/**
 * A local room's fast@1 channel, played by real clients from this computer.
 *
 * `genex__room` serves the room in ProcessSandbox. On Linux the sandbox gives the room a network
 * namespace of its own, and this computer reaches its ports only through the loopback bridge
 * (`substrate/linux-loopback-bridge.ts`): its datagrams cross as IPC messages, each sender with a
 * socket of its own in the sandbox. Elsewhere the room's loopback is this computer's.
 *
 * Here two seats of Studio's own multiplayer client (`connectAuthority` over node:dgram, the Node
 * fast@1 client the SDK ships) join a room `GenexRoomService` started in the real sandbox and play
 * it for ten seconds. Each must bind on UDP and stay there: live on every sample after it bound, no
 * fallback, never on the WebSocket; snapshots and inputs at the room's tick rate; its inputs moving
 * its own entity, and only its own, the whole time. The room's own report must count both seats on
 * the channel, at two addresses: on Linux, the bridge's two per-sender sockets. And they must stay
 * so while more senders than the bridge keeps (other programs here, no seat of the room's) send to
 * its fast port.
 */
import assert from "node:assert/strict";
import { createSocket, type Socket as DatagramSocket } from "node:dgram";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type AuthoritySession,
  connectAuthority,
  FAST_VERSION,
  FastKind,
  type FastSocketOpener,
  FastTransport,
  TOPDOWN_DEFAULTS,
} from "@genex-ai/multiplayer/authority";
import { openUdpFastSocket } from "@genex-ai/multiplayer/authority/fast-udp";
import { GenexRoomService, type RoomStatus } from "../../src/main/core/genex-room.ts";
import { authorityDevDir } from "../../src/plugins/genex/cli.ts";
import { BRIDGE_PEER_MAX } from "../../src/substrate/linux-loopback-bridge.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** The room's tick rate. */
const TICK_HZ = 60;
/**
 * A topdown room whose players the preset moves from their inputs alone. A room patches its state,
 * and sends each fast seat a snapshot, every 50 ms by default (PROTOCOL.md §17.6); a predicting
 * room patches after every keyframe instead, and `patchHz` at the tick rate makes every tick one
 * (§17.10, car-ball's setting): so this room sends a snapshot a tick.
 */
const ROOM_JS = [
  "export default {",
  "  contract: 1,",
  `  config: { tickHz: ${TICK_HZ}, maxPlayers: 8, preset: { name: "topdown" }, physics: { predict: true, patchHz: ${TICK_HZ} } },`,
  "  init: () => ({}),",
  '  onJoin(ctx, player) { ctx.entities.spawn({ kind: "player", owner: player.id, hp: 3 }); },',
  "  onLeave(ctx, player) { const me = ctx.entities.ownedBy(player.id); if (me) ctx.entities.remove(me.id); },",
  "  onInput() {},",
  "  step() {},",
  "};",
].join("\n");
/** The room key the toolchain serves (`authority-dev`'s LOCAL_ROOM_KEY). */
const ROOM_KEY = "local";
/** How long the seats play once both are bound. */
const PLAY_MS = 10_000;
/** How long a seat may take to go live after it joins (the handshake's few round trips, retried). */
const BIND_WITHIN_MS = 5_000;
/** How often a seat sends its input and reads the channel: a 125 Hz client frame, above the tick rate. */
const FRAME_MS = 8;
/** How often the channel's state is sampled while the seats play. */
const SAMPLE_EVERY_MS = 100;
/**
 * How far the measured rates (snapshots heard, inputs sent) may sit from the tick rate, each way.
 * The room steps on a fixed clock that catches up after a late timer and sends one snapshot a step;
 * the client sends one uplink per input tick. Over ten seconds either count is the tick count to
 * within a tick or two, and loopback loses or doubles nearly nothing: macOS measured 60.0/s both
 * ways. 10% leaves a CI runner its scheduling stalls (a sandboxed room, two clients and the bridge's
 * relay on two cores) and nothing more: a channel that carries every other tick (30/s), or each
 * twice (120/s), fails.
 */
const RATE_SHARE = 0.1;
/** How long each seat holds one direction before it turns back: 12 units at the preset's 6 a second, inside its ±20 arena from the spawn. */
const LEG_MS = 2_000;
/** How long after a turn a leg is judged from: the input's way to the room and the snapshot's way back, on loopback. */
const LEG_SETTLE_MS = 300;
/**
 * The share of the preset's pace a seat must reach in each leg's judged span. The room steps a seat
 * once per input it receives, at most one a tick earned (§17.6 *The input meter*), and the client
 * sends faster than the room ticks, so a seat whose every input arrives walks at the full pace. A
 * leg's span is sampled every 100 ms, so its ends sit within a sample of the turn: 75% holds that
 * and fails a seat whose inputs reach the room at two thirds of the tick rate or less.
 */
const LEG_PACE_SHARE = 0.75;
/** Senders that are no seat, past the bridge's table of {@link BRIDGE_PEER_MAX}. */
const STRANGERS = BRIDGE_PEER_MAX + 16;
/** How often each stranger sends. */
const CHURN_EVERY_MS = 20;

let sandbox: ProcessSandbox;
let root: string;
before(async () => {
  root = await tmpDir("studio-genex-room-fast-");
  sandbox = await ProcessSandbox.create({
    writableRoots: [path.join(root, "games")],
    scratchDir: path.join(root, "sandbox"),
    secretPaths: [],
  });
});
after(async () => {
  await sandbox.dispose();
});

/** A game folder declaring the room. */
async function game(name: string): Promise<string> {
  const dir = path.join(root, "games", name);
  await mkdir(path.join(dir, "server"), { recursive: true });
  await writeFile(path.join(dir, "index.html"), "<!doctype html>");
  await writeFile(path.join(dir, "server", "room.js"), ROOM_JS);
  await writeFile(path.join(dir, "genex.json"), JSON.stringify({ authority: { module: "server/room.js" } }));
  return dir;
}

/** The service on the real sandbox and toolchain. */
function service(dir: string) {
  const pids: number[] = [];
  const toolDir = authorityDevDir();
  assert.ok(toolDir, "the repository carries the toolchain");
  const rooms = new GenexRoomService({
    run: (request) => sandbox.run(request),
    spawn: async (request) => {
      const { child, input, expose } = await sandbox.spawnLongLived(request);
      if (child.pid) pids.push(child.pid);
      return expose ? { child, input, expose } : { child, input };
    },
    toolDir,
    scratch: path.join(root, "runs"),
    boundGame: async () => dir,
    onRoom: async () => true,
    loopbackPorts: () => sandbox.loopbackPorts(),
    ownLoopback: () => sandbox.ownLoopback(),
  });
  return { rooms, pids, binding: { project: path.basename(dir), directory: dir } };
}

/** What one seat's own UDP socket did: the urls it opened and the datagrams it sent and heard. */
interface SeatWire {
  opened: string[];
  sent: number;
  heard: number;
}

/** One look at a seat's channel and entity, and the way it was walking. */
interface Sample {
  at: number;
  way: number;
  live: boolean;
  fallback: string | null;
  transport: string;
  snapshots: number;
  sent: number;
  heard: number;
  x: number;
  y: number;
}

/** A seat, the input axis it walks along and what it saw. */
interface Player {
  session: AuthoritySession;
  wire: SeatWire;
  axis: "moveX" | "moveY";
  samples: Sample[];
}

/** One seat of Studio's client, asking for fast@1 on node:dgram, its socket watched; no prediction, so its entity is the room's. */
async function seat(url: string, name: string, axis: Player["axis"]): Promise<Player> {
  const wire: SeatWire = { opened: [], sent: 0, heard: 0 };
  const open: FastSocketOpener = (to, receive) => {
    wire.opened.push(to);
    const socket = openUdpFastSocket(to, (bytes) => {
      wire.heard++;
      receive(bytes);
    });
    if (socket === null) return null;
    return {
      send(bytes) {
        wire.sent++;
        socket.send(bytes);
      },
      close: () => socket.close(),
    };
  };
  const session = await connectAuthority({
    urls: [],
    url,
    room: ROOM_KEY,
    name,
    capacityRetryMs: [],
    predict: false,
    fast: open,
  });
  return { session, wire, axis, samples: [] };
}

function sample(player: Player, at: number, way: number): Sample {
  const me = player.session.me();
  const { live, fallback, transport, snapshots } = player.session.fast;
  const { sent, heard } = player.wire;
  return { at, way, live, fallback, transport, snapshots, sent, heard, x: me?.x ?? Number.NaN, y: me?.y ?? Number.NaN };
}

/** Where a sample's entity stands along `axis`, and across it. */
const along = (s: Sample, axis: Player["axis"]) => (axis === "moveX" ? s.x : s.y);
const across = (s: Sample, axis: Player["axis"]) => (axis === "moveX" ? s.y : s.x);

/**
 * Play every seat's frame each {@link FRAME_MS} for `ms`, or until `done`, each walking `way(elapsed)`
 * along its axis; sampled every {@link SAMPLE_EVERY_MS}.
 */
async function play(players: Player[], ms: number, way: (elapsed: number) => number, done = () => false) {
  const start = performance.now();
  let nextSample = start;
  while (!done() && performance.now() - start < ms) {
    const now = performance.now();
    const held = way(now - start);
    for (const player of players) {
      player.session.input[player.axis] = held;
      player.session.frame();
    }
    if (now >= nextSample) {
      for (const player of players) player.samples.push(sample(player, now - start, held));
      nextSample += SAMPLE_EVERY_MS;
    }
    await sleep(FRAME_MS);
  }
}

/** Out and back: forward in even legs, back in odd ones. */
const outAndBack = (elapsed: number) => (Math.floor(elapsed / LEG_MS) % 2 === 0 ? 1 : -1);

/** Per second, how much `field` grew from the first sample to the last. */
function ratePerSecond(samples: Sample[], field: "snapshots" | "sent" | "heard"): number {
  const first = samples[0] as Sample;
  const last = samples.at(-1) as Sample;
  return ((last[field] - first[field]) * 1000) / (last.at - first.at);
}

/** Each leg's judged span: its way, and how far the entity went along and across the axis in it. */
function legs(player: Player): Array<{ way: number; ms: number; along: number; across: number }> {
  const out = [];
  for (let start = 0; start + LEG_MS <= PLAY_MS; start += LEG_MS) {
    const span = player.samples.filter((s) => s.at >= start + LEG_SETTLE_MS && s.at < start + LEG_MS);
    const first = span[0] as Sample;
    const last = span.at(-1) as Sample;
    out.push({
      way: first.way,
      ms: last.at - first.at,
      along: along(last, player.axis) - along(first, player.axis),
      across: across(last, player.axis) - across(first, player.axis),
    });
  }
  return out;
}

/** The room's report's fast@1 line, as the toolchain counts it. */
interface FastReport {
  state?: string;
  url?: string;
  bound?: number;
  seats?: number;
  addresses?: number;
  dropped?: Record<string, number>;
}

/** Each of `player`'s samples, rates and legs against the bounds above. */
function assertPlayed(player: Player, fastUrl: string | undefined): void {
  const off = player.samples.filter((s) => !s.live || s.fallback !== null || s.transport !== FastTransport.Udp);
  assert.deepEqual(off, [], "live on UDP with no fallback on every sample after binding");
  assert.equal(player.session.fast.fallbacks, 0, "never fell back to the WebSocket");
  assert.deepEqual(player.wire.opened, [fastUrl], "one socket, to the room's fast port");
  for (const field of ["snapshots", "heard", "sent"] as const) {
    const rate = ratePerSecond(player.samples, field);
    assert.ok(
      Math.abs(rate - TICK_HZ) <= TICK_HZ * RATE_SHARE,
      `${field} ${rate.toFixed(1)}/s at a ${TICK_HZ} Hz room`,
    );
  }
  for (const leg of legs(player)) {
    const least = (TOPDOWN_DEFAULTS.speed * leg.ms * LEG_PACE_SHARE) / 1000;
    assert.ok(
      leg.along * leg.way >= least,
      `inputs walked the entity ${JSON.stringify(leg)}: at least ${least.toFixed(2)}`,
    );
    assert.equal(leg.across, 0, `and nothing moved it across its axis: ${JSON.stringify(leg)}`);
  }
}

/** Senders that are no seat: more of them than the bridge keeps, each its own socket on this computer's loopback. */
async function strangers(count: number): Promise<{ sockets: DatagramSocket[]; close: () => void }> {
  const sockets = await Promise.all(
    Array.from({ length: count }, async () => {
      const socket = createSocket("udp4");
      socket.on("error", () => {});
      await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
      return socket;
    }),
  );
  const close = () => {
    for (const socket of sockets) socket.close();
  };
  return { sockets, close };
}

/** Every {@link CHURN_EVERY_MS}, a datagram from each stranger to `port`: an uplink's header for a seat that does not exist. */
function churn(sockets: DatagramSocket[], port: number): () => void {
  const bytes = new Uint8Array(29);
  bytes[0] = FAST_VERSION;
  bytes[1] = FastKind.Uplink;
  const timer = setInterval(() => {
    for (const socket of sockets) {
      new DataView(bytes.buffer).setUint32(2, (Math.random() * 0xffff_ffff) >>> 0, true);
      socket.send(bytes, port, "127.0.0.1");
    }
  }, CHURN_EVERY_MS);
  return () => clearInterval(timer);
}

/** Start the room, seat two players, bind them, then play {@link PLAY_MS} out and back; the room's report and the players. */
async function playRoom(
  t: TestContext,
  rooms: GenexRoomService,
  binding: { project: string; directory: string },
  players: Player[],
  during?: (fastPort: number) => () => void,
): Promise<{ fast: FastReport; seated: number | undefined }> {
  const started = (await rooms.call({ action: "start", bots: 0 }, binding)) as RoomStatus;
  assert.equal(started.reachable, true, JSON.stringify(started));
  players.push(await seat(started.url ?? "", "seat-a", "moveX"), await seat(started.url ?? "", "seat-b", "moveY"));
  await play(
    players,
    BIND_WITHIN_MS,
    () => 0,
    () => players.every((p) => p.session.fast.live),
  );
  for (const player of players)
    assert.equal(player.session.fast.live, true, `${player.axis} bound: ${JSON.stringify(player.session.fast)}`);
  for (const player of players) player.samples.length = 0;
  const stop = during?.(Number(new URL(fastUrlOf(players)).port)) ?? (() => {});
  try {
    await play(players, PLAY_MS, outAndBack);
  } finally {
    stop();
  }
  const report = rooms.status(binding.project).report as { fast?: FastReport; players?: number } | null;
  const fast = report?.fast ?? {};
  t.diagnostic(
    `bridge: ${sandbox.ownLoopback() ? "yes" : "no (this computer's loopback)"}; room fast@1: ${JSON.stringify(fast)}`,
  );
  for (const player of players) {
    const rates = (["snapshots", "heard", "sent"] as const).map(
      (f) => `${f} ${ratePerSecond(player.samples, f).toFixed(1)}/s`,
    );
    t.diagnostic(
      `${player.axis}: ${player.samples.length} samples, live ${player.samples.filter((s) => s.live).length}; ${rates.join(", ")}; ` +
        `legs ${JSON.stringify(legs(player).map((l) => [l.way, Number(l.along.toFixed(2)), l.across]))}; ${JSON.stringify(player.session.fast)}`,
    );
  }
  return { fast, seated: report?.players };
}

/** The fast url the seats' sockets were told. */
function fastUrlOf(players: Player[]): string {
  const url = players[0]?.wire.opened[0];
  assert.ok(url, "the seat opened a socket");
  return url;
}

describe("a local room's fast@1 channel carries real clients from this computer", () => {
  it("binds two seats on UDP and keeps them there for ten seconds: snapshots and inputs at the tick rate, each seat walking its own entity", async (t) => {
    const dir = await game("fast");
    const { rooms, pids, binding } = service(dir);
    const players: Player[] = [];
    try {
      const { fast, seated } = await playRoom(t, rooms, binding, players);
      for (const player of players) assertPlayed(player, fast.url);
      assert.equal(fast.state, "on");
      assert.equal(fast.bound, 2, "the room has both seats bound on the channel");
      assert.equal(fast.addresses, 2, "at two addresses: each sender its own socket");
      assert.ok(
        Object.values(fast.dropped ?? {}).every((n) => n === 0),
        "and dropped none of their datagrams",
      );
      assert.equal(seated, 2);
    } finally {
      for (const player of players) await player.session.leave().catch(() => undefined);
      await rooms.stopAll();
    }
    assert.equal(pids.length, 1, "one room process");
    for (const pid of pids) assert.equal(running(pid), false, `the room process ${pid} ended`);
  });

  it("keeps both seats on the channel while more strangers than the bridge keeps send to its port", async (t) => {
    const dir = await game("fast-crowd");
    const { rooms, binding } = service(dir);
    const players: Player[] = [];
    const crowd = await strangers(STRANGERS);
    try {
      const { fast } = await playRoom(t, rooms, binding, players, (port) => churn(crowd.sockets, port));
      for (const player of players) assertPlayed(player, fast.url);
      assert.equal(fast.bound, 2, "both seats still bound");
      assert.ok((fast.dropped?.unknown_sid ?? 0) > 0, "the strangers' datagrams reached the room, which dropped them");
    } finally {
      crowd.close();
      for (const player of players) await player.session.leave().catch(() => undefined);
      await rooms.stopAll();
    }
  });
});

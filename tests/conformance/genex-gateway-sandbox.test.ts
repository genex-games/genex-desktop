/**
 * A native game from Play joining a real authority room through its gateway, inside the real game
 * sandbox. The seat (`tests/fixtures/play-gateway-seat.mjs`, Studio's Node client bundled into the
 * game's saves folder) is started by `spawnNativeGame`, the function Play starts every Mac game
 * with, so its Seatbelt profile is Play's own: no network but the gateway's TCP and datagram ports,
 * and `GENEX_API_URL` its only address. Behind the gateway is a fake API that names two authority
 * regions, both served by one real local room (`@genex-ai/authority-dev`, fast@1 on), the second
 * through a slow path. The seat must probe both regions through the gateway, join the near one,
 * bind fast@1 on UDP through the gateway's datagram port and stay there: live on every sample after
 * it bound, no fallback, the transport line `udp fast@1`, and snapshots at the room's tick rate.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { authorityHostsOf, relayHostsOf, startGenexGateway } from "../../src/main/play/genex-gateway.ts";
import { authorityDevDir } from "../../src/plugins/genex/cli.ts";
import { spawnNativeGame } from "../../src/substrate/plugins/native-process.ts";
import { tmpDir } from "../helpers/tmp.ts";

const TICK_HZ = 60;
/** A topdown room that patches, and sends each fast seat a snapshot, every tick (genex-room-fast.test.ts's). */
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
const PLAY_MS = 10_000;
/** How long a seat may take to go live after its first sample: the handshake's few round trips. */
const BIND_WITHIN_MS = 5_000;
/** How far the snapshot rate may sit from the tick rate (genex-room-fast.test.ts's `RATE_SHARE`). */
const RATE_SHARE = 0.1;
/** The far region's added one-way delay: well past loopback's, so the probe must prefer the near one. */
const FAR_DELAY_MS = 60;
const API_HOST = "api.genex.games";
const NEAR = "authority-eu.genex.games";
const FAR = "authority-asia.genex.games";
const SEAT = fileURLToPath(new URL("../fixtures/play-gateway-seat.mjs", import.meta.url));

const SKIP =
  process.platform === "darwin" && authorityDevDir() ? false : "needs macOS's Seatbelt and the room toolchain";

const closing: Array<() => unknown> = [];
after(async () => {
  for (const close of closing.reverse()) await close();
});

/** The local room: authority-dev serving the module, once it prints where it listens. */
async function room(dir: string): Promise<{ ws: number; fastUrl: string; child: ChildProcess }> {
  const tool = authorityDevDir() ?? "";
  await mkdir(path.join(dir, "server"), { recursive: true });
  await writeFile(path.join(dir, "server", "room.js"), ROOM_JS);
  const child = spawn(
    process.execPath,
    [path.join(tool, "dist/cli.js"), "start", "--module", "server/room.js", "--root", dir, "--report"],
    { cwd: dir, stdio: ["pipe", "pipe", "inherit"] },
  );
  closing.push(() => child.kill("SIGTERM"));
  let out = "";
  return new Promise((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`room exited ${code}: ${out}`)));
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const ws = /LISTEN ws:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1];
      const fast = /FAST (\{.*\})/.exec(out)?.[1];
      if (ws && fast) resolve({ ws: Number(ws), fastUrl: JSON.parse(fast).url, child });
    });
  });
}

/** A TCP path to `port` that counts its connections and holds each chunk `delayMs` each way. */
async function path_(port: number, delayMs: number) {
  const seen = { connections: 0 };
  const server = net.createServer((inner) => {
    seen.connections++;
    const outer = net.connect(port, "127.0.0.1");
    const carry = (from: net.Socket, to: net.Socket) =>
      from.on("data", (chunk: Buffer) => (delayMs ? setTimeout(() => to.write(chunk), delayMs) : to.write(chunk)));
    carry(inner, outer);
    carry(outer, inner);
    const end = () => {
      inner.destroy();
      outer.destroy();
    };
    for (const side of [inner, outer]) side.on("error", end).on("close", end);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  closing.push(() => {
    server.close();
  });
  return { port: (server.address() as AddressInfo).port, seen };
}

/** The fake API: a guest session naming the two regions. */
async function fakeApi(): Promise<number> {
  const answer = {
    token: "guest",
    colyseus: {
      urls: [],
      authorityUrls: [`wss://${NEAR}`, `wss://${FAR}`],
      authorityRegions: [
        { region: "asia", urls: [`wss://${FAR}`] },
        { region: "eu", urls: [`wss://${NEAR}`] },
      ],
    },
  };
  const server = http.createServer((_req, res) =>
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer)),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  closing.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return (server.address() as AddressInfo).port;
}

/** One sample the seat printed. */
interface Sample {
  at: number;
  live: boolean;
  fallback: string | null;
  transport: string;
  snapshots: number;
  x: number | null;
}

describe("a native game from Play in its sandbox, through its gateway", { skip: SKIP }, () => {
  it("probes both regions, joins the near one and plays it on fast@1 UDP, never on the WebSocket", async () => {
    const root = await realpath(await tmpDir("play-gateway-sandbox-"));
    closing.push(() => rm(root, { recursive: true, force: true }));
    const local = await room(path.join(root, "game"));
    const near = await path_(local.ws, 0);
    const far = await path_(local.ws, FAR_DELAY_MS);
    const apiPort = await fakeApi();
    const upstreamOf: Record<string, number> = { [API_HOST]: apiPort, [NEAR]: near.port, [FAR]: far.port };
    const fastHost = new URL(local.fastUrl.replace(/^udp:/, "http:")).hostname;
    const gateway = await startGenexGateway({
      api: `https://${API_HOST}`,
      relay: relayHostsOf(API_HOST),
      authority: authorityHostsOf(API_HOST),
      // The local room names its loopback endpoint; Genex's own names a fast host (`fastHostsOf`).
      fast: (host) => host === fastHost,
      resolve: async (host) => host,
      upstream: (host) => ({ host: "127.0.0.1", port: upstreamOf[host] ?? 1, secure: false }),
    });
    closing.push(gateway.close);

    const saves = path.join(root, "saves");
    const scratch = path.join(root, "scratch");
    await mkdir(saves, { recursive: true });
    await mkdir(scratch, { recursive: true });
    const seat = path.join(saves, "seat.mjs");
    // One file the sandbox reads from the game's own folder; its CommonJS dependencies (ws) keep a `require`.
    const banner =
      'import { createRequire as seatRequire } from "node:module"; const require = seatRequire(import.meta.url);';
    await build({
      entryPoints: [SEAT],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: seat,
      banner: { js: banner },
      logLevel: "error",
    });
    const nodeRoot = path.dirname(path.dirname(await realpath(process.execPath)));
    const child = await spawnNativeGame({
      binary: await realpath(process.execPath),
      app: nodeRoot,
      saves,
      scratch,
      bundleId: "games.genex.play.gateway-proof",
      bundleName: "Gateway Proof",
      args: [seat, String(PLAY_MS)],
      genex: {
        ports: gateway.ports,
        datagramPorts: gateway.datagramPorts,
        env: { GENEX_API_URL: gateway.apiUrl },
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    const line = out.trim().split("\n").at(-1) ?? "";
    assert.ok(line.startsWith("{"), `the seat said nothing (exit ${code}): ${err.slice(-2000)}`);
    const result = JSON.parse(line);
    assert.equal(code, 0, `the seat ran: ${result.error ?? ""} ${err.slice(-2000)}`);

    const ports = (result.authorityUrls as string[]).map((url) => Number(new URL(url.replace(/^ws/, "http")).port));
    assert.ok(
      ports.every((port) => gateway.ports.includes(port)),
      "the seat was given only the gateway's ports",
    );
    assert.ok(near.seen.connections >= 2 && far.seen.connections >= 1, "both regions were probed through the gateway");
    assert.ok(String(result.url).endsWith(`:${ports[0]}`), `joined the near region: ${result.url}`);
    assert.match(String(result.line), /^genex transport: udp fast@1 udp:\/\/127\.0\.0\.1:\d+$/);
    const boundTo = Number(/:(\d+)$/.exec(String(result.line))?.[1]);
    assert.ok(gateway.datagramPorts.includes(boundTo), "its datagrams went to the gateway's own port");

    const samples: Sample[] = result.samples;
    const bound = samples.findIndex((s) => s.live);
    assert.ok(bound >= 0 && (samples[bound]?.at ?? Infinity) < BIND_WITHIN_MS, "bound on UDP within the handshake");
    const after = samples.slice(bound);
    assert.ok(
      after.every((s) => s.live && s.fallback === null && s.transport === "udp"),
      "live on UDP on every sample after it bound",
    );
    const first = after[0] as Sample;
    const last = after.at(-1) as Sample;
    const rate = ((last.snapshots - first.snapshots) * 1000) / (last.at - first.at);
    console.log(
      `sandboxed seat: bound at ${first.at.toFixed(0)} ms, ${after.length} samples on UDP, ${rate.toFixed(1)} snapshots/s, probes near ${near.seen.connections} far ${far.seen.connections}`,
    );
    assert.ok(Math.abs(rate - TICK_HZ) <= TICK_HZ * RATE_SHARE, `snapshots at the tick rate: ${rate.toFixed(1)}/s`);
    const moved = after.map((s) => s.x).filter((x): x is number => typeof x === "number");
    assert.ok(Math.max(...moved) - Math.min(...moved) > 3, "its inputs moved its entity");
  });
});

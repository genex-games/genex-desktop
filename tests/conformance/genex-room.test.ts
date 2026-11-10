/**
 * A server-authoritative game made in Studio could not be checked or played before it was
 * published: a game's commands cannot download `@genex-ai/authority-dev`, and Studio ran none.
 *
 * Now `genex__room` runs the toolchain Studio ships, in ProcessSandbox: `validate` gives the
 * publish gate's verdict, `start` serves the room on 127.0.0.1 with bots and tells the preview its
 * address, `stop` ends it with its process tree. The real sandbox and the real toolchain run here.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createSocket } from "node:dgram";
import http from "node:http";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { GenexRoomService, ROOM_MAX_BOTS, roomCall, type RoomStatus } from "../../src/main/core/genex-room.ts";
import { authorityDevDir } from "../../src/plugins/genex/cli.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ROOM_JS = [
  'import { SPEED } from "../src/world.js";',
  "export default {",
  "  contract: 1,",
  '  config: { tickHz: 30, maxPlayers: 8, preset: { name: "topdown" } },',
  "  init: () => ({ joins: 0 }),",
  '  onJoin(ctx, player) { ctx.state.joins += SPEED > 0 ? 1 : 0; ctx.entities.spawn({ kind: "player", owner: player.id, hp: 3 }); },',
  "  onLeave(ctx, player) { const me = ctx.entities.ownedBy(player.id); if (me) ctx.entities.remove(me.id); },",
  "  onInput() {},",
  "  step() {},",
  "};",
].join("\n");
/** A Unity game's room module: TypeScript, sharing nothing with its C# client. */
const UNITY_ROOM_TS = [
  "type Player = { id: string };",
  "export default {",
  "  contract: 1,",
  '  config: { tickHz: 30, maxPlayers: 8, preset: { name: "topdown" } },',
  "  init: () => ({ joins: 0 }),",
  '  onJoin(ctx: any, player: Player) { ctx.state.joins += 1; ctx.entities.spawn({ kind: "player", owner: player.id, hp: 3 }); },',
  "  onLeave(ctx: any, player: Player) { const me = ctx.entities.ownedBy(player.id); if (me) ctx.entities.remove(me.id); },",
  "  onInput() {},",
  "  step() {},",
  "};",
].join("\n");
/** A module whose every tick throws: a fault the gate names. */
const FAULTY_JS = ROOM_JS.replace("step() {},", 'step() { throw new Error("boom"); },');
/** How often a test looks at a running room, and how long it looks before it gives up. */
const LOOK_EVERY_MS = 100;
const LOOK_FOR_MS = 20_000;

/**
 * A stand-in toolchain that runs as the room does and tries what the room must not: write in the
 * game, reach any network but loopback, reach loopback outside the sandbox's fence (Windows) or
 * this computer's loopback (Linux), hold the bridge's channel, and reports each outcome; it listens
 * (answering HTTP, and echoing datagrams on its fast port) and connects to itself where the room's
 * own clients do, and stops once its input closes. It reads its targets from `probe.json` beside it.
 */
const PROBE_CLI = String.raw`"use strict";
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const dgram = require("node:dgram");
const path = require("node:path");
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const targets = JSON.parse(fs.readFileSync(path.join(__dirname, "probe.json"), "utf8"));
const report = (value) => process.stdout.write("REPORT " + JSON.stringify(value) + "\n");
const tryWrite = (file, text) => { try { fs.writeFileSync(file, text); return "written"; } catch (e) { return e.code || "refused"; } };
const connect = (host, port) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  const done = (outcome) => { socket.destroy(); resolve(outcome); };
  socket.setTimeout(3000, () => done("timeout"));
  socket.once("connect", () => done("connected"));
  socket.once("error", (e) => done(e.code || "error"));
});
const datagram = (port) => new Promise((resolve) => {
  const socket = dgram.createSocket("udp4");
  const timer = setTimeout(() => resolve("timeout"), 3000);
  socket.on("message", (data, from) => {
    if (from.port !== port) { socket.send(data, from.port, from.address); return; }
    clearTimeout(timer);
    resolve("received");
  });
  socket.once("error", (e) => { clearTimeout(timer); resolve(e.code || "error"); });
  socket.bind(port, "127.0.0.1", () => socket.send("x", port, "127.0.0.1", (e) => e && resolve(e.code || "error")));
});
const writes = () => ({
  gameNewFile: tryWrite(path.join(arg("--root"), "planted.txt"), "planted"),
  gameModule: tryWrite(arg("--module"), "tampered"),
});
if (args[0] === "validate") {
  process.stdout.write("VALIDATE " + JSON.stringify({ passed: true, ...writes() }) + "\n");
  process.exit(0);
}
(async () => {
  const server = http.createServer((request, response) => { response.statusCode = 204; response.end(); });
  await new Promise((resolve) => server.listen(Number(arg("--port") || 0), "127.0.0.1", resolve));
  const port = server.address().port;
  const outcomes = {
    env: { electronAsNode: process.env.ELECTRON_RUN_AS_NODE === "1", noProxy: process.env.no_proxy || null },
    channel: typeof process.send === "function",
    ...writes(),
    selfTcp: await connect("127.0.0.1", port),
    selfUdp: arg("--fast-port") ? await datagram(Number(arg("--fast-port"))) : "not named",
    outside: {},
  };
  for (const target of targets.outside) outcomes.outside[target.name] = await connect(target.host, target.port);
  process.stdout.write("LISTEN " + JSON.stringify("ws://127.0.0.1:" + port) + "\n");
  if (arg("--fast-port")) process.stdout.write("FAST " + JSON.stringify({ state: "on", url: "udp://127.0.0.1:" + arg("--fast-port") }) + "\n");
  report(outcomes);
  process.stdin.resume();
  process.stdin.on("end", () => { report({ ...outcomes, stopped: true }); process.exit(0); });
})();
`;

let sandbox: ProcessSandbox;
let root: string;
before(async () => {
  root = await tmpDir("studio-genex-room-");
  // The games folder is writable, as in the app: the room's own deny is what keeps it from a game.
  sandbox = await ProcessSandbox.create({
    writableRoots: [path.join(root, "games")],
    scratchDir: path.join(root, "sandbox"),
    secretPaths: [],
  });
});
after(async () => {
  await sandbox.dispose();
});

/** A game folder declaring a room, with `files` (relative path → text). */
async function game(name: string, files: Record<string, string>, authority: unknown = { module: "server/room.js" }) {
  const dir = path.join(root, "games", name);
  const page = { "index.html": "<!doctype html>", "src/world.js": "export const SPEED = 4;" };
  for (const [rel, text] of Object.entries({ ...page, ...files })) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  await writeFile(path.join(dir, "genex.json"), JSON.stringify({ authority }));
  return dir;
}

/** The service on the real sandbox and toolchain (or `toolDir`'s), recording what it told the preview. */
function service(dir: string, toolDir = authorityDevDir()) {
  const told: Array<string | null> = [];
  const runs: string[] = [];
  const pids: number[] = [];
  assert.ok(toolDir, "the repository carries the toolchain");
  const rooms = new GenexRoomService({
    run: (request) => {
      runs.push(request.command);
      return sandbox.run(request);
    },
    spawn: async (request) => {
      runs.push(request.command);
      const { child, input, expose } = await sandbox.spawnLongLived(request);
      if (child.pid) pids.push(child.pid);
      return expose ? { child, input, expose } : { child, input };
    },
    toolDir,
    scratch: path.join(root, "runs"),
    boundGame: async () => dir,
    onRoom: async (_project, url) => {
      told.push(url);
      return url !== null;
    },
    loopbackPorts: () => sandbox.loopbackPorts(),
    ownLoopback: () => sandbox.ownLoopback(),
  });
  return { rooms, told, runs, pids, binding: { project: path.basename(dir), directory: dir } };
}

/** The room's address lies inside the sandbox's loopback fence, where there is one. */
function assertInRange(url: string | null) {
  const range = sandbox.loopbackPorts();
  if (!range) return;
  const port = Number(new URL(url ?? "ws://x").port);
  assert.ok(port >= range[0] && port <= range[1], `${url} lies in ${range.join("-")}`);
}

/** The HTTP status the room answers this process with (outside the sandbox, as the preview is), 0 if none. */
function hostReaches(url: string | null): Promise<number> {
  const target = new URL(url ?? "ws://x");
  return new Promise((resolve) => {
    const request = http.get({ host: target.hostname, port: target.port, path: "/", timeout: 5000 }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(0));
  });
}

/** What this process gets back for a datagram to `port` on loopback (as a native client's would be): its echo, or why not. */
function hostEchoes(port: number): Promise<string> {
  const socket = createSocket("udp4");
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 5000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
    socket.once("error", (error) => resolve(error.message));
    socket.send("ping", port, "127.0.0.1");
  }).finally(() => socket.close());
}

/** The value after `flag` on a command line of single-quoted or bare words. */
function option(command: string | undefined, flag: string): number | null {
  const match = new RegExp(`${flag}'? '?(\\d+)'?`).exec(command ?? "");
  return match ? Number(match[1]) : null;
}

/** A listener on `host` that counts who reached it. */
async function counting(host: string): Promise<{ server: Server; port: number; reached: () => number }> {
  let reached = 0;
  const server = createServer((socket) => {
    reached++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0, reached: () => reached };
}

/** This machine's first address off loopback, or null. */
function lanAddress(): string | null {
  const all = Object.values(os.networkInterfaces()).flat();
  return all.find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address ?? null;
}

/** The room's status once `ready` holds, looked at every {@link LOOK_EVERY_MS}. */
async function until(rooms: GenexRoomService, project: string, ready: (status: RoomStatus) => boolean) {
  for (let waited = 0; waited < LOOK_FOR_MS; waited += LOOK_EVERY_MS) {
    const status = rooms.status(project);
    if (ready(status)) return status;
    await sleep(LOOK_EVERY_MS);
  }
  throw new Error(`the room never got there: ${JSON.stringify(rooms.status(project))}`);
}

describe("genex__room checks its call before anything runs", () => {
  it("refuses an unknown action, key, bot count or delay", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["no action", {}],
      ["an unknown action", { action: "deploy" }],
      ["an unknown key", { action: "start", module: "../../etc/passwd" }],
      ["too many bots", { action: "start", bots: ROOM_MAX_BOTS + 1 }],
      ["negative bots", { action: "start", bots: -1 }],
      ["fractional bots", { action: "start", bots: 1.5 }],
      ["bots as text", { action: "start", bots: "3" }],
      ["too much delay", { action: "start", latencyMs: 301 }],
    ];
    for (const [name, args] of cases) assert.throws(() => roomCall(args), Error, name);
    assert.deepEqual(roomCall({ action: "start" }), { action: "start", bots: 3, latencyMs: 0 });
  });

  it("refuses a game with no room, or a module that leads out of it, and runs nothing", async () => {
    const none = path.join(root, "no-room");
    await mkdir(none, { recursive: true });
    await writeFile(path.join(none, "index.html"), "<!doctype html>");
    await writeFile(path.join(none, "genex.json"), "{}");
    const a = service(none);
    await assert.rejects(a.rooms.call({ action: "validate" }, a.binding), /declares no room module/);
    const outside = await game("outside", { "elsewhere/room.js": ROOM_JS });
    const linked = await game("linked", {});
    await mkdir(path.join(linked, "server"), { recursive: true });
    await symlink(path.join(outside, "elsewhere", "room.js"), path.join(linked, "server", "room.js"));
    const b = service(linked);
    await assert.rejects(b.rooms.call({ action: "start" }, b.binding), /not a file in this game|escapes/i);
    const traversal = await game("traversal", {}, { module: "server/../../outside/elsewhere/room.js" });
    const c = service(traversal);
    await assert.rejects(c.rooms.call({ action: "validate" }, c.binding), /declares no room module/);
    assert.deepEqual([...a.runs, ...b.runs, ...c.runs], [], "nothing ran");
  });
});

describe("genex__room runs the toolchain Studio ships, in the sandbox", () => {
  it("validates a module as the publish gate does, and names a faulty one's failures", async () => {
    const dir = await game("validate", { "server/room.js": ROOM_JS });
    const before = await readdir(dir, { recursive: true });
    const { rooms, binding } = service(dir);
    const verdict = await rooms.call({ action: "validate" }, binding);
    assert.equal((verdict as { passed: boolean }).passed, true, JSON.stringify(verdict));
    assert.deepEqual(await readdir(dir, { recursive: true }), before, "validation writes nothing in the game");
    await writeFile(path.join(dir, "server", "room.js"), FAULTY_JS);
    const failed = (await rooms.call({ action: "validate" }, binding)) as { passed: boolean; failures: unknown[] };
    assert.equal(failed.passed, false);
    assert.ok(failed.failures.length > 0, "each failure is named");
  });

  it("serves the room with bots on 127.0.0.1, puts the preview in it, and stops it with its process tree", async () => {
    const dir = await game("start", { "server/room.js": ROOM_JS });
    const { rooms, told, pids, binding } = service(dir);
    const started = (await rooms.call({ action: "start", bots: 2 }, binding)) as RoomStatus;
    try {
      assert.match(started.url ?? "", /^ws:\/\/127\.0\.0\.1:\d+$/);
      assertInRange(started.url);
      // Linux gives the room a network namespace of its own: the loopback bridge opens its ports here.
      const status = await hostReaches(started.url);
      assert.ok(status > 0, "the preview's side (this process, outside the sandbox) reaches the room");
      assert.equal(started.reachable, true);
      assert.equal(started.previewJoined, true);
      assert.deepEqual(told, [started.url], "the preview was told the room's address");
      const playing = await until(rooms, binding.project, (status) => {
        const report = status.report as { players?: number } | null;
        return (report?.players ?? 0) >= 2;
      });
      assert.equal(playing.running, true);
    } finally {
      await rooms.call({ action: "stop" }, binding).catch(() => null);
    }
    const stopped = rooms.status(binding.project);
    assert.equal((stopped as RoomStatus).running, false);
    assert.deepEqual(told, [started.url, null], "the preview left the room");
    assert.equal(rooms.status(binding.project).running, false);
    assert.equal(pids.length, 1, "one room process");
    for (const pid of pids) assert.equal(running(pid), false, `the room process ${pid} ended`);
  });

  it("ends a game's last room when it starts another", async () => {
    const dir = await game("restart", { "server/room.js": ROOM_JS });
    const { rooms, told, pids, binding } = service(dir);
    const first = (await rooms.call({ action: "start", bots: 0 }, binding)) as RoomStatus;
    const second = (await rooms.call({ action: "start", bots: 0 }, binding)) as RoomStatus;
    // Flipped from `first.url !== second.url`: on Windows both listen at the top of the fence's
    // range, so the same address can come back. The first room's process is what must be gone.
    assert.equal(pids.length, 2);
    assert.equal(running(pids[0] ?? 0), false, "the first room ended before the second started");
    assert.equal(second.running, true);
    assert.deepEqual(told, [first.url, null, second.url]);
    await rooms.stopAll();
    assert.equal(rooms.status(binding.project).running, false);
  });

  it("validates and serves a Unity game's room: server/room.ts beside its project and its WebGL build", async () => {
    // A Unity game has no page or package.json of its own at the top: its project carries Genex's
    // package, its WebGL build is in web/, and genex.json declares the room.
    const dir = path.join(root, "games", "unity-arena");
    const files: Record<string, string> = {
      "unity/Packages/com.genex.multiplayer/package.json": JSON.stringify({ name: "com.genex.multiplayer" }),
      "unity/Assets/Scripts/Online.cs": "public sealed class Online {}",
      "web/index.html": "<!doctype html>",
      "server/room.ts": UNITY_ROOM_TS,
      "genex.json": JSON.stringify({ authority: { module: "server/room.ts", tickHz: 30, maxPlayers: 8 } }),
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), text);
    }
    const { rooms, told, binding } = service(dir);
    const verdict = (await rooms.call({ action: "validate" }, binding)) as { passed: boolean };
    assert.equal(verdict.passed, true, JSON.stringify(verdict));
    const started = (await rooms.call({ action: "start", bots: 2 }, binding)) as RoomStatus;
    try {
      assert.match(started.url ?? "", /^ws:\/\/127\.0\.0\.1:\d+$/);
      assert.deepEqual(told, [started.url], "the preview (the WebGL build) is told the room's address");
      await until(
        rooms,
        binding.project,
        (status) => ((status.report as { players?: number } | null)?.players ?? 0) >= 2,
      );
    } finally {
      await rooms.call({ action: "stop" }, binding).catch(() => null);
    }
  });

  it("fails a start whose module does not load, leaving nothing running and the preview alone", async () => {
    const dir = await game("broken", { "server/room.js": "export default {" });
    const { rooms, told, binding } = service(dir);
    await assert.rejects(rooms.call({ action: "start" }, binding), /did not start/);
    assert.deepEqual(told, []);
    await until(rooms, binding.project, (status) => !status.running);
  });
});

/**
 * Where the probe reaches out to: a public address, and listeners of this process's own that count
 * who reached them: this machine's LAN address, and on Windows loopback outside the fence's range
 * (closed to the sandbox user, whoever listens). macOS has no LAN row: Seatbelt's `localhost` takes
 * this machine's own addresses too, so every sandboxed process there reaches them (sandbox-runtime's
 * profile, not the room's).
 */
async function outsideTargets() {
  const listeners = new Map<string, Awaited<ReturnType<typeof counting>>>();
  // `own`: a refusal there is the room's own empty loopback answering, not that place.
  const outside = [{ name: "public address", host: "1.1.1.1", port: 80, own: false }];
  const lan = process.platform === "darwin" ? null : lanAddress();
  if (lan) {
    const listener = await counting("0.0.0.0");
    listeners.set("this machine's LAN address", listener);
    outside.push({ name: "this machine's LAN address", host: lan, port: listener.port, own: false });
  }
  if (sandbox.loopbackPorts()) {
    const listener = await counting("127.0.0.1");
    listeners.set("loopback outside the fence", listener);
    outside.push({ name: "loopback outside the fence", host: "127.0.0.1", port: listener.port, own: false });
  }
  if (sandbox.ownLoopback()) {
    const listener = await counting("127.0.0.1");
    listeners.set("this computer's loopback", listener);
    outside.push({ name: "this computer's loopback", host: "127.0.0.1", port: listener.port, own: true });
  }
  return { outside, listeners };
}

describe("the room's sandbox gives it loopback and its scratch, nothing of the game or the network", () => {
  it("refuses each hostile reach of a process started as the room is, with no side effect", async (t) => {
    const dir = await game("hostile", { "server/room.js": ROOM_JS });
    const toolDir = path.join(root, "games", "probe-tool");
    await mkdir(path.join(toolDir, "dist"), { recursive: true });
    await writeFile(path.join(toolDir, "dist", "cli.js"), PROBE_CLI);
    const { outside, listeners } = await outsideTargets();
    await writeFile(path.join(toolDir, "dist", "probe.json"), JSON.stringify({ outside }));
    const { rooms, runs, binding } = service(dir, toolDir);
    try {
      const validated = (await rooms.call({ action: "validate" }, binding)) as Record<string, unknown>;
      assert.notEqual(validated.gameNewFile, "written", "validation plants nothing in the game");
      assert.notEqual(validated.gameModule, "written", "validation leaves the room module alone");
      const started = (await rooms.call({ action: "start", bots: 0 }, binding)) as RoomStatus;
      assertInRange(started.url);
      const status = await until(rooms, binding.project, (now) => now.report !== null);
      const outcomes = status.report as Record<string, unknown> & { outside: Record<string, string> };
      t.diagnostic(`probe: ${JSON.stringify(outcomes)}`);
      const env = outcomes.env as { electronAsNode: boolean; noProxy: string | null };
      assert.equal(env.electronAsNode, true, "the toolchain runs as node");
      assert.ok(env.noProxy?.split(",").includes("127.0.0.1"), `its clients reach the room directly (${env.noProxy})`);
      assert.notEqual(outcomes.gameNewFile, "written", "no new file in the game");
      assert.notEqual(outcomes.gameModule, "written", "the room module is untouched");
      assert.equal(outcomes.selfTcp, "connected", "the room's own clients reach it");
      assert.equal(outcomes.channel, false, "the room holds no channel to Genex (the bridge's relay does)");
      for (const { name, own } of outside) {
        const reached = own ? ["connected"] : ["connected", "ECONNREFUSED"];
        assert.ok(!reached.includes(outcomes.outside[name] ?? ""), `${name}: ${outcomes.outside[name]}`);
      }
      assert.ok((await hostReaches(started.url)) > 0, "this process reaches the room's WebSocket port");
      assert.equal(started.reachable, true);
      const fastPort = option(runs.at(-1), "--fast-port");
      if (sandbox.ownLoopback() && fastPort !== null) {
        assert.equal(outcomes.selfUdp, "received", "the room's own clients reach its fast port");
        assert.equal(
          await hostEchoes(fastPort),
          "ping",
          "a datagram from here reaches the room and its answer comes back",
        );
      }
      const stopped = (await rooms.call({ action: "stop" }, binding)) as RoomStatus;
      assert.equal(
        (stopped.report as { stopped?: boolean } | null)?.stopped,
        true,
        "its input reached it and ended it",
      );
      for (const [name, listener] of listeners) assert.equal(listener.reached(), 0, `nothing reached ${name}`);
      assert.equal(await readFile(path.join(dir, "server", "room.js"), "utf8"), ROOM_JS);
      assert.equal((await readdir(dir)).includes("planted.txt"), false, "nothing planted in the game");
    } finally {
      await rooms.stopAll();
      for (const listener of listeners.values()) listener.server.close();
    }
  });
});

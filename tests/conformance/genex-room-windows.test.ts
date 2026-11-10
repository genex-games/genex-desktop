/**
 * A local room could not work on Windows: srt-win's egress filter lets a sandboxed process connect
 * only to its proxies' loopback range, machine-wide, and Genex installs it that way
 * (`allowLocalBinding` cannot open loopback for one process there). The room listened on any port,
 * so its own bots, sandboxed with it, could never reach it; its stdin, which ends the room, never
 * reached it either (srt-win does not pass stdin on).
 *
 * Now a room on a fenced loopback names its listeners inside that range, its own clients go to it
 * directly rather than to the sandbox's proxy, and its input goes through the live-input relay.
 * Nothing else is granted: no domain, no loopback beyond the range, the game write-denied. These
 * drive the service over a recording spawn and the srt config a Windows sandbox builds for it, on
 * any machine; tests/conformance/genex-room.test.ts runs the real thing (in the Windows suite).
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { GenexRoomService, type RoomStatus } from "../../src/main/core/genex-room.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { ProcessSandbox, type SandboxPolicy } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ROOM_JS = "export default { contract: 1, init: () => ({}), onJoin() {}, onLeave() {}, onInput() {}, step() {} };";

/** What the room asked the sandbox for. */
interface SpawnRequest {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  policy?: Partial<SandboxPolicy>;
  liveInput?: boolean;
}

/** The value after `flag` on a command line of single-quoted or bare words. */
function option(command: string, flag: string): number | null {
  const match = new RegExp(`${flag}'? '?(\\d+)'?`).exec(command);
  return match ? Number(match[1]) : null;
}

/**
 * A room that says it listens on the port its command names (or 41234) and ends once its input
 * closes, as `--stop-on-stdin-close` does. It has no pid: nothing here may signal a real process.
 */
function listeningRoom(command: string): { child: ChildProcess; input: PassThrough } {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const input = new PassThrough();
  Object.assign(child, { stdout, stderr: new PassThrough(), exitCode: null, signalCode: null });
  input.on("finish", () => {
    Object.assign(child, { exitCode: 0 });
    child.emit("close", 0, null);
  });
  input.resume();
  const port = option(command, "--port") ?? 41234;
  queueMicrotask(() => stdout.write(`LISTEN "ws://127.0.0.1:${port}"\n`));
  return { child, input };
}

/** A game with a room, a sandbox built for `platform` (not started), and a service recording its spawns. */
async function setup(platform: StudioPlatform, portFree: (port: number) => boolean = () => true) {
  const root = await tmpDir("studio-room-windows-");
  const game = path.join(root, "games", "arena");
  const toolDir = path.join(root, "tool");
  await mkdir(path.join(game, "server"), { recursive: true });
  await mkdir(path.join(toolDir, "dist"), { recursive: true });
  await writeFile(path.join(game, "server", "room.js"), ROOM_JS);
  await writeFile(path.join(game, "index.html"), "<!doctype html>");
  await writeFile(path.join(game, "genex.json"), JSON.stringify({ authority: { module: "server/room.js" } }));
  await writeFile(path.join(toolDir, "dist", "cli.js"), "");
  const sandbox = await ProcessSandbox.create({
    writableRoots: [path.join(root, "games")],
    scratchDir: path.join(root, "sandbox"),
    secretPaths: [],
    platform,
    enabled: false,
  });
  const spawned: SpawnRequest[] = [];
  const rooms = new GenexRoomService({
    run: () => Promise.reject(new Error("no validation here")),
    spawn: async (request) => {
      spawned.push(request);
      return listeningRoom(request.command);
    },
    toolDir,
    scratch: path.join(root, "runs"),
    boundGame: async () => game,
    loopbackPorts: () => sandbox.loopbackPorts(),
    portFree: async (port) => portFree(port),
  });
  return { rooms, sandbox, spawned, game, binding: { project: "arena", directory: game } };
}

describe("a room on Windows listens where its sandboxed bots may connect, and is granted nothing else", () => {
  it("names its WebSocket and fast@1 ports inside srt-win's loopback range", async () => {
    const { rooms, sandbox, spawned, binding } = await setup(StudioPlatform.Windows);
    const range = sandbox.loopbackPorts();
    assert.ok(range, "Windows fences loopback to a range");
    const started = (await rooms.call({ action: "start", bots: 2 }, binding)) as RoomStatus;
    const command = spawned[0]?.command ?? "";
    const [low, high] = range;
    for (const flag of ["--port", "--fast-port"]) {
      const port = option(command, flag);
      assert.ok(port !== null && port >= low && port <= high, `${flag} ${port} lies in ${low}-${high}`);
    }
    assert.equal(started.url, `ws://127.0.0.1:${option(command, "--port")}`);
    await rooms.stopAll();
  });

  it("asks the Windows sandbox for no domain and no open loopback, writes nothing of the game, and keeps its input", async () => {
    const { rooms, sandbox, spawned, game, binding } = await setup(StudioPlatform.Windows);
    await rooms.call({ action: "start" }, binding);
    const request = spawned[0];
    assert.ok(request);
    assert.deepEqual(request.policy, { denyWrite: [game] }, "the room's own policy only takes the game's writes away");
    const config = sandbox.toRuntimeConfig({ ...sandbox.policy, ...request.policy });
    assert.deepEqual(config.network.allowedDomains, [], "no domain through the proxy");
    assert.equal(config.network.allowLocalBinding, false, "loopback stays the install's, closed");
    assert.ok(config.filesystem.denyWrite.includes(game), "the game is write-denied");
    assert.equal(request.env?.no_proxy, "127.0.0.1", "its clients reach the room directly, only the room's host");
    assert.equal(request.liveInput, true, "its stdin, which ends it, reaches it on Windows");
    await rooms.stopAll();
  });

  it("refuses what a fenced loopback cannot give, and runs nothing", async () => {
    const cases: Array<{
      name: string;
      args: Record<string, unknown>;
      free: (port: number) => boolean;
      refused: RegExp;
    }> = [
      {
        name: "a delay (the toolchain's delay proxies listen on any port)",
        args: { action: "start", latencyMs: 80 },
        free: () => true,
        refused: /delay/i,
      },
      {
        name: "every port of the range taken",
        args: { action: "start" },
        free: () => false,
        refused: /60080-60089/,
      },
    ];
    for (const { name, args, free, refused } of cases) {
      const { rooms, spawned, binding } = await setup(StudioPlatform.Windows, free);
      await assert.rejects(rooms.call(args, binding), refused, name);
      assert.deepEqual(spawned, [], `${name}: nothing ran`);
      assert.equal(rooms.status(binding.project).running, false);
    }
  });

  it("leaves macOS and Linux rooms on any port, with a delay", async () => {
    for (const platform of [StudioPlatform.Mac, StudioPlatform.Linux]) {
      const { rooms, sandbox, spawned, binding } = await setup(platform);
      assert.equal(sandbox.loopbackPorts(), null, platform);
      await rooms.call({ action: "start", latencyMs: 80 }, binding);
      const command = spawned[0]?.command ?? "";
      assert.equal(option(command, "--port"), null, `${platform}: the room picks its own port`);
      assert.equal(option(command, "--latency"), 80);
      await rooms.stopAll();
    }
  });
});

/**
 * `genex__room start` said the preview had joined the room whenever the preview was loaded with its
 * address, whether or not anything outside the sandbox could reach that address. On Linux the
 * sandbox gives the room a network namespace of its own, so its 127.0.0.1 was not the preview's:
 * the preview loaded into nothing while `previewJoined` said true.
 *
 * Now a room is handed to the preview only once this computer gets an answer from it, and on Linux
 * the loopback bridge carries this computer's connections and datagrams in to the room's own ports,
 * and nothing out: it answers only a sender it heard. These drive the service over a recording
 * spawn, and the bridge's host side over a stand-in relay, on any machine;
 * tests/conformance/genex-room.test.ts runs the real sandbox and toolchain.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createSocket, type Socket as DatagramSocket } from "node:dgram";
import { EventEmitter } from "node:events";
import { access, mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { anyLoopbackPort, GenexRoomService, type RoomStatus } from "../../src/main/core/genex-room.ts";
import {
  BRIDGE_PEER_MAX,
  type BridgeMessage,
  LoopbackProtocol,
  openLoopbackBridge,
} from "../../src/substrate/linux-loopback-bridge.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ROOM_JS = "export default { contract: 1, init: () => ({}), onJoin() {}, onLeave() {}, onInput() {}, step() {} };";
/** How long a test waits for a datagram that must not come. */
const QUIET_MS = 300;

/** The value after `flag` on a command line of single-quoted or bare words. */
function option(command: string, flag: string): number | null {
  const match = new RegExp(`${flag}'? '?(\\d+)'?`).exec(command);
  return match ? Number(match[1]) : null;
}

/**
 * A room that prints `lines` (LISTEN on its command's `--port`, or 41234, first) and ends once its
 * input closes. It has no pid: nothing here may signal a real process.
 */
function printingRoom(command: string, lines: (port: number) => string[]) {
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
  queueMicrotask(() =>
    stdout.write(
      lines(port)
        .map((line) => `${line}\n`)
        .join(""),
    ),
  );
  return { child, input };
}

/** A game with a room and a service whose spawns, exposures and preview calls are recorded. */
async function setup(options: { reaches: boolean; ownLoopback?: boolean; fastPort?: number }) {
  const root = await tmpDir("studio-room-reach-");
  const game = path.join(root, "arena");
  const toolDir = path.join(root, "tool");
  await mkdir(path.join(game, "server"), { recursive: true });
  await mkdir(path.join(toolDir, "dist"), { recursive: true });
  await writeFile(path.join(game, "server", "room.js"), ROOM_JS);
  await writeFile(path.join(game, "index.html"), "<!doctype html>");
  await writeFile(path.join(game, "genex.json"), JSON.stringify({ authority: { module: "server/room.js" } }));
  await writeFile(path.join(toolDir, "dist", "cli.js"), "");
  const told: Array<string | null> = [];
  const asked: string[] = [];
  const exposed: Array<[number, string]> = [];
  const commands: string[] = [];
  const fast = (port: number) =>
    `FAST ${JSON.stringify({ state: "on", url: `udp://127.0.0.1:${options.fastPort ?? port + 1}` })}`;
  const rooms = new GenexRoomService({
    run: () => Promise.reject(new Error("no validation here")),
    spawn: async (request) => {
      commands.push(request.command);
      const room = printingRoom(request.command, (port) => [`LISTEN "ws://127.0.0.1:${port}"`, fast(port)]);
      if (!request.loopbackServer || !options.ownLoopback) return room;
      return {
        ...room,
        expose: async (port: number, protocol: string) => {
          exposed.push([port, protocol]);
        },
      };
    },
    toolDir,
    scratch: path.join(root, "runs"),
    boundGame: async () => game,
    onRoom: async (_project, url) => {
      told.push(url);
      return url !== null;
    },
    ownLoopback: () => options.ownLoopback === true,
    reaches: async (url) => {
      asked.push(url);
      return options.reaches;
    },
  });
  return { rooms, told, asked, exposed, commands, binding: { project: "arena", directory: game } };
}

describe("a room joins the preview only once this computer reaches it", () => {
  it("never hands an unreachable room to the preview, and leaves the preview alone when it ends", async () => {
    const { rooms, told, asked, binding } = await setup({ reaches: false });
    const started = (await rooms.call({ action: "start", bots: 0 }, binding)) as RoomStatus;
    assert.equal(started.running, true);
    assert.equal(started.previewJoined, false, "an unreachable room is never joined");
    assert.equal(started.reachable, false);
    assert.deepEqual(asked, [started.url], "this computer asked the room at its address");
    assert.deepEqual(told, [], "the preview was not told an address it cannot reach");
    await rooms.call({ action: "stop" }, binding);
    assert.deepEqual(told, [], "nor told to leave a room it never joined");
  });

  it("joins a reachable room, and leaves it when it ends", async () => {
    const { rooms, told, binding } = await setup({ reaches: true });
    const started = (await rooms.call({ action: "start", bots: 0 }, binding)) as RoomStatus;
    assert.equal(started.previewJoined, true);
    assert.equal(started.reachable, true);
    await rooms.call({ action: "stop" }, binding);
    assert.deepEqual(told, [started.url, null]);
  });

  it("where the room's loopback is its own, names ports free here and opens its WebSocket and fast@1 ports", async () => {
    const { rooms, exposed, commands, binding } = await setup({ reaches: true, ownLoopback: true, fastPort: 45_001 });
    const started = (await rooms.call({ action: "start", bots: 0 }, binding)) as RoomStatus;
    const port = option(commands[0] ?? "", "--port");
    assert.ok(port !== null && option(commands[0] ?? "", "--fast-port") !== null, "both listeners are named");
    assert.equal(started.url, `ws://127.0.0.1:${port}`);
    await rooms.call({ action: "status" }, binding);
    // FAST follows LISTEN at once, so the fast@1 port may open first.
    assert.deepEqual(
      new Map(exposed),
      new Map([
        [port, LoopbackProtocol.Tcp],
        [45_001, LoopbackProtocol.Udp],
      ]),
    );
    await rooms.stopAll();
  });
});

/** A relay that records what the host hands it, as a sandboxed process's IPC channel would. */
function standInRelay() {
  const sent: Array<{ message: BridgeMessage; handle: unknown }> = [];
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    connected: true,
    send(message: BridgeMessage, handle: unknown, _options: unknown, done?: (error: Error | null) => void) {
      sent.push({ message, handle });
      // As `keepOpen: false` does: the host's copy of a handed socket is closed once it is sent.
      if (handle instanceof net.Socket) handle.destroy();
      done?.(null);
      return true;
    },
  });
  return { child, sent, say: (message: unknown) => child.emit("message", message) };
}

/** The datagrams the host passed the relay. */
const datagrams = (relay: ReturnType<typeof standInRelay>) =>
  relay.sent.filter(({ message }) => message.kind === LoopbackProtocol.Udp && message.data !== undefined);

/** The senders the host told the relay it forgot, in order. */
const forgotten = (relay: ReturnType<typeof standInRelay>) =>
  relay.sent.flatMap(({ message }) => (message.forget === undefined ? [] : [message.forget]));

/** A UDP socket on loopback that keeps what reaches it. */
async function datagramListener(): Promise<{ socket: DatagramSocket; port: number; got: Buffer[] }> {
  const socket = createSocket("udp4");
  const got: Buffer[] = [];
  socket.on("message", (data) => got.push(data));
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return { socket, port: socket.address().port, got };
}

/** Wait until `ready` holds, or {@link QUIET_MS} passes. */
async function settle(ready: () => boolean = () => false): Promise<void> {
  for (let waited = 0; waited < QUIET_MS && !ready(); waited += 10) await sleep(10);
}

describe("the Linux loopback bridge carries this computer's traffic in, and nothing out", () => {
  it("hands each accepted connection to the relay whole, for the port it came to", async () => {
    const scratch = await tmpDir("studio-bridge-");
    const bridge = await openLoopbackBridge({ command: "true", shell: "/bin/sh", scratchDir: scratch });
    const relay = standInRelay();
    bridge.attach(relay.child);
    const port = await anyLoopbackPort(LoopbackProtocol.Tcp);
    try {
      await bridge.expose(port, LoopbackProtocol.Tcp);
      await bridge.expose(port, LoopbackProtocol.Tcp);
      const client = net.connect(port, "127.0.0.1");
      await new Promise((resolve) => client.once("connect", resolve));
      await settle(() => relay.sent.length > 0);
      client.destroy();
      assert.equal(relay.sent.length, 1);
      assert.deepEqual(relay.sent[0]?.message, { kind: LoopbackProtocol.Tcp, port });
      assert.ok(relay.sent[0]?.handle instanceof net.Socket, "the connection itself, not its bytes");
    } finally {
      await bridge.close();
    }
    await assert.rejects(access(bridge.file), "the relay's file is gone with the bridge");
    assert.equal(bridge.env.GENEX_BRIDGE_COMMAND, "true");
  });

  it("answers only a sender it heard, on the port it heard it on: every other answer is dropped unsent", async () => {
    const scratch = await tmpDir("studio-bridge-");
    const bridge = await openLoopbackBridge({ command: "true", shell: "/bin/sh", scratchDir: scratch });
    const relay = standInRelay();
    bridge.attach(relay.child);
    const port = await anyLoopbackPort(LoopbackProtocol.Udp);
    const player = await datagramListener();
    const bystander = await datagramListener();
    try {
      await bridge.expose(port, LoopbackProtocol.Udp);
      player.socket.send("hello", port, "127.0.0.1");
      await settle(() => relay.sent.length > 0);
      const heard = relay.sent[0]?.message;
      assert.equal(heard?.kind, LoopbackProtocol.Udp);
      assert.equal(heard?.port, port);
      assert.equal(Buffer.from(heard?.data ?? "", "base64").toString(), "hello");
      const peer = heard?.peer ?? "";
      const data = (text: string) => Buffer.from(text).toString("base64");
      const hostile: Array<[string, unknown]> = [
        ["a sender never heard", { kind: "udp", port, peer: `127.0.0.1:${bystander.port}`, data: data("x") }],
        ["a public address", { kind: "udp", port, peer: "1.1.1.1:53", data: data("x") }],
        ["a port never exposed", { kind: "udp", port: port + 1, peer, data: data("x") }],
        ["a connection's kind", { kind: "tcp", port, peer, data: data("x") }],
        ["more than a datagram", { kind: "udp", port, peer, data: "A".repeat(90_000) }],
        ["no data", { kind: "udp", port, peer }],
        ["not a port", { kind: "udp", port: "x", peer, data: data("x") }],
        ["not an object", "udp"],
        ["nothing", null],
      ];
      for (const [, message] of hostile) relay.say(message);
      await settle();
      assert.equal(bystander.got.length, 0, "nothing reached a bystander");
      assert.equal(player.got.length, 0, "nothing reached the player but its answer");
      relay.say({ kind: "udp", port, peer, data: data("welcome") });
      await settle(() => player.got.length > 0);
      assert.deepEqual(
        player.got.map((got) => got.toString()),
        ["welcome"],
      );
    } finally {
      await bridge.close();
      player.socket.close();
      bystander.socket.close();
    }
  });

  it("forgets the oldest sender past its cap, tells the relay so, and refuses what is not a port", async () => {
    const scratch = await tmpDir("studio-bridge-");
    const bridge = await openLoopbackBridge({ command: "true", shell: "/bin/sh", scratchDir: scratch });
    const relay = standInRelay();
    bridge.attach(relay.child);
    const port = await anyLoopbackPort(LoopbackProtocol.Udp);
    const first = await datagramListener();
    const others = await Promise.all(Array.from({ length: BRIDGE_PEER_MAX }, () => datagramListener()));
    try {
      await assert.rejects(bridge.expose(0, LoopbackProtocol.Tcp), RangeError);
      await assert.rejects(bridge.expose(70_000, LoopbackProtocol.Udp), RangeError);
      await bridge.expose(port, LoopbackProtocol.Udp);
      first.socket.send("1", port, "127.0.0.1");
      await settle(() => relay.sent.length === 1);
      const firstPeer = relay.sent[0]?.message.peer;
      for (const other of others) other.socket.send("n", port, "127.0.0.1");
      await settle(() => datagrams(relay).length === BRIDGE_PEER_MAX + 1);
      assert.deepEqual(forgotten(relay), [firstPeer], "the relay is told which sender's socket to close");
      relay.say({ kind: "udp", port, peer: firstPeer, data: Buffer.from("late").toString("base64") });
      await settle();
      assert.equal(first.got.length, 0, "a forgotten sender is not answered");
    } finally {
      await bridge.close();
      first.socket.close();
      for (const other of others) other.socket.close();
    }
  });

  it("keeps a sender the server answers when more others than it keeps send: they take each other's places", async () => {
    const scratch = await tmpDir("studio-bridge-");
    const bridge = await openLoopbackBridge({ command: "true", shell: "/bin/sh", scratchDir: scratch });
    const relay = standInRelay();
    bridge.attach(relay.child);
    const port = await anyLoopbackPort(LoopbackProtocol.Udp);
    const player = await datagramListener();
    const strangers = await Promise.all(Array.from({ length: BRIDGE_PEER_MAX + 16 }, () => datagramListener()));
    const data = (text: string) => Buffer.from(text).toString("base64");
    try {
      await bridge.expose(port, LoopbackProtocol.Udp);
      player.socket.send("join", port, "127.0.0.1");
      await settle(() => relay.sent.length === 1);
      const peer = relay.sent[0]?.message.peer ?? "";
      relay.say({ kind: "udp", port, peer, data: data("welcome") });
      await settle(() => player.got.length === 1);
      // The strangers send twice round: each after the first 63 replaces another, never the player.
      for (const round of [1, 2])
        for (const stranger of strangers) {
          stranger.socket.send(`n${round}`, port, "127.0.0.1");
          await settle(
            () => datagrams(relay).length > 1 + strangers.length * (round - 1) + strangers.indexOf(stranger),
          );
        }
      assert.equal(datagrams(relay).length, 1 + 2 * strangers.length, "every datagram went in");
      relay.say({ kind: "udp", port, peer, data: data("still here") });
      await settle(() => player.got.length === 2);
      assert.deepEqual(
        player.got.map((got) => got.toString()),
        ["welcome", "still here"],
        "the server's answer still reaches the player",
      );
      assert.ok(!forgotten(relay).includes(peer), "the player was never forgotten");
      assert.equal(
        forgotten(relay).length,
        2 * strangers.length - (BRIDGE_PEER_MAX - 1),
        "each stranger past the cap replaced one",
      );
    } finally {
      await bridge.close();
      player.socket.close();
      for (const stranger of strangers) stranger.socket.close();
    }
  });
});

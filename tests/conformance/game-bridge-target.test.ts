/**
 * A Play Protocol game as the computer tool's target: the studio's input plan carried out as
 * protocol ops, the game started through the ProcessSandbox from the command its studio.json
 * declares, every failure to start or stay up answered as a problem, and nothing left running
 * after a release. The last rows drive the fake game through the real computer session.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ClockLevel, InputRoute, PointerLevel, StateLevel, TargetRuntime } from "../../src/shared/computer-target.ts";
import { PlayErrorCode, PlayFailure, type PlayHello, PlayOp, readHello } from "../../src/shared/play-protocol.ts";
import { CaptureSurface, StillMimeType } from "../../src/shared/preview-contract.ts";
import { computerSession } from "../../src/main/core/computer-session.ts";
import {
  type GameBridgeSource,
  capabilitiesFromHello,
  gameBridgeSource,
  gameBridgeTarget,
} from "../../src/main/core/game-bridge-target.ts";
import { type PlayClient, type PlayDeadlines, PlayProtocolError } from "../../src/substrate/play-protocol-client.ts";
import { ProcessSandbox, shellQuote } from "../../src/substrate/spawn.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FAKE_GAME = path.resolve(import.meta.dirname, "../fixtures/fake-play-game.mjs");
const POSIX_ONLY = process.platform === "win32" ? "the fake game is started by a POSIX shell script" : false;

const HELLO: PlayHello = {
  protocol: 3,
  name: "recorded",
  view: { width: 64, height: 40 },
  capabilities: {
    pointer: PointerLevel.Absolute,
    clock: ClockLevel.StepLocked,
    state: StateLevel.Game,
    seed: true,
    actions: ["jump"],
    screenshot: ["png"],
  },
  ops: [],
};

/** A client that records every op and answers each with `answer`'s value, or its rejection. */
function recordingClient(answer: (op: string, args: Record<string, unknown>) => unknown = () => ({})) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const send = async (op: string, args: Record<string, unknown>) => {
    calls.push([op, { ...args }]);
    const value = answer(op, args);
    if (value instanceof Error) throw value;
    return value;
  };
  const client: PlayClient = {
    ready: { event: "ready", protocol: 3 },
    exited: false,
    call: (op, args) => send(op, { ...args }),
    send: (op, args) => send(op, args),
    close: () => {},
  };
  return { client, calls };
}

/** A target over a recording client, with sleeps recorded instead of slept. */
function recordedTarget(answer?: (op: string, args: Record<string, unknown>) => unknown) {
  const { client, calls } = recordingClient(answer);
  const slept: number[] = [];
  const target = gameBridgeTarget(client, HELLO, {
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { target, calls, slept };
}

describe("game bridge target — the studio's input as protocol ops", () => {
  it("clicks at a pixel with its button, count and held modifiers", async () => {
    const { target, calls } = recordedTarget();
    const done = await target.input([
      { type: "click", x: 10, y: 20, px: true, button: "right", clicks: 2, modifiers: ["shift"] },
    ]);
    assert.deepEqual(done, { applied: 1, route: InputRoute.Bridge });
    assert.deepEqual(calls, [
      [PlayOp.Key, { code: "ShiftLeft", down: true }],
      [PlayOp.Pointer, { x: 10, y: 20, button: "right", click: 2 }],
      [PlayOp.Key, { code: "ShiftLeft", down: false }],
    ]);
    assert.deepEqual(target.pointer(), { x: 10, y: 20 });
  });

  it("reads a fraction of the view as a fraction, and clamps a pixel to the view", async () => {
    const { target, calls } = recordedTarget();
    await target.input([{ type: "move", x: 0.5, y: 0.5 }]);
    await target.input([{ type: "move", x: 500, y: -3, px: true }]);
    assert.deepEqual(calls, [
      [PlayOp.Pointer, { x: 32, y: 20 }],
      [PlayOp.Pointer, { x: 63, y: 0 }],
    ]);
  });

  it("drags: press at the start, glide, release at the end", async () => {
    const { target, calls, slept } = recordedTarget();
    await target.input([{ type: "drag", fromX: 1, fromY: 2, x: 30, y: 31, px: true }]);
    assert.deepEqual(calls, [
      [PlayOp.Pointer, { x: 1, y: 2, button: "left", down: true }],
      [PlayOp.Pointer, { x: 30, y: 31 }],
      [PlayOp.Pointer, { x: 30, y: 31, button: "left", down: false }],
    ]);
    assert.equal(slept.length, 2, "the game is given time between the moves");
  });

  it("taps a key: real time on a running game, an exact step on a held one", async () => {
    const { target, calls, slept } = recordedTarget((op) => (op === PlayOp.Step ? { simulatedMs: 48 } : {}));
    await target.input([{ type: "tap", keys: ["d"] }]);
    assert.deepEqual(calls.splice(0), [
      [PlayOp.Key, { code: "KeyD", down: true }],
      [PlayOp.Key, { code: "KeyD", down: false }],
    ]);
    assert.deepEqual(slept, [50]);
    await target.clock?.pause();
    await target.input([{ type: "tap", keys: ["d"], stepMs: 32 }]);
    assert.deepEqual(calls, [
      [PlayOp.Pause, {}],
      [PlayOp.Key, { code: "KeyD", down: true }],
      [PlayOp.Step, { ms: 32 }],
      [PlayOp.Key, { code: "KeyD", down: false }],
    ]);
    assert.deepEqual(slept, [50], "a held clock is stepped, never slept on");
  });

  it("presses a chord with its modifiers first and lets go in reverse", async () => {
    const { target, calls } = recordedTarget();
    await target.input([{ type: "press", combo: "ctrl+s" }]);
    assert.deepEqual(calls, [
      [PlayOp.Key, { code: "ControlLeft", down: true }],
      [PlayOp.Key, { code: "KeyS", down: true }],
      [PlayOp.Key, { code: "KeyS", down: false }],
      [PlayOp.Key, { code: "ControlLeft", down: false }],
    ]);
  });

  it("types, looks, scrolls at a point and waits", async () => {
    const { target, calls, slept } = recordedTarget();
    await target.input([
      { type: "type", text: "hi" },
      { type: "look", dx: 5, dy: -9_999 },
      { type: "scroll", dx: 0, dy: 240, x: 7, y: 8 },
      { type: "wait", ms: 300 },
    ]);
    assert.deepEqual(calls, [
      [PlayOp.Type, { text: "hi" }],
      [PlayOp.Look, { dx: 5, dy: -2_000 }],
      [PlayOp.Pointer, { x: 7, y: 8 }],
      [PlayOp.Wheel, { dx: 0, dy: 240 }],
    ]);
    assert.deepEqual(slept, [300]);
  });

  it("skips an action the game refuses and counts only what landed", async () => {
    const { target } = recordedTarget((op) =>
      op === PlayOp.Pointer ? new PlayProtocolError(PlayErrorCode.Unsupported, op, "no pointer") : {},
    );
    const done = await target.input([
      { type: "click", x: 1, y: 1, px: true },
      { type: "type", text: "a" },
    ]);
    assert.equal(done.applied, 1);
  });

  it("fails the plan when the game process is gone", async () => {
    const { target } = recordedTarget(() => new PlayProtocolError(PlayFailure.Exited, PlayOp.Type, "gone"));
    await assert.rejects(target.input([{ type: "type", text: "a" }]), /gone/);
  });

  it("asks for JPEG when the game draws it, and names a PNG as PNG", async () => {
    const png = recordedTarget((op) =>
      op === PlayOp.Screenshot ? { format: "png", data: "iVBORw0K", width: 64, height: 40 } : {},
    );
    const shot = await png.target.screenshot({ quality: 70, surface: CaptureSurface.Auto });
    assert.equal(shot.mime, StillMimeType.Png);
    assert.deepEqual(png.calls[0], [PlayOp.Screenshot, { format: "png", quality: 70 }]);
    const { client, calls } = recordingClient(() => ({ format: "jpeg", data: "/9j/", width: 64, height: 40 }));
    const jpegGame = gameBridgeTarget(client, {
      ...HELLO,
      capabilities: { ...HELLO.capabilities, screenshot: ["jpeg", "png"] },
    });
    assert.equal((await jpegGame.screenshot({ quality: 70, surface: CaptureSurface.Auto })).mime, StillMimeType.Jpeg);
    assert.deepEqual(calls[0], [PlayOp.Screenshot, { format: "jpeg", quality: 70 }]);
  });

  it("refuses a screenshot answer with no picture", async () => {
    const { target } = recordedTarget(() => ({ format: "gif", data: "x", width: 1, height: 1 }));
    await assert.rejects(target.screenshot({ quality: 70, surface: CaptureSurface.Auto }), PlayProtocolError);
  });
});

describe("game bridge target — capabilities from hello", () => {
  it("reads every level the game declares", () => {
    const caps = capabilitiesFromHello(HELLO);
    assert.equal(caps.runtime, TargetRuntime.Bridge);
    assert.equal(caps.pointer, PointerLevel.Absolute);
    assert.equal(caps.clock, ClockLevel.StepLocked);
    assert.equal(caps.state, StateLevel.Game);
    assert.equal(caps.seed, true);
    assert.equal(caps.actions, true);
    for (const missing of ["reload", "cameras", "console", "zoom", "surfaces"] as const)
      assert.equal(caps[missing], false);
  });

  const unsafe: Array<{ name: string; capabilities: unknown }> = [
    { name: "no capabilities", capabilities: undefined },
    {
      name: "made-up levels",
      capabilities: { pointer: "telepathic", clock: "always", state: "everything", seed: "yes" },
    },
    { name: "the wrong types", capabilities: { pointer: 3, clock: null, state: [], actions: "jump" } },
  ];
  for (const row of unsafe) {
    it(`falls back to none for ${row.name}`, () => {
      const hello = readHello({ protocol: 3, view: { width: 10, height: 10 }, capabilities: row.capabilities });
      assert.ok(hello);
      const caps = capabilitiesFromHello(hello);
      assert.equal(caps.pointer, PointerLevel.None);
      assert.equal(caps.clock, ClockLevel.None);
      assert.equal(caps.state, StateLevel.None);
      assert.equal(caps.seed, false);
      assert.equal(caps.actions, false);
      const target = gameBridgeTarget(recordingClient().client, hello);
      assert.equal(target.clock, undefined);
      assert.equal(target.state, undefined);
      assert.equal(target.seed, undefined);
      assert.equal(target.act, undefined);
    });
  }

  it("refuses a hello without a protocol version or a view", () => {
    assert.equal(readHello({ view: { width: 1, height: 1 } }), null);
    assert.equal(readHello({ protocol: 3, view: { width: 0, height: 1 } }), null);
    assert.equal(readHello({ protocol: 3, view: { width: 1.5, height: 1 } }), null);
    assert.equal(readHello("hello"), null);
  });
});

/** A sandbox (unsandboxed, for speed) that records every process it starts; disposed after the file. */
async function recordingSandbox() {
  const root = await realpath(await tmpDir("bridge-sandbox-"));
  const sandbox = await ProcessSandbox.create({
    writableRoots: [root],
    scratchDir: path.join(root, "scratch"),
    secretPaths: [],
    enabled: false,
  });
  after(() => sandbox.dispose());
  const spawned: Array<{ command: string; cwd: string }> = [];
  return {
    spawned,
    sandbox: {
      spawnLongLived: (request: Parameters<ProcessSandbox["spawnLongLived"]>[0]) => {
        spawned.push({ command: request.command, cwd: request.cwd });
        return sandbox.spawnLongLived(request);
      },
    },
  };
}

/** A bridge project whose `bin/game` starts the fake game with these flags. */
async function bridgeProject(args: string[] = [], play?: unknown): Promise<string> {
  const dir = await realpath(await tmpDir("bridge-game-"));
  await mkdir(path.join(dir, "bin"), { recursive: true });
  const script = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(FAKE_GAME)} "$@"\n`;
  await writeFile(path.join(dir, "bin", "game"), script);
  await chmod(path.join(dir, "bin", "game"), 0o755);
  const declared = play ?? { command: "bin/game", args };
  await writeFile(path.join(dir, "studio.json"), JSON.stringify({ runtime: "bridge", play: declared }));
  return dir;
}

/** A source whose release runs after the test, so a failed assertion still stops the game. */
function source(
  sandbox: Parameters<typeof gameBridgeSource>[0]["sandbox"],
  extra: Partial<Parameters<typeof gameBridgeSource>[0]> = {},
): GameBridgeSource {
  const made = gameBridgeSource({ sandbox, stopGraceMs: 300, ...extra });
  after(() => made.release());
  return made;
}

/** How many times, 20 ms apart, a test looks for the pid a booting game writes: a loaded machine boots node slowly. */
const PID_POLLS = 1_000;

/** The pid the fake game wrote, once it has. */
async function pidIn(file: string): Promise<number> {
  for (let i = 0; i < PID_POLLS; i++) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text) return Number(text);
    await sleep(20);
  }
  assert.fail("the game never wrote its pid");
}

describe("game bridge source — started through the sandbox, stopped on release", { skip: POSIX_ONLY }, () => {
  it("starts the declared command by its real path, in the build, through the sandbox", async () => {
    const { sandbox, spawned } = await recordingSandbox();
    const root = await bridgeProject(["--view=32x20"]);
    const loaded = await source(sandbox).load(root, false);
    assert.equal(loaded.problem, null);
    assert.equal(loaded.fresh, true);
    assert.deepEqual(spawned, [{ command: `${shellQuote(path.join(root, "bin", "game"))} '--view=32x20'`, cwd: root }]);
    assert.deepEqual(loaded.target.viewSize(), { width: 32, height: 20 });
  });

  it("keeps one game between loads of the same build, and starts again when forced", async () => {
    const { sandbox, spawned } = await recordingSandbox();
    const root = await bridgeProject();
    const bridge = source(sandbox);
    await bridge.load(root, false);
    assert.equal((await bridge.load(root, false)).fresh, false);
    assert.equal((await bridge.load(root, true)).fresh, true);
    assert.equal(spawned.length, 2);
  });

  const hostile: Array<{ name: string; plant: (root: string, outside: string) => Promise<unknown> }> = [
    { name: "a parent escape", plant: async () => ({ command: "../evil" }) },
    { name: "an absolute command outside", plant: async (_root, outside) => ({ command: path.join(outside, "evil") }) },
    {
      name: "a link out of the project",
      plant: async (root, outside) => {
        await symlink(path.join(outside, "evil"), path.join(root, "bin", "linked"));
        return { command: "bin/linked" };
      },
    },
    { name: "non-string args", plant: async () => ({ command: "bin/game", args: [1, 2] }) },
    { name: "a shell metacharacter", plant: async () => ({ command: "bin/game;touch pwned" }) },
  ];
  for (const row of hostile) {
    it(`refuses ${row.name} and starts nothing`, async () => {
      const { sandbox, spawned } = await recordingSandbox();
      const outside = await realpath(await tmpDir("bridge-outside-"));
      const marker = path.join(outside, "ran");
      await writeFile(path.join(outside, "evil"), `#!/bin/sh\ntouch ${shellQuote(marker)}\n`);
      await chmod(path.join(outside, "evil"), 0o755);
      const root = await bridgeProject();
      await writeFile(
        path.join(root, "studio.json"),
        JSON.stringify({ runtime: "bridge", play: await row.plant(root, outside) }),
      );
      const loaded = await source(sandbox).load(root, false);
      assert.match(String(loaded.problem), /play command|Play Protocol game/);
      assert.deepEqual(spawned, [], "nothing was started");
      assert.deepEqual(await readdir(outside), ["evil"], "nothing outside ran");
      await assert.rejects(loaded.target.screenshot({ quality: 80, surface: CaptureSurface.Auto }));
    });
  }

  it("answers a game that never says ready as a problem, and leaves nothing running", async () => {
    const { sandbox } = await recordingSandbox();
    const pidFile = path.join(await tmpDir("bridge-pid-"), "pid");
    const root = await bridgeProject(["--never-ready", `--pid-file=${pidFile}`]);
    // The handshake's deadline fires once the game has booted and is plainly silent, whatever the
    // machine's load: the row is about a game that never says ready, not about how fast node starts.
    const deadlines: PlayDeadlines = {
      after: (_ms, fire) => {
        void pidIn(pidFile).then(() => sleep(100).then(fire));
        return () => {};
      },
    };
    const loaded = await source(sandbox, { client: { deadlines } }).load(root, false);
    assert.match(String(loaded.problem), /did not say ready/);
    assert.equal(running(await pidIn(pidFile)), false);
  });

  it("answers a fatal start with the game's own reason", async () => {
    const { sandbox } = await recordingSandbox();
    const loaded = await source(sandbox).load(await bridgeProject(["--fatal"]), false);
    assert.match(String(loaded.problem), /fake fatal: no display/);
  });

  it("fails a call the game dies in, then starts it again on the next load and says so", async () => {
    const { sandbox, spawned } = await recordingSandbox();
    const root = await bridgeProject(["--die-on=state"]);
    const bridge = source(sandbox);
    const first = await bridge.load(root, false);
    await assert.rejects(first.target.state?.() ?? Promise.resolve(), (error: unknown) => {
      assert.ok(error instanceof PlayProtocolError);
      assert.equal(error.code, PlayFailure.Exited);
      return true;
    });
    const again = await bridge.load(root, false);
    assert.equal(again.fresh, true);
    assert.match(String(again.note), /had exited/);
    assert.equal(spawned.length, 2);
  });

  it("asks the game to quit on release, and nothing is left running", async () => {
    const { sandbox } = await recordingSandbox();
    const pidFile = path.join(await tmpDir("bridge-pid-"), "pid");
    const bridge = source(sandbox);
    await bridge.load(await bridgeProject([`--pid-file=${pidFile}`]), false);
    const pid = await pidIn(pidFile);
    assert.equal(running(pid), true);
    await bridge.release();
    assert.equal(running(pid), false);
  });

  it("kills a game that ignores quit once the grace is over", async () => {
    const { sandbox } = await recordingSandbox();
    const pidFile = path.join(await tmpDir("bridge-pid-"), "pid");
    const bridge = source(sandbox);
    await bridge.load(await bridgeProject(["--ignore-quit", `--pid-file=${pidFile}`]), false);
    const pid = await pidIn(pidFile);
    await bridge.release();
    assert.equal(running(pid), false);
  });
});

/** The game's state as the session's target reads it. */
async function gameState(session: ReturnType<typeof computerSession>) {
  const { target } = await session.ensureLoaded();
  return (await target.state?.()) as { paused: boolean; tick: number; player: { x: number } };
}

describe("game bridge source — driven by the computer session", { skip: POSIX_ONLY }, () => {
  it("presses a key the game reads, then photographs it as the PNG it is", async () => {
    const { sandbox } = await recordingSandbox();
    const frameDir = await tmpDir("bridge-frames-");
    const session = computerSession(source(sandbox), await bridgeProject(), { paced: false, frameDir });
    const start = (await gameState(session)).player.x;
    const pressed = await session.run("computer", { action: "hold_key", text: "d", duration: 0.2 });
    assert.match(typeof pressed === "string" ? pressed : pressed.text, /^OK/);
    assert.ok((await gameState(session)).player.x > start, "the dot ran right");
    const shot = await session.run("computer", { action: "screenshot" });
    assert.ok(typeof shot !== "string", "a screenshot answers with an image");
    assert.equal(shot.images?.[0]?.mimeType, StillMimeType.Png);
    assert.match(shot.text, /64×40/);
    assert.deepEqual(
      (await readdir(frameDir)).filter((name) => name.endsWith(".png")),
      ["s1_screen.png"],
    );
  });

  it("a paced session holds the game still between moves and runs it only during them", async () => {
    const { sandbox } = await recordingSandbox();
    const session = computerSession(source(sandbox), await bridgeProject(), {
      paced: true,
      frameDir: await tmpDir("bridge-frames-"),
    });
    const held = await gameState(session);
    assert.equal(held.paused, true, "stood still as soon as it loaded");
    await sleep(150);
    assert.equal((await gameState(session)).tick, held.tick, "no time passed while the model looked");
    await session.run("computer", { action: "key", text: "d" });
    const after = await gameState(session);
    assert.equal(after.paused, true, "held again after the move");
    assert.ok(after.tick > held.tick, "time ran during the move");
  });

  it("refuses what the game cannot do before it reaches the game", async () => {
    const { sandbox, spawned } = await recordingSandbox();
    const session = computerSession(source(sandbox), await bridgeProject(), {
      paced: false,
      frameDir: await tmpDir("bridge-frames-"),
    });
    const zoomed = await session.run("computer", { action: "zoom", region: [0, 0, 10, 10] });
    assert.match(typeof zoomed === "string" ? zoomed : zoomed.text, /not available/);
    assert.deepEqual(spawned, [], "a refused action starts nothing");
  });
});

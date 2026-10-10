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
import {
  ClockLevel,
  ComputerPacing,
  InputRoute,
  PointerLevel,
  StateLevel,
  TargetRuntime,
} from "../../src/shared/computer-target.ts";
import {
  PLAY_MAX_STEP_MS,
  PlayErrorCode,
  PlayFailure,
  type PlayHello,
  PlayOp,
  lackedOps,
  readHello,
} from "../../src/shared/play-protocol.ts";
import { CaptureSurface, StillMimeType } from "../../src/shared/preview-contract.ts";
import { computerSession } from "../../src/main/core/computer-session.ts";
import {
  type GameBridgeSource,
  capabilitiesFromHello,
  gameBridgeSource,
  gameBridgeTarget,
} from "../../src/main/core/game-bridge-target.ts";
import {
  PLAY_CALL_TIMEOUT_MS,
  type PlayClient,
  type PlayDeadlines,
  PlayProtocolError,
} from "../../src/substrate/play-protocol-client.ts";
import { MAX_HOLD_KEY_MS } from "../../src/substrate/preview-input.ts";
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
  unsupported: [],
  build: null,
};

/** A client that records every op (and the deadline it was given) and answers each with `answer`'s value, or its rejection. */
function recordingClient(answer: (op: string, args: Record<string, unknown>) => unknown = () => ({})) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const deadlines: Array<[string, number | undefined]> = [];
  const send = async (op: string, args: Record<string, unknown>, timeoutMs?: number) => {
    calls.push([op, { ...args }]);
    deadlines.push([op, timeoutMs]);
    const value = answer(op, args);
    if (value instanceof Error) throw value;
    return value;
  };
  const client: PlayClient = {
    ready: { event: "ready", protocol: 3 },
    exited: false,
    call: (op, args, options) => send(op, { ...args }, options?.timeoutMs),
    send: (op, args, options) => send(op, args, options?.timeoutMs),
    close: () => {},
    stderrTail: () => [],
  };
  return { client, calls, deadlines };
}

/** A target over a recording client, with sleeps recorded instead of slept. */
function recordedTarget(answer?: (op: string, args: Record<string, unknown>) => unknown) {
  const { client, calls, deadlines } = recordingClient(answer);
  const slept: number[] = [];
  const target = gameBridgeTarget(client, HELLO, {
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { target, calls, slept, deadlines };
}

/** A refusal of `op` with the engine's `unsupported` code. */
function unsupported(op: string): PlayProtocolError {
  return new PlayProtocolError(PlayErrorCode.Unsupported, op, `${op} refused: not here`);
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

  it("counts only the actions whose every op the game accepted, and says which op it refused", async () => {
    const { target } = recordedTarget((op) => (op === PlayOp.Look ? unsupported(op) : {}));
    const done = await target.input([
      { type: "type", text: "a" },
      { type: "look", dx: 3, dy: 0 },
      { type: "type", text: "b" },
    ]);
    assert.deepEqual(done, { applied: 2, route: InputRoute.Bridge });
    assert.deepEqual(
      target.refusals().map((refusal) => [refusal.op, refusal.code]),
      [[PlayOp.Look, PlayErrorCode.Unsupported]],
    );
    assert.deepEqual(target.refusals(), [], "reading the refusals clears them");
  });

  it("lets go of a click's modifiers when the game refuses the click", async () => {
    const { target, calls } = recordedTarget((op) => (op === PlayOp.Pointer ? unsupported(op) : {}));
    const done = await target.input([{ type: "click", x: 1, y: 1, px: true, modifiers: ["shift"] }]);
    assert.equal(done.applied, 0);
    assert.deepEqual(calls, [
      [PlayOp.Key, { code: "ShiftLeft", down: true }],
      [PlayOp.Pointer, { x: 1, y: 1, button: "left", click: 1 }],
      [PlayOp.Key, { code: "ShiftLeft", down: false }],
    ]);
  });

  it("lets go of a held key when the step that holds it is refused, and does not count the tap", async () => {
    const { target, calls } = recordedTarget((op) => (op === PlayOp.Step ? unsupported(op) : {}));
    await target.clock?.pause();
    const done = await target.input([{ type: "tap", keys: ["d"], stepMs: 32 }]);
    assert.equal(done.applied, 0);
    assert.deepEqual(calls, [
      [PlayOp.Pause, {}],
      [PlayOp.Key, { code: "KeyD", down: true }],
      [PlayOp.Step, { ms: 32 }],
      [PlayOp.Key, { code: "KeyD", down: false }],
    ]);
  });

  it("answers a refused step as a clock that cannot step, with the refusal kept for the session", async () => {
    const { target } = recordedTarget((op) => (op === PlayOp.Step ? unsupported(op) : {}));
    assert.equal(await target.clock?.step?.(100), null);
    const [refusal] = target.refusals();
    assert.equal(refusal?.op, PlayOp.Step);
    assert.equal(refusal?.code, PlayErrorCode.Unsupported);
    assert.match(String(refusal?.message), /not here/);
  });

  it("still fails a step when the game process is gone", async () => {
    const { target } = recordedTarget(() => new PlayProtocolError(PlayFailure.Exited, PlayOp.Step, "gone"));
    await assert.rejects(target.clock?.step?.(100) ?? Promise.resolve(), /gone/);
  });

  it("steps a long hold in pieces the game must accept, each under a deadline that grows with it", async () => {
    const { target, calls, deadlines } = recordedTarget((op, args) =>
      op === PlayOp.Step ? { simulatedMs: args.ms } : {},
    );
    assert.equal(await target.clock?.step?.(MAX_HOLD_KEY_MS), MAX_HOLD_KEY_MS);
    const steps = calls.filter(([op]) => op === PlayOp.Step).map(([, args]) => Number(args.ms));
    assert.ok(steps.length > 1, "a five-minute hold is more than one step");
    assert.ok(steps.every((ms) => ms > 0 && ms <= PLAY_MAX_STEP_MS));
    assert.equal(
      steps.reduce((sum, ms) => sum + ms, 0),
      MAX_HOLD_KEY_MS,
    );
    for (const [, timeoutMs] of deadlines.filter(([op]) => op === PlayOp.Step))
      assert.ok((timeoutMs ?? 0) > PLAY_MAX_STEP_MS, `a minute's step waits longer than a minute (${timeoutMs})`);
    deadlines.length = 0;
    await target.clock?.step?.(16);
    const short = deadlines.find(([op]) => op === PlayOp.Step)?.[1];
    assert.ok((short ?? 0) >= PLAY_CALL_TIMEOUT_MS, "a short step keeps at least the usual deadline");
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

  it("reads the build a game names, and drops what is not one", () => {
    const base = { protocol: 3, view: { width: 10, height: 10 } };
    assert.deepEqual(readHello({ ...base, build: { id: "b-42", sourceHash: "abc123" } })?.build, {
      id: "b-42",
      sourceHash: "abc123",
    });
    assert.deepEqual(readHello({ ...base, build: { id: "b-42" } })?.build, { id: "b-42", sourceHash: null });
    assert.equal(readHello(base)?.build, null);
    assert.equal(readHello({ ...base, build: { id: 7 } })?.build, null);
    assert.equal(readHello({ ...base, build: { id: "" } })?.build, null);
    const hostile = readHello({ ...base, build: { id: `a\u0007b\n${"z".repeat(5_000)}`, sourceHash: 9 } })?.build;
    assert.ok(hostile);
    assert.ok(hostile.id.startsWith("abz"), "control characters are dropped");
    assert.ok(hostile.id.length <= 200, "a runaway id is cut");
    assert.equal(hostile.sourceHash, null);
  });

  it("reads the core ops a game says it lacks, beside those its levels rule out", () => {
    const hello = readHello({
      protocol: 3,
      view: { width: 10, height: 10 },
      capabilities: { pointer: "relative", clock: "freeze", state: "game", seed: false, actions: [] },
      unsupported: ["type", "screenshot", "teleport"],
    });
    assert.ok(hello);
    assert.deepEqual(
      [...lackedOps(hello)].sort(),
      [PlayOp.Act, PlayOp.Pointer, PlayOp.Reset, PlayOp.Step, PlayOp.Type, PlayOp.Wheel].sort(),
      "screenshot is never optional and an unknown name is ignored",
    );
    assert.deepEqual(lackedOps(HELLO), []);
  });

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

/** How long a game flooding stderr is given to say ready: plenty when the pipe is read, never enough when it is not. */
const STDERR_FLOOD_READY_MS = 8_000;

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

  it("refuses a game that speaks another protocol version, and leaves nothing running", async () => {
    const { sandbox } = await recordingSandbox();
    const pidFile = path.join(await tmpDir("bridge-pid-"), "pid");
    const loaded = await source(sandbox).load(await bridgeProject(["--protocol=2", `--pid-file=${pidFile}`]), false);
    assert.match(String(loaded.problem), /Play Protocol 2.*studio speaks 3/);
    assert.equal(running(await pidIn(pidFile)), false);
    await assert.rejects(loaded.target.screenshot({ quality: 80, surface: CaptureSurface.Auto }));
  });

  it("names the build it plays in the load's note", async () => {
    const { sandbox } = await recordingSandbox();
    const root = await bridgeProject(["--build=b-42", "--source-hash=abc123"]);
    const loaded = await source(sandbox).load(root, false);
    assert.equal(loaded.problem, null);
    assert.deepEqual(loaded.target.hello?.build, { id: "b-42", sourceHash: "abc123" });
    assert.match(String(loaded.note), /build b-42.*abc123/);
  });

  it("reads a game that floods stderr before it says ready, instead of blocking it", async () => {
    const { sandbox } = await recordingSandbox();
    const root = await bridgeProject(["--stderr-flood=300000"]);
    const loaded = await source(sandbox, { client: { readyTimeoutMs: STDERR_FLOOD_READY_MS } }).load(root, false);
    assert.equal(loaded.problem, null);
    assert.ok(await loaded.target.state?.(), "the game answers once it is up");
  });

  it("names what the game wrote to stderr when it dies before ready", async () => {
    const { sandbox } = await recordingSandbox();
    const loaded = await source(sandbox).load(
      await bridgeProject(["--stderr=renderer: no Metal device", "--crash"]),
      false,
    );
    assert.match(String(loaded.problem), /renderer: no Metal device/);
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
    const session = computerSession(source(sandbox), await bridgeProject(), {
      pacing: ComputerPacing.Running,
      frameDir,
    });
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
      pacing: ComputerPacing.Paced,
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

  it("a stepped session replays: the same seed and the same moves land the game in the same state", async () => {
    const play = async () => {
      const { sandbox } = await recordingSandbox();
      const session = computerSession(source(sandbox), await bridgeProject(), {
        pacing: ComputerPacing.Stepped,
        seed: 42,
        frameDir: await tmpDir("bridge-frames-"),
      });
      await session.run("computer", { action: "key", text: "d" });
      await session.run("computer", { action: "wait", duration: 0.5 });
      await session.run("computer", { action: "key", text: "w" });
      const state = await gameState(session);
      assert.equal(session.trace().deterministic, true, "every move ran on a stepped clock");
      return state;
    };
    assert.deepEqual(await play(), await play());
  });

  it("refuses what the game cannot do before it reaches the game", async () => {
    const { sandbox, spawned } = await recordingSandbox();
    const session = computerSession(source(sandbox), await bridgeProject(), {
      pacing: ComputerPacing.Running,
      frameDir: await tmpDir("bridge-frames-"),
    });
    const zoomed = await session.run("computer", { action: "zoom", region: [0, 0, 10, 10] });
    assert.match(typeof zoomed === "string" ? zoomed : zoomed.text, /not available/);
    assert.deepEqual(spawned, [], "a refused action starts nothing");
  });
});

describe("a Play Protocol game on the agent's screen", () => {
  it("each move draws a frame of the game on the worker's screen, as the browser window's do", {
    skip: process.platform === "win32" ? "starts the fake game from a POSIX script" : false,
  }, async () => {
    const { computerTools } = await import("../../src/main/core/computer-tools.ts");
    const { sandbox } = await recordingSandbox();
    const frames: Array<{ caption: string | null; bytes: number; width: number | undefined }> = [];
    const opened: string[] = [];
    const previews = {
      openScreen: (screen: { handle: string }) => opened.push(screen.handle),
      frame: async (
        port: { screenshot(q?: number): Promise<Buffer>; viewSize?(): { width: number } },
        _screen: unknown,
        jpeg: Buffer | null,
        caption: string | null,
      ) => {
        const shot = jpeg ?? (await port.screenshot(60));
        frames.push({ caption, bytes: shot.length, width: port.viewSize?.().width });
      },
    };
    const sessionPort = { get: async () => ({}), handle: () => "pool-1", loaded: null, release: async () => {} };
    const tools = computerTools(
      previews as never,
      { project: "bridge", role: "builder" } as never,
      await bridgeProject(),
      await tmpDir("bridge-screen-"),
      sessionPort as never,
      { bridge: { sandbox } },
    );
    after(() => tools.release());
    await tools.onLiveTool("computer", { action: "key", text: "d" });
    assert.deepEqual(opened, ["pool-1"], "the worker's screen opens with the game");
    assert.ok(frames.length >= 1, "a move draws a frame");
    assert.ok(frames.every((f) => f.bytes > 0 && typeof f.width === "number"));
  });
});

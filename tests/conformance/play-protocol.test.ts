/**
 * The Genex Play Protocol conformance suite (docs/play-protocol.md). An engine plugin — the
 * native engine, Godot, Unity, Unreal — counts as done when it passes this file, run through the
 * studio's real client and GameBridgeTarget, spawned through the ProcessSandbox.
 *
 * By default it runs against `tests/fixtures/fake-play-game.mjs`, once whole and once reduced (a
 * game that honestly declares less). Point `PLAY_GAME_COMMAND` at another engine's command line
 * (run from `PLAY_GAME_CWD`, default this repository) to run the same suite against it; that
 * subject is skipped when the variable is unset. Every check reads only what the engine's `hello`
 * declared, so an engine is never failed for an ability it honestly says it lacks.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { canPause, canPoint, PointerLevel } from "../../src/shared/computer-target.ts";
import { CaptureSurface, type PreviewInputAction } from "../../src/shared/preview-contract.ts";
import {
  PLAY_MAX_STEP_MS,
  PLAY_PROTOCOL_VERSION,
  PlayErrorCode,
  type PlayHello,
  PlayOp,
  lackedOps,
  readScreenshot,
  readStep,
} from "../../src/shared/play-protocol.ts";
import { type GameBridgeLaunch, launchGameBridge } from "../../src/main/core/game-bridge-target.ts";
import { PlayProtocolError } from "../../src/substrate/play-protocol-client.ts";
import { ProcessSandbox, shellQuote } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const FAKE_GAME = path.join(repo, "tests/fixtures/fake-play-game.mjs");
const FAKE_COMMAND = [process.execPath, FAKE_GAME].map(shellQuote).join(" ");
/** How long a paused game is watched to prove nothing moves without a step. */
const STILL_WATCH_MS = 120;

/** The engines this run checks: the fake (whole and reduced) always, another engine when the environment names one. */
const SUBJECTS: Array<{ name: string; command: string; cwd: string; skip: string | false }> = [
  { name: "fake-play-game", command: FAKE_COMMAND, cwd: repo, skip: false },
  { name: "fake-play-game --reduced", command: `${FAKE_COMMAND} --reduced`, cwd: repo, skip: false },
  {
    name: process.env.PLAY_GAME_COMMAND ?? "PLAY_GAME_COMMAND",
    command: process.env.PLAY_GAME_COMMAND ?? "",
    cwd: process.env.PLAY_GAME_CWD ?? repo,
    skip: process.env.PLAY_GAME_COMMAND ? false : "set PLAY_GAME_COMMAND to run the suite against another engine",
  },
];

/** Arguments every core op accepts, for asking a game for an op it says it lacks. */
const VALID_ARGS: Record<PlayOp, Record<string, unknown>> = {
  hello: {},
  screenshot: {},
  pointer: { x: 1, y: 1 },
  key: { code: "KeyA" },
  type: { text: "a" },
  look: { dx: 1, dy: 0 },
  wheel: { dx: 0, dy: 1 },
  act: { list: [{ action: "jump", state: "press" }] },
  pause: {},
  play: {},
  step: { ms: 16 },
  reset: { seed: 1 },
  state: {},
  quit: {},
};

/** Requests every game must refuse, with the code it must refuse them with (skipped for an op it lacks). */
const MALFORMED: Array<{ op: string; args: Record<string, unknown>; code: PlayErrorCode }> = [
  { op: "definitely-not-an-op", args: {}, code: PlayErrorCode.UnknownOp },
  { op: "STATE", args: {}, code: PlayErrorCode.UnknownOp },
  { op: "", args: {}, code: PlayErrorCode.UnknownOp },
  { op: PlayOp.Step, args: { ms: "soon" }, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Step, args: { ms: -5 }, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Step, args: { ms: 0 }, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Key, args: {}, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Key, args: { code: 5 }, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Key, args: { code: "KeyA", down: "yes" }, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Pointer, args: { x: "1", y: 2 }, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Pointer, args: { x: 1, y: 2, button: "thumb" }, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Pointer, args: { x: 1, y: 2, click: 9 }, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Type, args: { text: 42 }, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Look, args: { dx: "1", dy: 0 }, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Wheel, args: { dy: 3 }, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Act, args: { list: "jump" }, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Act, args: { list: [{ action: "jump", state: "bounce" }] }, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Reset, args: { seed: -1 }, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Reset, args: { seed: 1.5 }, code: PlayErrorCode.BadArgs },
  { op: PlayOp.Screenshot, args: { format: "gif" }, code: PlayErrorCode.BadArgs },
];

/** The width and height a PNG or JPEG says it has, read from its header. */
function imageSize(bytes: Buffer): { width: number; height: number } | null {
  const png = bytes.subarray(1, 4).toString("ascii") === "PNG";
  if (png) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  for (let at = 2; at + 9 < bytes.length; ) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

/** A picture's bytes, hashed. */
function pictureHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Is this a non-null, non-array object whose fields can be read? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A state with what the engine marked volatile set aside: what a replay must reproduce. */
function replayable(state: unknown): unknown {
  if (!isRecord(state)) return state;
  const { volatile: _volatile, ...rest } = state;
  return rest;
}

/** The simulation's fingerprint: the engine's checksum when it has one, else its replayable state without the input echo. */
function fingerprint(state: unknown): string {
  const kept = replayable(state);
  if (!isRecord(kept)) return JSON.stringify(kept);
  if (typeof kept.checksum === "string") return kept.checksum;
  const { input: _input, ...simulation } = kept;
  return JSON.stringify(simulation);
}

/** The input echo a game's state may carry (docs/play-protocol.md, `state`): what it received. */
interface InputEcho {
  pointer?: { x: number; y: number; buttons?: string[] };
  keys?: string[];
  typed?: string;
  look?: { dx: number; dy: number };
  wheel?: { dx: number; dy: number };
}

/** The state's input echo, when the engine keeps one. */
function echoOf(state: unknown): InputEcho | null {
  return isRecord(state) && isRecord(state.input) ? (state.input as InputEcho) : null;
}

/** The typed failure a promise rejected with. */
async function refusal(promise: Promise<unknown>, what = "the call"): Promise<PlayProtocolError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlayProtocolError, `a PlayProtocolError, got ${String(error)}`);
    return error;
  }
  assert.fail(`${what} was answered instead of refused`);
}

for (const subject of SUBJECTS) {
  describe(`play protocol conformance — ${subject.name}`, { skip: subject.skip }, () => {
    let sandbox: ProcessSandbox;
    let game: GameBridgeLaunch;

    before(async () => {
      const root = await tmpDir("play-conformance-");
      sandbox = await ProcessSandbox.create({
        writableRoots: [root],
        scratchDir: path.join(root, "scratch"),
        secretPaths: [],
        enabled: false,
      });
      game = await launchGameBridge({ sandbox, command: subject.command, cwd: subject.cwd, label: "conformance" });
    });

    after(async () => {
      await game?.stop();
      await sandbox?.dispose();
    });

    /** The game's hello, read at launch. */
    const hello = (): PlayHello => {
      assert.ok(game.target.hello, "hello was read");
      return game.target.hello;
    };
    /** Whether the game takes this core op, by its hello. */
    const takes = (op: PlayOp) => !lackedOps(hello()).includes(op);
    const state = () => game.target.state?.() ?? Promise.resolve(null);
    const input = (actions: PreviewInputAction[]) => game.target.input(actions);
    /** Pause and, when the game can, reseed it: a known start for a row. */
    const freshStart = async (seed: number) => {
      await game.target.clock?.pause();
      await game.target.seed?.(seed);
    };

    it("says hello: protocol 3, a view, capability levels, a build when it names one, no core op among its own", () => {
      assert.equal(hello().protocol, PLAY_PROTOCOL_VERSION);
      assert.ok(hello().view.width > 0 && hello().view.height > 0);
      const core: readonly string[] = Object.values(PlayOp);
      for (const op of hello().ops) assert.ok(!core.includes(op), `${op} is a core op, not a game op`);
      assert.deepEqual(game.target.viewSize(), hello().view);
      if (hello().build) assert.ok(hello().build?.id, "a named build has an id");
    });

    it("pauses: a paused game's state stands still", async (t) => {
      if (!canPause(game.target.caps)) return t.skip("the engine declares no step-locked clock");
      await game.target.clock?.pause();
      const first = fingerprint(await state());
      await sleep(STILL_WATCH_MS);
      assert.equal(fingerprint(await state()), first);
    });

    it("steps by milliseconds and says how many it simulated", async (t) => {
      if (!canPause(game.target.caps)) return t.skip("the engine declares no step-locked clock");
      await game.target.clock?.pause();
      const before = fingerprint(await state());
      const ran = readStep(await game.client.call(PlayOp.Step, { ms: 200 }));
      assert.ok(ran !== null && ran > 0, `step answered simulatedMs ${ran}`);
      assert.ok(Math.abs(ran - 200) <= 50, `simulated ${ran} ms for 200 asked`);
      assert.notEqual(fingerprint(await state()), before, "the simulation moved");
    });

    it("rounds a step to whole ticks, at least one, and takes the longest step the studio sends", async (t) => {
      if (!canPause(game.target.caps)) return t.skip("the engine declares no step-locked clock");
      await game.target.clock?.pause();
      const tiny = readStep(await game.client.call(PlayOp.Step, { ms: 1 }));
      assert.ok(tiny !== null && tiny > 0, `a 1 ms step runs at least one tick (answered ${tiny})`);
      const longest = await game.target.clock?.step?.(PLAY_MAX_STEP_MS);
      assert.ok(typeof longest === "number" && Math.abs(longest - PLAY_MAX_STEP_MS) <= tiny, `simulated ${longest}`);
    });

    it("replays: the same seed and the same inputs reach the same state", async (t) => {
      const caps = game.target.caps;
      if (!caps.seed || !canPause(caps)) return t.skip("the engine declares no seed or no step-locked clock");
      const run = async () => {
        await freshStart(42);
        await input([{ type: "down", keys: ["ArrowRight"] }]);
        await game.target.clock?.step?.(160);
        await input([{ type: "up", keys: ["ArrowRight"] }]);
        const first = hello().capabilities.actions[0];
        if (caps.actions && first) await game.target.act?.([{ action: first, state: "press" }]);
        await game.target.clock?.step?.(320);
        return replayable(await state());
      };
      const first = await run();
      const second = await run();
      assert.deepEqual(second, first);
    });

    it("applies ops in the order it received them, whatever order the replies take", async (t) => {
      const caps = game.target.caps;
      if (!caps.seed || !canPause(caps)) return t.skip("the engine declares no seed or no step-locked clock");
      const plan: Array<[PlayOp, Record<string, unknown>]> = [
        [PlayOp.Key, { code: "ArrowRight", down: true }],
        [PlayOp.Step, { ms: 96 }],
        [PlayOp.Key, { code: "ArrowRight", down: false }],
        [PlayOp.Key, { code: "Space" }],
        [PlayOp.Step, { ms: 96 }],
      ];
      await freshStart(5);
      for (const [op, args] of plan) await game.client.send(op, args);
      const awaited = fingerprint(await state());
      await freshStart(5);
      await Promise.all(plan.map(([op, args]) => game.client.send(op, args)));
      assert.equal(fingerprint(await state()), awaited, "sent at once, applied as sent");
    });

    it("acts: a named action given while paused takes effect on the next step, not before", async (t) => {
      const caps = game.target.caps;
      const actions = hello().capabilities.actions;
      if (!caps.actions || !caps.seed || !canPause(caps))
        return t.skip("the engine declares no actions, seed or clock");
      const reach = async (list: Parameters<NonNullable<typeof game.target.act>>[0]) => {
        await freshStart(7);
        const start = fingerprint(await state());
        if (list.length) await game.target.act?.(list);
        await sleep(STILL_WATCH_MS);
        assert.equal(fingerprint(await state()), start, "nothing moved before the step");
        await game.target.clock?.step?.(160);
        return fingerprint(await state());
      };
      const idle = await reach([]);
      const moved = [];
      for (const action of actions) moved.push(await reach([{ action, state: "hold", ticks: 10 }]));
      assert.ok(
        moved.some((print) => print !== idle),
        "at least one declared action changes the state",
      );
    });

    it("queues keys and clicks given while paused until the next step", async (t) => {
      const caps = game.target.caps;
      if (!canPause(caps)) return t.skip("the engine declares no step-locked clock");
      await freshStart(9);
      const start = fingerprint(await state());
      const view = hello().view;
      const queued: PreviewInputAction[] = [{ type: "down", keys: ["ArrowRight"] }];
      if (canPoint(caps) && takes(PlayOp.Pointer)) {
        for (const x of [0.2, 0.4, 0.6, 0.8])
          for (const y of [0.25, 0.5, 0.75, 0.9])
            queued.push({ type: "click", x: Math.floor(x * view.width), y: Math.floor(y * view.height), px: true });
      }
      const done = await input(queued);
      assert.equal(done.applied, queued.length, "every queued action was accepted");
      await game.client.call(PlayOp.Key, { code: "Space" });
      await sleep(STILL_WATCH_MS);
      assert.equal(fingerprint(await state()), start, "nothing the game was given moved it before the step");
      await game.target.clock?.step?.(16);
      await input([{ type: "up", keys: ["ArrowRight"] }]);
    });

    it("clicks at an absolute pixel: the click lands where it was asked", async (t) => {
      if (!canPoint(game.target.caps) || !takes(PlayOp.Pointer))
        return t.skip("the engine declares no absolute pointer");
      const at = { x: Math.floor(hello().view.width / 4), y: Math.floor(hello().view.height / 2) };
      const done = await input([{ type: "click", ...at, px: true }]);
      assert.equal(done.applied, 1);
      assert.deepEqual(game.target.pointer(), at);
      const echo = echoOf(await state());
      if (!echo?.pointer) return t.diagnostic("the state keeps no input echo: only the acceptance was checked");
      assert.deepEqual({ x: echo.pointer.x, y: echo.pointer.y }, at);
      assert.deepEqual(echo.pointer.buttons ?? [], [], "a click leaves no button held");
    });

    it("types Unicode text as characters", async (t) => {
      if (!takes(PlayOp.Type)) return t.skip("the engine declares no text input");
      const text = "héllo, wörld ✓ 🎮";
      assert.equal((await input([{ type: "type", text }])).applied, 1);
      const echo = echoOf(await state());
      if (typeof echo?.typed !== "string") return t.diagnostic("the state keeps no typed echo");
      assert.ok(echo.typed.endsWith(text), `typed ${JSON.stringify(echo.typed.slice(-40))}`);
    });

    it("looks by relative view pixels", async (t) => {
      if (game.target.caps.pointer === PointerLevel.None || !takes(PlayOp.Look))
        return t.skip("the engine declares no pointer to look with");
      const before = echoOf(await state())?.look;
      assert.equal((await input([{ type: "look", dx: 12, dy: -7 }])).applied, 1);
      const after = echoOf(await state())?.look;
      if (!before || !after) return t.diagnostic("the state keeps no look echo");
      assert.deepEqual({ dx: after.dx - before.dx, dy: after.dy - before.dy }, { dx: 12, dy: -7 });
    });

    it("wheels at the pointer", async (t) => {
      if (!canPoint(game.target.caps) || !takes(PlayOp.Wheel)) return t.skip("the engine declares no absolute pointer");
      const before = echoOf(await state())?.wheel;
      const at = { x: 3, y: 4 };
      assert.equal((await input([{ type: "scroll", dx: 0, dy: 120, ...at }])).applied, 1);
      const echo = echoOf(await state());
      if (!before || !echo?.wheel) return t.diagnostic("the state keeps no wheel echo");
      assert.deepEqual({ dx: echo.wheel.dx - before.dx, dy: echo.wheel.dy - before.dy }, { dx: 0, dy: 120 });
      if (echo.pointer) assert.deepEqual({ x: echo.pointer.x, y: echo.pointer.y }, at);
    });

    it("photographs: an image of the declared size, inline", async () => {
      const shot = await game.target.screenshot({ quality: 80, surface: CaptureSurface.Auto });
      assert.deepEqual(imageSize(shot.jpeg), game.target.viewSize());
      const raw = readScreenshot(await game.client.call(PlayOp.Screenshot, {}));
      assert.ok(raw, "a bare screenshot request is answered too");
      assert.deepEqual({ width: raw.width, height: raw.height }, game.target.viewSize());
    });

    it("photographs the stepped state, and a picture never moves time", async (t) => {
      const caps = game.target.caps;
      if (!canPause(caps)) return t.skip("the engine declares no step-locked clock");
      await freshStart(13);
      const start = fingerprint(await state());
      const shoot = () => game.target.screenshot({ quality: 80, surface: CaptureSurface.Auto });
      const before = await shoot();
      assert.equal(fingerprint(await state()), start, "a screenshot advanced no time");
      await input([{ type: "down", keys: ["ArrowRight"] }]);
      const first = hello().capabilities.actions[0];
      if (caps.actions && first) await game.target.act?.([{ action: first, state: "hold", ticks: 30 }]);
      await game.target.clock?.step?.(480);
      await input([{ type: "up", keys: ["ArrowRight"] }]);
      const after = await shoot();
      assert.deepEqual(imageSize(after.jpeg), game.target.viewSize());
      if (fingerprint(await state()) === start) return t.diagnostic("nothing moved, so the pictures may match");
      assert.notEqual(pictureHash(after.jpeg), pictureHash(before.jpeg), "the picture shows the stepped state");
    });

    it("resets to the initial state with the seed, input and all", async (t) => {
      const caps = game.target.caps;
      if (!caps.seed) return t.skip("the engine declares no seed");
      await freshStart(11);
      const initial = replayable(await state());
      const played: PreviewInputAction[] = [{ type: "down", keys: ["ArrowRight"] }];
      if (takes(PlayOp.Type)) played.push({ type: "type", text: "zz" });
      if (takes(PlayOp.Look) && caps.pointer !== PointerLevel.None) played.push({ type: "look", dx: 5, dy: 5 });
      if (canPoint(caps) && takes(PlayOp.Pointer)) played.push({ type: "click", x: 2, y: 2, px: true });
      await input(played);
      if (canPause(caps)) await game.target.clock?.step?.(200);
      await game.target.seed?.(11);
      assert.deepEqual(replayable(await state()), initial);
    });

    it("refuses with unsupported each core op its hello says it lacks, and the studio counts it unapplied", async (t) => {
      const lacked = lackedOps(hello());
      if (!lacked.length) return t.skip("the engine declares every core op");
      for (const op of lacked) {
        const error = await refusal(game.client.send(op, VALID_ARGS[op]), op);
        assert.equal(error.code, PlayErrorCode.Unsupported, `${op} answered ${error.code}`);
      }
      if (lacked.includes(PlayOp.Type)) {
        assert.equal((await input([{ type: "type", text: "a" }])).applied, 0);
        assert.deepEqual(
          game.target.refusals().map((refused) => refused.code),
          [PlayErrorCode.Unsupported],
        );
      }
    });

    it("refuses unknown ops with unknown-op and malformed arguments with bad-args, and keeps answering", async () => {
      const lacked: readonly string[] = lackedOps(hello());
      for (const row of MALFORMED) {
        if (lacked.includes(row.op)) continue;
        const what = `${row.op || "(no op)"} ${JSON.stringify(row.args)}`;
        const error = await refusal(game.client.send(row.op, row.args), what);
        assert.equal(error.code, row.code, `${what} answered ${error.code}`);
      }
      assert.ok(await game.target.state?.(), "the game still answers");
    });

    it("survives hostile lines on its stdin and keeps answering", async () => {
      const stdin = game.child.stdin;
      assert.ok(stdin);
      stdin.write("{not json\n");
      stdin.write("[1,2,3]\n");
      stdin.write(`${JSON.stringify({ op: PlayOp.State })}\n`);
      stdin.write(`${JSON.stringify({ id: "x", op: 7 })}\n`);
      stdin.write("\n\n");
      assert.ok(await game.target.state?.(), "the game still answers after garbage");
      assert.ok(game.running());
    });

    it("quits on request, and the process is gone", async () => {
      await game.client.call(PlayOp.Quit, {});
      const exit = await game.exited;
      assert.equal(exit.code, 0);
      assert.equal(game.running(), false);
    });
  });
}

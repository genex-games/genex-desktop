/**
 * The Genex Play Protocol conformance suite (docs/play-protocol.md). An engine plugin — the
 * native engine, Godot, Unity, Unreal — counts as done when it passes this file, run through the
 * studio's real client and GameBridgeTarget, spawned through the ProcessSandbox.
 *
 * By default it runs against `tests/fixtures/fake-play-game.mjs`. Point `PLAY_GAME_COMMAND` at
 * another engine's command line (run from `PLAY_GAME_CWD`, default this repository) to run the
 * same suite against it; that subject is skipped when the variable is unset. Every check reads
 * only what the engine's `hello` declared, so an engine is never failed for an ability it
 * honestly says it lacks.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { canPause } from "../../src/shared/computer-target.ts";
import { CaptureSurface } from "../../src/shared/preview-contract.ts";
import {
  PLAY_PROTOCOL_VERSION,
  PlayErrorCode,
  PlayOp,
  readScreenshot,
  readStep,
} from "../../src/shared/play-protocol.ts";
import { type GameBridgeLaunch, launchGameBridge } from "../../src/main/core/game-bridge-target.ts";
import { PlayProtocolError } from "../../src/substrate/play-protocol-client.ts";
import { ProcessSandbox, shellQuote } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const FAKE_GAME = path.join(repo, "tests/fixtures/fake-play-game.mjs");

/** The engines this run checks: the fake always, another engine when the environment names one. */
const SUBJECTS: Array<{ name: string; command: string; cwd: string; skip: string | false }> = [
  { name: "fake-play-game", command: [process.execPath, FAKE_GAME].map(shellQuote).join(" "), cwd: repo, skip: false },
  {
    name: process.env.PLAY_GAME_COMMAND ?? "PLAY_GAME_COMMAND",
    command: process.env.PLAY_GAME_COMMAND ?? "",
    cwd: process.env.PLAY_GAME_CWD ?? repo,
    skip: process.env.PLAY_GAME_COMMAND ? false : "set PLAY_GAME_COMMAND to run the suite against another engine",
  },
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

/** A state with what the engine marked volatile set aside: what a replay must reproduce. */
function replayable(state: unknown): unknown {
  if (typeof state !== "object" || state === null) return state;
  const { volatile: _volatile, ...rest } = state as Record<string, unknown>;
  return rest;
}

/** The engine's checksum when it has one, else its whole replayable state. */
function fingerprint(state: unknown): string {
  const kept = replayable(state);
  const checksum = typeof kept === "object" && kept !== null ? (kept as { checksum?: unknown }).checksum : undefined;
  return typeof checksum === "string" ? checksum : JSON.stringify(kept);
}

/** The typed failure a promise rejected with. */
async function refusal(promise: Promise<unknown>): Promise<PlayProtocolError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlayProtocolError, `a PlayProtocolError, got ${String(error)}`);
    return error;
  }
  assert.fail("the call was answered instead of refused");
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

    it("says hello: protocol 3, a view, capability levels, and no core op among its own", () => {
      const hello = game.target.hello;
      assert.ok(hello, "hello was read");
      assert.equal(hello.protocol, PLAY_PROTOCOL_VERSION);
      assert.ok(hello.view.width > 0 && hello.view.height > 0);
      const core: readonly string[] = Object.values(PlayOp);
      for (const op of hello.ops) assert.ok(!core.includes(op), `${op} is a core op, not a game op`);
      assert.deepEqual(game.target.viewSize(), hello.view);
    });

    it("pauses: a paused game's state stands still", async (t) => {
      if (!canPause(game.target.caps)) return t.skip("the engine declares no step-locked clock");
      await game.target.clock?.pause();
      const first = fingerprint(await game.target.state?.());
      await sleep(120);
      assert.equal(fingerprint(await game.target.state?.()), first);
    });

    it("steps by milliseconds and says how many it simulated", async (t) => {
      if (!canPause(game.target.caps)) return t.skip("the engine declares no step-locked clock");
      await game.target.clock?.pause();
      const before = fingerprint(await game.target.state?.());
      const ran = readStep(await game.client.call(PlayOp.Step, { ms: 200 }));
      assert.ok(ran !== null && ran > 0, `step answered simulatedMs ${ran}`);
      assert.ok(Math.abs(ran - 200) <= 50, `simulated ${ran} ms for 200 asked`);
      assert.notEqual(fingerprint(await game.target.state?.()), before, "the simulation moved");
    });

    it("replays: the same seed and the same inputs reach the same state", async (t) => {
      const caps = game.target.caps;
      if (!caps.seed || !canPause(caps)) return t.skip("the engine declares no seed or no step-locked clock");
      const run = async () => {
        await game.target.clock?.pause();
        await game.target.seed?.(42);
        await game.target.input([{ type: "down", keys: ["ArrowRight"] }]);
        await game.target.clock?.step?.(160);
        await game.target.input([{ type: "up", keys: ["ArrowRight"] }]);
        if (caps.actions && game.target.hello?.capabilities.actions[0]) {
          await game.target.act?.([{ action: game.target.hello.capabilities.actions[0], state: "press" }]);
        }
        await game.target.clock?.step?.(320);
        return replayable(await game.target.state?.());
      };
      const first = await run();
      const second = await run();
      assert.deepEqual(second, first);
    });

    it("acts: a named action changes what the same seed reaches", async (t) => {
      const caps = game.target.caps;
      const actions = game.target.hello?.capabilities.actions ?? [];
      if (!caps.actions || !caps.seed || !canPause(caps))
        return t.skip("the engine declares no actions, seed or clock");
      const reach = async (list: Parameters<NonNullable<typeof game.target.act>>[0]) => {
        await game.target.clock?.pause();
        await game.target.seed?.(7);
        if (list.length) await game.target.act?.(list);
        await game.target.clock?.step?.(160);
        return fingerprint(await game.target.state?.());
      };
      const idle = await reach([]);
      const moved = await Promise.all(actions.map(async (action) => reach([{ action, state: "hold", ticks: 10 }])));
      assert.ok(
        moved.some((print) => print !== idle),
        "at least one declared action changes the state",
      );
    });

    it("photographs: an image of the declared size, inline", async () => {
      const shot = await game.target.screenshot({ quality: 80, surface: CaptureSurface.Auto });
      assert.deepEqual(imageSize(shot.jpeg), game.target.viewSize());
      const raw = readScreenshot(await game.client.call(PlayOp.Screenshot, {}));
      assert.ok(raw, "a bare screenshot request is answered too");
      assert.deepEqual({ width: raw.width, height: raw.height }, game.target.viewSize());
    });

    it("refuses an unknown op with unknown-op, and bad arguments with bad-args", async () => {
      assert.equal((await refusal(game.client.send("definitely-not-an-op", {}))).code, PlayErrorCode.UnknownOp);
      assert.equal((await refusal(game.client.send(PlayOp.Step, { ms: "soon" }))).code, PlayErrorCode.BadArgs);
      assert.equal((await refusal(game.client.send(PlayOp.Key, {}))).code, PlayErrorCode.BadArgs);
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

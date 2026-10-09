/**
 * The playtester's shorthands over a fake window: what each one sends to the page, the frame it
 * leaves on the agent's screen, and the answer the model reads back.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  PLAYTEST_LIMITS,
  PLAYTEST_TOOLS,
  PlaytestTool,
  runPlaytestTool,
  type PlaytestContext,
} from "../../src/main/core/playtest-tools.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";
import { tools as previewTools } from "../../src/harness-seed/tools/preview-tools.ts";
import { playBrief } from "../../src/harness-seed/loop/playtester.ts";
import { tmpDir } from "../helpers/tmp.ts";

function fakeWindow(state: unknown = { x: 1 }) {
  const inputs: unknown[] = [];
  const calls: unknown[][] = [];
  const port = {
    input: async (actions: unknown[]) => void inputs.push(...actions),
    studioState: async () => state,
    studioCall: async (...args: unknown[]) => void calls.push(args),
    screenshot: async () => Buffer.from("plain"),
    screenshotWithStats: async () => ({ jpeg: Buffer.from("jpeg"), stats: { litFraction: 0.5, meanLuma: 99.6 } }),
  } as unknown as PreviewPort;
  return { port, inputs, calls };
}

async function context(dir: string) {
  const frames: Array<{ jpeg: string | null; caption: string }> = [];
  const slept: number[] = [];
  let shots = 0;
  const ctx: PlaytestContext = {
    frame: async (_port, jpeg, caption) => void frames.push({ jpeg: jpeg ? jpeg.toString() : null, caption }),
    shotFile: async (camera) => path.join(dir, `p${++shots}_${camera ?? "view"}.jpg`),
    sleep: async (ms) => void slept.push(ms),
  };
  return { ctx, frames, slept };
}

describe("playtest shorthands", () => {
  it("presses keys with a clamped hold, frames it and answers with the state", async () => {
    const { port, inputs } = fakeWindow({ x: 2 });
    const { ctx, frames } = await context(await tmpDir("playtest-"));
    const answer = await runPlaytestTool(PlaytestTool.PressKeys, { keys: "w, shift", holdMs: 99_999 }, port, ctx);
    assert.equal(answer, 'state: {"x":2}');
    assert.deepEqual(inputs, [{ type: "hold", keys: ["w", "shift"], ms: PLAYTEST_LIMITS.maxHoldMs }]);
    assert.deepEqual(frames, [{ jpeg: null, caption: "press w+shift" }]);

    await runPlaytestTool(PlaytestTool.PressKeys, { keys: "a", holdMs: 1 }, port, ctx);
    await runPlaytestTool(PlaytestTool.PressKeys, { keys: "a" }, port, ctx);
    assert.deepEqual(
      inputs.slice(1).map((action) => (action as { ms: number }).ms),
      [PLAYTEST_LIMITS.minHoldMs, PLAYTEST_LIMITS.defaultHoldMs],
    );
    assert.equal(
      await runPlaytestTool(PlaytestTool.PressKeys, { keys: " , " }, port, ctx),
      'press_keys needs keys, e.g. "w"',
    );
  });

  it("looks, clicks where it was told, and waits no longer than the cap", async () => {
    const { port, inputs } = fakeWindow();
    const { ctx, frames, slept } = await context(await tmpDir("playtest-"));
    await runPlaytestTool(PlaytestTool.Look, { dx: "12", dy: "nope" }, port, ctx);
    await runPlaytestTool(PlaytestTool.Click, { x: 0.25 }, port, ctx);
    await runPlaytestTool(PlaytestTool.Wait, { ms: 60_000 }, port, ctx);
    await runPlaytestTool(PlaytestTool.Wait, { ms: -5 }, port, ctx);
    assert.deepEqual(inputs, [
      { type: "look", dx: 12, dy: 0 },
      { type: "click", x: 0.25 },
    ]);
    assert.deepEqual(
      frames.map((frame) => frame.caption),
      ["look", "click"],
    );
    assert.deepEqual(slept, [PLAYTEST_LIMITS.maxWaitMs, 0]);
  });

  it("reads a missing state as missing, and cuts a long one", async () => {
    const { ctx } = await context(await tmpDir("playtest-"));
    assert.equal(
      await runPlaytestTool(PlaytestTool.GameState, {}, fakeWindow(null).port, ctx),
      'state: {"__missing":true}',
    );
    const long = await runPlaytestTool(PlaytestTool.GameState, {}, fakeWindow({ s: "x".repeat(5_000) }).port, ctx);
    assert.equal(String(long).length, "state: ".length + PLAYTEST_LIMITS.stateChars);
  });

  it("saves a screenshot from the named camera and says where it is", async () => {
    const dir = await tmpDir("playtest-");
    const { port, calls } = fakeWindow();
    const { ctx, frames } = await context(dir);
    const answer = await runPlaytestTool(PlaytestTool.Screenshot, { camera: " eye:here " }, port, ctx);
    const file = path.join(dir, "p1_eye:here.jpg");
    assert.equal(answer, `saved ${file} (litFraction 0.50, meanLuma 100) — Read it to look.`);
    assert.equal(await readFile(file, "utf8"), "jpeg");
    assert.deepEqual(calls, [["debugCamera", "eye:here"]]);
    assert.deepEqual(frames, [{ jpeg: "jpeg", caption: "camera eye:here" }]);
  });

  it("answers a name that is not a shorthand as unknown", async () => {
    const { ctx } = await context(await tmpDir("playtest-"));
    assert.equal(await runPlaytestTool("toString", {}, fakeWindow().port, ctx), "unknown tool toString");
    assert.equal(await runPlaytestTool("fly", {}, fakeWindow().port, ctx), "unknown tool fly");
  });

  it("tells the model the same limits it enforces", () => {
    const byName = new Map(PLAYTEST_TOOLS.map((tool) => [tool.name, JSON.stringify(tool)]));
    assert.deepEqual([...byName.keys()], ["press_keys", "look", "click", "screenshot", "game_state", "wait"]);
    assert.match(byName.get(PlaytestTool.PressKeys) ?? "", /default 400, max 8000/);
    assert.match(byName.get(PlaytestTool.Wait) ?? "", /max 5000/);
  });

  it("lets the game's racing line steer a held throttle when asked, and lets go after", async () => {
    const { port, inputs, calls } = fakeWindow();
    const { ctx } = await context(await tmpDir("playtest-"));
    await runPlaytestTool(PlaytestTool.PressKeys, { keys: "w", holdMs: 3_000, autosteer: true }, port, ctx);
    assert.deepEqual(calls, [
      ["assist", { steer: true }],
      ["assist", { steer: false }],
    ]);
    assert.deepEqual(inputs, [{ type: "hold", keys: ["w"], ms: 3_000 }]);
    await runPlaytestTool(PlaytestTool.PressKeys, { keys: "w" }, port, ctx);
    assert.equal(calls.length, 2, "a plain press steers nothing");
    const described = JSON.stringify(PLAYTEST_TOOLS.find((tool) => tool.name === PlaytestTool.PressKeys));
    assert.match(described, /autosteer/);
  });
});

describe("the direct playtester's press_keys", () => {
  it("lets the game's racing line steer a held throttle when asked, and lets go after", async () => {
    const press = previewTools.find((tool) => tool.name === "press_keys");
    assert.ok(press);
    const sent: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const ctx = {
      call: async (method: string, payload: Record<string, unknown> = {}) => {
        sent.push({ method, payload });
        return method === "preview.state" ? { x: 1 } : { ok: true };
      },
    };
    await press.execute({ keys: ["w"], holdMs: 2_000, autosteer: true }, ctx as never);
    const words = sent.map((c) =>
      c.method === "preview.call" ? `${c.payload.method}:${JSON.stringify(c.payload.arg ?? null)}` : c.method,
    );
    assert.deepEqual(words, [
      "start:null",
      'assist:{"steer":true}',
      "preview.input",
      'assist:{"steer":false}',
      "preview.state",
    ]);
    assert.match(JSON.stringify(press.parameters), /autosteer/);
  });

  it("tells a racer's playtester the racing line can steer a held throttle, and nobody else", () => {
    const brief = (kind: string) =>
      playBrief({ run: { runId: "r", project: "p", game: { kind } } as never, checks: [], maxActions: 20 });
    assert.match(brief("racing"), /press_keys autosteer: true/);
    assert.doesNotMatch(brief("first-person"), /autosteer/);
  });
});

/**
 * The computer session over any target: a fake target records what reached it, so the session's
 * own rules — observing after an action, batches, the action budget, the trace and the clock's
 * pacing — are tested without a window.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { computerSession, type TargetSource } from "../../src/main/core/computer-session.ts";
import { BROWSER_CAPABILITIES, ClockLevel, InputRoute } from "../../src/shared/computer-target.ts";
import type { ComputerTarget } from "../../src/substrate/computer-target.ts";
import type { LiveToolResult } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);
const images = (result: LiveToolResult): number => (typeof result === "string" ? 0 : (result.images?.length ?? 0));

/** A target that records every call in order, with a clock that can step. */
function fakeTarget(options: { stepAnswers?: number | null; failInputAt?: number } = {}) {
  const calls: string[] = [];
  let inputs = 0;
  const target: ComputerTarget = {
    caps: BROWSER_CAPABILITIES,
    viewSize: () => ({ width: 960, height: 600 }),
    pointer: () => ({ x: 1, y: 2 }),
    screenshot: async ({ surface }) => {
      calls.push(`shot:${surface}`);
      return { jpeg: Buffer.from("jpeg"), stats: null, surface: null };
    },
    input: async (actions) => {
      inputs += 1;
      if (options.failInputAt === inputs) throw new Error("the window went away");
      calls.push(`input:${actions.map((a) => a.type).join("+")}`);
      return { applied: actions.length, route: InputRoute.Browser };
    },
    state: async () => ({ hp: 3 }),
    clock: {
      pause: async () => {
        calls.push("pause");
      },
      start: async () => {
        calls.push("start");
      },
      step: async (ms) => {
        calls.push(`step:${ms}`);
        return options.stepAnswers === undefined ? ms : options.stepAnswers;
      },
    },
    seed: async (seed) => {
      calls.push(`seed:${seed}`);
    },
  };
  return { target, calls };
}

/** A source over one fake target: loads it once, frames go nowhere. */
function sourceOf(target: ComputerTarget): TargetSource {
  let loaded = false;
  return {
    caps: target.caps,
    load: async () => {
      const fresh = !loaded;
      loaded = true;
      return { target, problem: null, note: null, fresh };
    },
    frame: async () => {},
  };
}

async function session(options: Partial<Parameters<typeof computerSession>[2]> & { target?: ComputerTarget } = {}) {
  const fake = options.target ? { target: options.target, calls: [] as string[] } : fakeTarget();
  const frameDir = await tmpDir("computer-session-");
  const s = computerSession(sourceOf(fake.target), "/build", { pacing: "running", frameDir, ...options });
  return { s, calls: fake.calls, frameDir };
}

describe("computer session — observe after an action", () => {
  it("returns the picture with the answer when asked, and saves it as a frame", async () => {
    const { s, calls } = await session();
    const answer = await s.run("computer", { action: "key", text: "w", observe: "screenshot" });
    assert.equal(images(answer), 1);
    assert.match(text(answer), /s1_/);
    assert.deepEqual(calls, ["input:press", "shot:auto"]);
  });

  it("observes by default where the session says so, and never when told none", async () => {
    const { s, calls } = await session({ observeByDefault: true });
    assert.equal(images(await s.run("computer", { action: "key", text: "w" })), 1);
    assert.equal(images(await s.run("computer", { action: "key", text: "w", observe: "none" })), 0);
    assert.deepEqual(calls, ["input:press", "shot:auto", "input:press"]);
    assert.doesNotMatch(
      text(await s.run("computer", { action: "key", text: "w", observe: "none" })),
      /Screenshot to see/,
    );
  });

  it("photographs only the canvas when asked", async () => {
    const { s, calls } = await session();
    await s.run("computer", { action: "key", text: "w", observe: "canvas" });
    assert.equal(calls.at(-1), "shot:canvas");
  });
});

describe("computer session — batches and the action budget", () => {
  it("runs a batch in order with one look at the end", async () => {
    const { s, calls } = await session();
    const answer = await s.run("computer", {
      action: "batch",
      actions: [
        { action: "key", text: "w" },
        { action: "left_click", coordinate: "5,5" },
      ],
      observe: "screenshot",
    });
    assert.deepEqual(calls, ["input:press", "input:click", "shot:auto"]);
    assert.equal(images(answer), 1);
    assert.match(text(answer), /2 of 2 steps/);
  });

  it("stops a batch at the first step that fails and names it", async () => {
    const { target, calls } = fakeTarget({ failInputAt: 2 });
    const { s } = await session({ target });
    const answer = await s.run("computer", {
      action: "batch",
      actions: [
        { action: "key", text: "w" },
        { action: "key", text: "a" },
        { action: "key", text: "d" },
      ],
    });
    assert.match(text(answer), /step 2 \(key a\) failed/);
    assert.deepEqual(calls, ["input:press"]);
  });

  it("counts every batch step against the budget, on the host", async () => {
    const { s } = await session({ maxActions: 3 });
    await s.run("computer", {
      action: "batch",
      actions: [
        { action: "key", text: "w" },
        { action: "key", text: "w" },
      ],
    });
    const over = await s.run("computer", {
      action: "batch",
      actions: [
        { action: "key", text: "w" },
        { action: "key", text: "w" },
      ],
    });
    assert.match(text(over), /action budget/);
    const last = await s.run("computer", { action: "key", text: "w" });
    assert.doesNotMatch(text(last), /action budget/);
    assert.match(text(await s.run("computer", { action: "key", text: "w" })), /action budget/);
    assert.doesNotMatch(text(await s.run("computer", { action: "screenshot" })), /action budget/, "looking is free");
  });
});

describe("computer session — the trace", () => {
  it("writes one row per action with its route, frame and cursor", async () => {
    const { s, frameDir } = await session();
    await s.run("computer", { action: "key", text: "w", observe: "screenshot" });
    await s.run("computer", { action: "state" });
    const rows = (await readFile(path.join(frameDir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].action, "key");
    assert.equal(rows[0].route, InputRoute.Browser);
    assert.match(rows[0].frame, /s1_/);
    assert.deepEqual(rows[0].cursor, { x: 1, y: 2 });
    assert.equal(rows[1].action, "state");
    assert.equal(rows[1].route, null);
    assert.equal(s.trace().steps, 2);
    assert.equal(s.trace().path, path.join(frameDir, "trace.jsonl"));
  });
});

describe("computer session — the clock", () => {
  it("a paced session pauses after load and runs the clock only during a move", async () => {
    const { s, calls } = await session({ pacing: "paced" });
    await s.run("computer", { action: "key", text: "w" });
    assert.deepEqual(calls, ["pause", "start", "input:press", "pause"]);
  });

  it("a stepped session seeds, pauses, and steps exact time after each move and through a wait", async () => {
    const { s, calls } = await session({ pacing: "stepped", seed: 7 });
    await s.run("computer", { action: "key", text: "w" });
    await s.run("computer", { action: "wait", duration: 0.5 });
    assert.deepEqual(calls, ["seed:7", "pause", "input:press", "step:120", "step:500"]);
    assert.equal(s.trace().deterministic, true);
  });

  it("a stepped session whose target cannot step falls back to pacing and marks the trace", async () => {
    const { target, calls } = fakeTarget({ stepAnswers: null });
    const { s } = await session({ pacing: "stepped", target });
    await s.run("computer", { action: "key", text: "w" });
    await s.run("computer", { action: "key", text: "w" });
    assert.equal(s.trace().deterministic, false);
    assert.deepEqual(
      calls.slice(-3),
      ["start", "input:press", "pause"],
      "it paces with start/pause once stepping failed",
    );
  });

  it("a target without a holdable clock is never paused, whatever the role", async () => {
    const { target, calls } = fakeTarget();
    const { s } = await session({
      pacing: "paced",
      target: { ...target, caps: { ...BROWSER_CAPABILITIES, clock: ClockLevel.None } },
    });
    await s.run("computer", { action: "key", text: "w" });
    assert.deepEqual(calls, ["input:press"]);
  });
});

describe("computer session — a goal the studio checks", () => {
  it("announces the goal once, the first time the game's own state reaches it, and marks the trace", async () => {
    let hp = 3;
    const { target } = fakeTarget();
    const watched: ComputerTarget = {
      ...target,
      state: async () => ({ flow: { phase: hp > 1 ? "menu" : "playing" } }),
    };
    const { s, frameDir } = await session({
      target: watched,
      quest: { id: "reach-play", until: { path: "flow.phase", equals: "playing" } },
    });
    assert.doesNotMatch(text(await s.run("computer", { action: "key", text: "Return" })), /GOAL REACHED/);
    hp = 1;
    assert.match(
      text(await s.run("computer", { action: "key", text: "Return" })),
      /GOAL REACHED \(studio-verified\): reach-play/,
    );
    assert.doesNotMatch(text(await s.run("computer", { action: "key", text: "Return" })), /GOAL REACHED/, "said once");
    assert.equal(s.trace().reachedAt, 2);
    const rows = (await readFile(path.join(frameDir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(rows[1].reached, true);
  });

  it("a state the studio cannot read never reaches the goal", async () => {
    const { target } = fakeTarget();
    const { s } = await session({
      target: { ...target, state: undefined },
      quest: { id: "x", until: { path: "flow.phase", equals: "playing" } },
    });
    assert.doesNotMatch(text(await s.run("computer", { action: "key", text: "Return" })), /GOAL REACHED/);
    assert.equal(s.trace().reachedAt, null);
  });
});

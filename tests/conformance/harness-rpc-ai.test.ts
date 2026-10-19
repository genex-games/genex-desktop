/**
 * The harness's play-time AI host methods (`main/harness-rpc/ai.ts`): every call names a library
 * game and, at most, a build folder that is the game's own or a run's copy under scratch; a hostile
 * name, folder or field is refused before the play-time AI host sees anything; recording, benching
 * and the model check run on a run budget the host made (this Mac's models, one call at a time, a
 * fixed cap) that nothing the agent sends can raise, and that closes when the call answers.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createRunBudget, HARNESS_RUN_DOORS } from "../../src/main/harness-rpc/ai.ts";
import type { AiRunBudget, GameAiHarnessHost } from "../../src/main/game-ai/types.ts";
import { AiDoor } from "../../src/shared/game-ai.ts";
import { AI_BENCH_MAX_SAMPLES, AiCheckState } from "../../src/shared/game-ai-check.ts";
import { AI_RECORD_MAX_CALLS, AI_REPLAY_MAX_SEEDS, AiReplayAnswers } from "../../src/shared/game-ai-tape.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** One call the fake play-time AI host received. */
interface HostCall {
  method: string;
  args: unknown[];
  budget: AiRunBudget | null;
}

const calls: HostCall[] = [];

/** A play-time AI host that records what it was asked and answers with fixed shapes. */
const host: GameAiHarnessHost = {
  async tapes(project, build) {
    calls.push({ method: "tapes", args: [project, build], budget: null });
    return [];
  },
  async replay(project, demo, seeds, run) {
    calls.push({ method: "replay", args: [project, demo, seeds, run], budget: null });
    return { demo, deterministic: true, stateDigests: seeds.map(() => []), misses: 0, fallbacks: 0, rejected: 0 };
  },
  async record(project, demo, seed, run) {
    calls.push({ method: "record", args: [project, demo, seed, run.root], budget: run.budget });
    return { demo, file: `ai/tapes/${demo}.jsonl`, calls: run.budget.used(), refused: 0 };
  },
  async bench(project, site, samples, run) {
    calls.push({ method: "bench", args: [project, site, samples, run.root], budget: run.budget });
    return {
      site,
      model: null,
      samples,
      fitted: 0,
      medianLatencyMs: null,
      medianInputTokens: null,
      medianOutputTokens: null,
    };
  },
  async modelCheck(project, run) {
    calls.push({ method: "modelCheck", args: [project, run.localOnly], budget: run.budget });
    return {
      project,
      state: AiCheckState.Empty,
      moments: 0,
      progress: null,
      rows: [],
      recommended: null,
      checkedAt: null,
    };
  },
};

let lite: CoreLite;
let bare: CoreLite;
/** The library game, its folder, another game's folder and a folder outside both. */
const GAME = "oracle";
let gameDir: string;
let otherDir: string;
let outside: string;
let scratchRun: string;

const api = (core: CoreLite = lite) => core.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;

before(async () => {
  lite = await coreLite({ gameAi: host });
  bare = await coreLite();
  await api()[HostMethod.GameScaffold]({ name: GAME });
  await api()[HostMethod.GameScaffold]({ name: "other" });
  await api(bare)[HostMethod.GameScaffold]({ name: GAME });
  gameDir = await realpath(lite.core.games.dirFor(GAME));
  otherDir = await realpath(lite.core.games.dirFor("other"));
  outside = await realpath(await tmpDir("ai-rpc-outside-"));
  scratchRun = path.join(await realpath(lite.core.layout.scratch), "autopilot", "run_ai", "worktree");
  await mkdir(scratchRun, { recursive: true });
  await symlink(outside, path.join(gameDir, "escape"));
});
after(async () => {
  await lite.close();
  await bare.close();
});
beforeEach(() => {
  calls.length = 0;
});

describe("ai.* host methods: what reaches the play-time AI host", () => {
  it("names the game's own folder as no root, and a run's copy under scratch by its real path", async () => {
    await api()[HostMethod.AiTapes]({ project: GAME });
    await api()[HostMethod.AiTapes]({ project: GAME, root: gameDir });
    await api()[HostMethod.AiReplay]({ project: GAME, demo: "turn-three", seeds: [1, 2], root: scratchRun });
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        [GAME, { root: null }],
        [GAME, { root: gameDir }],
        [GAME, "turn-three", [1, 2], { root: scratchRun, answers: AiReplayAnswers.Tape }],
      ],
    );
  });

  it("replays with no answer at all only when asked for by name", async () => {
    await api()[HostMethod.AiReplay]({ project: GAME, demo: "turn-three", seeds: [3], answers: AiReplayAnswers.None });
    assert.deepEqual(calls[0]?.args, [GAME, "turn-three", [3], { root: null, answers: AiReplayAnswers.None }]);
  });

  it("hands recording, benching and the model check a fresh run budget it closes when the call answers", async () => {
    await api()[HostMethod.AiRecord]({ project: GAME, demo: "turn-three", seed: 7 });
    await api()[HostMethod.AiBench]({ project: GAME, site: "turn.resolve", samples: 2 });
    await api()[HostMethod.AiBench]({ project: GAME, site: "turn.resolve" });
    await api()[HostMethod.AiModelCheck]({ project: GAME });
    const budgets = calls.map((call) => call.budget);
    assert.deepEqual(
      budgets.map((budget) => ({
        doors: budget?.doors,
        maxCalls: budget?.maxCalls,
        concurrency: budget?.concurrency,
        closed: budget?.closed(),
      })),
      [
        { doors: [AiDoor.Local], maxCalls: AI_RECORD_MAX_CALLS, concurrency: 1, closed: true },
        { doors: [AiDoor.Local], maxCalls: 4, concurrency: 1, closed: true },
        { doors: [AiDoor.Local], maxCalls: AI_BENCH_MAX_SAMPLES * 2, concurrency: 1, closed: true },
        { doors: [AiDoor.Local], maxCalls: AI_RECORD_MAX_CALLS, concurrency: 1, closed: true },
      ],
    );
    assert.equal(new Set(budgets).size, budgets.length, "every call gets its own budget");
    assert.deepEqual(calls[3]?.args, [GAME, true], "the agent's model check is local only");
    assert.equal(budgets[0]?.take(AiDoor.Local), null, "a closed budget takes nothing");
  });

  it("closes the run budget when the host throws", async () => {
    const failing = await coreLite({
      gameAi: {
        ...host,
        async record(_project, _demo, _seed, run) {
          calls.push({ method: "record", args: [], budget: run.budget });
          throw new Error("the local model went away");
        },
      },
    });
    try {
      await api(failing)[HostMethod.GameScaffold]({ name: GAME });
      await assert.rejects(
        api(failing)[HostMethod.AiRecord]({ project: GAME, demo: "turn-three", seed: 1 }),
        /local model went away/,
      );
      assert.equal(calls[0]?.budget?.closed(), true);
    } finally {
      await failing.close();
    }
  });
});

describe("ai.* host methods refuse hostile input with no side effect", () => {
  /** Every row is refused, and the play-time AI host is never called. */
  const HOSTILE: Array<{ name: string; method: string; params: () => unknown }> = [
    { name: "a game outside the library", method: HostMethod.AiTapes, params: () => ({ project: "nobody" }) },
    {
      name: "a climbing game name",
      method: HostMethod.AiReplay,
      params: () => ({ project: "../oracle", demo: "a", seeds: [1] }),
    },
    { name: "another game's folder", method: HostMethod.AiTapes, params: () => ({ project: GAME, root: otherDir }) },
    {
      name: "a folder outside the studio",
      method: HostMethod.AiRecord,
      params: () => ({ project: GAME, demo: "a", seed: 1, root: outside }),
    },
    {
      name: "a link in the game's folder that leaves it",
      method: HostMethod.AiBench,
      params: () => ({ project: GAME, site: "turn.resolve", root: path.join(gameDir, "escape") }),
    },
    {
      name: "a climbing root",
      method: HostMethod.AiTapes,
      params: () => ({ project: GAME, root: `${gameDir}/../other` }),
    },
    {
      name: "a root that does not exist",
      method: HostMethod.AiTapes,
      params: () => ({ project: GAME, root: path.join(gameDir, "nope") }),
    },
    { name: "a root that is not text", method: HostMethod.AiTapes, params: () => ({ project: GAME, root: 7 }) },
    {
      name: "a climbing demo",
      method: HostMethod.AiReplay,
      params: () => ({ project: GAME, demo: "../../x", seeds: [1] }),
    },
    {
      name: "a demo with a separator",
      method: HostMethod.AiRecord,
      params: () => ({ project: GAME, demo: "a/b", seed: 1 }),
    },
    {
      name: "an uppercase demo",
      method: HostMethod.AiReplay,
      params: () => ({ project: GAME, demo: "Turn", seeds: [1] }),
    },
    { name: "an empty demo", method: HostMethod.AiReplay, params: () => ({ project: GAME, demo: "", seeds: [1] }) },
    { name: "no seeds", method: HostMethod.AiReplay, params: () => ({ project: GAME, demo: "a", seeds: [] }) },
    {
      name: "more seeds than a replay runs",
      method: HostMethod.AiReplay,
      params: () => ({ project: GAME, demo: "a", seeds: Array.from({ length: AI_REPLAY_MAX_SEEDS + 1 }, (_, i) => i) }),
    },
    { name: "a negative seed", method: HostMethod.AiRecord, params: () => ({ project: GAME, demo: "a", seed: -1 }) },
    {
      name: "a fractional seed",
      method: HostMethod.AiReplay,
      params: () => ({ project: GAME, demo: "a", seeds: [1.5] }),
    },
    {
      name: "a seed past the safe integers",
      method: HostMethod.AiRecord,
      params: () => ({ project: GAME, demo: "a", seed: 2 ** 53 }),
    },
    {
      name: "an answer source it does not know",
      method: HostMethod.AiReplay,
      params: () => ({ project: GAME, demo: "a", seeds: [1], answers: "live" }),
    },
    {
      name: "a site with a space",
      method: HostMethod.AiBench,
      params: () => ({ project: GAME, site: "turn resolve" }),
    },
    { name: "a site that climbs", method: HostMethod.AiBench, params: () => ({ project: GAME, site: "../turn" }) },
    {
      name: "zero samples",
      method: HostMethod.AiBench,
      params: () => ({ project: GAME, site: "turn.resolve", samples: 0 }),
    },
    {
      name: "more samples than a bench takes",
      method: HostMethod.AiBench,
      params: () => ({ project: GAME, site: "turn.resolve", samples: AI_BENCH_MAX_SAMPLES + 1 }),
    },
    {
      name: "a model check of a game outside the library",
      method: HostMethod.AiModelCheck,
      params: () => ({ project: "nobody" }),
    },
    { name: "no params at all", method: HostMethod.AiRecord, params: () => null },
  ];

  for (const row of HOSTILE) {
    it(`refuses ${row.name}`, async () => {
      await assert.rejects(api()[row.method](row.params()));
      assert.deepEqual(calls, []);
    });
  }

  it("ignores every field that would size, widen or skip the run budget", async () => {
    const widen = {
      maxCalls: 1e9,
      concurrency: 8,
      doors: [AiDoor.Byok, AiDoor.Plan, AiDoor.GenexCredits],
      budget: { maxCalls: 1e9 },
      localOnly: false,
    };
    await api()[HostMethod.AiRecord]({ project: GAME, demo: "a", seed: 1, ...widen });
    await api()[HostMethod.AiBench]({ project: GAME, site: "turn.resolve", samples: 1, ...widen });
    await api()[HostMethod.AiModelCheck]({ project: GAME, ...widen });
    assert.deepEqual(
      calls.map((call) => [call.budget?.maxCalls, call.budget?.doors]),
      [
        [AI_RECORD_MAX_CALLS, [AiDoor.Local]],
        [2, [AiDoor.Local]],
        [AI_RECORD_MAX_CALLS, [AiDoor.Local]],
      ],
    );
    assert.equal(calls[2]?.args[1], true);
  });

  it("answers a studio without play-time AI with a refusal, except the pure schema check", async () => {
    const off = /play-time AI isn't running/;
    await assert.rejects(api(bare)[HostMethod.AiTapes]({ project: GAME }), off);
    await assert.rejects(api(bare)[HostMethod.AiReplay]({ project: GAME, demo: "a", seeds: [1] }), off);
    await assert.rejects(api(bare)[HostMethod.AiRecord]({ project: GAME, demo: "a", seed: 1 }), off);
    await assert.rejects(api(bare)[HostMethod.AiBench]({ project: GAME, site: "a" }), off);
    await assert.rejects(api(bare)[HostMethod.AiModelCheck]({ project: GAME }), off);
    assert.deepEqual(await api(bare)[HostMethod.AiSchemaCheck]({ schema: { type: "string" } }), { ok: true });
  });
});

describe("a run budget", () => {
  it("takes one call at a time, on its own doors, up to its cap", () => {
    const { budget, close } = createRunBudget(2);
    assert.deepEqual(budget.doors, HARNESS_RUN_DOORS);
    assert.equal(budget.take(AiDoor.Byok), null, "a key is never a run budget's door");
    assert.equal(budget.take(AiDoor.Plan), null, "neither is a plan");
    const first = budget.take(AiDoor.Local);
    assert.ok(first);
    assert.equal(budget.take(AiDoor.Local), null, "one call at a time");
    first.release();
    first.release();
    const second = budget.take(AiDoor.Local);
    assert.ok(second, "a double release frees one slot, once");
    second.release();
    assert.equal(budget.take(AiDoor.Local), null, "the cap is spent");
    assert.equal(budget.used(), 2);
    close();
    assert.equal(budget.closed(), true);
  });

  it("cannot be widened by its holder", () => {
    const { budget } = createRunBudget(1);
    assert.throws(() => Object.assign(budget, { maxCalls: 1e9 }));
    assert.throws(() => (budget.doors as AiDoor[]).push(AiDoor.Byok));
    assert.equal(budget.maxCalls, 1);
  });

  it("takes nothing with a cap that is not a positive whole number", () => {
    for (const cap of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      assert.equal(createRunBudget(cap).budget.take(AiDoor.Local), null, String(cap));
    }
  });

  it("refuses the doors no run budget opens", () => {
    const { budget } = createRunBudget(AI_RECORD_MAX_CALLS);
    for (const door of Object.values(AiDoor).filter((door) => door !== AiDoor.Local))
      assert.equal(budget.take(door), null, door);
  });
});

/**
 * The seeded soak and its two five-minute rows, replayed on a virtual clock. One constant per window
 * (Rule 1): the soak and both rows read `SPEC_SOAK_MS`, so a shorter soak is `unknown`, never a
 * verdict inherited from a window it never observed. A guard's refusal consumes the same RNG draws,
 * a stopped main thread is a crash, a quantised heap is no measurement, and only a stillness fail is
 * routed through the door demotions.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SECOND_MS } from "../../src/shared/duration.ts";
import type { ProbeSample } from "../../scripts/evals/prober/instrument.ts";
import { BaselineName, buildBaseline } from "../../scripts/evals/prober/phases/baseline.ts";
import {
  mulberry32,
  SOAK_HANG_STREAK,
  SOAK_WINDOW_MS,
  type SoakDeps,
  type SoakRun,
  soakPhase,
  soakWindows,
  SPEC_SOAK_MS,
} from "../../scripts/evals/prober/phases/soak.ts";
import {
  heapGrowth,
  type SoftLockDoors,
  softLockRow,
  stillnessThreshold,
  survivesRow,
} from "../../scripts/evals/prober/phases/soak-rows.ts";
import { lookInputVerdict } from "../../scripts/evals/prober/verdicts.ts";
import { CheckResult, ProbeRow } from "../../scripts/evals/vocabulary.ts";

/** A soak driver on a virtual clock that records every input it was asked to send. */
function fakeSoak(opts: { refuseKeys?: boolean; answers?: (step: number) => boolean } = {}) {
  let now = 0;
  let step = 0;
  const trace: string[] = [];
  const deps: SoakDeps = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    viewport: { width: 1280, height: 720 },
    press: async (key, holdMs) => {
      trace.push(`key ${key} ${holdMs}`);
      now += holdMs;
      return !opts.refuseKeys;
    },
    move: async (x, y) => {
      trace.push(`move ${x},${y}`);
      return true;
    },
    click: async (x, y) => {
      trace.push(`click ${x},${y}`);
      return true;
    },
    capture: async () => true,
    pullSeries: async () => opts.answers?.(step++) ?? true,
  };
  return { deps, trace };
}

describe("the seeded soak", () => {
  it("mulberry32 replays from its seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const draws = [a(), a(), a()];
    assert.deepEqual(draws, [b(), b(), b()]);
    assert.notDeepEqual(draws, [c(), c(), c()]);
    assert.ok(draws.every((d) => d >= 0 && d < 1));
  });

  it("the trace is the same whether or not a guard refused the keys", async () => {
    const open = fakeSoak();
    const guarded = fakeSoak({ refuseKeys: true });
    await soakPhase(open.deps, 30 * SECOND_MS, 7);
    await soakPhase(guarded.deps, 30 * SECOND_MS, 7);
    const sentKeys = open.trace.filter((t) => t.startsWith("key"));
    assert.ok(sentKeys.length > 0);
    assert.deepEqual(
      guarded.trace.filter((t) => !t.startsWith("key")).slice(0, 3),
      open.trace.filter((t) => !t.startsWith("key")).slice(0, 3),
      "the pointer draws land where they would have",
    );
  });

  it("runs its full length, framing densely in the first minute, and records what it did", async () => {
    const soak = await soakPhase(fakeSoak().deps, SPEC_SOAK_MS, 20260830);
    assert.equal(soak.crashed, false);
    assert.ok(soak.ranMs >= SPEC_SOAK_MS);
    assert.ok(soak.framesEarly >= 10, `${soak.framesEarly} early frames`);
    assert.ok(soak.framesLate > 0);
    assert.ok(soak.actions.keys > soak.actions.clicks);
  });

  it("A STOPPED MAIN THREAD is a crash, after the streak and not before", async () => {
    const soak = await soakPhase(fakeSoak({ answers: (step) => step < 5 }).deps, SPEC_SOAK_MS, 1);
    assert.equal(soak.crashed, true);
    assert.match(soak.crashReason ?? "", /stopped answering/);
    const blip = await soakPhase(
      fakeSoak({ answers: (step) => step % SOAK_HANG_STREAK !== 0 }).deps,
      20 * SECOND_MS,
      1,
    );
    assert.equal(blip.crashed, false, "an isolated unanswered read is not a crash");
  });
});

const baseline = buildBaseline(BaselineName.PostEntrance, [0.004, 0.004, 0.004, 0.004, 0.004, 0.004]);

/** Samples every 100 ms over the soak; `d` from the callback. */
function soakSamples(ms: number, d: (t: number) => number): ProbeSample[] {
  return Array.from({ length: ms / 100 }, (_, i) => ({ t: i * 100, m: 0.4, d: d(i * 100) }));
}

function run(overrides: Partial<SoakRun> = {}): SoakRun {
  return {
    plannedMs: SPEC_SOAK_MS,
    ranMs: SPEC_SOAK_MS,
    seed: 1,
    crashed: false,
    crashReason: null,
    actions: { keys: 0, moves: 0, clicks: 0, refused: 0 },
    framesEarly: 0,
    framesLate: 0,
    ...overrides,
  };
}

const openDoors: SoftLockDoors = {
  pointerLock: null,
  lookInput: lookInputVerdict(null),
  fullscreen: null,
  entranceConfirmed: true,
  gameplay: { reached: true, why: "the entrance was confirmed" },
};

describe("l2.no_soft_lock_5min", () => {
  const moving = soakSamples(SPEC_SOAK_MS, (t) => (t % 2000 < 200 ? 0.05 : 0.0001));
  const frozen = soakSamples(SPEC_SOAK_MS, (t) => (t < 30_000 ? 0.05 : 0.0001));

  it("passes when most windows move past the stillness floor over the full soak", () => {
    const w = soakWindows(moving, 0, SPEC_SOAK_MS, stillnessThreshold(baseline));
    assert.equal(w.windows, SPEC_SOAK_MS / SOAK_WINDOW_MS);
    const row = softLockRow(run(), w, baseline, openDoors);
    assert.equal(row.id, ProbeRow.L2NoSoftLock5min);
    assert.equal(row.result, CheckResult.Pass);
  });

  it("A SHORTER SOAK is unknown, never a pass inherited from a window it did not observe", () => {
    const short = soakSamples(60 * SECOND_MS, () => 0.05);
    const w = soakWindows(short, 0, 60 * SECOND_MS, stillnessThreshold(baseline));
    assert.equal(softLockRow(run({ ranMs: 60 * SECOND_MS }), w, baseline, openDoors).result, CheckResult.Unknown);
  });

  it("a game that freezes partway fails on stillness; the same fail on a game never entered is demoted", () => {
    const w = soakWindows(frozen, 0, SPEC_SOAK_MS, stillnessThreshold(baseline));
    assert.equal(softLockRow(run(), w, baseline, openDoors).result, CheckResult.Fail);
    const stuck = { ...openDoors, gameplay: { reached: false, why: "a door was never seen to open" } };
    const demoted = softLockRow(run(), w, baseline, stuck);
    assert.equal(demoted.result, CheckResult.Unknown);
    assert.match(demoted.detail, /Gameplay was never reached/);
  });

  it("A CRASH IS NEVER DEMOTED: it happened whichever side of a door the page sat on", () => {
    const w = soakWindows(frozen, 0, SPEC_SOAK_MS, stillnessThreshold(baseline));
    const stuck = { ...openDoors, gameplay: { reached: false, why: "a door was never seen to open" } };
    const crashed = softLockRow(run({ crashed: true, crashReason: "stopped answering" }), w, baseline, stuck);
    assert.equal(crashed.result, CheckResult.Fail);
    assert.doesNotMatch(crashed.detail, /Gameplay was never reached/);
  });

  it("a sampler too coarse for its windows cannot tell stopped from slow", () => {
    const coarse = Array.from({ length: 100 }, (_, i) => ({ t: i * 3000, m: 0.4, d: 0.0001 }));
    const w = soakWindows(coarse, 0, SPEC_SOAK_MS, stillnessThreshold(baseline));
    assert.equal(softLockRow(run(), w, baseline, openDoors).result, CheckResult.Unknown);
  });
});

describe("l1.survives_5min", () => {
  const growing = {
    available: true,
    samples: Array.from({ length: 20 }, (_, i) => ({ t: i * 15_000, used: 10e6 + i * 5e6 })),
    note: "",
  };
  const steady = {
    available: true,
    samples: Array.from({ length: 20 }, (_, i) => ({ t: i * 15_000, used: 10e6 + (i % 2) * 1000 })),
    note: "",
  };
  const quantised = {
    available: true,
    samples: Array.from({ length: 20 }, (_, i) => ({ t: i * 15_000, used: 10e6 })),
    note: "",
  };

  it("passes a full soak with a flat heap; fails an unbounded one", () => {
    assert.equal(survivesRow(run(), heapGrowth(steady), null).result, CheckResult.Pass);
    const leak = survivesRow(run(), heapGrowth(growing), null);
    assert.equal(leak.result, CheckResult.Fail);
    assert.match(leak.detail, /KB\/s/);
  });

  it("a QUANTISED heap is no measurement: unknown, saying so", () => {
    const row = survivesRow(run(), heapGrowth(quantised), null);
    assert.equal(row.result, CheckResult.Unknown);
    assert.match(row.detail, /quantised/);
  });

  it("a soak the budget shortened is unknown and names the budget", () => {
    const row = survivesRow(run({ ranMs: 120 * SECOND_MS }), heapGrowth(steady), "the probe budget had 200s left");
    assert.equal(row.result, CheckResult.Unknown);
    assert.match(row.detail, /probe budget/);
  });

  it("A SHORTER SOAK with a climbing heap is unknown: a heap read over less than the specified soak is no leak verdict", () => {
    const climbing = {
      available: true,
      samples: Array.from({ length: 100 }, (_, i) => ({ t: i * 300, used: 10e6 + i * 230e3 })),
      note: "",
    };
    const row = survivesRow(run({ ranMs: 30 * SECOND_MS }), heapGrowth(climbing), null);
    assert.equal(row.result, CheckResult.Unknown);
    assert.match(row.detail, /soak ran 30s/);
    assert.match(row.detail, /KB\/s/);
    assert.equal(
      survivesRow(run({ ranMs: 30 * SECOND_MS, crashed: true, crashReason: "x" }), heapGrowth(climbing), null).result,
      CheckResult.Fail,
      "a crash fails a soak of any length",
    );
  });

  it("a crash fails; no soak at all is unknown", () => {
    assert.equal(
      survivesRow(run({ crashed: true, crashReason: "x" }), heapGrowth(steady), null).result,
      CheckResult.Fail,
    );
    assert.equal(survivesRow(null, heapGrowth(undefined), null).result, CheckResult.Unknown);
  });
});

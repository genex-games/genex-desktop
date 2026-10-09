/**
 * The director's full journal, without a rig. Everything a run needs to go on lives in the run's
 * journal, not only in the harness's memory: the time the run has worked, which a Resume goes on
 * from instead of restarting the budget or reading the wall clock (journal.ts `loopRunClock`); the
 * record every save writes (loop-run.ts `saveJournal`) — each worker's brief, seam, deadline, rounds
 * and last accepted commit, the defects nobody owns, the plan and its review window, the
 * integration's health, the workers' engine limit, the log and what the lead has heard of it; what
 * a resumed run reads back (`restoreLoopRun`); the first message it opens with, a digest built from
 * that record; and how often it is saved, into a store that keeps every version. And the workers'
 * engine limit, cleared once it lifts. And a finished build its chat reopens (director/reopen.ts):
 * its rewritten journal gives a fresh clock and wake loop, a fork in the game folder as it is now,
 * and the lead's words for the finished build instead of a pause. Every clock here is a number the
 * test chooses.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { GIT, shortSha } from "../../src/harness-seed/loop/git.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { Side } from "../../src/harness-seed/loop/judge.ts";
import { saveJournal as saveRunJournal } from "../../src/harness-seed/loop/run-events.ts";
import { VerdictSource } from "../../src/harness-seed/loop/verdict.ts";
import { directorTalk } from "../../src/harness-seed/loop/director.ts";
import * as loopRunFunctions from "../../src/harness-seed/loop/director/loop-run.ts";
import * as toolFunctions from "../../src/harness-seed/loop/director/tools.ts";
import * as workerFunctions from "../../src/harness-seed/loop/director/workers.ts";
import { timedWorkRemaining, wrapReserveMs } from "../../src/harness-seed/loop/director/budgets.ts";
import {
  defaultWorkerId,
  JOURNAL_BRIEF_CHARS,
  JOURNAL_REASON_CHARS,
  loopRunClock,
  priorWorkerIds,
  priorWorkersSummary,
  restoredWake,
  restoreLoopRun,
} from "../../src/harness-seed/loop/director/journal.ts";
import {
  outcomesAwaitPlan,
  reopenCommits,
  reopenedJournal,
  reopenMarkOf,
} from "../../src/harness-seed/loop/director/reopen.ts";
import { reopenBudgets, reopenedRun } from "../../src/harness-seed/loop/reopen-run.ts";
import { CompletionPolicy } from "../../src/harness-seed/loop/completion-policy.ts";
import { RunEvent } from "../../src/harness-seed/loop/run-events.ts";
import { reopenNote } from "../../src/harness-seed/loop/director/reopen-prompts.ts";
import { DirectorTool } from "../../src/harness-seed/loop/director/tool-specs.ts";
import { runWakeLoop, type DirectorTalk, type WakeClock } from "../../src/harness-seed/loop/director/wake.ts";
import { NoteKind, WAKE_WINDOW_MS, WRAP_UP_MARGIN_MS } from "../../src/harness-seed/loop/director/wake-schedule.ts";
import { HOUR_MS, MINUTE_MS, minutes } from "../../src/harness-seed/loop/time.ts";

const T0 = Date.UTC(2026, 8, 26, 1, 0, 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const utc = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
const SKY_ACCEPTED = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const LAMPS_ACCEPTED = "b2c3d4e5f60718293a4b5c6d7e8f901234567890";
const FORK = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
/** Where a finished build's integration branch stood, and the game folder's head when it is reopened. */
const FINISHED = "c3d4e5f60718293a4b5c6d7e8f9012345678901a";
const LIVE = "d4e5f60718293a4b5c6d7e8f90123456789012ab";
const BRIEF = () => "You are the DIRECTOR of run run_j";

/** What the fake host saw: every call, and each journal as it was written. */
interface FakeHost {
  calls: Array<{ method: string; params: Record<string, any> }>;
  journals: Array<Record<string, any>>;
}
const fakeHost = (): FakeHost => ({ calls: [], journals: [] });
/** How many times the run's journal was written. */
const journalSaves = (host: FakeHost): number =>
  host.calls.filter((c) => c.method === HostMethod.ArtifactWrite && c.params.artifactId === "autopilot_run_j").length;

/** The run's own clock in these rows: an hour, the wrap-up reserve at its end. */
const CLOCK = { started: T0, softDeadline: T0 + HOUR_MS - wrapReserveMs(HOUR_MS), finalDeadline: T0 + HOUR_MS };
/** A clock as the journal keeps it, having worked `workedMs`. */
const keptClock = (workedMs: number) => ({
  started: iso(CLOCK.started),
  softDeadline: iso(CLOCK.softDeadline),
  finalDeadline: iso(CLOCK.finalDeadline),
  workedMs,
});

/** A worker as startWorker leaves it, building (override what the row is about). */
function skyWorker(over: Record<string, unknown> = {}) {
  let settle = () => {};
  return {
    id: "sky",
    title: "Dusk sky",
    mode: "loop",
    brief: "Build a dusk sky over the plaza",
    owns: ["src/sky.js"],
    ownsMain: false,
    from: FORK,
    replaces: null,
    worktree: "/runs/run_j/sky",
    handle: null,
    threadId: "t-sky",
    startedAt: T0 + MINUTE_MS,
    endedAt: null,
    deadline: T0 + 31 * MINUTE_MS,
    state: "running",
    stopRequested: false,
    stopWhy: null,
    iterations: [
      { iteration: 1, won: true, stopped: false, reason: "the dusk reads" },
      { iteration: 2, won: false, stopped: false, reason: "the stars are gone" },
    ],
    roundMs: [],
    lastIterationAt: null,
    monitor: null,
    result: null,
    lastCommit: null,
    lastAccepted: SKY_ACCEPTED,
    loop: null,
    steering: [],
    settled: false,
    settle: new Promise<void>((resolve) => {
      settle = resolve;
    }),
    resolveSettle: () => settle(),
    ...over,
  };
}

/** A round as the facet loop publishes it: won by its build, or lost. */
const round = (iteration: number, won: boolean, reason = won ? "brighter" : "darker") => ({
  iteration,
  winner: won ? Side.Challenger : Side.Incumbent,
  satisfied: false,
  reason,
  verdictSource: VerdictSource.Checks,
});

/**
 * A run as prepareLoopRun leaves it — its data plain, its parts the real ones, bound to it the way
 * `bindLoopRun` binds them — on a host that records what it is asked. An answer may be a function of
 * the call's params.
 */
function fakeLoopRun(host: FakeHost, over: Record<string, unknown> = {}, answers: Record<string, unknown> = {}) {
  const run = {
    runId: "run_j",
    project: "plaza",
    goal: "a dusk plaza",
    engine: "codex",
    reference: { name: "Dusk", shots: [] },
    budgets: { wallClockMs: HOUR_MS },
  };
  const ctx = {
    threadId: "t1",
    cancelled: false,
    workspace: "/nowhere",
    setStatus: () => {},
    notify: () => {},
    call: async (method: string, params: Record<string, any>) => {
      host.calls.push({ method, params });
      if (method === HostMethod.ArtifactWrite) host.journals.push(structuredClone(params.value));
      if (method === HostMethod.PreviewScreens) return [];
      const answer = answers[method];
      return typeof answer === "function" ? answer(params) : (answer ?? null);
    },
  };
  const data = {
    ctx,
    threadId: "t1",
    run,
    resume: false,
    inbox: {
      steering: async () => [],
      finishing: async () => false,
      addressed: async () => [],
      backlog: async () => [],
    },
    started: CLOCK.started,
    softDeadline: CLOCK.softDeadline,
    finalDeadline: CLOCK.finalDeadline,
    clock: { ...CLOCK },
    priorJournal: null,
    report: { notes: [], workers: {}, iterations: [], verdicts: [] },
    integrationWorktree: "/runs/run_j/integration",
    integrationRef: "refs/studio/runs/run_j/integration",
    baseCommit: FORK,
    state: {
      run,
      workers: new Map(),
      ledger: [] as Array<Record<string, unknown>>,
      log: [] as Array<Record<string, unknown>>,
      plan: null as Record<string, unknown> | null,
      planReviewUntil: null as number | null,
      planGo: false,
      planSaidFrom: 0,
      integrationHead: FORK,
      integrationHealthy: null as boolean | null,
      workerLimit: null as Record<string, unknown> | null,
      limit: null,
      lastJudge: null,
      finish: null,
      finished: false,
      monitor: null as Promise<unknown> | null,
      fromScratch: false,
      healthByHead: new Map<string, boolean>(),
      consoleByHead: new Map<string, string[]>(),
      evidenceByHead: new Map(),
      baseHeads: new Set<string>(),
      facetSpecs: [],
      softDeadline: CLOCK.softDeadline,
      finalDeadline: CLOCK.finalDeadline,
    },
    journal: { runId: "run_j", run, director: { sessionId: null, workers: {}, notes: [] }, plan: {} },
    logSeq: 0,
    waitSeq: 0,
    runLedger: [],
    priorLedger: [],
    ledgerWrites: Promise.resolve(),
    ...over,
  };
  return loopRunFunctions.bindLoopRun(data as never, [loopRunFunctions, workerFunctions, toolFunctions]) as any;
}

/** The loop's clock, moved by its own sleeps; `onSleep` runs after each. */
function fakeClock(start: number, onSleep: (now: number) => void = () => {}): WakeClock & { at: number } {
  const clock = {
    at: start,
    now: () => clock.at,
    sleep: async (ms: number) => {
      clock.at += ms;
      onSleep(clock.at);
    },
  };
  return clock;
}

/** The lead's session: each turn answered by `script`, every prompt and timeout kept. */
function lead(script: (turn: number) => Record<string, unknown>) {
  const turns: Array<{ prompt: string; sid: string | null | undefined; timeoutMs: number }> = [];
  const talk: DirectorTalk = {
    sessionId: "lead-1",
    keep: async (result) => {
      if (result?.sessionId) talk.sessionId = result.sessionId;
    },
    session: async (prompt, sid, timeoutMs) => {
      turns.push({ prompt, sid, timeoutMs });
      return script(turns.length);
    },
  };
  return { talk, turns };
}

/**
 * A resumed run on `priorJournal` whose lead starts workers: a host that lends windows, makes
 * worktrees and answers a builder's session, the plan gone ahead, every starting commit healthy.
 * Given its own `run` (a reopened one), it stands on the plan the journal kept.
 */
function workerLoopRun(
  host: FakeHost,
  priorJournal: Record<string, any>,
  now: number,
  run: Record<string, unknown> | null = null,
) {
  const loopRun = fakeLoopRun(
    host,
    {
      resume: true,
      priorJournal,
      ...(run ? { run } : {}),
      started: now,
      softDeadline: now + HOUR_MS,
      finalDeadline: now + 2 * HOUR_MS,
      clock: { started: now, softDeadline: now + HOUR_MS, finalDeadline: now + 2 * HOUR_MS },
    },
    {
      [HostMethod.PreviewCapacity]: { headless: true, max: 12, free: 12, inUse: 0 },
      [HostMethod.PreviewAcquire]: { handle: "h" },
      [HostMethod.SnapshotWorktree]: (params: Record<string, any>) => ({ path: `/runs/run_j/${params.name}` }),
      [HostMethod.ThreadCreate]: "t-new",
      [HostMethod.EngineDelegate]: { ok: true, summary: "built", sessionId: "s" },
    },
  );
  // A run on a run of its own (a reopened one) stands on the plan its journal kept, as prepareLoopRun's.
  if (run) loopRun.state.run = run;
  loopRun.state.plan = run
    ? priorJournal.director.plan
    : { summary: "This run: a dusk plaza.", workers: [{ id: "sky" }] };
  loopRun.state.monitor = Promise.resolve();
  for (const commit of [FORK, SKY_ACCEPTED, LAMPS_ACCEPTED]) loopRun.state.healthByHead.set(commit, true);
  restoreLoopRun(loopRun, now);
  return loopRun;
}

/** `worker_start` as the lead calls it: the refusal's words, or what it started. */
const workerStart = (loopRun: ReturnType<typeof fakeLoopRun>) => async (args: Record<string, unknown>) => {
  const answer = String(await loopRun.startWorker({ mode: "single", brief: "Build it", ...args }));
  return answer.startsWith("{") ? JSON.parse(answer) : answer;
};

/** One section of a digest: from its heading to the next blank line. */
function section(text: string, heading: string): string {
  const from = text.indexOf(heading);
  assert.ok(from >= 0, `no "${heading}" in:\n${text}`);
  return text.slice(from).split("\n\n")[0]!;
}

describe("the run's working time survives a Resume (journal.ts)", () => {
  it("K1. a Resume goes on with the working time the run had left — paused time does not count, worked time is never given back — and a run whose worked time used its budget gets only its wrap-up", () => {
    const total = HOUR_MS;
    const reserve = wrapReserveMs(total);
    assert.deepEqual(loopRunClock({ saved: null, now: T0, totalMs: total }), CLOCK);
    // Twenty minutes worked, then paused unattended: resumed ten hours on, it has the forty minutes
    // it had not used — not the wall clock's verdict that its hour is long over.
    const morning = T0 + 10 * HOUR_MS;
    assert.deepEqual(loopRunClock({ saved: keptClock(20 * MINUTE_MS), now: morning, totalMs: total }), {
      started: morning - 20 * MINUTE_MS,
      softDeadline: morning + 40 * MINUTE_MS - reserve,
      finalDeadline: morning + 40 * MINUTE_MS,
    });
    // Resumed at once, the same forty minutes: never a fresh hour.
    assert.deepEqual(
      loopRunClock({ saved: keptClock(20 * MINUTE_MS), now: T0 + 20 * MINUTE_MS, totalMs: total }),
      CLOCK,
    );
    // Worked into its wrap-up, or all of it: the wrap-up again, the reserve long, and nothing more.
    for (const worked of [total - reserve, total, 3 * total]) {
      assert.deepEqual(loopRunClock({ saved: keptClock(worked), now: morning, totalMs: total }), {
        started: morning - worked,
        softDeadline: morning,
        finalDeadline: morning + reserve,
      });
    }
    // A journal that kept no worked time (a run from before it did) starts one.
    const { workedMs: _none, ...noCount } = keptClock(0);
    assert.deepEqual(loopRunClock({ saved: noCount, now: T0, totalMs: total }), CLOCK);
    assert.deepEqual(loopRunClock({ saved: { started: "soon", workedMs: -5 }, now: T0, totalMs: total }), CLOCK);
  });

  it("K9. a run stopped at 22:30 after 3 h of its 6 h, resumed at 08:00, gets the 3 h it had left — less the wrap-up reserve — not only a wrap-up", async (t) => {
    const total = 6 * HOUR_MS;
    const reserve = wrapReserveMs(total);
    const evening = Date.UTC(2026, 8, 25, 19, 30);
    const stop = Date.UTC(2026, 8, 25, 22, 30);
    const morning = Date.UTC(2026, 8, 26, 8, 0);
    t.mock.timers.enable({ apis: ["Date"], now: evening });
    const first = loopRunClock({ saved: null, now: evening, totalMs: total });
    const before = fakeHost();
    const one = fakeLoopRun(before, { ...first, clock: first });
    // 22:30, Stop: the close saves the journal.
    t.mock.timers.setTime(stop);
    await one.saveJournal();
    const paused: Record<string, any> = { ...before.journals.at(-1)!, phase: "paused" };

    // 08:00, Resume.
    t.mock.timers.setTime(morning);
    const clock = loopRunClock({ saved: paused.director.clock, now: morning, totalMs: total });
    assert.deepEqual(clock, {
      started: morning - 3 * HOUR_MS,
      softDeadline: morning + 3 * HOUR_MS - reserve,
      finalDeadline: morning + 3 * HOUR_MS,
    });
    const after = fakeHost();
    const two = fakeLoopRun(after, { resume: true, priorJournal: paused, ...clock, clock });
    restoreLoopRun(two, morning);
    const { talk, turns } = lead(() => {
      two.state.finished = true;
      return { ok: true, sessionId: "lead-1" };
    });
    await runWakeLoop(two, talk, BRIEF, fakeClock(morning));
    assert.doesNotMatch(turns[0]!.prompt, /your session reached its deadline/, "not only a wrap-up");
    assert.equal(turns[0]!.timeoutMs, clock.softDeadline - morning, "the working time it had left");

    // …and the count goes on from there: an hour into the morning, four hours worked.
    t.mock.timers.setTime(morning + HOUR_MS);
    await two.saveJournal();
    assert.equal(paused.director.clock.workedMs, 3 * HOUR_MS);
    assert.equal(after.journals.at(-1)!.director.clock.workedMs, 4 * HOUR_MS);
  });
});

describe("every save writes the run's record (loop-run.ts saveJournal)", () => {
  it("K2. a worker started this turn is on the journal before the lead rests — its brief, seam, deadline, rounds and last accepted commit — with the defects nobody owns, the plan window, the health, the log and the time the run has worked", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: T0 + 7 * MINUTE_MS });
    const host = fakeHost();
    const loopRun = fakeLoopRun(host);
    loopRun.state.workers.set("sky", skyWorker());
    // A worker whose brief and last round's reason are longer than the journal keeps.
    loopRun.state.workers.set(
      "moon",
      skyWorker({
        id: "moon",
        title: "Moon",
        brief: "x".repeat(2_000),
        iterations: [{ iteration: 3, won: false, stopped: true, reason: "y".repeat(1_000) }],
      }),
    );
    loopRun.state.ledger.push({ text: "the crates float above the plaza", from: "sky", owner: "props", at: T0 });
    loopRun.state.plan = { summary: "This run: a dusk plaza.", workers: [{ id: "sky" }, { id: "props" }] };
    loopRun.state.planReviewUntil = T0 + 4 * MINUTE_MS;
    loopRun.state.planSaidFrom = 1;
    loopRun.state.integrationHealthy = true;
    loopRun.note("worker sky started (loop)");
    loopRun.note("worker sky: iteration 2 lost — the stars are gone", NoteKind.WorkerRound);
    loopRun.waitSeq = 1;
    // A wrap-up that started early moves the working deadline; the run's own clock stays.
    loopRun.softDeadline = T0 + 10 * MINUTE_MS;

    await loopRun.saveJournal();

    const saved = host.journals.at(-1)!.director;
    const sky = saved.workers.sky;
    assert.ok(sky, `the worker is on the journal: ${JSON.stringify(saved.workers)}`);
    assert.equal(sky.brief, "Build a dusk sky over the plaza");
    assert.deepEqual(sky.owns, ["src/sky.js"]);
    assert.equal(sky.deadline, iso(T0 + 31 * MINUTE_MS));
    assert.equal(sky.state, "running");
    assert.equal(sky.rounds, 2);
    assert.equal(sky.accepted, 1);
    assert.deepEqual(sky.lastRound, { iteration: 2, won: false, stopped: false, reason: "the stars are gone" });
    assert.equal(sky.lastCommit, SKY_ACCEPTED, "the last accepted commit of a worker still building");
    assert.equal(sky.ref, "refs/studio/runs/run_j/workers/sky");
    const moon = saved.workers.moon;
    assert.equal(moon.brief, "x".repeat(JOURNAL_BRIEF_CHARS), "a brief is kept to its bound");
    assert.deepEqual(moon.lastRound, {
      iteration: 3,
      won: false,
      stopped: true,
      reason: "y".repeat(JOURNAL_REASON_CHARS),
    });
    assert.deepEqual(saved.ledger, loopRun.state.ledger);
    assert.equal(saved.plan.summary, "This run: a dusk plaza.");
    assert.deepEqual(saved.planReview, { until: iso(T0 + 4 * MINUTE_MS), go: false, saidFrom: 1 });
    assert.equal(saved.integrationHealthy, true);
    assert.deepEqual(
      saved.log.map((entry: Record<string, unknown>) => [entry.seq, entry.text]),
      [
        [1, "worker sky started (loop)"],
        [2, "worker sky: iteration 2 lost — the stars are gone"],
      ],
    );
    assert.equal(saved.logSeq, 2);
    assert.equal(saved.heardSeq, 1, "what the lead has heard of the log");
    assert.deepEqual(saved.clock, { ...keptClock(7 * MINUTE_MS) }, "the run's own clock, and seven minutes worked");
  });
});

describe("a resumed run reads its journal back (journal.ts restoreLoopRun, wake.ts)", () => {
  it("K3. crash mid-build, then Resume: the first message opens with a digest read from the journal — the workers and the defects nobody owns from before, the news the lead never heard, the plan window — and the wrap-up comes when the working time it had left runs out", async (t) => {
    // Run one, ten minutes in: a worker building, a defect a judge shelved, a round the lead has not heard of.
    t.mock.timers.enable({ apis: ["Date"], now: T0 + 10 * MINUTE_MS });
    const before = fakeHost();
    const one = fakeLoopRun(before);
    one.state.workers.set("sky", skyWorker());
    one.state.ledger.push({ text: "the crates float above the plaza", from: "sky", owner: "props", at: T0 });
    one.state.plan = { summary: "This run: a dusk plaza.", workers: [{ id: "sky" }, { id: "props" }] };
    one.state.planReviewUntil = T0 + 30 * MINUTE_MS;
    one.note("worker sky started (loop)");
    one.waitSeq = 1;
    one.note("worker sky: iteration 2 lost — the stars are gone", NoteKind.WorkerRound);
    // The plan's parts, as `plan` puts them on the journal: the app checks a steer to a worker against them.
    one.journal.plan = {
      facets: [
        { id: "sky", title: "Dusk sky" },
        { id: "props", title: "Props" },
      ],
    };
    await one.saveJournal();
    // The loop dies here. The app's repair keeps the journal and marks the run paused.
    const kept: Record<string, any> = { ...before.journals.at(-1)!, phase: "paused" };

    // Resume, ten minutes after the crash: the ten minutes of the pause do not count.
    const later = T0 + 20 * MINUTE_MS;
    t.mock.timers.setTime(later);
    const clock = loopRunClock({ saved: kept.director.clock, now: later, totalMs: HOUR_MS });
    assert.equal(clock.softDeadline, CLOCK.softDeadline + 10 * MINUTE_MS);
    const after = fakeHost();
    const two = fakeLoopRun(after, {
      resume: true,
      priorJournal: kept,
      started: clock.started,
      softDeadline: clock.softDeadline,
      finalDeadline: clock.finalDeadline,
      clock,
    });
    two.state.plan = kept.director.plan;
    restoreLoopRun(two, later);
    const { talk, turns } = lead(() => {
      two.state.finished = true;
      return { ok: true, sessionId: "lead-1" };
    });
    await runWakeLoop(two, talk, BRIEF, fakeClock(later));

    const first = turns[0]!.prompt;
    assert.match(first, /^You are the DIRECTOR of run run_j/);
    assert.match(first, /RESUMED AT \d\d:\d\d UTC/);
    const stands = section(first, "WHERE THE RUN STANDS:");
    assert.match(stands, /^- worker sky \(Dusk sky\): /m, stands);
    assert.match(stands, /1 accepted/, stands);
    assert.match(stands, new RegExp(SKY_ACCEPTED.slice(0, 7)), "its last accepted commit, to build on or merge");
    assert.match(stands, /defects nobody owns: the crates float above the plaza/, stands);
    assert.match(stands, new RegExp(`wrap-up at ${utc(clock.softDeadline)}`), "when the working time it had left ends");
    assert.match(
      stands,
      new RegExp(`the plan window: the builders wait for the user until ${utc(T0 + 30 * MINUTE_MS)}`),
    );
    const happened = section(first, "WHAT HAPPENED:");
    assert.match(happened, /iteration 2 lost — the stars are gone/, "the round the lead never heard of");
    assert.doesNotMatch(happened, /worker sky started/, "what it had heard is not said again");
    assert.ok(turns[0]!.timeoutMs <= clock.softDeadline - later, "the turn ends at the run's own working deadline");

    // …and what the resumed run saves keeps its clock and the workers from before.
    await two.saveJournal();
    const resaved = after.journals.at(-1)!.director;
    assert.equal(resaved.clock.softDeadline, iso(clock.softDeadline));
    assert.equal(resaved.clock.workedMs, 10 * MINUTE_MS);
    assert.equal(resaved.workers.sky?.brief, "Build a dusk sky over the plaza");
    assert.deepEqual(
      resaved.ledger.map((d: Record<string, unknown>) => d.text),
      ["the crates float above the plaza"],
    );
    assert.deepEqual(
      after.journals.at(-1)!.plan.facets.map((f: Record<string, unknown>) => f.id),
      ["sky", "props"],
      "a steer addressed to a planned worker is still accepted after the Resume",
    );
  });

  it("K4. a resumed run whose worked time used its working time opens in its wrap-up, with the wrap-up's time", async () => {
    const host = fakeHost();
    const late = T0 + 3 * HOUR_MS;
    const clock = loopRunClock({ saved: keptClock(HOUR_MS), now: late, totalMs: HOUR_MS });
    const loopRun = fakeLoopRun(host, {
      resume: true,
      priorJournal: { director: { workers: {}, ledger: [] } },
      started: clock.started,
      softDeadline: clock.softDeadline,
      finalDeadline: clock.finalDeadline,
      clock,
    });
    restoreLoopRun(loopRun, late);
    const { talk, turns } = lead(() => {
      loopRun.state.finished = true;
      return { ok: true, sessionId: "lead-1" };
    });
    await runWakeLoop(loopRun, talk, BRIEF, fakeClock(late));

    assert.equal(turns.length, 1);
    assert.match(turns[0]!.prompt, /your session reached its deadline/, "the wrap-up, in the first message");
    assert.equal(turns[0]!.timeoutMs, clock.finalDeadline - WRAP_UP_MARGIN_MS - late, "the wrap-up's own time");
  });

  it("K5. the wake loop's own state comes back: asked what next once already, and the wakes still in the cap's window", () => {
    const now = T0 + 2 * HOUR_MS;
    const saved = {
      idleAsked: true,
      wakesAt: [iso(now - 2 * WAKE_WINDOW_MS), iso(now - 10 * MINUTE_MS), iso(now - MINUTE_MS)],
    };
    assert.deepEqual(restoredWake(saved, now), { idleAsked: true, wakesAt: [now - 10 * MINUTE_MS, now - MINUTE_MS] });
    assert.deepEqual(restoredWake(null, now), { idleAsked: false, wakesAt: [] });
  });

  it("K14. a plan window that closed while the run was paused lets the plan go on a Resume, and nothing wakes the lead for it", async () => {
    const later = T0 + 2 * HOUR_MS;
    const loopRun = fakeLoopRun(fakeHost(), {
      resume: true,
      priorJournal: {
        director: { workers: {}, planReview: { until: iso(T0 + 30 * MINUTE_MS), go: false, saidFrom: 0 } },
      },
      started: later,
      softDeadline: later + HOUR_MS,
      finalDeadline: later + 2 * HOUR_MS,
      clock: { started: later, softDeadline: later + HOUR_MS, finalDeadline: later + 2 * HOUR_MS },
    });
    loopRun.state.plan = { summary: "This run: a dusk plaza.", workers: [{ id: "sky" }] };
    restoreLoopRun(loopRun, later);
    // A worker of the resumed run builds; the lead rests ten minutes and the run ends.
    loopRun.state.workers.set("sky", skyWorker({ startedAt: later }));
    const { talk, turns } = lead(() => ({ ok: true, sessionId: "lead-1" }));
    const clock = fakeClock(later, (now) => {
      if (now >= later + 10 * MINUTE_MS) loopRun.state.finished = true;
    });
    await runWakeLoop(loopRun, talk, BRIEF, clock);

    assert.equal(turns.length, 1, turns.map((turn) => turn.prompt.slice(0, 120)).join("\n---\n"));
    assert.equal(loopRun.state.planGo, true, "the window closed during the pause: the plan goes as it stands");
    assert.equal(loopRun.state.planReviewUntil, null);
  });

  it("K15. the workers' engine limit is on the run's record and comes back on a Resume — unless it reset while the run was paused", async () => {
    const host = fakeHost();
    const loopRun = fakeLoopRun(host);
    const limit = {
      engine: "codex",
      kind: "usage_limit",
      message: "out of usage",
      retryAfterMs: null,
      at: T0 + 5 * MINUTE_MS,
      worker: "sky",
    };
    loopRun.state.workerLimit = { ...limit };
    await loopRun.saveJournal();
    const saved = host.journals.at(-1)!;
    assert.deepEqual(saved.director.workerLimit, { ...limit, at: iso(limit.at) });

    const two = fakeLoopRun(fakeHost(), { resume: true, priorJournal: saved });
    restoreLoopRun(two, T0 + HOUR_MS);
    assert.deepEqual(two.state.workerLimit, limit, "no reset time was given: it stands until a session comes back");

    const reset = structuredClone(saved);
    reset.director.workerLimit = { ...reset.director.workerLimit, kind: "rate_limit", retryAfterMs: 10 * MINUTE_MS };
    const three = fakeLoopRun(fakeHost(), { resume: true, priorJournal: reset });
    restoreLoopRun(three, T0 + HOUR_MS);
    assert.equal(three.state.workerLimit, null, "it reset during the pause");
  });

  it("K16. the workers from before the pause get their full lines in the first resumed digest only — later wakes name them in one line — and worker_status answers for them", async () => {
    const later = T0 + 2 * HOUR_MS;
    const priorJournal = {
      director: {
        workers: {
          sky: {
            id: "sky",
            title: "Dusk sky",
            state: "running",
            brief: "Build a dusk sky over the plaza",
            owns: ["src/sky.js"],
            from: FORK,
            rounds: 2,
            accepted: 1,
            lastCommit: SKY_ACCEPTED,
            ref: "refs/studio/runs/run_j/workers/sky",
          },
          lamps: {
            id: "lamps",
            title: "Lamps",
            state: "done",
            brief: "Hang warm lamps along the plaza",
            owns: ["src/lamps.js"],
            from: FORK,
            rounds: 1,
            accepted: 1,
            lastCommit: LAMPS_ACCEPTED,
            ref: "refs/studio/runs/run_j/workers/lamps",
          },
        },
      },
    };
    const loopRun = fakeLoopRun(fakeHost(), {
      resume: true,
      priorJournal,
      started: later,
      softDeadline: later + HOUR_MS,
      finalDeadline: later + 2 * HOUR_MS,
      clock: { started: later, softDeadline: later + HOUR_MS, finalDeadline: later + 2 * HOUR_MS },
    });
    restoreLoopRun(loopRun, later);
    // A worker of the resumed run builds and lands a round while the lead rests.
    const moon = skyWorker({ id: "moon", title: "Moon", startedAt: later, iterations: [] });
    loopRun.state.workers.set("moon", moon);
    let landed = false;
    const { talk, turns } = lead((turn) => {
      if (turn === 2) loopRun.state.finished = true;
      return { ok: true, sessionId: "lead-1" };
    });
    const clock = fakeClock(later, () => {
      if (landed) return;
      landed = true;
      loopRun.note("worker moon: iteration 1 accepted — the moon rises", NoteKind.WorkerRound);
    });
    await runWakeLoop(loopRun, talk, BRIEF, clock);

    assert.equal(turns.length, 2);
    const first = section(turns[0]!.prompt, "WHERE THE RUN STANDS:");
    assert.match(first, /^- worker sky \(Dusk sky\): .*brief: Build a dusk sky/m, first);
    assert.match(first, /^- worker lamps \(Lamps\): /m, first);
    const woken = section(turns[1]!.prompt, "WHERE THE RUN STANDS:");
    assert.doesNotMatch(woken, /^- worker (sky|lamps) \(/m, "the full lines are not said again");
    assert.doesNotMatch(woken, /brief: Build a dusk sky/);
    const line = woken.split("\n").find((l) => /before the pause/.test(l));
    assert.ok(line, `one line names them:\n${woken}`);
    assert.match(line, /sky/);
    assert.match(line, /lamps/);
    assert.ok(line.length < 240, `one short line: ${line.length} characters`);

    // worker_status knows a worker from before the pause: its record, and how to go on from it.
    const sky = JSON.parse(await loopRun.handler(DirectorTool.WorkerStatus, { id: "sky" }));
    assert.equal(sky.id, "sky");
    assert.equal(sky.lastCommit, SKY_ACCEPTED);
    assert.equal(sky.stateBeforeThePause, "running");
    const all = JSON.parse(await loopRun.handler(DirectorTool.WorkerStatus, {}));
    assert.deepEqual(
      all.map((w: Record<string, unknown>) => w.id),
      ["moon", "sky", "lamps"],
      "every worker, those from before the pause too",
    );
  });
});

describe("the journal is saved when something changed, not on every tick (loop-run.ts, wake.ts, director.ts)", () => {
  it("K10. a wake saves the journal twice — as the lead is woken and as it rests — a round saves itself only while the lead is awake, and an unchanged session id saves nothing", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    const host = fakeHost();
    const sky = skyWorker({ iterations: [], worktree: "", lastAccepted: null });
    const seen: Array<{ saves: number; skyRounds: number | undefined }> = [];
    let turn = 0;
    const loopRun = fakeLoopRun(
      host,
      {},
      {
        [HostMethod.EngineDelegate]: () => {
          turn += 1;
          seen.push({ saves: journalSaves(host), skyRounds: host.journals.at(-1)?.director.workers.sky?.rounds });
          // A round lands while the lead is awake: it saves itself (and its line wakes the lead once it rests).
          if (turn === 2) loopRun.recordRound(sky, round(2, true));
          if (turn === 3) loopRun.state.finished = true;
          return { ok: true, sessionId: "lead-1", summary: "decided" };
        },
      },
    );
    loopRun.state.plan = { summary: "This run: a dusk plaza.", workers: [{ id: "sky" }] };
    loopRun.state.workers.set("sky", sky);
    // A round lands while the lead rests, a minute into its first rest.
    let landedAt: number | null = null;
    let restedAt: number | null = null;
    const clock: WakeClock = {
      now: () => Date.now(),
      sleep: async (ms: number) => {
        t.mock.timers.tick(ms);
        restedAt ??= Date.now();
        if (landedAt === null && Date.now() >= restedAt + MINUTE_MS) {
          loopRun.recordRound(sky, round(1, true));
          landedAt = journalSaves(host);
        }
      },
    };
    await runWakeLoop(loopRun, directorTalk(loopRun, [], []), BRIEF, clock);
    await nextTurn();

    assert.equal(turn, 3, "woken by the round that landed under it, then by the one it had not heard of");
    assert.ok(landedAt !== null, "the round landed while the lead rested");
    // Turn 1 kept the new session id and rested; the round landed; its wake saved it — once.
    assert.equal(seen[1]!.saves - landedAt, 1, "one save between a round landing under a resting lead and its wake");
    assert.equal(seen[1]!.skyRounds, 1, "the wake's save carries the round");
    // Turn 2: the round it saw land saved itself, the unchanged session id saved nothing, it rested, it was woken.
    assert.equal(seen[2]!.saves - seen[1]!.saves, 3, "the round in the turn, the rest and the wake");
    // Session id (1), rest (1), wake (1), the round in turn 2 (1), rest (1), wake (1).
    assert.equal(journalSaves(host), 6, `saves: ${journalSaves(host)}`);
  });
});

describe("a save that changes nothing is not made (loop-run.ts saveJournal)", () => {
  it("K17. a save that would write what the last one wrote — the worked time aside — is not made, and a write that failed is made again", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: T0 + MINUTE_MS });
    const host = fakeHost();
    let full = false;
    const loopRun = fakeLoopRun(
      host,
      {},
      {
        [HostMethod.ArtifactWrite]: () => {
          if (full) throw new Error("disk full");
          return journalSaves(host);
        },
      },
    );
    await loopRun.saveJournal();
    t.mock.timers.tick(MINUTE_MS);
    await loopRun.saveJournal();
    assert.equal(journalSaves(host), 1, "a minute more worked, and nothing else: no new version");
    loopRun.note("worker sky started (loop)");
    full = true;
    await loopRun.saveJournal();
    full = false;
    await loopRun.saveJournal();
    assert.equal(journalSaves(host), 3, "the line, and the write that failed, made again");
    assert.equal(
      host.journals.at(-1)!.director.clock.workedMs,
      2 * MINUTE_MS,
      "a version carries the count as it stands",
    );
  });
});

describe("a new worker and the workers from before the pause (workers.ts)", () => {
  it("K12. after a Resume a new worker never takes the id of one from before the pause that left work — unless it builds on that work — and the default id and replaces= count them", async () => {
    const host = fakeHost();
    const now = Date.now();
    const priorJournal = {
      director: {
        workers: {
          sky: {
            id: "sky",
            title: "Dusk sky",
            state: "running",
            brief: "Build a dusk sky over the plaza",
            from: FORK,
            rounds: 2,
            accepted: 1,
            lastCommit: SKY_ACCEPTED,
            ref: "refs/studio/runs/run_j/workers/sky",
          },
          w1: { id: "w1", title: "Lamps", state: "done", brief: "Hang lamps", from: FORK, lastCommit: LAMPS_ACCEPTED },
          fog: { id: "fog", title: "Fog", state: "failed", brief: "Roll fog in", from: FORK, lastCommit: null },
        },
      },
    };
    const loopRun = workerLoopRun(host, priorJournal, now);
    const start = workerStart(loopRun);

    const taken = await start({ id: "sky" });
    assert.equal(typeof taken, "string", `refused: ${JSON.stringify(taken)}`);
    assert.match(taken, /"sky" ran before the pause/);
    assert.match(taken, new RegExp(`from=${SKY_ACCEPTED}`), "and it says how to build on that work");
    assert.equal(loopRun.state.workers.has("sky"), false);
    assert.equal(loopRun.journal.director.workers.sky.brief, "Build a dusk sky over the plaza", "its record is kept");

    assert.equal((await start({ id: "sky", from: SKY_ACCEPTED })).started, "sky", "it may start again on its own work");
    assert.equal((await start({})).started, "w2", "the default id passes w1, which ran before the pause");
    assert.equal((await start({ id: "fog" })).started, "fog", "a worker that left no commit of its own buries nothing");
    assert.equal((await start({ id: "lamps", replaces: "w1" })).started, "lamps", "replaces= names one from before");
    const w1 = await start({ id: "w1", from: "w1" });
    assert.equal(w1.started, "w1", "from=<its id> builds on its work");
    assert.equal(w1.forkedFrom, shortSha(LAMPS_ACCEPTED), "…from its last commit");
    await Promise.all(
      [...loopRun.state.workers.values()].map((worker: { promise?: Promise<unknown> }) => worker.promise),
    );
  });

  it("K13. under a kept loop-run.ts from before the full journal, whose save writes no record, the wake loop still puts the run's record on the journal", async () => {
    const host = fakeHost();
    const loopRun = fakeLoopRun(host);
    // The kept copy's save: the journal as it stands, with no record written first.
    loopRun.saveJournal = () => saveRunJournal(loopRun.ctx, loopRun.threadId, loopRun.run.runId, loopRun.journal);
    loopRun.state.workers.set("sky", skyWorker());
    const { talk } = lead(() => ({ ok: true, sessionId: "lead-1" }));
    const clock = fakeClock(T0 + 5 * MINUTE_MS, () => {
      loopRun.state.finished = true;
    });
    await runWakeLoop(loopRun, talk, BRIEF, clock);

    const saved = host.journals.at(-1)?.director;
    assert.equal(saved?.workers.sky?.brief, "Build a dusk sky over the plaza", JSON.stringify(saved));
    assert.ok(saved?.clock?.softDeadline, "the run's clock is on it");
  });

  it("answers a refused copy of the game as a start the lead reads, and starts nothing", async () => {
    const host = fakeHost();
    const loopRun = workerLoopRun(host, { director: { workers: {} } }, Date.now());
    const refused =
      "This game is too large to copy, so nothing that needs its own copy of it can start; work in the game folder itself. A copy would take 6.1 GB, more than the 2 GB allowed (most of it in Content 5.2 GB).";
    // The host refuses the copy (`snapshot.worktree`); every other call is answered as before.
    const answered = loopRun.ctx.call;
    loopRun.ctx.call = (method: string, params: Record<string, unknown>) =>
      method === HostMethod.SnapshotWorktree ? Promise.reject(new Error(refused)) : answered(method, params);
    const answer = await workerStart(loopRun)({ id: "sky" });
    assert.equal(answer, `could not start "sky": ${refused}`);
    assert.equal(loopRun.state.workers.has("sky"), false);
    const asked = host.calls.map((call) => call.method);
    assert.ok(!asked.includes(HostMethod.ThreadCreate), "no thread for a worker with no copy");
    assert.ok(!asked.includes(HostMethod.EngineDelegate), "and no turn");
  });
});

describe("a builder's start at Genex's moments (director/workers.ts)", () => {
  /** A run whose game hooks the workers' moments, every moment answered quietly. */
  function hookedLoopRun(host: FakeHost) {
    const loopRun = workerLoopRun(host, { director: { workers: {} } }, Date.now());
    loopRun.game = { hookEvents: ["worker.start", "worker.end"] };
    const quiet = { blocked: null, pending: null, notes: [], images: [], ran: [] };
    const answered = loopRun.ctx.call;
    loopRun.ctx.call = (method: string, params: Record<string, unknown>) =>
      method === HostMethod.HooksFire
        ? (host.calls.push({ method, params }), Promise.resolve(quiet))
        : answered(method, params);
    return loopRun;
  }
  const moments = (host: FakeHost) =>
    host.calls.filter((c) => c.method === HostMethod.HooksFire).map((c) => `${c.params.on} ${c.params.worker?.id}`);

  it("a builder refused after its start was announced announces its end too, and no builder is kept", async () => {
    const host = fakeHost();
    const loopRun = hookedLoopRun(host);
    const withHooks = loopRun.ctx.call;
    loopRun.ctx.call = (method: string, params: Record<string, unknown>) =>
      method === HostMethod.SnapshotWorktree
        ? Promise.reject(new Error("no room for a copy"))
        : withHooks(method, params);
    const answer = await workerStart(loopRun)({ id: "sky" });
    assert.equal(answer, 'could not start "sky": no room for a copy');
    assert.deepEqual(moments(host), ["worker.start sky", "worker.end sky"]);
    assert.equal(loopRun.state.workers.has("sky"), false);
  });

  it("a builder a plugin holds back at its start announces no end and starts nothing", async () => {
    const host = fakeHost();
    const loopRun = hookedLoopRun(host);
    const withHooks = loopRun.ctx.call;
    loopRun.ctx.call = (method: string, params: Record<string, unknown>) =>
      method === HostMethod.HooksFire && params.on === "worker.start"
        ? (host.calls.push({ method, params }),
          Promise.resolve({
            blocked: { plugin: "bench", tool: "gate", reason: "The bench is full." },
            pending: null,
            notes: [],
            images: [],
            ran: [],
          }))
        : withHooks(method, params);
    const answer = await workerStart(loopRun)({ id: "sky" });
    assert.match(String(answer), /holds the worker back: The bench is full\./);
    assert.deepEqual(moments(host), ["worker.start sky"]);
    assert.ok(!host.calls.some((c) => c.method === HostMethod.SnapshotWorktree), "no copy of the game");
  });
});

/** A run whose host refuses the first `refusals` builder turns for room, as a full chat's ceiling does. */
function roomLoopRun(refusals: number) {
  const host = fakeHost();
  const loopRun = workerLoopRun(host, { director: { workers: {} } }, Date.now());
  let refused = refusals;
  const answered = loopRun.ctx.call;
  loopRun.ctx.call = (method: string, params: Record<string, unknown>) => {
    if (method !== HostMethod.EngineDelegate || refused-- <= 0) return answered(method, params);
    host.calls.push({ method, params });
    return Promise.reject(Object.assign(new Error("this chat already runs 8 workers"), { code: "too_many_workers" }));
  };
  const delegations = () => host.calls.filter((call) => call.method === HostMethod.EngineDelegate).length;
  return { loopRun, delegations };
}

/** Let the run's own work run until `done` holds, moving the mocked timers on while it waits. */
async function runUntil(t: { mock: { timers: { tick(ms: number): void } } }, done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 5_000 && !done(); turn++) {
    await nextTurn();
    if (turn % 20 === 19) t.mock.timers.tick(10_000);
  }
  assert.ok(done(), "the run got there");
}

describe("a director's single worker under the chat's Settings ceiling", () => {
  it("waits for room when the host has none, then takes its turn and ends done", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { loopRun, delegations } = roomLoopRun(1);
    const started = await workerStart(loopRun)({ id: "sky" });
    assert.equal(started.started, "sky", JSON.stringify(started));
    const worker = loopRun.state.workers.get("sky");
    await runUntil(t, () => worker.state !== "running");
    assert.equal(worker.state, "done", worker.error ?? "");
    assert.equal(delegations(), 2, "asked again once there was room");
  });

  it("a stop while it waits for room ends it as stopped, and it never takes its turn", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { loopRun, delegations } = roomLoopRun(1_000);
    await workerStart(loopRun)({ id: "sky" });
    const worker = loopRun.state.workers.get("sky");
    await runUntil(t, () => delegations() >= 1);
    await workerFunctions.stopWorker(loopRun, worker, "not needed");
    await runUntil(t, () => worker.state !== "running");
    assert.equal(worker.state, "stopped", worker.error ?? "");
    assert.equal(delegations(), 1, "no turn after the stop");
  });
});

describe("the workers' engine limit, once it lifts", () => {
  it("K6. the wake that says the workers' limit has reset clears it, so nothing names it again", async () => {
    const host = fakeHost();
    const loopRun = fakeLoopRun(host);
    loopRun.state.workerLimit = {
      engine: "codex",
      kind: "rate_limit",
      message: "rate limited",
      retryAfterMs: 10 * MINUTE_MS,
      at: T0,
      worker: "sky",
    };
    const seen: Array<Record<string, unknown> | null> = [];
    const { talk, turns } = lead((turn) => {
      seen.push(loopRun.state.workerLimit);
      if (turn === 2) loopRun.state.finished = true;
      return { ok: true, sessionId: "lead-1" };
    });
    await runWakeLoop(loopRun, talk, BRIEF, fakeClock(T0));

    assert.equal(turns.length, 2);
    assert.match(turns[1]!.prompt, /the workers' engine limit has reset/);
    assert.equal(seen[1], null, "cleared by the wake that says it lifted");
  });

  it("K7. run_status stops naming a workers' limit whose reset time has passed, and clears it", async () => {
    const host = fakeHost();
    const loopRun = fakeLoopRun(host);
    loopRun.state.workerLimit = {
      engine: "codex",
      kind: "rate_limit",
      message: "rate limited",
      retryAfterMs: 10 * MINUTE_MS,
      at: Date.now() - 20 * MINUTE_MS,
      worker: "sky",
    };
    const status = await loopRun.statusText();
    assert.equal(status.workersEngineLimit, undefined, JSON.stringify(status.workersEngineLimit));
    assert.equal(loopRun.state.workerLimit, null);
    // One that has not reset yet is still named.
    loopRun.state.workerLimit = {
      engine: "codex",
      kind: "rate_limit",
      message: "rate limited",
      retryAfterMs: 10 * MINUTE_MS,
      at: Date.now(),
      worker: "sky",
    };
    assert.ok((await loopRun.statusText()).workersEngineLimit);
  });
  it("K8. a worker started after the workers' limit whose session comes back clears it — the engine answers again; one started before the limit does not", async () => {
    const limitAt = Date.now() - 10 * MINUTE_MS;
    const noReset = {
      engine: "codex",
      kind: "usage_limit",
      message: "out",
      retryAfterMs: null,
      at: limitAt,
      worker: "sky",
    };
    const answered = { [HostMethod.EngineDelegate]: { ok: true, summary: "hung the sign", sessionId: "sign-1" } };
    const after = fakeLoopRun(fakeHost(), {}, answered);
    after.state.workerLimit = { ...noReset };
    const later = skyWorker({ id: "sign", mode: "single", startedAt: limitAt + MINUTE_MS, iterations: [] });
    after.state.workers.set("sign", later);
    await after.runWorker(later);
    assert.equal(later.state, "done");
    assert.equal(after.state.workerLimit, null, "a session that came back after the limit lifts it");

    const before = fakeLoopRun(fakeHost(), {}, answered);
    before.state.workerLimit = { ...noReset };
    const earlier = skyWorker({ id: "sign", mode: "single", startedAt: limitAt - MINUTE_MS, iterations: [] });
    before.state.workers.set("sign", earlier);
    await before.runWorker(earlier);
    assert.ok(before.state.workerLimit, "a worker that started before the limit says nothing about it");
  });

  it("K11. a round its builder's engine lost to a limit does not lift the workers' limit — only a round its build won does", async () => {
    const limitAt = Date.now() - 10 * MINUTE_MS;
    const loopRun = fakeLoopRun(fakeHost());
    loopRun.state.workerLimit = {
      engine: "codex",
      kind: "usage_limit",
      message: "out",
      retryAfterMs: null,
      at: limitAt,
      worker: "sky",
    };
    const sign = skyWorker({ id: "sign", startedAt: limitAt + MINUTE_MS, iterations: [], worktree: "" });
    loopRun.state.workers.set("sign", sign);
    // Its build turn met the limit: the round is still published — lost, with nothing built to judge.
    loopRun.recordRound(sign, {
      ...round(1, false, "the build turn failed: rate limited"),
      verdictSource: VerdictSource.Broken,
    });
    await nextTurn();
    assert.ok(loopRun.state.workerLimit, "the engine did not answer: the limit stands");
    loopRun.recordRound(sign, round(2, true));
    await nextTurn();
    assert.equal(loopRun.state.workerLimit, null, "a round its build won is the engine answering again");
  });
});

describe("a finished build reopened (director/reopen.ts)", () => {
  /** The morning the chat reopens the build. */
  const MORNING = T0 + 10 * HOUR_MS;
  /** The mark the chat's rewrite puts on the journal: when, and the head the log's close says the build finished on. */
  const MARK = { at: iso(MORNING), finishedHead: FINISHED };
  /** The journal as the build's close left it: done, its hour worked, asked what next, its last health pass on its head. */
  const finishedJournal = () => ({
    runId: "run_j",
    phase: "done",
    run: { runId: "run_j", project: "plaza", goal: "a dusk plaza", engine: "codex", budgets: { wallClockMs: HOUR_MS } },
    plan: { facets: [{ id: "sky", title: "Dusk sky" }] },
    director: {
      baseCommit: FORK,
      integrationHead: FINISHED,
      integrationHealthy: true,
      clock: keptClock(HOUR_MS),
      wake: { loop: "wake", idleAsked: true, wakesAt: [iso(T0 + 50 * MINUTE_MS)] },
      plan: { summary: "This run: a dusk plaza.", workers: [{ id: "sky" }] },
      planReview: { until: null, go: true, saidFrom: 0 },
      ledger: [{ text: "the crates float above the plaza", from: "sky", owner: "props", at: iso(T0) }],
      workers: {
        sky: {
          id: "sky",
          title: "Dusk sky",
          state: "done",
          brief: "Build a dusk sky over the plaza",
          from: FORK,
          rounds: 2,
          accepted: 1,
          lastCommit: SKY_ACCEPTED,
          ref: "refs/studio/runs/run_j/workers/sky",
        },
        w1: { id: "w1", title: "Lamps", state: "done", brief: "Hang lamps", from: FORK, lastCommit: LAMPS_ACCEPTED },
      },
    },
  });
  /** The finished build's journal as the chat reopens it, with the Loop's two hours. */
  const reopenedWithTwoHours = () => {
    const finished = finishedJournal();
    return reopenedJournal(finished, { ...finished.run, budgets: { wallClockMs: 2 * HOUR_MS } }, MARK);
  };

  /** The outcome the finished build verified, as its plan named it. */
  const SKY_DONE = ["the sky reads as dusk"];
  /** The finished build as a Loop ∞ left it: its one required outcome verified on its head, checkpointed, reviewed. */
  const finishedGoalJournal = () => {
    const finished = finishedJournal();
    const budgets = { wallClockMs: 24 * HOUR_MS, completionPolicy: CompletionPolicy.Goal, untilSatisfied: true };
    const checkpoint = { head: FINISHED, at: T0, verifiedGoals: ["sky"], requiredGoals: 1 };
    const sky = { id: "sky", required: true, acceptance: SKY_DONE, status: "passed", head: FINISHED, attempts: 0 };
    return {
      ...finished,
      run: { ...finished.run, budgets },
      director: {
        ...finished.director,
        plan: { summary: "This run: a dusk plaza.", workers: [{ id: "sky", done: SKY_DONE }] },
        goals: { version: 1, scopeRevisions: [], entries: [{ ...sky, replan: null, blocker: null, verified: [0] }] },
        firstVerifiedCheckpoint: checkpoint,
        latestVerifiedCheckpoint: checkpoint,
        softReviewAt: T0 + 30 * MINUTE_MS,
      },
    };
  };
  /** A finished journal as the chat reopens it with a Loop of `hours` (null: ∞). */
  const reopenedWith = (finished: Record<string, any>, hours: number | null) => {
    const run = reopenedRun(finished.run, reopenBudgets(finished.run.budgets, hours), { model: null });
    return reopenedJournal(finished, run, MARK);
  };
  /** The plan a reopened build's lead writes for the user's ask. */
  const ENEMIES = {
    summary: "Enemies chase the player.",
    workers: JSON.stringify([{ id: "enemies", done: ["an enemy chases the player"] }]),
  };
  /** The plan cards the run put in the chat. */
  const planCards = (host: FakeHost) =>
    host.calls.filter(
      ({ method, params }) =>
        method === HostMethod.EventsAppend && params.batch?.[0]?.event_type === RunEvent.AutopilotPlanReview,
    );
  /** The progress the finished run kept that a reopened one earns anew. */
  const EARNED_ANEW = ["firstVerifiedCheckpoint", "latestVerifiedCheckpoint", "softReviewAt"];

  it("K23. a finished build reopened with Loop ∞ takes its required outcomes from the plan its lead writes for the ask — not the finished run's verified ones, nor its old plan's", async () => {
    const reopens = [
      { label: "a Loop ∞ build reopened with ∞", journal: reopenedWith(finishedGoalJournal(), null) },
      { label: "a timed build reopened with ∞", journal: reopenedWith(finishedJournal(), null) },
    ];
    for (const { label, journal } of reopens) {
      assert.equal(journal.director.goals, null, `${label}: its outcomes are the new plan's to set`);
      for (const key of EARNED_ANEW) assert.equal(key in journal.director, false, `${label}: ${key} is earned anew`);
      journal.director.plan = { summary: "This run: a dusk plaza.", workers: [{ id: "sky", done: SKY_DONE }] };
      const host = fakeHost();
      const loopRun = workerLoopRun(host, journal, Date.now(), journal.run);
      assert.equal(loopRun.state.goals, undefined, `${label}: no outcomes until it plans`);
      const start = workerStart(loopRun);

      const unplanned = await start({ id: "enemies" });
      assert.equal(typeof unplanned, "string", `${label}: ${JSON.stringify(unplanned)}`);
      assert.match(unplanned, /call plan/);
      assert.doesNotMatch(unplanned, /finish instead|needs goal=/);
      assert.match(await loopRun.setPlan(ENEMIES), /Required acceptance is frozen: enemies\./, label);
      assert.equal(planCards(host).length, 1, `${label}: the user sees the plan for the ask`);
      assert.deepEqual(
        loopRun.state.goals.entries.map((goal: { id: string }) => goal.id),
        ["enemies"],
      );
      assert.equal((await start({ id: "enemies" })).started, "enemies", label);
      await Promise.all(
        [...loopRun.state.workers.values()].map((worker: { promise?: Promise<unknown> }) => worker.promise),
      );
    }
  });

  it("K24. a finished build reopened with hours works to its ask, the hours its ceiling: its outcomes come from the plan for the ask, and no working time holds its finish (golden-boot-glory)", async () => {
    const journal = reopenedWith(finishedGoalJournal(), 2);
    assert.equal(journal.run.budgets.completionPolicy, CompletionPolicy.Goal);
    assert.equal(journal.run.budgets.wallClockMs, 2 * HOUR_MS, "the Loop's hours are its ceiling");
    assert.equal(journal.director.goals, null);
    for (const key of EARNED_ANEW) assert.equal(key in journal.director, false, `${key} is earned anew`);
    const host = fakeHost();
    const now = Date.now();
    const loopRun = workerLoopRun(host, journal, now, journal.run);
    assert.equal(loopRun.state.goals, undefined);
    assert.equal(timedWorkRemaining(journal.run, now + HOUR_MS, now), false, "finish is never refused for time left");
    const start = workerStart(loopRun);
    assert.match(String(await start({ id: "enemies" })), /call plan/, "workers wait for the plan for the ask");
    assert.match(await loopRun.setPlan(ENEMIES), /Required acceptance is frozen: enemies\./);
    assert.equal(planCards(host).length, 1, "the new plan is in the chat");
    assert.equal((await start({ id: "enemies" })).started, "enemies");
    await Promise.all(
      [...loopRun.state.workers.values()].map((worker: { promise?: Promise<unknown> }) => worker.promise),
    );
  });

  it("K27. a conflict worker starts on a run with required outcomes: resolving a merge is not a new attempt at a goal", async () => {
    const { resolveByWorker } = await import("../../src/harness-seed/loop/director/conflict-worker.ts");
    const reopened = reopenedWith(finishedGoalJournal(), null);
    const host = fakeHost();
    const loopRun = workerLoopRun(host, reopened, Date.now(), reopened.run);
    await loopRun.setPlan(ENEMIES);
    assert.deepEqual(
      loopRun.state.goals.entries.map((goal: { id: string }) => goal.id),
      ["enemies"],
    );
    const answer = String(
      await resolveByWorker(loopRun as never, { id: "enemies", title: "Enemies" } as never, "c0ffee", [
        "src/enemies.js",
      ]),
    );
    assert.doesNotMatch(answer, /needs goal=|refused|did not start/i, answer);
    assert.ok(
      [...loopRun.state.workers.keys()].some((id: string) => id.startsWith("merge-enemies")),
      `the conflict went to a worker: ${answer}`,
    );
    await Promise.all(
      [...loopRun.state.workers.values()].map((worker: { promise?: Promise<unknown> }) =>
        worker.promise?.catch(() => {}),
      ),
    );
  });

  it("K25. a reopened build paused before it planned asks its own plan for its outcomes again on a Resume; a paused run from before outcomes were kept still takes them from its plan", async () => {
    const reopened = reopenedWith(finishedGoalJournal(), null);
    const host = fakeHost();
    const loopRun = workerLoopRun(host, reopened, Date.now(), reopened.run);
    await loopRun.saveJournal();
    const saved = host.journals.at(-1);
    assert.ok(saved, "the reopened run saved its journal");
    const paused = structuredClone(saved);
    assert.equal(paused.director.goals, null, "the save says its outcomes still wait for its plan");
    assert.equal(reopenMarkOf(paused), null, "a pause of the reopened run is a pause, not a reopen");
    const resumed = workerLoopRun(fakeHost(), { ...paused, run: reopened.run }, Date.now(), reopened.run);
    assert.equal(resumed.state.goals, undefined, "not the finished build's plan made outcomes");

    // A goal run saved before outcomes were kept (no `goals` at all) still takes them from its plan.
    const before = { ...paused, director: { ...paused.director } };
    delete before.director.goals;
    const legacy = workerLoopRun(fakeHost(), before, Date.now(), reopened.run);
    assert.deepEqual(
      legacy.state.goals?.entries.map((goal: { id: string }) => goal.id),
      ["sky"],
    );
  });

  it("K26. a reopened Loop ∞ build whose first plan for the ask is refused keeps no outcomes: the plan that follows posts its card and sets them", async () => {
    const journal = reopenedWith(finishedGoalJournal(), null);
    const host = fakeHost();
    const loopRun = workerLoopRun(host, journal, Date.now(), journal.run);
    // A quote of the user's words that is not theirs exactly: the scope revision is refused.
    const refused = await loopRun.setPlan({ ...ENEMIES, scope_instruction: "Add some enemies" });
    assert.match(refused, /quoted exactly/);
    assert.equal(loopRun.state.goals, undefined, "a refused plan sets no outcomes");
    assert.match(await loopRun.setPlan(ENEMIES), /Required acceptance is frozen: enemies\./);
    assert.equal(planCards(host).length, 1, "the user sees the plan that was taken");
    assert.equal((await workerStart(loopRun)({ id: "enemies" })).started, "enemies");
    await Promise.all(
      [...loopRun.state.workers.values()].map((worker: { promise?: Promise<unknown> }) => worker.promise),
    );
  });

  it("K27. a reopened build's outcomes wait for its plan whichever journal.ts reads it back: those a kept one rebuilt from the finished plan are set aside, and a Resume's own are kept", () => {
    const journal = reopenedWith(finishedGoalJournal(), null);
    const loopRun = workerLoopRun(fakeHost(), journal, Date.now(), journal.run);
    // What a kept journal.ts from before `goals: null` waited for its plan makes of it.
    loopRun.state.goals = {
      version: 1,
      entries: [{ id: "sky", required: true, acceptance: SKY_DONE, status: "pending" }],
    };
    outcomesAwaitPlan(loopRun);
    assert.equal(loopRun.state.goals, undefined, "the finished plan's parts are not the ask's outcomes");

    const resumed = workerLoopRun(
      fakeHost(),
      { ...journal, director: { ...journal.director, reopened: undefined } },
      Date.now(),
      journal.run,
    );
    resumed.state.goals = {
      version: 1,
      entries: [{ id: "enemies", required: true, acceptance: ["x"], status: "pending" }],
    };
    outcomesAwaitPlan(resumed);
    assert.deepEqual(
      resumed.state.goals?.entries.map((goal: { id: string }) => goal.id),
      ["enemies"],
      "a run that is not a reopen keeps what it restored",
    );
  });

  it("K18. a finished build reopened gets a fresh clock of its new budget — the time the finished run worked is not taken back — while a paused one still goes on with what it had left", async (t) => {
    const finished = finishedJournal();
    const run = { ...finished.run, budgets: { wallClockMs: 2 * HOUR_MS } };
    const reopened = reopenedJournal(finished, run, MARK);
    assert.deepEqual(reopened.run, run, "the run with the Loop's new budget");
    assert.deepEqual(reopened.director.reopened, MARK);
    assert.equal(reopened.phase, "done", "the run's setup writes its own phase");
    assert.ok(finished.director.clock, "the journal it read is left as it was");

    const total = 2 * HOUR_MS;
    const clock = loopRunClock({ saved: reopened.director.clock, now: MORNING, totalMs: total });
    assert.deepEqual(clock, {
      started: MORNING,
      softDeadline: MORNING + total - wrapReserveMs(total),
      finalDeadline: MORNING + total,
    });
    // The finished journal as it was would count its spent hour against the new budget.
    assert.equal(
      loopRunClock({ saved: finished.director.clock, now: MORNING, totalMs: total }).started,
      MORNING - HOUR_MS,
    );
    // A paused run still goes on with the working time it had left.
    const paused = loopRunClock({ saved: keptClock(20 * MINUTE_MS), now: MORNING, totalMs: HOUR_MS });
    assert.equal(paused.started, MORNING - 20 * MINUTE_MS);

    // The reopened run counts its own work: saved half an hour in, it has worked half an hour.
    t.mock.timers.enable({ apis: ["Date"], now: MORNING + 30 * MINUTE_MS });
    const host = fakeHost();
    const loopRun = fakeLoopRun(host, { resume: true, priorJournal: reopened, ...clock, clock });
    await loopRun.saveJournal();
    assert.equal(host.journals.at(-1)?.director.clock.workedMs, 30 * MINUTE_MS);
  });

  it("K19. a reopened build forks from the game folder as it is now when the finished build is in it, and from the finished build when it is not; the folder as it is now is its start either way", async () => {
    /** A ctx whose git answers `answer` (or throws), keeping every call. */
    const gitCtx = (answer: () => unknown) => {
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const call = async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return answer();
      };
      return { ctx: { call } as never, calls };
    };
    const facts = { project: "plaza", runId: "run_j", finishedHead: FINISHED, liveHead: LIVE };

    const landed = gitCtx(() => ({ code: 0, stdout: "yes\n" }));
    assert.deepEqual(await reopenCommits(landed.ctx, facts), { baseCommit: LIVE, forkCommit: LIVE });
    assert.deepEqual(
      landed.calls.map(({ method, params }) => ({ method, project: params.project, command: params.command })),
      [{ method: HostMethod.RunExec, project: "plaza", command: GIT.isAncestor(FINISHED) }],
      "the finished build is looked for in the live folder",
    );
    const apart = [
      () => ({ code: 0, stdout: "no\n" }),
      () => {
        throw new Error("git is gone");
      },
    ];
    for (const answer of apart)
      assert.deepEqual(
        await reopenCommits(gitCtx(answer).ctx, facts),
        { baseCommit: LIVE, forkCommit: FINISHED },
        "not in the folder, or git cannot tell: it forks from the finished build",
      );

    // A head that is not a commit reaches no command line: the mark drops it, and so does the fork.
    for (const head of [null, "", "--output=/tmp/owned", "refs/heads/main", "$(touch /tmp/owned)", 42]) {
      const mark = reopenMarkOf({ director: { reopened: { at: iso(MORNING), finishedHead: head } } });
      assert.deepEqual(mark, { at: iso(MORNING), finishedHead: null }, `${String(head)} is no head`);
      const probe = gitCtx(() => ({ code: 0, stdout: "yes\n" }));
      const commits = await reopenCommits(probe.ctx, { ...facts, finishedHead: head as never });
      assert.deepEqual(commits, { baseCommit: LIVE, forkCommit: LIVE });
      assert.equal(probe.calls.length, 0, `${String(head)}: git is not asked`);
    }
    assert.equal(reopenMarkOf({ director: { reopened: { finishedHead: FINISHED } } }), null, "a mark with no time");
    assert.equal(reopenMarkOf({ phase: "paused", director: { integrationHead: FINISHED } }), null, "a paused run");
    assert.equal(reopenMarkOf(null), null);

    // The lead's first words say where it goes on from.
    assert.match(
      reopenNote({ inFolder: true, forkCommit: LIVE }),
      new RegExp(`game folder as it is now \\(${shortSha(LIVE)}\\)`),
    );
    assert.match(reopenNote({ inFolder: false, forkCommit: FINISHED }), /not in the game folder .*finish land=yes/);
  });

  it("K20. a reopened build reads its journal back — its workers, the defects nobody owns, its plan — but not the last health pass, which was the finished head's", () => {
    const loopRun = fakeLoopRun(fakeHost(), { resume: true, priorJournal: reopenedWithTwoHours() });
    restoreLoopRun(loopRun, MORNING);
    assert.equal(loopRun.state.integrationHealthy, null, "no health pass yet on the head it now stands on");
    assert.deepEqual(priorWorkerIds(loopRun), ["sky", "w1"]);
    assert.equal(defaultWorkerId(loopRun), "w2");
    assert.equal(loopRun.state.planGo, true, "the plan the build finished on goes on");
    assert.deepEqual(
      loopRun.state.ledger.map((defect: Record<string, unknown>) => defect.text),
      ["the crates float above the plaza"],
    );
    // The finished journal as it was would carry that pass onto the reopened run.
    const stale = fakeLoopRun(fakeHost(), { resume: true, priorJournal: finishedJournal() });
    restoreLoopRun(stale, MORNING);
    assert.equal(stale.state.integrationHealthy, true);
  });

  it("K21. a reopened build opens with the user's ask and its fresh time, never as a pause, and its wake loop starts afresh: asked what next before is not remembered", async () => {
    const reopened = reopenedWithTwoHours();
    const clock = loopRunClock({ saved: reopened.director.clock, now: MORNING, totalMs: 2 * HOUR_MS });
    let told = false;
    const inbox = {
      steering: async () => {
        if (told) return [];
        told = true;
        return ["make the moon red too"];
      },
      finishing: async () => false,
      addressed: async () => [],
      backlog: async () => [],
    };
    const loopRun = fakeLoopRun(fakeHost(), { resume: true, priorJournal: reopened, inbox, ...clock, clock });
    restoreLoopRun(loopRun, MORNING);
    // Turn 1 starts nothing; turn 2 finishes the run.
    const { talk, turns } = lead((turn) => {
      if (turn === 2) loopRun.state.finished = true;
      return { ok: true, sessionId: "lead-1" };
    });
    await runWakeLoop(loopRun, talk, BRIEF, fakeClock(MORNING));

    assert.equal(turns.length, 2, turns.map((turn) => turn.prompt.slice(0, 160)).join("\n---\n"));
    const [first = "", second = ""] = turns.map((turn) => turn.prompt);
    assert.match(first, /THE BUILD GOES ON AT \d\d:\d\d UTC/);
    assert.match(first, new RegExp(`${minutes(clock.softDeadline - MORNING)} more working minutes`));
    assert.match(first, /THE USER SAYS[\s\S]*make the moon red too/);
    assert.match(section(first, "WHERE THE RUN STANDS:"), /sky .*done in the finished build/);
    assert.doesNotMatch(first, /pause/, first);
    assert.match(second, /What next\?/, "an idle turn is asked what next, once, as on a new run");
    assert.doesNotMatch(second, /starts the wrap-up now/);
  });

  it("K22. a new worker of a reopened build never takes the id of one from the finished build that left work unless it builds on it, and the default id passes them", async () => {
    const loopRun = workerLoopRun(fakeHost(), reopenedWithTwoHours(), Date.now());
    assert.match(priorWorkersSummary(loopRun) ?? "", /^- from the finished build, not running: sky, w1 /);
    const start = workerStart(loopRun);

    const taken = await start({ id: "sky" });
    assert.equal(typeof taken, "string", `refused: ${JSON.stringify(taken)}`);
    assert.match(taken, /"sky" ran in the finished build/);
    assert.match(taken, new RegExp(`from=${SKY_ACCEPTED}`), "and it says how to build on that work");
    assert.equal((await start({})).started, "w2", "the default id passes w1, from the finished build");
    assert.equal((await start({ id: "sky", from: SKY_ACCEPTED })).started, "sky", "it may start again on its own work");
    await Promise.all(
      [...loopRun.state.workers.values()].map((worker: { promise?: Promise<unknown> }) => worker.promise),
    );
  });

  it("K28. a finished goal build whose finish the art director turned back once is reopened: the new ask's finish is the art director's to turn back once again, and the finished head's review is not the new ask's (SR-2)", () => {
    const finished = finishedGoalJournal();
    const turnedBack = {
      ...finished,
      director: {
        ...finished.director,
        shipFinishRefused: true,
        lastShip: { head: FINISHED, ship: false, defects: [{ part: "sky", severity: "visible" }], at: iso(T0) },
        wake: { ...finished.director.wake, finishMarkSaid: true },
      },
    };
    const journal = reopenedWith(turnedBack, null);
    assert.equal("shipFinishRefused" in journal.director, false, "the once is per commission");
    assert.equal("lastShip" in journal.director, false, "the review was of the finished build for its ask");
    const loopRun = fakeLoopRun(fakeHost(), { resume: true, priorJournal: journal, run: journal.run });
    restoreLoopRun(loopRun, MORNING);
    assert.notEqual(loopRun.state.shipFinishRefused, true, "its finish goes through the art director's gate");
    assert.equal(loopRun.state.lastShip, null);

    // A Resume of the reopened build, paused after the art director turned its own finish back, keeps that.
    const paused = { ...journal, director: { ...journal.director, ...turnedBack.director, reopened: MARK } };
    const resumed = fakeLoopRun(fakeHost(), { resume: true, priorJournal: paused, run: journal.run });
    restoreLoopRun(resumed, MORNING);
    assert.equal(resumed.state.shipFinishRefused, true, "never twice within one commission");
    assert.equal(resumed.state.lastShip?.head, FINISHED);
  });
});

describe("a run reads its job ends on from its journal's cursor (journal.ts, wake.ts)", () => {
  const BUILD_ID = "0b5e3c1a-3f7e-4f3d-9f0e-6f1c2d3e4a5b";
  /** The run's fourth job end: a worker's build that failed. */
  const fourthEnd = {
    id: BUILD_ID,
    title: "Unreal build",
    role: "worker",
    worker: "Scene builder",
    command: "make build",
    state: "failed",
    exitCode: 2,
    endedAt: iso(T0),
    endSeq: 4,
    durationMs: 4 * MINUTE_MS,
    stoppedBy: null,
  };
  /** A host whose registry holds that end after end number 3. */
  const jobsAnswer = (params: Record<string, any>) =>
    params.endedAfter < 4 ? { jobs: [fourthEnd], seq: 4 } : { jobs: [], seq: 4 };

  /** A resumed run on `priorJournal` whose lead rests once, then finishes: its turns and the host's calls. */
  async function resumedLoopRun(priorJournal: Record<string, any>) {
    const host = fakeHost();
    const loopRun = fakeLoopRun(host, { resume: true, priorJournal }, { [HostMethod.JobsList]: jobsAnswer });
    restoreLoopRun(loopRun, T0);
    const { talk, turns } = lead((turn) => {
      if (turn > 1) loopRun.state.finished = true;
      return { ok: true, sessionId: "lead-1" };
    });
    await runWakeLoop(loopRun, talk, BRIEF, fakeClock(T0));
    const reads = host.calls.filter((call) => call.method === HostMethod.JobsList).map((call) => call.params);
    return { host, turns, reads };
  }

  it("after a restart the run reads on from its journal's cursor, and the next save keeps where it got to", async () => {
    const { host, turns, reads } = await resumedLoopRun({ director: { workers: {}, ledger: [], jobsCursor: 3 } });
    assert.deepEqual(reads[0], { project: "plaza", runId: "run_j", endedAfter: 3 });
    assert.match(
      turns[1]?.prompt ?? "",
      /Unreal build \(`make build`, started by worker Scene builder\) failed \(exit 2\) after 4 min/,
    );
    assert.equal(host.journals.at(-1)?.director.jobsCursor, 4, "the journal keeps the cursor past the end it told");
    assert.ok(
      reads.slice(1).every((params) => params.endedAfter === 4),
      "an end is told once",
    );
  });

  it("a journal from before it kept a cursor reads the run's job ends from the start", async () => {
    const { reads } = await resumedLoopRun({ director: { workers: {}, ledger: [] } });
    assert.equal(reads[0]?.endedAfter, 0);
  });
});

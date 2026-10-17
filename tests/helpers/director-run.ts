/**
 * A director's run without a rig: the run as prepareLoopRun leaves it, its parts the real ones, on a
 * host that records what it is asked; the wake loop's clock, moved by its own sleeps; and the lead's
 * session, each turn answered by a script. Every clock here is a number the test chooses.
 */
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import * as loopRunFunctions from "../../src/harness-seed/loop/director/loop-run.ts";
import * as toolFunctions from "../../src/harness-seed/loop/director/tools.ts";
import * as workerFunctions from "../../src/harness-seed/loop/director/workers.ts";
import { wrapReserveMs } from "../../src/harness-seed/loop/director/budgets.ts";
import type { DirectorTalk, WakeClock } from "../../src/harness-seed/loop/director/wake.ts";
import { HOUR_MS } from "../../src/harness-seed/loop/time.ts";

/** The rows' own start. */
export const T0 = Date.UTC(2026, 8, 26, 1, 0, 0);
/** The commit the run's integration branch forked from. */
export const FORK = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";

/** What the fake host saw: every call, and each journal as it was written. */
export interface FakeHost {
  calls: Array<{ method: string; params: Record<string, any> }>;
  journals: Array<Record<string, any>>;
}
export const fakeHost = (): FakeHost => ({ calls: [], journals: [] });

/** The run's own clock in these rows: an hour, the wrap-up reserve at its end. */
export const CLOCK = { started: T0, softDeadline: T0 + HOUR_MS - wrapReserveMs(HOUR_MS), finalDeadline: T0 + HOUR_MS };

/**
 * A run as prepareLoopRun leaves it — its data plain, its parts the real ones, bound to it the way
 * `bindLoopRun` binds them — on a host that records what it is asked. An answer may be a function of
 * the call's params.
 */
export function fakeLoopRun(host: FakeHost, over: Record<string, unknown> = {}, answers: Record<string, unknown> = {}) {
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
export function fakeClock(start: number, onSleep: (now: number) => void = () => {}): WakeClock & { at: number } {
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
export function lead(script: (turn: number) => Record<string, unknown> | Promise<Record<string, unknown>>) {
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

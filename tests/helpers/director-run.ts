/**
 * A web game's Loop without a rig: the run as prepareLoopRun leaves it, its parts the real ones
 * (`bindLoopRun`), on a host that records what it is asked and answers from a table the test gives.
 * Every clock here is a number the test chooses, and the run's sleeps pass no time.
 */
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import * as loopRunFunctions from "../../src/harness-seed/loop/director/loop-run.ts";
import * as toolFunctions from "../../src/harness-seed/loop/director/tools.ts";
import * as integrateFunctions from "../../src/harness-seed/loop/director/integrate.ts";
import { wrapReserveMs } from "../../src/harness-seed/loop/director/journal.ts";
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
/** A fresh fake host with nothing seen yet. */
export const fakeHost = (): FakeHost => ({ calls: [], journals: [] });

/** The run's own clock in these rows: an hour, the wrap-up reserve at its end. */
export const CLOCK = { started: T0, softDeadline: T0 + HOUR_MS - wrapReserveMs(HOUR_MS), finalDeadline: T0 + HOUR_MS };

/** The events the run appended, by type, in order. */
export function appended(host: FakeHost): Array<{ type: string; payload: Record<string, any> }> {
  return host.calls
    .filter((call) => call.method === HostMethod.EventsAppend)
    .flatMap((call) => (call.params.batch ?? []) as Array<{ event_type?: string; payload?: Record<string, any> }>)
    .map((event) => ({ type: String(event.event_type), payload: event.payload ?? {} }));
}

/**
 * A run as prepareLoopRun leaves it — its data plain, its parts the real ones, bound to it the way
 * `bindLoopRun` binds them — on a host that records what it is asked. An answer may be a function of
 * the call's params.
 */
export function fakeLoopRun(host: FakeHost, over: Record<string, unknown> = {}, answers: Record<string, unknown> = {}) {
  const run = {
    runId: "run_j",
    project: "plaza",
    goal: "a plaza",
    engine: "codex",
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
      const answer = answers[method];
      return typeof answer === "function" ? answer(params) : (answer ?? null);
    },
  };
  const integrationWorktree = "/runs/run_j/integration";
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
    projectDir: "/games/plaza",
    baseCommit: FORK,
    forkCommit: FORK,
    integrationWorktree,
    integrationRef: "refs/studio/runs/run_j/integration",
    state: {
      run,
      threadId: "t1",
      projectDir: "/games/plaza",
      baseCommit: FORK,
      integrationWorktree,
      integrationHead: FORK,
      healthByHead: new Map(),
      integrationHealthy: null as boolean | null,
      limit: null,
      log: [] as Array<Record<string, unknown>>,
      finish: null,
      finished: false,
      judges: 0,
      softDeadline: CLOCK.softDeadline,
      finalDeadline: CLOCK.finalDeadline,
    },
    journal: { runId: "run_j", run, director: { sessionId: null, workers: {}, notes: [] } },
    logSeq: 0,
    waitSeq: 0,
    toolCalls: 0,
    sleep: async () => {},
    ...over,
  };
  return loopRunFunctions.bindLoopRun(data as never, [loopRunFunctions, toolFunctions, integrateFunctions]) as any;
}

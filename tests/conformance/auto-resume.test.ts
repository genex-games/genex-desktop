/**
 * Host auto-resume (src/main/core/auto-resume.ts): a build an engine limit paused resumes once the
 * limit resets, and one the loop's crash paused resumes once the loop runs again — at most
 * AUTO_RESUMES_MAX times a run, never after the user's Stop or Finish, never with too little working
 * time or memory left. Decided from typed fields only: the close's `limit`, the host's own crash
 * record, `run_control` actions and `run_auto_resumed` counts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTO_RESUME_HORIZON_MS,
  AUTO_RESUME_MIN_FREE_MB,
  AUTO_RESUME_RECHECK_MAX_MS,
  AUTO_RESUME_RECHECK_MS,
  AUTO_RESUME_WAIT_MS,
  AUTO_RESUMES_MAX,
  AutoResumeAction,
  AutoResumeHold,
  AutoResumeService,
  AutoResumeSkip,
  LIMIT_RESET_MARGIN_MS,
  OUTAGE_RESUME_AFTER_MS,
  autoResumePlan,
  type AutoResumeFacts,
} from "../../src/main/core/auto-resume.ts";
import { AutoResumeCause, CustomEvent, type RunAutoResumedPayload } from "../../src/shared/custom-events.ts";
import { RunControlAction } from "../../src/shared/coordinator.ts";
import { EngineFailureKind } from "../../src/shared/engine-requests.ts";
import { EventKind, type EventEnvelope } from "../../src/shared/event-log.ts";
import { HOUR_MS, MINUTE_MS } from "../../src/shared/duration.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { ActivityIndex } from "../../src/shared/studio-activity.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { coreLite } from "../helpers/core-lite.ts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodexEngine, type CodexExec } from "../../src/substrate/engines/codex.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { engineLimitOf } from "../../src/harness-seed/loop/outage.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** How long the core test lets an asynchronous plan settle: a few short steps, never a deadline. */
const SETTLE_TRIES = 20;
const SETTLE_STEP_MS = 10;

const RUN = "run-a";
const THREAD = "chat";
const T0 = Date.parse("2026-10-06T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

let clock = 0;
function custom(at: number, event_type: string, payload: Record<string, unknown>): EventEnvelope {
  clock += 1;
  return {
    id: `e${String(clock).padStart(5, "0")}`,
    thread_id: THREAD,
    session_id: null,
    turn_id: null,
    created_at: iso(at),
    data: { type: EventKind.Custom, event_type, payload },
  };
}

const registered = (at = T0, budgets: Record<string, unknown> = { wallClockMs: 4 * HOUR_MS }) =>
  custom(at, CustomEvent.RunRegistered, { runId: RUN, project: "kart", budgets });
const resumedStart = (at: number) =>
  custom(at, CustomEvent.RunRegistered, { runId: RUN, project: "kart", resumed: true });

/** A director's close on an engine limit, as `integrate.ts` `closeRun` writes it, and its pause. */
function limitPause(at: number, limit: Record<string, unknown>): EventEnvelope[] {
  return [
    custom(at, CustomEvent.RunFinished, { runId: RUN, project: "kart", executionStatus: "paused", limit }),
    custom(at, CustomEvent.AutopilotPaused, { runId: RUN, project: "kart" }),
  ];
}

/** A close with no limit: the user's Stop, or the reborn loop's crash close (`boot-notice.ts`). */
function plainPause(at: number, extra: Record<string, unknown> = {}): EventEnvelope[] {
  return [
    custom(at, CustomEvent.RunFinished, { runId: RUN, project: "kart", victory: false, ...extra }),
    custom(at, CustomEvent.AutopilotPaused, { runId: RUN, project: "kart" }),
  ];
}

const autoResumed = (at: number, runId = RUN) =>
  custom(at, CustomEvent.RunAutoResumed, { runId, cause: AutoResumeCause.LimitReset, attempt: 1 });

const PAUSED_AT = T0 + 60 * MINUTE_MS;
const RESET_MS = 30 * MINUTE_MS;
const DUE = PAUSED_AT + RESET_MS + LIMIT_RESET_MARGIN_MS;
const rateLimit = { kind: EngineFailureKind.RateLimit, retryAfterMs: RESET_MS };

const facts = (patch: Partial<AutoResumeFacts> = {}): AutoResumeFacts => ({
  runId: RUN,
  enabled: true,
  harnessReady: true,
  freeMb: 8_000,
  crashedAt: null,
  stoppedAt: null,
  ...patch,
});

const limited = () => [registered(), ...limitPause(PAUSED_AT, rateLimit)];
const crashed = () => [
  registered(),
  ...plainPause(PAUSED_AT, { stoppedBecause: "the studio's loop crashed and restarted" }),
];
const CRASH_AT = PAUSED_AT - MINUTE_MS;

describe("autoResumePlan: when a paused build resumes on its own", () => {
  const rows: Array<{
    name: string;
    events: () => EventEnvelope[];
    now: number;
    facts?: Partial<AutoResumeFacts>;
    want: Record<string, unknown>;
  }> = [
    {
      name: "an engine-limit pause waits for the reset plus a margin",
      events: limited,
      now: PAUSED_AT + MINUTE_MS,
      want: { action: AutoResumeAction.Wait, at: DUE, hold: AutoResumeHold.Reset },
    },
    {
      name: "once the reset has passed it resumes, as the run's first automatic resume",
      events: limited,
      now: DUE,
      want: { action: AutoResumeAction.Resume, cause: AutoResumeCause.LimitReset, attempt: 1 },
    },
    {
      name: "a usage cap with a known reset is waited out the same way",
      events: () => [
        registered(),
        ...limitPause(PAUSED_AT, { kind: EngineFailureKind.UsageLimit, retryAfterMs: RESET_MS }),
      ],
      now: DUE,
      want: { action: AutoResumeAction.Resume, cause: AutoResumeCause.LimitReset, attempt: 1 },
    },
    {
      name: "the reset counts from when the limit was hit, when the close says",
      events: () => [registered(), ...limitPause(PAUSED_AT, { ...rateLimit, at: PAUSED_AT - 10 * MINUTE_MS })],
      now: PAUSED_AT,
      want: { action: AutoResumeAction.Wait, at: DUE - 10 * MINUTE_MS, hold: AutoResumeHold.Reset },
    },
    {
      name: "a limit with no reset time is the user's to resume",
      events: () => [
        registered(),
        ...limitPause(PAUSED_AT, { kind: EngineFailureKind.UsageLimit, retryAfterMs: null }),
      ],
      now: DUE,
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.NotResumable },
    },
    {
      name: "a reset further away than the horizon is the user's to resume",
      events: () => [
        registered(),
        ...limitPause(PAUSED_AT, { ...rateLimit, retryAfterMs: AUTO_RESUME_HORIZON_MS + HOUR_MS }),
      ],
      now: PAUSED_AT,
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.ResetTooFar },
    },
    {
      name: "a lost sign-in is the user's to fix, whatever reset its close names",
      events: () => [registered(), ...limitPause(PAUSED_AT, { kind: EngineFailureKind.Auth, retryAfterMs: RESET_MS })],
      now: DUE,
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.AccessLost },
    },
    {
      name: "an account whose access was taken away is the user's to fix",
      events: () => [
        registered(),
        ...limitPause(PAUSED_AT, { kind: EngineFailureKind.Auth, message: "access disabled", retryAfterMs: null }),
      ],
      now: PAUSED_AT + HOUR_MS,
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.AccessLost },
    },
    {
      name: "a provider outage that outlasted the lead's patience is tried again after a wait",
      events: () => [
        registered(),
        ...limitPause(PAUSED_AT, { kind: EngineFailureKind.Unavailable, retryAfterMs: null }),
      ],
      now: PAUSED_AT + MINUTE_MS,
      want: { action: AutoResumeAction.Wait, at: PAUSED_AT + OUTAGE_RESUME_AFTER_MS, hold: AutoResumeHold.Outage },
    },
    {
      name: "once that wait is over it resumes, as an automatic resume of its own cause",
      events: () => [
        registered(),
        ...limitPause(PAUSED_AT, {
          kind: EngineFailureKind.Unavailable,
          retryAfterMs: null,
          at: PAUSED_AT - MINUTE_MS,
        }),
      ],
      now: PAUSED_AT - MINUTE_MS + OUTAGE_RESUME_AFTER_MS,
      want: { action: AutoResumeAction.Resume, cause: AutoResumeCause.ProviderOutage, attempt: 1 },
    },
    {
      name: "a failure that is neither a limit, a sign-in nor an outage never resumes",
      events: () => [registered(), ...limitPause(PAUSED_AT, { kind: EngineFailureKind.Other, retryAfterMs: RESET_MS })],
      now: DUE,
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.NotResumable },
    },
    {
      name: "a loop-crash pause resumes once the loop is running again",
      events: crashed,
      now: PAUSED_AT,
      facts: { crashedAt: CRASH_AT },
      want: { action: AutoResumeAction.Resume, cause: AutoResumeCause.LoopRestart, attempt: 1 },
    },
    {
      name: "a loop-crash pause waits while the loop is still starting",
      events: crashed,
      now: PAUSED_AT,
      facts: { crashedAt: CRASH_AT, harnessReady: false },
      want: { action: AutoResumeAction.Wait, at: PAUSED_AT + AUTO_RESUME_RECHECK_MS, hold: AutoResumeHold.Harness },
    },
    {
      name: "a loop that never comes back is given up on",
      events: crashed,
      now: PAUSED_AT + AUTO_RESUME_WAIT_MS + 1,
      facts: { crashedAt: CRASH_AT, harnessReady: false },
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.HarnessDown },
    },
    {
      name: "a pause with no limit and no crash under it (the user's Stop) never resumes",
      events: crashed,
      now: PAUSED_AT,
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.NotResumable },
    },
    {
      name: "a crash from before the run started again is not this pause's",
      events: () => [registered(), ...plainPause(PAUSED_AT)],
      now: PAUSED_AT,
      facts: { crashedAt: T0 - MINUTE_MS },
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.NotResumable },
    },
    {
      name: "a crash after the pause did not cause it",
      events: () => [registered(), ...plainPause(PAUSED_AT)],
      now: PAUSED_AT + 2 * MINUTE_MS,
      facts: { crashedAt: PAUSED_AT + MINUTE_MS },
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.NotResumable },
    },
    {
      name: "the user's Stop during the run outranks the limit that paused it",
      events: limited,
      now: DUE,
      facts: { stoppedAt: PAUSED_AT - MINUTE_MS },
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.UserStopped },
    },
    {
      name: "a Stop from before the run started again does not hold it back",
      events: limited,
      now: DUE,
      facts: { stoppedAt: T0 - MINUTE_MS },
      want: { action: AutoResumeAction.Resume, cause: AutoResumeCause.LimitReset, attempt: 1 },
    },
    {
      name: "the user's Finish never resumes",
      events: () => [
        registered(),
        custom(T0 + MINUTE_MS, CustomEvent.RunControl, { runId: RUN, action: RunControlAction.Finish }),
        ...limitPause(PAUSED_AT, rateLimit),
      ],
      now: DUE,
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.FinishAsked },
    },
    {
      name: "a resumed run that pauses again is its second automatic resume",
      events: () => [...limited(), autoResumed(DUE), resumedStart(DUE), ...limitPause(DUE + HOUR_MS, rateLimit)],
      now: DUE + HOUR_MS + RESET_MS + LIMIT_RESET_MARGIN_MS,
      want: { action: AutoResumeAction.Resume, cause: AutoResumeCause.LimitReset, attempt: 2 },
    },
    {
      name: `after ${AUTO_RESUMES_MAX} automatic resumes it is the user's`,
      events: () => [
        ...limited(),
        autoResumed(DUE),
        resumedStart(DUE),
        autoResumed(DUE + HOUR_MS),
        resumedStart(DUE + HOUR_MS),
        ...limitPause(DUE + 2 * HOUR_MS, rateLimit),
      ],
      now: DUE + 2 * HOUR_MS + RESET_MS + LIMIT_RESET_MARGIN_MS,
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.Spent },
    },
    {
      name: "another run's automatic resumes are not counted",
      events: () => [autoResumed(T0 - HOUR_MS, "run-b"), autoResumed(T0 - HOUR_MS, "run-b"), ...limited()],
      now: DUE,
      want: { action: AutoResumeAction.Resume, cause: AutoResumeCause.LimitReset, attempt: 1 },
    },
    {
      name: "too little working time left is not worth a resume",
      events: () => [registered(T0, { wallClockMs: 65 * MINUTE_MS }), ...limitPause(PAUSED_AT, rateLimit)],
      now: DUE,
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.NoTimeLeft },
    },
    {
      name: "a run until satisfied has no clock to run out",
      events: () => [registered(T0, { untilSatisfied: true }), ...limitPause(PAUSED_AT, rateLimit)],
      now: DUE,
      want: { action: AutoResumeAction.Resume, cause: AutoResumeCause.LimitReset, attempt: 1 },
    },
    {
      name: "memory below the floor waits",
      events: limited,
      now: DUE,
      facts: { freeMb: AUTO_RESUME_MIN_FREE_MB - 1 },
      want: { action: AutoResumeAction.Wait, at: DUE + AUTO_RESUME_RECHECK_MS, hold: AutoResumeHold.Memory },
    },
    {
      name: "memory that never recovers is given up on",
      events: limited,
      now: DUE + AUTO_RESUME_WAIT_MS + 1,
      facts: { freeMb: 70 },
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.LowMemory },
    },
    {
      name: "memory that cannot be read does not hold it back",
      events: limited,
      now: DUE,
      facts: { freeMb: null },
      want: { action: AutoResumeAction.Resume, cause: AutoResumeCause.LimitReset, attempt: 1 },
    },
    {
      name: "switched off in Settings, nothing resumes",
      events: limited,
      now: DUE,
      facts: { enabled: false },
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.Off },
    },
    {
      name: "a run the user already resumed is not paused",
      events: () => [...limited(), resumedStart(PAUSED_AT + MINUTE_MS)],
      now: DUE,
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.NotPaused },
    },
    {
      name: "a newer run started in the same chat: the paused one is the user's",
      events: () => [
        ...limited(),
        custom(PAUSED_AT + MINUTE_MS, CustomEvent.RunRegistered, { runId: "run-b", project: "kart" }),
        custom(PAUSED_AT + 30 * MINUTE_MS, CustomEvent.RunFinished, {
          runId: "run-b",
          project: "kart",
          executionStatus: "completed",
        }),
      ],
      now: DUE,
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.Superseded },
    },
    {
      name: "another run still running: the paused one waits for the user",
      events: () => [
        custom(T0 - MINUTE_MS, CustomEvent.RunRegistered, { runId: "run-b", project: "kart" }),
        ...limited(),
      ],
      now: DUE,
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.Superseded },
    },
    {
      name: "a run that finished is not paused",
      events: () => [
        registered(),
        custom(PAUSED_AT, CustomEvent.RunFinished, { runId: RUN, executionStatus: "completed", limit: rateLimit }),
      ],
      now: DUE,
      want: { action: AutoResumeAction.None, skip: AutoResumeSkip.NotPaused },
    },
  ];
  for (const row of rows) {
    it(row.name, () => {
      assert.deepEqual(autoResumePlan(row.events(), row.now, facts(row.facts)), row.want);
    });
  }

  it("reads a limit's fields by type, never by shape alone: hostile values are not a reset", () => {
    const hostile: unknown[] = [
      "1800000",
      -RESET_MS,
      0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { ms: RESET_MS },
      [RESET_MS],
    ];
    for (const retryAfterMs of hostile) {
      const events = [registered(), ...limitPause(PAUSED_AT, { kind: EngineFailureKind.RateLimit, retryAfterMs })];
      assert.deepEqual(
        autoResumePlan(events, DUE, facts()),
        { action: AutoResumeAction.None, skip: AutoResumeSkip.NotResumable },
        `retryAfterMs ${JSON.stringify(retryAfterMs)}`,
      );
    }
    for (const limit of [null, "rate_limit", 42, [], { kind: "rate limit", retryAfterMs: RESET_MS }]) {
      const events = [registered(), ...limitPause(PAUSED_AT, limit as Record<string, unknown>)];
      assert.equal(autoResumePlan(events, DUE, facts()).action, AutoResumeAction.None, JSON.stringify(limit));
    }
  });
});

/** The service with every clock and port faked: timers run when the test says. */
function harness(
  options: {
    enabled?: boolean;
    ready?: boolean;
    freeMb?: number | null;
    resume?: (runId: string) => Promise<void>;
    /** Runs while the record is being appended, before it lands. */
    record?: () => Promise<void>;
  } = {},
) {
  let now = PAUSED_AT;
  let ready = options.ready ?? true;
  let enabled = options.enabled ?? true;
  let eventsFail = false;
  /** Each change of "a resume is waiting" the service announced, in order (what holds the Mac awake). */
  const pendingChanges: boolean[] = [];
  const timers = new Map<number, { at: number; ms: number; run: () => void }>();
  const memoryReads: number[] = [];
  const logReads: number[] = [];
  let nextTimer = 1;
  let log: EventEnvelope[] = [registered()];
  const recorded: Array<{ threadId: string; payload: RunAutoResumedPayload }> = [];
  const resumed: string[] = [];
  const service = new AutoResumeService({
    enabled: () => enabled,
    harnessReady: () => ready,
    freeMb: async () => {
      memoryReads.push(now);
      return options.freeMb ?? 8_000;
    },
    events: async () => {
      logReads.push(now);
      if (eventsFail) throw new Error("the log could not be read");
      return log;
    },
    record: async (threadId, payload) => {
      await options.record?.();
      recorded.push({ threadId, payload });
      log = [...log, custom(now, CustomEvent.RunAutoResumed, { ...payload })];
    },
    resume: async (runId) => {
      resumed.push(runId);
      await options.resume?.(runId);
    },
    now: () => now,
    setTimer: (run, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, ms, run });
      return id;
    },
    clearTimer: (handle) => timers.delete(handle as number),
    onPendingChange: (pending) => pendingChanges.push(pending),
  });
  return {
    service,
    pendingChanges,
    recorded,
    resumed,
    timers,
    memoryReads,
    logReads,
    /**
     * The Mac slept: the wall clock jumps to `at`, but a timer counts only awake time, so just the
     * earliest pending timer fires, however far it was from due.
     */
    async wakeAt(at: number) {
      now = at;
      const [next] = [...timers].sort(([, a], [, b]) => a.at - b.at);
      if (!next) return;
      timers.delete(next[0]);
      next[1].run();
      await service.idle();
    },
    /** Run the timers due by `at` without waiting for the looks they start to settle. */
    fire(at: number) {
      now = at;
      for (const [id, timer] of [...timers].filter(([, t]) => t.at <= now)) {
        timers.delete(id);
        timer.run();
      }
    },
    append(events: EventEnvelope[]) {
      log = [...log, ...events];
      service.observe(THREAD, events);
    },
    setReady(value: boolean) {
      ready = value;
    },
    setEnabled(value: boolean) {
      enabled = value;
    },
    failEvents() {
      eventsFail = true;
    },
    /** Move the clock to `at` and run every timer due by then, letting each tick settle. */
    async advance(at: number) {
      now = at;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= now);
        if (due.length === 0) break;
        for (const [id, timer] of due) {
          timers.delete(id);
          timer.run();
        }
        await service.idle();
      }
    },
  };
}

describe("AutoResumeService: the planner wired to timers and the resume path", () => {
  it("records the automatic resume, then resumes, at the reset — not before", async () => {
    const h = harness();
    h.append(limitPause(PAUSED_AT, rateLimit));
    await h.advance(PAUSED_AT);
    assert.deepEqual(h.resumed, [], "nothing resumes before the reset");
    assert.deepEqual(
      [...h.timers.values()].map((t) => t.at),
      [PAUSED_AT + AUTO_RESUME_RECHECK_MAX_MS],
      "the next look is a bounded step towards the reset, not one long timer",
    );
    assert.deepEqual(h.memoryReads, [], "memory is read only once a resume is due");
    await h.advance(DUE);
    assert.deepEqual(h.resumed, [RUN]);
    assert.deepEqual(h.recorded, [
      { threadId: THREAD, payload: { runId: RUN, project: "kart", cause: AutoResumeCause.LimitReset, attempt: 1 } },
    ]);
    assert.equal(h.timers.size, 0);
  });

  it("a crash pause resumes once the loop is ready again, and forgetting the crash (the watchdog) cancels it", async () => {
    const h = harness({ ready: false });
    h.service.noteCrash([RUN]);
    h.append(plainPause(PAUSED_AT));
    await h.advance(PAUSED_AT);
    assert.deepEqual(h.resumed, [], "the loop is still starting");
    h.setReady(true);
    await h.advance(PAUSED_AT + AUTO_RESUME_RECHECK_MS);
    assert.deepEqual(h.resumed, [RUN]);
    assert.equal(h.recorded[0]?.payload.cause, AutoResumeCause.LoopRestart);

    const watchdog = harness();
    watchdog.service.noteCrash([RUN]);
    watchdog.service.forgetCrashes();
    watchdog.append(plainPause(PAUSED_AT));
    await watchdog.advance(DUE);
    assert.deepEqual(watchdog.resumed, [], "a crash loop the watchdog rewound is the user's to resume");
  });

  const cancellations: Array<{ name: string; cancel: (h: ReturnType<typeof harness>) => void }> = [
    { name: "the user's Stop", cancel: (h) => h.service.userStopped(THREAD) },
    { name: "the user's own Resume", cancel: (h) => h.service.cancelRun(RUN) },
    { name: "the run starting again", cancel: (h) => h.append([resumedStart(PAUSED_AT + MINUTE_MS)]) },
  ];
  for (const { name, cancel } of cancellations) {
    it(`${name} cancels a planned resume`, async () => {
      const h = harness();
      h.append(limitPause(PAUSED_AT, rateLimit));
      await h.advance(PAUSED_AT);
      cancel(h);
      await h.advance(DUE + HOUR_MS);
      assert.deepEqual(h.resumed, []);
      assert.deepEqual(h.recorded, []);
    });
  }

  const lateCancellations: Array<{ name: string; cancel: (h: ReturnType<typeof harness>) => void }> = [
    { name: "the user's Stop in the chat", cancel: (h) => h.service.userStopped(THREAD) },
    { name: "the user's stop of the run itself", cancel: (h) => h.service.userStoppedRun(RUN) },
    { name: "the user's own Resume", cancel: (h) => h.service.cancelRun(RUN) },
  ];
  for (const { name, cancel } of lateCancellations) {
    it(`${name}, pressed while the automatic resume is being recorded, keeps it from dispatching`, async () => {
      let recording: () => void = () => {};
      const started = new Promise<void>((resolve) => (recording = resolve));
      let land: () => void = () => {};
      const landed = new Promise<void>((resolve) => (land = resolve));
      const h = harness({
        record: () => {
          recording();
          return landed;
        },
      });
      h.append(limitPause(PAUSED_AT, rateLimit));
      await h.advance(PAUSED_AT);
      for (let at = PAUSED_AT; at < DUE; at += AUTO_RESUME_RECHECK_MAX_MS) await h.advance(at);
      h.fire(DUE);
      await started;
      cancel(h);
      land();
      await h.service.idle();
      assert.deepEqual(h.resumed, [], "the user's word since the plan holds the dispatch");
    });
  }

  it("switched off, nothing is planned; disposed, nothing is left running", async () => {
    const off = harness({ enabled: false });
    off.append(limitPause(PAUSED_AT, rateLimit));
    await off.advance(DUE);
    assert.deepEqual([off.resumed, off.timers.size], [[], 0]);

    const h = harness();
    h.append(limitPause(PAUSED_AT, rateLimit));
    await h.advance(PAUSED_AT);
    h.service.dispose();
    assert.equal(h.timers.size, 0);
  });

  it("a Mac that slept past the reset resumes at its first look after waking, not a whole sleep late", async () => {
    const h = harness();
    h.append(limitPause(PAUSED_AT, rateLimit));
    await h.advance(PAUSED_AT);
    assert.ok(
      [...h.timers.values()].every((t) => t.ms <= AUTO_RESUME_RECHECK_MAX_MS),
      `every timer is a bounded step: ${[...h.timers.values()].map((t) => t.ms)}`,
    );
    for (let at = PAUSED_AT; at < DUE; at += AUTO_RESUME_RECHECK_MAX_MS) await h.advance(at);
    assert.deepEqual(h.logReads, [PAUSED_AT], "a step before the reset reads nothing");
    await h.wakeAt(DUE + HOUR_MS);
    assert.deepEqual(h.resumed, [RUN], "the first look after waking sees the reset has passed");
  });

  it("the user's stop of the run itself (not its chat) holds a later limit pause back", async () => {
    const h = harness();
    h.service.userStoppedRun(RUN);
    h.append(limitPause(PAUSED_AT, rateLimit));
    await h.advance(DUE + HOUR_MS);
    assert.deepEqual([h.resumed, h.recorded], [[], []]);
  });

  it("a resume that fails after the run paused again does not drop the new plan", async () => {
    let fail: (err: Error) => void = () => {};
    let calls = 0;
    const h = harness({
      resume: () => {
        calls++;
        // The first resume's dispatch settles only when that run ends — here, by failing late.
        return calls === 1 ? new Promise<void>((_resolve, reject) => (fail = reject)) : Promise.resolve();
      },
    });
    h.append(limitPause(PAUSED_AT, rateLimit));
    await h.advance(PAUSED_AT);
    for (let at = PAUSED_AT; at < DUE; at += AUTO_RESUME_RECHECK_MAX_MS) await h.advance(at);
    h.fire(DUE);
    for (let i = 0; i < SETTLE_TRIES && h.resumed.length === 0; i++) await sleep(SETTLE_STEP_MS);
    assert.deepEqual(h.resumed, [RUN], "the first resume is under way");
    const secondPause = DUE + HOUR_MS;
    h.append([resumedStart(DUE), ...limitPause(secondPause, rateLimit)]);
    fail(new Error("the resumed run ended badly"));
    await h.service.idle();
    await h.advance(secondPause);
    for (let at = secondPause; at <= secondPause + RESET_MS + LIMIT_RESET_MARGIN_MS; at += AUTO_RESUME_RECHECK_MAX_MS)
      await h.advance(at);
    await h.advance(secondPause + RESET_MS + LIMIT_RESET_MARGIN_MS);
    assert.deepEqual(h.resumed, [RUN, RUN], "the second pause still resumes");
  });

  it("a resume that fails is still counted, so a failing resume cannot repeat forever", async () => {
    let attempts = 0;
    let log: EventEnvelope[] = [registered(), ...limitPause(PAUSED_AT, rateLimit)];
    const lines: string[] = [];
    const service = new AutoResumeService({
      enabled: () => true,
      harnessReady: () => true,
      freeMb: async () => null,
      events: async () => log,
      record: async (_threadId, payload) => {
        log = [...log, custom(DUE, CustomEvent.RunAutoResumed, { ...payload })];
      },
      resume: async () => {
        attempts++;
        throw new Error("the loop refused");
      },
      now: () => DUE,
      setTimer: (run) => {
        run();
        return 0;
      },
      clearTimer: () => {},
      onLog: (line) => lines.push(line),
    });
    const pause = log.slice(-1);
    for (let look = 0; look <= AUTO_RESUMES_MAX; look++) {
      service.observe(THREAD, pause);
      await service.idle();
    }
    assert.equal(attempts, AUTO_RESUMES_MAX);
    assert.ok(lines.some((line) => line.includes("the loop refused")));
  });
});

describe("AutoResumeService: a waiting resume keeps the Mac awake until it is resumed or dropped", () => {
  /** A limit pause the service has looked at once and now waits on (the reset is half an hour away). */
  async function waitingOnReset(h: ReturnType<typeof harness>) {
    h.append(limitPause(PAUSED_AT, rateLimit));
    await h.advance(PAUSED_AT);
  }

  it("a limit pause holds from the first look until the resume, once each way", async () => {
    const h = harness();
    await waitingOnReset(h);
    assert.deepEqual(h.pendingChanges, [true], "the wait for the reset is held, not left to idle sleep");
    assert.equal(h.service.nextResumeAt(), DUE, "the planned time is the reset plus the margin");
    for (let at = PAUSED_AT; at < DUE; at += AUTO_RESUME_RECHECK_MAX_MS) await h.advance(at);
    assert.deepEqual(h.pendingChanges, [true], "the bounded steps towards the reset do not flap the hold");
    await h.advance(DUE);
    assert.deepEqual(h.resumed, [RUN]);
    assert.deepEqual(h.pendingChanges, [true, false], "released once the resume is dispatched");
    assert.equal(h.service.nextResumeAt(), null);
  });

  const drops: Array<{ name: string; drop: (h: ReturnType<typeof harness>) => void | Promise<void> }> = [
    { name: "the user's Stop", drop: (h) => h.service.userStopped(THREAD) },
    { name: "the user's stop of the run", drop: (h) => h.service.userStoppedRun(RUN) },
    { name: "the user's own Resume", drop: (h) => h.service.cancelRun(RUN) },
    { name: "the run starting again", drop: (h) => h.append([resumedStart(PAUSED_AT + MINUTE_MS)]) },
    { name: "the core stopping", drop: (h) => h.service.dispose() },
    {
      name: "the switch turned off before the resume is due",
      drop: async (h) => {
        h.setEnabled(false);
        await h.advance(DUE);
      },
    },
    {
      name: "a look that throws",
      drop: async (h) => {
        h.failEvents();
        await h.advance(DUE);
      },
    },
  ];
  for (const { name, drop } of drops) {
    it(`${name} releases the hold`, async () => {
      const h = harness();
      await waitingOnReset(h);
      await drop(h);
      assert.deepEqual(h.pendingChanges, [true, false]);
      assert.equal(h.service.nextResumeAt(), null);
      assert.deepEqual(h.resumed, []);
    });
  }

  it("a pause that never resumes on its own (the user's Stop) holds nothing", async () => {
    const h = harness();
    h.append(plainPause(PAUSED_AT));
    await h.advance(DUE);
    assert.deepEqual(h.pendingChanges, []);
    assert.equal(h.service.nextResumeAt(), null);
  });

  it("a crash pause waiting for the loop is held until it resumes", async () => {
    const h = harness({ ready: false });
    h.service.noteCrash([RUN]);
    h.append(plainPause(PAUSED_AT));
    await h.advance(PAUSED_AT);
    assert.deepEqual(h.pendingChanges, [true]);
    h.setReady(true);
    await h.advance(PAUSED_AT + AUTO_RESUME_RECHECK_MS);
    assert.deepEqual([h.resumed, h.pendingChanges], [[RUN], [true, false]]);
  });

  it("a listener that throws does not stop the plan", async () => {
    let calls = 0;
    const lines: string[] = [];
    let now = PAUSED_AT;
    const timers: Array<{ at: number; run: () => void }> = [];
    const log = [registered(), ...limitPause(PAUSED_AT, rateLimit)];
    const service = new AutoResumeService({
      enabled: () => true,
      harnessReady: () => true,
      freeMb: async () => 8_000,
      events: async () => log,
      record: async () => {},
      resume: async () => {
        calls++;
      },
      now: () => now,
      setTimer: (run, ms) => timers.push({ at: now + ms, run }),
      clearTimer: () => {},
      onPendingChange: () => {
        throw new Error("the blocker refused");
      },
      onLog: (line) => lines.push(line),
    });
    service.observe(THREAD, log.slice(-1));
    while (calls === 0 && timers.length > 0) {
      const next = timers.shift();
      if (!next) break;
      now = Math.max(now, next.at);
      next.run();
      await service.idle();
    }
    assert.equal(calls, 1, "the resume still happens");
    assert.ok(lines.some((line) => line.includes("the blocker refused")));
  });
});

describe("run_auto_resumed where people read it", () => {
  const record = (cause: string) => [
    registered(),
    ...limitPause(PAUSED_AT, rateLimit),
    custom(DUE, CustomEvent.RunAutoResumed, { runId: RUN, project: "kart", cause, attempt: 1 }),
  ];
  const texts = (events: EventEnvelope[]) =>
    toEntries(events).flatMap((entry) =>
      "rows" in entry ? entry.rows.map((row) => ("text" in row ? row.text : "")) : "text" in entry ? [entry.text] : [],
    );

  it("the chat says why the build resumed, in plain words", () => {
    assert.ok(texts(record(AutoResumeCause.LimitReset)).includes("Resumed automatically after the limit reset"));
    assert.ok(
      texts(record(AutoResumeCause.LoopRestart)).includes("Resumed automatically after Studio’s loop restarted"),
    );
    assert.ok(texts(record("something-new")).includes("Resumed automatically"), "an unknown cause still reads");
  });

  it("Activity lists the automatic resume beside the run", () => {
    // The core serves Activity from its incremental index, never from the whole log.
    const index = new ActivityIndex();
    assert.ok(index.append(record(AutoResumeCause.LimitReset)));
    const item = index.items().find((i) => i.kind === "recovery");
    assert.deepEqual(item && { title: item.title, detail: item.detail, runId: item.runId, project: item.project }, {
      title: "Resumed a build automatically",
      detail: "The limit reset.",
      runId: RUN,
      project: "kart",
    });
  });
});

describe("the core: the switch, its default, and who may write the record", () => {
  it("Resume builds automatically is on by default and a choice survives a restart", async () => {
    const lite = await coreLite();
    assert.equal(lite.core.settings.autoResume, true);
    const off = await lite.core.updateSettings({ autoResume: false });
    assert.equal(off.autoResume, false);
    await lite.core.stop();
    await lite.core.init();
    assert.equal(lite.core.settings.autoResume, false, "the choice persists");
    await lite.close();
  });

  it("the harness cannot write run_auto_resumed: the count that bounds resumes is the host's", async () => {
    const lite = await coreLite();
    const threadId = await lite.core.store.createThread({ title: "game" });
    await assert.rejects(
      lite.api()["events.append"]!({
        threadId,
        batch: [{ type: EventKind.Custom, event_type: CustomEvent.RunAutoResumed, payload: { runId: RUN } }],
      } as never),
      /written by the studio only/,
    );
    assert.equal(
      (await lite.core.store.listEvents(threadId)).filter((e) => e.data.type === EventKind.Custom).length,
      0,
      "nothing of the batch was written",
    );
    await lite.close();
  });

  it("a limit pause the harness appends is planned for the reset, and not at all when switched off", async () => {
    const delays: number[] = [];
    const lite = await coreLite({
      autoResume: {
        // The store dates records by the real clock, so the fake one follows it.
        now: () => Date.now(),
        setTimer: (run, ms) => {
          delays.push(ms);
          if (ms === 0) run();
          return delays.length;
        },
        clearTimer: () => {},
        freeMb: async () => 8_000,
      },
    });
    const threadId = await lite.core.store.createThread({ title: "game" });
    const append = (batch: unknown[]) => lite.api()["events.append"]!({ threadId, batch } as never);
    const registration = { runId: RUN, budgets: { wallClockMs: 4 * HOUR_MS } };
    await append([{ type: EventKind.Custom, event_type: CustomEvent.RunRegistered, payload: registration }]);
    await append(limitPause(PAUSED_AT, rateLimit).map((e) => e.data));
    for (let i = 0; i < SETTLE_TRIES && delays.length < 2; i++) await sleep(SETTLE_STEP_MS);
    assert.equal(delays[0], 0, "the pause is planned at once");
    // The reset is half an hour away: the core waits for it in bounded steps, not at once.
    assert.equal(delays[1], AUTO_RESUME_RECHECK_MAX_MS, "the resume waits for the reset, a bounded step at a time");

    delays.length = 0;
    await lite.core.updateSettings({ autoResume: false });
    await append([
      { type: EventKind.Custom, event_type: CustomEvent.RunRegistered, payload: { ...registration, resumed: true } },
    ]);
    await append(limitPause(PAUSED_AT, rateLimit).map((e) => e.data));
    for (let i = 0; i < SETTLE_TRIES; i++) await sleep(SETTLE_STEP_MS);
    assert.deepEqual(delays, [0], "looked at, and nothing planned");
    await lite.close();
  });

  it("a resume waiting on a reset is announced to the app, which holds the Mac awake until the core stops", async () => {
    const pending: boolean[] = [];
    const lite = await coreLite({
      autoResume: {
        now: () => Date.now(),
        setTimer: (run, ms) => {
          if (ms === 0) run();
          return 1;
        },
        clearTimer: () => {},
        freeMb: async () => 8_000,
      },
      onAutoResumePending: (value) => pending.push(value),
    });
    const threadId = await lite.core.store.createThread({ title: "game" });
    const append = (batch: unknown[]) => lite.api()["events.append"]!({ threadId, batch } as never);
    const now = Date.now();
    await append([
      {
        type: EventKind.Custom,
        event_type: CustomEvent.RunRegistered,
        payload: { runId: RUN, budgets: { wallClockMs: 4 * HOUR_MS } },
      },
    ]);
    await append(limitPause(now, { ...rateLimit, at: now }).map((e) => e.data));
    for (let i = 0; i < SETTLE_TRIES && pending.length === 0; i++) await sleep(SETTLE_STEP_MS);
    assert.deepEqual(pending, [true], "the wait for the reset is held");
    assert.equal(lite.core.autoResumeAt, now + RESET_MS + LIMIT_RESET_MARGIN_MS, "a quit can name the time");
    await lite.close();
    assert.deepEqual(pending, [true, false], "the core stopping releases it");
  });

  it("a stop asked through the run controls (not the chat's Stop) holds the run back too", async () => {
    const delays: number[] = [];
    const lite = await coreLite({
      autoResume: {
        now: () => Date.now(),
        setTimer: (run, ms) => {
          delays.push(ms);
          if (ms === 0) run();
          return delays.length;
        },
        clearTimer: () => {},
        freeMb: async () => 8_000,
      },
    });
    const threadId = await lite.core.store.createThread({ title: "game" });
    const append = (batch: unknown[]) => lite.api()["events.append"]!({ threadId, batch } as never);
    const registration = { runId: RUN, budgets: { wallClockMs: 4 * HOUR_MS } };
    await append([{ type: EventKind.Custom, event_type: CustomEvent.RunRegistered, payload: registration }]);
    // No loop runs in core-lite, so the stop's dispatch fails; the user's word is kept all the same.
    await lite.core.stopRun(RUN, MINUTE_MS).catch(() => {});
    await append(limitPause(PAUSED_AT, rateLimit).map((e) => e.data));
    for (let i = 0; i < SETTLE_TRIES; i++) await sleep(SETTLE_STEP_MS);
    assert.deepEqual(delays, [0], "looked at, and nothing planned");
    await lite.close();
  });
});

describe("an engine's own limit, from its error to the planned resume", () => {
  /** A signed-in Codex engine whose `codex exec` fails its turn with `message`. */
  async function codexFailing(message: string): Promise<{ engine: CodexEngine; cwd: string }> {
    const root = await tmpDir("studio-codex-limit-");
    const home = path.join(root, "codex-home");
    const cwd = path.join(root, "game");
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(home, "auth.json"), "{}");
    const execFn: CodexExec = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "thread.started", thread_id: "t" };
        yield { type: "turn.failed", error: { message } };
      },
    });
    const engine = new CodexEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "no-system-login"),
      executable: "/fake/codex",
      authStatusFn: async () => ({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" }),
      execFn,
    });
    return { engine, cwd };
  }

  it("a Codex usage limit that names its wait is resumed after it", async () => {
    const { engine, cwd } = await codexFailing(
      "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 1 hour 30 minutes.",
    );
    const err = await engine.delegate({ prompt: "build", cwd }).then(
      () => assert.fail("a limit is an error"),
      (e: unknown) => e,
    );
    // The close the harness writes keeps the limit as the seed's engineLimitOf reads it.
    const limit = engineLimitOf(err, PAUSED_AT);
    const events = [registered(), ...limitPause(PAUSED_AT, { ...limit })];
    const due = PAUSED_AT + 90 * MINUTE_MS + LIMIT_RESET_MARGIN_MS;
    assert.deepEqual(autoResumePlan(events, PAUSED_AT + MINUTE_MS, facts()), {
      action: AutoResumeAction.Wait,
      at: due,
      hold: AutoResumeHold.Reset,
    });
    assert.deepEqual(autoResumePlan(events, due, facts()), {
      action: AutoResumeAction.Resume,
      cause: AutoResumeCause.LimitReset,
      attempt: 1,
    });
  });

  /**
   * "Your organization has disabled Claude subscription access…", in a `success`-subtype result
   * flagged `is_error`. No reset ends that: the pause waits for the user.
   */
  it("an account whose access was taken away pauses for the user, never for a reset", async () => {
    const disabled =
      "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";
    const root = await tmpDir("studio-claude-access-");
    const home = path.join(root, "claude-home");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".credentials.json"), "{}");
    const stream = [
      { type: "system", subtype: "init", model: "claude-opus-5-5", session_id: "ses_lead", tools: [] },
      { type: "assistant", message: { content: [{ type: "text", text: disabled }] }, parent_tool_use_id: null },
      { type: "result", subtype: "success", is_error: true, num_turns: 5, total_cost_usd: 15.9, result: disabled },
    ];
    const claude = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "no-system-login"),
      queryFn: (() => ({
        async *[Symbol.asyncIterator]() {
          for (const message of stream) yield message;
        },
      })) as never,
    });
    const codex = await codexFailing("Your workspace has disabled Codex access for this account");
    for (const [name, engine, cwd] of [
      ["claude-code", claude, root],
      ["codex", codex.engine, codex.cwd],
    ] as const) {
      const err = await engine.delegate({ prompt: "build", cwd }).then(
        () => assert.fail(`${name}: a lost account is an error`),
        (e: unknown) => e,
      );
      const limit = engineLimitOf(err, PAUSED_AT);
      assert.equal(limit.kind, EngineFailureKind.Auth, `${name}: ${limit.message}`);
      const events = [registered(), ...limitPause(PAUSED_AT, { ...limit })];
      assert.deepEqual(autoResumePlan(events, PAUSED_AT + 3 * HOUR_MS, facts()), {
        action: AutoResumeAction.None,
        skip: AutoResumeSkip.AccessLost,
      });
    }
  });
});

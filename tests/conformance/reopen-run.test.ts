/**
 * A finished build reopened by the chat's own session (loop/reopen-run.ts): after a build its lead
 * led as the chat's own session has finished, a message with Loop on that asks for more work reopens
 * the SAME run with the Loop's working time, once the session's reply has ended. What the Loop's time
 * is, which messages keep their commission, the run a reopen registers, and the reopen itself — its
 * order, its refusals and its Stop — without a rig; the rig run is director-one-session.test.ts S11.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  commissionHours,
  finishedLoopRun,
  keepsCommission,
  loopBudgets,
  reopenAfterReply,
  reopenBudgets,
  reopenedRun,
  reopens,
  servesReopen,
} from "../../src/harness-seed/loop/reopen-run.ts";
import { coordinatorReopens, handleUserMessage, intakeBudgets } from "../../src/harness-seed/loop/chat-dispatch.ts";
import { coordinatorPrompt } from "../../src/harness-seed/loop/coordinator-prompts.ts";
import * as coordinator from "../../src/harness-seed/loop/coordinator.ts";
import * as coordinatorPrompts from "../../src/harness-seed/loop/coordinator-prompts.ts";
import { steersInto } from "../../src/harness-seed/loop/message-queue.ts";
import { tools as gameTools } from "../../src/harness-seed/tools/game-tools.ts";
import * as afterLoopRunPrompts from "../../src/harness-seed/loop/after-loop-run-prompts.ts";
import * as delegatedTurn from "../../src/harness-seed/loop/delegated-turn.ts";
import * as runDispatch from "../../src/harness-seed/loop/run-dispatch.ts";
import * as turnLoop from "../../src/harness-seed/loop/turn-loop.ts";
import { HOUR_MS } from "../../src/harness-seed/loop/time.ts";
import { plannerModel } from "../../src/harness-seed/loop/model-roles.ts";
import { CompletionPolicy } from "../../src/harness-seed/loop/completion-policy.ts";

const RUN = "run_reopen";
const THREAD = "thread_reopen";
/** The head the finished build's close named. */
const H1 = "a".repeat(40);

/** A record the fake host keeps and answers — a journal, a payload, a call's params — read as the harness reads it. */
// biome-ignore lint/suspicious/noExplicitAny: JSON the fake host keeps, read back without a schema as the harness reads it
type Json = Record<string, any>;

/** One record of a thread's log, as the host keeps it. */
type Logged = { type: string; event_type?: string; message?: string; payload?: Json; messages?: Json[] };
type Entry = { id: string; data: Logged };

/** A custom record of the log. */
const custom = (id: string, event_type: string, payload: Record<string, unknown>): Entry => ({
  id,
  data: { type: "custom", event_type, payload },
});

/** The run as its launch registered it. */
const launched = {
  runId: RUN,
  project: "plaza",
  goal: "a dusk plaza",
  engine: "codex",
  mode: "autopilot" as const,
  reference: { name: "plaza", shots: [] },
  roles: { planner: "gpt-5.6-sol", builder: "gpt-5.6-sol", judge: "gpt-5.6-sol" },
  rolesApplied: true,
  budgets: { wallClockMs: HOUR_MS, review: false },
};

/** The log of a build that ran and finished, its close naming the head it stood on. */
const finishedLog = (): Entry[] => [
  custom("e1", "run_registered", { ...launched, resumed: false }),
  custom("e2", "run_finished", { runId: RUN, project: "plaza", landed: true, integrationHead: H1 }),
];

/** The finished run's journal: its lead the chat's own session, its clock spent, asked what next. */
const finishedJournal = (): Json => ({
  phase: "done",
  run: { ...launched, readiness: { contract: "loaded", problems: [] } },
  director: {
    lead: { chatSession: true },
    sessionId: "chat-1",
    clock: { workedMs: HOUR_MS },
    wake: { idleAsked: true, wakesAt: [] },
    integrationHealthy: true,
    integrationHead: H1,
    baseCommit: "b".repeat(40),
    workers: { sky: { id: "sky", state: "done" } },
    plan: { summary: "a dusk sky" },
  },
});

/** The finished run the chat's own session answers after, as chat-dispatch.ts hands it on. */
const loopRun = {
  runId: RUN,
  state: "finished",
  goal: "a dusk plaza",
  landed: true,
  stoppedBecause: null,
  engine: "codex",
  model: "gpt-5.6-sol",
  messageId: "m9",
  reopenable: true,
};

/** What a reopen is asked with: the session's words for the build, the Loop's hours, the message's words. */
const ask = {
  hours: 2,
  text: "add enemies",
  words: "please add some enemies to the plaza",
  models: { model: "gpt-5.6-sol" },
};

/** A loop whose host keeps `log` and the run's journal, and records every call. */
function studioWith({ log = finishedLog(), journal = finishedJournal() as Json | null } = {}) {
  const calls: Array<{ method: string; params: Json }> = [];
  const notified: Array<{ method: string; payload: unknown }> = [];
  const store = { journal };
  const host = {
    workspace: "/nonexistent",
    notify: (method: string, payload: unknown) => void notified.push({ method, payload }),
    call: async (method: string, params: Json): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "events.list") return [...log];
      if (method === "artifact.read") return params.artifactId === `autopilot_${RUN}` ? store.journal : null;
      if (method === "artifact.write") {
        store.journal = params.value;
        return true;
      }
      if (method === "events.append") for (const data of params.batch) log.push({ id: `e${log.length + 1}`, data });
      return null;
    },
  };
  const studio = {
    host,
    cancels: new Set<string>(),
    moodBoards: new Map<string, unknown[]>([[THREAD, [{ data: "still" }]]]),
    activeRuns: new Map<string, Json>(),
    startingRuns: new Map<string, Json>(),
    orphanRuns: new Map<string, string>(),
    scoped: () => {
      throw new Error("no ctx here");
    },
  };
  /** The chat's ctx: its thread, stopped by the composer's Stop. */
  const ctx = {
    threadId: THREAD,
    get cancelled() {
      return studio.cancels.has(THREAD);
    },
  };
  const starts: Array<{ run: Json; reopen: unknown }> = [];
  const start = async (run: Json, reopen: unknown): Promise<void> => {
    starts.push({ run, reopen });
  };
  return { studio, ctx, host, calls, notified, store, log, starts, start };
}

/** 21:00 UTC on the run of the reopen. */
const NOW = Date.parse("2026-09-29T21:00:00Z");
const clock = () => NOW;

/** What the chat was told: its errors and its assistant words, in order. */
function toldOf(calls: Array<{ method: string; params: Json }>): Array<{ type: string; words: string }> {
  return calls
    .filter((c) => c.method === "events.append")
    .flatMap((c) => c.params.batch as Logged[])
    .filter((data) => data.type === "error" || data.type === "messages")
    .map((data) => ({
      type: data.type,
      words: data.type === "error" ? String(data.message) : String(data.messages?.[0]?.content),
    }));
}

/** The steers recorded on the run. */
const steersOf = (log: readonly Entry[]) =>
  log.filter((entry) => entry.data.event_type === "run_steering").map((entry) => entry.data.payload);

describe("the Loop's working time for a reopened build", () => {
  it("R1. the Loop's hours give a reopened build the working time a launch gives, as a ceiling on its ask; the run's other knobs are kept", async () => {
    const launch = gameTools.find((tool) => tool.name === "start_autopilot");
    assert.ok(launch);
    /** What a launch with this Loop would be given (start_autopilot, then chat-dispatch.ts intakeBudgets). */
    const launchedWith = async (hours: number | null) => {
      const autopilot = { frames: [], ...(hours === null ? {} : { hours }) };
      const outcome = await launch.execute({ goal: "a dusk plaza", direction: "dusk" }, {
        engine: "codex",
        autopilot,
      } as never);
      return intakeBudgets((outcome as { details: { run: Record<string, unknown> } }).details.run);
    };
    for (const hours of [0.1, 0.5, 3, 24, 30, null, 0, -2, Number.NaN])
      assert.deepEqual(loopBudgets(hours), await launchedWith(hours), `hours ${hours}`);

    // A reopened build has an ask to finish, not hours to spend: the new Loop's hours are its
    // ceiling, whatever policy the finished build had (golden-boot-glory).
    const saved = {
      wallClockMs: 24 * HOUR_MS,
      untilSatisfied: true,
      completionPolicy: CompletionPolicy.Goal,
      review: false,
      maxIterations: 9,
    };
    assert.deepEqual(reopenBudgets(saved, 2), {
      review: false,
      maxIterations: 9,
      wallClockMs: 2 * HOUR_MS,
      completionPolicy: CompletionPolicy.Goal,
    });
    const timed = { wallClockMs: HOUR_MS, completionPolicy: CompletionPolicy.Duration, review: false };
    assert.deepEqual(reopenBudgets(timed, null), {
      review: false,
      wallClockMs: 24 * HOUR_MS,
      completionPolicy: CompletionPolicy.Goal,
      untilSatisfied: true,
    });
    assert.deepEqual(reopenBudgets(undefined, 1), {
      wallClockMs: HOUR_MS,
      completionPolicy: CompletionPolicy.Goal,
    });
  });
});

describe("which messages and runs a reopen is for", () => {
  it("R2. a routed message keeps its commission for no run or a finished build the chat may reopen; the reopen is offered only then", () => {
    const finished = { ...loopRun };
    const notMarked = { ...loopRun, reopenable: undefined };
    const paused = { ...loopRun, state: "paused" };
    const rows = [
      { label: "no run yet", existing: null, after: null, keeps: true },
      { label: "a finished build the chat may reopen", existing: launched, after: finished, keeps: true },
      { label: "a finished build a kept part does not serve", existing: launched, after: notMarked, keeps: false },
      { label: "a paused build", existing: launched, after: paused, keeps: false },
      { label: "the coordinator's (no lead of the chat's own)", existing: launched, after: null, keeps: false },
    ];
    assert.deepEqual(
      rows.map(({ label, existing, after }) => ({ label, keeps: keepsCommission(existing, after as never) })),
      rows.map(({ label, keeps }) => ({ label, keeps })),
    );
    const loop = { hours: 2 };
    assert.equal(reopens(finished as never, loop), true);
    assert.equal(reopens(finished as never, null), false, "Loop off: the session does the work itself");
    assert.equal(reopens(notMarked as never, loop), false);
    assert.equal(reopens(paused as never, loop), false, "a paused build resumes");
    assert.equal(reopens(undefined, loop), false, "a chat with no run behind it launches");

    assert.deepEqual(
      [2, 0.5, 0, -1, Number.NaN, "2", undefined].map((hours) => commissionHours({ hours })),
      [2, 0.5, null, null, null, null, null],
    );
    assert.equal(commissionHours(null), null);

    const parts = [turnLoop, delegatedTurn, afterLoopRunPrompts, runDispatch];
    assert.equal(servesReopen(parts), true);
    assert.equal(
      servesReopen([turnLoop, delegatedTurn, { afterLoopRunNote: afterLoopRunPrompts.afterLoopRunNote }]),
      false,
    );
    assert.equal(servesReopen([{ ...runDispatch, SERVES_REOPEN: "yes" }]), false);
  });

  it("R3. the run a reopen registers: the Loop's budgets, its builders and judges resolved from the message's picks as a launch resolves them, planned on the model the session answers on, the launch's readiness dropped", () => {
    const saved = {
      ...launched,
      model: "gpt-5.6-sol",
      judgeEngine: "codex",
      judgeModel: "gpt-5.6-sol",
      effort: "high",
      preferences: { fast: true },
      readiness: { contract: "loaded", problems: [] },
    };
    const budgets = { wallClockMs: 2 * HOUR_MS, review: false };
    const run = reopenedRun(saved, budgets, { model: "gpt-5.6-terra" });
    assert.equal(run.runId, RUN, "the same run");
    assert.deepEqual(run.budgets, budgets);
    // Flipped (was: the finished builders and judges kept, only the planner replaced): a message on
    // another model builds and judges on it too, as a launch from that message would.
    assert.deepEqual(run.roles, { planner: "gpt-5.6-terra", builder: "gpt-5.6-terra", judge: "gpt-5.6-terra" });
    assert.deepEqual([run.model, run.judgeModel, run.judgeEngine], ["gpt-5.6-terra", "gpt-5.6-terra", "codex"]);
    assert.equal(
      "effort" in run || "preferences" in run,
      false,
      "a message that names none keeps none of the finished",
    );
    assert.equal("readiness" in run, false, "the folder is asked again, not the launch's answer");
    assert.equal(run.rolesApplied, true, "resolved once, here: the run's start does not resolve it again");

    // The roles page: workers on the other subscription, other judges, per-role efforts, the effort and preferences.
    const picked = reopenedRun(saved, budgets, {
      model: "gpt-5.6-terra",
      roles: {
        planner: "gpt-5.6-terra",
        builder: "opus",
        judge: "gpt-5.6-luna",
        engines: { builder: "claude-code" },
        efforts: { builder: "high" },
      },
      effort: "medium",
      preferences: { fast: true },
    });
    assert.deepEqual(
      {
        planner: picked.roles?.planner,
        model: picked.model,
        builderEngine: picked.builderEngine,
        judgeEngine: picked.judgeEngine,
        judgeModel: picked.judgeModel,
        efforts: picked.roles?.efforts,
        effort: picked.effort,
        preferences: picked.preferences,
      },
      {
        planner: "gpt-5.6-terra",
        model: "opus",
        builderEngine: "claude-code",
        judgeEngine: "codex",
        judgeModel: "gpt-5.6-luna",
        efforts: { builder: "high" },
        effort: "medium",
        preferences: { fast: true },
      },
    );

    // Flipped (was: roles are never invented): a run from before roles resolves as a launch does.
    const { roles: _roles, ...noRoles } = saved;
    assert.deepEqual(reopenedRun(noRoles, budgets, { model: "gpt-5.6-terra" }).roles, run.roles);
    const unnamed = reopenedRun(saved, budgets, { model: null });
    assert.equal(unnamed.roles?.planner, launched.roles.planner, "no model named: the planner stays");
    assert.equal("model" in unnamed, false, "and the builders take the engine's own default, as a launch with none");
    // Neither names a planner: the engine's default leads, never the builders' model in its place.
    const plannerless = { ...saved, roles: { planner: undefined, builder: undefined, judge: undefined } };
    const lead = reopenedRun(plannerless, budgets, { model: null, roles: { builder: "gpt-5.6-sol" } });
    assert.equal(plannerModel(lead), "default");
  });
});

describe("a finished build the run's coordinator answers for", () => {
  it("R12. its continue_build may reopen a finished run that seated a lead, with the build's own models; the coordinator is told the Loop only when its parts serve it", async () => {
    const hostWith = (journal: Json | null) => ({
      call: async (method: string, params: Json) =>
        method === "artifact.read" && params.artifactId === `autopilot_${RUN}` ? journal : null,
    });
    const finished = { ...launched, state: "finished", landed: true };
    const rows: Array<{ label: string; run: Json; journal: Json | null; reopens: boolean }> = [
      {
        label: "a lead of its own",
        run: finished,
        journal: { director: { lead: { chatSession: false } } },
        reopens: true,
      },
      {
        label: "the chat's own session",
        run: finished,
        journal: { director: { lead: { chatSession: true } } },
        reopens: true,
      },
      {
        label: "a paused run",
        run: { ...finished, state: "paused" },
        journal: { director: { lead: { chatSession: false } } },
        reopens: false,
      },
      { label: "no journal", run: finished, journal: null, reopens: false },
      {
        label: "the classic pipeline (no director)",
        run: finished,
        journal: { phase: "done", facets: {} },
        reopens: false,
      },
      {
        label: "the long turn (no lead seated)",
        run: finished,
        journal: { director: { sessionId: "d-1" } },
        reopens: false,
      },
      { label: "a lead record that is not one", run: finished, journal: { director: { lead: null } }, reopens: false },
    ];
    for (const row of rows) {
      const loopRun = await finishedLoopRun(hostWith(row.journal), THREAD, row.run, "m9");
      assert.equal(loopRun !== null, row.reopens, row.label);
      if (loopRun)
        assert.deepEqual(
          {
            engine: loopRun.engine,
            model: loopRun.model,
            messageId: loopRun.messageId,
            reopenable: loopRun.reopenable,
          },
          { engine: "codex", model: null, messageId: "m9", reopenable: true },
          `${row.label}: the build's own models, the message it answers`,
        );
    }

    const prompt = (reopen: { hours: number | null } | null) =>
      coordinatorPrompt({
        events: [],
        run: launched,
        text: "add enemies",
        journal: null,
        savedPlan: null,
        history: "",
        reopen,
      });
    assert.match(prompt({ hours: 2 }), /Loop is on[\s\S]*continue_build reopens it[\s\S]*up to 2 h/);
    assert.match(prompt({ hours: null }), /until its judges are satisfied/);
    assert.doesNotMatch(prompt(null), /Loop is on/, "no Loop, no reopen: continue_build hands the work to a builder");

    assert.equal(coordinatorReopens(), true);
    assert.equal(servesReopen([coordinator, { ...coordinatorPrompts, SERVES_REOPEN: undefined }, runDispatch]), false);
  });
});

describe("reopening the finished build once the reply has ended", () => {
  it("R4. the journal reopened, the ask recorded on the run, the chat told, then the same run started from the ask on", async () => {
    const { studio, ctx, calls, store, log, starts, start } = studioWith();
    await reopenAfterReply(studio as never, ctx, loopRun as never, ask, start, clock);

    assert.deepEqual(
      calls.map((c) => c.method),
      ["artifact.read", "events.list", "artifact.write", "events.append", "events.append"],
    );
    const journal = store.journal as Json;
    assert.equal(journal.phase, "done", "the run rewrites its phase when it starts");
    assert.deepEqual(journal.run.budgets, {
      review: false,
      wallClockMs: 2 * HOUR_MS,
      completionPolicy: CompletionPolicy.Goal,
    });
    assert.equal(journal.run.roles.planner, "gpt-5.6-sol", "planned on the model the session answers on");
    assert.deepEqual(journal.run.asks, ["add enemies"], "its judges read the ask ahead of the commission");
    assert.equal(journal.run.goal, "a dusk plaza", "the commission stays what the Builds graph shows");
    assert.equal("readiness" in journal.run, false);
    for (const dropped of ["clock", "wake", "integrationHealthy"])
      assert.equal(dropped in journal.director, false, `${dropped} starts afresh`);
    assert.deepEqual(journal.director.reopened, { at: new Date(NOW).toISOString(), finishedHead: H1 });
    assert.equal(journal.director.integrationHead, H1);
    assert.deepEqual(journal.director.workers, finishedJournal().director.workers, "its workers go on");

    assert.deepEqual(steersOf(log), [
      { runId: RUN, text: "add enemies", sourceMessageId: "m9", at: new Date(NOW).toISOString() },
    ]);
    const told = toldOf(calls);
    assert.equal(told.length, 1);
    assert.equal(told[0]?.type, "messages");
    assert.match(
      String(told[0]?.words),
      /The build goes on until your request is checked, by about .+ at the latest — keep the app open and the Mac awake\./,
    );

    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.run.runId, RUN);
    assert.deepEqual(starts[0]?.run.budgets, journal.run.budgets);
    assert.deepEqual(starts[0]?.reopen, { after: "e2" }, "the run hears from the ask on: the last record before it");
    assert.equal(studio.moodBoards.has(THREAD), false, "the chat's mood board did its job");
  });

  it("R4b. Loop ∞: until its critics are satisfied, under the day's ceiling; no words from the session, the message's", async () => {
    const unbounded = studioWith();
    await reopenAfterReply(
      unbounded.studio as never,
      unbounded.ctx,
      loopRun as never,
      { hours: null, words: " more  ", models: { model: "gpt-5.6-sol" } },
      unbounded.start,
      clock,
    );
    assert.deepEqual(unbounded.starts[0]?.run.budgets, {
      review: false,
      wallClockMs: 24 * HOUR_MS,
      completionPolicy: CompletionPolicy.Goal,
      untilSatisfied: true,
    });
    assert.deepEqual(
      steersOf(unbounded.log).map((steer) => steer?.text),
      ["more"],
    );
    assert.match(String(toldOf(unbounded.calls)[0]?.words), /until its critics are satisfied/);
  });

  it("R4c. the reopening message joins the user's words in the build's scope, once; a build without scope gets none, and words the log does not have change nothing", async () => {
    const { createScope } = await import("../../src/harness-seed/loop/scope.ts");
    const scope = createScope({ asked: ["a dusk plaza"], inScope: ["the plaza"], cut: ["a city"] });
    const userSaid = (words: string): Entry => ({
      id: "e3",
      data: { type: "messages", messages: [{ role: "user", content: words }] },
    });
    const scoped = (): Json => ({ ...finishedJournal(), run: { ...finishedJournal().run, scope } });

    const s = studioWith({ log: [...finishedLog(), userSaid(ask.words)], journal: scoped() });
    await reopenAfterReply(s.studio as never, s.ctx, loopRun as never, ask, s.start, clock);
    const reopened = s.starts[0]?.run.scope;
    assert.deepEqual(reopened?.asked, ["a dusk plaza", ask.words], "the user's message, not the session's words");
    assert.deepEqual(reopened?.inScope, ["the plaza"]);
    assert.deepEqual(reopened?.cut, ["a city"]);
    assert.deepEqual((s.store.journal as Json).run.scope, reopened, "the journal keeps it for the next Resume");

    const replayed = studioWith({ log: [...finishedLog(), userSaid(ask.words)], journal: s.store.journal });
    (replayed.store.journal as Json).phase = "done";
    await reopenAfterReply(replayed.studio as never, replayed.ctx, loopRun as never, ask, replayed.start, clock);
    assert.deepEqual(replayed.starts[0]?.run.scope, reopened, "a replayed message adds nothing twice");

    const unlogged = studioWith({ journal: scoped() });
    await reopenAfterReply(unlogged.studio as never, unlogged.ctx, loopRun as never, ask, unlogged.start, clock);
    assert.deepEqual(unlogged.starts[0]?.run.scope, scope, "words the log does not have are not the user's");

    const legacy = studioWith({ log: [...finishedLog(), userSaid(ask.words)] });
    await reopenAfterReply(legacy.studio as never, legacy.ctx, loopRun as never, ask, legacy.start, clock);
    assert.equal("scope" in (legacy.starts[0]?.run ?? {}), false, "a build from before scope stays without one");
  });

  it("R4d. a reopening message the user edited in the queue joins the scope as edited; a command's result never proves words the user's", async () => {
    const { createScope } = await import("../../src/harness-seed/loop/scope.ts");
    const scope = createScope({ asked: ["a dusk plaza"], inScope: ["the plaza"], cut: ["a city"] });
    const scoped = (): Json => ({ ...finishedJournal(), run: { ...finishedJournal().run, scope } });
    const queuedAs = (id: string, words: string, action: Json): Entry[] => [
      { id, data: { type: "messages", messages: [{ role: "user", content: words }] } },
      custom(`${id}q`, "coordinator_message_queued", { messageId: `m_${id}`, action: { text: words, ...action } }),
    ];

    const edited = studioWith({
      log: [
        ...finishedLog(),
        ...queuedAs("e3", "please add some plants to the plaza", {}),
        custom("e4", "coordinator_message_updated", { messageId: "m_e3", text: ask.words }),
      ],
      journal: scoped(),
    });
    await reopenAfterReply(edited.studio as never, edited.ctx, loopRun as never, ask, edited.start, clock);
    assert.deepEqual(
      edited.starts[0]?.run.scope?.asked,
      ["a dusk plaza", ask.words],
      "the words the user sent, edited",
    );

    const reported = studioWith({
      log: [...finishedLog(), ...queuedAs("e3", ask.words, { origin: "command-result" })],
      journal: scoped(),
    });
    await reopenAfterReply(reported.studio as never, reported.ctx, loopRun as never, ask, reported.start, clock);
    assert.deepEqual(reported.starts[0]?.run.scope, scope, "the chat's own report is not the user's words");
  });

  it("R5. refused with nothing written, recorded or started, and one word to the chat: not the latest, not finished, a build under way, no journal, Stop", async () => {
    const rows: Array<{ label: string; set: (s: ReturnType<typeof studioWith>) => void; why: RegExp }> = [
      {
        label: "another run is the chat's latest",
        set: ({ log }) => log.push(custom("e3", "run_registered", { runId: "run_other", project: "plaza" })),
        why: /no longer/,
      },
      {
        label: "the latest is paused",
        set: ({ log }) => {
          log.push(custom("e3", "run_registered", { ...launched, resumed: true }));
          log.push(custom("e4", "autopilot_paused", { runId: RUN }));
        },
        why: /no longer/,
      },
      {
        label: "a build is under way on the game from another chat",
        set: ({ studio }) =>
          studio.activeRuns.set("run_x", {
            run: { runId: "run_x", project: "plaza" },
            threadId: "thread_other",
            done: false,
            settled: new Promise(() => {}),
          }),
        why: /already running for plaza/,
      },
      {
        label: "no journal",
        set: (s) => {
          s.store.journal = null;
        },
        why: /could not be read/,
      },
      {
        label: "a journal without its run",
        set: (s) => {
          s.store.journal = { phase: "done", run: launched };
        },
        why: /could not be read/,
      },
      { label: "Stop pressed", set: ({ studio }) => studio.cancels.add(THREAD), why: /It stays finished/ },
    ];
    for (const { label, set, why } of rows) {
      const s = studioWith();
      set(s);
      const before = s.log.length;
      await reopenAfterReply(s.studio as never, s.ctx, loopRun as never, ask, s.start, clock);
      assert.equal(
        s.calls.some((c) => c.method === "artifact.write"),
        false,
        `${label}: no journal written`,
      );
      assert.equal(s.starts.length, 0, `${label}: nothing started`);
      const told = toldOf(s.calls);
      assert.equal(told.length, 1, `${label}: ${JSON.stringify(told)}`);
      assert.equal(told[0]?.type, "error", label);
      assert.match(String(told[0]?.words), /^The build was not reopened: /, label);
      assert.match(String(told[0]?.words), why, label);
      assert.equal(s.log.length, before + 1, `${label}: only the word was recorded`);
      assert.equal(s.studio.moodBoards.has(THREAD), true, `${label}: the mood board is kept`);
    }
  });

  it("R6. the chat holds until the finished build's learning pass is over; a Stop meanwhile keeps it finished", async () => {
    /** The finished build, still held by its learning pass until `settle`. */
    function learning(s: ReturnType<typeof studioWith>) {
      let settle = () => {};
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      s.studio.activeRuns.set(RUN, { run: { runId: RUN, project: "plaza" }, threadId: THREAD, done: true, settled });
      return () => {
        s.studio.activeRuns.delete(RUN);
        settle();
      };
    }
    const held = studioWith();
    const passOver = learning(held);
    const reopening = reopenAfterReply(held.studio as never, held.ctx, loopRun as never, ask, held.start, clock);
    await sleep(20);
    assert.equal(
      held.calls.some((c) => c.method === "artifact.write"),
      false,
      "nothing is written while the pass runs",
    );
    passOver();
    await reopening;
    assert.equal(held.starts.length, 1, "started once the pass was over");

    const stopped = studioWith();
    const stopOver = learning(stopped);
    const stopping = reopenAfterReply(
      stopped.studio as never,
      stopped.ctx,
      loopRun as never,
      ask,
      stopped.start,
      clock,
    );
    await sleep(20);
    // The composer's Stop ends the pass (live-chat.ts `stopRunsOf`) and stops the chat.
    stopped.studio.cancels.add(THREAD);
    stopOver();
    await stopping;
    assert.equal(
      stopped.calls.some((c) => c.method === "artifact.write"),
      false,
    );
    assert.equal(stopped.starts.length, 0);
    assert.deepEqual(
      toldOf(stopped.calls).map((told) => told.words),
      ["The build was not reopened: Stop came before it started again. It stays finished."],
    );
  });

  it("R7. a reopen rewound away: the log's close says where the build stood, not the journal the withdrawn run left", async () => {
    const withdrawn = finishedJournal();
    withdrawn.phase = "paused";
    withdrawn.director.integrationHead = "c".repeat(40);
    const s = studioWith({ journal: withdrawn });
    await reopenAfterReply(s.studio as never, s.ctx, loopRun as never, ask, s.start, clock);
    assert.equal(s.starts.length, 1, "the log says finished: it reopens");
    const journal = s.store.journal as Json;
    assert.equal(journal.director.integrationHead, H1);
    assert.equal(journal.director.reopened.finishedHead, H1);

    // A close that names no commit leaves the journal's head, and marks none.
    const log = finishedLog();
    log[1] = custom("e2", "run_finished", { runId: RUN, project: "plaza", integrationHead: "$(touch /tmp/x)" });
    const headless = studioWith({ log });
    await reopenAfterReply(headless.studio as never, headless.ctx, loopRun as never, ask, headless.start, clock);
    const kept = headless.store.journal as Json;
    assert.equal(kept.director.integrationHead, H1);
    assert.equal(kept.director.reopened.finishedHead, null);
  });

  it("R8. a replayed message records its ask once, and its run hears it from that ask on; a restated one is recorded anew and heard alone", async () => {
    const log = finishedLog();
    log.push(custom("e3", "run_steering", { runId: RUN, text: "add enemies", sourceMessageId: "m9", at: "earlier" }));
    const s = studioWith({ log });
    await reopenAfterReply(s.studio as never, s.ctx, loopRun as never, ask, s.start, clock);
    assert.deepEqual(
      steersOf(s.log).map((steer) => steer?.text),
      ["add enemies"],
    );
    // Flipped: the cursor was the log's last record (e3, the ask itself), so the run never heard it.
    assert.deepEqual(s.starts[0]?.reopen, { after: "e2" }, "from the record before the ask its first answer recorded");

    const restated = studioWith({ log: [...log] });
    await reopenAfterReply(
      restated.studio as never,
      restated.ctx,
      loopRun as never,
      { ...ask, text: "add enemies and a boss" },
      restated.start,
      clock,
    );
    assert.deepEqual(
      steersOf(restated.log).map((steer) => steer?.text),
      ["add enemies", "add enemies and a boss"],
    );
    assert.deepEqual(restated.starts[0]?.reopen, { after: "e4" }, "the restated ask alone is heard");
  });

  it("R8b. once per close: an ask recorded before a reopened run the restart closed is that run's, so the replay records its own", async () => {
    const log = [
      ...finishedLog(),
      custom("e3", "run_steering", { runId: RUN, text: "add enemies", sourceMessageId: "m9", at: "earlier" }),
      custom("e4", "run_registered", { ...launched, resumed: true }),
      custom("e5", "run_finished", { runId: RUN, project: "plaza", victory: false, stoppedBecause: "crashed" }),
    ];
    const s = studioWith({ log });
    await reopenAfterReply(s.studio as never, s.ctx, loopRun as never, ask, s.start, clock);
    assert.deepEqual(
      steersOf(s.log).map((steer) => steer?.text),
      ["add enemies", "add enemies"],
    );
    assert.deepEqual(s.starts[0]?.reopen, { after: "e5" }, "never back into a run before this close");
  });
});

describe("the chat's message, from the queue to the reopened run (chat-dispatch.ts)", () => {
  /**
   * A chat whose last build its own session led and finished, on a host that keeps the log and the
   * journal. The session records `recorded`; once the chat's turn has ended no game has the build's
   * name, so a run started again throws before it builds and closes.
   */
  function chatAfter(
    journal: Json,
    log: Entry[],
    recorded: Array<Record<string, unknown>>,
    artifacts: Record<string, unknown> = {},
  ) {
    const requests: Array<Json> = [];
    const store = { journal, turnOver: false };
    /** The session's answer: it records `recorded`. */
    const answered = (params: Json) => {
      requests.push(params);
      const summary = "The build goes on with enemies.";
      return {
        ok: true,
        engine: "codex",
        turns: 1,
        usage: {},
        sessionId: "chat-1",
        summary,
        studioToolCalls: recorded,
      };
    };
    const answers: Record<string, (params: Json) => unknown> = {
      "events.list": (params) =>
        params?.after ? log.slice(log.findIndex((entry) => entry.id === params.after) + 1) : [...log],
      "engine.describe": () => [{ id: "codex", kind: "delegated", label: "Codex" }],
      "artifact.read": (params) =>
        params.artifactId === `autopilot_${RUN}` ? store.journal : (artifacts[params.artifactId] ?? null),
      "artifact.write": (params) => {
        if (params.artifactId === `autopilot_${RUN}`) store.journal = params.value;
      },
      "events.append": (params) => {
        for (const data of params.batch) log.push({ id: `e${log.length + 1}`, data });
      },
      "turn.begin": () => ({ turnId: "turn-1" }),
      "turn.end": () => {
        store.turnOver = true;
      },
      "events.messages": () => [{ role: "user", content: "add enemies" }],
      "game.list": () => (store.turnOver ? [] : [{ name: "plaza", title: "Plaza" }]),
      "game.contentStamp": () => ({ all: "same", source: "same" }),
      "engine.delegate": answered,
    };
    const host = {
      workspace: "/nonexistent",
      notify: () => {},
      call: async (method: string, params: Json): Promise<unknown> => answers[method]?.(params) ?? null,
    };
    const studio: Json = {
      host,
      cancels: new Set<string>(),
      moodBoards: new Map(),
      activeRuns: new Map(),
      startingRuns: new Map(),
      orphanRuns: new Map(),
    };
    const ctx = {
      ...host,
      host,
      threadId: THREAD,
      setStatus: () => {},
      get cancelled() {
        return studio.cancels.has(THREAD);
      },
    };
    studio.scoped = () => ctx;
    return { studio, requests, store, log };
  }

  it("R9. Loop on after a finished build its session led: the message keeps its Loop, the session reopens, and the same run registers again with the Loop's time", async () => {
    const reopenAsked = [{ name: "reopen_run", args: { text: "add enemies to the plaza" } }];
    const chat = chatAfter(finishedJournal(), finishedLog(), reopenAsked);
    const action = {
      type: "user_message",
      threadId: THREAD,
      text: "add enemies",
      engine: "codex",
      project: "plaza",
      messageId: "m9",
    };
    const loopOn = { ...action, autopilot: { hours: 2 } };
    await handleUserMessage(chat.studio as never, loopOn as never);

    assert.deepEqual(loopOn.autopilot, { hours: 2 }, "the message keeps its Loop");
    // The queue joins what is sent meanwhile on the commission the turn kept (message-queue.ts `steersInto`).
    assert.equal(steersInto({ ...action, messageId: "m10", autopilot: { hours: 2 } }, loopOn), true);
    assert.equal(steersInto({ ...action, messageId: "m10" }, loopOn), false, "a message with Loop off waits");
    assert.deepEqual(
      (chat.requests[0]?.interviewTools ?? []).map((tool: { name: string }) => tool.name),
      ["reopen_run", "start_autopilot", "ask_user"],
    );
    assert.equal(chat.requests[0]?.model, "gpt-5.6-sol", "the session answers on the model it led on");

    const registered = () =>
      chat.log.filter((entry) => entry.data.event_type === "run_registered" && entry.data.payload?.runId === RUN);
    for (let n = 0; n < 200 && registered().length < 2; n++) await sleep(10);
    for (let n = 0; n < 200 && chat.studio.activeRuns.size + chat.studio.startingRuns.size > 0; n++) await sleep(10);
    const again = registered()[1]?.data.payload;
    assert.equal(again?.resumed, true, JSON.stringify(chat.log.map((entry) => entry.data.event_type)));
    assert.equal(again?.budgets?.wallClockMs, 2 * HOUR_MS);
    assert.equal(again?.roles?.planner, "gpt-5.6-sol");
    const steer = chat.log.findIndex(
      (entry) => entry.data.event_type === "run_steering" && entry.data.payload?.text === "add enemies to the plaza",
    );
    assert.ok(steer > 1 && steer < chat.log.indexOf(registered()[1] as Entry), "the ask is recorded before the start");
    assert.equal(chat.log[steer]?.data.payload?.sourceMessageId, "m9");
    assert.ok(chat.store.journal.director.reopened, "the run started from the reopened journal");
  });

  it("R9c. a command's result after a finished build its session led inherits no Loop from the question the session asked: nothing reopens", async () => {
    const words = "I ran this in the terminal:\nnpm test\n\nIt failed (exit code 1). It printed nothing.";
    const log = [
      ...finishedLog(),
      custom("e3", "interview_question", { question: "Go on with this build?", intakeId: "interview_t0" }),
      { id: "e4", data: { type: "messages", messages: [{ role: "user", content: words }] } },
    ];
    const chat = chatAfter(finishedJournal(), log, [{ name: "reopen_run", args: { text: "fix the failing test" } }], {
      interview_t0: { autopilot: { hours: 2 } },
    });
    const report = {
      type: "user_message",
      threadId: THREAD,
      text: words,
      engine: "codex",
      project: "plaza",
      messageId: "m12",
      origin: "command-result",
    };
    await handleUserMessage(chat.studio as never, report as never);
    const offered = (chat.requests[0]?.interviewTools ?? []).map((tool: { name: string }) => tool.name);
    assert.equal(offered.includes("reopen_run"), false, `offered ${offered}`);
    await sleep(20);
    assert.equal(chat.log.filter((entry) => entry.data.event_type === "run_registered").length, 1, "nothing reopened");
    assert.equal(chat.store.journal.director.reopened, undefined);
  });

  it("R10. the same message after a paused build, or with Loop off: its Loop is dropped or never there, and nothing reopens", async () => {
    const pausedLog = finishedLog();
    pausedLog[1] = custom("e2", "autopilot_paused", { runId: RUN });
    const paused = chatAfter({ ...finishedJournal(), phase: "paused" }, pausedLog, [
      { name: "reopen_run", args: { text: "add enemies" } },
    ]);
    const action = {
      type: "user_message",
      threadId: THREAD,
      text: "add enemies",
      engine: "codex",
      project: "plaza",
      messageId: "m9",
    };
    const loopOn = { ...action, autopilot: { hours: 2 } };
    await handleUserMessage(paused.studio as never, loopOn as never);
    assert.equal("autopilot" in loopOn, false, "a message for a paused build drops its Loop");
    assert.equal(steersInto({ ...action, messageId: "m10", autopilot: { hours: 2 } }, loopOn), false);
    assert.equal(steersInto({ ...action, messageId: "m10" }, loopOn), true);
    assert.deepEqual(
      (paused.requests[0]?.interviewTools ?? []).map((tool: { name: string }) => tool.name),
      ["resume_run"],
    );

    const loopOff = chatAfter(finishedJournal(), finishedLog(), [
      { name: "reopen_run", args: { text: "add enemies" } },
    ]);
    await handleUserMessage(loopOff.studio as never, { ...action } as never);
    assert.equal(loopOff.requests[0]?.interviewTools, undefined);
    await sleep(20);
    const registrations = loopOff.log.filter((entry) => entry.data.event_type === "run_registered");
    assert.equal(registrations.length, 1, "nothing reopened");
    assert.equal(loopOff.store.journal.director.reopened, undefined);
  });

  it("R11. the reopened run builds and judges on the message's picks, as a start over from that same message would; only its planner is the session's model", async () => {
    const finishedRun = {
      ...launched,
      roles: { planner: "gpt-5.6-sol", builder: "gpt-5.6-sol", judge: "sonnet", engines: { judge: "claude-code" } },
      model: "gpt-5.6-sol",
      judgeEngine: "claude-code",
      judgeModel: "sonnet",
      effort: "high",
      preferences: { fast: true },
    };
    const journal = () => ({
      ...finishedJournal(),
      run: { ...finishedRun, readiness: { contract: "loaded", problems: [] } },
    });
    const base = {
      type: "user_message",
      threadId: THREAD,
      text: "add enemies",
      engine: "codex",
      project: "plaza",
      messageId: "m9",
    };
    const roles = {
      planner: "gpt-5.6-terra",
      builder: "opus",
      judge: "gpt-5.6-luna",
      engines: { builder: "claude-code" },
      efforts: { builder: "high" },
    };
    /** The question the session asked after the build, its commission kept beside it, and the reply's bubble. */
    const asked = [
      custom("e3", "interview_question", { question: "Go on or start over?", intakeId: "interview_t0" }),
      { id: "e4", data: { type: "messages", messages: [{ role: "user", content: "add enemies" }] } },
    ];
    const question = {
      interview_t0: { autopilot: { hours: 2, roles, builderEngine: "codex", builderModel: "gpt-5.6-terra" } },
    };
    const rows = [
      {
        label: "the roles page: workers on Claude Code, Luna judging, per-role efforts",
        message: {
          model: "gpt-5.6-terra",
          effort: "medium",
          preferences: { fast: true },
          autopilot: { hours: 2, roles },
        },
        planner: "gpt-5.6-terra",
      },
      {
        label: "one model, no roles: its preset",
        message: { model: "gpt-5.6-terra", effort: "low", autopilot: { hours: 2 } },
        planner: "gpt-5.6-terra",
      },
      {
        label: "no model named: the session's own, nothing kept from the finished picks",
        message: { autopilot: { hours: 2 } },
        planner: "gpt-5.6-sol",
      },
      {
        label: "a reply to the question the session asked: the question's Loop",
        message: { model: "gpt-5.6-terra", effort: "medium" },
        planner: "gpt-5.6-terra",
        asked: true,
      },
    ];
    /** The run the second registration of this thread carries, once the message recorded `recorded`. */
    const second = async (row: (typeof rows)[number], recorded: Array<Record<string, unknown>>) => {
      const log = [custom("e1", "run_registered", { ...finishedRun, resumed: false }), finishedLog()[1] as Entry];
      if (row.asked) log.push(...asked);
      const chat = chatAfter(journal(), log, recorded, row.asked ? question : {});
      await handleUserMessage(chat.studio as never, { ...base, ...structuredClone(row.message) } as never);
      const registered = () => chat.log.filter((entry) => entry.data.event_type === "run_registered");
      for (let n = 0; n < 200 && registered().length < 2; n++) await sleep(10);
      for (let n = 0; n < 200 && chat.studio.activeRuns.size + chat.studio.startingRuns.size > 0; n++) await sleep(10);
      return registered()[1]?.data.payload ?? {};
    };
    const PICKS = ["engine", "model", "builderEngine", "judgeEngine", "judgeModel", "effort", "preferences"] as const;
    /** What the workers and judges run on, and the roles without the planner. */
    const picksOf = (run: Json) => {
      const { planner: _lead, ...workers } = run.roles ?? {};
      return { ...Object.fromEntries(PICKS.map((key) => [key, run[key]])), roles: workers };
    };
    for (const row of rows) {
      const reopened = await second(row, [{ name: "reopen_run", args: { text: "add enemies" } }]);
      const startedOver = await second(row, [
        { name: "start_autopilot", args: { goal: "enemies", direction: "dusk" } },
      ]);
      assert.equal(reopened.runId, RUN, `${row.label}: the same run`);
      assert.notEqual(startedOver.runId, RUN, `${row.label}: a new one`);
      assert.deepEqual(picksOf(reopened), picksOf(startedOver), row.label);
      assert.equal(reopened.roles?.planner, row.planner, `${row.label}: planned on the session's model`);
    }
  });
});

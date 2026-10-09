/**
 * The same agent after the build (loop/after-loop-run.ts): once a run a lead led as its chat's own
 * session has closed, the chat's next message goes to that session with the run's controls. Which
 * runs that is, what the session is told, what it is handed, and the resume it records — and,
 * after a finished build with Loop on, the reopen it records (loop/reopen-run.ts) — without a rig.
 * The rig runs are director-one-session.test.ts S1 and S6–S10.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  afterLeadLoopRun,
  afterLoopRunGrant,
  resumeAfterReply,
  resumeAsked,
  servesAfterLoopRun,
} from "../../src/harness-seed/loop/after-loop-run.ts";
import { handleRunStart } from "../../src/harness-seed/loop/run-dispatch.ts";
import type { Studio } from "../../src/harness-seed/loop/studio-state.ts";
import { afterLoopRunNote } from "../../src/harness-seed/loop/after-loop-run-prompts.ts";
import { buildContractorBrief } from "../../src/harness-seed/loop/chat-session.ts";
import * as chatSession from "../../src/harness-seed/loop/chat-session.ts";
import * as delegatedTurn from "../../src/harness-seed/loop/delegated-turn.ts";
import * as turnLoop from "../../src/harness-seed/loop/turn-loop.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const RUN = "run_after";
const THREAD = "thread_after";

/** A host that answers the engines it knows and the run's journal, and records every other call. */
function hostWith(journal: unknown, calls: Array<{ method: string; params: any }> = []) {
  return {
    calls,
    call: async (method: string, params: any): Promise<any> => {
      calls.push({ method, params });
      if (method === "engine.describe")
        return [
          { id: "codex", kind: "delegated" },
          { id: "ollama", kind: "direct" },
        ];
      if (method === "artifact.read") return params.artifactId === `autopilot_${RUN}` ? journal : null;
      return null;
    },
  };
}

/** A loop's state as the chat's resume and a run's start read it: its host, its Stops and its runs. */
function studioWith(host: { call: (method: string, params: any) => Promise<any> }): Studio {
  return {
    host: { ...host, notify: () => {}, workspace: "/nonexistent" },
    cancels: new Set(),
    moodBoards: new Map(),
    activeRuns: new Map(),
    startingRuns: new Map(),
    orphanRuns: new Map(),
    scoped: () => {
      throw new Error("no ctx here");
    },
  } as never;
}

/** The chat's ctx: its thread, stopped by the composer's Stop (main.ts `cancel`). */
const chatOf = (studio: Studio) => ({
  threadId: THREAD,
  get cancelled() {
    return studio.cancels.has(THREAD);
  },
});

/** How long the unit rows let the chat hold for a reservation that never comes here. */
const NEVER_RESERVED_MS = 20;

/** A run's journal whose lead was the chat's own session — or another one's, or none at all. */
const leadJournal = (chatSession: boolean | null) => ({
  phase: "done",
  director: chatSession === null ? { sessionId: "director-1" } : { lead: { chatSession }, sessionId: "chat-1" },
});
const closed = (state: string) => ({
  runId: RUN,
  project: "plaza",
  engine: "codex",
  goal: "a dusk plaza",
  state,
  landed: false,
  stoppedBecause: "stopped by the user",
});

describe("which chats after a run the chat's own session answers", () => {
  it("A1. only a closed run whose lead was the chat's own session, on an engine that holds a session", async () => {
    const rows: Array<{
      label: string;
      run: Record<string, unknown>;
      journal: unknown;
      engine?: string;
      own: boolean;
    }> = [
      {
        label: "a finished lead run",
        run: closed("finished"),
        journal: leadJournal(true),
        engine: "codex",
        own: true,
      },
      { label: "a paused lead run", run: closed("paused"), journal: leadJournal(true), engine: "codex", own: true },
      { label: "a message that names no engine", run: closed("finished"), journal: leadJournal(true), own: true },
      {
        label: "a message on another engine than its lead's (another session)",
        run: closed("finished"),
        journal: leadJournal(true),
        engine: "claude-code",
        own: false,
      },
      {
        label: "a run still running",
        run: closed("running"),
        journal: leadJournal(true),
        engine: "codex",
        own: false,
      },
      {
        label: "a run under way (no state)",
        run: { runId: RUN, engine: "codex" },
        journal: leadJournal(true),
        own: false,
      },
      {
        label: "a lead that was a session of its own",
        run: closed("finished"),
        journal: leadJournal(false),
        engine: "codex",
        own: false,
      },
      {
        label: "a director with its own hands (the long turn, a kept older part)",
        run: closed("finished"),
        journal: leadJournal(null),
        engine: "codex",
        own: false,
      },
      {
        label: "the classic pipeline (no director)",
        run: closed("finished"),
        journal: { phase: "done" },
        engine: "codex",
        own: false,
      },
      { label: "no journal at all", run: closed("finished"), journal: null, engine: "codex", own: false },
      {
        label: "a model without sessions",
        run: closed("finished"),
        journal: leadJournal(true),
        engine: "ollama",
        own: false,
      },
    ];
    const seen: Array<{ label: string; own: boolean }> = [];
    for (const { label, run, journal, engine } of rows) {
      const loopRun = await afterLeadLoopRun(
        hostWith(journal),
        { threadId: THREAD, ...(engine ? { engine } : {}) },
        run,
      );
      seen.push({ label, own: loopRun !== null });
    }
    assert.deepEqual(
      seen,
      rows.map(({ label, own }) => ({ label, own })),
    );
    const loopRun = await afterLeadLoopRun(hostWith(leadJournal(true)), { threadId: THREAD }, closed("paused"));
    assert.deepEqual(loopRun, {
      runId: RUN,
      state: "paused",
      goal: "a dusk plaza",
      landed: false,
      stoppedBecause: "stopped by the user",
      engine: "codex",
      model: null,
    });
    const onFable = await afterLeadLoopRun(
      hostWith(leadJournal(true)),
      { threadId: THREAD, engine: "claude-code" },
      { ...closed("finished"), engine: "claude-code", roles: { planner: "claude-fable-5-1" } },
    );
    assert.equal(onFable?.model, "claude-fable-5-1", "the model its lead ran on, for a message that names none");
  });

  it("A1b. the turn runs where the session is: the lead's engine, and its model unless the message names one", async () => {
    const lead = { ...closed("finished"), engine: "claude-code", roles: { planner: "claude-fable-5-1" } };
    const runsOn = async (message: { engine?: string; model?: string }) => {
      const loopRun = await afterLeadLoopRun(hostWith(leadJournal(true)), { threadId: THREAD, ...message }, lead);
      return loopRun && { engine: loopRun.engine, model: loopRun.model };
    };
    const rows = [
      {
        label: "the lead's engine, no model",
        message: { engine: "claude-code" },
        runs: { engine: "claude-code", model: "claude-fable-5-1" },
      },
      { label: "no engine, no model", message: {}, runs: { engine: "claude-code", model: "claude-fable-5-1" } },
      {
        label: "the lead's engine, a model of its own",
        message: { engine: "claude-code", model: "opus" },
        runs: { engine: "claude-code", model: "opus" },
      },
      // Another engine is another session: the coordinator answers, and the lead's model is not borrowed there.
      { label: "another engine, no model", message: { engine: "codex" }, runs: null },
      { label: "another engine, a model of its own", message: { engine: "codex", model: "gpt-5.6-sol" }, runs: null },
    ];
    const seen: Array<{ label: string; runs: unknown }> = [];
    for (const { label, message } of rows) seen.push({ label, runs: await runsOn(message) });
    assert.deepEqual(
      seen,
      rows.map(({ label, runs }) => ({ label, runs })),
    );
  });

  it("A2. the chat turn, the runner that picks it and its brief serve it (`SERVES_AFTER_LOOP_RUN`); a part without the mark does not", () => {
    assert.equal(servesAfterLoopRun([delegatedTurn, chatSession, turnLoop]), true);
    assert.equal(servesAfterLoopRun([delegatedTurn, { buildContractorBrief }]), false);
    assert.equal(servesAfterLoopRun([delegatedTurn, chatSession, { runTurn: turnLoop.runTurn }]), false);
  });
});

describe("what the chat's own session is told and handed after a run", () => {
  const finished = {
    runId: RUN,
    state: "finished",
    goal: "a dusk plaza",
    landed: false,
    stoppedBecause: null,
    model: null,
  };
  const paused = { ...finished, state: "paused", stoppedBecause: "stopped by the user" };

  it("A3. the note: the build is over, its hands are back, a question never restarts it, and the controls spelled for its engine", () => {
    const note = afterLoopRunNote(finished as never, "claude-code");
    assert.match(note, /THE BUILD IS OVER/);
    assert.match(note, /a dusk plaza/);
    assert.match(note, /edit/i);
    assert.match(note, /never restarts/);
    assert.match(note, /mcp__studio__run_status/);
    assert.match(note, /mcp__studio__show_build/);
    assert.match(note, /mcp__studio__land_build/);
    assert.match(note, /yourself/, "a finished run's change is the session's own to make");
    assert.doesNotMatch(note, /resume_run/, "nothing to resume after a finished run");
    const pausedNote = afterLoopRunNote(paused as never, "codex");
    assert.match(pausedNote, /PAUSED/);
    assert.match(pausedNote, /stopped by the user/);
    assert.match(pausedNote, /\.studio\/bridge\/tool\.mjs resume_run/, "a paused run's resume, spelled for Codex");
  });

  it("A4. the brief carries the note in place of 'pick up where you left off', resumed or fresh", () => {
    const note = afterLoopRunNote(finished as never, "codex");
    const resumed = buildContractorBrief({
      ask: "why dusk?",
      resume: true,
      engine: "codex",
      afterLoopRun: note,
    } as never);
    assert.ok(resumed.startsWith("why dusk?"), resumed);
    assert.ok(resumed.includes(note), resumed);
    assert.doesNotMatch(resumed, /Pick up exactly where you left off/);
    const fresh = buildContractorBrief({
      ask: "why dusk?",
      messages: [
        { role: "user", content: "make a dusk plaza" },
        { role: "assistant", content: "Building until about 07:10." },
      ],
      engine: "codex",
      afterLoopRun: note,
    } as never);
    assert.ok(fresh.includes(note), fresh);
    assert.match(fresh, /Original request:\nmake a dusk plaza/);
  });

  it("A5. handed the run's controls for this run and message; a paused run's resume is bridged, a finished one's is not", () => {
    const finishedGrant = afterLoopRunGrant({ ...finished, messageId: "m1" } as never);
    assert.deepEqual(finishedGrant, { runControls: { runId: RUN, messageId: "m1" } });
    const pausedGrant = afterLoopRunGrant({ ...paused, messageId: "m2" } as never);
    assert.deepEqual(pausedGrant.runControls, { runId: RUN, messageId: "m2" });
    assert.deepEqual(
      (pausedGrant.interviewTools ?? []).map((tool: { name: string }) => tool.name),
      ["resume_run"],
    );
    // The resume reaches this run only: the bridged tool names no run to reach another with.
    assert.deepEqual(Object.keys(pausedGrant.interviewTools?.[0]?.parameters.properties ?? {}), ["text"]);
  });

  it("A6. a recorded resume is taken only after a paused run, and done through the host's resume_run once the reply ends", async () => {
    const recorded = [{ name: "resume_run", args: { text: "continue with a red moon" } }];
    assert.equal(resumeAsked(finished as never, recorded), null, "a finished run resumes nothing");
    assert.equal(resumeAsked(paused as never, []), null);
    const asked = resumeAsked(paused as never, recorded);
    assert.deepEqual(asked, { text: "continue with a red moon" });
    // Hostile: the session names another run, or more than its instruction. Only the words are
    // taken; the resume is the granted run's.
    const hostile: Array<{ args: Record<string, unknown>; taken: Record<string, unknown> }> = [
      { args: { runId: "run_other", text: "go on" }, taken: { text: "go on" } },
      { args: { runId: "run_other" }, taken: {} },
      { args: { text: { runId: "run_other" }, project: "elsewhere" }, taken: {} },
    ];
    for (const { args, taken } of hostile)
      assert.deepEqual(resumeAsked(paused as never, [{ name: "resume_run", args }]), taken, JSON.stringify(args));

    const calls: Array<{ method: string; params: any }> = [];
    const studio = studioWith(hostWith(null, calls));
    await resumeAfterReply(studio, chatOf(studio), { ...paused, messageId: "m2" } as never, asked!, NEVER_RESERVED_MS);
    // What a hostile recording leaves: the words, for the granted run.
    const taken = resumeAsked(paused as never, [{ name: "resume_run", args: { runId: "run_other", text: "go on" } }]);
    await resumeAfterReply(studio, chatOf(studio), { ...paused, messageId: "m4" } as never, taken!, NEVER_RESERVED_MS);
    assert.deepEqual(
      calls.map((c) => [c.method, c.params]),
      [
        [
          "coordinator.tool",
          {
            threadId: THREAD,
            runId: RUN,
            messageId: "m2",
            name: "resume_run",
            args: { text: "continue with a red moon" },
          },
        ],
        [
          "coordinator.tool",
          { threadId: THREAD, runId: RUN, messageId: "m4", name: "resume_run", args: { text: "go on" } },
        ],
      ],
    );

    // The host refuses (the run is no longer paused): the chat is told, durably, and nothing else happens.
    const refused: Array<{ method: string; params: any }> = [];
    const refusing = {
      call: async (method: string, params: any) => {
        refused.push({ method, params });
        if (method === "coordinator.tool")
          throw new Error("Only a paused run from this conversation can be resumed. No new run was started.");
        return null;
      },
    };
    const refusedBy = studioWith(refusing);
    await resumeAfterReply(refusedBy, chatOf(refusedBy), { ...paused, messageId: "m3" } as never, asked!);
    const told = refused.find((c) => c.method === "events.append")?.params;
    assert.equal(told?.threadId, THREAD);
    assert.match(JSON.stringify(told?.batch), /Only a paused run from this conversation can be resumed/);
  });

  it("A7. the chat holds its next message until the run it asked to resume is reserved, never past its bound", async () => {
    const studio = studioWith(hostWith(null));
    let released = false;
    const resuming = resumeAfterReply(studio, chatOf(studio), { ...paused, messageId: "m5" } as never, {
      text: "go on",
    }).then(() => {
      released = true;
    });
    await sleep(200);
    assert.equal(released, false, "the resumed run is not reserved yet: the chat still holds");
    // run-dispatch.ts reserves the run once the host's resume reaches the loop.
    studio.startingRuns.set(RUN, { run: { runId: RUN } as never, threadId: THREAD, settled: new Promise(() => {}) });
    await resuming;
    assert.equal(released, true);

    // A resume that never comes frees the chat once the bound passes.
    const lone = studioWith(hostWith(null));
    const started = Date.now();
    await resumeAfterReply(lone, chatOf(lone), { ...paused, messageId: "m6" } as never, { text: "go on" }, 100);
    assert.ok(Date.now() - started < 2_000, `held ${Date.now() - started} ms`);
  });

  it("A8. Stop after the resuming reply, before the run is reserved: the run stays paused, and the chat is told", async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const studio = studioWith(hostWith(null, calls));
    const resuming = resumeAfterReply(studio, chatOf(studio), { ...paused, messageId: "m7" } as never, {
      text: "go on",
    });
    studio.cancels.add(THREAD); // the composer's Stop
    await resuming;
    // The host's resume reaches the loop after the Stop (run-dispatch.ts `resumeRun`).
    await handleRunStart(studio, {
      type: "run_start",
      threadId: THREAD,
      run: { runId: RUN, project: "plaza", goal: "a dusk plaza", engine: "codex", mode: "autopilot" } as never,
      resume: true,
    });
    assert.equal(studio.cancels.has(THREAD), true, "the Stop is kept");
    assert.equal(studio.activeRuns.size + studio.startingRuns.size, 0, "nothing was reserved");
    assert.ok(!calls.some((c) => c.method === "game.list"), "the run never started");
    await sleep(0);
    const told = calls.filter((c) => c.method === "events.append").map((c) => JSON.stringify(c.params.batch));
    assert.ok(
      told.some((batch) => /The build was not resumed: Stop came before it started again/.test(batch)),
      told.join("\n"),
    );
  });
});

describe("the chat's own session after a finished build, with Loop on (reopen-run.ts)", () => {
  /** A finished run the chat may reopen: chat-dispatch.ts marks it once every part serves the reopen. */
  const finished = {
    runId: RUN,
    state: "finished",
    goal: "a dusk plaza",
    landed: true,
    stoppedBecause: null,
    model: null,
    messageId: "m1",
    reopenable: true,
  };
  const paused = { ...finished, state: "paused", stoppedBecause: "stopped by the user" };
  /** A tool the session recorded: its name and what it passed. */
  type Recorded = { name: string; args?: Record<string, unknown> };
  /** What the session was handed (`engine.delegate`): its prompt and model, its bridged tools, the run's controls. */
  type Handed = {
    prompt?: string;
    model?: string;
    runControls?: unknown;
    interviewTools?: Array<{ name: string; parameters: { properties: Record<string, unknown> } }>;
  };
  /** What one turn of the session is given: the run, the message's commission, what it records and how it ends. */
  interface SessionTurn {
    loopRun: Record<string, unknown>;
    commission?: Record<string, unknown> | null;
    recorded?: Recorded[];
    ok?: boolean;
    engine?: string;
    /** The session changed the game's sources in its turn. */
    edits?: boolean;
  }

  /**
   * One turn of the chat's own session after its run, in folder `plaza`, resuming its session: the
   * request it was handed, what the turn gave back, and every call the turn made.
   */
  async function sessionTurn({
    loopRun,
    commission = null,
    recorded = [],
    ok = true,
    engine = "codex",
    edits = false,
  }: SessionTurn) {
    const requests: Handed[] = [];
    let stamps = 0;
    const recorder = ctxRecorder({
      threadId: THREAD,
      unknown: { value: null },
      handlers: {
        "events.messages": () => [{ role: "user", content: "add enemies" }],
        "game.list": () => [{ name: "plaza", title: "Plaza" }],
        // The folder did not change, unless the session edits the game: then a preview pass looks at it.
        "game.contentStamp": () =>
          edits && stamps++ > 0 ? { all: "edited", source: "edited" } : { all: "same", source: "same" },
        "preview.ready": () => ({ ready: true }),
        "preview.status": () => ({}),
        "preview.console": () => [],
        "engine.delegate": (params) => {
          requests.push(params as Handed);
          return {
            ok,
            engine,
            turns: 1,
            usage: {},
            sessionId: "chat-1",
            summary: "On it.",
            studioToolCalls: recorded,
            ...(ok ? {} : { stopReason: "error", errorText: "the session ended" }),
          };
        },
      },
    });
    const outcome = await delegatedTurn.runDelegatedTurn(recorder.ctx as never, {
      threadId: THREAD,
      turnId: "turn-1",
      text: "add enemies",
      engine,
      engineLabel: "Codex",
      project: "plaza",
      resume: "chat-1",
      ...(commission ? { autopilot: commission } : {}),
      afterLoopRun: { ...loopRun, engine } as never,
    });
    return { outcome, request: requests[0], recorder };
  }
  /** The names of the tools a request bridged in. */
  const offered = (request: Handed | undefined): string[] => (request?.interviewTools ?? []).map((tool) => tool.name);
  /** What the turn said in the chat, in order. */
  const said = (recorder: ReturnType<typeof ctxRecorder>): string[] =>
    recorder
      .paramsOf("turn.append")
      .flatMap((p) => (p.batch as Array<{ messages?: Array<{ content?: string }> }>) ?? [])
      .flatMap((item) => (item.messages ?? []).map((m) => String(m.content)));

  it("A9. a finished build the chat may reopen, Loop on: the reopen first, the launch beside it for a start over, and no launch rules or New build", async () => {
    const { request } = await sessionTurn({ loopRun: finished, commission: { hours: 2 } });
    assert.deepEqual(offered(request), ["reopen_run", "start_autopilot", "ask_user"]);
    assert.deepEqual(Object.keys(request?.interviewTools?.[0]?.parameters.properties ?? {}), ["text"]);
    assert.deepEqual(request?.runControls, { runId: RUN, messageId: "m1" });
    const prompt = String(request?.prompt);
    assert.match(prompt, /\.studio\/bridge\/tool\.mjs reopen_run/);
    assert.match(prompt, /\.studio\/bridge\/tool\.mjs start_autopilot/, "a start over, spelled for Codex");
    assert.doesNotMatch(prompt, /changing it substantially/, "no launch rules: a change goes to the build");
    assert.doesNotMatch(prompt, /New build/);
    assert.doesNotMatch(prompt, /you do not start one/);
  });

  it("A10. no reopen without Loop, for a build the chat may not reopen, or after a paused run — and no launch after a run unless the reopen is offered", async () => {
    const rows = [
      { label: "a finished build the chat may reopen, Loop off", loopRun: finished, commission: null, tools: [] },
      // Named flip: a Loop commission after a run the chat may not reopen (a kept older part, or
      // an interview question's commission restored onto the reply) used to bridge start_autopilot.
      {
        label: "a finished build the chat may not reopen, Loop on",
        loopRun: { ...finished, reopenable: undefined },
        commission: { hours: 2 },
        tools: [],
      },
      { label: "a paused build, Loop on", loopRun: paused, commission: { hours: 2 }, tools: ["resume_run"] },
    ];
    const seen: Array<{ label: string; tools: string[] }> = [];
    for (const { label, loopRun, commission } of rows)
      seen.push({ label, tools: offered((await sessionTurn({ loopRun, commission })).request) });
    assert.deepEqual(
      seen,
      rows.map(({ label, tools }) => ({ label, tools })),
    );
    const { request } = await sessionTurn({
      loopRun: { ...finished, reopenable: undefined },
      commission: { hours: 2 },
    });
    assert.doesNotMatch(String(request?.prompt), /changing it substantially|reopen_run/);
    assert.match(String(request?.prompt), /no build starts for it/, "the session does the work itself");
  });

  it("A11. the reopen recorded goes back to the chat with its words and the Loop's hours: only a finished build's, a question first, then the reopen before a launch", async () => {
    const reopen = (args: Record<string, unknown>): Recorded => ({ name: "reopen_run", args });
    const launch: Recorded = { name: "start_autopilot", args: { goal: "a neon city", direction: "neon" } };
    const question: Recorded = { name: "ask_user", args: { question: "Go on with this build, or start over?" } };
    const rows: Array<SessionTurn & { label: string; details: unknown }> = [
      {
        label: "its request, with the Loop's hours",
        loopRun: finished,
        commission: { hours: 2 },
        recorded: [reopen({ text: "add enemies" })],
        details: { reopenRun: { hours: 2, text: "add enemies" } },
      },
      {
        label: "Loop ∞: no hours",
        loopRun: finished,
        commission: {},
        recorded: [reopen({ text: "add enemies" })],
        details: { reopenRun: { hours: null, text: "add enemies" } },
      },
      {
        label: "the Loop's roles go with it: the reopened run's workers and judges",
        loopRun: finished,
        commission: {
          hours: 2,
          roles: { planner: "gpt-5.6-sol", builder: "opus", engines: { builder: "claude-code" } },
        },
        recorded: [reopen({ text: "add enemies" })],
        details: {
          reopenRun: {
            hours: 2,
            text: "add enemies",
            roles: { planner: "gpt-5.6-sol", builder: "opus", engines: { builder: "claude-code" } },
          },
        },
      },
      // Hostile: the session names a run, or passes no words. Only its words are taken; the run is the granted one.
      {
        label: "a run it names is dropped",
        loopRun: finished,
        commission: { hours: 2 },
        recorded: [reopen({ runId: "run_other", text: "  go on  " })],
        details: { reopenRun: { hours: 2, text: "go on" } },
      },
      {
        label: "words that are not text are dropped",
        loopRun: finished,
        commission: { hours: 2 },
        recorded: [reopen({ text: { runId: "run_other" } })],
        details: { reopenRun: { hours: 2 } },
      },
      {
        label: "Loop off: a recorded reopen is ignored",
        loopRun: finished,
        recorded: [reopen({ text: "add enemies" })],
        details: undefined,
      },
      {
        label: "a paused build: a recorded reopen is ignored",
        loopRun: paused,
        commission: { hours: 2 },
        recorded: [reopen({ text: "add enemies" })],
        details: undefined,
      },
      {
        label: "the reopen beats a launch recorded beside it",
        loopRun: finished,
        commission: { hours: 2 },
        recorded: [launch, reopen({ text: "add enemies" })],
        details: { reopenRun: { hours: 2, text: "add enemies" } },
      },
      {
        label: "a question beats both",
        loopRun: finished,
        commission: { hours: 2 },
        recorded: [reopen({ text: "add enemies" }), launch, question],
        details: undefined,
      },
    ];
    const seen: Array<{ label: string; stopped: unknown; details: unknown }> = [];
    for (const { label, ...turn } of rows) {
      const { outcome } = await sessionTurn(turn);
      seen.push({ label, stopped: outcome.stopped, details: outcome.details });
    }
    assert.deepEqual(
      seen,
      rows.map(({ label, details }) => ({ label, stopped: "done", details })),
    );

    // The session was told the build goes on when its reply ends, and it does: an ending that went wrong is said.
    const { outcome, recorder } = await sessionTurn({
      loopRun: finished,
      commission: { hours: 2 },
      recorded: [reopen({ text: "add enemies" })],
      ok: false,
    });
    assert.deepEqual(outcome.details, { reopenRun: { hours: 2, text: "add enemies" } });
    assert.ok(
      said(recorder).some((words) => /asking to reopen the build — reopening it anyway/.test(words)),
      said(recorder).join("\n"),
    );
    assert.deepEqual(recorder.sequence("preview."), [], "no preview pass: the reply edits nothing");
  });

  it("A12b. a contained change Loop could have sent to the finished build, made by the session itself: the chat says it was made directly, with no build", async () => {
    const direct = await sessionTurn({ loopRun: finished, commission: { hours: 3 }, edits: true });
    assert.deepEqual(direct.outcome.details ?? null, null, "nothing reopens");
    assert.ok(
      said(direct.recorder).some((words) => /made directly, no build/.test(words)),
      said(direct.recorder).join("\n"),
    );

    const loopOff = await sessionTurn({ loopRun: finished, edits: true });
    assert.ok(
      !said(loopOff.recorder).some((words) => /made directly/.test(words)),
      "Loop off: nothing to say about a build",
    );
    const answered = await sessionTurn({ loopRun: finished, commission: { hours: 3 } });
    assert.ok(!said(answered.recorder).some((words) => /made directly/.test(words)), "an answer changed nothing");
  });

  it("A12. the note after a finished build: the session's own work with Loop off, the reopen with it on; a paused build's is unchanged", () => {
    const own = afterLoopRunNote(finished as never, "claude-code");
    assert.match(own, /you do yourself, here in the game folder/);
    assert.doesNotMatch(own, /New build|you do not start one/);
    assert.doesNotMatch(own, /reopen_run/);

    const grant = { hours: 2, frameCount: 1, project: "plaza", launchTool: "start_autopilot" };
    const reopening = afterLoopRunNote(finished as never, "claude-code", grant);
    assert.match(reopening, /mcp__studio__reopen_run/);
    assert.match(reopening, /up to 2 h/);
    assert.match(reopening, /edit nothing/);
    assert.match(reopening, /mcp__studio__start_autopilot/);
    assert.match(reopening, /start over/);
    assert.match(reopening, /Pass "plaza"/);
    assert.match(reopening, /mcp__studio__ask_user/);
    assert.match(reopening, /1 still/);
    assert.doesNotMatch(reopening, /no build starts for it|New build/);

    const untilSatisfied = afterLoopRunNote(finished as never, "codex", { ...grant, hours: null, frameCount: 0 });
    assert.match(untilSatisfied, /\.studio\/bridge\/tool\.mjs reopen_run/);
    assert.match(untilSatisfied, /until its judges are satisfied, 24 h at most/);
    assert.doesNotMatch(untilSatisfied, /still\(s\)/);
    const noStartOver = afterLoopRunNote(finished as never, "claude-code", { ...grant, launchTool: null });
    assert.doesNotMatch(noStartOver, /start over|start_autopilot|ask_user/);

    // A paused build resumes with the time it had left, whatever grant came with it.
    assert.equal(afterLoopRunNote(paused as never, "codex", grant), afterLoopRunNote(paused as never, "codex"));
    assert.match(afterLoopRunNote(paused as never, "codex"), /\.studio\/bridge\/tool\.mjs resume_run/);
  });

  it("A13. a throttled session after its run never falls back to another engine, Loop or not; a Loop chat still does", async () => {
    /** A session turn whose engine is throttled with a fallback named; nothing past the fallback is answered. */
    async function throttled(afterLoopRun: Record<string, unknown> | null) {
      const recorder = ctxRecorder({
        threadId: THREAD,
        handlers: {
          "events.messages": () => [{ role: "user", content: "add enemies" }],
          "game.list": () => [{ name: "plaza", title: "Plaza" }],
          "game.contentStamp": () => ({ all: "same", source: "same" }),
          "turn.append": () => null,
          "engine.delegate": () => {
            throw Object.assign(new Error("usage limit reached"), { kind: "rate_limit", fallbacks: ["ollama"] });
          },
        },
      });
      const outcome = await delegatedTurn
        .runDelegatedTurn(recorder.ctx as never, {
          threadId: THREAD,
          turnId: "turn-1",
          text: "add enemies",
          engine: "codex",
          engineLabel: "Codex",
          project: "plaza",
          autopilot: { hours: 2 },
          ...(afterLoopRun ? { afterLoopRun: { ...afterLoopRun, engine: "codex" } as never } : {}),
        })
        .catch((err: Error) => ({ stopped: `threw: ${err.message}` }));
      const fellBack = recorder
        .paramsOf("turn.append")
        .flatMap((p) => (p.batch as Array<{ event_type?: string }>) ?? [])
        .some((item) => item.event_type === "engine_fallback");
      return { stopped: outcome.stopped, fellBack };
    }
    assert.deepEqual(await throttled(finished), { stopped: "engine_limited", fellBack: false });
    assert.deepEqual(await throttled({ ...finished, reopenable: undefined }), {
      stopped: "engine_limited",
      fellBack: false,
    });
    assert.equal((await throttled(null)).fellBack, true, "a Loop chat's build is not lost to a throttle");
  });

  it("A14. the session answers on its own model, not the commission's planner: its next run seats it again", async () => {
    /** The model the delegated session was asked on, for a turn run by the runner. */
    async function modelOf(options: Record<string, unknown>): Promise<unknown> {
      const requests: Handed[] = [];
      const recorder = ctxRecorder({
        threadId: THREAD,
        unknown: { value: null },
        handlers: {
          "engine.describe": () => [{ id: "claude-code", kind: "delegated", label: "Claude Code" }],
          "events.messages": () => [{ role: "user", content: "add enemies" }],
          "game.list": () => [{ name: "plaza", title: "Plaza" }],
          "game.contentStamp": () => ({ all: "same", source: "same" }),
          "engine.delegate": (params) => {
            requests.push(params as Handed);
            return { ok: true, engine: "claude-code", turns: 1, usage: {}, sessionId: "chat-1", summary: "On it." };
          },
        },
      });
      await turnLoop.runTurn(recorder.ctx as never, {
        threadId: THREAD,
        turnId: "turn-1",
        text: "add enemies",
        engine: "claude-code",
        project: "plaza",
        autopilot: { hours: 2, roles: { planner: "claude-fable-5-1" } },
        ...options,
      });
      return requests[0] && "model" in requests[0] ? requests[0].model : "none sent";
    }
    const loopRun = { ...finished, engine: "claude-code" };
    assert.equal(await modelOf({ model: "opus", afterLoopRun: { ...loopRun, model: "opus" } }), "opus");
    assert.equal(
      await modelOf({ afterLoopRun: loopRun }),
      "none sent",
      "the session's own default, as it answered before",
    );
    // Characterization: a Loop chat decides and scopes a build on the planner.
    assert.equal(await modelOf({ model: "opus" }), "claude-fable-5-1");
  });
});

/**
 * The same agent after the build (loop/after-loop-run.ts): once a Loop run that seated a lead has
 * closed, the chat's next message goes to the chat's own session with the run's controls. Which
 * runs that is, what the session is told, what it is handed, and the resume it records — without a
 * rig.
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
  resumeStopped,
} from "../../src/harness-seed/loop/after-loop-run.ts";
import { handleRunStart } from "../../src/harness-seed/loop/run-dispatch.ts";
import type { Studio } from "../../src/harness-seed/loop/studio-state.ts";
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
  it("A1. a closed run whose journal seated a lead, on an engine that holds a session", async () => {
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
        label: "a message on another engine than its lead's (the chat's own session there)",
        run: closed("finished"),
        journal: leadJournal(true),
        engine: "claude-code",
        own: true,
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
        own: true,
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
      engine: "codex",
      onLeadEngine: true,
      model: null,
    });
    const onFable = await afterLeadLoopRun(
      hostWith(leadJournal(true)),
      { threadId: THREAD, engine: "claude-code" },
      { ...closed("finished"), engine: "claude-code", roles: { planner: "claude-fable-5-1" } },
    );
    assert.equal(onFable?.model, "claude-fable-5-1", "the model its lead ran on, for a message that names none");
  });

  it("A1b. the turn runs on the message's engine, else the lead's; on the lead's engine, on its model unless the message names one", async () => {
    const lead = { ...closed("finished"), engine: "claude-code", roles: { planner: "claude-fable-5-1" } };
    const runsOn = async (message: { engine?: string; model?: string }) => {
      const loopRun = await afterLeadLoopRun(hostWith(leadJournal(true)), { threadId: THREAD, ...message }, lead);
      return loopRun && { engine: loopRun.engine, model: loopRun.model, onLeadEngine: loopRun.onLeadEngine };
    };
    const rows = [
      {
        label: "the lead's engine, no model",
        message: { engine: "claude-code" },
        runs: { engine: "claude-code", model: "claude-fable-5-1", onLeadEngine: true },
      },
      {
        label: "no engine, no model",
        message: {},
        runs: { engine: "claude-code", model: "claude-fable-5-1", onLeadEngine: true },
      },
      {
        label: "the lead's engine, a model of its own",
        message: { engine: "claude-code", model: "opus" },
        runs: { engine: "claude-code", model: "opus", onLeadEngine: true },
      },
      // Another engine is the chat's own session there: the lead's model is not borrowed there.
      {
        label: "another engine, no model",
        message: { engine: "codex" },
        runs: { engine: "codex", model: null, onLeadEngine: false },
      },
      {
        label: "another engine, a model of its own",
        message: { engine: "codex", model: "gpt-5.6-sol" },
        runs: { engine: "codex", model: "gpt-5.6-sol", onLeadEngine: false },
      },
    ];
    const seen: Array<{ label: string; runs: unknown }> = [];
    for (const { label, message } of rows) seen.push({ label, runs: await runsOn(message) });
    assert.deepEqual(
      seen,
      rows.map(({ label, runs }) => ({ label, runs })),
    );
  });
});

describe("what the chat's own session is told and handed after a run", () => {
  // Flipped (one Loop): the run named no `inPlace`, and a paused one resumed all the same; only a
  // Loop that worked in the game folder resumes now (an earlier Genex's web Loop is refused).
  const finished = { runId: RUN, state: "finished", onLeadEngine: true, model: null, inPlace: true };
  const paused = { ...finished, state: "paused" };
  /** A paused run answered on another engine than its lead's: the chat's bookmark moves there. */
  const pausedElsewhere = { ...paused, onLeadEngine: false };

  it("A5. handed the run's controls for this run and message; a paused run's resume is bridged on its lead's engine, a finished one's is not", () => {
    const finishedGrant = afterLoopRunGrant({ ...finished, messageId: "m1" } as never);
    assert.deepEqual(finishedGrant, { runControls: { runId: RUN, messageId: "m1" } });
    const pausedGrant = afterLoopRunGrant({ ...paused, messageId: "m2" } as never);
    assert.deepEqual(pausedGrant.runControls, { runId: RUN, messageId: "m2" });
    assert.deepEqual(
      (pausedGrant.interviewTools ?? []).map((tool: { name: string }) => tool.name),
      ["resume_run"],
    );
    // The resume reaches this run only: the bridged tool names no run to reach another with.
    // Flipped: it took `text` alone; it takes the time the person named for the build too (work-time.ts).
    assert.deepEqual(Object.keys(pausedGrant.interviewTools?.[0]?.parameters.properties ?? {}), [
      "text",
      "hours",
      "minutes",
    ]);
    // On another engine the build's controls stay, and its resume is Builds' alone.
    assert.deepEqual(afterLoopRunGrant({ ...pausedElsewhere, messageId: "m2" } as never), {
      runControls: { runId: RUN, messageId: "m2" },
    });
  });

  it("A6. a recorded resume is taken only after a paused run, and done through the host's resume_run once the reply ends", async () => {
    const recorded = [{ name: "resume_run", args: { text: "continue with a red moon" } }];
    assert.equal(resumeAsked(finished as never, recorded), null, "a finished run resumes nothing");
    assert.equal(resumeAsked(paused as never, []), null);
    assert.equal(resumeAsked(pausedElsewhere as never, recorded), null, "nothing resumes on another engine");
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
          "run.control",
          {
            threadId: THREAD,
            runId: RUN,
            messageId: "m2",
            name: "resume_run",
            args: { text: "continue with a red moon" },
          },
        ],
        ["run.control", { threadId: THREAD, runId: RUN, messageId: "m4", name: "resume_run", args: { text: "go on" } }],
      ],
    );

    // The host refuses (the run is no longer paused): the chat is told, durably, and nothing else happens.
    const refused: Array<{ method: string; params: any }> = [];
    const refusing = {
      call: async (method: string, params: any) => {
        refused.push({ method, params });
        if (method === "run.control")
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

  it("A6b. a time the person named with the resume goes on the paused run's journal first, counted from what it has worked", async () => {
    const recorded = (args: Record<string, unknown>) => [{ name: "resume_run", args }];
    assert.deepEqual(resumeAsked(paused as never, recorded({ text: "work 2h more", hours: 2 })), {
      text: "work 2h more",
      hours: 2,
    });
    // Hostile: no time, or one that is no time, is not taken.
    for (const hours of [0, -3, "abc", null])
      assert.deepEqual(
        resumeAsked(paused as never, recorded({ text: "go on", hours })),
        { text: "go on" },
        String(hours),
      );

    const worked = 47 * 60_000;
    const journalOf = () => ({
      run: { runId: RUN, budgets: { creditCap: 600, workMinutes: 180, workFromMs: 0, completionPolicy: "duration" } },
      director: { worked, lead: { chatSession: true } },
    });
    const writes = async (args: Record<string, unknown>, running = false) => {
      const calls: Array<{ method: string; params: any }> = [];
      const studio = studioWith(hostWith(journalOf(), calls));
      if (running) studio.activeRuns.set(THREAD, { run: { runId: RUN }, done: false } as never);
      await resumeAfterReply(studio, chatOf(studio), { ...paused, messageId: "m6" } as never, args, NEVER_RESERVED_MS);
      return calls.filter((call) => call.method === "artifact.write").map((call) => call.params.value);
    };
    const [written] = await writes({ text: "work 2h more", hours: 2 });
    // The rest of its budgets kept; the new time counted from the 47 minutes the run has worked.
    assert.deepEqual(written?.run.budgets, {
      creditCap: 600,
      workMinutes: 120,
      workFromMs: worked,
      completionPolicy: "duration",
    });
    assert.deepEqual(await writes({ text: "go on" }), [], "no time named: the journal is untouched");
    assert.deepEqual(await writes({ text: "go on", hours: 2 }, true), [], "a run under way here is never written");
  });

  it("A7. the chat holds its next message until the run it asked to resume is reserved or already held, never past its bound", async () => {
    const studio = studioWith(hostWith(null));
    let released = false;
    const resuming = resumeAfterReply(studio, chatOf(studio), { ...paused, messageId: "m5" } as never, {
      text: "go on",
    }).then(() => {
      released = true;
    });
    await sleep(200);
    assert.equal(released, false, "the resumed run is not reserved yet: the chat still holds");
    // run-dispatch.ts reserves the run once the host's resume reaches the loop (`handleRunStart` asks first).
    resumeStopped(studio, { type: "run_start", threadId: THREAD, run: { runId: RUN } as never, resume: true });
    await resuming;
    assert.equal(released, true);

    // A run already held, resumed meanwhile from Builds (the host's resume then dispatches nothing): the chat holds not at all.
    const held = studioWith(hostWith(null));
    held.activeRuns.set(THREAD, { threadId: THREAD, run: { runId: RUN }, done: false } as never);
    const heldSince = Date.now();
    await resumeAfterReply(held, chatOf(held), { ...paused, messageId: "m8" } as never, { text: "go on" }, 10_000);
    assert.ok(Date.now() - heldSince < 2_000, `held ${Date.now() - heldSince} ms for a run already reserved`);

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

describe("the chat's own session after a build it led: the Loop's start, never a reopen", () => {
  const finished = {
    runId: RUN,
    state: "finished",
    goal: "a dusk plaza",
    landed: true,
    stoppedBecause: null,
    onLeadEngine: true,
    model: null,
    messageId: "m1",
    // Flipped (one Loop): it named no `inPlace`; only a Loop that worked in place resumes now.
    inPlace: true,
  };
  const paused = { ...finished, state: "paused", stoppedBecause: "stopped by the user" };
  /** A tool the session recorded: its name and what it passed. */
  type Recorded = { name: string; args?: Record<string, unknown> };
  /** What the session was handed (`engine.delegate`): its prompt and model, its bridged tools, the run's controls. */
  type Handed = {
    prompt?: string;
    system?: string;
    model?: string;
    runControls?: unknown;
    interviewTools?: Array<{ name: string; parameters: { properties: Record<string, unknown> } }>;
  };
  /** What one turn of the session is given: the run, what it records and how it ends. */
  interface SessionTurn {
    loopRun: Record<string, unknown>;
    recorded?: Recorded[];
    engine?: string;
  }

  /**
   * One turn of the chat's own session after its run, in folder `plaza`, resuming its session: the
   * request it was handed, what the turn gave back, and every call the turn made.
   */
  async function sessionTurn({ loopRun, recorded = [], engine = "codex" }: SessionTurn) {
    const requests: Handed[] = [];
    const recorder = ctxRecorder({
      threadId: THREAD,
      unknown: { value: null },
      handlers: {
        "events.messages": () => [{ role: "user", content: "add enemies" }],
        "game.list": () => [{ name: "plaza", title: "Plaza" }],
        "game.contentStamp": () => ({ all: "same", source: "same" }),
        "preview.ready": () => ({ ready: true }),
        "preview.status": () => ({}),
        "preview.console": () => [],
        "engine.delegate": (params) => {
          requests.push(params as Handed);
          return {
            ok: true,
            engine,
            turns: 1,
            usage: {},
            sessionId: "chat-1",
            summary: "On it.",
            studioToolCalls: recorded,
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
      afterLoopRun: { ...loopRun, engine } as never,
    });
    return { outcome, request: requests[0], recorder };
  }
  /** The names of the tools a request bridged in. */
  const offered = (request: Handed | undefined): string[] => (request?.interviewTools ?? []).map((tool) => tool.name);

  // Flipped (A3, A4, A12): the session read "THE BUILD IS OVER" and the run's controls in words on
  // each turn after its run. It led the run itself; its controls and a paused run's resume are tools.
  it("A3. after a run the session reads the person's words alone, with no note of the build", async () => {
    for (const loopRun of [finished, paused]) {
      const { request } = await sessionTurn({ loopRun });
      assert.equal(request?.prompt, "add enemies", loopRun.state);
      assert.doesNotMatch(String(request?.system), /THE BUILD IS OVER|run_status|resume_run|PAUSED/, loopRun.state);
    }
  });

  it("A9. after a finished build the session holds the Loop's start beside the run's controls; after a paused one the resume too; never a reopen", async () => {
    const rows = [
      { label: "a finished build", loopRun: finished, tools: ["start_autopilot"] },
      { label: "a paused build", loopRun: paused, tools: ["start_autopilot", "resume_run"] },
    ];
    const seen: Array<{ label: string; tools: string[] }> = [];
    for (const { label, loopRun } of rows)
      seen.push({ label, tools: offered((await sessionTurn({ loopRun })).request) });
    assert.deepEqual(
      seen,
      rows.map(({ label, tools }) => ({ label, tools })),
    );
    const { request } = await sessionTurn({ loopRun: finished });
    assert.deepEqual(request?.runControls, { runId: RUN, messageId: "m1" });
    assert.doesNotMatch(String(request?.prompt), /reopen_run|asks? in words|no build starts|You start Loops yourself/);
  });

  it("A10. a Loop the session starts after its run, on any session engine, goes until its lead finishes it; a recorded reopen_run starts nothing", async () => {
    const ask = { goal: "the dragon attack", direction: "Skyrim at dusk" };
    const engines = ["codex", "claude-code", "opencode", "local-server"];
    const seen: Array<{ engine: string; stopped: unknown; hours: unknown }> = [];
    for (const engine of engines) {
      const launched = await sessionTurn({
        loopRun: { ...finished, inPlace: true },
        engine,
        recorded: [{ name: "start_autopilot", args: { ...ask, hours: 1 } }],
      });
      const run = launched.outcome.details?.run as { hours?: unknown; goal?: unknown } | undefined;
      seen.push({ engine, stopped: launched.outcome.stopped, hours: run?.hours });
    }
    assert.deepEqual(
      seen,
      engines.map((engine) => ({ engine, stopped: "launch_run", hours: undefined })),
      "no hours ride the launch",
    );
    const reopened = await sessionTurn({ loopRun: finished, recorded: [{ name: "reopen_run", args: { text: "x" } }] });
    assert.equal(reopened.outcome.stopped, "done");
    assert.equal(reopened.outcome.details, undefined);
  });

  it("A13. a throttled chat turn never falls back to another engine, after a run or not: only a run's own turn does", async () => {
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
    // Flipped: a chat turn that had the Loop switch on fell back to keep its build; no turn of the chat's own does now.
    assert.deepEqual(await throttled(null), { stopped: "engine_limited", fellBack: false });
  });

  it("A14. the session answers on its own model after its run, whatever roles the message carries", async () => {
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
        roles: { planner: "claude-fable-5-1" },
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
    // Flipped: a Loop chat used to swap to the commission's planner; a turn runs on the model it was sent.
    assert.equal(await modelOf({ model: "opus" }), "opus");
  });
});

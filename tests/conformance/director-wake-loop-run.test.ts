/**
 * The wake loop through the real core and harness (loop/director/wake.ts): a scripted lead ends
 * its turn after each decision, and the studio wakes the same session when its worker ends, when
 * the user speaks, when a job ends — and never after Stop.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { DelegateRequest, DelegateResult, LiveToolResult } from "../../src/substrate/engines/types.ts";
import { STAGE_PLUGIN, stagePackage } from "../helpers/hook-plugin.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import { customEvents, makeFakePreview, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import { messageQueueState } from "../../src/shared/message-queue.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { buildRunGraph, GraphNodeKind } from "../../src/renderer/run-graph.ts";
import { CustomEvent, customRecord } from "../../src/shared/custom-events.ts";
import { deliveryOrder } from "../../src/renderer/chat/delivery-order.ts";
import { chatContext } from "../../src/shared/chat-history.ts";
import { JobRole, JobScopeKind } from "../../src/shared/jobs.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { MessageFrom } from "../../src/shared/engine-requests.ts";

/** No run here may hang the suite: each is over in well under a minute when it works. */
const RIG_TIMEOUT_MS = 240_000;
const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.stop().catch(() => {})));
});

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);

/** Poll until it holds, or say what was still false when the clock ran out. */
async function until(condition: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The one worker the scripted leads start: a writer in its own copy of the integration branch. */
const startSky = { title: "Dusk sky", task: "Build a dusk sky", isolation: "copy" };

/** A delegated engine the rig's harness talks to: the lead's turns and the workers' sessions. */
function fakeEngine(rig: Rig, delegate: (request: DelegateRequest) => Promise<DelegateResult>): void {
  rig.core.engines.register({
    id: "codex",
    label: "codex",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete: async () => ({
      message: { role: "assistant", content: "{}" },
      usage: {},
      model: "fixture",
      engine: "codex",
      stopReason: "stop",
    }),
    delegate,
  } as never);
}

/** A turn's answer, as the engine reports one. */
const turnResult = (sessionId: string, summary: string): DelegateResult => ({
  ok: true,
  engine: "codex",
  turns: 1,
  usage: {},
  sessionId,
  summary,
});

/** A worker session that builds nothing until it is stopped. */
const hangUntilStopped = (request: DelegateRequest, aborted: () => void): Promise<DelegateResult> =>
  new Promise((resolve) =>
    request.signal!.addEventListener("abort", () => {
      aborted();
      resolve({ ok: false, engine: "codex", turns: 1, usage: {}, stopReason: "stopped", summary: "" });
    }),
  );

async function loopRun(name: string, extra: Record<string, unknown> = {}) {
  const rig = await startRig(
    { replies: [] },
    { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
  );
  rigs.push(rig);
  const project = await rig.core.games.scaffold(name, { title: name });
  const runId = rig.core.newRunId();
  // The dispatch answers when the run is over: a test that acts during it starts it and goes on.
  const dispatch = () =>
    rig.core
      .dispatchRun({
        runId,
        goal: "a dusk plaza",
        project: project.name,
        mode: "autopilot",
        engine: "codex",
        reference: { name: "Dusk", shots: [] },
        budgets: { wallClockMs: 15 * 60_000 },
        ...extra,
      } as never)
      .catch(() => {});
  const finished = () =>
    waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      150_000,
      `${name} run_finished`,
    );
  return { rig, project, runId, dispatch, finished };
}

describe("the lead is woken, not kept in one long turn", () => {
  it("R1. a lead that ends its turn is woken in the same session by its worker's end: that one line, Genex's", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("wake-by-worker");
    const lead: DelegateRequest[] = [];
    const results: Record<string, any> = {};
    let turnOneReturned = () => {};
    const turnOne = new Promise<void>((resolve) => {
      turnOneReturned = resolve;
    });
    fakeEngine(rig, async (request) => {
      if (request.director) {
        lead.push(request);
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        if (lead.length === 1) {
          results.started = text(await call("worker_start", startSky));
          turnOneReturned();
          return turnResult("lead-1", "the sky is building");
        }
        results.integrated = text(await call("worker_mark", { id: "w1", verdict: "used" }));
        results.finished = text(await call("finish", { summary: "a dusk sky", land: "yes" }));
        return turnResult("lead-1", "done");
      }
      // The worker ends after the lead has rested, so the order is the same on every run.
      await turnOne;
      await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'dusk';\n");
      return turnResult("worker-1", "Dusk sky");
    });
    const running = dispatch();
    const events = await finished();
    await running;

    assert.equal(lead.length, 2, lead.map((t) => t.prompt.slice(0, 60)).join(" | "));
    assert.equal(lead[1]!.resume, "lead-1", "the same session is woken");
    const woken = lead[1]!.prompt;
    // Flipped: a digest (WHAT HAPPENED, WHERE THE RUN STANDS, "… says what it found"); the worker's own line.
    assert.equal(woken, 'worker w1 "Dusk sky" ended: done.');
    assert.equal(lead[1]!.from, "genex", "Genex's, never the person's");
    // Flipped (Loop phase 5): a lead's tools are the one worker model's, worker_wait among them.
    assert.ok(
      (lead[0]!.liveTools ?? []).some((t) => t.name === "worker_start"),
      "it has its run tools",
    );
    // Flipped: the wake was recorded as `director_continued` "worker_ended"; what woke the lead is what it read.
    assert.deepEqual(customEvents(events, "director_continued"), []);
    const finishedEvent = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    // Flipped (Loop phase 5): the close names the lead. Flipped again (one Loop): a web game's Loop
    // closes in place on the lead's word, as every Loop does ("the lead finished the run" was its landing's).
    assert.equal(finishedEvent.stoppedBecause, "the lead says the goal is reached");
    assert.match(results.integrated, /^Merged w1's work into your folder/, results.integrated);

    const threadId = await rig.core.threadForGame(project.name);
    const journal = (await rig.core.store.readArtifact(threadId, `autopilot_${runId}`)) as Record<string, any>;
    // Flipped (no clock): the record held the run's clock (`director.clock.finalDeadline`); a Loop has none.
    assert.equal(journal.director.clock, undefined, "the record keeps no clock");
    assert.ok(journal.director.wake, "it keeps the wake state");
  });

  it("R2. a note the person leaves about the build wakes a sleeping lead within seconds, word for word", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("wake-by-user");
    const lead: Array<{ request: DelegateRequest; at: number }> = [];
    let rested = false;
    fakeEngine(rig, async (request) => {
      if (!request.director) return hangUntilStopped(request, () => {});
      lead.push({ request, at: Date.now() });
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (lead.length === 1) {
        await call("worker_start", startSky);
        rested = true;
        return turnResult("lead-1", "the sky is building");
      }
      await call("finish", { summary: "the user wants a red sky; stopping here", land: "no" });
      return turnResult("lead-1", "done");
    });
    const running = dispatch();
    await until(() => rested, "the lead's first turn to end");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const sentAt = Date.now();
    await rig.core.runFeedback({
      threadId: await rig.core.threadForGame(project.name),
      runId,
      text: "make the sky red",
    });
    await finished();
    await running;

    assert.equal(lead.length, 2);
    assert.ok(lead[1]!.at - sentAt < 10_000, `woken ${lead[1]!.at - sentAt} ms after the user spoke`);
    // Flipped: under THE USER SAYS, before WHERE THE RUN STANDS; the note alone, as the chat keeps it.
    assert.equal(lead[1]!.request.prompt, "[USER FEEDBACK] make the sky red");
    assert.equal(lead[1]!.request.from, "person");
    assert.equal(lead[1]!.request.resume, "lead-1");
  });

  it("R4. Stop reaches a sleeping lead: the run closes as stopped and no turn follows", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, runId, dispatch, finished } = await loopRun("wake-stop");
    const lead: DelegateRequest[] = [];
    let aborted = 0;
    let rested = false;
    fakeEngine(rig, async (request) => {
      if (!request.director) return hangUntilStopped(request, () => aborted++);
      lead.push(request);
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (lead.length === 1) {
        await call("worker_start", startSky);
        rested = true;
      }
      return turnResult("lead-1", "the sky is building");
    });
    const running = dispatch();
    await until(() => rested, "the lead's first turn to end");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await rig.core.host.dispatch({ type: "run_stop", runId }, 30_000);
    const events = await finished();
    await running;

    const finishedEvent = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finishedEvent.stoppedBecause, "stopped by the user");
    assert.equal(lead.length, 1, "no wrap-up turn after Stop");
    await until(() => aborted > 0, "the worker to be stopped", 30_000);
  });

  it("R8. a job that ends while the lead rests wakes it with the job's one line", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("wake-by-job");
    const lead: DelegateRequest[] = [];
    let rested = false;
    fakeEngine(rig, async (request) => {
      if (!request.director) return hangUntilStopped(request, () => {});
      lead.push(request);
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (lead.length === 1) {
        await call("worker_start", startSky);
        rested = true;
        return turnResult("lead-1", "the sky is building");
      }
      await call("finish", { summary: "the bake failed; stopping here", land: "no" });
      return turnResult("lead-1", "done");
    });
    const running = dispatch();
    await until(() => rested, "the lead's first turn to end");
    const threadId = await rig.core.threadForGame(project.name);
    const job = await rig.core.jobs.start({
      owner: {
        project: project.name,
        chatThreadId: threadId,
        role: JobRole.Lead,
        scope: { kind: JobScopeKind.Run, runId },
      },
      title: "Light bake",
      command: "echo baking; exit 3",
      cwd: rig.core.games.dirFor(project.name),
      policy: { allowedDomains: [], allowLocalBinding: true },
      mode: PermissionMode.Auto,
    });
    const events = await finished();
    await running;

    assert.equal(lead.length, 2, lead.map((t) => t.prompt.slice(0, 60)).join(" | "));
    assert.equal(lead[1]!.resume, "lead-1", "the same session is woken");
    // Flipped: inside a digest, with "read it with job_tail <id>" after it; the job's own line, a fact.
    assert.match(
      lead[1]!.prompt,
      new RegExp(`^job ${job.id} "Light bake" \\(\`echo baking; exit 3\`, started by you\\) failed \\(exit 3\\)`),
    );
    assert.doesNotMatch(lead[1]!.prompt, /job_tail/);
    assert.deepEqual(customEvents(events, "director_continued"), []);
  });
});

describe("live chat during a build", () => {
  /** The session answering the chat once the run is over: the chat's own, with the run's controls. */
  const answersChat = (request: DelegateRequest): boolean =>
    !request.director && Boolean(request.liveTools?.some((t) => t.name === "run_status"));
  /** A message to the game's chat, as the composer sends it, with the bubble id it is queued under. */
  async function say(rig: Rig, project: string, text: string, over: Record<string, unknown> = {}) {
    const thread = await rig.core.threadForGame(project);
    const messageId = `msg_live_${Math.random().toString(36).slice(2, 10)}`;
    await rig.core.sendUserMessage(text, { thread, engine: "codex", clientId: messageId, ...over } as never);
    return { thread, messageId };
  }
  const stateOf = async (rig: Rig, thread: string, messageId: string) =>
    messageQueueState(await rig.core.store.listEvents(thread)).messages.get(messageId);
  /** The lead's words, as its engine reports them: what the chat shows. */
  const speak = (request: DelegateRequest, text: string) =>
    request.onEvent?.({ type: "assistant", payload: { role: "assistant", parts: [{ type: "text", text }] } } as never);
  const aborted = (request: DelegateRequest) =>
    new Promise<void>((resolve) => {
      if (request.signal?.aborted) resolve();
      else request.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  const stopped = (sessionId: string): DelegateResult => ({
    ok: false,
    engine: "codex",
    turns: 1,
    usage: {},
    stopReason: "stopped",
    summary: "",
    sessionId,
  });

  it("L1. a message sent mid-build is delivered to the lead at once and answered in the chat within one wake, while the run keeps running", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("live-answer");
    const lead: Array<{ request: DelegateRequest; at: number }> = [];
    const seen: Record<string, unknown> = {};
    let workersAborted = 0;
    let rested = false;
    fakeEngine(rig, async (request) => {
      if (!request.director) return hangUntilStopped(request, () => workersAborted++);
      lead.push({ request, at: Date.now() });
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (lead.length === 1) {
        await call("worker_start", startSky);
        rested = true;
        return turnResult("lead-1", "the sky is building");
      }
      const log = await rig.core.store.listEvents(await rig.core.threadForGame(project.name));
      seen.runOpen = !customEvents(log, "run_finished").some((e) => e.runId === runId);
      seen.workersAborted = workersAborted;
      speak(request, "Not yet: the sky worker is on its first round.");
      return turnResult("lead-1", "answered");
    });
    const running = dispatch();
    await until(() => rested, "the lead's first turn to end");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const sentAt = Date.now();
    const { thread, messageId } = await say(rig, project.name, "is the sky dusk yet?");
    const receipt = await stateOf(rig, thread, messageId);
    assert.equal(receipt?.state, "delivered", "delivered with its receipt, never Queued under the build");
    assert.equal(receipt?.into, runId);
    await until(() => lead.length === 2, "the lead to be woken with the message");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rig.core.host.dispatch({ type: "run_stop", runId }, 30_000);
    await finished();
    await running;

    const woken = lead[1]!;
    assert.ok(woken.at - sentAt < 10_000, `woken ${woken.at - sentAt} ms after the user spoke`);
    assert.equal(woken.request.resume, "lead-1", "the same session answers");
    // Flipped: under THE USER SAYS; the person's words alone, as they wrote them.
    assert.equal(woken.request.prompt, "is the sky dusk yet?");
    assert.equal(seen.runOpen, true, "the run was still running when the lead answered");
    assert.equal(seen.workersAborted, 0, "a question stops no worker");
    const log = await rig.core.store.listEvents(thread);
    const started = customEvents(log, "autopilot_started").find((e) => e.runId === runId);
    assert.equal(started?.liveChat, true, "the build says its lead takes the chat, so the composer can say so");
    assert.equal(started?.workerRecords, true, "the run says from its start that its workers leave records");
    const startIndex = log.findIndex(
      (event) =>
        customRecord(event.data)?.event_type === CustomEvent.AutopilotStarted &&
        customRecord(event.data)?.payload.runId === runId,
    );
    const fromItsStart = buildRunGraph(log.slice(0, startIndex + 1), runId);
    assert.equal(fromItsStart?.tree, true, "a tree before any worker starts: the lead never moves");
    // No finish check until the lead asks a reviewer (flipped: it was drawn from the start).
    assert.deepEqual(
      fromItsStart?.nodes.map((node) => node.kind),
      [GraphNodeKind.Run, GraphNodeKind.Base, GraphNodeKind.Lead, GraphNodeKind.Integration, GraphNodeKind.Final],
    );
    assert.equal(customEvents(log, "run_registered").length, 1, "no second run started");
    assert.equal(customEvents(log, "coordinator_message_processing").length, 0, "never a turn of its own");
    const said = toEntries(deliveryOrder(log)).flatMap((e) => (e.kind === "assistant" ? [e.text] : []));
    assert.ok(said.includes("Not yet: the sky worker is on its first round."), JSON.stringify(said));
  });

  it("L2. a message sent while the lead is mid-turn is steered into that turn: interrupted and resumed in the same session, words first", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("live-interrupt");
    const lead: DelegateRequest[] = [];
    let rested = false;
    let working = false;
    fakeEngine(rig, async (request) => {
      if (!request.director) return hangUntilStopped(request, () => {});
      lead.push(request);
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (lead.length === 1) {
        await call("worker_start", startSky);
        rested = true;
        return turnResult("lead-1", "the sky is building");
      }
      if (lead.length === 2) {
        // A long look at the build: the user speaks again while it runs.
        working = true;
        await aborted(request);
        return stopped("lead-1");
      }
      speak(request, "Red it is: the sky worker gets it next.");
      return turnResult("lead-1", "on it");
    });
    const running = dispatch();
    await until(() => rested, "the lead's first turn to end");
    await say(rig, project.name, "how is it going?");
    await until(() => working, "the lead's second turn to start");
    const { thread, messageId } = await say(rig, project.name, "make the sky red instead");
    assert.equal((await stateOf(rig, thread, messageId))?.state, "delivered");
    await until(() => lead.length === 3, "the lead to be resumed with the message");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rig.core.host.dispatch({ type: "run_stop", runId }, 30_000);
    const events = await finished();
    await running;

    const resumed = lead[2]!;
    assert.equal(resumed.resume, "lead-1", "the same session, resumed");
    // Flipped: resumed with the person's words alone, as they wrote them.
    assert.match(resumed.prompt, /(^|\n\n)make the sky red instead(\n\n|$)/);
    assert.doesNotMatch(resumed.prompt, /THE USER SAYS|cut short/i);
    assert.doesNotMatch(resumed.prompt, /Your last turn failed/, "an interrupted turn is not a failed one");
    assert.doesNotMatch(resumed.prompt, /starts the wrap-up now/, "nor the start of a wrap-up");
    const finishedEvent = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finishedEvent.stoppedBecause, "stopped by the user", "it ran until the user stopped it");
  });

  /*
   * The golf game's lead: Codex continuing the chat's own session, whose first turn ran on while
   * "stop" sat unread for its whole 45 minutes. Its very first turn is cut for the words now.
   */
  it("L10. a lead continuing the chat's own session is cut short in its first turn for a stop, and resumed with the words alone", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("live-first-cut");
    // The chat already talked to Codex: the run's lead continues that session from its first turn.
    await rig.core.append(
      [
        {
          type: "custom",
          event_type: "contractor_session",
          payload: { project: project.name, engine: "codex", sessionId: "chat-1" },
        },
      ],
      await rig.core.threadForGame(project.name),
    );
    const lead: DelegateRequest[] = [];
    let working = false;
    fakeEngine(rig, async (request) => {
      if (!request.director) return hangUntilStopped(request, () => {});
      lead.push(request);
      if (lead.length === 1) {
        // Its first turn, on the brief, works on and on.
        working = true;
        await aborted(request);
        return stopped("chat-1");
      }
      speak(request, "Stopping: wrapping the build up.");
      return turnResult("chat-1", "wrapping up");
    });
    const running = dispatch();
    await until(() => working, "the lead's first turn to start");
    const { thread, messageId } = await say(rig, project.name, "stop the build");
    assert.equal((await stateOf(rig, thread, messageId))?.state, "delivered");
    await until(() => lead.length === 2, "the first turn to be cut and resumed with the message");
    await rig.core.host.dispatch({ type: "run_stop", runId }, 30_000);
    await finished();
    await running;

    assert.equal(lead[0]?.resume, "chat-1", "the first turn continues the chat's own session");
    const resumed = lead[1];
    assert.equal(resumed?.resume, "chat-1", "the same session, resumed");
    // Flipped: the person's words alone; that a stop is wrap_up is said once, in wrap_up's own description.
    assert.match(String(resumed?.prompt), /(^|\n\n)stop the build(\n\n|$)/);
  });

  /*
   * castle-artillery: a Claude Code lead read "How is it going?" mid-turn, beside a tool's result,
   * and built on with no word back. The person's words now cut its turn as they cut any engine's.
   */
  it("L3. the person's message cuts the running turn of an engine that reads input mid-turn too, and the next turn opens with it alone", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("live-native", { engine: "claude-code" });
    const lead: DelegateRequest[] = [];
    const handed: string[] = [];
    let rested = false;
    let listening = false;
    rig.core.engines.register({
      id: "claude-code",
      label: "Claude",
      kind: "delegated",
      steersMidTurn: true,
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        if (!request.director) return hangUntilStopped(request, () => {});
        lead.push(request);
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        if (lead.length === 1) {
          await call("worker_start", startSky);
          rested = true;
          return turnResult("lead-1", "the sky is building");
        }
        if (lead.length > 2) {
          speak(request, "Fog too, then.");
          return turnResult("lead-1", "fog too");
        }
        assert.ok(request.steer, "the lead's turn is open to the chat");
        // The session's own input mid-turn is open: the person's words must not come in through it.
        request.steer.ready((message) => {
          handed.push(message.text);
          return true;
        });
        listening = true;
        await aborted(request);
        return stopped("lead-1");
      },
    } as never);
    const running = dispatch();
    await until(() => rested, "the lead's first turn to end");
    await say(rig, project.name, "how is it going?", { engine: "claude-code" });
    await until(() => listening, "the lead's second turn to start");
    await say(rig, project.name, "add some fog", { engine: "claude-code" });
    // A message read mid-turn ends the wait at once, for the assertion below to name it.
    await until(
      () => lead.length >= 3 || handed.length > 0,
      "the turn to be cut and its session resumed with the message",
    );
    // Long enough for a poll of the resting lead's inbox to have woken it again, had it not heard.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await rig.core.host.dispatch({ type: "run_stop", runId }, 30_000);
    await finished();
    await running;

    // Flipped (castle-artillery): read in the running turn, with no cut and no second turn. Now cut.
    assert.deepEqual(handed, [], "never read mid-turn, beside a tool's result");
    assert.equal(lead.length, 3, "cut once and resumed once: no wake after it");
    const resumed = lead[2];
    assert.equal(resumed?.resume, "lead-1", "the same session, resumed");
    // Alone: neither what woke the cut turn ("how is it going?") nor that the turn failed is said again.
    assert.equal(resumed?.prompt, "add some fog", "the person's words alone, as they wrote them");
    assert.equal(resumed?.from, MessageFrom.Person, "the person's own message, not Genex's");
  });

  it("L4. Stop mid-build still hands over to the oldest queued message: a slash command waits for the chat", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("live-stop");
    const lead: DelegateRequest[] = [];
    const chats: DelegateRequest[] = [];
    let rested = false;
    fakeEngine(rig, async (request) => {
      if (answersChat(request)) {
        chats.push(request);
        return turnResult(request.resume ?? "chat", "Reviewed.");
      }
      if (!request.director) return hangUntilStopped(request, () => {});
      lead.push(request);
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      await call("worker_start", startSky);
      rested = true;
      return turnResult("lead-1", "the sky is building");
    });
    const running = dispatch();
    await until(() => rested, "the lead's first turn to end");
    // Flipped: a picture reaches the lead now, alone too (LM1, LM4); a slash command waits for the chat.
    const { thread, messageId } = await say(rig, project.name, "/review");
    assert.equal((await stateOf(rig, thread, messageId))?.state, "queued", "a command waits for the chat");
    await rig.core.stopThread(thread);
    const events = await finished();
    await running;
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "coordinator_message_handled").some((e) => e.messageId === messageId),
      60_000,
      "the queued message to be answered",
    );

    const finishedEvent = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finishedEvent.stoppedBecause, "stopped by the user");
    assert.equal(lead.length, 1, "no turn of the lead after Stop");
    assert.equal(chats.length, 1, "the chat answers the message that waited");
    assert.equal(chats[0]!.resume, "lead-1", "the session that led the run");
    // Flipped: the command opened a brief; it goes alone, as the person sent it.
    assert.equal(chats[0]!.prompt, "/review", "the command the person sent");
  });

  it("L7. a run that crashes gives back what its lead never heard before the run closes: the chat keeps it Queued, and answers it", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("live-crash");
    const chats: DelegateRequest[] = [];
    let working = false;
    let handed = () => {};
    const sent = new Promise<void>((resolve) => {
      handed = resolve;
    });
    fakeEngine(rig, async (request) => {
      if (answersChat(request)) {
        chats.push(request);
        return turnResult(request.resume ?? "chat", "The run stopped on a problem; the sky is not dusk yet.");
      }
      if (!request.director) return hangUntilStopped(request, () => {});
      // The lead's first turn fails outright after the user spoke to it: the run's crash close.
      working = true;
      await sent;
      throw new Error("the provider broke");
    });
    const running = dispatch();
    await until(() => working, "the lead's first turn to start");
    const { thread, messageId } = await say(rig, project.name, "is the sky dusk yet?");
    assert.equal((await stateOf(rig, thread, messageId))?.state, "delivered");
    handed();
    await finished();
    await running;
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "coordinator_message_handled").some((e) => e.messageId === messageId),
      60_000,
      "the message to be answered after the crash",
    );

    const log = await rig.core.store.listEvents(thread);
    const custom = (e: (typeof log)[number]) => (e.data.type === "custom" ? (e.data as Record<string, any>) : null);
    const index = (type: string, match: (payload: Record<string, unknown>) => boolean) =>
      log.findIndex((e) => custom(e)?.event_type === type && match(custom(e)!.payload ?? {}));
    const back = index("coordinator_message_requeued", (p) => p.messageId === messageId);
    const closedAt = index("run_finished", (p) => p.runId === runId);
    assert.ok(back >= 0, "the lead never heard it: it went back to the chat");
    assert.ok(back < closedAt, `given back (${back}) before the run closed (${closedAt})`);
    // The paged chat's state up to the close: the message still waits, with its words.
    const context = chatContext([], log.slice(0, closedAt + 1));
    assert.ok(
      context.some(
        (e) => custom(e)?.event_type === "coordinator_message_queued" && custom(e)!.payload?.messageId === messageId,
      ),
      "Queued in the paged chat, not settled with the run",
    );
    assert.equal(chats.length, 1, "the chat answered it");
    assert.match(chats[0]!.prompt, /is the sky dusk yet\?/);
  });

  it("L9. a run stopped while it prepares gives back what its lead never heard before it closes, and the chat answers it", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    // Flipped (Loop phase 5): no starting point is built before the lead any more; the run's start
    // is held here by a plugin's start step (run.prepare) that waits until the test lets it go.
    let skew = 0;
    const rig = await startRig(
      { replies: [] },
      {
        previewPoolMax: 3,
        createHeadlessPreview: async () => makeFakePreview(),
        locks: {
          now: () => Date.now() + skew,
          sleep: async (ms: number) => {
            skew += ms;
            await nextTurn();
          },
        },
      },
    );
    rigs.push(rig);
    const stage = await stagePackage();
    await rig.core.plugins.installLocal(stage.dir, PluginSourceKind.Local, []);
    await rig.core.plugins.setEnabled(STAGE_PLUGIN, true);
    const gate = path.join(await tmpDir("live-stop-gate-"), "go");
    await stage.script({ "run.prepare:gate": { until: gate } });
    const project = await rig.core.games.scaffold("live-stop-early", { title: "live-stop-early" });
    const runId = rig.core.newRunId();
    const chats: DelegateRequest[] = [];
    fakeEngine(rig, async (request) => {
      if (answersChat(request)) {
        chats.push(request);
        return turnResult(request.resume ?? "chat", "Stopped before it started; nothing was built.");
      }
      return turnResult("lead-1", "planned");
    });
    const running = rig.core
      .dispatchRun({
        runId,
        goal: "a dusk plaza",
        project: project.name,
        mode: "autopilot",
        engine: "codex",
        reference: { name: "Dusk", shots: [] },
        budgets: { wallClockMs: 15 * 60_000 },
      } as never)
      .catch(() => {});
    for (let tries = 0; tries < 600 && !(await stage.trail()).includes("run.prepare:gate"); tries++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const { thread, messageId } = await say(rig, project.name, "use the red palette");
    assert.equal((await stateOf(rig, thread, messageId))?.state, "delivered", "the lead's line took it");
    await rig.core.host.dispatch({ type: "run_stop", runId }, 30_000);
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      150_000,
      "the stopped run to close",
    );
    await writeFile(gate, "");
    await running;
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "coordinator_message_handled").some((e) => e.messageId === messageId),
      60_000,
      "the message to be answered after the stopped run",
    );
    const log = await rig.core.store.listEvents(thread);
    const at = (type: string, match: (payload: Record<string, unknown>) => boolean) =>
      log.findIndex(
        (e) =>
          e.data.type === "custom" &&
          e.data.event_type === type &&
          match((e.data.payload ?? {}) as Record<string, unknown>),
      );
    const back = at("coordinator_message_requeued", (p) => p.messageId === messageId);
    const closedAt = at("run_finished", (p) => p.runId === runId);
    assert.ok(back >= 0, "the lead never heard it: it went back to the chat");
    assert.ok(back < closedAt, `given back (${back}) before the run closed (${closedAt})`);
    assert.equal(chats.length, 1, "the chat answered it");
  });
});

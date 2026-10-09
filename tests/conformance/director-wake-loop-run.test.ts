/**
 * The wake loop through the real core and harness (loop/director/wake.ts): a scripted lead ends
 * its turn after each decision, and the studio wakes the same session when its worker ends, when
 * the user speaks, when the user answers a plan they asked to read — and never after Stop. The
 * long turn it replaced stays one field away (`directorLoop: "turn"`).
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DelegateRequest, DelegateResult, LiveToolResult } from "../../src/substrate/engines/types.ts";
import {
  customEvents,
  type FakePreview,
  makeFakePreview,
  startRig,
  waitForLog,
  type Rig,
} from "../helpers/studio-rig.ts";
import { messageQueueState } from "../../src/shared/message-queue.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { buildRunGraph, GraphNodeKind } from "../../src/renderer/run-graph.ts";
import { CustomEvent, customRecord } from "../../src/shared/custom-events.ts";
import { deliveryOrder } from "../../src/renderer/chat/delivery-order.ts";
import { chatContext } from "../../src/shared/chat-history.ts";
import { JobRole, JobScopeKind } from "../../src/shared/jobs.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";

/** No run here may hang the suite: each is over in well under a minute when it works. */
const RIG_TIMEOUT_MS = 240_000;
const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.stop().catch(() => {})));
});

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);
const json = (result: LiveToolResult): Record<string, any> => JSON.parse(text(result));

/** Poll until it holds, or say what was still false when the clock ran out. */
async function until(condition: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The plan every scripted lead writes before its first worker, as a real one must. */
const plan = {
  summary: "This run: a dusk sky over the plaza.",
  workers: JSON.stringify([
    { id: "sky", title: "Dusk sky", seam: "the sky", owns: "src/sky.js", done: ["the sky reads as dusk"], minutes: 20 },
  ]),
  base: "the integration branch as it stands",
  risks: "one window at a time on this machine",
};
const startSky = {
  id: "sky",
  title: "Dusk sky",
  brief: "Build a dusk sky",
  mode: "single",
  minutes: "5",
  owns: "src/sky.js",
};

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
  it("R1. a lead that ends its turn is woken in the same session by its worker's end, with the news on top", {
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
          await call("plan", plan);
          results.started = json(await call("worker_start", startSky));
          turnOneReturned();
          return turnResult("lead-1", "the sky is building");
        }
        results.integrated = json(await call("integrate", { worker: "sky" }));
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
    assert.match(woken, /WHAT HAPPENED/);
    assert.match(woken, /worker sky done/);
    const at = ["WHAT HAPPENED", "WHERE THE RUN STANDS", "BUILD CARD"].map((mark) => woken.indexOf(mark));
    assert.ok(at[0]! >= 0 && at[0]! < at[1]! && at[1]! < at[2]!, `in order: ${JSON.stringify(at)}\n${woken}`);
    assert.ok(!woken.includes(path.join("autopilot", runId)), "no worktree path in the digest");
    for (const turn of lead)
      assert.ok(!(turn.liveTools ?? []).some((t) => t.name === "wait"), "a waking lead is offered no wait");
    assert.ok(
      (lead[0]!.liveTools ?? []).some((t) => t.name === "worker_start"),
      "and still has the rest of its run tools",
    );
    const continued = customEvents(events, "director_continued").filter((e) => e.runId === runId);
    assert.equal(continued.length, 1, JSON.stringify(continued));
    assert.ok((continued[0]!.reasons as string[]).includes("worker_ended"), JSON.stringify(continued[0]));
    const finishedEvent = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finishedEvent.stoppedBecause, "the director finished the run");
    assert.equal(results.integrated.merged, true, JSON.stringify(results.integrated));

    const threadId = await rig.core.threadForGame(project.name);
    const journal = (await rig.core.store.readArtifact(threadId, `autopilot_${runId}`)) as Record<string, any>;
    assert.equal(journal.director.workers.sky.brief, "Build a dusk sky");
    // The run's own clock is the run's record, not the wake loop's (journal.ts; it moved from `wake.clock`).
    assert.match(String(journal.director.clock.finalDeadline), /^\d{4}-\d\d-\d\dT/);
  });

  it("R2. a user's message wakes a sleeping lead within seconds, word for word, at the top", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("wake-by-user");
    const lead: Array<{ request: DelegateRequest; at: number }> = [];
    const results: Record<string, any> = {};
    let rested = false;
    fakeEngine(rig, async (request) => {
      if (!request.director) return hangUntilStopped(request, () => {});
      lead.push({ request, at: Date.now() });
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (lead.length === 1) {
        await call("plan", plan);
        await call("worker_start", startSky);
        rested = true;
        return turnResult("lead-1", "the sky is building");
      }
      // A kept playbook may still call wait by name: the steer it was woken with is not said again.
      results.waited = json(await call("wait", { seconds: "1" }));
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
    const woken = lead[1]!.request.prompt;
    const says = woken.indexOf("THE USER SAYS");
    const words = woken.indexOf("make the sky red");
    assert.ok(says >= 0 && says < words && words < woken.indexOf("WHAT HAPPENED"), woken);
    assert.equal(lead[1]!.request.resume, "lead-1");
    assert.ok(
      !(results.waited.happened as string[]).some((line) => line.includes("make the sky red")),
      JSON.stringify(results.waited.happened),
    );
  });

  it("R3. the plan window is a timer: worker_start answers at once and the lead is woken when the user answers", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("wake-plan-window", { reviewPlan: true });
    const lead: DelegateRequest[] = [];
    const results: Record<string, any> = {};
    let rested = false;
    fakeEngine(rig, async (request) => {
      if (!request.director) return hangUntilStopped(request, () => {});
      lead.push(request);
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (lead.length === 1) {
        results.planned = text(await call("plan", plan));
        const at = Date.now();
        results.held = text(await call("worker_start", startSky));
        results.heldMs = Date.now() - at;
        rested = true;
        return turnResult("lead-1", "waiting for the user's word");
      }
      results.started = json(await call("worker_start", startSky));
      await call("finish", { summary: "started on the user's go", land: "no" });
      return turnResult("lead-1", "done");
    });
    const running = dispatch();
    await until(() => rested, "the lead's first turn to end");
    await rig.core.runFeedback({ threadId: await rig.core.threadForGame(project.name), runId, text: "go ahead" });
    const events = await finished();
    await running;

    assert.match(results.planned, /waits for their word — up to \d+ min/, results.planned);
    assert.ok(results.heldMs < 10_000, `worker_start answered in ${results.heldMs} ms`);
    assert.match(results.held, /End your turn/, results.held);
    assert.equal(lead.length, 2);
    assert.match(lead[1]!.prompt, /THE USER SAYS[\s\S]*go ahead/);
    assert.equal(results.started.started, "sky", JSON.stringify(results.started));
    const decisions = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.decision));
    assert.equal(decisions.filter((d) => /plan review: the user said go/.test(d)).length, 1, decisions.join(" | "));
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
        await call("plan", plan);
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

  it("R8. a job that ends while the lead rests is in its next digest", { timeout: RIG_TIMEOUT_MS }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("wake-by-job");
    const lead: DelegateRequest[] = [];
    let rested = false;
    fakeEngine(rig, async (request) => {
      if (!request.director) return hangUntilStopped(request, () => {});
      lead.push(request);
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (lead.length === 1) {
        await call("plan", plan);
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
    const woken = lead[1]!.prompt;
    assert.match(woken, /Light bake \(`echo baking; exit 3`, started by you\) failed \(exit 3\)/, woken);
    assert.match(woken, new RegExp(`read it with job_tail ${job.id}`));
    const continued = customEvents(events, "director_continued").filter((e) => e.runId === runId);
    assert.ok(((continued[0]?.reasons ?? []) as string[]).includes("job_ended"), JSON.stringify(continued));
  });

  it("R7. a Stop while the run prepares opens no lead session: the run closes as stopped", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    /** The empty scaffold as a window sees it, so the run builds a starting point first. */
    const asEmptyScaffold = (preview: FakePreview): FakePreview => {
      preview.pixelStatsNext = { width: 800, height: 600, sampled: 480_000, meanLuma: 0, litFraction: 0, canvas: true };
      preview.evaluations.push({ match: "isScene", value: true }, { match: "matrixWorld", value: "[1,0,0,1]" });
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => asEmptyScaffold(makeFakePreview()) },
    );
    rigs.push(rig);
    asEmptyScaffold(rig.preview);
    const project = await rig.core.games.scaffold("wake-stop-early", { title: "wake-stop-early" });
    const runId = rig.core.newRunId();
    const lead: DelegateRequest[] = [];
    let baseStarted = false;
    fakeEngine(rig, async (request) => {
      if (request.director) {
        lead.push(request);
        return turnResult("lead-1", "planned");
      }
      baseStarted = true;
      return hangUntilStopped(request, () => {});
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
    await until(() => baseStarted, "the starting point to be building");
    await rig.core.host.dispatch({ type: "run_stop", runId }, 30_000);
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      150_000,
      "the stopped run to close",
    );
    await running;
    assert.equal(lead.length, 0, "no lead session opens after the Stop");
    const closed = customEvents(events, "run_finished").find((e) => e.runId === runId);
    assert.equal(closed?.stoppedBecause, "stopped by the user");
  });
});

describe("the long turn, one field away", () => {
  it("R6. a shipped build's way back: STUDIO_DIRECTOR_LOOP=turn in the studio's environment runs the long turn", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    // Set before the rig starts: the studio hands it to the harness it spawns.
    const before = process.env.STUDIO_DIRECTOR_LOOP;
    process.env.STUDIO_DIRECTOR_LOOP = "turn";
    try {
      const { rig, dispatch, finished } = await loopRun("env-turn");
      const lead: DelegateRequest[] = [];
      const results: Record<string, string> = {};
      fakeEngine(rig, async (request) => {
        if (!request.director) return turnResult("worker", "nothing");
        lead.push(request);
        results.finished = text(await request.onLiveTool!("finish", { summary: "nothing to do", land: "no" }));
        return turnResult("env-session", "done");
      });
      const running = dispatch();
      await finished();
      await running;

      assert.equal(lead.length, 1);
      assert.ok(
        (lead[0]!.liveTools ?? []).some((t) => t.name === "worker_wait"),
        "the long turn's wait",
      );
      assert.match(lead[0]!.prompt, /`worker_wait` is your loop/);
      assert.match(results.finished, /run is closed/, results.finished);
    } finally {
      if (before === undefined) delete process.env.STUDIO_DIRECTOR_LOOP;
      else process.env.STUDIO_DIRECTOR_LOOP = before;
    }
  });

  it("R5. the old loop stays behind directorLoop: turn", { timeout: RIG_TIMEOUT_MS }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("turn-loop", {
      directorLoop: "turn",
      reference: { name: "Dusk", kind: "direction", shots: [] },
      budgets: { wallClockMs: 3_600_000 },
    });
    const lead: DelegateRequest[] = [];
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (!request.director) {
        await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'dusk';\n");
        return turnResult("worker", "Dusk sky");
      }
      lead.push(request);
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (lead.length === 1) {
        assert.match(text(await call("finish", { summary: "too early", land: "yes" })), /finish refused/);
        return turnResult("timed-session", "First playable");
      }
      // The user's Finish, where the run's inbox reads it: the game's own thread.
      await rig.core.append(
        [{ type: "custom", event_type: "run_control", payload: { runId, action: "finish" } }],
        await rig.core.threadForGame(project.name),
      );
      results.finished = text(await call("finish", { summary: "Stopped early at the user’s request", land: "no" }));
      return turnResult("timed-session", "Finished as requested");
    });
    const running = dispatch();
    const events = await finished();
    await running;

    assert.equal(lead.length, 2);
    assert.match(results.finished, /run is closed/, results.finished);
    // The long turn is told its own loop — `worker_wait`, the one worker model's name for its old
    // `wait` — and nothing of the wake loop's, playbook included.
    assert.match(lead[0]!.prompt, /`worker_wait` is your loop/);
    assert.doesNotMatch(lead[0]!.prompt, /end your turn/i);
    assert.doesNotMatch(lead[0]!.prompt, /asked once what next/i);
    assert.ok(lead[1]!.prompt.startsWith("The timed build still has"), lead[1]!.prompt.slice(0, 120));
    assert.ok(
      (lead[0]!.liveTools ?? []).some((t) => t.name === "worker_wait"),
      "the long turn still has its wait",
    );
    const continued = customEvents(events, "director_continued").filter((e) => e.runId === runId);
    assert.equal(continued.length, 1);
    assert.equal(continued[0]!.reasons, undefined, "the long turn's continuation carries no wake reasons");
  });
});

/**
 * Live chat during a build: a message sent to the game's chat while a run's lead works is
 * handed to that lead at once — delivered, never Queued under the build — and the lead answers in
 * the chat. A lead in the middle of a turn hears it in that turn: read at its next step by an
 * engine that takes input mid-turn, or interrupted and resumed in the same session with the
 * user's words in front. Stop still hands over to what waits; the long turn keeps its queue. After
 * the close the chat's own session answers what waited — the one the lead was — never a coordinator.
 */
describe("live chat during a build", () => {
  /** The session answering the chat once the run is over: a coordinator, or the chat's own with the run's controls. */
  const answersChat = (request: DelegateRequest): boolean =>
    !request.director && Boolean(request.coordinator || request.liveTools?.some((t) => t.name === "run_status"));
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
    const coordinators: DelegateRequest[] = [];
    const seen: Record<string, unknown> = {};
    let workersAborted = 0;
    let rested = false;
    fakeEngine(rig, async (request) => {
      if (request.coordinator) {
        coordinators.push(request);
        return turnResult("coordinator", "answered by the chat");
      }
      if (!request.director) return hangUntilStopped(request, () => workersAborted++);
      lead.push({ request, at: Date.now() });
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (lead.length === 1) {
        await call("plan", plan);
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
    assert.match(woken.request.prompt, /THE USER SAYS[\s\S]*is the sky dusk yet\?/);
    assert.equal(seen.runOpen, true, "the run was still running when the lead answered");
    assert.equal(seen.workersAborted, 0, "a question stops no worker");
    assert.equal(coordinators.length, 0, "the lead answered, not a coordinator after the build");
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
    assert.deepEqual(
      fromItsStart?.nodes.map((node) => node.kind),
      [
        GraphNodeKind.Run,
        GraphNodeKind.Base,
        GraphNodeKind.Lead,
        GraphNodeKind.Integration,
        GraphNodeKind.Final,
        GraphNodeKind.FinishCheck,
      ],
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
        await call("plan", plan);
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
    assert.match(resumed.prompt, /THE USER SAYS[\s\S]*make the sky red instead/);
    assert.doesNotMatch(resumed.prompt, /Your last turn failed/, "an interrupted turn is not a failed one");
    assert.doesNotMatch(resumed.prompt, /starts the wrap-up now/, "nor the start of a wrap-up");
    const continued = customEvents(events, "director_continued").filter((e) => e.runId === runId);
    assert.ok(
      continued.every((e) => (e.reasons as string[]).includes("user_message")),
      JSON.stringify(continued),
    );
    const finishedEvent = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finishedEvent.stoppedBecause, "stopped by the user", "it ran until the user stopped it");
  });

  it("L3. an engine that reads input mid-turn takes the message in the running turn, and it is not said again", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("live-native", { engine: "claude-code" });
    const lead: DelegateRequest[] = [];
    const handed: string[] = [];
    let rested = false;
    let listening = false;
    let heard = () => {};
    const heardOne = new Promise<void>((resolve) => {
      heard = resolve;
    });
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
          await call("plan", plan);
          await call("worker_start", startSky);
          rested = true;
          return turnResult("lead-1", "the sky is building");
        }
        if (lead.length > 2) return turnResult("lead-1", "nothing new");
        assert.ok(request.steer, "the lead's turn is open to the chat");
        let id = "";
        request.steer.ready((message) => {
          handed.push(message.text);
          id = message.id;
          heard();
          return true;
        });
        listening = true;
        await heardOne;
        request.onEvent?.({ type: "steer_delivered", payload: { id } });
        speak(request, "Fog too, then.");
        return { ...turnResult("lead-1", "fog too"), steered: [id] };
      },
    } as never);
    const running = dispatch();
    await until(() => rested, "the lead's first turn to end");
    await say(rig, project.name, "how is it going?", { engine: "claude-code" });
    await until(() => listening, "the lead's second turn to start");
    await say(rig, project.name, "add some fog", { engine: "claude-code" });
    await until(() => handed.length === 1, "the message to reach the running turn");
    // Long enough for a poll of the resting lead's inbox to have woken it again, had it not heard.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await rig.core.host.dispatch({ type: "run_stop", runId }, 30_000);
    await finished();
    await running;

    assert.equal(lead.length, 2, "read in the running turn: no interrupt, no second wake");
    assert.match(handed[0]!, /THE USER SAYS[\s\S]*add some fog/);
    assert.doesNotMatch(handed[0]!, /how is it going/, "what the lead was woken with is not said again");
  });

  it("L4. Stop mid-build still hands over to the oldest queued message: a picture waits for the chat", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("live-stop");
    const lead: DelegateRequest[] = [];
    const chats: DelegateRequest[] = [];
    let rested = false;
    fakeEngine(rig, async (request) => {
      if (answersChat(request)) {
        chats.push(request);
        return turnResult(request.resume ?? "chat", "I see the picture.");
      }
      if (!request.director) return hangUntilStopped(request, () => {});
      lead.push(request);
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      await call("plan", plan);
      await call("worker_start", startSky);
      rested = true;
      return turnResult("lead-1", "the sky is building");
    });
    const running = dispatch();
    await until(() => rested, "the lead's first turn to end");
    const picture = { label: "ref", mimeType: "image/png", data: "iVBORw0KGgo=" };
    const { thread, messageId } = await say(rig, project.name, "does it look like this?", { frames: [picture] });
    assert.equal((await stateOf(rig, thread, messageId))?.state, "queued", "a picture waits for the chat");
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
    assert.equal(chats[0]!.coordinator, undefined, "in its own session, not a coordinator's");
    assert.equal(chats[0]!.resume, "lead-1", "the session that led the run");
    assert.match(chats[0]!.prompt, /does it look like this\?/);
    assert.equal(chats[0]!.images?.[0]?.data, "iVBORw0KGgo=", "with the picture");
  });

  it("L6. the chat is free as soon as the run closes: a message during its self-improvement pass is answered then", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("live-learning");
    const chats: DelegateRequest[] = [];
    let learning = () => {};
    const learned = new Promise<void>((resolve) => {
      learning = resolve;
    });
    let learningAsked = false;
    // The pass after the run starts by asking whether to learn: held here until the test lets it go.
    // (The run asks too, before it closes; those answers are not held.)
    const api = rig.core.host.options.api as Record<string, (params: unknown) => Promise<unknown>>;
    const closed = async () =>
      customEvents(await rig.core.listAllEvents(), "run_finished").some((e) => e.runId === runId);
    api["learning.enabled"] = async () => {
      if (!(await closed())) return false;
      learningAsked = true;
      await learned;
      return false;
    };
    fakeEngine(rig, async (request) => {
      if (answersChat(request)) {
        chats.push(request);
        return turnResult(request.resume ?? "chat", "It finished with nothing to build.");
      }
      if (!request.director) return turnResult("worker", "nothing");
      await request.onLiveTool!("finish", { summary: "nothing to do", land: "no" });
      return turnResult("lead-1", "done");
    });
    const running = dispatch();
    try {
      await finished();
      await until(() => learningAsked, "the run's self-improvement pass to begin");
      const { thread, messageId } = await say(rig, project.name, "what did you finish?");
      await waitForLog(
        rig.core,
        (log) => customEvents(log, "coordinator_message_handled").some((e) => e.messageId === messageId),
        20_000,
        "the message to be answered while the pass still runs",
      );
      assert.equal(chats.length, 1, "the chat answered after the run closed, not after its pass");
      assert.equal(chats[0]!.coordinator, undefined, "in its own session, not a coordinator's");
      assert.equal(chats[0]!.resume, "lead-1", "the session that led the run");
      const log = await rig.core.store.listEvents(thread);
      assert.ok(customEvents(log, "run_finished").some((e) => e.runId === runId));
    } finally {
      learning();
      await running;
    }
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
    assert.equal(chats[0]!.coordinator, undefined, "in its own session, not a coordinator's");
    assert.match(chats[0]!.prompt, /is the sky dusk yet\?/);
  });

  it("L9. a run stopped while it prepares gives back what its lead never heard before it closes, and the chat answers it", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    /** The empty scaffold as a window sees it, so the run builds a starting point first. */
    const asEmptyScaffold = (preview: FakePreview): FakePreview => {
      preview.pixelStatsNext = { width: 800, height: 600, sampled: 480_000, meanLuma: 0, litFraction: 0, canvas: true };
      preview.evaluations.push({ match: "isScene", value: true }, { match: "matrixWorld", value: "[1,0,0,1]" });
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => asEmptyScaffold(makeFakePreview()) },
    );
    rigs.push(rig);
    asEmptyScaffold(rig.preview);
    const project = await rig.core.games.scaffold("live-stop-early", { title: "live-stop-early" });
    const runId = rig.core.newRunId();
    const chats: DelegateRequest[] = [];
    let baseStarted = false;
    fakeEngine(rig, async (request) => {
      if (answersChat(request)) {
        chats.push(request);
        return turnResult(request.resume ?? "chat", "Stopped before it started; nothing was built.");
      }
      if (request.director) return turnResult("lead-1", "planned");
      baseStarted = true;
      return hangUntilStopped(request, () => {});
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
    await until(() => baseStarted, "the starting point to be building");
    const { thread, messageId } = await say(rig, project.name, "use the red palette");
    assert.equal((await stateOf(rig, thread, messageId))?.state, "delivered", "the lead's line took it");
    await rig.core.host.dispatch({ type: "run_stop", runId }, 30_000);
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      150_000,
      "the stopped run to close",
    );
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

  it("L8. Stop while a new build waits out the last run's learning pass stops that build too", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("live-learning-stop");
    let learning = () => {};
    const learned = new Promise<void>((resolve) => {
      learning = resolve;
    });
    let learningAsked = false;
    const api = rig.core.host.options.api as Record<string, (params: unknown) => Promise<unknown>>;
    const closed = async () =>
      customEvents(await rig.core.listAllEvents(), "run_finished").some((e) => e.runId === runId);
    api["learning.enabled"] = async () => {
      if (!(await closed())) return false;
      learningAsked = true;
      await learned;
      return false;
    };
    fakeEngine(rig, async (request) => {
      if (!request.director) return turnResult("worker", "nothing");
      await request.onLiveTool!("finish", { summary: "nothing to do", land: "no" });
      return turnResult("lead-1", "done");
    });
    const running = dispatch();
    const thread = await rig.core.threadForGame(project.name);
    const second = rig.core.newRunId();
    try {
      await finished();
      await until(() => learningAsked, "the run's self-improvement pass to begin");
      // A second build for the same game: it waits for the pass to end.
      void rig.core.host
        .dispatch(
          {
            type: "run_start",
            threadId: thread,
            run: {
              runId: second,
              goal: "a dusk plaza, again",
              project: project.name,
              mode: "autopilot",
              engine: "codex",
              reference: { name: "Dusk", shots: [] },
              budgets: { wallClockMs: 15 * 60_000 },
            },
          } as never,
          120_000,
        )
        .catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await rig.core.stopThread(thread);
    } finally {
      learning();
      await running;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const log = await rig.core.store.listEvents(thread);
    assert.ok(
      !customEvents(log, "run_registered").some((e) => e.runId === second),
      "the build that waited on the pass was stopped with it",
    );
  });

  it("L5. the long turn keeps the old way: a message waits for the run, and the chat answers it after", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, project, runId, dispatch, finished } = await loopRun("live-old-loop", { directorLoop: "turn" });
    const lead: DelegateRequest[] = [];
    const coordinators: DelegateRequest[] = [];
    let started = false;
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    fakeEngine(rig, async (request) => {
      if (request.coordinator) {
        coordinators.push(request);
        return turnResult("coordinator", "It finished: a dusk sky.");
      }
      if (!request.director) return hangUntilStopped(request, () => {});
      lead.push(request);
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      await call("plan", plan);
      await call("worker_start", startSky);
      started = true;
      await released;
      await call("finish", { summary: "a dusk sky", land: "no" });
      return turnResult("timed-session", "done");
    });
    const running = dispatch();
    await until(() => started, "the long turn to start its worker");
    const { thread, messageId } = await say(rig, project.name, "is it done?");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal((await stateOf(rig, thread, messageId))?.state, "queued", "the long turn's run keeps its queue");
    assert.equal(coordinators.length, 0);
    release();
    await finished();
    await running;
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "coordinator_message_handled").some((e) => e.messageId === messageId),
      60_000,
      "the message to be answered after the run",
    );
    assert.equal(coordinators.length, 1, "the long turn's chat is still answered by the coordinator");
    assert.equal(coordinators[0]!.readOnly, true);
    assert.equal(lead.length, 1);
    const log = await rig.core.store.listEvents(thread);
    assert.equal(customEvents(log, "run_steering").length, 0, "nothing was handed to the long turn");
    const start = customEvents(log, "autopilot_started").find((e) => e.runId === runId);
    assert.equal(
      start?.liveChat,
      undefined,
      "the long turn opens no line: its composer keeps saying the message waits",
    );
    assert.ok(customEvents(log, "run_finished").some((e) => e.runId === runId));
  });
});

it("G2. an until-satisfied build pauses on a required prerequisite instead of starting cosmetics", {
  timeout: RIG_TIMEOUT_MS,
}, async () => {
  const { rig, runId, dispatch, finished, project } = await loopRun("goal-blocker", {
    reference: { kind: "direction", name: "Dusk", shots: [] },
    budgets: { wallClockMs: 24 * 60 * 60_000, untilSatisfied: true },
  });
  let workers = 0;
  let turns = 0;
  fakeEngine(rig, async (request) => {
    if (!request.director) {
      workers += 1;
      return turnResult("worker", "unexpected");
    }
    turns += 1;
    assert.ok(request.onLiveTool);
    await request.onLiveTool("plan", plan);
    await request.onLiveTool("goal_update", { goal: "sky", blocker: "hosted_verification_unavailable" });
    return turnResult("lead", "Required hosted verification is unavailable");
  });
  const running = dispatch();
  const events = await finished();
  await running;
  assert.equal(turns, 1);
  assert.equal(workers, 0);
  const report = customEvents(events, "run_finished").find((event) => event.runId === runId);
  assert.equal(report?.executionStatus, "paused");
  assert.equal(report?.victory, false);
  const threadId = await rig.core.threadForGame(project.name);
  const journal = await rig.core.store.readArtifact(threadId, `autopilot_${runId}`);
  assert.ok(journal && typeof journal === "object" && "director" in journal);
  assert.equal(JSON.stringify(journal).includes("hosted_verification_unavailable"), true);
});

it("G3. current integrated acceptance permits early completion and keeps a recoverable checkpoint", {
  timeout: RIG_TIMEOUT_MS,
}, async () => {
  const { rig, runId, dispatch, finished, project } = await loopRun("goal-complete", {
    reference: { kind: "direction", name: "Dusk", shots: [] },
    budgets: { wallClockMs: 24 * 60 * 60_000, untilSatisfied: true },
  });
  let verified = false;
  fakeEngine(rig, async (request) => {
    if (request.playtest)
      return turnResult(
        "playtester",
        JSON.stringify({
          answers: { "director-play": { answer: "yes", note: "Reached the dusk scene through interaction" } },
        }),
      );
    assert.ok(request.director, "no builder is needed after current acceptance passes");
    assert.ok(request.onLiveTool);
    await request.onLiveTool("plan", plan);
    assert.match(
      text(await request.onLiveTool("finish", { summary: "unverified", land: "no", victory: "yes" })),
      /cannot claim victory/,
    );
    const played = json(await request.onLiveTool("playtest", { target: "integration", goal: "sky" }));
    assert.equal(played.answer, "yes");
    verified = true;
    assert.match(
      text(await request.onLiveTool("worker_start", { ...startSky, goal: "sky" })),
      /verified|complete|finish/,
    );
    assert.match(
      text(await request.onLiveTool("finish", { summary: "Dusk verified", land: "no", victory: "yes" })),
      /closed/,
    );
    return turnResult("lead", "Dusk verified");
  });
  const running = dispatch();
  const events = await finished();
  await running;
  assert.equal(verified, true);
  const report = customEvents(events, "run_finished").find((event) => event.runId === runId);
  assert.equal(report?.executionStatus, "completed");
  const threadId = await rig.core.threadForGame(project.name);
  const journal = await rig.core.store.readArtifact(threadId, `autopilot_${runId}`);
  assert.ok(journal && typeof journal === "object" && "director" in journal);
  assert.match(JSON.stringify(journal), /firstVerifiedCheckpoint/);
  const saved = JSON.parse(JSON.stringify(journal));
  const { gitFile } = await import("../helpers/git.ts");
  const head = saved.director.firstVerifiedCheckpoint.head;
  const kept = await gitFile(["rev-parse", `refs/studio/runs/${runId}/checkpoints/${head}`], { cwd: project.dir });
  assert.equal(String(kept.stdout).trim(), head, "checkpoint remains reachable after worktree cleanup");
});

it("G4. multiplayer prerequisites are host-checked before any worker is delegated", {
  timeout: RIG_TIMEOUT_MS,
}, async () => {
  const { rig, runId, dispatch, finished } = await loopRun("goal-prerequisites", {
    reference: { kind: "direction", name: "Chess", shots: [] },
    budgets: { wallClockMs: 24 * 60 * 60_000, untilSatisfied: true },
  });
  let workers = 0;
  let refusal = "";
  fakeEngine(rig, async (request) => {
    if (!request.director) {
      workers += 1;
      return turnResult("worker", "must not start");
    }
    assert.ok(request.onLiveTool);
    await request.onLiveTool("plan", {
      ...plan,
      workers: JSON.stringify([{ id: "sky", done: ["Two players exchange legal moves"], multiplayer: true }]),
    });
    refusal = text(await request.onLiveTool("worker_start", startSky));
    await request.onLiveTool("finish", { summary: "Prerequisite unavailable", land: "no", victory: "no" });
    return turnResult("lead", refusal);
  });
  const running = dispatch();
  const events = await finished();
  await running;
  assert.equal(workers, 0);
  assert.match(refusal, /Genex|package\.json/);
  const report = customEvents(events, "run_finished").find((event) => event.runId === runId);
  assert.equal(report?.executionStatus, "paused");
});

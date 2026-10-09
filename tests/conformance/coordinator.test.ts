import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { startRig, waitForLog, customEvents, type Rig } from "../helpers/studio-rig.ts";
import { type DelegateRequest, EngineError } from "../../src/substrate/engines/types.ts";
import {
  coordinatorTools,
  createRunInbox,
  latestRun,
  conversationThrough,
  runSnapshot,
} from "../../src/harness-seed/loop/run-inbox.ts";
import { runCoordinatorTurn } from "../../src/harness-seed/loop/coordinator.ts";

const rigs: Rig[] = [];
after(async () => {
  for (const rig of rigs) await rig.stop().catch(() => {});
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const result = (summary: string, sessionId: string) => ({
  ok: true,
  summary,
  sessionId,
  turns: 1,
  usage: {},
  durationMs: 1,
  engine: "fixture",
});

for (const engine of ["codex", "claude-code"])
  describe(`${engine}: persistent build coordinator`, () => {
    it("queues follow-ups during a build, then answers in order with the saved run and session", async () => {
      const rig = await startRig();
      rigs.push(rig);
      const project = "coordinator-game";
      await rig.core.games.scaffold(project);
      const thread = await rig.core.createGameThread(project);
      const workerStarted = deferred(),
        releaseWorker = deferred(),
        coordinatorStarted = deferred(),
        releaseCoordinator = deferred();
      const coordinators: DelegateRequest[] = [];
      let workerCalls = 0;
      rig.core.engines.register({
        id: engine,
        label: engine,
        kind: "delegated",
        status: async () => ({ code: "ready", detail: "" }),
        models: async () => [],
        complete: async () => ({
          message: { role: "assistant", content: '{"pick":"A","reason":"fixture"}' },
          usage: {},
          model: "fixture",
          engine,
          stopReason: "stop",
        }),
        delegate: async (request) => {
          if (request.coordinator) {
            coordinators.push(request);
            assert.equal(request.readOnly, true);
            assert.notEqual(request.cwd, rig.core.games.dirFor(project));
            assert.ok(!request.interviewTools?.some((t) => t.name === "start_autopilot"));
            // It is this game's chat to the user, and it knows what the builders can use.
            assert.doesNotMatch(request.prompt, /Studio coordinator|registrar\)/);
            assert.match(request.prompt, /capabilities of this game's builders/);
            if (coordinators.length === 1) {
              const state = JSON.parse(String(await request.onLiveTool!("run_status", {})));
              assert.equal(state.run.runId, "preserve-run");
              assert.match(state.toolCapabilities, /genex__asset/);
              assert.match(state.toolCapabilities, /capabilities of this game's builders/);
              coordinatorStarted.resolve();
              await releaseCoordinator.promise;
              return result("The worker is still running.", "registrar-session");
            }
            assert.equal(request.resume, "registrar-session");
            if (coordinators.length > 2) return result("Here is the completed build report.", "registrar-session");
            await request.onLiveTool!("run_status", {});
            return result("The existing build has finished.", "registrar-session");
          }
          workerCalls++;
          await writeFile(path.join(request.cwd, "worker-progress.txt"), "valuable work");
          workerStarted.resolve();
          await Promise.race([
            releaseWorker.promise,
            new Promise<void>((r) => request.signal?.addEventListener("abort", () => r(), { once: true })),
          ]);
          return result("Built the scene.", "worker-session");
        },
      });
      const run = {
        runId: "preserve-run",
        project,
        engine,
        goal: "Build a village",
        reference: { name: "village", shots: [] },
        budgets: { wallClockMs: 7200000, maxIterations: 5 },
      };
      const running = rig.core.host.dispatch({ type: "run_start", threadId: thread, run });
      const requireStart = async (milestone: Promise<void>, name: string): Promise<void> => {
        await Promise.race([
          milestone,
          running.then(async () => {
            const ended = customEvents(await rig.core.store.listEvents(thread), "run_finished").at(-1);
            throw new Error(`${engine}: run ended before ${name}: ${JSON.stringify(ended ?? {})}`);
          }),
        ]);
      };
      try {
        await requireStart(workerStarted.promise, "worker started");
        const started = Date.now();
        await rig.core.sendUserMessage("Is the river ready?", { thread: thread, engine, autopilot: { hours: 2 } });
        assert.ok(Date.now() - started < 5000, "send acknowledges receipt without waiting for a worker or reply");
        assert.equal(coordinators.length, 0, "follow-up waits for the active build");
        await rig.core.sendUserMessage("Wait for the last workers and make live what we have.", {
          thread: thread,
          engine,
          autopilot: { hours: 2 },
        });
        const queued = await rig.core.store.listEvents(thread);
        assert.equal(customEvents(queued, "coordinator_message_queued").length, 2);
        assert.equal(coordinators.length, 0, "both follow-ups remain queued while the worker runs");
        assert.equal(
          customEvents(queued, "coordinator_message_steering").length,
          0,
          "a build keeps its messages: nothing is steered",
        );
        await rig.core.host.dispatch({
          type: "run_start",
          threadId: thread,
          run: { ...run, runId: "accidental-second-run" },
        });
        assert.equal(
          await readFile(path.join(rig.core.games.dirFor(project), "worker-progress.txt"), "utf8"),
          "valuable work",
        );
        await rig.core.requestRunFinish(thread, run.runId);
        releaseWorker.resolve();
        await coordinatorStarted.promise;
        releaseCoordinator.resolve();
        await waitForLog(rig.core, (es) => customEvents(es, "coordinator_message_handled").length === 2, 15000);
        const log = await waitForLog(
          rig.core,
          (es) => customEvents(es, "run_control").length === 1,
          15000,
          "finish command",
        );
        assert.equal(customEvents(log, "run_started").length, 1);
        assert.equal(customEvents(log, "run_registered").length, 1);
        assert.equal(customEvents(log, "run_start_blocked").length, 1);
        assert.equal(customEvents(log, "run_steering").length, 0, "a status question is not broadcast to workers");
        assert.equal(workerCalls, 1);
        assert.equal(
          coordinators[0]!.cwd,
          coordinators[1]!.cwd,
          "the coordinator session has a stable working directory",
        );
        releaseWorker.resolve();
        await running;
        assert.equal(workerCalls, 1, "finish prevents another build iteration");
        const closed = await rig.core.store.listEvents(thread);
        assert.equal(customEvents(closed, "run_finished").length, 1);
        assert.match(String(customEvents(closed, "run_finished")[0]?.stoppedBecause), /user|current attempts/);
        assert.ok(!JSON.stringify(closed).includes("continues the Autopilot interview"));
        // A follow-up after completion still addresses the coordinator, never intake.
        await rig.core.sendUserMessage("What did we finish?", { thread: thread, engine, autopilot: { hours: 2 } });
        await waitForLog(rig.core, (es) => customEvents(es, "coordinator_message_handled").length === 3, 15000);
        assert.equal(customEvents(await rig.core.store.listEvents(thread), "run_started").length, 1);
        await rig.core.host.restart();
        await rig.core.sendUserMessage("Which checks passed?", { thread, engine, autopilot: { hours: 2 } });
        await waitForLog(rig.core, (es) => customEvents(es, "coordinator_message_handled").length === 4, 15000);
        assert.equal(coordinators.at(-1)?.resume, "registrar-session", "coordinator session survives restart");
      } finally {
        releaseCoordinator.resolve();
        releaseWorker.resolve();
        await rig.core.stopThread(thread).catch(() => {});
        await running.catch(() => {});
      }
    });
  });

describe("addressed run inbox", () => {
  it("retains planning-time guidance, filters targets/questions/other runs, and drains at a boundary", async () => {
    const events: any[] = [
      { id: "1", data: { type: "messages", messages: [{ role: "user", content: "Is it ready?" }] } },
      {
        id: "2",
        data: {
          type: "custom",
          event_type: "run_steering",
          payload: { runId: "r", text: "Use warm light", facetId: "light" },
        },
      },
      {
        id: "3",
        data: { type: "custom", event_type: "run_steering", payload: { runId: "other", text: "Destroy it" } },
      },
      {
        id: "4",
        data: { type: "custom", event_type: "run_steering", payload: { runId: "r", text: "Keep walking peaceful" } },
      },
      // The director's own steer to a worker is not the user speaking.
      {
        id: "4b",
        data: {
          type: "custom",
          event_type: "run_steering",
          payload: { runId: "r", text: "fix the floating drums", facetId: "contact", source: "director" },
        },
      },
    ];
    const inbox = createRunInbox(
      {
        call: async (_: string, p: any) =>
          p.after ? events.slice(events.findIndex((e) => e.id === p.after) + 1) : events,
      } as never,
      { threadId: "t", runId: "r" },
    );
    assert.deepEqual(await inbox.steering("river"), ["Keep walking peaceful"]);
    assert.deepEqual(await inbox.backlog(), ["Use warm light"]);
    assert.deepEqual(
      await inbox.steering("contact"),
      ["Keep walking peaceful"],
      "the director's own steer never comes back as an instruction",
    );
    assert.deepEqual(await inbox.steering("light"), ["Use warm light", "Keep walking peaceful"]);
    assert.equal(await inbox.finishing(), false);
    events.push({
      id: "5",
      data: { type: "custom", event_type: "run_control", payload: { runId: "r", action: "finish" } },
    });
    assert.equal(await inbox.finishing(), true);
    assert.deepEqual(await inbox.backlog(), []);
  });
  it("offers the user a way to see and land a build after the run, in flat string tools both bridges carry", () => {
    for (const name of ["show_build", "land_build"]) {
      const tool = coordinatorTools.find((t) => t.name === name)!;
      assert.ok(tool, `${name} exists`);
      assert.equal(tool.parameters.properties.build?.type, "string");
      assert.match(tool.description, /integration/);
    }
    assert.match(coordinatorTools.find((t) => t.name === "show_build")!.description, /finished or paused/);
  });

  it("keeps paused and finished identity after an app restart", () => {
    const es = [
      { data: { type: "custom", event_type: "run_started", payload: { runId: "r", project: "village" } } },
      { data: { type: "custom", event_type: "run_finished", payload: { runId: "r" } } },
      { data: { type: "custom", event_type: "autopilot_paused", payload: { runId: "r" } } },
    ];
    assert.equal(latestRun(es as never)?.state, "paused");
    const replaced = [
      ...es,
      { data: { type: "custom", event_type: "run_started", payload: { runId: "empty-replacement" } } },
    ];
    assert.equal(
      latestRun(replaced as never, "r")?.state,
      "paused",
      "the registrar can still address an older saved run",
    );
  });
});

it("future queued messages stay out of an earlier turn prompt", () => {
  const es = [
    { id: "1", data: { type: "messages", messages: [{ role: "user", content: "first" }] } },
    { id: "2", data: { type: "custom", event_type: "coordinator_message_queued", payload: { messageId: "a" } } },
    { id: "3", data: { type: "messages", messages: [{ role: "user", content: "second" }] } },
    { id: "4", data: { type: "custom", event_type: "coordinator_message_queued", payload: { messageId: "b" } } },
  ];
  assert.deepEqual(
    (conversationThrough(es as never, "a") as typeof es).filter((e) => e.data.type === "messages").map((e) => e.id),
    ["1"],
  );
  assert.deepEqual(
    (conversationThrough(es as never, "b") as typeof es).filter((e) => e.data.type === "messages").map((e) => e.id),
    ["1", "3"],
  );
});

it("replays a durable unanswered message once on boot without opening intake", async () => {
  const rig = await startRig();
  rigs.push(rig);
  await rig.core.games.scaffold("replay-world");
  const thread = await rig.core.createGameThread("replay-world");
  await rig.core.append(
    [
      {
        type: "custom",
        event_type: "run_started",
        payload: { runId: "old", project: "replay-world", engine: "ollama" },
      },
      { type: "custom", event_type: "run_finished", payload: { runId: "old", project: "replay-world" } },
      { type: "messages", messages: [{ role: "user", content: "What passed?" }] },
      {
        type: "custom",
        event_type: "coordinator_message_queued",
        payload: {
          messageId: "recover-me",
          action: {
            messageId: "recover-me",
            type: "user_message",
            threadId: thread,
            project: "replay-world",
            text: "What passed?",
            engine: "ollama",
            autopilot: { hours: 2 },
          },
        },
      },
    ],
    thread,
  );
  await rig.core.host.dispatch({ type: "boot_notice", notice: { reason: "crash_restart" } });
  await waitForLog(
    rig.core,
    (es) => customEvents(es, "coordinator_message_handled").some((p) => p.messageId === "recover-me"),
    15000,
  );
  await rig.core.host.dispatch({ type: "boot_notice", notice: { reason: "cold_start" } });
  const es = await rig.core.store.listEvents(thread);
  assert.equal(customEvents(es, "coordinator_message_handled").length, 1);
  assert.equal(customEvents(es, "run_started").length, 1);
});

it("coordinator status includes the current Optimization stage without mixing runs", () => {
  const event = (event_type: string, payload: object) => ({ data: { type: "custom", event_type, payload } });
  const snapshot = runSnapshot(
    [
      event("run_started", { runId: "r", project: "village" }),
      event("optimization_updated", { runId: "r", phase: "profiling_candidate", outcome: null }),
      event("optimization_updated", { runId: "other", phase: "terminal", outcome: "improved" }),
    ] as never,
    "r",
  );
  assert.equal(snapshot.progress.length, 1);
  assert.equal(snapshot.progress[0].phase, "profiling_candidate");
});

it("a run's wakes do not crowd the workers out of the coordinator's progress", () => {
  const event = (event_type: string, payload: object) => ({ data: { type: "custom", event_type, payload } });
  // Up to thirty wakes an hour, each a director_continued: an hour of them is more than the list holds.
  const wakes = Array.from({ length: 30 }, (_, i) =>
    event("director_continued", { runId: "r", minutesLeft: 90 - i, reasons: ["worker_round"] }),
  );
  const snapshot = runSnapshot(
    [
      event("run_started", { runId: "r", project: "village" }),
      event("director_worker", { runId: "r", workerId: "sky", state: "running" }),
      ...wakes,
      event("director_worker", { runId: "r", workerId: "sky", state: "done" }),
    ] as never,
    "r",
  );
  assert.deepEqual(
    snapshot.progress.map((p) => `${p.type}:${p.state ?? ""}`),
    ["director_worker:running", "director_worker:done"],
  );
});

it("the chat's words to a run's lead do not crowd the workers out of the coordinator's progress", () => {
  const event = (event_type: string, payload: object) => ({ data: { type: "custom", event_type, payload } });
  // Each message to the lead is a steer, taken off its inbox and heard: only the steer is progress.
  const chat = Array.from({ length: 10 }, (_, i) => [
    event("run_steering", { runId: "r", text: `question ${i}`, sourceMessageId: `m${i}`, how: "lead" }),
    event("run_steering_delivered", { runId: "r", messageId: `s${i}`, facetId: "build", stage: "next brief" }),
    event("run_steering_delivered", { runId: "r", sourceMessageId: `m${i}`, how: "lead" }),
  ]).flat();
  const snapshot = runSnapshot(
    [
      event("run_started", { runId: "r", project: "village" }),
      event("director_worker", { runId: "r", workerId: "sky", state: "running" }),
      ...chat,
      event("director_worker", { runId: "r", workerId: "sky", state: "done" }),
    ] as never,
    "r",
  );
  const types = snapshot.progress.map((p) => p.type);
  assert.equal(types.filter((type) => type === "run_steering").length, 10);
  assert.ok(!types.includes("run_steering_delivered"), types.join(", "));
  assert.equal(types[0], "director_worker", "the worker's start is still on the list");
});

it("a follow-up after a run sees what the run's lead said in the chat, and the coordinator's own reply once", async () => {
  const custom = (id: number, event_type: string, payload: object) => ({
    id: String(id).padStart(3, "0"),
    data: { type: "custom", event_type, payload },
  });
  const words = (id: number, role: string, content: string) => ({
    id: String(id).padStart(3, "0"),
    data: { type: "messages", messages: [{ role, content }] },
  });
  const said = (id: number, delegationId: string, text: string) =>
    custom(id, "delegated.codex", {
      delegationId,
      role: "planner",
      runId: "r",
      kind: "assistant",
      data: { role: "assistant", parts: [{ type: "text", text }] },
    });
  const log = [
    custom(1, "run_started", { runId: "r", project: "plaza" }),
    // Mid-build, the lead answers the chat.
    words(2, "user", "is the sky dusk yet?"),
    custom(3, "coordinator_message_queued", { messageId: "m1", action: { text: "is the sky dusk yet?" } }),
    custom(4, "coordinator_message_delivered", { messageId: "m1", into: "r", how: "lead" }),
    custom(5, "run_steering", { runId: "r", text: "is the sky dusk yet?", sourceMessageId: "m1", how: "lead" }),
    said(6, "lead", "Not yet: the sky worker is on its first round."),
    custom(7, "run_finished", { runId: "r" }),
    // After the run, the coordinator answers a question: its reply is in the chat's own words.
    words(8, "user", "what did you finish?"),
    custom(9, "coordinator_message_queued", { messageId: "m2", action: { text: "what did you finish?" } }),
    custom(10, "coordinator_message_processing", { messageId: "m2" }),
    said(11, "coordinator", "A dusk sky over the plaza."),
    words(12, "assistant", "A dusk sky over the plaza."),
    custom(13, "coordinator_message_handled", { messageId: "m2" }),
    // The follow-up this turn answers.
    words(14, "user", "why dusk?"),
    custom(15, "coordinator_message_queued", { messageId: "m3", action: { text: "why dusk?" } }),
  ];
  const prompts: string[] = [];
  const ctx = {
    cancelled: false,
    notify: () => {},
    call: async (method: string, p: Record<string, any>) => {
      if (method === "events.list") return log;
      if (method === "engine.describe") return [{ id: "codex", kind: "delegated" }];
      if (method === "engine.delegate") {
        prompts.push(p.prompt);
        return { ok: true, summary: "Because you asked for a dusk plaza.", sessionId: "coordinator-1" };
      }
      return null;
    },
  };
  await runCoordinatorTurn(ctx as never, {
    threadId: "t",
    turnId: "turn-3",
    run: { runId: "r", project: "plaza", engine: "codex", state: "finished" },
    text: "why dusk?",
    engine: "codex",
    messageId: "m3",
  });
  assert.equal(prompts.length, 1);
  const history = prompts[0]!.slice(prompts[0]!.indexOf("RECENT CONVERSATION"));
  assert.match(history, /assistant: Not yet: the sky worker is on its first round\./, history);
  assert.ok(history.indexOf("Not yet") < history.indexOf("what did you finish?"), "in the order it was said");
  assert.equal(history.split("A dusk sky over the plaza.").length - 1, 1, "the coordinator's own reply once");
});

for (const ending of ["returns stopped", "throws aborted"] as const)
  it(`Stop leaves the same durable trace in the coordinator's turn when its engine ${ending}`, async () => {
    // Real engines do both: Claude Code and Codex mostly answer a Stop with a stopped result, and
    // throw an abort when it lands before the session starts. The turn records it the same way.
    const rig = await startRig();
    rigs.push(rig);
    await rig.core.games.scaffold("stop-trace");
    const thread = await rig.core.createGameThread("stop-trace");
    await rig.core.append(
      [
        {
          type: "custom",
          event_type: "run_started",
          payload: { runId: "saved", project: "stop-trace", engine: "codex" },
        },
        { type: "custom", event_type: "run_finished", payload: { runId: "saved", project: "stop-trace" } },
      ],
      thread,
    );
    const started = deferred();
    rig.core.engines.register({
      id: "codex",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        if (ending === "throws aborted") throw new EngineError("aborted", "codex", "stopped by you");
        return { ...result("", "stopped-session"), ok: false, stopReason: "stopped", errorText: "stopped by you" };
      },
    });
    try {
      await rig.core.sendUserMessage("Is the river ready?", { thread, engine: "codex" });
      await started.promise;
      await rig.core.stopThread(thread);
      const log = await waitForLog(
        rig.core,
        (es) => es.some((e) => e.data.type === "turn_ended"),
        15000,
        "the turn to end",
      );
      const turnId = log.find((e) => e.data.type === "turn_started")?.turn_id;
      assert.ok(turnId, "the message opened a turn");
      const ended = log.find((e) => e.turn_id === turnId && e.data.type === "turn_ended");
      assert.equal((ended?.data as { status?: string } | undefined)?.status, "cancelled");
      const interrupted = log.some(
        (e) =>
          e.turn_id === turnId &&
          e.data.type === "custom" &&
          e.data.event_type === "session_activity" &&
          (e.data.payload as { phase?: string } | undefined)?.phase === "interrupted",
      );
      assert.ok(interrupted, "the turn says it was interrupted");
    } finally {
      await rig.core.stopThread(thread).catch(() => {});
    }
  });

it("Stop while the plan is being written cancels it at once, without waiting for the plan", async () => {
  const rig = await startRig();
  rigs.push(rig);
  await rig.core.games.scaffold("stop-plan");
  const thread = await rig.core.createGameThread("stop-plan");
  let writing = false;
  rig.core.engines.register({
    id: "codex",
    label: "fixture",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    // The plan is written until the user stops it.
    complete: async (request: { signal?: AbortSignal }) => {
      writing = true;
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw Object.assign(new Error("stopped by you"), { name: "AbortError" });
    },
    delegate: async () => result("never", "s"),
  } as never);
  const sending = rig.core
    .sendUserMessage("Build a quiet garden", {
      thread,
      engine: "codex",
      reviewPlan: true,
      autopilot: { hours: 1, reviewPlan: true },
    })
    .catch(() => {});
  const deadline = Date.now() + 10_000;
  while (!writing && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(writing, "the plan is being written");
  const stopped = await Promise.race([
    rig.core.stopThread(thread).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  assert.ok(stopped, "Stop answers without waiting for the plan to be written");
  await sending;
});

it("a Stop pressed while the message is still sending stops that message: no builder answers it", async () => {
  const rig = await startRig();
  rigs.push(rig);
  await rig.core.games.scaffold("stop-while-sending");
  const thread = await rig.core.createGameThread("stop-while-sending");
  let answered = 0;
  rig.core.engines.register({
    id: "codex",
    label: "fixture",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    delegate: async (request) => {
      // A builder that is stopped says so; one left alone answers after a moment.
      const stopped = await new Promise<boolean>((resolve) => {
        if (request.signal?.aborted) resolve(true);
        request.signal?.addEventListener("abort", () => resolve(true), { once: true });
        setTimeout(() => resolve(false), 2_000);
      });
      if (stopped) return { ...result("", "s"), ok: false, stopReason: "stopped", errorText: "stopped by you" };
      answered++;
      return result("Made the sky pink.", "s");
    },
  });
  try {
    // The composer's Send, and the Stop pressed before the send reached the chat's queue.
    const sending = rig.core.sendUserMessage("make the sky pink", { thread, engine: "codex" });
    await rig.core.stopThread(thread);
    await sending;
    const log = await waitForLog(
      rig.core,
      (es) => es.some((e) => e.data.type === "turn_ended"),
      15000,
      "the stopped message's turn to end",
    );
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(answered, 0, "no builder answered the stopped message");
    const ended = log.find((e) => e.data.type === "turn_ended")?.data as { status?: string } | undefined;
    assert.equal(ended?.status, "cancelled");
  } finally {
    await rig.core.stopThread(thread).catch(() => {});
  }
});

it("Stop hands off to queued input in the same native session; an empty queue stays stopped", async () => {
  const rig = await startRig();
  rigs.push(rig);
  await rig.core.games.scaffold("stop-queue");
  const thread = await rig.core.createGameThread("stop-queue");
  await rig.core.append(
    [
      {
        type: "custom",
        event_type: "run_started",
        payload: { runId: "saved", project: "stop-queue", engine: "codex" },
      },
      { type: "custom", event_type: "run_finished", payload: { runId: "saved", project: "stop-queue" } },
    ],
    thread,
  );
  await rig.core.store.writeArtifact(thread, "autopilot_saved", {
    plan: { summary: "Preserve the quiet garden and its blue river" },
    phase: "done",
  });
  const started = deferred(),
    calls: DelegateRequest[] = [];
  rig.core.engines.register({
    id: "codex",
    label: "fixture",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    delegate: async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        started.resolve();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return result("Interrupted with progress saved.", "same-session");
      }
      assert.equal(request.resume, "same-session");
      assert.match(request.prompt, /Preserve the quiet garden and its blue river/);
      assert.match(request.prompt, /LATEST USER MESSAGE:\nAdd fireflies/);
      assert.ok(!request.signal?.aborted, "new response is not aborted by the old Stop");
      return result("Continue the existing garden.", "same-session");
    },
  });
  try {
    await rig.core.sendUserMessage("First message", { thread, engine: "codex" });
    await started.promise;
    // Another model: it waits for a turn of its own rather than being steered into this one.
    await rig.core.sendUserMessage("Add fireflies", { thread, engine: "codex", model: "another-model" });
    assert.equal(calls.length, 1);
    assert.equal(customEvents(await rig.core.store.listEvents(thread), "coordinator_message_steering").length, 0);
    await rig.core.stopThread(thread);
    await waitForLog(rig.core, (es) => customEvents(es, "coordinator_message_handled").length === 2, 15000);
    assert.equal(calls.length, 2);
    await rig.core.stopThread(thread);
    assert.equal(calls.length, 2, "empty queue does not invent a continuation");
    assert.equal(customEvents(await rig.core.store.listEvents(thread), "run_started").length, 1);
  } finally {
    await rig.core.stopThread(thread);
  }
});

it("a stale Plan mode flag during a build preserves its plan and queues the follow-up", async () => {
  const rig = await startRig();
  rigs.push(rig);
  await rig.core.games.scaffold("existing-plan");
  const thread = await rig.core.createGameThread("existing-plan");
  await rig.core.store.updateThread(thread, {
    metadata: {
      planReview: {
        id: "approved-plan",
        state: "approved",
        text: "Build a quiet garden",
        plan: "Keep the river blue",
        options: { thread },
      },
    },
  });
  await rig.core.append(
    [
      {
        type: "custom",
        event_type: "run_started",
        payload: { runId: "current", project: "existing-plan", engine: "ollama", goal: "Build a quiet garden" },
      },
    ],
    thread,
  );
  await rig.core.sendUserMessage("Add fireflies", {
    thread,
    engine: "ollama",
    reviewPlan: true,
    autopilot: { hours: 1, reviewPlan: true },
  });
  const saved = (await rig.core.store.getRecord(thread)).metadata?.planReview as { id: string };
  assert.equal(saved.id, "approved-plan");
  assert.equal(customEvents(await rig.core.store.listEvents(thread), "plan_review").length, 0);
  assert.equal(customEvents(await rig.core.store.listEvents(thread), "coordinator_message_queued").length, 1);
});

it("an ordinary change after completion continues implementation with the saved plan, without another intake", async () => {
  const rig = await startRig();
  rigs.push(rig);
  await rig.core.games.scaffold("followup-plan");
  const thread = await rig.core.createGameThread("followup-plan");
  await rig.core.append(
    [
      { type: "messages", messages: [{ role: "user", content: "Build a quiet garden" }] },
      {
        type: "custom",
        event_type: "plan_review",
        payload: { id: "plan", state: "approved", plan: "Keep the river blue and the existing paths" },
      },
      {
        type: "custom",
        event_type: "run_started",
        payload: { runId: "done", project: "followup-plan", engine: "codex" },
      },
      { type: "custom", event_type: "run_finished", payload: { runId: "done", project: "followup-plan" } },
    ],
    thread,
  );
  let built = 0;
  rig.core.engines.register({
    id: "codex",
    label: "fixture",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    delegate: async (request) => {
      if (request.coordinator) {
        await request.onLiveTool!("continue_build", { text: "Add fireflies" });
        return result("Adding fireflies to the existing garden.", "coordinator");
      }
      assert.ok(!request.interviewTools?.length, "no new build interview");
      assert.match(request.prompt, /Keep the river blue and the existing paths/);
      assert.match(request.prompt, /Add fireflies/);
      assert.match(request.prompt, /Build a quiet garden/);
      await writeFile(path.join(request.cwd, "fireflies.txt"), "added");
      built++;
      return result("Added fireflies.", "builder");
    },
  });
  await rig.core.sendUserMessage("Add fireflies", { thread, engine: "codex" });
  await waitForLog(rig.core, (es) => customEvents(es, "coordinator_message_handled").length === 1, 15000);
  assert.equal(built, 1);
  assert.equal(await readFile(path.join(rig.core.games.dirFor("followup-plan"), "fireflies.txt"), "utf8"), "added");
  assert.equal(customEvents(await rig.core.store.listEvents(thread), "run_started").length, 1);
});

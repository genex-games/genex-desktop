import assert from "node:assert/strict";
import { after, it } from "node:test";
import { spawn } from "node:child_process";
import { access, readdir, readFile, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { startRig, waitForLog, customEvents, type Rig } from "../helpers/studio-rig.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { messageQueueState } from "../../src/shared/message-queue.ts";
import { CHECKPOINT_FILE_MAX_BYTES, CheckpointPhase, chatCheckpointRef } from "../../src/main/chat-checkpoints.ts";
import { SkippedBy } from "../../src/shared/chat-rewind.ts";
import { CustomEvent, customRecord } from "../../src/shared/custom-events.ts";
import { latestRun } from "../../src/shared/coordinator.ts";
import { git } from "../../src/substrate/snapshots.ts";
import type { JobSpawn } from "../../src/substrate/jobs.ts";
import { JobRole, JobScopeKind } from "../../src/shared/jobs.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";

const rigs: Rig[] = [];
after(async () => {
  for (const rig of rigs) await rig.stop().catch(() => {});
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
const handled = (thread: string, count: number) => (events: EventEnvelope[]) =>
  events.filter(
    (e) => e.thread_id === thread && e.data.type === "custom" && e.data.event_type === "coordinator_message_handled",
  ).length >= count;
/** The bubble of a message by its text: its event id and queue id, as the chat has them. */
function bubble(events: EventEnvelope[], text: string): { eventId: string; messageId: string } {
  const message = [...messageQueueState(events).messages.values()].find(
    (m) => (m.action as { text?: string } | undefined)?.text === text,
  );
  assert.ok(message?.eventId, `no bubble for ${text}`);
  return { eventId: message.eventId, messageId: message.messageId };
}

/** The chat as the harness reads it (`events.list`: without what a rewind withdrew). */
const harnessEvents = (rig: Rig, threadId: string) =>
  (rig.core.api()["events.list"] as (p: unknown) => Promise<EventEnvelope[]>)({ threadId });
/** Waits until a git ref exists in the game folder (checkpoints are taken beside the queue). */
async function refExists(dir: string, ref: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = await git(dir, ["rev-parse", "--verify", "-q", ref]).then(
      (out) => out.trim(),
      () => "",
    );
    if (found) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no ${ref}`);
}

it("rewinds a game chat: the message and its answer leave, files come back, and the next turn starts a fresh session", async () => {
  const rig = await startRig();
  rigs.push(rig);
  const project = "rewind-game";
  await rig.core.games.scaffold(project);
  const thread = await rig.core.createGameThread(project);
  const dir = rig.core.games.dirFor(project);
  const delegations: DelegateRequest[] = [];
  let hold: ReturnType<typeof deferred> | null = null;
  rig.core.engines.register({
    id: "claude-code",
    label: "Claude",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    delegate: async (request) => {
      delegations.push(request);
      const step = delegations.length;
      await writeFile(path.join(request.cwd!, `step-${step}.js`), `step ${step}\n`);
      if (hold) await hold.promise;
      return {
        ok: true,
        summary: `Answered step ${step}.`,
        sessionId: request.resume ?? `session-${step}`,
        turns: 1,
        usage: {},
        durationMs: 1,
        engine: "claude-code",
      };
    },
  });
  const send = (text: string, clientId?: string) =>
    rig.core.sendUserMessage(text, { thread, engine: "claude-code", ...(clientId ? { clientId } : {}) });

  await send("Make a platformer", "msg_client_one");
  await waitForLog(rig.core, handled(thread, 1), 20000, "first answer");
  await send("Add a boss");
  await waitForLog(rig.core, handled(thread, 2), 20000, "second answer");
  assert.equal(delegations[1]!.resume, "session-1", "the second message resumed the chat session");
  let events = await rig.core.store.listEvents(thread);
  const first = bubble(events, "Make a platformer");
  assert.equal(first.messageId, "msg_client_one", "the composer id became the queue id");
  const boss = bubble(events, "Add a boss");
  // A checkpoint was taken before each message was answered.
  assert.ok((await git(dir, ["rev-parse", "--verify", chatCheckpointRef(thread, boss.messageId)])).trim());

  // A file changed outside the chat since then is named: a restore would put it back too.
  await refExists(dir, chatCheckpointRef(thread, boss.messageId, CheckpointPhase.After));
  await writeFile(path.join(dir, "outside.txt"), "made in an editor\n");
  assert.deepEqual(await rig.core.rewindPreview(thread, boss.eventId, boss.messageId), {
    files: { state: "restore", files: 2, outside: ["outside.txt"], outsideUnknown: false, nested: [], tooLarge: 0 },
    stopsBuild: false,
  });
  const result = await rig.core.rewindChat(thread, boss.eventId, boss.messageId, { files: true });
  assert.deepEqual(result, {
    text: "Add a boss",
    messageId: boss.messageId,
    imageCount: 0,
    pickedImages: 0,
    files: 2,
    held: [],
  });
  assert.equal(await exists(path.join(dir, "step-2.js")), false, "the answer’s file went");
  assert.equal(await exists(path.join(dir, "outside.txt")), false, "asked for, the outside change went too");
  assert.equal(await readFile(path.join(dir, "step-1.js"), "utf8"), "step 1\n", "the earlier answer’s file stayed");

  // The harness reads the chat without the withdrawn turn and without its session.
  const view = await (rig.core.api()["events.list"] as (p: unknown) => Promise<EventEnvelope[]>)({ threadId: thread });
  const said = JSON.stringify(view.filter((e) => e.data.type === "messages"));
  assert.match(said, /Make a platformer/);
  assert.doesNotMatch(said, /Add a boss|step 2/);
  assert.equal(
    customEvents(view, "contractor_session").some((p) => p.sessionId),
    false,
  );
  assert.equal(((await rig.core.store.getRecord(thread)).metadata as { contractor?: unknown }).contractor, null);
  assert.deepEqual(
    (await rig.core.store.chatState(thread))
      .filter((e) => e.data.type === "messages")
      .map((e) => JSON.stringify(e.data))
      .filter((s) => s.includes("Add a boss")),
    [],
  );

  await send("Add a dragon instead");
  await waitForLog(rig.core, handled(thread, 3), 20000, "answer after the rewind");
  const fresh = delegations[2]!;
  assert.equal(fresh.resume, undefined, "the next turn does not resume a session that remembers the withdrawn turn");
  assert.match(fresh.prompt, /Make a platformer/);
  assert.doesNotMatch(fresh.prompt, /Add a boss/);

  // A restart does not bring the withdrawn message back.
  await rig.core.host.restart();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(delegations.length, 3);

  // Rewinding waits for the chat to be between answers.
  hold = deferred();
  await send("Now add music");
  await waitForLog(rig.core, () => delegations.length === 4, 20000, "a turn in progress");
  events = await rig.core.store.listEvents(thread);
  const dragon = bubble(events, "Add a dragon instead");
  await assert.rejects(
    rig.core.rewindChat(thread, dragon.eventId, dragon.messageId, { files: true }),
    /Wait for this chat to finish/,
  );
  hold.resolve();
  await waitForLog(rig.core, handled(thread, 4), 20000, "the held answer");
});

it("a message is never sent while its chat is rewinding, and a rewind without files leaves them alone", async () => {
  const rig = await startRig();
  rigs.push(rig);
  const project = "rewind-draft";
  await rig.core.games.scaffold(project);
  const thread = await rig.core.createGameThread(project);
  rig.core.engines.register({
    id: "claude-code",
    label: "Claude",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    delegate: async (request) => ({
      ok: true,
      summary: "Done.",
      sessionId: request.resume ?? "session-1",
      turns: 1,
      usage: {},
      durationMs: 1,
      engine: "claude-code",
    }),
  });
  await rig.core.sendUserMessage("One", { thread, engine: "claude-code" });
  await waitForLog(rig.core, handled(thread, 1), 20000, "the answer");
  const one = bubble(await rig.core.store.listEvents(thread), "One");
  const rewinding = rig.core.rewindChat(thread, one.eventId, one.messageId);
  await assert.rejects(
    rig.core.sendUserMessage("Two", { thread, engine: "claude-code" }),
    /Wait for the rewind to finish/,
  );
  assert.equal((await rewinding).files, null, "files were not asked for");
  const marker = customEvents(await rig.core.store.listEvents(thread), "conversation_rewound");
  assert.equal(marker.length, 1);
});

it("follow-ups on hold leave with the message, its pictures come back, and the references it saved go", async () => {
  const rig = await startRig();
  rigs.push(rig);
  const project = "rewind-held";
  await rig.core.games.scaffold(project);
  const thread = await rig.core.createGameThread(project);
  const dir = rig.core.games.dirFor(project);
  const delegations: DelegateRequest[] = [];
  const release = deferred();
  rig.core.engines.register({
    id: "claude-code",
    label: "Claude",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    delegate: async (request) => {
      delegations.push(request);
      if (delegations.length === 1) await release.promise;
      return {
        ok: true,
        summary: "Done.",
        sessionId: request.resume ?? "session-1",
        turns: 1,
        usage: {},
        durationMs: 1,
        engine: "claude-code",
      };
    },
  });
  const pixel = {
    label: "mood",
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  };
  await rig.core.sendUserMessage("Make it moody", { thread, engine: "claude-code", frames: [pixel] });
  await waitForLog(rig.core, () => delegations.length === 1, 20000, "the first answer running");
  assert.equal(
    (await readdir(path.join(dir, "references"))).filter((name) => name.endsWith(".png")).length,
    1,
    "the picture was saved as a reference",
  );
  // A follow-up sent meanwhile is put on hold, so it still waits when the answer ends. It asks
  // another model, so it waits for a turn of its own instead of being steered into this one.
  await rig.core.sendUserMessage("And add rain", { thread, engine: "claude-code", model: "another-model" });
  let events = await rig.core.store.listEvents(thread);
  await rig.core.changeQueuedMessage(thread, bubble(events, "And add rain").messageId, "hold");
  release.resolve();
  await waitForLog(rig.core, handled(thread, 1), 20000, "the first answer");
  events = await rig.core.store.listEvents(thread);
  assert.equal([...messageQueueState(events).messages.values()].filter((m) => m.state === "queued").length, 1);
  const moody = bubble(events, "Make it moody");
  const result = await rig.core.rewindChat(thread, moody.eventId, moody.messageId, { files: true });
  assert.equal(result.text, "Make it moody\n\nAnd add rain", "the waiting follow-up comes back with it");
  assert.deepEqual([result.imageCount, result.pickedImages], [1, 1]);
  assert.deepEqual(
    (await readdir(path.join(dir, "references")).catch(() => [])).filter((name) => name.endsWith(".png")),
    [],
    "the reference it saved went with it",
  );
  events = await rig.core.store.listEvents(thread);
  assert.equal(messageQueueState(events).messages.get(bubble(events, "And add rain").messageId)?.state, "removed");
  await rig.core.host.restart();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(delegations.length, 1, "the withdrawn follow-up is never answered");
});

/** A delegated engine whose every chat turn leaves a file of its own, and that writes plans. */
function answeringEngine(rig: Rig): DelegateRequest[] {
  const turns: DelegateRequest[] = [];
  rig.core.engines.register({
    id: "claude-code",
    label: "Claude",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete: async () => ({
      message: { role: "assistant", content: "## Moat\n\n1. Dig a moat around the castle." },
      usage: {},
      model: "fixture",
      engine: "claude-code",
      stopReason: "stop",
    }),
    delegate: async (request) => {
      turns.push(request);
      await writeFile(path.join(request.cwd!, `step-${turns.length}.js`), `step ${turns.length}\n`);
      return {
        ok: true,
        summary: `Answered step ${turns.length}.`,
        sessionId: request.resume ?? `session-${turns.length}`,
        turns: 1,
        usage: {},
        durationMs: 1,
        engine: "claude-code",
      };
    },
  });
  return turns;
}

const custom = (event_type: string, payload: Record<string, unknown>) => ({
  type: "custom" as const,
  event_type,
  payload,
});

it("a build after the message leaves the chat with it: files come back when it left them alone, and the chat is the chat's again", async () => {
  const rig = await startRig();
  rigs.push(rig);
  const project = "rewind-after-build";
  await rig.core.games.scaffold(project);
  const thread = await rig.core.createGameThread(project);
  const dir = rig.core.games.dirFor(project);
  const turns = answeringEngine(rig);
  await rig.core.sendUserMessage("Make a village", { thread, engine: "claude-code" });
  await waitForLog(rig.core, handled(thread, 1), 20000, "the answer");
  // A run built after it and paused without landing: the game's history did not move.
  await rig.core.append(
    [
      custom("run_started", { runId: "paused", project, engine: "claude-code", goal: "A village" }),
      { type: "messages", messages: [{ role: "assistant", content: "The run paused." }] },
      custom("autopilot_paused", { runId: "paused" }),
    ],
    thread,
  );
  assert.equal(latestRun(await harnessEvents(rig, thread))?.runId, "paused", "the paused run owns the chat");
  const village = bubble(await rig.core.store.listEvents(thread), "Make a village");
  assert.deepEqual(await rig.core.rewindPreview(thread, village.eventId, village.messageId), {
    files: { state: "restore", files: 1, outside: [], outsideUnknown: false, nested: [], tooLarge: 0 },
    stopsBuild: false,
  });
  const result = await rig.core.rewindChat(thread, village.eventId, village.messageId, { files: true });
  assert.equal(result.files, 1);
  assert.equal(await exists(path.join(dir, "step-1.js")), false, "the answer's file went");
  // Routing: the run is not the chat's any more, in the harness's view and in the chat's.
  assert.equal(latestRun(await harnessEvents(rig, thread)), null);
  assert.equal(latestRun(await rig.core.store.chatState(thread)), null);
  await rig.core.sendUserMessage("Make a castle", { thread, engine: "claude-code" });
  await waitForLog(rig.core, handled(thread, 2), 20000, "the answer after the rewind");
  assert.equal(turns.length, 2);
  assert.ok(!turns[1]!.coordinator, "a turn of the chat's own, not the run's coordinator");
  assert.equal(turns[1]!.resume, undefined, "with a fresh session");
  assert.doesNotMatch(turns[1]!.prompt, /Make a village|The run paused/);
  // A Plan-mode send is no longer a follow-up to a paused build: it gets its plan review.
  await rig.core.sendUserMessage("Dig a moat", {
    thread,
    engine: "claude-code",
    reviewPlan: true,
    autopilot: { hours: 1, reviewPlan: true },
  });
  await waitForLog(
    rig.core,
    (events) =>
      customEvents(
        events.filter((e) => e.thread_id === thread),
        "plan_review",
      ).length > 0,
    20000,
    "the plan review",
  );
});

it("rewound past a later build, the next message's run tools reach the build from before the message", async () => {
  const rig = await startRig();
  rigs.push(rig);
  const project = "rewind-older-build";
  await rig.core.games.scaffold(project);
  const thread = await rig.core.createGameThread(project);
  const dir = rig.core.games.dirFor(project);
  const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
  /** What the coordinator's run tools answered, per tool, once it is asked to use them. */
  const answers: Record<string, string>[] = [];
  let useTools = false;
  rig.core.engines.register({
    id: "claude-code",
    label: "Claude",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    delegate: async (request) => {
      if (request.coordinator && useTools) {
        const tried: Record<string, string> = {};
        const calls: [string, Record<string, unknown>][] = [
          ["run_status", {}],
          ["show_build", {}],
          ["resume_run", { text: "Go on with the forest" }],
        ];
        for (const [name, args] of calls) {
          tried[name] = await request.onLiveTool!(name, args).then(String, (err: Error) => `refused: ${err.message}`);
        }
        answers.push(tried);
      }
      return {
        ok: true,
        summary: "Answered.",
        sessionId: request.resume ?? "session",
        turns: 1,
        usage: {},
        durationMs: 1,
        engine: "claude-code",
      };
    },
  });
  // Build A paused before the message; the message went to its coordinator.
  await rig.core.append(
    [
      custom("run_started", {
        runId: "run-a",
        project,
        engine: "claude-code",
        goal: "A forest",
        integrationHead: head,
      }),
      custom("autopilot_paused", { runId: "run-a" }),
    ],
    thread,
  );
  await rig.core.sendUserMessage("Make it autumn", { thread, engine: "claude-code" });
  await waitForLog(rig.core, handled(thread, 1), 20000, "the coordinator's answer");
  // Build B began after the message and landed.
  await rig.core.append(
    [
      custom("run_started", { runId: "run-b", project, engine: "claude-code", goal: "A desert" }),
      custom("run_finished", { runId: "run-b", project, landed: true }),
    ],
    thread,
  );
  const autumn = bubble(await rig.core.store.listEvents(thread), "Make it autumn");
  await rig.core.rewindChat(thread, autumn.eventId, autumn.messageId, { files: true });
  assert.equal(latestRun(await harnessEvents(rig, thread))?.runId, "run-a", "the chat is build A's again");
  assert.equal(latestRun(await rig.core.store.listEvents(thread))?.runId, "run-b", "the log still holds build B");

  useTools = true;
  await rig.core.sendUserMessage("How is the forest?", { thread, engine: "claude-code" });
  await waitForLog(rig.core, handled(thread, 2), 20000, "the answer after the rewind");
  assert.equal(answers.length, 1, "build A's coordinator answered");
  const [tried] = answers;
  assert.doesNotMatch(JSON.stringify(tried), /refused/, JSON.stringify(tried));
  assert.equal(JSON.parse(tried!.run_status!).run.runId, "run-a");
  assert.match(tried!.show_build!, /Live/);
  assert.match(tried!.resume_run!, /Resume requested for the same run/);
});

it("after a landed build, or with no saved copy, only the conversation rewinds and the files stay", async () => {
  const rig = await startRig();
  rigs.push(rig);
  const project = "rewind-landed";
  await rig.core.games.scaffold(project);
  const thread = await rig.core.createGameThread(project);
  const dir = rig.core.games.dirFor(project);
  answeringEngine(rig);
  // A bubble from before the queue existed: no queue record, no checkpoint.
  await rig.core.append([{ type: "messages", messages: [{ role: "user", content: "Seeded question" }] }], thread);
  await rig.core.append([{ type: "messages", messages: [{ role: "assistant", content: "Seeded answer" }] }], thread);
  const seeded = (await rig.core.store.listEvents(thread)).find((e) =>
    JSON.stringify(e.data).includes("Seeded question"),
  );
  assert.ok(seeded);
  assert.deepEqual(await rig.core.rewindPreview(thread, seeded.id, seeded.id), {
    files: { state: "unavailable", reason: "no-checkpoint" },
    stopsBuild: false,
  });
  await rig.core.sendUserMessage("Make a village", { thread, engine: "claude-code" });
  await waitForLog(rig.core, handled(thread, 1), 20000, "the answer");
  // A run landed after it: its commit moved the game's history.
  await writeFile(path.join(dir, "landed.js"), "the run's work\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "land the run"]);
  const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
  await rig.core.append(
    [
      custom("run_started", { runId: "landed-run", project, engine: "claude-code" }),
      custom("run_finished", { runId: "landed-run", project, landed: true }),
    ],
    thread,
  );
  const village = bubble(await rig.core.store.listEvents(thread), "Make a village");
  const chatOnly = { files: { state: "unavailable", reason: "build-changed" }, stopsBuild: false };
  assert.deepEqual(await rig.core.rewindPreview(thread, village.eventId, village.messageId), chatOnly);
  assert.deepEqual(await rig.core.rewindPreview(thread, seeded.id, seeded.id), chatOnly);
  const result = await rig.core.rewindChat(thread, village.eventId, village.messageId, { files: true });
  assert.equal(result.files, null, "files asked for, but a landed build keeps them");
  assert.equal(await readFile(path.join(dir, "step-1.js"), "utf8"), "step 1\n");
  assert.equal(await readFile(path.join(dir, "landed.js"), "utf8"), "the run's work\n");
  assert.equal((await git(dir, ["rev-parse", "HEAD"])).trim(), head);
  assert.equal(latestRun(await harnessEvents(rig, thread)), null);
  // The bubble with no queue record rewinds by its own id, and comes back to the composer.
  const back = await rig.core.rewindChat(thread, seeded.id, seeded.id, { files: true });
  assert.deepEqual([back.text, back.messageId, back.files], ["Seeded question", seeded.id, null]);
  assert.deepEqual(
    (await harnessEvents(rig, thread)).filter((e) => e.data.type === "messages"),
    [],
    "the chat starts over",
  );
});

it("rewinding over a running build stops it first; the build leaves the chat and a follow-up sent during it comes back", async () => {
  const rig = await startRig();
  rigs.push(rig);
  const project = "rewind-running";
  await rig.core.games.scaffold(project);
  const thread = await rig.core.createGameThread(project);
  const dir = rig.core.games.dirFor(project);
  const chatTurns: DelegateRequest[] = [];
  const coordinators: DelegateRequest[] = [];
  const workerStarted = deferred();
  /** While the build runs, a session that is not its coordinator is one of its builders. */
  let building = false;
  rig.core.engines.register({
    id: "codex",
    label: "codex",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete: async () => ({
      message: { role: "assistant", content: '{"pick":"A","reason":"fixture"}' },
      usage: {},
      model: "fixture",
      engine: "codex",
      stopReason: "stop",
    }),
    delegate: async (request) => {
      const answer = (summary: string, sessionId: string) => ({
        ok: true,
        summary,
        sessionId,
        turns: 1,
        usage: {},
        durationMs: 1,
        engine: "codex",
      });
      if (request.coordinator) {
        coordinators.push(request);
        return answer("The build is paused.", "coordinator-session");
      }
      if (!building) {
        chatTurns.push(request);
        return answer(`Chat answer ${chatTurns.length}.`, request.resume ?? `chat-${chatTurns.length}`);
      }
      workerStarted.resolve();
      // The worker builds until it is stopped.
      await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return answer("Stopped.", "worker-session");
    },
  });
  await rig.core.sendUserMessage("Make a village", { thread, engine: "codex" });
  await waitForLog(rig.core, handled(thread, 1), 20000, "the chat's answer");
  const run = {
    runId: "running-run",
    project,
    engine: "codex",
    goal: "Build a village",
    reference: { name: "village", shots: [] },
    budgets: { wallClockMs: 7200000, maxIterations: 5 },
  };
  building = true;
  const running = rig.core.host.dispatch({ type: "run_start", threadId: thread, run });
  try {
    await Promise.race([
      workerStarted.promise,
      running.then(async () => {
        const ended = customEvents(await rig.core.store.listEvents(thread), "run_finished").at(-1);
        throw new Error(`the build ended before its worker started: ${JSON.stringify(ended ?? {})}`);
      }),
    ]);
    // A follow-up sent while it builds waits for the build.
    await rig.core.sendUserMessage("Is the river ready?", { thread, engine: "codex" });
    const village = bubble(await rig.core.store.listEvents(thread), "Make a village");
    assert.deepEqual(await rig.core.rewindPreview(thread, village.eventId, village.messageId), {
      files: { state: "unavailable", reason: "build-running" },
      stopsBuild: true,
    });
    const result = await rig.core.rewindChat(thread, village.eventId, village.messageId, { files: true });
    assert.equal(result.text, "Make a village\n\nIs the river ready?", "the waiting follow-up comes back with it");
    assert.equal(result.files, null, "a stopped build's files stay as they are");
    const raw = await rig.core.store.listEvents(thread);
    assert.ok(customEvents(raw, "coordinator_queue_paused").length > 0, "the Stop held the queue");
    assert.ok(
      raw.some((e) => /run_finished|autopilot_paused/.test(e.data.type === "custom" ? e.data.event_type : "")),
      "the build closed before the chat went back",
    );
    const view = await harnessEvents(rig, thread);
    assert.equal(latestRun(view), null, "its lifecycle left the chat with it");
    assert.equal(customEvents(view, "run_started").length, 0);
    assert.equal(latestRun(await rig.core.store.chatState(thread)), null);
    assert.equal(messageQueueState(raw).messages.get(bubble(raw, "Is the river ready?").messageId)?.state, "removed");
    await running;
    building = false;
    // The next message is the chat's own turn again, with a fresh session.
    await rig.core.sendUserMessage("Make a harbour", { thread, engine: "codex" });
    await waitForLog(rig.core, handled(thread, 2), 20000, "the answer after the rewind");
    assert.equal(coordinators.length, 0, "the stopped build's coordinator never answers");
    assert.equal(chatTurns.length, 2);
    assert.equal(chatTurns[1]!.resume, undefined);
    assert.equal(await exists(dir), true);
  } finally {
    await rig.core.stopThread(thread).catch(() => {});
    await running.catch(() => {});
  }
});

it("a rewind over a running build waits for the build's jobs to end, and their lines leave with it", {
  skip: process.platform === "win32" && "process groups and /bin/sh are POSIX",
}, async () => {
  // The job winds down a second after its Stop, as a real build tool does.
  const jobSpawn: JobSpawn = async (request) => ({
    child: spawn("/bin/sh", ["-c", request.command], { cwd: request.cwd, detached: true, stdio: "pipe" }),
    sandboxed: false,
  });
  const rig = await startRig({}, { jobSpawn });
  rigs.push(rig);
  const project = "rewind-running-job";
  await rig.core.games.scaffold(project);
  const thread = await rig.core.createGameThread(project);
  const workerStarted = deferred();
  let building = false;
  rig.core.engines.register({
    id: "codex",
    label: "codex",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete: async () => ({
      message: { role: "assistant", content: '{"pick":"A","reason":"fixture"}' },
      usage: {},
      model: "fixture",
      engine: "codex",
      stopReason: "stop",
    }),
    delegate: async (request) => {
      const answer = (summary: string) => ({
        ok: true,
        summary,
        sessionId: request.resume ?? "session",
        turns: 1,
        usage: {},
        durationMs: 1,
        engine: "codex",
      });
      if (request.coordinator || !building) return answer("Answered.");
      workerStarted.resolve();
      await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return answer("Stopped.");
    },
  });
  await rig.core.sendUserMessage("Make a village", { thread, engine: "codex" });
  await waitForLog(rig.core, handled(thread, 1), 20000, "the chat's answer");
  building = true;
  const runId = "running-job-run";
  const running = rig.core.host.dispatch({
    type: "run_start",
    threadId: thread,
    run: {
      runId,
      project,
      engine: "codex",
      goal: "Build a village",
      reference: { name: "village", shots: [] },
      budgets: { wallClockMs: 7200000, maxIterations: 5 },
    },
  });
  try {
    await workerStarted.promise;
    const job = await rig.core.jobs.start({
      owner: { project, chatThreadId: thread, role: JobRole.Lead, scope: { kind: JobScopeKind.Run, runId } },
      title: "Unreal build",
      command: "trap 'sleep 1; exit 0' TERM; sleep 30 & wait",
      cwd: rig.core.games.dirFor(project),
      policy: {},
      mode: PermissionMode.Bypass,
    });
    const village = bubble(await rig.core.store.listEvents(thread), "Make a village");
    await rig.core.rewindChat(thread, village.eventId, village.messageId, { files: true });
    const raw = await rig.core.store.listEvents(thread);
    const jobEnd = raw.find((e) => {
      const custom = customRecord(e.data);
      return custom?.event_type === CustomEvent.JobEnded && custom.payload.jobId === job.id;
    });
    const rewound = raw.findLast((e) => customRecord(e.data)?.event_type === CustomEvent.ConversationRewound);
    assert.ok(jobEnd && rewound, "the job ended and the chat went back");
    assert.ok(jobEnd.id < rewound.id, "the job's end is in the log the rewind read");
    const view = await harnessEvents(rig, thread);
    assert.deepEqual(
      [...customEvents(view, "job_started"), ...customEvents(view, "job_ended")],
      [],
      "the build's job left the chat with the build",
    );
    await running;
  } finally {
    await rig.core.stopThread(thread).catch(() => {});
    await running.catch(() => {});
  }
});

it("a build that does not close in time fails the rewind, and the queue its Stop held answers again", async () => {
  // The wait's own clock: its two minutes pass at once, and the build still has not closed.
  let now = 0;
  const rig = await startRig(
    {},
    {
      rewindBuildStop: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          await new Promise((resolve) => setImmediate(resolve));
        },
      },
    },
  );
  rigs.push(rig);
  const project = "rewind-stuck-build";
  await rig.core.games.scaffold(project);
  const thread = await rig.core.createGameThread(project);
  const workerStarted = deferred();
  const releaseWorker = deferred();
  let building = false;
  rig.core.engines.register({
    id: "codex",
    label: "codex",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete: async () => ({
      message: { role: "assistant", content: '{"pick":"A","reason":"fixture"}' },
      usage: {},
      model: "fixture",
      engine: "codex",
      stopReason: "stop",
    }),
    delegate: async (request) => {
      const answer = (summary: string) => ({
        ok: true,
        summary,
        sessionId: request.resume ?? "session",
        turns: 1,
        usage: {},
        durationMs: 1,
        engine: "codex",
      });
      if (request.coordinator || !building) return answer("Answered.");
      workerStarted.resolve();
      // A worker that winds down only when it is let go, whatever the Stop says.
      await releaseWorker.promise;
      return answer("Stopped.");
    },
  });
  await rig.core.sendUserMessage("Make a village", { thread, engine: "codex" });
  await waitForLog(rig.core, handled(thread, 1), 20000, "the chat's answer");
  building = true;
  const running = rig.core.host.dispatch({
    type: "run_start",
    threadId: thread,
    run: {
      runId: "stuck-run",
      project,
      engine: "codex",
      goal: "Build a village",
      reference: { name: "village", shots: [] },
      budgets: { wallClockMs: 7200000, maxIterations: 5 },
    },
  });
  try {
    await workerStarted.promise;
    await rig.core.sendUserMessage("Is the river ready?", { thread, engine: "codex" });
    const village = bubble(await rig.core.store.listEvents(thread), "Make a village");
    await assert.rejects(
      rig.core.rewindChat(thread, village.eventId, village.messageId, { files: true }),
      /The build is still stopping/,
    );
    assert.ok(now >= 120_000, "it waited its whole two minutes on its own clock");
    const raw = await rig.core.store.listEvents(thread);
    const queueRows = raw.flatMap((e) =>
      e.data.type === "custom" && /^coordinator_queue_(paused|resumed)$/.test(e.data.event_type)
        ? [e.data.event_type]
        : [],
    );
    assert.equal(queueRows.at(-1), "coordinator_queue_resumed", `the held queue answers again: ${queueRows}`);
    assert.equal(customEvents(raw, "conversation_rewound").length, 0, "the chat did not go back");
    // Once the build closes, the follow-up is answered as after any Stop.
    releaseWorker.resolve();
    await running;
    await waitForLog(rig.core, handled(thread, 2), 20000, "the follow-up after the build closed");
  } finally {
    releaseWorker.resolve();
    await rig.core.stopThread(thread).catch(() => {});
    await running.catch(() => {});
  }
});

it("without a saved copy from before the message, a rewind asked to restore the files rewinds the chat alone", async () => {
  const rig = await startRig();
  rigs.push(rig);
  const project = "rewind-no-copy";
  await rig.core.games.scaffold(project);
  const thread = await rig.core.createGameThread(project);
  const dir = rig.core.games.dirFor(project);
  answeringEngine(rig);
  // A bubble with no queue record: nothing ever saved the game before it.
  await rig.core.append([{ type: "messages", messages: [{ role: "user", content: "Seeded question" }] }], thread);
  await rig.core.append([{ type: "messages", messages: [{ role: "assistant", content: "Seeded answer" }] }], thread);
  const seeded = (await rig.core.store.listEvents(thread)).find((e) =>
    JSON.stringify(e.data).includes("Seeded question"),
  );
  assert.ok(seeded);
  const noCopy = { files: { state: "unavailable", reason: "no-checkpoint" }, stopsBuild: false };
  assert.deepEqual(await rig.core.rewindPreview(thread, seeded.id, seeded.id), noCopy);
  const back = await rig.core.rewindChat(thread, seeded.id, seeded.id, { files: true });
  assert.deepEqual([back.text, back.files], ["Seeded question", null]);
  assert.deepEqual(
    (await harnessEvents(rig, thread)).filter((e) => e.data.type === "messages"),
    [],
    "the chat went back",
  );

  // A queued message whose saved copy is gone (pruned, or never taken in time) rewinds the chat alone too.
  await rig.core.sendUserMessage("Make a village", { thread, engine: "claude-code" });
  await waitForLog(rig.core, handled(thread, 1), 20000, "the answer");
  const village = bubble(await rig.core.store.listEvents(thread), "Make a village");
  const before = chatCheckpointRef(thread, village.messageId);
  await refExists(dir, before);
  await git(dir, ["update-ref", "-d", before]);
  assert.deepEqual(await rig.core.rewindPreview(thread, village.eventId, village.messageId), noCopy);
  const result = await rig.core.rewindChat(thread, village.eventId, village.messageId, { files: true });
  assert.equal(result.files, null);
  assert.equal(await readFile(path.join(dir, "step-1.js"), "utf8"), "step 1\n", "the answer's file stays");
  assert.equal(
    JSON.stringify((await harnessEvents(rig, thread)).filter((e) => e.data.type === "messages")).includes("village"),
    false,
    "the message left the chat",
  );
});

it("tells the chat once when a checkpoint leaves a file out for its size", async () => {
  const rig = await startRig();
  rigs.push(rig);
  const project = "rewind-big-files";
  await rig.core.games.scaffold(project);
  const thread = await rig.core.createGameThread(project);
  const dir = rig.core.games.dirFor(project);
  const tooLarge = CHECKPOINT_FILE_MAX_BYTES + 1;
  const grow = (file: string) => truncate(path.join(dir, file), tooLarge);
  await writeFile(path.join(dir, "theme.wav"), "small\n");
  await writeFile(path.join(dir, "intro.mp4"), "");
  await grow("intro.mp4");
  const prompts: string[] = [];
  rig.core.engines.register({
    id: "claude-code",
    label: "Claude",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    delegate: async (request) => {
      prompts.push(request.prompt);
      const step = prompts.length;
      await writeFile(path.join(request.cwd ?? dir, `step-${step}.js`), `step ${step}\n`);
      // The third answer grows a saved file past the limit.
      if (step === 3) await grow("theme.wav");
      return {
        ok: true,
        summary: `Answered step ${step}.`,
        sessionId: `session-${step}`,
        turns: 1,
        usage: {},
        durationMs: 1,
        engine: "claude-code",
      };
    },
  });
  const send = (text: string) => rig.core.sendUserMessage(text, { thread, engine: "claude-code" });
  const skips = (events: EventEnvelope[]) =>
    customEvents(
      events.filter((e) => e.thread_id === thread),
      CustomEvent.CheckpointSkipped,
    );

  await send("Make a racer");
  await waitForLog(rig.core, handled(thread, 1), 20000, "first answer");
  await send("Add a track");
  await waitForLog(rig.core, handled(thread, 2), 20000, "second answer");
  await send("Add music");
  await waitForLog(rig.core, (events) => skips(events).length >= 2, 20000, "a second set of files left out");
  const events = await rig.core.store.listEvents(thread);
  const [first, second, ...more] = skips(events);
  assert.deepEqual(more, [], "the same set is told once");
  assert.equal(first?.by, SkippedBy.Checkpoint);
  assert.deepEqual(first?.files, [{ file: "intro.mp4", bytes: tooLarge }]);
  assert.equal(first?.fileLimitBytes, CHECKPOINT_FILE_MAX_BYTES);
  assert.deepEqual(second?.files, [
    { file: "intro.mp4", bytes: tooLarge },
    { file: "theme.wav", bytes: tooLarge },
  ]);
  assert.match(prompts[0] ?? "", /^Studio notice: Rewind cannot bring back these files.*intro\.mp4 \(50 MB\)/);
  assert.doesNotMatch(prompts[1] ?? "", /Rewind cannot bring back/, "told once, then used up");

  // A rewind that leaves a file as it is says so too.
  const music = bubble(events, "Add music");
  await refExists(dir, chatCheckpointRef(thread, music.messageId, CheckpointPhase.After));
  const preview = await rig.core.rewindPreview(thread, music.eventId, music.messageId);
  assert.deepEqual(preview.files.state === "restore" && preview.files.tooLargeFiles, ["theme.wav"]);
  await rig.core.rewindChat(thread, music.eventId, music.messageId, { files: true });
  const rewound = skips(await rig.core.store.listEvents(thread)).filter((p) => p.by === SkippedBy.Rewind);
  assert.deepEqual(
    rewound.map((p) => p.files),
    [[{ file: "theme.wav", bytes: tooLarge }]],
  );
});

it("when every changed file is too large to save, only the chat rewinds and the files are named", async () => {
  const rig = await startRig();
  rigs.push(rig);
  const project = "rewind-only-big-files";
  await rig.core.games.scaffold(project);
  const thread = await rig.core.createGameThread(project);
  const dir = rig.core.games.dirFor(project);
  const tooLarge = CHECKPOINT_FILE_MAX_BYTES + 1;
  await writeFile(path.join(dir, "theme.wav"), "small\n");
  rig.core.engines.register({
    id: "claude-code",
    label: "Claude",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    delegate: async () => {
      // The answer only grows a saved file past the limit.
      await truncate(path.join(dir, "theme.wav"), tooLarge);
      return {
        ok: true,
        summary: "Answered.",
        sessionId: "session-1",
        turns: 1,
        usage: {},
        durationMs: 1,
        engine: "claude-code",
      };
    },
  });
  await rig.core.sendUserMessage("Add music", { thread, engine: "claude-code" });
  await waitForLog(rig.core, handled(thread, 1), 20000, "the answer");
  const music = bubble(await rig.core.store.listEvents(thread), "Add music");
  await refExists(dir, chatCheckpointRef(thread, music.messageId, CheckpointPhase.After));

  const preview = await rig.core.rewindPreview(thread, music.eventId, music.messageId);
  assert.deepEqual(preview.files, { state: "unavailable", reason: "too-large", tooLargeFiles: ["theme.wav"] });
  await rig.core.rewindChat(thread, music.eventId, music.messageId);
  const records = customEvents(
    (await rig.core.store.listEvents(thread)).filter((e) => e.thread_id === thread),
    CustomEvent.CheckpointSkipped,
  ).filter((p) => p.by === SkippedBy.Rewind);
  assert.deepEqual(
    records.map((p) => p.files),
    [[{ file: "theme.wav", bytes: tooLarge }]],
    "the rewind that left them says so",
  );
  assert.equal((await readFile(path.join(dir, "theme.wav"))).length, tooLarge, "the file stays as it is");
});

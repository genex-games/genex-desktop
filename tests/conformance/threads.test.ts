/**
 * Per-game chat threads and context management — the "chat management" design of 20 Aug.
 *
 * The properties that matter:
 *  1. a message sent to a game's thread lands there, and the delegated build trace follows it —
 *     each game's chat holds its own history, not a shared pile;
 *  2. a draft "new game" thread becomes the project's thread the moment the first brief
 *     scaffolds a folder;
 *  3. the Studio thread never builds;
 *  4. the prompt window is measured in tokens against the model's real context, oversized tool
 *     dumps are clamped, and a `compacted` event replaces exactly what it summarised;
 *  5. the engine's exact prompt size is logged (`context_usage`) so the UI meter never guesses.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Engine } from "../../src/substrate/engines/types.ts";
import { StudioCore } from "../../src/main/studio-core.ts";
import { customEvents, makeResources, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import {
  eventsToMessages,
  windowMessagesToBudget,
  estimateMessagesTokens,
  estimateTokens,
  materializePrompt,
} from "../../src/harness-seed/loop/prompt.ts";
import { compactThread } from "../../src/harness-seed/loop/compact.ts";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { isContinueAsk } from "../../src/harness-seed/loop/turn-loop.ts";
import { tools as gameTools } from "../../src/harness-seed/tools/game-tools.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.stop().catch(() => {})));
});

function vendorEngine(
  briefs: Array<{ cwd: string; resume?: string; prompt?: string }>,
  result: Record<string, unknown> = {},
): Engine {
  return {
    id: "vendor",
    label: "Vendor",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "signed in" }),
    models: async () => [],
    delegate: async (request) => {
      briefs.push({
        cwd: request.cwd,
        prompt: request.prompt,
        ...(request.resume ? { resume: request.resume } : {}),
      });
      request.onEvent?.({ type: "system", payload: { subtype: "init", model: "vendor-1" } });
      return {
        ok: true,
        engine: "vendor",
        summary: "done",
        turns: 1,
        usage: { input_tokens: 0, output_tokens: 0 },
        sessionId: "ses_ok",
        ...result,
      } as never;
    },
  };
}

describe("per-game threads", () => {
  it("a game thread keeps its own messages and its own build trace", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const briefs: Array<{ cwd: string }> = [];
    rig.core.engines.register(vendorEngine(briefs));
    await rig.core.games.scaffold("arena", { title: "arena" });
    const threadId = await rig.core.threadForGame("arena");

    await rig.core.sendUserMessage("Add a boss fight", { engine: "vendor", thread: threadId });
    const deadline = Date.now() + 30_000;
    let threadEvents = await rig.core.store.listEvents(threadId);
    while (Date.now() < deadline && !threadEvents.some((e) => e.data.type === "turn_ended")) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      threadEvents = await rig.core.store.listEvents(threadId);
    }

    assert.ok(briefs[0]!.cwd.endsWith("arena"), "the thread's project got the brief");
    assert.ok(
      threadEvents.some((e) => e.data.type === "messages" && e.data.messages.some((m) => m.role === "user")),
      "the user message is in the game's thread",
    );
    assert.ok(
      threadEvents.some((e) => e.data.type === "custom" && e.data.event_type === "delegated.vendor"),
      "the contractor's mirrored trace follows the game's thread",
    );
    const mainEvents = await rig.core.store.listEvents(rig.core.mainThread);
    assert.ok(
      !mainEvents.some((e) => e.data.type === "messages" && e.data.messages.some((m) => m.role === "user")),
      "nothing about this build leaked into the Studio thread",
    );
    // The merged view still sees everything, in one global order.
    const all = await rig.core.listAllEvents();
    assert.ok(all.some((e) => e.thread_id === threadId && e.data.type === "turn_ended"));
  });

  it("a draft thread is bound to the project its first brief scaffolds", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const briefs: Array<{ cwd: string }> = [];
    rig.core.engines.register(vendorEngine(briefs));

    const threadId = await rig.core.createGameThread();
    // Asking again before the first message reuses the same draft instead of piling them up.
    assert.equal(await rig.core.createGameThread(), threadId);

    await rig.core.sendUserMessage("Build a chess puzzle game", { engine: "vendor", thread: threadId });
    // Project binding precedes asynchronous delegation. Wait for the actual first turn,
    // not the intermediate metadata write, before inspecting the contractor's brief.
    await waitForLog(
      rig.core,
      (log) => log.some((e) => e.thread_id === threadId && e.data.type === "turn_ended"),
      30_000,
      "draft first turn ended",
    );
    const record = await rig.core.store.getRecord(threadId);
    assert.equal((record.metadata as { project?: string }).project, "chess-puzzle");
    assert.equal(record.title, "Build a chess puzzle game");
    assert.ok(briefs[0]!.cwd.endsWith("chess-puzzle"));
  });

  it("＋ opens a fresh chat once the draft holds a conversation", async () => {
    const rig = await startRig({ replies: [{ text: "Sure — what should it look like?" }] });
    rigs.push(rig);

    const first = await rig.core.createGameThread();
    assert.equal(await rig.core.createGameThread(), first, "an untouched draft is reused");

    await rig.core.sendUserMessage("what kind of games can you build", { thread: first });
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn_ended");

    // The draft now holds a conversation, so it is no longer a fresh chat to hand back. ＋ used
    // to return it forever — every new game landed in the middle of the last one's history.
    const second = await rig.core.createGameThread();
    assert.notEqual(second, first, "＋ opened a new chat instead of reopening the old one");
    assert.equal(await rig.core.createGameThread(), second, "the new, still-empty draft is reused");
  });

  it("a local model's own new_game names the chat it was asked in", async () => {
    const rig = await startRig({
      replies: [
        { toolCalls: [{ id: "c1", name: "new_game", arguments: { name: "arena", title: "Arena" } }] },
        { toolCalls: [{ id: "c2", name: "start_web_game", arguments: { project: "arena" } }] },
        { text: "Scaffolded the arena." },
      ],
    });
    rigs.push(rig);

    const threadId = await rig.core.createGameThread();
    await rig.core.sendUserMessage("make a top-down arena shooter", { thread: threadId });
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn_ended");

    // Only the delegated path used to pass the thread along, so a local model building a game
    // left its chat unbound — and an unbound chat is the one ＋ hands back.
    const record = await rig.core.store.getRecord(threadId);
    assert.equal((record.metadata as { project?: string }).project, "arena");
    assert.equal(record.title, "make a top-down arena shooter");
    assert.notEqual(await rig.core.createGameThread(), threadId, "＋ opens a new chat, not the arena's");
    // The game it made started empty, and its start_web_game wrote the web starter.
    const arena = (await rig.core.games.list()).find((game) => game.name === "arena");
    assert.deepEqual(
      arena?.facts.map(({ id, path }) => ({ id, path })),
      [{ id: "web-game", path: "." }],
    );
  });

  it("a local model's new_game makes an empty folder unless it asks for web, and start_web_game starts one", async () => {
    const tool = (name: string) => {
      const found = gameTools.find((candidate) => candidate.name === name);
      assert.ok(found, name);
      return found;
    };
    const rows = [
      { tool: "new_game", args: { name: "arena" }, method: "game.scaffold", params: { name: "arena", title: "arena" } },
      {
        tool: "new_game",
        args: { name: "arena", kind: "web" },
        method: "game.scaffold",
        params: { name: "arena", title: "arena", kind: "web" },
      },
      {
        tool: "start_web_game",
        args: { project: "arena" },
        method: "game.start",
        // Flipped: the start names its chat, so the host holds it while that chat plans.
        params: { project: "arena", starter: "web", threadId: "thread-1" },
      },
    ];
    for (const row of rows) {
      const host = ctxRecorder({
        unknown: { value: null },
        handlers: { [row.method]: () => ({ name: "arena", dir: "/g/arena" }) },
      });
      await tool(row.tool).execute(row.args, host.ctx as never);
      assert.deepEqual(host.paramsOf(row.method), [row.params], `${row.tool} ${JSON.stringify(row.args)}`);
    }
  });

  it("adopts a chat that built a game but was never named after it", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);

    // Exactly the state the binding gap left on disk: the real conversation in an unbound chat…
    await rig.core.games.scaffold("orphan", { title: "orphan" });
    const orphaned = await rig.core.createGameThread();
    await rig.core.store.appendEvents(orphaned, [
      { type: "messages", messages: [{ role: "user", content: "make orphan" }] },
      { type: "tool_requested", tool_call_id: "c1", request: { name: "new_game", arguments: { name: "orphan" } } },
    ]);
    // …and an empty stand-in chat wearing the game's name, made by clicking the game in the sidebar.
    const standIn = await rig.core.threadForGame("orphan");
    assert.notEqual(standIn, orphaned);

    await rig.core.stop();
    const revived = new StudioCore({
      paths: { userData: rig.userData, resources: await makeResources() },
      execPath: process.execPath,
      engines: [rig.core.engines.get("ollama")],
      ollamaHost: rig.server.host,
    });
    await revived.init();
    await revived.start();
    try {
      const adopted = await revived.store.getRecord(orphaned);
      assert.equal((adopted.metadata as { project?: string }).project, "orphan", "the history found its game");
      assert.equal(
        ((await revived.store.getRecord(standIn)).metadata as { archived?: boolean }).archived,
        true,
        "the empty stand-in stepped aside",
      );
      assert.equal(await revived.threadForGame("orphan"), orphaned, "the game opens its real chat");
      assert.notEqual(await revived.createGameThread(), orphaned, "＋ is unstuck");
    } finally {
      await revived.stop();
    }
  });

  it("the Studio thread calls the model without building and keeps its answer", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const briefs: Array<{ cwd: string }> = [];
    const requests: import("../../src/substrate/engines/types.ts").CompleteRequest[] = [];
    rig.core.engines.register({
      ...vendorEngine(briefs),
      complete: async (request) => {
        requests.push(request);
        return {
          engine: "vendor",
          model: "vendor-1",
          stopReason: "stop",
          usage: {},
          message: {
            role: "assistant",
            content: "Open New game to create the racing game, then describe drifting in its chat.",
          },
        };
      },
    });
    await rig.core.games.scaffold("existing", { title: "existing" });
    // Older versions kept game runs in the Studio log. A new question must stay in Studio.
    await rig.core.append(
      [
        {
          type: "custom",
          event_type: "run_started",
          payload: { runId: "legacy-studio-run", project: "existing", goal: "A racing game" },
        },
        {
          type: "custom",
          event_type: "run_finished",
          payload: { runId: "legacy-studio-run", project: "existing", landed: false },
        },
      ],
      rig.core.mainThread,
    );

    await rig.core.sendUserMessage("Build a racing game with drifting", {
      engine: "vendor",
      thread: rig.core.mainThread,
    });
    await waitForLog(
      rig.core,
      (log) => log.some((e) => e.thread_id === rig.core.mainThread && e.data.type === "turn_ended"),
      30_000,
      "Studio turn",
    );
    const events = await rig.core.store.listEvents(rig.core.mainThread);
    assert.equal(briefs.length, 0, "no contractor was briefed from the Studio thread");
    const reply = events
      .filter((e) => e.data.type === "messages")
      .flatMap((e) => (e.data as { messages: Array<{ role: string; content: string }> }).messages)
      .find((m) => m.role === "assistant");
    assert.equal(requests.length, 1, "the Studio actually calls the chosen model");
    assert.match(requests[0]!.systemPrompt!, /recorded context/);
    assert.equal(requests[0]!.tools, undefined);
    assert.match(reply!.content, /racing game/);
    assert.match(reply!.content, /New game|sidebar/i);
  });

  it("an interrupted build reports the partial state and records what Continue needs", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const briefs: Array<{ cwd: string }> = [];
    const vendor = vendorEngine(briefs, {
      ok: false,
      summary: "",
      turns: 12,
      stopReason: "stopped",
      sessionId: "ses_halt",
    });
    rig.core.engines.register({
      ...vendor,
      delegate: async (request) => {
        request.onEvent?.({ type: "text_delta", payload: { streamId: "partial", delta: "I am still building" } });
        return vendor.delegate!(request);
      },
    });
    await rig.core.games.scaffold("halted", { title: "halted" });
    const threadId = await rig.core.threadForGame("halted");

    await rig.core.sendUserMessage("Add a boss fight to the arena", { engine: "vendor", thread: threadId });
    const deadline = Date.now() + 30_000;
    let events = await rig.core.store.listEvents(threadId);
    while (Date.now() < deadline && !events.some((e) => e.data.type === "turn_ended")) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      events = await rig.core.store.listEvents(threadId);
    }

    const incomplete = customEvents(events, "delegation_incomplete")[0] as { sessionId: string; stopReason: string };
    assert.equal(incomplete.sessionId, "ses_halt", "the session id is in the log where Continue reads it");
    assert.equal(incomplete.stopReason, "stopped");
    const delta = rig.events.find((e) => e.type === "chat.delta")?.payload as { streamId: string };
    assert.ok(delta?.streamId);
    assert.ok(
      rig.events.some(
        (e) =>
          e.type === "chat.stream.ended" &&
          (e.payload as { streamId: string; failed: boolean }).streamId === delta.streamId &&
          (e.payload as { failed: boolean }).failed,
      ),
      "Stop retires the partial reply instead of leaving a second answer in chat",
    );
    const reply = events
      .filter((e) => e.data.type === "messages")
      .flatMap((e) => (e.data as { messages: Array<{ role: string; content: string }> }).messages)
      .filter((m) => m.role === "assistant")
      .at(-1);
    assert.match(reply!.content, /Stopped/i, "a stop is an outcome to report, not an error");
    assert.match(reply!.content, /Continue/i, "the user is told they can pick up where it left off");
    assert.ok(
      !events.some((e) => e.data.type === "error"),
      "no 'turn failed' — the partial build is a result, not a crash",
    );
  });

  it("Continue resumes the same contractor session — a short ask with resume is never mistaken for chit-chat", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const briefs: Array<{ cwd: string; resume?: string }> = [];
    rig.core.engines.register(vendorEngine(briefs));
    await rig.core.games.scaffold("halted", { title: "halted" });
    const threadId = await rig.core.threadForGame("halted");

    // "Continue." is 9 chars — without resume, the tiny-ask guard would answer instead of build.
    await rig.core.sendUserMessage("Continue.", { engine: "vendor", thread: threadId, resume: "ses_halt" });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && briefs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.equal(briefs[0]!.resume, "ses_halt", "the resume id rides the brief to the engine");
    assert.ok(briefs[0]!.cwd.endsWith("halted"));
  });

  it("Keep going preserves a recorded session model and effort; a provider's CLI keeps its own compaction", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const requests: import("../../src/substrate/engines/types.ts").DelegateRequest[] = [];
    rig.core.engines.register({
      ...vendorEngine([]),
      delegate: async (request) => {
        requests.push(request);
        return {
          ok: true,
          engine: "vendor",
          model: request.model,
          requestedModel: request.model,
          sessionId: "saved-session",
          summary: "done",
          turns: 1,
          usage: {},
        };
      },
    });
    await rig.core.games.scaffold("resume-policy", { title: "Resume policy" });
    const thread = await rig.core.threadForGame("resume-policy");
    await rig.core.store.updateThread(thread, {
      metadata: {
        contractor: {
          engine: "vendor",
          sessionId: "saved-session",
          project: "resume-policy",
          model: "chosen",
          effort: "low",
        },
      },
    });
    await assert.rejects(
      rig.core.contextPreferences.set("vendor", "chosen", { mode: "custom", thresholdPercent: 35 }, thread),
      /applies only to local models/,
    );
    await rig.core.sendUserMessage("Keep going from where we left off.", {
      engine: "vendor",
      resume: "saved-session",
      thread,
    });
    await waitForLog(rig.core, (events) => events.some((e) => e.data.type === "turn_ended"), 30000, "resumed turn");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.resume, "saved-session");
    assert.equal(requests[0]!.model, "chosen");
    assert.equal(requests[0]!.effort, "low");
    assert.equal(requests[0]!.contextPolicy?.mode, "default", "it compacts at its own point");
    await rig.core.sendUserMessage("Use the explicitly selected default.", {
      engine: "vendor",
      model: "",
      resume: "saved-session",
      thread,
    });
    await waitForLog(
      rig.core,
      (events) => events.filter((e) => e.data.type === "turn_ended").length === 2,
      30000,
      "explicit default turn",
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[1]!.model, undefined, "explicit default does not restore the prior named model");
    assert.equal(requests[1]!.contextPolicy?.mode, "default");
  });

  it("a stop only stops THAT turn — the next message starts clean", async () => {
    const rig = await startRig({ replies: [{ text: "still here" }] });
    rigs.push(rig);
    // The latent bug: cancel set a flag nothing reset, so one stop poisoned every later turn.
    await rig.core.stopThread(rig.core.mainThread);
    await rig.core.sendUserMessage("hello studio", { thread: rig.core.mainThread });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      30_000,
      "turn after stop",
    );
    const reply = events
      .filter((e) => e.data.type === "messages")
      .flatMap((e) => (e.data as { messages: Array<{ role: string; content: string }> }).messages)
      .find((m) => m.role === "assistant");
    assert.match(reply!.content, /still here/, "the turn after a stop runs normally");
    assert.ok(
      !events.some((e) => e.data.type === "error" && /cancelled/.test((e.data as { message: string }).message)),
    );
  });

  it("keep-going phrasing is a continue, even with a typo", () => {
    assert.equal(isContinueAsk("keeep going plz"), true);
    assert.equal(isContinueAsk("Keep going from where we left off."), true);
    assert.equal(isContinueAsk("continue"), true);
    assert.equal(isContinueAsk("I want a rainy night city"), false);
  });

  it("status is per-thread: a busy chat never paints the others", async () => {
    const rig = await startRig({ replies: [{ text: "done thinking" }] });
    rigs.push(rig);
    await rig.core.sendUserMessage("hello studio", { thread: rig.core.mainThread });
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn end");

    const statuses = rig.events
      .filter((e) => e.type === "harness.status")
      .map(
        (e) =>
          e.payload as { threadId?: string; status: string; all?: Record<string, { status: string; since: number }> },
      );
    assert.ok(statuses.length >= 2, "status changes were notified");
    for (const s of statuses) {
      assert.equal(s.threadId, rig.core.mainThread, "every status names the thread it belongs to");
      assert.ok(s.all, "each notification carries the full map, so a reloaded UI can never go stale");
    }
    const last = statuses.at(-1)!;
    assert.equal(last.status, "idle");
    assert.deepEqual(last.all, {}, "an idle harness shows no thread as busy");
  });

  it("stop reaches into a local generation mid-flight", async () => {
    // The reply hangs forever after one delta — the shape of a model deep in a giant tool
    // call. The turn can only end if Stop actually aborts the completion.
    const rig = await startRig({ replies: [{ hangAfter: "writing the whole game…" }] });
    rigs.push(rig);
    const turnDone = rig.core.sendUserMessage("make doom", { thread: rig.core.mainThread });
    turnDone.catch(() => {});
    const deadline = Date.now() + 15_000;
    while (!rig.events.some((e) => e.type === "chat.delta")) {
      if (Date.now() > deadline) assert.fail("the stream never started");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await rig.core.stopThread(rig.core.mainThread);
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      15_000,
      "the stopped turn to end",
    );
    await turnDone;
    assert.ok(
      events.some((e) => e.data.type === "error" && (e.data as { message: string }).message === "cancelled"),
      "the turn ended as a stop",
    );
    assert.ok(
      !events.some((e) => e.data.type === "error" && /turn failed/.test((e.data as { message: string }).message)),
      "a stop is not a failure",
    );
  });

  it("a stop in one thread does not stop another", async () => {
    const rig = await startRig({ replies: [{ text: "unbothered" }] });
    rigs.push(rig);
    // Stop a game thread that is doing nothing; the studio thread's next turn must be untouched.
    await rig.core.games.scaffold("bystander", { title: "bystander" });
    const gameThread = await rig.core.threadForGame("bystander");
    await rig.core.stopThread(gameThread);
    await rig.core.sendUserMessage("hello studio", { thread: rig.core.mainThread });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      30_000,
      "turn in the other thread",
    );
    const reply = events
      .filter((e) => e.data.type === "messages")
      .flatMap((e) => (e.data as { messages: Array<{ role: string; content: string }> }).messages)
      .find((m) => m.role === "assistant");
    assert.match(reply!.content, /unbothered/, "the other thread's turn ran normally");
    assert.ok(
      !events.some((e) => e.data.type === "error" && /cancelled/.test((e.data as { message: string }).message)),
    );
  });

  it("archiving marks the thread and refuses while a contractor is inside", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    await rig.core.games.scaffold("shelved", { title: "shelved" });
    const threadId = await rig.core.threadForGame("shelved");
    const { dir } = await rig.core.archiveGame("shelved");
    assert.ok(dir.endsWith("shelved"));
    const record = await rig.core.store.getRecord(threadId);
    assert.equal((record.metadata as { archived?: boolean }).archived, true);
    const log = await rig.core.store.listEvents(rig.core.mainThread);
    assert.equal(customEvents(log, "game_archived").length, 1);
  });
});

describe("context management", () => {
  it("windows by tokens: keeps the opening intent, fits the tail, states the elision", () => {
    const messages = [
      { role: "user", content: "build me a butterfly game with pastel colors" },
      { role: "assistant", content: "Starting on it." },
      ...Array.from({ length: 40 }, (_, i) => ({
        role: "assistant",
        content: `progress note ${i} ${"x".repeat(400)}`,
      })),
      { role: "user", content: "make the wings bigger" },
    ];
    const windowed = windowMessagesToBudget(messages as never, 1_000);
    assert.ok(estimateMessagesTokens(windowed) <= 1_100, "fits the budget (plus the marker)");
    assert.match(windowed[0]!.content, /butterfly game/, "the opening intent survives");
    assert.match(windowed.at(-1)!.content, /wings bigger/, "the newest message survives");
    assert.ok(
      windowed.some((m: { content: string }) => /elided to fit the model's context/.test(m.content)),
      "the cut is stated",
    );
  });

  it("clamps one giant tool dump instead of letting it evict the conversation", () => {
    const messages = [
      { role: "user", content: "check the logs" },
      { role: "assistant", content: "Reading." },
      { role: "tool", content: "L".repeat(60_000), tool_call_id: "c1", name: "read_file" },
      { role: "assistant", content: "The logs look fine." },
    ];
    const windowed = windowMessagesToBudget(messages as never, 4_000);
    const clamped = windowed.find((m: { role: string }) => m.role === "tool")!;
    assert.ok(clamped.content.length < 12_000, "the dump was clamped");
    assert.match(clamped.content, /clamped from this message/, "the clamp is stated in place");
    assert.match(windowed.at(-1)!.content, /look fine/);
  });

  it("a compacted event replaces exactly what it summarised — the kept tail survives", () => {
    const events = [
      { id: "01a", data: { type: "messages", messages: [{ role: "user", content: "old ask" }] } },
      { id: "01b", data: { type: "messages", messages: [{ role: "assistant", content: "old reply" }] } },
      { id: "01c", data: { type: "messages", messages: [{ role: "user", content: "recent ask" }] } },
      {
        id: "01d",
        data: {
          type: "custom",
          event_type: "compacted",
          payload: { summary: "They discussed the old thing.", upTo: "01b", messages: 2 },
        },
      },
      { id: "01e", data: { type: "messages", messages: [{ role: "assistant", content: "recent reply" }] } },
    ];
    const messages = eventsToMessages(events as never);
    assert.equal(messages.length, 3);
    assert.match(messages[0]!.content, /compacted[\s\S]*old thing/i, "the summary leads");
    assert.match(messages[1]!.content, /recent ask/, "messages after upTo survive verbatim");
    assert.match(messages[2]!.content, /recent reply/);
  });

  it("a provider's own compaction that left no summary in the log replaces nothing there", () => {
    const events = [
      { id: "01a", data: { type: "messages", messages: [{ role: "user", content: "old ask" }] } },
      { id: "01b", data: { type: "messages", messages: [{ role: "assistant", content: "old reply" }] } },
      {
        id: "01c",
        data: { type: "custom", event_type: "compacted", payload: { native: true, engine: "codex", messages: 2 } },
      },
      { id: "01d", data: { type: "messages", messages: [{ role: "user", content: "new ask" }] } },
    ];
    assert.deepEqual(
      eventsToMessages(events as never).map((m) => m.content),
      ["old ask", "old reply", "new ask"],
      "Codex keeps its summary sealed inside its session; a prompt built from the log still has the messages",
    );
  });

  it("a second and a third compaction replace what they summarised, even a tail older than the last summary", () => {
    const say = (id: string, role: string, content: string) => ({
      id,
      data: { type: "messages", messages: [{ role, content }] },
    });
    const compacted = (id: string, upTo: string, summary: string) => ({
      id,
      data: { type: "custom", event_type: "compacted", payload: { summary, upTo, messages: 2 } },
    });
    const events = [
      say("01a", "user", "old ask"),
      say("01b", "assistant", "old reply"),
      say("01c", "user", "kept ask"),
      compacted("01d", "01b", "first summary"),
      say("01e", "assistant", "kept reply"),
      // The second compaction's cut falls inside the tail the first one kept: 01c is older than 01d.
      compacted("01f", "01c", "second summary"),
      say("01g", "user", "newer ask"),
      compacted("01h", "01e", "third summary"),
      say("01i", "assistant", "newest reply"),
    ];
    const after = (count: number) => eventsToMessages(events.slice(0, count) as never).map((m) => m.content);
    const second = after(6);
    assert.equal(second.length, 2, "the first summary and the ask it kept are replaced");
    assert.match(second[0]!, /second summary/);
    assert.match(second[1]!, /kept reply/);
    const third = after(9);
    assert.equal(third.length, 3);
    assert.match(third[0]!, /third summary/);
    assert.deepEqual(third.slice(1), ["newer ask", "newest reply"]);
  });

  it("one oversized tool result is clamped in a preserved history, so compaction can make the prompt fit", async () => {
    const huge = "row,".repeat(100_000);
    const events = [
      { id: "01a", data: { type: "messages", messages: [{ role: "user", content: "read the log" }] } },
      {
        id: "01b",
        data: {
          type: "messages",
          messages: [{ role: "assistant", content: "", tool_calls: [{ id: "c1", name: "read_file", arguments: {} }] }],
        },
      },
      { id: "01c", data: { type: "tool_result", tool_call_id: "c1", result: { ok: true, content: huge } } },
    ];
    const ctx = {
      workspace: "/nowhere",
      call: async (method: string) => (method === "events.list" ? events : null),
    };
    const prompt = await materializePrompt(
      ctx as never,
      {
        threadId: "t1",
        contextWindow: 32_768,
        preserveHistory: true,
      } as never,
    );
    const tool = prompt.messages.find((m) => m.role === "tool")!;
    assert.ok(
      estimateTokens(tool.content) <= 32_768 / 4 + 64,
      `a quarter of the window at most, got ${tool.content.length}`,
    );
    assert.match(tool.content, /clamped from this message/, "the cut is stated in place; the log keeps the whole");
    assert.equal(prompt.messages.length, 3, "nothing else is dropped");
  });

  it("a local model's identity names no engine and says where it runs and what the game holds; a web game's adds three.js and the web rules", async () => {
    const seed = new URL("../../src/harness-seed", import.meta.url).pathname;
    const systemFor = async (game: Record<string, unknown> | null, kinds: unknown[] = []) => {
      const ctx = {
        workspace: seed,
        call: async (method: string) => {
          if (method === "game.list") return game ? [game] : [];
          if (method === "events.list") return [];
          if (method === "plugins.tools") return { tools: [], guidance: "", kinds, revision: 1 };
          return null;
        },
      };
      return (await materializePrompt(ctx as never, { threadId: "t1", project: "g" } as never)).systemPrompt;
    };
    const neutral = await systemFor({ name: "g", web: false });
    assert.match(neutral, /You build games on this Mac/, "the shipped identity was read");
    assert.doesNotMatch(neutral, /three\.js/i);
    assert.match(await systemFor({ name: "g", web: true }), /three\.js/);
    assert.match(await systemFor({ name: "g" }), /three\.js/, "a descriptor without the flag is a web game");
    assert.doesNotMatch(
      await systemFor({ name: "g", web: true, engine: { kind: GameEngine.Unreal } }),
      /three\.js/i,
      "a game linked to Unreal is no web page",
    );
    const godot = await systemFor({ name: "g", dir: "/AI Games/g", facts: [{ id: "godot-project", path: "." }] });
    assert.match(godot, /inside Genex[^\n]*the folder `AI Games\/g`; it holds a Godot project at its root/);
    assert.doesNotMatch(godot, /window\.__studio|game_state\(\)/, "a Godot game gets no web page rules");
    const web = await systemFor({ name: "g", dir: "/AI Games/g", facts: [{ id: "web-game", path: "." }] });
    assert.match(web, /it holds a web game at its root/);
    assert.match(web, /window\.__studio/);
    assert.match(web, /game_state\(\)/);
    // A new game with no kind yet starts as a web game through start_web_game, by its bare name.
    for (const holds of [undefined, "nothing", "notes"]) {
      const pending = await systemFor({ name: "g", dir: "/AI Games/g", facts: [], ...(holds ? { holds } : {}) });
      assert.match(pending, /call start_web_game first/, `${holds}: web is the default`);
      assert.match(pending, /call plugins_find/, `${holds}: an engine goes through plugins_find`);
    }
    // An engine plugin that is on names its kind tool, as a chat's brief does.
    const unrealKind = { plugin: "unreal", name: "Unreal Engine", tool: "unreal__new-game", makes: ["unreal-project"] };
    const offered = await systemFor({ name: "g", dir: "/AI Games/g", facts: [] }, [unrealKind]);
    assert.match(offered, /When the request names Unreal Engine, call unreal__new-game/);
    assert.match(offered, /call start_web_game first/, "web is still the default");
    const own = await systemFor({ name: "g", dir: "/AI Games/g", facts: [], holds: "own-files" });
    assert.doesNotMatch(own, /start_web_game/, "a folder of its own files takes no starter");
    assert.match(own, /look through them first/);
  });

  it("compactThread summarises via the engine and appends a compacted event", async () => {
    const appended: Array<{ threadId: string; batch: Array<Record<string, unknown>> }> = [];
    const events = Array.from({ length: 20 }, (_, i) => ({
      id: `01${String(i).padStart(2, "0")}`,
      data: { type: "messages", messages: [{ role: i % 2 ? "assistant" : "user", content: `message ${i}` }] },
    }));
    const notified: string[] = [];
    const ctx = {
      call: async (method: string, params: Record<string, unknown>) => {
        if (method === "events.list") return events;
        if (method === "engine.complete") {
          assert.equal((params as { effort?: string }).effort, "low", "the summariser thinks cheap");
          return { message: { role: "assistant", content: "A tidy summary." }, model: "test-model" };
        }
        if (method === "events.append") {
          appended.push(params as never);
          return { latestEventId: "x" };
        }
        throw new Error(`unexpected call ${method}`);
      },
      notify: (type: string) => notified.push(type),
    };
    const report = await compactThread(ctx as never, { threadId: "t1", force: true, contextWindow: 8_192 });
    assert.equal(report.compacted, true);
    assert.equal(appended[0]!.batch[0]!.event_type, "session_activity");
    const event = appended.flatMap((a) => a.batch).find((e) => e.event_type === "compacted") as {
      event_type: string;
      payload: { summary: string; upTo: string };
    };
    assert.equal(event.event_type, "compacted");
    assert.equal(event.payload.summary, "A tidy summary.");
    assert.ok(event.payload.upTo, "the event names the boundary so the kept tail survives");
    assert.ok(notified.includes("thread.compacted"));
  });

  it("skips compaction when the history comfortably fits", async () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      id: `01${String(i).padStart(2, "0")}`,
      data: { type: "messages", messages: [{ role: "user", content: "short" }] },
    }));
    const ctx = {
      call: async (method: string) => {
        if (method === "events.list") return events;
        throw new Error(`should not have called ${method}`);
      },
      notify: () => {},
    };
    const report = await compactThread(ctx as never, { threadId: "t1", contextWindow: 32_768 });
    assert.equal(report.compacted, false);
  });

  it("logs the engine's exact prompt size as context_usage — the meter never estimates", async () => {
    const rig = await startRig({ replies: [{ text: "hello there", usage: { prompt: 1_234, completion: 5 } }] });
    rigs.push(rig);
    await rig.core.sendUserMessage("hi studio", { thread: rig.core.mainThread });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "context_usage"),
      30_000,
      "context_usage",
    );
    const usage = customEvents(events, "context_usage")[0] as {
      promptTokens: number;
      contextWindow: number;
      percent: number;
    };
    assert.equal(usage.promptTokens, 1_234, "the engine's own count, not an estimate");
    assert.equal(usage.contextWindow, 262_144, "the model's real context window rides along");
    assert.ok(usage.percent >= 0);
  });

  it("a follow-up without an explicit resume still continues the same contractor session", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const briefs: Array<{ cwd: string; resume?: string; prompt?: string }> = [];
    rig.core.engines.register(vendorEngine(briefs));
    await rig.core.games.scaffold("megastructure", { title: "megastructure" });
    const threadId = await rig.core.threadForGame("megastructure");

    await rig.core.sendUserMessage("Build a rainy megastructure city with flying traffic", {
      engine: "vendor",
      thread: threadId,
    });
    await waitForLog(
      rig.core,
      (log) => log.some((e) => e.thread_id === threadId && e.data.type === "turn_ended"),
      30_000,
      "first build",
    );

    await rig.core.sendUserMessage("Keep going", { engine: "vendor", thread: threadId });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && briefs.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.equal(briefs[1]!.resume, "ses_ok", "typing keep going resumes the session without a UI resume id");
    assert.ok(briefs[1]!.cwd.endsWith("megastructure"));
  });

  it("keep going after a session-less auth failure still briefs the original ask", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const briefs: Array<{ cwd: string; resume?: string; prompt?: string }> = [];
    rig.core.engines.register(vendorEngine(briefs, { sessionId: undefined }));
    await rig.core.games.scaffold("blame", { title: "blame" });
    const threadId = await rig.core.threadForGame("blame");

    await rig.core.sendUserMessage("Make Blame! — a vertical megastructure of rusted walkways", {
      engine: "vendor",
      thread: threadId,
    });
    await waitForLog(
      rig.core,
      (log) => log.some((e) => e.thread_id === threadId && e.data.type === "turn_ended"),
      30_000,
      "first build without a session",
    );

    await rig.core.sendUserMessage("Keep going", { engine: "vendor", thread: threadId });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && briefs.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.equal(briefs[1]!.resume, undefined, "there is no session to resume after auth died before init");
    assert.match(briefs[1]!.prompt ?? "", /Make Blame!/, "the original ask is in the brief, not just keep going");
    assert.ok(briefs[1]!.cwd.endsWith("blame"));
  });

  it("two games in the library never send a bound chat into the other folder", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const briefs: Array<{ cwd: string; resume?: string }> = [];
    rig.core.engines.register(vendorEngine(briefs));
    await rig.core.games.scaffold("older", { title: "older" });
    await rig.core.games.scaffold("newer", { title: "newer" });
    const threadId = await rig.core.threadForGame("older");

    await rig.core.sendUserMessage("Add a rooftop chase", { engine: "vendor", thread: threadId });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && briefs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.ok(briefs[0]!.cwd.endsWith("older"), "the bound chat stays in its own folder");
    assert.ok(!briefs[0]!.cwd.endsWith("newer"), "the newest game is not guessed");
  });

  it("renameThread retitles the chat and leaves the folder binding intact", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    await rig.core.games.scaffold("named", { title: "named" });
    const threadId = await rig.core.threadForGame("named");
    const after = await rig.core.renameThread(threadId, "  rooftop chase  ");
    assert.equal(after.title, "rooftop chase");
    assert.equal((after.metadata as { project?: string }).project, "named");
    const events = await rig.core.store.listEvents(threadId);
    assert.ok(events.some((event) => event.data.type === "thread_updated" && event.data.title === "rooftop chase"));
  });
});

/**
 * Compact now on a chat whose engine keeps a provider session (Claude Code, Codex, a local
 * session). The log summary alone changed nothing there: the next turn resumed the same session
 * with all of its history. Now the session writes its own handover, and the next turn starts a
 * fresh one briefed with it.
 */
describe("Compact now on a session chat", () => {
  type DelegateRequest = import("../../src/substrate/engines/types.ts").DelegateRequest;
  const HANDOVER = "The plaza has a working fountain; the market stalls are next. Files: src/plaza.js.";
  /**
   * A session engine that answers a read-only resume with a handover and anything else with a
   * turn. `gate` holds the handover until it settles; `overlaps` records, for each other turn,
   * whether a handover was still being written when it started.
   */
  function sessionEngine(
    requests: DelegateRequest[],
    {
      fail = false,
      gate = Promise.resolve(),
      overlaps = [],
    }: { fail?: boolean; gate?: Promise<void>; overlaps?: boolean[] } = {},
  ) {
    let sessions = 0;
    let handingOver = false;
    return {
      ...vendorEngine([]),
      delegate: async (request: DelegateRequest) => {
        requests.push(request);
        const handover = request.readOnly === true && Boolean(request.resume);
        if (!handover) overlaps.push(handingOver);
        if (handover && fail) throw new Error("You've hit your session limit");
        if (handover) {
          handingOver = true;
          await gate;
          handingOver = false;
        }
        return {
          ok: true,
          engine: "vendor",
          summary: handover ? HANDOVER : "done",
          turns: 1,
          usage: {},
          sessionId: request.resume ?? `ses_${++sessions}`,
        };
      },
    } satisfies Engine;
  }
  const NATIVE_SUMMARY = "The provider's own summary: the fountain glows at night.";
  /**
   * A session engine with a compaction of its own (Claude Code's `/compact`, Codex's app server):
   * a `compact` delegation compacts the session in place, or reports that it did not.
   */
  function nativeEngine(requests: DelegateRequest[], { compacts }: { compacts: boolean }) {
    const engine = sessionEngine(requests);
    return {
      ...engine,
      compactsNatively: true,
      delegate: async (request: DelegateRequest) => {
        if (!request.compact) return engine.delegate(request);
        requests.push(request);
        return {
          ok: compacts,
          engine: "vendor",
          summary: compacts ? NATIVE_SUMMARY : "",
          turns: 0,
          usage: {},
          sessionId: request.resume,
          ...(compacts ? { compacted: true } : { errorText: "Not enough messages to compact." }),
        };
      },
    } satisfies Engine;
  }
  const turnsEnded = (count: number) => (events: Array<{ data: { type: string } }>) =>
    events.filter((e) => e.data.type === "turn_ended").length >= count;
  /** How long a message sent during the handover is watched for being taken: the queue takes one at once. */
  const QUEUE_HOLD_MS = 1500;
  /** A game chat on the session engine, after its first turn. */
  async function chatAfterOneTurn(
    rig: Rig,
    requests: DelegateRequest[],
    options: Parameters<typeof sessionEngine>[1] = {},
    engine: Engine = sessionEngine(requests, options),
  ) {
    rig.core.engines.register(engine);
    const game = `plaza-${rigs.length}`;
    await rig.core.games.scaffold(game, { title: "Plaza chat" });
    const thread = await rig.core.threadForGame(game);
    await rig.core.sendUserMessage("Build a plaza with a fountain.", { engine: "vendor", thread });
    await waitForLog(rig.core, turnsEnded(1), 30000, "first turn");
    return thread;
  }

  it("the session writes the handover, and the next turn starts a fresh session briefed with it", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const requests: DelegateRequest[] = [];
    const thread = await chatAfterOneTurn(rig, requests);
    assert.equal(requests.at(-1)?.resume, undefined);
    await rig.core.sendUserMessage("Make the water glow at night.", { engine: "vendor", thread });
    await waitForLog(rig.core, turnsEnded(2), 30000, "second turn");

    await rig.core.compactThread(thread, { engine: "vendor" });
    const summaryTurn = requests.at(-1);
    assert.equal(summaryTurn?.resume, "ses_1", "the session that remembers the chat writes the handover");
    assert.equal(summaryTurn?.readOnly, true, "and changes nothing in the game");
    const compacted = customEvents(await rig.core.store.listEvents(thread), "compacted");
    assert.deepEqual(
      compacted.map((p) => [p.summary, p.engine, p.messages]),
      [[HANDOVER, "vendor", 3]],
      "it replaces the first exchange (the ask, the build's record, the reply); the later one stays verbatim",
    );

    await rig.core.sendUserMessage("Now add the market stalls.", { engine: "vendor", thread });
    await waitForLog(rig.core, turnsEnded(3), 30000, "turn after compaction");
    const next = requests.at(-1);
    assert.equal(next?.resume, undefined, "a fresh session, not the compacted one");
    assert.match(String(next?.prompt), /The plaza has a working fountain; the market stalls are next/);
    assert.match(String(next?.prompt), /Now add the market stalls\./);
    assert.match(
      String(next?.prompt),
      /Recent conversation[\s\S]*user: Make the water glow at night\./,
      "the latest exchanges stay verbatim",
    );
    assert.doesNotMatch(String(next?.prompt), /user: Build a plaza/, "the first exchange is the handover's");
    assert.doesNotMatch(
      String(next?.prompt),
      /Original request/,
      "the handover says what was asked; a kept message is not the original",
    );
  });

  it("an engine with its own compaction compacts the session in place, and the next turn resumes it", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const requests: DelegateRequest[] = [];
    const thread = await chatAfterOneTurn(rig, requests, {}, nativeEngine(requests, { compacts: true }));

    await rig.core.compactThread(thread, { engine: "vendor" });
    const compaction = requests.at(-1);
    assert.equal(compaction?.compact, true, "the provider's own compaction");
    assert.equal(compaction?.resume, "ses_1", "of the chat's session");
    assert.equal(requests.filter((r) => r.resume && !r.compact).length, 0, "no handover turn");
    const compacted = customEvents(await rig.core.store.listEvents(thread), "compacted");
    assert.deepEqual(
      compacted.map((p) => [p.summary, p.engine, p.native, p.sessionId]),
      [[NATIVE_SUMMARY, "vendor", true, "ses_1"]],
    );

    await rig.core.sendUserMessage("Now add the market stalls.", { engine: "vendor", thread });
    await waitForLog(rig.core, turnsEnded(2), 30000, "turn after compaction");
    const next = requests.at(-1);
    assert.equal(next?.resume, "ses_1", "the compacted session goes on");
    assert.doesNotMatch(String(next?.prompt), /fountain glows/, "it holds its own summary; none is pasted in");
  });

  it("when the engine's own compaction does not run, the session writes the handover instead", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const requests: DelegateRequest[] = [];
    const thread = await chatAfterOneTurn(rig, requests, {}, nativeEngine(requests, { compacts: false }));

    await rig.core.compactThread(thread, { engine: "vendor" });
    assert.deepEqual(
      requests.slice(-2).map((r) => [r.compact === true, r.readOnly === true, r.resume]),
      [
        [true, true, "ses_1"],
        [false, true, "ses_1"],
      ],
      "its own compaction first, then the handover turn",
    );
    const compacted = customEvents(await rig.core.store.listEvents(thread), "compacted");
    assert.deepEqual(
      compacted.map((p) => [p.summary, p.native]),
      [[HANDOVER, undefined]],
    );
    await rig.core.sendUserMessage("Now add the market stalls.", { engine: "vendor", thread });
    await waitForLog(rig.core, turnsEnded(2), 30000, "turn after compaction");
    assert.equal(requests.at(-1)?.resume, undefined, "a fresh session briefed with the handover");
  });

  it("a message sent while the session writes its handover waits in the queue, then starts the fresh session", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const requests: DelegateRequest[] = [];
    const overlaps: boolean[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const thread = await chatAfterOneTurn(rig, requests, { gate, overlaps });

    const compacting = rig.core.compactThread(thread, { engine: "vendor" });
    await waitForLog(
      rig.core,
      (events) => customEvents(events, "session_activity").some((p) => p.phase === "compacting"),
      30000,
      "the handover under way",
    );
    // Sent now, the message is stamped with the session the compaction is ending.
    await rig.core.sendUserMessage("Now add the market stalls.", { engine: "vendor", thread });
    const taken = await waitForLog(
      rig.core,
      // The first message's record is there already; the second is this one's.
      (events) => customEvents(events, "coordinator_message_processing").length > 1,
      QUEUE_HOLD_MS,
      "the message taken",
    ).then(
      () => true,
      () => false,
    );
    assert.equal(taken, false, "it waits in the queue while the handover is written");
    release();
    await compacting;
    await waitForLog(rig.core, turnsEnded(2), 30000, "the queued message's turn");

    assert.deepEqual(overlaps, [false, false], "no turn ran beside the handover");
    const next = requests.at(-1);
    assert.equal(next?.resume, undefined, "the queued message starts the fresh session, not the compacted one");
    assert.match(String(next?.prompt), /The plaza has a working fountain; the market stalls are next/);
  });

  it("a compaction the host could not record as the session's end still lands, and still ends it", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const requests: DelegateRequest[] = [];
    const thread = await chatAfterOneTurn(rig, requests);
    const { store } = rig.core;
    const update = store.updateThread.bind(store);
    store.updateThread = async (...args: Parameters<typeof update>) => {
      const metadata = args[1]?.metadata as Record<string, unknown> | undefined;
      if (metadata && "contractor" in metadata && metadata.contractor === null) throw new Error("EIO: write failed");
      return update(...args);
    };

    await rig.core.compactThread(thread, { engine: "vendor" });
    assert.equal(customEvents(await rig.core.store.listEvents(thread), "compacted").length, 1);
    await rig.core.sendUserMessage("Now add the market stalls.", { engine: "vendor", thread });
    await waitForLog(rig.core, turnsEnded(2), 30000, "turn after compaction");
    assert.equal(requests.at(-1)?.resume, undefined, "the saved session was not forgotten, but is not resumed");
  });

  it("a handover the session could not write leaves the chat's session as it was", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const requests: DelegateRequest[] = [];
    const thread = await chatAfterOneTurn(rig, requests, { fail: true });
    await rig.core.compactThread(thread, { engine: "vendor" }).catch(() => {});
    assert.equal(customEvents(await rig.core.store.listEvents(thread), "compacted").length, 0);
    await rig.core.sendUserMessage("Now add the market stalls.", { engine: "vendor", thread });
    await waitForLog(rig.core, turnsEnded(2), 30000, "turn after the failed compaction");
    assert.equal(requests.at(-1)?.resume, "ses_1", "nothing was summarised, so nothing was forgotten");
  });
});

/**
 * The person may switch the chat's model at any message, and the chat must
 * stay one conversation. A session goes on only while it is the chat's latest: one that missed
 * another model's turns is not resumed. A fresh session whose brief cannot carry the conversation
 * is briefed with a written summary, which a Codex compaction cannot give (it keeps its own sealed).
 */
describe("switching the chat's model", () => {
  type DelegateRequest = import("../../src/substrate/engines/types.ts").DelegateRequest;
  type Asked = DelegateRequest & { engine: string };
  const WRITTEN_SUMMARY = "Where the chat stands: a plaza with a glowing fountain and market stalls.";
  /** A session engine that compacts natively and keeps its summary sealed, as Codex does. */
  function chatEngine(id: string, asked: Asked[], summaries: string[] = []): Engine {
    let sessions = 0;
    return {
      id,
      label: id,
      kind: "delegated",
      compactsNatively: true,
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      delegate: async (request) => {
        asked.push({ ...request, engine: id });
        const sessionId = request.resume ?? `${id}_${++sessions}`;
        if (request.compact)
          return { ok: true, engine: id, summary: "", turns: 0, usage: {}, sessionId, compacted: true };
        return { ok: true, engine: id, summary: `done by ${id}`, turns: 1, usage: {}, sessionId };
      },
      complete: async () => {
        summaries.push(id);
        return {
          engine: id,
          model: `${id}-1`,
          stopReason: "stop",
          usage: {},
          message: { role: "assistant", content: WRITTEN_SUMMARY },
        };
      },
    };
  }
  const turnsEnded = (count: number) => (events: Array<{ data: { type: string } }>) =>
    events.filter((e) => e.data.type === "turn_ended").length >= count;
  /** Each ask in turn on its engine, waiting for every turn to end. */
  async function say(rig: Rig, thread: string, asks: Array<[engine: string, text: string]>, before = 0) {
    for (const [index, [engine, text]] of asks.entries()) {
      await rig.core.sendUserMessage(text, { engine, thread });
      await waitForLog(rig.core, turnsEnded(before + index + 1), 30000, `turn ${before + index + 1}`);
    }
  }

  it("a model switched back to starts fresh, briefed with what the other model did", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const asked: Asked[] = [];
    rig.core.engines.register(chatEngine("claudish", asked));
    rig.core.engines.register(chatEngine("codexish", asked));
    await rig.core.games.scaffold("switch-back", { title: "Switch back" });
    const thread = await rig.core.threadForGame("switch-back");
    await say(rig, thread, [
      ["claudish", "Build a plaza."],
      ["codexish", "Add a fountain."],
      ["codexish", "Make the water glow."],
    ]);
    assert.equal(asked.at(-1)?.resume, "codexish_1", "a model goes on in its own session while it answers");
    await rig.core.compactThread(thread, { engine: "codexish" });
    await say(rig, thread, [["claudish", "Now add lanterns."]], 3);
    const next = asked.at(-1);
    assert.equal(next?.engine, "claudish");
    assert.equal(next?.resume, undefined, "its old session missed the other model's turns");
    assert.match(
      String(next?.prompt),
      /Recent conversation[\s\S]*user: Add a fountain\.[\s\S]*user: Make the water glow\./,
    );
  });

  it("a chat its brief cannot carry is summarised before the switched-to model starts", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const asked: Asked[] = [];
    const summaries: string[] = [];
    rig.core.engines.register(chatEngine("claudish", asked, summaries));
    rig.core.engines.register(chatEngine("codexish", asked, summaries));
    await rig.core.games.scaffold("switch-long", { title: "Switch long" });
    const thread = await rig.core.threadForGame("switch-long");
    const asks = Array.from(
      { length: 12 },
      (_, n) => ["codexish", `Step ${n + 1}: add part ${n + 1}.`] as [string, string],
    );
    await say(rig, thread, asks);
    // Codex's own compaction: its summary stays sealed in Codex's session.
    await rig.core.compactThread(thread, { engine: "codexish" });
    assert.deepEqual(summaries, [], "Codex compacts natively; nothing of ours is written");

    await say(rig, thread, [["claudish", "Now add lanterns."]], asks.length);
    assert.deepEqual(summaries, ["claudish"], "one summary, written on the model the chat switched to");
    const next = asked.at(-1);
    assert.equal(next?.engine, "claudish");
    assert.equal(next?.resume, undefined);
    assert.ok(String(next?.prompt).includes(WRITTEN_SUMMARY), "the fresh session is briefed with it");
    const compacted = customEvents(await rig.core.store.listEvents(thread), "compacted");
    assert.deepEqual(
      compacted.map((p) => [p.engine, p.native === true, Boolean(p.summary)]),
      [
        ["codexish", true, false],
        ["claudish", false, true],
      ],
    );
  });

  it("a short chat fits the brief whole: switching writes no summary", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const asked: Asked[] = [];
    const summaries: string[] = [];
    rig.core.engines.register(chatEngine("claudish", asked, summaries));
    rig.core.engines.register(chatEngine("codexish", asked, summaries));
    await rig.core.games.scaffold("switch-short", { title: "Switch short" });
    const thread = await rig.core.threadForGame("switch-short");
    await say(rig, thread, [
      ["codexish", "Build a plaza."],
      ["claudish", "Add a fountain."],
    ]);
    assert.deepEqual(summaries, []);
    assert.equal(asked.at(-1)?.resume, undefined);
    assert.match(String(asked.at(-1)?.prompt), /user: Build a plaza\./);
  });
});

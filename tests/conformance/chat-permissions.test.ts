/**
 * Claude Code permissions in a game chat, from the host's side: only the session answering a
 * message the person sent in this game's own chat is handed a mode and a way to ask; every other
 * delegation (builders, anything the harness shapes on its own) keeps the sandboxed contract, and
 * a build's lead or the run's coordinator asks from its own seat (lead-sessions-host.test.ts). A question lands in the chat as a pending card and its answer as a
 * settled one; a Stop, the turn's end or a restart withdraws it without anyone's click; and the
 * harness can neither forge the person's chat nor write their questions.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { mainAgentReachNote } from "../../src/main/core/delegation-prompts.ts";
import { readsAfterRewind } from "../../src/main/core/rewind.ts";
import { RecoveryService } from "../../src/main/core/recovery.ts";
import type { CoreInternals, StudioCore } from "../../src/main/studio-core.ts";
import type { ToolPermissionAnswer, ToolPermissionEvent } from "../../src/shared/permissions.ts";
import type { UiEvent } from "../../src/shared/ui-events.ts";
import type { DelegateRequest, PermissionAsk } from "../../src/substrate/engines/types.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";
import { isInside } from "../../src/substrate/paths.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

type Api = Record<string, (input: unknown) => Promise<unknown>>;

const permissionRows = (events: EventEnvelope[]): ToolPermissionEvent[] =>
  events.flatMap((event) =>
    event.data.type === "custom" && event.data.event_type === "tool_permission"
      ? [event.data.payload as ToolPermissionEvent]
      : [],
  );

describe("game chat permissions", () => {
  let lite: CoreLite;
  let core: StudioCore;
  let api: Api;
  let threadId: string;
  const project = "perm-chat";
  const seen: DelegateRequest[] = [];
  const uiEvents: UiEvent[] = [];
  let sent = 0;
  /** What the fake Claude session does once it has its request. */
  let during: (request: DelegateRequest) => Promise<void> = async () => {};

  before(async () => {
    // No project root policy: one test adopts a game from outside the studio's folders.
    lite = await coreLite({ executionPolicy: { runBackgroundImprovement: false }, onUiEvent: (e) => uiEvents.push(e) });
    core = lite.core;
    // No harness in a lite core: a dispatch reaches nothing, and a message is still the person's.
    core.host.dispatch = async () => undefined;
    await core.games.scaffold(project);
    await core.games.scaffold("perm-other");
    threadId = await core.createGameThread(project);
    api = core.api() as unknown as Api;
    const delegate = (id: string) => async (request: DelegateRequest) => {
      seen.push(request);
      await during(request);
      return { ok: true, engine: id, summary: "fixture", turns: 1, usage: {} };
    };
    const engine = (id: string, permissionPrompts: boolean) =>
      ({
        id,
        label: id,
        kind: "delegated",
        supportsSessions: true,
        permissionPrompts,
        status: async () => ({ code: "ready", detail: "fixture" }),
        models: async () => [],
        delegate: delegate(id),
      }) as never;
    core.engines.register(engine("claude-code", true));
    core.engines.register(engine("codex", false));
  });
  after(async () => {
    await lite?.close();
  });

  /** The person sends a message in a chat, as the composer does; its id is what a session answers. */
  const personSays = async (thread = threadId): Promise<string> => {
    const messageId = `msg-perm-${++sent}`;
    await core.sendUserMessage("Make it jump", { thread, clientId: messageId, engine: "claude-code" });
    return messageId;
  };
  /** The harness briefs the chat's own session answering the person's latest message. */
  const brief = async (extra: Record<string, unknown> = {}, messageId?: string): Promise<DelegateRequest> => {
    const answering = messageId ?? (await personSays());
    await api["engine.delegate"]!({
      engine: "claude-code",
      project,
      threadId,
      prompt: "Make it jump",
      chatTurn: { messageId: answering },
      ...extra,
    });
    return seen.at(-1)!;
  };
  const rows = async (requestId?: string): Promise<ToolPermissionEvent[]> =>
    permissionRows(await core.store.listEvents(threadId)).filter(
      (row) => requestId === undefined || row.requestId === requestId,
    );
  /** Start a session that asks once, and wait for its card. */
  const asking = async (ask: Omit<PermissionAsk, "toolUseId">, extra: Record<string, unknown> = {}) => {
    const known = new Set((await rows()).map((row) => row.requestId));
    let answer: ToolPermissionAnswer | undefined;
    during = async (request) => {
      answer = await request.permissions!.ask({ toolUseId: "tu", ...ask }, new AbortController().signal);
    };
    const session = brief(extra).finally(() => {
      during = async () => {};
    });
    let card: ToolPermissionEvent | undefined;
    for (let waited = 0; !card && waited < 200; waited++) {
      card = (await rows()).find((row) => !known.has(row.requestId));
      if (!card) await sleep(25);
    }
    assert.ok(card, "a permission card");
    return {
      card,
      done: async () => {
        await session;
        return answer!;
      },
    };
  };

  it("hands only the session answering the person's message a mode, and no sibling-folder deny list", async () => {
    const chat = await brief({ model: "claude-x" });
    assert.ok(chat.permissions, "the chat's session asks");
    assert.equal(chat.permissions.mode, "auto", "a chat that never chose starts in Auto");
    assert.equal(chat.denyReads, undefined, "the person decides what else it reads");
    assert.deepEqual(chat.permissions.allow, []);
    // The studio's own data folder is fenced by walking it, so a store added later is covered.
    await writeFile(path.join(lite.userData, "future-store.json"), "{}");
    const fence = (await brief({ model: "claude-x" })).permissions!.protectWrites;
    for (const file of [path.join(lite.userData, "future-store.json"), core.layout.exoharness]) {
      assert.ok(fence.includes(file), `fenced: ${path.relative(lite.userData, file)}`);
    }
    assert.ok(
      fence.some((file) => isInside(file, core.layout.harnessWs)),
      "the harness workspace is fenced",
    );
    assert.ok(
      fence.includes(path.join(core.layout.engineHomes, "permissions.json")),
      "and the permission store by name",
    );
    for (const dir of [core.layout.gamesRoot, core.layout.secrets, core.layout.engineHomes]) {
      assert.ok(!fence.includes(dir), `not fenced here: ${dir}`);
    }
    const cwd = core.games.dirFor(project);
    assert.ok(
      fence.every((file) => !isInside(file, cwd) && !isInside(cwd, file)),
      "the game itself is never protected from its chat",
    );

    const unattended = [
      { timeoutMs: 60_000 },
      { selfCapture: { project, root: "/elsewhere", runId: "run-1", facetId: "build" } },
      { readOnly: true },
      { class: "improvement" },
      { ownership: { facetId: "world", owns: ["src/world"], ownsMain: false } },
      { coordinator: { runId: "run-c" }, readOnly: true, timeoutMs: 300_000 },
    ];
    for (const extra of unattended) {
      const request = await brief(extra);
      assert.equal(request.permissions, undefined, `unattended: ${Object.keys(extra).join(", ")}`);
      assert.equal(request.leadAsks, undefined, `nor a lead's: ${Object.keys(extra).join(", ")}`);
      assert.ok(request.denyReads?.includes(core.games.dirFor("perm-other")), "sibling games stay unreadable");
    }
  });

  // The owner asked the chat to read their Downloads and it refused without trying, in Auto: its
  // brief said to stay inside the game's folder. Only the host knows the session reaches the Mac.
  it("tells the session answering the person it reaches their whole Mac, and an unattended one nothing of it", async () => {
    const chat = await brief({ prompt: "Read my downloads folder" });
    assert.ok(chat.permissions, "the chat's session asks");
    assert.ok(chat.prompt.includes(mainAgentReachNote()), "told it works anywhere on the Mac");
    assert.ok(chat.prompt.startsWith("Read my downloads folder"), "after the brief it was given");
    for (const extra of [{ timeoutMs: 60_000 }, { readOnly: true }, { class: "improvement" }]) {
      const request = await brief(extra);
      assert.equal(request.permissions, undefined, `unattended: ${Object.keys(extra).join(", ")}`);
      assert.equal(request.prompt.includes(mainAgentReachNote()), false, `not told: ${Object.keys(extra).join(", ")}`);
    }
  });

  it("asks only for a message the person sent in this chat, while it is still being answered", async () => {
    await api["engine.delegate"]!({ engine: "claude-code", project, threadId, prompt: "x" });
    assert.equal(seen.at(-1)!.permissions, undefined, "a brief that answers no message runs unattended");
    assert.equal(
      (await brief({}, "msg-the-harness-made-up")).permissions,
      undefined,
      "nor one that names a message nobody sent",
    );
    const other = await core.store.createThread({ title: "Other chat", metadata: { kind: "game", project } });
    const elsewhere = await personSays(other);
    assert.equal(
      (await brief({}, elsewhere)).permissions,
      undefined,
      "a message sent in another chat is not this chat's",
    );

    const answered = await personSays();
    assert.ok((await brief({}, answered)).permissions, "legs of the same turn share its message");
    assert.ok((await brief({}, answered)).permissions);
    await api["events.append"]!({
      threadId,
      batch: [{ type: "custom", event_type: "coordinator_message_handled", payload: { messageId: answered } }],
    });
    assert.equal((await brief({}, answered)).permissions, undefined, "a message the queue answered is over");

    const stopped = await personSays();
    await core.stopThread(threadId);
    assert.equal((await brief({}, stopped)).permissions, undefined, "Stop ends whatever the chat was answering");

    await api["engine.delegate"]!({ engine: "claude-code", project, threadId: core.mainThread, prompt: "x" });
    assert.equal(seen.at(-1)!.permissions, undefined, "the Studio thread is not a game chat");
    await api["engine.delegate"]!({ engine: "claude-code", project, prompt: "x" });
    assert.equal(seen.at(-1)!.permissions, undefined, "a nested contractor has no chat");
  });

  // Flipped: Codex's chat session used to get no mode at all, so its chat had no permissions pill.
  // Every engine now follows the chat's mode as far as it can (`permissionModesFor`).
  it("hands another engine's chat session the mode it honours, and keeps its sandboxed fence", async () => {
    const codexBrief = async () => {
      const messageId = await personSays();
      await api["engine.delegate"]!({ engine: "codex", project, threadId, prompt: "x", chatTurn: { messageId } });
      return seen.at(-1)!;
    };
    const runs: Array<[string, string]> = [];
    for (const mode of ["auto", "default", "acceptEdits", "plan", "bypassPermissions"]) {
      await core.setPermissionMode(threadId, mode);
      runs.push([mode, (await codexBrief()).permissions?.mode ?? "none"]);
    }
    assert.deepEqual(runs, [
      ["auto", "auto"],
      ["default", "auto"],
      ["acceptEdits", "auto"],
      ["plan", "plan"],
      ["bypassPermissions", "bypassPermissions"],
    ]);
    assert.equal((await core.store.getRecord(threadId)).metadata?.permissionMode, "bypassPermissions");
    const chat = await codexBrief();
    assert.ok(chat.denyReads?.includes(core.games.dirFor("perm-other")), "sibling games stay unreadable");
    assert.equal(chat.prompt.includes(mainAgentReachNote()), false, "not told it reaches the whole Mac");
    assert.equal(chat.leadAsks, undefined);
    await api["engine.delegate"]!({ engine: "codex", project, threadId, prompt: "x", timeoutMs: 60_000 });
    assert.equal(seen.at(-1)!.permissions, undefined, "unattended work on it keeps no mode");
    await core.setPermissionMode(threadId, "auto");
  });

  it("asks for a plan an engine shows by ending its turn, and goes on in the same session in the mode chosen", async () => {
    const passes: DelegateRequest[] = [];
    core.engines.register({
      id: "bonsai",
      label: "bonsai",
      kind: "direct",
      supportsSessions: true,
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        passes.push(request);
        const summary = passes.length === 1 ? "# Plan\n\n1. Jump on space" : "Added the jump";
        return { ok: true, engine: "bonsai", summary, sessionId: "local-1", turns: 1, usage: {} };
      },
    } as never);
    await core.setPermissionMode(threadId, "plan");
    const known = new Set((await rows()).map((row) => row.requestId));
    const messageId = await personSays();
    const turn = api["engine.delegate"]!({ engine: "bonsai", project, threadId, prompt: "x", chatTurn: { messageId } });
    let card: ToolPermissionEvent | undefined;
    for (let waited = 0; !card && waited < 200; waited++) {
      card = (await rows()).find((row) => !known.has(row.requestId));
      if (!card) await sleep(25);
    }
    assert.ok(card, "a plan card");
    assert.equal(card.tool, "ExitPlanMode");
    assert.equal(card.plan, "# Plan\n\n1. Jump on space");
    assert.equal(passes[0]!.permissions?.mode, "plan");
    core.answerPermission(card.requestId, { decision: "approve_plan", mode: "acceptEdits" });
    const result = (await turn) as { summary: string; turns: number };
    assert.equal(passes.length, 2);
    assert.equal(passes[1]!.resume, "local-1");
    assert.equal(passes[1]!.permissions?.mode, "acceptEdits");
    assert.deepEqual([result.summary, result.turns], ["Added the jump", 2]);
    assert.equal((await core.store.getRecord(threadId)).metadata?.permissionMode, "acceptEdits");
    await core.setPermissionMode(threadId, "auto");
  });

  it("holds a build the chat's session records in Plan behind the plan card: dropped when declined, started once approved", async () => {
    const launch = { name: "start_autopilot", args: { goal: "A neon platformer", direction: "Celeste" } };
    core.engines.register({
      id: "bonsai",
      label: "bonsai",
      kind: "direct",
      supportsSessions: true,
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async () => ({
        ok: true,
        engine: "bonsai",
        summary: "1. Three levels",
        sessionId: "local-2",
        turns: 1,
        usage: {},
        studioToolCalls: [launch],
      }),
    } as never);
    const turn = async (answer: { decision: "deny" } | { decision: "approve_plan"; mode: "acceptEdits" }) => {
      const known = new Set((await rows()).map((row) => row.requestId));
      const messageId = await personSays();
      const pending = api["engine.delegate"]!({
        engine: "bonsai",
        project,
        threadId,
        prompt: "x",
        chatTurn: { messageId },
      });
      let card: ToolPermissionEvent | undefined;
      for (let waited = 0; !card && waited < 200; waited++) {
        card = (await rows()).find((row) => !known.has(row.requestId));
        if (!card) await sleep(25);
      }
      assert.ok(card, "a plan card");
      assert.equal(card.tool, "ExitPlanMode");
      assert.match(String(card.plan), /1\. Three levels[\s\S]*A neon platformer/);
      core.answerPermission(card.requestId, answer);
      return (await pending) as { studioToolCalls?: Array<{ name: string }> };
    };
    await core.setPermissionMode(threadId, "plan");
    const declined = await turn({ decision: "deny" });
    assert.equal(declined.studioToolCalls, undefined, "a declined build never reaches the harness");
    assert.equal((await core.store.getRecord(threadId)).metadata?.permissionMode, "plan");
    const approved = await turn({ decision: "approve_plan", mode: "acceptEdits" });
    assert.deepEqual(approved.studioToolCalls, [launch], "the approved build starts as recorded");
    assert.equal((await core.store.getRecord(threadId)).metadata?.permissionMode, "acceptEdits");
    await core.setPermissionMode(threadId, "auto");
  });

  it("Stop ends the message being answered, never one still queued behind it", async () => {
    // The queue's own receipts, as the harness writes them.
    const queue = (messageId: string, ...records: string[]) =>
      api["events.append"]!({
        threadId,
        batch: records.map((event_type) => ({ type: "custom", event_type, payload: { messageId } })),
      });
    const answering = await personSays();
    await queue(answering, "coordinator_message_queued", "coordinator_message_processing");
    const joined = await personSays();
    await queue(joined, "coordinator_message_queued", "coordinator_message_steering");
    const waiting = await personSays();
    await queue(waiting, "coordinator_message_queued");
    await core.stopThread(threadId);
    assert.equal((await brief({}, answering)).permissions, undefined, "the stopped message is over");
    assert.equal((await brief({}, joined)).permissions, undefined, "so is one its turn took in");
    // The queue answers the waiting one after the Stop: its session is the person's, in their mode.
    await queue(waiting, "coordinator_message_processing");
    assert.ok((await brief({}, waiting)).permissions, "the next queued message still asks");
    // One put back to wait (a run's lead never heard it) outlives a Stop too.
    const handedBack = await personSays();
    await queue(handedBack, "coordinator_message_queued", "coordinator_message_delivered");
    await queue(handedBack, "coordinator_message_requeued");
    await core.stopThread(threadId);
    assert.ok((await brief({}, handedBack)).permissions, "a message put back in the queue");
    await queue(handedBack, "coordinator_message_handled");
  });

  it("the lead model: a run's lead is never the chat's own session, the chat's own session after the run asks", async () => {
    await core.setPermissionMode(threadId, "default");
    // A waking run's lead answers the chat too, in the game folder, but its turn is its run's: it
    // never gets the chat's own permissions, and without a run of this chat behind its grant it asks
    // nobody (a real one asks from its own seat: lead-sessions-host.test.ts).
    const lead = await brief({
      readOnly: true,
      director: { project, root: path.join(core.layout.scratch, "autopilot", "run-n", "integration"), runId: "run-n" },
      timeoutMs: 600_000,
      chatTurn: { messageId: "run-n" },
    });
    assert.equal(lead.permissions, undefined);
    assert.equal(lead.leadAsks, undefined);
    // After the run it led, the chat's own session answers the person, with the run's controls.
    const after = await brief({ runControls: { runId: "run-n", messageId: "m" } });
    assert.equal(after.permissions?.mode, "default", "the person's mode, not a silent sandbox");
  });

  it("the picker sets the chat's mode and the mode new chats start in", async () => {
    const view = await core.setPermissionMode(threadId, "plan");
    assert.equal(view.defaultMode, "default", "Plan stays with the chat that chose it");
    assert.equal((await brief()).permissions?.mode, "plan");
    assert.equal(
      (await core.setPermissionMode(threadId, "bypassPermissions")).defaultMode,
      "default",
      "so does Bypass: no chat runs unasked unless confirmed in it",
    );
    await core.setPermissionMode(threadId, "plan");
    const other = await core.store.createThread({ title: "Second chat", metadata: { kind: "game", project } });
    await core.setPermissionMode(null, "acceptEdits");
    const first = await personSays(other);
    await api["engine.delegate"]!({
      engine: "claude-code",
      project,
      threadId: other,
      prompt: "x",
      chatTurn: { messageId: first },
    });
    assert.equal(seen.at(-1)!.permissions?.mode, "acceptEdits", "a chat that never chose starts in the default");
    await core.setPermissionMode(null, "default");
    const second = await personSays(other);
    await api["engine.delegate"]!({
      engine: "claude-code",
      project,
      threadId: other,
      prompt: "x",
      chatTurn: { messageId: second },
    });
    assert.equal(seen.at(-1)!.permissions?.mode, "acceptEdits", "and keeps the mode it first ran in");
    await core.setPermissionMode(null, "auto");
    assert.equal((await brief()).permissions?.mode, "plan", "a chat that chose keeps its own");
    await assert.rejects(core.setPermissionMode(core.mainThread, "plan"), /game chat/);
    await assert.rejects(core.setPermissionMode(threadId, "yolo"), /Unknown permission mode/);
    assert.ok(uiEvents.some((event) => event.type === "permissions.changed"));
  });

  it("a question waits in the chat, and 'always' keeps its grants for the game and the chat", async () => {
    await core.setPermissionMode(threadId, "default");
    const { card, done } = await asking({
      tool: "Bash",
      input: {
        command: "npm install three",
        description: "Install three",
        junk: "x".repeat(5000),
        deep: { a: { b: { c: 1 } } },
        many: Array.from({ length: 30 }, (_, i) => i),
      },
      title: "  Claude wants to run npm install three  ",
      displayName: "Run command",
      description: "Install three",
      reason: "\x1b[1mThis command requires approval\x1b[0m",
      always: [
        { kind: "rule", rule: "Bash(npm install:*)", scope: "game" },
        { kind: "rule", rule: "Bash(ls:*)", scope: "chat" },
        { kind: "directory", path: "/tmp/refs" },
      ],
    });
    assert.equal(card.state, "pending");
    assert.equal(card.tool, "Bash");
    assert.equal(card.subject, "npm install three");
    assert.equal(card.title, "Claude wants to run npm install three");
    assert.equal(card.reason, "This command requires approval");
    assert.equal(card.project, project);
    assert.equal((card.input.junk as string).length, 2000);
    assert.deepEqual(card.input.deep, { a: { b: "…" } });
    assert.equal((card.input.many as unknown[]).length, 21);
    assert.equal(card.always?.length, 3);
    assert.ok(
      uiEvents.some(
        (event) =>
          event.type === "tool.permission" && (event.payload as { requestId?: string }).requestId === card.requestId,
      ),
    );

    assert.throws(() => core.answerPermission(card.requestId, { decision: "maybe" }), /Invalid/);
    assert.throws(
      () => core.answerPermission(card.requestId, { decision: "approve_plan", mode: "bypassPermissions" }),
      /Invalid/,
    );
    assert.throws(
      () => core.answerPermission(card.requestId, { decision: "deny", message: "x".repeat(4001) }),
      /Invalid/,
    );
    assert.equal(core.answerPermission("perm_unknown", { decision: "allow" }), false);
    assert.equal(core.answerPermission(card.requestId, { decision: "always" }), true);
    assert.deepEqual(await done(), { decision: "always" });
    assert.equal(core.answerPermission(card.requestId, { decision: "allow" }), false, "a second click changes nothing");

    const settled = (await rows(card.requestId)).at(-1)!;
    assert.deepEqual([settled.state, settled.by, settled.granted], ["allowed", "user", "always"]);
    const view = await core.permissionSettings();
    assert.deepEqual(
      view.rules.map((entry) => [entry.project, entry.rules]),
      [[project, ["Bash(npm install:*)"]]],
    );
    const next = await brief();
    assert.deepEqual(next.permissions?.allow, ["Bash(npm install:*)", "Bash(ls:*)"]);
    assert.deepEqual(next.permissions?.directories, [path.resolve("/tmp/refs")]);
    const other = await core.store.createThread({ title: "Third chat", metadata: { kind: "game", project } });
    const message = await personSays(other);
    await api["engine.delegate"]!({
      engine: "claude-code",
      project,
      threadId: other,
      prompt: "x",
      chatTurn: { messageId: message },
    });
    assert.deepEqual(seen.at(-1)!.permissions?.allow, ["Bash(npm install:*)"], "a chat grant stays in its chat");

    const forgotten = await core.forgetPermission(project, "Bash(npm install:*)");
    assert.deepEqual(forgotten.rules, []);
  });

  it("a deny carries the person's words; a plan approval sets the chat's mode", async () => {
    const denied = await asking({
      tool: "Write",
      input: { file_path: "/Users/me/notes.md", content: "hi" },
      always: [],
    });
    assert.equal(denied.card.subject, "/Users/me/notes.md");
    // `withdrawn` is the host's alone: an answer from the Studio UI that claims it is the person's own.
    core.answerPermission(denied.card.requestId, {
      decision: "deny",
      message: "  Write it inside the game  ",
      withdrawn: true,
    } as never);
    assert.deepEqual(await denied.done(), { decision: "deny", message: "Write it inside the game" });
    const deniedRow = (await rows(denied.card.requestId)).at(-1)!;
    assert.deepEqual(
      [deniedRow.state, deniedRow.by, deniedRow.message, deniedRow.granted],
      ["denied", "user", "Write it inside the game", undefined],
    );

    await core.setPermissionMode(threadId, "plan");
    const plan = await asking({ tool: "ExitPlanMode", input: { plan: "# Plan\n\n1. Jump" }, always: [] });
    assert.equal(plan.card.plan, "# Plan\n\n1. Jump");
    assert.equal("plan" in plan.card.input, false, "the plan is not kept twice");
    core.answerPermission(plan.card.requestId, { decision: "approve_plan", mode: "acceptEdits" });
    assert.deepEqual(await plan.done(), { decision: "approve_plan", mode: "acceptEdits" });
    const planRow = (await rows(plan.card.requestId)).at(-1)!;
    assert.deepEqual([planRow.state, planRow.mode, planRow.granted], ["allowed", "acceptEdits", "once"]);
    assert.equal((await core.store.getRecord(threadId)).metadata?.permissionMode, "acceptEdits");
    assert.equal((await brief()).permissions?.mode, "acceptEdits");
  });

  it("the end of the turn and Stop withdraw a waiting question", async () => {
    const ended = await asking({ tool: "Bash", input: { command: "rm -rf build" }, always: [] });
    await core.append([{ type: "turn_ended", status: "cancelled" }], threadId);
    // Flipped (review F5): a withdrawal is the host's own deny, marked so Claude reads it as it is.
    assert.deepEqual(await ended.done(), {
      decision: "deny",
      withdrawn: true,
      message: "The turn ended before the user answered.",
    });
    const endedRow = (await rows(ended.card.requestId)).at(-1)!;
    assert.deepEqual([endedRow.state, endedRow.by], ["denied", "turn"]);
    assert.equal(core.answerPermission(ended.card.requestId, { decision: "allow" }), false);

    const stopped = await asking({ tool: "WebFetch", input: { url: "https://example.com" }, always: [] });
    assert.equal(stopped.card.subject, "https://example.com");
    await core.stopThread(threadId);
    assert.deepEqual(await stopped.done(), {
      decision: "deny",
      withdrawn: true,
      message: "The user stopped this work before answering.",
    });
    assert.equal((await rows(stopped.card.requestId)).at(-1)!.by, "stop");

    // The harness's own Stop (`engine.abort` for the game) withdraws it too.
    const aborted = await asking({ tool: "Bash", input: { command: "ls" }, always: [] });
    await api["engine.abort"]!({ project });
    assert.deepEqual(await aborted.done(), {
      decision: "deny",
      withdrawn: true,
      message: "The user stopped this work before answering.",
    });
  });

  it("a game kept outside the studio's folders does not deny its neighbours to the sandboxed shell", async () => {
    // A game in the person's home has the whole home as neighbours: ~/.nvm, git's config, ~/.claude.
    const home = await tmpDir("perm-home-");
    for (const dir of ["mygame", ".nvm", ".config"]) await mkdir(path.join(home, dir), { recursive: true });
    await writeFile(path.join(home, "mygame", "index.html"), "<!doctype html><title>x</title>");
    const adopted = await core.adoptProject(path.join(home, "mygame"));
    await api["engine.delegate"]!({ engine: "claude-code", project: adopted.name, prompt: "x", timeoutMs: 60_000 });
    const denied = seen.at(-1)!.denyReads ?? [];
    assert.ok(!denied.some((dir) => isInside(home, dir)), `nothing of the home is denied: ${denied.join(", ")}`);
    assert.ok(denied.includes(path.resolve(core.games.dirFor("perm-other"))), "other games still are");
    // A worktree still reads its own game: its node_modules link and git metadata point there.
    const worktree = path.join(core.layout.scratch, "autopilot", "run-w", "worker");
    await mkdir(worktree, { recursive: true });
    await mkdir(path.join(core.layout.scratch, "autopilot", "run-w", "neighbour"), { recursive: true });
    await api["engine.delegate"]!({ engine: "claude-code", project, prompt: "x", cwd: worktree, timeoutMs: 60_000 });
    const worker = seen.at(-1)!.denyReads ?? [];
    assert.ok(!worker.includes(path.resolve(core.games.dirFor(project))), "its own game is readable");
    assert.ok(
      worker.some((dir) => dir.endsWith("neighbour")),
      "another worktree is not",
    );
  });

  it("the harness cannot make a thread of its own read as the person's chat, nor write their questions", async () => {
    // thread.create takes a title and nothing else: kind, game, id and mode are the host's.
    const forged = String(
      await api["thread.create"]!({
        title: "x",
        threadId,
        metadata: { kind: "game", project, permissionMode: "bypassPermissions" },
      }),
    );
    assert.notEqual(forged, threadId, "no thread id of the harness's choosing");
    assert.deepEqual((await core.store.getRecord(forged)).metadata ?? {}, {});
    assert.equal((await core.store.getRecord(threadId)).metadata?.kind, "game", "the person's chat is untouched");
    const onForged = await personSays(forged);
    await api["engine.delegate"]!({
      engine: "claude-code",
      project,
      threadId: forged,
      prompt: "x",
      chatTurn: { messageId: onForged },
    });
    assert.equal(seen.at(-1)!.permissions, undefined);
    // Another game's chat does not ask for this game.
    const message = await personSays();
    await api["engine.delegate"]!({
      engine: "claude-code",
      project: "perm-other",
      threadId,
      prompt: "x",
      chatTurn: { messageId: message },
    });
    assert.equal(seen.at(-1)!.permissions, undefined);
    // Only the folders the thread records reach a chat's session; a harness-named one does not.
    assert.equal((await brief({ extraReads: ["/private/etc"] })).extraReads, undefined);
    const row = {
      type: "custom",
      event_type: "tool_permission",
      payload: { requestId: "perm_x", tool: "Bash", subject: "npm test", state: "pending" },
    };
    await assert.rejects(api["events.append"]!({ threadId, batch: [row] }), /studio only/);
    await assert.rejects(
      api["events.append"]!({ threadId, batch: [{ ...row, event_type: "plugin_consent" }] }),
      /studio only/,
    );
    const { turnId } = (await api["turn.begin"]!({ threadId })) as { turnId: string };
    await assert.rejects(api["turn.append"]!({ turnId, batch: [row] }), /studio only/);
    await api["turn.end"]!({ turnId, status: "ok" });
    assert.equal((await rows("perm_x")).length, 0);
  });

  it("a rewind narrows the folders a chat reads, never widens them", () => {
    const recorded = ["/Users/me/refs", "/Users/me/art"];
    assert.deepEqual(
      readsAfterRewind(recorded, [{ extraReads: ["/Users/me/refs"] }, { extraReads: ["/private/etc"] }]),
      ["/Users/me/refs"],
      "a queue row the harness wrote cannot add a folder",
    );
    assert.deepEqual(readsAfterRewind(undefined, [{ extraReads: ["/Users/me/refs"] }]), []);
  });

  it("a plan approved into Auto on a model without it goes on asking first", async () => {
    await core.setPermissionMode(threadId, "auto");
    during = async (request) => request.permissions!.onMode!("default");
    await brief({ model: "claude-z" });
    during = async () => {};
    await core.setPermissionMode(threadId, "plan");
    const plan = await asking({ tool: "ExitPlanMode", input: { plan: "1. Jump" }, always: [] }, { model: "claude-z" });
    assert.throws(() => core.answerPermission(plan.card.requestId, { decision: "allow" }), /does not fit/);
    core.answerPermission(plan.card.requestId, { decision: "approve_plan", mode: "auto" });
    assert.deepEqual(await plan.done(), { decision: "approve_plan", mode: "default" });
    assert.equal((await core.store.getRecord(threadId)).metadata?.permissionMode, "default");
  });

  it("Auto the session could not start in is remembered for its model, and the picker reaches a running session", async () => {
    await core.setPermissionMode(threadId, "auto");
    during = async (request) => request.permissions!.onMode!("default");
    await brief({ model: "claude-x" });
    assert.ok((await core.permissionSettings()).autoUnavailable.includes("claude-x"));
    during = async (request) => {
      request.permissions!.onMode!("default");
      request.permissions!.onMode!("auto");
    };
    await brief({ model: "claude-x" });
    assert.ok(
      !(await core.permissionSettings()).autoUnavailable.includes("claude-x"),
      "the CLI settling its gate a moment later counts too",
    );

    const switched: string[] = [];
    let refuse = false;
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    during = async (request) => {
      request.permissions!.onControl!({
        setMode: async (mode) => {
          if (refuse)
            throw Object.assign(new Error("refused"), { code: mode === "auto" ? "auto_unavailable" : "unreachable" });
          switched.push(mode);
        },
      });
      ready();
      await held;
    };
    const session = brief({ model: "claude-y" });
    await started;
    await core.setPermissionMode(threadId, "acceptEdits");
    assert.deepEqual(switched, ["acceptEdits"]);
    refuse = true;
    const view = await core.setPermissionMode(threadId, "auto");
    assert.ok(view.autoUnavailable.includes("claude-y"), "Auto refused mid-turn is shown, not thrown");
    await assert.rejects(core.setPermissionMode(threadId, "default"), /next message/);
    release();
    await session;
    during = async () => {};
    refuse = false;
    await core.setPermissionMode(threadId, "bypassPermissions");
    assert.deepEqual(switched, ["acceptEdits"], "a finished session is not switched");
  });
});

describe("a restart", () => {
  it("withdraws a question nobody answered, once", async () => {
    const lite = await coreLite();
    const { core } = lite;
    const threadId = await core.store.createThread({ title: "chat", metadata: { kind: "game", project: "arena" } });
    const row = (requestId: string, state: ToolPermissionEvent["state"]): ToolPermissionEvent => ({
      requestId,
      project: "arena",
      threadId,
      tool: "Bash",
      subject: "ls",
      input: { command: "ls" },
      state,
      ...(state === "pending" ? {} : { by: "user" as const }),
    });
    await core.store.appendEvents(
      threadId,
      [row("waiting", "pending"), row("answered", "pending"), row("answered", "allowed")].map((payload) => ({
        type: "custom" as const,
        event_type: "tool_permission",
        payload,
      })),
    );
    for (let restart = 0; restart < 2; restart++) {
      await new RecoveryService(core, {} as CoreInternals).closeInterruptedWork();
      const questions = permissionRows(await core.store.listEvents(threadId));
      assert.equal(questions.length, 4, "only the unanswered question gains a closure, once");
      assert.deepEqual(questions.at(-1), { ...row("waiting", "denied"), by: "restart" });
    }
    assert.equal(core.answerPermission("waiting", { decision: "allow" }), false);
    await lite.close();
  });
});

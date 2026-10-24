/**
 * Steer, the host's half, without the harness: `engine.steer` looks for the session answering the
 * chat on a clock the test owns, cuts a session that cannot read a message mid-turn only between
 * its tool calls, a restated `resume_run` is recorded once per message and text, and the
 * composer's bubble id reaches the queue even before the harness says it has one.
 */
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { after, describe, it } from "node:test";
import { chatTurnOf, FIND_SESSION_MS, openDoor, settleDoor, steerIntoChat } from "../../src/main/core/chat-steer.ts";
import type { ActiveDelegation } from "../../src/main/core/internals.ts";
import { personWroteWatch } from "../../src/main/core/plugin-locks.ts";
import { noteEvent, STEER_CUT_MAX_WAIT_MS, toolsInFlight } from "../../src/main/core/steer-cut.ts";
import { ChatActivityPhase } from "../../src/shared/chat-activity.ts";
import { customRecord } from "../../src/shared/custom-events.ts";
import type { DispatchAction } from "../../src/shared/protocol.ts";
import { EngineId } from "../../src/shared/providers.ts";
import type {
  DelegateEvent,
  DelegateRequest,
  DelegateResult,
  SteerMessage,
} from "../../src/substrate/engines/types.ts";
import type { EventData, EventEnvelope } from "../../src/substrate/types.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";

const lites: CoreLite[] = [];
after(async () => {
  for (const lite of lites) await lite.close();
});
async function lite(): Promise<CoreLite> {
  const made = await coreLite();
  lites.push(made);
  return made;
}

const custom = (event_type: string, payload: Record<string, unknown>): EventData => ({
  type: "custom",
  event_type,
  payload,
});
const payloads = (events: EventEnvelope[], type: string) =>
  events.flatMap((e) => {
    const record = customRecord(e.data);
    return record?.event_type === type ? [record.payload] : [];
  });

/** A clock that passes at once and remembers every wait. */
function testClock(onWait: (waited: number) => void = () => {}) {
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
    onWait(waits.reduce((sum, w) => sum + w, 0));
  };
  return { waits, sleep, waited: () => waits.reduce((sum, w) => sum + w, 0) };
}

const ask = { threadId: "chat", into: "pond", messages: [{ id: "ducks", text: "and ducks" }] };

describe("engine.steer waits for the chat's session on the clock it is given", () => {
  it("no session answers the turn: refused once the whole wait has passed", async () => {
    const clock = testClock();
    const answer = await steerIntoChat(new Map(), ask, clock.sleep);
    assert.deepEqual(answer, { how: null, accepted: [] });
    assert.equal(clock.waited(), FIND_SESSION_MS, "it looked for the whole wait, and no longer");
  });

  it("a session that registers while it waits takes the messages: interrupted, to be resumed with them", async () => {
    const abort = new AbortController();
    const session: ActiveDelegation = {
      project: "pond",
      threadId: "chat",
      engine: "codex",
      startedAt: 0,
      abort,
      chatTurn: "pond",
    };
    const delegations = new Map<string, ActiveDelegation>();
    const clock = testClock((waited) => {
      if (waited >= FIND_SESSION_MS / 2) delegations.set("/games/pond", session);
    });
    const answer = await steerIntoChat(delegations, ask, clock.sleep);
    assert.deepEqual(answer, { how: "interrupt", accepted: ["ducks"] });
    assert.ok(clock.waited() < FIND_SESSION_MS);
    assert.equal(session.steered, true, "its caller resumes it rather than reading a Stop");
    assert.equal(abort.signal.aborted, true);
  });
});

/** A clock whose waits the test ends: each stays pending until `pass` reaches its end, or its signal ends it. */
function heldClock() {
  let now = 0;
  const waits = new Set<{ at: number; resolve: () => void }>();
  const asked: number[] = [];
  return {
    asked,
    sleep(ms: number, signal?: AbortSignal): Promise<void> {
      asked.push(ms);
      return new Promise((resolve, reject) => {
        const wait = { at: now + ms, resolve };
        waits.add(wait);
        signal?.addEventListener(
          "abort",
          () => {
            waits.delete(wait);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
    async pass(ms: number): Promise<void> {
      now += ms;
      for (const wait of [...waits])
        if (wait.at <= now) {
          waits.delete(wait);
          wait.resolve();
        }
      await settled();
    },
  };
}

async function settled(): Promise<void> {
  for (let tick = 0; tick < 5; tick++) await nextTurn();
}

const toolUse = (...ids: string[]): DelegateEvent => ({
  type: "assistant",
  payload: { role: "assistant", parts: ids.map((id) => ({ type: "tool_use", name: "Bash", id, input: "" })) },
});
const toolResult = (...ids: string[]): DelegateEvent => ({
  type: "user",
  payload: { role: "user", parts: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "" })) },
});
const codexActivity = (phase: ChatActivityPhase): DelegateEvent => ({
  type: "activity",
  payload: { phase, engine: EngineId.Codex },
});

/** A promise the test resolves when it says. */
function opened(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The chat's session answering `pond` on `engine`, registered, its tools in flight read from what the test notes. */
function chatSession(engine: string, extra: Partial<ActiveDelegation> = {}) {
  const ended = new AbortController();
  const tools = toolsInFlight(engine);
  const wrote = personWroteWatch();
  const session: ActiveDelegation = {
    project: "pond",
    threadId: "chat",
    engine,
    startedAt: 0,
    abort: new AbortController(),
    chatTurn: "pond",
    settled: ended.signal,
    tools,
    personWrote: wrote,
    ...extra,
  };
  const note = (event: DelegateEvent) => noteEvent(tools, event);
  return { session, delegations: new Map([["/games/pond", session]]), note, wrote };
}

/** A door that has said it takes messages mid-turn, remembering each it was handed. */
function nativeDoor() {
  const sent: SteerMessage[] = [];
  const door = openDoor();
  settleDoor(door, (message) => {
    sent.push(message);
    return true;
  });
  return { door, sent };
}

describe("a session that cannot read a message mid-turn is cut only between tool calls", () => {
  it("a Codex session in a tool: taken as an interrupt at once, cut only once the tool ended", async () => {
    const { session, delegations, note } = chatSession(EngineId.Codex);
    note(codexActivity(ChatActivityPhase.Tool));
    const answer = await steerIntoChat(delegations, ask, heldClock().sleep);
    assert.deepEqual(answer, { how: "interrupt", accepted: ["ducks"] }, "the harness hears an interrupt right away");
    assert.equal(session.steered, true);
    assert.equal(session.cutPending, true);
    await settled();
    assert.equal(session.abort.signal.aborted, false, "never inside the tool: its result would be lost");
    note(codexActivity(ChatActivityPhase.Thinking));
    await settled();
    assert.equal(session.abort.signal.aborted, true, "cut as the item completed");
    assert.equal(session.cutPending, false);
  });

  it("with no tool in flight it is cut at once", async () => {
    const { session, delegations } = chatSession(EngineId.Codex);
    const answer = await steerIntoChat(delegations, ask, heldClock().sleep);
    assert.deepEqual(answer, { how: "interrupt", accepted: ["ducks"] });
    assert.equal(session.abort.signal.aborted, true);
  });

  it("a Claude Code session with two calls running at once is cut once both answered", async () => {
    const { session, delegations, note } = chatSession(EngineId.ClaudeCode);
    note(toolUse("toolu_a", "toolu_b"));
    await steerIntoChat(delegations, ask, heldClock().sleep);
    note(toolResult("toolu_b"));
    await settled();
    assert.equal(session.abort.signal.aborted, false, "toolu_a still runs");
    note(toolResult("toolu_a"));
    await settled();
    assert.equal(session.abort.signal.aborted, true);
  });

  it("native: false is never handed to a session that reads mid-turn: it is cut at its next step", async () => {
    const { door, sent } = nativeDoor();
    const { session, delegations, note } = chatSession(EngineId.ClaudeCode, { steer: door });
    note(toolUse("toolu_a"));
    const answer = await steerIntoChat(delegations, { ...ask, native: false }, heldClock().sleep);
    assert.deepEqual(answer, { how: "interrupt", accepted: ["ducks"] });
    assert.deepEqual(sent, [], "not sent natively");
    await settled();
    assert.equal(session.abort.signal.aborted, false);
    note(toolResult("toolu_a"));
    await settled();
    assert.equal(session.abort.signal.aborted, true, "cut at the boundary");
    // The same session without the flag reads it mid-turn, as before.
    const read = nativeDoor();
    const other = chatSession(EngineId.ClaudeCode, { steer: read.door });
    assert.deepEqual(await steerIntoChat(other.delegations, ask, heldClock().sleep), {
      how: "native",
      accepted: ["ducks"],
    });
    assert.deepEqual(
      read.sent.map((m) => m.id),
      ["ducks"],
    );
    assert.equal(other.session.abort.signal.aborted, false);
  });

  it("native: false with interrupt: false takes nothing and cuts nothing", async () => {
    const { door, sent } = nativeDoor();
    const { session, delegations } = chatSession(EngineId.ClaudeCode, { steer: door });
    const answer = await steerIntoChat(delegations, { ...ask, native: false, interrupt: false }, heldClock().sleep);
    assert.deepEqual(answer, { how: null, accepted: [] });
    assert.deepEqual(sent, []);
    assert.equal(session.abort.signal.aborted, false);
  });

  it("a call that never answers is cut anyway after the cap, on the clock it is given", async () => {
    const { session, delegations, note } = chatSession(EngineId.ClaudeCode);
    const clock = heldClock();
    note(toolUse("toolu_stuck"));
    await steerIntoChat(delegations, ask, clock.sleep);
    await clock.pass(STEER_CUT_MAX_WAIT_MS - 1);
    assert.equal(session.abort.signal.aborted, false);
    await clock.pass(1);
    assert.equal(session.abort.signal.aborted, true, "a stuck id never strands the message");
  });

  it("a later message joins the cut that waits: one cut, its messages taken", async () => {
    const { session, delegations, note } = chatSession(EngineId.Codex);
    const clock = heldClock();
    note(codexActivity(ChatActivityPhase.Tool));
    await steerIntoChat(delegations, ask, clock.sleep);
    const later = { ...ask, messages: [{ id: "geese", text: "and geese" }] };
    assert.deepEqual(await steerIntoChat(delegations, later, clock.sleep), { how: "interrupt", accepted: ["geese"] });
    assert.deepEqual(clock.asked, [STEER_CUT_MAX_WAIT_MS], "one cap for the one cut");
    note(codexActivity(ChatActivityPhase.Thinking));
    await settled();
    assert.equal(session.abort.signal.aborted, true);
  });

  it("interrupt: false still takes nothing from a session in a tool, and leaves it uncut", async () => {
    const { session, delegations, note } = chatSession(EngineId.Codex);
    note(codexActivity(ChatActivityPhase.Tool));
    const answer = await steerIntoChat(delegations, { ...ask, interrupt: false }, heldClock().sleep);
    assert.deepEqual(answer, { how: null, accepted: [] });
    assert.equal(session.steered, undefined);
    note(codexActivity(ChatActivityPhase.Thinking));
    await settled();
    assert.equal(session.abort.signal.aborted, false);
  });

  it("Stop while a cut waits stops the session at once", async () => {
    const { session, delegations, note } = chatSession(EngineId.Codex);
    note(codexActivity(ChatActivityPhase.Tool));
    await steerIntoChat(delegations, ask, heldClock().sleep);
    // What `engine.abort` does.
    session.abort.abort();
    assert.equal(session.abort.signal.aborted, true);
  });

  it("the person's words end the session's waits for a lock: those begun before them, and every one while a cut waits", async () => {
    const native = chatSession(EngineId.ClaudeCode, { steer: nativeDoor().door });
    const before = native.wrote.current.signal;
    await steerIntoChat(native.delegations, ask, heldClock().sleep);
    assert.equal(before.aborted, true, "a wait begun before the message ends");
    assert.equal(native.wrote.current.signal.aborted, false, "a call after it waits as usual");

    const cut = chatSession(EngineId.Codex);
    cut.note(codexActivity(ChatActivityPhase.Tool));
    await steerIntoChat(cut.delegations, ask, heldClock().sleep);
    assert.equal(cut.wrote.current.signal.aborted, true, "the session is cut next: none waits now");

    const refused = chatSession(EngineId.Codex);
    await steerIntoChat(refused.delegations, { ...ask, interrupt: false }, heldClock().sleep);
    assert.equal(refused.wrote.current.signal.aborted, false, "nothing taken: nothing ends");
  });
});

describe("the host reads what a delegated session reports", () => {
  it("a Codex chat session's steer lands only once its tool item completed", async () => {
    const { core, api } = await lite();
    core.host.dispatch = async () => undefined;
    let request: DelegateRequest | undefined;
    const inTool = opened();
    const toolEnds = opened();
    const abortedAt: string[] = [];
    core.engines.register({
      id: EngineId.Codex,
      kind: "delegated",
      label: "Codex",
      permissionPrompts: false,
      supportsSessions: true,
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (asked: DelegateRequest): Promise<DelegateResult> => {
        request = asked;
        asked.onEvent?.(codexActivity(ChatActivityPhase.Tool));
        inTool.resolve();
        await toolEnds.promise;
        const cutInside = asked.signal?.aborted === true;
        asked.onEvent?.(codexActivity(ChatActivityPhase.Thinking));
        asked.onEvent?.(toolUse("item_1"));
        asked.onEvent?.(toolResult("item_1"));
        if (!asked.signal?.aborted)
          await new Promise((resolve) => asked.signal?.addEventListener("abort", resolve, { once: true }));
        abortedAt.push(cutInside ? "inside the tool" : "after the tool");
        return {
          ok: false,
          engine: EngineId.Codex,
          sessionId: "s1",
          turns: 1,
          usage: {},
          summary: "",
          stopReason: "stopped",
        };
      },
    } as never);
    const { name } = await core.games.scaffold("steer-pond");
    const threadId = await core.threadForGame(name);
    const turn = Promise.resolve(
      (api() as unknown as Record<string, (p: unknown) => Promise<unknown>>)["engine.delegate"]?.({
        engine: EngineId.Codex,
        project: name,
        threadId,
        prompt: "build the pond",
        chatTurn: { messageId: "msg_pond" },
      }),
    ).catch(() => null);
    // A delegation that failed to start ends the wait too: the steer below then finds no session.
    await Promise.race([inTool.promise, turn]);
    const steer = (api() as unknown as Record<string, (p: unknown) => Promise<unknown>>)["engine.steer"];
    const answer = await steer?.({ threadId, into: "msg_pond", messages: [{ id: "ducks", text: "and ducks" }] });
    assert.deepEqual(answer, { how: "interrupt", accepted: ["ducks"] });
    assert.equal(request?.signal?.aborted, false, "the tool runs on");
    toolEnds.resolve();
    await turn;
    assert.deepEqual(abortedAt, ["after the tool"]);
  });
});

describe("a run's lead takes the chat's messages, addressed by its run", () => {
  it("a director's session answers the chat only by its own run: never by a message id, never a build worktree", () => {
    const lead = { runId: "run_1", threadId: "chat", project: "pond", root: "/scratch/run_1/integration" };
    const asked = (messageId: string, over: Record<string, unknown> = {}) =>
      ({ project: "pond", prompt: "", threadId: "chat", cwd: lead.root, chatTurn: { messageId }, ...over }) as never;
    const none = { director: null, playtest: null, candidate: null };
    assert.equal(chatTurnOf(asked("run_1"), { ...none, director: lead }), "run_1");
    assert.equal(
      chatTurnOf(asked("msg_1"), { ...none, director: lead }),
      undefined,
      "a lead never answers a message's turn",
    );
    assert.equal(chatTurnOf(asked("run_1"), none), undefined, "a build worktree never answers the chat");
    assert.equal(chatTurnOf(asked("msg_1", { cwd: undefined }), none), "msg_1", "the chat's own session, as before");
  });

  it("engine.steer reaches the lead's running turn, and does not interrupt it when asked not to", async () => {
    const abort = new AbortController();
    const session: ActiveDelegation = {
      project: "pond",
      threadId: "chat",
      engine: "codex",
      startedAt: 0,
      abort,
      chatTurn: "run_1",
    };
    const delegations = new Map([["/scratch/run_1/integration", session]]);
    const words = { threadId: "chat", into: "run_1", messages: [{ id: "lead_1", text: "THE USER SAYS: red" }] };
    const kept = await steerIntoChat(delegations, { ...words, interrupt: false }, testClock().sleep);
    assert.deepEqual(kept, { how: null, accepted: [] }, "a session that cannot read it mid-turn keeps working");
    assert.equal(abort.signal.aborted, false);
    const cut = await steerIntoChat(delegations, words, testClock().sleep);
    assert.deepEqual(cut, { how: "interrupt", accepted: ["lead_1"] });
    assert.equal(abort.signal.aborted, true);
  });
});

describe("a restated resume_run", () => {
  it("records the run's steering once per message and text: a replayed turn adds nothing, a restated one is kept", async () => {
    const { core, api } = await lite();
    const thread = await core.store.createThread({ title: "paused run" });
    await core.store.appendEvents(thread, [
      custom("run_started", { runId: "r1", project: "pond", engine: "codex" }),
      custom("autopilot_paused", { runId: "r1" }),
    ]);
    const resumes: DispatchAction[] = [];
    core.host.dispatch = async (action: DispatchAction) => {
      resumes.push(action);
    };
    const resume = (text: string) =>
      api()["coordinator.tool"]({ threadId: thread, runId: "r1", name: "resume_run", args: { text }, messageId: "m1" });

    await resume("Add rain");
    await resume("Add rain");
    await resume("Add rain and fog");
    const steering = payloads(await core.store.listEvents(thread), "run_steering");
    assert.deepEqual(
      steering.map((p) => [p.sourceMessageId, p.text]),
      [
        ["m1", "Add rain"],
        ["m1", "Add rain and fog"],
      ],
    );
    assert.equal(resumes.length, 3, "each call still asks the same run to resume");
  });
});

describe("the chat is free once a run closes", () => {
  it("continue_build is taken for a finished run while its self-improvement pass still holds the run", async () => {
    const { core, api } = await lite();
    const thread = await core.store.createThread({ title: "finished run" });
    await core.store.appendEvents(thread, [
      custom("run_started", { runId: "r1", project: "pond", engine: "codex" }),
      custom("run_finished", { runId: "r1", project: "pond" }),
    ]);
    // The harness holds the run until its learning pass after run_finished is over (run.settled).
    core.host.options.onNotify?.("run.keepawake", { runId: "r1" });
    const answer = await api()["coordinator.tool"]({
      threadId: thread,
      runId: "r1",
      name: "continue_build",
      args: { text: "Add rain" },
      messageId: "m1",
    });
    assert.match(String(answer), /will continue in this game/);
    assert.deepEqual(
      payloads(await core.store.listEvents(thread), "run_followup_requested").map((p) => p.text),
      ["Add rain"],
    );
  });
});

describe("a contained change after a finished build (golden-boot-glory)", () => {
  it("continue_build records build: false, so the harness hands the change to one builder turn instead of reopening the build", async () => {
    const { core, api } = await lite();
    const thread = await core.store.createThread({ title: "finished run" });
    await core.store.appendEvents(thread, [
      custom("run_started", { runId: "r1", project: "pond", engine: "codex" }),
      custom("run_finished", { runId: "r1", project: "pond" }),
    ]);
    const continueBuild = (messageId: string, args: Record<string, unknown>) =>
      api()["coordinator.tool"]({ threadId: thread, runId: "r1", name: "continue_build", args, messageId });
    await continueBuild("m1", { text: "Remove the name plates", build: false });
    await continueBuild("m1", { text: "Remove the name plates", build: false });
    await continueBuild("m2", { text: "Add a second stadium" });
    assert.deepEqual(
      payloads(await core.store.listEvents(thread), "run_followup_requested").map((p) => [p.text, p.build]),
      [
        ["Remove the name plates", false],
        ["Add a second stadium", undefined],
      ],
    );
  });
});

describe("the composer's bubble id reaches the queue", () => {
  it("before the harness is ready, and whenever it has the queue; never to a ready loop without it", async () => {
    const { core } = await lite();
    const sent: DispatchAction[] = [];
    core.host.dispatch = async (action: DispatchAction) => {
      sent.push(action);
    };
    const send = async (clientId: string) => {
      await core.sendUserMessage("hello", { thread: core.mainThread, clientId });
      return (sent.at(-1) as { messageId?: string }).messageId;
    };

    assert.notEqual(core.host.state, "ready");
    assert.equal(await send("msg_first"), "msg_first", "a first message sent at launch keeps its bubble's id");

    let capabilities: string[] = [];
    Object.defineProperty(core.host, "state", { configurable: true, get: () => "ready" });
    Object.defineProperty(core.host, "hasCapability", {
      configurable: true,
      value: (name: string) => capabilities.includes(name),
    });
    assert.equal(await send("msg_old_loop"), undefined, "a ready loop without the queue would read it as saved");
    capabilities = ["message-queue"];
    assert.equal(await send("msg_queue"), "msg_queue");
  });
});

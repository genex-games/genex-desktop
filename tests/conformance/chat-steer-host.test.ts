/**
 * Steer, the host's half, without the harness: `engine.steer` looks for the session answering the
 * chat on a clock the test owns, a restated `resume_run` is recorded once per message and text,
 * and the composer's bubble id reaches the queue even before the harness says it has one.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { chatTurnOf, FIND_SESSION_MS, steerIntoChat } from "../../src/main/core/chat-steer.ts";
import type { ActiveDelegation } from "../../src/main/core/internals.ts";
import { customRecord } from "../../src/shared/custom-events.ts";
import type { DispatchAction } from "../../src/shared/protocol.ts";
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

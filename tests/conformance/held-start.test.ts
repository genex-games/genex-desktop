/**
 * A Loop the chat started that a plugin held back before its first turn: Genex tells the chat's
 * agent why, behind the scenes and sent as the person's last message was, so it fixes what stopped
 * it and starts the Loop again. Once per message of the person's; never for Genex's own holds.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { heldStartAsk, heldStartRuns } from "../../src/main/core/held-start.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import { isChatReport, MessageOrigin } from "../../src/shared/protocol.ts";

const THREAD = "t1";
const WHY =
  "The Loop didn't start: a plugin of this project held it back: Unreal couldn't be reopened (The game's code didn't build). Then start the Loop again.";
const PERSON = {
  type: "user_message",
  threadId: THREAD,
  text: "make the graphics photoreal",
  engine: "claude-code",
  model: "opus",
  effort: "xhigh",
  autopilot: { roles: { planner: "opus" } },
  project: "bodycam",
  projectDir: "/games/bodycam",
};

let seq = 0;
const custom = (event_type: string, payload: Record<string, unknown>): EventEnvelope => ({
  id: String(++seq).padStart(6, "0"),
  thread_id: THREAD,
  turn_id: null,
  session_id: null,
  created_at: new Date(seq * 1000).toISOString(),
  data: { type: "custom", event_type, payload },
});
const queued = (messageId: string, action: Record<string, unknown>) =>
  custom("coordinator_message_queued", { messageId, action });
const closed = (runId: string, payload: Record<string, unknown> = { startHeld: true }) =>
  custom("run_finished", { runId, stoppedBecause: WHY, ...payload });

describe("a Loop a plugin held back at its start", () => {
  it("is told to the chat's agent with why, as the person's last message was sent, hidden from the chat", () => {
    const events = [queued("m1", PERSON), closed("r1")];
    assert.deepEqual(heldStartRuns(events), ["r1"]);
    const ask = heldStartAsk(THREAD, events, "r1");
    assert.ok(ask);
    assert.ok(ask.text.includes(WHY), "the agent reads why");
    assert.match(ask.text, /start the Loop again/);
    assert.deepEqual(ask.options, {
      engine: "claude-code",
      model: "opus",
      effort: "xhigh",
      autopilot: { roles: { planner: "opus" } },
      thread: THREAD,
      origin: MessageOrigin.LoopHeld,
    });
    assert.ok(isChatReport(ask.options as Record<string, unknown>), "the transcript leaves it out");
  });

  it("is said once per message of the person's: a Loop the agent starts again and is held too waits for them", () => {
    const asked = { ...PERSON, text: "Genex here", origin: MessageOrigin.LoopHeld };
    const events = [queued("m1", PERSON), closed("r1"), queued("m2", asked), closed("r2")];
    assert.equal(heldStartAsk(THREAD, events, "r2"), null);
    const wroteAgain = [...events, queued("m3", PERSON), closed("r3")];
    assert.ok(heldStartAsk(THREAD, wroteAgain, "r3"), "the person's new message earns a new ask");
  });

  it("is not said for a close that wasn't a plugin's block at a new Loop's start, or before any message of the person's", () => {
    for (const payload of [{}, { startHeld: false }, { paused: true }]) {
      const events = [queued("m1", PERSON), closed("r1", payload)];
      assert.deepEqual(heldStartRuns(events), []);
      assert.equal(heldStartAsk(THREAD, events, "r1"), null, JSON.stringify(payload));
    }
    assert.equal(heldStartAsk(THREAD, [closed("r1")], "r1"), null, "no message of the person's");
    assert.equal(heldStartAsk(THREAD, [queued("m1", PERSON), closed("r1")], "other"), null, "another run");
  });

  it("waits for a message the person wrote after the close: theirs is answered first", () => {
    const events = [queued("m1", PERSON), closed("r1"), queued("m2", { ...PERSON, text: "just reopen unreal" })];
    assert.equal(heldStartAsk(THREAD, events, "r1"), null);
  });
});

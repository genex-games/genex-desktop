import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingReadinessTurn } from "../e2e/readiness-events.mjs";

const pendingText = "fixture:pending cancellation proof";
const row = (id: string, data: object, turn: string | null = null, thread = "game") => ({
  id,
  thread_id: thread,
  turn_id: turn,
  data,
});
const earlier = [
  row("old-start", { type: "turn_started" }, "previous"),
  row("old-thinking", { type: "custom", event_type: "session_activity", payload: { phase: "thinking" } }),
  row("old-end", { type: "turn_ended", status: "ok" }, "previous"),
];
const own = [
  row("queue", {
    type: "custom",
    event_type: "coordinator_message_queued",
    payload: { messageId: "own", action: { text: pendingText, threadId: "game" } },
  }),
  row("processing", { type: "custom", event_type: "coordinator_message_processing", payload: { messageId: "own" } }),
  row("other-start", { type: "turn_started" }, "other", "another-game"),
  row("own-start", { type: "turn_started" }, "pending"),
  row("own-thinking", { type: "custom", event_type: "session_activity", payload: { phase: "thinking" } }),
];
test("a preceding response that starts late is never the controlled pending turn", () => {
  assert.equal(pendingReadinessTurn([...earlier, ...own], new Set(), pendingText), "pending");
});
test("the pending turn must have started its engine, and not already ended", () => {
  assert.equal(pendingReadinessTurn([...earlier, ...own.slice(0, -1)], new Set(), pendingText), false);
  assert.equal(
    pendingReadinessTurn(
      [...earlier, ...own, row("end", { type: "turn_ended", status: "cancelled" }, "pending")],
      new Set(),
      pendingText,
    ),
    false,
  );
});
test("a queued marker from before the current Send is never reused", () => {
  assert.equal(pendingReadinessTurn(own, new Set(["queue"]), pendingText), false);
});

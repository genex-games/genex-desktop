import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PENDING_SEND_GRACE_MS,
  newClientId,
  reconcilePendingSends,
  sendPlacement,
  type PendingSend,
} from "../../src/renderer/chat/pending-sends.ts";
import { messageQueueState } from "../../src/shared/message-queue.ts";
import type { EventData, EventEnvelope } from "../../src/substrate/types.ts";

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "game",
  turn_id: null,
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const custom = (id: number, event_type: string, payload: unknown) => event(id, { type: "custom", event_type, payload });
const user = (id: number, content: string) => event(id, { type: "messages", messages: [{ role: "user", content }] });
const send = (clientId: string, text: string, extra: Partial<PendingSend> = {}): PendingSend => ({
  clientId,
  threadId: "game",
  text,
  after: "000002",
  placement: "transcript",
  ...extra,
});
const reconcile = (pending: PendingSend[], events: EventEnvelope[], now = 0) =>
  reconcilePendingSends(pending, events, messageQueueState(events), now);

test("a sent message shows until its durable row arrives, then that row takes its place exactly", () => {
  const pending = [send("c1", "Add a boss")];
  assert.deepEqual(
    reconcile(pending, [user(1, "Earlier"), user(2, "Reply")]).shown.map((s) => s.clientId),
    ["c1"],
  );
  // The queue records it under the composer's id: matched even when the harness edited nothing.
  const saved = [
    user(1, "Earlier"),
    user(3, "Add a boss"),
    custom(4, "coordinator_message_queued", { messageId: "c1", action: { text: "Add a boss" } }),
  ];
  const { shown, adopted } = reconcile(pending, saved);
  assert.deepEqual(shown, []);
  assert.deepEqual([...adopted], [["c1", "000003-0:user"]]);
});

test("the same text sent twice pairs each bubble with its own row", () => {
  const pending = [send("c1", "again"), send("c2", "again")];
  const events = [
    user(3, "again"),
    custom(4, "coordinator_message_queued", { messageId: "c2", action: { text: "again" } }),
  ];
  const first = reconcile(pending, events);
  assert.deepEqual(
    first.shown.map((s) => s.clientId),
    ["c1"],
    "the other row belongs to c2, not to the older bubble",
  );
  assert.deepEqual([...first.adopted], [["c2", "000003-0:user"]]);
});

test("a row written without the queue is matched by its text, once, and only after the send", () => {
  // A harness without the queue, or a refusal the host saved with the text.
  const pending = [send("c1", "Start a run build"), send("c2", "Start a run build")];
  const events = [
    user(1, "Start a run build"),
    user(3, "Start a run build"),
    event(4, { type: "error", message: "Loop can’t start" }),
  ];
  const { shown, adopted } = reconcile(pending, events);
  assert.deepEqual([...adopted], [["c1", "000003-0:user"]], "row 1 is older than the send");
  assert.deepEqual(
    shown.map((s) => s.clientId),
    ["c2"],
  );
  // Once c1 has taken row 3 and left, c2 does not take it in a later render.
  assert.deepEqual(
    reconcilePendingSends([pending[1]!], events, messageQueueState(events), 0, new Set(["000003-0:user"])).shown.map(
      (s) => s.clientId,
    ),
    ["c2"],
  );
});

test("an acknowledged send that became a plan, or never arrived, stops showing", () => {
  const settled = send("c1", "Plan a racing game", { settledAt: 1_000 });
  // Plan review holds the send open for the whole plan: its first row is enough.
  assert.deepEqual(
    reconcile(
      [send("c0", "Plan a racing game")],
      [custom(3, "plan_review", { id: "p", state: "generating", text: "Plan a racing game" })],
      1_000,
    ).expired,
    ["c0"],
  );
  assert.deepEqual(
    reconcile([settled], [], 1_000 + PENDING_SEND_GRACE_MS - 1).shown.map((s) => s.clientId),
    ["c1"],
  );
  assert.deepEqual(reconcile([settled], [], 1_000 + PENDING_SEND_GRACE_MS + 1).expired, ["c1"]);
  // Not yet acknowledged: it waits however long main takes.
  assert.deepEqual(
    reconcile([send("c2", "slow")], [], 10 * PENDING_SEND_GRACE_MS).shown.map((s) => s.clientId),
    ["c2"],
  );
});

test("a message waits below current work, and joins the conversation in an idle chat", () => {
  const idle = messageQueueState([]);
  assert.equal(sendPlacement(false, idle), "transcript");
  assert.equal(sendPlacement(true, idle), "waiting");
  const queued = messageQueueState([
    user(1, "first"),
    custom(2, "coordinator_message_queued", { messageId: "a", action: { text: "first" } }),
  ]);
  assert.equal(sendPlacement(false, queued), "waiting");
  assert.equal(sendPlacement(false, messageQueueState([custom(1, "coordinator_queue_paused", {})])), "waiting");
});

test("client ids are ones the queue accepts", () => {
  const ids = new Set(Array.from({ length: 50 }, () => newClientId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[\w-]{1,80}$/);
});

test("a send steered into the running turn is adopted by its id however far it got", () => {
  const pending = [send("c1", "Give it wings", { placement: "waiting" })];
  const saved = [
    user(3, "Give it wings"),
    custom(4, "coordinator_message_queued", { messageId: "c1", action: { text: "Give it wings" } }),
    custom(5, "coordinator_message_steering", { messageId: "c1", into: "b" }),
  ];
  assert.deepEqual([...reconcile(pending, saved).adopted], [["c1", "000003-0:user"]]);
  assert.equal(sendPlacement(false, messageQueueState(saved)), "waiting", "the next one waits behind it");
  // Read before the chat rendered it as waiting: the placeholder still hands over to that row.
  const read = [...saved, custom(6, "coordinator_message_delivered", { messageId: "c1", into: "b", how: "native" })];
  assert.deepEqual([...reconcile(pending, read).adopted], [["c1", "000003-0:user"]]);
});

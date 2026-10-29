/**
 * The chat says once when an agent went ahead in an app the person was using (a plugin's lock
 * lets agents go ahead of the person): one quiet line, with a button to that plugin's settings.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EntryAction, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";

const event = (id: number, payload: Record<string, unknown>): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: "turn",
  session_id: null,
  created_at: new Date(id).toISOString(),
  data: { type: "custom", event_type: "agent_went_ahead", payload },
});

const lines = (entries: ReturnType<typeof toEntries>) =>
  entries.filter((e) => e.kind === EntryKind.Action && e.action === EntryAction.WentAhead);

describe("an agent that went ahead while the person used an app", () => {
  it("is one line naming the app, with a button to its plugin's settings", () => {
    const [line] = lines(toEntries([event(1, { project: "valley", pluginId: "unity", label: "Unity" })]));
    assert.ok(line?.kind === EntryKind.Action);
    assert.equal(line.text, "An agent used Unity while you were playing.");
    assert.deepEqual(line.wentAhead, { pluginId: "unity", label: "Unity" });
  });

  it("draws nothing for a record that names no plugin or app", () => {
    assert.deepEqual(lines(toEntries([event(1, { project: "valley", label: "Unity" })])), []);
    assert.deepEqual(lines(toEntries([event(2, { pluginId: "unity" })])), []);
  });
});

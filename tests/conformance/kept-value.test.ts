/**
 * The transcript read anew after an event keeps what did not change the object it was
 * (`renderer/chat/kept-value.ts`), so only the rows whose entries changed are drawn again.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import { keptValue } from "../../src/renderer/chat/kept-value.ts";
import { transcriptEntries } from "../../src/renderer/chat/transcript.ts";
import { WORK_KIND } from "../../src/renderer/chat/conversation-entries.ts";

const event = (n: number, data: EventData): EventEnvelope => ({
  id: String(n).padStart(6, "0"),
  thread_id: "game",
  turn_id: null,
  session_id: null,
  created_at: new Date(n).toISOString(),
  data,
});
const said = (n: number, role: "user" | "assistant", content: string) =>
  event(n, { type: EventKind.Messages, messages: [{ role, content }] });
const tool = (n: number, id: string) =>
  event(n, {
    type: EventKind.ToolRequested,
    tool_call_id: id,
    request: { name: "Read", arguments: { file_path: `${id}.js` } },
  });
const read = (events: EventEnvelope[]) =>
  transcriptEntries({ events, threadEvents: events, stateEvents: [], queued: [], activeRunId: null, studio: false });

const HISTORY = [said(1, "user", "Make the sky warmer"), said(2, "assistant", "Done: the sky is warmer.")];

describe("kept transcript entries", () => {
  it("keeps the whole transcript when an event changed nothing in it", () => {
    const before = read(HISTORY);
    const again = read(HISTORY);
    assert.notEqual(again, before, "read anew, the transcript is new objects");
    assert.equal(keptValue(before, again), before);
  });

  it("keeps every earlier entry when a message arrives, and only the new one is new", () => {
    const before = read(HISTORY);
    const kept = keptValue(before, read([...HISTORY, said(3, "user", "And the clouds")]));
    assert.notEqual(kept, before);
    assert.equal(kept.length, before.length + 1);
    before.forEach((entry, index) => assert.equal(kept[index], entry, `entry ${entry.id} is the one it was`));
  });

  it("gives a changed entry a new object but keeps its unchanged parts", () => {
    const working = [...HISTORY, said(3, "user", "Tidy the files"), tool(4, "a"), tool(5, "b")];
    const before = read(working);
    const kept = keptValue(before, read([...working, tool(6, "c")]));
    const work = (list: typeof before) => list.find((entry) => entry.kind === WORK_KIND);
    const was = work(before);
    const now = work(kept);
    assert.ok(was && now && was.kind === WORK_KIND && now.kind === WORK_KIND);
    assert.notEqual(now, was, "the work gained a tool");
    assert.equal(now.items.length, was.items.length + 1);
    was.items.forEach((item, index) => assert.equal(now.items[index], item, `tool row ${item.id} is the one it was`));
    assert.equal(kept[0], before[0], "the rows before the work are kept");
  });
});

describe("kept values", () => {
  it("keeps a map whose entries are equal, and its unchanged values when one changes", () => {
    const before = new Map([
      ["a", { messageId: "m1", count: 2 }],
      ["b", { messageId: "m2" }],
    ]);
    assert.equal(keptValue(before, new Map([...before].map(([key, value]) => [key, { ...value }]))), before);
    const changed = keptValue(
      before,
      new Map([
        ["a", { messageId: "m1", count: 2 }],
        ["b", { messageId: "m3" }],
      ]),
    );
    assert.notEqual(changed, before);
    assert.equal(changed.get("a"), before.get("a"));
    assert.deepEqual(changed.get("b"), { messageId: "m3" });
  });

  it("keeps a set with the same members", () => {
    const before = new Set(["a", "b"]);
    assert.equal(keptValue(before, new Set(["b", "a"])), before);
    assert.notEqual(keptValue(before, new Set(["a"])), before);
  });

  it("sees a key that came or went, and an undefined value that is new", () => {
    const before: Record<string, unknown> = { a: 1 };
    assert.notEqual(keptValue(before, { a: 1, b: 2 }), before);
    assert.notEqual(keptValue<Record<string, unknown>>({ a: 1, b: 2 }, { a: 1 }), before);
    assert.notEqual(keptValue(before, { a: 1, b: undefined }), before);
  });

  it("matches list items by id, so an item put before others keeps those after it", () => {
    const first = { id: "x", text: "one" };
    const second = { id: "y", text: "two" };
    const kept = keptValue(
      [first, second],
      [
        { id: "w", text: "zero" },
        { id: "x", text: "one" },
        { id: "y", text: "two" },
      ],
    );
    assert.equal(kept[1], first);
    assert.equal(kept[2], second);
  });

  it("compares only data: anything else is taken as it comes", () => {
    const day = new Date(1);
    const next = new Date(1);
    assert.equal(keptValue(day, next), next);
    const handler = () => {};
    assert.equal(
      keptValue<unknown>(() => {}, handler),
      handler,
    );
  });
});

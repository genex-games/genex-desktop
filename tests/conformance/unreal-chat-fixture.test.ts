/**
 * A synthetic Unreal chat (`tests/fixtures/unreal-chat/sample-chat.json`) reads as the review's
 * mockup: every connector call one row in words, under "Worked in Unreal" headings, its failures
 * one clipped error line each with the whole text kept, the play views under the work that took
 * them, and the Blender model it delivered under the work that made it. Nothing is a "Tool"
 * narration line, and nothing names a tool the way the agent called it.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { it } from "node:test";
import { type Entry, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import {
  type ActivityItem,
  activitySummary,
  type ConversationEntry,
  conversationEntries,
  stripShots,
  WORK_KIND,
} from "../../src/renderer/chat/conversation-entries.ts";
import { chatCaptures, unrealChatLog } from "../../src/main/dev/fixture-unreal-chat.ts";
import type { ToolChipRow } from "../../src/renderer/ui/ToolChips.tsx";
import type { EventEnvelope } from "../../src/shared/event-log.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

async function sampleChat() {
  const log = await unrealChatLog(ROOT);
  const start = Date.UTC(2026, 0, 1, 12, 0);
  const events: EventEnvelope[] = log.events.map((event, i) => ({
    id: String(i).padStart(6, "0"),
    thread_id: "fog-valley",
    session_id: null,
    turn_id: null,
    created_at: new Date(start + event.at).toISOString(),
    data: event.data,
  }));
  const entries = toEntries(events);
  return { log, entries, shown: conversationEntries(entries) };
}

type Work = Extract<ConversationEntry, { kind: typeof WORK_KIND }>;
const works = (shown: ConversationEntry[]): Work[] => shown.filter((e): e is Work => e.kind === WORK_KIND);
const tools = (items: ActivityItem[]): ToolChipRow[] => items.flatMap((i) => (i.kind === "tool" ? [i.tool] : []));
const unrealRows = (entries: Entry[]): ToolChipRow[] =>
  entries.flatMap((e) => (e.kind === EntryKind.Tools ? e.rows : [])).filter((row) => row.source?.name === "Unreal");

it("every Unreal call in the chat is one row in words, under a Worked in Unreal heading", async () => {
  const { log, entries, shown } = await sampleChat();
  const calls = log.events.filter((e) => e.data.type === "custom" && e.data.event_type === "connector_tool_started");
  const rows = unrealRows(entries);
  assert.equal(rows.length, calls.length, "one row per call");
  assert.equal(entries.filter((e) => e.kind === EntryKind.System).length, 0, "no narration line of its own");
  for (const row of rows) assert.doesNotMatch(row.label, /used a tool|call tool|call_tool/);
  const labels = rows.map((row) => row.label);
  for (const said of [
    "Couldn't write EUA_ValleyBridge",
    "Made Blueprint",
    "Played the level",
    "Took a screenshot",
    "Stopped play",
  ])
    assert.ok(
      labels.some((label) => label.startsWith(said)),
      said,
    );
  const unrealWork = works(shown).filter((work) => tools(work.items).some((row) => row.source?.name === "Unreal"));
  assert.ok(unrealWork.length > 0);
  for (const work of unrealWork)
    assert.match(activitySummary(work.items), /^Worked in (?:.+ and )?Unreal · \d+ steps?$/);
});

it("its failures are one clipped error line each, and the whole text stays in the detail", async () => {
  const { entries } = await sampleChat();
  const failed = unrealRows(entries).filter((row) => row.failed);
  assert.ok(failed.length >= 4, `${failed.length} failures`);
  for (const row of failed) {
    assert.ok(row.label.startsWith("Couldn't") || row.label.includes(": "), row.label);
    assert.ok(row.label.length <= 120, row.label);
    assert.doesNotMatch(row.label, /\n/);
    assert.ok((row.detail?.length ?? 0) >= 1, "the whole error opens in the detail");
  }
  const longest = Math.max(...failed.map((row) => row.detail?.map((line) => line.text).join("\n").length ?? 0));
  assert.ok(longest > 500, "a long traceback is kept whole, not flattened into the line");
});

it("its play views sit under the work that took them; the editor at rest stays in its row", async () => {
  const { log, shown } = await sampleChat();
  const strips = works(shown).map((work) => stripShots(work.items));
  const playTest = strips.find((strip) => strip.length === 2);
  assert.ok(playTest, "the long play test shows both of its play views");
  assert.equal(strips.flat().length, 4);
  const drawn = new Set(chatCaptures(log).map((file) => path.basename(file)));
  for (const shot of strips.flat()) assert.ok(drawn.has(path.basename(shot)), `${shot} is a capture the fixture draws`);
  const rowShots = works(shown).flatMap((work) =>
    tools(work.items).flatMap((row) => (row.shots ?? []).filter((shot) => !shot.play)),
  );
  assert.equal(rowShots.length, 1, "the screenshot of the editor at rest");
});

it("the Blender model it delivered sits under the work that made it", async () => {
  const { shown } = await sampleChat();
  assert.equal(shown.filter((e) => e.kind === EntryKind.Assets).length, 0);
  const delivered = works(shown).filter((work) => work.deliveries?.length);
  assert.equal(delivered.length, 1);
  assert.match(activitySummary(delivered[0]!.items), /^Worked in Blender and Unreal · /);
});

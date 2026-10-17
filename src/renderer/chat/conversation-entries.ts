import type { AssetDeliveredPayload } from "../../shared/game-assets.ts";
import { type Entry, EntryKind } from "../chat-entries.ts";
import type { ToolChipRow } from "../ui/ToolChips.tsx";
import { toolFailed, ToolState } from "../ui/tool-state.ts";
import { USING_A_TOOL, workSummaryWords } from "../words.ts";
import type { RowSize } from "./transcript-window.ts";

/** What one line of a work group is: a tool row, an activity note or a thought. */
export const ActivityItemKind = {
  Tool: "tool",
  Note: "note",
  Thought: "thought",
} as const;
export type ActivityItemKind = (typeof ActivityItemKind)[keyof typeof ActivityItemKind];

/** The conversation's own row beside `Entry`'s kinds: neighbouring background work folded into one group. */
export const WORK_KIND = "work";

export type ActivityItem =
  | { kind: typeof ActivityItemKind.Tool; id: string; tool: ToolChipRow }
  | { kind: typeof ActivityItemKind.Note | typeof ActivityItemKind.Thought; id: string; text: string };
export type ConversationEntry =
  | Exclude<Entry, BackgroundEntry>
  | {
      kind: typeof WORK_KIND;
      id: string;
      items: ActivityItem[];
      /** What the work delivered (a plugin's models, sounds, images): shown under it, not as a block of its own. */
      deliveries?: AssetDeliveredPayload[];
    };

/** The background work the transcript folds into one group: tool rows, activity notes and thinking. */
type BackgroundEntry = Extract<
  Entry,
  { kind: typeof EntryKind.Tools | typeof EntryKind.Activity | typeof EntryKind.Thinking }
>;
const BACKGROUND_KINDS: ReadonlySet<string> = new Set([EntryKind.Tools, EntryKind.Activity, EntryKind.Thinking]);
const isBackground = (entry: Entry): entry is BackgroundEntry => BACKGROUND_KINDS.has(entry.kind);

/**
 * Group only neighboring background activity. Never move a reply, decision or failure; what a
 * group delivered sits under it, and the group goes on after it.
 */
export function conversationEntries(entries: Entry[]): ConversationEntry[] {
  const result: ConversationEntry[] = [];
  for (const entry of entries) {
    const last = result.at(-1);
    if (entry.kind === EntryKind.Assets && last?.kind === WORK_KIND) {
      last.deliveries = [...(last.deliveries ?? []), entry.delivery];
      continue;
    }
    if (!isBackground(entry)) {
      result.push(entry);
      continue;
    }
    let group = result.at(-1);
    if (group?.kind !== WORK_KIND) {
      group = { kind: WORK_KIND, id: entry.id, items: [] };
      result.push(group);
    }
    if (entry.kind === EntryKind.Tools)
      group.items.push(...entry.rows.map((tool) => ({ kind: ActivityItemKind.Tool, id: tool.key, tool })));
    else if (entry.kind === EntryKind.Thinking)
      group.items.push({ kind: ActivityItemKind.Thought, id: entry.id, text: entry.text });
    else
      group.items.push(
        ...entry.rows.map((row, i) => ({ kind: ActivityItemKind.Note, id: `${entry.id}:${i}`, text: row.text })),
      );
  }
  return result;
}

/** Characters on about one line of the chat: a short message still takes a whole line. */
const LINE_CHARS = 80;

/** What a row's height is guessed from before it is measured (`heightEstimate`): text by its length, the rest by kind. */
export function entrySize(entry: ConversationEntry): RowSize {
  const text = "text" in entry ? entry.text : "";
  return { kind: entry.kind, weight: text ? LINE_CHARS + text.length : 1 };
}

export function activitySummary(items: ActivityItem[]): string {
  const tools = items.flatMap((item) => (item.kind === ActivityItemKind.Tool ? [item.tool] : []));
  // Only a recorded running tool is active. Unknown historical outcomes must stay unknown.
  const running = tools.findLast((tool) => tool.state === ToolState.Running);
  if (running) return running.activeLabel ?? USING_A_TOOL;
  if (tools.length > 0)
    return workSummaryWords(
      workSources(items).map((source) => source.name),
      tools.length,
    );
  if (items.every((item) => item.kind === ActivityItemKind.Thought)) return "Thinking details";
  return "Work details";
}

/** A tool call in the work that failed. */
export const failedToolItem = (item: ActivityItem): boolean =>
  item.kind === ActivityItemKind.Tool && toolFailed(item.tool);

/** The plugins and connectors a work group's steps ran in, once each by name, in the order they first ran. */
export function workSources(items: readonly ActivityItem[]): Array<NonNullable<ToolChipRow["source"]>> {
  const seen = new Map<string, NonNullable<ToolChipRow["source"]>>();
  for (const item of items)
    if (item.kind === ActivityItemKind.Tool && item.tool.source && !seen.has(item.tool.source.name))
      seen.set(item.tool.source.name, item.tool.source);
  return [...seen.values()];
}

/** How many play views a work group shows under its heading. */
export const STRIP_SHOTS = 3;

/** The play views a work group shows under its heading: its latest few; the others stay in their rows. */
export function stripShots(items: readonly ActivityItem[]): string[] {
  const play = items.flatMap((item) =>
    item.kind === ActivityItemKind.Tool ? (item.tool.shots ?? []).filter((shot) => shot.play) : [],
  );
  return play.slice(-STRIP_SHOTS).map((shot) => shot.path);
}

/** A work group with results of its own (pictures, deliveries) or a failure stays in the transcript. */
export const workHasResults = (work: { items: readonly ActivityItem[]; deliveries?: readonly unknown[] }): boolean =>
  Boolean(work.deliveries?.length) || stripShots(work.items).length > 0 || work.items.some(failedToolItem);

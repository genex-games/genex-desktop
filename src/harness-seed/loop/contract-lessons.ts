/**
 * The lessons every builder's brief carries (`library/contract-lessons.md`, one bullet per line),
 * as SkillOpt proposes them: never written here, but staged for the host like a skill edit, which
 * applies them when the user's switches allow and lists them in Activity otherwise. A change is a
 * few bounded edits the host can replay onto a file that changed since: one `append` per new
 * lesson, and one `replace` of the exact line (newline to newline) per lesson taken out.
 *
 * Its own module, not library.ts: a seed upgrade keeps a sibling the agent edited, and a new name
 * imported from a kept old library.ts would fail to link.
 */
import type { AnyRecord } from "../types/harness.d.ts";
import type { SkillEdit } from "./skills.ts";

/**
 * What a staged suggestion changes: one skill file, or these lessons. The app keeps the same
 * vocabulary (`src/shared/self-change-files.ts`); persisted, so never rename a value.
 */
export const StagedTarget = { Skill: "skill", Lessons: "lessons" } as const;
export type StagedTarget = (typeof StagedTarget)[keyof typeof StagedTarget];

/** The one file a lessons suggestion may write, relative to the harness workspace. */
export const CONTRACT_LESSONS_FILE = "library/contract-lessons.md";
/** The name a lessons suggestion is staged, refused and remembered under. */
export const LESSONS_SKILL = "contract-lessons";
/** The lessons the file keeps; past it, the oldest give way to the newest. */
export const MAX_CONTRACT_LESSONS = 40;
/** The file's first line, for whoever opens it. */
export const LESSONS_HEADER = "# Lessons the runs learned (read by every brief)";

/** A lesson bullet as the file writes it. */
const BULLET = "- ";

/** One lesson as one line: whitespace collapsed, so a lesson never spills onto the next bullet. */
export function lessonLine(lesson: unknown): string {
  return String(lesson ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The file for these lessons, in order. */
export function renderContractLessons(lessons: readonly unknown[]): string {
  const lines = lessons.map(lessonLine).filter(Boolean);
  return `${LESSONS_HEADER}\n\n${lines.map((line) => `${BULLET}${line}`).join("\n")}\n`;
}

/** The edit that takes one lesson's exact line out: newline to newline, never a longer line it starts. */
function removal(lesson: string): SkillEdit {
  return { op: "replace", anchor: `\n${BULLET}${lesson}\n`, text: "\n" };
}

/**
 * The bounded edits that turn `current` into `current - remove + add`, and that list: removals
 * first, then one append per new lesson. Past `max`, the oldest kept lessons are removed too —
 * as edits, so the cap replays like everything else instead of being a silent slice.
 */
export function lessonEdits(
  current: readonly string[],
  add: readonly string[],
  remove: readonly string[],
  max = MAX_CONTRACT_LESSONS,
): { edits: SkillEdit[]; next: string[] } {
  const removing = new Set(remove.filter((lesson) => current.includes(lesson)));
  const kept = current.filter((lesson) => !removing.has(lesson));
  const adding = [...new Set(add.map(lessonLine))].filter((lesson) => lesson && !current.includes(lesson));
  const overflow = Math.max(0, kept.length + adding.length - max);
  for (const oldest of kept.slice(0, overflow)) removing.add(oldest);
  return {
    edits: [...[...removing].map(removal), ...adding.map((lesson) => ({ op: "append", text: `${BULLET}${lesson}` }))],
    next: [...kept.slice(overflow), ...adding],
  };
}

/** The lessons a list of edits adds and takes out, read back from the edits themselves. */
export function lessonsInEdits(edits: unknown): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const edit of Array.isArray(edits) ? (edits as AnyRecord[]) : []) {
    const text = typeof edit?.text === "string" ? edit.text : "";
    const anchor = typeof edit?.anchor === "string" ? edit.anchor : "";
    if (edit?.op === "append" && text.startsWith(BULLET)) add.push(text.slice(BULLET.length));
    const taken = /^\n- (.+)\n$/.exec(anchor);
    if (edit?.op === "replace" && taken) remove.push(taken[1]!);
  }
  return { add, remove };
}

/** Is this staged record a lessons suggestion? */
export function isLessonsRecord(record: unknown): boolean {
  return (record as AnyRecord | null)?.target === StagedTarget.Lessons;
}

/** The lessons the person refused (a discard or an undo, in the step buffer): never proposed again. */
export function refusedLessons(stepBuffer: unknown): Set<string> {
  const entries = Array.isArray(stepBuffer) ? (stepBuffer as AnyRecord[]) : [];
  const refused = entries.filter((entry) => entry?.skill === LESSONS_SKILL);
  return new Set(refused.flatMap((entry) => lessonsInEdits(entry.edits).add));
}

/** What the lessons suggestion still waiting proposes: its lessons count as known to the next pass. */
export function pendingLessons(staged: unknown): { add: string[]; remove: string[] } {
  const records = Array.isArray(staged) ? staged.filter(isLessonsRecord) : [];
  const read = records.map((record: AnyRecord) => lessonsInEdits(record.edits));
  return { add: read.flatMap((r) => r.add), remove: read.flatMap((r) => r.remove) };
}

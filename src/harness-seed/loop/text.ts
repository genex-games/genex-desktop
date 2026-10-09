/**
 * Text cut to fit a record, a log line or a prompt. A limit is named for what it holds, so a
 * record's field and the line that quotes it agree on how much of a model's words they keep.
 * Also the one rule for two words that are the same word in another form (`sharesStem`).
 */

/** A reason, a note or an error a record keeps (`why`, `rationale`, `error`). */
export const CLIP_REASON = 300;
/** An error or an answer quoted inside a longer sentence. */
export const CLIP_DETAIL = 200;
/** A fragment quoted in a one-line note (`"…"` in a log line). */
export const CLIP_QUOTE = 120;
/** A brief, an ask or a plan step handed on to another session. */
export const CLIP_BRIEF = 400;
/** A scaffolded game's title, taken from the ask or the goal that named it. */
export const CLIP_GAME_TITLE = 48;
/** The shortest stem that makes two words one: "tree" and "trees" are, "a" and "an" are not. */
const MIN_STEM = 4;

/** Is `value` text with something in it besides whitespace? */
export function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Is `word` the same word as `stem` in another form: one begins the other, and the stem is long enough to mean it? */
export function sharesStem(word: string, stem: string): boolean {
  return stem.length >= MIN_STEM && (word.startsWith(stem) || stem.startsWith(word));
}

/** The first `max` characters of `value` as text; nothing (`""`) for null or undefined. */
export function clip(value: unknown, max: number): string {
  return String(value ?? "").slice(0, max);
}

/** Like `clip`, with `…` added when something was cut. */
export function clipMarked(value: unknown, max: number): string {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Cuts at a word boundary, kept in a module of their own (a kept older text.ts still links them). */
export { clipTailWords, clipWords } from "./word-clip.ts";

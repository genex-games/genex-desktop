/**
 * Text cut at a word, never inside one: notes that end "…the needle cli" tell the next builder half
 * a sentence. Its own module so a workspace that
 * kept an older `text.ts` still links the callers that need these; `text.ts` re-exports them.
 */

/** The mark a cut leaves where the words were taken out. */
const CUT_MARK = "…";

/** Whitespace, the only place a word cut may land. */
const SPACE = /\s/;

/**
 * The head of `value` within `max` characters, the mark included: cut after the last whole
 * word that fits, with `…` added. One word longer than the room is cut where the room ends.
 */
export function clipWords(value: unknown, max: number): string {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  if (max <= CUT_MARK.length) return "";
  const room = max - CUT_MARK.length;
  const head = text.slice(0, room);
  if (SPACE.test(text.charAt(room))) return `${head.trimEnd()}${CUT_MARK}`;
  const lastSpace = head.search(/\s\S*$/);
  const kept = lastSpace > 0 ? head.slice(0, lastSpace).trimEnd() : head;
  return `${kept}${CUT_MARK}`;
}

/**
 * The tail of `value` within `max` characters, the mark included: the newest words of a file
 * that appends, cut before the first whole word that fits, with `…` in front. One word longer
 * than the room keeps its last characters.
 */
export function clipTailWords(value: unknown, max: number): string {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  if (max <= CUT_MARK.length) return "";
  const room = max - CUT_MARK.length;
  const start = text.length - room;
  const tail = text.slice(start);
  if (SPACE.test(text.charAt(start - 1))) return `${CUT_MARK}${tail.trimStart()}`;
  const firstSpace = tail.search(SPACE);
  const kept = firstSpace >= 0 && tail.slice(firstSpace).trim() ? tail.slice(firstSpace).trimStart() : tail;
  return `${CUT_MARK}${kept}`;
}

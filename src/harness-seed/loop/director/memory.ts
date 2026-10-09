/**
 * The director's own memory, `.studio/DIRECTOR.md`: the one file that survives a compaction and
 * a resume. The studio keeps a copy of it for the whole run (`keepMemory`, loop-run.ts) and hands it back
 * to the next session clamped to a size a session can afford.
 */

/**
 * The most of `.studio/DIRECTOR.md` a session is handed back. The director's own memory is the
 * one file that survives a compaction and a resume, so it grows for the whole run — and a run that
 * paused twice would otherwise hand the third session a file bigger than the brief that
 * explains it. Head and tail, because the top of that file is what the run set out to do and
 * the bottom is where it actually is.
 */
export const MAX_DIRECTOR_MEMORY = 24_000;
/** How much of the clamp goes to the head; the rest is the tail. */
const DIRECTOR_MEMORY_HEAD = 0.35;
/** Room kept for the banner itself, so a clamped file is never longer than the clamp. */
const DIRECTOR_CLAMP_RESERVE = 96;
/** The banner the clamp leaves in the gap, and the shape that recognises an older one. */
const DIRECTOR_CLAMP_LINE = /^… \d+ characters of older notes dropped by the studio …$/;

/** The first lines of `lines` that fit in `budget` characters (each line counts its newline). */
function headLines(lines: readonly string[], budget: number): string[] {
  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    head.push(line);
    used += line.length + 1;
  }
  return head;
}

/** The last lines of `lines`, never reaching back past `floor`, that fit in `budget` characters. */
function tailLines(lines: readonly string[], budget: number, floor: number): string[] {
  const tail: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= floor; i -= 1) {
    if (used + lines[i].length + 1 > budget) break;
    tail.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  return tail;
}

/**
 * Clamp the director's memory to `max` characters, on line boundaries, keeping the head and the
 * tail and saying how much went. Any banner a previous clamp left is stripped BEFORE measuring,
 * so a run resumed four times carries one banner and not four — the file is clamped on the way
 * out (the artifact the next session restores from) and again on the way in (what is written
 * into the new worktree), and the two together would otherwise accumulate.
 */
export function clampDirectorMemory(text: unknown, max = MAX_DIRECTOR_MEMORY): string {
  const raw = String(text ?? "");
  // Already small enough: returned byte for byte, banner and all, so clamping the same file on
  // the way out and again on the way in is one clamp and not two.
  if (raw.length <= max) return raw;
  const stripped = raw
    .split("\n")
    .filter((line) => !DIRECTOR_CLAMP_LINE.test(line.trim()))
    .join("\n");
  if (stripped.length <= max) return stripped;
  const budget = Math.max(0, max - DIRECTOR_CLAMP_RESERVE);
  const headBudget = Math.floor(budget * DIRECTOR_MEMORY_HEAD);
  const lines = stripped.split("\n");
  const head = headLines(lines, headBudget);
  const tail = tailLines(lines, budget - headBudget, head.length);
  // A file with no line breaks at all (one 40 KB paragraph) has no boundary to cut on; it gets
  // the head, because a memory nobody can read is worse than a memory that stops mid-sentence.
  if (head.length + tail.length === 0) return stripped.slice(0, budget);
  const dropped = stripped.length - (head.join("\n").length + tail.join("\n").length);
  return [...head, `… ${dropped} characters of older notes dropped by the studio …`, ...tail].join("\n");
}

/**
 * What one `keepMemory` pass makes of the file it just read: the text to keep, whether that is
 * new, and the one note worth saying about it. The note belongs to a CHANGE, not to a size:
 * `clampDirectorMemory` keeps clamping for as long as the file is over the ceiling, and the
 * note used to be said before the "nothing changed" guard — so once a run's DIRECTOR.md
 * passed the ceiling, every director tool call pushed the same sentence into the log, and
 * within a couple of hundred calls the 400 entries the director's own `wait` reads were
 * nothing else.
 */
export function directorMemoryKeep(
  raw: unknown,
  kept: string | null | undefined,
): { text: string; changed: boolean; note: string | null } {
  const text = clampDirectorMemory(raw);
  const changed = text !== kept;
  return {
    text,
    changed,
    note:
      changed && text !== raw
        ? `the director's memory was ${String(raw ?? "").length} characters — kept ${text.length} (head and tail)`
        : null,
  };
}

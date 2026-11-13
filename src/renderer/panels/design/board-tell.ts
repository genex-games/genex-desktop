/**
 * What Tell Genex sends: the person's new notes and picks as one message of theirs in the game's
 * chat. Each note names the artboard it is on, by the title the person reads and the file the
 * agent opens, and where on it the note is, so the agent can act on it without the canvas; a note
 * on one of the person's own pictures says what that reference is for. Each pick names the artboard
 * to go with, or the one set aside.
 */
import { DesignPick, type DesignNote } from "../../../shared/design-marks.ts";
import { t } from "../../../shared/i18n.ts";

/** An artboard as a note's place is told: where it hangs and how large. */
type Hung = { file: string; x: number; y: number; width: number; height: number };

/** A share of a length as a whole percentage, 0 to 100. */
const percent = (part: number, whole: number): number =>
  whole > 0 ? Math.round(Math.min(1, Math.max(0, part / whole)) * 100) : 0;

/** A note's words on one line: its own line breaks would read as further notes of the list. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** One note as a line of the message. */
function noteLine(note: DesignNote, frames: readonly Hung[], captionOf: (file: string) => string): string {
  const text = oneLine(note.text);
  const on = note.file ? frames.find((frame) => frame.file === note.file) : undefined;
  if (!on) return t("On the canvas: {text}", { text });
  return t("{title} ({file}), {across}% across and {down}% down: {text}", {
    title: captionOf(on.file),
    file: on.file,
    across: percent(note.x, on.width),
    down: percent(note.y, on.height),
    text,
  });
}

/** One pick as a line of the message. */
function pickLine(file: string, pick: DesignPick, captionOf: (file: string) => string): string {
  const named = { title: captionOf(file), file };
  return pick === DesignPick.Use ? t("Use this: {title} ({file})", named) : t("Not this: {title} ({file})", named);
}

/** What the person has to tell: their new notes, and their new picks by artboard. */
export interface BoardNews {
  notes: readonly DesignNote[];
  picks: ReadonlyArray<{ file: string; pick: DesignPick }>;
}

/** The message for this news: the notes, then the picks; nothing to send for none. */
export function tellMessage(news: BoardNews, frames: readonly Hung[], captionOf: (file: string) => string): string {
  const notes = news.notes.map((note) => `- ${noteLine(note, frames, captionOf)}`);
  const picks = news.picks.map(({ file, pick }) => `- ${pickLine(file, pick, captionOf)}`);
  const blocks = [
    ...(notes.length ? [[t("My notes on the Design board:"), ...notes].join("\n")] : []),
    ...(picks.length ? [[t("My picks on the Design board:"), ...picks].join("\n")] : []),
  ];
  return blocks.join("\n\n");
}

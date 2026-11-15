/**
 * The person's new notes and picks on the Design board, in words: what Tell Genex sends as their
 * message, and what goes with their next message in the game's chat without it. Each note names
 * the artboard it is on, by the title the person reads and the file the agent opens, and where on
 * it the note is, so the agent can act on it without the canvas; a note on one of the person's own
 * pictures says what that reference is for. Each pick names the artboard to go with, or the one
 * set aside.
 */
import { DESIGN_NEWS_HEADING, DESIGN_NEWS_RULE, noteOnArtboard } from "./design-tell-prompts.ts";
import { type DesignNote, DesignPick } from "./design-marks.ts";
import { t } from "./i18n.ts";

/** What the person has to tell: their new notes, and their new picks by artboard. */
export interface BoardNews {
  notes: readonly DesignNote[];
  picks: ReadonlyArray<{ file: string; pick: DesignPick }>;
}

/** What the teller knows of the board's artboards. */
export interface BoardNewsNames {
  /** An artboard's title as the person reads it. */
  titleOf: (file: string) => string;
  /** Whether the artboard is on the board: a note on one that is gone reads as on the canvas. */
  onBoard: (file: string) => boolean;
  /** An artboard's size on the canvas, where the teller knows it; else the shares kept with a note say where. */
  sizeOf?: (file: string) => { width: number; height: number } | undefined;
}

/** A share of a length as a whole percentage, 0 to 100. */
const percent = (share: number): number => Math.round(Math.min(1, Math.max(0, share)) * 100);

/** A note's words on one line: its own line breaks would read as further notes of the list. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Where on its artboard a note is, in percent across and down; null when neither its size nor the note says. */
function noteSpot(note: DesignNote, file: string, names: BoardNewsNames): { across: number; down: number } | null {
  const size = names.sizeOf?.(file);
  if (size && size.width > 0 && size.height > 0)
    return { across: percent(note.x / size.width), down: percent(note.y / size.height) };
  if (note.fx === undefined || note.fy === undefined) return null;
  return { across: percent(note.fx), down: percent(note.fy) };
}

/** One note as a line of the message. */
function noteLine(note: DesignNote, names: BoardNewsNames): string {
  const text = oneLine(note.text);
  const file = note.file;
  if (!file || !names.onBoard(file)) return t("On the canvas: {text}", { text });
  const title = names.titleOf(file);
  const spot = noteSpot(note, file, names);
  if (!spot) return noteOnArtboard(title, file, text);
  return t("{title} ({file}), {across}% across and {down}% down: {text}", { title, file, ...spot, text });
}

/** One pick as a line of the message. */
function pickLine(file: string, pick: DesignPick, names: BoardNewsNames): string {
  const named = { title: names.titleOf(file), file };
  return pick === DesignPick.Use ? t("Use this: {title} ({file})", named) : t("Not this: {title} ({file})", named);
}

/** The message for this news, as the person sends it: the notes, then the picks; nothing for none. */
export function boardNewsMessage(news: BoardNews, names: BoardNewsNames): string {
  const notes = news.notes.map((note) => `- ${noteLine(note, names)}`);
  const picks = news.picks.map(({ file, pick }) => `- ${pickLine(file, pick, names)}`);
  const blocks = [
    ...(notes.length ? [[t("My notes on the Design board:"), ...notes].join("\n")] : []),
    ...(picks.length ? [[t("My picks on the Design board:"), ...picks].join("\n")] : []),
  ];
  return blocks.join("\n\n");
}

/** The same news as the lines the agent reads after the person's next message; nothing for none. */
export function boardNewsContext(news: BoardNews, names: BoardNewsNames): string {
  const message = boardNewsMessage(news, names);
  return message ? `${DESIGN_NEWS_HEADING}${message}\n${DESIGN_NEWS_RULE}` : "";
}

/**
 * What the person did on a game's design board, beside the artboards themselves: where they put
 * each artboard, the notes they pinned and the artboards they chose or set aside. Genex keeps it in
 * one file of the board's folder, so it travels with the game. The file is read as untrusted: only
 * the board's own artboards are named in it, every number and text is bounded, and anything else is
 * dropped.
 */
import { CHOICES_MAX, DESIGN_FOLDER, designItemFile, readDesignFiles } from "./design-board.ts";

/** The file, in the game folder: hidden, so the board never lists it and no page can read it. */
export const DESIGN_MARKS_FILE = `${DESIGN_FOLDER}/.genex-board.json`;
/** The file's format; a file of another format is read as nothing done. */
export const MARKS_VERSION = 1;
/** The most notes and placed artboards a board keeps, and a note's longest text. */
export const NOTES_MAX = 200;
export const PLACES_MAX = 200;
export const NOTE_TEXT_MAX_CHARS = 600;
/** How far from the canvas's origin anything may stand, in the canvas's own pixels. */
const COORD_MAX = 1_000_000;
/** A note's longest id. */
const NOTE_ID_MAX_CHARS = 40;

/** What the person said of an artboard: the one to go with, or one set aside. Wire values: never rename one. */
export const DesignPick = { Use: "use", Not: "not" } as const;
export type DesignPick = (typeof DesignPick)[keyof typeof DesignPick];

/** One pick, and whether the person has told the agent about it. */
export interface DesignPickMark {
  pick: DesignPick;
  told: boolean;
}

/** A corner on the canvas, in the canvas's own pixels. */
export interface DesignPlace {
  x: number;
  y: number;
}

/**
 * A note the person pinned. On an artboard (`file`) its place is counted from that artboard's
 * corner, so it stays on it wherever the artboard goes; on the bare canvas, from the canvas's origin.
 */
export interface DesignNote extends DesignPlace {
  id: string;
  text: string;
  file?: string;
  /** The person has told the agent about it. */
  told: boolean;
}

/** Everything the person did on one board. */
export interface DesignMarks {
  /** Where the person put an artboard, by its file; one with no place hangs where the layout puts it. */
  places: Record<string, DesignPlace>;
  notes: DesignNote[];
  picks: Record<string, DesignPickMark>;
  /** The artboards the game's agent offers to pick among: only these wear Use this and Not this. */
  choices: string[];
}

/** A board the person did nothing on. */
export const EMPTY_MARKS: DesignMarks = { places: {}, notes: [], picks: {}, choices: [] };

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** An artboard's file as the marks name it: the board's own spelling of it, or null. */
const artboard = (file: unknown): string | null => (designItemFile(file) === file ? (file as string) : null);

/** A length on the canvas: a finite number, whole, within reach; null for anything else. */
function coordinate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(COORD_MAX, Math.max(-COORD_MAX, value)));
}

function readPlace(value: unknown): DesignPlace | null {
  const place = record(value);
  const x = coordinate(place?.x);
  const y = coordinate(place?.y);
  return x === null || y === null ? null : { x, y };
}

function readPlaces(value: unknown): Record<string, DesignPlace> {
  const places: Record<string, DesignPlace> = {};
  for (const [key, entry] of Object.entries(record(value) ?? {}).slice(0, PLACES_MAX)) {
    const file = artboard(key);
    const place = readPlace(entry);
    if (file && place) places[file] = place;
  }
  return places;
}

function readPicks(value: unknown): Record<string, DesignPickMark> {
  const picks: Record<string, DesignPickMark> = {};
  for (const [key, entry] of Object.entries(record(value) ?? {}).slice(0, PLACES_MAX)) {
    const file = artboard(key);
    const mark = record(entry);
    const pick = mark?.pick;
    if (file && (pick === DesignPick.Use || pick === DesignPick.Not)) picks[file] = { pick, told: mark?.told === true };
  }
  return picks;
}

/** One note, or null for one with no id, no words, no place, or pinned to what is no artboard of the board. */
function readNote(value: unknown): DesignNote | null {
  const note = record(value);
  const place = readPlace(note);
  const id = typeof note?.id === "string" ? note.id.slice(0, NOTE_ID_MAX_CHARS) : "";
  const text = typeof note?.text === "string" ? note.text.trim().slice(0, NOTE_TEXT_MAX_CHARS) : "";
  if (!note || !place || !id || !text) return null;
  if (note.file === undefined) return { id, text, ...place, told: note.told === true };
  const file = artboard(note.file);
  return file ? { id, text, file, ...place, told: note.told === true } : null;
}

function readNotes(value: unknown): DesignNote[] {
  const notes: DesignNote[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(value) ? value : []) {
    const note = readNote(entry);
    if (!note || seen.has(note.id)) continue;
    seen.add(note.id);
    notes.push(note);
    if (notes.length === NOTES_MAX) break;
  }
  return notes;
}

/** The marks a parsed file holds; nothing done for anything that is no such file. */
export function readDesignMarks(value: unknown): DesignMarks {
  const file = record(value);
  if (!file || (file.v !== undefined && file.v !== MARKS_VERSION))
    return { places: {}, notes: [], picks: {}, choices: [] };
  return {
    places: readPlaces(file.places),
    notes: readNotes(file.notes),
    picks: readPicks(file.picks),
    choices: readDesignFiles(file.choices, CHOICES_MAX).filter((one) => artboard(one) !== null),
  };
}

/** The file's text for these marks. */
export const writeDesignMarks = (marks: DesignMarks): string =>
  `${JSON.stringify({ v: MARKS_VERSION, ...readDesignMarks(marks) }, null, 2)}\n`;

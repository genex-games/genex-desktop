/**
 * What the person does on the canvas, as changes to the board's marks (`shared/design-marks.ts`):
 * pure, so each is the same marks with one thing done. `use-board-marks.ts` keeps and saves them.
 */
import type { DesignMarks, DesignNote, DesignPick, DesignPlace } from "../../../shared/design-marks.ts";
import type { CanvasView } from "../../canvas-view.ts";
import { pictureSize } from "./design-model.ts";

/** How far each further picture of one drop hangs from the one before it, down and right. */
const DROP_STEP = 80;

/** A point of the window on the canvas, under a camera at `view` in a viewport whose corner is at `corner`. */
export function canvasPoint(
  view: CanvasView,
  corner: { left: number; top: number },
  client: { x: number; y: number },
): DesignPlace {
  return { x: (client.x - corner.left - view.tx) / view.k, y: (client.y - corner.top - view.ty) / view.k };
}

/**
 * Where a picture dropped at `point` hangs: its middle under the pointer (at the size a picture has
 * before it loads), each further picture of the same drop a step down and right of the one before.
 */
export function dropPlace(point: DesignPlace, index: number): DesignPlace {
  const size = pictureSize(undefined);
  return {
    x: Math.round(point.x - size.width / 2 + index * DROP_STEP),
    y: Math.round(point.y - size.height / 2 + index * DROP_STEP),
  };
}

/** The marks with an artboard put at `place`. */
export const placed = (marks: DesignMarks, file: string, place: DesignPlace): DesignMarks => ({
  ...marks,
  places: { ...marks.places, [file]: { x: Math.round(place.x), y: Math.round(place.y) } },
});

/** The marks with every artboard back where the layout puts it; notes and picks stay. */
export const tidied = (marks: DesignMarks): DesignMarks => ({ ...marks, places: {} });

/** Whether the person moved anything: Tidy up has something to do. */
export const hasPlaces = (marks: DesignMarks): boolean => Object.keys(marks.places).length > 0;

/** An artboard as a note finds it: where it hangs and how large. */
type Hung = { file: string; x: number; y: number; width: number; height: number };

/** Whether an artboard's sheet covers a point of the canvas. */
function covers(frame: Hung, point: DesignPlace): boolean {
  const across = point.x >= frame.x && point.x <= frame.x + frame.width;
  const down = point.y >= frame.y && point.y <= frame.y + frame.height;
  return across && down;
}

/**
 * Where a note put at `point` is pinned: to the artboard under it (the one on top, where several
 * overlap), counted from that artboard's corner, so it stays on it wherever the artboard goes;
 * else to the bare canvas, counted from the canvas's origin.
 */
export function noteAnchor(point: DesignPlace, frames: readonly Hung[]): DesignPlace & { file?: string } {
  const under = frames.findLast((frame) => covers(frame, point));
  if (!under) return { x: Math.round(point.x), y: Math.round(point.y) };
  return { file: under.file, x: Math.round(point.x - under.x), y: Math.round(point.y - under.y) };
}

/** Where a note stands on the canvas now; null for a note whose artboard is no longer on the board. */
export function notePoint(note: DesignNote, frames: readonly Hung[]): DesignPlace | null {
  if (!note.file) return { x: note.x, y: note.y };
  const on = frames.find((frame) => frame.file === note.file);
  return on ? { x: on.x + note.x, y: on.y + note.y } : null;
}

/** The marks with a note added, or the note of the same id replaced where it stood. */
export function withNote(marks: DesignMarks, note: DesignNote): DesignMarks {
  const known = marks.notes.some((one) => one.id === note.id);
  const notes = known ? marks.notes.map((one) => (one.id === note.id ? note : one)) : [...marks.notes, note];
  return { ...marks, notes };
}

/** The marks without one note. */
export const withoutNote = (marks: DesignMarks, id: string): DesignMarks => ({
  ...marks,
  notes: marks.notes.filter((note) => note.id !== id),
});

/**
 * The notes the agent has not been told about that the person can see on the canvas. The marks
 * file is the game's and read as untrusted, so a note pinned to an artboard no longer on the board,
 * which is not drawn, is never sent as the person's words.
 */
export const untoldNotes = (marks: DesignMarks, frames: readonly Hung[]): DesignNote[] =>
  marks.notes.filter((note) => !note.told && notePoint(note, frames) !== null);

/** The marks with these notes told to the agent. */
export const toldNotes = (marks: DesignMarks, ids: readonly string[]): DesignMarks => ({
  ...marks,
  notes: marks.notes.map((note) => (ids.includes(note.id) ? { ...note, told: true } : note)),
});

/** A new note's id: short, and its own among a board's notes. */
export const newNoteId = (): string => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * The marks with an artboard chosen or set aside, and still to be told; pressing the pick it
 * already has takes the pick away.
 */
export function withPick(marks: DesignMarks, file: string, pick: DesignPick): DesignMarks {
  const { [file]: before, ...others } = marks.picks;
  if (before?.pick === pick) return { ...marks, picks: others };
  return { ...marks, picks: { ...others, [file]: { pick, told: false } } };
}

/** The picks the agent has not been told about, each with its artboard's file. */
export const untoldPicks = (marks: DesignMarks): Array<{ file: string; pick: DesignPick }> =>
  Object.entries(marks.picks).flatMap(([file, mark]) => (mark.told ? [] : [{ file, pick: mark.pick }]));

/** The marks with the picks of these artboards told to the agent. */
export const toldPicks = (marks: DesignMarks, files: readonly string[]): DesignMarks => ({
  ...marks,
  picks: Object.fromEntries(
    Object.entries(marks.picks).map(([file, mark]) => [file, files.includes(file) ? { ...mark, told: true } : mark]),
  ),
});

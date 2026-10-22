/**
 * Files dragged over a chat and dropped on its prompt bar. Pictures go on the board as pictures;
 * any other file goes with the message as a link to where it is, for the agent to open. This holds
 * what is held, the one line the prompt bar says about it, the board after a drop, what a drop left
 * out, and the words a message sends for its files. Pure, so each is tested without a drag.
 */
import { MAX_REFERENCE_FRAMES, type PickedFrame } from "../reference-frames.ts";
import { COMPOSER_DROP_WORDS } from "../words.ts";

/** The most files (that are not pictures) one message carries, beside its pictures. */
export const MAX_ATTACHED_FILES = 12;

/** What a drag carries: how many of its files are pictures, and how many are not. */
export interface HeldFiles {
  pictures: number;
  others: number;
}

/** A file that is not a picture, going with the next message: its name and where it is. */
export interface AttachedFile {
  name: string;
  path: string;
}

/** What is on the board now, as the prompt bar counts it against its limits. */
export interface BoardCount {
  pictures: number;
  files: number;
}

/** How the prompt bar takes what is held: blue while it all goes in, orange when some cannot. */
export const DropTone = { Takes: "takes", Refuses: "refuses" } as const;
export type DropTone = (typeof DropTone)[keyof typeof DropTone];

/** What a drop left off the board: pictures and files past the limits, and files with no place on disk. */
export interface LeftOut {
  overPictures: number;
  overFiles: number;
  /** Files the app could not find on this computer (pasted data), so there is nothing to link. */
  unlinked: string[];
}

/** A drag item, as `DataTransferItem` describes it while the drag is still over the page. */
interface DragItem {
  kind: string;
  type: string;
}

/** Whether a file's declared type says it is a picture. */
export const isPictureType = (type: string): boolean => type.startsWith("image/");

/** The files a drag carries, from its items; null when it carries none (text, a link, a tab). */
export function heldFiles(items: ArrayLike<DragItem> | undefined): HeldFiles | null {
  const files = Array.from(items ?? []).filter((item) => item.kind === "file");
  if (!files.length) return null;
  const pictures = files.filter((item) => isPictureType(item.type)).length;
  return { pictures, others: files.length - pictures };
}

/** The prompt bar's one line while files are held over the chat, given what is on its board. */
export function dropLine(held: HeldFiles, board: BoardCount): { tone: DropTone; words: string } {
  const files = held.others > 0;
  const pictureRoom = Math.max(0, MAX_REFERENCE_FRAMES - board.pictures);
  const fileRoom = Math.max(0, MAX_ATTACHED_FILES - board.files);
  const fit = Math.min(held.pictures, pictureRoom) + Math.min(held.others, fileRoom);
  const out = held.pictures + held.others - fit;
  const max = files ? MAX_ATTACHED_FILES : MAX_REFERENCE_FRAMES;
  if (!fit) return { tone: DropTone.Refuses, words: COMPOSER_DROP_WORDS.full(max, files) };
  if (out) return { tone: DropTone.Refuses, words: COMPOSER_DROP_WORDS.someStayOut(fit, out, files) };
  return { tone: DropTone.Takes, words: COMPOSER_DROP_WORDS.dropToAdd(fit, files) };
}

/**
 * The board after adding pictures: new ones join in order up to the limit, a picture already on
 * it is not added twice, and `overLimit` counts the new ones that did not fit.
 */
export function addToBoard(
  current: PickedFrame[],
  picked: PickedFrame[],
): { frames: PickedFrame[]; overLimit: number } {
  const seen = new Set(current.map((frame) => frame.data));
  const fresh = picked.filter((frame) => !seen.has(frame.data));
  const room = Math.max(0, MAX_REFERENCE_FRAMES - current.length);
  return { frames: [...current, ...fresh.slice(0, room)], overLimit: Math.max(0, fresh.length - room) };
}

/** The files after adding some: the same place on disk once, up to the limit, and how many did not fit. */
export function addAttachedFiles(
  current: AttachedFile[],
  added: AttachedFile[],
): { files: AttachedFile[]; overLimit: number } {
  const seen = new Set(current.map((file) => file.path));
  const fresh: AttachedFile[] = [];
  for (const file of added) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    fresh.push(file);
  }
  const room = Math.max(0, MAX_ATTACHED_FILES - current.length);
  return { files: [...current, ...fresh.slice(0, room)], overLimit: Math.max(0, fresh.length - room) };
}

/** The orange line under a drop that left something out, or null when everything went in. */
export function leftOutLine(left: LeftOut): string | null {
  const { overPictures, overFiles, unlinked } = left;
  const over = overPictures + overFiles;
  if (over && unlinked.length) return COMPOSER_DROP_WORDS.filesLeftOut(over + unlinked.length);
  if (unlinked.length === 1) return COMPOSER_DROP_WORDS.couldNotAdd(unlinked[0] ?? "");
  if (unlinked.length) return COMPOSER_DROP_WORDS.couldNotAddMany(unlinked.length);
  if (overFiles) return COMPOSER_DROP_WORDS.overLimit(over, MAX_ATTACHED_FILES, true);
  if (overPictures) return COMPOSER_DROP_WORDS.overLimit(overPictures, MAX_REFERENCE_FRAMES, false);
  return null;
}

/** A path as a `file:` URL, which carries a space or any other character whole. */
function fileUrl(place: string): string {
  const slashed = place.replace(/\\/g, "/");
  return `file://${slashed.startsWith("/") ? "" : "/"}${encodeURI(slashed).replace(/[?#]/g, encodeURIComponent)}`;
}

/**
 * The text a message sends: the person's words, then a line per file with where it is, so the
 * chat shows each as a link and the agent opens it there. A path with a space goes as a `file:`
 * URL, so it is read whole.
 */
export function messageWithFiles(words: string, files: readonly AttachedFile[]): string {
  const links = files.map((file) => (/\s/.test(file.path) ? fileUrl(file.path) : file.path));
  return [words, links.join("\n")].filter(Boolean).join("\n\n");
}

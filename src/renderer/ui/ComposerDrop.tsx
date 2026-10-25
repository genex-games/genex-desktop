/**
 * Files dragged onto a chat: the chat's whole area takes them (the nearest `data-file-drop-zone`
 * around the prompt bar, else the prompt bar itself), the prompt bar shows a dashed veil with one
 * line while they are held, and what a drop left out stays under it in orange with a way on.
 */
import { type JSX, type RefObject, useEffect, useRef, useState } from "react";
import { filesToFramesDetailed, MAX_REFERENCE_FRAMES, type PickedFrame } from "../reference-frames.ts";
import { COMPOSER_DROP_WORDS } from "../words.ts";
import {
  type AttachedFile,
  type BoardCount,
  dropLine,
  type HeldFiles,
  heldFiles,
  isPictureType,
  type LeftOut,
  leftOutLine,
} from "./composer-drop.ts";
import { Icon } from "./icons.tsx";

/** The marker of an area whose drops go to the prompt bar inside it (a chat, home). */
const FILE_DROP_ZONE = "data-file-drop-zone";

/** Where drops onto this prompt bar land: its chat's area, or the prompt bar alone. */
function dropZone(composer: HTMLElement): HTMLElement {
  return composer.closest<HTMLElement>(`[${FILE_DROP_ZONE}]`) ?? composer;
}

/**
 * Files held over the prompt bar's drop zone, or null while none are. A drop hands its files to
 * `onFiles`. A disabled prompt bar takes no drop and shows nothing.
 */
export function useFileDrop(
  composer: RefObject<HTMLElement | null>,
  disabled: boolean,
  onFiles: (files: FileList) => void,
): HeldFiles | null {
  const [held, setHeld] = useState<HeldFiles | null>(null);
  const take = useRef(onFiles);
  take.current = onFiles;
  useEffect(() => {
    const element = composer.current;
    if (!element || disabled) return;
    const zone = dropZone(element);
    // Entering a child fires before leaving its parent: count to know when the drag has really left.
    let depth = 0;
    const reset = (): void => {
      depth = 0;
      setHeld(null);
    };
    const enter = (event: DragEvent): void => {
      const files = heldFiles(event.dataTransfer?.items);
      if (!files) return;
      event.preventDefault();
      depth += 1;
      setHeld(files);
    };
    const over = (event: DragEvent): void => {
      if (!heldFiles(event.dataTransfer?.items)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (): void => {
      depth = Math.max(0, depth - 1);
      if (!depth) setHeld(null);
    };
    const drop = (event: DragEvent): void => {
      const files = event.dataTransfer?.files;
      reset();
      if (!files?.length) return;
      event.preventDefault();
      take.current(files);
    };
    zone.addEventListener("dragenter", enter);
    zone.addEventListener("dragover", over);
    zone.addEventListener("dragleave", leave);
    zone.addEventListener("drop", drop);
    // A drag let go or cancelled anywhere else ends the veil too.
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      zone.removeEventListener("dragenter", enter);
      zone.removeEventListener("dragover", over);
      zone.removeEventListener("dragleave", leave);
      zone.removeEventListener("drop", drop);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
      setHeld(null);
    };
  }, [composer, disabled]);
  return held;
}

/** Where a file is on this computer, "" for one that is only data. */
function placeOf(file: File): string {
  const place: unknown = window.studio.pathOfFile?.(file);
  return typeof place === "string" ? place : "";
}

/** A drop's files, sorted: pictures read as pictures, every other file a link to where it is. */
export interface DroppedFiles {
  frames: PickedFrame[];
  files: AttachedFile[];
  /** Pictures past the limit, never read. */
  unreadPictures: number;
  /** Files with no place on this computer, so there is nothing to link. */
  unlinked: string[];
}

/**
 * Read what a drop or paste carried. A picture the browser cannot decode (a layered PSD, say)
 * goes as a file too, so nothing the person meant to share is turned away.
 */
export async function readDroppedFiles(list: File[]): Promise<DroppedFiles> {
  const pictures = list.filter((file) => isPictureType(file.type));
  const { frames, skipped } = await filesToFramesDetailed(pictures);
  const undecoded = pictures.filter((file) => skipped.includes(file.name));
  const files: AttachedFile[] = [];
  const unlinked: string[] = [];
  for (const file of [...list.filter((each) => !isPictureType(each.type)), ...undecoded]) {
    const path = placeOf(file);
    if (path) files.push({ name: file.name, path });
    else unlinked.push(file.name);
  }
  return { frames, files, unreadPictures: Math.max(0, pictures.length - MAX_REFERENCE_FRAMES), unlinked };
}

/** The dashed veil over the prompt bar while files are held over the chat, with its one line. */
export function DropVeil({ held, board }: { held: HeldFiles | null; board: BoardCount }): JSX.Element | null {
  if (!held) return null;
  const line = dropLine(held, board);
  return (
    <div data-drop-veil data-tone={line.tone} className="composer-drop-veil" role="status">
      {line.words}
    </div>
  );
}

/** What a drop left off the board, in orange, with Choose files and a way to put it away. */
export function LeftOutNote({
  left,
  onChoose,
  onDismiss,
}: {
  left: LeftOut | null;
  onChoose: () => void;
  onDismiss: () => void;
}): JSX.Element | null {
  const words = left ? leftOutLine(left) : null;
  if (!words) return null;
  const title = left?.unlinked.length ? left.unlinked.join(", ") : undefined;
  return (
    <div data-left-out className="composer-left-out" role="alert">
      <span className="min-w-0 flex-1 break-words" title={title}>
        {words}
      </span>
      <button type="button" className="composer-left-out-action" onClick={onChoose}>
        {COMPOSER_DROP_WORDS.chooseFiles}
      </button>
      <button
        type="button"
        className="composer-left-out-dismiss"
        aria-label={COMPOSER_DROP_WORDS.dismiss}
        onClick={onDismiss}
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}

/** A file going with the next message: its name on a chip (its place on hover), and its remove button. */
export function FileChip({ file, onRemove }: { file: AttachedFile; onRemove: () => void }): JSX.Element {
  return (
    <div data-attached-file className="group relative">
      <span className="composer-file-chip" title={file.path}>
        <Icon name="file" size={14} />
        <span className="truncate">{file.name}</span>
      </span>
      <button
        type="button"
        aria-label={COMPOSER_DROP_WORDS.remove(file.name)}
        onClick={onRemove}
        className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full text-micro"
        style={{ background: "var(--ink)", color: "var(--surface)" }}
      >
        ×
      </button>
    </div>
  );
}

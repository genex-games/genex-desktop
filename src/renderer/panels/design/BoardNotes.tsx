/**
 * The person's notes on the canvas: yellow stickies pinned to a spot of an artboard or of the bare
 * canvas. A note is dragged to move (it re-pins to whatever it is let go on), pressed twice to
 * reword, and removed with its ×; a new one opens to type where the Note tool was pressed. Notes
 * keep their size on screen whatever the zoom, as captions do, and say whether the agent was told.
 */
import { type JSX, type PointerEvent as ReactPointerEvent, useState } from "react";
import type { DesignMarks, DesignNote, DesignPlace } from "../../../shared/design-marks.ts";
import { noteAnchor, notePoint, withNote, withoutNote } from "./board-marks.ts";
import { BOARD_WORDS } from "./board-words.ts";
import type { WallFrame } from "./design-model.ts";
import { useArtboardDrag } from "./use-artboard-drag.ts";
import type { MarksChange } from "./use-board-marks.ts";

/** A sticky's paper, ink and quiet ink: the same in a light and a dark app, as paper is. */
const PAPER = "#f3d36b";
const PAPER_INK = "#2a2204";
const PAPER_QUIET = "#6d5a10";
/** A sticky's width on screen. */
const NOTE_WIDTH = 184;

/** A note being written before it is kept: where it is pinned, and its id once it is. */
export type NoteDraft = DesignPlace & { id: string; file?: string };

/** The words of a note being typed: Enter keeps them, Shift+Enter breaks the line, Escape drops them. */
function NoteField({
  text,
  onKeep,
  onDrop,
}: {
  text: string;
  onKeep: (text: string) => void;
  onDrop: () => void;
}): JSX.Element {
  const [value, setValue] = useState(text);
  return (
    <textarea
      // biome-ignore lint/a11y/noAutofocus: the note opens to type the moment it is put on the canvas
      autoFocus
      data-design-note-field=""
      aria-label={BOARD_WORDS.notePlaceholder}
      placeholder={BOARD_WORDS.notePlaceholder}
      value={value}
      rows={2}
      className="block w-full resize-none border-0 bg-transparent p-0 text-[13px] leading-[18px] outline-none [field-sizing:content] placeholder:text-[#6d5a10]"
      style={{ color: PAPER_INK }}
      onChange={(event) => setValue(event.target.value)}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={() => onKeep(value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onDrop();
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          onKeep(value);
        }
      }}
    />
  );
}

/** One sticky at a point of the canvas: its spot at the point, the paper beside it. */
function Sticky({
  point,
  zoom,
  dragged,
  children,
  onPointerDown,
  onDoubleClick,
}: {
  point: DesignPlace;
  zoom: number;
  dragged: boolean;
  children: JSX.Element | JSX.Element[];
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick?: () => void;
}): JSX.Element {
  return (
    <div className={`absolute ${dragged ? "z-30" : "z-20"}`} style={{ left: point.x, top: point.y }}>
      <div style={{ transform: `scale(${1 / zoom})`, transformOrigin: "left top" }}>
        <span
          aria-hidden="true"
          className="absolute top-[-6px] left-[-6px] size-3 rounded-full"
          style={{ background: PAPER, boxShadow: `0 0 0 2px ${PAPER_INK}` }}
        />
        <div
          data-design-note=""
          className={`group relative mt-2 ml-2 flex flex-col gap-2 rounded-[6px] px-3.5 py-3 text-[13px] leading-[18px] shadow-pop ${
            onPointerDown ? "cursor-grab" : ""
          }`}
          style={{ width: NOTE_WIDTH, background: PAPER, color: PAPER_INK }}
          onPointerDown={onPointerDown}
          onDoubleClick={onDoubleClick}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** A note with its place put at `anchor`: on that artboard, or on the bare canvas. */
function movedTo(note: DesignNote, anchor: DesignPlace & { file?: string }): DesignNote {
  const { file: _file, ...bare } = note;
  return { ...bare, x: anchor.x, y: anchor.y, ...(anchor.file ? { file: anchor.file } : {}) };
}

/** Every note of the board on the canvas, and the one being written. */
export function BoardNotes({
  marks,
  frames,
  zoom,
  draft,
  change,
  onDraft,
}: {
  marks: DesignMarks;
  /** Where each artboard hangs now. */
  frames: readonly WallFrame[];
  zoom: number;
  /** A new note, open to type; null when none is being written. */
  draft: NoteDraft | null;
  change: (update: MarksChange) => void;
  onDraft: (draft: NoteDraft | null) => void;
}): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  const dragger = useArtboardDrag({
    zoom,
    onStart: () => {},
    onPlace: (id, place) =>
      change((now) => {
        const note = now.notes.find((one) => one.id === id);
        return note ? withNote(now, movedTo(note, noteAnchor(place, frames))) : now;
      }),
  });
  const keep = (note: DesignNote, text: string): void => {
    setEditing(null);
    const words = text.trim();
    if (!words) change((now) => withoutNote(now, note.id));
    else if (words !== note.text) change((now) => withNote(now, { ...note, text: words, told: false }));
  };
  const keepDraft = (text: string): void => {
    if (!draft) return;
    const words = text.trim();
    if (words) change((now) => withNote(now, { ...draft, text: words, told: false }));
    onDraft(null);
  };
  const draftPoint = draft ? notePoint({ ...draft, text: "", told: false }, frames) : null;
  return (
    <>
      {marks.notes.map((note) => {
        const hung = notePoint(note, frames);
        if (!hung) return null;
        const moving = dragger.drag?.file === note.id ? dragger.drag : null;
        const point = moving ?? hung;
        if (editing === note.id)
          return (
            <Sticky key={note.id} point={point} zoom={zoom} dragged={false}>
              <NoteField text={note.text} onKeep={(text) => keep(note, text)} onDrop={() => setEditing(null)} />
            </Sticky>
          );
        return (
          <Sticky
            key={note.id}
            point={point}
            zoom={zoom}
            dragged={moving !== null}
            onPointerDown={(event) => dragger.begin({ file: note.id, ...hung, width: 0, height: 0 }, event)}
            onDoubleClick={() => setEditing(note.id)}
          >
            <span className="whitespace-pre-wrap break-words">{note.text}</span>
            <span className="font-mono text-[11px] leading-[14px]" style={{ color: PAPER_QUIET }}>
              {note.told ? BOARD_WORDS.noteTold : BOARD_WORDS.noteNew}
            </span>
            <button
              type="button"
              aria-label={BOARD_WORDS.deleteNote}
              title={BOARD_WORDS.deleteNote}
              className="absolute top-1 right-1 grid size-5 cursor-pointer place-items-center rounded-full opacity-0 hover:bg-black/10 focus-visible:opacity-100 group-hover:opacity-100"
              style={{ color: PAPER_INK }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => change((now) => withoutNote(now, note.id))}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </Sticky>
        );
      })}
      {draft && draftPoint ? (
        <Sticky key={draft.id} point={draftPoint} zoom={zoom} dragged={false}>
          <NoteField text="" onKeep={keepDraft} onDrop={() => onDraft(null)} />
        </Sticky>
      ) : null}
    </>
  );
}

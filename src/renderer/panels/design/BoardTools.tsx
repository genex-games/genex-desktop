/**
 * The canvas's tools, bottom centre (Move, Note, Add a picture), and what waits to be told to the
 * agent, bottom right: how many new notes there are and Tell Genex, which sends them as the
 * person's message in the game's chat.
 */
import { type JSX, type PointerEvent as ReactPointerEvent, type ReactNode, useRef } from "react";
import type { DesignMarks, DesignPlace } from "../../../shared/design-marks.ts";
import { composeInChat } from "../../compose-in-chat.ts";
import { Button } from "../../ui/Button.tsx";
import { newNoteId, noteAnchor, toldNotes, toldPicks, untoldNotes, untoldPicks } from "./board-marks.ts";
import type { NoteDraft } from "./BoardNotes.tsx";
import { tellMessage } from "./board-tell.ts";
import { BOARD_WORDS } from "./board-words.ts";
import type { WallFrame } from "./design-model.ts";
import type { MarksChange } from "./use-board-marks.ts";

/** What a press on the canvas does. Move drags artboards and pans; Note pins a note where it is pressed. */
export const BoardTool = { Move: "move", Note: "note" } as const;
export type BoardTool = (typeof BoardTool)[keyof typeof BoardTool];

/** The picture types the canvas keeps. */
const PICTURES = "image/*";

const glyph = (path: ReactNode): JSX.Element => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);
const MOVE = glyph(<path d="M5 4l14 7-6 2-2 6z" />);
const NOTE = glyph(<path d="M5 5h14v9l-5 5H5zM14 19v-5h5" />);
const PICTURE = glyph(
  <>
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <path d="M4 16l5-5 4 4 3-3 4 4" />
  </>,
);

function ToolButton({
  label,
  pressed,
  onPress,
  children,
  hook,
}: {
  label: string;
  pressed?: boolean;
  onPress: () => void;
  children: ReactNode;
  hook: string;
}): JSX.Element {
  return (
    <button
      type="button"
      data-design-tool-button={hook}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={`grid size-8 cursor-pointer place-items-center rounded-[10px] ${
        pressed ? "bg-inset text-ink" : "text-ink-3 hover:bg-control-hover hover:text-ink"
      }`}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

/** The tools: which one a press on the canvas uses, and adding pictures from the computer. */
export function BoardTools({
  tool,
  onTool,
  onPictures,
}: {
  tool: BoardTool;
  onTool: (tool: BoardTool) => void;
  /** Pictures the person chose from their computer. */
  onPictures: (files: readonly File[]) => void;
}): JSX.Element {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <div
      data-design-tools=""
      className="-translate-x-1/2 absolute bottom-2.5 left-1/2 z-40 flex items-center gap-0.5 rounded-[14px] bg-surface p-1 shadow-btn"
    >
      <ToolButton
        hook="move"
        label={BOARD_WORDS.move}
        pressed={tool === BoardTool.Move}
        onPress={() => onTool(BoardTool.Move)}
      >
        {MOVE}
      </ToolButton>
      <ToolButton
        hook="note"
        label={BOARD_WORDS.note}
        pressed={tool === BoardTool.Note}
        onPress={() => onTool(BoardTool.Note)}
      >
        {NOTE}
      </ToolButton>
      <ToolButton hook="picture" label={BOARD_WORDS.addPicture} onPress={() => picker.current?.click()}>
        {PICTURE}
      </ToolButton>
      <input
        ref={picker}
        type="file"
        accept={PICTURES}
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          onPictures([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
    </div>
  );
}

/** What waits to be told to the agent, in the person's words: "2 new notes · 1 new pick". */
function newsWords(notes: number, picks: number): string {
  const parts = [...(notes ? [BOARD_WORDS.newNotes(notes)] : []), ...(picks ? [BOARD_WORDS.newPicks(picks)] : [])];
  return parts.join(" · ");
}

/** What waits to be told to the agent: nothing shows while nothing waits. */
export function TellGenex({
  notes,
  picks,
  onTell,
}: {
  notes: number;
  picks: number;
  onTell: () => void;
}): JSX.Element | null {
  if (notes + picks === 0) return null;
  return (
    <div
      data-design-tell=""
      className="absolute right-2.5 bottom-2.5 z-40 flex h-10 items-center gap-2.5 rounded-[14px] bg-surface pr-1 pl-3 text-[13px] text-ink-2 leading-[18px] shadow-btn"
    >
      <span>{newsWords(notes, picks)}</span>
      <Button variant="default" className="!h-8" onClick={onTell}>
        {BOARD_WORDS.tell}
      </Button>
    </div>
  );
}

/**
 * Everything over the canvas that is the person's: while the Note tool is on, a press anywhere pins
 * a new note there and opens it to type; the tools; and Tell Genex, which sends the new notes and
 * picks as the person's message and marks them told once the chat has really sent them.
 */
export function BoardChrome({
  project,
  marks,
  frames,
  tool,
  captionOf,
  pointOf,
  change,
  onTool,
  onDraft,
  onPictures,
}: {
  project: string;
  marks: DesignMarks;
  frames: readonly WallFrame[];
  tool: BoardTool;
  /** An artboard's caption, as the person reads it. */
  captionOf: (file: string) => string;
  /** A point of the window on the canvas; null while the canvas is not on screen. */
  pointOf: (client: { x: number; y: number }) => DesignPlace | null;
  change: (update: MarksChange) => void;
  onTool: (tool: BoardTool) => void;
  onDraft: (draft: NoteDraft) => void;
  onPictures: (files: readonly File[]) => void;
}): JSX.Element {
  const notes = untoldNotes(marks, frames);
  const picks = untoldPicks(marks);
  const tell = (): void => {
    const ids = notes.map((note) => note.id);
    const files = picks.map((pick) => pick.file);
    composeInChat({
      project,
      text: tellMessage({ notes, picks }, frames, captionOf),
      send: true,
      sent: () => change((now) => toldPicks(toldNotes(now, ids), files)),
    });
  };
  const pin = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const point = pointOf({ x: event.clientX, y: event.clientY });
    if (!point) return;
    event.preventDefault();
    onDraft({ id: newNoteId(), ...noteAnchor(point, frames) });
    onTool(BoardTool.Move);
  };
  return (
    <>
      {tool === BoardTool.Note ? (
        <div data-design-note-placer="" className="absolute inset-0 z-30 cursor-crosshair" onPointerDown={pin} />
      ) : null}
      <BoardTools tool={tool} onTool={onTool} onPictures={onPictures} />
      <TellGenex notes={notes.length} picks={picks.length} onTell={tell} />
    </>
  );
}

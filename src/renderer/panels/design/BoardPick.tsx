/**
 * The person's pick on an artboard: under the pointer, Use this and Not this; once picked, a ring
 * and Chosen on the one to go with, a veil and Not this on one set aside. A press on the pick an
 * artboard already has takes it away. The tag and the buttons keep their size on screen whatever
 * the zoom, as captions do.
 */
import type { JSX } from "react";
import { DesignPick } from "../../../shared/design-marks.ts";
import { BOARD_WORDS } from "./board-words.ts";

/** The ring around a chosen artboard, in screen pixels. */
const RING_PX = 3;

const PICK_BUTTON = "h-8 cursor-pointer rounded-[9px] px-3 font-medium text-[13px] leading-[18px]";

export function BoardPick({
  pick,
  zoom,
  onPick,
}: {
  /** What the person said of this artboard, if anything. */
  pick: DesignPick | null;
  zoom: number;
  onPick: (pick: DesignPick) => void;
}): JSX.Element {
  const screen = (origin: string) => ({ transform: `scale(${1 / zoom})`, transformOrigin: origin });
  return (
    <>
      {pick === DesignPick.Not ? (
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[12px] bg-canvas/70" />
      ) : null}
      {pick === DesignPick.Use ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[12px]"
          style={{ boxShadow: `0 0 0 ${RING_PX / zoom}px var(--accent)` }}
        />
      ) : null}
      {pick ? (
        <div className="pointer-events-none absolute top-0 left-0" style={screen("left top")}>
          <span
            data-design-pick={pick}
            className={`m-2.5 block rounded-[8px] px-2.5 py-0.5 font-mono text-[11px] leading-4 ${
              pick === DesignPick.Use ? "bg-accent-fill text-white" : "bg-inset text-ink-2"
            }`}
          >
            {pick === DesignPick.Use ? BOARD_WORDS.chosen : BOARD_WORDS.notThis}
          </span>
        </div>
      ) : null}
      <div
        data-design-pick-bar=""
        className="absolute bottom-0 left-0 hidden group-hover/sheet:block group-data-[design-dragged]/board:hidden"
        style={screen("left bottom")}
      >
        <div className="flex gap-1.5 p-2.5" onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            aria-pressed={pick === DesignPick.Use}
            className={`${PICK_BUTTON} bg-accent-fill text-white`}
            onClick={() => onPick(DesignPick.Use)}
          >
            {BOARD_WORDS.useThis}
          </button>
          <button
            type="button"
            aria-pressed={pick === DesignPick.Not}
            className={`${PICK_BUTTON} bg-black/60 text-white`}
            onClick={() => onPick(DesignPick.Not)}
          >
            {BOARD_WORDS.notThis}
          </button>
        </div>
      </div>
    </>
  );
}

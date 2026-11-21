/**
 * The agent on the canvas: where it points on an artboard, with its few words said there, and an
 * artboard it said it is making, shown before its file exists (the one being drawn shimmers and
 * carries the agent's cursor; the ones after it wait as empty frames) or, when it is making one
 * again, over the one that is there. The pointer, the cursor and
 * the captions keep their size on screen whatever the zoom, as every caption does.
 */
import { type JSX, useEffect, useMemo, useState } from "react";
import type { DesignItem, DesignSpot } from "../../../shared/design-board.ts";
import { SECOND_MS } from "../../../shared/duration.ts";
import { BOARD_WORDS } from "./board-words.ts";
import { DESIGN_MAKING_EVENT, forgetMaking, makingOn } from "./design-asks.ts";
import { useLibrary, useThreads } from "../../state/hooks.ts";
import { projectWorking } from "../../state/threads.ts";
import {
  CAPTION_HEIGHT,
  MAKING_IDLE_MS,
  makingEnded,
  makingNow,
  UNZOOMED,
  type WallFrame,
  zoomedWidth,
} from "./design-model.ts";

/** The ring the agent draws around a spot, across, in screen pixels. */
const RING_PX = 40;
/** How often a list of artboards being made is looked at again, to drop one that went stale. */
const MAKING_CHECK_MS = 30 * SECOND_MS;

/** The agent's cursor and what it says, as on an artboard it just changed. */
function GenexTag({ words }: { words: string }): JSX.Element {
  return (
    <span className="flex min-w-0 items-start gap-0.5">
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0 text-accent">
        <path d="M4 3l15 8-7 2-3 7z" fill="currentColor" />
      </svg>
      <span className="mt-3 min-w-0 truncate whitespace-nowrap rounded-[9px] bg-accent-fill px-2 py-0.5 text-[12px] text-white leading-4">
        {words}
      </span>
    </span>
  );
}

/** Where the agent points on an artboard: a ring at the spot, and its words beside it. */
export function AgentPointer({ frame, spot, note }: { frame: WallFrame; spot: DesignSpot; note: string }): JSX.Element {
  const left = frame.x + (frame.width * spot.x) / 100;
  const top = frame.y + (frame.height * spot.y) / 100;
  return (
    <div data-design-pointer="" className="pointer-events-none absolute z-30" style={{ left, top }}>
      <div style={{ transform: UNZOOMED, transformOrigin: "left top" }}>
        <span
          aria-hidden="true"
          className="absolute rounded-full"
          style={{
            left: -RING_PX / 2,
            top: -RING_PX / 2,
            width: RING_PX,
            height: RING_PX,
            boxShadow: "inset 0 0 0 2px var(--accent), 0 0 0 6px color-mix(in oklab, var(--accent) 22%, transparent)",
          }}
        />
        {note ? (
          <span className="absolute top-2.5 left-3.5">
            <GenexTag words={note} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** How far the agent's cursor stands in from an artboard's corner, on screen. */
const TAG_INSET_PX = 12;

/**
 * The agent's cursor inside an artboard's lower corner, saying it is drawing it: on one being made,
 * and on one being made again (its caption above names it). It keeps its size on screen and stays
 * within its artboard, its words cut short on a far canvas, so it never lies over another.
 */
export function DrawingTag({ width }: { width: number }): JSX.Element {
  return (
    <span
      data-design-drawing-tag=""
      className="pointer-events-none absolute bottom-0 left-0 z-10 flex"
      style={{
        maxWidth: zoomedWidth(width),
        padding: `0 ${TAG_INSET_PX}px ${TAG_INSET_PX}px`,
        transform: UNZOOMED,
        transformOrigin: "left bottom",
      }}
    >
      <GenexTag words={BOARD_WORDS.drawing} />
    </span>
  );
}

/** An artboard the agent said it is making: being drawn now, or waiting its turn. */
export function MakingSheet({
  frame,
  caption,
  section,
  drawing,
}: {
  frame: WallFrame;
  caption: string;
  /** Its section's name, when it is the first artboard of one. */
  section: string | null;
  /** The one being drawn now; the others wait. */
  drawing: boolean;
}): JSX.Element {
  return (
    <div
      data-design-making={frame.file}
      data-design-drawing={drawing ? "" : undefined}
      className="absolute"
      style={{ left: frame.x, top: frame.y - CAPTION_HEIGHT, width: frame.width }}
    >
      <div className="flex items-end" style={{ height: CAPTION_HEIGHT }}>
        <div
          className="flex flex-col items-start"
          style={{ maxWidth: zoomedWidth(frame.width), transform: UNZOOMED, transformOrigin: "left bottom" }}
        >
          {section ? (
            <span className="whitespace-nowrap pb-1.5 font-medium text-[15px] text-ink leading-[22px]">{section}</span>
          ) : null}
          <span className="block max-w-full truncate pb-1.5 text-ink-3 text-sm">
            {drawing ? caption : BOARD_WORDS.next(caption)}
          </span>
        </div>
      </div>
      <div className="relative" style={{ width: frame.width, height: frame.height }}>
        {drawing ? (
          <div aria-hidden="true" className="asset-skeleton absolute inset-0 !rounded-[12px]" />
        ) : (
          <div
            aria-hidden="true"
            className="absolute inset-0 rounded-[12px] bg-inset/40 shadow-[inset_0_0_0_1px_var(--line)]"
          />
        )}
        {drawing ? <DrawingTag width={frame.width} /> : null}
      </div>
    </div>
  );
}

/**
 * The artboards this game's agent said it is making, in the order it will make them: the ones the
 * board does not hold yet, and the ones it holds that are being made again. Read again when the
 * agent says so, when the board changes, when its game's chats stop working, and now and then, so
 * a list the agent never made good on, or a stopped turn's, goes away.
 */
export function useMaking(project: string, items: readonly DesignItem[]): string[] {
  const [tick, setTick] = useState(0);
  const chatting = useThreads((state) => projectWorking(state, project));
  const building = useLibrary((state) => state.building.has(project));
  const working = chatting || building;
  useEffect(() => {
    const again = (): void => setTick((count) => count + 1);
    window.addEventListener(DESIGN_MAKING_EVENT, again);
    const clock = setInterval(again, MAKING_CHECK_MS);
    return () => {
      window.removeEventListener(DESIGN_MAKING_EVENT, again);
      clearInterval(clock);
    };
  }, []);
  // A turn that ended is looked at again once its grace has passed.
  useEffect(() => {
    if (working) return;
    const later = setTimeout(() => setTick((count) => count + 1), MAKING_IDLE_MS);
    return () => clearTimeout(later);
  }, [working]);
  // A list that ended is forgotten, so the game's next turn does not show it again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` reads the agent's newest list and the clock again
  useEffect(() => {
    const said = makingOn(project);
    if (said && makingEnded(said, Date.now(), working)) forgetMaking(project, said.at);
  }, [project, tick, working]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` reads the agent's newest list and the clock again
  return useMemo(() => makingNow(makingOn(project), items, Date.now(), working), [project, items, tick, working]);
}

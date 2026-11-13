/**
 * Moving an artboard by hand: a press on its caption (or on a picture itself) that travels far
 * enough becomes a drag; the artboard follows the pointer and is put where it is let go. A press
 * that stays put is a press, left to whatever it was on.
 */
import { type PointerEvent as ReactPointerEvent, useCallback, useRef, useState } from "react";
import type { DesignPlace } from "../../../shared/design-marks.ts";
import type { WallFrame } from "./design-model.ts";

/** How far a press travels, in screen pixels, before it is a drag. */
const DRAG_START_PX = 4;

/** The artboard being moved, and where its corner is now on the canvas. */
export interface ArtboardDrag extends DesignPlace {
  file: string;
}

export interface ArtboardDragger {
  drag: ArtboardDrag | null;
  /** Start watching a press on `frame`'s artboard. */
  begin: (frame: WallFrame, event: ReactPointerEvent<HTMLElement>) => void;
  /** Whether the press that just ended moved its artboard: its click is not a press on the caption. */
  takeMoved: () => boolean;
}

export function useArtboardDrag(options: {
  /** The canvas's zoom as a drag begins: screen pixels to canvas pixels. */
  zoom: number;
  /** A drag has begun. */
  onStart: () => void;
  /** The artboard was let go at `place`. */
  onPlace: (file: string, place: DesignPlace) => void;
}): ArtboardDragger {
  const [drag, setDrag] = useState<ArtboardDrag | null>(null);
  const moved = useRef(false);
  const latest = useRef(options);
  latest.current = options;
  const begin = useCallback((frame: WallFrame, event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const handle = event.currentTarget;
    const { pointerId, clientX: fromX, clientY: fromY } = event;
    const zoom = latest.current.zoom || 1;
    let dragging = false;
    moved.current = false;
    const at = (now: PointerEvent): DesignPlace => ({
      x: frame.x + (now.clientX - fromX) / zoom,
      y: frame.y + (now.clientY - fromY) / zoom,
    });
    const move = (now: PointerEvent): void => {
      if (now.pointerId !== pointerId) return;
      if (!dragging && Math.hypot(now.clientX - fromX, now.clientY - fromY) < DRAG_START_PX) return;
      if (!dragging) {
        dragging = true;
        moved.current = true;
        handle.setPointerCapture(pointerId);
        latest.current.onStart();
      }
      setDrag({ file: frame.file, ...at(now) });
    };
    const end = (now: PointerEvent): void => {
      if (now.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (dragging && now.type === "pointerup") latest.current.onPlace(frame.file, at(now));
      setDrag(null);
    };
    // The window hears the whole press: before the drag begins nothing has captured the pointer.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }, []);
  const takeMoved = useCallback((): boolean => {
    const was = moved.current;
    moved.current = false;
    return was;
  }, []);
  return { drag, begin, takeMoved };
}

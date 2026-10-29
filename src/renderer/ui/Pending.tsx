/**
 * The one way a region says its content is still on its way. Nothing shows for the first moments,
 * because most reads here are local and finish unseen (`.pending-late` fades it in after 0.4 s);
 * after that, the region shows the shape of what is coming (`Skeleton`), with no words, and its label
 * comes into the status for assistive technology, which announces it once. Real work being started (checking a program, opening a terminal) is
 * `working`: the chat's orb beside one small shimmering line that says what runs. The window's
 * startup has its own loader (`app-loader.ts`); a running agent's turn has `LoadingState`; media
 * keeps its placeholder tile.
 */
import { type JSX, type ReactNode, useEffect, useState } from "react";
import { SkeletonLines } from "./Skeleton.tsx";
import { StatusOrb } from "./StatusOrb.tsx";

/** A wait shorter than this is never shown, nor announced. */
export const PENDING_DELAY_MS = 400;

/** Whether `ms` has passed since the caller mounted. */
function useShownAfter(ms: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return shown;
}

/** What a region shows when its caller draws no shape of its own: a short paragraph. */
const DEFAULT_SHAPE = <SkeletonLines widths={["100%", "92%", "60%"]} />;

export function Pending({
  label,
  className = "",
  working = false,
  children = DEFAULT_SHAPE,
}: {
  label: string;
  className?: string;
  /** Real work is being started: the orb and the label, instead of a shape. */
  working?: boolean;
  /** The shape of what is coming, drawn from `Skeleton` blocks. */
  children?: ReactNode;
}): JSX.Element {
  // A live region announces what comes into it, not its name: the label arrives with the shape.
  const announced = useShownAfter(PENDING_DELAY_MS);
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-pending={working ? "working" : "shape"}
      className={`pending-late ${className}`}
    >
      {working ? (
        <span className="pending-working">
          <StatusOrb />
          <span aria-hidden data-shimmer className="chat-status-shimmer min-w-0 truncate">
            {label}
          </span>
        </span>
      ) : (
        children
      )}
      {announced && <span className="sr-only">{label}</span>}
    </div>
  );
}

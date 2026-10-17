/**
 * The one way a region says its content is still on its way. Nothing shows for the first moments,
 * because most reads here are local and finish unseen; after that, the region's label shimmers
 * quietly in ink-3, like current work does. It never claims the region is empty, holds still under
 * reduced motion, and is announced once as a status. A whole page still on its way (`spinner`) shows
 * the app's working mark (`LoaderGrid`) centred over its label instead. The window's startup has its own loader
 * (`app-loader.ts`); a running agent's turn has `LoadingState`; media keeps its placeholder tile.
 */
import { type JSX, useEffect, useState } from "react";
import { LoaderGrid } from "./LoadingState.tsx";

/** A wait shorter than this is never shown. */
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

export function Pending({
  label,
  className = "text-sm",
  spinner = false,
}: {
  label: string;
  className?: string;
  /** A page's whole content is on its way: the working mark centred over the label. */
  spinner?: boolean;
}): JSX.Element {
  const shown = useShownAfter(PENDING_DELAY_MS);
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-pending={spinner ? "page" : ""}
      className={spinner ? `pending-page ${className}` : className}
    >
      {shown && spinner && <LoaderGrid />}
      {shown && (
        <span data-shimmer className="chat-status-shimmer">
          {label}
        </span>
      )}
    </div>
  );
}

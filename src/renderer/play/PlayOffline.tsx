/**
 * Play without a network: a signal of four dot-matrix bars that keep looking for a connection, the
 * notice a shelf, a search or the viewer shows in place of what it cannot load (each comes back by
 * itself once the Mac is online), and the small Offline mark on the dashboard's bar.
 */
import type { JSX } from "react";
import { useId } from "react";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { PLAY_WORDS } from "../words.ts";

const WORDS = PLAY_WORDS;
/**
 * The signal's bars on the 3px dot grid: two dots wide with one empty column between, and a whole
 * number of dot rows tall (2, 4, 6, 8) on a 24px-tall mark.
 */
const BARS = [
  { x: 0, height: 5 },
  { x: 9, height: 11 },
  { x: 18, height: 17 },
  { x: 27, height: 23 },
] as const;
const MARK = { width: 32, height: 24 } as const;

/** Four bars of dots, lighting one after another as if looking for a signal. */
export function OfflineMark(): JSX.Element {
  const dots = useId();
  return (
    <svg
      className="play-offline-mark"
      width={MARK.width}
      height={MARK.height}
      viewBox={`0 0 ${MARK.width} ${MARK.height}`}
      aria-hidden="true"
    >
      <defs>
        <pattern id={dots} width="3" height="3" patternUnits="userSpaceOnUse" y="1">
          <rect width="2" height="2" fill="currentColor" />
        </pattern>
      </defs>
      {BARS.map((bar) => (
        <rect key={bar.x} x={bar.x} y={MARK.height - bar.height} width="5" height={bar.height} fill={`url(#${dots})`} />
      ))}
    </svg>
  );
}

/** What a shelf, a search or the viewer says while offline: the signal, a title, one line, and Try again. */
export function OfflineNotice({
  text,
  onRetry,
  className = "",
}: {
  text: string;
  onRetry?: () => void;
  className?: string;
}): JSX.Element {
  return (
    <div className={`play-offline ${className}`} role="status" data-play-offline>
      <OfflineMark />
      <h2 className="play-offline-title">{WORDS.offline.title}</h2>
      <p>{text}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          <Icon name="reload" />
          {WORDS.retry}
        </Button>
      )}
    </div>
  );
}

/** The dashboard bar's mark while offline, beside the search. */
export function OfflineChip(): JSX.Element {
  return (
    <span className="play-offline-chip" role="status">
      <i aria-hidden="true" />
      {WORDS.offline.chip}
    </span>
  );
}

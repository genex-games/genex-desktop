/**
 * The parts every grid on Play's dashboard shares: the one-line notice for a list with nothing to
 * show (Try again after a failure), the line under the cards when their next page could not be read,
 * and the marker that reads the next page before the cards run out.
 */
import type { JSX, RefObject } from "react";
import { useEffect, useRef } from "react";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { type FeedThings, PLAY_WORDS } from "../words.ts";
import { OfflineMark } from "./PlayOffline.tsx";

const WORDS = PLAY_WORDS;
/**
 * How far below the fold the next page starts loading: two of the scroller's own heights, time
 * for the page and its covers to arrive before a quick scroll reaches them.
 */
const LOAD_AHEAD = "200%";

/** A marker under the grid that reads the next page once it comes near the fold. */
export function MoreMarker({
  onNear,
  scroller,
}: {
  onNear: () => void;
  /** The element the grid scrolls in: the look-ahead is measured from its edge. */
  scroller: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  const marker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = marker.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onNear(), {
      root: scroller.current,
      rootMargin: `0px 0px ${LOAD_AHEAD} 0px`,
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onNear, scroller]);
  return <div ref={marker} className="play-more" aria-hidden="true" />;
}

/** A tab, or a search, that has nothing to show: the reason in one line, and Try again after a failure. */
export function Notice({ text, onRetry }: { text: string; onRetry?: () => void }): JSX.Element {
  return (
    <div className="play-notice" role={onRetry ? "alert" : "status"}>
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

/** Under the cards, when their next page could not be read: offline it waits, else Try again. */
export function MoreFailed({
  things,
  online,
  onRetry,
}: {
  things: FeedThings;
  online: boolean;
  onRetry: () => void;
}): JSX.Element {
  if (!online)
    return (
      <div className="play-more-failed" role="status">
        <OfflineMark />
        {WORDS.offline.more(things)}
      </div>
    );
  return (
    <div className="play-more-failed" role="alert">
      {WORDS.moreFailed(things)}
      <Button variant="secondary" onClick={onRetry}>
        <Icon name="reload" />
        {WORDS.retry}
      </Button>
    </div>
  );
}

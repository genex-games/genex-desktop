/**
 * A game's review as the Publish dialog and the chat's review card read it: Genex's word from the
 * Genex plugin (`studio:plugins.genex-review-status`), read again whenever main's review watch says it
 * changed; the dialog also asks main to read Genex again while something is open or a sent app waits
 * for Genex's word, and once a publish of the game's apps ends (main reads at most once a 30 s, and
 * its watch follows a publish it was told of). And the game's newest Fix with agent press, read from
 * its chat's log.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { SECOND_MS } from "../../../../shared/duration.ts";
import { CustomEvent, customPayload } from "../../../../shared/custom-events.ts";
import type { EventEnvelope } from "../../../../shared/event-log.ts";
import type { GenexReviewPayload, GenexReviewStatus } from "../../../../shared/genex-review.ts";
import { type GenexFixState, newestFix } from "../../../../shared/genex-review-log.ts";
import { UiEvent } from "../../../../shared/ui-events.ts";
import { useEventLog } from "../../../state/hooks.ts";

/** How often the open dialog reads the review again while something is open. */
const REVIEW_POLL_MS = 10 * SECOND_MS;

/** How the dialog reads a game's review: on its own cadence, and what makes Genex worth asking again. */
export interface ReviewReading {
  /** Read again every 10 s (the dialog). */
  poll?: boolean;
  /** A publish of the game's apps runs: once it ends, Genex is asked again at once. */
  busy?: boolean;
  /** A sent app waits for Genex's word: each poll asks Genex, not only the kept record. */
  held?: boolean;
}

/** The game's review, or null before it is read (or for a game Genex does not know). */
export function useGenexReview(project: string | null, options: ReviewReading = {}): GenexReviewStatus | null {
  const [status, setStatus] = useState<GenexReviewStatus | null>(null);
  const open = useRef(false);
  const held = useRef(options.held === true);
  held.current = options.held === true;
  const busy = useRef(options.busy === true);
  useEffect(() => {
    const was = busy.current;
    busy.current = options.busy === true;
    if (!project || !was || options.busy === true) return undefined;
    let alive = true;
    // The publish ended: what it sent is with Genex now, so ask Genex rather than the kept record.
    void window.studio
      .genexReviewStatus(project, true)
      .then((next) => {
        if (!alive) return;
        open.current = next.open;
        setStatus(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project, options.busy]);
  useEffect(() => {
    if (!project) return undefined;
    let alive = true;
    const read = (refresh: boolean) =>
      void window.studio
        .genexReviewStatus(project, refresh)
        .then((next) => {
          if (!alive) return;
          open.current = next.open;
          setStatus(next);
        })
        .catch(() => {});
    read(options.poll === true);
    const off = window.studio.onEvent((event) => {
      if (event.type === UiEvent.GenexReviewChanged && event.payload.project === project) read(false);
    });
    const timer = options.poll
      ? window.setInterval(() => read(open.current || held.current), REVIEW_POLL_MS)
      : undefined;
    return () => {
      alive = false;
      off();
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [project, options.poll]);
  return status;
}

/** The game's review records in the order they were written, across its chats. */
function reviewEvents(byThread: Readonly<Record<string, EventEnvelope[]>>, project: string): EventEnvelope[] {
  const about = (event: EventEnvelope) => {
    const payload =
      customPayload(event.data, CustomEvent.GenexReview) ?? customPayload(event.data, CustomEvent.GenexReviewFix);
    return payload !== null && payload.project === project;
  };
  return Object.values(byThread)
    .flatMap((events) => events.filter(about))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** The game's newest fix press and its newest review record, from its chats' logs. */
export function useGenexFix(project: string | null): {
  fix: GenexFixState | null;
  latest: Partial<GenexReviewPayload> | null;
} {
  const byThread = useEventLog((s) => s.byThread);
  return useMemo(() => {
    if (!project) return { fix: null, latest: null };
    const events = reviewEvents(byThread, project);
    const latest = events.map((event) => customPayload(event.data, CustomEvent.GenexReview)).findLast(Boolean) ?? null;
    return { fix: newestFix(events, project), latest };
  }, [byThread, project]);
}

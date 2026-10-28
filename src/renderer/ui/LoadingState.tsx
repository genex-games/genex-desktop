/** Compact current-work indicator: the current phase, and beside it the time the work has taken. */
import type { JSX, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { useClockText } from "../use-polling.ts";
import { clockWords } from "../words.ts";
import { Icon } from "./icons.tsx";
import { prefersReducedMotion } from "./media-queries.ts";
import { CLOSE_MS, OPEN_MS } from "./motion.ts";
import { Presence, useLinger } from "./Presence.tsx";
import { StatusOrb } from "./StatusOrb.tsx";
import { useSteadyStatus, useTextFade, useWidthGlide } from "./label-motion.ts";

/** How a clock's first words come in: unseen while their box opens halfway, then fading in. */
const CLOCK_ARRIVAL: Keyframe[] = [{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }];
/** Pixels along each side of the square loader. */
const LOADER_SIDE = 3;
/** How long after its left-hand neighbour a pixel brightens. */
const LOADER_STEP_MS = 90;

/**
 * When a pixel brightens: column by column, the outer rows a step behind the middle one, so a
 * ">" crosses the grid. The pulse itself is the `.loader-grid` animation in theme.css.
 */
function loaderDelayMs(cell: number): number {
  const row = Math.floor(cell / LOADER_SIDE);
  const column = cell % LOADER_SIDE;
  const middleRow = (LOADER_SIDE - 1) / 2;
  return (column + Math.abs(row - middleRow)) * LOADER_STEP_MS;
}

/** The app's small "working" mark: a square of pixels a chevron sweeps across. */
export function LoaderGrid(): JSX.Element {
  return (
    <span aria-hidden className="loader-grid">
      {Array.from({ length: LOADER_SIDE * LOADER_SIDE }, (_, cell) => (
        <span key={cell} style={{ animationDelay: `${loaderDelayMs(cell)}ms` }} />
      ))}
    </span>
  );
}

/** When the work started: `since` when the caller knows it, else when the caller first showed. */
export function useStartedAt(since?: number): number {
  const [mountedAt] = useState(() => Date.now());
  return since ?? mountedAt;
}

/**
 * The time since `since`, ticking every second: a running clock ("42s", "3m 5s"), or the caller's
 * own `words` for it. A tick rewrites only this text; the tree around it does not re-render.
 */
export function Elapsed({
  since,
  words = clockWords,
}: {
  since: number;
  words?: (elapsedMs: number) => string;
}): JSX.Element {
  // `since` is live: when the work moves to a new phase the caller passes a fresh start, and the
  // clock must follow it — a run that reads "85m" across every phase looks wedged, not busy.
  const text = useClockText<HTMLSpanElement>((now) => words(Math.max(0, now - since)), SECOND_MS);
  return <span ref={text} />;
}

/**
 * The status line's clock, after its words in the same type, from its first whole second. Its width
 * follows the words' width (`--clock-width`) as a transition, so when the clock comes at "1s", its
 * words change width ("9s" → "10s") or it goes while the work waits on the user, the chevron after
 * it slides instead of jumping.
 */
function StatusClock({ since, hidden, shimmer }: { since: number; hidden: boolean; shimmer: boolean }): JSX.Element {
  const box = useRef<HTMLSpanElement>(null);
  const text = useClockText<HTMLSpanElement>((now) => clockWords(Math.max(0, now - since)), SECOND_MS);
  useLayoutEffect(() => {
    const words = text.current;
    if (!words) return;
    const setWidth = (width: number) => box.current?.style.setProperty("--clock-width", `${Math.ceil(width)}px`);
    // Measured once as it mounts, so a clock with nothing to show yet has a width ("0px") to glide from.
    let shown = words.getBoundingClientRect().width;
    setWidth(shown);
    // Reported only when the words' width changes, read from the report: nothing is laid out again.
    const observer = new ResizeObserver((entries) => {
      const width = entries.at(-1)?.borderBoxSize[0]?.inlineSize;
      if (width === undefined) return;
      setWidth(width);
      // Words that come where there were none ("1s") fade in as their box opens, so the opening
      // never shows them cut.
      if (!shown && width && !prefersReducedMotion())
        words.animate(CLOCK_ARRIVAL, { duration: OPEN_MS, easing: "ease-out" });
      shown = width;
    });
    observer.observe(words);
    return () => observer.disconnect();
  }, [text]);
  return (
    <span ref={box} data-chat-elapsed aria-hidden={hidden || undefined} className="chat-clock">
      <span ref={text} className={`inline-block ${shimmer ? "chat-status-shimmer" : ""}`} />
    </span>
  );
}

export function LoadingState({
  label,
  variant = "Drive",
  since,
  details,
  waiting = false,
}: {
  label: string;
  details?: ReactNode;
  waiting?: boolean;
  variant?: string;
  /** epoch ms the work actually started, so the timer survives re-mounts */
  since?: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // Phases come faster than they can be read: each label stays a second, its clock and its waiting
  // with it, then the next fades in while the line's width glides to it, the chevron sliding along.
  const workStarted = useStartedAt(since);
  const held = useSteadyStatus({ label, since: workStarted, waiting });
  const { label: shown, since: startedAt } = held;
  const status = useRef<HTMLSpanElement>(null);
  useTextFade(status, shown);
  useWidthGlide(status, shown);
  // The chevron comes and goes with the work's details: it fades in, and fades out before it goes.
  const disclosure = useLinger(Boolean(details), CLOSE_MS);
  const chevronClass = `chat-chevron ${open ? "rotate-90" : ""} ${disclosure.leaving ? "chat-chevron-leaving" : ""}`;
  // Waiting on the user has no clock and no loader: they close when the wait begins and open again
  // when work resumes, so the words beside them slide. The words and the clock shimmer together.
  const line = (
    <>
      <span aria-hidden className="chat-status-orb-slot" data-gone={held.waiting || undefined}>
        <StatusOrb />
      </span>
      <span className="chat-status-words">
        {/* The label can be the agent's own words about the work. */}
        <span
          ref={status}
          role="status"
          data-analytics-mask
          data-shimmer={!held.waiting || undefined}
          className={`${held.waiting ? "text-ink-2" : "chat-status-shimmer"} min-w-0 truncate`}
        >
          {shown}
        </span>
        <StatusClock since={startedAt} hidden={held.waiting} shimmer={!held.waiting} />
      </span>
    </>
  );
  return (
    <div data-chat-status data-loader-variant={variant} className="min-w-0 text-status">
      <div className="flex min-w-0 items-center">
        {disclosure.on ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="chat-disclosure min-w-0"
          >
            {line}
            <Icon name="chevron-right" size={12} className={chevronClass} />
          </button>
        ) : (
          <div className="chat-status-line">{line}</div>
        )}
      </div>
      <Presence>{open && details ? [{ key: "details", node: details }] : []}</Presence>
    </div>
  );
}

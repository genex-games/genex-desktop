/**
 * The chat's side of Stop: when it says "Stopping", and what its Stop button and Escape do. Both
 * go through the composer's own routes in `composer-stop.ts` (`stopTurn`, `escapeCancels`), so
 * they interrupt this conversation's turn and never a build
 * (tests/conformance/run-controls.test.ts).
 */
import { useCallback, useEffect, useState } from "react";
import { CustomEvent, customEvent } from "../../shared/custom-events.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { EventKind, type EventEnvelope } from "../../shared/event-log.ts";
import { escapeCancels, stopTurn } from "../composer-stop.ts";
import { problemWords } from "../words.ts";
import { ToastTone, type Notify } from "../state/toasts.ts";

/**
 * How long a Stop that is still settling ignores the button: a double press must not cancel the
 * follow-up taking over, but a Stop the work never heard must be possible to ask again.
 */
export const STOP_RETRY_MS = 5 * SECOND_MS;

/** Where a Stop was asked: the chat, the newest event it had seen at that moment, and when. */
export interface StopMark {
  thread: string;
  after: string;
  at: number;
}

/** A record that stopped work ended: a turn ended, or the run closed or paused. */
function endsStoppedWork(event: EventEnvelope): boolean {
  if (event.data.type === EventKind.TurnEnded) return true;
  return customEvent(event, [CustomEvent.RunFinished, CustomEvent.AutopilotPaused]) !== null;
}

/** The stopped work has recorded its end since the mark: a turn ended, or the run closed or paused. */
export function stopSettled(mark: StopMark, events: readonly EventEnvelope[]): boolean {
  return events.some((event) => event.id > mark.after && endsStoppedWork(event));
}

/**
 * The chat says "Stopping" from the press until the stopped work records its end, and while it
 * does, a second Stop cannot cancel the follow-up that is taking over.
 */
export function isStopping(
  mark: StopMark | null,
  state: { threadId: string | null | undefined; running: boolean; events: readonly EventEnvelope[] },
): boolean {
  return Boolean(mark && mark.thread === state.threadId && state.running && !stopSettled(mark, state.events));
}

/** A Stop is settling and was asked too recently to ask again. */
function justAsked(state: { stopping: boolean; mark?: StopMark | null }, now: number): boolean {
  if (!state.stopping) return false;
  return !state.mark || now - state.mark.at < STOP_RETRY_MS;
}

/**
 * The Stop button: mark where it was pressed and cancel this chat's own turn. Returns the mark,
 * or null when there is no chat or a Stop is settling and was asked less than `STOP_RETRY_MS` ago.
 * A refused Stop goes to `onFailed`.
 */
export function requestChatStop(
  api: { cancelTurn(threadId: string): Promise<unknown> },
  state: {
    threadId: string | null | undefined;
    stopping: boolean;
    events: readonly EventEnvelope[];
    mark?: StopMark | null;
    now?: number;
  },
  onFailed: (err: unknown) => void,
): StopMark | null {
  const now = state.now ?? Date.now();
  if (!state.threadId || justAsked(state, now)) return null;
  const mark = { thread: state.threadId, after: state.events.at(-1)?.id ?? "", at: now };
  stopTurn(api, state.threadId, onFailed);
  return mark;
}

/** Escape: cancel the chat turn `escapeCancels` names, and nothing else. */
export function escapeStops(
  api: { cancelTurn(threadId: string): Promise<unknown> },
  event: { key: string; target: unknown },
  state: { threadId: string | null; runId: string | null; turnInFlight: boolean },
): void {
  const cancel = escapeCancels(event, state);
  if (cancel) void api.cancelTurn(cancel);
}

/**
 * The chat's Stop, wired: `requestStop` for the composer's button, `stopping` for the status line,
 * and — while a turn or a plan is in flight — Escape in the composer.
 */
export function useChatStop({
  threadId,
  runId,
  working,
  turnInFlight,
  events,
  onNotice,
}: {
  threadId: string | null;
  runId: string | null;
  /** Anything is running in this chat (a turn, a build). */
  working: boolean;
  /** A chat turn or a plan is in flight: Escape has something it may cancel. */
  turnInFlight: boolean;
  events: EventEnvelope[];
  onNotice: Notify;
}): { stopping: boolean; requestStop: () => void } {
  const [mark, setMark] = useState<StopMark | null>(null);
  const stopping = isStopping(mark, { threadId, running: working, events });
  const requestStop = useCallback((): void => {
    const next = requestChatStop(window.studio, { threadId, stopping, events, mark }, (err) => {
      setMark(null);
      onNotice(problemWords(err), ToastTone.Error);
    });
    if (next) setMark(next);
  }, [threadId, onNotice, stopping, events, mark]);

  // Escape belongs to the composer and to nothing else. It used to be a window listener that
  // stopped the run, so the Escape that closed the model menu at 11 pm ended the run; now it
  // reaches only a chat turn, and while a build runs `escapeCancels` leaves it with nothing to do.
  useEffect(() => {
    if (!turnInFlight) return;
    const onKey = (event: KeyboardEvent): void => escapeStops(window.studio, event, { threadId, runId, turnInFlight });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [turnInFlight, threadId, runId]);

  return { stopping, requestStop };
}

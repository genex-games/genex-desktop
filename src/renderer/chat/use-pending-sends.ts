/**
 * What the composer sent shows at once; each is matched to its durable row in the render that
 * row arrives (`pending-sends.ts`), so it neither doubles nor enters twice.
 *
 * Every send is saved as queued first. One sent to an idle chat keeps its place at the end of
 * the conversation for that moment, instead of dropping below the status and jumping back. Only
 * for a moment: a message that really waits (behind a build the chat has not heard of yet)
 * moves below the work, reading Sending… until that work reads it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { QueueView } from "../../shared/message-queue.ts";
import type { EventEnvelope } from "../types.ts";
import { rememberMessageImages } from "./MessageImages.tsx";
import { PENDING_SEND_GRACE_MS, type PendingSend, reconcilePendingSends, SendPlacement } from "./pending-sends.ts";

/** How long a message sent to an idle chat keeps its place while the queue picks it up. */
const HOLD_IN_PLACE_MS = 1500;
/** A timer that wakes the reconcile a little after the moment it waits for. */
const WAKE_PAD_MS = 50;

/** The bubble a saved row was a moment ago: which send, where it showed and when it began to show. */
export interface Placeholder {
  clientId: string;
  placement: SendPlacement;
  shownAt?: number;
}

/** How many saved rows remember the bubble they were; the oldest is forgotten first. */
const PLACEHOLDERS_CAP = 64;

export interface PendingSends {
  /** Sends still waiting for their rows, where each first shows. */
  shown: PendingSend[];
  /** Transcript entries that were a placeholder a moment ago: they do not enter again. */
  adoptedRows: ReadonlySet<string>;
  /** The bubble each saved row was, by entry id: it keeps that bubble's place and opening. */
  placeholders: ReadonlyMap<string, Placeholder>;
  /** A queued message that keeps its place in the conversation for now. */
  holdsInPlace: (messageId: string) => boolean;
  /** A message on its way shows in the conversation (not below the work). */
  sending: boolean;
  add(send: PendingSend): void;
  /** The send was acknowledged; its row may still be on the way. */
  settle(clientId: string): void;
  /** The send failed: the composer gets the text back, and no bubble stays. */
  drop(clientId: string): void;
}

/** Remember the bubble each newly saved row was, forgetting the oldest past the cap. */
function rememberPlaceholders(
  placeholders: Map<string, Placeholder>,
  adopted: ReadonlyMap<string, string>,
  pending: readonly PendingSend[],
): void {
  for (const [clientId, entryId] of adopted) {
    const send = pending.find((item) => item.clientId === clientId);
    if (!send || placeholders.has(entryId)) continue;
    placeholders.set(entryId, {
      clientId,
      placement: send.placement,
      ...(send.shownAt === undefined ? {} : { shownAt: send.shownAt }),
    });
  }
  for (const entryId of placeholders.keys()) {
    if (placeholders.size <= PLACEHOLDERS_CAP) break;
    placeholders.delete(entryId);
  }
}

/** The saved row shows the pictures its placeholder had from its first paint, when those are all of them. */
function rememberPictures(
  threadId: string | undefined,
  adopted: ReadonlyMap<string, string>,
  pending: readonly PendingSend[],
  queue: QueueView,
): void {
  if (!threadId) return;
  for (const [clientId] of adopted) {
    const send = pending.find((item) => item.clientId === clientId);
    const recorded = queue.messages.get(clientId)?.action?.imageCount;
    if (send?.frames?.length && recorded === send.frames.length) rememberMessageImages(threadId, clientId, send.frames);
  }
}

/** Re-render once the soonest acknowledged send's grace runs out. */
function useGraceWake(shown: readonly PendingSend[], wake: () => void): void {
  useEffect(() => {
    const due = shown.flatMap((send) =>
      send.settledAt === undefined ? [] : [send.settledAt + PENDING_SEND_GRACE_MS - Date.now()],
    );
    if (!due.length) return;
    const timer = setTimeout(wake, Math.max(0, Math.min(...due)) + WAKE_PAD_MS);
    return () => clearTimeout(timer);
  }, [shown, wake]);
}

export function usePendingSends(input: {
  threadId: string | undefined;
  threadEvents: EventEnvelope[];
  queue: QueueView;
}): PendingSends {
  const { threadId, threadEvents, queue } = input;
  const [pending, setPending] = useState<PendingSend[]>([]);
  const [clock, setClock] = useState(0);
  const wake = useCallback(() => setClock((n) => n + 1), []);
  const adoptedEntries = useRef(new Set<string>());
  const placeholders = useRef(new Map<string, Placeholder>());
  const heldInPlace = useRef(new Map<string, number>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `clock` re-reads the time-dependent grace.
  const sends = useMemo(
    () =>
      reconcilePendingSends(
        pending.filter((send) => send.threadId === threadId),
        threadEvents,
        queue,
        Date.now(),
        adoptedEntries.current,
      ),
    [pending, threadId, threadEvents, queue, clock],
  );
  const adoptedInPlace = useMemo(
    () =>
      new Set(
        [...sends.adopted.keys()].filter(
          (clientId) => pending.find((send) => send.clientId === clientId)?.placement === SendPlacement.Transcript,
        ),
      ),
    [sends, pending],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per reconcile, as the rows arrive.
  const adoptedRows = useMemo(() => {
    rememberPictures(threadId, sends.adopted, pending, queue);
    rememberPlaceholders(placeholders.current, sends.adopted, pending);
    return new Set([...adoptedEntries.current, ...sends.adopted.values()]);
  }, [sends]);
  useLayoutEffect(() => {
    for (const id of adoptedInPlace) if (!heldInPlace.current.has(id)) heldInPlace.current.set(id, Date.now());
    for (const id of sends.adopted.values()) adoptedEntries.current.add(id);
    const settled = new Set([...sends.adopted.keys(), ...sends.expired]);
    if (settled.size) setPending((list) => list.filter((send) => !settled.has(send.clientId)));
  }, [sends, adoptedInPlace]);
  useGraceWake(sends.shown, wake);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `clock` ends a hold that has run out.
  const holdsInPlace = useCallback(
    (messageId: string): boolean =>
      adoptedInPlace.has(messageId) ||
      Date.now() - (heldInPlace.current.get(messageId) ?? Number.NEGATIVE_INFINITY) < HOLD_IN_PLACE_MS,
    [adoptedInPlace, clock],
  );
  const heldQueued = [...queue.messages.values()].some(
    (m) => m.state === "queued" && !queue.paused && holdsInPlace(m.messageId),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new queue restarts the hold's timer.
  useEffect(() => {
    if (!heldQueued) return;
    const timer = setTimeout(wake, HOLD_IN_PLACE_MS);
    return () => clearTimeout(timer);
  }, [heldQueued, queue, wake]);
  return {
    shown: sends.shown,
    adoptedRows,
    placeholders: placeholders.current,
    holdsInPlace,
    sending: sends.shown.some((send) => send.placement === SendPlacement.Transcript),
    add: (send) => setPending((list) => [...list, { ...send, shownAt: performance.now() }]),
    settle: (clientId) =>
      setPending((list) =>
        list.map((send) => (send.clientId === clientId ? { ...send, settledAt: Date.now() } : send)),
      ),
    drop: (clientId) => setPending((list) => list.filter((send) => send.clientId !== clientId)),
  };
}

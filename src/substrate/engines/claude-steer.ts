/**
 * Steer on Claude Code (`DelegateRequest.steer`): the person's messages, pushed into the running
 * session through the SDK's streaming input. The CLI folds a message pushed with priority `next`
 * in at its next tool result, or runs it as a follow-up turn of the same session when it arrives
 * during the final answer. Its `command_lifecycle` `started` frame is the moment the session read
 * it: reported at once (`steer_delivered`), so the host records it in stream order.
 *
 * Only a CLI that advertises message lifecycles says whether it read a message; an older one, and
 * an interview (a message folded in at its question's or launch's tool result would be answered
 * by a turn that had already decided), take nothing mid-turn and are interrupted instead.
 */
import { randomUUID } from "node:crypto";
import { SECOND_MS } from "../../shared/duration.ts";
import { DelegateEventType, type DelegateImage, type DelegateRequest, type SteerSend } from "./types.ts";

/**
 * How long a steered message the CLI took may sit unread after a result before the input is
 * closed anyway. A late message normally starts its own turn within a second of the result;
 * one that never does must not hold a finished session open (it reports as not delivered).
 * Exported for the test that runs the stall on its own clock.
 */
export const STEER_STALL_MS = 30 * SECOND_MS;

/** The init capability of a CLI that reports each pushed message's lifecycle (2.1.281 does). */
const MESSAGE_LIFECYCLES = "msg_lifecycle_v1";

/** Where a pushed message stands, as its `command_lifecycle` frame says. Wire values: never rename one. */
const LifecycleState = {
  Queued: "queued",
  /** The session read it: in stream order, after the tool result it was folded into. */
  Started: "started",
  Completed: "completed",
  Discarded: "discarded",
  Refused: "refused",
  Cancelled: "cancelled",
} as const;
type LifecycleState = (typeof LifecycleState)[keyof typeof LifecycleState];
/** The session will never read it: it reports as not delivered. */
const DROPPED: ReadonlySet<string> = new Set<LifecycleState>([
  LifecycleState.Discarded,
  LifecycleState.Refused,
  LifecycleState.Cancelled,
]);

/** A pushed message folds in at the next tool-result boundary instead of waiting for the turn. */
const NEXT_PRIORITY = "next";
/** Who sent a pushed message. */
const HUMAN_ORIGIN = { kind: "human" } as const;

/**
 * A user message's content: the text, and any stills as image blocks the text names (WP3d) — the
 * same shape for the brief and for a message steered into the turn.
 */
export function userContent(text: string, images: readonly DelegateImage[]) {
  if (!images.length) return [{ type: "text" as const, text }];
  const labels = images.map((image) => image.label).join("; ");
  return [
    { type: "text" as const, text: `${text}\n\nIMAGES ATTACHED (${images.length}): ${labels}.` },
    ...images.map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mimeType || "image/jpeg", data: image.data },
    })),
  ];
}

/** A user message frame of the SDK's streaming input. */
export function userFrame(text: string, images: readonly DelegateImage[]) {
  return {
    type: "user" as const,
    message: { role: "user" as const, content: userContent(text, images) },
    parent_tool_use_id: null,
  };
}

/** What a steerable delegation reports back through `delegate`: the host's `ready`, and what was read. */
export interface SteerSession {
  /** Says once whether this session takes messages mid-turn; later calls are ignored. */
  tell(send: SteerSend | null): void;
  /** Ids of the steered messages the session read, in the order it read them. */
  steered: string[];
}

/** The steer half of a delegation: `ready` said exactly once, whatever ends it. */
export function steerSession(ready: (send: SteerSend | null) => void): SteerSession {
  let told = false;
  return {
    tell: (send) => {
      if (told) return;
      told = true;
      ready(send);
    },
    steered: [],
  };
}

/**
 * A steerable session's input: the brief, then each message pushed, until it is ended. The SDK
 * keeps the CLI's stdin open for exactly as long as this iterable runs, so it must end on every
 * path — an abort included, or a stopped session's `for await` would wait on it forever. What an
 * abort leaves unwritten is dropped: it was never read, so it reports as not delivered.
 */
function steerInput(first: object, signal: AbortSignal) {
  const queue: object[] = [first];
  let ended = false;
  let wake: (() => void) | null = null;
  const end = (): void => {
    ended = true;
    wake?.();
  };
  const abort = (): void => {
    queue.length = 0;
    end();
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return {
    get ended(): boolean {
      return ended;
    },
    end,
    push(message: object): void {
      queue.push(message);
      wake?.();
    },
    messages: (async function* () {
      for (;;) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    })(),
  };
}

/** Runs `fire` after `ms` and returns what calls it off: real timers, or a test's own clock. */
export type StallSchedule = (fire: () => void, ms: number) => () => void;

/** The real clock's schedule. */
const realSchedule: StallSchedule = (fire, ms) => {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
};

/** A steerable session's input and the messages it took, as the delegation's stream reads them. */
export interface SteerFeed {
  /** The session's input, for the SDK's `prompt`. */
  prompt: AsyncIterable<object>;
  /** The session's init: tells the host once whether it takes messages mid-turn. */
  initialized(message: Record<string, unknown>, interview: boolean): void;
  /** A `command_lifecycle` frame: a pushed message read, or dropped. */
  lifecycle(message: Record<string, unknown>, onEvent: DelegateRequest["onEvent"]): void;
  /** A result: the input ends once the session has answered everything it read. */
  answered(): void;
  /** The delegation ended: the input ends with it. */
  dispose(): void;
  /** The input has ended: the session takes nothing more over stdin, a control request included. */
  readonly ended: boolean;
}

/**
 * The input a steerable session is fed through, held open by the delegation: a string prompt
 * has the SDK close stdin at the first result, which would cut off a message taken during the
 * final answer before the CLI started it, and a resumed session's brief behind a queued notice.
 * `sessionId` names the session each message goes to;
 * `schedule` is the clock the stall runs on.
 */
export function steerFeed(
  steer: SteerSession,
  brief: object,
  signal: AbortSignal,
  sessionId: () => string | undefined,
  schedule: StallSchedule = realSchedule,
): SteerFeed {
  // The brief carries a uuid so the session says when it reads it: a resumed session first
  // answers what it had queued (a background task's notice), and that result is not the brief's.
  const briefUuid = randomUUID();
  const input = steerInput({ ...brief, uuid: briefUuid }, signal);
  let briefUnread = false;
  let briefTaken = false;
  // Steers the CLI took and has not yet read, by frame uuid → the queue's message id. Read is
  // `started`, never `completed`: an abort after `queued` means the session never saw it.
  const pending = new Map<string, string>();
  let resultSinceSteer = false;
  let cancelStall: (() => void) | null = null;
  // The input ends once the session has answered everything it read (a result since the last
  // steer started) and holds nothing unread — or, with something unread and no progress, after
  // STEER_STALL_MS. Whatever never started by then is reported as not delivered.
  const settleInput = (): void => {
    if (input.ended) return;
    cancelStall?.();
    cancelStall = null;
    if (!resultSinceSteer) return;
    if (!pending.size) input.end();
    else cancelStall = schedule(() => input.end(), STEER_STALL_MS);
  };
  // The brief read (or dropped): only a result after it answers it.
  const briefTook = (state: string): void => {
    if (state !== LifecycleState.Started && !DROPPED.has(state)) return;
    briefTaken = true;
    briefUnread = false;
    resultSinceSteer = false;
    cancelStall?.();
    cancelStall = null;
    if (DROPPED.has(state)) input.end();
  };
  const send: SteerSend = (message) => {
    if (input.ended || signal.aborted) return false;
    const uuid = randomUUID();
    input.push({
      ...userFrame(
        message.text,
        (message.images ?? []).filter((image) => image?.data),
      ),
      priority: NEXT_PRIORITY,
      uuid,
      origin: HUMAN_ORIGIN,
      session_id: sessionId() ?? "",
    });
    pending.set(uuid, message.id);
    return true;
  };
  return {
    prompt: input.messages,
    initialized(message, interview) {
      const capabilities = Array.isArray(message.capabilities) ? message.capabilities : [];
      const lifecycles = capabilities.includes(MESSAGE_LIFECYCLES);
      // Only a CLI that reports lifecycles says when it read the brief; an older one answers it first.
      briefUnread = lifecycles && !briefTaken;
      steer.tell(lifecycles && !interview ? send : null);
    },
    lifecycle(message, onEvent) {
      const uuid = String(message.command_uuid ?? "");
      if (uuid === briefUuid) {
        briefTook(String(message.state ?? ""));
        return;
      }
      const id = pending.get(uuid);
      if (id === undefined) return;
      const state = String(message.state ?? "");
      if (state === LifecycleState.Started) {
        pending.delete(uuid);
        resultSinceSteer = false;
        steer.steered.push(id);
        onEvent?.({ type: DelegateEventType.SteerDelivered, payload: { id } });
      } else if (DROPPED.has(state)) pending.delete(uuid);
      settleInput();
    },
    answered() {
      if (briefUnread) {
        // What it answered was queued before the brief; one that never starts must not hold it open.
        cancelStall?.();
        cancelStall = schedule(() => input.end(), STEER_STALL_MS);
        return;
      }
      resultSinceSteer = true;
      settleInput();
    },
    dispose() {
      cancelStall?.();
      input.end();
    },
    get ended() {
      return input.ended;
    },
  };
}

/**
 * Steer on a local session (`DelegateRequest.steer`): Genex runs the session's loop itself
 * (`local-session.ts`), so a message the person sends while it works waits in the run's inbox and
 * is read at the top of the next round, before the model's next call — nothing is cut. A message
 * the run can no longer read is refused (`send` says false), and one it took but never read when
 * it ends is never reported read: the host queues it again.
 */
import type { Message } from "../types.ts";
import type { DelegateRequest, SteerMessage, SteerSend } from "./types.ts";
import { isInterview } from "../../shared/engine-requests.ts";

/** A running local session's inbox: what the person sent since its last round, in order. */
export interface LocalInbox {
  /** The host's door: takes one message while the run still reads input. */
  readonly send: SteerSend;
  /** Something waits to be read. */
  readonly waiting: boolean;
  /** Every waiting message, in the order sent; the inbox is empty after. */
  take(): SteerMessage[];
  /** The run takes nothing more: what still waits is never read. */
  close(): void;
}

/** An inbox that takes messages until the run stops (`signal`) or is closed. */
export function localInbox(signal: AbortSignal): LocalInbox {
  const waiting: SteerMessage[] = [];
  let closed = false;
  const close = (): void => {
    closed = true;
    waiting.length = 0;
    signal.removeEventListener("abort", close);
  };
  if (signal.aborted) close();
  else signal.addEventListener("abort", close, { once: true });
  return {
    send: (message) => {
      if (closed || signal.aborted) return false;
      waiting.push(message);
      return true;
    },
    get waiting() {
      return waiting.length > 0;
    },
    take: () => waiting.splice(0),
    close,
  };
}

/**
 * Whether this session reads messages mid-turn. An interview does not: a message read after its
 * question's or launch's tool result would be answered by a turn that had already decided.
 */
export function takesSteer(request: DelegateRequest): boolean {
  return !isInterview(request.interviewTools);
}

/** A steered message as the session's history carries it: the words, and the pictures that have pixels. */
export function steerUserMessage(message: SteerMessage): Message {
  const images = (message.images ?? []).filter((image) => image?.data);
  return { role: "user", content: message.text, ...(images.length ? { images } : {}) };
}

/**
 * The line a run's lead takes the chat on while its build runs (live chat). The chat's queue
 * hands the lead a message the person sends (loop/live-chat.ts) instead of holding it until the
 * run is over, and the lead's own loop hears it (wake.ts): at once in a turn under way, or as the
 * reason for its next wake. What the lead heard is recorded on the run's log, so a later run of
 * the run never tells it again (run-inbox.ts). What it never heard when its run ends goes back to
 * the chat, where it waits for a turn of its own — so Stop still hands over to it.
 *
 * A module of its own, importing only leaves: the director (director.ts), the wake loop and the
 * chat's queue all read it, and a seed upgrade keeps an older copy of any of them the agent edited,
 * which never exported it. A run whose director.ts predates live chat opens no line, and the
 * chat's messages wait for it as they always did.
 */
import { HostMethod } from "../host-methods.ts";
import { EventKind, RunEvent } from "../run-events.ts";
import { SteerDelivery } from "../steer-delivery.ts";
import type { QueueAction } from "../message-queue.ts";
import type { HarnessCtx } from "../../types/harness.d.ts";

/** Puts messages back in the chat's queue, in the order they were sent. */
export type GiveBack = (items: QueueAction[]) => Promise<void>;

/** A settled-from-outside promise: the next word on the line. */
interface Signal {
  promise: Promise<void>;
  resolve(): void;
}

function signal(): Signal {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A run's lead, as the chat reaches it. */
export interface LeadLine {
  readonly runId: string;
  /** The chat the run tells its story in: only its messages reach the lead. */
  readonly threadId: string;
  /** It takes the chat's messages now: its run goes on, and its wrap-up has not begun. */
  open(): boolean;
  /** No more messages: the run is over for its lead (an older wake loop shuts it as the wrap-up begins). */
  shut(): void;
  /**
   * The wrap-up began: the lead still hears what the person sends, but every message from now on
   * stays the chat's to answer once the run has closed (live-chat.ts: its door `keeps` it).
   */
  wrapUp(): void;
  /** The wrap-up began (`wrapUp`). */
  wrapping(): boolean;
  /** A message was handed to it (`giveBack` returns it to the chat): a turn under way hears it at once. */
  hear(item: QueueAction, giveBack: GiveBack): void;
  /** Settles when the next message is handed to it. */
  heard(): Promise<void>;
  /** How many messages it has been handed so far. */
  count(): number;
  /**
   * The lead heard every message handed before the `count` given (in a message it took, or read
   * mid-turn): recorded on the run's log, when the line was opened with the run's ctx.
   */
  heardThrough(count: number): Promise<void>;
  /** The lead's loop answers for what it hears: a loop that never says so hears it all from the inbox. */
  attend(): void;
  /**
   * The run is over: no more messages, and those its lead never heard go back to the chat — every
   * one when `heardNone` (no loop of the lead's ever took the line). One handed after this goes back
   * at once.
   */
  release(options?: { heardNone?: boolean }): Promise<void>;
}

/** The lines open now, by run. */
const lines = new Map<string, LeadLine>();
/** The runs whose lead will take the chat once their start is ready (`expectLeadLine`), by run. */
const preparing = new Set<string>();
/** Settles when a line opens or shuts: what waits for a lead looks again. */
let changed = signal();

/** Tell whatever waits for a lead that the lines changed. */
function announce(): void {
  const was = changed;
  changed = signal();
  was.resolve();
}

/**
 * The record that the run's lead heard these chat messages (`run_steering_delivered`, how `lead`,
 * by the message each came from): run-inbox.ts never tells them to a later run of the run.
 */
function heardRecords(runId: string, items: readonly QueueAction[]) {
  return items.map((item) => ({
    type: EventKind.Custom,
    event_type: RunEvent.RunSteeringDelivered,
    payload: { runId, sourceMessageId: item.messageId, how: SteerDelivery.Lead },
  }));
}

/**
 * Open the line to a run's lead: it takes the chat's messages while `live` holds (its run is
 * not over) and until it is shut. What the lead hears is recorded through `ctx`, the run's own.
 */
export function openLeadLine(
  runId: string,
  threadId: string,
  live: () => boolean,
  ctx?: Pick<HarnessCtx, "call">,
): LeadLine {
  let isShut = false;
  let wrappingUp = false;
  let released = false;
  let attended = false;
  let heardCount = 0;
  let next = signal();
  const handed: Array<{ item: QueueAction; giveBack: GiveBack }> = [];
  const line: LeadLine = {
    runId,
    threadId,
    open: () => !isShut && live(),
    shut: () => {
      if (isShut) return;
      isShut = true;
      if (lines.get(runId) === line) lines.delete(runId);
      announce();
    },
    wrapUp: () => {
      if (isShut || wrappingUp) return;
      wrappingUp = true;
      announce();
    },
    wrapping: () => wrappingUp,
    hear: (item, giveBack) => {
      // Handed as the run ended (its line was released while the receipt was written): nobody
      // is left to hear it, so it goes back to the chat at once.
      if (released) {
        void giveBack([item]).catch(() => {});
        return;
      }
      handed.push({ item, giveBack });
      const was = next;
      next = signal();
      was.resolve();
    },
    heard: () => next.promise,
    count: () => handed.length,
    heardThrough: async (count) => {
      const through = Math.max(heardCount, Math.min(count, handed.length));
      const now = handed.slice(heardCount, through).map(({ item }) => item);
      heardCount = through;
      if (!now.length || !ctx) return;
      await ctx.call(HostMethod.EventsAppend, { threadId, batch: heardRecords(runId, now) }).catch(() => {});
    },
    attend: () => {
      attended = true;
    },
    release: async ({ heardNone = false } = {}) => {
      line.shut();
      released = true;
      const unheard = attended || heardNone ? handed.splice(heardCount) : [];
      heardCount = handed.length;
      const first = unheard[0];
      if (first) await first.giveBack(unheard.map(({ item }) => item)).catch(() => {});
    },
  };
  preparing.delete(runId);
  lines.set(runId, line);
  announce();
  return line;
}

/**
 * A run whose lead will take the chat once its start is ready (a waking director preparing it):
 * until its line opens, the chat answers what is sent (live-chat.ts `chatWaitsFor`). Answers the
 * call that ends the wait without a line (the start failed, was stopped or refused).
 */
export function expectLeadLine(runId: string): () => void {
  preparing.add(runId);
  announce();
  return () => {
    if (preparing.delete(runId)) announce();
  };
}

/** Is this run's lead still preparing its start, its line not open yet (`expectLeadLine`)? */
export function leadPreparing(runId: string): boolean {
  return preparing.has(runId) && !lines.has(runId);
}

/** The line to the lead of this run, while it is open. */
export function leadLineOf(runId: string): LeadLine | undefined {
  return lines.get(runId);
}

/** Settles the next time a line opens or shuts. */
export function leadLinesChanged(): Promise<void> {
  return changed.promise;
}

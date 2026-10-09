import type { AnyRecord, HarnessEvent, Host } from "../types/harness.d.ts";
import type { DelegateImage } from "../types/host-api.d.ts";
import { HostMethod } from "./host-methods.ts";
import { EventKind, RunEvent } from "./run-events.ts";
import { SteerDelivery } from "./steer-delivery.ts";

/**
 * This queue hands a message to a run's lead while its build runs (live chat, `beforeProcess`
 * answering with a `LeadDoor`); an older copy keeps every message behind the build. Read by
 * main.ts through live-chat-served.ts `serveLiveChat`, never imported by name.
 */
export const SERVES_LIVE_CHAT = true;

/** A user message as the queue holds it: the dispatch action, plus its id once queued. */
export type QueueAction = AnyRecord & { threadId: string; messageId?: string; text?: string };

/**
 * Where a queued message stands. Written to the transcript's view of the log: never rename a value.
 * `steering`: handed to the chat's running turn and not read yet; `delivered`: read by that turn,
 * which answers it (it never gets a turn of its own).
 */
const MessageState = {
  Queued: "queued",
  Processing: "processing",
  Handled: "handled",
  Removed: "removed",
  Steering: "steering",
  Delivered: "delivered",
} as const;
type MessageState = (typeof MessageState)[keyof typeof MessageState];

/** The events that settle where a message stands, and the state each one leaves it in. */
const STATE_AFTER: Partial<Record<string, MessageState>> = {
  [RunEvent.CoordinatorMessageRequeued]: MessageState.Queued,
  [RunEvent.CoordinatorMessageHandled]: MessageState.Handled,
  [RunEvent.CoordinatorMessageRemoved]: MessageState.Removed,
};

/** One message the log says was queued, and where it stands. */
export interface QueuedMessage {
  messageId: string;
  eventId: string | null;
  action: AnyRecord | undefined;
  state: string;
  attempts?: number;
  /** Steered or delivered: the message whose turn it joined. */
  into?: string;
}

/**
 * The turn answering one message, as the queue keeps it while it runs (steer): what may join it,
 * whether its session takes messages now, and what it took, read and was carried in with.
 */
interface Turn {
  messageId: string;
  action: QueueAction;
  /** Only what is sent from here on (by send order) may join this turn; older messages keep theirs. */
  after: number;
  /** Its runner will answer with a session: what is sent joins it (Sending…), not the queue. */
  expecting: boolean;
  /** Its session runs: what is sent is handed to it (`engine.steer`). */
  open: boolean;
  closed: boolean;
  /** The hand-overs to its session, in order; closing the turn waits for them. */
  handing: Promise<unknown>;
  /** Handed over and not settled yet, by message id, with how the session took it. */
  taken: Map<string, { item: QueueAction; how: SteerDelivery | null }>;
  /** Joined while its session was being set up: they go into its next prompt. */
  pending: QueueAction[];
  /** Read by this turn, in the order read. */
  delivered: QueueAction[];
  /** Delivered into this turn before a restart cut it short: its answer starts with them. */
  carried: QueueAction[];
}

/**
 * What the runner of a turn sees (chat-steer.ts): its session's door to what the person sends
 * while it works. `expect` when the turn will be answered by a session; `open` as each session
 * starts (what joined meanwhile comes back, for its prompt); `close` as each ends (what it took by
 * being interrupted comes back, for the runner to settle); `done` when no more sessions follow.
 */
export interface SteerHandle {
  /** The message this turn answers. */
  readonly messageId: string;
  /** Delivered into this turn before a restart cut it short: its answer starts with them. */
  readonly carried: QueueAction[];
  /** Everything this turn has read so far, in the order it read it. */
  readonly delivered: QueueAction[];
  expect(): Promise<void>;
  done(): Promise<void>;
  open(): Promise<QueueAction[]>;
  close(result?: { steered?: string[] } | null): Promise<QueueAction[]>;
  deliver(items: QueueAction[], how: SteerDelivery): Promise<void>;
  requeue(items: QueueAction[]): Promise<void>;
  inOrder(items: QueueAction[]): QueueAction[];
}

/**
 * A run's lead taking the chat while its build runs (live-chat.ts): a message it takes is
 * recorded delivered to its run, with the records the lead reads it from, and never waits behind
 * one the lead does not take.
 */
export interface LeadDoor {
  /** The run whose lead takes it: the delivered record's `into`. */
  into: string;
  /** Still taking messages: a door found before a wait may have shut since. */
  open(): boolean;
  /** What the lead reads the message from, written with the record that it was delivered. */
  records(item: QueueAction): Array<{ event_type: RunEvent; payload: AnyRecord }>;
  /**
   * Those records are written: the lead hears of it. `giveBack` puts messages the lead never heard
   * back in the queue when its run ends, so they still get an answer (and Stop hands over to them).
   */
  handed(item: QueueAction, giveBack: (items: QueueAction[]) => Promise<void>): void;
}

/** A value `beforeProcess` answered with: the lead's door for the next message, or anything else. */
const isLeadDoor = (value: unknown): value is LeadDoor =>
  typeof value === "object" && value !== null && typeof (value as LeadDoor).records === "function";

/** The pump's word for "look at the front of the queue again": it changed, went to the lead, or the lead's lines did. */
const LOOK_AGAIN = Symbol("look again");

/** One thread's queue while the harness runs. */
interface ThreadQueue {
  items: QueueAction[];
  ids: Set<string>;
  /** Each message's place in the order it was sent (restored ones first, in log order). */
  order: Map<string, number>;
  attempts: Map<string, number>;
  paused: boolean;
  running: boolean;
  serial: Promise<unknown>;
  /** The turn answering a message now, while it runs. */
  turn: Turn | null;
  /** Delivered into a turn a restart cut short, by that turn's message: they ride in its replay. */
  carried: Map<string, QueueAction[]>;
}

/** A promise settled from outside: a receipt still being written. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The append-only inbox view shared by the harness and transcript. */
export function messageQueueState(events: readonly HarnessEvent[]): {
  paused: boolean;
  messages: Map<string, QueuedMessage>;
} {
  const messages = new Map<string, QueuedMessage>();
  let paused = false;
  for (const [i, event] of events.entries()) {
    const d = event.data;
    if (d?.type !== EventKind.Custom) continue;
    const p: AnyRecord = d.payload ?? {};
    if (d.event_type === RunEvent.CoordinatorQueuePaused) paused = true;
    if (d.event_type === RunEvent.CoordinatorQueueResumed) paused = false;
    if (d.event_type === RunEvent.CoordinatorMessageQueued && p.messageId) {
      messages.set(p.messageId, {
        messageId: p.messageId,
        eventId: p.eventId ?? userMessageBefore(events, i),
        action: p.action,
        state: MessageState.Queued,
      });
    }
    const message = messages.get(p.messageId);
    if (message) applyMessageEvent(message, d.event_type, p);
  }
  return { paused, messages };
}

/** The id of the user message logged just before event `i`, which a queue record answers. */
function userMessageBefore(events: readonly HarnessEvent[], i: number): string | null {
  const before = events[i - 1];
  return before?.data?.type === EventKind.Messages ? before.id : null;
}

/** Move a queued message along by one custom event about it. */
function applyMessageEvent(message: QueuedMessage, eventType: string, p: AnyRecord): void {
  if (eventType === RunEvent.CoordinatorMessageUpdated) message.action = { ...message.action, text: p.text };
  if (eventType === RunEvent.CoordinatorMessageProcessing) {
    message.state = MessageState.Processing;
    message.attempts = (message.attempts ?? 0) + 1;
  }
  const settled = Object.hasOwn(STATE_AFTER, eventType) ? STATE_AFTER[eventType] : undefined;
  if (settled) message.state = settled;
  if (eventType === RunEvent.CoordinatorMessageRequeued) delete message.into;
  const steered =
    eventType === RunEvent.CoordinatorMessageSteering || eventType === RunEvent.CoordinatorMessageDelivered;
  if (steered) steerMessage(message, eventType, p);
}

/**
 * Steer: handed to the chat's running turn, then read by it (`into` is the message that turn
 * answers). A delivered message is answered by the turn it joined; it never gets one of its own.
 */
function steerMessage(message: QueuedMessage, eventType: string, p: AnyRecord): void {
  const into = typeof p.into === "string" ? p.into : undefined;
  message.state = eventType === RunEvent.CoordinatorMessageSteering ? MessageState.Steering : MessageState.Delivered;
  if (into) message.into = into;
  else if (message.state === MessageState.Steering) delete message.into;
}

/** Has the log already finished with this message (answered, or taken back)? */
function isSettled(message: QueuedMessage): boolean {
  return message.state === MessageState.Handled || message.state === MessageState.Removed;
}

/**
 * A message is answered at most this many times: once, plus one retry after a restart cut its
 * answer off. A second interruption settles it instead (the user may have quit to stop it).
 */
export const MESSAGE_ATTEMPTS = 2;

/**
 * What the chat says about a reply a restart cut off, from the thread's log before boot: whether
 * the message being answered will be retried (`restore` below), or was retried already and will
 * not be. `null` when no message was being answered; the caller keeps its own words then.
 */
export function interruptedReplyNotice(events: readonly HarnessEvent[]): string | null {
  const answering = [...messageQueueState(events).messages.values()].filter(
    (m) => m.state === MessageState.Processing && m.action,
  );
  if (!answering.length) return null;
  return answering.some((m) => (m.attempts ?? 1) < MESSAGE_ATTEMPTS)
    ? "This response was interrupted by a restart. Studio will retry this message."
    : "This response was interrupted by a restart again, so Studio will not retry it. Send it again to continue.";
}

/** The intake settings a message commissions a run with, which joining another turn would drop. */
const COMMISSION_FIELDS = ["hours", "reviewPlan", "roles"] as const;

/** A message's commission (mode, hours, plan review, roles and effort), or null for none. */
function commissionOf(message: AnyRecord): string | null {
  const commission = message.autopilot ?? message.loop;
  if (!commission) return null;
  const fields = COMMISSION_FIELDS.map((field) => commission[field] ?? null);
  return JSON.stringify([Boolean(message.autopilot), Boolean(message.loop), ...fields, message.effort ?? null]);
}

/**
 * A fresh build asked for (`newRun`, a New build queued before the composer dropped it), Studio's
 * chat, or a new mood board: always a turn of its own.
 */
function startsItsOwnTurn(item: AnyRecord, action: AnyRecord): boolean {
  return Boolean(item.newRun || item.studioThread || action.studioThread || item.autopilot?.frames?.length);
}

/** The same engine and model answer both. */
function sameModel(item: AnyRecord, action: AnyRecord): boolean {
  return (item.engine ?? null) === (action.engine ?? null) && (item.model ?? null) === (action.model ?? null);
}

/** Slash text is a command to the session, never words to fold into its turn. */
const isSlashText = (text: unknown): boolean =>
  String(text ?? "")
    .trimStart()
    .startsWith("/");

/**
 * Whether a waiting message can join the turn answering `action` instead of waiting for a turn
 * of its own: the same kind of request, to the same model. A fresh build asked for, a changed mood
 * board or slash text waits. An intake message carries the commission the run launches with: joining a
 * turn would drop hours, roles or plan review the person changed, so a different one waits too.
 */
export function steersInto(item: AnyRecord, action: AnyRecord | null | undefined): boolean {
  if (!action || startsItsOwnTurn(item, action) || !sameModel(item, action)) return false;
  if (commissionOf(item) !== commissionOf(action)) return false;
  return !isSlashText(item.text);
}

/** The turn answering `action`, as it begins: `after` is the send order it starts at. */
function newTurn(action: QueueAction, after: number, carried: QueueAction[]): Turn {
  return {
    messageId: action.messageId as string,
    action,
    after,
    expecting: false,
    open: false,
    closed: false,
    handing: Promise.resolve(),
    taken: new Map(),
    pending: [],
    delivered: [],
    carried,
  };
}

/** Is this the thread's running turn, and not yet closed? */
function isCurrent(thread: ThreadQueue, turn: Turn): boolean {
  return thread.turn === turn && !turn.closed;
}

/** A queue record naming each of these messages. */
const recordsFor = (event_type: RunEvent, items: readonly QueueAction[], extra: AnyRecord = {}) =>
  items.map((item) => ({ event_type, payload: { messageId: item.messageId, ...extra } }));

/**
 * Serialized receipt/mutation, one response at a time, and a durable pause gate.
 *
 * While a response is being written, the messages sent meanwhile are steered into it rather
 * than queued behind it — when its runner will answer with a session (`steer.expect`, then
 * `steer.open` once the session starts) and `steerable(threadId, action)` allows it (never
 * during a build). Before the session starts they join its first prompt; while it runs the host
 * puts them in (`engine.steer`): read mid-turn, or by interrupting and resuming it. Whatever the
 * session did not read goes back to the queue in the order it was sent.
 *
 * While a build runs, its run's lead may take the chat (`lead`, live-chat.ts): a message it
 * takes is delivered to it with its receipt, and one that waited is handed to it once
 * `beforeProcess` answers with the lead's door for it. What the lead does not take (a picture, a
 * fresh build asked for, slash text) keeps its place and waits for the build to close, but holds
 * nothing back: the words sent after it still reach the lead, in the order they were sent.
 */
export class MessageQueue {
  #threads = new Map<string, ThreadQueue>();
  #stopped = false;
  host: Host;
  process: (action: QueueAction, steer?: SteerHandle) => Promise<unknown>;
  /**
   * Waits until `next` may be answered — or answers with the lead's door when the lead takes it, or
   * null when the lead's lines changed and the queue should look again.
   */
  beforeProcess: (threadId: string, next?: QueueAction) => Promise<unknown>;
  steerable: (threadId: string, action: QueueAction) => boolean;
  /** The door to the run's lead that takes this message now, or null. */
  lead: (threadId: string, action: QueueAction) => LeadDoor | null;
  constructor(
    host: Host,
    process: (action: QueueAction, steer?: SteerHandle) => Promise<unknown>,
    beforeProcess: (threadId: string, next?: QueueAction) => Promise<unknown> = async () => {},
    steerable = (_threadId: string, _action: QueueAction): boolean => true,
    lead = (_threadId: string, _action: QueueAction): LeadDoor | null => null,
  ) {
    this.host = host;
    this.process = process;
    this.beforeProcess = beforeProcess;
    this.steerable = steerable;
    this.lead = lead;
  }
  #thread(id: string): ThreadQueue {
    let thread = this.#threads.get(id);
    if (!thread) {
      thread = {
        items: [],
        ids: new Set(),
        order: new Map(),
        attempts: new Map(),
        paused: false,
        running: false,
        serial: Promise.resolve(),
        turn: null,
        carried: new Map(),
      };
      this.#threads.set(id, thread);
    }
    return thread;
  }
  #serial<T>(thread: ThreadQueue, action: () => Promise<T>): Promise<T> {
    const next = thread.serial.then(action);
    thread.serial = next.catch(() => {});
    return next;
  }
  #event(threadId: string, event_type: RunEvent, payload: object = {}): Promise<string> {
    return this.#events(threadId, [{ event_type, payload }]);
  }
  #events(threadId: string, records: ReadonlyArray<{ event_type: RunEvent; payload: object }>): Promise<string> {
    return this.host.call(HostMethod.EventsAppend, {
      threadId,
      batch: records.map(({ event_type, payload }) => ({ type: EventKind.Custom, event_type, payload })),
    });
  }
  /** Knows the message, and its place in the order sent. */
  #track(thread: ThreadQueue, messageId: string): void {
    thread.ids.add(messageId);
    thread.order.set(messageId, thread.order.size);
  }
  async restore(threadId: string, events: readonly HarnessEvent[]): Promise<void> {
    const state = messageQueueState(events),
      thread = this.#thread(threadId);
    await this.#serial(thread, async () => {
      thread.paused = state.paused;
      for (const message of state.messages.values()) {
        const restorable = !isSettled(message) && message.action && !thread.ids.has(message.messageId);
        if (restorable) await this.#restoreMessage(threadId, thread, message);
      }
      // A turn that began before this replay reached the thread keeps to its own messages: the
      // restored ones were sent before it, and each gets a turn of its own.
      if (thread.turn) thread.turn.after = thread.order.size;
    });
    this.#pump(threadId);
  }
  /** Put one unsettled message back on the queue, unless a restart has already cut it off twice. */
  async #restoreMessage(threadId: string, thread: ThreadQueue, message: QueuedMessage): Promise<void> {
    if (message.state === MessageState.Delivered) {
      this.#carry(thread, message);
      return;
    }
    if (message.state === MessageState.Processing) {
      // Cut off mid-answer. Retried once, with the attempt recorded; never a third time.
      const attempts = message.attempts ?? 1;
      if (attempts >= MESSAGE_ATTEMPTS) {
        await this.#event(threadId, RunEvent.CoordinatorMessageHandled, {
          messageId: message.messageId,
          interrupted: true,
          attempts,
        });
        thread.ids.add(message.messageId);
        return;
      }
      await this.#event(threadId, RunEvent.CoordinatorMessageRequeued, { messageId: message.messageId, attempts });
    }
    // Handed to a turn a restart cut short, never read: it gets a turn of its own.
    if (message.state === MessageState.Steering)
      await this.#event(threadId, RunEvent.CoordinatorMessageRequeued, { messageId: message.messageId });
    if (message.attempts) thread.attempts.set(message.messageId, message.attempts);
    this.#track(thread, message.messageId);
    thread.items.push({ ...message.action, messageId: message.messageId } as QueueAction);
  }
  /**
   * Read by a turn a restart cut short: that turn is answered again, with this message in front
   * of it — delivered once, never asked twice or lost. One read by a turn that is not answered
   * again (finished, removed, or cut off twice) stays settled with it.
   */
  #carry(thread: ThreadQueue, message: QueuedMessage): void {
    const into = message.into;
    if (!into || !thread.items.some((item) => item.messageId === into)) return;
    this.#track(thread, message.messageId);
    const carried = thread.carried.get(into) ?? [];
    thread.carried.set(into, [...carried, { ...message.action, messageId: message.messageId } as QueueAction]);
  }
  async enqueue(action: QueueAction): Promise<void> {
    const thread = this.#thread(action.threadId);
    const receipt = await this.#serial(thread, () => this.#receive(thread, action));
    receipt?.resolve(true);
    this.#pump(action.threadId);
  }
  /**
   * Save the message and its receipt. Sent while the chat's turn works, and nothing older waits:
   * it joins that turn, recorded with its receipt so it never shows as queued first. A running
   * session is handed it once the receipt is written (the returned receipt settles that); one
   * still being set up takes it into its first prompt. Sent while a run's lead takes the chat,
   * and nothing the lead takes waits ahead of it: it is delivered to the lead with its receipt instead.
   */
  async #receive(thread: ThreadQueue, action: QueueAction): Promise<Deferred<boolean> | null> {
    const messageId = action.messageId ?? `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    if (thread.ids.has(messageId)) return null;
    const queued: QueueAction = { ...action, messageId };
    const durable = await this.#durable(queued);
    const turn = thread.turn && this.#joins(thread, thread.turn, queued) ? thread.turn : null;
    const door = turn ? null : this.#leadTakes(thread, queued);
    const receipt = turn?.open ? deferred<boolean>() : null;
    if (turn && receipt) void this.#hand(action.threadId, thread, turn, [queued], receipt.promise);
    try {
      await this.host.call(HostMethod.EventsAppend, {
        threadId: action.threadId,
        batch: receiptBatch(thread, queued, durable, turn, door),
      });
    } catch (err) {
      receipt?.resolve(false);
      throw err;
    }
    this.#track(thread, messageId);
    if (!turn && !door) thread.items.push(queued);
    else if (turn && !receipt) turn.pending.push(queued);
    thread.paused = false;
    this.host.notify("coordinator.queued", { threadId: action.threadId, messageId });
    if (door) this.#toldLead(action.threadId, door, queued);
    return receipt;
  }
  /**
   * The run's lead takes this message now: nothing holds the queue, and nothing it would take
   * waits ahead of it — what waits there (a picture, a fresh build asked for) waits for the build to
   * close.
   */
  #leadTakes(thread: ThreadQueue, queued: QueueAction): LeadDoor | null {
    if (thread.paused || this.#stopped) return null;
    const door = this.lead(queued.threadId, queued);
    if (!door?.open()) return null;
    const handedFirst = thread.items.some((item) => this.lead(queued.threadId, item));
    return handedFirst ? null : door;
  }
  /** Handed to the lead: the chat hears it was delivered, and the lead that it was handed. */
  #toldLead(threadId: string, door: LeadDoor, item: QueueAction): void {
    this.host.notify("coordinator.delivered", { threadId, messageIds: [item.messageId] });
    door.handed(item, (items) => this.#giveBack(threadId, items));
  }
  /** Messages a run's lead never heard, back from its ended run: each waits for a turn of its own. */
  async #giveBack(threadId: string, items: QueueAction[]): Promise<void> {
    if (this.#stopped) return;
    await this.#requeue(threadId, this.#thread(threadId), null, items);
  }
  /** Hand a waiting message to the run's lead, as its receipt would have. */
  async #handToLead(threadId: string, thread: ThreadQueue, item: QueueAction, door: LeadDoor): Promise<void> {
    await this.#events(threadId, leadRecords(item, door));
    thread.items = thread.items.filter((waiting) => waiting !== item);
    thread.attempts.delete(item.messageId as string);
    this.#toldLead(threadId, door, item);
  }
  /**
   * Hand the run's lead every waiting message it takes, in the order sent: what it does not take
   * keeps its place and waits for the build to close, holding nothing back behind it.
   */
  async #handPast(threadId: string, thread: ThreadQueue): Promise<void> {
    if (thread.paused || this.#stopped) return;
    for (const item of [...thread.items]) {
      const door = this.lead(threadId, item);
      if (door?.open()) await this.#handToLead(threadId, thread, item, door);
    }
  }
  /** Can this message join the running turn: it takes messages, nothing older waits, and it is the same kind of request. */
  #joins(thread: ThreadQueue, turn: Turn, queued: QueueAction): boolean {
    const takes = !thread.items.length && (turn.open || turn.expecting);
    return takes && this.#steerable(thread, queued.threadId, turn) && steersInto(queued, turn.action);
  }
  /** The message as the log keeps it: its pictures saved beside it, only their count in the log. */
  async #durable(queued: QueueAction): Promise<QueueAction> {
    const durable: QueueAction = { ...queued };
    if (!queued.stills?.length && !queued.autopilot?.frames?.length) return durable;
    durable.attachmentsArtifact = `message_attachments_${queued.messageId}`;
    // The count stays in the log so the chat can hold the pictures' place while they load.
    durable.imageCount = queued.stills?.length || queued.autopilot?.frames?.length || 0;
    await this.host.call(HostMethod.ArtifactWrite, {
      threadId: queued.threadId,
      artifactId: durable.attachmentsArtifact,
      value: { stills: queued.stills, frames: queued.autopilot?.frames },
    });
    delete durable.stills;
    if (durable.autopilot) durable.autopilot = { ...durable.autopilot, frames: undefined };
    return durable;
  }
  /**
   * The message a Stop pressed now is for: the one being answered, else the one at the front. The
   * chat keeps its Stop for it (chat-dispatch.ts `routeMessage`); what waits behind still takes over.
   */
  current(threadId: string): string | null {
    const thread = this.#thread(threadId);
    const id = thread.turn?.action.messageId ?? thread.items[0]?.messageId;
    return typeof id === "string" ? id : null;
  }
  async pause(threadId: string): Promise<void> {
    const thread = this.#thread(threadId);
    await this.#serial(thread, async () => {
      await this.#event(threadId, RunEvent.CoordinatorQueuePaused);
      thread.paused = true;
    });
  }
  async resume(threadId: string): Promise<void> {
    const thread = this.#thread(threadId);
    await this.#serial(thread, async () => {
      await this.#event(threadId, RunEvent.CoordinatorQueueResumed);
      thread.paused = false;
    });
    this.#pump(threadId);
  }
  async change(threadId: string, messageId: string, operation: string, text?: string): Promise<void> {
    const thread = this.#thread(threadId);
    await this.#serial(thread, async () => {
      const item = thread.items.find((item) => item.messageId === messageId);
      if (!item) throw new Error("This message has already started. Send a follow-up to change it.");
      if (operation === "edit") {
        if (!text?.trim()) throw new Error("Write a message before sending.");
        await this.#event(threadId, RunEvent.CoordinatorMessageUpdated, { messageId, text: text.trim() });
        item.text = text.trim();
      } else if (operation === "remove") {
        await this.#remove(threadId, thread, item);
      } else if (operation !== "hold") throw new Error("Unknown queue action");
      if (operation === "hold") {
        await this.#event(threadId, RunEvent.CoordinatorQueuePaused);
        thread.paused = true;
      } else if (operation === "edit") {
        await this.#event(threadId, RunEvent.CoordinatorQueueResumed);
        thread.paused = false;
      }
    });
    this.#pump(threadId);
  }
  /** Take a waiting message back. A turn a restart cut short, removed before its replay: what it had read gets its own turns. */
  async #remove(threadId: string, thread: ThreadQueue, item: QueueAction): Promise<void> {
    const messageId = item.messageId as string;
    await this.#event(threadId, RunEvent.CoordinatorMessageRemoved, { messageId });
    thread.items = thread.items.filter((candidate) => candidate !== item);
    const carried = thread.carried.get(messageId) ?? [];
    thread.carried.delete(messageId);
    if (!carried.length) return;
    await this.#events(threadId, recordsFor(RunEvent.CoordinatorMessageRequeued, carried));
    thread.items.push(...carried);
    this.#sort(thread);
  }

  // ── steer: the current turn takes what is sent while it works ──

  #steerable(thread: ThreadQueue, threadId: string, turn: Turn): boolean {
    return !thread.paused && !this.#stopped && this.steerable(threadId, turn.action);
  }
  /** The thread's running turn, still taking messages, and nothing (a build, a pause, Stop) holds them back. */
  #takesMessages(thread: ThreadQueue, threadId: string, turn: Turn): boolean {
    return isCurrent(thread, turn) && this.#steerable(thread, threadId, turn);
  }
  /** The waiting messages, in the order they were sent. */
  #sort(thread: ThreadQueue): void {
    thread.items = this.#inOrder(thread, thread.items);
  }
  /** Messages in the order they were sent. */
  #inOrder(thread: ThreadQueue, items: readonly QueueAction[]): QueueAction[] {
    const place = (item: QueueAction) => thread.order.get(item.messageId as string) ?? 0;
    return [...items].sort((a, b) => place(a) - place(b));
  }
  /**
   * The messages sent during this turn that wait at the front of the queue and can join it, taken
   * out in order. Older ones (sent before this turn began, or a cut-short turn replayed after a
   * restart) keep their own turns: never reordered.
   */
  #front(threadId: string, thread: ThreadQueue, turn: Turn): QueueAction[] {
    const taken: QueueAction[] = [];
    if (!this.#takesMessages(thread, threadId, turn)) return taken;
    for (;;) {
      const item = thread.items[0];
      if (!item || !this.#joinsFromFront(thread, turn, item)) return taken;
      taken.push(item);
      thread.items.shift();
    }
  }
  /** Sent during this turn, not a replayed turn itself, and the same kind of request. */
  #joinsFromFront(thread: ThreadQueue, turn: Turn, item: QueueAction): boolean {
    const messageId = item.messageId as string;
    const sentDuring = (thread.order.get(messageId) ?? -1) >= turn.after;
    return sentDuring && !thread.carried.has(messageId) && steersInto(item, turn.action);
  }
  /** The runner will answer with a session: what is sent from now on joins it (Sending…), not the queue. */
  #expect(threadId: string, thread: ThreadQueue, turn: Turn): Promise<void> {
    return this.#serial(thread, async () => {
      if (!isCurrent(thread, turn)) return;
      turn.expecting = true;
      const taken = this.#front(threadId, thread, turn);
      if (!taken.length) return;
      await this.#events(threadId, recordsFor(RunEvent.CoordinatorMessageSteering, taken, { into: turn.messageId }));
      turn.pending.push(...taken);
      this.host.notify("coordinator.steering", { threadId, messageIds: taken.map((item) => item.messageId) });
    });
  }
  /**
   * The session is starting: from now on what is sent is handed to it. Returned, in the order
   * sent, is what joined while it was being set up — its runner puts that in the prompt it is
   * about to send and records it delivered (`deliver`).
   */
  #openTurn(threadId: string, thread: ThreadQueue, turn: Turn): Promise<QueueAction[]> {
    return this.#serial(thread, async () => {
      if (!isCurrent(thread, turn)) return [];
      turn.open = true;
      turn.expecting = true;
      const joined = this.#inOrder(thread, [...turn.pending.splice(0), ...this.#front(threadId, thread, turn)]);
      for (const item of joined) turn.taken.set(item.messageId as string, { item, how: SteerDelivery.Prompt });
      return joined;
    });
  }
  /**
   * Asks the host to put these messages into the turn's running session, once their receipt is
   * written (`written`); what it will not take waits again. Chained on `turn.handing` at once, so
   * closing the turn always waits for it.
   */
  #hand(
    threadId: string,
    thread: ThreadQueue,
    turn: Turn,
    items: QueueAction[],
    written: Promise<boolean>,
  ): Promise<unknown> {
    const next = turn.handing.then(() => this.#handOver(threadId, thread, turn, items, written));
    turn.handing = next.catch(() => {});
    return next;
  }
  async #handOver(
    threadId: string,
    thread: ThreadQueue,
    turn: Turn,
    items: QueueAction[],
    written: Promise<boolean>,
  ): Promise<void> {
    if (!(await written)) return;
    // The session stopped taking input meanwhile (its leg ended, a Stop): these wait again.
    const takesInput = turn.open && this.#takesMessages(thread, threadId, turn);
    if (!takesInput) return this.#requeue(threadId, thread, turn, items);
    // Pictures that cannot be read stay behind: the words still reach the session, and the
    // message never waits as Sending… until a restart.
    for (const item of items)
      if (item.attachmentsArtifact && !item.stills) await this.#attach(threadId, item).catch(() => {});
    const answer = await this.host
      .call(HostMethod.EngineSteer, { threadId, into: turn.messageId, messages: items.map(steerMessageOf) })
      .catch(() => null);
    const accepted = new Set(answer?.accepted ?? []);
    for (const item of items)
      if (accepted.has(item.messageId as string))
        turn.taken.set(item.messageId as string, { item, how: answer?.how ?? null });
    const refused = items.filter((item) => !accepted.has(item.messageId as string));
    if (!refused.length) return;
    // The session will not take input now (its turn is ending, or it never could): stop
    // offering until the runner opens it again, and let these wait for their own turn.
    turn.open = false;
    await this.#requeue(threadId, thread, turn, refused);
  }
  /** Puts messages back where they were sent, among the ones still waiting, and lets the queue run. */
  async #requeue(threadId: string, thread: ThreadQueue, turn: Turn | null, items: QueueAction[]): Promise<void> {
    for (const item of items) {
      turn?.taken.delete(item.messageId as string);
      if (turn) turn.pending = turn.pending.filter((pending) => pending !== item);
    }
    if (!items.length) return;
    await this.#serial(thread, async () => {
      const back = items.filter((item) => !thread.items.includes(item));
      if (!back.length) return;
      await this.#events(threadId, recordsFor(RunEvent.CoordinatorMessageRequeued, back));
      thread.items.push(...back);
      this.#sort(thread);
      this.host.notify("coordinator.requeued", { threadId, messageIds: back.map((item) => item.messageId) });
    });
    this.#pump(threadId);
  }
  /**
   * The runner's session stopped taking messages (its engine call returned or failed). What it
   * read natively is delivered — the host recorded where — and what it did not read waits again.
   * What it took by being interrupted, or for a prompt, is returned (in the order sent) for the
   * runner to settle.
   */
  async #close(
    threadId: string,
    thread: ThreadQueue,
    turn: Turn,
    result?: { steered?: string[] } | null,
  ): Promise<QueueAction[]> {
    turn.open = false;
    await turn.handing;
    const native = [...turn.taken.values()].filter(({ how }) => how === SteerDelivery.Native);
    const read = await this.#readNatively(threadId, turn, native.length > 0, result);
    const unread: QueueAction[] = [];
    for (const { item } of native) {
      turn.taken.delete(item.messageId as string);
      if (read.has(item.messageId as string)) turn.delivered.push(item);
      else unread.push(item);
    }
    await this.#requeue(threadId, thread, turn, unread);
    return this.#inOrder(
      thread,
      [...turn.taken.values()].map(({ item }) => item),
    );
  }
  /** What the session read mid-turn: its result says; with no result (the call threw) the log is the only witness. */
  async #readNatively(
    threadId: string,
    turn: Turn,
    tookAny: boolean,
    result: { steered?: string[] } | null | undefined,
  ): Promise<Set<string>> {
    if (result) return new Set(result.steered ?? []);
    if (!tookAny) return new Set();
    const events = await this.host.call(HostMethod.EventsList, { threadId }).catch(() => []);
    const read = [...messageQueueState(events).messages.values()].filter(
      (message) => message.state === MessageState.Delivered && message.into === turn.messageId,
    );
    return new Set(read.map((message) => message.messageId));
  }
  /**
   * The runner is done with sessions for this turn: nothing more joins it, and what joined since
   * its last session waits for a turn of its own. Inside the serial chain, so a message whose
   * receipt is being written either made it into `pending` first or is queued.
   */
  async #done(threadId: string, thread: ThreadQueue, turn: Turn): Promise<void> {
    const left = await this.#serial(thread, async () => {
      turn.expecting = false;
      turn.open = false;
      return turn.pending.splice(0);
    });
    await this.#requeue(threadId, thread, turn, left);
  }
  /** Delivered by the runner itself: in the prompt it is about to send, or the one it resumes with. */
  async #deliver(threadId: string, turn: Turn, items: QueueAction[], how: SteerDelivery): Promise<void> {
    if (!items.length) return;
    await this.#events(
      threadId,
      recordsFor(RunEvent.CoordinatorMessageDelivered, items, { into: turn.messageId, how }),
    );
    for (const item of items) turn.taken.delete(item.messageId as string);
    turn.delivered.push(...items);
    this.host.notify("coordinator.delivered", { threadId, messageIds: items.map((item) => item.messageId) });
  }
  /** What the runner of a turn sees (chat-steer.ts): its session's door to what is sent meanwhile. */
  #steerHandle(threadId: string, thread: ThreadQueue, turn: Turn): SteerHandle {
    return {
      messageId: turn.messageId,
      carried: turn.carried,
      get delivered() {
        return [...turn.carried, ...turn.delivered];
      },
      expect: () => this.#expect(threadId, thread, turn),
      done: () => this.#done(threadId, thread, turn),
      open: () => this.#openTurn(threadId, thread, turn),
      close: (result) => this.#close(threadId, thread, turn, result),
      deliver: (items, how) => this.#deliver(threadId, turn, items, how),
      requeue: (items) => {
        // A message recorded delivered but never read goes back too: the requeue resets it.
        turn.delivered = turn.delivered.filter((item) => !items.includes(item));
        return this.#requeue(threadId, thread, turn, items);
      },
      inOrder: (items) => this.#inOrder(thread, items),
    };
  }

  #pump(threadId: string): void {
    const thread = this.#thread(threadId);
    if (thread.running || thread.paused || this.#stopped) return;
    thread.running = true;
    void (async () => {
      try {
        while (!this.#stopped && (await this.#step(threadId, thread))) {}
      } catch (err: any) {
        thread.paused = true;
        this.host.notify("chat.error", { threadId, message: `The queue is paused: ${err?.message ?? err}` });
      } finally {
        thread.running = false;
        if (thread.items.length && !thread.paused && !this.#stopped) this.#pump(threadId);
      }
    })();
  }
  /**
   * One step of the pump: hand the run's lead what it takes, wait until the message at the front
   * may be answered (or its lead takes it), then answer it, hand it over, or look again. False when
   * there is nothing to do.
   */
  async #step(threadId: string, thread: ThreadQueue): Promise<boolean> {
    if (!thread.items.length || thread.paused) return false;
    await this.#serial(thread, () => this.#handPast(threadId, thread));
    const next = thread.items[0];
    if (!next || thread.paused) return false;
    const door = await this.beforeProcess(threadId, next);
    const action = await this.#serial(thread, () => this.#next(threadId, thread, next, door));
    if (action === LOOK_AGAIN) return true;
    if (!action) return false;
    await this.#answer(threadId, thread, action);
    return true;
  }
  /**
   * After the wait for `next`: hand it to the run's lead when `beforeProcess` answered with the
   * lead's door, or take it to answer. The front changed meanwhile, the lead's lines changed (null),
   * or its door shut: look again.
   */
  async #next(
    threadId: string,
    thread: ThreadQueue,
    next: QueueAction,
    door: unknown,
  ): Promise<QueueAction | typeof LOOK_AGAIN | null> {
    const [front] = thread.items;
    if (thread.paused || this.#stopped || !front) return null;
    if (front !== next || door === null) return LOOK_AGAIN;
    if (!isLeadDoor(door)) return this.#take(threadId, thread);
    if (door.open()) await this.#handToLead(threadId, thread, front, door);
    return LOOK_AGAIN;
  }
  /** Take the next message off the queue and log that it is being answered; null when there is none to take. */
  async #take(threadId: string, thread: ThreadQueue): Promise<QueueAction | null> {
    const [action] = thread.items;
    if (thread.paused || this.#stopped || !action) return null;
    const messageId = action.messageId as string;
    const earlier = thread.attempts.get(messageId);
    await this.#event(threadId, RunEvent.CoordinatorMessageProcessing, {
      messageId: action.messageId,
      ...(earlier ? { attempt: earlier + 1 } : {}),
    });
    thread.attempts.delete(messageId);
    thread.items.shift();
    return action;
  }
  /**
   * Answer one message with its attachments restored, and with the door its runner steers
   * through; a failure is said in the chat, and the message is handled either way.
   */
  async #answer(threadId: string, thread: ThreadQueue, action: QueueAction): Promise<void> {
    const messageId = action.messageId as string;
    const carried = thread.carried.get(messageId) ?? [];
    thread.carried.delete(messageId);
    // `after`: only what is sent from here on may join this turn; older messages keep theirs.
    const turn = newTurn(action, thread.order.size, carried);
    thread.turn = turn;
    this.host.notify("coordinator.processing", { threadId, messageId: action.messageId });
    let failed = false;
    try {
      for (const item of [action, ...carried]) if (item.attachmentsArtifact) await this.#attach(threadId, item);
      await this.process(action, this.#steerHandle(threadId, thread, turn));
    } catch (err: any) {
      failed = true;
      await this.host.call(HostMethod.EventsAppend, {
        threadId,
        batch: [
          {
            type: EventKind.Error,
            message: `Could not answer this message: ${err?.message ?? err}. Send a message to continue.`,
          },
        ],
      });
    } finally {
      await this.#endTurn(threadId, thread, turn);
      // Handled either way — never answered twice — but a failed one says so.
      await this.#event(threadId, RunEvent.CoordinatorMessageHandled, {
        messageId: action.messageId,
        ...(failed ? { failed: true } : {}),
      });
      this.host.notify("coordinator.handled", { threadId, messageId: action.messageId });
    }
  }
  /**
   * Whatever the runner left taken but unsettled, or never took, waits again before this turn
   * ends (a runner that never opened a session: a local model, an early failure).
   */
  async #endTurn(threadId: string, thread: ThreadQueue, turn: Turn): Promise<void> {
    await this.#done(threadId, thread, turn).catch(() => {});
    const left = await this.#close(threadId, thread, turn).catch(() => []);
    await this.#requeue(threadId, thread, turn, left).catch(() => {});
    turn.closed = true;
    thread.turn = null;
  }
  /** Put a message's stills and reference frames back on it, from the artifact they were kept in. */
  async #attach(threadId: string, action: QueueAction): Promise<void> {
    const attachments = (await this.host.call(HostMethod.ArtifactRead, {
      threadId,
      artifactId: action.attachmentsArtifact,
    })) as AnyRecord | null;
    if (attachments?.stills) action.stills = attachments.stills;
    if (attachments?.frames && action.autopilot) action.autopilot = { ...action.autopilot, frames: attachments.frames };
  }
  stop(): void {
    this.#stopped = true;
  }
}

/**
 * A message's receipt: its words, its queue record, a resumed queue, and — joining a turn — its
 * hand-over, or — taken by a run's lead — its delivery to that lead.
 */
function receiptBatch(
  thread: ThreadQueue,
  queued: QueueAction,
  durable: QueueAction,
  joining: Turn | null,
  lead: LeadDoor | null,
) {
  const record = (event_type: RunEvent, payload: object) => ({ type: EventKind.Custom, event_type, payload });
  return [
    { type: EventKind.Messages, messages: [{ role: "user" as const, content: queued.text as string }] },
    record(RunEvent.CoordinatorMessageQueued, { messageId: queued.messageId, action: durable }),
    ...(thread.paused ? [record(RunEvent.CoordinatorQueueResumed, {})] : []),
    ...(joining
      ? [record(RunEvent.CoordinatorMessageSteering, { messageId: queued.messageId, into: joining.messageId })]
      : []),
    ...(lead ? leadRecords(queued, lead).map(({ event_type, payload }) => record(event_type, payload)) : []),
  ];
}

/** A message delivered to a run's lead: recorded delivered to its run, then what the lead reads it from. */
function leadRecords(item: QueueAction, door: LeadDoor): Array<{ event_type: RunEvent; payload: AnyRecord }> {
  return [
    {
      event_type: RunEvent.CoordinatorMessageDelivered,
      payload: { messageId: item.messageId, into: door.into, how: SteerDelivery.Lead },
    },
    ...door.records(item),
  ];
}

/** A message as `engine.steer` hands it to the session: its words and its pictures. */
function steerMessageOf(item: QueueAction): { id: string; text: string; images?: DelegateImage[] } {
  const images: DelegateImage[] = item.stills ?? [];
  return { id: item.messageId as string, text: String(item.text ?? ""), ...(images.length ? { images } : {}) };
}

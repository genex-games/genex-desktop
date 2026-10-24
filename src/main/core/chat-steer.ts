/**
 * Steer, the host's half: a message the person sent while the chat's own turn works goes into
 * the session answering that turn (`engine.steer`). An engine that reads input mid-turn
 * (`Engine.steersMidTurn`) takes it at its next step and reports where it read it, which is
 * recorded in stream order among the turn's mirrored rows; any other session, and one asked not
 * to read it mid-turn (`native: false`), is cut at its next step, between tool calls and never
 * inside one (`steer-cut.ts`) — marked `steered`, so its caller (the harness's
 * `loop/chat-steer.ts`) resumes it with the messages in front instead of reading a Stop. Either
 * way the session's plugin calls stop waiting for a lock (`PersonWrote`): the agent reads the
 * message first. Only a chat's own session answers a turn, and a run's lead, which answers the
 * chat while its build runs (addressed by its run id, and told without recording where: the queue
 * recorded the hand-over): a builder's never.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import type { HarnessParams, HarnessResult, HostMethod } from "../../shared/harness-api.ts";
import { SteerDelivery } from "../../shared/message-queue.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { SteerMessage, SteerSend } from "../../substrate/engines/types.ts";
import type { StudioCore } from "../studio-core.ts";
import type { ActiveDelegation } from "./internals.ts";
import { personWrote, personWroteBeforeCut } from "./plugin-locks.ts";
import { cutAtNextStep } from "./steer-cut.ts";

/** How long `engine.steer` waits for the session it names: the harness asks as soon as it has asked for it. */
export const FIND_SESSION_MS = 3 * SECOND_MS;
/** How often it looks for that session meanwhile. */
const FIND_SESSION_POLL_MS = 50;
/** How many pictures one steered message carries into the session, as a brief does. */
const MAX_STEER_IMAGES = 16;

/** What the log is told when a read message could not be recorded. */
const MESSAGE = {
  notRecorded: (error: unknown) => `Could not record a steered message: ${String(error)}`,
} as const;

type SteerParams = HarnessParams<typeof HostMethod.EngineSteer>;
/**
 * How `engine.steer` waits, between looks for the session and for a cut's cap (`STEER_CUT_MAX_WAIT_MS`):
 * real time, or a test's own clock. Its signal ends the wait early.
 */
export type SteerSleep = (ms: number, signal?: AbortSignal) => Promise<unknown>;
/** Real time: a wait its signal ends rejects, and leaves no timer behind. */
const realSleep: SteerSleep = (ms, signal) => sleep(ms, undefined, signal ? { signal } : {});
type SteerAnswer = HarnessResult<typeof HostMethod.EngineSteer>;
type DelegateParams = HarnessParams<typeof HostMethod.EngineDelegate>;

/** Nothing was taken: there is no such session, or it stopped taking input. */
const REFUSED: SteerAnswer = { how: null, accepted: [] };

/**
 * A session's input mid-turn, when its engine reads messages as it works. The engine says once
 * whether this session takes them (`DelegateRequest.steer.ready`); `engine.steer` waits to hear.
 */
export interface SteerDoor {
  /** Undefined until the engine says; then its `send`, or null when it takes nothing mid-turn. */
  send?: SteerSend | null;
  waiters: Array<(send: SteerSend | null) => void>;
}

/** A door nobody has said anything about yet. */
export function openDoor(): SteerDoor {
  return { waiters: [] };
}

/** The engine says whether this session takes input mid-turn; later words are ignored. */
export function settleDoor(door: SteerDoor | undefined, send: SteerSend | null): void {
  if (!door || door.send !== undefined) return;
  door.send = send;
  for (const waiter of door.waiters.splice(0)) waiter(send);
}

/** The door's `send`, once the engine has said. */
function doorSend(door: SteerDoor): Promise<SteerSend | null> {
  if (door.send !== undefined) return Promise.resolve(door.send);
  return new Promise((resolve) => door.waiters.push(resolve));
}

/** What else a delegation may be for, besides a chat's own turn: the director grant as honoured. */
interface NarrowerPurpose {
  director: { runId: string } | null;
  playtest: unknown;
  candidate: unknown;
}

/**
 * The chat turn a delegation answers (`chatTurn`): a chat's own session, by the message it
 * answers — or a run's lead, by its own run and nothing else. Never a build worktree, a
 * playtester or an optimization candidate, whatever the caller claims.
 */
export function chatTurnOf(p: DelegateParams, narrower: NarrowerPurpose): string | undefined {
  const messageId = p.chatTurn?.messageId;
  if (typeof messageId !== "string" || !p.threadId) return undefined;
  if (narrower.director) return messageId === narrower.director.runId ? messageId : undefined;
  return servesNarrowerPurpose(p, narrower) ? undefined : messageId;
}

/** A build worktree (`cwd`), a director, a playtester or an optimization candidate. */
function servesNarrowerPurpose(p: DelegateParams, narrower: NarrowerPurpose): boolean {
  return Boolean(p.cwd || narrower.director || narrower.playtest || narrower.candidate);
}

/** The messages as a session takes them: an id, the words and a few pictures, nothing else. */
function steerMessages(p: SteerParams): SteerMessage[] {
  const messages = Array.isArray(p?.messages) ? p.messages : [];
  return messages
    .filter((m) => typeof m?.id === "string" && typeof m.text === "string")
    .map((m) => {
      const images = Array.isArray(m.images) ? m.images.filter((image) => image?.data).slice(0, MAX_STEER_IMAGES) : [];
      return { id: m.id, text: m.text, ...(images.length ? { images } : {}) };
    });
}

/** The running session answering this chat turn, if there is one. */
function chatSession(delegations: Iterable<ActiveDelegation>, p: SteerParams): ActiveDelegation | undefined {
  for (const delegation of delegations) {
    const answers = delegation.chatTurn === p.into && delegation.threadId === p.threadId;
    if (answers && !delegation.ended) return delegation;
  }
  return undefined;
}

/** That session, given a moment to register: the harness asks as soon as it has asked for it. */
async function findChatSession(
  delegations: ReadonlyMap<string, ActiveDelegation>,
  p: SteerParams,
  wait: SteerSleep,
): Promise<ActiveDelegation | undefined> {
  for (let waited = 0; ; waited += FIND_SESSION_POLL_MS) {
    const running = chatSession(delegations.values(), p);
    if (running || waited >= FIND_SESSION_MS) return running;
    await wait(FIND_SESSION_POLL_MS);
  }
}

/** Hand the messages in, in order, until the session will not take one. */
function sendEach(send: SteerSend, messages: readonly SteerMessage[]): string[] {
  const accepted: string[] = [];
  for (const message of messages) {
    if (!send(message)) break;
    accepted.push(message.id);
  }
  return accepted;
}

/** The session's own input mid-turn, once its engine said; none when it has none, or the steer asks for a cut (`native: false`). */
async function nativeSend(running: ActiveDelegation, p: SteerParams): Promise<SteerSend | null> {
  if (p.native === false || !running.steer) return null;
  return doorSend(running.steer);
}

/** The messages read mid-turn: the session's calls waiting for a lock stop waiting once it took one. */
function sendNatively(running: ActiveDelegation, send: SteerSend, messages: readonly SteerMessage[]): SteerAnswer {
  const accepted = sendEach(send, messages);
  if (accepted.length && running.personWrote) personWrote(running.personWrote);
  return { how: SteerDelivery.Native, accepted };
}

/**
 * `engine.steer`: messages the person sent while the chat's turn works, into the session
 * answering it. Read mid-turn by an engine that can (`native`, recorded where it reads them), or
 * taken by cutting the session at its next step (`interrupt`), answered at once though the cut
 * lands when its tools in flight ended: its caller resumes it with them in front. `wait` is the
 * clock it looks for the session on, and waits out a cut's cap on.
 */
export async function steerIntoChat(
  delegations: ReadonlyMap<string, ActiveDelegation>,
  p: SteerParams,
  wait: SteerSleep = realSleep,
): Promise<SteerAnswer> {
  const messages = steerMessages(p);
  const running = await findChatSession(delegations, p, wait);
  if (!running || !messages.length) return REFUSED;
  const all = messages.map((m) => m.id);
  // Already cut, or to be at its next step, to take earlier messages: these join the same resume.
  if (running.steered) return { how: SteerDelivery.Interrupt, accepted: all };
  if (running.abort.signal.aborted) return REFUSED;
  const send = await nativeSend(running, p);
  if (send) return sendNatively(running, send, messages);
  // No input mid-turn (Codex, an older Claude Code, a Loop chat), or none asked: cut, and the caller
  // resumes — unless it asked for a session that reads them as it works, or none.
  const mayCut = p.interrupt !== false && !running.ended && !running.abort.signal.aborted;
  if (!mayCut) return REFUSED;
  running.steered = true;
  if (running.personWrote) personWroteBeforeCut(running.personWrote);
  cutAtNextStep(running, wait);
  return { how: SteerDelivery.Interrupt, accepted: all };
}

/** The session read a steered message here: appended now, in stream order, so the chat shows it at this point. */
export function recordSteerDelivered(core: StudioCore, threadId: string, into: string, messageId: string): void {
  const read = customEventData(CustomEvent.CoordinatorMessageDelivered, { messageId, into, how: SteerDelivery.Native });
  void core
    .append([read], threadId)
    .then(() => core.emit(UiEvent.CoordinatorDelivered, { threadId, messageIds: [messageId] }))
    .catch((error) => core.options.onLog?.(MESSAGE.notRecorded(error), "stderr"));
}

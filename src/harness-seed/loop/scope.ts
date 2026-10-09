/**
 * What a build is for, as the user said it: their literal words (`asked`, taken from the chat's log,
 * never from a model), what this build delivers (`inScope`), what it will not have (`cut`), what a
 * plan built beyond the ask (`added`) and the user steers that changed it (`revisions`). It rides on
 * the run (`run.scope`, stamped at launch by chat-dispatch.ts `intakeRun`), so the journal keeps it
 * and a Resume or a reopen reads it back; scope-prompts.ts renders it for every agent that reads the
 * goal. A run without it is a run from before it existed, and every reader behaves as before.
 *
 * The user's own words are kept because a paraphrase drifts: with only the contractor's goal to
 * read, and nothing saying what was cut, a street race grows police, traffic and a pursuit meter.
 *
 * A new module, so a kept older sibling can never shadow these names; it imports only the log's own
 * folds (run-inbox.ts `conversationThrough`, message-queue.ts `messageQueueState`), which every seed has.
 */

import { messageQueueState } from "./message-queue.ts";
import { EventKind, RunEvent } from "./run-events.ts";
import { conversationThrough } from "./run-inbox.ts";
import type { AnyRecord, HarnessEvent } from "../types/harness.d.ts";

/** Whether a proposal deepens what the user asked for or adds something they did not name. */
export const MoveScope = { Deepens: "deepens", Adds: "adds" } as const;
export type MoveScope = (typeof MoveScope)[keyof typeof MoveScope];

/** The journal shape's version (`restoreScope`). */
const SCOPE_VERSION = 1;
/** How many items each of in scope, cut and added keeps. */
export const SCOPE_ITEMS = 12;
/** How long one in-scope, cut or added item may be. */
export const SCOPE_ITEM_CHARS = 200;
/** How much of the user's own words the ask keeps, all messages together. */
export const ASKED_CHARS = 4000;
/** How long one message of the ask may be. */
export const ASKED_MESSAGE_CHARS = 2000;
/** How many scope revisions a run remembers (each is a user steer, used once). */
const SCOPE_REVISIONS = 32;

/** A run's scope: the user's words, what is in, what is cut, what was added, and the steers that changed it. */
export interface RunScope {
  version: typeof SCOPE_VERSION;
  /** The user's own messages up to the launch (and each reopening message), verbatim. */
  asked: string[];
  /** What this build delivers, each item from the user's words. */
  inScope: string[];
  /** What a game like this often has that this build will not; nobody builds or proposes it. */
  cut: string[];
  /** What a plan builds beyond the ask, waiting for the user's yes; never in scope by itself. */
  added: string[];
  /** The user steers that changed scope, each usable once. */
  revisions: string[];
}

/** The parts a launch knows: the user's words, and the contractor's in-scope and cut lists. */
export interface ScopeParts {
  asked: readonly unknown[];
  inScope?: readonly unknown[];
  cut?: readonly unknown[];
  added?: readonly unknown[];
}

/** The non-empty strings of a list, trimmed and de-duplicated. */
function words(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const kept: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text && !kept.includes(text)) kept.push(text);
  }
  return kept;
}

/** The non-empty strings of a list, trimmed, every one kept: the user's words, repeats and all. */
function said(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : []));
}

/** A list of scope items, each clipped, at most `SCOPE_ITEMS`. */
function items(values: unknown): string[] {
  return words(words(values).map((text) => text.slice(0, SCOPE_ITEM_CHARS))).slice(0, SCOPE_ITEMS);
}

/**
 * The user's messages within `ASKED_CHARS`: the first (the ask a build was commissioned from) and as
 * many of the newest as fit, in the order they were sent.
 */
function boundAsked(values: unknown): string[] {
  const messages = said(values).map((text) => text.slice(0, ASKED_MESSAGE_CHARS));
  const [first, ...rest] = messages;
  if (first === undefined) return [];
  const newest: string[] = [];
  let used = first.length;
  for (let i = rest.length - 1; i >= 0; i--) {
    const message = rest[i] ?? "";
    if (used + message.length > ASKED_CHARS) break;
    newest.unshift(message);
    used += message.length;
  }
  return [first, ...newest];
}

/**
 * A tool's list as scope items: an array, a JSON array in a string, or one item per line — the shapes
 * engines pass an array parameter in.
 */
export function scopeItems(value: unknown): string[] {
  if (Array.isArray(value)) return items(value);
  if (typeof value !== "string") return [];
  const text = value.trim();
  if (text.startsWith("[")) {
    try {
      return items(JSON.parse(text));
    } catch {
      return [];
    }
  }
  return items(text.split("\n"));
}

/** A run's scope at launch. */
export function createScope({ asked, inScope = [], cut = [], added = [] }: ScopeParts): RunScope {
  return {
    version: SCOPE_VERSION,
    asked: boundAsked(asked),
    inScope: items(inScope),
    cut: items(cut),
    added: items(added),
    revisions: [],
  };
}

/** A scope as a journal or a run kept it; undefined for anything but the versioned shape with an ask. */
export function restoreScope(value: unknown): RunScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const saved = value as Record<string, unknown>;
  if (saved.version !== SCOPE_VERSION) return undefined;
  const scope = createScope({
    asked: Array.isArray(saved.asked) ? saved.asked : [],
    inScope: Array.isArray(saved.inScope) ? saved.inScope : [],
    cut: Array.isArray(saved.cut) ? saved.cut : [],
    added: Array.isArray(saved.added) ? saved.added : [],
  });
  if (!scope.asked.length) return undefined;
  return { ...scope, revisions: words(saved.revisions).slice(-SCOPE_REVISIONS) };
}

/** Anything that may carry a scope: a run (whose other fields are its own), a journal's run, a record. */
export type ScopeCarrier = { readonly scope?: unknown; readonly [field: string]: unknown } | null | undefined;

/** The scope a run carries, read as `restoreScope` reads a journal's; undefined for a run without one. */
export function runScope(run: ScopeCarrier): RunScope | undefined {
  return restoreScope(run?.scope);
}

/**
 * Scope widened by the user: `items` move into scope (and out of the cut list), and their words join
 * the ask. Null unless `instruction` is one of the user's own steers quoted exactly and not used to
 * change scope before — the same rule as director/goals.ts `reviseGoals`. Returns a new scope.
 */
export function addToScope(
  scope: RunScope,
  added: readonly string[],
  instruction: string,
  userInstructions: readonly string[],
): RunScope | null {
  if (!instruction || !userInstructions.includes(instruction) || scope.revisions.includes(instruction)) return null;
  const moved = items(added);
  return {
    ...createScope({
      asked: [...scope.asked, instruction],
      inScope: [...scope.inScope, ...moved],
      cut: scope.cut.filter((item) => !moved.includes(item)),
      added: scope.added.filter((item) => !moved.includes(item)),
    }),
    revisions: [...scope.revisions, instruction].slice(-SCOPE_REVISIONS),
  };
}

/** Does a proposal add something the user did not ask for? Only its typed `scope` says so; none deepens. */
export function isBeyondScope(proposal: { scope?: unknown } | null | undefined): boolean {
  return proposal?.scope === MoveScope.Adds;
}

/** The records that open or close a run on a thread; a new build's ask starts after the latest. */
const RUN_BOUNDARIES: readonly string[] = [RunEvent.RunRegistered, RunEvent.RunStarted, RunEvent.RunFinished];

/** Which of a thread's user messages `userWordsInLog` reads. */
export interface UserWordsWindow {
  /** The queued message the words run up to (itself included); later messages are left out. */
  through?: string | null;
  /** Only what was said after the thread's latest run opened or closed: the ask of a new build. */
  sinceLastRun?: boolean;
}

/**
 * The user's own messages in a thread's log, trimmed, in the order sent: as the queue has them (an
 * edit applied, a removed message gone, nothing after `through`), never a message the chat wrote
 * itself (a command's result, queued with an `origin`) nor any model's words.
 */
export function userWordsInLog(events: readonly HarnessEvent[], window: UserWordsWindow = {}): string[] {
  const chatWrote = chatWrittenEvents(events);
  const view = conversationThrough(events, window.through);
  const start = window.sinceLastRun ? view.findLastIndex(isRunBoundary) + 1 : 0;
  return said(
    view
      .slice(start)
      .filter((event) => !chatWrote.has(event.id))
      .flatMap((event) => (event.data?.type === EventKind.Messages ? (event.data.messages ?? []) : []))
      .filter((message: AnyRecord) => message?.role === "user")
      .map((message: AnyRecord) => message.content),
  );
}

/** The ids of the logged messages the chat queued itself (`origin` set: chat-dispatch.ts `chatWrote`). */
function chatWrittenEvents(events: readonly HarnessEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messageQueueState(events).messages.values()) {
    const origin = message.action?.origin;
    if (message.eventId && origin !== undefined && origin !== null) ids.add(message.eventId);
  }
  return ids;
}

/** Does this record open or close a run? */
function isRunBoundary(event: HarnessEvent): boolean {
  return event.data?.type === EventKind.Custom && RUN_BOUNDARIES.includes(String(event.data.event_type));
}

import { compareIds } from "../shared/compare-ids.ts";
/**
 * Notifications: what is waiting on you, and what happened in your games while you were elsewhere.
 *
 * Read from the event log, never written to it. The log stays the one record; this is a reader's
 * inbox over it, kept in localStorage so it survives a relaunch past the bootstrap's event tail.
 *
 * Two kinds of row, because they end differently:
 *  - Waiting (a question, a plan, a permission) holds work until the person answers. It
 *    stays in Needs you until the log settles it, then disappears. Opening the panel never clears it.
 *  - Activity (a build that ended, a provider that signed out) is news. Opening the panel reads it.
 *
 * A build the person stopped is not news, and neither is one that ended in the chat they were
 * watching: it arrives already read.
 */
import { withdrawnId } from "../shared/chat-rewind.ts";
import { PlanReviewState } from "../shared/composer.ts";
import {
  CustomEvent,
  type CustomEventName,
  type CustomPayload,
  customPayload,
  customRecord,
} from "../shared/custom-events.ts";
import { DAY_MS, MINUTE_MS } from "../shared/duration.ts";
import { EventKind } from "../shared/event-log.ts";
import { ExecutionStatus, executionStep } from "../shared/run-state.ts";
import { contractorIdentity } from "./chat-labels.ts";
import { StageView } from "./stage.ts";
import { STORAGE_KEYS } from "./storage.ts";
import type { EventEnvelope } from "./types.ts";
import { A_PLUGIN, NOTICE_WORDS, permissionTitleWords, permissionWords, problemWords, wasCancelled } from "./words.ts";
import { ToolPermissionState } from "../shared/permissions.ts";

/** What a notice is about: a question, a plan, a plugin's permission, a build's ending, a sign-in. */
export const NoticeKind = {
  Question: "question",
  Plan: "plan",
  Permission: "permission",
  Build: "build",
  SignIn: "signin",
} as const;
export type NoticeKind = (typeof NoticeKind)[keyof typeof NoticeKind];

/** How a build's ending reads. */
export const NoticeTone = { Done: "done", Failed: "failed", Stopped: "stopped" } as const;
export type NoticeTone = (typeof NoticeTone)[keyof typeof NoticeTone];

export interface Notice {
  /** The event that raised it. */
  id: string;
  /** What it is about. A newer notice with the same key replaces the older one. */
  key: string;
  kind: NoticeKind;
  at: string;
  threadId: string;
  project?: string;
  text: string;
  tone?: NoticeTone;
  /** Holds work until the person answers. */
  waiting?: boolean;
  /** A waiting plan starts by itself at this time. */
  until?: number;
  read?: boolean;
  /** Where opening it lands on the stage. */
  view?: typeof StageView.Live | typeof StageView.Builds;
  /** The provider a sign-in notice is about. */
  engine?: string;
}

export interface NoticeState {
  /** The newest event already read into the feed. Event ids are time-ordered UUIDv7. */
  floor: string | null;
  items: Notice[];
}

/** Activity kept; waiting rows are few and always kept until settled. */
export const NOTICE_KEEP = 60;
export const EMPTY_NOTICES: NoticeState = { floor: null, items: [] };

/** The key of each kind of notice; a newer notice with the same key replaces the older one. */
const noticeKey = {
  question: (threadId: string) => `question:${threadId}`,
  plan: (threadId: string) => `plan:${threadId}`,
  autoplan: (runId: string) => `autoplan:${runId}`,
  consent: (consentId: string) => `consent:${consentId}`,
  permission: (requestId: string) => `permission:${requestId}`,
  build: (runId: string) => `build:${runId}`,
  signIn: (engine: string) => `signin:${engine}`,
};
const AUTOPLAN_PREFIX = noticeKey.autoplan("");

/** A notice any reply in its chat answers: a question, or a plan waiting for "go". */
const answeredByReply = (item: Notice): boolean =>
  item.kind === NoticeKind.Question || item.key.startsWith(AUTOPLAN_PREFIX);

const words = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** A close that stopped short: paused or cancelled, or one the harness says was interrupted. */
function endedEarly(
  status: string | undefined,
  payload: CustomPayload<typeof CustomEvent.RunFinished>,
  because?: string,
): boolean {
  const early = status === ExecutionStatus.Paused || status === ExecutionStatus.Cancelled;
  return early || payload.paused === true || /interrupted/i.test(because ?? "");
}

/** A build's ending in one sentence, or null when there is nothing to tell. */
export function buildNotice(
  payload: CustomPayload<typeof CustomEvent.RunFinished>,
): Pick<Notice, "text" | "tone" | "view"> | null {
  const because = words(payload.stoppedBecause);
  if (wasCancelled(because)) return null;
  const failure = words(payload.failure?.message);
  // How the close describes the run, by the one execution rule (shared/run-state.ts).
  const status = executionStep(null, "", { event_type: CustomEvent.RunFinished, payload, at: "" })?.status;
  if (status === ExecutionStatus.Failed || failure) {
    return {
      tone: NoticeTone.Failed,
      view: StageView.Builds,
      text: failure ? `${NOTICE_WORDS.buildFailed} ${problemWords(failure)}` : NOTICE_WORDS.buildFailed,
    };
  }
  if (endedEarly(status, payload, because))
    return { tone: NoticeTone.Stopped, view: StageView.Builds, text: NOTICE_WORDS.buildStopped };
  if (payload.landed === true) return { tone: NoticeTone.Done, view: StageView.Live, text: NOTICE_WORDS.buildLive };
  return { tone: NoticeTone.Stopped, view: StageView.Builds, text: NOTICE_WORDS.buildNothingNew };
}

type FeedOptions = { catchUp?: boolean; seen?: (threadId: string) => boolean };

/** The feed while `applyEvents` reads: its rows, the ones that arrived, and how to read them. */
interface FeedDraft {
  items: Notice[];
  floor: string | null;
  arrived: Notice[];
  options: FeedOptions;
}

/** Waiting rows the log has now answered disappear. */
function settle(feed: FeedDraft, match: (item: Notice) => boolean): void {
  feed.items = feed.items.filter((item) => !(item.waiting && match(item)));
}

/** A notice raised by this event, replacing any older one with its key; news the person saw arrives read. */
function raise(feed: FeedDraft, event: EventEnvelope, notice: Omit<Notice, "id" | "at" | "threadId">): void {
  const threadId = event.thread_id;
  const { options } = feed;
  const read = !notice.waiting && Boolean(options.catchUp || options.seen?.(threadId));
  const next: Notice = { ...notice, id: event.id, at: event.created_at, threadId, ...(read ? { read } : {}) };
  feed.items = [...feed.items.filter((item) => item.key !== next.key), next];
  if (!options.catchUp && !read) feed.arrived.push(next);
}

/**
 * Reads events newer than the floor into the feed. `catchUp` is the first read after launch with
 * no saved feed: history arrives read, so an upgrade does not ring for yesterday.
 */
export function applyEvents(
  state: NoticeState,
  events: readonly EventEnvelope[],
  options: FeedOptions = {},
): { state: NoticeState; arrived: Notice[] } {
  const feed: FeedDraft = { items: state.items, floor: state.floor, arrived: [], options };
  for (const event of events) {
    if (feed.floor !== null && event.id <= feed.floor) continue;
    feed.floor = event.id;
    readNoticeEvent(feed, event);
  }
  if (feed.floor === state.floor) return { state, arrived: feed.arrived };
  const waiting = feed.items.filter((item) => item.waiting);
  const activity = feed.items.filter((item) => !item.waiting).slice(-NOTICE_KEEP);
  return { state: { floor: feed.floor, items: [...waiting, ...activity] }, arrived: feed.arrived };
}

function readNoticeEvent(feed: FeedDraft, event: EventEnvelope): void {
  const { data, thread_id: threadId } = event;
  if (data.type === EventKind.Messages) {
    // Any reply answers the chat's question and a plan that waits for "go".
    if (data.messages.some((message) => message.role === "user"))
      settle(feed, (item) => item.threadId === threadId && answeredByReply(item));
    return;
  }
  const custom = customRecord(data);
  if (!custom) return;
  const project = words(custom.payload.project);
  const about = project ? { project } : {};
  switch (custom.event_type) {
    case CustomEvent.RunRegistered:
    case CustomEvent.RunStarted:
      settle(feed, (item) => item.threadId === threadId && item.kind === NoticeKind.Question);
      break;
    case CustomEvent.InterviewQuestion:
      onQuestion(feed, event, about);
      break;
    case CustomEvent.PlanReview:
      onPlanReview(feed, event, about);
      break;
    case CustomEvent.AutopilotPlanReview:
      onAutoplan(feed, event, about);
      break;
    case CustomEvent.PluginConsent:
      onConsent(feed, event, about);
      break;
    case CustomEvent.ToolPermission:
      onToolPermission(feed, event, about);
      break;
    case CustomEvent.RunFinished:
      onRunFinished(feed, event, about);
      break;
    case CustomEvent.AutopilotPaused:
      onPaused(feed, event);
      break;
    case CustomEvent.NeedsSignin:
      onSignedOut(feed, event);
      break;
    case CustomEvent.ConversationRewound:
      onRewound(feed, event);
      break;
    default:
      break;
  }
}

type About = { project?: string };

/** The payload of this event under its contract name (shared/custom-events.ts); every field optional. */
const payloadOf = <K extends CustomEventName>(event: EventEnvelope, name: K): CustomPayload<K> =>
  customPayload(event.data, name) ?? {};

function onQuestion(feed: FeedDraft, event: EventEnvelope, about: About): void {
  const question = words(payloadOf(event, CustomEvent.InterviewQuestion).question);
  if (!question) return;
  raise(feed, event, {
    kind: NoticeKind.Question,
    key: noticeKey.question(event.thread_id),
    waiting: true,
    text: question,
    ...about,
  });
}

function onPlanReview(feed: FeedDraft, event: EventEnvelope, about: About): void {
  const { state: review } = payloadOf(event, CustomEvent.PlanReview);
  const key = noticeKey.plan(event.thread_id);
  settle(feed, (item) => item.key === key);
  if (review === PlanReviewState.Waiting)
    raise(feed, event, { kind: NoticeKind.Plan, key, waiting: true, text: NOTICE_WORDS.planReady, ...about });
  if (review === PlanReviewState.Failed)
    raise(feed, event, {
      kind: NoticeKind.Plan,
      key,
      tone: NoticeTone.Failed,
      text: NOTICE_WORDS.planFailed,
      ...about,
    });
}

function onAutoplan(feed: FeedDraft, event: EventEnvelope, about: About): void {
  const plan = payloadOf(event, CustomEvent.AutopilotPlanReview);
  const minutes = typeof plan.waitMinutes === "number" ? plan.waitMinutes : 0;
  const runId = words(plan.runId);
  if (minutes <= 0 || !runId) return;
  raise(feed, event, {
    kind: NoticeKind.Plan,
    key: noticeKey.autoplan(runId),
    waiting: true,
    ...about,
    until: Date.parse(event.created_at) + minutes * MINUTE_MS,
    text: NOTICE_WORDS.buildPlanReady,
  });
}

function onConsent(feed: FeedDraft, event: EventEnvelope, about: About): void {
  const consent = payloadOf(event, CustomEvent.PluginConsent);
  const key = noticeKey.consent(words(consent.consentId) ?? event.id);
  if (consent.state !== "pending") {
    settle(feed, (item) => item.key === key);
    return;
  }
  const plugin = words(consent.pluginName) ?? A_PLUGIN;
  raise(feed, event, {
    kind: NoticeKind.Permission,
    key,
    waiting: true,
    text: permissionWords(plugin, words(consent.prompt)),
    ...about,
  });
}

/** Claude asking before it runs a command, edits a file or leaves Plan: the same kind of wait. */
function onToolPermission(feed: FeedDraft, event: EventEnvelope, about: About): void {
  const request = payloadOf(event, CustomEvent.ToolPermission);
  const key = noticeKey.permission(words(request.requestId) ?? event.id);
  if (request.state !== ToolPermissionState.Pending) {
    settle(feed, (item) => item.key === key);
    return;
  }
  raise(feed, event, {
    kind: NoticeKind.Permission,
    key,
    waiting: true,
    text: permissionTitleWords(request),
    ...about,
  });
}

function onRunFinished(feed: FeedDraft, event: EventEnvelope, about: About): void {
  const finished = payloadOf(event, CustomEvent.RunFinished);
  const runId = words(finished.runId) ?? event.id;
  const autoplan = noticeKey.autoplan(runId);
  settle(feed, (item) => item.key === autoplan);
  const ending = buildNotice(finished);
  if (ending) raise(feed, event, { kind: NoticeKind.Build, key: noticeKey.build(runId), ...ending, ...about });
}

/** A paused build's ending reads as stopped, unless it already failed. */
function onPaused(feed: FeedDraft, event: EventEnvelope): void {
  const key = noticeKey.build(words(payloadOf(event, CustomEvent.AutopilotPaused).runId) ?? "");
  feed.items = feed.items.map((item) =>
    item.key === key && item.tone !== NoticeTone.Failed
      ? { ...item, tone: NoticeTone.Stopped, view: StageView.Builds, text: NOTICE_WORDS.buildStopped }
      : item,
  );
}

/** A question or plan the rewind withdrew no longer waits (one it re-opened stays quiet). */
function onRewound(feed: FeedDraft, event: EventEnvelope): void {
  const { from, through, hide, keep } = payloadOf(event, CustomEvent.ConversationRewound);
  const rewind = {
    messageId: "",
    from: words(from) ?? "",
    through: words(through) ?? "",
    hide: Array.isArray(hide) ? hide : [],
    keep: Array.isArray(keep) ? keep : [],
  };
  settle(
    feed,
    (item) =>
      item.threadId === event.thread_id &&
      (item.kind === NoticeKind.Question || item.kind === NoticeKind.Plan) &&
      withdrawnId(item.id, [rewind]),
  );
}

function onSignedOut(feed: FeedDraft, event: EventEnvelope): void {
  const engine = words(payloadOf(event, CustomEvent.NeedsSignin).engine) ?? "";
  raise(feed, event, { kind: NoticeKind.SignIn, key: noticeKey.signIn(engine), engine, text: NOTICE_WORDS.signedOut });
}

/** Who a row is from: the provider for a sign-in, else the game, a game still being named, or the Harness chat. */
export function noticeSource(notice: Notice, gameTitle: string | undefined, gameThread = true): string {
  if (notice.kind === NoticeKind.SignIn) return contractorIdentity(notice.engine ?? "").label;
  return gameTitle ?? (gameThread ? NOTICE_WORDS.newGame : NOTICE_WORDS.harness);
}

/** Rows still waiting now; a plan that has started by itself no longer is. */
export function waitingNotices(items: readonly Notice[], now = Date.now()): Notice[] {
  return items
    .filter((item) => item.waiting && !(item.until && item.until <= now))
    .sort((a, b) => compareIds(b.at, a.at));
}

export function activityNotices(items: readonly Notice[]): Notice[] {
  return items.filter((item) => !item.waiting).sort((a, b) => compareIds(b.at, a.at));
}

/** The coarse day something happened on, by the local calendar. */
export const DayGroup = { Today: "today", Yesterday: "yesterday", Earlier: "earlier" } as const;
export type DayGroup = (typeof DayGroup)[keyof typeof DayGroup];

/** The notifications menu's heading for each day. */
const DAY_HEADINGS = {
  [DayGroup.Today]: "Today",
  [DayGroup.Yesterday]: "Yesterday",
  [DayGroup.Earlier]: "Earlier",
} as const satisfies Record<DayGroup, string>;

/** Which day `iso` falls on, seen from `now`: today, yesterday or earlier. */
export function dayOf(iso: string, now = new Date()): DayGroup {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const at = Date.parse(iso);
  if (at >= today) return DayGroup.Today;
  if (at >= today - DAY_MS) return DayGroup.Yesterday;
  return DayGroup.Earlier;
}

/** Today / Yesterday / Earlier: coarse on purpose, the row carries its own time. */
export function dayGroup(iso: string, now = new Date()): (typeof DAY_HEADINGS)[DayGroup] {
  return DAY_HEADINGS[dayOf(iso, now)];
}

/** An activity row not yet read, among the ones asked for (all when none are named). */
const unreadActivity = (item: Notice, ids?: ReadonlySet<string>): boolean =>
  !item.waiting && !item.read && (!ids || ids.has(item.id));

export function markRead(state: NoticeState, ids?: ReadonlySet<string>): NoticeState {
  if (!state.items.some((item) => unreadActivity(item, ids))) return state;
  return {
    ...state,
    items: state.items.map((item) => (unreadActivity(item, ids) ? { ...item, read: true } : item)),
  };
}

/** Clears activity; waiting rows stay until they are answered. */
export function clearActivity(state: NoticeState): NoticeState {
  return { ...state, items: state.items.filter((item) => item.waiting) };
}

const STORE_KEY = STORAGE_KEYS.notifications;

export function loadNotices(storage: Pick<Storage, "getItem">): NoticeState | null {
  try {
    const saved = JSON.parse(storage.getItem(STORE_KEY) ?? "null") as NoticeState | null;
    return saved && Array.isArray(saved.items)
      ? { floor: typeof saved.floor === "string" ? saved.floor : null, items: saved.items }
      : null;
  } catch {
    return null;
  }
}

export function saveNotices(storage: Pick<Storage, "setItem">, state: NoticeState): void {
  try {
    storage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // A full or blocked store only costs the feed its memory across a relaunch.
  }
}

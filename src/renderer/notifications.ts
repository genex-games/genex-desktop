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
 *
 * Genex's review of a game's apps or its takedown (`genex_review`) is one row per game, its newest
 * change: a game taken down or an app turned down waits for the person until they press Fix with
 * agent, ask a person, or it goes live again; a person reviewing it, and a game going live or public
 * again, is news.
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
import { t } from "../shared/i18n.ts";
import { ExecutionStatus, executionStep } from "../shared/run-state.ts";
import { GenexReviewChange } from "../shared/genex-review.ts";
import { LoopProfile } from "../shared/project-facts.ts";
import { contractorIdentity } from "./chat-labels.ts";
import { StageView } from "./stage.ts";
import { STORAGE_KEYS } from "./storage.ts";
import type { EventEnvelope } from "./types.ts";
import {
  A_PLUGIN,
  NATIVE_WORDS,
  nativeHereWords,
  NOTICE_WORDS,
  permissionTitleWords,
  permissionWords,
  problemWords,
  REVIEW_WORDS,
  wasCancelled,
} from "./words.ts";
import { sizeWords } from "../shared/byte-size.ts";
import { InstallFailure, isInstallFailure } from "../shared/play-native.ts";
import { ToolPermissionState } from "../shared/permissions.ts";

/**
 * What a notice is about: a question, a plan, a plugin's permission, a build's ending, a sign-in, or
 * a game from Play installed, failed to install or updated (`slug` names it; it opens its page).
 */
export const NoticeKind = {
  Question: "question",
  Plan: "plan",
  Permission: "permission",
  Build: "build",
  SignIn: "signin",
  Play: "play",
  /** Genex's review of a game's apps or its takedown (`genex_review`). */
  Review: "review",
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
  /** A Play notice's game, and its name as the row says it. */
  slug?: string;
  title?: string;
  /** A review row's first line in place of its game's name: "Midnight Asphalt was taken down". */
  headline?: string;
  /** What changed in a review row's game, and how many things it has to fix: its macOS and toast words. */
  change?: GenexReviewChange;
  count?: number;
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
  play: (slug: string) => `play:${slug}`,
  /** A game's review: one row per game, its newest change, which waits while the game must be fixed. */
  review: (project: string) => `review:${project}`,
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
  if (payload.landed === true) {
    // A Loop led in its project's own folder kept its work there: Live may only show it as stills.
    const text = payload.profile === LoopProfile.Open ? NOTICE_WORDS.buildKept : NOTICE_WORDS.buildLive;
    return { tone: NoticeTone.Done, view: StageView.Live, text };
  }
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
    case CustomEvent.PlayInstallFinished:
    case CustomEvent.PlayInstallFailed:
    case CustomEvent.PlayUpdateAvailable:
      onPlayInstall(feed, event, custom.event_type);
      break;
    case CustomEvent.GenexReview:
      onReview(feed, event);
      break;
    case CustomEvent.GenexReviewFix:
      // Fix with agent pressed: the game no longer waits for the person.
      if (project) settle(feed, (item) => item.key === noticeKey.review(project));
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

/** What a Play install's row says: ready, why it failed, or a new version waiting. */
function playInstallText(event: EventEnvelope, kind: PlayInstallEvent): Pick<Notice, "text" | "tone"> {
  if (kind === CustomEvent.PlayInstallFinished) {
    const { platform } = payloadOf(event, CustomEvent.PlayInstallFinished);
    return { text: nativeHereWords(String(platform)).readyToPlay, tone: NoticeTone.Done };
  }
  if (kind === CustomEvent.PlayUpdateAvailable) {
    const size = payloadOf(event, CustomEvent.PlayUpdateAvailable).sizeBytes;
    return { text: NOTICE_WORDS.newVersion(sizeWords(typeof size === "number" ? size : 0)) };
  }
  const failed = payloadOf(event, CustomEvent.PlayInstallFailed);
  const failure = isInstallFailure(failed.failure) ? failed.failure : InstallFailure.Failed;
  const needed = typeof failed.neededBytes === "number" ? failed.neededBytes : 0;
  const here = nativeHereWords(String(failed.platform));
  return { text: NATIVE_WORDS.installFailed[failure](sizeWords(needed), here), tone: NoticeTone.Failed };
}

/** The Play install events a row is raised for. */
type PlayInstallEvent =
  | typeof CustomEvent.PlayInstallFinished
  | typeof CustomEvent.PlayInstallFailed
  | typeof CustomEvent.PlayUpdateAvailable;

/** A game from Play installed, failed to install, or has a new version: one row per game, the newest. */
function onPlayInstall(feed: FeedDraft, event: EventEnvelope, kind: PlayInstallEvent): void {
  const about = payloadOf(event, kind);
  const slug = words(about.slug);
  if (!slug) return;
  const title = words(about.title) ?? slug;
  raise(feed, event, {
    kind: NoticeKind.Play,
    key: noticeKey.play(slug),
    slug,
    title,
    ...playInstallText(event, kind),
  });
}

/**
 * How a review row reads, by what changed: its headline and words, and whether it waits for the
 * person. A newer change replaces the game's row: a request for a person, or the game live again,
 * no longer waits.
 */
interface ReviewShown {
  headline: string;
  text: string;
  waiting: boolean;
  /** It is live again. */
  done: boolean;
}

/** A review record's row; null for a change the bell does not tell (sent, a fix's end). */
function reviewShown(
  change: GenexReviewChange | undefined,
  game: { title: string; app: string; count: number },
): ReviewShown | null {
  const { title, app, count } = game;
  const waits = (headline: string): ReviewShown => ({
    headline,
    text: REVIEW_WORDS.notice.things(count),
    waiting: true,
    done: false,
  });
  const news = (headline: string, text: string, done: boolean): ReviewShown => ({
    headline,
    text,
    waiting: false,
    done,
  });
  switch (change) {
    case GenexReviewChange.TakenDown:
      return waits(REVIEW_WORDS.notice.takenDown(title));
    case GenexReviewChange.NotApproved:
      return waits(REVIEW_WORDS.notice.notApproved(title, app));
    case GenexReviewChange.Upheld:
      return waits(REVIEW_WORDS.notice.upheld(title));
    case GenexReviewChange.WithPerson:
    case GenexReviewChange.Requested:
      return news(title, REVIEW_WORDS.notice.humanReview, false);
    case GenexReviewChange.Live:
      return news(REVIEW_WORDS.title.live(title), REVIEW_WORDS.line.anyone, true);
    case GenexReviewChange.Restored:
      return news(REVIEW_WORDS.title.publicAgain(title), REVIEW_WORDS.line.anyone, true);
    default:
      return null;
  }
}

/** How many things a review record has to fix: its count, else its things. */
const thingsCount = (review: CustomPayload<typeof CustomEvent.GenexReview>): number => {
  if (typeof review.count === "number") return review.count;
  return Array.isArray(review.things) ? review.things.length : 0;
};

/** Genex's review of a game changed: a row that waits for the person, news, or nothing. */
function onReview(feed: FeedDraft, event: EventEnvelope): void {
  const review = payloadOf(event, CustomEvent.GenexReview);
  const project = words(review.project);
  if (!project) return;
  const title = words(review.title) ?? project;
  const app = words(review.app?.platform) ?? "apps";
  const shown = reviewShown(review.change, { title, app, count: thingsCount(review) });
  if (!shown) return;
  raise(feed, event, {
    kind: NoticeKind.Review,
    key: noticeKey.review(project),
    project,
    headline: shown.headline,
    text: shown.text,
    ...(review.change ? { change: review.change } : {}),
    count: thingsCount(review),
    ...(shown.waiting ? { waiting: true } : {}),
    ...(shown.done ? { tone: NoticeTone.Done } : {}),
  });
}

/** Who a row is from: the provider for a sign-in, a Play game, a review's headline, else the game, a game still being named, or the Harness chat. */
export function noticeSource(notice: Notice, gameTitle: string | undefined, gameThread = true): string {
  if (notice.kind === NoticeKind.SignIn) return contractorIdentity(notice.engine ?? "").label;
  if (notice.kind === NoticeKind.Play) return notice.title ?? "";
  if (notice.kind === NoticeKind.Review && notice.headline) return notice.headline;
  return gameTitle ?? (gameThread ? NOTICE_WORDS.newGame : NOTICE_WORDS.harness);
}

/** The review changes macOS is told of while Studio is in the background. */
const REVIEW_SYSTEM: ReadonlySet<string> = new Set<GenexReviewChange>([
  GenexReviewChange.TakenDown,
  GenexReviewChange.NotApproved,
  GenexReviewChange.Restored,
  GenexReviewChange.Live,
]);
/** The review changes a toast tells while another game is open. */
const REVIEW_TOAST: ReadonlySet<string> = new Set<GenexReviewChange>([
  GenexReviewChange.TakenDown,
  GenexReviewChange.NotApproved,
  GenexReviewChange.Restored,
]);
/** Past this many notices arriving at once, macOS is told one line about them all. */
const SYSTEM_NOTES_MAX = 3;

const NOTICE_SUBTITLES: Partial<Record<NoticeKind, string>> = {
  [NoticeKind.Question]: t("Waiting for your answer"),
  [NoticeKind.Plan]: t("Plan ready for review"),
  [NoticeKind.Permission]: t("Permission needed"),
};

/** One macOS notification: `id` names the row a click opens. */
export interface SystemNote {
  id?: string;
  title: string;
  subtitle?: string;
  body: string;
}

/** Whether macOS is told of a notice: every one but a review change the bell alone tells. */
const tellsSystem = (notice: Notice): boolean =>
  notice.kind !== NoticeKind.Review || REVIEW_SYSTEM.has(notice.change ?? "");

/** One notice as macOS says it: a review's headline, and for a game that waits what a click does. */
function systemNote(notice: Notice, source: string): SystemNote {
  if (notice.kind === NoticeKind.Review) {
    const body = notice.waiting ? REVIEW_WORDS.notice.systemThings(notice.count ?? 0) : notice.text;
    return { id: notice.id, title: notice.headline ?? source, body };
  }
  const subtitle = NOTICE_SUBTITLES[notice.kind];
  return { id: notice.id, title: source, body: notice.text, ...(subtitle ? { subtitle } : {}) };
}

/**
 * What macOS is told of the notices that arrived: nothing on the first read or while Studio is in
 * front (the person sees the bell), else one note each, or one line for a burst.
 */
export function systemNotes(
  arrived: readonly Notice[],
  seen: { first: boolean; focused: boolean },
  source: (notice: Notice) => string,
): SystemNote[] {
  if (seen.first || seen.focused) return [];
  const told = arrived.filter(tellsSystem);
  if (told.length <= SYSTEM_NOTES_MAX) return told.map((notice) => systemNote(notice, source(notice)));
  const body = t("{count, plural, one {# update from your games} other {# updates from your games}}", {
    count: told.length,
  });
  return [{ title: "Genex", body }];
}

/**
 * The review notices a toast tells: a game taken down, an app turned down or a game public again,
 * while Studio is in front and another game is open (the open game's own card already says it).
 */
export function reviewToasts(arrived: readonly Notice[], seen: { focused: boolean; openProject: string | null }) {
  if (!seen.focused) return [];
  return arrived.filter(
    (notice) =>
      notice.kind === NoticeKind.Review && REVIEW_TOAST.has(notice.change ?? "") && notice.project !== seen.openProject,
  );
}

/** Where opening a row takes the person: a chat (a review row's with its game's Publish open), Settings, Play, or nowhere. */
export type NoticeDestination =
  | { to: "thread"; threadId: string; view?: Notice["view"]; publish?: string }
  | { to: "settings" }
  | { to: "play"; slug: string }
  | { to: "nowhere" };

/**
 * Where a row goes when it is opened, from the bell, macOS or a toast: a sign-in to Settings, a Play
 * game to its page, a review to its game's chat with Publish open (never a press: opening it sends
 * nothing), anything else to its chat. After the bell's Fix (`fixed`), a review goes to its game's
 * chat alone, where the agent has the fix. A chat that is gone goes nowhere.
 */
export function noticeDestination(
  notice: Notice,
  chatExists: (threadId: string) => boolean,
  fixed = false,
): NoticeDestination {
  if (notice.kind === NoticeKind.SignIn) return { to: "settings" };
  if (notice.kind === NoticeKind.Play) return notice.slug ? { to: "play", slug: notice.slug } : { to: "nowhere" };
  if (!chatExists(notice.threadId)) return { to: "nowhere" };
  if (notice.kind === NoticeKind.Review && notice.project && !fixed)
    return { to: "thread", threadId: notice.threadId, publish: notice.project };
  return { to: "thread", threadId: notice.threadId, ...(notice.view ? { view: notice.view } : {}) };
}

/**
 * The bell's Fix on a review row: Fix with agent on its game (the press is the consent to the brief it
 * sends the game's chat), then the game's chat. A failed press still opens the chat, where its card is.
 */
export async function pressReviewFix(
  api: { genexFixReview(project: string, options: { autoPublish: boolean }): Promise<unknown> },
  notice: Notice,
  go: (notice: Notice) => void,
  failed: (error: unknown) => void,
): Promise<void> {
  if (notice.kind === NoticeKind.Review && notice.project) {
    await api.genexFixReview(notice.project, { autoPublish: true }).catch(failed);
  }
  go(notice);
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
  [DayGroup.Today]: t("Today"),
  [DayGroup.Yesterday]: t("Yesterday"),
  [DayGroup.Earlier]: t("Earlier"),
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

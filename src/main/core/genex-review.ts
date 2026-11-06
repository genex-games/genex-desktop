/**
 * Fix with agent and Request human review, pressed on a game's review card (the Publish dialog's, the
 * chat's, the bell's Fix), and what Studio does by itself once the agent is done.
 *
 * - Fix with agent sends the game's chat a brief of Genex's things to fix (`genex-review-prompts.ts`)
 *   and records the press (`genex_review_fix`). The press is the person's consent to that message and
 *   to the one automatic step after it: once the agent's work ends, a fixed app that was built again
 *   is sent again so Genex checks it, and a taken-down game with apps is sent again and a person at
 *   Genex is asked to put it back. A taken-down web game is only said to be fixed: publishing it and
 *   asking a person stay the person's. "Don't publish it automatically" takes that step back.
 * - One automatic step per press: a second turn-down never sends again by itself.
 * - Request human review asks a person at Genex about the turned-down apps or the takedown, with the
 *   person's note, and sends an app Genex keeps no copy of again in the same press.
 *
 * Every Genex call goes through the Genex plugin; web games keep today's publishing.
 */
import type { ComposerSendOptions } from "../../shared/composer.ts";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { MessageFrom } from "../../shared/engine-requests.ts";
import type { EventData, EventEnvelope } from "../../shared/event-log.ts";
import {
  GenexAppReview,
  GenexDecider,
  GenexFixKind,
  GenexReviewChange,
  type GenexReviewPayload,
  type GenexReviewRecord,
  type GenexReviewRequestAnswer,
  type GenexReviewStatus,
  type GenexReviewTold,
  type GenexTakedown,
  thingsOf,
  worstApps,
} from "../../shared/genex-review.ts";
import { FixEnd, type GenexFixState, fixWorkEnded, newestFix } from "../../shared/genex-review-log.ts";
import { t } from "../../shared/i18n.ts";
import { reviewChanges } from "./genex-review-watch.ts";
import { AfterFix, appFixBrief, rebuildBrief, takedownFixBrief } from "./genex-review-prompts.ts";

/** Why a press did nothing, as the person reads it. */
const MESSAGE = {
  NothingToFix: () => t("Genex has nothing for this game's agent to fix"),
  NoSuchFix: () => t("That fix isn't the game's latest one"),
  NothingToBuild: () => t("This game's latest fix isn't waiting for a build"),
} as const;

/** What the review flows run on: the Genex plugin, the game's chat and its folder. */
export interface GenexReviewDeps {
  /** The plugin's `review-status` for the game; `refresh` reads Genex first, `told` keeps what was told. */
  status(project: string, options?: { refresh?: boolean; told?: GenexReviewTold }): Promise<GenexReviewStatus>;
  /** The game's own chat, made when it has none: for what is written there. */
  thread(project: string): Promise<string>;
  /** The game's own chat when it has one; null otherwise. Reading never makes one. */
  existingThread(project: string): Promise<string | null>;
  /** The game's name and link on Genex. */
  game(project: string): Promise<{ title: string; slug?: string; web: boolean }>;
  events(threadId: string): Promise<EventEnvelope[]>;
  append(threadId: string, records: EventData[]): Promise<void>;
  /** Send the game's chat a message Genex wrote. */
  send(text: string, options: ComposerSendOptions): Promise<unknown>;
  /** The app builds a send takes, by their place in the folder (`publishedApps`). */
  apps(project: string, choice: { force?: string; builtAfter?: number }): Promise<string[]>;
  /** Publish a game that has only apps, as the dialog's press does (`publishAppsFromDialog`). */
  publishApps(project: string): Promise<void>;
  /** Send apps of a game with a web version again on their own (`apps-resend`). */
  resendApps(project: string, native: string[]): Promise<void>;
  /** The plugin's `review-request`. */
  request(
    project: string,
    args: { platform?: string; arch?: string; note?: string; native?: string[] },
  ): Promise<GenexReviewRequestAnswer>;
  /** Read the game's review again now. */
  refresh(project: string): void;
  /** Tell the window the game's line and bell row may have changed (`UiEvent.GenexReviewChanged`). */
  changed(project: string): void;
  now(): number;
  id(): string;
}

/** The words an app's brief names it by: "Mac app", "Windows app", "Linux app", or "apps". */
const APP_NAME: Readonly<Record<string, string>> = { mac: "Mac app", windows: "Windows app", linux: "Linux app" };
const appName = (platforms: readonly string[]): string =>
  platforms.length === 1 ? (APP_NAME[platforms[0] ?? ""] ?? "app") : "apps";

/**
 * What Studio does once the agent is done with a takedown's fix: a web game's is the person's; a game
 * with apps is sent again, and a person asked to put it back while a request may go (an old Genex that
 * needs the person's own words gets none from Studio).
 */
function takedownStep(takedown: GenexTakedown, web: boolean): AfterFix {
  if (web) return AfterFix.Yours;
  return takedown.humanReview.canRequest && !takedown.noteMin ? AfterFix.AskPerson : AfterFix.Publish;
}

/** The turned-down apps a fix is about, and the words its brief names them by. */
function turnedDownApps(record: GenexReviewRecord) {
  const apps = worstApps(record).filter((app) => app.state === GenexAppReview.NotApproved);
  return { apps, platform: appName([...new Set(apps.map((app) => app.platform))]) };
}

/** What a game's review asks the agent to fix: its kind, the things, and the brief's words. */
function fixFor(record: GenexReviewRecord, game: { title: string; web: boolean }) {
  const takedown = record.takedown;
  if (takedown) {
    if (takedown.things.length === 0) return null;
    const kind = game.web ? GenexFixKind.Web : GenexFixKind.Takedown;
    const step = takedownStep(takedown, game.web);
    const text = takedownFixBrief({ title: game.title, things: takedown.things, step });
    return { kind, count: takedown.things.length, text };
  }
  const { apps, platform } = turnedDownApps(record);
  const things = thingsOf(apps);
  if (things.length === 0) return null;
  const decidedBy = apps.some((app) => app.decidedBy === GenexDecider.Person) ? GenexDecider.Person : undefined;
  const text = appFixBrief({ title: game.title, platform, things, ...(decidedBy ? { decidedBy } : {}) });
  return { kind: GenexFixKind.App, count: things.length, text };
}

/** A `genex_review_fix` record. */
const fixRecord = (project: string, fix: Omit<GenexFixState, "index" | "outcome">) =>
  customEventData(CustomEvent.GenexReviewFix, { project, ...fix });

/** A `genex_review` record. */
const reviewRecord = (payload: GenexReviewPayload) => customEventData(CustomEvent.GenexReview, { ...payload });

/** A fix's outcome as its record says it, at `now`. */
const outcome = (project: string, change: GenexReviewChange, now: number, extra: Partial<GenexReviewPayload> = {}) => ({
  project,
  change,
  ...extra,
  at: new Date(now).toISOString(),
});

/**
 * Build again after a fix whose app was not built again: the same fix, pressed again, with a brief that
 * asks only for the build; null when the game's newest fix is not waiting for one.
 */
function rebuildFor(
  fix: GenexFixState | null,
  record: GenexReviewRecord | null,
  game: { title: string; web: boolean },
) {
  if (fix?.outcome !== GenexReviewChange.NotBuilt || !record) return null;
  const takedown = record.takedown;
  const step = takedown ? takedownStep(takedown, game.web) : AfterFix.Publish;
  const platform = takedown ? appName([]) : turnedDownApps(record).platform;
  return { kind: fix.kind, count: fix.count, text: rebuildBrief({ title: game.title, platform, step }) };
}

/**
 * Fix with agent: the press is recorded, with Studio's step after it (`autoPublish`), then the brief
 * goes to the game's chat; a brief that never reached it ends the press stopped. With `fixId` and
 * `autoPublish: false`, it is "Don't publish it automatically" on that press: only the record changes.
 * With `rebuild`, it is Build again: the newest fix, which ended with nothing built, is pressed again.
 */
export async function fixReviewFromDialog(
  deps: GenexReviewDeps,
  project: string,
  options: { autoPublish?: unknown; fixId?: unknown; rebuild?: unknown },
): Promise<{ fixId: string }> {
  const threadId = await deps.thread(project);
  const at = new Date(deps.now()).toISOString();
  if (typeof options.fixId === "string") {
    const fix = newestFix(await deps.events(threadId), project);
    if (fix?.fixId !== options.fixId) throw new Error(MESSAGE.NoSuchFix());
    const { fixId, kind, count } = fix;
    await deps.append(threadId, [
      fixRecord(project, { fixId, kind, count, autoPublish: options.autoPublish === true, at }),
    ]);
    return { fixId };
  }
  const { record } = await deps.status(project);
  const game = await deps.game(project);
  const rebuild = options.rebuild === true;
  const fix = rebuild
    ? rebuildFor(newestFix(await deps.events(threadId), project), record, game)
    : record && fixFor(record, game);
  if (!fix) throw new Error(rebuild ? MESSAGE.NothingToBuild() : MESSAGE.NothingToFix());
  const fixId = deps.id();
  // The press goes first, so the agent's turn on the brief comes after it in the chat.
  await deps.append(threadId, [fixRecord(project, { fixId, kind: fix.kind, count: fix.count, autoPublish: true, at })]);
  try {
    await deps.send(fix.text, { thread: threadId, from: MessageFrom.Genex });
  } catch (error) {
    // The agent never got the brief: no work will end, so the press ends here, stopped.
    await deps.append(threadId, [reviewRecord(outcome(project, GenexReviewChange.FixStopped, deps.now()))]);
    throw error;
  }
  return { fixId };
}

/** The platforms a request for a person asks about: the one named, else every turned-down app that allows one. */
function requestedPlatforms(record: GenexReviewRecord | null, platform: unknown): string[] {
  const apps = (record?.apps ?? []).filter((app) => app.humanReview.canRequest);
  const named = typeof platform === "string" ? apps.filter((app) => app.platform === platform) : apps;
  return [...new Set(named.map((app) => app.platform))];
}

/**
 * Request human review: the plugin asks Genex, with the apps a person may need sent again (each
 * platform's newest build, whatever its age), and the request is told once in the game's chat.
 */
export async function requestReviewFromDialog(
  deps: GenexReviewDeps,
  project: string,
  args: { platform?: unknown; arch?: unknown; note?: unknown },
): Promise<GenexReviewRequestAnswer> {
  const { record } = await deps.status(project);
  const platforms = record?.takedown ? [] : requestedPlatforms(record, args.platform);
  const native = (await Promise.all(platforms.map((force) => deps.apps(project, { force })))).flat();
  const answer = await deps.request(project, {
    ...(typeof args.platform === "string" ? { platform: args.platform } : {}),
    ...(typeof args.arch === "string" ? { arch: args.arch } : {}),
    ...(typeof args.note === "string" && args.note.trim() ? { note: args.note.trim() } : {}),
    ...(native.length > 0 ? { native } : {}),
  });
  if (answer.refused) return answer;
  await tellRequested(deps, project, answer);
  deps.refresh(project);
  return answer;
}

/** The request, told once: the record the plugin read after it is what the watch will not tell again. */
async function tellRequested(deps: GenexReviewDeps, project: string, answer: GenexReviewRequestAnswer): Promise<void> {
  const status = await deps.status(project);
  const game = await deps.game(project);
  const names = { project, title: game.title, ...(game.slug ? { slug: game.slug } : {}) };
  if (status.record)
    await deps.status(project, { told: reviewChanges(status.told, status.record, deps.now(), names).told });
  const app = status.record?.apps.find((one) => answer.requested.some((asked) => asked.platform === one.platform));
  const things = answer.takedown ? status.record?.takedown?.things : app?.things;
  const threadId = await deps.thread(project);
  const at = new Date(deps.now()).toISOString();
  await deps.append(threadId, [
    reviewRecord({
      ...names,
      change: GenexReviewChange.Requested,
      requested: true,
      ...(app ? { app: { platform: app.platform, arch: app.arch, version: app.version } } : {}),
      ...(things?.length ? { things, count: things.length } : {}),
      at,
    }),
  ]);
}

/**
 * Once the agent's work on the game's newest fix press ends: Studio's one step after it, unless the
 * person took it back or it already ran. Runs for every append to a game's chat; does nothing until
 * that work has ended. A fix whose step the person took back has nothing to run, but its game's line
 * stops saying Fixing: the window is told.
 */
export async function afterFixRunEnds(deps: GenexReviewDeps, project: string, threadId: string): Promise<void> {
  const events = await deps.events(threadId);
  const fix = newestFix(events, project);
  if (!fix || fix.outcome) return;
  const ended = fixWorkEnded(events, fix);
  if (!ended) return;
  if (!fix.autoPublish) {
    deps.changed(project);
    return;
  }
  await settleFix(deps, project, threadId, fix, ended);
}

/**
 * A fix press whose agent can no longer finish: Studio quit while it worked. Said once at the next
 * start, as a stop: nothing is published by itself after a restart. A game with no chat has no press.
 */
export async function settleInterruptedFix(deps: GenexReviewDeps, project: string): Promise<void> {
  const threadId = await deps.existingThread(project);
  if (!threadId) return;
  const fix = newestFix(await deps.events(threadId), project);
  if (!fix?.autoPublish || fix.outcome) return;
  await deps.append(threadId, [reviewRecord(outcome(project, GenexReviewChange.FixStopped, deps.now()))]);
}

/** Studio's step after a fix: send the app again (and ask a person for a takedown), or say why not. */
async function settleFix(
  deps: GenexReviewDeps,
  project: string,
  threadId: string,
  fix: GenexFixState,
  ended: FixEnd,
): Promise<void> {
  const say = (change: GenexReviewChange, extra: Partial<GenexReviewPayload> = {}) =>
    deps.append(threadId, [reviewRecord(outcome(project, change, deps.now(), extra))]);
  if (ended === FixEnd.Stopped) return say(GenexReviewChange.FixStopped);
  if (fix.kind === GenexFixKind.Web) return say(GenexReviewChange.FixedWeb);
  const native = await deps.apps(project, { builtAfter: Date.parse(fix.at) || 0 });
  if (native.length === 0) return say(GenexReviewChange.NotBuilt);
  // The outcome goes first: whatever the send does, this press never sends again by itself.
  await say(GenexReviewChange.Sent, { recheck: true });
  const game = await deps.game(project);
  if (game.web) await deps.resendApps(project, native);
  else await deps.publishApps(project);
  if (fix.kind === GenexFixKind.Takedown) await askToPutBack(deps, project, threadId);
  deps.refresh(project);
}

/** A fixed takedown of a game with apps: a person is asked to put it back, unless an old API needs a note first. */
async function askToPutBack(deps: GenexReviewDeps, project: string, threadId: string): Promise<void> {
  const { record } = await deps.status(project);
  const takedown = record?.takedown;
  if (!takedown?.humanReview.canRequest) return;
  if (takedown.noteMin) {
    await deps.append(threadId, [reviewRecord(outcome(project, GenexReviewChange.FixedWeb, deps.now()))]);
    return;
  }
  const answer = await deps.request(project, {});
  if (!answer.refused) await tellRequested(deps, project, answer);
}

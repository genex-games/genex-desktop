/**
 * The Publish card of a game made in an engine, as words and a plan (canvas "Publish to every
 * platform", round 4): one row per platform the person can do something about, each saying only
 * what is true now (a dot and a line), with a switch for whether players get it; and the one button,
 * whose words say what pressing it does. Pure: the dialog draws it, tests read it.
 */
import { sizeWords } from "../../../../shared/byte-size.ts";
import { HOUR_MS, MINUTE_MS } from "../../../../shared/duration.ts";
import {
  CloudBuildFailure,
  CloudBuildState,
  CloudSendState,
  GenexBuildReview,
  type GenexCloudBuild,
  type GenexNativeRecord,
  type GenexNativeSent,
} from "../../../../shared/genex.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { NATIVE_WORDS, PUBLISH_CARD_WORDS } from "../../../words.ts";
import {
  CLOUD_TARGETS,
  cloudErrors,
  currentSent,
  newestCloudBuild,
  RUNNING_CLOUD,
  WebOffer,
} from "./publish-platforms-view.ts";

const WORDS = PUBLISH_CARD_WORDS;

/** How close two times count as the same build: a game's files keep changing a little after a build starts. */
const SAME_BUILD_MS = MINUTE_MS;
/** How long a row says the agent builds an app it was asked for, when no new build lands: then it was not built. */
const ASK_HOLD_MS = 2 * HOUR_MS;

/** A row's dot: what is on Genex for that platform now. */
export const CardTone = {
  /** Players have it, and it is the game as it is now (or its age can't be told). */
  Live: "live",
  /** Players have it, but the game changed since. */
  Old: "old",
  /** Players don't have it. */
  None: "none",
  /** Something is happening to it now: a clock is at its end. */
  Working: "working",
  /** On Genex, waiting for Genex's review. */
  Review: "review",
  /** Its last send or build failed, or Genex turned it down. */
  Bad: "bad",
} as const;
export type CardTone = (typeof CardTone)[keyof typeof CardTone];

/** What the button does for a row. */
export const CardWork = {
  /** Send the build the folder holds. */
  Publish: "publish",
  /** Ask the agent to make it, or make it again, on this computer. */
  Build: "build",
  /** Have Genex Cloud build it from the game's project. */
  Cloud: "cloud",
  /** Take what players have off Genex. */
  TakeDown: "take-down",
} as const;
export type CardWork = (typeof CardWork)[keyof typeof CardWork];

/** One platform's row. */
export interface CardRow {
  target: PublishTarget;
  name: string;
  tone: CardTone;
  status: string;
  /** The row's end: when it went live, how big it is, or where the button builds it. */
  side: string | null;
  /** When the work the row shows began, for its clock. */
  since?: string;
  /** Genex Cloud is working on it now: the wait can be long. */
  cloud: boolean;
  /** The agent is building it on this computer now. */
  here: boolean;
  /** On Genex now (for players or for review): switching it off takes it down. */
  live: boolean;
  /** Where its switch starts. */
  on: boolean;
  /** What the button does for it while its switch is on; null when nothing needs doing. */
  work: CardWork | null;
}

/** What the card is read from. */
export interface CardInput {
  /** The game folder's platforms as the Genex plugin can send them (`gateByPlugin`). */
  platforms: readonly PublishPlatform[];
  /** How the last Publish's apps went, and Genex Cloud's builds. */
  native?: GenexNativeRecord | undefined;
  now: number;
  /** What a game with no web version is offered for one. */
  webOffer: WebOffer;
  /** The systems this computer makes the game's apps for (`appsMadeHere`); null: the agent makes any. */
  madeHere: ReadonlySet<PublishTarget> | null;
  /** Whether Genex's page plays a web version; absent while unknown. */
  hostedWeb?: boolean | undefined;
  /** When the web version last went out from here (`lastPublishAt`), to tell it from the game's last change. */
  webPublishedAt?: string | undefined;
  /** Apps the agent was asked to build from this card, by when it was asked. */
  asked?: ReadonlyMap<PublishTarget, string>;
  /** This computer is a Mac: the words say "this Mac", else "this PC". */
  mac: boolean;
}

/** The app players get of a platform, from the last sends and Genex Cloud's builds. */
interface Live {
  /** When it went live. */
  at: string;
  /** When it was built, as near as can be told: what "older than your game" is judged by. */
  builtAt: string;
  review?: GenexBuildReview;
}

const ms = (at: string | null | undefined): number => (at ? Date.parse(at) : Number.NaN);

/** The newest app the record says went to Genex for `row`'s platform. */
function newestSent(row: PublishPlatform, native: GenexNativeRecord | undefined): GenexNativeSent | undefined {
  const sent = (native?.sent ?? []).filter((one) => one.platform === row.target);
  return sent.reduce<GenexNativeSent | undefined>(
    (newest, one) => (!newest || ms(one.publishedAt) > ms(newest.publishedAt) ? one : newest),
    undefined,
  );
}

/** The newest build Genex Cloud finished and put on the game's page for `row`'s platform. */
function newestCloudDone(row: PublishPlatform, native: GenexNativeRecord | undefined): GenexCloudBuild | undefined {
  const done = (native?.cloud?.builds ?? []).filter(
    (build) => build.platform === row.target && build.state === CloudBuildState.Done,
  );
  return done.reduce<GenexCloudBuild | undefined>(
    (newest, build) => (!newest || ms(build.startedAt) > ms(newest.startedAt) ? build : newest),
    undefined,
  );
}

/** The app players get (or Genex reviews) of a native platform: whichever went last. */
function liveApp(row: PublishPlatform, native: GenexNativeRecord | undefined): Live | null {
  const sent = newestSent(row, native);
  const cloud = newestCloudDone(row, native);
  const cloudAt = cloud?.finishedAt ?? cloud?.startedAt;
  if (cloud && cloudAt && (!sent || ms(cloudAt) > ms(sent.publishedAt)))
    return { at: cloudAt, builtAt: cloud.startedAt };
  if (!sent) return null;
  // The build that went is this folder's when the record says it went after the folder's build was made.
  const builtAt = currentSent(row, native) && row.builtAt ? row.builtAt : sent.publishedAt;
  return { at: sent.publishedAt, builtAt, ...(sent.review ? { review: sent.review } : {}) };
}

/** Whether the app players have is older than the game: built before its last change, or a newer build waits. */
function isOlder(row: PublishPlatform, live: Live): boolean {
  const built = ms(live.builtAt);
  const changedSince = ms(row.changedAt) - built > SAME_BUILD_MS;
  const newerWaits = row.state === PublishPlatformState.Ready && ms(row.builtAt) - built > SAME_BUILD_MS;
  return changedSince || newerWaits;
}

/** Whether this computer can make `row`'s app (the agent builds it here). */
const makesHere = (row: PublishPlatform, input: CardInput): boolean =>
  input.madeHere === null || input.madeHere.has(row.target);

/** Whether Genex Cloud builds `row`'s app because this computer can't: an Unreal game's Windows app on a Mac. */
const cloudBuilds = (row: PublishPlatform, input: CardInput): boolean =>
  CLOUD_TARGETS.has(row.target) && input.native?.cloud?.supported === true && !makesHere(row, input);

/** What the button does to bring a platform's app up to the game: send, build here, or build on Genex Cloud. */
function updateWork(row: PublishPlatform, input: CardInput): { work: CardWork | null; side: string | null } {
  if (row.state === PublishPlatformState.Ready)
    return row.uploads ? { work: CardWork.Publish, side: sizeWords(row.bytes) } : { work: null, side: WORDS.soon };
  if (cloudBuilds(row, input)) return { work: CardWork.Cloud, side: WORDS.buildsCloud };
  if (makesHere(row, input)) return { work: CardWork.Build, side: WORDS.buildsHere(input.mac) };
  return { work: null, side: null };
}

/** What a row says, before its switch and work. */
type RowState = Pick<CardRow, "tone" | "status" | "side" | "since" | "cloud" | "here">;

/** The work under way for a native platform now, if any: Genex Cloud's, a send, or the agent's. */
function workingNow(row: PublishPlatform, input: CardInput): RowState | null {
  const { native } = input;
  const send = native?.cloud?.send;
  if (send?.platform === row.target && send.state === CloudSendState.Sending)
    return {
      tone: CardTone.Working,
      status: WORDS.sendingCloud,
      side: null,
      since: send.startedAt,
      cloud: true,
      here: false,
    };
  const build = newestCloudBuild(row, native);
  if (build && RUNNING_CLOUD.has(build.state))
    return {
      tone: CardTone.Working,
      status: WORDS.buildingCloud,
      side: null,
      since: build.startedAt,
      cloud: true,
      here: false,
    };
  if (native?.sending && row.uploads && !currentSent(row, native))
    return { tone: CardTone.Working, status: WORDS.sending, side: null, cloud: false, here: false };
  const asked = input.asked?.get(row.target);
  const landed = row.state === PublishPlatformState.Ready && ms(row.builtAt) > ms(asked);
  const waiting = asked !== undefined && input.now - ms(asked) < ASK_HOLD_MS;
  if (asked !== undefined && waiting && !landed)
    return {
      tone: CardTone.Working,
      status: WORDS.buildingHere(input.mac),
      side: null,
      since: asked,
      cloud: false,
      here: true,
    };
  return null;
}

/** Why a native platform's last try went wrong, if it did and nothing newer went: a refused send or a failed cloud build. */
function failedNow(row: PublishPlatform, input: CardInput, live: Live | null): RowState | null {
  const { native } = input;
  if (native?.failed.some((one) => one.platform === row.target) && !currentSent(row, native))
    return { tone: CardTone.Bad, status: WORDS.sendFailed, side: null, cloud: false, here: false };
  const build = newestCloudBuild(row, native);
  if (build?.state !== CloudBuildState.Failed || native?.cloud?.send?.platform === row.target) return null;
  if (live && ms(live.at) > ms(build.startedAt)) return null;
  return {
    tone: CardTone.Bad,
    status: live ? WORDS.buildFailedLive : WORDS.buildFailed,
    side: null,
    cloud: false,
    here: false,
  };
}

/** What Genex's review says of the app on Genex, when it holds it back. */
function reviewNow(live: Live | null): RowState | null {
  if (live?.review === GenexBuildReview.Pending)
    return { tone: CardTone.Review, status: WORDS.inReview, side: null, cloud: false, here: false };
  if (live?.review === GenexBuildReview.Rejected)
    return { tone: CardTone.Bad, status: WORDS.notApproved, side: null, cloud: false, here: false };
  return null;
}

/**
 * Whether building `row`'s app on Genex Cloud again can't help: the account's builds are used up, or
 * the game hasn't changed since the build failed (the same project fails the same way: the agent fixes
 * it first).
 */
function retryUseless(row: PublishPlatform, native: GenexNativeRecord | undefined): boolean {
  const build = newestCloudBuild(row, native);
  if (build?.state !== CloudBuildState.Failed) return false;
  if (build.failure === CloudBuildFailure.Quota) return true;
  return !(ms(row.changedAt) - ms(build.finishedAt ?? build.startedAt) > SAME_BUILD_MS);
}

/** A native platform's row, or null when nothing can be done about it from here. */
function nativeRow(row: PublishPlatform, input: CardInput, firstPublish: boolean): CardRow | null {
  const live = liveApp(row, input.native);
  const base = { target: row.target, name: WORDS.name[row.target], live: live !== null };
  const update = updateWork(row, input);
  const working = workingNow(row, input);
  if (working) return { ...base, ...working, on: true, work: null };
  const held = reviewNow(live);
  // A turned-down app goes again only as a newer build: the same one would be turned down again.
  const resend = held?.tone === CardTone.Bad && live && isOlder(row, live) ? update.work : null;
  if (held) return { ...base, ...held, on: true, work: resend };
  const failed = failedNow(row, input, live);
  if (failed) {
    // A send that didn't reach Genex is tried again from its error block, never by the main button.
    const blockRetries = failed.status === WORDS.sendFailed;
    const work = blockRetries || retryUseless(row, input.native) ? null : update.work;
    return { ...base, ...failed, on: true, work };
  }
  if (live && !isOlder(row, live))
    return {
      ...base,
      tone: CardTone.Live,
      status: WORDS.liveCurrent,
      side: WORDS.ago(live.at, input.now),
      cloud: false,
      here: false,
      on: true,
      work: null,
    };
  if (live)
    return {
      ...base,
      tone: CardTone.Old,
      status: WORDS.liveOlder,
      side: update.side,
      cloud: false,
      here: false,
      on: true,
      work: update.work,
    };
  if (!update.work) return null;
  const startsOn = row.state === PublishPlatformState.Ready || (firstPublish && update.work === CardWork.Cloud);
  return {
    ...base,
    tone: CardTone.None,
    status: WORDS.notPublished,
    side: update.side,
    cloud: false,
    here: false,
    on: startsOn,
    work: update.work,
  };
}

/** The web row: live on Genex's page, ready to send, or one the agent can make; null when the game can't have one. */
function webRow(row: PublishPlatform, input: CardInput): CardRow | null {
  const live = input.hostedWeb === true;
  const base = { target: row.target, name: WORDS.name[row.target], live, cloud: false, here: false };
  const ready = row.state === PublishPlatformState.Ready;
  if (live) {
    const at = input.webPublishedAt;
    const older = ready && (!at || ms(row.changedAt) - ms(at) > SAME_BUILD_MS);
    const side = at ? WORDS.ago(at, input.now) : null;
    return older
      ? { ...base, tone: CardTone.Old, status: WORDS.liveOlder, side: null, on: true, work: CardWork.Publish }
      : { ...base, tone: CardTone.Live, status: WORDS.liveCurrent, side, on: true, work: null };
  }
  if (ready)
    return { ...base, tone: CardTone.None, status: WORDS.notPublished, side: null, on: true, work: CardWork.Publish };
  if (input.webOffer !== WebOffer.Make) return null;
  const side = WORDS.buildsHere(input.mac);
  return { ...base, side, tone: CardTone.None, status: WORDS.notPublished, on: false, work: CardWork.Build };
}

/** The card's rows, in the folder's order, leaving out every platform nothing can be done about from here. */
export function cardRows(input: CardInput): CardRow[] {
  const anyLive = input.platforms.some((row) =>
    row.target === PublishTarget.Web ? input.hostedWeb === true : liveApp(row, input.native) !== null,
  );
  return input.platforms
    .map((row) => (row.target === PublishTarget.Web ? webRow(row, input) : nativeRow(row, input, !anyLive)))
    .filter((row): row is CardRow => row !== null);
}

/** One thing the button does. */
export interface PlanStep {
  target: PublishTarget;
  work: CardWork;
}

/** What the button does and says. */
export interface PressPlan {
  label: string;
  steps: PlanStep[];
  /** It only takes platforms down: the button warns. */
  warn: boolean;
}

/** Whether a row's switch is on: the person's choice, else where it starts. */
export const switchedOn = (row: CardRow, switches: ReadonlyMap<PublishTarget, boolean>): boolean =>
  switches.get(row.target) ?? row.on;

/** "Mac", "Mac and Windows", "Mac, Windows and web". */
const listed = (rows: readonly CardRow[]): string =>
  NATIVE_WORDS.platforms(rows.map((row) => WORDS.inPress[row.target]));

/** The words for the platforms that get something: named up to two, counted from three. */
function sendWords(updates: readonly CardRow[], news: readonly CardRow[]): string | null {
  const all = [...updates, ...news];
  if (all.length === 0) return null;
  const onlyUpdates = news.length === 0;
  if (all.length >= 3) return onlyUpdates ? WORDS.updateCount(all.length) : WORDS.publishToCount(all.length);
  return onlyUpdates ? WORDS.update(listed(all)) : WORDS.publishTo(listed(all));
}

/** The words for platforms that get something, with the ones taken down after them. */
function planLabel(updates: readonly CardRow[], news: readonly CardRow[], downs: readonly CardRow[]): string {
  const send = sendWords(updates, news);
  if (downs.length === 0) return send ?? "";
  if (!send) return WORDS.takeDown(listed(downs));
  return news.length === 0
    ? WORDS.updateAndTakeDown(listed(updates), listed(downs))
    : WORDS.publishAndTakeDown(listed([...updates, ...news]), listed(downs));
}

/** The button for apps the agent builds first: it builds them, and a second press publishes them. */
function buildPlan(builds: readonly CardRow[]): PressPlan {
  const label = builds.length >= 3 ? WORDS.buildCount(builds.length) : WORDS.build(listed(builds));
  return { label, steps: builds.map((row) => ({ target: row.target, work: CardWork.Build })), warn: false };
}

/**
 * What the button does for the rows as switched, or null when nothing needs doing. Apps the agent
 * builds come first and alone: building never sends anything to players, so a second press does.
 * Genex Cloud builds only for a game with a page on Genex (`onGenex`), or one a send of this press makes.
 */
export function pressPlan(
  rows: readonly CardRow[],
  switches: ReadonlyMap<PublishTarget, boolean>,
  onGenex = true,
): PressPlan | null {
  const ready = rows.filter((row) => row.tone !== CardTone.Working);
  const chosen = ready.filter((row) => switchedOn(row, switches) && row.work !== null);
  const builds = chosen.filter((row) => row.work === CardWork.Build);
  if (builds.length > 0) return buildPlan(builds);
  const makesPage = onGenex || chosen.some((row) => row.work === CardWork.Publish);
  const sending = chosen.filter((row) => row.work !== CardWork.Cloud || makesPage);
  const downs = ready.filter((row) => !switchedOn(row, switches) && row.live);
  if (sending.length === 0 && downs.length === 0) return null;
  const steps: PlanStep[] = [
    ...sending.map((row) => ({ target: row.target, work: row.work ?? CardWork.Publish })),
    ...downs.map((row) => ({ target: row.target, work: CardWork.TakeDown })),
  ];
  const updates = sending.filter((row) => row.live);
  const news = sending.filter((row) => !row.live);
  return { label: planLabel(updates, news, downs), steps, warn: sending.length === 0 };
}

/** The button while rows work: what it says, the clock of the longest wait, and whether Genex Cloud is in it. */
export interface BusyPress {
  label: string;
  since: string | null;
  cloud: boolean;
}

/** What the busy button says: building here, updating what players have, or publishing something new. */
function busyLabel(working: readonly CardRow[]): string {
  if (working.every((row) => row.here)) return WORDS.building(listed(working));
  return working.every((row) => row.live) ? WORDS.updating(listed(working)) : WORDS.publishing(listed(working));
}

/** The busy button for the rows at work now, or null when none is. */
export function busyPress(rows: readonly CardRow[]): BusyPress | null {
  const working = rows.filter((row) => row.tone === CardTone.Working);
  if (working.length === 0) return null;
  const label = busyLabel(working);
  const starts = working.map((row) => row.since).filter((at): at is string => at !== undefined);
  const since = starts.reduce<string | null>((first, at) => (first === null || ms(at) < ms(first) ? at : first), null);
  return { label, since, cloud: working.some((row) => row.cloud) };
}

/** What an error block is about: a build Genex Cloud couldn't make, or an app that didn't reach Genex. */
export const CardErrorKind = { Build: "build", Send: "send" } as const;
export type CardErrorKind = (typeof CardErrorKind)[keyof typeof CardErrorKind];

/** One error block: under the rows, above the link. Its text is never shown: it goes to the agent or the clipboard. */
export interface CardError {
  target: PublishTarget;
  kind: CardErrorKind;
  title: string;
  /** The whole error, as the log or the CLI said it. */
  text: string;
}

/**
 * The card's error blocks: a failed Genex Cloud build with its log, which the agent can fix, then each
 * app whose last send didn't reach Genex (and hasn't gone since), which a press tries again.
 */
export function cardErrors(platforms: readonly PublishPlatform[], native: GenexNativeRecord | undefined): CardError[] {
  const errors: CardError[] = [];
  const build = cloudErrors(platforms, native);
  if (build)
    errors.push({
      target: build.target,
      kind: CardErrorKind.Build,
      title: WORDS.buildError(WORDS.name[build.target]),
      text: build.errors.join("\n"),
    });
  for (const row of platforms) {
    const failed = native?.failed.find((one) => one.platform === row.target);
    if (!failed || currentSent(row, native)) continue;
    errors.push({
      target: row.target,
      kind: CardErrorKind.Send,
      title: WORDS.sendError(WORDS.name[row.target]),
      text: failed.error,
    });
  }
  return errors;
}

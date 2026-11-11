/**
 * The Publish card of a game made in an engine, as words and a plan (canvas "Publish to every
 * platform", round 3 of its redesign): one row per platform the person can do something about, each
 * saying only what is true now (a dot and a line) and ending in its own control: a button that builds
 * it, publishes it or tries again, the loader of the work under way, or the menu that takes it down.
 * And the one big button, which does everything. Pure: the dialog draws it, tests read it.
 *
 * A row's own Build only builds: players get nothing until its Publish, or the big button. The big
 * button builds what isn't built (on this computer one app after another, on Genex Cloud beside
 * them) and gives players each platform as soon as it is ready (`followStep`); a build that fails
 * stops only its own platform.
 */
import { sizeWords } from "../../../../shared/byte-size.ts";
import { HOUR_MS, MINUTE_MS } from "../../../../shared/duration.ts";
import {
  CloudBuildFailure,
  CloudBuildState,
  CloudSendState,
  GenexBuildReview,
  type GenexCloudBuild,
  GenexHostedStatus,
  type GenexNativeRecord,
  type GenexNativeSent,
  type GenexPublishState,
  type GenexSendProgress,
} from "../../../../shared/genex.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { NATIVE_WORDS, PUBLISH_CARD_WORDS } from "../../../words.ts";
import { publishView } from "./genex-publish-view.ts";
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
  /** Players don't have it, and no app of it is ready for them. */
  None: "none",
  /** Players don't have it: its app is built and waits for Publish. */
  Ready: "ready",
  /** Something is happening to it now: its loader stands in its button's place. */
  Working: "working",
  /** On Genex, waiting for Genex's review. */
  Review: "review",
  /** Its last send or build failed, or Genex turned it down. */
  Bad: "bad",
} as const;
export type CardTone = (typeof CardTone)[keyof typeof CardTone];

/** What a press does for a row. */
export const CardWork = {
  /** Send the build the folder holds. */
  Publish: "publish",
  /** Ask the agent to make it, or make it again, on this computer. */
  Build: "build",
  /** Have Genex Cloud build it from the game's project, and keep it. */
  Cloud: "cloud",
  /** Give players the app Genex Cloud built and keeps, or the one it still builds once it is built. */
  Release: "release",
  /** Take what players have off Genex. */
  TakeDown: "take-down",
} as const;
export type CardWork = (typeof CardWork)[keyof typeof CardWork];

/** A row's own button: what pressing it does, and its words. */
export interface RowAct {
  work: CardWork;
  label: string;
}

/** One platform's row. */
export interface CardRow {
  target: PublishTarget;
  name: string;
  tone: CardTone;
  status: string;
  /** The row's end note: when it went live, or how big what its button sends is. */
  side: string | null;
  /** When the work the row shows began, for its loader's clock. */
  since?: string;
  /** How far the send the row shows is; absent when nothing is being sent or the CLI says nothing of it. */
  progress?: GenexSendProgress;
  /** Genex Cloud is working on it now: the wait can be long. */
  cloud: boolean;
  /** The agent was asked to build it on this computer, and hasn't yet. */
  here: boolean;
  /** The work under way only makes the app: players get nothing when it ends. */
  making: boolean;
  /** It waits for another app's build on this computer: "Queued" stands in its button's place. */
  queued: boolean;
  /** On Genex now (for players or for review): its menu takes it down. */
  live: boolean;
  /** The loader's word while the row works ("Building", "Publishing"); null at rest. */
  busy: string | null;
  /** The row's own button; null while it works or waits, and when nothing can be done about it. */
  act: RowAct | null;
  /** What the big button does for it; null when nothing. */
  work: CardWork | null;
}

/** The web version on its way to Genex now: the dialog's own publish. */
export interface WebSend {
  /** What the attempt is doing, in the publish's own words ("Uploading", "Testing"); empty before it says. */
  status: string;
  /** When the attempt began; null when it hasn't said. */
  since: string | null;
  progress?: GenexSendProgress | undefined;
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
  /**
   * Whether Genex lists the game (`GenexHostedStatus.Published`); absent while unknown. Genex keeps
   * serving the build of a game taken back to a draft, on no page players reach.
   */
  listed?: boolean | undefined;
  /** When the web version last went out from here (`lastPublishAt`), to tell it from the game's last change. */
  webPublishedAt?: string | undefined;
  /** The web version is being published now; absent when it is not. */
  webSend?: WebSend | undefined;
  /** Apps the agent was asked to build from this card, by when it was asked. */
  asked?: ReadonlyMap<PublishTarget, string>;
  /** This computer is a Mac: the words say "Mac", else "PC". */
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

/** The app Genex Cloud built and keeps of `row`'s platform, whatever its age; null when it keeps none. */
function keptApp(row: PublishPlatform, native: GenexNativeRecord | undefined): GenexCloudBuild | null {
  const build = newestCloudBuild(row, native);
  return build?.state === CloudBuildState.Built ? build : null;
}

/** Whether the game changed after Genex Cloud started `build`: what it made is not the game as it is now. */
const builtBeforeChange = (row: PublishPlatform, build: GenexCloudBuild): boolean =>
  ms(row.changedAt) - ms(build.startedAt) > SAME_BUILD_MS;

/**
 * The app Genex Cloud built and keeps for a publish, when it is the game as it is now and newer than
 * the one players have. One built before the game's last change stays with Genex, as a build in the
 * folder that is older than the game stays there: its row builds it again.
 */
function keptBuild(
  row: PublishPlatform,
  native: GenexNativeRecord | undefined,
  live: Live | null,
): GenexCloudBuild | null {
  const build = keptApp(row, native);
  if (!build || builtBeforeChange(row, build)) return null;
  return live && ms(live.builtAt) >= ms(build.startedAt) ? null : build;
}

/** The works that give players an app that is already made. */
const SENDS: ReadonlySet<CardWork | null> = new Set([CardWork.Publish, CardWork.Release]);
/** The works that make an app, and give players nothing. */
const MAKES: ReadonlySet<CardWork | null> = new Set([CardWork.Build, CardWork.Cloud]);

/**
 * What brings a platform's app up to the game: send the build the folder holds or the one Genex
 * Cloud keeps (`side`: how big it is), else build it on Genex Cloud or here.
 */
function updateWork(
  row: PublishPlatform,
  input: CardInput,
  live: Live | null,
): { work: CardWork | null; side: string | null } {
  if (row.state === PublishPlatformState.Ready)
    return row.uploads ? { work: CardWork.Publish, side: sizeWords(row.bytes) } : { work: null, side: WORDS.soon };
  const kept = keptBuild(row, input.native, live);
  if (kept) return { work: CardWork.Release, side: kept.installedBytes ? sizeWords(kept.installedBytes) : null };
  if (cloudBuilds(row, input)) return { work: CardWork.Cloud, side: null };
  if (makesHere(row, input)) return { work: CardWork.Build, side: null };
  return { work: null, side: null };
}

/**
 * A row's own button for `work`: Build says where it builds ("Build on Mac", "Build on Genex Cloud"),
 * a send says Publish, or Update when players have an older one.
 */
function actFor(work: CardWork | null, live: boolean, input: CardInput): RowAct | null {
  if (work === null) return null;
  if (work === CardWork.Cloud) return { work, label: WORDS.buildOnCloud };
  if (work === CardWork.Build) return { work, label: WORDS.buildHere(input.mac) };
  return { work, label: live ? WORDS.update : WORDS.publish };
}

/** What a row says, before its button and what the big button does for it. */
type RowState = Pick<
  CardRow,
  "tone" | "status" | "side" | "since" | "progress" | "cloud" | "here" | "making" | "queued" | "busy"
>;

/** A row's state with its presses: its own button, and the big button's work. */
type RowPresses = RowState & Pick<CardRow, "act" | "work">;

/** The app a send's progress names (`mac-universal`, `windows-x64`) is `row`'s. */
const namesRow = (progress: GenexSendProgress | undefined, row: PublishPlatform): boolean =>
  progress?.target?.split("-")[0] === row.target;

/** A row at rest: nothing is under way for it. */
const AT_REST = { cloud: false, here: false, making: false, queued: false, busy: null } as const;

const progressOf = (progress: GenexSendProgress | undefined): Pick<CardRow, "progress"> =>
  progress ? { progress } : {};

/** How far the app being sent is, when it is `row`'s. */
const appProgress = (native: GenexNativeRecord, row: PublishPlatform): Pick<CardRow, "progress"> =>
  namesRow(native.progress, row) ? progressOf(native.progress) : {};

/** The loader's word of a send: an update of what players have, or something new. */
const sendWord = (live: boolean): string => (live ? WORDS.updating : WORDS.publishing);

/**
 * Whether the agent was asked for `row`'s build from this card and hasn't made it: no build newer
 * than the ask has landed, and the ask is not so old that it was never built.
 */
function askedStill(row: PublishPlatform, input: CardInput): boolean {
  const asked = input.asked?.get(row.target);
  if (asked === undefined) return false;
  // A build whose time can't be read counts as landed: the folder has one, and the ask is answered.
  const landed = row.state === PublishPlatformState.Ready && !(ms(row.builtAt) <= ms(asked));
  return !landed && input.now - ms(asked) < ASK_HOLD_MS;
}

/**
 * The builds the agent was asked for and hasn't made, in the order it makes them: by when each was
 * asked, then as the folder lists them. A computer builds one at a time, so the first is building
 * and each other waits for the one before it.
 */
function hereQueue(input: CardInput): PublishTarget[] {
  const waiting = input.platforms.filter((row) => askedStill(row, input));
  const askedAt = (row: PublishPlatform): number => ms(input.asked?.get(row.target));
  return waiting.sort((a, b) => askedAt(a) - askedAt(b)).map((row) => row.target);
}

/** The row of a build the agent was asked for: building on this computer, or waiting for the one before it. */
function askedRow(row: PublishPlatform, input: CardInput, queue: readonly PublishTarget[]): RowState | null {
  const turn = queue.indexOf(row.target);
  if (turn < 0) return null;
  const before = queue[turn - 1];
  if (before !== undefined)
    return {
      tone: CardTone.None,
      status: WORDS.buildsAfter(WORDS.name[before]),
      side: null,
      cloud: false,
      here: true,
      making: true,
      queued: true,
      busy: null,
    };
  const since = input.asked?.get(row.target);
  return {
    tone: CardTone.Working,
    status: WORDS.onThisComputer(input.mac),
    side: null,
    ...(since ? { since } : {}),
    cloud: false,
    here: true,
    making: true,
    queued: false,
    busy: WORDS.building,
  };
}

/** The work Genex Cloud or a send has under way for a native platform now, if any. */
function workingNow(row: PublishPlatform, input: CardInput, live: boolean): RowState | null {
  const { native } = input;
  const send = native?.cloud?.send;
  if (send?.platform === row.target && send.state === CloudSendState.Sending)
    return {
      tone: CardTone.Working,
      status: WORDS.sendingCloud,
      side: null,
      since: send.startedAt,
      ...progressOf(send.progress),
      ...AT_REST,
      cloud: true,
      // Only a build Genex keeps is just being made: any other goes to players once built.
      making: send.held === true && send.released !== true,
      busy: WORDS.building,
    };
  const build = newestCloudBuild(row, native);
  if (build && RUNNING_CLOUD.has(build.state))
    return {
      tone: CardTone.Working,
      status: WORDS.onCloud,
      side: null,
      since: build.startedAt,
      ...AT_REST,
      cloud: true,
      making: build.held === true,
      busy: WORDS.building,
    };
  if (native?.sending && row.uploads && !currentSent(row, native))
    return {
      tone: CardTone.Working,
      status: WORDS.sending,
      side: null,
      ...appProgress(native, row),
      ...AT_REST,
      busy: sendWord(live),
    };
  return null;
}

/** Whether the project Genex Cloud builds `row`'s app from never reached it, and none has gone since. */
const cloudSendFailed = (row: PublishPlatform, native: GenexNativeRecord | undefined): boolean =>
  native?.cloud?.send?.platform === row.target && native.cloud.send.state === CloudSendState.Failed;

/**
 * Whether building `row`'s app on Genex Cloud again by itself can't help: the account's builds are
 * used up, or the game hasn't changed since the build failed (the same project fails the same way:
 * the agent fixes it first). The big button leaves such a build alone; the row's own Try again is
 * the person's call, and is there unless the builds are used up.
 */
function retryUseless(row: PublishPlatform, native: GenexNativeRecord | undefined): boolean {
  const build = newestCloudBuild(row, native);
  if (build?.state !== CloudBuildState.Failed) return false;
  if (build.failure === CloudBuildFailure.Quota) return true;
  return !(ms(row.changedAt) - ms(build.finishedAt ?? build.startedAt) > SAME_BUILD_MS);
}

/** A row whose last try went wrong: what it says, and Try again for `again` when trying can help. */
function failedRow(status: string, again: CardWork | null, work: CardWork | null): RowPresses {
  const act = again === null ? null : { work: again, label: WORDS.tryAgain };
  return { tone: CardTone.Bad, status, side: null, ...AT_REST, act, work };
}

/**
 * Why a native platform's last try went wrong, if it did and nothing newer went: an app or a project
 * that didn't reach Genex (the row's Try again sends it again, never the big button), or a failed
 * cloud build.
 */
function failedNow(row: PublishPlatform, input: CardInput, live: Live | null): RowPresses | null {
  const { native } = input;
  if (native?.failed.some((one) => one.platform === row.target) && !currentSent(row, native))
    return failedRow(WORDS.sendFailed, CardWork.Publish, null);
  if (cloudSendFailed(row, native)) return failedRow(WORDS.sendFailed, CardWork.Cloud, null);
  const build = newestCloudBuild(row, native);
  if (build?.state !== CloudBuildState.Failed) return null;
  if (live && ms(live.at) > ms(build.startedAt)) return null;
  const again = build.failure === CloudBuildFailure.Quota ? null : updateWork(row, input, live).work;
  const work = retryUseless(row, native) ? null : again;
  return failedRow(live ? WORDS.buildFailedLive : WORDS.buildFailed, again, work);
}

/**
 * What Genex's review says of the app on Genex, when it holds it back. A turned-down app goes again
 * only as a newer build (the same one would be turned down again), and as a Publish: players never
 * had it.
 */
function reviewNow(row: PublishPlatform, input: CardInput, live: Live | null): RowPresses | null {
  if (live?.review === GenexBuildReview.Pending)
    return { tone: CardTone.Review, status: WORDS.inReview, side: null, ...AT_REST, act: null, work: null };
  if (live?.review !== GenexBuildReview.Rejected) return null;
  const work = isOlder(row, live) ? updateWork(row, input, live).work : null;
  return {
    tone: CardTone.Bad,
    status: WORDS.notApproved,
    side: null,
    ...AT_REST,
    act: actFor(work, false, input),
    work,
  };
}

/** The row of a platform players have: up to date, or older than the game with what brings it up. */
function liveRow(row: PublishPlatform, input: CardInput, live: Live): RowPresses {
  const update = updateWork(row, input, live);
  const older = isOlder(row, live) || update.work === CardWork.Release;
  if (!older)
    return {
      tone: CardTone.Live,
      status: WORDS.liveCurrent,
      side: WORDS.ago(live.at, input.now),
      ...AT_REST,
      act: null,
      work: null,
    };
  const status = SENDS.has(update.work) ? WORDS.liveUpdateReady : WORDS.liveOlder;
  const act = actFor(update.work, true, input);
  return { tone: CardTone.Old, status, side: update.side, ...AT_REST, act, work: update.work };
}

/** The row of a platform players don't have: its app is ready, was built before the game's last change, or isn't built. */
function unpublishedRow(row: PublishPlatform, input: CardInput): RowPresses | null {
  const update = updateWork(row, input, null);
  if (!update.work) return null;
  const act = actFor(update.work, false, input);
  if (SENDS.has(update.work))
    return {
      tone: CardTone.Ready,
      status: WORDS.readyToPublish,
      side: update.side,
      ...AT_REST,
      act,
      work: update.work,
    };
  const kept = keptApp(row, input.native);
  const older = row.state === PublishPlatformState.Stale || (kept !== null && builtBeforeChange(row, kept));
  const status = older ? WORDS.builtOlder : WORDS.notBuilt;
  return { tone: CardTone.None, status, side: null, ...AT_REST, act, work: update.work };
}

/** A native platform's row, or null when nothing can be done about it from here. */
function nativeRow(row: PublishPlatform, input: CardInput, queue: readonly PublishTarget[]): CardRow | null {
  const live = liveApp(row, input.native);
  const base = { target: row.target, name: WORDS.name[row.target], live: live !== null };
  const working = workingNow(row, input, live !== null) ?? askedRow(row, input, queue);
  // What Genex Cloud makes and keeps can be published while it is made: it goes to players once built.
  if (working)
    return { ...base, ...working, act: null, work: working.cloud && working.making ? CardWork.Release : null };
  const state = reviewNow(row, input, live) ?? failedNow(row, input, live);
  if (state) return { ...base, ...state };
  if (live) return { ...base, ...liveRow(row, input, live) };
  const unpublished = unpublishedRow(row, input);
  return unpublished ? { ...base, ...unpublished } : null;
}

/**
 * Whether the web version that went out at `publishedAt` is older than the game: the game changed
 * after it, or the web build in the game's folder was made after it (a build put there is new by
 * itself, with no source changed).
 */
function webOlder(row: PublishPlatform, publishedAt: string): boolean {
  const published = ms(publishedAt);
  return ms(row.changedAt) - published > SAME_BUILD_MS || ms(row.builtAt) - published > SAME_BUILD_MS;
}

/**
 * Whether players have the game's web version: Genex plays one on a page it lists. The build of a
 * game that is a draft again reaches nobody, so its row offers Publish as a first publish would.
 */
const webLive = (input: CardInput): boolean => input.hostedWeb === true && input.listed !== false;

/** The web row while the web version is on its way to Genex: the publish's own step, its clock and how far it is. */
function webSending(send: WebSend, live: boolean): RowState {
  return {
    tone: CardTone.Working,
    status: send.status || WORDS.sending,
    side: null,
    ...(send.since ? { since: send.since } : {}),
    ...progressOf(send.progress),
    ...AT_REST,
    busy: sendWord(live),
  };
}

/** The web row at rest: live on Genex's page, ready to send, or one the agent can make; null when the game can't have one. */
function webAtRest(row: PublishPlatform, input: CardInput, live: boolean): RowPresses | null {
  const ready = row.state === PublishPlatformState.Ready;
  const send = { act: actFor(CardWork.Publish, live, input), work: CardWork.Publish };
  if (live) {
    const at = input.webPublishedAt;
    if (ready && (!at || webOlder(row, at)))
      return { tone: CardTone.Old, status: WORDS.liveUpdateReady, side: null, ...AT_REST, ...send };
    const side = at ? WORDS.ago(at, input.now) : null;
    return { tone: CardTone.Live, status: WORDS.liveCurrent, side, ...AT_REST, act: null, work: null };
  }
  if (ready) return { tone: CardTone.Ready, status: WORDS.readyToPublish, side: null, ...AT_REST, ...send };
  if (input.webOffer !== WebOffer.Make) return null;
  const act = actFor(CardWork.Build, false, input);
  return { tone: CardTone.None, status: WORDS.notBuilt, side: null, ...AT_REST, act, work: CardWork.Build };
}

/** The web row: on its way to Genex, being built, or as it rests; null when the game can't have one. */
function webRow(row: PublishPlatform, input: CardInput, queue: readonly PublishTarget[]): CardRow | null {
  const live = webLive(input);
  const base = { target: row.target, name: WORDS.name[row.target], live };
  const working = input.webSend ? webSending(input.webSend, live) : askedRow(row, input, queue);
  if (working) return { ...base, ...working, act: null, work: null };
  const rest = webAtRest(row, input, live);
  return rest ? { ...base, ...rest } : null;
}

/** The card's rows, in the folder's order, leaving out every platform nothing can be done about from here. */
export function cardRows(input: CardInput): CardRow[] {
  const queue = hereQueue(input);
  return input.platforms
    .map((row) => (row.target === PublishTarget.Web ? webRow(row, input, queue) : nativeRow(row, input, queue)))
    .filter((row): row is CardRow => row !== null);
}

/** What the rows are read with besides the game's folder and its record: this computer, and what the card asked for. */
export type CardContext = Pick<CardInput, "now" | "webOffer" | "madeHere" | "asked" | "mac">;

/** The card's rows for a game's publish record (`state`) and its folder's platforms. */
export function recordRows(
  platforms: readonly PublishPlatform[],
  state: GenexPublishState,
  context: CardContext,
): CardRow[] {
  const view = publishView(state, context.now);
  const webSend = view.running ? { status: view.phase, since: view.startedAt, progress: view.progress } : undefined;
  return cardRows({
    ...context,
    platforms,
    native: state.native,
    hostedWeb: state.hostedWeb,
    ...(state.status ? { listed: state.status === GenexHostedStatus.Published } : {}),
    webPublishedAt: state.lastPublishAt,
    webSend,
  });
}

/** One thing a press does. */
export interface PlanStep {
  target: PublishTarget;
  work: CardWork;
}

/** What the big button does and says. */
export interface PressPlan {
  label: string;
  /** The one line under it: what it does now and what by itself later; null when it only sends what is ready. */
  note: string | null;
  /** What the press starts at once: the builds, and what is ready for players. */
  steps: PlanStep[];
  /** The platforms it then follows (`followStep`): each goes to players as soon as it is ready. */
  follow: PublishTarget[];
  /** Players have every platform it names: it updates them. */
  update: boolean;
}

/** Whether nothing is under way for a row: it neither works nor waits its turn. */
export const atRest = (row: CardRow): boolean => row.busy === null && !row.queued;

/** Whether a row's app is being made now, for nobody yet: a build a row's own button or the big one started. */
const beingMade = (row: CardRow): boolean => !atRest(row) && row.making;

/** "Mac", "Mac and Windows", "Web, Mac and Windows". */
const listed = (rows: readonly CardRow[]): string => NATIVE_WORDS.platforms(rows.map((row) => row.name));

/** The line for a press that must build first, when Genex Cloud builds one of the apps: the wait can be long. */
function slowBuildNote(builds: readonly CardRow[], slow: readonly CardRow[], another: boolean): string {
  const [only] = builds;
  if (builds.length === 1 && only)
    return another ? WORDS.buildOneTooSlow(only.name) : WORDS.buildOneFirstSlow(only.name);
  return another
    ? WORDS.buildTooSlow(listed(builds), listed(slow))
    : WORDS.buildFirstSlow(listed(builds), listed(slow));
}

/**
 * The line under the big button: what it gives players now (`sends`) and what once built, the apps
 * it builds (`builds`) and the ones being built already (`coming`), named in the rows' order (`later`
 * is both). None when all it does is send.
 */
function planNote(
  sends: readonly CardRow[],
  builds: readonly CardRow[],
  coming: readonly CardRow[],
  later: readonly CardRow[],
  update: boolean,
): string | null {
  if (later.length === 0) return null;
  if (sends.length > 0) {
    const words = update ? WORDS.updateNowAndLater : WORDS.publishNowAndLater;
    return words(listed(sends), listed(later), later.length);
  }
  if (builds.length === 0)
    return (update ? WORDS.updateOnceBuilt : WORDS.publishOnceBuilt)(listed(coming), coming.length);
  if (update) return WORDS.buildThenUpdate(listed(later), later.length);
  const slow = builds.filter((row) => row.work === CardWork.Cloud);
  if (slow.length === 0) return WORDS.buildThenPublish(listed(later), later.length);
  return slowBuildNote(builds, slow, coming.length > 0);
}

/**
 * Whether a game is there to play, so an app Genex Cloud still builds can be given to its players:
 * players have a platform already, or one goes to them now (`sends`). A game with nothing to play
 * can't be published.
 */
const playable = (rows: readonly CardRow[], sends: readonly CardRow[]): boolean =>
  sends.length > 0 || rows.some((row) => row.live);

const stepsOf = (rows: readonly CardRow[]): PlanStep[] =>
  rows.map((row) => ({ target: row.target, work: row.work ?? CardWork.Publish }));

/**
 * What the big button does for the rows as they are, or null when nothing needs doing. It builds
 * every app that isn't built, gives players what is ready, and follows the rest, the builds a row's
 * own button started too. A row whose last try failed is left to its own Try again.
 */
export function pressPlan(rows: readonly CardRow[]): PressPlan | null {
  const idle = rows.filter(atRest);
  const sends = idle.filter((row) => SENDS.has(row.work));
  const builds = idle.filter((row) => MAKES.has(row.work));
  const coming = rows.filter(beingMade);
  const named = rows.filter((row) => sends.includes(row) || builds.includes(row) || coming.includes(row));
  if (named.length === 0) return null;
  const update = named.every((row) => row.live);
  const released = playable(rows, sends) ? coming.filter((row) => row.work === CardWork.Release) : [];
  const later = named.filter((row) => !sends.includes(row));
  return {
    label: update ? WORDS.updateAll : WORDS.publishAll,
    note: planNote(sends, builds, coming, later, update),
    steps: stepsOf([...builds, ...sends, ...released]),
    follow: named.map((row) => row.target),
    update,
  };
}

/** A press's sends as the calls that make them. */
export interface SendCalls {
  /** The web publish, with the apps that go behind it; null when the web version doesn't go. */
  web: PublishTarget[] | null;
  /** The apps that go on their own, and the ones Genex Cloud made or makes (`release`); null when none does. */
  apps: { platforms: PublishTarget[]; release: PublishTarget[] } | null;
}

/**
 * The calls that give players what `steps` name: the web publish carries the apps that are ready
 * with it, and what Genex Cloud made goes with the apps, or on its own after a web publish.
 */
export function sendCalls(steps: readonly PlanStep[]): SendCalls {
  const of = (work: CardWork): PublishTarget[] => steps.filter((step) => step.work === work).map((step) => step.target);
  const published = of(CardWork.Publish);
  const ready = published.filter((target) => target !== PublishTarget.Web);
  const release = of(CardWork.Release);
  const web = published.includes(PublishTarget.Web);
  const alone = release.length > 0 || (!web && ready.length > 0);
  return { web: web ? ready : null, apps: alone ? { platforms: web ? [] : ready, release } : null };
}

/** What a followed press does next. */
export interface FollowStep {
  /** What goes to players now. */
  send: PlanStep[];
  /** The platforms still on their way; none ends the follow. */
  left: PublishTarget[];
}

/**
 * The next step of a big-button press that follows `targets`, from the rows as they are now: each
 * app that is ready goes to players, and one Genex Cloud still builds is promised to them once a
 * game is there to play. A platform is left while it is being built or sent, or is ready to go: one
 * that was just sent (`settling`) may still read as ready, since the record takes a moment to say it
 * is on its way, and is not sent again. It leaves the follow once players have it, or once nothing
 * more comes by itself (its build failed or never landed).
 */
export function followStep(
  rows: readonly CardRow[],
  targets: readonly PublishTarget[],
  settling: ReadonlySet<PublishTarget> = new Set(),
): FollowStep {
  const followed = rows.filter((row) => targets.includes(row.target));
  const fresh = followed.filter((row) => !settling.has(row.target));
  const sendable = (row: CardRow): boolean => atRest(row) && SENDS.has(row.work);
  const ready = fresh.filter(sendable);
  const promised = playable(rows, ready) ? fresh.filter((row) => !atRest(row) && row.work === CardWork.Release) : [];
  const waits = (row: CardRow): boolean => !atRest(row) || sendable(row);
  return { send: stepsOf([...ready, ...promised]), left: followed.filter(waits).map((row) => row.target) };
}

/** The big button while its press is followed: a status, never a press. */
export interface FollowBar {
  label: string;
  note: string;
}

/**
 * The status in the big button's place while its press is followed: how many of the card's platforms
 * players have as the game is now, and that each goes live by itself.
 */
export function followBar(rows: readonly CardRow[], update: boolean): FollowBar {
  const done = rows.filter((row) => row.tone === CardTone.Live).length;
  const label = update ? WORDS.updatingAll(done, rows.length) : WORDS.publishingAll(done, rows.length);
  return { label, note: WORDS.goesLiveWhenReady };
}

/** An hour, in the minutes a time left is said in. */
const MINUTES_PER_HOUR = HOUR_MS / MINUTE_MS;

/** How long a send has left, for its row's loader: "2m left", "1h 20m left"; to the minute, never less than one. */
export function leftWords(leftMs: number): string {
  const minutes = Math.max(1, Math.ceil(leftMs / MINUTE_MS));
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return hours === 0 ? WORDS.minutesLeft(minutes) : WORDS.hoursLeft(hours, minutes % MINUTES_PER_HOUR);
}

/**
 * What an error block is about: a build Genex Cloud couldn't make, a build that never started (the
 * game's project didn't reach Genex Cloud, or it refused it), or an app that didn't reach Genex.
 */
export const CardErrorKind = { Build: "build", Start: "start", Send: "send" } as const;
export type CardErrorKind = (typeof CardErrorKind)[keyof typeof CardErrorKind];

/** One error block: under the rows, above the link. Its text is never shown: it goes to the agent or the clipboard. */
export interface CardError {
  target: PublishTarget;
  kind: CardErrorKind;
  title: string;
  /** The whole error, as the log or the CLI said it. */
  text: string;
}

/** The block of a Genex Cloud build that never started, in the CLI's words when it said why. */
function startError(platforms: readonly PublishPlatform[], native: GenexNativeRecord | undefined): CardError[] {
  const row = platforms.find((one) => cloudSendFailed(one, native));
  if (!row) return [];
  const title = WORDS.startError(WORDS.name[row.target]);
  return [{ target: row.target, kind: CardErrorKind.Start, title, text: native?.cloud?.send?.error ?? "" }];
}

/**
 * The card's error blocks: a failed Genex Cloud build with its log, which the agent can fix, one that
 * never started, and each app whose last send didn't reach Genex (and hasn't gone since). Trying
 * again is the row's own button.
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
  errors.push(...startError(platforms, native));
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

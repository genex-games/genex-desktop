/**
 * The Publish dialog's platform rows as words (canvas board "Publish"): what each platform's build
 * is, how big, and what the row offers: "Make with agent" for an app not made (and for a Unity or
 * Godot game's web version), "Coming soon" while Studio's Genex CLI cannot send apps, and, for an app
 * Publish sends, whether it is being sent, is on Genex or was not sent. Pure: the dialog draws it,
 * tests read it.
 */
import { sizeWords } from "../../../../shared/byte-size.ts";
import {
  GenexBuildReview,
  GenexListingState,
  type GenexNativeRecord,
  type GenexNativeSent,
} from "../../../../shared/genex.ts";
import { CoreFact, type FactRef } from "../../../../shared/project-facts.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { NATIVE_WORDS, PUBLISH_PLATFORM_WORDS } from "../../../words.ts";

const WORDS = PUBLISH_PLATFORM_WORDS;

/** What a row offers at its end. Display only: never stored. */
export const PlatformEnd = {
  /** Nothing: the web row, or an app Publish sends. */
  None: "none",
  /** Built, but genex.games does not take it yet. */
  Soon: "soon",
  /** Not made: the agent can make it. */
  Make: "make",
  /** Built before the game's last change: the agent can build it again. */
  Rebuild: "rebuild",
  /** Publish is sending it now. */
  Sending: "sending",
  /** On Genex: this build is what desktop players get. */
  Sent: "sent",
  /** On Genex, waiting for Genex's review before players get it. */
  Review: "review",
  /** On Genex, but Genex turned it down: players never get it. */
  Rejected: "rejected",
  /** The last Publish could not send it. */
  Failed: "failed",
} as const;
export type PlatformEnd = (typeof PlatformEnd)[keyof typeof PlatformEnd];

/** What a game with no web version is offered for one. Display only: never stored. */
export const WebOffer = {
  /** The agent makes it: Unity's WebGL build, Godot's Web export. */
  Make: "make",
  /** It cannot have one: Unreal has no web export. */
  Unavailable: "unavailable",
  /** Nothing to offer: a web game, or one Genex does not know. */
  Quiet: "quiet",
} as const;
export type WebOffer = (typeof WebOffer)[keyof typeof WebOffer];

/** The engines whose games the agent can build for the web. */
const WEB_ENGINE_FACTS: ReadonlySet<string> = new Set([CoreFact.UnityProject, CoreFact.GodotProject]);

/** What a game with these facts is offered while it has no web version. */
export function webOfferFor(facts: readonly FactRef[]): WebOffer {
  if (facts.some((fact) => WEB_ENGINE_FACTS.has(fact.id))) return WebOffer.Make;
  return facts.some((fact) => fact.id === CoreFact.UnrealProject) ? WebOffer.Unavailable : WebOffer.Quiet;
}

/** The rows of each computer's own system, in `process.platform` spelling. */
const HOST_TARGET: Readonly<Record<string, PublishTarget>> = {
  darwin: PublishTarget.Mac,
  win32: PublishTarget.Windows,
  linux: PublishTarget.Linux,
};

/**
 * The only system a game's apps are made on here, or null when the agent makes any: an Unreal game
 * is packaged on the system it is for (Unreal makes no Mac app on Windows, nor a Windows or Linux one
 * on a Mac), so the other rows say where it is made instead of offering "Make with agent".
 */
export function appsMadeOnly(facts: readonly FactRef[], hostPlatform: string): PublishTarget | null {
  if (!facts.some((fact) => fact.id === CoreFact.UnrealProject)) return null;
  return HOST_TARGET[hostPlatform] ?? null;
}

/** One platform's row as the dialog draws it. */
export interface PlatformRow {
  target: PublishTarget;
  name: string;
  detail: string;
  /** The build's size; none for the web or a missing build. */
  size: string | null;
  state: PublishPlatform["state"];
  end: PlatformEnd;
}

type NativeTarget = Exclude<PublishTarget, typeof PublishTarget.Web>;

const isNative = (row: PublishPlatform): row is PublishPlatform & { target: NativeTarget } =>
  row.target !== PublishTarget.Web;

/** A native row's second line: what it runs on and when it was built, or why it is not ready. */
function nativeDetail(row: PublishPlatform & { target: NativeTarget }, now: number): string {
  if (row.state === PublishPlatformState.Missing) return WORDS.missing;
  if (row.state === PublishPlatformState.Stale) return WORDS.stale;
  const runsOn = row.arch ? WORDS.arch[row.target][row.arch] : "";
  const built = row.builtAt ? WORDS.built(row.builtAt, now) : "";
  return [runsOn, built].filter(Boolean).join(" · ");
}

/** Whether a record's entry is for `row`'s platform. */
const forRow = (row: PublishPlatform) => (entry: { platform: string }) => entry.platform === row.target;

/** Where a sent app stands with players: theirs, waiting for Genex's review, or turned down. */
const REVIEW_END: Record<GenexBuildReview, PlatformEnd> = {
  [GenexBuildReview.Pending]: PlatformEnd.Review,
  [GenexBuildReview.Approved]: PlatformEnd.Sent,
  [GenexBuildReview.Rejected]: PlatformEnd.Rejected,
};

/** Where an app Publish sends stands: being sent, on Genex (this build or a newer one), or not sent. */
function sendEnd(row: PublishPlatform, native: GenexNativeRecord | undefined): PlatformEnd {
  const sent = native?.sent.find(forRow(row));
  const builtAt = row.builtAt ? Date.parse(row.builtAt) : 0;
  if (sent && Date.parse(sent.publishedAt) >= builtAt) return sent.review ? REVIEW_END[sent.review] : PlatformEnd.Sent;
  if (native?.sending) return PlatformEnd.Sending;
  return native?.failed.some(forRow(row)) ? PlatformEnd.Failed : PlatformEnd.None;
}

/**
 * What a native row offers: making it while missing, building it again while it is older than the
 * game, "Coming soon" while it cannot go, else how its send stands.
 */
function nativeEnd(row: PublishPlatform, native: GenexNativeRecord | undefined): PlatformEnd {
  if (row.state === PublishPlatformState.Missing) return PlatformEnd.Make;
  if (row.state === PublishPlatformState.Stale) return PlatformEnd.Rebuild;
  return row.uploads ? sendEnd(row, native) : PlatformEnd.Soon;
}

/** The web row's second line and end: ready, or, with none, what the game is offered for one. */
function webWords(row: PublishPlatform, offer: WebOffer): { detail: string; end: PlatformEnd } {
  if (row.state === PublishPlatformState.Ready) return { detail: WORDS.webReady, end: PlatformEnd.None };
  if (offer === WebOffer.Make) return { detail: WORDS.missing, end: PlatformEnd.Make };
  const detail = offer === WebOffer.Unavailable ? WORDS.webUnavailable : WORDS.webMissing;
  return { detail, end: PlatformEnd.None };
}

/** Whether a native row is an app this computer can't make (`appsMadeOnly`) and has none ready to send. */
const madeElsewhere = (row: PublishPlatform, madeOnly: PublishTarget | null): boolean =>
  madeOnly !== null && row.target !== madeOnly && row.state !== PublishPlatformState.Ready;

/** A native row this computer can't make: where it is made while missing, else why it is old; no press. */
const elsewhereWords = (row: PublishPlatform & { target: NativeTarget }, now: number) => ({
  detail: row.state === PublishPlatformState.Missing ? WORDS.elsewhere[row.target] : nativeDetail(row, now),
  end: PlatformEnd.None,
});

/**
 * The rows in the order they come, each as words; `native` is how the last Publish's apps went,
 * `webOffer` what a game with no web version is offered for one, `madeOnly` the one system this
 * computer makes the game's apps for (`appsMadeOnly`).
 */
export function platformRows(
  platforms: readonly PublishPlatform[],
  now: number,
  native?: GenexNativeRecord,
  webOffer: WebOffer = WebOffer.Quiet,
  madeOnly: PublishTarget | null = null,
): PlatformRow[] {
  return platforms.map((row) => {
    if (!isNative(row))
      return {
        target: row.target,
        name: WORDS.name[row.target],
        ...webWords(row, webOffer),
        size: null,
        state: row.state,
      };
    const words = madeElsewhere(row, madeOnly)
      ? elsewhereWords(row, now)
      : { detail: nativeDetail(row, now), end: nativeEnd(row, native) };
    return {
      target: row.target,
      name: WORDS.name[row.target],
      ...words,
      size: row.bytes > 0 && row.state !== PublishPlatformState.Missing ? sizeWords(row.bytes) : null,
      state: row.state,
    };
  });
}

/**
 * Whether the dialog lists platforms: for a game made in an engine, which can be built as an app,
 * or one whose folder already holds an app. A web game with no app keeps the dialog as it was.
 */
export const listsPlatforms = (platforms: readonly PublishPlatform[], engineGame: boolean): boolean =>
  engineGame || platforms.some((row) => isNative(row) && row.state !== PublishPlatformState.Missing);

/** The players of the apps Publish sends: "Mac", "Windows", "Linux". */
const sendingPlayers = (platforms: readonly PublishPlatform[]): string[] =>
  platforms.filter((row) => isNative(row) && row.uploads).map((row) => playersOf(row.target));

/** Whether the game has only apps to publish: no web build, and an app Publish can send. */
export const onlyApps = (platforms: readonly PublishPlatform[]): boolean =>
  platforms.some((row) => row.target === PublishTarget.Web && row.state === PublishPlatformState.Missing) &&
  sendingPlayers(platforms).length > 0;

/** The facts of a project an engine builds apps from: Unity, Godot and Unreal games. */
const APP_ENGINE_FACTS: ReadonlySet<string> = new Set([
  CoreFact.UnityProject,
  CoreFact.GodotProject,
  CoreFact.UnrealProject,
]);

/** Whether a game is made in an engine that builds Mac, Windows and Linux apps (it gets Publish for them). */
export const makesApps = (facts: readonly FactRef[]): boolean => facts.some((fact) => APP_ENGINE_FACTS.has(fact.id));

/** The main press of a game with only apps: "Publish Mac app", "Publish Mac and Windows apps". */
export const appsLabel = (platforms: readonly PublishPlatform[]): string =>
  WORDS.publishApps(WORDS.apps(sendingPlayers(platforms)));

/**
 * How the listing of a game with only apps went, once its apps went: held for review, or not listed
 * at all; nothing when it was listed, while they go, or for a game listed by its web publish.
 */
export function listingLine(
  platforms: readonly PublishPlatform[],
  native: GenexNativeRecord | undefined,
): string | null {
  if (!onlyApps(platforms) || !native || native.sending || native.sent.length === 0) return null;
  if (native.listing?.state === GenexListingState.Held) return WORDS.held;
  // Apps Genex turned down are never listed: their own lines say why.
  if (native.listing || native.sent.every(turnedDown)) return null;
  return WORDS.notListed;
}

const turnedDown = (sent: GenexNativeSent): boolean => sent.review === GenexBuildReview.Rejected;

/**
 * Whether Publish has nothing new to send for a game with only apps: every app it would send is on
 * Genex already, built no later than it went. Its press would only send them again, so it is hidden.
 */
export function appsUpToDate(platforms: readonly PublishPlatform[], native: GenexNativeRecord | undefined): boolean {
  if (!onlyApps(platforms) || !native || native.sending) return false;
  return platforms.filter((row) => isNative(row) && row.uploads).every((row) => ON_GENEX.has(sendEnd(row, native)));
}

/** The ends of an app Genex has: sending it again would change nothing. */
const ON_GENEX: ReadonlySet<PlatformEnd> = new Set([PlatformEnd.Sent, PlatformEnd.Review]);

const waitsForReview = (sent: GenexNativeSent): boolean => sent.review === GenexBuildReview.Pending;

/**
 * Whether a game with only apps waits for Genex's review: every app its last Publish sent is still
 * reviewed, so players see none of it yet and the dialog sends it for review instead of celebrating.
 */
export function appsInReview(platforms: readonly PublishPlatform[], native: GenexNativeRecord | undefined): boolean {
  if (!onlyApps(platforms) || !native || native.sending || native.sent.length === 0) return false;
  return native.sent.every(waitsForReview);
}

/** Whether the game has no web build. */
const noWebBuild = (platforms: readonly PublishPlatform[]): boolean =>
  platforms.some((row) => row.target === PublishTarget.Web && row.state === PublishPlatformState.Missing);

/**
 * Whether Publish has nothing to send: a game made in an engine with no web build, and no app it can
 * send (none made yet, or none while Studio's Genex CLI cannot send apps). Its press then waits.
 */
export const nothingToPublish = (platforms: readonly PublishPlatform[]): boolean =>
  noWebBuild(platforms) && sendingPlayers(platforms).length === 0;

/**
 * Why a game with nothing to send waits: an app older than the game, a Genex plugin from before
 * apps, apps Studio cannot send yet, or nothing made yet (a web version too, when the agent can make one).
 */
function waitingLine(platforms: readonly PublishPlatform[], behind: boolean, webOffer: WebOffer): string {
  const stale = platforms.filter((row) => isNative(row) && row.state === PublishPlatformState.Stale);
  if (stale.length > 0) return WORDS.rebuildFirst(WORDS.apps(stale.map((row) => playersOf(row.target))));
  if (behind) return WORDS.updateGenex;
  const built = platforms.some((row) => isNative(row) && row.state !== PublishPlatformState.Missing);
  if (built) return WORDS.appsSoon;
  return webOffer === WebOffer.Make ? WORDS.makeAnyFirst : WORDS.makeFirst;
}

/**
 * The line under the rows: the apps Publish sends too, and whose players get the web version; for a
 * game with nothing to send, why. `behind`: the Genex plugin is too old to send its apps; `webOffer`:
 * what the game is offered for a web version.
 */
export function reachLine(
  platforms: readonly PublishPlatform[],
  behind = false,
  webOffer: WebOffer = WebOffer.Quiet,
): string | null {
  const web = platforms.find((row) => row.target === PublishTarget.Web);
  if (onlyApps(platforms)) return WORDS.onlyPlayers(NATIVE_WORDS.platforms(sendingPlayers(platforms)));
  if (nothingToPublish(platforms)) return waitingLine(platforms, behind, webOffer);
  if (web?.state !== PublishPlatformState.Ready) return null;
  const native = platforms.filter(isNative);
  const sending = sendingPlayers(platforms);
  const webOnly = native.filter((row) => !row.uploads).map((row) => playersOf(row.target));
  const lines = [
    sending.length > 0 ? WORDS.alsoSends(WORDS.apps(sending)) : null,
    webOnly.length > 0 ? WORDS.reach(NATIVE_WORDS.platforms(webOnly)) : null,
  ].filter((line): line is string => line !== null);
  return lines.length > 0 ? lines.join(" ") : null;
}

/** A line for each app the last Publish could not send, in the CLI's words. */
export function failureLines(platforms: readonly PublishPlatform[], native: GenexNativeRecord | undefined): string[] {
  return platforms.filter((row) => isNative(row) && row.uploads).flatMap((row) => failureLine(row, native));
}

/** A sent app's line when it did not reach players: not sent and why, or turned down by Genex and why. */
function failureLine(row: PublishPlatform, native: GenexNativeRecord | undefined): string[] {
  const end = sendEnd(row, native);
  const name = WORDS.name[row.target];
  if (end === PlatformEnd.Failed) return [WORDS.failedLine(name, native?.failed.find(forRow(row))?.error ?? "")];
  if (end !== PlatformEnd.Rejected) return [];
  const reason = native?.sent.find(forRow(row))?.reviewReason;
  return [reason ? WORDS.rejectedLine(name, reason) : WORDS.rejected(name)];
}

/** The players a native row is for: "Mac", "Windows", "Linux". */
const playersOf = (target: PublishTarget): string => (target === PublishTarget.Web ? "" : WORDS.players[target]);

/** What "Make with agent" sends through the game's chat for a platform. */
export const makeAppAsk = (target: PublishTarget, title: string): string => WORDS.makeAsk(playersOf(target), title);

/** What "Make with agent" sends through the game's chat for the web version. */
export const makeWebAsk = (title: string): string => WORDS.makeWebAsk(title);

/** What "Build again" sends through the game's chat for a platform. */
export const rebuildAsk = (target: PublishTarget, title: string): string => WORDS.rebuildAsk(playersOf(target), title);

/**
 * The rows as the installed Genex plugin can send them: an app goes only through a plugin whose
 * record says it can (`native.supported`), and a plugin from before apps answers no record. `behind`
 * when Studio could send an app that the plugin cannot: updating the plugin is what is missing.
 */
export function gateByPlugin(
  platforms: readonly PublishPlatform[],
  native: GenexNativeRecord | undefined,
): { platforms: PublishPlatform[]; behind: boolean } {
  if (native?.supported === true) return { platforms: [...platforms], behind: false };
  const behind = platforms.some((row) => isNative(row) && row.uploads);
  return { platforms: platforms.map((row) => (isNative(row) ? { ...row, uploads: false } : row)), behind };
}

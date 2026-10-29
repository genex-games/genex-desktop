/**
 * The Publish dialog's platform rows as words (canvas board "Publish"): what each platform's build
 * is, how big, and what the row offers: "Make with agent" for an app not made (and for a Unity or
 * Godot game's web version), "Coming soon" while Studio's Genex CLI cannot send apps, and, for an app
 * Publish sends, whether it is being sent, is on Genex or was not sent. Pure: the dialog draws it,
 * tests read it.
 */
import { sizeWords } from "../../../../shared/byte-size.ts";
import { GenexListingState, type GenexNativeRecord } from "../../../../shared/genex.ts";
import { CoreFact, type FactRef } from "../../../../shared/project-facts.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { PLAY_NATIVE_WORDS, PUBLISH_PLATFORM_WORDS } from "../../../words.ts";

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

/** Where an app Publish sends stands: being sent, on Genex (this build or a newer one), or not sent. */
function sendEnd(row: PublishPlatform, native: GenexNativeRecord | undefined): PlatformEnd {
  const sent = native?.sent.find(forRow(row));
  const builtAt = row.builtAt ? Date.parse(row.builtAt) : 0;
  if (sent && Date.parse(sent.publishedAt) >= builtAt) return PlatformEnd.Sent;
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

/**
 * The rows in the order they come, each as words; `native` is how the last Publish's apps went,
 * `webOffer` what a game with no web version is offered for one.
 */
export function platformRows(
  platforms: readonly PublishPlatform[],
  now: number,
  native?: GenexNativeRecord,
  webOffer: WebOffer = WebOffer.Quiet,
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
    return {
      target: row.target,
      name: WORDS.name[row.target],
      detail: nativeDetail(row, now),
      size: row.bytes > 0 && row.state !== PublishPlatformState.Missing ? sizeWords(row.bytes) : null,
      state: row.state,
      end: nativeEnd(row, native),
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
  return native.listing ? null : WORDS.notListed;
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
  if (onlyApps(platforms)) return WORDS.onlyPlayers(PLAY_NATIVE_WORDS.platforms(sendingPlayers(platforms)));
  if (nothingToPublish(platforms)) return waitingLine(platforms, behind, webOffer);
  if (web?.state !== PublishPlatformState.Ready) return null;
  const native = platforms.filter(isNative);
  const sending = sendingPlayers(platforms);
  const webOnly = native.filter((row) => !row.uploads).map((row) => playersOf(row.target));
  const lines = [
    sending.length > 0 ? WORDS.alsoSends(WORDS.apps(sending)) : null,
    webOnly.length > 0 ? WORDS.reach(PLAY_NATIVE_WORDS.platforms(webOnly)) : null,
  ].filter((line): line is string => line !== null);
  return lines.length > 0 ? lines.join(" ") : null;
}

/** A line for each app the last Publish could not send, in the CLI's words. */
export function failureLines(platforms: readonly PublishPlatform[], native: GenexNativeRecord | undefined): string[] {
  return platforms
    .filter((row) => isNative(row) && row.uploads && sendEnd(row, native) === PlatformEnd.Failed)
    .map((row) => {
      const error = native?.failed.find(forRow(row))?.error ?? "";
      return WORDS.failedLine(WORDS.name[row.target], error);
    });
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

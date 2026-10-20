/**
 * What Play draws for a native game, worked out from the catalog, this computer's installs and the
 * games being played: the game page's one primary block (install, installing, play, playing,
 * update, elsewhere, failed) and the badge on its card. Pure, so it is tested without a window.
 */
import { MINUTE_MS } from "../../shared/duration.ts";
import type { PlayGame } from "../../shared/play.ts";
import {
  buildFor,
  hasWebBuild,
  type InstalledGame,
  type InstallFailure,
  InstallPhase,
  type InstallProgress,
  installUnderWay,
  type LaunchFailure,
  type NativeBuild,
  type NativeInstalls,
  type NativePlatform,
  type NativeSession,
  NativeSessionPhase,
  platformsOf,
} from "../../shared/play-native.ts";

/** Where a native game stands on this computer, as its page's primary block says. */
export const GamePhase = {
  Install: "install",
  Installing: "installing",
  Ready: "ready",
  Playing: "playing",
  Update: "update",
  /** No build for this computer: the page says where it plays instead. */
  Elsewhere: "elsewhere",
  Failed: "failed",
} as const;
export type GamePhase = (typeof GamePhase)[keyof typeof GamePhase];

/** Why the last try failed: an install's or a launch's reason. */
export type GameFailure = { install: InstallFailure } | { launch: LaunchFailure };

/** A native game on this computer, for its page. */
export interface GameStanding {
  phase: GamePhase;
  /** The build this computer installs, or null. */
  build: NativeBuild | null;
  installed: InstalledGame | null;
  /** The install under way (or failed), or null. */
  progress: InstallProgress | null;
  /** Its session being played (or failed to start), or null. */
  session: NativeSession | null;
  failure: GameFailure | null;
}

/** Whether an install is still going. */
export const installing = (progress: InstallProgress | null | undefined): progress is InstallProgress =>
  installUnderWay(progress ?? undefined);

/** Whether a session is starting or being played. */
const live = (session: NativeSession | null): boolean =>
  session !== null && session.phase !== NativeSessionPhase.Failed;

/** The failure to show, if the last install or launch failed: the newer one when both did. */
function failureOf(progress: InstallProgress | null, session: NativeSession | null): GameFailure | null {
  if (session?.phase === NativeSessionPhase.Failed && session.failure) return { launch: session.failure };
  if (progress?.phase === InstallPhase.Failed && progress.failure) return { install: progress.failure };
  return null;
}

/** The phase that follows from what is installed and what this computer is offered. */
function restingPhase(build: NativeBuild | null, installed: InstalledGame | null): GamePhase {
  if (!installed) return build ? GamePhase.Install : GamePhase.Elsewhere;
  return build && build.version !== installed.version ? GamePhase.Update : GamePhase.Ready;
}

/** Where `game` stands on this computer: what its page's primary block shows. */
export function gameStanding(
  game: Pick<PlayGame, "slug" | "native">,
  installs: NativeInstalls,
  sessions: readonly NativeSession[],
): GameStanding {
  const build = installs.host ? buildFor(game.native?.builds ?? [], installs.host) : null;
  const installed = installs.installed.find((one) => one.slug === game.slug) ?? null;
  const progress = installs.progress.find((one) => one.slug === game.slug) ?? null;
  const session = sessions.find((one) => one.slug === game.slug) ?? null;
  const failure = failureOf(progress, session);
  const standing = { build, installed, progress, session, failure };
  if (live(session)) return { ...standing, phase: GamePhase.Playing };
  if (installing(progress)) return { ...standing, phase: GamePhase.Installing };
  if (failure) return { ...standing, phase: GamePhase.Failed };
  return { ...standing, phase: restingPhase(build, installed) };
}

/** How far an install has come, in whole percent. */
export const installPercent = (progress: InstallProgress): number =>
  progress.totalBytes > 0 ? Math.min(100, Math.floor((progress.receivedBytes / progress.totalBytes) * 100)) : 0;

/** What a card shows over its cover's corner for a native game. */
export const CardBadge = {
  /** Not installed: which systems it was built for. */
  Platforms: "platforms",
  Downloading: "downloading",
  Installed: "installed",
  Update: "update",
} as const;
export type CardBadge = (typeof CardBadge)[keyof typeof CardBadge];

/** A card's badge and what it says. */
export type CardBadgeState =
  | { kind: typeof CardBadge.Platforms; platforms: NativePlatform[] }
  | { kind: typeof CardBadge.Downloading; percent: number; etaMs: number | null }
  | { kind: typeof CardBadge.Installed }
  | { kind: typeof CardBadge.Update; bytes: number };

/**
 * The badge a card shows, or null: a game with a web build shows nothing new (its card plays the web
 * build), unless it is installed or installing here.
 */
export function cardBadge(game: Pick<PlayGame, "slug" | "native">, installs: NativeInstalls): CardBadgeState | null {
  if (!game.native) return null;
  const progress = installs.progress.find((one) => one.slug === game.slug);
  if (installing(progress))
    return { kind: CardBadge.Downloading, percent: installPercent(progress), etaMs: progress.etaMs };
  const installed = installs.installed.find((one) => one.slug === game.slug);
  const build = installs.host ? buildFor(game.native.builds, installs.host) : null;
  if (installed && build && build.version !== installed.version)
    return { kind: CardBadge.Update, bytes: build.sizeBytes };
  if (installed) return { kind: CardBadge.Installed };
  if (hasWebBuild(game)) return null;
  return { kind: CardBadge.Platforms, platforms: platformsOf(game) };
}

/** Whether pressing `game`'s card opens its page rather than the viewer: it has no web build. */
export const opensPage = (game: Pick<PlayGame, "native">): boolean => !hasWebBuild(game);

/** Whole minutes since `startedAt` at `now`. */
export const minutesSince = (startedAt: string, now: number): number =>
  Math.max(0, Math.floor((now - Date.parse(startedAt)) / MINUTE_MS));

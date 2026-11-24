/**
 * An app build's install, as the app tells genex.games a moment at a time (`InstallReport` to
 * `PlayRoute.NativeInstall`): only the app installs and opens app builds, so nothing else can count
 * them for a creator's Installs report. A report names the game, the moment, this computer's system
 * family (`OsFamily`), the build's version, and with its moment how long the download took, why the
 * page could offer no build (`InstallBlock`) or how the install failed (`InstallFailure`): never a
 * path, a file, a title, an address or anything else about the computer. It goes from main, never a
 * page (genex.games refuses one with an Origin), the way the play report does (`native-plays.ts`): as
 * the signed-in account, or with this computer's random id while there is none.
 * Best effort: reports go one after another, apart from the install, the launch or the removal they
 * tell of, which never wait for them; a refusal or an outage drops the report; a 404 (genex.games
 * does not take them yet) drops every report for {@link NOT_SERVED_PAUSE_MS}. A fixture or smoke
 * launch sends nothing. Electron-free: the call, the token, the id and the clock are deps.
 */
import { HOUR_MS, MINUTE_MS } from "../../shared/duration.ts";
import { InstallBlock, InstallMoment, type InstallReport, OsFamily } from "../../shared/game-analytics.ts";
import { isPlaySlug } from "../../shared/play.ts";
import {
  buildFor,
  type InstallFailure,
  NativeArch,
  type NativeBuild,
  type NativeHost,
  type NativeInstalls,
  NativePlatform,
  WhyNotHere,
  whyNotHere,
} from "../../shared/play-native.ts";
import { PlayRoute } from "./gallery.ts";
import { type LauncherReportDeps, launcherSender } from "./native-plays.ts";

/** How long no report is sent once genex.games answers that it does not take them (404). */
export const NOT_SERVED_PAUSE_MS = HOUR_MS;
const HTTP_NOT_FOUND = 404;

/** The moments the installer and the launcher tell; a game's page on screen tells Offered and Blocked (`pageRead`). */
type ToldMoment = Exclude<InstallMoment, typeof InstallMoment.Offered | typeof InstallMoment.Blocked>;

/** One moment as the installer or the launcher tells it: the report without what the reporter adds. */
export type InstallNews =
  | {
      slug: string;
      moment: Exclude<ToldMoment, typeof InstallMoment.Downloaded | typeof InstallMoment.Failed>;
      version: string | null;
    }
  | { slug: string; moment: typeof InstallMoment.Downloaded; version: string | null; seconds: number }
  | { slug: string; moment: typeof InstallMoment.Failed; version: string | null; failure: InstallFailure };

/** What reporting takes: how a report is sent (`launcherSender`), this computer and the clock. */
export interface InstallReportDeps extends LauncherReportDeps {
  /** This computer: its system family, and what a game's page offers it. */
  host: NativeHost;
  now(): number;
  log(line: string): void;
  /** A fixture or smoke launch: nothing is sent. */
  silent?: boolean;
}

/** Reports an app build's install moments; nothing it does throws or waits on genex.games for its caller. */
export interface InstallReports {
  /** Tell genex.games one moment; resolves once it was answered or dropped, never rejects. */
  tell(news: InstallNews): Promise<void>;
  /**
   * A game's page was read while the window shows it: Offered when it shows Install, Blocked when the
   * game's app builds offer this computer none. Nothing for a game with no app build, or one installed
   * or installing here (`here`, what this computer holds; null where it installs nothing). Once per
   * game per start of Genex.
   */
  pageRead(
    slug: string,
    builds: readonly NativeBuild[],
    here: Pick<NativeInstalls, "installed" | "progress"> | null,
  ): Promise<void>;
}

/** The system family genex.games counts `host` under. */
export function osFamilyOf(host: Pick<NativeHost, "platform" | "arch">): OsFamily {
  if (host.platform === NativePlatform.Windows) return OsFamily.Windows;
  if (host.platform === NativePlatform.Linux) return OsFamily.Linux;
  return host.arch === NativeArch.Arm64 ? OsFamily.MacArm : OsFamily.MacIntel;
}

/** Whether `host` is a Linux computer with an Arm processor. */
const armLinux = (host: Pick<NativeHost, "platform" | "arch">): boolean =>
  host.platform === NativePlatform.Linux && host.arch === NativeArch.Arm64;

/**
 * Why a game's page offers `host` no build (`whyNotHere`), folded into the blocks genex.games counts:
 * a system too old, an Intel Mac given Apple silicon builds, an Arm Linux computer given other
 * processors' builds, and anything else.
 */
export function installBlockOf(why: WhyNotHere, host: Pick<NativeHost, "platform" | "arch">): InstallBlock {
  if (why === WhyNotHere.OldSystem) return InstallBlock.OldSystem;
  if (why === WhyNotHere.AppleSilicon) return InstallBlock.MacIntel;
  if (why === WhyNotHere.Processor && armLinux(host)) return InstallBlock.LinuxArm;
  return InstallBlock.Other;
}

/** A download's time as whole seconds, or null when it is no time at all. */
const wholeSeconds = (seconds: number): number | null =>
  Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : null;

/** The report of `news` from a computer of `os`: every field there, those its moment has no use for null. */
function reportOf(news: InstallNews, os: OsFamily): InstallReport {
  const { slug, moment } = news;
  return {
    slug,
    moment,
    os,
    version: news.version || null,
    seconds: news.moment === InstallMoment.Downloaded ? wholeSeconds(news.seconds) : null,
    block: null,
    failure: news.moment === InstallMoment.Failed ? news.failure : null,
  };
}

/** Whether `here` holds `slug`, installed or installing: its page then shows no Install. */
const heldHere = (slug: string, here: Pick<NativeInstalls, "installed" | "progress"> | null): boolean =>
  here !== null && [...here.installed, ...here.progress].some((one) => one.slug === slug);

/**
 * What a game's page with `builds` shows `host`: Offered with the build it installs, Blocked with why
 * not, or nothing for a game with no app build.
 */
function pageReport(slug: string, builds: readonly NativeBuild[], host: NativeHost): InstallReport | null {
  if (builds.length === 0) return null;
  const page = { slug, os: osFamilyOf(host), seconds: null, failure: null };
  const build = buildFor(builds, host);
  if (build) return { ...page, moment: InstallMoment.Offered, version: build.version || null, block: null };
  const notHere = whyNotHere(builds, host);
  if (!notHere) return null;
  return { ...page, moment: InstallMoment.Blocked, version: null, block: installBlockOf(notHere.why, host) };
}

/** The reporter over `deps`: one report after another, each answered or dropped before the next goes. */
export function installReports(deps: InstallReportDeps): InstallReports {
  const send = launcherSender(deps);
  const os = osFamilyOf(deps.host);
  /** Games whose page told Offered or Blocked in this start of Genex. */
  const paged = new Set<string>();
  let pausedUntil = Number.NEGATIVE_INFINITY;
  let line: Promise<void> = Promise.resolve();

  const deliver = async (report: InstallReport): Promise<void> => {
    try {
      if (deps.now() < pausedUntil) return;
      const status = await send(PlayRoute.NativeInstall, { ...report });
      if (status !== HTTP_NOT_FOUND) return;
      pausedUntil = deps.now() + NOT_SERVED_PAUSE_MS;
      deps.log(`install reports paused for ${NOT_SERVED_PAUSE_MS / MINUTE_MS} min: genex.games does not take them yet`);
    } catch {
      // Dropped: an outage, an id that could not be read, a log that failed. Never the caller's.
    }
  };

  const queue = (report: InstallReport): Promise<void> => {
    if (deps.silent) return Promise.resolve();
    line = line.then(() => deliver(report));
    return line;
  };

  return {
    tell: (news) => (isPlaySlug(news.slug) ? queue(reportOf(news, os)) : Promise.resolve()),
    pageRead: (slug, builds, here) => {
      if (!isPlaySlug(slug) || paged.has(slug)) return Promise.resolve();
      const report = heldHere(slug, here) ? null : pageReport(slug, builds, deps.host);
      if (!report) return Promise.resolve();
      paged.add(slug);
      return queue(report);
    },
  };
}

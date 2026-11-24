/**
 * The two parts every answer about a game's analytics opens with: the game it is about and the
 * period it covers. Both must echo what was asked, so an answer about another game or another
 * period is not an answer.
 */
import type { AnalyticsGame, AnalyticsWindow } from "../../../shared/game-analytics.ts";
import type { StatsPeriod } from "../../../shared/play-stats.ts";
import { imageUrl, isRecord } from "../gallery.ts";
import { count, isoDay, isoTime, line } from "./kit.ts";

/** genex.games' own limit on a game's title, and the longest a version may read. */
const TITLE_MAX = 200;
const VERSION_MAX = 40;

/**
 * The game an answer is about, or null when it is not the game `slug`, has no title to show, or
 * no count of who plays it now (the header would show a made-up zero as a fact). What only
 * decorates it (a cover off Genex's hosts, a version that is not text) reads as absent.
 */
export function toAnalyticsGame(value: unknown, slug: string, local = false): AnalyticsGame | null {
  if (!isRecord(value) || value.slug !== slug) return null;
  const title = line(value.title, TITLE_MAX);
  const playingNow = count(value.playingNow);
  if (!title || playingNow === undefined) return null;
  return {
    slug,
    title,
    coverUrl: imageUrl(value.coverUrl, local),
    playingNow,
    publishedOn: isoDay(value.publishedOn) ?? null,
    version: line(value.version, VERSION_MAX) ?? null,
    hasAppBuild: value.hasAppBuild === true,
    sdkVersion: line(value.sdkVersion, VERSION_MAX) ?? null,
    eventsReady: value.eventsReady === true,
  };
}

/** The period an answer covers, or null when it is not the `days` that were asked or its dates are not dates. */
export function toAnalyticsWindow(value: unknown, days: StatsPeriod): AnalyticsWindow | null {
  if (!isRecord(value) || value.days !== days) return null;
  const endsOn = isoDay(value.endsOn);
  const computedAt = isoTime(value.computedAt);
  return endsOn && computedAt ? { days, endsOn, computedAt } : null;
}

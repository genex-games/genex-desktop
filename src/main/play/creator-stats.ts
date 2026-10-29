/**
 * A creator's numbers from genex.games: the account's own stats for a period (only it ever sees
 * them) and Play's Top creators. Both are newer than the rest of the API; while genex.games does not
 * serve one, its read answers null and the page shows what it can without it. Electron-free, like
 * the gallery.
 */
import { MINUTE_MS } from "../../shared/duration.ts";
import { type PlayCreator, creatorScore } from "../../shared/play-people.ts";
import { isPlaySlug } from "../../shared/play.ts";
import { type PlayGameStats, type PlayStats, type StatsPeriod, isStatsPeriod } from "../../shared/play-stats.ts";
import { type GalleryDeps, GalleryError, imageUrl, isRecord, SignInNeeded, text } from "./gallery.ts";
import { countOf, toPerson } from "./people.ts";

/** The routes the creator reads use. */
export const CreatorRoute = {
  Stats: "/api/users/me/stats",
  TopCreators: "/api/creators/top",
} as const;

/** How long Top creators are kept: the ranking moves over days, not minutes. */
const CREATORS_TTL_MS = 10 * MINUTE_MS;
/** The most creators the row shows, and the most games one stats answer keeps. */
const CREATORS_MAX = 24;
const STATS_GAMES_MAX = 200;
const TITLE_MAX = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const MESSAGE = { BadPeriod: "Not a stats period" } as const;

/** `days` counts from a list, or null when it is not one. */
function series(value: unknown, days: number): number[] | null {
  if (!Array.isArray(value) || value.length !== days) return null;
  const counts = value.map(countOf);
  return counts.every((count) => count !== null) ? (counts as number[]) : null;
}

/** One game's numbers, or null when the row is not one. */
function gameStats(value: unknown, days: number, local: boolean): PlayGameStats | null {
  if (!isRecord(value) || !isPlaySlug(value.slug)) return null;
  const title = text(value.title, TITLE_MAX).trim();
  const plays = series(value.plays, days);
  const players = series(value.players, days);
  if (!title || !plays || !players) return null;
  return {
    slug: value.slug,
    title,
    coverUrl: imageUrl(value.thumbnailUrl, local),
    plays,
    players,
    playsBefore: countOf(value.playsBefore) ?? 0,
    playersTotal: countOf(value.playersTotal) ?? 0,
    playersBefore: countOf(value.playersBefore) ?? 0,
    playingNow: countOf(value.online) ?? 0,
  };
}

/** The stats answer for `days`, or null when it is not one. */
export function toStats(body: unknown, days: StatsPeriod, local = false): PlayStats | null {
  if (!isRecord(body) || body.days !== days || typeof body.endsOn !== "string" || !DAY.test(body.endsOn)) return null;
  const rows = Array.isArray(body.games) ? body.games.slice(0, STATS_GAMES_MAX) : [];
  const seen = new Set<string>();
  const games: PlayGameStats[] = [];
  for (const row of rows) {
    const game = gameStats(row, days, local);
    if (!game || seen.has(game.slug)) continue;
    seen.add(game.slug);
    games.push(game);
  }
  return {
    days,
    endsOn: body.endsOn,
    games,
    players: countOf(body.players) ?? 0,
    playersBefore: countOf(body.playersBefore) ?? 0,
    published: countOf(body.published) ?? games.length,
    publishedThisMonth: countOf(body.publishedThisMonth) ?? 0,
  };
}

/** Top creators as Play shows them, best first by {@link creatorScore}. */
export function toCreators(body: unknown, local = false): PlayCreator[] {
  const list = isRecord(body) && Array.isArray(body.creators) ? body.creators : [];
  const seen = new Set<string>();
  const creators: PlayCreator[] = [];
  for (const value of list) {
    const person = toPerson(value, local);
    const games = isRecord(value) ? countOf(value.games) : null;
    const hours = isRecord(value) && typeof value.hours === "number" && value.hours >= 0 ? value.hours : null;
    if (!person || !games || hours === null || seen.has(person.id)) continue;
    seen.add(person.id);
    creators.push({ ...person, games, hours });
  }
  return creators
    .toSorted((a, b) => creatorScore(b.games, b.hours) - creatorScore(a.games, a.hours))
    .slice(0, CREATORS_MAX);
}

/** The creator reads over `deps`. */
export function creatorStats(deps: GalleryDeps) {
  const { request, token, now } = deps;
  const local = deps.localImages === true;
  let creators: { at: number; list: PlayCreator[] | null } | null = null;

  /** The account's stats for `days`; null while genex.games has no stats to give. */
  const stats = async (days: StatsPeriod): Promise<PlayStats | null> => {
    if (!isStatsPeriod(days)) throw new Error(MESSAGE.BadPeriod);
    const current = await token();
    if (!current) throw new SignInNeeded();
    const route = `${CreatorRoute.Stats}?${new URLSearchParams({ days: String(days) })}`;
    const answer = await request(route, { method: "GET", token: current });
    if (answer.status === HTTP_NOT_FOUND) return null;
    if (answer.status === HTTP_UNAUTHORIZED) throw new SignInNeeded();
    if (answer.status < 200 || answer.status >= 300) throw new GalleryError(route, answer.status);
    return toStats(answer.body, days, local);
  };

  /** Play's Top creators, kept a while; null while genex.games does not rank them. */
  const topCreators = async (): Promise<PlayCreator[] | null> => {
    if (creators && now() - creators.at < CREATORS_TTL_MS) return creators.list;
    const answer = await request(CreatorRoute.TopCreators, { method: "GET" });
    if (answer.status !== HTTP_NOT_FOUND && (answer.status < 200 || answer.status >= 300))
      throw new GalleryError(CreatorRoute.TopCreators, answer.status);
    const list = answer.status === HTTP_NOT_FOUND ? null : toCreators(answer.body, local);
    creators = { at: now(), list };
    return list;
  };

  return { stats, topCreators };
}

/** The creator reads as `creatorStats` makes them. */
export type CreatorStats = ReturnType<typeof creatorStats>;

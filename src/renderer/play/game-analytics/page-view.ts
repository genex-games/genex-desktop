/**
 * What a game's analytics page shows, decided without React: which face a tab's read calls for,
 * what the header knows of the game, and the line of facts under the title. The page's container
 * reads the stores and hands these to its faces.
 */
import {
  type AnalyticsGame,
  type AnalyticsRead,
  type CampaignLink,
  EventOrigin,
  type EventsStatus,
  type GameReport,
  type GameReportAnswer,
  ReadKind,
} from "../../../shared/game-analytics.ts";
import type { PlayGameDetail } from "../../../shared/play.ts";
import { type PlayGameStats, STATS_PERIODS, type StatsPeriod } from "../../../shared/play-stats.ts";
import type { AnalyticsEntry } from "../../state/game-analytics.ts";
import { LoadStatus, type PeopleState } from "../../state/people.ts";
import { formatAgo } from "./kit/format.ts";
import { periodSpan, utcDay } from "./page-dates.ts";
import { PAGE_WORDS } from "./page-words.ts";
import { AnalyticsTab } from "./tabs.ts";

/**
 * What a tab's body is: the page's own states, and a read's answer under the contract's own name
 * for it (`ReadKind`). The value of `data-game-analytics-state`.
 */
export const BodyKind = {
  SignedOut: "signed-out",
  /** Nothing read, and this computer has no network. */
  Offline: "offline",
  Loading: "loading",
  /** Nothing read, and the read failed. */
  Failed: "failed",
  Unavailable: ReadKind.Unavailable,
  NoGame: ReadKind.NoGame,
  NoReport: ReadKind.NoReport,
  Ready: ReadKind.Ready,
} as const;
export type BodyKind = (typeof BodyKind)[keyof typeof BodyKind];

/**
 * A tab's body. Ready carries the value to draw: `refreshing` while a newer answer is on its way
 * (the value is the last one), `stale` when reading it again failed (the value is still the last one).
 */
export type Body<Value> =
  | { kind: Exclude<BodyKind, typeof BodyKind.Ready> }
  | { kind: typeof BodyKind.Ready; value: Value; refreshing: boolean; stale: boolean };

/** The tab shown with its body, each tab with the value it draws. */
export type ShownTab =
  | { tab: GameReport; body: Body<GameReportAnswer> }
  | { tab: typeof AnalyticsTab.Links; body: Body<CampaignLink[]> }
  | { tab: typeof AnalyticsTab.Sdk; body: Body<EventsStatus> };

/** An answer as a body: its value, or why there is none. A `quiet` re-read of it is not said. */
function answered<Value>(read: AnalyticsRead<Value>, status: LoadStatus, quiet: boolean): Body<Value> {
  if (read.kind !== ReadKind.Ready) return { kind: read.kind };
  const refreshing = !quiet && status === LoadStatus.Loading;
  return { kind: BodyKind.Ready, value: read.value, refreshing, stale: status === LoadStatus.Failed };
}

/**
 * The body a tab shows for its read. Signed out comes first. An answer shows whatever became of
 * reading it again. With no answer to this very question, `previous`, the tab's last answer to
 * another period or option, stays up: dimmed until the new one lands, and with the line that it
 * could not refresh when the read failed, so the tab (and what was typed in it) stays. With nothing
 * read for the tab, a failed read says so (offline when that is why); else it is loading.
 * `quietRereads` is for a read that repeats on an interval (the SDK tab's): reading the answer shown
 * again is then not said, so the tab does not dim every few seconds.
 */
export function bodyOf<Value>(input: {
  signedIn: boolean;
  online: boolean;
  entry: Pick<AnalyticsEntry<unknown, Value>, "status" | "read"> | undefined;
  previous: Value | null;
  quietRereads?: boolean;
}): Body<Value> {
  const { signedIn, online, entry, previous, quietRereads = false } = input;
  if (!signedIn) return { kind: BodyKind.SignedOut };
  if (entry?.read) return answered(entry.read, entry.status, quietRereads);
  const failed = entry?.status === LoadStatus.Failed;
  if (previous !== null) return { kind: BodyKind.Ready, value: previous, refreshing: !failed, stale: failed };
  if (failed) return { kind: online ? BodyKind.Failed : BodyKind.Offline };
  return { kind: BodyKind.Loading };
}

/**
 * Where the keyboard's focus goes once the row `removed` of `ids` is gone with its Remove button: the
 * next row's, else the one before's; null when no row is left (the caller picks a place of its own).
 */
export function focusAfterRemoval(ids: readonly string[], removed: string): string | null {
  const at = ids.indexOf(removed);
  if (at < 0) return null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

/** What the header knows of the game; null where nothing has said yet. */
export interface HeadGame {
  title: string | null;
  coverUrl: string | null;
  playingNow: number | null;
  /** Whether an answer said the game has an app build: the Installs tab is listed only then. */
  hasAppBuild: boolean;
}

/** The game's row in the account's stats, as read for any period; null when no period has it. */
export function statsRow(stats: PeopleState["stats"], slug: string): PlayGameStats | null {
  for (const period of STATS_PERIODS) {
    const row = stats[period]?.stats?.games.find((game) => game.slug === slug);
    if (row) return row;
  }
  return null;
}

/**
 * What the header shows of the game: as the latest analytics answer described it, else its row in
 * the Stats table (where the page was opened from), else its own page as Play read it.
 */
export function headOf(
  game: AnalyticsGame | undefined,
  row: PlayGameStats | null,
  page: PlayGameDetail | null,
): HeadGame {
  if (game) {
    const { title, coverUrl, playingNow, hasAppBuild } = game;
    return { title, coverUrl, playingNow, hasAppBuild };
  }
  if (row) return { title: row.title, coverUrl: row.coverUrl, playingNow: row.playingNow, hasAppBuild: false };
  return { title: page?.title ?? null, coverUrl: page?.coverUrl ?? null, playingNow: null, hasAppBuild: false };
}

/** A report's facts: the days its numbers cover and, once it answered, what changes compare with and its age. */
function reportFacts(body: Body<GameReportAnswer>, period: StatsPeriod, now: number): string[] {
  if (body.kind !== BodyKind.Ready) {
    const { from, to } = periodSpan(utcDay(now), period);
    return [PAGE_WORDS.span(from, to)];
  }
  const { days, endsOn, computedAt } = body.value.window;
  const { from, to } = periodSpan(endsOn, days);
  return [PAGE_WORDS.span(from, to), PAGE_WORDS.against(days), PAGE_WORDS.updated(formatAgo(computedAt, now))];
}

/**
 * The SDK tab's facts: the SDK the published game loads, and how long ago the last of the events
 * shown came, named as Studio preview's while those are the ones shown.
 */
function sdkFacts(body: Body<EventsStatus>, now: number): string[] {
  if (body.kind !== BodyKind.Ready) return [];
  const { game, lastAt, origin } = body.value;
  const version = game.sdkVersion ? [PAGE_WORDS.sdkVersion(game.sdkVersion)] : [];
  const preview = origin === EventOrigin.Preview;
  if (!lastAt) return [...version, preview ? PAGE_WORDS.noPreviewEvents : PAGE_WORDS.noEvents];
  const ago = formatAgo(lastAt, now);
  return [...version, preview ? PAGE_WORDS.lastPreviewEvent(ago) : PAGE_WORDS.lastEvent(ago)];
}

/**
 * The line under the title, as its separate facts: that only the creator sees the page, then what
 * the tab's numbers are (their days in UTC, what changes are against, how long ago they were
 * computed). `period` and `now` (the wall clock) date a tab that has no answer yet.
 */
export function headFacts(shown: ShownTab, period: StatsPeriod, now: number): string[] {
  if (shown.tab === AnalyticsTab.Sdk) return [PAGE_WORDS.onlyYou, ...sdkFacts(shown.body, now)];
  if (shown.tab === AnalyticsTab.Links) {
    const { from, to } = periodSpan(utcDay(now), period);
    return [PAGE_WORDS.onlyYou, PAGE_WORDS.linksSpan(from, to)];
  }
  return [PAGE_WORDS.onlyYou, ...reportFacts(shown.body, period, now)];
}

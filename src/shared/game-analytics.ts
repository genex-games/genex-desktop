/**
 * A game's analytics, which only its creator ever sees: seven reports over a period (7, 30 or 90
 * days), the campaign links that tag where players come from, and the state of the game's own
 * events. genex.games computes every number; this module is the contract both sides hold, and the
 * JSON genex.games answers with has exactly these field names.
 *
 * What the words mean, everywhere:
 * - A player is one person: an account, or a browser or device that has none yet, joined to the
 *   account once they sign in.
 * - A play is one session of the game that finished loading. Opening the page is a visit, not a play.
 * - A new player is a player on the day of their first ever play of this game; a new visitor is
 *   the same for visits.
 * - Days are UTC. Every series is one number per day of the period, oldest first.
 * - A rate is a fraction from 0 to 1. `null` means it cannot be known yet (the day has not passed)
 *   or there is nobody to divide by: never draw it as zero.
 * - A source is where a visit came from. utm_ tags win over the referrer. The first source that
 *   brought a player to this game stays theirs, through sign-in and for `INSTALL_CREDIT_DAYS` up
 *   to an install; the latest source is kept on every play.
 * - The creator's own plays, plays in Studio's preview and bots are never counted.
 *
 * The wire (all under the account's token; `:slug` is the game's):
 * - `GET /api/projects/:slug/analytics/reports/:report?days=&…` with the `GameReportOptions` keys as
 *   query parameters answers a `GameReportAnswer`.
 * - `GET /api/projects/:slug/analytics/events/status?origin=` answers an `EventsStatus`.
 * - `GET /api/projects/:slug/analytics/links?days=` answers `{ links: CampaignLink[] }`;
 *   `POST` there with a `CampaignTags` body answers the new `CampaignLink`; `DELETE …/links/:id`.
 * - `POST /api/projects/:slug/analytics/funnels` with an `EventFunnelDraft` answers the
 *   `EventFunnel`; `DELETE …/funnels/:id`.
 * - A refusal is a 404 whose body carries `code`: a `ReadKind` other than Ready. A 404 with no
 *   code is a genex.games that does not serve analytics yet.
 * - A report takes only its own options (`REPORT_OPTIONS` in `game-analytics-asks.ts`); the words a
 *   creator types are held to the limits here and there, and over-long input is refused, not cut.
 * - A save past `CAMPAIGN_LINKS_MAX` or `FUNNELS_MAX` answers 409 with
 *   `code: AnalyticsWriteRefusal.Limit`; saving tags that are already saved answers the link that
 *   has them. A link just saved has brought nothing yet.
 * - Nex amounts are whole numbers. Every time is an instant (ISO, UTC); the app writes it in the
 *   viewer's own time.
 * - A table's rows are its largest ones and need not add up to the report's totals; a row's `parts`
 *   need not add up to the row.
 * - A row's new players need not be among its new visitors (a play can start with no visit of the
 *   page); the app shows players over visitors only when that is at most 1.
 * - Asked for an event or a split property the game does not send, the Events report answers its
 *   default detail (the top event, no split) and names what it answers, not what was asked.
 * - A campaign link's short link lives on the Play website's own origin.
 * - `POST /api/embed/native-install` takes an `InstallReport` from the app, never from a page.
 */
import type { StatsPeriod } from "./play-stats.ts";

/** The reports a game has; Installs only for a game with an app build. */
export const GameReport = {
  Overview: "overview",
  Acquisition: "acquisition",
  Retention: "retention",
  Engagement: "engagement",
  Events: "events",
  Revenue: "revenue",
  Installs: "installs",
} as const;
export type GameReport = (typeof GameReport)[keyof typeof GameReport];

const REPORTS: ReadonlySet<unknown> = new Set(Object.values(GameReport));

/** Whether a value is one of the reports. */
export const isGameReport = (value: unknown): value is GameReport => REPORTS.has(value);

/** How a read of a game's analytics ended. */
export const ReadKind = {
  Ready: "ready",
  /** genex.games does not serve this yet. */
  Unavailable: "unavailable",
  /** No such game, or it is not this account's. */
  NoGame: "no_game",
  /** The game has no such report: Installs with no app build, Revenue with no store. */
  NoReport: "no_report",
} as const;
export type ReadKind = (typeof ReadKind)[keyof typeof ReadKind];

/** Why genex.games refuses a save: the `code` of its 409. */
export const AnalyticsWriteRefusal = { Limit: "limit" } as const;
export type AnalyticsWriteRefusal = (typeof AnalyticsWriteRefusal)[keyof typeof AnalyticsWriteRefusal];

/** What a read gives: the value, or why there is none. A broken answer is an error, never one of these. */
export type AnalyticsRead<Value> =
  | { kind: typeof ReadKind.Ready; value: Value }
  | { kind: Exclude<ReadKind, typeof ReadKind.Ready> };

/** The kind of place a visit came from. */
export const SourceChannel = {
  /** A surface of Genex itself: `GenexSurface` says which. */
  Genex: "genex",
  /** A link that carried utm_ tags, or an ad click id. */
  Campaigns: "campaigns",
  Social: "social",
  /** No referrer and no tags. */
  Direct: "direct",
  Search: "search",
  Other: "other",
} as const;
export type SourceChannel = (typeof SourceChannel)[keyof typeof SourceChannel];

/** The places inside Genex that lead to a game. */
export const GenexSurface = {
  Feed: "feed",
  Featured: "featured",
  Search: "search",
  Profile: "profile",
  Friends: "friends",
  Remixes: "remixes",
  Other: "other",
} as const;
export type GenexSurface = (typeof GenexSurface)[keyof typeof GenexSurface];

const SURFACES: ReadonlySet<unknown> = new Set(Object.values(GenexSurface));

/** Whether a value names one of Genex's places that lead to a game. */
export const isGenexSurface = (value: unknown): value is GenexSurface => SURFACES.has(value);

/** What a player plays on. */
export const DeviceClass = { Computer: "computer", Phone: "phone", Tablet: "tablet" } as const;
export type DeviceClass = (typeof DeviceClass)[keyof typeof DeviceClass];

/** Where a play runs. */
export const PlayPlace = {
  /** The game's page on genex.games. */
  Browser: "browser",
  /** Play, inside the Genex app. */
  GenexApp: "genex_app",
  /** The game's own app build, installed on the player's computer. */
  Installed: "installed",
} as const;
export type PlayPlace = (typeof PlayPlace)[keyof typeof PlayPlace];

/** The systems an app build is made for. */
export const OsFamily = { Windows: "windows", MacArm: "mac_arm", MacIntel: "mac_intel", Linux: "linux" } as const;
export type OsFamily = (typeof OsFamily)[keyof typeof OsFamily];

/** What the sources table is split by. */
export const SourceBreakdown = {
  Channel: "channel",
  Referrer: "referrer",
  Country: "country",
  Device: "device",
} as const;
export type SourceBreakdown = (typeof SourceBreakdown)[keyof typeof SourceBreakdown];

/** Which of a player's sources a number is credited to. */
export const Attribution = { First: "first", Latest: "latest" } as const;
export type Attribution = (typeof Attribution)[keyof typeof Attribution];

/** The utm_ tag the campaigns table is grouped by. */
export const CampaignField = {
  Campaign: "campaign",
  Source: "source",
  Medium: "medium",
  Content: "content",
  Term: "term",
} as const;
export type CampaignField = (typeof CampaignField)[keyof typeof CampaignField];

/** What "came back on day N" asks: a play on that very day, or on that day or any later one. */
export const RetentionMode = { OnDay: "on_day", DayOrLater: "day_or_later" } as const;
export type RetentionMode = (typeof RetentionMode)[keyof typeof RetentionMode];

/** Whether first plays are grouped by day or by week (Monday first). */
export const CohortSize = { Day: "day", Week: "week" } as const;
export type CohortSize = (typeof CohortSize)[keyof typeof CohortSize];

/** What groups of new players are compared by. */
export const SegmentBy = {
  Place: "place",
  Channel: "channel",
  Device: "device",
  Country: "country",
  Version: "version",
} as const;
export type SegmentBy = (typeof SegmentBy)[keyof typeof SegmentBy];

/** The days the retention tiles show. */
export const RETENTION_DAYS = [1, 3, 7, 14, 30] as const;
/** The longest retention curve and the widest cohort row, in days after the first play. */
export const RETENTION_SPAN = 30;
/** A play this long, in seconds, is engaged; one shorter than `QUICK_EXIT_SECONDS` is a quick exit. */
export const ENGAGED_SECONDS = 30;
export const QUICK_EXIT_SECONDS = 10;
/** How long a campaign link keeps its credit between the click and an install, in days. */
export const INSTALL_CREDIT_DAYS = 7;
/** The hours in a week: the length of the when-they-play series. */
export const WEEK_HOURS = 168;

/** A count or a sum, now and over the period before. */
export interface Compared {
  now: number;
  before: number;
}

/** A rate, a median or an average, now and over the period before; null when there is nothing to measure. */
export interface Measure {
  now: number | null;
  before: number | null;
}

/** The game a report is about. */
export interface AnalyticsGame {
  slug: string;
  title: string;
  coverUrl: string | null;
  /** People in it right now. */
  playingNow: number;
  /** The day it was first published, and the version players get today. */
  publishedOn: string | null;
  version: string | null;
  /** Whether it has an app build: the Installs report exists only then. */
  hasAppBuild: boolean;
  /** The SDK version the published build loads, and whether that one can send the game's own events. */
  sdkVersion: string | null;
  eventsReady: boolean;
}

/** The period a report covers. */
export interface AnalyticsWindow {
  days: StatsPeriod;
  /** The period's last day (UTC, `YYYY-MM-DD`): today. */
  endsOn: string;
  /** When the numbers were computed (ISO time): they are a few minutes behind, never live. */
  computedAt: string;
}

/**
 * A step people pass on the way from the game's page to coming back. A place with no Play button
 * (the page starts the game by itself) sends no PressedPlay step.
 */
export const FunnelStep = {
  Visited: "visited",
  PressedPlay: "pressed_play",
  Loaded: "loaded",
  Engaged: "engaged",
  Returned: "returned",
} as const;
export type FunnelStep = (typeof FunnelStep)[keyof typeof FunnelStep];

/** How many new visitors of the period reached a step; steps come in order, the first is everyone. */
export interface FunnelCount {
  step: FunnelStep;
  people: number;
}

/** New players (or installs) credited to a channel. */
export interface ChannelCount {
  channel: SourceChannel;
  people: number;
}

/** What a mark on the per-day chart is about. */
export const AnnotationKind = { Campaign: "campaign", Version: "version" } as const;
export type AnnotationKind = (typeof AnnotationKind)[keyof typeof AnnotationKind];

/** A mark on the per-day chart: a campaign's first day, or a version's publish day. */
export interface Annotation {
  on: string;
  kind: AnnotationKind;
  /** The campaign's name or the version, as the creator wrote it. */
  label: string;
}

/** What an insight is about. */
export const InsightKind = {
  /** One level loses far more players than the ones around it. */
  LevelDropOff: "level_drop_off",
  /** A campaign brought many new players who stay less (or more) than everyone. */
  CampaignRetention: "campaign_retention",
  /** One kind of device loads the game much slower than the rest. */
  DeviceLoad: "device_load",
  /** Players who installed the app build stay longer than players in the browser. */
  InstalledRetention: "installed_retention",
} as const;
export type InsightKind = (typeof InsightKind)[keyof typeof InsightKind];

/** Something in the numbers worth the creator's look; the sentence is written by the app. */
export type Insight =
  | {
      kind: typeof InsightKind.LevelDropOff;
      level: string;
      /** The share of players who reach the level before it, and this one. */
      reachedBefore: number;
      reached: number;
      tries: number | null;
    }
  | { kind: typeof InsightKind.CampaignRetention; campaign: string; newPlayers: number; day7: number; day7All: number }
  | {
      kind: typeof InsightKind.DeviceLoad;
      device: DeviceClass;
      loadSeconds: number;
      loadSecondsOthers: number;
      /** The share of that device's players who leave before the game loads. */
      leftLoading: number;
    }
  | { kind: typeof InsightKind.InstalledRetention; day7Installed: number; day7Browser: number };

/** The numbers the Overview's tiles and chart can show. */
export const OverviewMetric = {
  Players: "players",
  NewPlayers: "newPlayers",
  Plays: "plays",
  MedianPlaySeconds: "medianPlaySeconds",
  Day1: "day1",
  Day7: "day7",
  Installs: "installs",
  NexSpent: "nexSpent",
} as const;
export type OverviewMetric = (typeof OverviewMetric)[keyof typeof OverviewMetric];

/**
 * One Overview number: over the period and the one before, and per day of each. For Day 1 and
 * Day 7 a day's value is the retention of the players who first played that day.
 */
export interface OverviewSeries {
  now: number | null;
  before: number | null;
  daily: (number | null)[];
  dailyBefore: (number | null)[];
}

/** New players who play again, by days since their first play: index 0 is day 1. */
export interface RetentionCurve {
  /** Up to `RETENTION_SPAN` rates; `before` and `similar` are as long. */
  rates: (number | null)[];
  /** The same over the period before. */
  before: (number | null)[];
  /** The median of similar games on Genex; null while there are too few to compare with. */
  similar: (number | null)[] | null;
}

/** Overview: the headline numbers and a first look at every other report. */
export interface OverviewReport {
  /** Installs is null for a game with no app build. */
  series: Record<OverviewMetric, OverviewSeries | null>;
  annotations: Annotation[];
  insights: Insight[];
  /** New players by the channel that first brought them, most first. */
  channels: ChannelCount[];
  retention: RetentionCurve;
  funnel: FunnelCount[];
}

/** What a source brought, and how those players turned out. */
export interface SourceNumbers {
  newVisitors: number;
  newPlayers: number;
  day1: number | null;
  day7: number | null;
  /** Nex spent per new player, so far. */
  nexPerPlayer: number | null;
}

/**
 * A row of the sources table. `key` is a `SourceChannel` (or, inside Genex, a `GenexSurface`), a
 * referrer's host (`direct` for a visit with none), a two-letter country code or a `DeviceClass`,
 * as the breakdown says.
 */
export interface SourceRow extends SourceNumbers {
  key: string;
  /** Times Genex showed the game there; null where nothing is shown (a link, a friend). */
  shown: number | null;
  /** The rows inside this one: Genex's surfaces, a channel's sites. One level only. */
  parts: SourceRow[];
}

/** A row of the campaigns table: one value of the tag it is grouped by. */
export interface CampaignRow extends SourceNumbers {
  name: string;
  /** The utm_source and utm_medium it arrived with most often. */
  source: string | null;
  medium: string | null;
}

/** Acquisition: where new players come from and how far they get. */
export interface AcquisitionReport {
  newPlayers: Compared;
  newVisitors: Compared;
  /** Times Genex showed the game, and the new visitors that came of it; null when not counted. */
  shown: Compared | null;
  shownVisitors: Compared | null;
  /** New players per day by first channel, for the stacked bars. */
  daily: { channel: SourceChannel; newPlayers: number[] }[];
  funnel: FunnelCount[];
  breakdown: SourceBreakdown;
  attribution: Attribution;
  sources: SourceRow[];
  campaignBy: CampaignField;
  campaigns: CampaignRow[];
}

/** Retention on one of the headline days. */
export interface RetentionPoint {
  day: number;
  rate: number | null;
  before: number | null;
  similar: number | null;
}

/** The players who first played on one day (or week) and how many of them played again. */
export interface Cohort {
  /** The cohort's first day. */
  startsOn: string;
  size: number;
  /** Index 0 is day (or week) 1 after the first play; null for the ones that have not passed. */
  rates: (number | null)[];
  /** The campaign that brought most of this cohort, when one did. */
  campaign: string | null;
}

/** A group of new players compared with the others. `key` is a value of the `SegmentBy` asked for. */
export interface SegmentRow {
  key: string;
  newPlayers: number;
  day1: number | null;
  day7: number | null;
  day30: number | null;
}

/** One week's players by what they did the week before. */
export interface LifecycleWeek {
  /** The week's Monday. */
  startsOn: string;
  /** First ever play this week. */
  fresh: number;
  /** Played the week before too. */
  stayed: number;
  /** Back after two weeks or more away. */
  back: number;
  /** Played the week before and not this one. */
  left: number;
}

/** Retention: whether new players come back. */
export interface RetentionReport {
  mode: RetentionMode;
  cohort: CohortSize;
  /** One point per day of `RETENTION_DAYS`; like the curve, counted the way `mode` says. */
  headline: RetentionPoint[];
  curve: RetentionCurve;
  /** Oldest first. */
  cohorts: Cohort[];
  segmentBy: SegmentBy;
  segments: SegmentRow[];
  /** Oldest first, whole weeks only. */
  weeks: LifecycleWeek[];
}

/** The lengths plays are sorted into. */
export const PlayLength = {
  Under10s: "under_10s",
  Under1m: "under_1m",
  Under3m: "under_3m",
  Under10m: "under_10m",
  Under30m: "under_30m",
  Over30m: "over_30m",
} as const;
export type PlayLength = (typeof PlayLength)[keyof typeof PlayLength];

/** How far players get in a game that sends level events. */
export interface LevelRow {
  level: string;
  /** Players who started it and who finished it. */
  started: number;
  finished: number;
  /** The median tries and seconds it takes to pass. */
  tries: number | null;
  seconds: number | null;
}

/** How the game runs for a group of plays. */
export interface RunNumbers {
  /** Plays that were started (not all of them loaded). */
  started: number;
  /** Median and 90th percentile seconds from start to loaded. */
  loadSeconds: number | null;
  loadSecondsP90: number | null;
  /** The share of started plays that finished loading. */
  loaded: number | null;
  /** The share of plays that held 30 frames a second or more, and the median frames a second. */
  smooth: number | null;
  fps: number | null;
  /** The share of plays with no script error and no crash. */
  clean: number | null;
}

/** Engagement: how much and how well people play. */
export interface EngagementReport {
  plays: Compared;
  /** Plays per player on the days they play. */
  playsPerPlayerDay: Measure;
  medianPlaySeconds: Measure;
  p90PlaySeconds: number | null;
  /** Seconds played by everyone, and per player on the days they play. */
  playSeconds: Compared;
  playSecondsPerPlayerDay: Measure;
  /** The share of plays that ended within `QUICK_EXIT_SECONDS`. */
  quickExits: Measure;
  /** The most people in the game at once, and the hour it happened (ISO time). */
  peak: Compared;
  peakAt: string | null;
  /** Average players a day against everyone who played in the last 30 days. */
  dailyPlayers: Measure;
  monthlyPlayers: Compared;
  /** Plays by length, shortest first. */
  lengths: { length: PlayLength; plays: number }[];
  /** Players by the number of days they played in a week: index 0 is one day. */
  daysAWeek: number[];
  /** Plays by hour of the week, `WEEK_HOURS` numbers from Monday 00:00: in UTC, and in each player's own time. */
  hours: number[];
  hoursLocal: number[] | null;
  /** Null for a game that sends no level events. */
  levels: LevelRow[] | null;
  run: RunNumbers;
  runBefore: RunNumbers;
  /** The version a load-time change dates from, when one stands out. */
  runSince: string | null;
  devices: { device: DeviceClass; run: RunNumbers }[];
}

/** The events Genex counts in every game, with no code. */
export const AutoEvent = {
  PlayStart: "play_start",
  GameReady: "game_ready",
  PlayEnd: "play_end",
  Purchase: "purchase",
  Share: "share",
  Install: "install",
  FirstOpen: "first_open",
} as const;
export type AutoEvent = (typeof AutoEvent)[keyof typeof AutoEvent];

/** The names that also draw a report when a game sends them. */
export const KnownEvent = {
  LevelStart: "level_start",
  LevelComplete: "level_complete",
  LevelFail: "level_fail",
  TutorialComplete: "tutorial_complete",
  MatchStart: "match_start",
  MatchEnd: "match_end",
} as const;
export type KnownEvent = (typeof KnownEvent)[keyof typeof KnownEvent];

/** The kinds of value an event's property can carry. */
export const PropertyKind = { Text: "text", Number: "number", Flag: "boolean" } as const;
export type PropertyKind = (typeof PropertyKind)[keyof typeof PropertyKind];

/** An event in the list. */
export interface EventRow {
  name: string;
  count: number;
  players: number;
  firstSeenOn: string | null;
}

/** What arrived in one property of an event. */
export type PropertyFacts =
  | { kind: typeof PropertyKind.Number; min: number; max: number; median: number; p90: number }
  | { kind: typeof PropertyKind.Text; top: { value: string; share: number }[] }
  /** `yes` is the share of events where it was true. */
  | { kind: typeof PropertyKind.Flag; yes: number };

/** One event, in full. */
export interface EventDetail {
  name: string;
  /** Whether Genex counts it itself (an `AutoEvent`) or the game sends it. */
  automatic: boolean;
  firstSeenOn: string | null;
  count: Compared;
  players: Compared;
  /** Everyone who played in the period: what "players who sent it" divides by. */
  everyone: number;
  daily: number[];
  /** The property the event is split by, and its values, most first. */
  splitBy: string | null;
  split: { value: string; count: number; players: number }[];
  properties: { name: string; facts: PropertyFacts }[];
}

/** A step of a funnel: an event, optionally with one property at one value. */
export interface EventFunnelStep {
  event: string;
  /** Both or neither: a property always comes with the value it must have. */
  property: string | null;
  value: string | null;
}

/** A funnel as the creator writes it. */
export interface EventFunnelDraft {
  name: string;
  /** Players must do every step, in order, within this many days. */
  withinDays: number;
  steps: EventFunnelStep[];
}

/** The most steps a funnel has, the most funnels a game keeps, and the longest a funnel may run. */
export const FUNNEL_STEPS_MAX = 8;
export const FUNNELS_MAX = 20;
export const FUNNEL_DAYS_MAX = 30;

/** A funnel the creator saved, with how many players reached each step in the period. */
export interface EventFunnel {
  id: string;
  name: string;
  withinDays: number;
  steps: (EventFunnelStep & { players: number })[];
  /** The day after the first step on which players typically reach the last. */
  typicalDay: number | null;
}

/** Events: what the game reports about itself. */
export interface EventsReport {
  /** The time (ISO) of the last event the game itself sent, and how many it sent in the period. */
  lastAt: string | null;
  total: number;
  /** The game's own events, most counted first, then the ones Genex counts. */
  custom: EventRow[];
  automatic: EventRow[];
  /** The event asked for (or the first of `custom`); null when the game has none. */
  detail: EventDetail | null;
  funnels: EventFunnel[];
}

/** Revenue: the Nex players spend in the game. Refunded purchases are taken out. */
export interface RevenueReport {
  nex: Compared;
  purchases: Compared;
  payers: Compared;
  /** Everyone who played: what the paying share divides by. */
  players: Compared;
  /** Nex per player on the days they play. */
  nexPerPlayerDay: Measure;
  daily: number[];
  dailyBefore: number[];
  /** What was bought, most Nex first. */
  items: { id: string; name: string; price: number | null; sold: number; buyers: number; nex: number }[];
  /** Nex a new player has spent by each day since their first play: index 0 is the first day. */
  spend: (number | null)[];
  /** The day after the first play on which players typically buy for the first time. */
  firstPurchaseDay: number | null;
  /** By the first channel that brought each player. */
  sources: { channel: SourceChannel; players: number; payers: number; nex: number }[];
}

/** A step from seeing Install to opening the installed game. */
export const InstallStep = {
  Offered: "offered",
  Pressed: "pressed",
  Downloaded: "downloaded",
  Installed: "installed",
  Opened: "opened",
} as const;
export type InstallStep = (typeof InstallStep)[keyof typeof InstallStep];

/** Why a visitor who wanted the app build could not get one. */
export const InstallBlock = {
  MacIntel: "mac_intel",
  OldSystem: "old_system",
  LinuxArm: "linux_arm",
  Other: "other",
} as const;
export type InstallBlock = (typeof InstallBlock)[keyof typeof InstallBlock];

/** Installs: the game's app build, from the button to the first launch. */
export interface InstallsReport {
  installs: Compared;
  /** Installs of the period that were opened at least once. */
  opened: Compared;
  /** Computers it is installed on today, and how many removed it in the period. */
  installedNow: Compared;
  removed: number;
  /** Steps in order; the first is every visitor who saw Install on a computer that can run it. */
  funnel: { step: InstallStep; people: number }[];
  blocked: { reason: InstallBlock; people: number }[];
  daily: { os: OsFamily; installs: number[] }[];
  systems: {
    os: OsFamily;
    installs: number;
    opened: number;
    /** Median seconds a download takes, and the share of downloads that failed. */
    downloadSeconds: number | null;
    failed: number | null;
  }[];
  /** New players who installed against new players in the browser. */
  places: {
    place: PlayPlace;
    newPlayers: number;
    day1: number | null;
    day7: number | null;
    medianPlaySeconds: number | null;
    playsPerPlayerDay: number | null;
    nexPerPlayer: number | null;
  }[];
  /** Versions on players' computers, newest first. */
  versions: { version: string; publishedOn: string | null; installed: number }[];
  /** Median days players take to move to the newest version. */
  updateDays: number | null;
  /** Installs by the channel that first brought the player. */
  channels: ChannelCount[];
}

/** Every report's numbers, by report. */
export interface GameReportMap {
  [GameReport.Overview]: OverviewReport;
  [GameReport.Acquisition]: AcquisitionReport;
  [GameReport.Retention]: RetentionReport;
  [GameReport.Engagement]: EngagementReport;
  [GameReport.Events]: EventsReport;
  [GameReport.Revenue]: RevenueReport;
  [GameReport.Installs]: InstallsReport;
}

/** What a report can be asked with, beyond the game and the period; each is a query parameter of its name. */
export interface GameReportOptions {
  breakdown?: SourceBreakdown;
  attribution?: Attribution;
  campaignBy?: CampaignField;
  mode?: RetentionMode;
  cohort?: CohortSize;
  segmentBy?: SegmentBy;
  /** The event to detail, and the property to split it by. */
  event?: string;
  splitBy?: string;
}

/** A question about one game: which report, over which period, with which options. */
export interface GameReportQuery extends GameReportOptions {
  slug: string;
  report: GameReport;
  days: StatsPeriod;
}

/** A report as genex.games answers it. */
export type GameReportAnswer = {
  [Report in GameReport]: {
    report: Report;
    game: AnalyticsGame;
    window: AnalyticsWindow;
    data: GameReportMap[Report];
  };
}[GameReport];

/** The tags of a campaign link; lower case, spaces as underscores. */
export interface CampaignTags {
  source: string;
  medium: string;
  campaign: string;
  content: string | null;
  term: string | null;
}

/** A campaign link the creator saved, with what it brought in the period. */
export interface CampaignLink extends CampaignTags {
  id: string;
  /** The game's link with the tags on it, and the short link that carries them. */
  url: string;
  shortUrl: string | null;
  createdOn: string;
  newVisitors: number;
  newPlayers: number;
  day7: number | null;
}

/** The longest a tag may be, and the most links a game keeps. */
export const CAMPAIGN_TAG_MAX = 80;
export const CAMPAIGN_LINKS_MAX = 200;

/** A tag as it is saved: trimmed, lower case, runs of spaces as one underscore, cut to the limit. */
export function campaignTag(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_").slice(0, CAMPAIGN_TAG_MAX);
}

/** `gameUrl` with `tags` on it as utm_ parameters; tags that are empty are left out. */
export function campaignUrl(gameUrl: string, tags: CampaignTags): string {
  const url = new URL(gameUrl);
  const entries: [string, string | null][] = [
    ["utm_source", tags.source],
    ["utm_medium", tags.medium],
    ["utm_campaign", tags.campaign],
    ["utm_content", tags.content],
    ["utm_term", tags.term],
  ];
  for (const [name, value] of entries) {
    const tag = value === null ? "" : campaignTag(value);
    if (tag) url.searchParams.set(name, tag);
  }
  return url.toString();
}

/** Where an event came from. */
export const EventOrigin = { Published: "published", Preview: "preview" } as const;
export type EventOrigin = (typeof EventOrigin)[keyof typeof EventOrigin];

const ORIGINS: ReadonlySet<unknown> = new Set(Object.values(EventOrigin));

/** Whether a value is one of the origins. */
export const isEventOrigin = (value: unknown): value is EventOrigin => ORIGINS.has(value);

/** Why genex.games dropped an event the game sent. */
export const DropReason = {
  /** The name is not lower case letters, digits and underscores, or is too long. */
  BadName: "bad_name",
  /** The name is one Genex counts itself. */
  ReservedName: "reserved_name",
  TooManyNames: "too_many_names",
  TooManyProperties: "too_many_properties",
  /** A property's value is not text, a number or true/false. */
  BadValue: "bad_value",
  TextTooLong: "text_too_long",
  TooFast: "too_fast",
} as const;
export type DropReason = (typeof DropReason)[keyof typeof DropReason];

/** The limits events are held to. */
export interface EventLimits {
  nameLength: number;
  names: number;
  properties: number;
  textLength: number;
  /** Seconds between batches, and days every event is kept. */
  batchSeconds: number;
  keptDays: number;
}

/** The limits while genex.games has not said otherwise. */
export const EVENT_LIMITS: EventLimits = {
  nameLength: 40,
  names: 200,
  properties: 20,
  textLength: 200,
  batchSeconds: 5,
  keptDays: 90,
};

/** An event name as genex.games takes it: lower case letters, digits and underscores, a letter first. */
export const EVENT_NAME = /^[a-z][a-z0-9_]*$/;

/** The newest events and the most dropped rows one answer keeps. */
export const RECENT_EVENTS_MAX = 50;
export const DROPPED_ROWS_MAX = 50;

/** An event that just arrived. */
export interface RecentEvent {
  at: string;
  name: string;
  /** A short label for the player that names nobody. */
  player: string;
  /** The event's properties as text, already cut to fit a row. */
  properties: { name: string; value: string }[];
}

/** Events genex.games dropped, by name and reason. */
export interface DroppedEvents {
  /** The name as the game sent it. */
  name: string;
  reason: DropReason;
  /** The property at fault, when the reason is about one. */
  property: string | null;
  count: number;
  lastAt: string;
}

/** The game's events as they arrive: for the SDK page. */
export interface EventsStatus {
  game: AnalyticsGame;
  origin: EventOrigin;
  lastAt: string | null;
  /** Names the game has used, against `limits.names`. */
  names: number;
  /** Newest first. */
  recent: RecentEvent[];
  /** Over the last 24 hours, most dropped first. */
  dropped: DroppedEvents[];
  limits: EventLimits;
}

/**
 * What the app tells genex.games about an app build on this computer, a moment at a time. Only the
 * app installs and opens app builds, so nothing else can count them.
 */
export const InstallMoment = {
  /** The game's page showed Install on a computer that can run the build. */
  Offered: "offered",
  /** The page could not offer it: `block` says why. */
  Blocked: "blocked",
  Pressed: "pressed",
  Downloaded: "downloaded",
  Installed: "installed",
  /** The download or the unpacking failed: `failure` says how. */
  Failed: "failed",
  Opened: "opened",
  Removed: "removed",
} as const;
export type InstallMoment = (typeof InstallMoment)[keyof typeof InstallMoment];

/**
 * One moment of an install, as the app reports it. It carries no name, path or address. `seconds`
 * are whole; Blocked carries no version; an update is told as Pressed, Downloaded and Installed with
 * the new version; Opened is told on every launch; Offered and Blocked are told at most once per game
 * per start of the app, and only while the game's page is shown. With nobody signed in the app adds
 * `playerId` beside these fields: this computer's random id, the one its play report carries.
 */
export interface InstallReport {
  slug: string;
  moment: InstallMoment;
  os: OsFamily;
  /** The build's version, when the moment is about one. */
  version: string | null;
  /** Seconds the download took, with Downloaded. */
  seconds: number | null;
  /** With Blocked. */
  block: InstallBlock | null;
  /** The `InstallFailure` code, with Failed. */
  failure: string | null;
}

/**
 * The query keys the app puts on a game's address when Play opens it, so genex.games knows the
 * play ran in the app and which surface led to it: a `PlayPlace` and a `GenexSurface`, and any other
 * word counts as `other`. The SDK never shows `genex_` keys to the game.
 */
export const PLAY_PLACE_PARAM = "genex_place";
export const PLAY_SURFACE_PARAM = "genex_surface";

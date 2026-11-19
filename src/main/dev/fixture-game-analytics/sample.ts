/**
 * One made-up game per slug, from which every report of a fixture launch is derived, so the reports
 * agree with each other: the new players per day are the same in Overview and Acquisition, the
 * channels sum to the new players, Day 1 and Day 7 are one number wherever they show, and the Nex
 * totals match.
 *
 * A game is one history of 180 days ending today (UTC), seeded by its slug. A period is a slice of
 * it (the last 7, 30 or 90 days) beside the same number of days before, so a week is the month's
 * last week and what is summed in one period is summed the same in another. There are three kinds:
 * the account's first game with an app build is the rich one, whose last 30 days are the numbers
 * the page was designed with (a campaign's spike twelve days back, a version four days after it);
 * the last of the others is young, published two days ago, with a handful of players and almost
 * every rate still unknown; the rest are steady. The quiet fixture account's games all went silent
 * two weeks ago.
 */
import {
  type AnalyticsGame,
  type AnalyticsWindow,
  type Compared,
  DeviceClass,
  type FunnelCount,
  FunnelStep,
  type Insight,
  InsightKind,
  type OverviewSeries,
  RETENTION_SPAN,
  type RetentionCurve,
  SourceChannel,
} from "../../../shared/game-analytics.ts";
import { DAY_MS, MINUTE_MS } from "../../../shared/duration.ts";
import { isPlaySlug } from "../../../shared/play.ts";
import { dayBefore, type StatsPeriod } from "../../../shared/play-stats.ts";
import { isRecord } from "../../play/gallery.ts";
import { FixtureAccount, type FixtureCatalog, fixtureOwnGames } from "../fixture-people.ts";

/** How long a made-up history is: the longest period and the one before it. */
const SPAN_DAYS = 180;
/** How many days back the quiet fixture account's games went silent. */
const DORMANT_DAYS = 14;
/** How far behind the numbers are, as genex.games computes them. */
const COMPUTED_AGO_MS = 4 * MINUTE_MS;
/** How a week goes, Monday first: a little busier towards the weekend. */
const WEEK_RHYTHM = [0.92, 0.88, 0.95, 1, 1.08, 1.22, 1.18] as const;

/** The channels in the order every per-channel list of a history keeps. */
const CHANNELS = [
  SourceChannel.Genex,
  SourceChannel.Campaigns,
  SourceChannel.Social,
  SourceChannel.Direct,
  SourceChannel.Search,
  SourceChannel.Other,
] as const;
/** The share of a channel's new visitors who get into the game. */
const VISIT_TO_PLAY = [0.44, 0.413, 0.362, 0.338, 0.293, 0.2] as const;
/** Where a steady game's new players come from, before its slug moves the shares a little. */
const STEADY_SHARES = [0.56, 0.06, 0.15, 0.13, 0.06, 0.04] as const;

/** The design's game over its last 30 days: players, plays and new players per day, and the 30 days before. */
const RICH_PLAYERS = [
  410, 395, 420, 440, 510, 640, 610, 430, 425, 450, 470, 560, 700, 690, 470, 480, 520, 1180, 1420, 1510, 1290, 980, 890,
  860, 840, 930, 1120, 1060, 870, 812,
] as const;
const RICH_PLAYS = [
  566, 545, 580, 607, 704, 883, 842, 593, 587, 621, 649, 773, 966, 952, 649, 662, 718, 1628, 1960, 2084, 1780, 1352,
  1228, 1187, 1159, 1283, 1546, 1463, 1201, 1121,
] as const;
const RICH_NEW_PLAYERS = [
  111, 107, 113, 119, 138, 173, 165, 116, 115, 122, 127, 151, 189, 186, 127, 130, 140, 732, 824, 785, 581, 353, 294,
  267, 252, 279, 347, 318, 244, 235,
] as const;
const RICH_BEFORE = [
  410, 390, 280, 275, 290, 300, 340, 450, 430, 300, 295, 310, 330, 380, 480, 470, 330, 335, 350, 365, 410, 520, 500,
  360, 370, 385, 400, 450, 560, 540,
] as const;
const RICH_DAYS = RICH_PLAYERS.length;
/** The design's totals: by channel over the 30 days, and what the 30 days before sum to. */
const RICH_CHANNEL_PLAYERS = [3790, 2480, 790, 520, 170, 90] as const;
const RICH_CHANNEL_VISITORS = [8620, 6010, 2180, 1540, 580, 450] as const;
const RICH_NOW = { installs: 1060, nex: 48_610 } as const;
const RICH_BEFORE_TOTALS = { players: 13_482, newPlayers: 4331, plays: 18_386, installs: 768, nex: 31_565 } as const;
/** Where the rich game's new players come from: before its campaign, on each day of it, and after. */
const RICH_QUIET_SHARES = [0.66, 0.08, 0.12, 0.09, 0.033, 0.017] as const;
const RICH_AFTER_SHARES = [0.55, 0.22, 0.11, 0.08, 0.026, 0.014] as const;
const RICH_CAMPAIGN_SHARES = [
  [0.26, 0.58, 0.08, 0.05, 0.02, 0.01],
  [0.25, 0.6, 0.08, 0.05, 0.013, 0.007],
  [0.31, 0.52, 0.09, 0.05, 0.02, 0.01],
  [0.38, 0.42, 0.1, 0.07, 0.02, 0.01],
] as const;
/** The share of the design's new players who play again, by days since their first play. */
const RICH_CURVE = [
  0.345, 0.268, 0.221, 0.193, 0.173, 0.157, 0.145, 0.133, 0.124, 0.116, 0.11, 0.105, 0.1, 0.096, 0.092, 0.088, 0.084,
  0.08, 0.076, 0.072, 0.069, 0.067, 0.065, 0.063, 0.061, 0.059, 0.057, 0.056, 0.054, 0.053,
] as const;
const YOUNG_CURVE = [0.25, 0.2] as const;

/** The design's ratios, kept as the fractions they come from so the rich month lands on them exactly. */
const RATIO = {
  /** Different players of a period for each player-day in it. */
  distinct: { 7: 0.62, 30: 9300 / 22_382, 90: 0.38 },
  pressedPlay: 8560 / 7840,
  engaged: 5960 / 7840,
  returned: 2270 / 5960,
  payers: 412 / 9300,
  purchases: 837 / 412,
  /** New players who install, and Nex spent for each player-day. */
  installs: 0.135,
  nexPerPlayerDay: 2.17,
} as const;
/** How a shorter or longer period moves retention and the median play. */
const PERIOD_LIFT = { 7: 1.03, 30: 1, 90: 0.97 } as const;
const PERIOD_PLAY_SECONDS = { 7: -8, 30: 0, 90: 6 } as const;

/** The rich game's campaign: its tags, when it began, how long it spiked and what it brought. */
const CAMPAIGN = {
  name: "launch_trailer",
  source: "tiktok",
  medium: "social",
  daysAgo: 12,
  days: RICH_CAMPAIGN_SHARES.length,
  /** Its share of the Campaigns channel's new players and new visitors. */
  players: 1460 / 2480,
  visitors: 3420 / 6010,
  day1: 0.26,
  day7: 0.082,
} as const;

/** The kinds of made-up game. */
export const SampleKind = { Rich: "rich", Steady: "steady", Young: "young" } as const;
export type SampleKind = (typeof SampleKind)[keyof typeof SampleKind];

/** A fixture game to make a sample of: what the catalog says of it and which kind it is. */
export interface SampleSource {
  slug: string;
  title: string;
  coverUrl: string | null;
  /** Its lifetime plays in the catalog: how busy a steady game is. */
  plays: number;
  playingNow: number;
  hasAppBuild: boolean;
  kind: SampleKind;
  /** Nobody has played it for two weeks (the quiet fixture account). */
  dormant: boolean;
}

/** A count over the period and the one before, with a number for each day of both. */
export interface SampleSeries {
  now: number;
  before: number;
  daily: number[];
  dailyBefore: number[];
}

/** What one channel brought over the period, and its new players per day. */
export interface SampleChannel {
  channel: SourceChannel;
  newVisitors: number;
  newPlayers: number;
  daily: number[];
}

/** The campaign that is bringing players in the period. */
export interface SampleCampaign {
  name: string;
  source: string;
  medium: string;
  /** Its first day, which may be before the period. */
  startsOn: string;
  newVisitors: number;
  newPlayers: number;
  day1: number;
  day7: number;
}

/** One game over one period: the numbers every report of it is made from. */
export interface GameSample {
  kind: SampleKind;
  /** Steady for a slug: what a report varies its own details by (`noise`). */
  seed: number;
  game: AnalyticsGame;
  window: AnalyticsWindow;
  /** Each day of the period, oldest first. */
  dates: string[];
  /** Different players: per day, and over the whole period (which is not their sum). */
  players: SampleSeries;
  newPlayers: SampleSeries;
  newVisitors: SampleSeries;
  plays: SampleSeries;
  /** Null for a game with no app build. */
  installs: SampleSeries | null;
  nex: SampleSeries;
  purchases: Compared;
  payers: Compared;
  medianPlaySeconds: OverviewSeries;
  /** Day 1 and Day 7 retention: over the period (the curve's own numbers) and by first-play day. */
  day1: OverviewSeries;
  day7: OverviewSeries;
  retention: RetentionCurve;
  /** Most new players first; their new players sum to `newPlayers`, day by day too. */
  channels: SampleChannel[];
  funnel: FunnelCount[];
  campaign: SampleCampaign | null;
  /** The newest version and the day it was published, which may be before the period. */
  release: { version: string; on: string };
  insights: Insight[];
}

/** One day of a game's history. Per-channel lists are in `CHANNELS` order. */
interface Day {
  newPlayers: number[];
  newVisitors: number[];
  players: number;
  plays: number;
  installs: number;
  nex: number;
  /** The median play that day, or null when nobody played. */
  playSeconds: number | null;
}

/** What a kind of game is like, beyond its history. */
interface Profile {
  curve: readonly number[];
  /** Whether Genex has enough similar games to compare its retention with. */
  similar: boolean;
  /** Whole days since it was published: a later retention day cannot be known yet. */
  ageDays: number;
  playSeconds: number;
  /** How much longer a median play is than over the period before. */
  playSecondsGain: number;
  version: string;
  versionDaysAgo: number;
  sdkVersion: string;
  eventsReady: boolean;
  /** How Day 1 and Day 7 differ for players who came outside the campaign, and during it. */
  cohort: { day1: [lift: number, dip: number]; day7: [lift: number, dip: number] };
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const round3 = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;

/** A repeatable number from 0 to 1 for `index` under `seed`. */
export function noise(seed: number, index: number): number {
  const x = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** The design's slow wave from -1 to 1, so a made-up line moves like its own. */
const wave = (index: number, phase: number): number =>
  Math.sin(index * 1.7 + phase) * 0.6 + Math.sin(index * 0.63 + phase * 2) * 0.4;

/** `total` shared out as whole numbers in proportion to `weights`: the parts always sum to `total`. */
export function spread(total: number, weights: readonly number[]): number[] {
  const weight = sum(weights);
  const exact = weights.map((part) => (weight > 0 ? (total * part) / weight : total / weights.length));
  const parts = exact.map(Math.floor);
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .sort((a, b) => b.rest - a.rest || a.index - b.index);
  const left = total - sum(parts);
  for (const { index } of order.slice(0, left)) parts[index] = (parts[index] ?? 0) + 1;
  return parts;
}

/** A slug's seed: the same game is the same numbers on every launch. */
function seedOf(slug: string): number {
  let hash = 2_166_136_261;
  for (const char of slug) hash = Math.imul(hash ^ char.charCodeAt(0), 16_777_619) >>> 0;
  return hash % 997;
}

const NOBODY: Day = {
  newPlayers: CHANNELS.map(() => 0),
  newVisitors: CHANNELS.map(() => 0),
  players: 0,
  plays: 0,
  installs: 0,
  nex: 0,
  playSeconds: null,
};

/** A day made from its new players: who brought them, and what a game of that size sees with them. */
function madeDay(newPlayers: number, at: number, seed: number, shares: readonly number[], playSeconds: number): Day {
  if (newPlayers === 0) return NOBODY;
  const byChannel = spread(newPlayers, shares);
  const players = Math.round(newPlayers / (0.25 + noise(seed + 1, at) * 0.05));
  return {
    newPlayers: byChannel,
    newVisitors: byChannel.map((people, channel) => Math.round(people / (VISIT_TO_PLAY[channel] ?? 1))),
    players,
    plays: Math.round(players * (1.33 + noise(seed + 2, at) * 0.1)),
    installs: Math.round(newPlayers * RATIO.installs * (0.95 + noise(seed + 3, at) * 0.1)),
    nex: Math.round(players * RATIO.nexPerPlayerDay * (0.88 + noise(seed + 4, at) * 0.24)),
    playSeconds: Math.round(playSeconds * (0.94 + noise(seed + 5, at) * 0.12)),
  };
}

/** How busy day `at` of a history is against its last day: a slow growth, a weekly rhythm and some chance. */
function tide(at: number, seed: number, today: number): number {
  const weekday = (new Date(today - (SPAN_DAYS - 1 - at) * DAY_MS).getUTCDay() + 6) % 7;
  const growth = 0.7 + (0.3 * at) / (SPAN_DAYS - 1);
  return growth * (WEEK_RHYTHM[weekday] ?? 1) * (0.88 + noise(seed, at) * 0.24);
}

/** A steady game's history: as busy as its catalog plays say, from where its slug says. */
function steadyHistory(source: SampleSource, seed: number, today: number, playSeconds: number): Day[] {
  const level = Math.max(8, source.plays / 40);
  const shares = STEADY_SHARES.map((share, channel) => share * (0.8 + noise(seed, 200 + channel) * 0.4));
  return Array.from({ length: SPAN_DAYS }, (_, at) =>
    madeDay(Math.round(level * tide(at, seed, today)), at, seed, shares, playSeconds),
  );
}

/** A young game's history: nothing until two days ago, then a handful of people, nobody paying yet. */
function youngHistory(seed: number, ageDays: number): Day[] {
  const first = SPAN_DAYS - 1 - ageDays;
  return Array.from({ length: SPAN_DAYS }, (_, at) => {
    if (at < first) return NOBODY;
    const newPlayers = 3 + Math.floor(noise(seed, at) * 4);
    const players = newPlayers + (at > first ? 1 : 0);
    const day = madeDay(newPlayers, at, seed, STEADY_SHARES, 95);
    return { ...day, players, plays: players + 1, installs: 0, nex: 0 };
  });
}

/**
 * New players by channel for each day of the rich month: every channel but the first gets its
 * month's total shared over the days by its share of each, and the first takes what each day has
 * left, so both the days and the channels sum to the design's numbers.
 */
function richByChannel(): number[][] {
  const shareOn = (day: number): readonly number[] => {
    const campaignDay = day - (RICH_DAYS - 1 - CAMPAIGN.daysAgo);
    if (campaignDay < 0) return RICH_QUIET_SHARES;
    return RICH_CAMPAIGN_SHARES[campaignDay] ?? RICH_AFTER_SHARES;
  };
  const others = RICH_CHANNEL_PLAYERS.slice(1).map((total, index) =>
    spread(
      total,
      RICH_NEW_PLAYERS.map((people, day) => people * (shareOn(day)[index + 1] ?? 0)),
    ),
  );
  const first = RICH_NEW_PLAYERS.map((people, day) => people - sum(others.map((channel) => channel[day] ?? 0)));
  return [first, ...others];
}

/** The rich game's last 30 days: the design's own series, with its totals shared out day by day. */
function richMonth(): Day[] {
  const byChannel = richByChannel();
  const visitors = RICH_CHANNEL_VISITORS.map((total, channel) => spread(total, byChannel[channel] ?? []));
  const installs = spread(
    RICH_NOW.installs,
    RICH_NEW_PLAYERS.map((people, day) => people * (1 + Math.sin(day * 1.7 + 8) * 0.05)),
  );
  const nex = spread(
    RICH_NOW.nex,
    RICH_PLAYERS.map((players, day) => players * (1 + wave(day, 10) * 0.12)),
  );
  const firstCampaignDay = RICH_DAYS - 1 - CAMPAIGN.daysAgo;
  return RICH_PLAYERS.map((players, day) => {
    const inCampaign = day >= firstCampaignDay && day < firstCampaignDay + CAMPAIGN.days;
    return {
      newPlayers: byChannel.map((channel) => channel[day] ?? 0),
      newVisitors: visitors.map((channel) => channel[day] ?? 0),
      players,
      plays: RICH_PLAYS[day] ?? 0,
      installs: installs[day] ?? 0,
      nex: nex[day] ?? 0,
      playSeconds: Math.round(((inCampaign ? 4.9 : 5.9) + wave(day, 2) * 0.35) * 60),
    };
  });
}

/** The 30 days before the rich month: the design's dashed line, summing to what its changes say. */
function richMonthBefore(): Day[] {
  const shared = {
    players: spread(RICH_BEFORE_TOTALS.players, RICH_BEFORE),
    newPlayers: spread(RICH_BEFORE_TOTALS.newPlayers, RICH_BEFORE),
    plays: spread(RICH_BEFORE_TOTALS.plays, RICH_BEFORE),
    installs: spread(RICH_BEFORE_TOTALS.installs, RICH_BEFORE),
    nex: spread(RICH_BEFORE_TOTALS.nex, RICH_BEFORE),
  };
  return RICH_BEFORE.map((_, day) => {
    const byChannel = spread(shared.newPlayers[day] ?? 0, RICH_QUIET_SHARES);
    return {
      newPlayers: byChannel,
      newVisitors: byChannel.map((people, channel) => Math.round(people / (VISIT_TO_PLAY[channel] ?? 1))),
      players: shared.players[day] ?? 0,
      plays: shared.plays[day] ?? 0,
      installs: shared.installs[day] ?? 0,
      nex: shared.nex[day] ?? 0,
      playSeconds: Math.round((5.3 + wave(day, 3) * 0.3) * 60),
    };
  });
}

/** The rich game's history: made-up days growing towards the design's two months, then those. */
function richHistory(seed: number, today: number): Day[] {
  const early = SPAN_DAYS - 2 * RICH_DAYS;
  const level = RICH_BEFORE_TOTALS.newPlayers / RICH_DAYS;
  const made = Array.from({ length: early }, (_, at) =>
    madeDay(Math.round(level * tide(at, seed, today)), at, seed, RICH_QUIET_SHARES, 318),
  );
  return [...made, ...richMonthBefore(), ...richMonth()];
}

/** What each kind of game is like; a steady one's retention and play length move with its slug. */
function profileOf(kind: SampleKind, seed: number): Profile {
  const plain = { day1: [1, 1], day7: [1, 1] } satisfies Profile["cohort"];
  if (kind === SampleKind.Rich)
    return {
      curve: RICH_CURVE,
      similar: true,
      ageDays: SPAN_DAYS + 20,
      playSeconds: 340,
      playSecondsGain: 22,
      version: "1.4.0",
      versionDaysAgo: CAMPAIGN.daysAgo - 4,
      sdkVersion: "0.38.2",
      eventsReady: true,
      cohort: { day1: [0.366 / 0.345, 0.285 / 0.345], day7: [0.159 / 0.145, 0.094 / 0.145] },
    };
  if (kind === SampleKind.Young)
    return {
      curve: YOUNG_CURVE,
      similar: false,
      ageDays: YOUNG_CURVE.length,
      playSeconds: 95,
      playSecondsGain: 0,
      version: "1.0.0",
      versionDaysAgo: YOUNG_CURVE.length,
      sdkVersion: "0.38.2",
      eventsReady: true,
      cohort: plain,
    };
  const keeps = 0.78 + noise(seed, 301) * 0.3;
  return {
    curve: RICH_CURVE.map((rate) => rate * keeps),
    similar: true,
    ageDays: SPAN_DAYS + 80,
    playSeconds: 180 + Math.round(noise(seed, 302) * 240),
    playSecondsGain: Math.round(noise(seed, 303) * 30) - 10,
    version: "1.2.0",
    versionDaysAgo: 19,
    // An SDK from before games could send their own events.
    sdkVersion: "0.31.0",
    eventsReady: false,
    cohort: plain,
  };
}

/** A game's whole history, silent for its last two weeks when it is dormant. */
function historyOf(source: SampleSource, seed: number, today: number, profile: Profile): Day[] {
  const history = {
    [SampleKind.Rich]: () => richHistory(seed, today),
    [SampleKind.Steady]: () => steadyHistory(source, seed, today, profile.playSeconds),
    [SampleKind.Young]: () => youngHistory(seed, profile.ageDays),
  }[source.kind]();
  return source.dormant ? history.map((day, at) => (at >= SPAN_DAYS - DORMANT_DAYS ? NOBODY : day)) : history;
}

/** A game being made: its kind, its seed and what that kind is like. */
interface Made {
  kind: SampleKind;
  seed: number;
  profile: Profile;
}

/** A period of a history and the one before it. */
interface Period {
  days: StatsPeriod;
  now: Day[];
  before: Day[];
  /** Where the period's first day is in the history. */
  first: number;
}

const counted = ({ now, before }: Period, pick: (day: Day) => number): SampleSeries => {
  const daily = now.map(pick);
  const dailyBefore = before.map(pick);
  return { now: sum(daily), before: sum(dailyBefore), daily, dailyBefore };
};

/** Different players a day, and over each period: never fewer than its new players. */
function playersOf(period: Period, newPlayers: SampleSeries): SampleSeries {
  const perDay = counted(period, (day) => day.players);
  const distinct = (playerDays: number, fresh: number) =>
    Math.max(fresh, Math.round(playerDays * RATIO.distinct[period.days]));
  return { ...perDay, now: distinct(perDay.now, newPlayers.now), before: distinct(perDay.before, newPlayers.before) };
}

/**
 * New players who play again by days since their first play. A day is known once a period that
 * long has passed and the game is that old; with no new players there is nobody to divide by.
 */
function retentionOf(profile: Profile, period: Period, newPlayers: SampleSeries): RetentionCurve {
  const lift = PERIOD_LIFT[period.days];
  const base = (index: number) => profile.curve[index] ?? 0;
  const knownNow = newPlayers.now > 0 ? Math.min(period.days, profile.ageDays, profile.curve.length) : 0;
  const knownBefore = newPlayers.before > 0 ? Math.min(2 * period.days, profile.curve.length) : 0;
  const curve = (known: number, rate: (index: number) => number): (number | null)[] =>
    Array.from({ length: RETENTION_SPAN }, (_, index) => (index < known ? round3(rate(index)) : null));
  return {
    rates: curve(knownNow, (index) => base(index) * lift),
    before: curve(
      knownBefore,
      (index) => base(index) * lift - 0.021 * Math.exp(-index / 7) + (0.002 * index) / (RETENTION_SPAN - 1),
    ),
    similar: profile.similar
      ? curve(RETENTION_SPAN, (index) => base(index) * (0.9 - (0.16 * index) / (RETENTION_SPAN - 1)))
      : null,
  };
}

/** Whether a day of the history is one of the rich game's campaign days. */
const campaignDay = (kind: SampleKind, at: number): boolean => {
  const first = SPAN_DAYS - 1 - CAMPAIGN.daysAgo;
  return kind === SampleKind.Rich && at >= first && at < first + CAMPAIGN.days;
};

/**
 * Retention on day `day` by first-play day: null for a day whose players have not had `day` days
 * yet, and for one with no new players.
 */
function cohortSeries(game: Made, retention: RetentionCurve, period: Period, day: 1 | 7): OverviewSeries {
  const [lift, dip] = game.profile.cohort[day === 1 ? "day1" : "day7"];
  const now = retention.rates[day - 1] ?? null;
  const before = retention.before[day - 1] ?? null;
  const chance = (index: number) => 0.96 + noise(game.seed + day, index) * 0.08;
  const fresh = (one: Day) => sum(one.newPlayers) > 0;
  return {
    now,
    before,
    daily: period.now.map((one, index) => {
      const passed = period.days - 1 - index >= day;
      if (now === null || !passed || !fresh(one)) return null;
      return round3(now * (campaignDay(game.kind, period.first + index) ? dip : lift) * chance(index));
    }),
    dailyBefore: period.before.map((one, index) =>
      before === null || !fresh(one) ? null : round3(before * chance(index + period.days)),
    ),
  };
}

/** The median play over each period and day by day: null where nobody played. */
function playSecondsOf(profile: Profile, period: Period, plays: SampleSeries): OverviewSeries {
  const now = profile.playSeconds + PERIOD_PLAY_SECONDS[period.days];
  return {
    now: plays.now > 0 ? now : null,
    before: plays.before > 0 ? now - profile.playSecondsGain : null,
    daily: period.now.map((day) => day.playSeconds),
    dailyBefore: period.before.map((day) => day.playSeconds),
  };
}

/** What each channel brought over the period, most new players first. */
function channelsOf({ now }: Period): SampleChannel[] {
  return CHANNELS.map((channel, index) => {
    const daily = now.map((day) => day.newPlayers[index] ?? 0);
    return {
      channel,
      newVisitors: sum(now.map((day) => day.newVisitors[index] ?? 0)),
      newPlayers: sum(daily),
      daily,
    };
  }).sort((a, b) => b.newPlayers - a.newPlayers);
}

/** New visitors step by step: everyone who opened the page, down to those who came back. */
function funnelOf(newVisitors: number, newPlayers: number): FunnelCount[] {
  const engaged = Math.round(newPlayers * RATIO.engaged);
  return [
    { step: FunnelStep.Visited, people: newVisitors },
    { step: FunnelStep.PressedPlay, people: Math.min(newVisitors, Math.round(newPlayers * RATIO.pressedPlay)) },
    { step: FunnelStep.Loaded, people: newPlayers },
    { step: FunnelStep.Engaged, people: engaged },
    { step: FunnelStep.Returned, people: Math.round(engaged * RATIO.returned) },
  ];
}

/** The rich game's campaign with what it brought in the period; none for the others, or with nobody new. */
function campaignOf(kind: SampleKind, channels: readonly SampleChannel[], endsOn: string): SampleCampaign | null {
  const paid = channels.find((channel) => channel.channel === SourceChannel.Campaigns);
  if (kind !== SampleKind.Rich || !paid || paid.newPlayers === 0) return null;
  return {
    name: CAMPAIGN.name,
    source: CAMPAIGN.source,
    medium: CAMPAIGN.medium,
    startsOn: dayBefore(endsOn, CAMPAIGN.daysAgo),
    newVisitors: Math.round(paid.newVisitors * CAMPAIGN.visitors),
    newPlayers: Math.round(paid.newPlayers * CAMPAIGN.players),
    day1: CAMPAIGN.day1,
    day7: CAMPAIGN.day7,
  };
}

/** What is worth a look: the design's four for the rich game, slow phones for a steady one, nothing where nobody plays. */
function insightsOf(sample: Pick<GameSample, "kind" | "game" | "plays" | "retention" | "campaign">): Insight[] {
  if (sample.plays.now === 0 || sample.kind === SampleKind.Young) return [];
  const phone = InsightKind.DeviceLoad;
  if (sample.kind === SampleKind.Steady)
    return [{ kind: phone, device: DeviceClass.Phone, loadSeconds: 5.2, loadSecondsOthers: 2.6, leftLoading: 0.11 }];
  const day7All = sample.retention.rates[6] ?? null;
  const { campaign } = sample;
  const insights: Insight[] = [
    { kind: InsightKind.LevelDropOff, level: "4", reachedBefore: 0.61, reached: 0.38, tries: 4 },
  ];
  if (campaign && day7All !== null)
    insights.push({
      kind: InsightKind.CampaignRetention,
      campaign: campaign.name,
      newPlayers: campaign.newPlayers,
      day7: campaign.day7,
      day7All,
    });
  insights.push({
    kind: phone,
    device: DeviceClass.Phone,
    loadSeconds: 6.1,
    loadSecondsOthers: 2.9,
    leftLoading: 0.14,
  });
  if (sample.game.hasAppBuild)
    insights.push({ kind: InsightKind.InstalledRetention, day7Installed: 0.261, day7Browser: 0.122 });
  return insights;
}

/** The game as an answer names it. */
function gameOf(source: SampleSource, profile: Profile, endsOn: string): AnalyticsGame {
  const lively = source.kind !== SampleKind.Young && !source.dormant;
  return {
    slug: source.slug,
    title: source.title,
    coverUrl: source.coverUrl,
    playingNow: lively ? source.playingNow : 0,
    publishedOn: dayBefore(endsOn, profile.ageDays),
    version: profile.version,
    hasAppBuild: source.hasAppBuild,
    sdkVersion: profile.sdkVersion,
    eventsReady: profile.eventsReady,
  };
}

/** Who paid and how often, from the players and the Nex of a period: nobody where no Nex was spent. */
function payingOf(players: SampleSeries, nex: SampleSeries): { payers: Compared; purchases: Compared } {
  const paid = (people: number, spent: number) => (spent > 0 ? Math.round(people * RATIO.payers) : 0);
  const payers = { now: paid(players.now, nex.now), before: paid(players.before, nex.before) };
  const bought = (people: number) => Math.round(people * RATIO.purchases);
  return { payers, purchases: { now: bought(payers.now), before: bought(payers.before) } };
}

/** The sample of `source` over `days`, ending on the UTC day of `now`. */
export function gameSample(source: SampleSource, days: StatsPeriod, now: number): GameSample {
  const seed = seedOf(source.slug);
  const profile = profileOf(source.kind, seed);
  const history = historyOf(source, seed, now, profile);
  const first = SPAN_DAYS - days;
  const period: Period = { days, now: history.slice(first), before: history.slice(first - days, first), first };
  const endsOn = new Date(now).toISOString().slice(0, 10);
  const newPlayers = counted(period, (day) => sum(day.newPlayers));
  const newVisitors = counted(period, (day) => sum(day.newVisitors));
  const players = playersOf(period, newPlayers);
  const plays = counted(period, (day) => day.plays);
  const nex = counted(period, (day) => day.nex);
  const retention = retentionOf(profile, period, newPlayers);
  const channels = channelsOf(period);
  const made: Made = { kind: source.kind, seed, profile };
  const core = {
    kind: source.kind,
    game: gameOf(source, profile, endsOn),
    plays,
    retention,
    campaign: campaignOf(source.kind, channels, endsOn),
  };
  return {
    ...core,
    seed,
    window: { days, endsOn, computedAt: new Date(now - COMPUTED_AGO_MS).toISOString() },
    dates: Array.from({ length: days }, (_, day) => dayBefore(endsOn, days - 1 - day)),
    players,
    newPlayers,
    newVisitors,
    installs: source.hasAppBuild ? counted(period, (day) => day.installs) : null,
    nex,
    ...payingOf(players, nex),
    medianPlaySeconds: playSecondsOf(profile, period, plays),
    day1: cohortSeries(made, retention, period, 1),
    day7: cohortSeries(made, retention, period, 7),
    channels,
    funnel: funnelOf(newVisitors.now, newPlayers.now),
    release: { version: profile.version, on: dayBefore(endsOn, profile.versionDaysAgo) },
    insights: insightsOf(core),
  };
}

/** A game of the fixture catalog as a sample reads it, or null for an item that is not a game. */
function listedGame(item: unknown): Omit<SampleSource, "kind" | "dormant"> | null {
  if (!isRecord(item) || !isPlaySlug(item.slug) || typeof item.title !== "string") return null;
  return {
    slug: item.slug,
    title: item.title,
    coverUrl: typeof item.thumbnailUrl === "string" ? item.thumbnailUrl : null,
    plays: typeof item.playsCount === "number" ? item.playsCount : 0,
    playingNow: typeof item.online === "number" ? item.online : 2,
    hasAppBuild: Array.isArray(item.builds) && item.builds.length > 0,
  };
}

/**
 * The fixture account's own games, each with its kind: the first with an app build is the rich one
 * (the first game, when none has one), the last of the others is young when there is another to
 * stay steady, and the fresh account's single game is young.
 */
export function ownSamples(account: FixtureAccount, catalog: FixtureCatalog): SampleSource[] {
  const games = fixtureOwnGames(account, catalog).flatMap((item) => listedGame(item) ?? []);
  const rich = games.find((game) => game.hasAppBuild) ?? games[0];
  const others = games.filter((game) => game !== rich);
  const young = others.length > 1 ? others.at(-1) : undefined;
  const kindOf = (game: (typeof games)[number]): SampleKind => {
    if (account === FixtureAccount.Fresh || game === young) return SampleKind.Young;
    return game === rich ? SampleKind.Rich : SampleKind.Steady;
  };
  return games.map((game) => ({
    ...game,
    // The design's game has 38 people in it.
    playingNow: game === rich ? 38 : game.playingNow,
    kind: kindOf(game),
    dormant: account === FixtureAccount.Quiet,
  }));
}

/**
 * A fixture game's Installs report as genex.games answers it: the game's app build, from the
 * button to the first launch. Made from the game's sample (`sample.ts`), the way
 * `fixture-overview.ts` makes its own, so its numbers agree with every other report of the game:
 * the installs of each day are the sample's, shared out among the systems; the installs by channel
 * sum to them; the two places' retention and play length sit around everyone's.
 *
 * The rich game's last 30 days are the numbers the page was designed with. Every ratio here is kept
 * as the fraction it comes from, so that month lands on them exactly; another period of that game
 * is the same ratios over other totals, and another game moves each ratio a little by its seed.
 */
import {
  type ChannelCount,
  type GameReportOptions,
  type Insight,
  InsightKind,
  InstallBlock,
  InstallStep,
  type InstallsReport,
  OsFamily,
  PlayPlace,
  SourceChannel,
} from "../../../shared/game-analytics.ts";
import { dayBefore } from "../../../shared/play-stats.ts";
import { type GameSample, noise, SampleKind, type SampleSeries, spread } from "./sample.ts";

/** The design's month, as the sample holds it: what the ratios below are fractions of. */
const DESIGN = {
  installs: 1060,
  installsBefore: 768,
  newVisitors: 19_380,
  offered: 6840,
  day1: 0.345,
  day7: 0.145,
  medianPlaySeconds: 340,
  playsPerPlayerDay: 30_889 / 22_382,
  nexPerPlayer: 48_610 / 9300,
} as const;

/** Around an install: who saw the button (of new visitors), then who pressed it, whose download finished and who removed the game (per install). */
const FLOW = {
  offered: DESIGN.offered / DESIGN.newVisitors,
  pressed: 1240 / DESIGN.installs,
  downloaded: 1092 / DESIGN.installs,
  removed: 310 / DESIGN.installs,
  /** The share of the period before's installs that were opened. */
  openedBefore: 667 / DESIGN.installsBefore,
} as const;

/** Visitors who could not get a build, for each one who saw Install; the design's game has no other reason, another game a few. */
const BLOCKED_OF_OFFERED = {
  [InstallBlock.MacIntel]: 180 / DESIGN.offered,
  [InstallBlock.OldSystem]: 150 / DESIGN.offered,
  [InstallBlock.LinuxArm]: 90 / DESIGN.offered,
  [InstallBlock.Other]: 0,
} as const satisfies Record<InstallBlock, number>;
const OTHER_BLOCKED_OF_OFFERED = 0.004;

/** The design's systems: their installs of the month, how many of those were opened, and how their downloads went. */
const SYSTEMS = [
  { os: OsFamily.Windows, installs: 610, opened: 536, downloadSeconds: 52, failed: 0.034 },
  { os: OsFamily.MacArm, installs: 360, opened: 326, downloadSeconds: 41, failed: 0.022 },
  { os: OsFamily.MacIntel, installs: 50, opened: 43, downloadSeconds: 58, failed: 0.041 },
  { os: OsFamily.Linux, installs: 40, opened: 35, downloadSeconds: 47, failed: 0.05 },
] as const;

/** Installs for each new player a channel brought, in the design's month. */
const INSTALLS_PER_NEW_PLAYER = {
  [SourceChannel.Genex]: 520 / 3790,
  [SourceChannel.Campaigns]: 290 / 2480,
  [SourceChannel.Social]: 80 / 790,
  [SourceChannel.Direct]: 140 / 520,
  [SourceChannel.Search]: 20 / 170,
  [SourceChannel.Other]: 10 / 90,
} as const satisfies Record<SourceChannel, number>;

/** How a place's new players turn out against all new players, and where the sample's insight says their Day 7. */
const PLACES = [
  {
    place: PlayPlace.Installed,
    day1: 0.491 / DESIGN.day1,
    day7: 0.261 / DESIGN.day7,
    medianPlaySeconds: 800 / DESIGN.medianPlaySeconds,
    playsPerPlayerDay: 1.9 / DESIGN.playsPerPlayerDay,
    nexPerPlayer: 9.4 / DESIGN.nexPerPlayer,
    insight: "day7Installed",
  },
  {
    place: PlayPlace.Browser,
    day1: 0.314 / DESIGN.day1,
    day7: 0.122 / DESIGN.day7,
    medianPlaySeconds: 290 / DESIGN.medianPlaySeconds,
    playsPerPlayerDay: 1.3 / DESIGN.playsPerPlayerDay,
    nexPerPlayer: 3.1 / DESIGN.nexPerPlayer,
    insight: "day7Browser",
  },
] as const;

/** A version before the newest: when it was published (null where the day was not kept) and its weight among the computers that have the game. */
interface OlderVersion {
  version: string;
  daysAgo: number | null;
  weight: number;
}
/** The newest version's weight, and each kind of game's versions before it, newest first. */
const NEWEST_WEIGHT = 2038;
const OLDER_VERSIONS = {
  [SampleKind.Rich]: [
    { version: "1.3.2", daysAgo: 27, weight: 631 },
    { version: "1.3.0", daysAgo: 48, weight: 124 },
    { version: "1.2.1", daysAgo: 71, weight: 51 },
    { version: "1.2.0", daysAgo: 96, weight: 26 },
  ],
  [SampleKind.Steady]: [
    { version: "1.1.2", daysAgo: 58, weight: 540 },
    { version: "1.1.0", daysAgo: 131, weight: 190 },
    { version: "1.0.0", daysAgo: null, weight: 60 },
  ],
  [SampleKind.Young]: [],
} as const satisfies Record<SampleKind, readonly OlderVersion[]>;

/** The computers the design's game is on today, and the median days its players take to update. */
const RICH_INSTALLED_NOW = 2870;
const UPDATE_DAYS = 1.2;
/** Another game is on as many computers as it gains in this many fortnights. */
const FORTNIGHT_DAYS = 14;
const FORTNIGHTS_INSTALLED = 7;

/** How far another game's number may sit from the design's, either way: by default, and for the ones with little room. */
const REACH = 0.2;
const SMALL_REACH = 0.04;
const WIDE_REACH = 0.6;
/** Where each detail reads its chance (`noise(seed, index)`); a list takes the indices after its own. */
const CHANCE = {
  offered: 700,
  pressed: 701,
  downloaded: 702,
  removed: 703,
  openedBefore: 704,
  updateDays: 705,
  newest: 706,
  blocked: 710,
  systems: 720,
  opened: 730,
  download: 740,
  failed: 750,
  channels: 760,
  places: 770,
} as const;

/** A game with no app build has no installs; `index.ts` refuses its report before asking here. */
const NO_INSTALLS: SampleSeries = { now: 0, before: 0, daily: [], dailyBefore: [] };
const CHANNEL_ORDER: readonly SourceChannel[] = Object.values(SourceChannel);

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const tenth = (value: number): number => Math.round(value * 10) / 10;
const thousandth = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
/** `value` times `by`, or null while `value` cannot be known. */
const scaled = (value: number | null, by: number): number | null => (value === null ? null : value * by);
/** `value` rounded by `round`, or null while it cannot be known. */
const rounded = (value: number | null, round: (value: number) => number): number | null =>
  value === null ? null : round(value);

/**
 * How far a game moves a number of the design's: not at all for the rich game, up to `reach` either
 * way for another, by its seed.
 */
function vary(sample: GameSample, index: number, reach: number = REACH): number {
  return sample.kind === SampleKind.Rich ? 1 : 1 + (noise(sample.seed, index) * 2 - 1) * reach;
}

/** The period's installs by system, with how many of each were opened and how its downloads went; a system nobody installed on is left out. */
function systemsOf(sample: GameSample, installs: number): InstallsReport["systems"] {
  const shared = spread(
    installs,
    SYSTEMS.map((system, index) => system.installs * vary(sample, CHANCE.systems + index)),
  );
  return SYSTEMS.map((system, index) => {
    const mine = shared[index] ?? 0;
    const opens = (system.opened / system.installs) * vary(sample, CHANCE.opened + index, SMALL_REACH);
    return {
      os: system.os,
      installs: mine,
      opened: Math.min(mine, Math.round(mine * opens)),
      downloadSeconds: Math.round(system.downloadSeconds * vary(sample, CHANCE.download + index)),
      failed: thousandth(system.failed * vary(sample, CHANCE.failed + index)),
    };
  }).filter((row) => row.installs > 0);
}

/**
 * Each day's installs shared out among the systems so that both sums hold: a day's systems make the
 * day's installs, and a system's days make its installs of the period. A day is shared by what each
 * system still has left, which is never less than the day asks of it and which the last day uses up.
 */
function dailyOf(systems: InstallsReport["systems"], daily: readonly number[]): InstallsReport["daily"] {
  const left = systems.map((system) => system.installs);
  const perDay = daily.map((installs) => {
    const parts = spread(installs, left);
    for (const [index, part] of parts.entries()) left[index] = (left[index] ?? 0) - part;
    return parts;
  });
  return systems.map((system, index) => ({ os: system.os, installs: perDay.map((parts) => parts[index] ?? 0) }));
}

/** The steps before an install: everyone who saw the button, who pressed it and whose download finished. */
function flowOf(sample: GameSample, installs: number): { offered: number; pressed: number; downloaded: number } {
  const pressed = Math.round(installs * FLOW.pressed * vary(sample, CHANCE.pressed, SMALL_REACH));
  const finished = Math.round(installs * FLOW.downloaded * vary(sample, CHANCE.downloaded, SMALL_REACH / 2));
  const saw = Math.round(sample.newVisitors.now * FLOW.offered * vary(sample, CHANCE.offered));
  return { offered: Math.max(pressed, saw), pressed, downloaded: Math.min(pressed, finished) };
}

/** Visitors who wanted the build and could not get one, by reason; a reason with nobody is left out. */
function blockedOf(sample: GameSample, offered: number): InstallsReport["blocked"] {
  const shareOf = (reason: InstallBlock): number =>
    reason === InstallBlock.Other && sample.kind !== SampleKind.Rich
      ? OTHER_BLOCKED_OF_OFFERED
      : BLOCKED_OF_OFFERED[reason];
  return Object.values(InstallBlock)
    .map((reason, index) => ({
      reason,
      people: Math.round(offered * shareOf(reason) * vary(sample, CHANCE.blocked + index)),
    }))
    .filter((row) => row.people > 0);
}

/**
 * The computers the game is on today. It does not change with the period: the design's number for
 * the rich game, and for another what its last two weeks say, which every period holds.
 */
function installedToday(sample: GameSample, installs: SampleSeries): number {
  if (sample.kind === SampleKind.Rich) return RICH_INSTALLED_NOW;
  const fortnight = [...installs.dailyBefore, ...installs.daily].slice(-FORTNIGHT_DAYS);
  return Math.round(sum(fortnight) * FORTNIGHTS_INSTALLED);
}

/** The computers that have the game, today and when the period began, and the removals between the two. */
function installedOf(sample: GameSample, installs: SampleSeries): Pick<InstallsReport, "installedNow" | "removed"> {
  const now = installedToday(sample, installs);
  const typical = Math.round(installs.now * FLOW.removed * vary(sample, CHANCE.removed));
  // At least as many removals as leave the period's start with no fewer than no computers.
  const removed = Math.max(typical, installs.now - now);
  return { installedNow: { now, before: now - installs.now + removed }, removed };
}

/** What the sample says of all new players, which each place's numbers sit around. */
function everyoneOf(sample: GameSample) {
  const playerDays = sum(sample.players.daily);
  return {
    day1: sample.day1.now,
    day7: sample.day7.now,
    medianPlaySeconds: sample.medianPlaySeconds.now,
    playsPerPlayerDay: playerDays > 0 ? sample.plays.now / playerDays : null,
    nexPerPlayer: sample.players.now > 0 ? sample.nex.now / sample.players.now : null,
  };
}

type InstalledRetention = Extract<Insight, { kind: typeof InsightKind.InstalledRetention }>;

/** A measure of a place's new players: null while everyone's is not known, or with nobody in the place. */
type PlaceMeasure = "day1" | "day7" | "medianPlaySeconds" | "playsPerPlayerDay" | "nexPerPlayer";

/**
 * New players who installed against new players in the browser. Day 7 is the sample's own insight
 * where it has one, so the report says what the Overview says; a place with nobody has nothing to measure.
 */
function placesOf(sample: GameSample, installs: number): InstallsReport["places"] {
  const installed = Math.min(installs, sample.newPlayers.now);
  const newPlayers = [installed, sample.newPlayers.now - installed];
  const everyone = everyoneOf(sample);
  const insight = sample.insights.find((one): one is InstalledRetention => one.kind === InsightKind.InstalledRetention);
  return PLACES.map((place, index) => {
    const people = newPlayers[index] ?? 0;
    const measured = (measure: PlaceMeasure): number | null =>
      people > 0 ? scaled(everyone[measure], place[measure] * vary(sample, CHANCE.places + index, SMALL_REACH)) : null;
    const said = people > 0 && insight ? insight[place.insight] : measured("day7");
    return {
      place: place.place,
      newPlayers: people,
      day1: rounded(measured("day1"), thousandth),
      day7: rounded(said, thousandth),
      medianPlaySeconds: rounded(measured("medianPlaySeconds"), Math.round),
      playsPerPlayerDay: rounded(measured("playsPerPlayerDay"), tenth),
      nexPerPlayer: rounded(measured("nexPerPlayer"), tenth),
    };
  });
}

/** The versions on players' computers, newest first: the sample's release, then the kind's older ones; a version on no computer is left out. */
function versionsOf(sample: GameSample, installedNow: number): InstallsReport["versions"] {
  const older: readonly OlderVersion[] = OLDER_VERSIONS[sample.kind];
  const shared = spread(installedNow, [
    NEWEST_WEIGHT * vary(sample, CHANCE.newest),
    ...older.map((version) => version.weight),
  ]);
  const versions = [
    { version: sample.release.version, publishedOn: sample.release.on },
    ...older.map(({ version, daysAgo }) => ({
      version,
      publishedOn: daysAgo === null ? null : dayBefore(sample.window.endsOn, daysAgo),
    })),
  ];
  return versions
    .map((version, index) => ({ ...version, installed: shared[index] ?? 0 }))
    .filter((row) => row.installed > 0);
}

/** The period's installs by the channel that first brought the player, most first; a channel with none is left out. */
function channelsOf(sample: GameSample, installs: number): ChannelCount[] {
  const shared = spread(
    installs,
    sample.channels.map(
      ({ channel, newPlayers }) =>
        newPlayers * INSTALLS_PER_NEW_PLAYER[channel] * vary(sample, CHANCE.channels + CHANNEL_ORDER.indexOf(channel)),
    ),
  );
  return sample.channels
    .map(({ channel }, index) => ({ channel, people: shared[index] ?? 0 }))
    .filter((row) => row.people > 0)
    .sort((a, b) => b.people - a.people);
}

/** The Installs report's data for `sample`; it takes no options, and is asked only for a game with an app build. */
export function fixtureInstalls(sample: GameSample, _options: GameReportOptions): InstallsReport {
  const installs = sample.installs ?? NO_INSTALLS;
  const systems = systemsOf(sample, installs.now);
  const opened = sum(systems.map((system) => system.opened));
  const openedBefore = Math.round(installs.before * FLOW.openedBefore * vary(sample, CHANCE.openedBefore, SMALL_REACH));
  const flow = flowOf(sample, installs.now);
  const installed = installedOf(sample, installs);
  return {
    installs: { now: installs.now, before: installs.before },
    opened: { now: opened, before: Math.min(installs.before, openedBefore) },
    ...installed,
    funnel: [
      { step: InstallStep.Offered, people: flow.offered },
      { step: InstallStep.Pressed, people: flow.pressed },
      { step: InstallStep.Downloaded, people: flow.downloaded },
      { step: InstallStep.Installed, people: installs.now },
      { step: InstallStep.Opened, people: opened },
    ],
    blocked: blockedOf(sample, flow.offered),
    daily: dailyOf(systems, installs.daily),
    systems,
    places: placesOf(sample, installs.now),
    versions: versionsOf(sample, installed.installedNow.now),
    updateDays:
      installed.installedNow.now > 0 ? tenth(UPDATE_DAYS * vary(sample, CHANCE.updateDays, WIDE_REACH)) : null,
    channels: channelsOf(sample, installs.now),
  };
}

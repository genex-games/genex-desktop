/**
 * What the Installs report shows, derived from an answer: the four tiles, the way from the Install
 * button to the first launch, the installs of each day by system, the systems' table with its
 * total, the two places side by side, the versions and the channels. Pure: the component only lays
 * these out. A number that cannot be known is null here and a dash on the page, never zero; days
 * are UTC, as genex.games counts them, so nothing here asks the clock or the viewer's time zone.
 */
import {
  type ChannelCount,
  type GameReport,
  INSTALL_CREDIT_DAYS,
  type InstallBlock,
  InstallStep,
  type InstallsReport,
  OsFamily,
  PlayPlace,
  SourceChannel,
} from "../../../shared/game-analytics.ts";
import { INSTALLS_WORDS } from "./installs-words.ts";
import {
  type BarListItem,
  type BarSeries,
  DASH,
  DeltaKind,
  formatDay,
  formatDuration,
  formatNexPerPlayer,
  formatNumber,
  formatPercent,
  formatSigned,
  type FunnelStepItem,
  type LegendItem,
  type MetricDelta,
  OS_SLOT,
  periodLabels,
  ratio,
} from "./kit/index.ts";
import type { ReportAnswer } from "./report-props.ts";

/** The rows the versions table shows: with more versions than this, the last row holds the older ones together. */
export const VERSION_ROWS = 3;
/** The row that holds search and every other site together, as the page names them. */
const ELSEWHERE = "search_and_other";

const WORDS = INSTALLS_WORDS;
const SYSTEMS: readonly OsFamily[] = Object.values(OsFamily);

/** The steps the funnel draws, in order; who saw Install at all is said beside the title. */
type DrawnStep = Exclude<InstallStep, typeof InstallStep.Offered>;
const DRAWN_STEPS: readonly DrawnStep[] = [
  InstallStep.Pressed,
  InstallStep.Downloaded,
  InstallStep.Installed,
  InstallStep.Opened,
];
/** The step each step's people go on to; the last goes nowhere. */
const NEXT_STEP = {
  [InstallStep.Pressed]: InstallStep.Downloaded,
  [InstallStep.Downloaded]: InstallStep.Installed,
  [InstallStep.Installed]: InstallStep.Opened,
} as const;

/** The row of "Where installs came from" a channel is counted in. */
const CHANNEL_ROW = {
  [SourceChannel.Genex]: { id: SourceChannel.Genex, label: WORDS.channels.genex },
  [SourceChannel.Campaigns]: { id: SourceChannel.Campaigns, label: WORDS.channels.campaigns },
  [SourceChannel.Social]: { id: SourceChannel.Social, label: WORDS.channels.social },
  [SourceChannel.Direct]: { id: SourceChannel.Direct, label: WORDS.channels.direct },
  [SourceChannel.Search]: { id: ELSEWHERE, label: WORDS.channels.searchAndOther },
  [SourceChannel.Other]: { id: ELSEWHERE, label: WORDS.channels.searchAndOther },
} as const satisfies Record<SourceChannel, { id: string; label: string }>;

/** One quiet line under a tile's number; `mask` when it carries the creator's own words (a version). */
export interface TileNote {
  id: string;
  text: string;
  mask?: boolean;
}

/** A headline tile: its number as it reads (null when it cannot be known), how it moved, and its notes. */
export interface InstallsTile {
  id: string;
  label: string;
  value: string | null;
  delta?: MetricDelta;
  notes: TileNote[];
}

/** A reason visitors could not get the build, with how many it stopped, already written. */
export interface BlockedReason {
  id: InstallBlock;
  label: string;
  people: string;
}

/** The way from the Install button to the first launch. */
export interface InstallFunnelView {
  /** Who saw Install and the share who pressed it; null when the answer does not say. */
  hint: string | null;
  /** The steps to draw; none when nobody pressed Install. */
  steps: FunnelStepItem[];
  /** The visitors who wanted the build and could not get one; null when there were none. */
  blocked: { sentence: string; reasons: BlockedReason[] } | null;
}

/** The installs of each day, stacked by system; no series when nobody installed. */
export interface DailyInstallsView {
  series: BarSeries[];
  labels: string[];
  legend: LegendItem[];
}

/** A row of the systems table: a system, or all of them together. */
export interface SystemRow {
  id: string;
  label: string;
  installs: number;
  /** Its share of the period's installs; null for the total and with no installs to divide by. */
  share: number | null;
  /** The share of its installs that were opened. */
  opened: number | null;
  /** Its median download time; null for the total, since the answer has no median of every download. */
  downloadSeconds: number | null;
  failed: number | null;
}

/** A row of the comparison between places: one measure, written for each place. */
export interface PlaceRow {
  id: string;
  label: string;
  installed: string;
  browser: string;
}

/** New players who installed beside new players in the browser; no rows when neither place has any. */
export interface PlacesView {
  hint: string | null;
  rows: PlaceRow[];
}

/** A row of the versions table: a version, or the older ones together. */
export interface VersionRow {
  id: string;
  label: string;
  published: string;
  installed: number;
  /** Its share of the computers that have the game. */
  share: number | null;
}

/** Everything the Installs report draws. */
export interface InstallsView {
  tiles: InstallsTile[];
  funnel: InstallFunnelView;
  daily: DailyInstallsView;
  systems: { rows: SystemRow[]; total: SystemRow | null };
  places: PlacesView;
  versions: VersionRow[];
  channels: BarListItem[];
  /** How long a campaign link keeps its credit up to an install. */
  credit: string;
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
/** `value` written by `write`, or a dash while it cannot be known. */
const written = <Value>(value: Value | null | undefined, write: (value: Value) => string): string =>
  value === null || value === undefined ? DASH : write(value);

/**
 * The computers a version's share is of: the ones that have the game today, or the versions' own
 * sum where an answer lists more than that, so no share reads over 100%.
 */
function installedOn(report: InstallsReport): number {
  return Math.max(report.installedNow.now, sum(report.versions.map((version) => version.installed)));
}

/** The median days players take to update, as its note reads: one decimal unless it is a whole number. */
function updateNote(days: number): string {
  const tenths = Math.round(days * 10) / 10;
  return WORDS.tiles.updateNote(tenths, formatNumber(tenths, Number.isInteger(tenths) ? 0 : 1));
}

/** The tile of the newest version: its share of the computers that have the game, when it was published and how fast players move to it. */
function latestTile(report: InstallsReport): InstallsTile {
  const [newest] = report.versions;
  const share = newest ? ratio(newest.installed, installedOn(report)) : null;
  const notes: TileNote[] = [];
  if (newest) {
    const text = newest.publishedOn
      ? WORDS.tiles.latestPublished(newest.version, formatDay(newest.publishedOn))
      : newest.version;
    notes.push({ id: "version", text, mask: true });
  }
  if (newest && report.updateDays !== null) notes.push({ id: "update", text: updateNote(report.updateDays) });
  return { id: "latest", label: WORDS.tiles.latest, value: share === null ? null : formatPercent(share, 0), notes };
}

/** The four headline tiles. */
function tilesOf(report: InstallsReport): InstallsTile[] {
  const { installs, opened, installedNow, removed } = report;
  const openedRate = ratio(opened.now, installs.now);
  return [
    {
      id: "installs",
      label: WORDS.tiles.installs,
      value: formatNumber(installs.now),
      delta: { kind: DeltaKind.Percent, now: installs.now, before: installs.before },
      notes: [{ id: "what", text: WORDS.tiles.installsNote }],
    },
    {
      id: "opened",
      label: WORDS.tiles.opened,
      value: openedRate === null ? null : formatPercent(openedRate),
      delta: { kind: DeltaKind.Points, now: openedRate, before: ratio(opened.before, installs.before) },
      notes:
        openedRate === null
          ? []
          : [{ id: "count", text: WORDS.tiles.openedNote(opened.now, formatNumber(opened.now)) }],
    },
    {
      id: "installed-now",
      label: WORDS.tiles.installedNow,
      value: formatNumber(installedNow.now),
      delta: {
        kind: DeltaKind.Amount,
        now: installedNow.now,
        before: installedNow.before,
        format: formatSigned,
        digits: 0,
      },
      notes: [{ id: "removed", text: WORDS.tiles.removedNote(removed, formatNumber(removed)) }],
    },
    latestTile(report),
  ];
}

/** Who saw Install on a computer that can run the build, and the share of them who pressed it. */
function offeredHint(people: ReadonlyMap<InstallStep, number>): string | null {
  const offered = people.get(InstallStep.Offered);
  if (offered === undefined) return null;
  const pressed = ratio(people.get(InstallStep.Pressed), offered);
  const shown = formatNumber(offered);
  return pressed === null
    ? WORDS.funnel.offered(offered, shown)
    : WORDS.funnel.offeredPressed(offered, shown, formatPercent(pressed));
}

/** The two lines under a step: the share that goes on (of the first step, for the last) and how many do not. */
function stepLines(step: DrawnStep, people: ReadonlyMap<InstallStep, number>): Pick<FunnelStepItem, "onward" | "lost"> {
  const here = people.get(step);
  if (step === InstallStep.Opened) {
    const ofPressed = ratio(here, people.get(InstallStep.Pressed));
    return { onward: ofPressed === null ? null : WORDS.funnel.onward[step](formatPercent(ofPressed)), lost: null };
  }
  const next = people.get(NEXT_STEP[step]);
  const onward = ratio(next, here);
  const lost = here === undefined || next === undefined ? 0 : here - next;
  return {
    onward: onward === null ? null : WORDS.funnel.onward[step](formatPercent(onward)),
    lost: lost > 0 ? WORDS.funnel.lost[step](lost, formatNumber(lost)) : null,
  };
}

/** The steps from pressing Install to opening the game that the answer has; none when nobody reached any. */
function funnelSteps(people: ReadonlyMap<InstallStep, number>): FunnelStepItem[] {
  const steps = DRAWN_STEPS.flatMap((step) => {
    const count = people.get(step);
    return count === undefined
      ? []
      : [{ id: step, label: WORDS.funnel.steps[step], count, ...stepLines(step, people) }];
  });
  return steps.some((step) => step.count > 0) ? steps : [];
}

/** The visitors who wanted the build and could not get one, by reason, most first. */
function blockedOf(blocked: InstallsReport["blocked"]): InstallFunnelView["blocked"] {
  const stopped = blocked.filter((row) => row.people > 0).toSorted((a, b) => b.people - a.people);
  const total = sum(stopped.map((row) => row.people));
  if (total === 0) return null;
  return {
    sentence: WORDS.funnel.blocked(total, formatNumber(total)),
    reasons: stopped.map((row) => ({
      id: row.reason,
      label: WORDS.funnel.reasons[row.reason],
      people: formatNumber(row.people),
    })),
  };
}

/** The installs of each day by system, in the systems' own order; a system nobody installed on has no series. */
function dailyOf(answer: ReportAnswer<typeof GameReport.Installs>): DailyInstallsView {
  const series = SYSTEMS.flatMap((os) => {
    const values = answer.data.daily.find((row) => row.os === os)?.installs;
    const drawn = values !== undefined && sum(values) > 0;
    return drawn ? [{ id: os, label: WORDS.systems.names[os], slot: OS_SLOT[os], values }] : [];
  });
  return {
    series,
    labels: periodLabels(answer.window),
    legend: series.map(({ id, label, slot }) => ({ id, label, slot })),
  };
}

/**
 * The systems' table, in the systems' own order, and the row for all of them; no total without
 * rows. The total holds only what the systems add up to. Its download time stays empty: each
 * system's is a median, and the answer carries no median of every download, which no mix of the
 * systems' medians is. Its Failed stays empty too: a system's share of failed downloads cannot be
 * weighed by its installs (a failed download never installs), and the answer counts no downloads.
 */
function systemsOf(systems: InstallsReport["systems"]): InstallsView["systems"] {
  const installs = sum(systems.map((system) => system.installs));
  const rows = SYSTEMS.flatMap((os) => {
    const system = systems.find((row) => row.os === os);
    if (!system) return [];
    return [
      {
        id: os,
        label: WORDS.systems.names[os],
        installs: system.installs,
        share: ratio(system.installs, installs),
        opened: ratio(system.opened, system.installs),
        downloadSeconds: system.downloadSeconds,
        failed: system.failed,
      },
    ];
  });
  if (rows.length === 0) return { rows, total: null };
  const total: SystemRow = {
    id: "all",
    label: WORDS.systems.all,
    installs,
    share: null,
    opened: ratio(sum(systems.map((system) => system.opened)), installs),
    downloadSeconds: null,
    failed: null,
  };
  return { rows, total };
}

type Place = InstallsReport["places"][number];

/** The measures the two places are compared by, and how each is written. */
const PLACE_MEASURES = [
  { id: "day1", label: WORDS.places.day1, write: (place: Place) => written(place.day1, formatPercent) },
  { id: "day7", label: WORDS.places.day7, write: (place: Place) => written(place.day7, formatPercent) },
  {
    id: "medianPlaySeconds",
    label: WORDS.places.medianPlaySeconds,
    write: (place: Place) => written(place.medianPlaySeconds, formatDuration),
  },
  {
    id: "playsPerPlayerDay",
    label: WORDS.places.playsPerPlayerDay,
    write: (place: Place) => written(place.playsPerPlayerDay, (value) => formatNumber(value, 1)),
  },
  {
    id: "nexPerPlayer",
    label: WORDS.places.nexPerPlayer,
    write: (place: Place) => written(place.nexPerPlayer, formatNexPerPlayer),
  },
] as const;

/** New players who installed beside new players in the browser, a measure a row; a place the answer lacks is all dashes. */
function placesOf(places: InstallsReport["places"]): PlacesView {
  const installed = places.find((row) => row.place === PlayPlace.Installed);
  const browser = places.find((row) => row.place === PlayPlace.Browser);
  const people = { installed: installed?.newPlayers ?? 0, browser: browser?.newPlayers ?? 0 };
  if (people.installed + people.browser === 0) return { hint: null, rows: [] };
  return {
    hint: WORDS.places.hint(
      people.installed,
      formatNumber(people.installed),
      people.browser,
      formatNumber(people.browser),
    ),
    rows: PLACE_MEASURES.map(({ id, label, write }) => ({
      id,
      label,
      installed: installed ? write(installed) : DASH,
      browser: browser ? write(browser) : DASH,
    })),
  };
}

/**
 * The versions table, newest first. A long list keeps `VERSION_ROWS` rows: the last one holds that
 * version and every older one together, under the newest of them and its publish day.
 */
function versionsOf(report: InstallsReport): VersionRow[] {
  const { versions } = report;
  const whole = installedOn(report);
  const folds = versions.length > VERSION_ROWS;
  const named = folds ? versions.slice(0, VERSION_ROWS - 1) : versions;
  const rows: VersionRow[] = named.map((version, index) => ({
    id: String(index),
    label: version.version,
    published: written(version.publishedOn, formatDay),
    installed: version.installed,
    share: ratio(version.installed, whole),
  }));
  const [first, ...rest] = folds ? versions.slice(VERSION_ROWS - 1) : [];
  if (!first) return rows;
  const installed = first.installed + sum(rest.map((version) => version.installed));
  rows.push({
    id: "older",
    label: WORDS.versions.andOlder(first.version),
    published: written(first.publishedOn, formatDay),
    installed,
    share: ratio(installed, whole),
  });
  return rows;
}

/** The channels installs came from, most first, search and other sites as one row; a channel with none is left out. */
function channelsOf(channels: readonly ChannelCount[]): BarListItem[] {
  const rows = new Map<string, BarListItem>();
  for (const { channel, people } of channels) {
    const { id, label } = CHANNEL_ROW[channel];
    rows.set(id, { id, label, value: (rows.get(id)?.value ?? 0) + people });
  }
  return [...rows.values()].filter((row) => row.value > 0).toSorted((a, b) => b.value - a.value);
}

/** What the Installs report draws for `answer`. */
export function installsView(answer: ReportAnswer<typeof GameReport.Installs>): InstallsView {
  const report = answer.data;
  const people = new Map(report.funnel.map((row) => [row.step, row.people]));
  return {
    tiles: tilesOf(report),
    funnel: { hint: offeredHint(people), steps: funnelSteps(people), blocked: blockedOf(report.blocked) },
    daily: dailyOf(answer),
    systems: systemsOf(report.systems),
    places: placesOf(report.places),
    versions: versionsOf(report),
    channels: channelsOf(report.channels),
    credit: WORDS.channels.credit(INSTALL_CREDIT_DAYS),
  };
}

/**
 * The Installs report as genex.games answers it: the game's app build, from the Install button to
 * the first launch. Read with the helpers in `kit.ts`, the way `report-overview.ts` reads its own:
 * a fixed part that does not read refuses the report, a row that does not read is left out, and a
 * number that cannot be known yet stays null.
 *
 * Two counts are parts of another and are held to it: the installs that were opened cannot
 * outnumber the installs (the whole report for the period's totals, the row for one system), and no
 * version sits on more computers than have the game.
 */
import {
  type AnalyticsWindow,
  type ChannelCount,
  type Compared,
  InstallBlock,
  InstallStep,
  type InstallsReport,
  OsFamily,
  PlayPlace,
  SourceChannel,
} from "../../../shared/game-analytics.ts";
import { isRecord } from "../gallery.ts";
import {
  amount,
  compared,
  count,
  isoDay,
  line,
  oneOf,
  orNull,
  type Read,
  rateOrNull,
  rows,
  series,
  whole,
} from "./kit.ts";

/** The most versions a page lists, and the longest a version may read (`game.ts` holds the game's own to the same). */
const VERSIONS_MAX = 50;
const VERSION_MAX = 40;
const STEPS_MAX = Object.keys(InstallStep).length;
const BLOCKS_MAX = Object.keys(InstallBlock).length;
const SYSTEMS_MAX = Object.keys(OsFamily).length;
const PLACES_MAX = Object.keys(PlayPlace).length;
const CHANNELS_MAX = Object.keys(SourceChannel).length;

const isStep = oneOf(InstallStep);
const isBlock = oneOf(InstallBlock);
const isSystem = oneOf(OsFamily);
const isPlace = oneOf(PlayPlace);
const isChannel = oneOf(SourceChannel);

type FunnelRow = InstallsReport["funnel"][number];
type BlockedRow = InstallsReport["blocked"][number];
type DailyRow = InstallsReport["daily"][number];
type SystemRow = InstallsReport["systems"][number];
type PlaceRow = InstallsReport["places"][number];
type VersionRow = InstallsReport["versions"][number];

const amountOrNull = orNull(amount);

/** How many people reached a step; a step the app does not know is left out. */
const funnelRow: Read<FunnelRow> = (value) => {
  if (!isRecord(value) || !isStep(value.step)) return undefined;
  const people = count(value.people);
  return people === undefined ? undefined : { step: value.step, people };
};

/** How many visitors could not get a build for one reason; a reason the app has no words for is left out. */
const blockedRow: Read<BlockedRow> = (value) => {
  if (!isRecord(value) || !isBlock(value.reason)) return undefined;
  const people = count(value.people);
  return people === undefined ? undefined : { reason: value.reason, people };
};

/** One system's installs for each of the period's `days`. */
const dailyRowOver =
  (days: number): Read<DailyRow> =>
  (value) => {
    if (!isRecord(value) || !isSystem(value.os)) return undefined;
    const installs = series(value.installs, days, count);
    return installs ? { os: value.os, installs } : undefined;
  };

/** One system's installs, how many of them were opened, and how its downloads went. */
const systemRow: Read<SystemRow> = (value) => {
  if (!isRecord(value) || !isSystem(value.os)) return undefined;
  const read = whole({
    installs: count(value.installs),
    opened: count(value.opened),
    downloadSeconds: amountOrNull(value.downloadSeconds),
    failed: rateOrNull(value.failed),
  });
  return read && read.opened <= read.installs ? { os: value.os, ...read } : undefined;
};

/** New players of one place and how they turned out; each measure may not be known yet. */
const placeRow: Read<PlaceRow> = (value) => {
  if (!isRecord(value) || !isPlace(value.place)) return undefined;
  const read = whole({
    newPlayers: count(value.newPlayers),
    day1: rateOrNull(value.day1),
    day7: rateOrNull(value.day7),
    medianPlaySeconds: amountOrNull(value.medianPlaySeconds),
    playsPerPlayerDay: amountOrNull(value.playsPerPlayerDay),
    nexPerPlayer: amountOrNull(value.nexPerPlayer),
  });
  return read ? { place: value.place, ...read } : undefined;
};

/** A version on at most `installedNow` computers, as the creator named it, cleaned. */
const versionRowWithin =
  (installedNow: number): Read<VersionRow> =>
  (value) => {
    if (!isRecord(value)) return undefined;
    const version = line(value.version, VERSION_MAX);
    const read = whole({ publishedOn: orNull(isoDay)(value.publishedOn), installed: count(value.installed) });
    return version && read && read.installed <= installedNow ? { version, ...read } : undefined;
  };

/** Installs a channel brought; a channel the app does not know is left out. */
const channelCount: Read<ChannelCount> = (value) => {
  if (!isRecord(value) || !isChannel(value.channel)) return undefined;
  const people = count(value.people);
  return people === undefined ? undefined : { channel: value.channel, people };
};

/** The period's opened installs, which cannot outnumber its installs, now or before. */
function openedOf(value: unknown, installs: Compared | undefined): Compared | undefined {
  const opened = compared(value);
  if (!opened || !installs) return undefined;
  return opened.now <= installs.now && opened.before <= installs.before ? opened : undefined;
}

/** The Installs report for `window`, or null when `data` is not one. */
export function toInstallsReport(data: unknown, window: AnalyticsWindow): InstallsReport | null {
  if (!isRecord(data)) return null;
  const installs = compared(data.installs);
  const installedNow = compared(data.installedNow);
  const report = whole({
    installs,
    opened: openedOf(data.opened, installs),
    installedNow,
    removed: count(data.removed),
    funnel: rows(data.funnel, STEPS_MAX, funnelRow, (row) => row.step),
    blocked: rows(data.blocked, BLOCKS_MAX, blockedRow, (row) => row.reason),
    daily: rows(data.daily, SYSTEMS_MAX, dailyRowOver(window.days), (row) => row.os),
    systems: rows(data.systems, SYSTEMS_MAX, systemRow, (row) => row.os),
    places: rows(data.places, PLACES_MAX, placeRow, (row) => row.place),
    versions: rows(data.versions, VERSIONS_MAX, versionRowWithin(installedNow?.now ?? 0), (row) => row.version),
    updateDays: amountOrNull(data.updateDays),
    channels: rows(data.channels, CHANNELS_MAX, channelCount, (row) => row.channel),
  });
  return report ?? null;
}

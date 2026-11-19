/**
 * The Acquisition report as genex.games answers it: how many new visitors and new players came,
 * what Genex showing the game brought, the new players per day by the channel that first brought
 * them, how far new visitors get, and the sources and the campaigns behind them.
 *
 * Read the way `report-overview.ts` reads its own: the totals, the per-day series and the three
 * options the answer echoes are fixed parts, so one of them broken refuses the report; a row of the
 * sources or the campaigns table that does not read is left out. A row's key is held to what its
 * breakdown names (a channel, a Genex surface, a country, a device) and anything a stranger can
 * write (a referrer's host, a utm_ tag's value) goes through `line`.
 */
import {
  type AcquisitionReport,
  type AnalyticsWindow,
  Attribution,
  CampaignField,
  type CampaignRow,
  type Compared,
  DeviceClass,
  type FunnelCount,
  FunnelStep,
  GenexSurface,
  SourceBreakdown,
  SourceChannel,
  type SourceNumbers,
  type SourceRow,
} from "../../../shared/game-analytics.ts";
import { isRecord } from "../gallery.ts";
import {
  amount,
  compared,
  count,
  countryCode,
  line,
  oneOf,
  orNull,
  type Read,
  rateOrNull,
  rows,
  series,
  whole,
} from "./kit.ts";

/** The most rows the sources table keeps, the most rows inside one of them, and the most campaigns. */
const SOURCES_MAX = 100;
const SOURCE_PARTS_MAX = 50;
const CAMPAIGNS_MAX = 100;
/** The longest a referrer's host may read (a domain name's own limit), and a utm_ tag's value. */
const HOST_MAX = 253;
const TAG_MAX = 200;
const CHANNELS_MAX = Object.keys(SourceChannel).length;
const FUNNEL_STEPS_MAX = Object.keys(FunnelStep).length;

const isAttribution = oneOf(Attribution);
const isBreakdown = oneOf(SourceBreakdown);
const isCampaignField = oneOf(CampaignField);
const isChannel = oneOf(SourceChannel);
const isDevice = oneOf(DeviceClass);
const isFunnelStep = oneOf(FunnelStep);
const isSurface = oneOf(GenexSurface);

/** A referrer's host, as anyone who links to a game can write it. */
const host: Read<string> = (value) => line(value, HOST_MAX);
/** A place inside Genex; one the app has no name for is not a key. */
const surface: Read<string> = (value) => (isSurface(value) ? value : undefined);

/** How a row's key reads under each breakdown. */
const SOURCE_KEY = {
  [SourceBreakdown.Channel]: (value) => (isChannel(value) ? value : undefined),
  [SourceBreakdown.Referrer]: host,
  [SourceBreakdown.Country]: countryCode,
  [SourceBreakdown.Device]: (value) => (isDevice(value) ? value : undefined),
} as const satisfies Record<SourceBreakdown, Read<string>>;

/** A count now and before, or null where genex.games does not count it. */
const comparedOrNull = (value: unknown): Compared | null | undefined => (value === null ? null : compared(value));

/** What a source brought: two counts, and three numbers that stay null while they cannot be known. */
function sourceNumbers(value: Record<string, unknown>): SourceNumbers | undefined {
  return whole({
    newVisitors: count(value.newVisitors),
    newPlayers: count(value.newPlayers),
    day1: rateOrNull(value.day1),
    day7: rateOrNull(value.day7),
    nexPerPlayer: orNull(amount)(value.nexPerPlayer),
  });
}

/** A row of the sources table with no rows inside it, its key read by `key`. */
const sourceLeaf =
  (key: Read<string>): Read<SourceRow> =>
  (value) => {
    if (!isRecord(value)) return undefined;
    const read = whole({ key: key(value.key), shown: orNull(count)(value.shown), numbers: sourceNumbers(value) });
    return read ? { key: read.key, shown: read.shown, ...read.numbers, parts: [] } : undefined;
  };

/**
 * A row of the sources table under `breakdown`, with the rows inside it one level deep: Genex's
 * are its surfaces, any other row's are sites.
 */
const sourceRow =
  (breakdown: SourceBreakdown): Read<SourceRow> =>
  (value) => {
    const row = sourceLeaf(SOURCE_KEY[breakdown])(value);
    if (!row || !isRecord(value)) return undefined;
    const holdsSurfaces = breakdown === SourceBreakdown.Channel && row.key === SourceChannel.Genex;
    const parts = rows(value.parts, SOURCE_PARTS_MAX, sourceLeaf(holdsSurfaces ? surface : host), (part) => part.key);
    return parts ? { ...row, parts } : undefined;
  };

/** A utm_ tag's value, or null where a campaign came with none. */
const tag: Read<string | null> = orNull((value) => line(value, TAG_MAX));

/** A row of the campaigns table: one value of the tag it is grouped by. */
const campaignRow: Read<CampaignRow> = (value) => {
  if (!isRecord(value)) return undefined;
  const read = whole({
    name: line(value.name, TAG_MAX),
    source: tag(value.source),
    medium: tag(value.medium),
    numbers: sourceNumbers(value),
  });
  return read ? { name: read.name, source: read.source, medium: read.medium, ...read.numbers } : undefined;
};

/** A channel's new players per day; its days are null when they are not one whole count for each day. */
const channelDays =
  (days: number): Read<{ channel: SourceChannel; newPlayers: number[] | null }> =>
  (value) =>
    isRecord(value) && isChannel(value.channel)
      ? { channel: value.channel, newPlayers: series(value.newPlayers, days, count) ?? null }
      : undefined;

/**
 * New players per day by channel. A channel the app does not know is left out; a known channel
 * whose days do not read spoils the report, because the bars would stand shorter than the day was.
 */
function dailyByChannel(value: unknown, days: number): AcquisitionReport["daily"] | undefined {
  const read = rows(value, CHANNELS_MAX, channelDays(days), (row) => row.channel);
  if (!read) return undefined;
  const daily: AcquisitionReport["daily"] = [];
  for (const { channel, newPlayers } of read) {
    if (!newPlayers) return undefined;
    daily.push({ channel, newPlayers });
  }
  return daily;
}

/** How many new visitors reached a step; a step the app does not know is left out. */
const funnelCount: Read<FunnelCount> = (value) => {
  if (!isRecord(value) || !isFunnelStep(value.step)) return undefined;
  const people = count(value.people);
  return people === undefined ? undefined : { step: value.step, people };
};

/** The Acquisition report for `window`, or null when `data` is not one. */
export function toAcquisitionReport(data: unknown, window: AnalyticsWindow): AcquisitionReport | null {
  if (!isRecord(data) || !isBreakdown(data.breakdown)) return null;
  const report = whole({
    newPlayers: compared(data.newPlayers),
    newVisitors: compared(data.newVisitors),
    shown: comparedOrNull(data.shown),
    shownVisitors: comparedOrNull(data.shownVisitors),
    daily: dailyByChannel(data.daily, window.days),
    funnel: rows(data.funnel, FUNNEL_STEPS_MAX, funnelCount, (row) => row.step),
    breakdown: data.breakdown,
    attribution: isAttribution(data.attribution) ? data.attribution : undefined,
    sources: rows(data.sources, SOURCES_MAX, sourceRow(data.breakdown), (row) => row.key),
    campaignBy: isCampaignField(data.campaignBy) ? data.campaignBy : undefined,
    campaigns: rows(data.campaigns, CAMPAIGNS_MAX, campaignRow, (row) => row.name),
  });
  return report ?? null;
}

/**
 * The Revenue report as genex.games answers it: the Nex players spend in the game, what they buy,
 * what a new player spends over time and which sources bring the players who pay. Read with the
 * helpers in `kit.ts`, the way `report-overview.ts` reads its own: the totals, the days and the
 * curve refuse the report when one of them is broken, a broken item or source is left out, an
 * item's name is cleaned as every word a creator wrote is, and what cannot be known yet stays null.
 *
 * The report carries no rate, but the page divides its counts into some (the share of players who
 * pay, an item's share of all Nex), so a part is held to its whole here: more payers than players
 * is no report, and a row that claims more than the period's totals is left out.
 */
import {
  type AnalyticsWindow,
  type Compared,
  RETENTION_SPAN,
  type RevenueReport,
  SourceChannel,
} from "../../../shared/game-analytics.ts";
import { isRecord } from "../gallery.ts";
import {
  amount,
  compared,
  count,
  line,
  measure,
  oneOf,
  orNull,
  type Read,
  rows,
  series,
  shortSeries,
  whole,
} from "./kit.ts";

/** The most items the table keeps. */
const ITEMS_MAX = 50;
/** The longest an item's name and its id may read. */
const NAME_MAX = 200;
const ID_MAX = 120;
/** The spending curve's most points: the first day and each of the `RETENTION_SPAN` days after it. */
const SPEND_POINTS_MAX = RETENTION_SPAN + 1;
const CHANNELS_MAX = Object.keys(SourceChannel).length;

const isChannel = oneOf(SourceChannel);

type Item = RevenueReport["items"][number];
type Source = RevenueReport["sources"][number];

/** The period's totals: Nex, purchases, the players who paid and everyone who played. */
interface Totals {
  nex: Compared;
  purchases: Compared;
  payers: Compared;
  players: Compared;
}

/** The totals, or undefined when one is broken or more players paid than played. */
function totalsOf(data: Record<string, unknown>): Totals | undefined {
  const totals = whole({
    nex: compared(data.nex),
    purchases: compared(data.purchases),
    payers: compared(data.payers),
    players: compared(data.players),
  });
  if (!totals) return undefined;
  const { payers, players } = totals;
  return payers.now <= players.now && payers.before <= players.before ? totals : undefined;
}

/**
 * Something that was bought. Its price is null when it has no one price. A row with more buyers
 * than sales, or more Nex than was spent in all, cannot be right and is left out.
 */
const itemWithin =
  (totals: Totals): Read<Item> =>
  (value) => {
    if (!isRecord(value)) return undefined;
    const id = line(value.id, ID_MAX);
    const name = line(value.name, NAME_MAX);
    const read = whole({
      price: orNull(count)(value.price),
      sold: count(value.sold),
      buyers: count(value.buyers),
      nex: count(value.nex),
    });
    if (!id || !name || !read) return undefined;
    const adds = read.buyers <= read.sold && read.nex <= totals.nex.now;
    return adds ? { id, name, ...read } : undefined;
  };

/**
 * The players a channel first brought and what they spent. A channel the app does not know is left
 * out, and so is a row with more payers than players or more than the period's totals.
 */
const sourceWithin =
  (totals: Totals): Read<Source> =>
  (value) => {
    if (!isRecord(value) || !isChannel(value.channel)) return undefined;
    const read = whole({ players: count(value.players), payers: count(value.payers), nex: count(value.nex) });
    if (!read) return undefined;
    const adds = read.payers <= read.players && read.players <= totals.players.now && read.nex <= totals.nex.now;
    return adds ? { channel: value.channel, ...read } : undefined;
  };

/** The Revenue report for `window`, or null when `data` is not one. */
export function toRevenueReport(data: unknown, window: AnalyticsWindow): RevenueReport | null {
  if (!isRecord(data)) return null;
  const totals = totalsOf(data);
  if (!totals) return null;
  const report = whole({
    ...totals,
    nexPerPlayerDay: measure(data.nexPerPlayerDay),
    daily: series(data.daily, window.days, count),
    dailyBefore: series(data.dailyBefore, window.days, count),
    items: rows(data.items, ITEMS_MAX, itemWithin(totals), (row) => row.id),
    spend: shortSeries(data.spend, SPEND_POINTS_MAX, orNull(amount)),
    firstPurchaseDay: orNull(count)(data.firstPurchaseDay),
    sources: rows(data.sources, CHANNELS_MAX, sourceWithin(totals), (row) => row.channel),
  });
  return report ?? null;
}

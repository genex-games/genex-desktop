/**
 * A fixture game's Revenue report as genex.games answers it: the Nex players spend in the game. Made
 * from the game's sample (`sample.ts`), the way `fixture-overview.ts` makes its own, so its numbers
 * agree with every other report of the game: the Nex (day by day too), the purchases, the payers and
 * everyone who played are the sample's, and the items and the sources share those totals out.
 *
 * The rich game's 30 days are the numbers the page was designed with. Over another period, and for a
 * steady game, the sample's Nex for each purchase is another, so the same Store sells more of its
 * cheap or of its dear items until its sales cost that much; what whole sales cannot add up to is in
 * a tip jar, which has no price. A young game has sold nothing.
 */
import {
  type GameReportOptions,
  RETENTION_SPAN,
  type RevenueReport,
  SourceChannel,
} from "../../../shared/game-analytics.ts";
import { type GameSample, noise, SampleKind, spread } from "./sample.ts";

/** The design's Store: each item's price, and how many were sold to how many players over its 30 days. */
const STORE = [
  { id: "storm-lantern-skin", name: "Storm Lantern skin", price: 150, sold: 131, buyers: 131 },
  { id: "extra-life-pack", name: "Extra life pack", price: 40, sold: 402, buyers: 188 },
  { id: "glow-trail", name: "Glow trail", price: 80, sold: 96, buyers: 96 },
  { id: "level-skip", name: "Level skip", price: 25, sold: 208, buyers: 97 },
] as const;

/** The Store's items from the dearest, by their place in `STORE`. */
const DEAREST_FIRST = STORE.map((_, index) => index).sort((a, b) => (STORE[b]?.price ?? 0) - (STORE[a]?.price ?? 0));
/** What players pay what they like for: it has no price, and holds the Nex whole sales do not add up to. */
const TIP_JAR = { id: "tip-jar", name: "Tip jar" } as const;
/** How a lean towards cheap items is measured: by this many Nex of an item's price. */
const PRICE_SCALE = 100;
/** The strongest lean, which sells only the cheapest or only the dearest item, and the halvings that find one. */
const TILT_MAX = 12;
const TILT_STEPS = 48;

/**
 * How the design's new players pay, by the channel that first brought them: the share of them who
 * pay, and the Nex each of those spends.
 */
const CHANNEL_SPEND = {
  [SourceChannel.Genex]: { paying: 196 / 3790, nexEach: 17_434 / 196 },
  [SourceChannel.Campaigns]: { paying: 62 / 2480, nexEach: 5952 / 62 },
  [SourceChannel.Social]: { paying: 27 / 790, nexEach: 2370 / 27 },
  [SourceChannel.Direct]: { paying: 38 / 520, nexEach: 3380 / 38 },
  [SourceChannel.Search]: { paying: 4 / 170, nexEach: 357 / 4 },
  [SourceChannel.Other]: { paying: 2 / 90, nexEach: 171 / 2 },
} as const satisfies Record<SourceChannel, { paying: number; nexEach: number }>;
/** The same for the design's players who first played before the period: they pay a little more often, and far more. */
const RETURNING_SPEND = { paying: 83 / 1460, nexEach: 18_946 / 83 } as const;

/** The design's curve of what a new player has spent: on the first day, and how fast it grows after. */
const SPEND_FIRST_DAY = 1.1;
const SPEND_GROWTH = 1.194;
/** The day the design's players typically first buy on, and the latest a steady game's do. */
const RICH_FIRST_PURCHASE_DAY = 2;
const FIRST_PURCHASE_DAY_MAX = 4;
/** How far a steady game's details stray from the design's: an item's and a channel's share, and the whole curve. */
const SHARE_SWING = 0.4;
const CURVE_SWING = 0.8;
/** Where each detail's `noise` starts, so no two details move together. */
const NOISE = { items: 610, sources: 630, curve: 650, firstPurchase: 651 } as const;

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const round1 = (value: number): number => Math.round(value * 10) / 10;
const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * How much a detail of `sample` strays from the design's: not at all for the rich game, whose
 * numbers are the design's, and up to half of `swing` either way for another, steady for its slug.
 */
function vary(sample: GameSample, index: number, swing = SHARE_SWING): number {
  if (sample.kind === SampleKind.Rich) return 1;
  return 1 - swing / 2 + noise(sample.seed, index) * swing;
}

/** Nex for each player-day, to the cent: null when nobody played. */
const perPlayerDay = (nex: number, playerDays: number): number | null =>
  playerDays > 0 ? round2(nex / playerDays) : null;

/** The Store's sales in proportion `sales`, leaning by `tilt` towards its cheap items (or, below zero, its dear ones). */
const tilted = (sales: readonly number[], tilt: number): number[] =>
  STORE.map((item, index) => (sales[index] ?? 0) * Math.exp((-tilt * item.price) / PRICE_SCALE));

/** What a sale costs on average when the Store sells in proportion `sales`. */
const meanPrice = (sales: readonly number[]): number =>
  sum(STORE.map((item, index) => item.price * (sales[index] ?? 0))) / sum(sales);

/**
 * The proportion the Store sells in when a purchase costs `mean` Nex on average: `sales`, leaned
 * towards the cheap or the dear items as far as that takes. The lean is found by halving, since a
 * stronger one always makes the average sale cheaper.
 */
function salesAt(sales: readonly number[], mean: number): number[] {
  let low = -TILT_MAX;
  let high = TILT_MAX;
  for (let step = 0; step < TILT_STEPS; step += 1) {
    const middle = (low + high) / 2;
    if (meanPrice(tilted(sales, middle)) > mean) low = middle;
    else high = middle;
  }
  return tilted(sales, (low + high) / 2);
}

/**
 * How many of each item were sold, and the tips: the period's purchases shared out so the priced
 * items' sales cost the period's Nex, to the Nex. When whole sales cannot add up to it, one purchase
 * is a tip of what is left, and a sale of the dearest item becomes a tip until every tip is a Nex at
 * least.
 */
function salesOf(sample: GameSample): { sold: number[]; tips: number; tipped: number } {
  const purchases = sample.purchases.now;
  const nex = sample.nex.now;
  const wanted = salesAt(
    STORE.map((item, index) => item.sold * vary(sample, NOISE.items + index)),
    nex / purchases,
  );
  const cost = (sold: readonly number[]) => sum(STORE.map((item, index) => item.price * (sold[index] ?? 0)));
  const exact = spread(purchases, wanted);
  if (cost(exact) === nex) return { sold: exact, tips: 0, tipped: 0 };
  const sold = spread(purchases - 1, wanted);
  let tips = 1;
  while (nex - cost(sold) < tips) {
    const dearest = DEAREST_FIRST.find((index) => (sold[index] ?? 0) > 0);
    if (dearest === undefined) break;
    sold[dearest] = (sold[dearest] ?? 0) - 1;
    tips += 1;
  }
  return { sold, tips, tipped: nex - cost(sold) };
}

/** What was bought, most Nex first: the Store's items that sold, and the tip jar when it holds something. */
function itemsOf(sample: GameSample): RevenueReport["items"] {
  if (sample.purchases.now === 0) return [];
  const { sold, tips, tipped } = salesOf(sample);
  const priced = STORE.map((item, index) => {
    const sales = sold[index] ?? 0;
    const regulars = Math.max(1, Math.round((sales * item.buyers) / item.sold));
    return {
      id: item.id,
      name: item.name,
      price: item.price,
      sold: sales,
      buyers: Math.min(sales, sample.payers.now, regulars),
      nex: item.price * sales,
    };
  });
  const jar = { ...TIP_JAR, price: null, sold: tips, buyers: Math.min(tips, sample.payers.now), nex: tipped };
  return [...priced, jar].filter((item) => item.sold > 0).sort((a, b) => b.nex - a.nex);
}

/**
 * What a new player has spent by each day since their first play. A day is known once the period
 * and the game are that old, as the sample's retention is; a game that sold nothing is at zero.
 */
function spendOf(sample: GameSample): (number | null)[] {
  const scale = sample.purchases.now > 0 ? vary(sample, NOISE.curve, CURVE_SWING) : 0;
  return Array.from({ length: RETENTION_SPAN + 1 }, (_, day) => {
    const known = day === 0 ? sample.newPlayers.now > 0 : (sample.retention.rates[day - 1] ?? null) !== null;
    return known ? round1((SPEND_FIRST_DAY + SPEND_GROWTH * Math.log(1 + day)) * scale) : null;
  });
}

/** The day players typically first buy on: the design's for the rich game, null where nothing was bought. */
function firstPurchaseDayOf(sample: GameSample): number | null {
  if (sample.purchases.now === 0) return null;
  if (sample.kind === SampleKind.Rich) return RICH_FIRST_PURCHASE_DAY;
  return 1 + Math.floor(noise(sample.seed, NOISE.firstPurchase) * FIRST_PURCHASE_DAY_MAX);
}

/**
 * Everyone who played, by the channel that first brought them, in the sample's order: a channel's
 * new players and its share of the ones from before the period, with the payers and the Nex shared
 * out as the design's channels pay. A channel with no player has no row.
 */
function sourcesOf(sample: GameSample): RevenueReport["sources"] {
  const fresh = sample.channels.map((channel) => channel.newPlayers);
  const back = spread(sample.players.now - sample.newPlayers.now, fresh);
  const paying = sample.channels.map(({ channel }, index) => {
    const design = CHANNEL_SPEND[channel];
    const newPayers = (fresh[index] ?? 0) * design.paying * vary(sample, NOISE.sources + index);
    const oldPayers = (back[index] ?? 0) * RETURNING_SPEND.paying;
    return { payers: newPayers + oldPayers, nex: newPayers * design.nexEach + oldPayers * RETURNING_SPEND.nexEach };
  });
  const payers = spread(
    sample.payers.now,
    paying.map((one) => one.payers),
  );
  const nex = spread(
    sample.nex.now,
    paying.map((one, index) => ((payers[index] ?? 0) > 0 ? one.nex : 0)),
  );
  return sample.channels
    .map(({ channel }, index) => ({
      channel,
      players: (fresh[index] ?? 0) + (back[index] ?? 0),
      payers: payers[index] ?? 0,
      nex: nex[index] ?? 0,
    }))
    .filter((source) => source.players > 0);
}

/** The Revenue report's data for `sample`; it takes no options. */
export function fixtureRevenue(sample: GameSample, _options: GameReportOptions): RevenueReport {
  return {
    nex: { now: sample.nex.now, before: sample.nex.before },
    purchases: sample.purchases,
    payers: sample.payers,
    players: { now: sample.players.now, before: sample.players.before },
    nexPerPlayerDay: {
      now: perPlayerDay(sample.nex.now, sum(sample.players.daily)),
      before: perPlayerDay(sample.nex.before, sum(sample.players.dailyBefore)),
    },
    daily: sample.nex.daily,
    dailyBefore: sample.nex.dailyBefore,
    items: itemsOf(sample),
    spend: spendOf(sample),
    firstPurchaseDay: firstPurchaseDayOf(sample),
    sources: sourcesOf(sample),
  };
}

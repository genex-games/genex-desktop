/**
 * A fixture game's Acquisition report as genex.games answers it: where new players come from and
 * how far they get. Made from the game's sample (`sample.ts`), the way `fixture-overview.ts` makes
 * its own, so its numbers agree with every other report of the game: the totals, the days by
 * channel, the funnel, the channels' own totals and the campaign are the sample's.
 *
 * What the sample does not hold is shared out here: a channel's new visitors and new players over
 * what is inside it (Genex's surfaces, a channel's sites, the campaigns), and the whole game's over
 * countries and devices. Every split sums back to what it splits, no row has more players than
 * visitors, and every split's Day 1, Day 7 and Nex per player average out to the whole game's. The
 * rich game's shares are the numbers the page was designed with; the others' move with their slug.
 */
import {
  type AcquisitionReport,
  Attribution,
  CampaignField,
  type CampaignRow,
  type Compared,
  DeviceClass,
  type GameReportOptions,
  GenexSurface,
  SourceBreakdown,
  SourceChannel,
  type SourceNumbers,
  type SourceRow,
} from "../../../shared/game-analytics.ts";
import { PLAY_ORIGIN } from "../../../shared/play.ts";
import { type GameSample, noise, SampleKind, spread } from "./sample.ts";

/** New visitors and the new players among them. */
type Counts = Pick<SourceNumbers, "newVisitors" | "newPlayers">;
/** How a group of new players turns out. */
type Rates = Pick<SourceNumbers, "day1" | "day7" | "nexPerPlayer">;
/** How a group's players turn out against everyone's: a multiplier of each of the whole's numbers. */
type Lift = Record<keyof Rates, number>;

/** A source before it has numbers: its key, its weight among its siblings, and how its players turn out. */
interface Spec {
  key: string;
  /** Its share of the new players, and of the new visitors who never got into the game. */
  players: number;
  bounced: number;
  lift: Lift;
  /** Times Genex shows the game there for each new visitor it brings; left out where nothing is shown. */
  shownPerVisitor?: number;
}

/** A source with its counts: what `numbered` gives its Day 1, Day 7 and Nex per player. */
interface Group extends Counts {
  key: string;
  shown: number | null;
  lift: Lift;
  /** Its numbers when they are already known (a campaign's), so the others even out around them. */
  rates: Rates | null;
}

/** A campaign as its links tag it, with the site its visitors came from. */
interface CampaignSpec extends Omit<Spec, "key"> {
  name: string;
  source: string;
  medium: string;
  site: string;
  content: string | null;
  term: string | null;
}

/** A campaign with what it brought. */
interface Campaign extends CampaignRow {
  site: string;
  content: string | null;
  term: string | null;
}

/** One game's acquisition, which every table of its report is cut from. */
interface Scene {
  sample: GameSample;
  /** The whole game's Day 1, Day 7 and Nex per new player: what every split averages out to. */
  whole: Rates;
  /** The campaigns, by the first one that brought each player. */
  campaigns: Campaign[];
  /** Times Genex showed the game on each surface; null while it does not count them. */
  shown: ReadonlyMap<string, number> | null;
}

/** The design's whole game: what its per-source numbers are told against. */
const DESIGN: Rates & Lift = { day1: 0.345, day7: 0.145, nexPerPlayer: 29_664 / 7840 };
/** The share of the Nex a game's players spend that its new players spend: the design's 29,664 of 48,610. */
const NEW_PLAYER_NEX = 29_664 / 48_610;
/** The design's Genex: the new visitors it showed the game to, of all new visitors, and how often a showing brought one. */
const DESIGN_SHOWN = { visitors: 8140 / 19_380, clicked: 8140 / 157_900 } as const;
/** How much the rich game's click-through grew over the period before, and the least a made-up one is. */
const CLICKED_GAIN = 0.004;
const CLICKED_MIN = 0.005;
/**
 * With the latest source credited, the share of a channel's players who came back another way, and
 * where they came back from: two in three through Genex, the rest by typing the address.
 */
const LATEST_MOVED = 0.18;
const LATEST_TO: readonly SourceChannel[] = [SourceChannel.Genex, SourceChannel.Direct];
const LATEST_SHARES = [2, 1] as const;
/** Where `noise` starts for each list a game's slug moves, so no two lists move alike. */
const NOISE_AT = { surfaces: 500, sites: 540, campaigns: 580, countries: 620, devices: 680, clicked: 700 } as const;
/** A game that is not the design's has each weight between this much and this much more of the list's. */
const WEIGHT_FLOOR = 0.6;
const WEIGHT_SWING = 0.8;

const NO_RATES: Rates = { day1: null, day7: null, nexPerPlayer: null };
/** A rate is at most one; Nex per player has no top. */
const TOP: Lift = { day1: 1, day7: 1, nexPerPlayer: Number.POSITIVE_INFINITY };
/** Rates keep three decimals, Nex per player two. */
const DECIMALS: Lift = { day1: 3, day7: 3, nexPerPlayer: 2 };

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const rounded = (value: number, decimals: number): number => Math.round(value * 10 ** decimals) / 10 ** decimals;
const by = (day1: number, day7: number, nexPerPlayer: number): Lift => ({ day1, day7, nexPerPlayer });
/** A group's Day 1, Day 7 and Nex per player on the design, as multipliers of the design's whole game. */
const designed = (day1: number, day7: number, nexPerPlayer: number): Lift =>
  by(day1 / DESIGN.day1, day7 / DESIGN.day7, nexPerPlayer / DESIGN.nexPerPlayer);
const mostFirst = (a: Counts, b: Counts): number => b.newPlayers - a.newPlayers || b.newVisitors - a.newVisitors;

/** How each channel's players turn out on the design. Campaigns' own is the average of its campaigns. */
const CHANNEL_LIFT = {
  [SourceChannel.Genex]: designed(0.384, 0.173, 4.6),
  [SourceChannel.Campaigns]: designed(0.3, 0.112, 2.4),
  [SourceChannel.Social]: designed(0.31, 0.121, 3),
  [SourceChannel.Direct]: designed(0.369, 0.16, 6.5),
  [SourceChannel.Search]: designed(0.271, 0.094, 2.1),
  [SourceChannel.Other]: designed(0.244, 0.089, 1.9),
} as const satisfies Record<SourceChannel, Lift>;

/** The design's Genex: what each surface brought, how its players turn out, and how often it showed the game. */
const SURFACES: readonly Spec[] = [
  {
    key: GenexSurface.Feed,
    players: 1540,
    bounced: 2120,
    lift: designed(0.362, 0.158, 4.1),
    shownPerVisitor: 96_400 / 3660,
  },
  {
    key: GenexSurface.Featured,
    players: 1180,
    bounced: 1290,
    lift: designed(0.395, 0.179, 4.9),
    shownPerVisitor: 41_200 / 2470,
  },
  {
    key: GenexSurface.Search,
    players: 520,
    bounced: 540,
    lift: designed(0.413, 0.194, 5.6),
    shownPerVisitor: 9800 / 1060,
  },
  {
    key: GenexSurface.Profile,
    players: 250,
    bounced: 360,
    lift: designed(0.38, 0.176, 4.4),
    shownPerVisitor: 6300 / 610,
  },
  // A friend's invite is not Genex showing the game.
  { key: GenexSurface.Friends, players: 210, bounced: 270, lift: designed(0.448, 0.229, 6.2) },
  {
    key: GenexSurface.Remixes,
    players: 90,
    bounced: 250,
    lift: designed(0.289, 0.111, 1.8),
    shownPerVisitor: 4200 / 340,
  },
];

/** The sites inside the channels that are made of sites. */
const SITES: Partial<Record<SourceChannel, readonly Spec[]>> = {
  [SourceChannel.Social]: [
    { key: "tiktok.com", players: 34, bounced: 40, lift: by(0.9, 0.84, 0.8) },
    { key: "x.com", players: 24, bounced: 22, lift: by(1.06, 1.1, 1.15) },
    { key: "instagram.com", players: 20, bounced: 22, lift: by(0.96, 0.95, 0.9) },
    { key: "reddit.com", players: 14, bounced: 10, lift: by(1.14, 1.22, 1.3) },
    { key: "facebook.com", players: 8, bounced: 6, lift: by(1, 0.98, 1.05) },
  ],
  [SourceChannel.Search]: [
    { key: "google.com", players: 78, bounced: 76, lift: by(1, 1, 1) },
    { key: "bing.com", players: 14, bounced: 15, lift: by(1.05, 1.02, 1.1) },
    { key: "duckduckgo.com", players: 8, bounced: 9, lift: by(0.95, 0.96, 0.8) },
  ],
  [SourceChannel.Other]: [
    { key: "itch.io", players: 52, bounced: 44, lift: by(1.12, 1.2, 1.2) },
    { key: "newgrounds.com", players: 30, bounced: 34, lift: by(0.92, 0.85, 0.8) },
    { key: "gamejolt.com", players: 18, bounced: 22, lift: by(0.8, 0.74, 0.7) },
  ],
};

/**
 * The design's campaigns. The first is the sample's own: its tags, what it brought and its Day 1
 * and Day 7 come from there, and only where its links lead from and its Nex are told here.
 */
const RICH_CAMPAIGNS: readonly CampaignSpec[] = [
  {
    name: "launch_trailer",
    source: "tiktok",
    medium: "social",
    site: "tiktok.com",
    content: "cut_15s",
    term: null,
    players: 1460,
    bounced: 1960,
    lift: designed(0.26, 0.082, 1.6),
  },
  {
    name: "devlog_12",
    source: "youtube",
    medium: "video",
    site: "youtube.com",
    content: "description_link",
    term: null,
    players: 520,
    bounced: 660,
    lift: designed(0.352, 0.149, 3.4),
  },
  {
    name: "halloween_update",
    source: "discord",
    medium: "community",
    site: "discord.com",
    content: "pinned_post",
    term: null,
    players: 310,
    bounced: 330,
    lift: designed(0.41, 0.197, 4.9),
  },
  {
    name: "newsletter_oct",
    source: "email",
    medium: "newsletter",
    site: "mail.google.com",
    content: null,
    term: null,
    players: 130,
    bounced: 280,
    lift: designed(0.308, 0.123, 2.8),
  },
  {
    name: "reddit_webgames",
    source: "reddit",
    medium: "social",
    site: "reddit.com",
    content: null,
    term: "browser_games",
    players: 60,
    bounced: 300,
    lift: designed(0.217, 0.067, 0.9),
  },
];

/** The campaigns of a game that is not the design's. */
const STEADY_CAMPAIGNS: readonly CampaignSpec[] = [
  {
    name: "devlog_3",
    source: "youtube",
    medium: "video",
    site: "youtube.com",
    content: "description_link",
    term: null,
    players: 5,
    bounced: 6,
    lift: by(0.98, 0.95, 0.8),
  },
  {
    name: "discord_drop",
    source: "discord",
    medium: "community",
    site: "discord.com",
    content: null,
    term: null,
    players: 3,
    bounced: 3,
    lift: by(1.1, 1.2, 1.1),
  },
  {
    name: "shorts_teaser",
    source: "tiktok",
    medium: "social",
    site: "tiktok.com",
    content: "cut_15s",
    term: null,
    players: 4,
    bounced: 8,
    lift: by(0.72, 0.6, 0.45),
  },
];

/** Where players are, most first. */
const COUNTRIES: readonly Spec[] = [
  { key: "US", players: 31, bounced: 30, lift: by(1.04, 1.06, 1.4) },
  { key: "BR", players: 11, bounced: 13, lift: by(0.97, 0.92, 0.5) },
  { key: "DE", players: 8, bounced: 7, lift: by(1.05, 1.1, 1.3) },
  { key: "GB", players: 7, bounced: 7, lift: by(1.03, 1.05, 1.25) },
  { key: "FR", players: 6, bounced: 6, lift: by(1, 1.02, 1.1) },
  { key: "IN", players: 6, bounced: 9, lift: by(0.88, 0.8, 0.3) },
  { key: "TR", players: 5, bounced: 6, lift: by(0.95, 0.9, 0.45) },
  { key: "PL", players: 5, bounced: 4, lift: by(1.06, 1.08, 0.9) },
  { key: "JP", players: 4, bounced: 4, lift: by(1.08, 1.15, 1.6) },
  { key: "MX", players: 4, bounced: 5, lift: by(0.94, 0.9, 0.5) },
  { key: "CA", players: 4, bounced: 3, lift: by(1.03, 1.05, 1.3) },
  { key: "KR", players: 3, bounced: 3, lift: by(1.07, 1.1, 1.5) },
  { key: "ES", players: 3, bounced: 3, lift: by(0.99, 1, 0.9) },
  { key: "ID", players: 3, bounced: 5, lift: by(0.9, 0.82, 0.3) },
];

/** What players play on: a phone loads the game slower, so fewer of its visitors get in and stay. */
const DEVICES: readonly Spec[] = [
  { key: DeviceClass.Computer, players: 62, bounced: 48, lift: by(1.06, 1.1, 1.2) },
  { key: DeviceClass.Phone, players: 32, bounced: 46, lift: by(0.9, 0.84, 0.65) },
  { key: DeviceClass.Tablet, players: 6, bounced: 6, lift: by(0.96, 0.92, 0.8) },
];

/** A list's weights as a game's slug moves them; the design's game keeps the list as written. */
function moved<Item extends Pick<Spec, "players" | "bounced">>(
  items: readonly Item[],
  sample: GameSample,
  at: number,
): Item[] {
  if (sample.kind === SampleKind.Rich) return [...items];
  const swing = (index: number) => WEIGHT_FLOOR + WEIGHT_SWING * noise(sample.seed, at + index);
  return items.map((item, index) => ({
    ...item,
    players: item.players * swing(index),
    bounced: item.bounced * swing(index + items.length),
  }));
}

/**
 * `total` shared out over `weights`: the new players by their weights, the new visitors who never
 * played by theirs, so the parts sum to the total and none has more players than visitors.
 */
function sharedOut(total: Counts, weights: readonly Pick<Spec, "players" | "bounced">[]): Counts[] {
  const players = spread(
    total.newPlayers,
    weights.map((weight) => weight.players),
  );
  const bounced = spread(
    Math.max(0, total.newVisitors - total.newPlayers),
    weights.map((weight) => weight.bounced),
  );
  return weights.map((_, index) => {
    const newPlayers = players[index] ?? 0;
    return { newPlayers, newVisitors: newPlayers + (bounced[index] ?? 0) };
  });
}

/** `total` shared out over `specs`, as sources still without their numbers. */
function groupsOf(total: Counts, specs: readonly Spec[]): Group[] {
  const counts = sharedOut(total, specs);
  return specs.map((spec, index) => ({
    key: spec.key,
    newVisitors: counts[index]?.newVisitors ?? 0,
    newPlayers: counts[index]?.newPlayers ?? 0,
    shown: null,
    lift: spec.lift,
    rates: null,
  }));
}

/**
 * What each lift is multiplied by so the groups' numbers, weighted by their new players, average
 * out to the whole's. Groups whose numbers are already known keep them; the others make up for it.
 */
function evening(groups: readonly Group[], whole: Rates): Lift {
  const people = sum(groups.map((group) => group.newPlayers));
  const scale = (measure: keyof Rates): number => {
    const total = whole[measure];
    if (total === null) return 1;
    const known = sum(groups.map((group) => group.newPlayers * (group.rates?.[measure] ?? 0)));
    const open = sum(groups.map((group) => (group.rates ? 0 : group.newPlayers * total * group.lift[measure])));
    return open > 0 ? Math.max(0, total * people - known) / open : 1;
  };
  return by(scale("day1"), scale("day7"), scale("nexPerPlayer"));
}

/** A group's numbers: null with nobody in it, and where the whole's is not known yet. */
function ratesOf(group: Group, whole: Rates, scale: Lift): Rates {
  if (group.newPlayers === 0) return NO_RATES;
  if (group.rates) return group.rates;
  const at = (measure: keyof Rates): number | null => {
    const total = whole[measure];
    if (total === null) return null;
    return rounded(Math.min(TOP[measure], total * group.lift[measure] * scale[measure]), DECIMALS[measure]);
  };
  return { day1: at("day1"), day7: at("day7"), nexPerPlayer: at("nexPerPlayer") };
}

/** The groups that brought somebody as rows, most new players first, their numbers averaging out to `whole`. */
function numbered(groups: readonly Group[], whole: Rates): SourceRow[] {
  const scale = evening(groups, whole);
  return groups
    .filter((group) => group.newVisitors > 0)
    .map(({ key, shown, newVisitors, newPlayers, ...group }) => ({
      key,
      shown,
      newVisitors,
      newPlayers,
      ...ratesOf({ key, shown, newVisitors, newPlayers, ...group }, whole, scale),
      parts: [],
    }))
    .sort(mostFirst);
}

/** The new players' average of each number over `rows`; null where no row with players knows it. */
function averaged(rows: readonly (Counts & Rates)[]): Rates {
  const of = (measure: keyof Rates): number | null => {
    const known = rows.filter((row) => row[measure] !== null && row.newPlayers > 0);
    const people = sum(known.map((row) => row.newPlayers));
    if (people === 0) return null;
    return rounded(sum(known.map((row) => row.newPlayers * (row[measure] ?? 0))) / people, DECIMALS[measure]);
  };
  return { day1: of("day1"), day7: of("day7"), nexPerPlayer: of("nexPerPlayer") };
}

/** The whole game's Day 1 and Day 7 (the sample's own) and the Nex its new players spent, each. */
function wholeOf(sample: GameSample): Rates {
  const people = sample.newPlayers.now;
  return {
    day1: sample.day1.now,
    day7: sample.day7.now,
    nexPerPlayer: people > 0 ? (sample.nex.now * NEW_PLAYER_NEX) / people : null,
  };
}

/** What a channel brought, as the sample counts it by first source. */
const firstCredit = (sample: GameSample, channel: SourceChannel): Counts =>
  sample.channels.find((one) => one.channel === channel) ?? { newVisitors: 0, newPlayers: 0 };

/**
 * The game's campaigns with what each brought: together they are the Campaigns channel. The
 * sample's campaign comes first with its own numbers; the others share out what is left.
 */
function campaignsOf(sample: GameSample, whole: Rates): Campaign[] {
  const channel = firstCredit(sample, SourceChannel.Campaigns);
  if (channel.newVisitors === 0) return [];
  const specs = moved(sample.kind === SampleKind.Rich ? RICH_CAMPAIGNS : STEADY_CAMPAIGNS, sample, NOISE_AT.campaigns);
  const lead = sample.campaign;
  const others = lead ? specs.slice(1) : specs;
  const left = lead
    ? { newVisitors: channel.newVisitors - lead.newVisitors, newPlayers: channel.newPlayers - lead.newPlayers }
    : channel;
  const counts = [...(lead ? [lead] : []), ...sharedOut(left, others)];
  return specs
    .map((spec, index) => {
      const { newVisitors = 0, newPlayers = 0 } = counts[index] ?? {};
      const group: Group = { key: spec.name, newVisitors, newPlayers, shown: null, lift: spec.lift, rates: null };
      const rates = ratesOf(group, whole, by(1, 1, 1));
      const own = index === 0 && lead && newPlayers > 0;
      return {
        name: own ? lead.name : spec.name,
        source: own ? lead.source : spec.source,
        medium: own ? lead.medium : spec.medium,
        newVisitors,
        newPlayers,
        ...rates,
        day1: own && rates.day1 !== null ? lead.day1 : rates.day1,
        day7: own && rates.day7 !== null ? lead.day7 : rates.day7,
        site: spec.site,
        content: spec.content,
        term: spec.term,
      };
    })
    .filter((campaign) => campaign.newVisitors > 0);
}

/** The tag a campaign carries for each way of grouping the table. */
const TAG_OF = {
  [CampaignField.Campaign]: (campaign) => campaign.name,
  [CampaignField.Source]: (campaign) => campaign.source,
  [CampaignField.Medium]: (campaign) => campaign.medium,
  [CampaignField.Content]: (campaign) => campaign.content,
  [CampaignField.Term]: (campaign) => campaign.term,
} as const satisfies Record<CampaignField, (campaign: Campaign) => string | null>;

/**
 * The campaigns table grouped by a tag: one row a value, with the source and medium that brought
 * it most visitors. A campaign whose links carry no such tag is in no row.
 */
function campaignRows(campaigns: readonly Campaign[], field: CampaignField): CampaignRow[] {
  const groups = new Map<string, Campaign[]>();
  for (const campaign of campaigns) {
    const value = TAG_OF[field](campaign);
    if (value !== null) groups.set(value, [...(groups.get(value) ?? []), campaign]);
  }
  return [...groups]
    .map(([name, members]) => {
      const lead = members.reduce((most, one) => (one.newVisitors > most.newVisitors ? one : most));
      return {
        name,
        source: lead.source,
        medium: lead.medium,
        newVisitors: sum(members.map((one) => one.newVisitors)),
        newPlayers: sum(members.map((one) => one.newPlayers)),
        ...averaged(members),
      };
    })
    .sort(mostFirst);
}

/**
 * Times Genex showed the game on each surface, from the visitors each first brought. A game two
 * days old has none: Genex does not count them yet.
 */
function shownBySurface(sample: GameSample): ReadonlyMap<string, number> | null {
  if (sample.kind === SampleKind.Young) return null;
  const surfaces = moved(SURFACES, sample, NOISE_AT.surfaces);
  const counts = sharedOut(firstCredit(sample, SourceChannel.Genex), surfaces);
  const shown = new Map<string, number>();
  surfaces.forEach(({ key, shownPerVisitor }, index) => {
    if (shownPerVisitor !== undefined) shown.set(key, Math.round((counts[index]?.newVisitors ?? 0) * shownPerVisitor));
  });
  return shown;
}

/**
 * Times Genex showed the game and the new visitors that came of it, now and over the period
 * before, when a little fewer of those who saw it opened it.
 */
function shownOf({ sample, shown }: Scene): Pick<AcquisitionReport, "shown" | "shownVisitors"> {
  if (!shown) return { shown: null, shownVisitors: null };
  const surfaces = moved(SURFACES, sample, NOISE_AT.surfaces);
  const counts = sharedOut(firstCredit(sample, SourceChannel.Genex), surfaces);
  const times = sum([...shown.values()]);
  const visitors = sum(counts.map((count, index) => (shown.has(surfaces[index]?.key ?? "") ? count.newVisitors : 0)));
  const share = sample.newVisitors.now > 0 ? visitors / sample.newVisitors.now : DESIGN_SHOWN.visitors;
  const gain =
    sample.kind === SampleKind.Rich ? CLICKED_GAIN : (noise(sample.seed, NOISE_AT.clicked) - 0.4) * 2 * CLICKED_GAIN;
  const clickedBefore = Math.max(CLICKED_MIN, (times > 0 ? visitors / times : DESIGN_SHOWN.clicked) - gain);
  const visitorsBefore = Math.round(sample.newVisitors.before * share);
  const compared = (now: number, before: number): Compared => ({ now, before });
  return {
    shown: compared(times, Math.round(visitorsBefore / clickedBefore)),
    shownVisitors: compared(visitors, visitorsBefore),
  };
}

/**
 * What each channel brought by the source credited. By the latest one, part of the players a
 * campaign, a post or a search first brought count for Genex or for no source at all: they came
 * back that way.
 */
function creditedChannels(sample: GameSample, attribution: Attribution): (Counts & { channel: SourceChannel })[] {
  const first = sample.channels.map(({ channel, newVisitors, newPlayers }) => ({ channel, newVisitors, newPlayers }));
  if (attribution === Attribution.First) return first;
  const stays = (channel: SourceChannel) => LATEST_TO.some((to) => to === channel);
  const gone = first.map((row) => ({
    newVisitors: stays(row.channel) ? 0 : Math.round(row.newVisitors * LATEST_MOVED),
    newPlayers: stays(row.channel) ? 0 : Math.round(row.newPlayers * LATEST_MOVED),
  }));
  const gained = {
    newVisitors: spread(sum(gone.map((row) => row.newVisitors)), LATEST_SHARES),
    newPlayers: spread(sum(gone.map((row) => row.newPlayers)), LATEST_SHARES),
  };
  const gain = (channel: SourceChannel, count: keyof Counts): number => gained[count][LATEST_TO.indexOf(channel)] ?? 0;
  return first
    .map((row, index) => ({
      channel: row.channel,
      newVisitors: row.newVisitors - (gone[index]?.newVisitors ?? 0) + gain(row.channel, "newVisitors"),
      newPlayers: row.newPlayers - (gone[index]?.newPlayers ?? 0) + gain(row.channel, "newPlayers"),
    }))
    .sort(mostFirst);
}

/** What is inside a channel's row: Genex's surfaces, the sites the campaigns came from, a channel's sites. */
function insideOf(scene: Scene, row: SourceRow): Group[] {
  if (row.key === SourceChannel.Genex) {
    const surfaces = groupsOf(row, moved(SURFACES, scene.sample, NOISE_AT.surfaces));
    return surfaces.map((surface) => ({ ...surface, shown: scene.shown?.get(surface.key) ?? null }));
  }
  if (row.key === SourceChannel.Campaigns) {
    const sites = scene.campaigns.map((campaign) => ({
      key: campaign.site,
      players: campaign.newPlayers,
      bounced: campaign.newVisitors - campaign.newPlayers,
      lift: by(1, 1, 1),
    }));
    return groupsOf(row, sites).map((site, index) => {
      const { day1 = null, day7 = null, nexPerPlayer = null } = scene.campaigns[index] ?? {};
      return { ...site, rates: { day1, day7, nexPerPlayer } };
    });
  }
  const sites = Object.entries(SITES).find(([channel]) => channel === row.key)?.[1] ?? [];
  return groupsOf(row, moved(sites, scene.sample, NOISE_AT.sites));
}

/** The sources by channel: each with what is inside it, Genex with every time it showed the game. */
function channelRows(scene: Scene, attribution: Attribution): SourceRow[] {
  const campaigns = scene.campaigns.length > 0 ? averaged(scene.campaigns) : null;
  const groups = creditedChannels(scene.sample, attribution).map(({ channel, ...counts }) => ({
    key: channel,
    ...counts,
    shown: channel === SourceChannel.Genex && scene.shown ? sum([...scene.shown.values()]) : null,
    lift: CHANNEL_LIFT[channel],
    rates: channel === SourceChannel.Campaigns ? campaigns : null,
  }));
  return numbered(groups, scene.whole).map((row) => ({ ...row, parts: numbered(insideOf(scene, row), row) }));
}

/** The host a visit from inside Genex names as its referrer. */
const GENEX_HOST = new URL(PLAY_ORIGIN.web).host;

/**
 * The sources by the site a visit came from: everything inside Genex is its own site, a site that
 * sends both campaign and plain links is one row, and visits with no referrer are the Direct row.
 */
function referrerRows(scene: Scene, attribution: Attribution): SourceRow[] {
  const sites = channelRows(scene, attribution).flatMap((row) => {
    if (row.key === SourceChannel.Genex) return [{ ...row, key: GENEX_HOST, parts: [] }];
    return row.parts.length > 0 ? row.parts : [row];
  });
  const hosts = new Map<string, SourceRow[]>();
  for (const site of sites) hosts.set(site.key, [...(hosts.get(site.key) ?? []), site]);
  return [...hosts]
    .map(([key, rows]) => ({
      key,
      shown: rows.some((row) => row.shown !== null) ? sum(rows.map((row) => row.shown ?? 0)) : null,
      newVisitors: sum(rows.map((row) => row.newVisitors)),
      newPlayers: sum(rows.map((row) => row.newPlayers)),
      ...averaged(rows),
      parts: [],
    }))
    .sort(mostFirst);
}

/** The whole game shared out over `specs` (countries, devices), Genex's showings going where its visitors are. */
function splitRows(scene: Scene, specs: readonly Spec[], at: number): SourceRow[] {
  const { sample, whole, shown } = scene;
  const total = { newVisitors: sample.newVisitors.now, newPlayers: sample.newPlayers.now };
  const rows = numbered(groupsOf(total, moved(specs, sample, at)), whole);
  if (!shown) return rows;
  const times = spread(
    sum([...shown.values()]),
    rows.map((row) => row.newVisitors),
  );
  return rows.map((row, index) => ({ ...row, shown: times[index] ?? 0 }));
}

/** The sources table for each breakdown. A country and a device are the player's, whichever source is credited. */
const SOURCES = {
  [SourceBreakdown.Channel]: channelRows,
  [SourceBreakdown.Referrer]: referrerRows,
  [SourceBreakdown.Country]: (scene) => splitRows(scene, COUNTRIES, NOISE_AT.countries),
  [SourceBreakdown.Device]: (scene) => splitRows(scene, DEVICES, NOISE_AT.devices),
} as const satisfies Record<SourceBreakdown, (scene: Scene, attribution: Attribution) => SourceRow[]>;

/** The Acquisition report's data for `sample`; it takes `breakdown`, `attribution` and `campaignBy`. */
export function fixtureAcquisition(sample: GameSample, options: GameReportOptions): AcquisitionReport {
  const breakdown = options.breakdown ?? SourceBreakdown.Channel;
  const attribution = options.attribution ?? Attribution.First;
  const campaignBy = options.campaignBy ?? CampaignField.Campaign;
  const whole = wholeOf(sample);
  const scene: Scene = { sample, whole, campaigns: campaignsOf(sample, whole), shown: shownBySurface(sample) };
  return {
    newPlayers: { now: sample.newPlayers.now, before: sample.newPlayers.before },
    newVisitors: { now: sample.newVisitors.now, before: sample.newVisitors.before },
    ...shownOf(scene),
    daily: sample.channels
      .filter((channel) => channel.newPlayers > 0)
      .map(({ channel, daily }) => ({ channel, newPlayers: daily })),
    funnel: sample.funnel,
    breakdown,
    attribution,
    sources: SOURCES[breakdown](scene, attribution),
    campaignBy,
    campaigns: campaignRows(scene.campaigns, campaignBy),
  };
}

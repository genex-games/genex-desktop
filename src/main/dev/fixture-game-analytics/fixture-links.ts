/**
 * A fixture game's saved campaign links as genex.games answers them, with what each brought over
 * the sample's period. Made from the game's sample (`sample.ts`): together a game's links bring
 * what its Campaigns channel did, and the links of the rich game's campaign bring what
 * `sample.campaign` says, so the page agrees with Acquisition's campaigns. A link is the same link
 * over every period (its id, tags, day and addresses); only what it brought changes. A link saved
 * during the launch is added, and a removed one left out, by `index.ts`, which tells them apart by `id`.
 */
import { type CampaignLink, type CampaignTags, campaignUrl, SourceChannel } from "../../../shared/game-analytics.ts";
import { PLAY_ORIGIN } from "../../../shared/play.ts";
import { dayBefore } from "../../../shared/play-stats.ts";
import { type GameSample, noise, SampleKind, spread } from "./sample.ts";

/** A link that shares what a group of links brought. */
interface Share {
  campaign: string;
  content: string | null;
  source: string;
  medium: string;
  /** Its weight among the group's new visitors and new players: the design's own numbers. */
  visitors: number;
  players: number;
  /** The share of its new players who play again on day 7. */
  day7: number;
  /** How many days ago it was saved. */
  daysAgo: number;
}

/**
 * The rich game's campaign as its two links carry it, in every period: `sample.campaign` names it
 * only while it brings somebody, and a saved link keeps its tags when it brings nobody.
 */
const CAMPAIGN = { campaign: "launch_trailer", source: "tiktok", medium: "social" } as const;
/** The campaign's two links, which share what the campaign brought; their Day 7 averages to the campaign's. */
const CAMPAIGN_LINKS: readonly Share[] = [
  { ...CAMPAIGN, content: "bio_link", visitors: 2150, players: 940, day7: 0.086, daysAgo: 13 },
  { ...CAMPAIGN, content: "pinned_comment", visitors: 1270, players: 520, day7: 0.075, daysAgo: 12 },
];
/** The rich game's other links, which share the rest of its Campaigns channel. */
const OTHER_LINKS: readonly Share[] = [
  {
    campaign: "devlog_12",
    content: "description",
    source: "youtube",
    medium: "video",
    visitors: 1180,
    players: 520,
    day7: 0.149,
    daysAgo: 20,
  },
  {
    campaign: "halloween_update",
    content: "announcement",
    source: "discord",
    medium: "community",
    visitors: 640,
    players: 310,
    day7: 0.197,
    daysAgo: 21,
  },
  {
    campaign: "newsletter_oct",
    content: "cta_button",
    source: "email",
    medium: "newsletter",
    visitors: 410,
    players: 130,
    day7: 0.123,
    daysAgo: 26,
  },
  {
    campaign: "reddit_webgames",
    content: "post",
    source: "reddit",
    medium: "social",
    visitors: 360,
    players: 60,
    day7: 0.067,
    daysAgo: 28,
  },
];
/** A steady game's one working link, and how far its Day 7 strays from the game's own by its slug. */
const STEADY_LINK = {
  campaign: "update_news",
  content: "pinned_post",
  source: "discord",
  medium: "community",
  daysAgo: 34,
} as const;
const STEADY_DAY7 = { least: 0.85, spread: 0.3 } as const;
/** The link a steady game saved three days ago and has not posted: it has brought nobody. */
const UNUSED_LINK = {
  campaign: "creator_collab",
  content: null,
  source: "youtube",
  medium: "video",
  daysAgo: 3,
} as const;

/** What a short link's code is written in, and how long it is. */
const CODE_LETTERS = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 5;
/** Where this report's own details start in the sample's noise. */
const NOISE_AT = 400;

const round3 = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;

/** A link's short code: steady for a game and the link's place in its list. */
function shortCode(seed: number, place: number): string {
  const letter = (at: number): string =>
    CODE_LETTERS[Math.floor(noise(seed, NOISE_AT + place * CODE_LENGTH + at) * CODE_LETTERS.length)] ?? "a";
  return Array.from({ length: CODE_LENGTH }, (_, at) => letter(at)).join("");
}

/** What a link brought in the period. */
interface Brought {
  newVisitors: number;
  newPlayers: number;
  day7: number | null;
}

/** A link of `sample`'s game: the `place`-th of its list, with its tags and what it brought. */
function linkOf(
  sample: GameSample,
  place: number,
  made: Omit<Share, "visitors" | "players" | "day7">,
  brought: Brought,
): CampaignLink {
  const { campaign, content, source, medium } = made;
  const tags: CampaignTags = { source, medium, campaign, content, term: null };
  return {
    ...tags,
    id: `fx-made-link-${place + 1}`,
    url: campaignUrl(`${PLAY_ORIGIN.web}/${sample.game.slug}`, tags),
    shortUrl: `${PLAY_ORIGIN.web}/go/${shortCode(sample.seed, place)}`,
    createdOn: dayBefore(sample.window.endsOn, made.daysAgo),
    ...brought,
  };
}

/**
 * Links that share `visitors` and `players` by their weights. A link nobody played through has no
 * Day 7, and none has while the game's own is not known yet.
 */
function shared(
  sample: GameSample,
  first: number,
  links: readonly Share[],
  visitors: number,
  players: number,
): CampaignLink[] {
  const newVisitors = spread(
    visitors,
    links.map((link) => link.visitors),
  );
  const newPlayers = spread(
    players,
    links.map((link) => link.players),
  );
  const ripe = sample.day7.now !== null;
  return links.map((link, index) => {
    const played = newPlayers[index] ?? 0;
    return linkOf(sample, first + index, link, {
      newVisitors: newVisitors[index] ?? 0,
      newPlayers: played,
      day7: ripe && played > 0 ? link.day7 : null,
    });
  });
}

/** The rich game's six links: the campaign's two, then the four that share the rest of the Campaigns channel. */
function richLinks(sample: GameSample, visitors: number, players: number): CampaignLink[] {
  const campaign = { visitors: sample.campaign?.newVisitors ?? 0, players: sample.campaign?.newPlayers ?? 0 };
  const named = sample.campaign ?? { name: CAMPAIGN.campaign, source: CAMPAIGN.source, medium: CAMPAIGN.medium };
  const own = CAMPAIGN_LINKS.map((link) => ({
    ...link,
    campaign: named.name,
    source: named.source,
    medium: named.medium,
  }));
  return [
    ...shared(sample, 0, own, campaign.visitors, campaign.players),
    ...shared(sample, own.length, OTHER_LINKS, visitors - campaign.visitors, players - campaign.players),
  ];
}

/** A steady game's two links: one that brings its whole Campaigns channel, one that has brought nobody. */
function steadyLinks(sample: GameSample, visitors: number, players: number): CampaignLink[] {
  const own = sample.day7.now;
  const strays = STEADY_DAY7.least + noise(sample.seed, NOISE_AT - 1) * STEADY_DAY7.spread;
  const day7 = own !== null && players > 0 ? round3(own * strays) : null;
  return [
    linkOf(sample, 0, STEADY_LINK, { newVisitors: visitors, newPlayers: players, day7 }),
    linkOf(sample, 1, UNUSED_LINK, { newVisitors: 0, newPlayers: 0, day7: null }),
  ];
}

/** The `{ links }` answer for `sample`'s game: six for the rich one, two for a steady one, none for a young one. */
export function fixtureLinks(sample: GameSample): { links: CampaignLink[] } {
  if (sample.kind === SampleKind.Young) return { links: [] };
  const paid = sample.channels.find((channel) => channel.channel === SourceChannel.Campaigns);
  const visitors = paid?.newVisitors ?? 0;
  const players = paid?.newPlayers ?? 0;
  const links =
    sample.kind === SampleKind.Rich ? richLinks(sample, visitors, players) : steadyLinks(sample, visitors, players);
  return { links };
}

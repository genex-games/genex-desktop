/**
 * The words of the Acquisition report: its tiles, the chart of new players by channel, the funnel
 * from the game page to coming back, the sources table and the campaigns table. A channel, a place
 * inside Genex and a device are named here by their vocabulary; a referrer's host, a campaign's
 * tags and the utm_ tag names themselves are data and are shown as they are.
 */
import {
  Attribution,
  ENGAGED_SECONDS,
  FunnelStep,
  GenexSurface,
  SourceBreakdown,
} from "../../../shared/game-analytics.ts";
import { t, tc } from "../../../shared/i18n.ts";
import { REPORT_WORDS } from "./report-words.ts";

/** A step of the funnel that people reach from the one before it: every step but the first. */
export type ReachedStep = Exclude<FunnelStep, typeof FunnelStep.Visited>;

/** The Acquisition report's own copy. */
export const ACQUISITION_WORDS = {
  tiles: {
    newPlayers: t("New players"),
    newPlayersNote: t("played this game for the first time"),
    newVisitors: t("New visitors"),
    newVisitorsNote: t("opened the game page for the first time"),
    visitToPlay: t("Visit-to-play rate"),
    visitToPlayNote: t("new visitors who got into the game"),
    clickThrough: t("Genex click-through"),
    /** `shown` is `count` as the page writes numbers. */
    clickThroughNote: (count: number, shown: string) =>
      t("{count, plural, one {of {shown} time Genex showed the game} other {of {shown} times Genex showed the game}}", {
        count,
        shown,
      }),
  },
  daily: {
    title: t("New players per day, by where they came from"),
    /** The chart, in a sentence, for a screen reader and its table's caption. */
    label: t("New players per day, stacked by where they came from"),
    /** The mark on the first day of a run of days when campaigns brought more new players than anything else. */
    campaignsLead: t("Campaigns take the lead"),
    empty: REPORT_WORDS.noNewPlayers,
  },
  channels: REPORT_WORDS.channels,
  surfaces: {
    [GenexSurface.Feed]: t("Games feed"),
    [GenexSurface.Featured]: t("Featured"),
    [GenexSurface.Search]: t("Search on Genex"),
    [GenexSurface.Profile]: t("Your profile"),
    [GenexSurface.Friends]: t("Friends playing and invites"),
    [GenexSurface.Remixes]: t("Remixes of this game"),
    [GenexSurface.Other]: t("Elsewhere on Genex"),
  } satisfies Record<GenexSurface, string>,
  devices: REPORT_WORDS.devices,
  /** A visit that named no site it came from, in the table split by referrer. */
  noReferrer: t("No referrer"),
  funnel: {
    title: t("From the game page to coming back"),
    hint: t("New visitors in this period"),
    label: t("How far new visitors get, from the game page to coming back"),
    steps: REPORT_WORDS.steps,
    /** Under a step: the share of its people who reach the next one, worded by the step they reach. */
    onward: {
      [FunnelStep.PressedPlay]: (share: string) => t("{share} press Play", { share }),
      [FunnelStep.Loaded]: (share: string) => t("{share} see it load", { share }),
      [FunnelStep.Engaged]: (share: string) =>
        t("{share} play {seconds} s or more", { share, seconds: ENGAGED_SECONDS }),
      [FunnelStep.Returned]: (share: string) => t("{share} come back", { share }),
    } satisfies Record<ReachedStep, (share: string) => string>,
    /** Under a step: how many do not reach the next one. `people` is `count` as the page writes numbers. */
    lost: {
      [FunnelStep.PressedPlay]: (count: number, people: string) =>
        t("{count, plural, one {{people} leaves} other {{people} leave}}", { count, people }),
      [FunnelStep.Loaded]: (count: number, people: string) =>
        t("{count, plural, one {{people} leaves while it loads} other {{people} leave while it loads}}", {
          count,
          people,
        }),
      [FunnelStep.Engaged]: (count: number, people: string) =>
        t("{count, plural, one {{people} leaves sooner} other {{people} leave sooner}}", { count, people }),
      [FunnelStep.Returned]: (count: number, people: string) =>
        t("{count, plural, one {{people} has not yet} other {{people} have not yet}}", { count, people }),
    } satisfies Record<ReachedStep, (count: number, people: string) => string>,
    /** Under the last step: its people as a share of everyone who opened the page. */
    ofNewVisitors: (share: string) => t("{share} of new visitors", { share }),
    empty: t("Nobody opened the game page for the first time in this period."),
  },
  sources: {
    title: t("Sources"),
    label: t("New visitors and players by source"),
    breakdownLabel: t("Group sources by"),
    breakdowns: {
      [SourceBreakdown.Channel]: t("Channel"),
      [SourceBreakdown.Referrer]: t("Referrer"),
      [SourceBreakdown.Country]: t("Country"),
      [SourceBreakdown.Device]: t("Device"),
    } satisfies Record<SourceBreakdown, string>,
    attributionLabel: t("Credit goes to"),
    attributions: {
      [Attribution.First]: t("First source"),
      [Attribution.Latest]: t("Latest source"),
    } satisfies Record<Attribution, string>,
    /** Under the table: whose source a player's numbers are counted under. */
    credit: {
      [Attribution.First]: t("Each player counts for the source that first brought them."),
      [Attribution.Latest]: t("Each player counts for the source of their latest play."),
    } satisfies Record<Attribution, string>,
    total: t("All new players"),
    empty: REPORT_WORDS.noNewVisitors,
  },
  columns: {
    source: tc("traffic", "Source"),
    campaign: t("Campaign"),
    shown: t("Shown"),
    newVisitors: t("New visitors"),
    newPlayers: t("New players"),
    visitToPlay: t("Visit to play"),
    day1: t("Day 1"),
    day7: t("Day 7"),
    nexPerPlayer: t("Nex per player"),
  },
  campaigns: {
    title: t("Campaigns"),
    label: t("New visitors and players by campaign"),
    groupLabel: t("Group campaigns by"),
    /** Under a row's name: the utm_source and utm_medium it came with. */
    via: (source: string, medium: string) => t("{source} / {medium}", { source, medium }),
    newLink: t("New campaign link"),
    keeps: t(
      "A player keeps the first campaign that brought them, through sign-in and install. Links without utm_ tags are sorted by the site they came from.",
    ),
    none: t("No campaign brought new visitors in this period."),
    /** `tag` is a utm_ tag's own name. */
    noneWith: (tag: string) => t("No new visitors came with {tag} in this period.", { tag }),
    whatIsLink: t(
      "A campaign link is your game’s link with utm_ tags on it. Use one for each post, video or ad, and this table shows what each one brought.",
    ),
  },
} as const;

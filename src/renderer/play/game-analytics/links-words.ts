/**
 * The words of the Campaign links tab: the form that makes a link, how a visit is credited, and the
 * table of saved links. Tag names (`utm_`), tags and links are data and are written as they are.
 */
import { CampaignField } from "../../../shared/game-analytics.ts";
import { t, tc } from "../../../shared/i18n.ts";

/** The Campaign links tab's copy. */
export const LINKS_WORDS = {
  newLink: t("New campaign link"),
  newLinkHint: t(
    "Post this link instead of the plain one and every visit, player, install and purchase from it is counted under its name.",
  ),
  /** Each tag's name, and what to write in it. */
  fields: {
    [CampaignField.Source]: { label: tc("traffic", "Source"), hint: t("where you post it") },
    [CampaignField.Medium]: { label: t("Medium"), hint: t("what kind of post") },
    [CampaignField.Campaign]: { label: t("Campaign"), hint: t("what you are promoting") },
    [CampaignField.Content]: { label: t("Content"), hint: t("optional, tells two links in one campaign apart") },
  },
  usedSources: t("Sources you have used"),
  yourLink: t("Your link"),
  shortLink: t("Short link, for places that cut long links or strip the tags"),
  copyYourLink: t("Copy your link"),
  copyShortLink: t("Copy the short link"),
  save: t("Save link"),
  saving: t("Saving…"),
  saved: t("Saved"),
  full: (max: number) =>
    t(
      "{max, plural, one {This game already keeps # saved link, the most it can. Remove one to save another.} other {This game already keeps # saved links, the most it can. Remove one to save another.}}",
      { max },
    ),
  /** Under a field whose words run past the limit. */
  tooLong: (max: number) =>
    t("{max, plural, one {A tag can be up to # character.} other {A tag can be up to # characters.}}", { max }),
  tagsNote: t("Tags are saved in lower case with spaces as underscores, so TikTok and tiktok count as one source."),
  refused: t("Couldn’t save this link. Try again."),

  credit: t("How a visit is credited"),
  /** The five rules, in the order genex.games applies them: what each says first, then what it means. */
  rules: {
    tags: {
      lead: t("Tags come first."),
      detail: t("A visit that carries utm_ tags is a campaign visit, whatever site it came from."),
    },
    site: {
      lead: t("No tags, Genex reads the site."),
      detail: t(
        "It lands in Social, Search engines or Other sites. No site at all is Direct. An ad click with gclid, fbclid or ttclid counts as a campaign.",
      ),
    },
    genex: {
      lead: t("Inside Genex, the place is the source."),
      detail: t("The feed, Featured, search, your profile, a friend playing, a remix."),
    },
    first: {
      lead: t("The first source sticks."),
      detail: (days: number) =>
        t(
          "{days, plural, one {A player keeps the source that first brought them to this game, through sign-in and for # day up to an install. Retention and revenue use it.} other {A player keeps the source that first brought them to this game, through sign-in and for # days up to an install. Retention and revenue use it.}}",
          { days },
        ),
    },
    latest: {
      lead: t("The latest source is kept on every play."),
      detail: t("Use it to see what is bringing people back this week."),
    },
  },
  neverCounted: t("Your own plays and plays in Studio preview are never counted."),

  savedLinks: t("Saved links"),
  /** What each saved link's numbers are counted over. */
  period: (days: number) =>
    t("{days, plural, one {Numbers for the last # day.} other {Numbers for the last # days.}}", { days }),
  tableLabel: t("Saved campaign links"),
  columns: {
    campaign: t("Campaign and content"),
    via: t("Source and medium"),
    newVisitors: t("New visitors"),
    newPlayers: t("New players"),
    visitToPlay: t("Visit to play"),
    day7: t("Day 7"),
    created: t("Created"),
  },
  /** A link's source and medium on one line. */
  via: (source: string, medium: string) => t("{source} / {medium}", { source, medium }),
  /** What a link is called in its buttons' labels: its campaign, with its content when it has one. */
  linkName: (campaign: string, content: string) => t("{campaign}, {content}", { campaign, content }),
  copyLink: (name: string) => t("Copy the link for {name}", { name }),
  removeLink: (name: string) => t("Remove the link for {name}", { name }),
  keepLink: (name: string) => t("Keep the link for {name}", { name }),
  remove: t("Remove"),
  keep: t("Keep"),
  removing: t("Removing…"),
  removeFailed: t("Couldn’t remove that link. Try again."),
  noLinks: t(
    "No saved links yet. Save one to get a short link for it, and to see here how many visitors and players it brings.",
  ),
} as const;

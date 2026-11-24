/**
 * The words of the SDK tab: what Genex counts with no code, why and how a game sends its own
 * events, the names that fill in reports, the events arriving now, why events were dropped and the
 * rules they are held to. Event names, property names, the package and its calls are data: they
 * are written as they are, and a sentence takes them as placeholders. The rules' numbers are the
 * limits genex.games sent, written by the view, never typed into a sentence here.
 */
import { AutoEvent, DropReason, EventOrigin } from "../../../shared/game-analytics.ts";
import { t, tc } from "../../../shared/i18n.ts";

/** What a dropped event's sentence is written from. */
export interface DropContext {
  /** The name as the game sent it. */
  name: string;
  /** The property at fault; null when the reason is not about one. */
  property: string | null;
  /** A name the game could send instead; null when there is no obvious one. */
  suggestion: string | null;
  limits: { nameLength: number; names: number; properties: number; textLength: number };
}

/** The sentences a code sample's comments are written in. */
export interface SampleWords {
  track: string;
  player: string;
}

/** The SDK tab's copy. */
export const SDK_WORDS = {
  counted: {
    title: t("Counted for you, with no code"),
    hint: t(
      "Every game published from Genex carries the SDK. Plays, play length, retention, sources, installs and revenue come from these.",
    ),
    /** What each event Genex counts means, one line each. */
    events: {
      [AutoEvent.PlayStart]: t("A player pressed Play, with where they came from"),
      [AutoEvent.GameReady]: t("The game finished loading, with how long it took"),
      [AutoEvent.PlayEnd]: t("The play ended, with its length, frames a second and errors"),
      [AutoEvent.Purchase]: t("Nex spent in the Store or through buy()"),
      [AutoEvent.Share]: t("A player copied or posted the game’s link"),
      [AutoEvent.Install]: t("The app build was installed"),
      [AutoEvent.FirstOpen]: t("The installed app build was opened for the first time"),
    } satisfies Record<AutoEvent, string>,
  },

  own: {
    title: t("Send your own events"),
    hint: t(
      "Your own events show what Genex can’t see from outside, like where players give up or which power-up they like. Send them from your game with the Genex SDK and they show up in Events.",
    ),
    notReady: t(
      "This game’s published build can’t send its own events yet. They start arriving once you publish it again with a newer Genex SDK.",
    ),
    sampleLabel: t("Add this to your game"),
    copy: t("Copy the code sample"),
    /** The comments in the sample, which a person reads in their own language. */
    sample: {
      track: t("when something worth counting happens"),
      player: t("facts about the player, added to every later event"),
    } satisfies SampleWords,
  },

  known: {
    title: t("Names that fill in reports"),
    hint: t("Any name works in Events. These ones also draw a report without setting anything up."),
    /** With a property: "level_complete with level". */
    withProperty: (property: string) => t("with {property}", { property }),
    levels: (report: string) =>
      t("How far players get, and the tries and time each level takes, in {report}", { report }),
    tutorial: (seconds: string, report: string) =>
      t("A step between loading the game and playing it for {seconds}, in {report}", { seconds, report }),
    matches: (report: string) => t("Match length and room size for multiplayer games, in {report}", { report }),
  },

  live: {
    title: t("Events arriving now"),
    originLabel: t("Where events come from"),
    origins: {
      [EventOrigin.Published]: t("Published game"),
      [EventOrigin.Preview]: t("Studio preview"),
    } satisfies Record<EventOrigin, string>,
    tableLabel: t("Latest events"),
    columns: {
      when: t("When"),
      name: t("Event"),
      properties: t("Properties"),
      player: t("Player"),
    },
    /** An event with no properties. */
    noProperties: tc("properties", "none"),
    /** In place of the list, per origin. */
    emptyPublished: t("No events yet. They show up here a few seconds after someone plays the published game."),
    emptyPublishedSince: (ago: string) => t("Nothing arrived lately. The last event came {ago}.", { ago }),
    emptyPreview: t("No preview events yet. Run your game in Studio preview and its events show up here."),
    previewNote: t(
      "Events from Studio preview show under their own switch and are never counted, so you can test freely.",
    ),
  },

  dropped: {
    title: t("Dropped in the last 24 hours"),
    none: t("Nothing was dropped. Every event your game sent got through."),
    listLabel: t("Dropped events"),
    count: (count: number) => t("{count, plural, one {# event} other {# events}}", { count }),
    last: (ago: string) => t("last {ago}", { ago }),
    /** One sentence per reason: what went wrong and what to send instead. */
    reasons: {
      [DropReason.BadName]: ({ suggestion, limits }: DropContext) =>
        suggestion
          ? t("Names are lower case letters, digits and underscores. Send {suggestion}.", { suggestion })
          : t(
              "Names are lower case letters, digits and underscores, start with a letter, and run up to {max} characters. Send a name like that.",
              { max: limits.nameLength },
            ),
      [DropReason.ReservedName]: ({ name }: DropContext) =>
        t("Genex counts {name} itself. Send your event under another name.", { name }),
      [DropReason.TooManyNames]: ({ limits }: DropContext) =>
        t("The game already uses {max} names, the most it can. Send one of the names it has.", { max: limits.names }),
      [DropReason.TooManyProperties]: ({ limits }: DropContext) =>
        t("The event has more than {max} properties. Send {max} or fewer.", { max: limits.properties }),
      [DropReason.BadValue]: ({ property }: DropContext) =>
        property
          ? t("The property {property} isn’t text, a number, or true or false. Send one of those.", { property })
          : t("A property isn’t text, a number, or true or false. Send one of those."),
      [DropReason.TextTooLong]: ({ property, limits }: DropContext) =>
        property
          ? t("The property {property} is longer than {max} characters. Send a shorter text.", {
              property,
              max: limits.textLength,
            })
          : t("A text is longer than {max} characters. Send a shorter text.", { max: limits.textLength }),
      [DropReason.TooFast]: () =>
        t("Events came faster than Genex takes them. Send one when something happens, not one every frame."),
    } satisfies Record<DropReason, (context: DropContext) => string>,
  },

  rules: {
    title: t("Rules"),
    terms: {
      names: t("Names"),
      properties: t("Properties"),
      delivery: t("Delivery"),
      players: t("Players"),
      kept: t("Kept for"),
    },
    names: (length: number, names: number) =>
      t(
        "Lower case letters, digits and underscores, starting with a letter, up to {length} characters. Up to {names} names in a game.",
        { length, names },
      ),
    namesUsed: (used: number, names: number) => t("This game has used {used} of {names}.", { used, names }),
    properties: (properties: number, length: number) =>
      t("Up to {properties} on an event. Text up to {length} characters, numbers, true or false.", {
        properties,
        length,
      }),
    delivery: (seconds: number) =>
      t(
        "{seconds, plural, one {Sent together every # second and when the game closes. Kept and sent later if the player is offline.} other {Sent together every # seconds and when the game closes. Kept and sent later if the player is offline.}}",
        { seconds },
      ),
    players: t("Genex adds who the player is. Never send a name, an email or anything else that points to a person."),
    kept: (days: number) =>
      t(
        "{days, plural, one {Every event for # day. Daily totals for as long as the game is published.} other {Every event for # days. Daily totals for as long as the game is published.}}",
        { days },
      ),
  },
} as const;

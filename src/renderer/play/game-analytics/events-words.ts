/**
 * The Events tab's words: the status strip, the list of events and what each one is for, the
 * detail's tiles, split and properties, the saved funnels and the form that makes one. Whole
 * sentences with their numbers as placeholders, so each language orders them its own way; the
 * numbers arrive already written by the kit's formatters. An event's name, a property and a value
 * are the game's words and are never in a message.
 */
import { AutoEvent, KnownEvent, PropertyKind } from "../../../shared/game-analytics.ts";
import { t } from "../../../shared/i18n.ts";
import { FormProblem } from "./events-funnel-form.ts";

/** What an event is for, for the ones Genex counts and the names that also draw a report. */
const EVENT_NOTES = {
  [AutoEvent.PlayStart]: t("Counted when a play starts."),
  [AutoEvent.GameReady]: t("Counted when the game has finished loading."),
  [AutoEvent.PlayEnd]: t("Counted when a play ends."),
  [AutoEvent.Purchase]: t("Counted when a player buys something with Nex."),
  [AutoEvent.Share]: t("Counted when a player shares the game."),
  [AutoEvent.Install]: t("Counted when someone installs the app build."),
  [AutoEvent.FirstOpen]: t("Counted the first time an installed game opens."),
  [KnownEvent.LevelStart]: t("Sent when a player starts a level."),
  [KnownEvent.LevelComplete]: t("Sent when a player finishes a level."),
  [KnownEvent.LevelFail]: t("Sent when a player fails a level."),
  [KnownEvent.TutorialComplete]: t("Sent when a player finishes the tutorial."),
  [KnownEvent.MatchStart]: t("Sent when a match starts."),
  [KnownEvent.MatchEnd]: t("Sent when a match ends."),
} as const satisfies Record<AutoEvent | KnownEvent, string>;

/** Whether a name is one the app has a sentence for. */
const hasNote = (name: string): name is keyof typeof EVENT_NOTES => Object.hasOwn(EVENT_NOTES, name);

/** The Events tab's own copy. */
export const EVENTS_WORDS = {
  status: {
    arriving: t("Receiving your events"),
    quiet: t("No event in a while"),
    none: t("Your game sends no events yet"),
    last: (ago: string) => t("Last one {ago}", { ago }),
    /** `count` and `names` pick the plurals; `shown` and `namesShown` are the same numbers as they are written. */
    counted: (count: number, shown: string, names: number, namesShown: string) =>
      t(
        "{count, plural, one {{shown} event} other {{shown} events}} in this period, under {names, plural, one {{namesShown} name} other {{namesShown} names}}",
        { count, shown, names, namesShown },
      ),
    watch: t("Watch events arrive"),
  },

  list: {
    title: t("Events"),
    hint: t("Press one to see it in full."),
    search: t("Search events"),
    event: t("Event"),
    mine: t("Your events"),
    automatic: t("Counted by Genex, no code"),
    count: t("Count"),
    players: t("Players"),
    perPlayer: t("Per player"),
    noMatch: t("No event has that name."),
    /** The game sends none of its own: what to do about it, and the button that opens the SDK tab. */
    noOwn: t("Your game has not sent an event yet. Events tell you what players do, like finishing a level."),
    noOwnOpen: t("See how to add events"),
    oldSdk: t("The SDK in your published game is too old to send events."),
    oldSdkOpen: t("See how to update it"),
  },

  detail: {
    firstSeen: (day: string) => t("First seen {day}.", { day }),
    /** What an event is for; null for a name the game made up. */
    note: (name: string): string | null => (hasNote(name) ? EVENT_NOTES[name] : null),
    count: t("Count"),
    players: t("Players"),
    perPlayer: t("Per player"),
    share: t("Players who sent it"),
    /** `everyone` picks the plural; `shown` is the same number as it is written. */
    shareNote: (everyone: number, shown: string) =>
      t("of {everyone, plural, one {{shown} player} other {{shown} players}}", { everyone, shown }),
    perDay: t("Per day"),
    perDayLabel: (name: string) => t("{name} per day", { name }),
  },

  split: {
    title: t("Split by"),
    /** What the switch of properties is, read aloud. */
    switchLabel: t("The property the event is split by"),
    label: (property: string) => t("Events by {property}", { property }),
    empty: t("Nothing to split in these days."),
    /** `players` picks the plural; `shown` is the same number as it is written. */
    players: (players: number, shown: string) =>
      t("{players, plural, one {{shown} player} other {{shown} players}}", { players, shown }),
  },

  properties: {
    title: t("What comes with it"),
    label: (name: string) => t("Properties of {name}", { name }),
    property: t("Property"),
    kind: t("Kind"),
    arrived: t("What arrived"),
    none: t("This event carries no properties."),
    kinds: {
      [PropertyKind.Number]: t("Number"),
      [PropertyKind.Text]: t("Text"),
      [PropertyKind.Flag]: t("True or false"),
    } satisfies Record<PropertyKind, string>,
    number: (min: string, max: string, median: string, p90: string) =>
      t("{min} to {max}, median {median}, 9 in 10 under {p90}", { min, max, median, p90 }),
    /** A value of a text property with its share of the events, written: "red 40%". */
    valueShare: (value: string, share: string) => t("{value} {share}", { value, share }),
    /** `values` are the most common values with their shares, already listed; `more` picks the plural and `shown` is the same number as it is written. */
    textMore: (values: string, more: number, shown: string) =>
      t("{more, plural, one {{values}, and {shown} more} other {{values}, and {shown} more}}", {
        values,
        more,
        shown,
      }),
    flag: (share: string) => t("True in {share} of events", { share }),
  },

  funnels: {
    title: t("Funnels"),
    hint: t("Where players drop off between events."),
    new: t("New funnel"),
    /** What the list of funnels is, read aloud. */
    label: t("Saved funnels"),
    empty: t("No funnels yet. A funnel follows players through events, in order, and shows where they stop."),
    /** `days` picks the plural; `shown` is the same number as it is written. */
    within: (days: number, shown: string) =>
      t("Players who did every step in order within {days, plural, one {{shown} day} other {{shown} days}}.", {
        days,
        shown,
      }),
    stepsLabel: (name: string) => t("Steps of {name}", { name }),
    nobody: t("Nobody has done the first step in these days."),
    reach: (share: string) => t("{share} reach the end.", { share }),
    /** `shown` is how many days after the first step, as it is written. */
    reachTypically: (share: string, shown: string) =>
      t("{share} reach the end, typically on day {shown}.", { share, shown }),
    reachSameDay: (share: string) => t("{share} reach the end, typically the same day.", { share }),
    remove: t("Remove"),
    removeAsk: t("Remove this funnel?"),
    removeYes: t("Remove funnel"),
    removing: t("Removing…"),
    removeKeep: t("Keep it"),
    removeFailed: t("Couldn’t remove it. Try again."),
    /** `max` picks the plural; `shown` is the same number as it is written. */
    limit: (max: number, shown: string) =>
      t("A game keeps up to {max, plural, one {{shown} funnel} other {{shown} funnels}}. Remove one to make another.", {
        max,
        shown,
      }),
  },

  form: {
    title: t("New funnel"),
    name: t("Name"),
    namePlaceholder: t("First purchase"),
    days: t("Within how many days"),
    steps: t("Steps"),
    stepsHint: t("Players have to do these in order."),
    step: (n: number) => t("Step {n}", { n }),
    event: t("Event"),
    property: t("Property (optional)"),
    value: t("Value"),
    addStep: t("Add a step"),
    removeStep: (n: number) => t("Remove step {n}", { n }),
    save: t("Save funnel"),
    saving: t("Saving…"),
    cancel: t("Cancel"),
    refused: t("Genex couldn’t save this funnel. Check the steps and try again."),
    /** What is wrong in a field; `max` is the field's limit, `shown` the same number as it is written. */
    problem: {
      [FormProblem.Empty]: t("Fill this in."),
      [FormProblem.TooLong]: (max: number, shown: string) =>
        t("This can be up to {max, plural, one {{shown} character} other {{shown} characters}}.", { max, shown }),
      [FormProblem.Characters]: t("Remove the special characters."),
      [FormProblem.NotWhole]: t("Use a whole number."),
      [FormProblem.OutOfRange]: (max: number, shown: string) =>
        t("Pick from 1 to {max, plural, one {{shown} day} other {{shown} days}}.", { max, shown }),
      [FormProblem.Pair]: t("Add both a property and its value, or leave both empty."),
      [FormProblem.UnknownEvent]: t("Pick an event from the list."),
    },
  },
} as const;

/**
 * Words more than one tab of a game's analytics says: what each value of the vocabularies several
 * reports draw is called (where new players came from, the steps from a visit to a return, the
 * kind of device) and the sentences tabs share. A tab's own words module points here instead of
 * keeping a copy, so one idea reads the same on every tab.
 */
import { DeviceClass, ENGAGED_SECONDS, FunnelStep, SourceChannel } from "../../../shared/game-analytics.ts";
import { currentLocale, t } from "../../../shared/i18n.ts";

/** A level a game names with a number is "Level 4"; one it gives a name to is shown as written. */
const NUMBERED = /^\d+$/;

/** The words several tabs share. */
export const REPORT_WORDS = {
  /** Where a new player came from. */
  channels: {
    // A name, the same in every language.
    [SourceChannel.Genex]: "Genex",
    [SourceChannel.Campaigns]: t("Campaigns"),
    [SourceChannel.Social]: t("Social"),
    [SourceChannel.Direct]: t("Direct"),
    [SourceChannel.Search]: t("Search engines"),
    [SourceChannel.Other]: t("Other sites"),
  } satisfies Record<SourceChannel, string>,
  /** The steps from a visit to a return, as the funnels of Overview and Acquisition name them. */
  steps: {
    [FunnelStep.Visited]: t("Opened the game page"),
    [FunnelStep.PressedPlay]: t("Pressed Play"),
    [FunnelStep.Loaded]: t("Game loaded"),
    [FunnelStep.Engaged]: t("Played {seconds} s or more", { seconds: ENGAGED_SECONDS }),
    [FunnelStep.Returned]: t("Came back another day"),
  } satisfies Record<FunnelStep, string>,
  /** The kind of device a game was played on. */
  devices: {
    [DeviceClass.Computer]: t("Computer"),
    [DeviceClass.Phone]: t("Phone"),
    [DeviceClass.Tablet]: t("Tablet"),
  } satisfies Record<DeviceClass, string>,
  /** A block about new players while the period has none. */
  noNewPlayers: t("No new players in these days."),
  /** A funnel of new visitors while the period has none. */
  noNewVisitors: t("No new visitors in these days."),
  /** A return rate before anybody could have come back. */
  tooEarly: t("Too early to tell. This fills in a day after the first new players."),
  /** The axis under a retention or spending curve. */
  daysSince: t("Days since the first play"),
  /** A day of such a curve. */
  day: (day: number) => t("Day {day}", { day }),
  /** The line of the period before, in a legend. */
  daysBefore: (days: number) => t("{days} days before", { days }),
  /** A level the game numbers. */
  level: (level: string) => t("Level {level}", { level }),
} as const;

const regionNames = new Map<string, Intl.DisplayNames>();

/**
 * A country's name in the app's language, as every tab writes it, from its two letters ("ZZ", a
 * country genex.games could not tell, included); the letters themselves when they name no country.
 * A name is words, so it follows the app's language, English included, not the computer's settings.
 */
export function countryName(code: string): string {
  const locale = currentLocale();
  let names = regionNames.get(locale);
  if (!names) {
    names = new Intl.DisplayNames(locale, { type: "region" });
    regionNames.set(locale, names);
  }
  try {
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/** A level's name as every tab writes it: "Level 4" for a number, a name the game gave as written. */
export const levelName = (level: string): string => (NUMBERED.test(level) ? REPORT_WORDS.level(level) : level);

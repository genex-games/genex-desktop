/**
 * The words of the Installs report: its tiles, the way from the Install button to the first launch,
 * the systems, the two places new players play in, the versions and the channels. Each is a whole
 * sentence; one that carries a count takes the count (which picks its plural) and the count as it
 * is written (`shown`, grouped the language's way).
 */
import { InstallBlock, InstallStep, OsFamily, PlayPlace, SourceChannel } from "../../../shared/game-analytics.ts";
import { t, tc } from "../../../shared/i18n.ts";
import { REPORT_WORDS } from "./report-words.ts";

/** The Installs report's own words. */
export const INSTALLS_WORDS = {
  tiles: {
    installs: t("Installs"),
    installsNote: t("downloaded and ready to open"),
    opened: t("Opened after installing"),
    openedNote: (count: number, shown: string) =>
      t("{count, plural, one {{shown} opened it at least once} other {{shown} opened it at least once}}", {
        count,
        shown,
      }),
    installedNow: t("Installed now"),
    removedNote: (count: number, shown: string) =>
      t("{count, plural, one {{shown} removed it in this period} other {{shown} removed it in this period}}", {
        count,
        shown,
      }),
    latest: t("On the latest version"),
    latestPublished: (version: string, day: string) => t("{version}, published {day}", { version, day }),
    /** The median days players take to move to the newest version. */
    updateNote: (days: number, shown: string) =>
      t("{days, plural, one {half update within {shown} day} other {half update within {shown} days}}", {
        days,
        shown,
      }),
  },
  funnel: {
    title: t("From pressing Install to opening the game"),
    /** Beside the title: everyone who was offered the build, and the share who took it. */
    offered: (count: number, shown: string) =>
      t(
        "{count, plural, =0 {Nobody saw Install on a computer that can run it.} one {{shown} visitor on a computer that can run it saw Install.} other {{shown} visitors on a computer that can run it saw Install.}}",
        { count, shown },
      ),
    offeredPressed: (count: number, shown: string, share: string) =>
      t(
        "{count, plural, one {{shown} visitor on a computer that can run it saw Install. {share} pressed it.} other {{shown} visitors on a computer that can run it saw Install. {share} pressed it.}}",
        { count, shown, share },
      ),
    steps: {
      [InstallStep.Pressed]: t("Pressed Install"),
      [InstallStep.Downloaded]: t("Download finished"),
      [InstallStep.Installed]: t("Installed"),
      [InstallStep.Opened]: t("Opened the game"),
    },
    /** Under a step's bar: the share that reaches the next one; under the last, its share of the first. */
    onward: {
      [InstallStep.Pressed]: (share: string) => t("{share} finish the download", { share }),
      [InstallStep.Downloaded]: (share: string) => t("{share} install", { share }),
      [InstallStep.Installed]: (share: string) => t("{share} open it", { share }),
      [InstallStep.Opened]: (share: string) => t("{share} of those who pressed Install", { share }),
    },
    /** Under that: how many do not reach the next step. */
    lost: {
      [InstallStep.Pressed]: (count: number, shown: string) =>
        t("{count, plural, one {{shown} stopped or failed} other {{shown} stopped or failed}}", { count, shown }),
      [InstallStep.Downloaded]: (count: number, shown: string) =>
        t("{count, plural, one {{shown} could not be unpacked} other {{shown} could not be unpacked}}", {
          count,
          shown,
        }),
      [InstallStep.Installed]: (count: number, shown: string) =>
        t("{count, plural, one {{shown} has not opened it} other {{shown} have not opened it}}", { count, shown }),
    },
    empty: t("Nobody pressed Install in this period."),
    blocked: (count: number, shown: string) =>
      t(
        "{count, plural, one {{shown} visitor wanted it and could not install, because there is no build for their computer.} other {{shown} visitors wanted it and could not install, because there is no build for their computer.}}",
        { count, shown },
      ),
    blockedLabel: t("Why they could not install"),
    reasons: {
      [InstallBlock.MacIntel]: t("Mac with an Intel chip and no Rosetta"),
      [InstallBlock.OldSystem]: t("A system that is too old"),
      [InstallBlock.LinuxArm]: t("Linux on ARM"),
      [InstallBlock.Other]: t("Another reason"),
    } satisfies Record<InstallBlock, string>,
  },
  daily: {
    title: t("Installs per day"),
    label: t("Installs per day, by system"),
    empty: t("No installs in this period."),
  },
  systems: {
    title: t("By system"),
    label: t("Installs by system"),
    system: tc("column", "System"),
    installs: t("Installs"),
    share: tc("column", "Share"),
    opened: tc("column", "Opened"),
    download: t("Download time"),
    failed: t("Failed"),
    all: t("All systems"),
    names: {
      [OsFamily.Windows]: t("Windows"),
      [OsFamily.MacArm]: t("Mac, Apple silicon"),
      [OsFamily.MacIntel]: t("Mac, Intel"),
      [OsFamily.Linux]: t("Linux"),
    } satisfies Record<OsFamily, string>,
    empty: t("Nothing to split by system yet."),
  },
  places: {
    title: t("Players who install against players in the browser"),
    label: t("Installed players compared with browser players"),
    /** Beside the title: how many new players each side of the comparison stands on. */
    hint: (installed: number, installedShown: string, browser: number, browserShown: string) =>
      t(
        "{installed, plural, one {{installedShown} new player installed} other {{installedShown} new players installed}}, {browser, plural, one {{browserShown} played in the browser} other {{browserShown} played in the browser}}",
        { installed, installedShown, browser, browserShown },
      ),
    measure: t("New players"),
    names: {
      [PlayPlace.Installed]: t("Installed"),
      [PlayPlace.Browser]: t("Browser"),
    },
    day1: t("Still playing on day 1"),
    day7: t("Still playing on day 7"),
    medianPlaySeconds: t("Median play length"),
    playsPerPlayerDay: t("Plays per player a day"),
    nexPerPlayer: t("Nex per player"),
    empty: REPORT_WORDS.noNewPlayers,
  },
  versions: {
    title: t("Versions on players’ computers"),
    label: t("Installed versions"),
    version: t("Version"),
    published: t("Published"),
    installed: t("Installed"),
    share: tc("column", "Share"),
    /** The last row, when the list is long: a version together with every one before it. */
    andOlder: (version: string) => t("{version} and older", { version }),
    empty: t("Nobody has it installed right now."),
  },
  channels: {
    title: t("Where installs came from"),
    label: t("Installs by where the players came from"),
    genex: REPORT_WORDS.channels[SourceChannel.Genex],
    campaigns: REPORT_WORDS.channels[SourceChannel.Campaigns],
    social: REPORT_WORDS.channels[SourceChannel.Social],
    direct: REPORT_WORDS.channels[SourceChannel.Direct],
    searchAndOther: t("Search and other sites"),
    credit: (days: number) =>
      t(
        "A campaign link keeps its credit for {days, plural, one {# day} other {# days}} between the click and the install.",
        { days },
      ),
    empty: t("No installs to trace yet."),
  },
} as const;

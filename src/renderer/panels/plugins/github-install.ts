/** The Install from GitHub window's small rules: which plugin is on show, how its version reads, and when Continue works. */
import {
  type GithubLookup,
  GithubLookupKind,
  GithubLookupProblem,
  type GithubPluginFound,
  type GithubVersion,
  GithubVersionKind,
} from "../../../shared/plugins.ts";
import { intlLocale } from "../../../shared/i18n.ts";
import { PLUGINS_WORDS } from "../../words.ts";

const WORDS = PLUGINS_WORDS.github;
/** How much of a commit the version line shows, as GitHub shows it. */
const SHORT_SHA_CHARS = 7;

/** A lookup's answer and the link (and version, when one was picked from the list) it answers. */
export interface GithubAnswer {
  lookup: GithubLookup;
  link: string;
  picked?: GithubVersion;
}

/** The plugin the window would install: the one found, or the one chosen from several. */
export function shownPlugin(answer: GithubAnswer | null, chosen: string | null): GithubPluginFound | undefined {
  const lookup = answer?.lookup;
  if (lookup?.kind === GithubLookupKind.Plugin) return lookup;
  if (lookup?.kind === GithubLookupKind.Choose) return lookup.plugins.find((p) => p.spec === chosen);
  return undefined;
}

/** After another version is looked up, the same folder stays chosen when that version still has it. */
export function keptChoice(lookup: GithubLookup, subdir: string | undefined): string | null {
  if (lookup.kind !== GithubLookupKind.Choose) return null;
  return lookup.plugins.find((p) => p.subdir === subdir)?.spec ?? null;
}

/** Whether Continue can look the field's link up: something typed, and no answer for it that looking again can't change. */
export function canLookUp(link: string, answer: GithubAnswer | null): boolean {
  if (!link.trim()) return false;
  const current = answer && answer.link === link.trim() ? answer.lookup : null;
  if (!current) return true;
  return current.kind === GithubLookupKind.Problem && current.problem === GithubLookupProblem.RateLimited;
}

/** A date as the reader writes a short one: "Sep 12", with the year when it isn't this year's. */
export function shortDate(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const };
  return date.toLocaleDateString(intlLocale(), { month: "short", day: "numeric", ...year });
}

/** The version line: its name, and what else helps to know (latest release, the commit, when). */
export function versionWords(
  found: Pick<GithubPluginFound, "sha" | "version">,
  picked: boolean,
  now: Date = new Date(),
): { name: string; detail: string } {
  const { kind, label, date } = found.version;
  const when = shortDate(date, now);
  const commit = [found.sha.slice(0, SHORT_SHA_CHARS), when].filter(Boolean).join(", ");
  switch (kind) {
    case GithubVersionKind.Release:
      return { name: label, detail: picked ? when : WORDS.latestRelease(when) };
    case GithubVersionKind.Branch:
      return { name: WORDS.newestOn(label), detail: commit };
    case GithubVersionKind.Commit:
      return { name: WORDS.commit(label), detail: when };
    default:
      return { name: label, detail: commit };
  }
}

/** Whether the window should say the plugin has no releases: the newest code was taken because there are none. */
export const takesNewestCode = (found: GithubPluginFound, picked: boolean): boolean =>
  found.version.kind === GithubVersionKind.Branch && !picked;

/** The repository's owner, who the window says the plugin is by: GitHub vouches for that name, not the manifest. */
export const ownerOf = (repo: string): string => repo.split("/")[0] ?? repo;

/**
 * A build's name, as the Builds bar's tabs say it and the chat's build cards can: the short title
 * the chat gave it as it started it (`start_autopilot`'s `title`, carried on `run_registered`),
 * else the label of the first save point its lead named, else the chat's own title, else a short
 * line of its goal. `cleanBuildTitle` has a copy in the seed (`buildTitleOf` in
 * `loop/start-autopilot.ts`); tests/conformance/seed-contracts.test.ts holds the two together.
 */

/** The longest a build's name may be, in characters; a longer one is cut at a word and ends in "…". */
export const MAX_BUILD_TITLE_CHARS = 60;
/** A cut keeps at least this share of the longest name before it looks back for a word's end. */
const MIN_CUT_SHARE = 0.5;
/** Quote marks a name may come wrapped in, dropped from its ends. */
const WRAPPING_QUOTES = /^["'“”«»„]+|["'“”«»„]+$/g;
/**
 * The lead an older seed's goal opened with: its goal parameter told the chat to quote the person's
 * own words after it. Matching these English words is the one exception to reading typed fields:
 * those runs carry nothing else to be named by.
 */
const LEGACY_ASK_LEAD = /^the person asked:\s*/i;
/** The person's words an older goal quoted right after its lead. */
const QUOTED_ASK = /^["“«„]([^"”»“]+)["”»“]/;

/** What a build can be called by, best first; any of them may be missing. */
export interface BuildTitleSources {
  /** The title the chat gave the build as it started it. */
  title?: string | null;
  /** The label of the first save point its lead named (not an autosave). */
  firstSavePoint?: string | null;
  /** The chat's own title. */
  threadTitle?: string | null;
  /** The goal the build ran, the only name an older run may have. */
  goal?: string | null;
}

/** A name as one line of at most `MAX_BUILD_TITLE_CHARS`, cut at a word; null when it says nothing. */
export function cleanBuildTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const line = raw.replace(/\s+/g, " ").trim().replace(WRAPPING_QUOTES, "").trim();
  if (!line) return null;
  const chars = Array.from(line);
  if (chars.length <= MAX_BUILD_TITLE_CHARS) return line;
  const cut = chars.slice(0, MAX_BUILD_TITLE_CHARS - 1).join("");
  const space = cut.lastIndexOf(" ");
  const kept = space > MAX_BUILD_TITLE_CHARS * MIN_CUT_SHARE ? cut.slice(0, space) : cut;
  return `${kept.trimEnd()}…`;
}

/** A goal's first line as a name, without an older seed's "The person asked:" lead and its quotes. */
export function goalTitle(goal: string | null | undefined): string | null {
  const line = (goal ?? "").trim().split("\n")[0] ?? "";
  const unled = line.replace(LEGACY_ASK_LEAD, "");
  return cleanBuildTitle(QUOTED_ASK.exec(unled)?.[1] ?? unled);
}

/** The name a build is called by, from the best source it has; "" when it has none. */
export function buildTitle(sources: BuildTitleSources): string {
  return (
    cleanBuildTitle(sources.title) ??
    cleanBuildTitle(sources.firstSavePoint) ??
    cleanBuildTitle(sources.threadTitle) ??
    goalTitle(sources.goal) ??
    ""
  );
}

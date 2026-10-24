/**
 * A plugin manifest's `judges` (API 3, beside an `engine`): blind judges that play the engine's games
 * in its editor (`shared/plugins.ts` `PluginJudge`). A judge is data: its brief is a Markdown file of
 * the package, read and size-checked at install; its players are no more than the engine opens; its
 * probe is one of the plugin's own quiet harness tools that holds the play tools' locks, so the
 * host can run it inside the judge's play. Checked here and kept in canonical form.
 */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { EnginePlayTool, MAX_PLAY_PLAYERS } from "../../shared/engine-play.ts";
import {
  MAX_JUDGE_BRIEF_CHARS,
  MAX_PLUGIN_JUDGES,
  type PluginJudge,
  type PluginManifest,
  type PluginManifestTool,
} from "../../shared/plugins.ts";
import { isFactId } from "../../shared/project-facts.ts";
import { containedReal } from "../paths.ts";
import { quietHarnessTool } from "./hook-manifest.ts";

/** How much one judge may say. */
const LIMIT = { LabelChars: 40, Facts: 8 } as const;
/** A brief's file is read whole: a UTF-8 brief of the most characters fits in this many bytes. */
const BRIEF_FILE_BYTES = MAX_JUDGE_BRIEF_CHARS * 4;

/** A judge's id: 2-40 lowercase letters, digits and dashes, starting with a letter. */
const JUDGE_ID = /^[a-z][a-z0-9-]{1,39}$/;
/** Control characters, NUL and line breaks included. */
const CONTROL = /\p{Cc}/u;
/** A brief's path: package-relative, plain segments, a Markdown file. */
const BRIEF_PATH = /^(?!.*(?:^|\/)\.)[^/\\\p{Cc}]+(?:\/[^/\\\p{Cc}]+)*\.md$/u;

/** What a publisher reads when `judges` is refused. */
const MESSAGE = {
  NeedsApi3: "judges requires apiVersion 3",
  NeedsEngine: "judges requires an engine declaration: a judge plays the engine's games in its editor",
  NotList: `Invalid judges (a list of at most ${MAX_PLUGIN_JUDGES} entries)`,
  InvalidEntry: (at: string) =>
    `Invalid judges entry ${at} (id: lowercase letters, digits and dashes, starting with a letter, 2-40; label: 1-${LIMIT.LabelChars} characters on one line; facts: 1-${LIMIT.Facts} fact ids, each once)`,
  InvalidBrief: (at: string) =>
    `Invalid judges entry ${at} brief (a Markdown file in the package, outside every dot folder)`,
  InvalidPlayers: (at: string, most: number) =>
    `Invalid judges entry ${at} players (a whole number from 1 to ${most}, the most players the engine's play opens)`,
  InvalidProbe: (at: string) =>
    `Invalid judges entry ${at} probe (a tool of this manifest only the harness calls, that asks nothing, runs no host program and needs every lock ${EnginePlayTool.Open} needs)`,
  Duplicate: (id: string) => `Invalid judges: ${id} is declared twice`,
  MissingBrief: (file: string) => `Judge brief ${file} is missing`,
  BriefNotAFile: (file: string) => `Judge brief ${file} is not a plain file`,
  BriefTooLong: (file: string) => `Judge brief ${file} is too long (at most ${MAX_JUDGE_BRIEF_CHARS} characters)`,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** How an entry is named in a refusal: its id when it has one, else its place in the list. */
const nameOf = (entry: unknown, index: number): string =>
  isRecord(entry) && typeof entry.id === "string" && entry.id ? JSON.stringify(entry.id) : `#${index + 1}`;

const isLabel = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= LIMIT.LabelChars && !CONTROL.test(value);

/** Whether `value` is 1-`LIMIT.Facts` distinct fact ids. */
function isFactList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > LIMIT.Facts) return false;
  return value.every(isFactId) && new Set(value).size === value.length;
}

/** Whether `entry` has an id, a label and (when given) facts a judge may have. */
function isJudgeHeader(entry: unknown): entry is Record<string, unknown> & { id: string; label: string } {
  if (!isRecord(entry) || typeof entry.id !== "string" || !JUDGE_ID.test(entry.id)) return false;
  return isLabel(entry.label) && (entry.facts === undefined || isFactList(entry.facts));
}

/** Whether a probe named by a judge may run in its play: quiet, the harness's, and holding every lock opening a play holds. */
function isProbe(tools: readonly PluginManifestTool[], name: unknown): name is string {
  const probe = quietHarnessTool(tools, name);
  if (!probe) return false;
  const opening = tools.find((tool) => tool.name === EnginePlayTool.Open)?.needs ?? [];
  return opening.every((lock) => probe.needs?.includes(lock));
}

/** Whether `value` is a whole number of players from 1 to `most`. */
const isPlayers = (value: unknown, most: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= most;

/** One judge in canonical form: known fields only, in a fixed order. */
function pluginJudge(
  entry: unknown,
  index: number,
  m: PluginManifest,
  tools: readonly PluginManifestTool[],
): PluginJudge {
  const at = nameOf(entry, index);
  if (!isJudgeHeader(entry)) throw new Error(MESSAGE.InvalidEntry(at));
  if (typeof entry.brief !== "string" || !BRIEF_PATH.test(entry.brief)) throw new Error(MESSAGE.InvalidBrief(at));
  const judge: PluginJudge = {
    id: entry.id,
    label: entry.label,
    ...(entry.facts === undefined ? {} : { facts: [...(entry.facts as string[])] }),
    brief: entry.brief,
  };
  // The most players one play of the engine opens: one where it declares none.
  const most = Math.min(MAX_PLAY_PLAYERS, m.engine?.play?.players ?? 1);
  if (entry.players !== undefined) {
    if (!isPlayers(entry.players, most)) throw new Error(MESSAGE.InvalidPlayers(at, most));
    judge.players = entry.players;
  }
  if (entry.probe !== undefined) {
    if (!isProbe(tools, entry.probe)) throw new Error(MESSAGE.InvalidProbe(at));
    judge.probe = entry.probe;
  }
  return judge;
}

/**
 * The manifest's `judges` in canonical form, checked against its canonical tools and engine; throws
 * on API 1 or 2, without an engine, and on anything malformed.
 */
export function validateJudges(m: PluginManifest, tools: readonly PluginManifestTool[]): PluginJudge[] {
  if (m.apiVersion !== 3) throw new Error(MESSAGE.NeedsApi3);
  if (!m.engine) throw new Error(MESSAGE.NeedsEngine);
  const raw: unknown = m.judges;
  if (!Array.isArray(raw) || raw.length > MAX_PLUGIN_JUDGES) throw new Error(MESSAGE.NotList);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const judge = pluginJudge(entry, index, m, tools);
    if (seen.has(judge.id)) throw new Error(MESSAGE.Duplicate(JSON.stringify(judge.id)));
    seen.add(judge.id);
    return judge;
  });
}

/**
 * A judge's brief, read from the package through a handle that refuses a link put in its place:
 * refused when missing, not a plain file, or longer than `MAX_JUDGE_BRIEF_CHARS`.
 */
export async function readJudgeBrief(root: string, file: string): Promise<string> {
  const real = await containedReal(root, file).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "ENOENT" ? new Error(MESSAGE.MissingBrief(file)) : error;
  });
  if (!(await lstat(real)).isFile()) throw new Error(MESSAGE.BriefNotAFile(file));
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await handle.stat()).size > BRIEF_FILE_BYTES) throw new Error(MESSAGE.BriefTooLong(file));
    const text = (await handle.readFile()).toString("utf8");
    if (text.length > MAX_JUDGE_BRIEF_CHARS) throw new Error(MESSAGE.BriefTooLong(file));
    return text;
  } finally {
    await handle.close();
  }
}

/** Every judge's brief is a package file an agent will read: each contained, a plain file, within its cap. */
export async function inspectJudgeBriefs(root: string, m: Pick<PluginManifest, "judges">): Promise<void> {
  for (const judge of m.judges ?? []) await readJudgeBrief(root, judge.brief);
}

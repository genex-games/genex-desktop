/**
 * A plugin manifest's `detect` section (API 3): the rules that know the plugin's kinds of project by
 * their files (`shared/project-facts.ts`). Checked here and kept in canonical form; the globs use the
 * one grammar the detection matches with (`isFileGlob`, `isFolderGlob`).
 */
import type { PluginManifest } from "../../shared/plugins.ts";
import { type FactRule, isFactId, isFileGlob, isFolderGlob } from "../../shared/project-facts.ts";

/** How much one manifest may declare. */
const LIMIT = { Rules: 8, Files: 8, NotUnder: 8 } as const;

/** What a publisher reads when `detect` is refused. */
const MESSAGE = {
  NeedsApi3: "detect requires apiVersion 3",
  NotList: `Invalid detect (a list of at most ${LIMIT.Rules} rules)`,
  NotRule: "Invalid detect entry (an object with fact, files and optional notUnder)",
  InvalidFact: "Invalid detect fact (lowercase letters, digits and dashes, starting with a letter, at most 40)",
  InvalidFiles: `Invalid detect files (1-${LIMIT.Files} globs: plain characters, * within a segment, an optional leading **/, no .. and no leading /)`,
  InvalidNotUnder: `Invalid detect notUnder (at most ${LIMIT.NotUnder} folder globs, each ending with /)`,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A list of strings of at most `max` (and at least `min`) entries, each passing `valid`. */
function globList(value: unknown, min: number, max: number, valid: (glob: unknown) => boolean): string[] | undefined {
  if (!Array.isArray(value) || value.length < min || value.length > max) return undefined;
  return value.every(valid) ? [...(value as string[])] : undefined;
}

/** One rule in canonical form. */
function validateRule(raw: unknown): FactRule {
  if (!isRecord(raw)) throw new Error(MESSAGE.NotRule);
  if (!isFactId(raw.fact)) throw new Error(MESSAGE.InvalidFact);
  const files = globList(raw.files, 1, LIMIT.Files, isFileGlob);
  if (!files) throw new Error(MESSAGE.InvalidFiles);
  if (raw.notUnder === undefined) return { fact: raw.fact, files };
  const notUnder = globList(raw.notUnder, 0, LIMIT.NotUnder, isFolderGlob);
  if (!notUnder) throw new Error(MESSAGE.InvalidNotUnder);
  return { fact: raw.fact, files, notUnder };
}

/** The manifest's `detect` in canonical form; throws on API 1 or 2 and on any malformed rule. */
export function validateDetect(m: Pick<PluginManifest, "apiVersion" | "detect">): FactRule[] {
  if (m.apiVersion !== 3) throw new Error(MESSAGE.NeedsApi3);
  const raw: unknown = m.detect;
  if (!Array.isArray(raw) || raw.length > LIMIT.Rules) throw new Error(MESSAGE.NotList);
  return raw.map(validateRule);
}

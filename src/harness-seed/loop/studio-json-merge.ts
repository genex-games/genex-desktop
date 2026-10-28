/**
 * studio.json merged by its keys when a landing meets it changed on both sides. The studio writes
 * the game's declared kind into the game folder's studio.json during a run (kinds.ts
 * `writeDeclaredGame`), and a lead often writes the same `game` block into the build: git saw two
 * edits of one hunk and the finished run was never made live. Read as JSON, the two sides agree;
 * only a key both sides set to different values is a conflict, and that one is still refused.
 */
import { GIT } from "./git.ts";
import { isPlainRecord } from "./json.ts";
import { shellQuote } from "./shell.ts";
import type { MergeExec } from "./merge-ownership.ts";
import type { AnyRecord } from "../types/harness.d.ts";

/** The one file this resolver settles. */
export const STUDIO_JSON = "studio.json";

/** A three-way merge's answer: the merged value, or the first key both sides changed apart. */
export type JsonMerge = { ok: true; value: unknown } | { ok: false; key: string };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Merge `ours` and `theirs` against `base`, key by key: a side that left a value as it was takes
 * the other's, equal values are one, and two objects merge inside. An absent key is `undefined`,
 * so a key one side added (the folder's `declaredBy`) or removed survives. Anything else conflicts.
 */
export function mergeJson(base: unknown, ours: unknown, theirs: unknown, at = ""): JsonMerge {
  if (same(ours, theirs) || same(base, theirs)) return { ok: true, value: ours };
  if (same(base, ours)) return { ok: true, value: theirs };
  if (!isPlainRecord(ours) || !isPlainRecord(theirs)) return { ok: false, key: at || "(the file)" };
  const from: AnyRecord = isPlainRecord(base) ? base : {};
  const merged: AnyRecord = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const value = mergeJson(from[key], ours[key], theirs[key], at ? `${at}.${key}` : key);
    if (!value.ok) return value;
    if (value.value !== undefined) merged[key] = value.value;
  }
  return { ok: true, value: merged };
}

/** One stage of the conflicted studio.json as JSON: `{}` where it has none (base), null where it is no object. */
async function stageJson(exec: MergeExec, stage: 1 | 2 | 3): Promise<AnyRecord | null> {
  const shown = await exec(GIT.show(`:${stage}:${STUDIO_JSON}`)).catch(() => null);
  if (shown?.code !== 0) return stage === 1 ? {} : null;
  try {
    const json = JSON.parse(String(shown.stdout ?? ""));
    return isPlainRecord(json) ? json : null;
  } catch {
    return null;
  }
}

/**
 * Settle a stopped merge whose only conflict is studio.json by merging it by its keys, then
 * commit the merge as `message`. Answers `ok`, or why not; the caller aborts the merge on a no.
 */
export async function resolveStudioJson(
  exec: MergeExec,
  { message }: { message: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const unmerged = await exec(GIT.unmerged).catch(() => null);
  const files = String(unmerged?.stdout ?? "")
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
  if (files.length !== 1 || files[0] !== STUDIO_JSON) return { ok: false, reason: "not studio.json alone" };
  const [base, ours, theirs] = [await stageJson(exec, 1), await stageJson(exec, 2), await stageJson(exec, 3)];
  if (!ours || !theirs) return { ok: false, reason: "studio.json is not a JSON object on both sides" };
  const merged = mergeJson(base, ours, theirs);
  if (!merged.ok) return { ok: false, reason: `both sides set studio.json's ${merged.key}` };
  const text = `${JSON.stringify(merged.value, null, 2)}\n`;
  const written = await exec(
    `printf '%s' ${shellQuote(text)} > ${shellQuote(STUDIO_JSON)} && ${GIT.addPath(STUDIO_JSON)}`,
  ).catch(() => null);
  if (written?.code !== 0) return { ok: false, reason: "studio.json could not be written" };
  const committed = await exec(GIT.commit(message, { noEdit: true })).catch(() => null);
  if (committed?.code !== 0) return { ok: false, reason: "the merge could not be committed" };
  return { ok: true };
}

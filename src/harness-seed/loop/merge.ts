/**
 * Union merge for the FACET WIRING block — HARNESS-FIX-PLAN.md WP1c.
 *
 * The template promises "adjacent one-line additions merge clean"; git disagrees, and every
 * facet of one run paid a builder turn to resolve two facets' import lines. When a merge
 * conflicts on exactly the template's entry (`src/main.js`, or `src/main.cpp` in a C++ · raylib
 * game, named by `main`), the three stages are union-merged, the result is checked (no markers
 * left, every line inside the wiring block unique), and the merge is committed. Any other
 * conflict keeps the old path: abort, tell the builder.
 */
import { GIT } from "./git.ts";
import { shellQuote } from "./shell.ts";
import { CLIP_DETAIL } from "./text.ts";

/**
 * This merge takes a C++ · raylib entry (`main: "src/main.cpp"`): its FACET WIRING block is the
 * same `//` comment pair. run-dispatch.ts and chat-dispatch.ts refuse a raylib night on a kept copy
 * without this mark (`servesNative`, native-contract.ts).
 */
export const SERVES_NATIVE = true;
/** The union merge takes a Rust · wgpu entry too (`src/main.rs`): its FACET WIRING block is the same `//` comment pair. */
export const SERVES_RUST = true;

export const WIRING_START = /^\s*\/\/\s*─*\s*FACET WIRING/;
export const WIRING_END = /^\s*\/\/\s*─*\s*END FACET WIRING/;

/**
 * Validate (and tidy) a union-merged entry (main.js, main.cpp): fails on any conflict marker;
 * deduplicates identical lines inside the wiring block (both sides adding the same import is one
 * import).
 */
export function verifyWiringMerge(
  text: unknown,
): { ok: false; reason: string; text: string } | { ok: true; text: string; duplicates: number } {
  const source = String(text ?? "");
  if (/^(<{7}|={7}|>{7})/m.test(source)) return { ok: false, reason: "conflict markers remain", text: source };
  const lines = source.split("\n");
  // A file with no wiring block is not a file this rule can merge. `git merge-file --union`
  // keeps BOTH sides of every hunk, so on a marker-less entry it silently doubles the whole
  // module — every import twice, every call twice — and the result compiles just often enough
  // to reach a judge. A game the user brought has no block at all: it belongs to the caller.
  if (!lines.some((line) => WIRING_START.test(line)))
    return {
      ok: false,
      reason: "no FACET WIRING block in the merged file — a union merge would double it",
      text: source,
    };
  const { out, duplicates } = dedupeWiring(lines);
  return { ok: true, text: out.join("\n"), duplicates };
}

/** The lines with every repeated line inside a wiring block dropped, and how many were dropped. */
function dedupeWiring(lines: readonly string[]): { out: string[]; duplicates: number } {
  const out: string[] = [];
  let inside = false;
  const seen = new Set<string>();
  let duplicates = 0;
  for (const line of lines) {
    const key = line.trim();
    const wiringLine = inside && key !== "";
    if (WIRING_START.test(line)) {
      inside = true;
      seen.clear();
    } else if (WIRING_END.test(line)) inside = false;
    else if (wiringLine && seen.has(key)) {
      duplicates++;
      continue;
    } else if (wiringLine) seen.add(key);
    out.push(line);
  }
  return { out, duplicates };
}

/**
 * After a failed `git merge` in `cwd`: if the only unmerged path is the entry (`main`, src/main.js
 * unless the shape names another, src/main.cpp for C++ · raylib), union-merge it and commit;
 * otherwise leave the conflict for the caller to abort. `exec(command)` runs a shell command in the
 * worktree and returns `{ code, stdout, stderr }`.
 */
export async function unionMergeMain(
  exec: (command: string) => Promise<{ code: number | null; stdout?: string; stderr?: string }>,
  {
    message = "merge (union on FACET WIRING)",
    main = "src/main.js",
    wiring = true,
  }: { message?: string; main?: string; wiring?: boolean } = {},
): Promise<{ ok: boolean; reason?: string; duplicates?: number }> {
  // Only a template entry has a wiring block to union-merge. In a game the user brought the
  // entry is the game's own code, and a conflict in it is the director's work to resolve —
  // visible, rather than a merge that reads clean and doubles a module.
  if (!wiring)
    return { ok: false, reason: "this game's entry has no FACET WIRING block — resolve the conflict by hand" };
  const unmerged = await exec(GIT.unmerged);
  const files = String(unmerged.stdout ?? "")
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
  const onlyTheEntryConflicts = unmerged.code === 0 && files.length === 1 && files[0] === main;
  if (!onlyTheEntryConflicts)
    return { ok: false, reason: files.length ? `conflicts in ${files.join(", ")}` : "no unmerged file" };
  // Scratch files live under the worktree's own `.studio/` (gitignored by the brief writer):
  // the builder sandbox confines writes to the workspace, so /tmp is not an option here.
  const merged = await exec(
    // The entry's name is the game's own (studio.json): quoted, so nothing in it runs (M3).
    `T=.studio/merge && mkdir -p "$T" && ${GIT.show(`:1:${main}`)} > "$T/base.js" && ${GIT.show(`:2:${main}`)} > "$T/ours.js" && ${GIT.show(`:3:${main}`)} > "$T/theirs.js" && (${GIT.mergeFileUnion('"$T/ours.js"', '"$T/base.js"', '"$T/theirs.js"')} > "$T/merged.js"; true) && cat "$T/merged.js" && rm -rf "$T"`,
  );
  if (merged.code !== 0 || !String(merged.stdout ?? "").trim())
    return { ok: false, reason: `union merge failed: ${(merged.stderr || "").slice(0, CLIP_DETAIL)}` };
  const verified = verifyWiringMerge(merged.stdout);
  if (!verified.ok) return { ok: false, reason: verified.reason };
  // Write through a heredoc-free path: base64 keeps every byte intact through the shell.
  const encoded = Buffer.from(verified.text, "utf8").toString("base64");
  const wrote = await exec(
    `printf '%s' '${encoded}' | base64 -d > ${shellQuote(main)} && ${GIT.addPath(main)} && ${GIT.commit(message, { noEdit: true })}`,
  );
  if (wrote.code !== 0)
    return {
      ok: false,
      reason: `could not commit the union merge: ${(wrote.stderr || wrote.stdout || "").slice(0, CLIP_DETAIL)}`,
    };
  return { ok: true, duplicates: verified.duplicates };
}

/**
 * The code reviewer — HARNESS-REWORK.md §4.7. A cheap pass over an attempt's diff for
 * contract violations before any evidence is spent: the mechanical scan finds what a regex
 * can (Math.random, wall clock, a removed installStudio, untagged new meshes, edits outside
 * the facet's files); the model pass, when enabled and the diff is small, finds what a regex
 * cannot (a probe that lies). Findings are handed back to the builder in the same session.
 */
import { reviewDiff } from "./judge.ts";
import { facetNotes } from "./repo.ts";
import { commitArg, isCommit, shellQuote } from "./shell.ts";
import { GIT } from "./git.ts";
import {
  arrivedByMerge,
  EnforcedAction,
  isOwnershipFinding,
  openMergeHead,
  ReviewCategory,
} from "./merge-ownership.ts";
import { GIT_TIMEOUT_MS } from "./config.ts";
import { screenOwnership } from "./screen-owner.ts";
import { HostMethod } from "./host-methods.ts";
import { EngineFailure } from "./outage.ts";
import type { HarnessCtx, Run } from "../types/harness.d.ts";

/** One finding against an attempt: the file, the line, what is wrong and how to fix it. */
export interface Violation {
  file: string;
  line?: number;
  category?: string;
  what: string;
  fix?: string;
  /** "mechanical" for the regex half; the model half says nothing, or its own word. */
  source?: string;
  /** The model reviewer's own flag: this finding is a check made to pass without the work (a forced probe or flag). */
  gaming?: boolean;
}

/** The facet as review reads it: its id, its seam, and the entry files of this game's shape. */
export interface ReviewSpec {
  id: string;
  owns?: string[];
  main?: string;
  studio?: string;
  template?: boolean;
  /** This part owns the screen (screen-owner.ts): it alone draws on it. */
  ownsScreen?: boolean;
  /** The part that owns the screen, when one does; absent, nobody does and the rule is inert. */
  screenOwner?: string;
  [field: string]: unknown;
}

/** What a review found. */
export interface ReviewOutcome {
  violations: Violation[];
  summary: string;
  diffChars: number;
  base: string;
  merged: boolean;
  files?: string[];
}

/** The largest diff the model half of the review is asked about; a larger one gets the mechanical scan alone. */
const MAX_MODEL_DIFF_CHARS = 40_000;
/** New objects a template file may create before it must tag at least one of them. */
const UNTAGGED_OBJECT_LIMIT = 3;
/** Lines beyond its wiring a facet may add to an entry it does not own. */
const WIRING_LINE_LIMIT = 3;
/** Where the template keeps its entry module and the studio contract. */
const DEFAULT_MAIN = "src/main.js";
const DEFAULT_STUDIO = "src/studio.js";

/** `src/studio.js` → `src/studio.d.ts`: the contract module's types, wherever it lives. */
function declarationFor(studio: unknown): string {
  return String(studio ?? "").replace(/\.[cm]?js$/, ".d.ts");
}

/** `src/studio.js` → `src/hud.js`: the contract's HUD module, beside it (M4.2a). */
function hudFor(studio: unknown): string {
  const path = String(studio ?? "");
  const at = path.lastIndexOf("/");
  return at < 0 ? "hud.js" : `${path.slice(0, at + 1)}hud.js`;
}

/** `tsconfig.json` and the files it references (`tsconfig.app.json`, `tsconfig.node.json`). */
function isTypeConfig(file: unknown): boolean {
  return /^tsconfig(\.[\w-]+)?\.json$/.test(String(file ?? ""));
}

/**
 * Does `file` fall inside one `owns` entry? A seam with no `*` or `?` keeps the rule the
 * template has always had — the exact path, or anything under it as a directory. A seam with
 * either metacharacter is a glob: `*` and `?` stop at a slash, `**` crosses them. The body is
 * the same one in `substrate/ownership.ts`; the conformance suite drives every case through
 * both copies so they cannot drift.
 */
export function ownMatches(file: unknown, own: unknown): boolean {
  const pattern = String(own ?? "").trim();
  const target = String(file ?? "");
  if (!pattern || !target) return false;
  if (!/[*?]/.test(pattern)) return target === pattern || target.startsWith(pattern.replace(/\/?$/, "/"));
  return globRegExp(pattern).test(target);
}

/** A glob into a RegExp: `**` crosses slashes, `*` and `?` do not. */
function globRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          source += "(?:[^\\0]*\\/)?";
          i += 2;
        } else {
          source += "[^\\0]*";
          i += 1;
        }
      } else source += "[^/]*";
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      continue;
    }
    source += ch.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/**
 * Files a facet may touch: its own module(s), its notes (`docs/notes/`, out of the game's own
 * root), and the wiring line. The same rule runs at edit time as an SDK PreToolUse hook
 * (`substrate/ownership.ts`, WP8) — keep the two in step;
 * `tests/conformance/harness-incidents.test.ts` checks that they agree.
 *
 * `spec.template === false` is a game the user brought (M4.6): no FACET WIRING pass-through on
 * the entry, no id-substring escape hatch, and a worker with no seam owns the repository minus
 * the entry, the contract and the page. Absent means the studio's template, so every caller
 * written before the flag existed keeps the behaviour it had.
 */
export function allowedFile(file: string, spec: ReviewSpec, ownsMain: boolean): boolean {
  if (!file) return true;
  const template = spec.template !== false;
  const main = spec.main ?? DEFAULT_MAIN;
  const studio = spec.studio ?? DEFAULT_STUDIO;
  if (sharedFile(file, spec.id)) return true;
  // The contract's declaration and the compiler config belong to whoever owns the entry: a
  // TypeScript game whose build is `tsc -b && vite build` cannot import ./studio.js until they
  // agree, and the brief that tells the builder to fix that must not also forbid the edit.
  const entryOrConfig = isEntryFile(file, main, studio) || isTypeConfig(file);
  if (ownsMain && entryOrConfig) return true;
  if (template && file === main) return true; // the FACET WIRING block — checked below by content
  if (spec.owns?.length) {
    return spec.owns.some((own) => ownMatches(file, own)) || (template && file.includes(spec.id));
  }
  if (template) return file.startsWith("src/") && file !== studio && file !== hudFor(studio);
  return !isEntryFile(file, main, studio);
}

/** Files every facet may touch: its notes, the game's notes, the studio's scratch and the assets. */
function sharedFile(file: string, facetId: string): boolean {
  if (file === facetNotes(facetId) || file === "NOTES.md") return true;
  if (file.startsWith(".studio/")) return true;
  return (
    file === "assets" || file.startsWith("assets/") || file === "public/assets" || file.startsWith("public/assets/")
  );
}

/** The entry, the contract (its module, declaration and HUD) and the page: the entry owner's files. */
function isEntryFile(file: string, main: string, studio: string): boolean {
  return (
    file === main ||
    file === studio ||
    file === declarationFor(studio) ||
    file === hudFor(studio) ||
    file === "index.html"
  );
}

/** One file's lines in a diff: what was added (with its new line number) and what was removed. */
interface FileDiff {
  added: Array<{ line: number; text: string }>;
  removed: string[];
}

/** Parse `git diff` output into per-file added lines. */
export function parseDiff(diff: unknown): Map<string, FileDiff> {
  const files = new Map<string, FileDiff>();
  let current: FileDiff | undefined;
  let newLine = 0;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("+++ ")) {
      const name = line.slice(4).replace(/^b\//, "").trim();
      current = name === "/dev/null" ? undefined : fileEntry(files, name);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (current) newLine = recordLine(current, line, newLine);
  }
  return files;
}

/** The entry for `name`, made the first time the diff names it. */
function fileEntry(files: Map<string, FileDiff>, name: string): FileDiff {
  const known = files.get(name);
  if (known) return known;
  const entry: FileDiff = { added: [], removed: [] };
  files.set(name, entry);
  return entry;
}

/** Record one body line of a hunk; answers the new side's next line number. */
function recordLine(entry: FileDiff, line: string, newLine: number): number {
  if (line.startsWith("+")) {
    entry.added.push({ line: newLine, text: line.slice(1) });
    return newLine + 1;
  }
  if (line.startsWith("-")) {
    entry.removed.push(line.slice(1));
    return newLine;
  }
  if (line.startsWith("\\")) return newLine;
  return newLine + 1;
}

/**
 * The four rules the studio owns only inside its own template, as the model half words them.
 * A game the user brought already has its own randomness, its own clock and its own scene
 * graph, and no FACET WIRING block at all: raising these on it tells a worker to break the
 * game it was sent to improve. The mechanical half is gated by `template` below; the model
 * half comes back as free text, so it is gated by matching what it said.
 */
const TEMPLATE_ONLY_FINDING =
  /Math\.random|wall[- ]clock|Date\.now|performance\.now|untagged|userData\.tag|FACET WIRING|wiring line|not tagged|tag them/i;

/** Is this a finding the studio only makes about its own template? (M4.6) */
export function templateOnlyFinding(violation: Partial<Violation> | null | undefined): boolean {
  if (violation?.category) return ["determinism", "wall-clock", "tags", "wiring"].includes(violation.category);
  return TEMPLATE_ONLY_FINDING.test(`${violation?.what ?? ""} ${violation?.fix ?? ""}`);
}

/** The contract methods the harness calls; removing one from the contract module is a finding. */
const CONTRACT_METHODS = ["capture", "inspect", "debugCamera", "state"] as const;

/** The mechanical scan's view of one changed file. */
interface FileReview {
  file: string;
  added: FileDiff["added"];
  removed: string[];
  spec: ReviewSpec;
  ownsMain: boolean;
  template: boolean;
  entryMain: string;
  entryStudio: string;
}

/** The regex half. Returns violations with `source: "mechanical"`. */
export function mechanicalReview(
  diff: unknown,
  spec: ReviewSpec,
  {
    ownsMain = true,
    main = null,
    studio = null,
    template = true,
  }: { ownsMain?: boolean; main?: string | null; studio?: string | null; template?: boolean } = {},
): Violation[] {
  // The entry files this project's shape names — a game the user brought has its own.
  const shaped: ReviewSpec = {
    ...spec,
    ...(main ? { main } : {}),
    ...(studio ? { studio } : {}),
    ...(template === false ? { template: false } : {}),
  };
  const entryMain = shaped.main ?? DEFAULT_MAIN;
  const entryStudio = shaped.studio ?? DEFAULT_STUDIO;
  const violations: Violation[] = [];
  for (const [file, { added, removed }] of parseDiff(diff)) {
    const review: FileReview = { file, added, removed, spec: shaped, ownsMain, template, entryMain, entryStudio };
    violations.push(
      ...templateFindings(review),
      ...evidenceWrites(review),
      ...contractRemovals(review),
      ...wiringOverreach(review),
      ...ownershipBreach(review),
      ...screenOwnership(review),
    );
  }
  return violations;
}

/** Is this file game code (JavaScript or TypeScript)? */
function isSourceFile(file: string): boolean {
  return /\.(m?js|ts)$/.test(file);
}

/** Inside the template: no Math.random, no wall clock, and new objects are tagged. */
function templateFindings({ file, added, template }: FileReview): Violation[] {
  const templateSource = template && isSourceFile(file) && !file.endsWith("studio.js");
  if (!templateSource) return [];
  const violations: Violation[] = [];
  for (const { line, text } of added) {
    if (/\bMath\.random\s*\(/.test(text)) {
      violations.push({
        file,
        line,
        category: "determinism",
        what: "Math.random() in game code — two builds cannot be compared on one seed",
        fix: "use the rng passed into update() or a generator seeded in reset(seed)",
        source: "mechanical",
      });
    }
    if (/\b(Date\.now|performance\.now)\s*\(/.test(text) && !/\/\/.*(log|debug)/i.test(text)) {
      violations.push({
        file,
        line,
        category: "wall-clock",
        what: "wall-clock time drives the game — judging is stepped, not clocked",
        fix: "derive time from dt in update() / the frame counter",
        source: "mechanical",
      });
    }
  }
  const newMeshes = added.filter(({ text }) =>
    /new\s+THREE\.(Mesh|InstancedMesh|SkinnedMesh|Group|Points|Line|Sprite)\b/.test(text),
  ).length;
  const newTags = added.filter(({ text }) => /userData\.tag\s*=|userData\s*=\s*\{[^}]*tag/.test(text)).length;
  if (newMeshes >= UNTAGGED_OBJECT_LIMIT && newTags === 0) {
    violations.push({
      file,
      line: 0,
      category: "tags",
      what: `${newMeshes} new objects created and none tagged — scene checks cannot see them`,
      fix: 'set obj.userData.tag = "<tag>" on every object (a group tag covers its children)',
      source: "mechanical",
    });
  }
  return violations;
}

/** A line that assigns to one of the studio's evidence globals, or defines one. */
function writesEvidenceGlobal(text: string): boolean {
  return (
    /\b__studio(Clock|Draw|Capture|Gl|Hook)\b\s*(=[^=]|\.[A-Za-z_$][\w$]*\s*=[^=])/.test(text) ||
    /defineProperty\s*\([^,]*,\s*["'`]__studio(Clock|Draw|Capture|Gl|Hook)["'`]/.test(text)
  );
}

/**
 * The studio's own evidence globals, on any shape of game. They are installed behind
 * accessors that ignore a write (M4.9a), so this is a second belt and not the defence: a
 * build that assigns to one is telling the studio what it drew instead of drawing it, and
 * a run that reads its own numbers back is judging nothing.
 */
function evidenceWrites({ file, added }: FileReview): Violation[] {
  if (!isSourceFile(file)) return [];
  return added
    .filter(({ text }) => writesEvidenceGlobal(text))
    .map(({ line }) => ({
      file,
      line,
      category: "evidence",
      what: "game code writes to one of the studio's own evidence globals — the frame, draw and capture counts the judge reads must be the page's own, not the build's",
      fix: "delete the assignment; report what the game did through the contract (state(), inspect(), probes()) and let the studio count what it drew",
      source: "mechanical",
    }));
}

/** Did this file's diff remove a line matching `pattern` without adding one back? */
function dropped({ added, removed }: FileReview, pattern: RegExp): boolean {
  return removed.some((text) => pattern.test(text)) && !added.some(({ text }) => pattern.test(text));
}

/** The entry or the contract module lost installStudio(), or the contract lost a method. */
function contractRemovals(review: FileReview): Violation[] {
  const { file, entryMain, entryStudio } = review;
  if (file !== entryStudio && file !== entryMain) return [];
  const violations: Violation[] = [];
  if (dropped(review, /installStudio\s*\(/)) {
    violations.push({
      file,
      line: 0,
      category: "contract",
      what: "installStudio() call removed — the build cannot be judged",
      fix: "restore the call — installStudio({ renderer, player }) is the whole ask; the studio's page shim supplies the rest",
      source: "mechanical",
    });
  }
  if (file !== entryStudio) return violations;
  for (const key of CONTRACT_METHODS) {
    if (!dropped(review, new RegExp(`^\\s*${key}\\s*[(:]`))) continue;
    violations.push({
      file,
      line: 0,
      category: "contract",
      what: `__studio.${key} removed from the contract`,
      fix: "restore it — every method of the contract is called by the harness",
      source: "mechanical",
    });
  }
  return violations;
}

/** In the template, a facet that does not own the entry edits only its wiring line there. */
function wiringOverreach({ file, added, template, ownsMain, entryMain }: FileReview): Violation[] {
  const othersEntry = template && !ownsMain && file === entryMain;
  if (!othersEntry) return [];
  const outsideWiring = added.filter(
    ({ text }) => !/^\s*(import|\/\/|$)/.test(text) && !/init|setup|install/i.test(text),
  );
  const [first] = outsideWiring;
  if (outsideWiring.length <= WIRING_LINE_LIMIT || !first) return [];
  return [
    {
      file,
      line: first.line,
      category: "wiring",
      what: `this facet does not own ${entryMain} but edited beyond its wiring line`,
      fix: "touch only the FACET WIRING block: one import + one init line",
      source: "mechanical",
    },
  ];
}

/** Where the facet's work belongs, as the ownership finding tells it. */
function ownedPlace(spec: ReviewSpec, template: boolean): string {
  if (spec.owns?.length) return spec.owns.join(", ");
  if (template) return `src/${spec.id}.js`;
  return "the seam it was given";
}

/** A file outside the facet's ownership. */
function ownershipBreach({ file, spec, ownsMain, template }: FileReview): Violation[] {
  if (allowedFile(file, spec, ownsMain)) return [];
  return [
    {
      file,
      line: 0,
      category: ReviewCategory.Ownership,
      what: `edited a file outside this facet's ownership (${file})`,
      fix: `keep this facet's work in ${ownedPlace(spec, template)}`,
      source: "mechanical",
    },
  ];
}

/** Everything reviewAttempt is told about one attempt. */
interface AttemptReview {
  run: Run;
  spec: ReviewSpec;
  worktree: string;
  incumbentCommit: string;
  integrationHead?: string | string[] | null;
  ownsMain?: boolean;
  model?: boolean;
  main?: string | null;
  studio?: string | null;
  template?: boolean;
}

/** The attempt's diff, and the base it was taken against (the incumbent, or a merged integration head). */
interface AttemptDiff {
  diff: string;
  base: string;
  merged: boolean;
}

/** A command run in the attempt's worktree. */
type Exec = (command: string) => Promise<{ code: number | null; stdout: string }>;

/** Changed files are this facet's only outside the notes and the studio's scratch. */
const DIFF_EXCLUDES = `':(exclude)*.md' ':(exclude).studio/*'`;

/**
 * Review an attempt in a worktree against its incumbent commit. `model: false` keeps it to
 * the mechanical scan (the default for local engines, where a judge call costs minutes).
 */
export async function reviewAttempt(ctx: HarnessCtx, attempt: AttemptReview): Promise<ReviewOutcome> {
  const { spec, worktree, ownsMain = true, model = true, main = null, studio = null, template = true } = attempt;
  const exec: Exec = (command) =>
    ctx.call(HostMethod.RunExec, {
      command,
      cwd: worktree,
      timeoutMs: GIT_TIMEOUT_MS.quick,
      label: `facet:${spec.id}:review-diff`,
    });
  const { diff, base, merged } = await attemptDiff(exec, attempt);
  if (!diff.trim()) return { violations: [], summary: "no source changes", diffChars: 0, base, merged };
  const violations = mechanicalReview(diff, spec, { ownsMain, main, studio, template });
  let summary = violations.length ? `${violations.length} mechanical finding(s)` : "mechanical scan clean";
  if (model && diff.length <= MAX_MODEL_DIFF_CHARS)
    summary = await modelReview(ctx, attempt, diff, violations, summary);
  return { violations, summary, diffChars: diff.length, base, merged, files: [...parseDiff(diff).keys()] };
}

/** The attempt's own changes: against the incumbent, or only what differs from both bases after a merge. */
async function attemptDiff(
  exec: Exec,
  { incumbentCommit, integrationHead = null }: AttemptReview,
): Promise<AttemptDiff> {
  const found: AttemptDiff = { diff: "", base: incumbentCommit, merged: false };
  try {
    // A facet's first module is a NEW file, and `git diff` shows only tracked changes — the
    // intent-to-add makes the whole attempt visible without staging anything for real.
    await exec(GIT.intentToAddAll);
    await findMergedBase(exec, found, integrationHead);
    found.diff = found.merged
      ? await mergedDiff(exec, incumbentCommit, found.base)
      : await diffAgainst(exec, found.base);
  } catch {
    found.diff = "";
  }
  return found;
}

/**
 * After the builder merged the integration head by hand, every file that arrived by
 * merge shows as this facet's edit against the pre-merge incumbent — and enforcement once
 * deleted eleven of them (HARNESS-FIX-PLAN.md WP1a). The diff base is the integration
 * head when it is already an ancestor of HEAD, and only files changed against BOTH bases
 * are this facet's.
 * One or several candidate heads (newest first): the builder may have merged the current
 * integration head by hand while the loop's own last merge is older — the newest ancestor
 * is the base, or every file water changed since reads as this facet's edit.
 */
async function findMergedBase(
  exec: Exec,
  found: AttemptDiff,
  integrationHead: string | string[] | null,
): Promise<void> {
  const incumbentCommit = found.base;
  const candidates = (Array.isArray(integrationHead) ? integrationHead : [integrationHead]).filter(
    (h) => isCommit(h) && h !== incumbentCommit,
  );
  for (const candidate of candidates) {
    const ancestor = await exec(GIT.isAncestor(candidate)).catch(() => ({ code: 1, stdout: "no" }));
    if (ancestor.code === 0 && ancestor.stdout.trim() === "yes") {
      found.merged = true;
      found.base = candidate as string;
      return;
    }
  }
}

/** The worktree's diff against `base`, or nothing when git refuses. */
async function diffAgainst(exec: Exec, base: string, paths = `. ${DIFF_EXCLUDES}`): Promise<string> {
  const listed = await exec(GIT.diff(base, paths));
  return listed.code === 0 ? listed.stdout : "";
}

/** The file names `git diff --name-only` lists against `base`. */
async function changedNames(exec: Exec, base: string): Promise<string[]> {
  const listed = await exec(GIT.diffNames(base, `. ${DIFF_EXCLUDES}`));
  return String(listed.stdout ?? "")
    .split("\n")
    .map((f) => f.trim());
}

/** After a merge: the diff of only the files changed against both the incumbent and the merged base. */
async function mergedDiff(exec: Exec, incumbentCommit: string, base: string): Promise<string> {
  const incumbentFiles = new Set((await changedNames(exec, incumbentCommit)).filter(Boolean));
  const files = (await changedNames(exec, base)).filter((f) => f && incumbentFiles.has(f));
  if (!files.length) return "";
  // A file name is the contractor's to choose: quoted so that nothing in it runs (M3).
  return diffAgainst(exec, base, files.map(shellQuote).join(" "));
}

/** Add the model half's findings to `violations`; answers the summary to report. */
async function modelReview(
  ctx: HarnessCtx,
  { run, spec, main = null, template = true }: AttemptReview,
  diff: string,
  violations: Violation[],
  summary: string,
): Promise<string> {
  try {
    const reviewed = await reviewDiff(ctx, { run, diff, spec: modelReviewSpec(spec, template, main), template });
    for (const v of reviewed.violations) {
      // The judge's rubric hard-codes the same four template rules, so a worker that followed
      // the two-line ask would be told to undo it. They are dropped for a game that is not
      // the template — the same rules the mechanical half above never ran.
      if (template === false && templateOnlyFinding(v)) continue;
      if (!violations.some((m) => m.file === v.file && m.what === v.what)) violations.push(v);
    }
    return reviewed.summary || summary;
  } catch (err: any) {
    if (err?.kind === EngineFailure.Aborted || ctx.cancelled) throw err;
    return `${summary}; model review unavailable (${err?.message ?? err})`;
  }
}

/**
 * The model half reads `owns` as the seam it must judge against, and the judge prompt's
 * own fallback ("its own module under src/") is the template's world. A worker in a game
 * the user brought is told what its seam really is instead.
 */
function modelReviewSpec(spec: ReviewSpec, template: boolean, main: string | null): ReviewSpec {
  if (template !== false || spec.owns?.length) return spec;
  return {
    ...spec,
    owns: [
      `every file of this game except its entry module (${main ?? spec.main ?? DEFAULT_MAIN}), the studio contract and index.html`,
    ],
  };
}

/**
 * Teeth, without a blade (WP1b): a file outside ownership is left alone when its content arrived
 * by merge (it matches an integration head), reverted to the diff base when it exists there, left
 * alone when it is new and an integration head holds it, and quarantined (never deleted) when it
 * is genuinely new. While a merge is still open the revert takes the merged head's copy, never the
 * pre-merge incumbent's. Findings are chosen by their ownership category. `git(command)` runs a
 * shell command in the worktree and returns its stdout.
 */
export async function enforceOwnership(
  git: (command: string) => Promise<string>,
  {
    base,
    integrationHeads = [],
    violations = [],
    iterationId,
  }: {
    base: string;
    integrationHeads?: string[];
    violations?: ReadonlyArray<{ source?: string; what?: string; file?: string; category?: string }>;
    iterationId: string;
  },
): Promise<Array<{ file: string; action: string }>> {
  // M3: a file name is the contractor's and a head comes back from a tool; neither runs as shell.
  commitArg(base);
  const enforced: Array<{ file: string; action: string }> = [];
  const revertTo = (await openMergeHead(git)) ?? base;
  for (const v of violations.filter(isOwnershipFinding) as Array<{ file: string }>) {
    // Hud-2 once reverted city-2's districts: the merge brought them, so they were not hud's edit.
    if (await arrivedByMerge(git, { heads: integrationHeads, file: v.file })) {
      enforced.push({ file: v.file, action: EnforcedAction.Kept });
      continue;
    }
    const atBase = await git(GIT.catFileExists(revertTo, v.file)).catch(() => "no");
    if (atBase === "yes") {
      await git(GIT.checkoutPath(revertTo, v.file)).catch(() => {});
      enforced.push({ file: v.file, action: EnforcedAction.Reverted });
      continue;
    }
    let atIntegration = "no";
    for (const head of integrationHeads.filter(isCommit)) {
      if ((await git(GIT.catFileExists(head, v.file)).catch(() => "no")) === "yes") atIntegration = "yes";
    }
    if (atIntegration === "yes") {
      enforced.push({ file: v.file, action: EnforcedAction.Kept });
      continue;
    }
    const quarantine = `.studio/quarantine/${iterationId}`;
    await git(
      `mkdir -p ${shellQuote(quarantine)} && mv -- ${shellQuote(v.file)} ${shellQuote(`${quarantine}/`)} 2>/dev/null || true`,
    ).catch(() => {});
    enforced.push({ file: v.file, action: `quarantined to ${quarantine}` });
  }
  return enforced;
}

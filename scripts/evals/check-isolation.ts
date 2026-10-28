/**
 * The anti-fitting checker (§6.4), a static check in the `check-vocabulary.ts` mould rather than a
 * test, because a test that reads `src/**` as text is refused by `check-test-style.ts`. It looks
 * for the eval cases and the AA+ suite's briefs inside what the in-app agent reads: a seven-word run
 * of any brief, or a traced checklist phrase, in the harness seed, any game template, plugin skills
 * or a `*-prompts.ts` module is a leak. Village tuning is semantic and invisible here; that is what `Exposure` carries.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AAA_SUITE_FILE, readAaaSuite } from "./aaa/suite.ts";
import { type ParsedCase, readCases, readHoldoutCases } from "./cases.ts";
import { resolveEvalsHome } from "./home.ts";

/** Words in a brief shingle; a brief shorter than this is exempt (the vague brief). */
export const SHINGLE_WORDS = 7;
/**
 * Words a traced checklist phrase needs before it is distinctive enough to be a term. Three let
 * "in the middle" match seven ordinary seed sentences; four words keep only case-specific phrases.
 */
export const TERM_MIN_WORDS = 4;
/** The fewest files a scan may read and still claim the tree is clean (the plan's "more than 20"). */
export const MIN_FILES_SCANNED = 21;

/** What kind of case text a leak is. */
export const LeakKind = {
  Shingle: "shingle",
  Term: "term",
} as const;
export type LeakKind = (typeof LeakKind)[keyof typeof LeakKind];

/** Why a scan measured too little to be believed. */
export const IsolationVacuity = {
  FewSentences: "few-sentences",
  FewFiles: "few-files",
} as const;
export type IsolationVacuity = (typeof IsolationVacuity)[keyof typeof IsolationVacuity];

/** A case's brief. */
export interface IsolationBrief {
  caseId: string;
  text: string;
}

/** A traced checklist phrase of a case. */
export interface IsolationTerm {
  caseId: string;
  term: string;
}

/** One scanned file: its repository path and text. */
export interface IsolationFile {
  path: string;
  text: string;
}

/** One case text found in one file; `match` is the normalized shingle or term. */
export interface Leak {
  file: string;
  caseId: string;
  kind: LeakKind;
  match: string;
}

/** What a scan found, and whether it measured enough to trust a clean result. */
export interface IsolationReport {
  leaks: Leak[];
  filesScanned: number;
  sentences: number;
  /** Cases whose brief is shorter than a shingle, so only their terms were looked for. */
  exempt: string[];
  vacuity: IsolationVacuity[];
}

const SENTENCE_END = /[.!?]+(?=\s|$)/;
const APOSTROPHE = /['’]/g;
const NON_WORD = /[^\p{L}\p{N}]+/u;
const ELLIPSIS = /\.{3}|…/;
const SCANNED_TEXT = /\.(?:md|txt|json|[cm]?[jt]sx?|html|css|glsl|wgsl|ya?ml)$/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", "out", ".git"]);
/** Every game template is read by in-app agents: the Rust and C++ ones carry their API docs. */
const WHOLE_TREES = ["src/harness-seed/", "src/game-template/", "src/game-template-rust/", "src/game-template-cpp/"];
const PLUGIN_SKILLS = /^src\/plugins\/[^/]+\/skills\//;
const PROMPT_MODULE = /-prompts\.ts$/;
/**
 * The graders' rubrics (§8.5): a case's phrasing leaking into them would grade with the answer in
 * hand, so they sit in the scan roots beside what the in-app agent reads.
 */
export const GRADER_RUBRIC_FILES = [
  "scripts/evals/grade/checklist/checklist-prompts.ts",
  "scripts/evals/grade/pairwise-prompt.md",
  "scripts/evals/aaa/taste-prompt.md",
] as const;

/** Lowercase words with apostrophes folded in and every other non-letter a break. */
function words(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().replace(APOSTROPHE, "").split(NON_WORD).filter(Boolean);
}

const sentenceCount = (text: string) => text.split(SENTENCE_END).filter((part) => words(part).length > 0).length;

/** Every run of `SHINGLE_WORDS` words of each brief, to the case it came from. */
function shingles(briefs: readonly IsolationBrief[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const brief of briefs) {
    const list = words(brief.text);
    for (let i = 0; i + SHINGLE_WORDS <= list.length; i++) {
      const shingle = list.slice(i, i + SHINGLE_WORDS).join(" ");
      if (!found.has(shingle)) found.set(shingle, brief.caseId);
    }
  }
  return found;
}

function fileLeaks(file: IsolationFile, shingleMap: Map<string, string>, terms: readonly IsolationTerm[]): Leak[] {
  const list = words(file.text);
  const seen = new Set<string>();
  const leaks: Leak[] = [];
  for (let i = 0; i + SHINGLE_WORDS <= list.length; i++) {
    const shingle = list.slice(i, i + SHINGLE_WORDS).join(" ");
    const caseId = shingleMap.get(shingle);
    if (caseId === undefined || seen.has(shingle)) continue;
    seen.add(shingle);
    leaks.push({ file: file.path, caseId, kind: LeakKind.Shingle, match: shingle });
  }
  const padded = ` ${list.join(" ")} `;
  for (const term of terms) {
    const normalized = words(term.term).join(" ");
    if (normalized && padded.includes(` ${normalized} `))
      leaks.push({ file: file.path, caseId: term.caseId, kind: LeakKind.Term, match: normalized });
  }
  return leaks;
}

/**
 * The case text found in the files. Pure: the caller reads the files. A brief shorter than a
 * shingle is listed as exempt, and a scan with fewer brief sentences than briefs (or no briefs) or
 * too few files reports its vacuity instead of passing.
 */
export function findLeaks(
  briefs: readonly IsolationBrief[],
  terms: readonly IsolationTerm[],
  files: readonly IsolationFile[],
): IsolationReport {
  const sentences = briefs.reduce((sum, brief) => sum + sentenceCount(brief.text), 0);
  const vacuity: IsolationVacuity[] = [];
  if (!briefs.length || sentences < briefs.length) vacuity.push(IsolationVacuity.FewSentences);
  if (files.length < MIN_FILES_SCANNED) vacuity.push(IsolationVacuity.FewFiles);
  const shingleMap = shingles(briefs);
  return {
    leaks: files.flatMap((file) => fileLeaks(file, shingleMap, terms)),
    filesScanned: files.length,
    sentences,
    exempt: briefs.filter((brief) => words(brief.text).length < SHINGLE_WORDS).map((brief) => brief.caseId),
    vacuity,
  };
}

/** The briefs, and the traced phrases (split at an ellipsis) of at least `TERM_MIN_WORDS` words. */
export function isolationInputs(cases: readonly ParsedCase[]): { briefs: IsolationBrief[]; terms: IsolationTerm[] } {
  const briefs = cases.map((c) => ({ caseId: c.id, text: c.brief }));
  const terms = cases.flatMap((c) =>
    c.acceptance
      .flatMap((item) => (item.tracesTo ?? "").split(ELLIPSIS))
      .map((term) => term.trim())
      .filter((term) => words(term).length >= TERM_MIN_WORDS)
      .map((term) => ({ caseId: c.id, term })),
  );
  return { briefs, terms };
}

/** The AA+ release-gate briefs (`evals/aaa/suite.json`), held out the same way; none when the file is absent. */
export function aaaIsolationBriefs(root: string): IsolationBrief[] {
  if (!fs.existsSync(path.join(root, AAA_SUITE_FILE))) return [];
  return readAaaSuite(root).map((prompt) => ({ caseId: `aaa:${prompt.id}`, text: prompt.brief }));
}

/** Whether a repository path is something the in-app agent reads as instructions or code. */
function isInstructionFile(rel: string): boolean {
  if (!SCANNED_TEXT.test(rel)) return false;
  if (WHOLE_TREES.some((tree) => rel.startsWith(tree))) return true;
  return PLUGIN_SKILLS.test(rel) || PROMPT_MODULE.test(rel);
}

/**
 * Every scanned file, by repository path: under `root/src` the harness seed, the game template,
 * plugin skills and prompt modules, plus the graders' rubrics. Symlinks are never followed, so
 * nothing outside those roots is read.
 */
export function isolationFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) walk(rel);
      else if (entry.isFile() && isInstructionFile(rel)) files.push(rel);
    }
  };
  if (fs.existsSync(path.join(root, "src"))) walk("src");
  const rubrics = GRADER_RUBRIC_FILES.filter((rel) =>
    fs.lstatSync(path.join(root, rel), { throwIfNoEntry: false })?.isFile(),
  );
  return [...files, ...rubrics].sort();
}

/** The report lines of a scan: one per leak, then one per vacuity. */
export function isolationLines(report: IsolationReport): string[] {
  return [
    ...report.leaks.map((leak) => `${leak.file}: ${leak.caseId} ${leak.kind} "${leak.match}"`),
    ...report.vacuity.map(
      (code) =>
        `vacuous scan (${code}): ${report.filesScanned} files, ${report.sentences} brief sentences; nothing was measured`,
    ),
  ];
}

/**
 * Scan the repository at `root` for its public cases, plus the holdouts of `holdoutHome` when
 * given. `ok` is false on any leak or vacuity; `lines` name each file and shingle.
 */
export function checkIsolation(root: string, holdoutHome: string | null = null): { ok: boolean; lines: string[] } {
  const cases = [...readCases(root), ...(holdoutHome ? readHoldoutCases(holdoutHome) : [])];
  const inputs = isolationInputs(cases);
  const briefs = [...inputs.briefs, ...aaaIsolationBriefs(root)];
  const { terms } = inputs;
  const files = isolationFiles(root).map((rel) => ({ path: rel, text: fs.readFileSync(path.join(root, rel), "utf8") }));
  const report = findLeaks(briefs, terms, files);
  const lines = isolationLines(report);
  if (lines.length) return { ok: false, lines };
  const exempt = report.exempt.length ? `; exempt by length: ${report.exempt.join(", ")}` : "";
  return {
    ok: true,
    lines: [`Isolation: ${briefs.length} briefs, ${terms.length} terms, ${files.length} files, no leaks${exempt}`],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const withHoldouts = process.argv.includes("--with-holdouts");
  const result = checkIsolation(process.cwd(), withHoldouts ? resolveEvalsHome() : null);
  if (result.ok) console.log(result.lines.join("\n"));
  else {
    console.error(result.lines.join("\n"));
    console.error("Isolation: eval case text leaked into what the in-app agent reads; see docs/evals.md.");
    process.exitCode = 1;
  }
}

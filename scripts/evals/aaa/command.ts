/**
 * The AA+ release gate's commands (`npm run eval -- aaa <suite|collect|grade|references>`,
 * docs/evals.md#the-aa-release-gate). `suite` prints what to run, `collect` turns a finished run into
 * an evidence bundle, `grade` scores bundles into `report.json`, `report.md` and the gate verdict,
 * and `references` fetches the CC0 stills the taste judge compares against. Only `grade --taste live`
 * and `references` reach the network or a model, and both need `--live`.
 */
import fs from "node:fs";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { type CliArgs, parseCliArgs } from "../cli/args.ts";
import { REPO_ROOT } from "../cli/context.ts";
import { CliExit, type Out } from "../cli/exit.ts";
import { DEFAULT_GRADER_MODELS } from "../grade/checklist/family.ts";
import type { GraderComplete } from "../grade/checklist/complete.ts";
import type { GraderPin } from "../grade/types.ts";
import { resolveEvalsHome } from "../home.ts";
import { AaaTasteMode as TasteMode, Effort, GraderFamily } from "../vocabulary.ts";
import { collectEvidence, CollectError } from "./collect.ts";
import {
  type AaaComparison,
  type ComparedRun,
  CompareVerdict,
  compareRuns,
  readPairwiseTasteTemplate,
  renderComparisonMarkdown,
} from "./compare.ts";
import { AaaEvidenceError, readEvidence } from "./evidence.ts";
import { CLOSEUP_ROLE_PREFIX, type GradeContext, MAP_ROLE } from "./honest.ts";
import { type FetchBytes, fetchReferences, REFERENCE_RECORD, referenceStills } from "./references.ts";
import { buildReport, gradePrompt, renderReportMarkdown } from "./report.ts";
import { type AaaPrompt, readAaaSuite } from "./suite.ts";
import { DEFAULT_TASTE_VOTES, judgeTaste, readTasteTemplate, type TasteDeps } from "./taste.ts";
import { judgeVision } from "./vision.ts";

/** Where references live inside `$GENEX_EVALS_HOME`. */
export const REFERENCES_SUBDIR = path.join("aaa", "references");
/** Report file names inside `--out`. */
export const REPORT_JSON = "report.json";
export const REPORT_MD = "report.md";

/** What the commands need from the machine; tests replace any of it. */
export interface AaaDeps {
  root: string;
  home: () => string;
  now: () => Date;
  /** Bind the taste judge's model seam for the given pins; only `--taste live` asks for it. */
  graderComplete: (pins: readonly GraderPin[]) => Promise<GraderComplete>;
  fetchBytes: FetchBytes;
}

/** The machine's dependencies. */
export function systemAaaDeps(): AaaDeps {
  return {
    root: REPO_ROOT,
    home: () => resolveEvalsHome(),
    now: () => new Date(),
    graderComplete: async () => {
      const [{ createGraderEngines }, { engineGraderComplete }, { evalsLayout, applyEvalHomesEnv }] = await Promise.all(
        [
          import("../grade/checklist/engines.ts"),
          import("../grade/checklist/complete.ts"),
          import("../lanes/homes.ts"),
        ],
      );
      const home = resolveEvalsHome();
      const layout = evalsLayout(home);
      applyEvalHomesEnv(layout.homes, process.env);
      const judgeCwd = path.join(home, "judge-cwd");
      await mkdir(judgeCwd, { recursive: true });
      return engineGraderComplete(await createGraderEngines({ homes: layout.homes, judgeCwd, env: process.env }));
    },
    fetchBytes: async (url) => {
      const response = await fetch(url, { redirect: "error" });
      if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

const usage = (out: Out, line: string) => {
  out(`usage: npm run eval -- ${line}`);
  return CliExit.Usage;
};

/** `aaa suite`: every prompt with its version, the views to map, the demos to log and the brief. */
export async function aaaSuiteCommand(args: readonly string[], out: Out, deps: AaaDeps = systemAaaDeps()) {
  if (args.length) return usage(out, "aaa suite");
  for (const p of readAaaSuite(deps.root)) {
    out(`${p.id} @${p.version} (${p.look}): ${p.label}`);
    out(`  views: ${p.views.map((v) => `${v.role} [${v.setting}]`).join(", ")}`);
    out(
      `  motion: ${p.motion.map((d) => d.demo).join(", ")}; doorway: ${p.transitions.map((d) => d.demo).join(", ") || "none"}`,
    );
    out(`  references: ${p.references.map((r) => `${r.source}:${r.asset}`).join(", ")}`);
    out(`  brief: ${p.brief}`);
  }
  out(
    `every run also needs: a ${MAP_ROLE} map and a ${CLOSEUP_ROLE_PREFIX}<character>/<clip> close-up per animation clip, clean and at least 1600×900`,
  );
  return CliExit.Ok;
}

const COLLECT_USAGE =
  "aaa collect --prompt <id> --run <runDir> [--roles <roles.json>] --out <dir> [--shots <dir>] [--facts <facts.json>] [--clean yes|no]";
const CLEAN_VALUES: Readonly<Record<string, boolean>> = { yes: true, no: false };

function readJsonFile(file: string | undefined): unknown {
  return file === undefined ? null : JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

const promptById = (prompts: readonly AaaPrompt[], id: string | undefined) => prompts.find((p) => p.id === id);

/** `aaa collect`: one finished run into an evidence bundle. */
export async function aaaCollectCommand(args: readonly string[], out: Out, deps: AaaDeps = systemAaaDeps()) {
  const parsed = parseCliArgs(args, {
    values: ["--prompt", "--run", "--roles", "--out", "--shots", "--facts", "--clean"],
  });
  const value = (name: string) => parsed?.values.get(name);
  const clean = value("--clean");
  const prompt = promptById(readAaaSuite(deps.root), value("--prompt"));
  const required = ["--run", "--out"].every((name) => value(name) !== undefined);
  if (!parsed || parsed.positional.length || !prompt || !required || (clean !== undefined && !(clean in CLEAN_VALUES)))
    return usage(out, COLLECT_USAGE);
  const outDir = path.resolve(value("--out") as string);
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const evidence = collectEvidence({
      prompt,
      runDir: path.resolve(value("--run") as string),
      shotsDir: value("--shots") === undefined ? null : path.resolve(value("--shots") as string),
      roles: value("--roles") === undefined ? null : (readJsonFile(value("--roles")) as Record<string, string>),
      facts: readJsonFile(value("--facts")),
      clean: clean === undefined ? null : (CLEAN_VALUES[clean] ?? null),
      outDir,
    });
    const mapped = evidence.captures.filter((c) => c.role !== null).length;
    out(`collected ${evidence.captures.length} captures (${mapped} mapped to views) into ${outDir}`);
    return CliExit.Ok;
  } catch (error) {
    if (!(error instanceof CollectError || error instanceof AaaEvidenceError)) throw error;
    out(error.message);
    return CliExit.Refused;
  }
}

const GRADE_USAGE =
  "aaa grade <bundleDir>... --out <dir> [--taste off|live --live] [--taste-family gpt|claude|gpt,claude] [--builder-family claude|gpt] [--votes n] [--references <dir>] [--head <sha>]";
const FAMILIES: ReadonlySet<string> = new Set(Object.values(GraderFamily));

/** The taste pins for `--taste-family`: each family's default model at medium effort. */
export function tastePins(families: readonly string[], promptSha: string): GraderPin[] | null {
  const pins = families.map((family) => DEFAULT_GRADER_MODELS.find((pin) => pin.family === family));
  if (!families.length || pins.some((pin) => pin === undefined)) return null;
  return pins.map((pin) => ({ ...(pin as GraderPin), effort: Effort.Medium, promptSha }));
}

interface GradeOptions {
  bundles: string[];
  outDir: string;
  taste: TasteMode;
  families: string[];
  builderFamily: GraderFamily | null;
  votes: number;
  referencesDir: string | null;
  /** The current integration head the run's dev store must come from. */
  head: string | null;
}

function gradeOptions(parsed: CliArgs | null): GradeOptions | null {
  if (!parsed?.positional.length || !parsed.values.has("--out")) return null;
  const value = (name: string) => parsed.values.get(name);
  const taste = value("--taste") ?? TasteMode.Off;
  const families = (value("--taste-family") ?? GraderFamily.Gpt).split(",");
  const builder = value("--builder-family") ?? GraderFamily.Claude;
  const votes = Number(value("--votes") ?? DEFAULT_TASTE_VOTES);
  const valid =
    Object.values(TasteMode).includes(taste as TasteMode) &&
    families.every((f) => FAMILIES.has(f)) &&
    FAMILIES.has(builder) &&
    Number.isInteger(votes) &&
    votes > 0;
  if (!valid) return null;
  return {
    bundles: parsed.positional.map((dir) => path.resolve(dir)),
    outDir: path.resolve(value("--out") as string),
    taste: taste as TasteMode,
    families,
    builderFamily: builder as GraderFamily,
    votes,
    referencesDir: value("--references") === undefined ? null : path.resolve(value("--references") as string),
    head: value("--head") ?? null,
  };
}

/** The live judge's dependencies, or null when the references were never fetched. */
async function liveTasteDeps(
  options: GradeOptions,
  deps: AaaDeps,
  readTemplate: () => { template: string; sha: string } = readTasteTemplate,
): Promise<{ deps: TasteDeps; template: string } | null> {
  const { template, sha } = readTemplate();
  const pins = tastePins(options.families, sha);
  if (!pins) return null;
  const referencesDir = options.referencesDir ?? path.join(deps.home(), REFERENCES_SUBDIR);
  if (!fs.existsSync(path.join(referencesDir, REFERENCE_RECORD))) return null;
  return {
    template,
    deps: {
      pins,
      complete: await deps.graderComplete(pins),
      votes: options.votes,
      builderFamily: options.builderFamily,
      referenceStills: (prompt, role) => referenceStills(referencesDir, prompt, role),
    },
  };
}

/** One bundle graded, or why it cannot be. */
async function gradeBundle(
  dir: string,
  prompts: readonly AaaPrompt[],
  taste: { deps: TasteDeps; template: string } | null,
  head: string | null = null,
): Promise<(ComparedRun & { prompt: AaaPrompt }) | string> {
  const evidence = readEvidence(dir);
  const prompt = promptById(prompts, evidence.promptId);
  if (!prompt) return `${dir}: prompt ${evidence.promptId} is not in the suite`;
  const verdict = taste
    ? await judgeTaste(prompt, evidence, dir, taste.template, taste.deps)
    : { summary: null, missing: ["taste judge off"] };
  const vision = taste ? (await judgeVision(prompt, evidence, dir, taste.deps)).summary : null;
  const context: GradeContext = { expectedHead: head, vision };
  return { dir, prompt, evidence, report: gradePrompt(prompt, evidence, verdict, context) };
}

/** `aaa grade`: score bundles, write the report and print the gate. Exit 0 when the gate passes, 1 when not. */
export async function aaaGradeCommand(args: readonly string[], out: Out, deps: AaaDeps = systemAaaDeps()) {
  const options = gradeOptions(
    parseCliArgs(args, {
      values: ["--out", "--taste", "--taste-family", "--builder-family", "--votes", "--references", "--head"],
    }),
  );
  if (!options) return usage(out, GRADE_USAGE);
  const prompts = readAaaSuite(deps.root);
  const taste = options.taste === TasteMode.Live ? await liveTasteDeps(options, deps) : null;
  if (options.taste === TasteMode.Live && !taste) {
    out("no reference stills: run `npm run eval -- aaa references --live` first");
    return CliExit.NotReady;
  }
  const graded = [];
  for (const dir of options.bundles) {
    const run = await gradeBundle(dir, prompts, taste, options.head);
    if (typeof run === "string") {
      out(run);
      return CliExit.Refused;
    }
    graded.push(run.report);
  }
  const report = buildReport(graded, options.taste, deps.now());
  fs.mkdirSync(options.outDir, { recursive: true });
  fs.writeFileSync(path.join(options.outDir, REPORT_JSON), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(options.outDir, REPORT_MD), `${renderReportMarkdown(report)}\n`);
  for (const r of graded)
    out(`${r.promptId}: ${r.grade} (blocked by ${r.blockers.map((c) => c.floor).join(", ") || "nothing"})`);
  out(`release gate: ${report.gate.pass ? "PASS" : "FAIL"} (${report.gate.lines.join("; ")})`);
  return report.gate.pass ? CliExit.Ok : CliExit.Refused;
}

const COMPARE_USAGE =
  "aaa compare <candidateBundle> --baseline <baselineBundle> --out <dir> [--taste off|live --live] [--taste-family gpt|claude|gpt,claude] [--references <dir>]";
/** The side-by-side page and record inside `--out`. */
export const COMPARE_JSON = "compare.json";
export const COMPARE_MD = "compare.md";

/** Copy each side's compared captures next to the page, so the page stands alone. */
function copyPairImages(comparison: AaaComparison, base: ComparedRun, cand: ComparedRun, outDir: string): void {
  for (const view of comparison.views)
    for (const [side, run, image] of [
      ["baseline", base, view.baseline],
      ["candidate", cand, view.candidate],
    ] as const) {
      if (!image) continue;
      const target = path.join(outDir, side, image);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(run.dir, image), target);
    }
}

/**
 * `aaa compare`: a candidate run beside a baseline run of the same prompt. Exit 0 when the candidate
 * is clearly better, 1 when not (or a bundle was refused), 2 when a live judge has no references.
 */
export async function aaaCompareCommand(args: readonly string[], out: Out, deps: AaaDeps = systemAaaDeps()) {
  const parsed = parseCliArgs(args, {
    values: [
      "--baseline",
      "--out",
      "--taste",
      "--taste-family",
      "--builder-family",
      "--votes",
      "--references",
      "--head",
    ],
  });
  const options = gradeOptions(parsed);
  const baselineDir = parsed?.values.get("--baseline");
  if (options?.bundles.length !== 1 || !baselineDir) return usage(out, COMPARE_USAGE);
  const prompts = readAaaSuite(deps.root);
  const live = options.taste === TasteMode.Live;
  const taste = live ? await liveTasteDeps(options, deps) : null;
  const pairwise = live ? await liveTasteDeps(options, deps, readPairwiseTasteTemplate) : null;
  if (live && (!taste || !pairwise)) {
    out("no reference stills: run `npm run eval -- aaa references --live` first");
    return CliExit.NotReady;
  }
  const base = await gradeBundle(path.resolve(baselineDir), prompts, taste, options.head);
  const cand = await gradeBundle(options.bundles[0] as string, prompts, taste, options.head);
  if (typeof base === "string" || typeof cand === "string") {
    out(typeof base === "string" ? base : String(cand));
    return CliExit.Refused;
  }
  if (base.prompt.id !== cand.prompt.id) {
    out(`the runs answer different prompts: ${base.prompt.id} and ${cand.prompt.id}`);
    return CliExit.Refused;
  }
  const comparison = await compareRuns(cand.prompt, base, cand, pairwise);
  fs.mkdirSync(options.outDir, { recursive: true });
  copyPairImages(comparison, base, cand, options.outDir);
  fs.writeFileSync(path.join(options.outDir, COMPARE_JSON), `${JSON.stringify(comparison, null, 2)}\n`);
  const page = renderComparisonMarkdown(comparison, (side, image) => `${side}/${image}`);
  fs.writeFileSync(path.join(options.outDir, COMPARE_MD), `${page}\n`);
  out(`${comparison.promptId}: ${comparison.verdict} (${comparison.reasons.join("; ")})`);
  return comparison.verdict === CompareVerdict.ClearlyBetter ? CliExit.Ok : CliExit.Refused;
}

/** `aaa references`: fetch the suite's CC0 stills into the eval home (needs `--live`). */
export async function aaaReferencesCommand(args: readonly string[], out: Out, deps: AaaDeps = systemAaaDeps()) {
  const parsed = parseCliArgs(args, { values: ["--dir"] });
  if (!parsed || parsed.positional.length) return usage(out, "aaa references --live [--dir <dir>]");
  const dir = path.resolve(parsed.values.get("--dir") ?? path.join(deps.home(), REFERENCES_SUBDIR));
  const records = await fetchReferences(readAaaSuite(deps.root), dir, deps.fetchBytes);
  out(`${records.length} CC0 references in ${dir}`);
  return CliExit.Ok;
}

/**
 * The `campaign plan` and `campaign run` command handlers for `scripts/eval.ts` (§12). Each takes
 * the command's arguments, a line printer and, for tests, its dependencies; without them it binds
 * the machine's own: the repository's case file and lane registry, the evals home, git for SHAs,
 * the real lane runners, the sandboxed snapshot server and the boot probe.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ProcessSandbox } from "../../../src/substrate/spawn.ts";
import { budgetCaps, engineQuotaReader, type QuotaReader, SYSTEM_BUDGET_CLOCK } from "../budget.ts";
import type { EvalCase } from "../case-types.ts";
import { readCases, readHoldoutCases, resolveStartFrom } from "../cases.ts";
import { probeBoot } from "../grade/quick-probe.ts";
import { sandboxedServe } from "../grade/serve.ts";
import type { ServeSnapshot } from "../grade/types.ts";
import { resolveEvalsHome } from "../home.ts";
import { prepareAppBuild, runGenexAppLane, systemGenexLaneDeps } from "../lanes/genex-app.ts";
import { installInterruptReaper } from "../lanes/common.ts";
import { laneCliResolver } from "../lanes/fixture-stubs.ts";
import {
  applyEvalHomesEnv,
  EvalHomesError,
  type EvalsLayout,
  evalHomesRefusalLines,
  evalsLayout,
} from "../lanes/homes.ts";
import { runRawLane, systemRawLaneDeps } from "../lanes/raw.ts";
import { readLaneRegistry } from "../lanes/registry.ts";
import type { LaneRegistry } from "../lanes/types.ts";
import { type EvalsPaths, evalsPaths } from "../ledger/paths.ts";
import { readRunRows } from "../ledger/read.ts";
import { appendLedgerRow } from "../ledger/write.ts";
import { readPriceTable } from "../prices.ts";
import { PROBE_LOCK_DIR, PROBE_LOCK_FILE } from "../prober/lock.ts";
import { EvalAgent } from "../vocabulary.ts";
import { APP_VENDOR_DIR, createCanaryJudge } from "./canary.ts";
import {
  CampaignPlanError,
  DEFAULT_CAMPAIGN_LABEL,
  formatPlan,
  planCampaign,
  readCampaignPlan,
  writeCampaignPlan,
} from "./plan.ts";
import { machineFacts } from "./row.ts";
import {
  AbandonedRunLiveError,
  CampaignOutcome,
  type CampaignRunDeps,
  type CampaignRunReport,
  type LaneRunner,
  runCampaign,
} from "./run.ts";
import type { CampaignPlan } from "./types.ts";

const run = promisify(execFile);

/** The exit code of each campaign outcome; a stopped campaign resumes, so it is a temporary failure. */
export const CAMPAIGN_EXIT: Readonly<Record<CampaignOutcome, number>> = {
  [CampaignOutcome.Completed]: 0,
  [CampaignOutcome.DryRun]: 0,
  [CampaignOutcome.Aborted]: 3,
  [CampaignOutcome.Void]: 4,
  [CampaignOutcome.Refused]: 65,
  [CampaignOutcome.Stopped]: 75,
};
/** The exit code of bad usage (unknown flag, missing value), as `scripts/eval.ts` spells it. */
export const EXIT_CAMPAIGN_USAGE = 64;
/** The default selectors: every primary lane. */
const DEFAULT_LANES = "primary";
/** Random bytes behind a generated interleave seed. */
const SEED_BYTES = 8;

/** A usage error: an unknown flag, a flag without its value, or a value that is not a number. */
export class CampaignUsageError extends Error {
  constructor(detail: string) {
    super(`usage: ${detail}`);
    this.name = "CampaignUsageError";
  }
}

/** Parsed command-line flags and positional arguments. */
export interface ParsedArgs {
  values: Map<string, string>;
  switches: Set<string>;
  positional: string[];
}

/** Split arguments into `--flag value` pairs, bare `--switch`es and positionals; anything unknown is refused. */
export function parseArgs(
  args: readonly string[],
  spec: { values: readonly string[]; switches: readonly string[] },
): ParsedArgs {
  const parsed: ParsedArgs = { values: new Map(), switches: new Set(), positional: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("--")) {
      parsed.positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (spec.switches.includes(name)) parsed.switches.add(name);
    else if (spec.values.includes(name)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new CampaignUsageError(`--${name} needs a value`);
      parsed.values.set(name, value);
      index++;
    } else throw new CampaignUsageError(`unknown flag ${arg}`);
  }
  return parsed;
}

const listOf = (value: string | undefined): string[] =>
  value
    ? value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : [];

function numberOf(parsed: ParsedArgs, name: string): number | null {
  const value = parsed.values.get(name);
  if (value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new CampaignUsageError(`--${name} takes a number`);
  return number;
}

// ── plan ─────────────────────────────────────────────────────────────────────────────────

/** What `campaign plan` reads and writes. */
export interface PlanCommandDeps {
  paths: EvalsPaths;
  cases: () => EvalCase[];
  registry: () => LaneRegistry;
  /** The full commit SHA a ref names, in the repository under evaluation. */
  resolveSha: (ref: string) => Promise<string>;
  now: () => number;
  randomSeed: () => string;
}

/** The public cases and, when the private file exists, the holdouts. */
/** Where an edit case starts from in this checkout; null for a case built from nothing. */
const startDirIn = (root: string) => (evalCase: EvalCase) =>
  evalCase.startFrom === null ? null : resolveStartFrom(root, evalCase);

function allCases(root: string, evalsHome: string): EvalCase[] {
  return [...readCases(root), ...readHoldoutCases(evalsHome)];
}

/** The full commit SHA of a ref (`HEAD`, a branch, a short SHA) in `repo`. */
export function gitShaResolver(repo: string): (ref: string) => Promise<string> {
  return async (ref) => {
    if (ref.startsWith("-")) throw new CampaignUsageError(`not a ref: ${ref}`);
    const { stdout } = await run("git", ["-C", repo, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
    return stdout.trim();
  };
}

/** The repository these scripts belong to. */
function repoRoot(): string {
  return path.resolve(import.meta.dirname, "../../..");
}

/** The machine's own `campaign plan` dependencies. */
export function systemPlanDeps(env: NodeJS.ProcessEnv = process.env): PlanCommandDeps {
  const root = repoRoot();
  const home = resolveEvalsHome({ env });
  return {
    paths: evalsPaths(home),
    cases: () => allCases(root, home),
    registry: () => readLaneRegistry(root),
    resolveSha: gitShaResolver(root),
    now: () => Date.now(),
    randomSeed: () => BigInt(`0x${randomBytes(SEED_BYTES).toString("hex")}`).toString(36),
  };
}

const PLAN_FLAGS = {
  values: ["cases", "lanes", "reps", "apps", "deadline-min", "seed", "label"],
  switches: [],
} as const;

/** The plan input from the command line; the apps default to HEAD when a Genex lane is selected. */
async function planFromArgs(args: readonly string[], deps: PlanCommandDeps): Promise<CampaignPlan> {
  const parsed = parseArgs(args, PLAN_FLAGS);
  if (parsed.positional.length) throw new CampaignUsageError(`unexpected ${parsed.positional.join(" ")}`);
  const registry = deps.registry();
  const laneSelectors = listOf(parsed.values.get("lanes") ?? DEFAULT_LANES);
  const refs = listOf(parsed.values.get("apps"));
  const genex = registry.lanes.some(
    (lane) =>
      lane.agent === EvalAgent.GenexApp && (laneSelectors.includes(lane.id) || laneSelectors.includes(lane.status)),
  );
  const apps = await Promise.all((refs.length || !genex ? refs : ["HEAD"]).map((ref) => deps.resolveSha(ref)));
  return planCampaign({
    cases: deps.cases(),
    registry,
    caseIds: listOf(parsed.values.get("cases")),
    laneSelectors,
    reps: numberOf(parsed, "reps") ?? 1,
    apps,
    deadlineMin: numberOf(parsed, "deadline-min"),
    seed: parsed.values.get("seed") ?? deps.randomSeed(),
    label: parsed.values.get("label") ?? DEFAULT_CAMPAIGN_LABEL,
    nowMs: deps.now(),
  });
}

/** Print a refusal's code; answers the usage exit code. */
function refused(error: unknown, out: (line: string) => void): number {
  if (error instanceof CampaignUsageError || error instanceof CampaignPlanError) {
    out(error.message);
    return EXIT_CAMPAIGN_USAGE;
  }
  if (error instanceof EvalHomesError) {
    for (const line of evalHomesRefusalLines(error)) out(line);
    return EXIT_CAMPAIGN_USAGE;
  }
  if (error instanceof AbandonedRunLiveError) {
    out(error.message);
    return EXIT_CAMPAIGN_USAGE;
  }
  throw error;
}

/**
 * `campaign plan --cases … --lanes … --reps N [--apps base,cand] [--deadline-min 90] [--seed s]
 * [--label l]`: print the matrix, the seeded order, the canary brackets and the estimates, and
 * write `campaign.json`.
 */
export async function campaignPlanCommand(
  args: readonly string[],
  out: (line: string) => void = console.log,
  given?: PlanCommandDeps,
): Promise<number> {
  const deps = given ?? systemPlanDeps();
  try {
    const plan = await planFromArgs(args, deps);
    const file = await writeCampaignPlan(deps.paths, plan);
    for (const line of formatPlan(plan).split("\n")) out(line);
    out(`wrote ${file}`);
    return 0;
  } catch (error) {
    return refused(error, out);
  }
}

// ── run ──────────────────────────────────────────────────────────────────────────────────

const RUN_FLAGS = {
  values: ["budget-hours", "max-quota", "max-runs"],
  switches: ["live", "account-exclusive", "serial"],
} as const;

/** The sandboxed snapshot server the canary serves through (grading's, `sandboxedServe`), made on first use. */
export function lazyServe(paths: EvalsPaths): ServeSnapshot {
  return sandboxedServe(paths, (options) => ProcessSandbox.create(options));
}

/**
 * The machine's lane runner: the Genex app or the raw CLI. A fixture lane runs the scripted engines
 * (Genex) or the stub CLIs (raw) and never reads a provider's quota; every other lane runs the
 * machine's CLIs and reads its provider's quota around the run.
 */
export function systemLaneRunner(layout: EvalsLayout, readQuota: QuotaReader, userHome: string): LaneRunner {
  return (request) => {
    const quota = request.lane.fixture ? null : readQuota;
    if (request.lane.agent === EvalAgent.GenexApp)
      return runGenexAppLane(request, systemGenexLaneDeps(userHome, quota));
    const raw = systemRawLaneDeps(layout, quota);
    return runRawLane(request, { ...raw, resolveCli: laneCliResolver(request.lane, raw.resolveCli) });
  };
}

/** The machine's own `campaign run` dependencies, with this process's engines pointed at the eval homes. */
export async function systemRunDeps(env: NodeJS.ProcessEnv = process.env): Promise<CampaignRunDeps> {
  const root = repoRoot();
  const home = resolveEvalsHome({ env });
  const layout = evalsLayout(home);
  const paths = evalsPaths(home);
  applyEvalHomesEnv(layout.homes, env);
  // A lane runs in its own process group: a Ctrl-C must stop it before this process exits.
  installInterruptReaper();
  const readQuota: QuotaReader = engineQuotaReader(layout, env);
  const userHome = os.homedir();
  const { stdout } = await run("git", ["-C", root, "rev-parse", "HEAD"]);
  return {
    paths,
    layout,
    cases: allCases(root, home),
    startDir: startDirIn(root),
    registry: readLaneRegistry(root),
    prices: readPriceTable(root),
    clock: SYSTEM_BUDGET_CLOCK,
    runLane: systemLaneRunner(layout, readQuota, userHome),
    buildApp: (sha) => prepareAppBuild({ repo: root, sha, buildsDir: layout.builds }),
    readQuota,
    judgeCanary: createCanaryJudge({
      serve: lazyServe(paths),
      probeBoot: (url, options) =>
        probeBoot(url, options, { lockPath: path.join(home, PROBE_LOCK_DIR, PROBE_LOCK_FILE) }),
      vendorDir: path.join(root, APP_VENDOR_DIR),
      npmCacheDir: paths.npmCache,
    }),
    appendRow: async (row) => {
      await appendLedgerRow(row, { paths });
    },
    readRows: () => readRunRows(paths),
    machine: machineFacts(stdout.trim()),
    userHome,
    out: console.log,
  };
}

/** One line per outcome, with what is left. */
function summary(report: CampaignRunReport): string {
  const why = report.refusal ?? report.voidReason ?? report.stop;
  return `${report.outcome}${why ? ` (${why})` : ""}: ran ${report.ran.length}, pending ${report.pending.length}`;
}

/**
 * `campaign run <id> [--live] [--budget-hours 8] [--max-quota 70] [--max-runs N]
 * [--account-exclusive] [--serial]`: without `--live` it lists what would run and touches nothing.
 */
export async function campaignRunCommand(
  args: readonly string[],
  out: (line: string) => void = console.log,
  given?: CampaignRunDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const parsed = parseArgs(args, RUN_FLAGS);
    const [campaignId, ...extra] = parsed.positional;
    if (!campaignId || extra.length) throw new CampaignUsageError("campaign run <id>");
    const hours = numberOf(parsed, "budget-hours");
    const maxQuotaPercent = numberOf(parsed, "max-quota");
    const caps = budgetCaps({
      ...(hours === null ? {} : { hours }),
      ...(maxQuotaPercent === null ? {} : { maxQuotaPercent }),
      maxRuns: numberOf(parsed, "max-runs"),
    });
    const live = parsed.switches.has("live");
    const deps = given ?? (live ? await systemRunDeps(env) : await dryRunDeps(env));
    const plan = await readCampaignPlan(deps.paths, campaignId);
    const report = await runCampaign(
      plan,
      { live, caps, accountExclusive: parsed.switches.has("account-exclusive"), serial: parsed.switches.has("serial") },
      { ...deps, out },
    );
    out(summary(report));
    return CAMPAIGN_EXIT[report.outcome];
  } catch (error) {
    if (error instanceof RangeError) return refused(new CampaignUsageError(error.message), out);
    return refused(error, out);
  }
}

/** A dry run's dependencies: it reads the plan, the cases, the registry and the ledger, and nothing else. */
async function dryRunDeps(env: NodeJS.ProcessEnv = process.env): Promise<CampaignRunDeps> {
  const root = repoRoot();
  const home = resolveEvalsHome({ env });
  const paths = evalsPaths(home);
  const refuse = async (): Promise<never> => {
    throw new Error("a dry run starts nothing");
  };
  return {
    paths,
    layout: evalsLayout(home),
    cases: allCases(root, home),
    startDir: startDirIn(root),
    registry: readLaneRegistry(root),
    prices: readPriceTable(root),
    clock: SYSTEM_BUDGET_CLOCK,
    runLane: refuse,
    buildApp: refuse,
    readQuota: async () => null,
    judgeCanary: refuse,
    appendRow: refuse,
    readRows: () => readRunRows(paths),
    machine: machineFacts("0000000"),
    userHome: os.homedir(),
    out: console.log,
  };
}

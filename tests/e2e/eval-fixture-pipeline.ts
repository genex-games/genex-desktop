/**
 * The fixture-lane pipeline end to end (plan M2.7, §13.8), driven by `run-eval-fixture.mjs`. Every
 * command goes through the eval CLI's own registry (`scripts/eval.ts` `main`), with its handler
 * bound to a disposable `$GENEX_EVALS_HOME` outside any repository and to no provider:
 *
 * - Lanes A/D launch the built app (`dist/`) as the real Electron smoke sub-runner with
 *   `--studio-eval-lane --studio-eval-fixture`, so the app's scripted fixture engines answer. Those
 *   engines never edit a game, so this driver stands in for the agent's edits once the app has
 *   seeded and reported the game: it writes a calibration game over it ("calibration games stand
 *   in for outputs").
 * - Lanes B/C run the stub CLIs through `campaign run`'s own machine runner: each replays a
 *   recorded, redacted stream with its receive timing and writes the recorded game.
 * - Canaries and grades are served from sandboxed copies and probed by the real quick prober when
 *   Chromium launches; otherwise probing is skipped as a typed `scripted` mode (a stand-in that
 *   reads the seeded defect from the served files) and everything else still runs.
 * - Graders are an evidence-reading fixture function, never a model: yes to an item only when the
 *   probe attached frames and logged no seeded break, no to the control, a tie in every pairwise
 *   facet; a synthetic calibration covers exactly their pins.
 *
 * Then the version axis: the same lane on a base and a candidate app build, where the candidate's
 * seeded defect is a boot-breaking variant of the case's fixture game. `check` must exit with the
 * regression or probable code and name the cell, and the ledger must validate and pass the guard.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { main } from "../../scripts/eval.ts";
import { SYSTEM_BUDGET_CLOCK } from "../../scripts/evals/budget.ts";
import { canaryPassed, createCanaryJudge, APP_VENDOR_DIR } from "../../scripts/evals/campaign/canary.ts";
import {
  campaignPlanCommand,
  campaignRunCommand,
  lazyServe,
  type PlanCommandDeps,
  systemLaneRunner,
} from "../../scripts/evals/campaign/commands.ts";
import { machineFacts } from "../../scripts/evals/campaign/row.ts";
import type { CampaignRunDeps, LaneRunner } from "../../scripts/evals/campaign/run.ts";
import { CANARY_CASE_ID } from "../../scripts/evals/campaign/types.ts";
import { readCases } from "../../scripts/evals/cases.ts";
import { checkCommand } from "../../scripts/evals/cli/check.ts";
import { biomeFormatter, type CliContext } from "../../scripts/evals/cli/context.ts";
import type { CliRun } from "../../scripts/evals/cli/exit.ts";
import { validateLedgerCommand } from "../../scripts/evals/cli/ledger.ts";
import { reportCommand } from "../../scripts/evals/cli/report.ts";
import { gradeCommand, type GradingCommandContext } from "../../scripts/evals/grade/commands.ts";
import type { GraderComplete } from "../../scripts/evals/grade/checklist/complete.ts";
import { defaultGraderPins } from "../../scripts/evals/grade/checklist/family.ts";
import { CHECKLIST_PROMPT_SHA } from "../../scripts/evals/grade/checklist/prompt.ts";
import { readPairwiseRubric } from "../../scripts/evals/grade/pairwise.ts";
import { DEFAULT_VOTES_PER_FAMILY } from "../../scripts/evals/grade/pipeline.ts";
import { probeBoot, runQuickProbe } from "../../scripts/evals/grade/quick-probe.ts";
import type {
  BootProbeResult,
  CalibrationResult,
  FrameRef,
  ProbeBoot,
  QuickProbeResult,
  RunFullProbe,
  RunQuickProbe,
  ServeSnapshot,
} from "../../scripts/evals/grade/types.ts";
import { EVALS_HOME_ENV } from "../../scripts/evals/home.ts";
import { fixtureStubResolver } from "../../scripts/evals/lanes/fixture-stubs.ts";
import { readLaneReport } from "../../scripts/evals/lanes/genex-app.ts";
import { evalsLayout } from "../../scripts/evals/lanes/homes.ts";
import { readStreamRecords } from "../../scripts/evals/lanes/common.ts";
import type { LaneRunRequest, LaneRunResult } from "../../scripts/evals/lanes/types.ts";
import { readLaneRegistry } from "../../scripts/evals/lanes/registry.ts";
import { guardRow } from "../../scripts/evals/ledger/guard.ts";
import { evalsPaths, type EvalsPaths } from "../../scripts/evals/ledger/paths.ts";
import { currentRows, readPairwiseRows, readRunRows } from "../../scripts/evals/ledger/read.ts";
import type { RunRow } from "../../scripts/evals/ledger/types.ts";
import { appendLedgerRow } from "../../scripts/evals/ledger/write.ts";
import { readPriceTable } from "../../scripts/evals/prices.ts";
import { probeLockPath, withProbeLock } from "../../scripts/evals/prober/lock.ts";
import { PROBER_VERSION } from "../../scripts/evals/prober/types.ts";
import { bootOutcome } from "../../scripts/evals/report/endpoints.ts";
import {
  CheckResult,
  CheckState,
  CHECK_EXIT_CODE,
  EntranceVia,
  EvalAgent,
  EvalCommand,
  ProbePhase,
  ProbeRow,
  RendererMode,
  RowKind,
  ServedVia,
} from "../../scripts/evals/vocabulary.ts";
import { ZERO_TOKEN_USAGE } from "../../src/shared/eval-lane.ts";
import { EngineId } from "../../src/shared/providers.ts";

const run = promisify(execFile);

/** How the pipeline probes: the real quick prober in Chromium, or the typed scripted stand-in when Chromium is missing. */
export const ProbeMode = { Chromium: "chromium", Scripted: "scripted" } as const;
export type ProbeMode = (typeof ProbeMode)[keyof typeof ProbeMode];

/** The case every fixture campaign builds: the recorded games are its known-good mini golf. */
const CASE_ID = "mini-golf";
/** The Genex fixture lane the version axis runs on. */
const VERSION_LANE = "fixture-genex";
/** Every fixture lane, by the registry's status selector. */
const FIXTURE_LANES = "fixture";
/** The version axis needs a base that arms the gate (≥ 6 booting runs) and a candidate that reaches a verdict. */
const VERSION_REPS = 6;
/** The interleave seed both campaigns are planned with, so the order is reproducible. */
const SEED = "fixturee2e";
/** The app refs the plan names; the driver resolves them itself. */
const APP_REF = { Base: "base", Candidate: "cand" } as const;
/** The minimum receive span a replayed stub stream must show: the recorded gaps are kept, not collapsed. */
const MIN_REPLAY_SPAN_MS = 1000;
/** The model the fixture graders are pinned to: the fixture engines' own model id. */
const FIXTURE_GRADER_MODEL = "fixture-v1";
/** The calibration game every fixture output stands in with. */
const GAME_FIXTURE = path.join("tests", "fixtures", "evals", "calibration", "known-good-mini-golf");
/** The candidate's seeded defect: an uncaught error before the first frame (the prober's boot failure, §8.1). */
const SEEDED_BREAK_TEXT = "seeded boot break";
const SEEDED_BREAK = `queueMicrotask(() => {\n  throw new Error("${SEEDED_BREAK_TEXT}");\n});\n`;
/** The scripted probe's version pin, so a scripted grade never passes for a real one. */
const SCRIPTED_PROBER_VERSION = `${PROBER_VERSION}+scripted`;
/** A frame the scripted probe writes: PNG magic and a label. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** What each pairwise facet gets from the fixture judge. */
const PAIRWISE_TIE = ["OVERALL", "WORKS", "VISUALS", "FEEL", "PLAY"].map((facet) => `${facet}: TIE`).join("\n");
/** The line the pairwise rubric (and only it) asks for. */
const PAIRWISE_MARK = "OVERALL: LEFT, RIGHT or TIE";
/** Variables that make the eval CLI think it runs in CI, where the live gate refuses everything. */
const CI_VARIABLES = ["CI", "GITHUB_ACTIONS"] as const;

/** What the driver is given. */
export interface EvalFixtureOptions {
  /** The repository whose `dist/` is the app build under test. */
  repo: string;
  /** A disposable `$GENEX_EVALS_HOME`, outside any repository. */
  home: string;
  /** Where the evidence is kept (`.studio-dev/evidence/…`). */
  evidenceDir: string;
  /** The user's home, for the workspace ancestor guard. */
  userHome: string;
  /** Force the scripted probe even when Chromium launches. */
  scriptedProbe: boolean;
  out: (line: string) => void;
}

/** One CLI command the pipeline ran. */
export interface StepRecord {
  command: string;
  exit: number;
  expected: readonly number[];
  ms: number;
  output: string[];
}

/** What the pipeline did and whether every expectation held. */
export interface EvalFixtureReport {
  ok: boolean;
  probe: { mode: ProbeMode; reason: string | null };
  campaigns: { pipeline: string | null; version: string | null };
  steps: StepRecord[];
  failures: string[];
  evidenceDir: string;
  home: string;
}

/** The machine and app identity a run is recorded against. */
interface Identity {
  baseSha: string;
  candidateSha: string;
  dirty: boolean;
}

/** Everything a pipeline run shares. */
interface World {
  options: EvalFixtureOptions;
  paths: EvalsPaths;
  identity: Identity;
  handlers: Partial<Record<EvalCommand, CliRun>>;
  steps: StepRecord[];
  failures: string[];
}

// ── the probe ───────────────────────────────────────────────────────────────────────────

/** Whether Playwright's Chromium launches here; the reason when it does not. */
async function chromiumMissing(): Promise<string | null> {
  try {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return null;
  } catch (error) {
    return String(error instanceof Error ? error.message : error).split("\n")[0] ?? "launch failed";
  }
}

/** Whether a served game carries the candidate's seeded defect. */
async function seededBreak(root: string): Promise<boolean> {
  const code = await readFile(path.join(root, "main.js"), "utf8").catch(() => "");
  return code.includes(SEEDED_BREAK_TEXT);
}

/** The scripted stand-in for the prober: it reads the served files, never renders them. */
function scriptedProbes(serve: ServeSnapshot) {
  const roots = new Map<string, string>();
  const tracked: ServeSnapshot = async (options) => {
    const handle = await serve(options);
    roots.set(handle.url, handle.root);
    return handle;
  };
  const boot = async (url: string): Promise<CheckResult> => {
    const root = roots.get(url);
    if (!root) return CheckResult.Unknown;
    return (await seededBreak(root)) ? CheckResult.Fail : CheckResult.Pass;
  };
  const probeBootScripted: ProbeBoot = async (url, options): Promise<BootProbeResult> => {
    const booted = await boot(url);
    return {
      booted,
      firstRenderMs: booted === CheckResult.Pass ? 0 : null,
      uncaughtBeforeFirstDraw: booted === CheckResult.Fail,
      degenerateCanvas: false,
      rendererMode: options.rendererMode,
      servedVia: options.servedVia ?? ServedVia.AsIs,
      consoleErrors: booted === CheckResult.Fail ? 1 : 0,
      frames: [],
    };
  };
  const quickScripted: RunQuickProbe = async (url, options): Promise<QuickProbeResult> => {
    const booted = await boot(url);
    await mkdir(options.evidenceDir, { recursive: true });
    const consoleSummaryPath = path.join(options.evidenceDir, "console-summary.json");
    const networkSummaryPath = path.join(options.evidenceDir, "network-summary.json");
    await writeFile(consoleSummaryPath, booted === CheckResult.Fail ? JSON.stringify([SEEDED_BREAK_TEXT]) : "[]");
    await writeFile(networkSummaryPath, "[]");
    const frames: FrameRef[] = [];
    if (booted === CheckResult.Pass) {
      const file = path.join(options.evidenceDir, "frame-0.png");
      await writeFile(file, Buffer.concat([PNG_MAGIC, Buffer.from("scripted")]));
      frames.push({
        path: file,
        atMs: 0,
        phase: ProbePhase.InputBurst,
        origin: new URL(url).origin,
        width: 8,
        height: 8,
      });
    }
    return {
      rows: { [ProbeRow.L1BuildsAndBoots]: booted },
      l1Gate: booted,
      l2Gate: CheckResult.Unknown,
      scored: false,
      entrance: EntranceVia.None,
      firstRenderMs: booted === CheckResult.Pass ? 0 : null,
      fpsMedian: null,
      consoleErrors: booted === CheckResult.Fail ? 1 : 0,
      rendererMode: options.rendererMode,
      servedVia: options.servedVia ?? ServedVia.AsIs,
      evidence: {
        gameOrigin: new URL(url).origin,
        frames,
        consoleSummaryPath,
        networkSummaryPath,
        videoPath: null,
        summaryBytes: 0,
      },
      proberVersion: SCRIPTED_PROBER_VERSION,
      noErrorsMs: options.noErrorsMs,
      quick: true,
    };
  };
  return { serve: tracked, probeBoot: probeBootScripted, quickProbe: quickScripted };
}

/** The real probers over the sandboxed server, or the scripted stand-ins. */
function probers(mode: ProbeMode, paths: EvalsPaths) {
  const serve = lazyServe(paths);
  const lockPath = probeLockPath({ [EVALS_HOME_ENV]: paths.home });
  const noFullProbe: RunFullProbe = async () => {
    throw new Error("the fixture pipeline grades with the quick probe only");
  };
  const withLock = <T>(fn: () => Promise<T>) => withProbeLock(lockPath, fn);
  if (mode === ProbeMode.Scripted)
    return { ...scriptedProbes(serve), fullProbe: noFullProbe, withLock, proberVersion: SCRIPTED_PROBER_VERSION };
  return {
    serve,
    probeBoot: ((url, options) => probeBoot(url, options, { lockPath })) satisfies ProbeBoot,
    quickProbe: ((url, options) => runQuickProbe(url, options, { lockPath })) satisfies RunQuickProbe,
    fullProbe: noFullProbe,
    withLock,
    proberVersion: PROBER_VERSION,
  };
}

// ── the fixture agent and graders ───────────────────────────────────────────────────────

/** Write the calibration game over a seeded Genex game; the candidate's non-canary games carry the seeded break. */
async function writeStandIn(repo: string, dir: string, broken: boolean): Promise<void> {
  const source = path.join(repo, GAME_FIXTURE);
  await copyFile(path.join(source, "index.html"), path.join(dir, "index.html"));
  const code = await readFile(path.join(source, "main.js"), "utf8");
  await writeFile(path.join(dir, "main.js"), broken ? `${SEEDED_BREAK}${code}` : code);
}

/** Whether `dir` is a folder inside `root`, by real path. */
async function folderInside(root: string, dir: string): Promise<boolean> {
  if (!dir) return false;
  const [realRoot, realDir] = await Promise.all([realpath(root).catch(() => null), realpath(dir).catch(() => null)]);
  if (!realRoot || !realDir) return false;
  const info = await stat(realDir).catch(() => null);
  return Boolean(info?.isDirectory()) && realDir.startsWith(`${realRoot}${path.sep}`);
}

/**
 * The lane runner: `campaign run`'s machine runner (the app for A/D, the stubs for B/C), then, for a
 * Genex run the app reported, the stand-in for the agent's edits in the game it seeded.
 */
function fixtureRunner(world: { repo: string; identity: Identity; userHome: string; paths: EvalsPaths }): LaneRunner {
  const machine = systemLaneRunner(evalsLayout(world.paths.home), async () => null, world.userHome);
  return async (request: LaneRunRequest): Promise<LaneRunResult> => {
    const result = await machine(request);
    const genex = request.lane.agent === EvalAgent.GenexApp && result.harnessFailure === null;
    // The agent edits its game in the lane root, while the run is still live there.
    if (!genex || !(await folderInside(request.laneRoot, result.artifacts.projectDir))) return result;
    const candidate = request.appBuild?.sha === world.identity.candidateSha;
    await writeStandIn(world.repo, result.artifacts.projectDir, candidate && request.evalCase.id !== CANARY_CASE_ID);
    return result;
  };
}

/** The fixture graders: the default families, pinned to the fixture model. */
const FIXTURE_GRADERS = defaultGraderPins(CHECKLIST_PROMPT_SHA).map((pin) => ({ ...pin, model: FIXTURE_GRADER_MODEL }));

/**
 * The fixture grader: it reads the rendered prompt as a model would read the evidence. Yes to an
 * item only when frames were attached and the console shows no seeded break; no to a control item;
 * a tie on every pairwise facet.
 */
function fixtureGrader(controls: readonly string[]): GraderComplete {
  return async (pin, prompt) => {
    const reply = (text: string) => ({ text, model: pin.model, usage: ZERO_TOKEN_USAGE });
    if (prompt.text.includes(PAIRWISE_MARK)) return reply(PAIRWISE_TIE);
    const frames = Number(/The (\d+) attached images/.exec(prompt.text)?.[1] ?? 0);
    const control = controls.some((text) => prompt.text.includes(text));
    const yes = frames > 0 && !control && !prompt.text.includes(SEEDED_BREAK_TEXT);
    return reply(yes ? "VERDICT: YES\nWHY: the frames show it." : "VERDICT: NO\nWHY: the evidence does not show it.");
  };
}

/** A calibration covering exactly the fixture graders' pins (they are not models; nothing to calibrate). */
function fixtureCalibration(proberVersion: string): CalibrationResult {
  return {
    proberVersion,
    graderPromptSha: CHECKLIST_PROMPT_SHA,
    graderModels: FIXTURE_GRADERS.map((pin) => pin.model),
    checks: [],
    ok: true,
    recordedAt: new Date().toISOString(),
    quick: false,
  };
}

// ── wiring ──────────────────────────────────────────────────────────────────────────────

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-C", repo, ...args])).stdout.trim();
}

/** The base is the checkout's HEAD; the candidate is a synthetic id for its seeded variant of the same build. */
async function identityOf(repo: string): Promise<Identity> {
  const baseSha = await git(repo, "rev-parse", "HEAD");
  const candidateSha = createHash("sha1").update(`${baseSha}\0${SEEDED_BREAK}`).digest("hex");
  const dirty = (await git(repo, "status", "--porcelain")).length > 0;
  return { baseSha, candidateSha, dirty };
}

/** Every handler the pipeline calls, bound to the disposable home, the fixture lanes and the fixture graders. */
async function bindHandlers(options: EvalFixtureOptions, identity: Identity, mode: ProbeMode) {
  const { repo, home } = options;
  const paths = evalsPaths(home);
  const layout = evalsLayout(home);
  const cases = readCases(repo);
  const registry = readLaneRegistry(repo);
  const probe = probers(mode, paths);
  const refs: Record<string, string> = { [APP_REF.Base]: identity.baseSha, [APP_REF.Candidate]: identity.candidateSha };
  const planDeps: PlanCommandDeps = {
    paths,
    cases: () => cases,
    registry: () => registry,
    resolveSha: async (ref) => {
      const sha = refs[ref];
      if (!sha) throw new Error(`the fixture pipeline names only ${Object.keys(refs).join(", ")}`);
      return sha;
    },
    now: () => Date.now(),
    randomSeed: () => SEED,
  };
  const vendorDir = path.join(repo, APP_VENDOR_DIR);
  const npmCacheDir = path.join(paths.work, "npm-cache");
  const runDeps: CampaignRunDeps = {
    paths,
    layout,
    cases,
    startDir: () => null,
    registry,
    prices: readPriceTable(repo),
    clock: SYSTEM_BUDGET_CLOCK,
    runLane: fixtureRunner({ repo, identity, userHome: options.userHome, paths }),
    buildApp: async (sha) => ({ sha, dir: repo, dirty: identity.dirty }),
    readQuota: async () => null,
    judgeCanary: createCanaryJudge({ serve: probe.serve, probeBoot: probe.probeBoot, vendorDir, npmCacheDir }),
    appendRow: async (row) => {
      await appendLedgerRow(row, { paths });
    },
    readRows: () => readRunRows(paths),
    machine: machineFacts(identity.baseSha),
    userHome: options.userHome,
    out: options.out,
  };
  const controls = cases.flatMap((c) => c.acceptance.filter((item) => item.control).map((item) => item.text));
  const grading: GradingCommandContext = {
    root: repo,
    deps: {
      paths,
      cases,
      graders: FIXTURE_GRADERS,
      votesPerFamily: DEFAULT_VOTES_PER_FAMILY,
      proberVersion: probe.proberVersion,
      rendererMode: RendererMode.Gpu,
      vendorDir,
      // Both app refs are this checkout's own build (`buildApp` above), so its vendor serves both.
      appVendorDir: async () => vendorDir,
      npmCacheDir,
      serve: probe.serve,
      quick: true,
      quickProbe: probe.quickProbe,
      fullProbe: probe.fullProbe,
      complete: fixtureGrader(controls),
      rubric: await readPairwiseRubric(),
      withLock: probe.withLock,
      quotaGate: async () => null,
      latestCalibration: async () => fixtureCalibration(probe.proberVersion),
      now: () => new Date(),
    },
  };
  const cli: CliContext = {
    paths,
    root: repo,
    lanes: layout.lanes,
    cases: () => cases,
    registry: () => registry,
    now: () => new Date(),
    formatJson: biomeFormatter(repo),
  };
  const handlers: Partial<Record<EvalCommand, CliRun>> = {
    [EvalCommand.CampaignPlan]: (args, out) => campaignPlanCommand(args, out, planDeps),
    [EvalCommand.CampaignRun]: (args, out) => campaignRunCommand(args, out, runDeps),
    [EvalCommand.Grade]: (args, out) => gradeCommand(args, out, grading),
    [EvalCommand.Report]: (args, out) => reportCommand(args, out, cli),
    [EvalCommand.Check]: (args, out) => checkCommand(args, out, cli),
    [EvalCommand.ValidateLedger]: (args, out) => validateLedgerCommand(args, out, cli),
  };
  return { paths, handlers };
}

/**
 * The environment the CLI's live gate reads. The gate keeps provider quota and outgoing data out of
 * CI; a fixture campaign spends and sends none, so a CI dispatch of this runner hands it no CI marker.
 */
function gateEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of CI_VARIABLES) delete env[name];
  return env;
}

/** Run one command line through the CLI registry and record it; a step whose exit is unexpected is a failure. */
async function cli(world: World, args: string[], expected: readonly number[]): Promise<StepRecord> {
  const output: string[] = [];
  const started = Date.now();
  world.options.out(`$ eval ${args.join(" ")}`);
  const exit = await main(args, (line) => output.push(...line.split("\n")), {
    env: gateEnv(),
    handlers: world.handlers,
  });
  const step = { command: args.join(" "), exit, expected, ms: Date.now() - started, output };
  world.steps.push(step);
  world.options.out(`  exit ${exit} in ${Math.round(step.ms / 1000)}s`);
  expect(world, expected.includes(exit), `${step.command} exited ${exit}, expected ${expected.join(" or ")}`);
  return step;
}

function expect(world: World, holds: boolean, what: string): void {
  if (holds) return;
  world.failures.push(what);
  world.options.out(`  ✖ ${what}`);
}

/** The campaign a `campaign plan` step wrote (`wrote <dir>/campaign.json`). */
function plannedCampaign(step: StepRecord): string | null {
  const file = step.output.findLast((line) => line.startsWith("wrote "))?.slice("wrote ".length);
  return file ? path.basename(path.dirname(file)) : null;
}

async function campaignRows(paths: EvalsPaths, campaignId: string): Promise<RunRow[]> {
  return currentRows(await readRunRows(paths)).filter((row) => row.campaignId === campaignId);
}

// ── the checks ──────────────────────────────────────────────────────────────────────────

/** Every build ran clean, every canary booted, raw streams kept their timing and Genex reports are the fixture's. */
async function checkCollected(world: World, campaignId: string, lanes: readonly string[], builds: number) {
  const rows = await campaignRows(world.paths, campaignId);
  const buildRows = rows.filter((row) => row.kind === RowKind.Build);
  expect(world, buildRows.length === builds, `${campaignId}: ${buildRows.length} build rows, expected ${builds}`);
  for (const lane of lanes)
    expect(
      world,
      buildRows.some((row) => row.lane.id === lane),
      `${campaignId}: no build row for ${lane}`,
    );
  for (const row of buildRows) {
    expect(world, row.outcome.harnessFailure === null, `${row.runId}: harness failure ${row.outcome.harnessFailure}`);
    expect(world, row.outcome.noBuild === null, `${row.runId}: no build (${row.outcome.noBuild})`);
    if (row.lane.agent === EvalAgent.GenexApp) await checkGenexRun(world, row);
    else await checkStubRun(world, row);
  }
  for (const row of rows.filter((candidate) => candidate.kind === RowKind.Canary))
    expect(world, canaryPassed(row), `${row.runId}: the canary did not boot`);
}

async function checkGenexRun(world: World, row: RunRow): Promise<void> {
  const report = await readLaneReport(path.join(world.paths.work, row.runId, "lane-report.json"));
  expect(world, report?.fixture === true, `${row.runId}: no fixture lane report from the app`);
  expect(world, report?.harnessDigest.matches === true, `${row.runId}: the harness differs from the shipped seed`);
}

async function checkStubRun(world: World, row: RunRow): Promise<void> {
  const engine = row.lane.engine === EngineId.Codex ? EngineId.Codex : EngineId.ClaudeCode;
  const stub = await fixtureStubResolver(world.options.repo)(engine);
  expect(world, row.pins.run.cliVersion === stub.version, `${row.runId}: CLI version ${row.pins.run.cliVersion}`);
  const text = await readFile(path.join(world.paths.work, row.runId, "stream.jsonl"), "utf8").catch(() => "");
  const times = readStreamRecords(text).map((record) => record.receivedAt);
  const ordered = times.every((at, index) => index === 0 || at >= (times[index - 1] ?? at));
  const span = (times.at(-1) ?? 0) - (times[0] ?? 0);
  expect(
    world,
    ordered && span >= MIN_REPLAY_SPAN_MS,
    `${row.runId}: replay not timed (${times.length} lines, ${span}ms)`,
  );
}

/** Every build of the campaign was graded with a probe and a checklist. */
async function checkGraded(world: World, campaignId: string): Promise<RunRow[]> {
  const builds = (await campaignRows(world.paths, campaignId)).filter((row) => row.kind === RowKind.Build);
  for (const row of builds) {
    expect(world, row.probe !== null, `${row.runId}: not probed`);
    expect(world, row.checklist !== null, `${row.runId}: no checklist`);
  }
  return builds;
}

/** The ledger validates through the CLI and every row, run or pairwise, passes the guard. */
async function checkLedger(world: World): Promise<void> {
  await cli(world, [EvalCommand.ValidateLedger], [0]);
  const rows = [...(await readRunRows(world.paths)), ...(await readPairwiseRows(world.paths))];
  let refused = 0;
  for (const row of rows) {
    try {
      guardRow(row);
    } catch {
      refused += 1;
    }
  }
  expect(world, rows.length > 0 && refused === 0, `ledger guard refused ${refused} of ${rows.length} rows`);
}

// ── the two campaigns ───────────────────────────────────────────────────────────────────

/** Plan, run, grade and report every fixture lane once on the base build. */
async function pipelineCampaign(world: World): Promise<string | null> {
  const planned = await cli(
    world,
    [...EvalCommand.CampaignPlan.split(" "), "--lanes", FIXTURE_LANES, "--cases", CASE_ID, "--reps", "1"].concat([
      "--apps",
      APP_REF.Base,
      "--seed",
      SEED,
      "--label",
      "fixture-pipeline",
    ]),
    [0],
  );
  const id = plannedCampaign(planned);
  if (!id) return null;
  const fixtureLanes = readLaneRegistry(world.options.repo)
    .lanes.filter((lane) => lane.fixture)
    .map((l) => l.id);
  await cli(world, [...EvalCommand.CampaignRun.split(" "), id, "--live"], [0]);
  await checkCollected(world, id, fixtureLanes, fixtureLanes.length);
  const graded = await cli(world, [EvalCommand.Grade, id, "--quick", "--live"], [0]);
  const builds = await checkGraded(world, id);
  for (const row of builds) expect(world, bootOutcome(row) === 1, `${row.runId}: the recorded game did not boot`);
  const pairwise = Number(graded.output.find((line) => line.startsWith("pairwise "))?.split(" ")[1] ?? 0);
  expect(world, pairwise > 0, "no pairwise rows were judged");
  const report = await cli(world, [EvalCommand.Report, id], [0, 1]);
  for (const lane of fixtureLanes)
    expect(
      world,
      report.output.some((line) => line.includes(lane)),
      `the scorecard does not name ${lane}`,
    );
  await cli(world, [EvalCommand.Report, id, "--html"], [0, 1]);
  await checkLedger(world);
  return id;
}

/** The version axis: base against the candidate's seeded boot break on one Genex lane, then `check`. */
async function versionCampaign(world: World): Promise<string | null> {
  const planned = await cli(
    world,
    [...EvalCommand.CampaignPlan.split(" "), "--lanes", VERSION_LANE, "--cases", CASE_ID]
      .concat(["--reps", String(VERSION_REPS), "--apps", `${APP_REF.Base},${APP_REF.Candidate}`])
      .concat(["--seed", SEED, "--label", "fixture-version"]),
    [0],
  );
  const id = plannedCampaign(planned);
  if (!id) return null;
  await cli(world, [...EvalCommand.CampaignRun.split(" "), id, "--live"], [0]);
  await checkCollected(world, id, [VERSION_LANE], 2 * VERSION_REPS);
  await cli(world, [EvalCommand.Grade, id, "--quick", "--live"], [0]);
  const builds = await checkGraded(world, id);
  const bootsOf = (sha: string) => builds.filter((row) => row.pins.run.appSha === sha).map(bootOutcome);
  const base = bootsOf(world.identity.baseSha);
  const candidate = bootsOf(world.identity.candidateSha);
  expect(world, base.length === VERSION_REPS && base.every((boot) => boot === 1), `base boots ${base.join(",")}`);
  expect(
    world,
    candidate.length === VERSION_REPS && candidate.every((boot) => boot === 0),
    `candidate boots ${candidate.join(",")}`,
  );
  const failing = [CHECK_EXIT_CODE[CheckState.Regression], CHECK_EXIT_CODE[CheckState.Probable]];
  const checked = await cli(world, [EvalCommand.Check, id], failing);
  const cell = `${CASE_ID} × ${VERSION_LANE}: `;
  const named = checked.output.some(
    (line) => line.startsWith(`${cell}${CheckState.Regression}`) || line.startsWith(`${cell}${CheckState.Probable}`),
  );
  expect(world, named, `check did not name the cell ${cell.trim()} as a regression`);
  await checkLedger(world);
  return id;
}

// ── evidence ────────────────────────────────────────────────────────────────────────────

/** Copy the ledger, the campaign plans, the HTML reports and each run's lane report or stream into the evidence folder. */
async function keepEvidence(world: World, report: EvalFixtureReport): Promise<void> {
  const dir = world.options.evidenceDir;
  await mkdir(dir, { recursive: true });
  const copyInto = async (from: string, to: string) => {
    if (!(await stat(from).catch(() => null))?.isFile()) return;
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  };
  for (const name of ["runs.jsonl", "pairwise.jsonl"])
    await copyInto(path.join(world.paths.ledger, name), path.join(dir, "ledger", name));
  const reports = path.join(world.paths.home, "reports");
  for (const name of await readdir(reports).catch(() => [] as string[]))
    await copyInto(path.join(reports, name), path.join(dir, "reports", name));
  for (const id of Object.values(report.campaigns).filter((value): value is string => value !== null))
    await copyInto(path.join(world.paths.campaigns, id, "campaign.json"), path.join(dir, "campaigns", `${id}.json`));
  for (const runId of await readdir(world.paths.work).catch(() => [] as string[]))
    for (const name of ["lane-report.json", "stream.jsonl", "stderr.log"])
      await copyInto(path.join(world.paths.work, runId, name), path.join(dir, "runs", runId, name));
  const log = report.steps.flatMap((step) => [`$ eval ${step.command}  (exit ${step.exit})`, ...step.output, ""]);
  await writeFile(path.join(dir, "commands.log"), `${log.join("\n")}\n`);
  await writeFile(path.join(dir, "summary.json"), `${JSON.stringify({ ...report, steps: undefined }, null, 2)}\n`);
}

/** Run the fixture pipeline end to end; never throws for an unmet expectation, only reports it. */
export async function runEvalFixturePipeline(options: EvalFixtureOptions): Promise<EvalFixtureReport> {
  const missing = options.scriptedProbe ? "scripted probe requested" : await chromiumMissing();
  const mode = missing === null ? ProbeMode.Chromium : ProbeMode.Scripted;
  options.out(`probe: ${mode}${missing ? ` (${missing})` : ""}`);
  const identity = await identityOf(options.repo);
  const { paths, handlers } = await bindHandlers(options, identity, mode);
  const world: World = { options, paths, identity, handlers, steps: [], failures: [] };
  const report: EvalFixtureReport = {
    ok: false,
    probe: { mode, reason: missing },
    campaigns: { pipeline: null, version: null },
    steps: world.steps,
    failures: world.failures,
    evidenceDir: options.evidenceDir,
    home: options.home,
  };
  try {
    report.campaigns.pipeline = await pipelineCampaign(world);
    report.campaigns.version = await versionCampaign(world);
  } catch (error) {
    world.failures.push(
      `the pipeline threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
  report.ok = world.failures.length === 0 && report.campaigns.version !== null;
  await keepEvidence(world, report);
  return report;
}

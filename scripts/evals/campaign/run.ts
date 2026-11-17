/**
 * `campaign run` (§4, §8.1, §10.5, §10.6, Rules 20, 21, 24): the scheduler. A dry run (the default)
 * prints what would run and touches nothing; `--live` runs it.
 *
 * - Each app SHA a Genex lane needs is built once, in its eval-owned folder.
 * - Each provider stream runs one run at a time; the Claude and Codex streams overlap unless
 *   `--serial`, and each row records the lane that ran beside it (`coRunLane`).
 * - All opening canaries run first. Each is judged at once (boot-only, stop-time snapshot); a
 *   failure is retried once, and a second consecutive failure aborts the campaign before any case.
 *   A failing closing canary voids the campaign.
 * - A run whose guards tripped (`harnessFailure`) is written with `supersededBy` naming a new rep
 *   that replaces it, at most two per cell; agent outcomes (deadline, crash, …) count as they are.
 * - A provider failure (signed out, quota exhausted, rate limited, CLI missing) is the account's,
 *   not the run's: nothing is written for that run, no replacement or canary verdict is spent, and
 *   the campaign stops cleanly (`provider-unavailable`), to resume after the account is back.
 * - The budget's hours and runs, and the quota ceiling (sleeping until a reset inside the budget),
 *   are checked before every run (never for a fixture lane, which touches no account); a stop is
 *   clean and the campaign resumes where it stopped.
 * - A CLI version change between runs voids the campaign (`cli-changed`).
 * - Resuming skips every runId that has a row; a run that started and never wrote one is rerun in
 *   a fresh work folder, the old one set aside, never deleted.
 *
 * Voiding appends a later `gradeSeq` of every row with the reason, so the append-only ledger's
 * `currentRows()` reads the campaign as void.
 */
import { readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS } from "../../../src/shared/duration.ts";
import { EngineId } from "../../../src/shared/providers.ts";
import {
  type Budget,
  type BudgetCaps,
  type BudgetClock,
  BudgetStop,
  budgetStop,
  countRun,
  guardQuota,
  type QuotaReader,
  startBudget,
} from "../budget.ts";
import type { EvalCase } from "../case-types.ts";
import type { SnapshotFacts } from "../collect/observation.ts";
import type { CodingProvider } from "../../../src/shared/coding-cli.ts";
import {
  ANSWER_POLICY,
  checkWorkspaceAncestors,
  createLaneRoot,
  instructionSuffix,
  LANE_PID_FILE,
  readLanePid,
  settledPath,
  settleLaneRoot,
  SYSTEM_GROUP,
  MAX_ANSWERS,
  PROJECT_DIR,
  RAIL_GRACE_MS,
  rawDeliverable,
  WorkspaceRefusedError,
} from "../lanes/common.ts";
import { genexPaths, readLaneReport } from "../lanes/genex-app.ts";
import { type EvalsLayout, runWorkRoot } from "../lanes/homes.ts";
import { laneById } from "../lanes/registry.ts";
import type { AppBuild, LaneRegistry, LaneRegistryRow, LaneRunRequest, LaneRunResult } from "../lanes/types.ts";
import { sha256File } from "../ledger/hash.ts";
import { type EvalsPaths, evidenceDir, insideGitWorktree } from "../ledger/paths.ts";
import { currentRows } from "../ledger/read.ts";
import type { RunRow } from "../ledger/types.ts";
import type { PriceTable } from "../prices.ts";
import {
  AccountExclusive,
  CampaignVoidReason,
  CaseVisibility,
  Concurrency,
  EvalAgent,
  isProviderFailure,
  RowKind,
} from "../vocabulary.ts";
import { APP_VENDOR_DIR, type CanaryJudge, type CanaryVerdict, canaryPassed, canaryProbeBlock } from "./canary.ts";
import { collectRun, keptEvidenceDigest, snapshotValidation } from "./collect.ts";
import { plannedRunId } from "./plan.ts";
import { assembleRunRow, harnessFailureOf, type MachineFacts, voidedRow, withCampaignVoid } from "./row.ts";
import { type CampaignPlan, CanaryBracket, type PlannedApp, type PlannedRun, type ProviderStream } from "./types.ts";
import { type GameLocation, SNAPSHOTS_DIR, watchGame } from "./watch.ts";
import { snapshotFacts } from "../watch/snapshots.ts";
import type { CloneTree, Every } from "../watch/snapshots.ts";

/** Replacement reps one cell may take for harness failures (§10.5). */
export const MAX_REPLACEMENTS_PER_CELL = 2;
/** The run id's rep suffix. */
const REP_SUFFIX = /-r(\d+)$/;

/** How a campaign run ended. */
export const CampaignOutcome = {
  Completed: "completed",
  DryRun: "dry-run",
  /** The budget or the quota said stop; the campaign resumes where it stopped. */
  Stopped: "stopped",
  /** The opening canary failed twice: nothing but canaries ran. */
  Aborted: "aborted",
  Void: "void",
  Refused: "refused",
} as const;
export type CampaignOutcome = (typeof CampaignOutcome)[keyof typeof CampaignOutcome];

/** Why a campaign stopped cleanly: the budget's reasons, or a provider account that went down mid-campaign. */
export const CampaignStop = {
  ...BudgetStop,
  /** A run failed with a provider failure (`isProviderFailure`): signed out, quota, rate limit or no CLI. */
  ProviderUnavailable: "provider-unavailable",
} as const;
export type CampaignStop = (typeof CampaignStop)[keyof typeof CampaignStop];

/** Why a run was refused before anything ran. */
export const CampaignRunRefusal = {
  /** A case's frozen version moved since the plan. */
  CaseMoved: "case-moved",
  /** A lane's flags digest moved since the plan, or the lane is gone. */
  LaneMoved: "lane-moved",
  /** The campaign is already void; a void campaign never resumes. */
  AlreadyVoid: "already-void",
  /** A holdout case's rows would be written inside a Git working tree, which the ledger refuses. */
  HoldoutInWorktree: "holdout-in-worktree",
} as const;
export type CampaignRunRefusal = (typeof CampaignRunRefusal)[keyof typeof CampaignRunRefusal];

/** Runs one lane: the raw CLI runner or the Genex app runner, or a fake in tests. */
export type LaneRunner = (request: LaneRunRequest) => Promise<LaneRunResult>;

/** The watcher's timers and clone, injectable. */
export interface WatchDeps {
  every?: Every;
  clone?: CloneTree;
  intervalMs?: number;
  seedPollMs?: number;
}

/** What a campaign run needs; every part is injectable, so a whole campaign runs hermetically under test. */
export interface CampaignRunDeps {
  paths: EvalsPaths;
  layout: EvalsLayout;
  cases: readonly EvalCase[];
  /** The real folder an edit case starts from; null for a case built from nothing. */
  startDir: (evalCase: EvalCase) => string | null;
  registry: LaneRegistry;
  prices: PriceTable;
  clock: BudgetClock;
  runLane: LaneRunner;
  buildApp: (sha: string) => Promise<AppBuild>;
  readQuota: QuotaReader;
  judgeCanary: CanaryJudge;
  appendRow: (row: RunRow) => Promise<void>;
  readRows: () => Promise<RunRow[]>;
  machine: MachineFacts;
  /** The user's home, for the workspace ancestor guard. */
  userHome: string;
  /** Whether a process group still runs; the machine's by default. Asked of an interrupted run's lane before it reruns. */
  groupAlive?: (pid: number) => boolean;
  watch?: WatchDeps;
  out: (line: string) => void;
}

/** The operator's choices for this invocation. */
export interface CampaignRunOptions {
  live: boolean;
  caps: BudgetCaps;
  accountExclusive: boolean;
  serial: boolean;
}

/** What a campaign run did. */
export interface CampaignRunReport {
  campaignId: string;
  outcome: CampaignOutcome;
  stop: CampaignStop | null;
  voidReason: CampaignVoidReason | null;
  refusal: CampaignRunRefusal | null;
  /** Run ids started by this invocation, in start order. */
  ran: string[];
  /** Run ids still to run (a dry run lists them all). */
  pending: string[];
}

/** Why this invocation stopped early. */
interface Halt {
  outcome: CampaignOutcome;
  stop: CampaignStop | null;
  voidReason: CampaignVoidReason | null;
}

/** One invocation's state. */
interface Session {
  plan: CampaignPlan;
  options: CampaignRunOptions;
  deps: CampaignRunDeps;
  stamp: string;
  rows: Map<string, RunRow>;
  resumed: boolean;
  builds: Map<string, AppBuild>;
  budget: Budget;
  halt: Halt | null;
  active: Map<EngineId, { laneId: string; coRun: string | null }>;
  cliVersions: Map<EngineId, string>;
  maxRep: Map<string, number>;
  ran: string[];
  /** Every ledger write, one after another, so a void never misses a row another stream is writing. */
  writes: Promise<unknown>;
}

const cellKey = (laneId: string, caseId: string, app: PlannedApp | null) => `${laneId}\0${caseId}\0${app?.role ?? ""}`;
const repOf = (runId: string) => Number(REP_SUFFIX.exec(runId)?.[1] ?? 0);

/** The plan's app for a row's appSha, or null (raw lanes). */
function appOfRow(plan: CampaignPlan, row: RunRow): PlannedApp | null {
  const sha = row.pins.run.appSha;
  return plan.apps.find((app) => app.sha === sha) ?? null;
}

/** Refuse a plan whose cases or lanes moved under it, or whose holdouts would land in a Git working tree (§6.3). */
async function planRefusal(plan: CampaignPlan, deps: CampaignRunDeps): Promise<CampaignRunRefusal | null> {
  const holdouts = plan.cases.some((planned) => planned.visibility === CaseVisibility.Holdout);
  if (holdouts && (await insideGitWorktree(deps.paths.ledgerFiles.runs))) return CampaignRunRefusal.HoldoutInWorktree;
  for (const planned of plan.cases) {
    const current = deps.cases.find((c) => c.id === planned.id);
    if (current?.version !== planned.version) return CampaignRunRefusal.CaseMoved;
  }
  for (const planned of plan.lanes) {
    if (laneById(deps.registry, planned.id)?.flagsDigest !== planned.flagsDigest) return CampaignRunRefusal.LaneMoved;
  }
  return null;
}

/** The replacement a failed row names that has not run yet. */
function pendingReplacement(session: Session, row: RunRow): PlannedRun | null {
  const next = row.supersededBy;
  if (!next || session.rows.has(next) || row.kind !== RowKind.Build) return null;
  return {
    runId: next,
    kind: RowKind.Build,
    laneId: row.lane.id,
    caseId: row.case.id,
    rep: repOf(next),
    app: appOfRow(session.plan, row),
    bracket: null,
  };
}

/** A stream's builds still to run: planned ones without a row, then replacements owed. */
function buildQueue(session: Session, stream: ProviderStream): PlannedRun[] {
  const planned = stream.builds.filter((run) => !session.rows.has(run.runId));
  const lanes = new Set(stream.builds.map((run) => run.laneId));
  const owed = [...session.rows.values()]
    .filter((row) => lanes.has(row.lane.id))
    .flatMap((row) => pendingReplacement(session, row) ?? []);
  return [...planned, ...owed];
}

/** Every run still to run, for a dry run's listing. */
function pendingRuns(session: Session): PlannedRun[] {
  return session.plan.streams.flatMap((stream) => {
    const openings = openingGroups(stream).flatMap((group) => {
      if (group.some((run) => canaryPassed(session.rows.get(run.runId)))) return [];
      return group.filter((run) => !session.rows.has(run.runId)).slice(0, 1);
    });
    const closing = stream.closing.filter((run) => !session.rows.has(run.runId));
    return [...openings, ...buildQueue(session, stream), ...closing];
  });
}

/** A stream's opening canaries grouped per (lane, app): the first try, then its retry. */
function openingGroups(stream: ProviderStream): PlannedRun[][] {
  const groups = new Map<string, PlannedRun[]>();
  for (const run of stream.opening) {
    const key = cellKey(run.laneId, run.caseId, run.app);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()].map((group) =>
    group.sort(
      (a, b) => Number(a.bracket === CanaryBracket.OpeningRetry) - Number(b.bracket === CanaryBracket.OpeningRetry),
    ),
  );
}

function newSession(plan: CampaignPlan, options: CampaignRunOptions, deps: CampaignRunDeps, rows: RunRow[]): Session {
  const current = currentRows(rows.filter((row) => row.campaignId === plan.campaignId));
  const session: Session = {
    plan,
    options,
    deps,
    stamp: plan.campaignId.slice(0, plan.campaignId.indexOf("-")),
    rows: new Map(current.map((row) => [row.runId, row])),
    resumed: current.length > 0,
    builds: new Map(),
    budget: startBudget(options.caps, deps.clock.now()),
    halt: null,
    active: new Map(),
    cliVersions: new Map(),
    maxRep: new Map(),
    ran: [],
    writes: Promise.resolve(),
  };
  for (const stream of plan.streams)
    for (const run of stream.builds) bumpRep(session, cellKey(run.laneId, run.caseId, run.app), run.rep);
  for (const row of current) {
    bumpRep(session, cellKey(row.lane.id, row.case.id, appOfRow(plan, row)), repOf(row.runId));
    if (row.supersededBy)
      bumpRep(session, cellKey(row.lane.id, row.case.id, appOfRow(plan, row)), repOf(row.supersededBy));
    const version = row.pins.run.cliVersion;
    if (typeof version === "string" && !session.cliVersions.has(row.lane.engine))
      session.cliVersions.set(row.lane.engine, version);
  }
  return session;
}

function bumpRep(session: Session, key: string, rep: number): void {
  session.maxRep.set(key, Math.max(session.maxRep.get(key) ?? 0, rep));
}

// ── one run ──────────────────────────────────────────────────────────────────────────────

/** An interrupted run's lane is still running: rerunning it would put two live runs on one account (Rule 21). */
export class AbandonedRunLiveError extends Error {
  readonly runId: string;
  readonly pid: number;
  constructor(runId: string, pid: number, pidFile: string) {
    super(
      `refused abandoned-run-live ${runId}: its lane's process group ${pid} still runs; stop it (kill -TERM -${pid}) or remove ${pidFile} if that is another process, then run again`,
    );
    this.name = "AbandonedRunLiveError";
    this.runId = runId;
    this.pid = pid;
  }
}

/**
 * Set aside a work folder a run left without writing its row (an interrupted invocation); never
 * delete it. A folder whose lane group still runs is refused (`AbandonedRunLiveError`) and left as it is.
 */
async function setAsideAbandoned(session: Session, runId: string, workRoot: string): Promise<void> {
  const present = await stat(workRoot).catch(() => null);
  if (!present) return;
  const pidFile = path.join(workRoot, LANE_PID_FILE);
  const pid = readLanePid(await readFile(pidFile, "utf8").catch(() => ""));
  const alive = session.deps.groupAlive ?? SYSTEM_GROUP.alive;
  if (pid !== null && alive(pid)) throw new AbandonedRunLiveError(runId, pid, pidFile);
  await rename(workRoot, `${workRoot}.abandoned-${session.deps.clock.now()}`);
}

function laneAndCase(
  session: Session,
  planned: PlannedRun,
): { lane: LaneRegistryRow; evalCase: EvalCase; deadlineMin: number } {
  const lane = laneById(session.deps.registry, planned.laneId);
  const evalCase = session.deps.cases.find((c) => c.id === planned.caseId);
  const frozen = session.plan.cases.find((c) => c.id === planned.caseId);
  if (!lane || !evalCase || !frozen) throw new Error(`run ${planned.runId} names a lane or case the plan lost`);
  return { lane, evalCase, deadlineMin: frozen.deadlineMin };
}

/** The lane request for one planned run. */
function laneRequest(
  session: Session,
  planned: PlannedRun,
  roots: { workRoot: string; laneRoot: string },
  coRunLane: string | null,
): LaneRunRequest {
  const { workRoot, laneRoot } = roots;
  const { lane, evalCase, deadlineMin } = laneAndCase(session, planned);
  return {
    runId: planned.runId,
    campaignId: session.plan.campaignId,
    lane,
    evalCase,
    rep: planned.rep,
    workRoot,
    laneRoot,
    homes: session.deps.layout.homes,
    appBuild: planned.app ? (session.builds.get(planned.app.sha) ?? null) : null,
    deadlineMs: deadlineMin * MINUTE_MS,
    graceMs: RAIL_GRACE_MS,
    suffix: instructionSuffix(deadlineMin),
    deliverable: lane.agent === EvalAgent.GenexApp ? null : rawDeliverable(lane.browser),
    answerPolicy: ANSWER_POLICY,
    maxAnswers: MAX_ANSWERS,
    live: true,
    interleaveSeed: session.plan.seed,
    coRunLane,
    templateDigest: null,
    startDir: session.deps.startDir(evalCase),
  };
}

/** Where a run's game is while it runs: the raw project folder, or the Genex games folder to find it in. */
function gameLocation(lane: LaneRegistryRow, laneRoot: string): GameLocation {
  if (lane.agent === EvalAgent.GenexApp) return { gamesRoot: genexPaths(laneRoot).gamesRoot };
  return { gameRoot: path.join(laneRoot, PROJECT_DIR) };
}

/** Move what the agent made into the run's work root, and read the result's paths from there. */
async function settle(request: LaneRunRequest, result: LaneRunResult): Promise<LaneRunResult> {
  const { laneRoot, workRoot } = request;
  await settleLaneRoot(laneRoot, workRoot);
  const at = (file: string) => settledPath(file, laneRoot, workRoot);
  const { artifacts } = result;
  return {
    ...result,
    artifacts: {
      ...artifacts,
      projectDir: at(artifacts.projectDir),
      eventLogDir: artifacts.eventLogDir === null ? null : at(artifacts.eventLogDir),
      reportPath: artifacts.reportPath === null ? null : at(artifacts.reportPath),
      specPath: artifacts.specPath === null ? null : at(artifacts.specPath),
    },
  };
}

/** Register a run as its stream's active one, noting the other stream's lane as its co-run and vice versa. */
function enterActive(session: Session, engine: EngineId, laneId: string): { coRun: string | null } {
  const entry = { laneId, coRun: null as string | null };
  for (const [other, running] of session.active) {
    if (other === engine) continue;
    entry.coRun ??= running.laneId;
    running.coRun ??= laneId;
  }
  session.active.set(engine, entry);
  return entry;
}

/**
 * The seeded template's digest a Genex run's lane report carries (the app took it when the chat was
 * bound to its game, before any edit); null for a raw lane, whose folder is not seeded.
 */
async function seededTemplateDigest(lane: LaneRegistryRow, result: LaneRunResult): Promise<string | null> {
  const reportPath = result.artifacts.reportPath;
  if (lane.agent !== EvalAgent.GenexApp || reportPath === null) return null;
  return (await readLaneReport(reportPath))?.templateDigest ?? null;
}

/** Launch the lane under the snapshot watcher; answers the result and the stop-time snapshot's facts. */
async function launch(
  session: Session,
  request: LaneRunRequest,
): Promise<{ result: LaneRunResult; snapshot: SnapshotFacts | null; finalDir: string | null }> {
  const { deps } = session;
  const watch = watchGame({
    location: gameLocation(request.lane, request.laneRoot),
    snapshotDir: path.join(request.workRoot, SNAPSHOTS_DIR),
    startedAtMs: deps.clock.now(),
    now: () => deps.clock.now(),
    ...deps.watch,
  });
  let ran: LaneRunResult;
  try {
    ran = await deps.runLane(request);
  } catch (error) {
    await watch.stop(null).catch(() => null);
    throw error;
  }
  const stopped = await watch.stop(ran.artifacts.projectDir);
  const result = await settle(request, ran);
  const templateDigest = await seededTemplateDigest(request.lane, result);
  const snapshot = stopped.finalDir ? await snapshotFacts(stopped.finalDir, { templateDigest }) : null;
  return { result, snapshot, finalDir: stopped.finalDir };
}

/** The void reason a run's CLI version gives (Rule 24): the engine's version moved inside the campaign. */
function cliChange(session: Session, engine: EngineId, version: string | null): CampaignVoidReason | null {
  if (version === null) return null;
  const known = session.cliVersions.get(engine);
  if (known === undefined) {
    session.cliVersions.set(engine, version);
    return null;
  }
  return known === version ? null : CampaignVoidReason.CliChanged;
}

/** The replacement a harness-failure build gets, when its cell has one left (§10.5). */
function replacementFor(session: Session, planned: PlannedRun): PlannedRun | null {
  if (planned.kind !== RowKind.Build) return null;
  const key = cellKey(planned.laneId, planned.caseId, planned.app);
  const used = [...session.rows.values()].filter(
    (row) => row.supersededBy !== null && cellKey(row.lane.id, row.case.id, appOfRow(session.plan, row)) === key,
  ).length;
  if (used >= MAX_REPLACEMENTS_PER_CELL) return null;
  const rep = (session.maxRep.get(key) ?? 0) + 1;
  bumpRep(session, key, rep);
  return { ...planned, rep, runId: plannedRunId(session.stamp, planned.laneId, planned.caseId, planned.app, rep) };
}

/** Judge a canary on its stop-time snapshot; builds are not judged here. */
async function judgeIfCanary(
  session: Session,
  planned: PlannedRun,
  run: {
    failure: RunRow["outcome"]["harnessFailure"];
    snapshot: SnapshotFacts | null;
    finalDir: string | null;
    appBuild: AppBuild | null;
  },
): Promise<CanaryVerdict | null> {
  if (planned.kind !== RowKind.Canary) return null;
  return session.deps.judgeCanary({
    runId: planned.runId,
    finalSnapshotDir: run.finalDir,
    noBuild: run.snapshot ? run.snapshot.noBuild : null,
    harnessFailure: run.failure,
    evidenceDir: evidenceDir(session.deps.paths, planned.runId),
    vendorDir: run.appBuild ? path.join(run.appBuild.dir, APP_VENDOR_DIR) : null,
  });
}

/** What executing one run produced. */
interface Executed {
  /** null: the provider was unavailable, so nothing was written and the run stays pending for a resume. */
  row: RunRow | null;
  replacement: PlannedRun | null;
  voidReason: CampaignVoidReason | null;
  /** The run failed with a provider failure (`isProviderFailure`): the campaign stops cleanly. */
  providerDown: boolean;
}

/** What one launched run left to record. */
interface Launched {
  lane: LaneRegistryRow;
  evalCase: EvalCase;
  request: LaneRunRequest;
  coRun: string | null;
  result: LaneRunResult;
  snapshot: SnapshotFacts | null;
  finalDir: string | null;
  collected: Awaited<ReturnType<typeof collectRun>>;
  failure: RunRow["outcome"]["harnessFailure"];
  voidReason: CampaignVoidReason | null;
}

/** Judge a canary, assemble the run's row and write it, naming a harness failure's replacement. */
async function recordRun(session: Session, planned: PlannedRun, run: Launched): Promise<Executed> {
  const { deps } = session;
  const { request, result, snapshot, finalDir, collected, failure, voidReason } = run;
  const verdict = await judgeIfCanary(session, planned, { failure, snapshot, finalDir, appBuild: request.appBuild });
  const replacement = failure && !voidReason ? replacementFor(session, planned) : null;
  const probe = verdict ? canaryProbeBlock(verdict) : null;
  const streamFile = result.artifacts.streamPath;
  const row = assembleRunRow({
    schedule: {
      campaignId: session.plan.campaignId,
      kind: planned.kind,
      interleaveSeed: session.plan.seed,
      concurrency: session.options.serial ? Concurrency.Serial : Concurrency.OnePerProvider,
      coRunLane: run.coRun,
      accountExclusive: session.options.accountExclusive ? AccountExclusive.Attested : AccountExclusive.Unattested,
      replacement: planned.rep > session.plan.reps && planned.kind === RowKind.Build,
      resumed: session.resumed,
    },
    machine: deps.machine,
    lane: run.lane,
    evalCase: run.evalCase,
    instructions: { suffix: request.suffix, deliverable: request.deliverable },
    result,
    report: collected.report,
    observation: collected.observation,
    metrics: collected.metrics,
    inApp: collected.inApp,
    snapshot,
    appBuild: request.appBuild,
    canaryProbe: probe && verdict?.probe ? { probe, rendererMode: verdict.probe.rendererMode } : null,
    streamSha256: streamFile ? await sha256File(streamFile).catch(() => null) : null,
    transcriptSha256: collected.transcriptSha256,
    evidenceSha256: await keptEvidenceDigest(evidenceDir(deps.paths, planned.runId)),
    validate: await snapshotValidation(finalDir),
    supersededBy: replacement?.runId ?? null,
    campaignVoid: voidReason,
    recordedAt: new Date(deps.clock.now()).toISOString(),
  });
  const written = await writeRow(session, row);
  const failed = written.outcome.harnessFailure ? ` (${written.outcome.harnessFailure})` : "";
  deps.out(`done ${written.runId}: ${written.outcome.endedHow}${failed}`);
  return { row: written, replacement, voidReason, providerDown: false };
}

/**
 * Run one planned run end to end and write its row. A provider failure writes nothing: the work
 * folder stays (set aside on resume, never deleted), the run stays pending, and no replacement or
 * canary verdict is spent on an account that is down.
 */
async function execute(session: Session, planned: PlannedRun, engine: EngineId): Promise<Executed> {
  const { deps } = session;
  const { lane, evalCase } = laneAndCase(session, planned);
  const workRoot = runWorkRoot(deps.layout, planned.runId);
  await setAsideAbandoned(session, planned.runId, workRoot);
  const preflight = await checkWorkspaceAncestors(workRoot, deps.userHome);
  if (!preflight.ok) throw new WorkspaceRefusedError(preflight.refusal, preflight.at);
  const active = enterActive(session, engine, lane.id);
  session.ran.push(planned.runId);
  deps.out(`start ${planned.runId}`);
  try {
    const laneRoot = await createLaneRoot(deps.layout.lanes, deps.layout.root);
    const request = laneRequest(session, planned, { workRoot, laneRoot }, active.coRun);
    const { result, snapshot, finalDir } = await launch(session, request);
    const collected = await collectRun({ lane, result, snapshot, prices: deps.prices });
    const failure = harnessFailureOf(result, collected.metrics);
    const voidReason = cliChange(session, lane.engine, result.cliVersion);
    if (!voidReason && isProviderFailure(failure)) {
      deps.out(`stopped ${planned.runId}: ${failure}; no row written, it runs again on resume`);
      return { row: null, replacement: null, voidReason: null, providerDown: true };
    }
    const launched = { lane, evalCase, request, coRun: active.coRun, result, snapshot, finalDir, collected };
    return await recordRun(session, planned, { ...launched, failure, voidReason });
  } finally {
    session.active.delete(engine);
  }
}

// ── the ledger ───────────────────────────────────────────────────────────────────────────

/** Run a ledger step after every step queued before it. */
function serially<T>(session: Session, step: () => Promise<T>): Promise<T> {
  const next = session.writes.then(step);
  session.writes = next.catch(() => {});
  return next;
}

/** Append a run's row; when the campaign was voided meanwhile, the row carries the reason itself. */
function writeRow(session: Session, row: RunRow): Promise<RunRow> {
  return serially(session, async () => {
    const reason = session.halt?.voidReason ?? null;
    const final = reason && !row.campaignVoid ? withCampaignVoid(row, reason) : row;
    await session.deps.appendRow(final);
    session.rows.set(final.runId, final);
    return final;
  });
}

// ── the phases ───────────────────────────────────────────────────────────────────────────

/** Stop this invocation; a void or an abort also voids every row already written. */
async function halt(session: Session, next: Halt): Promise<void> {
  if (session.halt) return;
  session.halt = next;
  const reason = next.voidReason;
  if (!reason) return;
  await serially(session, async () => {
    const recordedAt = new Date(session.deps.clock.now()).toISOString();
    for (const row of [...session.rows.values()]) {
      if (row.campaignVoid) continue;
      const voided = voidedRow(row, reason, recordedAt);
      await session.deps.appendRow(voided);
      session.rows.set(voided.runId, voided);
    }
  });
}

/** The provider account a stream draws on; quota is read per coding CLI. */
function codingProvider(engine: EngineId): CodingProvider {
  return engine === EngineId.Codex ? EngineId.Codex : EngineId.ClaudeCode;
}

/** Every planned run on a fixture lane reads no quota: its stubs or scripted engines touch no account. */
const NO_QUOTA: QuotaReader = async () => null;

/**
 * Whether another run may start: the budget's hours and runs, then the quota ceiling for this
 * provider. A fixture lane's run never reads quota, so a fixture campaign starts no provider CLI.
 */
async function mayStart(session: Session, planned: PlannedRun, engine: EngineId): Promise<boolean> {
  if (session.halt) return false;
  const stop = budgetStop(session.budget, session.deps.clock.now());
  if (stop) {
    await halt(session, { outcome: CampaignOutcome.Stopped, stop, voidReason: null });
    return false;
  }
  const guard = await guardQuota({
    engine: codingProvider(engine),
    budget: session.budget,
    read: laneAndCase(session, planned).lane.fixture ? NO_QUOTA : session.deps.readQuota,
    clock: session.deps.clock,
  });
  if (!guard.proceed) {
    await halt(session, { outcome: CampaignOutcome.Stopped, stop: guard.stop, voidReason: null });
    return false;
  }
  if (session.halt) return false;
  session.budget = countRun(session.budget);
  return true;
}

/**
 * Run one planned run when the budget allows; null when the invocation stopped first. A provider
 * failure stops the invocation cleanly (never a void), so a later `campaign run` resumes it.
 */
async function runOne(session: Session, planned: PlannedRun, engine: EngineId): Promise<Executed | null> {
  if (!(await mayStart(session, planned, engine))) return null;
  const executed = await execute(session, planned, engine);
  if (executed.voidReason)
    await halt(session, { outcome: CampaignOutcome.Void, stop: null, voidReason: executed.voidReason });
  if (executed.providerDown) {
    const stop = CampaignStop.ProviderUnavailable;
    await halt(session, { outcome: CampaignOutcome.Stopped, stop, voidReason: null });
  }
  return executed;
}

/** Whether one (lane, app)'s opening canary has passed, on its first try or its retry. */
const groupPassed = (session: Session, group: readonly PlannedRun[]): boolean =>
  group.some((run) => canaryPassed(session.rows.get(run.runId)));

/** One (lane, app)'s opening canary: the first try, then the retry, each only while none has passed. */
async function openGroup(session: Session, group: readonly PlannedRun[], engine: EngineId): Promise<void> {
  for (const run of group) {
    if (groupPassed(session, group)) return;
    if (session.rows.has(run.runId)) continue;
    if (!(await runOne(session, run, engine))?.row) return;
  }
}

/** A stream's opening canaries: each (lane, app) must pass, on its first try or its one retry (Rule 20). */
async function openStream(session: Session, stream: ProviderStream): Promise<void> {
  for (const group of openingGroups(stream)) {
    await openGroup(session, group, stream.engine);
    if (session.halt) return;
    if (!groupPassed(session, group)) {
      const voidReason = CampaignVoidReason.OpeningCanary;
      await halt(session, { outcome: CampaignOutcome.Aborted, stop: null, voidReason });
      return;
    }
  }
}

/** A stream's builds in their seeded order, with each harness failure's replacement queued behind them. */
async function buildStream(session: Session, stream: ProviderStream): Promise<void> {
  const queue = buildQueue(session, stream);
  for (let next = queue.shift(); next; next = queue.shift()) {
    const executed = await runOne(session, next, stream.engine);
    if (!executed?.row) return;
    if (executed.replacement) queue.push(executed.replacement);
  }
}

/** A stream's closing canaries: one try each; a failure voids the campaign (§8.1). */
async function closeStream(session: Session, stream: ProviderStream): Promise<void> {
  for (const run of stream.closing) {
    const done = session.rows.get(run.runId);
    const row = done ?? (await runOne(session, run, stream.engine))?.row;
    if (!row) return;
    if (!canaryPassed(row)) {
      await halt(session, { outcome: CampaignOutcome.Void, stop: null, voidReason: CampaignVoidReason.ClosingCanary });
      return;
    }
  }
}

/** Run one phase over every stream: at the same time, or one stream after another under `--serial`. */
async function eachStream(session: Session, phase: (session: Session, stream: ProviderStream) => Promise<void>) {
  if (session.options.serial) {
    for (const stream of session.plan.streams) await phase(session, stream);
    return;
  }
  // A fault in one stream stops the other at its next run, and is rethrown once both have settled,
  // so no live run is left going behind a rejected campaign.
  const settled = await Promise.allSettled(
    session.plan.streams.map((stream) =>
      phase(session, stream).catch((error: unknown) => {
        session.halt ??= { outcome: CampaignOutcome.Stopped, stop: null, voidReason: null };
        throw error;
      }),
    ),
  );
  const fault = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (fault) throw fault.reason;
}

/** Build each app SHA the pending Genex runs need, once. */
async function buildApps(session: Session, pending: readonly PlannedRun[]): Promise<void> {
  const shas = new Set(pending.flatMap((run) => (run.app ? [run.app.sha] : [])));
  for (const sha of shas) {
    session.deps.out(`build app ${sha.slice(0, 12)}`);
    session.builds.set(sha, await session.deps.buildApp(sha));
  }
}

function report(session: Session, outcome: CampaignOutcome, extra: Partial<CampaignRunReport> = {}): CampaignRunReport {
  return {
    campaignId: session.plan.campaignId,
    outcome,
    stop: session.halt?.stop ?? null,
    voidReason: session.halt?.voidReason ?? null,
    refusal: null,
    ran: session.ran,
    pending: pendingRuns(session).map((run) => run.runId),
    ...extra,
  };
}

/** Run (or, without `live`, list) a planned campaign; resumable. */
export async function runCampaign(
  plan: CampaignPlan,
  options: CampaignRunOptions,
  deps: CampaignRunDeps,
): Promise<CampaignRunReport> {
  const session = newSession(plan, options, deps, await deps.readRows());
  const refusal = await planRefusal(plan, deps);
  const alreadyVoid = [...session.rows.values()].some((row) => row.campaignVoid !== null);
  const refused = refusal ?? (alreadyVoid ? CampaignRunRefusal.AlreadyVoid : null);
  if (refused) return report(session, CampaignOutcome.Refused, { refusal: refused });
  const pending = pendingRuns(session);
  if (!options.live) {
    for (const run of pending) deps.out(`would run ${run.runId}`);
    return report(session, pending.length ? CampaignOutcome.DryRun : CampaignOutcome.Completed);
  }
  await buildApps(session, pending);
  for (const phase of [openStream, buildStream, closeStream]) {
    await eachStream(session, phase);
    if (session.halt) return report(session, session.halt.outcome);
  }
  return report(session, CampaignOutcome.Completed);
}

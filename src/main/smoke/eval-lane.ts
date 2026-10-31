/**
 * The Genex app's eval lane (evals plan §5.3, lanes A and D): an isolated `--studio-smoke` launch
 * that reads an {@link EvalLaneSpec}, turns off the plugins it names, sends one brief through one
 * fresh game chat in the evaluated build's own default mode, answers typed questions with the
 * shared sentence, waits until the chat is idle or the deadline rail takes the core stop path,
 * and writes an {@link EvalLaneReport}. No `electron` import: the rig drives {@link runEvalLane}
 * with a real core, and main opens and checks the launch ({@link openEvalLane}) before any core
 * starts.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PlanReviewState } from "../../shared/composer.ts";
import { latestRun } from "../../shared/coordinator.ts";
import type { CodingProvider } from "../../shared/coding-cli.ts";
import { CustomEvent, customPayload, customRecord } from "../../shared/custom-events.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { errorMessage } from "../../shared/errors.ts";
import {
  AnswerPolicy,
  EVAL_LANE_ANSWER_TEXT,
  EVAL_LANE_EXIT,
  EVAL_LANE_REPORT_SCHEMA,
  EndedHow,
  type EvalCommission,
  type EvalExecutables,
  type EvalLaneAnswer,
  type EvalLaneBudgets,
  type EvalLaneError,
  EvalLaneErrorCode,
  type EvalLanePlugin,
  type EvalLaneReport,
  type EvalLaneSpec,
  EvalLaunchRefusal,
  type HarnessDigest,
  LaneModeServed,
  LaunchPath,
  QuestionKind,
} from "../../shared/eval-lane.ts";
import { type EventEnvelope, EventKind } from "../../shared/event-log.ts";
import { messageQueueState, QueueState } from "../../shared/message-queue.ts";
import { isPermissionMode, PermissionMode } from "../../shared/permissions.ts";
import { isPluginId } from "../../shared/plugin-id.ts";
import { isCompletionPolicy, RUN_START_EVENTS, RunState } from "../../shared/run-state.ts";
import { UiEvent, type UiEventMap } from "../../shared/ui-events.ts";
import { EngineId } from "../../shared/providers.ts";
import { ClaudeCodeEngine } from "../../substrate/engines/claude-code.ts";
import { CodexEngine, HostSkills } from "../../substrate/engines/codex.ts";
import { cliVersion, resolveCodingCli } from "../../substrate/engines/external-cli.ts";
import type { Engine } from "../../substrate/engines/types.ts";
import { atomicWriteJson, ensureDir, isJsonObject, readRegularFile, realpathNearest } from "../../substrate/fsx.ts";
import { workspaceDigest } from "../../substrate/workspace-digest.ts";
import { layoutFor } from "../core/layout.ts";
import { fixtureEngines } from "../dev/fixture-engines.ts";
import type { StudioCore, StudioCoreOptions } from "../studio-core.ts";

/** How often the lane reads its chat's log while it waits. */
const POLL_MS = SECOND_MS;
/** Consecutive idle reads before the chat counts as done: a turn's end and a run's registration can straddle one read. */
const IDLE_SETTLE_POLLS = 2;
/** How long the core stop path gets to leave the chat idle before the report is written anyway. */
const STOP_SETTLE_MS = 2 * MINUTE_MS;
/** The largest spec file a launch reads. */
const SPEC_MAX_BYTES = 256 * 1024;
/** The version a report carries when the core was given none. */
const UNKNOWN_VERSION = "unknown";
/** What a workspace file the seed ships hashes to when the workspace has none. */
const MISSING_FILE = "missing";

/**
 * The run mode `start_autopilot` registers (the seed's `RunMode.Autopilot` in
 * `loop/run-events.ts`); a run registered without it came from `start_unattended_run`.
 */
const AUTOPILOT_RUN_MODE = "autopilot";

/** What the lane says; the typed-question answer is the shared sentence (`EVAL_LANE_ANSWER_TEXT`, §5.2). */
const MESSAGE = {
  unknownModel: (engine: string, model: string) => `${engine} does not list the model ${model}`,
  engineNotReady: (engine: string, status: string) => `${engine} is not ready (${status})`,
  noEngine: (engine: string) => `${engine} is not registered in this launch`,
  pluginNotDisabled: (id: string, why: string) => `plugin ${id} could not be turned off: ${why}`,
  pluginStillOn: "it is still on",
  refused: (code: string, detail: string) => `eval lane refused (${code}): ${detail}`,
} as const;

/** An eval launch main has opened and checked: the spec to run, including the CLIs it pins. */
export interface EvalLaunch {
  spec: EvalLaneSpec;
}

/** The time the lane reads and waits on; injectable so a test never waits a real deadline. */
export interface EvalLaneClock {
  now(): number;
  sleep(ms: number): Promise<unknown>;
}

/** Wall-clock time. */
export const SYSTEM_CLOCK: EvalLaneClock = { now: () => Date.now(), sleep: (ms) => sleep(ms) };

/** The plugin calls the lane makes: the ones the Plugins panel's switch and list make. */
export type EvalLanePlugins = Pick<StudioCore["plugins"], "list" | "enabled" | "setEnabled">;

/** The parts of the core the lane drives: the same calls the composer, the plan card, Stop and the Plugins panel make. */
export type EvalLaneCore = Pick<
  StudioCore,
  | "engines"
  | "layout"
  | "options"
  | "store"
  | "games"
  | "createGameThread"
  | "setPermissionMode"
  | "sendUserMessage"
  | "answerPlan"
  | "requestRunFinish"
  | "stopThread"
  | "activeBuilders"
> & { plugins: EvalLanePlugins };

/** A chat the core bound to a game folder (`UiEvent.ThreadBound`). */
export type ThreadBound = UiEventMap[typeof UiEvent.ThreadBound];

/** What the lane cannot read from the core itself. */
export interface EvalLaneDeps {
  /** The coding CLIs' versions; unset reports none (a fixture lane). */
  cliVersions?: () => Promise<EvalLaneReport["cliVersions"]>;
  /**
   * Call `listener` for each chat the core binds to a game folder; returns the unsubscribe. The
   * lane digests the seeded game right then (`templateDigest`); unset, the report has none.
   */
  onThreadBound?: (listener: (bound: ThreadBound) => void) => () => void;
}

/** The core's UI events fanned out to the lane's `thread.bound` listeners: feed `push` every event. */
export function threadBoundListeners(): {
  push: (event: UiEvent) => void;
  onThreadBound: NonNullable<EvalLaneDeps["onThreadBound"]>;
} {
  const listeners = new Set<(bound: ThreadBound) => void>();
  return {
    push: (event) => {
      if (event.type !== UiEvent.ThreadBound) return;
      for (const listener of listeners) listener(event.payload);
    },
    onThreadBound: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

// ── opening a launch ────────────────────────────────────────────────────────────────────────

/** What main knows about this launch when it opens the spec. */
export interface OpenEvalLaneInput {
  /** The `--studio-eval-lane` file. */
  file: string;
  smoke: boolean;
  /** A developer launch (`--studio-dev-launch`): its core would run on the dev profile and games. */
  devLaunch: boolean;
  /** `--studio-eval-fixture`: scripted engines whatever the spec says. */
  fixtureFlag: boolean;
  /** `STUDIO_ALLOW_LIVE_CREDENTIAL_CHECKS=1`. */
  liveAllowed: boolean;
  /** The launch's actual data folder (`--userdata`). */
  userData: string;
  /** `~/AI Games`, the normal profile's games. */
  aiGames: string;
  /** The normal profile's userData. */
  defaultUserData: string;
}

/** An opened launch, or the reason it is refused (with a local-only detail). */
export type OpenedEvalLane =
  | { ok: true; launch: EvalLaunch }
  | { ok: false; refusal: EvalLaunchRefusal; detail: string };

/**
 * Read, validate and check an eval launch before any core starts: a smoke launch only, never a
 * developer launch (its core runs on the dev profile, not the roots checked here), live
 * providers only with the explicit opt-in, never Bypass, and every root the run writes (its data
 * folder, the spec's userData and games, the report's folder) inside the spec's work root by real
 * path, never in `~/AI Games` or the normal profile. Creates nothing.
 */
export async function openEvalLane(input: OpenEvalLaneInput): Promise<OpenedEvalLane> {
  if (!input.smoke) return refuse(EvalLaunchRefusal.NotSmoke, input.file);
  // A developer launch's core writes to its dev profile and games, never the roots checked below.
  if (input.devLaunch) return refuse(EvalLaunchRefusal.DevLaunch, input.file);
  let launch: EvalLaunch;
  try {
    launch = parseEvalLaunch(JSON.parse((await readRegularFile(input.file, SPEC_MAX_BYTES)).toString("utf8")));
  } catch (error) {
    return refuse(EvalLaunchRefusal.InvalidSpec, errorMessage(error));
  }
  const spec = { ...launch.spec, fixture: launch.spec.fixture || input.fixtureFlag };
  const roots = [input.userData, spec.userDataRoot, spec.gamesRoot, path.dirname(spec.reportPath)];
  let real: { workRoot: string; roots: string[]; aiGames: string; defaultUserData: string };
  try {
    real = {
      workRoot: await realpathNearest(spec.workRoot),
      roots: await Promise.all(roots.map((root) => realpathNearest(root))),
      aiGames: await realpathNearest(input.aiGames),
      defaultUserData: await realpathNearest(input.defaultUserData),
    };
  } catch (error) {
    // A link on the way that resolves nowhere: where the run would write is unknown, so not inside its root.
    return refuse(EvalLaunchRefusal.OutsideWorkRoot, errorMessage(error));
  }
  const refusal = evalLaunchRefusal({
    smoke: input.smoke,
    live: !spec.fixture,
    liveAllowed: input.liveAllowed,
    permissionMode: spec.permissionMode,
    ...real,
  });
  if (refusal) return refuse(refusal, spec.workRoot);
  // The run uses the roots it was checked by: the core compares a game's real path with its games root.
  const [, userDataRoot = spec.userDataRoot, gamesRoot = spec.gamesRoot, reportDir = ""] = real.roots;
  const reportPath = path.join(reportDir, path.basename(spec.reportPath));
  const checked = { ...spec, workRoot: real.workRoot, userDataRoot, gamesRoot, reportPath };
  return { ok: true, launch: { spec: checked } };
}

function refuse(refusal: EvalLaunchRefusal, detail: string): OpenedEvalLane {
  return { ok: false, refusal, detail };
}

/** The refusal line main prints on stderr. */
export function evalLaunchRefusedLine(opened: Extract<OpenedEvalLane, { ok: false }>): string {
  return MESSAGE.refused(opened.refusal, opened.detail);
}

/** An eval launch's facts, every path already a real path. */
export interface EvalLaunchFacts {
  smoke: boolean;
  /** Real providers (not the fixture engines). */
  live: boolean;
  liveAllowed: boolean;
  permissionMode: PermissionMode;
  workRoot: string;
  /** Every folder the run writes. */
  roots: readonly string[];
  aiGames: string;
  defaultUserData: string;
}

/**
 * `target` is `root` or lies under it, lexically. Unlike `paths.ts` `isInside`, the file system
 * root contains everything: a work root of `/` must read as too broad, not as holding nothing.
 */
function within(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  const leaves = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return !leaves;
}

/** Why this launch must not run, or null. Pure: every path is real already. */
export function evalLaunchRefusal(facts: EvalLaunchFacts): EvalLaunchRefusal | null {
  if (!facts.smoke) return EvalLaunchRefusal.NotSmoke;
  if (facts.live && !facts.liveAllowed) return EvalLaunchRefusal.LiveNotAllowed;
  if (facts.permissionMode === PermissionMode.Bypass) return EvalLaunchRefusal.BypassMode;
  const protectedRoots = [facts.aiGames, facts.defaultUserData];
  if (protectedRoots.some((root) => within(facts.workRoot, root))) return EvalLaunchRefusal.WorkRootTooBroad;
  for (const root of facts.roots) {
    if (within(facts.aiGames, root)) return EvalLaunchRefusal.InsideAiGames;
    if (within(facts.defaultUserData, root)) return EvalLaunchRefusal.DefaultUserData;
    if (!within(facts.workRoot, root)) return EvalLaunchRefusal.OutsideWorkRoot;
  }
  return null;
}

// ── the spec ────────────────────────────────────────────────────────────────────────────────

/** A spec field that is missing or has the wrong shape. */
class EvalSpecError extends Error {
  constructor(field: string) {
    super(`eval lane spec: bad ${field}`);
  }
}

type Fields = Record<string, unknown>;

function text(fields: Fields, key: string): string {
  const value = fields[key];
  if (typeof value !== "string" || !value) throw new EvalSpecError(key);
  return value;
}

function absolute(fields: Fields, key: string): string {
  return absolutePath(fields[key], key);
}

/** An absolute path, or the error naming `field`. */
function absolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new EvalSpecError(field);
  return value;
}

function count(fields: Fields, key: string): number {
  const value = fields[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new EvalSpecError(key);
  return value;
}

function flag(fields: Fields, key: string): boolean {
  const value = fields[key];
  if (typeof value !== "boolean") throw new EvalSpecError(key);
  return value;
}

function oneOf<T extends string>(fields: Fields, key: string, values: Record<string, T>): T {
  const value = fields[key];
  const known = Object.values(values) as string[];
  if (typeof value !== "string" || !known.includes(value)) throw new EvalSpecError(key);
  return value as T;
}

function object(fields: Fields, key: string): Fields {
  const value = fields[key];
  if (!isJsonObject(value)) throw new EvalSpecError(key);
  return value;
}

/** The commission keys a spec may carry: what the composer sends with a brief, nothing else. */
const COMMISSION_KEYS: ReadonlySet<string> = new Set(["autopilot", "loop", "reviewPlan", "preferences"]);

function commission(fields: Fields): EvalCommission {
  const value = object(fields, "commission");
  if (Object.keys(value).some((key) => !COMMISSION_KEYS.has(key))) throw new EvalSpecError("commission");
  return value as EvalCommission;
}

/** The optional pinned CLIs (`executables: {claude?, codex?}`), absolute paths only; absent stays absent. */
function executables(fields: Fields): Pick<EvalLaneSpec, "executables"> {
  if (fields.executables === undefined) return {};
  const { claude, codex } = object(fields, "executables");
  const pinned: EvalExecutables = {
    ...(claude === undefined ? {} : { claude: absolutePath(claude, "executables.claude") }),
    ...(codex === undefined ? {} : { codex: absolutePath(codex, "executables.codex") }),
  };
  return { executables: pinned };
}

/** The optional plugins to turn off: distinct plugin ids, at least one; absent stays absent. */
function disabledPlugins(fields: Fields): Pick<EvalLaneSpec, "disabledPlugins"> {
  const value = fields.disabledPlugins;
  if (value === undefined) return {};
  const valid = Array.isArray(value) && value.length > 0 && value.every(isPluginId);
  if (!valid || new Set(value).size !== value.length) throw new EvalSpecError("disabledPlugins");
  return { disabledPlugins: [...value] };
}

/** The eval-owned CLI homes, both absolute. */
function cliHomes(fields: Fields): EvalLaneSpec["homes"] {
  const { claude, codex } = object(fields, "homes");
  return { claude: absolutePath(claude, "homes.claude"), codex: absolutePath(codex, "homes.codex") };
}

/** A spec as JSON gave it, validated field by field; throws naming the first bad field. */
export function parseEvalLaunch(value: unknown): EvalLaunch {
  if (!isJsonObject(value)) throw new EvalSpecError("spec");
  const spec: EvalLaneSpec = {
    runId: text(value, "runId"),
    laneId: text(value, "laneId"),
    caseId: text(value, "caseId"),
    engine: oneOf(value, "engine", EngineId),
    model: text(value, "model"),
    effort: text(value, "effort"),
    brief: text(value, "brief"),
    suffix: text(value, "suffix"),
    commission: commission(value),
    permissionMode: oneOf(value, "permissionMode", PermissionMode),
    deadlineMs: count(value, "deadlineMs"),
    graceMs: count(value, "graceMs"),
    answerPolicy: oneOf(value, "answerPolicy", AnswerPolicy),
    maxAnswers: count(value, "maxAnswers"),
    codexHostSkillSuppression: flag(value, "codexHostSkillSuppression"),
    gamesRoot: absolute(value, "gamesRoot"),
    userDataRoot: absolute(value, "userDataRoot"),
    workRoot: absolute(value, "workRoot"),
    homes: cliHomes(value),
    reportPath: absolute(value, "reportPath"),
    fixture: flag(value, "fixture"),
    ...executables(value),
    ...disabledPlugins(value),
  };
  return { spec };
}

// ── the core an eval launch runs ────────────────────────────────────────────────────────────

/** The core options the launch's `launchCoreOptions` returns (evals plan §5.3). */
export type EvalCoreOptions = Pick<StudioCoreOptions, "engines" | "gamesRoot" | "executionPolicy">;

/**
 * Real Claude Code and Codex engines (Codex with host skills suppressed when the spec asks, and
 * both CLIs pinned when it names them), or the scripted fixture engines; games in the spec's
 * root, which is the only root a build may use.
 */
export function evalCoreOptions(launch: EvalLaunch, userData: string): EvalCoreOptions {
  const { spec } = launch;
  return {
    engines: spec.fixture ? fixtureEngines() : evalEngines(launch, userData),
    gamesRoot: spec.gamesRoot,
    executionPolicy: { allowedProjectRoot: spec.gamesRoot },
  };
}

/** The two subscription engines as the core builds them, plus the eval-only pins. */
function evalEngines({ spec }: EvalLaunch, userData: string): Engine[] {
  const executables = spec.executables ?? {};
  const layout = layoutFor(userData);
  // The core's own protected paths (studio-core.ts `#protectedPaths`): its secrets, its engine
  // homes and Genex's CLI folder, which no contractor may read.
  const protectedPaths = [layout.secrets, layout.engineHomes, path.join(os.homedir(), ".genex")];
  return [
    new ClaudeCodeEngine({
      engineHome: path.join(layout.engineHomes, EngineId.ClaudeCode),
      protectedPaths,
      sweepOnBoot: true,
      ...(executables.claude ? { executable: executables.claude } : {}),
    }),
    new CodexEngine({
      engineHome: path.join(layout.engineHomes, EngineId.Codex),
      protectedPaths,
      ...(spec.codexHostSkillSuppression ? { hostSkills: HostSkills.Suppress } : {}),
      ...(executables.codex ? { executable: executables.codex } : {}),
    }),
  ];
}

/** The pinned CLIs' versions, as the app's own discovery reads them; none for a fixture lane. */
export function evalCliVersions(launch: EvalLaunch): () => Promise<EvalLaneReport["cliVersions"]> {
  const version = async (engine: CodingProvider, executable: string | undefined) =>
    cliVersion((await resolveCodingCli(engine, executable).catch(() => null))?.status.version) ?? null;
  return async () => {
    if (launch.spec.fixture) return { claude: null, codex: null };
    return {
      claude: await version(EngineId.ClaudeCode, launch.spec.executables?.claude),
      codex: await version(EngineId.Codex, launch.spec.executables?.codex),
    };
  };
}

// ── the chat's log ──────────────────────────────────────────────────────────────────────────

/** One typed question in the chat, and whether it still waits for an answer. */
export interface LaneQuestion {
  kind: QuestionKind;
  id: string;
  waiting: boolean;
}

/** What the lane reads from its chat's log at one moment. */
export interface LaneLog {
  /** The chat took the brief: a message was queued or a plan review began. */
  started: boolean;
  /** A message still waits for, or is getting, its answer. */
  queueBusy: boolean;
  /** A plan is being written or its run is starting. */
  planBusy: boolean;
  /** The chat's latest run while it has not finished, or null. */
  runningRunId: string | null;
  /** The last user message was met with an error and no reply: the turn failed. */
  failed: boolean;
  questions: LaneQuestion[];
}

const BUSY_QUEUE: ReadonlySet<string> = new Set([QueueState.Queued, QueueState.Processing, QueueState.Steering]);
const BUSY_PLAN: ReadonlySet<string> = new Set([PlanReviewState.Generating, PlanReviewState.Starting]);

/** Is this record a message in the user's words? */
function isUserMessage(event: EventEnvelope): boolean {
  const data = event.data;
  return data.type === EventKind.Messages && data.messages.some((message) => message.role === "user");
}

/** Is this record the assistant's reply? */
function isAssistantMessage(event: EventEnvelope): boolean {
  const data = event.data;
  return data.type === EventKind.Messages && data.messages.some((message) => message.role === "assistant");
}

/** Did the chat's last user message get an error and no reply after it? */
function turnFailed(events: readonly EventEnvelope[]): boolean {
  let failed = false;
  for (const event of events) {
    if (isUserMessage(event) || isAssistantMessage(event)) failed = false;
    if (event.data.type === EventKind.Error) failed = true;
  }
  return failed;
}

/** The chat's log as the lane reads it: queue, plan reviews, the latest run and typed questions. */
export function readLaneLog(events: readonly EventEnvelope[]): LaneLog {
  const queue = messageQueueState(events);
  const plans = new Map<string, string>();
  const asked: Array<{ id: string; at: number }> = [];
  let lastUserAt = -1;
  for (const [at, event] of events.entries()) {
    if (isUserMessage(event)) lastUserAt = at;
    const review = customPayload(event.data, CustomEvent.PlanReview);
    if (review && typeof review.id === "string" && typeof review.state === "string") plans.set(review.id, review.state);
    if (customRecord(event.data)?.event_type === CustomEvent.InterviewQuestion) asked.push({ id: event.id, at });
  }
  const questions: LaneQuestion[] = asked.map(({ id, at }) => ({
    kind: QuestionKind.AskUser,
    id,
    waiting: at > lastUserAt,
  }));
  for (const [id, state] of plans)
    questions.push({ kind: QuestionKind.PlanReview, id, waiting: state === PlanReviewState.Waiting });
  const run = latestRun(events);
  return {
    started: queue.messages.size > 0 || plans.size > 0,
    queueBusy: [...queue.messages.values()].some((message) => BUSY_QUEUE.has(message.state)),
    planBusy: [...plans.values()].some((state) => BUSY_PLAN.has(state)),
    runningRunId: run && run.state !== RunState.Finished ? String(run.runId ?? "") : null,
    failed: turnFailed(events),
    questions,
  };
}

/** Is the chat done: it took the brief, its turn ended, nothing is queued, no build runs? */
function isIdle(log: LaneLog, buildersAtWork: number): boolean {
  const working = log.queueBusy || log.planBusy || buildersAtWork > 0;
  return log.started && !working && log.runningRunId === null;
}

/** Which launch the chat chose, the budgets it registered, and the runs it launched, in order. */
export function readLaunch(events: readonly EventEnvelope[]): {
  launch: LaunchPath;
  budgets: EvalLaneBudgets;
  runIds: string[];
} {
  const runIds: string[] = [];
  // The first run's start records, merged: its registration names the mode and all its budgets.
  let mode: unknown;
  let budgets: Record<string, unknown> = {};
  for (const event of events) {
    const custom = customRecord(event.data);
    if (!custom || !RUN_START_EVENTS.has(custom.event_type)) continue;
    const start = custom.payload;
    if (typeof start.runId !== "string") continue;
    if (!runIds.includes(start.runId)) runIds.push(start.runId);
    if (start.runId !== runIds[0]) continue;
    mode = start.mode ?? mode;
    budgets = { ...budgets, ...(isJsonObject(start.budgets) ? start.budgets : {}) };
  }
  if (!runIds.length) return { launch: LaunchPath.None, budgets: { completionPolicy: null }, runIds };
  const launch = mode === AUTOPILOT_RUN_MODE ? LaunchPath.StartAutopilot : LaunchPath.StartUnattendedRun;
  return { launch, budgets: recordedBudgets(budgets), runIds };
}

/** The budgets a run registered, only the fields a report records. */
function recordedBudgets(budgets: Record<string, unknown>): EvalLaneBudgets {
  const policy = budgets.completionPolicy;
  return {
    ...(typeof budgets.wallClockMs === "number" ? { wallClockMs: budgets.wallClockMs } : {}),
    ...(typeof budgets.untilSatisfied === "boolean" ? { untilSatisfied: budgets.untilSatisfied } : {}),
    completionPolicy: isCompletionPolicy(policy) ? policy : null,
  };
}

/** The main-loop model the engine reported (the chat's own context meter), or null. */
function servedModel(events: readonly EventEnvelope[], engine: string): string | null {
  for (const event of events) {
    const usage = customPayload(event.data, CustomEvent.ContextUsage);
    const chatSession = usage?.role === undefined || usage.role === "planner";
    if (usage?.engine === engine && chatSession && typeof usage.model === "string" && usage.model) return usage.model;
  }
  return null;
}

/** Ms from the brief's record to the first checkpoint or landed build (the first-preview proxy). */
function firstPreviewProxyMs(events: readonly EventEnvelope[]): number | null {
  const brief = events.find(isUserMessage);
  if (!brief) return null;
  const briefAt = Date.parse(brief.created_at);
  const proxy = events.find((event) => {
    if (Date.parse(event.created_at) < briefAt) return false;
    return (
      event.data.type === EventKind.SnapshotCreated || customRecord(event.data)?.event_type === CustomEvent.BuildLanded
    );
  });
  return proxy ? Date.parse(proxy.created_at) - briefAt : null;
}

// ── the harness digest ──────────────────────────────────────────────────────────────────────

/** Every file under `dir` by `/`-relative path, sorted; links and `.git` are not followed. */
async function seedFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name === ".git") continue;
    if (entry.isDirectory()) out.push(...(await seedFiles(dir, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

async function fileHash(file: string): Promise<string> {
  const bytes = await readFile(file).catch(() => null);
  return bytes ? createHash("sha256").update(bytes).digest("hex") : MISSING_FILE;
}

/**
 * The harness workspace against the shipped seed: one sha256 over each seed file's path and hash,
 * and one over the workspace's copies of the same paths. They match while the agent's harness is
 * the shipped one; files the harness writes for itself (memory) are not the seed's and not hashed.
 */
export async function harnessDigest(workspace: string, seed: string): Promise<HarnessDigest> {
  const shipped = createHash("sha256");
  const current = createHash("sha256");
  for (const rel of await seedFiles(seed)) {
    shipped.update(`${rel}\0${await fileHash(path.join(seed, rel))}\n`);
    current.update(`${rel}\0${await fileHash(path.join(workspace, rel))}\n`);
  }
  const digest = { workspace: current.digest("hex"), shipped: shipped.digest("hex") };
  return { ...digest, matches: digest.workspace === digest.shipped };
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────

/** One lane's run as it goes: its chat, its clock marks, what it answered and what went wrong. */
interface LaneRun {
  core: EvalLaneCore;
  spec: EvalLaneSpec;
  clock: EvalLaneClock;
  threadId: string;
  startedAt: number;
  promptAt: number;
  answers: EvalLaneAnswer[];
  errors: EvalLaneError[];
  /** The seeded game's digest, started the moment the chat was bound to it; null until then. */
  templateDigest: Promise<string | null> | null;
  /** Stop listening for the chat's binding. */
  unwatchSeed: () => void;
}

/**
 * Digest the game the moment the core binds this run's chat to it: the template as the app seeded
 * it, before the agent's first edit can land (the bind happens inside the scaffold call the agent
 * is still waiting on). Returns the unsubscribe.
 */
function digestSeededGame(run: LaneRun, deps: EvalLaneDeps): () => void {
  if (!deps.onThreadBound) return () => {};
  return deps.onThreadBound((bound) => {
    if (bound.threadId !== run.threadId || run.templateDigest !== null) return;
    run.templateDigest = workspaceDigest(run.core.games.dirFor(bound.project)).catch(() => null);
  });
}

/** The composer options every message of the lane carries: the pinned model and the build's commission. */
function sendOptions(run: LaneRun) {
  const { spec } = run;
  return { thread: run.threadId, engine: spec.engine, model: spec.model, effort: spec.effort, ...spec.commission };
}

/** The engine can run the requested model, or the error that says why not. */
async function preflight(core: EvalLaneCore, spec: EvalLaneSpec): Promise<EvalLaneError | null> {
  const descriptor = (await core.engines.describe()).find((engine) => engine.id === spec.engine);
  if (!descriptor) return { code: EvalLaneErrorCode.EngineNotReady, detail: MESSAGE.noEngine(spec.engine) };
  if (descriptor.status.code !== EngineStatusCode.Ready)
    return {
      code: EvalLaneErrorCode.EngineNotReady,
      detail: MESSAGE.engineNotReady(spec.engine, descriptor.status.code),
    };
  const listed = descriptor.models.some((model) => model.id === spec.model || model.resolvedModel === spec.model);
  if (!listed) return { code: EvalLaneErrorCode.UnknownModel, detail: MESSAGE.unknownModel(spec.engine, spec.model) };
  return null;
}

/**
 * Turn the spec's plugins off the way the Plugins panel's switch does, before any chat exists, and
 * read each back: the error naming the first that is not installed or is still on, or null.
 */
async function turnPluginsOff(plugins: EvalLanePlugins, ids: readonly string[]): Promise<EvalLaneError | null> {
  for (const id of ids) {
    try {
      await plugins.setEnabled(id, false);
    } catch (error) {
      return { code: EvalLaneErrorCode.PluginNotDisabled, detail: MESSAGE.pluginNotDisabled(id, errorMessage(error)) };
    }
    if (plugins.enabled(id))
      return {
        code: EvalLaneErrorCode.PluginNotDisabled,
        detail: MESSAGE.pluginNotDisabled(id, MESSAGE.pluginStillOn),
      };
  }
  return null;
}

/** Every installed plugin and whether it is live now, by id. */
function pluginStates(plugins: EvalLanePlugins): EvalLanePlugin[] {
  return plugins
    .list()
    .map(({ manifest }) => ({ id: manifest.id, enabled: plugins.enabled(manifest.id) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Answer the chat's waiting typed questions with the policy's sentence, up to the spec's cap; whether any was. */
async function answerQuestions(run: LaneRun, log: LaneLog): Promise<boolean> {
  let answered = false;
  for (const question of log.questions) {
    const already = run.answers.some((answer) => answer.questionId === question.id);
    if (!question.waiting || already || run.answers.length >= run.spec.maxAnswers) continue;
    if (question.kind === QuestionKind.AskUser && log.queueBusy) continue;
    if (question.kind === QuestionKind.AskUser)
      await run.core.sendUserMessage(EVAL_LANE_ANSWER_TEXT[run.spec.answerPolicy], sendOptions(run));
    else await run.core.answerPlan(run.threadId, question.id, true);
    run.answers.push({
      atMs: run.clock.now() - run.promptAt,
      question: question.kind,
      questionId: question.id,
      policy: run.spec.answerPolicy,
    });
    answered = true;
  }
  return answered;
}

/** Builders at work in any game right now. */
function buildersAtWork(core: EvalLaneCore): number {
  return Object.values(core.activeBuilders()).reduce((sum, n) => sum + n, 0);
}

/**
 * Wait for the chat to be idle, answering its typed questions; at the deadline ask its running
 * build to finish, and at deadline + grace take the core stop path. How the run ended.
 */
async function waitForEnd(run: LaneRun): Promise<EndedHow> {
  const deadlineAt = run.promptAt + run.spec.deadlineMs;
  const railAt = deadlineAt + run.spec.graceMs;
  let settled = 0;
  let finishAsked = false;
  for (;;) {
    const log = readLaneLog(await run.core.store.listEvents(run.threadId));
    const now = run.clock.now();
    if (now >= railAt) return stopAtRail(run);
    if (now >= deadlineAt && log.runningRunId && !finishAsked) {
      finishAsked = true;
      await run.core.requestRunFinish(run.threadId, log.runningRunId).catch(() => {});
    }
    const answered = now < deadlineAt && (await answerQuestions(run, log));
    settled = !answered && isIdle(log, buildersAtWork(run.core)) ? settled + 1 : 0;
    if (settled >= IDLE_SETTLE_POLLS) return idleEnding(log, now >= deadlineAt);
    await run.clock.sleep(POLL_MS);
  }
}

/** How an idle chat ended: our deadline, a failed turn, or the agent finishing. */
function idleEnding(log: LaneLog, pastDeadline: boolean): EndedHow {
  if (pastDeadline) return EndedHow.Deadline;
  return log.failed ? EndedHow.Crash : EndedHow.AgentFinished;
}

/** The rail: the core's Stop, then a bounded wait for the chat to settle. Always a deadline ending. */
async function stopAtRail(run: LaneRun): Promise<EndedHow> {
  try {
    await run.core.stopThread(run.threadId);
  } catch (error) {
    run.errors.push({ code: EvalLaneErrorCode.StopFailed, detail: errorMessage(error) });
    return EndedHow.Deadline;
  }
  const until = run.clock.now() + STOP_SETTLE_MS;
  while (run.clock.now() < until) {
    const log = readLaneLog(await run.core.store.listEvents(run.threadId));
    if (isIdle(log, buildersAtWork(run.core))) break;
    await run.clock.sleep(POLL_MS);
  }
  return EndedHow.Deadline;
}

/** What mode the lane served, from the commission it sent (D3) or its fixture engines. */
function modeServed(spec: EvalLaneSpec): LaneModeServed {
  if (spec.fixture) return LaneModeServed.Fixture;
  const { autopilot, loop } = spec.commission;
  const timed = typeof autopilot?.hours === "number" && autopilot.hours > 0;
  if (autopilot) return timed ? LaneModeServed.AutopilotTimed : LaneModeServed.AutopilotUntilSatisfied;
  return loop ? LaneModeServed.AutopilotTimed : LaneModeServed.ChatOnly;
}

/** The chat's permission mode as the core now serves it. */
async function permissionModeServed(core: EvalLaneCore, threadId: string, fallback: PermissionMode) {
  const record = await core.store.getRecord(threadId).catch(() => null);
  const mode = (record?.metadata as { permissionMode?: unknown } | undefined)?.permissionMode;
  return isPermissionMode(mode) ? mode : fallback;
}

/** The game folder the chat is bound to, or "" when it never got one. */
async function projectDir(core: EvalLaneCore, threadId: string): Promise<string> {
  const record = await core.store.getRecord(threadId).catch(() => null);
  const project = (record?.metadata as { project?: unknown } | undefined)?.project;
  return typeof project === "string" && project ? core.games.dirFor(project) : "";
}

/** The report, from the run and its chat's final log. */
async function buildReport(run: LaneRun, endedHow: EndedHow, deps: EvalLaneDeps): Promise<EvalLaneReport> {
  const { core, spec } = run;
  const events = run.threadId ? await core.store.listEvents(run.threadId).catch(() => []) : [];
  const chosen = readLaunch(events);
  const log = readLaneLog(events);
  return {
    schema: EVAL_LANE_REPORT_SCHEMA,
    runId: spec.runId,
    laneId: spec.laneId,
    caseId: spec.caseId,
    engine: spec.engine,
    modelRequested: spec.model,
    modelServed: servedModel(events, spec.engine),
    effort: spec.effort,
    effortServed: null,
    appVersion: core.options.appVersion ?? UNKNOWN_VERSION,
    harnessDigest: await harnessDigest(core.layout.harnessWs, path.join(core.options.paths.resources, "harness-seed")),
    projectDir: run.threadId ? await projectDir(core, run.threadId) : "",
    templateDigest: await (run.templateDigest ?? null),
    threadId: run.threadId,
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: new Date(run.clock.now()).toISOString(),
    endedHow,
    ...chosen,
    permissionModeServed: run.threadId
      ? await permissionModeServed(core, run.threadId, spec.permissionMode)
      : spec.permissionMode,
    modeServed: modeServed(spec),
    commissionSent: spec.commission,
    questionsAsked: log.questions.length,
    answers: run.answers,
    firstPreviewProxyMs: firstPreviewProxyMs(events),
    cliVersions: (await deps.cliVersions?.()) ?? { claude: null, codex: null },
    fixture: spec.fixture,
    errors: run.errors,
    plugins: pluginStates(core.plugins),
  };
}

/**
 * Preflight, the spec's plugins turned off, a fresh game chat in the spec's permission mode (its
 * seeding watched), and the brief sent into it.
 */
async function begin(run: LaneRun, deps: EvalLaneDeps): Promise<boolean> {
  const refused =
    (await preflight(run.core, run.spec)) ?? (await turnPluginsOff(run.core.plugins, run.spec.disabledPlugins ?? []));
  if (refused) {
    run.errors.push(refused);
    return false;
  }
  try {
    run.threadId = await run.core.createGameThread();
    run.unwatchSeed = digestSeededGame(run, deps);
    await run.core.setPermissionMode(run.threadId, run.spec.permissionMode);
    run.promptAt = run.clock.now();
    await run.core.sendUserMessage(`${run.spec.brief}\n\n${run.spec.suffix}`, sendOptions(run));
    return true;
  } catch (error) {
    run.errors.push({ code: EvalLaneErrorCode.ThreadFailed, detail: errorMessage(error) });
    return false;
  }
}

/**
 * Run one eval lane through the core and write its report to `spec.reportPath`. The exit code:
 * 0 when the lane ran and reported (whatever its ending), 1 when the lane itself failed.
 */
export async function runEvalLane(
  core: EvalLaneCore,
  spec: EvalLaneSpec,
  clock: EvalLaneClock = SYSTEM_CLOCK,
  deps: EvalLaneDeps = {},
): Promise<number> {
  const startedAt = clock.now();
  const run: LaneRun = {
    core,
    spec,
    clock,
    threadId: "",
    startedAt,
    promptAt: startedAt,
    answers: [],
    errors: [],
    templateDigest: null,
    unwatchSeed: () => {},
  };
  let endedHow: EndedHow = EndedHow.HarnessFailure;
  if (await begin(run, deps)) {
    try {
      endedHow = await waitForEnd(run);
    } catch (error) {
      run.errors.push({ code: EvalLaneErrorCode.ThreadFailed, detail: errorMessage(error) });
    }
  }
  run.unwatchSeed();
  const report = await buildReport(run, endedHow, deps);
  try {
    await ensureDir(path.dirname(spec.reportPath));
    await atomicWriteJson(spec.reportPath, report);
  } catch (error) {
    console.error(`[eval-lane] ${EvalLaneErrorCode.ReportWriteFailed}: ${errorMessage(error)}`);
    return EVAL_LANE_EXIT.Failed;
  }
  return endedHow === EndedHow.HarnessFailure ? EVAL_LANE_EXIT.Failed : EVAL_LANE_EXIT.Ok;
}

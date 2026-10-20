import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  Activate,
  PluginActivation,
  PluginContext,
  PluginEngineAssistRefusal,
  PluginEngineLink,
  PluginReview,
  PluginToolbarStatus,
} from "../../plugin-sdk/index.d.ts";
import { errorMessage } from "../../shared/errors.ts";
import { OBSERVE_CALL_MS } from "../../shared/observers.ts";
import type { HookAnswer, HookContext } from "../../shared/plugin-hooks.ts";
import { atomicWriteJson } from "../../substrate/fsx.ts";
import { SYSTEM_CLOCK } from "../../substrate/job-process.ts";
import { EnginePlayTool } from "../../shared/engine-play.ts";
import { PluginService } from "../../shared/plugins.ts";
import { RobloxAction } from "./actions.ts";
import { agentFolder } from "./agent-marks.ts";
import { type AiTool, type AskFirstGame, createAiTools } from "./ai-tools.ts";
import { createComputerPlay, type PlayGame } from "./computer-play.ts";
import { type HelperAsk, type HelperLink, startHelperLink } from "./helper-link.ts";
import type { ScriptChange } from "./helper-protocol.ts";
import {
  nowStep,
  type RobloxRow,
  type RobloxStepFacts,
  type RobloxStepId,
  type RobloxSteps,
  robloxRows,
  robloxSteps,
} from "./engine-steps.ts";
import { readLiveData } from "./live-data.ts";
import {
  addLuauAction,
  checkScriptsTool,
  type LuauDeps,
  type LuauStatus,
  luauFinishAt,
  luauNoteAt,
  luauStatus,
  reviewAddLuau,
  systemLuau,
} from "./luau-checks.ts";
import { type MomentServices, momentOpsFor, noMomentServices } from "./moment-ops.ts";
import { clearPendingScripts, hasPendingScripts, loadPendingPlace } from "./place-files.ts";
import { createProbes, type ProbeLuauFile, RobloxProbe } from "./probes.ts";
import {
  firstPublish,
  firstPublishName,
  PublishAsker,
  type PublishDeps,
  type PublishPlace,
  publishUpdate,
  reviewFirstPublish,
  reviewPublish,
  unfitName,
} from "./publish.ts";
import { crashAnswer, probeAnswer } from "./hook-answers.ts";
import {
  createStudioWatch,
  heroShotsAt,
  FLUSH_MAX_MS,
  loadPlaceAt,
  type MomentOps,
  openForRun,
  personActive,
  savePlaceAt,
  studioStateAt,
  teamNoteAt,
  viewportStill,
} from "./studio-moments.ts";
import { planSwitches, readSwitches } from "./mcp-switch.ts";
import {
  HELPER_FILE,
  HelperChange,
  planSetup,
  recordedHelper,
  type SetupDone,
  type SetupOptions,
  setUp,
  setupPaths,
  undoSetup,
} from "./setup.ts";
import { notedFrom, notePublish, type RelinkDeps, relinkPublished, studioHolding } from "./relink.ts";
import { SETUP_PROMPTS } from "./setup-prompts.ts";
import { RobloxSetupError, SetupRefusal } from "./setup-refusal.ts";
import { createScriptSyncs, type ScriptSyncs, systemWatch } from "./script-sync.ts";
import { createStudioClient, type StudioClient, studioAnswers, systemStudioClientDeps } from "./studio-client.ts";
import { type ShrinkShot, systemShrink } from "./studio-shot.ts";
import {
  ALLOWED_HOST,
  afterInstall,
  INSTALLER,
  type InstallDeps,
  InstallError,
  InstallPhase,
  type InstallRefusal,
  installStudio,
  systemInstallRun,
} from "./studio-install.ts";
import {
  createGame,
  engineStatus,
  newGameTool,
  openStudio,
  type PlaceActionDeps,
  type QuitAnswer,
  QuitMiss,
  quitStudioAction,
  showSteps,
  titleOf as gameTitle,
} from "./place-actions.ts";
import { insertAsset } from "./insert-asset.ts";
import { checkModelTool, importModel } from "./model-import.ts";
import { linkedPlace, listPlaces, type ScanCache, usePlace, usePlaceNamed } from "./places.ts";
import { quitStudio, startingNow, systemOpener } from "./studio-launch.ts";
import {
  type LocateDeps,
  locateStudio,
  type StudioInstall,
  studioRunning,
  systemLocateFs,
  systemRun,
} from "./studio-locate.ts";
import { AskFirstTool } from "./studio-tools.ts";
import { RobloxTool } from "./tools.ts";
import { MCP_SWITCH_CLICK_PATH, MESSAGE } from "./words.ts";

/**
 * The Roblox Studio plugin's backend: the "Roblox Studio" toolbar button's word
 * (`toolbar-status`), the panel's status (`status`), and the Studio lock's probe
 * (`studio-activity`). It reads where Studio is, whether Genex set it up (a record in the plugin's
 * own storage) and whether it runs; never the person's Documents folder, which macOS guards with
 * a prompt that only the person's own press may raise. Once Studio is set up it also serves the
 * helper link (`helper-link.ts`), which tells each game's connection which Studio is the game's,
 * and Genex's moments (`studio-moments.ts`): the place saved and loaded around checkpoints and
 * restores, health, the crash note, Team Create notes and the viewport's picture.
 */

export { RobloxAction, RobloxTool };
const ACTION_NAMES: ReadonlySet<string> = new Set(Object.values(RobloxAction));
const isRobloxAction = (name: string): name is RobloxAction => ACTION_NAMES.has(name);

const TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(RobloxTool));
/**
 * The tools that may run in a worker's copy of the game: its folder is never the game's, so the
 * script sync isn't told of it. The ask-first, model and publish tools need no folder but that of a file they read.
 */
const COPY_TOOLS: ReadonlySet<string> = new Set([
  RobloxTool.CheckScripts,
  RobloxTool.LuauNote,
  RobloxTool.LuauFinish,
  ...Object.values(AskFirstTool),
  RobloxTool.CheckModel,
  RobloxTool.ImportModel,
  RobloxTool.PublishUpdate,
]);
const isRobloxTool = (name: string): name is RobloxTool => TOOL_NAMES.has(name);

/** Where Studio stands for Genex, as the toolbar button and the panel name it. Wire values: never rename. */
export const StudioStatus = {
  /** Studio isn't on this computer. */
  Get: "get",
  /** Studio is here, but Genex hasn't added its helper or turned on Studio's MCP server. */
  SetUp: "set-up",
  NotOpen: "not-open",
  /** Studio runs but doesn't answer Genex yet. */
  Starting: "starting",
  Ready: "ready",
} as const;
export type StudioStatus = (typeof StudioStatus)[keyof typeof StudioStatus];

/** The Set up panel's steps, each its own block. Wire values: never rename. */
export const PanelStep = {
  Studio: "studio",
  Helper: "helper",
  Mcp: "mcp",
  Place: "place",
} as const;
export type PanelStep = (typeof PanelStep)[keyof typeof PanelStep];

/** Genex's record of what its setup wrote, in the plugin's own storage: its presence means set up. */
const SETUP_RECORD = path.join("setup", "record.json");
/** Where Get Roblox Studio last stood, in the plugin's own storage. */
const INSTALL_RECORD = path.join("install", "state.json");

/** Why Set up didn't go on, beyond setup's own refusals. Wire values: never rename. */
export const SetupMiss = {
  NotInstalled: "not-installed",
  /** Restart Studio asked Studio to quit, and it was still open at the end of the wait. */
  StillOpen: "still-open",
  /** Restart Studio left Studio open: a build is using it. */
  InUse: "in-use",
} as const;
export type SetupMiss = (typeof SetupMiss)[keyof typeof SetupMiss];

/** What the panel can offer while Studio is open and its MCP switch still has to be turned on. */
const OPEN_STUDIO_CHOICES = [
  { action: RobloxAction.RestartStudio, label: MESSAGE.Choice.RestartStudio },
  { action: RobloxAction.DoItForMe, label: MESSAGE.Choice.DoItForMe },
] as const;

/** The panel's answer to Set up, Undo and Restart Studio: done, or why not and what to do instead. */
export interface SetupAnswer {
  done: boolean;
  message: string;
  reason?: SetupRefusal | SetupMiss;
  /** The actions the panel offers instead; with them, Studio's own click path. */
  choices?: ReadonlyArray<{ action: RobloxAction; label: string }>;
  clickPath?: string;
  setup?: SetupDone;
  removed?: string[];
  kept?: string[];
  /** Restart Studio opened Studio again. */
  reopened?: boolean;
  /** Restart Studio left Studio open: the title of the game whose build uses it. */
  inUse?: string;
}

/** The answer to Do it for me: whether the game's chat took the click, else why not and the click path. */
export interface AssistAnswer {
  started: boolean;
  message: string;
  reason?: PluginEngineAssistRefusal;
  clickPath?: string;
}

/** The computer the backend works on; tests hand in a fake one. */
export interface RobloxDeps extends PlaceActionDeps {
  /** Whether the open Studio answers Genex. */
  answers(): Promise<boolean>;
  /**
   * Whether Genex can click in Studio for the person here (Do it for me, Publish an update); when
   * absent, the host is asked (`game.engine.canAssist`: a desktop with its driver, on a Mac or a PC).
   */
  canClick?(): boolean;
  /** The shipped Genex helper file. */
  helper: string;
  /** The network, the programs and the temporary folder Get Roblox Studio uses. */
  install: Pick<InstallDeps, "fetch" | "run" | "tempRoot">;
  /**
   * Starts the helper link in the plugin's storage, once however often it is called. It is called
   * only once Genex has set Studio up: before that no helper exists to connect.
   */
  helperLink?(storage: string): void;
  /** The helper link and the script sync, for Genex's moments; without them no helper is ever connected. */
  moments?: MomentServices;
  /** Makes a play shot over 1 MB smaller; this computer's own by default. */
  shrink?: ShrinkShot;
  /** A judge probe's Luau file; by default read beside this backend, in the plugin's package. */
  probeLuau?(file: ProbeLuauFile): Promise<string>;
  /** The Luau checks' runner, network and unpacker; this computer's by default. */
  luau?: LuauDeps;
}

/** The folder the backend runs from: the plugin's package once built. */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** A judge probe's Luau, read from the package beside the backend. */
const packageLuau = (file: ProbeLuauFile) => readFile(path.join(PACKAGE_DIR, file), "utf8");

/** Get Roblox Studio as the panel shows it: where it stands, in plain words, and why it stopped. */
export interface InstallStatus {
  phase: InstallPhase;
  message: string;
  reason?: InstallRefusal;
}

/** Get Roblox Studio under way or last finished in this backend, with the person's Stop. */
interface InstallJob extends InstallStatus {
  controller: AbortController;
  /** The record's writes, one after another, so an earlier phase never lands over a later one. */
  writes: Promise<void>;
}

/** The answer to Get Roblox Studio and its Stop. */
export interface GetStudioAnswer {
  started: boolean;
  message: string;
}

const isFinished = (job: InstallJob | undefined) =>
  !job || job.phase === InstallPhase.Done || job.phase === InstallPhase.Failed;

/** What the status is made of. */
export interface StudioFacts {
  installed: boolean;
  setUp: boolean;
  running: boolean;
  answering: boolean;
}

/** Studio's MCP switch in its settings: how many accounts' settings files there are, and how many have it on. */
export interface McpSwitchState {
  settings: number;
  on: number;
}

/** The panel's answer to `status`. */
export interface RobloxStatus {
  studio: StudioStatus;
  version?: string;
  steps: Record<PanelStep, boolean>;
  /** Get Roblox Studio, while it runs and after it has finished. */
  install?: InstallStatus;
  /** Studio's MCP switch, read from its settings (never Documents); absent when they can't be read. */
  mcp?: McpSwitchState;
  /** The helper Genex's record says it added. */
  helper?: { version: number; current: boolean };
  /** The panel's rows: the chat's steps card's, with the panel's extras on the step that is next. */
  rows: RobloxRow[];
  /** The step that is next; absent once every step is done. */
  now?: RobloxStepId;
  /** The Luau checks: all here, or Add Luau checks offered. */
  luau?: LuauStatus;
  /**
   * The game's place, once linked: whether Roblox has it published (Publish an update), whether Genex
   * can click Publish here, and for a place never published the name its first publish would use.
   */
  publish?: { published: boolean; canClick: boolean; name?: string };
}

/**
 * Where Studio stands: missing first, then setup, then whether it runs, then whether it answers.
 * An answer counts only while Studio runs: without it, whatever answers is not this Studio.
 */
export function studioStatusOf(facts: StudioFacts): StudioStatus {
  if (!facts.installed) return StudioStatus.Get;
  if (!facts.setUp) return StudioStatus.SetUp;
  if (!facts.running) return StudioStatus.NotOpen;
  return facts.answering ? StudioStatus.Ready : StudioStatus.Starting;
}

/** Each status as the toolbar shows it: a dot in its tone, its word leading the tooltip. */
const BADGE = {
  [StudioStatus.Get]: { badge: MESSAGE.Badge.Get, tone: "info", dot: true },
  [StudioStatus.SetUp]: { badge: MESSAGE.Badge.SetUp, tone: "warn", dot: true },
  [StudioStatus.NotOpen]: { badge: MESSAGE.Badge.NotOpen, tone: "info", dot: true },
  [StudioStatus.Starting]: { badge: MESSAGE.Badge.Starting, tone: "warn", dot: true },
  [StudioStatus.Ready]: { badge: MESSAGE.Badge.Ready, tone: "ok", dot: true },
} as const satisfies Record<StudioStatus, PluginToolbarStatus>;

function titleOf(status: StudioStatus, install: StudioInstall | undefined): string {
  if (status === StudioStatus.Get) return MESSAGE.Title.Get;
  if (status === StudioStatus.SetUp) return MESSAGE.Title.SetUp;
  if (status === StudioStatus.NotOpen) return MESSAGE.Title.NotOpen(install?.version);
  return status === StudioStatus.Starting ? MESSAGE.Title.Starting : MESSAGE.Title.Ready;
}

/** The toolbar button's word, dot and title for a status. */
export function toolbarStatusOf(status: StudioStatus, install?: StudioInstall): PluginToolbarStatus {
  return { ...BADGE[status], title: titleOf(status, install) };
}

/** Whether Genex's setup record is a plain file in the plugin's storage. */
async function setUpIn(deps: RobloxDeps, storage: string): Promise<boolean> {
  const stat = await deps.fs.lstat(path.join(storage, SETUP_RECORD));
  return Boolean(stat?.file && !stat.link);
}

/** Whether Genex can click in Studio here: the test's word, else the host's (never when it can't say). */
async function canClickHere(deps: RobloxDeps, context: PluginContext): Promise<boolean> {
  if (deps.canClick) return deps.canClick();
  return context.host(PluginService.GameEngineCanAssist).catch(() => false);
}

/** What is known of Studio now, asking each thing only when the one before it holds. */
async function readStudio(deps: RobloxDeps, context: PluginContext) {
  const location = await locateStudio(deps);
  const install = location.installed ? location.install : undefined;
  const facts: StudioFacts = { installed: location.installed, setUp: false, running: false, answering: false };
  if (!install) return { install, facts };
  const storage = await context.host(PluginService.StorageRoot);
  facts.setUp = await setUpIn(deps, storage);
  if (!facts.setUp) return { install, facts, storage };
  deps.helperLink?.(storage);
  // Studio Genex just opened counts as running (Starting) before its process is seen.
  facts.running = (await studioRunning(deps)) || (await startingNow(storage, deps.now()));
  facts.answering = facts.running && (await deps.answers());
  return { install, facts, storage };
}

/** What the panel shows of a Get Roblox Studio job. */
const installStatusOf = (job: InstallJob): InstallStatus => {
  const answer: InstallStatus = { phase: job.phase, message: job.message };
  if (job.reason) answer.reason = job.reason;
  return answer;
};

/** The link of the game this call is bound to, or null when it builds in no Roblox place. */
async function linkHere(context: PluginContext): Promise<PluginEngineLink | null> {
  if (!context.project) return null;
  return context.host(PluginService.GameEngineRead).catch(() => null);
}

/** Studio's MCP switch across the accounts' settings files; undefined when they can't be read. */
async function mcpSwitch(deps: RobloxDeps): Promise<McpSwitchState | undefined> {
  try {
    const plan = await planSwitches(setupPaths(deps.platform, deps.env, deps.home).settings);
    return { settings: plan.files, on: plan.alreadyOn };
  } catch {
    return undefined;
  }
}

/** What the place step adds beyond the rows: whether Roblox has the place, and a first publish's name. */
interface PublishFacts {
  published?: boolean;
  firstName?: string;
}

/**
 * What the game's place adds to the rows: its name, the person's own Rojo project, and live saved
 * data; and for publishing, whether Roblox has it, else the name its first publish would use.
 */
async function placeFacts(
  context: PluginContext,
  storage: string | undefined,
): Promise<Pick<RobloxStepFacts, "linked" | "place" | "rojo" | "liveData"> & PublishFacts> {
  const link = await linkHere(context);
  if (!link || !storage || !context.project) return { linked: Boolean(link) };
  const game = { project: context.project, ...(context.directory ? { directory: context.directory } : {}) };
  const place = await linkedPlace(storage, game, link);
  const live = await readLiveData(storage, context.project);
  const facts = { linked: true, place: place.name, rojo: place.rojo, liveData: live?.reachable === true };
  if (link.remote) return { ...facts, published: true };
  const title = context.directory ? await gameTitle(context.directory, context.project) : undefined;
  const firstName = firstPublishName({ link, name: place.name, ...(title ? { title } : {}) });
  return { ...facts, published: false, firstName };
}

/** Where Get Roblox Studio stands, as the rows read it: under way, or stopped and why. */
function installFacts(job: InstallJob | undefined): Pick<RobloxStepFacts, "getting" | "failed"> {
  if (!job) return {};
  if (!isFinished(job)) return { getting: { detail: job.message } };
  return job.phase === InstallPhase.Failed ? { failed: { detail: job.message } } : {};
}

/**
 * Everything the rows are read from, now. Unlike the toolbar, the rows ask whether Studio runs
 * before setup too: Set up waits for Studio to close, and Open Studio is offered only while it is.
 */
async function stepFacts(deps: RobloxDeps, context: PluginContext, job: InstallJob | undefined) {
  const { install, facts, storage } = await readStudio(deps, context);
  const running = facts.running || (facts.installed && (await studioRunning(deps)));
  const mcp = facts.installed ? await mcpSwitch(deps) : undefined;
  const helper = facts.setUp && storage ? await recordedHelper(storage, deps.helper) : undefined;
  const { published, firstName, ...place } = await placeFacts(context, storage);
  const rows: RobloxStepFacts = {
    ...facts,
    running,
    ...(install?.version ? { version: install.version } : {}),
    ...installFacts(job),
    ...place,
    mac: deps.platform === "darwin",
    canClick: await canClickHere(deps, context),
    ...(mcp ? { mcpOn: mcp.on > 0 } : {}),
  };
  return { install, facts, rows, mcp, helper, published, firstName };
}

async function status(
  deps: RobloxDeps,
  context: PluginContext,
  job: InstallJob | undefined,
  luau: LuauDeps,
): Promise<RobloxStatus> {
  const { install, facts, rows, mcp, helper, published, firstName } = await stepFacts(deps, context, job);
  const steps = {
    [PanelStep.Studio]: facts.installed,
    [PanelStep.Helper]: facts.setUp,
    [PanelStep.Mcp]: facts.answering,
    [PanelStep.Place]: rows.linked,
  };
  const answer: RobloxStatus = { studio: studioStatusOf(facts), steps, rows: robloxRows(rows) };
  if (install?.version) answer.version = install.version;
  if (job) answer.install = installStatusOf(job);
  if (mcp) answer.mcp = mcp;
  if (helper) answer.helper = helper;
  if (published !== undefined)
    answer.publish = { published, canClick: rows.canClick === true, ...(firstName ? { name: firstName } : {}) };
  answer.luau = await luauStatus(deps, luau, context).catch(() => ({ added: false, offered: false }));
  const now = nowStep(rows);
  if (now) answer.now = now;
  return answer;
}

/** The steps card, read now: the panel's rows, so a Studio already here is ticked with its version. */
async function steps(deps: RobloxDeps, context: PluginContext, job: InstallJob | undefined): Promise<RobloxSteps> {
  return robloxSteps((await stepFacts(deps, context, job)).rows);
}

async function toolbarStatus(deps: RobloxDeps, context: PluginContext): Promise<PluginToolbarStatus> {
  const { install, facts } = await readStudio(deps, context);
  return toolbarStatusOf(studioStatusOf(facts), install);
}

function setupOptionsIn(deps: RobloxDeps, storage: string): SetupOptions {
  return {
    paths: setupPaths(deps.platform, deps.env, deps.home),
    helper: deps.helper,
    storage,
    running: () => studioRunning(deps),
    now: deps.now,
  };
}

async function setupOptions(deps: RobloxDeps, context: PluginContext): Promise<SetupOptions> {
  return setupOptionsIn(deps, await context.host(PluginService.StorageRoot));
}

/** A refusal as the panel shows it; Studio being open comes with what to do instead. */
function refusedAnswer(error: unknown): SetupAnswer {
  if (!(error instanceof RobloxSetupError)) throw error;
  const answer: SetupAnswer = { done: false, reason: error.code, message: error.message };
  if (error.code !== SetupRefusal.StudioRunning) return answer;
  return { ...answer, choices: OPEN_STUDIO_CHOICES, clickPath: MCP_SWITCH_CLICK_PATH };
}

function setupDoneAnswer(setup: SetupDone): SetupAnswer {
  if (setup.switches.files === 0)
    return {
      done: true,
      setup,
      message: MESSAGE.Setup.DoneNoSettings,
      choices: OPEN_STUDIO_CHOICES.filter((choice) => choice.action === RobloxAction.DoItForMe),
      clickPath: MCP_SWITCH_CLICK_PATH,
    };
  const newer = setup.helper === HelperChange.Kept && setup.switches.turnedOn === 0;
  return { done: true, setup, message: newer ? MESSAGE.Setup.NewerHelper : MESSAGE.Setup.Done };
}

/** Runs Set up, answering its refusals in plain words. Studio is checked first: nothing is read while it runs. */
async function runSetupWith(options: SetupOptions): Promise<SetupAnswer> {
  try {
    return setupDoneAnswer(await setUp(options));
  } catch (error) {
    return refusedAnswer(error);
  }
}

async function runSetup(deps: RobloxDeps, context: PluginContext): Promise<SetupAnswer> {
  return runSetupWith(await setupOptions(deps, context));
}

async function setupAction(deps: RobloxDeps, context: PluginContext): Promise<SetupAnswer> {
  const location = await locateStudio(deps);
  if (!location.installed) return { done: false, reason: SetupMiss.NotInstalled, message: MESSAGE.Setup.NotInstalled };
  return runSetup(deps, context);
}

async function undoAction(deps: RobloxDeps, context: PluginContext): Promise<SetupAnswer> {
  try {
    const { removed, kept } = await undoSetup(await setupOptions(deps, context));
    const message = kept.length > 0 ? MESSAGE.Setup.UndoneKept(kept.length) : MESSAGE.Setup.Undone;
    return { done: true, message, removed, kept };
  } catch (error) {
    return refusedAnswer(error);
  }
}

/** The title of a game whose run is using Studio now, if one is. */
async function buildUsingStudio(context: PluginContext): Promise<string | undefined> {
  const runs = await context.host(PluginService.GameEngineRuns).catch(() => []);
  const busy = Array.isArray(runs) ? runs.find((run) => typeof run?.title === "string") : undefined;
  return busy?.title;
}

/**
 * Restart Studio: a normal quit (Studio asks the person to save, as it always does), Set up while
 * it is closed, then Studio opened again, whatever Set up answered: Genex closed it. Never while a
 * build uses Studio, as Quit Studio.
 */
async function restartStudio(deps: RobloxDeps, context: PluginContext): Promise<SetupAnswer> {
  const location = await locateStudio(deps);
  if (!location.installed) return { done: false, reason: SetupMiss.NotInstalled, message: MESSAGE.Setup.NotInstalled };
  const inUse = await buildUsingStudio(context);
  if (inUse) return { done: false, reason: SetupMiss.InUse, message: MESSAGE.Quit.InUse(inUse), inUse };
  if (!(await quitStudio(deps))) return { done: false, reason: SetupMiss.StillOpen, message: MESSAGE.Setup.StillOpen };
  const answer = await runSetup(deps, context);
  // The game's own place, when it has one: Studio on its start page has no MCP server to answer.
  await openStudio(deps, context);
  return { ...answer, reopened: true, message: `${answer.message} ${MESSAGE.Setup.Reopened}` };
}

const ASSIST_WORDS: Partial<Record<PluginEngineAssistRefusal, string>> = {
  unavailable: MESSAGE.Assist.Unavailable,
  declined: MESSAGE.Assist.Declined,
  "no-chat": MESSAGE.Assist.NoChat,
};

/**
 * Do it for me: setup clicks only. Genex's own computer control, in this game's chat, clicks
 * Studio's MCP switch the person asked for; it never builds or play-tests. Where it can't (Windows,
 * no driver, no game open, the person said no), the answer carries Studio's own click path.
 */
async function doItForMe(context: PluginContext): Promise<AssistAnswer> {
  const answer = await context.host(PluginService.GameEngineAssist, { task: MESSAGE.Assist.Task });
  if (answer.started) return { started: true, message: MESSAGE.Assist.Started };
  const message = (answer.reason && ASSIST_WORDS[answer.reason]) || MESSAGE.Assist.NotStarted;
  const refused: AssistAnswer = { started: false, message, clickPath: MCP_SWITCH_CLICK_PATH };
  if (answer.reason) refused.reason = answer.reason;
  return refused;
}

/** Writes where Get Roblox Studio stands into storage, after any earlier write, so the record keeps the newest. */
function writePhase(job: InstallJob, storage: string, phase: InstallPhase, now: number): Promise<void> {
  const record: Record<string, unknown> = { phase, at: new Date(now).toISOString() };
  if (job.reason) record.reason = job.reason;
  const write = () => atomicWriteJson(path.join(storage, INSTALL_RECORD), record).catch(() => undefined);
  job.writes = job.writes.then(write);
  return job.writes;
}

/** A step on the way: the panel sees it at once, the record follows. */
function notePhase(job: InstallJob, storage: string, phase: InstallPhase, now: number): void {
  job.phase = phase;
  job.message = MESSAGE.Install.Phase[phase];
  void writePhase(job, storage, phase, now);
}

/** The end: recorded first, then shown, so whoever sees it finished finds the record finished too. */
async function finish(job: InstallJob, storage: string, end: { phase: InstallPhase; message: string; now: number }) {
  await writePhase(job, storage, end.phase, end.now);
  job.message = end.message;
  job.phase = end.phase;
}

/**
 * Get Roblox Studio, start to end: Roblox's installer downloaded, checked and run; Studio waited
 * for; the person's sign-in in the installer's Studio; Set up while that Studio is closed; Studio
 * opened again once.
 */
async function getStudioJob(deps: RobloxDeps, job: InstallJob, storage: string): Promise<void> {
  const signal = job.controller.signal;
  const onPhase = (phase: InstallPhase) => notePhase(job, storage, phase, deps.now());
  try {
    await installStudio({ ...deps.install, platform: deps.platform, env: deps.env }, { signal, onPhase });
    const setUpStep = async () => (await runSetupWith(setupOptionsIn(deps, storage))).message;
    const done = await afterInstall({ ...deps, setUp: setUpStep }, { signal, onPhase });
    await finish(job, storage, { phase: InstallPhase.Done, message: done.message, now: deps.now() });
  } catch (error) {
    if (error instanceof InstallError) job.reason = error.code;
    const message = error instanceof InstallError ? error.message : MESSAGE.Install.Phase.failed;
    await finish(job, storage, { phase: InstallPhase.Failed, message, now: deps.now() });
  }
}

/** The one Get Roblox Studio this backend runs at a time. */
interface InstallSlot {
  job?: InstallJob;
}

/**
 * Get Roblox Studio: starts the install and answers at once, so the panel follows it through
 * `status`. A Studio already here, or an install already going, is answered in words, not run.
 */
async function getStudio(deps: RobloxDeps, context: PluginContext, slot: InstallSlot): Promise<GetStudioAnswer> {
  if (!isFinished(slot.job)) return { started: false, message: MESSAGE.Install.AlreadyGetting };
  const location = await locateStudio(deps);
  if (location.installed)
    return { started: false, message: MESSAGE.Install.AlreadyInstalled(location.install.version) };
  if (!(deps.platform in INSTALLER)) return { started: false, message: MESSAGE.Install.Refused.unsupported };
  const storage = await context.host(PluginService.StorageRoot);
  const job: InstallJob = {
    phase: InstallPhase.Downloading,
    message: MESSAGE.Install.Phase.downloading,
    controller: new AbortController(),
    writes: Promise.resolve(),
  };
  slot.job = job;
  void getStudioJob(deps, job, storage);
  return { started: true, message: MESSAGE.Install.Started };
}

/** Stop: ends the download or the wait under way. Roblox's installer, once running, finishes on its own. */
function cancelGetStudio(slot: InstallSlot): GetStudioAnswer {
  const job = slot.job;
  if (!job || isFinished(job)) return { started: false, message: MESSAGE.Install.NothingToStop };
  job.controller.abort();
  return { started: false, message: MESSAGE.Install.Stopped };
}

/** Get Roblox Studio's confirmation: this computer's download, where it comes from, and the sign-in. */
function reviewGetStudio(deps: RobloxDeps): PluginReview {
  if (!(deps.platform in INSTALLER)) return {};
  const installer = INSTALLER[deps.platform as keyof typeof INSTALLER];
  return { message: MESSAGE.Install.Confirm(installer.megabytes), detail: MESSAGE.Install.Plan(ALLOWED_HOST) };
}

/**
 * Set up's confirmation: what it will do on this computer, read from Studio's settings folder only.
 * It never reads Documents: macOS would ask the person before they have confirmed.
 */
async function reviewSetup(deps: RobloxDeps): Promise<PluginReview> {
  try {
    const paths = setupPaths(deps.platform, deps.env, deps.home);
    const settings = (await readSwitches(paths.settings)).length;
    const detail = planSetup({ platform: deps.platform, paths, settings }).join("\n");
    return { message: MESSAGE.Setup.Confirm, detail };
  } catch {
    return {};
  }
}

type Handler = (args: Record<string, unknown>, context: PluginContext) => Promise<unknown>;

/** Hands the script sync the folder of the game a call is for; a call with none is left alone. */
async function noteGame(deps: RobloxDeps, context: PluginContext): Promise<void> {
  if (!deps.gameSeen || !context.project || !context.directory) return;
  const storage = await context.host(PluginService.StorageRoot);
  await deps.gameSeen(storage, context.project, context.directory);
}

/** A moment's handler over the bound game's Studio operations and the moment it runs at. */
type MomentHandler = (ops: MomentOps, hook: HookContext) => Promise<HookAnswer>;

/**
 * The Studio operations of the game a call is bound to; the helper link starts once Studio is set up.
 * A publish that has just finished is linked first, so the moment finds the game's Studio.
 */
async function momentOps(deps: RobloxDeps, services: MomentServices, context: PluginContext): Promise<MomentOps> {
  await relinkQuietly(deps, services, context);
  const storage = await context.host(PluginService.StorageRoot);
  const setUp = async () => {
    const done = (await locateStudio(deps)).installed && (await setUpIn(deps, storage));
    if (done) deps.helperLink?.(storage);
    return done;
  };
  await setUp();
  return momentOpsFor(deps, services, context, { storage, setUp });
}

/** Starts the helper link for a game that isn't bound yet, once Studio is set up: bound means it already runs. */
async function linkFor(deps: RobloxDeps, services: MomentServices, storage: string, game: string): Promise<void> {
  if (services.bound(game) !== undefined) return;
  if ((await locateStudio(deps)).installed && (await setUpIn(deps, storage))) deps.helperLink?.(storage);
}

/**
 * The game an ask-first tool's call is for: its Studio as the helper link has it bound, the folder
 * a picture is read from, the plugin's storage and the agent's marks.
 */
async function askFirstGame(deps: RobloxDeps, services: MomentServices, context: PluginContext): Promise<AskFirstGame> {
  const storage = await context.host(PluginService.StorageRoot);
  const game = context.project ?? "";
  await linkFor(deps, services, storage, game);
  const marks = agentFolder(storage, game);
  return {
    studio: () => services.bound(game),
    storage,
    ...(context.directory ? { folder: context.directory } : {}),
    ...(marks ? { marks } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  };
}

/** Roblox's AI tools, uploads and the Creator Store insert, each over the game its call is for. */
function askFirstHandlers(deps: RobloxDeps, services: MomentServices) {
  const own = { ...(deps.studio ? { studio: deps.studio } : {}), now: deps.now };
  const ai = createAiTools(own);
  const over =
    (tool: AiTool): Handler =>
    async (args, context) =>
      ai[tool](args, await askFirstGame(deps, services, context));
  return {
    [RobloxTool.GenerateMesh]: over(AskFirstTool.GenerateMesh),
    [RobloxTool.GenerateModel]: over(AskFirstTool.GenerateModel),
    [RobloxTool.GenerateTexture]: over(AskFirstTool.GenerateTexture),
    [RobloxTool.GenerateMaterial]: over(AskFirstTool.GenerateMaterial),
    [RobloxTool.SegmentMesh]: over(AskFirstTool.SegmentMesh),
    [RobloxTool.RobloxPlaytest]: over(AskFirstTool.RobloxPlaytest),
    [RobloxTool.RobloxExplore]: over(AskFirstTool.RobloxExplore),
    [RobloxTool.UploadImage]: over(AskFirstTool.UploadImage),
    [RobloxTool.StoreImage]: over(AskFirstTool.StoreImage),
    [RobloxTool.InsertAsset]: async (args, context) =>
      insertAsset(own, args, await askFirstGame(deps, services, context)),
  } as const satisfies Partial<Record<RobloxTool, Handler>>;
}

/** The asset gate's check, and the import of a model that passes into the game's own Studio. */
function modelHandlers(deps: RobloxDeps, services: MomentServices) {
  return {
    [RobloxTool.CheckModel]: async (args, context) => checkModelTool(args, context.directory),
    [RobloxTool.ImportModel]: async (args, context) => {
      const storage = await context.host(PluginService.StorageRoot);
      const game = context.project ?? "";
      await linkFor(deps, services, storage, game);
      const marks = agentFolder(storage, game);
      return importModel({ now: deps.now }, args, {
        ask: services.ask(game),
        bound: () => services.bound(game),
        ...(context.directory ? { folder: context.directory } : {}),
        ...(marks ? { marks } : {}),
      });
    },
  } as const satisfies Partial<Record<RobloxTool, Handler>>;
}

/**
 * The game a play tool's call is for: its Studio as the helper link has it bound, the helper and the
 * agent's marks. The helper link starts once Studio is set up, as for the moments, when the game
 * isn't bound yet.
 */
async function playGame(deps: RobloxDeps, services: MomentServices, context: PluginContext): Promise<PlayGame> {
  const storage = await context.host(PluginService.StorageRoot);
  const game = context.project ?? "";
  await linkFor(deps, services, storage, game);
  const marks = agentFolder(storage, game);
  return {
    storage,
    game,
    edit: () => services.bound(game),
    ask: services.ask(game),
    signal: context.signal,
    flush: () => services.flush(game, FLUSH_MAX_MS),
    ...(marks ? { marks } : {}),
  };
}

/** The play tools and the judges' probes, each over the game its call is for. */
function playHandlers(deps: RobloxDeps, services: MomentServices) {
  const shrink = deps.shrink ?? systemShrink(deps.platform, deps.env);
  const studio = deps.studio ? { studio: deps.studio } : {};
  const computer = createComputerPlay({ ...studio, shrink, now: deps.now, sleep: deps.sleep });
  // The judges' probes measure the play the play tools hold for the game.
  const probes = createProbes(
    { ...studio, shrink, now: deps.now, luau: deps.probeLuau ?? packageLuau },
    computer.playing,
  );
  const playing =
    (tool: EnginePlayTool): Handler =>
    async (args, context) =>
      computer.handlers[tool](args, await playGame(deps, services, context));
  const probing =
    (probe: RobloxProbe): Handler =>
    async (args, context) =>
      probes[probe](args, await playGame(deps, services, context));
  return {
    [RobloxTool.PlayOpen]: playing(EnginePlayTool.Open),
    [RobloxTool.PlayInput]: playing(EnginePlayTool.Input),
    [RobloxTool.PlayShot]: playing(EnginePlayTool.Shot),
    [RobloxTool.PlayState]: playing(EnginePlayTool.State),
    [RobloxTool.PlayPause]: playing(EnginePlayTool.Pause),
    [RobloxTool.PlayClose]: playing(EnginePlayTool.Close),
    [RobloxTool.PlayersState]: probing(RobloxProbe.PlayersState),
    [RobloxTool.CheatRemotes]: probing(RobloxProbe.CheatRemotes),
    [RobloxTool.PhoneCheck]: probing(RobloxProbe.PhoneCheck),
  } as const satisfies Partial<Record<RobloxTool, Handler>>;
}

/** The game's place as publishing sees it: its link, its name as the panel shows it, and the game's title. */
async function publishPlace(context: PluginContext): Promise<PublishPlace> {
  const link = await linkHere(context);
  if (!link || !context.project) return { link };
  const storage = await context.host(PluginService.StorageRoot);
  const game = { project: context.project, ...(context.directory ? { directory: context.directory } : {}) };
  const title = context.directory ? await gameTitle(context.directory, context.project) : undefined;
  return { link, name: (await linkedPlace(storage, game, link)).name, ...(title ? { title } : {}) };
}

/** A call's requested name for a first publish, when it gave one as text. */
const requestedName = (args: Record<string, unknown>) => (typeof args.name === "string" ? args.name : undefined);

/** What publishing asks of the host and of the game's helper, for the game a call is bound to. */
function publishDeps(deps: RobloxDeps, services: MomentServices, context: PluginContext, place: PublishPlace) {
  const game = context.project ?? "";
  const answer: PublishDeps = {
    assist: (task) => context.host(PluginService.GameEngineAssist, { task }),
    flush: () => services.flush(game),
  };
  const project = place.link?.project;
  if (!project) return answer;
  const noted = (name: string) => noteFirstPublish(deps, services, context, project, name);
  return { ...answer, noted };
}

/**
 * Notes a first publish of the game a call is bound to under `name`, from the Studio holding the
 * game; with no Studio holding it there is nothing to publish from, and nothing is noted.
 */
async function noteFirstPublish(
  deps: RobloxDeps,
  services: MomentServices,
  context: PluginContext,
  project: string,
  name: string,
): Promise<void> {
  const game = context.project ?? "";
  const storage = await context.host(PluginService.StorageRoot);
  const studioId = await studioHolding(deps, storage, game, services.bound(game));
  if (studioId) await notePublish(deps, storage, game, { at: deps.now(), project, name, studioId });
}

/**
 * Where Genex can't click, the panel shows the person Studio's own clicks for a first publish: noted
 * under the name it shows, once for the Studio holding the game, so the game is linked to the place
 * they publish by hand there. With no Studio holding the game, nothing is noted.
 */
async function noteHandPublish(deps: RobloxDeps, services: MomentServices, context: PluginContext, name: string) {
  const link = await linkHere(context);
  if (!link || link.remote || !context.project) return;
  const game = context.project;
  const storage = await context.host(PluginService.StorageRoot);
  const studioId = await studioHolding(deps, storage, game, services.bound(game));
  if (!studioId || (await notedFrom(storage, game, link.project, studioId))) return;
  await notePublish(deps, storage, game, { at: deps.now(), project: link.project, name, studioId });
}

/** What relinking asks of the computer and of the helper link. */
const relinkDeps = (deps: RobloxDeps, services: MomentServices): RelinkDeps => ({
  ...deps,
  bound: (game) => services.bound(game),
});

/** Links the game to the place Roblox has now after a publish; a look that fails links nothing. */
async function relinkQuietly(deps: RobloxDeps, services: MomentServices, context: PluginContext, askBound = false) {
  if (!context.project) return;
  await relinkPublished(relinkDeps(deps, services), context, { askBound }).catch(() => undefined);
}

/**
 * Publish an update, as the panel's action or the agent's confirmed tool: the game's chat is handed
 * the task through Do it for me, after the game's changed script files reach Studio.
 */
function publishHandler(deps: RobloxDeps, services: MomentServices, asker: PublishAsker): Handler {
  return async (_args, context) => {
    // A place just published by hand is linked first, so it gets its update and not a first publish.
    await relinkQuietly(deps, services, context, true);
    const place = await publishPlace(context);
    return publishUpdate(place, publishDeps(deps, services, context, place), asker);
  };
}

/**
 * A first publish, as the panel's Publish to Roblox or the agent's confirmed `first-publish`, under
 * the name asked for. A place Roblox already has (published by hand) is linked first, and answered
 * as one to update.
 */
function firstPublishHandler(deps: RobloxDeps, services: MomentServices, asker: PublishAsker): Handler {
  return async (args, context) => {
    await relinkQuietly(deps, services, context, true);
    const place = await publishPlace(context);
    const requested = requestedName(args);
    // The agent's card showed its name: a name Roblox would take otherwise is asked again, never changed.
    const unfit = asker === PublishAsker.Agent ? unfitName(place, requested) : undefined;
    return unfit ?? firstPublish(place, publishDeps(deps, services, context, place), asker, requested);
  };
}

/** Do it for me's refusals in the agent's words; any other is "nothing was clicked". */
const ASSIST_PROMPTS: Partial<Record<PluginEngineAssistRefusal, string>> = {
  unavailable: SETUP_PROMPTS.AssistUnavailable,
  declined: SETUP_PROMPTS.AssistDeclined,
  "no-chat": SETUP_PROMPTS.AssistNoChat,
  "in-assist": SETUP_PROMPTS.InAssist,
};

/** Why Do it for me has nothing to click now, in the agent's words; undefined when the switch is to click. */
async function nothingToClick(deps: RobloxDeps, context: PluginContext): Promise<string | undefined> {
  const { facts } = await readStudio(deps, context);
  if (!facts.installed) return SETUP_PROMPTS.NotInstalled;
  const running = facts.running || (await studioRunning(deps));
  if (!facts.setUp) return running ? SETUP_PROMPTS.NotSetUp : SETUP_PROMPTS.NotSetUpClosed;
  if (!running) return SETUP_PROMPTS.NotOpen;
  if (facts.answering) return SETUP_PROMPTS.Answering;
  const mcp = await mcpSwitch(deps);
  return mcp && mcp.on > 0 ? SETUP_PROMPTS.SwitchAlreadyOn : undefined;
}

/**
 * The agent's `do-it-for-me`: Studio's MCP switch clicked by this game's chat with computer control,
 * started by the agent itself when Studio is open and the switch is all that's missing; otherwise the
 * tool that does the step that is.
 */
async function doItForMeTool(deps: RobloxDeps, context: PluginContext): Promise<string> {
  const blocked = await nothingToClick(deps, context);
  if (blocked) return blocked;
  const answer = await doItForMe(context);
  if (answer.started) return SETUP_PROMPTS.AssistStarted;
  return (answer.reason && ASSIST_PROMPTS[answer.reason]) || SETUP_PROMPTS.AssistNotStarted;
}

/**
 * Set up's answer in the agent's words: done, or the tool that does the step in the way. With no
 * settings file to switch on, Do it for me clicks it where Genex can click; elsewhere that one click
 * is the person's.
 */
function setupWords(answer: SetupAnswer, canClick: boolean): string {
  if (answer.reason === SetupMiss.NotInstalled) return SETUP_PROMPTS.NotInstalled;
  if (answer.reason === SetupMiss.StillOpen) return SETUP_PROMPTS.StillOpen;
  if (answer.reason === SetupMiss.InUse) return SETUP_PROMPTS.QuitInUse(answer.inUse ?? "");
  if (answer.reason === SetupRefusal.StudioRunning) return SETUP_PROMPTS.SetupStudioOpen;
  if (answer.reason === SetupRefusal.NoRobloxFolder) return SETUP_PROMPTS.NoRobloxFolder;
  if (!answer.done) return SETUP_PROMPTS.SetupStopped(answer.message);
  if (answer.setup?.switches.files === 0)
    return canClick ? SETUP_PROMPTS.SetupNoSettings : SETUP_PROMPTS.SetupNoSettingsNoClick;
  return SETUP_PROMPTS.SetupDone(answer.message);
}

/** Quit Studio's answer in the agent's words. */
function quitWords(answer: QuitAnswer): string {
  if (answer.quit) return SETUP_PROMPTS.Quit;
  if (answer.reason === QuitMiss.StillOpen) return SETUP_PROMPTS.StillOpen;
  if (answer.reason === QuitMiss.InUse) return SETUP_PROMPTS.QuitInUse(answer.inUse ?? "");
  return SETUP_PROMPTS.QuitNotRunning;
}

/** Runs `then` once Studio is on this computer; otherwise the agent is told to get it. */
async function installedThen(deps: RobloxDeps, then: () => Promise<string>): Promise<string> {
  return (await locateStudio(deps)).installed ? then() : SETUP_PROMPTS.NotInstalled;
}

/**
 * The panel's presses as the agent's tools, each answered in words for the agent: setup is its job,
 * so the words name the next tool to call, never a click for the person.
 */
function pressHandlers(deps: RobloxDeps, slot: InstallSlot, luau: LuauDeps) {
  return {
    [RobloxTool.DoItForMe]: (_args, context) => doItForMeTool(deps, context),
    [RobloxTool.Setup]: async (_args, context) =>
      setupWords(await setupAction(deps, context), await canClickHere(deps, context)),
    [RobloxTool.RestartStudio]: async (_args, context) => {
      const answer = await restartStudio(deps, context);
      const words = setupWords(answer, await canClickHere(deps, context));
      return answer.reopened ? SETUP_PROMPTS.Restarted(words) : words;
    },
    [RobloxTool.UndoSetup]: async (_args, context) => (await undoAction(deps, context)).message,
    [RobloxTool.OpenStudio]: (_args, context) =>
      installedThen(deps, async () => SETUP_PROMPTS.Opened((await openStudio(deps, context)).message)),
    [RobloxTool.QuitStudio]: async (_args, context) => quitWords(await quitStudioAction(deps, context)),
    [RobloxTool.GetStudio]: async (_args, context) => {
      const answer = await getStudio(deps, context, slot);
      return answer.started ? SETUP_PROMPTS.Getting : SETUP_PROMPTS.Words(answer.message);
    },
    [RobloxTool.CancelGetStudio]: async () => cancelGetStudio(slot).message,
    [RobloxTool.Places]: async (_args, context) => ({
      ...(await listPlaces(deps, context)),
      note: SETUP_PROMPTS.PlacesNote,
    }),
    [RobloxTool.AddLuauChecks]: async (_args, context) => {
      const answer = await addLuauAction(deps, luau, context);
      return answer.added ? SETUP_PROMPTS.LuauAdded(answer.message) : answer.message;
    },
  } as const satisfies Partial<Record<RobloxTool, Handler>>;
}

/** The backend over the computer it is given; tests hand in fakes. */
export function createRobloxBackend(deps: RobloxDeps): PluginActivation {
  const slot: InstallSlot = {};
  const scan: ScanCache = {};
  const services = deps.moments ?? noMomentServices(deps.now);
  const luau = deps.luau ?? systemLuau(deps.install.fetch, deps.install.run);
  // A moment's tool answers only at its moments: called any other way, it says nothing.
  const atMoment =
    (handler: MomentHandler): Handler =>
    async (_args, context) =>
      context.hook ? handler(await momentOps(deps, services, context), context.hook) : {};
  const actions: Record<RobloxAction, Handler> = {
    [RobloxAction.Status]: async (_args, context) => {
      await relinkQuietly(deps, services, context);
      const answer = await status(deps, context, slot.job, luau);
      const shown = answer.publish;
      if (shown && !shown.published && !shown.canClick && shown.name)
        await noteHandPublish(deps, services, context, shown.name).catch(() => undefined);
      return answer;
    },
    [RobloxAction.ToolbarStatus]: (_args, context) => toolbarStatus(deps, context),
    [RobloxAction.Steps]: (_args, context) => steps(deps, context, slot.job),
    [RobloxAction.GetStudio]: (_args, context) => getStudio(deps, context, slot),
    [RobloxAction.CancelGetStudio]: async () => cancelGetStudio(slot),
    [RobloxAction.OpenStudio]: (_args, context) => openStudio(deps, context),
    [RobloxAction.QuitStudio]: (_args, context) => quitStudioAction(deps, context),
    [RobloxAction.Places]: (_args, context) => listPlaces(deps, context, scan),
    [RobloxAction.UsePlace]: (args, context) => usePlace(deps, context, args, scan),
    [RobloxAction.Create]: (args, context) =>
      createGame(deps, context, { snapshot: true, ...(typeof args.title === "string" ? { title: args.title } : {}) }),
    [RobloxAction.Setup]: (_args, context) => setupAction(deps, context),
    [RobloxAction.UndoSetup]: (_args, context) => undoAction(deps, context),
    [RobloxAction.RestartStudio]: (_args, context) => restartStudio(deps, context),
    [RobloxAction.DoItForMe]: (_args, context) => doItForMe(context),
    [RobloxAction.AddLuauChecks]: (_args, context) => addLuauAction(deps, luau, context),
    [RobloxAction.PublishUpdate]: publishHandler(deps, services, PublishAsker.Person),
    [RobloxAction.FirstPublish]: firstPublishHandler(deps, services, PublishAsker.Person),
  };
  const tools: Record<RobloxTool, Handler> = {
    [RobloxTool.StudioActivity]: async (_args, context) =>
      probeAnswer(await personActive(await momentOps(deps, services, context))),
    [RobloxTool.CheckScripts]: (args, context) => checkScriptsTool(deps, luau, context, args),
    [RobloxTool.LuauNote]: async (_args, context) => (context.hook ? luauNoteAt(deps, luau, context) : {}),
    [RobloxTool.LuauFinish]: async (_args, context) => (context.hook ? luauFinishAt(deps, luau, context) : {}),
    [RobloxTool.UseProject]: async (args, context) => (await usePlaceNamed(deps, context, args.project)).message,
    [RobloxTool.ShowSteps]: async (_args, context) => showSteps(context, (await steps(deps, context, slot.job)).open),
    [RobloxTool.NewGame]: (_args, context) => newGameTool(deps, context),
    [RobloxTool.EngineStatus]: () => engineStatus(deps),
    [RobloxTool.OpenForRun]: atMoment((ops) => openForRun(ops)),
    [RobloxTool.SavePlace]: atMoment(savePlaceAt),
    [RobloxTool.LoadPlace]: atMoment((ops) => loadPlaceAt(ops)),
    [RobloxTool.StudioState]: atMoment((ops) => studioStateAt(ops)),
    [RobloxTool.StudioCrashNote]: async (_args, context) => (context.hook ? crashAnswer() : {}),
    [RobloxTool.TeamNote]: atMoment((ops) => teamNoteAt(ops)),
    ...playHandlers(deps, services),
    ...askFirstHandlers(deps, services),
    ...modelHandlers(deps, services),
    [RobloxTool.PublishUpdate]: publishHandler(deps, services, PublishAsker.Agent),
    [RobloxTool.FirstPublish]: firstPublishHandler(deps, services, PublishAsker.Agent),
    ...pressHandlers(deps, slot, luau),
    [RobloxTool.HeroShots]: async (_args, context) => {
      // As the viewport observer: the picture within the time Genex gives.
      if (context.observe) {
        const ops = await momentOps(deps, services, context);
        return viewportStill(ops, context.observe.withinMs ?? OBSERVE_CALL_MS);
      }
      return context.hook ? heroShotsAt(await momentOps(deps, services, context), context.hook) : {};
    },
  };
  return {
    async action(name, args, context) {
      if (!isRobloxAction(name)) throw new Error(MESSAGE.UnknownAction(name));
      await noteGame(deps, context).catch(() => undefined);
      return actions[name](args, context);
    },
    async tool(name, args, context) {
      if (!isRobloxTool(name)) throw new Error(MESSAGE.UnknownTool(name));
      if (!COPY_TOOLS.has(name)) await noteGame(deps, context).catch(() => undefined);
      return tools[name](args, context);
    },
    async review(name, args, context) {
      if (name === RobloxAction.GetStudio) return reviewGetStudio(deps);
      if (name === RobloxAction.AddLuauChecks) return reviewAddLuau(deps, luau, context);
      if (name === RobloxAction.PublishUpdate) return reviewPublish(await publishPlace(context));
      if (name === RobloxAction.FirstPublish)
        return reviewFirstPublish(await publishPlace(context), requestedName(args));
      return name === RobloxAction.Setup ? reviewSetup(deps) : {};
    },
  };
}

/**
 * What runs when a game's helper connects, before agents can reach that Studio: a load a restore
 * left waiting (`pending-load.json`) first, then the scripts compared with the folder, the restored
 * files winning when a restore left their reconcile waiting (`pending-scripts.json`). A failed load
 * is logged and keeps its wait for the next connection; the scripts are compared all the same.
 */
export function pendingThenScripts(
  scripts: Pick<ScriptSyncs, "folder" | "bind">,
  log: (line: string) => void,
): (game: string, ask: HelperAsk) => Promise<void> {
  return async (game, ask) => {
    const folder = await scripts.folder(game);
    if (folder) await loadPendingPlace(ask, folder).catch((error) => log(`pending load: ${errorMessage(error)}`));
    const restored = folder ? await hasPendingScripts(folder) : false;
    const reconciled = await scripts.bind(game, { restored });
    // Cleared only once the restore's reconcile ran to its end: an ordinary one would undo the restore.
    if (reconciled && restored && folder) await clearPendingScripts(folder);
  };
}

/** The helper link and the script sync on this computer, as the backend's process runs them. */
interface HelperServices {
  helperLink(storage: string): void;
  gameSeen(storage: string, game: string, folder: string): Promise<void>;
  noteWritten(storage: string, game: string, folder: string, name: string): Promise<void>;
  moments: MomentServices;
}

/**
 * The helper link on this computer, started once: the Genex helper in Studio connects to it, and it
 * reads the helper's marker through the backend's own StudioMCP. A range with every port taken is
 * logged and left; the link starts again with the backend. Each game's scripts are reconciled when
 * its helper binds, before agents can reach that Studio, and kept in step while it stays bound.
 */
function helperServices(client: StudioClient, stopped: AbortSignal): HelperServices {
  let link: HelperLink | undefined;
  let syncs: ScriptSyncs | undefined;
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const watch = createStudioWatch(SYSTEM_CLOCK.now);
  const askFor =
    (game: string): HelperAsk =>
    (type, body, options) =>
      link ? link.request(game, type, body, options) : Promise.reject(new Error("The helper link isn't started"));
  const syncsIn = (storage: string) => {
    syncs ??= createScriptSyncs({
      storage,
      ask: askFor,
      bound: (game) => link?.bound(game) !== undefined,
      clock: SYSTEM_CLOCK,
      watch: systemWatch(log),
      log,
    });
    return syncs;
  };
  stopped.addEventListener("abort", () => syncs?.stop(), { once: true });
  let started = false;
  return {
    helperLink(storage) {
      if (started) return;
      started = true;
      const scripts = syncsIn(storage);
      const deps = {
        storage,
        studio: client,
        clock: SYSTEM_CLOCK,
        newSession: randomUUID,
        log,
        beforeBind: pendingThenScripts(scripts, log),
        sinks: {
          scriptsChanged: (game: string, change: ScriptChange) => scripts.changed(game, change),
          activity: (game: string, body: { editing: boolean }) => watch.activity(game, body.editing),
          team: (game: string, body: { others: string[] }) => watch.team(game, body.others),
        },
      };
      startHelperLink(deps, { signal: stopped }).then(
        (running) => {
          link = running.link;
        },
        (error: unknown) => log(`helper link: ${errorMessage(error)}`),
      );
    },
    gameSeen: (storage, game, folder) => syncsIn(storage).seen(game, folder),
    noteWritten: (storage, game, folder, name) => syncsIn(storage).written(game, folder, name),
    moments: {
      ask: askFor,
      bound: (game) => link?.bound(game),
      flush: async (game, timeoutMs) => {
        await syncs?.flush(game, timeoutMs);
      },
      reapply: async (game, options) => (await syncs?.bind(game, options)) ?? false,
      watch,
    },
  };
}

/**
 * Aborts when Genex lets go of this backend (its IPC channel closes: Genex quit or ended). The
 * helper link and the backend's StudioMCP then end, so nothing keeps the process, or the port.
 */
function backendGone(): AbortSignal {
  const gone = new AbortController();
  process.once("disconnect", () => gone.abort());
  return gone.signal;
}

/**
 * This computer, as the backend's process sees it. Studio answers when its own MCP server lists it,
 * asked through one StudioMCP the backend keeps for its life (StudioMCP ends with its stdin, so it
 * ends with the backend). It starts only once Studio is set up and running.
 */
export function systemDeps(): RobloxDeps {
  const locate: LocateDeps = {
    platform: process.platform,
    env: process.env,
    home: os.userInfo().homedir,
    fs: systemLocateFs,
    run: systemRun,
  };
  const client = createStudioClient(
    systemStudioClientDeps(async () => {
      const location = await locateStudio(locate);
      return location.installed ? location.install.mcp : undefined;
    }),
  );
  const gone = backendGone();
  gone.addEventListener("abort", () => void client.close(), { once: true });
  const services = helperServices(client, gone);
  return {
    ...locate,
    answers: () => studioAnswers(client),
    helperLink: services.helperLink,
    gameSeen: services.gameSeen,
    noteWritten: services.noteWritten,
    moments: services.moments,
    studio: client,
    helper: path.join(PACKAGE_DIR, HELPER_FILE),
    install: { fetch: globalThis.fetch, run: systemInstallRun, tempRoot: os.tmpdir() },
    open: systemOpener,
    sleep: (ms, signal) => sleep(ms, undefined, signal ? { signal } : {}),
    now: () => Date.now(),
  };
}

export const activate: Activate = () => createRobloxBackend(systemDeps());

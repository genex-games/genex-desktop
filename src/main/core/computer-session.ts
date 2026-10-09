/**
 * The computer session: the studio's referee between a model and a target. It parses the action,
 * loads the target, refuses what the target cannot do, keeps the action budget, holds or steps the
 * clock between a paced role's moves, answers every action — looking, waiting and the studio verbs
 * here, input through the target — checks a goal the studio was given, and writes the trace,
 * leaving a frame on the agent's screen each time.
 *
 * Generic over {@link ComputerTarget}: the browser window, a Play Protocol game and every target
 * added later share this one implementation. What is particular to a target (how it loads, how
 * its frames reach the agent screen) comes in through a {@link TargetSource}.
 */
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ScreenAct } from "../../shared/agent-screen.ts";
import { ComputerPacing, canPause, type InputRoute, type TargetCapabilities } from "../../shared/computer-target.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { CaptureSurface, type PreviewSetup, StillMimeType } from "../../shared/preview-contract.ts";
import {
  COMPUTER_TOOL_NAME,
  ComputerObserve,
  ComputerVerb,
  type ComputerHostAction,
  type ComputerRequest,
  computerAct,
  computerToInput,
  describeComputerAction,
  parseComputerArgs,
  setupReached,
  unsupportedAction,
} from "../../substrate/computer-tool.ts";
import { COMPUTER_ARG_PROBLEM } from "../../substrate/computer-tool-prompts.ts";
import type { ComputerTarget, TargetClock, TargetLoad, TargetShot } from "../../substrate/computer-target.ts";
import { plannedInputs, steppedPlan } from "../../substrate/computer-steps.ts";
import { MAX_INPUT_ACTIONS, type PreviewInputAction } from "../../substrate/preview-input.ts";
import { TRACE_FILE, type TraceRow, type TraceSummary, traceArgs, traceLine } from "../../substrate/computer-trace.ts";
import type { LiveToolResult } from "../../substrate/engines/types.ts";
import { ensureDir } from "../../substrate/fsx.ts";
import { CAMERA_SETTLE_MS, DEFAULT_SHOT_QUALITY, requestedSurface, surfaceWord } from "./capture.ts";
import { safePathSegment } from "./run-shots.ts";

/** How long an input settles before the state is read back (and how far a stepped clock runs after it). */
const INPUT_SETTLE_MS = 120;
/** Characters of the game's state in an answer: after an action, by default, and when asked for. */
const STATE_CHARS = { afterAction: 600, default: 1_200, asked: 4_000 } as const;
/** How many of the latest console errors an answer lists. */
const CONSOLE_ERRORS_SHOWN = 12;
/** Characters of an action's name kept in a frame's file name. */
const FRAME_NAME_CHARS = 40;
/** One simulation tick of a named action held for a duration: a 60 Hz frame. */
const TICK_MS = SECOND_MS / 60;
/** The game time a stepped session gives a key stroke between its down and its up: a few frames. */
const STEPPED_TAP_MS = 50;
/** The most game time one step asks of a target at once; a longer wait is stepped in chunks. */
const STEP_CHUNK_MS = 5 * SECOND_MS;
/** How many frame folders the numbering remembers before it forgets the oldest. */
const MAX_NUMBERED_FOLDERS = 500;
/** The seed a stepped session plants when it was given none, so two runs start from the same dice. */
const DEFAULT_SEED = 1;

export { ComputerPacing };

/** What a session needs from the kind of target it drives: how it loads, and where its frames go. */
export interface TargetSource<T extends ComputerTarget = ComputerTarget> {
  readonly caps: TargetCapabilities;
  /**
   * The target, loaded with the build at `root` — reloaded when forced. `fresh` says this call
   * loaded it, so the session can seed and stand the clock still before the first move.
   */
  load(root: string, force: boolean): Promise<TargetLoad<T> & { fresh: boolean }>;
  /** A picture of the target for the agent's screen; null asks the source to take its own. */
  frame(target: T, jpeg: Buffer | null, caption: string, act: ScreenAct): Promise<void>;
}

/** A goal the studio checks after every move: the first time it holds is studio-verified. */
export interface ComputerQuest {
  id: string;
  until: NonNullable<PreviewSetup["verify"]>;
}

/** How a session behaves: its pacing, where frames go, what it brings back, and its limits. */
export interface ComputerSessionOptions {
  pacing: ComputerPacing;
  /** The folder every frame of this session, and its trace, is saved into. */
  frameDir: string;
  /** The seed a stepped session plants on every fresh load. */
  seed?: number;
  /** Whether an input action brings back its picture when the model does not say. */
  observeByDefault?: boolean;
  /** The most moves (input actions, waits and batch steps) the session may make. */
  maxActions?: number;
  quest?: ComputerQuest;
  /** The clock trace times are read from; injected in tests. */
  now?: () => number;
  /**
   * What the tool offers of what the target can do: a judge is offered neither the game's `state`
   * nor its `console` (the builder wrote both), though the session still reads state for the goal.
   */
  offer?: (caps: TargetCapabilities) => TargetCapabilities;
  /** Whether answers carry the game's own state after a move; a judge's never do. */
  showState?: boolean;
  /** Told once, when the goal is reached: the trace that shows it (the host vouches for it). */
  onReached?: (tracePath: string) => void;
}

/** One session on one target: its tool call, its shared load, the build it shows and its trace. */
export interface ComputerSession<T extends ComputerTarget = ComputerTarget> {
  run(name: string, args: Record<string, unknown>): Promise<LiveToolResult>;
  ensureLoaded(force?: boolean): Promise<TargetLoad<T>>;
  root(): string;
  retarget(root: string): void;
  trace(): TraceSummary;
}

/** What an action leaves for its trace row, filled in by its handler. */
interface ActionRecord {
  route: InputRoute | null;
  frame: string | null;
  simMs: number | null;
  reached: boolean;
  /** Input actions the target took, of those planned; null for an action that sent none. */
  applied: { taken: number; planned: number } | null;
  /** Why the action failed, when it did. */
  failed?: string;
}

/** Everything an action's handler reads: the request, the target, and the session's helpers. */
interface ActionContext {
  request: ComputerRequest;
  target: ComputerTarget;
  size: { width: number; height: number };
  caption: string;
  /** The same action as a code, for the agent's screen. */
  act: ScreenAct;
  /** The note of the load this action caused, if it caused one. */
  note: string | null;
  /** The setup note to append to the answer (`\nnote: …`), or nothing. */
  noteLine: string;
  surface: CaptureSurface;
  /** What the studio says about the surface and observe words asked for, on lines above the answer. */
  surfaceLine: string;
  helpers: SessionHelpers;
  record: ActionRecord;
}

type HostActionHandler = (ctx: ActionContext) => Promise<LiveToolResult>;

/** A session's state and the helpers its actions share. */
interface SessionHelpers {
  readonly root: () => string;
  readonly loadedAt: () => number;
  /** The note of the last load, until a look has shown it. */
  readonly setupNote: () => string | null;
  readonly clearSetupNote: () => void;
  readonly cursor: (target: ComputerTarget, size: { width: number; height: number }) => { x: number; y: number };
  readonly stateText: (target: ComputerTarget, max?: number) => Promise<string>;
  /** The state after a move, as the answer shows it, with the goal checked against it. */
  readonly afterMove: (ctx: ActionContext) => Promise<string>;
  /** Save a frame under the session's folder; a PNG keeps its own extension. */
  readonly saveFrame: (jpeg: Buffer, name: string, mime?: StillMimeType) => Promise<string>;
  readonly frame: (target: ComputerTarget, jpeg: Buffer | null, caption: string, act: ScreenAct) => Promise<void>;
  /** Let `ms` of the target's time pass, as the session's pacing says: a wait. */
  readonly waiting: (target: ComputerTarget, ms: number) => Promise<number | null>;
  /** Carry out an input plan inside the session's pacing; what it took and how much time ran. */
  readonly inputting: (target: ComputerTarget, actions: PreviewInputAction[]) => Promise<InputOutcome>;
  readonly observeByDefault: boolean;
}

async function look(ctx: ActionContext): Promise<LiveToolResult> {
  const { request, target, helpers } = ctx;
  const warning = request.action === "camera" ? await switchCamera(target, request.text) : "";
  const shot = await target.screenshot({ quality: DEFAULT_SHOT_QUALITY, surface: ctx.surface });
  const { jpeg, stats } = shot;
  const mimeType = shot.mime ?? StillMimeType.Jpeg;
  const name = request.action === "camera" ? `cam-${request.text}` : "screen";
  const file = await helpers.saveFrame(jpeg, name, mimeType);
  ctx.record.frame = file;
  await helpers.frame(target, jpeg, ctx.caption, ctx.act);
  const c = helpers.cursor(target, ctx.size);
  helpers.clearSetupNote();
  const took = surfaceWord(shot.surface);
  const tookText = took ? ` (${took})` : "";
  const measured = stats ? `, litFraction ${stats.litFraction.toFixed(2)}, meanLuma ${Math.round(stats.meanLuma)}` : "";
  return {
    text: `${ctx.surfaceLine}${file} — ${ctx.size.width}×${ctx.size.height}${tookText}, cursor at ${c.x},${c.y}${measured}${warning}${ctx.noteLine}`,
    images: [{ mimeType, data: jpeg.toString("base64"), label: ctx.caption }],
  };
}

/** Point the game's debug camera; a camera the game does not know is a warning, never a refusal. */
async function switchCamera(target: ComputerTarget, camera: string | undefined): Promise<string> {
  let warning = "";
  const placed = target.camera ? await target.camera(String(camera ?? "")).catch(() => null) : null;
  if (placed && !placed.ok) {
    const why = placed.reason ?? `available: ${(placed.available ?? []).join(", ") || "none"}`;
    warning = ` — WARNING: camera "${camera}" is not registered (${why}); this is the current view instead`;
  }
  await sleep(CAMERA_SETTLE_MS);
  return warning;
}

async function zoom(ctx: ActionContext): Promise<LiveToolResult> {
  const { request, target, size, surface } = ctx;
  if (!target.zoom || !request.region) return "zoom is not available on this preview — take a screenshot instead";
  const z = await target.zoom(request.region, { surface });
  const file = await ctx.helpers.saveFrame(z.jpeg, "zoom");
  ctx.record.frame = file;
  const took = surfaceWord(surface === CaptureSurface.Auto ? null : surface);
  const tookText = took ? ` (${took})` : "";
  return {
    text: `${ctx.surfaceLine}${file} — region ${z.region.map(Math.round).join(",")} of the ${size.width}×${size.height} frame${tookText}, shown at ${z.width}×${z.height}; coordinates stay those of the whole frame`,
    images: [{ mimeType: "image/jpeg", data: z.jpeg.toString("base64"), label: ctx.caption }],
  };
}

/** A picture the target answered, as opposed to the error it threw. */
function isShot(value: unknown): value is TargetShot {
  return typeof value === "object" && value !== null && Buffer.isBuffer((value as { jpeg?: unknown }).jpeg);
}

/** What a move brings back: the picture asked for (or the session's default), or only its text. */
async function observed(ctx: ActionContext, text: string, hint: boolean): Promise<LiveToolResult> {
  const { request, target, helpers } = ctx;
  const fallback = helpers.observeByDefault ? ComputerObserve.Screenshot : ComputerObserve.None;
  const mode = request.observe ?? fallback;
  if (mode === ComputerObserve.None) {
    await helpers.frame(target, null, ctx.caption, ctx.act);
    const asked = request.observe !== undefined;
    return `${ctx.surfaceLine}${text}${hint && !asked ? "\nScreenshot to see the result." : ""}`;
  }
  const surface = mode === ComputerObserve.Canvas ? CaptureSurface.Canvas : CaptureSurface.Auto;
  // The move already happened: a picture that cannot be taken is said, never a failed move.
  const shot = await target.screenshot({ quality: DEFAULT_SHOT_QUALITY, surface }).catch((err: unknown) => err);
  if (!isShot(shot)) {
    await helpers.frame(target, null, ctx.caption, ctx.act);
    return `${ctx.surfaceLine}${text}\n${COMPUTER_ARG_PROBLEM.observeFailed(errorMessage(shot))}`;
  }
  const mimeType = shot.mime ?? StillMimeType.Jpeg;
  const file = await helpers.saveFrame(shot.jpeg, `after-${request.action}`, mimeType);
  ctx.record.frame = file;
  await helpers.frame(target, shot.jpeg, ctx.caption, ctx.act);
  return {
    text: `${ctx.surfaceLine}${text}\n${file}`,
    images: [{ mimeType, data: shot.jpeg.toString("base64"), label: ctx.caption }],
  };
}

async function wait(ctx: ActionContext): Promise<LiveToolResult> {
  const seconds = ctx.request.duration ?? 1;
  ctx.record.simMs = await ctx.helpers.waiting(ctx.target, Math.round(seconds * SECOND_MS));
  return observed(ctx, `waited ${seconds}s — ${await ctx.helpers.afterMove(ctx)}${ctx.noteLine}`, false);
}

async function consoleErrors(ctx: ActionContext): Promise<LiveToolResult> {
  const entries = ctx.target.console?.(ctx.helpers.loadedAt()) ?? [];
  const errors = entries.filter((entry) => entry.level === "error");
  if (!errors.length) return "console errors since load: none";
  const listed = errors
    .slice(-CONSOLE_ERRORS_SHOWN)
    .map((entry) => `- ${entry.message}`)
    .join("\n");
  return `console errors since load (${errors.length}):\n${listed}`;
}

/** One input step: carried out by the target inside the session's pacing; what it took and the time it ran. */
async function inputStep(ctx: ActionContext, step: ComputerRequest): Promise<InputOutcome> {
  const { target, helpers } = ctx;
  if (step.action === ComputerVerb.Wait) {
    const simMs = await helpers.waiting(target, Math.round((step.duration ?? 1) * SECOND_MS));
    return { simMs, taken: 0, planned: 0, route: null };
  }
  const actions = computerToInput(step, helpers.cursor(target, ctx.size));
  if (!actions.length) return { simMs: null, taken: 0, planned: 0, route: null };
  const outcome = await helpers.inputting(target, actions);
  if (outcome.route) ctx.record.route = outcome.route;
  return outcome;
}

/** What a move's input amounted to, added to the action's record. */
function tally(record: ActionRecord, outcome: InputOutcome): void {
  if (!outcome.planned) return;
  const before = record.applied ?? { taken: 0, planned: 0 };
  record.applied = { taken: before.taken + outcome.taken, planned: before.planned + outcome.planned };
}

/** The input events a batch would send, counted before any is sent. */
function batchEvents(ctx: ActionContext, steps: ComputerRequest[]): number {
  const at = ctx.helpers.cursor(ctx.target, ctx.size);
  return steps.reduce((sum, step) => sum + computerToInput(step, at).length, 0);
}

/** A batch: its steps in order, stopping at the first that fails, with one look at the end. */
async function batch(ctx: ActionContext): Promise<LiveToolResult> {
  const steps = ctx.request.steps ?? [];
  if (batchEvents(ctx, steps) > MAX_INPUT_ACTIONS) return COMPUTER_ARG_PROBLEM.batchTooManyEvents(MAX_INPUT_ACTIONS);
  let simulated = 0;
  for (const [index, step] of steps.entries()) {
    const outcome = await inputStep(ctx, step).catch((err: unknown) => errorMessage(err));
    const why = typeof outcome === "string" ? outcome : refusedWhy(outcome);
    if (why) {
      const failed = COMPUTER_ARG_PROBLEM.batchStepFailed(index + 1, describeComputerAction(step), why, index);
      return observed(ctx, `${failed}. ${await ctx.helpers.afterMove(ctx)}`, true);
    }
    if (typeof outcome !== "string") {
      tally(ctx.record, outcome);
      simulated += outcome.simMs ?? 0;
    }
  }
  ctx.record.simMs = simulated || null;
  const c = ctx.helpers.cursor(ctx.target, ctx.size);
  const head = `OK — ${steps.length} of ${steps.length} steps: ${ctx.caption}; cursor at ${c.x},${c.y}.`;
  return observed(ctx, `${head} ${await ctx.helpers.afterMove(ctx)}${ctx.noteLine}`, true);
}

/** The game's own named action: pressed once, or held for its duration of game time, then time let pass. */
async function act(ctx: ActionContext): Promise<LiveToolResult> {
  const { request, target, helpers } = ctx;
  if (!target.act) return COMPUTER_ARG_PROBLEM.unsupported(request.action, "");
  const held = request.duration ? Math.round(request.duration * SECOND_MS) : 0;
  const ticks = held ? Math.max(1, Math.round(held / TICK_MS)) : undefined;
  const done = await target.act([
    { action: String(request.text), state: held ? "hold" : "press", ...(ticks ? { ticks } : {}) },
  ]);
  ctx.record.route = done.route;
  tally(ctx.record, { simMs: null, taken: done.applied, planned: 1, route: done.route });
  ctx.record.simMs = await helpers.waiting(target, held || INPUT_SETTLE_MS);
  const head = done.applied ? `OK — ${ctx.caption}` : COMPUTER_ARG_PROBLEM.partlyTaken(ctx.caption, 0, 1);
  return observed(ctx, `${head}. ${await helpers.afterMove(ctx)}${ctx.noteLine}`, true);
}

const HOST_ACTIONS: Record<ComputerHostAction, HostActionHandler> = {
  screenshot: look,
  camera: look,
  zoom,
  cursor_position: async (ctx) => {
    const c = ctx.helpers.cursor(ctx.target, ctx.size);
    return `X=${c.x}, Y=${c.y}`;
  },
  wait,
  state: async (ctx) => `${await ctx.helpers.stateText(ctx.target, STATE_CHARS.asked)}${ctx.noteLine}`,
  console: consoleErrors,
  reload: async (ctx) => {
    const noted = ctx.note ? ` — ${ctx.note}` : "";
    const state = await ctx.helpers.stateText(ctx.target, STATE_CHARS.afterAction);
    return `reloaded ${path.basename(ctx.helpers.root())}${noted} — ${state}`;
  },
  batch,
  act,
};

function isHostAction(action: string): action is ComputerHostAction {
  return Object.hasOwn(HOST_ACTIONS, action);
}

/** An input action: carried out by the target, then the state read back. */
async function input(ctx: ActionContext): Promise<LiveToolResult> {
  const { target, helpers, caption } = ctx;
  if (!computerToInput(ctx.request, helpers.cursor(target, ctx.size)).length) {
    return `${ctx.request.action}: nothing to do (${caption})`;
  }
  const outcome = await inputStep(ctx, ctx.request);
  tally(ctx.record, outcome);
  ctx.record.simMs = outcome.simMs;
  const c = helpers.cursor(target, ctx.size);
  const state = await helpers.afterMove(ctx);
  const head =
    outcome.taken < outcome.planned
      ? COMPUTER_ARG_PROBLEM.partlyTaken(caption, outcome.taken, outcome.planned)
      : `OK — ${caption}`;
  return observed(ctx, `${head}; cursor at ${c.x},${c.y}. ${state}${ctx.noteLine}`, true);
}

/**
 * A load that concurrent callers share: parallel state/console requests share the first
 * navigation, rather than aborting each other. A forced load waits for the one in flight, then runs.
 */
function sharedLoad<L>(load: (force: boolean) => Promise<L>): (force?: boolean) => Promise<L> {
  let loading: Promise<L> | null = null;
  return async (force = false) => {
    if (loading) {
      if (!force) return loading;
      await loading;
    }
    const pending = load(force);
    loading = pending;
    try {
      return await pending;
    } finally {
      if (loading === pending) loading = null;
    }
  };
}

/** The view's centre: where a pointer the target does not track is drawn. */
function centre(size: { width: number; height: number }): { x: number; y: number } {
  return { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
}

/** How many moves an action makes against the budget: looking and reading are free. */
function movesOf(request: ComputerRequest): number {
  if (request.action === ComputerVerb.Batch) return request.steps?.length ?? 0;
  const moving = request.action === ComputerVerb.Wait || request.action === ComputerVerb.Act;
  return isHostAction(request.action) && !moving ? 0 : 1;
}

/** What one move's input amounted to: the time the clock ran, the actions the target took, and how. */
interface InputOutcome {
  simMs: number | null;
  taken: number;
  planned: number;
  route: InputRoute | null;
}

/** Why a move counts as failed for a batch: the target took none of the input it was sent. */
function refusedWhy(outcome: InputOutcome): string | null {
  return outcome.planned > 0 && outcome.taken === 0 ? COMPUTER_ARG_PROBLEM.allRefused : null;
}

/** Wall time a paced move lets pass: the settle, or the wait itself. */
async function pacedTime(clock: TargetClock | undefined, ms: number): Promise<void> {
  await clock?.start();
  try {
    await sleep(ms);
  } finally {
    await clock?.pause();
  }
}

/** Step `ms` of game time in chunks a target can take whole; null the moment it cannot. */
async function stepChunks(clock: TargetClock, ms: number): Promise<number | null> {
  let simulated = 0;
  for (let left = ms; left > 0; left -= STEP_CHUNK_MS) {
    const chunk = Math.min(STEP_CHUNK_MS, left);
    const stepped = clock.step ? await clock.step(chunk).catch(() => null) : null;
    if (stepped === null) return null;
    simulated += stepped;
  }
  return simulated;
}

/**
 * The session's clock keeper. It reads what the loaded target can do on every load — a Play
 * Protocol game says so only in its `hello` — so a paced session holds only a clock that can be held,
 * and a stepped one seeds the target and steps exact time, splitting every key stroke so the game
 * sees it (`steppedPlan`). The first time the target cannot step, the session falls back to pacing
 * on wall time and its trace stops claiming the run replays.
 */
function clockKeeper(options: ComputerSessionOptions) {
  let holds = false;
  let stepping = false;
  let replayable = options.pacing === ComputerPacing.Stepped;
  const fallBack = () => {
    stepping = false;
    replayable = false;
  };
  /** Game time for one part of a stepped plan: stepped exactly, or paced on wall time once it cannot be. */
  const stepTime = async (target: ComputerTarget, ms: number): Promise<number> => {
    const stepped = stepping && target.clock ? await stepChunks(target.clock, ms) : null;
    if (stepped !== null) return stepped;
    fallBack();
    await pacedTime(holds ? target.clock : undefined, ms);
    return 0;
  };
  const steppedInput = async (target: ComputerTarget, actions: PreviewInputAction[]): Promise<InputOutcome> => {
    const parts = steppedPlan(actions, STEPPED_TAP_MS);
    const outcome: InputOutcome = { simMs: 0, taken: 0, planned: plannedInputs(parts), route: null };
    for (const part of [...parts, { stepMs: INPUT_SETTLE_MS }]) {
      if ("stepMs" in part) {
        outcome.simMs = (outcome.simMs ?? 0) + (await stepTime(target, part.stepMs));
        continue;
      }
      const done = await target.input(part.input);
      outcome.taken += done.applied;
      outcome.route = done.route;
    }
    return outcome;
  };
  return {
    deterministic: () => replayable,
    onLoad: async (target: ComputerTarget) => {
      holds = options.pacing !== ComputerPacing.Running && canPause(target.caps);
      stepping = holds && options.pacing === ComputerPacing.Stepped && Boolean(target.clock?.step);
      if (!stepping || !target.seed) replayable = false;
      if (stepping) await target.seed?.(options.seed ?? DEFAULT_SEED);
      if (holds) await target.clock?.pause();
    },
    waiting: async (target: ComputerTarget, ms: number): Promise<number | null> => {
      const stepped = stepping && target.clock ? await stepChunks(target.clock, ms) : null;
      if (stepped !== null) return stepped;
      if (stepping) fallBack();
      await pacedTime(holds ? target.clock : undefined, ms);
      return null;
    },
    inputting: async (target: ComputerTarget, actions: PreviewInputAction[]): Promise<InputOutcome> => {
      if (stepping) return steppedInput(target, actions);
      const clock = holds ? target.clock : undefined;
      await clock?.start();
      try {
        const done = await target.input(actions);
        await sleep(INPUT_SETTLE_MS);
        return { simMs: null, taken: done.applied, planned: actions.length, route: done.route };
      } finally {
        await clock?.pause();
      }
    },
  };
}

/** Frames and traces of every session in one folder: numbered on, so no session overwrites another's. */
const FOLDERS = new Map<string, { shots: number; sessions: number }>();

/** A folder's numbering, made on first use; the oldest folder is forgotten past a bound. */
function folderNumbering(dir: string): { shots: number; sessions: number } {
  const known = FOLDERS.get(dir);
  if (known) return known;
  if (FOLDERS.size >= MAX_NUMBERED_FOLDERS) {
    const oldest = FOLDERS.keys().next().value;
    if (oldest !== undefined) FOLDERS.delete(oldest);
  }
  const made = { shots: 0, sessions: 0 };
  FOLDERS.set(dir, made);
  return made;
}

/** The session's trace: rows appended beside the frames, and what they add up to. */
function traceKeeper(options: ComputerSessionOptions) {
  const now = options.now ?? Date.now;
  const session = ++folderNumbering(options.frameDir).sessions;
  const file = path.join(options.frameDir, session === 1 ? TRACE_FILE : `trace-${session}.jsonl`);
  let started: number | null = null;
  let steps = 0;
  let reachedAt: number | null = null;
  const routes = new Set<InputRoute>();
  return {
    file,
    write: async (
      request: ComputerRequest,
      caption: string,
      record: ActionRecord,
      cursor: TraceRow["cursor"],
      refused: boolean,
    ) => {
      started ??= now();
      steps += 1;
      if (record.reached && reachedAt === null) reachedAt = steps;
      if (record.route) routes.add(record.route);
      const row: TraceRow = {
        i: steps,
        atMs: now() - started,
        action: request.action,
        caption,
        args: traceArgs(request),
        route: record.route,
        frame: record.frame,
        cursor,
        simMs: record.simMs,
        ...(record.applied ? { applied: record.applied } : {}),
        ...(refused ? { refused: true as const } : {}),
        ...(record.failed ? { failed: record.failed } : {}),
        ...(record.reached ? { reached: true as const } : {}),
      };
      await ensureDir(options.frameDir);
      await appendFile(file, traceLine(row));
    },
    summary: (deterministic: boolean): TraceSummary => ({
      path: steps ? file : null,
      steps,
      deterministic,
      reachedAt,
      routes: [...routes],
    }),
  };
}

/** Where the session's goal stands: reached, or already holding before any move (which never counts). */
interface GoalState {
  reached: boolean;
  /** The goal held before the first move; it counts only once it has stopped holding and holds again. */
  heldBeforeMoving: boolean;
}

/** The session's helpers over its source, its options and the keepers of its clock and goal. */
function sessionHelpers<T extends ComputerTarget>(
  source: TargetSource<T>,
  options: ComputerSessionOptions,
  state: { root: () => string; loadedAt: () => number; note: { value: string | null } },
  clock: ReturnType<typeof clockKeeper>,
  goal: GoalState,
): SessionHelpers {
  const numbering = folderNumbering(options.frameDir);
  const readState = async (target: ComputerTarget): Promise<unknown> =>
    (target.state ? await target.state().catch(() => null) : null) ?? { __missing: true };
  return {
    root: state.root,
    loadedAt: state.loadedAt,
    setupNote: () => state.note.value,
    clearSetupNote: () => {
      state.note.value = null;
    },
    cursor: (target, size) => target.pointer() ?? centre(size),
    stateText: async (target, max = STATE_CHARS.default) =>
      `state: ${JSON.stringify(await readState(target)).slice(0, max)}`,
    afterMove: async (ctx) => {
      const current = await readState(ctx.target);
      const line =
        options.showState === false ? "" : `state: ${JSON.stringify(current).slice(0, STATE_CHARS.afterAction)}`;
      const reached = goalReached(options.quest, goal, current);
      if (!reached || !options.quest) return line;
      ctx.record.reached = true;
      return `${line}\nGOAL REACHED (studio-verified): ${options.quest.id}`.trim();
    },
    saveFrame: async (jpeg, name, mime = StillMimeType.Jpeg) => {
      await ensureDir(options.frameDir);
      const ext = mime === StillMimeType.Png ? "png" : "jpg";
      const base = `s${++numbering.shots}_${safePathSegment(name).slice(0, FRAME_NAME_CHARS)}`;
      const file = path.join(options.frameDir, `${base}.${ext}`);
      await writeFile(file, jpeg);
      return file;
    },
    frame: (target, jpeg, caption, act) => source.frame(target as T, jpeg, caption, act),
    waiting: clock.waiting,
    inputting: clock.inputting,
    observeByDefault: options.observeByDefault ?? false,
  };
}

/** The context an action runs in. */
function actionContext(
  request: ComputerRequest,
  loaded: TargetLoad,
  setupNote: string | null,
  helpers: SessionHelpers,
): ActionContext {
  const notes = [request.surfaceNote, request.observeNote].filter(Boolean);
  return {
    request,
    target: loaded.target,
    size: loaded.target.viewSize(),
    caption: describeComputerAction(request),
    act: computerAct(request),
    note: loaded.note,
    noteLine: setupNote ? `\nnote: ${setupNote}` : "",
    surface: requestedSurface(request),
    surfaceLine: notes.length ? `${notes.join("\n")}\n` : "",
    helpers,
    record: emptyRecord(),
  };
}

/** A record with nothing in it yet. */
function emptyRecord(): ActionRecord {
  return { route: null, frame: null, simMs: null, reached: false, applied: null };
}

/**
 * Whether this move reached the goal: the first time the game's own state meets it, and never when
 * it already held before the first move — that state came with the build, not from playing it.
 */
function goalReached(quest: ComputerQuest | undefined, goal: GoalState, current: unknown): boolean {
  if (!quest || goal.reached) return false;
  const holds = setupReached(quest.until, current) === true;
  if (goal.heldBeforeMoving) {
    if (!holds) goal.heldBeforeMoving = false;
    return false;
  }
  if (holds) goal.reached = true;
  return holds;
}

/**
 * A computer session over one target source, starting on the build at `initialRoot`. Loaded on
 * the first action, then kept running between actions so a map the worker switched to stays
 * switched — except for a paced or stepped session, whose clock runs only during its moves.
 */
export function computerSession<T extends ComputerTarget>(
  source: TargetSource<T>,
  initialRoot: string,
  options: ComputerSessionOptions,
): ComputerSession<T> {
  let root = initialRoot;
  let loadedAt = 0;
  let moves = 0;
  let caps = source.caps;
  const note = { value: null as string | null };
  const goal: GoalState = { reached: false, heldBeforeMoving: false };
  const clock = clockKeeper(options);
  const trace = traceKeeper(options);
  const offered = () => (options.offer ? options.offer(caps) : caps);
  const ensureLoaded = sharedLoad(async (force: boolean): Promise<TargetLoad<T>> => {
    const loaded = await source.load(root, force);
    if (!loaded.fresh || loaded.problem) return loaded;
    caps = loaded.target.caps;
    await clock.onLoad(loaded.target);
    loadedAt = Date.now();
    note.value = loaded.note;
    goal.heldBeforeMoving = await goalHoldsNow(options.quest, loaded.target);
    return loaded;
  });
  const helpers = sessionHelpers(source, options, { root: () => root, loadedAt: () => loadedAt, note }, clock, goal);
  const refuse = async (request: ComputerRequest, sentence: string): Promise<LiveToolResult> => {
    await trace.write(request, describeComputerAction(request), emptyRecord(), null, true);
    return sentence;
  };
  const act = async (request: ComputerRequest, loaded: TargetLoad<T>): Promise<LiveToolResult> => {
    const ctx = actionContext(request, loaded, loaded.note ?? note.value, helpers);
    const answer = await (isHostAction(request.action) ? HOST_ACTIONS[request.action](ctx) : input(ctx)).catch(
      (err: unknown) => {
        ctx.record.failed = errorMessage(err);
        return { text: COMPUTER_ARG_PROBLEM.actionFailed(request.action, ctx.record.failed), isError: true };
      },
    );
    await trace.write(request, ctx.caption, ctx.record, loaded.target.pointer(), false);
    if (ctx.record.reached) options.onReached?.(trace.file);
    return answer;
  };
  const run = async (name: string, args: Record<string, unknown>): Promise<LiveToolResult> => {
    if (name !== COMPUTER_TOOL_NAME) return `unknown tool ${name}`;
    const parsed = parseComputerArgs(args);
    if (!parsed.ok) return parsed.error;
    const request = parsed.request;
    // Refused before the load when even what the target may do rules it out (nothing starts),
    // and again after it, against what the loaded target says it can do.
    const ruledOut = refusalOf(request, offered());
    if (ruledOut) return refuse(request, ruledOut);
    const loaded = await ensureLoaded(request.action === ComputerVerb.Reload);
    if (loaded.problem) return loaded.problem;
    const refused = refusalOf(request, offered());
    if (refused) return refuse(request, refused);
    const cost = movesOf(request);
    if (options.maxActions !== undefined && moves + cost > options.maxActions) {
      return refuse(request, COMPUTER_ARG_PROBLEM.budgetSpent(options.maxActions));
    }
    moves += cost;
    return act(request, loaded);
  };
  return {
    run,
    ensureLoaded,
    root: () => root,
    retarget: (next) => {
      root = next;
    },
    trace: () => trace.summary(clock.deterministic()),
  };
}

/** Whether the goal already holds on a freshly loaded build, before any move. */
async function goalHoldsNow(quest: ComputerQuest | undefined, target: ComputerTarget): Promise<boolean> {
  if (!quest || !target.state) return false;
  const state = await target.state().catch(() => null);
  return setupReached(quest.until, state) === true;
}

/** The sentence for an action, or any step of a batch, the target cannot carry out; null when it can. */
function refusalOf(request: ComputerRequest, caps: TargetCapabilities): string | null {
  const own = unsupportedAction(request.action, caps);
  if (own) return own;
  for (const step of request.steps ?? []) {
    const refused = unsupportedAction(step.action, caps);
    if (refused) return refused;
  }
  return null;
}

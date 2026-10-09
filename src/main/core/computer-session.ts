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
import { CaptureSurface, type PreviewSetup } from "../../shared/preview-contract.ts";
import {
  COMPUTER_TOOL_NAME,
  ComputerObserve,
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
import type { ComputerTarget, TargetLoad, TargetShot } from "../../substrate/computer-target.ts";
import { TRACE_FILE, type TraceRow, type TraceSummary, traceArgs, traceLine } from "../../substrate/computer-trace.ts";
import type { LiveToolResult } from "../../substrate/engines/types.ts";
import { ensureDir } from "../../substrate/fsx.ts";
import { MAX_INPUT_ACTIONS } from "../../substrate/preview-input.ts";
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
  readonly saveFrame: (jpeg: Buffer, name: string) => Promise<string>;
  readonly frame: (target: ComputerTarget, jpeg: Buffer | null, caption: string, act: ScreenAct) => Promise<void>;
  /** Run one move and let `ms` of the target's time pass after it, as the session's pacing says. */
  readonly moving: (target: ComputerTarget, move: () => Promise<void>, ms: number) => Promise<number | null>;
  readonly observeByDefault: boolean;
}

async function look(ctx: ActionContext): Promise<LiveToolResult> {
  const { request, target, helpers } = ctx;
  const warning = request.action === "camera" ? await switchCamera(target, request.text) : "";
  const shot = await target.screenshot({ quality: DEFAULT_SHOT_QUALITY, surface: ctx.surface });
  const { jpeg, stats } = shot;
  const file = await helpers.saveFrame(jpeg, request.action === "camera" ? `cam-${request.text}` : "screen");
  ctx.record.frame = file;
  await helpers.frame(target, jpeg, ctx.caption, ctx.act);
  const c = helpers.cursor(target, ctx.size);
  helpers.clearSetupNote();
  const took = surfaceWord(shot.surface);
  const tookText = took ? ` (${took})` : "";
  const measured = stats ? `, litFraction ${stats.litFraction.toFixed(2)}, meanLuma ${Math.round(stats.meanLuma)}` : "";
  return {
    text: `${ctx.surfaceLine}${file} — ${ctx.size.width}×${ctx.size.height}${tookText}, cursor at ${c.x},${c.y}${measured}${warning}${ctx.noteLine}`,
    images: [{ mimeType: "image/jpeg", data: jpeg.toString("base64"), label: ctx.caption }],
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
  const file = await helpers.saveFrame(shot.jpeg, `after-${request.action}`);
  ctx.record.frame = file;
  await helpers.frame(target, shot.jpeg, ctx.caption, ctx.act);
  return {
    text: `${ctx.surfaceLine}${text}\n${file}`,
    images: [{ mimeType: "image/jpeg", data: shot.jpeg.toString("base64"), label: ctx.caption }],
  };
}

async function wait(ctx: ActionContext): Promise<LiveToolResult> {
  const seconds = ctx.request.duration ?? 1;
  ctx.record.simMs = await ctx.helpers.moving(ctx.target, async () => {}, Math.round(seconds * SECOND_MS));
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

/** One input step: carried out by the target inside the session's pacing; the time its clock ran. */
async function inputStep(ctx: ActionContext, step: ComputerRequest): Promise<number | null> {
  const { target, helpers } = ctx;
  if (step.action === "wait")
    return helpers.moving(target, async () => {}, Math.round((step.duration ?? 1) * SECOND_MS));
  const actions = computerToInput(step, helpers.cursor(target, ctx.size));
  if (!actions.length) return null;
  return helpers.moving(
    target,
    async () => {
      const done = await target.input(actions);
      ctx.record.route = done.route;
    },
    INPUT_SETTLE_MS,
  );
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
    try {
      simulated += (await inputStep(ctx, step)) ?? 0;
    } catch (err) {
      const why = COMPUTER_ARG_PROBLEM.batchStepFailed(
        index + 1,
        describeComputerAction(step),
        errorMessage(err),
        index,
      );
      return observed(ctx, `${why}. ${await ctx.helpers.afterMove(ctx)}`, true);
    }
  }
  ctx.record.simMs = simulated || null;
  const c = ctx.helpers.cursor(ctx.target, ctx.size);
  const head = `OK — ${steps.length} of ${steps.length} steps: ${ctx.caption}; cursor at ${c.x},${c.y}.`;
  return observed(ctx, `${head} ${await ctx.helpers.afterMove(ctx)}${ctx.noteLine}`, true);
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
  ctx.record.simMs = await inputStep(ctx, ctx.request);
  const c = helpers.cursor(target, ctx.size);
  const state = await helpers.afterMove(ctx);
  return observed(ctx, `OK — ${caption}; cursor at ${c.x},${c.y}. ${state}${ctx.noteLine}`, true);
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
  if (request.action === "batch") return request.steps?.length ?? 0;
  return isHostAction(request.action) && request.action !== "wait" ? 0 : 1;
}

/**
 * The session's clock keeper. A paced session runs the clock on wall time during a move; a stepped
 * one seeds the target on load and steps exact time after each move, and falls back to pacing —
 * marking the session as not replayable — the first time the target cannot step.
 */
function clockKeeper(caps: TargetCapabilities, options: ComputerSessionOptions) {
  const holds = options.pacing !== ComputerPacing.Running && canPause(caps);
  let stepping = holds && options.pacing === ComputerPacing.Stepped;
  const paced = async (target: ComputerTarget, move: () => Promise<void>, ms: number): Promise<number | null> => {
    const clock = holds ? target.clock : undefined;
    await clock?.start();
    try {
      await move();
      await sleep(ms);
    } finally {
      await clock?.pause();
    }
    return null;
  };
  return {
    deterministic: () => stepping,
    onLoad: async (target: ComputerTarget) => {
      if (stepping) await target.seed?.(options.seed ?? DEFAULT_SEED);
      if (holds) await target.clock?.pause();
    },
    moving: async (target: ComputerTarget, move: () => Promise<void>, ms: number): Promise<number | null> => {
      const step = target.clock?.step;
      if (!stepping || !step) return paced(target, move, ms);
      await move();
      const simulated = await step.call(target.clock, ms);
      if (simulated === null) stepping = false;
      return simulated;
    },
  };
}

/** The session's trace: rows appended beside the frames, and what they add up to. */
function traceKeeper(options: ComputerSessionOptions) {
  const now = options.now ?? Date.now;
  const file = path.join(options.frameDir, TRACE_FILE);
  let started: number | null = null;
  let steps = 0;
  let reachedAt: number | null = null;
  return {
    reachedAt: () => reachedAt,
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
        ...(refused ? { refused: true as const } : {}),
        ...(record.reached ? { reached: true as const } : {}),
      };
      await ensureDir(options.frameDir);
      await appendFile(file, traceLine(row));
    },
    summary: (deterministic: boolean): TraceSummary => ({ path: steps ? file : null, steps, deterministic, reachedAt }),
  };
}

/** The session's helpers over its source, its options and the keepers of its clock and goal. */
function sessionHelpers<T extends ComputerTarget>(
  source: TargetSource<T>,
  options: ComputerSessionOptions,
  state: { root: () => string; loadedAt: () => number; note: { value: string | null } },
  clock: ReturnType<typeof clockKeeper>,
  goal: { reached: boolean },
): SessionHelpers {
  let shots = 0;
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
      const line = `state: ${JSON.stringify(current).slice(0, STATE_CHARS.afterAction)}`;
      if (!options.quest || goal.reached || setupReached(options.quest.until, current) !== true) return line;
      goal.reached = true;
      ctx.record.reached = true;
      return `${line}\nGOAL REACHED (studio-verified): ${options.quest.id}`;
    },
    saveFrame: async (jpeg, name) => {
      await ensureDir(options.frameDir);
      const file = path.join(options.frameDir, `s${++shots}_${safePathSegment(name).slice(0, FRAME_NAME_CHARS)}.jpg`);
      await writeFile(file, jpeg);
      return file;
    },
    frame: (target, jpeg, caption, act) => source.frame(target as T, jpeg, caption, act),
    moving: clock.moving,
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
    record: { route: null, frame: null, simMs: null, reached: false },
  };
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
  const note = { value: null as string | null };
  const goal = { reached: false };
  const clock = clockKeeper(source.caps, options);
  const trace = traceKeeper(options);
  const ensureLoaded = sharedLoad(async (force: boolean): Promise<TargetLoad<T>> => {
    const loaded = await source.load(root, force);
    if (!loaded.fresh || loaded.problem) return loaded;
    await clock.onLoad(loaded.target);
    loadedAt = Date.now();
    note.value = loaded.note;
    return loaded;
  });
  const helpers = sessionHelpers(source, options, { root: () => root, loadedAt: () => loadedAt, note }, clock, goal);
  const refuse = async (request: ComputerRequest, sentence: string): Promise<LiveToolResult> => {
    await trace.write(
      request,
      describeComputerAction(request),
      { route: null, frame: null, simMs: null, reached: false },
      null,
      true,
    );
    return sentence;
  };
  const run = async (name: string, args: Record<string, unknown>): Promise<LiveToolResult> => {
    if (name !== COMPUTER_TOOL_NAME) return `unknown tool ${name}`;
    const parsed = parseComputerArgs(args);
    if (!parsed.ok) return parsed.error;
    const request = parsed.request;
    const refused = unsupportedAction(request.action, source.caps);
    if (refused) return refuse(request, refused);
    const cost = movesOf(request);
    if (options.maxActions !== undefined && moves + cost > options.maxActions) {
      return refuse(request, COMPUTER_ARG_PROBLEM.budgetSpent(options.maxActions));
    }
    moves += cost;
    const loaded = await ensureLoaded(request.action === "reload");
    if (loaded.problem) return loaded.problem;
    const ctx = actionContext(request, loaded, loaded.note ?? note.value, helpers);
    const answer = await (isHostAction(request.action) ? HOST_ACTIONS[request.action](ctx) : input(ctx));
    await trace.write(request, ctx.caption, ctx.record, loaded.target.pointer(), false);
    return answer;
  };
  return {
    run,
    ensureLoaded,
    root: () => root,
    retarget: (next) => {
      root = next;
    },
    trace: () => trace.summary(options.pacing === ComputerPacing.Stepped && clock.deterministic()),
  };
}

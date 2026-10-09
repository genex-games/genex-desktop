/**
 * The computer session: the studio's referee between a model and a target. It parses the action,
 * loads the target, refuses what the target cannot do, holds the clock still between a paced
 * role's moves, and answers every action — looking, waiting and the studio verbs here, input
 * through the target — leaving a frame on the agent's screen each time.
 *
 * Generic over {@link ComputerTarget}: the browser window, a Play Protocol game and every target
 * added later share this one implementation. What is particular to a target (how it loads, how
 * its frames reach the agent screen) comes in through a {@link TargetSource}.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ScreenAct } from "../../shared/agent-screen.ts";
import { canPause, type TargetCapabilities } from "../../shared/computer-target.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { CaptureSurface } from "../../shared/preview-contract.ts";
import {
  COMPUTER_TOOL_NAME,
  type ComputerHostAction,
  type ComputerRequest,
  computerAct,
  computerToInput,
  describeComputerAction,
  parseComputerArgs,
  unsupportedAction,
} from "../../substrate/computer-tool.ts";
import type { ComputerTarget, TargetLoad } from "../../substrate/computer-target.ts";
import type { LiveToolResult } from "../../substrate/engines/types.ts";
import { ensureDir } from "../../substrate/fsx.ts";
import { CAMERA_SETTLE_MS, DEFAULT_SHOT_QUALITY, requestedSurface, surfaceWord } from "./capture.ts";
import { safePathSegment } from "./run-shots.ts";

/** How long an input settles before the state is read back. */
const INPUT_SETTLE_MS = 120;
/** Characters of the game's state in an answer: after an action, by default, and when asked for. */
const STATE_CHARS = { afterAction: 600, default: 1_200, asked: 4_000 } as const;
/** How many of the latest console errors an answer lists. */
const CONSOLE_ERRORS_SHOWN = 12;
/** Characters of an action's name kept in a frame's file name. */
const FRAME_NAME_CHARS = 40;

/** What a session needs from the kind of target it drives: how it loads, and where its frames go. */
export interface TargetSource<T extends ComputerTarget = ComputerTarget> {
  readonly caps: TargetCapabilities;
  /**
   * The target, loaded with the build at `root` — reloaded when forced. `fresh` says this call
   * loaded it, so the session can stand a paced clock still before the first move.
   */
  load(root: string, force: boolean): Promise<TargetLoad<T> & { fresh: boolean }>;
  /** A picture of the target for the agent's screen; null asks the source to take its own. */
  frame(target: T, jpeg: Buffer | null, caption: string, act: ScreenAct): Promise<void>;
}

/** How a session behaves: whose clock it holds and where its frames are saved. */
export interface ComputerSessionOptions {
  /** Stand the target's clock still between moves (a playtester, a judge). */
  paced: boolean;
  /** The folder every frame of this session is saved into. */
  frameDir: string;
}

/** One session on one target: its tool call, its shared load, and the build it shows. */
export interface ComputerSession<T extends ComputerTarget = ComputerTarget> {
  run(name: string, args: Record<string, unknown>): Promise<LiveToolResult>;
  ensureLoaded(force?: boolean): Promise<TargetLoad<T>>;
  root(): string;
  retarget(root: string): void;
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
  /** What the studio says about the surface asked for, on its own line above the answer. */
  surfaceLine: string;
  helpers: SessionHelpers;
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
  readonly saveFrame: (jpeg: Buffer, name: string) => Promise<string>;
  readonly frame: (target: ComputerTarget, jpeg: Buffer | null, caption: string, act: ScreenAct) => Promise<void>;
  /** Run the target's clock for one move, then stand it still again when the session is paced. */
  readonly moving: <R>(target: ComputerTarget, move: () => Promise<R>) => Promise<R>;
}

async function look(ctx: ActionContext): Promise<LiveToolResult> {
  const { request, target, helpers } = ctx;
  const warning = request.action === "camera" ? await switchCamera(target, request.text) : "";
  const shot = await target.screenshot({ quality: DEFAULT_SHOT_QUALITY, surface: ctx.surface });
  const { jpeg, stats } = shot;
  const file = await helpers.saveFrame(jpeg, request.action === "camera" ? `cam-${request.text}` : "screen");
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
  const took = surfaceWord(surface === CaptureSurface.Auto ? null : surface);
  const tookText = took ? ` (${took})` : "";
  return {
    text: `${ctx.surfaceLine}${file} — region ${z.region.map(Math.round).join(",")} of the ${size.width}×${size.height} frame${tookText}, shown at ${z.width}×${z.height}; coordinates stay those of the whole frame`,
    images: [{ mimeType: "image/jpeg", data: z.jpeg.toString("base64"), label: ctx.caption }],
  };
}

async function wait(ctx: ActionContext): Promise<LiveToolResult> {
  const seconds = ctx.request.duration ?? 1;
  await ctx.helpers.moving(ctx.target, () => sleep(Math.round(seconds * SECOND_MS)));
  await ctx.helpers.frame(ctx.target, null, ctx.caption, ctx.act);
  return `waited ${seconds}s — ${await ctx.helpers.stateText(ctx.target, STATE_CHARS.afterAction)}${ctx.noteLine}`;
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
};

function isHostAction(action: string): action is ComputerHostAction {
  return Object.hasOwn(HOST_ACTIONS, action);
}

/** An input action: carried out by the target, then the state read back. */
async function input(ctx: ActionContext): Promise<LiveToolResult> {
  const { target, helpers, caption } = ctx;
  const actions = computerToInput(ctx.request, helpers.cursor(target, ctx.size));
  if (!actions.length) return `${ctx.request.action}: nothing to do (${caption})`;
  await helpers.moving(target, async () => {
    await target.input(actions);
    await sleep(INPUT_SETTLE_MS);
  });
  await helpers.frame(target, null, caption, ctx.act);
  const c = helpers.cursor(target, ctx.size);
  const state = await helpers.stateText(target, STATE_CHARS.afterAction);
  return `OK — ${caption}; cursor at ${c.x},${c.y}. ${state}${ctx.noteLine}\nScreenshot to see the result.`;
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

/**
 * A computer session over one target source, starting on the build at `initialRoot`. Loaded on
 * the first action, then kept running between actions so a map the worker switched to stays
 * switched — except for a paced session, whose clock runs only during its moves.
 */
export function computerSession<T extends ComputerTarget>(
  source: TargetSource<T>,
  initialRoot: string,
  options: ComputerSessionOptions,
): ComputerSession<T> {
  let root = initialRoot;
  let shots = 0;
  let loadedAt = 0;
  let lastSetupNote: string | null = null;
  const holdsClock = options.paced && canPause(source.caps);
  const ensureLoaded = sharedLoad(async (force: boolean): Promise<TargetLoad<T>> => {
    const loaded = await source.load(root, force);
    if (!loaded.fresh || loaded.problem) return loaded;
    if (holdsClock) await loaded.target.clock?.pause();
    loadedAt = Date.now();
    lastSetupNote = loaded.note;
    return loaded;
  });
  const helpers: SessionHelpers = {
    root: () => root,
    loadedAt: () => loadedAt,
    setupNote: () => lastSetupNote,
    clearSetupNote: () => {
      lastSetupNote = null;
    },
    cursor: (target, size) => target.pointer() ?? centre(size),
    stateText: async (target, max = STATE_CHARS.default) => {
      const state = target.state ? await target.state().catch(() => null) : null;
      return `state: ${JSON.stringify(state ?? { __missing: true }).slice(0, max)}`;
    },
    saveFrame: async (jpeg, name) => {
      await ensureDir(options.frameDir);
      const file = path.join(options.frameDir, `s${++shots}_${safePathSegment(name).slice(0, FRAME_NAME_CHARS)}.jpg`);
      await writeFile(file, jpeg);
      return file;
    },
    frame: (target, jpeg, caption, act) => source.frame(target as T, jpeg, caption, act),
    moving: async (target, move) => {
      if (!holdsClock || !target.clock) return move();
      await target.clock.start();
      try {
        return await move();
      } finally {
        await target.clock.pause();
      }
    },
  };
  const run = async (name: string, args: Record<string, unknown>): Promise<LiveToolResult> => {
    if (name !== COMPUTER_TOOL_NAME) return `unknown tool ${name}`;
    const parsed = parseComputerArgs(args);
    if (!parsed.ok) return parsed.error;
    const request = parsed.request;
    const refused = unsupportedAction(request.action, source.caps);
    if (refused) return refused;
    const { target, problem, note } = await ensureLoaded(request.action === "reload");
    if (problem) return problem;
    const setupNote = note ?? lastSetupNote;
    // Which picture this look takes. An unparseable surface is never a refusal — the studio
    // picks and says so on the line above the answer, because a turn spent arguing about a
    // flag costs the engine that cannot see the image more than the picture is worth.
    const ctx: ActionContext = {
      request,
      target,
      size: target.viewSize(),
      caption: describeComputerAction(request),
      act: computerAct(request),
      note,
      noteLine: setupNote ? `\nnote: ${setupNote}` : "",
      surface: requestedSurface(request),
      surfaceLine: request.surfaceNote ? `${request.surfaceNote}\n` : "",
      helpers,
    };
    return isHostAction(request.action) ? HOST_ACTIONS[request.action](ctx) : input(ctx);
  };
  return {
    run,
    ensureLoaded,
    root: () => root,
    retarget: (next) => {
      root = next;
    },
  };
}

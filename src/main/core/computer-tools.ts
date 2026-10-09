/**
 * The computer: hands and eyes on one pooled window for a whole
 * session. Actions are Anthropic's computer vocabulary plus the studio's own verbs; the input
 * actions become input events on the preview, and the host actions (looking, waiting, the studio
 * verbs) are answered here, each by its own handler. Every action leaves a frame on the agent's screen.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type AgentScreen, type AgentScreenRole, type ScreenAct, ScreenDeed } from "../../shared/agent-screen.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import {
  COMPUTER_TOOL_NAME,
  COMPUTER_VIEW,
  type ComputerHostAction,
  type ComputerRequest,
  computerAct,
  computerToInput,
  computerToolDefinition,
  describeComputerAction,
  parseComputerArgs,
} from "../../substrate/computer-tool.ts";
import type { DelegateRequest, LiveToolResult } from "../../substrate/engines/types.ts";
import type { PreviewPort } from "../../substrate/preview-port.ts";
import type { ComputerToolRole } from "../../substrate/computer-tool-prompts.ts";
import { ensureDir } from "../../substrate/fsx.ts";
import { LIVE_HANDLE } from "../../substrate/preview-pool.ts";
import { CAMERA_SETTLE_MS, DEFAULT_SHOT_QUALITY, captureSurface, requestedSurface, surfaceWord } from "./capture.ts";
import type { PreviewService } from "./previews.ts";
import { iterationDir, safePathSegment } from "./run-shots.ts";
import type { SessionPort } from "./session-port.ts";
import { CaptureSurface, GameClock } from "../../shared/preview-contract.ts";

/** How long an input settles before the state is read back. */
const INPUT_SETTLE_MS = 120;
/** Characters of the game's state in an answer: after an action, by default, and when asked for. */
const STATE_CHARS = { afterAction: 600, default: 1_200, asked: 4_000 } as const;
/** How many of the latest console errors an answer lists. */
const CONSOLE_ERRORS_SHOWN = 12;
/** Characters of an action's name kept in a frame's file name. */
const FRAME_NAME_CHARS = 40;

/** The tool's own wording for each screen role; a judge (or anything else) is told it plays. */
const TOOL_ROLE: Record<AgentScreenRole, ComputerToolRole> = {
  builder: "builder",
  scout: "scout",
  director: "director",
  playtester: "playtester",
  judge: "playtester",
};

/**
 * The roles that play a build to judge it: they take seconds to look and decide, so the game's clock
 * stands still between their moves (golden-boot-glory: one key press ran four match minutes).
 */
const PACED_ROLES: ReadonlySet<AgentScreenRole> = new Set(["playtester", "judge"]);

/**
 * The roles that meet the game's own title and menu as a player does: the studio never begins
 * play for them, whatever setup an older seed sends (`PreviewService.applySetup` `keepFrontEnd`).
 */
const FRONT_END_ROLES: ReadonlySet<AgentScreenRole> = new Set(["playtester"]);

/** Who holds the computer, and on which build: a playtest grant with any screen role. */
export type ComputerGrant = Omit<NonNullable<DelegateRequest["playtest"]>, "role"> & { role?: AgentScreen["role"] };

/** A load of the build into the window: the port, and what went wrong or is worth saying. */
export interface ComputerLoad {
  port: PreviewPort;
  problem: string | null;
  note: string | null;
}

export interface ComputerTools {
  liveTools: NonNullable<DelegateRequest["liveTools"]>;
  onLiveTool: NonNullable<DelegateRequest["onLiveTool"]>;
  ensureLoaded: (force?: boolean) => Promise<ComputerLoad>;
  screen: () => AgentScreen;
  /** The build the window shows; the director's `look` moves it. */
  root: () => string;
  retarget: (root: string) => void;
}

/** Everything a host action reads: the request, the window, and the session's helpers. */
interface ActionContext {
  request: ComputerRequest;
  port: PreviewPort;
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
  session: ComputerSession;
}

type HostActionHandler = (ctx: ActionContext) => Promise<LiveToolResult>;

/** A session's state and the helpers its actions share. */
interface ComputerSession {
  readonly root: () => string;
  readonly loadedAt: () => number;
  /** The note of the last load, until a look has shown it. */
  readonly setupNote: () => string | null;
  readonly clearSetupNote: () => void;
  readonly cursor: (port: PreviewPort, size: { width: number; height: number }) => { x: number; y: number };
  readonly stateText: (port: PreviewPort, max?: number) => Promise<string>;
  readonly saveFrame: (jpeg: Buffer, name: string) => Promise<string>;
  readonly frame: (port: PreviewPort, jpeg: Buffer | null, caption: string, act: ScreenAct) => Promise<void>;
  /** Run the game's clock for one move, then stand it still again when the session is paced. */
  readonly moving: <T>(port: PreviewPort, move: () => Promise<T>) => Promise<T>;
}

async function look(ctx: ActionContext): Promise<LiveToolResult> {
  const { request, port, session } = ctx;
  const warning = request.action === "camera" ? await switchCamera(port, request.text) : "";
  const shot = await captureSurface(port, DEFAULT_SHOT_QUALITY, ctx.surface);
  const { jpeg, stats } = shot;
  const file = await session.saveFrame(jpeg, request.action === "camera" ? `cam-${request.text}` : "screen");
  await session.frame(port, jpeg, ctx.caption, ctx.act);
  const c = session.cursor(port, ctx.size);
  session.clearSetupNote();
  const took = surfaceWord(shot.surface);
  const tookText = took ? ` (${took})` : "";
  const measured = stats ? `, litFraction ${stats.litFraction.toFixed(2)}, meanLuma ${Math.round(stats.meanLuma)}` : "";
  return {
    text: `${ctx.surfaceLine}${file} — ${ctx.size.width}×${ctx.size.height}${tookText}, cursor at ${c.x},${c.y}${measured}${warning}${ctx.noteLine}`,
    images: [{ mimeType: "image/jpeg", data: jpeg.toString("base64"), label: ctx.caption }],
  };
}

/** Point the game's debug camera; a camera the game does not know is a warning, never a refusal. */
async function switchCamera(port: PreviewPort, camera: string | undefined): Promise<string> {
  let warning = "";
  const placed = (await port.studioCall("debugCamera", camera).catch(() => null)) as {
    ok?: boolean;
    reason?: string;
    available?: string[];
  } | null;
  const refused = typeof placed === "object" && placed?.ok === false;
  if (refused) {
    const why = placed.reason ?? `available: ${(placed.available ?? []).join(", ") || "none"}`;
    warning = ` — WARNING: camera "${camera}" is not registered (${why}); this is the current view instead`;
  }
  await sleep(CAMERA_SETTLE_MS);
  return warning;
}

async function zoom(ctx: ActionContext): Promise<LiveToolResult> {
  const { request, port, size, surface } = ctx;
  const zoomer = port.zoom;
  if (!zoomer || !request.region) return "zoom is not available on this preview — take a screenshot instead";
  const z = await zoomer.call(port, request.region, undefined, { surface });
  const file = await ctx.session.saveFrame(z.jpeg, "zoom");
  const took = surfaceWord(surface === CaptureSurface.Auto ? null : surface);
  const tookText = took ? ` (${took})` : "";
  return {
    text: `${ctx.surfaceLine}${file} — region ${z.region.map(Math.round).join(",")} of the ${size.width}×${size.height} frame${tookText}, shown at ${z.width}×${z.height}; coordinates stay those of the whole frame`,
    images: [{ mimeType: "image/jpeg", data: z.jpeg.toString("base64"), label: ctx.caption }],
  };
}

async function wait(ctx: ActionContext): Promise<LiveToolResult> {
  const seconds = ctx.request.duration ?? 1;
  await ctx.session.moving(ctx.port, () => sleep(Math.round(seconds * SECOND_MS)));
  await ctx.session.frame(ctx.port, null, ctx.caption, ctx.act);
  return `waited ${seconds}s — ${await ctx.session.stateText(ctx.port, STATE_CHARS.afterAction)}${ctx.noteLine}`;
}

async function consoleErrors(ctx: ActionContext): Promise<LiveToolResult> {
  const errors = ctx.port.consoleEntries(ctx.session.loadedAt()).filter((entry) => entry.level === "error");
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
    const c = ctx.session.cursor(ctx.port, ctx.size);
    return `X=${c.x}, Y=${c.y}`;
  },
  wait,
  state: async (ctx) => `${await ctx.session.stateText(ctx.port, STATE_CHARS.asked)}${ctx.noteLine}`,
  console: consoleErrors,
  reload: async (ctx) => {
    const noted = ctx.note ? ` — ${ctx.note}` : "";
    const state = await ctx.session.stateText(ctx.port, STATE_CHARS.afterAction);
    return `reloaded ${path.basename(ctx.session.root())}${noted} — ${state}`;
  },
};

function isHostAction(action: string): action is ComputerHostAction {
  return Object.hasOwn(HOST_ACTIONS, action);
}

/** An input action: sent to the page as input events, then the state read back. */
async function input(ctx: ActionContext): Promise<LiveToolResult> {
  const { port, session, caption } = ctx;
  const actions = computerToInput(ctx.request, session.cursor(port, ctx.size));
  if (!actions.length) return `${ctx.request.action}: nothing to do (${caption})`;
  await session.moving(port, async () => {
    await port.input(actions);
    await sleep(INPUT_SETTLE_MS);
  });
  await session.frame(port, null, caption, ctx.act);
  const c = session.cursor(port, ctx.size);
  const state = await session.stateText(port, STATE_CHARS.afterAction);
  return `OK — ${caption}; cursor at ${c.x},${c.y}. ${state}${ctx.noteLine}\nScreenshot to see the result.`;
}

/** Stand the game's clock still; a page with no clock to pause keeps running. */
async function stillClock(port: PreviewPort): Promise<void> {
  await port.studioCall(GameClock.Pause).catch(() => null);
}

/** One computer call: parsed, the build loaded (reloaded when asked), then answered by its action. */
async function runComputerTool(
  name: string,
  args: Record<string, unknown>,
  ensureLoaded: (force?: boolean) => Promise<ComputerLoad>,
  session: ComputerSession,
): Promise<LiveToolResult> {
  if (name !== COMPUTER_TOOL_NAME) return `unknown tool ${name}`;
  const parsed = parseComputerArgs(args);
  if (!parsed.ok) return parsed.error;
  const request = parsed.request;
  const { port, problem, note } = await ensureLoaded(request.action === "reload");
  if (problem) return problem;
  const setupNote = note ?? session.setupNote();
  // Which picture this look takes. An unparseable surface is never a refusal — the studio
  // picks and says so on the line above the answer, because a turn spent arguing about a
  // flag costs the engine that cannot see the image more than the picture is worth.
  const ctx: ActionContext = {
    request,
    port,
    size: port.viewSize?.() ?? COMPUTER_VIEW,
    caption: describeComputerAction(request),
    act: computerAct(request),
    note,
    noteLine: setupNote ? `\nnote: ${setupNote}` : "",
    surface: requestedSurface(request),
    surfaceLine: request.surfaceNote ? `${request.surfaceNote}\n` : "",
    session,
  };
  return isHostAction(request.action) ? HOST_ACTIONS[request.action](ctx) : input(ctx);
}

/**
 * A load that concurrent callers share: parallel state/console requests share the first
 * navigation, rather than aborting each other. A forced load waits for the one in flight, then runs.
 */
function sharedLoad(load: (force: boolean) => Promise<ComputerLoad>): (force?: boolean) => Promise<ComputerLoad> {
  let loading: Promise<ComputerLoad> | null = null;
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

/**
 * The computer on one session's window — the builder's worktree, the playtester's build under
 * test, the scout's live folder. Loaded once through the served entry, the setup script applied,
 * then kept running between actions so a map the worker switched to stays switched — except for a
 * playtester's or judge's, whose clock runs only during its moves (`PACED_ROLES`).
 */
export function computerTools(
  previews: PreviewService,
  grant: ComputerGrant,
  initialRoot: string,
  outDir: string,
  sessionPort: SessionPort,
): ComputerTools {
  let root = initialRoot;
  const role: AgentScreen["role"] = grant.role ?? "builder";
  const paced = PACED_ROLES.has(role);
  const label = grant.label ?? grant.facetId ?? grant.project;
  const iterDir = iterationDir(outDir, grant.iteration);
  let shots = 0;
  let loadedAt = 0;
  let lastSetupNote: string | null = null;
  const screen = (): AgentScreen => ({
    handle: sessionPort.handle() ?? LIVE_HANDLE,
    label,
    project: grant.project,
    runId: grant.runId ?? null,
    facetId: grant.facetId ?? null,
    role,
  });
  const loadOnce = async (force = false): Promise<ComputerLoad> => {
    const window = await sessionPort.get();
    const alreadyLoaded = !force && sessionPort.loaded?.root === root;
    if (alreadyLoaded) return { port: window, problem: null, note: null };
    const loaded = await previews.loadServed(window, grant.project, root, grant.entry);
    if (loaded.problem) {
      sessionPort.loaded = null;
      return { port: window, problem: `the build failed to load: ${loaded.problem}`, note: null };
    }
    const applied = await previews.applySetup(window, grant.setup, { keepFrontEnd: FRONT_END_ROLES.has(role) });
    if (paced) await stillClock(window);
    const note = [loaded.note, applied].filter(Boolean).join("; ") || null;
    sessionPort.loaded = { root, at: Date.now() };
    loadedAt = Date.now();
    lastSetupNote = note;
    previews.openScreen(screen());
    await previews.frame(window, screen(), null, "loaded", { deed: ScreenDeed.Load });
    return { port: window, problem: null, note };
  };
  const ensureLoaded = sharedLoad(loadOnce);
  const moving = async <T>(window: PreviewPort, move: () => Promise<T>): Promise<T> => {
    if (!paced) return move();
    await window.studioCall(GameClock.Start).catch(() => null);
    try {
      return await move();
    } finally {
      await stillClock(window);
    }
  };
  const session: ComputerSession = {
    root: () => root,
    loadedAt: () => loadedAt,
    setupNote: () => lastSetupNote,
    clearSetupNote: () => {
      lastSetupNote = null;
    },
    cursor: (window, size) => window.pointer?.() ?? { x: Math.round(size.width / 2), y: Math.round(size.height / 2) },
    stateText: async (window, max = STATE_CHARS.default) => {
      const state = await window.studioState().catch(() => null);
      return `state: ${JSON.stringify(state ?? { __missing: true }).slice(0, max)}`;
    },
    saveFrame: async (jpeg, name) => {
      await ensureDir(iterDir);
      const file = path.join(iterDir, `s${++shots}_${safePathSegment(name).slice(0, FRAME_NAME_CHARS)}.jpg`);
      await writeFile(file, jpeg);
      return file;
    },
    frame: (window, jpeg, caption, act) => previews.frame(window, screen(), jpeg, caption, act),
    moving,
  };
  return {
    liveTools: [computerToolDefinition({ role: Object.hasOwn(TOOL_ROLE, role) ? TOOL_ROLE[role] : "playtester" })],
    onLiveTool: (name, args) => runComputerTool(name, args, ensureLoaded, session),
    ensureLoaded,
    screen,
    root: () => root,
    retarget: (next: string) => {
      root = next;
    },
  };
}

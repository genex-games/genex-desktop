/**
 * The computer on a delegation's pooled window: who holds it (the role), which build it shows, and
 * how the studio's own browser window loads that build. Everything an action does — parsing,
 * refusing what the target cannot do, looking, input — is the generic
 * {@link computerSession}; this module is its browser source (`browser-preview-target.ts`), or,
 * for a game whose studio.json declares the `bridge` runtime, the Play Protocol source
 * (`game-bridge-target.ts`), or, for a game played in its engine's editor, the engine plugin's
 * play tools (`editor-play-target.ts`).
 */
import { type AgentScreen, type AgentScreenRole, ScreenDeed } from "../../shared/agent-screen.ts";
import {
  BROWSER_CAPABILITIES,
  ComputerPacing,
  type ComputerTraceSummary,
  type GameRuntime,
  type TargetCapabilities,
  TargetRuntime,
} from "../../shared/computer-target.ts";
import { computerToolDefinition } from "../../substrate/computer-tool.ts";
import type { DelegateCaptureGrant, DelegateRequest } from "../../substrate/engines/types.ts";
import type { PreviewPort } from "../../substrate/preview-port.ts";
import type { ComputerToolRole } from "../../substrate/computer-tool-prompts.ts";
import { LIVE_HANDLE } from "../../substrate/preview-pool.ts";
import { CaptureSurface } from "../../shared/preview-contract.ts";
import type { ProcessSandbox } from "../../substrate/spawn.ts";
import type { ComputerTarget } from "../../substrate/computer-target.ts";
import { type BrowserPreviewTarget, browserPreviewTarget } from "./browser-preview-target.ts";
import {
  type ComputerSession,
  type ComputerSessionOptions,
  computerSession,
  type TargetSource,
} from "./computer-session.ts";
import { type EngineLauncher, gameBridgeSource } from "./game-bridge-target.ts";
import { type EnginePlayCall, editorPlaySource } from "./editor-play-target.ts";
import type { FramePort, PreviewService } from "./previews.ts";
import { iterationDir } from "./run-shots.ts";
import type { SessionPort } from "./session-port.ts";

/** The tool's own wording for each screen role. */
const TOOL_ROLE: Record<AgentScreenRole, ComputerToolRole> = {
  builder: "builder",
  director: "director",
  operator: "operator",
};

/** Who holds the computer, and on which build: a capture grant with its screen role. */
export type ComputerGrant = DelegateCaptureGrant & { role?: AgentScreen["role"] };

/**
 * A load of the build: the browser window's port (null for a game with no browser window), and
 * what went wrong or is worth saying.
 */
export interface ComputerLoad {
  port: PreviewPort | null;
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
  /** What the session's trace adds up to so far. */
  trace: () => ComputerTraceSummary;
  /** How the game runs: the browser window, or its own Play Protocol process. */
  runtime: TargetRuntime;
  /** Stop what the computer started: a Play Protocol game's process. The browser window is the session's. */
  release: () => Promise<void>;
}

/** How a delegation's session runs: on a running game, its frames in `frameDir`. */
const sessionOptionsFor = (frameDir: string): ComputerSessionOptions => ({ pacing: ComputerPacing.Running, frameDir });

/** The quality of a frame a target that is no preview window takes for the agent's screen. */
const TARGET_FRAME_QUALITY = 60;

/**
 * A target that is no preview window, read as one by the agent screen: its picture, its size and
 * its pointer, so a Play Protocol game's moves are drawn on the worker's node as a browser game's are.
 */
export function targetFramePort(target: ComputerTarget): FramePort {
  const centre = () => {
    const size = target.viewSize();
    return { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
  };
  return {
    screenshot: async (quality = TARGET_FRAME_QUALITY) =>
      (await target.screenshot({ quality, surface: CaptureSurface.Auto })).jpeg,
    viewSize: () => target.viewSize(),
    pointer: () => target.pointer() ?? centre(),
  };
}

/** What else a computer may need: a sandbox to start a Play Protocol game in, or the engine plugin's play tools. */
export interface ComputerToolsOptions {
  /**
   * Set when the build's studio.json declares the `bridge` runtime: its game is started here, or by
   * `engine` when its play names an engine a plugin runs (an engine draws: a window and the GPU).
   */
  bridge?: { sandbox: Pick<ProcessSandbox, "spawnLongLived">; engine?: EngineLauncher };
  /**
   * Set when the game is played in its engine's editor: the engine plugin's play tools, what its
   * declaration says the play can do (known before play opens, so the tool is described from it),
   * and a step run once right after the play opens.
   */
  editor?: {
    call: EnginePlayCall;
    caps?: TargetCapabilities;
    afterOpen?: (opened: unknown) => Promise<void>;
  };
}

/** The runtimes a computer is built for: those a game declares, and its engine's editor. */
type ToolsRuntime = GameRuntime | typeof TargetRuntime.Editor;

/** The tools over one session, whatever its target: the tool definition, its calls, its load and its trace. */
function toolsOver<T extends ComputerTarget>(
  session: ComputerSession<T>,
  parts: {
    caps: TargetCapabilities;
    toolRole: ComputerToolRole;
    screen: () => AgentScreen;
    portOf: (target: T) => PreviewPort | null;
    release: () => Promise<void>;
  },
): ComputerTools {
  // A Play Protocol game says what it can do only once it runs, so its tool offers what such a game may do.
  const definition = computerToolDefinition({ role: parts.toolRole, capabilities: parts.caps });
  return {
    liveTools: [definition],
    onLiveTool: (name, args) => session.run(name, args),
    ensureLoaded: async (force = false) => {
      const loaded = await session.ensureLoaded(force);
      return { port: parts.portOf(loaded.target), problem: loaded.problem, note: loaded.note };
    },
    screen: parts.screen,
    root: () => session.root(),
    retarget: (next: string) => session.retarget(next),
    trace: () => session.trace(),
    runtime: parts.caps.runtime,
    release: parts.release,
  };
}

/**
 * The studio's own browser window as a target source: the session's pooled window, loaded through
 * the served entry with the setup script applied, and its frames sent to the agent's screen.
 */
function browserSource(
  previews: PreviewService,
  grant: ComputerGrant,
  sessionPort: SessionPort,
  screen: () => AgentScreen,
): TargetSource<BrowserPreviewTarget> {
  return {
    caps: BROWSER_CAPABILITIES,
    load: async (root, force) => {
      const window = await sessionPort.get();
      const target = browserPreviewTarget(window);
      const alreadyLoaded = !force && sessionPort.loaded?.root === root;
      if (alreadyLoaded) return { target, problem: null, note: null, fresh: false };
      const loaded = await previews.loadServed(window, grant.project, root, grant.entry);
      if (loaded.problem) {
        sessionPort.loaded = null;
        return { target, problem: `the build failed to load: ${loaded.problem}`, note: null, fresh: true };
      }
      const applied = await previews.applySetup(window, grant.setup);
      const note = [loaded.note, applied].filter(Boolean).join("; ") || null;
      sessionPort.loaded = { root, at: Date.now() };
      previews.openScreen(screen());
      await previews.frame(window, screen(), null, "loaded", { deed: ScreenDeed.Load });
      return { target, problem: null, note, fresh: true };
    },
    frame: (target, jpeg, caption, act) => previews.frame(target.port, screen(), jpeg, caption, act),
  };
}

/** Which runtime a computer is built for: the engine's editor, a Play Protocol game, or the browser window. */
function toolsRuntime(options: ComputerToolsOptions): ToolsRuntime {
  if (options.editor) return TargetRuntime.Editor;
  return options.bridge ? TargetRuntime.Bridge : TargetRuntime.Browser;
}

/**
 * The computer on one session's window — the builder's worktree, the lead's build. Loaded once
 * through the served entry, the setup script applied, then kept running between actions so a map
 * the worker switched to stays switched.
 */
export function computerTools(
  previews: PreviewService,
  grant: ComputerGrant,
  initialRoot: string,
  outDir: string,
  sessionPort: SessionPort,
  options: ComputerToolsOptions = {},
): ComputerTools {
  const role: AgentScreen["role"] = grant.role ?? "builder";
  const label = grant.label ?? grant.facetId ?? grant.project;
  const screen = (): AgentScreen => ({
    handle: sessionPort.handle() ?? LIVE_HANDLE,
    label,
    project: grant.project,
    runId: grant.runId ?? null,
    facetId: grant.facetId ?? null,
    role,
  });
  const sessionOptions = sessionOptionsFor(iterationDir(outDir, grant.iteration));
  const toolRole = Object.hasOwn(TOOL_ROLE, role) ? TOOL_ROLE[role] : TOOL_ROLE.builder;
  const shared = { toolRole, screen };
  const runtime = toolsRuntime(options);
  const deps: SourceDeps = { previews, grant, sessionPort, screen, options };
  return TARGET_SOURCES[runtime](deps, (source, parts) =>
    toolsOver(computerSession(source, initialRoot, sessionOptions), { ...shared, ...parts }),
  );
}

/** What any target source is built from: the previews, the grant, the window and the extras. */
interface SourceDeps {
  previews: PreviewService;
  grant: ComputerGrant;
  sessionPort: SessionPort;
  screen: () => AgentScreen;
  options: ComputerToolsOptions;
}

/** Builds the tools over a source once its runtime-specific parts are known. */
type ToolsBuilder = <T extends ComputerTarget>(
  source: TargetSource<T>,
  parts: { caps: TargetCapabilities; portOf: (target: T) => PreviewPort | null; release: () => Promise<void> },
) => ComputerTools;

/**
 * One row per game runtime: how its target source is made. A new kind of game target is a new
 * runtime and a new row here; the desktop and a VM, which no game declares, are built by
 * `desktop-tools.ts` over the same session. The session, the tool and every engine stay as they are.
 */
const TARGET_SOURCES: Record<ToolsRuntime, (deps: SourceDeps, build: ToolsBuilder) => ComputerTools> = {
  [TargetRuntime.Browser]: (deps, build) => {
    const source = browserSource(deps.previews, deps.grant, deps.sessionPort, deps.screen);
    return build(source, { caps: source.caps, portOf: (target) => target.port, release: async () => {} });
  },
  [TargetRuntime.Bridge]: (deps, build) => {
    const sandbox = deps.options.bridge?.sandbox;
    if (!sandbox) return TARGET_SOURCES[TargetRuntime.Browser](deps, build);
    const engine = deps.options.bridge?.engine;
    const source = gameBridgeSource({
      sandbox,
      ...(engine ? { engine } : {}),
      frame: (target, jpeg, caption, act) => {
        deps.previews.openScreen(deps.screen());
        return deps.previews.frame(targetFramePort(target), deps.screen(), jpeg, caption, act);
      },
    });
    return build(source, { caps: source.caps, portOf: () => null, release: source.release });
  },
  [TargetRuntime.Editor]: (deps, build) => {
    const editor = deps.options.editor;
    if (!editor) return TARGET_SOURCES[TargetRuntime.Browser](deps, build);
    const source = editorPlaySource({
      ...editor,
      frame: (target, jpeg, caption, act) => {
        deps.previews.openScreen(deps.screen());
        return deps.previews.frame(targetFramePort(target), deps.screen(), jpeg, caption, act);
      },
    });
    return build(source, { caps: source.caps, portOf: () => null, release: source.release });
  },
};

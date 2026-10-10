/**
 * The computer on a delegation's pooled window: who holds it (the role), which build it shows, and
 * how the studio's own browser window loads that build. Everything an action does — parsing,
 * refusing what the target cannot do, pacing the clock, looking, input — is the generic
 * {@link computerSession}; this module is its browser source (`browser-preview-target.ts`), or,
 * for a game whose studio.json declares the `bridge` runtime, the Play Protocol source
 * (`game-bridge-target.ts`).
 */
import { type AgentScreen, type AgentScreenRole, ScreenDeed, ScreenRole } from "../../shared/agent-screen.ts";
import {
  BROWSER_CAPABILITIES,
  ComputerPacing,
  type ComputerTraceSummary,
  StateLevel,
  type TargetCapabilities,
  TargetRuntime,
} from "../../shared/computer-target.ts";
import { computerToolDefinition, normalizeSetup } from "../../substrate/computer-tool.ts";
import type { DelegateRequest } from "../../substrate/engines/types.ts";
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
import { gameBridgeSource } from "./game-bridge-target.ts";
import type { FramePort, PreviewService } from "./previews.ts";
import { iterationDir } from "./run-shots.ts";
import { markVerified } from "./verified-traces.ts";
import type { SessionPort } from "./session-port.ts";

/** The tool's own wording for each screen role; a judge (or anything else) is told it plays. */
const TOOL_ROLE: Record<AgentScreenRole, ComputerToolRole> = {
  builder: "builder",
  scout: "scout",
  director: "director",
  playtester: "playtester",
  judge: "judge",
};

/**
 * The roles that play a build to judge it: they take seconds to look and decide, so the game's clock
 * stands still between their moves (golden-boot-glory: one key press ran four match minutes).
 */
const PACED_ROLES: ReadonlySet<AgentScreenRole> = new Set([ScreenRole.Playtester, ScreenRole.Judge]);

/**
 * The roles that meet the game's own title and menu as a player does: the studio never begins
 * play for them, whatever setup an older seed sends (`PreviewService.applySetup` `keepFrontEnd`).
 */
const FRONT_END_ROLES: ReadonlySet<AgentScreenRole> = new Set(["playtester"]);

/** Who holds the computer, and on which build: a playtest grant with any screen role. */
export type ComputerGrant = Omit<NonNullable<DelegateRequest["playtest"]>, "role"> & { role?: AgentScreen["role"] };

/**
 * A load of the build: the browser window's port (null for a Play Protocol game, which has no
 * window the playtest shorthands could drive), and what went wrong or is worth saying.
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
  /**
   * Load the target now and describe the tool from what it says it can do — a Play Protocol game
   * says so only in its `hello`, so until then the tool is described from what such a game may do.
   */
  prepare: () => Promise<void>;
}

/**
 * How a role's session runs: a judge on a seeded, stepped clock (its run can be replayed), a
 * playtester paced on wall time, everyone else on a running game. The roles that play to judge
 * see the result of every move without asking; the grant's goal and budget ride along.
 */
function sessionOptionsFor(role: AgentScreenRole, grant: ComputerGrant, frameDir: string): ComputerSessionOptions {
  const judging = role === ScreenRole.Judge;
  const pacing = PACED_ROLES.has(role)
    ? (grant.pacing ?? (judging ? ComputerPacing.Stepped : ComputerPacing.Paced))
    : ComputerPacing.Running;
  const quest = questOf(grant);
  return {
    pacing,
    frameDir,
    observeByDefault: PACED_ROLES.has(role),
    onReached: markVerified,
    ...(judging ? JUDGE_VIEW : {}),
    ...(grant.maxActions !== undefined ? { maxActions: grant.maxActions } : {}),
    ...(quest ? { quest } : {}),
  };
}

/**
 * What a judge sees of the game: never its `state` or `console`, which the builder under judgement
 * wrote — the session still reads the state to check the goal, and the judge answers from playing.
 */
const JUDGE_VIEW: Pick<ComputerSessionOptions, "offer" | "showState"> = {
  offer: (caps) => ({ ...caps, state: StateLevel.None, console: false }),
  showState: false,
};

/** The grant's goal, as the host reads it: a plain dotted path and a plain value, or no goal at all. */
function questOf(grant: ComputerGrant): ComputerSessionOptions["quest"] {
  const until = grant.quest ? normalizeSetup({ verify: grant.quest.until })?.verify : undefined;
  return grant.quest && until ? { id: String(grant.quest.id), until } : undefined;
}

/** The quality of a frame a target that is no preview window takes for the agent's screen. */
const TARGET_FRAME_QUALITY = 60;

/**
 * A target that is no preview window, read as one by the agent screen: its picture, its size and
 * its pointer, so a Play Protocol game's moves are drawn on the worker's node as a browser game's are.
 */
function targetFramePort(target: ComputerTarget): FramePort {
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

/** What else a computer may need: a sandbox to start a Play Protocol game in, when the build is one. */
export interface ComputerToolsOptions {
  /** Set when the build's studio.json declares the `bridge` runtime: its game is started here. */
  bridge?: { sandbox: Pick<ProcessSandbox, "spawnLongLived"> };
}

/** The tools over one session, whatever its target: the tool definition, its calls, its load and its trace. */
function toolsOver<T extends ComputerTarget>(
  session: ComputerSession<T>,
  parts: {
    caps: TargetCapabilities;
    toolRole: ComputerToolRole;
    observeByDefault: boolean;
    screen: () => AgentScreen;
    portOf: (target: T) => PreviewPort | null;
    release: () => Promise<void>;
    offer?: (caps: TargetCapabilities) => TargetCapabilities;
  },
): ComputerTools {
  const describe = (caps: TargetCapabilities) =>
    computerToolDefinition({
      role: parts.toolRole,
      capabilities: parts.offer ? parts.offer(caps) : caps,
      observeByDefault: parts.observeByDefault,
    });
  const liveTools = [describe(parts.caps)];
  return {
    liveTools,
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
    prepare: async () => {
      const loaded = await session.ensureLoaded();
      if (!loaded.problem) liveTools[0] = describe(loaded.target.caps);
    },
  };
}

/**
 * The studio's own browser window as a target source: the session's pooled window, loaded through
 * the served entry with the setup script applied, and its frames sent to the agent's screen.
 */
function browserSource(
  previews: PreviewService,
  grant: ComputerGrant,
  role: AgentScreenRole,
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
      const applied = await previews.applySetup(window, grant.setup, { keepFrontEnd: FRONT_END_ROLES.has(role) });
      const note = [loaded.note, applied].filter(Boolean).join("; ") || null;
      sessionPort.loaded = { root, at: Date.now() };
      previews.openScreen(screen());
      await previews.frame(window, screen(), null, "loaded", { deed: ScreenDeed.Load });
      return { target, problem: null, note, fresh: true };
    },
    frame: (target, jpeg, caption, act) => previews.frame(target.port, screen(), jpeg, caption, act),
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
  const sessionOptions = sessionOptionsFor(role, grant, iterationDir(outDir, grant.iteration));
  const toolRole = Object.hasOwn(TOOL_ROLE, role) ? TOOL_ROLE[role] : ScreenRole.Playtester;
  const shared = {
    toolRole,
    observeByDefault: PACED_ROLES.has(role),
    screen,
    ...(sessionOptions.offer ? { offer: sessionOptions.offer } : {}),
  };
  const runtime = options.bridge ? TargetRuntime.Bridge : TargetRuntime.Browser;
  const deps: SourceDeps = { previews, grant, role, sessionPort, screen, options };
  return TARGET_SOURCES[runtime](deps, (source, parts) =>
    toolsOver(computerSession(source, initialRoot, sessionOptions), { ...shared, ...parts }),
  );
}

/** What any target source is built from: the previews, the grant, the window and the extras. */
interface SourceDeps {
  previews: PreviewService;
  grant: ComputerGrant;
  role: AgentScreenRole;
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
 * One row per runtime: how its target source is made. A new kind of target — a window, a desktop,
 * a VM — is a new runtime and a new row here; the session, the tool and every engine stay as they are.
 */
const TARGET_SOURCES: Record<TargetRuntime, (deps: SourceDeps, build: ToolsBuilder) => ComputerTools> = {
  [TargetRuntime.Browser]: (deps, build) => {
    const source = browserSource(deps.previews, deps.grant, deps.role, deps.sessionPort, deps.screen);
    return build(source, { caps: source.caps, portOf: (target) => target.port, release: async () => {} });
  },
  [TargetRuntime.Bridge]: (deps, build) => {
    const sandbox = deps.options.bridge?.sandbox;
    if (!sandbox) return TARGET_SOURCES[TargetRuntime.Browser](deps, build);
    const source = gameBridgeSource({
      sandbox,
      frame: (target, jpeg, caption, act) => {
        deps.previews.openScreen(deps.screen());
        return deps.previews.frame(targetFramePort(target), deps.screen(), jpeg, caption, act);
      },
    });
    return build(source, { caps: source.caps, portOf: () => null, release: source.release });
  },
};

/**
 * The computer on a delegation's pooled window: who holds it (the role), which build it shows, and
 * how the studio's own browser window loads that build. Everything an action does — parsing,
 * refusing what the target cannot do, pacing the clock, looking, input — is the generic
 * {@link computerSession}; this module is its browser source (`browser-preview-target.ts`), or,
 * for a game whose studio.json declares the `bridge` runtime, the Play Protocol source
 * (`game-bridge-target.ts`).
 */
import { type AgentScreen, type AgentScreenRole, ScreenDeed } from "../../shared/agent-screen.ts";
import {
  BROWSER_CAPABILITIES,
  ComputerPacing,
  type ComputerTraceSummary,
  type TargetCapabilities,
  TargetRuntime,
} from "../../shared/computer-target.ts";
import { computerToolDefinition } from "../../substrate/computer-tool.ts";
import type { DelegateRequest } from "../../substrate/engines/types.ts";
import type { PreviewPort } from "../../substrate/preview-port.ts";
import type { ComputerToolRole } from "../../substrate/computer-tool-prompts.ts";
import { LIVE_HANDLE } from "../../substrate/preview-pool.ts";
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
import type { PreviewService } from "./previews.ts";
import { iterationDir } from "./run-shots.ts";
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
const PACED_ROLES: ReadonlySet<AgentScreenRole> = new Set(["playtester", "judge"]);

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
}

/**
 * How a role's session runs: a judge on a seeded, stepped clock (its run can be replayed), a
 * playtester paced on wall time, everyone else on a running game. The roles that play to judge
 * see the result of every move without asking; the grant's goal and budget ride along.
 */
function sessionOptionsFor(role: AgentScreenRole, grant: ComputerGrant, frameDir: string): ComputerSessionOptions {
  const judging = role === "judge";
  const pacing = PACED_ROLES.has(role)
    ? (grant.pacing ?? (judging ? ComputerPacing.Stepped : ComputerPacing.Paced))
    : ComputerPacing.Running;
  return {
    pacing,
    frameDir,
    observeByDefault: PACED_ROLES.has(role),
    ...(grant.maxActions !== undefined ? { maxActions: grant.maxActions } : {}),
    ...(grant.quest ? { quest: grant.quest } : {}),
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
  },
): ComputerTools {
  const definition = computerToolDefinition({
    role: parts.toolRole,
    capabilities: parts.caps,
    observeByDefault: parts.observeByDefault,
  });
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
  const toolRole = Object.hasOwn(TOOL_ROLE, role) ? TOOL_ROLE[role] : "playtester";
  const observeByDefault = PACED_ROLES.has(role);
  if (options.bridge) {
    const bridge = gameBridgeSource({ sandbox: options.bridge.sandbox });
    const session = computerSession(bridge, initialRoot, sessionOptions);
    return toolsOver(session, {
      caps: bridge.caps,
      toolRole,
      observeByDefault,
      screen,
      portOf: () => null,
      release: bridge.release,
    });
  }
  const source = browserSource(previews, grant, role, sessionPort, screen);
  const session = computerSession(source, initialRoot, sessionOptions);
  const release = async () => {};
  return toolsOver(session, {
    caps: source.caps,
    toolRole,
    observeByDefault,
    screen,
    portOf: (target) => target.port,
    release,
  });
}

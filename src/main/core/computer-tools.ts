/**
 * The computer on a delegation's pooled window: who holds it (the role), which build it shows, and
 * how the studio's own browser window loads that build. Everything an action does — parsing,
 * refusing what the target cannot do, pacing the clock, looking, input — is the generic
 * {@link computerSession}; this module is its browser source (`browser-preview-target.ts`).
 */
import { type AgentScreen, type AgentScreenRole, ScreenDeed } from "../../shared/agent-screen.ts";
import { BROWSER_CAPABILITIES } from "../../shared/computer-target.ts";
import { computerToolDefinition } from "../../substrate/computer-tool.ts";
import type { DelegateRequest } from "../../substrate/engines/types.ts";
import type { PreviewPort } from "../../substrate/preview-port.ts";
import type { ComputerToolRole } from "../../substrate/computer-tool-prompts.ts";
import { LIVE_HANDLE } from "../../substrate/preview-pool.ts";
import { type BrowserPreviewTarget, browserPreviewTarget } from "./browser-preview-target.ts";
import { computerSession, type TargetSource } from "./computer-session.ts";
import type { PreviewService } from "./previews.ts";
import { iterationDir } from "./run-shots.ts";
import type { SessionPort } from "./session-port.ts";

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
  const source = browserSource(previews, grant, role, sessionPort, screen);
  const session = computerSession(source, initialRoot, {
    paced: PACED_ROLES.has(role),
    frameDir: iterationDir(outDir, grant.iteration),
  });
  const ensureLoaded = async (force = false): Promise<ComputerLoad> => {
    const loaded = await session.ensureLoaded(force);
    return { port: loaded.target.port, problem: loaded.problem, note: loaded.note };
  };
  const toolRole = Object.hasOwn(TOOL_ROLE, role) ? TOOL_ROLE[role] : "playtester";
  return {
    liveTools: [computerToolDefinition({ role: toolRole, capabilities: source.caps })],
    onLiveTool: (name, args) => session.run(name, args),
    ensureLoaded,
    screen,
    root: () => session.root(),
    retarget: (next: string) => session.retarget(next),
  };
}

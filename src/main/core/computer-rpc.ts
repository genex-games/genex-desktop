/**
 * `preview.computer`: the `computer` tool run by the host on a window the harness leased, for an
 * engine whose tool loop is the harness's own (Ollama). It is the same session every session
 * engine holds — same vocabulary, pacing, budget, goal check and trace — kept per leased window
 * until the harness releases it, so the direct playtester and the playing judge play exactly as
 * the others do instead of through a handful of shorthands.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { HarnessParams, HarnessResult, HostMethod } from "../../shared/harness-api.ts";
import { isInside } from "../../substrate/paths.ts";
import { ScreenRole } from "../../shared/agent-screen.ts";
import { COMPUTER_TOOL_NAME } from "../../substrate/computer-tool.ts";
import { LIVE_HANDLE, STAND_IN_HANDLE } from "../../substrate/preview-pool.ts";
import type { ComputerGrant, ComputerTools } from "./computer-tools.ts";
import { ShotKind, runShotsDir } from "./run-shots.ts";
import type { SessionPort } from "./session-port.ts";
import type { PreviewPort } from "../../substrate/preview-port.ts";

type ComputerParams = HarnessParams<typeof HostMethod.PreviewComputer>;
type ComputerAnswer = HarnessResult<typeof HostMethod.PreviewComputer>;

/** What the harness reads when a computer call is refused. */
const MESSAGE = {
  needsLease: "preview.computer needs a window the harness leased (preview.acquire), never the person's own",
  notThisRun: (root: string) => `preview.computer: ${root} is not this game's folder or a build of this run`,
} as const;

/** The handles that are never a leased window: the person's own view and its stand-in. */
const SHARED_HANDLES: ReadonlySet<string> = new Set([LIVE_HANDLE, STAND_IN_HANDLE]);

/** What the service needs from the core: the folders a build may live in, the windows, and the tool builder. */
export interface ComputerRpcHost {
  gameDir(project: string): string;
  scratch(): string;
  runs(): string;
  port(handle: string): PreviewPort;
  computerTools(grant: ComputerGrant, root: string, outDir: string, session: SessionPort): Promise<ComputerTools>;
  /** The host's own records say this run is this game's (`DelegationService.runOfGame`). */
  runOfGame(project: string, runId: string): Promise<boolean>;
}

/** One leased window's computer, and the grant it was built for. */
interface Kept {
  key: string;
  tools: ComputerTools;
}

/** The leased window as a session port whose release is the harness's own `preview.release`. */
function leasePort(host: ComputerRpcHost, handle: string): SessionPort {
  const lease: SessionPort = {
    loaded: null,
    handle: () => handle,
    get: async () => host.port(handle),
    release: async () => {},
  };
  return lease;
}

/** A run id that names one plain folder: no separator, no climbing, nothing but its own characters. */
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * This run's own folder under scratch, checked real, when the run id is a plain name and the host's
 * records say the run is this game's; null otherwise — a run id never reaches another folder or
 * another game's run.
 */
async function runFolderOf(host: ComputerRpcHost, p: ComputerParams): Promise<string | null> {
  if (!p.runId || !RUN_ID.test(p.runId)) return null;
  const autopilot = await realpath(path.join(host.scratch(), "autopilot")).catch(() => null);
  if (!autopilot) return null;
  const folder = path.join(autopilot, p.runId);
  if ((await realpath(folder).catch(() => null)) !== folder) return null;
  return (await host.runOfGame(p.project, p.runId)) ? folder : null;
}

/** The real path of a build root, if it is this game's folder or under this game's run folder; null otherwise. */
async function allowedRoot(host: ComputerRpcHost, p: ComputerParams): Promise<string | null> {
  const root = await realpath(path.resolve(String(p.root))).catch(() => null);
  if (!root) return null;
  const game = await realpath(host.gameDir(p.project)).catch(() => null);
  if (game && (root === game || isInside(game, root))) return root;
  const run = await runFolderOf(host, p);
  return run && isInside(run, root) ? root : null;
}

/** What makes two calls the same session: the window, the build, and how it was asked to play. */
function sessionKey(p: ComputerParams, root: string): string {
  return JSON.stringify([
    p.handle,
    root,
    p.runId ?? null,
    p.facetId ?? null,
    p.iteration ?? null,
    p.role ?? null,
    p.pacing ?? null,
    p.quest ?? null,
    p.maxActions ?? null,
  ]);
}

/** The service: one computer per leased window, rebuilt when the harness asks for another build or role. */
export function computerRpc(host: ComputerRpcHost) {
  const kept = new Map<string, Kept>();
  /** Drop a window's computer, stopping what it started (a Play Protocol game's process). */
  const drop = async (handle: string): Promise<void> => {
    const current = kept.get(handle);
    kept.delete(handle);
    await current?.tools.release().catch(() => {});
  };
  const toolsFor = async (p: ComputerParams, root: string): Promise<ComputerTools> => {
    const key = sessionKey(p, root);
    const current = kept.get(p.handle);
    if (current && current.key === key && !p.fresh) return current.tools;
    if (current) await drop(p.handle);
    const { handle: _handle, args: _args, describe: _describe, fresh: _fresh, ...grant } = p;
    const outDir = runShotsDir(host.runs(), p.runId, p.facetId, ShotKind.Playtest);
    const tools = await host.computerTools(
      { ...grant, role: p.role ?? ScreenRole.Playtester },
      root,
      outDir,
      leasePort(host, p.handle),
    );
    kept.set(p.handle, { key, tools });
    return tools;
  };
  return {
    /** One `preview.computer` call: the schema when asked to describe, otherwise one action and the trace so far. */
    call: async (p: ComputerParams): Promise<ComputerAnswer> => {
      if (!p?.handle || SHARED_HANDLES.has(p.handle)) throw new Error(MESSAGE.needsLease);
      const root = await allowedRoot(host, p);
      if (!root) throw new Error(MESSAGE.notThisRun(String(p.root)));
      const tools = await toolsFor(p, root);
      const [tool] = tools.liveTools;
      if (p.describe && tool) return { tool };
      const answer = await tools.onLiveTool(COMPUTER_TOOL_NAME, p.args ?? {});
      return { answer, trace: tools.trace() };
    },
    /** Forget a released window's computer, stopping what it started. */
    forget: (handle: string): Promise<void> => drop(handle),
  };
}

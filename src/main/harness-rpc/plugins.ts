import { preflightMultiplayer } from "../core/generation-prerequisites.ts";
/** Harness RPC: plugin and MCP connector tools, and the capabilities a builder is told about. */
import { MCP_QUALIFIED_TOOL } from "../../shared/mcp.ts";
import { PluginToolAudience } from "../../shared/plugins.ts";
import type { GameKind } from "../../shared/project-facts.ts";
import { HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { CONNECTOR_ARGS_CAP } from "../core/plugin-tools.ts";
import { IN_PLACE_LOCK, isLockRefused, workerHolder } from "../core/plugin-locks.ts";
import { isWorkerId, isWorkerTitle, WORKER_NAMING } from "../../shared/workers.ts";
import { CapabilityAudience } from "../planning-capabilities.ts";
import { kindsWithReadiness } from "../core/kind-readiness.ts";
import { pluginsFind, pluginsSuggest } from "../core/project-tools.ts";

/** Why a plugin or connector call from the harness is refused. */
const MESSAGE = {
  noProject: "Open a project first",
  argsNotObject: "Connector arguments must be a JSON object",
  argsNotJson: "Connector arguments must be JSON",
  argsTooLarge: "Connector arguments are too large",
  unknownConnectorTool: "Unknown connector tool",
  unknownGame: "No such game",
  badHolder: WORKER_NAMING,
} as const;

/** The engine the local harness's own plugin calls are recorded under. */
const LOCAL_HARNESS_ENGINE = "local";

/** The binding a plugin or connector call runs under; there is none until a project is open. */
async function requirePluginBinding(core: StudioCore, project: string, threadId: string | undefined) {
  const binding = await core.pluginBinding(project, threadId);
  if (!binding) throw new Error(MESSAGE.noProject);
  return binding;
}

/** A connector call's arguments, refused unless they are a JSON object within the size cap. */
function connectorArgs(raw: unknown): Record<string, unknown> {
  const args = raw ?? {};
  const isObject = typeof args === "object" && args !== null && !Array.isArray(args);
  if (!isObject) throw new Error(MESSAGE.argsNotObject);
  let encoded: string;
  try {
    encoded = JSON.stringify(args);
  } catch {
    throw new Error(MESSAGE.argsNotJson);
  }
  if (Buffer.byteLength(encoded ?? "", "utf8") > CONNECTOR_ARGS_CAP) throw new Error(MESSAGE.argsTooLarge);
  return args as Record<string, unknown>;
}

/**
 * What the game a harness call names holds, by which its plugin tools and connectors are chosen:
 * none named, or one whose facts can't be read (a game a Loop is about to make included), has no
 * kind yet (served as a web game).
 */
async function kindOf(core: StudioCore, project: string | null | undefined): Promise<GameKind> {
  if (!project) return { facts: [] };
  return core.games.kindOf(project).catch(() => ({ facts: [] }));
}

/** The worker a lock is held for, as the harness names it; refused unless its id and title are plain. */
function holderOf(
  holder: { id?: unknown; title?: unknown } | undefined,
  titled: boolean,
): { id: string; title: string } {
  const id = holder?.id;
  const title = holder?.title;
  if (!isWorkerId(id) || (titled && !isWorkerTitle(title))) throw new Error(MESSAGE.badHolder);
  return { id, title: typeof title === "string" ? title : "" };
}

/**
 * A worker writing in place starts: Genex's one writer in place in the game folder, and the
 * per-game locks of the plugins that are on that its tools need, all at once or none, without
 * waiting and without asking the person (its own calls do).
 */
async function holdInPlace(
  core: StudioCore,
  x: CoreInternals,
  p: { project: string; threadId: string; runId?: string | null; holder: { id: string; title: string } },
): Promise<{ held: true; labels: string[] } | { busy: string }> {
  const holder = holderOf(p.holder, true);
  // A game of any kind: an Unreal game's folder holds no web page.
  await core.games.kindOf(p.project).catch(() => {
    throw new Error(MESSAGE.unknownGame);
  });
  const binding = await requirePluginBinding(core, p.project, p.threadId);
  const plugins = core.plugins.locksFor(await kindOf(core, p.project));
  try {
    await x.locks.hold([IN_PLACE_LOCK, ...plugins], {
      binding,
      waitMs: 0,
      holder: workerHolder({ threadId: p.threadId, runId: p.runId, id: holder.id }),
      title: holder.title,
      personFirst: false,
      forHarness: true,
    });
  } catch (error) {
    if (isLockRefused(error)) return { busy: error.message };
    throw error;
  }
  return { held: true, labels: plugins.map(({ lock }) => lock.label) };
}

export function pluginsRpc(core: StudioCore, x: CoreInternals) {
  return {
    [HostMethod.PluginsPreflightMultiplayer]: (p) => preflightMultiplayer(core, p.project, p.threadId),
    // One snapshot, so the local harness's tools and their guidance describe the same plugins,
    // those that reach the game it serves.
    [HostMethod.PluginsTools]: async (p = {}) => {
      const game = await kindOf(core, p?.project);
      const { tools, guidance, kinds } = core.plugins.snapshot(game);
      // A game with no kind yet: the engine card offers each kind as its plugin says it stands.
      const offered = await kindsWithReadiness(core, p?.project, game, kinds);
      return { tools, guidance, kinds: offered, revision: x.toolRegistryRevision };
    },
    // The kinds of worker a lead may start for this game: those the enabled plugins declare whose
    // tools reach it, read by its facts as its plugin tools are.
    [HostMethod.PluginsWorkerTypes]: async (p) => core.plugins.workerTypes(await kindOf(core, p.project)),
    // The local model's plugin search and turn-it-on card: neither turns a plugin on.
    [HostMethod.PluginsFind]: (p = {}) => pluginsFind(core, { fact: p?.fact, text: p?.text }),
    [HostMethod.PluginsSuggest]: (p) =>
      pluginsSuggest(core, { project: p.project, threadId: p.threadId, plugin: p.plugin, reason: p.reason }),
    /** What this game's builders can use, for a conversation that cannot call it (the local coordinator). */
    [HostMethod.CapabilitiesDescribe]: async (p) =>
      (await x.capabilityFacts(p.threadId, p.project, CapabilityAudience.Conversation)).text,
    [HostMethod.PluginsInvoke]: async (p) => {
      const binding = await requirePluginBinding(core, p.project, p.threadId);
      // The local harness reaches plugins here; the same record pair is written so the ledger
      // reads the same whichever engine made the call. Only the harness's own steps say `step`:
      // its agents' calls never do, so a tool kept for the harness stays out of their reach.
      return x.pluginTools.invokePluginTool(p.name, p.args, binding, undefined, {
        engine: LOCAL_HARNESS_ENGINE,
        caller: p.step === true ? PluginToolAudience.Harness : PluginToolAudience.Agents,
        checkpoint: p.checkpoint === true,
      });
    },
    // Connectors, for the local harness. Two methods and no more: an agent may see what is
    // connected and use it, and nothing here can add, change, enable or remove a connector —
    // that lives in the Studio UI, behind a native trust dialog.
    [HostMethod.McpTools]: async (p = {}) => {
      const tools = await core.mcp.toolsFor(p?.project ?? null, await kindOf(core, p?.project));
      return { tools, guidance: core.mcp.guidance(tools), revision: x.toolRegistryRevision };
    },
    [HostMethod.McpInvoke]: async (p) => {
      // The name is checked here as well as in the registry: this is the doorway an agent
      // reaches, and `<connector>__<tool>` is the only shape that may pass through it.
      // The host tracks this call by its project/thread. Stop aborts local waiting even when
      // the editable harness is awaiting its result. Remote cancellation is server-dependent.
      if (typeof p?.name !== "string" || !MCP_QUALIFIED_TOOL.test(p.name))
        throw new Error(MESSAGE.unknownConnectorTool);
      const args = connectorArgs(p.args);
      const binding = await requirePluginBinding(core, p.project, p.threadId);
      // A plugin's server scoped to facts is never started for a game it does not reach, as it is
      // never listed for one (`mcp.tools`): the same rule, before anything connects.
      const connector = p.name.slice(0, p.name.indexOf("__"));
      const game = await kindOf(core, binding.project);
      if (!core.mcp.reaches(connector, game.facts, game.holds)) throw new Error(MESSAGE.unknownConnectorTool);
      return x.pluginTools.invokeConnectorTool(p.name, args, binding);
    },
    [HostMethod.LocksHold]: (p) => holdInPlace(core, x, p),
    // Only the worker's own locks go: another holder's, or a holder that holds nothing, change nothing.
    [HostMethod.LocksRelease]: async (p) => {
      const holder = holderOf(p.holder, false);
      x.locks.releaseHolder(workerHolder({ threadId: p.threadId, runId: p.runId, id: holder.id }));
      return true;
    },
  } satisfies Partial<HarnessHostHandlers>;
}

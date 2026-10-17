/**
 * The builders' tool sources as sessions see them: plugins and MCP connectors, one revision
 * counter that moves whenever either changes, and which revision each thread last applied. A
 * session that cannot call the tools itself (planning, the conversation) gets them as text.
 */
import type { ConnectionSnapshot } from "../../shared/connections.ts";
import { CustomEvent, customEvent } from "../../shared/custom-events.ts";
import { EventKind } from "../../shared/event-log.ts";
import type { GameProject } from "../../shared/game-project.ts";
import { mcpScopeCovers, type McpConnectorView } from "../../shared/mcp.ts";
import { McpAuthState } from "../../substrate/mcp/oauth.ts";
import { isAgentTool, type PluginAppliedSet, type PluginInfo, pluginReach } from "../../shared/plugins.ts";
import { CoreFact, type GameKind, hasFact } from "../../shared/project-facts.ts";
import type { ThreadFold } from "../../substrate/event-store.ts";
import type { EventEnvelope } from "../../substrate/types.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { CapabilityAudience, planningCapabilities } from "../planning-capabilities.ts";
import type { StudioCore } from "../studio-core.ts";

type ConnectionsCore = Pick<StudioCore, "mcp" | "plugins" | "games" | "append" | "emit" | "store">;
type ConnectionSource = ConnectionSnapshot["sources"][number];

/** A list of names, as a log record may or may not hold one. */
const isNameList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((name) => typeof name === "string");

/** One session's key in the applied fold: an engine's own session id, never mistaken for another engine's. */
const sessionKey = (engine: string, session: string): string => JSON.stringify([engine, session]);

/**
 * Whether a game runs on the Studio template (Three.js through its import map under /vendor/): a
 * web game at its root in the template's shape. A shape read from a folder with no page falls back
 * to the template's, so a new empty game, a Godot or an Unreal project never claims it.
 */
const usesStudioTemplate = (game: Pick<GameProject, "shape" | "facts"> | undefined): boolean =>
  game?.shape.kind === "studio-template" && hasFact(game.facts, CoreFact.WebGame, ".");

/** The session and the set a delivered record carries; none for a record without a well-formed one. */
function deliveredSetOf(event: EventEnvelope): [string, PluginAppliedSet] | undefined {
  const payload = customEvent(event, CustomEvent.ToolRegistryApplied);
  if (!payload || typeof payload.engine !== "string" || typeof payload.session !== "string") return undefined;
  const { plugins, skills } = payload;
  if (!isNameList(plugins) || !isNameList(skills)) return undefined;
  return [sessionKey(payload.engine, payload.session), { plugins, skills }];
}

/**
 * The plugins and skills each engine session on a thread was last handed, by that session's id,
 * checkpointed beside the thread's log (`applied-tools.json`). Only a record written once the
 * session answered carries a set: a brief that never reached its session, and a fresh session on
 * the same thread and engine, leave another session's set as it was.
 */
const APPLIED_FOLD: ThreadFold<Array<[string, PluginAppliedSet]>> = {
  name: "applied-tools",
  version: 2,
  fold: (previous, events) => {
    const bySession = new Map(previous ?? []);
    for (const event of events) {
      const delivered = deliveredSetOf(event);
      if (delivered) bySession.set(...delivered);
    }
    return [...bySession];
  },
};

/** The tool registry's revision, per-thread applied revisions, and the snapshot built from them. */
export class ConnectionService {
  readonly #core: ConnectionsCore;
  /** Whether a thread has work in flight (a turn, a completion or a delegation). */
  readonly #threadBusy: (threadId: string) => boolean;
  #revision = 0;
  readonly #applied = new Map<string, number>();

  constructor(core: ConnectionsCore, threadBusy: (threadId: string) => boolean) {
    this.#core = core;
    this.#threadBusy = threadBusy;
  }

  /** The current tool registry revision; it moves whenever a plugin or connector changes. */
  get revision(): number {
    return this.#revision;
  }

  /** A plugin or connector changed: move the revision and tell the renderer. */
  changed(): void {
    this.#revision++;
    this.#core.emit(UiEvent.ConnectionsChanged, { revision: this.#revision });
  }

  /** Every tool source the settings and the composer show, with the thread's applied revision. */
  async snapshot(threadId?: string, project?: string | null): Promise<ConnectionSnapshot> {
    const connectors = await this.#core.mcp.list(project ?? null);
    const game = project ? await this.#kindOf(project) : undefined;
    const plugins = await Promise.all(
      this.#core.plugins
        .list()
        .filter((p) => !p.removed)
        .map((p) => this.#pluginSource(p, game)),
    );
    return {
      revision: this.#revision,
      appliedRevision: threadId ? (this.#applied.get(threadId) ?? null) : null,
      active: !!threadId && this.#threadBusy(threadId),
      sources: [
        ...plugins,
        ...connectors.filter((v) => mcpScopeCovers(v.connector.scope, project)).map(connectorSource),
      ],
    };
  }

  /** The builders' plugins, accounts and connectors, for a session that cannot call them itself. */
  async capabilityFacts(
    threadId: string,
    project: string | null | undefined,
    audience: CapabilityAudience,
  ): Promise<{ revision: number; text: string }> {
    const revision = this.#revision;
    const connections = await this.snapshot(threadId, project);
    const game = project ? (await this.#core.games.list()).find((g) => g.name === project) : undefined;
    const kind: GameKind = game ?? { facts: [] };
    const connectors = await this.#enabledConnectors(project, kind);
    const text = planningCapabilities(
      revision,
      this.#core.plugins.list(),
      connections,
      connectors,
      usesStudioTemplate(game),
      audience,
      kind,
    );
    if (audience === CapabilityAudience.Conversation)
      await this.#core.append(
        [
          {
            type: EventKind.Custom,
            event_type: CustomEvent.ConversationCapabilitiesApplied,
            payload: { revision, scope: audience, project: project ?? null },
          },
        ],
        threadId,
      );
    return { revision, text };
  }

  /** A session took the registry at `revision`: remember it for the thread and log it. */
  async recordApplied(threadId: string, engine: string, revision = this.#revision): Promise<void> {
    this.#applied.set(threadId, revision);
    await this.#core.append(
      [{ type: EventKind.Custom, event_type: CustomEvent.ToolRegistryApplied, payload: { revision, engine } }],
      threadId,
    );
    this.#core.emit(UiEvent.ConnectionsApplied, { threadId, revision });
  }

  /**
   * `engine`'s session `session` answered a brief that handed it `applied`: log the set under that
   * session, for a later resume of it to be compared against.
   */
  async recordDelivered(threadId: string, engine: string, session: string, applied: PluginAppliedSet): Promise<void> {
    const payload = { engine, session, plugins: applied.plugins, skills: applied.skills };
    await this.#core.append(
      [{ type: EventKind.Custom, event_type: CustomEvent.ToolRegistryApplied, payload }],
      threadId,
    );
  }

  /** The plugins and skills `engine`'s session `session` on this thread was last handed, read from the thread's log. */
  async lastApplied(threadId: string, engine: string, session: string): Promise<PluginAppliedSet | undefined> {
    const { state } = await this.#core.store.foldThread(threadId, APPLIED_FOLD);
    return new Map(state).get(sessionKey(engine, session));
  }

  /** What a game's folder holds; a game whose facts can't be read has no kind yet. */
  async #kindOf(project: string): Promise<GameKind> {
    return this.#core.games.kindOf(project).catch(() => ({ facts: [] }));
  }

  /** The enabled connectors that reach this game, with the tool names a plan may name. */
  async #enabledConnectors(project: string | null | undefined, game: GameKind) {
    const views = await this.#core.mcp.list(project ?? null);
    return views
      .filter((v) => v.connector.enabled && mcpScopeCovers(v.connector.scope, project))
      .filter((v) => this.#core.mcp.reaches(v.connector.id, game.facts, game.holds))
      .map((v) => ({
        id: v.connector.id,
        name: v.connector.name,
        health: v.health,
        tools: this.#core.mcp.planningToolNames(v.connector.id, project ?? null),
      }));
  }

  /** One plugin as a tool source; with a game, its tools are those that reach that game. */
  async #pluginSource(p: PluginInfo, game: GameKind | undefined): Promise<ConnectionSource> {
    // The tools agents get: one only the harness calls is no tool of theirs.
    const agentTools = game ? pluginReach(p.manifest, game).tools : p.manifest.tools.filter(isAgentTool);
    return {
      id: p.manifest.id,
      name: p.manifest.name,
      kind: "plugin",
      enabled: p.enabled,
      health: p.health,
      tools: p.enabled ? agentTools.length : 0,
      pending: !!p.pendingVersion,
      reason: p.error,
      account: await this.#core.plugins.accountState(p.manifest.id),
    };
  }
}

function connectorSource(v: McpConnectorView): ConnectionSource {
  const authorizing = v.authentication?.state === McpAuthState.Authorizing;
  return {
    id: v.connector.id,
    name: v.connector.name,
    kind: "mcp",
    enabled: v.connector.enabled,
    health: authorizing ? McpAuthState.Authorizing : v.health,
    tools: v.toolCount,
    pending: v.pending,
    reason: v.authentication?.error ?? v.error,
  };
}

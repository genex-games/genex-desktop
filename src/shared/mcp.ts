/**
 * MCP connectors — the renderer-visible contract. Types only: the client, the store and the
 * registry live in `src/substrate/mcp/**` and are reachable from the UI only through IPC.
 *
 * A connector is a user-configured MCP server Studio itself connects to. Its tools are proxied
 * through the existing `liveTools`/`onLiveTool` channel, so Claude Code, Codex and the local
 * harness share one trust, consent and observability model.
 *
 * Secret values never appear here. `env` and `headers` carry **names**; the values live in a
 * `SecretStore` under `engine-homes/mcp/secrets` and are materialized only into a child's
 * environment (or a request header) at launch.
 */
import type { CallMaking } from "./asset-making.ts";
import type { CallCutOff } from "./plugins.ts";
import type { SecretStorageIssue } from "./secret-storage.ts";

/**
 * Connector ids share the plugin id character class, minus `_`: tool names are
 * `<connectorId>__<exposedTool>`, so the `__` split must stay unambiguous.
 */
export const MCP_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** Environment variable names, POSIX style. */
export const MCP_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** HTTP header names. */
export const MCP_HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/** A sanitized tool name as it is exposed to an engine, after `exposedToolName`. */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_-]{1,48}$/;
/** The full proxied name an engine sees and `McpRegistry.owns` recognises. */
export const MCP_QUALIFIED_TOOL = /^[a-z][a-z0-9-]{0,31}__[A-Za-z0-9_-]{1,48}$/;
/** The longest exposed tool name: the tool half of `MCP_QUALIFIED_TOOL`. */
export const MCP_TOOL_NAME_MAX = 48;

/**
 * `name`, or when another tool of the same connector already has it, `name_2`, `name_3`… with the
 * base cut so the result still fits `MCP_TOOL_NAME`. A suffix that ran past the limit would give
 * the model a tool whose name no call can reach.
 */
export function uniqueToolName(name: string, taken: { has(name: string): boolean }): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const candidate = `${name.slice(0, MCP_TOOL_NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A connector tool as an engine sees it: the flat projection plus the schema it came from. */
export interface McpLiveTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  inputSchema: Record<string, unknown>;
}

/** How Studio talks to a connector (`McpConnector.transport`). Persisted in connectors.json: never rename a value. */
export const McpTransport = { Stdio: "stdio", Http: "http", Sse: "sse" } as const;
export type McpTransport = (typeof McpTransport)[keyof typeof McpTransport];
/** Global, or only the named projects. */
export type McpScope = "global" | { projects: string[] };
/** Raw MCP tool names, before sanitising. Deny wins over allow. */
export interface McpToolPolicy {
  /** Exact raw tool names the person explicitly permits without per-call consent. */
  autoApprove?: string[];
  allow?: string[];
  deny?: string[];
}

/**
 * Where a connector came from. `'user'` is one the user typed into the Connectors card;
 * a plugin-declared server is owned by its plugin, lives only in memory, and is never written
 * to connectors.json.
 */
export type McpConnectorSource = "user" | { plugin: string; server: string };

export interface McpConnector {
  id: string;
  name: string;
  transport: McpTransport;
  /** stdio only. Never taken from a model argument: the user types it, or a plugin declares it. */
  command?: string;
  args?: string[];
  /** stdio only; absolute. */
  cwd?: string;
  /** Environment variable NAMES whose values come from the secret store. */
  env?: string[];
  /** http/sse only. https, or http on loopback. */
  url?: string;
  /** Header NAMES whose values come from the secret store. */
  headers?: string[];
  /** OAuth credentials live in protected host storage, separately from HTTP headers. */
  authentication?: "oauth";
  enabled: boolean;
  scope: McpScope;
  /** Explicit user consent to expose the bound project's path through roots/list. */
  shareProjectRoot?: boolean;
  toolPolicy: McpToolPolicy;
  createdAt: string;
  /**
   * stdio only: sha256 over `JSON.stringify([command, args, cwd ?? null, env names])` as approved
   * in the native trust dialog. A hand-edited connectors.json therefore cannot start a different
   * program than the one the user saw.
   */
  trustedLaunch?: string;
  /** Absent means `'user'`. */
  source?: McpConnectorSource;
}

export interface McpConnectorsFile {
  version: 1;
  connectors: McpConnector[];
}

/**
 * `idle` — configured, never connected this session. `connecting`/`ready`/`failed` follow the
 * connection. `disabled` is the user's switch, not a fault.
 */
export const McpHealth = {
  Disabled: "disabled",
  Idle: "idle",
  Connecting: "connecting",
  Ready: "ready",
  Failed: "failed",
} as const;
export type McpHealth = (typeof McpHealth)[keyof typeof McpHealth];

export interface McpToolSummary {
  /** The name the server itself uses. */
  name: string;
  /** The sanitized half of `<connectorId>__<exposedName>`. */
  exposedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** False when `toolPolicy` filters it out. */
  allowed: boolean;
}

export interface McpConnectorView {
  connector: McpConnector;
  health: McpHealth;
  error?: string;
  toolCount: number;
  /** Secret keys this connector has values for, as `env.NAME` / `header.NAME`. Names only. */
  secrets: string[];
  /** stdio: the recorded launch digest still matches. Non-stdio connectors are always true. */
  trusted: boolean;
  /**
   * False in a profile without OS encryption (`STUDIO_DISABLE_OS_CREDENTIALS=1`, a keychain
   * Studio cannot open, or Linux without a keyring): connectors still work, but a value typed into a secret field has
   * nowhere to live, and the card says so instead of losing it.
   */
  secretsAvailable: boolean;
  /** Why secrets cannot be stored, when `secretsAvailable` is false and main knows. */
  secretsLocked?: SecretStorageIssue;
  lastConnectedAt?: string;
  /** An approved configuration waits for this connector's existing calls to finish. */
  pending?: boolean;
  authentication?: { state: "locked" | "signed-out" | "authorizing" | "connected" | "failed"; error?: string };
  /** The server's own name for itself (MCP `serverInfo.title`), once it has connected this session. */
  title?: string;
  /** The server's own picture (MCP `serverInfo.icons`) as a checked `data:` URL, once it has connected. */
  icon?: string;
}

export interface McpTestResult {
  ok: boolean;
  tools: McpToolSummary[];
  error?: string;
  durationMs: number;
}

/** Payload of the `mcp.changed` UI event. */
export interface McpChange {
  id: string;
  health: McpHealth;
  error?: string;
}

/**
 * The arguments a toolset gateway takes (Epic's Unreal MCP: `list_toolsets`, `describe_toolset`,
 * `call_tool`): which toolset, which of its tools, and that tool's own arguments. A connector
 * call's record names the toolset and tool it reached through them.
 */
export const ToolsetGatewayArg = {
  Toolset: "toolset_name",
  Tool: "tool_name",
  Arguments: "arguments",
} as const;
export type ToolsetGatewayArg = (typeof ToolsetGatewayArg)[keyof typeof ToolsetGatewayArg];

/** How much of a connector call's arguments its records keep, as characters of JSON. */
export const CONNECTOR_ARGS_RECORD_MAX = 1024;

/** Where a game keeps the pictures its connectors answered with, relative to its folder. */
export const CONNECTOR_CAPTURES_DIR = ".studio/captures";

/**
 * The `_meta` entry a connector's error answer carries when the call may have taken effect before
 * it failed (the app it drives went away mid-call): the host records the call as outcome unknown.
 */
export const CONNECTOR_OUTCOME_META = { Key: "genex/outcome", Unknown: "unknown" } as const;

/** What a connector call was, as both of its records carry it. */
export interface ConnectorCall {
  /** Pairs a call's `connector_tool_started` with its `connector_tool`; absent in older logs. */
  callId?: string;
  connectorId: string;
  /** The server's own tool name. */
  tool: string;
  /** The name the agent called it by, after the connector's prefix. */
  exposedName: string;
  /** The plugin that ships this connector, when one does. */
  pluginId?: string;
  /** The connector as the person knows it when the call ran: its plugin's name, else its own. */
  connectorName?: string;
  /** A toolset gateway's toolset and tool ({@link ToolsetGatewayArg}). */
  toolset?: string;
  toolName?: string;
  /**
   * The tool's own arguments (a gateway call's `arguments`), clipped to
   * {@link CONNECTOR_ARGS_RECORD_MAX} characters of JSON, credential-named fields redacted.
   */
  args?: Record<string, unknown>;
  /** What the call makes, when the server's listing of the tool says (`_meta["genex/asset"]`). */
  making?: CallMaking;
}

/** Payload of the `connector_tool_started` thread custom event: the call, on its way out. */
export interface ConnectorToolStartedEvent extends ConnectorCall {
  callId: string;
}

/** Payload of the `connector_tool` thread custom event: the call, and how it ended. */
export interface ConnectorToolEvent extends ConnectorCall {
  ok: boolean;
  durationMs: number;
  /** The answer's text, capped for the log. */
  result?: string;
  error?: string;
  /** How many image parts came back; the bytes themselves never enter the log. */
  images?: number;
  /** The pictures kept in the game's {@link CONNECTOR_CAPTURES_DIR}, as game-relative paths. */
  captures?: string[];
  /** Set when the call was cut off: its outcome is unknown. */
  cutOff?: CallCutOff;
}

export function isMcpScope(value: unknown): value is McpScope {
  if (value === "global") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const projects = (value as { projects?: unknown }).projects;
  return Array.isArray(projects) && projects.every((p) => typeof p === "string");
}

export function mcpScopeCovers(scope: McpScope, project?: string | null): boolean {
  if (scope === "global") return true;
  return !!project && scope.projects.includes(project);
}

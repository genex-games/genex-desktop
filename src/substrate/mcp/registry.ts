/**
 * The connector registry — the MCP half of what `PluginRegistry` is for plugins.
 *
 * It owns the connector list, one `McpConnection` per enabled connector, the tool cache, health
 * and leases, and it is the only thing that turns a server's tools into names an engine may
 * call. Everything it publishes is namespaced `<connectorId>__<exposedTool>` and travels the
 * existing `liveTools`/`onLiveTool` channel, so Claude Code, Codex and the local harness get one
 * trust, consent and observability model instead of three.
 *
 * Four rules it never bends:
 *  - **Agents cannot mutate connectors.** There is no save or remove on the RPC table; every
 *    mutation here is reached from the Studio UI through IPC.
 *  - **A stdio connector launches only on a matching trust digest.** A hand-edited
 *    connectors.json cannot start a different program than the one the user approved.
 *  - **One broken connector is not a broken delegation.** `toolsFor` connects in parallel, isolates
 *    failures, and a server that will not answer contributes nothing and reads `failed`.
 *  - **`tool()` fails closed.** Disabled, out of scope, untrusted, denied by policy or simply
 *    unknown all refuse before anything is spawned.
 *
 * A connection is opened per project only when the project changes what the server sees (a
 * per-project launch, or a shared project root); every other connector runs one process for all
 * games. A connection with no lease and no call for `idleCloseMs` is closed, and the next use
 * opens it again.
 */
import {
  MCP_ID,
  MCP_QUALIFIED_TOOL,
  mcpScopeCovers,
  uniqueToolName,
  McpHealth,
  McpTransport,
  type McpChange,
  type McpConnector,
  type McpConnectorView,
  type McpTestResult,
  type McpToolSummary,
} from "../../shared/mcp.ts";
import type { LiveToolResult } from "../engines/types.ts";
import type { McpLiveTool } from "../../shared/mcp.ts";
import type { SecretStorageIssue } from "../../shared/secret-storage.ts";
import { exposedToolName, flatParameters } from "../engines/tool-schema.ts";
import {
  McpConnection,
  CALL_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  type McpLaunch,
  type McpLaunchContext,
  type McpRawTool,
  type McpServerIdentity,
} from "./client.ts";
import { pickServerIcon, resolveServerIcon } from "./server-icon.ts";
import {
  McpSecretsLocked,
  McpStore,
  launchDigest,
  launchTrusted,
  secretKey,
  storedSecretFields,
  validateConnector,
  type SecretPort,
} from "./store.ts";
import { McpAuthState, McpOAuthAccount } from "./oauth.ts";
import { McpSessionSecrets } from "./session-secrets.ts";
import { resetToolchain } from "../toolchain.ts";
import { errorMessage } from "../../shared/errors.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";

/** The harness reads connector tools over `mcp.tools`, so their shape lives in `shared/mcp.ts`. */
export type { McpLiveTool };

/** An MCP server a plugin declares. In memory only: it is never written to connectors.json. */
export interface McpPluginServer {
  /** Server id inside the plugin; the connector id becomes `<pluginId>-<id>`. */
  id: string;
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  /** Environment variable names the host materializes; values never come from the manifest. */
  env?: string[];
  toolPolicy?: { allow?: string[]; deny?: string[] };
  maxTools?: number;
  callTimeoutMs?: number;
  description?: string;
  /**
   * Why this server cannot run yet, in words a person can act on ("unlock the account first").
   * It is still listed — a server the user has not finished setting up is a thing to finish, not
   * a thing to hide — but switched off, so nothing tries to start it.
   */
  unavailable?: string;
}

export interface McpRegistryOptions {
  file: string;
  secrets?: SecretPort | null;
  /** Why `secrets` is null, shown on every connector card. */
  secretsLocked?: SecretStorageIssue | null;
  onChange?: (change: McpChange) => void;
  /** Injected in tests so no suite ever reaches a real network. */
  fetchImpl?: typeof fetch;
  resolveProject?: (project: string) => Promise<string>;
  /** How long a connection may sit with no lease and no call before it is closed. */
  idleCloseMs?: number;
  /** The clock the idle close runs on; answers a cancel. Injected in tests. */
  schedule?: (run: () => void, ms: number) => () => void;
  /** How long `close()` waits for any one connection before leaving it behind. */
  closeTimeoutMs?: number;
}

/**
 * On quit a connection gets this long to close. A stdio close ends its child (SIGTERM, then
 * SIGKILL after 2 s), so past this the process is already on its way out; waiting longer would
 * only eat the quit budget the harness stop shares.
 */
export const CLOSE_TIMEOUT_MS = 3 * SECOND_MS;

/** An unused connection holds a process (stdio) or a client (http) for no one past this. */
export const IDLE_CLOSE_MS = 10 * MINUTE_MS;

function scheduleUnref(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** Past this a server's tool list is a prompt-cost problem, not a feature. */
export const MAX_TOOLS_PER_CONNECTOR = 64;
const MAX_DESCRIPTION = 1_000;
/** When connections disagree, the connector reads as the first of these any of them is in. */
const HEALTH_PRECEDENCE = [McpHealth.Connecting, McpHealth.Ready, McpHealth.Failed, McpHealth.Idle] as const;

/** What a person reads when the registry refuses a connector, a secret or a tool call. */
const MESSAGE = {
  PluginIdTooLong: "A plugin id that owns a connector must fit a connector id",
  InvalidServerId: "Invalid plugin server id",
  ConnectorIdTooLong: (id: string) => `Connector id ${id} is too long`,
  OwnedByPlugin: "This connector belongs to a plugin; change it there",
  PluginConnectorByHand: "A plugin connector cannot be saved by hand",
  Untrusted: (name: string) => `${name} has not been trusted to start on this Mac`,
  UnknownConnector: "Unknown connector",
  NoSecretStorage: "This profile cannot store secrets: Studio has no OS encryption here.",
  UnknownSecretField: (field: string) => `Unknown secret field: ${field}`,
  UndeclaredSecret: (name: string) => `${name} is not declared on this connector`,
  RemoveThePlugin: "This connector belongs to a plugin; remove the plugin instead",
  IdTaken: "A connector with that id already exists",
  SwitchedOffOrChanged: (name: string) => `${name} is switched off or its configuration changed`,
  UnknownTool: "Unknown connector tool",
  NotEnabledForProject: (name: string) => `${name} is not enabled for this project`,
  ToolNotAllowed: (tool: string, name: string) => `${tool} is not allowed on ${name}`,
  ToolNoLongerAllowed: (tool: string, name: string) => `${tool} is no longer allowed on ${name}`,
  NoBrowserSignIn: "This connector has no browser sign-in",
  NotEnabledForSelectedProject: "This connector is not enabled for the selected project",
  TestUntrusted: "This connector has not been trusted to start on this Mac.",
} as const;

interface Entry {
  connector: McpConnector;
  launch?: McpLaunch;
  callTimeoutMs?: number;
  maxTools?: number;
  /** A plugin's server disappears with the plugin and is never persisted. */
  plugin?: string;
  /** What the server is for, in the plugin's own words; it rides along in the prompt guidance. */
  description?: string;
  /** Missing plugin prerequisites apply to every project, unlike transport failures. */
  unavailable?: string;
}

/** A server's title and picture as the connector list shows them, when it has introduced itself. */
function identityView(
  identity: { title?: string; icon?: string } | undefined,
): Pick<McpConnectorView, "title" | "icon"> {
  return {
    ...(identity?.title ? { title: identity.title } : {}),
    ...(identity?.icon ? { icon: identity.icon } : {}),
  };
}

/**
 * What one start of an entry runs: its connector (with a resolved working directory), its launch
 * (with the resolved environment merged over the declared one) and the secrets that start hands over.
 */
function launchOptions(
  entry: Entry,
  extra: McpLaunchContext | undefined,
): Pick<ConstructorParameters<typeof McpConnection>[0], "connector" | "launch" | "secretValues"> {
  const connector = extra?.cwd ? { ...entry.connector, cwd: extra.cwd } : entry.connector;
  const launch =
    entry.launch && extra?.extraEnv
      ? { ...entry.launch, extraEnv: { ...entry.launch.extraEnv, ...extra.extraEnv } }
      : entry.launch;
  return {
    connector,
    ...(extra?.secrets ? { secretValues: extra.secrets } : {}),
    ...(launch ? { launch } : {}),
  };
}

const isPluginSource = (source: McpConnector["source"]) => Boolean(source) && source !== "user";

/** `<pluginId>-<serverId>`, each part and the whole a valid connector id. */
function pluginConnectorId(pluginId: string, definition: McpPluginServer): string {
  if (!MCP_ID.test(pluginId)) throw new Error(MESSAGE.PluginIdTooLong);
  if (!MCP_ID.test(definition.id)) throw new Error(MESSAGE.InvalidServerId);
  const id = `${pluginId}-${definition.id}`;
  if (!MCP_ID.test(id)) throw new Error(MESSAGE.ConnectorIdTooLong(id));
  return id;
}

/** A plugin server as a validated stdio connector, trusted by the plugin's own install dialog. */
function pluginConnector(
  id: string,
  pluginId: string,
  definition: McpPluginServer,
  createdAt: string | undefined,
): McpConnector {
  const connector = validateConnector({
    id,
    name: definition.name,
    transport: McpTransport.Stdio,
    command: definition.command,
    args: definition.args ?? [],
    ...(definition.cwd ? { cwd: definition.cwd } : {}),
    ...(definition.env?.length ? { env: definition.env } : {}),
    // A server whose requirements are not met yet is listed switched off, with the reason, so
    // the user can see what is missing instead of watching a connection fail.
    enabled: !definition.unavailable,
    scope: "global",
    toolPolicy: definition.toolPolicy ?? {},
    createdAt: createdAt ?? new Date().toISOString(),
    source: { plugin: pluginId, server: definition.id },
  });
  connector.trustedLaunch = launchDigest(connector);
  return connector;
}

/** A plugin server's registry entry: its connector plus the launch and limits only the plugin knows. */
function pluginEntry(
  pluginId: string,
  definition: McpPluginServer,
  connector: McpConnector,
  launch: McpLaunch | undefined,
): Entry {
  const entry: Entry = { connector, plugin: pluginId };
  if (launch) entry.launch = launch;
  if (definition.callTimeoutMs) entry.callTimeoutMs = definition.callTimeoutMs;
  if (definition.maxTools) entry.maxTools = definition.maxTools;
  if (definition.description) entry.description = definition.description;
  if (definition.unavailable) entry.unavailable = definition.unavailable;
  return entry;
}

/** The user's own connector as saved from the card, dated, and never one a plugin owns. */
function validatedUserConnector(input: unknown, previous: McpConnector | undefined): McpConnector {
  const draft = { ...(input as McpConnector) } as McpConnector;
  if (!draft.createdAt) draft.createdAt = previous?.createdAt ?? new Date().toISOString();
  if (isPluginSource(previous?.source)) throw new Error(MESSAGE.OwnedByPlugin);
  if (isPluginSource(draft.source)) throw new Error(MESSAGE.PluginConnectorByHand);
  return validateConnector(draft);
}

/**
 * A stdio connector runs a program on this Mac: the digest the user approved is the only one that
 * launches, and a changed command needs a new dialog. Remote connectors carry no digest.
 */
function applyTrust(connector: McpConnector, previous: McpConnector | undefined, trust: boolean): void {
  if (connector.transport !== McpTransport.Stdio) {
    delete connector.trustedLaunch;
    return;
  }
  const digest = launchDigest(connector);
  if (trust || previous?.trustedLaunch === digest) connector.trustedLaunch = digest;
  else delete connector.trustedLaunch;
}

/** The OAuth account no longer matches: the connector is off, or its url or sign-in changed. */
const accountChanged = (previous: McpConnector | undefined, next: McpConnector) =>
  !next.enabled || previous?.url !== next.url || previous?.authentication !== next.authentication;

/** A parked configuration no longer lets this tool run for this project. */
function pendingRefuses(pending: McpConnector | undefined, project: string | null, allowed: boolean): boolean {
  if (!pending) return false;
  return !pending.enabled || !mcpScopeCovers(pending.scope, project) || !allowed;
}

export class McpRegistry {
  readonly store: McpStore;
  #secrets: SecretPort | null;
  #secretsLocked: SecretStorageIssue | null;
  #sessionSecrets: McpSessionSecrets | null;
  #onChange: ((change: McpChange) => void) | undefined;
  #fetch: typeof fetch | undefined;
  /** How each server introduced itself when it last connected: its title and its checked picture. */
  #identity = new Map<string, { title?: string; icon?: string; iconSrc?: string }>();
  #resolveProject: McpRegistryOptions["resolveProject"];
  #oauth = new Map<string, McpOAuthAccount>();
  #oauthProject = new Map<string, string | null>();
  #entries = new Map<string, Entry>();
  /** Keyed by connector, then by `#key` — a project only for connectors that depend on it. */
  #connections = new Map<string, Map<string | null, McpConnection>>();
  #errors = new Map<string, string>();
  #exposed = new Map<string, Map<string | null, Map<string, string>>>();
  #leases = new Map<string, number>();
  /** Leases and calls in flight per connection key: a busy connection is never idle-closed. */
  #busy = new Map<string, Map<string | null, number>>();
  /** Leases taken for every project at once (`lease()` with no project) hold every key. */
  #allLeases = new Map<string, number>();
  #idleTimers = new Map<string, Map<string | null, () => void>>();
  #idleMs: number;
  #schedule: (run: () => void, ms: number) => () => void;
  #closeMs: number;
  #pending = new Map<string, { connector: McpConnector; secrets?: Record<string, string> }>();
  #removals = new Set<string>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: McpRegistryOptions) {
    this.store = new McpStore(options.file);
    this.#secrets = options.secrets ?? null;
    this.#secretsLocked = this.#secrets ? null : (options.secretsLocked ?? null);
    this.#sessionSecrets = this.#secrets ? new McpSessionSecrets(this.#secrets) : null;
    this.#onChange = options.onChange;
    this.#fetch = options.fetchImpl;
    this.#resolveProject = options.resolveProject;
    this.#idleMs = options.idleCloseMs ?? IDLE_CLOSE_MS;
    this.#schedule = options.schedule ?? scheduleUnref;
    this.#closeMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
  }

  get secretsAvailable(): boolean {
    return !!this.#secrets;
  }

  /** A view's `secretsLocked`, present only when the store is locked and the reason is known. */
  #lockedView(): { secretsLocked?: SecretStorageIssue } {
    return this.#secretsLocked ? { secretsLocked: this.#secretsLocked } : {};
  }

  #account(entry: Entry, _project: string | null = null): McpOAuthAccount | undefined {
    const c = entry.connector;
    if (c.authentication !== "oauth" || !c.url) return undefined;
    let account = this.#oauth.get(c.id);
    if (account && account.url !== c.url) {
      account.lock();
      this.#oauth.delete(c.id);
      account = undefined;
    }
    if (!account) {
      account = new McpOAuthAccount(
        c.id,
        c.url,
        this.#secrets,
        () => this.#fire(c.id),
        async () => {
          await this.#drop(c.id);
          await this.connect(c.id, this.#oauthProject.get(c.id) ?? null);
        },
        this.#fetch,
      );
      this.#oauth.set(c.id, account);
    }
    return account;
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn);
    this.#tail = next.catch(() => {});
    return next;
  }

  /**
   * Keep how a server introduced itself: its title at once, and its picture once fetched and
   * checked (a picture already held for the same source is not fetched again).
   */
  #learnIdentity(id: string, identity: McpServerIdentity | undefined): void {
    const known = this.#identity.get(id);
    const icon = pickServerIcon(identity?.icons);
    const next = { ...(identity?.title ? { title: identity.title } : {}) };
    const same = icon && known?.iconSrc === icon.src;
    this.#identity.set(id, same ? { ...next, icon: known?.icon, iconSrc: icon.src } : next);
    if (!icon || same) return;
    void resolveServerIcon(icon, this.#fetch).then((picture) => {
      const current = this.#identity.get(id);
      if (!picture || !current || !this.#entries.has(id)) return;
      this.#identity.set(id, { ...current, icon: picture, iconSrc: icon.src });
      this.#fire(id);
    });
  }

  #fire(id: string): void {
    const health = this.#health(id);
    const error = this.#errors.get(id);
    try {
      this.#onChange?.({ id, health, ...(error ? { error } : {}) });
    } catch {
      /* a reporting hook never fails a mutation */
    }
  }

  async init(): Promise<void> {
    const loaded = await this.store.load();
    for (const [id, message] of loaded.errors) this.#errors.set(id, message);
    for (const connector of loaded.connectors) this.#entries.set(connector.id, { connector });
  }

  #health(id: string): McpHealth {
    const entry = this.#entries.get(id);
    if (!entry) return McpHealth.Failed;
    if (!entry.connector.enabled) return McpHealth.Disabled;
    const connections = [...(this.#connections.get(id)?.values() ?? [])];
    for (const health of HEALTH_PRECEDENCE) if (connections.some((c) => c.health === health)) return health;
    return this.#errors.has(id) ? McpHealth.Failed : McpHealth.Idle;
  }

  /** The connection a view describes: the project's own, or any ready one for the all-projects view. */
  #viewConnection(id: string, entry: Entry, project: string | null | undefined): McpConnection | undefined {
    if (project === undefined)
      return [...(this.#connections.get(id)?.values() ?? [])].find((c) => c.health === McpHealth.Ready);
    return this.#connections.get(id)?.get(this.#key(entry, project));
  }

  /** Switched off, signing in, the connector's overall health, or this project's connection's. */
  #viewHealth(id: string, entry: Entry, project: string | null | undefined, connection?: McpConnection): McpHealth {
    if (!entry.connector.enabled) return McpHealth.Disabled;
    if (this.#oauth.get(id)?.state === McpAuthState.Authorizing) return McpHealth.Connecting;
    if (project === undefined) return this.#health(id);
    return connection?.health ?? McpHealth.Idle;
  }

  async #viewFor(id: string, entry: Entry, project: string | null | undefined): Promise<McpConnectorView> {
    const connection = this.#viewConnection(id, entry, project);
    const account = this.#oauth.get(id);
    const authorizing = account?.state === McpAuthState.Authorizing;
    // An OAuth challenge deliberately ends the initial transport attempt. The
    // browser flow is still active; it is not a failed account connection.
    const error = authorizing
      ? undefined
      : (entry.unavailable ?? connection?.error ?? (project === undefined ? this.#errors.get(id) : undefined));
    const toolCount = project === undefined ? this.#toolCount(id) : (this.#exposed.get(id)?.get(project)?.size ?? 0);
    return {
      connector: entry.connector,
      health: this.#viewHealth(id, entry, project, connection),
      ...(error ? { error } : {}),
      toolCount,
      pending: this.#pending.has(id) || this.#removals.has(id),
      ...(entry.connector.authentication === "oauth"
        ? { authentication: { state: account?.state ?? McpAuthState.Locked, error: account?.error } }
        : {}),
      secrets: await storedSecretFields(this.#secrets, entry.connector),
      trusted: launchTrusted(entry.connector),
      secretsAvailable: this.secretsAvailable,
      ...this.#lockedView(),
      ...(connection?.lastConnectedAt ? { lastConnectedAt: connection.lastConnectedAt } : {}),
      ...identityView(this.#identity.get(id)),
    };
  }

  async list(project?: string | null): Promise<McpConnectorView[]> {
    const views: McpConnectorView[] = [];
    for (const [id, entry] of this.#entries) views.push(await this.#viewFor(id, entry, project));
    return views.sort((a, b) => a.connector.id.localeCompare(b.connector.id));
  }

  /** The connectors the file owns, for the IPC layer's own checks. */
  ids(): string[] {
    return [...this.#entries.keys()];
  }

  /**
   * The one sentence that stands between a hand-edited `connectors.json` and a program starting
   * on this Mac. Every path that can spawn a child says it, so none of them can forget to.
   */
  #assertTrusted(entry: Entry): void {
    if (entry.connector.transport !== McpTransport.Stdio) return;
    if (!launchTrusted(entry.connector)) throw new Error(MESSAGE.Untrusted(entry.connector.name));
  }

  /**
   * Does the project change what this server sees? A per-project launch (its own working
   * directory and HOME) or a shared project root does; nothing else does, so such a connector is
   * one process for every game rather than one per game touched.
   */
  #perProject(entry: Entry): boolean {
    return !!entry.launch?.perProject || !!entry.connector.shareProjectRoot;
  }

  /** The connection key for a project: the project itself, or `null` for a shared connection. */
  #key(entry: Entry, project: string | null | undefined): string | null {
    return this.#perProject(entry) ? (project ?? null) : null;
  }

  /**
   * The live connection to one connector, for one project.
   *
   * A per-project connector's connections and schemas belong to their project: parallel games
   * never close one another's process or reuse another game's roots, working directory or tool
   * list. Any other connector is shared.
   */
  async #connection(id: string, project: string | null = null): Promise<McpConnection> {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(MESSAGE.UnknownConnector);
    this.#assertCurrent(id, entry);
    // Belt and braces. Every caller checks the digest before it gets here, and nothing that starts
    // a program on this Mac should depend on every caller remembering to.
    this.#assertTrusted(entry);
    const key = this.#key(entry, project);
    return this.#connections.get(id)?.get(key) ?? this.#openConnection(id, entry, key, project);
  }

  /** Resolve the launch for `key`, then create and register its connection unless a racing call already did. */
  async #openConnection(id: string, entry: Entry, key: string | null, project: string | null): Promise<McpConnection> {
    const extra = entry.launch?.resolve ? await entry.launch.resolve(key) : undefined;
    const root =
      key && entry.connector.shareProjectRoot && this.#resolveProject ? await this.#resolveProject(key) : null;
    this.#assertCurrent(id, entry);
    // Concurrent first calls may both resolve the launch; only one owns the transport.
    const existing = this.#connections.get(id)?.get(key);
    if (existing) return existing;
    const account = this.#account(entry, project);
    const connection: McpConnection = new McpConnection({
      ...launchOptions(entry, extra),
      project: root,
      authProvider: account?.provider(),
      redact: account?.redactor(),
      secrets: this.#sessionSecrets,
      ...(this.#fetch ? { fetchImpl: this.#fetch } : {}),
      onHealth: (health, error) => {
        // A save that dropped this attempt has already put a fresh entry in its place; the old
        // attempt's last word ("Connection closed") must not mark that new one failed.
        if (this.#connections.get(id)?.get(key) !== connection) return;
        if (error) this.#errors.set(id, error);
        else if (health === McpHealth.Ready) this.#errors.delete(id);
        if (health === McpHealth.Ready) this.#learnIdentity(id, connection.identity);
        this.#fire(id);
      },
      onToolsChanged: () => {
        if (this.#connections.get(id)?.get(key) !== connection) return;
        // A shared connection's list is every project's list.
        if (this.#perProject(entry)) this.#exposed.get(id)?.delete(key);
        else this.#exposed.delete(id);
        this.#fire(id);
      },
    });
    const scoped = this.#connections.get(id) ?? new Map();
    scoped.set(key, connection);
    this.#connections.set(id, scoped);
    this.#arm(id, key);
    return connection;
  }

  async #drop(id: string): Promise<void> {
    const connections = this.#connections.get(id);
    this.#connections.delete(id);
    this.#exposed.delete(id);
    for (const cancel of this.#idleTimers.get(id)?.values() ?? []) cancel();
    this.#idleTimers.delete(id);
    await Promise.all([...(connections?.values() ?? [])].map((c) => c.close().catch(() => {})));
  }

  #cancelIdle(id: string, key: string | null): void {
    const timers = this.#idleTimers.get(id);
    timers?.get(key)?.();
    timers?.delete(key);
  }

  #idle(id: string, key: string | null): boolean {
    return !this.#busy.get(id)?.get(key) && !this.#allLeases.get(id);
  }

  /** (Re)start the idle clock of a connection nobody holds. Any use restarts it. */
  #arm(id: string, key: string | null): void {
    this.#cancelIdle(id, key);
    if (!this.#connections.get(id)?.has(key) || !this.#idle(id, key)) return;
    const timers = this.#idleTimers.get(id) ?? new Map<string | null, () => void>();
    timers.set(
      key,
      this.#schedule(() => this.#closeIdle(id, key), this.#idleMs),
    );
    this.#idleTimers.set(id, timers);
  }

  #hold(id: string, key: string | null): void {
    const counts = this.#busy.get(id) ?? new Map<string | null, number>();
    counts.set(key, (counts.get(key) ?? 0) + 1);
    this.#busy.set(id, counts);
    this.#cancelIdle(id, key);
  }

  #letGo(id: string, key: string | null): void {
    const counts = this.#busy.get(id);
    const left = (counts?.get(key) ?? 1) - 1;
    if (counts && left > 0) counts.set(key, left);
    else {
      counts?.delete(key);
      if (counts && !counts.size) this.#busy.delete(id);
    }
    this.#arm(id, key);
  }

  /**
   * Close one idle connection. Only that key goes: its cached tool names stay for planning, and
   * the next call reconnects through `#connection` as it would after a restart.
   */
  async #closeIdle(id: string, key: string | null): Promise<void> {
    this.#idleTimers.get(id)?.delete(key);
    const scoped = this.#connections.get(id);
    const connection = scoped?.get(key);
    if (!scoped || !connection || !this.#idle(id, key)) return;
    scoped.delete(key);
    if (!scoped.size) this.#connections.delete(id);
    await connection.close().catch(() => {});
    this.#fire(id);
  }

  #toolCount(id: string): number {
    return new Set([...(this.#exposed.get(id)?.values() ?? [])].flatMap((m) => [...m.keys()])).size;
  }

  async #persist(): Promise<void> {
    await this.store.save(
      [...this.#entries.values()]
        .filter((e) => !e.plugin && !this.#removals.has(e.connector.id))
        .map((e) => e.connector),
    );
  }

  /**
   * Create or replace a connector. A save while a delegation holds the registry is parked and
   * applied by the last `release()`, exactly as a plugin update is: a live session never has a
   * tool list changed underneath it.
   */
  async save(
    input: unknown,
    secrets?: Record<string, string>,
    options: { trust?: boolean } = {},
  ): Promise<McpConnectorView> {
    return this.#serial(async () => {
      const previous = this.#entries.get((input as McpConnector)?.id)?.connector;
      const connector = validatedUserConnector(input, previous);
      applyTrust(connector, previous, options.trust === true);
      if (this.#leases.get(connector.id)) return this.#parkWhileLeased(connector, previous, secrets);
      await this.#forgetDropped(previous, connector);
      if (secrets) await this.#writeSecrets(connector, secrets);
      if (accountChanged(previous, connector)) this.#oauth.get(connector.id)?.lock();
      if (!connector.enabled) this.#sessionSecrets?.lock(connector.id);
      this.#entries.set(connector.id, { connector });
      await this.#persist();
      await this.#drop(connector.id);
      this.#errors.delete(connector.id);
      this.#fire(connector.id);
      return this.#view(connector);
    });
  }

  /**
   * A save while a delegation holds the connector waits for the release; switching it off still
   * takes effect at once.
   */
  async #parkWhileLeased(
    connector: McpConnector,
    previous: McpConnector | undefined,
    secrets: Record<string, string> | undefined,
  ): Promise<McpConnectorView> {
    // Revocation is immediate, even while the old schema/version is leased. Persist it
    // before stopping local work so a restart cannot resurrect the enabled connector.
    if (!connector.enabled && previous) {
      this.#oauth.get(connector.id)?.lock();
      this.#sessionSecrets?.lock(connector.id);
      previous.enabled = false;
      await this.#persist();
      await this.#drop(connector.id);
      this.#fire(connector.id);
    }
    // Last answer wins: saving a connector the user removed a moment ago during the same
    // delegation puts it back, rather than being applied and then undone by the queued removal.
    this.#removals.delete(connector.id);
    this.#pending.set(connector.id, { connector, secrets });
    this.#fire(connector.id);
    return this.#view(connector);
  }

  async #writeSecrets(connector: McpConnector, secrets: Record<string, string>): Promise<void> {
    const entries = Object.entries(secrets ?? {});
    if (!entries.length) return;
    const lease = this.#sessionSecrets;
    if (!this.#secrets || !lease) throw new Error(MESSAGE.NoSecretStorage);
    for (const [field, value] of entries) {
      const match = /^(env|header)\.(.+)$/.exec(field);
      if (!match) throw new Error(MESSAGE.UnknownSecretField(field));
      const kind = match[1] as "env" | "header";
      const name = match[2];
      const declared = (kind === "env" ? connector.env : connector.headers) ?? [];
      if (!declared.includes(name)) throw new Error(MESSAGE.UndeclaredSecret(name));
      if (value === "") await lease.delete(secretKey(connector.id, kind, name));
      else await lease.set(secretKey(connector.id, kind, name), value);
    }
  }

  /** An env or header name an edit dropped takes its stored value with it. */
  async #forgetDropped(previous: McpConnector | undefined, next: McpConnector): Promise<void> {
    if (!previous || !this.#sessionSecrets) return;
    for (const kind of ["env", "header"] as const) {
      const kept = new Set((kind === "env" ? next.env : next.headers) ?? []);
      for (const name of (kind === "env" ? previous.env : previous.headers) ?? [])
        if (!kept.has(name)) await this.#sessionSecrets.delete(secretKey(previous.id, kind, name)).catch(() => {});
    }
  }

  /** Every stored value under this connector's id, including names an older version declared. */
  async #eraseSecrets(id: string): Promise<void> {
    for (const key of (await this.#secrets?.list().catch(() => [])) ?? [])
      if (key.startsWith(`mcp.${id}.`)) await this.#secrets?.delete(key).catch(() => {});
  }

  async #view(connector: McpConnector): Promise<McpConnectorView> {
    const id = connector.id;
    const error = this.#errors.get(id);
    return {
      connector,
      health: this.#health(id),
      ...(error ? { error } : {}),
      toolCount: this.#toolCount(id),
      pending: this.#pending.has(id) || this.#removals.has(id),
      secrets: await storedSecretFields(this.#secrets, connector),
      trusted: launchTrusted(connector),
      secretsAvailable: this.secretsAvailable,
      ...this.#lockedView(),
    };
  }

  async remove(id: string): Promise<void> {
    return this.#serial(async () => {
      const entry = this.#entries.get(id);
      if (!entry) throw new Error(MESSAGE.UnknownConnector);
      if (entry.plugin) throw new Error(MESSAGE.RemoveThePlugin);
      // Revoked at the server where it offers that, even if never connected this session.
      await this.#account(entry)?.disconnect();
      this.#oauth.delete(id);
      this.#sessionSecrets?.lock(id);
      if (this.#leases.get(id)) {
        this.#removals.add(id);
        this.#pending.delete(id);
        entry.connector.enabled = false;
        await this.#persist();
        await this.#drop(id);
        await this.#eraseSecrets(id);
        this.#fire(id);
        return;
      }
      this.#entries.delete(id);
      this.#pending.delete(id);
      await this.#drop(id);
      this.#errors.delete(id);
      await this.#eraseSecrets(id);
      await this.#persist();
      this.#fire(id);
    });
  }

  /**
   * Register an MCP server a plugin declares. Memory only, owned by the plugin, and trusted by
   * the plugin's own install dialog — the digest is recorded here so the launch path treats it
   * exactly like a user connector the user approved.
   */
  async registerPluginServer(pluginId: string, definition: McpPluginServer, launch?: McpLaunch): Promise<McpConnector> {
    return this.#serial(async () => {
      const id = pluginConnectorId(pluginId, definition);
      const existing = this.#entries.get(id);
      if (existing && existing.plugin !== pluginId) throw new Error(MESSAGE.IdTaken);
      const connector = pluginConnector(id, pluginId, definition, existing?.connector.createdAt);
      await this.#drop(id);
      this.#entries.set(id, pluginEntry(pluginId, definition, connector, launch));
      if (definition.unavailable) this.#errors.set(id, definition.unavailable);
      else this.#errors.delete(id);
      this.#fire(id);
      return connector;
    });
  }

  /**
   * A plugin was replaced by a package with another identity (M5): the servers it declared lose
   * every secret stored under their connector ids — env and header values and OAuth tokens — so a
   * same-named server of the new package starts without them. A user's own connector that happens
   * to carry such an id is not the plugin's, and keeps its secrets.
   */
  async erasePluginSecrets(pluginId: string, serverIds: string[]): Promise<void> {
    return this.#serial(async () => {
      const ids = serverIds.map((server) => `${pluginId}-${server}`).filter((id) => MCP_ID.test(id));
      const owned = ids.filter((id) => {
        const entry = this.#entries.get(id);
        return !entry || entry.plugin === pluginId;
      });
      if (!owned.length) return;
      const keys = (await this.#secrets?.list()) ?? [];
      for (const id of owned) {
        this.#oauth.get(id)?.lock();
        this.#sessionSecrets?.lock(id);
        for (const key of keys) if (key.startsWith(`mcp.${id}.`)) await this.#secrets?.delete(key).catch(() => {});
      }
    });
  }

  /** Every server a plugin owns goes away with it — disable, remove, update, cancel. */
  async unregisterPlugin(pluginId: string): Promise<void> {
    return this.#serial(async () => {
      for (const [id, entry] of [...this.#entries]) {
        if (entry.plugin !== pluginId) continue;
        this.#entries.delete(id);
        await this.#drop(id);
        this.#errors.delete(id);
        this.#fire(id);
      }
    });
  }

  /**
   * Pin only sources in this project's snapshot; new/unrelated connectors remain available. A
   * leased connection is never closed for being idle.
   */
  lease(project?: string | null): () => Promise<void> {
    const entries = (project === undefined ? [...this.#entries.values()] : this.#eligible(project)).filter(
      (e) => e.connector.enabled,
    );
    const ids = entries.map((e) => e.connector.id);
    const holds = project === undefined ? [] : entries.map((e) => ({ id: e.connector.id, key: this.#key(e, project) }));
    for (const id of ids) this.#leases.set(id, (this.#leases.get(id) ?? 0) + 1);
    for (const { id, key } of holds) this.#hold(id, key);
    if (project === undefined) for (const id of ids) this.#holdEverywhere(id);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      for (const { id, key } of holds) this.#letGo(id, key);
      if (project === undefined) for (const id of ids) this.#letGoEverywhere(id);
      await this.#serial(async () => {
        let changed = false;
        for (const id of ids) if (await this.#releaseLease(id)) changed = true;
        if (changed) await this.#persist();
      });
    };
  }

  /** A lease for every project holds each of the connector's connections open. */
  #holdEverywhere(id: string): void {
    this.#allLeases.set(id, (this.#allLeases.get(id) ?? 0) + 1);
    for (const cancel of this.#idleTimers.get(id)?.values() ?? []) cancel();
    this.#idleTimers.delete(id);
  }

  #letGoEverywhere(id: string): void {
    const left = (this.#allLeases.get(id) ?? 1) - 1;
    if (left > 0) this.#allLeases.set(id, left);
    else this.#allLeases.delete(id);
    for (const key of this.#connections.get(id)?.keys() ?? []) this.#arm(id, key);
  }

  /**
   * Drop one lease; the last one applies what waited for it — a queued removal, then a parked
   * save. True when the connectors file must be written.
   */
  async #releaseLease(id: string): Promise<boolean> {
    const count = (this.#leases.get(id) ?? 1) - 1;
    if (count > 0) {
      this.#leases.set(id, count);
      return false;
    }
    this.#leases.delete(id);
    let changed = false;
    if (this.#removals.delete(id)) {
      this.#entries.delete(id);
      await this.#drop(id);
      this.#errors.delete(id);
      changed = true;
      this.#fire(id);
    }
    const pending = this.#pending.get(id);
    if (!pending) return changed;
    this.#pending.delete(id);
    await this.#forgetDropped(this.#entries.get(id)?.connector, pending.connector);
    if (pending.secrets) await this.#writeSecrets(pending.connector, pending.secrets);
    this.#entries.set(id, { connector: pending.connector });
    await this.#drop(id);
    this.#errors.delete(id);
    this.#fire(id);
    return true;
  }

  /**
   * A user connector whose declared env or header values are still in the store: after a restart
   * nothing is unlocked until Connect, and a process started now would run without them.
   */
  #assertUnlocked(entry: Entry): void {
    if (!entry.plugin && this.#sessionSecrets?.locked(entry.connector)) throw new McpSecretsLocked();
  }

  #assertCurrent(id: string, entry: Entry): void {
    if (this.#entries.get(id) !== entry || this.#removals.has(id) || !entry.connector.enabled)
      throw new Error(MESSAGE.SwitchedOffOrChanged(entry.connector.name));
  }

  #eligible(project?: string | null): Entry[] {
    return [...this.#entries.values()].filter(
      (entry) =>
        entry.connector.enabled &&
        mcpScopeCovers(entry.connector.scope, project ?? null) &&
        launchTrusted(entry.connector),
    );
  }

  #allowed(entry: Entry, tool: string): boolean {
    const policy = entry.connector.toolPolicy ?? {};
    if (policy.deny?.includes(tool)) return false;
    if (policy.allow?.length) return policy.allow.includes(tool);
    return true;
  }

  /**
   * The tools this project's delegation may use. Every in-scope connector is connected in
   * parallel with its own timeout; one that fails contributes nothing, records why, and is
   * tried again the next time a delegation starts.
   */
  async toolsFor(project?: string | null, options: { signal?: AbortSignal } = {}): Promise<McpLiveTool[]> {
    const entries = this.#eligible(project);
    const lists = await Promise.all(entries.map((entry) => this.#listFor(entry, project, options.signal)));
    const live: McpLiveTool[] = [];
    for (const { entry, tools } of lists) {
      // Same reason: a list answered by a configuration the user has since replaced is not this
      // connector's tool list any more, and must not be published or cached as one.
      if (!this.#stillCurrent(entry)) continue;
      live.push(...this.#publish(entry, tools, project ?? null));
    }
    return live;
  }

  /** The entry is still the connector's configuration, switched on and not queued for removal. */
  #stillCurrent(entry: Entry): boolean {
    const id = entry.connector.id;
    return this.#entries.get(id) === entry && entry.connector.enabled && !this.#removals.has(id);
  }

  /** One connector's raw tools for a delegation; a failure records why and contributes nothing. */
  async #listFor(
    entry: Entry,
    project: string | null | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ entry: Entry; tools: McpRawTool[] }> {
    const id = entry.connector.id;
    try {
      // Listed as locked with the reason, never started without its secrets.
      this.#assertUnlocked(entry);
      const connection = await this.#connection(id, project ?? null);
      const tools = await connection.listTools({ ...(signal ? { signal } : {}), timeoutMs: CONNECT_TIMEOUT_MS });
      this.#arm(id, this.#key(entry, project));
      this.#errors.delete(id);
      return { entry, tools };
    } catch (error) {
      // A save that replaced this connector while it was connecting has already put a fresh
      // entry in its place. The attempt that was dropped does not get to mark that one failed.
      if (!this.#stillCurrent(entry)) return { entry, tools: [] };
      this.#errors.set(id, errorMessage(error));
      this.#fire(id);
      return { entry, tools: [] };
    }
  }

  /**
   * Expose a connector's allowed tools under unique sanitized names, at most its cap, and cache
   * the name map for this project.
   */
  #publish(entry: Entry, tools: McpRawTool[], project: string | null): McpLiveTool[] {
    const id = entry.connector.id;
    const exposed = new Map<string, string>();
    const live: McpLiveTool[] = [];
    const cap = Math.min(entry.maxTools ?? MAX_TOOLS_PER_CONNECTOR, MAX_TOOLS_PER_CONNECTOR);
    for (const tool of tools) {
      if (!this.#allowed(entry, tool.name)) continue;
      const pending = this.#pending.get(id)?.connector;
      if (pending && pendingRefuses(pending, project, this.#allowed({ connector: pending }, tool.name))) continue;
      if (exposed.size >= cap) break;
      const name = uniqueToolName(exposedToolName(tool.name), exposed);
      exposed.set(name, tool.name);
      live.push({
        name: `${id}__${name}`,
        description: (tool.description || `${entry.connector.name}: ${tool.name}`).slice(0, MAX_DESCRIPTION),
        parameters: flatParameters(tool.inputSchema),
        inputSchema: tool.inputSchema,
      });
    }
    const scoped = this.#exposed.get(id) ?? new Map();
    scoped.set(project, exposed);
    this.#exposed.set(id, scoped);
    return live;
  }

  /** Is this the name of a connector tool? Checked before the director/builder and plugin branches. */
  owns(name: string): boolean {
    if (typeof name !== "string" || !MCP_QUALIFIED_TOOL.test(name)) return false;
    return this.#entries.has(name.slice(0, name.indexOf("__")));
  }

  /**
   * The server's own name for a proxied tool, once that connector has been listed. For the
   * record a call writes, never for the call itself — `tool()` resolves the name it was given.
   */
  rawName(name: string): string | undefined {
    if (typeof name !== "string" || !MCP_QUALIFIED_TOOL.test(name)) return undefined;
    const id = name.slice(0, name.indexOf("__"));
    for (const scoped of this.#exposed.get(id)?.values() ?? []) {
      const raw = scoped.get(name.slice(id.length + 2));
      if (raw) return raw;
    }
    return undefined;
  }

  /** The display name of the connector a proxied tool belongs to, for words a person reads. */
  nameOf(id: string): string | undefined {
    return this.#entries.get(id)?.connector.name;
  }

  /** Only a user-saved exact-name grant can bypass consent; server annotations never grant authority. */
  async toolAutoApproved(name: string, project: string | null, signal?: AbortSignal): Promise<boolean> {
    if (!MCP_QUALIFIED_TOOL.test(name)) throw new Error(MESSAGE.UnknownTool);
    const id = name.slice(0, name.indexOf("__"));
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(MESSAGE.UnknownTool);
    this.#assertCurrent(id, entry);
    if (!mcpScopeCovers(entry.connector.scope, project))
      throw new Error(MESSAGE.NotEnabledForProject(entry.connector.name));
    const raw = await this.#rawToolName(id, name.slice(id.length + 2), project, signal);
    if (!this.#allowed(entry, raw)) throw new Error(MESSAGE.ToolNotAllowed(raw, entry.connector.name));
    const pending = this.#pending.get(id)?.connector;
    const currentGrant = entry.connector.toolPolicy.autoApprove?.includes(raw) === true;
    const pendingGrant = !pending || pending.toolPolicy.autoApprove?.includes(raw) === true;
    return currentGrant && pendingGrant;
  }

  /**
   * Run one connector tool. Fails closed on anything it cannot positively allow, and resolves
   * the exposed name back to the server's own — the sanitizing is Studio's, not the server's.
   */
  async tool(
    name: string,
    args: Record<string, unknown>,
    binding?: { project?: string | null },
    signal?: AbortSignal,
  ): Promise<LiveToolResult> {
    if (!MCP_QUALIFIED_TOOL.test(name)) throw new Error(MESSAGE.UnknownTool);
    const id = name.slice(0, name.indexOf("__"));
    const exposedName = name.slice(id.length + 2);
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(MESSAGE.UnknownTool);
    this.#assertCurrent(id, entry);
    if (!mcpScopeCovers(entry.connector.scope, binding?.project ?? null))
      throw new Error(MESSAGE.NotEnabledForProject(entry.connector.name));
    if (!launchTrusted(entry.connector)) throw new Error(MESSAGE.Untrusted(entry.connector.name));
    this.#assertUnlocked(entry);
    // A call in flight keeps its connection from being closed as idle.
    const project = binding?.project ?? null;
    const key = this.#key(entry, project);
    this.#hold(id, key);
    try {
      const raw = await this.#rawToolName(id, exposedName, project, signal);
      if (!this.#allowed(entry, raw)) throw new Error(MESSAGE.ToolNotAllowed(raw, entry.connector.name));
      const connection = await this.#connection(id, project);
      this.#assertCurrent(id, entry);
      const pending = this.#pending.get(id)?.connector;
      const pendingAllows = pending ? launchTrusted(pending) && this.#allowed({ connector: pending }, raw) : true;
      if (pendingRefuses(pending, project, pendingAllows))
        throw new Error(MESSAGE.ToolNoLongerAllowed(raw, entry.connector.name));
      return await connection.callTool(raw, args ?? {}, {
        ...(signal ? { signal } : {}),
        timeoutMs: entry.callTimeoutMs ?? CALL_TIMEOUT_MS,
      });
    } finally {
      this.#letGo(id, key);
    }
  }

  /** The server's own name for an exposed tool, listing the connector's tools once when it is not cached. */
  async #rawToolName(id: string, exposedName: string, project: string | null, signal?: AbortSignal): Promise<string> {
    const cached = () => this.#exposed.get(id)?.get(project)?.get(exposedName);
    if (!cached()) await this.toolsFor(project, signal ? { signal } : {});
    const raw = cached();
    if (!raw) throw new Error(MESSAGE.UnknownTool);
    return raw;
  }

  /** Connect once, list, and put it back the way it was. Used by the card's Test button. */
  async test(id: string): Promise<McpTestResult> {
    const started = Date.now();
    const entry = this.#entries.get(id);
    if (!entry) return { ok: false, tools: [], error: MESSAGE.UnknownConnector, durationMs: 0 };
    if (entry.connector.transport === McpTransport.Stdio && !launchTrusted(entry.connector)) {
      return {
        ok: false,
        tools: [],
        error: MESSAGE.TestUntrusted,
        durationMs: Date.now() - started,
      };
    }
    try {
      this.#assertUnlocked(entry);
    } catch (error) {
      return { ok: false, tools: [], error: errorMessage(error), durationMs: Date.now() - started };
    }
    let extra: McpLaunchContext | undefined;
    try {
      extra = entry.launch?.resolve ? await entry.launch.resolve(null) : undefined;
    } catch (error) {
      return { ok: false, tools: [], error: errorMessage(error), durationMs: Date.now() - started };
    }
    const probe = new McpConnection({
      ...launchOptions(entry, extra),
      secrets: this.#sessionSecrets,
      ...(this.#fetch ? { fetchImpl: this.#fetch } : {}),
    });
    try {
      const tools = await probe.listTools({ timeoutMs: CONNECT_TIMEOUT_MS });
      this.#errors.delete(id);
      this.#fire(id);
      return { ok: true, tools: tools.map((tool) => this.#summary(entry, tool)), durationMs: Date.now() - started };
    } catch (error) {
      const message = errorMessage(error);
      this.#errors.set(id, message);
      this.#fire(id);
      return { ok: false, tools: [], error: message, durationMs: Date.now() - started };
    } finally {
      await probe.close().catch(() => {});
    }
  }

  /**
   * The user's own Connect: load the connector's secrets (restarting a process that ran without
   * them), then, for an OAuth connector, run the browser sign-in.
   */
  async #unlockForConnect(
    id: string,
    entry: Entry,
    project: string | null,
    openBrowser: (url: string) => Promise<void>,
  ): Promise<void> {
    // A process started before this unlock ran without the values it just loaded: the next one gets them.
    resetToolchain();
    if (await this.#sessionSecrets?.unlock(entry.connector)) await this.#drop(id);
    this.#assertUnlocked(entry);
    if (entry.connector.authentication !== "oauth") return;
    this.#oauthProject.set(id, project ?? null);
    const account = this.#account(entry, project);
    if (!account) throw new Error(MESSAGE.NoBrowserSignIn);
    await account.begin(openBrowser);
    await this.#drop(id);
  }

  /** Cache the exposed names of a connected connector's allowed tools for this project. */
  #cacheNames(id: string, entry: Entry, project: string | null, tools: McpRawTool[]): void {
    const scoped = this.#exposed.get(id) ?? new Map();
    const names = new Map<string, string>();
    for (const tool of tools
      .filter((t) => this.#allowed(entry, t.name))
      .slice(0, entry.maxTools ?? MAX_TOOLS_PER_CONNECTOR))
      names.set(uniqueToolName(exposedToolName(tool.name), names), tool.name);
    scoped.set(project, names);
    this.#exposed.set(id, scoped);
  }

  /** Explicit UI connection retained for the next turn; never starts unrelated connectors. */
  async connect(
    id: string,
    project: string | null = null,
    openBrowser?: (url: string) => Promise<void>,
  ): Promise<McpTestResult> {
    const started = Date.now();
    const entry = this.#entries.get(id);
    try {
      if (!entry) throw new Error(MESSAGE.UnknownConnector);
      this.#assertCurrent(id, entry);
      if (!mcpScopeCovers(entry.connector.scope, project)) throw new Error(MESSAGE.NotEnabledForSelectedProject);
      if (openBrowser) await this.#unlockForConnect(id, entry, project, openBrowser);
      else this.#assertUnlocked(entry);
      const tools = await (await this.#connection(id, project)).listTools();
      this.#assertCurrent(id, entry);
      this.#arm(id, this.#key(entry, project));
      this.#cacheNames(id, entry, project, tools);
      this.#errors.delete(id);
      this.#fire(id);
      this.#oauth.get(id)?.ready();
      return { ok: true, tools: tools.map((t) => this.#summary(entry, t)), durationMs: Date.now() - started };
    } catch (error) {
      const message = errorMessage(error);
      this.#oauth.get(id)?.ready();
      if (entry && this.#entries.get(id) === entry && entry.connector.enabled) {
        this.#errors.set(id, message);
        this.#fire(id);
      }
      return { ok: false, tools: [], error: message, durationMs: Date.now() - started };
    }
  }

  async cancelAuthorization(id: string): Promise<void> {
    this.#oauth.get(id)?.cancel();
    await this.#drop(id);
    this.#fire(id);
  }
  async disconnectAccount(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (entry) await this.#account(entry)?.disconnect();
    await this.#drop(id);
    this.#fire(id);
  }

  #summary(entry: Entry, tool: McpRawTool): McpToolSummary {
    return {
      name: tool.name,
      exposedName: exposedToolName(tool.name),
      description: tool.description,
      inputSchema: tool.inputSchema,
      allowed: this.#allowed(entry, tool.name),
    };
  }

  /** Cached, project-scoped tool names only; planning must not start a connector. */
  planningToolNames(id: string, project: string | null): string[] {
    return [...(this.#exposed.get(id)?.get(project)?.keys() ?? [])];
  }

  /**
   * The per-connector tool list the card's allow/deny checklist is built from. The card asks for
   * it the moment Edit is pressed, so this is a launch path like any other: a stdio connector
   * whose recorded command is not the one the user approved is refused, not started to answer it.
   */
  async tools(id: string): Promise<McpToolSummary[]> {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(MESSAGE.UnknownConnector);
    if (!entry.connector.enabled) return [];
    this.#assertTrusted(entry);
    this.#assertUnlocked(entry);
    const tools = await (await this.#connection(id)).listTools({ timeoutMs: CONNECT_TIMEOUT_MS });
    this.#arm(id, this.#key(entry, null));
    return tools.map((tool) => this.#summary(entry, tool));
  }

  /**
   * One short paragraph naming what is connected. Deliberately not per-engine: connector tools
   * are never spelled out in a prompt builder (the engine-voice gate), only counted here.
   */
  guidance(tools?: McpLiveTool[]): string {
    const counts = new Map<string, number>();
    for (const tool of tools ?? []) {
      const id = tool.name.slice(0, tool.name.indexOf("__"));
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const lines: string[] = [];
    for (const [id, count] of counts) {
      const entry = this.#entries.get(id);
      if (!entry) continue;
      lines.push(
        `- ${entry.connector.name}: ${count} tool${count === 1 ? "" : "s"}, named ${id}__*${entry.description ? ` — ${entry.description}` : ""}`,
      );
    }
    if (!lines.length) return "";
    return [
      "[CONNECTORS]",
      "Tools from connected services the user set up. They run outside this workspace and may cost money or change data elsewhere — read what one does before calling it.",
      ...lines,
    ].join("\n");
  }

  /**
   * Every credential value the registry holds right now: values unlocked this session, OAuth
   * tokens, and what plugin launches handed their servers. For Studio's own redactor (the event
   * log, the dev control, a public export); never sent anywhere.
   */
  secretValues(): string[] {
    const values = new Set<string>(this.#sessionSecrets?.heldValues() ?? []);
    for (const account of this.#oauth.values()) for (const value of account.secretValues()) values.add(value);
    for (const scoped of this.#connections.values())
      for (const connection of scoped.values()) for (const value of connection.secretValues()) values.add(value);
    return [...values];
  }

  /**
   * Every connection closes at once, and each is waited for at most `closeTimeoutMs`: on quit a
   * few slow stdio servers one after another would otherwise use up the time the core has to stop
   * the harness.
   */
  async close(): Promise<void> {
    for (const account of this.#oauth.values()) account.lock();
    const within = (work: Promise<void>) =>
      new Promise<void>((resolve) => {
        const cancel = this.#schedule(resolve, this.#closeMs);
        void work.finally(() => {
          cancel();
          resolve();
        });
      });
    await Promise.all([...this.#connections.keys()].map((id) => within(this.#drop(id))));
    for (const timers of this.#idleTimers.values()) for (const cancel of timers.values()) cancel();
    this.#idleTimers.clear();
  }
}

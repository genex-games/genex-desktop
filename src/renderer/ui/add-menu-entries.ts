/**
 * What the composer's Add menu lists: each plugin and each MCP server of its own, whether it is
 * on, and — only when something needs doing — a status with the action that fixes it. Pure, so
 * the menu only draws it; the actions come in as callbacks.
 */
import type { ConnectionSnapshot } from "../../shared/connections.ts";
import { McpHealth, mcpScopeCovers, type McpConnectorView } from "../../shared/mcp.ts";
import { PluginHealth, type PluginInfo } from "../../shared/plugins.ts";
import { PLUGINS_WORDS } from "../words.ts";

export interface EntryStatus {
  text: string;
  action?: { label: string; run: () => void };
}

/** Where a row's switch applies. Plugins are on or off for every game at once. */
export const EntryScope = {
  AllGames: "all-games",
} as const;
export type EntryScope = (typeof EntryScope)[keyof typeof EntryScope];

export interface AddMenuEntry {
  id: string;
  kind: "plugin" | "mcp";
  name: string;
  on: boolean;
  locked?: boolean;
  /** Where the switch applies, when the row says so. */
  scope?: EntryScope;
  status: EntryStatus | null;
  toggle: (on: boolean) => void;
  /** The plugin's or server's own picture, when it has one. */
  icon?: string;
  /** A plugin row's plugin id (the row's own id is namespaced by its kind). */
  pluginId?: string;
}

/** What the menu's rows can do, bound by the menu to its studio calls. */
export interface EntryActions {
  /** Open a plugin's page in Plugins (or Plugins itself). */
  manage(plugin?: string): void;
  /** Connect an MCP server the user added. */
  connect(view: McpConnectorView): void;
  /** Run a plugin's account connect action. */
  connectAccount(plugin: PluginInfo): void;
  enablePlugin(plugin: PluginInfo, on: boolean): void;
  enableServer(view: McpConnectorView, on: boolean): void;
}

type Account = NonNullable<ConnectionSnapshot["sources"][number]["account"]>;
/** Account states whose fix is the plugin's own connect action. */
const CONNECTABLE: ReadonlySet<string> = new Set<Account>(["locked", "not connected", "failed"]);
const UNLOCKED: Account = "unlocked";
const AUTHORIZING: Account = "authorizing";
const FAILED: Account = "failed";
const ACCOUNT_WORDS = PLUGINS_WORDS.account;

/** Short name of a plugin's own server: "Genex plugin · Blender" → "Blender". */
export const serverName = (view: McpConnectorView): string =>
  view.connector.name.split(" · ").pop() ?? view.connector.name;

/** The plugin that declared this server, if a plugin did. */
export const pluginOf = (view: McpConnectorView): string | undefined =>
  typeof view.connector.source === "object" ? view.connector.source.plugin : undefined;

/** A server that cannot connect until someone configures, trusts or gives it its secrets. */
function needsSetup(view: McpConnectorView, pluginOwned: boolean, enabled: boolean): boolean {
  const offUnderItsPlugin = pluginOwned && enabled && !view.connector.enabled;
  if (offUnderItsPlugin) return true;
  if (!view.trusted) return true;
  const secrets = [
    ...(view.connector.env ?? []).map((n) => `env.${n}`),
    ...(view.connector.headers ?? []).map((n) => `header.${n}`),
  ];
  return secrets.some((n) => !view.secrets.includes(n));
}

/** A server's trouble, lower-case, to follow its name or open a sentence. */
function connectorTrouble(view: McpConnectorView, setup: boolean): string {
  if (setup) return "needs setup";
  if (view.health === McpHealth.Connecting) return "connecting…";
  return view.health === McpHealth.Failed ? "failed to connect" : "not connected";
}

/** The button that fixes a server's trouble. */
function connectorActionLabel(view: McpConnectorView, setup: boolean): string {
  if (setup) return "Set up";
  return view.health === McpHealth.Failed ? "Retry" : "Connect";
}

/** A server's status, or null when it is off, ready, or a plugin's server waiting to connect on use. */
function connectorStatus(
  view: McpConnectorView,
  pluginId: string | undefined,
  enabled: boolean,
  prefix: string,
  actions: EntryActions,
): EntryStatus | null {
  if (!enabled || view.health === McpHealth.Ready) return null;
  const setup = needsSetup(view, Boolean(pluginId), enabled);
  const connectsOnUse = Boolean(pluginId) && !setup && view.health === McpHealth.Idle && !view.error;
  if (connectsOnUse) return null; // Host connects lazily on use.
  const text = connectorTrouble(view, setup);
  const sentence = prefix ? `${prefix} ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
  if (view.health === McpHealth.Connecting) return { text: sentence };
  // A plugin's own server is configured on the plugin's page.
  const run = setup || pluginId ? () => actions.manage(pluginId) : () => actions.connect(view);
  return { text: sentence, action: { label: connectorActionLabel(view, setup), run } };
}

/**
 * A plugin account's status: one Connect (or, after a failure, Reconnect) button and no words, the
 * browser step while it runs, or nothing once connected or while it is still being read.
 */
function accountStatus(plugin: PluginInfo, state: Account | undefined, actions: EntryActions): EntryStatus | null {
  if (!plugin.manifest.account || state === UNLOCKED || state === undefined) return null;
  if (CONNECTABLE.has(state)) {
    const label = state === FAILED ? ACCOUNT_WORDS.reconnect : ACCOUNT_WORDS.connect;
    return { text: "", action: { label, run: () => actions.connectAccount(plugin) } };
  }
  return state === AUTHORIZING ? { text: ACCOUNT_WORDS.finishing } : null;
}

/** A plugin row's status: its account first, then its own start, then its servers'. */
function pluginStatus(
  plugin: PluginInfo,
  owned: McpConnectorView[],
  state: Account | undefined,
  actions: EntryActions,
): EntryStatus | null {
  if (!plugin.enabled) return null;
  const account = accountStatus(plugin, state, actions);
  if (account) return account;
  if (plugin.health === PluginHealth.Failed)
    return { text: "Failed to start", action: { label: "Manage", run: () => actions.manage(plugin.manifest.id) } };
  const servers = owned.map((view) => connectorStatus(view, plugin.manifest.id, true, serverName(view), actions));
  return servers.find(Boolean) ?? null;
}

/** The servers this game can use; optional endpoints stay in Plugins until configured. */
export function visibleConnectors(
  connectors: McpConnectorView[],
  plugins: PluginInfo[],
  project: string | null | undefined,
): McpConnectorView[] {
  return connectors.filter((view) => {
    if (!mcpScopeCovers(view.connector.scope, project)) return false;
    const source = view.connector.source;
    const declared =
      typeof source === "object"
        ? plugins
            .find((p) => p.manifest.id === source.plugin)
            ?.manifest.mcpServers?.find((server) => server.id === source.server)
        : undefined;
    // Optional endpoints stay in Plugins until configured, rather than blocking account setup.
    return view.connector.enabled || !declared?.requires?.settings?.length;
  });
}

/** Every row of the menu: the plugins, then the servers no listed plugin owns. */
export function addMenuEntries(
  plugins: PluginInfo[],
  visible: McpConnectorView[],
  connections: ConnectionSnapshot | null,
  actions: EntryActions,
): AddMenuEntry[] {
  const pluginRows = plugins.map((plugin): AddMenuEntry => {
    const owned = visible.filter((view) => pluginOf(view) === plugin.manifest.id);
    const state = connections?.sources.find(
      (source) => source.kind === "plugin" && source.id === plugin.manifest.id,
    )?.account;
    return {
      id: `plugin:${plugin.manifest.id}`,
      kind: "plugin",
      name: plugin.manifest.name,
      on: plugin.enabled,
      scope: EntryScope.AllGames,
      status: pluginStatus(plugin, owned, state, actions),
      toggle: (on) => actions.enablePlugin(plugin, on),
      pluginId: plugin.manifest.id,
      ...(plugin.iconUrl ? { icon: plugin.iconUrl } : {}),
    };
  });
  const unowned = visible.filter((view) => {
    const id = pluginOf(view);
    return !id || !plugins.some((p) => p.manifest.id === id);
  });
  const serverRows = unowned.map((view): AddMenuEntry => {
    const pluginId = pluginOf(view);
    const c = view.connector;
    return {
      id: `mcp:${c.id}`,
      kind: "mcp",
      name: c.name,
      on: c.enabled,
      locked: Boolean(pluginId),
      status: connectorStatus(view, pluginId, c.enabled, "", actions),
      toggle: (on) => actions.enableServer(view, on),
      ...(view.icon ? { icon: view.icon } : {}),
    };
  });
  return [...pluginRows, ...serverRows];
}

/** One option of the @ list. */
export interface MentionOption {
  id: string;
  name: string;
  pick: () => void;
  /** A plugin's own picture, for its card. */
  icon?: string;
}

/** The option that adds images; it answers to "images" and to "reference mood board". */
export const IMAGES_OPTION = "images";

/** The @ list for what was typed after the @: Images when it matches, then the plugins that are on. */
export function mentionOptions(
  mention: string | null,
  entries: AddMenuEntry[],
  pickImages: () => void,
  mentionEntry: (entry: AddMenuEntry) => void,
): MentionOption[] {
  const query = (mention ?? "").toLowerCase();
  const images = IMAGES_OPTION.includes(query) || "reference mood board".includes(query);
  return [
    ...(images ? [{ id: IMAGES_OPTION, name: "Images", pick: pickImages }] : []),
    ...entries
      .filter((e) => e.on && e.name.toLowerCase().includes(query))
      .map((e) => ({ id: e.id, name: e.name, pick: () => mentionEntry(e), ...(e.icon ? { icon: e.icon } : {}) })),
  ];
}

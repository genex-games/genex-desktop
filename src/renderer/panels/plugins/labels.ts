/** The plugins page's words and small rules: its tabs, a plugin's source and state, its account, and version floors. */
import type { ConnectionSnapshot } from "../../../shared/connections.ts";
import { SECOND_MS } from "../../../shared/duration.ts";
import { GENEX_PLUGIN_ID } from "../../../shared/genex.ts";
import { GENEX_WORDS, PLUGINS_WORDS } from "../../words.ts";
import {
  type PluginIndexView,
  type PluginInfo,
  type PluginManifest,
  PluginAccountState,
  PluginCapability,
  PluginSourceKind,
} from "../../../shared/plugins.ts";

/** The plugin guide Create a plugin and Read the guide open; `plugin:new` names the same page. */
export { PLUGIN_GUIDE_URL } from "../../../shared/plugins.ts";

/** Fallback refresh for external account changes; host changes refresh immediately. */
export const PLUGINS_POLL_MS = 30 * SECOND_MS;

/** The page's two tabs. */
export const ExtensionsTab = {
  Plugins: "plugins",
  Skills: "skills",
} as const;
export type ExtensionsTab = (typeof ExtensionsTab)[keyof typeof ExtensionsTab];

/** The tabs in the order the page shows them. */
export const EXTENSIONS_TABS: readonly ExtensionsTab[] = [ExtensionsTab.Plugins, ExtensionsTab.Skills];

/** Each tab's name, as its button and the page title say it. */
export const TAB_LABEL: Record<ExtensionsTab, string> = { plugins: "Plugins", skills: "Skills" };

/** Each tab's search field label and placeholder. */
export const SEARCH_LABEL: Record<ExtensionsTab, string> = {
  plugins: "Search plugins and MCP servers",
  skills: "Search skills",
};

/** The refresh button's label on each tab. */
export const REFRESH_LABEL: Record<ExtensionsTab, string> = {
  plugins: "Refresh marketplace index",
  skills: "Refresh skills",
};

/** What each tab is for, under its title. */
export const TAB_INTRO: Record<ExtensionsTab, string> = {
  plugins: "Tools and connections for all your games.",
  skills: "Guidance available to your agents. Availability depends on the source and selected provider.",
};

const SOURCE_LABEL: Record<PluginSourceKind, string> = {
  [PluginSourceKind.Bundled]: "Bundled",
  [PluginSourceKind.Catalog]: "Curated release",
  [PluginSourceKind.Local]: "Local folder",
  [PluginSourceKind.Github]: "GitHub",
  [PluginSourceKind.Index]: "Marketplace",
};

/** Where an installed plugin came from, in words. */
export const sourceWords = (p: PluginInfo): string => SOURCE_LABEL[p.source] ?? "Marketplace";

const CAN = PLUGINS_WORDS.can;
/** The place in the capability sentence for game files, which two capabilities share. */
const FILES = "files";

/**
 * What a plugin can do, in one plain sentence from its capabilities: "Use your Genex account, see
 * the running game, reach the internet…". Reading and writing game files read as one phrase.
 */
export function capabilityLine(
  manifest: Pick<PluginManifest, "capabilities" | "publisher" | "nativeRuntimes">,
): string {
  const has = new Set(manifest.capabilities);
  const runtimes = (manifest.nativeRuntimes ?? []).map((r) => r.label).join(" and ");
  const phrase: Array<[string, string]> = [
    [PluginCapability.Credentials, CAN.credentials(manifest.publisher)],
    [PluginCapability.NativeRuntime, CAN["native-runtime"](runtimes || "programs on this Mac")],
    [PluginCapability.Observe, CAN.observe],
    [PluginCapability.Network, CAN.network],
    [PluginCapability.ExternalAuth, CAN["external-auth"]],
    [PluginCapability.Jobs, CAN.jobs],
    [FILES, filesPhrase(has)],
    [PluginCapability.Settings, CAN.settings],
    [PluginCapability.Export, CAN.export],
  ];
  const parts = phrase.filter(([capability, words]) => words && (capability === FILES || has.has(capability)));
  const line = parts.map(([, words]) => words).join(", ");
  return line ? `${line.charAt(0).toLocaleUpperCase()}${line.slice(1)}` : PLUGINS_WORDS.page.nothing;
}

/** Reading and writing game files, as one phrase: "read and write files in your games". */
function filesPhrase(has: ReadonlySet<string>): string {
  const reads = has.has(PluginCapability.ProjectRead);
  const writes = has.has(PluginCapability.ProjectWrite);
  if (reads && writes) return CAN.readWrite;
  if (reads) return CAN["project.read"];
  return writes ? CAN["project.write"] : "";
}

/** Where a plugin's own picture loads from, or undefined when it has none (the page shows its initial). */
export const pluginIconUrl = (p: PluginInfo): string | undefined => p.iconUrl;

/** Whether a dotted version is at least the minimum; missing or unreadable parts count as zero. */
export function meetsMinimumVersion(version: string, minimum: string): boolean {
  const a = version.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const b = minimum.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Where a plugin's account stands, from the host's connection snapshot. */
export type AccountState = ConnectionSnapshot["sources"][number]["account"];

/** A plugin's account state, or undefined while the snapshot has not arrived or names none. */
export const pluginAccount = (connections: ConnectionSnapshot | null, id: string): AccountState =>
  connections?.sources.find((s) => s.kind === "plugin" && s.id === id)?.account;

/** What a plugin row offers for its account, by where the account stands. */
export const RowAccountStep = {
  /** Locked (a saved sign-in not opened yet this session) or never connected: one Connect button. */
  Connect: "connect",
  /** The last sign-in failed; why is on the plugin's page. */
  Reconnect: "reconnect",
  /** Waiting on the browser. */
  Finishing: "finishing",
  /** Connected: the row shows the balance, when the plugin has one, and no button. */
  Connected: "connected",
  /** Not known yet: nothing, rather than a guess. */
  Checking: "checking",
} as const;
export type RowAccountStep = (typeof RowAccountStep)[keyof typeof RowAccountStep];

/** The step a row's account is at. A locked account reads as Connect: to a person both are "not connected yet". */
export function rowAccountStep(state: AccountState): RowAccountStep {
  switch (state) {
    case PluginAccountState.Locked:
    case PluginAccountState.NotConnected:
      return RowAccountStep.Connect;
    case PluginAccountState.Failed:
      return RowAccountStep.Reconnect;
    case PluginAccountState.Authorizing:
      return RowAccountStep.Finishing;
    case PluginAccountState.Unlocked:
      return RowAccountStep.Connected;
    default:
      return RowAccountStep.Checking;
  }
}

/** Whether pressing the account button should connect: the account is locked, never connected, or failed. */
export const accountNeedsConnect = (state: AccountState): boolean =>
  state === "locked" || state === "not connected" || state === "failed";

/** Whether a plugin is installed, enabled and in use: its panels and account apply. */
export const isActive = (p: PluginInfo): boolean => p.enabled && !p.removed;

/** Whether a plugin is off the installed list: removed, or found but never allowed. */
export const isOffList = (p: PluginInfo): boolean => Boolean(p.removed || p.unlisted);

/** Whether a plugin is Genex, which the Plugins page shows as the game dev tools router. */
const isRouter = (p: PluginInfo): boolean => p.manifest.id === GENEX_PLUGIN_ID;

/** The name a plugin's row and page show: Genex is the game dev tools router; any other its own name. */
export const shownName = (p: PluginInfo): string => (isRouter(p) ? GENEX_WORDS.router.name : p.manifest.name);

/** The line under a plugin's name in its row: Genex names the tools it routes; any other its own description. */
export const shownDescription = (p: PluginInfo): string =>
  isRouter(p) ? GENEX_WORDS.router.description : p.manifest.description;

/** The line under a plugin's page title: Genex says what the router does; any other its own description. */
export const shownIntro = (p: PluginInfo): string => (isRouter(p) ? GENEX_WORDS.router.intro : p.manifest.description);

/** What the Marketplace shows: what the catalog offers you, or that more is coming. */
export const MoreView = { List: "list", Soon: "soon" } as const;
export type MoreView = (typeof MoreView)[keyof typeof MoreView];

/**
 * The Marketplace lists the catalog's entries and releases you don't have; until there are any
 * (or while the catalog loads or can't be read) it is only Coming soon.
 */
export function moreView({
  index,
  entries,
  releases,
}: {
  index: PluginIndexView | null;
  entries: number;
  releases: number;
}): MoreView {
  return index && entries + releases > 0 ? MoreView.List : MoreView.Soon;
}

/** Whether Studio draws the plugin's page itself (Genex), account problems included. */
export const hasOwnPage = (p: PluginInfo): boolean => p.manifest.id === GENEX_PLUGIN_ID && !isOffList(p);

type Panel = PluginManifest["panels"][number];

/**
 * The panel an account button opens: the plugin's settings panel, else its project panel when a
 * game is open. Genex's page shows its account itself, so its button opens no frame.
 */
export function accountPanel(manifest: PluginManifest, project: string | null | undefined): Panel | undefined {
  if (manifest.id === GENEX_PLUGIN_ID) return undefined;
  return (
    manifest.panels.find((panel) => panel.placement === "settings") ??
    (project ? manifest.panels.find((panel) => panel.placement === "project") : undefined)
  );
}

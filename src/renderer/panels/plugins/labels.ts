/** The plugins page's words and small rules: its tabs, a plugin's source and state, its account, and version floors. */
import type { ConnectionSnapshot } from "../../../shared/connections.ts";
import { SECOND_MS } from "../../../shared/duration.ts";
import { GENEX_PLUGIN_ID } from "../../../shared/genex.ts";
import { GENEX_WORDS, PLUGINS_WORDS } from "../../words.ts";
import {
  type PluginIndexEntry,
  type PluginIndexView,
  type PluginInfo,
  type PluginManifest,
  PluginAccountState,
  PluginCapability,
  PluginSourceKind,
  PluginTier,
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

/** Between two folders in a line. */
const FOLDER_SEPARATOR = "; ";

/** The folders outside your games a plugin's programs write to, each with why; empty when it names none. */
export function foldersLine(manifest: Pick<PluginManifest, "folders">): string {
  return (manifest.folders ?? []).map((f) => PLUGINS_WORDS.page.folder(f.path, f.why)).join(FOLDER_SEPARATOR);
}

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

/**
 * Genex's row line, in two parts (the second quieter): on, the tools it gives the agent on the
 * person's account; off, that the agent lost them and the account kept everything else.
 */
export const routerLine = (p: PluginInfo): { lead: string; tail: string } =>
  isActive(p) ? GENEX_WORDS.router.rowOn : GENEX_WORDS.router.rowOff;

/** The line under a plugin's name in its row: Genex says what its switch does; any other its own description. */
export function shownDescription(p: PluginInfo): string {
  if (!isRouter(p)) return p.manifest.description;
  const { lead, tail } = routerLine(p);
  return `${lead} ${tail}`;
}

/**
 * The line under a plugin's page title: Genex is the game dev tools router, connected as the account
 * when there is one; any other its own description.
 */
export function shownIntro(p: PluginInfo, accountName: string | null = null): string {
  if (!isRouter(p)) return p.manifest.description;
  return accountName ? GENEX_WORDS.router.connectedAs(accountName) : GENEX_WORDS.router.description;
}

/**
 * The catalog's two shelves on the Plugins tab: Plugins, the ones Genex makes (official), and
 * Community plugins, everyone else's.
 */
export function catalogShelves(entries: readonly PluginIndexEntry[]): {
  ours: PluginIndexEntry[];
  community: PluginIndexEntry[];
} {
  return {
    ours: entries.filter((e) => e.tier === PluginTier.Official),
    community: entries.filter((e) => e.tier === PluginTier.Community),
  };
}

/**
 * The ids the catalog lists as community plugins. Installed ones stay in Community plugins, with
 * their switch, rather than under Installed; with no catalog every installed plugin is Installed.
 */
export function communityIds(index: Pick<PluginIndexView, "entries"> | null): Set<string> {
  return new Set((index?.entries ?? []).filter((e) => e.tier === PluginTier.Community).map((e) => e.id));
}

/**
 * The steps a catalog plugin's page shows before it is installed: Genex's own install step, its
 * author's plain steps (or, when it needs an account and says nothing, connecting it), and when it
 * is ready. The author's steps are text Genex draws; Genex's steps come first and last.
 */
export function listingSteps(entry: Pick<PluginIndexEntry, "name" | "setup" | "capabilities">): string[] {
  const WORDS = PLUGINS_WORDS.listing;
  const needsAccount = entry.capabilities.includes(PluginCapability.Credentials);
  const own = entry.setup ?? (needsAccount ? [WORDS.connectStep(entry.name)] : []);
  return [WORDS.installStep, ...own, WORDS.readyStep];
}

/** One step of an installed plugin's "How to start", and whether it is done. */
export interface SetupStep {
  text: string;
  done: boolean;
}

/**
 * An installed plugin's "How to start": Install, done, then its author's steps (or connecting its
 * account when it has one and its author wrote none), then when it is ready. Empty when there is
 * nothing to set up.
 */
export function installedSteps(manifest: Pick<PluginManifest, "setup" | "account">): SetupStep[] {
  const WORDS = PLUGINS_WORDS.listing;
  const own = manifest.setup ?? (manifest.account ? [WORDS.connectAccount] : []);
  if (own.length === 0) return [];
  return [
    { text: WORDS.installedStep, done: true },
    ...own.map((text) => ({ text, done: false })),
    { text: WORDS.readyStep, done: false },
  ];
}

/**
 * Whether an installed plugin still waits on its person: it is on, has an account, and that
 * account is not connected (never, locked or failed). A plugin with no account, one that is off,
 * or one whose browser step is under way does not.
 */
export function needsSetup(plugin: Pick<PluginInfo, "enabled" | "manifest">, state: AccountState): boolean {
  if (!plugin.enabled || !plugin.manifest.account) return false;
  const step = rowAccountStep(state);
  return step === RowAccountStep.Connect || step === RowAccountStep.Reconnect;
}

/** A community plugin's publisher on GitHub: the owner of its source repository, and their profile. */
export function publisherProfile(repo: string): { login: string; url: string } {
  const login = repo.split("/")[0] ?? repo;
  return { login, url: `https://github.com/${encodeURIComponent(login)}` };
}

/** What Community plugins shows: the community's plugins you don't have, or that they are coming. */
export const CommunityView = { List: "list", Soon: "soon" } as const;
export type CommunityView = (typeof CommunityView)[keyof typeof CommunityView];

/**
 * Community plugins lists the catalog's community entries you don't have; until there are any (or
 * while the catalog loads or can't be read) it is only Coming soon.
 */
export function communityView({ index, entries }: { index: PluginIndexView | null; entries: number }): CommunityView {
  return index && entries > 0 ? CommunityView.List : CommunityView.Soon;
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

/** The plugin page's line for a plugin loaded from a folder: it runs with your access; null for any other source. */
export const localAccessNote = (p: Pick<PluginInfo, "source">): string | null =>
  p.source === PluginSourceKind.Local ? PLUGINS_WORDS.page.localAccess : null;

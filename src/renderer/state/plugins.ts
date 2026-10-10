/**
 * The installed plugins and the plugin index: one copy, read by the stage toolbar, the sidebar and
 * the Plugins page. The list is refreshed on `plugins.changed` and whenever the page asks; the
 * index then, at the bootstrap, when the page opens and every hour. A failed read keeps the last
 * answer.
 *
 * A plugin's update comes from one of two places (`PluginUpdateSource`): `pluginUpdates` lists
 * them, `installPluginUpdate` installs one, and the store's `updateAll` installs them all.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { HOUR_MS } from "../../shared/duration.ts";
import type { PluginIndexView, PluginInfo } from "../../shared/plugins.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
import { createRefresher } from "./refresher.ts";

/** How often the index is asked for again. Main keeps its own copy for hours, so most asks cost no download. */
export const PLUGIN_INDEX_POLL_MS = HOUR_MS;

/** Where a plugin's newer version comes from, which decides the call that installs it. */
export const PluginUpdateSource = {
  /** A newer copy of a bundled plugin, shipped with this build of the app. */
  Seed: "seed",
  /** A newer release in the plugin index. */
  Index: "index",
} as const;
export type PluginUpdateSource = (typeof PluginUpdateSource)[keyof typeof PluginUpdateSource];

/** A newer version an installed plugin can move to. */
export interface PluginUpdate {
  plugin: PluginInfo;
  version: string;
  source: PluginUpdateSource;
}

export interface PluginsState {
  list: PluginInfo[];
  /** The plugin index as main last answered it, or null before the first answer. */
  index: PluginIndexView | null;
  /** Update plugins is installing every waiting update. */
  updating: boolean;
}

export const initialPlugins = (): PluginsState => ({ list: [], index: null, updating: false });

export function pluginsLoaded(state: PluginsState, list: PluginInfo[]): PluginsState {
  return state.list === list ? state : { ...state, list };
}

export function indexLoaded(state: PluginsState, index: PluginIndexView): PluginsState {
  return { ...state, index };
}

/** Update plugins started, or (false) installed its last update. */
export function updatingChanged(state: PluginsState, updating: boolean): PluginsState {
  return state.updating === updating ? state : { ...state, updating };
}

/** The update one installed plugin can take: its newer seed, else the index's newer release. */
function updateOf(plugin: PluginInfo, releases: ReadonlyMap<string, string>): PluginUpdate | null {
  // An update already installed waits for active sessions; removed or unlisted code is installed, not updated.
  const offered = !plugin.pendingVersion && !plugin.removed && !plugin.unlisted;
  if (!offered) return null;
  if (plugin.availableVersion) return { plugin, version: plugin.availableVersion, source: PluginUpdateSource.Seed };
  const release = releases.get(plugin.manifest.id);
  return release ? { plugin, version: release, source: PluginUpdateSource.Index } : null;
}

/** The updates waiting for the installed plugins, in the installed order. */
export function pluginUpdates(list: PluginInfo[], index: PluginIndexView | null): PluginUpdate[] {
  const releases = new Map((index?.updates ?? []).map((release) => [release.id, release.version]));
  return list.flatMap((plugin) => updateOf(plugin, releases) ?? []);
}

/**
 * Install one update. Main shows the plugin's trust dialog first, and a "no" there resolves like
 * a "yes": the plugin list says which it was.
 */
export function installPluginUpdate(
  api: Pick<StudioApi, "pluginInstall" | "pluginUpdate">,
  update: PluginUpdate,
): Promise<void> {
  const { id } = update.plugin.manifest;
  // A seed has no index entry: it is installed again, through the same review as its first install.
  return update.source === PluginUpdateSource.Seed ? api.pluginInstall(id) : api.pluginUpdate(id);
}

export interface PluginsStore extends StoreApi<PluginsState> {
  refresh(): Promise<void>;
  /** Read the plugin index again: what it offers, and the newer releases of installed plugins. */
  refreshIndex(): Promise<void>;
  /**
   * Install every waiting update, one after another, then read the plugins and the index again.
   * Resolves with the failures; a press while one runs starts nothing.
   */
  updateAll(): Promise<unknown[]>;
}

export function createPluginsStore(
  api: Pick<StudioApi, "pluginsList" | "pluginsIndex" | "pluginInstall" | "pluginUpdate">,
): PluginsStore {
  const store = createStore<PluginsState>()(() => initialPlugins());
  const list = createRefresher(api.pluginsList.bind(api), (value) =>
    store.setState((state) => pluginsLoaded(state, value), true),
  );
  const index = createRefresher(
    () => api.pluginsIndex(),
    (value) => store.setState((state) => indexLoaded(state, value), true),
  );
  const refresh = (): Promise<void> => list.request();
  const refreshIndex = (): Promise<void> => index.request();
  const updateAll = async (): Promise<unknown[]> => {
    const state = store.getState();
    if (state.updating) return [];
    store.setState((current) => updatingChanged(current, true), true);
    const failures: unknown[] = [];
    try {
      for (const update of pluginUpdates(state.list, state.index)) {
        // One refusal (a release withdrawn since the index was read) leaves the others to install.
        await installPluginUpdate(api, update).catch((error: unknown) => failures.push(error));
      }
      await Promise.all([refresh(), refreshIndex()]);
    } finally {
      store.setState((current) => updatingChanged(current, false), true);
    }
    return failures;
  };
  return Object.assign(store, { refresh, refreshIndex, updateAll });
}

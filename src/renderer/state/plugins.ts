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
import { isUserCancelled } from "../../shared/errors.ts";
import type { PluginIndexView, PluginInfo } from "../../shared/plugins.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
import { problemWords } from "../words.ts";
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

/** How the last run of Update plugins ended: the updates that failed, and the ones turned down in a trust dialog. */
export interface UpdatesRunEnd {
  failed: number;
  declined: number;
}

export interface PluginsState {
  list: PluginInfo[];
  /** The plugin index as main last answered it, or null before the first answer. */
  index: PluginIndexView | null;
  /** Update plugins is installing every waiting update. */
  updating: boolean;
  /** How the last run of Update plugins ended; set as `updating` turns false. */
  lastRun: UpdatesRunEnd;
}

export const initialPlugins = (): PluginsState => ({
  list: [],
  index: null,
  updating: false,
  lastRun: { failed: 0, declined: 0 },
});

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

/** Update plugins installed its last update: how many failed and how many the person turned down. */
export const updatesRunEnded = (state: PluginsState, lastRun: UpdatesRunEnd): PluginsState => ({
  ...state,
  updating: false,
  lastRun,
});

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

/** One update by plugin and version: unticking it skips that version only, so a newer one is offered again. */
export const updateKey = (update: PluginUpdate): string => `${update.plugin.manifest.id}@${update.version}`;

/** The updates still ticked: all of them but the ones `skipped` names (`updateKey`). */
export function chosenUpdates(updates: readonly PluginUpdate[], skipped: ReadonlySet<string>): PluginUpdate[] {
  return updates.filter((update) => !skipped.has(updateKey(update)));
}

/**
 * Install one update. For an index release main shows the plugin's trust dialog first, and a "no"
 * there rejects as the person's (`isUserCancelled`). A seed installs without asking.
 */
export function installPluginUpdate(
  api: Pick<StudioApi, "pluginInstall" | "pluginUpdate">,
  update: PluginUpdate,
): Promise<void> {
  const { id } = update.plugin.manifest;
  // A seed has no index entry: it is installed again, through the same path as its first install.
  return update.source === PluginUpdateSource.Seed ? api.pluginInstall(id) : api.pluginUpdate(id);
}

/**
 * The failures of a run, the first of each distinct words, each with its own code: one cause (no
 * connection) refuses every update alike, and is said once.
 */
export function distinctFailures(failures: readonly unknown[]): unknown[] {
  const said = new Set<string>();
  return failures.filter((failure) => {
    const words = problemWords(failure);
    if (said.has(words)) return false;
    said.add(words);
    return true;
  });
}

export interface PluginsStore extends StoreApi<PluginsState> {
  refresh(): Promise<void>;
  /** Read the plugin index again: what it offers, and the newer releases of installed plugins. */
  refreshIndex(): Promise<void>;
  /**
   * Install every waiting update but the `skipped` ones (`updateKey`), one after another, then read
   * the plugins and the index again. Resolves with the failures, never the person's no (counted in
   * `lastRun`); a press while one runs starts nothing.
   */
  updateAll(skipped?: ReadonlySet<string>): Promise<unknown[]>;
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
  const updateAll = async (skipped: ReadonlySet<string> = new Set()): Promise<unknown[]> => {
    const state = store.getState();
    if (state.updating) return [];
    store.setState((current) => updatingChanged(current, true), true);
    const failures: unknown[] = [];
    let declined = 0;
    try {
      for (const update of chosenUpdates(pluginUpdates(state.list, state.index), skipped)) {
        // One refusal (a release withdrawn since the index was read) leaves the others to install.
        await installPluginUpdate(api, update).catch((error: unknown) => {
          if (isUserCancelled(error)) declined += 1;
          else failures.push(error);
        });
      }
      await Promise.all([refresh(), refreshIndex()]);
    } finally {
      const ended = { failed: failures.length, declined };
      store.setState((current) => updatesRunEnded(current, ended), true);
    }
    return failures;
  };
  return Object.assign(store, { refresh, refreshIndex, updateAll });
}

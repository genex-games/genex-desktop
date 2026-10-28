/**
 * A plugin as usage analytics may name it. A plugin a catalog published (bundled with the app, in
 * its curated catalog or in the plugin index) is named by its id, which anyone can read there; one
 * the person brought (a local folder, a GitHub repository) is theirs, and only where it came from
 * is said. The same rule keeps those plugins' names out of replays (`isOwnPlugin`).
 */
import { PluginSourceKind } from "../../shared/plugins.ts";

/** What stands in for a plugin's id when the id is not the catalog's to show. */
export const PluginRefBucket = {
  /** A plugin loaded from a folder on this computer. */
  Local: "local",
  /** A plugin installed from a GitHub repository. */
  Github: "github",
  /** An id that is not shaped like a catalog's. */
  Other: "other",
} as const;
export type PluginRefBucket = (typeof PluginRefBucket)[keyof typeof PluginRefBucket];

/** A catalog id: letters, digits, dots, dashes and underscores, as the catalogs publish them. */
const CATALOG_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** A plugin the person brought (a local folder or a GitHub repository): its names are theirs, not a catalog's. */
export const isOwnPlugin = (plugin: { source: PluginSourceKind }): boolean =>
  plugin.source === PluginSourceKind.Local || plugin.source === PluginSourceKind.Github;

/**
 * How an event names a plugin: its id when a catalog published it (`source` null is a catalog or
 * index entry not installed), else only the kind of place it came from.
 */
export function pluginRef(id: string, source: PluginSourceKind | null): string {
  if (source === PluginSourceKind.Local) return PluginRefBucket.Local;
  if (source === PluginSourceKind.Github) return PluginRefBucket.Github;
  return CATALOG_ID.test(id) ? id : PluginRefBucket.Other;
}

/** An installed plugin, as much of it as its reference needs. */
export interface ListedRef {
  manifest: { id: string };
  source: PluginSourceKind;
}

/** An installed plugin's reference. */
export const installedRef = (plugin: ListedRef): string => pluginRef(plugin.manifest.id, plugin.source);

/**
 * A plugin known only by its id: as the installed list has it, or a catalog's when the list has no
 * such plugin (a suggestion or an install names a catalog plugin before it is installed).
 */
export function refFromList(list: readonly ListedRef[], id: string): string {
  const listed = list.find((plugin) => plugin.manifest.id === id);
  return pluginRef(id, listed?.source ?? null);
}

/**
 * Which of a plugin's toolbar buttons the stage strip shows for the game on it, pure. Genex's
 * Publish puts a game on the web, so a game without Browser among its destinations has none (the
 * host refuses it `not-a-destination` anyway). `PluginToolbar.tsx` applies it.
 */
import { BuildTarget } from "../../shared/game-project.ts";
import { GENEX_PLUGIN_ID, GENEX_PUBLISH_PANEL } from "../../shared/genex.ts";
import type { PluginInfo, PluginToolbarItem } from "../../shared/plugins.ts";

/** Whether `item` of `plugin` is Genex's Publish panel. */
function isGenexPublish(item: PluginToolbarItem, plugin: Pick<PluginInfo, "manifest">): boolean {
  const { target } = item;
  return plugin.manifest.id === GENEX_PLUGIN_ID && target.kind === "panel" && target.id === GENEX_PUBLISH_PANEL;
}

/** Whether a game made for `destinations` goes on the web (null: not known, so it may). */
export function playsOnWeb(destinations: readonly BuildTarget[] | null): boolean {
  return destinations === null || destinations.includes(BuildTarget.Web);
}

/**
 * `plugin`'s `items` the strip shows for a game made for `destinations` (null: no game, or one
 * whose destinations are not known, which hides nothing). Every other plugin's items are untouched.
 */
export function visibleToolbarItems(
  items: readonly PluginToolbarItem[],
  plugin: Pick<PluginInfo, "manifest">,
  destinations: readonly BuildTarget[] | null,
): PluginToolbarItem[] {
  if (playsOnWeb(destinations)) return [...items];
  return items.filter((item) => !isGenexPublish(item, plugin));
}

/**
 * The turn-it-on card a session shows in the chat (`plugins_suggest`, recorded as
 * `plugin_suggested`): which Genex plugin, why, and the one button the person may press. The
 * button is read from the live plugin list, not the record, so a plugin turned on since says On.
 */
import type { PluginInfo } from "../../shared/plugins.ts";
import { PluginOffer, type PluginSuggestedPayload } from "../../shared/project-tools.ts";
import { PLUGIN_SUGGESTION_WORDS } from "../words.ts";

/** What the card offers now: Turn on, Install…, or says the plugin is On. */
export const SuggestionState = {
  TurnOn: "turn-on",
  Install: "install",
  On: "on",
} as const;
export type SuggestionState = (typeof SuggestionState)[keyof typeof SuggestionState];

/** An installed plugin as the live list has it. */
type ListedPlugin = Pick<PluginInfo, "manifest" | "enabled" | "removed" | "unlisted">;

/**
 * The card's button for a plugin, from the live list: installed and on → On; installed but off →
 * Turn on; anything else (in Genex's catalog, removed, or code with no install record) → Install…,
 * which asks the person to review it first.
 */
export function suggestionState(list: readonly ListedPlugin[], pluginId: string): SuggestionState {
  const plugin = list.find((p) => p.manifest.id === pluginId && !p.unlisted && !p.removed);
  if (!plugin) return SuggestionState.Install;
  return plugin.enabled ? SuggestionState.On : SuggestionState.TurnOn;
}

/**
 * The plugin's name and description as the card shows them: from the live list when the plugin is
 * installed there, so the card always names the plugin its button acts on; otherwise (a catalog
 * plugin, which Install… reviews in Genex's own dialog first) the record's.
 */
export function suggestionShown(
  list: readonly ListedPlugin[],
  suggestion: Pick<PluginSuggestedPayload, "pluginId" | "name" | "description">,
): { name: string; description: string } {
  const listed = list.find((p) => p.manifest.id === suggestion.pluginId && !p.unlisted);
  if (listed) return { name: listed.manifest.name, description: listed.manifest.description };
  return { name: suggestion.name, description: suggestion.description };
}

/**
 * The card's line naming the folders outside the game an installed plugin's programs write to,
 * which turning it on approves; empty when it names none or is not installed (Install… reviews a
 * catalog plugin in Genex's own dialog first, which names its folders).
 */
export function suggestionFolders(list: readonly ListedPlugin[], pluginId: string): string {
  const plugin = list.find((p) => p.manifest.id === pluginId && !p.unlisted && !p.removed);
  const paths = (plugin?.manifest.folders ?? []).map((folder) => folder.path);
  return paths.length ? PLUGIN_SUGGESTION_WORDS.folders(paths.join(", ")) : "";
}

const isText = (value: unknown): value is string => typeof value === "string";
const OFFERS: ReadonlySet<unknown> = new Set(Object.values(PluginOffer));
const isOffer = (value: unknown): value is PluginOffer => OFFERS.has(value);

/** A record's card, or null for an old or partial one that names no plugin, game or offer. */
export function parseSuggestion(payload: Partial<PluginSuggestedPayload>): PluginSuggestedPayload | null {
  const { pluginId, name, offer, project } = payload;
  const named = isText(pluginId) && pluginId && isText(name) && isText(project) && project;
  if (!named || !isOffer(offer)) return null;
  return {
    pluginId,
    name,
    description: isText(payload.description) ? payload.description : "",
    offer,
    reason: isText(payload.reason) ? payload.reason : "",
    project,
  };
}

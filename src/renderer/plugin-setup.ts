/**
 * Opening a plugin's setup from anywhere: its toolbar panel over the stage when it has one (for
 * Genex, Studio's own Publish dialog), else the Plugins page on it. The stage strip listens
 * (`panels/PluginToolbar.tsx`); the chat's Genex cover card asks it for Publish.
 */
import { PluginsOpenedFrom } from "./analytics/plugins-page.ts";

/** The window event {@link openPluginSetup} dispatches, with the plugin's id. */
export const PLUGIN_SETUP_EVENT = "studio:plugin-setup";

/** What {@link PLUGIN_SETUP_EVENT} carries: the plugin, and (for usage analytics) where it was asked from. */
export interface PluginSetupRequest {
  id: string;
  from: PluginsOpenedFrom;
}

/** Open one plugin's setup: its toolbar panel, or the Plugins page on it. */
export function openPluginSetup(id: string, from: PluginsOpenedFrom = PluginsOpenedFrom.SetupRequest): void {
  window.dispatchEvent(new CustomEvent<PluginSetupRequest>(PLUGIN_SETUP_EVENT, { detail: { id, from } }));
}

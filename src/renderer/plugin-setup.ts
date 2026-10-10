/**
 * Opening a plugin's setup from anywhere: its toolbar panel over the stage when it has one (for
 * Genex, Studio's own Publish dialog), else the Plugins page on it. The stage strip listens
 * (`panels/PluginToolbar.tsx`); the chat's Genex cover card asks it for Publish.
 */

/** The window event {@link openPluginSetup} dispatches, with the plugin's id. */
export const PLUGIN_SETUP_EVENT = "studio:plugin-setup";

/** Open one plugin's setup: its toolbar panel, or the Plugins page on it. */
export function openPluginSetup(id: string): void {
  window.dispatchEvent(new CustomEvent<{ id: string }>(PLUGIN_SETUP_EVENT, { detail: { id } }));
}

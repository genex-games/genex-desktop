/**
 * Connect on the Genex page while the plugin is off: one press turns the plugin on and, when the
 * app is not signed in to Genex, signs in as the plate and the plugin's row do (the account is the
 * app's, and outlives the switch). A signed-in account is simply in use again. A failed turn-on
 * signs in to nothing.
 */
import type { PluginInfo } from "../../../../shared/plugins.ts";
import type { PluginsPage } from "../page.ts";

/** The app's Genex account as Connect needs it: whether it is signed in, and how to sign in. */
export interface ConnectAccount {
  signedIn: boolean;
  signIn: () => Promise<void>;
}

/** Turns the Genex plugin on and signs in when needed, as one of the page's actions. */
export function turnOnAndConnect(
  plugin: PluginInfo,
  page: Pick<PluginsPage, "act">,
  account: ConnectAccount,
): Promise<void> {
  return page.act(async () => {
    await window.studio.pluginEnable(plugin.manifest.id, true);
    if (!account.signedIn) await account.signIn();
  });
}

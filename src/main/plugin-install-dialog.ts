/**
 * The one native trust dialog every way a plugin can arrive goes through, and re-acquiring a
 * removed plugin from where it came from.
 */
import { dialog } from "electron";
import {
  type PluginInfo,
  type PluginManifest,
  type PluginScan,
  type PluginSource,
  PluginSourceKind,
} from "../shared/plugins.ts";
import type { PluginMarketplace } from "../substrate/plugins/marketplace.ts";
import { assertNativeActionAllowed } from "./dev/native-policy.ts";
import { asksBeforeInstall, reviewPluginInstall } from "./plugin-local-install.ts";
import { installPrompt, installUpdateFacts } from "./plugin-install-words.ts";
import type { StudioCore } from "./studio-core.ts";

/** Ask the user whether to install (or replace with) this package; true when they agreed. */
export type ConfirmPluginInstall = (
  manifest: PluginManifest,
  origin: PluginSource | undefined,
  scan: PluginScan | undefined,
  previous?: PluginManifest,
  note?: string,
) => Promise<boolean>;

/** The dialog's fixed words; its question, body and confirming button are built from the package. */
const MESSAGE = {
  installTitle: "Install plugin",
  replaceTitle: "Replace plugin",
  cancel: "Cancel",
  notInCatalog: "Plugin is not in the curated catalog",
  cancelled: "Cancelled by user",
} as const;

/**
 * One trust dialog for every way a plugin can arrive. It names where the code came from, which
 * capabilities are new since the installed version, and what the static scan saw — disclosure, not
 * isolation: the backend runs as trusted native code either way. `note` carries anything the user
 * must weigh besides the package itself, such as an index that has moved to another commit.
 * Genex's own bundled plugins install and update without it (`asksBeforeInstall`).
 */
export function confirmPluginInstall(
  core: () => Pick<StudioCore, "plugins" | "mcp">,
  fixtureNativePolicy: boolean,
): ConfirmPluginInstall {
  return async (manifest, origin, scan, previous, note) => {
    assertNativeActionAllowed(fixtureNativePolicy, "studio:plugins.install");
    // Refused before anything is asked: a bundled id from elsewhere, or an id a connector answers for.
    const review = reviewPluginInstall(core().plugins, manifest, origin, core().mcp.ids());
    if (!asksBeforeInstall(origin, review)) return true;
    const { replaces } = review;
    const facts = installUpdateFacts(core().plugins.list(), manifest, origin, previous, Boolean(replaces));
    const { before, previousScan, staysOn } = facts;
    const prompt = installPrompt({ manifest, origin, scan, before, previousScan, replaces, note, staysOn });
    const choice = await dialog.showMessageBox({
      type: "warning",
      title: replaces ? MESSAGE.replaceTitle : MESSAGE.installTitle,
      message: prompt.message,
      detail: prompt.detail,
      buttons: [MESSAGE.cancel, prompt.confirm],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice.response !== 1) return false;
    if (replaces) core().plugins.authorizeReplacement(manifest, origin ?? { kind: PluginSourceKind.Bundled });
    return true;
  };
}

/**
 * Put a removed plugin back where it came from when the folder it was loaded from is not the answer:
 * a curated release, a cataloged entry, or the commit the spec pinned. The registry asks; this decides.
 * Every path stages and scans the real code first and asks about THAT, never about the manifest the
 * old install record happens to carry.
 */
export async function reacquirePlugin(
  studio: StudioCore,
  market: PluginMarketplace,
  info: PluginInfo,
  confirmInstall: ConfirmPluginInstall,
): Promise<void> {
  const origin = info.origin;
  if (origin?.kind === PluginSourceKind.Catalog) {
    // The curated artifact is verified against the catalog's own manifest on the staged copy.
    const entry = (await studio.plugins.catalog()).find((p) => p.manifest.id === info.manifest.id);
    if (!entry) throw new Error(MESSAGE.notInCatalog);
    if (!(await confirmInstall(entry.manifest, origin, undefined, info.manifest))) throw new Error(MESSAGE.cancelled);
    await studio.plugins.installCatalog(info.manifest.id, entry.manifest.capabilities);
    return;
  }
  await market.reacquire(info, studio.plugins, (manifest, scan, source, note) =>
    confirmInstall(manifest, source, scan, info.manifest, note),
  );
}

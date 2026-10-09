import path from "node:path";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { type PluginManifest, type PluginScan, type PluginSource, PluginSourceKind } from "../shared/plugins.ts";
import type { PluginRegistry } from "../substrate/plugins/registry.ts";
import { inspectPackage } from "../substrate/plugins/manifest.ts";
import { scanPackage } from "../substrate/plugins/scan.ts";
import { packageCopyFilter } from "../substrate/plugins/pack.ts";

/** Why a local folder could not be installed again, as the plugin panel shows it. */
const MESSAGE = {
  folderGone: "The folder this plugin was loaded from is gone; load it again",
  differentPlugin: "The local folder now contains a different plugin. Load it as a new plugin instead.",
} as const;

/**
 * Where the code came from, as the trust dialog says it. Only an index entry is cataloged: a spec the
 * user typed names a commit on GitHub and nothing more.
 */
export const pluginOriginWords = (origin?: PluginSource): string => {
  const commit = `GitHub ${origin?.repo}@${(origin?.sha ?? "").slice(0, 12)}`;
  switch (origin?.kind) {
    case PluginSourceKind.Index:
      return `${commit} (cataloged, not audited)`;
    case PluginSourceKind.Github:
      return `${commit} (not in the catalog)`;
    case PluginSourceKind.Catalog:
      return "a curated release (cataloged, not audited)";
    case PluginSourceKind.Local:
      return "local folder";
    default:
      return "bundled";
  }
};

/** What the trust dialog must say besides the package itself. */
export interface PluginInstallReview {
  /** The plugin under this id that installing erases: another publisher, or another source. */
  replaces?: { name: string; publisher: string; origin?: PluginSource };
}

/**
 * The facts the trust dialog is built from, checked before it is shown. A bundled id from anywhere
 * but Studio, or an id a user connector already answers for (both publish `<id>__<tool>`), is refused
 * outright; a package that would take over another publisher's or source's id is named as such.
 */
export function reviewPluginInstall(
  registry: Pick<PluginRegistry, "assertInstallable" | "replacement">,
  manifest: PluginManifest,
  origin: PluginSource | undefined,
  connectorIds: readonly string[],
): PluginInstallReview {
  const from: PluginSource = origin ?? { kind: PluginSourceKind.Bundled };
  registry.assertInstallable(manifest, from);
  if (connectorIds.includes(manifest.id))
    throw new Error(
      `A connector already uses the id "${manifest.id}"; remove or rename that connector before installing this plugin`,
    );
  const replaces = registry.replacement(manifest, from);
  return replaces ? { replaces } : {};
}

/** Review a snapshot: a local author may keep editing while the native trust dialog is open. */
export async function installLocalPlugin(
  registry: PluginRegistry,
  directory: string,
  confirm: (
    manifest: PluginManifest,
    origin: PluginSource,
    scan: PluginScan,
    previous?: PluginManifest,
  ) => Promise<boolean>,
  expectedId?: string,
): Promise<void> {
  const origin: PluginSource = { kind: PluginSourceKind.Local, directory: path.resolve(directory) };
  const stillThere = await stat(directory).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!stillThere) throw new Error(MESSAGE.folderGone);
  await inspectPackage(directory);
  const staging = path.join(registry.root, "staging");
  await mkdir(staging, { recursive: true });
  const holder = await mkdtemp(path.join(staging, "local-review-"));
  const snapshot = path.join(holder, "package");
  try {
    await cp(directory, snapshot, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: packageCopyFilter(directory),
    });
    const manifest = await inspectPackage(snapshot);
    if (expectedId && manifest.id !== expectedId) throw new Error(MESSAGE.differentPlugin);
    const scan = await scanPackage(snapshot, manifest);
    const previous = registry.list().find((p) => p.manifest.id === manifest.id);
    if (!(await confirm(manifest, origin, scan, previous?.manifest))) return;
    await registry.installLocal(snapshot, PluginSourceKind.Local, manifest.capabilities, origin, scan);
  } finally {
    await rm(holder, { recursive: true, force: true });
  }
}

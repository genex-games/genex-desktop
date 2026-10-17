/**
 * The plugin-updates fixture: a profile whose bundled plugins read as an older build's installs, so
 * this build's registry offers each one's update (`PluginInfo.availableVersion`). The registry
 * installs them as on any first launch; the fixture then stamps each installed copy one version
 * behind its seed, before the core starts its own registry over the same store.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, ensureDir } from "../../substrate/fsx.ts";
import { PluginRegistry } from "../../substrate/plugins/registry.ts";

/** Why a bundled plugin cannot be stamped older. */
const MESSAGE = {
  nothingOlder: (version: string) => `no plugin version is older than ${version}`,
} as const;

/** The registry's record of what its store holds, by plugin id. */
const INSTALL_RECORDS = "installed.json";
/** A package's manifest, in its folder. */
const MANIFEST = "plugin.json";

/** What the fixture reads of a manifest; the rest is written back as it was. */
interface VersionedManifest {
  id: string;
  version: string;
}

/** What the fixture reads and changes of an install record; the registry owns the rest. */
interface InstallRecord {
  directory: string;
  manifest: VersionedManifest;
}

/** The version one step behind `version`: its last part above zero, lowered by one. */
function versionBehind(version: string): string {
  const parts = version.split(".").map(Number);
  const lowered = parts.findLastIndex((part) => part > 0);
  if (lowered < 0) throw new Error(MESSAGE.nothingOlder(version));
  return parts.map((part, at) => (at === lowered ? part - 1 : part)).join(".");
}

async function readManifest(directory: string): Promise<VersionedManifest> {
  return JSON.parse(await readFile(path.join(directory, MANIFEST), "utf8"));
}

/** Install each bundled plugin the store lacks, as the core's registry would on a first launch. */
async function installSeeds(store: string, seeds: string, resources: string): Promise<void> {
  // No service is called: a fresh install has no saved account to restore.
  const registry = new PluginRegistry(store, seeds, path.join(resources, "plugin-sdk/backend.mjs"), async () => null);
  try {
    await registry.init();
  } finally {
    registry.cancel();
  }
}

/**
 * Leave every bundled plugin installed one version behind this build's, in the plugin store under
 * `engineHomes`. Only a copy still at its seed's version is stamped, so a reused profile keeps
 * the plugins it has; nothing outside `engineHomes` is written.
 */
export async function installOlderPlugins(engineHomes: string, resources: string): Promise<void> {
  const store = path.join(engineHomes, "plugins");
  const seeds = path.join(resources, "plugins");
  // The core makes this folder with its own mode; the registry alone would make it private.
  await ensureDir(engineHomes);
  await installSeeds(store, seeds, resources);
  const file = path.join(store, INSTALL_RECORDS);
  const records: Record<string, InstallRecord> = JSON.parse(await readFile(file, "utf8"));
  for (const name of await readdir(seeds)) {
    const seed = await readManifest(path.join(seeds, name));
    const record = records[seed.id];
    if (record?.manifest.version !== seed.version) continue;
    const version = versionBehind(seed.version);
    // The copy's own manifest and its record say the same version, as an install's always do.
    await atomicWriteJson(path.join(record.directory, MANIFEST), {
      ...(await readManifest(record.directory)),
      version,
    });
    record.manifest.version = version;
  }
  await atomicWriteJson(file, records);
}

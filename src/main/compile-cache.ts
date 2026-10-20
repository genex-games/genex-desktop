/**
 * V8's compile cache for the packaged main bundle. Without it every launch parses and compiles all
 * of `app.mjs` (several MB) before the first window; with it a launch reads the compiled code back
 * (measured on Electron 43: the bundle's import 238 → 168 ms median). Node keys each entry by the
 * file and a hash of its source, so an update recompiles once and a changed file is never served
 * stale code.
 *
 * Only a normal packaged launch writes the cache, in the profile it runs with. Development, test,
 * runner and installer launches carry a switch (`StudioFlag`, Squirrel's) or are unpackaged, and
 * leave every profile folder as it was. Any failure leaves the launch uncached and costs it nothing.
 */
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { StudioFlag } from "./dev/launch-flags.ts";

/** The cache's folder inside the profile's data folder. */
export const COMPILE_CACHE_FOLDER = "v8-compile-cache";

/** What the cache needs from Electron and Node; a fake in tests. */
export interface CompileCacheHost {
  packaged: boolean;
  argv: readonly string[];
  userData: string;
  /** `module.enableCompileCache`, reduced to whether it is on and where. */
  enable(dir: string): { enabled: boolean; directory: string | undefined };
  /** `module.flushCompileCache`. */
  flush(): void;
  onQuit(write: () => void): void;
  /** Runs `write` once the launch has compiled what it starts with. */
  later(write: () => Promise<void>): void;
}

/** Turn the cache on for a normal packaged launch; call before the app bundle is imported. */
export function startCompileCache(host: CompileCacheHost): void {
  if (!host.packaged || host.argv.some(isLaunchSwitch)) return;
  let directory: string | undefined;
  try {
    const status = host.enable(path.join(host.userData, COMPILE_CACHE_FOLDER));
    if (!status.enabled) return;
    directory = status.directory;
  } catch {
    return;
  }
  const write = () => {
    try {
      host.flush();
    } catch {
      // A full or read-only disk leaves the next launch uncached, nothing worse.
    }
  };
  host.later(async () => {
    write();
    if (directory) await removeOlderRuntimes(directory);
  });
  host.onQuit(write);
}

const LAUNCH_SWITCHES: readonly string[] = Object.values(StudioFlag);
/** Windows' installer launches the app to make or remove shortcuts, then it exits at once. */
const SQUIRREL_SWITCH = "--squirrel-";

function isLaunchSwitch(arg: string): boolean {
  if (arg.startsWith(SQUIRREL_SWITCH)) return true;
  return LAUNCH_SWITCHES.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * Node writes one folder per runtime (`v<node>-<arch>-<flags hash>-<uid>`); an Electron update
 * leaves the previous one unread forever. Remove those once this runtime's is written.
 */
async function removeOlderRuntimes(directory: string): Promise<void> {
  const current = `v${process.versions.node}-${process.arch}-`;
  try {
    for (const name of await readdir(directory)) {
      if (/^v\d+\.\d+\.\d+-/.test(name) && !name.startsWith(current))
        await rm(path.join(directory, name), { recursive: true, force: true });
    }
  } catch {
    // The folder is only a cache.
  }
}

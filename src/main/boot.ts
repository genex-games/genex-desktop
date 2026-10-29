/**
 * Electron's entry (`dist/main/main.mjs`): points Electron at the folder the person keeps Genex's
 * data in (`data-folder.ts`), turns on V8's compile cache for the app bundle, then loads it
 * (`dist/main/app.mjs`, built from `index.ts`). The cache only covers modules loaded after it is
 * on, which is why this file is separate and stays small.
 */
import { app } from "electron";
import module from "node:module";
import { startCompileCache } from "./compile-cache.ts";
import { pointElectronAtData } from "./data-folder.ts";
import { isNormalLaunch } from "./dev/launch-flags.ts";
import { SECOND_MS } from "../shared/duration.ts";

/** Long enough for the launch to compile what its first window runs. */
const WRITE_CACHE_AFTER_MS = 30 * SECOND_MS;

// Before anything reads userData: the compile cache below is the first.
pointElectronAtData({
  appData: app.getPath("appData"),
  appName: app.getName(),
  temp: app.getPath("temp"),
  argvNormal: isNormalLaunch(process.argv),
  setPath: (name, dir) => app.setPath(name, dir),
  lock: () => app.requestSingleInstanceLock(),
});

const { ENABLED, ALREADY_ENABLED } = module.constants.compileCacheStatus;
startCompileCache({
  packaged: app.isPackaged,
  argv: process.argv,
  userData: app.getPath("userData"),
  enable: (dir) => {
    const result = module.enableCompileCache(dir);
    return { enabled: result.status === ENABLED || result.status === ALREADY_ENABLED, directory: result.directory };
  },
  flush: () => module.flushCompileCache(),
  onQuit: (write) => app.once("will-quit", write),
  later: (write) => setTimeout(() => void write(), WRITE_CACHE_AFTER_MS).unref(),
});

// The app bundle beside this file in dist/main, built from ./index.ts; esbuild leaves a URL alone.
await import(new URL("./app.mjs", import.meta.url).href);

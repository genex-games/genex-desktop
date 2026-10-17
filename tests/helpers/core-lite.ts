/**
 * A real {@link StudioCore} brought up to `init()` and no further: real event log, settings,
 * game library, plugin registry and `api()` table, but no harness child process, no engines and
 * (unless asked) no Seatbelt sandbox. The dev-policy pattern, made reusable.
 *
 * Use it for anything that talks to the core's substrate API or public methods directly. Reach for
 * `studio-rig.ts` only when the harness loop itself has to run.
 */
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { StudioCore, type StudioCoreOptions } from "../../src/main/studio-core.ts";
import { sharedResources } from "./resources.ts";
import { closeBeforeCleanup, tmpDir } from "./tmp.ts";

export { sharedResources };

export type CoreApi = ReturnType<StudioCore["api"]>;

export interface CoreLite {
  core: StudioCore;
  userData: string;
  gamesRoot: string;
  resources: string;
  /** The substrate table the harness calls through `ctx.call(method, params)`. */
  api(): CoreApi;
  /** Stop the core; safe to call twice. Also runs automatically before the file's temp cleanup. */
  close(): Promise<void>;
}

export interface CoreLiteOptions extends Partial<Omit<StudioCoreOptions, "paths">> {
  /** Stop after construction: nothing on disk is touched and `api()` still answers its keys. */
  init?: boolean;
  /** A resources folder of the test's own (`makeResources`), instead of the file's shared copy. */
  resources?: string;
}

export async function coreLite(options: CoreLiteOptions = {}): Promise<CoreLite> {
  const { init = true, resources: ownResources, ...overrides } = options;
  const resourcesDir = ownResources ?? (await sharedResources());
  // Real, not /var/folders behind the /private link: the development containment check refuses a
  // games root reached through a link, and the app's own games root is never spelled that way.
  const root = await realpath(await tmpDir("studio-core-lite-"));
  const userData = path.join(root, "userData");
  const gamesRoot = overrides.gamesRoot ?? path.join(root, "games");
  await mkdir(gamesRoot, { recursive: true });
  const core = new StudioCore({
    paths: { userData, resources: resourcesDir },
    gamesRoot,
    // No engine unless the test brings one: nothing probes an account, a CLI or a local model.
    engines: [],
    executionPolicy: { allowedProjectRoot: gamesRoot, runBackgroundImprovement: false },
    improvementIdle: { idleMs: 0, minGapMs: 0 },
    // Seatbelt is a process-wide singleton with proxy servers that keep the file alive; tests that
    // assert containment opt back in with `sandbox: true`.
    sandbox: false,
    execPath: process.execPath,
    ...overrides,
  });
  let closed: Promise<void> | undefined;
  // Stopping the core also releases the sandbox it opened (with `sandbox: true`).
  const close = () => {
    closed ??= core.stop().catch(() => {});
    return closed;
  };
  closeBeforeCleanup(close);
  if (init) await core.init();
  return { core, userData, gamesRoot, resources: resourcesDir, api: () => core.api(), close };
}

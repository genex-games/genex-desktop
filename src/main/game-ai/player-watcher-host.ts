/**
 * The plan watcher's production parts, so main composes it with one call
 * (`createPlanWatcher(planWatcherDeps(...))`): the box each job runs in (a `ProcessSandbox` of its
 * own), the CLIs as Studio's discovery finds them, the player credential in the secret store, the
 * files under `userData/game-ai/`, and the name this Mac shows on genex.games' watcher list. What
 * belongs to the rest of the app (the plan's windows, the keep-for-building share, the browser,
 * Settings' notice, the log) comes in from main.
 */
import os from "node:os";
import path from "node:path";
import { AiWatcherRunner } from "../../shared/game-ai-watcher.ts";
import type { PlayOrigins } from "../../shared/play.ts";
import type { ProviderUsage } from "../../shared/provider-usage.ts";
import { EngineId } from "../../shared/providers.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { codexAuthStatus } from "../../substrate/engines/codex-cli.ts";
import { resolveCodingCli } from "../../substrate/engines/external-cli.ts";
import { type ApiKeyStore, GENEX_PLAYER_CREDENTIAL_SECRET, secretKeyStore } from "../../substrate/provider-keys.ts";
import { ProcessSandbox } from "../../substrate/spawn.ts";
import type { RunnerSandboxFactory } from "./player-runner.ts";
import { type FoundCli, type PlanWatcherDeps, REAL_WATCHER_TIMERS, readCliWatcherState } from "./player-watcher.ts";

/** The longest machine name a label carries. */
const HOST_NAME_CHARS = 48;
/** The longest platform tag genex.games' heartbeat route takes (`^[a-z0-9_-]{1,40}$`). */
const PLATFORM_TAG_CHARS = 40;

/** The coding CLI each watcher runner is. */
const ENGINE_OF_RUNNER = {
  [AiWatcherRunner.Claude]: EngineId.ClaudeCode,
  [AiWatcherRunner.Codex]: EngineId.Codex,
} as const satisfies Record<AiWatcherRunner, string>;

/** "Genex on <this Mac's name>": printable, bounded, without the `.local` suffix. */
export function watcherLabel(hostname: string): string {
  const name = hostname
    .replace(/[^A-Za-z0-9 ._-]/g, "")
    .replace(/\.local$/i, "")
    .trim()
    .slice(0, HOST_NAME_CHARS)
    .trim();
  return `Genex on ${name || "this Mac"}`;
}

/** The platform as genex.games' heartbeat takes it. */
export function platformTag(platform: string): string {
  return (
    platform
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, PLATFORM_TAG_CHARS) || "unknown"
  );
}

/**
 * A `ProcessSandbox` of its own for each job or probe: it writes only the job's folder (and Claude
 * Code's own home, the one credential home exempted for it), and denies every path no agent may
 * read. The job's policy (`runnerPolicy`) adds the read-deny on the home folder per run.
 */
export function runnerSandboxes(
  secretPaths: readonly string[],
  options: { enabled?: boolean } = {},
): RunnerSandboxFactory {
  return (box) =>
    ProcessSandbox.create({
      writableRoots: [box.cwd],
      scratchDir: path.join(box.cwd, ".scratch"),
      secretPaths: [...secretPaths],
      ownHome: box.ownHome,
      enabled: options.enabled ?? true,
    });
}

/** A CLI as Studio's discovery finds it (the same install Settings shows), with the environment it found it in. */
export async function findWatcherCli(runner: AiWatcherRunner): Promise<FoundCli | null> {
  const found = await resolveCodingCli(ENGINE_OF_RUNNER[runner]);
  const binary = found.status.path;
  return found.status.state === CodingCliState.Ready && binary ? { binary, env: found.env } : null;
}

/** Whether Codex is signed in to a ChatGPT plan here (an API-key sign-in is no plan). */
export async function codexOnPlan(): Promise<boolean> {
  const status = await codexAuthStatus();
  return status.loggedIn === true && status.method === "chatgpt";
}

/** What main hands the watcher. */
export interface PlanWatcherHostOptions {
  origins: PlayOrigins;
  version: string;
  userData: string;
  /** `layout.secrets`: the player credential is kept in its `providers` store. */
  secretsDir: string;
  /** Paths no agent process may read (`StudioCore`'s protected paths), denied in every job's box too. */
  protectedPaths: readonly string[];
  /** A fixture profile's in-memory store; the OS secret store otherwise. */
  credential?: ApiKeyStore;
  planUsage(runner: AiWatcherRunner): Promise<ProviderUsage | null>;
  keepForBuildingPercent(): Promise<number>;
  openSignIn(url: string): Promise<void>;
  notify(): void;
  log(line: string): void;
  /** Test seams; this Mac's own by default. */
  home?: string;
  hostname?: string;
  platform?: string;
  tmpRoot?: string;
  sandboxEnabled?: boolean;
}

/** The watcher's deps for this app. */
export function planWatcherDeps(options: PlanWatcherHostOptions): PlanWatcherDeps {
  const home = options.home ?? os.homedir();
  const folder = path.join(options.userData, "game-ai");
  return {
    api: options.origins.api,
    web: options.origins.web,
    version: options.version,
    platform: platformTag(options.platform ?? process.platform),
    label: watcherLabel(options.hostname ?? os.hostname()),
    home,
    env: process.env,
    credential:
      options.credential ?? secretKeyStore(path.join(options.secretsDir, "providers"), GENEX_PLAYER_CREDENTIAL_SECRET),
    stateFile: path.join(folder, "watcher.json"),
    tmpRoot: path.join(options.tmpRoot ?? os.tmpdir(), "genex-player"),
    canaryDir: path.join(folder, "probe"),
    sandbox: runnerSandboxes(options.protectedPaths, { enabled: options.sandboxEnabled ?? true }),
    findCli: findWatcherCli,
    codexSignedIn: codexOnPlan,
    planUsage: (runner) => options.planUsage(runner),
    keepForBuildingPercent: () => options.keepForBuildingPercent(),
    cliWatcher: () => readCliWatcherState(home, Date.now()),
    openSignIn: (url) => options.openSignIn(url),
    notify: () => options.notify(),
    log: (line) => options.log(line),
    clock: { now: () => Date.now() },
    timers: REAL_WATCHER_TIMERS,
    fetch: (input, init) => fetch(input, init),
    random: () => Math.random(),
  };
}

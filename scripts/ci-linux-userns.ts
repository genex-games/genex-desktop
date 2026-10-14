/**
 * Linux CI only (`.github/workflows/linux-userns.yml`): the steps of the Ubuntu 24.04 job that go
 * through Genex's own code rather than shell.
 *
 *   node scripts/ci-linux-userns.ts restricted            fails unless this unconfined process is
 *                                                          restricted, as the app reads it
 *   node scripts/ci-linux-userns.ts unprofiled <exe>      fails unless that copy, which no profile
 *                                                          names, stops at Chromium's sandbox
 *   node scripts/ci-linux-userns.ts install <executable>  installs the portable profile for that
 *                                                          copy exactly as Set up does, with
 *                                                          non-interactive sudo in pkexec's place
 *
 * It loads an AppArmor profile as root, so it refuses to run outside a GitHub Actions Linux runner.
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { StudioPlatform } from "../src/shared/boot.ts";
import { SECOND_MS } from "../src/shared/duration.ts";
import { CHROMIUM_SANDBOX_FATALS, usernsRestricted } from "../src/substrate/linux-apparmor.ts";
import { installLinuxUsernsProfile, type RunPrivileged } from "../src/substrate/linux-userns-setup.ts";
import { readSystemFile, runningExecutable } from "../src/substrate/sandbox-unavailable.ts";

/** What stands in pkexec's argv slot: `runWithSudo` replaces it with `sudo -n`. */
const PKEXEC_STAND_IN = "sudo";

/** How long an unprofiled copy may take to stop: Chromium checks its sandbox before any window. */
export const UNPROFILED_EXIT_TIMEOUT_MS = 30 * SECOND_MS;

const Command = {
  Restricted: "restricted",
  Unprofiled: "unprofiled",
  Install: "install",
} as const;

/** Why an unprofiled copy did not stop the way a zip copy on Ubuntu 24.04 does. */
export const UnprofiledFailure = {
  /** It could not be started at all. */
  DidNotStart: "did-not-start",
  /** It exited 0: the restriction did not stop it. */
  ExitedZero: "exited-zero",
  /** It was still running at the deadline: it got past the sandbox. */
  StillRunning: "still-running",
  /** It failed, but not at Chromium's sandbox. */
  OtherError: "other-error",
} as const;
export type UnprofiledFailure = (typeof UnprofiledFailure)[keyof typeof UnprofiledFailure];

const MESSAGE = {
  runnerOnly: "ci-linux-userns runs only on a disposable GitHub Actions Linux runner",
  notRestricted: "this unconfined process is not restricted: the switch is off or a profile labels it",
  notInstalled: (executable: string) => `Set up's install did not finish for ${executable}`,
  unprofiled: {
    [UnprofiledFailure.DidNotStart]: "the unprofiled copy could not be started",
    [UnprofiledFailure.ExitedZero]: "the unprofiled copy exited 0: the restriction did not stop it",
    [UnprofiledFailure.StillRunning]: `the unprofiled copy still ran after ${UNPROFILED_EXIT_TIMEOUT_MS / SECOND_MS} s: it got past Chromium's sandbox`,
    [UnprofiledFailure.OtherError]: `the unprofiled copy failed without either of Chromium's sandbox FATALs (${CHROMIUM_SANDBOX_FATALS.map((fatal) => `"${fatal}"`).join(", ")})`,
  } satisfies Record<UnprofiledFailure, string>,
  usage: "usage: node scripts/ci-linux-userns.ts restricted | unprofiled <executable> | install <executable>",
} as const;

/** How a launched copy ended: its exit code or signal, or why it never started. */
export interface AppExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

/** A launched copy: its error output as it comes, how it ends, and a way to stop it. */
export interface LaunchedApp {
  onStderr(listener: (chunk: string) => void): void;
  exited: Promise<AppExit>;
  kill(): void;
}

/** Start `executable` with no arguments. */
export type LaunchApp = (executable: string) => LaunchedApp;

/** The unprofiled check's seams: the launch, and a wait that ends early when `signal` aborts. */
export interface UnprofiledSeams {
  launch: LaunchApp;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Start a copy no profile names and see how it ends: null when it stops as a zip copy does on
 * Ubuntu 24.04 (a non-zero exit, or death by signal, with one of Chromium's sandbox FATALs,
 * {@link CHROMIUM_SANDBOX_FATALS}, on stderr) within {@link UNPROFILED_EXIT_TIMEOUT_MS}; otherwise
 * what happened instead. A copy still running at the deadline is killed; one that ended cancels the
 * deadline.
 */
export async function checkUnprofiledCopy(
  executable: string,
  seams: UnprofiledSeams,
): Promise<UnprofiledFailure | null> {
  const app = seams.launch(executable);
  let stderr = "";
  app.onStderr((chunk) => {
    stderr += chunk;
  });
  const deadline = new AbortController();
  const timedOut = seams.wait(UNPROFILED_EXIT_TIMEOUT_MS, deadline.signal).then(() => null);
  const exit = await Promise.race([app.exited, timedOut]);
  if (exit === null) {
    app.kill();
    return UnprofiledFailure.StillRunning;
  }
  deadline.abort();
  if (exit.error !== undefined) return UnprofiledFailure.DidNotStart;
  if (exit.code === 0) return UnprofiledFailure.ExitedZero;
  return CHROMIUM_SANDBOX_FATALS.some((fatal) => stderr.includes(fatal)) ? null : UnprofiledFailure.OtherError;
}

/**
 * The copy for real: its own process group (Chromium starts helpers), stderr read and passed on to
 * the job's log (so a run shows which FATAL Chromium printed), the rest ignored.
 */
const launchApp: LaunchApp = (executable) => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [], { detached: true, stdio: ["ignore", "ignore", "pipe"], env });
  child.stderr?.setEncoding("utf8");
  return {
    onStderr: (listener) =>
      child.stderr?.on("data", (chunk: string) => {
        process.stderr.write(chunk);
        listener(chunk);
      }),
    exited: new Promise((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error: error.message }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    }),
    kill: () => {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    },
  };
};

/** A deadline that a finished copy cancels, so the script does not wait it out. */
const waitFor: UnprofiledSeams["wait"] = (ms, signal) => sleep(ms, undefined, { signal }).catch(() => {});

function fail(reason: string): never {
  console.log(`::error title=Linux user namespaces::${reason}`);
  process.exit(1);
}

/** Set up's privileged run with `sudo -n` in pkexec's place: the runner's user sudoes without a prompt. */
const runWithSudo: RunPrivileged = async ([, ...argv], timeoutMs) => {
  const result = spawnSync(PKEXEC_STAND_IN, ["-n", ...argv], { encoding: "utf8", timeout: timeoutMs });
  return { code: result.status, stderr: result.stderr ?? result.error?.message ?? "" };
};

async function unprofiled(target: string): Promise<void> {
  const failure = await checkUnprofiledCopy(target, { launch: launchApp, wait: waitFor });
  if (failure) fail(MESSAGE.unprofiled[failure]);
  console.log(`unprofiled: ${target} stopped at Chromium's sandbox (its FATAL above), as a zip copy does`);
}

async function main(): Promise<void> {
  const onRunner = process.platform === StudioPlatform.Linux && process.env.GITHUB_ACTIONS === "true";
  if (!onRunner) fail(MESSAGE.runnerOnly);
  const [command, target] = process.argv.slice(2);
  if (command === Command.Restricted) {
    if (!usernsRestricted(readSystemFile)) fail(MESSAGE.notRestricted);
    console.log("restricted: kernel.apparmor_restrict_unprivileged_userns=1 and this process is unconfined");
    return;
  }
  if (command === Command.Unprofiled && target) return unprofiled(target);
  if (command !== Command.Install || !target) fail(MESSAGE.usage);
  const executable = runningExecutable(target);
  const { cancelled, restart } = await installLinuxUsernsProfile({
    execPath: target,
    pkexec: PKEXEC_STAND_IN,
    run: runWithSudo,
  });
  if (cancelled || !restart) fail(MESSAGE.notInstalled(executable));
  console.log(`loaded Genex's portable AppArmor profile for ${executable}`);
}

// Run as a script only (the tests import the unprofiled check). `import.meta.main` holds however the
// script was reached, a symlinked path included, so the checks can never be skipped by the guard.
if (import.meta.main) main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

/**
 * Whether the Linux sandbox can isolate a process at all, checked once at startup.
 *
 * bubblewrap needs user namespaces that carry capabilities. Ubuntu 24.04 and the distributions
 * built on it (`kernel.apparmor_restrict_unprivileged_userns`) strip them from every program no
 * AppArmor profile allows, so bwrap is installed, sandbox-runtime's dependency check passes, and
 * still no sandboxed process starts: the harness never boots. Startup runs one command in the
 * sandbox first, and a failure becomes the setup screen's problem. Under AppArmor's restriction it
 * carries the command that installs the same profile the .deb's postinst installs
 * (build/linux/postinst); processes the app starts, bwrap included, inherit it. Where the system
 * also confines /usr/bin/bwrap (Ubuntu 24.10 and later), the command copies it beside the app as
 * postinst does, since only a copy keeps the app's profile (linux-bubblewrap.ts).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type SandboxProblem, SandboxProblemCode, StudioPlatform } from "../shared/boot.ts";
import { SECOND_MS } from "../shared/duration.ts";
import { bubblewrapConfined, ownBubblewrapPath } from "./linux-bubblewrap.ts";
import { SandboxUnavailableError } from "./sandbox-unavailable.ts";
import { type ProcessSandbox, shellQuote } from "./spawn.ts";

/** How long the startup check may take: one `true` inside bwrap, normally well under a second. */
const ISOLATION_CHECK_TIMEOUT_MS = 30 * SECOND_MS;
/** The profile's name, and its file under /etc/apparmor.d. */
const PROFILE_NAME = "genex";
const PROFILE_FILE = `/etc/apparmor.d/${PROFILE_NAME}`;
/** The kernel switch, under /proc, that restricts user namespaces to programs a profile allows. */
const RESTRICTION_SWITCH = ["sys", "kernel", "apparmor_restrict_unprivileged_userns"] as const;
/**
 * What an AppArmor attachment path may not hold: a pattern character (`* ? [ ] { } ^`, and `@{`
 * opens a variable), a quote or backslash the quoted path cannot carry, or a control character.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses.
const UNREPRESENTABLE = /[*?[\]{}^"\\\u0000-\u001f\u007f]/;

const MESSAGE = {
  label: "sandbox isolation check",
  timedOut: (seconds: number) => `the sandbox did not start a process within ${seconds} s`,
  exited: (code: number | null) => `the sandbox could not start a process (exit ${code ?? "by signal"})`,
} as const;

/** The profile's lines, or null for a path AppArmor would read as a pattern or could not quote. */
function profileLines(execPath: string): string[] | null {
  if (!path.posix.isAbsolute(execPath) || UNREPRESENTABLE.test(execPath)) return null;
  return [
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "",
    `profile ${PROFILE_NAME} "${execPath}" flags=(unconfined) {`,
    "  userns,",
    "",
    `  include if exists <local/${PROFILE_NAME}>`,
    "}",
  ];
}

/** The AppArmor profile that lets `execPath` (and what it starts) create user namespaces. */
export function appArmorProfile(execPath: string): string | null {
  const lines = profileLines(execPath);
  return lines ? `${lines.join("\n")}\n` : null;
}

/** What the setup command does: install the profile, copy bubblewrap beside the app, or both. */
export interface AllowSteps {
  profile: boolean;
  ownBubblewrap: boolean;
}

/**
 * One shell command line that installs {@link appArmorProfile} for `execPath` and loads it, and
 * with `ownBubblewrap` copies the bubblewrap on PATH beside the app, root-owned.
 */
export function appArmorAllowCommand(
  execPath: string,
  steps: AllowSteps = { profile: true, ownBubblewrap: false },
): string | null {
  const lines = profileLines(execPath);
  if (!lines) return null;
  const write = `printf '%s\\n' ${lines.map(shellQuote).join(" ")}`;
  const parts = [
    ...(steps.profile
      ? [`${write} | sudo tee ${PROFILE_FILE} > /dev/null && sudo apparmor_parser -r ${PROFILE_FILE}`]
      : []),
    ...(steps.ownBubblewrap
      ? [`sudo install -m 0755 "$(command -v bwrap)" ${shellQuote(ownBubblewrapPath(execPath))}`]
      : []),
  ];
  return parts.length ? parts.join(" && ") : null;
}

/** Does the kernel restrict user namespaces to programs an AppArmor profile allows? */
export async function appArmorRestrictsNamespaces(procRoot = "/proc"): Promise<boolean> {
  const value = await readFile(path.join(procRoot, ...RESTRICTION_SWITCH), "utf8").catch(() => "");
  return value.trim() === "1";
}

/** What the isolation check found when the sandbox could not start a process. */
export interface IsolationFailure {
  /** What the failed start printed, for Details. */
  details: string[];
  /** AppArmor's user-namespace restriction is on. */
  restricted: boolean;
  /** The app's executable, which the profile names. */
  execPath: string;
  /** The system confines /usr/bin/bwrap itself, so the app needs its own copy. */
  bwrapConfined: boolean;
}

/** The setup problem for a sandbox that cannot start a process. */
export function isolationProblem(failure: IsolationFailure): SandboxProblem {
  const steps = { profile: failure.restricted, ownBubblewrap: failure.bwrapConfined };
  const allowCommand = steps.profile || steps.ownBubblewrap ? appArmorAllowCommand(failure.execPath, steps) : null;
  return {
    code: SandboxProblemCode.IsolationBlocked,
    platform: StudioPlatform.Linux,
    missingTools: [],
    installCommands: [],
    details: failure.details,
    ...(allowCommand ? { allowCommand } : {}),
  };
}

/** Test seams for {@link checkLinuxIsolation}; production reads the real ones. */
export interface IsolationCheckOptions {
  platform?: NodeJS.Platform;
  /** Where /proc is. */
  procRoot?: string;
  /** Where /etc is. */
  etcRoot?: string;
  /** The executable the profile names (default: this process's). */
  execPath?: string;
}

/**
 * Linux: start one process in `sandbox`; when it cannot, throw the setup problem the window shows
 * instead of a harness that never boots. Nothing runs on other platforms or with the sandbox off.
 */
export async function checkLinuxIsolation(sandbox: ProcessSandbox, options: IsolationCheckOptions = {}): Promise<void> {
  if ((options.platform ?? process.platform) !== StudioPlatform.Linux || !sandbox.enabled) return;
  const result = await sandbox.run({
    command: "true",
    cwd: sandbox.scratchDir,
    label: MESSAGE.label,
    timeoutMs: ISOLATION_CHECK_TIMEOUT_MS,
  });
  if (result.code === 0) return;
  const printed = result.stderr.split("\n").map((line) => line.trim());
  const outcome = result.timedOut
    ? MESSAGE.timedOut(ISOLATION_CHECK_TIMEOUT_MS / SECOND_MS)
    : MESSAGE.exited(result.code);
  const details = printed.some(Boolean) ? printed.filter(Boolean) : [outcome];
  const restricted = await appArmorRestrictsNamespaces(options.procRoot);
  const bwrapConfined = bubblewrapConfined(options.etcRoot);
  throw new SandboxUnavailableError(
    isolationProblem({ details, restricted, bwrapConfined, execPath: options.execPath ?? process.execPath }),
  );
}

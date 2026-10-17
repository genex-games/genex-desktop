/**
 * Install the Windows Squirrel installer the way a person does, then uninstall it (Windows only).
 *
 * Setup.exe unpacks the app into %LOCALAPPDATA%\genex\app-<version>, starts it once with
 * `--squirrel-install` (main makes the Start menu and desktop shortcuts through Update.exe and
 * exits) and then opens it. The checks: the install lands, the shortcuts appear, no installed
 * path reaches MAX_PATH, the app's own Git runs with no other Git on PATH, the first start on a
 * PC whose sandbox is not set up yet opens the setup screen rather than an error, and
 * `Update.exe --uninstall` takes the shortcuts away again. The copy
 * Setup.exe opens is closed before the uninstall; it runs on the CI machine's own profile.
 *
 *   npm run make -- --platform win32 --arch x64 && node tests/e2e/run-squirrel-install.mjs
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
/** forge.config.cjs's maker-squirrel `name` and `setupExe`. */
const INSTALL_NAME = "genex";
const SETUP_EXE = path.join(root, "out", "make", "squirrel.windows", "x64", "Genex-Setup.exe");
/** Windows' MAX_PATH, which counts the terminating NUL. */
const MAX_PATH = 260;
const SETUP_TIMEOUT_MS = 5 * 60_000;
const SETTLE_TIMEOUT_MS = 2 * 60_000;
const GIT_RUN_TIMEOUT_MS = 60_000;
/** The installed app's log (main's `userData/logs/studio.log`; userData is named for productName). */
const STUDIO_LOG = path.join(process.env.APPDATA ?? "", "Genex", "logs", "studio.log");
/** What main logs when it opens the setup screen on an unprovisioned sandbox (main/index.ts). */
const SETUP_SCREEN_LOG = /sandbox unavailable: not-provisioned/;
const POLL_MS = 1_000;

const installDir = path.join(process.env.LOCALAPPDATA ?? "", INSTALL_NAME);
const shortcutRoots = [
  path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs"),
  path.join(process.env.USERPROFILE ?? "", "Desktop"),
];
const results = [];

function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? `  — ${detail}` : ""}`);
}

async function filesUnder(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

async function genexShortcuts() {
  const found = await Promise.all(shortcutRoots.map(filesUnder));
  return found.flat().filter((file) => /^genex.*\.lnk$/i.test(path.basename(file)));
}

/** Poll `probe` until it returns a truthy value or the settle time runs out. */
async function settle(probe) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const value = await probe();
    if (value || Date.now() > deadline) return value;
    await delay(POLL_MS);
  }
}

async function installedApp() {
  const versions = (await readdir(installDir).catch(() => [])).filter((name) => name.startsWith("app-"));
  const exe = versions.map((name) => path.join(installDir, name, `${INSTALL_NAME}.exe`)).find(existsSync);
  return exe ?? null;
}

/**
 * The installed app's own Git (scripts/package-git.cjs), run with only Windows' own folders on
 * PATH, so a Git installed on this machine cannot stand in for it: Git Bash with git and the tools
 * agents use (the sandbox's shell), and `cmd\git.exe` with git-lfs (the host's git). Its output,
 * or null with why.
 */
async function bundledGitRuns(exe) {
  const git = path.join(path.dirname(exe), "resources", "git");
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  env.PATH = [path.join(windows, "System32"), windows].join(";");
  const options = { env, timeout: GIT_RUN_TIMEOUT_MS };
  try {
    const bash = await run(
      path.join(git, "bin", "bash.exe"),
      ["-c", "git --version && command -v grep sed awk tar curl"],
      options,
    );
    const host = await run(path.join(git, "cmd", "git.exe"), ["lfs", "version"], options);
    return { ok: true, detail: `${bash.stdout} ${host.stdout}`.replace(/\s+/g, " ").trim() };
  } catch (error) {
    return { ok: false, detail: String(error.stderr || error.message).trim() };
  }
}

/**
 * Start the installed app as a person does (a copy already open just takes the focus) and wait for
 * main to log that it opened the setup screen. Only meaningful before this machine's sandbox is
 * set up: the CI job runs this before its sandbox setup step, which then exports
 * GENEX_WINDOWS_SANDBOX=ready.
 */
async function opensSandboxSetup(exe) {
  if (process.env.GENEX_WINDOWS_SANDBOX === "ready") return { ok: true, detail: "skipped: the sandbox is set up here" };
  spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
  const logged = await settle(async () => {
    const log = existsSync(STUDIO_LOG) ? readFileSync(STUDIO_LOG, "utf8") : "";
    return SETUP_SCREEN_LOG.test(log) ? log : null;
  });
  if (logged) return { ok: true, detail: "setup screen" };
  const log = existsSync(STUDIO_LOG) ? readFileSync(STUDIO_LOG, "utf8").slice(-1500) : "no studio.log";
  return { ok: false, detail: log };
}

/** Close the copy Setup.exe opened: only processes running from the install folder. */
async function closeInstalledCopies() {
  const script = `Get-Process ${INSTALL_NAME} -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${installDir}\\*' } | Stop-Process -Force`;
  await run("powershell.exe", ["-NoProfile", "-Command", script]).catch(() => {});
}

function printSetupLogs() {
  for (const log of [
    path.join(process.env.LOCALAPPDATA ?? "", "SquirrelTemp", "SquirrelSetup.log"),
    path.join(installDir, "SquirrelSetup.log"),
  ]) {
    if (existsSync(log)) console.log(`--- ${log}\n${readFileSync(log, "utf8").slice(-4000)}`);
  }
}

if (process.platform !== "win32") {
  console.log("the Squirrel install check runs on Windows only");
  process.exit(0);
}

console.log(`installing ${SETUP_EXE}\n  into ${installDir}`);
await run(SETUP_EXE, ["--silent"], { timeout: SETUP_TIMEOUT_MS }).catch((error) => {
  console.log(`Setup.exe: ${error.message}`);
});
const exe = await settle(installedApp);
check("Setup.exe installs the app under %LOCALAPPDATA%\\genex", Boolean(exe), exe ?? "no app-<version>\\genex.exe");
const shortcuts = await settle(async () => {
  const found = await genexShortcuts();
  return found.length ? found : null;
});
check(
  "the install launch makes the Start menu and desktop shortcuts",
  Boolean(shortcuts),
  (shortcuts ?? []).join(", "),
);
const tooLong = (await filesUnder(installDir)).filter((file) => file.length >= MAX_PATH);
check(`every installed path is under ${MAX_PATH} characters`, tooLong.length === 0, tooLong.slice(0, 3).join(", "));
const git = exe ? await bundledGitRuns(exe) : { ok: false, detail: "no installed app" };
check("the app's own Git runs without any other Git on PATH", git.ok, git.detail);
const setup = exe ? await opensSandboxSetup(exe) : { ok: false, detail: "no installed app" };
check("the first start before the sandbox is set up opens the setup screen, not an error", setup.ok, setup.detail);

await closeInstalledCopies();
await run(path.join(installDir, "Update.exe"), ["--uninstall", "-s"], { timeout: SETUP_TIMEOUT_MS }).catch((error) => {
  console.log(`Update.exe --uninstall: ${error.message}`);
});
const removed = await settle(async () => (await genexShortcuts()).length === 0);
check("Update.exe --uninstall removes the shortcuts", removed);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} Squirrel install checks passed`);
if (passed !== results.length) {
  printSetupLogs();
  process.exit(1);
}

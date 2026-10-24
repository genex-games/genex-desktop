/**
 * Install the Windows Squirrel installer the way a person does, then uninstall it (Windows only).
 *
 * Setup.exe unpacks the app into %LOCALAPPDATA%\genex\app-<version>, starts it once with
 * `--squirrel-install` (main makes the Start menu and desktop shortcuts through Update.exe and
 * exits) and then opens it. The checks: the install lands, the shortcuts appear, no installed
 * path reaches MAX_PATH, the app's own Git runs with no other Git on PATH, the first start sets
 * the sandbox up by itself (on a person's PC behind one administrator prompt; the CI machine is
 * elevated, so none shows) and opens the studio with the sandbox running from the installed
 * folder, again with only the app's own Git and again on a profile made to look lived-in (SSH keys,
 * the coding CLIs' homes, a browser profile, thousands of files), printing the folders' DACLs
 * between the profile and the install, and `Update.exe --uninstall` takes the shortcuts away. The copy
 * Setup.exe opens is closed before the uninstall; it runs on the CI machine's own profile.
 *
 *   npm run make -- --platform win32 --arch x64 && node tests/e2e/run-squirrel-install.mjs
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
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
const STUDIO_START_TIMEOUT_MS = 5 * 60_000;
const GIT_RUN_TIMEOUT_MS = 60_000;
/** The installed app's log (main's `userData/logs/studio.log`; userData is named for productName). */
const STUDIO_LOG = path.join(process.env.APPDATA ?? "", "Genex", "logs", "studio.log");
/** What main logs when it opens the setup screen on an unprovisioned sandbox (main/index.ts). */
const STUDIO_READY_LOG = /\[main\] studio ready/;
const STARTUP_FAILED_LOG = /startup failed|sandbox setup failed/;
const FIRST_START_LOG_LINES = 60;
const POLL_MS = 1_000;
/** A lived-in profile's bulk: folders × files, so a walk of the whole profile takes as long as on a PC. */
const BULK_DIRS = 200;
const BULK_FILES = 100;

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
async function settle(probe, timeoutMs = SETTLE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
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
 * Start the installed app as a person does and wait for main to log that the studio is ready: on
 * a machine whose sandbox is not set up, after setting it up by itself. The studio starts its
 * sandbox from the installed folder, under the profile, which the sandbox user cannot open until
 * Genex lets it. The log is read from before Setup.exe ran: the copy Setup.exe starts holds the
 * single-instance lock, so it may be the one that gets there, and a second start only hands over
 * to it. A logged startup or setup failure ends the wait at once.
 */
async function startsTheStudio(exe, from, env = process.env) {
  const newLog = () => (existsSync(STUDIO_LOG) ? readFileSync(STUDIO_LOG, "utf8").slice(from) : "");
  const started = Date.now();
  spawn(exe, [], { detached: true, stdio: "ignore", env }).unref();
  const log = await settle(async () => {
    const text = newLog();
    return STUDIO_READY_LOG.test(text) || STARTUP_FAILED_LOG.test(text) ? text : null;
  }, STUDIO_START_TIMEOUT_MS);
  if (log && STUDIO_READY_LOG.test(log)) {
    // The first start's own timestamped lines, so a slow setup shows which step took the time.
    console.log(log.split("\n").slice(0, FIRST_START_LOG_LINES).join("\n"));
    return { ok: true, detail: `studio ready in ${Math.round((Date.now() - started) / 1000)} s` };
  }
  return { ok: false, detail: (log ?? newLog()).slice(-3000) || "no studio.log" };
}

/** Close the copy Setup.exe opened: only processes running from the install folder. */
async function closeInstalledCopies() {
  const script = `Get-Process ${INSTALL_NAME} -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${installDir}\\*' } | Stop-Process -Force`;
  await run("powershell.exe", ["-NoProfile", "-Command", script]).catch(() => {});
}

/**
 * Make the CI profile look like a person's: the coding CLIs' homes, SSH keys and browser profiles
 * the sandbox denies (srt-win stamps each deny's parent, the profile itself for `.ssh`), and enough
 * files that a walk of the profile takes real time.
 */
async function liveInTheProfile() {
  const home = process.env.USERPROFILE ?? "";
  const local = process.env.LOCALAPPDATA ?? "";
  const files = [
    path.join(home, ".ssh", "known_hosts"),
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".codex", "config.toml"),
    path.join(local, "Google", "Chrome", "User Data", "Local State"),
  ];
  for (const file of files) {
    await mkdir(path.dirname(file), { recursive: true });
    if (!existsSync(file)) await writeFile(file, "{}");
  }
  const bulk = path.join(home, "Documents", "genex-ci-lived-in");
  for (let d = 0; d < BULK_DIRS; d++) {
    const dir = path.join(bulk, `d${d}`);
    await mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: BULK_FILES }, (_, f) => writeFile(path.join(dir, `f${f}.txt`), "x")));
  }
}

/** The DACLs on the folders between the profile and the install, and the grant records, for a failure's reader. */
async function printAccess(exe) {
  const home = process.env.USERPROFILE ?? "";
  const dirs = [home, path.join(home, "AppData"), path.join(home, "AppData", "Local"), installDir];
  if (exe) dirs.push(path.dirname(exe));
  for (const dir of dirs) {
    const out = await run("icacls", [dir]).then(
      (r) => r.stdout,
      (error) => String(error.stdout || error.message),
    );
    console.log(out.trim());
  }
  const holders = path.join(process.env.LOCALAPPDATA ?? "", "genex-sandbox-grants");
  for (const name of await readdir(holders).catch(() => [])) {
    console.log(`${name}: ${readFileSync(path.join(holders, name), "utf8")}`);
  }
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

const logBeforeSetup = existsSync(STUDIO_LOG) ? readFileSync(STUDIO_LOG, "utf8").length : 0;
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
const studio = exe ? await startsTheStudio(exe, logBeforeSetup) : { ok: false, detail: "no installed app" };
check(
  "the first start sets the sandbox up by itself and opens the studio from the installed folder",
  studio.ok,
  studio.detail,
);
await printAccess(exe);

// Again with only the app's own Git, as on a PC without Git: the harness boots from the profile
// through the bundled Git Bash, which the package job's chat turn (from out\) does not cover.
await closeInstalledCopies();
const logBeforeRestart = existsSync(STUDIO_LOG) ? readFileSync(STUDIO_LOG, "utf8").length : 0;
const bundledOnly = { ...process.env, STUDIO_WINDOWS_BUNDLED_GIT_ONLY: "1" };
const again = exe
  ? await startsTheStudio(exe, logBeforeRestart, bundledOnly)
  : { ok: false, detail: "no installed app" };
check("a start with only the app's own Git boots the harness from the installed folder", again.ok, again.detail);
if (!again.ok) await printAccess(exe);

// Again on a profile like a person's, where srt-win's deny stamps reach the profile folder itself.
await closeInstalledCopies();
await liveInTheProfile();
const logBeforeLivedIn = existsSync(STUDIO_LOG) ? readFileSync(STUDIO_LOG, "utf8").length : 0;
const livedIn = exe ? await startsTheStudio(exe, logBeforeLivedIn) : { ok: false, detail: "no installed app" };
await printAccess(exe);
check("a start on a lived-in profile boots the harness from the installed folder", livedIn.ok, livedIn.detail);

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

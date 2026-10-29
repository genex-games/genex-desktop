// Gives a checkout its node_modules from one install per lockfile shared by every worktree of the
// repository, as an APFS copy-on-write clone: a worktree then costs almost nothing on disk, where
// `npm ci` in each one writes 1.4 GB more. Off macOS it runs `npm ci`.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOUR_MS } from "../src/shared/duration.ts";

/** How many lockfiles' installs the shared folder keeps: the current one and the one before. */
const KEPT_INSTALLS = 2;
/** The file in node_modules naming the install it came from. */
const KEY_FILE = ".genex-deps-key";
/** Written last into a shared install, so a half-copied one is never cloned. */
const COMPLETE_FILE = ".complete";

/** How old a half-made shared install must be before it is taken for a crash's leftover. */
const STALE_STAGING_MS = HOUR_MS;
/** A shared install's folder name: a {@link depsKey}. */
const KEY_NAME = /^[0-9a-f]{16}$/;

/** What a dependency install takes in, injectable so a test runs neither npm nor `cp`. */
export interface DepsSteps {
  /** Installs node_modules in a checkout from its lockfile. */
  install: (checkout: string) => void;
  /** Copies a node_modules folder to a new path. */
  clone: (from: string, to: string) => void;
  /** Whether a running program (a dev window's Electron) uses this node_modules. */
  inUse: (modules: string) => boolean;
}

const MESSAGE = {
  inUse: (modules: string) =>
    `A running dev app uses ${modules}; stop it (npm run studio:dev -- stop --profile <id>) and run this again.`,
} as const;

/** What {@link restoreDeps} did: nothing, cloned a shared install, or installed and shared it. */
export const DepsOutcome = { Current: "current", Cloned: "cloned", Installed: "installed" } as const;
export type DepsOutcome = (typeof DepsOutcome)[keyof typeof DepsOutcome];

/** The runtime an install's native packages are built for. */
export interface DepsRuntime {
  platform: string;
  arch: string;
  versions: { modules: string };
}

/** One install's identity: the lockfile and the runtime its native packages were built for. */
export function depsKey(lock: Buffer, runtime: DepsRuntime): string {
  const hash = createHash("sha256")
    .update(lock)
    .update(`${runtime.platform}-${runtime.arch}-${runtime.versions.modules}`);
  return hash.digest("hex").slice(0, 16);
}

/** Removes a checkout's node_modules; a link to another one goes without touching what it points at. */
function removeModules(modules: string): void {
  const stat = fs.lstatSync(modules, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink()) fs.unlinkSync(modules);
  else fs.rmSync(modules, { recursive: true, force: true });
}

/** Copies a checkout's fresh install into the shared folder, unless another checkout got there first. */
function share(modules: string, entry: string, steps: DepsSteps): void {
  const staging = `${entry}.${process.pid}.tmp`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  steps.clone(modules, path.join(staging, "node_modules"));
  fs.writeFileSync(path.join(staging, COMPLETE_FILE), "");
  // A finished install only ever appears by this rename, so one without its mark is a leftover.
  if (!fs.existsSync(path.join(entry, COMPLETE_FILE))) fs.rmSync(entry, { recursive: true, force: true });
  try {
    fs.renameSync(staging, entry);
  } catch {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Keeps the newest shared installs, and removes older ones and the staging a crash left. */
function pruneShared(shared: string, keep: string, now: number): void {
  const entries = fs
    .readdirSync(shared, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== keep)
    .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(shared, e.name)).mtimeMs }));
  const installs = entries.filter((e) => KEY_NAME.test(e.name)).sort((a, b) => b.mtime - a.mtime);
  const stale = entries.filter((e) => !KEY_NAME.test(e.name) && now - e.mtime > STALE_STAGING_MS);
  for (const { name } of [...installs.slice(KEPT_INSTALLS - 1), ...stale])
    fs.rmSync(path.join(shared, name), { recursive: true, force: true });
}

/** The install key a checkout's node_modules carries, or null when it carries none. */
function installedKey(modules: string): string | null {
  try {
    return fs.readFileSync(path.join(modules, KEY_FILE), "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Brings `checkout/node_modules` to the install `key` names: left alone when it already is, else a
 * clone of the shared install, else a fresh install that is then shared for the next checkout.
 */
export function restoreDeps(
  checkout: string,
  shared: string,
  key: string,
  steps: DepsSteps,
  now: number = Date.now(),
): DepsOutcome {
  const modules = path.join(checkout, "node_modules");
  if (installedKey(modules) === key) return DepsOutcome.Current;
  if (steps.inUse(modules)) throw new Error(MESSAGE.inUse(modules));
  fs.mkdirSync(shared, { recursive: true });
  const entry = path.join(shared, key);
  removeModules(modules);
  if (fs.existsSync(path.join(entry, COMPLETE_FILE))) {
    steps.clone(path.join(entry, "node_modules"), modules);
    fs.utimesSync(entry, new Date(now), new Date(now));
    pruneShared(shared, key, now);
    return DepsOutcome.Cloned;
  }
  steps.install(checkout);
  fs.writeFileSync(path.join(modules, KEY_FILE), `${key}\n`);
  share(modules, entry, steps);
  pruneShared(shared, key, now);
  return DepsOutcome.Installed;
}

/** The repository's main checkout: where the shared installs live for all of its worktrees. */
function mainCheckout(checkout: string): string {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: checkout,
    encoding: "utf8",
  }).trim();
  return path.dirname(common);
}

/** `npm ci` in a checkout, its output shown; a failure stops the script. */
function npmInstall(checkout: string): void {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["ci"], { cwd: checkout, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`npm ci failed (${result.status ?? result.signal})`);
}

/** Whether any process's command line runs a program from inside this node_modules. */
function runningFrom(modules: string): boolean {
  const table = execFileSync("ps", ["-axo", "command="], { encoding: "utf8" });
  return table.split("\n").some((line) => line.includes(`${modules}${path.sep}`));
}

/** An APFS clone of a folder: the copy shares the original's blocks until either changes. */
function apfsClone(from: string, to: string): void {
  execFileSync("cp", ["-cR", from, to], { stdio: "inherit" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import("./check-node.mjs");
  const checkout = fs.realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  if (process.platform !== "darwin") npmInstall(checkout);
  else {
    const key = depsKey(fs.readFileSync(path.join(checkout, "package-lock.json")), process);
    const shared = path.join(mainCheckout(checkout), ".studio-dev", "deps");
    const outcome = restoreDeps(checkout, shared, key, { install: npmInstall, clone: apfsClone, inUse: runningFrom });
    console.log(`node_modules ${outcome} (${key})`);
  }
}

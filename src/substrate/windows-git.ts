/** Private Git Bash for Windows first launch. Existing Git is reused; machine PATH is never edited. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MINUTE_MS } from "../shared/duration.ts";
import { download, matches } from "./bonsai/download.ts";
import type { DownloadFile } from "./bonsai/manifest.ts";
import { findGitBash, gitRootOf } from "./windows-sandbox.ts";

const exec = promisify(execFile);
const SETUP_TIMEOUT_MS = 5 * MINUTE_MS;
const VERSION = "2.56.0.2";
const MARKER = "genex-source.json";
/** Immutable official PortableGit release; full Bash, unlike MinGit. Never resolves latest at runtime. */
export const WINDOWS_GIT: Readonly<DownloadFile> = {
  name: `PortableGit-${VERSION}-64-bit.7z.exe`,
  bytes: 60027568,
  sha256: "075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b",
  url: `https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-${VERSION}-64-bit.7z.exe`,
};
const MESSAGE = {
  Unsafe: "Git setup folder crosses a link. Choose a local Genex data folder and retry.",
  Unsupported: "Automatic Git setup currently requires Windows x64.",
  Integrity: "Git download failed its integrity check. Choose Set up to download it again.",
  Incomplete: "Git setup did not finish. Choose Set up to try again.",
} as const;

/** Trusted host seams for first-run tests; none is read from IPC, games or plugin manifests. */
export interface WindowsGitSetup {
  discover?: () => Promise<string | null>;
  fetch?: typeof download;
  extract?: (archive: string, stage: string) => Promise<void>;
  source?: Readonly<DownloadFile>;
  arch?: string;
}

function cachePath(data: string): string {
  return path.resolve(data, "runtime", "git", VERSION);
}

/** Refuse reparse paths before writing, extracting or trusting an executable. */
async function noLinks(file: string): Promise<void> {
  const absolute = path.resolve(file);
  for (let current = absolute; ; current = path.dirname(current)) {
    const entry = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (entry?.isSymbolicLink()) throw new Error(MESSAGE.Unsafe);
    if (path.dirname(current) === current) break;
  }
}

async function complete(root: string, source: Readonly<DownloadFile>): Promise<boolean> {
  await noLinks(root);
  const binaries = [path.join(root, "bin", "bash.exe"), path.join(root, "cmd", "git.exe")];
  for (const binary of binaries) {
    await noLinks(binary);
    if (!(await lstat(binary).catch(() => null))?.isFile()) return false;
  }
  await noLinks(path.join(root, MARKER));
  const marker = await readFile(path.join(root, MARKER), "utf8").catch(() => "");
  return marker === JSON.stringify(source);
}

async function extract(archive: string, stage: string): Promise<void> {
  // Upstream SFX runs its own post-install.bat; unpacking only the 7z payload is insufficient.
  // This pinned SFX extracts beside itself into PortableGit; its current build ignores -o.
  await exec(archive, ["-y", "-gm2"], { timeout: SETUP_TIMEOUT_MS, windowsHide: true });
  const bash = path.join(stage, "bin", "bash.exe");
  await exec(bash, ["--noprofile", "--norc", "-c", "git --version && printf genex-bash-ready"], {
    cwd: stage,
    timeout: SETUP_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, HOME: stage, GIT_CONFIG_GLOBAL: "NUL", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

/** Find an existing Git, or this app's completed private cache; never downloads at ordinary startup. */
export async function windowsGit(data: string, setup: WindowsGitSetup = {}): Promise<string | null> {
  const installed = await (setup.discover ?? findGitBash)();
  if (installed) return gitRootOf(installed);
  const root = cachePath(data);
  return (await complete(root, setup.source ?? WINDOWS_GIT)) ? root : null;
}

/** Make Git available only in Genex's process environment, preserving every existing PATH entry. */
export function activateWindowsGit(root: string, env: NodeJS.ProcessEnv = process.env): void {
  const cmd = path.join(root, "cmd");
  const entries = (env.PATH ?? "").split(path.delimiter);
  if (!entries.some((entry) => entry.toLowerCase() === cmd.toLowerCase()))
    env.PATH = [cmd, ...entries].join(path.delimiter);
}

const installing = new Map<string, Promise<string>>();
/** Fetch, verify and stage the official portable distribution; partial installs never become discoverable. */
export function ensureWindowsGit(data: string, setup: WindowsGitSetup = {}): Promise<string> {
  const root = cachePath(data);
  const running = installing.get(root);
  if (running) return running;
  const result = install(data, setup).finally(() => installing.delete(root));
  installing.set(root, result);
  return result;
}

async function install(data: string, setup: WindowsGitSetup): Promise<string> {
  const existing = await windowsGit(data, setup);
  if (existing) return existing;
  if ((setup.arch ?? process.arch) !== "x64") throw new Error(MESSAGE.Unsupported);
  const root = cachePath(data);
  await noLinks(path.dirname(root));
  await mkdir(path.dirname(root), { recursive: true });
  const parent = await realpath(path.dirname(root));
  const stage = path.join(parent, `stage-${randomUUID()}`);
  const source = setup.source ?? WINDOWS_GIT;
  try {
    await mkdir(stage);
    const archive = await (setup.fetch ?? download)(source, stage, AbortSignal.timeout(SETUP_TIMEOUT_MS), () => {});
    if (!(await matches(archive, source))) throw new Error(MESSAGE.Integrity);
    const extracted = path.join(stage, "PortableGit");
    await (setup.extract ?? extract)(archive, extracted);
    await noLinks(extracted);
    await writeFile(path.join(extracted, MARKER), JSON.stringify(source));
    if (!(await complete(extracted, source))) throw new Error(MESSAGE.Incomplete);
    // An incomplete existing cache is retained for inspection rather than deleted or overwritten.
    await rename(extracted, root);
    return root;
  } finally {
    // Only this invocation's generated stage, beneath a verified real parent, is ever removed.
    await noLinks(stage);
    await rm(stage, { recursive: true, force: true });
  }
}

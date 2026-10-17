/**
 * Remix: a published game's public source becomes a new game of the person's own. Its repository is
 * cloned shallowly over https from Genex's git into a hidden folder in the games folder, its history
 * is dropped (the copy starts its own), and once whole it moves to a free folder of its own and is
 * adopted as a game without trusting the Claude settings or hooks it came with. Nothing of the copy runs while it is made: no hooks, no
 * content filters, and links come out as plain files. Files the game keeps in Git LFS (its models
 * and textures) come next, by the host's git-lfs, from that same repository only. Then its
 * packages are installed the guarded way (no package's scripts, nothing of the copy running while
 * the registry is open), the folder becomes a game, and it is built once so it opens playing.
 * Each step is told as it starts, and the models as they download.
 */
import { type ChildProcess, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MINUTE_MS } from "../../shared/duration.ts";
import { isPlaySlug, type RemixProgress, RemixStep, remixTitle } from "../../shared/play.ts";
import { HOST_GIT_CONFIG, hostGitEnv } from "../../substrate/git-policy.ts";
import type { PlayWorld } from "./gallery.ts";

const exec = promisify(execFile);

/**
 * How long a download (the clone, its Git LFS files) may go without progress before it is given
 * up. A download that keeps moving may take as long as it takes: a big game on a slow line too.
 */
export const DOWNLOAD_STALL_MS = MINUTE_MS;
/** The longest a git step that downloads nothing (listing the LFS files, its version) may take. */
const GIT_LOCAL_TIMEOUT_MS = MINUTE_MS;
/** How many numbered folders are tried before giving up on a free name. */
const MAX_FOLDER_TRIES = 50;
/** The most a clone may print before it is cut off. */
const CLONE_OUTPUT_MAX_BYTES = 1024 * 1024;
/** The only host a remix clones from. */
const GIT_HOST = "git.genex.games";
/**
 * Where a copy is made until it is whole: a hidden folder the library never lists, so half a game
 * is never one. Its name is this prefix, the game's slug and six random hex digits.
 */
const STAGING_PREFIX = ".remix-";
const STAGING_NAME = /^\.remix-[a-z0-9][a-z0-9-]*-[0-9a-f]{6}$/;
/** Random bytes in a hidden folder's name: six hex digits. */
const STAGING_RANDOM_BYTES = 3;
/** How often the models' download is told while git-lfs works. */
const LFS_PROGRESS_TICK_MS = 250;
/** The file in the clone's own `.git` that git-lfs writes its progress to (`GIT_LFS_PROGRESS`). */
const LFS_PROGRESS_FILE = "genex-lfs-progress";
/**
 * The host's git-lfs as the LFS filter, for the pull alone. The host's git runs without the
 * person's own git config, where `git lfs install` put it, and without it git-lfs downloads the
 * files and then leaves their pointers in their place ("Git LFS is not installed").
 */
const LFS_FILTER = [
  "-c",
  "filter.lfs.process=git-lfs filter-process",
  "-c",
  "filter.lfs.smudge=git-lfs smudge -- %f",
  "-c",
  "filter.lfs.clean=git-lfs clean -- %f",
  "-c",
  "filter.lfs.required=true",
] as const;
/** A `git lfs ls-files` line: the object id, `*` when the file is there or `-` for a pointer, the path. */
const LFS_LISTED = /^\S+ ([*-]) (.+)$/;
/** A git-lfs progress line: `download <n>/<of> <bytes>/<size> <name>`. */
const LFS_PROGRESS_LINE = /^download \d+\/\d+ (\d+)\/\d+ (.+)$/;

const MESSAGE = {
  NotRemixable: "This game can’t be remixed",
  NeedsLfs:
    "This game keeps its files in Git LFS. Install git-lfs on this Mac (brew install git-lfs), then remix it again.",
  NoFolder: "There is no free folder for the copy",
  Underway: "Another remix is being made",
  ModelsMissing: (files: number) => `${files} of this game's files didn't download from Git LFS`,
  Stalled: "The download stopped moving",
} as const;

/**
 * Settings a clone runs under, after the host's own: https only (no `ext::` or `file://`
 * transports), no LFS or other content filter, and symbolic links written as plain files.
 */
const CLONE_CONFIG = [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "core.symlinks=false",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.required=false",
  "-c",
  "submodule.recurse=false",
] as const;

/** Whether `url` is a repository on Genex's git, over https, that a remix may clone. */
export function isRemixSource(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === GIT_HOST &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      /^\/[a-z0-9-]+\/[a-z0-9-]+\.git$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/** The git command line that clones `url` into `dest`. */
export function cloneArgs(url: string, dest: string): string[] {
  return [
    ...HOST_GIT_CONFIG,
    ...CLONE_CONFIG,
    "clone",
    // Its progress on stderr is how a stalled clone is told from a slow one.
    "--progress",
    "--depth=1",
    "--single-branch",
    "--no-tags",
    "--no-recurse-submodules",
    "--",
    url,
    dest,
  ];
}

/**
 * The git command line that brings a clone's Git LFS files, run in the clone: from the repository it
 * was cloned from (`lfs.url` set here outranks any `.lfsconfig` in the copy), https only, no hooks.
 */
export function lfsPullArgs(url: string): string[] {
  return [
    ...HOST_GIT_CONFIG,
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    `lfs.url=${url}/info/lfs`,
    ...LFS_FILTER,
    "lfs",
    "pull",
  ];
}

/** The files git-lfs's listing says are still pointers (`-`), not the files themselves (`*`). */
export function lfsPointers(listing: string): string[] {
  return listing.split("\n").flatMap((line) => {
    const match = LFS_LISTED.exec(line.trim());
    return match?.[1] === "-" && match[2] ? [match[2]] : [];
  });
}

/** Whether a clone keeps files in Git LFS: a line of its `.gitattributes` (not a comment) names the lfs filter. */
export async function tracksLfs(dir: string): Promise<boolean> {
  const attributes = await readFile(path.join(dir, ".gitattributes"), "utf8").catch(() => "");
  return attributes
    .split("\n")
    .some((line) => !line.trimStart().startsWith("#") && line.split(/\s+/).includes("filter=lfs"));
}

/** Hears a clone's models download: bytes so far, and their total when it is known. */
export type ModelsProgress = (done: number, total: number | null) => void;

/** Where a remix goes, how each of its steps is done, and who hears about them. */
export interface RemixDeps {
  /** Where new games go. */
  gamesRoot(): string;
  /** Clone `url` into `dest`, an empty folder this remix made; `models` hears its Git LFS download. */
  clone(url: string, dest: string, models: ModelsProgress): Promise<void>;
  /** Install the copy's packages the guarded way. A failure leaves the stage's Install packages. */
  install(dir: string): Promise<void>;
  /** Adopt a folder as a game with this title; answers its library name. */
  adopt(dir: string, title: string): Promise<string>;
  /** Build the new game once, so it opens built. A failure is the stage's to show. */
  build(name: string): Promise<void>;
  /** Hear each step as it starts, and the models as they download. */
  progress(progress: Omit<RemixProgress, "slug">): void;
}

/** Whether an error says the folder is there already. */
const exists = (error: unknown): boolean => (error as { code?: string } | null)?.code === "EEXIST";

/**
 * Claim the first free `<slug>-remix`, `<slug>-remix-2`, … folder in `root` by making it: two
 * remixes at once can never pick the same folder, and the folder is this remix's to remove.
 */
export async function claimFolder(
  root: string,
  slug: string,
  make: (dir: string) => Promise<unknown> = (dir) => mkdir(dir),
): Promise<string> {
  for (let n = 1; n <= MAX_FOLDER_TRIES; n += 1) {
    const candidate = path.join(root, n === 1 ? `${slug}-remix` : `${slug}-remix-${n}`);
    try {
      await make(candidate);
      return candidate;
    } catch (error) {
      if (!exists(error)) throw error;
    }
  }
  throw new Error(MESSAGE.NoFolder);
}

/** Whether a remix is being made: one at a time, so the next may clear what an interrupted one left. */
let underway = false;

/**
 * Make `world` a new game of the person's own; answers its library name. A failed copy leaves
 * nothing behind; packages that would not install or a first build that broke leave the game, and
 * the stage says what is left to do. One remix at a time.
 */
export async function remixGame(world: PlayWorld, deps: RemixDeps): Promise<string> {
  const source = world.cloneUrl;
  if (!world.remixable || !isRemixSource(source) || !isPlaySlug(world.slug)) throw new Error(MESSAGE.NotRemixable);
  if (underway) throw new Error(MESSAGE.Underway);
  underway = true;
  try {
    return await makeRemix(world, source, deps);
  } finally {
    underway = false;
  }
}

/** The remix's steps: the copy of `source` made whole in a hidden folder, moved to its own, adopted, built once. */
async function makeRemix(world: PlayWorld, source: string, deps: RemixDeps): Promise<string> {
  const root = deps.gamesRoot();
  await mkdir(root, { recursive: true });
  await clearStaging(root);
  // Made as any game folder is (`mkdtemp` would make it private, and the game would stay so).
  const work = path.join(root, `${STAGING_PREFIX}${world.slug}-${randomBytes(STAGING_RANDOM_BYTES).toString("hex")}`);
  await mkdir(work);
  const step = (at: RemixStep, done: number | null = null, total: number | null = null, name: string | null = null) =>
    deps.progress({ step: at, done, total, name });
  let dest: string | null = null;
  let name: string;
  try {
    step(RemixStep.Copy);
    await deps.clone(source, work, (done, total) => step(RemixStep.Models, done, total));
    // The copy starts its own history; the author's stays theirs.
    await rm(path.join(work, ".git"), { recursive: true, force: true });
    step(RemixStep.Packages);
    await deps.install(work).catch(() => {});
    dest = await claimFolder(root, world.slug, (dir) => moveInto(work, dir));
    name = await deps.adopt(dest, remixTitle(world.title));
  } catch (error) {
    await rm(dest ?? work, { recursive: true, force: true });
    throw error;
  }
  step(RemixStep.Build, null, null, name);
  await deps.build(name).catch(() => {});
  return name;
}

/** Remove the hidden folders of remixes the app quit in the middle of; only a remix's own name is touched. */
async function clearStaging(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const left = entries.filter((entry) => entry.isDirectory() && STAGING_NAME.test(entry.name));
  await Promise.all(left.map((entry) => rm(path.join(root, entry.name), { recursive: true, force: true })));
}

/**
 * Move the finished copy to `dir`, claimed by making it (a folder already there is `EEXIST`, and
 * the next name is tried). The claimed folder goes again just before the move: Windows renames
 * onto no folder.
 */
async function moveInto(work: string, dir: string): Promise<void> {
  await mkdir(dir);
  await rmdir(dir);
  await rename(work, dir);
}

/** How the host runs git for a remix: its policy's environment and bounded output. */
const GIT_OUTPUT = { windowsHide: true, maxBuffer: CLONE_OUTPUT_MAX_BYTES } as const;
/** A git step that downloads nothing, under a deadline. */
const GIT_LOCAL = { ...GIT_OUTPUT, timeout: GIT_LOCAL_TIMEOUT_MS } as const;

/** The timers a stall is measured with. */
export interface StallClock {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const TIMERS: StallClock = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Gives up on a download that stops moving: `signal` aborts once `moved` has not been called for `stallMs`. */
export function stallGuard(
  clock: StallClock = TIMERS,
  stallMs = DOWNLOAD_STALL_MS,
): { signal: AbortSignal; moved: () => void; stop: () => void } {
  const controller = new AbortController();
  let timer: unknown = null;
  const moved = () => {
    clock.clearTimeout(timer);
    timer = clock.setTimeout(() => controller.abort(), stallMs);
  };
  moved();
  return { signal: controller.signal, moved, stop: () => clock.clearTimeout(timer) };
}

/**
 * Run a git download for as long as it moves: `watch` calls `moved` at each sign of progress and
 * answers how to stop watching; a stall gives the download up.
 */
async function download(
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
  clock: StallClock,
  watch: (moved: () => void, child: ChildProcess) => () => void,
): Promise<void> {
  const guard = stallGuard(clock);
  const running = exec("git", args, { ...GIT_OUTPUT, ...options, signal: guard.signal });
  const unwatch = watch(guard.moved, running.child);
  try {
    await running;
  } catch (error) {
    if (guard.signal.aborted) throw new Error(MESSAGE.Stalled);
    throw error;
  } finally {
    guard.stop();
    unwatch();
  }
}

/** Whatever git prints on stderr is a sign the download moves. */
const onStderr = (moved: () => void, child: ChildProcess) => {
  child.stderr?.on("data", moved);
  return () => child.stderr?.off("data", moved);
};

/**
 * The host's git clone under the host's git policy, then its Git LFS files if it has any. Each
 * download may take as long as it keeps moving ({@link DOWNLOAD_STALL_MS}).
 */
export async function gitClone(
  url: string,
  dest: string,
  models: ModelsProgress = () => {},
  clock: StallClock = TIMERS,
): Promise<void> {
  if (!isRemixSource(url)) throw new Error(MESSAGE.NotRemixable);
  await download(cloneArgs(url, dest), { env: hostGitEnv({ GIT_LFS_SKIP_SMUDGE: "1" }) }, clock, onStderr);
  if (!(await tracksLfs(dest))) return;
  const lfs = await exec("git", ["lfs", "version"], { ...GIT_LOCAL, env: hostGitEnv() }).catch(() => null);
  if (!lfs) throw new Error(MESSAGE.NeedsLfs);
  const total = await lfsTotal(dest);
  models(0, total);
  const file = path.join(dest, ".git", LFS_PROGRESS_FILE);
  let done = 0;
  let seen = 0;
  // A read still under way when the pull ends tells nothing: the next step has begun.
  let pulled = false;
  const tell = async (moved: () => void) => {
    const progress = await readFile(file, "utf8").catch(() => "");
    if (pulled) return;
    // Any new line moves the download along: a file's bytes, or one checked out.
    if (progress.length !== seen) moved();
    seen = progress.length;
    const now = lfsDownloaded(progress);
    if (now === done) return;
    done = now;
    models(done, total);
  };
  await download(
    lfsPullArgs(url),
    { cwd: dest, env: hostGitEnv({ GIT_LFS_PROGRESS: file }) },
    clock,
    (moved, child) => {
      const ticker = setInterval(() => void tell(moved), LFS_PROGRESS_TICK_MS);
      const unwatch = onStderr(moved, child);
      return () => {
        pulled = true;
        clearInterval(ticker);
        unwatch();
      };
    },
  );
  const listed = await exec("git", [...HOST_GIT_CONFIG, "lfs", "ls-files"], {
    ...GIT_LOCAL,
    cwd: dest,
    env: hostGitEnv(),
  });
  const pointers = lfsPointers(listed.stdout);
  if (pointers.length) throw new Error(MESSAGE.ModelsMissing(pointers.length));
  models(total ?? done, total);
}

/**
 * A tagged game's code as a read-only reference: the clone alone, its Git LFS files left as
 * pointers, because an agent reads the code and a reference never ships. It may take as long as
 * it keeps moving ({@link DOWNLOAD_STALL_MS}).
 */
export async function gitCloneCode(url: string, dest: string, clock: StallClock = TIMERS): Promise<void> {
  if (!isRemixSource(url)) throw new Error(MESSAGE.NotRemixable);
  await download(cloneArgs(url, dest), { env: hostGitEnv({ GIT_LFS_SKIP_SMUDGE: "1" }) }, clock, onStderr);
}

/** The bytes a clone's Git LFS files come to, from git-lfs's own listing; null when it cannot say. */
async function lfsTotal(dir: string): Promise<number | null> {
  const listed = await exec("git", [...HOST_GIT_CONFIG, "lfs", "ls-files", "--json"], {
    ...GIT_LOCAL,
    cwd: dir,
    env: hostGitEnv(),
  }).catch(() => null);
  if (!listed) return null;
  try {
    const files = (JSON.parse(listed.stdout) as { files?: Array<{ size?: unknown }> }).files ?? [];
    return files.reduce((sum, file) => sum + (typeof file.size === "number" ? file.size : 0), 0);
  } catch {
    return null;
  }
}

/** The bytes downloaded so far by git-lfs's progress lines: each file's latest count, summed. */
export function lfsDownloaded(progress: string): number {
  const latest = new Map<string, number>();
  for (const line of progress.split("\n")) {
    const match = LFS_PROGRESS_LINE.exec(line.trim());
    if (match?.[1] && match[2]) latest.set(match[2], Number(match[1]));
  }
  return [...latest.values()].reduce((sum, bytes) => sum + bytes, 0);
}

/** A fixture launch's clone: a one-page stand-in game, so a remix can be followed with no network. */
export async function fixtureClone(url: string, dest: string, _models?: ModelsProgress): Promise<void> {
  if (!isRemixSource(url)) throw new Error(MESSAGE.NotRemixable);
  await mkdir(dest, { recursive: true });
  const name = path.basename(new URL(url).pathname, ".git");
  await writeFile(
    path.join(dest, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><h1>${name}</h1></body></html>\n`,
  );
}

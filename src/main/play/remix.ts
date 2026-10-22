/**
 * Remix: a published game's public source becomes a new game of the person's own. Its repository is
 * cloned shallowly over https from Genex's git into a hidden folder in the games folder, its history
 * is dropped (the copy starts its own), and once whole it moves to a free folder of its own and is
 * adopted as a game without trusting the Claude settings or hooks it came with. Nothing of the copy runs while it is made: no hooks, no
 * content filters, and links come out as plain files. Files the game keeps in Git LFS (its models
 * and textures) come next over https from that same repository, each checked against its pointer,
 * with no git-lfs needed (`lfs.ts`). Then its packages are installed the guarded way (no
 * package's scripts, nothing of the copy running while the registry is open), the folder becomes a
 * game, and it is built once so it opens playing. Each step is told as it starts, and the models
 * as they download; a remix that fails says why in the log.
 */
import { type ChildProcess, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MINUTE_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { isPlaySlug, PlayRemixRefusal, type RemixProgress, RemixStep, remixTitle } from "../../shared/play.ts";
import { HOST_GIT_CONFIG, hostGitEnv } from "../../substrate/git-policy.ts";
import { ENGINE_PROJECT_DEPTH, sourceHoldsGame } from "./game-source.ts";
import type { PlayWorld } from "./gallery.ts";
import { downloadLfsFiles, type LfsDownloadDeps } from "./lfs.ts";

const exec = promisify(execFile);

/**
 * How long a download (the clone, its Git LFS files) may go without progress before it is given
 * up. A download that keeps moving may take as long as it takes: a big game on a slow line too.
 */
export const DOWNLOAD_STALL_MS = MINUTE_MS;
/** How many numbered folders are tried before giving up on a free name. */
const MAX_FOLDER_TRIES = 50;
/** The most a clone may print before it is cut off. */
const CLONE_OUTPUT_MAX_BYTES = 1024 * 1024;
/** The most git may print when it says which files are in Git LFS: a line per pointer. */
const CHECK_ATTR_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
/** How long git may take to say which files are in Git LFS. */
const CHECK_ATTR_TIMEOUT_MS = MINUTE_MS;
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
/** The most entries the look for a game's marks reads. */
const ENGINE_LOOK_ENTRIES_MAX = 5_000;

const MESSAGE = {
  NotRemixable: "This game can’t be remixed",
  NoFolder: "There is no free folder for the copy",
  Underway: "Another remix is being made",
  Stalled: "The download stopped moving",
  NoProject: "The game's source holds no game: its creator hasn't shared its project",
} as const;

/** A remix refused before anything was made, with the code the renderer says it by. */
export class RemixRefusedError extends Error {
  readonly code: PlayRemixRefusal;
  constructor(code: PlayRemixRefusal, message: string) {
    super(message);
    this.name = "RemixRefusedError";
    this.code = code;
  }
}

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

/** Whether a clone keeps files in Git LFS: a line of its `.gitattributes` (not a comment) names the lfs filter. */
export async function tracksLfs(dir: string): Promise<boolean> {
  const attributes = await readFile(path.join(dir, ".gitattributes"), "utf8").catch(() => "");
  return attributes
    .split("\n")
    .some((line) => !line.trimStart().startsWith("#") && line.split(/\s+/).includes("filter=lfs"));
}

/**
 * Which of `files` (paths in the clone at `dir`) the clone's attributes route through Git LFS
 * (`filter=lfs`), as git-lfs reads them: the host's git answers from the clone's own
 * `.gitattributes` files, nested ones included, never from the person's git config.
 */
export function lfsRoutedFiles(dir: string, files: string[]): Promise<Set<string>> {
  if (files.length === 0) return Promise.resolve(new Set());
  // Git names paths with `/` on every system; the answer is mapped back to the caller's own.
  const byGitPath = new Map(files.map((file) => [file.split(path.sep).join("/"), file]));
  const options = {
    cwd: dir,
    env: hostGitEnv(),
    windowsHide: true,
    maxBuffer: CHECK_ATTR_OUTPUT_MAX_BYTES,
    timeout: CHECK_ATTR_TIMEOUT_MS,
    encoding: "utf8",
  } as const;
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...HOST_GIT_CONFIG, "check-attr", "-z", "--stdin", "filter"],
      options,
      (error, stdout) => {
        if (error) reject(error);
        else resolve(routedIn(stdout, byGitPath));
      },
    );
    // Git that exits before reading every path (no repository, a crash) closes its input: the write's
    // EPIPE is this call's failure, never an uncaught error.
    child.stdin?.on("error", reject);
    child.stdin?.end(`${[...byGitPath.keys()].join("\0")}\0`);
  });
}

/** The files a `git check-attr -z filter` listing (path, attribute, value, each NUL-ended) names `lfs`. */
function routedIn(listing: string, byGitPath: Map<string, string>): Set<string> {
  const fields = listing.split("\0");
  const routed = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const file = byGitPath.get(fields[index] ?? "");
    if (file && fields[index + 2] === "lfs") routed.add(file);
  }
  return routed;
}

/** Folders never looked in for a game's marks: hidden ones and installed packages. */
const passedOver = (name: string): boolean => name.startsWith(".") || name === "node_modules";

/** One folder's files (relative, `/` between parts) and the folders under it to look in next; links are never followed. */
async function folderEntries(dir: string, rel: string): Promise<{ files: string[]; folders: string[]; read: number }> {
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
  const at = (name: string) => (rel ? `${rel}/${name}` : name);
  return {
    files: entries.filter((entry) => entry.isFile()).map((entry) => at(entry.name)),
    folders: entries.filter((entry) => entry.isDirectory() && !passedOver(entry.name)).map((entry) => at(entry.name)),
    read: entries.length,
  };
}

/**
 * The files of `dir` a few folders deep (`ENGINE_PROJECT_DEPTH`), `/` between parts: enough to
 * find a game's marks. The look reads a bounded number of entries.
 */
async function topFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let seen = 0;
  let level: string[] = [""];
  for (let depth = 0; depth <= ENGINE_PROJECT_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const rel of level) {
      const found = await folderEntries(dir, rel);
      seen += found.read;
      if (seen > ENGINE_LOOK_ENTRIES_MAX) return files;
      files.push(...found.files);
      next.push(...found.folders);
    }
    level = next;
  }
  return files;
}

/**
 * Whether a copy holds a game (`game-source.ts`): a Genex game's record, a page at its root,
 * packages that build it, or an engine's project. Such a source with none of these is what a game
 * whose creator never shared its project has on Genex.
 */
export async function holdsGame(dir: string): Promise<boolean> {
  const files = await topFiles(dir);
  const packageJson = files.includes("package.json")
    ? await readFile(path.join(dir, "package.json"), "utf8").catch(() => null)
    : null;
  return sourceHoldsGame(files, packageJson);
}

/**
 * Make the copy's `studio.json` the remix's own: what kind of game it is stays (its scaffold, engine,
 * shape), under the remix's title and its own date, without the author's name for it; adoption keeps
 * a record that is there, so the remix would otherwise list under the author's title. A record that
 * is not a JSON object is left as it is.
 */
async function ownRecord(dir: string, title: string): Promise<void> {
  const file = path.join(dir, "studio.json");
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return;
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) return;
  const { name: _name, title: _title, createdAt: _createdAt, ...kind } = record as Record<string, unknown>;
  await writeFile(file, `${JSON.stringify({ ...kind, title, createdAt: new Date().toISOString() }, null, 2)}\n`);
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
  /** Write a line to the app's log: why a remix failed, which the person's toast does not say. */
  log(message: string): void;
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
  } catch (error) {
    deps.log(`remix of ${world.slug} failed: ${errorMessage(error)}`);
    throw error;
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
    if (!(await holdsGame(work))) throw new RemixRefusedError(PlayRemixRefusal.NoProject, MESSAGE.NoProject);
    await ownRecord(work, remixTitle(world.title));
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
 * The host's git clone under the host's git policy, then its Git LFS files over https if it has
 * any, with no git-lfs needed. Each download may take as long as it keeps moving
 * ({@link DOWNLOAD_STALL_MS}).
 */
export async function gitClone(
  url: string,
  dest: string,
  models: ModelsProgress = () => {},
  clock: StallClock = TIMERS,
  fetch: LfsDownloadDeps["fetch"] = globalThis.fetch,
): Promise<void> {
  if (!isRemixSource(url)) throw new Error(MESSAGE.NotRemixable);
  await download(cloneArgs(url, dest), { env: hostGitEnv({ GIT_LFS_SKIP_SMUDGE: "1" }) }, clock, onStderr);
  if (!(await tracksLfs(dest))) return;
  await downloadLfsFiles(dest, url, {
    fetch,
    models,
    guard: () => stallGuard(clock),
    routed: (files) => lfsRoutedFiles(dest, files),
  });
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

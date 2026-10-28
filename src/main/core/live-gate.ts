/**
 * Live stays still while the person watches it. Only the person's own action loads the live view:
 * opening a game, Reload, Play or Make live, a build they asked the chat to show while Live is out of
 * their sight (`PreviewService.liveOutOfSight`), and one more: a Unity or Godot game's web build that
 * appeared or was built again since Live loaded the game, which is the engine's own output, never
 * edited (`PreviewService.offerLive`). Anything else
 * that used to change it — the harness loading the game or a run's build, a builder's checkpoint,
 * a run landing, a rewind — is offered here instead: Live is marked behind, and the stage's
 * Reload says why and applies it (docs/product/builds-live.md).
 */
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { LiveBehindReason, type LiveBehindEvent } from "../../shared/live-behind.ts";
import { CoreFact } from "../../shared/project-facts.ts";
import { gitOrNull } from "../../substrate/snapshots.ts";

/** The most uncommitted paths a folder's print reads the size and time of; past this it counts them. */
const PRINT_MAX_PATHS = 400;
/** The most files of a web build its print reads the size and time of, and how deep it looks. */
const BUILD_PRINT_MAX_FILES = 400;
const BUILD_PRINT_MAX_DEPTH = 4;

/** What Live's Reload would load: the game folder, or a run's build by its commit (its folder may be gone by then). */
export interface LiveWaiting {
  project: string;
  reason: LiveBehindReason;
  /** The build's folder, when it is not the game folder. */
  root: string | null;
  commit: string | null;
  note: string | null;
}

/** Something that would have changed Live: a folder the harness loaded, a checkpoint, a landing, a build to show. */
export interface LiveOffer {
  project: string;
  /** Null (or the game folder itself) for the game folder, unless `commit` names a build. */
  root: string | null;
  /** A build by its checked commit, whose folder the host makes when Reload plays it (`showBuild`). */
  commit?: string | null;
  note?: string | null;
}

/** A load of Live the person made: the game folder's print, or the build's folder, whose commit Live now shows. */
export interface LiveLoad {
  /** The game folder's print before the load; undefined when Live loaded something else. */
  print: string | null | undefined;
  /** The folder Live loaded when it is not the game folder: a build's worktree, a snapshot's copy. */
  root: string | null;
}

/** What the gate reads of the studio. */
export interface LiveGateDeps {
  emit(event: LiveBehindEvent): void;
  gameDir(project: string): string;
  /** What the live view last served. */
  showing(): { project: string; root: string | null } | undefined;
  /** The commit Live shows, when the studio knows it. */
  showingHead(project: string): string | null;
}

/** The paths `git status --porcelain -z` lists: a rename or copy carries its source as the next entry. */
function changedPaths(status: string): string[] {
  const tokens = status.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    paths.push(token.slice(3));
    if (token.startsWith("R") || token.startsWith("C")) i++;
  }
  return paths;
}

/**
 * A folder's state as far as the preview cares: its commit, what git says is uncommitted, and the
 * size and time of each such path. Null when git cannot read it, which the gate reads as changed.
 * `--no-optional-locks`: a look never rewrites the person's index.
 */
export async function folderPrint(dir: string): Promise<string | null> {
  const head = await gitOrNull(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const status = await gitOrNull(dir, ["--no-optional-locks", "status", "--porcelain=v1", "-z"]);
  if (status === null) return null;
  const hash = createHash("sha1")
    .update(head ?? "")
    .update("\0")
    .update(status);
  const paths = changedPaths(status);
  for (const entry of paths.slice(0, PRINT_MAX_PATHS)) {
    const stat = await lstat(path.join(dir, entry)).catch(() => null);
    hash.update(`\0${entry}:${stat ? `${stat.size}:${stat.mtimeMs}` : "gone"}`);
  }
  hash.update(`\0${paths.length}`);
  return hash.digest("hex");
}

/** A web build's files below `dir`, by path relative to it, sorted; links are never followed. */
async function buildFiles(dir: string, rel = "", depth = 0): Promise<string[]> {
  if (depth > BUILD_PRINT_MAX_DEPTH) return [];
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const at = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isFile()) files.push(at);
    else if (entry.isDirectory()) files.push(...(await buildFiles(dir, at, depth + 1)));
    if (files.length >= BUILD_PRINT_MAX_FILES) break;
  }
  return files;
}

/** A web build as Live reads it: its files' print, which files it has, and when the newest was written. */
export interface BuildFiles {
  print: string;
  files: ReadonlySet<string>;
  newestMs: number;
}

/**
 * A web build's state as far as Live cares: each of its files' path, size and time, read without
 * git, which may ignore an engine's build. Null when the folder can't be read.
 */
export async function readBuild(dir: string): Promise<BuildFiles | null> {
  const files = await buildFiles(dir).catch(() => null);
  if (files === null) return null;
  const hash = createHash("sha1");
  let newestMs = 0;
  for (const file of files) {
    const stat = await lstat(path.join(dir, file)).catch(() => null);
    newestMs = Math.max(newestMs, stat?.mtimeMs ?? 0);
    hash.update(`${file}:${stat ? `${stat.size}:${stat.mtimeMs}` : "gone"}\0`);
  }
  return { print: hash.digest("hex"), files: new Set(files), newestMs };
}

/** The endings Unity gives a build file: as written, or packed by Brotli, gzip or its own fallback. */
const UNITY_PACKINGS = ["", ".br", ".gz", ".unityweb"] as const;
/** The parts of a Unity WebGL build beside its `Build/<name>.loader.js`. */
const UNITY_PARTS = [".data", ".framework.js", ".wasm"] as const;
const UNITY_LOADER = /^Build\/([^/]+)\.loader\.js$/;

/** Whether a Unity WebGL build holds its loader and every part it loads. */
function unityBuildWhole(files: ReadonlySet<string>): boolean {
  const name = [...files].map((file) => UNITY_LOADER.exec(file)?.[1]).find((found) => found !== undefined);
  if (name === undefined) return false;
  const has = (part: string) => UNITY_PACKINGS.some((packing) => files.has(`Build/${name}${part}${packing}`));
  return UNITY_PARTS.every(has);
}

/** Whether a Godot web export holds its game pack and its engine. */
const godotBuildWhole = (files: ReadonlySet<string>): boolean => files.has("index.pck") && files.has("index.wasm");

/** How each engine's finished web build is told, by the kind of the game's project. */
const WHOLE_BUILD: Readonly<Record<string, (files: ReadonlySet<string>) => boolean>> = {
  [CoreFact.UnityProject]: unityBuildWhole,
  [CoreFact.GodotProject]: godotBuildWhole,
};

/** How long a web build's newest file must be left alone before Live takes the build as finished. */
export const BUILD_SETTLE_MS = 2 * SECOND_MS;

/**
 * Whether a web build is finished: whole for the engine of one of the game's `kinds`, and no file of
 * it written in the last `BUILD_SETTLE_MS` before `now` (an export still writing is never loaded).
 */
export function buildFinished(build: BuildFiles, kinds: readonly string[], now: number): boolean {
  const whole = kinds.some((kind) => WHOLE_BUILD[kind]?.(build.files) === true);
  return whole && now - build.newestMs >= BUILD_SETTLE_MS;
}

/** A folder's checked-out commit, or null when git cannot say. */
async function headOf(dir: string): Promise<string | null> {
  return (await gitOrNull(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim() || null;
}

/** Whether two paths name one folder, links resolved. */
async function sameFolder(a: string, b: string): Promise<boolean> {
  if (path.resolve(a) === path.resolve(b)) return true;
  const [left, right] = await Promise.all([realpath(a).catch(() => null), realpath(b).catch(() => null)]);
  return left !== null && left === right;
}

/** The waiting change, the game folder as Live last loaded it, and the build Live shows. */
export class LiveGate {
  readonly #deps: LiveGateDeps;
  #waiting: LiveWaiting | null = null;
  /** The game folder's print when Live last loaded it. */
  #loadedFolder: { project: string; print: string | null } | null = null;
  /** The game Live last loaded, and the build it shows by commit (null: its folder, or not known). */
  #shows: { project: string; commit: string | null } | null = null;

  constructor(deps: LiveGateDeps) {
    this.#deps = deps;
  }

  /** What Reload would apply, if anything waits. */
  get waiting(): LiveWaiting | null {
    return this.#waiting;
  }

  /** What the stage reads for a game (on mount, and in each `live.behind`): what waits for Reload, and the build Live shows. */
  state(project: string): LiveBehindEvent {
    const waiting = this.#waiting?.project === project ? this.#waiting : null;
    return {
      project,
      reason: waiting?.reason ?? null,
      commit: waiting?.commit ?? null,
      note: waiting?.note ?? null,
      shows: this.#showsOf(project),
    };
  }

  /** The print to record for a live load, taken before it starts: a change during the load stays a change. */
  async printBefore(project: string, root: string | null): Promise<string | null | undefined> {
    const dir = this.#deps.gameDir(project);
    if (root !== null && !(await sameFolder(root, dir))) return undefined;
    return folderPrint(dir);
  }

  /**
   * The person's own load reached Live (called once it has loaded, never before): nothing waits any
   * more, a folder load records its print, and the stage hears the build Live shows (its folder's
   * commit) when that changed, whichever path loaded it (Play in Builds, the morning card, a
   * review, Reload).
   */
  async loaded(project: string, load: LiveLoad): Promise<void> {
    const shows = load.print === undefined && load.root !== null ? await headOf(load.root) : null;
    if (load.print !== undefined) this.#loadedFolder = { project, print: load.print };
    const moved = this.#showsOf(project) !== shows;
    this.#shows = { project, commit: shows };
    const was = this.#waiting;
    this.#waiting = null;
    if (was && was.project !== project) this.#emit(was.project);
    if (moved || was?.project === project) this.#emit(project);
  }

  /** Nothing waits for Live. */
  clear(): void {
    const was = this.#waiting;
    if (!was) return;
    this.#waiting = null;
    this.#emit(was.project);
  }

  /** The build Live shows of this game, by commit; null for its folder, or when Live is on another game. */
  #showsOf(project: string): string | null {
    return this.#shows?.project === project ? this.#shows.commit : null;
  }

  /** Live already shows this build of the game, as the gate recorded it or as the stage identified it. */
  #showsBuild(project: string, commit: string): boolean {
    return commit === this.#showsOf(project) || commit === this.#deps.showingHead(project);
  }

  #emit(project: string): void {
    this.#deps.emit(this.state(project));
  }

  /**
   * Something would have changed Live. For the game on the stage, a folder that moved since Live
   * loaded it, or a build Live is not showing, waits for Reload; anything else is not Live's.
   */
  async offer(offer: LiveOffer): Promise<void> {
    const showing = this.#deps.showing();
    if (showing?.project !== offer.project) return;
    const dir = this.#deps.gameDir(offer.project);
    const folder = !offer.commit && (offer.root === null || (await sameFolder(offer.root, dir)));
    if (folder) return this.#offerFolder(offer.project, dir, offer.note ?? null);
    // A build named by commit needs no folder: Reload makes one (`showBuild`).
    const root = offer.commit ? null : (offer.root ?? dir);
    const commit = offer.commit ?? (root ? await headOf(root) : null);
    if (commit !== null && this.#showsBuild(offer.project, commit)) return;
    this.#wait({ project: offer.project, reason: LiveBehindReason.Build, root, commit, note: offer.note ?? null });
  }

  async #offerFolder(project: string, dir: string, note: string | null): Promise<void> {
    const print = await folderPrint(dir);
    const loaded = this.#loadedFolder;
    const unchanged = loaded?.project === project && loaded.print !== null && loaded.print === print;
    if (unchanged) {
      // The folder is back as Live has it (a rewind undid the change): nothing waits.
      if (this.#waiting?.reason === LiveBehindReason.Changed) this.clear();
      return;
    }
    const kept = this.#waiting?.reason === LiveBehindReason.Changed ? this.#waiting.note : null;
    this.#wait({ project, reason: LiveBehindReason.Changed, root: null, commit: null, note: note || kept });
  }

  #wait(waiting: LiveWaiting): void {
    this.#waiting = waiting;
    this.#emit(waiting.project);
  }
}

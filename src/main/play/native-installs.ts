/**
 * Play's native installs: a game built in an engine downloaded, checked and unpacked into Genex's
 * own folder, never the person's games and never a folder an agent writes. One install runs at a
 * time and the rest wait; leaving the page does not stop one. Each game keeps
 * `<root>/<slug>/<version>/` (the app, read-only to the game) beside `<root>/<slug>/saves/` (its
 * home), and `<root>/index.json` lists what is installed. Removing a game keeps its saves.
 * Electron-free: the catalog read, the fetch, the tools and the push to the window are deps.
 */
import { lstat, mkdir, mkdtemp, readdir, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { isPlaySlug, type PlayGameDetail } from "../../shared/play.ts";
import {
  buildFor,
  type InstalledGame,
  InstallFailure,
  InstallPhase,
  type InstallProgress,
  isNativeArch,
  isNativePlatform,
  NativeArch,
  type NativeBuild,
  type NativeHost,
  type NativeInstalls,
  NativePlatform,
} from "../../shared/play-native.ts";
import { atomicWriteJson, readJsonIfExists } from "../../substrate/fsx.ts";
import { diskBytes, removeOwnedFolder } from "../../substrate/storage-folders.ts";
import { downloadArchive, InstallError, verifyArchive } from "./native-download.ts";
import { type ToolRun, type UnpackedApp, unpackLinuxBuild, unpackMacBuild } from "./native-unpack.ts";
import type { StallClock } from "./remix.ts";

/** Free space kept beyond the download and the unpacked game. */
export const INSTALL_RESERVE_BYTES = 1024 ** 3;
/** The least time between two progress pushes of one download. */
const PROGRESS_EVERY_MS = SECOND_MS / 4;
/** The folders the installer keeps beside the games: partial downloads, unpacking, and what is being thrown away. */
const DOWNLOADS = ".downloads";
const INCOMING = ".incoming-";
const TRASH = ".trash-";
/** Each game's saves folder, kept across versions and removals. */
export const SAVES = "saves";
const INDEX = "index.json";
const INDEX_VERSION = 1;

const MESSAGE = {
  BadSlug: "not a game address",
  Playing: "quit the game before removing it",
} as const;

/** What the launcher needs of an installed game: where it is and what it is called. */
export interface InstallRecord extends InstalledGame, UnpackedApp {
  /** The app's folder inside the version folder: the bundle (`Dust Runners.app`), or `.` on Linux. */
  entry: string;
  /** The engine the catalog says it was made with (`unity`), or null: how the launcher opens it full screen. */
  engine: string | null;
}

/** How an install ended, for notifications. */
export interface InstallOutcome {
  slug: string;
  title: string;
  version: string;
  platform: NativePlatform;
  /** Null when it is ready to play. */
  failure: InstallFailure | null;
  /** The space the download and the game take together: what a full disk must free. */
  neededBytes: number;
}

/** What the installer works with. */
export interface NativeInstallDeps {
  /** Genex's own folder for installed games (`StudioLayout.installedGames`). */
  root: string;
  host: NativeHost;
  /** The build hosts a download may reach. */
  hosts: ReadonlySet<string>;
  /** A game's own page from the catalog: its builds, title and cover. */
  game(slug: string): Promise<PlayGameDetail>;
  fetch: typeof fetch;
  run: ToolRun;
  /** Free bytes on the disk holding `dir`; the system's by default. */
  freeBytes?(dir: string): Promise<number>;
  now(): number;
  /** Every change, for the window. */
  publish(state: NativeInstalls): void;
  /** An install finished or failed. */
  outcome?(outcome: InstallOutcome): void;
  /** Whether a game is running now: its installed version stays until it quits. */
  inUse?(slug: string): boolean;
  stallClock?: StallClock;
  stallMs?: number;
}

/** The index on disk. */
interface InstallIndex {
  version: number;
  games: Record<string, InstallRecord>;
}

/** One install waiting or running. */
interface Job {
  slug: string;
  game: PlayGameDetail;
  build: NativeBuild;
  stop: AbortController;
}

/** The free bytes on the disk holding `dir`. */
async function systemFreeBytes(dir: string): Promise<number> {
  const disk = await statfs(dir);
  return disk.bavail * disk.bsize;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const STRING_FIELDS = ["title", "version", "entry", "executable", "bundleId", "bundleName", "installedAt"] as const;
/** A Genex project id as the API hands them out: letters and digits, never a path. */
const PROJECT_ID = /^[A-Za-z0-9]{1,64}$/;

/** One index record as the installer wrote it, or null when anything in it is off. */
function readRecord(slug: string, value: unknown): InstallRecord | null {
  if (!isPlaySlug(slug) || !isRecord(value) || value.slug !== slug) return null;
  if (!STRING_FIELDS.every((field) => typeof value[field] === "string" && value[field] !== "")) return null;
  const { platform, arch, bytes, coverUrl, lastPlayedAt, identityProject } = value;
  if (!isNativePlatform(platform) || !isNativeArch(arch)) return null;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  return {
    slug,
    title: String(value.title),
    coverUrl: typeof coverUrl === "string" ? coverUrl : null,
    version: String(value.version),
    platform,
    arch,
    bytes,
    installedAt: String(value.installedAt),
    lastPlayedAt: typeof lastPlayedAt === "string" ? lastPlayedAt : null,
    entry: String(value.entry),
    executable: String(value.executable),
    bundleId: String(value.bundleId),
    bundleName: String(value.bundleName),
    // A record from before these were kept: an engine nobody named, and full screen.
    engine: typeof value.engine === "string" ? value.engine : null,
    windowed: value.windowed === true,
    ...(typeof identityProject === "string" && PROJECT_ID.test(identityProject) ? { identityProject } : {}),
  };
}

/** An index read from disk, keeping only records that are well formed. */
function readIndex(value: unknown): InstallIndex {
  const games: Record<string, InstallRecord> = {};
  const raw = isRecord(value) && isRecord(value.games) ? value.games : {};
  for (const [slug, entry] of Object.entries(raw)) {
    const record = readRecord(slug, entry);
    if (record) games[slug] = record;
  }
  return { version: INDEX_VERSION, games };
}

/** The installed game as Play shows it: the record without the launcher's own fields. */
function shownGame(record: InstallRecord): InstalledGame {
  const { slug, title, coverUrl, version, platform, arch, bytes, installedAt, lastPlayedAt, identityProject } = record;
  const shown = { slug, title, coverUrl, version, platform, arch, bytes, installedAt, lastPlayedAt };
  return identityProject ? { ...shown, identityProject } : shown;
}

/**
 * The installer over `deps`: one install at a time, the rest queued, every change published. Each
 * method is one step of the life of an install; the index is read once and written one write after
 * another.
 */
export class NativeInstaller {
  readonly folder: string;
  readonly #deps: NativeInstallDeps;
  readonly #freeBytes: (dir: string) => Promise<number>;
  readonly #progress = new Map<string, InstallProgress>();
  readonly #queue: Job[] = [];
  #running: Job | null = null;
  #index: InstallIndex | null = null;
  #writes: Promise<void> = Promise.resolve();
  #drained: Promise<void> = Promise.resolve();
  #lastPush = Number.NEGATIVE_INFINITY;

  constructor(deps: NativeInstallDeps) {
    this.#deps = deps;
    this.folder = deps.root;
    this.#freeBytes = deps.freeBytes ?? systemFreeBytes;
  }

  async #indexNow(): Promise<InstallIndex> {
    this.#index ??= readIndex(await readJsonIfExists(path.join(this.folder, INDEX)).catch(() => null));
    return this.#index;
  }

  /** Change the index and write it, one write after another. */
  async #changeIndex(change: (games: Record<string, InstallRecord>) => void): Promise<void> {
    const current = await this.#indexNow();
    change(current.games);
    this.#writes = this.#writes.then(async () => {
      await mkdir(this.folder, { recursive: true });
      await atomicWriteJson(path.join(this.folder, INDEX), current);
    });
    await this.#writes;
  }

  /** Every installed game and every install under way or failed. */
  async state(): Promise<NativeInstalls> {
    const games = Object.values((await this.#indexNow()).games);
    return { installed: games.map(shownGame), progress: [...this.#progress.values()], host: this.#deps.host };
  }

  async #push(): Promise<void> {
    this.#lastPush = this.#deps.now();
    this.#deps.publish(await this.state());
  }

  #setProgress(job: Pick<Job, "slug" | "build">, change: Partial<InstallProgress>): void {
    const before = this.#progress.get(job.slug);
    this.#progress.set(job.slug, {
      slug: job.slug,
      version: job.build.version,
      phase: InstallPhase.Queued,
      receivedBytes: before?.receivedBytes ?? 0,
      totalBytes: job.build.sizeBytes,
      etaMs: null,
      failure: null,
      ...change,
    });
  }

  /** Tell how an install ended. */
  #tell(job: Pick<Job, "slug" | "build" | "game">, failure: InstallFailure | null): void {
    const { slug, game, build } = job;
    const neededBytes = build.sizeBytes + build.installedBytes;
    this.#deps.outcome?.({
      slug,
      title: game.title,
      version: build.version,
      platform: build.platform,
      failure,
      neededBytes,
    });
  }

  /** A failed install: its progress says why until the next try, and the outcome is told. */
  async #fail(job: Pick<Job, "slug" | "build" | "game">, failure: InstallFailure): Promise<void> {
    this.#setProgress(job, { phase: InstallPhase.Failed, failure, etaMs: null });
    await this.#push();
    this.#tell(job, failure);
  }

  #partialOf(job: Pick<Job, "slug" | "build">): string {
    return path.join(this.folder, DOWNLOADS, `${job.slug}-${job.build.sha256.slice(0, 16)}.zip.part`);
  }

  /** Download `job`'s archive and check it, pushing progress at most every quarter second. */
  async #download(job: Job): Promise<string> {
    await mkdir(path.join(this.folder, DOWNLOADS), { recursive: true });
    const partial = this.#partialOf(job);
    const started = this.#deps.now();
    let from: number | null = null;
    this.#setProgress(job, { phase: InstallPhase.Downloading });
    await this.#push();
    await downloadArchive(this.#deps, job.build, partial, job.stop.signal, (received, total) => {
      from ??= received;
      const rate = (received - from) / Math.max(1, this.#deps.now() - started);
      const etaMs = rate > 0 ? Math.round((total - received) / rate) : null;
      this.#setProgress(job, { phase: InstallPhase.Downloading, receivedBytes: received, etaMs });
      if (this.#deps.now() - this.#lastPush >= PROGRESS_EVERY_MS) void this.#push();
    });
    this.#setProgress(job, { phase: InstallPhase.Verifying, receivedBytes: job.build.sizeBytes, etaMs: null });
    await this.#push();
    if (!(await verifyArchive(partial, job.build))) {
      await rm(partial, { force: true });
      throw new InstallError(InstallFailure.Checksum);
    }
    return partial;
  }

  /** Throw `no-space` unless the disk holds the rest of the download, the game and a reserve. */
  async #assertSpace(job: Job): Promise<void> {
    const saved = (await lstat(this.#partialOf(job)).catch(() => null))?.size ?? 0;
    const needed = job.build.sizeBytes - saved + job.build.installedBytes + INSTALL_RESERVE_BYTES;
    if ((await this.#freeBytes(this.folder)) < needed) throw new InstallError(InstallFailure.NoSpace);
  }

  /** Move the unpacked version into place, record it, and drop older versions not in use. */
  async #settle(job: Job, staging: string, app: UnpackedApp): Promise<void> {
    const gameDir = path.join(this.folder, job.slug);
    await mkdir(path.join(gameDir, SAVES), { recursive: true });
    const versionDir = path.join(gameDir, job.build.version);
    if (await lstat(versionDir).catch(() => null)) await rename(versionDir, `${staging}${TRASH}old`);
    await rename(staging, versionDir);
    const bytes = await diskBytes(versionDir);
    const at = new Date(this.#deps.now()).toISOString();
    const { slug, game, build } = job;
    await this.#changeIndex((games) => {
      games[slug] = {
        slug,
        title: game.title,
        coverUrl: game.coverUrl,
        version: build.version,
        platform: build.platform,
        arch: build.arch,
        bytes,
        installedAt: at,
        lastPlayedAt: games[slug]?.lastPlayedAt ?? null,
        // An update keeps what the player agreed this game may know.
        ...(games[slug]?.identityProject ? { identityProject: games[slug].identityProject } : {}),
        entry: build.entry,
        engine: game.native?.engine ?? null,
        ...app,
      };
    });
    await this.sweep(slug);
  }

  /** Download, check, unpack and record one game into `staging`'s parent. */
  async #installInto(job: Job, staging: string): Promise<void> {
    const archive = await this.#download(job);
    this.#setProgress(job, { phase: InstallPhase.Unpacking });
    await this.#push();
    const unpacked = path.join(staging, "game");
    const game = { slug: job.slug, host: this.#deps.host };
    const app =
      job.build.platform === NativePlatform.Linux
        ? await unpackLinuxBuild(archive, unpacked, job.build, game)
        : await unpackMacBuild(this.#deps.run, archive, unpacked, job.build, game);
    job.stop.signal.throwIfAborted();
    await this.#settle(job, unpacked, app);
    await rm(archive, { force: true });
  }

  /** Download, check and unpack one game; its progress and outcome say how it went. */
  async #runJob(job: Job): Promise<void> {
    let staging: string | null = null;
    try {
      await mkdir(this.folder, { recursive: true });
      await this.#assertSpace(job);
      staging = await mkdtemp(path.join(this.folder, INCOMING));
      await this.#installInto(job, staging);
      this.#progress.delete(job.slug);
      await this.#push();
      this.#tell(job, null);
    } catch (error) {
      if (!job.stop.signal.aborted)
        return this.#fail(job, error instanceof InstallError ? error.failure : InstallFailure.Failed);
      this.#progress.delete(job.slug);
      await rm(this.#partialOf(job), { force: true });
      await this.#push();
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }

  /** Run queued installs one after another until none is left. */
  async #drain(): Promise<void> {
    for (let job = this.#queue.shift(); job; job = this.#queue.shift()) {
      this.#running = job;
      await this.#runJob(job);
      this.#running = null;
    }
  }

  /** Remove `slug`'s version folders other than its installed one, unless it is running. */
  async sweep(slug: string): Promise<void> {
    if (this.#deps.inUse?.(slug)) return;
    const keep = (await this.#indexNow()).games[slug]?.version;
    const names = await readdir(path.join(this.folder, slug)).catch(() => [] as string[]);
    for (const name of names) {
      if (name !== SAVES && name !== keep) await removeOwnedFolder(this.folder, [slug], name);
    }
  }

  /**
   * Install `slug` on this computer: its page is read from the catalog and the build for this
   * computer queued. Answers once it is queued; what happens next arrives through `publish`.
   */
  async install(slug: string): Promise<void> {
    if (!isPlaySlug(slug)) throw new Error(MESSAGE.BadSlug);
    if (this.#running?.slug === slug || this.#queue.some((job) => job.slug === slug)) return;
    const game = await this.#deps.game(slug);
    const build = buildFor(game.native?.builds ?? [], this.#deps.host);
    if (!build) {
      const none: NativeBuild = { ...EMPTY_BUILD, platform: this.#deps.host.platform };
      return this.#fail({ slug, game, build: none }, InstallFailure.NotOffered);
    }
    if ((await this.#indexNow()).games[slug]?.version === build.version) return;
    const job: Job = { slug, game, build, stop: new AbortController() };
    this.#queue.push(job);
    this.#setProgress(job, { phase: InstallPhase.Queued, receivedBytes: 0 });
    await this.#push();
    if (!this.#running) this.#drained = this.#drain();
  }

  /** Stop `slug`'s install, waiting or running (its bytes are thrown away), or forget how a failed one ended. */
  async cancel(slug: string): Promise<void> {
    const waiting = this.#queue.findIndex((job) => job.slug === slug);
    if (waiting >= 0) this.#queue.splice(waiting, 1);
    if (this.#running?.slug === slug) return this.#running.stop.abort();
    if (this.#progress.delete(slug)) await this.#push();
  }

  /** Remove `slug` from this computer: its versions go, its saves stay. Refused while it runs. */
  async uninstall(slug: string): Promise<void> {
    if (!isPlaySlug(slug)) throw new Error(MESSAGE.BadSlug);
    if (this.#deps.inUse?.(slug)) throw new Error(MESSAGE.Playing);
    await this.cancel(slug);
    await this.#changeIndex((games) => {
      delete games[slug];
    });
    await this.sweep(slug);
    await this.#push();
  }

  /** Where an installed game's app is, or null. */
  async appOf(slug: string): Promise<string | null> {
    const record = await this.record(slug);
    return record ? path.join(this.folder, slug, record.version, record.entry) : null;
  }

  /** The launcher's record of an installed game, or null. */
  async record(slug: string): Promise<InstallRecord | null> {
    return (await this.#indexNow()).games[slug] ?? null;
  }

  /**
   * Remember (`projectId`) or forget (null) that the player agreed this installed game may know who
   * they are; a game that is not installed is left alone.
   */
  async knowsYou(slug: string, projectId: string | null): Promise<void> {
    if (projectId !== null && !PROJECT_ID.test(projectId)) return;
    await this.#changeIndex((games) => {
      const game = games[slug];
      if (!game) return;
      if (projectId) game.identityProject = projectId;
      else delete game.identityProject;
    });
    await this.#push();
  }

  /** Note that `slug` was just played. */
  async played(slug: string): Promise<void> {
    const at = new Date(this.#deps.now()).toISOString();
    await this.#changeIndex((games) => {
      const game = games[slug];
      if (game) game.lastPlayedAt = at;
    });
    await this.#push();
  }

  /**
   * Tidy the folder at start: unpacking and trash folders a quit left behind go, and so does every
   * version folder the index does not name.
   */
  async reconcile(): Promise<void> {
    const names = await readdir(this.folder).catch(() => [] as string[]);
    for (const name of names) {
      if (name.startsWith(INCOMING) || name.startsWith(TRASH)) await removeOwnedFolder(this.folder, [], name);
      else if (isPlaySlug(name)) await this.sweep(name);
    }
  }

  /** Resolves once no install is waiting or running. */
  async idle(): Promise<void> {
    while (this.#running || this.#queue.length > 0) await this.#drained;
  }
}

/** The installer over `deps`. */
export const nativeInstalls = (deps: NativeInstallDeps): NativeInstaller => new NativeInstaller(deps);

/** A build that does not exist: what a failure for a game with no build for this computer names. */
const EMPTY_BUILD: NativeBuild = {
  platform: NativePlatform.Mac,
  arch: NativeArch.Universal,
  version: "",
  sizeBytes: 0,
  installedBytes: 0,
  sha256: "",
  url: "",
  entry: "",
  publishedAt: "",
};

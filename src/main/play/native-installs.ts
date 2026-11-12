/**
 * Play's native installs: a game built in an engine downloaded, checked and unpacked into Genex's
 * own folder, never the person's games and never a folder an agent writes. One install runs at a
 * time and the rest wait; leaving the page does not stop one. Each game keeps
 * `<root>/<slug>/<version>/` (the app, read-only to the game) beside `<root>/<slug>/saves/` (its
 * home), and `<root>/index.json` lists what is installed. Removing a game keeps its saves; a game
 * whose owner changed its link moves to the new one, saves and all.
 * A chunked build (`native-chunks.ts`) has no archive: its manifest is read, its chunks assembled in
 * a work folder (`native-chunk-assemble.ts`), and the manifest kept as `<root>/<slug>/.manifest.json`
 * so the next update takes every chunk it can from the installed files and downloads only the rest.
 * Electron-free: the catalog read, the fetch, the tools and the push to the window are deps.
 */
import { lstat, mkdir, mkdtemp, readdir, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { etaMsAt, type SpeedMeter, speedAfter, speedMeter } from "../../shared/download-speed.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { isPlaySlug, type PlayGameDetail } from "../../shared/play.ts";
import {
  buildFor,
  type ChunkedBuild,
  type InstalledGame,
  InstallFailure,
  InstallPhase,
  type InstallProgress,
  installSpaceBytes,
  isChunkedBuild,
  isNativeArch,
  isNativePlatform,
  NativeArch,
  type NativeBuild,
  type NativeHost,
  type NativeInstalls,
  NativePlatform,
  type ZipBuild,
} from "../../shared/play-native.ts";
import { atomicWriteJson, atomicWriteText, readJsonIfExists, readRegularFile } from "../../substrate/fsx.ts";
import { diskBytes, removeOwnedFolder } from "../../substrate/storage-folders.ts";
import {
  assembleChunks,
  type ChunkDeps,
  chunkWorkBytes,
  chunkWorkOf,
  discardChunkWork,
  type InstalledSource,
} from "./native-chunk-assemble.ts";
import { fetchManifest, MANIFEST_MAX_BYTES, parseManifest, sha256Hex } from "./native-chunks.ts";
import { discardDownload, downloadArchive, InstallError, verifyArchive } from "./native-download.ts";
import {
  finishBuild,
  type ToolRun,
  type UnpackedApp,
  type UnpackedFor,
  unpackLinuxBuild,
  unpackMacBuild,
  unpackWindowsBuild,
} from "./native-unpack.ts";
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
/**
 * The manifest of a game's installed version, when it came as chunks: a file beside its versions
 * (no version can be named so: none starts with a dot), which clearing old versions leaves alone.
 */
export const KEPT_MANIFEST = ".manifest.json";
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
  /** The sha256 of the manifest kept for it ({@link KEPT_MANIFEST}), when it was installed from chunks. */
  manifestSha256?: string;
}

/** How an install ended, for notifications. */
export interface InstallOutcome {
  slug: string;
  title: string;
  version: string;
  platform: NativePlatform;
  /** Null when it is ready to play. */
  failure: InstallFailure | null;
  /** The space the install takes (`installSpaceBytes`): what a full disk must free. */
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
  /** How the wait before a chunk is asked for again passes (a timer by default). */
  sleep?: ChunkDeps["sleep"];
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
const SHA256 = /^[0-9a-f]{64}$/;

/** One index record as the installer wrote it, or null when anything in it is off. */
function readRecord(slug: string, value: unknown): InstallRecord | null {
  if (!isPlaySlug(slug) || !isRecord(value) || value.slug !== slug) return null;
  if (!STRING_FIELDS.every((field) => typeof value[field] === "string" && value[field] !== "")) return null;
  const { platform, arch, bytes, coverUrl, lastPlayedAt, manifestSha256 } = value;
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
    ...(typeof manifestSha256 === "string" && SHA256.test(manifestSha256) ? { manifestSha256 } : {}),
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
  const { slug, title, coverUrl, version, platform, arch, bytes, installedAt, lastPlayedAt } = record;
  return { slug, title, coverUrl, version, platform, arch, bytes, installedAt, lastPlayedAt };
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
      totalBytes: isChunkedBuild(job.build) ? job.build.installedBytes : job.build.sizeBytes,
      bytesPerSecond: null,
      etaMs: null,
      failure: null,
      ...change,
    });
  }

  /** Tell how an install ended. */
  #tell(job: Pick<Job, "slug" | "build" | "game">, failure: InstallFailure | null): void {
    const { slug, game, build } = job;
    this.#deps.outcome?.({
      slug,
      title: game.title,
      version: build.version,
      platform: build.platform,
      failure,
      neededBytes: installSpaceBytes(build),
    });
  }

  /** A failed install: its progress says why until the next try, and the outcome is told. */
  async #fail(job: Pick<Job, "slug" | "build" | "game">, failure: InstallFailure): Promise<void> {
    this.#setProgress(job, { phase: InstallPhase.Failed, failure, etaMs: null });
    await this.#push();
    this.#tell(job, failure);
  }

  #partialOf(slug: string, build: ZipBuild): string {
    return path.join(this.folder, DOWNLOADS, `${slug}-${build.sha256.slice(0, 16)}.zip.part`);
  }

  /** Where a chunked build of `slug` is assembled: kept after a failure, for the next try. */
  #workOf(slug: string, build: ChunkedBuild): string {
    return chunkWorkOf(path.join(this.folder, DOWNLOADS), slug, build);
  }

  /** Download `job`'s archive and check it, pushing progress at most every quarter second. */
  async #download(job: Job, build: ZipBuild): Promise<string> {
    await mkdir(path.join(this.folder, DOWNLOADS), { recursive: true });
    const partial = this.#partialOf(job.slug, build);
    let meter: SpeedMeter | null = null;
    this.#setProgress(job, { phase: InstallPhase.Downloading });
    await this.#push();
    await downloadArchive(this.#deps, build, partial, job.stop.signal, (received, total) => {
      const now = this.#deps.now();
      meter = meter ? speedAfter(meter, received, now) : speedMeter(received, now);
      const { bytesPerSecond } = meter;
      const etaMs = etaMsAt(meter, total - received);
      this.#setProgress(job, { phase: InstallPhase.Downloading, receivedBytes: received, bytesPerSecond, etaMs });
      if (now - this.#lastPush >= PROGRESS_EVERY_MS) void this.#push();
    });
    this.#setProgress(job, { phase: InstallPhase.Verifying, receivedBytes: build.sizeBytes, etaMs: null });
    await this.#push();
    if (!(await verifyArchive(partial, build))) {
      await discardDownload(partial);
      throw new InstallError(InstallFailure.Checksum);
    }
    return partial;
  }

  /**
   * The space `job` still needs: for a zip, the rest of the download and the game; for a chunked
   * build, the part of the game its work folder does not hold on disk yet (its files are laid out at
   * their sizes, so what a disk without sparse files already gave them is not asked for twice).
   */
  async #spaceNeeded(job: Job): Promise<number> {
    const { slug, build } = job;
    if (isChunkedBuild(build)) {
      const held = await chunkWorkBytes(this.#workOf(slug, build));
      return Math.max(0, build.installedBytes - held);
    }
    const saved = (await lstat(this.#partialOf(slug, build)).catch(() => null))?.size ?? 0;
    return build.sizeBytes - saved + build.installedBytes;
  }

  /** Throw `no-space` unless the disk holds what the install still needs and a reserve. */
  async #assertSpace(job: Job): Promise<void> {
    const needed = (await this.#spaceNeeded(job)) + INSTALL_RESERVE_BYTES;
    if ((await this.#freeBytes(this.folder)) < needed) throw new InstallError(InstallFailure.NoSpace);
  }

  /** Throw away what `job` saved so far: a zip's partial archive, a chunked build's work folder. */
  #discard(job: Job): Promise<void> {
    const { slug, build } = job;
    return isChunkedBuild(build)
      ? discardChunkWork(this.#workOf(slug, build))
      : discardDownload(this.#partialOf(slug, build));
  }

  /**
   * The installed version of `slug` as a source of chunks, or null: it was not installed from
   * chunks, or the manifest kept for it is not the one its record names.
   */
  async #installedSource(slug: string): Promise<InstalledSource | null> {
    const record = (await this.#indexNow()).games[slug];
    if (!record?.manifestSha256) return null;
    try {
      const bytes = await readRegularFile(path.join(this.folder, slug, KEPT_MANIFEST), MANIFEST_MAX_BYTES);
      if ((await sha256Hex(bytes)) !== record.manifestSha256) return null;
      return { dir: path.join(this.folder, slug, record.version), manifest: parseManifest(bytes) };
    } catch {
      return null;
    }
  }

  /** Keep `manifest` for `slug`'s next update, or (a zip has none) drop the one a chunked version left. */
  async #keepManifest(slug: string, manifest: Buffer | null): Promise<void> {
    const kept = path.join(this.folder, slug, KEPT_MANIFEST);
    if (manifest) await atomicWriteText(kept, manifest.toString("utf8"));
    else await rm(kept, { force: true });
  }

  /** What a chunked build's progress reports do: each phase pushed at once, bytes at most every quarter second. */
  #chunkReport(job: Job, build: ChunkedBuild): (phase: InstallPhase, doneBytes: number) => void {
    let meter: SpeedMeter | null = null;
    return (phase, receivedBytes) => {
      const now = this.#deps.now();
      const moved = this.#progress.get(job.slug)?.phase !== phase;
      if (phase !== InstallPhase.Downloading) meter = null;
      else meter = meter ? speedAfter(meter, receivedBytes, now) : speedMeter(receivedBytes, now);
      const bytesPerSecond = meter?.bytesPerSecond ?? null;
      const etaMs = meter ? etaMsAt(meter, build.installedBytes - receivedBytes) : null;
      this.#setProgress(job, { phase, receivedBytes, bytesPerSecond, etaMs });
      if (moved || now - this.#lastPush >= PROGRESS_EVERY_MS) void this.#push();
    };
  }

  /**
   * Move the unpacked version into place, record it (with the `manifest` it came from, when it came
   * as chunks), and drop older versions not in use.
   */
  async #settle(job: Job, staging: string, app: UnpackedApp, manifest: Buffer | null): Promise<void> {
    const gameDir = path.join(this.folder, job.slug);
    await mkdir(path.join(gameDir, SAVES), { recursive: true });
    const versionDir = path.join(gameDir, job.build.version);
    if (await lstat(versionDir).catch(() => null)) await rename(versionDir, `${staging}${TRASH}old`);
    await rename(staging, versionDir);
    await this.#keepManifest(job.slug, manifest);
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
        entry: build.entry,
        engine: game.native?.engine ?? null,
        ...app,
        ...(manifest ? { manifestSha256: build.sha256 } : {}),
      };
    });
    await this.sweep(slug);
  }

  /** Download, check, unpack and record one game into `staging`'s parent. */
  async #installInto(job: Job, staging: string): Promise<void> {
    const unpacked = path.join(staging, "game");
    const game: UnpackedFor = { slug: job.slug, host: this.#deps.host };
    const { build } = job;
    if (isChunkedBuild(build)) return this.#installChunks(job, build, unpacked, game);
    const archive = await this.#download(job, build);
    this.#setProgress(job, { phase: InstallPhase.Unpacking });
    await this.#push();
    const app = await this.#unpack(build, archive, unpacked, game);
    job.stop.signal.throwIfAborted();
    await this.#settle(job, unpacked, app, null);
    await rm(archive, { force: true });
  }

  /**
   * Install a chunked build: its manifest read and checked, its chunks assembled in its work folder
   * (those the installed version holds taken from it), the game moved to `unpacked` and from there
   * checked and recorded exactly as an unpacked zip is. The work folder is gone once the game leaves it.
   */
  async #installChunks(job: Job, build: ChunkedBuild, unpacked: string, game: UnpackedFor): Promise<void> {
    const { signal } = job.stop;
    this.#setProgress(job, { phase: InstallPhase.Downloading });
    await this.#push();
    const { manifest, bytes } = await fetchManifest(this.#deps, build, signal);
    const dir = this.#workOf(job.slug, build);
    const installed = await this.#installedSource(job.slug);
    const report = this.#chunkReport(job, build);
    const assembled = await assembleChunks({ deps: this.#deps, build, manifest, dir, installed, signal, report });
    await rename(assembled, unpacked);
    await discardChunkWork(dir);
    const app = await finishBuild(this.#deps.run, unpacked, build, game);
    signal.throwIfAborted();
    await this.#settle(job, unpacked, app, bytes);
  }

  /** Unpack a verified archive the way its platform's builds are packed. */
  #unpack(build: ZipBuild, archive: string, unpacked: string, game: UnpackedFor): Promise<UnpackedApp> {
    if (build.platform === NativePlatform.Linux) return unpackLinuxBuild(archive, unpacked, build, game);
    if (build.platform === NativePlatform.Windows) return unpackWindowsBuild(archive, unpacked, build, game);
    return unpackMacBuild(this.#deps.run, archive, unpacked, build, game);
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
      await this.#discard(job);
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

  /**
   * Remove `slug`'s version folders other than its installed one, unless it is running. Only folders
   * go: the manifest kept beside them ({@link KEPT_MANIFEST}) stays until the game is removed.
   */
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
    await this.#keepManifest(slug, null);
    await this.sweep(slug);
    await this.#push();
  }

  /** Whether `slug` is installing or waiting to. */
  #installing(slug: string): boolean {
    return this.#running?.slug === slug || this.#queue.some((job) => job.slug === slug);
  }

  /**
   * Move an installed game to the link its page answers under now (its owner changed it): its
   * folder, versions and saves together, and its record, so it plays and updates as before. Nothing
   * moves while it runs or installs, or when something is at the new link already; false then.
   */
  async follow(from: string, to: string): Promise<boolean> {
    if (!isPlaySlug(from) || !isPlaySlug(to) || from === to) return false;
    if (this.#deps.inUse?.(from) || this.#installing(from) || this.#installing(to)) return false;
    const games = (await this.#indexNow()).games;
    const record = games[from];
    if (!record || games[to]) return false;
    if (await lstat(path.join(this.folder, to)).catch(() => null)) return false;
    await rename(path.join(this.folder, from), path.join(this.folder, to));
    await this.#changeIndex((all) => {
      delete all[from];
      all[to] = { ...record, slug: to };
    });
    await this.#push();
    return true;
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

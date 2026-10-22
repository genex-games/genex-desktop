/**
 * Live's hot reload of a Rust game's assets (game systems C-19a, owner call C10). The host watches
 * the folder of the game Live shows (a recursive `fs.watch`, debounced and coalesced as
 * notify-debouncer-full does: every name a burst touched, a rename's two names included, once).
 * A batch lights Reload through Live's gate; nothing changes on its own while the person watches.
 *
 * Reload then asks {@link LiveAssets.reload}. It re-plans the whole `assets/` folder against the
 * copy the running game reads (so a change `fs.watch` missed is still found), and when only files
 * it can place changed, writes them into that copy by atomic rename and sends the game the
 * `reloadAssets` op: the new bytes draw on its next frame, its state kept, no cargo run. Anything
 * else answers `rebuild` with a typed reason and Reload rebuilds as before: a change outside
 * `assets/` (code needs a build), a removed file, a file that needs the import step (a conversion,
 * a compressed mesh, a texture whose families the web page plans), more than one op names. A
 * change outside `assets/` is found by the watcher and, as the assets are, by Reload itself: the
 * folder's other files' print when Live loaded the game against theirs now, so code the watcher
 * has not reported yet (FSEvents' latency, a missed event) never rides an asset swap.
 *
 * Placing a texture's new source drops the family files (`<stem>.<family>.ktx2`) the running
 * native game holds of it, so it draws the new image uncompressed until the next build encodes it
 * again. A web page's copy is the served build output: its `assets.json` row and the build's
 * `.admitted` record take the new length and digests, and the page fetches only the changed
 * entries (its `reloadAssets` verb).
 */
import { createHash, randomUUID } from "node:crypto";
import { watch as fsWatch } from "node:fs";
import { chmod, lstat, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ASSET_LOCK_FILE } from "../shared/asset-db.ts";
import { assetExtension } from "../shared/game-assets.ts";
import { GameStack } from "../shared/game-project.ts";
import {
  type LiveAssetsAnswer,
  LiveAssetsOutcome,
  LiveAssetsRebuild,
  liveAssetsRebuild,
} from "../shared/live-assets.ts";
import {
  isNativeResult,
  NATIVE_BUNDLE_APP,
  NATIVE_RELOAD_FILES_MAX,
  NativeOp,
  type NativeReloadAnswer,
  type NativeReloadFile,
  NativeRunMode,
  type NativeRunStatus,
  type NativeTimers,
  receiptServesReloadAssets,
} from "../shared/native-contract.ts";
import { ImportConverter, planImport, runsImporter, ImportAction } from "../substrate/asset-import/import-plan.ts";
import { isSafeAssetPath, readGameAsset } from "../substrate/asset-import/safe-asset.ts";
import { TextureCompression, familyFileName } from "../substrate/asset-import/texture-table.ts";
import { atomicWriteText, readRegularFile } from "../substrate/fsx.ts";
import { RunDirLayout } from "../substrate/native-bundle.ts";
import { fnv1a64Hex } from "../substrate/native-game-port.ts";
import { IMPORT_INPUT_MAX_BYTES } from "./rust-assets.ts";

/** How long a burst of changes settles before it becomes one batch (notify-debouncer-full's default range). */
export const ASSET_WATCH_DEBOUNCE_MS = 150;
/** The game folder's assets, and the served copy's. */
const ASSETS_DIR = "assets";
/** The web build's asset map beside its page (`WEB_FILES.assetMap`). */
const WEB_ASSET_MAP = "assets.json";
/** The build output's folder suffix and its admitted record's (`rust-build.ts`). */
const OUT_SUFFIX = ".out";
const ADMITTED_SUFFIX = ".admitted";
/** The most of an asset map or an admitted record read back. */
const RECORD_MAX_BYTES = 16 * 1024 * 1024;
/** Top-level folders a change in never asks for a build: git's, the studio's own records, build trees. */
const IGNORED_FOLDERS: ReadonlySet<string> = new Set([".git", ".studio", ".genex", "target", "node_modules"]);
/** The most files outside `assets/` a source print reads, and how deep it looks; past either it reads as moved. */
const SOURCE_PRINT_MAX_FILES = 5000;
const SOURCE_PRINT_MAX_DEPTH = 16;
/** The raster textures the import step encodes into families (`import-plan.ts`). */
const ENCODED_TEXTURES: ReadonlySet<string> = new Set(["png", "jpg", "jpeg"]);
/** A served folder made writable for a moment, then read-only again (`native-bundle.ts` `makeReadOnly`). */
const WRITABLE_FOLDER_MODE = 0o755;
const READ_ONLY_FILE_MODE = 0o444;
const OWNER_WRITE = 0o200;

/** What one changed name under the game folder is to Live. Wire values in tests only. */
export const GameChangeKind = {
  /** A file under `assets/` (its path below `assets/`). */
  Asset: "asset",
  /** `genex-assets.lock`: the import's recorded intent. */
  Lock: "lock",
  /** Anything else that is the game's: code, `genex.toml`, docs. */
  Source: "source",
} as const;
export type GameChangeKind = (typeof GameChangeKind)[keyof typeof GameChangeKind];

/** One changed name, classified; null for a name Live never reloads for. */
export type GameChange =
  | { kind: typeof GameChangeKind.Asset; path: string }
  | { kind: Exclude<GameChangeKind, "asset"> };

/** What a burst of changes touched. */
export interface GameChanges {
  /** Paths below `assets/`, sorted, each once. */
  assets: string[];
  /** Something outside `assets/` that a build reads changed (the lock included). */
  source: boolean;
  /** The watcher could not name a change: only a whole re-plan can say. */
  rescan: boolean;
}

/** `rel` (a game-relative name, either separator) as Live reads it. */
export function classifyGamePath(rel: string): GameChange | null {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  const [top, ...rest] = parts;
  if (top === undefined || IGNORED_FOLDERS.has(top)) return null;
  if (top === ASSETS_DIR) return rest.length > 0 ? { kind: GameChangeKind.Asset, path: rest.join("/") } : null;
  if (parts.length === 1 && top === ASSET_LOCK_FILE) return { kind: GameChangeKind.Lock };
  return { kind: GameChangeKind.Source };
}

/** The names a burst touched, gathered until it settles. */
export interface ChangeBatcher {
  /** One changed name (null: the watcher could not say which). */
  note(rel: string | null): void;
  /** Stops: a burst still settling is dropped. */
  dispose(): void;
}

/**
 * Gathers changed names until none came for `debounceMs`, then hands the batch on once: a burst
 * of writes, a save's temp-and-rename pair, a folder copied in all become one batch.
 */
export function changeBatcher(
  timers: NativeTimers,
  onBatch: (changes: GameChanges) => void,
  debounceMs = ASSET_WATCH_DEBOUNCE_MS,
): ChangeBatcher {
  let assets = new Set<string>();
  let source = false;
  let rescan = false;
  let timer: unknown = null;
  const flush = () => {
    timer = null;
    const changes = { assets: [...assets].sort(), source, rescan };
    assets = new Set();
    source = false;
    rescan = false;
    if (changes.assets.length > 0 || changes.source || changes.rescan) onBatch(changes);
  };
  return {
    note(rel) {
      const change = rel === null ? null : classifyGamePath(rel);
      if (rel === null) rescan = true;
      else if (change?.kind === GameChangeKind.Asset) assets.add(change.path);
      else if (change) source = true;
      else return;
      timers.clearTimeout(timer);
      timer = timers.setTimeout(flush, debounceMs);
    },
    dispose() {
      timers.clearTimeout(timer);
      timer = null;
    },
  };
}

/** What a recursive watch reports and how it stops (`fs.watch`'s shape). */
export type FolderWatch = (
  dir: string,
  listener: (filename: string | null) => void,
) => { close(): void; on?(event: "error", listener: () => void): unknown };

/** The real watcher: `fs.watch` over the whole folder; an error is a change it could not name. */
export const recursiveWatch: FolderWatch = (dir, listener) => {
  const watcher = fsWatch(dir, { recursive: true, persistent: false }, (_event, filename) =>
    listener(typeof filename === "string" ? filename : null),
  );
  watcher.on("error", () => listener(null));
  return watcher;
};

/** One file's line in a source print: its kind, size and time (a link is its own entry, never followed). */
function printLine(rel: string, stat: { size: number; mtimeMs: number; isSymbolicLink(): boolean }): string {
  return `${rel}:${stat.isSymbolicLink() ? "link" : "file"}:${stat.size}:${stat.mtimeMs}\0`;
}

/** The entries a source print reads below `rel`: every one but the top-level `assets/` and the ignored folders. */
async function sourceEntries(gameDir: string, rel: string): Promise<Array<{ rel: string; dir: boolean }>> {
  const entries = await readdir(rel ? path.join(gameDir, ...rel.split("/")) : gameDir, { withFileTypes: true });
  const kept = rel ? entries : entries.filter((e) => e.name !== ASSETS_DIR && !IGNORED_FOLDERS.has(e.name));
  return kept
    .map((e) => ({ rel: rel ? `${rel}/${e.name}` : e.name, dir: e.isDirectory() }))
    .sort((a, b) => (a.rel < b.rel ? -1 : Number(a.rel > b.rel)));
}

/**
 * The game folder's files outside `assets/` as Reload compares them: each one's path, kind, size
 * and time (git's and Studio's own folders and build trees left out, links never followed). Null
 * when the folder cannot be read or holds more than a print reads: then Reload rebuilds.
 */
export async function sourcePrint(gameDir: string): Promise<string | null> {
  const hash = createHash("sha256");
  const pending: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
  let files = 0;
  try {
    for (let next = pending.pop(); next; next = pending.pop()) {
      for (const entry of await sourceEntries(gameDir, next.rel)) {
        if (entry.dir && next.depth >= SOURCE_PRINT_MAX_DEPTH) return null;
        if (entry.dir) {
          pending.push({ rel: entry.rel, depth: next.depth + 1 });
          continue;
        }
        files += 1;
        if (files > SOURCE_PRINT_MAX_FILES) return null;
        hash.update(printLine(entry.rel, await lstat(path.join(gameDir, ...entry.rel.split("/")))));
      }
    }
  } catch {
    return null;
  }
  return hash.digest("hex");
}

/** What Reload knows before it plans a swap. */
export interface SwapState {
  /** Live shows a run or page of the game's own folder. */
  shown: boolean;
  /** That build serves `reloadAssets`. */
  serves: boolean;
  /** The watcher saw a change outside `assets/` since Live loaded the game. */
  watchedSource: boolean;
  /** The folder's files outside `assets/` differ from their print when Live loaded the game (or either print is unknown). */
  sourceMoved: boolean;
}

/**
 * The route of a Reload, before any asset is read: null when only assets can have changed, so the
 * swap plans them and names them in one `reloadAssets`; otherwise the rebuild's reason.
 */
export function swapRefusal(state: SwapState): LiveAssetsRebuild | null {
  if (!state.shown) return LiveAssetsRebuild.NoRun;
  if (!state.serves) return LiveAssetsRebuild.NotServed;
  if (state.watchedSource || state.sourceMoved) return LiveAssetsRebuild.Source;
  return null;
}

/** How a changed asset can reach the running game. */
const SwapRule = {
  /** Its bytes are what the game reads: placed as they are. */
  Place: "place",
  /** A PNG or JPEG: placed, and the families the build encoded from the old one dropped. */
  Texture: "texture",
  /** Its served form is its own bytes but made by the import step (a KTX2's families): a rebuild. */
  Import: "import",
  /** The import step rewrites or renames it (a conversion, a mesh): only the watcher can say it changed. */
  Watched: "watched",
} as const;
type SwapRule = (typeof SwapRule)[keyof typeof SwapRule];

/** How a Rust game's `rel` (below `assets/`) can be swapped; null when the build never serves it. */
function swapRule(rel: string): SwapRule | null {
  const step = planImport(GameStack.RustWgpu, `${ASSETS_DIR}/${rel}`);
  if (step.action === ImportAction.Refuse || step.action === ImportAction.Skip) return null;
  if (ENCODED_TEXTURES.has(assetExtension(rel))) return SwapRule.Texture;
  if (!runsImporter(step) || step.converter === ImportConverter.HdrCheck) return SwapRule.Place;
  if (step.converter === ImportConverter.Ktx2Check) return SwapRule.Import;
  return SwapRule.Watched;
}

/** One file a swap places: its asset path, new bytes and their FNV-1a 64. */
export interface SwapFile {
  path: string;
  bytes: Buffer;
  digest: string;
  /** A PNG or JPEG: its old family files are dropped beside it. */
  texture: boolean;
}

/** What the whole-folder re-plan found: the files to place, or why a rebuild is due. */
export type SwapPlan = { ok: true; files: SwapFile[] } | { ok: false; reason: LiveAssetsRebuild };

/** The regular files under `dir`, `/`-separated below it, sorted; links and odd names left out. */
export async function regularAssetFiles(dir: string, rel = ""): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(rel ? path.join(dir, ...rel.split("/")) : dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (!isSafeAssetPath(child)) continue;
    if (entry.isDirectory()) files.push(...(await regularAssetFiles(dir, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort((a, b) => (a < b ? -1 : Number(a > b)));
}

/** The served copy's bytes of `rel`, or null when it has none (never through a link). */
async function servedBytes(servedDir: string, rel: string): Promise<Buffer | null> {
  return readRegularFile(path.join(servedDir, ...rel.split("/")), IMPORT_INPUT_MAX_BYTES).catch(() => null);
}

/** One game file against the served copy: null when unchanged, a file to place, or a rebuild reason. */
async function planOne(
  gameDir: string,
  servedDir: string,
  rel: string,
  touched: ReadonlySet<string>,
): Promise<SwapFile | LiveAssetsRebuild | null> {
  const rule = swapRule(rel);
  if (rule === null) return null;
  if (rule === SwapRule.Watched) return touched.has(rel) ? LiveAssetsRebuild.Import : null;
  const read = await readGameAsset(gameDir, `${ASSETS_DIR}/${rel}`, IMPORT_INPUT_MAX_BYTES);
  if (!read.ok) return null;
  // Byte for byte (a native compare): only a changed file is digested, so re-planning a whole
  // folder of unchanged assets costs reads, not hashing.
  const served = await servedBytes(servedDir, rel);
  if (served?.equals(read.bytes)) return null;
  if (rule === SwapRule.Import) return LiveAssetsRebuild.Import;
  return { path: rel, bytes: read.bytes, digest: fnv1a64Hex(read.bytes), texture: rule === SwapRule.Texture };
}

/**
 * The whole `assets/` folder of `gameDir` re-planned against `servedDir` (the copy the running
 * game reads): every file whose bytes differ, placed as they are or as a texture's source; a
 * rebuild reason for a file the swap cannot place, a name `touched` that is gone (removed), or
 * more files than one op names. `touched` is what the watcher saw since Live loaded.
 */
export async function planAssetSwap(
  gameDir: string,
  servedDir: string,
  touched: ReadonlySet<string> = new Set(),
): Promise<SwapPlan> {
  const present = await regularAssetFiles(path.join(gameDir, ASSETS_DIR));
  const listed = new Set(present);
  const gone = [...touched].some((rel) => !listed.has(rel) && isSafeAssetPath(rel) && swapRule(rel) !== null);
  if (gone) return { ok: false, reason: LiveAssetsRebuild.Removed };
  const files: SwapFile[] = [];
  for (const rel of present) {
    const planned = await planOne(gameDir, servedDir, rel, touched);
    if (typeof planned === "string") return { ok: false, reason: planned };
    if (planned) files.push(planned);
    if (files.length > NATIVE_RELOAD_FILES_MAX) return { ok: false, reason: LiveAssetsRebuild.TooMany };
  }
  return { ok: true, files };
}

/** `dir` and every folder from it down to `target`'s folder, made where missing, each a real folder (never a link). */
async function realFoldersTo(root: string, rel: string): Promise<string> {
  let dir = root;
  for (const part of rel.split("/").slice(0, -1)) {
    dir = path.join(dir, part);
    const found = await lstat(dir).catch(() => null);
    if (found && !found.isDirectory()) throw new Error(`${dir} is not a folder of the served copy`);
    if (!found) await withWritable(path.dirname(dir), () => mkdir(dir));
  }
  return dir;
}

/** Runs `write` with `dir` writable by its owner, then gives the folder its mode back. */
async function withWritable<T>(dir: string, write: () => Promise<T>): Promise<T> {
  const mode = (await lstat(dir)).mode & 0o777;
  const locked = (mode & OWNER_WRITE) === 0;
  if (locked) await chmod(dir, WRITABLE_FOLDER_MODE);
  try {
    return await write();
  } finally {
    if (locked) await chmod(dir, mode);
  }
}

/** The family files of a texture's old source the served copy holds. */
function familyFiles(rel: string): string[] {
  return Object.values(TextureCompression).map((family) => familyFileName(rel, family));
}

/** One file placed: a fresh temp file beside it, then renamed over it; a read-only copy stays read-only. */
async function placeFile(root: string, file: SwapFile): Promise<void> {
  const dir = await realFoldersTo(root, file.path);
  const target = path.join(root, ...file.path.split("/"));
  const old = await lstat(target).catch(() => null);
  if (old && !old.isFile()) throw new Error(`${file.path} in the served copy is not a regular file`);
  await withWritable(dir, async () => {
    const temp = path.join(dir, `.${randomUUID()}.swap`);
    const mode = old ? old.mode & 0o777 : READ_ONLY_FILE_MODE;
    await writeFile(temp, file.bytes, { flag: "wx", mode });
    await rename(temp, target);
    if (!file.texture) return;
    for (const family of familyFiles(file.path)) {
      const at = path.join(root, ...family.split("/"));
      if ((await lstat(at).catch(() => null))?.isFile()) await rm(at);
    }
  });
}

/**
 * Places `files` into the served copy at `servedDir` (a real folder, never a link): each by atomic
 * rename, through real folders only, a texture's old family files dropped. Answers the paths of
 * the family files it dropped.
 */
export async function placeSwap(servedDir: string, files: readonly SwapFile[]): Promise<void> {
  const found = await lstat(servedDir);
  if (!found.isDirectory()) throw new Error(`${servedDir} is not the served copy's folder`);
  const root = await realpath(servedDir);
  for (const file of files) await placeFile(root, file);
}

/** One `assets.json` row, as far as a swap reads it (`WebAssetEntry` in `rust-build-web.ts`). */
interface WebMapRow {
  path: string;
  bytes: number;
  fnv1a64: string;
  family?: unknown;
  of?: unknown;
  group?: unknown;
  ranges?: unknown;
}

const isMapRow = (row: unknown): row is WebMapRow =>
  typeof row === "object" &&
  row !== null &&
  typeof (row as WebMapRow).path === "string" &&
  typeof (row as WebMapRow).bytes === "number" &&
  typeof (row as WebMapRow).fnv1a64 === "string";

/** The served page's asset map, or null when it has none a swap can edit. */
async function readWebMap(webRoot: string): Promise<{ version: unknown; files: WebMapRow[] } | null> {
  const text = await readRegularFile(path.join(webRoot, WEB_ASSET_MAP), RECORD_MAX_BYTES).catch(() => null);
  if (!text) return null;
  try {
    const map: unknown = JSON.parse(text.toString("utf8"));
    const files = (map as { files?: unknown }).files;
    if (!Array.isArray(files) || !files.every(isMapRow)) return null;
    return { version: (map as { version?: unknown }).version, files };
  } catch {
    return null;
  }
}

/** Whether the page plans `rel` as one whole file it can swap: listed, not ranged nor streamed, no families of it. */
function webSwappable(rows: readonly WebMapRow[], rel: string): boolean {
  const row = rows.find((known) => known.path === rel);
  if (!row || row.ranges !== undefined || row.family !== undefined) return false;
  return !rows.some((other) => other.of === rel);
}

/**
 * Whether the web page at `webRoot` can take `files` in place: each a whole file its map plans,
 * with no family files of it (a texture's families the page picks are the import step's).
 */
export async function webSwapRefusal(webRoot: string, files: readonly SwapFile[]): Promise<LiveAssetsRebuild | null> {
  const map = await readWebMap(webRoot);
  if (!map) return LiveAssetsRebuild.Import;
  return files.every((file) => webSwappable(map.files, file.path)) ? null : LiveAssetsRebuild.Import;
}

/** The web page's map rows and the build's admitted record, given the placed files' new lengths and digests. */
export async function recordWebSwap(webRoot: string, files: readonly SwapFile[]): Promise<void> {
  const map = await readWebMap(webRoot);
  if (!map) return;
  for (const file of files) {
    const row = map.files.find((known) => known.path === file.path);
    if (!row) continue;
    row.bytes = file.bytes.length;
    row.fnv1a64 = file.digest;
  }
  const mapText = `${JSON.stringify({ version: map.version, files: map.files })}\n`;
  await atomicWriteText(path.join(webRoot, WEB_ASSET_MAP), mapText);
  const changed = [
    ...files.map((file) => ({ rel: `${ASSETS_DIR}/${file.path}`, bytes: file.bytes })),
    { rel: WEB_ASSET_MAP, bytes: Buffer.from(mapText) },
  ];
  await recordAdmitted(webRoot, changed);
}

/** One `<bin>.admitted` row (`rust-build.ts` `digestTree`). */
interface AdmittedRow {
  path: string;
  sha256: string;
  bytes: number;
}

const isAdmittedRow = (row: unknown): row is AdmittedRow =>
  typeof row === "object" && row !== null && typeof (row as AdmittedRow).path === "string";

/**
 * The build's admitted record beside `<bin>.out` takes the new digests of `changed`, so the
 * output still reads as what was admitted (`lastAdmitted`); a record it cannot read is left.
 */
async function recordAdmitted(outDir: string, changed: ReadonlyArray<{ rel: string; bytes: Buffer }>): Promise<void> {
  if (!outDir.endsWith(OUT_SUFFIX)) return;
  const record = `${outDir.slice(0, -OUT_SUFFIX.length)}${ADMITTED_SUFFIX}`;
  const text = await readRegularFile(record, RECORD_MAX_BYTES).catch(() => null);
  if (!text) return;
  let rows: unknown;
  try {
    rows = JSON.parse(text.toString("utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(rows) || !rows.every(isAdmittedRow)) return;
  for (const { rel, bytes } of changed) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const row = rows.find((known) => known.path === rel);
    if (row) Object.assign(row, { sha256, bytes: bytes.length });
    else rows.push({ path: rel, sha256, bytes: bytes.length });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  await atomicWriteText(record, `${JSON.stringify(rows)}\n`);
}

/** What Live shows of a game, as far as the swap reaches it. */
export interface ShownGame {
  /** The folder of assets the running game reads (a native run's bundle copy, a web build's `out/assets`). */
  assetsDir: string;
  /** A web page's served build output (its `assets.json` and admitted record); null for a native run. */
  webRoot: string | null;
  /** Whether the game's build serves `reloadAssets` (its receipt says so, or the web page's shell has the verb). */
  serves(): Promise<boolean>;
  /** Sends the op; answers what the game did, or null when the game turns out not to serve it. */
  reload(files: NativeReloadFile[]): Promise<NativeReloadAnswer | null>;
}

/** Live's web page as the swap reaches it: the build output it serves and its page verbs. */
export interface LiveAssetsPage {
  output: string;
  /** Whether the page's shell has the `reloadAssets` verb, asked before anything is placed. */
  serves(): Promise<boolean>;
  studioCall(method: string, arg?: unknown): Promise<unknown>;
}

/** A native run as the swap reaches it: its status (run id, receipt) and its op call. */
interface SwapRun {
  call(op: typeof NativeOp.ReloadAssets, arg: { files: NativeReloadFile[] }): Promise<NativeReloadAnswer>;
}

/** What Live shows, as the core holds it. */
export interface LiveShowing {
  nativeRuns: {
    portOf(project: string, mode?: NativeRunMode): SwapRun | null;
    state(project: string, mode?: NativeRunMode): NativeRunStatus | null;
  };
  /** `layout.nativeRuns`: a run's folder is `<root>/<runId>`. */
  nativeRunsRoot: string;
  livePage(project: string): LiveAssetsPage | null;
}

/** The runs Live can show, in the order the person looks at them (as the frame profile reads them). */
const SHOWN_MODES = [NativeRunMode.Embedded, NativeRunMode.Window] as const;

/** The build output a Live load served (its `servedKey`: `[root, entry, loopback]`); null when none. */
export function servedOutputOf(key: string | null): string | null {
  if (!key) return null;
  try {
    const parsed: unknown = JSON.parse(key);
    const root = Array.isArray(parsed) ? parsed[0] : null;
    return typeof root === "string" && path.isAbsolute(root) ? root : null;
  } catch {
    return null;
  }
}

/**
 * What Live shows of `project` for the swap: its native run (Live's Native view first, then the
 * Play window), reading the read-only copy in its run folder's bundle; else Live's page when it
 * serves a build of the game's own folder. Null when it shows neither.
 */
export function shownLiveGame(showing: LiveShowing, project: string): ShownGame | null {
  for (const mode of SHOWN_MODES) {
    const port = showing.nativeRuns.portOf(project, mode);
    const status = showing.nativeRuns.state(project, mode);
    if (!port || !status) continue;
    const bundle = path.join(showing.nativeRunsRoot, status.runId, RunDirLayout.Bundle, NATIVE_BUNDLE_APP);
    return {
      assetsDir: path.join(bundle, "Contents", "Resources", ASSETS_DIR),
      webRoot: null,
      serves: async () => receiptServesReloadAssets(status.receipt),
      reload: (files) => port.call(NativeOp.ReloadAssets, { files }),
    };
  }
  const page = showing.livePage(project);
  if (!page) return null;
  return {
    assetsDir: path.join(page.output, ASSETS_DIR),
    webRoot: page.output,
    serves: () => page.serves(),
    reload: async (files) => {
      const answer = await page.studioCall(NativeOp.ReloadAssets, { files });
      return isNativeResult(NativeOp.ReloadAssets, answer) ? answer : null;
    },
  };
}

/** What the swap reaches, injected. */
export interface LiveAssetsDeps {
  gameDir(project: string): string;
  /** What Live shows of `project`'s own folder now; null when it shows none (another game, a run's build). */
  shown(project: string): ShownGame | null;
  /** A batch for the watched game: Live's gate decides whether Reload lights. */
  offer(project: string): void;
  /** The swap brought Live level with the folder: nothing waits for Reload. */
  caughtUp(project: string): Promise<void>;
  timers: NativeTimers;
  /** Default {@link recursiveWatch}. */
  watch?: FolderWatch;
  log?(line: string): void;
}

/** The game the watcher follows, and what it saw since Live loaded it. */
interface Watched {
  project: string;
  batcher: ChangeBatcher;
  close(): void;
  touched: Set<string>;
  source: boolean;
  /** The folder's files outside `assets/` when Live loaded the game ({@link sourcePrint}). */
  sourcePrint: Promise<string | null>;
}

/** The watcher and the swap for the game Live shows. */
export class LiveAssets {
  readonly #deps: LiveAssetsDeps;
  #watched: Watched | null = null;

  constructor(deps: LiveAssetsDeps) {
    this.#deps = deps;
  }

  /** The game Live just loaded (a load or a rebuild the person asked for): watch its folder from a clean slate. */
  liveLoaded(project: string): void {
    this.#watch(project);
  }

  /** What the watcher saw of `project` since Live loaded it (tests and the swap read it). */
  seen(project: string): { touched: string[]; source: boolean } | null {
    const watched = this.#watched?.project === project ? this.#watched : null;
    return watched ? { touched: [...watched.touched].sort(), source: watched.source } : null;
  }

  /** Resolves once the print of `project`'s files outside `assets/` taken at its load is read (tests wait on it). */
  async settled(project: string): Promise<void> {
    if (this.#watched?.project === project) await this.#watched.sourcePrint;
  }

  /** Stops watching. */
  dispose(): void {
    this.#unwatch();
  }

  /**
   * Reload's asset swap for `project`: the whole `assets/` folder re-planned against what the
   * running game reads, the changed files placed and named in one `reloadAssets`; `rebuild` with
   * its reason whenever anything else changed or a file cannot be placed (nothing is placed then).
   */
  async reload(project: string): Promise<LiveAssetsAnswer> {
    const shown = this.#deps.shown(project);
    const serves = shown !== null && (await shown.serves());
    // Only a game Live shows, in a build that swaps, is watched: asking about another game never
    // moves the watch off the one on the stage.
    const watched = serves ? this.#watchedOrNew(project) : null;
    const refusal = swapRefusal({
      shown: shown !== null,
      serves,
      watchedSource: watched?.source === true,
      sourceMoved: watched !== null && !watched.source && (await this.#sourceMoved(project, watched)),
    });
    if (refusal !== null || !shown || !watched) return liveAssetsRebuild(refusal ?? LiveAssetsRebuild.NoRun);
    const plan = await planAssetSwap(this.#deps.gameDir(project), shown.assetsDir, watched.touched);
    if (!plan.ok) return liveAssetsRebuild(plan.reason);
    if (plan.files.length === 0) return liveAssetsRebuild(LiveAssetsRebuild.Unchanged);
    const webRefusal = shown.webRoot ? await webSwapRefusal(shown.webRoot, plan.files) : null;
    if (webRefusal) return liveAssetsRebuild(webRefusal);
    await placeSwap(shown.assetsDir, plan.files);
    if (shown.webRoot) await recordWebSwap(shown.webRoot, plan.files);
    const answer = await shown.reload(plan.files.map(({ path: rel, digest }) => ({ path: rel, digest })));
    if (!answer) return liveAssetsRebuild(LiveAssetsRebuild.NotServed);
    if (answer.refused.length > 0) {
      this.#deps.log?.(
        `live asset swap: the game refused ${answer.refused.map((r) => `${r.path} (${r.code})`).join(", ")}`,
      );
      return { ...liveAssetsRebuild(LiveAssetsRebuild.Refused), reloaded: answer.reloaded, pending: answer.pending };
    }
    watched.touched.clear();
    await this.#deps.caughtUp(project);
    return { outcome: LiveAssetsOutcome.Swapped, reason: null, reloaded: answer.reloaded, pending: answer.pending };
  }

  /** The watch on `project`, or a new one from now when the watcher follows another game or none. */
  #watchedOrNew(project: string): Watched {
    return this.#watched?.project === project ? this.#watched : this.#watch(project);
  }

  /** Whether the game's files outside `assets/` moved since Live loaded it, as far as their prints say. */
  async #sourceMoved(project: string, watched: Watched): Promise<boolean> {
    const before = await watched.sourcePrint;
    const now = await sourcePrint(this.#deps.gameDir(project));
    return before === null || now === null || before !== now;
  }

  /** Watch `project`'s folder from now on, forgetting what was seen before. */
  #watch(project: string): Watched {
    this.#unwatch();
    const batcher = changeBatcher(this.#deps.timers, (changes) => this.#batch(watched, changes));
    const listen = this.#deps.watch ?? recursiveWatch;
    let close = () => {};
    try {
      const handle = listen(this.#deps.gameDir(project), (filename) => batcher.note(filename));
      close = () => handle.close();
    } catch (error) {
      this.#deps.log?.(`live asset watch: ${project}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const sourcePrinted = sourcePrint(this.#deps.gameDir(project));
    const watched: Watched = { project, batcher, close, touched: new Set(), source: false, sourcePrint: sourcePrinted };
    this.#watched = watched;
    return watched;
  }

  #batch(watched: Watched, changes: GameChanges): void {
    if (this.#watched !== watched) return;
    for (const rel of changes.assets) watched.touched.add(rel);
    if (changes.source) watched.source = true;
    this.#deps.offer(watched.project);
  }

  #unwatch(): void {
    const watched = this.#watched;
    if (!watched) return;
    this.#watched = null;
    watched.batcher.dispose();
    try {
      watched.close();
    } catch {
      // Already closed: nothing is left to stop.
    }
  }
}

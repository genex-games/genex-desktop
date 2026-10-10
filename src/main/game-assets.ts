/**
 * What a game actually holds, read-only.
 *
 * Four pieces, each of which refuses rather than guesses: a walk of the game's own asset
 * folders (lstat only — a symlink is reported, never followed), a read of the Genex plugin's
 * durable job records (never written, never carrying its approval images), a pure join that
 * decides where each file came from, and one contained image reader for the canvas.
 *
 * `readRunStill` is not widened by any of this: its contract is the runs folder and it keeps it.
 * Every path this module hands back is posix-relative to the game root.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { sniffImage } from "../substrate/image-sniff.ts";
import { assertRelativePath, isBelow } from "../substrate/paths.ts";
import { isJsonObject, readRegularFile } from "../substrate/fsx.ts";
import { isPluginId } from "../shared/plugin-id.ts";
import { GENEX_COVER_MAX_BYTES, GENEX_COVER_SHOT_FILE, GENEX_COVERS_DIR } from "../shared/genex.ts";
import type { StillMimeType } from "../shared/preview-contract.ts";
import { genexRef } from "../shared/genex-ref.ts";
import { isImageFile } from "../substrate/game-workspace.ts";
import {
  type AssetAvailability,
  type AssetKind,
  type AssetSource,
  assetKind,
  type ProjectAsset,
  type ProjectAssets,
} from "../shared/game-assets.ts";
import type { EventEnvelope } from "../substrate/types.ts";
import { CustomEvent } from "../shared/custom-events.ts";
import { EventKind } from "../shared/event-log.ts";
import type { AssetDeliveryRecord } from "./asset-checkpoints.ts";

/** The folders a game keeps generated and dropped-in assets in. `public/assets` is the bundled shape. */
const ASSET_ROOTS = ["assets", "public/assets"] as const;
/** Blender scripts live in `assets/src`; they are inputs, not assets. */
const EXCLUDED_PREFIX = "assets/src/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A game's name as the Genex plugin keys its storage by it: one plain path segment. */
const GENEX_PROJECT = /^[a-zA-Z0-9_-]+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const JOB_JSON_MAX = 2_000_000;
const JOB_CACHE_MAX = 512;
const JOB_CACHE_BYTES = 8 * 1024 * 1024;
const jobJsonCache = new Map<string, { stamp: string; value: Record<string, unknown>; bytes: number }>();
let jobCacheBytes = 0;
const PROMPT_MAX = 500;
/** How many files an asset walk lists, and how deep below an asset root it goes. */
const WALK_MAX_ENTRIES = 2000;
const WALK_MAX_DEPTH = 6;
/** The largest image the contained reader returns, in bytes. */
const IMAGE_MAX_BYTES = 16 * 1024 * 1024;
/** How many file digests are cached before the cache starts over. */
const DIGEST_CACHE_MAX = 10_000;
/** A job id no job has: `readGenexJobs` finds the jobs folder through the job-folder check. */
const NO_JOB = "00000000-0000-0000-0000-000000000000";

export interface AssetEntry {
  file: string;
  bytes: number;
  mtime: string;
}
export interface AssetWalk {
  entries: AssetEntry[];
  truncated: boolean;
  skipped: Array<{ file: string; why: string }>;
}

/** Text order, as the listing shows it. */
function byText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** One asset walk under way: what it found, what it refused, and its limits. */
interface WalkState extends AssetWalk {
  maxEntries: number;
  maxDepth: number;
}

async function walkAssetDir(state: WalkState, dir: string, rel: string, depth: number): Promise<void> {
  if (depth > state.maxDepth) {
    state.truncated = true;
    return;
  }
  const names = await readdir(dir).catch(() => null);
  if (!names) return;
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const childRel = `${rel}/${name}`;
    if (childRel.startsWith(EXCLUDED_PREFIX)) continue;
    if (state.entries.length >= state.maxEntries) {
      state.truncated = true;
      return;
    }
    await visitAssetEntry(state, path.join(dir, name), childRel, depth);
  }
}

async function visitAssetEntry(state: WalkState, child: string, childRel: string, depth: number): Promise<void> {
  const st = await lstat(child).catch(() => null);
  if (!st) return;
  if (st.isSymbolicLink()) {
    state.skipped.push({ file: childRel, why: "symlink" });
    return;
  }
  if (st.isDirectory()) {
    await walkAssetDir(state, child, childRel, depth + 1);
    return;
  }
  if (!st.isFile()) {
    state.skipped.push({ file: childRel, why: "not a regular file" });
    return;
  }
  if (/\.md$/i.test(childRel)) return;
  state.entries.push({ file: childRel, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() });
}

/**
 * Every regular file under `assets/` and `public/assets/`, capped. Dotfiles, `*.md` and
 * `assets/src/**` are left out; a symlink anywhere — the asset roots themselves included — is
 * listed in `skipped` and the walk carries on past it, because one hostile link must not hide
 * the rest of a folder.
 */
export async function walkGameAssets(
  root: string,
  { maxEntries = WALK_MAX_ENTRIES, maxDepth = WALK_MAX_DEPTH }: { maxEntries?: number; maxDepth?: number } = {},
): Promise<AssetWalk> {
  const state: WalkState = { entries: [], skipped: [], truncated: false, maxEntries, maxDepth };
  for (const base of ASSET_ROOTS) {
    const dir = path.join(root, ...base.split("/"));
    // The root itself is lstat-ed like every entry under it: a symlinked `assets/` is reported and
    // left alone, never walked, so a link cannot make another folder read as this game's.
    const st = await lstat(dir).catch(() => null);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      state.skipped.push({ file: base, why: "symlink" });
      continue;
    }
    if (!st.isDirectory()) continue;
    await walkAssetDir(state, dir, base, 1);
  }
  state.entries.sort((a, b) => byText(a.file, b.file));
  return { entries: state.entries, truncated: state.truncated, skipped: state.skipped };
}

/** A plugin job record as this module reads it — the durable part, never the approval images. */
export interface AssetJobRecord {
  id: string;
  manifest?: ProjectAsset["variants"];
  preferredFile?: string;
  operation?: string;
  status?: string;
  generationId?: string;
  files: string[];
  prompt?: string;
  createdAt?: string;
  use?: ProjectAsset["use"];
}

/** Where the Genex plugin keeps one project's jobs. */
export function genexJobsRoot(engineHomes: string, project: string): string | null {
  return GENEX_PROJECT.test(project) ? path.join(engineHomes, "genex", "projects", project, "jobs") : null;
}

/** Where a Genex job keeps its record and its inspection frames. */
export function genexJobDir(engineHomes: string, project: string, jobId: string): string | null {
  const root = genexJobsRoot(engineHomes, project);
  return root && UUID.test(jobId) ? path.join(root, jobId) : null;
}

/** The one inspection frame a job may expose: `inspection-<uuid>.jpg`, nothing else in that folder. */
export function isGenexInspectionFile(file: string): boolean {
  return /^inspection-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i.test(file);
}

/** Where the Genex plugin keeps one game's cover (`covers/<project>/`), or null for a name no game has. */
export function genexCoverDir(engineHomes: string, project: string): string | null {
  return GENEX_PROJECT.test(project) ? path.join(engineHomes, "genex", GENEX_COVERS_DIR, project) : null;
}

/** The kept shot's image when the folder holds it as a plain file: its name, type and time. */
async function shotCandidate(
  dir: string,
  [mimeType, name]: [StillMimeType, string],
): Promise<{ file: string; mimeType: StillMimeType; mtimeMs: number } | null> {
  const st = await lstat(path.join(dir, name)).catch(() => null);
  return st?.isFile() ? { file: path.join(dir, name), mimeType, mtimeMs: st.mtimeMs } : null;
}

/**
 * The game's kept Genex cover shot, as bytes the renderer can show, or null. Its place is built
 * here from the game's name, never taken from anyone: the cover folder must be exactly that folder
 * by its real path (a link anywhere on the way from engine homes refuses it), and only `shot.png`
 * or `shot.jpg` is read: a regular file opened without following a link, at most Genex's upload
 * limit, whose bytes are the type its name says. While a shot of the other type replaces the last
 * one both are there for a moment, and the newer is the shot.
 */
export async function readGenexCoverShot(
  engineHomes: string,
  project: string,
  { resize }: { resize?: (data: Buffer) => Promise<Buffer> } = {},
): Promise<{ mimeType: string; data: string } | null> {
  const homes = typeof project === "string" ? await realpath(engineHomes).catch(() => null) : null;
  const dir = homes && genexCoverDir(homes, project);
  if (!dir || (await realpath(dir).catch(() => null)) !== dir) return null;
  const files = Object.entries(GENEX_COVER_SHOT_FILE) as Array<[StillMimeType, string]>;
  const found = (await Promise.all(files.map((entry) => shotCandidate(dir, entry)))).filter((shot) => shot !== null);
  const shot = found.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!shot) return null;
  const data = await readRegularFile(shot.file, GENEX_COVER_MAX_BYTES).catch(() => null);
  if (!data || sniffImage(data)?.mimeType !== shot.mimeType) return null;
  const smaller = resize ? await resize(data).catch(() => null) : null;
  if (smaller) return { mimeType: "image/jpeg", data: smaller.toString("base64") };
  return { mimeType: shot.mimeType, data: data.toString("base64") };
}

/** A value that is a plain object (not an array), as a record; otherwise null. */
function plainObject(value: unknown): Record<string, unknown> | null {
  return isJsonObject(value) ? value : null;
}

async function readJson(file: string, within: string): Promise<Record<string, unknown> | null> {
  const resolved = await realpath(file).catch(() => null);
  if (!resolved || !isBelow(within, resolved)) return null;
  const st = await lstat(resolved).catch(() => null);
  if (!st?.isFile() || st.size > JOB_JSON_MAX) return null;
  const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  const cached = jobJsonCache.get(resolved);
  if (cached?.stamp === stamp) {
    jobJsonCache.delete(resolved);
    jobJsonCache.set(resolved, cached);
    return structuredClone(cached.value);
  }
  const raw = await readFile(resolved, "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = plainObject(JSON.parse(raw) as unknown);
    if (!parsed) return null;
    const value = inventoryRecord(parsed, path.basename(file));
    cacheJobRecord(resolved, stamp, value);
    return structuredClone(value);
  } catch {
    return null;
  }
}

/** Keep inventory fields only: never approval images or unrelated provider response bodies. */
function inventoryRecord(value: Record<string, unknown>, name: string): Record<string, unknown> {
  if (name === "request.json") return { prompt: requestPrompt(value) };
  const fields = [
    "id",
    "project",
    "files",
    "manifest",
    "preferredFile",
    "use",
    "operation",
    "status",
    "generationId",
    "createdAt",
    "state",
    "inputs",
  ];
  return Object.fromEntries(fields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function cacheJobRecord(file: string, stamp: string, value: Record<string, unknown>): void {
  jobCacheBytes -= jobJsonCache.get(file)?.bytes ?? 0;
  jobJsonCache.delete(file);
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > JOB_CACHE_BYTES) return;
  jobJsonCache.set(file, { stamp, value, bytes });
  jobCacheBytes += bytes;
  while (jobJsonCache.size > JOB_CACHE_MAX || jobCacheBytes > JOB_CACHE_BYTES) {
    const oldest = jobJsonCache.keys().next().value;
    if (oldest === undefined) break;
    jobCacheBytes -= jobJsonCache.get(oldest)?.bytes ?? 0;
    jobJsonCache.delete(oldest);
  }
}

/** The named fields of a record that hold strings, and only those, in the order named. */
function stringFields<K extends string>(
  record: Record<string, unknown>,
  keys: readonly K[],
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

const isVariant = (value: unknown): value is { role: string; url: string; bytes?: unknown } =>
  Boolean(value) &&
  typeof (value as { role?: unknown }).role === "string" &&
  typeof (value as { url?: unknown }).url === "string";

/** A job's variant manifest, keeping only well-formed entries. */
function jobManifest(value: unknown): ProjectAsset["variants"] {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(isVariant)
    .map((v) => ({ role: v.role, url: v.url, ...(typeof v.bytes === "number" ? { bytes: v.bytes } : {}) }));
}

/** The prompt a job was asked with, clipped; the request may wrap it in `request`. */
function requestPrompt(request: Record<string, unknown> | null): string | undefined {
  const requested =
    request?.request && typeof request.request === "object" ? (request.request as Record<string, unknown>) : request;
  return typeof requested?.prompt === "string" ? requested.prompt.slice(0, PROMPT_MAX) : undefined;
}

/** One job folder's record, when it is this project's and named by its own id. */
async function readGenexJob(jobsRoot: string, name: string, project: string): Promise<AssetJobRecord | null> {
  if (!UUID.test(name)) return null;
  const dir = await realpath(path.join(jobsRoot, name)).catch(() => null);
  if (!dir || !isBelow(jobsRoot, dir)) return null;
  const record = await readJson(path.join(dir, "job.json"), dir);
  const thisProjectsJob = record?.id === name && record.project === project;
  if (!thisProjectsJob) return null;
  const files = Array.isArray(record.files) ? record.files.filter((f): f is string => typeof f === "string") : [];
  const prompt = requestPrompt(await readJson(path.join(dir, "request.json"), dir));
  const use = plainObject(record.use) as ProjectAsset["use"] | null;
  return {
    id: name,
    files,
    manifest: jobManifest(record.manifest),
    preferredFile: typeof record.preferredFile === "string" ? record.preferredFile : undefined,
    ...stringFields(record, ["operation", "status", "generationId", "createdAt"]),
    ...(prompt ? { prompt } : {}),
    ...(use ? { use } : {}),
  };
}

/**
 * The Genex plugin's own job records for one project. Read-only and contained: the folder name
 * must be the job's id, the record must name this project, and nothing outside the job folder
 * is followed. `approval` never leaves this function — it holds base64 candidate images.
 */
export async function readGenexJobs(engineHomes: string, project: string): Promise<AssetJobRecord[]> {
  const root = genexJobDir(engineHomes, project, NO_JOB);
  if (!root) return [];
  const jobsRoot = await realpath(path.dirname(root)).catch(() => null);
  if (!jobsRoot) return [];
  const names = await readdir(jobsRoot).catch(() => [] as string[]);
  const jobs: AssetJobRecord[] = [];
  for (const name of names.sort()) {
    const job = await readGenexJob(jobsRoot, name, project);
    if (job) jobs.push(job);
  }
  return jobs;
}

interface Delivered {
  source: AssetSource;
  pluginId?: string;
  jobId: string;
  at?: string;
  render?: string | null;
  renderFront?: string | null;
  runId?: string;
  facetId?: string;
  iteration?: number;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** A delivery record's word for one of its files. */
function deliveryOf(payload: Record<string, unknown>): Delivered {
  const pluginId = str(payload.pluginId);
  const at = str(payload.at);
  const runId = str(payload.runId);
  const facetId = str(payload.facetId);
  return {
    source: str(payload.source) ?? "imported",
    ...(pluginId ? { pluginId } : {}),
    jobId: str(payload.jobId) ?? "",
    ...(at ? { at } : {}),
    ...(payload.render !== undefined ? { render: (payload.render as string | null) ?? null } : {}),
    ...(payload.renderFront !== undefined ? { renderFront: (payload.renderFront as string | null) ?? null } : {}),
    ...(runId ? { runId } : {}),
    ...(facetId ? { facetId } : {}),
    ...(typeof payload.iteration === "number" ? { iteration: payload.iteration } : {}),
  };
}

/** What the project's log says about where its files came from: deliveries, and Blender models. */
interface LedgerOrigins {
  delivered: Map<string, Delivered>;
  blender: Map<string, Record<string, unknown>>;
}

function ledgerOrigins(ledger: readonly EventEnvelope[], project: string): LedgerOrigins {
  const origins: LedgerOrigins = { delivered: new Map(), blender: new Map() };
  for (const event of ledger) {
    if (event.data.type !== EventKind.Custom) continue;
    const payload = event.data.payload as Record<string, unknown> | undefined;
    if (!payload || payload.project !== project) continue;
    if (event.data.event_type === CustomEvent.AssetDelivered) noteDelivery(origins, payload);
    else if (event.data.event_type === CustomEvent.BlenderAsset) noteBlenderModel(origins, payload);
  }
  return origins;
}

function noteDelivery(origins: LedgerOrigins, payload: Record<string, unknown>): void {
  const files = Array.isArray(payload.files) ? payload.files : [];
  for (const raw of files) {
    const file = str((raw as Record<string, unknown> | undefined)?.file);
    if (file) origins.delivered.set(file, deliveryOf(payload));
  }
}

function noteBlenderModel(origins: LedgerOrigins, payload: Record<string, unknown>): void {
  const file = str(payload.file);
  if (payload.ok === true && file) origins.blender.set(file, payload);
}

function applyDelivery(asset: ProjectAsset, record: Delivered): void {
  asset.source = record.source;
  if (record.jobId) asset.jobId = record.jobId;
  if (record.at) asset.at = record.at;
  if (record.render !== undefined) asset.render = record.render;
  if (record.renderFront !== undefined) asset.renderFront = record.renderFront;
  if (record.runId) asset.runId = record.runId;
  if (record.facetId) asset.facetId = record.facetId;
  if (record.iteration !== undefined) asset.iteration = record.iteration;
}

function applyBlenderModel(asset: ProjectAsset, model: Record<string, unknown>): void {
  asset.source = "blender";
  const name = str(model.name);
  if (name) asset.jobId = name;
  const at = str(model.at);
  if (at) asset.at = at;
  asset.render = (model.render as string | null) ?? null;
  asset.renderFront = (model.renderFront as string | null) ?? null;
  const runId = str(model.runId);
  if (runId) asset.runId = runId;
  const facetId = str(model.facetId);
  if (facetId) asset.facetId = facetId;
  if (typeof model.iteration === "number") asset.iteration = model.iteration;
}

/**
 * The shape a delivery leaves behind: `assets/<plugin id>/<job uuid>/…`. Inference, and
 * the card must not claim a job status it never read.
 */
function inferredOrigin(file: string): { source: string; jobId: string } | null {
  const parts = file.replace(/^public\//, "").split("/");
  const [top, pluginId = "", jobId = ""] = parts;
  if (top !== "assets" || parts.length <= 3) return null;
  if (!isPluginId(pluginId) || !UUID.test(jobId)) return null;
  return { source: pluginId, jobId };
}

function applyJobRecord(asset: ProjectAsset, job: AssetJobRecord): void {
  if (job.operation) asset.operation = job.operation;
  if (job.status) asset.pluginStatus = job.status;
  if (job.generationId) asset.generationId = job.generationId;
  if (job.prompt) asset.prompt = job.prompt;
  if (job.use) asset.use = job.use;
  if (!asset.at && job.createdAt) asset.at = job.createdAt;
  if (!asset.jobId) asset.jobId = job.id;
}

/** Everything the join knows about origins, indexed. */
interface AssetOrigins extends LedgerOrigins {
  jobByFile: Map<string, AssetJobRecord>;
  jobById: Map<string, AssetJobRecord>;
}

/** Where one file came from, by the first source that knows (see `joinProjectAssets`). */
function applyOrigin(
  asset: ProjectAsset,
  origins: AssetOrigins,
  record: Delivered | undefined,
  fileJob: AssetJobRecord | undefined,
): void {
  if (record) {
    applyDelivery(asset, record);
    return;
  }
  if (fileJob) {
    asset.source = "genex";
    asset.jobId = fileJob.id;
    return;
  }
  const model = origins.blender.get(asset.file);
  if (model) {
    applyBlenderModel(asset, model);
    return;
  }
  const inferred = inferredOrigin(asset.file);
  if (inferred) {
    asset.source = inferred.source;
    asset.jobId = inferred.jobId;
  }
}

function assetFrom(entry: AssetEntry, origins: AssetOrigins): ProjectAsset {
  const asset: ProjectAsset = {
    file: entry.file,
    kind: assetKind(entry.file),
    bytes: entry.bytes,
    mtime: entry.mtime,
    source: "imported",
  };
  const record = origins.delivered.get(entry.file);
  const fileJob = origins.jobByFile.get(entry.file);
  const job = fileJob ?? (record?.jobId ? origins.jobById.get(record.jobId) : undefined);
  applyOrigin(asset, origins, record, fileJob);
  if (job) applyJobRecord(asset, job);
  return asset;
}

/** Newest first, by when it arrived (or its own time), then by name. */
function newestFirst(a: ProjectAsset, b: ProjectAsset): number {
  const left = a.at ?? a.mtime;
  const right = b.at ?? b.mtime;
  if (left !== right) return left < right ? 1 : -1;
  return byText(a.file, b.file);
}

/**
 * Where each file on disk came from. The walk is the truth about existence — a ledger entry for
 * a file nobody can find is not an asset — and the ledger is the truth about origin, in this
 * order: the host's own delivery record, the plugin's job record, a Blender model, the
 * `assets/<plugin>/<job>/` shape a delivery leaves behind, and otherwise a file someone dropped in.
 */
export function joinProjectAssets({
  project,
  entries,
  ledger,
  jobs,
  truncated = false,
  skipped = [],
}: {
  project: string;
  entries: readonly AssetEntry[];
  ledger: readonly EventEnvelope[];
  jobs: readonly AssetJobRecord[];
  truncated?: boolean;
  skipped?: ReadonlyArray<{ file: string; why: string }>;
}): ProjectAssets {
  const origins: AssetOrigins = { ...ledgerOrigins(ledger, project), jobByFile: new Map(), jobById: new Map() };
  for (const job of jobs) {
    origins.jobById.set(job.id, job);
    for (const file of job.files) origins.jobByFile.set(file, job);
  }
  const assets = entries.map((entry) => assetFrom(entry, origins));
  assets.sort(newestFirst);
  return { project, assets, truncated, skipped: [...skipped] };
}

/**
 * One image from inside a contained folder, as bytes the renderer can show. Every gate the
 * reference reader has and one more: the relative path is validated before it is joined, the
 * prefix must be an asset folder, a link is refused rather than followed, and the bytes name
 * the type — a renamed file renders as what it is or not at all.
 */
export async function readContainedImage(
  base: string,
  file: string,
  {
    prefixes = ["assets/", "public/assets/"],
    maxBytes = IMAGE_MAX_BYTES,
    resize,
  }: { prefixes?: readonly string[]; maxBytes?: number; resize?: (data: Buffer) => Promise<Buffer> } = {},
): Promise<{ mimeType: string; data: string } | null> {
  try {
    assertRelativePath(file);
  } catch {
    return null;
  }
  if (prefixes.length && !prefixes.some((prefix) => file.startsWith(prefix))) return null;
  if (!isImageFile(file)) return null;
  const root = await realpath(base).catch(() => null);
  if (!root) return null;
  const target = path.join(root, ...file.split("/"));
  const st = await lstat(target).catch(() => null);
  const readable = st?.isFile() && !st.isSymbolicLink() && st.size <= maxBytes;
  if (!readable) return null;
  const resolved = await realpath(target).catch(() => null);
  if (resolved !== target) return null;
  const data = await readFile(resolved).catch(() => null);
  if (!data) return null;
  const sniffed = sniffImage(data);
  if (!sniffed) return null;
  if (resize) {
    const smaller = await resize(data).catch(() => null);
    if (smaller) return { mimeType: "image/jpeg", data: smaller.toString("base64") };
  }
  return { mimeType: sniffed.mimeType, data: data.toString("base64") };
}

/** Re-exported so callers that only touch this module keep one import. */
export type { AssetKind, ProjectAsset, ProjectAssets };

/** Retained originals remain discoverable when a worker moved or removed its delivered copy.
 * Hash joins preserve provenance for renamed local files. No remote call or generation is made.
 */
const assetHashes = new Map<string, { stamp: string; hash: string }>();
async function assetDigest(file: string): Promise<string> {
  const st = await lstat(file);
  const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  const cached = assetHashes.get(file);
  if (cached?.stamp === stamp) {
    assetHashes.delete(file);
    assetHashes.set(file, cached);
    return cached.hash;
  }
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  const value = hash.digest("hex");
  assetHashes.delete(file);
  assetHashes.set(file, { stamp, hash: value });
  while (assetHashes.size > DIGEST_CACHE_MAX) {
    const oldest = assetHashes.keys().next().value;
    if (oldest !== undefined) assetHashes.delete(oldest);
  }
  return value;
}
export interface AssetWorkspace {
  id: string;
  root: string;
  scope: "project" | "integration" | "worker";
  revision?: string;
}

type AssetDelivery = AssetAvailability["deliveries"][number];

/** Every asset copy in the run worktrees, by content hash. */
async function workspaceCopiesByHash(workspaces: readonly AssetWorkspace[]): Promise<Map<string, AssetDelivery[]>> {
  const copies = new Map<string, AssetDelivery[]>();
  for (const workspace of workspaces) {
    for (const entry of (await walkGameAssets(workspace.root)).entries) {
      const hash = await assetDigest(path.join(workspace.root, entry.file));
      copies.set(hash, [
        ...(copies.get(hash) ?? []),
        {
          workspaceId: workspace.id,
          scope: workspace.scope,
          relativePath: entry.file,
          present: true,
          revision: workspace.revision,
        },
      ]);
    }
  }
  return copies;
}

/** The game folder's own assets, by content hash (only files that really are inside it). */
async function projectCopiesByHash(
  root: string,
  assets: readonly ProjectAsset[],
): Promise<Map<string, ProjectAsset[]>> {
  const hashes = new Map<string, ProjectAsset[]>();
  const resolvedRoot = await realpath(root);
  for (const asset of assets) {
    const file = await realpath(path.join(root, asset.file)).catch(() => null);
    if (!file || !isBelow(resolvedRoot, file)) continue;
    const hash = await assetDigest(file);
    hashes.set(hash, [...(hashes.get(hash) ?? []), asset]);
  }
  return hashes;
}

/** What the reconcile is joining: the inventory, and every copy it has found so far. */
interface Reconcile {
  inventory: ProjectAssets;
  engineHomes: string;
  workspaces: readonly AssetWorkspace[];
  deliveries: readonly AssetDeliveryRecord[];
  workspaceCopies: Map<string, AssetDelivery[]>;
  hashes: Map<string, ProjectAsset[]>;
  seen: Set<string>;
}

/** Recorded deliveries of these bytes that are neither in the game folder nor in a worktree now. */
function missingDeliveries(ctx: Reconcile, hash: string, copies: readonly ProjectAsset[]): AssetDelivery[] {
  const inWorkspaces = ctx.workspaceCopies.get(hash) ?? [];
  const elsewhere = (file: string) =>
    copies.some((a) => a.file === file) || inWorkspaces.some((c) => c.relativePath === file);
  return ctx.deliveries
    .filter((r) => r.project === ctx.inventory.project)
    .flatMap((r) => {
      const workspace = ctx.workspaces.find((w) => w.root === r.workspace);
      return r.files
        .filter((f) => f.sha256 === hash && !elsewhere(f.path))
        .map((f) => ({
          workspaceId: workspace?.id ?? `delivery:${r.id}`,
          scope: workspace?.scope ?? ("project" as const),
          relativePath: f.path,
          present: false,
          revision: r.revision,
        }));
    });
}

function genexAvailability(
  ctx: Reconcile,
  job: AssetJobRecord,
  identity: string,
  hash: string,
  copies: readonly ProjectAsset[],
): AssetAvailability {
  return {
    assetId: identity,
    generationId: job.generationId,
    originalAvailable: true,
    deliveries: [
      ...copies.map((a) => ({
        workspaceId: ctx.inventory.project,
        scope: "project" as const,
        relativePath: a.file,
        present: true,
      })),
      ...(ctx.workspaceCopies.get(hash) ?? []),
      ...missingDeliveries(ctx, hash, copies),
    ],
    usage: "unverified" as const,
  };
}

/** One retained Genex original: joined onto its copies in the game, or listed on its own. */
async function joinGenexOutput(ctx: Reconcile, job: AssetJobRecord, output: string, name: string): Promise<void> {
  if (name.startsWith(".")) return;
  const file = path.join(output, name);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) return;
  const hash = await assetDigest(file);
  const identity = `genex:${job.generationId ?? job.id}:${hash}`;
  if (ctx.seen.has(identity)) return;
  ctx.seen.add(identity);
  const copies = ctx.hashes.get(hash) ?? [];
  const availability = genexAvailability(ctx, job, identity, hash, copies);
  if (copies.length) {
    for (const asset of copies)
      Object.assign(asset, {
        source: "genex",
        jobId: job.id,
        generationId: job.generationId,
        prompt: job.prompt,
        operation: job.operation,
        variants: job.manifest,
        preferredFile: job.preferredFile,
        availability,
        ...(job.status ? { pluginStatus: job.status } : {}),
      });
    return;
  }
  ctx.inventory.assets.push({
    file: job.files.find((f) => path.basename(f) === name) ?? `assets/genex/${job.id}/${name}`,
    assetRef: genexRef(job.id, name),
    kind: assetKind(name),
    bytes: info.size,
    mtime: info.mtime.toISOString(),
    source: "genex",
    jobId: job.id,
    generationId: job.generationId,
    prompt: job.prompt,
    operation: job.operation,
    variants: job.manifest,
    preferredFile: job.preferredFile,
    at: job.createdAt,
    availability,
    ...(job.status ? { pluginStatus: job.status } : {}),
  });
}

/** Every retained original of one Genex job, when its output folder is exactly where it should be. */
async function joinGenexJob(ctx: Reconcile, job: AssetJobRecord): Promise<void> {
  const dir = genexJobDir(ctx.engineHomes, ctx.inventory.project, job.id);
  if (!dir) return;
  const output = path.join(dir, "output");
  const resolved = await realpath(output).catch(() => null);
  const expected = path.join(
    await realpath(ctx.engineHomes),
    "genex",
    "projects",
    ctx.inventory.project,
    "jobs",
    job.id,
    "output",
  );
  if (resolved !== expected) return;
  for (const name of await readdir(output).catch(() => [] as string[])) await joinGenexOutput(ctx, job, output, name);
}

/** A completed host-native Blender job, as far as the reconcile reads it. */
interface NativeJob {
  project?: unknown;
  state?: unknown;
  files: string[];
  inputs?: { model?: { sha256?: unknown } };
}

async function readNativeJob(directory: string, project: string): Promise<NativeJob | null> {
  if ((await realpath(directory).catch(() => null)) !== directory) return null;
  const job = (await readJson(path.join(directory, "job.json"), directory)) as NativeJob | null;
  const completed = job?.project === project && job.state === "completed" && Array.isArray(job.files);
  return completed ? job : null;
}

/** The input a native job staged: its hash, and the retained asset holding those bytes when there is one. */
interface NativeSource {
  hash: unknown;
  asset: ProjectAsset | undefined;
}

function nativeSource(job: NativeJob, assets: readonly ProjectAsset[]): NativeSource {
  const hash = job.inputs?.model?.sha256;
  const asset = typeof hash === "string" ? assets.find((a) => a.availability?.assetId.endsWith(`:${hash}`)) : undefined;
  return { hash, asset };
}

/** What a native derivative was made from: the retained original's identity, or its hash. */
function derivedFromOf(source: NativeSource): string | undefined {
  const retained = source.asset?.availability?.assetId;
  if (retained) return retained;
  return SHA256_HEX.test(String(source.hash ?? "")) ? `sha256:${source.hash}` : undefined;
}

async function joinNativeFile(
  ctx: Reconcile,
  directory: string,
  id: string,
  name: string,
  source: NativeSource,
): Promise<void> {
  assertRelativePath(name);
  const file = path.join(directory, "delivery", name);
  const contained = (await realpath(file)) === file && (await lstat(file)).isFile();
  if (!contained) return;
  const hash = await assetDigest(file);
  for (const asset of ctx.hashes.get(hash) ?? []) {
    asset.source = "blender";
    asset.jobId = id;
    asset.derivedFrom = derivedFromOf(source);
    asset.availability = {
      assetId: `blender:${id}:${hash}`,
      originalAvailable: true,
      deliveries: [{ workspaceId: ctx.inventory.project, scope: "project", relativePath: asset.file, present: true }],
      usage: "unverified",
    };
  }
}

/**
 * Host-native records bind derivatives to the bytes staged for their job, even if the
 * input was renamed or its project copy subsequently disappeared.
 */
async function joinNativeDerivatives(ctx: Reconcile): Promise<void> {
  const nativeRoot = path.join(ctx.engineHomes, "plugins", "data", "blender", "native-jobs");
  const nativeCanonical = await realpath(nativeRoot).catch(() => null);
  for (const id of await readdir(nativeRoot).catch(() => [] as string[])) {
    if (!UUID.test(id) || !nativeCanonical) continue;
    const directory = path.join(nativeCanonical, id);
    const job = await readNativeJob(directory, ctx.inventory.project);
    if (!job) continue;
    const source = nativeSource(job, ctx.inventory.assets);
    for (const name of job.files) {
      try {
        await joinNativeFile(ctx, directory, id, name, source);
      } catch {
        /* One missing or invalid output must not hide other retained assets. */
      }
    }
  }
}

/** A renamed copy is one asset with multiple deliveries, not a second generation. */
function oneAssetPerId(assets: readonly ProjectAsset[]): ProjectAsset[] {
  const canonical = new Set<string>();
  return assets.filter((asset) => {
    const id = asset.availability?.assetId;
    if (!id) return true;
    if (canonical.has(id)) return false;
    canonical.add(id);
    return true;
  });
}

/** A Genex file whose original is gone still gets an identity, marked unavailable. */
function markUnretainedGenex(inventory: ProjectAssets): void {
  for (const asset of inventory.assets) {
    if (asset.availability || asset.source !== "genex") continue;
    asset.availability = {
      assetId: `genex:${asset.generationId ?? asset.jobId}:${asset.file}`,
      generationId: asset.generationId,
      originalAvailable: false,
      deliveries: [{ workspaceId: inventory.project, scope: "project", relativePath: asset.file, present: true }],
      usage: "unverified",
    };
  }
}

/** Jobs with no file in the game yet, one per generation. */
function pendingGenexJobs(assets: readonly ProjectAsset[], jobs: readonly AssetJobRecord[]): ProjectAssets["jobs"] {
  const completed = new Set(assets.map((a) => a.generationId).filter(Boolean));
  const pending = new Map<string, AssetJobRecord>();
  for (const job of jobs) {
    const landed = completed.has(job.generationId) || assets.some((a) => a.jobId === job.id);
    if (!landed) pending.set(job.generationId ?? job.id, job);
  }
  return [...pending.values()].map((j) => ({
    source: "genex",
    jobId: j.generationId ?? j.id,
    at: j.createdAt,
    operation: j.operation,
    prompt: j.prompt,
    ...(j.status ? { pluginStatus: j.status } : {}),
    ...(j.files.length ? { delivered: true } : {}),
  }));
}

export async function reconcileGeneratedAssets(
  root: string,
  engineHomes: string,
  inventory: ProjectAssets,
  jobs: readonly AssetJobRecord[],
  workspaces: AssetWorkspace[] = [],
  deliveries: readonly AssetDeliveryRecord[] = [],
): Promise<ProjectAssets> {
  const ctx: Reconcile = {
    inventory,
    engineHomes,
    workspaces,
    deliveries,
    workspaceCopies: await workspaceCopiesByHash(workspaces),
    hashes: await projectCopiesByHash(root, inventory.assets),
    seen: new Set(),
  };
  for (const job of jobs) await joinGenexJob(ctx, job);
  await joinNativeDerivatives(ctx);
  inventory.assets = oneAssetPerId(inventory.assets);
  markUnretainedGenex(inventory);
  inventory.jobs = pendingGenexJobs(inventory.assets, jobs);
  return inventory;
}

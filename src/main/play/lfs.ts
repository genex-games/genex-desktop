/**
 * A remix's Git LFS files over https, without git-lfs. The clone keeps each model as a pointer (its
 * SHA-256 and size); the game's own repository on Genex's git says where each object is (the Git
 * LFS batch API), each is downloaded once, and it takes its pointers' places only once its bytes
 * match. No git-lfs has to be installed, or found: an app opened from the Dock or the Start menu
 * never looks where Homebrew puts one. Only files the clone's attributes route through Git LFS
 * count, as git-lfs counts them, and every request is https, redirects included.
 */
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./gallery.ts";

/** The most objects one batch request asks for, as git-lfs asks. */
const BATCH_MAX_OBJECTS = 100;
/** How many objects download at once. */
const PARALLEL_DOWNLOADS = 4;
/** A pointer is smaller than this (the Git LFS spec): a bigger file is the file itself. */
const POINTER_MAX_BYTES = 1024;
/** How many bytes come between two reports of the models' download. */
const PROGRESS_STEP_BYTES = 1024 * 1024;
/** The Git LFS API's media type. */
const LFS_MEDIA_TYPE = "application/vnd.git-lfs+json";
/** The HTTP statuses that redirect. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** The most redirects one download follows. */
const MAX_REDIRECTS = 5;
/** Where a download is written until its bytes match: inside the clone's `.git`, which the copy drops. */
const PARTS_DIR = "genex-lfs";
/** A pointer as Git LFS writes it: the spec's version, a SHA-256 and a size, one per line. */
const POINTER =
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:([0-9a-f]{64})\r?\nsize (\d{1,15})\r?\n?$/;

const MESSAGE = {
  BatchFailed: (status: number) => `Genex’s git answered ${status} when asked for this game’s files`,
  BatchUnreadable: "Genex’s git’s answer about this game’s files couldn’t be read",
  BatchStalled: "Genex’s git stopped answering about this game’s files",
  ModelsMissing: (files: number) => `${files} of this game’s files didn’t download from Git LFS`,
  DownloadRefused: "A download address for this game’s files was refused",
  DownloadFailed: (status: number) => `A file of this game didn’t download (${status})`,
  Mismatch: "A file of this game didn’t match what its repository says it is",
  Stalled: "A file of this game stopped moving while it downloaded",
} as const;

/** The object a pointer stands for: its SHA-256 (lowercase hex) and its size in bytes. */
export interface LfsObject {
  oid: string;
  size: number;
}

/** A file of the clone that is a pointer, by its path in the clone. */
export interface LfsPointer extends LfsObject {
  file: string;
}

/** How the files are fetched: the network, who hears the bytes, and a guard against a stalled download. */
export interface LfsDownloadDeps {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** Which of these files (paths in the clone) its attributes route through Git LFS (`filter=lfs`). */
  routed(files: string[]): Promise<Set<string>>;
  /** Hears the bytes downloaded so far, of the total. */
  models(done: number, total: number): void;
  /** A guard whose signal aborts once its download has not `moved` for a while. */
  guard(): { signal: AbortSignal; moved: () => void; stop: () => void };
}

/** Where an object downloads from, as the batch API answered. */
interface LfsAction {
  href: string;
  header: Record<string, string>;
}

/** The object a pointer's text stands for, or null when the text is not exactly a pointer. */
export function parseLfsPointer(text: string): LfsObject | null {
  const match = POINTER.exec(text);
  if (!match?.[1] || !match[2]) return null;
  const size = Number(match[2]);
  return Number.isSafeInteger(size) ? { oid: match[1], size } : null;
}

/**
 * Every file of the clone in `dir` that is a pointer and that its attributes route through Git LFS
 * (`routed`), as git-lfs finds them. Its `.git` and its links are never read.
 */
export async function findLfsPointers(dir: string, routed: LfsDownloadDeps["routed"]): Promise<LfsPointer[]> {
  const pointers: LfsPointer[] = [];
  for (const file of await filesOf(dir)) {
    const full = path.join(dir, file);
    if ((await lstat(full)).size >= POINTER_MAX_BYTES) continue;
    const object = parseLfsPointer(await readFile(full, "utf8"));
    if (object) pointers.push({ file, ...object });
  }
  if (pointers.length === 0) return pointers;
  const inLfs = await routed(pointers.map((pointer) => pointer.file));
  return pointers.filter((pointer) => inLfs.has(pointer.file));
}

/** The plain files under `dir`, by their paths in it: no `.git`, and no link is followed. */
async function filesOf(dir: string, under = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(dir, under), { withFileTypes: true })) {
    const file = path.join(under, entry.name);
    if (!under && entry.name === ".git") continue;
    if (entry.isDirectory()) files.push(...(await filesOf(dir, file)));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

/**
 * Put the Git LFS files of the clone in `dir`, cloned from `repository`, in their pointers' places.
 * A download that fails leaves every pointer as it was; downloads under way stop before it is told.
 */
export async function downloadLfsFiles(dir: string, repository: string, deps: LfsDownloadDeps): Promise<void> {
  const pointers = await findLfsPointers(dir, deps.routed);
  if (pointers.length === 0) return;
  const objects = [...new Map(pointers.map(({ oid, size }) => [oid, { oid, size }])).values()];
  const actions = await locate(repository, objects, deps);
  const missing = pointers.filter((pointer) => !actions.has(pointer.oid)).length;
  if (missing) throw new Error(MESSAGE.ModelsMissing(missing));
  const parts = path.join(dir, ".git", PARTS_DIR);
  await mkdir(parts, { recursive: true });
  try {
    await downloadAll(objects, actions, parts, deps);
    for (const object of objects) await placeObject(dir, parts, object, pointers);
  } finally {
    await rm(parts, { recursive: true, force: true });
  }
}

/**
 * Where each object downloads from, asked of the repository's batch API a hundred at a time. Only
 * the objects asked for are kept, by the ids the pointers gave, never one the answer made up.
 */
async function locate(
  repository: string,
  objects: LfsObject[],
  deps: LfsDownloadDeps,
): Promise<Map<string, LfsAction>> {
  const actions = new Map<string, LfsAction>();
  for (let start = 0; start < objects.length; start += BATCH_MAX_OBJECTS) {
    const asked = objects.slice(start, start + BATCH_MAX_OBJECTS);
    const answered = await askBatch(repository, asked, deps);
    const wanted = new Set(asked.map((object) => object.oid));
    for (const item of answered) {
      const found = answerOf(item);
      if (found && wanted.has(found.oid)) actions.set(found.oid, found.action);
    }
  }
  return actions;
}

/** One batch request's answered objects. A server that stops answering is given up, as a stalled download is. */
async function askBatch(repository: string, asked: LfsObject[], deps: LfsDownloadDeps): Promise<unknown[]> {
  const guard = deps.guard();
  try {
    const response = await fetchHttps(deps.fetch, `${repository}/info/lfs/objects/batch`, {
      method: "POST",
      headers: { Accept: LFS_MEDIA_TYPE, "Content-Type": LFS_MEDIA_TYPE },
      body: JSON.stringify({ operation: "download", transfers: ["basic"], objects: asked, hash_algo: "sha256" }),
      signal: guard.signal,
    });
    if (!response.ok) throw new Error(MESSAGE.BatchFailed(response.status));
    const answered = await response.json().catch((error: unknown) => {
      if (guard.signal.aborted) throw error;
      return null;
    });
    if (!isRecord(answered) || !Array.isArray(answered.objects)) throw new Error(MESSAGE.BatchUnreadable);
    return answered.objects;
  } catch (error) {
    throw guard.signal.aborted ? new Error(MESSAGE.BatchStalled) : error;
  } finally {
    guard.stop();
  }
}

/**
 * Fetch `href`, following a redirect only to another https address with no user or password in
 * it: each hop is checked before it is requested, so a downgrade to plain http never is, and the
 * request's headers go no further than its own origin. A request with a body (the batch) follows
 * none.
 */
async function fetchHttps(fetch: LfsDownloadDeps["fetch"], href: string, init: RequestInit): Promise<Response> {
  let at = href;
  let request = init;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(at, { ...request, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get("location");
    const followable = init.body === undefined && location !== null && URL.canParse(location, at);
    if (!followable) throw new Error(MESSAGE.DownloadRefused);
    const next = safeHref(new URL(location, at).href);
    // The answer's headers (an Authorization) are for the host it named, never sent on to another.
    if (new URL(next).origin !== new URL(at).origin) request = { ...request, headers: undefined };
    at = next;
  }
  throw new Error(MESSAGE.DownloadRefused);
}

/** One answered object's download, or null when the server has none for it. A hostile address throws. */
function answerOf(item: unknown): { oid: string; action: LfsAction } | null {
  if (!isRecord(item) || typeof item.oid !== "string" || item.error !== undefined) return null;
  const download = isRecord(item.actions) ? item.actions.download : null;
  if (!isRecord(download)) return null;
  return { oid: item.oid, action: { href: safeHref(download.href), header: safeHeader(download.header) } };
}

/** A download address: https, with no user or password in it. */
function safeHref(href: unknown): string {
  const url = typeof href === "string" && URL.canParse(href) ? new URL(href) : null;
  const plain = url?.protocol === "https:" && !url.username && !url.password;
  if (!url || !plain) throw new Error(MESSAGE.DownloadRefused);
  return url.href;
}

/** A download's headers: text names to text values, or none. */
function safeHeader(header: unknown): Record<string, string> {
  if (header === undefined) return {};
  if (!isRecord(header)) throw new Error(MESSAGE.DownloadRefused);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(header)) {
    if (typeof value !== "string") throw new Error(MESSAGE.DownloadRefused);
    headers[name] = value;
  }
  return headers;
}

/**
 * Download every object into `parts`, a few at a time. The first failure stops the rest: the ones
 * under way are aborted and waited for, then the failure is told.
 */
async function downloadAll(
  objects: LfsObject[],
  actions: Map<string, LfsAction>,
  parts: string,
  deps: LfsDownloadDeps,
): Promise<void> {
  const total = objects.reduce((sum, object) => sum + object.size, 0);
  let done = 0;
  let told = 0;
  deps.models(0, total);
  const progress = (bytes: number) => {
    done += bytes;
    if (done - told < PROGRESS_STEP_BYTES && done !== total) return;
    told = done;
    deps.models(done, total);
  };
  const stop = new AbortController();
  const queue = [...objects];
  const failures: unknown[] = [];
  const worker = async () => {
    for (let object = queue.shift(); object && !stop.signal.aborted; object = queue.shift()) {
      const action = actions.get(object.oid);
      if (!action) continue;
      await downloadObject(object, action, parts, { ...deps, stop: stop.signal, progress }).catch((error: unknown) => {
        if (!stop.signal.aborted) failures.push(error);
        stop.abort();
      });
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_DOWNLOADS }, worker));
  if (failures.length) throw failures[0];
}

/** One object's download into `parts`, hashed and counted as it comes; kept only when it matches. */
async function downloadObject(
  object: LfsObject,
  action: LfsAction,
  parts: string,
  deps: LfsDownloadDeps & { stop: AbortSignal; progress: (bytes: number) => void },
): Promise<void> {
  const guard = deps.guard();
  const part = path.join(parts, object.oid);
  const file = await open(part, "w");
  try {
    const signal = AbortSignal.any([guard.signal, deps.stop]);
    const response = await fetchHttps(deps.fetch, action.href, { headers: action.header, signal });
    if (!response.ok || !response.body) throw new Error(MESSAGE.DownloadFailed(response.status));
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > object.size) throw new Error(MESSAGE.Mismatch);
      hash.update(chunk);
      await file.write(chunk);
      guard.moved();
      deps.progress(chunk.byteLength);
    }
    if (size !== object.size || hash.digest("hex") !== object.oid) throw new Error(MESSAGE.Mismatch);
  } catch (error) {
    throw guard.signal.aborted ? new Error(MESSAGE.Stalled) : error;
  } finally {
    guard.stop();
    await file.close();
  }
}

/** Put a downloaded object in the place of each pointer that stands for it. */
async function placeObject(dir: string, parts: string, object: LfsObject, pointers: LfsPointer[]): Promise<void> {
  const part = path.join(parts, object.oid);
  const [first, ...others] = pointers.filter((pointer) => pointer.oid === object.oid);
  for (const pointer of others) await copyFile(part, path.join(dir, pointer.file));
  if (first) await rename(part, path.join(dir, first.file));
}

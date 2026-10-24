import path from "node:path";
import { lstat, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import {
  type BuildPreviewFrame,
  type BuildPreviewRequest,
  type CaptureManifest,
  type CaptureProvenance,
  captureManifestOf,
  captureProvenanceOf,
} from "../shared/build-preview.ts";
import { atomicWriteFile, atomicWriteJson } from "./fsx.ts";
import { isBelow } from "./paths.ts";

/** The largest capture file the preview hands on; anything bigger is not one of ours. */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
/** The largest provenance sidecar or manifest read (`<capture>.provenance.json`, `<capture>.manifest.json`). */
const MAX_PROVENANCE_BYTES = 64 * 1024;
/** A capture's manifest file, beside its frame: `c3_default.jpg` → `c3_default.manifest.json`. */
const MANIFEST_SUFFIX = ".manifest.json";
/** A capture's provenance sidecar, beside its frame: `c3_default.jpg` → `c3_default.provenance.json`. */
const PROVENANCE_SUFFIX = ".provenance.json";
/** A capture's frame file extension. */
const FRAME_SUFFIX = /\.jpg$/;
/** A run or facet id as the preview accepts it: one plain path segment. */
const PLAIN_SEGMENT = /^[a-z0-9_-]+$/i;
/** A builder capture's file name: `c<sequence>_<camera>.jpg`. */
const CAPTURE_FILE = /^c(\d+)_(.+)\.jpg$/;
/** A capture that took no frame, saved alone: `c<sequence>.refused.json`. */
const REFUSED_FILE = /^c(\d+)\.refused\.json$/;
/** Why a capture folder is not written. */
const MESSAGE = {
  outside: (dir: string) => `the capture folder ${dir} is not inside the runs folder`,
  link: (dir: string) => `the capture folder ${dir} has a link or a file on its way: nothing is written through it`,
} as const;
/** A frame its computer session saved after a move: `s<sequence>_<what>.jpg`, seen as the default camera. */
const SESSION_FRAME = /^s(\d+)_.+\.jpg$/;
/** The camera a capture is taken with when the game names none; it wins a tie. */
const DEFAULT_CAMERA = "default";
/** Iteration folders are numbered to this many digits: `iter_007`. */
const ITERATION_DIGITS = 3;

/** The two numbered series a builder's pictures come in: its captures and its session's frames. */
const Series = { Capture: "capture", Session: "session" } as const;
type Series = (typeof Series)[keyof typeof Series];

interface Capture {
  name: string;
  sequence: number;
  camera: string;
  series: Series;
}

/** Read only what a builder saved: its captures and its computer session's frames. Never launch a renderer or touch a live worktree. */
export async function latestBuildPreview(
  runsRoot: string,
  request: BuildPreviewRequest,
): Promise<BuildPreviewFrame | null> {
  if (!isPlainRequest(request)) return null;
  try {
    const root = await realpath(runsRoot);
    const dir = await realpath(iterationDir(root, request));
    if (!isBelow(root, dir)) return null;
    const names = await readdir(dir);
    // A newer capture whose build failed: no older capture stands in for it.
    const refusedAt = await newestRefusal(dir, names);
    let newest: SavedFrame | null = null;
    for (const file of captures(names)) {
      if (file.series === Series.Capture && file.sequence < refusedAt) continue;
      const saved = await savedFrame(dir, file);
      if (saved && (!newest || newer(saved, newest))) newest = saved;
    }
    if (newest) {
      const frame = { path: newest.path, capturedAt: newest.mtime.toISOString(), camera: newest.file.camera };
      return { ...frame, ...(await savedBeside(dir, newest.file.name)) };
    }
  } catch {
    /* no capture yet */
  }
  return null;
}

/**
 * Saves `manifest` beside the capture `frame` (`c3_default.jpg` → `c3_default.manifest.json`),
 * whole or not at all; answers the manifest's path.
 */
export async function writeCaptureManifest(frame: string, manifest: CaptureManifest): Promise<string> {
  const file = frame.replace(FRAME_SUFFIX, MANIFEST_SUFFIX);
  await atomicWriteJson(file, manifest);
  return file;
}

/** Saves a capture's frame whole or not at all; a link planted at its name is replaced, never written through. */
export async function writeCaptureFrame(file: string, jpeg: Uint8Array): Promise<void> {
  await atomicWriteFile(file, jpeg);
}

/**
 * Saves the record of a capture that took no frame (`c<call>.refused.json` in `dir`): the folder's
 * newest capture is then that failure, and {@link latestBuildPreview} shows no older frame for it.
 */
export async function writeCaptureRefusal(dir: string, manifest: CaptureManifest): Promise<string> {
  const file = path.join(dir, `c${manifest.call}.refused.json`);
  await atomicWriteJson(file, manifest);
  return file;
}

/**
 * The capture folder `dir`, made and checked before the host writes into it: it must lie inside
 * `runsRoot`, and no folder on the way from there may be a link (or a file), because sandboxed
 * agents can write the runs folder and the host writing through a link they planted would land
 * outside every rule that holds them. Answers the folder as reached from the real runs root;
 * throws when it is not the run's own.
 */
export async function confinedCaptureDir(runsRoot: string, dir: string): Promise<string> {
  const relative = path.relative(path.resolve(runsRoot), path.resolve(dir));
  const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  if (!inside) throw new Error(MESSAGE.outside(dir));
  let current = await realpath(runsRoot);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    await mkdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(MESSAGE.link(dir));
  }
  return current;
}

/** The sequence of the newest capture in `dir` that took no frame, or 0; a record that does not check out is no refusal. */
async function newestRefusal(dir: string, names: string[]): Promise<number> {
  const sequences = names
    .flatMap((name) => {
      const [, sequence] = REFUSED_FILE.exec(name) ?? [];
      return sequence ? [{ name, sequence: Number(sequence) }] : [];
    })
    .sort((a, b) => b.sequence - a.sequence);
  for (const { name, sequence } of sequences) {
    const record = captureManifestOf(await besideJson(dir, name));
    if (record?.refused) return sequence;
  }
  return 0;
}
/**
 * What was saved beside a capture: its manifest and the provenance it carries, else a bare
 * provenance sidecar, else nothing (a folder saved before either was kept).
 */
async function savedBeside(
  dir: string,
  capture: string,
): Promise<{ manifest?: CaptureManifest; provenance?: CaptureProvenance }> {
  const manifest = captureManifestOf(await besideJson(dir, capture.replace(FRAME_SUFFIX, MANIFEST_SUFFIX)));
  if (manifest) return { manifest, provenance: manifest.provenance };
  const provenance = captureProvenanceOf(await besideJson(dir, capture.replace(FRAME_SUFFIX, PROVENANCE_SUFFIX)));
  return provenance ? { provenance } : {};
}

/**
 * A JSON file saved beside a capture, parsed, or null: one that is missing, a link out of the
 * capture's own folder, larger than the cap or not JSON is left out, never followed or trusted.
 */
async function besideJson(dir: string, name: string): Promise<unknown> {
  try {
    const target = await realpath(path.join(dir, name));
    if (!isBelow(dir, target)) return null;
    const info = await stat(target);
    if (!info.isFile() || info.size > MAX_PROVENANCE_BYTES) return null;
    return JSON.parse(await readFile(target, "utf8"));
  } catch {
    return null;
  }
}

/** A request whose ids are plain segments and whose iteration is a whole, non-negative number. */
function isPlainRequest(request: BuildPreviewRequest): boolean {
  if (!request) return false;
  const plainIds = PLAIN_SEGMENT.test(request.runId) && PLAIN_SEGMENT.test(request.facetId);
  return plainIds && Number.isSafeInteger(request.iteration) && request.iteration >= 0;
}

/** Where a builder's own captures for one iteration are saved. */
function iterationDir(root: string, request: BuildPreviewRequest): string {
  const iteration = `iter_${String(request.iteration).padStart(ITERATION_DIGITS, "0")}`;
  return path.join(root, request.runId, `facet_${request.facetId}`, "self", iteration);
}

/** A capture or session frame as saved: where it really is and when it was written. */
interface SavedFrame {
  file: Capture;
  path: string;
  mtime: Date;
}

/**
 * The file as saved, or null when it is not a usable picture or leads out of its own folder: a link
 * to another worker's or run's frame is not this one's.
 */
async function savedFrame(dir: string, file: Capture): Promise<SavedFrame | null> {
  const target = await realpath(path.join(dir, file.name)).catch(() => null);
  if (!target || !isBelow(dir, target)) return null;
  const info = await stat(target).catch(() => null);
  const usable = info?.isFile() && info.size > 0 && info.size <= MAX_CAPTURE_BYTES;
  return usable && info ? { file, path: target, mtime: info.mtime } : null;
}

/**
 * Is `a` the newer picture? In one series the higher number, then the default camera (one capture
 * writes every camera), then the name; between a capture and a session frame, the one written last.
 */
function newer(a: SavedFrame, b: SavedFrame): boolean {
  if (a.file.series !== b.file.series) return a.mtime.getTime() > b.mtime.getTime();
  const order =
    a.file.sequence - b.file.sequence ||
    Number(a.file.camera === DEFAULT_CAMERA) - Number(b.file.camera === DEFAULT_CAMERA) ||
    b.file.name.localeCompare(a.file.name);
  return order > 0;
}

/** The builder's pictures among `names`: its captures and its computer session's frames. */
function captures(names: string[]): Capture[] {
  return names.flatMap((name): Capture[] => {
    const [, sequence, camera] = CAPTURE_FILE.exec(name) ?? [];
    if (sequence && camera) return [{ name, sequence: Number(sequence), camera, series: Series.Capture }];
    const [, frame] = SESSION_FRAME.exec(name) ?? [];
    return frame ? [{ name, sequence: Number(frame), camera: DEFAULT_CAMERA, series: Series.Session }] : [];
  });
}

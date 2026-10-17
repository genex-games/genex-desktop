import path from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";
import type { BuildPreviewFrame, BuildPreviewRequest } from "../shared/build-preview.ts";
import { isBelow } from "./paths.ts";

/** The largest capture file the preview hands on; anything bigger is not one of ours. */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
/** A run or facet id as the preview accepts it: one plain path segment. */
const PLAIN_SEGMENT = /^[a-z0-9_-]+$/i;
/** A builder capture's file name: `c<sequence>_<camera>.jpg`. */
const CAPTURE_FILE = /^c(\d+)_(.+)\.jpg$/;
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
    let newest: SavedFrame | null = null;
    for (const file of captures(await readdir(dir))) {
      const saved = await savedFrame(root, dir, file);
      if (saved && (!newest || newer(saved, newest))) newest = saved;
    }
    if (newest) return { path: newest.path, capturedAt: newest.mtime.toISOString(), camera: newest.file.camera };
  } catch {
    /* no capture yet */
  }
  return null;
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

/** The file as saved, or null when it leads outside the runs or is not a usable picture. */
async function savedFrame(root: string, dir: string, file: Capture): Promise<SavedFrame | null> {
  const target = await realpath(path.join(dir, file.name)).catch(() => null);
  if (!target || !isBelow(root, target)) return null;
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

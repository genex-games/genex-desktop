/**
 * The Builds tab's pictures that are not a single read: the newest saved frame of a round still
 * being built, and the game's reference frames. Every still itself is read through `stills.ts`.
 */
import { useEffect, useMemo, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import type { ProjectAsset } from "../../shared/game-assets.ts";
import type { IterationNode, Shot } from "../run-graph.ts";
import { type CameraPair, camerasToCompare, frameDifference, savePointShot } from "../run-graph-pictures.ts";
import {
  type BuilderCapture,
  capturedBy,
  onStartingPoint,
  PictureSource,
  type RoundPicture,
  RoundPictureSource,
  type WorkerPicture,
} from "../run-steps.ts";
import { loadStill, type StillSource, useStill } from "../stills.ts";

/** How often a builder capture of a round in hand looks for a newer saved frame. */
const LIVE_FRAME_POLL_MS = 5 * SECOND_MS;
/** The size two frames are compared at: small enough to read fast, big enough to see a change. */
const COMPARE_W = 32;
const COMPARE_H = 18;
/** The largest side of the stills read for a comparison. */
const COMPARE_PX = 64;
/** A node's picture: the largest side read for it. */
const NODE_PICTURE_PX = 640;

/**
 * Reads now and, while `again`, once more `everyMs` after each read settles, until the returned
 * stop runs. `read` catches its own failures and checks `isCurrent()` before it keeps a result.
 */
export function pollWhile(
  read: (isCurrent: () => boolean) => Promise<void>,
  again: boolean,
  everyMs: number,
): () => void {
  let cancelled = false;
  let busy = false;
  const page = typeof document === "undefined" ? null : document;
  let hidden = page?.hidden ?? false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const isCurrent = () => !cancelled;
  const tick = async (): Promise<void> => {
    if (cancelled || hidden || busy) return;
    busy = true;
    try {
      await read(isCurrent);
    } finally {
      busy = false;
      if (!cancelled && !hidden && again) timer = setTimeout(() => void tick(), everyMs);
    }
  };
  const visibility = () => {
    const wasHidden = hidden;
    hidden = page?.hidden ?? false;
    if (hidden) clearTimeout(timer);
    else if (wasHidden) void tick();
  };
  page?.addEventListener("visibilitychange", visibility);
  void tick();
  return () => {
    cancelled = true;
    clearTimeout(timer);
    page?.removeEventListener("visibilitychange", visibility);
  };
}

const FINISHED_PREVIEW_CACHE_MAX = 128;
type BuildPreviewRequest = Parameters<typeof window.studio.buildPreview>[0];
type BuildPreview = Awaited<ReturnType<typeof window.studio.buildPreview>>;
const finishedPreviews = new Map<string, Promise<BuildPreview>>();

/** Share immutable finished-step lookups; active steps and missing pictures remain refreshable. */
export function readRoundPreview(request: BuildPreviewRequest, active: boolean): Promise<BuildPreview> {
  const key = JSON.stringify(request);
  if (active) {
    finishedPreviews.delete(key);
    return window.studio.buildPreview(request);
  }
  const cached = finishedPreviews.get(key);
  if (cached) {
    finishedPreviews.delete(key);
    finishedPreviews.set(key, cached);
    return cached;
  }
  const pending = window.studio.buildPreview(request).then(
    (frame) => {
      if (!frame && finishedPreviews.get(key) === pending) finishedPreviews.delete(key);
      return frame;
    },
    () => {
      if (finishedPreviews.get(key) === pending) finishedPreviews.delete(key);
      return null;
    },
  );
  finishedPreviews.set(key, pending);
  while (finishedPreviews.size > FINISHED_PREVIEW_CACHE_MAX) {
    const oldest = finishedPreviews.keys().next().value;
    if (oldest !== undefined) finishedPreviews.delete(oldest);
  }
  return pending;
}

/** A step's picture of its builds as a card shows it: the still, and whether it stands on the run's starting point. */
export interface RoundStill {
  src: string | null;
  onStart: boolean;
}

const NO_ROUND_STILL: RoundStill = { src: null, onStart: false };

/**
 * A builder's newest capture of its own round, read from its own folder — polled while the round
 * is in hand, because that frame changes as it works. A capture whose manifest names another
 * worker or run is never shown. A chat turn's graph (no run, `runIdOf` null) has no saved frames
 * to ask for.
 */
function useBuilderStill(runId: string | null, capture: BuilderCapture | null, live: boolean): RoundStill {
  const [still, setStill] = useState<RoundStill>(NO_ROUND_STILL);
  const worker = capture?.worker ?? null;
  const iteration = capture?.iteration ?? 0;
  const startCommit = capture?.start?.commit ?? null;
  const movedOnAt = capture?.start?.movedOnAt ?? null;
  useEffect(() => {
    setStill(NO_ROUND_STILL);
    const run = runId;
    if (!worker || !run) return;
    const start = startCommit && movedOnAt ? { commit: startCommit, movedOnAt } : null;
    const read = async (isCurrent: () => boolean): Promise<void> => {
      try {
        const frame = await readRoundPreview({ runId: run, facetId: worker, iteration }, live);
        if (!frame || !capturedBy(frame.manifest, run, worker)) return;
        const src = await loadStill({ run: frame.path, version: frame.capturedAt, maxPx: NODE_PICTURE_PX });
        if (isCurrent() && src) setStill({ src, onStart: onStartingPoint(frame.manifest, start) });
      } catch {
        /* no frame yet */
      }
    };
    return pollWhile(read, live, LIVE_FRAME_POLL_MS);
  }, [runId, worker, iteration, startCommit, movedOnAt, live]);
  return still;
}

/**
 * A step's picture of its builds (`run-steps.ts` `RoundPicture`): the judged frame, else its own
 * builder's newest capture, else none — never another worker's capture, such as that of the
 * attempt a restart replaced, and never an older one standing in for a build that showed nothing.
 */
export function useRoundPicture(runId: string | null, picture: RoundPicture | null, live: boolean): RoundStill {
  const judgedPath = picture?.source === RoundPictureSource.Judged ? picture.shot.path : null;
  const judged = useStill(judgedPath ? { run: judgedPath, maxPx: NODE_PICTURE_PX } : null);
  const builder = useBuilderStill(runId, picture?.source === RoundPictureSource.Builder ? picture : null, live);
  if (judgedPath) return { src: judged, onStart: false };
  return builder;
}

/**
 * A step's card picture through the shot its node wears (a save point's own camera,
 * `useSavePointShot`): that judged frame when there is one, else the step's own picture.
 */
export const throughShot = (picture: RoundPicture, shot: Shot | null): RoundPicture =>
  shot ? { source: RoundPictureSource.Judged, shot } : picture;

export interface ReferenceFrame {
  label: string;
  src: string;
}

export function useReferenceFrames(project: string | null, runId: string): ReferenceFrame[] {
  const [frames, setFrames] = useState<ReferenceFrame[]>([]);
  useEffect(() => {
    if (!project) {
      setFrames([]);
      return;
    }
    let cancelled = false;
    void window.studio
      .readReferenceStills(project)
      .then((result) => {
        if (cancelled) return;
        setFrames(
          result.frames.map((frame) => ({ label: frame.label, src: `data:${frame.mimeType};base64,${frame.data}` })),
        );
      })
      .catch(() => {
        if (!cancelled) setFrames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project, runId]);
  return frames;
}

/** Each pair of frames measured so far, by its two paths: a save point's frames never change. */
const measured = new Map<string, Promise<number | null>>();

/** A still's pixels at the comparison size, or null when it cannot be read or drawn. */
async function pixelsOf(path: string): Promise<Uint8ClampedArray | null> {
  const src = await loadStill({ run: path, maxPx: COMPARE_PX });
  if (!src || typeof document === "undefined") return null;
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = COMPARE_W;
  canvas.height = COMPARE_H;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, COMPARE_W, COMPARE_H);
  return context.getImageData(0, 0, COMPARE_W, COMPARE_H).data;
}

/** How much one camera's frame changed between two save points, once; null when either frame is missing. */
function changeOf(pair: CameraPair): Promise<number | null> {
  const key = `${pair.before}\n${pair.now}`;
  const known = measured.get(key);
  if (known) return known;
  const pending = Promise.all([pixelsOf(pair.before), pixelsOf(pair.now)])
    .then(([before, now]) => (before && now ? frameDifference(before, now) : null))
    .catch(() => null);
  measured.set(key, pending);
  return pending;
}

/**
 * The picture a round wears on its node: a save point's own (`savePointShot`: the one the lead
 * named, else its camera that changed most since `earlier`, measured here), any other round's
 * `thumbShot`. Null for none.
 */
export function useSavePointShot(node: IterationNode | null, earlier: IterationNode | null | undefined): Shot | null {
  const [changes, setChanges] = useState<ReadonlyMap<string, number>>(new Map());
  const pairs = useMemo(() => (node ? camerasToCompare(node, earlier) : []), [node, earlier]);
  // A save point's frames never change: the same pictures are measured once, whatever the graph's tick.
  const key = pairs.map((pair) => `${pair.before}\n${pair.now}`).join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairs are their key
  useEffect(() => {
    setChanges(new Map());
    if (!pairs.length) return;
    let cancelled = false;
    void Promise.all(pairs.map(async (pair) => [pair.camera, await changeOf(pair)] as const)).then((rows) => {
      if (cancelled) return;
      setChanges(new Map(rows.flatMap(([camera, change]) => (change === null ? [] : [[camera, change] as const]))));
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return node ? savePointShot(node, earlier, changes) : null;
}

/** What a worker's node shows: a still to draw, or an asset the Assets stage draws; `borrowed` for one not its own. */
export interface WorkerStill {
  src: string | null;
  asset: ProjectAsset | null;
  borrowed: boolean;
}

/** Where a worker's picture is read from, when it is a still. */
function workerStillSource(
  project: string | null,
  picture: WorkerPicture | undefined,
  reviewed: Shot | null,
): StillSource | null {
  if (picture?.source === PictureSource.File)
    return project ? { project, asset: picture.file, maxPx: NODE_PICTURE_PX } : null;
  if (picture?.source === PictureSource.Render) return { run: picture.path, maxPx: NODE_PICTURE_PX };
  return reviewed ? { run: reviewed.path, maxPx: NODE_PICTURE_PX } : null;
}

/**
 * A worker's picture (`run-steps.ts` `WorkerPicture`): a picture it delivered, its model as the
 * Assets stage draws it, or for a reader the save point it looked at, borrowed.
 */
export function useWorkerStill(project: string | null, picture: WorkerPicture | undefined): WorkerStill {
  const round = picture?.source === PictureSource.Reviewed ? picture.round : null;
  const reviewed = useSavePointShot(round, null);
  const src = useStill(workerStillSource(project, picture, reviewed));
  const asset = picture?.source === PictureSource.Asset && project ? picture.asset : null;
  return { src, asset, borrowed: round !== null };
}

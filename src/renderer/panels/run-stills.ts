/**
 * The Builds tab's pictures that are not a single read: the newest saved frame of a round still
 * being built. Every still itself is read through `stills.ts`.
 */
import { useContext, useEffect, useMemo, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import type { ProjectAsset } from "../../shared/game-assets.ts";
import { type IterationNode, type RunGraph, runIdOf, type Shot } from "../run-graph.ts";
import {
  type CameraPair,
  camerasToCompare,
  changedShare,
  frameDifference,
  savePointShot,
} from "../run-graph-pictures.ts";
import { PictureSource, type WorkerPicture } from "../run-steps.ts";
import { loadStill, type StillSource, StillsNear, useStill, useStillRead } from "../stills.ts";

/** How often a round still in hand looks for a newer saved frame. */
const LIVE_FRAME_POLL_MS = 5 * SECOND_MS;
/** The size two frames are compared at: small enough to read fast, big enough to see a change. */
const COMPARE_W = 32;
const COMPARE_H = 18;
/** The largest side of the stills read for a comparison. */
const COMPARE_PX = 64;
/** The size two pictures of one frame are measured at for a visible change: a small sprite still shows. */
const CHANGE_W = 160;
const CHANGE_H = 90;
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

/**
 * What a round looks like: its judged still when it has one, else the newest frame the builder
 * saved — polled while the round is in hand, because that frame changes as it works — at most
 * `maxPx` on its largest side.
 */
export function useRoundStill(
  graph: Pick<RunGraph, "runId">,
  facetId: string,
  iteration: number,
  shot: string | null,
  active: boolean,
  maxPx: number = NODE_PICTURE_PX,
): string | null {
  const judged = useStill(shot ? { run: shot, maxPx } : null);
  const [live, setLive] = useState<string | null>(null);
  // A Builds row far from the screen asks for no frame until it nears it.
  const near = useContext(StillsNear);
  // A chat turn's graph has no run whose saved frames could be asked for.
  const runId = runIdOf(graph);
  useEffect(() => {
    setLive(null);
    // No part named: nothing to ask for (a caller whose picture comes from elsewhere).
    if (shot || !facetId || !runId || !near) return;
    const read = async (isCurrent: () => boolean): Promise<void> => {
      try {
        const frame = await readRoundPreview({ runId, facetId, iteration }, active);
        const src = frame ? await loadStill({ run: frame.path, version: frame.capturedAt, maxPx }) : null;
        if (isCurrent() && src) setLive(src);
      } catch {
        /* no frame yet */
      }
    };
    return pollWhile(read, active, LIVE_FRAME_POLL_MS);
  }, [runId, facetId, iteration, shot, active, near, maxPx]);
  return judged ?? live;
}

/** Each pair of frames measured so far, by its two paths: a save point's frames never change. */
const measured = new Map<string, Promise<number | null>>();

/** A still's pixels at a size (the save points' comparison size by default), or null when it cannot be read or drawn. */
async function pixelsOf(
  path: string,
  size = { width: COMPARE_W, height: COMPARE_H, maxPx: COMPARE_PX },
): Promise<Uint8ClampedArray | null> {
  const src = await loadStill({ run: path, maxPx: size.maxPx });
  if (!src || typeof document === "undefined") return null;
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, size.width, size.height);
  return context.getImageData(0, 0, size.width, size.height).data;
}

/** Each pair of pictures measured for a visible change, by their two paths: a kept picture never changes. */
const shares = new Map<string, Promise<number | null>>();

/** The share of pixels that changed between two pictures under the run folder, once; null when either can't be read. */
function shareOf(before: string, now: string): Promise<number | null> {
  const key = `${before}\n${now}`;
  const known = shares.get(key);
  if (known) return known;
  const size = { width: CHANGE_W, height: CHANGE_H, maxPx: CHANGE_W };
  const pending = Promise.all([pixelsOf(before, size), pixelsOf(now, size)])
    .then(([a, b]) => (a && b ? changedShare(a, b) : null))
    .catch(() => null);
  shares.set(key, pending);
  return pending;
}

/**
 * How much `now` changed from `before`, two pictures of the same frame under the run folder
 * (`changedShare`): undefined while it is measured, null when either could not be read.
 */
export function usePictureChange(before: string | null, now: string | null): number | null | undefined {
  const [share, setShare] = useState<{ key: string; value: number | null } | null>(null);
  const key = before && now ? `${before}\n${now}` : "";
  useEffect(() => {
    if (!before || !now) return;
    let cancelled = false;
    void shareOf(before, now).then((value) => {
      if (!cancelled) setShare({ key: `${before}\n${now}`, value });
    });
    return () => {
      cancelled = true;
    };
  }, [before, now]);
  return share?.key === key ? share.value : undefined;
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
  /** its still is on its way: a skeleton stands in */
  loading: boolean;
}

/** Where a worker's picture is read from, when it is a still, at most `maxPx` on its largest side. */
export function workerStillSource(
  project: string | null,
  picture: WorkerPicture | undefined,
  reviewed: Shot | null,
  maxPx: number = NODE_PICTURE_PX,
): StillSource | null {
  if (picture?.source === PictureSource.File) return project ? { project, asset: picture.file, maxPx } : null;
  // A render, a kept copy and the merged build are files under the run's folder.
  if (picture && "path" in picture) return { run: picture.path, maxPx };
  return reviewed ? { run: reviewed.path, maxPx } : null;
}

/**
 * A worker's picture (`run-steps.ts` `WorkerPicture`): a picture it delivered, its model as the
 * Assets stage draws it, or for a reader the save point it looked at, borrowed.
 */
export function useWorkerStill(
  project: string | null,
  picture: WorkerPicture | undefined,
  maxPx: number = NODE_PICTURE_PX,
): WorkerStill {
  const round = picture?.source === PictureSource.Reviewed ? picture.round : null;
  const reviewed = useSavePointShot(round, null);
  const { src, loading } = useStillRead(workerStillSource(project, picture, reviewed, maxPx));
  const asset = picture?.source === PictureSource.Asset && project ? picture.asset : null;
  return { src, asset, borrowed: round !== null, loading };
}

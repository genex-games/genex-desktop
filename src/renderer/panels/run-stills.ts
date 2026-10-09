/**
 * The Builds tab's pictures that are not a single read: the newest saved frame of a round still
 * being built, and the game's reference frames. Every still itself is read through `stills.ts`.
 */
import { useEffect, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { type RunGraph, runIdOf } from "../run-graph.ts";
import { loadStill, useStill } from "../stills.ts";

/** How often a round still in hand looks for a newer saved frame. */
const LIVE_FRAME_POLL_MS = 5 * SECOND_MS;

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
 * saved — polled while the round is in hand, because that frame changes as it works.
 */
export function useRoundStill(
  graph: Pick<RunGraph, "runId">,
  facetId: string,
  iteration: number,
  shot: string | null,
  active: boolean,
): string | null {
  const judged = useStill(shot ? { run: shot, maxPx: 640 } : null);
  const [live, setLive] = useState<string | null>(null);
  // A chat turn's graph has no run whose saved frames could be asked for.
  const runId = runIdOf(graph);
  useEffect(() => {
    setLive(null);
    // No part named: nothing to ask for (a caller whose picture comes from elsewhere).
    if (shot || !facetId || !runId) return;
    const read = async (isCurrent: () => boolean): Promise<void> => {
      try {
        const frame = await readRoundPreview({ runId, facetId, iteration }, active);
        const src = frame ? await loadStill({ run: frame.path, version: frame.capturedAt, maxPx: 640 }) : null;
        if (isCurrent() && src) setLive(src);
      } catch {
        /* no frame yet */
      }
    };
    return pollWhile(read, active, LIVE_FRAME_POLL_MS);
  }, [runId, facetId, iteration, shot, active]);
  return judged ?? live;
}

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

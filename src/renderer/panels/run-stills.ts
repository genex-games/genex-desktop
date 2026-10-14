/**
 * The Builds tab's pictures that are not a single read: the newest saved frame of a round still
 * being built, and the game's reference frames. Every still itself is read through `stills.ts`.
 */
import { useEffect, useState } from "react";

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

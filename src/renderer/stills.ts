/**
 * Pictures the stage reads from main as data URLs, through one loader and one hook:
 *
 * - a run-folder still (`readRunStill`), cached per path and version;
 * - a run-level capture (`base`, `final`) that is written once, read again whenever its `retry`
 *   key changes and never cached, so a capture that did not exist yet is picked up later;
 * - a picture inside the game (`readProjectAsset`, contained and byte-checked), cached per game,
 *   file, size and version — a card asks for a thumbnail, the lightbox for the whole picture.
 *
 * The Builds timeline and the Assets stage both re-render on every log tick; the caches mean
 * neither reads the same file twice. Small pictures (a row's, a card's thumbnail) are read a few at a
 * time, so a list of thirty never asks main for thirty at once; a big one (the lightbox's) goes first.
 * Inside a `StillsNear` that says false, a picture not read yet waits until its place nears the screen.
 */
import { createContext, useContext, useEffect, useState } from "react";
import { createLane } from "./thumbnail-lanes.ts";

export type StillSource =
  | { run: string; version?: string | null; maxPx?: number }
  | { run: string; retry: string; maxPx?: number }
  | { project: string; asset: string; maxPx?: number; version?: string };

/** How many pictures stay in memory: a long Builds list's thumbnails and its open card's stills. */
const STILL_CACHE_MAX = 160;
/** A read of at most this many pixels on its largest side is a thumbnail, and waits its turn in the lane. */
const THUMBNAIL_MAX_PX = 256;
/** How many thumbnails main is asked for at once. */
const THUMBNAIL_LANE_WIDTH = 4;
/** The lane small pictures are read in; a full-size or unsized read skips it. */
const thumbnailLane = createLane(THUMBNAIL_LANE_WIDTH);

/**
 * Whether the pictures under it are near the screen. Pictures read through `useStill` under a false
 * value wait (one already read still shows at once); outside any provider every picture is near.
 */
export const StillsNear = createContext(true);
/** A read on its way, and its picture once it arrived. */
type StillEntry = { identity: string; pending: Promise<string | null>; value?: string };
const cache = new Map<string, StillEntry>();

const dataUrl = (still: { mimeType: string; data: string } | null): string | null =>
  still ? `data:${still.mimeType};base64,${still.data}` : null;

/** The cache key, or null for a source that is read fresh every time. */
function keyOf(source: StillSource): string | null {
  if ("asset" in source)
    return `asset ${source.project} ${source.asset}@${source.maxPx ?? "full"}${source.version ? `#${source.version}` : ""}`;
  if ("retry" in source) return null;
  return `run ${source.run}@${source.maxPx ?? "full"}#${source.version ?? ""}`;
}

/** Whether a read is a thumbnail, which waits its turn, rather than a picture someone opened. */
const isThumbnail = (source: StillSource): boolean => source.maxPx !== undefined && source.maxPx <= THUMBNAIL_MAX_PX;

function read(source: StillSource): Promise<string | null> {
  return isThumbnail(source) ? thumbnailLane(() => readNow(source)) : readNow(source);
}

function readNow(source: StillSource): Promise<string | null> {
  if ("asset" in source)
    return window.studio
      .readProjectAsset({
        project: source.project,
        file: source.asset,
        ...(source.maxPx ? { maxPx: source.maxPx } : {}),
      })
      .then(dataUrl);
  return window.studio.readRunStill(source.run, source.maxPx).then(dataUrl);
}

/** One picture as a data URL, or null when there is none (yet). Never rejects. */
export function loadStill(source: StillSource): Promise<string | null> {
  const key = keyOf(source);
  if (key === null) return read(source).catch(() => null);
  const found = cache.get(key);
  if (found) {
    cache.delete(key);
    cache.set(key, found);
    return found.pending;
  }
  const identity =
    "asset" in source
      ? JSON.stringify([source.project, source.asset, source.maxPx])
      : JSON.stringify([source.run, source.maxPx]);
  for (const [older, entry] of cache) if (entry.identity === identity) cache.delete(older);
  const pending = read(source).then(
    (value) => {
      const entry = cache.get(key);
      if (entry?.pending !== pending) return value;
      if (value) entry.value = value;
      else cache.delete(key);
      return value;
    },
    () => {
      if (cache.get(key)?.pending === pending) cache.delete(key);
      return null;
    },
  );
  cache.set(key, { identity, pending });
  while (cache.size > STILL_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return pending;
}

/** The picture already read for a cached source, there at once; undefined until its read answered. */
export function stillNow(source: StillSource): string | undefined {
  const key = keyOf(source);
  return key === null ? undefined : cache.get(key)?.value;
}

/** A picture as `useStillRead` has it: the picture, or null with whether its read is still on its way. */
export interface StillRead {
  src: string | null;
  /** true until the read answered (a picture not near the screen yet is on its way too) */
  loading: boolean;
}

/**
 * The same read as a hook, and whether it is still on its way, for a skeleton in its place. A
 * picture already read shows from the first frame, so a card that mounts again never pops it in; an
 * unread cached source starts blank when it changes; a `retry` source keeps showing the last
 * picture until the new read answers. Under a `StillsNear` that is false, the read waits.
 */
export function useStillRead(source: StillSource | null): StillRead {
  const near = useContext(StillsNear);
  const [read, setRead] = useState<{ key: string; src: string | null } | null>(null);
  const key = source ? JSON.stringify(source) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the source is its key
  useEffect(() => {
    if (!source || !key) {
      setRead(null);
      return;
    }
    if (!near && stillNow(source) === undefined) return;
    let cancelled = false;
    if (!("retry" in source)) setRead(null);
    void loadStill(source).then((value) => {
      if (!cancelled) setRead({ key, src: value });
    });
    return () => {
      cancelled = true;
    };
  }, [key, near]);
  const now = source ? stillNow(source) : undefined;
  if (now !== undefined) return { src: now, loading: false };
  if (!source) return { src: null, loading: false };
  // A `retry` source keeps the picture it showed while the next read is on its way.
  const kept = "retry" in source ? (read?.src ?? null) : null;
  if (read?.key === key) return { src: read.src, loading: false };
  return { src: kept, loading: true };
}

/** The picture alone, as most callers want it. */
export function useStill(source: StillSource | null): string | null {
  return useStillRead(source).src;
}

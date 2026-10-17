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
 * neither reads the same file twice.
 */
import { useEffect, useState } from "react";

export type StillSource =
  | { run: string; version?: string | null; maxPx?: number }
  | { run: string; retry: string; maxPx?: number }
  | { project: string; asset: string; maxPx?: number; version?: string };

const STILL_CACHE_MAX = 64;
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

function read(source: StillSource): Promise<string | null> {
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

/**
 * The same read as a hook. A picture already read shows from the first frame, so a card that
 * mounts again never pops it in; an unread cached source starts blank when it changes; a `retry`
 * source keeps showing the last picture until the new read answers.
 */
export function useStill(source: StillSource | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  const key = source ? JSON.stringify(source) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the source is its key
  useEffect(() => {
    if (!source) {
      setSrc(null);
      return;
    }
    let cancelled = false;
    if (!("retry" in source)) setSrc(null);
    void loadStill(source).then((value) => {
      if (!cancelled) setSrc(value);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return (source ? stillNow(source) : undefined) ?? src;
}

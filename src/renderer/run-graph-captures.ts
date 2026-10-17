/**
 * The pictures a run's observers kept (`observer_capture`), as the Builds graph carries them for
 * Live (`live-views.ts`): each capture's observer, source, label, files and time, oldest first.
 * Only a capture with pictures is kept, only the files it names by text, and only the newest few
 * of each observer. The paths are as the run recorded them; reading one is the run folder's gate
 * (`readRunStill`).
 */
import type { CapturedFile } from "../shared/observers.ts";
import { ObserverSource } from "../shared/observers.ts";

/** How many captures of one observer the graph keeps, newest last. */
const CAPTURES_PER_OBSERVER = 8;

/** One capture of a run: whose, from where, its label, its pictures and when. */
export interface CaptureInfo {
  observer: string;
  source: ObserverSource;
  label: string;
  files: CapturedFile[];
  at: string;
}

const SOURCES: ReadonlySet<string> = new Set(Object.values(ObserverSource));
const isSource = (value: unknown): value is ObserverSource => typeof value === "string" && SOURCES.has(value);

/** A picture entry named by text, else null. */
function fileOf(value: unknown): CapturedFile | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, file } = value as { name?: unknown; file?: unknown };
  if (typeof name !== "string" || typeof file !== "string" || !file) return null;
  return { name, file };
}

/** A capture record read for the graph; null for one with no observer, an unknown source or no picture. */
export function captureOf(payload: Record<string, unknown>, at: string): CaptureInfo | null {
  const { observer, source, label, images } = payload;
  if (typeof observer !== "string" || !observer || !isSource(source)) return null;
  const files = (Array.isArray(images) ? images : []).map(fileOf).filter((file) => file !== null);
  if (files.length === 0) return null;
  const when = typeof payload.at === "string" && payload.at ? payload.at : at;
  return { observer, source, label: typeof label === "string" ? label : observer, files, at: when };
}

/** A capture onto the run's list, dropping that observer's oldest beyond the cap. */
export function foldCapture(captures: CaptureInfo[], capture: CaptureInfo): void {
  captures.push(capture);
  const own = captures.filter((entry) => entry.observer === capture.observer);
  const extra = own.length - CAPTURES_PER_OBSERVER;
  for (const old of own.slice(0, Math.max(0, extra))) captures.splice(captures.indexOf(old), 1);
}

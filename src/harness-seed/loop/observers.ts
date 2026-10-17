/**
 * What Genex captures of a game for a reviewer: the plugins' observers through the host and Genex's
 * own web preview through the evidence pass, as one evidence shape.
 *
 * A `Capture` is what every reader takes: an observer's stills and its play recording's frames in
 * order, its note, or the problem that kept it from looking. The host keeps and records a plugin's
 * captures itself (`observers.capture`); the harness records the ones it made (the preview's and
 * the lead's proof) with `recordCaptures`, files only.
 */
import type { CapturedImage, DelegateImage, GameProject, ObserverCaptureResult } from "../types/host-api.d.ts";
import type { HarnessCtx, Run } from "../types/harness.d.ts";
import { type Evidence, gatherEvidence, type Shot } from "./evidence.ts";
import { OBSERVER_CAPTURE_EVENT, ObserverSource, PREVIEW_OBSERVER } from "./finish-contract.ts";
import { CoreFact, FACT_ROOT, type FactsOfDescriptor, servedFactsOf } from "./folder-facts.ts";
import { olderHost } from "./hooks.ts";
import { HostMethod } from "./host-methods.ts";
import { isRecord } from "./json.ts";
import { appendRun } from "./run-events.ts";

/** How many of the preview pass's camera shots a capture keeps as its stills. */
export const PREVIEW_STILLS = 3;
/** How many motion frames a capture keeps as its play recording. */
export const RECORDING_FRAMES = 6;
/** The plugins' observers together, in a capture that says why none of them could be asked. */
export const PLUGIN_OBSERVERS = "plugins";
/** The largest picture a reviewer is handed, in bytes: a provider refuses a larger one. */
export const REVIEW_PICTURE_MAX_BYTES = 3_750_000;
/** All the pictures of one review together at most, in bytes. */
export const REVIEW_IMAGES_MAX_BYTES = 20 * 1024 * 1024;

/** The preview pass's pictures are JPEGs. */
const PREVIEW_MIME = "image/jpeg";
/** Where the preview pass's pictures at a finish land among the run's shots. */
const PREVIEW_LABEL_PREFIX = "finish/preview";
/** The captures the harness records itself; the host records a plugin's and a checkpoint's. */
const RECORDED_HERE: ReadonlySet<ObserverSource> = new Set([ObserverSource.Preview, ObserverSource.Proof]);
/** A look that ran past its time. */
const LATE = Symbol("late");

/** What a capture says, a reviewer reads. */
const MESSAGE = {
  noTime: "no time to look",
  pluginsLabel: "The plugins' observers",
  olderHost: "this Genex can't run the plugins' observers",
  couldNotAsk: (why: string) => `couldn't ask the plugins' observers: ${why}`,
  previewLabel: (path: string) => (path === FACT_ROOT ? "The game's preview" : `The preview of ${path}`),
  noLook: "the preview gave back nothing to look at",
  couldNotLook: (why: string) => `couldn't look at the preview: ${why}`,
  still: (label: string, n: number, of: number) => `${label} ${n}/${of}`,
  play: (label: string, n: number, of: number) => `${label} play ${n}/${of}`,
} as const;

/** One picture of a capture: its name, its file when it was kept, and its pixels. */
export interface CaptureImage {
  name: string;
  file?: string;
  mimeType: string;
  data: string;
}

/** What an observer captured: its stills, its play recording's frames in order, a note, or why it could not. */
export interface Capture {
  observer: string;
  label: string;
  source: ObserverSource;
  images: CaptureImage[];
  recording: CaptureImage[];
  note?: string;
  problem?: string;
}

/** What a look reads of the game: its name, its folder and what the folder holds. */
export type ObservedGame = Pick<GameProject, "name" | "dir"> & NonNullable<FactsOfDescriptor>;

/**
 * The clock a look's deadline is read on: what time it is, and a wait a test may drive. Without a
 * wait, the deadline's race is a real timer of the time left by `now`.
 */
export interface ObserveClock {
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The game a look is for, its run and chat, the caller's own preview pass (a lease-aware one) and its clock, if any. */
export interface ObserveScope {
  run: Run;
  threadId: string;
  game: ObservedGame;
  previewPass?: (path: string) => Promise<Evidence | null>;
  clock?: ObserveClock;
}

/** The wall clock, when the caller has none of its own. */
const WALL_CLOCK: ObserveClock = { now: Date.now };

/** The scope's clock, or the wall clock. */
const clockOf = (scope: ObserveScope): ObserveClock => scope.clock ?? WALL_CLOCK;

/** A capture with nothing in it but why. */
function problemCapture(observer: string, label: string, source: ObserverSource, problem: string): Capture {
  return { observer, label, source, images: [], recording: [], problem };
}

/** A shot's or a frame's pixels, when it has any. */
const pixelsOf = (shot: Shot): string | null => (typeof shot.base64 === "string" && shot.base64 ? shot.base64 : null);

/** A pass's picture as a capture's. */
function pictureOf(shot: Shot, name: string, data: string): CaptureImage {
  return { name, ...(typeof shot.path === "string" ? { file: shot.path } : {}), mimeType: PREVIEW_MIME, data };
}

/**
 * An evidence pass as a capture: its camera shots with pixels as stills (at most `PREVIEW_STILLS`),
 * the motion frames the pass took as its recording, in order (at most `RECORDING_FRAMES`), and its
 * problems as the capture's problem.
 */
export function captureOfEvidence(evidence: Evidence, label: string): Capture {
  const shots: Shot[] = Array.isArray(evidence.shots) ? evidence.shots : [];
  const frames: Shot[] = Array.isArray(evidence.motion) ? evidence.motion : [];
  const images = shots
    .flatMap((shot) => {
      const data = pixelsOf(shot);
      return data ? [pictureOf(shot, String(shot.camera), data)] : [];
    })
    .slice(0, PREVIEW_STILLS);
  const recording = frames
    .flatMap((frame, index) => {
      const data = pixelsOf(frame);
      return data ? [pictureOf(frame, `m${String(index + 1).padStart(2, "0")}`, data)] : [];
    })
    .slice(0, RECORDING_FRAMES);
  const problems = Array.isArray(evidence.problems) ? evidence.problems.map(String) : [];
  return {
    observer: PREVIEW_OBSERVER,
    label,
    source: ObserverSource.Preview,
    images,
    recording,
    ...(problems.length ? { problem: problems.join("; ") } : {}),
  };
}

/** The host's pictures of one capture, whatever an older or edited host sent. */
function hostPictures(value: unknown): CaptureImage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((picture: Partial<CapturedImage>) => {
    const { name, file, mimeType, data } = picture;
    if (typeof name !== "string" || typeof mimeType !== "string" || typeof data !== "string") return [];
    return [{ name, ...(typeof file === "string" ? { file } : {}), mimeType, data }];
  });
}

/** One of the host's captures as a capture. */
function captureOfHost(result: Partial<ObserverCaptureResult>): Capture {
  const observer = String(result.observer ?? PLUGIN_OBSERVERS);
  return {
    observer,
    label: String(result.label ?? observer),
    source: ObserverSource.Plugin,
    images: hostPictures(result.images),
    recording: hostPictures(result.recording),
    ...(typeof result.note === "string" ? { note: result.note } : {}),
    ...(typeof result.problem === "string" ? { problem: result.problem } : {}),
  };
}

/**
 * The work's answer, or `LATE` once `until` (on `clock`) passes first. The host's capture is told
 * its time and stops with it; a preview pass is left to its own bounds.
 */
async function beforeDeadline<T>(work: Promise<T>, until: number, clock: ObserveClock): Promise<T | typeof LATE> {
  const left = Math.max(0, until - clock.now());
  // Work left behind past its time may still fail: nobody waits for it then.
  work.catch(() => {});
  if (clock.sleep) return Promise.race([work, clock.sleep(left).then((): typeof LATE => LATE)]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), left);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The plugins' captures through the host; a host that cannot is one capture with the problem. */
async function pluginCaptures(ctx: HarnessCtx, scope: ObserveScope, until: number): Promise<Capture[]> {
  const unanswered = (problem: string) => [
    problemCapture(PLUGIN_OBSERVERS, MESSAGE.pluginsLabel, ObserverSource.Plugin, problem),
  ];
  const clock = clockOf(scope);
  const withinMs = until - clock.now();
  if (withinMs <= 0) return unanswered(MESSAGE.noTime);
  const asked = { project: scope.game.name, runId: scope.run.runId, threadId: scope.threadId, withinMs };
  try {
    const answer = await beforeDeadline(ctx.call(HostMethod.ObserversCapture, asked), until, clock);
    if (answer === LATE) return unanswered(MESSAGE.noTime);
    return (Array.isArray(answer) ? answer : []).filter(isRecord).map(captureOfHost);
  } catch (err) {
    return unanswered(olderHost(err) ? MESSAGE.olderHost : MESSAGE.couldNotAsk(String((err as Error)?.message ?? err)));
  }
}

/** The folders the game is served from as a web game, its root first. */
function webPaths(game: ObservedGame): string[] {
  const paths = servedFactsOf(game)
    .filter((fact) => fact.id === CoreFact.WebGame)
    .map((fact) => fact.path);
  return [...new Set(paths)].sort((a, b) => Number(b === FACT_ROOT) - Number(a === FACT_ROOT) || a.localeCompare(b));
}

/** Genex's preview of one served folder: the caller's pass, else an evidence pass of its own. */
async function previewCapture(ctx: HarnessCtx, scope: ObserveScope, path: string, until: number): Promise<Capture> {
  const label = MESSAGE.previewLabel(path);
  const unanswered = (problem: string) => problemCapture(PREVIEW_OBSERVER, label, ObserverSource.Preview, problem);
  const clock = clockOf(scope);
  if (clock.now() >= until) return unanswered(MESSAGE.noTime);
  const pass = scope.previewPass
    ? scope.previewPass(path)
    : gatherEvidence(ctx, {
        run: scope.run,
        root: scope.game.dir,
        ...(path === FACT_ROOT ? {} : { entry: `${path}/index.html` }),
        motion: RECORDING_FRAMES,
        labelPrefix: PREVIEW_LABEL_PREFIX,
      });
  try {
    const evidence = await beforeDeadline(pass, until, clock);
    if (evidence === LATE) return unanswered(MESSAGE.noTime);
    return evidence ? captureOfEvidence(evidence, label) : unanswered(MESSAGE.noLook);
  } catch (err) {
    return unanswered(MESSAGE.couldNotLook(String((err as Error)?.message ?? err)));
  }
}

/**
 * Everything Genex can capture of the game now: the plugins' observers through the host, then the
 * preview of each folder it is served from as a web game. Each look is bounded by `until` (on the
 * scope's clock): past it, a look is skipped or abandoned and says so. Never throws.
 */
export async function observeGame(ctx: HarnessCtx, scope: ObserveScope, until: number): Promise<Capture[]> {
  const captures = await pluginCaptures(ctx, scope, until);
  for (const path of webPaths(scope.game)) captures.push(await previewCapture(ctx, scope, path, until));
  return captures;
}

/** A capture's pictures in its record: the kept files, never the data. */
const filesOf = (pictures: readonly CaptureImage[]) =>
  pictures.flatMap((picture) => (picture.file ? [{ name: picture.name, file: picture.file }] : []));

/**
 * Record the captures the harness made (the preview's, the lead's proof) as `observer_capture`, one
 * each, files only: the host records a plugin's capture itself. A failed write is logged, never thrown.
 */
export async function recordCaptures(
  ctx: HarnessCtx,
  threadId: string,
  runId: string,
  captures: readonly Capture[],
): Promise<void> {
  for (const capture of captures) {
    if (!RECORDED_HERE.has(capture.source)) continue;
    const recording = filesOf(capture.recording);
    const payload = {
      observer: capture.observer,
      label: capture.label,
      source: capture.source,
      images: filesOf(capture.images),
      ...(recording.length ? { recording } : {}),
      ...(capture.note ? { note: capture.note } : {}),
      ...(capture.problem ? { problem: capture.problem } : {}),
      at: new Date().toISOString(),
    };
    await appendRun(ctx, threadId, OBSERVER_CAPTURE_EVENT, payload, { runId });
  }
}

/** How many of a capture's pictures a reviewer was handed: its stills and its play frames. */
export interface Attached {
  stills: number;
  frames: number;
}

/** The pictures handed to a reviewer, and how many of each capture's (by index) they hold. */
export interface Picked {
  images: DelegateImage[];
  attached: Attached[];
}

/** A picture's size once decoded from base64. */
const bytesOf = (picture: CaptureImage): number => Math.floor((picture.data.length * 3) / 4);

/** One picture as a reviewer is handed it, with its label. */
interface Candidate {
  capture: number;
  still: boolean;
  image: DelegateImage;
  bytes: number;
}

/** A capture's stills or frames as candidates, each labelled. */
function candidates(capture: Capture, index: number, still: boolean): Candidate[] {
  const pictures = still ? capture.images : capture.recording;
  const word = still ? MESSAGE.still : MESSAGE.play;
  return pictures.map((picture, n) => ({
    capture: index,
    still,
    image: { label: word(capture.label, n + 1, pictures.length), mimeType: picture.mimeType, data: picture.data },
    bytes: bytesOf(picture),
  }));
}

/** Lists taken one item each in turn, until all are empty. */
function roundRobin<T>(lists: readonly T[][]): T[] {
  const queues = lists.map((list) => [...list]);
  const out: T[] = [];
  while (queues.some((queue) => queue.length))
    for (const queue of queues) if (queue.length) out.push(queue.shift() as T);
  return out;
}

/**
 * The pictures of the captures for a reviewer, at most `max` and `REVIEW_IMAGES_MAX_BYTES` together,
 * none over `REVIEW_PICTURE_MAX_BYTES`: the captures in `first` (the lead's proof) keep all their
 * stills, then every other capture's stills in turn (one still of each before a second of any),
 * then the play frames in turn. Each is labelled; `attached` says how many of each capture went.
 */
export function pickedImages(
  captures: readonly Capture[],
  max: number,
  first: ReadonlySet<number> = new Set(),
): Picked {
  const stills = captures.map((capture, index) => candidates(capture, index, true));
  const frames = captures.map((capture, index) => candidates(capture, index, false));
  const ordered = [
    ...stills.filter((_, index) => first.has(index)).flat(),
    ...roundRobin(stills.filter((_, index) => !first.has(index))),
    ...roundRobin(frames),
  ];
  const attached: Attached[] = captures.map(() => ({ stills: 0, frames: 0 }));
  const images: DelegateImage[] = [];
  let bytes = 0;
  for (const one of ordered) {
    if (images.length >= Math.max(0, max)) break;
    const fits = one.bytes <= REVIEW_PICTURE_MAX_BYTES && bytes + one.bytes <= REVIEW_IMAGES_MAX_BYTES;
    if (!fits) continue;
    images.push(one.image);
    bytes += one.bytes;
    const count = attached[one.capture] as Attached;
    if (one.still) count.stills += 1;
    else count.frames += 1;
  }
  return { images, attached };
}

/** The pictures of the captures for a reviewer (`pickedImages` with no capture first). */
export function captureImages(captures: readonly Capture[], max: number): DelegateImage[] {
  return pickedImages(captures, max).images;
}

/**
 * How the previous session ended, for usage analytics: each launch that keeps analytics leaves a
 * small marker in its data folder (`analytics/session.json`), reads the one before it once at
 * launch (`begin`), and keeps its own current as it goes: running, then quitting or updating, with
 * its pages that went away, its hangs, main's own uncaught errors and background update failures
 * counted. A marker still saying running was a session that never quit; one saying updating whose
 * version is still this one's was an update that never installed.
 *
 * The marker holds counts, enums, times and the app's version only, and is read back as data: a
 * missing, corrupt or forged one (words, paths, huge numbers) gives no facts or only typed ones.
 * Pure but for `markerFileIo`, which reads it only as a file of its own (never through a link) and
 * writes it only into a folder of its own below the data folder.
 */
import path from "node:path";
import { type PreviousSession, RendererGone, SessionExit } from "../shared/app-session.ts";
import type { LaunchFacts } from "../shared/app-session.ts";
import { type StartFacts, StartPassage } from "../shared/boot.ts";
import { MINUTE_MS, SECOND_MS } from "../shared/duration.ts";
import { atomicWriteText, ensureDirBelow, readRegularFile } from "../substrate/fsx.ts";

/** The marker's folder and file below the data folder. */
const MARKER_DIR = "analytics";
const MARKER_FILE = "session.json";
/** The shape this module writes; any other is read as no marker. */
const MARKER_VERSION = 1;
/** A marker is a few hundred bytes; anything much larger is not one. */
const MARKER_BYTES_MAX = 4096;
/** A version longer than this is not one the app wrote. */
const VERSION_CHARS_MAX = 64;
/** The most of anything one session counts: a forged huge count reads as this. */
const TALLY_MAX = 10_000;
/** How often a running session says it is still alive, so its uptime survives a crash. */
export const SESSION_HEARTBEAT_MS = 5 * MINUTE_MS;
/** How long a quit or a relaunch waits for the marker to say so before it goes on regardless. */
export const SESSION_MARKER_WAIT_MS = SECOND_MS;

/** How the marker was last left. */
export const SessionMark = {
  /** The session is running, or stopped without quitting. */
  Running: "running",
  /** Genex's own quit began. */
  Quitting: "quitting",
  /** Relaunch to update began. */
  Updating: "updating",
} as const;
export type SessionMark = (typeof SessionMark)[keyof typeof SessionMark];

/** One session's marker, as written and as read back (every field re-checked). */
interface Marker {
  state: SessionMark | null;
  version: string | null;
  startedAt: number | null;
  aliveAt: number | null;
  rendererCrashes: number;
  lastCrash: RendererGone | null;
  hangs: number;
  mainErrors: number;
  updateFailures: number;
  /** Steps the launch before this one passed on to it (`noteNextStart`). */
  notes: StartPassage[];
}

/** Where the marker is kept: read whole (null when there is none to read) and replaced whole. */
export interface MarkerIo {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

/** What a launch learns from the marker the session before it left. */
export interface SessionBegun {
  previous: PreviousSession | null;
  notes: StartPassage[];
}

/** One session's marker, kept current. Every write is in order, and none ever throws. */
export interface SessionMarker {
  /** Read the previous session's marker, once, then keep this one's (running). */
  begin(): Promise<SessionBegun>;
  /** A window's page went away for `reason` (Electron's); a clean exit is not counted. */
  rendererGone(reason: unknown): void;
  /** A window stopped answering. */
  hung(): void;
  /** Main's own process caught an error nowhere. */
  mainError(): void;
  /** A background update check, download or install failed. */
  updateFailed(): void;
  /** Still alive: the uptime a crash leaves behind runs to here. */
  heartbeat(): void;
  /** Genex's own quit began; an update already relaunching stays updating. */
  quitting(): Promise<void>;
  /** Relaunch to update began. */
  updating(): Promise<void>;
  /** Every write asked for so far has landed (or failed quietly). */
  flushed(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value of `vocabulary` that `value` spells, or null: never a free string. */
function valueIn<V extends string>(vocabulary: Readonly<Record<string, V>>, value: unknown): V | null {
  for (const word of Object.values(vocabulary)) if (word === value) return word;
  return null;
}

/** A count read back: a whole number from 0, at most `TALLY_MAX`; anything else is 0. */
const tally = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, TALLY_MAX) : 0;

/** A moment read back: epoch ms from 0, or null. */
const instant = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** A version read back: a short string, or null. */
const versionOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= VERSION_CHARS_MAX ? value : null;

/** The notes read back: only the start's own steps, each once. */
function passages(value: unknown): StartPassage[] {
  if (!Array.isArray(value)) return [];
  const known = value.map((item) => valueIn(StartPassage, item)).filter((item) => item !== null);
  return [...new Set(known)];
}

function parsed(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A marker's text read back field by field, or null when it is not one this module wrote. */
function parseMarker(text: string | null): Marker | null {
  const raw = parsed(text);
  if (!isRecord(raw) || raw.v !== MARKER_VERSION) return null;
  return {
    state: valueIn(SessionMark, raw.state),
    version: versionOf(raw.version),
    startedAt: instant(raw.startedAt),
    aliveAt: instant(raw.aliveAt),
    rendererCrashes: tally(raw.rendererCrashes),
    lastCrash: valueIn(RendererGone, raw.lastCrash),
    hangs: tally(raw.hangs),
    mainErrors: tally(raw.mainErrors),
    updateFailures: tally(raw.updateFailures),
    notes: passages(raw.notes),
  };
}

/** How a session left as `state` by `version` ended, seen from a launch of `current`. */
function exitOf(state: SessionMark, version: string, current: string): SessionExit {
  if (state === SessionMark.Running) return SessionExit.Unclean;
  if (version !== current) return SessionExit.UpdateInstalled;
  return state === SessionMark.Updating ? SessionExit.UpdateInterrupted : SessionExit.Clean;
}

/** From its start to the last moment it was seen, or null when the marker cannot say. */
function uptimeOf(marker: Marker): number | null {
  if (marker.startedAt === null || marker.aliveAt === null) return null;
  const uptime = marker.aliveAt - marker.startedAt;
  return uptime >= 0 ? uptime : null;
}

/** What a marker's text says about the session that left it, seen from a launch of `current`. */
export function readPrevious(text: string | null, current: string): SessionBegun {
  const marker = parseMarker(text);
  if (!marker) return { previous: null, notes: [] };
  const { state, version } = marker;
  const previous =
    state === null || version === null
      ? null
      : {
          exit: exitOf(state, version, current),
          rendererCrashes: marker.rendererCrashes,
          lastCrash: marker.lastCrash,
          hangs: marker.hangs,
          mainErrors: marker.mainErrors,
          updateFailures: marker.updateFailures,
          uptimeMs: uptimeOf(marker),
        };
  return { previous, notes: marker.notes };
}

/** A marker's text, with its shape's version. */
const markerText = (marker: Marker): string => JSON.stringify({ v: MARKER_VERSION, ...marker });

/** The marker of one session of `version`, kept through `io`, on `now`'s clock. */
export function createSessionMarker({
  io,
  version,
  now,
}: {
  io: MarkerIo;
  version: string;
  now: () => number;
}): SessionMarker {
  const started = now();
  const current: Marker = {
    state: SessionMark.Running,
    version,
    startedAt: started,
    aliveAt: started,
    rendererCrashes: 0,
    lastCrash: null,
    hangs: 0,
    mainErrors: 0,
    updateFailures: 0,
    notes: [],
  };
  let writes: Promise<void> = Promise.resolve();
  // Nothing is written before the previous session's marker has been read.
  let begun = false;
  const save = (): Promise<void> => {
    if (!begun) return writes;
    current.aliveAt = Math.max(current.startedAt ?? 0, now());
    const text = markerText(current);
    writes = writes.then(() => io.write(text)).catch(() => undefined);
    return writes;
  };
  const count = (field: "hangs" | "mainErrors" | "updateFailures"): void => {
    current[field] = Math.min(current[field] + 1, TALLY_MAX);
    void save();
  };
  return {
    async begin() {
      // The read goes first in the line of writes, so nothing this session writes can land before it.
      const read = writes.then(() => io.read()).catch(() => null);
      writes = read.then(() => undefined);
      begun = true;
      const text = await read;
      await save();
      return readPrevious(text, version);
    },
    rendererGone(reason) {
      const gone = valueIn(RendererGone, reason);
      if (gone === RendererGone.CleanExit) return;
      current.rendererCrashes = Math.min(current.rendererCrashes + 1, TALLY_MAX);
      current.lastCrash = gone;
      void save();
    },
    hung: () => count("hangs"),
    mainError: () => count("mainErrors"),
    updateFailed: () => count("updateFailures"),
    heartbeat: () => void save(),
    quitting() {
      if (current.state !== SessionMark.Updating) current.state = SessionMark.Quitting;
      return save();
    },
    updating() {
      current.state = SessionMark.Updating;
      return save();
    },
    flushed: () => writes,
  };
}

/**
 * Leave `passage` for the next launch of the data folder `io` keeps a marker in: a launch that
 * moved Genex's data, or waited for its folder, before it starts Genex again. The marker there
 * keeps what it said; a folder with none gets one that says only this.
 */
export async function noteNextStart(io: MarkerIo, passage: StartPassage): Promise<void> {
  const text = await io.read().catch(() => null);
  const marker = parseMarker(text) ?? {
    state: null,
    version: null,
    startedAt: null,
    aliveAt: null,
    rendererCrashes: 0,
    lastCrash: null,
    hangs: 0,
    mainErrors: 0,
    updateFailures: 0,
    notes: [],
  };
  const notes = marker.notes.includes(passage) ? marker.notes : [...marker.notes, passage];
  await io.write(markerText({ ...marker, notes })).catch(() => undefined);
}

/** The marker of the data folder `dataDir`: a regular file of its own, in a folder of its own below it. */
export function markerFileIo(dataDir: string): MarkerIo {
  return {
    read: () =>
      readRegularFile(path.join(dataDir, MARKER_DIR, MARKER_FILE), MARKER_BYTES_MAX).then(
        (bytes) => bytes.toString("utf8"),
        () => null,
      ),
    async write(text) {
      const dir = await ensureDirBelow(dataDir, [MARKER_DIR]);
      await atomicWriteText(path.join(dir, MARKER_FILE), text);
    },
  };
}

/**
 * This launch's facts, from the marker the session before it left and the start the boot gate saw
 * (`BootGate.started`), with what the launch before passed on and a data folder that fell back.
 */
export function launchFacts(begun: SessionBegun, start: StartFacts, fellBack: boolean): LaunchFacts {
  const extra = fellBack ? [StartPassage.DataFallback] : [];
  const passed = [...new Set([...begun.notes, ...start.passed, ...extra])];
  return { previous: begun.previous, start: { ...start, passed } };
}

/** `read`'s answer to the first caller only; every later one gets null (a reload or a Retry). */
export function handOnce<T>(read: () => Promise<T>): () => Promise<T | null> {
  let handed = false;
  return () => {
    if (handed) return Promise.resolve(null);
    handed = true;
    return read();
  };
}

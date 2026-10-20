/**
 * A Rust game's frame profile as the host reads it (game-systems PROFILE): the summary every frame
 * puts in `state().volatile.profile`, the `ProfileReport` v2 the dev op `profile` answers, and what
 * `preview.frameProfile` and `studio:native.profile` hand on. Every value comes from the game, so
 * each parser here checks size, depth, vocabularies and caps, copies only the fields it knows and
 * answers null (never throws) for anything outside the shape. The caps are genex-profile's.
 */

/** What a `profile` request asks for. Wire values: never rename one. */
export const FrameProfileAction = {
  /** The `volatile.profile` summary. */
  Summary: "summary",
  /** `ProfileReport` v2 for the last `frames` frames, plus every kept hitch. */
  Report: "report",
  /** Switch GPU timing to `mode` (per-node brackets until `frame` again or the arm's frames pass). */
  Arm: "arm",
  /** Write a Chrome trace of the report window into the run's `state/profile/`, answering its size and digest. */
  Trace: "trace",
} as const;
export type FrameProfileAction = (typeof FrameProfileAction)[keyof typeof FrameProfileAction];

/** How the GPU is timed: the whole frame (Live's default) or each frame-graph node. Wire values. */
export const GpuTimingMode = {
  Frame: "frame",
  Nodes: "nodes",
} as const;
export type GpuTimingMode = (typeof GpuTimingMode)[keyof typeof GpuTimingMode];

/** Whether per-node GPU timing is armed, as the summary says. Wire values. */
export const NodeTimingState = {
  Off: "off",
  Armed: "armed",
} as const;
export type NodeTimingState = (typeof NodeTimingState)[keyof typeof NodeTimingState];

/** Why a frame is a hitch: its CPU work, its GPU work, or only its interval (the OS or compositor). Wire values. */
export const HitchCause = {
  Cpu: "cpu",
  Gpu: "gpu",
  Pacing: "pacing",
} as const;
export type HitchCause = (typeof HitchCause)[keyof typeof HitchCause];

/** Where the GPU numbers come from. Wire values. */
export const GpuTimeSource = {
  Timestamps: "timestamps",
  /** Timestamps a browser rounds (Chrome: about 100 µs). */
  TimestampsQuantized: "timestamps-quantized",
  SubmitLatency: "submit-latency",
  None: "none",
} as const;
export type GpuTimeSource = (typeof GpuTimeSource)[keyof typeof GpuTimeSource];

/** Why the host has no profile to give. Wire values: never rename one. */
export const ProfileUnavailableReason = {
  /** This host or game does not serve frame profiles yet. */
  NotServed: "not-served",
  /** The lease runs no game. */
  NoRun: "no-run",
  /** An export build, or a game made before the verb: it answers `unknown-op`. */
  UnknownOp: "unknown-op",
} as const;
export type ProfileUnavailableReason = (typeof ProfileUnavailableReason)[keyof typeof ProfileUnavailableReason];

/** The summary's and the report's format numbers (their `v`). */
export const PROFILE_SUMMARY_VERSION = 1;
export const PROFILE_REPORT_VERSION = 2;
/** The most bytes a summary takes as JSON. */
export const PROFILE_SUMMARY_MAX_BYTES = 4 * 1024;
/** The most bytes a report takes as JSON; the game drops frames and sets `truncated` past it. */
export const PROFILE_REPORT_MAX_BYTES = 256 * 1024;
/** The most frames a report holds, and the default a `report` asks for. */
export const PROFILE_REPORT_FRAMES_MAX = 240;
export const PROFILE_REPORT_FRAMES_DEFAULT = 120;
/** The most frames one `arm nodes` keeps per-node timing for. */
export const PROFILE_ARM_MAX_FRAMES = 1800;
/** The most scopes one report frame lists (the deepest are dropped first). */
export const PROFILE_FRAME_SCOPES_MAX = 512;
/** The most rows of the summary's top scopes. */
export const PROFILE_TOP_SCOPES = 8;
/** The most hitches a report keeps (8 on phones). */
export const PROFILE_HITCHES_MAX = 16;
/** The most counters a game reports, and the most GPU nodes one frame times. */
export const PROFILE_COUNTERS_MAX = 64;
export const PROFILE_GPU_NODES_MAX = 256;
/** The most memory rows a summary or report lists. */
export const PROFILE_MEMORY_ROWS_MAX = 64;
/** The deepest JSON nesting a profile value may have. */
export const PROFILE_JSON_DEPTH_MAX = 8;

/** A scope, counter, memory class or GPU node name: 1..=48 of `a-z`, `0-9`, `_`, `.`, `-`. */
const NAME = /^[a-z0-9_.-]{1,48}$/;
/** FNV-1a 64, 16 lowercase hex. */
const DIGEST = /^[0-9a-f]{16}$/;
/** A destination, device class or engine id as the report names it (display only). */
const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** What the host answers when it has no profile. */
export interface ProfileUnavailable {
  state: "unavailable";
  reason: ProfileUnavailableReason;
}

/** A frame-time distribution, in milliseconds. */
export interface ProfilePercentiles {
  p50: number;
  p95: number;
}

/** One memory row: a GPU budget kind, a CPU memory class or a process measure, in bytes. */
export interface ProfileMemoryRow {
  class: string;
  bytes: number;
  budget?: number;
}

/** `state().volatile.profile`: the last frames' summary (at most 4 KiB). */
export interface ProfileSummaryV1 {
  v: 1;
  /** Scopes are recorded (off in exports, where cpu and gpu still come from the frame timers). */
  on: boolean;
  frames: number;
  cpu: ProfilePercentiles;
  gpu: (ProfilePercentiles & { source: GpuTimeSource }) | null;
  top: Array<{ scope: string; game: boolean; p95: number }>;
  counters: Record<string, number>;
  memory: ProfileMemoryRow[];
  hitches: { count: number; last: number | null };
  nodes: NodeTimingState;
  dropped: { scopes: number; counters: number; frames: number };
}

/** One timed scope of a report frame, microseconds from the frame's start. */
export interface ProfileScope {
  scope: string;
  game: boolean;
  depth: number;
  startUs: number;
  us: number;
}

/** One frame of a report. */
export interface ProfileFrame {
  index: number;
  cpuMs: number;
  gpuMs: number | null;
  intervalMs: number;
  scopes: ProfileScope[];
  /** Per-node GPU time while armed: the frame graph row's wire name, or `world`. */
  gpu: Array<{ node: string; ms: number }>;
}

/** One kept hitch: the frame, why, the line it crossed and its heaviest scopes. */
export interface ProfileHitch {
  frame: number;
  cause: HitchCause;
  thresholdMs: number;
  top: Array<{ scope: string; us: number }>;
}

/** What the dev op `profile` answers for `report` (at most 256 KiB). */
export interface ProfileReportV2 {
  v: 2;
  engine: string;
  destination: string;
  deviceClass: string;
  frames: ProfileFrame[];
  hitches: ProfileHitch[];
  memory: ProfileMemoryRow[];
  counters: Record<string, number>;
  gpuSource: GpuTimeSource;
  truncated: boolean;
}

/** What `arm` answers: the mode now in force. */
export interface ProfileArmAnswer {
  mode: GpuTimingMode;
}

/** What `trace` answers: the trace file's size and FNV-1a 64 digest. */
export interface ProfileTraceAnswer {
  bytes: number;
  digest: string;
}

/** A `profile` request: the action, the report's frames and the arm's mode. */
export interface FrameProfileRequest {
  action: FrameProfileAction;
  frames?: number;
  mode?: GpuTimingMode;
}

/** What each action answers, by action. */
export interface ProfileAnswers {
  [FrameProfileAction.Summary]: ProfileSummaryV1;
  [FrameProfileAction.Report]: ProfileReportV2;
  [FrameProfileAction.Arm]: ProfileArmAnswer;
  [FrameProfileAction.Trace]: ProfileTraceAnswer;
}

/** What `preview.frameProfile` and `studio:native.profile` answer. */
export type FrameProfileAnswer = ProfileAnswers[FrameProfileAction] | ProfileUnavailable;

/** The answer for a host that has no profile for this request. */
export function profileUnavailable(reason: ProfileUnavailableReason): ProfileUnavailable {
  return { state: "unavailable", reason };
}

// ── untrusted JSON bounds (shared with shared/crash-record.ts) ─────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` nests no deeper than `maxDepth` objects and arrays; walked without recursion. */
function depthWithin(value: unknown, maxDepth: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [item, depth] = stack.pop() ?? [null, 0];
    if (typeof item !== "object" || item === null) continue;
    if (depth >= maxDepth) return false;
    for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return true;
}

/** The UTF-8 bytes of `value` as JSON; Infinity for a value JSON cannot hold. */
function jsonBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? new TextEncoder().encode(text).byteLength : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Whether an untrusted value nests at most `maxDepth` deep and takes at most `maxBytes` as JSON. */
export function jsonWithin(value: unknown, maxBytes: number, maxDepth: number): boolean {
  return depthWithin(value, maxDepth) && jsonBytes(value) <= maxBytes;
}

// ── parsers ─────────────────────────────────────────────────────────────────────────────────

/** Thrown inside a parse for a value outside its shape; caught once, by the exported parser. */
class ProfileRefused extends Error {}
const refuse = (): never => {
  throw new ProfileRefused();
};
const nonNegative = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : refuse();
const count = (value: unknown): number =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : refuse();
const flag = (value: unknown): boolean => (typeof value === "boolean" ? value : refuse());
const name = (value: unknown): string => (typeof value === "string" && NAME.test(value) ? value : refuse());
const label = (value: unknown): string => (typeof value === "string" && LABEL.test(value) ? value : refuse());
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : refuse());
const list = (value: unknown, max: number): unknown[] =>
  Array.isArray(value) && value.length <= max ? value : refuse();
function word<T extends string>(vocabulary: Readonly<Record<string, T>>, value: unknown): T {
  return Object.values(vocabulary).find((member) => member === value) ?? refuse();
}

function percentiles(value: unknown): ProfilePercentiles {
  const raw = record(value);
  return { p50: nonNegative(raw.p50), p95: nonNegative(raw.p95) };
}

function counters(value: unknown): Record<string, number> {
  const raw = record(value);
  const entries = Object.entries(raw);
  if (entries.length > PROFILE_COUNTERS_MAX) refuse();
  // `fromEntries` defines own properties, so a counter named `__proto__` stays plain data.
  return Object.fromEntries(
    entries.map(([key, reading]) => [
      name(key),
      typeof reading === "number" && Number.isFinite(reading) ? reading : refuse(),
    ]),
  );
}

function memoryRows(value: unknown): ProfileMemoryRow[] {
  return list(value, PROFILE_MEMORY_ROWS_MAX).map((item) => {
    const raw = record(item);
    const row: ProfileMemoryRow = { class: name(raw.class), bytes: count(raw.bytes) };
    return raw.budget === undefined ? row : { ...row, budget: count(raw.budget) };
  });
}

function summaryOf(value: unknown): ProfileSummaryV1 {
  const raw = record(value);
  if (raw.v !== PROFILE_SUMMARY_VERSION) refuse();
  const gpu =
    raw.gpu === null ? null : { ...percentiles(raw.gpu), source: word(GpuTimeSource, record(raw.gpu).source) };
  const hitches = record(raw.hitches);
  const dropped = record(raw.dropped);
  return {
    v: PROFILE_SUMMARY_VERSION,
    on: flag(raw.on),
    frames: count(raw.frames),
    cpu: percentiles(raw.cpu),
    gpu,
    top: list(raw.top, PROFILE_TOP_SCOPES).map((item) => {
      const row = record(item);
      return { scope: name(row.scope), game: flag(row.game), p95: nonNegative(row.p95) };
    }),
    counters: counters(raw.counters),
    memory: memoryRows(raw.memory),
    hitches: { count: count(hitches.count), last: hitches.last === null ? null : count(hitches.last) },
    nodes: word(NodeTimingState, raw.nodes),
    dropped: { scopes: count(dropped.scopes), counters: count(dropped.counters), frames: count(dropped.frames) },
  };
}

function scopeOf(value: unknown): ProfileScope {
  const raw = record(value);
  return {
    scope: name(raw.scope),
    game: flag(raw.game),
    depth: count(raw.depth),
    startUs: nonNegative(raw.startUs),
    us: nonNegative(raw.us),
  };
}

function frameOf(value: unknown): ProfileFrame {
  const raw = record(value);
  return {
    index: count(raw.index),
    cpuMs: nonNegative(raw.cpuMs),
    gpuMs: raw.gpuMs === null ? null : nonNegative(raw.gpuMs),
    intervalMs: nonNegative(raw.intervalMs),
    scopes: list(raw.scopes, PROFILE_FRAME_SCOPES_MAX).map(scopeOf),
    gpu: list(raw.gpu, PROFILE_GPU_NODES_MAX).map((item) => {
      const node = record(item);
      return { node: name(node.node), ms: nonNegative(node.ms) };
    }),
  };
}

function hitchOf(value: unknown): ProfileHitch {
  const raw = record(value);
  return {
    frame: count(raw.frame),
    cause: word(HitchCause, raw.cause),
    thresholdMs: nonNegative(raw.thresholdMs),
    top: list(raw.top, PROFILE_TOP_SCOPES).map((item) => {
      const row = record(item);
      return { scope: name(row.scope), us: nonNegative(row.us) };
    }),
  };
}

function reportOf(value: unknown): ProfileReportV2 {
  const raw = record(value);
  if (raw.v !== PROFILE_REPORT_VERSION) refuse();
  return {
    v: PROFILE_REPORT_VERSION,
    engine: label(raw.engine),
    destination: label(raw.destination),
    deviceClass: label(raw.deviceClass),
    frames: list(raw.frames, PROFILE_REPORT_FRAMES_MAX).map(frameOf),
    hitches: list(raw.hitches, PROFILE_HITCHES_MAX).map(hitchOf),
    memory: memoryRows(raw.memory),
    counters: counters(raw.counters),
    gpuSource: word(GpuTimeSource, raw.gpuSource),
    truncated: flag(raw.truncated),
  };
}

/** Runs `parse` over an untrusted value inside its bounds; null for anything outside them. */
function bounded<T>(value: unknown, maxBytes: number, parse: (value: unknown) => T): T | null {
  try {
    return jsonWithin(value, maxBytes, PROFILE_JSON_DEPTH_MAX) ? parse(value) : null;
  } catch (error) {
    if (error instanceof ProfileRefused) return null;
    throw error;
  }
}

/** A game's `volatile.profile` summary, copied; null outside its shape or over 4 KiB. */
export function parseProfileSummary(value: unknown): ProfileSummaryV1 | null {
  return bounded(value, PROFILE_SUMMARY_MAX_BYTES, summaryOf);
}

/** A game's `ProfileReport` v2, copied; null outside its shape or over 256 KiB. */
export function parseProfileReport(value: unknown): ProfileReportV2 | null {
  return bounded(value, PROFILE_REPORT_MAX_BYTES, reportOf);
}

/** What the dev op answered for `action`, copied; null outside that action's shape. */
export function parseProfileAnswer<A extends FrameProfileAction>(action: A, value: unknown): ProfileAnswers[A] | null;
export function parseProfileAnswer(
  action: FrameProfileAction,
  value: unknown,
): ProfileAnswers[FrameProfileAction] | null {
  switch (action) {
    case FrameProfileAction.Summary:
      return parseProfileSummary(value);
    case FrameProfileAction.Report:
      return parseProfileReport(value);
    case FrameProfileAction.Arm:
      return bounded(value, PROFILE_SUMMARY_MAX_BYTES, (raw) => ({ mode: word(GpuTimingMode, record(raw).mode) }));
    case FrameProfileAction.Trace:
      return bounded(value, PROFILE_SUMMARY_MAX_BYTES, (raw) => {
        const answer = record(raw);
        const digest = typeof answer.digest === "string" && DIGEST.test(answer.digest) ? answer.digest : refuse();
        return { bytes: count(answer.bytes), digest };
      });
    default:
      return null;
  }
}

/**
 * A `profile` request from the harness or the renderer, copied with its known fields; null for an
 * unknown action, frames outside 1..=240, or a mode outside the vocabulary.
 */
export function parseFrameProfileRequest(value: unknown): FrameProfileRequest | null {
  try {
    const raw = record(value);
    const request: FrameProfileRequest = { action: word(FrameProfileAction, raw.action) };
    if (raw.frames !== undefined) {
      const frames = count(raw.frames);
      if (frames < 1 || frames > PROFILE_REPORT_FRAMES_MAX) refuse();
      request.frames = frames;
    }
    if (raw.mode !== undefined) request.mode = word(GpuTimingMode, raw.mode);
    return request;
  } catch (error) {
    if (error instanceof ProfileRefused) return null;
    throw error;
  }
}

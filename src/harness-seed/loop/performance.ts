import { MINUTE_MS, SECOND_MS } from "./time.ts";

/** Conservative, deterministic policy. Constants are engineering defaults, not FPS targets. */
export const PROFILE_DEFAULTS = Object.freeze({ warmupMs: 2000, sampleMs: 5000, samples: 3, minIntervals: 30 });

/** The runtime metrics a comparison reads, in the order it reads them. */
const COMPARED_METRICS = ["frameMs", "drawCalls", "triangles"] as const;
type ComparedMetric = (typeof COMPARED_METRICS)[number];

/** Each metric as a verified reduction names it. */
const METRIC_WORDS: Record<string, string> = {
  frameMs: "frame interval",
  drawCalls: "world draw calls",
  triangles: "world triangles",
};

/** What one metric's paired samples say. */
const MetricVerdict = {
  Skipped: "skipped",
  Unmeasured: "unmeasured",
  Regressed: "regressed",
  Gained: "gained",
  Unchanged: "unchanged",
} as const;
type MetricVerdict = (typeof MetricVerdict)[keyof typeof MetricVerdict];

/** One measured metric of a profile sample. */
export interface SampleMetric {
  value?: number;
}

/**
 * One profile sample as `preview.profile` answers it: what ran (backend, renderer, version, scope,
 * scenario, configuration), what it measured, and the build it measured.
 */
export interface PerformanceSample {
  schemaVersion?: number;
  backend?: string;
  renderer?: string;
  version?: string;
  scope?: string;
  scenarioId?: string;
  configuration?: unknown;
  metrics?: Record<string, SampleMetric | undefined>;
  revision?: { tree?: string } | null;
  [field: string]: unknown;
}

/** A check's outcome as the preservation gate reads it. */
export interface CheckOutcome {
  id: string;
  pass?: boolean | null;
}

/** What drew a sample: a web page's WebGL or WebGPU, or a native run's renderer. Wire values. */
export const SampleBackend = { WebGl: "webgl", WebGpu: "webgpu", Native: "native" } as const;
export type SampleBackend = (typeof SampleBackend)[keyof typeof SampleBackend];
const isSampleBackend = (value: unknown): boolean =>
  typeof value === "string" && Object.values(SampleBackend).some((backend) => backend === value);

/** The sample format this comparison reads, and the samples each side of it takes. */
const SAMPLE_SCHEMA = 1;
const PAIRED_SAMPLES = 3;
/** The share of a run's wall clock the optimization stage may take, and the most it may take. */
const OPTIMIZATION_SHARE = 0.1;
const MAX_OPTIMIZATION_MS = 10 * MINUTE_MS;

/** The time the optimization stage is given out of a run's `total`: a tenth, never more than ten minutes. */
export const optimizationAllowance = (total: number): number =>
  Math.max(0, Math.min(total * OPTIMIZATION_SHARE, MAX_OPTIMIZATION_MS));
export const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
export const median = (xs: readonly number[]): number | null => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)]! + s[Math.floor(s.length / 2)]!) / 2 : null;
};
const spread = (xs: readonly number[]): number => Math.max(...xs) - Math.min(...xs);
const canonical = (x: unknown): string =>
  JSON.stringify(x, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
export function cadence(intervals: readonly number[]): {
  count: number;
  elapsedMs: number;
  fps: number | null;
  frameMs: number | null;
} {
  const good = intervals.filter((n) => finite(n) && n > 0);
  const elapsedMs = good.reduce((a, b) => a + b, 0);
  return {
    count: good.length,
    elapsedMs,
    fps: good.length >= PROFILE_DEFAULTS.minIntervals ? (SECOND_MS * good.length) / elapsedMs : null,
    frameMs: good.length >= PROFILE_DEFAULTS.minIntervals ? elapsedMs / good.length : null,
  };
}
export function comparableSamples(
  a: PerformanceSample | null | undefined,
  b: PerformanceSample | null | undefined,
): string | null {
  if (!a || !b) return "missing sample";
  if (a.schemaVersion !== SAMPLE_SCHEMA || b.schemaVersion !== SAMPLE_SCHEMA) return "missing sample";
  for (const key of ["backend", "renderer", "version", "scope", "scenarioId"]) {
    if (a[key] == null || a[key] !== b[key]) return `${key} changed or unavailable`;
  }
  if (!isSampleBackend(a.backend) || !a.version) return "actual backend/version unavailable";
  if (canonical(a.configuration) !== canonical(b.configuration))
    return "view, resolution or render configuration changed";
  return null;
}
/** What a before/after profile comparison concluded. */
export interface PerformanceComparison {
  comparable: boolean;
  improved: boolean;
  reason: string;
  gains: string[];
}

export function comparePerformance(
  before: PerformanceSample[] | null | undefined,
  after: PerformanceSample[] | null | undefined,
  bracket: PerformanceSample | null | undefined,
): PerformanceComparison {
  const unpaired = before?.length !== PAIRED_SAMPLES || after?.length !== PAIRED_SAMPLES;
  if (unpaired || !bracket) return notComparable("three paired samples and a final baseline bracket are required");
  const unfit = unfitSample(before, after, bracket);
  if (unfit) return notComparable(unfit);
  // Large cadence variation is an attribution failure, not extra tolerance that a draw-call
  // win can use to hide a playback regression or a changed machine load.
  if (cadenceVaried(before, after, bracket))
    return notComparable("Playback conditions varied too much for a reliable comparison");
  const read = readMetrics(before, after, bracket);
  if ("comparable" in read) return read;
  const { gains, measured } = read;
  if (!measured) return notComparable("no comparable runtime metrics");
  // A counter win cannot hide unknown playback performance.
  const cadenceKnown = [...before, ...after].every((s) => finite(s.metrics?.frameMs?.value));
  if (!cadenceKnown) return notComparable("live playback cadence unavailable");
  return {
    comparable: true,
    improved: gains.length > 0,
    reason: gains.length
      ? `Verified reduction in ${gains.map((k) => METRIC_WORDS[k]).join(", ")}`
      : "No verified improvement beyond observed variation",
    gains,
  };
}

/** Every compared metric's verdict: the first that settles the comparison, or the gains and how many were measured. */
function readMetrics(
  before: PerformanceSample[],
  after: PerformanceSample[],
  bracket: PerformanceSample,
): PerformanceComparison | { gains: string[]; measured: number } {
  const gains: string[] = [];
  let measured = 0;
  for (const key of COMPARED_METRICS) {
    const verdict = compareMetric(key, before, after, bracket);
    if (verdict === MetricVerdict.Skipped) continue;
    if (verdict === MetricVerdict.Unmeasured) return notComparable(`${key} became unmeasured`);
    if (verdict === MetricVerdict.Regressed)
      return { comparable: true, improved: false, reason: `${key} regressed`, gains: [] };
    measured++;
    if (verdict === MetricVerdict.Gained) gains.push(key);
  }
  return { gains, measured };
}

/** A comparison that cannot be trusted, and why. */
function notComparable(reason: string): PerformanceComparison {
  return { comparable: false, improved: false, reason, gains: [] };
}

/** The first sample that cannot stand beside the others — changed setup, no cadence, or another revision. */
function unfitSample(
  before: PerformanceSample[],
  after: PerformanceSample[],
  bracket: PerformanceSample,
): string | null {
  const [first] = before;
  for (const s of [...before, ...after, bracket]) {
    const why = comparableSamples(first, s);
    if (why) return why;
    if (!((s.metrics?.frameMs?.value as number) > 0)) return "live playback cadence unavailable";
    const expectedTree = after.includes(s) ? after[0]?.revision?.tree : first?.revision?.tree;
    if (!s.revision?.tree || s.revision.tree !== expectedTree) return "sample revision changed or unavailable";
  }
  return null;
}

/** A sample's frame interval; every sample was checked for one by `unfitSample`. */
const cadenceOf = (s: PerformanceSample): number => Number(s.metrics?.frameMs?.value);

/** The frame interval moved more than a tenth of the baseline (at least 1 ms) within or between the runs. */
function cadenceVaried(before: PerformanceSample[], after: PerformanceSample[], bracket: PerformanceSample): boolean {
  const baselineCadence = before.map(cadenceOf);
  const candidateCadence = after.map(cadenceOf);
  const baseline = Number(median(baselineCadence));
  const cadenceLimit = Math.max(1, 0.1 * baseline);
  const variation = Math.max(
    spread(baselineCadence),
    spread(candidateCadence),
    Math.abs(cadenceOf(bracket) - baseline),
  );
  return variation > cadenceLimit;
}

/**
 * One metric across the paired samples. A metric with a value that is not a number is skipped
 * — unless the baseline had it and the candidate lost it. A regression is a candidate median
 * above the baseline's by more than the noise; a gain is below it by more, on every pair, and
 * with the bracket back above the candidate.
 */
function compareMetric(
  key: ComparedMetric,
  before: PerformanceSample[],
  after: PerformanceSample[],
  bracket: PerformanceSample,
): MetricVerdict {
  // Read as numbers: the `finite` check right below skips a metric with any value that is not.
  const a = before.map((s) => s.metrics?.[key]?.value) as number[];
  const b = after.map((s) => s.metrics?.[key]?.value) as number[];
  const last = bracket.metrics?.[key]?.value as number;
  if (![...a, ...b, last].every(finite))
    return [...a, last].every(finite) ? MetricVerdict.Unmeasured : MetricVerdict.Skipped;
  const baseline = Number(median(a));
  const candidate = Number(median(b));
  const drift = Math.abs(last - baseline);
  const noise = Math.max(spread(a), spread(b), drift);
  const margin = key === "frameMs" ? Math.max(0.25, 2 * noise) : Math.max(0, 2 * noise);
  if (candidate - baseline > margin) return MetricVerdict.Regressed;
  const everyPairLower = b.every((n, i) => n < Number(a[i]));
  const gained = baseline - candidate > margin && everyPairLower && last > candidate;
  if (gained) return MetricVerdict.Gained;
  return MetricVerdict.Unchanged;
}
export function preservedChecks(
  before: readonly CheckOutcome[] | null | undefined,
  after: readonly CheckOutcome[] | null | undefined,
): string[] {
  const errors: string[] = [];
  for (const b of before ?? [])
    if (b.pass === true) {
      const a = (after ?? []).find((a) => a.id === b.id);
      if (a?.pass !== true)
        errors.push(`${b.id}: previously passing check ${a?.pass === false ? "failed" : "unmeasured"}`);
    }
  return errors;
}

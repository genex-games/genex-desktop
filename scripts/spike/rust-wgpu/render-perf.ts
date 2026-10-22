/**
 * The renderer perf gate (renderer follow-up RQ0.9). It runs the showcase crate's perf matrix
 * (`examples/showcase/tests/perf_matrix.rs`: scenes x profiles x sizes on the host GPU, CPU and
 * GPU-timestamp p50/p95 per row), records a baseline, compares a fresh run against it and prints the
 * feature costs against the plan's budgets (plan 2.10).
 *
 *   node scripts/spike/rust-wgpu/render-perf.ts --profiles off --record baseline [--head]
 *   node scripts/spike/rust-wgpu/render-perf.ts --profiles off --compare baseline
 *   node scripts/spike/rust-wgpu/render-perf.ts --profiles off --ab rq0-head --runs 5
 *   node scripts/spike/rust-wgpu/render-perf.ts --profiles off,low,medium,high,ultra --compare baseline
 *   node scripts/spike/rust-wgpu/render-perf.ts --save-bin rq0
 *   node scripts/spike/rust-wgpu/render-perf.ts --save-bin pre-rq2 --head --rev 7d49ad95^
 *
 * - Statistic: GPU timestamp p95 per scene (`frameMs`, the whole frame with the GPU wait, when a side
 *   has no timestamps), at least 600 measured frames per row, the median over `--runs` runs (3; an
 *   interleaved A/B 5, owner decision 2026-10-13). The CPU encode time is a separate metric. The
 *   report prints each run's p95 on both sides beside the gated median, and an A/B's paired run
 *   ratios (`formatComparison`).
 * - `--statistic median|min` picks which p95 of the runs is compared: the median (the default of `--ab`,
 *   whose sides share the machine's load) or the best run (the default against a stored baseline: on a
 *   shared machine contention only adds time, so a real regression is slower at its best too). Scenes
 *   whose runs disagree by more than 25% are measured again, alone, up to four more times.
 * - `--compare` exits 1 when a scene of profile `off` has a p95 above 1.10 x the baseline's, or is
 *   missing from the run. Other profiles, and the Lakeside scenes' `off` rows against a baseline
 *   built before the Lakeside content (`INFORMATIONAL_OFF_SCENES`, `lakesideGatedFor`), report their
 *   ratios and never fail the gate.
 * - Records from different adapters, power sources or thermal states are never compared (refusal
 *   exit 78); the baseline is a local evidence file (`.studio-dev/evidence/rust-renderer/perf/baseline.json`).
 * - `--ab <tier>` interleaves runs of the saved executable `perf/bin/<tier>/` (`perf_matrix`, or the
 *   pre-refactor `render-baseline` bench, compared on the whole-frame metric both have) with the current
 *   build's, and compares the medians: old commits are never rebuilt. `--save-bin <tier>` saves the
 *   current build's executable there, with what it was built from (`SOURCE_SHA`, and `SOURCE_TREE`:
 *   the commit, whether it was a snapshot, and a sha256 of the working tree's tracked diff of
 *   `native/genex-rust` when it was not), so a saved side is never an unidentified dirty tree.
 * - `--head` builds the committed HEAD (a `git archive` snapshot with the harness's files laid over it,
 *   in its own cargo target) instead of the working tree, so a baseline is HEAD's renderer whatever
 *   other work is half-edited around it; `--rev <commit>` snapshots that commit instead (a saved
 *   "before" side, e.g. the commit before a tier).
 * - The gate row (`tests/conformance/render-perf-gate.test.ts`, `GENEX_REQUIRE_METAL=1`) runs `GATE_ARGS`:
 *   profile off, the median of 5 interleaved A/B runs against the saved `rq0-head` executable (owner
 *   decision 2026-10-13 (1)); it skips while `perf/bin/rq0-head/` holds no executable.
 * - Environment: the matrix reads `GENEX_PERF_*` (frames, warm-up, sizes, profiles, rows, out); this script
 *   sets them from its options. A developer measurement: the app never runs or imports it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statfsSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const REPO = path.resolve(import.meta.dirname, "../../..");
const RENDERER_EVIDENCE = path.join(REPO, ".studio-dev", "evidence", "rust-renderer");
/** The local perf evidence folder. */
export const PERF_DIR = path.join(RENDERER_EVIDENCE, "perf");
/** The recorded baseline (a local evidence file; the gate row skips without it). */
export const BASELINE_PATH = path.join(PERF_DIR, "baseline.json");
const BUDGETS_PATH = path.join(REPO, "tests", "fixtures", "render-perf", "budgets.json");
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");

/** Measured frames per row the gate needs. */
export const MIN_GATE_FRAMES = 600;
/** The `off` profile's p95 may be at most this multiple of the baseline's. */
export const MAX_OFF_RATIO = 1.1;
const DEFAULT_WARMUP = 60;
const DEFAULT_RUNS = 3;
/** Interleaved A/B runs when `--runs` is not given: the features-off rule's median of 5 (owner decision 2026-10-13 (1)). */
const AB_DEFAULT_RUNS = 5;
/** Runs of one row whose p95 differ by more than this factor (largest over smallest) are noisy. */
export const NOISE_SPREAD = 1.25;
/** Noisy scenes are measured again, alone, at most this many more times. */
const MAX_EXTRA_RUNS = 4;
const OFF = "off";
const DEFAULT_PROFILES = [OFF];
/** Free GiB under which the shared cargo target should be cleaned, and under which heavy work stops. */
const DISK_WARN_GIB = 8;
const DISK_STOP_GIB = 5;
const GIB = 1024 ** 3;
/** The exit code of a refusal (EX_CONFIG), the other toolchain scripts' too. */
const REFUSAL_EXIT = 78;
const REFUSAL_PREFIX = "genex-render-perf-refusal: ";
/** Name of a record or saved executable folder: no separators, so it cannot leave the perf folder. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MATRIX_BIN = "perf_matrix";
/** The snapshot a `--head` build compiles, and its own cargo target (the shared one is for the working tree). */
const SNAPSHOT_DIR = path.join(REPO, ".studio-dev", "perf-snapshot");
const HEAD_TARGET_DIR = path.join(REPO, ".studio-dev", "cargo-target-perf-head");
/** The harness's files (relative to the workspace) laid over a `git archive` of a commit that does not hold them yet. */
const HARNESS_FILES = [
  "examples/showcase/src/lib.rs",
  "examples/showcase/src/stress.rs",
  "examples/showcase/tests/perf_matrix.rs",
];
const BENCH_BIN = "render-baseline";
/** The saved executable the gate row's interleaved A/B measures against: the renderer before RQ0's work. */
export const GATE_TIER = "rq0-head";
/** The folder `--save-bin rq0-head` saved the gate's executable in (a local evidence folder). */
export const GATE_TIER_DIR = path.join(PERF_DIR, "bin", GATE_TIER);
/** The gate row's command line: the features-off rule's statistic of owner decision 2026-10-13 (1). */
export const GATE_ARGS: readonly string[] = ["--profiles", OFF, "--ab", GATE_TIER, "--runs", String(AB_DEFAULT_RUNS)];

/** p50/p95/mean/max of one metric, milliseconds. */
export interface Summary {
  p50: number;
  p95: number;
  mean: number;
  max: number;
}

/** The metrics a row carries. */
export type MetricName = "gpuMs" | "frameMs" | "cpuMs";

/** One row of a perf record: a scene at a size under a profile. */
export interface PerfRow {
  row: string;
  /** Absent in records of the pre-refactor bench: that renderer is `off`. */
  profile?: string;
  size: number[];
  camera?: string;
  frames: number;
  cpuMs: Summary;
  frameMs: Summary;
  gpuMs: Summary | null;
  nodes?: unknown;
  nodesReason?: string;
  stats?: Record<string, number>;
  scene?: unknown;
  applied?: {
    profile?: string;
    class?: string;
    renderScale?: number;
    wired?: boolean;
    featuresRequested?: string[];
    /** The requested features this build's renderer draws (a record before RQ0's review has none). */
    featuresDrawn?: string[];
    /** A drawn feature's shape (its knobs), where a profile can draw a feature `off` also draws
     * otherwise: the sun shadows' cascades, size, format, filter and reach (RQ3 review). */
    featureShapes?: Record<string, string>;
  };
  /** The p95 of each run a merged row comes from. */
  runsP95?: Partial<Record<MetricName, number[]>>;
}

/** The host state a record was taken in. */
export interface HostState {
  power: string;
  thermal: string;
  /** One-minute load average before and after the run (a busy machine makes timings noisy). */
  load1?: number[];
}

/** A perf record: what the matrix (or the pre-refactor bench) writes, or a merge of runs. */
export interface PerfRecord {
  harness: string;
  version: number;
  recordedAt: number;
  build: { sha: string; trackedChanges: boolean; profile?: string; source?: string };
  adapter: { name: string; backend: string; key?: string };
  timestamps?: { available: boolean; periodNs?: number; reason?: string };
  host: HostState;
  /** The state of each run of a merge. */
  hostStates?: HostState[];
  deviceClass?: string;
  method: { warmupFrames: number; measuredFrames: number; runs?: number; statistic?: string; [key: string]: unknown };
  rows: PerfRow[];
}

/** Why records are not compared. */
export const PerfRefusal = {
  AdapterMismatch: "adapter-mismatch",
  PowerMismatch: "power-mismatch",
  ThermalMismatch: "thermal-mismatch",
  TooFewFrames: "too-few-frames",
} as const;
export type PerfRefusal = (typeof PerfRefusal)[keyof typeof PerfRefusal];

/** Which p95 of a merged row is compared. */
export const Statistic = {
  /** The median over the runs (the plan's statistic, and the interleaved A/B's). */
  Median: "median",
  /** The best run: on a shared machine contention only adds time, so a real regression is slower at its best too. */
  Min: "min",
} as const;
export type Statistic = (typeof Statistic)[keyof typeof Statistic];

/** What a compared row came to. */
export const RowVerdict = {
  Ok: "ok",
  Regressed: "regressed",
  Missing: "missing",
  Info: "info",
} as const;
export type RowVerdict = (typeof RowVerdict)[keyof typeof RowVerdict];

/** Why the gate row does not run. */
export const GateSkip = {
  /** `--compare` names a stored record that does not exist. */
  NoBaseline: "no-baseline",
  /** The gate's saved executable (`perf/bin/rq0-head/`) is not on this machine. */
  NoSavedExecutable: "no-saved-executable",
  NoMetal: "no-metal",
} as const;
export type GateSkip = (typeof GateSkip)[keyof typeof GateSkip];

/** A refusal with the facts that caused it. */
export interface Refusal {
  code: PerfRefusal;
  detail: string;
}

/** One compared row. */
export interface RowComparison {
  row: string;
  profile: string;
  size: number[];
  metric: MetricName | null;
  baselineP95: number | null;
  candidateP95: number | null;
  ratio: number | null;
  verdict: RowVerdict;
  /** Either side's runs of this row disagree by more than [`NOISE_SPREAD`]. */
  noisy: boolean;
  /** Each run's p95 of the compared metric on both sides (absent when no metric compared). */
  runs?: RunP95s;
}

/** The p95 of every run a compared row's sides merge, and the ratios of runs that ran as pairs. */
export interface RunP95s {
  baseline: number[];
  candidate: number[];
  /**
   * Run n of the candidate over run n of the baseline, when both sides hold the same number of
   * runs (an interleaved A/B: each pair shared the machine's state); null otherwise.
   */
  ratios: number[] | null;
}

/** The outcome of comparing two records. */
export interface Comparison {
  refusals: Refusal[];
  rows: RowComparison[];
  failures: RowComparison[];
  passed: boolean;
  /** The highest ratio among gated `off` rows (null when none was compared). */
  worstOffRatio: number | null;
}

/** What `compareRecords` takes besides the records. */
export interface CompareOptions {
  /** `off` rows fail above this multiple of the baseline (1.10). */
  maxRatio?: number;
  /** Both sides' rows need at least this many measured frames (0: no minimum). */
  minFrames?: number;
  /** The metric to compare; `auto` takes GPU timestamps when both sides have them, else the whole frame. */
  metric?: MetricName | "auto";
  /** Which p95 of a merged row to compare: the median over its runs (default) or the best run. */
  statistic?: Statistic;
  /** Only these profiles (default: every profile of the baseline). */
  profiles?: readonly string[];
  /** Only these scenes (default: every scene of the baseline). */
  rows?: readonly string[];
  /**
   * The baseline draws the current Lakeside content ({@link lakesideGatedFor}), so its Lakeside
   * `off` rows gate like every other (default false: {@link INFORMATIONAL_OFF_SCENES} apply).
   */
  lakesideGated?: boolean;
}

function profileOf(row: PerfRow): string {
  return row.profile ?? OFF;
}

function sizeKey(size: readonly number[]): string {
  return `${size[0]}x${size[1]}`;
}

function rowKey(row: PerfRow): string {
  return `${row.row}|${profileOf(row)}|${sizeKey(row.size)}`;
}

/** The adapter a record was taken on, as the records compare it. */
export function adapterKey(record: PerfRecord): string {
  return record.adapter.key ?? `${record.adapter.backend}/${record.adapter.name}`;
}

/** `ac`, `battery`, `ups` or `unknown` from `pmset -g ps` output. */
export function powerSource(raw: string): string {
  const source = /Now drawing from '([^']+)'/.exec(raw)?.[1]?.toLowerCase();
  if (source === undefined) return "unknown";
  if (source.startsWith("ac")) return "ac";
  if (source.startsWith("battery")) return "battery";
  if (source.startsWith("ups")) return "ups";
  return "unknown";
}

/** `nominal`, `limited-<n>` (the lowest CPU limit below 100) or `warning` from `pmset -g therm` output. */
export function thermalState(raw: string): string {
  if (raw.trim() === "" || raw === "unknown") return "unknown";
  const limits = [...raw.matchAll(/CPU_(?:Speed|Scheduler)_Limit\s*=\s*(\d+)/g)].map((m) => Number(m[1]));
  const lowest = limits.length === 0 ? 100 : Math.min(...limits);
  if (lowest < 100) return `limited-${lowest}`;
  const warned = /(?:thermal|performance) warning level[^;]*?(?:=|:)\s*([1-9]\d*)/i.test(raw);
  return warned ? "warning" : "nominal";
}

/** The power source and thermal state of a record, over every run when it is a merge. */
export function hostState(record: PerfRecord): HostState {
  const states = record.hostStates ?? [record.host];
  const unique = (values: string[]) => [...new Set(values)].sort().join("+");
  return {
    power: unique(states.map((s) => powerSource(s.power))),
    thermal: unique(states.map((s) => thermalState(s.thermal))),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const middle = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? middle : (middle + (sorted[mid - 1] ?? middle)) / 2;
}

function mergeSummaries(summaries: readonly Summary[]): Summary {
  const field = (key: keyof Summary) => median(summaries.map((s) => s[key]));
  return { p50: field("p50"), p95: field("p95"), mean: field("mean"), max: field("max") };
}

/**
 * The median over runs of one setup: each row's p50, p95, mean and max become the median of the
 * runs'. The runs must come from one adapter; their power and thermal states are kept per run.
 */
export function mergeRuns(runs: readonly PerfRecord[]): PerfRecord {
  const first = runs[0];
  if (first === undefined) throw new Error("no runs to merge");
  const key = adapterKey(first);
  for (const run of runs) {
    if (adapterKey(run) !== key) {
      throw new Error(`${PerfRefusal.AdapterMismatch}: runs from ${key} and ${adapterKey(run)} cannot be merged`);
    }
  }
  const rows: PerfRow[] = first.rows.map((row) => {
    const same = runs
      .map((run) => run.rows.find((r) => rowKey(r) === rowKey(row)))
      .filter((r): r is PerfRow => r !== undefined);
    const gpu = same.map((r) => r.gpuMs).filter((g): g is Summary => g !== null && g !== undefined);
    const runsP95: Partial<Record<MetricName, number[]>> = {
      frameMs: same.map((r) => r.frameMs.p95),
      cpuMs: same.map((r) => r.cpuMs.p95),
    };
    if (gpu.length > 0) runsP95.gpuMs = gpu.map((g) => g.p95);
    return {
      ...row,
      frames: Math.min(...same.map((r) => r.frames)),
      cpuMs: mergeSummaries(same.map((r) => r.cpuMs)),
      frameMs: mergeSummaries(same.map((r) => r.frameMs)),
      gpuMs: gpu.length === same.length && gpu.length > 0 ? mergeSummaries(gpu) : null,
      runsP95,
    };
  });
  return {
    ...first,
    hostStates: runs.map((run) => run.host),
    method: { ...first.method, runs: runs.length },
    rows,
  };
}

function metricOf(row: PerfRow, metric: MetricName): Summary | null {
  return row[metric] ?? null;
}

/** The p95 of `metric` under `statistic` (a row that is not a merge has one run: its own). */
function p95Of(row: PerfRow, metric: MetricName, statistic: Statistic): number | undefined {
  const own = metricOf(row, metric)?.p95;
  const runs = row.runsP95?.[metric];
  if (statistic === Statistic.Min && runs !== undefined && runs.length > 0) return Math.min(...runs);
  return own;
}

/** Each run's p95 of `metric` in a row (a row that is not a merge is its own single run). */
function runP95s(row: PerfRow, metric: MetricName): number[] {
  const runs = row.runsP95?.[metric];
  if (runs !== undefined && runs.length > 0) return runs;
  const own = metricOf(row, metric)?.p95;
  return own === undefined ? [] : [own];
}

/** Both sides' runs of a compared row and, for sides of equal run counts, their paired ratios. */
function pairedRuns(base: PerfRow, candidate: PerfRow, metric: MetricName): RunP95s {
  const [a, b] = [runP95s(base, metric), runP95s(candidate, metric)];
  const paired = a.length === b.length && a.length > 1 && a.every((value) => value > 0);
  return { baseline: a, candidate: b, ratios: paired ? b.map((value, n) => value / (a[n] ?? 1)) : null };
}

/** The largest over the smallest p95 of a merged row's runs of `metric` (1 with fewer than two runs). */
export function rowSpread(row: PerfRow, metric: MetricName): number {
  const values = row.runsP95?.[metric] ?? [];
  if (values.length < 2) return 1;
  const [low, high] = [Math.min(...values), Math.max(...values)];
  return low > 0 ? high / low : 1;
}

/** The scenes (in row order) with a row whose runs disagree by more than [`NOISE_SPREAD`]. */
export function noisyScenes(record: PerfRecord): string[] {
  const names = record.rows.filter((r) => rowSpread(r, r.gpuMs ? "gpuMs" : "frameMs") > NOISE_SPREAD).map((r) => r.row);
  return [...new Set(names)];
}

function chooseMetric(want: MetricName | "auto", base: PerfRow, candidate: PerfRow): MetricName | null {
  if (want !== "auto") return metricOf(base, want) && metricOf(candidate, want) ? want : null;
  return base.gpuMs && candidate.gpuMs ? "gpuMs" : "frameMs";
}

function sideRefusals(base: PerfRecord, candidate: PerfRecord, minFrames: number, keys: Set<string>): Refusal[] {
  const refusals: Refusal[] = [];
  if (adapterKey(base) !== adapterKey(candidate)) {
    refusals.push({
      code: PerfRefusal.AdapterMismatch,
      detail: `baseline ${adapterKey(base)}, candidate ${adapterKey(candidate)}`,
    });
  }
  const [a, b] = [hostState(base), hostState(candidate)];
  if (a.power !== b.power) {
    refusals.push({ code: PerfRefusal.PowerMismatch, detail: `baseline ${a.power}, candidate ${b.power}` });
  }
  if (a.thermal !== b.thermal) {
    refusals.push({ code: PerfRefusal.ThermalMismatch, detail: `baseline ${a.thermal}, candidate ${b.thermal}` });
  }
  if (minFrames > 0) {
    for (const [side, record] of [["baseline", base] as const, ["candidate", candidate] as const]) {
      const short = record.rows.filter((r) => keys.has(rowKey(r)) && r.frames < minFrames);
      if (short.length > 0) {
        refusals.push({
          code: PerfRefusal.TooFewFrames,
          detail: `${side}: ${short.length} rows under ${minFrames} frames (first: ${short[0]?.row} with ${short[0]?.frames})`,
        });
      }
    }
  }
  return refusals;
}

/**
 * Scenes whose `off` rows are information, never gated (owner decision 2026-10-12): the Lakeside
 * shots' content was remastered at bf0920e1 (and Lakeside v2 added four shots and the cabin's
 * room in renderer pass 2), so no baseline commit draws the same scene. The
 * features-off rule covers the bench and stress scenes, whose content is unchanged.
 */
export const INFORMATIONAL_OFF_SCENES: ReadonlySet<string> = new Set([
  "lakeside-wide",
  "lakeside-dock",
  "lakeside-cabin",
  "lakeside-forest",
  "lakeside-closeup",
  "lakeside-golden-wide",
  "lakeside-shore",
  "lakeside-forest-floor",
  "lakeside-cabin-interior",
]);

/**
 * The commit that last changed what the Lakeside scenes draw (renderer pass 2's Lakeside v2: four
 * new shots and the cabin's room). A baseline built from it or a later commit draws the same
 * scenes as the current build.
 */
export const LAKESIDE_CONTENT_COMMIT = "9177556a1925e322576b41be8e2642ed669e78f0";

/**
 * Whether a baseline built from `baseSha` draws the current Lakeside content, so its Lakeside `off`
 * rows are gated: it descends from {@link LAKESIDE_CONTENT_COMMIT}. `isAncestor` answers whether
 * `ancestor` is an ancestor of `sha` (null: unknown); an unknown or missing commit keeps the
 * exemption.
 */
export function lakesideGatedFor(
  baseSha: string,
  isAncestor: (ancestor: string, sha: string) => boolean | null,
): boolean {
  if (baseSha === "") return false;
  return isAncestor(LAKESIDE_CONTENT_COMMIT, baseSha) === true;
}

/** Whether `ancestor` is an ancestor of `sha` in this repository (null: either is unknown). */
function gitIsAncestor(ancestor: string, sha: string): boolean | null {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, sha], { cwd: REPO });
  if (result.status === 0) return true;
  return result.status === 1 ? false : null;
}

/** Whether a scene's rows are information only: an exempt Lakeside scene, unless gated. */
function isInformational(row: { row: string }, lakesideGated: boolean): boolean {
  return !lakesideGated && INFORMATIONAL_OFF_SCENES.has(row.row);
}

/** Whether a row's ratio is gated: an `off` row of a scene the rule covers. */
function isGated(row: { row: string; profile: string }, lakesideGated: boolean): boolean {
  return row.profile === OFF && !isInformational(row, lakesideGated);
}

/** What a row's ratio comes to: only gated rows ({@link isGated}) can regress. */
function gatedVerdict(
  row: { row: string; profile: string },
  ratio: number,
  maxRatio: number,
  lakesideGated: boolean,
): RowVerdict {
  if (!isGated(row, lakesideGated)) return RowVerdict.Info;
  return ratio > maxRatio ? RowVerdict.Regressed : RowVerdict.Ok;
}

/**
 * Compare `candidate` to `baseline` row by row (scene x profile x size) on the p95 of one metric.
 * Records from another adapter, power source or thermal state are refused and no row is compared. An
 * `off` row fails above `maxRatio` of the baseline's p95; a baseline row the candidate lacks fails
 * whatever its profile; other profiles' ratios are information.
 */
export function compareRecords(baseline: PerfRecord, candidate: PerfRecord, options: CompareOptions = {}): Comparison {
  const maxRatio = options.maxRatio ?? MAX_OFF_RATIO;
  const lakesideGated = options.lakesideGated ?? false;
  const statistic = options.statistic ?? Statistic.Median;
  const wantProfiles = options.profiles ? new Set(options.profiles) : null;
  const wantRows = options.rows ? new Set(options.rows) : null;
  const selected = baseline.rows.filter(
    (r) => (!wantProfiles || wantProfiles.has(profileOf(r))) && (!wantRows || wantRows.has(r.row)),
  );
  const keys = new Set(selected.map(rowKey));
  const refusals = sideRefusals(baseline, candidate, options.minFrames ?? 0, keys);
  if (refusals.length > 0) return { refusals, rows: [], failures: [], passed: false, worstOffRatio: null };
  const byKey = new Map(candidate.rows.map((r) => [rowKey(r), r] as const));
  const rows: RowComparison[] = selected.map((base) => {
    const profile = profileOf(base);
    const header = { row: base.row, profile, size: base.size };
    const other = byKey.get(rowKey(base));
    // A row of an informational scene the candidate lacks is information too.
    const absent = isInformational(base, lakesideGated) ? RowVerdict.Info : RowVerdict.Missing;
    if (other === undefined) {
      return {
        ...header,
        metric: null,
        baselineP95: null,
        candidateP95: null,
        ratio: null,
        verdict: absent,
        noisy: false,
      };
    }
    const metric = chooseMetric(options.metric ?? "auto", base, other);
    const [a, b] = metric ? [p95Of(base, metric, statistic), p95Of(other, metric, statistic)] : [undefined, undefined];
    if (metric === null || a === undefined || b === undefined || a <= 0) {
      return {
        ...header,
        metric,
        baselineP95: a ?? null,
        candidateP95: b ?? null,
        ratio: null,
        verdict: absent,
        noisy: false,
      };
    }
    const ratio = b / a;
    const verdict = gatedVerdict(header, ratio, maxRatio, lakesideGated);
    const noisy = Math.max(rowSpread(base, metric), rowSpread(other, metric)) > NOISE_SPREAD;
    const runs = pairedRuns(base, other, metric);
    return { ...header, metric, baselineP95: a, candidateP95: b, ratio, verdict, noisy, runs };
  });
  const failures = rows.filter((r) => r.verdict === RowVerdict.Regressed || r.verdict === RowVerdict.Missing);
  const offRatios = rows.filter((r) => isGated(r, lakesideGated) && r.ratio !== null).map((r) => r.ratio ?? 0);
  return {
    refusals,
    rows,
    failures,
    passed: failures.length === 0,
    worstOffRatio: offRatios.length > 0 ? Math.max(...offRatios) : null,
  };
}

/**
 * The features a row's frames drew: what the renderer drew of what the profile asked for, or, for
 * a record that does not say, what it asked for (empty when it says neither). A feature asked for
 * but not drawn yet costs nothing and is never attributed.
 */
export function switchedOn(row: PerfRow | undefined): string[] {
  return row?.applied?.featuresDrawn ?? row?.applied?.featuresRequested ?? [];
}

/** The plan's per-feature GPU budgets (tests/fixtures/render-perf/budgets.json). */
export interface Budgets {
  format: string;
  resolution: number[];
  unit: string;
  /**
   * One budget per entry. `shapes`, when present, names the shape (`applied.featureShapes`) each
   * of its features must be drawn in for the entry to apply: GTAO's budget is per resolution.
   */
  entries: Array<{ id: string; features: string[]; budgetMs: number; shapes?: Record<string, string> }>;
}

/** One profile row's added cost against the budgets of the features it switched on. */
export interface FeatureCost {
  row: string;
  profile: string;
  size: number[];
  /** Whether the renderer drew the features (else nothing is attributed). */
  wired: boolean;
  /** GPU p95 added over the same scene under `off`. */
  deltaMs: number;
  budgetMs: number;
  budgetEntries: string[];
  withinBudget: boolean | null;
}

/**
 * The features `row` adds over `off`'s row: drawn by it and not by `off`, or drawn by both in
 * another shape (`off` draws the legacy sun shadows; a preset draws its own cascades, filter and
 * reach, whose added cost is the shadow budget's).
 */
export function addedOver(row: PerfRow, off: PerfRow): Set<string> {
  const offDrawn = switchedOn(off);
  const shape = (r: PerfRow, feature: string) => r.applied?.featureShapes?.[feature];
  const reshaped = (feature: string) =>
    shape(row, feature) !== undefined && shape(row, feature) !== shape(off, feature);
  return new Set(switchedOn(row).filter((feature) => !offDrawn.includes(feature) || reshaped(feature)));
}

/**
 * The cost of every non-`off` row at the budgets' resolution: its p95 minus `off`'s for the same
 * scene, against the sum of the budgets whose features the profile adds over `off`
 * ({@link addedOver}) in the shapes an entry names, if any. A row the renderer did not draw (`applied.wired` false) has nothing to
 * attribute.
 */
export function featureCosts(record: PerfRecord, budgets: Budgets): FeatureCost[] {
  const [width, height] = budgets.resolution;
  const rows = record.rows.filter((r) => r.size[0] === width && r.size[1] === height);
  const costs: FeatureCost[] = [];
  for (const row of rows.filter((r) => profileOf(r) !== OFF)) {
    const off = rows.find((r) => r.row === row.row && profileOf(r) === OFF);
    if (off === undefined) continue;
    const metric: MetricName = row.gpuMs && off.gpuMs ? "gpuMs" : "frameMs";
    const deltaMs = (metricOf(row, metric)?.p95 ?? 0) - (metricOf(off, metric)?.p95 ?? 0);
    const added = addedOver(row, off);
    const shapes = row.applied?.featureShapes ?? {};
    const shaped = (e: Budgets["entries"][number]) =>
      Object.entries(e.shapes ?? {}).every(([feature, shape]) => shapes[feature] === shape);
    const entries = budgets.entries.filter((e) => e.features.every((f) => added.has(f)) && shaped(e));
    const wired = row.applied?.wired === true;
    const budgetMs = entries.reduce((sum, e) => sum + e.budgetMs, 0);
    costs.push({
      row: row.row,
      profile: profileOf(row),
      size: row.size,
      wired,
      deltaMs,
      budgetMs,
      budgetEntries: entries.map((e) => e.id),
      withinBudget: wired && entries.length > 0 ? deltaMs <= budgetMs : null,
    });
  }
  return costs;
}

/** What the gate row does. */
export type GateStatus = { run: true } | { run: false; skip: GateSkip };

/** The gate row runs only with its saved executable in `tierDir` and `GENEX_REQUIRE_METAL=1`. */
export function gateStatus(input: { tierDir: string; env: NodeJS.ProcessEnv }): GateStatus {
  if (savedExecutableIn(input.tierDir) === null) return { run: false, skip: GateSkip.NoSavedExecutable };
  if (input.env.GENEX_REQUIRE_METAL !== "1") return { run: false, skip: GateSkip.NoMetal };
  return { run: true };
}

// ---- the runner ----------------------------------------------------------------------------

class PerfRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function freeGib(): number {
  const stats = statfsSync(os.homedir());
  return (stats.bavail * stats.bsize) / GIB;
}

function checkDisk(): void {
  const free = freeGib();
  if (free < DISK_STOP_GIB)
    throw new PerfRefused("disk", `${free.toFixed(1)} GiB free; heavy work stops under ${DISK_STOP_GIB}`);
  if (free < DISK_WARN_GIB) {
    process.stderr.write(`note: ${free.toFixed(1)} GiB free; cargo clean the shared target before heavy builds\n`);
  }
}

function safeName(kind: string, value: string): string {
  if (!SAFE_NAME.test(value)) throw new PerfRefused("usage", `${kind} "${value}" is not a plain name`);
  return value;
}

function readRecord(file: string): PerfRecord {
  return JSON.parse(readFileSync(file, "utf8")) as PerfRecord;
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new PerfRefused("git", `git ${args.join(" ")} exited ${result.status}`);
  return result.stdout.trim();
}

/**
 * A committed revision's workspace (`rev`, HEAD by default) in a scratch folder, with the harness's
 * files laid over it: a baseline that is that commit's renderer whatever other work is half-edited
 * in the working tree. A folder copy, never a second worktree.
 */
function headWorkspace(rev = "HEAD"): { workspace: string; sha: string } {
  const sha = git(["rev-parse", "--verify", `${rev}^{commit}`]);
  const root = path.join(SNAPSHOT_DIR, sha.slice(0, 12));
  const workspace = path.join(root, "native", "genex-rust");
  if (!existsSync(path.join(workspace, "Cargo.toml"))) {
    mkdirSync(root, { recursive: true });
    const archive = spawnSync("git", ["archive", sha, "native/genex-rust"], {
      cwd: REPO,
      maxBuffer: 1024 * 1024 * 1024,
    });
    if (archive.status !== 0) throw new PerfRefused("git", "git archive HEAD failed");
    const untar = spawnSync("tar", ["-x", "-C", root], { input: archive.stdout });
    if (untar.status !== 0) throw new PerfRefused("git", "tar could not unpack the snapshot");
  }
  // Only where the commit lacks them (one from before the harness): a commit that holds them is
  // measured with its own, which match its renderer's API.
  for (const file of HARNESS_FILES) {
    if (git(["ls-tree", "--name-only", sha, "--", `native/genex-rust/${file}`]) !== "") continue;
    mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    copyFileSync(path.join(REPO, "native", "genex-rust", file), path.join(workspace, file));
  }
  return { workspace, sha };
}

/**
 * Mark every file of a snapshot's workspace as just written. Every snapshot builds into the one
 * `HEAD_TARGET_DIR`, where cargo names a workspace crate's artifacts by its path inside the
 * workspace, not by the snapshot's folder; `git archive` stamps the files with the commit's time,
 * older than the artifact another snapshot left there, so cargo took that artifact as fresh and a
 * saved side was silently another commit's (RQ4 review: `rq3-review` held b71b8df7's renderer).
 */
function freshen(dir: string): void {
  const now = new Date();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) freshen(at);
    else if (entry.isFile()) utimesSync(at, now, now);
  }
}

/** A built executable and what it was built from. */
interface Built {
  exe: string;
  /** Set for a `--head` build: what the record's build says it is. */
  source?: string;
  /** The commit it was built from. */
  sha: string;
  /** Whether it was built from a snapshot of that commit (else the working tree). */
  snapshot: boolean;
}

/** What a saved executable was built from (`SOURCE_TREE`). */
interface SourceTree {
  sha: string;
  snapshot: boolean;
  /** sha256 of `git diff HEAD -- native/genex-rust` for a working-tree build (null: clean or a snapshot). */
  trackedDiffSha256: string | null;
}

/** The sha256 of the working tree's tracked changes under `native/genex-rust`, or null when clean. */
function trackedDiffSha256(): string | null {
  const diff = spawnSync("git", ["diff", "HEAD", "--", "native/genex-rust"], {
    cwd: REPO,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (diff.status !== 0) throw new PerfRefused("git", "git diff HEAD failed");
  return diff.stdout.length === 0 ? null : createHash("sha256").update(diff.stdout).digest("hex");
}

/** Build the current perf matrix test executable (the working tree's, or a snapshot of `rev`) and return it. */
function buildMatrix(fromHead: boolean, rev = "HEAD"): Built {
  checkDisk();
  const args = [RUST_ENV, "--", "cargo", "test", "-p", "showcase", "--release", "--offline", "--locked"];
  args.push("--test", MATRIX_BIN, "--no-run", "--message-format=json");
  const env: NodeJS.ProcessEnv = { ...process.env };
  let source: string | undefined;
  let sha = git(["rev-parse", "HEAD"]);
  if (fromHead) {
    const head = headWorkspace(rev);
    freshen(head.workspace);
    env.GENEX_RUST_WORKSPACE = head.workspace;
    env.CARGO_TARGET_DIR = HEAD_TARGET_DIR;
    source = `${rev} ${head.sha.slice(0, 12)} snapshot (the RQ0.9 harness files laid over where it lacks them)`;
    sha = head.sha;
  }
  const result = spawnSync(process.execPath, args, {
    cwd: REPO,
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) throw new PerfRefused("build", `cargo test --no-run exited ${result.status}`);
  for (const line of result.stdout.split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line) as { reason?: string; target?: { name?: string }; executable?: string | null };
    if (message.reason === "compiler-artifact" && message.target?.name === MATRIX_BIN && message.executable)
      return { exe: message.executable, source, sha, snapshot: fromHead };
  }
  throw new PerfRefused("build", `cargo reported no ${MATRIX_BIN} executable`);
}

/** The knobs a run passes the matrix. */
interface RunSetup {
  profiles: readonly string[];
  sizes?: string;
  rows?: string;
  frames: number;
  warmup: number;
  /** What a `--head` build was built from: the record says so and is not marked as having working-tree changes. */
  source?: string;
}

/** Run an executable (the matrix, or the pre-refactor bench) once and read the record it wrote. */
function runOnce(exe: string, setup: RunSetup, label: string): PerfRecord {
  const out = path.join(PERF_DIR, "runs", `${label}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GENEX_REQUIRE_METAL: process.env.GENEX_REQUIRE_METAL ?? "1",
    GENEX_NO_WINDOW: "1",
    GENEX_PERF_FRAMES: String(setup.frames),
    GENEX_PERF_WARMUP: String(setup.warmup),
    GENEX_PERF_PROFILES: setup.profiles.join(","),
    GENEX_PERF_OUT: out,
  };
  if (setup.sizes) env.GENEX_PERF_SIZES = setup.sizes;
  if (setup.rows) env.GENEX_PERF_ROWS = setup.rows;
  const isMatrix = path.basename(exe).startsWith(MATRIX_BIN);
  const args = isMatrix ? ["--ignored", "metal_matrix", "--nocapture"] : ["--bench"];
  const loadBefore = os.loadavg()[0] ?? 0;
  const result = spawnSync(exe, args, { cwd: REPO, env, stdio: ["ignore", "ignore", "inherit"] });
  if (result.status !== 0) throw new PerfRefused("run", `${label}: ${exe} exited ${result.status}`);
  const record = readRecord(out);
  if (setup.source !== undefined) {
    record.build.trackedChanges = false;
    record.build.source = setup.source;
  }
  record.host.load1 = [loadBefore, os.loadavg()[0] ?? 0].map((v) => Math.round(v * 100) / 100);
  return record;
}

/** The saved `perf_matrix` (or pre-refactor bench) in a tier folder, or null. */
function savedExecutableIn(dir: string): string | null {
  for (const name of [MATRIX_BIN, BENCH_BIN]) {
    const exe = path.join(dir, name);
    if (existsSync(exe)) return exe;
  }
  return null;
}

function savedExecutable(tier: string): string {
  const dir = path.join(PERF_DIR, "bin", safeName("tier", tier));
  const exe = savedExecutableIn(dir);
  if (exe === null) throw new PerfRefused(GateSkip.NoSavedExecutable, `no ${MATRIX_BIN} or ${BENCH_BIN} in ${dir}`);
  return exe;
}

function saveExecutable(tier: string, built: Built): string {
  const dir = path.join(PERF_DIR, "bin", safeName("tier", tier));
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, MATRIX_BIN);
  copyFileSync(built.exe, target);
  const tree: SourceTree = {
    sha: built.sha,
    snapshot: built.snapshot,
    trackedDiffSha256: built.snapshot ? null : trackedDiffSha256(),
  };
  writeFileSync(path.join(dir, "SOURCE_SHA"), `${built.sha}\n`);
  writeFileSync(path.join(dir, "SOURCE_TREE"), `${JSON.stringify(tree)}\n`);
  return target;
}

function fmt(value: number | null, digits = 3): string {
  return value === null ? "-" : value.toFixed(digits);
}

/** The label of an `off` row the gate read as information ({@link INFORMATIONAL_OFF_SCENES}). */
function informationalNote(row: RowComparison): string {
  const informational = row.verdict === RowVerdict.Info && row.profile === OFF && INFORMATIONAL_OFF_SCENES.has(row.row);
  return informational ? " (informational: the baseline predates the Lakeside content, not gated)" : "";
}

/** A row's runs as one report line: each side's run p95s, the paired run ratios, and what was gated. */
function runsLine(r: RowComparison): string | null {
  const runs = r.runs;
  if (runs === undefined || Math.max(runs.baseline.length, runs.candidate.length) < 2) return null;
  const list = (values: readonly number[], digits: number) => values.map((v) => v.toFixed(digits)).join(" ");
  const ratios = runs.ratios === null ? "" : ` | run ratios ${list(runs.ratios, 2)}`;
  const count = Math.max(runs.baseline.length, runs.candidate.length);
  return `    ${r.row} ${sizeKey(r.size)} runs: base ${list(runs.baseline, 3)} | now ${list(runs.candidate, 3)}${ratios} | gated ratio ${fmt(r.ratio)} (median of ${count} runs per side)`;
}

/** The comparison as the report the harness prints: a row per scene, then each row's runs. */
export function formatComparison(title: string, comparison: Comparison): string {
  const lines = [title];
  for (const refusal of comparison.refusals) lines.push(`  REFUSED ${refusal.code}: ${refusal.detail}`);
  lines.push(
    `  ${"scene".padEnd(20)} ${"size".padEnd(10)} ${"profile".padEnd(7)} ${"metric".padEnd(7)} ${"base p95".padStart(9)} ${"now p95".padStart(9)} ${"ratio".padStart(6)}  verdict`,
  );
  for (const r of comparison.rows) {
    const cells = [r.row.padEnd(20), sizeKey(r.size).padEnd(10), r.profile.padEnd(7), (r.metric ?? "-").padEnd(7)];
    lines.push(
      `  ${cells.join(" ")} ${fmt(r.baselineP95).padStart(9)} ${fmt(r.candidateP95).padStart(9)} ${fmt(r.ratio).padStart(6)}  ${r.verdict}${informationalNote(r)}${r.noisy ? " (noisy: runs disagree)" : ""}`,
    );
  }
  const perRun = comparison.rows.map(runsLine).filter((line): line is string => line !== null);
  if (perRun.length > 0) lines.push("  each run's p95 (ms):", ...perRun);
  const worst = comparison.worstOffRatio;
  lines.push(
    `  worst off ratio ${worst === null ? "-" : worst.toFixed(3)} (limit ${MAX_OFF_RATIO}); ${comparison.passed ? "PASSED" : "FAILED"}`,
  );
  return `${lines.join("\n")}\n`;
}

function printComparison(title: string, comparison: Comparison): void {
  process.stdout.write(formatComparison(title, comparison));
}

function costVerdict(cost: FeatureCost): string {
  if (!cost.wired) return "not wired: nothing to attribute";
  if (cost.withinBudget === null) return "no budget entry";
  return cost.withinBudget ? "within budget" : "OVER budget";
}

function printCosts(costs: readonly FeatureCost[]): void {
  if (costs.length === 0) return;
  process.stdout.write(
    "feature costs at the budget resolution (GPU p95 added over off, against the plan's budgets):\n",
  );
  for (const c of costs) {
    const verdict = costVerdict(c);
    const budget = c.budgetEntries.length > 0 ? `${c.budgetMs.toFixed(2)} ms (${c.budgetEntries.join("+")})` : "-";
    process.stdout.write(
      `  ${c.row.padEnd(20)} ${c.profile.padEnd(7)} +${c.deltaMs.toFixed(3)} ms  budget ${budget}  ${verdict}\n`,
    );
  }
}

function recordPath(name: string): string {
  return path.join(PERF_DIR, `${safeName("record", name)}.json`);
}

const CLI_OPTIONS = {
  profiles: { type: "string" },
  sizes: { type: "string" },
  scenes: { type: "string" },
  frames: { type: "string" },
  warmup: { type: "string" },
  runs: { type: "string" },
  record: { type: "string" },
  compare: { type: "string" },
  ab: { type: "string" },
  "save-bin": { type: "string" },
  head: { type: "boolean" },
  rev: { type: "string" },
  statistic: { type: "string" },
} as const;

function positive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new PerfRefused("usage", `--${name} needs a positive integer`);
  return n;
}

function parseCli(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: CLI_OPTIONS }).values;
  } catch (error) {
    throw new PerfRefused("usage", String(error));
  }
}

/** What a command line asks the harness to do. */
export const RunMode = {
  Record: "record",
  Compare: "compare",
  Ab: "ab",
  SaveBin: "save-bin",
} as const;
export type RunMode = (typeof RunMode)[keyof typeof RunMode];

/** A command line's mode, the record or tier it names, the profiles, the run count and the statistic. */
export interface RunPlan {
  mode: RunMode;
  name: string;
  profiles: readonly string[];
  runs: number;
  statistic: Statistic;
}

function modeOf(values: ReturnType<typeof parseCli>): { mode: RunMode; name: string } {
  checkNames(values);
  if (values.record !== undefined) return { mode: RunMode.Record, name: values.record };
  if (values.ab !== undefined) return { mode: RunMode.Ab, name: values.ab };
  if (values["save-bin"] !== undefined) return { mode: RunMode.SaveBin, name: values["save-bin"] };
  return { mode: RunMode.Compare, name: values.compare ?? "baseline" };
}

/**
 * What `argv` runs, before anything builds: an interleaved A/B takes the median of 5 runs by default,
 * a stored-record comparison the best of 3 (`--runs` and `--statistic` override either).
 */
export function runPlan(argv: readonly string[]): RunPlan {
  const values = parseCli(argv);
  const { mode, name } = modeOf(values);
  const ab = mode === RunMode.Ab;
  return {
    mode,
    name,
    profiles: setupFrom(values).profiles,
    runs: positive(values.runs, ab ? AB_DEFAULT_RUNS : DEFAULT_RUNS, "runs"),
    statistic: statisticFrom(values.statistic, mode === RunMode.Compare ? Statistic.Min : Statistic.Median),
  };
}

function stamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

/**
 * Run the setup `runs` times on one executable and merge. Scenes whose runs disagree by more than
 * [`NOISE_SPREAD`] (a busy machine lets the GPU clock drop between frames) are measured again, alone,
 * up to [`MAX_EXTRA_RUNS`] more times, and the median is taken over every run of the scene.
 */
function measureSide(exe: string, setup: RunSetup, runs: number, tag: string): PerfRecord {
  const records: PerfRecord[] = [];
  for (let n = 1; n <= runs; n++) records.push(runOnce(exe, setup, `${tag}-run${n}`));
  let merged = mergeRuns(records);
  for (let extra = 1; extra <= MAX_EXTRA_RUNS; extra++) {
    const noisy = noisyScenes(merged);
    if (noisy.length === 0) break;
    process.stderr.write(`noisy scenes ${noisy.join(", ")}: measuring them again (${extra}/${MAX_EXTRA_RUNS})\n`);
    records.push(runOnce(exe, { ...setup, rows: noisy.join(",") }, `${tag}-again${extra}`));
    merged = mergeRuns(records);
  }
  return merged;
}

/**
 * The commit a saved executable was built from (its folder's `SOURCE_SHA`), if recorded, marked
 * `+dirty-<diff hash>` when `SOURCE_TREE` says it was built from a working tree with tracked changes.
 */
function savedSourceSha(exe: string): string | undefined {
  const file = path.join(path.dirname(exe), "SOURCE_SHA");
  if (!existsSync(file)) return undefined;
  const sha = readFileSync(file, "utf8").trim().slice(0, 12);
  const treeFile = path.join(path.dirname(exe), "SOURCE_TREE");
  if (!existsSync(treeFile)) return sha;
  const tree = JSON.parse(readFileSync(treeFile, "utf8")) as SourceTree;
  return tree.trackedDiffSha256 === null ? sha : `${sha}+dirty-${tree.trackedDiffSha256.slice(0, 8)}`;
}

function withSha(record: PerfRecord, sha: string | undefined): PerfRecord {
  if (sha !== undefined) record.build.sha = sha;
  return record;
}

/** Interleave `runs` runs of the saved executable and the current one, and merge each side. */
function interleave(
  saved: string,
  current: string,
  setup: RunSetup,
  runs: number,
  tag: string,
): { a: PerfRecord; b: PerfRecord } {
  const [as, bs]: [PerfRecord[], PerfRecord[]] = [[], []];
  // A saved executable reads the checkout's HEAD when it runs: its record says what it was built from.
  const savedSetup: RunSetup = { ...setup, source: `saved executable ${path.relative(PERF_DIR, saved)}` };
  const savedSha = savedSourceSha(saved);
  for (let n = 1; n <= runs; n++) {
    as.push(withSha(runOnce(saved, savedSetup, `${tag}-saved-run${n}`), savedSha));
    bs.push(runOnce(current, setup, `${tag}-current-run${n}`));
  }
  return { a: mergeRuns(as), b: mergeRuns(bs) };
}

/** `--statistic`, or the mode's default: the median for an interleaved A/B, the best run against a stored baseline. */
function statisticFrom(value: string | undefined, fallback: Statistic): Statistic {
  if (value === undefined) return fallback;
  if (value === Statistic.Median || value === Statistic.Min) return value;
  throw new PerfRefused("usage", `--statistic is ${Statistic.Median} or ${Statistic.Min}`);
}

/** The exit code of a comparison: 0 passed, 78 refused, 1 failed. */
function exitCodeOf(comparison: Comparison): number {
  if (comparison.passed) return 0;
  return comparison.refusals.length > 0 ? REFUSAL_EXIT : 1;
}

function setupFrom(values: ReturnType<typeof parseCli>): RunSetup {
  return {
    profiles: values.profiles ? values.profiles.split(",").map((p) => p.trim()) : DEFAULT_PROFILES,
    sizes: values.sizes,
    rows: values.scenes,
    frames: positive(values.frames, MIN_GATE_FRAMES, "frames"),
    warmup: positive(values.warmup, DEFAULT_WARMUP, "warmup"),
  };
}

/** Names are validated before anything builds: a name that is not plain never reaches a path. */
function checkNames(values: ReturnType<typeof parseCli>): void {
  const modes = [values.record, values.compare, values.ab, values["save-bin"]].filter((v) => v !== undefined);
  if (modes.length !== 1) throw new PerfRefused("usage", "name exactly one of --record, --compare, --ab, --save-bin");
  const compared = values.compare === "baseline" ? undefined : values.compare;
  for (const name of [values.record, values.ab, values["save-bin"], compared]) {
    if (name !== undefined) safeName("name", name);
  }
}

function recordBaseline(name: string, exe: string, setup: RunSetup, runs: number, tag: string): number {
  const target = recordPath(name);
  const merged = measureSide(exe, setup, runs, `${tag}-record`);
  mkdirSync(PERF_DIR, { recursive: true });
  writeFileSync(target, `${JSON.stringify(merged, null, 1)}\n`);
  process.stdout.write(
    `recorded ${target}: ${merged.rows.length} rows, median of ${runs} runs, adapter ${adapterKey(merged)}, build ${merged.build.sha}\n`,
  );
  return 0;
}

function runAb(tier: string, exe: string, setup: RunSetup, runs: number, tag: string, statistic: Statistic): number {
  const saved = savedExecutable(tier);
  const { a, b } = interleave(saved, exe, setup, runs, `${tag}-ab-${tier}`);
  const oldBench = path.basename(saved).startsWith(BENCH_BIN);
  const common = b.rows
    .filter((r) => a.rows.some((x) => x.row === r.row && sizeKey(x.size) === sizeKey(r.size)))
    .map((r) => r.row);
  const comparison = compareRecords(a, b, {
    profiles: [OFF],
    metric: oldBench ? "frameMs" : "auto",
    statistic,
    minFrames: gateFrames(setup),
    rows: [...new Set(common)],
    lakesideGated: lakesideGatedFor(a.build.sha, gitIsAncestor),
  });
  printComparison(
    `A/B ${tier} (${a.build.sha}) vs current (${b.build.sha}), ${statistic} of ${runs} interleaved runs`,
    comparison,
  );
  writeFileSync(path.join(PERF_DIR, `ab-${tier}-${tag}.json`), `${JSON.stringify(comparison, null, 1)}\n`);
  return exitCodeOf(comparison);
}

function runCompare(
  name: string,
  exe: string,
  setup: RunSetup,
  runs: number,
  tag: string,
  statistic: Statistic,
): number {
  const baselinePath = name === "baseline" ? BASELINE_PATH : recordPath(name);
  if (!existsSync(baselinePath)) {
    throw new PerfRefused(GateSkip.NoBaseline, `${baselinePath} does not exist; record it with --record baseline`);
  }
  const baseline = readRecord(baselinePath);
  const candidate = measureSide(exe, setup, runs, `${tag}-compare`);
  const comparison = compareRecords(baseline, candidate, {
    profiles: setup.profiles,
    rows: setup.rows?.split(","),
    statistic,
    minFrames: gateFrames(setup),
    lakesideGated: lakesideGatedFor(baseline.build.sha, gitIsAncestor),
  });
  printComparison(
    `current (${candidate.build.sha}) vs ${path.basename(baselinePath)} (${baseline.build.sha}), ${statistic} of ${runs} runs`,
    comparison,
  );
  if (existsSync(BUDGETS_PATH)) {
    printCosts(featureCosts(candidate, JSON.parse(readFileSync(BUDGETS_PATH, "utf8")) as Budgets));
  }
  return exitCodeOf(comparison);
}

/** The gate needs [`MIN_GATE_FRAMES`] per row; a quick run with fewer frames compares without a minimum. */
function gateFrames(setup: RunSetup): number {
  return setup.frames >= MIN_GATE_FRAMES ? MIN_GATE_FRAMES : 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const values = parseCli(argv);
  const setup = setupFrom(values);
  const plan = runPlan(argv);
  const tag = stamp();
  if (values.rev !== undefined && values.head !== true)
    throw new PerfRefused("usage", "--rev builds a snapshot: give it with --head");
  const rev = values.rev ?? "HEAD";
  if (plan.mode === RunMode.SaveBin) {
    process.stdout.write(`saved ${saveExecutable(plan.name, buildMatrix(values.head === true, rev))}\n`);
    return 0;
  }
  const built = buildMatrix(values.head === true, rev);
  setup.source = built.source;
  if (plan.mode === RunMode.Record) return recordBaseline(plan.name, built.exe, setup, plan.runs, tag);
  if (plan.mode === RunMode.Ab) return runAb(plan.name, built.exe, setup, plan.runs, tag, plan.statistic);
  return runCompare(plan.name, built.exe, setup, plan.runs, tag, plan.statistic);
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof PerfRefused)) throw error;
    process.stderr.write(`${REFUSAL_PREFIX}${JSON.stringify({ code: error.code, detail: error.message })}\n`);
    process.exitCode = REFUSAL_EXIT;
  }
}

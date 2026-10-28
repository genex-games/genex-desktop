import { t } from "./i18n.ts";

/** How much of a stage result the renderer keeps: the result is the harness's, so it is bounded. */
const MAX_SCENARIOS = 2;
const MAX_SAMPLES = 8;
const MAX_METRICS = 12;
const MAX_CHANGED_FILES = 100;
const MAX_SUMMARY_CHARS = 1200;

/** Durable, additive Optimization stage JSON. Page observations never supply revision identity. */
export interface Revision {
  snapshotId: string | null;
  commit: string;
  tree: string;
}
export interface Metric {
  value: number | null;
  unit: string;
  reason: string | null;
  provenance: string;
}
export interface ProfileSample {
  schemaVersion: 1;
  backend: "webgl" | "webgpu";
  renderer: string;
  version: string;
  scope: string;
  configuration: Record<string, unknown>;
  inventory: Record<string, number>;
  metrics: Record<string, Metric>;
  intervals: { count: number; elapsedMs: number; minMs: number | null; maxMs: number | null };
  revision?: Revision;
  scenarioId?: string;
  handle?: string;
  measuredAt?: string;
}
/** `preview.profile`: begin a sampling session on a stage preview, then read, start or end it. */
export interface ProfileBegin {
  action: "begin";
  runId: string;
  stageId: string;
  scenarioId: string;
  handle: string;
  expectedRevision: Revision;
  warmupMs: number;
  sampleMs: number;
  counters?: boolean;
}
export type ProfileRequest = ProfileBegin | { action: "read" | "end" | "start"; sessionId: string };
/** A host-owned optimizer worktree (`substrate/game-candidate.ts`), as `optimization.open` answers it. */
export interface OptimizationCandidate {
  candidateId: string;
  project: string;
  runId: string;
  root: string;
  baselineRoot: string;
  baseline: Revision;
  frozen: Revision | null;
  closed: boolean;
}
export interface ScenarioResult {
  id: string;
  workload: Record<string, unknown>;
  before: ProfileSample[];
  after: ProfileSample[];
  comparison: { comparable: boolean; improved: boolean; reason: string; gains: string[] };
}
/** How an Optimization stage ended; `OptimizationResultV1.outcome` is null while it runs. */
export const OptimizationOutcome = {
  Improved: "improved",
  NoImprovement: "no_improvement",
  Skipped: "skipped",
  Failed: "failed",
  Interrupted: "interrupted",
} as const;
export type OptimizationOutcome = (typeof OptimizationOutcome)[keyof typeof OptimizationOutcome];
const OUTCOMES: ReadonlySet<string> = new Set<OptimizationOutcome>(Object.values(OptimizationOutcome));
export interface OptimizationResultV1 {
  schemaVersion: 1;
  runId: string;
  project: string;
  stageId: "optimization";
  attempt: number;
  phase: string;
  outcome: OptimizationOutcome | null;
  reasonCode: string | null;
  reason: string | null;
  summary: string;
  baseline: Revision | null;
  candidate: Revision | null;
  retainedRevision: Revision | null;
  candidateAdopted: boolean;
  scenarios: ScenarioResult[];
  preservation: {
    status: "preserved" | "regressed" | "unavailable" | "not_run";
    reasons: string[];
    evidenceRefs: string[];
  };
  changedFiles: string[];
  reportPath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  sequence: number;
}
export interface OptimizationCheckpointV1 {
  schemaVersion: 1;
  runId: string;
  project: string;
  origin: "autopilot_single" | "autopilot_multi";
  stageId: "optimization";
  attempt: number;
  phase: string;
  baseline: {
    revision: Revision;
    verified: boolean;
    qualityVerdict: unknown;
    evidenceRefs: string[];
    checkResults: unknown;
  } | null;
  candidate: {
    candidateId: string;
    root: string;
    revision: Revision | null;
    workerThreadId: string | null;
    workerSessionId: string | null;
    writerStopped: boolean;
  } | null;
  budget: {
    allocatedMs: number;
    consumedMs: number;
    workerAllocatedMs: number;
    workerConsumedMs: number;
    activeSegmentStartedAt: string | null;
  };
  adoptionIntent: { expectedLive: Revision; verifiedCandidate: Revision; validationArtifact: string } | null;
  result: OptimizationResultV1;
}

/** Does a record carry this schema's identity and the fields every reader relies on? */
function isResultV1(r: OptimizationResultV1): boolean {
  const identified = r.schemaVersion === 1 && r.stageId === "optimization";
  const named = typeof r.runId === "string" && typeof r.project === "string";
  const sequenced = Number.isSafeInteger(r.sequence) && r.sequence >= 0;
  const described = typeof r.summary === "string" && typeof r.phase === "string";
  const outcomeKnown = r.outcome === null || OUTCOMES.has(r.outcome);
  return identified && named && sequenced && described && outcomeKnown;
}

/** Renderer-side guard: unknown future schemas are ignored; malformed numbers are never gains. */
export function normalizeOptimization(value: unknown): OptimizationResultV1 | null {
  if (!value || typeof value !== "object") return null;
  const r = value as OptimizationResultV1;
  if (!isResultV1(r)) return null;
  const metric = (m: Metric): Metric => ({
    value: typeof m?.value === "number" && Number.isFinite(m.value) && m.value >= 0 ? m.value : null,
    unit: typeof m?.unit === "string" ? m.unit : "",
    reason: typeof m?.reason === "string" ? m.reason : null,
    provenance: typeof m?.provenance === "string" ? m.provenance : "",
  });
  const samples = (items: ProfileSample[]) =>
    (Array.isArray(items) ? items : [])
      .slice(0, MAX_SAMPLES)
      .filter((s) => s && typeof s === "object")
      .map((s) => ({
        ...s,
        metrics: Object.fromEntries(
          Object.entries(s.metrics ?? {})
            .slice(0, MAX_METRICS)
            .map(([k, v]) => [k, metric(v)]),
        ),
      }));
  return {
    ...r,
    summary: r.summary.slice(0, MAX_SUMMARY_CHARS),
    candidateAdopted: r.candidateAdopted === true,
    changedFiles: (Array.isArray(r.changedFiles) ? r.changedFiles : [])
      .filter((f) => typeof f === "string")
      .slice(0, MAX_CHANGED_FILES),
    scenarios: (Array.isArray(r.scenarios) ? r.scenarios : [])
      .slice(0, MAX_SCENARIOS)
      .filter((s) => s && typeof s.id === "string")
      .map((s) => ({
        ...s,
        before: samples(s.before),
        after: samples(s.after),
        comparison: {
          comparable: s.comparison?.comparable === true,
          improved: s.comparison?.improved === true,
          reason: typeof s.comparison?.reason === "string" ? s.comparison.reason : t("Not measured"),
          gains: Array.isArray(s.comparison?.gains) ? s.comparison.gains.filter((g) => typeof g === "string") : [],
        },
      })),
    preservation:
      r.preservation && typeof r.preservation === "object"
        ? r.preservation
        : { status: "not_run", reasons: [], evidenceRefs: [] },
  };
}

/**
 * The play-time AI graders (the four AI archetype cases): what a run's game did with its AI, read
 * from the run's own records and never from the game's say-so —
 *
 *  - the schema failure rate after the one repair: the share of the game's model calls the broker
 *    refused `invalid_output` (`game_ai_call` rows of the eval profile's log);
 *  - fallback coverage: the share of AI demos that ended cleanly with no answer at all, and nothing
 *    left waiting (the host's `ai.replay` with `answers: "none"`);
 *  - determinism: the share of AI demos whose every seed replayed its frames exactly from the tape;
 *  - local p95 per site: the 95th-percentile reply time of each call site on this Mac's models;
 *  - calls per decision: a demo's saved calls over its checkpoints — a guard against a call per frame.
 *
 * Each metric is unmeasured (null) when its records are missing, never a pass. The blind pairwise
 * mechanic judge is `ai-mechanic-pairwise.ts`.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CustomEvent, customEvent, type GameAiCallPayload } from "../../../src/shared/custom-events.ts";
import { AiDoor, AiErrorCode } from "../../../src/shared/game-ai.ts";
import {
  AI_TAPE_EXTENSION,
  AI_TAPE_MAX_BYTES,
  AI_TAPES_DIR,
  type AiReplayResult,
  isTapeName,
  readTape,
  type TapeLine,
} from "../../../src/shared/game-ai-tape.ts";
import type { EventEnvelope } from "../../../src/shared/event-log.ts";

/** The most schema failures, as a share of calls, a game may have after the repair (the plan's 1%). */
export const AI_SCHEMA_FAILURE_CEILING = 0.01;
/** The slowest a site's p95 reply may be on this Mac's models (a cold local model's bound). */
export const AI_LOCAL_P95_CEILING_MS = 15_000;
/** The most calls a demo may make per checkpoint before it reads as a call per frame. */
export const AI_CALLS_PER_DECISION_CEILING = 4;
/** The most tapes one snapshot's grade reads. */
const MAX_TAPES = 16;
/** The percentile the latency metric reports. */
const P95 = 0.95;

/** One demo's saved playtest, as the grade reads it. */
export interface GradedTape {
  demo: string;
  lines: TapeLine[];
  rejected: number;
}

/** What the AI graders read of a run. */
export interface AiPlayEvidence {
  /** The game's model calls, from the eval profile's log. */
  calls: GameAiCallPayload[];
  /** The snapshot's saved playtests. */
  tapes: GradedTape[];
  /** Each AI demo's replay from its tape, under the replay seeds (empty: not replayed). */
  replays: AiReplayResult[];
  /** Each AI demo's replay with no answer at all (empty: not replayed). */
  noAnswer: AiReplayResult[];
}

/** One metric: its value, and whether it meets its bar (null: unmeasured). */
export interface AiMetric {
  value: number | null;
  pass: boolean | null;
}

/** A run's play-time AI grade. */
export interface AiPlayGrade {
  schemaFailureAfterRepair: AiMetric;
  fallbackCoverage: AiMetric;
  determinism: AiMetric;
  /** Per site, the p95 reply time on this Mac's models, in ms. */
  localP95BySite: Record<string, AiMetric>;
  callsPerDecision: AiMetric;
  /** Every measured metric passed, and the AI was measured at all; null when nothing was. */
  pass: boolean | null;
}

const unmeasured: AiMetric = { value: null, pass: null };

/** The game's model calls in an eval profile's log. */
export function aiCallsOf(events: readonly EventEnvelope[]): GameAiCallPayload[] {
  return events.map((event) => customEvent(event, CustomEvent.GameAiCall)).filter((call) => call !== null);
}

/** A share, or null for none of none. */
const shareOf = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

/** The share of calls refused for an answer that never fit, after its repair. */
function schemaFailure(calls: readonly GameAiCallPayload[]): AiMetric {
  const value = shareOf(calls.filter((call) => call.code === AiErrorCode.InvalidOutput).length, calls.length);
  return value === null ? unmeasured : { value, pass: value <= AI_SCHEMA_FAILURE_CEILING };
}

/** The share of replays a predicate holds for; it must hold for all of them. */
function allOf(replays: readonly AiReplayResult[], holds: (replay: AiReplayResult) => boolean | null): AiMetric {
  const known = replays.map(holds).filter((verdict) => verdict !== null);
  const value = shareOf(known.filter(Boolean).length, known.length);
  return value === null ? unmeasured : { value, pass: value === 1 };
}

/** A demo with no answer: ended cleanly, nothing waiting; null when the host could not tell. */
const handledNoAnswer = (replay: AiReplayResult): boolean | null =>
  replay.settled === undefined || replay.stuck === undefined ? null : replay.settled && replay.stuck === 0;

/** The value at a quantile of sorted numbers (nearest rank). */
function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
}

/** Each site's p95 reply time on this Mac's models. */
function localP95(calls: readonly GameAiCallPayload[]): Record<string, AiMetric> {
  const bySite = new Map<string, number[]>();
  for (const call of calls) {
    const latency = call.latencyMs;
    const local = call.door === AiDoor.Local && call.code == null && typeof latency === "number";
    if (!local || !call.site) continue;
    bySite.set(call.site, [...(bySite.get(call.site) ?? []), latency]);
  }
  return Object.fromEntries(
    [...bySite].map(([site, latencies]) => {
      const value = quantile(
        [...latencies].sort((a, b) => a - b),
        P95,
      );
      return [site, { value, pass: value <= AI_LOCAL_P95_CEILING_MS }];
    }),
  );
}

/** Calls per checkpoint over the demos that were replayed and have a tape. */
function callsPerDecision(tapes: readonly GradedTape[], replays: readonly AiReplayResult[]): AiMetric {
  let calls = 0;
  let decisions = 0;
  for (const replay of replays) {
    const tape = tapes.find((entry) => entry.demo === replay.demo);
    const checkpoints = replay.stateDigests[0]?.length ?? 0;
    if (!tape || checkpoints === 0) continue;
    calls += tape.lines.length;
    decisions += checkpoints;
  }
  const value = shareOf(calls, decisions);
  return value === null ? unmeasured : { value, pass: value <= AI_CALLS_PER_DECISION_CEILING };
}

/** Grade a run's play-time AI. */
export function gradeAiPlay(evidence: AiPlayEvidence): AiPlayGrade {
  const localP95BySite = localP95(evidence.calls);
  const metrics: Omit<AiPlayGrade, "localP95BySite" | "pass"> = {
    schemaFailureAfterRepair: schemaFailure(evidence.calls),
    fallbackCoverage: allOf(evidence.noAnswer, handledNoAnswer),
    determinism: allOf(evidence.replays, (replay) => replay.deterministic),
    callsPerDecision: callsPerDecision(evidence.tapes, evidence.replays),
  };
  const verdicts = [...Object.values(metrics), ...Object.values(localP95BySite)].map((metric) => metric.pass);
  const measured = verdicts.filter((verdict) => verdict !== null);
  return { ...metrics, localP95BySite, pass: measured.length ? measured.every(Boolean) : null };
}

/**
 * A snapshot's saved playtests (`ai/tapes/<demo>.jsonl`): regular files only, never through a link,
 * each read as hostile input and bounded; at most `MAX_TAPES`. None when the folder is not there.
 */
export async function readSnapshotTapes(snapshotDir: string): Promise<GradedTape[]> {
  const dir = path.join(snapshotDir, ...AI_TAPES_DIR.split("/"));
  const folder = await lstat(dir).catch(() => null);
  if (!folder?.isDirectory()) return [];
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => name.endsWith(AI_TAPE_EXTENSION) && isTapeName(name.slice(0, -AI_TAPE_EXTENSION.length)))
    .sort()
    .slice(0, MAX_TAPES);
  const tapes: GradedTape[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.size > AI_TAPE_MAX_BYTES) continue;
    const read = readTape(await readFile(file, "utf8"));
    tapes.push({ demo: name.slice(0, -AI_TAPE_EXTENSION.length), lines: read.lines, rejected: read.rejected });
  }
  return tapes;
}

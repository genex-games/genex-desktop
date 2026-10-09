/**
 * The trace of a computer session: one JSON line per action, written beside the session's frames
 * (`trace.jsonl`). It records what was done, by which route, what the target showed and how much
 * simulated time passed, so a judge's evidence can be read back, a playthrough scrubbed, and a run
 * that reached its goal kept as a route to replay on later builds (`harness-seed/loop/routes.ts`).
 *
 * Electron-free and pure: the session decides what goes in a row; this module only shapes it.
 */
import type { InputRoute } from "../shared/computer-target.ts";

/** The file every session's trace is written to, beside its frames. */
export const TRACE_FILE = "trace.jsonl";

/** One action of a session, as the trace keeps it. */
export interface TraceRow {
  /** The action's index in the session, from 1. */
  i: number;
  /** Milliseconds since the session's first action. */
  atMs: number;
  action: string;
  caption: string;
  /** The arguments that ran, as the session parsed them: never the raw text the model sent. */
  args: Record<string, unknown>;
  /** The route its input took; null for an action that only looked. */
  route: InputRoute | null;
  /** The frame it saved, if it saved one. */
  frame: string | null;
  cursor: { x: number; y: number } | null;
  /** Simulated milliseconds it ran the target's clock, when the clock was stepped. */
  simMs: number | null;
  /** Set when the session refused the action (the target cannot do it, the budget is spent). */
  refused?: true;
  /** Set on the action after which the studio verified the session's goal was reached. */
  reached?: true;
}

/** What a finished session's trace adds up to. */
export interface TraceSummary {
  /** Where the trace was written; null before the first action. */
  path: string | null;
  steps: number;
  /** True when every move ran on a stepped clock: the same seed and inputs replay the same run. */
  deterministic: boolean;
  /** The index of the action after which the goal was verified, or null. */
  reachedAt: number | null;
}

/** The fields of a parsed request worth keeping: the model's notes and the batch's own steps are not. */
const DROPPED_FIELDS = new Set(["surfaceNote", "observeNote"]);

/** A request's arguments as a trace row keeps them. */
export function traceArgs(request: object): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (DROPPED_FIELDS.has(key) || value === undefined) continue;
    kept[key] = key === "steps" && Array.isArray(value) ? value.map((step: object) => traceArgs(step)) : value;
  }
  return kept;
}

/** One row as the line written to the trace file. */
export function traceLine(row: TraceRow): string {
  return `${JSON.stringify(row)}\n`;
}

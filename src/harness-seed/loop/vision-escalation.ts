/**
 * Vision escalation: a screenshot question the picture judge could not answer (unmeasured) or
 * answered at less than even confidence may be put to a judge that plays — one hands-on probe per
 * build per pass, on the pass's leased window, within a budget for the whole run.
 *
 * The probe is a second witness, never a higher court:
 * - it may resolve an unmeasured or low-confidence answer;
 * - it never overturns a confident screenshot answer on its own;
 * - when it flips a measured verdict, the picture judge is asked once more about the frames the
 *   probe cited, and the flip stands only if that look agrees with confidence.
 *
 * A new module: facet scoring calls it through a namespace import, so a kept older scoring never
 * needs it and this one never stops it loading.
 */
import { readFile } from "node:fs/promises";
import { visionCheck, type VisionAsk } from "./judge.ts";
import { handsOnJudgesOn, runHandsOnJudge, type HandsOnOutcome } from "./hands-on-judge.ts";
import { CheckKind, CheckWeight, type Check } from "./spec.ts";
import { isMeasured, type CheckResult } from "./checks.ts";
import { MINUTE_MS } from "./time.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";

/** The most questions one probe carries. */
export const MAX_PROBE_QUESTIONS = 2;
/** The most probes one run spends, whatever its length. */
export const MAX_PROBES_PER_RUN = 8;
/** Below this confidence a screenshot answer may be escalated; at or above it, it stands. */
export const ESCALATE_BELOW_CONFIDENCE = 0.5;
/** The moves a probe may make: a look at one thing, not a playthrough. */
const PROBE_MAX_ACTIONS = 8;
/** A probe starts only with at least this much of the pass's clock left. */
const PROBE_MIN_MS = 3 * MINUTE_MS;
/** The field of the run that counts the probes it spent. */
const PROBES_FIELD = "handsOnProbes";

/** How a resolved or verified answer explains itself on the board. */
const MESSAGE = {
  resolved: (note: string) => `a judge that played answered what the picture could not${note ? `: ${note}` : ""}`,
  verified: "a judge that played flipped the picture's answer, and a second look at its frames agreed",
} as const;

/** Where a probe may play: the pass's own window and build, and its clock. */
export interface EscalationOptions {
  run: Run;
  /** The build's folder. */
  root: string;
  /** The pass's leased window; without one nothing is escalated. */
  handle: string | null | undefined;
  deadline?: number | null;
  labelPrefix?: string | null;
  iteration?: number;
  facetId?: string;
}

/** May this answer be put to a judge that plays: nothing measured, or less than even confidence. */
export function escalatable(result: CheckResult | undefined): boolean {
  if (!result) return false;
  if (!isMeasured(result)) return true;
  return typeof result.confidence === "number" && result.confidence < ESCALATE_BELOW_CONFIDENCE;
}

/** A confident screenshot answer: one no probe may overturn. */
function confident(result: CheckResult): boolean {
  return isMeasured(result) && typeof result.confidence === "number" && result.confidence >= ESCALATE_BELOW_CONFIDENCE;
}

/** How many probes this run has spent. */
function probesSpent(run: Run | AnyRecord): number {
  const spent = Number(run?.[PROBES_FIELD]);
  return Number.isFinite(spent) ? spent : 0;
}

/** Whether this pass may probe at all: on for the run, a leased window, budget and time left. */
function mayProbe(options: EscalationOptions): boolean {
  const { run, handle, deadline } = options;
  const timeLeft = deadline ? deadline - Date.now() : Number.POSITIVE_INFINITY;
  return Boolean(handle) && handsOnJudgesOn(run) && probesSpent(run) < MAX_PROBES_PER_RUN && timeLeft > PROBE_MIN_MS;
}

/** A picture question as a question a judge that plays answers. */
function playQuestion(check: Check): Check {
  return {
    id: check.id,
    kind: CheckKind.Play,
    ask: check.ask,
    expect: check.expect === "no" ? "no" : "yes",
    weight: check.weight ?? CheckWeight.Normal,
  } as Check;
}

/** The last frame a probe cited for a question, as a picture the judge can be shown. */
async function citedPicture(probe: HandsOnOutcome, id: string): Promise<{ base64: string; path: string } | null> {
  const file = probe.frames[id]?.at(-1);
  if (!file) return null;
  const bytes = await readFile(file).catch(() => null);
  return bytes ? { base64: bytes.toString("base64"), path: file } : null;
}

/** The probe's answer on the board, as a vision result: the picture's question, the player's answer. */
function asVision(fresh: CheckResult, probe: CheckResult, confidence: number, reason: string): CheckResult {
  const { state: _unmeasured, ...measured } = fresh;
  return {
    ...measured,
    pass: probe.pass,
    answer: probe.answer,
    confidence,
    note: typeof probe.note === "string" ? probe.note : "",
    reason: probe.pass ? "" : reason,
    probed: true,
  };
}

/**
 * One escalated answer weighed against the probe's. Unmeasured: the probe's answer resolves it. A
 * confident answer stands. A measured answer the probe flips stands unless a second look at the
 * probe's own frames agrees with the flip, with confidence.
 */
async function weigh(
  ctx: HarnessCtx,
  run: Run,
  ask: VisionAsk,
  fresh: CheckResult,
  probe: HandsOnOutcome,
): Promise<CheckResult> {
  const answered = probe.results.find((result) => result.id === ask.check.id);
  if (!answered || !isMeasured(answered) || confident(fresh)) return fresh;
  const note = typeof answered.note === "string" ? answered.note : "";
  if (!isMeasured(fresh)) return asVision(fresh, answered, ESCALATE_BELOW_CONFIDENCE, MESSAGE.resolved(note));
  if (answered.pass === fresh.pass) return fresh;
  const picture = await citedPicture(probe, ask.check.id);
  if (!picture) return fresh;
  const second = await visionCheck(ctx, { run, check: ask.check, crop: picture });
  const agrees = second.pass === answered.pass && confident(second);
  return agrees ? asVision(fresh, answered, second.confidence ?? ESCALATE_BELOW_CONFIDENCE, MESSAGE.verified) : fresh;
}

/**
 * The board's screenshot answers with the uncertain ones put to one judge that plays, when the run,
 * the window, the budget and the clock allow. Answers come back in ask order; anything the probe
 * cannot settle is the picture judge's answer unchanged.
 */
export async function escalateVision(
  ctx: HarnessCtx,
  { asks, answers, ...options }: EscalationOptions & { asks: readonly VisionAsk[]; answers: readonly CheckResult[] },
): Promise<CheckResult[]> {
  const out = [...answers];
  if (!mayProbe(options)) return out;
  const picked = asks
    .map((ask, index) => ({ ask, index }))
    .filter(({ ask, index }) => ask.check.ask && escalatable(out[index]))
    .slice(0, MAX_PROBE_QUESTIONS);
  if (picked.length === 0) return out;
  options.run[PROBES_FIELD] = probesSpent(options.run) + 1;
  const probe = await runHandsOnJudge(ctx, {
    ...options,
    questions: picked.map(({ ask }) => playQuestion(ask.check)),
    maxActions: PROBE_MAX_ACTIONS,
    labelPrefix: options.labelPrefix ? `${options.labelPrefix}/probe` : null,
  });
  for (const { ask, index } of picked) {
    const fresh = out[index];
    if (fresh) out[index] = await weigh(ctx, options.run, ask, fresh, probe);
  }
  return out;
}

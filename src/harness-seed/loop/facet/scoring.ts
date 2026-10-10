/** One evidence pass scored: the diffs against the incumbent and the whole scoreboard. */
import { askVisionBoard } from "../judge.ts";
import {
  INVISIBLE_DIFF_FRACTION,
  isMeasured,
  runDeterministicChecks,
  settleVision,
  toScoreboard,
  unmeasured,
} from "../checks.ts";
import { runPlaytest } from "../playtester.ts";
// By namespace: a workspace may keep a copy of a module this one reaches for that predates it.
import * as escalation from "../vision-escalation.ts";
import * as handsOn from "../hands-on-judge.ts";
import { PlayReaches, questFromSetup } from "../quest.ts";
import type { CheckResult } from "../checks.ts";
import type { AnyRecord, HarnessCtx } from "../../types/harness.d.ts";
import type { Run } from "../../types/harness.d.ts";
import type { VisionAsk } from "../judge.ts";
import { FacetRole, NO_LOCK } from "./state.ts";
import { MAX_WOBBLES } from "./policy.ts";
import { HostMethod } from "../host-methods.ts";
import { EngineFailure } from "../outage.ts";
import { isProviderLoss } from "../provider-loss.ts";
import { MINUTE_MS } from "../time.ts";
import { CheckKind, CheckWeight, type Check } from "../spec.ts";

/** The kinds the harness measures itself: the ones that gate the playtester. */
const MECHANICAL_KINDS: readonly string[] = [
  CheckKind.Scene,
  CheckKind.Pixel,
  CheckKind.Metric,
  CheckKind.Probe,
  CheckKind.Demo,
];
/** The integration facet's play session needs at least this much of the clock. */
const INTEGRATION_PLAY_MIN_MS = MINUTE_MS;
/** Any other facet's play session needs this much, or a tenth of its budget if that is less. */
const PLAY_MIN_MS = 5 * MINUTE_MS;
/** The share of a facet's budget a play session may need before it is worth starting. */
const PLAY_BUDGET_SHARE = 0.1;
/** The goal a judge that plays the integration is sent to reach: the run's own requested state. */
const INTEGRATION_QUEST = "requested-state";

/** Per-camera diff of the challenger's frames against the incumbent's; null where unsupported. */
export async function diffAgainstIncumbent(
  ctx: HarnessCtx,
  {
    run,
    evidence,
    incumbentEvidence,
    handle,
    label,
  }: {
    run: AnyRecord;
    evidence: AnyRecord | null;
    incumbentEvidence: AnyRecord | null;
    handle?: string | null;
    label: string;
  },
): Promise<Record<string, AnyRecord>> {
  const diffs: Record<string, AnyRecord> = {};
  const previous = new Map<string, AnyRecord>(
    (incumbentEvidence?.shots ?? []).map((shot: AnyRecord) => [shot.camera, shot]),
  );
  for (const shot of evidence?.shots ?? []) {
    const before = previous.get(shot.camera);
    if (!before?.path || !shot?.path) continue;
    try {
      const diff = await ctx.call(HostMethod.PreviewDiff, {
        runId: run.runId,
        a: shot.path,
        b: before.path,
        label: `${label}_${shot.camera.replace(/[^a-z0-9-_]+/gi, "-")}`,
        ...(handle ? { handle } : {}),
      });
      const found = diff && typeof diff.diffFraction === "number" ? diff : byteDiff(shot, before);
      if (found) diffs[shot.camera] = found;
    } catch {
      /* no diff for this camera: the invisible-diff detector simply has one fewer witness */
    }
  }
  return diffs;
}

/** Where the preview cannot diff: two frames are identical when their bytes are. */
function byteDiff(shot: AnyRecord, before: AnyRecord): AnyRecord | null {
  if (!shot.base64 || !before.base64) return null;
  return {
    diffFraction: shot.base64 === before.base64 ? 0 : 1,
    meanAbsDiff: 0,
    grid: [],
    compared: 1,
    heatmapPath: null,
  };
}

/** What one scoring pass shares across its steps. */
type Scoring = AnyRecord & {
  ctx: HarnessCtx;
  label: string;
  results: AnyRecord[];
};

/**
 * The whole scoreboard for one evidence pass: deterministic checks, then vision checks (one
 * crop each), then play checks through the playtester when they are worth their cost.
 */
export async function scoreEvidence(
  ctx: HarnessCtx,
  input: AnyRecord,
): Promise<{ board: AnyRecord; results: AnyRecord[] }> {
  const { spec, evidence, diffs, handle, facetId, iterationId, references = null } = input;
  const { results, pending } = await runDeterministicChecks(ctx, { spec, evidence, diffs, handle, references });
  const { incumbentBoard = {}, withPreview = NO_LOCK, wobbles = {}, stucks = {} } = input;
  const scoring: Scoring = {
    ...input,
    incumbentBoard,
    withPreview,
    wobbles,
    stucks,
    ctx,
    label: `facet_${facetId}/iter_${iterationId}`,
    results,
  };
  const asks = await visionAsks(
    scoring,
    pending.filter((c) => c.kind === CheckKind.Vision),
  );
  await settleVisionAnswers(scoring, asks);
  const playChecks = pending.filter((c) => c.kind === CheckKind.Play);
  if (playChecks.length) results.push(...(await playResults(scoring, playChecks)));
  return { board: toScoreboard(results), results };
}

/** The shot a candidate took from a camera, if any. */
function shotFor(ev: AnyRecord | null | undefined, camera: string | undefined): AnyRecord | null {
  return (ev?.shots ?? []).find((s: AnyRecord) => s.camera === camera) ?? null;
}

/** A vision check's picture: the whole shot, or its crop when the check names one. */
async function cropOf(scoring: Scoring, shot: AnyRecord | null, check: Check, tag: string): Promise<AnyRecord | null> {
  const { ctx, run, handle, label } = scoring;
  if (!shot) return null;
  const whole = { base64: shot.base64, path: shot.path };
  if (!check.crop) return whole;
  try {
    const cropped = await ctx.call(HostMethod.PreviewCrop, {
      runId: run.runId,
      path: shot.path,
      crop: check.crop,
      label: `${label}/crops/${check.id}_${tag}`,
      ...(handle ? { handle } : {}),
    });
    return cropped?.base64 ? cropped : whole;
  } catch {
    return whole;
  }
}

/**
 * The picture questions that still need a judge, collected before any of them is asked: a board
 * of them costs one call per camera, not one session per question (M3.10). Everything that can
 * settle a question without a judge — a wobble that has run out of patience, a crop identical
 * to the accepted build's — still settles it here, before the call is built.
 */
async function visionAsks(scoring: Scoring, checks: Check[]): Promise<AnyRecord[]> {
  const { evidence, incumbentEvidence, incumbentBoard, wobbles, results } = scoring;
  const asks: AnyRecord[] = [];
  for (const check of checks) {
    const previous = incumbentBoard?.[check.id];
    // A judge that could not decide twice running is not asked a third time (WP2e).
    if ((wobbles[check.id] ?? 0) >= MAX_WOBBLES && isMeasured(previous)) {
      results.push(
        unmeasured(
          check,
          `judge cannot decide — answered both ways at low confidence ${wobbles[check.id]} times on this crop`,
          { wobble: true },
        ),
      );
      continue;
    }
    const crop = await cropOf(scoring, shotFor(evidence, check.camera), check, "challenger");
    const incumbentCrop = await cropOf(scoring, shotFor(incumbentEvidence, check.camera), check, "incumbent");
    // A crop identical to the accepted build's cannot answer differently: the accepted result
    // is carried over and no judge call is spent (WP2a — the CROP, so animated water on one
    // side of the frame no longer forces a re-ask about a roof on the other).
    if (isMeasured(previous) && (await sameCrop(scoring, check, crop, incumbentCrop))) {
      results.push({
        ...previous,
        reason: previous.pass ? "" : `${previous.reason} (crop identical to the accepted build — result carried over)`,
        carried: true,
      });
      continue;
    }
    asks.push({ check, crop, incumbentCrop, camera: check.camera, previous });
  }
  return asks;
}

/** The challenger's crop reads as the accepted build's: by a crop diff, else by the whole frame's. */
async function sameCrop(
  scoring: Scoring,
  check: Check,
  crop: AnyRecord | null,
  incumbentCrop: AnyRecord | null,
): Promise<boolean> {
  const { ctx, run, handle, label, diffs } = scoring;
  const frameDiff = diffs?.[check.camera as string];
  const twoCrops = check.crop && crop?.path && incumbentCrop?.path && crop.path !== incumbentCrop.path;
  if (!twoCrops)
    return Boolean(frameDiff && frameDiff.compared > 0 && frameDiff.diffFraction < INVISIBLE_DIFF_FRACTION);
  try {
    const cropDiff = await ctx.call(HostMethod.PreviewDiff, {
      runId: run.runId,
      a: crop.path,
      b: incumbentCrop.path,
      label: `${label}/crops/${check.id}_diff`,
      ...(handle ? { handle } : {}),
    });
    return Boolean(cropDiff && cropDiff.compared > 0 && cropDiff.diffFraction < INVISIBLE_DIFF_FRACTION);
  } catch {
    return false;
  }
}

/**
 * The board's screenshot answers, the uncertain ones put to a judge that plays on this pass's own
 * window (vision-escalation.ts) — through a namespace import, so a workspace whose copy of that
 * module is missing scores exactly as before.
 */
async function escalated(scoring: Scoring, asks: VisionAsk[], answers: CheckResult[]): Promise<CheckResult[]> {
  if (typeof escalation.escalateVision !== "function") return answers;
  const { ctx, run, handle, worktree, projectDir, deadline, iteration, facetId, label } = scoring;
  try {
    return await escalation.escalateVision(ctx, {
      run: run as Run,
      root: worktree ?? projectDir,
      handle,
      deadline,
      labelPrefix: label,
      iteration,
      facetId,
      asks,
      answers,
    });
  } catch (err: any) {
    // A stop, or a lost provider the round waits for: neither is the picture judge's answer.
    if (err?.kind === EngineFailure.Aborted || ctx.cancelled || isProviderLoss(err?.kind)) throw err;
    return answers;
  }
}

/** Ask the board's picture questions, settle each answer against the accepted one, and count wobbles and hedges. */
async function settleVisionAnswers(scoring: Scoring, asks: AnyRecord[]): Promise<void> {
  const { ctx, run, wobbles, stucks, results } = scoring;
  const asked = await askVisionBoard(ctx, { run: run as Run, asks: asks as VisionAsk[] });
  const answers = await escalated(scoring, asks as VisionAsk[], asked);
  for (const [i, { check, previous }] of asks.entries()) {
    const fresh = answers[i];
    // Hysteresis (WP2b): a low-confidence flip against the accepted answer is a wobble, not a
    // verdict; two in a row settle it.
    const settled = settleVision(previous, fresh);
    if (settled.wobble) wobbles[check.id] = (wobbles[check.id] ?? 0) + 1;
    else if (settled.pass === fresh.pass && !settled.carried) wobbles[check.id] = 0;
    // M3.2: a hedge on a failing question settles nothing. Two running and the question retires
    // (see judgeChecksToRetire) — asking a picture about a number never gets a better answer.
    stucks[check.id] = settled.stuck ? (stucks[check.id] ?? 0) + 1 : 0;
    results.push(settled);
  }
}

/**
 * The playtester is the most expensive evidence: it plays for identity play checks, on the
 * integrated build, or once everything mechanical already passes.
 */
function playWorthIt(scoring: Scoring, playChecks: Check[]): boolean {
  // "All measured mechanical checks pass" — an unmeasured check neither opens nor closes the gate.
  // "Mechanical" means the scene/pixel/metric/probe/demo checks the planner wrote: a
  // judge-grown vision check that never settles must not keep the playtester waiting for the whole
  // run (talk-hud-legible went unmeasured through ten villagers iterations).
  const measured = scoring.results.filter((r) => isMeasured(r) && MECHANICAL_KINDS.includes(r.kind));
  const mechanicalAllPass = measured.length > 0 && measured.every((r) => r.pass === true);
  const identityPlay = playChecks.some((c) => c.weight === CheckWeight.Identity);
  return scoring.role === FacetRole.Integration || identityPlay || mechanicalAllPass;
}

/**
 * Enough of the clock is left for a play session. The integration facet always gets its play
 * session (WP6): it is the only judgeable build of the merged game, and the deadline reserved
 * six minutes for it.
 */
function timeToPlay({ role, deadline, budgetMs }: Scoring): boolean {
  const timeLeft = deadline - Date.now();
  if (role === FacetRole.Integration) return timeLeft > INTEGRATION_PLAY_MIN_MS;
  return timeLeft > Math.min(PLAY_MIN_MS, (budgetMs ?? Infinity) * PLAY_BUDGET_SHARE);
}

/** Is the integration's play put to a judge that plays: its window is leased, and the run has them on. */
function judgesIntegration(scoring: Scoring): boolean {
  const available = typeof handsOn.runHandsOnJudge === "function" && typeof handsOn.handsOnJudgesOn === "function";
  return (
    scoring.role === FacetRole.Integration &&
    Boolean(scoring.handle) &&
    available &&
    handsOn.handsOnJudgesOn(scoring.run)
  );
}

/**
 * The integration's play checks, put to a judge that plays when one of them is tied to the run's
 * requested state (`reaches: "setup"`) and the run's setup names that state as one the studio can
 * check: the judge plays from the game's first screen to reach it, and only the tied check's yes
 * counts once the studio saw it — every other answer is the model's word. Null when that does not
 * apply, and the playtester plays as before.
 */
async function integrationJudge(scoring: Scoring, playChecks: Check[]): Promise<CheckResult[] | null> {
  if (!judgesIntegration(scoring)) return null;
  const { ctx, run, handle, worktree, projectDir, deadline, iteration, label } = scoring;
  const tied = playChecks.find((check) => check.reaches === PlayReaches.Setup);
  const quest = tied ? questFromSetup(run.setup, INTEGRATION_QUEST, tied.id) : null;
  if (!quest) return null;
  const judged = await handsOn.runHandsOnJudge(ctx, {
    run: run as Run,
    root: worktree ?? projectDir,
    handle,
    questions: playChecks,
    quest,
    deadline,
    labelPrefix: label,
    iteration,
    facetId: FacetRole.Integration,
  });
  if (typeof handsOn.recordHandsOn === "function") await handsOn.recordHandsOn(ctx, run as Run, judged, playChecks);
  return judged.results;
}

/** The play checks' results: played when worth it and there is time, otherwise unmeasured — not played is not failed. */
async function playResults(scoring: Scoring, playChecks: Check[]): Promise<CheckResult[]> {
  const worth = playWorthIt(scoring, playChecks);
  if (!worth || !timeToPlay(scoring)) {
    const why = worth
      ? "no time left for a play session"
      : "the playtester runs once the measured mechanical checks pass (or for identity play checks)";
    return playChecks.map((check) => unmeasured(check, why));
  }
  const { ctx, run, spec, worktree, projectDir, handle, deadline, iteration, label, withPreview } = scoring;
  try {
    // A shared live view is held for the whole session, like an evidence pass; a pooled
    // port has NO_LOCK here and simply plays.
    const release = await withPreview();
    let played: AnyRecord | null;
    try {
      const judged = await integrationJudge(scoring, playChecks);
      if (judged) return judged;
      played = await runPlaytest(ctx, {
        run,
        spec,
        checks: playChecks,
        root: worktree ?? projectDir,
        handle,
        deadline,
        iteration,
        labelPrefix: label,
      });
    } finally {
      release();
    }
    return played?.results ?? [];
  } catch (err: any) {
    // A stop, or a lost provider the round waits for (facet/provider.ts): neither is "unmeasured".
    if (err?.kind === EngineFailure.Aborted || ctx.cancelled || isProviderLoss(err?.kind)) throw err;
    return playChecks.map((check) => unmeasured(check, `playtester unavailable: ${err?.message ?? err}`));
  }
}

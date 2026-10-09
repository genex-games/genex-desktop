/**
 * Replans (WP5): the checks a spike, the builder, the user or four identical failures called
 * unsatisfiable, re-pointed, relaxed or dropped by the planner — each one a decision card the
 * user can overturn, and a drop that stands one iteration unopposed before it takes effect.
 */
import {
  MAX_REPLANS_PER_CHECK,
  parsePlanSteering,
  ReplanAction,
  replanCheck,
  type PlanSteering,
  type ReplanDecision,
} from "../../replan.ts";
import { RunEvent } from "../../run-events.ts";
import { CheckKind, CheckOrigin, CheckWeight, type Check } from "../../spec.ts";
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { FacetLoop, FacetRound } from "../state.ts";
import { isStopped } from "../flow.ts";
import type { RoundFlow } from "../flow.ts";
import { recordDecision, roundFields } from "../record.ts";

/** Camera names that are the harness's own eyes: a check re-pointed at one adds no camera to the spec. */
const EYE_CAMERA_PREFIX = "eye:";
/** Frames a demo composes: never one of the spec's cameras. */
const DEMO_CAMERA_PREFIX = "demo:";

/** Who asked for a check to be reconsidered (`source` on a queued request), besides the user. */
export const ReplanSource = {
  Spike: "spike",
  Flag: "flag",
  Streak: "streak",
  FixStuck: "fix-stuck",
} as const;
export type ReplanSource = (typeof ReplanSource)[keyof typeof ReplanSource];

/** One check the round was asked to reconsider, and why. */
interface ReplanRequest extends AnyRecord {
  checkId: string;
  reason: string;
  action?: string;
  camera?: string;
  user?: boolean;
}

/** A check, the request that named it, and what the planner (or the user) decided. */
interface Replan {
  check: Check;
  request: ReplanRequest;
  decision: ReplanDecision;
}

/** Replans (WP5): the checks a spike, the builder, the user or four identical failures called unsatisfiable. */
export async function applyReplans(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  // ── replans (WP5): checks a spike, the builder or four identical failures called unsatisfiable ──
  round.steer = parsePlanSteering(round.userSteering.join("\n"));
  queueUserReplans(loop, round.steer);
  await settlePendingDrops(loop, round);
  if (!loop.replanRequests.length || loop.ctx.cancelled) return;
  for (const request of takeReplanRequests(loop)) {
    const check = loop.spec.checks.find((c) => c.id === request.checkId);
    if (!check || !mayReplan(loop, check, request)) continue;
    const decision = await replanDecision(loop, check, request);
    // The run was stopped while the planner was being asked: nothing more is asked.
    if (!decision) break;
    // A planner that never answered spent none of the check's goes.
    if (!unanswered(decision)) loop.replans[check.id] = (loop.replans[check.id] ?? 0) + 1;
    await applyReplan(loop, round, { check, request, decision });
  }
}

/** The user's own `drop <check>` and `repoint <check> to <camera>`, queued beside the others. */
function queueUserReplans({ spec, replanRequests }: FacetLoop, steer: PlanSteering): void {
  for (const drop of steer.drops) {
    const check = spec.checks.find((c) => c.id === drop && c.origin !== CheckOrigin.Harness);
    if (check)
      replanRequests.push({
        checkId: check.id,
        reason: "user steering: drop",
        action: ReplanAction.Drop,
        user: true,
      });
  }
  for (const rp of steer.repoints) {
    const check = spec.checks.find(
      (c) => c.id === rp.checkId && c.kind !== CheckKind.Probe && c.kind !== CheckKind.Demo,
    );
    if (check)
      replanRequests.push({
        checkId: check.id,
        reason: `user steering: repoint to ${rp.camera}`,
        action: ReplanAction.Repoint,
        camera: rp.camera,
        user: true,
      });
  }
}

/** A drop that stood one iteration unopposed takes effect now — unless the user said keep. */
async function settlePendingDrops(loop: FacetLoop, round: FacetRound): Promise<void> {
  const { appendRun, facet, pendingDrops, spec } = loop;
  for (const [checkId, since] of Object.entries(pendingDrops)) {
    if (since >= round.iteration) continue;
    delete pendingDrops[checkId];
    if (round.steer.keeps.includes(checkId)) {
      await recordDecision(loop, `kept check ${checkId} on ${facet.id} — the user said keep`);
      continue;
    }
    spec.checks = spec.checks.filter((c) => c.id !== checkId);
    delete loop.board[checkId];
    await appendRun(RunEvent.FacetCheckReplanned, {
      ...roundFields(loop, round.iteration),
      checkId,
      action: ReplanAction.Drop,
      why: "stood one iteration unopposed",
    });
  }
}

/** The queued requests, one per check (the first one asked wins); the queue is emptied. */
function takeReplanRequests(loop: FacetLoop): ReplanRequest[] {
  const unique = new Map<string, ReplanRequest>();
  for (const request of loop.replanRequests as ReplanRequest[])
    if (!unique.has(request.checkId)) unique.set(request.checkId, request);
  loop.replanRequests = [];
  return [...unique.values()];
}

/** A check waiting on its drop is not asked about again, and the planner gets two goes per check; the user, always. */
function mayReplan({ pendingDrops, replans }: FacetLoop, check: Check, request: ReplanRequest): boolean {
  if (pendingDrops[check.id]) return false;
  return (replans[check.id] ?? 0) < MAX_REPLANS_PER_CHECK || Boolean(request.user);
}

/**
 * What becomes of the check: the user's own word as given, else the planner's answer. Null when
 * the run was stopped while the planner was being asked.
 */
async function replanDecision(loop: FacetLoop, check: Check, request: ReplanRequest): Promise<ReplanDecision | null> {
  if (request.user && request.action === ReplanAction.Drop) return { action: ReplanAction.Drop, why: request.reason };
  if (request.user && request.action === ReplanAction.Repoint)
    return {
      action: ReplanAction.Repoint,
      check: { ...check, camera: request.camera, replanned: Number(check.replanned ?? 0) + 1 },
      why: request.reason,
    };
  const { ctx, incumbentEvidence, run, spec } = loop;
  try {
    return await replanCheck(ctx, {
      run,
      spec,
      check,
      reason: request.reason,
      cameras: [
        ...new Set([...(incumbentEvidence?.shots ?? []).map((s: AnyRecord) => s.camera), ...spec.cameras]),
      ].filter((c) => typeof c === "string" && !c.startsWith(DEMO_CAMERA_PREFIX)),
      eyes: incumbentEvidence?.eyes ?? [],
      evidence: incumbentEvidence,
    });
  } catch (err: any) {
    if (isStopped(err, ctx)) return null;
    return { action: ReplanAction.Keep, why: String(err?.message ?? err), unanswered: true };
  }
}

/** A keep the planner never decided: it could not be reached, or its reply named no action. */
function unanswered(decision: ReplanDecision): boolean {
  return decision.action === ReplanAction.Keep && decision.unanswered === true;
}

/** Apply one decision: a kept check is only recorded, a drop waits a round, a corrected check replaces the old one. */
async function applyReplan(loop: FacetLoop, round: FacetRound, replan: Replan): Promise<void> {
  const { check, request, decision } = replan;
  if (decision.action === ReplanAction.Keep) {
    await loop.appendRun(RunEvent.FacetCheckReplanned, {
      ...roundFields(loop, round.iteration),
      checkId: check.id,
      action: ReplanAction.Keep,
      why: decision.why,
      reason: request.reason,
      ...(unanswered(decision) ? { unanswered: true } : {}),
    });
    return;
  }
  if (decision.action === ReplanAction.Drop) {
    await dropLater(loop, round, replan);
    return;
  }
  await replaceCheck(loop, round, {
    check,
    request,
    corrected: decision.check,
    action: decision.action,
    why: decision.why,
  });
}

/** A drop is announced and takes effect next round, when nobody said keep — never the planner's drop of an identity check. */
async function dropLater(loop: FacetLoop, round: FacetRound, { check, request, decision }: Replan): Promise<void> {
  const { appendRun, facet, pendingDrops } = loop;
  const replanned = { ...roundFields(loop, round.iteration), checkId: check.id };
  if (check.weight === CheckWeight.Identity && !request.user) {
    await appendRun(RunEvent.FacetCheckReplanned, {
      ...replanned,
      action: ReplanAction.Keep,
      why: `the planner wanted to drop an identity check (${decision.why}) — identity checks are re-pointed or relaxed, never dropped by the planner`,
      reason: request.reason,
    });
    return;
  }
  pendingDrops[check.id] = round.iteration;
  await appendRun(RunEvent.FacetCheckReplanned, {
    ...replanned,
    action: ReplanAction.DropPending,
    why: decision.why,
    reason: request.reason,
  });
  await recordDecision(
    loop,
    `dropping check ${check.id} from ${facet.id} next iteration (${decision.why}) — say "keep ${check.id}" to overturn`,
  );
}

/** The corrected check takes the old one's place, with a clean slate: no board entry, no streaks, no spike. */
async function replaceCheck(
  loop: FacetLoop,
  round: FacetRound,
  {
    check,
    request,
    corrected,
    action,
    why,
  }: { check: Check; request: ReplanRequest; corrected: Check; action: string; why: string },
): Promise<void> {
  const { appendRun, facet, failureStreaks, reasonStreaks, spec, spiked } = loop;
  const index = spec.checks.findIndex((c) => c.id === check.id);
  spec.checks[index] = corrected;
  const camera = corrected.camera;
  const newCamera = camera && !spec.cameras.includes(camera) && !String(camera).startsWith(EYE_CAMERA_PREFIX);
  if (newCamera) spec.cameras.push(camera);
  delete loop.board[check.id];
  delete failureStreaks[check.id];
  delete reasonStreaks[check.id];
  spiked.delete(check.id);
  await appendRun(RunEvent.FacetCheckReplanned, {
    ...roundFields(loop, round.iteration),
    checkId: check.id,
    action,
    why,
    reason: request.reason,
    check: corrected,
  });
  await recordDecision(
    loop,
    `${action}ed check ${check.id} on ${facet.id}: ${why}${camera ? ` (now on ${camera})` : ""} — say "keep ${check.id}" to overturn`,
  );
}

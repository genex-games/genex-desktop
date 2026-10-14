/** The spike: a hard or twice-failed identity check is solved in isolation before the round builds. */
import { loadRecipes, recipesForChecks } from "../../library.ts";
import { stackOfShape, stampedStack } from "../../native-loop.ts";
import { describeSpike, runSpike, spikeCandidates, type SpikeOutcome } from "../../spike.ts";
import { MINUTE_MS } from "../../time.ts";
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { Check } from "../../spec.ts";
import type { FacetLoop, FacetRound } from "../state.ts";
import { isStopped, stoppedByUser } from "../flow.ts";
import type { RoundFlow } from "../flow.ts";
import { ReplanSource } from "./replans.ts";

/** A spike is started only with this much of the facet's clock left (or a slice of a short one). */
const SPIKE_MIN_MS = 10 * MINUTE_MS;
/** The failed attempts at the check a spike's brief lists, newest last. */
const SPIKE_TRIED = 4;
/** The recipes a spike's brief carries for its one check. */
const SPIKE_RECIPES = 2;

/** The spike: a hard or twice-failed identity check is solved in isolation first. */
export async function spikeHardCheck(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { ctx, facet, failureStreaks, hasTime, legacy, run, spec, spiked } = loop;
  // ── spike: a hard or twice-failed identity check gets solved in isolation first ──
  round.spikeText = null;
  if (legacy || !hasTime(SPIKE_MIN_MS)) return;
  const candidate = spikeCandidates(spec, failureStreaks, spiked)[0];
  if (!candidate) return;
  spiked.add(candidate.id);
  ctx.setStatus(`run ${run.runId} · ${facet.title} — spike on ${candidate.id}`);
  const spike = await spikeOn(loop, round, candidate as Check);
  if (!spike || spike.stopped) return stoppedByUser(loop);
  loop.lastSpike = spike;
  await keepSpike(loop, candidate.id, spike);
  round.spikeText = describeSpike(spike);
}

/** Run the spike on one check; a spike that could not run is a failed spike. Null when the run was stopped. */
async function spikeOn(loop: FacetLoop, round: FacetRound, check: Check): Promise<SpikeOutcome | null> {
  const { ctx, deadline, facetThreadId, handle, ownShape, ownsMain, projectDir, result, run, seed, shape, spec } = loop;
  const tried = result.attempts
    .filter((a: AnyRecord) => a.checks?.[check.id] === false)
    .map((a: AnyRecord) => a.summary)
    .filter(Boolean)
    .slice(-SPIKE_TRIED);
  try {
    return await runSpike(ctx, {
      run,
      spec,
      check,
      worktree: loop.worktree,
      incumbentCommit: loop.incumbentCommit ?? undefined,
      tried,
      // Written for this game's stack (the run's stamp, else the folder's kind), never the other's.
      recipes: recipesForChecks(loop.recipes, [check], SPIKE_RECIPES, {
        stack: stampedStack(run) ?? stackOfShape(shape),
      }),
      handle: handle ?? undefined,
      deadline,
      iteration: round.iteration,
      facetThreadId,
      ownsMain,
      seed,
      projectDir,
      shape,
      ownShape,
    });
  } catch (err: any) {
    if (isStopped(err, ctx)) return null;
    return {
      checkId: check.id,
      ok: false,
      reason: `spike failed to run: ${err?.message ?? err}`,
      files: [],
      branch: null,
      worktree: null,
      recipe: null,
      durationMs: 0,
      unsatisfiable: null,
    };
  }
}

/** What the spike leaves the facet: its record, its worktree to read from, a replan when it says the check cannot pass, and its recipe. */
async function keepSpike(loop: FacetLoop, checkId: string, spike: SpikeOutcome): Promise<void> {
  loop.result.spikes.push({
    checkId,
    ok: spike.ok,
    reason: spike.reason,
    branch: spike.branch,
    worktree: spike.worktree ?? null,
    recipe: spike.recipe?.id ?? null,
    unsatisfiable: spike.unsatisfiable ?? null,
  });
  if (spike.worktree) loop.spikeRoots.push(spike.worktree);
  if (spike.unsatisfiable)
    loop.replanRequests.push({
      checkId,
      reason: `spike verdict: ${spike.unsatisfiable}`,
      source: ReplanSource.Spike,
    });
  if (spike.recipe) loop.recipes = await loadRecipes(loop.ctx.workspace).catch(() => loop.recipes);
}

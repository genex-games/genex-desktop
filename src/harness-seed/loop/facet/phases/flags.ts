/** The builder → harness channel (WP1e): HARNESS: lines in the facet's notes. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { flagTarget, harnessFlags, ReplanAction } from "../../replan.ts";
import { facetNotes } from "../../repo.ts";
import { RunEvent } from "../../run-events.ts";
import { CheckOrigin, CheckWeight, type Check } from "../../spec.ts";
import { CLIP_QUOTE } from "../../text.ts";
import type { FacetLoop, FacetRound } from "../state.ts";
import { RoundFlow } from "../flow.ts";
import { defectClass } from "../defects.ts";
import { recordDecision, roundFields } from "../record.ts";
import { ReplanSource } from "./replans.ts";

/** The flags a facet's record keeps, newest last. */
const FLAGS_KEPT = 8;
/** The disowned defect classes a spec remembers, newest last. */
const FLAG_BLOCKED_DEFECTS = 16;

/** One `HARNESS:` line: what the builder said, and the check it names, if any. */
type Flag = { what: string; checkId?: string };

/** The builder → harness channel (WP1e): HARNESS: lines in the facet's notes. */
export async function readHarnessFlags(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { facet, seenFlags, spec, stoppedHere, workdir } = loop;
  // ── the builder → harness channel (WP1e): HARNESS: lines in the facet's notes ──
  if (workdir) {
    const notesNow = await readFile(path.join(workdir, facetNotes(facet.id)), "utf8").catch(() => "");
    for (const flag of harnessFlags(notesNow, spec.checks)) {
      const key = flag.what.toLowerCase();
      if (seenFlags.has(key)) continue;
      seenFlags.add(key);
      if (await rerouteFlaggedCheck(loop, round, flag)) continue;
      await noteFlag(loop, round, flag);
    }
  }

  // A stop that landed while the build turn was ending: nothing here has been looked at yet.
  if (await stoppedHere(round.iteration)) return RoundFlow.Stop;
}

/**
 * "Not mine — it is <facet>'s": the check leaves this board only when the facet named actually
 * takes it. It used to be deleted here first and offered afterwards, so an orchestrator with no
 * router (the director's workers, until M3.5) did not hand the defect over — it destroyed it,
 * and nobody ever saw the complaint again. Delivered, the artefact class is blocked from
 * re-growing here too, so a flagged defect does not linger for iterations after it. True when the check went to the other facet.
 */
async function rerouteFlaggedCheck(loop: FacetLoop, round: FacetRound, flag: Flag): Promise<boolean> {
  const { facet, facets, routeDefect, spec } = loop;
  const target = flag.checkId ? flagTarget(flag, facets ?? [], facet.id) : null;
  const flagged = flag.checkId ? spec.checks.find((c) => c.id === flag.checkId) : null;
  const movable = flagged && flagged.origin !== CheckOrigin.Harness && flagged.weight !== CheckWeight.Identity;
  if (!target || !flagged) return false;
  if (!movable) return false;
  const note = [flagged.note, `re-routed from ${facet.id}: its builder flagged it as ${target}'s`]
    .filter(Boolean)
    .join("; ");
  const delivered = typeof routeDefect === "function" && routeDefect(target, { ...flagged, note }) !== false;
  // Nobody could take it: the check stays on this board and the flag goes to the planner
  // below, which is the one path that can still answer the builder.
  if (!delivered) return false;
  keepFlag(loop, { ...flag, iteration: round.iteration, action: `re-routed to ${target}` });
  dropFlaggedCheck(loop, flagged, target);
  await recordReroute(loop, round, { flag, flagged, target });
  return true;
}

/** The flag on the facet's record, the newest few kept. */
function keepFlag(loop: FacetLoop, entry: Flag & { iteration: number; action: string }): void {
  loop.flags = [...loop.flags.slice(1 - FLAGS_KEPT), entry];
}

/** The re-routed check leaves this board, and its defect class is blocked from growing here again. */
function dropFlaggedCheck(loop: FacetLoop, flagged: Check, target: string): void {
  const { failureStreaks, reasonStreaks, spec } = loop;
  spec.checks = spec.checks.filter((c) => c.id !== flagged.id);
  delete loop.board[flagged.id];
  delete failureStreaks[flagged.id];
  delete reasonStreaks[flagged.id];
  const text = flagged.defect ?? flagged.ask ?? flagged.id;
  spec.blockedDefects = [...(spec.blockedDefects ?? []), { text, class: defectClass(text), to: target }].slice(
    -FLAG_BLOCKED_DEFECTS,
  );
}

/** The re-route on the record: the flag, the replan, the routed defect and a decision card the user can overturn. */
async function recordReroute(
  loop: FacetLoop,
  round: FacetRound,
  { flag, flagged, target }: { flag: Flag; flagged: Check; target: string },
): Promise<void> {
  const { appendRun, facet, run } = loop;
  const fields = roundFields(loop, round.iteration);
  await appendRun(RunEvent.FacetFlag, { ...fields, what: flag.what, checkId: flag.checkId, target });
  await appendRun(RunEvent.FacetCheckReplanned, {
    ...fields,
    checkId: flagged.id,
    action: ReplanAction.Rerouted,
    why: `the builder says it belongs to ${target}`,
    target,
    delivered: true,
  });
  await appendRun(RunEvent.FacetDefectRouted, {
    runId: run.runId,
    from: facet.id,
    to: target,
    iteration: round.iteration,
    check: flagged,
    byFlag: true,
  });
  await recordDecision(
    loop,
    `check ${flagged.id} moved from ${facet.id} to ${target} — its builder flagged "${flag.what.slice(0, CLIP_QUOTE)}"; say "keep ${flagged.id}" to overturn`,
  );
}

/** A flag that stays here: on the record, as a decision card, and — when it names a check — a replan request. */
async function noteFlag(loop: FacetLoop, round: FacetRound, flag: Flag): Promise<void> {
  const { appendRun, facet, spec } = loop;
  keepFlag(loop, { ...flag, iteration: round.iteration, action: flag.checkId ? "replan requested" : "noted" });
  await appendRun(RunEvent.FacetFlag, {
    ...roundFields(loop, round.iteration),
    what: flag.what,
    checkId: flag.checkId ?? null,
  });
  await recordDecision(
    loop,
    `${facet.id} flagged the harness: "${flag.what}"${flag.checkId ? ` — check ${flag.checkId} goes to the planner for a replan` : ""}`,
  );
  const named = flag.checkId && spec.checks.find((c) => c.id === flag.checkId)?.origin !== CheckOrigin.Harness;
  if (named)
    loop.replanRequests.push({
      checkId: flag.checkId,
      reason: `builder flag: ${flag.what}`,
      source: ReplanSource.Flag,
    });
}

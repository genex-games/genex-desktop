/**
 * The taste judge's side of the verdict: it sees the round blind over the facet's cameras. A veto
 * needs a named regression, which becomes a new check and undoes the round; short of one, the
 * round's work is kept, whatever the judge picked (facet/rules.ts `acceptRound`).
 */
import { Side, tasteVeto } from "../../judge.ts";
import { CheckOrigin, CheckWeight, type Check } from "../../spec.ts";
import { RunEvent } from "../../run-events.ts";
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { FacetLoop, FacetRound } from "../state.ts";
import { acceptRound, moveVerdict } from "../rules.ts";
import { VerdictSource } from "../../verdict.ts";
import { similarDefect, twinDefect, uniqueCheckId } from "../defects.ts";
import { roundFields } from "../record.ts";
import { roundStage } from "../stage.ts";
import { keptByBlock } from "../build-block.ts";
import { blockReason } from "../build-block-prompts.ts";

/** The harness's eyes the taste judge looks through beside the facet's own cameras. */
const TASTE_EYES = ["eye:spawn", "eye:here", "eye:down"];
/** How much of the move a verdict's reason quotes. */
const MOVE_QUOTED = 120;
/** How much of THE FIX a verdict's reason quotes. */
const FIX_QUOTED = 160;

/** What `acceptRound` decided, and what the reason sentence needs besides it. */
interface Decision {
  accepted: boolean;
  strong: string[];
  source: string;
  /** Only the judge's own grown questions flipped. */
  weakOnly: boolean;
  moveNow: ReturnType<typeof moveVerdict>;
}

/** Ask the taste judge, apply the acceptance rule, hold THE FIX to account, and grow the judge's own new check. */
export async function tasteVerdict(loop: FacetLoop, round: FacetRound): Promise<void> {
  const { ctx, facet, run, spec } = loop;
  const eyes = (round.evidence.eyes ?? []).filter((e: string) => TASTE_EYES.includes(e));
  round.taste = await tasteVeto(ctx, {
    run,
    facet,
    challenger: round.evidence,
    incumbentEvidence: loop.incumbentEvidence,
    board: round.nextBoard,
    comparison: round.comparison,
    cameras: [...new Set([...spec.cameras, ...eyes])],
    iterationId: round.iterationId,
    move: loop.currentMove?.what ?? null,
    // A finishing round is judged as one: polish is expected, and its polish list is the work.
    stage: roundStage(round, spec),
  });
  // The move (§5): measured by its own check when it has one, else by the taste judge. Missing
  // it is a note on the round, never the end of it: a move somebody asked for stays owed.
  const moveNow = moveVerdict({ move: loop.currentMove, board: round.nextBoard, taste: round.taste });
  // A veto with a named regression grows the scoreboard whether or not a check flipped;
  // the record says so, because "rolled back — now a new check" is what the user sees.
  // A build block (facet/build-block.ts) is kept on the checks the board already settled: the
  // judge looked once, and its pick, veto and notes are the next round's work, not a verdict.
  const decided = round.buildBlock
    ? keptByBlock(spec, round.nextBoard, round.comparison)
    : acceptRound({ spec, board: round.nextBoard, comparison: round.comparison, taste: round.taste });
  const weakOnly = decided.strong.length === 0 && round.comparison.flips.length > 0;
  round.verdictSource = decided.source;
  round.verdict = {
    pick: decided.accepted ? Side.Challenger : Side.Incumbent,
    satisfied: round.taste.satisfied,
    biggest_gap: round.taste.regression?.what ?? round.taste.biggest_gap ?? "",
    reason: round.buildBlock
      ? blockReason(decided.strong)
      : tasteReason(loop, round, { ...decided, weakOnly, moveNow }),
    defects: round.taste.defects,
  };
  if (decided.accepted) holdTheFix(loop, round);
  await growTasteCheck(loop, round);
}

/** The verdict's reason, in the order the rule decided it: a veto, a regression, then why it was kept. */
function tasteReason(loop: FacetLoop, round: FacetRound, decided: Decision): string {
  const { accepted, strong, weakOnly, moveNow } = decided;
  if (round.verdictSource === VerdictSource.TasteVeto) return `taste veto: ${round.taste.regression?.what}`;
  if (!accepted) return `checks regressed: ${round.comparison.regressions.join(", ")}`;
  const move = moveWords(loop, moveNow);
  if (strong.length) return `checks accepted (${strong.join(", ")}), taste judge did not veto${move}`;
  const flipped = weakOnly
    ? `only the judge's own notes flipped (${round.comparison.flips.join(", ")})`
    : "no check moved";
  if (round.verdictSource === VerdictSource.Taste) return `${flipped}; taste judge preferred the challenger${move}`;
  return `${flipped}; kept: nothing regressed and the taste judge named no regression${move}`;
}

/** What a kept round says about its move, when it carried one: it landed, or it was not delivered and stays owed. */
function moveWords(loop: FacetLoop, moveNow: Decision["moveNow"]): string {
  const what = loop.currentMove?.what;
  if (!what) return "";
  if (!moveNow.missing) return " and the move landed";
  return `; the move was not delivered and stays owed: ${String(what).slice(0, MOVE_QUOTED)}`;
}

/**
 * A mandatory fix the kept build leaves stays owed. Measured by its own check when it has one;
 * else by whether the judge still names it as the biggest gap (an unmeasured check gives the
 * benefit of the doubt). The round's work is kept — only a regression undoes a round — and the
 * round counts against the fix (settle.ts `countFixLoss`), so a fix the builder keeps leaving goes
 * to the planner.
 */
function holdTheFix(loop: FacetLoop, round: FacetRound): void {
  const fix = loop.currentFix;
  if (!fix?.mandatory) return;
  const entry = fix.checkId ? round.nextBoard[fix.checkId] : null;
  const gap = round.verdict.biggest_gap;
  const stillThere = entry ? entry.pass === false : Boolean(gap) && similarDefect(gap, fix.what);
  if (!stillThere) return;
  round.fixLeft = true;
  round.verdict = {
    ...round.verdict,
    biggest_gap: fix.what,
    reason: `${round.verdict.reason}; the fix was mandatory (named as the biggest gap ${fix.streak} judged builds in a row) and the build leaves it — the fix stays owed: ${String(fix.what).slice(0, FIX_QUOTED)}`,
  };
}

/**
 * The taste judge's own new check goes through the same twin net as a defect: a regression it
 * has already named once must not open a second question about it.
 */
async function growTasteCheck(loop: FacetLoop, round: FacetRound): Promise<void> {
  const { appendRun, spec } = loop;
  const proposed: Check | null = round.taste.newCheck ?? null;
  if (!proposed || spec.checks.some((c) => asksTheSame(c, proposed))) return;
  // `origin: "judge"` is the truth about it and has consequences: it counts against the
  // grown cap, it can retire, and its flip alone no longer keeps a round (M3.2).
  const grown = {
    ...proposed,
    id: uniqueCheckId(spec, proposed.id),
    weight: CheckWeight.Normal,
    hard: false,
    origin: CheckOrigin.Judge,
    note: `added by the taste judge at iteration ${round.iteration}`,
  };
  spec.checks.push(grown);
  const camera = grown.camera as string;
  if (!spec.cameras.includes(camera)) spec.cameras.push(camera);
  await appendRun(RunEvent.FacetCheckAdded, { ...roundFields(loop, round.iteration), check: grown });
}

/** Does this check already ask what the taste judge's new check would? */
function asksTheSame(check: AnyRecord, proposed: AnyRecord): boolean {
  if (check.id === proposed.id || check.ask === proposed.ask) return true;
  return twinDefect(check, { camera: proposed.camera, defect: proposed.ask });
}

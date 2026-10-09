/**
 * What an undone round had fixed. A round rolled back whole loses the defects it fixed with it,
 * and a brief that files it under "do not repeat what lost" tells the builder to drop that work
 * too. A judged round that is rolled back with flips leaves them here, with the ref its code is
 * kept on, and every next brief says to carry them over until the accepted build passes them.
 *
 * A new module on purpose: a workspace that kept an older settle.ts or brief.ts still loads.
 */
import { VerdictSource } from "../verdict.ts";
import { clip, CLIP_QUOTE, CLIP_REASON } from "../text.ts";
import type { AnyRecord } from "../../types/harness.d.ts";

/** The undone rounds a brief carries fixes from, newest kept. */
const MAX_CARRIED_ROUNDS = 3;

/** One check an undone round flipped: its id and what it asks, in the judge's words where it has them. */
export interface CarriedCheck {
  id: string;
  what: string;
}

/** An undone round's demonstrated fixes: the round, where its code is kept, why it was undone, and what it fixed. */
export interface CarriedFix {
  iteration: number;
  ref: string | null;
  why: string;
  checks: CarriedCheck[];
}

/**
 * How a round was undone when its fixes are worth carrying: the judge kept the round before, vetoed
 * it, or the move or THE FIX it owed was missing, or another check regressed. A broken build, an
 * unreachable judge, a stopped round and an unchanged one demonstrated nothing.
 */
const CARRIED_FROM: readonly string[] = [
  VerdictSource.Taste,
  VerdictSource.TasteVeto,
  VerdictSource.NoMove,
  VerdictSource.Unfixed,
  VerdictSource.Checks,
];

/** What a check asks, as a carry-over line names it: the judge's defect, else its question, else its id. */
function checkWords(spec: { checks?: AnyRecord[] } | null | undefined, id: string): string {
  const check = (spec?.checks ?? []).find((c) => c?.id === id);
  return clip(String(check?.defect ?? check?.ask ?? id), CLIP_QUOTE);
}

/** The fixes a just-settled round leaves to carry over, or null when it was kept or demonstrated none. */
function carriedFrom(round: AnyRecord, spec: { checks?: AnyRecord[] } | null | undefined): CarriedFix | null {
  if (round.won || round.challengerBroken) return null;
  if (!CARRIED_FROM.includes(String(round.verdictSource))) return null;
  const flips: string[] = round.comparison?.flips ?? [];
  if (!flips.length) return null;
  return {
    iteration: round.iteration,
    ref: typeof round.attemptBranch === "string" ? round.attemptBranch : null,
    why: clip(String(round.verdict?.reason ?? ""), CLIP_REASON),
    checks: flips.map((id) => ({ id, what: checkWords(spec, id) })),
  };
}

/**
 * The carried fixes still owed: each round's checks that the accepted build still fails (one it
 * passes was carried over, one gone from the board was retired), rounds with none left dropped.
 */
export function openCarriedFixes(
  carried: readonly CarriedFix[] | null | undefined,
  board: Record<string, { pass?: boolean | null } | undefined> | null | undefined,
): CarriedFix[] {
  return (carried ?? [])
    .map((fix) => ({ ...fix, checks: fix.checks.filter((check) => board?.[check.id]?.pass === false) }))
    .filter((fix) => fix.checks.length > 0);
}

/** The carry list after a settled round: its own fixes added, what the accepted build passes taken off, the newest kept. */
export function carryFixesOver(
  carried: readonly CarriedFix[] | null | undefined,
  { round, spec, board }: { round: AnyRecord; spec: { checks?: AnyRecord[] } | null | undefined; board: AnyRecord },
): CarriedFix[] {
  const fresh = carriedFrom(round, spec);
  const all = fresh ? [...(carried ?? []), fresh] : [...(carried ?? [])];
  return openCarriedFixes(all, board).slice(-MAX_CARRIED_ROUNDS);
}

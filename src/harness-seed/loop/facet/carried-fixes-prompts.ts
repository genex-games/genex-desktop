/** What a brief says about the fixes undone rounds made (facet/carried-fixes.ts): carry them over. */
import type { CarriedFix } from "./carried-fixes.ts";

/** The brief's heading for them; the earlier-rounds section points here by it. */
const CARRY_OVER_HEAD = "CARRY OVER";

/** The brief's section: each undone round, what it fixed, where its code is, and to re-apply it first. */
export function carryOverSection(carried: readonly CarriedFix[]): string[] {
  if (!carried.length) return [];
  const rounds = carried.flatMap((fix) => [
    `Round ${fix.iteration} was undone${fix.why ? ` (${fix.why})` : ""}, but it fixed these — they still fail on the accepted build:`,
    ...fix.checks.map((check) => `- ${check.id} — ${check.what}`),
    fix.ref
      ? `  Its code is kept on ${fix.ref}: \`git diff HEAD ${fix.ref} -- <your files>\` shows what it changed.`
      : "",
  ]);
  return [
    `## ${CARRY_OVER_HEAD} — fixes an undone round already made`,
    ...rounds.filter(Boolean),
    `Re-apply those fixes first — port what fixed them, not what lost the round — then do this round's work.`,
    ``,
  ];
}

/** What the earlier-rounds heading adds when there is something to carry over: a lost round's fixes are the exception. */
export const CARRY_OVER_EXCEPTION = ` — except the fixes under ${CARRY_OVER_HEAD}`;

/** What the resumed prompt says about a lost round that flipped checks: re-apply them, not "keep" them — the worktree was reset. */
export const reapplyWords = (flips: readonly string[]): string =>
  ` (it did flip ${flips.join(", ")} — re-apply that work; the worktree no longer has it)`;

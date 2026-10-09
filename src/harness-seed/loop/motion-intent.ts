/**
 * Whether a facet is judged on motion: the one rule the taste judge (which shows both builds'
 * motion strips) and a re-baseline (which decides whether the incumbent's evidence has a strip to
 * show) both read. Two copies of it drifted: a re-look took no strip for a facet whose intent was
 * about feel, and the judge then saw only the challenger move.
 */
import { CheckKind } from "./spec.ts";
import type { Scoreboard } from "./checks.ts";
import type { AnyRecord } from "../types/harness.d.ts";

/** Words in a facet's intent that make its feel something only motion shows. */
export const MOTION_WORDS = /\b(motion|feel|movement|animation|walk|run|jump|swing|recoil|physics)\b/i;

/** A facet with a play check, an intent about motion, or a play result on the board is judged on motion too. */
export function judgedOnMotion(facet: AnyRecord | null | undefined, board: Scoreboard | null | undefined): boolean {
  const playChecked = (facet?.checks ?? []).some((c: AnyRecord | null) => c?.kind === CheckKind.Play);
  const aboutMotion = MOTION_WORDS.test(String(facet?.intent ?? facet?.brief ?? ""));
  const playOnBoard = Object.values(board ?? {}).some((e) => e?.kind === CheckKind.Play);
  return playChecked || aboutMotion || playOnBoard;
}

/**
 * A way in for growth. A critic that scores a principle 2 — "present but thin" — round after round
 * proposes the same growth (a distant skyline, side streets fading into fog), and without a way in
 * none of it becomes a move: only a 0 or a 1 is actionable, and a lead's ladder owns every move
 * while it lasts. Three ways in, all pure:
 *
 * - a principle the critic keeps short of convincing, with a fix inside the ask, for
 *   `STUCK_PRINCIPLE_CARDS` cards running is stuck: it becomes actionable by its kind (a grow gap,
 *   or the polish ledger), and three cards of the same complaint outrank one round's proposal;
 * - the critic's own `biggest`, a grow principle inside the ask, is a move candidate at any score
 *   short of convincing;
 * - every director ladder ends with an open rung (`withOpenRung`), filled when it is reached by the
 *   best of those or the taste judge's big move (`growthCandidate`), and passed over while there is
 *   none.
 *
 * A fix beyond the ask (`adds`) is never counted and never a candidate. A new module on purpose: a
 * workspace that kept an older, agent-edited rules.ts, learn.ts, judge.ts or director code still
 * loads, because only updated callers import from here, and a ladder without an open rung or a loop
 * without streaks behaves as before.
 */
import { PrincipleKind } from "../judge.ts";
import { isRecord } from "../json.ts";
import { isBeyondScope } from "../scope.ts";
import type { Milestone } from "../spec.ts";
import type { AnyRecord } from "../../types/harness.d.ts";

/** Critic cards in a row a principle stays short of convincing, with a fix inside the ask, before it is stuck. */
export const STUCK_PRINCIPLE_CARDS = 3;

/** The critic's score for "convincing" (judge/liveness.md): anything below it still has a step to take. */
const CONVINCING_SCORE = 3;

/** The open rung's id on a ladder, unless a rung of the lead's already took it. */
const OPEN_RUNG_ID = "open";

/** What an open rung says until it is filled: how a brief, `worker_status` and the lead read it. */
export const OPEN_RUNG_WHAT = "open — filled when reached by the reviewers' best in-scope structural step";

/** Where the reviewers' best step inside the ask came from: the taste judge's big move, or one of the critic's principles. */
export type GrowthCandidate = { bigMove: AnyRecord; gap?: undefined } | { gap: AnyRecord; bigMove?: undefined };

/** Is this the ladder's open rung, filled or not? Anything that is not a rung is not. */
export function isOpenRung(rung: unknown): boolean {
  return isRecord(rung) && rung.open === true;
}

/** An open rung nobody has filled yet: passed over until a step exists to fill it with. */
export function isUnfilledOpenRung(rung: unknown): boolean {
  if (!isRecord(rung)) return false;
  return rung.open === true && !rung.filledBy;
}

/**
 * The director's ladder with one open rung at its end when it has none, so growth always has a way
 * in. A ladder that has one already (open, filled or climbed) comes back as it is, and an empty one
 * stays empty: no ladder means the harness names the move, as before.
 */
export function withOpenRung(ladder: readonly Milestone[]): Milestone[] {
  if (!ladder.length || ladder.some(isOpenRung)) return [...ladder];
  return [...ladder, { id: freeRungId(ladder), what: OPEN_RUNG_WHAT, open: true }];
}

/** `open`, or `open-<n>` when one of the lead's rungs is already called that. */
function freeRungId(ladder: readonly Milestone[]): string {
  const taken = new Set(ladder.map((rung) => rung.id));
  let id = OPEN_RUNG_ID;
  for (let n = ladder.length + 1; taken.has(id); n++) id = `${OPEN_RUNG_ID}-${n}`;
  return id;
}

/** A principle scored short of convincing whose fix stays inside the ask: what a streak counts. */
function shortOfConvincing(principle: AnyRecord): boolean {
  const scored = typeof principle.score === "number" && principle.score < CONVINCING_SCORE;
  return scored && Boolean(principle.fix) && principle.adds !== true;
}

/**
 * Each principle's streak after this card: one more card short of convincing with a fix inside the
 * ask, or none — a convincing score, no score, no fix or a fix beyond the ask ends it.
 */
export function countPrincipleStreaks(
  streaks: Readonly<Record<string, number>> | null | undefined,
  liveness: AnyRecord | null | undefined,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const principle of liveness?.principles ?? [])
    if (shortOfConvincing(principle)) next[principle.key] = (streaks?.[principle.key] ?? 0) + 1;
  return next;
}

/**
 * The card with its stuck principles actionable: each joins `grow` or `polish` by its kind (where a
 * 0 or a 1 already is) and carries `stuck`, the cards it has stood. A card with nothing stuck comes
 * back as it is.
 */
export function withStuckPrinciples<L extends AnyRecord | null | undefined>(
  liveness: L,
  streaks: Readonly<Record<string, number>> | null | undefined,
): L {
  const stuck: AnyRecord[] = (liveness?.principles ?? []).filter(
    (p: AnyRecord) => shortOfConvincing(p) && (streaks?.[p.key] ?? 0) >= STUCK_PRINCIPLE_CARDS,
  );
  if (!liveness || !stuck.length) return liveness;
  const marked = new Map<string, AnyRecord>(stuck.map((p) => [p.key, { ...p, stuck: streaks?.[p.key] }]));
  const join = (list: AnyRecord[] | undefined, kind: string): AnyRecord[] => {
    const listed = (list ?? []).map((p) => marked.get(p.key) ?? p);
    const added = [...marked.values()].filter((p) => p.kind === kind && !listed.some((q) => q.key === p.key));
    return [...listed, ...added];
  };
  return {
    ...liveness,
    grow: join(liveness.grow, PrincipleKind.Grow),
    polish: join(liveness.polish, PrincipleKind.Polish),
  };
}

/**
 * The critic's move candidates, best first: its stuck grow principles, then its `biggest` when that
 * is a grow principle inside the ask still short of convincing, then its other grow gaps, worst first.
 */
function criticCandidates(liveness: AnyRecord | null | undefined): AnyRecord[] {
  const grow: AnyRecord[] = liveness?.grow ?? [];
  const biggest = (liveness?.principles ?? []).find((p: AnyRecord) => p.key === liveness?.biggest);
  const named = biggest?.kind === PrincipleKind.Grow && shortOfConvincing(biggest) ? [biggest] : [];
  const ordered = [...grow.filter((p) => p.stuck), ...named, ...grow.filter((p) => !p.stuck)];
  return ordered.filter((p, index) => ordered.findIndex((q) => q.key === p.key) === index);
}

/**
 * The reviewers' best structural step inside the ask that nobody has asked for yet (`asked`: the
 * moves already named and the ladder's rungs, by their words): a stuck principle first — three cards
 * of the same complaint outrank one round's proposal — then the taste judge's big move, then the
 * critic's biggest and its other grow gaps. A step beyond the ask is never one; null when none is left.
 */
export function growthCandidate({
  asked = [],
  lastBigMove = null,
  lastLiveness = null,
}: {
  asked?: ReadonlyArray<AnyRecord | null | undefined>;
  lastBigMove?: AnyRecord | null;
  lastLiveness?: AnyRecord | null;
}): GrowthCandidate | null {
  const known = new Set(asked.map((move) => move?.what).filter(Boolean));
  const gaps = criticCandidates(lastLiveness).filter((gap) => !known.has(gap.fix));
  const stuck = gaps.find((gap) => gap.stuck);
  if (stuck) return { gap: stuck };
  const proposed = lastBigMove?.what && !known.has(lastBigMove.what) && !isBeyondScope(lastBigMove);
  if (proposed && lastBigMove) return { bigMove: lastBigMove };
  return gaps[0] ? { gap: gaps[0] } : null;
}

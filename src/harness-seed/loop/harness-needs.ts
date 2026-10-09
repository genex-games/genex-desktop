/**
 * When a harness-owned check is not this build's question.
 *
 * The harness puts its own checks on a board from what the plan says the game is (spec.ts
 * HARNESS_CHECKS): `reaches-play` on every keyboard or mouse game, `hud-coverage` and
 * `hud-overlap` on every HUD game. Some of them read something only some builds have — a
 * front-end that reports `flow.playing`, a HUD that measures its own coverage — and name it under
 * `needs`. A build without it is not failing that check and is not hiding an answer either: the
 * check simply does not apply. Counted as unmeasured it cost real things — every lesson of a round
 * (skillopt keeps only fully measured rounds), a "re-point it or drop it" the director cannot act
 * on, and an "expose it" note that pushed every builder to add a menu nobody asked for. A check
 * the plan or the director wrote is a contract instead, and stays unmeasured until it is met.
 *
 * Its own module so an upgraded checks.ts or spec.ts never asks a kept, older sibling for it.
 */
import type { CheckOrigin } from "./spec.ts";

/** The origin of the harness's own checks (spec.ts CheckOrigin.Harness; imported as a type to avoid a cycle). */
const HARNESS_ORIGIN = "harness" as const satisfies CheckOrigin;

/** The probe scope's alias for the state and the early state's prefix: a missing path is the same path under either. */
const SCOPE_PREFIXES = /^(?:state\.|early\.)/;

/** A check as far as this module reads it. */
interface NeedsOf {
  origin?: unknown;
  needs?: unknown;
}

/**
 * Whether `missing` (the paths a dry run or an evaluation found the build does not report) are
 * all paths this harness-owned check names under `needs` — so the check does not apply to this
 * build. False for any check the harness did not write, and for an empty or unknown `missing`.
 */
export function notThisBuildsQuestion(check: NeedsOf | null | undefined, missing: unknown): boolean {
  if (check?.origin !== HARNESS_ORIGIN || !Array.isArray(check.needs) || !Array.isArray(missing)) return false;
  if (missing.length === 0) return false;
  const needs = new Set(check.needs.map((path) => String(path).replace(SCOPE_PREFIXES, "")));
  return missing.every((path) => needs.has(String(path).replace(SCOPE_PREFIXES, "")));
}

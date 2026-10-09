/**
 * How much of the frame a game's HUD may cover, by the kind of game it is.
 *
 * The template's HUD measures the share of the frame its items cover (`state().hud.coverage`).
 * A racer's dashboard may take more of the view than a first-person crosshair and ammo count; a
 * top-down map more than either. The harness-owned `hud-coverage` check and the judge's HUD fact
 * line both read the budget from here, so the number a builder is held to and the number a judge
 * is told are the same. It lives in its own module so an upgraded spec.ts or judge.ts never asks
 * a kept, older kinds.ts for a name it does not export.
 */
import { GAME_KINDS, normalizeGameTraits } from "./kinds.ts";
import type { AnyRecord } from "../types/harness.d.ts";

/**
 * The share a HUD game of no declared kind (or a kind with no budget of its own) may cover: the
 * most any kind allows, so a game nobody described is never held to a tighter budget than a map.
 */
export const DEFAULT_HUD_BUDGET = 0.22;

/** The share of the frame this game's HUD may cover, or null for a game with no HUD declared. */
export function hudBudgetFor(game: AnyRecord | null | undefined): number | null {
  const traits = normalizeGameTraits(game);
  if (!traits.hud) return null;
  const own = traits.kind ? GAME_KINDS[traits.kind]?.hudBudget : undefined;
  return typeof own === "number" && Number.isFinite(own) ? own : DEFAULT_HUD_BUDGET;
}

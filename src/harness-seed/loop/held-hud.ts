/**
 * The HUD a game holds. A contract upgrade replaces a `src/hud.js` the studio shipped byte for byte
 * and leaves an edited one alone — it is the main owner's work (game.ts `upgradeShippedHud`). The
 * answer's `hud` says which happened; this module turns it into the run's decision and stamps the
 * generation the game keeps on the run (`run.heldHudGeneration`), so every builder's brief and
 * prompt offers only what that HUD draws: the template's facade skips a call an older HUD predates
 * with a console warning a capture never reports. A new module; it imports nothing of the seed's.
 */

/** The HUD before `HUD_GENERATION` existed: text, bars and the crosshair only. */
export const FIRST_HUD_GENERATION = 1;

/** What `game.upgradeContract` says about a game's HUD that was older than the template's. */
export interface HudUpgrade {
  generation: number;
  replaced: boolean;
  backup?: string;
}

/** The decision a HUD upgrade answer records: the log's line and the sentence on the user's card. */
export interface HudDecision {
  decision: string;
  plain: string;
}

/** Where a run keeps the generation of an older HUD the game holds; absent when it holds the template's. */
export interface HeldHudCarrier {
  heldHudGeneration?: number;
}

/** The calls the first HUD has, in the words briefs and cards use. */
export const FIRST_HUD_DRAWS = "text, bars and the crosshair";

/** The calls the first HUD lacks, by the facade's own names (studio.js `callLoadedHud`). */
export const FIRST_HUD_SKIPS = "arc, path, image, panel and font";

/** The `hud` of a `game.upgradeContract` answer, or null when it has none (a current, absent or unreachable HUD). */
export function hudUpgradeOf(upgraded: unknown): HudUpgrade | null {
  if (!upgraded || typeof upgraded !== "object") return null;
  const hud = (upgraded as { hud?: unknown }).hud;
  if (!hud || typeof hud !== "object") return null;
  const { generation, replaced, backup } = hud as Record<string, unknown>;
  if (!Number.isInteger(generation) || typeof replaced !== "boolean") return null;
  return { generation: generation as number, replaced, ...(typeof backup === "string" ? { backup } : {}) };
}

/** The generation of an older HUD the run's game holds, or null when it holds the template's. */
export function heldHudGeneration(run: unknown): number | null {
  const held = (run as HeldHudCarrier | null | undefined)?.heldHudGeneration;
  return Number.isInteger(held) && (held as number) > 0 ? (held as number) : null;
}

/** What `__studio.hud` draws on a HUD of this generation, for the brief, the prompt and the card. */
export function heldHudDraws(generation: number): string {
  return generation === FIRST_HUD_GENERATION ? FIRST_HUD_DRAWS : `only the calls HUD generation ${generation} has`;
}

/**
 * Read a `game.upgradeContract` answer into the run: the generation of an edited HUD the game
 * keeps is stamped on it (cleared once the game holds the template's), and the decision to record
 * comes back — null when the HUD was current. An answer that is no answer (the call failed)
 * leaves the run as it was.
 */
export function noteHudUpgrade(run: HeldHudCarrier, upgraded: unknown): HudDecision | null {
  if (!upgraded || typeof upgraded !== "object") return null;
  const hud = hudUpgradeOf(upgraded);
  if (hud && !hud.replaced) run.heldHudGeneration = hud.generation;
  else delete run.heldHudGeneration;
  if (!hud) return null;
  return hud.replaced ? replacedDecision(hud) : keptDecision(hud.generation);
}

/** A shipped HUD the template's replaced, the old copy beside it. */
function replacedDecision(hud: HudUpgrade): HudDecision {
  const kept = hud.backup ? ` (the previous copy is kept as ${hud.backup})` : "";
  return {
    decision: `upgraded src/hud.js to HUD generation ${hud.generation}${kept}`,
    plain: "updated the game's HUD to the studio's current one; the previous copy is kept beside it",
  };
}

/** An edited HUD left at its generation: what it draws, and what the facade skips on it. */
function keptDecision(generation: number): HudDecision {
  const skips =
    generation === FIRST_HUD_GENERATION
      ? `; its ${FIRST_HUD_SKIPS} calls are skipped`
      : "; a newer __studio.hud call is skipped";
  return {
    decision: `left src/hud.js at HUD generation ${generation}: it was edited, so the studio keeps it — builders draw ${heldHudDraws(generation)} with it${skips}`,
    plain: `kept the game's own edited HUD as it is, so builders draw ${heldHudDraws(generation)} with it`,
  };
}

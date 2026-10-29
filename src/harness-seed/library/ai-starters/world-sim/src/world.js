/**
 * A turn-based world the player steers with orders in their own words; the model resolves each turn
 * and the engine applies it under the rules. Engine-free: the game draws `state()` however it likes.
 *
 *   import { createAi } from "genex-ai";
 *   const ai = createAi({ sites: WORLD_SITES, requires: "optional" });
 *   const world = createWorld({ ai, seed });   // seed: the game's own seeded randomness
 *   ordersButton.onclick = () => world.submitOrder(input.value); // a gesture
 *   // in update(): world.update(); in the HUD: hud.text(world.disclosure().text)
 *
 * Calls per turn: one resolve, one dispatch, and a drift every third turn — never one per frame.
 */
import { NATIONS } from "../ai/nations.js";
import { Dispatch, MinorDrift, TurnDelta } from "../ai/schema.js";
import { dispatchPrompt, driftPrompt, turnPrompt, worldBible } from "../ai/prompts.js";
import { applyDispatch, applyDrift, applyTurn, quietTurn } from "../ai/applier.js";

/** Every call site this world uses: its tape keys and bench rows. */
export const WORLD_SITES = ["turn.resolve", "turn.dispatch", "minor.drift"];
/** The background drifts every this many turns. */
const DRIFT_EVERY = 3;
/** The longest order the model is shown. */
const MAX_ORDER_CHARS = 280;

/** A seeded random source (mulberry32): the same seed, the same sequence. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh continent. The seed only paints the sky: nothing a prompt reads depends on it. */
function newWorld(seed) {
  return {
    turn: 0,
    nations: NATIONS.map((nation) => ({ ...nation })),
    fronts: {},
    chronicle: [],
    headline: "",
    dispatch: "",
    sky: 0,
    random: seeded(seed),
  };
}

/** The world, steered by orders and resolved by the model through `ai` (genex-ai's createAi). */
export function createWorld({ ai, seed = 1 }) {
  const world = newWorld(seed);
  let resolving = false;
  let asked = false;
  let disclosed = false;

  /** A turn's answer (or its fallback) applied, and the turn's follow-up calls. */
  function onResolved(result) {
    applyTurn(world, result.value ?? quietTurn(world));
    world.sky = Math.round(world.random() * 100);
    ai.ask({
      site: "turn.dispatch",
      system: worldBible(),
      prompt: dispatchPrompt(),
      untrusted: { headline: world.headline },
      schema: Dispatch,
      tier: "fast",
      maxOutputTokens: 120,
      fallback: { line: world.headline },
    });
    if (world.turn % DRIFT_EVERY === 0) {
      ai.ask({
        site: "minor.drift",
        system: worldBible(),
        prompt: driftPrompt(world),
        untrusted: {},
        schema: MinorDrift,
        tier: "fast",
        maxOutputTokens: 200,
        fallback: { drifts: [] },
      });
    }
    resolving = false;
  }

  const handlers = {
    "turn.resolve": onResolved,
    "turn.dispatch": (result) => applyDispatch(world, result.value),
    "minor.drift": (result) => applyDrift(world, result.value),
  };

  return {
    /** From the orders button (a gesture): the player's order for this turn, in their words. */
    async submitOrder(order) {
      if (resolving) return false;
      resolving = true;
      if (!asked) {
        asked = true;
        await ai.requestBudget();
      }
      ai.ask({
        site: "turn.resolve",
        system: worldBible(),
        prompt: turnPrompt(world),
        untrusted: { order: String(order ?? "").slice(0, MAX_ORDER_CHARS) },
        schema: TurnDelta,
        tier: "smart",
        maxOutputTokens: 700,
        fallback: () => quietTurn(world),
      });
      return true;
    },
    /** Once per frame, from the game's update(): the only place answers enter the world. */
    update() {
      for (const result of ai.drain()) handlers[result.site]?.(result);
    },
    /** Whether a turn or its follow-ups are still waiting for the model. */
    busy: () => resolving || ai.status().pending > 0,
    /** The HUD's "AI-generated" chip; drawing it marks the disclosure shown. */
    disclosure() {
      disclosed = true;
      return ai.disclosure();
    },
    /** What the game draws and Studio reads (`state().world`, `state().ai`). */
    state: () => ({
      turn: world.turn,
      nations: world.nations.map(({ id, troops, stance, stability }) => ({ id, troops, stance, stability })),
      fronts: { ...world.fronts },
      headline: world.headline,
      dispatch: world.dispatch,
      sky: world.sky,
      ai: { pending: ai.status().pending, disclosed },
    }),
  };
}

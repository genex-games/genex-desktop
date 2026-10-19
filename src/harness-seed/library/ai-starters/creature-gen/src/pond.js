/**
 * A pond the player fills with creatures they describe in their own words. The model designs each
 * one ONCE, into bounded parameters; a deterministic sim then runs them every frame with no model at
 * all. Engine-free: the game draws `state()`.
 *
 *   const ai = createAi({ sites: POND_SITES, requires: "optional" });
 *   const pond = createPond({ ai, seed });
 *   createButton.onclick = () => pond.describe(input.value); // a gesture
 *   // in update(): pond.update(); in the HUD: hud.text(pond.disclosure().text)
 */
import { CreatureDesign, FieldNote } from "../ai/schema.js";
import { designerBible, designPrompt, notePrompt } from "../ai/prompts.js";
import { applyDesign, applyNote, plainCreature } from "../ai/applier.js";

/** Every call site the pond uses. */
export const POND_SITES = ["creature.design", "creature.note"];
/** The pond's edge, in metres from its middle; and the most creatures it holds. */
const POND_RADIUS = 20;
const MAX_CREATURES = 8;
const MAX_DESCRIPTION_CHARS = 280;
const FRAME_SECONDS = 1 / 30;

/** A seeded random source (mulberry32). */
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

/** One creature's frame: it wanders at its own speed and stays in the pond. */
function wander(creature, random) {
  creature.heading += (random() - 0.5) * 0.6;
  const step = creature.speed * FRAME_SECONDS;
  const x = creature.x + Math.cos(creature.heading) * step;
  const y = creature.y + Math.sin(creature.heading) * step;
  const inside = Math.hypot(x, y) <= POND_RADIUS;
  creature.x = inside ? x : creature.x;
  creature.y = inside ? y : creature.y;
  if (!inside) creature.heading += Math.PI;
}

/** The pond, filled by descriptions and designed by the model through `ai` (genex-ai's createAi). */
export function createPond({ ai, seed = 1 }) {
  const random = seeded(seed);
  const creatures = [];
  /** Which creature each field-guide call is about, by its ticket. */
  const notes = new Map();
  let designing = 0;
  let asked = false;
  let disclosed = false;

  /** A design (or its fallback) made legal and put in the pond, then its field-guide line asked for. */
  function onDesigned(result) {
    designing -= 1;
    const creature = applyDesign(result.value ?? plainCreature(creatures.length), creatures.length);
    Object.assign(creature, { x: (random() - 0.5) * POND_RADIUS, y: (random() - 0.5) * POND_RADIUS, heading: 0 });
    creatures.push(creature);
    const ticket = ai.ask({
      site: "creature.note",
      system: designerBible(),
      prompt: notePrompt(creature),
      untrusted: {},
      schema: FieldNote,
      tier: "fast",
      maxOutputTokens: 80,
      fallback: { line: "" },
    });
    notes.set(ticket, creature);
  }

  const handlers = {
    "creature.design": onDesigned,
    "creature.note": (result) => {
      const creature = notes.get(result.ticket);
      notes.delete(result.ticket);
      if (creature) applyNote(creature, result.value);
    },
  };

  return {
    /** From the create button (a gesture): a creature, in the player's words. */
    async describe(description) {
      if (creatures.length + designing >= MAX_CREATURES) return false;
      designing += 1;
      if (!asked) {
        asked = true;
        await ai.requestBudget();
      }
      ai.ask({
        site: "creature.design",
        system: designerBible(),
        prompt: designPrompt(creatures.length + designing - 1),
        untrusted: { description: String(description ?? "").slice(0, MAX_DESCRIPTION_CHARS) },
        schema: CreatureDesign,
        tier: "fast",
        maxOutputTokens: 200,
        fallback: () => plainCreature(creatures.length),
      });
      return true;
    },
    /** Once per frame: answers enter, then the sim runs every creature. */
    update() {
      for (const result of ai.drain()) handlers[result.site]?.(result);
      for (const creature of creatures) wander(creature, random);
    },
    busy: () => designing > 0 || ai.status().pending > 0,
    disclosure() {
      disclosed = true;
      return ai.disclosure();
    },
    state: () => ({
      creatures: creatures.map((creature) => ({
        ...creature,
        x: Math.round(creature.x * 100) / 100,
        y: Math.round(creature.y * 100) / 100,
        heading: Math.round(creature.heading * 100) / 100,
      })),
      ai: { pending: ai.status().pending, disclosed },
    }),
  };
}

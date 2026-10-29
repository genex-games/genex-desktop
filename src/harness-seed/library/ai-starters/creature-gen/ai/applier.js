/**
 * The only code that turns a model's design into a creature. Every parameter is clamped, every word
 * checked against the game's own lists, and the physics decide what the design implies: a legless
 * creature crawls, a big one is slow, nothing outruns the pond's speed limit.
 */
import { BODIES, DIETS, PALETTES, TEMPERS } from "./schema.js";

const MAX_NAME = 24;
const MAX_LINE = 160;
const POND_SPEED_LIMIT = 6;
const CRAWL_SPEED = 1.5;

const clampNumber = (value, min, max) =>
  Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : min));
const pick = (value, allowed) => (allowed.includes(value) ? value : allowed[0]);

/** Text a model wrote, safe to draw. */
export function cleanText(value, max) {
  return Array.from(
    String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim(),
  )
    .slice(0, max)
    .join("");
}

/** A design made legal: the creature the sim runs. */
export function applyDesign(design, index) {
  const legs = Math.round(clampNumber(design?.legs, 0, 8));
  const size = Math.round(clampNumber(design?.size, 0.3, 3) * 10) / 10;
  const limit = legs === 0 ? CRAWL_SPEED : POND_SPEED_LIMIT / Math.max(1, size);
  return {
    id: `c${index + 1}`,
    name: cleanText(design?.name, MAX_NAME) || `Creature ${index + 1}`,
    body: pick(design?.body, BODIES),
    legs,
    arms: Math.round(clampNumber(design?.arms, 0, 4)),
    size,
    speed: Math.round(clampNumber(design?.speed, 0, limit) * 10) / 10,
    diet: pick(design?.diet, DIETS),
    palette: pick(design?.palette, PALETTES),
    temper: pick(design?.temper, TEMPERS),
    note: "",
  };
}

/** The fallback: a plain pond creature, so the game goes on with no AI. */
export const plainCreature = (index) => ({
  name: `Pond dweller ${index + 1}`,
  body: "round",
  legs: 4,
  arms: 0,
  size: 1,
  speed: 2,
  diet: "plants",
  palette: "moss",
  temper: "shy",
});

/** The field-guide line, cleaned. */
export const applyNote = (creature, note) => {
  creature.note = cleanText(note?.line, MAX_LINE);
};

/**
 * The shapes the model answers in: plain JSON schemas of genex-ai's closed dialect (what its `s`
 * builders write). A creature is a handful of bounded parameters a deterministic sim runs — never
 * code, never a mesh. Check a change with `ai_schema_check`.
 */

export const BODIES = ["round", "long", "tall", "flat"];
export const DIETS = ["plants", "meat", "light", "minerals"];
export const PALETTES = ["moss", "ember", "tide", "dusk", "bone"];
export const TEMPERS = ["shy", "curious", "bold", "lazy"];

const int = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const number = (minimum, maximum) => ({ type: "number", minimum, maximum });
const text = (maxLength) => ({ type: "string", maxLength });
const oneOf = (values) => ({ type: "string", enum: [...values] });
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** A creature's design: what it looks like and how it moves, every number ranged. */
export const CreatureDesign = object({
  name: text(24),
  body: oneOf(BODIES),
  legs: int(0, 8),
  arms: int(0, 4),
  size: number(0.3, 3),
  speed: number(0, 10),
  diet: oneOf(DIETS),
  palette: oneOf(PALETTES),
  temper: oneOf(TEMPERS),
});

/** One line for the creature's field-guide card. */
export const FieldNote = object({ line: text(160) });

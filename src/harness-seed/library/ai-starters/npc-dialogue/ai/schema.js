/**
 * The shapes the model answers in: what the player meant (a word from a fixed list, and a topic the
 * character really knows about), and the character's reply (a bounded line, a mood, and at most one
 * item from what it really carries). Plain JSON schemas of genex-ai's closed dialect.
 */
import { FACTS, ITEMS } from "./character.js";

export const INTENTS = ["greet", "ask", "trade", "threaten", "farewell"];
export const MOODS = ["warm", "wary", "cold"];
export const NOTHING = "none";

const text = (maxLength) => ({ type: "string", maxLength });
const oneOf = (values) => ({ type: "string", enum: [...values] });
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** What the player meant by what they said. */
export const Intent = object({
  intent: oneOf(INTENTS),
  topic: oneOf([...FACTS.map((fact) => fact.id), NOTHING]),
});

/** The character's reply. */
export const Reply = object({
  line: text(200),
  mood: oneOf(MOODS),
  give: oneOf([...ITEMS, NOTHING]),
});

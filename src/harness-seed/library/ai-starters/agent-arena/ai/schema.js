/**
 * The shape a strategy compiles into: a short list of rules in a tiny closed language, read top to
 * bottom every tick by a deterministic engine. The model writes it once, when the player gives their
 * bot its strategy; it never plays a tick. A plain JSON schema of genex-ai's closed dialect.
 */

/** What a rule may test. */
export const CONDITIONS = ["enemy-near", "enemy-far", "hurt", "healthy", "always"];
/** What a rule may do. */
export const MOVES = ["advance", "retreat", "strike", "guard", "circle"];
/** The most rules one program holds. */
export const MAX_RULES = 6;

const int = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const text = (maxLength) => ({ type: "string", maxLength });
const oneOf = (values) => ({ type: "string", enum: [...values] });
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** A bot's program: its name and its rules, the first that matches each tick wins. */
export const BotProgram = object({
  name: text(24),
  rules: {
    type: "array",
    items: object({ when: oneOf(CONDITIONS), act: oneOf(MOVES), power: int(1, 3) }),
    minItems: 1,
    maxItems: MAX_RULES,
  },
});

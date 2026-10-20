/**
 * Values made up from a schema, for the mock lane: the creator plays a game whose saved playtest
 * does not cover a call yet, and the game still gets an answer of the right shape. Each value is
 * seeded by the world's seed and the call's slot (its key and occurrence), so the same seed and
 * steps make the same values in any order, and every value fits its schema's bounds.
 */
import { type AiOutputSchema, AiSchemaType, isAiOutputSchema } from "../../../shared/game-ai-schema.ts";
import { sha256Hex } from "../sha256.ts";

/** How far an unbounded number strays from zero. */
const MOCK_NUMBER_SPAN = 100;
/** The longest string a mock writes when its schema allows longer. */
const MOCK_STRING_CHARS = 24;
/** The most items a mock list holds beyond its minimum. */
const MOCK_EXTRA_ITEMS = 3;
/** How long a mock `say` answer is, in characters. */
const MOCK_SAY_CHARS = { min: 20, max: 80 } as const;
/** Decimal places a mock number keeps. */
const MOCK_DECIMALS = 1000;

/** The words mock text is written in: plainly not a model's. */
const MOCK_WORDS = [
  "mock",
  "answer",
  "amber",
  "river",
  "lantern",
  "north",
  "copper",
  "quiet",
  "storm",
  "harbor",
  "ember",
  "willow",
] as const;

/** A seeded random source (mulberry32): the same seed, the same sequence. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The random source of one call slot under a world seed. */
export function slotRandom(seed: number, key: string, n: number): () => number {
  const digest = sha256Hex(`${seed >>> 0}:${key}#${n}`);
  return seededRandom(Number.parseInt(digest.slice(0, 8), 16));
}

/** A whole number from `min` to `max`, both included. */
const between = (random: () => number, min: number, max: number): number =>
  min + Math.floor(random() * (max - min + 1));

/** Mock words, from `min` to `max` characters (code points). */
function words(random: () => number, min: number, max: number): string {
  const target = between(random, min, Math.max(min, max));
  let text = "";
  while ([...text].length < target) {
    const word = MOCK_WORDS[between(random, 0, MOCK_WORDS.length - 1)] ?? "mock";
    text = text ? `${text} ${word}` : word;
  }
  return [...text].slice(0, target).join("");
}

/** A number's range, with a span around what one bound names when the other is missing. */
function range(schema: AiOutputSchema): [number, number] {
  const { minimum, maximum } = schema;
  if (minimum !== undefined && maximum !== undefined) return [minimum, maximum];
  if (minimum !== undefined) return [minimum, minimum + MOCK_NUMBER_SPAN];
  if (maximum !== undefined) return [maximum - MOCK_NUMBER_SPAN, maximum];
  return [-MOCK_NUMBER_SPAN, MOCK_NUMBER_SPAN];
}

function mockInteger(schema: AiOutputSchema, random: () => number): number {
  const [low, high] = range(schema);
  return between(random, Math.ceil(low), Math.floor(high));
}

function mockNumber(schema: AiOutputSchema, random: () => number): number {
  const [low, high] = range(schema);
  const value = Math.round((low + random() * (high - low)) * MOCK_DECIMALS) / MOCK_DECIMALS;
  return Math.min(high, Math.max(low, value));
}

function mockList(schema: AiOutputSchema, random: () => number): unknown[] {
  const min = schema.minItems ?? 0;
  const max = Math.min(schema.maxItems ?? min + MOCK_EXTRA_ITEMS, min + MOCK_EXTRA_ITEMS);
  const items = schema.items;
  if (!items) return [];
  return Array.from({ length: between(random, min, max) }, () => mockOf(items, random));
}

function mockObject(schema: AiOutputSchema, random: () => number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(schema.properties ?? {})) out[name] = mockOf(child, random);
  return out;
}

/** A value `schema` admits. */
function mockOf(schema: AiOutputSchema, random: () => number): unknown {
  if (schema.enum) return schema.enum[between(random, 0, schema.enum.length - 1)] ?? null;
  switch (schema.type) {
    case AiSchemaType.Object:
      return mockObject(schema, random);
    case AiSchemaType.Array:
      return mockList(schema, random);
    case AiSchemaType.String: {
      const min = Math.min(schema.minLength ?? 1, schema.maxLength ?? MOCK_STRING_CHARS);
      return words(random, min, Math.max(min, Math.min(schema.maxLength ?? MOCK_STRING_CHARS, MOCK_STRING_CHARS)));
    }
    case AiSchemaType.Integer:
      return mockInteger(schema, random);
    case AiSchemaType.Number:
      return mockNumber(schema, random);
    case AiSchemaType.Boolean:
      return random() < 0.5;
    default:
      return null;
  }
}

/** A made-up answer for a call: text for `say` (no schema), else a value its schema admits; null when there is no schema of the dialect. */
export function mockAnswer(schema: unknown, random: () => number): unknown {
  if (schema === null) return words(random, MOCK_SAY_CHARS.min, MOCK_SAY_CHARS.max);
  return isAiOutputSchema(schema) ? mockOf(schema, random) : null;
}

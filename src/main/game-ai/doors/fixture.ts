/**
 * The door of a fixture session and of tests: every call answered at once with the plainest value
 * that fits the game's schema (the first of an enum, the least of a range, the fewest items), or a
 * fixed line for `say`. Deterministic, free, never verified, and it reaches nothing. The scripted
 * engines of a fixture profile (`dev/fixture-engines.ts`) answer a game's call with the same value.
 */
import { AiDoor, AiOp } from "../../../shared/game-ai.ts";
import { type AiOutputSchema, AiSchemaType, isAiOutputSchema } from "../../../shared/game-ai-schema.ts";
import type { GameAiDoorImpl } from "../types.ts";

/** What a fixture answers a `say`. */
export const FIXTURE_SAID = "Fixture reply.";
/** The string a fixture writes where a schema allows it. */
const FIXTURE_TEXT = "fixture";
/** The engine and model id a fixture answer names. */
export const FIXTURE_ENGINE = "fixture";
export const FIXTURE_MODEL_ID = "fixture-v1";

/** The plainest string within a schema's length bounds. */
function fixtureString(schema: AiOutputSchema): string {
  const max = schema.maxLength ?? Number.POSITIVE_INFINITY;
  const min = schema.minLength ?? 0;
  const base = FIXTURE_TEXT.slice(0, Math.min(FIXTURE_TEXT.length, max));
  return base.padEnd(Math.min(Math.max(min, base.length), max), "f");
}

/** The number nearest zero within a schema's range; whole for an integer. */
function fixtureNumber(schema: AiOutputSchema): number {
  const low = schema.minimum ?? Number.NEGATIVE_INFINITY;
  const high = schema.maximum ?? Number.POSITIVE_INFINITY;
  const near = Math.min(Math.max(0, low), high);
  if (schema.type !== AiSchemaType.Integer) return near;
  const whole = Math.ceil(near);
  return whole > high ? Math.floor(high) : whole;
}

/** The plainest value that fits a schema of the dialect. */
export function fixtureValue(schema: AiOutputSchema): unknown {
  const first = schema.enum?.[0];
  if (first !== undefined) return first;
  switch (schema.type) {
    case AiSchemaType.Object:
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, child]) => [key, fixtureValue(child)]),
      );
    case AiSchemaType.Array: {
      const items = schema.items;
      return items ? Array.from({ length: schema.minItems ?? 0 }, () => fixtureValue(items)) : [];
    }
    case AiSchemaType.String:
      return fixtureString(schema);
    case AiSchemaType.Number:
    case AiSchemaType.Integer:
      return fixtureNumber(schema);
    case AiSchemaType.Boolean:
      return true;
    default:
      return null;
  }
}

/** A fixture's text for a call: the fixed line for `say`, else the plainest fitting JSON. */
export function fixtureText(op: AiOp, schema: unknown): string {
  if (op === AiOp.Say || !isAiOutputSchema(schema)) return FIXTURE_SAID;
  return JSON.stringify(fixtureValue(schema));
}

/** The fixture door. */
export function createFixtureDoor(): GameAiDoorImpl {
  return {
    door: AiDoor.Fixture,
    readiness: async () => ({
      door: AiDoor.Fixture,
      ready: true,
      json: true,
      loading: false,
      maxInputTokens: Number.MAX_SAFE_INTEGER,
    }),
    models: async () => [{ door: AiDoor.Fixture, engine: FIXTURE_ENGINE, model: FIXTURE_MODEL_ID }],
    worstCaseMicros: () => 0,
    run: async (call, signal, onDelta) => {
      signal.throwIfAborted();
      const text = fixtureText(call.request.op, call.request.schema);
      if (call.request.stream) onDelta?.(text);
      return { text, model: FIXTURE_MODEL_ID, usage: null, costMicros: 0 };
    },
  };
}

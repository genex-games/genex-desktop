/**
 * The worst answers a schema allows (`edgeAnswer`, what an `ai.replay` with `answers: "edge"` plays):
 * every one is an answer the schema admits, at its bounds — the largest numbers, the longest strings,
 * the fullest lists and the last enum word on one side; the smallest, the shortest, the emptiest and
 * the first word on the other — and odd seeds take the largest side.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AI_EDGE_MAX_CHARS,
  AI_EDGE_MAX_ITEMS,
  AiEdge,
  checkSchema,
  edgeAnswer,
  edgeOfSeed,
  validateValue,
} from "../../src/shared/game-ai-schema.ts";

const closed = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const SCHEMAS: Array<{ name: string; schema: unknown; max: unknown; min: unknown }> = [
  { name: "a bounded integer", schema: { type: "integer", minimum: -3, maximum: 3 }, max: 3, min: -3 },
  { name: "fractional integer bounds", schema: { type: "integer", minimum: -2.5, maximum: 2.5 }, max: 2, min: -2 },
  { name: "a bounded number", schema: { type: "number", minimum: 0.25, maximum: 9.5 }, max: 9.5, min: 0.25 },
  {
    name: "an unbounded integer",
    schema: { type: "integer" },
    max: Number.MAX_SAFE_INTEGER,
    min: -Number.MAX_SAFE_INTEGER,
  },
  { name: "a bounded string", schema: { type: "string", minLength: 2, maxLength: 5 }, max: "WWWWW", min: "WW" },
  {
    name: "an unbounded string",
    schema: { type: "string" },
    max: "W".repeat(AI_EDGE_MAX_CHARS),
    min: "",
  },
  { name: "an enum", schema: { type: "string", enum: ["ally", "war", "idle"] }, max: "idle", min: "ally" },
  { name: "a boolean", schema: { type: "boolean" }, max: true, min: false },
  { name: "null", schema: { type: "null" }, max: null, min: null },
  {
    name: "a bounded list",
    schema: { type: "array", items: { type: "integer", minimum: 0, maximum: 1 }, minItems: 1, maxItems: 3 },
    max: [1, 1, 1],
    min: [0],
  },
  {
    name: "a list longer than an edge fills",
    schema: { type: "array", items: { type: "boolean" }, maxItems: 1000 },
    max: Array.from({ length: AI_EDGE_MAX_ITEMS }, () => true),
    min: [],
  },
  {
    name: "a closed object",
    schema: closed({
      troops: { type: "integer", minimum: -500, maximum: 500 },
      note: { type: "string", maxLength: 4 },
      act: { type: "string", enum: ["a", "b"] },
    }),
    max: { troops: 500, note: "WWWW", act: "b" },
    min: { troops: -500, note: "", act: "a" },
  },
];

describe("the worst answers a schema allows", () => {
  for (const row of SCHEMAS) {
    it(`answers ${row.name} at both bounds, with a value the schema admits`, () => {
      assert.equal(checkSchema(row.schema), null);
      const max = edgeAnswer(row.schema, AiEdge.Max);
      const min = edgeAnswer(row.schema, AiEdge.Min);
      assert.deepEqual(max, row.max);
      assert.deepEqual(min, row.min);
      assert.ok(validateValue(row.schema, max));
      assert.ok(validateValue(row.schema, min));
    });
  }

  it("answers a deep schema of lists of objects with a value it admits", () => {
    const leaf = closed({ id: { type: "string", enum: ["x", "y"] }, n: { type: "number", minimum: -1, maximum: 1 } });
    const schema = closed({ rows: { type: "array", items: closed({ cells: { type: "array", items: leaf } }) } });
    for (const edge of Object.values(AiEdge)) assert.ok(validateValue(schema, edgeAnswer(schema, edge)), edge);
  });

  it("answers nothing for a schema the dialect refuses", () => {
    for (const schema of [null, { type: "object" }, { $ref: "#/x" }, { type: "string", pattern: "a" }])
      assert.equal(edgeAnswer(schema, AiEdge.Max), undefined, JSON.stringify(schema));
  });

  it("takes the largest side on odd seeds and the smallest on even ones", () => {
    assert.deepEqual([1, 2, 3, 0].map(edgeOfSeed), [AiEdge.Max, AiEdge.Min, AiEdge.Max, AiEdge.Min]);
  });
});

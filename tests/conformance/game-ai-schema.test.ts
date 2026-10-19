/**
 * The closed schema dialect (`src/shared/game-ai-schema.ts`) is genex.games' own, so a game that
 * passes on this Mac passes on the web. The parity table is genex-demo
 * `apps/api/src/runtime-generation/validation.ts` (`validateSchema`, `matches`, `validateOutput`)
 * row for row, at its default limits; a change on either side breaks a row here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AI_MAX_JSON_ARRAY_ITEMS,
  AI_SCHEMA_MAX_STRING,
  AiOutputProblem,
  AiSchemaProblem,
  canonicalJson,
  checkSchema,
  parseOutput,
  validateValue,
  withoutFence,
} from "../../src/shared/game-ai-schema.ts";

const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "object",
  properties,
  additionalProperties: false,
  ...extra,
});
const nest = (levels: number): unknown => {
  let schema: unknown = { type: "string" };
  for (let i = 0; i < levels; i += 1) schema = obj({ next: schema });
  return schema;
};

describe("checkSchema: genex.games' dialect, row for row", () => {
  const accepted: Array<[string, unknown]> = [
    ["a string", { type: "string" }],
    [
      "every scalar type",
      obj({
        s: { type: "string" },
        n: { type: "number" },
        i: { type: "integer" },
        b: { type: "boolean" },
        z: { type: "null" },
      }),
    ],
    ["an object with a required subset", obj({ a: { type: "string" }, b: { type: "string" } }, { required: ["a"] })],
    ["an object with no required list", obj({ a: { type: "string" } })],
    ["an array of objects", { type: "array", items: obj({ x: { type: "integer" } }), minItems: 1, maxItems: 8 }],
    ["an enum of mixed scalars", { type: "string", enum: ["a", 1, true, null] }],
    ["annotations", { type: "string", description: "x".repeat(500), title: "y".repeat(100) }],
    ["string bounds", { type: "string", minLength: 0, maxLength: AI_SCHEMA_MAX_STRING }],
    ["numeric bounds, fractional", { type: "number", minimum: -1.5, maximum: 2.5 }],
    ["depth 5", nest(5)],
    ["32 properties", obj(Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`p${i}`, { type: "string" }])))],
    ["an 80-character key", obj({ ["k".repeat(80)]: { type: "string" } })],
  ];
  for (const [what, schema] of accepted) it(`takes ${what}`, () => assert.equal(checkSchema(schema), null));

  const refused: Array<[string, unknown, AiSchemaProblem]> = [
    ["null", null, AiSchemaProblem.NotObject],
    ["an array", [{ type: "string" }], AiSchemaProblem.NotObject],
    ["depth 6", nest(6), AiSchemaProblem.TooDeep],
    ["an unknown type", { type: "date" }, AiSchemaProblem.UnknownType],
    ["a type list", { type: ["string", "null"] }, AiSchemaProblem.UnknownType],
    ["$ref", { type: "string", $ref: "#/x" }, AiSchemaProblem.UnknownKeyword],
    ["pattern", { type: "string", pattern: "^a" }, AiSchemaProblem.UnknownKeyword],
    ["anyOf", { type: "string", anyOf: [] }, AiSchemaProblem.UnknownKeyword],
    ["format", { type: "string", format: "email" }, AiSchemaProblem.UnknownKeyword],
    ["a long description", { type: "string", description: "x".repeat(501) }, AiSchemaProblem.BadAnnotation],
    ["a long title", { type: "string", title: "x".repeat(101) }, AiSchemaProblem.BadAnnotation],
    ["a numeric description", { type: "string", description: 3 }, AiSchemaProblem.BadAnnotation],
    ["an empty enum", { type: "string", enum: [] }, AiSchemaProblem.BadEnum],
    [
      "a 33-value enum",
      { type: "string", enum: Array.from({ length: 33 }, (_, i) => `v${i}`) },
      AiSchemaProblem.BadEnum,
    ],
    ["an enum with an object", { type: "string", enum: [{}] }, AiSchemaProblem.BadEnum],
    ["an enum with Infinity", { type: "number", enum: [Number.POSITIVE_INFINITY] }, AiSchemaProblem.BadEnum],
    ["an object open to more", { type: "object", properties: {} }, AiSchemaProblem.ObjectShape],
    ["an object with no properties", { type: "object", additionalProperties: false }, AiSchemaProblem.ObjectShape],
    [
      "33 properties",
      obj(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`p${i}`, { type: "string" }]))),
      AiSchemaProblem.ObjectShape,
    ],
    ["an 81-character key", obj({ ["k".repeat(81)]: { type: "string" } }), AiSchemaProblem.BadPropertyName],
    ["a __proto__ property", obj(JSON.parse('{"__proto__": {"type": "string"}}')), AiSchemaProblem.BadPropertyName],
    ["a constructor property", obj({ constructor: { type: "string" } }), AiSchemaProblem.BadPropertyName],
    ["required naming nothing", obj({ a: { type: "string" } }, { required: ["b"] }), AiSchemaProblem.BadRequired],
    ["required that is a string", obj({ a: { type: "string" } }, { required: "a" }), AiSchemaProblem.BadRequired],
    ["properties on a string", { type: "string", properties: {} }, AiSchemaProblem.MisplacedKeyword],
    [
      "additionalProperties on an array",
      { type: "array", items: { type: "string" }, additionalProperties: false },
      AiSchemaProblem.MisplacedKeyword,
    ],
    ["items on a string", { type: "string", items: { type: "string" } }, AiSchemaProblem.MisplacedKeyword],
    ["an array with no items", { type: "array" }, AiSchemaProblem.NotObject],
    ["maxLength on a number", { type: "number", maxLength: 3 }, AiSchemaProblem.MisplacedKeyword],
    ["minimum on a string", { type: "string", minimum: 1 }, AiSchemaProblem.MisplacedKeyword],
    ["a fractional maxItems", { type: "array", items: { type: "string" }, maxItems: 1.5 }, AiSchemaProblem.BadBound],
    ["a negative minLength", { type: "string", minLength: -1 }, AiSchemaProblem.BadBound],
    ["maxItems over 65,536", { type: "array", items: { type: "string" }, maxItems: 65_537 }, AiSchemaProblem.BadBound],
    ["min above max", { type: "integer", minimum: 5, maximum: 1 }, AiSchemaProblem.BadBound],
    ["a non-finite maximum", { type: "number", maximum: Number.NaN }, AiSchemaProblem.BadBound],
  ];
  for (const [what, schema, problem] of refused)
    it(`refuses ${what}`, () => assert.equal(checkSchema(schema), problem));
});

describe("validateValue: genex.games' matches and validateOutput", () => {
  const shape = obj(
    {
      verdict: { type: "string", enum: ["win", "lose"] },
      score: { type: "integer", minimum: 0, maximum: 100 },
      notes: { type: "array", items: { type: "string", maxLength: 3 }, maxItems: 2 },
    },
    { required: ["verdict"] },
  );
  const rows: Array<[string, unknown, boolean]> = [
    ["a full answer", { verdict: "win", score: 3, notes: ["ab"] }, true],
    ["only the required field", { verdict: "lose" }, true],
    ["a missing required field", { score: 3 }, false],
    ["an extra field", { verdict: "win", extra: 1 }, false],
    ["a value outside the enum", { verdict: "draw" }, false],
    ["a fractional integer", { verdict: "win", score: 1.5 }, false],
    ["an integer over its maximum", { verdict: "win", score: 101 }, false],
    ["too many items", { verdict: "win", notes: ["a", "b", "c"] }, false],
    ["a string over its length in code points", { verdict: "win", notes: ["abcd"] }, false],
    ["emoji counted as code points", { verdict: "win", notes: ["😀😀😀"] }, true],
    ["an array at the top", [{ verdict: "win" }], false],
  ];
  for (const [what, value, ok] of rows) it(what, () => assert.equal(validateValue(shape, value), ok));

  it("caps an array with no maxItems at the stand's item count", () => {
    const list = { type: "array", items: { type: "integer" } };
    assert.equal(
      validateValue(
        list,
        Array.from({ length: AI_MAX_JSON_ARRAY_ITEMS }, () => 1),
      ),
      true,
    );
    assert.equal(
      validateValue(
        list,
        Array.from({ length: AI_MAX_JSON_ARRAY_ITEMS + 1 }, () => 1),
      ),
      false,
    );
  });

  it("takes text only with words in it, and refuses a schema outside the dialect", () => {
    assert.equal(validateValue(null, "Hello, traveller."), true);
    assert.equal(validateValue(null, "   "), false);
    assert.equal(validateValue(null, 3), false);
    assert.equal(validateValue({ type: "string", pattern: "x" }, "x"), false);
  });
});

describe("parseOutput: a model's text into the game's answer", () => {
  const shape = obj({ ok: { type: "boolean" } }, { required: ["ok"] });
  it("drops one fence around the whole answer", () => {
    assert.equal(withoutFence('```json\n{"ok":true}\n```'), '{"ok":true}');
    assert.equal(withoutFence("```\n[1]\n```"), "[1]");
    assert.equal(withoutFence('  {"ok":true}  '), '{"ok":true}');
    assert.deepEqual(parseOutput(shape, '```json\n{"ok": true}\n```'), { ok: true, value: { ok: true } });
  });
  const rows: Array<[string, string, AiOutputProblem]> = [
    ["nothing", "  ", AiOutputProblem.Empty],
    ["an empty fence", "```json\n```", AiOutputProblem.Empty],
    ["prose", "Sure! Here it is: ok", AiOutputProblem.NotJson],
    ["JSON with a trailing comment", '{"ok":true} // done', AiOutputProblem.NotJson],
    ["the wrong shape", '{"ok":"yes"}', AiOutputProblem.Shape],
    ["an overflowing exponent", '{"ok":1e999}', AiOutputProblem.Shape],
    ["a huge answer", `"${"x".repeat(600 * 1024)}"`, AiOutputProblem.TooLarge],
  ];
  for (const [what, text, problem] of rows) {
    it(`names ${what}`, () => assert.deepEqual(parseOutput(shape, text), { ok: false, problem }));
  }
  it("keeps free text trimmed, and refuses an empty one", () => {
    assert.deepEqual(parseOutput(null, "  The gate creaks.\n"), { ok: true, value: "The gate creaks." });
    assert.deepEqual(parseOutput(null, "\n"), { ok: false, problem: AiOutputProblem.Empty });
  });
});

describe("canonicalJson: the same request, the same text", () => {
  it("sorts keys at every level, drops undefined fields and keeps array order", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, 1], c: undefined, B: true } }), '{"a":{"B":true,"d":[3,1]},"b":1}');
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
    assert.equal(canonicalJson(null), "null");
    assert.equal(canonicalJson("x"), '"x"');
  });
});

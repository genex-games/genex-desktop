/**
 * `s`, the schema builders a game writes its `ask` shapes with. Each builds a plain schema of the
 * closed dialect genex.games and Studio share (`shared/game-ai-schema.ts`); a builder never throws,
 * and a shape the dialect refuses is refused by `checkSchema` with the reason the agent is told.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AiSchemaProblem, checkSchema, validateValue } from "../../src/shared/game-ai-schema.ts";
import { type Infer, s } from "../../src/page/ai/schema.ts";

const Turn = s.object({
  reactions: s.list(
    s.object({
      nation: s.oneOf(["aurel", "brenn"]),
      stance: s.int(-3, 3),
      share: s.number(0, 1, "how much"),
      note: s.string({ max: 120 }),
      angry: s.bool(),
    }),
    8,
  ),
  headline: s.describe(s.string({ min: 1, max: 160 }), "one line"),
});

describe("the schema builders", () => {
  it("build schemas the dialect takes", () => {
    for (const schema of [
      Turn,
      s.string(),
      s.int(0, 9),
      s.number(-1, 1),
      s.bool(),
      s.oneOf(["a"]),
      s.list(s.bool(), 3, 1),
    ]) {
      assert.equal(checkSchema(schema), null, JSON.stringify(schema));
    }
  });

  it("close every object and require every property", () => {
    const point = s.object({ x: s.int(0, 1), y: s.int(0, 1) });
    assert.equal(point.additionalProperties, false);
    assert.deepEqual(point.required, ["x", "y"]);
  });

  it("hold the values they type", () => {
    const value: Infer<typeof Turn> = {
      reactions: [{ nation: "brenn", stance: -3, share: 0.5, note: "", angry: false }],
      headline: "War",
    };
    assert.equal(validateValue(Turn, value), true);
    assert.equal(validateValue(Turn, { ...value, extra: 1 }), false);
    assert.equal(validateValue(Turn, { ...value, headline: "" }), false);
    assert.equal(validateValue(Turn, { reactions: [{ ...value.reactions[0], stance: 4 }], headline: "x" }), false);
  });

  it("carry a description where one is given, and only then", () => {
    assert.equal(s.int(0, 1, "count").description, "count");
    assert.equal(Object.hasOwn(s.int(0, 1), "description"), false);
  });
});

describe("a shape the dialect refuses is refused by its reason, never thrown", () => {
  const deep = s.object({
    a: s.object({ b: s.object({ c: s.object({ d: s.object({ e: s.object({ f: s.bool() }) }) }) }) }),
  });
  const ROWS: Array<[string, unknown, AiSchemaProblem]> = [
    ["a range upside down", s.int(5, 1), AiSchemaProblem.BadBound],
    ["a non-finite bound", s.number(0, Number.POSITIVE_INFINITY), AiSchemaProblem.BadBound],
    ["a negative length", s.string({ max: -1 }), AiSchemaProblem.BadBound],
    ["an empty word list", s.oneOf([]), AiSchemaProblem.BadEnum],
    ["a word list past its cap", s.oneOf(Array.from({ length: 33 }, (_, i) => `w${i}`)), AiSchemaProblem.BadEnum],
    ["nesting past five", deep, AiSchemaProblem.TooDeep],
    [
      "a property named __proto__",
      s.object(JSON.parse('{"__proto__":{"type":"boolean"}}')),
      AiSchemaProblem.BadPropertyName,
    ],
    ["a description past its cap", s.bool("d".repeat(501)), AiSchemaProblem.BadAnnotation],
  ];
  for (const [name, schema, problem] of ROWS) {
    it(name, () => assert.equal(checkSchema(schema), problem));
  }
});

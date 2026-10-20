/**
 * The game template's `src/ai.d.ts` is what a builder agent and a TypeScript game read of
 * `genex-ai`; `src/page/ai` is what runs. The compiler holds the two together here: every value
 * the module exports is declared, nothing is declared that it does not export, and each declared
 * type takes exactly what the real one takes. `npm run typecheck` fails this file on any drift.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as Declared from "genex-ai";
import * as real from "../../src/page/ai/index.ts";

type Real = typeof real;

/** A and B are the same set of values. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** What the declaration promises of a value the module exports (the module may promise more). */
type Keeps<RealValue, DeclaredValue> = [RealValue] extends [DeclaredValue] ? true : false;

const surface: {
  names: Same<keyof typeof Declared, keyof Real>;
  vocabularies: [
    Same<typeof Declared.AiOp, Real["AiOp"]>,
    Same<typeof Declared.AiTier, Real["AiTier"]>,
    Same<typeof Declared.AiAuthority, Real["AiAuthority"]>,
    Same<typeof Declared.AiRequirement, Real["AiRequirement"]>,
    Same<typeof Declared.AiDoor, Real["AiDoor"]>,
    Same<typeof Declared.AiSource, Real["AiSource"]>,
    Same<typeof Declared.AiProvenance, Real["AiProvenance"]>,
    Same<typeof Declared.AiErrorCode, Real["AiErrorCode"]>,
    Same<typeof Declared.AiJudgeKind, Real["AiJudgeKind"]>,
    Same<typeof Declared.AiGrantPeriod, Real["AiGrantPeriod"]>,
  ];
  types: [
    Same<Declared.AiStatus, real.AiStatus>,
    Same<Declared.AiResult, real.AiResult>,
    Same<Declared.AiResult<{ a: number }>, real.AiResult<{ a: number }>>,
    Same<Declared.CreateAiOptions, real.CreateAiOptions>,
    Same<Declared.PlatformOptions, real.PlatformOptions>,
    Same<Declared.AiFailure, real.AiFailure>,
    Same<Declared.AiDisclosure, real.AiDisclosure>,
    Same<Declared.JudgeQuestion, real.JudgeQuestion>,
    Same<Declared.AiMemory, real.AiMemory>,
    Same<Declared.AiTicket<string>, real.AiTicket<string>>,
    Same<Declared.SayRequest, real.SayRequest>,
    Same<Declared.GameAi, real.GameAi>,
    Same<Declared.Schema<{ a: string }>, real.Schema<{ a: string }>>,
  ];
  functions: [
    Keeps<Real["createAi"], typeof Declared.createAi>,
    Keeps<Real["checkSchema"], typeof Declared.checkSchema>,
    Keeps<Real["s"], typeof Declared.s>,
  ];
} = {
  names: true,
  vocabularies: [true, true, true, true, true, true, true, true, true, true],
  types: [true, true, true, true, true, true, true, true, true, true, true, true, true],
  functions: [true, true, true],
};

describe("the template's genex-ai declaration", () => {
  it("declares exactly what genex-ai exports, each the same shape (checked by the compiler)", () => {
    assert.equal(surface.names, true);
    assert.ok([...surface.vocabularies, ...surface.types, ...surface.functions].every(Boolean));
  });

  it("exports the values the declaration names, at run time", () => {
    assert.equal(typeof real.createAi, "function");
    assert.equal(typeof real.checkSchema, "function");
    for (const builder of Object.values(real.s)) assert.equal(typeof builder, "function");
    assert.equal(real.AiErrorCode.Unrecorded, "ai_unrecorded");
  });
});

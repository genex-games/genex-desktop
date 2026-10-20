/**
 * What Studio's trusted surfaces send and read of play-time AI: the model check's pure rules
 * (D10/D12), the counts-only fit-from-play row, and the readers main runs on every renderer payload
 * (a model, a card's answer, a Settings change, a Report, a checkout) before anything happens.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AiDoor, AiFunding, type AiModelRef } from "../../src/shared/game-ai.ts";
import {
  AI_CHECK_MAX_MODELS,
  AiCheckFit,
  type AiCheckRow,
  AiCostLevel,
  bestFits,
  checkSet,
  costLevelOf,
  fitOf,
  mergeFitCounts,
  readAiFitCountRow,
} from "../../src/shared/game-ai-check.ts";
import {
  AiCreditProductKind,
  AiPickPolicy,
  readAiConsentAnswer,
  readAiCreditProduct,
  readAiModelRef,
  readAiReportRequest,
  readGameAiSettingsPatch,
} from "../../src/shared/game-ai-views.ts";

const model = (door: AiDoor, name: string, engine = "ollama"): AiModelRef => ({ door, engine, model: name });
const row = (name: string, fitted: number, cost: AiCostLevel): AiCheckRow => ({
  model: model(AiDoor.Local, name),
  label: name,
  funding: AiFunding.Free,
  moments: 10,
  fitted,
  fit: fitOf(fitted, 10),
  cost,
  medianLatencyMs: 900,
  note: null,
});

describe("the model check's rules", () => {
  it("builds the dynamic set: the panel first, then the rest, each once, never Genex credits", () => {
    const haiku = model(AiDoor.Plan, "claude-haiku-4-5", "claude-code");
    const qwen = model(AiDoor.Local, "qwen3:8b");
    const credits = model(AiDoor.GenexCredits, "anthropic/claude-haiku-4.5", "genex");
    assert.deepEqual(checkSet([haiku, qwen], [qwen, credits, model(AiDoor.Byok, "gemini", "openrouter")]), [
      haiku,
      qwen,
      model(AiDoor.Byok, "gemini", "openrouter"),
    ]);
    const many = Array.from({ length: 20 }, (_, i) => model(AiDoor.Local, `m${i}`));
    assert.equal(checkSet([], many).length, AI_CHECK_MAX_MODELS);
  });

  it("calls a model untested on too few moments, fitting at four in five", () => {
    assert.equal(fitOf(2, 2), AiCheckFit.Untested);
    assert.equal(fitOf(4, 5), AiCheckFit.Fits);
    assert.equal(fitOf(3, 5), AiCheckFit.Struggles);
    assert.equal(fitOf(0, Number.NaN), AiCheckFit.Untested);
  });

  it("prices free, plan and playtests as free, and the rest by a moment's median cost", () => {
    assert.equal(costLevelOf(AiFunding.Free, 50_000), AiCostLevel.Free);
    assert.equal(costLevelOf(AiFunding.Plan, 50_000), AiCostLevel.Free);
    assert.equal(costLevelOf(AiFunding.Key, 1_000), AiCostLevel.Low);
    assert.equal(costLevelOf(AiFunding.Credits, 10_000), AiCostLevel.Medium);
    assert.equal(costLevelOf(AiFunding.Credits, 10_001), AiCostLevel.High);
  });

  it("orders the models that fit by fit, then by cost", () => {
    const rows = [
      row("a", 9, AiCostLevel.High),
      row("b", 9, AiCostLevel.Free),
      row("c", 10, AiCostLevel.Low),
      row("d", 2, AiCostLevel.Free),
    ];
    assert.deepEqual(
      bestFits(rows).map((r) => r.label),
      ["c", "b", "a"],
    );
  });
});

describe("fit from real play: counts only", () => {
  const ROW = { game: "play:p1", door: "local", model: "qwen3:8b", week: "2026-W43", calls: 10, fitted: 8, invalid: 2 };
  it("takes a row whose counts add up", () => assert.deepEqual(readAiFitCountRow(ROW), ROW));
  const hostile: Array<[string, Record<string, unknown>]> = [
    ["more fitted and invalid than calls", { fitted: 9, invalid: 2 }],
    ["a negative count", { calls: -1 }],
    ["a fractional count", { calls: 1.5 }],
    ["a slug for a game", { game: "pong" }],
    ["an unknown door", { door: "gpu" }],
    ["a week out of range", { week: "2026-W54" }],
    ["a date for a week", { week: "2026-10-20" }],
    ["text riding along", { prompt: "what the player typed" }],
    ["an empty model", { model: "" }],
  ];
  for (const [what, change] of hostile)
    it(`refuses ${what}`, () => assert.equal(readAiFitCountRow({ ...ROW, ...change }), null));

  it("adds rows of the same game, door, model and week", () => {
    const read = readAiFitCountRow(ROW);
    assert.ok(read);
    assert.deepEqual(mergeFitCounts([read, read, { ...read, week: "2026-W44" }]), [
      { ...read, calls: 20, fitted: 16, invalid: 4 },
      { ...read, week: "2026-W44" },
    ]);
  });
});

describe("readers of what the renderer sends", () => {
  const HAIKU = { door: "plan", engine: "claude-code", model: "claude-haiku-4-5" };

  it("reads a model, and refuses a forged one", () => {
    assert.deepEqual(readAiModelRef(HAIKU), HAIKU);
    for (const raw of [
      { ...HAIKU, door: "wallet" },
      { ...HAIKU, engine: "../bin" },
      { ...HAIKU, model: "" },
      { ...HAIKU, model: "x\u0007" },
      { ...HAIKU, model: "m".repeat(201) },
      { ...HAIKU, price: 0 },
      null,
    ]) {
      assert.equal(readAiModelRef(raw), null, JSON.stringify(raw));
    }
  });

  it("reads a card's answer exactly", () => {
    const answer = { ticket: "ticket-0001", approve: true, model: null, unranked: false };
    assert.deepEqual(readAiConsentAnswer(answer), answer);
    assert.deepEqual(readAiConsentAnswer({ ...answer, model: HAIKU }), { ...answer, model: HAIKU });
    for (const raw of [
      { ...answer, approve: "yes" },
      { ...answer, ticket: "t" },
      { ...answer, model: { door: "plan" } },
      { ...answer, unranked: 1 },
      { ...answer, spend: 5000 },
    ]) {
      assert.equal(readAiConsentAnswer(raw), null, JSON.stringify(raw));
    }
  });

  it("reads a Settings change field by field, in range", () => {
    assert.deepEqual(readGameAiSettingsPatch({ pick: AiPickPolicy.FreeOnly, dailyAlertCredits: null }), {
      pick: "free-only",
      dailyAlertCredits: null,
    });
    assert.deepEqual(readGameAiSettingsPatch({ autoTopUp: { on: true, underCredits: 100, addCredits: 1000 } }), {
      autoTopUp: { on: true, underCredits: 100, addCredits: 1000 },
    });
    for (const raw of [
      {},
      { pick: "cheapest" },
      { keepForBuildingPercent: 101 },
      { keepForBuildingPercent: 49.5 },
      { dailyAlertCredits: 0 },
      { openRouterMonthlyMicros: -1 },
      { autoTopUp: { on: true, underCredits: 100 } },
      { autoTopUp: { on: true, underCredits: 100, addCredits: 1_000_000 } },
      { allowPlan: "true" },
      { balanceCredits: 99_999 },
      { __proto__: { allowPlan: true } },
      null,
    ]) {
      assert.equal(readGameAiSettingsPatch(raw), null, JSON.stringify(raw));
    }
  });

  it("reads a Report: a game, a reason, a short note", () => {
    assert.deepEqual(readAiReportRequest({ game: "play:p1", reason: "harmful", note: "  " }), {
      game: "play:p1",
      reason: "harmful",
      note: null,
    });
    for (const raw of [
      { game: "play:p1", reason: "spam", note: null },
      { game: "p1", reason: "other", note: null },
      { game: "play:p1", reason: "other", note: "x".repeat(501) },
      { game: "play:p1", reason: "other" },
      { game: "play:p1", reason: "other", note: null, account: "u1" },
    ]) {
      assert.equal(readAiReportRequest(raw), null, JSON.stringify(raw));
    }
  });

  it("reads what Get credits sells, and nothing else", () => {
    assert.deepEqual(readAiCreditProduct({ kind: AiCreditProductKind.Pro }), { kind: "pro" });
    assert.deepEqual(readAiCreditProduct({ kind: "pack", packId: "pack_2500" }), { kind: "pack", packId: "pack_2500" });
    for (const raw of [
      { kind: "pack" },
      { kind: "pack", packId: "../x" },
      { kind: "pack", packId: "p1", priceCents: 1 },
      { kind: "pro", packId: "p1" },
      { kind: "gift" },
      null,
    ]) {
      assert.equal(readAiCreditProduct(raw), null, JSON.stringify(raw));
    }
  });
});

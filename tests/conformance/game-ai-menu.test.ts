/**
 * The AI pill's model menu (`main/game-ai/menu.ts`), the chat's model menu for one game: the models
 * the doors legal for the game offer now, grouped by who makes them, named as the chat names them,
 * one tag a row (the maker's pick, Free, plan, or what the game costs on the person's own key), the
 * model check's fit, the "may struggle" models folded away, the Genex group with the balance and
 * the maker's pick on credits, and the top line in the words of how the game is paid.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGameAiMenu, type GameAiMenuDeps } from "../../src/main/game-ai/menu.ts";
import type { AiGrantRecord, AiLedgerEntry, GameAiDoorImpl } from "../../src/main/game-ai/types.ts";
import {
  AiConsent,
  AiDoor,
  AiFunding,
  type AiGameKey,
  AiGrantStatus,
  type AiModelRef,
  AiProvenance,
  AiRequirement,
} from "../../src/shared/game-ai.ts";
import { AiCheckFit, type AiCheckRow, AiCostLevel } from "../../src/shared/game-ai-check.ts";
import { AiMaker, AiModelTag } from "../../src/shared/game-ai-views.ts";
import { BYOK_HAIKU, heldClock, LOCAL_QWEN, PLAN_HAIKU, scriptedDoor } from "../helpers/game-ai-fakes.ts";

const PLAY: AiGameKey = "play:proj_crowns";
const OWN: AiGameKey = "create:Moss Garden";
const GPT: AiModelRef = { door: AiDoor.Byok, engine: "openrouter", model: "openai/gpt-5-mini" };
const MISTRAL: AiModelRef = { door: AiDoor.Byok, engine: "openrouter", model: "mistralai/mistral-small" };
const GEMINI: AiModelRef = { door: AiDoor.Byok, engine: "openrouter", model: "google/gemini-2.5-flash" };
const OPENCODE_FREE: AiModelRef = { door: AiDoor.OpenCode, engine: "opencode", model: "opencode/grok-code" };
const DEV_HAIKU: AiModelRef = { door: AiDoor.GenexDev, engine: "genex", model: "anthropic/claude-haiku-4.5" };

const LABELS: Record<string, { label: string; shortLabel: string; free?: boolean }> = {
  [LOCAL_QWEN.model]: { label: "Qwen3 8B", shortLabel: "Qwen3 8B" },
  [BYOK_HAIKU.model]: { label: "Claude Haiku 4.5", shortLabel: "Haiku 4.5" },
  [PLAN_HAIKU.model]: { label: "Claude Haiku 4.5", shortLabel: "Haiku 4.5" },
  [GPT.model]: { label: "GPT-5 mini", shortLabel: "GPT-5 mini" },
  [MISTRAL.model]: { label: "Mistral Small", shortLabel: "Mistral Small" },
  [GEMINI.model]: { label: "Gemini 2.5 Flash", shortLabel: "Gemini Flash" },
  [OPENCODE_FREE.model]: { label: "Grok Code", shortLabel: "Grok Code", free: true },
};

function grantOf(game: AiGameKey, model: AiModelRef, patch: Partial<AiGrantRecord> = {}): AiGrantRecord {
  return {
    id: "g_menu00001",
    game,
    door: model.door,
    model,
    status: AiGrantStatus.Active,
    consent: AiConsent.Card,
    consentedAt: "2026-10-20T10:00:00.000Z",
    lastUsedAt: null,
    spentMicros: 0,
    todayMicros: 0,
    day: "2026-10-20",
    monthMicros: 0,
    month: "2026-10",
    requires: AiRequirement.Optional,
    ...patch,
  };
}

function checkRow(model: AiModelRef, fit: AiCheckFit, cost: AiCostLevel): AiCheckRow {
  return {
    model,
    label: model.model,
    funding: AiFunding.Key,
    moments: 6,
    fitted: fit === AiCheckFit.Fits ? 6 : 2,
    fit,
    cost,
    medianLatencyMs: 900,
    note: null,
  };
}

interface Setup {
  grant?: AiGrantRecord | null;
  off?: boolean;
  balance?: number | null;
  check?: { rows: AiCheckRow[]; recommended: AiModelRef | null } | null;
  ready?: Partial<Record<AiDoor, boolean>>;
  ledger?: AiLedgerEntry[];
  planUsage?: { usedPercent: number; resetsAt: string | null } | null;
}

function menuFor(setup: Setup = {}) {
  const clock = heldClock();
  const door = (id: AiDoor, models: AiModelRef[], extra: Partial<GameAiDoorImpl> = {}) => ({
    ...scriptedDoor(id, [], { models, ready: { ready: setup.ready?.[id] ?? true } }),
    ...extra,
  });
  const doors = new Map<AiDoor, GameAiDoorImpl>([
    [AiDoor.Local, door(AiDoor.Local, [LOCAL_QWEN])],
    [AiDoor.OpenCode, door(AiDoor.OpenCode, [OPENCODE_FREE])],
    [AiDoor.Byok, door(AiDoor.Byok, [BYOK_HAIKU, GPT, MISTRAL, GEMINI])],
    [AiDoor.Plan, door(AiDoor.Plan, [PLAN_HAIKU], { usage: async () => setup.planUsage ?? null })],
    [AiDoor.GenexDev, door(AiDoor.GenexDev, [DEV_HAIKU])],
  ]);
  const deps: GameAiMenuDeps = {
    clock,
    doors,
    grants: {
      live: (game) => (setup.grant?.game === game ? setup.grant : null),
      isOff: () => setup.off ?? false,
    },
    ledger: { recent: async (_limit, game) => (setup.ledger ?? []).filter((entry) => !game || entry.game === game) },
    titleOf: async (game) => (game === PLAY ? "Crowns of 1444" : "Moss Garden"),
    facts: async (model) => LABELS[model.model] ?? null,
    balanceCredits: async () => (setup.balance === undefined ? 900 : setup.balance),
    check: async (game) => (game === OWN ? (setup.check ?? null) : null),
    sessionStartedAt: clock.now(),
  };
  return createGameAiMenu(deps);
}

const rowsOf = (menu: Awaited<ReturnType<ReturnType<typeof createGameAiMenu>>>) =>
  menu.groups.flatMap((group) => group.rows);

describe("the AI pill's model menu", () => {
  it("lists a Play game's models on the doors Play may use, grouped by who makes them", async () => {
    const menu = await menuFor()(PLAY);
    assert.equal(menu.title, "Crowns of 1444");
    assert.deepEqual(
      menu.groups.map((group) => group.maker),
      [AiMaker.Claude, AiMaker.ChatGpt, AiMaker.Google, AiMaker.Local, AiMaker.Other],
    );
    const doors = new Set(rowsOf(menu).map((row) => row.model.door));
    assert.ok(!doors.has(AiDoor.Plan), "the plan answers only the creator's own game");
    assert.ok(!doors.has(AiDoor.GenexDev), "credits are the Genex group's, never a row of a maker");
    const haiku = rowsOf(menu).find((row) => row.model.model === BYOK_HAIKU.model);
    assert.equal(haiku?.label, "Claude Haiku 4.5");
    assert.equal(haiku?.shortLabel, "Haiku 4.5");
    assert.equal(haiku?.funding, AiFunding.Key);
    const local = rowsOf(menu).find((row) => row.model.door === AiDoor.Local);
    assert.equal(local?.funding, AiFunding.Free);
    assert.equal(local?.tag, AiModelTag.Free);
    const freeOpenCode = rowsOf(menu).find((row) => row.model.door === AiDoor.OpenCode);
    assert.equal(freeOpenCode?.funding, AiFunding.Free, "an OpenCode model the catalog marks free costs nothing");
    assert.deepEqual(menu.genex, { signedIn: true, balanceCredits: 900, recommended: null, recommendedLabel: null });
  });

  it("offers the creator's own game their plan, tagged plan, in a group paid by the plan", async () => {
    const menu = await menuFor()(OWN);
    const plan = rowsOf(menu).find((row) => row.model.door === AiDoor.Plan);
    assert.equal(plan?.funding, AiFunding.Plan);
    assert.equal(plan?.tag, AiModelTag.Plan);
    const claude = menu.groups.find((group) => group.rows.some((row) => row.model.door === AiDoor.Plan));
    assert.equal(claude?.maker, AiMaker.Claude);
  });

  it("tags the maker's pick Best, wears the check's fit and cost, and folds the models that struggle", async () => {
    const menu = await menuFor({
      check: {
        rows: [
          checkRow(BYOK_HAIKU, AiCheckFit.Fits, AiCostLevel.Low),
          checkRow(GPT, AiCheckFit.Fits, AiCostLevel.High),
          checkRow(MISTRAL, AiCheckFit.Struggles, AiCostLevel.Low),
        ],
        recommended: BYOK_HAIKU,
      },
    })(OWN);
    const rows = rowsOf(menu);
    assert.equal(rows.find((row) => sameRef(row.model, BYOK_HAIKU))?.tag, AiModelTag.Best);
    assert.equal(rows.find((row) => sameRef(row.model, GPT))?.tag, AiModelTag.CostHigh);
    assert.equal(rows.find((row) => sameRef(row.model, GPT))?.fit, AiCheckFit.Fits);
    assert.equal(rows.find((row) => sameRef(row.model, GEMINI))?.fit, null, "nobody checked it");
    assert.equal(rows.find((row) => sameRef(row.model, GEMINI))?.tag, null, "no cost is guessed");
    assert.ok(!rows.some((row) => sameRef(row.model, MISTRAL)));
    assert.deepEqual(
      menu.struggling.map((row) => row.model),
      [MISTRAL],
    );
    assert.deepEqual(menu.genex.recommended, DEV_HAIKU, "players on credits get the maker's pick");
    assert.equal(menu.genex.recommendedLabel, "Claude Haiku 4.5");
  });

  it("marks a model that cannot answer now as not ready, and keeps it listed", async () => {
    const menu = await menuFor({ ready: { [AiDoor.Byok]: false } })(PLAY);
    const haiku = rowsOf(menu).find((row) => sameRef(row.model, BYOK_HAIKU));
    assert.equal(haiku?.ready, false);
    assert.equal(rowsOf(menu).find((row) => row.model.door === AiDoor.Local)?.ready, true);
  });

  it("names the game's model and says what it costs in the words of how it is paid", async () => {
    const free = await menuFor({ grant: grantOf(PLAY, LOCAL_QWEN) })(PLAY);
    assert.deepEqual(free.current, LOCAL_QWEN);
    assert.deepEqual(free.usage, { funding: AiFunding.Free });
    const key = await menuFor({ grant: grantOf(PLAY, BYOK_HAIKU, { monthMicros: 120_000 }) })(PLAY);
    assert.deepEqual(key.usage, { funding: AiFunding.Key, monthMicros: 120_000 });
    const plan = await menuFor({
      grant: grantOf(OWN, PLAN_HAIKU),
      planUsage: { usedPercent: 31, resetsAt: "2026-10-20T15:00:00.000Z" },
    })(OWN);
    assert.deepEqual(plan.usage, {
      funding: AiFunding.Plan,
      planUsedPercent: 31,
      resetsAt: "2026-10-20T15:00:00.000Z",
    });
    const session: AiLedgerEntry[] = [
      ledgerLine(OWN, 30_000, "2026-10-20T10:00:00.000Z"),
      ledgerLine(OWN, 25_000, "2026-10-20T10:00:00.000Z"),
      ledgerLine(OWN, 99_000, "2026-10-19T09:00:00.000Z"),
      ledgerLine(PLAY, 50_000, "2026-10-20T10:00:00.000Z"),
    ];
    const credits = await menuFor({ grant: grantOf(OWN, DEV_HAIKU), ledger: session, balance: 420 })(OWN);
    assert.deepEqual(credits.usage, { funding: AiFunding.Credits, sessionCredits: 6, balanceCredits: 420 });
  });

  it("names no model and no cost while AI is off, and reads signed out as no balance", async () => {
    const menu = await menuFor({ grant: grantOf(PLAY, LOCAL_QWEN), off: true, balance: null })(PLAY);
    assert.equal(menu.off, true);
    assert.equal(menu.current, null);
    assert.equal(menu.usage, null);
    assert.deepEqual(menu.genex, { signedIn: false, balanceCredits: null, recommended: null, recommendedLabel: null });
    assert.equal(menu.requires, AiRequirement.Optional);
  });
});

const sameRef = (a: AiModelRef, b: AiModelRef): boolean =>
  a.door === b.door && a.engine === b.engine && a.model === b.model;

function ledgerLine(game: AiGameKey, costMicros: number, at: string): AiLedgerEntry {
  return {
    at,
    game,
    grantId: null,
    site: "turn.resolve",
    door: AiDoor.GenexDev,
    model: DEV_HAIKU.model,
    provenance: AiProvenance.Verified,
    code: null,
    repaired: false,
    usage: null,
    costMicros,
    latencyMs: 1,
  };
}

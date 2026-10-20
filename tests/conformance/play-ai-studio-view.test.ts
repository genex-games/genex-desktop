/**
 * What Studio's creator surfaces of play-time AI say (`renderer/panels/game-ai/play-ai-view.ts`),
 * against the v3 canvas copy: the Create pill and its menu's top line, Settings' Games lines, the
 * optional model check's table, Publish's block and the engine Live card's line. Credits are the
 * unit; no line names a price per hour or per reply.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AiDoor, AiFunding, type AiModelRef, AiRequirement } from "../../src/shared/game-ai.ts";
import {
  AiCheckFit,
  type AiCheckResult,
  AiCheckState,
  AiCostLevel,
  type AiPublishFacts,
} from "../../src/shared/game-ai-check.ts";
import { AiMaker, type AiMenuRow, type AiModelMenu, AiModelTag, AiStopReason } from "../../src/shared/game-ai-views.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import {
  AiLineTone,
  BestWithAction,
  checkIntro,
  checkRows,
  engineAiLine,
  gameLine,
  PillState,
  pillView,
  publishAiView,
  publishChoice,
  publishShowsAi,
  strugglesLine,
  usageWords,
} from "../../src/renderer/panels/game-ai/play-ai-view.ts";
import { checkoutPriceWords, keySpendWords } from "../../src/renderer/words.ts";

const MAC = StudioPlatform.Mac;
const HAIKU: AiModelRef = { door: AiDoor.Plan, engine: "claude-code", model: "claude-haiku-4-5" };
const SONNET: AiModelRef = { door: AiDoor.Plan, engine: "claude-code", model: "claude-sonnet-4-5" };
const GPT: AiModelRef = { door: AiDoor.Plan, engine: "codex", model: "gpt-5-mini" };
const GEMINI: AiModelRef = { door: AiDoor.Byok, engine: "openrouter", model: "google/gemini-2.5-flash" };
const QWEN: AiModelRef = { door: AiDoor.Local, engine: "ollama", model: "qwen3:8b" };
const CREDITS: AiModelRef = { door: AiDoor.GenexCredits, engine: "genex", model: "claude-haiku-4-5" };

const row = (model: AiModelRef, label: string, funding: AiFunding, tag: AiMenuRow["tag"] = null): AiMenuRow => ({
  model,
  label,
  shortLabel: label.replace(/^Claude /, ""),
  funding,
  tag,
  fit: null,
  ready: true,
});

const MENU: AiModelMenu = {
  game: "create:Lantern Run",
  title: "Lantern Run",
  current: HAIKU,
  usage: { funding: AiFunding.Plan, planUsedPercent: 8, resetsAt: null },
  genex: { signedIn: true, balanceCredits: 1240, recommended: HAIKU, recommendedLabel: "Claude Haiku 4.5" },
  groups: [
    {
      maker: AiMaker.Claude,
      funding: AiFunding.Plan,
      rows: [
        row(HAIKU, "Claude Haiku 4.5", AiFunding.Plan, AiModelTag.Best),
        row(SONNET, "Claude Sonnet 4.5", AiFunding.Plan, AiModelTag.Plan),
      ],
    },
    {
      maker: AiMaker.ChatGpt,
      funding: AiFunding.Plan,
      rows: [row(GPT, "GPT-5 mini", AiFunding.Plan, AiModelTag.Plan)],
    },
    { maker: AiMaker.Local, funding: AiFunding.Free, rows: [row(QWEN, "Qwen3 8B", AiFunding.Free, AiModelTag.Free)] },
  ],
  struggling: [],
  off: false,
  leaderboard: false,
  requires: AiRequirement.Ai,
};

describe("the Create pill", () => {
  it("names the model, like the chat's model button", () => {
    assert.deepEqual(pillView(MENU), { state: PillState.Model, label: "Claude Haiku 4.5", tag: null, low: false });
  });

  it("wears Free on a model on this Mac", () => {
    const view = pillView({ ...MENU, current: QWEN, usage: { funding: AiFunding.Free } });
    assert.deepEqual([view.label, view.tag], ["Qwen3 8B", "Free"]);
  });

  it("shows credits with the balance, low at or under 100", () => {
    const credits = { ...MENU, current: CREDITS };
    assert.deepEqual(pillView(credits), { state: PillState.Credits, label: "Credits", tag: "1,240", low: false });
    const low = pillView({ ...credits, genex: { ...credits.genex, balanceCredits: 38 } });
    assert.deepEqual([low.tag, low.low], ["38", true]);
  });

  it("reads AI off, a saved playtest, and Choose while nothing is set", () => {
    assert.equal(pillView({ ...MENU, off: true }).label, "AI off");
    assert.equal(pillView({ ...MENU, usage: { funding: AiFunding.Playtest } }).label, "AI · Saved playtest");
    assert.equal(pillView({ ...MENU, current: null, usage: null }).label, "AI · Choose");
    assert.equal(pillView(null).state, PillState.Loading);
  });
});

describe("the menu's top line", () => {
  it("says what the AI costs in the words of how it is paid, never per hour or per reply", () => {
    assert.equal(usageWords(MENU, MAC), "Uses your Claude plan · 8% of this 5-hour window");
    assert.equal(
      usageWords({ ...MENU, current: QWEN, usage: { funding: AiFunding.Free } }, MAC),
      "Free · runs on this Mac, works offline",
    );
    assert.equal(
      usageWords({ ...MENU, current: QWEN, usage: { funding: AiFunding.Free } }, StudioPlatform.Windows),
      "Free · runs on this computer, works offline",
    );
    assert.equal(
      usageWords(
        { ...MENU, current: CREDITS, usage: { funding: AiFunding.Credits, sessionCredits: 18, balanceCredits: 1222 } },
        MAC,
      ),
      "18 credits this session · 1,222 left",
    );
    assert.equal(
      usageWords({ ...MENU, current: GEMINI, usage: { funding: AiFunding.Key, monthMicros: 410_000 } }, MAC),
      "41¢ this month on your OpenRouter key",
    );
    assert.equal(usageWords({ ...MENU, usage: null }, MAC), null);
    for (const funding of Object.values(AiFunding)) {
      const usage =
        funding === AiFunding.Plan
          ? MENU.usage
          : funding === AiFunding.Credits
            ? { funding, sessionCredits: 1, balanceCredits: 1 }
            : funding === AiFunding.Key
              ? { funding, monthMicros: 1 }
              : { funding };
      const line = usageWords({ ...MENU, usage } as AiModelMenu, MAC) ?? "";
      assert.doesNotMatch(line, /an hour|per hour|per reply|\$\d/, line);
    }
  });
});

describe("Settings' Games list", () => {
  const base = { game: "play:p1" as const, title: "Crowns of 1444", on: true, consent: null };
  it("reads each game as the canvas does", () => {
    assert.equal(
      gameLine({
        ...base,
        model: CREDITS,
        modelLabel: "Claude Haiku 4.5",
        funding: AiFunding.Credits,
        monthMicros: 3_100_000,
      }),
      "Genex credits · 310 this month",
    );
    assert.equal(
      gameLine({ ...base, model: HAIKU, modelLabel: "Claude Haiku 4.5", funding: AiFunding.Plan, monthMicros: 0 }),
      "Claude Haiku 4.5 · your plan",
    );
    assert.equal(
      gameLine({ ...base, model: QWEN, modelLabel: "Qwen3 8B", funding: AiFunding.Free, monthMicros: 0 }),
      "Qwen3 8B · Free",
    );
    assert.equal(
      gameLine({
        ...base,
        model: GEMINI,
        modelLabel: "Gemini 2.5 Flash",
        funding: AiFunding.Key,
        monthMicros: 1_240_000,
      }),
      "Gemini 2.5 Flash · $1.24 this month",
    );
    assert.equal(
      gameLine({ ...base, on: false, model: null, modelLabel: null, funding: null, monthMicros: 0 }),
      "AI off",
    );
  });
});

const checkRow = (
  model: AiModelRef,
  label: string,
  funding: AiFunding,
  fitted: number,
  cost: AiCostLevel,
  ms: number | null,
  note: string | null = null,
) => ({
  model,
  label,
  funding,
  moments: 5,
  fitted,
  fit: fitted >= 4 ? AiCheckFit.Fits : AiCheckFit.Struggles,
  cost,
  medianLatencyMs: ms,
  note,
});

const CHECK: AiCheckResult = {
  project: "Lantern Run",
  state: AiCheckState.Done,
  moments: 24,
  progress: null,
  rows: [
    checkRow(HAIKU, "Claude Haiku 4.5", AiFunding.Plan, 5, AiCostLevel.Low, 1100),
    checkRow(GPT, "GPT-5 mini", AiFunding.Plan, 5, AiCostLevel.Low, 1600),
    checkRow(GEMINI, "Gemini 2.5 Flash", AiFunding.Key, 5, AiCostLevel.Low, 900),
    checkRow(QWEN, "Llama 3.2 3B", AiFunding.Free, 1, AiCostLevel.Free, 700, "forgot the inn’s menu in 4 of 5 moments"),
  ],
  recommended: HAIKU,
  checkedAt: "2026-10-20T18:00:00.000Z",
};

describe("the model check", () => {
  it("says what it ran on, on the creator's own models and never Genex credits", () => {
    assert.equal(
      checkIntro(CHECK, "Lantern Run", MAC),
      "Genex replayed 24 moments from your playtests on the 4 models you have: your plans, your OpenRouter key and this Mac. No Genex credits. Optional.",
    );
  });

  it("reads each state before and while it runs", () => {
    assert.equal(
      checkIntro({ ...CHECK, state: AiCheckState.Empty, rows: [] }, "Lantern Run", MAC),
      "Play Lantern Run once with AI, then check which models fit. It runs on your own models, and it’s optional.",
    );
    assert.equal(
      checkIntro({ ...CHECK, state: AiCheckState.Checking, progress: { done: 4, total: 6 } }, "Lantern Run", MAC),
      "Checking 4 of 6 models…",
    );
    assert.match(checkIntro({ ...CHECK, state: AiCheckState.Failed }, "Lantern Run", MAC), /Nothing was spent/);
  });

  it("names each model's source, fit, cost and reply time, and marks the pick Best", () => {
    const rows = checkRows(CHECK, MAC);
    assert.deepEqual(
      rows.map((view) => [view.label, view.source, view.fitText, view.cost, view.reply, view.best]),
      [
        ["Claude Haiku 4.5", "your Claude plan", "5 of 5", "$", "1.1 s", true],
        ["GPT-5 mini", "your ChatGPT plan", "5 of 5", "$", "1.6 s", false],
        ["Gemini 2.5 Flash", "OpenRouter", "5 of 5", "$", "0.9 s", false],
        ["Llama 3.2 3B", "this Mac", "1 of 5", "Free", "0.7 s", false],
      ],
    );
    assert.equal(
      strugglesLine(CHECK),
      "Llama 3.2 3B: forgot the inn’s menu in 4 of 5 moments. Players can still pick it; Genex warns them.",
    );
  });
});

const FACTS: AiPublishFacts = {
  project: "Lantern Run",
  playtested: true,
  playtestModel: HAIKU,
  check: CHECK,
  bestWith: HAIKU,
  fits: { fitted: 5, of: 6 },
  cost: AiCostLevel.Low,
  creatorShareBps: 1000,
};
const labelOf = (model: AiModelRef) => (model.model === HAIKU.model ? "Claude Haiku 4.5" : model.model);

describe("Publish's play-time AI block", () => {
  it("shows Best with, the cost for players, a leaderboard and the creator's share for a game that needs AI", () => {
    assert.deepEqual(publishAiView(FACTS, AiRequirement.Ai, labelOf), {
      bestWith: "Claude Haiku 4.5 · fits 5 of 6 models",
      action: BestWithAction.Change,
      noCheck: false,
      cost: { marks: "$", name: "Low" },
      leaderboard: true,
      share:
        "You earn 10% of the credits players spend on AI in this game. Players on their own plan or this Mac pay you nothing and cost you nothing.",
    });
  });

  it("never waits for a check: without one it names the playtest's model and offers Check models", () => {
    const view = publishAiView(
      { ...FACTS, check: null, bestWith: null, fits: null, cost: null, creatorShareBps: null },
      null,
      labelOf,
    );
    assert.deepEqual(view, {
      bestWith: "Claude Haiku 4.5 · the model you playtested",
      action: BestWithAction.Check,
      noCheck: true,
      cost: null,
      leaderboard: false,
      share: null,
    });
  });

  it("reads a free best model as free on most Macs, with no leaderboard for a game that works without AI", () => {
    const view = publishAiView({ ...FACTS, cost: AiCostLevel.Free }, AiRequirement.Optional, labelOf);
    assert.deepEqual([view.cost, view.leaderboard, view.share], [{ free: "Free on most Macs" }, false, null]);
  });

  it("shows only for a game that played with AI, and sends a choice only once one is made", () => {
    assert.equal(publishShowsAi(null), false);
    assert.equal(publishShowsAi({ ...FACTS, playtested: false, check: null }), false);
    assert.equal(publishShowsAi(FACTS), true);
    assert.equal(publishChoice(null, true), null);
    assert.deepEqual(publishChoice(AiRequirement.Ai, true), { requires: AiRequirement.Ai, leaderboard: true });
    assert.deepEqual(publishChoice(AiRequirement.Optional, true), {
      requires: AiRequirement.Optional,
      leaderboard: false,
    });
  });
});

describe("the engine Live card's AI line", () => {
  const none = { stop: null, consent: false };
  it("says nothing until the game used AI, then how it runs", () => {
    assert.equal(engineAiLine({ ...MENU, usage: null }, none, MAC), null);
    assert.equal(engineAiLine(null, none, MAC), null);
    assert.deepEqual(engineAiLine(MENU, none, MAC), {
      text: "AI · Claude plan 8%",
      choose: false,
      tone: AiLineTone.Ready,
    });
    assert.equal(
      engineAiLine({ ...MENU, current: QWEN, usage: { funding: AiFunding.Free } }, none, MAC)?.text,
      "AI · Qwen3 8B, free on this Mac",
    );
    assert.equal(engineAiLine({ ...MENU, current: CREDITS }, none, MAC)?.text, "AI · Genex credits");
    assert.equal(engineAiLine({ ...MENU, off: true }, none, MAC)?.text, "AI off");
  });

  it("puts a stop first, then a card waiting on the person with Choose", () => {
    const stop = {
      game: MENU.game,
      title: MENU.title,
      reason: AiStopReason.OutOfCredits,
      model: CREDITS,
      modelLabel: "Claude Haiku 4.5",
      alternative: null,
      alternativeLabel: null,
      resetsAt: null,
      spentCredits: null,
    };
    assert.deepEqual(engineAiLine(MENU, { stop, consent: true }, MAC), {
      text: "AI paused: you’re out of Genex credits",
      choose: false,
      tone: AiLineTone.Stopped,
    });
    assert.deepEqual(engineAiLine(MENU, { stop: null, consent: true }, MAC), {
      text: "AI is waiting for you to choose how it runs",
      choose: true,
      tone: AiLineTone.Waiting,
    });
  });
});

describe("money words", () => {
  it("shows each pack at its one checkout price, cents always in pairs", () => {
    assert.deepEqual([550, 1100, 2750, 5500, 999].map(checkoutPriceWords), ["$5.50", "$11", "$27.50", "$55", "$9.99"]);
  });

  it("reads own-key spend in cents under a dollar, then dollars", () => {
    assert.deepEqual([410_000, 1_240_000, 1_000_000].map(keySpendWords), ["41¢", "$1.24", "$1"]);
  });
});

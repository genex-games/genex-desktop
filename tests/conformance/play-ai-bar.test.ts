/**
 * The Play bar's AI pill and its overlays, as the bar's layer decides them (design v3, the `V3-*`
 * canvas boards). The pill names the model, or "Credits" with the balance, "AI · Choose" when a card
 * waits and "AI off"; its notes are worn in place of its label and fade on their own. The model menu
 * lists the person's models by maker with local models last, one tag per row, and the Genex group.
 * Main's notices keep at most one card per game: a first-use card first, then a stop card, a lapsed
 * card never shows, and a closing names the card it closes. Each card offers exactly its board's
 * two answers, a card's yes needs its first 600 ms to pass, Get credits shows genex.games' packs in
 * order with 2,500 picked, and a Report's "See what's sent" shows bounded, plain text.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AiCardKind,
  autoTopUpPatch,
  CARD_COMMIT_GATE_MS,
  cardFor,
  cardsAfter,
  commitReady,
  ConsentAction,
  consentActions,
  consentAnswer,
  defaultPack,
  GenexRowAction,
  genexRow,
  menuGroups,
  NO_CARDS,
  noteFor,
  packsShown,
  PillName,
  PillValue,
  pillView,
  placeUnder,
  REPORT_PREVIEW_CHARS,
  REPORT_PREVIEW_MOMENTS,
  reportExtras,
  reportMoments,
  sameModel,
  StopAction,
  stopActions,
  withoutConsent,
  withoutStop,
} from "../../src/renderer/play/ai-model.ts";
import { PLAY_AI_WORDS } from "../../src/renderer/words.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import {
  AiDoor,
  AiFunding,
  type AiGameKey,
  type AiModelRef,
  AiOp,
  AiProvenance,
  AiRequirement,
} from "../../src/shared/game-ai.ts";
import { AiCheckFit } from "../../src/shared/game-ai-check.ts";
import {
  AI_REPORT_WIRE_VERSION,
  type AiReportBundle,
  type AiReportCall,
  AiReportFailure,
  AiReportKind,
  AiReportReason,
  AiValidation,
} from "../../src/shared/game-ai-report.ts";
import {
  AiConsentKind,
  type AiConsentTicket,
  type AiCreditPack,
  AiMaker,
  type AiMenuRow,
  type AiModelMenu,
  AiModelTag,
  AiStopReason,
  type AiStopCard,
  GameAiNoticeKind,
} from "../../src/shared/game-ai-views.ts";
import { PLAY_AI_NOTE_MS, type PlayAiBar, PlayAiNote, PlayAiPhase } from "../../src/shared/play-bar.ts";
import { EngineId } from "../../src/shared/providers.ts";

const GAME: AiGameKey = "play:p-crowns";
const OTHER: AiGameKey = "play:p-other";
const HAIKU: AiModelRef = { door: AiDoor.PlanWatcher, engine: EngineId.ClaudeCode, model: "claude-haiku-4-5" };
const QWEN: AiModelRef = { door: AiDoor.Local, engine: EngineId.Ollama, model: "qwen3:8b" };
const CREDITS: AiModelRef = { door: AiDoor.GenexCredits, engine: "genex", model: "claude-haiku-4-5" };
const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const LATER = new Date(NOW + 60_000).toISOString();
const EARLIER = new Date(NOW - 1).toISOString();
const MAC = StudioPlatform.Mac;

const bar = (over: Partial<PlayAiBar> = {}): PlayAiBar => ({
  game: GAME,
  phase: PlayAiPhase.Ready,
  model: HAIKU,
  label: "Claude Haiku 4.5",
  shortLabel: "Haiku 4.5",
  funding: AiFunding.Plan,
  tag: AiModelTag.Best,
  balanceCredits: null,
  lowCredits: false,
  unranked: false,
  note: null,
  addedCredits: null,
  ...over,
});

const row = (model: AiModelRef, label: string, over: Partial<AiMenuRow> = {}): AiMenuRow => ({
  model,
  label,
  shortLabel: label,
  funding: AiFunding.Plan,
  tag: null,
  fit: null,
  ready: true,
  ...over,
});

const menu = (over: Partial<AiModelMenu> = {}): AiModelMenu => ({
  game: GAME,
  title: "Crowns of 1444",
  current: HAIKU,
  usage: { funding: AiFunding.Plan, planUsedPercent: 8, resetsAt: null },
  genex: { signedIn: true, balanceCredits: 1240, recommended: CREDITS, recommendedLabel: "Claude Haiku 4.5" },
  groups: [
    {
      maker: AiMaker.Local,
      funding: null,
      rows: [row(QWEN, "Qwen3 8B", { funding: AiFunding.Free, tag: AiModelTag.Free })],
    },
    {
      maker: AiMaker.Claude,
      funding: AiFunding.Plan,
      rows: [row(HAIKU, "Claude Haiku 4.5", { tag: AiModelTag.Best })],
    },
    { maker: AiMaker.ChatGpt, funding: AiFunding.Plan, rows: [] },
  ],
  struggling: [],
  off: false,
  leaderboard: false,
  requires: AiRequirement.Ai,
  ...over,
});

const ticket = (over: Partial<AiConsentTicket> = {}): AiConsentTicket => ({
  ticket: "ticket-0001",
  game: GAME,
  title: "Crowns of 1444",
  kind: AiConsentKind.Plan,
  model: HAIKU,
  modelLabel: "Claude Haiku 4.5",
  balanceCredits: 1240,
  keepForBuildingPercent: 50,
  localDownloadBytes: null,
  maxCredits: null,
  expiresAt: LATER,
  ...over,
});

const stop = (over: Partial<AiStopCard> = {}): AiStopCard => ({
  game: GAME,
  title: "Crowns of 1444",
  reason: AiStopReason.OutOfCredits,
  model: CREDITS,
  modelLabel: "Claude Haiku 4.5",
  alternative: QWEN,
  alternativeLabel: "Qwen3 8B",
  resetsAt: null,
  spentCredits: null,
  ...over,
});

describe("the AI pill", () => {
  it("names the model, or credits with the balance, and says Choose, Off and Unranked as its board does", () => {
    const table: Array<[string, PlayAiBar, Partial<ReturnType<typeof pillView>>]> = [
      ["plan model", bar(), { name: PillName.Model, value: PillValue.None, busy: false, attention: false }],
      ["free on this Mac", bar({ model: QWEN, label: "Qwen3 8B", funding: AiFunding.Free }), { value: PillValue.Free }],
      [
        "credits",
        bar({ model: CREDITS, funding: AiFunding.Credits, balanceCredits: 1240 }),
        { name: PillName.Credits, value: PillValue.Balance, balance: 1240, warn: false },
      ],
      [
        "credits, low",
        bar({ model: CREDITS, funding: AiFunding.Credits, balanceCredits: 38, lowCredits: true }),
        { name: PillName.Credits, warn: true },
      ],
      ["writing", bar({ phase: PlayAiPhase.Writing }), { name: PillName.Model, busy: true }],
      ["needs you", bar({ phase: PlayAiPhase.NeedsYou }), { name: PillName.Choose, attention: true }],
      ["leaderboard, unranked", bar({ unranked: true }), { value: PillValue.Unranked }],
      ["turned off", bar({ phase: PlayAiPhase.Off }), { name: PillName.Off, value: PillValue.None }],
      [
        "nothing set up yet",
        bar({ model: null, label: null, shortLabel: null, funding: null }),
        { name: PillName.Choose, attention: false },
      ],
    ];
    for (const [name, ai, expected] of table) {
      const view = pillView(ai);
      for (const [key, value] of Object.entries(expected))
        assert.equal(view[key as keyof typeof view], value, `${name}: ${key}`);
    }
  });

  it("keeps the narrow bar's shorter name and says the whole one to a screen reader", () => {
    const view = pillView(bar());
    assert.equal(view.label, "Claude Haiku 4.5");
    assert.equal(view.short, "Haiku 4.5");
    assert.equal(PLAY_AI_WORDS.pill.aria(view), "AI: Claude Haiku 4.5");
    assert.equal(PLAY_AI_WORDS.pill.aria(pillView(bar({ phase: PlayAiPhase.Off }))), "AI off");
    const credits = pillView(bar({ model: CREDITS, funding: AiFunding.Credits, balanceCredits: 1240 }));
    assert.equal(PLAY_AI_WORDS.pill.aria(credits), "AI: Genex credits, 1,240 left");
  });

  it("wears each note in the words of its board, the free one by where it runs", () => {
    const table: Array<[PlayAiBar, string]> = [
      [bar({ note: PlayAiNote.FirstUse }), "AI is on · Claude Haiku 4.5, your plan"],
      [
        bar({ note: PlayAiNote.FirstUse, model: QWEN, label: "Qwen3 8B", funding: AiFunding.Free }),
        "AI is on · Qwen3 8B, free on this Mac",
      ],
      [
        bar({
          note: PlayAiNote.FirstUse,
          model: { door: AiDoor.OpenCode, engine: EngineId.OpenCode, model: "big-pickle" },
          label: "Big Pickle",
          funding: AiFunding.Free,
        }),
        "AI is on · Big Pickle, free",
      ],
      [
        bar({ note: PlayAiNote.FirstUse, model: CREDITS, funding: AiFunding.Credits, balanceCredits: 1240 }),
        "AI is on · Claude Haiku 4.5, Genex credits",
      ],
      [
        bar({ note: PlayAiNote.PlanResting, model: QWEN, label: "Qwen3 8B", funding: AiFunding.Free }),
        "Your plan is resting. Switched to Qwen3 8B, free",
      ],
      [bar({ note: PlayAiNote.TurnedOff, phase: PlayAiPhase.Off }), "AI off"],
      [
        bar({ note: PlayAiNote.CreditsAdded, addedCredits: 2500, balanceCredits: 2538 }),
        "Added 2,500 credits · 2,538 now",
      ],
      [bar({ note: PlayAiNote.ReportSent }), "Report sent"],
    ];
    for (const [ai, words] of table) assert.equal(PLAY_AI_WORDS.note(ai, MAC), words);
    assert.equal(
      PLAY_AI_WORDS.note(
        bar({ note: PlayAiNote.FirstUse, model: QWEN, label: "Qwen3 8B", funding: AiFunding.Free }),
        StudioPlatform.Windows,
      ),
      "AI is on · Qwen3 8B, free on this computer",
    );
  });

  it("shows a note for its own time from when it first came, and a note main repeats shows again", () => {
    const shown = noteFor(null, bar({ note: PlayAiNote.ReportSent }), NOW);
    assert.equal(shown?.note, PlayAiNote.ReportSent);
    assert.equal(shown?.until, NOW + PLAY_AI_NOTE_MS[PlayAiNote.ReportSent]);
    assert.equal(
      noteFor(shown, bar({ note: PlayAiNote.ReportSent }), NOW + 500),
      shown,
      "the same note keeps its time",
    );
    assert.equal(noteFor(shown, bar(), NOW + 500), null, "main dropped it");
    const added = noteFor(null, bar({ note: PlayAiNote.CreditsAdded, addedCredits: 500 }), NOW);
    const more = noteFor(added, bar({ note: PlayAiNote.CreditsAdded, addedCredits: 1000 }), NOW + 100);
    assert.notEqual(more, added, "another top-up is another note");
    assert.equal(more?.until, NOW + 100 + PLAY_AI_NOTE_MS[PlayAiNote.CreditsAdded]);
  });

  it("never prints a broken count, whatever number it is handed", () => {
    const table: Array<[number, string]> = [
      [0, "0"],
      [38, "38"],
      [1240, "1,240"],
      [1_000_000, "1,000,000"],
      [-5, "0"],
      [Number.NaN, "0"],
      [Number.POSITIVE_INFINITY, "0"],
      [12.7, "12"],
    ];
    for (const [value, words] of table) assert.equal(PLAY_AI_WORDS.credits(value), words, String(value));
  });
});

describe("the model menu", () => {
  it("groups the person's models by maker with local models last, and drops an empty group", () => {
    const groups = menuGroups(menu());
    assert.deepEqual(
      groups.map((group) => group.maker),
      [AiMaker.Claude, AiMaker.Local],
    );
  });

  it("marks the model in use, whichever door names it", () => {
    assert.equal(sameModel(HAIKU, { ...HAIKU }), true);
    assert.equal(sameModel(HAIKU, { ...HAIKU, door: AiDoor.Plan }), false);
    assert.equal(sameModel(HAIKU, null), false);
    assert.equal(sameModel(null, null), false);
  });

  it("offers Genex credits with the maker's pick, sign-in when signed out, and nothing without a pick", () => {
    assert.deepEqual(genexRow(menu()), { action: GenexRowAction.Pick, model: CREDITS, current: false });
    assert.equal(genexRow(menu({ current: CREDITS })).current, true);
    const signedOut = menu({
      genex: { signedIn: false, balanceCredits: null, recommended: null, recommendedLabel: null },
    });
    assert.equal(genexRow(signedOut).action, GenexRowAction.SignIn);
    const noPick = menu({ genex: { signedIn: true, balanceCredits: 10, recommended: null, recommendedLabel: null } });
    assert.equal(genexRow(noPick).action, GenexRowAction.None);
  });

  it("tags each row once, in its board's words", () => {
    const tags: Array<[AiModelTag, string]> = [
      [AiModelTag.Best, "Best"],
      [AiModelTag.Free, "Free"],
      [AiModelTag.Plan, "plan"],
      [AiModelTag.CostLow, "$"],
      [AiModelTag.CostMedium, "$$"],
      [AiModelTag.CostHigh, "$$$"],
    ];
    for (const [tag, words] of tags) assert.equal(PLAY_AI_WORDS.menu.tags[tag], words);
    assert.equal(PLAY_AI_WORDS.menu.struggle(2), "2 more may struggle");
    assert.equal(PLAY_AI_WORDS.menu.struggle(1), "1 more may struggle");
    assert.equal(PLAY_AI_WORDS.menu.makers[AiMaker.Claude], "Claude models");
    assert.equal(PLAY_AI_WORDS.menu.makers[AiMaker.Local], "Local models");
  });

  it("says what the game's AI costs in the words of how it is paid, never per hour or per reply", () => {
    const plan = PLAY_AI_WORDS.menu.usage({ funding: AiFunding.Plan, planUsedPercent: 8, resetsAt: null }, HAIKU, MAC);
    assert.equal(plan, "Uses your Claude plan · 8% of this 5-hour window");
    const codex: AiModelRef = { door: AiDoor.PlanWatcher, engine: EngineId.Codex, model: "gpt-5-mini" };
    assert.equal(
      PLAY_AI_WORDS.menu.usage({ funding: AiFunding.Plan, planUsedPercent: 12.6, resetsAt: null }, codex, MAC),
      "Uses your ChatGPT plan · 13% of this 5-hour window",
    );
    assert.equal(
      PLAY_AI_WORDS.menu.usage({ funding: AiFunding.Free }, QWEN, MAC),
      "Free · runs on this Mac, works offline",
    );
    assert.equal(
      PLAY_AI_WORDS.menu.usage({ funding: AiFunding.Credits, sessionCredits: 18, balanceCredits: 1222 }, CREDITS, MAC),
      "18 credits this session · 1,222 left",
    );
    assert.equal(
      PLAY_AI_WORDS.menu.usage({ funding: AiFunding.Key, monthMicros: 410_000 }, null, MAC),
      "41¢ this month on your OpenRouter key",
    );
    assert.equal(
      PLAY_AI_WORDS.menu.usage({ funding: AiFunding.Key, monthMicros: 1_204_000 }, null, MAC),
      "$1.20 this month on your OpenRouter key",
    );
    assert.doesNotMatch(plan, /an hour|per reply/);
  });
});

describe("the cards main asks for", () => {
  it("keeps one card per game: a first-use card before a stop card, the newest of each", () => {
    let cards = cardsAfter(NO_CARDS, { kind: GameAiNoticeKind.Stop, card: stop() });
    assert.equal(cardFor(cards, GAME, NOW)?.kind, AiCardKind.Stop);
    cards = cardsAfter(cards, { kind: GameAiNoticeKind.Consent, consent: ticket() });
    assert.deepEqual(cardFor(cards, GAME, NOW), { kind: AiCardKind.Consent, consent: ticket() });
    const newer = ticket({ ticket: "ticket-0002", kind: AiConsentKind.Credits });
    cards = cardsAfter(cards, { kind: GameAiNoticeKind.Consent, consent: newer });
    const shown = cardFor(cards, GAME, NOW);
    assert.equal(shown?.kind === AiCardKind.Consent ? shown.consent.ticket : null, "ticket-0002");
    assert.equal(cardFor(cards, OTHER, NOW), null, "another game's cards are its own");
  });

  it("drops a card on its closing, its answer or its lapse, and ignores a closing of a card it never had", () => {
    const asked = cardsAfter(NO_CARDS, { kind: GameAiNoticeKind.Consent, consent: ticket() });
    assert.equal(
      cardFor(cardsAfter(asked, { kind: GameAiNoticeKind.ConsentClosed, ticket: "ticket-0001" }), GAME, NOW),
      null,
    );
    assert.equal(cardsAfter(asked, { kind: GameAiNoticeKind.ConsentClosed, ticket: "ticket-9999" }), asked);
    assert.equal(cardFor(withoutConsent(asked, "ticket-0001"), GAME, NOW), null);
    const lapsed = cardsAfter(NO_CARDS, { kind: GameAiNoticeKind.Consent, consent: ticket({ expiresAt: EARLIER }) });
    assert.equal(cardFor(lapsed, GAME, NOW), null);
    const stopped = cardsAfter(NO_CARDS, { kind: GameAiNoticeKind.Stop, card: stop() });
    assert.equal(cardFor(withoutStop(stopped, GAME), GAME, NOW), null);
  });

  it("counts a change so the open menu reads again, and leaves the cards alone", () => {
    const asked = cardsAfter(NO_CARDS, { kind: GameAiNoticeKind.Consent, consent: ticket() });
    const changed = cardsAfter(asked, { kind: GameAiNoticeKind.Changed, game: GAME });
    assert.equal(changed.changed, asked.changed + 1);
    assert.deepEqual(changed.consents, asked.consents);
    const check = cardsAfter(asked, { kind: GameAiNoticeKind.Check, project: "crowns", done: 1, total: 4 });
    assert.equal(check, asked, "a model check is Create's news");
  });

  it("lets a card's yes count only once its first 600 ms have passed", () => {
    assert.equal(commitReady(NOW, NOW), false);
    assert.equal(commitReady(NOW, NOW + CARD_COMMIT_GATE_MS - 1), false);
    assert.equal(commitReady(NOW, NOW + CARD_COMMIT_GATE_MS), true);
    assert.equal(CARD_COMMIT_GATE_MS, 600);
  });

  it("offers each first-use card its board's two answers", () => {
    const table: Array<[AiConsentKind, ConsentAction, ConsentAction]> = [
      [AiConsentKind.Plan, ConsentAction.Play, ConsentAction.Change],
      [AiConsentKind.Credits, ConsentAction.Play, ConsentAction.Change],
      [AiConsentKind.Key, ConsentAction.Play, ConsentAction.Change],
      [AiConsentKind.Leaderboard, ConsentAction.PlayOnCredits, ConsentAction.PlayUnranked],
      [AiConsentKind.SetUp, ConsentAction.PlayFree, ConsentAction.SignIn],
      [AiConsentKind.GenexConfirm, ConsentAction.Allow, ConsentAction.NotNow],
    ];
    for (const [kind, primary, secondary] of table)
      assert.deepEqual(consentActions(ticket({ kind })), { primary, secondary }, kind);
  });

  it("answers a card with exactly what its button means, and leaves sign-in to the bar", () => {
    const card = ticket();
    assert.deepEqual(consentAnswer(card, ConsentAction.Play), {
      ticket: card.ticket,
      approve: true,
      model: null,
      unranked: false,
    });
    assert.deepEqual(consentAnswer(card, ConsentAction.Change, QWEN), {
      ticket: card.ticket,
      approve: true,
      model: QWEN,
      unranked: false,
    });
    assert.deepEqual(consentAnswer(card, ConsentAction.PlayUnranked), {
      ticket: card.ticket,
      approve: true,
      model: null,
      unranked: true,
    });
    assert.deepEqual(consentAnswer(card, ConsentAction.NotNow), {
      ticket: card.ticket,
      approve: false,
      model: null,
      unranked: false,
    });
    assert.equal(consentAnswer(card, ConsentAction.SignIn), null);
    assert.equal(consentAnswer(card, ConsentAction.Change), null, "Change without a model opens the menu");
  });

  it("offers each stop card its board's answers, and none it cannot keep", () => {
    const table: Array<[string, AiStopCard, StopAction, StopAction | null]> = [
      ["out of credits", stop(), StopAction.GetCredits, StopAction.UseAlternative],
      [
        "out of credits, nothing free",
        stop({ alternative: null, alternativeLabel: null }),
        StopAction.GetCredits,
        StopAction.BackToPlay,
      ],
      ["plan resting", stop({ reason: AiStopReason.PlanResting }), StopAction.Ok, StopAction.Change],
      [
        "your alert",
        stop({ reason: AiStopReason.DailyAlert, spentCredits: 500 }),
        StopAction.KeepPlaying,
        StopAction.StopToday,
      ],
      ["needs AI, AI off", stop({ reason: AiStopReason.NeedsAiOff }), StopAction.TurnOn, StopAction.BackToPlay],
      ["not answering", stop({ reason: AiStopReason.NotAnswering }), StopAction.UseAnother, null],
      ["struggles", stop({ reason: AiStopReason.Struggles }), StopAction.UseAlternative, StopAction.Keep],
      [
        "struggles, no pick",
        stop({ reason: AiStopReason.Struggles, alternative: null, alternativeLabel: null }),
        StopAction.Keep,
        StopAction.Change,
      ],
    ];
    for (const [name, card, primary, secondary] of table)
      assert.deepEqual(stopActions(card), { primary, secondary }, name);
  });

  it("words the first-use and stop cards as their boards do", () => {
    const plan = PLAY_AI_WORDS.consent(ticket(), MAC);
    assert.deepEqual(plan.line, ["Crowns of 1444 will use ", "Claude Haiku 4.5", " on your Claude plan."]);
    assert.equal(plan.small, "No extra cost. Pauses before half of your 5-hour limit.");
    const credits = PLAY_AI_WORDS.consent(ticket({ kind: AiConsentKind.Credits, model: CREDITS }), MAC);
    assert.deepEqual(credits.line, ["Crowns of 1444 will use your ", "Genex credits", "."]);
    assert.equal(credits.small, "You have 1,240. You pay only for what the AI writes.");
    const setUp = PLAY_AI_WORDS.consent(
      ticket({ kind: AiConsentKind.SetUp, model: null, localDownloadBytes: Math.round(2.4 * 1024 ** 3) }),
      MAC,
    );
    assert.deepEqual(setUp.line, ["Crowns of 1444 needs AI to play."]);
    assert.match(setUp.small, /one 2\.4 GB download/);
    const board = PLAY_AI_WORDS.consent(ticket({ kind: AiConsentKind.Leaderboard, title: "Crowns Ranked" }), MAC);
    assert.deepEqual(board.line, ["Crowns Ranked keeps a ", "leaderboard", "."]);
    const words = PLAY_AI_WORDS.consent(ticket({ kind: AiConsentKind.Leaderboard }), MAC);
    assert.doesNotMatch(JSON.stringify(words), /\branked\b/i, "leaderboard, never ranked");
    const out = PLAY_AI_WORDS.stop(stop(), MAC);
    assert.deepEqual(out.line, ["You’re out of Genex credits."]);
    assert.equal(out.small, "Keep going free with Qwen3 8B on this Mac, or get more credits.");
    const resting = PLAY_AI_WORDS.stop(
      stop({ reason: AiStopReason.PlanResting, model: HAIKU, resetsAt: "2026-10-20T19:15:00.000Z" }),
      MAC,
      { timeZone: "UTC" },
    );
    assert.deepEqual(resting.line, ["Your Claude plan is resting until 7:15 PM."]);
    const alert = PLAY_AI_WORDS.stop(stop({ reason: AiStopReason.DailyAlert, spentCredits: 500 }), MAC);
    assert.deepEqual(alert.line, ["Crowns of 1444 has spent 500 credits today."]);
  });
});

describe("Get credits", () => {
  const packs: AiCreditPack[] = [
    { id: "pack_5000", credits: 5000, priceCents: 5500 },
    { id: "pack_500", credits: 500, priceCents: 550 },
    { id: "pack_2500", credits: 2500, priceCents: 2750 },
    { id: "pack_1000", credits: 1000, priceCents: 1100 },
  ];

  it("lists genex.games' packs smallest first, with 2,500 picked", () => {
    assert.deepEqual(
      packsShown(packs).map((pack) => pack.credits),
      [500, 1000, 2500, 5000],
    );
    assert.equal(defaultPack(packs), "pack_2500");
    assert.equal(defaultPack(packs.filter((pack) => pack.credits !== 2500)), "pack_500", "else the smallest");
    assert.equal(defaultPack([]), null);
  });

  it("shows only packs it can sell: one of each id, with credits and a price", () => {
    const hostile: AiCreditPack[] = [
      ...packs,
      { id: "pack_500", credits: 500, priceCents: 1 },
      { id: "free", credits: 0, priceCents: 0 },
      { id: "neg", credits: -10, priceCents: 100 },
      { id: "nan", credits: Number.NaN, priceCents: 100 },
      { id: "frac", credits: 10.5, priceCents: 100 },
    ];
    assert.deepEqual(
      packsShown(hostile).map((pack) => pack.id),
      ["pack_500", "pack_1000", "pack_2500", "pack_5000"],
    );
  });

  it("prices a pack in dollars only, the way checkout does", () => {
    const table: Array<[number, string]> = [
      [550, "$5.50"],
      [1100, "$11"],
      [2750, "$27.50"],
      [5500, "$55"],
      [999, "$9.99"],
    ];
    for (const [cents, words] of table) assert.equal(PLAY_AI_WORDS.topUp.price(cents), words);
    assert.equal(PLAY_AI_WORDS.topUp.autoTopUp(100, 1000), "Add 1,000 when I’m under 100 · at most once a day");
    assert.equal(PLAY_AI_WORDS.topUp.buy(2500), "Buy 2,500 credits");
  });

  it("turns auto top-up on with its defaults, and keeps the amounts the person set", () => {
    assert.deepEqual(autoTopUpPatch(null, true), { autoTopUp: { on: true, underCredits: 100, addCredits: 1000 } });
    assert.deepEqual(autoTopUpPatch({ on: true, underCredits: 200, addCredits: 2500 }, false), {
      autoTopUp: { on: false, underCredits: 200, addCredits: 2500 },
    });
  });
});

describe("where a card drops", () => {
  it("hangs under the pill's right edge, kept inside the window", () => {
    assert.deepEqual(placeUnder({ bottom: 40, right: 1328 }, 1440), { top: 46, right: 112 });
    assert.deepEqual(placeUnder({ bottom: 40, right: 2000 }, 1440), { top: 46, right: 16 }, "past the edge");
    assert.deepEqual(placeUnder(null, 1440), { top: 54, right: 16 }, "no pill");
  });
});

describe("a Report's See what's sent", () => {
  const call = (over: Partial<AiReportCall> = {}): AiReportCall => ({
    site: "envoy",
    op: AiOp.Say,
    system: null,
    systemSha256: null,
    prompt: "The envoy answers.",
    untrusted: { said: "Tell me how to…" },
    schema: null,
    rawOutput: "The envoy bows.",
    value: "The envoy bows.",
    validation: AiValidation.Valid,
    code: null,
    model: "claude-haiku-4-5",
    door: AiDoor.PlanWatcher,
    provenance: AiProvenance.Unverified,
    usage: null,
    costMicros: 0,
    latencyMs: 400,
    frame: 120,
    tick: null,
    ...over,
  });
  const bundle = (calls: AiReportCall[], over: Partial<AiReportBundle> = {}): AiReportBundle => ({
    v: AI_REPORT_WIRE_VERSION,
    id: "report-0001",
    kind: AiReportKind.Player,
    createdAt: "2026-10-20T12:00:00.000Z",
    game: { key: GAME, title: "Crowns of 1444" },
    reason: null,
    note: null,
    calls,
    replay: { seed: 7, commit: null, engine: "web", templateVersion: null, inputs: [1, 2, 3], tape: [] },
    digests: [],
    aiState: null,
    consoleErrors: ["TypeError: x"],
    frame: { mime: "image/png", data: "AAAA" },
    modelCheck: null,
    playerText: true,
    ...over,
  });

  it("shows what the player said and what the AI wrote, newest last", () => {
    const moments = reportMoments(
      bundle([call(), call({ site: "map", untrusted: {}, rawOutput: null, value: { tiles: 3 } })]),
    );
    assert.deepEqual(moments, [
      { site: "envoy", model: "claude-haiku-4-5", said: "Tell me how to…", wrote: "The envoy bows." },
      { site: "map", model: "claude-haiku-4-5", said: null, wrote: '{"tiles":3}' },
    ]);
  });

  it("keeps hostile text plain and bounded: no control characters, no endless lines, no endless list", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const long = "x".repeat(REPORT_PREVIEW_CHARS * 3);
    const table: Array<[string, Partial<AiReportCall>, (moment: ReturnType<typeof reportMoments>[number]) => void]> = [
      ["an endless reply", { rawOutput: long }, (m) => assert.equal(m.wrote?.length, REPORT_PREVIEW_CHARS + 1)],
      ["control characters", { rawOutput: "a\u0000b\u001b[31mc\nd" }, (m) => assert.equal(m.wrote, "ab[31mc\nd")],
      [
        "marks that turn text around",
        { rawOutput: "safe\u202Etxt.exe\u2066x" },
        (m) => assert.equal(m.wrote, "safetxt.exex"),
      ],
      [
        "a character outside the BMP at the cut",
        { rawOutput: `${"x".repeat(REPORT_PREVIEW_CHARS - 1)}😀tail` },
        (m) => assert.equal(m.wrote, `${"x".repeat(REPORT_PREVIEW_CHARS - 1)}…`),
      ],
      ["a cyclic value", { rawOutput: null, value: cyclic }, (m) => assert.equal(m.wrote, null)],
      [
        "markup stays text",
        { rawOutput: "<img src=x onerror=alert(1)>" },
        (m) => assert.equal(m.wrote, "<img src=x onerror=alert(1)>"),
      ],
      ["a value that is no JSON", { rawOutput: null, value: undefined }, (m) => assert.equal(m.wrote, null)],
      ["many player fields", { untrusted: { a: "1", b: "2" } }, (m) => assert.equal(m.said, "1 · 2")],
      [
        "no reply at all",
        { rawOutput: null, value: null, validation: AiValidation.NoReply },
        (m) => assert.equal(m.wrote, null),
      ],
    ];
    for (const [name, over, expect] of table) {
      const [moment] = reportMoments(bundle([call(over)]));
      assert.ok(moment, name);
      expect(moment);
    }
    const many = reportMoments(
      bundle(Array.from({ length: REPORT_PREVIEW_MOMENTS + 30 }, (_, at) => call({ site: `s${at}` }))),
    );
    assert.equal(many.length, REPORT_PREVIEW_MOMENTS);
    assert.equal(many.at(-1)?.site, `s${REPORT_PREVIEW_MOMENTS + 29}`, "the newest moments");
  });

  it("counts what else goes with it, and says the account isn't included", () => {
    const extras = reportExtras(bundle([call(), call()]));
    assert.deepEqual(extras, { moments: 2, inputs: 3, frame: true, consoleErrors: 1 });
    assert.match(PLAY_AI_WORDS.report.about, /Your account isn’t included\./);
    assert.equal(PLAY_AI_WORDS.report.reasons[AiReportReason.Harmful], "Harmful or dangerous");
    for (const failure of Object.values(AiReportFailure)) assert.ok(PLAY_AI_WORDS.report.failed[failure]);
  });
});

describe("a model the check marked", () => {
  it("folds struggling models under one row, counted", () => {
    const weak = row({ door: AiDoor.Local, engine: EngineId.Ollama, model: "llama3.2:3b" }, "Llama 3.2 3B", {
      fit: AiCheckFit.Struggles,
    });
    const view = menu({ struggling: [weak, weak] });
    assert.equal(PLAY_AI_WORDS.menu.struggle(view.struggling.length), "2 more may struggle");
  });
});

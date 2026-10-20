/**
 * What Create's play-time AI surfaces read across the bridge: the creator's Player report inbox
 * (D9's third destination: a report of their own published game, which Fix with agent saves as a
 * playtest the agent replays) and Publish's choice (Needs AI or Works without AI, and a
 * leaderboard). Everything here comes from genex.games or the renderer, so each reader refuses a
 * hostile value whole and keeps nothing it was not asked for.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AiAudience, AiDoor, AiOp, AiProvenance, AiRequirement } from "../../src/shared/game-ai.ts";
import { readAiPublishChoice } from "../../src/shared/game-ai-check.ts";
import {
  AI_REPORT_INBOX_MAX,
  type AiReportBundle,
  type AiReportInboxItem,
  AiReportKind,
  AiReportReason,
  AiValidation,
  inboxItemOf,
  readAiReportId,
  readAiReportInbox,
  readAiReportInboxItem,
  reportTapeName,
} from "../../src/shared/game-ai-report.ts";
import { isTapeName } from "../../src/shared/game-ai-tape.ts";

const ITEM: AiReportInboxItem = {
  id: "report-0001",
  kind: AiReportKind.Player,
  createdAt: "2026-10-20T18:00:00.000Z",
  reason: AiReportReason.Harmful,
  note: "The envoy told me how to…",
  calls: 12,
  invalid: 1,
  model: "claude-haiku-4-5",
  tape: null,
};

describe("readAiReportInboxItem", () => {
  it("takes a whole item, rebuilt", () => {
    assert.deepEqual(readAiReportInboxItem(structuredClone(ITEM)), ITEM);
    const automatic = { ...ITEM, kind: AiReportKind.Automatic, reason: null, note: null, tape: "report-0001" };
    assert.deepEqual(readAiReportInboxItem(automatic), automatic);
  });

  const hostile: Array<[string, unknown]> = [
    ["nothing", null],
    ["an array", [ITEM]],
    ["an extra key (an account)", { ...ITEM, account: "u_1" }],
    ["a missing key", Object.fromEntries(Object.entries(ITEM).filter(([key]) => key !== "tape"))],
    ["a short id", { ...ITEM, id: "r1" }],
    ["an id with a slash", { ...ITEM, id: "report/../0001" }],
    ["an unknown kind", { ...ITEM, kind: "robot" }],
    ["a player report with no reason", { ...ITEM, reason: null }],
    ["an automatic one with a reason", { ...ITEM, kind: AiReportKind.Automatic }],
    ["an unknown reason", { ...ITEM, reason: "spam" }],
    ["a time that is not ISO", { ...ITEM, createdAt: "yesterday" }],
    ["a long note", { ...ITEM, note: "x".repeat(501) }],
    ["a negative count", { ...ITEM, calls: -1 }],
    ["more invalid than calls", { ...ITEM, calls: 1, invalid: 2 }],
    ["a fractional count", { ...ITEM, calls: 1.5 }],
    ["an empty model", { ...ITEM, model: "" }],
    ["a model with a control character", { ...ITEM, model: "haiku\u0000" }],
    ["a tape that is a path", { ...ITEM, tape: "../../etc/passwd" }],
    ["a tape in capitals", { ...ITEM, tape: "Report-1" }],
    ["a prototype key", JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(ITEM).slice(1)}`)],
  ];
  for (const [what, raw] of hostile) {
    it(`refuses ${what}`, () => assert.equal(readAiReportInboxItem(raw), null));
  }
});

describe("readAiReportInbox", () => {
  it("lists the newest first, at most the cap", () => {
    const older = { ...ITEM, id: "report-0000", createdAt: "2026-10-19T08:00:00.000Z" };
    assert.deepEqual(readAiReportInbox([older, ITEM]), [ITEM, older]);
    const many = Array.from({ length: AI_REPORT_INBOX_MAX + 5 }, (_, i) => ({
      ...ITEM,
      id: `report-${String(i).padStart(4, "0")}`,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    }));
    const read = readAiReportInbox(many);
    assert.equal(read?.length, AI_REPORT_INBOX_MAX);
    assert.equal(read?.[0]?.id, `report-${String(AI_REPORT_INBOX_MAX + 4).padStart(4, "0")}`);
  });

  it("refuses the whole list for one bad item, and anything that is not a list", () => {
    assert.equal(readAiReportInbox([ITEM, { ...ITEM, kind: "robot" }]), null);
    assert.equal(readAiReportInbox({ items: [ITEM] }), null);
    assert.equal(readAiReportInbox("[]"), null);
    assert.equal(readAiReportInbox(Array.from({ length: 10_000 }, () => ITEM)), null);
  });

  it("refuses two items with the same id", () => {
    assert.equal(readAiReportInbox([ITEM, { ...ITEM }]), null);
  });
});

describe("readAiReportId", () => {
  it("takes an id as genex.games names a report", () => {
    assert.equal(readAiReportId("report-0001"), "report-0001");
    assert.equal(readAiReportId("Ab_9-xyzQ"), "Ab_9-xyzQ");
  });
  for (const raw of ["r1", "../report-0001", "report 0001", "x".repeat(101), 42, null, undefined]) {
    it(`refuses ${JSON.stringify(raw)}`, () => assert.equal(readAiReportId(raw), null));
  }
});

describe("reportTapeName", () => {
  it("names a saved playtest the harness accepts, the same for the same report", () => {
    for (const id of ["report-0001", "AbC_def-123", "x".repeat(100), "UPPERCASE_ONLY"]) {
      const name = reportTapeName(id);
      assert.ok(isTapeName(name), `${id} → ${name}`);
      assert.equal(reportTapeName(id), name);
    }
  });

  it("never names two reports' playtests alike when their ids differ only in case or length", () => {
    assert.notEqual(reportTapeName("AbcDefGh"), reportTapeName("abcdefgh"));
    assert.notEqual(reportTapeName(`${"a".repeat(60)}one`), reportTapeName(`${"a".repeat(60)}two`));
  });
});

const CALL = {
  site: "envoy.reply",
  op: AiOp.Say,
  system: null,
  systemSha256: null,
  prompt: "Answer the player's envoy.",
  untrusted: {},
  schema: null,
  rawOutput: "We accept.",
  value: "We accept.",
  validation: AiValidation.Valid,
  code: null,
  model: "claude-haiku-4-5",
  door: AiDoor.Plan,
  provenance: AiProvenance.Unverified,
  usage: null,
  costMicros: 0,
  latencyMs: 900,
  frame: 10,
  tick: null,
};

const BUNDLE: AiReportBundle = {
  v: 1,
  id: "report-0001",
  kind: AiReportKind.Player,
  createdAt: "2026-10-20T18:00:00.000Z",
  game: { key: "play:p1", title: "Crowns of 1444" },
  reason: AiReportReason.Harmful,
  note: "The envoy told me how to…",
  calls: [
    CALL,
    { ...CALL, validation: AiValidation.Invalid, model: "llama-3.2-3b" },
    { ...CALL, validation: AiValidation.NoReply, model: null, rawOutput: null, value: null },
  ],
  replay: { seed: 7, commit: null, engine: "web", templateVersion: null, inputs: [], tape: [] },
  digests: [],
  aiState: null,
  consoleErrors: [],
  frame: null,
  modelCheck: null,
  playerText: true,
};

describe("inboxItemOf", () => {
  it("sums a bundle up: its calls, those still invalid, and the last model that answered", () => {
    assert.deepEqual(inboxItemOf(BUNDLE, null), {
      id: "report-0001",
      kind: AiReportKind.Player,
      createdAt: "2026-10-20T18:00:00.000Z",
      reason: AiReportReason.Harmful,
      note: "The envoy told me how to…",
      calls: 3,
      invalid: 1,
      model: "llama-3.2-3b",
      tape: null,
    });
    assert.equal(inboxItemOf(BUNDLE, reportTapeName(BUNDLE.id)).tape, reportTapeName(BUNDLE.id));
  });

  it("is itself an item the reader takes", () => {
    const item = inboxItemOf(BUNDLE, null);
    assert.deepEqual(readAiReportInboxItem(item), item);
  });
});

describe("readAiPublishChoice", () => {
  // Flipped: the choice also names who sees the game's AI text (D6).
  it("takes what Publish chose", () => {
    const shared = { requires: AiRequirement.Ai, leaderboard: true, audience: AiAudience.Shared };
    assert.deepEqual(readAiPublishChoice(shared), shared);
    const own = { requires: AiRequirement.Optional, leaderboard: false, audience: AiAudience.Player };
    assert.deepEqual(readAiPublishChoice(own), own);
  });

  const hostile: Array<[string, unknown]> = [
    ["nothing", null],
    ["a word", "ai"],
    ["an unknown requirement", { requires: "maybe", leaderboard: false, audience: AiAudience.Player }],
    [
      "a leaderboard that is not a switch",
      { requires: AiRequirement.Ai, leaderboard: "yes", audience: AiAudience.Player },
    ],
    [
      "a price riding along",
      { requires: AiRequirement.Ai, leaderboard: false, audience: AiAudience.Player, priceCents: 1 },
    ],
    ["a missing switch", { requires: AiRequirement.Ai, audience: AiAudience.Player }],
    ["a missing audience", { requires: AiRequirement.Ai, leaderboard: false }],
    ["an unknown audience", { requires: AiRequirement.Ai, leaderboard: false, audience: "everyone" }],
    ["an array", [AiRequirement.Ai, false]],
  ];
  for (const [what, raw] of hostile) {
    it(`refuses ${what}`, () => assert.equal(readAiPublishChoice(raw), null));
  }
});

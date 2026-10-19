/**
 * A Report's replay bundle (`src/shared/game-ai-report.ts`, D9) and the vendor table (D5,
 * `src/shared/ai-vendors.ts`): a bundle that comes back from genex.games is read under hard bounds
 * and refused whole on any bad part; what leaves this Mac has keys, emails and phone numbers taken
 * out, and an automatic bundle no player text. The vendor table blocks its hosts and finds its key
 * shapes, and lets every near miss through.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AI_VENDOR_HOSTS, AiHostMatch, AiVendor, aiVendorOfHost, findAiKeys } from "../../src/shared/ai-vendors.ts";
import { AiDoor, AiOp, AiProvenance } from "../../src/shared/game-ai.ts";
import {
  AI_REPORT_MAX_CALLS,
  type AiReportBundle,
  AiReportKind,
  AiReportReason,
  AiValidation,
  readAiReportBundle,
  redactReportBundle,
  withoutPlayerText,
} from "../../src/shared/game-ai-report.ts";
import { REDACTED, redactContacts } from "../../src/shared/redact.ts";

const CALL = {
  site: "envoy.reply",
  op: AiOp.Say,
  system: "You are the envoy of Castile.",
  systemSha256: "b".repeat(64),
  prompt: "Answer the player's envoy.",
  untrusted: { said: "write to me at mira@example.com" },
  schema: null,
  rawOutput: "We accept.",
  value: "We accept.",
  validation: AiValidation.Valid,
  code: null,
  model: "claude-haiku-4-5",
  door: AiDoor.Plan,
  provenance: AiProvenance.Unverified,
  usage: { inputTokens: 120, outputTokens: 4 },
  costMicros: 0,
  latencyMs: 1100,
  frame: 480,
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
  calls: [CALL],
  replay: {
    seed: 7,
    commit: "f22eebcb",
    engine: "web",
    templateVersion: "3",
    inputs: [{ frame: 1, key: "KeyA" }],
    tape: [],
  },
  digests: [{ frame: 480, digest: "d1" }],
  aiState: { pending: 0 },
  consoleErrors: ["TypeError: x is undefined"],
  frame: { mime: "image/jpeg", data: "/9j/4AAQ" },
  modelCheck: null,
  playerText: true,
};

describe("readAiReportBundle", () => {
  it("takes a whole bundle, rebuilt", () => {
    const read = readAiReportBundle(structuredClone(BUNDLE));
    assert.deepEqual(read, BUNDLE);
  });

  const hostile: Array<[string, Partial<Record<keyof AiReportBundle, unknown>>]> = [
    ["another version", { v: 2 }],
    ["a player report with no reason", { reason: null }],
    ["an automatic one with a reason", { kind: AiReportKind.Automatic }],
    ["an unknown reason", { reason: "spam" }],
    ["a long note", { note: "x".repeat(501) }],
    ["a time that is not ISO", { createdAt: "yesterday" }],
    ["a slug for a game", { game: { key: "crowns", title: "Crowns" } }],
    ["an account riding along", { game: { key: "play:p1", title: "Crowns", account: "u_1" } }],
    ["too many calls", { calls: Array.from({ length: AI_REPORT_MAX_CALLS + 1 }, () => CALL) }],
    ["a call with an unknown door", { calls: [{ ...CALL, door: "wallet" }] }],
    ["a call with an unknown code", { calls: [{ ...CALL, code: "oops" }] }],
    ["a call with a bad hash", { calls: [{ ...CALL, systemSha256: "xyz" }] }],
    ["a call with a negative cost", { calls: [{ ...CALL, costMicros: -1 }] }],
    ["a call with an extra field", { calls: [{ ...CALL, apiKey: "sk-…" }] }],
    ["a replay with a bad tape line", { replay: { ...BUNDLE.replay, tape: [{ v: 1 }] } }],
    ["a frame that is not base64", { frame: { mime: "image/jpeg", data: "<svg onload=…>" } }],
    ["a frame of another type", { frame: { mime: "text/html", data: "AAAA" } }],
    ["a console line too long", { consoleErrors: ["x".repeat(501)] }],
    [
      "a model check row that adds up wrong",
      {
        modelCheck: {
          model: { door: "local", engine: "ollama", model: "qwen3:8b" },
          label: "Qwen3 8B",
          funding: "free",
          moments: 3,
          fitted: 4,
          fit: "fits",
          cost: "free",
          medianLatencyMs: 2800,
          note: null,
        },
      },
    ],
  ];
  for (const [what, change] of hostile) {
    it(`refuses ${what}`, () => assert.equal(readAiReportBundle({ ...structuredClone(BUNDLE), ...change }), null));
  }

  it("refuses a tree past its bounds before reading a field", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 60; i += 1) deep = [deep];
    assert.equal(readAiReportBundle({ ...structuredClone(BUNDLE), aiState: deep }), null);
  });
});

describe("what leaves this Mac", () => {
  it("redacts keys, emails and phone numbers everywhere but the frame", () => {
    const leaking = {
      ...BUNDLE,
      note: "call +1 (415) 555-0134 or key sk-ant-api03-" + "a".repeat(90),
    };
    const sent = redactReportBundle(leaking);
    assert.equal(sent.calls[0]?.untrusted.said, `write to me at ${REDACTED}`);
    assert.ok(!sent.note?.includes("555-0134"), sent.note ?? "");
    assert.ok(!sent.note?.includes("sk-ant-"), sent.note ?? "");
    assert.deepEqual(sent.frame, BUNDLE.frame);
  });

  it("strips the player's text from an automatic bundle", () => {
    const quiet = withoutPlayerText(BUNDLE);
    assert.equal(quiet.playerText, false);
    assert.equal(quiet.note, null);
    assert.deepEqual(quiet.calls[0]?.untrusted, {});
    assert.deepEqual(quiet.replay.inputs, []);
    assert.equal(quiet.calls[0]?.rawOutput, "We accept.", "what the AI wrote stays");
  });

  it("redacts contacts and leaves scores, years and times alone", () => {
    assert.equal(redactContacts("mail mira.k+games@sub.example.co.uk now"), `mail ${REDACTED} now`);
    assert.equal(redactContacts("ring 020 7946 0958"), `ring ${REDACTED}`);
    for (const plain of ["score 1444 to 12", "at 18:00 on 2026-10-20", "level 3-2-1", "v1.2.3", "@everyone"]) {
      assert.equal(redactContacts(plain), plain);
    }
  });
});

describe("the AI vendor table (D5)", () => {
  const blocked: Array<[string, AiVendor]> = [
    ["https://api.openai.com/v1/chat/completions", AiVendor.OpenAi],
    ["API.OPENAI.COM.", AiVendor.OpenAi],
    ["api.anthropic.com:443", AiVendor.Anthropic],
    ["wss://api.openai.com/v1/realtime", AiVendor.OpenAi],
    ["https://generativelanguage.googleapis.com/v1beta/models", AiVendor.Google],
    ["https://us-central1-aiplatform.googleapis.com/", AiVendor.Google],
    ["openrouter.ai", AiVendor.OpenRouter],
    ["https://api.groq.com/openai/v1", AiVendor.Groq],
    ["https://api.x.ai/v1", AiVendor.Xai],
    ["https://queue.fal.run/x", AiVendor.Fal],
    ["https://myres.openai.azure.com/openai/deployments", AiVendor.OpenAi],
  ];
  for (const [target, vendor] of blocked) it(`blocks ${target}`, () => assert.equal(aiVendorOfHost(target), vendor));

  const nearMisses = [
    "https://openai.com.evil.io/",
    "https://notopenai.com/",
    "https://api.openai.co/",
    "https://fonts.googleapis.com/css",
    "https://storage.googleapis.com/bucket/x.png",
    "https://openai.com@evil.example/",
    "https://fox.ai/",
    "https://fal.media/files/x.png",
    "https://genex.games/api/runtime",
    "http://127.0.0.1:11434/api/chat",
    "",
    "not a url at all",
  ];
  for (const target of nearMisses)
    it(`lets ${JSON.stringify(target)} through`, () => assert.equal(aiVendorOfHost(target), null));

  it("matches each row's own host, and a regional prefix only as one label", () => {
    for (const row of AI_VENDOR_HOSTS) assert.equal(aiVendorOfHost(row.host), row.vendor, row.host);
    const regional = AI_VENDOR_HOSTS.filter((row) => row.match === AiHostMatch.Regional);
    assert.ok(regional.length > 0);
    for (const row of regional) assert.equal(aiVendorOfHost(`evil.io-${row.host}`), null, row.host);
  });

  it("finds vendor keys by shape, each once, by its most specific vendor", () => {
    const anthropic = `sk-ant-api03-${"A1_-".repeat(23)}`;
    const openrouter = `sk-or-v1-${"0a".repeat(32)}`;
    const project = `sk-proj-${"Ab3".repeat(20)}`;
    const google = `AIza${"B".repeat(35)}`;
    const text = `const a="${anthropic}"; const b='${openrouter}'; k=${project} g=${google}`;
    assert.deepEqual(
      findAiKeys(text).map((hit) => hit.vendor),
      [AiVendor.Anthropic, AiVendor.OpenRouter, AiVendor.OpenAi, AiVendor.Google],
    );
    assert.equal(findAiKeys(text)[0]?.index, text.indexOf(anthropic));
  });

  const prose = [
    "Use an sk-ant- key in Settings, never in the game.",
    "sk-or-v1-short",
    "AIza is how Google keys start",
    `AIza${"B".repeat(34)}`,
    `xAIza${"B".repeat(35)}`,
    "sk-proj-",
    "gsk_tooShort",
    "task-ant-api03-xyz",
  ];
  for (const text of prose)
    it(`does not flag ${JSON.stringify(text.slice(0, 40))}`, () => assert.deepEqual(findAiKeys(text), []));
});

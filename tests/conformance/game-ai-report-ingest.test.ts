/**
 * Sending Reports and fit-from-play counts to genex.games (`main/game-ai/report-ingest.ts`): the
 * route and body the contract names, no account on either, and every answer genex.games (or the
 * network) can give read as hostile: a send is refused, too large or offline, never thrown at the
 * player. A bundle of a game genex.games does not publish, or one over the body cap, never leaves.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AI_FIT_COUNTS_ROUTE, AI_FIT_MAX_ROWS, type AiFitCountRow } from "../../src/shared/game-ai-check.ts";
import { AiDoor } from "../../src/shared/game-ai.ts";
import {
  AI_REPORT_MAX_BODY_CHARS,
  AI_REPORT_ROUTE,
  type AiReportBundle,
  AiReportFailure,
  AiReportKind,
  AiReportReason,
} from "../../src/shared/game-ai-report.ts";
import type { GalleryAnswer, GalleryRequest } from "../../src/main/play/gallery.ts";
import { genexAiIngest } from "../../src/main/game-ai/report-ingest.ts";

const BUNDLE: AiReportBundle = {
  v: 1,
  id: "report-0001",
  kind: AiReportKind.Player,
  createdAt: "2026-10-20T18:00:00.000Z",
  game: { key: "play:p1", title: "Crowns of 1444" },
  reason: AiReportReason.Harmful,
  note: null,
  calls: [],
  replay: { seed: 7, commit: null, engine: "web", templateVersion: null, inputs: [], tape: [] },
  digests: [],
  aiState: null,
  consoleErrors: [],
  frame: null,
  modelCheck: null,
  playerText: true,
};

type Sent = { route: string; init: Parameters<GalleryRequest>[1] };

/** A genex.games that answers `answer` (or throws it) and records every request. */
function api(answer: GalleryAnswer | Error) {
  const sent: Sent[] = [];
  const request: GalleryRequest = async (route, init) => {
    sent.push({ route, init });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { sent, ingest: genexAiIngest({ request }) };
}

describe("sendReport", () => {
  it("posts the bundle itself to the report route, with no account", async () => {
    const { sent, ingest } = api({ status: 201, body: { id: "srv-report-1" } });
    assert.deepEqual(await ingest.sendReport(BUNDLE), { ok: true, id: "srv-report-1" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.route, AI_REPORT_ROUTE);
    assert.equal(sent[0]?.init.method, "POST");
    assert.deepEqual(sent[0]?.init.body, BUNDLE);
    assert.equal(sent[0]?.init.token, undefined, "a Report carries no account");
  });

  const answers: Array<[string, GalleryAnswer | Error, { ok: true; id: string } | { ok: false; failure: string }]> = [
    ["a stored bundle whose id is unreadable", { status: 200, body: { id: "../../x" } }, { ok: true, id: BUNDLE.id }],
    ["a stored bundle with no body", { status: 202, body: null }, { ok: true, id: BUNDLE.id }],
    ["a body too large", { status: 413, body: null }, { ok: false, failure: AiReportFailure.TooLarge }],
    ["a refused bundle", { status: 400, body: { error: "bad" } }, { ok: false, failure: AiReportFailure.Refused }],
    ["a game it does not publish", { status: 404, body: null }, { ok: false, failure: AiReportFailure.Refused }],
    ["a limit", { status: 429, body: null }, { ok: false, failure: AiReportFailure.Offline }],
    ["an outage", { status: 503, body: null }, { ok: false, failure: AiReportFailure.Offline }],
    ["a network failure", new TypeError("fetch failed"), { ok: false, failure: AiReportFailure.Offline }],
    ["a timeout", new DOMException("timed out", "TimeoutError"), { ok: false, failure: AiReportFailure.Offline }],
    ["a redirect", { status: 302, body: null }, { ok: false, failure: AiReportFailure.Refused }],
  ];
  for (const [name, answer, outcome] of answers)
    it(`reads ${name}`, async () => {
      const { ingest } = api(answer);
      assert.deepEqual(await ingest.sendReport(BUNDLE), outcome);
    });

  it("never sends a bundle of a game in the person's library", async () => {
    const { sent, ingest } = api({ status: 201, body: { id: "srv-report-1" } });
    const outcome = await ingest.sendReport({ ...BUNDLE, game: { key: "create:Lantern Run", title: "Lantern Run" } });
    assert.deepEqual(outcome, { ok: false, failure: AiReportFailure.Refused });
    assert.equal(sent.length, 0);
  });

  it("never sends a body over the cap", async () => {
    const { sent, ingest } = api({ status: 201, body: { id: "srv-report-1" } });
    const big = { ...BUNDLE, aiState: "x".repeat(AI_REPORT_MAX_BODY_CHARS) };
    assert.deepEqual(await ingest.sendReport(big), { ok: false, failure: AiReportFailure.TooLarge });
    assert.equal(sent.length, 0);
  });
});

const ROW: AiFitCountRow = {
  game: "play:p1",
  door: AiDoor.Local,
  model: "qwen3:8b",
  week: "2026-W43",
  calls: 10,
  fitted: 8,
  invalid: 1,
};

describe("sendFitCounts", () => {
  it("posts the rows to the fit-count route, with no account", async () => {
    const { sent, ingest } = api({ status: 204, body: null });
    await ingest.sendFitCounts([ROW]);
    assert.deepEqual(sent, [{ route: AI_FIT_COUNTS_ROUTE, init: { method: "POST", body: { rows: [ROW] } } }]);
  });

  it("splits a long list into sends of at most the cap", async () => {
    const { sent, ingest } = api({ status: 204, body: null });
    const rows = Array.from({ length: AI_FIT_MAX_ROWS + 3 }, (_, i) => ({ ...ROW, model: `m${i}` }));
    await ingest.sendFitCounts(rows);
    const bodies = sent.map((one) => (one.init.body as { rows: unknown[] }).rows.length);
    assert.deepEqual(bodies, [AI_FIT_MAX_ROWS, 3]);
  });

  it("sends only published games' well-formed rows, and nothing when none is left", async () => {
    const { sent, ingest } = api({ status: 204, body: null });
    await ingest.sendFitCounts([
      { ...ROW, game: "create:Lantern Run" },
      { ...ROW, fitted: 20 },
      { ...ROW, week: "2026-W60" },
    ]);
    assert.equal(sent.length, 0);
  });

  const failures: Array<[string, GalleryAnswer | Error]> = [
    ["a refusal", { status: 400, body: null }],
    ["an outage", { status: 500, body: null }],
    ["a network failure", new TypeError("fetch failed")],
  ];
  for (const [name, answer] of failures)
    it(`throws on ${name}, so the counts are kept for the next send`, async () => {
      const { ingest } = api(answer);
      await assert.rejects(ingest.sendFitCounts([ROW]));
    });
});

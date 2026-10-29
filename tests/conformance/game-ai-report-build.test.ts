/**
 * Report bundles (D9, `main/game-ai/report.ts`): the session's AI calls, the tape a replay needs,
 * the game's own capture and the model check's row, built into one `AiReportBundle` that the
 * contract's reader (and genex.games' mirror of it) accepts. Keys, emails and phone numbers are
 * redacted wherever they are, keys of free JSON included; an automatic bundle carries no player
 * text and is sent once per failed call, a few per game an hour. Whatever the game's capture
 * answers is hostile: a part out of bounds is left out, never the whole Report.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HOUR_MS } from "../../src/shared/duration.ts";
import { AiDoor, AiErrorCode, type AiGameKey } from "../../src/shared/game-ai.ts";
import {
  AI_REPORT_CONSOLE_MAX_CHARS,
  AI_REPORT_MAX_BODY_CHARS,
  AI_REPORT_MAX_CALLS,
  AI_REPORT_MAX_CONSOLE,
  AI_REPORT_MAX_DIGESTS,
  AI_REPORT_MAX_INPUTS,
  AI_REPORT_NOTE_MAX_CHARS,
  type AiReportBundle,
  AiReportFailure,
  AiReportKind,
  AiReportReason,
  AiValidation,
  readAiReportBundle,
} from "../../src/shared/game-ai-report.ts";
import { callKey, callKeyInput } from "../../src/shared/game-ai-tape.ts";
import { REDACTED } from "../../src/shared/redact.ts";
import {
  AUTOMATIC_REPORTS_PER_HOUR,
  REPORT_MAX_GAMES,
  REPORT_SESSION_MAX_CHARS,
  type ReportCapture,
  createGameAiReports,
} from "../../src/main/game-ai/report.ts";
import { CREATE_GAME, PLAY_GAME, callerFor, heldClock, requestOf, traceOf } from "../helpers/game-ai-traces.ts";

const ANTHROPIC = `sk-ant-api03-${"A1b2C3d4".repeat(12)}`;

const CAPTURE: ReportCapture = {
  seed: 7,
  commit: "f22eebcb",
  engine: "web",
  templateVersion: "3",
  inputs: [{ frame: 1, key: "KeyA" }],
  digests: [{ frame: 480, digest: "d1" }],
  aiState: { pending: 0 },
  consoleErrors: ["TypeError: x is undefined"],
  frame: { mime: "image/jpeg", data: "/9j/4AAQ" },
};

/** A Report service whose capture answers `capture`, sends recorded and answered `outcome`. */
function reports(options: { capture?: () => Promise<Partial<ReportCapture> | null> } = {}) {
  const sent: AiReportBundle[] = [];
  const clock = heldClock();
  let ids = 0;
  const service = createGameAiReports({
    clock,
    capture: options.capture ?? (async () => CAPTURE),
    checkRow: async () => null,
    send: async (bundle) => {
      sent.push(bundle);
      return { ok: true, id: bundle.id };
    },
    newId: () => {
      ids += 1;
      return `report-${String(ids).padStart(4, "0")}`;
    },
  });
  return { service, sent, clock };
}

/** A bundle as it would cross the wire and be read back. */
const reread = (bundle: AiReportBundle) => readAiReportBundle(JSON.parse(JSON.stringify(bundle)));

describe("a Report's bundle", () => {
  it("carries the session's calls, a replayable tape and the game's capture, and reads back whole", async () => {
    const { service } = reports();
    const play = callerFor(PLAY_GAME);
    const first = traceOf();
    const again = traceOf({ request: requestOf({ prompt: first.request.prompt }) });
    const failed = traceOf({ validation: AiValidation.Invalid, code: AiErrorCode.InvalidOutput, value: null });
    for (const trace of [first, again, failed]) service.observe(play, trace);
    const bundle = await service.preview(PLAY_GAME);
    assert.ok(reread(bundle), "the contract's reader takes it");
    assert.equal(bundle.kind, AiReportKind.Player);
    assert.equal(bundle.game.key, PLAY_GAME);
    assert.equal(bundle.game.title, "Crowns of 1444");
    assert.equal(bundle.calls.length, 3);
    assert.equal(bundle.calls[0]?.system, first.request.system);
    assert.match(bundle.calls[0]?.systemSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(bundle.calls[1]?.system, null, "an unchanged system prompt is named by its hash");
    assert.equal(bundle.calls[1]?.systemSha256, bundle.calls[0]?.systemSha256);
    assert.equal(bundle.calls[2]?.validation, AiValidation.Invalid);
    const key = await callKey(callKeyInput(first.request));
    assert.deepEqual(
      bundle.replay.tape.map((line) => [line.key, line.n, line.source]),
      [
        [key, 0, AiDoor.Local],
        [key, 1, AiDoor.Local],
      ],
      "fitting answers only, each at its occurrence",
    );
    assert.deepEqual(
      { seed: bundle.replay.seed, commit: bundle.replay.commit, engine: bundle.replay.engine },
      { seed: 7, commit: "f22eebcb", engine: "web" },
    );
    assert.deepEqual(bundle.frame, CAPTURE.frame);
    assert.equal(JSON.stringify(bundle).includes("account"), false);
  });

  it("redacts keys, emails and phone numbers everywhere, keys of free JSON included", async () => {
    const { service } = reports({
      capture: async () => ({
        ...CAPTURE,
        aiState: { [ANTHROPIC]: "x", mail: "write to mira@example.com" },
        consoleErrors: [`401 for ${ANTHROPIC}`],
      }),
    });
    service.observe(
      callerFor(PLAY_GAME),
      traceOf({
        request: requestOf({
          prompt: "Call +1 (415) 555-0134 now",
          untrusted: { said: `my key is ${ANTHROPIC}` },
        }),
        rawOutput: '{"line":"mail mira@example.com"}',
        value: { line: "mail mira@example.com" },
      }),
    );
    const bundle = await service.preview(PLAY_GAME);
    const text = JSON.stringify(bundle);
    for (const secret of [ANTHROPIC, "mira@example.com", "555-0134"])
      assert.equal(text.includes(secret), false, secret);
    assert.ok(text.includes(REDACTED));
    assert.ok(reread(bundle));
  });

  it("names a site or a player field shaped like a key as redacted, and still reads back", async () => {
    const { service } = reports();
    const keyish = `sk-${"a".repeat(30)}`;
    service.observe(
      callerFor(PLAY_GAME),
      traceOf({ request: requestOf({ site: keyish, untrusted: { [keyish]: "hi", said: "hello" } }) }),
    );
    const bundle = await service.preview(PLAY_GAME);
    assert.equal(JSON.stringify(bundle).includes(keyish), false);
    assert.equal(bundle.calls[0]?.site, "redacted");
    assert.deepEqual(Object.keys(bundle.calls[0]?.untrusted ?? {}).sort(), ["redacted", "said"]);
    assert.ok(reread(bundle));
  });
});

describe("a Report's session", () => {
  it("keeps the newest calls of a long session", async () => {
    const { service } = reports();
    const play = callerFor(PLAY_GAME);
    for (let i = 0; i < AI_REPORT_MAX_CALLS + 5; i += 1)
      service.observe(play, traceOf({ request: requestOf({ prompt: `turn ${i}` }) }));
    const bundle = await service.preview(PLAY_GAME);
    assert.equal(bundle.calls.length, AI_REPORT_MAX_CALLS);
    assert.equal(bundle.calls.at(-1)?.prompt, `turn ${AI_REPORT_MAX_CALLS + 4}`);
    assert.equal(bundle.calls[0]?.prompt, "turn 5");
  });

  it("keeps a session's text under its cap, the newest calls first", async () => {
    const { service } = reports();
    const play = callerFor(PLAY_GAME);
    const big = "x".repeat(100 * 1024);
    for (let i = 0; i < AI_REPORT_MAX_CALLS; i += 1)
      service.observe(play, traceOf({ request: requestOf({ prompt: `turn ${i} ${big}` }), rawOutput: big }));
    const bundle = await service.preview(PLAY_GAME);
    assert.ok(bundle.calls.length < AI_REPORT_MAX_CALLS);
    const kept = bundle.calls.reduce((sum, call) => sum + call.prompt.length + (call.rawOutput?.length ?? 0), 0);
    assert.ok(kept <= REPORT_SESSION_MAX_CHARS);
    assert.match(bundle.calls.at(-1)?.prompt ?? "", new RegExp(`^turn ${AI_REPORT_MAX_CALLS - 1} `));
    assert.ok(JSON.stringify(bundle).length <= AI_REPORT_MAX_BODY_CHARS);
    assert.ok(reread(bundle));
  });

  it("drops the oldest calls until the bundle fits the reader's node bound", async () => {
    const { service } = reports();
    const play = callerFor(PLAY_GAME);
    const schema = { type: "array", items: { type: "integer" }, maxItems: 4000 };
    const value = Array.from({ length: 2000 }, (_, i) => i);
    for (let i = 0; i < AI_REPORT_MAX_CALLS; i += 1)
      service.observe(
        play,
        traceOf({ request: requestOf({ prompt: `turn ${i}`, schema }), value, rawOutput: JSON.stringify(value) }),
      );
    const bundle = await service.preview(PLAY_GAME);
    assert.ok(bundle.calls.length < AI_REPORT_MAX_CALLS, "the oldest calls went");
    assert.equal(bundle.calls.at(-1)?.prompt, `turn ${AI_REPORT_MAX_CALLS - 1}`);
    assert.equal(bundle.calls[0]?.system, requestOf().system, "the first call kept carries the system prompt whole");
    assert.ok(bundle.calls.slice(1).every((call) => call.system === null && call.systemSha256));
    assert.ok(reread(bundle), "the reader takes what is left");
  });

  it("keeps the sessions of the most recent games only", async () => {
    const { service } = reports();
    for (let i = 0; i <= REPORT_MAX_GAMES; i += 1) service.observe(callerFor(`play:g${i}`), traceOf());
    assert.equal((await service.preview("play:g0")).calls.length, 0, "the oldest game's session was let go");
    assert.equal((await service.preview(`play:g${REPORT_MAX_GAMES}`)).calls.length, 1);
  });

  it("keeps each game's session apart", async () => {
    const { service } = reports();
    service.observe(callerFor(PLAY_GAME), traceOf());
    const other: AiGameKey = "play:p2";
    assert.equal((await service.preview(other)).calls.length, 0);
    assert.equal((await service.preview(PLAY_GAME)).calls.length, 1);
  });
});

describe("a Report's capture is hostile", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const rows: Array<[string, Partial<ReportCapture> | null, (bundle: AiReportBundle) => void]> = [
    ["gone", null, (b) => assert.deepEqual([b.replay.engine, b.frame, b.aiState], ["web", null, null])],
    ["a cyclic state", { aiState: cyclic }, (b) => assert.equal(b.aiState, null)],
    ["a huge state", { aiState: "s".repeat(2 * 1024 * 1024) }, (b) => assert.equal(b.aiState, null)],
    [
      "too many console lines, too long",
      { consoleErrors: Array.from({ length: AI_REPORT_MAX_CONSOLE + 9 }, (_, i) => `${i} ${"e".repeat(900)}`) },
      (b) => {
        assert.equal(b.consoleErrors.length, AI_REPORT_MAX_CONSOLE);
        assert.ok(b.consoleErrors.every((line) => line.length <= AI_REPORT_CONSOLE_MAX_CHARS));
        assert.match(b.consoleErrors.at(-1) ?? "", new RegExp(`^${AI_REPORT_MAX_CONSOLE + 8} `));
      },
    ],
    [
      "console lines that are not text",
      { consoleErrors: [7, null, "ok"] as unknown as string[] },
      (b) => assert.deepEqual(b.consoleErrors, ["ok"]),
    ],
    [
      "too many digests",
      { digests: Array.from({ length: AI_REPORT_MAX_DIGESTS + 3 }, (_, i) => ({ frame: i, digest: `d${i}` })) },
      (b) => {
        assert.equal(b.digests.length, AI_REPORT_MAX_DIGESTS);
        assert.equal(b.digests.at(-1)?.frame, AI_REPORT_MAX_DIGESTS + 2);
      },
    ],
    [
      "a digest that is not one",
      {
        digests: [
          { frame: -1, digest: "d" },
          { frame: 2, digest: "y".repeat(400) },
        ],
      },
      (b) => assert.deepEqual(b.digests, []),
    ],
    [
      "too many inputs",
      { inputs: Array.from({ length: AI_REPORT_MAX_INPUTS + 2 }, (_, i) => i) },
      (b) => {
        assert.equal(b.replay.inputs.length, AI_REPORT_MAX_INPUTS);
        assert.equal(b.replay.inputs.at(-1), AI_REPORT_MAX_INPUTS + 1);
      },
    ],
    [
      "a frame in another format",
      { frame: { mime: "image/gif", data: "R0lG" } as never },
      (b) => assert.equal(b.frame, null),
    ],
    [
      "a frame that is not base64",
      { frame: { mime: "image/png", data: "<svg>" } as never },
      (b) => assert.equal(b.frame, null),
    ],
    [
      "a frame too large",
      { frame: { mime: "image/png", data: "A".repeat(2 * 1024 * 1024) } as never },
      (b) => assert.equal(b.frame, null),
    ],
    ["a seed that is not an integer", { seed: 1.5 }, (b) => assert.equal(b.replay.seed, null)],
    ["an overlong commit", { commit: "c".repeat(400) }, (b) => assert.equal(b.replay.commit, null)],
    ["an empty engine", { engine: "" }, (b) => assert.equal(b.replay.engine, "web")],
  ];
  for (const [name, capture, check] of rows)
    it(`leaves out ${name}, and the rest reads back`, async () => {
      const { service } = reports({ capture: async () => capture });
      service.observe(callerFor(PLAY_GAME), traceOf());
      const bundle = await service.preview(PLAY_GAME);
      check(bundle);
      assert.ok(reread(bundle), name);
    });

  it("builds without a capture when the game's capture throws", async () => {
    const { service } = reports({
      capture: async () => {
        throw new Error("page gone");
      },
    });
    service.observe(callerFor(PLAY_GAME), traceOf());
    const bundle = await service.preview(PLAY_GAME);
    assert.equal(bundle.calls.length, 1);
    assert.ok(reread(bundle));
  });
});

describe("sending a Report", () => {
  it("sends the player's reason and note, redacted, with player text", async () => {
    const { service, sent } = reports();
    service.observe(callerFor(PLAY_GAME), traceOf());
    const note = `${"n".repeat(AI_REPORT_NOTE_MAX_CHARS - 10)} a@b.co`;
    const outcome = await service.send({ game: PLAY_GAME, reason: AiReportReason.Hateful, note });
    assert.deepEqual(outcome, { ok: true, id: "report-0001" });
    const [bundle] = sent;
    assert.ok(bundle && reread(bundle));
    assert.equal(bundle?.reason, AiReportReason.Hateful);
    assert.equal(bundle?.playerText, true);
    assert.equal(bundle?.note?.includes("a@b.co"), false);
    assert.ok((bundle?.note?.length ?? 0) <= AI_REPORT_NOTE_MAX_CHARS, "a redaction never pushes a note over its cap");
    assert.deepEqual(bundle?.calls[0]?.untrusted, { said: "what's good tonight?" });
  });

  it("answers a send that failed as it failed", async () => {
    const service = createGameAiReports({
      clock: heldClock(),
      capture: async () => null,
      checkRow: async () => null,
      send: async () => ({ ok: false, failure: AiReportFailure.Offline }),
      newId: () => "report-0001",
    });
    assert.deepEqual(await service.send({ game: PLAY_GAME, reason: AiReportReason.Other, note: null }), {
      ok: false,
      failure: AiReportFailure.Offline,
    });
  });

  it("answers a send that threw as offline", async () => {
    const service = createGameAiReports({
      clock: heldClock(),
      capture: async () => null,
      checkRow: async () => null,
      send: async () => {
        throw new Error("socket hang up");
      },
      newId: () => "report-0001",
    });
    assert.deepEqual(await service.send({ game: PLAY_GAME, reason: AiReportReason.Other, note: null }), {
      ok: false,
      failure: AiReportFailure.Offline,
    });
  });

  it("carries the model check's row for the model the game used", async () => {
    const row = {
      model: { door: AiDoor.Local, engine: "ollama", model: "qwen3:8b" },
      label: "Qwen3 8B",
      funding: "free" as const,
      moments: 5,
      fitted: 4,
      fit: "fits" as const,
      cost: "free" as const,
      medianLatencyMs: 2800,
      note: null,
    };
    const asked: unknown[] = [];
    const service = createGameAiReports({
      clock: heldClock(),
      capture: async () => CAPTURE,
      checkRow: async (game, model) => {
        asked.push([game, model]);
        return row;
      },
      send: async (bundle) => ({ ok: true, id: bundle.id }),
      newId: () => "report-0001",
    });
    service.observe(callerFor(CREATE_GAME), traceOf());
    const bundle = await service.preview(CREATE_GAME);
    assert.deepEqual(bundle.modelCheck, row);
    assert.deepEqual(asked, [[CREATE_GAME, traceOf().model]]);
    assert.ok(reread(bundle));
  });
});

describe("automatic bundles", () => {
  const invalid = () =>
    traceOf({ validation: AiValidation.Invalid, code: AiErrorCode.InvalidOutput, value: null, rawOutput: "nope" });

  it("go once per failed call, with no player text", async () => {
    const { service, sent } = reports();
    const play = callerFor(PLAY_GAME);
    const trace = invalid();
    service.observe(play, trace);
    await service.automatic(play, trace.request.ticket);
    await service.automatic(play, trace.request.ticket);
    assert.equal(sent.length, 1);
    const [bundle] = sent;
    assert.ok(bundle && reread(bundle));
    assert.equal(bundle?.kind, AiReportKind.Automatic);
    assert.equal(bundle?.reason, null);
    assert.equal(bundle?.playerText, false);
    assert.equal(bundle?.note, null);
    assert.deepEqual(bundle?.replay.inputs, []);
    assert.ok(bundle?.calls.every((call) => Object.keys(call.untrusted).length === 0));
  });

  const never: Array<[string, (play: ReturnType<typeof callerFor>) => [ReturnType<typeof traceOf>, string]]> = [
    [
      "a call that fit",
      () => {
        const trace = traceOf();
        return [trace, trace.request.ticket];
      },
    ],
    ["a ticket the session never saw", () => [invalid(), "ticket-unknown1"]],
    [
      "a failure that was not the game's shape",
      () => {
        const trace = traceOf({ validation: AiValidation.NoReply, code: AiErrorCode.Timeout, value: null });
        return [trace, trace.request.ticket];
      },
    ],
  ];
  for (const [name, make] of never)
    it(`never go for ${name}`, async () => {
      const { service, sent } = reports();
      const play = callerFor(PLAY_GAME);
      const [trace, ticket] = make(play);
      service.observe(play, trace);
      await service.automatic(play, ticket);
      assert.equal(sent.length, 0);
    });

  it("go at most a few per game an hour", async () => {
    const { service, sent, clock } = reports();
    const play = callerFor(PLAY_GAME);
    for (let i = 0; i < AUTOMATIC_REPORTS_PER_HOUR + 2; i += 1) {
      const trace = invalid();
      service.observe(play, trace);
      await service.automatic(play, trace.request.ticket);
    }
    assert.equal(sent.length, AUTOMATIC_REPORTS_PER_HOUR);
    clock.advance(HOUR_MS);
    const later = invalid();
    service.observe(play, later);
    await service.automatic(play, later.request.ticket);
    assert.equal(sent.length, AUTOMATIC_REPORTS_PER_HOUR + 1);
  });

  it("never throw when the send fails", async () => {
    const service = createGameAiReports({
      clock: heldClock(),
      capture: async () => null,
      checkRow: async () => null,
      send: async () => {
        throw new Error("offline");
      },
      newId: () => "report-0001",
    });
    const play = callerFor(PLAY_GAME);
    const trace = invalid();
    service.observe(play, trace);
    await service.automatic(play, trace.request.ticket);
  });
});

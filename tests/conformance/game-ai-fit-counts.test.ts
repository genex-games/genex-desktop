/**
 * Fit from real play (D12's follow-up, `main/game-ai/fit-counts.ts`): with the person's usage-stats
 * consent, each reply a published game got on a model the person runs is counted as fitting the
 * game's shape or not, per (game, door, model, week) — counts only, never text — and sent to
 * genex.games now and then. Without consent nothing is counted or kept; turning it off drops what
 * waits; a failed send keeps the counts for the next one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HOUR_MS, DAY_MS } from "../../src/shared/duration.ts";
import type { AiFitCountRow } from "../../src/shared/game-ai-check.ts";
import { AiDoor, AiErrorCode } from "../../src/shared/game-ai.ts";
import { AiValidation } from "../../src/shared/game-ai-report.ts";
import { FIT_COUNTS_FILE, FIT_SEND_INTERVAL_MS, createFitCounts } from "../../src/main/game-ai/fit-counts.ts";
import { CREATE_GAME, PLAY_GAME, callerFor, heldClock, traceOf } from "../helpers/game-ai-traces.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A fit counter in a fresh folder, consent as `consent` says, sends recorded (or failed). */
async function counter(options: { consent?: boolean; fail?: boolean } = {}) {
  const dir = await tmpDir("studio-fit-counts-");
  const clock = heldClock();
  const state = { consent: options.consent ?? true, fail: options.fail ?? false };
  const sent: AiFitCountRow[][] = [];
  const make = () =>
    createFitCounts({
      clock,
      dir,
      consent: async () => state.consent,
      send: async (rows) => {
        if (state.fail) throw new Error("offline");
        sent.push([...rows]);
      },
    });
  return { dir, clock, state, sent, counts: make(), make };
}

const ROW = { game: PLAY_GAME, door: AiDoor.Local, model: "qwen3:8b", week: "2026-W43" };

describe("fit counts", () => {
  it("counts nothing and keeps nothing without consent", async () => {
    const fx = await counter({ consent: false });
    await fx.counts.record(callerFor(PLAY_GAME), traceOf());
    await fx.counts.flush(true);
    assert.deepEqual(fx.sent, []);
    await assert.rejects(readFile(path.join(fx.dir, FIT_COUNTS_FILE)), { code: "ENOENT" });
  });

  it("counts fitting, repaired and invalid replies, and a model's failures as calls only", async () => {
    const fx = await counter();
    const play = callerFor(PLAY_GAME);
    await fx.counts.record(play, traceOf());
    await fx.counts.record(play, traceOf({ validation: AiValidation.Repaired }));
    await fx.counts.record(play, traceOf({ validation: AiValidation.Invalid, code: AiErrorCode.InvalidOutput }));
    await fx.counts.record(play, traceOf({ validation: AiValidation.NoReply, code: AiErrorCode.Timeout, value: null }));
    await fx.counts.flush(true);
    assert.deepEqual(fx.sent, [[{ ...ROW, calls: 4, fitted: 2, invalid: 1 }]]);
  });

  const skipped: Array<[string, Parameters<ReturnType<typeof createFitCounts>["record"]>]> = [
    ["a game in the creator's library", [callerFor(CREATE_GAME), traceOf()]],
    ["a replayed playtest", [callerFor(PLAY_GAME, { replaying: true }), traceOf()]],
    ["a tape's answer", [callerFor(PLAY_GAME), traceOf({ door: AiDoor.Tape })]],
    ["a fixture's answer", [callerFor(PLAY_GAME), traceOf({ door: AiDoor.Fixture })]],
    ["a call that never reached a model", [callerFor(PLAY_GAME), traceOf({ model: null, servedModel: null })]],
    [
      "a canceled call",
      [callerFor(PLAY_GAME), traceOf({ validation: AiValidation.NoReply, code: AiErrorCode.Canceled })],
    ],
    [
      "a refusal before dispatch",
      [callerFor(PLAY_GAME), traceOf({ validation: AiValidation.NoReply, code: AiErrorCode.RateLimited })],
    ],
    ["an overlong model id", [callerFor(PLAY_GAME), traceOf({ servedModel: "m".repeat(151) })]],
  ];
  for (const [name, [caller, trace]] of skipped)
    it(`never counts ${name}`, async () => {
      const fx = await counter();
      await fx.counts.record(caller, trace);
      await fx.counts.flush(true);
      assert.deepEqual(fx.sent, []);
    });

  it("keeps a row per week and per model, named by the model that ran", async () => {
    const fx = await counter();
    const play = callerFor(PLAY_GAME);
    await fx.counts.record(play, traceOf());
    await fx.counts.record(play, traceOf({ servedModel: null }));
    await fx.counts.record(play, traceOf({ servedModel: "llama3.2:3b" }));
    fx.clock.advance(7 * DAY_MS);
    await fx.counts.record(play, traceOf());
    await fx.counts.flush(true);
    assert.deepEqual(fx.sent, [
      [
        { ...ROW, calls: 2, fitted: 2, invalid: 0 },
        { ...ROW, model: "llama3.2:3b", calls: 1, fitted: 1, invalid: 0 },
        { ...ROW, week: "2026-W44", calls: 1, fitted: 1, invalid: 0 },
      ],
    ]);
  });
});

describe("fit counts on their way", () => {
  it("sends only when due, and empties what it sent", async () => {
    const fx = await counter();
    const play = callerFor(PLAY_GAME);
    await fx.counts.record(play, traceOf());
    await fx.counts.flush();
    assert.equal(fx.sent.length, 1, "the first send is due at once");
    await fx.counts.record(play, traceOf());
    await fx.counts.flush();
    assert.equal(fx.sent.length, 1, "the next waits for its interval");
    fx.clock.advance(FIT_SEND_INTERVAL_MS);
    await fx.counts.record(play, traceOf());
    await fx.counts.flush();
    assert.deepEqual(fx.sent[1], [{ ...ROW, calls: 2, fitted: 2, invalid: 0 }]);
    await fx.counts.flush(true);
    assert.equal(fx.sent.length, 2, "nothing is left to send");
  });

  it("keeps the counts when a send fails, and sends them with the next", async () => {
    const fx = await counter({ fail: true });
    const play = callerFor(PLAY_GAME);
    await fx.counts.record(play, traceOf());
    await fx.counts.flush(true);
    fx.state.fail = false;
    await fx.counts.record(play, traceOf());
    await fx.counts.flush(true);
    assert.deepEqual(fx.sent, [[{ ...ROW, calls: 2, fitted: 2, invalid: 0 }]]);
  });

  it("keeps a count recorded while its send is under way", async () => {
    const dir = await tmpDir("studio-fit-counts-race-");
    const sent: AiFitCountRow[][] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const counts = createFitCounts({
      clock: heldClock(),
      dir,
      consent: async () => true,
      send: async (rows) => {
        sent.push([...rows]);
        await gate;
      },
    });
    const play = callerFor(PLAY_GAME);
    await counts.record(play, traceOf());
    const sending = counts.flush(true);
    await counts.record(play, traceOf());
    release();
    await sending;
    await counts.flush(true);
    assert.deepEqual(sent, [
      [{ ...ROW, calls: 1, fitted: 1, invalid: 0 }],
      [{ ...ROW, calls: 1, fitted: 1, invalid: 0 }],
    ]);
  });
});

describe("fit counts kept", () => {
  it("drops what waits when consent is turned off", async () => {
    const fx = await counter();
    await fx.counts.record(callerFor(PLAY_GAME), traceOf());
    fx.state.consent = false;
    await fx.counts.flush(true);
    fx.state.consent = true;
    await fx.counts.flush(true);
    assert.deepEqual(fx.sent, []);
    assert.equal(
      await readFile(path.join(fx.dir, FIT_COUNTS_FILE), "utf8").then((text) => text.includes("qwen")),
      false,
    );
  });

  it("keeps the counts across a restart, and never any text", async () => {
    const fx = await counter();
    await fx.counts.record(callerFor(PLAY_GAME), traceOf());
    const saved = await readFile(path.join(fx.dir, FIT_COUNTS_FILE), "utf8");
    for (const text of ["innkeeper", "Stew", "what's good"]) assert.equal(saved.includes(text), false, text);
    fx.clock.advance(HOUR_MS);
    await fx.make().flush(true);
    assert.deepEqual(fx.sent, [[{ ...ROW, calls: 1, fitted: 1, invalid: 0 }]]);
  });

  const files: Array<[string, string]> = [
    ["not JSON", "{"],
    ["another version", JSON.stringify({ v: 9, rows: [], lastSentAt: null })],
    ["rows that are not a list", JSON.stringify({ v: 1, rows: "x", lastSentAt: null })],
    ["a row that does not add up", JSON.stringify({ v: 1, rows: [{ ...ROW, calls: 1, fitted: 2, invalid: 0 }] })],
  ];
  for (const [name, text] of files)
    it(`starts empty from a saved file that is ${name}`, async () => {
      const fx = await counter();
      await writeFile(path.join(fx.dir, FIT_COUNTS_FILE), text);
      await fx.make().flush(true);
      assert.deepEqual(fx.sent, []);
    });
});

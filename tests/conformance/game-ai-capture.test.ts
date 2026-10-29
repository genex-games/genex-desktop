/**
 * What a Report captures of the game a person is playing (`main/game-ai/capture.ts`): `genex-ai`'s
 * status and the seed from the page's state, one frame from Studio's own capture, the console's
 * errors and the build's commit. The page's word is hostile input: a seed that is not a whole
 * number, a frame over the bundle's cap or a state with no `ai` is left out, never guessed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CAPTURE_WAIT_MS, reportCaptureOf, withinCaptureWait } from "../../src/main/game-ai/capture.ts";
import { AI_REPORT_FRAME_MAX_CHARS, AiReportImage } from "../../src/shared/game-ai-report.ts";

describe("a Report's capture", () => {
  it("takes the page's AI status and seed, a frame, the console's errors and the commit", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const capture = reportCaptureOf({
      state: { seed: 42, ai: { lane: "host", misses: 0 }, score: 3 },
      jpeg,
      consoleErrors: ["TypeError: x is undefined"],
      commit: "abc123",
      engine: "web",
    });
    assert.deepEqual(capture, {
      seed: 42,
      commit: "abc123",
      engine: "web",
      aiState: { lane: "host", misses: 0 },
      consoleErrors: ["TypeError: x is undefined"],
      frame: { mime: AiReportImage.Jpeg, data: jpeg.toString("base64") },
    });
  });

  it("leaves out what the page says out of shape, and a frame over the bundle's cap", () => {
    for (const state of [null, "state", [], { seed: 1.5 }, { seed: "7" }, { seed: Number.NaN }]) {
      const capture = reportCaptureOf({ state, jpeg: null, consoleErrors: [], commit: null, engine: "web" });
      assert.equal(capture.seed, null, JSON.stringify(state));
      assert.equal(capture.aiState, null, JSON.stringify(state));
      assert.equal(capture.frame, null);
    }
    const huge = Buffer.alloc(Math.ceil((AI_REPORT_FRAME_MAX_CHARS * 3) / 4) + 16);
    assert.equal(
      reportCaptureOf({ state: {}, jpeg: huge, consoleErrors: [], commit: null, engine: "web" }).frame,
      null,
    );
  });

  it("gives up on a page that does not answer within the wait", async () => {
    const never = new Promise<unknown>(() => {});
    const started = Date.now();
    assert.equal(await withinCaptureWait(never, 20), null);
    assert.ok(Date.now() - started < CAPTURE_WAIT_MS);
    assert.equal(await withinCaptureWait(Promise.reject(new Error("gone")), 20), null);
    assert.deepEqual(await withinCaptureWait(Promise.resolve({ a: 1 }), 20), { a: 1 });
  });
});

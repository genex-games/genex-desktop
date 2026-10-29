/**
 * What a Report captures of a game the creator plays in the Live preview
 * (`StudioCore.liveAiCapture`): the page's AI status and seed from its state, one frame, the
 * console's errors and the build's commit — of the game Live shows, and of no other.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { AiReportImage } from "../../src/shared/game-ai-report.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/** A Live view showing whatever was loaded, with a state, a frame and a console. */
function livePort() {
  return {
    async load(project: string, entry: string) {
      return `game://${project}/${entry}`;
    },
    async reload() {},
    status: () => ({ project: "pong", loadError: null, consoleErrors: [], url: null }),
    async evaluate() {
      return { via: "contract", ready: true, phase: "ready" };
    },
    async studioState() {
      return { seed: 7, ai: { lane: "host", calls: 2 } };
    },
    async screenshot() {
      return JPEG;
    },
    consoleEntries: () => [
      { at: 1, level: "error", message: "Uncaught TypeError" },
      { at: 2, level: "log", message: "turn 2" },
    ],
  };
}

describe("a Report's capture of the Live preview", () => {
  it("captures the game Live shows: its AI status, seed, frame and console errors", async () => {
    const lite = await coreLite({ preview: livePort() as never, gamesRoot: await realpath(await tmpDir("ai-live-")) });
    await lite.core.games.scaffold("pong");
    await lite.core.loadPreview({ project: "pong" });
    const capture = await lite.core.liveAiCapture("pong");
    assert.ok(capture);
    assert.equal(capture.seed, 7);
    assert.deepEqual(capture.aiState, { lane: "host", calls: 2 });
    assert.deepEqual(capture.frame, { mime: AiReportImage.Jpeg, data: JPEG.toString("base64") });
    assert.deepEqual(capture.consoleErrors, ["Uncaught TypeError"]);
    assert.equal(capture.engine, "web");
  });

  it("captures nothing of a game Live does not show", async () => {
    const lite = await coreLite({ preview: livePort() as never, gamesRoot: await realpath(await tmpDir("ai-live-")) });
    await lite.core.games.scaffold("pong");
    assert.equal(await lite.core.liveAiCapture("pong"), null, "nothing loaded yet");
    await lite.core.loadPreview({ project: "pong" });
    assert.equal(await lite.core.liveAiCapture("moss"), null);
  });
});

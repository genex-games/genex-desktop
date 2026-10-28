/**
 * Live's pace: the game draws at the display's rate while Genex is in front or an agent looks at
 * it, and at `LIVE_BACKGROUND_FPS` behind another app.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIVE_BACKGROUND_FPS, liveMaxFps } from "../../src/main/live-pace.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";
import { coreLite } from "../helpers/core-lite.ts";

describe("Live's pace", () => {
  it("is capped only behind another app with no agent looking", () => {
    for (const foreground of [false, true])
      for (const observed of [false, true]) {
        const expected = foreground || observed ? 0 : LIVE_BACKGROUND_FPS;
        assert.equal(liveMaxFps({ foreground, observed }), expected, JSON.stringify({ foreground, observed }));
      }
  });

  it("the core paces Live when Genex goes behind another app and lifts it when Genex comes back", async () => {
    const paces: number[] = [];
    const live = {
      setMaxFps: (fps: number) => void paces.push(fps),
      setAudioMuted: () => {},
      setVisible: () => {},
      setObserved: () => {},
    } as unknown as PreviewPort;
    const { core, close } = await coreLite({ preview: live });
    try {
      core.previewForeground(false);
      assert.equal(paces.at(-1), LIVE_BACKGROUND_FPS);
      core.previewForeground(true);
      assert.equal(paces.at(-1), 0);
    } finally {
      await close();
    }
  });
});

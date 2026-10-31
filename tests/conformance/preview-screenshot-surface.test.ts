/**
 * The harness's `preview.screenshot`: a caller that names no surface gets what the preview judges the
 * game lives on (`auto`), not the canvas alone, so a page's DOM is in the frame like in the builder's
 * `capture`. A caller that names one, or the older `page: true`, is answered as asked.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { CaptureSurface } from "../../src/shared/preview-contract.ts";
import { coreLite } from "../helpers/core-lite.ts";

type Shoot = (params: Record<string, unknown>) => Promise<{ surface: string | null }>;

/** A core whose Live preview records the surface each screenshot was asked for. */
async function shooting() {
  const asked: Array<{ surface?: string; page?: boolean }> = [];
  const preview = {
    async screenshot() {
      return Buffer.from("jpeg");
    },
    async screenshotWithStats(_quality: number, opts: { surface?: string; page?: boolean }) {
      asked.push(opts);
      return { jpeg: Buffer.from("jpeg"), stats: null, surface: opts.surface ?? null };
    },
  };
  const lite = await coreLite({ preview: preview as never });
  const shoot = lite.api()[HostMethod.PreviewScreenshot] as unknown as Shoot;
  return { asked, shoot };
}

describe("harness preview.screenshot's surface", () => {
  it("asks the preview to judge the surface when the caller names none", async () => {
    const { asked, shoot } = await shooting();
    const answer = await shoot({});
    assert.equal(asked[0]?.surface, CaptureSurface.Auto);
    assert.equal(answer.surface, CaptureSurface.Auto);
  });

  it("answers the surface a caller names, and `page: true` as the page", async () => {
    const { asked, shoot } = await shooting();
    await shoot({ surface: CaptureSurface.Canvas });
    await shoot({ page: true });
    await shoot({ surface: CaptureSurface.Page });
    assert.deepEqual(
      asked.map((opts) => opts.surface),
      [CaptureSurface.Canvas, CaptureSurface.Page, CaptureSurface.Page],
    );
  });
});

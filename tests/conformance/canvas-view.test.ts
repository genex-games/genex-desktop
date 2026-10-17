/**
 * The shared canvas maths — the Builds timeline and the Assets stage pan and zoom through one
 * module, so the numbers it produces are pinned here rather than read off a screenshot.
 *
 * These are the formulas that were inline in `RunGraph.tsx`: a fit centres the content in what is
 * left of the viewport once the drawer has taken its width, and a zoom about a point leaves that
 * point exactly where it was — which is the whole reason a wheel zoom feels like a map and not
 * like a slider.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clamp,
  fitView,
  keepView,
  keptView,
  zoomAt,
  type CanvasView,
} from "../../src/renderer/canvas-view.ts";

const near = (actual: number, expected: number, why: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${why}: ${actual} != ${expected}`);
};

describe("fitView", () => {
  it("reproduces the numbers the Builds canvas produced inline", () => {
    // pad 32, top 48 — the constants the timeline has always used.
    const view = fitView({ x: 0, y: 0, w: 1000, h: 600 }, { width: 1200, height: 800 });
    near(view.k, 1.136, "scale is the tighter of the two axes");
    near(view.tx, 32, "centred across");
    near(view.ty, 67.2, "centred under the header band");
  });

  it("offsets content that does not start at the origin", () => {
    const view = fitView({ x: 120, y: -40, w: 1000, h: 600 }, { width: 1200, height: 800 });
    near(view.k, 1.136, "the scale does not depend on where the content is");
    near(view.tx, 32 - 120 * 1.136, "the left edge lands in the same place");
    near(view.ty, 67.2 + 40 * 1.136, "so does the top edge");
  });

  it("keeps the drawer's width out of the fit", () => {
    const full = fitView({ x: 0, y: 0, w: 1000, h: 600 }, { width: 1200, height: 800 });
    const withDrawer = fitView({ x: 0, y: 0, w: 1000, h: 600 }, { width: 1200, height: 800 }, { reserveRight: 360 });
    assert.ok(withDrawer.k < full.k, "less room means a smaller scale");
    near(withDrawer.k, (1200 - 360 - 64) / 1000, "the width is what binds once the drawer is open");
    // Centred in the 840 px the drawer left, so nothing is drawn underneath it.
    near(withDrawer.tx, (1200 - 360 - 1000 * withDrawer.k) / 2, "centred in what is left");
  });

  it("never zooms past either limit, however small or large the content is", () => {
    const tiny = fitView({ x: 0, y: 0, w: 4, h: 4 }, { width: 1200, height: 800 });
    assert.equal(tiny.k, MAX_ZOOM);
    const huge = fitView({ x: 0, y: 0, w: 200_000, h: 200_000 }, { width: 1200, height: 800 });
    assert.equal(huge.k, MIN_ZOOM);
  });

  it("survives a viewport that has not been laid out yet", () => {
    const view = fitView({ x: 0, y: 0, w: 1000, h: 600 }, { width: 0, height: 0 });
    assert.ok(
      Number.isFinite(view.k) && Number.isFinite(view.tx) && Number.isFinite(view.ty),
      "no NaN reaches the transform",
    );
    assert.equal(view.k, MIN_ZOOM, "a viewport of nothing fits nothing");
  });
});

describe("zoomAt", () => {
  const start: CanvasView = { k: 1, tx: 25, ty: -60 };

  it("leaves the point under the cursor exactly where it was", () => {
    for (const factor of [1.2, 1 / 1.2, 2.4, 0.4]) {
      const next = zoomAt(start, factor, 400, 300);
      // The canvas point under the cursor before the zoom …
      const canvasX = (400 - start.tx) / start.k;
      const canvasY = (300 - start.ty) / start.k;
      // … is under the cursor after it.
      near(canvasX * next.k + next.tx, 400, `x held at ×${factor}`);
      near(canvasY * next.k + next.ty, 300, `y held at ×${factor}`);
    }
  });

  it("clamps, and hands back the same view when it is already at the limit", () => {
    const zoomedOut = zoomAt(start, 0.0001, 400, 300);
    assert.equal(zoomedOut.k, MIN_ZOOM);
    assert.equal(zoomAt(zoomedOut, 0.5, 400, 300), zoomedOut, "no further zoom out, and no pointless re-render");
    const zoomedIn = zoomAt(start, 1000, 400, 300);
    assert.equal(zoomedIn.k, MAX_ZOOM);
    assert.equal(zoomAt(zoomedIn, 2, 400, 300), zoomedIn, "nor further in");
  });
});

describe("clamp", () => {
  it("is the one the zoom limits are written with", () => {
    assert.equal(clamp(5, 0, 1), 1);
    assert.equal(clamp(-5, 0, 1), 0);
    assert.equal(clamp(0.5, 0, 1), 0.5);
  });
});

describe("a canvas's camera across a tab switch", () => {
  it("comes back as the user left it, per canvas, and is forgotten when there is nothing of theirs to keep", () => {
    const moved: CanvasView = { k: 1.44, tx: -120, ty: 36 };
    keepView("assets\nlantern", moved);
    assert.deepEqual(keptView("assets\nlantern"), moved);
    assert.equal(keptView("assets\nharbor"), null, "another canvas starts fresh");
    keepView("assets\nlantern", null);
    assert.equal(keptView("assets\nlantern"), null);
  });

  it("keeps only the most recent canvases", () => {
    for (let i = 0; i < 200; i++) keepView(`run ${i}`, { k: 1, tx: i, ty: 0 });
    assert.equal(keptView("run 0"), null);
    assert.equal(keptView("run 199")?.tx, 199);
  });
});

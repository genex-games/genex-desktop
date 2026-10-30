/**
 * Before and after on the Builds graph: the compare shows only two pictures of the same frame — a
 * build's health-check screenshot and the build's before it, or two versions of one asset seen from
 * the same view — and only when the pixels measurably changed. Otherwise the card says plainly that
 * the picture did not visibly change. Nobody asks an agent: the pixels are measured.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssetInfo } from "../../src/renderer/run-graph.ts";
import { AssetCardState, earlierVersion } from "../../src/renderer/run-graph-assets.ts";
import { type BuildCard, BuildOutcome, buildBefore } from "../../src/renderer/run-graph-builds.ts";
import { changedShare, PairView, pairView, UNCHANGED_SHARE } from "../../src/renderer/run-graph-pictures.ts";

const W = 160;
const H = 90;

/** A frame of one colour, as a canvas hands its pixels: RGBA. */
function frame(rgb: [number, number, number]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let at = 0; at < pixels.length; at += 4) pixels.set([...rgb, 255], at);
  return pixels;
}

/** `base` with a square of `side` pixels painted another colour at its top left. */
function withSquare(base: Uint8ClampedArray, side: number, rgb: [number, number, number]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(base);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) pixels.set([...rgb, 255], (y * W + x) * 4);
  return pixels;
}

/** `base` with every channel moved by `by`: what saving the same frame as a JPEG twice does. */
function noisy(base: Uint8ClampedArray, by: number): Uint8ClampedArray {
  return base.map((value, at) => (at % 4 === 3 ? value : Math.min(255, value + ((at / 4) % 2 ? by : -by))));
}

describe("whether a picture changed", () => {
  const sky = frame([120, 160, 220]);

  it("measures the share of pixels that changed past compression noise", () => {
    assert.equal(changedShare(sky, sky), 0);
    assert.equal(changedShare(sky, noisy(sky, 12)), 0, "re-encoding the same frame changes nothing visible");
    const coin = withSquare(sky, 6, [250, 210, 40]);
    assert.equal(changedShare(sky, coin), 36 / (W * H));
    assert.ok(changedShare(sky, coin) >= UNCHANGED_SHARE, "a small coin on screen is a change");
    assert.equal(changedShare(sky, frame([0, 0, 0]).subarray(0, 4)), 1, "frames of different sizes");
  });

  it("shows the compare only for two pictures that measurably differ, else says it did not visibly change", () => {
    assert.equal(pairView("/a.jpg", "/b.jpg", undefined), PairView.Single, "not measured yet: no handle");
    assert.equal(pairView("/a.jpg", "/b.jpg", null), PairView.Single, "unreadable: no handle");
    assert.equal(pairView("/a.jpg", "/b.jpg", 0), PairView.Unchanged, "a sound-only merge");
    assert.equal(pairView("/a.jpg", "/b.jpg", UNCHANGED_SHARE / 2), PairView.Unchanged);
    assert.equal(pairView("/a.jpg", "/b.jpg", UNCHANGED_SHARE), PairView.Compare);
    assert.equal(pairView(null, "/b.jpg", 1), PairView.Single, "nothing to compare with");
    assert.equal(pairView("/a.jpg", "/a.jpg", 0), PairView.Single, "one picture is no pair");
  });
});

describe("which pictures may pair", () => {
  const build = (n: number, picture: string | null): BuildCard => ({
    id: `build:${n}`,
    n,
    head: String(n).repeat(40),
    outcome: BuildOutcome.Passed,
    problems: [],
    findings: [],
    picture,
    worker: null,
    seq: n,
  });

  it("a build's screenshot pairs only with the build's before it, both taken by its health check", () => {
    const builds = [build(1, "/runs/r/director/merge_w1.jpg"), build(2, "/runs/r/director/merge_w2.jpg")];
    assert.equal(buildBefore(builds, builds[1] as BuildCard)?.n, 1);
    assert.equal(buildBefore(builds, builds[0] as BuildCard), null, "the first build has none before it");
    const unpictured = [build(1, null), build(2, "/b.jpg"), build(3, "/c.jpg")];
    assert.equal(buildBefore(unpictured, unpictured[1] as BuildCard), null, "no screenshot before it: no pair");
    assert.equal(buildBefore(unpictured, unpictured[2] as BuildCard)?.n, 2);
  });

  const delivered = (over: Partial<AssetInfo>): AssetInfo =>
    ({
      name: "shop sign",
      file: null,
      bytes: 1,
      render: null,
      renderFront: null,
      facetId: "pool.w3",
      iteration: null,
      ok: true,
      error: null,
      polygons: null,
      triangles: null,
      at: "2026-01-01T09:00:00.000Z",
      source: "genex",
      pluginName: "Genex",
      callId: null,
      jobId: "job-a",
      state: AssetCardState.Delivered,
      files: ["assets/genex/shop-sign.png"],
      args: "",
      prompt: null,
      operation: null,
      tool: "image",
      picture: "/runs/r/deliveries/job-a.png",
      ...over,
    }) as AssetInfo;

  it("an asset's picture pairs with its own earlier version seen from the same view, never another asset's", () => {
    const first = delivered({});
    const again = delivered({
      jobId: "job-b",
      at: "2026-01-01T09:05:00.000Z",
      picture: "/runs/r/deliveries/job-b.png",
    });
    const other = delivered({
      jobId: "job-c",
      name: "tyre",
      files: ["assets/genex/tyre.png"],
      at: "2026-01-01T09:06:00.000Z",
      picture: "/runs/r/deliveries/job-c.png",
    });
    const jobs = [first, again, other];
    assert.equal(earlierVersion(jobs, again), first, "the same file delivered again");
    assert.equal(earlierVersion(jobs, first), null, "the first version has none before it");
    assert.equal(earlierVersion(jobs, other), null, "another asset is no earlier version");

    const car = (jobId: string, view: string, at: string) =>
      delivered({
        jobId,
        name: "rival car",
        source: "blender",
        tool: "model",
        at,
        files: [`assets/blender/${jobId}/model.glb`, `assets/blender/${jobId}/${view}`],
        picture: `/runs/r/deliveries/${jobId}.png`,
      });
    const front = car("job-1", "render-front.png", "2026-01-01T09:00:00.000Z");
    const remade = car("job-2", "render-front.png", "2026-01-01T09:10:00.000Z");
    const side = car("job-3", "render-side.png", "2026-01-01T09:20:00.000Z");
    assert.equal(earlierVersion([front, remade], remade), front, "the same asset remade, the same view");
    assert.equal(earlierVersion([front, side], side), null, "another view of it is no pair");
    const unpictured = delivered({ jobId: "job-d", at: "2026-01-01T09:30:00.000Z", picture: undefined });
    assert.equal(earlierVersion([first, unpictured], unpictured), null, "no picture of its own: nothing to compare");
  });
});

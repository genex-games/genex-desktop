/**
 * The build health check, driven through the same FakePreview the rig uses: the page loads, it
 * threw nothing it did not catch, and its frame is not blank. The game is never stepped or asked
 * about itself.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HealthFinding } from "../../src/shared/preview-contract.ts";
import { observeBuild } from "../../src/substrate/build-probe.ts";
import { makeFakePreview } from "../helpers/studio-rig.ts";

/** A frame with real contrast: something is drawn. */
const LIT = { width: 800, height: 600, sampled: 480_000, meanLuma: 42, litFraction: 0.6, contrast: 30, canvas: true };

describe("build health", () => {
  it("passes a page that loaded, threw nothing and drew something", async () => {
    const preview = makeFakePreview();
    preview.pixelStatsNext = LIT;
    const observation = await observeBuild(preview);
    assert.equal(observation.ok, true, observation.reasons.join("; "));
    assert.deepEqual(observation.reasons, []);
    assert.equal(observation.pixels?.litFraction, 0.6);
  });

  it("never steps the page or reads the game's state, and photographs the page", async () => {
    const preview = makeFakePreview();
    preview.pixelStatsNext = LIT;
    await observeBuild(preview);
    assert.deepEqual(
      preview.calls.map((call) => call.method),
      ["errors", "state"],
      "only the shim's own records are read: its error record and its clock",
    );
    assert.deepEqual(preview.stateOpts, [], "the game's state is never read");
    assert.equal(preview.captureOpts.at(-1)?.surface, "page");
  });

  it("fails a page that did not load", async () => {
    const preview = makeFakePreview();
    preview.pixelStatsNext = LIT;
    preview.next = { ...preview.next, __loadError: "net::ERR_FILE_NOT_FOUND" };
    const observation = await observeBuild(preview);
    assert.equal(observation.ok, false);
    assert.match(observation.reasons.join("; "), /did not load: net::ERR_FILE_NOT_FOUND/);
  });

  it("fails a page that threw an error it did not catch, and names it", async () => {
    const preview = makeFakePreview();
    preview.pixelStatsNext = LIT;
    preview.studioMethods.errors = () => ({ count: 2, messages: ["TypeError: player is undefined"] });
    const observation = await observeBuild(preview);
    assert.equal(observation.ok, false);
    assert.match(observation.reasons.join("; "), /2 uncaught errors.*TypeError: player is undefined/);
  });

  it("fails a blank frame, black or any one flat colour", async () => {
    for (const flat of [
      { ...LIT, meanLuma: 0, litFraction: 0, contrast: 0 },
      { ...LIT, meanLuma: 255, litFraction: 1, contrast: 0 },
      { ...LIT, meanLuma: 120, litFraction: 1, contrast: 0.4 },
    ]) {
      const preview = makeFakePreview();
      preview.pixelStatsNext = flat;
      const observation = await observeBuild(preview);
      assert.equal(observation.ok, false, JSON.stringify(flat));
      assert.match(observation.reasons.join("; "), /blank/);
    }
  });

  it("names what it found as codes beside its words, one per reason", async () => {
    const passed = makeFakePreview();
    passed.pixelStatsNext = LIT;
    assert.deepEqual((await observeBuild(passed)).findings, []);
    const blank = makeFakePreview();
    blank.pixelStatsNext = { ...LIT, meanLuma: 0, litFraction: 0, contrast: 0 };
    assert.deepEqual((await observeBuild(blank)).findings, [HealthFinding.Blank]);
    const broken = makeFakePreview();
    broken.pixelStatsNext = { ...LIT, meanLuma: 0, litFraction: 0, contrast: 0 };
    broken.next = { ...broken.next, __loadError: "net::ERR_FILE_NOT_FOUND" };
    broken.studioMethods.errors = () => ({ count: 1, messages: ["TypeError: x"] });
    const observation = await observeBuild(broken);
    assert.deepEqual(observation.findings, [HealthFinding.NotLoaded, HealthFinding.Uncaught, HealthFinding.Blank]);
    assert.equal(observation.findings?.length, observation.reasons.length);
  });

  it("judges a frame with no contrast measure by its light alone", async () => {
    const dark = makeFakePreview();
    dark.pixelStatsNext = { width: 800, height: 600, sampled: 480_000, meanLuma: 1, litFraction: 0.001, canvas: true };
    assert.equal((await observeBuild(dark)).ok, false);
    const lit = makeFakePreview();
    lit.pixelStatsNext = { width: 800, height: 600, sampled: 480_000, meanLuma: 42, litFraction: 0.6, canvas: true };
    assert.equal((await observeBuild(lit)).ok, true);
  });

  it("passes without a pixel verdict when the preview cannot capture stats", async () => {
    const preview = makeFakePreview();
    delete preview.screenshotWithStats;
    const observation = await observeBuild(preview);
    assert.equal(observation.ok, true);
    assert.equal(observation.pixels, null);
  });
});

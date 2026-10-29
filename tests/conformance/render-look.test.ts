/**
 * The engine's look facts and exposure telemetry (`shared/render-look.ts`): the fixture the Rust
 * side also writes (`tests/fixtures/render-look-v1.json`, held by genex's `look_facts` tests) is
 * accepted and copied field by field, and a value outside the shape is refused whole.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  EXPOSURE_TELEMETRY_BINS,
  ExposureWarning,
  parseExposureTelemetry,
  parseExposureTrace,
  parseRenderLookFacts,
  RENDER_LOOK_VERSION,
} from "../../src/shared/render-look.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/render-look-v1.json", import.meta.url), "utf8"));

describe("render look facts", () => {
  it("accepts the fixture and copies only its fields", () => {
    const parsed = parseRenderLookFacts({ ...fixture.look, extra: 1 });
    assert.deepEqual(parsed, fixture.look);
    assert.equal(parsed?.version, RENDER_LOOK_VERSION);
    const tagged = parseRenderLookFacts({
      ...fixture.look,
      tags: { bench: { ...fixture.look.tags.bench, junk: true } },
    });
    assert.deepEqual(tagged?.tags.bench, fixture.look.tags.bench);
  });

  it("refuses a value outside the shape whole", () => {
    const bench = fixture.look.tags.bench;
    const hostile: unknown[] = [
      null,
      [],
      { ...fixture.look, version: 2 },
      { ...fixture.look, grid: [160] },
      { ...fixture.look, grid: [0, 90] },
      { ...fixture.look, coverage: 1.5 },
      { ...fixture.look, flatCoverage: Number.NaN },
      { ...fixture.look, tags: [] },
      { ...fixture.look, tags: { bench: { ...bench, coverage: -0.1 } } },
      { ...fixture.look, tags: { bench: { ...bench, texelsPerMetre: -1 } } },
      { ...fixture.look, tags: { bench: { ...bench, pixelsPerMetre: Number.POSITIVE_INFINITY } } },
      { ...fixture.look, tags: { bench: { ...bench, draws: 1.5 } } },
      { ...fixture.look, tags: { bench: { ...bench, alphaCardShare: "0" } } },
      { ...fixture.look, tags: { bench: { ...bench, models: "a.glb" } } },
      { ...fixture.look, tags: { bench: { ...bench, models: [1] } } },
      { ...fixture.look, tags: { bench: { ...bench, primitiveOnly: undefined } } },
      { ...fixture.look, tags: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`t${i}`, bench])) },
    ];
    for (const value of hostile) assert.equal(parseRenderLookFacts(value), null, JSON.stringify(value)?.slice(0, 80));
  });
});

describe("exposure telemetry", () => {
  it("accepts the fixture, a manual frame and every warning", () => {
    assert.deepEqual(parseExposureTelemetry(fixture.exposure), fixture.exposure);
    assert.equal(fixture.exposure.histogram.length, EXPOSURE_TELEMETRY_BINS);
    const manual = {
      ...fixture.exposure,
      mode: "manual",
      meteredEv: null,
      targetEv: null,
      histogram: [],
      warnings: Object.values(ExposureWarning),
    };
    assert.deepEqual(parseExposureTelemetry(manual), manual);
  });

  it("refuses a value outside the shape whole", () => {
    const hostile: unknown[] = [
      undefined,
      { ...fixture.exposure, version: 0 },
      { ...fixture.exposure, mode: "aperture" },
      { ...fixture.exposure, meteredEv: "1" },
      { ...fixture.exposure, appliedEv: Number.NaN },
      { ...fixture.exposure, histogram: [1, 0] },
      { ...fixture.exposure, histogram: Array(EXPOSURE_TELEMETRY_BINS).fill(2) },
      { ...fixture.exposure, histogramEv: [-8] },
      { ...fixture.exposure, doorwayBoost: 1 },
      { ...fixture.exposure, ageFrames: -1 },
      { ...fixture.exposure, warnings: ["too dark"] },
    ];
    for (const value of hostile) assert.equal(parseExposureTelemetry(value), null, JSON.stringify(value)?.slice(0, 80));
  });
});

describe("exposure trace", () => {
  it("accepts the fixture's points and refuses a malformed one whole", () => {
    assert.deepEqual(parseExposureTrace(fixture.exposureTrace), fixture.exposureTrace);
    assert.deepEqual(parseExposureTrace([]), []);
    for (const value of [
      null,
      {},
      [{ t: 1, appliedEv: "x", meteredEv: null }],
      [{ t: Number.NaN, appliedEv: 0, meteredEv: 0 }],
      Array(601).fill({ t: 0, appliedEv: 0, meteredEv: null }),
    ]) {
      assert.equal(parseExposureTrace(value), null);
    }
  });
});

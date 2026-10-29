/**
 * The AA+ release gate's suite, signals, rubric and report: the committed suite validates and
 * versions each prompt alone; comfort and doorway metrics recover known synthetic motion; each
 * floor moves the grade on one fact; reconstructed facts fail but never certify; and the gate needs
 * three different current briefs at AA+.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FactSource, parseEvidence, PropOrigin } from "../../scripts/evals/aaa/evidence.ts";
import { buildReport, gradePrompt, releaseGate, renderReportMarkdown } from "../../scripts/evals/aaa/report.ts";
import { AaaFloor, AaaGrade, rubricChecks, type TasteSummary } from "../../scripts/evals/aaa/rubric.ts";
import { comfortMetrics, exposureMetrics } from "../../scripts/evals/aaa/signals.ts";
import { AaaSuiteError, parseAaaSuite, readAaaSuite } from "../../scripts/evals/aaa/suite.ts";
import { CheckResult } from "../../scripts/evals/vocabulary.ts";
import { evRamp, PASSING_CONTEXT, passingEvidence, rawPrompt, sineTrack, testSuite } from "../helpers/aaa-evidence.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const TASTE_AA_PLUS: TasteSummary = { grade: AaaGrade.AaPlus, sameFamily: false, detail: [] };
const TASTE_AAA: TasteSummary = { grade: AaaGrade.AaaIsh, sameFamily: false, detail: [] };
const [PROMPT] = testSuite();
if (!PROMPT) throw new Error("test suite is empty");

const grade = (evidence = passingEvidence(PROMPT), taste: TasteSummary | null = TASTE_AA_PLUS) =>
  gradePrompt(PROMPT, evidence, { summary: taste, missing: [] }, PASSING_CONTEXT);
const checkOf = (floor: AaaFloor, evidence = passingEvidence(PROMPT), taste: TasteSummary | null = TASTE_AA_PLUS) =>
  rubricChecks(PROMPT, evidence, taste).filter((c) => c.floor === floor);

describe("the committed AA+ suite", () => {
  it("validates, holds six to eight prompts with references for real view roles, and versions each", () => {
    const prompts = readAaaSuite(REPO);
    assert.ok(prompts.length >= 6 && prompts.length <= 8);
    for (const p of prompts) {
      assert.match(p.version, /^[0-9a-f]{12}$/);
      const roles = new Set(p.views.map((v) => v.role));
      assert.ok(
        p.references.every((r) => roles.has(r.matches)),
        p.id,
      );
    }
    assert.equal(new Set(prompts.map((p) => p.version)).size, prompts.length);
  });

  it("keeps a prompt's version when another prompt changes", () => {
    const before = testSuite(rawPrompt("alpha"), rawPrompt("beta"), rawPrompt("gamma"));
    const after = testSuite(rawPrompt("alpha"), rawPrompt("beta", { label: "renamed" }), rawPrompt("gamma"));
    assert.equal(before[0]?.version, after[0]?.version);
    assert.notEqual(before[1]?.version, after[1]?.version);
  });

  const refusals: Array<[string, Record<string, unknown>, string]> = [
    ["an unknown look", { look: "moody" }, "look"],
    ["a view role in camel case", { views: [{ role: "heroShot", setting: "interior", describe: "x" }] }, "views.role"],
    ["no motion demo", { motion: [] }, "motion"],
    [
      "a reference for a role it lacks",
      { references: [{ source: "polyhaven", asset: "a", matches: "vista", yawDeg: [0] }] },
      "references.matches",
    ],
    [
      "an unlisted reference source",
      { references: [{ source: "unsplash", asset: "a", matches: "interior-hero", yawDeg: [0] }] },
      "references.source",
    ],
    [
      "an asset id with a path in it",
      { references: [{ source: "polyhaven", asset: "../x", matches: "interior-hero", yawDeg: [0] }] },
      "references.asset",
    ],
    [
      "a yaw out of range",
      { references: [{ source: "polyhaven", asset: "a", matches: "interior-hero", yawDeg: [360] }] },
      "references.yawDeg",
    ],
  ];
  for (const [name, override, field] of refusals)
    it(`refuses ${name}, naming the prompt and field`, () => {
      const prompts = [rawPrompt("alpha", override), rawPrompt("beta"), rawPrompt("gamma")];
      assert.throws(
        () => parseAaaSuite({ schema: "genex-aaa-suite/1", prompts }),
        (error) => error instanceof AaaSuiteError && error.promptId === "alpha" && error.field === field,
      );
    });

  it("refuses fewer than three prompts and duplicate ids", () => {
    const parse =
      (...prompts: unknown[]) =>
      () =>
        parseAaaSuite({ schema: "genex-aaa-suite/1", prompts });
    assert.throws(parse(rawPrompt("alpha"), rawPrompt("beta")), AaaSuiteError);
    assert.throws(parse(rawPrompt("alpha"), rawPrompt("alpha"), rawPrompt("beta")), AaaSuiteError);
  });
});

describe("comfort and doorway signals", () => {
  it("recovers the gen3 sprint's bob, frequency and roll from a per-tick track", () => {
    const m = comfortMetrics(sineTrack({ bobP2pM: 0.089, bobHz: 7.5, rollAmpDeg: 5.8, rollHz: 3.7 }));
    assert.ok(Math.abs(m.bobPeakToPeakM - 0.089) < 0.002, String(m.bobPeakToPeakM));
    assert.equal(m.dominantBobHz, 7.5);
    assert.ok(Math.abs(m.rollAmplitudeDeg - 5.8) < 0.05);
    assert.ok(Math.abs(m.maxAbsRollDeg - 5.8) < 0.05);
  });

  it("puts a 9 Hz shake above the high-frequency share and a 2 Hz sway below it", () => {
    const shaky = comfortMetrics(sineTrack({ bobP2pM: 0.01, bobHz: 2, rollAmpDeg: 1, rollHz: 9 }));
    const calm = comfortMetrics(sineTrack({ bobP2pM: 0.01, bobHz: 2, rollAmpDeg: 1, rollHz: 2 }));
    assert.ok((shaky.highFrequencyShare ?? 0) > 0.9);
    assert.ok((calm.highFrequencyShare ?? 1) < 0.01);
  });

  it("answers null, not zero, where ticks are too coarse or the track too short to resolve", () => {
    const coarse = comfortMetrics(sineTrack({ bobP2pM: 0.02, bobHz: 2, rollAmpDeg: 1, rollHz: 1, tickHz: 10 }));
    assert.equal(coarse.highFrequencyShare, null);
    const short = comfortMetrics(sineTrack({ bobP2pM: 0.02, bobHz: 2, rollAmpDeg: 1, rollHz: 1, seconds: 1 }));
    assert.equal(short.dominantBobHz, null);
  });

  it("measures a doorway snap, a smooth ramp and an overshoot", () => {
    assert.ok(exposureMetrics({ ticks: evRamp(12, 8, 50) }).maxEvStepPerWindow >= 3.9);
    const smooth = exposureMetrics({ ticks: evRamp(12, 8, 2000) });
    assert.ok(smooth.maxEvStepPerWindow <= 1.01 && smooth.overshootEv < 0.05);
    const ticks = evRamp(12, 8, 1000).map((t) => (t.tMs === 1600 ? { ...t, ev: 7.4 } : t));
    assert.ok(Math.abs(exposureMetrics({ ticks }).overshootEv - 0.6) < 1e-9);
  });
});

describe("the AA+ rubric", () => {
  it("grades complete measured evidence by its taste verdict, and caps it at AA without one", () => {
    assert.equal(grade(passingEvidence(PROMPT), TASTE_AAA).grade, AaaGrade.AaaIsh);
    assert.equal(grade().grade, AaaGrade.AaPlus);
    const blind = grade(passingEvidence(PROMPT), null);
    assert.equal(blind.grade, AaaGrade.Aa);
    assert.deepEqual(
      blind.blockers.map((c) => [c.floor, c.result]),
      [[AaaFloor.Taste, CheckResult.Unknown]],
    );
  });

  const belowAa: Array<[string, (e: ReturnType<typeof passingEvidence>) => void, AaaFloor]> = [
    [
      "a 960×540 capture",
      (e) => {
        for (const c of e.captures) Object.assign(c, { width: 960, height: 540 });
      },
      AaaFloor.CleanResolution,
    ],
    [
      "a capture through the lens",
      (e) => {
        for (const c of e.captures) Object.assign(c, { clean: false });
      },
      AaaFloor.CleanResolution,
    ],
    ["an unmapped view", (e) => e.captures.splice(0, 1), AaaFloor.ViewCoverage],
    ["a classroom at luma 28", (e) => Object.assign(e.captures[0] ?? {}, { meanLuma: 28 }), AaaFloor.LumaBand],
    ["41% in the darkest bin", (e) => Object.assign(e.captures[0] ?? {}, { darkFraction: 0.41 }), AaaFloor.LumaBand],
    [
      "a box bench",
      (e) => Object.assign(e.props?.[0] ?? {}, { origin: PropOrigin.Primitive }),
      AaaFloor.NoPrimitiveProps,
    ],
    [
      "a cone birch far away",
      (e) => Object.assign(e.props?.[1] ?? {}, { origin: PropOrigin.Primitive, nearestM: 40 }),
      AaaFloor.NoPrimitiveProps,
    ],
    [
      "an albedo-only ground",
      (e) => Object.assign(e.surfaces?.[1] ?? {}, { hasNormal: false, hasOrm: false }),
      AaaFloor.NearMaps,
    ],
    [
      "a 200 px/m wall",
      (e) => Object.assign(e.surfaces?.[0] ?? {}, { texelDensityPxPerM: 200 }),
      AaaFloor.TexelDensity,
    ],
    [
      "10% flat materials",
      (e) => Object.assign(e, { flatCoverage: { value: 0.1, source: FactSource.Engine } }),
      AaaFloor.FlatCoverage,
    ],
    ["a doorway snap", (e) => Object.assign(e.exposure[0] ?? {}, { ticks: evRamp(12, 8, 50) }), AaaFloor.Doorway],
    [
      "the gen3 sprint",
      (e) =>
        Object.assign(e.motion[0] ?? {}, {
          ticks: sineTrack({ bobP2pM: 0.089, bobHz: 7.5, rollAmpDeg: 5.8, rollHz: 3.7 }),
        }),
      AaaFloor.Comfort,
    ],
  ];
  for (const [name, mutate, floor] of belowAa)
    it(`puts ${name} below AA on ${floor}`, () => {
      const evidence = passingEvidence(PROMPT);
      mutate(evidence);
      const report = grade(evidence);
      assert.equal(report.grade, AaaGrade.BelowAa);
      assert.ok(
        report.blockers.some((c) => c.floor === floor && c.result === CheckResult.Fail),
        JSON.stringify(report.blockers),
      );
    });

  const belowAaPlus: Array<[string, (e: ReturnType<typeof passingEvidence>) => void, AaaFloor]> = [
    [
      "upscaled 4K captures",
      (e) => {
        for (const c of e.captures) Object.assign(c, { native: false });
      },
      AaaFloor.Native4k,
    ],
    [
      "1440p captures",
      (e) => {
        for (const c of e.captures) Object.assign(c, { width: 2560, height: 1440 });
      },
      AaaFloor.Native4k,
    ],
    [
      "a 300 px/m wall",
      (e) => Object.assign(e.surfaces?.[0] ?? {}, { texelDensityPxPerM: 300 }),
      AaaFloor.TexelDensity,
    ],
    ["a tree without cards", (e) => Object.assign(e.props?.[1] ?? {}, { hasCards: false }), AaaFloor.OrganicCards],
    [
      "4% flat materials",
      (e) => Object.assign(e, { flatCoverage: { value: 0.04, source: FactSource.Engine } }),
      AaaFloor.FlatCoverage,
    ],
    [
      "a reduced motion that keeps half",
      (e) =>
        Object.assign(e.motion[1] ?? {}, { ticks: sineTrack({ bobP2pM: 0.01, bobHz: 2, rollAmpDeg: 0.4, rollHz: 1 }) }),
      AaaFloor.ReducedMotion,
    ],
  ];
  for (const [name, mutate, floor] of belowAaPlus)
    it(`holds ${name} at AA on ${floor}`, () => {
      const evidence = passingEvidence(PROMPT);
      mutate(evidence);
      const report = grade(evidence);
      assert.equal(report.grade, AaaGrade.Aa);
      assert.ok(
        report.blockers.some((c) => c.floor === floor),
        JSON.stringify(report.blockers),
      );
    });

  it("lets a night look sit lower in the luma band", () => {
    const [night] = testSuite(rawPrompt("night", { look: "dark" }), rawPrompt("b"), rawPrompt("c"));
    if (!night) throw new Error("no prompt");
    const evidence = passingEvidence(night);
    for (const c of evidence.captures) Object.assign(c, { meanLuma: 50, darkFraction: 0.3 });
    const luma = rubricChecks(night, evidence, TASTE_AA_PLUS).find((c) => c.floor === AaaFloor.LumaBand);
    assert.equal(luma?.result, CheckResult.Pass);
    assert.equal(checkOf(AaaFloor.LumaBand, evidence)[0]?.result, CheckResult.Fail);
  });

  const lumaRows: Array<[string, "bright" | "dark", string, number, boolean]> = [
    ["a snow yard at 155", "bright", "exterior-hero", 155, true],
    ["a sunny exterior at 175", "bright", "exterior-hero", 175, true],
    ["an exterior blown past 175", "bright", "exterior-hero", 180, false],
    ["an interior at 150", "bright", "interior-hero", 150, false],
    ["an interior at 130", "bright", "interior-hero", 130, true],
    ["a night street at 25", "dark", "exterior-hero", 25, true],
    ["a night street below 25", "dark", "exterior-hero", 24, false],
    ["a dark interior at 95", "dark", "interior-hero", 95, true],
    ["a dark interior above 95", "dark", "interior-hero", 96, false],
  ];
  for (const [name, look, role, luma, passes] of lumaRows)
    it(`${passes ? "accepts" : "refuses"} ${name} (${look} look)`, () => {
      const [p] = testSuite(rawPrompt("lumas", { look }), rawPrompt("b"), rawPrompt("c"));
      if (!p) throw new Error("no prompt");
      const evidence = passingEvidence(p);
      const others = look === "dark" ? 50 : 110;
      for (const c of evidence.captures) Object.assign(c, { meanLuma: c.role === role ? luma : others });
      const result = rubricChecks(p, evidence, TASTE_AA_PLUS).find((c) => c.floor === AaaFloor.LumaBand)?.result;
      assert.equal(result, passes ? CheckResult.Pass : CheckResult.Fail);
    });

  it("fails on a reconstructed fact but never certifies one", () => {
    const failing = passingEvidence(PROMPT);
    Object.assign(failing.props?.[0] ?? {}, { origin: PropOrigin.Primitive, source: FactSource.Reconstructed });
    assert.equal(checkOf(AaaFloor.NoPrimitiveProps, failing)[0]?.result, CheckResult.Fail);
    const passing = passingEvidence(PROMPT);
    Object.assign(passing.props?.[0] ?? {}, { source: FactSource.Reconstructed });
    assert.equal(checkOf(AaaFloor.NoPrimitiveProps, passing)[0]?.result, CheckResult.Unknown);
    assert.equal(grade(passing).grade, AaaGrade.BelowAa);
  });

  it("leaves unmeasured sections unknown, never passed", () => {
    const evidence = {
      ...passingEvidence(PROMPT),
      surfaces: null,
      props: null,
      flatCoverage: null,
      motion: [],
      exposure: [],
    };
    const report = grade(evidence);
    assert.equal(report.grade, AaaGrade.BelowAa);
    const unknown = report.blockers.filter((c) => c.result === CheckResult.Unknown).map((c) => c.floor);
    assert.deepEqual(unknown.sort(), [
      AaaFloor.Comfort,
      AaaFloor.Doorway,
      AaaFloor.FlatCoverage,
      AaaFloor.NearMaps,
      AaaFloor.NoPrimitiveProps,
      AaaFloor.TexelDensity,
    ]);
  });

  it("passes the doorway floor for a prompt with no doorway", () => {
    const [open] = testSuite(rawPrompt("open", { transitions: [] }), rawPrompt("b"), rawPrompt("c"));
    if (!open) throw new Error("no prompt");
    const evidence = { ...passingEvidence(open), exposure: [] };
    assert.equal(
      rubricChecks(open, evidence, TASTE_AA_PLUS).find((c) => c.floor === AaaFloor.Doorway)?.result,
      CheckResult.Pass,
    );
  });

  it("takes only bundles that validate", () => {
    const evidence = passingEvidence(PROMPT);
    assert.doesNotThrow(() => parseEvidence(JSON.parse(JSON.stringify(evidence))));
    const hostile = ["/etc/passwd", "../outside.jpg", "captures/../../x.jpg", "a\\b.jpg"];
    for (const image of hostile) {
      const bad = JSON.parse(JSON.stringify(evidence));
      bad.captures[0].image = image;
      assert.throws(() => parseEvidence(bad), /captures\[0\]\.image/, image);
    }
  });
});

describe("the release gate", () => {
  const prompts = testSuite();
  const at = (index: number, taste: TasteSummary | null) => {
    const prompt = prompts[index];
    if (!prompt) throw new Error("no prompt");
    return gradePrompt(prompt, passingEvidence(prompt), { summary: taste, missing: [] }, PASSING_CONTEXT);
  };

  it("passes three different prompts at AA+ and fails when one is lower or missing", () => {
    assert.equal(releaseGate([at(0, TASTE_AA_PLUS), at(1, TASTE_AA_PLUS), at(2, TASTE_AAA)]).pass, true);
    assert.equal(releaseGate([at(0, TASTE_AA_PLUS), at(1, TASTE_AA_PLUS), at(2, null)]).pass, false);
    assert.equal(releaseGate([at(0, TASTE_AA_PLUS), at(1, TASTE_AA_PLUS), at(1, TASTE_AA_PLUS)]).pass, false);
  });

  it("does not count a run whose brief differs from the suite's", () => {
    const stale = at(2, TASTE_AA_PLUS);
    const gate = releaseGate([at(0, TASTE_AA_PLUS), at(1, TASTE_AA_PLUS), { ...stale, versionMatches: false }]);
    assert.equal(gate.pass, false);
    assert.deepEqual(gate.counted, [prompts[0]?.id, prompts[1]?.id]);
  });

  it("renders every prompt, its grade and the gate in the Markdown report", () => {
    const report = buildReport([at(0, TASTE_AA_PLUS)], "off", new Date("2026-10-29T00:00:00Z"));
    const md = renderReportMarkdown(report);
    assert.match(md, /Release gate: FAIL/);
    assert.match(md, new RegExp(`## ${PROMPT.id}: aa-plus`));
  });
});

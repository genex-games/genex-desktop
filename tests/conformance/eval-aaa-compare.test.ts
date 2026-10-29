/**
 * The AA+ side-by-side comparison against a baseline run: checks move by result rank, the verdict
 * needs a higher grade or three improvements with no regression (and no view the look judge gives
 * the baseline), the pairwise judge counts a side only when both orders agree, and `aaa compare`
 * writes a page that carries both sides' captures.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import jpeg from "jpeg-js";
import {
  type AaaDeps,
  aaaCompareCommand,
  COMPARE_JSON,
  COMPARE_MD,
  tastePins,
} from "../../scripts/evals/aaa/command.ts";
import {
  type CheckDelta,
  CheckMove,
  CompareVerdict,
  checkDeltas,
  compareRuns,
  compareVerdict,
  PairwiseSide,
  parseCloser,
  readPairwiseTasteTemplate,
  type ViewPair,
} from "../../scripts/evals/aaa/compare.ts";
import { type AaaEvidence, EVIDENCE_FILE } from "../../scripts/evals/aaa/evidence.ts";
import { gradePrompt } from "../../scripts/evals/aaa/report.ts";
import { AaaFloor, AaaGrade, type FloorCheck } from "../../scripts/evals/aaa/rubric.ts";
import { AAA_SUITE_FILE, AAA_SUITE_SCHEMA } from "../../scripts/evals/aaa/suite.ts";
import type { GraderComplete } from "../../scripts/evals/grade/checklist/complete.ts";
import { CliExit } from "../../scripts/evals/cli/exit.ts";
import { CheckResult, GraderFamily } from "../../scripts/evals/vocabulary.ts";
import { HEAD, PASSING_CONTEXT, passingEvidence, rawPrompt, testSuite } from "../helpers/aaa-evidence.ts";
import { tmpDir } from "../helpers/tmp.ts";

const [PROMPT] = testSuite();
if (!PROMPT) throw new Error("no prompt");
const jpg = (shade: number) => jpeg.encode({ width: 4, height: 4, data: new Uint8Array(64).fill(shade) }, 80).data;

/** gen3-like: small captures through a lens, a dark room, no look facts. */
function weakEvidence(): AaaEvidence {
  const evidence = passingEvidence(PROMPT);
  for (const c of evidence.captures) Object.assign(c, { width: 960, height: 540, clean: false, native: false });
  Object.assign(evidence.captures[0] ?? {}, { meanLuma: 28, darkFraction: 0.41 });
  return { ...evidence, surfaces: null, props: null, flatCoverage: null, motion: [], exposure: [] };
}

const check = (floor: AaaFloor, result: CheckResult): FloorCheck => ({ floor, tier: AaaGrade.Aa, result, detail: [] });
const view = (taste: ViewPair["taste"]): ViewPair => ({
  role: "r",
  baseline: null,
  candidate: null,
  taste,
  detail: [],
});

describe("checks and the verdict", () => {
  it("moves a check only between passing and not passing: unmeasured and failing rank alike", () => {
    const base = [
      check(AaaFloor.LumaBand, CheckResult.Fail),
      check(AaaFloor.Comfort, CheckResult.Pass),
      check(AaaFloor.Doorway, CheckResult.Unknown),
    ];
    const cand = [
      check(AaaFloor.LumaBand, CheckResult.Unknown),
      check(AaaFloor.Comfort, CheckResult.Fail),
      check(AaaFloor.Doorway, CheckResult.Unknown),
    ];
    assert.deepEqual(
      checkDeltas(base, cand).map((d) => d.move),
      [CheckMove.Same, CheckMove.Regressed, CheckMove.Same],
    );
  });

  const improved = (n: number): CheckDelta[] =>
    Array.from({ length: n }, () => ({
      floor: "f",
      tier: "aa",
      baseline: CheckResult.Fail,
      candidate: CheckResult.Pass,
      move: CheckMove.Improved,
    }));
  const regressed = (n: number): CheckDelta[] =>
    Array.from({ length: n }, () => ({
      floor: "f",
      tier: "aa",
      baseline: CheckResult.Pass,
      candidate: CheckResult.Fail,
      move: CheckMove.Regressed,
    }));
  const rows: Array<[string, string, string, CheckDelta[], ViewPair[], CompareVerdict]> = [
    ["a higher grade", "below-aa", "aa", [], [], CompareVerdict.ClearlyBetter],
    ["a lower grade", "aa", "below-aa", improved(5), [], CompareVerdict.Worse],
    ["three improvements, none regressed", "below-aa", "below-aa", improved(3), [], CompareVerdict.ClearlyBetter],
    ["two improvements", "below-aa", "below-aa", improved(2), [], CompareVerdict.NotClearlyBetter],
    [
      "four improvements and one regression",
      "below-aa",
      "below-aa",
      [...improved(4), ...regressed(1)],
      [],
      CompareVerdict.NotClearlyBetter,
    ],
    [
      "more regressions than improvements",
      "below-aa",
      "below-aa",
      [...improved(1), ...regressed(2)],
      [],
      CompareVerdict.Worse,
    ],
    [
      "a higher grade with one view the judge gives the baseline",
      "below-aa",
      "aa",
      [],
      [view(PairwiseSide.Candidate), view(PairwiseSide.Baseline)],
      CompareVerdict.NotClearlyBetter,
    ],
    [
      "a higher grade the judge mostly prefers",
      "below-aa",
      "aa",
      [],
      [view(PairwiseSide.Candidate), view(PairwiseSide.Split)],
      CompareVerdict.ClearlyBetter,
    ],
    [
      "a judge that prefers the baseline overall",
      "below-aa",
      "aa",
      [],
      [view(PairwiseSide.Baseline), view(PairwiseSide.Baseline)],
      CompareVerdict.Worse,
    ],
  ];
  for (const [name, b, c, checks, views, verdict] of rows)
    it(`calls ${name} ${verdict}`, () => assert.equal(compareVerdict(b, c, checks, views).verdict, verdict));
});

describe("the pairwise look judge", () => {
  it("reads LEFT, RIGHT or SAME on the last line only", () => {
    assert.equal(parseCloser("sharper\nCLOSER: RIGHT"), "RIGHT");
    assert.equal(parseCloser("CLOSER: LEFT\nmaybe"), null);
    assert.equal(parseCloser("CLOSER: BOTH"), null);
  });

  async function runs() {
    const dir = await tmpDir("aaa-pair-");
    const sides = { base: path.join(dir, "base"), cand: path.join(dir, "cand") };
    for (const [key, shade] of [
      ["base", 40],
      ["cand", 200],
    ] as const) {
      fs.mkdirSync(path.join(sides[key], "captures"), { recursive: true });
      fs.writeFileSync(path.join(sides[key], "captures", "a.jpg"), jpg(shade));
    }
    fs.writeFileSync(path.join(dir, "ref.jpg"), jpg(128));
    const withImage = (e: AaaEvidence) => {
      for (const c of e.captures) c.image = "captures/a.jpg";
      return e;
    };
    const base = withImage(weakEvidence());
    const cand = withImage(passingEvidence(PROMPT));
    const graded = (e: AaaEvidence) => gradePrompt(PROMPT, e, { summary: null, missing: [] }, PASSING_CONTEXT);
    return {
      dir,
      base: { dir: sides.base, evidence: base, report: graded(base) },
      cand: { dir: sides.cand, evidence: cand, report: graded(cand) },
    };
  }
  const candidateData = Buffer.from(jpg(200)).toString("base64");
  const judgeDeps = (dir: string, answer: (leftIsCandidate: boolean) => string) => {
    const complete: GraderComplete = async (pin, q) => {
      const left = q.images.find((i) => i.label === "FRAME LEFT");
      return {
        text: answer(left?.data === candidateData),
        model: pin.model,
        usage: { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 },
      };
    };
    return {
      template: readPairwiseTasteTemplate().template,
      deps: {
        pins: tastePins([GraderFamily.Gpt], "sha") ?? [],
        complete,
        votes: 1,
        builderFamily: null,
        referenceStills: () => [path.join(dir, "ref.jpg")],
      },
    };
  };

  it("gives a view to the candidate when both orders pick it, and calls it clearly better", async () => {
    const r = await runs();
    const judge = judgeDeps(r.dir, (leftIsCandidate) => `CLOSER: ${leftIsCandidate ? "LEFT" : "RIGHT"}`);
    const comparison = await compareRuns(PROMPT, r.base, r.cand, judge);
    assert.deepEqual(
      comparison.views.map((v) => v.taste),
      [PairwiseSide.Candidate, PairwiseSide.Candidate],
    );
    assert.equal(comparison.verdict, CompareVerdict.ClearlyBetter);
    assert.ok(
      comparison.metrics.some((m) => m.metric === "luma distance outside band: interior-hero" && m.better === true),
    );
  });

  it("calls a judge that always picks the left side split, never a win", async () => {
    const r = await runs();
    const comparison = await compareRuns(
      PROMPT,
      r.base,
      r.cand,
      judgeDeps(r.dir, () => "CLOSER: LEFT"),
    );
    assert.deepEqual(
      comparison.views.map((v) => v.taste),
      [PairwiseSide.Split, PairwiseSide.Split],
    );
  });
});

describe("aaa compare", () => {
  async function root() {
    const dir = await tmpDir("aaa-root-");
    fs.mkdirSync(path.join(dir, "evals/aaa"), { recursive: true });
    const prompts = [rawPrompt("alpha"), rawPrompt("beta"), rawPrompt("gamma")];
    fs.writeFileSync(path.join(dir, AAA_SUITE_FILE), JSON.stringify({ schema: AAA_SUITE_SCHEMA, prompts }));
    return dir;
  }
  function bundle(dir: string, evidence: AaaEvidence, shade: number) {
    fs.mkdirSync(path.join(dir, "captures"), { recursive: true });
    for (const [i, c] of evidence.captures.entries()) {
      c.image = `captures/${i}.jpg`;
      fs.writeFileSync(path.join(dir, c.image), jpg(shade));
    }
    fs.writeFileSync(path.join(dir, EVIDENCE_FILE), JSON.stringify(evidence));
  }
  const deps = (repo: string): AaaDeps => ({
    root: repo,
    home: () => repo,
    now: () => new Date("2026-10-29T00:00:00Z"),
    graderComplete: async () => {
      throw new Error("no model in tests");
    },
    fetchBytes: async () => {
      throw new Error("no network in tests");
    },
  });
  const lines: string[] = [];
  const out = (line: string) => lines.push(line);

  it("writes compare.json and a page with both sides' captures, exit 0 when clearly better", async () => {
    const repo = await root();
    const work = await tmpDir("aaa-cmp-");
    bundle(path.join(work, "base"), weakEvidence(), 40);
    bundle(path.join(work, "cand"), passingEvidence(PROMPT), 200);
    const code = await aaaCompareCommand(
      [path.join(work, "cand"), "--baseline", path.join(work, "base"), "--out", path.join(work, "out"), "--head", HEAD],
      out,
      deps(repo),
    );
    assert.equal(code, CliExit.Ok);
    const comparison = JSON.parse(fs.readFileSync(path.join(work, "out", COMPARE_JSON), "utf8"));
    assert.equal(comparison.baseline.grade, AaaGrade.BelowAa);
    assert.equal(comparison.candidate.grade, AaaGrade.Aa);
    assert.equal(comparison.verdict, CompareVerdict.ClearlyBetter);
    const page = fs.readFileSync(path.join(work, "out", COMPARE_MD), "utf8");
    assert.match(page, /!\[baseline\]\(baseline\/captures\/0\.jpg\)/);
    assert.ok(fs.existsSync(path.join(work, "out", "candidate", "captures", "0.jpg")));
  });

  it("exits 1 when the candidate is not clearly better, and refuses runs of different prompts", async () => {
    const repo = await root();
    const work = await tmpDir("aaa-cmp-");
    bundle(path.join(work, "base"), weakEvidence(), 40);
    bundle(path.join(work, "same"), weakEvidence(), 40);
    const args = (cand: string) => [
      path.join(work, cand),
      "--baseline",
      path.join(work, "base"),
      "--out",
      path.join(work, "out"),
    ];
    assert.equal(await aaaCompareCommand(args("same"), out, deps(repo)), CliExit.Refused);
    const [, beta] = testSuite();
    bundle(path.join(work, "other"), { ...passingEvidence(PROMPT), promptId: beta?.id ?? "beta" }, 200);
    assert.equal(await aaaCompareCommand(args("other"), out, deps(repo)), CliExit.Refused);
    assert.match(lines.at(-1) ?? "", /different prompts/);
    assert.equal(await aaaCompareCommand([path.join(work, "same"), "--out", work], out, deps(repo)), CliExit.Usage);
  });
});

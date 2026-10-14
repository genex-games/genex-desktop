/**
 * The renderer perf gate (RQ0.9): the comparator `scripts/spike/rust-wgpu/render-perf.ts` over
 * committed fixture records (a 12% p95 regression on `off` fails, 9% passes, a missing scene
 * fails, records from different adapters, power sources or thermal states are refused), the run
 * merge (median of runs), the feature-cost report and the gate row: the owner's statistic of
 * 2026-10-13 (profile off, the median of 5 interleaved A/B runs against the saved `rq0-head`
 * executable), which skips with a typed reason unless that executable is saved locally and
 * `GENEX_REQUIRE_METAL=1` asks for the real GPU run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type Comparison,
  compareRecords,
  featureCosts,
  formatComparison,
  GATE_ARGS,
  GATE_TIER,
  GATE_TIER_DIR,
  GateSkip,
  gateStatus,
  MAX_OFF_RATIO,
  MIN_GATE_FRAMES,
  mergeRuns,
  noisyScenes,
  NOISE_SPREAD,
  rowSpread,
  Statistic,
  type PerfRecord,
  PerfRefusal,
  RowVerdict,
  RunMode,
  runPlan,
  switchedOn,
} from "../../scripts/spike/rust-wgpu/render-perf.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURES = path.join(REPO, "tests", "fixtures", "render-perf");
const SCRIPT = path.join(REPO, "scripts", "spike", "rust-wgpu", "render-perf.ts");

async function fixture(name: string): Promise<PerfRecord> {
  return JSON.parse(await readFile(path.join(FIXTURES, name), "utf8")) as PerfRecord;
}

function verdictOf(comparison: Comparison, row: string, profile: string, height: number): string | undefined {
  return comparison.rows.find((r) => r.row === row && r.profile === profile && r.size[1] === height)?.verdict;
}

describe("render perf comparator", () => {
  it("flags a 12% p95 regression on the off profile and fails the gate", async () => {
    const comparison = compareRecords(await fixture("baseline.json"), await fixture("candidate-plus-12.json"), {
      minFrames: MIN_GATE_FRAMES,
    });
    assert.equal(comparison.refusals.length, 0);
    assert.equal(comparison.passed, false);
    assert.equal(verdictOf(comparison, "bench-outdoor", "off", 1080), RowVerdict.Regressed);
    const row = comparison.rows.find((r) => r.row === "bench-outdoor" && r.profile === "off" && r.size[1] === 1080);
    assert.equal(row?.metric, "gpuMs");
    assert.ok(Math.abs((row?.ratio ?? 0) - 1.12) < 0.002);
    assert.equal(comparison.failures.length, 1);
  });

  it("passes a 9% regression and the exact limit of 10%", async () => {
    const base = await fixture("baseline.json");
    for (const name of ["candidate-plus-9.json", "candidate-plus-10.json", "candidate-same.json"]) {
      const comparison = compareRecords(base, await fixture(name), { minFrames: MIN_GATE_FRAMES });
      assert.equal(comparison.passed, true, name);
      assert.equal(comparison.failures.length, 0, name);
    }
    assert.equal(MAX_OFF_RATIO, 1.1);
  });

  it("reports a scene missing from the candidate as a failure", async () => {
    const comparison = compareRecords(await fixture("baseline.json"), await fixture("candidate-missing-scene.json"), {
      minFrames: MIN_GATE_FRAMES,
    });
    assert.equal(comparison.passed, false);
    assert.equal(verdictOf(comparison, "stress-plaza", "off", 1080), RowVerdict.Missing);
    assert.equal(comparison.failures.length, 1);
  });

  it("refuses records from different adapters without comparing a single row", async () => {
    const comparison = compareRecords(await fixture("baseline.json"), await fixture("candidate-other-adapter.json"), {
      minFrames: MIN_GATE_FRAMES,
    });
    assert.equal(comparison.passed, false);
    assert.deepEqual(
      comparison.refusals.map((r) => r.code),
      [PerfRefusal.AdapterMismatch],
    );
    assert.equal(comparison.rows.length, 0);
  });

  it("refuses records taken on a different power source or thermal state", async () => {
    const base = await fixture("baseline.json");
    const battery = compareRecords(base, await fixture("candidate-battery.json"), { minFrames: MIN_GATE_FRAMES });
    assert.deepEqual(
      battery.refusals.map((r) => r.code),
      [PerfRefusal.PowerMismatch],
    );
    const hot = compareRecords(base, await fixture("candidate-hot.json"), { minFrames: MIN_GATE_FRAMES });
    assert.deepEqual(
      hot.refusals.map((r) => r.code),
      [PerfRefusal.ThermalMismatch],
    );
    assert.equal(battery.rows.length + hot.rows.length, 0);
  });

  it("refuses a candidate measured over fewer frames than the gate needs", async () => {
    const comparison = compareRecords(await fixture("baseline.json"), await fixture("candidate-120-frames.json"), {
      minFrames: MIN_GATE_FRAMES,
    });
    assert.ok(comparison.refusals.some((r) => r.code === PerfRefusal.TooFewFrames));
    assert.equal(comparison.passed, false);
    // The same records compare when the caller asks for no minimum (the matrix's quick run).
    assert.equal(
      compareRecords(await fixture("baseline.json"), await fixture("candidate-120-frames.json")).passed,
      true,
    );
  });

  it("only gates the off profile; other profiles report their ratio", async () => {
    const comparison = compareRecords(await fixture("baseline.json"), await fixture("candidate-high-plus-40.json"), {
      minFrames: MIN_GATE_FRAMES,
    });
    assert.equal(comparison.passed, true);
    const high = comparison.rows.find((r) => r.profile === "high");
    assert.equal(high?.verdict, RowVerdict.Info);
    assert.ok(Math.abs((high?.ratio ?? 0) - 1.4) < 0.002);
  });

  it("falls back to the whole-frame metric when a side has no GPU timestamps, and compares the old bench record", async () => {
    const candidate = await fixture("candidate-plus-12.json");
    const old = await fixture("record-render-baseline.json");
    const comparison = compareRecords(old, candidate, { metric: "frameMs", profiles: ["off"] });
    assert.equal(comparison.refusals.length, 0, JSON.stringify(comparison.refusals));
    assert.ok(comparison.rows.every((r) => r.metric === "frameMs"));
    assert.ok(comparison.rows.length > 0);
    const noGpu = structuredClone(candidate);
    for (const row of noGpu.rows) row.gpuMs = null;
    const auto = compareRecords(await fixture("baseline.json"), noGpu, { profiles: ["off"] });
    assert.ok(auto.rows.every((r) => r.metric === "frameMs"));
  });
});

describe("render perf informational scenes", () => {
  it("reports the remastered Lakeside scenes' off rows as information that never fails the gate", async () => {
    // Owner decision 2026-10-12: the features-off rule covers the bench and stress scenes, whose
    // content is unchanged since the baseline; the Lakeside's content was remastered after it.
    const base = await fixture("baseline.json");
    const lakeside = (record: PerfRecord, factor: number) => {
      const copy = structuredClone(record);
      const extra = structuredClone(copy.rows.filter((r) => r.row === "bench-outdoor" && r.profile === "off"));
      for (const row of extra) {
        row.row = "lakeside-forest";
        if (row.gpuMs) row.gpuMs.p95 *= factor;
      }
      copy.rows.push(...extra);
      return copy;
    };
    const comparison = compareRecords(lakeside(base, 1), lakeside(await fixture("candidate-same.json"), 1.88), {
      minFrames: MIN_GATE_FRAMES,
    });
    assert.equal(verdictOf(comparison, "lakeside-forest", "off", 1080), RowVerdict.Info);
    assert.equal(verdictOf(comparison, "bench-outdoor", "off", 1080), RowVerdict.Ok);
    assert.equal(comparison.passed, true);
    assert.equal(comparison.failures.length, 0);
    assert.ok((comparison.worstOffRatio ?? 0) < 1.01, `worst gated ratio ${comparison.worstOffRatio}`);
    // A Lakeside row the candidate lacks is information too; a bench row it lacks still fails.
    const lacking = structuredClone(await fixture("candidate-same.json"));
    const missing = compareRecords(lakeside(base, 1), lacking, { minFrames: MIN_GATE_FRAMES });
    assert.equal(verdictOf(missing, "lakeside-forest", "off", 1080), RowVerdict.Info);
    assert.equal(missing.passed, true);
    lacking.rows = lacking.rows.filter((r) => r.row !== "bench-outdoor" || r.profile !== "off");
    assert.equal(compareRecords(lakeside(base, 1), lacking, { minFrames: MIN_GATE_FRAMES }).passed, false);
  });
});

describe("render perf run merge", () => {
  it("takes the median p95 of each row over the runs", async () => {
    const base = await fixture("baseline.json");
    const run = (factor: number) => {
      const copy = structuredClone(base);
      for (const row of copy.rows)
        for (const key of ["p50", "p95"] as const) {
          if (row.gpuMs) row.gpuMs[key] *= factor;
          row.frameMs[key] *= factor;
        }
      return copy;
    };
    const merged = mergeRuns([run(1.0), run(3.0), run(1.2)]);
    const first = merged.rows[0];
    assert.ok(Math.abs((first?.gpuMs?.p95 ?? 0) - (base.rows[0]?.gpuMs?.p95 ?? 0) * 1.2) < 1e-9);
    assert.equal(merged.method.runs, 3);
  });

  it("refuses to merge runs from different adapters", async () => {
    const base = await fixture("baseline.json");
    const other = await fixture("candidate-other-adapter.json");
    assert.throws(() => mergeRuns([base, other]), /adapter-mismatch/);
  });
});

describe("render perf noise", () => {
  it("measures a row's spread as the largest run p95 over the smallest", async () => {
    const base = await fixture("baseline.json");
    const row = structuredClone(base.rows[0]);
    assert.ok(row);
    assert.equal(rowSpread(row, "gpuMs"), 1);
    row.runsP95 = { gpuMs: [1.8, 4.2, 2.4] };
    assert.ok(Math.abs(rowSpread(row, "gpuMs") - 4.2 / 1.8) < 1e-9);
    assert.equal(rowSpread(row, "frameMs"), 1);
  });

  it("names the scenes whose runs disagree beyond the noise limit, so only they are measured again", async () => {
    const base = await fixture("baseline.json");
    const merged = mergeRuns([base, base, base]);
    assert.deepEqual(noisyScenes(merged), []);
    const noisy = structuredClone(merged);
    const target = noisy.rows.find((r) => r.row === "bench-city" && r.size[1] === 1080);
    assert.ok(target?.runsP95);
    target.runsP95.gpuMs = [3.0, 3.0 * NOISE_SPREAD * 1.01, 3.0];
    assert.deepEqual(noisyScenes(noisy), ["bench-city"]);
    target.runsP95.gpuMs = [3.0, 3.0 * NOISE_SPREAD * 0.99, 3.0];
    assert.deepEqual(noisyScenes(noisy), []);
  });

  it("flags a compared row as noisy when either side's runs disagree, without changing its ratio", async () => {
    const base = mergeRuns([await fixture("baseline.json")]);
    const candidate = mergeRuns([await fixture("candidate-plus-9.json")]);
    const row = candidate.rows.find((r) => r.row === "bench-outdoor" && r.size[1] === 1080 && r.profile === "off");
    assert.ok(row?.runsP95);
    row.runsP95.gpuMs = [2.0, 2.4, 3.9];
    const comparison = compareRecords(base, candidate);
    const compared = comparison.rows.find(
      (r) => r.row === "bench-outdoor" && r.size[1] === 1080 && r.profile === "off",
    );
    assert.equal(compared?.noisy, true);
    assert.equal(comparison.rows.filter((r) => r.noisy).length, 1);
    assert.equal(comparison.passed, true);
  });

  it("compares the best run instead of the median when asked, since contention only adds time", async () => {
    const base = mergeRuns([await fixture("baseline.json")]);
    const candidate = mergeRuns([await fixture("candidate-same.json")]);
    const row = candidate.rows.find((r) => r.row === "bench-city" && r.size[1] === 1080 && r.profile === "off");
    assert.ok(row?.gpuMs && row.runsP95);
    const best = row.gpuMs.p95;
    row.gpuMs.p95 = best * 1.3; // the median of runs a busy machine inflated
    row.runsP95.gpuMs = [best, best * 1.3, best * 1.5];
    const median = compareRecords(base, candidate, { statistic: Statistic.Median });
    assert.equal(median.passed, false);
    const min = compareRecords(base, candidate, { statistic: Statistic.Min });
    assert.equal(min.passed, true);
    const compared = min.rows.find((r) => r.row === "bench-city" && r.size[1] === 1080);
    assert.ok(Math.abs((compared?.ratio ?? 0) - 1) < 1e-9);
    // A genuine regression is slower at its best too.
    row.runsP95.gpuMs = [best * 1.2, best * 1.3, best * 1.5];
    assert.equal(compareRecords(base, candidate, { statistic: Statistic.Min }).passed, false);
  });

  it("merges a partial re-run into the rows it covers and leaves the others at their own runs", async () => {
    const base = await fixture("baseline.json");
    const partial = structuredClone(base);
    partial.rows = partial.rows.filter((r) => r.row === "bench-city");
    for (const r of partial.rows) if (r.gpuMs) r.gpuMs.p95 *= 2;
    const merged = mergeRuns([base, base, partial]);
    const city = merged.rows.find((r) => r.row === "bench-city");
    const wide = merged.rows.find((r) => r.row === "bench-outdoor" && r.size[1] === 720);
    assert.equal(city?.runsP95?.gpuMs?.length, 3);
    assert.equal(wide?.runsP95?.gpuMs?.length, 2);
    assert.equal(city?.gpuMs?.p95, base.rows.find((r) => r.row === "bench-city")?.gpuMs?.p95);
  });
});

describe("render perf interleaved A/B report", () => {
  /** `record` with every off row's GPU p95 scaled by `factor`. */
  const scaled = (record: PerfRecord, factor: number) => {
    const copy = structuredClone(record);
    for (const row of copy.rows) if (row.gpuMs) row.gpuMs.p95 *= factor;
    return copy;
  };

  it("keeps each run's p95 of both sides and their paired ratios beside the gated median", async () => {
    // Owner decision 2026-10-13 (1): the features-off rule is judged on the median of 5 interleaved
    // A/B runs, and the report shows each run as well as the median.
    const base = await fixture("baseline.json");
    const saved = mergeRuns([1.0, 1.4, 1.1, 1.0, 1.2].map((f) => scaled(base, f)));
    const current = mergeRuns([1.5, 1.0, 1.05, 1.1, 1.3].map((f) => scaled(base, f)));
    const comparison = compareRecords(saved, current, { profiles: ["off"] });
    const row = comparison.rows.find((r) => r.row === "bench-outdoor" && r.size[1] === 720);
    const p95 = base.rows.find((r) => r.row === "bench-outdoor" && r.size[1] === 720)?.gpuMs?.p95 ?? 0;
    assert.ok(row?.runs, "the compared row carries its runs");
    assert.equal(row.runs.baseline.length, 5);
    assert.equal(row.runs.candidate.length, 5);
    assert.ok(Math.abs((row.runs.baseline[1] ?? 0) - p95 * 1.4) < 1e-9);
    assert.ok(Math.abs((row.runs.candidate[0] ?? 0) - p95 * 1.5) < 1e-9);
    // Run n of one side against run n of the other: the pairs that shared the machine's state.
    const expected = [1.5 / 1.0, 1.0 / 1.4, 1.05 / 1.1, 1.1 / 1.0, 1.3 / 1.2];
    assert.equal(row.runs.ratios?.length, 5);
    for (const [n, ratio] of (row.runs.ratios ?? []).entries()) {
      assert.ok(Math.abs(ratio - (expected[n] ?? 0)) < 1e-9, `run ${n + 1}`);
    }
    // The gated ratio stays the median of each side's runs (1.1 over 1.1).
    assert.ok(Math.abs((row.ratio ?? 0) - 1) < 1e-9);
    assert.equal(row.verdict, RowVerdict.Ok);

    const report = formatComparison("A/B", comparison);
    const line = report
      .split("\n")
      .find((l) => l.includes("bench-outdoor") && l.includes("1280x720") && l.includes("runs:"));
    assert.ok(line, report);
    for (const value of [...row.runs.baseline, ...row.runs.candidate]) assert.ok(line.includes(value.toFixed(3)), line);
    for (const ratio of expected) assert.ok(line.includes(ratio.toFixed(2)), line);
    assert.match(report, /median of 5 runs/);
  });

  it("pairs no runs when the sides hold different run counts (a stored baseline)", async () => {
    const base = await fixture("baseline.json");
    const comparison = compareRecords(base, mergeRuns([base, scaled(base, 1.05), base]), { profiles: ["off"] });
    const row = comparison.rows.find((r) => r.row === "bench-outdoor" && r.size[1] === 720);
    assert.equal(row?.runs?.baseline.length, 1);
    assert.equal(row?.runs?.candidate.length, 3);
    assert.equal(row?.runs?.ratios, null);
  });
});

describe("render perf feature costs", () => {
  it("attributes a wired profile's delta against the budgets of its features", async () => {
    const budgets = JSON.parse(await readFile(path.join(FIXTURES, "budgets.json"), "utf8"));
    const costs = featureCosts(await fixture("baseline.json"), budgets);
    const high = costs.find((c) => c.row === "bench-outdoor" && c.profile === "high");
    assert.ok(high);
    assert.ok(Math.abs(high.deltaMs - (2.9 - 2.01)) < 1e-9);
    // hdr + tonemap and bloom are on: the sum is their entries (bloom's since RX.R3).
    assert.ok(Math.abs(high.budgetMs - (0.3 + 0.4)) < 1e-9);
    assert.deepEqual(high.budgetEntries, ["hdr-tonemap", "bloom"]);
    assert.equal(high.withinBudget, false);
  });

  it("reports an unwired profile as having nothing to attribute", async () => {
    const budgets = JSON.parse(await readFile(path.join(FIXTURES, "budgets.json"), "utf8"));
    const record = await fixture("baseline.json");
    for (const row of record.rows) if (row.applied) row.applied.wired = false;
    const costs = featureCosts(record, budgets);
    assert.equal(costs.length, 1);
    assert.equal(costs[0]?.wired, false);
    assert.equal(costs[0]?.withinBudget, null);
  });

  it("charges a preset's own shadows against the shadow budget although off draws legacy shadows", async () => {
    // RQ3 review: off draws shadows, so "shadows" was never added and no preset row met the
    // shadow budget.
    const budgets = JSON.parse(await readFile(path.join(FIXTURES, "budgets.json"), "utf8"));
    const record = await fixture("baseline.json");
    for (const row of record.rows) {
      if (!row.applied) continue;
      const off = row.applied.profile === "off" || row.profile === "off";
      row.applied.featuresDrawn = [...switchedOn(row), "shadows"];
      row.applied.featureShapes = { shadows: off ? "2x1024-Depth32-Pcf3x3" : "3x2048-Depth32-PcssLite" };
    }
    const off = record.rows.find(
      (r) => r.row === "bench-outdoor" && (r.profile ?? "off") === "off" && r.size[1] === 1080,
    );
    assert.ok(off?.applied, "the fixture's off row records what it drew");
    const high = featureCosts(record, budgets).find((c) => c.row === "bench-outdoor" && c.profile === "high");
    assert.ok(high);
    assert.deepEqual(high.budgetEntries, ["hdr-tonemap", "shadows-pcss", "bloom"]);
    assert.ok(Math.abs(high.budgetMs - (0.3 + 1.5 + 0.4)) < 1e-9);
    // The same shape as off's costs nothing of the shadow budget.
    for (const row of record.rows) if (row.applied) row.applied.featureShapes = { shadows: "2x1024-Depth32-Pcf3x3" };
    const same = featureCosts(record, budgets).find((c) => c.row === "bench-outdoor" && c.profile === "high");
    assert.deepEqual(same?.budgetEntries, ["hdr-tonemap", "bloom"]);
  });

  it("holds a feature to the budget of the shape it is drawn in: half-resolution AO 0.6 ms, full 1.5", async () => {
    // RX.R3 (pass-1 gate): the budgets listed only part of plan 2.10's table, so a preset's sum read
    // 2.8 ms where the plan gives bloom, GTAO by resolution, TAA, EASU + RCAS and light binning too.
    const budgets = JSON.parse(await readFile(path.join(FIXTURES, "budgets.json"), "utf8"));
    const highWithAo = async (shape: string) => {
      const record = await fixture("baseline.json");
      for (const row of record.rows.filter((r) => r.applied && (r.profile ?? "off") !== "off")) {
        if (!row.applied) continue;
        row.applied.featuresDrawn = [...switchedOn(row), "ao"];
        row.applied.featureShapes = { ao: shape };
      }
      return featureCosts(record, budgets).find((c) => c.row === "bench-outdoor" && c.profile === "high");
    };
    const half = await highWithAo("half");
    assert.deepEqual(half?.budgetEntries, ["hdr-tonemap", "bloom", "ao-half"]);
    assert.ok(Math.abs((half?.budgetMs ?? 0) - (0.3 + 0.4 + 0.6)) < 1e-9);
    const full = await highWithAo("full");
    assert.deepEqual(full?.budgetEntries, ["hdr-tonemap", "bloom", "ao-full"]);
    // Owner decision 2026-10-12: ultra's full-resolution AO (3 slices x 8 steps) has 1.5 ms (was 1.2).
    assert.ok(Math.abs((full?.budgetMs ?? 0) - (0.3 + 0.4 + 1.5)) < 1e-9);
  });

  it("lists the switched-on features of a row", async () => {
    const record = await fixture("baseline.json");
    assert.deepEqual(switchedOn(record.rows[4]), ["hdr", "tonemap", "bloom"]);
    assert.deepEqual(switchedOn(record.rows[0]), []);
  });

  it("attributes nothing to a feature a wired profile asked for but the renderer did not draw", async () => {
    const budgets = JSON.parse(await readFile(path.join(FIXTURES, "budgets.json"), "utf8"));
    const record = await fixture("baseline.json");
    for (const row of record.rows) if (row.applied) row.applied.featuresDrawn = ["shadows"];
    const high = featureCosts(record, budgets).find((c) => c.row === "bench-outdoor" && c.profile === "high");
    assert.ok(high);
    assert.equal(high.wired, true);
    assert.deepEqual(high.budgetEntries, [], "hdr and tonemap were asked for, not drawn");
    assert.equal(high.withinBudget, null);
  });
});

describe("render perf command line", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: "utf8" });

  it("refuses record, tier and baseline names that are not plain names, before anything builds", () => {
    for (const hostile of ["../escape", "a/b", "..", "", "-x", "a b", "x\\y", `${"n".repeat(70)}`]) {
      for (const flag of ["--record", "--ab", "--save-bin", "--compare"]) {
        const result = run(flag, hostile);
        assert.equal(result.status, 78, `${flag} ${JSON.stringify(hostile)}: ${result.stderr}`);
        assert.match(result.stderr, /genex-render-perf-refusal: .*"code":"usage"/);
      }
    }
  });

  it("needs exactly one mode", () => {
    for (const args of [[], ["--record", "x", "--compare", "baseline"]]) {
      const result = run(...args);
      assert.equal(result.status, 78, result.stderr);
      assert.match(result.stderr, /"code":"usage"/);
    }
  });

  it("refuses a zero or non-numeric frame count", () => {
    for (const frames of ["0", "x", "1.5", "-3"]) {
      const result = run("--record", "x", "--frames", frames);
      assert.equal(result.status, 78, `${frames}: ${result.stderr}`);
    }
  });
});

describe("render perf gate row", () => {
  // A saved-executable folder in the shape `--save-bin` leaves: with or without its perf_matrix.
  const tierDir = async (withExecutable: boolean) => {
    const dir = await tmpDir("genex-perf-tier-");
    await writeFile(path.join(dir, "SOURCE_SHA"), "0e46c323\n");
    if (withExecutable) await writeFile(path.join(dir, "perf_matrix"), "");
    return dir;
  };

  it("runs the owner's statistic: profile off, the median of 5 interleaved A/B runs against rq0-head", () => {
    // Owner decision 2026-10-13 (1). Gate round 2 found the row still judging off against the stored
    // baseline.json at its best of 3 runs, a record this machine no longer reproduces.
    assert.deepEqual(runPlan(GATE_ARGS), {
      mode: RunMode.Ab,
      name: GATE_TIER,
      profiles: ["off"],
      runs: 5,
      statistic: Statistic.Median,
    });
    assert.equal(GATE_TIER, "rq0-head");
    assert.equal(path.basename(GATE_TIER_DIR), GATE_TIER);
  });

  it("reads a stored-baseline comparison as the best of 3 runs (the developer's quick check)", () => {
    assert.deepEqual(runPlan(["--profiles", "off", "--compare", "baseline"]), {
      mode: RunMode.Compare,
      name: "baseline",
      profiles: ["off"],
      runs: 3,
      statistic: Statistic.Min,
    });
    assert.equal(runPlan(["--ab", "x", "--runs", "7", "--statistic", "min"]).statistic, Statistic.Min);
    assert.equal(runPlan(["--ab", "x", "--runs", "7"]).runs, 7);
  });

  it("skips with no-saved-executable when the gate's tier holds no perf_matrix", async () => {
    const empty = await tierDir(false);
    assert.deepEqual(gateStatus({ tierDir: empty, env: { GENEX_REQUIRE_METAL: "1" } }), {
      run: false,
      skip: GateSkip.NoSavedExecutable,
    });
    assert.deepEqual(gateStatus({ tierDir: path.join(empty, "missing"), env: {} }), {
      run: false,
      skip: GateSkip.NoSavedExecutable,
    });
  });

  it("skips with no-metal when the executable is saved but GENEX_REQUIRE_METAL is unset", async () => {
    const dir = await tierDir(true);
    assert.deepEqual(gateStatus({ tierDir: dir, env: {} }), { run: false, skip: GateSkip.NoMetal });
    assert.deepEqual(gateStatus({ tierDir: dir, env: { GENEX_REQUIRE_METAL: "0" } }), {
      run: false,
      skip: GateSkip.NoMetal,
    });
  });

  it("runs when the executable is saved and the real GPU is required", async () => {
    assert.deepEqual(gateStatus({ tierDir: await tierDir(true), env: { GENEX_REQUIRE_METAL: "1" } }), { run: true });
  });

  it("the gate itself: off-profile p95 within 1.10 x rq0-head, median of 5 interleaved runs, on the real GPU", (t) => {
    const status = gateStatus({ tierDir: GATE_TIER_DIR, env: process.env });
    if (!status.run) {
      t.skip(`skipped: ${status.skip}`);
      return;
    }
    const result = spawnSync(process.execPath, [SCRIPT, ...GATE_ARGS], {
      cwd: REPO,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /median of 5 interleaved runs/);
    // The report (each run of both sides, the paired ratios and the gated median) stays in the test's output.
    for (const line of result.stdout.split("\n")) t.diagnostic(line);
  });
});

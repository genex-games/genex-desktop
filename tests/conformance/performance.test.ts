import assert from "node:assert/strict";
import { it } from "node:test";
import {
  cadence,
  comparePerformance,
  preservedChecks,
  optimizationAllowance,
} from "../../src/harness-seed/loop/performance.ts";
export function sample(tree = "b", calls: number | null = 100, frame = 16) {
  const metric = (value: number | null) => ({
    value,
    unit: "test",
    reason: value === null ? "unavailable" : null,
    provenance: "test",
  });
  return {
    schemaVersion: 1,
    backend: "webgl",
    renderer: "WebGLRenderer",
    version: "0.185.1",
    scope: "world",
    scenarioId: "default",
    configuration: { width: 960, height: 600 },
    revision: { snapshotId: null, tree, commit: tree },
    metrics: { frameMs: metric(frame), fps: metric(1000 / frame), drawCalls: metric(calls), triangles: metric(1000) },
    inventory: { objects: 10 },
  };
}
const three = (tree: string, calls: number | null = 100, frames = [16, 16, 16]) =>
  frames.map((f) => sample(tree, calls, f));
it("cadence is elapsed-time weighted and never creates zero FPS from missing frames", () => {
  assert.equal(cadence([]).fps, null);
  assert.equal(cadence(Array(29).fill(10)).fps, null);
  assert.equal(cadence([...Array(30).fill(10), ...Array(30).fill(30)]).fps, 50);
});
it("a reproducible draw-call reduction can win at the same display ceiling", () => {
  const r = comparePerformance(three("b") as never, three("c", 50) as never, sample() as never);
  assert.equal(r.improved, true);
  assert.deepEqual(r.gains, ["drawCalls"]);
});
it("object counts, no-op, noise and temporal drift cannot establish a win", () => {
  const b = three("b"),
    c = three("c");
  c.forEach((s) => (s.inventory.objects = 1));
  assert.equal(comparePerformance(b as never, c as never, sample() as never).improved, false);
  assert.equal(
    comparePerformance(
      three("b", 100, [15, 17, 16]) as never,
      three("c", 100, [14, 17, 15]) as never,
      sample() as never,
    ).improved,
    false,
  );
  assert.equal(
    comparePerformance(
      three("b", 100, [20, 20, 20]) as never,
      three("c", 100, [16, 16, 16]) as never,
      sample("b", 100, 16) as never,
    ).improved,
    false,
  );
});
it("mismatched resolution/backend/version, missing provenance, missing previously measured data reject", () => {
  for (const field of ["backend", "version", "scope"] as const) {
    const c = three("c", 50);
    c[1]![field] = "different";
    assert.equal(comparePerformance(three("b") as never, c as never, sample() as never).comparable, false);
  }
  const c = three("c", 50);
  c[0]!.configuration.width = 100;
  assert.equal(comparePerformance(three("b") as never, c as never, sample() as never).comparable, false);
  assert.equal(comparePerformance(three("b") as never, three("c", null) as never, sample() as never).improved, false);
  assert.equal(
    comparePerformance(three("b") as never, three("c", 50, [NaN, 16, 16]) as never, sample() as never).improved,
    false,
  );
});
it("faster counters do not hide a cadence regression and missing checks are losses", () => {
  assert.equal(
    comparePerformance(three("b") as never, three("c", 50, [30, 30, 30]) as never, sample() as never).improved,
    false,
  );
  assert.deepEqual(preservedChecks([{ id: "part/x", pass: true }], [{ id: "part/x", pass: null }]), [
    "part/x: previously passing check unmeasured",
  ]);
  assert.equal(optimizationAllowance(3_600_000), 360_000);
  assert.equal(optimizationAllowance(86_400_000), 600_000);
});

it("unstable playback cannot be hidden behind an otherwise repeatable draw-call reduction", () => {
  const r = comparePerformance(
    three("b", 100, [16, 30, 45]) as never,
    three("c", 50, [30, 45, 60]) as never,
    sample("b", 100, 45) as never,
  );
  assert.equal(r.comparable, false);
  assert.equal(r.improved, false);
});

it("says why a comparison was refused, regressed, or found no win", () => {
  const cases: Array<[string, unknown, unknown, unknown, string]> = [
    ["too few samples", [], three("c"), sample(), "three paired samples and a final baseline bracket are required"],
    ["no bracket", three("b"), three("c"), null, "three paired samples and a final baseline bracket are required"],
    [
      "a changed backend",
      three("b"),
      three("c").map((s) => ({ ...s, backend: "webgpu" })),
      sample(),
      "backend changed or unavailable",
    ],
    ["no cadence", three("b"), three("c", 50, [0, 16, 16]), sample(), "live playback cadence unavailable"],
    [
      "another revision in the candidate",
      three("b"),
      [sample("c"), sample("d"), sample("c")],
      sample(),
      "sample revision changed or unavailable",
    ],
    [
      "unstable cadence",
      three("b", 100, [16, 30, 45]),
      three("c", 50, [30, 45, 60]),
      sample("b", 100, 45),
      "Playback conditions varied too much for a reliable comparison",
    ],
    ["draw calls lost", three("b"), three("c", null), sample(), "drawCalls became unmeasured"],
    ["draw calls up", three("b"), three("c", 150), sample(), "drawCalls regressed"],
    ["nothing moved", three("b"), three("c"), sample(), "No verified improvement beyond observed variation"],
    ["draw calls down", three("b"), three("c", 50), sample(), "Verified reduction in world draw calls"],
  ];
  for (const [name, before, after, bracket, reason] of cases)
    assert.equal(comparePerformance(before as never, after as never, bracket as never).reason, reason, name);
});
it("a native run's samples compare as a web run's do: a draw-call reduction can win (PROF-0c)", () => {
  const native = (tree: string, calls: number) =>
    three(tree, calls).map((s) => ({ ...s, backend: "native", renderer: "genex-render", version: "0.1.0" }));
  const r = comparePerformance(native("b", 100) as never, native("c", 50) as never, native("b", 100)[0] as never);
  assert.equal(r.comparable, true, r.reason);
  assert.equal(r.improved, true);
});

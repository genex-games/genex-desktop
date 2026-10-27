/**
 * The worst case at default limits (CONTRACT.md §11.2) in the WASM build, in this Node process: the
 * scene, ticks and variants of `native/genex-rust/crates/genex-physics/tests/bench.rs`, call for
 * call, through `@genex-ai/physics` as `node scripts/physics-wasm.ts` built it
 * (`.studio-dev/build/physics-wasm/`, or the folder `--package` names).
 *
 *   node scripts/physics-wasm-bench.ts [--package <folder>] [--seconds <measured>]
 *
 * It prints, per variant and schedule, how long building the scene took (the static world, 512
 * spawns, 64 joints), the mean, p99 and worst wall time per `step()` and per tick (commands, 64
 * queries and the step, plus every body's state imported back in the corrections variant), and
 * the stateHash the run ends on: with the default 10 measured seconds it must equal the native
 * bench's (`cargo test --release --test bench -- --ignored --nocapture`), the same build on
 * another target (§1.2). A measurement, never a check: it exits 0 whatever the numbers.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Physics from "../native/genex-rust/crates/genex-physics/js/index.d.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_PACKAGE = path.join(REPO, ".studio-dev/build/physics-wasm");
const BODIES = 512;
const JOINTS = 64;
const CCD = 16;
const RAYS = 32;
const CASTS = 16;
const OVERLAPS = 16;
const HEAP_SPACING = 0.85;
const WARMUP_SECONDS = 1;
const DEFAULT_MEASURED_SECONDS = 10;
const P99 = 0.99;
const MS_PER_SIXTIETH_TICK = 1 / 60;
const IDENTITY: Physics.Quat = [0, 0, 0, 1];
const SCHEDULES = [
  { dt: 1 / 60, substeps: 1 },
  { dt: 1 / 20, substeps: 3 },
] as const;

interface Options {
  packageDir: string;
  measuredSeconds: number;
}

function options(argv: string[]): Options {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  const measured = Number(value("--seconds") ?? DEFAULT_MEASURED_SECONDS);
  return { packageDir: value("--package") ?? DEFAULT_PACKAGE, measuredSeconds: measured };
}

const pose = (p: Physics.Vec3): Physics.Pose => ({ p, q: IDENTITY });
const ball = (radius: number): Physics.Shape => ({ kind: "sphere", radius });
/** The caller's y-up vector in the z-up frame (bench.rs `to`). */
const toZ = (v: Physics.Vec3): Physics.Vec3 => [v[0], -v[2], v[1]];
const pad = (n: number, width: number) => String(n).padStart(width, "0");
const ccdKey = (i: number) => `ccd.${pad(i, 2)}`;

/** An 8-point hull, a slightly skewed box (bench's `common::hull`). */
function hull(half: number): Physics.Shape {
  const points: Physics.Vec3[] = [];
  for (let i = 0; i < 8; i += 1) {
    const s = (bit: number) => ((i & bit) === 0 ? -half : half);
    points.push([s(1) * 1.1, s(2), s(4) * 0.9]);
  }
  return { kind: "hull", points };
}

function heapShape(i: number): Physics.Shape {
  const shapes: Physics.Shape[] = [
    { kind: "box", half: [0.4, 0.4, 0.4] },
    ball(0.4),
    hull(0.35),
    { kind: "capsule", halfHeight: 0.25, radius: 0.3, axis: "x" },
  ];
  return shapes[i % 4];
}

/** The heap's `i`th body (bench's `common::heap_body`, z-up). */
function heapBody(i: number): Physics.BodyDesc {
  const [x, z, layer] = [i % 8, Math.floor(i / 8) % 8, Math.floor(i / 64)];
  const p: Physics.Vec3 = [
    (x - 3.5) * HEAP_SPACING + layer * 0.07,
    1.0 + layer * HEAP_SPACING,
    (z - 3.5) * HEAP_SPACING - layer * 0.05,
  ];
  const collider: Physics.ColliderDesc = { key: "c", shape: heapShape(i), events: i % 5 === 0 };
  return {
    key: `heap.${pad(i, 3)}`,
    type: "dynamic",
    pose: pose(toZ(p)),
    colliders: [collider],
    kind: i % 2 === 0 ? "crate" : "prop",
  };
}

function must(result: Physics.Result<object>, what: string): void {
  if (!result.ok) throw new Error(`${what}: ${result.code} ${result.detail}`);
}

function scene(physics: typeof Physics, dt: number, substeps: number): Physics.World {
  const made = physics.World.create({
    contract: "1.0",
    dt,
    substeps,
    gravity: [0, 0, -9.81],
    upAxis: "z",
    lengthUnit: 1,
  });
  if (!made.ok) throw new Error(`world: ${made.code}`);
  const w = made.world;
  must(
    w.addStaticWorld({
      boxes: [
        [-60, -60, -1, 60, 60, 0],
        [-8, 12, 0, 8, 13, 3],
      ],
      ramps: [[8, -8, 0, 14, 8, 2, 0, 2, 0]],
    }),
    "floor",
  );
  for (let i = 0; i < BODIES - CCD; i += 1) must(w.spawn(heapBody(i)), "heap body");
  for (let i = 0; i < CCD; i += 1) {
    const collider: Physics.ColliderDesc = { key: "c", shape: ball(0.12), events: true };
    must(
      w.spawn({
        key: ccdKey(i),
        type: "dynamic",
        pose: pose([-30, (i - 7.5) * 0.8, 1]),
        colliders: [collider],
        ccd: true,
      }),
      "ccd ball",
    );
  }
  for (let j = 0; j < JOINTS; j += 1) {
    const [a, b] = [`heap.${pad(2 * j, 3)}`, `heap.${pad(2 * j + 1, 3)}`];
    must(
      w.addJoint({ key: `joint.${pad(j, 2)}`, a, b, type: "ball", anchorA: [0.42, 0, 0], anchorB: [-0.42, 0, 0] }),
      "joint",
    );
  }
  return w;
}

/** The tick's commands (bench.rs `commands`). */
function commands(tick: number, ticksPerSecond: number): Physics.Command[] {
  const out: Physics.Command[] = [];
  if (tick % ticksPerSecond === 0) {
    for (let i = 0; i < CCD; i += 1) {
      const key = ccdKey(i);
      out.push({ setPose: { key, pose: pose([-30, (i - 7.5) * 0.8, 1 + (i % 4)]), resetVelocity: true, wake: true } });
      out.push({ setVelocity: { key, linvel: [120, 0, 0] } });
    }
  }
  if (tick % Math.max(Math.floor(ticksPerSecond / 2), 1) === 0) {
    out.push({ areaPush: { center: [0, 0, -0.5], radius: 8, strength: 6, falloff: 1 } });
  }
  return out;
}

function queries(w: Physics.World, tick: number): void {
  const t = (tick % 64) * 0.1;
  for (let i = 0; i < RAYS; i += 1) must(w.ray([(i - 15.5) * 0.25, -10, 1 + t * 0.2], [0, 1, -0.05], 30), "ray");
  for (let i = 0; i < CASTS; i += 1)
    must(w.shapeCast(ball(0.3), pose([-10, (i - 7.5) * 0.5, 1.5]), [1, 0, 0], 25), "cast");
  for (let i = 0; i < OVERLAPS; i += 1) {
    const [x, y] = [(i % 4) * 1.5 - 2.25, Math.floor(i / 4) * 1.5 - 2.25];
    must(w.overlap(ball(0.8), pose([x, y, 1 + t * 0.1])), "overlap");
  }
}

function corrections(w: Physics.World): void {
  for (const body of w.bodies()) {
    if (body.type !== "dynamic") continue;
    const state = w.exportBodyState(body.key);
    if (state) must(w.importBodyState(body.key, state), "import");
  }
}

function summary(samples: number[]): { mean: number; p99: number; worst: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, x) => sum + x, 0) / sorted.length;
  const p99 = sorted[Math.max(Math.ceil(sorted.length * P99) - 1, 0)];
  return { mean, p99, worst: sorted[sorted.length - 1] };
}

function run(physics: typeof Physics, dt: number, substeps: number, correct: boolean, measuredSeconds: number) {
  const ticksPerSecond = Math.round(1 / dt);
  const built = performance.now();
  const w = scene(physics, dt, substeps);
  const buildMs = performance.now() - built;
  const warmup = Math.round(WARMUP_SECONDS / dt);
  const measured = Math.round(measuredSeconds / dt);
  const [steps, ticks]: number[][] = [[], []];
  for (let tick = 0; tick < warmup + measured; tick += 1) {
    const start = performance.now();
    const applied = w.apply(commands(tick, ticksPerSecond), "each");
    const refused = Array.isArray(applied) ? applied.find((outcome) => !outcome.ok) : applied;
    if (refused) throw new Error(`command: ${JSON.stringify(refused)}`);
    if (correct) corrections(w);
    queries(w, tick);
    const beforeStep = performance.now();
    must(w.step(), "step");
    const end = performance.now();
    if (tick < warmup) continue;
    steps.push(end - beforeStep);
    ticks.push(end - start);
  }
  const perSixtieth = MS_PER_SIXTIETH_TICK / dt;
  const tick = summary(ticks);
  const stats = w.stats();
  const result = {
    schedule: `dt 1/${ticksPerSecond} x${substeps}`,
    corrections: correct,
    measuredTicks: measured,
    buildMs,
    step: summary(steps),
    tick,
    meter: { meanMs: tick.mean * perSixtieth, worstTickMs: tick.worst * perSixtieth },
    bodies: stats.bodies,
    memoryBytes: stats.memoryBytes,
    stateHash: w.stateHash(),
  };
  w.free();
  return result;
}

async function main(): Promise<void> {
  const { packageDir, measuredSeconds } = options(process.argv.slice(2));
  const physics: typeof Physics = await import(pathToFileURL(path.join(packageDir, "node.js")).href);
  console.log(JSON.stringify({ buildId: physics.buildId(), node: process.version, arch: process.arch }));
  for (const correct of [false, true]) {
    for (const { dt, substeps } of SCHEDULES) {
      console.log(JSON.stringify(run(physics, dt, substeps, correct, measuredSeconds)));
    }
  }
}

await main();

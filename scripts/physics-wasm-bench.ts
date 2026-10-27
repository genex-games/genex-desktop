/**
 * The worst case at default limits (CONTRACT.md §11.2) in the WASM build, in this Node process: the
 * scene, ticks and variants of `native/genex-rust/crates/genex-physics/tests/bench.rs`, call for
 * call, through `@genex-ai/physics` as `node scripts/physics-wasm.ts` built it
 * (`.studio-dev/build/physics-wasm/`, or the folder `--package` names).
 *
 *   node scripts/physics-wasm-bench.ts [--backend wasm|native] [--package <folder>] [--seconds <measured>]
 *
 * It prints, per variant and schedule, how long building the scene took (the static world, 512
 * spawns, 64 joints), the mean, p99 and worst wall time per `step()`, per tick (commands, 64
 * queries and the step, plus every body's state imported back in the corrections variants) and
 * per tick's corrections and queries alone, and the stateHash the run ends on: with the default 10
 * measured seconds the plain and per-body variants must equal the native bench's (`cargo test
 * --release --test bench -- --ignored --nocapture`), the same build on another target (§1.2).
 *
 * The variants: `plain` (no corrections, one call per query, as bench.rs), `plain-many` (the 64
 * queries as one `queryMany`, §19.2), `per-body` (every body's state exported and imported back
 * one call each, as bench.rs) and `bulk` (the same corrections as one `exportChanged` and one
 * `importStates`, §19.1, with `queryMany`). The bulk variants end on the same stateHash as their
 * one-call-each twins. `room-tick` runs a room's tick as one `runTick` (§17.10's steps 3-11: the
 * commands, the step, then the 64 queries), one round trip on the native core; it ends on `plain`'s
 * stateHash, as queries change no state.
 *
 * `--backend native` runs the same through `@genex-ai/physics-native` (`node scripts/physics-native.ts`,
 * `.studio-dev/build/physics-native/` or `--package`): one `genex-physics-room` process per world,
 * every call a blocking round trip over its FIFOs, so each time includes the IPC. Its rows add
 * `sidecarCpuMs`, the process's own CPU time per tick (`cpuNs`, mean).
 *
 * A measurement, never a check: it exits 0 whatever the numbers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Physics from "../native/genex-rust/crates/genex-physics/js/index.d.ts";
import type * as Native from "../native/genex-rust/crates/genex-physics/js/native.d.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
/** The package each backend loads by default. */
const DEFAULT_PACKAGE = {
  wasm: path.join(REPO, ".studio-dev/build/physics-wasm"),
  native: path.join(REPO, ".studio-dev/build/physics-native"),
} as const;
/** The native core's per-call deadline: generous, a measurement is not a room. */
const NATIVE_DEADLINE_MS = 5_000;
const NS_PER_MS = 1e6;
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

/** How a tick corrects every body: not at all, one export and import call per body, or in bulk. */
const Correction = { None: "none", PerBody: "per-body", Bulk: "bulk" } as const;
type Correction = (typeof Correction)[keyof typeof Correction];
/** How a tick runs its 64 queries: one call each, one `queryMany`, or in the tick's one `runTick`. */
const QueryMode = { Single: "single", Many: "many", Tick: "tick" } as const;
type QueryMode = (typeof QueryMode)[keyof typeof QueryMode];

interface Variant {
  name: string;
  correction: Correction;
  queries: QueryMode;
}

const VARIANTS: readonly Variant[] = [
  { name: "plain", correction: Correction.None, queries: QueryMode.Single },
  { name: "plain-many", correction: Correction.None, queries: QueryMode.Many },
  { name: "per-body", correction: Correction.PerBody, queries: QueryMode.Single },
  { name: "bulk", correction: Correction.Bulk, queries: QueryMode.Many },
  { name: "room-tick", correction: Correction.None, queries: QueryMode.Tick },
];

/** The two cores. */
const BackendName = { Wasm: "wasm", Native: "native" } as const;
type BackendName = (typeof BackendName)[keyof typeof BackendName];

/** One tick in one call, as the package's `tickWorld` / `NativeCore.runTick` take it. */
type TickFn = (world: Physics.World, input: Native.TickInput) => Native.TickOutput | Physics.Failure;

/** What a run drives: the package (or its shape over native cores) and its one-call tick. */
export interface BenchBackend {
  name: BackendName;
  physics: typeof Physics;
  tick: TickFn;
  close(): void;
}

interface Options {
  backend: BackendName;
  packageDir: string;
  measuredSeconds: number;
}

function options(argv: string[]): Options {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  };
  const measured = Number(value("--seconds") ?? DEFAULT_MEASURED_SECONDS);
  const backend = value("--backend") ?? BackendName.Wasm;
  if (backend !== BackendName.Wasm && backend !== BackendName.Native) throw new Error(`unknown backend ${backend}`);
  return { backend, packageDir: value("--package") ?? DEFAULT_PACKAGE[backend], measuredSeconds: measured };
}

/** The WASM package and its internal `tickWorld` (`core.js`). */
async function wasmBackend(packageDir: string): Promise<BenchBackend> {
  const physics: typeof Physics = await import(pathToFileURL(path.join(packageDir, "node.js")).href);
  const core: { tickWorld: TickFn } = await import(pathToFileURL(path.join(packageDir, "core.js")).href);
  return { name: BackendName.Wasm, physics, tick: core.tickWorld, close: () => {} };
}

/** `@genex-ai/physics-native` with its own binary: one process per world, each world's core kept for `runTick`. */
export async function nativeBackend(packageDir: string, deadlineMs = NATIVE_DEADLINE_MS): Promise<BenchBackend> {
  const native: typeof Native = await import(pathToFileURL(path.join(packageDir, "native.js")).href);
  const binary = native.packagedBinary();
  if (binary === undefined) throw new Error(`no ${native.platformKey()} binary in ${packageDir}`);
  const dir = mkdtempSync(path.join(os.tmpdir(), "gxph-bench-"));
  const options = { ...binary, dir, deadlineMs };
  const cores = new WeakMap<Physics.World, Native.NativeCore>();
  const probe = native.createNativeCore(options);
  if (!probe.ok) throw new Error(`native core: ${probe.detail}`);
  const buildId = probe.core.buildId();
  probe.core.close();
  const create = (desc: Physics.WorldDesc): Physics.Result<{ world: Physics.World }> => {
    const started = native.createNativeCore(options);
    if (!started.ok) return started;
    const made = started.core.createWorld(desc);
    if (made.ok) cores.set(made.world, started.core);
    else started.core.close();
    return made;
  };
  const tick: TickFn = (world, input) => {
    const core = cores.get(world);
    if (core === undefined) throw new Error("a world no native core made");
    return core.runTick(input);
  };
  const physics = { buildId: () => buildId, PhysicsError: native.PhysicsError, World: { create } };
  return {
    name: BackendName.Native,
    physics: physics as unknown as typeof Physics,
    tick,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
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

/** The worst-case scene (bench.rs's): 496 heap bodies, 16 CCD balls, 64 joints on a static floor. */
export function scene(physics: Pick<typeof Physics, "World">, dt: number, substeps: number): Physics.World {
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
export function commands(tick: number, ticksPerSecond: number): Physics.Command[] {
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

/** The tick's 64 queries (bench.rs `queries`), in its order, in their JSON form (§13). */
export function queryList(tick: number): Physics.Query[] {
  const t = (tick % 64) * 0.1;
  const out: Physics.Query[] = [];
  for (let i = 0; i < RAYS; i += 1) {
    out.push({ ray: { origin: [(i - 15.5) * 0.25, -10, 1 + t * 0.2], dir: [0, 1, -0.05], maxDist: 30 } });
  }
  for (let i = 0; i < CASTS; i += 1) {
    out.push({ shapeCast: { shape: ball(0.3), pose: pose([-10, (i - 7.5) * 0.5, 1.5]), dir: [1, 0, 0], maxDist: 25 } });
  }
  for (let i = 0; i < OVERLAPS; i += 1) {
    const [x, y] = [(i % 4) * 1.5 - 2.25, Math.floor(i / 4) * 1.5 - 2.25];
    out.push({ overlap: { shape: ball(0.8), pose: pose([x, y, 1 + t * 0.1]) } });
  }
  return out;
}

/** One call per query, as bench.rs makes them (`query()` takes the path `ray`, `shapeCast` and `overlap` take). */
function queriesOneByOne(w: Physics.World, tick: number): void {
  for (const one of queryList(tick)) must(w.query(one), "query");
}

/** The same queries in one crossing (§19.2). */
function queriesAtOnce(w: Physics.World, tick: number): void {
  const answered = w.queryMany(queryList(tick));
  const refused = Array.isArray(answered) ? answered.find((result) => !result.ok) : answered;
  if (refused) throw new Error(`queryMany: ${JSON.stringify(refused)}`);
}

function corrections(w: Physics.World): void {
  for (const body of w.bodies()) {
    if (body.type !== "dynamic") continue;
    const state = w.exportBodyState(body.key);
    if (state) must(w.importBodyState(body.key, state), "import");
  }
}

/**
 * The same corrections in two calls (§19.1): every body changed since tick 0, which is every body
 * here (all dynamic: the floor is the static world), exported flat and imported back as read.
 */
function bulkCorrections(w: Physics.World): void {
  const { keys, data } = w.exportChanged(0);
  must(w.importStates(keys, data), "importStates");
}

function correct(w: Physics.World, correction: Correction): void {
  if (correction === Correction.PerBody) corrections(w);
  if (correction === Correction.Bulk) bulkCorrections(w);
}

function query(w: Physics.World, mode: QueryMode, tick: number): void {
  if (mode === QueryMode.Many) {
    queriesAtOnce(w, tick);
    return;
  }
  queriesOneByOne(w, tick);
}

function summary(samples: number[]): { mean: number; p99: number; worst: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, x) => sum + x, 0) / sorted.length;
  const p99 = sorted[Math.max(Math.ceil(sorted.length * P99) - 1, 0)];
  return { mean, p99, worst: sorted[sorted.length - 1] };
}

/** One `runTick`: the commands, the step and the queries; the sidecar's CPU time in ms. */
function roomTick(backend: BenchBackend, w: Physics.World, tick: number, ticksPerSecond: number): number {
  const out = backend.tick(w, { batches: [commands(tick, ticksPerSecond)], step: true, queries: queryList(tick) });
  if (!out.ok) throw new Error(`tick: ${out.code} ${out.detail}`);
  const refused = [out.step, ...out.results.flat(), ...(Array.isArray(out.answers) ? out.answers : [out.answers])];
  const bad = refused.find((result) => result === undefined || !result.ok);
  if (bad !== undefined) throw new Error(`tick: ${JSON.stringify(bad)}`);
  return out.cpuNs / NS_PER_MS;
}

/** The samples one run takes, each per measured tick. */
interface Samples {
  steps: number[];
  ticks: number[];
  corrected: number[];
  queried: number[];
  sidecar: number[];
}

/** One tick of a call-per-part variant: the commands, corrections, queries and step, each timed. */
function partsTick(w: Physics.World, variant: Variant, tick: number, ticksPerSecond: number, samples?: Samples): void {
  const start = performance.now();
  const applied = w.apply(commands(tick, ticksPerSecond), "each");
  const refused = Array.isArray(applied) ? applied.find((outcome) => !outcome.ok) : applied;
  if (refused) throw new Error(`command: ${JSON.stringify(refused)}`);
  const beforeCorrections = performance.now();
  correct(w, variant.correction);
  const beforeQueries = performance.now();
  query(w, variant.queries, tick);
  const beforeStep = performance.now();
  must(w.step(), "step");
  const end = performance.now();
  if (samples === undefined) return;
  samples.steps.push(end - beforeStep);
  samples.ticks.push(end - start);
  samples.corrected.push(beforeQueries - beforeCorrections);
  samples.queried.push(beforeStep - beforeQueries);
}

/** One tick of the `room-tick` variant, timed whole, with the sidecar's own CPU time. */
function wholeTick(
  backend: BenchBackend,
  w: Physics.World,
  tick: number,
  ticksPerSecond: number,
  samples?: Samples,
): void {
  const start = performance.now();
  const cpuMs = roomTick(backend, w, tick, ticksPerSecond);
  if (samples === undefined) return;
  samples.ticks.push(performance.now() - start);
  samples.sidecar.push(cpuMs);
}

const summarized = (samples: number[]) => (samples.length > 0 ? summary(samples) : null);

function run(backend: BenchBackend, dt: number, substeps: number, variant: Variant, measuredSeconds: number) {
  const ticksPerSecond = Math.round(1 / dt);
  const built = performance.now();
  const w = scene(backend.physics, dt, substeps);
  const buildMs = performance.now() - built;
  const warmup = Math.round(WARMUP_SECONDS / dt);
  const measured = Math.round(measuredSeconds / dt);
  const samples: Samples = { steps: [], ticks: [], corrected: [], queried: [], sidecar: [] };
  for (let tick = 0; tick < warmup + measured; tick += 1) {
    const kept = tick < warmup ? undefined : samples;
    if (variant.queries === QueryMode.Tick) wholeTick(backend, w, tick, ticksPerSecond, kept);
    else partsTick(w, variant, tick, ticksPerSecond, kept);
  }
  const perSixtieth = MS_PER_SIXTIETH_TICK / dt;
  const tick = summary(samples.ticks);
  const stats = w.stats();
  const result = {
    backend: backend.name,
    variant: variant.name,
    schedule: `dt 1/${ticksPerSecond} x${substeps}`,
    measuredTicks: measured,
    buildMs,
    step: summarized(samples.steps),
    tick,
    corrections: summarized(samples.corrected),
    queries: summarized(samples.queried),
    sidecarCpuMs: backend.name === BackendName.Native ? summarized(samples.sidecar) : null,
    meter: { meanMs: tick.mean * perSixtieth, worstTickMs: tick.worst * perSixtieth },
    bodies: stats.bodies,
    memoryBytes: stats.memoryBytes,
    stateHash: w.stateHash(),
  };
  w.free();
  return result;
}

async function main(): Promise<void> {
  const { backend: name, packageDir, measuredSeconds } = options(process.argv.slice(2));
  const backend = name === BackendName.Native ? await nativeBackend(packageDir) : await wasmBackend(packageDir);
  const buildId = backend.physics.buildId();
  console.log(JSON.stringify({ backend: name, buildId, node: process.version, arch: process.arch }));
  try {
    for (const variant of VARIANTS) {
      for (const { dt, substeps } of SCHEDULES) {
        console.log(JSON.stringify(run(backend, dt, substeps, variant, measuredSeconds)));
      }
    }
  } finally {
    backend.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

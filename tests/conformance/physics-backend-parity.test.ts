/**
 * The two cores agree bit for bit: `@genex-ai/physics` (WASM, `.studio-dev/build/physics-wasm-test/`)
 * and `@genex-ai/physics-native` (one process per world, `.studio-dev/build/physics-native-test/`,
 * or `GENEX_PHYSICS_NATIVE_PACKAGE`), stepped in lockstep in this process.
 *
 * - Every conformance vector (§16): each entry's refusals, query answers and step results equal,
 *   `stateHash` equal after every step, `physicsHash` equal; where the vector restores from a
 *   snapshot, each core restores the other's snapshot (§9.4).
 * - The 128-crate scene, 600 ticks, each tick one `runTick` (the native core's one round trip, the
 *   WASM package's same calls in turn): every part of every tick equal, but the measured `cpuNs` and
 *   `memoryBytes` (a 64-bit process allocates otherwise than wasm32, §11.1).
 * - The worst-case bench scene (`scripts/physics-wasm-bench.ts`, 512 bodies, 64 joints, 64 queries a
 *   tick), the same way for 240 ticks.
 * - Both scenes: snapshots restore across the cores in both directions mid-run and the four worlds
 *   then step on with equal `stateHash` and `physicsHash`.
 *
 * Skips without both builds (`GENEX_REQUIRE_TOOLCHAINS=1` makes their absence a failure).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { Vector, VectorStep } from "../../native/genex-rust/crates/genex-physics/js/conformance.js";
import type * as Physics from "../../native/genex-rust/crates/genex-physics/js/index.d.ts";
import type * as Native from "../../native/genex-rust/crates/genex-physics/js/native.d.ts";
import { commands, queryList, scene as benchScene } from "../../scripts/physics-wasm-bench.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const WASM_PACKAGE = path.join(REPO, ".studio-dev/build/physics-wasm-test");
const NATIVE_PACKAGE =
  process.env.GENEX_PHYSICS_NATIVE_PACKAGE ?? path.join(REPO, ".studio-dev/build/physics-native-test");
const VECTORS = path.join(REPO, "native/genex-rust/crates/genex-physics/vectors");
const DEADLINE_MS = 20_000;
const CRATES = 128;
const CRATE_TICKS = 600;
const BENCH_TICKS = 240;
const BENCH_TICKS_PER_SECOND = 60;
/** Where each scene's snapshots cross between the cores, and how long the four worlds step on after. */
const CROSS_AT = { crates: 300, bench: 120 } as const;
const AFTER_CROSS = 60;
const IDENTITY: Physics.Quat = [0, 0, 0, 1];
const Z_UP: Physics.WorldDesc = {
  contract: "1.0",
  dt: 1 / 60,
  substeps: 1,
  gravity: [0, 0, -9.81],
  upAxis: "z",
  lengthUnit: 1,
};

type Package = Pick<typeof Physics, "buildId" | "World">;
type TickFn = (world: Physics.World, input: Native.TickInput) => Native.TickOutput | Physics.Failure;

/** One core: its package shape and its one-call tick. */
interface Core {
  name: string;
  physics: Package;
  tick: TickFn;
}

function needsBuilds(): { skip?: string } {
  const missing = [path.join(WASM_PACKAGE, "core.js"), path.join(NATIVE_PACKAGE, "native.js")].filter(
    (file) => !existsSync(file),
  );
  if (missing.length === 0) return {};
  const what = `the physics test builds (${missing.join(", ")}; node scripts/physics-wasm.ts --test, node scripts/physics-native.ts --test)`;
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${what} absent`);
  return { skip: `not run: ${what} absent` };
}

async function wasmCore(): Promise<Core> {
  const physics: typeof Physics = await import(pathToFileURL(path.join(WASM_PACKAGE, "node.js")).href);
  const core: { tickWorld: TickFn } = await import(pathToFileURL(path.join(WASM_PACKAGE, "core.js")).href);
  return { name: "wasm32", physics, tick: core.tickWorld };
}

async function nativeCore(dir: string): Promise<Core> {
  const native: typeof Native = await import(pathToFileURL(path.join(NATIVE_PACKAGE, "native.js")).href);
  const binary = native.packagedBinary();
  assert.ok(binary, `${NATIVE_PACKAGE} has this host's binary`);
  const options = { ...binary, dir, deadlineMs: DEADLINE_MS };
  const cores = new WeakMap<Physics.World, Native.NativeCore>();
  const probe = native.createNativeCore(options);
  assert.ok(probe.ok, JSON.stringify(probe));
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
    assert.ok(core, "a world a native core made");
    return core.runTick(input);
  };
  return { name: "native", physics: { buildId: () => buildId, World: { create } } as unknown as Package, tick };
}

const gate = needsBuilds();
const rooms = await tmpDir("gxph-parity-");
const cores: Core[] = gate.skip ? [] : [await wasmCore(), await nativeCore(rooms)];
const [wasm, native] = cores;
const opened: Physics.World[] = [];
after(() => {
  for (const world of opened) world.free();
});

function ok<T extends object>(result: Physics.Result<T>, what: string): T {
  assert.ok(result.ok, `${what}: ${JSON.stringify(result)}`);
  return result;
}

/** A world on `core` from `desc` and its static world, freed after the file. */
function open(core: Core, desc: Physics.WorldDesc, statics?: Physics.StaticWorld): Physics.World {
  const { world } = ok(core.physics.World.create(desc), `${core.name} World.create`);
  opened.push(world);
  if (statics !== undefined && statics.boxes.length + statics.ramps.length > 0) {
    ok(world.addStaticWorld(statics), `${core.name} addStaticWorld`);
  }
  return world;
}

/** A pair of worlds stepped in lockstep: [wasm, native]. */
type Pair = [Physics.World, Physics.World];

/** Asserts both worlds of `pair` hold the same state. */
function same(pair: Pair, where: string): void {
  assert.equal(pair[1].stateHash(), pair[0].stateHash(), `${where}: stateHash`);
}

/** Each core restores the other's snapshot into a fresh world; the pair of fresh worlds. */
function crossed(pair: Pair, open: (core: Core) => Physics.World): Pair {
  const fromNative = open(wasm);
  const fromWasm = open(native);
  ok(fromNative.restore(pair[1].snapshot()), "wasm32 restores native's snapshot");
  ok(fromWasm.restore(pair[0].snapshot()), "native restores wasm32's snapshot");
  return [fromNative, fromWasm];
}

/** One vector entry on both worlds, compared part by part. */
function vectorEntry(vector: Vector, pair: Pair, entry: VectorStep, where: string): void {
  if (entry.apply !== undefined) {
    const mode = vector.mode === "atomic" ? "atomic" : "each";
    const [a, b] = pair.map((world) => world.apply(entry.apply as Physics.Command[], mode as "each"));
    assert.deepEqual(b, a, `${where}: apply`);
  }
  for (const query of entry.query ?? [])
    assert.deepEqual(pair[1].query(query), pair[0].query(query), `${where}: query`);
  for (let i = 0; i < (entry.repeat ?? 1); i += 1) {
    const [a, b] = pair.map((world) => world.step());
    assert.deepEqual(b, a, `${where}: step ${i}`);
    same(pair, `${where}: step ${i}`);
  }
}

function vectorFiles(): string[] {
  return readdirSync(VECTORS)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

describe("the native and WASM cores step every conformance vector in lockstep (§16)", gate, () => {
  for (const file of gate.skip ? [] : vectorFiles()) {
    it(`${file}: equal results and stateHash every step, snapshots restoring across`, () => {
      const vector: Vector = JSON.parse(readFileSync(path.join(VECTORS, file), "utf8"));
      const openOn = (core: Core) => open(core, vector.world, vector.static);
      let pair: Pair = [openOn(wasm), openOn(native)];
      assert.equal(pair[1].physicsHash(), pair[0].physicsHash(), "physicsHash");
      for (const [index, entry] of vector.steps.entries()) {
        if (entry.snapshotRestore) pair = crossed(pair, openOn);
        vectorEntry(vector, pair, entry, `${file} entry ${index}`);
      }
      same(pair, file);
      assert.equal(pair[1].physicsHash(), pair[0].physicsHash(), "physicsHash at the end");
    });
  }
});

/** A tick's output without what each core measures for itself. */
function comparable(out: Native.TickOutput | Physics.Failure): unknown {
  if (!out.ok) return out;
  const { cpuNs: _cpu, memoryBytes: _memory, ...rest } = out;
  return rest;
}

/** Runs `ticks` ticks of `input(tick)` on both worlds, every part equal, every stateHash equal. */
function lockstep(
  pair: Pair,
  from: number,
  ticks: number,
  input: (tick: number) => Native.TickInput,
  where: string,
): void {
  for (let tick = from; tick < from + ticks; tick += 1) {
    const outs = [wasm.tick(pair[0], input(tick)), native.tick(pair[1], input(tick))];
    assert.ok(outs[1].ok && outs[0].ok, `${where} tick ${tick}: ${JSON.stringify(outs[1])}`);
    assert.deepEqual(comparable(outs[1]), comparable(outs[0]), `${where} tick ${tick}`);
    same(pair, `${where} tick ${tick}`);
  }
}

/** Steps four worlds (the pair and its crossed restores) on together, all four equal. */
function crossAndStep(
  pair: Pair,
  open: (core: Core) => Physics.World,
  input: (tick: number) => Native.TickInput,
  from: number,
  where: string,
): void {
  const restored = crossed(pair, open);
  same([pair[0], restored[0]], `${where}: wasm32 restored from native`);
  same([restored[1], pair[1]], `${where}: native restored from wasm32`);
  lockstep(pair, from, AFTER_CROSS, input, `${where} (original pair)`);
  lockstep(restored, from, AFTER_CROSS, input, `${where} (restored pair)`);
  same([pair[0], restored[0]], `${where}: after stepping on`);
  assert.equal(restored[1].physicsHash(), pair[0].physicsHash(), `${where}: physicsHash`);
}

/** The 128-crate scene: a floor and a 8 × 4 × 4 stack of crates and balls, z up. */
function crateScene(core: Core): Physics.World {
  const world = open(core, Z_UP, { boxes: [[-40, -40, -1, 40, 40, 0]], ramps: [] });
  const spawns: Physics.Command[] = [];
  for (let i = 0; i < CRATES; i += 1) {
    const [x, y, z] = [i % 8, Math.floor(i / 8) % 4, Math.floor(i / 32)];
    const shape: Physics.Shape =
      i % 3 === 0 ? { kind: "sphere", radius: 0.35 } : { kind: "box", half: [0.35, 0.35, 0.35] };
    const desc: Physics.BodyDesc = {
      key: `crate.${String(i).padStart(3, "0")}`,
      kind: "crate",
      type: "dynamic",
      pose: { p: [(x - 3.5) * 0.8, (y - 1.5) * 0.8, 0.5 + z * 0.8], q: IDENTITY },
      colliders: [{ key: "c", shape, events: i % 4 === 0 }],
    };
    spawns.push({ spawn: desc });
  }
  const applied = world.apply(spawns, "each");
  assert.ok(Array.isArray(applied) && applied.every((result) => result.ok), JSON.stringify(applied));
  return world;
}

/** A room-like tick on the crates: a push now and then, an export since the last tick, a few queries. */
function crateTick(tick: number): Native.TickInput {
  const batch: Physics.Command[] =
    tick % 30 === 0
      ? [
          { areaPush: { center: [Math.sin(tick) * 2, 0, 0], radius: 4, strength: 5, falloff: 1 } },
          { impulse: { key: `crate.${String(tick % CRATES).padStart(3, "0")}`, j: [0, 0, 3] } },
        ]
      : [];
  return {
    batches: [batch, [{ wake: { key: "nobody" } }]],
    step: true,
    exportSince: Math.max(tick - 1, 0),
    queries: [
      { ray: { origin: [0, 0, 10], dir: [0, 0, -1], maxDist: 20 } },
      { overlap: { shape: { kind: "sphere", radius: 2 }, pose: { p: [0, 0, 1], q: IDENTITY } } },
    ],
  };
}

describe("the native and WASM cores agree tick for tick on the room scenes", gate, () => {
  it(`steps the ${CRATES}-crate scene ${CRATE_TICKS} ticks with every tick's parts equal, and restores across`, () => {
    const pair: Pair = [crateScene(wasm), crateScene(native)];
    assert.equal(pair[1].physicsHash(), pair[0].physicsHash());
    lockstep(pair, 0, CROSS_AT.crates, crateTick, "crates");
    crossAndStep(pair, (core) => crateScene(core), crateTick, CROSS_AT.crates, "crates");
    lockstep(pair, CROSS_AT.crates + AFTER_CROSS, CRATE_TICKS - CROSS_AT.crates - AFTER_CROSS, crateTick, "crates");
    assert.equal(pair[1].physicsHash(), pair[0].physicsHash());
  });

  it(`steps the worst-case bench scene ${BENCH_TICKS} ticks with every tick's parts equal, and restores across`, () => {
    const benchOn = (core: Core) => {
      const world = benchScene(core.physics as typeof Physics, 1 / BENCH_TICKS_PER_SECOND, 1);
      opened.push(world);
      return world;
    };
    const input = (tick: number): Native.TickInput => ({
      batches: [commands(tick, BENCH_TICKS_PER_SECOND)],
      step: true,
      exportSince: Math.max(tick - 1, 0),
      queries: queryList(tick),
    });
    const pair: Pair = [benchOn(wasm), benchOn(native)];
    lockstep(pair, 0, CROSS_AT.bench, input, "bench");
    crossAndStep(pair, benchOn, input, CROSS_AT.bench, "bench");
    lockstep(pair, CROSS_AT.bench + AFTER_CROSS, BENCH_TICKS - CROSS_AT.bench - AFTER_CROSS, input, "bench");
    assert.equal(pair[1].physicsHash(), pair[0].physicsHash());
  });
});

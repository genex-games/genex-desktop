/**
 * A room tick in one crossing is exactly its separate calls: `tickWorld` (`@genex-ai/physics`, its
 * `world_tick_frame` export) and `NativeCore.runTick` (`@genex-ai/physics-native`, one `Tick` frame)
 * cross a tick in the binary form of `crates/genex-physics-binding/src/tick.rs`, and every part of
 * their result must equal what `apply(batch, "each")` per batch, `step()`, `exportChanged(since)` and
 * `queryMany(queries)` give on a twin world, the world after them too.
 *
 * - A 128-crate scene with contact events, a sensor and an escaping body, 600 ticks on each backend.
 * - A table of hostile and odd tick inputs (refusals of the wrapper's own encoder, numbers at every
 *   edge, strings JSON cannot carry, inputs past the budget, getters and Proxies), each tick's result
 *   equal to the twin's calls and both worlds equal after it.
 * - A tick encoded while another is (a getter calling `tickWorld`) gives both their calls' results.
 *
 * Runs on the test builds (`node scripts/physics-wasm.ts --test`, `node scripts/physics-native.ts
 * --test`); without one its rows skip (`GENEX_REQUIRE_TOOLCHAINS=1` makes its absence a failure).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type * as Physics from "../../native/genex-rust/crates/genex-physics/js/index.d.ts";
import type * as Native from "../../native/genex-rust/crates/genex-physics/js/native.d.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const WASM_PACKAGE = process.env.GENEX_PHYSICS_PACKAGE ?? path.join(REPO, ".studio-dev/build/physics-wasm-test");
const NATIVE_PACKAGE =
  process.env.GENEX_PHYSICS_NATIVE_PACKAGE ?? path.join(REPO, ".studio-dev/build/physics-native-test");
const DEADLINE_MS = 20_000;
const CRATES = 128;
const SCENE_TICKS = 600;
const IDENTITY: Physics.Quat = [0, 0, 0, 1];
const Z_UP: Physics.WorldDesc = {
  contract: "1.0",
  dt: 1 / 60,
  substeps: 1,
  gravity: [0, 0, -9.81],
  upAxis: "z",
  lengthUnit: 1,
  limits: { worldExtent: 60 },
};
/** Past the per-call character budget at the default limits (8 Mi plus a heightfield's 24 each). */
const OVER_BUDGET_CHARS = 40 * 1024 * 1024;

type TickFn = (world: Physics.World, input: Native.TickInput) => Native.TickOutput | Physics.Failure;
interface Backend {
  name: string;
  create(desc: Physics.WorldDesc): Physics.World;
  tick: TickFn;
}

function needsBuild(file: string, what: string): { skip?: string } {
  if (existsSync(file)) return {};
  const missing = `the ${what} test build (${file})`;
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

const wasmGate = needsBuild(path.join(WASM_PACKAGE, "core.js"), "WASM");
const nativeGate = needsBuild(path.join(NATIVE_PACKAGE, "native.js"), "native");
const opened: Physics.World[] = [];
const closers: (() => void)[] = [];
after(() => {
  for (const world of opened) world.free();
  for (const close of closers) close();
});

async function wasmBackend(): Promise<Backend> {
  const physics: typeof Physics = await import(pathToFileURL(path.join(WASM_PACKAGE, "node.js")).href);
  const core: { tickWorld: TickFn } = await import(pathToFileURL(path.join(WASM_PACKAGE, "core.js")).href);
  const create = (desc: Physics.WorldDesc) => {
    const made = physics.World.create(desc);
    assert.ok(made.ok, JSON.stringify(made));
    opened.push(made.world);
    return made.world;
  };
  return { name: "wasm32", create, tick: core.tickWorld };
}

async function nativeBackend(): Promise<Backend> {
  const native: typeof Native = await import(pathToFileURL(path.join(NATIVE_PACKAGE, "native.js")).href);
  const binary = native.packagedBinary();
  assert.ok(binary, "the package has this host's binary");
  const dir = await tmpDir("gxph-tick-frame-");
  const cores = new WeakMap<Physics.World, Native.NativeCore>();
  const create = (desc: Physics.WorldDesc) => {
    const started = native.createNativeCore({ ...binary, dir, deadlineMs: DEADLINE_MS });
    assert.ok(started.ok, JSON.stringify(started));
    closers.push(() => started.core.close());
    const made = started.core.createWorld(desc);
    assert.ok(made.ok, JSON.stringify(made));
    cores.set(made.world, started.core);
    return made.world;
  };
  const tick: TickFn = (world, input) => {
    const core = cores.get(world);
    assert.ok(core, "a world a native core made");
    return core.runTick(input);
  };
  return { name: "native", create, tick };
}

/** A tick as its separate calls on `world`, in `runTick`'s result shape. */
function separately(world: Physics.World, input: Native.TickInput): unknown {
  const batches = input.batches ?? [];
  const out: Record<string, unknown> = { ok: true };
  const results = batches.map((batch) => world.apply(batch, "each"));
  const step = input.step === true ? world.step() : undefined;
  const exported = input.exportSince === undefined ? undefined : world.exportChanged(input.exportSince);
  const answers = input.queries === undefined ? undefined : world.queryMany(input.queries);
  out.tick = world.tick;
  out.results = results;
  if (step !== undefined) out.step = step;
  if (exported !== undefined) out.exported = exported;
  if (answers !== undefined) out.answers = answers;
  return out;
}

/** A tick's result without what each core measures for itself. */
function comparable(out: Native.TickOutput | Physics.Failure): unknown {
  if (!out.ok) return out;
  const { cpuNs: _cpu, memoryBytes: _memory, ...rest } = out;
  return rest;
}

/** One tick on both twins: `input()` is made fresh for each, so a getter or a Proxy reads its own. */
function twinTick(
  backend: Backend,
  pair: [Physics.World, Physics.World],
  input: () => Native.TickInput,
  where: string,
) {
  const framed = backend.tick(pair[0], input());
  const called = separately(pair[1], input());
  assert.deepEqual(comparable(framed), called, `${backend.name} ${where}`);
  assert.equal(pair[0].stateHash(), pair[1].stateHash(), `${backend.name} ${where}: stateHash`);
  return framed;
}

/** The scene: a floor, crates (a quarter with contact events, kinds on all), a sensor, a fast body. */
function scene(backend: Backend): Physics.World {
  const world = backend.create(Z_UP);
  assert.ok(world.addStaticWorld({ boxes: [[-40, -40, -1, 40, 40, 0]], ramps: [] }).ok);
  const spawns: Physics.Command[] = [];
  for (let i = 0; i < CRATES; i += 1) {
    const [x, y, z] = [i % 8, Math.floor(i / 8) % 4, Math.floor(i / 32)];
    const shape: Physics.Shape =
      i % 3 === 0 ? { kind: "sphere", radius: 0.35 } : { kind: "box", half: [0.35, 0.35, 0.35] };
    spawns.push({
      spawn: {
        key: `crate.${String(i).padStart(3, "0")}`,
        kind: i % 2 === 0 ? "crate" : "prop",
        type: "dynamic",
        pose: { p: [(x - 3.5) * 0.8, (y - 1.5) * 0.8, 0.5 + z * 0.8], q: IDENTITY },
        colliders: [{ key: "c", shape, events: i % 4 === 0 }],
      },
    });
  }
  spawns.push({
    spawn: {
      key: "gate",
      kind: "zone",
      type: "fixed",
      pose: { p: [0, 0, 1], q: IDENTITY },
      colliders: [{ key: "s", shape: { kind: "sphere", radius: 2 }, sensor: true, events: true }],
    },
  });
  spawns.push({
    spawn: {
      key: "rocket",
      type: "dynamic",
      pose: { p: [0, 0, 20], q: IDENTITY },
      linvel: [0, 0, 400],
      gravityScale: 0,
      colliders: [{ key: "c", shape: { kind: "sphere", radius: 0.2 } }],
    },
  });
  const applied = world.apply(spawns, "each");
  assert.ok(Array.isArray(applied) && applied.every((result) => result.ok), JSON.stringify(applied));
  return world;
}

/** A room-like tick: pushes now and then, a refused command, an export since the last tick, queries. */
function sceneTick(tick: number): Native.TickInput {
  const push: Physics.Command[] =
    tick % 20 === 0
      ? [
          { areaPush: { center: [Math.sin(tick) * 2, 0, 0], radius: 4, strength: 9, falloff: 1 } },
          { impulse: { key: `crate.${String(tick % CRATES).padStart(3, "0")}`, j: [0.5, -0.25, 3] } },
          { setVelocity: { key: "crate.001", linvel: [0, 0, 5] } },
        ]
      : [];
  return {
    batches: [push, [{ wake: { key: "nobody" } }]],
    step: true,
    exportSince: Math.max(tick - 1, 0),
    queries: [
      { ray: { origin: [0, 0, 10], dir: [0, 0, -1], maxDist: 20 } },
      { ray: { origin: [0, 0, 10], dir: [0, 0, 1], maxDist: 5 } },
      { overlap: { shape: { kind: "sphere", radius: 2 }, pose: { p: [0, 0, 1], q: IDENTITY } } },
      { ray: { origin: [0, 0, 10], dir: [0, 0, 0], maxDist: 20 } },
    ],
  };
}

/** One hostile or odd input: a factory, so each twin reads an input of its own. */
interface InputRow {
  name: string;
  input: () => Native.TickInput;
}

const impulse = (j: unknown): Physics.Command => ({ impulse: { key: "crate.000", j } }) as unknown as Physics.Command;
const LONE = "\ud800";
const deep = (levels: number): unknown =>
  Array.from({ length: levels }).reduce<unknown>((inner) => ({ wrap: [inner] }), { key: "x" });

const inputRows: InputRow[] = [
  { name: "an empty tick", input: () => ({}) },
  {
    name: "a refused batch between two that apply",
    input: () => ({ batches: [[impulse([0, 0, 1])], "x" as never, [impulse([0, 0, 1])]] }),
  },
  {
    name: "numbers at every edge (NaN, ±Infinity, -0, 1e39, 2^64, -2^63, 1e21, f32 max, a subnormal)",
    input: () => ({
      batches: [
        [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 1e39, -1e39].map((v) =>
          impulse([v, 0, 0]),
        ),
        [2 ** 64, -(2 ** 63), 1e21, 3.4028234663852886e38, 1e-45, 0.1, 123456789].map((v) => impulse([0, 0, v])),
        [{ setVelocity: { key: "crate.002", linvel: [0.1, -0, 2 ** 24 + 1] } }],
      ],
      step: true,
    }),
  },
  { name: "a BigInt in a command", input: () => ({ batches: [[impulse([1n, 0, 0])]] }) },
  { name: "a command nesting past the wrapper's depth", input: () => ({ batches: [[{ wake: deep(40) } as never]] }) },
  { name: "a command nesting just within it", input: () => ({ batches: [[{ wake: deep(14) } as never]] }) },
  {
    name: "a getter that throws",
    input: () => ({
      batches: [
        [
          Object.defineProperty({}, "wake", {
            enumerable: true,
            get() {
              throw new Error("hostile getter");
            },
          }) as never,
        ],
        [impulse([0, 0, 1])],
      ],
    }),
  },
  {
    name: "a Proxy command and a revoked Proxy",
    input: () => {
      const revocable = Proxy.revocable({ wake: { key: "crate.000" } }, {});
      revocable.revoke();
      return { batches: [[new Proxy({ wake: { key: "crate.003" } }, {}) as never], [revocable.proxy as never]] };
    },
  },
  {
    name: "omitted values, toJSON and a boxed number (read as JSON text reads them)",
    input: () => ({
      batches: [
        [
          { wake: { key: "crate.004", extra: undefined, fn: () => 1, sym: Symbol("s") } } as never,
          { impulse: { key: "crate.005", j: [1, undefined, () => 2] } } as never,
          { wake: { key: "crate.006", toJSON: () => ({ key: "nobody" }) } } as never,
          { impulse: { key: "crate.007", j: [new Number(5), 0, 0] } } as never,
        ],
      ],
    }),
  },
  {
    name: "a lone surrogate in a value, in a member name, and a well-formed pair",
    input: () => ({
      batches: [
        [{ wake: { key: `crate.${LONE}` } }],
        [{ wake: { [`key${LONE}`]: "crate.000" } } as never],
        [{ wake: { key: "crate.😀" } }],
        [
          {
            spawn: {
              key: "é",
              type: "fixed",
              pose: { p: [0, 0, 30], q: IDENTITY },
              colliders: [{ key: "c", shape: { kind: "sphere", radius: 0.1 } }],
            },
          },
        ],
      ],
    }),
  },
  {
    name: "a batch of 16,385 commands",
    input: () => ({ batches: [Array.from({ length: 16_385 }, () => impulse([0, 0, 1]))] }),
  },
  {
    name: "a batch over the character budget",
    input: () => ({ batches: [[{ wake: { key: "k".repeat(OVER_BUDGET_CHARS) } }]] }),
  },
  {
    name: "a batch whose text is near the budget only by its escapes and non-ASCII text",
    input: () => ({
      batches: [[{ wake: { key: "é".repeat(3 * 1024 * 1024) } }], [{ wake: { key: "\n".repeat(1024 * 1024) } }]],
    }),
  },
  {
    name: "a batch over the value budget",
    input: () => ({ batches: [[{ wake: { key: "a", many: new Array(2_000_000).fill(0) } } as never]] }),
  },
  {
    name: "queries: one refused alone among good ones",
    input: () => ({
      queries: [
        { ray: { origin: [0, 0, 10], dir: [0, 0, -1], maxDist: 20 } },
        { ray: { origin: [0n, 0, 10], dir: [0, 0, -1], maxDist: 20 } } as never,
        { overlap: { shape: { kind: "sphere", radius: 2 }, pose: { p: [0, 0, 1], q: IDENTITY } } },
      ],
    }),
  },
  { name: "queries that are not a list", input: () => ({ queries: "ray" as never }) },
  {
    name: "queries holding a lone surrogate",
    input: () => ({ queries: [{ ray: { origin: [0, 0, 10], dir: [0, 0, -1], maxDist: 20, [LONE]: 1 } } as never] }),
  },
  {
    name: "queries over the budget together",
    input: () => ({
      queries: Array.from({ length: 4 }, () => ({ overlap: { pad: "q".repeat(9 * 1024 * 1024) } }) as never),
    }),
  },
  { name: "an export since a fraction, and since -1", input: () => ({ exportSince: 1.5 }) },
  { name: "an export since -1 with a step", input: () => ({ step: true, exportSince: -1 }) },
];

const backends: [string, { skip?: string }, () => Promise<Backend>][] = [
  ["@genex-ai/physics (world_tick_frame)", wasmGate, wasmBackend],
  ["@genex-ai/physics-native (one Tick frame)", nativeGate, nativeBackend],
];

for (const [title, gate, load] of backends) {
  const backend = gate.skip ? undefined : await load();
  describe(`${title}: a tick in one crossing is its separate calls`, gate, () => {
    it(`steps the scene ${SCENE_TICKS} ticks, every part equal, with events, escapes and every answer form`, () => {
      assert.ok(backend);
      const pair: [Physics.World, Physics.World] = [scene(backend), scene(backend)];
      const seen = { events: new Set<string>(), escaped: 0 };
      for (let tick = 0; tick < SCENE_TICKS; tick += 1) {
        const out = twinTick(backend, pair, () => sceneTick(tick), `tick ${tick}`);
        if (!out.ok || out.step === undefined || !out.step.ok) continue;
        for (const event of out.step.events) seen.events.add(event.kind);
        seen.escaped += out.step.escaped.length;
      }
      const kinds = [...seen.events].sort();
      assert.deepEqual(
        kinds,
        ["contactBegin", "contactEnd", "triggerEnter", "triggerExit"],
        "every event kind crossed",
      );
      assert.ok(seen.escaped >= 1, "the rocket escaped");
    });

    it("exports different bodies each tick, their keys the same length, every export its own", () => {
      assert.ok(backend);
      const movers = (world: Physics.World) => {
        const spawns = Array.from({ length: 16 }, (_, i) => ({
          spawn: {
            key: `k.${String(i).padStart(2, "0")}`,
            type: "kinematic",
            pose: { p: [i * 2, 0, 1], q: IDENTITY },
            colliders: [{ key: "c", shape: { kind: "sphere", radius: 0.5 } }],
          },
        })) as Physics.Command[];
        assert.ok((world.apply(spawns, "each") as Physics.CommandResult[]).every((result) => result.ok));
        return world;
      };
      const pair: [Physics.World, Physics.World] = [movers(backend.create(Z_UP)), movers(backend.create(Z_UP))];
      for (let tick = 0; tick < 64; tick += 1) {
        const key = `k.${String(tick % 16).padStart(2, "0")}`;
        const pose = { p: [(tick % 16) * 2, tick * 0.01, 1], q: IDENTITY } as Physics.Pose;
        const out = twinTick(
          backend,
          pair,
          () => ({ batches: [[{ setNextKinematicPose: { key, pose } }]], step: true, exportSince: tick }),
          `tick ${tick}`,
        );
        assert.ok(out.ok && out.exported?.keys.includes(key), `tick ${tick}: the body moved is exported`);
      }
    });

    for (const row of inputRows) {
      it(`${row.name}: the same result and world`, () => {
        assert.ok(backend);
        const pair: [Physics.World, Physics.World] = [scene(backend), scene(backend)];
        twinTick(backend, pair, () => sceneTick(0), "a first tick");
        twinTick(backend, pair, row.input, row.name);
      });
    }

    it("a tick encoded while another is (a getter calling tickWorld) gives each its calls' result", () => {
      assert.ok(backend);
      const outer: [Physics.World, Physics.World] = [scene(backend), scene(backend)];
      const inner: [Physics.World, Physics.World] = [scene(backend), scene(backend)];
      const nestedResults: unknown[] = [];
      const input = (side: 0 | 1) => () => ({
        batches: [
          [
            {
              get wake() {
                const run = side === 0 ? backend.tick(inner[0], sceneTick(3)) : separately(inner[1], sceneTick(3));
                nestedResults[side] = side === 0 ? comparable(run as Native.TickOutput) : run;
                return { key: "crate.010" };
              },
            } as unknown as Physics.Command,
          ],
          [impulse([0, 0, 2])],
        ],
        step: true,
        exportSince: 0,
      });
      const framed = backend.tick(outer[0], input(0)());
      const called = separately(outer[1], input(1)());
      assert.deepEqual(comparable(framed), called, "the outer tick");
      assert.deepEqual(nestedResults[0], nestedResults[1], "the tick its getter ran");
      assert.equal(outer[0].stateHash(), outer[1].stateHash());
      assert.equal(inner[0].stateHash(), inner[1].stateHash());
    });
  });
}

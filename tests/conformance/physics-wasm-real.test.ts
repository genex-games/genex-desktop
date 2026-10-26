/**
 * `@genex-ai/physics` for real: the WASM build of Genex Physics (`crates/genex-physics-wasm`) under
 * its hand-written wrapper (`crates/genex-physics/js/`), loaded in this Node 24 process from the
 * test build `node scripts/physics-wasm.ts --test` writes (`.studio-dev/build/physics-wasm-test/`,
 * the `test-trap` feature on). Rows: the build's identity; every method of `index.d.ts` and the
 * error-as-value shape; hostile inputs through JS, each asserting the world unchanged; no method
 * throwing on any argument; memory per world (`stats().memoryBytes` follows spawns, the counting
 * allocator measures it, 1,000 worlds made and freed leave the instance's memory flat); every
 * conformance vector (`crates/genex-physics/vectors/`, pinned on the native core, run by the shared
 * `js/conformance.js`) giving the same hashes, events and refusals in wasm32; and last the §11.3
 * poison rule after a forced trap.
 *
 * Without the test build the rows skip; `GENEX_REQUIRE_TOOLCHAINS=1` makes its absence a failure.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runVector } from "../../native/genex-rust/crates/genex-physics/js/conformance.js";
import type * as Physics from "../../native/genex-rust/crates/genex-physics/js/index.d.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PACKAGE = path.join(REPO, ".studio-dev/build/physics-wasm-test");
const VECTORS = path.join(REPO, "native/genex-rust/crates/genex-physics/vectors");
const BUILD_ID = /^genex-physics\/0\.1\.0\+contract-1\.0\+rapier-0\.36\.0\+det\+wasm32$/;
const ERROR_CODES = 22;
const LEAK_WORLDS = 1000;
const LEAK_WARMUP_WORLDS = 50;
const LEAK_BODIES = 8;
/** One past the wrapper's input cap (`MAX_INPUT_CHARS` in core.js). */
const OVER_INPUT_CAP = 128 * 1024 * 1024 + 1;
const EXPORT_STRIDE = 14;

type Package = typeof Physics;
interface Testing {
  trap(): boolean;
  memoryIsMeasured(world: Physics.World): boolean;
  liveWorlds(): number;
  wasmMemoryBytes(): number;
  instance(): { generation: number; poisoned: boolean };
}

function needsBuild(): { skip?: string } {
  if (existsSync(path.join(PACKAGE, "testing.js"))) return {};
  const missing = `the physics test build (${PACKAGE}; node scripts/physics-wasm.ts --test)`;
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

const gate = needsBuild();
const physics: Package | undefined = gate.skip
  ? undefined
  : await import(pathToFileURL(path.join(PACKAGE, "node.js")).href);
const testing: Testing | undefined = gate.skip
  ? undefined
  : await import(pathToFileURL(path.join(PACKAGE, "testing.js")).href);

function pkg(): Package {
  assert.ok(physics, "the package loaded");
  return physics;
}

function hooks(): Testing {
  assert.ok(testing, "the test hooks loaded");
  return testing;
}

const Y_UP: Physics.WorldDesc = {
  contract: "1.0",
  dt: 1 / 60,
  substeps: 1,
  gravity: [0, -9.81, 0],
  upAxis: "y",
  lengthUnit: 1,
};
const Z_UP: Physics.WorldDesc = { ...Y_UP, gravity: [0, 0, -9.81], upAxis: "z" };
const IDENTITY: Physics.Quat = [0, 0, 0, 1];

function made(desc: Physics.WorldDesc = Y_UP): Physics.World {
  const result = pkg().World.create(desc);
  assert.ok(result.ok, `World.create: ${JSON.stringify(result)}`);
  return result.world;
}

function box(key: string, y: number, extra: Partial<Physics.BodyDesc> = {}): Physics.BodyDesc {
  const collider: Physics.ColliderDesc = { key: "c", shape: { kind: "box", half: [0.5, 0.5, 0.5] } };
  return { key, type: "dynamic", pose: { p: [0, y, 0], q: IDENTITY }, colliders: [collider], ...extra };
}

function ok(result: Physics.Result<object> | Physics.CommandResult[]): void {
  assert.ok(!Array.isArray(result) && result.ok, `expected ok: ${JSON.stringify(result)}`);
}

function code(result: unknown): string {
  const failed = result as Physics.Failure;
  assert.equal(failed.ok, false, `expected a failure: ${JSON.stringify(result)}`);
  assert.equal(typeof failed.detail, "string");
  return failed.code;
}

/** Everything a caller can observe of a world, to assert a refused call changed nothing. */
function observe(world: Physics.World): string {
  const { stepMs: _wallTime, ...stats } = world.stats();
  return JSON.stringify({
    hash: world.stateHash(),
    physics: world.physicsHash(),
    stats,
    bodies: world.bodies(),
    tick: world.tick,
  });
}

/** A scene with every kind of thing in it: a floor, two linked crates, a kinematic lift, a sensor. */
function scene(): Physics.World {
  const world = made();
  ok(
    world.spawn({
      key: "floor",
      type: "fixed",
      pose: { p: [0, -1, 0], q: IDENTITY },
      colliders: [{ key: "c", shape: { kind: "box", half: [20, 1, 20] } }],
    }),
  );
  ok(world.spawn(box("a", 1, { kind: "crate" })));
  ok(world.spawn(box("b", 3, { kind: "prop" })));
  ok(
    world.addJoint({
      key: "j",
      a: "a",
      b: "b",
      type: "hinge",
      anchorA: [0, 1, 0],
      anchorB: [0, -1, 0],
      axis: [0, 0, 1],
    }),
  );
  ok(world.spawn({ ...box("lift", 0.5), type: "kinematic" }));
  return world;
}

describe("@genex-ai/physics: the build and every method", gate, () => {
  it("names a wasm32 build of the core and the whole error vocabulary", () => {
    assert.match(pkg().buildId(), BUILD_ID);
    assert.equal(Object.keys(pkg().PhysicsError).length, ERROR_CODES);
    assert.equal(pkg().PhysicsError.Internal, "internal");
  });

  it("creates a world with every default resolved, and refuses a bad one making nothing", () => {
    const before = hooks().liveWorlds();
    const world = made();
    const desc = world.desc();
    assert.equal(desc.dt, Math.fround(1 / 60), "dt is the f32 the core holds");
    assert.deepEqual([desc.substeps, desc.upAxis, desc.limits.bodies, desc.solver.iterations], [1, "y", 512, 4]);
    assert.equal(desc.limits.memoryBytes, 64 * 1024 * 1024);
    assert.equal(world.tick, 0);
    ok(world.check());
    assert.equal(code(pkg().World.create({ ...Y_UP, contract: "2.0" as "1.0" })), "contract-mismatch");
    assert.equal(code(pkg().World.create({ ...Y_UP, dt: Number.NaN })), "non-finite");
    assert.equal(code(pkg().World.create({ ...Y_UP, substeps: 1.5 })), "out-of-range");
    assert.equal(hooks().liveWorlds(), before + 1, "a refused world takes no slot");
    world.free();
  });

  it("runs every command verb and both apply modes, errors as values with index", () => {
    const world = scene();
    ok(world.impulse("a", [0, 1, 0]));
    ok(world.impulse("a", [0, 1, 0], [0, 1.2, 0]));
    ok(world.setVelocity("b", [1, 0, 0], [0, 0, 1]));
    ok(world.setPose("b", { p: [0, 4, 0], q: IDENTITY }, { resetVelocity: true, wake: true }));
    ok(world.setPose("b", { p: [0, 4, 0], q: IDENTITY }));
    ok(world.setNextKinematicPose("lift", { p: [0, 0.6, 0], q: IDENTITY }));
    ok(world.areaPush([0, 0, 0], 5, 2, 1));
    ok(world.areaPush([0, 0, 0], 5, 2, 1, { member: 1, collides: 0xffff }));
    ok(world.setMotor("j", { targetVel: 1, damping: 2 }));
    ok(world.sleep("a"));
    ok(world.wake("a"));
    assert.equal(code(world.wake("nobody")), "unknown-key");
    assert.equal(code(world.impulse("lift", [0, 1, 0])), "wrong-body-type");
    ok(world.apply([{ wake: { key: "a" } }, { spawn: box("c", 6) }], "atomic"));
    const atomic = world.apply([{ wake: { key: "a" } }, { wake: { key: "zz" } }], "atomic") as Physics.Failure;
    assert.deepEqual([atomic.ok, atomic.code, atomic.index], [false, "unknown-key", 1]);
    const each = world.apply([{ wake: { key: "zz" } }, { remove: { key: "c" } }], "each");
    assert.deepEqual(each, [{ ok: false, code: "unknown-key" }, { ok: true }]);
    ok(world.removeJoint("j"));
    ok(world.remove("b"));
    assert.equal(world.body("b"), null);
    world.free();
  });

  it("steps with events, reads bodies, exports and imports network state", () => {
    const world = scene();
    ok(
      world.spawn({
        ...box("probe", 0.6),
        colliders: [{ key: "c", shape: { kind: "sphere", radius: 0.2 }, events: true }],
      }),
    );
    let events = 0;
    for (let i = 0; i < 30; i += 1) {
      const result = world.step();
      assert.ok(result.ok);
      assert.equal(result.tick, i + 1);
      assert.deepEqual(
        [typeof result.overflowed, Array.isArray(result.escaped), typeof result.memoryExceeded],
        ["boolean", true, "boolean"],
      );
      events += result.events.length;
    }
    assert.ok(events > 0, "the probe on the floor reports a contact");
    assert.equal(world.tick, 30);
    const a = world.body("a");
    assert.ok(a);
    assert.deepEqual([a.key, a.kind, a.type, a.pose.q.length, a.linvel.length], ["a", "crate", "dynamic", 4, 3]);
    assert.deepEqual(
      world.bodies({ kinds: ["prop"] }).map((b) => b.key),
      ["b"],
    );
    assert.deepEqual(
      world.bodies().map((b) => b.key),
      ["a", "b", "floor", "lift", "probe"],
      "key order",
    );
    assert.equal(world.bodies({ changedSinceTick: 1_000 }).length, 0);
    const changed = world.exportChanged(0);
    assert.ok(changed.data instanceof Float32Array);
    assert.equal(changed.data.length, changed.keys.length * EXPORT_STRIDE);
    const net = world.exportBodyState("a");
    assert.ok(net);
    ok(world.importBodyState("a", { ...net, p: [1, 2, 3] }));
    assert.deepEqual(world.exportBodyState("a")?.p, [1, 2, 3]);
    const stats = world.stats();
    assert.deepEqual([stats.tick, stats.bodies, stats.joints], [30, 5, 1]);
    assert.ok(stats.stepMs >= 0 && stats.memoryBytes > 0);
    world.free();
  });

  it("answers ray, shape cast, overlap and the JSON query form", () => {
    const world = scene();
    const ray = world.ray([0, 10, 0], [0, -1, 0], 50);
    assert.ok(ray.ok && ray.hit);
    assert.deepEqual([ray.hit.body, ray.hit.collider], ["b", "c"]);
    const cast = world.shapeCast({ kind: "sphere", radius: 0.1 }, { p: [0, 10, 0], q: IDENTITY }, [0, -1, 0], 50);
    assert.ok(cast.ok && cast.hit?.body === "b");
    const overlap = world.overlap({ kind: "box", half: [5, 0.1, 5] }, { p: [0, 0, 0], q: IDENTITY });
    assert.ok(overlap.ok);
    assert.deepEqual(overlap.keys, ["floor", "lift"], "key order");
    const missed = world.query({ ray: { origin: [100, 10, 0], dir: [0, 1, 0], maxDist: 5 } });
    assert.ok(missed.ok && "hit" in missed && missed.hit === null);
    assert.equal(code(world.ray([0, 0, 0], [0, 0, 0], 1)), "out-of-range");
    world.free();
  });

  it("snapshots and restores bit for bit, and hashes as the core does", () => {
    const world = scene();
    for (let i = 0; i < 10; i += 1) world.step();
    const bytes = world.snapshot();
    assert.ok(bytes instanceof Uint8Array && bytes.length > 0);
    assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), "GXPH");
    const copy = made();
    ok(copy.restore(bytes));
    for (let i = 0; i < 20; i += 1) {
      world.step();
      copy.step();
      assert.equal(copy.stateHash(), world.stateHash(), `step ${i}`);
    }
    assert.match(world.stateHash(), /^[0-9a-f]{16}$/);
    assert.match(world.physicsHash(), /^[0-9a-f]{16}$/);
    assert.equal(copy.physicsHash(), world.physicsHash());
    world.free();
    copy.free();
  });

  it("imports the static world in a z-up world, exact float32s only", () => {
    const world = made(Z_UP);
    ok(world.addStaticWorld({ boxes: [[-10, -10, -1, 10, 10, 0]], ramps: [[2, -2, 0, 6, 2, 1, 0, 0, 1]] }));
    const down = world.ray([0, 0, 5], [0, 0, -1], 10);
    assert.ok(down.ok && down.hit?.body === "static:box:0000");
    world.free();
  });

  it("refuses every call on a freed world with internal and reads empty", () => {
    const world = scene();
    world.free();
    world.free();
    assert.equal(code(world.step()), "internal");
    assert.equal(code(world.spawn(box("x", 1))), "internal");
    assert.equal(code(world.check()), "internal");
    assert.deepEqual([world.body("a"), world.bodies(), world.stateHash(), world.tick], [null, [], "", 0]);
    assert.equal(world.snapshot().length, 0);
    assert.equal(world.desc().upAxis, "y", "the description stays readable");
  });
});

/** A row of the hostile table: the call, and the code it must give with the world unchanged. */
interface HostileRow {
  name: string;
  call: (world: Physics.World) => unknown;
  code: Physics.PhysicsError;
}

const cyclic: Record<string, unknown> = { key: "loop" };
cyclic.self = cyclic;
const hostileRows: HostileRow[] = [
  { name: "spawn of undefined", call: (w) => w.spawn(undefined as unknown as Physics.BodyDesc), code: "bad-command" },
  { name: "spawn of a number", call: (w) => w.spawn(42 as unknown as Physics.BodyDesc), code: "bad-command" },
  { name: "a numeric key", call: (w) => w.spawn({ ...box("x", 1), key: 5 as unknown as string }), code: "bad-command" },
  {
    name: "a NaN position",
    call: (w) => w.spawn({ ...box("x", 1), pose: { p: [Number.NaN, 0, 0], q: IDENTITY } }),
    code: "non-finite",
  },
  {
    name: "an infinite velocity",
    call: (w) => w.setVelocity("a", [Number.POSITIVE_INFINITY, 0, 0]),
    code: "non-finite",
  },
  { name: "a number past f32", call: (w) => w.impulse("a", [1e39, 0, 0]), code: "non-finite" },
  { name: "a BigInt", call: (w) => w.impulse("a", [1n as unknown as number, 0, 0]), code: "bad-command" },
  { name: "a cyclic object", call: (w) => w.spawn(cyclic as unknown as Physics.BodyDesc), code: "bad-command" },
  {
    name: "an unknown field",
    call: (w) => w.spawn({ ...box("x", 1), wings: 2 } as Physics.BodyDesc),
    code: "bad-command",
  },
  {
    name: "a 1,000-point hull",
    call: (w) =>
      w.spawn({
        ...box("x", 1),
        colliders: [
          {
            key: "c",
            shape: {
              kind: "hull",
              points: Array.from({ length: 1_000 }, (_, i) => [i, i % 7, i % 3] as Physics.Vec3),
            },
          },
        ],
      }),
    code: "limit-hull-vertices",
  },
  { name: "an input past the cap", call: (w) => w.remove("k".repeat(OVER_INPUT_CAP)), code: "out-of-range" },
  { name: "a key past 64 bytes", call: (w) => w.wake("k".repeat(65)), code: "invalid-key" },
  { name: "a reserved key", call: (w) => w.spawn(box("__proto__", 1)), code: "invalid-key" },
  { name: "a duplicate key", call: (w) => w.spawn(box("a", 1)), code: "duplicate-key" },
  { name: "an unknown apply mode", call: (w) => w.apply([], "both" as "atomic"), code: "bad-command" },
  {
    name: "a batch that is not an array",
    call: (w) => w.apply("x" as unknown as Physics.Command[], "atomic"),
    code: "bad-command",
  },
  {
    name: "an atomic batch failing late",
    call: (w) => w.apply([{ spawn: box("new", 9) }, { wake: { key: "zz" } }], "atomic"),
    code: "unknown-key",
  },
  {
    name: "setPose options of a string",
    call: (w) => w.setPose("a", { p: [0, 1, 0], q: IDENTITY }, "fast" as Physics.SetPoseOptions),
    code: "bad-command",
  },
  {
    name: "setPose options naming a key",
    call: (w) => w.setPose("a", { p: [0, 1, 0], q: IDENTITY }, { key: "b" } as Physics.SetPoseOptions),
    code: "bad-command",
  },
  {
    name: "importBodyState with a numeric key",
    call: (w) =>
      w.importBodyState(5 as unknown as string, {
        p: [0, 1, 0],
        q: IDENTITY,
        v: [0, 0, 0],
        w: [0, 0, 0],
        sleeping: false,
      }),
    code: "invalid-key",
  },
  {
    name: "importBodyState of a short p",
    call: (w) =>
      w.importBodyState("a", {
        p: [0, 1] as unknown as Physics.Vec3,
        q: IDENTITY,
        v: [0, 0, 0],
        w: [0, 0, 0],
        sleeping: false,
      }),
    code: "bad-command",
  },
  { name: "restore of a string", call: (w) => w.restore("GXPH" as unknown as Uint8Array), code: "bad-snapshot" },
  { name: "restore of zeros", call: (w) => w.restore(new Uint8Array(1024)), code: "bad-snapshot" },
  { name: "restore of a damaged snapshot", call: (w) => w.restore(damaged(w.snapshot())), code: "bad-snapshot" },
  {
    name: "a static world in a y-up world",
    call: (w) => w.addStaticWorld({ boxes: [[0, 0, 0, 1, 1, 1]], ramps: [] }),
    code: "out-of-range",
  },
  {
    name: "a static world of strings",
    call: (w) => w.addStaticWorld({ boxes: "x" as unknown as number[][], ramps: [] }),
    code: "bad-command",
  },
  {
    name: "a query of an unknown kind",
    call: (w) => w.query({ cone: {} } as unknown as Physics.Query),
    code: "bad-command",
  },
  { name: "a zero ray direction", call: (w) => w.ray([0, 0, 0], [0, 0, 0], 1), code: "out-of-range" },
];

/** `bytes` with one payload byte flipped, so its checksum fails. */
function damaged(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  copy[copy.length - 1] ^= 0xff;
  return copy;
}

describe("@genex-ai/physics: hostile inputs through JS", gate, () => {
  for (const row of hostileRows) {
    it(`${row.name} gives ${row.code} and changes nothing`, () => {
      const world = scene();
      world.step();
      const before = observe(world);
      assert.equal(code(row.call(world)), row.code);
      assert.equal(observe(world), before);
      world.free();
    });
  }

  it("refuses hostile static worlds in a z-up world, changing nothing", () => {
    const world = made(Z_UP);
    const before = observe(world);
    assert.equal(code(world.addStaticWorld({ boxes: [[0, 0, 0, 1, 1, Number.NaN]], ramps: [] })), "non-finite");
    assert.equal(
      code(world.addStaticWorld({ boxes: [[0.1, 0, 0, 1, 1, 1]], ramps: [] })),
      "out-of-range",
      "0.1 is no float32",
    );
    assert.equal(code(world.addStaticWorld({ boxes: [], ramps: [], hills: [] } as Physics.StaticWorld)), "bad-command");
    assert.equal(
      code(world.addStaticWorld({ boxes: Array.from({ length: 5000 }, () => [0, 0, 0, 1, 1, 1]), ramps: [] })),
      "out-of-range",
    );
    assert.equal(observe(world), before);
    world.free();
  });

  it("never throws: every method takes every hostile argument and answers in its own shape", () => {
    const world = scene();
    const hostile: unknown[] = [
      undefined,
      null,
      Number.NaN,
      -0,
      1e39,
      "",
      "x".repeat(70),
      [],
      {},
      Symbol("s"),
      2n,
      cyclic,
      () => 1,
    ];
    const before = observe(world);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(world)).filter(
      (name) => !["constructor", "free", "step", "tick"].includes(name),
    );
    for (const name of methods) {
      const method = (world as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
      for (const value of hostile) {
        assert.doesNotThrow(
          () => method.call(world, value, value, value, value, value),
          `${name}(${String(typeof value)})`,
        );
      }
    }
    assert.equal(observe(world), before);
    assert.deepEqual(
      [
        world.body(5 as unknown as string),
        world.exportChanged(-1).keys,
        world.bodies({ kinds: [1] as unknown as string[] }),
      ],
      [null, [], []],
    );
    world.free();
  });
});

describe("@genex-ai/physics: memory per world (§11.1)", gate, () => {
  it("measures each world with the counting allocator; spawns raise it and removals lower it", () => {
    const world = made();
    assert.equal(hooks().memoryIsMeasured(world), true);
    const empty = world.stats().memoryBytes;
    for (let i = 0; i < 20; i += 1) ok(world.spawn(box(`b${i}`, i * 2)));
    const full = world.stats().memoryBytes;
    assert.ok(full > empty, `${empty} -> ${full}`);
    const other = made();
    const otherEmpty = other.stats().memoryBytes;
    for (let i = 0; i < 20; i += 1) ok(world.remove(`b${i}`));
    assert.ok(world.stats().memoryBytes < full);
    assert.equal(other.stats().memoryBytes, otherEmpty, "another world's calls are never charged to it");
    world.free();
    other.free();
  });

  it(`makes and frees ${LEAK_WORLDS} worlds with the instance's memory flat`, () => {
    const cycle = () => {
      const world = made();
      for (let i = 0; i < LEAK_BODIES; i += 1) ok(world.spawn(box(`b${i}`, i)));
      ok(world.step());
      world.free();
    };
    for (let i = 0; i < LEAK_WARMUP_WORLDS; i += 1) cycle();
    const worlds = hooks().liveWorlds();
    const bytes = hooks().wasmMemoryBytes();
    for (let i = 0; i < LEAK_WORLDS; i += 1) cycle();
    assert.equal(hooks().liveWorlds(), worlds);
    assert.equal(hooks().wasmMemoryBytes(), bytes, "the linear memory did not grow");
  });
});

describe("@genex-ai/physics: the conformance vectors in wasm32 (§16)", gate, () => {
  const files = gate.skip
    ? []
    : readdirSync(VECTORS)
        .filter((name) => name.endsWith(".json"))
        .sort();
  for (const file of files) {
    it(`${file} matches the pins`, () => {
      const outcome = runVector(pkg(), JSON.parse(readFileSync(path.join(VECTORS, file), "utf8")));
      assert.deepEqual(outcome.problems, [], `${file}: ${outcome.problems.join("; ")}`);
      assert.ok(outcome.checks > 0, `${file}: at least one pinned value was compared`);
    });
  }
});

describe("@genex-ai/physics: a trap poisons the instance (§11.3)", gate, () => {
  it("answers internal on every world after a trap, until init() makes a new instance", async () => {
    const first = scene();
    const second = made();
    const generation = hooks().instance().generation;
    assert.equal(hooks().trap(), true, "the test build exports test_trap");
    assert.equal(hooks().instance().poisoned, true);
    for (const world of [first, second]) {
      assert.equal(code(world.step()), "internal");
      assert.equal(code(world.spawn(box("x", 1))), "internal");
      assert.equal(code(world.apply([], "atomic")), "internal");
      assert.equal(code(world.ray([0, 5, 0], [0, -1, 0], 10)), "internal");
      assert.equal(code(world.restore(new Uint8Array(8))), "internal");
      assert.equal(code(world.check()), "internal");
      assert.deepEqual(
        [world.body("a"), world.bodies(), world.stateHash(), world.physicsHash(), world.tick],
        [null, [], "", "", 0],
      );
      assert.deepEqual([world.exportChanged(0).keys, world.snapshot().length, world.stats().bodies], [[], 0, 0]);
      assert.equal(world.desc().dt, Math.fround(1 / 60));
    }
    assert.equal(code(pkg().World.create(Y_UP)), "internal");
    assert.match(pkg().buildId(), BUILD_ID, "the identity is still known");

    await pkg().init();
    assert.equal(hooks().instance().poisoned, false);
    assert.equal(hooks().instance().generation, generation + 1);
    assert.equal(code(first.step()), "internal", "a world of the trapped instance stays failed");
    first.free();
    second.free();
    const fresh = scene();
    for (let i = 0; i < 5; i += 1) ok(fresh.step());
    assert.equal(fresh.stats().bodies, 4);
    assert.equal(hooks().liveWorlds(), 1, "the new instance holds only its own world");
    fresh.free();
  });
});

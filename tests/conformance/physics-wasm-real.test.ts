/**
 * `@genex-ai/physics` for real: the WASM build of Genex Physics (`crates/genex-physics-wasm`) under
 * its hand-written wrapper (`crates/genex-physics/js/`), loaded in this Node 24 process from the
 * test build `node scripts/physics-wasm.ts --test` writes (`.studio-dev/build/physics-wasm-test/`,
 * the `test-trap` feature on). Rows: the build's identity; every method of `index.d.ts` and the
 * error-as-value shape; hostile inputs through JS, each asserting the world unchanged; no method
 * throwing on any argument; memory per world (`stats().memoryBytes` follows spawns, the counting
 * allocator measures it, 1,000 worlds made and freed leave the instance's memory flat); every
 * conformance vector (`crates/genex-physics/vectors/`, pinned on the native core, run by the shared
 * `js/conformance.js`) giving the same hashes, events and refusals in wasm32; the bulk calls (§19,
 * additive to 1.0: `importStates` equal to one `importBodyState` per key and atomic, with its hostile
 * table, and `queryMany` equal to one `query` per item, quota included); and last the §11.3 poison
 * rule after a forced trap.
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
/**
 * The wrapper's per-call budget for a world of default limits (core.js `inputBudget`): 8 Mi
 * characters and 524,288 values besides the geometry, plus 24 characters and one value for each of
 * the 1,048,576 heightfield samples the limits admit.
 */
const INPUT_CHARS_BUDGET = 32 * 1024 * 1024;
const OVER_INPUT_CAP = INPUT_CHARS_BUDGET + 1;
/** The most commands one `apply` carries (core.js `BATCH_COMMANDS_MAX`). */
const BATCH_COMMANDS_MAX = 16_384;
/**
 * How far the heaviest inputs the budget lets through may grow the shared instance's linear memory
 * (it never shrinks): measured at about 120 MB for a default-limit heightfield, the largest legal input.
 */
const TRANSIENT_GROWTH_BOUND = 256 * 1024 * 1024;
const DEFAULT_HEIGHTFIELD_SIDE = 1024;
/** The native core's snapshot of a vector scene, and the hashes around it (`tests/vectors.rs`). */
const CROSS_TARGET_FIXTURE = path.join(
  REPO,
  "native/genex-rust/crates/genex-physics/tests/fixtures/cross-target-snapshot.json",
);
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
const boom = () => {
  throw new Error("a hostile getter");
};
/** An object whose `field` getter throws. */
const throwingGetter = (field: string): object => Object.defineProperty({}, field, { get: boom, enumerable: true });
/** A Proxy whose every trap throws. */
const throwingProxy = new Proxy(
  {},
  { ownKeys: boom, getOwnPropertyDescriptor: boom, get: boom, has: boom, getPrototypeOf: boom },
);
/** A revoked Proxy: every operation on it throws a TypeError. */
const revokedProxy = (() => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
})();
/** A real Uint8Array whose own `length` getter throws (the glue reads `length`). */
const bytesWithThrowingLength = (bytes: Uint8Array): Uint8Array =>
  Object.defineProperty(bytes, "length", { get: boom });
const POSE: Physics.Pose = { p: [0, 1, 0], q: IDENTITY };
const hostileOptions = (options: unknown) => options as Physics.SetPoseOptions;
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
  {
    name: "a spawn with a throwing getter",
    call: (w) => w.spawn(throwingGetter("key") as Physics.BodyDesc),
    code: "bad-command",
  },
  { name: "a spawn of a revoked Proxy", call: (w) => w.spawn(revokedProxy as Physics.BodyDesc), code: "bad-command" },
  {
    name: "setPose options with a throwing getter",
    call: (w) => w.setPose("a", POSE, hostileOptions(throwingGetter("wake"))),
    code: "bad-command",
  },
  {
    name: "setPose options of a throwing Proxy",
    call: (w) => w.setPose("a", POSE, hostileOptions(throwingProxy)),
    code: "bad-command",
  },
  {
    name: "setPose options of a revoked Proxy",
    call: (w) => w.setPose("a", POSE, hostileOptions(revokedProxy)),
    code: "bad-command",
  },
  {
    name: "a static world with a throwing getter",
    call: (w) => w.addStaticWorld(throwingGetter("boxes") as Physics.StaticWorld),
    code: "bad-command",
  },
  {
    name: "a static world with a throwing row",
    call: (w) => w.addStaticWorld({ boxes: [throwingProxy as number[]], ramps: [] }),
    code: "bad-command",
  },
  {
    name: "a static world of a revoked Proxy",
    call: (w) => w.addStaticWorld(revokedProxy as Physics.StaticWorld),
    code: "bad-command",
  },
  { name: "restore of a throwing Proxy", call: (w) => w.restore(throwingProxy as Uint8Array), code: "bad-snapshot" },
  { name: "restore of a revoked Proxy", call: (w) => w.restore(revokedProxy as Uint8Array), code: "bad-snapshot" },
  {
    name: "restore of zeros with a throwing length",
    call: (w) => w.restore(bytesWithThrowingLength(new Uint8Array(64))),
    code: "bad-snapshot",
  },
  {
    name: `an apply of more than ${BATCH_COMMANDS_MAX} commands, in each mode`,
    call: (w) =>
      w.apply(
        Array.from({ length: BATCH_COMMANDS_MAX + 1 }, () => ({ wake: { key: "a" } })),
        "each",
      ),
    code: "out-of-range",
  },
  {
    name: "a name whose JSON escapes pass the budget though its length does not",
    call: (w) => w.spawn({ ...box("x", 1), ["\u0001".repeat(INPUT_CHARS_BUDGET / 4)]: 0 } as Physics.BodyDesc),
    code: "out-of-range",
  },
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
      throwingGetter("key"),
      throwingGetter("boxes"),
      throwingGetter("kinds"),
      throwingProxy,
      revokedProxy,
      bytesWithThrowingLength(new Uint8Array(16)),
      new Proxy([], { get: boom, getPrototypeOf: boom }),
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
    assert.equal(hooks().instance().poisoned, false, "no hostile argument made the instance trap");
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

/** `scene()` stepped `ticks` times. */
function steppedScene(ticks: number): Physics.World {
  const world = scene();
  for (let i = 0; i < ticks; i += 1) ok(world.step());
  return world;
}

/** The `index`th entry of `exportChanged`'s layout as the state `importBodyState` takes. */
function netState(data: ArrayLike<number>, index: number): Physics.NetBodyState {
  const at = (slot: number) => data[index * EXPORT_STRIDE + slot];
  return {
    p: [at(0), at(1), at(2)],
    q: [at(3), at(4), at(5), at(6)],
    v: [at(7), at(8), at(9)],
    w: [at(10), at(11), at(12)],
    sleeping: at(13) === 1,
  };
}

/** An export's entries an import takes: every one but the scene's fixed floor. */
function importable(world: Physics.World, exported: Physics.ChangedExport): Physics.ChangedExport {
  const kept = exported.keys.flatMap((key, index) => (world.body(key)?.type === "fixed" ? [] : [index]));
  const data = new Float32Array(kept.length * EXPORT_STRIDE);
  for (const [at, index] of kept.entries()) {
    data.set(exported.data.subarray(index * EXPORT_STRIDE, (index + 1) * EXPORT_STRIDE), at * EXPORT_STRIDE);
  }
  return { keys: kept.map((index) => exported.keys[index]), data };
}

const SOURCE_TICKS = 40;
const TARGET_TICKS = 10;
const AFTER_TICKS = 30;
/** One entry of the flat layout: a body held 4 above the origin, awake and still. */
const HELD = [0, 4, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
/** Index 1's slot `slot` in a two-entry flat layout. */
const second = (slot: number) => EXPORT_STRIDE + slot;
/** Two held entries with `value` at `at`. */
const spoiled = (at: number, value: unknown): unknown[] => Object.assign([...HELD, ...HELD], { [at]: value });

/** A row of the bulk import's hostile table: its arguments, and the refusal they give. */
interface BulkRow {
  name: string;
  keys: unknown;
  data: unknown;
  code: Physics.PhysicsError;
  index?: number;
}

const bulkRows: BulkRow[] = [
  { name: "keys that are not a list", keys: "a", data: HELD, code: "bad-command" },
  { name: "a key that is not a string", keys: ["a", 5], data: [...HELD, ...HELD], code: "bad-command" },
  { name: "a Float64Array", keys: ["a", "b"], data: new Float64Array(2 * EXPORT_STRIDE), code: "bad-command" },
  { name: "a number given as a string", keys: ["a", "b"], data: spoiled(second(1), "4"), code: "bad-command" },
  { name: "data one number short", keys: ["a", "b"], data: [...HELD, ...HELD].slice(1), code: "bad-command" },
  { name: "a key with no data", keys: ["a", "b", "lift"], data: [...HELD, ...HELD], code: "bad-command" },
  {
    name: `more than ${BATCH_COMMANDS_MAX} keys`,
    keys: Array.from({ length: BATCH_COMMANDS_MAX + 1 }, () => "a"),
    data: new Float32Array((BATCH_COMMANDS_MAX + 1) * EXPORT_STRIDE),
    code: "out-of-range",
  },
  { name: "keys of a throwing Proxy", keys: new Proxy([], { get: boom }), data: [], code: "bad-command" },
  { name: "data of a throwing Proxy", keys: [], data: new Proxy([], { get: boom }), code: "bad-command" },
  { name: "a revoked Proxy", keys: revokedProxy, data: revokedProxy, code: "bad-command" },
  { name: "NaN", keys: ["a", "b"], data: spoiled(second(0), Number.NaN), code: "non-finite", index: 1 },
  { name: "a number past f32", keys: ["a", "b"], data: spoiled(second(8), 1e39), code: "non-finite", index: 1 },
  {
    name: "an infinite Float32Array spin",
    keys: ["a", "b"],
    data: Float32Array.from(spoiled(second(11), Number.POSITIVE_INFINITY) as number[]),
    code: "non-finite",
    index: 1,
  },
  { name: "a sleeping of 2", keys: ["a", "b"], data: spoiled(second(13), 2), code: "bad-command", index: 1 },
  { name: "past worldExtent", keys: ["a", "b"], data: spoiled(second(1), 2e5), code: "out-of-range", index: 1 },
  { name: "a zero rotation", keys: ["a", "b"], data: spoiled(second(6), 0), code: "out-of-range", index: 1 },
  { name: "an unknown key", keys: ["a", "nobody"], data: [...HELD, ...HELD], code: "unknown-key", index: 1 },
  { name: "the fixed floor", keys: ["a", "floor"], data: [...HELD, ...HELD], code: "wrong-body-type", index: 1 },
  { name: "a key past 64 bytes", keys: ["a", "k".repeat(70)], data: [...HELD, ...HELD], code: "invalid-key", index: 1 },
];

/** A world whose `queriesPerStep` is `queries`, with a fixed wall at x = 5. */
function limitedWorld(queries: number): Physics.World {
  const world = made({ ...Y_UP, limits: { queriesPerStep: queries } });
  ok(world.spawn({ ...box("wall", 0), type: "fixed", pose: { p: [5, 0, 0], q: IDENTITY } }));
  return world;
}

const RAY_X: Physics.Query = { ray: { origin: [0, 0, 0], dir: [1, 0, 0], maxDist: 10 } };
/** Hits and refusals of every source, in an order that runs past a quota of 3. */
const MIXED_QUERIES: Physics.Query[] = [
  RAY_X,
  { ray: { origin: [0, 0, 0], dir: [0, 0, 0], maxDist: 10 } },
  { cone: {} } as unknown as Physics.Query,
  { ray: { origin: [0, 0, 0], dir: [1, 0, 0], maxDist: 10n as unknown as number } },
  { overlap: { shape: { kind: "sphere", radius: 1 }, pose: { p: [5, 0, 0], q: IDENTITY } } },
  {
    shapeCast: {
      shape: { kind: "sphere", radius: 0.1 },
      pose: { p: [0, 0, 0], q: IDENTITY },
      dir: [1, 0, 0],
      maxDist: 10,
    },
  },
  RAY_X,
  { ray: { origin: [0, 0, 0], dir: [-1, 0, 0], maxDist: 10 } },
];
/** Characters of one query that fits the call's budget alone, though four of them do not. */
const QUARTER_PAST_BUDGET = Math.ceil(INPUT_CHARS_BUDGET / 4) + 1;

describe("@genex-ai/physics: bulk calls, additive to 1.0 (§19)", gate, () => {
  it("imports exportChanged's data in one call exactly as one importBodyState per key", () => {
    const source = steppedScene(SOURCE_TICKS);
    const { keys, data } = importable(source, source.exportChanged(0));
    assert.deepEqual(keys, ["a", "b", "lift"]);
    const each = steppedScene(TARGET_TICKS);
    const bulk = steppedScene(TARGET_TICKS);
    const numbers = steppedScene(TARGET_TICKS);
    for (const [index, key] of keys.entries()) ok(each.importBodyState(key, netState(data, index)));
    ok(bulk.importStates(keys, data));
    ok(numbers.importStates(keys, Array.from(data)));
    assert.equal(bulk.stateHash(), each.stateHash());
    assert.equal(numbers.stateHash(), each.stateHash(), "a number array imports as its Float32Array");
    assert.deepEqual(bulk.exportChanged(0), each.exportChanged(0), "the same changed marks too");
    for (const [index, key] of keys.entries()) {
      const back = bulk.exportBodyState(key);
      const sent = netState(data, index);
      assert.deepEqual([back?.p, back?.v, back?.w, back?.sleeping], [sent.p, sent.v, sent.w, sent.sleeping], key);
    }
    for (let i = 0; i < AFTER_TICKS; i += 1) {
      for (const world of [each, bulk, numbers]) ok(world.step());
      assert.equal(bulk.stateHash(), each.stateHash(), `step ${i}`);
    }
    for (const world of [source, each, bulk, numbers]) world.free();
  });

  it("imports a key named twice in order, the later winning, as two calls do", () => {
    const each = steppedScene(TARGET_TICKS);
    const bulk = steppedScene(TARGET_TICKS);
    const first = [...HELD];
    const later = Object.assign([...HELD], { 0: 2, 13: 1 });
    ok(each.importBodyState("a", netState(first, 0)));
    ok(each.importBodyState("a", netState(later, 0)));
    ok(bulk.importStates(["a", "a"], [...first, ...later]));
    assert.equal(bulk.stateHash(), each.stateHash());
    assert.deepEqual(bulk.exportBodyState("a"), netState(later, 0));
    ok(bulk.importStates([], new Float32Array(0)));
    each.free();
    bulk.free();
  });

  for (const row of bulkRows) {
    it(`refuses a bulk import of ${row.name} with ${row.code}, applying none of it`, () => {
      const world = steppedScene(1);
      const before = observe(world);
      const refused = world.importStates(row.keys as Physics.Key[], row.data as number[]) as Physics.Failure;
      assert.equal(code(refused), row.code);
      assert.equal(refused.index, row.index);
      assert.equal(observe(world), before);
      world.free();
    });
  }

  it("answers queryMany exactly as one query per item, counting queriesPerStep the same", () => {
    const single = limitedWorld(3);
    const many = limitedWorld(3);
    const oneByOne = MIXED_QUERIES.map((query) => single.query(query));
    const together = many.queryMany(MIXED_QUERIES);
    assert.deepEqual(together, oneByOne);
    assert.deepEqual(
      oneByOne.map((result) => (result.ok ? "ok" : result.code)),
      ["ok", "out-of-range", "bad-command", "bad-command", "ok", "ok", "limit-queries", "limit-queries"],
    );
    assert.equal(many.stats().queriesThisStep, 3);
    assert.equal(single.stats().queriesThisStep, 3);
    for (const world of [single, many]) ok(world.step());
    assert.deepEqual(many.queryMany([RAY_X]), [single.query(RAY_X)], "a step starts a new quota");
    assert.deepEqual(many.queryMany([]), []);
    single.free();
    many.free();
  });

  it("answers an item past the budget as query does, and refuses a whole call past it counting nothing", () => {
    const world = limitedWorld(64);
    const overCap = { ray: { ...RAY_X.ray, filter: { excludeBodies: ["k".repeat(OVER_INPUT_CAP)] } } } as Physics.Query;
    assert.deepEqual(world.queryMany([overCap, RAY_X]), [world.query(overCap), world.query(RAY_X)]);
    const quarter = { ray: { ...RAY_X.ray, filter: { excludeBodies: ["k".repeat(QUARTER_PAST_BUDGET)] } } };
    const before = world.stats().queriesThisStep;
    const refusals = [
      [world.queryMany(RAY_X as unknown as Physics.Query[]), "bad-command"],
      [world.queryMany(new Proxy([RAY_X], { get: boom })), "bad-command"],
      [world.queryMany(revokedProxy as Physics.Query[]), "bad-command"],
      [world.queryMany(Array.from({ length: BATCH_COMMANDS_MAX + 1 }, () => RAY_X)), "out-of-range"],
      [world.queryMany(Array.from({ length: 4 }, () => quarter as Physics.Query)), "out-of-range"],
    ] as const;
    for (const [result, expected] of refusals) assert.equal(code(result), expected);
    assert.equal(world.stats().queriesThisStep, before, "a refused call runs no query");
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

/** A fixed body on a square heightfield of `side × side` samples. */
function heightfield(key: string, side: number): Physics.BodyDesc {
  const heights = Array.from({ length: side * side }, (_, i) => Math.fround(Math.sin(i) * 0.37));
  const shape: Physics.Shape = { kind: "heightfield", rows: side, cols: side, heights, size: [1000, 10, 1000] };
  return { key, type: "fixed", pose: { p: [0, 0, 0], q: IDENTITY }, colliders: [{ key: "hf", shape }] };
}

describe("@genex-ai/physics: one world's input cannot sink the shared instance (§11.1, §11.3)", gate, () => {
  it("refuses an input past the budget before it crosses, and bounds what the heaviest legal ones cost", () => {
    const victim = scene();
    ok(victim.step());
    const reference = scene();
    ok(reference.step());
    const attacker = made();
    const start = hooks().wasmMemoryBytes();

    const overBudget: [string, () => unknown][] = [
      [
        "a million empty commands",
        () => attacker.apply(Array.from({ length: 1_000_000 }, () => []) as unknown as Physics.Command[], "each"),
      ],
      [
        "a value tree past the budget",
        () =>
          attacker.spawn({
            ...box("x", 1),
            colliders: Array.from({ length: 2_000_000 }, () => []),
          } as unknown as Physics.BodyDesc),
      ],
      ["a string past the budget", () => attacker.wake("k".repeat(OVER_INPUT_CAP))],
      [
        "a non-ASCII string past the budget at 3 per character",
        () => attacker.wake("é".repeat(INPUT_CHARS_BUDGET / 2)),
      ],
    ];
    for (const [name, call] of overBudget) {
      assert.equal(code(call()), "out-of-range", name);
      assert.equal(hooks().wasmMemoryBytes(), start, `${name}: nothing crossed`);
    }

    const heaviestLegal: [string, () => unknown][] = [
      ["a default-limit heightfield", () => attacker.spawn(heightfield("ground", DEFAULT_HEIGHTFIELD_SIDE))],
      [
        "a full batch of hostile commands",
        () =>
          attacker.apply(
            Array.from({ length: BATCH_COMMANDS_MAX }, (_, i) => ({ wake: { key: `k${i}`, junk: [1, 2, 3] } })),
            "each",
          ),
      ],
      ["a string at the budget", () => attacker.wake("k".repeat(INPUT_CHARS_BUDGET - 64))],
      [
        "a value tree at the budget",
        () =>
          attacker.spawn({
            ...box("y", 1),
            colliders: Array.from({ length: 1_400_000 }, () => []),
          } as unknown as Physics.BodyDesc),
      ],
    ];
    for (const [name, call] of heaviestLegal) {
      call();
      assert.equal(hooks().instance().poisoned, false, `${name}: the instance did not trap`);
      const grown = hooks().wasmMemoryBytes() - start;
      assert.ok(grown <= TRANSIENT_GROWTH_BOUND, `${name}: the instance grew ${grown} bytes`);
    }

    for (let i = 0; i < 10; i += 1) {
      ok(victim.step());
      ok(reference.step());
    }
    assert.equal(victim.stateHash(), reference.stateHash(), "another world in the instance steps on unharmed");
    for (const world of [victim, reference, attacker]) world.free();
  });

  it("restores a real snapshot handed over with a hostile length property, without a trap", () => {
    const world = scene();
    for (let i = 0; i < 5; i += 1) ok(world.step());
    const bytes = world.snapshot();
    const copy = made();
    ok(copy.restore(bytesWithThrowingLength(bytes)));
    assert.equal(copy.stateHash(), world.stateHash());
    assert.equal(hooks().instance().poisoned, false);
    world.free();
    copy.free();
  });
});

/** The fixture `tests/vectors.rs` writes: a native snapshot taken after a vector's steps. */
interface CrossTargetFixture {
  build: string;
  vector: string;
  snapshot: string;
  stateHash: string;
  stepsAfter: number;
  snapshotAfter: string;
  stateHashAfter: string;
}

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
/** Where a snapshot's buildId length sits (after the magic and the contract version, §9.4 header). */
const SNAPSHOT_BUILD_ID_AT = 8;
const SNAPSHOT_BUILD_ID_LENGTH_BYTES = 2;

/** A snapshot split at its buildId: the header names the writer's target, everything after it is the state. */
function splitSnapshot(bytes: Uint8Array): { buildId: string; rest: string } {
  const length = bytes[SNAPSHOT_BUILD_ID_AT] | (bytes[SNAPSHOT_BUILD_ID_AT + 1] << 8);
  const start = SNAPSHOT_BUILD_ID_AT + SNAPSHOT_BUILD_ID_LENGTH_BYTES;
  const buildId = new TextDecoder().decode(bytes.subarray(start, start + length));
  return { buildId, rest: toHex(bytes.subarray(start + length)) };
}

describe("@genex-ai/physics: a snapshot restores on any target of the same build (§9.4)", gate, () => {
  it("restores the native core's snapshot in wasm32 and writes the same bytes native does", () => {
    const fixture: CrossTargetFixture = JSON.parse(readFileSync(CROSS_TARGET_FIXTURE, "utf8"));
    assert.equal(`${fixture.build}+wasm32`, pkg().buildId(), "the fixture is this build's");
    const vector = JSON.parse(readFileSync(path.join(VECTORS, fixture.vector), "utf8"));
    const world = made(vector.world);
    const statics: Physics.StaticWorld = vector.static;
    if (statics.boxes.length + statics.ramps.length > 0) ok(world.addStaticWorld(statics));
    ok(world.restore(fromHex(fixture.snapshot)));
    assert.equal(world.stateHash(), fixture.stateHash, "native → wasm32: the restored world is native's");
    const native = splitSnapshot(fromHex(fixture.snapshot));
    const ours = splitSnapshot(world.snapshot());
    assert.ok(native.buildId.startsWith(`${fixture.build}+`) && native.buildId !== ours.buildId, native.buildId);
    assert.equal(ours.buildId, pkg().buildId());
    assert.equal(
      ours.rest,
      native.rest,
      "wasm32 writes native's state bytes; the header names only the writer's target",
    );
    for (let i = 0; i < fixture.stepsAfter; i += 1) ok(world.step());
    assert.equal(world.stateHash(), fixture.stateHashAfter, "and steps on bit for bit");
    assert.equal(
      splitSnapshot(world.snapshot()).rest,
      splitSnapshot(fromHex(fixture.snapshotAfter)).rest,
      "wasm32 → native: the same state bytes after stepping (native restores a +wasm32 header: tests/vectors.rs)",
    );
    world.free();
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

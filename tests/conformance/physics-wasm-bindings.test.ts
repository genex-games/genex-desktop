/**
 * `@genex-ai/physics`'s `createBinding()`: a WebAssembly instance of its own, made from the module the
 * package compiled once, for a caller that must keep one world's failure away from every other (an
 * authority server runs one per room). Loaded from the test build (`node scripts/physics-wasm.ts
 * --test`, `.studio-dev/build/physics-wasm-test/`, the `test-trap` feature on), whose `testing.js`
 * traps a chosen binding.
 *
 * - Two bindings and the package's own instance step the same scene to the same hashes, each world
 *   in its own linear memory.
 * - A trap in one binding poisons that binding and its worlds alone (§11.3): the other binding and
 *   the package's instance keep answering, with the hashes they would have had.
 * - A trap in the package's instance leaves every binding answering.
 *
 * Without the test build the rows skip; `GENEX_REQUIRE_TOOLCHAINS=1` makes its absence a failure.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type * as Physics from "../../native/genex-rust/crates/genex-physics/js/index.d.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const PACKAGE = path.join(REPO, ".studio-dev/build/physics-wasm-test");
const STEPS = 90;
const IDENTITY: Physics.Quat = [0, 0, 0, 1];
const DESC: Physics.WorldDesc = {
  contract: "1.0",
  dt: 1 / 60,
  substeps: 1,
  gravity: [0, -9.81, 0],
  upAxis: "y",
  lengthUnit: 1,
};

interface Testing {
  trap(): boolean;
  trapBinding(binding: Physics.Binding): boolean;
  instance(): { generation: number; poisoned: boolean };
}

function needsBuild(): { skip?: string } {
  if (existsSync(path.join(PACKAGE, "testing.js"))) return {};
  const missing = `the physics test build (${PACKAGE}; node scripts/physics-wasm.ts --test)`;
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

const gate = needsBuild();
const physics: typeof Physics | undefined = gate.skip
  ? undefined
  : await import(pathToFileURL(path.join(PACKAGE, "node.js")).href);
const testing: Testing | undefined = gate.skip
  ? undefined
  : await import(pathToFileURL(path.join(PACKAGE, "testing.js")).href);

function lib(): typeof Physics {
  assert.ok(physics !== undefined);
  return physics;
}

function hooks(): Testing {
  assert.ok(testing !== undefined);
  return testing;
}

function binding(): Physics.Binding {
  const made = lib().createBinding();
  assert.ok(made.ok, JSON.stringify(made));
  return made.binding;
}

/** A floor and a 4×4 pile of crates, in a world `create` makes. */
function scene(create: (desc: Physics.WorldDesc) => Physics.Result<{ world: Physics.World }>): Physics.World {
  const made = create(DESC);
  assert.ok(made.ok, JSON.stringify(made));
  const world = made.world;
  const floor: Physics.BodyDesc = {
    key: "floor",
    type: "fixed",
    pose: { p: [0, -1, 0], q: IDENTITY },
    colliders: [{ key: "c", shape: { kind: "box", half: [20, 1, 20] } }],
  };
  const crates: Physics.BodyDesc[] = Array.from({ length: 16 }, (_, i) => ({
    key: `crate.${i}`,
    type: "dynamic",
    pose: { p: [(i % 4) - 1.5, 0.5 + Math.floor(i / 4) * 1.01, 0], q: IDENTITY },
    colliders: [{ key: "c", shape: { kind: "box", half: [0.5, 0.5, 0.5] } }],
  }));
  const applied = world.apply(
    [floor, ...crates].map((spawn) => ({ spawn })),
    "each",
  );
  assert.ok(Array.isArray(applied) && applied.every((result) => result.ok), JSON.stringify(applied));
  return world;
}

/** Steps `world` `steps` times; the stateHash after each step. */
function run(world: Physics.World, steps: number): string[] {
  const hashes: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    const stepped = world.step();
    assert.ok(stepped.ok, JSON.stringify(stepped));
    hashes.push(world.stateHash());
  }
  return hashes;
}

function code(result: unknown): string {
  const failed = result as Physics.Failure;
  assert.equal(failed.ok, false, JSON.stringify(result));
  return failed.code;
}

describe("@genex-ai/physics: createBinding, one WebAssembly instance per caller", gate, () => {
  it("makes a binding with the package's buildId whose worlds step as the package's do", () => {
    const own = binding();
    assert.equal(own.buildId(), lib().buildId());
    assert.equal(own.poisoned(), false);
    assert.equal(own.PhysicsError, lib().PhysicsError);
    const reference = scene(lib().World.create);
    const mine = scene(own.World.create);
    assert.ok(mine instanceof lib().World, "a binding's world is the package's own World");
    assert.equal(mine.physicsHash(), reference.physicsHash());
    assert.deepEqual(run(mine, STEPS), run(reference, STEPS));
    mine.free();
    reference.free();
  });

  it("keeps each binding's worlds in its own instance: the same key lives in two bindings", () => {
    const a = binding();
    const b = binding();
    const wa = scene(a.World.create);
    const wb = scene(b.World.create);
    assert.ok(wa.remove("crate.0").ok);
    assert.equal(wa.body("crate.0"), null);
    assert.notEqual(wb.body("crate.0"), null, "the other binding's world still has it");
    wa.free();
    assert.ok(wb.step().ok, "freeing a world of one binding leaves the other's");
    wb.free();
  });

  it("a trap in one binding fails its worlds alone; the other binding and the package step on with unchanged hashes", () => {
    const victim = binding();
    const sibling = binding();
    const reference = run(scene(lib().World.create), STEPS);
    const doomed = scene(victim.World.create);
    const survivor = scene(sibling.World.create);
    const ownInstance = scene(lib().World.create);
    const half = STEPS / 2;
    const before = run(survivor, half);
    const packageBefore = run(ownInstance, half);
    run(doomed, half);
    assert.equal(hooks().trapBinding(victim), true, "the test build exports test_trap");
    assert.equal(victim.poisoned(), true);
    assert.equal(code(doomed.step()), "internal");
    assert.equal(doomed.stateHash(), "", "a read of a poisoned binding's world gives its empty form");
    assert.equal(code(victim.World.create(DESC)), "internal", "a poisoned binding makes no world");
    assert.equal(sibling.poisoned(), false);
    assert.equal(hooks().instance().poisoned, false, "the package's own instance never noticed");
    assert.deepEqual([...before, ...run(survivor, STEPS - half)], reference);
    assert.deepEqual([...packageBefore, ...run(ownInstance, STEPS - half)], reference);
    doomed.free();
    survivor.free();
    ownInstance.free();
  });

  it("a trap in the package's own instance leaves every binding answering", async () => {
    const own = binding();
    const world = scene(own.World.create);
    const reference = run(scene(own.World.create), STEPS);
    assert.equal(hooks().trap(), true);
    assert.equal(hooks().instance().poisoned, true);
    assert.equal(own.poisoned(), false);
    assert.deepEqual(run(world, STEPS), reference);
    const later = binding();
    assert.deepEqual(run(scene(later.World.create), STEPS), reference, "a binding made after the trap works too");
    await lib().init();
    assert.equal(hooks().instance().poisoned, false);
    world.free();
  });

  it("many bindings live at once, each answering, and dropping them frees nothing they do not own", () => {
    const many = Array.from({ length: 8 }, () => binding());
    const worlds = many.map((each) => scene(each.World.create));
    const hashes = worlds.map((world) => run(world, 10).at(-1));
    assert.equal(new Set(hashes).size, 1, "the same scene gives the same hash in every instance");
    for (const world of worlds) world.free();
  });
});

/**
 * Genex Physics' C ABI (`crates/genex-physics-capi`, `include/genex_physics.h`) through its test build
 * (`node scripts/physics-capi.ts --test`: this Mac's arm64 dylib with `gxph_test_panic`, and the C
 * tests compiled against it by the system clang).
 *
 * - The header test, as C11 and as C++17 with every warning an error: `static_assert` layouts, the
 *   address of every declared function, a world's life and a few hostile rows at the C boundary.
 *   The library's exported `gxph_*` symbols are exactly the ones it declares (and the test build's
 *   `gxph_test_panic`).
 * - The panic test: a panic is caught at the boundary, the process carries on, the library poisons.
 * - Every §16 vector through the C conformance runner (`tests/c/conformance.c`): every pin holds, and
 *   the `stateHash` after every step, the last `stateHash` and `physicsHash` and the count of pinned
 *   values are bit for bit what `@genex-ai/physics` (WASM) and `@genex-ai/physics-native` give on
 *   the same vector, each stepped by the shared JS runner.
 * - The runner is not vacuous: a changed pin is reported, and another build's vector opens no world.
 *
 * The Rust side's hostile-argument table is `crates/genex-physics-capi/tests/abi.rs` (cargo test).
 * Skips without the builds; `GENEX_REQUIRE_TOOLCHAINS=1` makes their absence a failure.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { runVector, type Vector } from "../../native/genex-rust/crates/genex-physics/js/conformance.js";
import type * as Physics from "../../native/genex-rust/crates/genex-physics/js/index.d.ts";
import type * as Native from "../../native/genex-rust/crates/genex-physics/js/native.d.ts";
import { exportedSymbols } from "../../scripts/physics-capi.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const CAPI_BUILD = process.env.GENEX_PHYSICS_CAPI_BUILD ?? path.join(REPO, ".studio-dev/build/physics-capi-test");
const WASM_PACKAGE = path.join(REPO, ".studio-dev/build/physics-wasm-test");
const NATIVE_PACKAGE =
  process.env.GENEX_PHYSICS_NATIVE_PACKAGE ?? path.join(REPO, ".studio-dev/build/physics-native-test");
const VECTORS = path.join(REPO, "native/genex-rust/crates/genex-physics/vectors");
const LIBRARY = path.join(CAPI_BUILD, "lib/libgenex_physics_capi.dylib");
const TESTS = path.join(CAPI_BUILD, "tests");
const DEADLINE_MS = 20_000;
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** The test build's own export, never in the header. */
const TEST_ONLY_SYMBOLS = ["gxph_test_panic"];
/** The vector the mutation rows change: one step, a stateHash pin. */
const SMALL_VECTOR = "key-64-bytes.json";

/** The package shape the shared runner takes. */
type Package = typeof Physics;

/** One C runner line (`tests/c/conformance.c`). */
interface CapiOutcome {
  name: string;
  problems: string[];
  checks: number;
  stateHash?: string;
  physicsHash?: string;
  stepHashes: string[];
}

function needsBuilds(): { skip?: string } {
  const wanted = [LIBRARY, path.join(WASM_PACKAGE, "core.js"), path.join(NATIVE_PACKAGE, "native.js")];
  const missing = wanted.filter((file) => !existsSync(file));
  if (missing.length === 0) return {};
  const what = `the test builds (${missing.join(", ")}; node scripts/physics-capi.ts --test, physics-wasm.ts --test, physics-native.ts --test)`;
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${what} absent`);
  return { skip: `not run: ${what} absent` };
}

function vectorFiles(): string[] {
  return readdirSync(VECTORS)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

/** The C runner over `files`: one outcome per vector, whatever its exit status. */
function runC(files: string[]): CapiOutcome[] {
  const ran = spawnSync(path.join(TESTS, "conformance"), files, { encoding: "utf8", maxBuffer: OUTPUT_MAX_BYTES });
  assert.ok(ran.status === 0 || ran.status === 1, `the runner ran: ${ran.status} ${ran.stderr}`);
  return ran.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as CapiOutcome);
}

/** `physics` with every world's `step()` recording its `stateHash` after a step that succeeded. */
function recording(physics: Package, hashes: string[]): Package {
  const wrap = (world: Physics.World): Physics.World =>
    new Proxy(world, {
      get(target, property) {
        if (property === "step") {
          return () => {
            const stepped = target.step();
            if (stepped.ok) hashes.push(target.stateHash());
            return stepped;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const create = (desc: Physics.WorldDesc) => {
    const made = physics.World.create(desc);
    return made.ok ? { ...made, world: wrap(made.world) } : made;
  };
  return { buildId: () => physics.buildId(), World: { create } } as unknown as Package;
}

const gate = needsBuilds();
const rooms = await tmpDir("gxph-capi-");

async function cores(): Promise<{ name: string; physics: Package }[]> {
  const wasm: typeof Physics = await import(pathToFileURL(path.join(WASM_PACKAGE, "node.js")).href);
  const native: typeof Native = await import(pathToFileURL(path.join(NATIVE_PACKAGE, "native.js")).href);
  const binary = native.packagedBinary();
  assert.ok(binary, `${NATIVE_PACKAGE} has this host's binary`);
  const made = native.nativePhysics({ ...binary, dir: rooms, deadlineMs: DEADLINE_MS });
  assert.ok(made.ok, `the native core started: ${JSON.stringify(made)}`);
  return [
    { name: "wasm32", physics: wasm },
    { name: "native", physics: made.physics as unknown as Package },
  ];
}

const others = gate.skip ? [] : await cores();

describe("genex_physics.h: the header and the boundary", gate, () => {
  it("compiles as C11 and C++17, and its declared functions are exactly the library's exports", () => {
    const declared = execFileSync(path.join(TESTS, "header_test"), { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.startsWith("declared "))
      .map((line) => line.slice("declared ".length))
      .sort();
    execFileSync(path.join(TESTS, "header_test-cxx"), { encoding: "utf8" });
    assert.ok(declared.length >= 37, `declared ${declared.length}`);
    const exported = exportedSymbols(LIBRARY).filter((name) => !TEST_ONLY_SYMBOLS.includes(name));
    assert.deepEqual(exported, declared);
  });

  it("catches a panic at the boundary and poisons the library, never unwinding into C", () => {
    const ran = spawnSync(path.join(TESTS, "panic_test"), { encoding: "utf8" });
    assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
    assert.match(ran.stdout, /library is poisoned/);
  });
});

describe("genex_physics.h: the §16 vectors through the C ABI", gate, () => {
  const outcomes = gate.skip ? [] : runC(vectorFiles().map((file) => path.join(VECTORS, file)));

  for (const [index, file] of vectorFiles().entries()) {
    it(`${file}: every pin holds, and every step's stateHash equals WASM's and native's`, () => {
      const ours = outcomes[index];
      assert.deepEqual(ours.problems, [], `${file}: ${ours.problems.join("; ")}`);
      assert.ok(ours.checks > 0 && ours.stepHashes.length > 0, file);
      const vector = JSON.parse(readFileSync(path.join(VECTORS, file), "utf8")) as Vector;
      for (const core of others) {
        const hashes: string[] = [];
        const theirs = runVector(recording(core.physics, hashes), vector);
        assert.deepEqual(theirs.problems, [], `${core.name} ${file}`);
        assert.equal(theirs.checks, ours.checks, `${core.name} ${file}: the same pins compared`);
        assert.equal(theirs.stateHash, ours.stateHash, `${core.name} ${file}: last stateHash`);
        assert.deepEqual(hashes, ours.stepHashes, `${core.name} ${file}: stateHash after every step`);
      }
    });
  }

  it("reports a changed pin, and opens no world for another build's vector", async () => {
    const dir = await tmpDir("gxph-capi-vectors-");
    const vector = JSON.parse(readFileSync(path.join(VECTORS, SMALL_VECTOR), "utf8"));
    const pinned = vector.steps.findLast((step: { expect?: { stateHash?: string } }) => step.expect?.stateHash);
    pinned.expect.stateHash = "0000000000000000";
    const changed = path.join(dir, "changed.json");
    writeFileSync(changed, JSON.stringify(vector));
    const foreign = path.join(dir, "foreign.json");
    writeFileSync(foreign, JSON.stringify({ ...vector, build: "genex-physics/9.9.9+contract-1.0+other" }));
    const [changedOutcome, foreignOutcome] = runC([changed, foreign]);
    assert.equal(changedOutcome.problems.length, 1);
    assert.match(changedOutcome.problems[0], /stateHash: pinned "0000000000000000", got "[0-9a-f]{16}"/);
    assert.match(foreignOutcome.problems[0], /^build: /);
    assert.equal(foreignOutcome.stepHashes.length, 0, "no world was opened");
  });
});

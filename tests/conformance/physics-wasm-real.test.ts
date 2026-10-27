/**
 * `@genex-ai/physics` for real: the WASM build of Genex Physics (`crates/genex-physics-wasm`) under
 * its hand-written wrapper (`crates/genex-physics/js/`), loaded in this Node 24 process from the
 * test build `node scripts/physics-wasm.ts --test` writes (`.studio-dev/build/physics-wasm-test/`,
 * the `test-trap` feature on). The rows are every binding's (`physics-binding-rows.ts`); this file
 * is their WASM backend: one instance holds every world, its linear memory is what a world's input
 * may grow, and a forced trap poisons the instance until `init()` (§11.3).
 *
 * Without the test build the rows skip; `GENEX_REQUIRE_TOOLCHAINS=1` makes its absence a failure.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as Physics from "../../native/genex-rust/crates/genex-physics/js/index.d.ts";
import { type BindingBackend, registerBindingRows } from "./physics-binding-rows.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const PACKAGE = path.join(REPO, ".studio-dev/build/physics-wasm-test");
const BUILD_ID = /^genex-physics\/0\.1\.0\+contract-1\.0\+rapier-0\.36\.0\+det\+wasm32$/;
const LEAK_WORLDS = 1000;
const LEAK_WARMUP_WORLDS = 50;

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

/** The WASM backend: the package and its test hooks (`js/testing.js`). */
function wasmBackend(physics: Package, testing: Testing): BindingBackend {
  return {
    title: "@genex-ai/physics",
    target: "wasm32",
    physics,
    buildId: BUILD_ID,
    liveWorlds: () => testing.liveWorlds(),
    memoryIsMeasured: (world) => testing.memoryIsMeasured(world),
    healthy: () => !testing.instance().poisoned,
    crossed: () => testing.wasmMemoryBytes(),
    grown: (start) => testing.wasmMemoryBytes() - start,
    held: () => testing.wasmMemoryBytes(),
    leakWorlds: LEAK_WORLDS,
    leakWarmupWorlds: LEAK_WARMUP_WORLDS,
    failure: {
      kind: "trap",
      trap: () => testing.trap(),
      generation: () => testing.instance().generation,
      poisoned: () => testing.instance().poisoned,
      init: () => physics.init(),
    },
  };
}

const gate = needsBuild();
const backend = gate.skip
  ? undefined
  : wasmBackend(
      await import(pathToFileURL(path.join(PACKAGE, "node.js")).href),
      await import(pathToFileURL(path.join(PACKAGE, "testing.js")).href),
    );
registerBindingRows(backend, gate);

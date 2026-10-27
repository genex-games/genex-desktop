// Test builds only (never packed: package.json `files` leaves it out): hooks this package's own
// tests use to reach what the API keeps private. `trap()` needs the `test-trap` build, whose glue
// exports `test_trap`.
import * as glue from "./wasm/genex_physics_wasm.js";
import { guardedForTests, instanceState, worldId } from "./core.js";

/** Makes the instance trap through the test-only export (§11.3); whether the export exists. */
export function trap() {
  if (typeof glue.test_trap !== "function") return false;
  guardedForTests(
    () => undefined,
    (glue) => glue.test_trap(),
  );
  return true;
}

/** Whether the counting allocator measures `world`'s memory (§11.1). */
export function memoryIsMeasured(world) {
  return guardedForTests(
    () => false,
    (glue) => glue.world_memory_is_measured(worldId(world)),
  );
}

/** How many worlds the live instance holds. */
export function liveWorlds() {
  return guardedForTests(
    () => -1,
    (glue) => glue.live_worlds(),
  );
}

/** The live instance's linear memory, in bytes (it only grows). */
export function wasmMemoryBytes() {
  return guardedForTests(
    () => 0,
    (wasm) => wasm.wasm_memory_bytes(),
  );
}

/** The instance's generation and health. */
export function instance() {
  const { generation, poisoned } = instanceState();
  return { generation, poisoned };
}

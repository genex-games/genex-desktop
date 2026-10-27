/**
 * `@genex-ai/physics-native` for real: every binding's rows (`physics-binding-rows.ts`) through the
 * native core, one `genex-physics-room` process per world, loaded from the test build
 * `node scripts/physics-native.ts --test` writes (`.studio-dev/build/physics-native-test/`, this
 * host's binary, linked to the WASM test build for `@genex-ai/physics`'s own `World`), or from
 * `GENEX_PHYSICS_NATIVE_PACKAGE` (a package folder with its `node_modules`, as the Linux container
 * mounts it). This file is the rows' native backend: nothing is shared between worlds, so a heavy
 * input grows no other world's memory, a world freed ends its process and removes its FIFO folder,
 * and a killed process fails its own world alone (§11.3).
 *
 * Without the build the rows skip; `GENEX_REQUIRE_TOOLCHAINS=1` makes its absence a failure.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { pathToFileURL } from "node:url";
import type * as Physics from "../../native/genex-rust/crates/genex-physics/js/index.d.ts";
import type * as Native from "../../native/genex-rust/crates/genex-physics/js/native.d.ts";
import { type BindingBackend, registerBindingRows } from "./physics-binding-rows.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const PACKAGE = process.env.GENEX_PHYSICS_NATIVE_PACKAGE ?? path.join(REPO, ".studio-dev/build/physics-native-test");
const BUILD_ID = /^genex-physics\/0\.1\.0\+contract-1\.0\+rapier-0\.36\.0\+det\+(aarch64-macos|x86_64-linux)$/;
/** A round trip's deadline: the heaviest legal input (a default-limit heightfield) parses well within it. */
const DEADLINE_MS = 20_000;
/** A process per world: fewer than WASM's 1,000, each a spawn. */
const LEAK_WORLDS = 100;
const LEAK_WARMUP_WORLDS = 5;

type NativeModule = typeof Native;

function needsBuild(): { skip?: string } {
  if (existsSync(path.join(PACKAGE, "native.js"))) return {};
  const missing = `the native physics test build (${PACKAGE}; node scripts/physics-native.ts --test)`;
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

/** The native backend: a core per world, each world mapped to its core for the hooks. */
function nativeBackend(native: NativeModule, rooms: string): BindingBackend {
  const binary = native.packagedBinary();
  if (binary === undefined) throw new Error(`no binary for ${native.platformKey()} in ${PACKAGE}`);
  const options = { ...binary, dir: rooms, deadlineMs: DEADLINE_MS, stderr: "inherit" as const };
  const cores = new WeakMap<Physics.World, Native.NativeCore>();
  const coreOf = (world: Physics.World): Native.NativeCore => {
    const core = cores.get(world);
    if (core === undefined) throw new Error("a world no native core made");
    return core;
  };
  const create = (desc: Physics.WorldDesc): Physics.Result<{ world: Physics.World }> => {
    const started = native.createNativeCore(options);
    if (!started.ok) return started;
    const made = started.core.createWorld(desc);
    if (!made.ok) {
      started.core.close();
      return made;
    }
    cores.set(made.world, started.core);
    return made;
  };
  const probe = native.createNativeCore(options);
  if (!probe.ok) throw new Error(`the native core did not start: ${probe.detail}`);
  const buildId = probe.core.buildId();
  probe.core.close();
  return {
    title: "@genex-ai/physics-native",
    target: buildId.slice(buildId.lastIndexOf("+") + 1),
    physics: { buildId: () => buildId, PhysicsError: native.PhysicsError, World: { create } },
    buildId: BUILD_ID,
    liveWorlds: () => native.liveCores(),
    memoryIsMeasured: (world) => coreOf(world).memoryIsMeasured(),
    healthy: (world) => coreOf(world).alive(),
    crossed: (world) => coreOf(world).frames(),
    grown: () => 0,
    held: () => readdirSync(rooms),
    leakWorlds: LEAK_WORLDS,
    leakWarmupWorlds: LEAK_WARMUP_WORLDS,
    failure: { kind: "kill", kill: (world) => process.kill(coreOf(world).pid, "SIGKILL") },
  };
}

const gate = needsBuild();
const rooms = mkdtempSync(path.join(os.tmpdir(), "gxph-rooms-"));
after(() => rmSync(rooms, { recursive: true, force: true }));
const backend = gate.skip
  ? undefined
  : nativeBackend(await import(pathToFileURL(path.join(PACKAGE, "native.js")).href), rooms);
registerBindingRows(backend, gate);

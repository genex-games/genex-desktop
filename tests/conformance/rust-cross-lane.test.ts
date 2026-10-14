/**
 * The Rust lane's Windows and Linux destinations as the core registers them
 * (`src/main/core/rust-cross-lane.ts`, M4.6): a cross builder registers only once the Rust recipe
 * pins its components (today none: both stay `target-unbuilt`), and each destination's settings
 * read the store's llvm-mingw, or zig, cargo-zigbuild and the Linux sysroot, at the build's own
 * lock. A component the lock does not pin, one not installed at the pin, a receipt for another
 * version and a hostile pin locate nothing and create nothing.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { rustTargetBuilders } from "../../src/main/core/internals.ts";
import {
  rustCrossBuilders,
  rustCrossPinned,
  rustTargetSettings,
  storeLinuxToolchain,
  storeLlvmMingw,
} from "../../src/main/core/rust-cross-lane.ts";
import { LinuxSettingsRefusal, RUST_LINUX_BUILDER } from "../../src/main/rust-build-linux.ts";
import { RUST_WINDOWS_BUILDER, WindowsSettingsRefusal } from "../../src/main/rust-build-windows.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { STACK_HOST_MATRIX } from "../../src/shared/game-targets.ts";
import { setupTargets } from "../../src/shared/stack-setup.ts";
import {
  RUST_CROSS_COMPONENTS,
  STACK_REQUIRED_COMPONENTS,
  type StackComponents,
  ToolchainHost,
  ToolchainId,
  type ToolchainLock,
} from "../../src/shared/toolchain.ts";
import { tmpDir } from "../helpers/tmp.ts";

const RUST_REQUIRED = STACK_REQUIRED_COMPONENTS[GameStack.RustWgpu];

/** The Rust row with `targets`' cross components pinned, as a recipe that pins them would list them. */
function pinned(...targets: Array<keyof typeof RUST_CROSS_COMPONENTS>): StackComponents {
  const table: Record<BuildTarget, readonly ToolchainId[]> = { ...RUST_REQUIRED };
  for (const target of targets)
    table[target] = [ToolchainId.Rust, ToolchainId.RustVendor, ...RUST_CROSS_COMPONENTS[target]];
  return table;
}

const PIN = { version: "1.2.3", sha12: "0123456789ab" } as const;

/** A lock naming `ids` at {@link PIN}. */
const lockOf = (entries: Partial<Record<ToolchainId, { version: string; sha12: string }>>): ToolchainLock => ({
  version: 1,
  entries,
  digest: "f".repeat(64),
});

/** Installs `id` at `pin` in `store` as `install.ts` lays it out: its folder, the receipt and `files`. */
async function install(
  store: string,
  id: ToolchainId,
  files: readonly string[],
  receipt: { version?: string; host?: ToolchainHost } = {},
): Promise<string> {
  const folder = path.join(store, id, `${PIN.version}-${PIN.sha12}`);
  await mkdir(folder, { recursive: true });
  for (const rel of files) {
    await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
    await writeFile(path.join(folder, rel), "");
  }
  const body = {
    id,
    version: receipt.version ?? PIN.version,
    sha256: PIN.sha12.padEnd(64, "0"),
    sha12: PIN.sha12,
    bytes: 1,
    host: receipt.host ?? ToolchainHost.MacArm64,
    target: null,
    source: "archive",
    installedAt: "2026-10-07T00:00:00.000Z",
  };
  await writeFile(path.join(folder, "receipt.json"), `${JSON.stringify(body)}\n`);
  return realpath(folder);
}

async function store(): Promise<string> {
  return realpath(await tmpDir("rust-cross-store-"));
}

describe("the Rust lane's cross builders", () => {
  it("today the recipe pins no cross component: Windows and Linux stay the lane's refusing placeholders", () => {
    assert.equal(rustCrossPinned(BuildTarget.Windows), false);
    assert.equal(rustCrossPinned(BuildTarget.Linux), false);
    const builders = rustTargetBuilders();
    assert.deepEqual(builders[BuildTarget.Windows], { ready: false });
    assert.deepEqual(builders[BuildTarget.Linux], { ready: false });
  });

  it("a recipe pinning a destination's cross components registers that destination's builder alone", () => {
    const windows = rustTargetBuilders(pinned(BuildTarget.Windows));
    assert.equal(windows[BuildTarget.Windows], RUST_WINDOWS_BUILDER);
    assert.deepEqual(windows[BuildTarget.Linux], { ready: false });
    const both = rustTargetBuilders(pinned(BuildTarget.Windows, BuildTarget.Linux));
    assert.equal(both[BuildTarget.Linux], RUST_LINUX_BUILDER);
    assert.equal(both[BuildTarget.Mac].ready, true);
  });

  it("a recipe missing any one cross component registers nothing for that destination", () => {
    for (const missing of RUST_CROSS_COMPONENTS[BuildTarget.Linux]) {
      const table = pinned(BuildTarget.Linux);
      const partial = { ...table, [BuildTarget.Linux]: table[BuildTarget.Linux].filter((id) => id !== missing) };
      assert.deepEqual(rustCrossBuilders(partial), {}, missing);
    }
  });
});

describe("the Rust host matrix against the lane", () => {
  it("every destination setup offers for a Rust game has a registered builder on that host", () => {
    const builders = rustTargetBuilders();
    for (const host of Object.values(ToolchainHost))
      for (const target of setupTargets(GameStack.RustWgpu, host))
        assert.equal(builders[target].ready, true, `${target} on ${host}`);
  });

  it("every run it lists is the browser or a Mac's own: the only Rust runs the core prepares and boxes", () => {
    for (const [host, ability] of Object.entries(STACK_HOST_MATRIX[GameStack.RustWgpu]))
      for (const target of ability.run) {
        const prepared = target === BuildTarget.Web || (host === StudioPlatform.Mac && target === BuildTarget.Mac);
        assert.ok(prepared, `${target} on ${host}`);
      }
  });
});

describe("the store's cross tools at the build's lock", () => {
  it("llvm-mingw is its installed folder; absent, unpinned, another version or a hostile pin is null", async () => {
    const root = await store();
    const folder = await install(root, ToolchainId.LlvmMingw, ["bin/clang"]);
    assert.equal(await storeLlvmMingw(root, lockOf({ [ToolchainId.LlvmMingw]: PIN })), folder);
    assert.equal(await storeLlvmMingw(root, lockOf({})), null);
    assert.equal(await storeLlvmMingw(path.join(root, "absent"), lockOf({ [ToolchainId.LlvmMingw]: PIN })), null);
    const other = await store();
    await install(other, ToolchainId.LlvmMingw, ["bin/clang"], { version: "9.9.9" });
    assert.equal(await storeLlvmMingw(other, lockOf({ [ToolchainId.LlvmMingw]: PIN })), null);
  });

  it("hostile pins locate nothing and create nothing in the store", async () => {
    const root = await store();
    await install(root, ToolchainId.LlvmMingw, ["bin/clang"]);
    const before = await readdir(root, { recursive: true });
    for (const version of ["../../..", "..", "1.2.3/../../x", "/etc", "1.2.3\0"]) {
      const lock = lockOf({
        [ToolchainId.LlvmMingw]: { version, sha12: PIN.sha12 },
        [ToolchainId.Zig]: { version, sha12: PIN.sha12 },
      });
      assert.equal(await storeLlvmMingw(root, lock), null, version);
      assert.deepEqual(
        await storeLinuxToolchain(root, lock),
        { zig: null, cargoZigbuild: null, sysroot: null },
        version,
      );
    }
    assert.deepEqual(await readdir(root, { recursive: true }), before);
  });

  it("zig, cargo-zigbuild and the sysroot each resolve by their host's layout, and each absent one is null", async () => {
    const root = await store();
    const zig = await install(root, ToolchainId.Zig, ["zig"]);
    const front = await install(root, ToolchainId.CargoZigbuild, ["cargo-zigbuild.exe"], {
      host: ToolchainHost.WindowsX64,
    });
    const lock = lockOf({ [ToolchainId.Zig]: PIN, [ToolchainId.CargoZigbuild]: PIN, [ToolchainId.LinuxSysroot]: PIN });
    assert.deepEqual(await storeLinuxToolchain(root, lock), {
      zig: path.join(zig, "zig"),
      cargoZigbuild: path.join(front, "cargo-zigbuild.exe"),
      sysroot: null,
    });
    const sysroot = await install(root, ToolchainId.LinuxSysroot, ["bin/pkg-config"]);
    assert.equal((await storeLinuxToolchain(root, lock)).sysroot, sysroot);
  });
});

describe("the lane's settings hook", () => {
  const bin = "/builds/game/windows";

  it("Windows reads llvm-mingw at the build's lock; without it the build is refused llvm-mingw-missing", async () => {
    const root = await store();
    const folder = await install(root, ToolchainId.LlvmMingw, ["bin/clang"]);
    const hook = rustTargetSettings({ store: root, mobile: async () => assert.fail("not a phone") });
    const ok = await hook(BuildTarget.Windows, { bin, lock: lockOf({ [ToolchainId.LlvmMingw]: PIN }) });
    assert.equal(ok?.ok, true);
    assert.ok(ok?.ok && Object.values(ok.env).some((value) => value.startsWith(folder)));
    const refused = await hook(BuildTarget.Windows, { bin, lock: lockOf({}) });
    assert.deepEqual(refused?.ok === false && refused.code, WindowsSettingsRefusal.LlvmMingwMissing);
  });

  it("Linux without the store's zig is refused zig-missing", async () => {
    const hook = rustTargetSettings({ store: await store(), mobile: async () => assert.fail("not a phone") });
    const refused = await hook(BuildTarget.Linux, { bin, lock: lockOf({}) });
    assert.deepEqual(refused?.ok === false && refused.code, LinuxSettingsRefusal.ZigMissing);
  });

  it("every other destination is the phones' answer", async () => {
    const asked: BuildTarget[] = [];
    const hook = rustTargetSettings({
      store: await store(),
      mobile: async (target) => {
        asked.push(target);
        return null;
      },
    });
    for (const target of [BuildTarget.Mac, BuildTarget.Web, BuildTarget.Ios, BuildTarget.Android])
      assert.equal(await hook(target, { bin, lock: lockOf({}) }), null);
    assert.deepEqual(asked, [BuildTarget.Mac, BuildTarget.Web, BuildTarget.Ios, BuildTarget.Android]);
  });
});

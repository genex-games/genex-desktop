/**
 * The six binaries a Rust · wgpu game is admitted as (`RUST_ADMITTED_EXECUTABLES` in
 * `shared/native-contract.ts`): the admission gates read exactly the executables the lane leaves in
 * `out/`, so the table and each registered builder name the same files. A destination whose
 * builder has not registered yet keeps the names its raylib counterpart already uses.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BuildTarget } from "../../src/shared/game-project.ts";
import {
  ExecutableArch,
  ExecutableFormat,
  NATIVE_CROSS_EXECUTABLES,
  NATIVE_MAC_EXECUTABLES,
  RUST_ADMITTED_EXECUTABLES,
} from "../../src/shared/native-contract.ts";
import { RUST_TARGET_BUILDERS } from "../../src/main/rust-build.ts";
import { RUST_MOBILE_TARGET_BUILDERS } from "../../src/main/rust-build-mobile.ts";
import { WEB_FILES } from "../../src/main/rust-build-web.ts";

describe("the six binaries a Rust game is admitted as (M3.0)", () => {
  it("names one entry per destination, each a known format and architecture", () => {
    assert.deepEqual(Object.keys(RUST_ADMITTED_EXECUTABLES).sort(), Object.values(BuildTarget).sort());
    for (const [target, entry] of Object.entries(RUST_ADMITTED_EXECUTABLES)) {
      assert.ok(Object.values(ExecutableFormat).includes(entry.format), target);
      assert.ok(Object.values(ExecutableArch).includes(entry.arch), target);
      assert.ok(entry.files.length > 0, target);
    }
  });

  it("names the executables each registered builder leaves in out/", () => {
    assert.deepEqual(
      RUST_ADMITTED_EXECUTABLES[BuildTarget.Mac].files,
      RUST_TARGET_BUILDERS[BuildTarget.Mac].executables,
    );
    for (const target of [BuildTarget.Ios, BuildTarget.Android] as const)
      assert.deepEqual(
        RUST_ADMITTED_EXECUTABLES[target].files,
        RUST_MOBILE_TARGET_BUILDERS[target].executables,
        target,
      );
    assert.deepEqual(RUST_ADMITTED_EXECUTABLES[BuildTarget.Web].files, [WEB_FILES.wasm]);
  });

  it("keeps the desktop names a raylib build already runs under", () => {
    assert.deepEqual(
      [...RUST_ADMITTED_EXECUTABLES[BuildTarget.Mac].files].sort(),
      Object.values(NATIVE_MAC_EXECUTABLES).sort(),
    );
    for (const target of [BuildTarget.Windows, BuildTarget.Linux] as const)
      assert.deepEqual(RUST_ADMITTED_EXECUTABLES[target].files, [NATIVE_CROSS_EXECUTABLES[target]], target);
  });

  it("reads Apple destinations as Mach-O, the others as PE, ELF and wasm", () => {
    const formats = Object.fromEntries(
      Object.entries(RUST_ADMITTED_EXECUTABLES).map(([target, entry]) => [target, `${entry.format}/${entry.arch}`]),
    );
    assert.deepEqual(formats, {
      [BuildTarget.Mac]: "mach-o/arm64",
      [BuildTarget.Ios]: "mach-o/arm64",
      [BuildTarget.Windows]: "pe/x86-64",
      [BuildTarget.Linux]: "elf/x86-64",
      [BuildTarget.Android]: "elf/arm64",
      [BuildTarget.Web]: "wasm/wasm32",
    });
  });
});

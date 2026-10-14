/**
 * The Linux destination of the Rust lane (M4.2, `src/main/rust-build-linux.ts`): cargo-zigbuild
 * with zig 0.16 for `x86_64-unknown-linux-gnu.2.28`, pkg-config over the Linux sysroot's link
 * stubs, a RUNPATH of exactly `$ORIGIN`; the export's ELF policy and its `.tar.gz` with the
 * SwiftShader split (`swiftshader-bundle.ts`, `rust-export-linux.ts`).
 *
 * The stand-in rows run the lane over stub programs (no compiler). The real rows build the Rust
 * template through the lane under the real Seatbelt sandbox with the pinned toolchain of the spike
 * folder (`.studio-dev/spike-toolchain`: the sysroot with rust-std for the triple, zig and
 * cargo-zigbuild), the release's vendored crates and the sysroot from the checked-in bundle; the
 * SwiftShader rows split the developer's pinned Linux ANGLE build (`GENEX_DEV_TOOLCHAINS`).
 * Without them the rows skip, and `GENEX_REQUIRE_TOOLCHAINS=1` turns the skip into a failure.
 * Nothing here runs a Linux binary: the CI floor rows are M4.4's.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { bundleLinuxSysroot } from "../../scripts/bundle-linux-sysroot.mjs";
import { rustPayloadDir, shippedRustStage } from "../../src/main/core/rust-lane.ts";
import type { GameBuildGame } from "../../src/main/game-build.ts";
import {
  RustBuilds,
  type RustBuildSandbox,
  type RustBuildSandboxSpec,
  type RustBuildsOptions,
  type RustStaged,
  type RustToolchain,
  rustBuildSandboxes,
} from "../../src/main/rust-build.ts";
import {
  admitRustLinuxExport,
  LinuxSettingsRefusal,
  linuxBuildSettings,
  linuxTargetSettings,
  RUST_LINUX_BUILDER,
  RUST_LINUX_LINK_FLAGS,
} from "../../src/main/rust-build-linux.ts";
import { BuildProblemCode, CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { GpuQualification } from "../../src/shared/game-export-contract.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { NativeRefusal, RustAdmissionProblem } from "../../src/shared/native-contract.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { ArchiveItemKind, ArchiveRefusal, NativeArchiveError } from "../../src/substrate/native-export-archive.ts";
import { admitRustLinuxElf, LINUX_GLIBC_FLOOR, parseElf, highestGlibc } from "../../src/substrate/native-gate-elf.ts";
import { LINUX_VULKAN_FILE_PINS, LinuxVulkanFile } from "../../src/substrate/native-runtime-files.ts";
import { rustLinuxArchiveItems, writeRustLinuxTarGz } from "../../src/substrate/rust-export-linux.ts";
import { NoticeSourceKind } from "../../src/substrate/native-export.ts";
import {
  NoticeRefusal,
  RUST_NOTICE_ROWS,
  RustRuntimePart,
  rustNotices,
  rustRuntimeSources,
} from "../../src/substrate/rust-notices.ts";
import { ArtifactError, ArtifactFault, sha256Hex } from "../../src/substrate/toolchain-store/artifact.ts";
import {
  AngleTarget,
  BUNDLE_LOCK,
  copyAngleTarget,
  parseBundleLock,
  verifyAngleBundle,
} from "../../src/substrate/toolchain-store/bundled.ts";
import { CrossTarget, RUST_CROSS_TARGETS } from "../../src/substrate/toolchain-store/cross-targets.ts";
import { lockOf } from "../../src/substrate/toolchain-store/lock.ts";
import { readPinnedManifest } from "../../src/substrate/toolchain-store/artifact.ts";
import {
  readSwiftShaderRuntime,
  SWIFTSHADER_FILES,
  SWIFTSHADER_LICENCES,
  SWIFTSHADER_TARGET,
  splitSwiftShader,
  swiftShaderManifest,
  verifySwiftShaderFolder,
} from "../../src/substrate/toolchain-store/swiftshader-bundle.ts";
import { linuxBinary, M2 } from "../fixtures/rust-bundles/binaries.ts";
import { devTool, needsTools } from "../helpers/dev-toolchains.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const VENDOR_DIR = process.env.GENEX_RUST_VENDOR_DIR ?? path.join(REPO, ".studio-dev", "rust-release", "e2e", "vendor");
const WORKSPACE = path.join(REPO, "native", "genex-rust");
const TEMPLATE = path.join(REPO, "src", "game-template-rust");
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
const SPEC = RUST_CROSS_TARGETS[CrossTarget.LinuxX64];
const TRIPLE_ENV = "x86_64_unknown_linux_gnu";
/** A cold release cross build compiles the facade's whole dependency graph twice (clippy, then the build). */
const COLD_BUILD_MS = 40 * MINUTE_MS;
const LOCK = lockOf({ rust: { version: "1.99.0", sha12: "000000000000" } });
const POSIX_ONLY = process.platform === "win32" ? { skip: "the stub programs are POSIX shell scripts" } : {};

/** Found tools at absolute, ordinary paths. */
const FOUND = {
  zig: "/store/zig/0.16.0/zig",
  cargoZigbuild: "/store/cargo-zigbuild/0.23.4/cargo-zigbuild",
  sysroot: "/store/linux-sysroot/almalinux-8.10-8031a635e032",
  bin: "/builds/pond-0123456789ab/linux-0123456789ab",
} as const;

describe("the Rust lane's Linux builder", () => {
  it("builds one `game` for x86_64-unknown-linux-gnu with its assets, from either host", () => {
    assert.deepEqual(RUST_LINUX_BUILDER, {
      ready: true,
      triple: "x86_64-unknown-linux-gnu",
      macSdk: false,
      executables: ["game"],
      assets: true,
    });
    assert.equal(SPEC.cargoTarget, "x86_64-unknown-linux-gnu.2.28");
  });

  it("links with a RUNPATH of exactly $ORIGIN (new dtags), where the export's Vulkan loader sits", () => {
    assert.deepEqual(RUST_LINUX_LINK_FLAGS, [
      "-C",
      "link-arg=-Wl,--enable-new-dtags",
      "-C",
      "link-arg=-Wl,-rpath,$ORIGIN",
    ]);
  });
});

describe("a Linux build's settings", () => {
  it("drives cargo-zigbuild with glibc 2.28, pkg-config over the sysroot and every cache in the build folder", () => {
    const settings = linuxBuildSettings(FOUND);
    assert.ok(settings.ok);
    assert.deepEqual(settings.front, {
      program: FOUND.cargoZigbuild,
      clippy: "clippy",
      build: "zigbuild",
      target: "x86_64-unknown-linux-gnu.2.28",
    });
    const pcDirs = `${FOUND.sysroot}/usr/lib64/pkgconfig:${FOUND.sysroot}/usr/share/pkgconfig`;
    assert.equal(settings.env[`PKG_CONFIG_${TRIPLE_ENV}`], `${FOUND.sysroot}/bin/pkg-config`);
    assert.equal(settings.env[`PKG_CONFIG_SYSROOT_DIR_${TRIPLE_ENV}`], FOUND.sysroot);
    assert.equal(settings.env[`PKG_CONFIG_PATH_${TRIPLE_ENV}`], pcDirs);
    assert.equal(settings.env[`PKG_CONFIG_LIBDIR_${TRIPLE_ENV}`], pcDirs);
    assert.equal(settings.env[`PKG_CONFIG_ALLOW_CROSS_${TRIPLE_ENV}`], "1");
    assert.equal(settings.env.CARGO_ZIGBUILD_ZIG_PATH, FOUND.zig);
    for (const name of ["CARGO_ZIGBUILD_CACHE_DIR", "ZIG_GLOBAL_CACHE_DIR", "ZIG_LOCAL_CACHE_DIR"])
      assert.ok(settings.env[name]?.startsWith(`${FOUND.bin}/`), `${name} is inside the build folder`);
    assert.equal(settings.env.PKG_CONFIG_PATH, undefined, "a host build script never sees the sysroot's pkg-config");
    assert.deepEqual(settings.rustflags, RUST_LINUX_LINK_FLAGS);
    assert.deepEqual(settings.reads, [path.dirname(FOUND.zig), path.dirname(FOUND.cargoZigbuild), FOUND.sysroot]);
  });

  const missing = [
    { name: "zig", found: { ...FOUND, zig: null }, code: LinuxSettingsRefusal.ZigMissing },
    {
      name: "cargo-zigbuild",
      found: { ...FOUND, cargoZigbuild: null },
      code: LinuxSettingsRefusal.CargoZigbuildMissing,
    },
    { name: "the sysroot", found: { ...FOUND, sysroot: null }, code: LinuxSettingsRefusal.SysrootMissing },
    { name: "a relative zig", found: { ...FOUND, zig: "zig/zig" }, code: LinuxSettingsRefusal.ToolchainUnusable },
    {
      name: "a sysroot with ':'",
      found: { ...FOUND, sysroot: "/store/a:b" },
      code: LinuxSettingsRefusal.ToolchainUnusable,
    },
    {
      name: "a cargo-zigbuild with a newline",
      found: { ...FOUND, cargoZigbuild: "/store/x\n/cargo-zigbuild" },
      code: LinuxSettingsRefusal.ToolchainUnusable,
    },
    {
      name: "a relative cargo-zigbuild",
      found: { ...FOUND, cargoZigbuild: "cargo-zigbuild" },
      code: LinuxSettingsRefusal.ToolchainUnusable,
    },
    { name: "a build folder with ':'", found: { ...FOUND, bin: "/b:c" }, code: LinuxSettingsRefusal.ToolchainUnusable },
  ];
  for (const row of missing)
    it(`refuses ${row.name} with ${row.code} and no setting at all`, () => {
      const settings = linuxBuildSettings(row.found);
      assert.equal(settings.ok, false);
      assert.equal(!settings.ok && settings.code, row.code);
      assert.equal("env" in settings, false);
    });

  it("is the lane's targetSettings for Linux only, located per build folder", async () => {
    const located: string[] = [];
    const settingsOf = linuxTargetSettings(async () => {
      located.push("linux");
      return { zig: FOUND.zig, cargoZigbuild: FOUND.cargoZigbuild, sysroot: FOUND.sysroot };
    });
    assert.equal(await settingsOf(BuildTarget.Mac, { bin: FOUND.bin }), null);
    assert.equal(await settingsOf(BuildTarget.Windows, { bin: FOUND.bin }), null);
    assert.deepEqual(located, []);
    const linux = await settingsOf(BuildTarget.Linux, { bin: FOUND.bin });
    assert.ok(linux?.ok);
    assert.deepEqual(located, ["linux"]);
    const failing = linuxTargetSettings(async () => {
      throw new Error("the store is unreadable");
    });
    const refused = await failing(BuildTarget.Linux, { bin: FOUND.bin });
    assert.equal(refused?.ok, false);
    assert.equal(refused && !refused.ok && refused.code, LinuxSettingsRefusal.ToolchainUnusable);
  });
});

// ---------- the lane over stub programs ----------

const STUB_ARTIFACT =
  '{"reason":"compiler-artifact","package_id":"path+file://STAGE#game@0.0.0","manifest_path":"MANIFEST",' +
  '"target":{"kind":["bin"],"crate_types":["bin"],"name":"game"},"filenames":["EXE"],"executable":"EXE","fresh":false}';

/** A stub cargo-zigbuild: records each call's arguments and environment, then plays clippy or the build. */
const STUB_ZIGBUILD = `#!/bin/sh
sub=$1
shift
log="$CARGO_TARGET_DIR/../front-$sub.log"
printf '%s\\n' "$@" > "$log.args"
env > "$log.env"
manifest=""
prev=""
for a in "$@"; do
  if [ "$prev" = --manifest-path ]; then manifest=$a; fi
  prev=$a
done
case "$sub" in
  clippy) echo '{"reason":"build-finished","success":true}' ;;
  zigbuild)
    exe="$CARGO_TARGET_DIR/x86_64-unknown-linux-gnu/release/game"
    mkdir -p "$(dirname "$exe")"
    printf 'ELF stand-in\\n' > "$exe"
    echo '${STUB_ARTIFACT}' | sed -e "s#STAGE#$(dirname "$manifest")#" -e "s#MANIFEST#$manifest#" -e "s#EXE#$exe#g"
    echo '{"reason":"build-finished","success":true}'
    ;;
  *) echo "unexpected front subcommand $sub" >&2; exit 2 ;;
esac
`;

/** A stub cargo that only generates the lock (clippy and the build must go through the front). */
const STUB_CARGO = `#!/bin/sh
sub=$1
shift
manifest=""
prev=""
for a in "$@"; do
  if [ "$prev" = --manifest-path ]; then manifest=$a; fi
  prev=$a
done
case "$sub" in
  generate-lockfile) printf '# lock\\nversion = 4\\n' > "$(dirname "$manifest")/Cargo.lock" ;;
  *) echo "cargo $sub must run through cargo-zigbuild" >&2; exit 3 ;;
esac
`;

const RUSTC_VV = "rustc 1.99.0 (abcdef012 2026-09-01)\nbinary: rustc\nhost: aarch64-apple-darwin\nrelease: 1.99.0\n";

/** `request` run by /bin/sh with this process's environment, as an unsandboxed stand-in. */
async function runShell(request: RunRequest): Promise<RunResult> {
  const { spawn } = await import("node:child_process");
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", request.command], { cwd: request.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut: false,
        truncated: false,
        sandboxed: false,
        command: request.command,
        cwd: request.cwd,
      }),
    );
  });
}

/** A stand-in Linux game: its genex.toml, a source and one asset. */
async function standInGame(parent: string): Promise<string> {
  const dir = path.join(parent, "pond");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeFile(path.join(dir, "genex.toml"), '[game]\ntitle = "Pond"\n');
  await writeFile(path.join(dir, "src", "main.rs"), "fn main() {}\n");
  await writeFile(path.join(dir, "assets", "fish.txt"), "fish");
  return dir;
}

async function standInStage(game: { dir: string }, into: string): Promise<RustStaged> {
  for (const folder of ["src", "assets"]) {
    await mkdir(path.join(into, folder), { recursive: true });
    for (const name of await readdir(path.join(game.dir, folder)))
      await writeFile(path.join(into, folder, name), await readFile(path.join(game.dir, folder, name)));
  }
  await writeFile(path.join(into, "Cargo.toml"), '[package]\nname = "game"\nversion = "0.0.0"\n\n[dependencies]\n');
  return { ok: true, dependencies: [] };
}

function linuxGame(dir: string): GameBuildGame {
  return {
    project: "pond",
    dir,
    shape: {
      entry: "index.html",
      main: "src/main.rs",
      build: null,
      install: null,
      own: false,
      kind: ProjectKind.RustWgpu,
      serve: ".",
    },
    destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Linux] },
  };
}

describe("the lane builds a Linux game through cargo-zigbuild (stand-in programs)", () => {
  it(
    "locks with cargo, runs clippy and the build through the front with the glibc target, and admits `game`",
    POSIX_ONLY,
    async () => {
      const parent = await realpath(await tmpDir("rust-linux-lane-"));
      const store = path.join(parent, "store");
      const bin = path.join(store, "rust", "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, "cargo"), STUB_CARGO, { mode: 0o755 });
      await writeFile(path.join(bin, "rustc"), `#!/bin/sh\nprintf '%s' '${RUSTC_VV}'\n`, { mode: 0o755 });
      const front = path.join(store, "cargo-zigbuild", "cargo-zigbuild");
      await mkdir(path.dirname(front), { recursive: true });
      await writeFile(front, STUB_ZIGBUILD, { mode: 0o755 });
      const zig = path.join(store, "zig", "zig");
      const sysroot = path.join(store, "linux-sysroot");
      await mkdir(path.dirname(zig), { recursive: true });
      await mkdir(sysroot, { recursive: true });
      const vendor = path.join(store, "vendor");
      await mkdir(vendor, { recursive: true });
      const toolchain: RustToolchain = { bin, vendor, clippyConf: store, reads: [store] };
      const specs: RustBuildSandboxSpec[] = [];
      const commands: string[] = [];
      const sandbox = async (spec: RustBuildSandboxSpec): Promise<RustBuildSandbox> => {
        specs.push(spec);
        return {
          run: async (request) => {
            commands.push(request.command);
            return await runShell(request);
          },
          dispose: async () => {},
        };
      };
      const builds = new RustBuilds({
        root: path.join(parent, "rust-builds"),
        sandbox,
        locate: async () => ({ ok: true, toolchain }),
        currentLock: async () => LOCK,
        stage: standInStage,
        emit: () => {},
        platform: "darwin",
        cores: 8,
        denyWrite: [],
        writeLock: async () => {},
        builders: { [BuildTarget.Linux]: RUST_LINUX_BUILDER },
        targetSettings: linuxTargetSettings(async () => ({ zig, cargoZigbuild: front, sysroot })),
      });
      const dir = await standInGame(parent);
      const outcome = await builds.ensure(linuxGame(dir), BuildTarget.Linux, CppBuildPurpose.Export);
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
      assert.deepEqual(await readdir(outcome.output ?? ""), ["assets", "game"]);
      assert.equal(outcome.rust?.receipt?.triple, "x86_64-unknown-linux-gnu");

      const buildFolder = specs[0]?.bin ?? "";
      for (const read of [path.dirname(zig), path.dirname(front), sysroot])
        assert.ok(specs[0]?.reads.includes(read), read);
      const clippyArgs = (await readFile(path.join(buildFolder, "front-clippy.log.args"), "utf8")).split("\n");
      const buildArgs = (await readFile(path.join(buildFolder, "front-zigbuild.log.args"), "utf8")).split("\n");
      for (const args of [clippyArgs, buildArgs]) {
        assert.equal(args[args.indexOf("--target") + 1], "x86_64-unknown-linux-gnu.2.28");
        for (const flag of ["--offline", "--locked", "--message-format=json", "--release"])
          assert.ok(args.includes(flag), flag);
      }
      assert.deepEqual(clippyArgs.slice(-3, -1), ["-D", "warnings"]);
      const env = await readFile(path.join(buildFolder, "front-zigbuild.log.env"), "utf8");
      assert.match(env, new RegExp(`^PKG_CONFIG_SYSROOT_DIR_${TRIPLE_ENV}=${sysroot}$`, "m"));
      assert.match(env, new RegExp(`^CARGO_ZIGBUILD_ZIG_PATH=${zig}$`, "m"));
      assert.match(
        env,
        /^RUSTFLAGS=-F unsafe_code -C link-arg=-Wl,--enable-new-dtags -C link-arg=-Wl,-rpath,\$ORIGIN$/m,
      );
      assert.doesNotMatch(env, /^HTTPS?_PROXY=/im, "the front starts from an empty environment too");
      assert.ok(
        commands.some((command) => command.includes("generate-lockfile")),
        "the lock is cargo's",
      );
    },
  );
});

// ---------- the export's ELF policy ----------

describe("a Rust Linux export's ELF policy", () => {
  const verdict = (bytes: Buffer) => {
    const admitted = admitRustLinuxExport(bytes);
    return admitted.ok ? "admitted" : `${admitted.refusal}/${admitted.problem}`;
  };
  const refused = `${NativeRefusal.RunpathNotOrigin}/${RustAdmissionProblem.SearchPath}`;

  it("admits the real link set with a RUNPATH of exactly $ORIGIN", () => {
    assert.equal(verdict(linuxBinary({ runpath: ["$ORIGIN"] })), "admitted");
    const runtime = ["libgcc_s.so.1", "libasound.so.2", "libudev.so.1"];
    assert.equal(verdict(linuxBinary({ needed: [...M2.linux.needed, ...runtime], runpath: ["$ORIGIN"] })), "admitted");
  });

  const hostile = [
    { name: "no RUNPATH (the bundled Vulkan loader is never found)", spec: { runpath: [] }, want: refused },
    { name: "a RUNPATH beside $ORIGIN", spec: { runpath: ["$ORIGIN:/usr/lib"] }, want: refused },
    { name: "a RUNPATH of $ORIGIN/lib", spec: { runpath: ["$ORIGIN/lib"] }, want: refused },
    { name: "DT_RPATH $ORIGIN instead", spec: { runpath: [], rpath: ["$ORIGIN"] }, want: refused },
    {
      name: "a glibc 2.29 symbol version",
      spec: { runpath: ["$ORIGIN"], versionNeeds: [{ file: "libc.so.6", names: ["GLIBC_2.2.5", "GLIBC_2.29"] }] },
      want: `${NativeRefusal.GlibcTooNew}/${RustAdmissionProblem.GlibcTooNew}`,
    },
    {
      name: "GLIBC_PRIVATE",
      spec: { runpath: ["$ORIGIN"], versionNeeds: [{ file: "libc.so.6", names: ["GLIBC_2.2.5", "GLIBC_PRIVATE"] }] },
      want: `${NativeRefusal.GlibcTooNew}/${RustAdmissionProblem.GlibcTooNew}`,
    },
    {
      name: "the system Vulkan loader linked in",
      spec: { runpath: ["$ORIGIN"], needed: [...M2.linux.needed, "libvulkan.so.1"] },
      want: `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.ForeignImport}`,
    },
  ];
  for (const row of hostile)
    it(`refuses ${row.name}`, () => {
      assert.equal(verdict(linuxBinary(row.spec)), row.want);
    });

  it("leaves the lane's own policy as it was: a dev build without RUNPATH is still admitted there", () => {
    assert.equal(admitRustLinuxElf(linuxBinary({ runpath: [] })).ok, true);
  });
});

// ---------- the SwiftShader split ----------

/** A fake ANGLE-style folder holding the split's files with made-up bytes, and its own manifest and pin. */
async function fakeSplit(parent: string) {
  const folder = path.join(parent, "split");
  const files = [];
  for (const rel of SWIFTSHADER_FILES) {
    const bytes = Buffer.from(`fake ${rel}\n`);
    await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
    await writeFile(path.join(folder, rel), bytes);
    files.push({ rel, sha256: sha256Hex(bytes), size: bytes.length });
  }
  const manifest = swiftShaderManifest(BUNDLE_LOCK.commit, files);
  await writeFile(path.join(folder, "manifest.json"), manifest);
  const pin = {
    target: SWIFTSHADER_TARGET,
    from: "linux-x64-vulkan",
    manifestSha256: sha256Hex(manifest),
    manifestBytes: manifest.length,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  };
  return { folder, pin };
}

describe("the SwiftShader + Vulkan loader split", () => {
  it("is pinned in the ANGLE bundle lock beside the three builds, split from linux-x64-vulkan", () => {
    const pin = BUNDLE_LOCK.swiftshader;
    assert.ok(pin);
    assert.equal(pin.target, "linux-x64-swiftshader");
    assert.equal(pin.from, "linux-x64-vulkan");
    assert.equal(pin.files, SWIFTSHADER_FILES.length);
    for (const name of Object.values(LinuxVulkanFile)) assert.ok(SWIFTSHADER_FILES.includes(name), name);
    const runtime = Object.values(LINUX_VULKAN_FILE_PINS).reduce((sum, file) => sum + file.size, 0);
    assert.ok(pin.bytes > runtime, "the licences count too");
  });

  it("refuses a lock whose swiftshader entry names another target or a short digest", () => {
    const lock = JSON.parse(JSON.stringify({ schema: 1, ...BUNDLE_LOCK }));
    assert.ok(parseBundleLock(lock));
    for (const change of [{ target: "linux-x64-vulkan" }, { from: "windows-x64-d3d11" }, { manifestSha256: "abc" }])
      assert.equal(parseBundleLock({ ...lock, swiftshader: { ...lock.swiftshader, ...change } }), null);
    const { swiftshader: _, ...without } = lock;
    assert.equal(parseBundleLock(without)?.swiftshader, undefined, "a lock with no split still parses");
  });

  it("derives its manifest from the files' bytes alone: the same files give the same pin", () => {
    const files = [
      { rel: "b", sha256: "1".repeat(64), size: 1 },
      { rel: "a", sha256: "2".repeat(64), size: 2 },
    ];
    const one = swiftShaderManifest(BUNDLE_LOCK.commit, files);
    assert.deepEqual(one, swiftShaderManifest(BUNDLE_LOCK.commit, [...files].reverse()));
    assert.deepEqual(Object.keys(JSON.parse(one.toString()).files), ["a", "b"]);
  });

  it("refuses a SwiftShader whose bytes are not the pinned software Vulkan, even under a matching manifest", async () => {
    const { folder, pin } = await fakeSplit(await tmpDir("swiftshader-fake-"));
    await assert.rejects(
      () => verifySwiftShaderFolder(folder, pin, BUNDLE_LOCK.commit),
      (error: unknown) => error instanceof ArtifactError && error.fault === ArtifactFault.FileDigest,
    );
  });

  it("refuses a split whose manifest is not the lock's pin", async () => {
    const { folder } = await fakeSplit(await tmpDir("swiftshader-fake-"));
    const pin = BUNDLE_LOCK.swiftshader;
    assert.ok(pin);
    await assert.rejects(
      () => verifySwiftShaderFolder(folder, pin, BUNDLE_LOCK.commit),
      (error: unknown) => error instanceof ArtifactError && error.fault === ArtifactFault.ManifestDigest,
    );
  });
});

describe("the SwiftShader split of the pinned Linux ANGLE build (developer toolchains)", () => {
  const angle = devTool("angleLinux");
  const angleRows = { ...needsTools("angleLinux") };
  async function realSplit() {
    assert.ok("path" in angle);
    const lock = BUNDLE_LOCK;
    const pin = lock.swiftshader;
    assert.ok(pin);
    const manifest = await readPinnedManifest(angle.path, lock.targets["linux-x64-vulkan"]);
    const into = path.join(await realpath(await tmpDir("swiftshader-real-")), "swiftshader", "c5bf49e78850");
    const made = await splitSwiftShader(angle.path, manifest, into, pin, lock.commit);
    return { made, pin, lock };
  }

  it(
    "splits the pinned Linux ANGLE build into exactly the lock's pin, runtime files their pins",
    angleRows,
    async () => {
      const { made, pin, lock } = await realSplit();
      assert.equal(made.files, pin.files);
      assert.equal(made.bytes, pin.bytes);
      const runtime = await readSwiftShaderRuntime(made.folder, pin, lock.commit);
      for (const name of Object.values(LinuxVulkanFile)) {
        assert.equal(runtime.files[name].length, LINUX_VULKAN_FILE_PINS[name].size, name);
        assert.equal(sha256Hex(runtime.files[name]), LINUX_VULKAN_FILE_PINS[name].sha256, name);
      }
      for (const file of [...runtime.licences.SwiftShader, ...runtime.licences.VulkanLoader])
        assert.ok(existsSync(file), file);
    },
  );

  const tampered = [
    { name: "one byte of libvk_swiftshader.so", rel: LinuxVulkanFile.SwiftShader, fault: ArtifactFault.FileDigest },
    { name: "the ICD manifest", rel: LinuxVulkanFile.SwiftShaderIcd, fault: ArtifactFault.FileDigest },
    { name: "the split's manifest", rel: "manifest.json", fault: ArtifactFault.ManifestDigest },
  ];
  for (const row of tampered)
    it(`refuses a split with ${row.name} altered`, angleRows, async () => {
      const { made, pin, lock } = await realSplit();
      const at = path.join(made.folder, row.rel);
      const bytes = await readFile(at);
      bytes[bytes.length - 2] = (bytes[bytes.length - 2] ?? 0) ^ 1;
      await writeFile(at, bytes);
      await assert.rejects(
        () => readSwiftShaderRuntime(made.folder, pin, lock.commit),
        (error: unknown) => error instanceof ArtifactError && error.fault === row.fault,
      );
    });

  it(
    "is made beside the bundled Linux ANGLE copy and held to its pin by the packaged-app check",
    angleRows,
    async () => {
      assert.ok("path" in angle);
      const resources = path.join(await realpath(await tmpDir("swiftshader-resources-")), "resources");
      const copied = await copyAngleTarget(angle.path, resources, AngleTarget.LinuxX64Vulkan);
      assert.equal(copied.swiftshader?.files, BUNDLE_LOCK.swiftshader?.files);
      const linux = () =>
        verifyAngleBundle(resources).then((checks) =>
          checks.find((check) => check.target === AngleTarget.LinuxX64Vulkan),
        );
      assert.equal((await linux())?.ok, true);
      const at = path.join(copied.swiftshader?.folder ?? "", LinuxVulkanFile.VulkanLoader);
      const bytes = await readFile(at);
      bytes[100] = (bytes[100] ?? 0) ^ 1;
      await writeFile(at, bytes);
      const check = await linux();
      assert.equal(check?.ok, false);
      assert.equal(check && !check.ok && check.fault, ArtifactFault.FileDigest);
    },
  );

  it("refuses an extra file beside the split", angleRows, async () => {
    const { made, pin, lock } = await realSplit();
    await writeFile(path.join(made.folder, "libvulkan.so"), "planted");
    await assert.rejects(
      () => verifySwiftShaderFolder(made.folder, pin, lock.commit),
      (error: unknown) => error instanceof ArtifactError,
    );
  });
});

// ---------- the notices ----------

describe("a Rust Linux export's notices row", () => {
  const LOCK_TEXT = '[[package]]\nname = "game"\nversion = "0.1.0"\n';
  const core = Object.fromEntries(
    [RustRuntimePart.Std, RustRuntimePart.CompilerBuiltins, RustRuntimePart.CompilerRt].map((part) => [
      part,
      [{ kind: NoticeSourceKind.Text, name: "LICENSE", text: part }],
    ]),
  );

  /** A zig folder with its LICENSE and a split folder with its licence files, as the store holds them. */
  async function storeLicences() {
    const root = await tmpDir("rust-linux-notices-");
    await mkdir(path.join(root, "zig"), { recursive: true });
    await writeFile(path.join(root, "zig", "LICENSE"), "MIT");
    for (const rel of Object.values(SWIFTSHADER_LICENCES).flat()) {
      await mkdir(path.dirname(path.join(root, "split", rel)), { recursive: true });
      await writeFile(path.join(root, "split", rel), rel);
    }
    return { zig: path.join(root, "zig", "zig"), swiftShader: path.join(root, "split") };
  }

  it("names zig's runtime, SwiftShader and the Vulkan loader beside the core parts", () => {
    const parts = (RUST_NOTICE_ROWS[BuildTarget.Linux] ?? []).map((row) => row.part);
    for (const part of [
      RustRuntimePart.Std,
      RustRuntimePart.ZigRuntime,
      RustRuntimePart.SwiftShader,
      RustRuntimePart.VulkanLoader,
    ])
      assert.ok(parts.includes(part), part);
  });

  it("reads their licences from the store's zig and the SwiftShader split, and generates the notices", async () => {
    const store = await storeLicences();
    const linux = await rustRuntimeSources({ sysroot: "/nowhere", vendorDirs: [], crates: [], ...store });
    assert.equal(linux[RustRuntimePart.SwiftShader]?.length, SWIFTSHADER_LICENCES.SwiftShader.length);
    assert.equal(linux[RustRuntimePart.VulkanLoader]?.length, 1);
    assert.equal(linux[RustRuntimePart.ZigRuntime]?.length, 1);
    const made = rustNotices({
      target: BuildTarget.Linux,
      lock: LOCK_TEXT,
      roots: ["game"],
      licences: new Map(),
      runtime: { ...core, ...linux },
    });
    assert.ok(made.ok, made.ok ? "" : made.detail);
  });

  it("refuses a Linux export whose SwiftShader licences are missing, typed", async () => {
    const { zig } = await storeLicences();
    const linux = await rustRuntimeSources({ sysroot: "/nowhere", vendorDirs: [], crates: [], zig });
    const made = rustNotices({
      target: BuildTarget.Linux,
      lock: LOCK_TEXT,
      roots: ["game"],
      licences: new Map(),
      runtime: { ...core, ...linux },
    });
    assert.equal(!made.ok && made.refusal, NoticeRefusal.RuntimeNoticeMissing);
    assert.match(!made.ok ? made.detail : "", /swiftshader/);
  });
});

// ---------- the .tar.gz ----------

describe("a Rust Linux export's .tar.gz", () => {
  const runtime = {
    [LinuxVulkanFile.VulkanLoader]: Buffer.from("loader"),
    [LinuxVulkanFile.SwiftShader]: Buffer.from("swiftshader"),
    [LinuxVulkanFile.SwiftShaderIcd]: Buffer.from('{"ICD":{"library_path":"./libvk_swiftshader.so"}}\n'),
  };
  const input = {
    name: "pond",
    executable: Buffer.from("\x7fELF game"),
    assets: [{ path: "fish.txt", content: { bytes: Buffer.from("fish") } }],
    runtime,
    notices: {
      index: "Third-party notices\n",
      files: [{ path: "swiftshader/LICENSE.txt", content: { bytes: Buffer.from("Apache-2.0") } }],
    },
    gpuQualification: GpuQualification.Untested,
  };

  it("lays out `<game>/<game>` 0755 with SwiftShader, its ICD and the loader beside it at the root", () => {
    const items = rustLinuxArchiveItems(input);
    const files = items.filter((item) => item.kind === ArchiveItemKind.File);
    const byPath = new Map(files.map((item) => [item.path, item]));
    const exe = byPath.get("pond/pond");
    assert.equal(exe?.kind === ArchiveItemKind.File && exe.executable, true);
    for (const name of Object.values(LinuxVulkanFile)) {
      const item = byPath.get(`pond/${name}`);
      assert.ok(item, name);
      assert.equal(item.kind === ArchiveItemKind.File && item.executable, false, `${name} is not a program`);
    }
    assert.ok(byPath.has("pond/assets/fish.txt"));
    assert.ok(byPath.has("pond/notices/swiftshader/LICENSE.txt"));
    assert.ok(byPath.has("pond/THIRD-PARTY-NOTICES.txt"));
    const readme = byPath.get("pond/README.txt");
    assert.ok(readme?.kind === ArchiveItemKind.File && "bytes" in readme.content);
    const text = Buffer.from(readme.content.bytes).toString("utf8");
    assert.match(text, /SwiftShader/);
    assert.match(text, /never on a real graphics card/);
    assert.ok(files.every((item) => item.path.startsWith("pond/")));
  });

  it("states nothing about software rendering once a real GPU ran the row", () => {
    const items = rustLinuxArchiveItems({ ...input, gpuQualification: GpuQualification.RealGpu });
    const readme = items.find((item) => item.path === "pond/README.txt");
    assert.ok(readme?.kind === ArchiveItemKind.File && "bytes" in readme.content);
    assert.doesNotMatch(Buffer.from(readme.content.bytes).toString("utf8"), /never on a real graphics card/);
  });

  it("refuses a game name that is not one plain path segment", () => {
    for (const name of ["../pond", "po/nd", "", ".", "libvulkan.so.1"])
      assert.throws(() => rustLinuxArchiveItems({ ...input, name }), name);
  });

  it("writes the same bytes twice", async () => {
    const dir = await tmpDir("rust-linux-tar-");
    const one = await writeRustLinuxTarGz(input, path.join(dir, "one.tar.gz"));
    const two = await writeRustLinuxTarGz(input, path.join(dir, "two.tar.gz"));
    assert.equal(one.sha256, two.sha256);
    assert.deepEqual(await readFile(path.join(dir, "one.tar.gz")), await readFile(path.join(dir, "two.tar.gz")));
  });

  it("promises no software fallback the loader cannot reach", () => {
    const readme = rustLinuxArchiveItems(input).find((item) => item.path === "pond/README.txt");
    assert.ok(readme?.kind === ArchiveItemKind.File && "bytes" in readme.content);
    assert.doesNotMatch(Buffer.from(readme.content.bytes).toString("utf8"), /draws the game on the CPU/);
  });

  it("refuses a credential in any file, or a file the inspector refuses, and leaves nothing behind", async () => {
    const secret = "sk-genex-test-0123456789abcdef";
    const leaky = { ...input, assets: [{ path: "fish.txt", content: { bytes: Buffer.from(`key=${secret}`) } }] };
    const rows: Array<{ name: string; options: Parameters<typeof writeRustLinuxTarGz>[2] }> = [
      {
        name: "a credential in an asset",
        options: { secretValues: [secret] },
      },
      {
        name: "an asset the inspector refuses mid-write",
        options: {
          inspect: (entry) => {
            if (entry.endsWith("fish.txt")) throw new Error("asset changed after admission");
          },
        },
      },
    ];
    for (const row of rows) {
      const dir = await tmpDir("rust-linux-tar-refused-");
      const target = path.join(dir, "pond-linux-x64.tar.gz");
      await assert.rejects(writeRustLinuxTarGz(leaky, target, row.options), row.name);
      assert.deepEqual(await readdir(dir), [], `${row.name}: no archive and no partial file`);
    }
    const dir = await tmpDir("rust-linux-tar-secret-");
    await assert.rejects(
      writeRustLinuxTarGz(leaky, path.join(dir, "pond.tar.gz"), { secretValues: [secret] }),
      (error: unknown) => error instanceof NativeArchiveError && error.code === ArchiveRefusal.SecretFound,
    );
  });
});

// ---------- the real lane ----------

/** Why the real rows cannot run here, or null. */
function absent(): string | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") return "an Apple silicon Mac";
  const needs = [
    "sysroot/bin/cargo",
    "sysroot/bin/cargo-clippy",
    `sysroot/lib/rustlib/${SPEC.rustTriple}/lib`,
    "tools/zig/zig",
    "tools/bin/cargo-zigbuild",
  ];
  for (const need of needs)
    if (!existsSync(path.join(TOOLCHAIN_DIR, need))) return `the Rust toolchain (${path.join(TOOLCHAIN_DIR, need)})`;
  if (!existsSync(path.join(VENDOR_DIR, "genex-0.1.0")))
    return `the release's vendored crates (${VENDOR_DIR}; rust-release.ts tree --out .studio-dev/rust-release/e2e)`;
  return null;
}

function needsToolchain(): { skip?: string } {
  const missing = absent();
  if (!missing) return {};
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

/** The M0a link probe's source: it calls cpal's ALSA host and gilrs's udev backend, so its link needs both stubs. */
const LINK_PROBE_MAIN = path.join(REPO, "scripts", "spike", "rust-wgpu", "link-probe", "src", "main.rs");

/** A real Linux lane in a fresh home: the pinned toolchain, the release's crates, the bundled sysroot. */
async function realLinuxLane() {
  const toolchainDir = realpathSync(TOOLCHAIN_DIR);
  const home = await realpath(await tmpDir("rust-linux-real-"));
  const games = path.join(home, "games");
  await mkdir(games, { recursive: true });
  const vendor = await realpath(VENDOR_DIR);
  const payload = rustPayloadDir(path.join(home, "resources"));
  await mkdir(payload, { recursive: true });
  for (const file of ["Cargo.lock", "clippy.toml"])
    await writeFile(path.join(payload, file), await readFile(path.join(WORKSPACE, file)));
  const { folder: sysroot } = await bundleLinuxSysroot({ resources: path.join(home, "sysroot-resources") });
  const toolchain: RustToolchain = {
    bin: path.join(toolchainDir, "sysroot", "bin"),
    vendor,
    clippyConf: payload,
    reads: [toolchainDir, vendor, payload],
  };
  const tools = {
    zig: path.join(toolchainDir, "tools", "zig", "zig"),
    cargoZigbuild: path.join(toolchainDir, "tools", "bin", "cargo-zigbuild"),
  };
  const state = { sysroot };
  const lane = (stage: RustBuildsOptions["stage"]) =>
    new RustBuilds({
      root: path.join(home, "app-data", "rust-builds"),
      sandbox: rustBuildSandboxes({ secretPaths: [], enabled: true, denyRead: [os.homedir(), games] }),
      locate: async () => ({ ok: true, toolchain }),
      currentLock: async () => LOCK,
      stage,
      emit: () => {},
      platform: process.platform,
      cores: 8,
      denyWrite: [],
      writeLock: async () => {},
      builders: { [BuildTarget.Linux]: RUST_LINUX_BUILDER },
      targetSettings: linuxTargetSettings(async () => ({ ...tools, sysroot: state.sysroot })),
    });
  return { home, games, payload, sysroot, state, lane };
}

/**
 * A stand-in stage for the link probe: its source under a host manifest naming cpal and gilrs
 * (the lane's lock and vendored-crate checks still run; the allowlist is the shipped stager's).
 */
function probeStage(): RustBuildsOptions["stage"] {
  return async (_game, into) => {
    await mkdir(path.join(into, "src"), { recursive: true });
    await mkdir(path.join(into, "assets"), { recursive: true });
    await writeFile(path.join(into, "src", "main.rs"), await readFile(LINK_PROBE_MAIN));
    const manifest = [
      "[package]",
      'name = "game"',
      'version = "0.0.0"',
      'edition = "2024"',
      "publish = false",
      "",
      "[dependencies]",
      'cpal = "=0.18.2"',
      'gilrs = "=0.11.2"',
      "",
      "[workspace]",
      "",
    ].join("\n");
    await writeFile(path.join(into, "Cargo.toml"), manifest);
    return { ok: true, dependencies: [] };
  };
}

/** The ELF facts every Linux export must have: x86_64, RUNPATH exactly $ORIGIN, glibc ≤ 2.28, admitted. */
function assertLinuxExportElf(bytes: Buffer, name: string) {
  const image = parseElf(bytes);
  assert.equal(image.machine, 62, name);
  assert.deepEqual(image.runpath, ["$ORIGIN"], name);
  assert.deepEqual(image.rpath, [], name);
  const max = highestGlibc(image);
  assert.ok(
    max !== null && Number.parseFloat(max.split(".")[1] ?? "99") <= 28,
    `${name}: glibc ${max} > ${LINUX_GLIBC_FLOOR}`,
  );
  const admitted = admitRustLinuxExport(bytes);
  assert.ok(admitted.ok, admitted.ok ? "" : `${name}: ${admitted.refusal}: ${admitted.detail}`);
  console.log(
    `${name}: ${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex")}, needs ${image.needed.join(", ")}, glibc ${max}`,
  );
  return image;
}

describe("the Rust lane builds for Linux with the real toolchain (from the Mac)", () => {
  it("builds the template for glibc 2.28 with RUNPATH $ORIGIN, admitted for export", {
    ...needsToolchain(),
    timeout: 2 * COLD_BUILD_MS,
  }, async () => {
    const real = await realLinuxLane();
    const dir = path.join(real.games, "pond");
    await cp(TEMPLATE, dir, { recursive: true });
    for (const file of [path.join(dir, "genex.toml"), path.join(dir, "src", "main.rs")])
      await writeFile(file, (await readFile(file, "utf8")).replaceAll("__GAME_TITLE__", "Pond"));
    const built = await real
      .lane(shippedRustStage(real.payload))
      .ensure(linuxGame(dir), BuildTarget.Linux, CppBuildPurpose.Export);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    console.log(`linux build steps: ${JSON.stringify(built.rust?.receipt?.steps)}`);
    assertLinuxExportElf(await readFile(path.join(built.output ?? "", "game")), "template");
  });

  it("links cpal and gilrs against the sysroot's stubs, and fails to link without the libasound stub", {
    ...needsToolchain(),
    timeout: COLD_BUILD_MS,
  }, async () => {
    const real = await realLinuxLane();
    const dir = await standInGame(real.games);
    const lane = real.lane(probeStage());
    const built = await lane.ensure(linuxGame(dir), BuildTarget.Linux, CppBuildPurpose.Export);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    const image = assertLinuxExportElf(await readFile(path.join(built.output ?? "", "game")), "link probe");
    for (const library of ["libasound.so.2", "libudev.so.1"]) assert.ok(image.needed.includes(library), library);

    // Red row: the same sysroot without the libasound stub cannot link it.
    const stubless = path.join(real.home, "stubless-sysroot");
    await cp(real.sysroot, stubless, { recursive: true });
    await rm(path.join(stubless, "usr", "lib64", "libasound.so"));
    real.state.sysroot = stubless;
    const failed = await real.lane(probeStage()).ensure(linuxGame(dir), BuildTarget.Linux, CppBuildPurpose.Export);
    assert.equal(failed.ok, false);
    assert.equal(failed.problem?.reason, BuildProblemCode.CommandFailed);
    const said = JSON.stringify(failed.problem?.lines);
    assert.match(said, /asound/, said);
    console.log(`without the stub: ${said.slice(0, 400)}`);
  });
});

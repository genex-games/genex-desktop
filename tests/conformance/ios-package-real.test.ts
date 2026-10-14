/**
 * The iPhone package over a real build (M5.1): the Rust template cross-compiled offline for
 * aarch64-apple-ios-sim with the pinned toolchain (`scripts/toolchains/rust-env.ts`), packaged as
 * a Simulator app by `packageIosApp`, and signed ad hoc by the real `codesign` in its own
 * `ProcessSandbox` (`mobileSignSandboxOptions`). The app must pass `codesign --verify --strict`,
 * `plutil -lint`, the Rust iOS admission for the Simulator platform, and declare every
 * required-reason API category its executable imports.
 *
 * Needs a Mac with Xcode (a Simulator SDK) and the pinned Rust toolchain with the
 * aarch64-apple-ios-sim standard library; without them the row skips, and
 * `GENEX_REQUIRE_TOOLCHAINS=1` turns the skip into a failure (off a Mac it always skips). Nothing
 * is installed or launched on a Simulator or a device: the owner launches the app at M5.7.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execHost } from "../../src/main/core/toolchains.ts";
import { IOS_DEPLOYMENT_TARGET, MobileBuild, RUST_MOBILE_BUILDERS } from "../../src/main/rust-build-mobile.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { ExportSigning, MobileArtifact } from "../../src/shared/game-export-contract.ts";
import { IOS_PRIVACY_CATEGORIES, IosOrientation, packageIosApp } from "../../src/substrate/ios-package.ts";
import { mobileSignSandboxOptions } from "../../src/substrate/mobile-sign.ts";
import { admitRustMachO, ApplePlatformCode } from "../../src/substrate/native-bundle.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { probeXcodeSdks } from "../../src/substrate/toolchain-store/xcode-probe.ts";
import { SigningRequester } from "../../src/substrate/windows-sign.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE = path.join(REPO, "src", "game-template-rust");
const FACADE = path.join(REPO, "native", "genex-rust", "crates", "genex");
const WORKSPACE_LOCK = path.join(REPO, "native", "genex-rust", "Cargo.lock");
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR || path.join(REPO, ".studio-dev", "spike-toolchain");
const SYSROOT = path.join(TOOLCHAIN_DIR, "sysroot");
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
const TRIPLE = RUST_MOBILE_BUILDERS[MobileBuild.IosSimulator].triple;
const BUNDLE_ID = "games.genex.game.00000000a5e1";
/** A cold cross build compiles the facade's whole dependency graph for the triple. */
const CROSS_BUILD_MS = 30 * MINUTE_MS;
const OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Each required-reason API's symbols, by the privacy manifest's category: an executable importing
 * one needs that category declared, or App Store review refuses the app.
 */
const REQUIRED_REASON_SYMBOLS: Record<string, readonly string[]> = {
  NSPrivacyAccessedAPICategoryFileTimestamp: [
    "_stat",
    "_fstat",
    "_lstat",
    "_fstatat",
    "_getattrlist",
    "_fgetattrlist",
    "_getattrlistat",
    "_getattrlistbulk",
  ],
  NSPrivacyAccessedAPICategorySystemBootTime: ["_mach_absolute_time"],
  NSPrivacyAccessedAPICategoryDiskSpace: ["_statfs", "_statvfs", "_fstatfs", "_fstatvfs", "_getattrlist"],
};

/** Why the row cannot run here, or null. */
function absent(): string | null {
  if (process.platform !== "darwin") return "a Mac";
  if (!existsSync(path.join(SYSROOT, "bin", "cargo"))) return `the Rust toolchain (${SYSROOT})`;
  if (!existsSync(path.join(TOOLCHAIN_DIR, "vendor"))) return `the vendored crates (${TOOLCHAIN_DIR}/vendor)`;
  if (!existsSync(path.join(SYSROOT, "lib", "rustlib", TRIPLE, "lib"))) return `rust-std for ${TRIPLE}`;
  return null;
}

function needs(): { skip?: string } {
  const missing = absent();
  if (!missing) return {};
  if (REQUIRED && process.platform === "darwin") throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

const HOST_MANIFEST = [
  "[package]",
  'name = "game"',
  'version = "0.0.0"',
  'edition = "2024"',
  "publish = false",
  "",
  "[[bin]]",
  'name = "game"',
  'path = "src/main.rs"',
  "",
  "[dependencies]",
  `genex = { path = ${JSON.stringify(FACADE)} }`,
  "",
  "[profile.dev]",
  "debug = false",
  "",
  "[workspace]",
  "",
].join("\n");

/** The executable cargo reported for the `game` bin. */
function executableOf(stdout: string): string {
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line) as { reason?: string; target?: { name?: string }; executable?: string | null };
    if (message.reason === "compiler-artifact" && message.target?.name === "game" && message.executable)
      return message.executable;
  }
  throw new Error(`cargo reported no executable for the game:\n${stdout.slice(-2000)}`);
}

/** The template cross-compiled offline for the Simulator through the env helper; its executable's bytes. */
async function simulatorBuild(): Promise<Buffer> {
  const crate = await tmpDir("studio-ios-package-crate-");
  await cp(path.join(TEMPLATE, "src"), path.join(crate, "src"), { recursive: true });
  await writeFile(path.join(crate, "Cargo.toml"), HOST_MANIFEST);
  await writeFile(path.join(crate, "Cargo.lock"), readFileSync(WORKSPACE_LOCK));
  const args = ["rustc", "--offline", "--bin", "game", "--target", TRIPLE, "--message-format=json"];
  const { stdout } = await execFileAsync(process.execPath, [RUST_ENV, "--", "cargo", ...args], {
    cwd: REPO,
    env: { ...process.env, IPHONEOS_DEPLOYMENT_TARGET: IOS_DEPLOYMENT_TARGET, GENEX_RUST_WORKSPACE: crate },
    timeout: CROSS_BUILD_MS,
    maxBuffer: OUTPUT_BYTES,
  });
  return readFile(executableOf(stdout));
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("a real Simulator app from the Rust template", () => {
  it(
    "is packaged, signed ad hoc in codesign's sandbox, and passes codesign, plutil and admission",
    needs(),
    async () => {
      const xcode = await probeXcodeSdks({ exec: execHost, platform: process.platform });
      if (xcode.simulatorSdk === null) {
        if (REQUIRED) assert.fail("GENEX_REQUIRE_TOOLCHAINS=1: Xcode with a Simulator SDK absent");
        return;
      }
      const exe = await simulatorBuild();
      const root = await realpath(await tmpDir("studio-ios-package-real-"));
      const out = path.join(root, "build", "ios-sim.out");
      await mkdir(path.join(out, "assets"), { recursive: true });
      await writeFile(path.join(out, "game"), exe, { mode: 0o755 });
      const level = Buffer.from("pond level\n");
      await writeFile(path.join(out, "assets", "level.txt"), level);
      const game = path.join(root, "games", "pond");
      const exports = path.join(root, "exports");
      const stagingRoot = path.join(root, "export-staging");
      for (const dir of [game, exports, stagingRoot]) await mkdir(dir, { recursive: true, mode: 0o700 });
      const sandbox = await ProcessSandbox.create(
        mobileSignSandboxOptions({
          staging: stagingRoot,
          scratch: path.join(root, "scratch"),
          secretPaths: [path.join(root, "secrets")],
          denyWrite: [path.join(root, "games")],
        }),
      );
      try {
        const made = await packageIosApp({
          artifact: MobileArtifact.SimulatorApp,
          out,
          outputs: [
            { path: "assets/level.txt", sha256: sha256(level) },
            { path: "game", sha256: sha256(exe) },
          ],
          notices: [],
          bundleId: BUNDLE_ID,
          title: "Pond & Co",
          fallbackName: "pond",
          orientations: [IosOrientation.LandscapeLeft, IosOrientation.LandscapeRight],
          signing: { kind: ExportSigning.AdHoc },
          requestedBy: SigningRequester.Harness,
          xcode,
          source: game,
          target: path.join(exports, "pond.ios"),
          exportsRoot: exports,
          stagingRoot,
          secretValues: [],
          signer: { sandbox, forbiddenRoots: [game], home: root },
        });
        const app = made.artifact;
        await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", app]);
        for (const plist of ["Info.plist", "PrivacyInfo.xcprivacy"]) {
          await execFileAsync("/usr/bin/plutil", ["-lint", "-s", path.join(app, plist)]);
        }
        const { stdout: info } = await execFileAsync("/usr/bin/plutil", [
          "-convert",
          "json",
          "-o",
          "-",
          path.join(app, "Info.plist"),
        ]);
        const parsed = JSON.parse(info) as Record<string, unknown>;
        assert.equal(parsed.MinimumOSVersion, "16.0");
        assert.equal(parsed.CFBundleIdentifier, BUNDLE_ID);
        assert.equal(parsed.CFBundleDisplayName, "Pond & Co");
        assert.equal(parsed.CFBundleExecutable, "game");
        assert.deepEqual(parsed.CFBundleSupportedPlatforms, ["iPhoneSimulator"]);
        const signed = await readFile(path.join(app, "game"));
        const admission = admitRustMachO(signed, BuildTarget.Ios);
        assert.ok(admission.ok, !admission.ok ? admission.detail : "");
        assert.equal(admission.version.platform, ApplePlatformCode.IosSimulator);
        assert.equal(admission.version.minos, IOS_DEPLOYMENT_TARGET);
        assert.deepEqual(await readFile(path.join(app, "assets", "level.txt")), level);
        const { stdout: symbols } = await execFileAsync("/usr/bin/nm", ["-u", path.join(app, "game")], {
          maxBuffer: OUTPUT_BYTES,
        });
        const imported = new Set(symbols.split("\n").map((line) => line.trim()));
        const declared: readonly string[] = Object.keys(IOS_PRIVACY_CATEGORIES);
        for (const [category, names] of Object.entries(REQUIRED_REASON_SYMBOLS)) {
          const uses = names.filter((name) => imported.has(name));
          if (uses.length > 0) assert.ok(declared.includes(category), `${category} undeclared: ${uses.join(", ")}`);
        }
        assert.equal(made.receipt.xcode.version, xcode.version);
        assert.equal(made.receipt.xcode.sdk, `iphonesimulator${xcode.simulatorSdk}`);
      } finally {
        await sandbox.dispose();
      }
    },
  );
});

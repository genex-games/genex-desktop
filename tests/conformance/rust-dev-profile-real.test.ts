/**
 * The Live profile for real (lane MK): a game crate and one path dependency outside its workspace,
 * built and run through the cargo env helper with exactly the settings every Live and judging build
 * and every store prewarm pass (`RUST_DEV_PROFILE_SETTINGS`, written as the manifest's dotted keys,
 * which is what `--config` sets). The engine and every other dependency run without debug
 * assertions or overflow checks, as an export does: in the dependencies they cost Ashen Horde's
 * Live builds half the frame (objc2's per-message signature checks under every Metal call, wgpu,
 * Rapier and the mixer). The game crate keeps both, so an agent's own arithmetic still traps.
 *
 * Needs the spike toolchain; `GENEX_REQUIRE_TOOLCHAINS=1` turns its absence into a failure.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { RUST_DEV_PROFILE_SETTINGS } from "../../src/substrate/toolchain-store/rust-locate.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
/** Two crates with no registry dependency: seconds, cold. */
const BUILD_TIMEOUT_MS = 5 * MINUTE_MS;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** What one crate reports about how it was compiled. */
interface Checks {
  debugAssertions: boolean;
  overflowChecks: boolean;
}

/** A crate's own answer: `cfg!(debug_assertions)`, and whether `u8::MAX + 1` traps in its code. */
const CHECKS_SOURCE = `
pub fn debug_assertions() -> bool {
    cfg!(debug_assertions)
}

pub fn overflow_checks() -> bool {
    std::panic::catch_unwind(|| std::hint::black_box(u8::MAX) + std::hint::black_box(1u8)).is_err()
}
`;

const DEP_MANIFEST = '[package]\nname = "probe-dep"\nversion = "0.0.0"\nedition = "2024"\npublish = false\n';

const GAME_MAIN = `
mod own {
${CHECKS_SOURCE}
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let report = |debug: bool, overflow: bool| format!("{{\\"debugAssertions\\":{debug},\\"overflowChecks\\":{overflow}}}");
    let dep = report(probe_dep::debug_assertions(), probe_dep::overflow_checks());
    let game = report(own::debug_assertions(), own::overflow_checks());
    println!("{{\\"dependency\\":{dep},\\"game\\":{game}}}");
}
`;

/** The game's manifest: the profile settings as root dotted keys (before any table), then the package. */
function gameManifest(depDir: string): string {
  return [
    ...RUST_DEV_PROFILE_SETTINGS,
    "",
    "[package]",
    'name = "probe-game"',
    'version = "0.0.0"',
    'edition = "2024"',
    "publish = false",
    "",
    "[dependencies]",
    `probe-dep = { path = ${JSON.stringify(depDir)} }`,
    "",
    "[workspace]",
    "",
  ].join("\n");
}

function needsToolchain(): { skip?: string } {
  if (existsSync(path.join(TOOLCHAIN_DIR, "sysroot", "bin", "cargo"))) return {};
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: the Rust toolchain (${TOOLCHAIN_DIR}) is absent`);
  return { skip: `not run: the Rust toolchain (${TOOLCHAIN_DIR}) is absent` };
}

describe("the Live cargo profile, built for real", { ...needsToolchain(), timeout: BUILD_TIMEOUT_MS }, () => {
  it("runs the dependencies without debug assertions or overflow checks and keeps both in the game crate", async () => {
    const scratch = await realpath(await tmpDir("rust-dev-profile-"));
    // The dependency sits outside the game's folder: a path dependency inside it would be a workspace member.
    const depDir = path.join(scratch, "dep");
    const gameDir = path.join(scratch, "game");
    await mkdir(path.join(depDir, "src"), { recursive: true });
    await mkdir(path.join(gameDir, "src"), { recursive: true });
    await writeFile(path.join(depDir, "Cargo.toml"), DEP_MANIFEST);
    await writeFile(path.join(depDir, "src", "lib.rs"), CHECKS_SOURCE);
    await writeFile(path.join(gameDir, "Cargo.toml"), gameManifest(depDir));
    await writeFile(path.join(gameDir, "src", "main.rs"), GAME_MAIN);
    const { stdout } = await execFileAsync(process.execPath, [RUST_ENV, "--", "cargo", "run", "--offline", "--quiet"], {
      env: { ...process.env, CARGO_TARGET_DIR: path.join(scratch, "target"), GENEX_RUST_WORKSPACE: gameDir },
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    const line = stdout.split("\n").find((text) => text.startsWith("{"));
    assert.ok(line, `the probe printed no report: ${stdout}`);
    const report = JSON.parse(line) as { dependency: Checks; game: Checks };
    assert.deepEqual(
      report.dependency,
      { debugAssertions: false, overflowChecks: false },
      "the engine's dependencies run as an export's",
    );
    assert.deepEqual(report.game, { debugAssertions: true, overflowChecks: true }, "the game's own code still traps");
  });
});

/**
 * The cargo env helper `scripts/toolchains/rust-env.ts` (M1.12, promoted from the spike's
 * `rust-env.sh`): every cargo command over the `genex` workspace runs with the pinned Rust sysroot
 * (the spike folder until the store's Rust payload lands), its vendored `CARGO_HOME` and
 * `--manifest-path native/genex-rust/Cargo.toml` right after the subcommand; never `~/.cargo`,
 * rustup, a caller's own manifest, `--config`, `-Z` or a cargo config file.
 *
 * The fixture rows drive the helper against a fake toolchain folder whose `cargo` prints what it
 * was given, so they run on any POSIX host. A refusal is one typed line on stderr
 * (`genex-rust-env-refusal: {"code":…}`) with exit 78, starts no tool and writes nothing. The real
 * row needs the installed spike toolchain: it skips without it, and
 * `GENEX_REQUIRE_SPIKE_TOOLCHAIN=1` turns that skip into a failure.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { tmpDir } from "../helpers/tmp.ts";
import { cleanWhileBuilding } from "../../scripts/toolchains/rust-env.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const REAL_TOOLCHAIN = path.join(REPO, ".studio-dev", "spike-toolchain");
const REAL_WORKSPACE_MANIFEST = path.join(REPO, "native", "genex-rust", "Cargo.toml");
const REFUSAL_EXIT = 78;
const REFUSAL_PREFIX = "genex-rust-env-refusal: ";
const RUST_VERSION = "1.99.0";
const HOST_ARCH = process.arch === "arm64" ? "aarch64" : "x86_64";
/** The host's triple as rust-env.ts spells its sysroot archives (a Mac or Linux runner). */
const HOST_TRIPLE = process.platform === "darwin" ? `${HOST_ARCH}-apple-darwin` : `${HOST_ARCH}-unknown-linux-gnu`;
/** Another host's triple: its archives are approved but are not this host's sysroot. */
const OTHER_HOST_TRIPLE = process.platform === "darwin" ? "x86_64-unknown-linux-gnu" : "aarch64-apple-darwin";
const RUN_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const POSIX_ONLY = process.platform === "win32" ? { skip: "the fixture tools are bash scripts" } : {};

/** The refusal codes the helper prints. */
const Refusal = {
  Usage: "usage",
  PinsMissing: "pins-missing",
  ToolchainMissing: "toolchain-missing",
  ToolMissing: "tool-missing",
  ToolOutsideToolchain: "tool-outside-toolchain",
  VendorMissing: "vendor-missing",
  ArchiveNotApproved: "archive-not-approved",
  ArchiveSha256Mismatch: "archive-sha256-mismatch",
  RustupToolchain: "rustup-toolchain",
  ManifestOverride: "manifest-override",
  ConfigOverride: "config-override",
  CargoConfigFound: "cargo-config-found",
  TargetInUse: "target-in-use",
} as const;
type Refusal = (typeof Refusal)[keyof typeof Refusal];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

interface RefusalLine {
  code: string;
  detail: string;
  archives?: string[];
}

/** A failed child's exit code, or 1 when it was killed or never started. */
const exitCodeOf = (error: { code?: unknown }) => (typeof error.code === "number" ? error.code : 1);

function execRun(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<Run> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      resolve({ code: error ? exitCodeOf(error) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const runEnv = (args: string[], env: NodeJS.ProcessEnv, cwd = REPO) =>
  execRun(process.execPath, [RUST_ENV, ...args], env, cwd);

function refusalOf(result: Run): RefusalLine | null {
  const line = result.stderr.split("\n").find((l) => l.startsWith(REFUSAL_PREFIX));
  return line ? (JSON.parse(line.slice(REFUSAL_PREFIX.length)) as RefusalLine) : null;
}

function assertRefused(result: Run, code: Refusal): RefusalLine {
  assert.equal(result.code, REFUSAL_EXIT, `exit ${result.code}; stderr: ${result.stderr}`);
  const refusal = refusalOf(result);
  assert.ok(refusal, result.stderr);
  assert.equal(refusal.code, code, result.stderr);
  return refusal;
}

/** Every entry under `dir` with its size and mtime, to prove a run wrote nothing there. */
function snapshot(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const full = path.join(at, name);
      const st = statSync(full, { throwIfNoEntry: false });
      if (!st) continue;
      out.push(`${path.relative(dir, full)} ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** A fake rust tool: `--version` answers the pinned version, anything else prints its argv and env as JSON. */
const FAKE_TOOL = (name: string) => `#!/bin/bash
if [ "$1" = "--version" ] || [ "$1" = "-V" ]; then echo "${name} ${RUST_VERSION} (fake)"; exit 0; fi
node -e 'const e = process.env; process.stdout.write(JSON.stringify({tool: process.argv[1], argv: process.argv.slice(2), env: {CARGO_HOME: e.CARGO_HOME, CARGO: e.CARGO, PATH: e.PATH, RUSTC: e.RUSTC, RUSTUP_TOOLCHAIN: e.RUSTUP_TOOLCHAIN ?? null, RUSTUP_HOME: e.RUSTUP_HOME ?? null, RUSTC_WRAPPER: e.RUSTC_WRAPPER ?? null, CARGO_BUILD_RUSTC_WRAPPER: e.CARGO_BUILD_RUSTC_WRAPPER ?? null, CARGO_TARGET_DIR: e.CARGO_TARGET_DIR, CARGO_NET_OFFLINE: e.CARGO_NET_OFFLINE, GENEX_NO_WINDOW: e.GENEX_NO_WINDOW ?? null, GENEX_COLYSEUS_LIB_DIR: e.GENEX_COLYSEUS_LIB_DIR ?? null, GENEX_COLYSEUS_ARCHIVE: e.GENEX_COLYSEUS_ARCHIVE ?? null}, configKeys: Object.keys(e).filter((k) => /^(CARGO_|RUST)/.test(k)).sort()}))' "${name}" "$@"
exit "\${FAKE_TOOL_EXIT:-0}"
`;

/** A tool in ~/.cargo/bin or a rustup dir: it only records that it ran. */
const MARKER_TOOL = (marker: string) => `#!/bin/bash
echo consulted >> '${marker}'
exit 0
`;

async function writeTool(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  await chmod(file, 0o755);
}

interface PinRow {
  group: string;
  file: string;
  sha256: string;
}

/** The archives a host sysroot is installed from, as the pins name them. */
const SYSROOT_ARCHIVES = [
  `rustc-${RUST_VERSION}-${HOST_TRIPLE}.tar.xz`,
  `cargo-${RUST_VERSION}-${HOST_TRIPLE}.tar.xz`,
  `rust-std-${RUST_VERSION}-${HOST_TRIPLE}.tar.xz`,
] as const;

const fixtureRows = (): PinRow[] => [
  ...SYSROOT_ARCHIVES.map((file, i) => ({ group: "rust", file, sha256: String(i).repeat(64) })),
  // Another host's archive, another target's standard library and a tool: approved, but not what
  // this host's sysroot is installed from.
  { group: "rust", file: `rustc-${RUST_VERSION}-${OTHER_HOST_TRIPLE}.tar.xz`, sha256: "6".repeat(64) },
  { group: "rust", file: `rust-std-${RUST_VERSION}-wasm32-unknown-unknown.tar.xz`, sha256: "7".repeat(64) },
  { group: "wasm", file: "wasm-bindgen-0.2.129-aarch64-apple-darwin.tar.gz", sha256: "8".repeat(64) },
];

function pinsTable(rows: PinRow[]): string {
  return [
    "# pins (fixture)",
    "",
    "<!-- genex-spike-pins:begin -->",
    "| group | file | url | sha256 | checksum source |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.group} | ${r.file} | file:///nowhere/${r.file} | ${r.sha256} | fixture |`),
    "<!-- genex-spike-pins:end -->",
    "",
  ].join("\n");
}

interface FakeToolchain {
  root: string;
  toolchain: string;
  pins: string;
  workspace: string;
  home: string;
  marker: string;
  rustupDir: string;
  env: NodeJS.ProcessEnv;
}

/** A home whose ~/.cargo/bin and a rustup folder both answer to cargo, rustc and rustup and record being run. */
async function hostileHome(root: string, marker: string): Promise<{ home: string; rustupDir: string }> {
  const home = path.join(root, "home");
  const rustupDir = path.join(root, "rustup-bin");
  for (const tool of ["cargo", "rustc", "rustup"]) {
    await writeTool(path.join(home, ".cargo", "bin", tool), MARKER_TOOL(marker));
    await writeTool(path.join(rustupDir, tool), MARKER_TOOL(marker));
  }
  await mkdir(path.join(home, ".rustup", "toolchains"), { recursive: true });
  await writeFile(path.join(home, ".cargo", "config.toml"), "[build]\nrustc-wrapper = 'should-not-be-read'\n");
  return { home, rustupDir };
}

/** A toolchain folder as setup-toolchain.sh leaves it, with fake tools. */
async function writeToolchain(toolchain: string): Promise<void> {
  const bin = path.join(toolchain, "sysroot", "bin");
  for (const tool of ["cargo", "rustc", "rustdoc", "cargo-clippy", "clippy-driver"]) {
    await writeTool(path.join(bin, tool), FAKE_TOOL(tool));
  }
  await mkdir(path.join(toolchain, "sysroot", "lib", "rustlib", HOST_TRIPLE, "lib"), { recursive: true });
  await mkdir(path.join(toolchain, "cargo-home"), { recursive: true });
  await writeFile(path.join(toolchain, "cargo-home", "config.toml"), "[net]\noffline = true\n");
  await mkdir(path.join(toolchain, "vendor", "bytemuck-1.25.2"), { recursive: true });
  await writeFile(path.join(toolchain, "vendor", "bytemuck-1.25.2", ".cargo-checksum.json"), '{"files":{}}');
  const installed = fixtureRows().slice(0, SYSROOT_ARCHIVES.length);
  await writeFile(
    path.join(toolchain, "receipt.tsv"),
    installed.map((r) => `${r.group}\t${r.file}\t${r.sha256}\tfile:///nowhere/${r.file}\n`).join(""),
  );
}

/** A fake toolchain, its pins, a workspace and a hostile home, with the env that points the helper at them. */
async function fakeToolchain(folderName = "toolchain"): Promise<FakeToolchain> {
  const root = await tmpDir("rust-env-");
  const toolchain = path.join(root, folderName);
  await writeToolchain(toolchain);
  const pins = path.join(root, "pins.md");
  await writeFile(pins, pinsTable(fixtureRows()));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const marker = path.join(root, "consulted.log");
  const { home, rustupDir } = await hostileHome(root, marker);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: [
      path.join(home, ".cargo", "bin"),
      rustupDir,
      path.dirname(process.execPath),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
    RUSTUP_TOOLCHAIN: "stable",
    RUSTUP_HOME: path.join(home, ".rustup"),
    RUSTC_WRAPPER: path.join(home, ".cargo", "bin", "rustc"),
    CARGO_HOME: path.join(home, ".cargo"),
    GENEX_RUST_TOOLCHAIN_DIR: toolchain,
    GENEX_RUST_PINS: pins,
    GENEX_RUST_WORKSPACE: workspace,
    CARGO_TARGET_DIR: path.join(root, "target"),
  };
  return { root, toolchain, pins, workspace, home, marker, rustupDir, env };
}

interface FakeCargoOutput {
  tool: string;
  argv: string[];
  env: {
    CARGO_HOME: string;
    CARGO: string;
    PATH: string;
    RUSTC: string;
    RUSTUP_TOOLCHAIN: string | null;
    RUSTUP_HOME: string | null;
    RUSTC_WRAPPER: string | null;
    CARGO_BUILD_RUSTC_WRAPPER: string | null;
    CARGO_TARGET_DIR: string;
    CARGO_NET_OFFLINE: string;
    GENEX_NO_WINDOW: string | null;
    GENEX_COLYSEUS_LIB_DIR: string | null;
    GENEX_COLYSEUS_ARCHIVE: string | null;
  };
  /** Every `CARGO_*` and `RUST*` variable the tool saw, sorted. */
  configKeys: string[];
}

/** The approved archives a host sysroot needs: what a missing-sysroot refusal must name. */
function assertNamesSysrootArchives(refusal: RefusalLine): void {
  assert.deepEqual(refusal.archives, [...SYSROOT_ARCHIVES], JSON.stringify(refusal));
  for (const archive of SYSROOT_ARCHIVES) assert.ok(refusal.detail.includes(archive), refusal.detail);
}

/** Each row is a cargo command line; the helper must put `--manifest-path` right after its subcommand. */
const MANIFEST_ROWS: Array<{ name: string; args: string[]; expected: (manifest: string) => string[] }> = [
  {
    name: "cargo test --workspace",
    args: ["test", "--workspace", "--offline", "--locked"],
    expected: (m) => ["test", "--manifest-path", m, "--workspace", "--offline", "--locked"],
  },
  {
    name: "cargo clippy with lint flags after --",
    args: ["clippy", "--workspace", "--", "-D", "warnings"],
    expected: (m) => ["clippy", "--manifest-path", m, "--workspace", "--", "-D", "warnings"],
  },
  {
    name: "cargo build -p genex",
    args: ["build", "-p", "genex"],
    expected: (m) => ["build", "--manifest-path", m, "-p", "genex"],
  },
  {
    name: "a global option and its value before the subcommand",
    args: ["--color", "never", "check"],
    expected: (m) => ["--color", "never", "check", "--manifest-path", m],
  },
  { name: "cargo tree", args: ["tree"], expected: (m) => ["tree", "--manifest-path", m] },
  {
    name: "cargo metadata",
    args: ["metadata", "--format-version", "1"],
    expected: (m) => ["metadata", "--manifest-path", m, "--format-version", "1"],
  },
  { name: "the short alias t", args: ["t"], expected: (m) => ["t", "--manifest-path", m] },
  {
    name: "cargo run with program arguments after --",
    args: ["run", "-p", "pond", "--", "--self-test", "--config", "x"],
    expected: (m) => ["run", "--manifest-path", m, "-p", "pond", "--", "--self-test", "--config", "x"],
  },
  {
    name: "cargo vet with no command of its own",
    args: ["vet", "--locked"],
    expected: (m) => ["vet", "--manifest-path", m, "--locked"],
  },
  {
    name: "cargo vet init: after vet's own command",
    args: ["vet", "init"],
    expected: (m) => ["vet", "init", "--manifest-path", m],
  },
  {
    name: "cargo vet certify: after vet's own command, before its arguments",
    args: ["vet", "certify", "glam", "0.33.12"],
    expected: (m) => ["vet", "certify", "--manifest-path", m, "glam", "0.33.12"],
  },
];

/** Each row breaks the toolchain folder or the command one way; the run must refuse typed and start nothing. */
const HOSTILE: Array<{
  name: string;
  code: Refusal;
  args?: string[];
  arrange?: (f: FakeToolchain) => Promise<void>;
}> = [
  {
    name: "an installed archive's sha256 differs from its pin",
    code: Refusal.ArchiveSha256Mismatch,
    arrange: (f) => {
      const rows = fixtureRows();
      rows[1] = { ...rows[1], sha256: "f".repeat(64) };
      return writeFile(f.pins, pinsTable(rows));
    },
  },
  {
    name: "an installed archive has no pin",
    code: Refusal.ArchiveNotApproved,
    arrange: (f) => writeFile(f.pins, pinsTable(fixtureRows().slice(0, 2))),
  },
  { name: "the pins file is missing", code: Refusal.PinsMissing, arrange: (f) => rm(f.pins) },
  {
    name: "cargo is missing from the sysroot",
    code: Refusal.ToolMissing,
    arrange: (f) => rm(path.join(f.toolchain, "sysroot", "bin", "cargo")),
  },
  {
    name: "clippy-driver is missing from the sysroot",
    code: Refusal.ToolMissing,
    arrange: (f) => rm(path.join(f.toolchain, "sysroot", "bin", "clippy-driver")),
  },
  {
    name: "the sysroot cargo is a link to ~/.cargo/bin/cargo",
    code: Refusal.ToolOutsideToolchain,
    arrange: async (f) => {
      await rm(path.join(f.toolchain, "sysroot", "bin", "cargo"));
      await symlink(path.join(f.home, ".cargo", "bin", "cargo"), path.join(f.toolchain, "sysroot", "bin", "cargo"));
    },
  },
  {
    name: "the sysroot's bin folder is a link to ~/.cargo/bin",
    code: Refusal.ToolOutsideToolchain,
    arrange: async (f) => {
      await rm(path.join(f.toolchain, "sysroot", "bin"), { recursive: true });
      for (const tool of ["rustdoc", "cargo-clippy", "clippy-driver"]) {
        await writeTool(path.join(f.home, ".cargo", "bin", tool), MARKER_TOOL(f.marker));
      }
      await symlink(path.join(f.home, ".cargo", "bin"), path.join(f.toolchain, "sysroot", "bin"));
    },
  },
  {
    name: "the vendored CARGO_HOME config is missing",
    code: Refusal.VendorMissing,
    arrange: (f) => rm(path.join(f.toolchain, "cargo-home", "config.toml")),
  },
  {
    name: "the vendored tree is missing",
    code: Refusal.VendorMissing,
    arrange: (f) => rm(path.join(f.toolchain, "vendor"), { recursive: true }),
  },
  {
    name: "the target's rust-std is not installed",
    code: Refusal.ToolMissing,
    args: ["--", "cargo", "build", "--target", "wasm32-unknown-unknown"],
  },
  {
    name: "the target's rust-std is not installed (--target=)",
    code: Refusal.ToolMissing,
    args: ["--", "cargo", "build", "--target=aarch64-linux-android"],
  },
  {
    name: "a target names a path instead of a triple",
    code: Refusal.ToolMissing,
    args: ["--", "cargo", "build", "--target", `../${HOST_TRIPLE}`],
  },
  {
    name: "the tool is not in the toolchain folder",
    code: Refusal.ToolMissing,
    args: ["--", "wasm-bindgen", "--version"],
  },
  { name: "the tool is ~/.cargo/bin's rustup", code: Refusal.ToolMissing, args: ["--", "rustup", "show"] },
  { name: "the tool is named by a path", code: Refusal.ToolMissing, args: ["--", "/usr/bin/true"] },
  {
    name: "the command names a rustup toolchain",
    code: Refusal.RustupToolchain,
    args: ["--", "cargo", "+stable", "build"],
  },
  {
    name: "the caller passes its own --manifest-path",
    code: Refusal.ManifestOverride,
    args: ["--", "cargo", "build", "--manifest-path", "/elsewhere/Cargo.toml"],
  },
  {
    name: "the caller passes --manifest-path= before the subcommand",
    code: Refusal.ManifestOverride,
    args: ["--", "cargo", "--manifest-path=/elsewhere/Cargo.toml", "build"],
  },
  {
    name: "the caller re-enables the network with --config",
    code: Refusal.ConfigOverride,
    args: ["--", "cargo", "build", "--config", "net.offline=false"],
  },
  {
    name: "the caller sets a rustc wrapper with --config=",
    code: Refusal.ConfigOverride,
    args: ["--", "cargo", "build", "--config=build.rustc-wrapper='/tmp/wrapper'"],
  },
  {
    name: "a global --config comes before the subcommand",
    code: Refusal.ConfigOverride,
    args: ["--", "cargo", "--config", "source.crates-io.replace-with='x'", "build"],
  },
  {
    name: "the caller passes -Z",
    code: Refusal.ConfigOverride,
    args: ["--", "cargo", "-Z", "unstable-options", "build"],
  },
  { name: "the caller passes -Zflag", code: Refusal.ConfigOverride, args: ["--", "cargo", "build", "-Zbuild-std"] },
  {
    name: "the workspace carries a .cargo/config.toml",
    code: Refusal.CargoConfigFound,
    arrange: async (f) => {
      await mkdir(path.join(f.workspace, ".cargo"), { recursive: true });
      await writeFile(path.join(f.workspace, ".cargo", "config.toml"), "[build]\nrustc-wrapper = '/tmp/w'\n");
    },
  },
  {
    name: "a folder above the workspace carries a legacy .cargo/config",
    code: Refusal.CargoConfigFound,
    arrange: async (f) => {
      await mkdir(path.join(f.root, ".cargo"), { recursive: true });
      await writeFile(path.join(f.root, ".cargo", "config"), "[target.x]\nrunner = '/tmp/r'\n");
    },
  },
  { name: "no command is given", code: Refusal.Usage, args: ["--"] },
];

describe("rust-env.ts runs cargo with the pinned toolchain only", POSIX_ONLY, () => {
  it("runs the sysroot cargo with the vendored CARGO_HOME and never consults ~/.cargo or rustup", async () => {
    const f = await fakeToolchain();
    const homeBefore = snapshot(f.home);
    const result = await runEnv(["--", "cargo", "build", "-p", "genex", "--offline"], f.env);
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout) as FakeCargoOutput;
    assert.equal(out.tool, "cargo");
    const manifest = path.join(f.workspace, "Cargo.toml");
    assert.deepEqual(out.argv, ["build", "--manifest-path", manifest, "-p", "genex", "--offline"]);
    assert.equal(out.env.CARGO_HOME, path.join(f.toolchain, "cargo-home"));
    assert.equal(out.env.CARGO, path.join(f.toolchain, "sysroot", "bin", "cargo"));
    assert.equal(out.env.RUSTC, path.join(f.toolchain, "sysroot", "bin", "rustc"));
    assert.equal(out.env.RUSTUP_TOOLCHAIN, null);
    assert.equal(out.env.RUSTUP_HOME, null);
    assert.equal(out.env.RUSTC_WRAPPER, "", "an empty wrapper also overrides a config file's");
    assert.equal(out.env.CARGO_BUILD_RUSTC_WRAPPER, "");
    assert.equal(out.env.CARGO_TARGET_DIR, path.join(f.root, "target"));
    assert.equal(out.env.CARGO_NET_OFFLINE, "true");
    const pathDirs = out.env.PATH.split(":");
    assert.equal(pathDirs[0], path.join(f.toolchain, "sysroot", "bin"));
    assert.ok(!pathDirs.includes(path.join(f.home, ".cargo", "bin")), out.env.PATH);
    assert.ok(!pathDirs.includes(f.rustupDir), out.env.PATH);
    assert.equal(existsSync(f.marker), false, "~/.cargo or rustup was run");
    assert.deepEqual(snapshot(f.home), homeBefore, "the home folder was written");
  });

  for (const row of MANIFEST_ROWS) {
    it(`passes --manifest-path right after the subcommand: ${row.name}`, async () => {
      const f = await fakeToolchain();
      const result = await runEnv(["--", "cargo", ...row.args], f.env);
      assert.equal(result.code, 0, result.stderr);
      const out = JSON.parse(result.stdout) as FakeCargoOutput;
      assert.deepEqual(out.argv, row.expected(path.join(f.workspace, "Cargo.toml")));
    });
  }

  it("drops inherited compiler flags and cargo configuration, keeping only the target folder and terminal output", async () => {
    const f = await fakeToolchain();
    const hostile: NodeJS.ProcessEnv = {
      CARGO_SOURCE_CRATES_IO_REPLACE_WITH: "elsewhere",
      CARGO_SOURCE_ELSEWHERE_DIRECTORY: path.join(f.home, "evil-vendor"),
      CARGO_REGISTRIES_EVIL_INDEX: "https://example.invalid/index",
      CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER: "/bin/false",
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: "/bin/false",
      CARGO_BUILD_RUSTFLAGS: "-Clinker=/bin/false",
      CARGO_BUILD_TARGET_DIR: path.join(f.home, "elsewhere-target"),
      RUSTFLAGS: "-Clinker=/bin/false",
      CARGO_ENCODED_RUSTFLAGS: "-Clinker=/bin/false",
      RUSTDOCFLAGS: "-Clinker=/bin/false",
      CARGO_ENCODED_RUSTDOCFLAGS: "-Clinker=/bin/false",
      RUSTC_BOOTSTRAP: "1",
      CARGO_TERM_COLOR: "never",
    };
    const result = await runEnv(["--", "cargo", "build", "--offline"], { ...f.env, ...hostile });
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout) as FakeCargoOutput;
    for (const name of Object.keys(hostile).filter((key) => key !== "CARGO_TERM_COLOR")) {
      assert.ok(!out.configKeys.includes(name), `${name} reached cargo`);
    }
    assert.ok(out.configKeys.includes("CARGO_TERM_COLOR"), "terminal output is the caller's");
    assert.equal(out.env.CARGO_TARGET_DIR, path.join(f.root, "target"), "the target folder is the caller's");
    assert.equal(out.env.CARGO_HOME, path.join(f.toolchain, "cargo-home"));
  });

  it("builds the genex workspace by default, also without the leading --", async () => {
    const f = await fakeToolchain();
    const { GENEX_RUST_WORKSPACE: _workspace, ...env } = f.env;
    const result = await runEnv(["cargo", "check"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual((JSON.parse(result.stdout) as FakeCargoOutput).argv, [
      "check",
      "--manifest-path",
      REAL_WORKSPACE_MANIFEST,
    ]);
  });

  it("leaves cargo --version alone and passes the tool's exit code through", async () => {
    const f = await fakeToolchain();
    const version = await runEnv(["--", "cargo", "--version"], f.env);
    assert.equal(version.code, 0, version.stderr);
    assert.equal(version.stdout.trim(), `cargo ${RUST_VERSION} (fake)`);
    const failed = await runEnv(["--", "cargo", "test"], { ...f.env, FAKE_TOOL_EXIT: "3" });
    assert.equal(failed.code, 3, failed.stderr);
    assert.equal(refusalOf(failed), null);
  });

  it("runs a tool the toolchain folder installed", async () => {
    const f = await fakeToolchain();
    await writeTool(path.join(f.toolchain, "tools", "bin", "wasm-bindgen"), FAKE_TOOL("wasm-bindgen"));
    const result = await runEnv(["--", "wasm-bindgen", "--out-dir", "x"], f.env);
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout) as FakeCargoOutput;
    assert.equal(out.tool, "wasm-bindgen");
    assert.deepEqual(out.argv, ["--out-dir", "x"]);
  });

  it("prints an environment a POSIX shell evaluates back to the same values", async () => {
    const f = await fakeToolchain("tool chain 'quoted' $(touch pwned)");
    const printed = await runEnv(["--print-env"], f.env);
    assert.equal(printed.code, 0, printed.stderr);
    const script = 'eval "$1"; printf "%s\\n%s" "$CARGO_HOME" "$(printenv RUSTUP_TOOLCHAIN || echo unset)"';
    const echoed = await execRun("/bin/bash", ["-c", script, "bash", printed.stdout], f.env, f.root);
    assert.equal(echoed.code, 0, echoed.stderr);
    assert.deepEqual(echoed.stdout.split("\n"), [path.join(f.toolchain, "cargo-home"), "unset"]);
    assert.equal(existsSync(path.join(f.root, "pwned")), false, "the printed env ran a command substitution");
  });
});

/** `GENEX_NO_WINDOW` cargo sees: `1` for test and bench runs (no test may open a window), the caller's otherwise. */
const NO_WINDOW_ROWS: { name: string; args: string[]; caller?: string; expected: string | null }[] = [
  { name: "cargo test", args: ["test", "-p", "genex"], expected: "1" },
  { name: "cargo t", args: ["t"], expected: "1" },
  { name: "cargo bench", args: ["bench", "-p", "pond"], expected: "1" },
  { name: "a global option before test", args: ["--color", "never", "test"], expected: "1" },
  { name: "a stray marker value on test", args: ["test"], caller: "yes", expected: "1" },
  { name: "the explicit opt-out on test", args: ["test"], caller: "0", expected: "0" },
  { name: "cargo build", args: ["build", "-p", "genex"], expected: null },
  { name: "cargo run (a person's window)", args: ["run", "-p", "pond"], expected: null },
  { name: "the caller's marker on run", args: ["run"], caller: "1", expected: "1" },
];

describe("rust-env.ts marks test and bench runs windowless", POSIX_ONLY, () => {
  for (const row of NO_WINDOW_ROWS) {
    it(`sets GENEX_NO_WINDOW for ${row.name}`, async () => {
      const f = await fakeToolchain();
      const env = row.caller === undefined ? f.env : { ...f.env, GENEX_NO_WINDOW: row.caller };
      const result = await runEnv(["--", "cargo", ...row.args], env);
      assert.equal(result.code, 0, result.stderr);
      assert.equal((JSON.parse(result.stdout) as FakeCargoOutput).env.GENEX_NO_WINDOW, row.expected);
    });
  }
});

/**
 * The vendored relay client's build script (genex-multiplayer `build.rs`) downloads the Colyseus
 * xcframework on a Mac when `GENEX_COLYSEUS_LIB_DIR` is unset (MP-1a). The helper always names a
 * lib folder in the toolchain, so a workspace build never reaches the network: a folder nobody
 * filled makes the script stop with its "has no libcolyseus.a" message instead.
 */
const COLYSEUS_ROWS: {
  name: string;
  args: string[];
  caller?: NodeJS.ProcessEnv;
  expected: (toolchain: string) => string;
}[] = [
  {
    name: "a workspace test names the host triple's folder",
    args: ["test", "--workspace", "--offline"],
    expected: (toolchain) => path.join(toolchain, "tools", "colyseus", HOST_TRIPLE),
  },
  {
    name: "a check of the host triple named with --target= names its folder",
    args: ["check", `--target=${HOST_TRIPLE}`],
    expected: (toolchain) => path.join(toolchain, "tools", "colyseus", HOST_TRIPLE),
  },
  {
    name: "an empty caller value is replaced",
    args: ["build"],
    caller: { GENEX_COLYSEUS_LIB_DIR: "" },
    expected: (toolchain) => path.join(toolchain, "tools", "colyseus", HOST_TRIPLE),
  },
  {
    name: "a caller's own folder is kept (the owner's prepared lib folder)",
    args: ["build"],
    caller: { GENEX_COLYSEUS_LIB_DIR: "/opt/colyseus/lib" },
    expected: () => "/opt/colyseus/lib",
  },
];

describe("rust-env.ts always names a Colyseus lib folder, so no build script downloads one", POSIX_ONLY, () => {
  for (const row of COLYSEUS_ROWS) {
    it(row.name, async () => {
      const f = await fakeToolchain();
      const result = await runEnv(["--", "cargo", ...row.args], { ...f.env, ...row.caller });
      assert.equal(result.code, 0, result.stderr);
      const out = JSON.parse(result.stdout) as FakeCargoOutput;
      assert.equal(out.env.GENEX_COLYSEUS_LIB_DIR, row.expected(f.toolchain));
    });
  }

  it("names the folder of the triple a cross build targets", async () => {
    const f = await fakeToolchain();
    await mkdir(path.join(f.toolchain, "sysroot", "lib", "rustlib", "wasm32-unknown-unknown", "lib"), {
      recursive: true,
    });
    const result = await runEnv(["--", "cargo", "check", "--target", "wasm32-unknown-unknown", "--", "-x"], f.env);
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout) as FakeCargoOutput;
    assert.equal(out.env.GENEX_COLYSEUS_LIB_DIR, path.join(f.toolchain, "tools", "colyseus", "wasm32-unknown-unknown"));
  });

  it("drops a caller's archive path, which only the download fallback reads", async () => {
    const f = await fakeToolchain();
    const env = { ...f.env, GENEX_COLYSEUS_ARCHIVE: path.join(f.home, "Colyseus.xcframework.zip") };
    const result = await runEnv(["--", "cargo", "build"], env);
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout) as FakeCargoOutput;
    assert.equal(out.env.GENEX_COLYSEUS_ARCHIVE, null);
    assert.equal(out.env.GENEX_COLYSEUS_LIB_DIR, path.join(f.toolchain, "tools", "colyseus", HOST_TRIPLE));
  });

  it("prints the folder in --print-env, so a sourced shell builds the same way", async () => {
    const f = await fakeToolchain();
    const result = await runEnv(["--", "--print-env"], f.env);
    assert.equal(result.code, 0, result.stderr);
    const dir = path.join(f.toolchain, "tools", "colyseus", HOST_TRIPLE);
    assert.ok(result.stdout.includes(`export GENEX_COLYSEUS_LIB_DIR='${dir}'`), result.stdout);
  });
});

describe("rust-env.ts never cleans the shared target under a running build", () => {
  // Pass-1 gate round 3: a disk guard's `cargo clean` deleted the shared target four times while
  // other checkers' builds and test binaries ran from it, failing their runs.
  const target = "/work/.studio-dev/cargo-target";
  const rows: [string, readonly string[], readonly string[], boolean][] = [
    ["a cargo build elsewhere", ["clean"], ["101 /tc/sysroot/bin/cargo test --manifest-path x"], true],
    [
      "a rustc writing the target",
      ["clean", "-p", "genex"],
      [`102 /tc/bin/rustc --out-dir ${target}/debug/deps`],
      true,
    ],
    ["a test binary running from the target", ["clean"], [`103 ${target}/release/deps/shots-1a2b --ignored`], true],
    ["clippy's driver", ["clean"], ["104 /tc/bin/clippy-driver rustc -"], true],
    [
      "only this helper and unrelated programs",
      ["clean"],
      ["105 node rust-env.ts -- cargo clean", "106 /bin/zsh", "107 grep cargo"],
      false,
    ],
    ["not a clean", ["build"], ["108 /tc/bin/cargo test"], false],
    ["a clean's dry run", ["clean", "--dry-run"], ["109 /tc/bin/cargo test"], false],
    ["this helper's own process", ["clean"], [`${process.pid} /tc/bin/cargo clean`], false],
  ];
  for (const [name, args, processes, refused] of rows)
    it(`${refused ? "refuses" : "allows"} a clean: ${name}`, () => {
      const busy = cleanWhileBuilding(args, processes, target, process.pid);
      assert.equal(busy !== null, refused, busy ?? "allowed");
    });
});

describe("rust-env.ts refuses typed and runs nothing", POSIX_ONLY, () => {
  it("refuses typed and names the approved sysroot archives when no toolchain is installed", async () => {
    const f = await fakeToolchain();
    await rm(f.toolchain, { recursive: true });
    const result = await runEnv(["--", "cargo", "build"], f.env);
    assertNamesSysrootArchives(assertRefused(result, Refusal.ToolchainMissing));
    assert.equal(result.stdout, "");
    assert.equal(existsSync(f.toolchain), false, "the helper created the toolchain folder");
    assert.equal(existsSync(f.marker), false, "~/.cargo or rustup was run");
  });

  it("refuses typed and names the approved sysroot archives when setup never finished (no receipt)", async () => {
    const f = await fakeToolchain();
    await rm(path.join(f.toolchain, "receipt.tsv"));
    const before = snapshot(f.toolchain);
    const result = await runEnv(["--", "cargo", "build"], f.env);
    assertNamesSysrootArchives(assertRefused(result, Refusal.ToolchainMissing));
    assert.equal(result.stdout, "");
    assert.deepEqual(snapshot(f.toolchain), before);
  });

  for (const row of HOSTILE) {
    it(`refuses typed and runs nothing when ${row.name}`, async () => {
      const f = await fakeToolchain();
      await row.arrange?.(f);
      const toolchainBefore = snapshot(f.toolchain);
      const homeBefore = snapshot(f.home);
      const result = await runEnv(row.args ?? ["--", "cargo", "build"], f.env);
      assertRefused(result, row.code);
      assert.equal(result.stdout, "", "a tool ran");
      assert.equal(existsSync(f.marker), false, "~/.cargo or rustup was run");
      assert.deepEqual(snapshot(f.toolchain), toolchainBefore);
      assert.deepEqual(snapshot(f.home), homeBefore);
    });
  }
});

/** Rows over the real installed spike toolchain: skipped without it, failed under GENEX_REQUIRE_SPIKE_TOOLCHAIN=1. */
function needsSpikeToolchain(): { skip?: string } {
  if (process.platform === "win32") return { skip: "not run: the spike toolchain is POSIX only" };
  if (existsSync(path.join(REAL_TOOLCHAIN, "receipt.tsv"))) return {};
  if (process.env.GENEX_REQUIRE_SPIKE_TOOLCHAIN === "1") {
    throw new Error(`GENEX_REQUIRE_SPIKE_TOOLCHAIN=1: no spike toolchain at ${REAL_TOOLCHAIN}`);
  }
  return { skip: "not run: spike toolchain absent (bash scripts/spike/rust-wgpu/setup-toolchain.sh)" };
}

describe("rust-env.ts over the installed toolchain", () => {
  it(`answers cargo ${RUST_VERSION} and locates the genex workspace`, needsSpikeToolchain(), async () => {
    const version = await runEnv(["--", "cargo", "--version"], process.env);
    assert.equal(version.code, 0, version.stderr);
    assert.ok(version.stdout.startsWith(`cargo ${RUST_VERSION} `), version.stdout);
    const located = await runEnv(["--", "cargo", "locate-project", "--message-format", "plain"], process.env);
    assert.equal(located.code, 0, located.stderr);
    assert.equal(located.stdout.trim(), REAL_WORKSPACE_MANIFEST);
  });
});

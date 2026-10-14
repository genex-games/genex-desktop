/**
 * The M0a spike toolchain (`scripts/spike/rust-wgpu/`): `setup-toolchain.sh` installs only the
 * archives the committed `pins.md` pins (sha256 checked; official sources only: the named GitHub
 * repositories' releases, and file sources only under the test override) into an owned spike
 * folder, and `rust-env.sh` runs a cargo command with that folder's sysroot, its vendored
 * `CARGO_HOME` and `--manifest-path <workspace>/Cargo.toml`, never `~/.cargo` or rustup, never a
 * `--config`, `-Z` or cargo config file.
 *
 * The fixture rows drive both scripts against a fake spike folder whose `cargo` prints what it
 * was given, so they run on any POSIX host. Each refusal is a typed line on stderr
 * (`genex-spike-refusal: {"code":…}`) with exit 78, and a refused run starts no tool and writes
 * nothing. The real rows need the installed spike toolchain (`setup-toolchain.sh`): they skip
 * without it, and `GENEX_REQUIRE_SPIKE_TOOLCHAIN=1` turns that skip into a failure.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SPIKE_SCRIPTS = path.join(REPO, "scripts", "spike", "rust-wgpu");
const RUST_ENV = path.join(SPIKE_SCRIPTS, "rust-env.sh");
const SETUP = path.join(SPIKE_SCRIPTS, "setup-toolchain.sh");
const REAL_SPIKE = path.join(REPO, ".studio-dev", "spike-toolchain");
const REAL_APPROVALS = path.join(REPO, "scripts", "spike", "rust-wgpu", "pins.md");
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** Seatbelt profile that denies every network operation and allows everything else. */
const NO_NETWORK_PROFILE = "(version 1)(allow default)(deny network*)";
const REFUSAL_EXIT = 78;
const REFUSAL_PREFIX = "genex-spike-refusal: ";
const RUST_VERSION = "1.99.0";
const HOST_ARCH = process.arch === "arm64" ? "aarch64" : "x86_64";
/** The host's triple as setup-toolchain.sh names its sysroot archives (a Mac or the Linux runner). */
const HOST_TRIPLE = process.platform === "darwin" ? `${HOST_ARCH}-apple-darwin` : `${HOST_ARCH}-unknown-linux-gnu`;
const CARGO_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const POSIX_ONLY = process.platform === "win32" ? { skip: "the spike scripts are bash" } : {};

/** The refusal codes both scripts print. */
const Refusal = {
  ApprovalsMissing: "approvals-missing",
  ToolchainMissing: "toolchain-missing",
  ToolMissing: "tool-missing",
  ToolOutsideSpike: "tool-outside-spike",
  VendorMissing: "vendor-missing",
  ArchiveNotApproved: "archive-not-approved",
  ArchiveSha256Mismatch: "archive-sha256-mismatch",
  ArchiveSourceRefused: "archive-source-refused",
  RustupToolchain: "rustup-toolchain",
  ManifestOverride: "manifest-override",
  ConfigOverride: "config-override",
  CargoConfigFound: "cargo-config-found",
  VendorLockMissing: "vendor-lock-missing",
  VendorLockDisagreement: "vendor-lock-disagreement",
  CargoVendorFailed: "cargo-vendor-failed",
} as const;
type Refusal = (typeof Refusal)[keyof typeof Refusal];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** A failed child's exit code, or 1 when it was killed or never started. */
const exitCodeOf = (error: { code?: unknown }) => (typeof error.code === "number" ? error.code : 1);

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd = REPO): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { env, cwd, timeout: CARGO_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        const code = error ? exitCodeOf(error) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function refusalOf(result: Run): { code: string; detail: string } | null {
  const line = result.stderr.split("\n").find((l) => l.startsWith(REFUSAL_PREFIX));
  return line ? JSON.parse(line.slice(REFUSAL_PREFIX.length)) : null;
}

function assertRefused(result: Run, code: Refusal): void {
  assert.equal(result.code, REFUSAL_EXIT, `exit ${result.code}; stderr: ${result.stderr}`);
  assert.equal(refusalOf(result)?.code, code, result.stderr);
}

const sha256Of = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

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
exec node -e 'const e = process.env; process.stdout.write(JSON.stringify({tool: process.argv[1], argv: process.argv.slice(2), env: {CARGO_HOME: e.CARGO_HOME, PATH: e.PATH, RUSTC: e.RUSTC, RUSTUP_TOOLCHAIN: e.RUSTUP_TOOLCHAIN ?? null, RUSTC_WRAPPER: e.RUSTC_WRAPPER ?? null, CARGO_BUILD_RUSTC_WRAPPER: e.CARGO_BUILD_RUSTC_WRAPPER ?? null, CARGO_TARGET_DIR: e.CARGO_TARGET_DIR, GENEX_NO_WINDOW: e.GENEX_NO_WINDOW ?? null}}))' "${name}" "$@"
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

interface FakeSpike {
  root: string;
  spike: string;
  approvals: string;
  workspace: string;
  home: string;
  marker: string;
  rustupDir: string;
  env: NodeJS.ProcessEnv;
}

interface PinRow {
  file: string;
  url: string;
  sha256: string;
}

const ARCHIVES = [
  `rustc-${RUST_VERSION}-${HOST_TRIPLE}.tar.xz`,
  `cargo-${RUST_VERSION}-${HOST_TRIPLE}.tar.xz`,
  `rust-std-${RUST_VERSION}-${HOST_TRIPLE}.tar.xz`,
] as const;

const fixtureRows = (): PinRow[] =>
  ARCHIVES.map((file, i) => ({ file, url: `file:///nowhere/${file}`, sha256: String(i).repeat(64) }));

function pinsTable(rows: PinRow[]): string {
  return [
    "# approvals (fixture)",
    "",
    "<!-- genex-spike-pins:begin -->",
    "| group | file | url | sha256 | checksum source |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| rust | ${r.file} | ${r.url} | ${r.sha256} | fixture |`),
    "<!-- genex-spike-pins:end -->",
    "",
  ].join("\n");
}

/** A spike folder as setup-toolchain.sh leaves it, with fake tools, plus a home that has rustup and ~/.cargo. */
async function fakeSpike(): Promise<FakeSpike> {
  const root = await tmpDir("rust-spike-env-");
  const spike = path.join(root, "spike-toolchain");
  const bin = path.join(spike, "sysroot", "bin");
  for (const tool of ["cargo", "rustc", "rustdoc", "cargo-clippy", "clippy-driver"]) {
    await writeTool(path.join(bin, tool), FAKE_TOOL(tool));
  }
  await mkdir(path.join(spike, "sysroot", "lib", "rustlib", HOST_TRIPLE, "lib"), { recursive: true });
  await mkdir(path.join(spike, "cargo-home"), { recursive: true });
  await writeFile(path.join(spike, "cargo-home", "config.toml"), "[net]\noffline = true\n");
  await mkdir(path.join(spike, "vendor", "bytemuck-1.25.2"), { recursive: true });
  await writeFile(path.join(spike, "vendor", "bytemuck-1.25.2", ".cargo-checksum.json"), '{"files":{}}');
  const rows = fixtureRows();
  await writeFile(
    path.join(spike, "receipt.tsv"),
    rows.map((r) => `rust\t${r.file}\t${r.sha256}\t${r.url}\n`).join(""),
  );
  const approvals = path.join(root, "approvals.md");
  await writeFile(approvals, pinsTable(rows));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  // A home whose ~/.cargo/bin and a rustup dir both answer to cargo and rustc and record being run.
  const home = path.join(root, "home");
  const marker = path.join(root, "consulted.log");
  for (const tool of ["cargo", "rustc", "rustup"])
    await writeTool(path.join(home, ".cargo", "bin", tool), MARKER_TOOL(marker));
  await mkdir(path.join(home, ".rustup", "toolchains"), { recursive: true });
  await writeFile(path.join(home, ".cargo", "config.toml"), "[build]\nrustc-wrapper = 'should-not-be-read'\n");
  const rustupDir = path.join(root, "rustup-bin");
  for (const tool of ["cargo", "rustc", "rustup"]) await writeTool(path.join(rustupDir, tool), MARKER_TOOL(marker));
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
    GENEX_SPIKE_TOOLCHAIN_DIR: spike,
    GENEX_SPIKE_APPROVALS: approvals,
    GENEX_SPIKE_WORKSPACE: workspace,
    CARGO_TARGET_DIR: path.join(root, "target"),
  };
  return { root, spike, approvals, workspace, home, marker, rustupDir, env };
}

interface FakeCargoOutput {
  tool: string;
  argv: string[];
  env: {
    CARGO_HOME: string;
    PATH: string;
    RUSTC: string;
    RUSTUP_TOOLCHAIN: string | null;
    RUSTC_WRAPPER: string | null;
    CARGO_BUILD_RUSTC_WRAPPER: string | null;
    CARGO_TARGET_DIR: string;
    GENEX_NO_WINDOW: string | null;
  };
}

/** Each row breaks the spike folder or the command one way; the run must refuse typed and start nothing. */
const ENV_HOSTILE: Array<{ name: string; code: Refusal; args?: string[]; arrange?: (f: FakeSpike) => Promise<void> }> =
  [
    {
      name: "an installed archive's sha256 differs from its approval",
      code: Refusal.ArchiveSha256Mismatch,
      arrange: (f) => {
        const rows = fixtureRows();
        rows[1] = { ...rows[1], sha256: "f".repeat(64) };
        return writeFile(f.approvals, pinsTable(rows));
      },
    },
    {
      name: "an installed archive has no approval",
      code: Refusal.ArchiveNotApproved,
      arrange: (f) => writeFile(f.approvals, pinsTable(fixtureRows().slice(0, 2))),
    },
    { name: "approvals.md is missing", code: Refusal.ApprovalsMissing, arrange: (f) => rm(f.approvals) },
    {
      name: "setup never ran (no receipt)",
      code: Refusal.ToolchainMissing,
      arrange: (f) => rm(path.join(f.spike, "receipt.tsv")),
    },
    {
      name: "cargo is missing from the sysroot",
      code: Refusal.ToolMissing,
      arrange: (f) => rm(path.join(f.spike, "sysroot", "bin", "cargo")),
    },
    {
      name: "clippy-driver is missing from the sysroot",
      code: Refusal.ToolMissing,
      arrange: (f) => rm(path.join(f.spike, "sysroot", "bin", "clippy-driver")),
    },
    {
      name: "the sysroot cargo is a link to ~/.cargo/bin/cargo",
      code: Refusal.ToolOutsideSpike,
      arrange: async (f) => {
        await rm(path.join(f.spike, "sysroot", "bin", "cargo"));
        await symlink(path.join(f.home, ".cargo", "bin", "cargo"), path.join(f.spike, "sysroot", "bin", "cargo"));
      },
    },
    {
      name: "the vendored CARGO_HOME config is missing",
      code: Refusal.VendorMissing,
      arrange: (f) => rm(path.join(f.spike, "cargo-home", "config.toml")),
    },
    {
      name: "the vendored tree is missing",
      code: Refusal.VendorMissing,
      arrange: (f) => rm(path.join(f.spike, "vendor"), { recursive: true }),
    },
    {
      name: "the target's rust-std is not installed",
      code: Refusal.ToolMissing,
      args: ["cargo", "build", "--target", "wasm32-unknown-unknown"],
    },
    { name: "the tool is not in the spike folder", code: Refusal.ToolMissing, args: ["wasm-bindgen", "--version"] },
    {
      name: "the command names a rustup toolchain",
      code: Refusal.RustupToolchain,
      args: ["cargo", "+stable", "build"],
    },
    {
      name: "the caller passes its own --manifest-path",
      code: Refusal.ManifestOverride,
      args: ["cargo", "build", "--manifest-path", "/elsewhere/Cargo.toml"],
    },
    {
      name: "the caller re-enables the network with --config",
      code: Refusal.ConfigOverride,
      args: ["cargo", "build", "--config", "net.offline=false"],
    },
    {
      name: "the caller sets a rustc wrapper with --config=",
      code: Refusal.ConfigOverride,
      args: ["cargo", "build", "--config=build.rustc-wrapper='/tmp/wrapper'"],
    },
    {
      name: "a global --config comes before the subcommand",
      code: Refusal.ConfigOverride,
      args: ["cargo", "--config", "source.crates-io.replace-with='x'", "build"],
    },
    { name: "the caller passes -Z", code: Refusal.ConfigOverride, args: ["cargo", "-Z", "unstable-options", "build"] },
    { name: "the caller passes -Zflag", code: Refusal.ConfigOverride, args: ["cargo", "build", "-Zbuild-std"] },
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
  ];

describe("rust-env.sh runs cargo from the spike folder only", POSIX_ONLY, () => {
  it("passes --manifest-path to the workspace, the spike CARGO_HOME and sysroot, and never runs ~/.cargo or rustup", async () => {
    const f = await fakeSpike();
    const homeBefore = snapshot(f.home);
    const result = await run("bash", [RUST_ENV, "cargo", "build", "-p", "genex", "--offline"], f.env);
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout) as FakeCargoOutput;
    assert.equal(out.tool, "cargo");
    assert.deepEqual(out.argv, [
      "build",
      "--manifest-path",
      path.join(f.workspace, "Cargo.toml"),
      "-p",
      "genex",
      "--offline",
    ]);
    assert.equal(out.env.CARGO_HOME, path.join(f.spike, "cargo-home"));
    assert.equal(out.env.RUSTC, path.join(f.spike, "sysroot", "bin", "rustc"));
    assert.equal(out.env.RUSTUP_TOOLCHAIN, null);
    assert.equal(out.env.RUSTC_WRAPPER, "", "an empty wrapper also overrides a config file's");
    assert.equal(out.env.CARGO_BUILD_RUSTC_WRAPPER, "");
    assert.equal(out.env.CARGO_TARGET_DIR, path.join(f.root, "target"));
    const pathDirs = out.env.PATH.split(":");
    assert.equal(pathDirs[0], path.join(f.spike, "sysroot", "bin"));
    assert.ok(!pathDirs.includes(path.join(f.home, ".cargo", "bin")), out.env.PATH);
    assert.ok(!pathDirs.includes(f.rustupDir), out.env.PATH);
    assert.equal(existsSync(f.marker), false, "~/.cargo or rustup was run");
    assert.deepEqual(snapshot(f.home), homeBefore, "the home folder was written");
  });

  it("puts --manifest-path before the clippy `--` and leaves --version alone", async () => {
    const f = await fakeSpike();
    const clippy = await run("bash", [RUST_ENV, "cargo", "clippy", "-p", "genex", "--", "-D", "warnings"], f.env);
    assert.equal(clippy.code, 0, clippy.stderr);
    assert.deepEqual((JSON.parse(clippy.stdout) as FakeCargoOutput).argv, [
      "clippy",
      "--manifest-path",
      path.join(f.workspace, "Cargo.toml"),
      "-p",
      "genex",
      "--",
      "-D",
      "warnings",
    ]);
    const version = await run("bash", [RUST_ENV, "cargo", "--version"], f.env);
    assert.equal(version.code, 0, version.stderr);
    assert.equal(version.stdout.trim(), `cargo ${RUST_VERSION} (fake)`);
  });

  for (const row of ENV_HOSTILE) {
    it(`refuses typed and runs nothing when ${row.name}`, async () => {
      const f = await fakeSpike();
      await row.arrange?.(f);
      const spikeBefore = snapshot(f.spike);
      const homeBefore = snapshot(f.home);
      const result = await run("bash", [RUST_ENV, ...(row.args ?? ["cargo", "build"])], f.env);
      assertRefused(result, row.code);
      assert.equal(result.stdout, "", "a tool ran");
      assert.equal(existsSync(f.marker), false, "~/.cargo or rustup was run");
      assert.deepEqual(snapshot(f.spike), spikeBefore);
      assert.deepEqual(snapshot(f.home), homeBefore);
    });
  }
});

type RowsOf = (archive: string, sha: string) => PinRow[];

async function setupFixture(rows: RowsOf, allowFileSources = true) {
  const root = await tmpDir("rust-spike-setup-");
  const archive = path.join(root, "mirror", `rustc-${RUST_VERSION}-${HOST_TRIPLE}.tar.xz`);
  await mkdir(path.dirname(archive), { recursive: true });
  await writeFile(archive, "not the approved bytes");
  const approvals = path.join(root, "approvals.md");
  await writeFile(approvals, pinsTable(rows(archive, await sha256Of(archive))));
  const spike = path.join(root, "spike-toolchain");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: [path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    GENEX_SPIKE_TOOLCHAIN_DIR: spike,
    GENEX_SPIKE_APPROVALS: approvals,
    // The local mirror stands in for the official source only under the test override.
    ...(allowFileSources ? { GENEX_SPIKE_ALLOW_FILE_SOURCES: "1" } : {}),
  };
  return { root, spike, env, approvals, home };
}

const SETUP_HOSTILE: Array<{ name: string; code: Refusal; rows: RowsOf; allowFileSources?: boolean }> = [
  {
    name: "the downloaded archive's sha256 differs from its pin",
    code: Refusal.ArchiveSha256Mismatch,
    rows: (archive) => [{ file: path.basename(archive), url: `file://${archive}`, sha256: "a".repeat(64) }],
  },
  { name: "the archive has no pin", code: Refusal.ArchiveNotApproved, rows: () => [] },
  {
    name: "the pinned URL is not an official source",
    code: Refusal.ArchiveSourceRefused,
    rows: (archive, sha) => [
      { file: path.basename(archive), url: `http://mirror.example/${path.basename(archive)}`, sha256: sha },
    ],
  },
  {
    name: "the pinned URL is a GitHub release of a repository the archive table does not name",
    code: Refusal.ArchiveSourceRefused,
    rows: (archive, sha) => [
      {
        file: path.basename(archive),
        url: `https://github.com/someone/rust/releases/download/1.99.0/${path.basename(archive)}`,
        sha256: sha,
      },
    ],
  },
  {
    name: "the pinned URL is a local file without the test override",
    code: Refusal.ArchiveSourceRefused,
    rows: (archive, sha) => [{ file: path.basename(archive), url: `file://${archive}`, sha256: sha }],
    allowFileSources: false,
  },
];

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

describe("rust-env.sh marks test and bench runs windowless", POSIX_ONLY, () => {
  for (const row of NO_WINDOW_ROWS) {
    it(`sets GENEX_NO_WINDOW for ${row.name}`, async () => {
      const f = await fakeSpike();
      const env = row.caller === undefined ? f.env : { ...f.env, GENEX_NO_WINDOW: row.caller };
      const result = await run("bash", [RUST_ENV, "cargo", ...row.args], env);
      assert.equal(result.code, 0, result.stderr);
      assert.equal((JSON.parse(result.stdout) as FakeCargoOutput).env.GENEX_NO_WINDOW, row.expected);
    });
  }
});

describe("setup-toolchain.sh installs only approved, matching archives", POSIX_ONLY, () => {
  for (const row of SETUP_HOSTILE) {
    it(`refuses typed and installs nothing when ${row.name}`, async () => {
      const f = await setupFixture(row.rows, row.allowFileSources ?? true);
      const homeBefore = snapshot(f.home);
      const result = await run("bash", [SETUP, "--no-vendor"], f.env);
      assertRefused(result, row.code);
      const left = existsSync(f.spike) ? await readdir(f.spike, { recursive: true }) : [];
      assert.deepEqual(
        left.filter((name) => name !== "downloads"),
        [],
        `left behind: ${left.join(", ")}`,
      );
      assert.deepEqual(snapshot(f.home), homeBefore);
    });
  }

  it("refuses typed when approvals.md is missing", async () => {
    const f = await setupFixture(() => []);
    await rm(f.approvals);
    assertRefused(await run("bash", [SETUP, "--verify"], f.env), Refusal.ApprovalsMissing);
  });
});

// ---- vendoring from the committed lock -------------------------------------------------------

/** One crates.io package of a lock: what cargo vendors as `<name>-<version>/`. */
interface LockedCrate {
  name: string;
  version: string;
  checksum: string;
}

const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";
const BYTEMUCK: LockedCrate = { name: "bytemuck", version: "1.25.2", checksum: "b".repeat(64) };
/** The version the committed locks pin (a CI run vendored 0.8.60, crates.io's latest then). */
const ZEROCOPY_LOCKED: LockedCrate = { name: "zerocopy", version: "0.8.59", checksum: "5".repeat(64) };
const ZEROCOPY_LATEST: LockedCrate = { name: "zerocopy", version: "0.8.60", checksum: "6".repeat(64) };
const NOISE: LockedCrate = { name: "noise", version: "0.9.0", checksum: "9".repeat(64) };

/** A Cargo.lock (format 4) with a root package and the given crates.io packages. */
function lockText(root: string, crates: readonly LockedCrate[]): string {
  const sorted = [...crates].sort((a, b) => a.name.localeCompare(b.name));
  const rootBlock = [
    "[[package]]",
    `name = "${root}"`,
    'version = "0.0.0"',
    "dependencies = [",
    ...sorted.map((c) => ` "${c.name}",`),
    "]",
  ].join("\n");
  const blocks = sorted.map((c) =>
    [
      "[[package]]",
      `name = "${c.name}"`,
      `version = "${c.version}"`,
      `source = "${CRATES_IO}"`,
      `checksum = "${c.checksum}"`,
    ].join("\n"),
  );
  return `# This file is automatically @generated by Cargo.\n# It is not intended for manual editing.\nversion = 4\n\n${[rootBlock, ...blocks].join("\n\n")}\n`;
}

/** The crates.io packages of a lock, sorted by name. */
function lockedCrates(text: string): LockedCrate[] {
  const blocks = text.split("[[package]]").slice(1);
  const field = (block: string, key: string) => block.match(new RegExp(`^${key} = "([^"]*)"`, "m"))?.[1];
  return blocks
    .map((block) => ({
      name: field(block, "name"),
      version: field(block, "version"),
      checksum: field(block, "checksum"),
    }))
    .filter((c): c is LockedCrate => c.name !== undefined && c.version !== undefined && c.checksum !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A fake `cargo` for vendoring, with crates.io as a table of each crate's latest version. The
 * allowlist always resolves to `base` (its transitive closure), plus any crate of the table the
 * manifest names. Like cargo: `generate-lockfile` resolves everything to the latest; `vendor`
 * keeps an existing lock's versions and adds what the manifest needs that the lock lacks, which
 * `--locked` refuses (exit 101). Every argv is appended to `log`.
 */
const FAKE_VENDOR_CARGO_JS = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [log, registryFile, ...argv] = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(argv) + "\n");
const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
const manifest = argv[argv.indexOf("--manifest-path") + 1];
const lockFile = path.join(path.dirname(manifest), "Cargo.lock");
const named = [...fs.readFileSync(manifest, "utf8").matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]);
const wanted = [...new Set([...registry.base, ...named.filter((n) => n in registry.latest)])];
const parse = (text) =>
  [...text.matchAll(/name = "([^"]+)"\nversion = "([^"]+)"\nsource = "[^"]+"\nchecksum = "([0-9a-f]+)"/g)].map((m) => ({
    name: m[1],
    version: m[2],
    checksum: m[3],
  }));
const block = (c) =>
  "\n[[package]]\nname = \"" + c.name + "\"\nversion = \"" + c.version + "\"\nsource = \"crates.io\"\nchecksum = \"" + c.checksum + "\"\n";
const write = (crates) =>
  fs.writeFileSync(lockFile, "version = 4\n" + [...crates].sort((a, b) => a.name.localeCompare(b.name)).map(block).join(""));
const latest = (name) => ({ name, ...registry.latest[name] });
if (argv[0] === "generate-lockfile") {
  write(wanted.map(latest));
  process.exit(0);
}
if (argv[0] !== "vendor") {
  console.error("fake cargo: " + argv[0]);
  process.exit(2);
}
const had = fs.existsSync(lockFile) ? parse(fs.readFileSync(lockFile, "utf8")) : null;
const missing = wanted.filter((n) => !(had ?? []).some((c) => c.name === n));
if (argv.includes("--locked") && (had === null || missing.length > 0)) {
  console.error("error: the lock file needs to be updated but --locked was passed to prevent this");
  process.exit(101);
}
const crates = [...(had ?? []), ...missing.map(latest)];
if (had === null || missing.length > 0) write(crates);
const out = argv[argv.length - 1];
for (const c of crates) {
  const dir = path.join(out, c.name + "-" + c.version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".cargo-checksum.json"), JSON.stringify({ files: {}, package: c.checksum }));
}
`;

/** The fake cargo's launcher: `--version` answers the pinned version, anything else runs the script above. */
const FAKE_VENDOR_CARGO = (script: string, log: string, registry: string) => `#!/bin/bash
if [ "$1" = "--version" ] || [ "$1" = "-V" ]; then echo "cargo ${RUST_VERSION} (fake)"; exit 0; fi
exec '${process.execPath}' '${script}' '${log}' '${registry}' "$@"
`;

interface VendorFixture extends FakeSpike {
  lock: string;
  allowlist: string;
  cargoLog: string;
}

/**
 * A spike folder as a fresh runner has it before vendoring (no vendor manifest, a stale tree),
 * with a committed lock pinning bytemuck and zerocopy 0.8.59, a workspace whose own lock agrees,
 * an allowlist of bytemuck alone, and crates.io whose latest zerocopy is 0.8.60.
 */
async function vendorFixture(workspaceCrates: readonly LockedCrate[] = [BYTEMUCK, ZEROCOPY_LOCKED]) {
  const f = await fakeSpike();
  const cargoLog = path.join(f.root, "cargo-argv.log");
  const registry = path.join(f.root, "crates-io.json");
  await writeFile(
    registry,
    JSON.stringify({
      base: [BYTEMUCK.name, ZEROCOPY_LATEST.name],
      latest: Object.fromEntries(
        [BYTEMUCK, ZEROCOPY_LATEST, NOISE].map((c) => [c.name, { version: c.version, checksum: c.checksum }]),
      ),
    }),
  );
  const script = path.join(f.root, "fake-vendor-cargo.cjs");
  await writeFile(script, FAKE_VENDOR_CARGO_JS);
  await writeTool(path.join(f.spike, "sysroot", "bin", "cargo"), FAKE_VENDOR_CARGO(script, cargoLog, registry));
  const lock = path.join(f.root, "vendor-allowlist.lock");
  await writeFile(lock, lockText("genex-spike-vendor", [BYTEMUCK, ZEROCOPY_LOCKED]));
  const allowlist = path.join(f.root, "vendor-allowlist.toml");
  await writeFile(allowlist, '[dependencies]\nbytemuck = { version = "1", features = ["derive"] }\n');
  await writeFile(path.join(f.workspace, "Cargo.lock"), lockText("genex", workspaceCrates));
  const env: NodeJS.ProcessEnv = {
    ...f.env,
    GENEX_SPIKE_VENDOR_LOCK: lock,
    GENEX_SPIKE_VENDOR_ALLOWLIST: allowlist,
  };
  return { ...f, env, lock, allowlist, cargoLog } satisfies VendorFixture;
}

/** The cargo argv lines the fake recorded, oldest first. */
async function cargoCalls(f: VendorFixture): Promise<string[][]> {
  if (!existsSync(f.cargoLog)) return [];
  const text = await readFile(f.cargoLog, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

const vendoredDirs = async (f: VendorFixture) => (await readdir(path.join(f.spike, "vendor"))).sort();

/** Each row makes the committed lock and what has to agree with it disagree; vendoring must refuse typed and change nothing. */
const LOCK_HOSTILE: Array<{
  name: string;
  code: Refusal;
  mode: string;
  workspace?: readonly LockedCrate[];
  arrange?: (f: VendorFixture) => Promise<void>;
  names?: string;
}> = [
  {
    name: "the workspace lock pins a version the committed lock does not",
    code: Refusal.VendorLockDisagreement,
    mode: "--vendor",
    workspace: [BYTEMUCK, { ...ZEROCOPY_LOCKED, version: "0.8.58" }],
    names: "zerocopy 0.8.58",
  },
  {
    name: "the workspace lock pins the same version with another checksum",
    code: Refusal.VendorLockDisagreement,
    mode: "--vendor",
    workspace: [BYTEMUCK, { ...ZEROCOPY_LOCKED, checksum: "e".repeat(64) }],
    names: "zerocopy 0.8.59",
  },
  {
    name: "--verify finds the workspace lock pinning a crate the committed lock lacks",
    code: Refusal.VendorLockDisagreement,
    mode: "--verify",
    workspace: [BYTEMUCK, ZEROCOPY_LOCKED, NOISE],
    names: "noise 0.9.0",
  },
  {
    name: "the committed lock is missing",
    code: Refusal.VendorLockMissing,
    mode: "--vendor",
    arrange: (f) => rm(f.lock),
  },
];

describe("setup-toolchain.sh vendors exactly the committed lock", POSIX_ONLY, () => {
  it("vendors the committed versions on a fresh runner with no vendor manifest (zerocopy 0.8.59, not crates.io's latest)", async () => {
    const f = await vendorFixture();
    const lockBefore = await readFile(f.lock, "utf8");
    const result = await run("bash", [SETUP, "--vendor"], f.env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await vendoredDirs(f), ["bytemuck-1.25.2", "zerocopy-0.8.59"]);
    assert.equal(await readFile(f.lock, "utf8"), lockBefore, "vendoring changed the committed lock");
    assert.equal(
      await readFile(path.join(f.spike, "vendor-manifest", "Cargo.lock"), "utf8"),
      lockBefore,
      "the vendor manifest's lock is the committed one",
    );
    const calls = await cargoCalls(f);
    assert.ok(!calls.some((argv) => argv[0] === "generate-lockfile"), JSON.stringify(calls));
    assert.ok(
      calls.some((argv) => argv[0] === "vendor" && argv.includes("--locked")),
      JSON.stringify(calls),
    );
    assert.match(
      await readFile(path.join(f.spike, "vendor-receipt.tsv"), "utf8"),
      new RegExp(`^lock\\t${await sha256Of(f.lock)}$`, "m"),
    );
  });

  for (const row of LOCK_HOSTILE) {
    it(`refuses typed and vendors nothing when ${row.name}`, async () => {
      const f = await vendorFixture(row.workspace);
      await row.arrange?.(f);
      const lockBefore = existsSync(f.lock) ? await readFile(f.lock, "utf8") : null;
      const spikeBefore = snapshot(f.spike);
      const result = await run("bash", [SETUP, row.mode], f.env);
      assertRefused(result, row.code);
      if (row.names) assert.ok(refusalOf(result)?.detail.includes(row.names), result.stderr);
      assert.deepEqual(await cargoCalls(f), [], "cargo ran");
      assert.deepEqual(snapshot(f.spike), spikeBefore);
      assert.equal(existsSync(f.lock) ? await readFile(f.lock, "utf8") : null, lockBefore);
    });
  }

  it("changes the committed lock only under --relock, keeping its existing versions", async () => {
    const f = await vendorFixture();
    await writeFile(f.allowlist, '[dependencies]\nbytemuck = "1"\nnoise = "0.9"\n');
    const lockBefore = await readFile(f.lock, "utf8");

    const vendored = await run("bash", [SETUP, "--vendor"], f.env);
    assertRefused(vendored, Refusal.CargoVendorFailed);
    assert.equal(await readFile(f.lock, "utf8"), lockBefore, "--vendor changed the committed lock");

    const relocked = await run("bash", [SETUP, "--relock"], f.env);
    assert.equal(relocked.code, 0, relocked.stderr);
    const lockAfter = await readFile(f.lock, "utf8");
    assert.deepEqual(lockedCrates(lockAfter), [BYTEMUCK, NOISE, ZEROCOPY_LOCKED]);
    assert.deepEqual(await vendoredDirs(f), ["bytemuck-1.25.2", "noise-0.9.0", "zerocopy-0.8.59"]);
    assert.equal(await readFile(path.join(f.spike, "vendor-manifest", "Cargo.lock"), "utf8"), lockAfter);
  });
});

/** Rows over the real installed spike toolchain: skipped without it, failed under GENEX_REQUIRE_SPIKE_TOOLCHAIN=1. */
function needsSpikeToolchain(): { skip?: string } {
  if (process.platform !== "darwin") return { skip: "not run: the network-denied rows use macOS sandbox-exec" };
  if (existsSync(path.join(REAL_SPIKE, "receipt.tsv")) && existsSync(REAL_APPROVALS)) return {};
  if (process.env.GENEX_REQUIRE_SPIKE_TOOLCHAIN === "1") {
    throw new Error(
      `GENEX_REQUIRE_SPIKE_TOOLCHAIN=1: no spike toolchain at ${REAL_SPIKE}; run setup-toolchain.sh or unset it`,
    );
  }
  return { skip: "not run: spike toolchain absent (bash scripts/spike/rust-wgpu/setup-toolchain.sh)" };
}

const PROBE_MANIFEST = `[package]
name = "spike-probe"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
bytemuck = "1"
`;

describe("the installed spike toolchain", () => {
  const options = needsSpikeToolchain();

  it(`answers cargo ${RUST_VERSION} from the spike sysroot and verifies its pins`, options, async () => {
    const version = await run("bash", [RUST_ENV, "cargo", "--version"], process.env);
    assert.equal(version.code, 0, version.stderr);
    assert.ok(version.stdout.startsWith(`cargo ${RUST_VERSION} `), version.stdout);
    const verify = await run("bash", [SETUP, "--verify"], process.env);
    assert.equal(verify.code, 0, `${verify.stdout}\n${verify.stderr}`);
  });

  it("builds a crate with the network denied only through the vendored CARGO_HOME, twice", options, async () => {
    const root = await tmpDir("rust-spike-offline-");
    const probe = path.join(root, "probe");
    await mkdir(path.join(probe, "src"), { recursive: true });
    await writeFile(path.join(probe, "Cargo.toml"), PROBE_MANIFEST);
    await writeFile(
      path.join(probe, "src", "lib.rs"),
      "pub fn bytes(v: &[u32]) -> &[u8] { bytemuck::cast_slice(v) }\n",
    );
    const target = path.join(root, "target");
    const rlib = path.join(target, "debug", "libspike_probe.rlib");
    const sysrootBin = path.join(REAL_SPIKE, "sysroot", "bin");

    // Before vendoring: the spike's own cargo with an empty CARGO_HOME must reach crates.io, which the sandbox denies.
    const bareHome = path.join(root, "bare-cargo-home");
    await mkdir(bareHome, { recursive: true });
    const bare = await run(
      SANDBOX_EXEC,
      [
        "-p",
        NO_NETWORK_PROFILE,
        path.join(sysrootBin, "cargo"),
        "build",
        "--manifest-path",
        path.join(probe, "Cargo.toml"),
      ],
      {
        HOME: root,
        PATH: [sysrootBin, "/usr/bin", "/bin"].join(":"),
        CARGO_HOME: bareHome,
        CARGO_TARGET_DIR: target,
        RUSTC: path.join(sysrootBin, "rustc"),
      },
    );
    assert.notEqual(bare.code, 0, "a build without the vendored registry succeeded with the network denied");
    assert.equal(existsSync(rlib), false);

    // After vendoring: rust-env.sh's CARGO_HOME replaces crates.io with the vendored tree.
    const env = { ...process.env, GENEX_SPIKE_WORKSPACE: probe, CARGO_TARGET_DIR: target };
    for (const attempt of ["first", "second"]) {
      const built = await run(
        SANDBOX_EXEC,
        ["-p", NO_NETWORK_PROFILE, "bash", RUST_ENV, "cargo", "build", "--offline"],
        env,
      );
      assert.equal(built.code, 0, `${attempt} offline build: ${built.stderr}`);
    }
    assert.ok(existsSync(rlib));
  });
});

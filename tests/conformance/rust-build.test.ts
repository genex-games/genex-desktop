/**
 * The Rust build lane (`RustBuilds`, `src/main/rust-build.ts`) behind the build-lane seam, over a
 * stub cargo and rustc: the lane's own sandbox per build, the host-written `CARGO_HOME` and fixed
 * environment, the host-owned working folder, the offline lock it verifies before `--locked`
 * builds, the clippy gate, Cargo's JSON messages (the first diagnostic with spans; artifact paths
 * read from the messages, never the target folder's layout), the admitted copy of `out/` outside
 * every build-writable path, receipts with timing and the compiler's identity, and the per-target
 * builder table with refusing placeholders.
 *
 * The stub cargo behaves as cargo documents its configuration: it reads `.cargo/config.toml` from
 * its working folder and every folder above it, and `$CARGO_HOME/config.toml` (default
 * `$HOME/.cargo`); a file saying `planted` makes it fail. It reaches for the npm registry through
 * whatever proxy its environment names, as any sandboxed process could while a package install
 * has the registry open. The sandbox rows (sibling game, late writer) run under the real Seatbelt
 * sandbox and so only on macOS. The real toolchain rows are `rust-lane-real.test.ts`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { coreGameBuilds } from "../../src/main/core/internals.ts";
import { BuildPriority, type GameBuildGame } from "../../src/main/game-build.ts";
import {
  RUST_CRATE_ALLOWLIST,
  RUST_TARGET_BUILDERS,
  RustBuilds,
  type RustBuildSandbox,
  type RustBuildSandboxSpec,
  type RustBuildsOptions,
  type RustStaged,
  type RustToolchain,
  rustBuildSandboxes,
} from "../../src/main/rust-build.ts";
import { RustBuildRefusal, RustDiagnosticTool } from "../../src/main/rust-build-diagnostics.ts";
import { RustTargetSeed, RustTargetSharing } from "../../src/main/rust-build-cache.ts";
import type { PlayStage, PlayTimingSink } from "../../src/shared/play-timing.ts";
import { cloneTreeByFile, type TreeCloner } from "../../src/substrate/clone-tree.ts";
import { RustNetFeature } from "../../src/main/rust-manifest.ts";
import { BuildProblemCode, CppBuildPurpose } from "../../src/shared/build-problem.ts";
import {
  BuildTarget,
  type GameDestinations,
  GameStack,
  ProjectKind,
  type ProjectShape,
} from "../../src/shared/game-project.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import type { XcodeExec } from "../../src/substrate/toolchain-store/locate.ts";
import { RUST_DEV_PROFILE_SETTINGS } from "../../src/substrate/toolchain-store/rust-locate.ts";
import { admitRustOutput } from "../../src/substrate/native-cross-admission.ts";
import { NativeRefusal, RustAdmissionProblem } from "../../src/shared/native-contract.ts";
import { macBinary } from "../fixtures/rust-bundles/binaries.ts";
import { DebugFileKind, EXPORT_DEBUG_SETTINGS } from "../../src/substrate/rust-debug-files.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LOCK: ToolchainLock = {
  version: 1,
  entries: { rust: { version: "1.99.0", sha12: "0123456789ab" } },
  digest: "0123456789abcdef".repeat(4),
};
const MAC_SDK = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";
const RUST_SHAPE: ProjectShape = {
  entry: "index.html",
  main: "src/main.rs",
  build: null,
  install: null,
  own: false,
  kind: ProjectKind.RustWgpu,
  serve: ".",
};
const EVERYWHERE: GameDestinations = {
  stack: GameStack.RustWgpu,
  targets: [
    BuildTarget.Web,
    BuildTarget.Mac,
    BuildTarget.Windows,
    BuildTarget.Linux,
    BuildTarget.Ios,
    BuildTarget.Android,
  ],
};
const MAC_ONLY: GameDestinations = { stack: GameStack.RustWgpu, targets: [BuildTarget.Mac] };
/** The bytes the stub's build writes as the game's executable. */
const GAME_BYTES = "#!/bin/sh\necho game\n";
const RUSTC_VV = [
  "rustc 1.99.0 (1d4e1a2b3 2026-09-17)",
  "binary: rustc",
  "commit-hash: 1d4e1a2b3c4d5e6f",
  "commit-date: 2026-09-17",
  "host: aarch64-apple-darwin",
  "release: 1.99.0",
  "LLVM version: 21.1.2",
].join("\n");
const LOCK_FILE = [
  "version = 4",
  "",
  "[[package]]",
  'name = "game"',
  'version = "0.0.0"',
  'dependencies = ["genex"]',
  "",
  "[[package]]",
  'name = "genex"',
  'version = "0.1.0"',
  "",
  "[[package]]",
  'name = "libm"',
  'version = "0.2.16"',
  'source = "registry+https://github.com/rust-lang/crates.io-index"',
  'checksum = "aa"',
  "",
].join("\n");
const SKIP_UNLESS_MAC = process.platform === "darwin" ? false : "the Seatbelt sandbox is macOS's";
const SKIP_ON_WINDOWS = process.platform === "win32" ? "the stub cargo is a POSIX shell script" : false;

/** The Command Line Tools as `xcode-select -p` and `xcrun --show-sdk-path` answer them. */
const xcode: XcodeExec = async (file) =>
  file.endsWith("xcode-select")
    ? { code: 0, stdout: "/Library/Developer/CommandLineTools\n", stderr: "" }
    : { code: 0, stdout: `${MAC_SDK}\n`, stderr: "" };

/** What a test adds to the stub cargo: shell run for a subcommand, and the lock it writes. */
interface StubCargo {
  /** Shell run for `cargo build` before it reports its artifact. */
  onBuild?: string;
  /** Shell run for `cargo clippy`; print messages and exit non-zero to fail the gate. */
  onClippy?: string;
  /** The Cargo.lock `generate-lockfile` writes. */
  lock?: string;
  /** A file whose bytes `cargo build` writes as the game's executable (default: a shell script). */
  exeFrom?: string;
}

/** `text` as one single-quoted shell word. */
function shellWord(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The stub cargo: reads its configuration as cargo does, reaches for the registry, then plays the subcommand. */
function stubCargo(stub: StubCargo): string {
  const artifact =
    '{"reason":"compiler-artifact","package_id":"path+file://STAGE#game@0.0.0","manifest_path":"MANIFEST",' +
    '"target":{"kind":["bin"],"crate_types":["bin"],"name":"game"},"filenames":["EXE"],"executable":"EXE","fresh":false}';
  return `#!/bin/sh
d=$(pwd -P)
while :; do
  for f in "$d/.cargo/config.toml" "$d/.cargo/config"; do
    if [ -f "$f" ] && grep -q planted "$f"; then echo "error: planted config read: $f" >&2; exit 101; fi
  done
  [ "$d" = / ] && break
  d=$(dirname "$d")
done
home=\${CARGO_HOME:-$HOME/.cargo}
if [ -f "$home/config.toml" ] && grep -q planted "$home/config.toml"; then echo "error: planted CARGO_HOME" >&2; exit 101; fi
proxy=\${HTTPS_PROXY:-\${https_proxy:-\${HTTP_PROXY:-\${http_proxy:-}}}}
if [ -n "$proxy" ]; then /usr/bin/curl -s -m 5 -x "$proxy" http://registry.npmjs.org/ -o /dev/null || true; fi
sub=$1
shift
manifest=""
prev=""
for a in "$@"; do
  if [ "$prev" = --manifest-path ]; then manifest=$a; fi
  prev=$a
done
case "$sub" in
  generate-lockfile)
    printf '%s' ${shellWord(stub.lock ?? LOCK_FILE)} > "$(dirname "$manifest")/Cargo.lock"
    ;;
  clippy)
    ${stub.onClippy ?? ":"}
    echo '{"reason":"build-finished","success":true}'
    ;;
  build)
    ${stub.onBuild ?? ":"}
    exe="$CARGO_TARGET_DIR/aarch64-apple-darwin/odd/place/game-5d41402abc"
    mkdir -p "$(dirname "$exe")"
    ${stub.exeFrom ? `cp ${shellWord(stub.exeFrom)} "$exe"` : `printf '#!/bin/sh\\necho game\\n' > "$exe"`}
    chmod +x "$exe"
    echo '${artifact}' | sed -e "s#STAGE#$(dirname "$manifest")#" -e "s#MANIFEST#$manifest#" -e "s#EXE#$exe#g"
    echo '{"reason":"build-finished","success":true}'
    ;;
esac
exit 0
`;
}

/** A stub cargo and rustc in `bin`. */
async function writeToolchain(bin: string, stub: StubCargo = {}): Promise<void> {
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "cargo"), stubCargo(stub), { mode: 0o755 });
  // printf, not a here-document: the shell's here-document file is refused inside the sandbox.
  await writeFile(path.join(bin, "rustc"), `#!/bin/sh\nprintf '%s\\n' ${shellWord(RUSTC_VV)}\n`, { mode: 0o755 });
}

/** A Rust game folder: its genex.toml, its sources and one asset. */
async function rustGame(parent: string, name = "game"): Promise<string> {
  const dir = path.join(parent, name);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeFile(path.join(dir, "genex.toml"), '[game]\ntitle = "Game"\n');
  await writeFile(path.join(dir, "src", "main.rs"), "fn main() {}\n");
  await writeFile(path.join(dir, "assets", "fish.txt"), "fish");
  return dir;
}

/** A stand-in for M2.2's staging and manifest writer: copies src/ and assets/ and writes a manifest declaring `dependencies`. */
function stager(
  dependencies: Record<string, string> = { genex: "=0.1.0" },
  nativeFeatures: readonly string[] = [],
  fragments: { renderToml?: string | null; wgslToml?: string } = {},
) {
  const stage = async (game: { dir: string }, into: string): Promise<RustStaged> => {
    for (const folder of ["src", "assets"]) {
      await mkdir(path.join(into, folder), { recursive: true });
      for (const name of await readdir(path.join(game.dir, folder))) {
        const from = path.join(game.dir, folder, name);
        if ((await stat(from)).isFile()) await writeFile(path.join(into, folder, name), await readFile(from));
      }
    }
    const deps = Object.entries(dependencies).map(([name, version]) => `${name} = "${version}"`);
    const manifest = `[package]\nname = "game"\nversion = "0.0.0"\nedition = "2024"\n\n[dependencies]\n${deps.join("\n")}\n`;
    await writeFile(path.join(into, "Cargo.toml"), manifest);
    return { ok: true, dependencies: Object.keys(dependencies), nativeFeatures, ...fragments };
  };
  return { stage };
}

/** `request` run by /bin/sh with this process's environment plus `env` (as srt adds its proxy settings). */
async function runShell(request: RunRequest, env: Record<string, string>): Promise<RunResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", request.command], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
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

/** The sandbox the lane asks for, run without containment: every spec and request recorded. */
function openSandboxes(env: Record<string, string> = {}) {
  const specs: RustBuildSandboxSpec[] = [];
  const requests: RunRequest[] = [];
  const disposed: RustBuildSandboxSpec[] = [];
  const sandbox = async (spec: RustBuildSandboxSpec): Promise<RustBuildSandbox> => {
    specs.push(spec);
    return {
      run: async (request) => {
        requests.push(request);
        return await runShell(request, env);
      },
      dispose: async () => {
        disposed.push(spec);
      },
    };
  };
  return { sandbox, specs, requests, disposed };
}

/** What a test changes about the lane besides its options: the stub cargo and the stager. */
interface LaneOverrides extends Partial<RustBuildsOptions> {
  stub?: StubCargo;
  staging?: ReturnType<typeof stager>;
}

/** A Rust lane over a fresh root in `parent`, the stub toolchain, the given stager and sandbox. */
async function lane(parent: string, sandbox: RustBuildsOptions["sandbox"], overrides: LaneOverrides = {}) {
  const { stub, staging, ...options } = overrides;
  const root = path.join(parent, "rust-builds");
  const bin = path.join(parent, "toolchain", "bin");
  await writeToolchain(bin, stub);
  const vendor = path.join(parent, "toolchain", "vendor");
  await mkdir(path.join(vendor, "libm-0.2.16"), { recursive: true });
  const conf = path.join(parent, "toolchain", "clippy");
  await mkdir(conf, { recursive: true });
  await writeFile(path.join(conf, "clippy.toml"), "disallowed-types = []\n");
  const toolchain: RustToolchain = { bin, vendor, clippyConf: conf, reads: [path.join(parent, "toolchain")] };
  const builds = new RustBuilds({
    root,
    sandbox,
    locate: async () => ({ ok: true, toolchain }),
    currentLock: async () => LOCK,
    stage: (staging ?? stager()).stage,
    emit: () => {},
    platform: "darwin",
    cores: 8,
    denyWrite: [],
    writeLock: async () => {},
    exec: xcode,
    ...options,
  });
  return { builds, root };
}

function gameOf(dir: string, destinations: GameDestinations = MAC_ONLY): GameBuildGame {
  return { project: path.basename(dir), dir, shape: { ...RUST_SHAPE }, destinations };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A proxy standing in for srt's while a package install has opened the registry: it records every authorised request. */
async function registryProxy(token: string): Promise<{ port: number; reached: string[]; close: () => Promise<void> }> {
  const reached: string[] = [];
  const server: Server = createServer((request, response) => {
    const auth = String(request.headers["proxy-authorization"] ?? "");
    const decoded = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString("utf8");
    if (decoded.endsWith(`:${token}`)) {
      reached.push(request.url ?? "");
      response.writeHead(200).end("registry");
      return;
    }
    response.writeHead(407).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, reached, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

describe("the Rust lane's typed refusals run nothing", { skip: SKIP_ON_WINDOWS }, () => {
  it("refuses a dependency outside the reviewed allowlist with a typed code, before any cargo runs", async () => {
    const parent = await realpath(await tmpDir("rust-allowlist-"));
    const open = openSandboxes();
    const { builds } = await lane(parent, open.sandbox, { staging: stager({ genex: "=0.1.0", serde: "1.0" }) });
    const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ran, false);
    assert.equal(outcome.rust?.refusal, RustBuildRefusal.DependencyNotAllowed);
    assert.ok(outcome.problem?.lines.some((line) => line.includes("serde")));
    assert.deepEqual(open.requests, [], "no cargo ran");
  });

  it("builds a game that names only the facade and the reviewed crates", async () => {
    const parent = await realpath(await tmpDir("rust-allowlist-ok-"));
    const open = openSandboxes();
    const reviewed = Object.fromEntries(Object.keys(RUST_CRATE_ALLOWLIST).map((name) => [name, "*"]));
    const { builds } = await lane(parent, open.sandbox, { staging: stager({ genex: "=0.1.0", ...reviewed }) });
    const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
  });

  it("refuses a lock that resolves a crate from anywhere but the vendored registry, building nothing", async () => {
    const parent = await realpath(await tmpDir("rust-lock-git-"));
    const open = openSandboxes();
    const gitLock = `${LOCK_FILE}\n[[package]]\nname = "sneaky"\nversion = "1.0.0"\nsource = "git+https://example.com/sneaky#abc"\n`;
    const { builds } = await lane(parent, open.sandbox, { stub: { lock: gitLock } });
    const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.rust?.refusal, RustBuildRefusal.LockRefused);
    assert.ok(outcome.problem?.lines.some((line) => line.includes("sneaky")));
    const commands = open.requests.map((request) => request.command);
    assert.ok(!commands.some((command) => / 'build' /.test(command)), "nothing was built");
  });

  it("refuses every destination whose builder has not landed with a typed code, running nothing", async () => {
    const parent = await realpath(await tmpDir("rust-placeholders-"));
    const open = openSandboxes();
    const { builds } = await lane(parent, open.sandbox);
    const dir = await rustGame(parent);
    const pending = [BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux, BuildTarget.Ios, BuildTarget.Android];
    for (const target of pending) {
      assert.equal(RUST_TARGET_BUILDERS[target].ready, false, `${target} is a placeholder`);
      const outcome = await builds.ensure(gameOf(dir, EVERYWHERE), target, CppBuildPurpose.Judging);
      assert.equal(outcome.ok, false, target);
      assert.equal(outcome.rust?.refusal, RustBuildRefusal.TargetUnbuilt, target);
    }
    assert.equal(RUST_TARGET_BUILDERS[BuildTarget.Mac].ready, true);
    assert.deepEqual(open.requests, []);
  });

  it("refuses a destination the game does not name, a host the lane does not run on and a Mac with no SDK", async () => {
    const parent = await realpath(await tmpDir("rust-host-"));
    const open = openSandboxes();
    const dir = await rustGame(parent);
    const webOnly: GameDestinations = { stack: GameStack.RustWgpu, targets: [BuildTarget.Web] };
    const unnamed = await (await lane(parent, open.sandbox)).builds.ensure(
      gameOf(dir, webOnly),
      BuildTarget.Mac,
      CppBuildPurpose.Live,
    );
    assert.equal(unnamed.problem?.reason, BuildProblemCode.NotADestination);
    const windows = await (await lane(parent, open.sandbox, { platform: "win32" })).builds.ensure(
      gameOf(dir),
      BuildTarget.Mac,
      CppBuildPurpose.Live,
    );
    assert.equal(windows.problem?.reason, BuildProblemCode.UnsupportedHost);
    const noClt: XcodeExec = async () => ({ code: 2, stdout: "", stderr: "" });
    const clt = await (await lane(parent, open.sandbox, { exec: noClt })).builds.ensure(
      gameOf(dir),
      BuildTarget.Mac,
      CppBuildPurpose.Live,
    );
    assert.equal(clt.problem?.reason, BuildProblemCode.CltMissing);
    assert.deepEqual(open.requests, []);
  });
});

/** A sandbox whose every command holds until its signal aborts, then answers killed: every request recorded. */
function holdingSandboxes() {
  const requests: RunRequest[] = [];
  const sandbox = async (): Promise<RustBuildSandbox> => ({
    run: (request) => {
      requests.push(request);
      return new Promise((resolve) => {
        const killed = (): void =>
          resolve({
            code: null,
            signal: "SIGKILL",
            stdout: "",
            stderr: "",
            durationMs: 0,
            timedOut: false,
            truncated: false,
            sandboxed: false,
            command: request.command,
            cwd: request.cwd,
          });
        if (request.signal?.aborted) killed();
        else request.signal?.addEventListener("abort", killed, { once: true });
      });
    },
    dispose: async () => {},
  });
  return { sandbox, requests };
}

describe("Composer Stop in the Rust lane", { skip: SKIP_ON_WINDOWS }, () => {
  it("cancelGame cancels one game's builds, its copies' too, and leaves another game's running", async () => {
    const parent = await realpath(await tmpDir("rust-cancel-game-"));
    const holding = holdingSandboxes();
    const { builds } = await lane(parent, holding.sandbox, { cores: 16 });
    const lake = { ...gameOf(await rustGame(parent, "lake")), project: "lake" };
    const other = builds.ensure(lake, BuildTarget.Mac, CppBuildPurpose.Live);
    for (let i = 0; i < 400 && holding.requests.length < 1; i++) await sleep(5);
    const pond = { ...gameOf(await rustGame(parent, "pond")), project: "pond" };
    const copy = { ...gameOf(await rustGame(parent, "pond-copy")), project: "pond" };
    const own = [pond, copy].map((game) => builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live));
    for (let i = 0; i < 400 && holding.requests.length < 3; i++) await sleep(5);
    assert.equal(holding.requests.length, 3, "all three build");
    builds.cancelGame("pond");
    for (const outcome of await Promise.all(own)) assert.equal(outcome.problem?.reason, BuildProblemCode.Cancelled);
    assert.equal(holding.requests[0]?.signal?.aborted, false, "another game's build goes on");
    builds.cancelAll();
    assert.equal((await other).problem?.reason, BuildProblemCode.Cancelled);
  });
});

describe("the Rust lane builds behind the seam", { skip: SKIP_ON_WINDOWS }, () => {
  it("registers as the Rust · wgpu lane of core.gameBuilds", async () => {
    const parent = await realpath(await tmpDir("rust-seam-"));
    const open = openSandboxes();
    const { builds } = await lane(parent, open.sandbox);
    const lanes = coreGameBuilds({
      cppBuilds: {
        ensure: async () => assert.fail("not the raylib lane"),
        cancelAll: () => {},
        cancelGame: () => {},
        sweep: async () => 0,
      },
      rustBuilds: builds,
    });
    const receipt = await lanes.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(receipt.refusal, null);
    assert.equal(receipt.stack, GameStack.RustWgpu);
    assert.equal(receipt.outcome?.ok, true, JSON.stringify(receipt.outcome?.problem));
  });

  it("serves an admitted copy of the executable cargo named, with the staged assets, outside every build-writable folder", async () => {
    const parent = await realpath(await tmpDir("rust-artifacts-"));
    const open = openSandboxes();
    const { builds, root } = await lane(parent, open.sandbox);
    const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    const output = outcome.output ?? "";
    assert.equal(await readFile(path.join(output, "game"), "utf8"), GAME_BYTES);
    assert.equal(await readFile(path.join(output, "game-headless"), "utf8"), GAME_BYTES);
    assert.equal(await readFile(path.join(output, "assets", "fish.txt"), "utf8"), "fish");
    assert.ok(output.startsWith(`${root}${path.sep}`));
    for (const spec of open.specs) {
      for (const writable of [...spec.allowWrite, spec.tmp])
        assert.ok(!`${output}${path.sep}`.startsWith(`${writable}${path.sep}`), `${output} is under ${writable}`);
    }
  });

  it("runs cargo from a host-owned folder with a host-written CARGO_HOME: planted configs in the game, its parents and HOME change nothing", async () => {
    const home = await realpath(await tmpDir("rust-home-"));
    const parent = path.join(home, "Library", "Genex");
    const games = path.join(parent, "games");
    const dir = await rustGame(games);
    const planted = '[build]\nrustc = "/usr/bin/false"\n# planted\n';
    for (const where of [dir, path.join(dir, "src"), games, parent, home]) {
      await mkdir(path.join(where, ".cargo"), { recursive: true });
      await writeFile(path.join(where, ".cargo", "config.toml"), planted);
    }
    const open = openSandboxes({ HOME: home, CARGO_HOME: path.join(home, ".cargo") });
    const { builds } = await lane(parent, open.sandbox);
    const outcome = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    assert.ok(open.requests.length > 0);
  });

  it("gives no build a way to the registry while a package install has it open", async () => {
    const parent = await realpath(await tmpDir("rust-offline-"));
    const proxy = await registryProxy("token-of-the-install");
    try {
      const url = `http://studio:token-of-the-install@127.0.0.1:${proxy.port}`;
      const open = openSandboxes({ HTTPS_PROXY: url, HTTP_PROXY: url, https_proxy: url, http_proxy: url });
      const { builds } = await lane(parent, open.sandbox);
      const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
      assert.ok(open.requests.length > 0);
      assert.deepEqual(proxy.reached, [], "no build process reached the registry through the open proxy");
      for (const spec of open.specs) assert.deepEqual(spec.allowedDomains, []);
    } finally {
      await proxy.close();
    }
  });

  it("runs each build in a sandbox of its own that writes only its folder, and lets it go", async () => {
    const parent = await realpath(await tmpDir("rust-own-sandbox-"));
    const open = openSandboxes();
    const { builds } = await lane(parent, open.sandbox);
    const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    assert.equal(open.specs.length, 1);
    const [spec] = open.specs;
    assert.ok(spec);
    assert.deepEqual(spec.allowWrite, [spec.bin]);
    assert.ok(spec.tmp.startsWith(`${spec.bin}${path.sep}`), "TMPDIR is private to the build");
    assert.deepEqual(open.disposed, [spec]);
  });

  it("gates on clippy with the store's clippy.toml, forbids unsafe code and reports the first diagnostic with spans", async () => {
    const parent = await realpath(await tmpDir("rust-clippy-"));
    const open = openSandboxes();
    const message = {
      reason: "compiler-message",
      package_id: "game 0.0.0",
      message: {
        message: "use of a disallowed method `f32::sin`",
        code: { code: "clippy::disallowed_methods" },
        level: "error",
        spans: [
          { file_name: "STAGE/src/main.rs", line_start: 2, column_start: 1, is_primary: false },
          { file_name: "STAGE/src/game.rs", line_start: 7, column_start: 13, is_primary: true },
        ],
        children: [{ message: "platform libm: use genex::math::sin", level: "note", spans: [] }],
        rendered: "error: use of a disallowed method `f32::sin`\n --> src/game.rs:7:13\n",
      },
    };
    const warning = { reason: "compiler-message", message: { message: "unused", level: "warning", spans: [] } };
    const noSpans = { reason: "compiler-message", message: { message: "aborting", level: "error", spans: [] } };
    const onClippy = [
      'stage=$(dirname "$manifest")',
      `printf '%s\\n' '${JSON.stringify(warning)}' '${JSON.stringify(noSpans)}'`,
      `printf '%s\\n' '${JSON.stringify(message)}' | sed "s#STAGE#$stage#g"`,
      'echo "$CLIPPY_CONF_DIR" > "$CARGO_TARGET_DIR/../clippy-conf"',
      'echo "$RUSTFLAGS" > "$CARGO_TARGET_DIR/../rustflags"',
      'echo "$*" > "$CARGO_TARGET_DIR/../clippy-args"',
      "exit 101",
    ].join("\n");
    const { builds } = await lane(parent, open.sandbox, { stub: { onClippy } });
    const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
    const [first] = outcome.rust?.diagnostics ?? [];
    assert.deepEqual(first, {
      tool: RustDiagnosticTool.Clippy,
      code: "clippy::disallowed_methods",
      file: "src/game.rs",
      line: 7,
      column: 13,
      message: "use of a disallowed method `f32::sin`",
      notes: ["platform libm: use genex::math::sin"],
    });
    assert.equal(outcome.problem?.lines[0], "error: use of a disallowed method `f32::sin`");
    const [spec] = open.specs;
    assert.ok(spec);
    const flags = (await readFile(path.join(spec.bin, "rustflags"), "utf8")).trim();
    assert.match(flags, /(^| )-F unsafe_code( |$)/);
    const conf = (await readFile(path.join(spec.bin, "clippy-conf"), "utf8")).trim();
    assert.equal(await readFile(path.join(conf, "clippy.toml"), "utf8"), "disallowed-types = []\n");
    const args = await readFile(path.join(spec.bin, "clippy-args"), "utf8");
    for (const flag of ["--offline", "--locked", "-D warnings"]) assert.ok(args.includes(flag), `clippy ran ${flag}`);
  });

  it("compiles in the native-enhanced features genex.toml declares (GENEX_NATIVE_FEATURES), and none for a core game", async () => {
    for (const [features, expected] of [
      [["subgroup", "ray-query"], "subgroup,ray-query"],
      [[], "unset"],
    ] as const) {
      const parent = await realpath(await tmpDir("rust-native-features-"));
      const open = openSandboxes();
      const onBuild = '{ printenv GENEX_NATIVE_FEATURES || echo unset; } > "$CARGO_TARGET_DIR/../native-features"';
      const staging = stager({ genex: "=0.1.0" }, features);
      const { builds } = await lane(parent, open.sandbox, { stub: { onBuild }, staging });
      const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
      const [spec] = open.specs;
      assert.ok(spec);
      assert.equal((await readFile(path.join(spec.bin, "native-features"), "utf8")).trim(), expected);
    }
  });

  it("names a libcolyseus folder (GENEX_COLYSEUS_LIB_DIR) in every native build, so the relay client's build script never downloads one (MP-1a)", async () => {
    const component = "/store/colyseus/0.18.10-0123456789ab";
    for (const pinned of [false, true]) {
      const parent = await realpath(await tmpDir("rust-colyseus-env-"));
      const open = openSandboxes();
      const onBuild = '{ printenv GENEX_COLYSEUS_LIB_DIR || echo unset; } > "$CARGO_TARGET_DIR/../colyseus"';
      const { builds } = await lane(parent, open.sandbox, { stub: { onBuild }, staging: stager({ genex: "=0.1.0" }) });
      if (pinned) {
        const located = await builds.options.locate(LOCK, BuildTarget.Mac);
        assert.ok(located.ok);
        builds.options.locate = async () => ({ ok: true, toolchain: { ...located.toolchain, colyseus: component } });
      }
      const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
      const [spec] = open.specs;
      assert.ok(spec);
      const named = (await readFile(path.join(spec.bin, "colyseus"), "utf8")).trim();
      // No component pinned on this host: a folder inside the build that is never made, so the script stops on its own message.
      const expected = pinned
        ? path.join(component, "lib", "aarch64-apple-darwin")
        : path.join(spec.bin, "colyseus-not-pinned");
      assert.equal(named, expected);
    }
  });

  it("compiles in genex.toml's [render] tables and [[wgsl]] rows (GENEX_RENDER_TOML, GENEX_WGSL_TOML) for every destination", async () => {
    const render = "[render]\n[render.look]\n[render.class.mobile-mid]\nrender_scale = 0.6\n";
    const wgsl = '[[wgsl]]\npath = "shaders/glow.wgsl"\nkind = "material"\napi = 1\n';
    for (const [fragments, expected] of [
      [{ renderToml: render, wgslToml: wgsl }, `${render}--\n${wgsl}`],
      // No [render]: unset. No [[wgsl]] rows: set and empty, so a compiled-in source is undeclared everywhere.
      [{ renderToml: null, wgslToml: "" }, "unset\n--\n"],
    ] as const) {
      const parent = await realpath(await tmpDir("rust-render-toml-"));
      const open = openSandboxes();
      const onBuild =
        '{ printenv GENEX_RENDER_TOML || echo unset; echo --; printenv GENEX_WGSL_TOML || echo unset; } > "$CARGO_TARGET_DIR/../fragments"';
      const staging = stager({ genex: "=0.1.0" }, [], fragments);
      const { builds } = await lane(parent, open.sandbox, { stub: { onBuild }, staging });
      const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
      const [spec] = open.specs;
      assert.ok(spec);
      // printenv adds a newline after each value; the fragments end in their own.
      const written = (await readFile(path.join(spec.bin, "fragments"), "utf8")).replace(/\n\n/g, "\n");
      assert.equal(written, expected);
    }
  });

  it("links a [net] game's room in Live and its relay in an export, which alone bakes in the binding's slug (G6 MP-5b)", async () => {
    const NET_ON = { enabled: true, matchmaking: null };
    const rows: Array<[CppBuildPurpose, RustStaged & { ok: true }, string | null, RustNetFeature, string]> = [
      [
        CppBuildPurpose.Live,
        { ok: true, dependencies: ["genex"], net: NET_ON },
        "tag-run",
        RustNetFeature.Loopback,
        "unset",
      ],
      [
        CppBuildPurpose.Export,
        { ok: true, dependencies: ["genex"], net: NET_ON },
        "tag-run",
        RustNetFeature.Relay,
        "tag-run",
      ],
      // A hostile binding is never baked; a game with networking off never carries a slug.
      [
        CppBuildPurpose.Export,
        { ok: true, dependencies: ["genex"], net: NET_ON },
        "../x",
        RustNetFeature.Relay,
        "unset",
      ],
      [
        CppBuildPurpose.Export,
        { ok: true, dependencies: ["genex"], net: null },
        "tag-run",
        RustNetFeature.Relay,
        "unset",
      ],
    ];
    for (const [purpose, answer, slug, feature, baked] of rows) {
      const parent = await realpath(await tmpDir("rust-net-slug-"));
      const open = openSandboxes();
      const linked: Array<RustNetFeature | undefined> = [];
      const base = stager();
      const stage: RustBuildsOptions["stage"] = async (
        game,
        into,
        _target,
        _flavour,
        _lock,
        _vendor,
        _ejected,
        net,
      ) => {
        linked.push(net);
        const staged = await base.stage(game, into);
        return staged.ok ? { ...staged, ...answer } : staged;
      };
      const onBuild = '{ printenv GENEX_GAME_SLUG || echo unset; } > "$CARGO_TARGET_DIR/../slug"';
      const { builds } = await lane(parent, open.sandbox, {
        stub: { onBuild },
        stage,
        gameSlug: async () => slug,
      });
      const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, purpose);
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
      assert.deepEqual(linked, [feature], `${purpose}: what the stage links`);
      const [spec] = open.specs;
      assert.ok(spec);
      assert.equal((await readFile(path.join(spec.bin, "slug"), "utf8")).trim(), baked, `${purpose} ${slug}`);
    }
  });

  it("builds Live and judging with the game crate at opt-level 1 over the engine and its dependencies at 3 (OPT) without debug assertions or overflow checks (MK), line tables only (R-7), the store prewarm's profile; an export is cargo's release profile with line tables kept in a dSYM (CRASH-7a)", async () => {
    // Flipped from the game crate unoptimized over dependencies at opt-level 1 (K6, OPT): Live runs
    // near release speed, and the game crate's rebuild stays incremental. Flipped again (MK): the
    // dependencies' debug assertions and overflow checks are off, as in an export, the game's kept.
    const liveProfile = [
      "profile.dev.opt-level=1",
      'profile.dev.package."*".opt-level=3',
      'profile.dev.debug="line-tables-only"',
      'profile.dev.package."*".debug-assertions=false',
      'profile.dev.package."*".overflow-checks=false',
    ];
    assert.deepEqual(RUST_DEV_PROFILE_SETTINGS, liveProfile, "the profile the store's prewarm builds with");
    for (const [purpose, expected] of [
      [CppBuildPurpose.Live, liveProfile],
      [CppBuildPurpose.Judging, liveProfile],
      [CppBuildPurpose.Export, EXPORT_DEBUG_SETTINGS[DebugFileKind.Dsym]],
    ] as const) {
      const parent = await realpath(await tmpDir("rust-dev-profile-"));
      const open = openSandboxes();
      const onBuild = 'printf "%s\\n" "$@" > "$CARGO_TARGET_DIR/../build-args"';
      const { builds } = await lane(parent, open.sandbox, { stub: { onBuild } });
      const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, purpose);
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
      const [spec] = open.specs;
      assert.ok(spec);
      const args = (await readFile(path.join(spec.bin, "build-args"), "utf8")).trim().split("\n");
      const profileSettings = args.filter((arg, index) => args[index - 1] === "--config" && arg.startsWith("profile."));
      assert.deepEqual(profileSettings, expected, `${purpose}: ${args.join(" ")}`);
      assert.equal(args.includes("--release"), purpose === CppBuildPurpose.Export);
    }
  });

  it("names cargo's own error, not its progress, when a step fails with no diagnostic", async () => {
    const parent = await realpath(await tmpDir("rust-cargo-error-"));
    const open = openSandboxes();
    const onBuild = [
      'for crate in serde_core libm bytemuck smallvec thiserror byteorder glam; do echo "   Compiling $crate v1.0.0" >&2; done',
      "echo 'error: linking with `cc` failed: exit status: 1' >&2",
      "echo '  = note: ld: library not found' >&2",
      "exit 101",
    ].join("\n");
    const { builds } = await lane(parent, open.sandbox, { stub: { onBuild } });
    const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
    assert.equal(outcome.problem?.code, 101);
    assert.equal(outcome.problem?.lines[0], "error: linking with `cc` failed: exit status: 1");
    assert.deepEqual(outcome.rust?.diagnostics, []);
  });

  it("names the signal that stopped a step that printed nothing (G0: a Windows build killed under a full disk said nothing)", async () => {
    const parent = await realpath(await tmpDir("rust-cargo-killed-"));
    const open = openSandboxes();
    const onBuild = "kill -KILL $$";
    const { builds } = await lane(parent, open.sandbox, { stub: { onBuild } });
    const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
    assert.equal(outcome.problem?.code, null);
    assert.equal(outcome.problem?.lines.length, 1, JSON.stringify(outcome.problem?.lines));
    assert.match(outcome.problem?.lines[0] ?? "", /SIGKILL/);
  });

  it("writes a receipt with each step's timing and the compiler's identity", async () => {
    const parent = await realpath(await tmpDir("rust-receipt-"));
    const open = openSandboxes();
    let clock = 1_000;
    const now = () => {
      clock += 10;
      return clock;
    };
    const { builds } = await lane(parent, open.sandbox, { now });
    const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    const receipt = outcome.rust?.receipt;
    assert.ok(receipt);
    assert.equal(receipt.compiler.release, "1.99.0");
    assert.equal(receipt.compiler.commitHash, "1d4e1a2b3c4d5e6f");
    assert.equal(receipt.compiler.host, "aarch64-apple-darwin");
    assert.equal(receipt.triple, "aarch64-apple-darwin");
    assert.equal(receipt.lock, LOCK.digest);
    assert.deepEqual(
      receipt.steps.map((step) => step.step),
      ["identity", "lock", "clippy", "build"],
    );
    assert.ok(receipt.steps.every((step) => step.ms > 0));
    assert.equal(receipt.outputs.find((file) => file.path === "game")?.sha256, sha256(GAME_BYTES));
  });

  it("tells a Play timing the build where its wait went: the host's own parts, the queue, the seed and each step (PW)", async () => {
    const parent = await realpath(await tmpDir("rust-play-timing-"));
    const open = openSandboxes();
    const { builds } = await lane(parent, open.sandbox);
    const marks: Array<{ stage: PlayStage; detail: string | null; ms: number }> = [];
    const timing: PlayTimingSink = (stage, ms, detail) => marks.push({ stage, ms, detail: detail ?? null });
    const dir = await rustGame(parent);
    const outcome = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Judging, { timing });
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    assert.deepEqual(
      marks.map((mark) => (mark.detail ? `${mark.stage}:${mark.detail}` : mark.stage)),
      [
        "build-step:locate",
        "build-step:sweep",
        "build-queue",
        `build-seed:${RustTargetSeed.Cold}`,
        "build-step:stage",
        "build-step:assets",
        "build-step:identity",
        "build-step:lock",
        "build-step:clippy",
        "build-step:build",
        "build-step:admit",
      ],
    );
    assert.ok(marks.every((mark) => Number.isFinite(mark.ms) && mark.ms >= 0));
    marks.length = 0;
    await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Judging);
    assert.deepEqual(marks, [], "a build nobody times tells nobody");
  });

  it("falls back to the last admitted output only while it is the very one admitted", async () => {
    const parent = await realpath(await tmpDir("rust-last-good-"));
    const open = openSandboxes();
    const { builds } = await lane(parent, open.sandbox, {
      stub: { onClippy: '[ -f "$(dirname "$manifest")/src/broken.rs" ] && exit 101' },
    });
    const dir = await rustGame(parent);
    const first = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(first.ok, true, JSON.stringify(first.problem));
    await writeFile(path.join(dir, "src", "broken.rs"), "nope\n");
    const broken = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(broken.ok, false);
    assert.equal(broken.lastGood, first.output);
    await writeFile(path.join(first.output ?? "", "game"), "swapped");
    const swapped = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(swapped.ok, false);
    assert.equal(swapped.lastGood, null, "an output changed since admission is no output");
  });
});

describe("the Rust lane's sandbox holds a build to its own reads (macOS)", { skip: SKIP_UNLESS_MAC }, () => {
  it("a build-script stand-in cannot read a denied folder (the user's home in the app), while the build still reads its stage and toolchain", async () => {
    const parent = await realpath(await tmpDir("rust-read-deny-"));
    const secrets = path.join(parent, "home");
    await mkdir(secrets);
    const secret = path.join(secrets, "notes.txt");
    await writeFile(secret, "private\n");
    const peek = `if cat '${secret}' > /dev/null 2>&1; then echo read; else echo denied; fi > "$CARGO_TARGET_DIR/../peek"`;
    const sandbox = rustBuildSandboxes({ secretPaths: [], enabled: true, denyRead: [secrets] });
    const { builds, root } = await lane(parent, sandbox, { stub: { onBuild: peek } });
    const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    const [project] = await readdir(root);
    const [folder] = (await readdir(path.join(root, project ?? ""))).filter((name) => !name.includes("."));
    assert.equal((await readFile(path.join(root, project ?? "", folder ?? "", "peek"), "utf8")).trim(), "denied");
  });
});

describe("the Rust lane's sandbox holds a build to its own folder (macOS)", { skip: SKIP_UNLESS_MAC }, () => {
  it("a build-script stand-in cannot write a sibling game, another build, or out/ after the build", async () => {
    const parent = await realpath(await tmpDir("rust-late-writer-"));
    const games = path.join(parent, "games");
    const sibling = await rustGame(games, "sibling");
    const dir = await rustGame(games, "game");
    const pwned = path.join(sibling, "src", "pwned.rs");
    const late = [
      `echo pwned > '${pwned}' 2>/dev/null`,
      // Every other build folder and every admitted out/ beside them, now and once the build is over.
      'for f in "$CARGO_TARGET_DIR"/../../../*/*; do echo "$CARGO_TARGET_DIR" > "$f/pwned" 2>/dev/null; done',
      '( sleep 1; for f in "$CARGO_TARGET_DIR"/../../*.out/game "$CARGO_TARGET_DIR"/../../../*/*.out/game; do echo late > "$f"; done ) >/dev/null 2>&1 &',
    ].join("\n");
    const sandbox = rustBuildSandboxes({ secretPaths: [], enabled: true });
    const { builds, root } = await lane(parent, sandbox, { stub: { onBuild: late } });
    const siblingBuild = await builds.ensure(gameOf(sibling), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(siblingBuild.ok, true, JSON.stringify(siblingBuild.problem));
    const outcome = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    await sleep(1_500);
    await assert.rejects(stat(pwned), "the sibling game is untouched");
    assert.equal(await readFile(path.join(siblingBuild.output ?? "", "game"), "utf8"), GAME_BYTES);
    assert.equal(await readFile(path.join(outcome.output ?? "", "game"), "utf8"), GAME_BYTES);
    for (const project of await readdir(root)) {
      for (const name of await readdir(path.join(root, project))) {
        const folder = path.join(root, project, name);
        const written = await readFile(path.join(folder, "pwned"), "utf8").catch(() => null);
        if (written === null) continue;
        assert.ok(written.trim().startsWith(`${folder}${path.sep}`), `${folder} was written by another build`);
      }
    }
  });
});

describe("the host's admission runs on every Rust lane output before it is out/ (M3.5)", {
  skip: SKIP_ON_WINDOWS,
}, () => {
  /** A file holding `bytes`, for the stub cargo to write as the game. */
  async function exeFile(parent: string, bytes: Buffer): Promise<string> {
    const file = path.join(parent, "exe-bytes");
    await writeFile(file, bytes);
    return file;
  }
  const exists = (at: string) =>
    stat(at).then(
      () => true,
      () => false,
    );

  it("refuses a build whose executable is not the destination's format, typed, and writes no out/", async () => {
    const parent = await realpath(await tmpDir("rust-admit-"));
    const { builds, root } = await lane(parent, openSandboxes().sandbox, { admit: admitRustOutput });
    const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.rust?.refusal, RustBuildRefusal.AdmissionRefused);
    assert.equal(outcome.rust?.admission?.file, "game");
    assert.equal(outcome.rust?.admission?.refusal, NativeRefusal.NotAnExecutable);
    assert.equal(outcome.output, null);
    const outs = (await readdir(root, { recursive: true })).filter((rel) => rel.endsWith(".out"));
    assert.deepEqual(outs, [], "nothing reached out/");
  });

  it("admits a real Mac image, and refuses the studio transport in an export", async () => {
    const parent = await realpath(await tmpDir("rust-admit-"));
    const exeFrom = await exeFile(parent, macBinary());
    const { builds } = await lane(parent, openSandboxes().sandbox, { admit: admitRustOutput, stub: { exeFrom } });
    const game = gameOf(await rustGame(parent));
    const live = await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(live.ok, true, JSON.stringify(live.problem));
    assert.ok(await exists(path.join(live.output ?? "", "game")));

    const marked = path.join(await realpath(await tmpDir("rust-admit-")), "x");
    await mkdir(marked);
    const transported = await exeFile(marked, macBinary({ trailer: "genex_studio9transport" }));
    const exportLane = await lane(marked, openSandboxes().sandbox, {
      admit: admitRustOutput,
      stub: { exeFrom: transported },
    });
    const exported = await exportLane.builds.ensure(
      gameOf(await rustGame(marked)),
      BuildTarget.Mac,
      CppBuildPurpose.Export,
    );
    assert.equal(exported.ok, false);
    assert.equal(exported.rust?.admission?.problem, RustAdmissionProblem.TransportLinked);
    const dev = await exportLane.builds.ensure(
      gameOf(await rustGame(marked, "dev")),
      BuildTarget.Mac,
      CppBuildPurpose.Live,
    );
    assert.equal(dev.ok, true, "a dev build serving the studio may carry the transport");
  });

  it("keeps the last admitted out/ when a rebuild is refused", async () => {
    const parent = await realpath(await tmpDir("rust-admit-"));
    const good = await exeFile(parent, macBinary());
    const { builds } = await lane(parent, openSandboxes().sandbox, { admit: admitRustOutput, stub: { exeFrom: good } });
    const game = gameOf(await rustGame(parent));
    const first = await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(first.ok, true, JSON.stringify(first.problem));
    const before = await readFile(path.join(first.output ?? "", "game"));
    await writeFile(good, "#!/bin/sh\necho swapped\n");
    await writeFile(path.join(game.dir, "src", "main.rs"), "fn main() { /* changed */ }\n");
    const second = await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(second.ok, false);
    assert.equal(second.rust?.refusal, RustBuildRefusal.AdmissionRefused);
    assert.deepEqual(await readFile(path.join(first.output ?? "", "game")), before, "the admitted bytes stay");
  });
});

describe("the lane's sweep keeps the build folders of every lock a game recorded (M6 review)", () => {
  const CURRENT = "c".repeat(64);
  const RECORDED = "a".repeat(64);
  const UNREFERENCED = "e".repeat(64);

  /** A build root with one game folder holding a Mac build of each lock, each stamped with a live source. */
  async function builtOnThreeLocks() {
    const parent = await tmpDir("rust-sweep-");
    const source = path.join(parent, "pond");
    await mkdir(source);
    const project = path.join(parent, "rust-builds", `pond-${"1".repeat(12)}`);
    for (const digest of [CURRENT, RECORDED, UNREFERENCED]) {
      const bin = path.join(project, `macos-${digest.slice(0, 12)}`);
      await mkdir(bin, { recursive: true });
      await writeFile(`${bin}.source`, source);
    }
    return { root: path.join(parent, "rust-builds"), project };
  }

  function sweeper(root: string, retainedLocks?: () => Promise<readonly string[]>) {
    return new RustBuilds({
      root,
      sandbox: async () => assert.fail("the sweep builds nothing"),
      locate: async () => assert.fail("the sweep locates nothing"),
      currentLock: async () => ({ ...LOCK, digest: CURRENT }),
      stage: async () => assert.fail("the sweep stages nothing"),
      emit: () => {},
      platform: "darwin",
      cores: 8,
      denyWrite: [],
      writeLock: async () => {},
      ...(retainedLocks ? { retainedLocks } : {}),
    });
  }

  const left = async (project: string) => (await readdir(project)).filter((name) => !name.endsWith(".source")).sort();

  it("keeps the current lock's and a recorded lock's folders, and removes only the unreferenced lock's", async () => {
    const { root, project } = await builtOnThreeLocks();
    assert.equal(await sweeper(root, async () => [RECORDED]).sweep(), 1);
    assert.deepEqual(await left(project), [`macos-${RECORDED.slice(0, 12)}`, `macos-${CURRENT.slice(0, 12)}`].sort());
  });

  it("a library it cannot read keeps every lock's folders", async () => {
    const { root, project } = await builtOnThreeLocks();
    assert.equal(
      await sweeper(root, async () => {
        throw new Error("the library is unreadable");
      }).sweep(),
      0,
    );
    assert.equal((await left(project)).length, 3);
  });

  it("with no recorded locks, a lock other than the current one is swept, as before (characterization)", async () => {
    const { root, project } = await builtOnThreeLocks();
    assert.equal(await sweeper(root).sweep(), 2);
    assert.deepEqual(await left(project), [`macos-${CURRENT.slice(0, 12)}`]);
  });
});

describe("the Rust lane starts a new build folder from the store's prewarm (R-7)", { skip: SKIP_ON_WINDOWS }, () => {
  it("starts a build folder's first build from the store's prewarmed target folder, once (R-7)", async () => {
    const parent = await realpath(await tmpDir("rust-warm-target-"));
    const open = openSandboxes();
    const calls: { lock: string; target: BuildTarget; to: string }[] = [];
    const warmTarget: RustBuildsOptions["warmTarget"] = async (lock, target, to) => {
      calls.push({ lock: lock.digest, target, to });
      await mkdir(path.join(to, "debug"), { recursive: true });
      await writeFile(path.join(to, "debug", "warm"), "prewarmed");
      return true;
    };
    const onBuild = 'cat "$CARGO_TARGET_DIR/debug/warm" > "$CARGO_TARGET_DIR/../saw-warm" || true';
    const { builds } = await lane(parent, open.sandbox, { stub: { onBuild }, warmTarget });
    const game = gameOf(await rustGame(parent));
    const first = await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(first.ok, true, JSON.stringify(first.problem));
    const [spec] = open.specs;
    assert.ok(spec);
    assert.deepEqual(calls, [{ lock: LOCK.digest, target: BuildTarget.Mac, to: path.join(spec.bin, "target") }]);
    assert.equal(await readFile(path.join(spec.bin, "saw-warm"), "utf8"), "prewarmed", "cargo ran over the clone");
    await writeFile(path.join(game.dir, "src", "main.rs"), "fn main() { let _ = 1; }\n");
    const second = await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(second.ok, true, JSON.stringify(second.problem));
    assert.equal(calls.length, 1, "a folder that has its own target keeps it");
  });

  it("builds from an empty target folder of its own when the prewarm clone fails or plants a link, touching nothing outside (R-7)", async () => {
    const outside = await realpath(await tmpDir("rust-warm-outside-"));
    await writeFile(path.join(outside, "keep"), "kept");
    const hostile: [string, NonNullable<RustBuildsOptions["warmTarget"]>][] = [
      ["refused", async () => false],
      [
        "throws",
        async () => {
          throw new Error("clone failed");
        },
      ],
      [
        "plants a link",
        async (_lock, _target, to) => {
          await symlink(outside, to);
          return true;
        },
      ],
      [
        "plants a file",
        async (_lock, _target, to) => {
          await writeFile(to, "not a folder");
          return true;
        },
      ],
    ];
    for (const [label, warmTarget] of hostile) {
      const parent = await realpath(await tmpDir("rust-warm-hostile-"));
      const open = openSandboxes();
      const { builds } = await lane(parent, open.sandbox, { warmTarget });
      const outcome = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
      assert.equal(outcome.ok, true, `${label}: ${JSON.stringify(outcome.problem)}`);
      const [spec] = open.specs;
      assert.ok(spec);
      const target = await lstat(path.join(spec.bin, "target"));
      assert.equal(target.isDirectory() && !target.isSymbolicLink(), true, `${label}: a real folder of its own`);
      assert.deepEqual(await readdir(outside), ["keep"], `${label}: nothing written outside`);
      assert.equal(await readFile(path.join(outside, "keep"), "utf8"), "kept", label);
    }
  });
});

describe("copies of a game reuse its compiled engine instead of rebuilding it (BC)", { skip: SKIP_ON_WINDOWS }, () => {
  /**
   * The stub's build as cargo meets a target folder: the engine's unit is reused when the target
   * holds it, else compiled into it; what it did, and which target it built in, go to `$TMPDIR/saw`.
   * A build folder holding `gate` waits for `gate.open` first, so a test can hold one build open.
   */
  const ENGINE_BUILD = [
    'bin=$(dirname "$TMPDIR")',
    'if [ -f "$bin/gate" ]; then while [ ! -f "$bin/gate.open" ]; do sleep 0.05; done; fi',
    'if [ -n "$LOG" ]; then echo "start $bin" >> "$LOG"; fi',
    'if [ -f "$CARGO_TARGET_DIR/debug/engine" ]; then saw=reused; else saw=compiled; mkdir -p "$CARGO_TARGET_DIR/debug"; echo engine > "$CARGO_TARGET_DIR/debug/engine"; fi',
    'printf "%s %s" "$saw" "$CARGO_TARGET_DIR" > "$TMPDIR/saw"',
    'if [ -n "$LOG" ]; then sleep 0.2; echo "end $bin" >> "$LOG"; fi',
  ].join("\n");

  /** Two copies of one game (a game folder and a worker's copy), and another game. */
  async function copies(parent: string) {
    const first = gameOf(await rustGame(path.join(parent, "games")));
    const second = gameOf(await rustGame(path.join(parent, "worktrees", "w1")));
    const other = { ...gameOf(await rustGame(path.join(parent, "games"), "lake")) };
    return { first, second, other };
  }

  /** What a build saw of its target, read from its folder. */
  async function saw(outcome: { output: string | null }): Promise<{ saw: string; target: string }> {
    assert.ok(outcome.output);
    const bin = outcome.output.slice(0, -".out".length);
    const [what = "", target = ""] = (await readFile(path.join(bin, "tmp", "saw"), "utf8")).split(" ");
    return { saw: what, target };
  }

  /** A host that clones (APFS, btrfs, XFS), file by file as copies; every file recorded, and held while `hold` is set. */
  function cloning() {
    const calls: { from: string; to: string }[] = [];
    const state: { hold: Promise<void> | null; failAfter: number | null } = { hold: null, failAfter: null };
    const cloneFile = async (from: string, to: string) => {
      calls.push({ from, to });
      if (state.hold) await state.hold;
      if (state.failAfter !== null && calls.length > state.failAfter) throw new Error("the disk is full");
      await copyFile(from, to);
    };
    const cloner: TreeCloner = {
      supported: async () => true,
      clone: (from, to) => cloneTreeByFile(from, to, cloneFile),
    };
    return { cloner, calls, state };
  }

  it("a copy's first build starts from a clone of the first copy's target, and only the game recompiles", async () => {
    const parent = await realpath(await tmpDir("rust-copy-seed-"));
    const open = openSandboxes();
    const { cloner, calls } = cloning();
    const warmed: string[] = [];
    const warmTarget: RustBuildsOptions["warmTarget"] = async (_lock, _target, to) => {
      warmed.push(to);
      return false;
    };
    const { builds, root } = await lane(parent, open.sandbox, { stub: { onBuild: ENGINE_BUILD }, cloner, warmTarget });
    const { first, second } = await copies(parent);
    const built = await builds.ensure(first, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    assert.equal((await saw(built)).saw, "compiled");
    assert.deepEqual(built.rust?.receipt?.cache, { sharing: RustTargetSharing.Clone, seed: RustTargetSeed.Cold });
    const probes = calls.length;
    const copy = await builds.ensure(second, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(copy.ok, true, JSON.stringify(copy.problem));
    assert.equal((await saw(copy)).saw, "reused", "the engine was not compiled again");
    assert.deepEqual(copy.rust?.receipt?.cache, { sharing: RustTargetSharing.Clone, seed: RustTargetSeed.Copy });
    const firstBin = (built.output ?? "").slice(0, -".out".length);
    const copyBin = (copy.output ?? "").slice(0, -".out".length);
    const clones = calls.slice(probes);
    assert.ok(clones.length > 0);
    for (const { from, to } of clones) {
      assert.ok(from.startsWith(path.join(firstBin, "target") + path.sep), from);
      assert.ok(to.startsWith(path.join(copyBin, "target") + path.sep), to);
    }
    assert.equal(warmed.length, 1, "the copy took no prewarm: it had a donor");
    assert.equal(path.dirname(path.dirname(copyBin)), root);
  });

  it("never seeds a copy from another game or another lock", async () => {
    const parent = await realpath(await tmpDir("rust-copy-other-"));
    const open = openSandboxes();
    const { cloner, calls } = cloning();
    const { builds } = await lane(parent, open.sandbox, { stub: { onBuild: ENGINE_BUILD }, cloner });
    const { first, second, other } = await copies(parent);
    assert.equal((await builds.ensure(first, BuildTarget.Mac, CppBuildPurpose.Live)).ok, true);
    const probes = calls.length;
    const lake = await builds.ensure(other, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal((await saw(lake)).saw, "compiled");
    const newer: ToolchainLock = { ...LOCK, digest: "fedcba9876543210".repeat(4) };
    const relocked = await builds.ensure({ ...second, lock: newer }, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(relocked.ok, true, JSON.stringify(relocked.problem));
    assert.equal((await saw(relocked)).saw, "compiled");
    assert.equal(calls.length, probes, "nothing was cloned");
  });

  it("never clones a copy that is building, and a copy being cloned from builds only once the clone is done", async () => {
    const parent = await realpath(await tmpDir("rust-copy-busy-"));
    const open = openSandboxes();
    const { cloner, calls, state } = cloning();
    const log = path.join(parent, "log");
    const { builds } = await lane(parent, open.sandbox, {
      stub: { onBuild: `LOG=${shellWord(log)}\n${ENGINE_BUILD}` },
      cloner,
    });
    const { first, second } = await copies(parent);
    const built = await builds.ensure(first, BuildTarget.Mac, CppBuildPurpose.Live);
    const firstBin = (built.output ?? "").slice(0, -".out".length);
    await writeFile(path.join(firstBin, "gate"), "");
    const rebuilding = builds.ensure(first, BuildTarget.Mac, CppBuildPurpose.Live);
    const probes = calls.length;
    const copy = await builds.ensure(second, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal((await saw(copy)).saw, "compiled", "the busy copy lent nothing");
    assert.equal(calls.length, probes);
    await writeFile(path.join(firstBin, "gate.open"), "");
    assert.equal((await rebuilding).ok, true);

    const third = gameOf(await rustGame(path.join(parent, "worktrees", "w2")));
    let release = () => {};
    state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await writeFile(log, "");
    const cloned = builds.ensure(third, BuildTarget.Mac, CppBuildPurpose.Live);
    for (let tries = 0; calls.length === probes && tries < 300; tries++) await sleep(10);
    assert.notEqual(calls.length, probes, "the third copy clones the donor's target");
    // The game folder's build was admitted last: it is the donor, and its next build waits for the clone.
    const donorRebuild = builds.ensure(first, BuildTarget.Mac, CppBuildPurpose.Live);
    await sleep(300);
    assert.equal(await readFile(log, "utf8"), "", "the donor's cargo did not run while its target was being cloned");
    release();
    state.hold = null;
    const results = await Promise.all([cloned, donorRebuild]);
    for (const outcome of results) assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    assert.equal((await saw(results[0])).saw, "reused");
  });

  it("a clone that fails builds the copy from nothing, leaving no part of the clone", async () => {
    const parent = await realpath(await tmpDir("rust-copy-failed-"));
    const open = openSandboxes();
    const { cloner, calls, state } = cloning();
    const { builds } = await lane(parent, open.sandbox, { stub: { onBuild: ENGINE_BUILD }, cloner });
    const { first, second } = await copies(parent);
    const built = await builds.ensure(first, BuildTarget.Mac, CppBuildPurpose.Live);
    await writeFile(path.join((built.output ?? "").slice(0, -".out".length), "target", "debug", "second"), "two");
    state.failAfter = calls.length + 1;
    const copy = await builds.ensure(second, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(copy.ok, true, JSON.stringify(copy.problem));
    assert.equal((await saw(copy)).saw, "compiled");
    assert.deepEqual(copy.rust?.receipt?.cache, { sharing: RustTargetSharing.Clone, seed: RustTargetSeed.Cold });
    const target = path.join((copy.output ?? "").slice(0, -".out".length), "target", "debug");
    assert.deepEqual((await readdir(target)).sort(), ["engine"], "only what the cold build wrote");
  });

  it("a donor whose target holds a link (cargo's dSYM link after a Mac export) lends nothing; the next freshest copy does (LK)", async () => {
    const parent = await realpath(await tmpDir("rust-copy-linked-"));
    const open = openSandboxes();
    const { cloner } = cloning();
    const { builds } = await lane(parent, open.sandbox, { stub: { onBuild: ENGINE_BUILD }, cloner });
    const { first, second } = await copies(parent);
    assert.equal((await builds.ensure(first, BuildTarget.Mac, CppBuildPurpose.Live)).ok, true);
    const fresher = await builds.ensure(second, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(fresher.ok, true, JSON.stringify(fresher.problem));
    const fresherTarget = path.join((fresher.output ?? "").slice(0, -".out".length), "target", "debug");
    await symlink(path.join(fresherTarget, "engine"), path.join(fresherTarget, "game.dSYM"));
    const third = gameOf(await rustGame(path.join(parent, "worktrees", "w2")));
    const copy = await builds.ensure(third, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(copy.ok, true, JSON.stringify(copy.problem));
    assert.deepEqual(copy.rust?.receipt?.cache, { sharing: RustTargetSharing.Clone, seed: RustTargetSeed.Copy });
    assert.equal((await saw(copy)).saw, "reused", "the engine was not compiled again");
  });

  it("a new build folder first sweeps the copies whose source is gone, never the donor or the one building (LK)", async () => {
    const parent = await realpath(await tmpDir("rust-copy-sweep-"));
    const open = openSandboxes();
    const { cloner } = cloning();
    const { builds } = await lane(parent, open.sandbox, { stub: { onBuild: ENGINE_BUILD }, cloner });
    const { first, second } = await copies(parent);
    const kept = await builds.ensure(first, BuildTarget.Mac, CppBuildPurpose.Live);
    const removed = await builds.ensure(second, BuildTarget.Mac, CppBuildPurpose.Live);
    const removedBin = (removed.output ?? "").slice(0, -".out".length);
    // A playtest or integration copy the run removed itself: no worktree hook told the host.
    await rm(second.dir, { recursive: true, force: true });
    const third = gameOf(await rustGame(path.join(parent, "worktrees", "w2")));
    const copy = await builds.ensure(third, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(copy.ok, true, JSON.stringify(copy.problem));
    assert.equal(await lstat(path.dirname(removedBin)).catch(() => null), null, "the gone copy's folders went");
    assert.equal((await lstat(kept.output ?? "")).isDirectory(), true, "the live copy's output stays");
    assert.equal(copy.rust?.receipt?.cache?.seed, RustTargetSeed.Copy, "the copy still cloned the live one");
  });

  it("the admitted executable is a clone of cargo's where the host clones, a copy where a clone fails (LK)", async () => {
    const parent = await realpath(await tmpDir("rust-exe-clone-"));
    const open = openSandboxes();
    const { cloner } = cloning();
    const cloned: { from: string; to: string }[] = [];
    const state = { fail: false };
    const withFile: TreeCloner = {
      ...cloner,
      cloneFile: async (from, to) => {
        cloned.push({ from, to });
        if (state.fail) throw new Error("clonefile failed");
        await copyFile(from, to);
      },
    };
    const { builds } = await lane(parent, open.sandbox, { cloner: withFile });
    const game = gameOf(await rustGame(parent));
    const built = await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    const bin = (built.output ?? "").slice(0, -".out".length);
    assert.deepEqual(
      cloned.map(({ to }) => to),
      ["game", "game-headless"].map((name) => path.join(`${bin}.out.new`, name)),
      "each of the Mac builder's names",
    );
    for (const { from } of cloned) assert.ok(from.startsWith(path.join(bin, "target") + path.sep), from);
    state.fail = true;
    await writeFile(path.join(game.dir, "src", "main.rs"), "fn main() { /* changed */ }\n");
    const again = await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(again.ok, true, JSON.stringify(again.problem));
    assert.equal(await readFile(path.join(again.output ?? "", "game"), "utf8"), "#!/bin/sh\necho game\n");
  });

  it("a host that cannot clone builds every copy of a game in one shared target, one build at a time", async () => {
    const parent = await realpath(await tmpDir("rust-copy-shared-"));
    const open = openSandboxes();
    const log = path.join(parent, "log");
    // ext4, NTFS or a Windows host: no clones.
    const cloner: TreeCloner = {
      supported: async () => false,
      clone: async () => assert.fail("a host that cannot clone clones nothing"),
    };
    const { builds, root } = await lane(parent, open.sandbox, {
      stub: { onBuild: `LOG=${shellWord(log)}\n${ENGINE_BUILD}` },
      cloner,
    });
    const { first, second, other } = await copies(parent);
    const [a, b, lake] = await Promise.all([
      builds.ensure(first, BuildTarget.Mac, CppBuildPurpose.Live),
      builds.ensure(second, BuildTarget.Mac, CppBuildPurpose.Live),
      builds.ensure(other, BuildTarget.Mac, CppBuildPurpose.Live),
    ]);
    for (const outcome of [a, b, lake]) assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    const [sawA, sawB, sawLake] = await Promise.all([saw(a), saw(b), saw(lake)]);
    const shared = path.join(root, "shared", "game-targets", `macos-${LOCK.digest.slice(0, 12)}`);
    assert.equal(sawA.target, shared);
    assert.equal(sawB.target, shared);
    assert.equal(sawLake.target, path.join(root, "shared", "lake-targets", `macos-${LOCK.digest.slice(0, 12)}`));
    assert.deepEqual([sawA.saw, sawB.saw].sort(), ["compiled", "reused"], "the second copy reused the first's engine");
    assert.deepEqual(b.rust?.receipt?.cache?.sharing, RustTargetSharing.Shared);
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    const ours = lines.filter((line) => !line.includes(path.join(parent, "rust-builds", "lake-")));
    assert.equal(ours.length, 4);
    assert.ok(ours[0]?.startsWith("start ") && ours[1]?.startsWith("end "), ours.join("\n"));
    assert.equal(
      ours[0]?.slice("start ".length),
      ours[1]?.slice("end ".length),
      "a copy's build ended before the next began",
    );
    for (const spec of open.specs.filter((s) => !s.bin.includes(`${path.sep}lake-`))) {
      assert.ok(spec.allowWrite.includes(shared), "the build may write the shared target");
      assert.equal(await lstat(path.join(spec.bin, "target")).catch(() => null), null, "no target of its own");
    }
  });

  it("starts every command with RUSTC_BOOTSTRAP cleared, as the store's prewarm built it, so the prewarm's units match", async () => {
    const parent = await realpath(await tmpDir("rust-bootstrap-"));
    const open = openSandboxes({ RUSTC_BOOTSTRAP: "1" });
    const onBuild =
      'if [ "${RUSTC_BOOTSTRAP+set}" = set ] && [ -z "$RUSTC_BOOTSTRAP" ]; then echo cleared > "$TMPDIR/bootstrap"; fi';
    const { builds } = await lane(parent, open.sandbox, { stub: { onBuild } });
    const built = await builds.ensure(gameOf(await rustGame(parent)), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    const bin = (built.output ?? "").slice(0, -".out".length);
    assert.equal(await readFile(path.join(bin, "tmp", "bootstrap"), "utf8"), "cleared\n");
  });
});

describe("the person's Play never queues behind agents' builds (PW incident)", { skip: SKIP_ON_WINDOWS }, () => {
  /**
   * A lane with one build slot (4 cores) whose stub cargo holds every build of a game named
   * `agent-*` until `gate` exists: a run's judged builds hold the slot while the person presses Play.
   */
  async function heldLane(parent: string, cloner: TreeCloner | null | undefined = undefined) {
    const gate = path.join(parent, "gate");
    const onBuild = `case "$manifest" in *${path.sep}agent-*) while [ ! -f ${shellWord(gate)} ]; do sleep 0.05; done ;; esac`;
    const open = openSandboxes();
    const { builds } = await lane(parent, open.sandbox, {
      stub: { onBuild },
      cores: 4,
      ...(cloner === undefined ? {} : { cloner }),
    });
    return { builds, open, release: () => writeFile(gate, "go") };
  }

  /** Whether `promise` has settled after the event loop has had `ms` to run. */
  async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await sleep(ms);
    return settled;
  }

  it("a person's Live build starts while agents' judged builds hold every slot and wait for more (the Opening… wait)", async () => {
    const parent = await realpath(await tmpDir("rust-person-slot-"));
    const { builds, release } = await heldLane(parent);
    const first = builds.ensure(gameOf(await rustGame(parent, "agent-a")), BuildTarget.Mac, CppBuildPurpose.Judging);
    const second = builds.ensure(gameOf(await rustGame(parent, "agent-b")), BuildTarget.Mac, CppBuildPurpose.Judging);
    const person = builds.ensure(gameOf(await rustGame(parent, "played")), BuildTarget.Mac, CppBuildPurpose.Live);
    try {
      assert.equal(await settledWithin(person, 3_000), true, "the person's build waited behind the agents'");
      assert.equal((await person).ok, true, JSON.stringify((await person).problem));
      assert.equal(await settledWithin(first, 0), false, "the agents' builds are still held");
    } finally {
      await release();
    }
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
  });

  it("a background Play build runs after the agents' queued builds, at a lower CPU priority, and never in the person's slot", async () => {
    const parent = await realpath(await tmpDir("rust-background-slot-"));
    const { builds, open, release } = await heldLane(parent);
    const order: string[] = [];
    const track = (name: string, building: Promise<{ ok: boolean }>) =>
      building.then((outcome) => {
        order.push(name);
        return outcome;
      });
    const held = track(
      "agent-a",
      builds.ensure(gameOf(await rustGame(parent, "agent-a")), BuildTarget.Mac, CppBuildPurpose.Judging),
    );
    await sleep(200);
    const background = track(
      "background",
      builds.ensure(gameOf(await rustGame(parent, "prebuilt")), BuildTarget.Mac, CppBuildPurpose.Live, {
        priority: BuildPriority.Background,
      }),
    );
    const queued = track(
      "agent-b",
      builds.ensure(gameOf(await rustGame(parent, "agent-b")), BuildTarget.Mac, CppBuildPurpose.Judging),
    );
    assert.equal(
      await settledWithin(background, 1_000),
      false,
      "the background build took no slot while agents hold it",
    );
    await release();
    await Promise.all([held, background, queued]);
    assert.deepEqual(order, ["agent-a", "agent-b", "background"]);
    const niced = open.requests.filter((request) => request.label?.startsWith("rust:prebuilt:"));
    assert.ok(niced.length > 0);
    for (const request of niced) assert.match(request.command, /^exec '\/usr\/bin\/nice' '-n' '10' '\/usr\/bin\/env' /, request.command);
    const agents = open.requests.filter((request) => request.label?.startsWith("rust:agent-"));
    for (const request of agents) assert.doesNotMatch(request.command, /\/usr\/bin\/nice/);
  });

  it("on a host that cannot clone, the person's build of a copy goes before the agents' copies waiting for the game's shared target", async () => {
    const parent = await realpath(await tmpDir("rust-person-shared-"));
    const { builds, release } = await heldLane(parent, null);
    const order: string[] = [];
    const copy = async (name: string, purpose: CppBuildPurpose) => {
      const dir = await rustGame(path.join(parent, name), "agent-game");
      const outcome = await builds.ensure(gameOf(dir), BuildTarget.Mac, purpose);
      order.push(name);
      return outcome;
    };
    const first = copy("one", CppBuildPurpose.Judging);
    await sleep(300);
    const second = copy("two", CppBuildPurpose.Judging);
    await sleep(100);
    const person = copy("played", CppBuildPurpose.Live);
    await sleep(300);
    await release();
    await Promise.all([first, second, person]);
    assert.deepEqual(order, ["one", "played", "two"], "the shared target goes to the person's build next");
  });
});

/**
 * An export's debug files (CRASH-7a, `src/substrate/rust-debug-files.ts`): the release-profile
 * settings per destination, the kept `<bin>.debug/<digest>/` folders with their prune, the hostile
 * table for the folder's links (no side effect), and the lane rows over a stub cargo: an export
 * keeps a dSYM or the unstripped executable outside `out/` and ships none of it; the web export's
 * `wasm-opt --symbolmap` writes outside the served folder.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { GameBuildGame } from "../../src/main/game-build.ts";
import {
  RustBuilds,
  type RustBuildSandbox,
  type RustBuildSandboxSpec,
  type RustBuildsOptions,
  type RustStaged,
  type RustToolchain,
} from "../../src/main/rust-build.ts";
import { packageWeb, RustWebStep, WEB_FILES, type WebRun } from "../../src/main/rust-build-web.ts";
import { RustBuildRefusal } from "../../src/main/rust-build-diagnostics.ts";
import { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { BuildTarget, type GameDestinations, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import {
  DEBUG_BUILDS_KEPT,
  DEBUG_INDEX_FILE,
  DebugFileKind,
  debugFileKind,
  debugRootOf,
  EXPORT_DEBUG_SETTINGS,
  keepDebugFiles,
  keptDebugBuild,
  WEB_SYMBOL_MAP_FILE,
} from "../../src/substrate/rust-debug-files.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import type { XcodeExec } from "../../src/substrate/toolchain-store/locate.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SKIP_ON_WINDOWS = process.platform === "win32" ? "the stub cargo is a POSIX shell script" : false;
const LOCK: ToolchainLock = {
  version: 1,
  entries: { rust: { version: "1.99.0", sha12: "0123456789ab" } },
  digest: "0123456789abcdef".repeat(4),
};
const HOST = "aarch64-apple-darwin";
const RUSTC_VV = `rustc 1.99.0 (1d4e1a2b3 2026-09-17)\nbinary: rustc\ncommit-hash: 1d4e1a2b3c4d5e6f\nhost: ${HOST}\nrelease: 1.99.0\nLLVM version: 21.1.2`;
const LOCK_FILE =
  'version = 4\n\n[[package]]\nname = "game"\nversion = "0.0.0"\ndependencies = ["genex"]\n\n[[package]]\nname = "genex"\nversion = "0.1.0"\n';
/** The executable the stub build writes: its debug lines are what a strip removes. */
const UNSTRIPPED = "#!/bin/sh\necho game\n# debug: .debug_line\n";
const STRIPPED = "#!/bin/sh\necho game\n";
const DWARF = "dwarf line tables";
const MAC_SDK = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";
/** The suffixes of a debug file: none may be in a shipped folder. */
const DEBUG_SUFFIXES = [".dSYM", ".dwp", ".pdb", ".symbols"];
const ANDROID_BUILDER = {
  ready: true,
  triple: "aarch64-linux-android",
  macSdk: false,
  executables: ["game"],
  assets: true,
} as const;

const xcode: XcodeExec = async (file) =>
  file.endsWith("xcode-select")
    ? { code: 0, stdout: "/Library/Developer/CommandLineTools\n", stderr: "" }
    : { code: 0, stdout: `${MAC_SDK}\n`, stderr: "" };

const shellWord = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const digestOf = (n: number): string => sha256(`build ${n}`);

/**
 * The stub cargo: writes the lock, passes clippy and, for a build, records its arguments, writes
 * the executable at a cargo-like place with a dSYM in `deps/` and a link to it beside the
 * executable (as cargo uplifts one), and reports the artifact.
 */
function stubCargo(): string {
  const artifact =
    '{"reason":"compiler-artifact","package_id":"path+file://STAGE#game@0.0.0","manifest_path":"MANIFEST",' +
    '"target":{"kind":["bin"],"crate_types":["bin"],"name":"game"},"filenames":["EXE"],"executable":"EXE","fresh":false}';
  return `#!/bin/sh
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
    printf '%s' ${shellWord(LOCK_FILE)} > "$(dirname "$manifest")/Cargo.lock"
    ;;
  clippy)
    echo '{"reason":"build-finished","success":true}'
    ;;
  build)
    printf "%s\\n" "$@" > "$CARGO_TARGET_DIR/../build-args"
    rel="$CARGO_TARGET_DIR/aarch64-apple-darwin/release"
    mkdir -p "$rel/deps/game-5d41.dSYM/Contents/Resources/DWARF"
    printf '%s' ${shellWord(DWARF)} > "$rel/deps/game-5d41.dSYM/Contents/Resources/DWARF/game-5d41"
    ln -sfn deps/game-5d41.dSYM "$rel/game.dSYM"
    exe="$rel/game"
    printf '%s' ${shellWord(UNSTRIPPED)} > "$exe"
    chmod +x "$exe"
    echo '${artifact}' | sed -e "s#STAGE#$(dirname "$manifest")#" -e "s#MANIFEST#$manifest#" -e "s#EXE#$exe#g"
    echo '{"reason":"build-finished","success":true}'
    ;;
esac
exit 0
`;
}

/** A stub `llvm-objcopy --strip-debug <from> <to>`: copies without the debug line. */
const STUB_OBJCOPY = `#!/bin/sh\n[ "$1" = --strip-debug ] || exit 2\ngrep -v '^# debug' "$2" > "$3"\n`;

async function writeToolchain(root: string, objcopy: string | null): Promise<RustToolchain> {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "cargo"), stubCargo(), { mode: 0o755 });
  await writeFile(path.join(bin, "rustc"), `#!/bin/sh\nprintf '%s\\n' ${shellWord(RUSTC_VV)}\n`, { mode: 0o755 });
  if (objcopy !== null) {
    const tools = path.join(root, "lib", "rustlib", HOST, "bin");
    await mkdir(tools, { recursive: true });
    await writeFile(path.join(tools, "llvm-objcopy"), objcopy, { mode: 0o755 });
  }
  const vendor = path.join(root, "vendor");
  await mkdir(vendor, { recursive: true });
  const clippyConf = path.join(root, "clippy");
  await mkdir(clippyConf, { recursive: true });
  await writeFile(path.join(clippyConf, "clippy.toml"), "\n");
  return { bin, vendor, clippyConf, reads: [root] };
}

async function runShell(request: RunRequest): Promise<RunResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", request.command], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
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

/** A lane over a stub toolchain whose sandbox runs commands uncontained, recording each spec and command. */
async function lane(parent: string, options: { objcopy?: string | null; now?: () => number } = {}) {
  const objcopy = options.objcopy === undefined ? STUB_OBJCOPY : options.objcopy;
  const toolchain = await writeToolchain(path.join(parent, "toolchain"), objcopy);
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
  const stage = async (game: { dir: string }, into: string): Promise<RustStaged> => {
    await mkdir(path.join(into, "src"), { recursive: true });
    await writeFile(path.join(into, "src", "main.rs"), await readFile(path.join(game.dir, "src", "main.rs")));
    const manifest =
      '[package]\nname = "game"\nversion = "0.0.0"\nedition = "2024"\n\n[dependencies]\ngenex = "=0.1.0"\n';
    await writeFile(path.join(into, "Cargo.toml"), manifest);
    return { ok: true, dependencies: ["genex"] };
  };
  const laneOptions: RustBuildsOptions = {
    root: path.join(parent, "rust-builds"),
    sandbox,
    locate: async () => ({ ok: true, toolchain }),
    currentLock: async () => LOCK,
    stage,
    emit: () => {},
    platform: "darwin",
    cores: 8,
    denyWrite: [],
    writeLock: async () => {},
    exec: xcode,
    builders: { [BuildTarget.Android]: ANDROID_BUILDER },
    ...(options.now ? { now: options.now } : {}),
  };
  return { builds: new RustBuilds(laneOptions), specs, commands };
}

async function rustGame(parent: string): Promise<GameBuildGame> {
  const dir = path.join(parent, "game");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "genex.toml"), '[game]\ntitle = "Game"\n');
  await writeFile(path.join(dir, "src", "main.rs"), "fn main() {}\n");
  const destinations: GameDestinations = { stack: GameStack.RustWgpu, targets: [BuildTarget.Mac, BuildTarget.Android] };
  const shape = { entry: "index.html", main: "src/main.rs", build: null, install: null, own: false };
  return { project: "game", dir, shape: { ...shape, kind: ProjectKind.RustWgpu, serve: "." }, destinations };
}

/** The `--config profile.*` values of the recorded cargo build. */
async function profileSettings(bin: string): Promise<string[]> {
  const args = (await readFile(path.join(bin, "build-args"), "utf8")).trim().split("\n");
  return args.filter((arg, index) => args[index - 1] === "--config" && arg.startsWith("profile."));
}

/** Every entry under `dir`, `/`-separated, never through a link. */
async function walk(dir: string, rel = ""): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    names.push(child);
    if (entry.isDirectory()) names.push(...(await walk(dir, child)));
  }
  return names;
}

const shippedDebug = (names: readonly string[]): string[] =>
  names.filter((name) => DEBUG_SUFFIXES.some((suffix) => name.split("/").some((part) => part.endsWith(suffix))));

describe("an export's debug-file settings per destination", () => {
  it("Apple packs a dSYM and strips the debug map; ELF and PE keep line tables to strip on the host; the web sets nothing", () => {
    const table = [
      ["aarch64-apple-darwin", DebugFileKind.Dsym],
      ["aarch64-apple-ios", DebugFileKind.Dsym],
      ["aarch64-apple-ios-sim", DebugFileKind.Dsym],
      ["aarch64-linux-android", DebugFileKind.Unstripped],
      ["x86_64-unknown-linux-gnu", DebugFileKind.Unstripped],
      ["x86_64-pc-windows-gnullvm", DebugFileKind.Unstripped],
      ["wasm32-unknown-unknown", DebugFileKind.SymbolMap],
    ] as const;
    for (const [triple, kind] of table) assert.equal(debugFileKind(triple), kind, triple);
    assert.deepEqual(EXPORT_DEBUG_SETTINGS[DebugFileKind.Dsym], [
      'profile.release.debug="line-tables-only"',
      'profile.release.split-debuginfo="packed"',
      'profile.release.strip="debuginfo"',
    ]);
    assert.deepEqual(EXPORT_DEBUG_SETTINGS[DebugFileKind.Unstripped], [
      'profile.release.debug="line-tables-only"',
      'profile.release.split-debuginfo="off"',
      'profile.release.strip="none"',
    ]);
    assert.deepEqual(EXPORT_DEBUG_SETTINGS[DebugFileKind.SymbolMap], []);
  });
});

/** A build folder whose target holds a dSYM in `deps/` and the link cargo uplifts beside the executable. */
async function built(name: string) {
  const parent = await realpath(await tmpDir(`rust-debug-${name}-`));
  const bin = path.join(parent, "game-0123456789ab", "macos-0123456789ab");
  const dsym = path.join(bin, "target", "release", "deps", "game.dSYM", "Contents", "Resources", "DWARF");
  await mkdir(dsym, { recursive: true });
  await writeFile(path.join(dsym, "game"), DWARF);
  await symlink("deps/game.dSYM", path.join(bin, "target", "release", "game.dSYM"));
  return { parent, bin, from: path.join(bin, "target", "release", "game.dSYM") };
}

describe("the kept debug folders", () => {
  it("keeps a dSYM uplifted as a link, with an index naming the build's digest and every file", async () => {
    const { bin, from } = await built("keep");
    const digest = digestOf(1);
    const kept = await keepDebugFiles({
      bin,
      digest,
      target: BuildTarget.Mac,
      triple: "aarch64-apple-darwin",
      kind: DebugFileKind.Dsym,
      sources: [{ from, as: "game.dSYM" }],
      within: bin,
      now: () => Date.UTC(2026, 9, 21),
    });
    assert.ok(kept);
    const file = "game.dSYM/Contents/Resources/DWARF/game";
    assert.deepEqual(kept.files, [{ path: file, bytes: DWARF.length }]);
    const folder = path.join(debugRootOf(bin), digest);
    assert.equal(await readFile(path.join(folder, file), "utf8"), DWARF);
    assert.equal((await lstat(path.join(folder, "game.dSYM"))).isDirectory(), true, "kept as a folder, not a link");
    const index = JSON.parse(await readFile(path.join(folder, DEBUG_INDEX_FILE), "utf8"));
    assert.equal(index.digest, digest);
    assert.equal(index.kind, DebugFileKind.Dsym);
    assert.equal((await keptDebugBuild(bin, digest))?.folder, folder);
    assert.equal(await keptDebugBuild(bin, digestOf(2)), null);
  });

  it(`keeps the newest ${DEBUG_BUILDS_KEPT} builds: the ${DEBUG_BUILDS_KEPT + 1}th prunes the oldest`, async () => {
    const { bin, from } = await built("prune");
    let clock = Date.UTC(2026, 9, 21);
    for (let n = 1; n <= DEBUG_BUILDS_KEPT + 1; n++) {
      clock += 1_000;
      const at = clock;
      await keepDebugFiles({
        bin,
        digest: digestOf(n),
        target: BuildTarget.Mac,
        triple: "aarch64-apple-darwin",
        kind: DebugFileKind.Dsym,
        sources: [{ from, as: "game.dSYM" }],
        within: bin,
        now: () => at,
      });
    }
    const left = (await readdir(debugRootOf(bin))).sort();
    const expected = Array.from({ length: DEBUG_BUILDS_KEPT }, (_, i) => digestOf(i + 2)).sort();
    assert.deepEqual(left, expected);
  });
});

describe("the kept debug folders' hostile table", () => {
  it("hostile table: links and names that reach outside the build write and remove nothing there", async () => {
    const rows: {
      name: string;
      arrange: (ctx: Awaited<ReturnType<typeof built>>, outside: string) => Promise<unknown>;
    }[] = [
      {
        name: "<bin>.debug is a link to a folder elsewhere",
        arrange: async ({ bin }, outside) => await symlink(outside, debugRootOf(bin)),
      },
      {
        name: "the kept build's folder is a link to a folder elsewhere",
        arrange: async ({ bin }, outside) => {
          await mkdir(debugRootOf(bin));
          await symlink(outside, path.join(debugRootOf(bin), digestOf(1)));
        },
      },
      {
        name: "the half-written folder is a link to a folder elsewhere",
        arrange: async ({ bin }, outside) => {
          await mkdir(debugRootOf(bin));
          await symlink(outside, path.join(debugRootOf(bin), `${digestOf(1)}.new`));
        },
      },
      {
        name: "a link inside the dSYM names a file elsewhere",
        arrange: async ({ bin }, outside) =>
          await symlink(
            path.join(outside, "secret.txt"),
            path.join(bin, "target", "release", "deps", "game.dSYM", "Contents", "secret.txt"),
          ),
      },
    ];
    for (const row of rows) {
      const ctx = await built("hostile");
      const outside = path.join(ctx.parent, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "secret.txt"), "secret");
      await row.arrange(ctx, outside);
      const kept = await keepDebugFiles({
        bin: ctx.bin,
        digest: digestOf(1),
        target: BuildTarget.Mac,
        triple: "aarch64-apple-darwin",
        kind: DebugFileKind.Dsym,
        sources: [{ from: ctx.from, as: "game.dSYM" }],
        within: ctx.bin,
        now: () => Date.UTC(2026, 9, 21),
      });
      assert.deepEqual(await readdir(outside), ["secret.txt"], `${row.name}: nothing written or removed outside`);
      assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "secret", row.name);
      assert.ok(kept, row.name);
      assert.ok(
        !kept.files.some((file) => file.path.endsWith("secret.txt")),
        `${row.name}: no file kept through a link`,
      );
      assert.equal((await lstat(debugRootOf(ctx.bin))).isDirectory(), true, `${row.name}: the root is a real folder`);
    }
  });

  it("hostile table: a source outside the build, a digest that is a path and a kept name that is a path keep nothing", async () => {
    const rows = [
      { name: "a dSYM link to a folder outside the build", source: "outside", digest: digestOf(1), as: "game.dSYM" },
      { name: "a digest with ../", source: "inside", digest: `../${digestOf(1).slice(3)}`, as: "game.dSYM" },
      { name: "a kept name with ../", source: "inside", digest: digestOf(1), as: "../game.dSYM" },
    ] as const;
    for (const row of rows) {
      const { parent, bin, from } = await built("refused");
      const outside = path.join(parent, "outside.dSYM");
      await mkdir(outside);
      await writeFile(path.join(outside, "dwarf"), "not this build's");
      const link = path.join(bin, "target", "release", "planted.dSYM");
      await symlink(outside, link);
      const kept = await keepDebugFiles({
        bin,
        digest: row.digest,
        target: BuildTarget.Mac,
        triple: "aarch64-apple-darwin",
        kind: DebugFileKind.Dsym,
        sources: [{ from: row.source === "outside" ? link : from, as: row.as }],
        within: bin,
        now: () => 0,
      });
      assert.equal(kept, null, row.name);
      assert.equal(await lstat(debugRootOf(bin)).catch(() => null), null, `${row.name}: nothing written`);
      assert.deepEqual(await readdir(parent), ["game-0123456789ab", "outside.dSYM"], row.name);
    }
  });
});

describe("the Rust lane keeps an export's debug files outside out/", { skip: SKIP_ON_WINDOWS }, () => {
  it("a Mac export builds with line tables, a packed dSYM and the debug map stripped; Live keeps cargo's dev profile with line tables only", async () => {
    for (const [purpose, expected] of [
      // Flipped from the opt-level row alone (R-7): Live builds keep line tables only.
      [CppBuildPurpose.Live, ['profile.dev.package."*".opt-level=1', 'profile.dev.debug="line-tables-only"']],
      [CppBuildPurpose.Export, [...EXPORT_DEBUG_SETTINGS[DebugFileKind.Dsym]]],
    ] as const) {
      const parent = await realpath(await tmpDir("rust-debug-profile-"));
      const { builds, specs } = await lane(parent);
      const outcome = await builds.ensure(await rustGame(parent), BuildTarget.Mac, purpose);
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
      const [spec] = specs;
      assert.ok(spec);
      assert.deepEqual(await profileSettings(spec.bin), expected, purpose);
    }
  });

  it("a Mac export ships no debug file and keeps the dSYM under the shipped executable's digest", async () => {
    const parent = await realpath(await tmpDir("rust-debug-mac-"));
    const { builds, specs } = await lane(parent);
    const outcome = await builds.ensure(await rustGame(parent), BuildTarget.Mac, CppBuildPurpose.Export);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    const out = outcome.output ?? "";
    assert.deepEqual(shippedDebug(await walk(out)), [], "out/ holds no .dSYM, .dwp, .pdb or .symbols");
    const digest = outcome.rust?.receipt?.outputs.find((file) => file.path === "game")?.sha256 ?? "";
    const bin = specs[0]?.bin ?? "";
    const kept = await keptDebugBuild(bin, digest);
    assert.ok(kept, "the dSYM is kept by the shipped executable's digest");
    const dwarf = path.join(kept.folder, "game.dSYM", "Contents", "Resources", "DWARF", "game-5d41");
    assert.equal(await readFile(dwarf, "utf8"), DWARF);
  });

  it("a Live build keeps no debug folder (its DWARF stays in the build's own target)", async () => {
    const parent = await realpath(await tmpDir("rust-debug-live-"));
    const { builds, specs } = await lane(parent);
    const outcome = await builds.ensure(await rustGame(parent), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    assert.equal(await lstat(debugRootOf(specs[0]?.bin ?? "")).catch(() => null), null);
  });

  it("an Android export ships the llvm-objcopy-stripped executable and keeps the unstripped one", async () => {
    const parent = await realpath(await tmpDir("rust-debug-android-"));
    const { builds, specs, commands } = await lane(parent);
    const outcome = await builds.ensure(await rustGame(parent), BuildTarget.Android, CppBuildPurpose.Export);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    const bin = specs[0]?.bin ?? "";
    assert.deepEqual(await profileSettings(bin), [...EXPORT_DEBUG_SETTINGS[DebugFileKind.Unstripped]]);
    assert.ok(
      commands.some((command) => command.includes("llvm-objcopy' '--strip-debug'")),
      "the strip runs in the build's sandbox",
    );
    const out = outcome.output ?? "";
    assert.equal(await readFile(path.join(out, "game"), "utf8"), STRIPPED, "the shipped executable is stripped");
    const kept = await keptDebugBuild(bin, sha256(STRIPPED));
    assert.ok(kept, "kept by the shipped executable's digest");
    assert.equal(await readFile(path.join(kept.folder, "game"), "utf8"), UNSTRIPPED);
    assert.equal(kept.index.kind, DebugFileKind.Unstripped);
  });

  it("an Android export on a toolchain with no llvm-objcopy builds as before and keeps nothing", async () => {
    const parent = await realpath(await tmpDir("rust-debug-no-objcopy-"));
    const { builds, specs } = await lane(parent, { objcopy: null });
    const outcome = await builds.ensure(await rustGame(parent), BuildTarget.Android, CppBuildPurpose.Export);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    const bin = specs[0]?.bin ?? "";
    assert.deepEqual(await profileSettings(bin), []);
    assert.equal(await lstat(debugRootOf(bin)).catch(() => null), null);
  });
});

describe("an export whose strip fails ships nothing", { skip: SKIP_ON_WINDOWS }, () => {
  it("refuses the build, keeps the last admitted out/ and keeps no debug folder", async () => {
    const parent = await realpath(await tmpDir("rust-debug-strip-fails-"));
    const { builds, specs } = await lane(parent, { objcopy: "#!/bin/sh\necho 'llvm-objcopy: error' >&2\nexit 1\n" });
    const game = await rustGame(parent);
    const live = await builds.ensure(game, BuildTarget.Android, CppBuildPurpose.Live);
    assert.equal(live.ok, true, JSON.stringify(live.problem));
    const before = await readFile(path.join(live.output ?? "", "game"), "utf8");
    const exported = await builds.ensure(game, BuildTarget.Android, CppBuildPurpose.Export);
    assert.equal(exported.ok, false);
    assert.equal(exported.rust?.refusal, RustBuildRefusal.ArtifactRefused);
    assert.match(exported.problem?.lines[0] ?? "", /llvm-objcopy could not strip/);
    assert.equal(exported.lastGood, live.output, "the last admitted output stays");
    assert.equal(await readFile(path.join(live.output ?? "", "game"), "utf8"), before);
    assert.equal(await lstat(debugRootOf(specs[0]?.bin ?? "")).catch(() => null), null);
  });
});

describe("the web export's symbol map", () => {
  /** A runner that writes what each tool would; wasm-opt writes the map where `--symbolmap=` names it. */
  function scripted(out: string) {
    const commands: string[] = [];
    const run: WebRun = async (command, step) => {
      commands.push(command);
      if (step === RustWebStep.BindgenVersion) return { code: 0, stdout: "wasm-bindgen 0.2.129\n", stderr: "" };
      if (step === RustWebStep.Bindgen) {
        await writeFile(path.join(out, WEB_FILES.module), "export default async function init() {}\n");
        await writeFile(path.join(out, WEB_FILES.wasm), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
      }
      if (step === RustWebStep.WasmOpt) {
        await writeFile(path.join(out, WEB_FILES.optimizing), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
        const map = /--symbolmap=([^']+)'/.exec(command)?.[1];
        if (map) await writeFile(map, "0:_RNvCs_4game5crash\n");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    return { run, commands };
  }

  it("an export writes --symbolmap outside the served folder; a Live build runs no wasm-opt and writes none", async () => {
    for (const optimize of [true, false]) {
      const home = await realpath(await tmpDir("rust-debug-web-"));
      const wasm = path.join(home, "game.wasm");
      await writeFile(wasm, "wasm");
      const out = path.join(home, "web");
      const symbolMap = path.join(home, "debug", WEB_SYMBOL_MAP_FILE);
      const tools = scripted(out);
      const result = await packageWeb({
        wasm,
        out,
        shell: "<title>__GAME_TITLE__</title>",
        title: "x",
        optimize,
        tools: { wasmBindgen: "/t/wasm-bindgen", wasmOpt: "/t/wasm opt" },
        symbolMap,
        run: tools.run,
      });
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(shippedDebug(await walk(out)), [], "the served folder holds no symbol map");
      const wasmOpt = tools.commands.find((command) => command.includes("-Oz"));
      if (optimize) {
        assert.ok(wasmOpt?.endsWith(`'--symbolmap=${symbolMap}'`), wasmOpt);
        assert.equal(await readFile(symbolMap, "utf8"), "0:_RNvCs_4game5crash\n");
      } else {
        assert.equal(wasmOpt, undefined);
        assert.equal(await lstat(symbolMap).catch(() => null), null);
      }
    }
  });
});

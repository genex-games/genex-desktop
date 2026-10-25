/**
 * The per-game trust flag (extension ladder level 5, M7.2; `src/main/rust-trust.ts` and the
 * policy rows of `src/main/rust-build.ts`): set only by the person, kept in the profile (never the
 * game), default off and reset when the game's folder changes identity (a copy, an import); every
 * change a `game_trust` event. With it off the Rust lane refuses a build script
 * (`build-script-refused`, before cargo runs) and reports an `unsafe` error `unsafe-code`; with it
 * on `-F unsafe_code` is dropped and the game's `build.rs` is staged, while the build's sandbox spec
 * is byte-identical either way. A game claiming trust in its own files is answered
 * `trust-person-only` and stays untrusted.
 *
 * The lane rows run over a stub cargo (as `rust-build.test.ts`); the Seatbelt row runs the real
 * sandbox (macOS) with a build-script stand-in; the real-toolchain row builds
 * `tests/fixtures/rust-unsafe-game` and runs only with `GENEX_REQUIRE_TOOLCHAINS=1` (a cold build).
 */
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { cp, link, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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
  rustTrustPolicy,
} from "../../src/main/rust-build.ts";
import { RustBuildRefusal } from "../../src/main/rust-build-diagnostics.ts";
import { RUST_ENGINE_CRATES, RUST_ENGINE_KEPT_CRATES } from "../../src/main/rust-manifest.ts";
import {
  createEngineTrust,
  ENGINE_TRUST_FILE,
  type GameTrust,
  ownBuildScripts,
  UNTRUSTED,
} from "../../src/main/rust-trust.ts";
import { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import type { CustomEventRecord } from "../../src/shared/custom-events.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { ExtensionRefusal, gameTrustOf } from "../../src/shared/game-conformance.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import type { XcodeExec } from "../../src/substrate/toolchain-store/locate.ts";
import { lockOf } from "../../src/substrate/toolchain-store/lock.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = path.join(REPO, "tests", "fixtures", "rust-unsafe-game");
const VENDOR_DIR = process.env.GENEX_RUST_VENDOR_DIR ?? path.join(REPO, ".studio-dev", "rust-release", "e2e", "vendor");
const LOCK: ToolchainLock = {
  version: 1,
  entries: { rust: { version: "1.99.0", sha12: "0123456789ab" } },
  digest: "0123456789abcdef".repeat(4),
};
const MAC_SDK = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";
const SKIP_ON_WINDOWS = process.platform === "win32" ? "the stub cargo is a POSIX shell script" : false;
const SKIP_UNLESS_MAC = process.platform === "darwin" ? false : "the Seatbelt sandbox is macOS's";
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
].join("\n");
const RUSTC_VV =
  "rustc 1.99.0 (1d4e1a2b3 2026-09-17)\nhost: aarch64-apple-darwin\nrelease: 1.99.0\nLLVM version: 21.1.2";
/** rustc's error for an `unsafe` block under `-F unsafe_code`, as cargo's JSON message carries it. */
const UNSAFE_MESSAGE = {
  reason: "compiler-message",
  package_id: "game 0.0.0",
  message: {
    message: "usage of an `unsafe` block",
    code: { code: "unsafe_code" },
    level: "error",
    spans: [{ file_name: "STAGE/src/game.rs", line_start: 24, column_start: 5, is_primary: true }],
    children: [],
    rendered: "error: usage of an `unsafe` block\n --> src/game.rs:24:5\n",
  },
};

const xcode: XcodeExec = async (file) =>
  file.endsWith("xcode-select")
    ? { code: 0, stdout: "/Library/Developer/CommandLineTools\n", stderr: "" }
    : { code: 0, stdout: `${MAC_SDK}\n`, stderr: "" };

function shellWord(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * A stub cargo: writes the lock, records its environment, and for `clippy` and `build` fails with an
 * `unsafe_code` error when RUSTFLAGS forbids unsafe and the stage holds an `unsafe` block (rustc's
 * own lint, so a Live build without clippy meets it too); `build`
 * runs `onBuild` (a build-script stand-in) when the stage's manifest names a build script, then
 * reports the game's executable.
 */
function stubCargo(onBuild: string): string {
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
stage=$(dirname "$manifest")
# rustc's -F unsafe_code, as clippy and the build both compile under it (a Live build runs no clippy).
gate() {
  echo "$RUSTFLAGS" > "$CARGO_TARGET_DIR/../rustflags"
  case " $RUSTFLAGS " in
    *" -F unsafe_code "*)
      if grep -q 'unsafe {' "$stage/src/game.rs" 2>/dev/null; then
        printf '%s\\n' ${shellWord(JSON.stringify(UNSAFE_MESSAGE))} | sed "s#STAGE#$stage#g"
        exit 101
      fi
      ;;
  esac
}
case "$sub" in
  generate-lockfile)
    printf '%s' ${shellWord(LOCK_FILE)} > "$stage/Cargo.lock"
    ;;
  clippy)
    gate
    echo '{"reason":"build-finished","success":true}'
    ;;
  build)
    gate
    if grep -q '^build = "build.rs"$' "$manifest" && [ -f "$stage/build.rs" ]; then
      echo ran > "$CARGO_TARGET_DIR/../build-script-ran"
      ${onBuild || ":"}
    fi
    exe="$CARGO_TARGET_DIR/aarch64-apple-darwin/debug/game"
    mkdir -p "$(dirname "$exe")"
    printf '#!/bin/sh\\necho game\\n' > "$exe"
    chmod +x "$exe"
    echo '${artifact}' | sed -e "s#STAGE#$stage#" -e "s#MANIFEST#$manifest#" -e "s#EXE#$exe#g"
    echo '{"reason":"build-finished","success":true}'
    ;;
esac
exit 0
`;
}

/** A stand-in for the shipped stager: copies src/ and writes the host's manifest, `build = false` as `rust-manifest.ts` does. */
async function stage(game: { dir: string }, into: string): Promise<RustStaged> {
  await mkdir(path.join(into, "src"), { recursive: true });
  for (const name of await readdir(path.join(game.dir, "src")))
    await writeFile(path.join(into, "src", name), await readFile(path.join(game.dir, "src", name)));
  const manifest = '[package]\nname = "game"\nversion = "0.0.0"\nedition = "2024"\nbuild = false\nautobins = false\n';
  await writeFile(path.join(into, "Cargo.toml"), `${manifest}\n[dependencies]\ngenex = "=0.1.0"\n`);
  return { ok: true, dependencies: ["genex"] };
}

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

/** The sandbox the lane asks for, run without containment: every spec and command recorded. */
function openSandboxes() {
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
  return { sandbox, specs, commands };
}

/** A Rust lane over `parent` with the stub toolchain, trusting games as `trust` answers. */
async function lane(
  parent: string,
  sandbox: RustBuildsOptions["sandbox"],
  trust: RustBuildsOptions["trust"],
  onBuild = "",
): Promise<RustBuilds> {
  const bin = path.join(parent, "toolchain", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "cargo"), stubCargo(onBuild), { mode: 0o755 });
  await writeFile(path.join(bin, "rustc"), `#!/bin/sh\nprintf '%s\\n' ${shellWord(RUSTC_VV)}\n`, { mode: 0o755 });
  const vendor = path.join(parent, "toolchain", "vendor");
  await mkdir(vendor, { recursive: true });
  const toolchain: RustToolchain = { bin, vendor, clippyConf: bin, reads: [path.join(parent, "toolchain")] };
  return new RustBuilds({
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
    ...(trust ? { trust } : {}),
  });
}

/** A Rust game folder: the fixture's sources, with or without its build script and `unsafe` block. */
async function rustGame(parent: string, name: string, shape: { buildScript: boolean; unsafe: boolean }) {
  const dir = path.join(parent, "games", name);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "genex.toml"), '[game]\ntitle = "Game"\n');
  await writeFile(path.join(dir, "src", "main.rs"), "mod game;\nfn main() {}\n");
  const safe = "pub fn speed() -> f32 { 0.8 }\n";
  const risky = "pub fn speed() -> f32 { let s = 0.8f32; let at: *const f32 = &s; unsafe { *at } }\n";
  await writeFile(path.join(dir, "src", "game.rs"), shape.unsafe ? risky : safe);
  if (shape.buildScript) await writeFile(path.join(dir, "build.rs"), "fn main() {}\n");
  return realpath(dir);
}

function gameOf(dir: string, project = path.basename(dir)): GameBuildGame {
  return {
    project,
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
    destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Mac] },
  };
}

const trusting =
  (trusted: boolean, claim: GameTrust["claim"] = null): NonNullable<RustBuildsOptions["trust"]> =>
  async () => ({ trusted, claim });

/** Every file under `dir`, `/`-separated, with its bytes. */
async function tree(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(dir, file).split(path.sep).join("/")] = await readFile(file, "utf8");
  }
  return files;
}

/** A trust store over a profile in `parent` and a library of the named Rust games. */
async function store(parent: string, library: Record<string, string>) {
  const events: CustomEventRecord[] = [];
  const profile = path.join(parent, "profile");
  await mkdir(profile, { recursive: true });
  const file = path.join(profile, ENGINE_TRUST_FILE);
  const trust = createEngineTrust({
    file,
    rustGame: async (project) => (Object.hasOwn(library, project) ? { dir: library[project] ?? "" } : null),
    record: async (records) => {
      events.push(...records);
    },
    now: () => Date.parse("2026-10-07T00:00:00Z"),
  });
  return { trust, events, file, profile };
}

describe("the trust flag is the person's, kept in the profile and never in the game (M7.2)", () => {
  it("is off by default, set on and off only through setTrust, each change a game_trust event and nothing written in the game", async () => {
    const parent = await realpath(await tmpDir("rust-trust-flag-"));
    const dir = await rustGame(parent, "pond", { buildScript: true, unsafe: true });
    const before = await tree(dir);
    const { trust, events, file } = await store(parent, { pond: dir });
    assert.deepEqual(await trust.trustOf({ project: "pond", dir }), UNTRUSTED);

    assert.deepEqual(await trust.setTrust("pond", true), { project: "pond", ok: true, refusal: null, trusted: true });
    assert.deepEqual(await trust.trustOf({ project: "pond", dir }), { trusted: true, claim: null });
    assert.deepEqual(await trust.setTrust("pond", true), { project: "pond", ok: true, refusal: null, trusted: true });
    assert.deepEqual(await trust.setTrust("pond", false), { project: "pond", ok: true, refusal: null, trusted: false });
    assert.deepEqual(await trust.trustOf({ project: "pond", dir }), UNTRUSTED);

    assert.deepEqual(
      events.map((event) => gameTrustOf(event)),
      [
        { project: "pond", trusted: true },
        { project: "pond", trusted: false },
      ],
      "one event per change; setting what is already set records nothing",
    );
    assert.ok(existsSync(file), "the flag lives in the profile");
    assert.deepEqual(await tree(dir), before, "nothing of the game folder changed");
  });

  it("a worktree build of a trusted game is trusted; a copy, an import under the same name and a replaced folder start off", async () => {
    const parent = await realpath(await tmpDir("rust-trust-identity-"));
    const dir = await rustGame(parent, "pond", { buildScript: false, unsafe: true });
    const library: Record<string, string> = { pond: dir };
    const { trust } = await store(parent, library);
    await trust.setTrust("pond", true);
    const worktree = await rustGame(parent, "pond-worktree", { buildScript: false, unsafe: true });
    assert.equal((await trust.trustOf({ project: "pond", dir: worktree })).trusted, true, "the game's own worktree");

    const copy = path.join(parent, "games", "pond-copy");
    await cp(dir, copy, { recursive: true });
    library["pond-copy"] = copy;
    assert.equal((await trust.trustOf({ project: "pond-copy", dir: copy })).trusted, false, "a copy starts off");

    // An import (or a folder swapped behind the library) under the same name and path is another game.
    await rm(dir, { recursive: true, force: true });
    await cp(FIXTURE, dir, { recursive: true });
    assert.equal((await trust.trustOf({ project: "pond", dir })).trusted, false, "a replaced folder starts off");
    assert.deepEqual(await trust.setTrust("pond", true), { project: "pond", ok: true, refusal: null, trusted: true });
    assert.equal(
      (await trust.trustOf({ project: "pond", dir })).trusted,
      true,
      "the person trusts the new folder anew",
    );
  });
});

describe("nothing in the game reaches the flag (M7.2)", () => {
  it("nothing but the person sets it: no harness method, a genex.toml trust key and a planted file are each trust-person-only", async () => {
    const methods: readonly string[] = Object.values(HostMethod);
    for (const method of methods) assert.doesNotMatch(method, /trust/i, `${method}: no harness method sets trust`);

    const parent = await realpath(await tmpDir("rust-trust-claims-"));
    const keys = [
      'trust = true\n[game]\ntitle = "Game"\n',
      '[game]\ntitle = "Game"\ntrusted = true\n',
      '[engine]\ntrusted = true\n[game]\ntitle = "Game"\n',
      '[game]\ntitle = "Game"\n"trust" = true\n',
      '[trust]\nunsafe = true\n[game]\ntitle = "Game"\n',
      'engine.trusted = true\n[game]\ntitle = "Game"\n',
    ];
    const library: Record<string, string> = {};
    const games: string[] = [];
    for (const [at, toml] of keys.entries()) {
      const dir = await rustGame(parent, `claims-${at}`, { buildScript: true, unsafe: true });
      await writeFile(path.join(dir, "genex.toml"), toml);
      library[`claims-${at}`] = dir;
      games.push(dir);
    }
    const planted = await rustGame(parent, "planted", { buildScript: true, unsafe: true });
    library.planted = planted;
    games.push(planted);
    const { trust, events, file } = await store(parent, library);
    // A copy of a real trusting profile file, planted in the game folder and in its src/.
    await trust.setTrust("planted", true);
    const forged = await readFile(file, "utf8");
    await trust.setTrust("planted", false);
    await writeFile(path.join(planted, ENGINE_TRUST_FILE), forged);
    events.length = 0;
    for (const dir of games) {
      const project = path.basename(dir);
      assert.deepEqual(
        await trust.trustOf({ project, dir }),
        { trusted: false, claim: ExtensionRefusal.TrustPersonOnly },
        project,
      );
    }
    assert.deepEqual(events, [], "no claim recorded a change");
    assert.deepEqual(await trust.trustOf({ project: "unknown", dir: planted }), {
      trusted: false,
      claim: ExtensionRefusal.TrustPersonOnly,
    });
  });

  it("a profile file it cannot trust trusts nothing (hostile table), and an unknown game is refused with nothing written", async () => {
    const parent = await realpath(await tmpDir("rust-trust-hostile-"));
    const dir = await rustGame(parent, "pond", { buildScript: false, unsafe: true });
    const { trust, file, profile, events } = await store(parent, { pond: dir });
    await trust.setTrust("pond", true);
    const good = await readFile(file, "utf8");
    const elsewhere = path.join(parent, "elsewhere.json");
    await writeFile(elsewhere, good);
    const hostile: Array<[string, () => Promise<void>]> = [
      ["a link to a trusting file", async () => symlink(elsewhere, file)],
      ["not JSON", async () => writeFile(file, "{ trusted: yes")],
      ["another schema", async () => writeFile(file, good.replace('"schema": 1', '"schema": 2'))],
      ["a record missing its identity", async () => writeFile(file, good.replace(/"ino": "\d+",/, ""))],
      ["a record for another folder", async () => writeFile(file, good.replace(/"ino": "\d+"/, '"ino": "1"'))],
      ["a folder", async () => mkdir(file)],
    ];
    for (const [name, plant] of hostile) {
      await rm(file, { recursive: true, force: true });
      await plant();
      assert.deepEqual(await trust.trustOf({ project: "pond", dir }), UNTRUSTED, name);
    }
    await rm(file, { recursive: true, force: true });
    events.length = 0;
    await assert.rejects(trust.setTrust("not-a-game", true), /not a Rust game/);
    assert.deepEqual(await readdir(profile), [], "nothing written for a game the library does not hold");
    assert.deepEqual(events, []);
  });
});

describe("the Rust lane's unsafe and build-script policy follows the flag; its sandbox does not (M7.2)", {
  skip: SKIP_ON_WINDOWS,
}, () => {
  it("the policy: -F unsafe_code and no build scripts unless trusted", () => {
    assert.deepEqual(rustTrustPolicy(false), { rustflags: ["-F unsafe_code"], buildScripts: false });
    assert.deepEqual(rustTrustPolicy(true), { rustflags: [], buildScripts: true });
  });

  it("with the flag off, a build.rs is refused build-script-refused before any cargo runs", async () => {
    const parent = await realpath(await tmpDir("rust-trust-off-script-"));
    const open = openSandboxes();
    const builds = await lane(parent, open.sandbox, trusting(false));
    const dir = await rustGame(parent, "pond", { buildScript: true, unsafe: false });
    const outcome = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ran, false);
    assert.equal(outcome.rust?.extension, ExtensionRefusal.BuildScriptRefused);
    assert.match(outcome.problem?.lines[0] ?? "", /^build-script-refused: build\.rs /);
    assert.deepEqual(open.commands, [], "no cargo ran");
    assert.deepEqual(open.specs, [], "no sandbox was opened");
  });

  it("with the flag off, an ejected engine's build scripts and proc macros are refused too (hostile table)", async () => {
    const parent = await realpath(await tmpDir("rust-trust-engine-"));
    const crate = '[package]\nname = "genex-core"\nversion = "0.1.0"\n';
    const rows: Array<[string, Record<string, string>, boolean]> = [
      ["a clean engine crate", { "engine/genex-core/Cargo.toml": crate }, false],
      [
        "cargo's own build = false",
        { "engine/genex-core/Cargo.toml": `${crate}build = false\nautobins = false\n` },
        false,
      ],
      ["a build key after false", { "engine/genex-core/Cargo.toml": `${crate}build = falsely\n` }, true],
      ["a proc macro set false", { "engine/genex-core/Cargo.toml": `${crate}[lib]\nproc_macro = false\n` }, true],
      [
        "a build.rs in an engine crate",
        { "engine/genex-core/Cargo.toml": crate, "engine/genex-core/build.rs": "" },
        true,
      ],
      ["a build key", { "engine/genex-core/Cargo.toml": `${crate}build = "gen.rs"\n` }, true],
      ["a dotted build key", { "engine/genex-core/Cargo.toml": `package.build = "gen.rs"\n` }, true],
      ["a quoted build key", { "engine/genex-core/Cargo.toml": `${crate}"build" = 'gen.rs'\n` }, true],
      ["an inline table", { "engine/genex-core/Cargo.toml": `package = { name = "x#", build = "g.rs" }\n` }, true],
      ["a proc macro", { "engine/genex-core/Cargo.toml": `${crate}[lib]\nproc-macro = true\n` }, true],
      ["an escaped key", { "engine/genex-core/Cargo.toml": `${crate}"bu\\u0069ld" = "g.rs"\n` }, true],
      ["a nested build.rs", { "engine/genex-core/src/deep/build.rs": "" }, true],
    ];
    for (const [name, files, refused] of rows) {
      const dir = await rustGame(parent, name.replaceAll(" ", "-").replaceAll(".", ""), {
        buildScript: false,
        unsafe: false,
      });
      for (const [rel, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await writeFile(path.join(dir, rel), text);
      }
      assert.equal((await ownBuildScripts(dir)).length > 0, refused, name);
    }
    const linked = await rustGame(parent, "linked", { buildScript: false, unsafe: false });
    await mkdir(path.join(linked, "engine", "genex-core"), { recursive: true });
    await symlink(path.join(parent, "nowhere.rs"), path.join(linked, "engine", "genex-core", "build.rs"));
    await symlink(path.join(parent, "nowhere.rs"), path.join(linked, "build.rs"));
    assert.deepEqual(await ownBuildScripts(linked), ["build.rs", "engine/genex-core/build.rs"], "a link counts");
  });

  it("a fresh eject of the release's vendored genex crates is not refused (cargo's normalized manifests)", {
    skip: existsSync(path.join(VENDOR_DIR, "genex-0.1.0")) ? false : `not run: no vendored release at ${VENDOR_DIR}`,
  }, async () => {
    const parent = await realpath(await tmpDir("rust-trust-eject-"));
    const dir = await rustGame(parent, "ejected", { buildScript: false, unsafe: false });
    // Flipped in GC: an eject forks only the engine crates; the kept ones (the relay client
    // genex-multiplayer, whose build script links libcolyseus, and the transport and phone shells)
    // stay the store's, so they are not copied under engine/ here either.
    const crateOf = (folder: string) => folder.replace(/-\d.*$/, "");
    const vendored = (await readdir(VENDOR_DIR)).filter((name) => /^genex(-[a-z-]+)?-\d/.test(name));
    const forked = vendored.filter((name) => RUST_ENGINE_CRATES.includes(crateOf(name)));
    assert.ok(forked.length > 0);
    const kept = vendored.filter((name) => RUST_ENGINE_KEPT_CRATES.includes(crateOf(name)));
    assert.ok(kept.length > 0, "the release vendors the kept crates the fork resolves from the store");
    for (const name of forked)
      await cp(path.join(VENDOR_DIR, name), path.join(dir, "engine", crateOf(name)), { recursive: true });
    assert.deepEqual(await ownBuildScripts(dir), []);
  });

  it("with the flag off, an unsafe block is reported unsafe-code under -F unsafe_code", async () => {
    const parent = await realpath(await tmpDir("rust-trust-off-unsafe-"));
    const open = openSandboxes();
    const builds = await lane(parent, open.sandbox, trusting(false));
    const dir = await rustGame(parent, "pond", { buildScript: false, unsafe: true });
    const outcome = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ran, true);
    assert.equal(outcome.rust?.extension, ExtensionRefusal.UnsafeCode);
    assert.equal(outcome.rust?.diagnostics[0]?.code, "unsafe_code");
    assert.equal(outcome.rust?.diagnostics[0]?.file, "src/game.rs");
    assert.match(outcome.problem?.lines[0] ?? "", /^unsafe-code: /);
    const [spec] = open.specs;
    const flags = (await readFile(path.join(spec?.bin ?? "", "rustflags"), "utf8")).trim();
    assert.match(flags, /(^| )-F unsafe_code( |$)/);
  });
});

describe("the Rust lane answers a claim, a failed read and a trusted game (M7.2)", { skip: SKIP_ON_WINDOWS }, () => {
  it("a game claiming trust in its own files stays untrusted, and the refusal says trust-person-only", async () => {
    const parent = await realpath(await tmpDir("rust-trust-claimed-"));
    const open = openSandboxes();
    const builds = await lane(parent, open.sandbox, trusting(false, ExtensionRefusal.TrustPersonOnly));
    const dir = await rustGame(parent, "pond", { buildScript: true, unsafe: true });
    const outcome = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.rust?.extension, ExtensionRefusal.BuildScriptRefused);
    assert.ok(outcome.problem?.lines.some((line) => line.startsWith("trust-person-only: ")));
    assert.deepEqual(open.commands, []);
  });

  it("a trust reader that fails leaves the game untrusted", async () => {
    const parent = await realpath(await tmpDir("rust-trust-failing-"));
    const open = openSandboxes();
    const builds = await lane(parent, open.sandbox, async () => {
      throw new Error("profile unreadable");
    });
    const dir = await rustGame(parent, "pond", { buildScript: true, unsafe: false });
    const outcome = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.rust?.extension, ExtensionRefusal.BuildScriptRefused);
  });

  it("with the flag on both build: -F unsafe_code is dropped and build.rs is staged, in a sandbox byte-identical to an untrusted build's", async () => {
    const parent = await realpath(await tmpDir("rust-trust-on-"));
    const open = openSandboxes();
    let trusted = true;
    const builds = await lane(parent, open.sandbox, async () => ({ trusted, claim: null }));
    const dir = await rustGame(parent, "pond", { buildScript: true, unsafe: true });
    const outcome = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    assert.equal(outcome.rust?.extension, undefined);
    const [onSpec] = open.specs;
    assert.ok(onSpec);
    assert.doesNotMatch(await readFile(path.join(onSpec.bin, "rustflags"), "utf8"), /unsafe_code/);
    assert.equal(await readFile(path.join(onSpec.bin, "build-script-ran"), "utf8"), "ran\n");
    const staged = `${onSpec.bin}.stage`;
    assert.equal(await readFile(path.join(staged, "build.rs"), "utf8"), "fn main() {}\n");
    assert.match(await readFile(path.join(staged, "Cargo.toml"), "utf8"), /^build = "build\.rs"$/m);

    // The same game, untrusted and without its build script: the very same sandbox spec.
    trusted = false;
    await rm(path.join(dir, "build.rs"));
    await writeFile(path.join(dir, "src", "game.rs"), "pub fn speed() -> f32 { 0.8 }\n");
    const off = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(off.ok, true, JSON.stringify(off.problem));
    const [, offSpec] = open.specs;
    assert.equal(JSON.stringify(offSpec), JSON.stringify(onSpec), "the sandbox spec is byte-identical on and off");
    assert.match(await readFile(path.join(onSpec.bin, "rustflags"), "utf8"), /-F unsafe_code/);
    assert.doesNotMatch(await readFile(path.join(`${onSpec.bin}.stage`, "Cargo.toml"), "utf8"), /build\.rs/);
  });

  it("a trusted game's build.rs that is a link or a hard link is refused at the stage", async () => {
    const parent = await realpath(await tmpDir("rust-trust-linked-"));
    const open = openSandboxes();
    const builds = await lane(parent, open.sandbox, trusting(true));
    const outside = path.join(parent, "outside.rs");
    await writeFile(outside, "fn main() {}\n");
    const dir = await rustGame(parent, "pond", { buildScript: false, unsafe: false });
    await symlink(outside, path.join(dir, "build.rs"));
    const outcome = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.rust?.refusal, RustBuildRefusal.StageRefused);
    assert.equal(open.commands.length, 0, "no cargo ran");

    const hard = await rustGame(parent, "hard", { buildScript: false, unsafe: false });
    await link(outside, path.join(hard, "build.rs"));
    const linked = await builds.ensure(gameOf(hard), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(linked.rust?.refusal, RustBuildRefusal.StageRefused);
    assert.equal(open.commands.length, 0, "no cargo ran");
  });
});

/** A documentation address (TEST-NET-3, RFC 5737): a network host no sandbox may reach. */
const NETWORK_HOST = "203.0.113.1";
/**
 * A build-script stand-in's connect to {@link NETWORK_HOST}, from an empty environment (no proxy),
 * writing `connect()`'s errno: 1 (EPERM) when the sandbox refuses it; outside one it hangs until
 * the alarm. The build sandbox's grant of this machine's own addresses (loopback) is
 * ProcessSandbox's for every build, trusted or not, so the row aims off the machine.
 */
const CONNECT_ERRNO = [
  "/usr/bin/env -i /usr/bin/perl -MSocket -e",
  shellWord(
    `alarm 5; socket(my $s, PF_INET, SOCK_STREAM, 0) or die; print connect($s, pack_sockaddr_in(80, inet_aton("${NETWORK_HOST}"))) ? "connected" : ($!+0)`,
  ),
].join(" ");

describe("a trusted build script is still held by the unchanged build sandbox (macOS)", {
  skip: SKIP_UNLESS_MAC,
}, () => {
  it("has no network and writes only its build folder", async () => {
    const parent = await realpath(await tmpDir("rust-trust-seatbelt-"));
    const dir = await rustGame(parent, "pond", { buildScript: true, unsafe: true });
    const sibling = await rustGame(parent, "sibling", { buildScript: false, unsafe: false });
    const pwned = [path.join(dir, "pwned"), path.join(sibling, "src", "pwned.rs"), path.join(parent, "pwned")];
    const hostile = [
      `${CONNECT_ERRNO} > "$CARGO_TARGET_DIR/../net" 2>/dev/null`,
      ...pwned.map((file) => `echo pwned > ${shellWord(file)} 2>/dev/null`),
      'mkdir -p "$CARGO_TARGET_DIR/debug/build/game-0/out" && echo own > "$CARGO_TARGET_DIR/debug/build/game-0/out/own"',
    ].join("\n");
    const sandbox = rustBuildSandboxes({ secretPaths: [], enabled: true });
    const builds = await lane(parent, sandbox, trusting(true), hostile);
    const outcome = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    const root = path.join(parent, "rust-builds");
    const [project] = await readdir(root);
    const [folder] = (await readdir(path.join(root, project ?? ""))).filter((name) => !name.includes("."));
    const bin = path.join(root, project ?? "", folder ?? "");
    assert.equal(await readFile(path.join(bin, "build-script-ran"), "utf8"), "ran\n", "the build script ran");
    assert.equal(await readFile(path.join(bin, "target", "debug", "build", "game-0", "out", "own"), "utf8"), "own\n");
    assert.equal(await readFile(path.join(bin, "net"), "utf8"), "1", "connect() was refused: EPERM");
    for (const file of pwned) assert.equal(existsSync(file), false, `${file} was not written`);
  });
});

const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const WORKSPACE = path.join(REPO, "native", "genex-rust");
/** A cold build compiles the facade's whole dependency graph twice (clippy, then the build). */
const COLD_BUILD_MS = 30 * MINUTE_MS;

/** Why the real row cannot run: only with `GENEX_REQUIRE_TOOLCHAINS=1` (a cold build), on Apple silicon with the stores. */
function realRowSkip(): { skip?: string } {
  if (process.env.GENEX_REQUIRE_TOOLCHAINS !== "1")
    return { skip: "not run: a cold build; GENEX_REQUIRE_TOOLCHAINS=1 runs it" };
  const missing = [path.join(TOOLCHAIN_DIR, "sysroot/bin/cargo"), path.join(VENDOR_DIR, "genex-0.1.0")].find(
    (need) => !existsSync(need),
  );
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("GENEX_REQUIRE_TOOLCHAINS=1: not Apple silicon");
  if (missing) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return {};
}

describe("the real toolchain builds the unsafe fixture only while trusted (macOS)", () => {
  it("refuses it untrusted (build-script-refused, then unsafe-code) and builds it trusted", {
    ...realRowSkip(),
    timeout: 2 * COLD_BUILD_MS,
  }, async () => {
    const home = await realpath(await tmpDir("rust-trust-real-"));
    const dir = path.join(home, "games", "unsafe-pond");
    await cp(FIXTURE, dir, { recursive: true });
    const payload = rustPayloadDir(path.join(home, "resources"));
    await mkdir(payload, { recursive: true });
    for (const file of ["Cargo.lock", "clippy.toml"])
      await writeFile(path.join(payload, file), await readFile(path.join(WORKSPACE, file)));
    const toolchainDir = realpathSync(TOOLCHAIN_DIR);
    const vendor = await realpath(VENDOR_DIR);
    const toolchain: RustToolchain = {
      bin: path.join(toolchainDir, "sysroot", "bin"),
      vendor,
      clippyConf: payload,
      reads: [toolchainDir, vendor, payload],
    };
    let trusted = false;
    const builds = new RustBuilds({
      root: path.join(home, "app-data", "rust-builds"),
      sandbox: rustBuildSandboxes({ secretPaths: [], enabled: true, denyRead: [os.homedir(), home] }),
      locate: async () => ({ ok: true, toolchain }),
      currentLock: async () => lockOf({ rust: { version: "1.99.0", sha12: "000000000000" } }),
      stage: shippedRustStage(payload),
      emit: () => {},
      platform: process.platform,
      cores: 8,
      denyWrite: [],
      writeLock: async () => {},
      trust: async () => ({ trusted, claim: null }),
    });
    const game = gameOf(dir, "unsafe-pond");
    const scripted = await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(scripted.rust?.extension, ExtensionRefusal.BuildScriptRefused, JSON.stringify(scripted.problem));
    // Without its build script (and the cfg it sets), the unsafe block alone refuses it.
    const script = await readFile(path.join(dir, "build.rs"));
    const source = await readFile(path.join(dir, "src", "game.rs"), "utf8");
    await rm(path.join(dir, "build.rs"));
    await writeFile(path.join(dir, "src", "game.rs"), source.replace("#[cfg(genex_trusted)]\n", ""));
    const unsafeBuild = await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(unsafeBuild.ok, false);
    assert.equal(unsafeBuild.rust?.extension, ExtensionRefusal.UnsafeCode, JSON.stringify(unsafeBuild.rust));
    await writeFile(path.join(dir, "build.rs"), script);
    await writeFile(path.join(dir, "src", "game.rs"), source);
    trusted = true;
    const built = await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    assert.equal(built.rust?.extension, undefined);
  });
});

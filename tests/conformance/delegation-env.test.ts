/**
 * The host's side of a compiled game's session (M3.13, `core/delegation.ts`): `rustToolchainEnv`
 * beside `cppToolchainEnv`, and the Rust session a delegation hands its engine — the store's cargo
 * and CARGO_HOME, a target folder of the session's own cloned from the prewarm, and the manifest
 * and lock the host writes outside the game folder for `cargo check --offline --locked`.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpDir } from "../helpers/tmp.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { fixtureRustWebOutput, seedFixtureRustStore } from "../../src/main/dev/fixture-rust.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { isInside } from "../../src/substrate/paths.ts";
import { rustSessionFor, rustToolchainEnv } from "../../src/main/core/delegation.ts";
import {
  RUST_COMMAND_TIMEOUT_MS,
  type RustSession,
  RustSessionVariable,
} from "../../src/substrate/engines/studio-tool-prompts.ts";
import {
  locateRust,
  RUST_PREWARM_FILE,
  RUST_TRIPLE,
  readRustPrewarm,
  rustCargoHome,
  rustPrewarmedTargetDir,
  rustSysroot,
  rustTargetFolder,
} from "../../src/substrate/toolchain-store/rust-locate.ts";
import { readWarmLock } from "../../src/substrate/toolchain-store/rust-prewarm.ts";
import type { DelegateRequest, DelegateResult } from "../../src/substrate/engines/types.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";

const SKIP_ON_WINDOWS = process.platform === "win32" && "a Windows host builds no Rust game (no prewarm)";

/** A delegated engine that records each request it is handed and answers at once. */
function recordingEngine(seen: DelegateRequest[]) {
  return {
    id: "claude-code",
    label: "fixture",
    kind: "delegated",
    supportsSessions: true,
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
      seen.push(request);
      return { ok: true, engine: "claude-code", sessionId: "s", turns: 1, usage: {}, summary: "" };
    },
  };
}

const lites: CoreLite[] = [];
after(async () => {
  for (const lite of lites) await lite.close();
});

/** A harness method of a core, called as the harness calls it. */
function harnessCall(core: StudioCore): (method: string, params: Record<string, unknown>) => Promise<unknown> {
  const api = core.api() as unknown as Record<string, (params: Record<string, unknown>) => Promise<unknown>>;
  return (method, params) => {
    const answer = api[method];
    assert.ok(answer, `the core answers ${method}`);
    return answer(params);
  };
}

/** Every entry under `dir` (links not followed) with its size and mtime: a folder that was written differs. */
async function listing(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  const described = await Promise.all(
    entries.map(async (rel) => {
      const info = await lstat(path.join(dir, rel));
      return `${rel}:${info.size}:${info.mtimeMs}`;
    }),
  );
  return described.sort();
}

/** A lite core over the fixture Rust store, a recording engine, a Rust game for the web and the Mac and a Three.js game. */
async function rustCore() {
  const lite = await coreLite();
  lites.push(lite);
  const { core } = lite;
  core.host.dispatch = async () => undefined;
  const lock = await seedFixtureRustStore(core.layout.toolchains, { webOutput: fixtureRustWebOutput() });
  assert.ok(lock, "the fixture Rust store is seeded");
  const store = await realpath(core.layout.toolchains);
  const seen: DelegateRequest[] = [];
  core.engines.register(recordingEngine(seen) as never);
  await core.games.scaffold("ferris", { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Mac] });
  await core.games.scaffold("arena");
  const call = harnessCall(core);
  const delegated = async (project: string): Promise<DelegateRequest> => {
    const threadId = await core.threadForGame(project);
    await call("engine.delegate", { engine: "claude-code", prompt: "go", project, threadId });
    const request = seen.at(-1);
    assert.ok(request, "the engine was handed a request");
    return request;
  };
  const sessions = path.join(await realpath(path.dirname(core.layout.rustSessions)), "rust-sessions");
  return { core, lock, store, delegated, sessions, game: await realpath(core.games.dirFor("ferris")) };
}

/** The host's Rust sessions folder of a lite core, by its parent's real path. */
async function sessionsRoot(core: { layout: { rustSessions: string } }): Promise<string> {
  return path.join(await realpath(path.dirname(core.layout.rustSessions)), path.basename(core.layout.rustSessions));
}

/** The Rust session a request carries, asserted present. */
function rustOf(request: DelegateRequest): RustSession {
  const rust = request.rust;
  assert.ok(rust, "a Rust session is handed its toolchain");
  return rust;
}

describe("rustToolchainEnv, beside cppToolchainEnv", { skip: SKIP_ON_WINDOWS }, () => {
  it("puts the store's cargo first, names the store's CARGO_HOME, the session's own target folder and manifest, and the prewarm's flags", async () => {
    const store = await realpath(await tmpDir("studio-rust-env-store-"));
    const lock = await seedFixtureRustStore(store, { webOutput: fixtureRustWebOutput() });
    assert.ok(lock);
    const found = await locateRust(store, lock, BuildTarget.Web);
    assert.ok(found.ok, JSON.stringify(found));
    const own = { targetDir: "/scratch/rust-sessions/g/k/target", manifest: "/scratch/rust-sessions/g/k/Cargo.toml" };
    const record = await readRustPrewarm(store, lock, BuildTarget.Web);
    assert.ok(record);
    const shell = rustToolchainEnv(found.located, own);
    assert.deepEqual(shell.path, [path.join(rustSysroot(store, lock), "bin")]);
    assert.deepEqual(shell.env, {
      CARGO_HOME: rustCargoHome(store, lock),
      CARGO_TARGET_DIR: own.targetDir,
      CARGO_BUILD_TARGET: RUST_TRIPLE[BuildTarget.Web],
      CARGO_ENCODED_RUSTFLAGS: record.rustflags.join("\u001f"),
      CARGO_NET_OFFLINE: "true",
      CARGO_TERM_COLOR: "never",
      RUSTC: found.located.rustc,
      [RustSessionVariable.Manifest]: own.manifest,
    });
    assert.equal("PATH" in shell.env, false, "PATH is the engine's to compose");
  });
});

describe("a Rust · wgpu game's session, as the host hands it", { skip: SKIP_ON_WINDOWS }, () => {
  it("reads the store, writes its own target folder cloned from the prewarm, and checks with a manifest outside the game", async () => {
    const { lock, store, delegated, sessions, game } = await rustCore();
    const prewarm = rustPrewarmedTargetDir(store, lock, BuildTarget.Web);
    const storeBefore = await listing(store);
    const request = await delegated("ferris");
    assert.equal(request.cpp, undefined, "a Rust game has no C++ session");
    const rust = rustOf(request);
    assert.equal(rust.store, store);
    assert.equal(rust.commandTimeoutMs, RUST_COMMAND_TIMEOUT_MS);
    assert.ok(rust.path.length > 0 && rust.path.every((dir) => isInside(store, dir)), "the store's cargo");
    assert.equal(rust.env.CARGO_HOME, rustCargoHome(store, lock), "the store's CARGO_HOME");
    const { targetDir } = rust;
    assert.ok(targetDir && isInside(sessions, targetDir), `its own, in the host's rust-sessions: ${targetDir}`);
    assert.equal(rust.env.CARGO_TARGET_DIR, targetDir);
    assert.ok(!isInside(store, targetDir) && !isInside(game, targetDir), "never in the store or the game");
    assert.deepEqual(await readdir(targetDir, { recursive: true }), await readdir(prewarm, { recursive: true }));
    await writeFile(path.join(targetDir, "built-by-the-session.txt"), "x");

    const manifest = rust.env[RustSessionVariable.Manifest];
    assert.ok(manifest && path.dirname(manifest) === path.dirname(targetDir), manifest);
    const toml = await readFile(manifest, "utf8");
    assert.ok(toml.includes(`path = ${JSON.stringify(path.join(game, "src", "main.rs"))}`), toml);
    assert.ok(toml.includes('name = "genex-game"') && toml.includes("genex = "), toml);
    const cargoLock = await readFile(path.join(path.dirname(manifest), "Cargo.lock"), "utf8");
    assert.match(cargoLock, /name = "genex-game"/);
    assert.match(cargoLock, /name = "genex"/);
    assert.deepEqual(await readdir(game).then((names) => names.filter((name) => /^Cargo\./.test(name))), []);

    const reads = request.extraReads ?? [];
    assert.ok(reads.includes(store), "an unattended session reads the store");
    assert.deepEqual(
      reads.filter((dir) => dir !== store),
      [targetDir],
      "besides the store, it reaches its target folder alone (its sandbox writes what it reaches)",
    );
    assert.deepEqual(await listing(store), storeBefore, "the store is unchanged");

    const again = rustOf(await delegated("ferris"));
    assert.equal(again.targetDir, targetDir, "the same worktree keeps its target folder");
    assert.equal(await readFile(path.join(targetDir, "built-by-the-session.txt"), "utf8"), "x", "and what it built");

    const three = await delegated("arena");
    assert.equal(three.rust, undefined, "a Three.js session has no Rust toolchain");
    assert.equal(three.cpp, undefined);
    assert.equal((three.extraReads ?? []).includes(store), false, "nor the store");
  });
});

describe("a Rust session per worktree, and none without what it checks with", { skip: SKIP_ON_WINDOWS }, () => {
  it("gives each worktree a target folder of its own", async () => {
    const { lock, store, core } = await rustCore();
    const found = await locateRust(store, lock, BuildTarget.Web);
    assert.ok(found.ok);
    const home = { root: await sessionsRoot(core), game: "ferris", attended: false };
    const one = await worktree(core.games.dirFor("ferris"), "wt-one");
    const two = await worktree(core.games.dirFor("ferris"), "wt-two");
    const lockLines = [await readWarmLock(store, lock, BuildTarget.Web)];
    const a = await rustSessionFor({ store, located: found.located, workCwd: one, home, lockLines });
    const b = await rustSessionFor({ store, located: found.located, workCwd: two, home, lockLines });
    assert.ok(a.targetDir && b.targetDir);
    assert.notEqual(a.targetDir, b.targetDir);
    const toml = await readFile(a.env[RustSessionVariable.Manifest] ?? "", "utf8");
    assert.ok(toml.includes(JSON.stringify(path.join(one, "src", "main.rs"))), "its manifest names its own sources");
  });

  it("sets nothing but the store and the timeout where there is no prewarm, no genex.toml or no lock to check with", async () => {
    const { lock, store, core } = await rustCore();
    const home = { root: await sessionsRoot(core), game: "ferris", attended: false };
    const found = await locateRust(store, lock, BuildTarget.Web);
    assert.ok(found.ok);
    const workCwd = await worktree(core.games.dirFor("ferris"), "wt-bare");
    const warm = await readWarmLock(store, lock, BuildTarget.Web);
    const bare = (session: RustSession) => {
      assert.equal(session.store, store);
      assert.equal(session.commandTimeoutMs, RUST_COMMAND_TIMEOUT_MS);
      assert.deepEqual([session.path, session.env, session.targetDir], [[], {}, null]);
    };
    bare(await rustSessionFor({ store, located: null, workCwd, home, lockLines: [warm] }));
    bare(await rustSessionFor({ store, located: found.located, workCwd, home, lockLines: [] }));
    bare(await rustSessionFor({ store, located: found.located, workCwd, home, lockLines: ["not a lock"] }));
    await rm(path.join(workCwd, "genex.toml"));
    bare(await rustSessionFor({ store, located: found.located, workCwd, home, lockLines: [warm] }));
  });

  it("hands a store whose destination is not prewarmed no environment, and no folder of its own", async () => {
    const { lock, store, delegated, sessions } = await rustCore();
    await rm(path.join(rustTargetFolder(store, lock, BuildTarget.Web), RUST_PREWARM_FILE));
    const rust = rustOf(await delegated("ferris"));
    assert.deepEqual([rust.path, rust.env, rust.targetDir], [[], {}, null]);
    // The core makes its rust-sessions folder at start, like every folder of its layout.
    assert.deepEqual(await readdir(sessions).catch(() => []), [], "nothing made in rust-sessions");
  });
});

describe("a Rust session's own folders, outside the game folder", { skip: SKIP_ON_WINDOWS }, () => {
  it("is made where a link or file was planted on its way, never through it: what the link pointed at is untouched", async () => {
    const { lock, store, delegated, sessions } = await rustCore();
    const outside = await tmpDir("studio-rust-session-outside-");
    await writeFile(path.join(outside, "keep.txt"), "keep me\n");
    // The key folder's name is the host's: learn it from a first session, then plant on it.
    const first = rustOf(await delegated("ferris"));
    assert.ok(first.targetDir);
    const folder = path.dirname(first.targetDir);
    const gameFolder = path.dirname(folder);
    const target = first.targetDir;
    const manifest = path.join(folder, "Cargo.toml");
    const prewarm = rustPrewarmedTargetDir(store, lock, BuildTarget.Web);
    const hostile: Array<[string, () => Promise<unknown>]> = [
      ["the target folder is a link to a folder outside", () => plantIn(folder, () => symlink(outside, target))],
      ["the target folder is a link to the store's prewarm", () => plantIn(folder, () => symlink(prewarm, target))],
      ["the target folder is a file", () => plantIn(folder, () => writeFile(target, "a file"))],
      [
        "Cargo.toml is a link to a file outside",
        () => plantIn(folder, () => symlink(path.join(outside, "keep.txt"), manifest)),
      ],
      ["the session's key folder is a link outside", () => plantIn(gameFolder, () => symlink(outside, folder))],
      ["the game's folder is a link outside", () => plantIn(sessions, () => symlink(outside, gameFolder))],
      ["the sessions folder is a link outside", () => symlink(outside, sessions)],
    ];
    for (const [label, plant] of hostile) {
      await rm(sessions, { recursive: true, force: true });
      await plant();
      const outsideBefore = await listing(outside);
      const storeBefore = await listing(store);
      const rust = rustOf(await delegated("ferris"));
      assert.equal(rust.targetDir, target, `${label}: the session gets its target folder`);
      for (const dir of [sessions, gameFolder, folder, target]) {
        const found = await lstat(dir);
        assert.ok(found.isDirectory() && !found.isSymbolicLink(), `${label}: ${dir} is a folder of its own`);
      }
      assert.ok((await lstat(manifest)).isFile(), `${label}: the manifest is a file of its own`);
      assert.deepEqual(await listing(outside), outsideBefore, `${label}: nothing written outside`);
      assert.deepEqual(await listing(store), storeBefore, `${label}: nor into the store`);
    }
  });
});

/** A copy of a game folder's `genex.toml` and `src/` at `<game>/../<name>`, as a worktree holds them. */
async function worktree(gameDir: string, name: string): Promise<string> {
  const dir = path.join(path.dirname(gameDir), name);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "genex.toml"), await readFile(path.join(gameDir, "genex.toml")));
  await writeFile(path.join(dir, "src", "main.rs"), await readFile(path.join(gameDir, "src", "main.rs")));
  return realpath(dir);
}

/** Makes `parent` and plants something in it. */
async function plantIn(parent: string, plant: () => Promise<unknown>): Promise<void> {
  await mkdir(parent, { recursive: true });
  await plant();
}

describe("a Rust session's folders are the host's: no other agent process writes what a session runs", {
  skip: SKIP_ON_WINDOWS,
}, () => {
  it("keeps every session folder outside every root an agent process writes", async () => {
    const { core, delegated } = await rustCore();
    const rust = rustOf(await delegated("ferris"));
    const manifest = rust.env[RustSessionVariable.Manifest] ?? "";
    const writable = [
      core.layout.scratch,
      core.layout.workspaces,
      core.layout.gamesRoot,
      core.layout.exports,
      core.layout.runs,
    ];
    for (const root of writable) {
      const real = await realpath(root).catch(() => root);
      for (const own of [rust.targetDir ?? "", manifest])
        assert.equal(isInside(real, own), false, `${own} is not under ${root}`);
    }
  });

  it("never hands a session the person attends a target folder a sandboxed session wrote", async () => {
    const { lock, store, core } = await rustCore();
    const found = await locateRust(store, lock, BuildTarget.Web);
    assert.ok(found.ok);
    const root = await sessionsRoot(core);
    const workCwd = await worktree(core.games.dirFor("ferris"), "wt-shared");
    const lockLines = [await readWarmLock(store, lock, BuildTarget.Web)];
    const agent = await rustSessionFor({
      store,
      located: found.located,
      workCwd,
      home: { root, game: "ferris", attended: false },
      lockLines,
    });
    assert.ok(agent.targetDir);
    // What a sandboxed session (or anything it ran) left in its own target folder: a build script's binary.
    const planted = path.join(agent.targetDir, "debug", "build", "evil-0000", "build-script-build");
    await mkdir(path.dirname(planted), { recursive: true });
    await writeFile(planted, "#!/bin/sh\necho pwned\n");
    const person = await rustSessionFor({
      store,
      located: found.located,
      workCwd,
      home: { root, game: "ferris", attended: true },
      lockLines,
    });
    assert.ok(person.targetDir);
    assert.notEqual(person.targetDir, agent.targetDir, "a folder of its own");
    assert.equal(isInside(agent.targetDir, person.targetDir), false);
    assert.equal(
      await lstat(path.join(person.targetDir, "debug", "build", "evil-0000")).then(
        () => true,
        () => false,
      ),
      false,
      "nothing the sandboxed session built is in it",
    );
    assert.notEqual(person.env[RustSessionVariable.Manifest], agent.env[RustSessionVariable.Manifest]);
  });

  it("rewrites a manifest planted in a session folder before the shell gets it", async () => {
    const { lock, store, core } = await rustCore();
    const found = await locateRust(store, lock, BuildTarget.Web);
    assert.ok(found.ok);
    const home = { root: await sessionsRoot(core), game: "ferris", attended: true };
    const workCwd = await worktree(core.games.dirFor("ferris"), "wt-planted");
    const lockLines = [await readWarmLock(store, lock, BuildTarget.Web)];
    const first = await rustSessionFor({ store, located: found.located, workCwd, home, lockLines });
    const manifest = first.env[RustSessionVariable.Manifest] ?? "";
    const honest = await readFile(manifest, "utf8");
    await writeFile(manifest, `${honest}\n[package]\nbuild = "/abs/evil.rs"\n`);
    const again = await rustSessionFor({ store, located: found.located, workCwd, home, lockLines });
    assert.equal(again.env[RustSessionVariable.Manifest], manifest);
    assert.equal(await readFile(manifest, "utf8"), honest, "the host's manifest, never the planted one");
  });
});

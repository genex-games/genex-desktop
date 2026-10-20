/**
 * The harness RPC is an untrusted API (ARCH-1). The harness is agent-editable code, so every
 * folder it names over RPC is checked by realpath before the host reads, serves, builds or removes
 * anything: a studio worktree under scratch, or the named game's own registered folder, and
 * nothing else. Adoption, which widens the sandbox, is not on the harness's table at all.
 */
import { before, describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { realpathNearest } from "../../src/substrate/fsx.ts";
import { git } from "../../src/substrate/snapshots.ts";
import { lockOf, writeCurrentLock } from "../../src/substrate/toolchain-store/lock.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { cppLaneRunsOn } from "../../src/shared/toolchain.ts";
import { BuildProblemCode } from "../../src/shared/build-problem.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import type { LocatedToolchain } from "../../src/substrate/toolchain-store/locate.ts";
import { ExportError, ExportRefusal } from "../../src/shared/game-export-contract.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { hostOf } from "../../src/shared/game-targets.ts";
import { NATIVE_LEASES_MAX, NativeRefusal, NativeRunMode } from "../../src/shared/native-contract.ts";
import { ScaffoldCaller } from "../../src/substrate/game-workspace.ts";

type Api = Record<string, (input: unknown) => Promise<unknown>>;

const REFUSED = /refused|outside scratch|symlink/i;
const REFUSED_OR_OUTSIDE = /refused|outside this project|symlink/i;
const REFUSED_OR_CWD = /refused|delegation cwd must be/i;

let lite: CoreLite;
let api: Api;
let outside: string;
const loads: Array<{ project: string; root: string | undefined }> = [];
const sentinels: string[] = [];
const delegations: string[] = [];
let candidate: { candidateId: string; root: string };

async function sentinel(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "secret.txt"), "do not read\n");
  sentinels.push(dir);
}

before(async () => {
  // A port that records what it was asked to serve and then refuses: reaching it at all is the
  // side effect a hostile root must never have.
  const port = {
    async load(project: string, _entry: string, root?: string) {
      loads.push({ project, root });
      throw new Error("fake port: not serving");
    },
    status: () => ({ loadError: null, consoleErrors: [] }),
  };
  // The dev execution policy compares canonical paths, and the temp folder is behind /var → /private/var.
  lite = await coreLite({ preview: port as never, gamesRoot: await realpath(await tmpDir("studio-games-")) });
  api = lite.api() as unknown as Api;
  const { core } = lite;
  await core.games.scaffold("pong");
  // Registers the game with the snapshot engine, as a run does before it removes anything.
  await api["snapshot.worktree"]!({ project: "pong", name: "first", runId: "run-0" });
  // An optimization candidate opens only from a clean game with no links, so before they are planted.
  const baseline = (await api["snapshot.create"]!({ scope: "game", project: "pong", reason: "baseline" })) as {
    snapshot_id: string;
  };
  candidate = (await api["optimization.open"]!({
    project: "pong",
    runId: "run_tq1",
    baselineSnapshotId: baseline.snapshot_id,
  })) as { candidateId: string; root: string };

  outside = await tmpDir("studio-outside-");
  await sentinel(path.join(outside, ".ssh"));
  await sentinel(path.join(outside, "victim"));
  await sentinel(core.layout.secrets);
  const run = path.join(core.layout.scratch, "autopilot", "run-1");
  await mkdir(run, { recursive: true });
  // A symlinked root inside scratch, a symlinked parent component, and a "game" in the library
  // folder that is really a link to somewhere else — all writable by the harness's own processes.
  await symlink(path.join(outside, ".ssh"), path.join(run, "escape"));
  await symlink(outside, path.join(run, "linkdir"));
  await symlink(path.join(outside, ".ssh"), path.join(core.layout.gamesRoot, "evil"));
  // Links inside the game itself, the kind a contractor's shell can plant in one command.
  const game = core.games.dirFor("pong");
  await symlink(path.join(outside, "victim", "rc"), path.join(game, "planted-write.txt"));
  await symlink(path.join(outside, "victim", "secret.txt"), path.join(game, "planted-read.txt"));
  await symlink(path.join(outside, "victim"), path.join(game, "linkdir"));
  // A contractor that records where it was sent and does nothing else.
  core.engines.register({
    id: "fixture-delegate",
    label: "Fixture",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    delegate: async (request: { cwd: string }) => {
      delegations.push(request.cwd);
      return { ok: true, summary: "done", usage: {}, turns: 1, engine: "fixture-delegate" };
    },
  } as never);
});

function hostileRoots(): Array<{ label: string; root: string }> {
  const { layout } = lite.core;
  return [
    { label: "/etc", root: "/etc" },
    { label: "the userData secrets", root: layout.secrets },
    { label: "an ~/.ssh-like folder", root: path.join(outside, ".ssh") },
    { label: "a symlinked root inside scratch", root: path.join(layout.scratch, "autopilot", "run-1", "escape") },
    {
      label: "a symlinked component inside scratch",
      root: path.join(layout.scratch, "autopilot", "run-1", "linkdir", "victim"),
    },
    { label: "traversal out of scratch", root: path.join(layout.scratch, "autopilot", "..", "..", "secrets") },
    { label: "scratch itself", root: layout.scratch },
    { label: "the harness workspace", root: layout.harnessWs },
  ];
}

/** Bytes a file only the host can read carries (an engine's login): they must never reach a game. */
const HOST_ONLY_TOKEN = "sk-host-only-secret-5b21";

/**
 * The C++ lane's store and runs, stubbed on the lite core's real lane: `lock` located with an
 * em-cache and a genex.cmake, and runs that leave the page a build writes. Restored after the row.
 */
async function stubLane(t: TestContext, lock: ToolchainLock): Promise<{ runs: () => number }> {
  const { options } = lite.core.cppBuilds;
  const store = await realpath(await tmpDir("lane-store-"));
  const cache = path.join(store, "em-cache");
  await mkdir(cache, { recursive: true });
  const genex = path.join(store, "genex-web.cmake");
  await writeFile(genex, "# genex web\n");
  const toolchain: LocatedToolchain = {
    lock,
    cmake: path.join(store, "cmake"),
    ninja: path.join(store, "ninja"),
    emscripten: {
      root: store,
      toolchainFile: path.join(store, "cmake", "Modules", "Platform", "Emscripten.cmake"),
      python: path.join(store, "python3"),
      node: path.join(store, "node"),
      config: path.join(store, "emscripten.config"),
      cache,
    },
    genexCmake: { [BuildTarget.Web]: genex },
  };
  let count = 0;
  t.mock.method(options, "currentLock", async () => lock);
  t.mock.method(options, "locate", async () => ({ ok: true, toolchain }));
  t.mock.method(options, "run", async (request: RunRequest): Promise<RunResult> => {
    count++;
    if (request.command.includes(" '--build' ")) {
      await mkdir(path.join(request.cwd, "out"), { recursive: true });
      await writeFile(path.join(request.cwd, "out", "index.html"), "<!doctype html>");
    }
    return {
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
      sandboxed: false,
      command: request.command,
      cwd: request.cwd,
    };
  });
  return { runs: () => count };
}

/** Every path under `dir` with its size, sorted: a store's shape before and after. */
async function treeOf(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  const rows = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return `${path.relative(dir, file)} ${(await stat(file)).size}`;
    }),
  );
  return rows.sort();
}

/** How long one call of the toolchain sweep may run before the sweep moves on to the next. */
const SWEEP_CALL_MS = 2_000;

/** Calls `call` and waits until it settles, however it settles, or until {@link SWEEP_CALL_MS} pass. */
async function settled(call: () => Promise<unknown>): Promise<void> {
  const timer = new AbortController();
  const outcome = Promise.resolve()
    .then(call)
    .then(
      () => {},
      () => {},
    );
  await Promise.race([outcome, sleep(SWEEP_CALL_MS, undefined, { signal: timer.signal }).catch(() => {})]);
  timer.abort();
}

async function assertUntouched(label: string): Promise<void> {
  for (const dir of sentinels) assert.deepEqual(await readdir(dir), ["secret.txt"], `${label}: ${dir} is untouched`);
}

/** Spies on everything that could build or start a game, and on every way a run could end. */
function sideEffects(t: TestContext) {
  const { core } = lite;
  const spies = [
    t.mock.method(core.cppBuilds, "ensure"),
    t.mock.method(core.nativeRuns, "start"),
    t.mock.method(core.nativeRuns, "stop"),
    t.mock.method(core.nativeRuns, "stopAll"),
    t.mock.method(core.nativeRuns, "stopProject"),
    t.mock.method(core.nativeRuns, "stopMode"),
    t.mock.method(core.nativeRuns, "stopOwnedBy"),
    t.mock.method(core.nativeRuns, "stopAgentRuns"),
  ];
  return () => spies.map((spy) => spy.mock.callCount());
}
/** No build, no spawn and no stop of any kind. */
const NO_SIDE_EFFECTS = [0, 0, 0, 0, 0, 0, 0, 0];

/** One harness method, called as the harness would; a missing method fails the row. */
function call(method: string, input: unknown): Promise<unknown> {
  const handler = api[method];
  assert.ok(handler, method);
  return handler(input);
}

describe("harness RPC authority", () => {
  it("game.write refuses Git control paths before any filesystem or UI side effect", async () => {
    const game = lite.core.games.dirFor("pong");
    const config = path.join(game, ".git", "config");
    const original = await readFile(config, "utf8");
    const head = await lite.core.store.head(lite.core.mainThread);
    const files = [
      ".git/config",
      ".git/hooks/hostile",
      ".GIT/config",
      "levels/.git/config",
      ".git./config",
      ".git ::$DATA",
      "src/../.git/config",
      path.join(game, ".git", "config"),
    ];
    for (const file of files) {
      await assert.rejects(api["game.write"]!({ project: "pong", file, contents: "HOSTILE" }), /refused/i, file);
      assert.equal(await readFile(config, "utf8"), original, `${file}: config unchanged`);
      assert.equal(await lite.core.store.head(lite.core.mainThread), head, `${file}: no event appended`);
    }
    await assert.rejects(stat(path.join(game, "levels")), /ENOENT/);
    await assert.rejects(stat(path.join(game, ".git", "hooks", "hostile")), /ENOENT/);
    await api["game.write"]!({ project: "pong", file: "docs/.git-notes.md", contents: "safe" });
    assert.equal(await readFile(path.join(game, "docs", ".git-notes.md"), "utf8"), "safe");
  });

  it("a harness preview.load of a raylib game whose lock names an uninstalled version is refused toolchain-missing, and the store is unchanged", async (t) => {
    const { core } = lite;
    const game = await core.games.scaffold("pong-raylib", {
      title: "Pong raylib",
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Web],
    });
    const lock = lockOf({ cmake: { version: "9.9.9", sha12: "deadbeef0000" } });
    await writeCurrentLock(core.layout.toolchains, lock);
    const studioJson = path.join(game.dir, "studio.json");
    const recorded = await readFile(studioJson, "utf8");
    const locks = await core.games.nativeLocks();
    const store = await treeOf(core.layout.toolchains);
    const reached = [
      t.mock.method(core.toolchains, "install"),
      t.mock.method(core.toolchains, "installClt"),
      t.mock.method(core.toolchains, "prune"),
      t.mock.method(core.games, "writeNativeLock"),
    ];
    const load = api["preview.load"];
    assert.ok(load);
    loads.length = 0;
    await load({ project: "pong-raylib" });
    assert.deepEqual(loads, [], "nothing reached the preview");
    assert.equal(
      core.buildProblem("pong-raylib")?.reason,
      process.platform === StudioPlatform.Windows
        ? BuildProblemCode.UnsupportedHost
        : BuildProblemCode.ToolchainMissing,
    );
    assert.deepEqual(
      reached.map((spy) => spy.mock.callCount()),
      [0, 0, 0, 0],
      "no install, no Command Line Tools, no prune, no lock written",
    );
    assert.equal(await readFile(studioJson, "utf8"), recorded, "studio.json is as it was");
    assert.deepEqual(await core.games.nativeLocks(), locks, "no lock recorded");
    assert.deepEqual(await treeOf(core.layout.toolchains), store, "the store is unchanged");
  });

  /**
   * A harness preview.load of the game folder is a Live build, and a Live build that works
   * records its lock: in the host's own library, never in the game. studio.json is the agent's to
   * write, so a link planted there to a file only the host can read must stay a link, and none of
   * that file may reach the game. The lane is real; only its runs and its store are stubs.
   */
  it("a harness preview.load that builds records the lock in the host's library, never through a studio.json link", {
    skip: !cppLaneRunsOn(process.platform) && "this host has no C++ build lane",
  }, async (t) => {
    const { core } = lite;
    const game = await core.games.scaffold("lock-raylib", {
      title: "Lock",
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Web],
    });
    const secret = path.join(outside, "engine-auth.json");
    await writeFile(secret, JSON.stringify({ access_token: HOST_ONLY_TOKEN }));
    const studioJson = path.join(game.dir, "studio.json");
    await rm(studioJson);
    await symlink(secret, studioJson);
    const lock = lockOf({ cmake: { version: "4.4.3", sha12: "0123456789ab" } });
    const stubs = await stubLane(t, lock);
    const recorded = t.mock.method(core.games, "writeNativeLock");
    loads.length = 0;
    // The fake port refuses to serve: reaching it at all means the build worked and served its page.
    await assert.rejects(api["preview.load"]!({ project: "lock-raylib" }), /not serving/);
    assert.equal(loads.length, 1, "the lane's page reached the preview");
    assert.equal(core.buildProblem("lock-raylib"), null, "the stubbed build worked");
    assert.equal(stubs.runs(), 2, "configure and build ran through the lane");
    assert.deepEqual(
      recorded.mock.calls.map((call) => call.arguments),
      [["lock-raylib", lock.digest]],
      "the lane recorded the lock it built with, once",
    );
    assert.ok((await core.games.nativeLocks()).includes(lock.digest));
    assert.equal(await readlink(studioJson), secret, "studio.json is still the link it was");
    assert.equal(await readFile(secret, "utf8"), JSON.stringify({ access_token: HOST_ONLY_TOKEN }));
    for (const entry of await readdir(game.dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const text = await readFile(path.join(entry.parentPath, entry.name), "utf8");
      assert.ok(!text.includes(HOST_ONLY_TOKEN), `${entry.name} holds nothing of the host-only file`);
    }
  });

  it("adoption, which widens the sandbox, is not on the harness's table", () => {
    assert.equal("game.adopt" in api, false);
    assert.equal(typeof lite.core.adoptProject, "function", "the user's own Open Game path still adopts");
  });

  for (const method of ["preview.load", "game.attached"]) {
    it(`${method} refuses every folder that is not a studio worktree or the game's own`, async () => {
      for (const { label, root } of hostileRoots()) {
        loads.length = 0;
        await assert.rejects(api[method]!({ project: "pong", root }), REFUSED, `${method}: ${label}`);
        assert.deepEqual(loads, [], `${method}: ${label} never reached the preview`);
        await assertUntouched(`${method}: ${label}`);
      }
      // A game whose library folder is a symlink out of the library is no registered game.
      for (const params of [
        { project: "evil" },
        { project: "evil", root: path.join(lite.core.layout.gamesRoot, "evil") },
      ]) {
        loads.length = 0;
        await assert.rejects(api[method]!(params), REFUSED, `${method}: ${JSON.stringify(params)}`);
        assert.deepEqual(loads, [], `${method}: the linked "game" never reached the preview`);
      }
    });
  }

  it("preview.load still serves a studio worktree and the game's own folder", async () => {
    const { core } = lite;
    const worktree = (await api["snapshot.worktree"]!({ project: "pong", name: "facet-a", runId: "run-2" })) as {
      path: string;
    };
    for (const root of [worktree.path, core.games.dirFor("pong")]) {
      loads.length = 0;
      await assert.rejects(api["preview.load"]!({ project: "pong", root }), /fake port/, root);
      assert.equal(loads.length, 1, `${root} reached the preview`);
    }
    await api["snapshot.removeWorktree"]!({ project: "pong", path: worktree.path });
  });

  it("snapshot.removeWorktree removes nothing outside scratch, whatever the path says", async () => {
    for (const { label, root } of hostileRoots()) {
      await assert.rejects(api["snapshot.removeWorktree"]!({ project: "pong", path: root }), REFUSED, label);
      await assertUntouched(`removeWorktree: ${label}`);
    }
  });

  /**
   * TQ-1: game.write and game.read checked containment lexically, so a link the harness's own
   * processes planted in the game (`notes.txt -> ~/.bashrc`) took the host's write, or its read,
   * straight out of the folder.
   */
  function plantedGameLinks(): Array<{ label: string; file: string }> {
    const { layout } = lite.core;
    return [
      { label: "a link leaf out of the game", file: "planted-write.txt" },
      { label: "a link leaf onto an existing outside file", file: "planted-read.txt" },
      { label: "a linked folder inside the game", file: "linkdir/new.txt" },
      { label: "an absolute outside path", file: path.join(outside, "victim", "abs.txt") },
      { label: "the userData secrets", file: path.join(layout.secrets, "secret.txt") },
      { label: "traversal out of the game", file: "../../victim.txt" },
    ];
  }

  it("game.write writes nothing outside the game, whatever links the folder holds", async () => {
    for (const { label, file } of plantedGameLinks()) {
      await assert.rejects(
        api["game.write"]!({ project: "pong", file, contents: "PWNED" }),
        REFUSED_OR_OUTSIDE,
        `game.write: ${label}`,
      );
      await assertUntouched(`game.write: ${label}`);
      for (const dir of sentinels)
        assert.equal(await readFile(path.join(dir, "secret.txt"), "utf8"), "do not read\n", `${label}: ${dir}`);
    }
    // The game's own files, and a link that stays inside it, are still the harness's to write.
    await api["game.write"]!({ project: "pong", file: "notes/own.txt", contents: "mine" });
    assert.equal(await readFile(path.join(lite.core.games.dirFor("pong"), "notes", "own.txt"), "utf8"), "mine");
  });

  it("game.read reads nothing outside the game through a link", async () => {
    for (const { label, file } of plantedGameLinks()) {
      await assert.rejects(api["game.read"]!({ project: "pong", file }), REFUSED_OR_OUTSIDE, `game.read: ${label}`);
    }
    assert.equal(await api["game.read"]!({ project: "pong", file: "notes/own.txt" }), "mine");
  });

  it("game.write and game.read on an optimization candidate refuse the same links", async () => {
    await symlink(path.join(outside, "victim", "rc"), path.join(candidate.root, "planted-write.txt"));
    await symlink(path.join(outside, "victim", "secret.txt"), path.join(candidate.root, "planted-read.txt"));
    await symlink(path.join(outside, "victim"), path.join(candidate.root, "linkdir"));
    for (const { label, file } of plantedGameLinks()) {
      await assert.rejects(
        api["game.write"]!({ project: "pong", candidateId: candidate.candidateId, file, contents: "PWNED" }),
        /escapes|symlink/,
        `candidate write: ${label}`,
      );
      await assert.rejects(
        api["game.read"]!({ project: "pong", candidateId: candidate.candidateId, file }),
        /escapes|symlink/,
        `candidate read: ${label}`,
      );
      await assertUntouched(`candidate: ${label}`);
    }
  });

  /**
   * A game's `.claude` folder holds Claude Code's project settings: allow rules and hooks that
   * the person's own, unsandboxed session in the game loads (`settingSources: ["project"]`). The
   * harness writes it under no spelling, and lands no build or candidate that changes it.
   */
  it("game.write never writes a game's or a candidate's .claude folder", async () => {
    const game = lite.core.games.dirFor("pong");
    // The person's own settings folder exists, and a link inside the game points at it.
    await mkdir(path.join(game, ".claude"), { recursive: true });
    await symlink(path.join(game, ".claude"), path.join(game, "cfg"));
    const spellings = [
      ".claude/settings.json",
      ".CLAUDE/settings.local.json",
      ".Claude/commands/deploy.md",
      "src/../.claude/settings.json",
      "levels/.claude/settings.json",
      ".claude./settings.json",
      ".claude ::$DATA",
      "cfg/settings.json",
      path.join(game, ".claude", "hooks.json"),
    ];
    for (const file of spellings) {
      await assert.rejects(
        api["game.write"]!({ project: "pong", file, contents: '{"hooks":{}}' }),
        /refused.*\.claude/,
        `game.write: ${file}`,
      );
    }
    assert.deepEqual(await readdir(path.join(game, ".claude")), [], "nothing landed in the settings folder");
    await assert.rejects(stat(path.join(game, "levels", ".claude")), /ENOENT/);
    for (const file of [".claude/settings.json", "src/.Claude/agents/x.md"]) {
      await assert.rejects(
        api["game.write"]!({ project: "pong", candidateId: candidate.candidateId, file, contents: "{}" }),
        /refused.*\.claude/,
        `candidate write: ${file}`,
      );
    }
    await assert.rejects(stat(path.join(candidate.root, ".claude")), /ENOENT/);
    // A look-alike name is still the game's own file.
    await api["game.write"]!({ project: "pong", file: "docs/.claude-notes.md", contents: "ok" });
    assert.equal(await readFile(path.join(game, "docs", ".claude-notes.md"), "utf8"), "ok");
    // The harness's own processes and its commands are held to it by the sandbox, from boot.
    if (process.platform === "darwin")
      assert.ok(
        lite.core.sandbox.policy.denyWrite.includes(
          path.join(lite.core.layout.gamesRoot, "*", "[.][cC][lL][aA][uU][dD][eE]"),
        ),
      );
  });

  it("no build lands in a game when it changes the game's .claude folder", async () => {
    const { core } = lite;
    const game = core.games.dirFor("pong");
    const worktree = (await api["snapshot.worktree"]!({ project: "pong", name: "hooked", runId: "run-3" })) as {
      path: string;
    };
    await mkdir(path.join(worktree.path, ".claude"), { recursive: true });
    await writeFile(path.join(worktree.path, ".claude", "settings.json"), '{"hooks":{}}');
    await git(worktree.path, ["add", "-A"]);
    await git(worktree.path, ["commit", "-q", "-m", "run: plant settings"]);
    const head = (await git(worktree.path, ["rev-parse", "HEAD"])).trim();
    await assert.rejects(core.landBuild("pong", head), /\.claude folder/);
    await assert.rejects(stat(path.join(game, ".claude", "settings.json")), /ENOENT/);
    await api["snapshot.removeWorktree"]!({ project: "pong", path: worktree.path });
  });

  it("game.export writes only into the studio's exports folder", async () => {
    for (const { label, root } of [
      ...hostileRoots(),
      { label: "a new folder beside a sentinel", root: path.join(outside, "victim", "export") },
    ]) {
      await assert.rejects(api["game.export"]!({ project: "pong", target: root }), REFUSED, `game.export: ${label}`);
      await assertUntouched(`game.export: ${label}`);
    }
    await assert.rejects(
      api["game.export"]!({ project: "../secrets" }),
      REFUSED,
      "a project name that climbs out of the library",
    );
  });

  it("game.export refuses a hostile destination, a malformed signing and any signing by identity, before anything runs", async (t) => {
    const { core } = lite;
    const exportGame = api["game.export"];
    assert.ok(exportGame, "game.export is on the harness's table");
    const ensure = t.mock.method(core.cppBuilds, "ensure");
    const exporter = t.mock.method(core.games, "export");
    const published = async () => (await readdir(core.layout.exports).catch(() => [])).sort();
    const before = await published();
    const identity = { kind: "developer-id", identity: "Developer ID Application: Pat Example (ABCDE12345)" };
    const rows: Array<[string, Record<string, unknown>, ExportRefusal]> = [
      ["destination ios", { project: "pong", destination: "ios" }, ExportRefusal.NotADestination],
      ["destination 1", { project: "pong", destination: 1 }, ExportRefusal.NotADestination],
      ["destination ../web", { project: "pong", destination: "../web" }, ExportRefusal.NotADestination],
      [
        "a Developer ID signing",
        { project: "pong", destination: "macos", signing: identity },
        ExportRefusal.HarnessMayNotSign,
      ],
      [
        "a malformed signing",
        { project: "pong", destination: "macos", signing: "adhoc" },
        ExportRefusal.SigningInvalid,
      ],
      ["a signed browser folder", { project: "pong", signing: { kind: "adhoc" } }, ExportRefusal.SigningInvalid],
    ];
    for (const [label, params, code] of rows) {
      await assert.rejects(
        exportGame(params),
        (error: unknown) => error instanceof ExportError && error.code === code,
        `game.export: ${label}`,
      );
      assert.equal(ensure.mock.callCount(), 0, `${label}: nothing built`);
      assert.equal(exporter.mock.callCount(), 0, `${label}: nothing exported`);
      assert.deepEqual(await published(), before, `${label}: nothing written`);
      await assertUntouched(`game.export: ${label}`);
    }
  });

  it("engine.delegate sends a contractor into no folder but the game's own or a real studio worktree", async () => {
    for (const { label, root } of hostileRoots()) {
      delegations.length = 0;
      await assert.rejects(
        api["engine.delegate"]!({ engine: "fixture-delegate", project: "pong", prompt: "build", cwd: root }),
        REFUSED_OR_CWD,
        `engine.delegate: ${label}`,
      );
      assert.deepEqual(delegations, [], `engine.delegate: ${label} never reached a contractor`);
    }
    const worktree = (await api["snapshot.worktree"]!({ project: "pong", name: "facet-d", runId: "run-4" })) as {
      path: string;
    };
    for (const cwd of [worktree.path, lite.core.games.dirFor("pong")]) {
      delegations.length = 0;
      await api["engine.delegate"]!({
        engine: "fixture-delegate",
        project: "pong",
        prompt: "build",
        cwd,
        timeoutMs: 1_000,
      });
      assert.equal(delegations.length, 1, `${cwd} reached the contractor`);
    }
    await api["snapshot.removeWorktree"]!({ project: "pong", path: worktree.path });
  });

  it("snapshot.removeWorktree still removes a studio worktree", async () => {
    const worktree = (await api["snapshot.worktree"]!({ project: "pong", name: "facet-b", runId: "run-3" })) as {
      path: string;
    };
    assert.equal(await api["snapshot.removeWorktree"]!({ project: "pong", path: worktree.path }), true);
    await assert.rejects(readdir(worktree.path), /ENOENT/);
  });

  /**
   * H1: a revision the harness names reaches git as an argument. An option-shaped one
   * (`--output=<file>`) was parsed as an option, and git wrote wherever it said.
   */
  it("snapshot.diff and snapshot.worktree refuse a revision git would read as an option", async () => {
    const written = path.join(outside, "victim", "d.txt");
    await assert.rejects(api["snapshot.diff"]!({ workspace: "pong", from: `--output=${written}` }), /not a commit/i);
    await assert.rejects(
      api["snapshot.diff"]!({ workspace: "pong", from: "HEAD", to: `--output=${written}` }),
      /not a commit/i,
    );
    await assert.rejects(stat(written), /ENOENT/, "git wrote nothing outside the game");
    await assertUntouched("snapshot.diff with an option-shaped revision");
    await assert.rejects(
      api["snapshot.worktree"]!({ project: "pong", name: "orphaned", runId: "run-5", commit: "--orphan" }),
      /not a commit/i,
    );
    await assert.rejects(stat(path.join(lite.core.layout.scratch, "autopilot", "run-5", "orphaned")), /ENOENT/);
    // A real revision still diffs.
    assert.equal(typeof (await api["snapshot.diff"]!({ workspace: "pong", from: "HEAD" })), "string");
  });

  /** H2: the worktree folder is removed and recreated host-side; a linked runId carried that rm out of scratch. */
  it("snapshot.worktree removes and creates nothing through a link planted under scratch", async () => {
    await mkdir(path.join(lite.core.layout.scratch, "autopilot"), { recursive: true });
    await symlink(outside, path.join(lite.core.layout.scratch, "autopilot", "linked"));
    await assert.rejects(api["snapshot.worktree"]!({ project: "pong", name: "victim", runId: "linked" }), REFUSED);
    await assertUntouched("snapshot.worktree through a linked runId");
  });

  /** M1: the folder the host checked is the folder it serves and sends a contractor to, not a path re-resolved later. */
  it("preview.load hands the preview the real path it checked", async () => {
    const worktree = (await api["snapshot.worktree"]!({ project: "pong", name: "facet-real", runId: "run-6" })) as {
      path: string;
    };
    // Named through scratch as configured, which in a temp folder runs through /var -> /private/var.
    const named = path.join(lite.core.layout.scratch, "autopilot", "run-6", "facet-real");
    loads.length = 0;
    await assert.rejects(api["preview.load"]!({ project: "pong", root: named }), /fake port/);
    assert.deepEqual(
      loads.map((l) => l.root),
      [await realpath(named)],
    );
    await api["snapshot.removeWorktree"]!({ project: "pong", path: worktree.path });
  });

  it("engine.delegate sends a contractor to the real path it checked", async () => {
    await api["snapshot.worktree"]!({ project: "pong", name: "facet-cwd", runId: "run-7" });
    const named = path.join(lite.core.layout.scratch, "autopilot", "run-7", "facet-cwd");
    const real = await realpath(named);
    delegations.length = 0;
    await api["engine.delegate"]!({
      engine: "fixture-delegate",
      project: "pong",
      prompt: "build",
      cwd: named,
      timeoutMs: 1_000,
    });
    assert.deepEqual(delegations, [real]);
    await api["snapshot.removeWorktree"]!({ project: "pong", path: named });
    await assert.rejects(readdir(real), /ENOENT/, "removed by the name it was created under, too");
  });

  /** M2: a dangling link inside the game passed the containment check as a folder still to be made. */
  it("game.write writes nothing through a dangling link, before or after its target appears", async () => {
    const later = path.join(outside, "later");
    await symlink(later, path.join(lite.core.games.dirFor("pong"), "dangle"));
    await assert.rejects(
      api["game.write"]!({ project: "pong", file: "dangle/x.txt", contents: "PWNED" }),
      REFUSED_OR_OUTSIDE,
    );
    await assert.rejects(stat(later), /ENOENT/, "the write created nothing outside the game");
    await mkdir(later);
    await assert.rejects(
      api["game.write"]!({ project: "pong", file: "dangle/x.txt", contents: "PWNED" }),
      REFUSED_OR_OUTSIDE,
    );
    assert.deepEqual(await readdir(later), []);
  });

  /**
   * Native runs (C++ · raylib): `native.build`, `native.status` and `native.stop` name a library
   * game and, for a build, a root `assertHarnessRoot` checks; a target outside the destinations'
   * vocabulary, or one this host cannot run, is refused before any lease or build exists; and a
   * harness never reaches the person's Play window. Every hostile row builds, spawns and writes nothing.
   */
  describe("native runs", () => {
    before(async () => {
      await lite.core.games.scaffold("native-pong", {
        title: "Native Pong",
        stack: GameStack.RaylibCpp,
        caller: ScaffoldCaller.Internal,
        targets: [BuildTarget.Web, BuildTarget.Mac],
      });
    });

    it("native.build refuses a hostile root before anything builds", async (t) => {
      const calls = sideEffects(t);
      for (const { label, root } of hostileRoots()) {
        await assert.rejects(
          call(HostMethod.NativeBuild, { project: "native-pong", target: BuildTarget.Mac, root }),
          REFUSED_OR_OUTSIDE,
          label,
        );
      }
      assert.deepEqual(calls(), NO_SIDE_EFFECTS, "no build, no spawn");
      await assertUntouched("native.build");
    });

    it("native.build, native.status, native.stop and game.crashes refuse a game that is not in the library", async (t) => {
      const calls = sideEffects(t);
      const { layout } = lite.core;
      const hostile = [
        "../native-pong",
        "/etc",
        path.join(outside, ".ssh"),
        "evil",
        path.join(layout.gamesRoot, "..", "secrets"),
        path.basename(path.dirname(layout.gamesRoot)),
      ];
      for (const project of hostile) {
        const target = BuildTarget.Mac;
        await assert.rejects(call(HostMethod.NativeBuild, { project, target }), REFUSED_OR_OUTSIDE, `build ${project}`);
        await assert.rejects(call(HostMethod.NativeStatus, { project }), REFUSED_OR_OUTSIDE, `status ${project}`);
        await assert.rejects(call(HostMethod.NativeStop, { project }), REFUSED_OR_OUTSIDE, `stop ${project}`);
        await assert.rejects(call(HostMethod.GameCrashes, { project }), REFUSED_OR_OUTSIDE, `crashes ${project}`);
      }
      assert.deepEqual(calls(), NO_SIDE_EFFECTS, "no build, no spawn, no stop");
      await assertUntouched("native.status/stop");
    });

    it("a target outside the destinations is refused for native.build and preview.acquire, with no lease", async (t) => {
      const calls = sideEffects(t);
      for (const target of ["ios", 1, null, "../macos", { macos: true }]) {
        await assert.rejects(call(HostMethod.NativeBuild, { project: "native-pong", target }), String(target));
        await assert.rejects(call(HostMethod.PreviewAcquire, { label: "evidence", target }), String(target));
      }
      const capacity = (await call(HostMethod.PreviewCapacity, {})) as { inUse: number; native?: { leases: number } };
      assert.equal(capacity.inUse, 0);
      assert.equal(capacity.native?.leases, 0);
      assert.deepEqual(calls(), NO_SIDE_EFFECTS);
    });

    it("preview.acquire for a destination this host cannot run is refused not-runnable-here before any lease", async (t) => {
      const calls = sideEffects(t);
      const foreign = process.platform === "win32" ? BuildTarget.Linux : BuildTarget.Windows;
      const refused = await call(HostMethod.PreviewAcquire, { label: "evidence", target: foreign }).then(
        () => null,
        (error: unknown) => error as { refusal?: string },
      );
      assert.equal(refused?.refusal, NativeRefusal.NotRunnableHere);
      const capacity = (await call(HostMethod.PreviewCapacity, {})) as {
        inUse: number;
        host?: string | null;
        native?: { leases: number; max: number };
      };
      assert.equal(capacity.inUse, 0);
      assert.equal(capacity.native?.leases, 0);
      assert.equal(capacity.native?.max, NATIVE_LEASES_MAX);
      assert.equal(capacity.host, hostOf(process.platform));
      assert.deepEqual(calls(), NO_SIDE_EFFECTS);
    });

    it("native.stop never stops the person's window", async (t) => {
      const calls = sideEffects(t);
      t.mock.method(lite.core.nativeRuns, "state", () => ({
        project: "native-pong",
        runId: "window1",
        mode: NativeRunMode.Window,
      }));
      assert.equal(await call(HostMethod.NativeStop, { project: "native-pong" }), false);
      assert.equal(await call(HostMethod.NativeStop, { project: "native-pong", handle: "window1" }), false);
      assert.deepEqual(calls(), NO_SIDE_EFFECTS, "no run of any kind was stopped");
    });
  });

  /**
   * The C++ toolchain is the person's: installs, pruning and Apple's Command Line Tools dialog
   * start from the Toolchain sheet and Settings (native IPC). No harness method reaches any of
   * them under any name: every method on the table is called with an empty payload and with a
   * raylib game's. (A Live build the harness asks for does record its lock, through the lane:
   * the row above.) It runs last, since some of those calls change the profile.
   * `guardian.rebuild_and_restart` is not called: its one job is to restart the harness process a
   * moment later, which would outlive this file.
   */
  it("no harness method installs a toolchain, runs xcode-select or prunes the store", async (t) => {
    const { core } = lite;
    await core.games.scaffold("sweep-raylib", {
      title: "Sweep",
      stack: GameStack.RaylibCpp,
      caller: ScaffoldCaller.Internal,
      targets: [BuildTarget.Web, BuildTarget.Mac],
    });
    const reached = [
      t.mock.method(core.toolchains, "install"),
      t.mock.method(core.toolchains, "installClt"),
      t.mock.method(core.toolchains, "prune"),
    ];
    const swept = Object.entries(api).filter(([method]) => method !== HostMethod.GuardianRebuildAndRestart);
    const names = swept.map(([method]) => method);
    assert.ok(names.includes(HostMethod.PreviewLoad) && names.includes(HostMethod.GameExport), "it covers the builds");
    for (const [, call] of swept)
      for (const payload of [{}, { project: "sweep-raylib" }]) await settled(() => call(payload));
    assert.deepEqual(
      reached.map((spy) => spy.mock.callCount()),
      [0, 0, 0],
      "no install, no Command Line Tools, no prune",
    );
  });
});

describe("realpathNearest", () => {
  it("resolves a path still to be made, and refuses one that runs through a dangling link", async () => {
    const base = await realpath(await tmpDir("nearest-"));
    await mkdir(path.join(base, "real"));
    assert.equal(
      await realpathNearest(path.join(base, "real", "new", "x.txt")),
      path.join(base, "real", "new", "x.txt"),
    );
    await symlink(path.join(base, "elsewhere", "later"), path.join(base, "real", "dangle"));
    for (const target of ["dangle", "dangle/x.txt", "dangle/a/b"]) {
      await assert.rejects(realpathNearest(path.join(base, "real", target)), /symlink/, target);
    }
    await assert.rejects(stat(path.join(base, "elsewhere")), /ENOENT/, "nothing was created on the way");
  });

  it("refuses in words a link that cannot be followed at all: a loop, or on Windows a file link to a folder", async () => {
    const base = await realpath(await tmpDir("nearest-loop-"));
    await symlink(path.join(base, "b"), path.join(base, "a"));
    await symlink(path.join(base, "a"), path.join(base, "b"));
    await assert.rejects(realpathNearest(path.join(base, "a")), /refused: .* is a symlink/);
  });
});

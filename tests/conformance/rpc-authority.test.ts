/**
 * The harness RPC is an untrusted API (ARCH-1). The harness is agent-editable code, so every
 * folder it names over RPC is checked by realpath before the host reads, serves, builds or removes
 * anything: a studio worktree under scratch, or the named game's own registered folder, and
 * nothing else. Adoption, which widens the sandbox, is not on the harness's table at all.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { realpathNearest } from "../../src/substrate/fsx.ts";
import { git } from "../../src/substrate/snapshots.ts";

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

async function assertUntouched(label: string): Promise<void> {
  for (const dir of sentinels) assert.deepEqual(await readdir(dir), ["secret.txt"], `${label}: ${dir} is untouched`);
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

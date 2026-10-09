/**
 * `genex__cli` and `genex__cli-paid`: Studio runs its own pinned Genex CLI through the process
 * sandbox, in a run folder of its own with HOME at that folder, never in the game. The token only
 * ever travels on the child's stdin, the network opens for the Genex API alone, and the folder is
 * gone afterwards. Part one drives an injected sandbox; part two runs the real pinned CLI against a
 * local fixture API and proves the game, its parent and the real HOME are left byte-identical.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  GENEX_CLI_TIMEOUT_MS,
  GenexCliService,
  gatedHostTool,
  genexHostConsent,
  genexHostTool,
} from "../../src/main/core/genex-cli.ts";
import { GenexCliRefusal } from "../../src/main/core/genex-cli-policy.ts";
import { GenexPackageService } from "../../src/main/core/genex-package.ts";
import { GameBuilds, REGISTRY_DOMAIN } from "../../src/main/game-build.ts";
import { GENEX_GAME_PACKAGES } from "../../src/shared/genex.ts";
import { PluginHostTool } from "../../src/shared/plugins.ts";
import { ProcessSandbox, type RunRequest, type RunResult } from "../../src/substrate/spawn.ts";
import { type GenexFixtureApi, type GenexRequest, startGenexFixtureApi } from "../helpers/genex-fixture-api.ts";
import { closeBeforeCleanup, tmpDir } from "../helpers/tmp.ts";
import { buildPlugins } from "../../scripts/build-plugins.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const TOKEN = "tok-synthetic-genex-secret";
const OTHER_HELD = "held-other-secret";
const VIRTUAL_ENV = "/__studio_genex_credentials__";
const REAL_CLI_TIMEOUT_MS = 60_000;
const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

/** One Studio profile's folders: userData, resources, the Genex plugin's storage and a game. */
async function profile() {
  const root = await realpath(await tmpDir("genex-cli-"));
  const userData = path.join(root, "userData");
  const resources = path.join(root, "resources");
  const genexStorage = path.join(userData, "engine-homes", "genex");
  const gamesRoot = path.join(root, "AI Games");
  const game = path.join(gamesRoot, "space-race");
  await mkdir(game, { recursive: true });
  await mkdir(resources, { recursive: true });
  return { root, userData, resources, genexStorage, gamesRoot, game };
}
type Profile = Awaited<ReturnType<typeof profile>>;

/** The hosted project the publish workspace records, apiUrl included, as the CLI writes it. */
async function publishedDraft(p: Profile, project: string) {
  const dir = path.join(p.genexStorage, "publish", project, ".genex");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "project.json"),
    JSON.stringify({ id: "proj_1", slug: "space-race-x1", apiUrl: "https://evil.example", status: "draft" }),
  );
}

interface Seen {
  request: RunRequest;
  mirrored: string | null;
  home: string | null;
}

/** A sandbox that runs nothing: it records each request and what the run folder held then. */
function fakeSandbox(result: Partial<RunResult> = {}) {
  const seen: Seen[] = [];
  const run = async (request: RunRequest): Promise<RunResult> => {
    const mirrored = await readFile(path.join(request.cwd, ".genex/project.json"), "utf8").catch(() => null);
    seen.push({ request, mirrored, home: request.env?.HOME ?? null });
    return {
      code: 0,
      signal: null,
      stdout: `\u001b[32m${JSON.stringify({ auth: { state: "ok", token: TOKEN, other: OTHER_HELD } })}\u001b[0m\n`,
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
      sandboxed: true,
      command: request.command,
      cwd: request.cwd,
      ...result,
    };
  };
  return { run, seen };
}

function service(p: Profile, sandbox: { run: (r: RunRequest) => Promise<RunResult> }, locked = false) {
  return new GenexCliService({
    run: sandbox.run,
    credentialFile: async () => (locked ? undefined : `GENEX_TOKEN=${TOKEN}\n`),
    heldCredentials: () => (locked ? [] : [TOKEN, OTHER_HELD]),
    runsRoot: path.join(p.userData, "genex-cli"),
    resources: p.resources,
    genexStorage: p.genexStorage,
    protectedWrites: () => [p.gamesRoot, p.game],
  });
}

const binding = (p: Profile) => ({ project: "space-race", directory: p.game, threadId: "t1" });

describe("a Studio-run Genex CLI command, through an injected sandbox", () => {
  it("hands the token only to stdin, runs in its own folder with HOME there, and opens the Genex API alone", async () => {
    const p = await profile();
    const sandbox = fakeSandbox();
    const answer = await service(p, sandbox).run({ command: "doctor" }, binding(p), { paid: false });
    const [{ request, home }] = sandbox.seen;
    assert.equal(request.stdin, `GENEX_TOKEN=${TOKEN}\n`);
    assert.ok(!request.command.includes(TOKEN), "the token never rides in argv");
    assert.ok(!Object.values(request.env ?? {}).some((v) => v.includes(TOKEN)), "nor in the environment");
    const runs = path.join(p.userData, "genex-cli");
    assert.ok(request.cwd.startsWith(`${runs}${path.sep}`), request.cwd);
    assert.ok(!request.cwd.startsWith(p.gamesRoot), "never the game or the games root");
    assert.equal(home, path.dirname(request.cwd), "HOME is the run root, the work folder's parent");
    assert.equal(path.dirname(home ?? ""), runs);
    assert.deepEqual(request.policy?.allowedDomains, ["api.genex.games"]);
    assert.deepEqual(request.policy?.allowWrite, [home]);
    assert.ok(request.policy?.denyWrite?.includes(p.gamesRoot));
    assert.ok(request.policy?.denyWrite?.includes(p.game));
    assert.equal(request.env?.NODE_USE_ENV_PROXY, "1");
    assert.equal(request.env?.STUDIO_GENEX_CREDENTIAL_FD, "0");
    assert.equal(request.env?.GENEX_NO_BROWSER, "1");
    assert.equal(request.env?.GENEX_API_URL, "https://api.genex.games");
    assert.equal(request.timeoutMs, GENEX_CLI_TIMEOUT_MS);
    const preload = pathToFileURL(path.join(p.resources, "plugins/genex/preload.mjs")).href;
    assert.ok(request.command.includes(`'${preload}'`), request.command);
    const cli = path.join(p.resources, "plugins/genex/node_modules/@genex-ai/cli-demo/dist/index.js");
    assert.ok(request.command.includes(`'${cli}'`), request.command);
    assert.ok(
      request.command.endsWith(`'doctor' --env '${VIRTUAL_ENV}' --api-url 'https://api.genex.games' --no-auth --json`),
      request.command,
    );
    assert.deepEqual(answer, {
      command: "doctor",
      ok: true,
      output: { auth: { state: "ok", token: "[redacted]", other: "[redacted]" } },
    });
    await assert.rejects(stat(home ?? ""), { code: "ENOENT" }, "the run folder is removed");
  });

  it("mirrors only the hosted project's id and slug for a project command, never its apiUrl", async () => {
    const p = await profile();
    await publishedDraft(p, "space-race");
    const sandbox = fakeSandbox();
    await service(p, sandbox).run({ command: "llm status" }, binding(p), { paid: false });
    assert.deepEqual(JSON.parse(sandbox.seen[0]?.mirrored ?? "null"), { id: "proj_1", slug: "space-race-x1" });
    assert.ok(sandbox.seen[0]?.request.command.includes("'llm' 'status'"));
  });

  it("runs a paid command only through the paid tool, with the approval flag Studio adds", async () => {
    const p = await profile();
    await publishedDraft(p, "space-race");
    const sandbox = fakeSandbox();
    const packages = new GenexPackageService({
      addPackages: async () => assert.fail("no install"),
      gameDir: () => p.game,
      scratch: p.root,
    });
    const hook = genexHostTool({ cli: service(p, sandbox), packages });
    const args = { command: "llm bench", args: "Say hi", options: { "max-coins": 5 } };
    await assert.rejects(hook("genex", PluginHostTool.GenexCli, args, binding(p)), GenexCliRefusal);
    assert.equal(sandbox.seen.length, 0, "the free tool starts nothing for a paid command");
    await hook("genex", PluginHostTool.GenexCliPaid, args, binding(p));
    assert.ok(sandbox.seen[0]?.request.command.includes("'--max-coins' '5' '--user-approved'"));
  });

  it("keeps a failing command's output, redacted, and still removes the run folder", async () => {
    const p = await profile();
    const sandbox = fakeSandbox({ code: 1, stdout: "", stderr: `Not signed in ${TOKEN}` });
    const answer = await service(p, sandbox).run({ command: "doctor" }, binding(p), { paid: false });
    assert.deepEqual(answer, { command: "doctor", ok: false, exitCode: 1, output: "Not signed in [redacted]" });
    assert.deepEqual(await readdir(path.join(p.userData, "genex-cli")), []);
  });

  it("caps what it answers", async () => {
    const p = await profile();
    const sandbox = fakeSandbox({ stdout: "x".repeat(200_000) });
    const answer = (await service(p, sandbox).run({ command: "doctor" }, binding(p), { paid: false })) as {
      output: string;
    };
    assert.ok(answer.output.length <= 64 * 1024 + 64, String(answer.output.length));
  });

  it("says a timed-out command was stopped", async () => {
    const p = await profile();
    const sandbox = fakeSandbox({ code: null, timedOut: true, signal: "SIGKILL" });
    await assert.rejects(
      service(p, sandbox).run({ command: "doctor" }, binding(p), { paid: false }),
      /did not finish within 90 seconds/,
    );
    assert.deepEqual(await readdir(path.join(p.userData, "genex-cli")), []);
  });

  const noRun: Array<[string, (p: Profile) => Promise<unknown>, RegExp]> = [
    [
      "a locked account",
      (p) => service(p, fakeSandbox(), true).run({ command: "doctor" }, binding(p), { paid: false }),
      /unlock Genex/,
    ],
    [
      "a project command before any draft",
      (p) => service(p, fakeSandbox()).run({ command: "shop list" }, binding(p), { paid: false }),
      /Publish a draft first/,
    ],
    [
      "a refused command",
      (p) => service(p, fakeSandbox()).run({ command: "init" }, binding(p), { paid: false }),
      /not available in Studio/,
    ],
    [
      "a project name that is a path",
      (p) =>
        service(p, fakeSandbox()).run({ command: "llm status" }, { ...binding(p), project: "../x" }, { paid: false }),
      /project/i,
    ],
  ];
  for (const [name, call, message] of noRun) {
    it(`starts nothing and leaves no folder for ${name}`, async () => {
      const p = await profile();
      await assert.rejects(call(p), message);
      const runs = await readdir(path.join(p.userData, "genex-cli")).catch(() => []);
      assert.deepEqual(runs, []);
    });
  }
});

/** Two build games in a library, git repositories with a pnpm lockfile, and a scratch folder for worktrees. */
async function packageLibrary() {
  const root = await realpath(await tmpDir("genex-package-"));
  const gamesRoot = path.join(root, "AI Games");
  const scratch = path.join(root, "scratch");
  await mkdir(scratch, { recursive: true });
  const games: Record<string, string> = {};
  for (const name of ["space-race", "other-game"]) {
    const dir = path.join(gamesRoot, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), `{"name":"${name}"}\n`);
    await writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await exec("git", ["init", "-q", "-b", "main"], { cwd: dir, env: GIT_ENV });
    await exec("git", ["add", "-A"], { cwd: dir, env: GIT_ENV });
    await exec("git", ["commit", "-qm", "first"], { cwd: dir, env: GIT_ENV });
    games[name] = dir;
  }
  const runner = fakeSandbox({ stdout: "" });
  const builds = new GameBuilds({ root: path.join(scratch, "builds"), run: runner.run });
  const packages = new GenexPackageService({
    addPackages: (source, names) => builds.addPackages(source, names),
    gameDir: (project) => {
      const dir = games[project];
      if (!dir) throw new Error(`unknown game ${project}`);
      return dir;
    },
    scratch,
  });
  return { root, gamesRoot, scratch, games, runner, packages };
}
type Library = Awaited<ReturnType<typeof packageLibrary>>;

/** Every package.json in the library, so a refusal can be proven to have changed none. */
async function manifests(lib: Library): Promise<string[]> {
  return Promise.all(Object.values(lib.games).map((dir) => readFile(path.join(dir, "package.json"), "utf8")));
}

describe("genex__package: a pinned Genex SDK install into the bound game", () => {
  it("adds the package at Studio's pin with the lockfile's manager, the npm registry alone opened", async () => {
    const lib = await packageLibrary();
    const game = lib.games["space-race"] ?? "";
    const answer = await lib.packages.add(
      { package: "@genex-ai/multiplayer" },
      { project: "space-race", directory: game },
    );
    const pin = GENEX_GAME_PACKAGES["@genex-ai/multiplayer"];
    const [call] = lib.runner.seen;
    assert.equal(
      call?.request.command,
      `pnpm add --save-exact '@genex-ai/multiplayer@${pin}' '@genex-ai/embed-sdk@${GENEX_GAME_PACKAGES["@genex-ai/embed-sdk"]}'`,
    );
    assert.equal(call?.request.cwd, game);
    assert.deepEqual(call?.request.policy?.allowedDomains, [REGISTRY_DOMAIN]);
    assert.deepEqual(answer, { package: "@genex-ai/multiplayer", version: pin, ok: true, lines: [] });
  });

  it("adds into a Studio worktree of that game, where a Loop run builds", async () => {
    const lib = await packageLibrary();
    const worktree = path.join(lib.scratch, "autopilot", "run-1", "integration");
    await mkdir(path.dirname(worktree), { recursive: true });
    await exec("git", ["worktree", "add", "-q", "--detach", worktree], { cwd: lib.games["space-race"], env: GIT_ENV });
    await lib.packages.add({ package: "@genex-ai/embed-sdk" }, { project: "space-race", directory: worktree });
    assert.equal(lib.runner.seen[0]?.request.cwd, worktree);
  });

  const hostile: Array<
    [string, (lib: Library) => Promise<{ args: Record<string, unknown>; directory: string; project?: string }>, RegExp]
  > = [
    [
      "left-pad",
      async (lib) => ({ args: { package: "left-pad" }, directory: lib.games["space-race"] ?? "" }),
      /not a package/,
    ],
    [
      "a name with a command after it",
      async (lib) => ({
        args: { package: "@genex-ai/multiplayer; rm -rf ~" },
        directory: lib.games["space-race"] ?? "",
      }),
      /not a package/,
    ],
    [
      "a version the agent picked",
      async (lib) => ({
        args: { package: "@genex-ai/multiplayer@latest && curl x" },
        directory: lib.games["space-race"] ?? "",
      }),
      /not a package/,
    ],
    [
      "a path",
      async (lib) => ({ args: { package: "../x" }, directory: lib.games["space-race"] ?? "" }),
      /not a package/,
    ],
    [
      "a folder outside the games",
      async (lib) => {
        const outside = path.join(lib.root, "elsewhere");
        await mkdir(outside, { recursive: true });
        await writeFile(path.join(outside, "package.json"), "{}\n");
        return { args: { package: "@genex-ai/multiplayer" }, directory: outside };
      },
      /not bound to the game/,
    ],
    [
      "a link inside the game that leads out of it",
      async (lib) => {
        const outside = path.join(lib.root, "elsewhere");
        await mkdir(outside, { recursive: true });
        await writeFile(path.join(outside, "package.json"), "{}\n");
        const link = path.join(lib.games["space-race"] ?? "", "linked");
        await symlink(outside, link);
        return { args: { package: "@genex-ai/multiplayer" }, directory: link };
      },
      /not bound to the game/,
    ],
    [
      "another game's folder",
      async (lib) => ({ args: { package: "@genex-ai/multiplayer" }, directory: lib.games["other-game"] ?? "" }),
      /not bound to the game/,
    ],
    [
      "a scratch folder git does not know as this game's worktree",
      async (lib) => {
        const loose = path.join(lib.scratch, "autopilot", "run-2", "integration");
        await mkdir(loose, { recursive: true });
        await writeFile(path.join(loose, "package.json"), "{}\n");
        return { args: { package: "@genex-ai/multiplayer" }, directory: loose };
      },
      /not bound to the game/,
    ],
    [
      "a worktree of another game",
      async (lib) => {
        const worktree = path.join(lib.scratch, "autopilot", "run-3", "integration");
        await mkdir(path.dirname(worktree), { recursive: true });
        await exec("git", ["worktree", "add", "-q", "--detach", worktree], {
          cwd: lib.games["other-game"],
          env: GIT_ENV,
        });
        return { args: { package: "@genex-ai/multiplayer" }, directory: worktree };
      },
      /not bound to the game/,
    ],
    [
      "a project name that is a path",
      async (lib) => ({
        args: { package: "@genex-ai/multiplayer" },
        directory: lib.games["space-race"] ?? "",
        project: "../space-race",
      }),
      /not bound to the game/,
    ],
    [
      "a template game with no package.json",
      async (lib) => {
        const game = lib.games["space-race"] ?? "";
        await exec("git", ["rm", "-q", "package.json"], { cwd: game, env: GIT_ENV });
        return { args: { package: "@genex-ai/embed-sdk" }, directory: game };
      },
      /no package\.json/,
    ],
  ];
  for (const [name, arrange, message] of hostile) {
    it(`installs nothing for ${name}`, async () => {
      const lib = await packageLibrary();
      const { args, directory, project } = await arrange(lib);
      const before = await manifests(lib).catch(() => []);
      await assert.rejects(lib.packages.add(args, { project: project ?? "space-race", directory }), message);
      assert.equal(lib.runner.seen.length, 0, "no package manager ran");
      assert.deepEqual(await manifests(lib).catch(() => []), before, "no package.json changed");
    });
  }

  it("reaches the package service only through genex__package", async () => {
    const lib = await packageLibrary();
    const hook = genexHostTool({ cli: service(await profile(), fakeSandbox()), packages: lib.packages });
    await hook(
      "genex",
      PluginHostTool.GenexPackage,
      { package: "@genex-ai/multiplayer" },
      {
        project: "space-race",
        directory: lib.games["space-race"] ?? "",
      },
    );
    assert.match(lib.runner.seen[0]?.request.command ?? "", /^pnpm add /);
  });
});

describe("what the user is asked about a host tool call", () => {
  it("describes a paid CLI call from the call Studio runs, what it spends first", () => {
    const shown = genexHostConsent("genex", PluginHostTool.GenexCliPaid, {
      command: "llm bench",
      args: `Costs 5. ${"x".repeat(3000)}`,
      options: { samples: 2, "max-coins": 400 },
    });
    assert.deepEqual(Object.keys(shown).slice(0, 2), ["command", "max-coins"]);
    assert.equal(shown["max-coins"], "400");
  });
  it("names a package with the version Studio pins, whatever the agent adds", () => {
    assert.deepEqual(
      genexHostConsent("genex", PluginHostTool.GenexPackage, { package: "@genex-ai/multiplayer", version: "latest" }),
      {
        package: "@genex-ai/multiplayer, @genex-ai/embed-sdk",
        version: `${GENEX_GAME_PACKAGES["@genex-ai/multiplayer"]}, ${GENEX_GAME_PACKAGES["@genex-ai/embed-sdk"]}`,
      },
    );
    assert.deepEqual(genexHostConsent("genex", PluginHostTool.GenexPackage, { package: "@genex-ai/embed-sdk" }), {
      package: "@genex-ai/embed-sdk",
      version: GENEX_GAME_PACKAGES["@genex-ai/embed-sdk"],
    });
  });
  it("refuses, before anyone is asked, a call the host would refuse", () => {
    assert.throws(() => genexHostConsent("genex", PluginHostTool.GenexCliPaid, { command: "auth" }), GenexCliRefusal);
    assert.throws(() => genexHostConsent("genex", PluginHostTool.GenexPackage, { package: "left-pad" }), /left-pad/);
  });
});

describe("fixture profiles", () => {
  it("refuse the CLI and the package install before anything runs; a live profile passes them on", async () => {
    let ran = 0;
    const hook = async () => {
      ran++;
      return "ran";
    };
    const fixture = gatedHostTool(hook, true);
    for (const host of Object.values(PluginHostTool)) {
      await assert.rejects(fixture("genex", host, {}, { project: "g", directory: "/x" }), /unsupported-in-fixture/);
    }
    assert.equal(ran, 0);
    assert.equal(
      await gatedHostTool(hook, false)("genex", PluginHostTool.GenexCli, {}, { project: "g", directory: "/x" }),
      "ran",
    );
  });
});

/** Every file and folder under `dir`, path to bytes, so a run can be proven to have changed nothing. */
async function tree(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    files[path.relative(dir, full)] = entry.isFile() ? await readFile(full, "base64") : "dir";
  }
  return files;
}

/** What the CLI could touch in the real HOME: its own folder and every agent's skills and contracts. */
async function homeFootprint(): Promise<Record<string, string>> {
  const home = os.homedir();
  const places = [
    ".genex",
    ".claude/skills",
    ".codex/skills",
    ".cursor/skills",
    ".agents/skills",
    "AGENTS.md",
    "CLAUDE.md",
  ];
  const seen: Record<string, string> = {};
  for (const place of places) {
    const full = path.join(home, place);
    const info = await lstat(full).catch(() => null);
    if (!info) continue;
    const listing = info.isDirectory() ? (await readdir(full)).sort().join(",") : "";
    seen[place] = `${info.mtimeMs}:${info.size}:${listing}`;
  }
  return seen;
}

describe("the real pinned CLI against a fixture API", () => {
  let api: GenexFixtureApi;
  const requests: GenexRequest[] = [];
  before(async () => {
    api = await startGenexFixtureApi((request) => void requests.push(request));
  });
  after(async () => api?.close());

  async function doctorKeepsProfile(sandboxed: boolean): Promise<void> {
    const p = await profile();
    const requestsBefore = requests.length;
    // Studio's resources, as the plugin build lays them out: the preload beside the pinned CLI.
    const genex = path.join(p.resources, "plugins/genex");
    await mkdir(path.join(genex, "node_modules/@genex-ai"), { recursive: true });
    const preloadSource = path.join(repo, "src/genex-host/preload.mjs");
    const preloadTarget = path.join(genex, "preload.mjs");
    const cliSource = await realpath(path.join(repo, "node_modules/@genex-ai/cli-demo"));
    const cliTarget = path.join(genex, "node_modules/@genex-ai/cli-demo");
    if (sandboxed) {
      // The package has real files: a fixture link would need grants to the developer checkout.
      await buildPlugins(repo, p.resources);
    } else {
      await symlink(preloadSource, preloadTarget);
      await symlink(cliSource, cliTarget);
    }
    // A game that looks like a Genex remix workspace, and a contract in its parent: exactly what
    // the CLI's skill sync and contract healing rewrite when it runs in a folder.
    await mkdir(path.join(p.game, ".genex"), { recursive: true });
    await writeFile(path.join(p.game, ".genex/workspace.json"), '{"mode":"remix","version":1}\n');
    await mkdir(path.join(p.game, ".claude/skills/genex-x"), { recursive: true });
    await writeFile(path.join(p.game, ".claude/skills/genex-x/SKILL.md"), "---\nname: genex-x\n---\nold\n");
    await writeFile(path.join(p.game, "package.json"), JSON.stringify({ name: "g", genex: { agentProfile: "remix" } }));
    await writeFile(path.join(p.gamesRoot, "AGENTS.md"), "<!-- genex:contract -->\n");
    const before = { games: await tree(p.gamesRoot), home: await homeFootprint() };
    const sandbox = await ProcessSandbox.create({
      writableRoots: [],
      readableRoots: [p.resources],
      scratchDir: path.join(p.root, "scratch"),
      secretPaths: [],
      enabled: sandboxed,
    });
    closeBeforeCleanup(() => sandbox.dispose());
    const cli = new GenexCliService({
      run: (request) => sandbox.run(request),
      ...(sandboxed
        ? {
            runNative: (
              request: import("../../src/substrate/plugins/native-process-contract.ts").NativeProcessRequest,
            ) => sandbox.runNative(request),
          }
        : {}),
      credentialFile: async () => `GENEX_TOKEN=${TOKEN}\n`,
      heldCredentials: () => [TOKEN],
      runsRoot: path.join(p.userData, "genex-cli"),
      resources: p.resources,
      genexStorage: p.genexStorage,
      protectedWrites: () => [p.gamesRoot, p.game],
      api: api.url,
    });
    const answer = (await cli.run({ command: "doctor" }, binding(p), { paid: false })) as {
      ok: boolean;
      output: { auth?: { state?: string } };
    };
    assert.equal(answer.output.auth?.state, "ok", JSON.stringify(answer));
    assert.ok(
      requests
        .slice(requestsBefore)
        .some((r) => r.url === "/api/auth/get-session" && r.authorization === `Bearer ${TOKEN}`),
      "the token reached the API through stdin and the preload",
    );
    assert.deepEqual(await tree(p.gamesRoot), before.games, "the game and its parent are untouched");
    assert.deepEqual(await homeFootprint(), before.home, "the real HOME is untouched");
    assert.deepEqual(await readdir(path.join(p.userData, "genex-cli")), [], "the run folder is gone");
  }

  it(
    "runs doctor signed in and leaves the game, its parent and the real HOME byte-identical",
    {
      timeout: REAL_CLI_TIMEOUT_MS,
    },
    () => doctorKeepsProfile(false),
  );

  const windowsSandboxReady = process.platform === "win32" && process.env.GENEX_WINDOWS_SANDBOX === "ready";
  it(
    "runs the signed-in CLI through the real Windows sandbox and preserves the game and HOME",
    {
      timeout: REAL_CLI_TIMEOUT_MS,
      skip: windowsSandboxReady ? false : "requires provisioned Windows SRT",
    },
    () => doctorKeepsProfile(true),
  );
});

it("package preflight refuses unsupported projects before approval and starts no installer", async () => {
  const { genexHostPreflight } = await import("../../src/main/core/genex-cli.ts");
  const lib = await packageLibrary();
  const dir = lib.games["space-race"] ?? "";
  const preflight = genexHostPreflight(lib.packages);
  const shown = await preflight(
    "genex",
    PluginHostTool.GenexPackage,
    { package: "@genex-ai/multiplayer" },
    { project: "space-race", directory: dir },
  );
  assert.match(shown.package ?? "", /embed-sdk/);
  assert.equal(lib.runner.seen.length, 0);
  await rm(path.join(dir, "package.json"));
  await assert.rejects(
    preflight(
      "genex",
      PluginHostTool.GenexPackage,
      { package: "@genex-ai/multiplayer" },
      { project: "space-race", directory: dir },
    ),
    /package.json/,
  );
  assert.equal(lib.runner.seen.length, 0);
});

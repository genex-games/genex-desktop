/**
 * `assets.checkpoint` commits a Loop's deliveries into the run's integration copy, and only into a
 * copy git has registered as a worktree of the named game (ARCH-1: the harness names a run, the
 * host finds the folder). Git names a worktree its own way: Git for Windows writes `C:/Users/…`
 * where Node's realpath answers `C:\Users\…` (#276), so the registration is compared by real path.
 * Every other folder is refused before anything is committed.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { git } from "../../src/substrate/snapshots.ts";

type Api = Record<string, (input: unknown) => Promise<unknown>>;

const FOREIGN = /does not belong to this game/;

let lite: CoreLite;
let api: Api;

/** The folder a run's integration copy lives in: what `assets.checkpoint` looks for. */
function integrationDir(runId: string): string {
  return path.join(lite.core.layout.scratch, "autopilot", runId, "integration");
}

/** A registered copy of `project`, made the way a Loop makes one. */
async function worktree(project: string, runId: string, name = "integration"): Promise<string> {
  const made = (await api["snapshot.worktree"]!({ project, name, runId })) as { path: string };
  return made.path;
}

/** Point git's registration of `workspace` at another spelling of the same folder. */
async function respell(workspace: string, spelling: string): Promise<void> {
  const pointer = (await readFile(path.join(workspace, ".git"), "utf8")).trim().replace(/^gitdir: /, "");
  await writeFile(path.join(pointer, "gitdir"), `${path.join(spelling, ".git")}\n`);
}

/** What a refused checkpoint must leave as it was: the game's commits and registrations. */
async function gameState(project: string): Promise<string> {
  const game = lite.core.games.dirFor(project);
  return `${await git(game, ["rev-parse", "HEAD"])}${await git(game, ["worktree", "list", "--porcelain", "-z"])}`;
}

before(async () => {
  lite = await coreLite();
  api = lite.api() as unknown as Api;
  await lite.core.games.scaffold("pong");
  await lite.core.games.scaffold("tennis");
});

describe("assets.checkpoint finds a run's integration copy by git's registration", () => {
  it("accepts the copy git registered", async () => {
    const workspace = await worktree("pong", "run-plain");
    const result = (await api["assets.checkpoint"]!({ project: "pong", runId: "run-plain" })) as { revision: string };
    assert.equal(result.revision, (await git(workspace, ["rev-parse", "HEAD"])).trim());
  });

  it("accepts the copy when git names it by another spelling of the same folder", async () => {
    const workspace = await worktree("pong", "run-spelled");
    // A link to scratch spells the folder differently from its real path, as Git for Windows'
    // forward slashes do on Windows.
    const link = path.join(await tmpDir("integration-spelling-"), "scratch");
    await symlink(await realpath(lite.core.layout.scratch), link, "junction");
    await respell(workspace, path.join(link, "autopilot", "run-spelled", "integration"));
    const listing = await git(lite.core.games.dirFor("pong"), ["worktree", "list", "--porcelain"]);
    assert.ok(listing.includes(link), "git lists the copy by the linked spelling");
    const result = (await api["assets.checkpoint"]!({ project: "pong", runId: "run-spelled" })) as {
      revision: string;
    };
    assert.equal(result.revision, (await git(workspace, ["rev-parse", "HEAD"])).trim());
  });

  const hostile: Array<{
    name: string;
    posixOnly?: boolean;
    plant: () => Promise<{ project: string; runId: string }>;
  }> = [
    {
      name: "another run's copy is registered, not this run's",
      plant: async () => {
        await worktree("pong", "run-other");
        await mkdir(integrationDir("run-mine"), { recursive: true });
        return { project: "pong", runId: "run-mine" };
      },
    },
    {
      name: "a registered copy whose name only starts the same",
      plant: async () => {
        await worktree("pong", "run-prefix", "integration-old");
        await mkdir(integrationDir("run-prefix"), { recursive: true });
        return { project: "pong", runId: "run-prefix" };
      },
    },
    {
      name: "the run's folder above it is registered",
      plant: async () => {
        const above = path.dirname(integrationDir("run-above"));
        await git(lite.core.games.dirFor("pong"), ["worktree", "add", "--detach", above]);
        await mkdir(integrationDir("run-above"), { recursive: true });
        return { project: "pong", runId: "run-above" };
      },
    },
    {
      name: "another game's copy",
      plant: async () => {
        await worktree("tennis", "run-tennis");
        return { project: "pong", runId: "run-tennis" };
      },
    },
    {
      name: "a link to another game's copy",
      plant: async () => {
        const theirs = await worktree("tennis", "run-theirs");
        await mkdir(path.dirname(integrationDir("run-link")), { recursive: true });
        await symlink(theirs, integrationDir("run-link"), "junction");
        return { project: "pong", runId: "run-link" };
      },
    },
    {
      // Without -z, git prints this folder's name on two lines, the second a worktree line.
      name: "a registered folder whose name carries a newline and this copy's worktree line",
      posixOnly: true,
      plant: async () => {
        const workspace = integrationDir("run-forged");
        await mkdir(workspace, { recursive: true });
        const forged = path.join(lite.core.layout.scratch, "autopilot", `x\nworktree ${await realpath(workspace)}`);
        await git(lite.core.games.dirFor("pong"), ["worktree", "add", "--detach", forged]);
        return { project: "pong", runId: "run-forged" };
      },
    },
  ];

  for (const row of hostile) {
    const skip = row.posixOnly && process.platform === "win32" ? "a Windows name cannot hold a newline" : false;
    it(`refuses, with nothing committed: ${row.name}`, { skip }, async () => {
      const { project, runId } = await row.plant();
      const before = await gameState(project);
      const contents = await readdir(integrationDir(runId));
      await assert.rejects(api["assets.checkpoint"]!({ project, runId }), FOREIGN);
      assert.equal(await gameState(project), before);
      assert.deepEqual(await readdir(integrationDir(runId)), contents);
    });
  }
});

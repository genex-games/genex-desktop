/**
 * `assets.checkpoint` commits only in a run's integration workspace that git registers as a
 * worktree of the game, however git spells it. Git lists a linked worktree as its admin `gitdir`
 * file names it (Git for Windows with `/`), so each row writes the spelling under test there.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { gameRpc } from "../../src/main/harness-rpc/game.ts";
import type { CoreInternals, StudioCore } from "../../src/main/studio-core.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { fixtureGit } from "../helpers/snapshot-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "game";
const RUN = "run-a";
const FOREIGN = /Integration workspace does not belong to this game/;

interface Stand {
  root: string;
  /** The run's integration folder, as Node's realpath spells it. */
  workspace: string;
  /** The folders a checkpoint was asked to commit in: the side effect a refusal must not have. */
  checkpoints: string[];
  checkpoint: () => Promise<unknown>;
  /** Git lists the run's linked worktree as `spelling`, newlines included. */
  register: (spelling: string) => Promise<void>;
  /** Git lists no linked worktree, only the game itself; the folder stays. */
  unregister: () => Promise<void>;
}

/** A game with the run's integration folder added as its one linked worktree. */
async function stand(): Promise<Stand> {
  const root = await realpath(await tmpDir());
  const game = path.join(root, PROJECT);
  const scratch = path.join(root, "scratch");
  const workspace = path.join(scratch, "autopilot", RUN, "integration");
  await mkdir(game, { recursive: true });
  await fixtureGit(game, ["init", "-q"]);
  await fixtureGit(game, ["commit", "-q", "--allow-empty", "-m", "start"]);
  await fixtureGit(game, ["worktree", "add", "-q", "--detach", workspace]);
  const admin = path.join(game, ".git", "worktrees", path.basename(workspace));
  const checkpoints: string[] = [];
  const core = {
    layout: { scratch },
    games: { dirFor: () => game },
    assertProjectAllowed: async () => {},
    assetCheckpoints: {
      checkpoint: async (_project: string, at: string) => {
        checkpoints.push(at);
        return { revision: "", files: [] };
      },
    },
  };
  const rpc = gameRpc(core as unknown as StudioCore, {} as CoreInternals);
  return {
    root,
    workspace,
    checkpoints,
    checkpoint: () => rpc[HostMethod.AssetsCheckpoint]({ project: PROJECT, runId: RUN }),
    register: (spelling) => writeFile(path.join(admin, "gitdir"), `${spelling}/.git\n`),
    unregister: () => writeFile(path.join(admin, "gitdir"), ""),
  };
}

/** A real folder that is not the run's integration workspace. */
async function folder(at: string): Promise<string> {
  await mkdir(at, { recursive: true });
  return at;
}

describe("a run's integration workspace for an asset checkpoint", () => {
  it("is accepted as git registered it", async () => {
    const s = await stand();
    await s.checkpoint();
    assert.deepEqual(s.checkpoints, [s.workspace]);
  });

  const accepted: { name: string; spelling: (s: Stand) => Promise<string> }[] = [
    { name: "the Windows forward-slash spelling", spelling: async (s) => s.workspace.replaceAll(path.sep, "/") },
    {
      name: "a spelling through a link to the scratch folder",
      spelling: async (s) => {
        const link = path.join(s.root, "scratch-link");
        await symlink(path.join(s.root, "scratch"), link, "junction");
        return path.join(link, "autopilot", RUN, "integration");
      },
    },
  ];
  for (const row of accepted) {
    it(`is accepted by ${row.name}`, async () => {
      const s = await stand();
      await s.register(await row.spelling(s));
      await s.checkpoint();
      assert.deepEqual(s.checkpoints, [s.workspace]);
    });
  }

  const refused: { name: string; listing: (s: Stand) => Promise<void> }[] = [
    {
      name: "another run's folder",
      listing: async (s) => s.register(await folder(path.join(s.root, "scratch", "autopilot", "run-b", "integration"))),
    },
    { name: "a longer name with the same start", listing: async (s) => s.register(await folder(`${s.workspace}-old`)) },
    { name: "the folder above", listing: async (s) => s.register(path.dirname(s.workspace)) },
    {
      name: "a path that only appears on a HEAD line",
      listing: async (s) => s.register(`${await folder(path.join(s.root, "elsewhere"))}\nHEAD ${s.workspace}`),
    },
    {
      name: "a worktree line smuggled inside another folder's name",
      listing: async (s) => s.register(`${await folder(path.join(s.root, "elsewhere"))}\nworktree ${s.workspace}`),
    },
    { name: "nothing but the game (an empty listing)", listing: (s) => s.unregister() },
  ];
  for (const row of refused) {
    it(`is refused when git registers ${row.name}, with no checkpoint`, async () => {
      const s = await stand();
      await row.listing(s);
      await assert.rejects(s.checkpoint(), FOREIGN);
      assert.deepEqual(s.checkpoints, []);
    });
  }
});

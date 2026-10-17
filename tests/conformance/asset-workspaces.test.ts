import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { assetWorkspaces } from "../../src/main/asset-workspaces.ts";

test("one git listing supplies revisions and refuses worktrees outside scratch", () => {
  const scratch = path.resolve("scratch");
  const allowed = path.join(scratch, "autopilot");
  const root = path.join(allowed, "run", "a\nworker");
  const listing = [
    `worktree ${root}\0HEAD 1234\0branch refs/heads/worker\0`,
    `worktree ${allowed}-escape/a\0HEAD 9999\0`,
    `worktree ${path.join(allowed, "run", "integration")}\0HEAD 5678\0detached\0`,
  ].join("\0");
  assert.deepEqual(
    assetWorkspaces(listing, scratch, allowed).map(({ root, revision, scope }) => ({ root, revision, scope })),
    [
      { root, revision: "1234", scope: "worker" },
      { root: path.join(allowed, "run", "integration"), revision: "5678", scope: "integration" },
    ],
  );
});

test("an asset poll uses the revisions from one worktree listing", async () => {
  const { mkdir, realpath } = await import("node:fs/promises");
  const { tmpDir } = await import("../helpers/tmp.ts");
  const { AssetService } = await import("../../src/main/core/assets.ts");
  const root = await realpath(await tmpDir());
  const scratch = path.join(root, "scratch");
  const engineHomes = path.join(root, "engines");
  const game = path.join(root, "game");
  const worker = path.join(scratch, "autopilot", "run", "worker");
  for (const folder of [engineHomes, game, worker]) await mkdir(folder, { recursive: true });
  const calls: string[][] = [];
  const core = {
    games: { dirFor: () => game, factsOf: async () => [] },
    layout: { scratch, engineHomes },
    assetCheckpoints: { records: async () => [] },
  };
  const service = new AssetService(
    core as unknown as import("../../src/main/studio-core.ts").StudioCore,
    async (_dir, args) => {
      calls.push(args);
      return args.includes("-z") ? `worktree ${worker}\0HEAD abcd\0\0` : `worktree ${worker}\nHEAD abcd\n\n`;
    },
  );
  await service.projectAssets("game");
  assert.equal(calls.length, 1);
});

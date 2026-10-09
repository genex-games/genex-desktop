import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { GameBuilds } from "../../src/main/game-build.ts";
import { GameWorkspaces } from "../../src/substrate/game-workspace.ts";
import { UNITY_PROJECT_SHAPE } from "../../src/substrate/unity-project.ts";
import { createUnityProject } from "../../src/plugins/unity/project-setup.ts";
import { canBuildUnattended, kindChip, openOptions, runsWords } from "../../src/shared/shape-words.ts";
import { tmpDir } from "../helpers/tmp.ts";

test("Unity source never becomes a successful browser build or a public web export", async () => {
  const root = await tmpDir("unity-surface-");
  const dir = path.join(root, "native-game");
  await createUnityProject(dir, "6000.5.5f1");
  let processes = 0;
  const builds = new GameBuilds({
    root: path.join(root, "builds"),
    run: async () => {
      processes++;
      throw new Error("No browser process is allowed");
    },
  });
  await assert.rejects(
    () => builds.ensure({ project: "native-game", dir, shape: UNITY_PROJECT_SHAPE }),
    /Unity.*Editor/i,
  );
  assert.equal(processes, 0);
  const games = new GameWorkspaces({
    root,
    indexFile: path.join(root, "index.json"),
    userData: path.join(root, "userData"),
    templateDir: path.resolve(import.meta.dirname, "../../src/game-template"),
    vendorDir: path.join(root, "vendor"),
  });
  await assert.rejects(() => games.export("native-game", path.join(root, "public")), /Unity.*build/i);
  assert.equal(kindChip("unity"), "Unity");
  assert.match(runsWords(UNITY_PROJECT_SHAPE), /Unity Editor/);
  assert.equal(canBuildUnattended("unity"), false);
  assert.equal(canBuildUnattended("three-vite"), true);
  const option = openOptions(await games.inspect(dir))[0];
  assert.equal(option?.engineExport, false, "editable Unity source is distinct from a compiled engine export");
});

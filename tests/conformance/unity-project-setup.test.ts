import assert from "node:assert/strict";
import fsPromises, { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { tmpDir } from "../helpers/tmp.ts";
import {
  installUnityBridge,
  createUnityProject,
  unityEditorEnvironment,
} from "../../src/plugins/unity/project-setup.ts";
import { safeUnityBatch, unityParams } from "../../src/plugins/unity/commands.ts";

test("Unity setup installs the bridge while preserving unrelated package dependencies and project assets", async () => {
  const parent = await tmpDir("unity-setup-");
  const root = path.join(parent, "Моя игра");
  await createUnityProject(root, "6000.5.5f1");
  const manifestFile = path.join(root, "Packages", "manifest.json");
  await writeFile(
    manifestFile,
    JSON.stringify({
      dependencies: { "com.unity.modules.physics": "1.0.0" },
      testables: ["my.tests"],
      scopedRegistries: [],
    }),
  );
  await writeFile(path.join(root, "Assets", "keep.txt"), "hand edited");
  const installed = await installUnityBridge(root);
  assert.equal(installed.installed, true);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assert.equal(manifest.dependencies["com.unity.modules.physics"], "1.0.0");
  assert.equal(manifest.dependencies["com.genex.unity-bridge"], "file:com.genex.unity-bridge");
  assert.deepEqual(manifest.testables, ["my.tests"]);
  assert.equal(await readFile(path.join(root, "Assets", "keep.txt"), "utf8"), "hand edited");
  assert.equal((await installUnityBridge(root)).changed, false);
});

test("Unity creation refuses existing content, unsupported versions and a cancelled request without altering files", async () => {
  const parent = await tmpDir("unity-setup-hostile-");
  await writeFile(path.join(parent, "keep.txt"), "preserve");
  await assert.rejects(() => createUnityProject(parent, "6000.5.5f1"), /exist/i);
  await assert.rejects(() => createUnityProject(path.join(parent, "new"), "arbitrary shell"), /version/i);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => createUnityProject(path.join(parent, "cancelled"), "6000.5.5f1", controller.signal));
  assert.equal(await readFile(path.join(parent, "keep.txt"), "utf8"), "preserve");
});

test("Unity package update refuses a user-edited bridge and leaves its manifest intact", async () => {
  const parent = await tmpDir("unity-edited-bridge-");
  const root = path.join(parent, "Project");
  await createUnityProject(root, "6000.5.5f1");
  await installUnityBridge(root);
  const manifestFile = path.join(root, "Packages", "manifest.json");
  const original = await readFile(manifestFile, "utf8");
  const bridge = path.join(root, "Packages", "com.genex.unity-bridge");
  await mkdir(path.join(bridge, "Custom"));
  await writeFile(path.join(bridge, "Custom", "keep.cs"), "// human edit");
  await assert.rejects(() => installUnityBridge(root), /modified|edited/i);
  assert.equal(await readFile(manifestFile, "utf8"), original);
  assert.equal(await readFile(path.join(bridge, "Custom", "keep.cs"), "utf8"), "// human edit");
});

test("Unity package update preserves a human edit made while the replacement package is staged", async (t) => {
  const parent = await tmpDir("unity-update-race-");
  const root = path.join(parent, "Project");
  await createUnityProject(root, "6000.5.5f1");
  await installUnityBridge(root);
  const packages = path.join(root, "Packages");
  const manifestFile = path.join(packages, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  delete manifest.dependencies["com.genex.unity-bridge"];
  const originalManifest = JSON.stringify(manifest);
  await writeFile(manifestFile, originalManifest);
  const editedFile = path.join(packages, "com.genex.unity-bridge", "Editor", "ProjectFiles.cs");
  const humanEdit = "// changed while updating\n";
  const copy = fsPromises.cp;
  t.mock.method(fsPromises, "cp", async (...args: Parameters<typeof copy>) => {
    await copy(...args);
    if (String(args[1]).includes(".genex-stage-")) await writeFile(editedFile, humanEdit);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(() => installUnityBridge(root), /modified|edited/i);
  assert.equal(await readFile(editedFile, "utf8"), humanEdit);
  assert.equal(await readFile(manifestFile, "utf8"), originalManifest);
  assert.deepEqual(
    (await readdir(packages)).filter((name) => name.startsWith(".genex-")),
    [],
  );
});

test("Unity package receipts are rejected before reading linked or oversized files", async (t) => {
  const parent = await tmpDir("unity-receipt-boundary-");
  const root = path.join(parent, "Project");
  await createUnityProject(root, "6000.5.5f1");
  await installUnityBridge(root);
  const receipt = path.join(root, "Packages", "com.genex.unity-bridge", ".genex-install.json");
  const external = path.join(parent, "keep.json");
  const content = await readFile(receipt, "utf8");
  await writeFile(external, content);
  await rm(receipt);
  await link(external, receipt);
  const read = fsPromises.readFile;
  let receiptReads = 0;
  t.mock.method(fsPromises, "readFile", (...args: Parameters<typeof read>) => {
    if (String(args[0]) === receipt) receiptReads++;
    return read(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(() => installUnityBridge(root), /linked|bounded|modified/i);
  await rm(receipt);
  await writeFile(receipt, " ".repeat(1024 * 1024 + 1));
  await assert.rejects(() => installUnityBridge(root), /bounded|modified/i);
  assert.equal(receiptReads, 0);
  assert.equal(await readFile(external, "utf8"), content);
});

test("Unity ordinary batches refuse caller confirmation and destructive commands before dispatch", () => {
  assert.throws(() => unityParams('{"id":"scene:1","confirmed":true}'), /confirmation/);
  assert.throws(
    () => safeUnityBatch({ commands: [{ method: "object.create", params: { name: "Tower", confirmed: true } }] }),
    /confirmation/,
  );
  assert.deepEqual(safeUnityBatch({ commands: [{ method: "object.create", params: { name: "Tower" } }] }), {
    commands: [{ method: "object.create", params: { name: "Tower" } }],
  });
  for (const method of ["object.delete", "asset.move", "editor.undo", "package.add", "job.start", "batch"])
    assert.throws(() => safeUnityBatch({ commands: [{ method, params: { confirmed: true } }] }));
});

test("opening Unity retains OS profile paths but never inherits Genex, provider or shell credentials", () => {
  assert.deepEqual(
    unityEditorEnvironment({
      Path: "tools",
      SystemRoot: "Windows",
      USERPROFILE: "profile",
      TEMP: "scratch",
      GENEX_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
      ANTHROPIC_API_KEY: "secret",
      SSH_AUTH_SOCK: "secret",
      GIT_CONFIG_COUNT: "1",
    }),
    { Path: "tools", SystemRoot: "Windows", USERPROFILE: "profile", TEMP: "scratch" },
  );
});

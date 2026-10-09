import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PluginServices } from "../../src/substrate/plugins/services.ts";
import { readAssetPreview } from "../../src/main/asset-preview.ts";
import { joinProjectAssets, readContainedImage, walkGameAssets } from "../../src/main/game-assets.ts";
import { assetCompanion } from "../../src/shared/asset-preview.ts";
import { AssetCheckpoints } from "../../src/main/asset-checkpoints.ts";
import { GIT_ENV } from "../../src/substrate/snapshots.ts";
import { gitFile } from "../helpers/git.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIRST_JOB = "11111111-1111-4111-8111-111111111111";
const SECOND_JOB = "22222222-2222-4222-8222-222222222222";

async function fixture() {
  const root = await tmpDir("unity-delivery-");
  const project = path.join(root, "Unity Project"),
    storage = path.join(root, "storage"),
    output = path.join(storage, "output");
  for (const directory of ["Assets", "Packages", "ProjectSettings"])
    await mkdir(path.join(project, directory), { recursive: true });
  await writeFile(path.join(project, "Packages", "manifest.json"), '{"dependencies":{}}');
  await writeFile(path.join(project, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.5.5f1\n");
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "model.fbx"), "12345");
  const create = () => new PluginServices(root, { blender: storage }, async () => null);
  return { root, project, output, create, binding: { project: "game", directory: project } };
}

test("Unity delivery uses native Assets, retains ledger paths and retrieves without overwriting project edits", async () => {
  const f = await fixture();
  const service = f.create();
  let ledger: unknown;
  service.onDelivered = async (_id, record, binding) => {
    ledger = { record, binding };
  };
  const args = { output: f.output, jobId: FIRST_JOB };
  const files = [`Assets/Generated/blender/${FIRST_JOB}/model.fbx`];
  assert.deepEqual(await service.call("blender", "assets.deliver", args, f.binding), files);
  assert.deepEqual(ledger, { record: { jobId: FIRST_JOB, files }, binding: f.binding });
  const model = path.join(f.project, files[0] ?? assert.fail("model path"));
  await writeFile(`${model}.meta`, "Unity's importer metadata");
  assert.deepEqual(await f.create().call("blender", "assets.deliver", args, f.binding), files);
  assert.equal(await readFile(`${model}.meta`, "utf8"), "Unity's importer metadata");
  await writeFile(model, "user edit");
  await assert.rejects(f.create().call("blender", "assets.deliver", args, f.binding), /differs.*not overwrite/);
  assert.equal(await readFile(model, "utf8"), "user edit");
  await assert.rejects(readFile(path.join(f.project, "assets", "blender", FIRST_JOB, "model.fbx")), { code: "ENOENT" });
});

test("asset quota survives restart and counts browser and Unity delivery roots together", async () => {
  const f = await fixture();
  const browser = path.join(f.root, "browser-worker");
  await mkdir(browser);
  const create = () => {
    const service = f.create();
    service.assetLimits = () => ({ fileBytes: 8, projectBytes: 8 });
    return service;
  };
  const args = { output: f.output, jobId: FIRST_JOB };
  await create().call("blender", "assets.deliver", args, { project: "game", directory: browser });
  await assert.rejects(
    create().call("blender", "assets.deliver", { ...args, jobId: SECOND_JOB }, f.binding),
    /across this project's workspaces/,
  );
  await assert.rejects(readFile(path.join(f.project, "Assets", "Generated", "blender", SECOND_JOB, "model.fbx")), {
    code: "ENOENT",
  });
  await rm(path.join(browser, "assets"), { recursive: true });
  const files = await create().call("blender", "assets.deliver", { ...args, jobId: SECOND_JOB }, f.binding);
  assert.deepEqual(await create().call("blender", "assets.deliver", { ...args, jobId: SECOND_JOB }, f.binding), files);
  await mkdir(path.join(f.project, "assets", "blender", "legacy"), { recursive: true });
  await writeFile(path.join(f.project, "assets", "blender", "legacy", "legacy.glb"), "12345");
  await assert.rejects(create().call("blender", "assets.deliver", args, f.binding), /across this project's workspaces/);
});

test("Unity asset delivery refuses linked Assets or Generated directories before copying any file", async () => {
  for (const relative of ["Assets", "Assets/Generated", "Assets/Generated/blender"]) {
    const f = await fixture();
    const outside = path.join(f.root, "outside");
    await mkdir(outside);
    const target = path.join(f.project, relative);
    if (relative === "Assets") await rm(target, { recursive: true });
    else await mkdir(path.dirname(target), { recursive: true });
    await symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
    const service = f.create();
    service.assetLimits = () => ({ fileBytes: 8, projectBytes: 8 });
    await assert.rejects(
      service.call("blender", "assets.deliver", { output: f.output, jobId: FIRST_JOB }, f.binding),
      /symlink/,
    );
    await assert.rejects(readFile(path.join(outside, FIRST_JOB, "model.fbx")), { code: "ENOENT" });
  }
});

test("Unity generated assets retain their exact paths in inventory, origin inference and bounded previews", async () => {
  const f = await fixture();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(path.join(f.output, "render.png"), png);
  const files = (await f
    .create()
    .call("blender", "assets.deliver", { output: f.output, jobId: FIRST_JOB }, f.binding)) as string[];
  const model = files.find((file) => file.endsWith("model.fbx")) ?? assert.fail("FBX delivered");
  const render = files.find((file) => file.endsWith("render.png")) ?? assert.fail("PNG delivered");
  await writeFile(path.join(f.project, `${model}.meta`), "Unity metadata");
  await writeFile(path.join(f.project, "Assets", "authoring.cs"), "class Authoring {}");
  const walk = await walkGameAssets(f.project);
  assert.deepEqual(walk.entries.map((entry) => entry.file).sort(), files.toSorted());
  const inventory = joinProjectAssets({ project: "game", ...walk, ledger: [], jobs: [] });
  assert.ok(inventory.assets.every((asset) => asset.source === "blender" && asset.jobId === FIRST_JOB));
  assert.equal(inventory.assets.find((asset) => asset.file === model)?.kind, "model");
  assert.equal((await readContainedImage(f.project, render))?.data, png.toString("base64"));
  assert.deepEqual((await readAssetPreview(f.project, model)).data, new Uint8Array(Buffer.from("12345")));
  assert.equal(assetCompanion(model, "render.png"), render);
  for (const file of [
    "Assets/authoring.cs",
    "Assets/secrets.json",
    `${model}.meta`,
    "Assets/Generated/../secrets.json",
  ]) {
    await assert.rejects(readAssetPreview(f.project, file));
    assert.equal(await readContainedImage(f.project, file), null);
  }
  for (const uri of ["../../../secret.png", "%2e%2e/%2e%2e/%2e%2e/secret.png", "https://host/a.png", "file:///a.png"]) {
    assert.throws(() => assetCompanion(model, uri));
  }
});

test("Unity inventory and preview refuse each linked ancestor of a generated asset", async () => {
  const linkedSuffixes: Record<string, string> = {
    Assets: `Generated/blender/${FIRST_JOB}/model.fbx`,
    "Assets/Generated": `blender/${FIRST_JOB}/model.fbx`,
    "Assets/Generated/blender": `${FIRST_JOB}/model.fbx`,
  };
  const file = `Assets/Generated/blender/${FIRST_JOB}/model.fbx`;
  for (const [relative, suffix] of Object.entries(linkedSuffixes)) {
    const f = await fixture();
    const outside = path.join(f.root, "outside");
    await mkdir(path.dirname(path.join(outside, suffix)), { recursive: true });
    await writeFile(path.join(outside, suffix), "private model");
    const target = path.join(f.project, relative);
    if (relative === "Assets") await rm(target, { recursive: true });
    else await mkdir(path.dirname(target), { recursive: true });
    await symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
    const inventory = await walkGameAssets(f.project);
    assert.deepEqual(inventory.entries, []);
    assert.deepEqual(inventory.skipped, [{ file: relative, why: "symlink" }]);
    await assert.rejects(readAssetPreview(f.project, file), /Linked/);
    assert.equal(await readContainedImage(f.project, file), null);
    assert.equal(await readFile(path.join(outside, suffix), "utf8"), "private model");
  }
});

test("Unity deliveries retain host records and checkpoint only delivered bytes, preserving unrelated edits", async () => {
  const f = await fixture();
  const git = async (...args: string[]) =>
    (await gitFile(args, { cwd: f.project, env: { ...process.env, ...GIT_ENV } })).stdout.trim();
  await git("init");
  await git("add", ".");
  await git("commit", "-m", "Fixture Unity project");
  const checkpoints = new AssetCheckpoints(path.join(f.project, ".git", "host-deliveries.json"));
  const service = f.create();
  service.onDelivered = async (id, record, binding) => {
    await checkpoints.record(binding.project, binding.directory, id, record.jobId, record.files);
  };
  const files = (await service.call(
    "blender",
    "assets.deliver",
    { output: f.output, jobId: FIRST_JOB },
    f.binding,
  )) as string[];
  assert.deepEqual(
    (await checkpoints.records())[0]?.files.map((file) => file.path),
    files,
  );
  await writeFile(path.join(f.project, "Assets", "Manual.cs"), "User staged this");
  await git("add", "Assets/Manual.cs");
  await writeFile(path.join(f.project, "Packages", "manifest.json"), '{"dependencies":{},"user":"edit"}');
  const result = await checkpoints.checkpoint("game", f.project);
  assert.deepEqual(result.files, files);
  assert.equal(await git("diff", "--cached", "--name-only"), "Assets/Manual.cs");
  assert.equal(await git("show", "HEAD:Packages/manifest.json"), '{"dependencies":{}}');
  const model = files[0] ?? assert.fail("delivered model");
  assert.equal(await git("show", `HEAD:${model}`), "12345");
  await writeFile(path.join(f.project, model), "user changed model");
  await assert.rejects(checkpoints.checkpoint("game", f.project), /was modified/);
  await assert.rejects(
    checkpoints.record("game", f.project, "blender", FIRST_JOB, ["Assets/Manual.cs"]),
    /Only delivered/,
  );
  assert.equal((await checkpoints.records()).length, 1);
});

/** Project setup through hostile filesystem boundaries, without launching an Editor. */
import assert from "node:assert/strict";
import fsPromises, { link, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { createUnityProject, installUnityBridge } from "../../src/plugins/unity/project-setup.ts";
import { tmpDir } from "../helpers/tmp.ts";

async function updateFixture() {
  const parent = await tmpDir("unity-update-boundary-");
  const root = path.join(parent, "Project");
  await createUnityProject(root, "6000.5.5f1");
  await installUnityBridge(root);
  const packages = path.join(root, "Packages");
  const manifestFile = path.join(packages, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  delete manifest.dependencies["com.genex.unity-bridge"];
  const before = `${JSON.stringify(manifest)}\n`;
  await writeFile(manifestFile, before);
  return { parent, root, packages, manifestFile, before, bridge: path.join(packages, "com.genex.unity-bridge") };
}

test("package replacement refuses hard-linked Unity metadata without copying its outside contents", async (t) => {
  const f = await updateFixture();
  const external = path.join(f.parent, "outside.txt");
  const metadata = path.join(f.bridge, "Editor", "ProjectFiles.cs.meta");
  const content = "synthetic private outside contents";
  await writeFile(external, content);
  await link(external, metadata);
  const copy = fsPromises.cp;
  let metadataCopies = 0;
  t.mock.method(fsPromises, "cp", (...args: Parameters<typeof copy>) => {
    if (String(args[0]) === metadata) metadataCopies++;
    return copy(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(() => installUnityBridge(f.root), /linked|bounded|modified/i);
  assert.equal(metadataCopies, 0);
  assert.equal(await readFile(external, "utf8"), content);
  assert.equal(await readFile(f.manifestFile, "utf8"), f.before);
  assert.equal(
    (await readdir(f.packages)).some((name) => name.startsWith(".genex-")),
    false,
  );
});

test("package replacement refuses oversized known metadata before copying it", async () => {
  const f = await updateFixture();
  const metadata = path.join(f.bridge, "Editor", "ProjectFiles.cs.meta");
  const content = "x".repeat(1024 * 1024 + 1);
  await writeFile(metadata, content);
  await assert.rejects(() => installUnityBridge(f.root), /bounded|budget|modified/i);
  assert.equal(await readFile(metadata, "utf8"), content);
  assert.equal(await readFile(f.manifestFile, "utf8"), f.before);
  assert.equal(
    (await readdir(f.packages)).some((name) => name.startsWith(".genex-")),
    false,
  );
});

test("a metadata link swapped while staging is rejected at the copy boundary", async (t) => {
  const f = await updateFixture();
  const metadata = path.join(f.bridge, "Editor", "ProjectFiles.cs.meta");
  const external = path.join(f.parent, "outside.txt");
  const content = "synthetic outside metadata";
  await writeFile(external, content);
  await writeFile(metadata, "guid: existing-human-guid\n");
  const copy = fsPromises.cp;
  let metadataCopies = 0;
  t.mock.method(fsPromises, "cp", async (...args: Parameters<typeof copy>) => {
    if (String(args[0]) === metadata) metadataCopies++;
    await copy(...args);
    if (!String(args[1]).includes(".genex-stage-")) return;
    await rm(metadata);
    await link(external, metadata);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(() => installUnityBridge(f.root), /linked|bounded|modified/i);
  assert.equal(metadataCopies, 0);
  assert.equal(await readFile(external, "utf8"), content);
  assert.equal(await readFile(f.manifestFile, "utf8"), f.before);
  assert.equal(
    (await readdir(f.packages)).some((name) => name.startsWith(".genex-")),
    false,
  );
});

test("installation refuses a linked Packages directory inside or outside the project without side effects", async (t) => {
  for (const inside of [false, true])
    await t.test(inside ? "inside junction" : "outside junction", async () => {
      const parent = await tmpDir("unity-packages-link-");
      const root = path.join(parent, "Project");
      await createUnityProject(root, "6000.5.5f1");
      const packages = path.join(root, "Packages");
      const destination = path.join(inside ? root : parent, "LinkedPackages");
      await rename(packages, destination);
      const manifestFile = path.join(destination, "manifest.json");
      const before = await readFile(manifestFile, "utf8");
      await writeFile(path.join(destination, "keep.txt"), "preserve");
      await symlink(destination, packages, "junction");
      await assert.rejects(() => installUnityBridge(root), /linked|inside|outside|unsafe/i);
      assert.equal(await readFile(manifestFile, "utf8"), before);
      assert.equal(await readFile(path.join(destination, "keep.txt"), "utf8"), "preserve");
      assert.deepEqual((await readdir(destination)).sort(), ["keep.txt", "manifest.json"]);
    });
});

test("cancellation after staging preserves the previous bridge and manifest and removes temporary files", async (t) => {
  const f = await updateFixture();
  const previous = await readFile(path.join(f.bridge, "Editor", "ProjectFiles.cs"), "utf8");
  const stop = new AbortController();
  const copy = fsPromises.cp;
  t.mock.method(fsPromises, "cp", async (...args: Parameters<typeof copy>) => {
    await copy(...args);
    if (String(args[1]).includes(".genex-stage-")) stop.abort();
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(() => installUnityBridge(f.root, stop.signal), { name: "AbortError" });
  assert.equal(await readFile(path.join(f.bridge, "Editor", "ProjectFiles.cs"), "utf8"), previous);
  assert.equal(await readFile(f.manifestFile, "utf8"), f.before);
  assert.equal(
    (await readdir(f.packages)).some((name) => name.startsWith(".genex-")),
    false,
  );
});

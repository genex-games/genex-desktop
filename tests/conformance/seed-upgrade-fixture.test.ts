import assert from "node:assert/strict";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { applySeed } from "../../src/substrate/seed-upgrade.ts";
import { cloneSeededWorkspace } from "../helpers/seed-upgrade-fixture.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

async function tinySeed(): Promise<string> {
  const seed = path.join(await tmpDir("seed-fixture-source-"), "seed");
  await mkdir(path.join(seed, "loop"), { recursive: true });
  await writeFile(path.join(seed, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(seed, "notes.md"), "first shipped notes\n");
  await writeFile(path.join(seed, "loop/provider.ts"), 'export const requiredName = "current";\n');
  await writeFile(
    path.join(seed, "loop/main.ts"),
    'import { requiredName } from "./provider.ts";\nexport const loaded = requiredName;\n',
  );
  return seed;
}

async function manifestBody(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

test("seed fixture reuses its immutable initialization with separate files and manifests per case", async () => {
  const seed = await tinySeed();
  const firstRoot = await tmpDir("seed-fixture-first-");
  const first = await cloneSeededWorkspace(seed, firstRoot);
  // The initialized snapshot is sufficient: another case must not reread or
  // reseed from the original input, even when that input is no longer present.
  await removeTree(seed);
  const second = await cloneSeededWorkspace(seed, await tmpDir("seed-fixture-second-"));
  const original = await readFile(path.join(second.ws, "loop/provider.ts"), "utf8");
  const manifest = await manifestBody(second.manifest);
  const [firstFile, secondFile] = await Promise.all([
    stat(path.join(first.ws, "loop/provider.ts"), { bigint: true }),
    stat(path.join(second.ws, "loop/provider.ts"), { bigint: true }),
  ]);
  assert.notDeepEqual([firstFile.dev, firstFile.ino], [secondFile.dev, secondFile.ino], "copies are not hardlinks");
  await writeFile(path.join(first.ws, "loop/provider.ts"), "// the first case's edit\n");
  await writeFile(first.manifest, "the first case's manifest edit\n");
  assert.equal(await readFile(path.join(second.ws, "loop/provider.ts"), "utf8"), original);
  assert.deepEqual(await manifestBody(second.manifest), manifest);
  const third = await cloneSeededWorkspace(seed, await tmpDir("seed-fixture-third-"));
  assert.equal(await readFile(path.join(third.ws, "loop/provider.ts"), "utf8"), original);
  assert.deepEqual(await manifestBody(third.manifest), manifest);
  await assert.rejects(cloneSeededWorkspace(seed, firstRoot), { code: "EEXIST" });
});

test("a relocated seed manifest produces the same real upgrade and backups as a fresh initial apply", async () => {
  const seed = await tinySeed();
  const updated = path.join(await tmpDir("seed-fixture-updated-"), "seed");
  await cp(seed, updated, { recursive: true });
  await writeFile(path.join(updated, "notes.md"), "new shipped notes\n");
  const clonedRoot = await tmpDir("seed-fixture-relocated-");
  const cloned = await cloneSeededWorkspace(seed, clonedRoot);
  const freshRoot = await tmpDir("seed-fixture-fresh-");
  const fresh = { ws: path.join(freshRoot, "workspace"), manifest: path.join(freshRoot, "manifest.json") };
  await applySeed({ seedDir: seed, workspaceDir: fresh.ws, manifestFile: fresh.manifest });
  const reports = [];
  for (const [root, fixture] of [
    [clonedRoot, cloned],
    [freshRoot, fresh],
  ] as const) {
    await writeFile(path.join(fixture.ws, "loop/provider.ts"), 'export const requiredName = "agent";\n');
    const report = await applySeed({
      seedDir: updated,
      workspaceDir: fixture.ws,
      manifestFile: fixture.manifest,
      backupDir: path.join(root, "backup"),
    });
    assert.deepEqual(report.updated, ["notes.md"]);
    assert.deepEqual(report.kept, ["loop/provider.ts"]);
    assert.equal(await readFile(path.join(root, "backup/notes.md"), "utf8"), "first shipped notes\n");
    reports.push(report);
  }
  assert.deepEqual(reports[0], reports[1]);
  assert.deepEqual(await manifestBody(cloned.manifest), await manifestBody(fresh.manifest));
});

test("a stale kept export still fails linking after another cloned workspace was already imported", async () => {
  const seed = await tinySeed();
  const first = await cloneSeededWorkspace(seed, await tmpDir("seed-fixture-loaded-"));
  const entry = (workspace: string) => pathToFileURL(path.join(workspace, "loop/main.ts")).href;
  assert.equal((await import(entry(first.ws))).loaded, "current");
  const broken = await cloneSeededWorkspace(seed, await tmpDir("seed-fixture-broken-"));
  await writeFile(path.join(broken.ws, "loop/provider.ts"), 'export const olderName = "agent";\n');
  const report = await applySeed({ seedDir: seed, workspaceDir: broken.ws, manifestFile: broken.manifest });
  assert.deepEqual(report.kept, ["loop/provider.ts"]);
  await assert.rejects(import(entry(broken.ws)), /does not provide an export named 'requiredName'/);
  const later = await cloneSeededWorkspace(seed, await tmpDir("seed-fixture-later-"));
  assert.equal((await import(entry(later.ws))).loaded, "current");
});

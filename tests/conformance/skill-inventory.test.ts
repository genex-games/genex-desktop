import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { studioSkills } from "../../src/main/skill-inventory.ts";
test("Studio skills exclude archived copies, directories, symlinks and oversized files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-skills-"));
  try {
    const dir = path.join(root, "skills");
    await mkdir(dir);
    await writeFile(path.join(dir, "director.md"), "---\nname: Director\ndescription: Run a build\n---\nInstructions");
    await writeFile(path.join(dir, "director.best.md"), "Archived");
    await writeFile(path.join(root, "outside.md"), "Private");
    await symlink(path.join(root, "outside.md"), path.join(dir, "linked.md"));
    await writeFile(path.join(dir, "large.md"), "x".repeat(256 * 1024 + 1));
    await mkdir(path.join(dir, "nested.md"));
    const skills = await studioSkills(root);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, "Director");
    assert.equal(skills[0]?.description, "Run a build");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("missing skills and redirected skills root expose no inventory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-skills-"));
  try {
    assert.deepEqual(await studioSkills(root), []);
    await mkdir(path.join(root, "outside"));
    await writeFile(path.join(root, "outside", "secret.md"), "Private");
    await symlink(path.join(root, "outside"), path.join(root, "skills"));
    assert.deepEqual(await studioSkills(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-existent workspace returns an empty skills array without throwing", async () => {
  const missing = path.join(os.tmpdir(), `studio-skills-missing-${Date.now()}`);
  assert.deepEqual(await studioSkills(missing), []);
});

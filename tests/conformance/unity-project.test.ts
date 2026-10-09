import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { mkdir, readFile, readdir, writeFile, link, symlink } from "node:fs/promises";
import {
  GameWorkspaces,
  detectProjectShape,
  findGameRoot,
  readProjectShape,
} from "../../src/substrate/game-workspace.ts";
import { validateGameDir } from "../../src/substrate/game-validation.ts";
import { tmpDir } from "../helpers/tmp.ts";

async function unityFolder(dir: string) {
  for (const folder of ["Assets", "Packages", "ProjectSettings", "Library"])
    await mkdir(path.join(dir, folder), { recursive: true });
  const originals: Record<string, string> = {
    "Assets/Player.cs": "using UnityEngine; public class Player : MonoBehaviour {}\n",
    "Assets/Player.cs.meta": "fileFormatVersion: 2\nguid: abcdef1234567890abcdef1234567890\n",
    "Assets/Level.unity": "%YAML 1.1\n--- !u!1 &1\nGameObject: {}\n",
    "Packages/manifest.json": '{"dependencies":{"com.unity.test-framework":"1.5.1"}}\n',
    "ProjectSettings/ProjectVersion.txt":
      "m_EditorVersion: 6000.3.0f1\nm_EditorVersionWithRevision: 6000.3.0f1 (fixture)\n",
    "Library/cached.txt": "never commit cache\n",
  };
  for (const [relative, content] of Object.entries(originals)) await writeFile(path.join(dir, relative), content);
  return originals;
}

function workspaces(base: string) {
  return new GameWorkspaces({
    root: path.join(base, "library"),
    templateDir: path.resolve(import.meta.dirname, "../../src/game-template"),
    vendorDir: path.join(base, "vendor"),
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
  });
}

test("Unity source projects are detected and offered directly, ahead of stale browser metadata or nearby exports", async () => {
  const root = await tmpDir("unity-project-");
  const dir = path.join(root, "my-unity-game");
  await unityFolder(dir);
  await writeFile(
    path.join(dir, "studio.json"),
    JSON.stringify({ entry: "index.html", main: "src/main.js", kind: "studio-template", own: false }),
  );
  await writeFile(path.join(dir, "index.html"), "<p>Unrelated old page</p>");
  assert.equal((await detectProjectShape(dir))?.kind, "unity");
  assert.equal((await readProjectShape(dir)).main, "Assets");
  const candidates = await findGameRoot(root);
  assert.deepEqual(
    candidates.map((candidate) => [candidate.rel, candidate.shape.kind]),
    [["my-unity-game", "unity"]],
  );
  assert.deepEqual(
    (await findGameRoot(dir)).map((candidate) => candidate.rel),
    ["."],
  );
});

test("Unity adoption adds only declared Genex metadata and history, preserving source files and existing instructions", async () => {
  const base = await tmpDir("unity-adopt-"),
    dir = path.join(base, "my-unity-game"),
    games = workspaces(base);
  const originals = await unityFolder(dir);
  await writeFile(path.join(dir, "CLAUDE.md"), "Preserve my Unity workflow\n");
  await writeFile(path.join(dir, ".gitignore"), "# user rules\nmy-private-folder/\n");
  const planned = await games.plannedWrites(dir);
  assert.deepEqual(planned, ["NOTES.md", "studio.json", ".gitignore", ".git"]);
  const inspection = await games.inspect(dir);
  assert.equal(inspection.suggested, ".");
  assert.equal(inspection.candidates[0]?.shape.kind, "unity");
  const adopted = await games.adopt(dir);
  assert.equal(adopted.shape.kind, "unity");
  assert.equal(adopted.shape.build, null);
  assert.equal(adopted.shape.install, null);
  assert.deepEqual(
    (await readdir(dir)).sort(),
    [
      ".git",
      ".gitignore",
      "Assets",
      "CLAUDE.md",
      "Library",
      "NOTES.md",
      "Packages",
      "ProjectSettings",
      "studio.json",
    ].sort(),
  );
  for (const [relative, content] of Object.entries(originals))
    assert.equal(await readFile(path.join(dir, relative), "utf8"), content, relative);
  assert.equal(await readFile(path.join(dir, "CLAUDE.md"), "utf8"), "Preserve my Unity workflow\n");
  const ignored = await readFile(path.join(dir, ".gitignore"), "utf8");
  assert.ok(ignored.startsWith("# user rules\nmy-private-folder/\n"));
  assert.ok(ignored.includes("/[Ll]ibrary/"));
  assert.ok((await readFile(path.join(dir, "NOTES.md"), "utf8")).includes("Unity Editor"));
  assert.deepEqual(await games.plannedWrites(dir), []);
});

test("Unity validation checks project structure without claiming an Editor, a compiled scene or a browser contract", async () => {
  const dir = path.join(await tmpDir("unity-validate-"), "project");
  await unityFolder(dir);
  const good = await validateGameDir(dir);
  assert.equal(good.ok, true, good.problems.join("\n"));
  assert.equal(good.shape.kind, "unity");
  assert.equal(good.contract, "missing");
  assert.ok(good.warnings.some((warning) => warning.includes("Unity Editor")));
  await writeFile(path.join(dir, "Packages", "manifest.json"), "invalid JSON");
  const bad = await validateGameDir(dir);
  assert.equal(bad.shape.kind, "unity", "an incomplete Unity project must never get a browser template");
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((problem) => problem.includes("Packages/manifest.json")));
});

test("Unity adoption refuses malformed or linked metadata before any project write", async () => {
  for (const file of ["studio.json", ".gitignore"]) {
    const base = await tmpDir("unity-adopt-hostile-"),
      dir = path.join(base, "project"),
      games = workspaces(base);
    await unityFolder(dir);
    const outside = path.join(base, "outside.json");
    await writeFile(outside, file === "studio.json" ? '{"secret":"preserve"}' : "private rule\n");
    await link(outside, path.join(dir, file));
    const before = await readdir(dir);
    await assert.rejects(games.adopt(dir), /linked|shared/);
    assert.deepEqual(await readdir(dir), before);
    assert.equal(await readFile(outside, "utf8"), file === "studio.json" ? '{"secret":"preserve"}' : "private rule\n");
  }
  const base = await tmpDir("unity-adopt-invalid-"),
    dir = path.join(base, "project"),
    games = workspaces(base);
  await unityFolder(dir);
  await writeFile(path.join(dir, "studio.json"), "invalid metadata");
  const before = await readdir(dir);
  await assert.rejects(games.adopt(dir));
  assert.deepEqual(await readdir(dir), before);
});

test("Unity metadata reached through an external directory link is never accepted as a valid project", async () => {
  const base = await tmpDir("unity-validation-link-"),
    dir = path.join(base, "project");
  await unityFolder(dir);
  const outside = path.join(base, "external-settings");
  await mkdir(outside);
  await writeFile(path.join(outside, "ProjectVersion.txt"), "m_EditorVersion: 6000.3.0f1\n");
  const alias = path.join(base, "linked-project");
  await mkdir(alias);
  await mkdir(path.join(alias, "Assets"));
  await mkdir(path.join(alias, "Packages"));
  await writeFile(path.join(alias, "Packages", "manifest.json"), '{"dependencies":{}}');
  await symlink(outside, path.join(alias, "ProjectSettings"), "junction");
  const validation = await validateGameDir(alias);
  assert.equal(validation.shape.kind, "unity", "preserve native shape even when metadata is unsafe");
  assert.equal(validation.ok, false);
  assert.ok(validation.problems.some((problem) => problem.includes("ProjectSettings")));
  assert.equal(await readFile(path.join(outside, "ProjectVersion.txt"), "utf8"), "m_EditorVersion: 6000.3.0f1\n");
});

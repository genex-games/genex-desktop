/**
 * A game's Godot project and the paths agents name in it: where the project is found, which scene
 * names reach a scene inside it (hostile ones never do, and nothing is touched), and New Godot game
 * from both templates, refused without a trace where the game's folder isn't free.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  findGameProject,
  GAME_PROJECT_FOLDER,
  ProjectError,
  projectScene,
  requireGameProject,
} from "../../src/plugins/godot/game-project.ts";
import { createProject, GodotTemplate, NewProjectError } from "../../src/plugins/godot/new-project.ts";
import { TEMPLATES } from "../helpers/godot-fake-engine.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT_FILE = "config_version=5\n";

/** A game folder, with project.godot files at each relative folder named. */
async function game(projects: string[] = []) {
  const dir = await realpath(await tmpDir("studio-godot-game-"));
  for (const folder of projects) {
    await mkdir(path.join(dir, folder), { recursive: true });
    await writeFile(path.join(dir, folder, "project.godot"), PROJECT_FILE);
  }
  return dir;
}

const exists = async (file: string) => Boolean(await lstat(file).catch(() => null));

describe("a game's Godot project", () => {
  it("is the game itself, else godot/, else the nearest one below", async () => {
    const root = await game([".", "godot"]);
    assert.equal(await findGameProject(root), root);
    const made = await game(["godot", "other"]);
    assert.equal(await findGameProject(made), path.join(made, GAME_PROJECT_FOLDER));
    const nested = await game(["client/game", "z"]);
    assert.equal(await findGameProject(nested), path.join(nested, "z"));
    const deep = await game(["a/b/c/d/e"]);
    assert.equal(await findGameProject(deep), null);
  });

  it("is never one a link leads out of the game to, nor in Godot's cache or a hidden folder", async () => {
    const outside = await game(["."]);
    const dir = await game([".godot/x", ".hidden"]);
    await symlink(outside, path.join(dir, "linked"));
    assert.equal(await findGameProject(dir), null);
    await assert.rejects(requireGameProject(dir), ProjectError);
    await assert.rejects(requireGameProject(undefined), ProjectError);
  });

  it("names a scene that is there by Godot's own path, and the main scene as empty", async () => {
    const dir = await game(["godot"]);
    const project = path.join(dir, GAME_PROJECT_FOLDER);
    await mkdir(path.join(project, "levels"));
    await writeFile(path.join(project, "levels", "one.tscn"), "[gd_scene format=3]\n");
    assert.equal(await projectScene(project, "res://levels/one.tscn"), "res://levels/one.tscn");
    assert.equal(await projectScene(project, " levels/one.tscn "), "res://levels/one.tscn");
    assert.equal(await projectScene(project, ""), "");
  });

  it("refuses every scene name that isn't a scene file inside the project", async () => {
    const dir = await game(["godot"]);
    const project = path.join(dir, GAME_PROJECT_FOLDER);
    const secret = path.join(dir, "secret.tscn");
    await writeFile(secret, "outside");
    await writeFile(path.join(project, "player.gd"), "extends Node\n");
    await symlink(secret, path.join(project, "linked.tscn"));
    const hostile = [
      "../secret.tscn",
      "res://../secret.tscn",
      "levels/../../secret.tscn",
      secret,
      "res:///etc/passwd.tscn",
      "player.gd",
      "levels\\one.tscn",
      "one\u0000.tscn",
      "res://",
      "res://levels//one.tscn",
      "linked.tscn",
      "missing.tscn",
      `${"a/".repeat(120)}x.tscn`,
    ];
    const before = await readdir(project);
    for (const asked of hostile) await assert.rejects(projectScene(project, asked), ProjectError, asked);
    assert.deepEqual(await readdir(project), before, "nothing was made or removed");
    assert.equal(await readFile(secret, "utf8"), "outside");
  });
});

describe("New Godot game", () => {
  for (const template of Object.values(GodotTemplate)) {
    it(`makes the ${template} template in godot/, named`, async () => {
      const dir = await game();
      const project = await createProject(dir, { template, name: "Moon Base" }, TEMPLATES);
      assert.equal(project, path.join(dir, GAME_PROJECT_FOLDER));
      assert.deepEqual((await readdir(project)).sort(), [
        ".gitignore",
        "icon.svg",
        "main.tscn",
        "player.gd",
        "project.godot",
      ]);
      const settings = await readFile(path.join(project, "project.godot"), "utf8");
      assert.match(settings, /config\/name="Moon Base"/);
      assert.doesNotMatch(settings, /\{\{NAME\}\}/);
      assert.match(await readFile(path.join(project, "main.tscn"), "utf8"), /groups=\["genex_shot"\]/);
      assert.equal(await findGameProject(dir), project);
    });
  }

  it("refuses a name or template it can't use, and makes nothing", async () => {
    const dir = await game();
    const asked: Array<[string, string]> = [
      ["3d", ""],
      ["3d", 'Moon"Base'],
      ["3d", "../escape"],
      ["3d", "a".repeat(41)],
      ["3d", " _starts-with-underscore"],
      ["4d", "Moon"],
      ["../2d", "Moon"],
    ];
    for (const [template, name] of asked) {
      await assert.rejects(createProject(dir, { template, name }, TEMPLATES), NewProjectError, `${template} ${name}`);
      assert.equal(await exists(path.join(dir, GAME_PROJECT_FOLDER)), false, `${template} ${name}`);
    }
  });

  it("refuses a game that is already a Godot project or has anything at godot, and leaves it as it was", async () => {
    const own = await game(["."]);
    await assert.rejects(createProject(own, { template: "3d", name: "Moon" }, TEMPLATES), NewProjectError);
    assert.equal(await exists(path.join(own, GAME_PROJECT_FOLDER)), false);
    const taken = await game();
    await writeFile(path.join(taken, GAME_PROJECT_FOLDER), "mine");
    await assert.rejects(createProject(taken, { template: "3d", name: "Moon" }, TEMPLATES), NewProjectError);
    assert.equal(await readFile(path.join(taken, GAME_PROJECT_FOLDER), "utf8"), "mine");
    const elsewhere = await game();
    const linked = await game();
    await symlink(elsewhere, path.join(linked, GAME_PROJECT_FOLDER));
    await assert.rejects(createProject(linked, { template: "3d", name: "Moon" }, TEMPLATES), NewProjectError);
    assert.deepEqual(await readdir(elsewhere), [], "nothing was written through the link");
  });
});

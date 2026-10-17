/**
 * The Godot projects the Godot panel offers to choose from: Godot's own project list and the Godot
 * Projects folders in Documents, each project once by its real folder, newest first, named as its
 * `project.godot` names it; nothing reached through a link.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { findProjects } from "../../src/plugins/godot/find-projects.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A Godot project at `folder`, named `name`, made with Godot `version`, its settings changed at `at` (s). */
async function project(folder: string, name: string, version: string, at: number) {
  await mkdir(folder, { recursive: true });
  const settings = path.join(folder, "project.godot");
  await writeFile(
    settings,
    `config_version=5\n\n[application]\n\nconfig/name="${name}"\nconfig/features=PackedStringArray("${version}", "Forward Plus")\n`,
  );
  await utimes(settings, at, at);
}

describe("the Godot projects the panel offers", () => {
  it("lists Godot's own list and the Godot Projects folders, each once, newest first", async () => {
    const home = await realpath(await tmpDir("studio-godot-home-"));
    const listed = path.join(home, "Code", "Void");
    await project(listed, 'Game of \\"Void\\"', "4.6", 3_000);
    await project(path.join(home, "Documents", "Godot Projects", "Moon"), "Moon", "4.3", 2_000);
    await project(path.join(home, "Documents", "GodotProjects", "Sun"), "Sun", "4.5", 1_000);
    await mkdir(path.join(home, "Documents", "Godot Projects", "Notes"), { recursive: true });
    await mkdir(path.join(home, "Library", "Application Support", "Godot"), { recursive: true });
    await writeFile(
      path.join(home, "Library", "Application Support", "Godot", "projects.cfg"),
      `[${listed}]\n\nfavorite=false\n\n[${path.join(home, "Documents", "Godot Projects", "Moon")}]\n\nfavorite=true\n\n[/nowhere/gone]\n`,
    );
    const found = await findProjects(home);
    assert.deepEqual(
      found.map((p) => [p.name, p.version, path.relative(home, p.folder)]),
      [
        ['Game of "Void"', "4.6", "Code/Void"],
        ["Moon", "4.3", "Documents/Godot Projects/Moon"],
        ["Sun", "4.5", "Documents/GodotProjects/Sun"],
      ],
    );
  });

  it("follows no link: a linked project, a linked projects folder or a linked project.godot is left out", async () => {
    const home = await realpath(await tmpDir("studio-godot-home-"));
    const outside = await realpath(await tmpDir("studio-godot-outside-"));
    await project(path.join(outside, "Elsewhere"), "Elsewhere", "4.6", 1_000);
    const projects = path.join(home, "Documents", "Godot Projects");
    await mkdir(projects, { recursive: true });
    await symlink(path.join(outside, "Elsewhere"), path.join(projects, "Linked"));
    await mkdir(path.join(projects, "File"));
    await symlink(path.join(outside, "Elsewhere", "project.godot"), path.join(projects, "File", "project.godot"));
    await symlink(outside, path.join(home, "Documents", "GodotProjects"));
    assert.deepEqual(await findProjects(home), []);
  });

  it("finds nothing on a Mac with no Godot projects", async () => {
    assert.deepEqual(await findProjects(await realpath(await tmpDir("studio-godot-home-"))), []);
  });
});

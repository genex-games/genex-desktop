/**
 * A Godot game linked to a project elsewhere on this Mac, through the backend on a fake Mac: the
 * panel's projects to choose from (the person's, the game's own, each once, Outside game where Rewind
 * and Loops can't reach), Use this project linking one by its real project.godot, every tool then
 * working in that project, and Set up making it Genex's play target from its own folder.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { GodotTool } from "../../src/plugins/godot/backend.ts";
import { GodotJob } from "../../src/plugins/godot/godot-run.ts";
import { godotBackendFixture } from "../helpers/godot-fake-engine.ts";

type Answer = Record<string, unknown>;

/** A Godot project named `name` in `folder`. */
async function godotProject(folder: string, name: string) {
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, "project.godot"),
    `config_version=5\n\n[application]\n\nconfig/name="${name}"\nconfig/features=PackedStringArray("4.6")\n`,
  );
  return realpath(folder);
}

describe("a Godot game linked to a project elsewhere", () => {
  it("offers the person's projects and the game's own, then uses the chosen one in every tool", async () => {
    const fixture = await godotBackendFixture();
    const void_ = await godotProject(path.join(fixture.home, "Documents", "Godot Projects", "Void"), "Game of Void");
    const own = await godotProject(path.join(fixture.gameDir, "godot"), "Moon");
    const action = async (name: string, args = {}) =>
      (await fixture.backend.action?.(name, args, fixture.context())) as Answer;

    const before = await action("status");
    assert.equal(before.project, "godot", "the game's own project at first");
    assert.deepEqual(
      (before.projects as Answer[]).map((p) => [p.name, p.inUse, p.outside]),
      [
        ["Moon", true, false],
        ["Game of Void", false, true],
      ],
    );

    assert.deepEqual(await action("use-project", { folder: void_ }), { linked: void_ });
    const link = fixture.hostCalls.find((call) => call.method === "game.engine.link");
    assert.deepEqual(link?.args, { project: path.join(void_, "project.godot") }, "linked by its real project.godot");

    const after = await action("status");
    assert.equal(after.project, void_, "an outside project by its own folder");
    assert.equal(after.outside, true);
    assert.equal(after.projectName, "Game of Void");
    fixture.jobs.length = 0;
    await fixture.backend.tool?.(GodotTool.Check, {}, fixture.context());
    assert.ok(
      fixture.jobs.every((job) => job.call.writes.includes(void_)),
      "Godot's check works in the linked project",
    );
    assert.ok(!fixture.jobs.some((job) => job.call.writes.includes(own)), "never in the game's own one");
    assert.ok(fixture.jobs.some((job) => job.call.job === GodotJob.Check));
  });

  it("sets a linked project up from its own folder: the addon there, bin/play naming it by its path", async () => {
    const fixture = await godotBackendFixture();
    const void_ = await godotProject(path.join(fixture.home, "Documents", "Godot Projects", "Void"), "Game of Void");
    await fixture.backend.action?.("use-project", { folder: void_ }, fixture.context());
    await fixture.backend.tool?.(GodotTool.SetUp, {}, fixture.context());
    assert.match(await readFile(path.join(void_, "project.godot"), "utf8"), /GenexPlay=/);
    const launcher = await readFile(path.join(fixture.gameDir, "bin", "play"), "utf8");
    assert.ok(launcher.includes(`--path '${void_}' --no-header`), launcher);
    const studio = JSON.parse(await readFile(path.join(fixture.gameDir, "studio.json"), "utf8"));
    assert.equal(studio.play.engine.args[1], void_, "Genex's engine plays it there too");
  });

  it("refuses a folder that isn't a Godot project, linking nothing", async () => {
    const fixture = await godotBackendFixture();
    const notes = path.join(fixture.home, "Notes");
    await mkdir(notes, { recursive: true });
    for (const folder of [notes, "relative/Void", path.join(fixture.home, "missing")])
      await assert.rejects(
        fixture.backend.action?.("use-project", { folder }, fixture.context()) ?? Promise.resolve(),
        /isn't a Godot project folder/,
        folder,
      );
    assert.equal(fixture.hostCalls.filter((call) => call.method === "game.engine.link").length, 0);
  });
});

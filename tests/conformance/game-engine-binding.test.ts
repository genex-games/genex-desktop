/**
 * A game's engine record (studio.json `engine`) is what makes Genex treat a game as an engine game
 * (an Unreal one, or any engine an installed plugin declares): the brief, the health check, the
 * Live tab and the Loop all ask it. studio.json sits in the folder agents write, so the record is
 * only believed while its kind is an installed plugin's engine and its project file is still a
 * regular file of that engine's declared kind at exactly the recorded real path, and a refused link
 * changes nothing on disk.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { engineOf, GameEngine, parseEngineBinding, projectName } from "../../src/shared/game-engine.ts";
import {
  EngineLinkError,
  EngineLinkErrorCode,
  readEngineBinding,
  restoreEngineBinding,
  writeEngineBinding,
} from "../../src/substrate/game-engine-binding.ts";
import { ENGINES, TOY_ENGINE, UNREAL_ENGINE } from "../helpers/engines.ts";
import { tmpDir } from "../helpers/tmp.ts";

const NOW = () => new Date("2026-10-04T12:00:00.000Z");
const UNREAL = GameEngine.Unreal;
const AT = { now: NOW };

async function world() {
  const root = await realpath(await tmpDir("studio-engine-"));
  const game = path.join(root, "games", "valley");
  const projects = path.join(root, "Unreal Projects", "Valley");
  await mkdir(game, { recursive: true });
  await mkdir(projects, { recursive: true });
  const project = path.join(projects, "Valley.uproject");
  await writeFile(project, '{"FileVersion":3}\n');
  const studio = path.join(game, "studio.json");
  await writeFile(studio, `${JSON.stringify({ name: "valley", title: "Fog Valley", contractVersion: 1 }, null, 2)}\n`);
  return { root, game, project, studio };
}

test("linking records the project's real path beside everything studio.json already held", async () => {
  const { game, project, studio } = await world();
  const { binding, previous } = await writeEngineBinding(game, project, UNREAL, ENGINES, AT);
  assert.deepEqual(binding, { kind: GameEngine.Unreal, project, linkedAt: "2026-10-04T12:00:00.000Z" });
  assert.equal(previous, undefined);
  const saved = JSON.parse(await readFile(studio, "utf8"));
  assert.equal(saved.title, "Fog Valley");
  assert.equal(saved.contractVersion, 1);
  assert.deepEqual(await readEngineBinding(game, ENGINES), binding);
  assert.equal(engineOf(binding), GameEngine.Unreal);
  assert.equal(engineOf(undefined), GameEngine.Web);
  assert.equal(projectName(project), "Valley");
});

test("a link through a symbolic link records where it really points", async () => {
  const { root, game, project } = await world();
  const alias = path.join(root, "Alias.uproject");
  await symlink(project, alias);
  const { binding } = await writeEngineBinding(game, alias, UNREAL, ENGINES, AT);
  assert.equal(binding.project, project);
});

test("hostile project paths are refused and leave studio.json byte-identical", async () => {
  const { root, game, project, studio } = await world();
  const before = await readFile(studio, "utf8");
  const notProject = path.join(root, "notes.txt");
  await writeFile(notProject, "hi");
  const folderNamedProject = path.join(root, "Folder.uproject");
  await mkdir(folderNamedProject);
  const linkToText = path.join(root, "Fake.uproject");
  await symlink(notProject, linkToText);
  const cases: [string, string, EngineLinkErrorCode][] = [
    ["relative", "Unreal Projects/Valley/Valley.uproject", EngineLinkErrorCode.NotProject],
    ["dot-dot", `${path.dirname(project)}/../Valley/Valley.uproject`, EngineLinkErrorCode.NotProject],
    ["not a project", notProject, EngineLinkErrorCode.NotProject],
    ["missing", path.join(root, "Gone.uproject"), EngineLinkErrorCode.Missing],
    ["a folder", folderNamedProject, EngineLinkErrorCode.NotFile],
    ["a link to a text file", linkToText, EngineLinkErrorCode.NotProject],
    ["control characters", `${root}/Bad\nName.uproject`, EngineLinkErrorCode.NotProject],
    ["empty", "", EngineLinkErrorCode.NotProject],
  ];
  for (const [label, file, code] of cases) {
    await assert.rejects(writeEngineBinding(game, file, UNREAL, ENGINES, AT), (error: unknown) => {
      assert.ok(error instanceof EngineLinkError, label);
      assert.equal(error.code, code, label);
      return true;
    });
    assert.equal(await readFile(studio, "utf8"), before, `${label}: studio.json unchanged`);
  }
});

test("a studio.json that does not parse is never replaced by a link", async () => {
  const { game, project, studio } = await world();
  await writeFile(studio, "{ not json");
  await assert.rejects(writeEngineBinding(game, project, UNREAL, ENGINES, AT));
  assert.equal(await readFile(studio, "utf8"), "{ not json");
});

test("a record stops holding when its project file is swapped for a link, moved, or deleted", async () => {
  const { root, game, project } = await world();
  await writeEngineBinding(game, project, UNREAL, ENGINES, AT);
  const elsewhere = path.join(root, "Elsewhere.uproject");
  await writeFile(elsewhere, "{}");

  await rename(project, `${project}.bak`);
  await symlink(elsewhere, project);
  assert.equal(await readEngineBinding(game, ENGINES), undefined, "a link in place of the file");

  await rm(project);
  assert.equal(await readEngineBinding(game, ENGINES), undefined, "deleted");

  await rename(`${project}.bak`, project);
  assert.equal((await readEngineBinding(game, ENGINES))?.project, project, "back where it was");

  const folder = path.dirname(project);
  await rename(folder, `${folder}-real`);
  await symlink(`${folder}-real`, folder);
  assert.equal(await readEngineBinding(game, ENGINES), undefined, "a link in place of a folder on the way");
});

test("records an agent wrote by hand only count when their shape is right", () => {
  const cases: unknown[] = [
    null,
    "unreal",
    [],
    { kind: "godot", project: "/a/b.uproject" },
    { kind: "unreal" },
    { kind: "unreal", project: "b.uproject" },
    { kind: "unreal", project: "/a/../b.uproject" },
    { kind: "unreal", project: "/a/b.umap" },
    { kind: "unreal", project: 42 },
    { kind: "unreal", project: "/a/Moon/project.godot" },
    { kind: "godot", project: "/a/Moon" },
    { kind: "godot", project: "/a/Moon/project.godot.bak" },
    { kind: "godot", project: "/a/Moon/Project.godot" },
    { kind: "godot", project: "Moon/project.godot" },
    { kind: "godot", project: "/a/../Moon/project.godot" },
  ];
  for (const raw of cases) assert.equal(parseEngineBinding(raw, ENGINES), undefined, JSON.stringify(raw));
  assert.deepEqual(parseEngineBinding({ kind: "unreal", project: "/a/B.uproject", linkedAt: "nonsense" }, ENGINES), {
    kind: GameEngine.Unreal,
    project: "/a/B.uproject",
    linkedAt: "",
  });
  assert.deepEqual(
    parseEngineBinding(
      { kind: "godot", project: "/a/Moon/project.godot", linkedAt: "2026-10-15T00:00:00.000Z" },
      ENGINES,
    ),
    { kind: GameEngine.Godot, project: "/a/Moon/project.godot", linkedAt: "2026-10-15T00:00:00.000Z" },
    "a Godot project's project.godot, kind godot",
  );
});

test("Undo puts back the record a link replaced, or none", async () => {
  const { root, game, project, studio } = await world();
  const other = path.join(root, "Other.uproject");
  await writeFile(other, "{}");
  const first = await writeEngineBinding(game, project, UNREAL, ENGINES, AT);
  const second = await writeEngineBinding(game, other, UNREAL, ENGINES, AT);
  assert.deepEqual(second.previous, first.binding);

  await restoreEngineBinding(game, second.previous);
  assert.deepEqual(await readEngineBinding(game, ENGINES), first.binding);

  await restoreEngineBinding(game, undefined);
  assert.equal(await readEngineBinding(game, ENGINES), undefined);
  const saved = JSON.parse(await readFile(studio, "utf8"));
  assert.equal(saved.engine, undefined);
  assert.equal(saved.title, "Fog Valley");
});

/** A game and a toy-engine project beside it, for an engine other than Unreal. */
async function toyWorld() {
  const w = await world();
  const toys = path.join(w.root, "Toy Projects", "Garden");
  await mkdir(toys, { recursive: true });
  const toy = path.join(toys, "Garden.toyproj");
  await writeFile(toy, "toy\n");
  return { ...w, toy };
}

test("a game links to any installed engine's project file and reads back as that engine", async () => {
  const { game, toy, studio } = await toyWorld();
  const remote = { placeId: "1818", universeId: "2929" };
  const { binding } = await writeEngineBinding(game, toy, TOY_ENGINE.id, ENGINES, { now: NOW, remote });
  assert.deepEqual(binding, { kind: TOY_ENGINE.id, project: toy, linkedAt: NOW().toISOString(), remote });
  assert.equal(JSON.parse(await readFile(studio, "utf8")).engine.kind, TOY_ENGINE.id);
  assert.deepEqual(await readEngineBinding(game, ENGINES), binding);
  assert.equal(engineOf(binding), TOY_ENGINE.id);
  assert.equal(projectName(toy, TOY_ENGINE.projectFiles), "Garden");
  const unrealOnly = new Map([[UNREAL_ENGINE.id, UNREAL_ENGINE]]);
  assert.equal(await readEngineBinding(game, unrealOnly), undefined, "an engine no installed plugin declares");
});

test("hostile toy links are refused and leave studio.json byte-identical", async () => {
  const { root, game, project, toy, studio } = await toyWorld();
  const before = await readFile(studio, "utf8");
  const disguised = path.join(root, "Disguised.toyproj");
  await symlink(project, disguised);
  const long = `${root}/${"g".repeat(1025 - root.length - "/.toyproj".length)}.toyproj`;
  assert.equal(long.length, 1025);
  const cases: [string, string, string, EngineLinkErrorCode][] = [
    ["a .toyproj under an undeclared kind", toy, "kiln", EngineLinkErrorCode.NotEngine],
    ["an Unreal kind with a .toyproj path", toy, UNREAL, EngineLinkErrorCode.NotProject],
    ["dot-dot", `${path.dirname(toy)}/../Garden/Garden.toyproj`, TOY_ENGINE.id, EngineLinkErrorCode.NotProject],
    ["relative", "Toy Projects/Garden/Garden.toyproj", TOY_ENGINE.id, EngineLinkErrorCode.NotProject],
    ["a .toyproj linked to an Unreal project", disguised, TOY_ENGINE.id, EngineLinkErrorCode.NotProject],
    ["control characters", `${root}/Bad\u0007Name.toyproj`, TOY_ENGINE.id, EngineLinkErrorCode.NotProject],
    ["1025 characters", long, TOY_ENGINE.id, EngineLinkErrorCode.NotProject],
  ];
  for (const [label, file, kind, code] of cases) {
    await assert.rejects(writeEngineBinding(game, file, kind, ENGINES, AT), (error: unknown) => {
      assert.ok(error instanceof EngineLinkError, label);
      assert.equal(error.code, code, label);
      return true;
    });
    assert.equal(await readFile(studio, "utf8"), before, `${label}: studio.json unchanged`);
  }
});

test("a project's name drops its engine's own extension, however many dotted parts it has", () => {
  const roblox = [".rbxl", ".rbxlx", ".project.json"];
  assert.equal(projectName("/games/a/a.project.json", roblox), "a");
  assert.equal(projectName("/games/a/Lantern.rbxlx", roblox), "Lantern");
  assert.equal(projectName("C:\\Games\\Lantern\\LANTERN.TOYPROJ", TOY_ENGINE.projectFiles), "LANTERN");
  assert.equal(projectName("/games/Valley/Valley.uproject"), "Valley", "Unreal's when none are given");
});

test("hand-written records of an installed engine count by its own project files, and a bad remote is dropped", () => {
  const toy = "/a/Garden.toyproj";
  const cases: unknown[] = [
    { kind: "kiln", project: toy },
    { kind: TOY_ENGINE.id, project: "/a/Garden.uproject" },
    { kind: UNREAL, project: toy },
    { kind: TOY_ENGINE.id, project: "Garden.toyproj" },
  ];
  for (const raw of cases) assert.equal(parseEngineBinding(raw, ENGINES), undefined, JSON.stringify(raw));
  const remote = { placeId: "18", universeId: "29" };
  assert.deepEqual(parseEngineBinding({ kind: TOY_ENGINE.id, project: toy, linkedAt: "", remote }, ENGINES), {
    kind: TOY_ENGINE.id,
    project: toy,
    linkedAt: "",
    remote,
  });
  for (const bad of [18, { placeId: "0", universeId: "29" }, { placeId: "18" }, "18"])
    assert.deepEqual(
      parseEngineBinding({ kind: TOY_ENGINE.id, project: toy, linkedAt: "", remote: bad }, ENGINES),
      { kind: TOY_ENGINE.id, project: toy, linkedAt: "" },
      JSON.stringify(bad),
    );
});

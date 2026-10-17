/**
 * The Unreal plugin carries the Genex editor helper: a small Unreal plugin that Set up Unreal
 * copies into a game's Plugins folder so the editor's MCP server gains the play, loop and build
 * tools. Unreal loads it without compiling only while it declares no C++ modules, without a
 * .uproject entry only while it is enabled by default, and runs its Python only from a content
 * plugin; the build tools need Geometry Script, which the helper turns on itself. A project still
 * holding an older helper reads as outdated, so Genex offers the shipped one.
 */
import assert from "node:assert/strict";
import { copyFile, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { buildPlugins } from "../../scripts/build-plugins.mjs";
import { HelperState, inspectProject, type SetupEnv } from "../../src/plugins/unreal/setup.ts";
import { XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { tmpDir } from "../helpers/tmp.ts";

const HELPER = path.resolve("src/plugins/unreal/GenexEditorHelper");
/** The descriptor of the helper Genex shipped as 0.4.0, as projects set up before 0.5.0 hold it. */
const INSTALLED_0_4_0 = path.resolve("tests/fixtures/unreal-helper/installed-0.4.0.uplugin");

async function relativeFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

test("the built Unreal plugin carries the editor helper, which Unreal loads without compiling", async () => {
  const resources = path.join(await tmpDir("studio-unreal-helper-"), "resources");
  await buildPlugins(process.cwd(), resources, { dependencies: false });
  const helper = path.join(resources, "plugins/unreal/GenexEditorHelper");

  assert.deepEqual(await relativeFiles(helper), [
    "Content/Python/genex_build/__init__.py",
    "Content/Python/genex_build/args.py",
    "Content/Python/genex_build/atmosphere.py",
    "Content/Python/genex_build/audit.py",
    "Content/Python/genex_build/character.py",
    "Content/Python/genex_build/character_math.py",
    "Content/Python/genex_build/compile_log.py",
    "Content/Python/genex_build/gx.py",
    "Content/Python/genex_build/imports.py",
    "Content/Python/genex_build/kit.py",
    "Content/Python/genex_build/material.py",
    "Content/Python/genex_build/mesh_math.py",
    "Content/Python/genex_build/models.py",
    "Content/Python/genex_build/motion.py",
    "Content/Python/genex_build/outs.py",
    "Content/Python/genex_build/place.py",
    "Content/Python/genex_build/pose_math.py",
    "Content/Python/genex_build/retarget.py",
    "Content/Python/genex_build/rig_math.py",
    "Content/Python/genex_build/routes.py",
    "Content/Python/genex_build/scope.py",
    "Content/Python/genex_build/script_files.py",
    "Content/Python/genex_build/scripts.py",
    "Content/Python/genex_build/shots.py",
    "Content/Python/genex_build/sockets.py",
    "Content/Python/genex_build/terrain.py",
    "Content/Python/genex_build/terrain_math.py",
    "Content/Python/genex_build/tools.py",
    "Content/Python/genex_build/world_materials.py",
    "Content/Python/genex_loop/__init__.py",
    "Content/Python/genex_loop/activity.py",
    "Content/Python/genex_loop/assets.py",
    "Content/Python/genex_loop/blueprints.py",
    "Content/Python/genex_loop/capture.py",
    "Content/Python/genex_loop/cpp.py",
    "Content/Python/genex_loop/editor.py",
    "Content/Python/genex_loop/editor_log.py",
    "Content/Python/genex_loop/errors.py",
    "Content/Python/genex_loop/part_api.py",
    "Content/Python/genex_loop/part_files.py",
    "Content/Python/genex_loop/parts.py",
    "Content/Python/genex_loop/paths.py",
    "Content/Python/genex_loop/probes.py",
    "Content/Python/genex_loop/project.py",
    "Content/Python/genex_loop/reference.py",
    "Content/Python/genex_loop/session.py",
    "Content/Python/genex_loop/tools.py",
    "Content/Python/genex_play/__init__.py",
    "Content/Python/genex_play/motion.py",
    "Content/Python/genex_play/play.py",
    "Content/Python/genex_play/route.py",
    "Content/Python/genex_play/route_math.py",
    "Content/Python/genex_play/tools.py",
    "Content/Python/init_unreal.py",
    "GenexEditorHelper.uplugin",
  ]);
  const descriptor = JSON.parse(await readFile(path.join(helper, "GenexEditorHelper.uplugin"), "utf8"));
  assert.equal(descriptor.Modules, undefined, "a C++ module would need a compiler");
  assert.equal(descriptor.EnabledByDefault, true, "the game's .uproject stays untouched");
  assert.equal(descriptor.CanContainContent, true, "Unreal runs Content/Python only for content plugins");
  assert.equal(descriptor.EditorOnly, true, "a packaged game never carries it");
  assert.deepEqual([descriptor.Version, descriptor.VersionName], [10, "0.8.0"]);
  const geometry = descriptor.Plugins.filter((plugin: { Name: string }) => plugin.Name === "GeometryScripting");
  assert.deepEqual(geometry, [{ Name: "GeometryScripting", Enabled: true }], "the terrain tool needs Geometry Script");
});

/** A Mac with nothing running: inspecting a project reads its files only. */
function quietEnv(home: string): SetupEnv {
  const xcode = {
    state: XcodeState.Missing,
    app: null,
    version: null,
    commandLineTools: true,
    supported: null,
    command: null,
  };
  return {
    home,
    platform: "darwin",
    programData: path.join(home, "ProgramData"),
    editorRunning: async () => false,
    portListening: async () => false,
    editorAnswers: async () => false,
    xcode: async () => xcode,
    freeBytes: async () => 2 ** 40,
    totalMemory: () => 2 ** 35,
  };
}

test("a project still holding the 0.4.0 helper reads as outdated against the shipped one", async () => {
  const root = await tmpDir("studio-unreal-helper-0.4.0-");
  const project = path.join(root, "Drift");
  const installed = path.join(project, "Plugins", "GenexEditorHelper");
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(project, "Drift.uproject"),
    `${JSON.stringify({ FileVersion: 3, EngineAssociation: "5.8" })}\n`,
  );
  // Every file as shipped but the descriptor, which still says 0.4.0.
  await cp(HELPER, installed, { recursive: true });
  await copyFile(INSTALLED_0_4_0, path.join(installed, "GenexEditorHelper.uplugin"));
  const options = { env: quietEnv(path.join(root, "home")), helper: HELPER, storage: path.join(root, "storage") };

  const state = await inspectProject(path.join(project, "Drift.uproject"), options);
  assert.equal(state.helper, HelperState.Outdated);
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { commandAllowed, type GatePlace, GateRefusal, gateCall } from "../../src/plugins/unity/pipeline-gate.ts";
import type { PipelineCommand } from "../../src/plugins/unity/pipeline.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A catalogue entry as the editor lists it, with each parameter's type. */
const command = (name: string, parameters: Record<string, string> = {}): PipelineCommand => ({
  name,
  description: "",
  tags: [],
  parameters: Object.entries(parameters).map(([key, type]) => ({ name: key, type, required: false, description: "" })),
});

/** The commands the tests call, typed as Pipeline 0.8 lists them. */
const CATALOGUE: PipelineCommand[] = [
  command("editor_play"),
  command("open_scene", { path: "String", additive: "Boolean" }),
  command("import_asset", { source: "String", path: "String", confirm: "Boolean" }),
  command("capture_game_view", { save_path: "String", source: "String", width: "Int32" }),
  command("create_prefab", { source: "ObjectRef", path: "String" }),
  command("delete_gameobject", { target: "ObjectRef", confirm: "Boolean" }),
  command("set_selection", { paths: "String[]" }),
  command("reload_file", { filename: "String", assemblyDir: "String" }),
  command("screenshot", { output: "String" }),
  command("find_gameobjects", { hierarchy_path: "String" }),
  command("batch", { operations: "List`1", transactional: "Boolean" }),
  command("eval", { code: "String" }),
  command("run_script", { file: "String" }),
  command("package_add", { identifier: "String", confirm: "Boolean" }),
  command("package_remove", { name: "String", confirm: "Boolean" }),
  command("package_list", { scope: "String" }),
  command("build", { target: "String", outputPath: "String", scenes: "String[]", confirm: "Boolean" }),
  command("switch_build_target", { target: "String", confirm: "Boolean" }),
  command("menu", { path: "String" }),
];

/** A game folder with its Unity project in `unity/`, a file of the game beside it, and a folder outside. */
async function place(): Promise<GatePlace & { outside: string }> {
  const game = await realpath(await tmpDir("unity-gate-"));
  const outside = await realpath(await tmpDir("unity-gate-outside-"));
  const root = path.join(game, "unity");
  await mkdir(path.join(root, "Assets", "Scenes"), { recursive: true });
  await mkdir(path.join(game, "assets"));
  await writeFile(path.join(root, "Assets", "Scenes", "Main.unity"), "");
  await writeFile(path.join(game, "assets", "ship.glb"), "");
  await writeFile(path.join(outside, "secret.txt"), "");
  return { root, game, outside };
}

const gate = (at: GatePlace, name: unknown, parameters?: unknown) => gateCall(at, CATALOGUE, name, parameters);

describe("the gate on Unity's Pipeline commands", () => {
  it("lets through what a person does in Unity: packages, builds, the build target and menu items", () => {
    const allowed = [
      "editor_play",
      "editor_stop",
      "capture_game_view",
      "get_scene_hierarchy",
      "recompile",
      "save_all",
      "set_tags_layers",
      "set_physics_settings",
      "set_player_settings",
      "add_scene_to_build",
      "batch",
      "run_script",
      "package_list",
      "package_search",
      "package_status",
      "package_add",
      "package_remove",
      "package_resolve",
      "package_embed",
      "build",
      "build_status",
      "switch_build_target",
      "menu",
    ];
    for (const name of allowed) assert.equal(commandAllowed(name), true, name);
  });

  it("refuses the commands that run code text, end the editor or loosen Genex's own hold on it", () => {
    const denied = [
      "eval",
      "eval_file",
      "quit",
      "set_authoring_root",
      "set_runtime_pipeline_settings",
      "add_package",
      "remove_package",
      "EVAL",
      "Quit",
    ];
    for (const name of denied) assert.equal(commandAllowed(name), false, name);
  });

  it("refuses anything that is no command of this editor before it reaches the editor", async () => {
    const at = await place();
    const notCommands: unknown[] = ["", " eval", "editor play", "a/b", "../x", "x".repeat(65), "fly_away", 7, null, {}];
    for (const name of notCommands)
      assert.deepEqual(await gate(at, name, {}), { ok: false, refusal: GateRefusal.NotACommand }, String(name));
  });

  it("answers the command and its parameters once they pass", async () => {
    const at = await place();
    assert.deepEqual(await gate(at, "open_scene", { path: "Assets/Scenes/Main.unity", additive: false }), {
      ok: true,
      command: "open_scene",
      parameters: { path: "Assets/Scenes/Main.unity", additive: false },
    });
    assert.deepEqual(await gate(at, "editor_play", undefined), { ok: true, command: "editor_play", parameters: {} });
    for (const name of ["eval", "quit"])
      assert.deepEqual(await gate(at, name, {}), { ok: false, refusal: GateRefusal.Denied, command: name }, name);
    assert.equal((await gate(at, "package_list", { scope: "installed" })).ok, true);
    for (const parameters of [7, "x", [1], null])
      assert.deepEqual(
        await gate(at, "editor_play", parameters),
        { ok: false, refusal: GateRefusal.NotParameters },
        JSON.stringify(parameters),
      );
  });

  it("keeps every file a command names inside the game's folder, by real path", async () => {
    const at = await place();
    await symlink(at.outside, path.join(at.root, "Assets", "Linked"));
    await symlink(path.join(at.outside, "secret.txt"), path.join(at.game, "assets", "secret.txt"));
    const inside: Array<[string, Record<string, unknown>]> = [
      ["open_scene", { path: "Assets/Scenes/Main.unity" }],
      ["open_scene", { path: "Scenes/Main.unity" }],
      ["capture_game_view", { save_path: "Temp/Genex/shot.png" }],
      ["capture_game_view", { source: "camera" }],
      ["import_asset", { source: "../assets/ship.glb", path: "Models/ship.glb" }],
      ["import_asset", { source: path.join(at.game, "assets", "ship.glb"), path: "Models/ship.glb" }],
      ["set_selection", { paths: ["Assets/Scenes/Main.unity", "Assets"] }],
      ["reload_file", { filename: "Assets/Scripts/Player.cs", assemblyDir: "Library/ScriptAssemblies" }],
      ["run_script", { file: "Assets/Editor/BuildLevel.cs", entry: "BuildLevel.Run" }],
    ];
    for (const [name, parameters] of inside)
      assert.equal((await gate(at, name, parameters)).ok, true, `${name} ${JSON.stringify(parameters)}`);

    const hostile: Array<[string, Record<string, unknown>, string]> = [
      ["import_asset", { source: "/etc/passwd", path: "x.txt" }, "source"],
      ["import_asset", { source: "../../outside.txt", path: "x.txt" }, "source"],
      ["import_asset", { source: "..\\..\\outside.txt", path: "x.txt" }, "source"],
      ["import_asset", { source: path.join(at.outside, "secret.txt"), path: "x.txt" }, "source"],
      ["import_asset", { source: "../assets/secret.txt", path: "x.txt" }, "source"],
      ["import_asset", { source: "Assets/Linked/secret.txt", path: "x.txt" }, "source"],
      ["import_asset", { source: "../assets/ship.glb", path: "Assets/Linked/new/ship.glb" }, "path"],
      ["capture_game_view", { save_path: path.join(at.outside, "shot.png") }, "save_path"],
      ["screenshot", { output: "/tmp/shot.png" }, "output"],
      ["open_scene", { path: "Assets/Scenes/Main.unity\u0000.png" }, "path"],
      ["open_scene", { path: "" }, "path"],
      ["set_selection", { paths: ["Assets", "../../outside"] }, "paths"],
      ["reload_file", { filename: "Assets/a.cs", assemblyDir: "/tmp" }, "assemblyDir"],
      ["run_script", { file: path.join(at.outside, "Build.cs") }, "file"],
      ["run_script", { file: "../../Build.cs" }, "file"],
    ];
    for (const [name, parameters, parameter] of hostile)
      assert.deepEqual(
        await gate(at, name, parameters),
        { ok: false, refusal: GateRefusal.PathOutside, parameter },
        `${name} ${JSON.stringify(parameters)}`,
      );
  });

  it("reads a path only where the editor does: an object reference or a hierarchy path is no file", async () => {
    const at = await place();
    const references: Array<[string, Record<string, unknown>]> = [
      ["delete_gameobject", { target: "/Player", confirm: true }],
      ["create_prefab", { source: "/Player/Ship", path: "Prefabs/Ship.prefab" }],
      ["create_prefab", { source: { instanceId: -4086 }, path: "Prefabs/Ship.prefab" }],
      ["find_gameobjects", { hierarchy_path: "/Environment/Rocks" }],
    ];
    for (const [name, parameters] of references)
      assert.equal((await gate(at, name, parameters)).ok, true, `${name} ${JSON.stringify(parameters)}`);
    assert.deepEqual(await gate(at, "create_prefab", { source: "/Player", path: "/tmp/Ship.prefab" }), {
      ok: false,
      refusal: GateRefusal.PathOutside,
      parameter: "path",
    });
  });

  it("adds packages from the registry or a repository, and from a folder only inside the game", async () => {
    const at = await place();
    const add = (identifier: unknown) => gate(at, "package_add", { identifier, confirm: true });
    const allowed = [
      "com.unity.render-pipelines.high-definition@17.3.0",
      "com.unity.inputsystem",
      "https://github.com/example/tool.git#v1.2.0",
      "file:../../assets/local-package",
      "file:LocalPackage",
    ];
    for (const identifier of allowed) assert.equal((await add(identifier)).ok, true, identifier);
    const outside = { ok: false, refusal: GateRefusal.PathOutside, parameter: "identifier" };
    const hostile = ["file:../../../outside", `file:${at.outside}`, "file:/etc", "file:", "FILE:/etc", "file:a\u0000b"];
    for (const identifier of hostile) assert.deepEqual(await add(identifier), outside, identifier);
    assert.equal((await gate(at, "package_remove", { name: "com.unity.inputsystem", confirm: true })).ok, true);
  });

  it("builds a player only into a folder inside the game, named by the call", async () => {
    const at = await place();
    const build = (parameters: Record<string, unknown>) =>
      gate(at, "build", { target: "StandaloneOSX", ...parameters });
    assert.equal((await build({ outputPath: "Builds/Mac/Game.app", confirm: true })).ok, true);
    assert.equal((await build({ outputPath: "Builds/Mac/Game.app", dry_run: true })).ok, true);
    const outside = { ok: false, refusal: GateRefusal.PathOutside, parameter: "outputPath" };
    assert.deepEqual(await build({ confirm: true }), outside, "Unity's last build folder may be anywhere");
    assert.deepEqual(await build({ outputPath: "/Applications/Game.app", confirm: true }), outside);
    assert.deepEqual(await build({ outputPath: "../../Game.app", confirm: true }), outside);
    assert.equal((await gate(at, "switch_build_target", { target: "StandaloneOSX", confirm: true })).ok, true);
  });

  it("runs menu items, except those that end the editor or open another project in it", async () => {
    const at = await place();
    const menu = (item: string) => gate(at, "menu", { path: item });
    for (const item of [
      "Window/Package Manager",
      "Assets/Reimport All",
      "Edit/Project Settings...",
      "GameObject/3D Object/Cube",
    ])
      assert.equal((await menu(item)).ok, true, item);
    for (const item of [
      "File/Exit",
      "Unity/Quit",
      "Unity/Quit Unity",
      "File/Open Project...",
      "File/New Project...",
      "File/Open Recent/Game",
      "file/exit",
    ])
      assert.deepEqual(await menu(item), { ok: false, refusal: GateRefusal.Denied, command: "menu" }, item);
  });

  it("holds every operation of a batch to the same rules", async () => {
    const at = await place();
    const batch = (operations: unknown) => gate(at, "batch", { operations, transactional: false });
    const scene = { path: "Assets/Scenes/Main.unity" };
    const passing: unknown[][] = [
      [
        { command: "open_scene", params: scene },
        { id: "play", command: "editor_play" },
      ],
      [{ command: "open_scene", params: JSON.stringify(scene) }],
      [{ command: "delete_gameobject", params: { target: "$0.hierarchyPath", confirm: true } }],
    ];
    for (const operations of passing) assert.equal((await batch(operations)).ok, true, JSON.stringify(operations));

    const denied = (name: string) => ({ refusal: GateRefusal.Denied, command: name });
    const outside = (parameter: string) => ({ refusal: GateRefusal.PathOutside, parameter });
    const malformed = { refusal: GateRefusal.NotParameters };
    const refused: Array<[string, unknown, object]> = [
      ["a denied command", [{ command: "editor_play" }, { command: "eval", params: { code: "1" } }], denied("eval")],
      [
        "a package from a folder outside the game",
        [{ command: "package_add", params: { identifier: "file:../../../outside", confirm: true } }],
        outside("identifier"),
      ],
      ["a menu item that ends the editor", [{ command: "menu", params: { path: "File/Exit" } }], denied("menu")],
      ["a command the editor lacks", [{ command: "fly_away" }], { refusal: GateRefusal.NotACommand }],
      [
        "a file outside the game",
        [{ command: "import_asset", params: { source: "/etc/passwd", path: "x" } }],
        outside("source"),
      ],
      [
        "a file named by an earlier operation's answer",
        [{ command: "import_asset", params: { source: "$0.contents", path: "x" } }],
        outside("source"),
      ],
      ["a nested batch", [{ command: "batch", params: { operations: [] } }], denied("batch")],
      ["operations that are no list", { command: "eval" }, malformed],
      ["an operation that is no object", ["eval"], malformed],
      ["parameters that are no object", [{ command: "editor_play", params: 7 }], malformed],
      ["parameters as text that is no object", [{ command: "editor_play", params: "[1]" }], malformed],
      ["no operations at all", undefined, malformed],
    ];
    for (const [what, operations, refusal] of refused)
      assert.deepEqual(await batch(operations), { ok: false, ...refusal }, what);
  });
});

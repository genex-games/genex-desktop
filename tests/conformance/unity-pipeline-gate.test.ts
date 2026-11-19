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
      "script eval",
      "script eval_file",
      "editor quit",
      "runtime quit",
      "authoring set_root",
      "settings.runtime_pipeline set",
      "set_root",
      "Script Eval",
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
    assert.deepEqual(await gate(at, "package_add", { confirm: true }), outside, "a package add that names no package");
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

/** A catalogue entry of Pipeline 1.0.0, named as that version runs it, from `name:type` pairs. */
const grouped = (name: string, parameters = ""): PipelineCommand =>
  command(
    name,
    Object.fromEntries(
      parameters
        .split("; ")
        .filter(Boolean)
        .map((pair) => pair.split(":")),
    ),
  );

/** Entries of the catalogue Pipeline 1.0.0 answered on Unity 6000.6.0f1 (2026-11-19), with their own parameters. */
const CATALOGUE_1_0: PipelineCommand[] = [
  grouped("editor.playmode start", "run-in-background:Boolean"),
  grouped("editor.playmode stop"),
  grouped("scene open", "path:String; additive:Boolean"),
  grouped("scene save", "path:String"),
  grouped("asset import", "source:String; path:String; confirm:Boolean; dry-run:Boolean"),
  grouped("asset find", "type:String; name:String; label:String; search-in:String; limit:Int32"),
  grouped(
    "capture game_view",
    "width:Int32; height:Int32; camera:String; output-path:String; include-inline-image:Boolean; source:String",
  ),
  grouped("capture editor_window", "window:String; output-path:String"),
  grouped("diagnostics memory_snapshot", "flags:String; output-path:String"),
  grouped("diagnostics profiler_record", "frames:Int32; output-path:String"),
  grouped("diagnostics profiler_session", "capture:String; confirm:Boolean"),
  grouped("diagnostics run_audit", "categories:String; output-path:String"),
  grouped("build create_profile", "name:String; platform:String; folder:String"),
  grouped("build run", "target:String; output-path:String; profile-name:String; scenes:String[]; confirm:Boolean"),
  grouped("build.target switch", "target:String; confirm:Boolean"),
  grouped("script.methodreload reload", "filename:String; assembly-dir:String"),
  grouped("gameobject delete", "target:ObjectRef"),
  grouped("gameobject find", "name:String; hierarchy-path:String"),
  grouped("prefab create", "source:ObjectRef; path:String"),
  grouped("job batch", "operations:List`1; transactional:Boolean; on-error:String"),
  grouped("script eval", "code:String; file:String; timeout:Double"),
  grouped("script run", "file:String; entry:String; timeout:Double"),
  grouped("editor quit", "save:Boolean; discard:Boolean; exit-code:Int32"),
  grouped("runtime quit", "exit-code:Int32"),
  grouped("authoring get_root"),
  grouped("authoring set_root", "root:String"),
  grouped("settings.runtime_pipeline get"),
  grouped("settings.runtime_pipeline set", "settings:RuntimePipelineSettingsInput; confirm:Boolean"),
  grouped("settings.player set", "settings:PlayerSettingsInput; confirm:Boolean"),
  grouped("package add", "name:String; confirm:Boolean; wait:Boolean"),
  grouped("package remove", "name:String; confirm:Boolean"),
  grouped("editor invoke_menu", "path:String"),
  grouped("editor save_all"),
];

const gate10 = (at: GatePlace, name: unknown, parameters?: unknown) => gateCall(at, CATALOGUE_1_0, name, parameters);

describe("the gate on the commands of Pipeline 1.0.0", () => {
  it("lets a command through under the name its editor lists, and as nothing else", async () => {
    const at = await place();
    const scene = { path: "Assets/Scenes/Main.unity" };
    assert.deepEqual(await gate10(at, "scene open", scene), { ok: true, command: "scene open", parameters: scene });
    assert.equal((await gate10(at, "editor.playmode start", { "run-in-background": true })).ok, true);
    assert.equal((await gate10(at, "settings.player set", { settings: {}, confirm: true })).ok, true);
    assert.equal((await gate10(at, "authoring get_root")).ok, true);
    // Pipeline also runs a command by these spellings; an agent is held to the catalogue's own.
    const otherSpellings = [
      "open",
      "scene.open",
      "open_scene",
      "scene_open",
      "scene  open",
      " scene open",
      "scene open ",
    ];
    for (const name of otherSpellings)
      assert.deepEqual(await gate10(at, name, scene), { ok: false, refusal: GateRefusal.NotACommand }, name);
  });

  it("refuses what agents never run under every spelling that reaches it", async () => {
    const at = await place();
    // Each of these ran its command on Pipeline 1.0.0 when sent as the command's name.
    const reaching: Array<[string, Record<string, unknown>]> = [
      ["script eval", { code: "return 1+1;" }],
      ["script.eval", { code: "return 1+1;" }],
      ["eval", { code: "return 1+1;" }],
      ["script eval", { file: "Assets/Editor/Probe.cs" }],
      ["authoring set_root", { root: "Assets" }],
      ["authoring.set_root", { root: "Assets" }],
      ["set_root", { root: "Assets" }],
      ["editor quit", { discard: true }],
      ["editor.quit", {}],
      ["runtime quit", {}],
      ["runtime.quit", {}],
      ["quit", {}],
      ["settings.runtime_pipeline set", { settings: { "enable-in-release-builds": true }, confirm: true }],
      ["invoke_menu", { path: "File/Quit" }],
      ["editor.invoke_menu", { path: "File/Quit" }],
    ];
    for (const [name, parameters] of reaching)
      assert.equal((await gate10(at, name, parameters)).ok, false, `${name} ${JSON.stringify(parameters)}`);
    const denied = [
      "script eval",
      "editor quit",
      "runtime quit",
      "authoring set_root",
      "settings.runtime_pipeline set",
    ];
    for (const name of denied)
      assert.deepEqual(await gate10(at, name, {}), { ok: false, refusal: GateRefusal.Denied, command: name }, name);
    const quits = { ok: false, refusal: GateRefusal.Denied, command: "editor invoke_menu" };
    for (const item of ["File/Quit", "Unity/Quit Unity", "File/Open Project...", "File/Open Recent/Game"])
      assert.deepEqual(await gate10(at, "editor invoke_menu", { path: item }), quits, item);
    assert.equal((await gate10(at, "editor invoke_menu", { path: "Assets/Reimport All" })).ok, true);
  });

  it("keeps the files its commands name inside the game, by the names 1.0.0 gives the parameters", async () => {
    const at = await place();
    const inside: Array<[string, Record<string, unknown>]> = [
      ["capture game_view", { "output-path": "Screenshots/cam.png", source: "camera" }],
      ["capture game_view", { source: "screen", width: 640 }],
      ["diagnostics run_audit", { "output-path": "Temp/audit.csv" }],
      ["asset import", { source: "../assets/ship.glb", path: "Models/ship.glb" }],
      ["asset find", { "search-in": "Assets/Scenes", name: "Main" }],
      ["script run", { file: "Assets/Editor/Build.cs", entry: "Build.Run" }],
      ["build create_profile", { name: "Web", platform: "WebGL", folder: "Assets/Settings" }],
      ["gameobject find", { "hierarchy-path": "/etc/passwd" }],
      ["prefab create", { source: "/Player", path: "Assets/Player.prefab" }],
    ];
    for (const [name, parameters] of inside) assert.equal((await gate10(at, name, parameters)).ok, true, name);
    const outside: Array<[string, Record<string, unknown>, string]> = [
      ["capture game_view", { "output-path": path.join(at.outside, "cam.png") }, "output-path"],
      ["capture game_view", { "output-path": "../../cam.png" }, "output-path"],
      ["capture editor_window", { window: "Game", "output-path": "/tmp/window.png" }, "output-path"],
      ["diagnostics memory_snapshot", { "output-path": "/tmp/heap.snap" }, "output-path"],
      ["diagnostics profiler_record", { "output-path": "..\\..\\frames.data" }, "output-path"],
      ["diagnostics profiler_session", { capture: path.join(at.outside, "secret.txt") }, "capture"],
      ["diagnostics run_audit", { "output-path": "/etc/audit.csv" }, "output-path"],
      ["asset import", { source: path.join(at.outside, "secret.txt"), path: "x.txt" }, "source"],
      ["asset find", { "search-in": "../../.." }, "search-in"],
      ["script run", { file: path.join(at.outside, "secret.txt") }, "file"],
      ["script.methodreload reload", { filename: "Assets/A.cs", "assembly-dir": "/tmp/out" }, "assembly-dir"],
      ["build create_profile", { name: "Web", platform: "WebGL", folder: "/tmp" }, "folder"],
    ];
    for (const [name, parameters, parameter] of outside)
      assert.deepEqual(
        await gate10(at, name, parameters),
        { ok: false, refusal: GateRefusal.PathOutside, parameter },
        `${name} ${JSON.stringify(parameters)}`,
      );
  });

  it("builds a player and adds a package only inside the game", async () => {
    const at = await place();
    const build = (parameters: Record<string, unknown>) => gate10(at, "build run", { target: "WebGL", ...parameters });
    assert.equal((await build({ "output-path": "Builds/web", confirm: true })).ok, true);
    const noFolder = { ok: false, refusal: GateRefusal.PathOutside, parameter: "output-path" };
    assert.deepEqual(await build({ confirm: true }), noFolder, "Unity's last build folder may be anywhere");
    assert.deepEqual(await build({ "output-path": "/Applications/Game.app", confirm: true }), noFolder);
    assert.deepEqual(await build({ outputPath: "Builds/web", confirm: true }), {
      ok: true,
      ...sentBuild("outputPath"),
    });
    assert.equal((await gate10(at, "build.target switch", { target: "WebGL", confirm: true })).ok, true);

    const add = (parameters: Record<string, unknown>) => gate10(at, "package add", { confirm: true, ...parameters });
    assert.equal((await add({ name: "com.unity.inputsystem" })).ok, true);
    assert.equal((await add({ name: "file:LocalPackage" })).ok, true);
    const named = { ok: false, refusal: GateRefusal.PathOutside, parameter: "name" };
    for (const name of ["file:../../../outside", `file:${at.outside}`, "git+file:///etc/repo", "file:"])
      assert.deepEqual(await add({ name }), named, name);
    assert.deepEqual(await add({}), named, "a package add that names no package");
    // The name earlier versions gave the parameter is read too, should an editor still take it.
    const old = { ok: false, refusal: GateRefusal.PathOutside, parameter: "identifier" };
    assert.deepEqual(await add({ name: "com.unity.inputsystem", identifier: "file:/etc" }), old);
  });

  it("holds every operation of a batch to the same rules", async () => {
    const at = await place();
    const batch = (operations: unknown) => gate10(at, "job batch", { operations, transactional: false });
    assert.equal((await batch([{ command: "scene save", params: { path: "Assets/Scenes/Main.unity" } }])).ok, true);
    const refused: Array<[string, unknown, object]> = [
      ["eval", [{ command: "script eval", params: { code: "1" } }], { refusal: "denied", command: "script eval" }],
      ["eval by its last word", [{ command: "eval", params: { code: "1" } }], { refusal: "denied", command: "eval" }],
      ["a quit", [{ command: "editor quit" }], { refusal: "denied", command: "editor quit" }],
      [
        "a nested batch",
        [{ command: "job batch", params: { operations: [] } }],
        { refusal: "denied", command: "job batch" },
      ],
      ["a batch by its old name", [{ command: "batch", params: {} }], { refusal: "denied", command: "batch" }],
      ["another spelling", [{ command: "scene.save" }], { refusal: "not-a-command" }],
      [
        "a file outside the game",
        [{ command: "capture game_view", params: { "output-path": "/tmp/cam.png" } }],
        { refusal: "path-outside", parameter: "output-path" },
      ],
    ];
    for (const [what, operations, refusal] of refused)
      assert.deepEqual(await batch(operations), { ok: false, ...refusal }, what);
  });
});

/** A build call as the gate hands it on, its output folder under `name`. */
function sentBuild(name: string) {
  return { command: "build run", parameters: { target: "WebGL", [name]: "Builds/web", confirm: true } };
}

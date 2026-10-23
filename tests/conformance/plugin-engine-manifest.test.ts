/**
 * A game-engine plugin's `engine` (API 3): the engine it declares, by the plugin's own id, with the
 * engine's name, the project files a game links, the fact a linked game holds, whether the Loop
 * needs the project inside the game folder, what its editor can do in play and its editor apps.
 * Genex keeps the declaration in canonical form and refuses one it cannot keep.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { isProjectPath, parseEngineRemote } from "../../src/shared/game-engine.ts";
import { engineCatalog, type PluginManifest } from "../../src/shared/plugins.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { TOY_PLUGIN, TOY_PLUGIN_ID } from "../helpers/project-fixtures.ts";

const NO_PARAMETERS = { type: "object", properties: {} };
const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

/** The declaration under test: a made-up engine whose project files are `.kiln`. */
const engine = (fields: Record<string, unknown> = {}) => ({
  id: "kiln",
  label: "Kiln",
  projectFiles: [".kiln"],
  fact: "kiln-project",
  projectInFolder: true,
  ...fields,
});

/** The smallest engine plugin that loads, with the given declaration and header fields. */
const manifest = (declared: unknown, header: Record<string, unknown> = {}) => ({
  apiVersion: 3,
  id: "kiln",
  version: "1.0.0",
  name: "Kiln",
  publisher: "Genex tests",
  description: "A manifest whose engine declaration is under test.",
  backend: "backend.mjs",
  capabilities: ["game-engine"],
  tools: [{ name: "build", description: "Build.", parameters: NO_PARAMETERS }],
  skills: [],
  panels: [],
  settings: [],
  actions: [],
  detect: [{ fact: "kiln-project", files: ["**/*.kiln"] }],
  engine: declared,
  ...header,
});

/** Every declaration Genex refuses, by the words that name its fault. */
const refused: Array<[name: string, value: unknown, header: Record<string, unknown>, words: RegExp]> = [
  ["an id other than the plugin's", engine({ id: "other" }), {}, /engine id/],
  ["an id that is not an engine id", engine({ id: "k" }), { id: "k" }, /engine id/],
  [
    "the web's id",
    engine({ id: "web", fact: "web-project" }),
    { id: "web", detect: [{ fact: "web-project", files: ["**/*.w"] }] },
    /web/,
  ],
  ["no game-engine capability", engine(), { capabilities: [] }, /game-engine/],
  ["API 2", engine(), { apiVersion: 2, detect: undefined }, /apiVersion 3/],
  ["not an object", [engine()], {}, /Invalid engine/],
  ["a missing label", engine({ label: undefined }), {}, /label/],
  ["an empty label", engine({ label: "" }), {}, /label/],
  ["a 41-character label", engine({ label: "K".repeat(41) }), {}, /label/],
  ["a label with a line break", engine({ label: "Kiln\nnow" }), {}, /label/],
  ["no project files", engine({ projectFiles: [] }), {}, /projectFiles/],
  ["5 project files", engine({ projectFiles: [".a", ".b", ".c", ".d", ".e"] }), {}, /projectFiles/],
  ["an extension without its dot", engine({ projectFiles: ["kiln"] }), {}, /projectFiles/],
  ["an extension in capitals", engine({ projectFiles: [".KILN"] }), {}, /projectFiles/],
  ["an extension of three parts", engine({ projectFiles: [".a.b.c"] }), {}, /projectFiles/],
  ["an extension with a slash", engine({ projectFiles: ["./kiln"] }), {}, /projectFiles/],
  ["an extension with a space", engine({ projectFiles: [".ki ln"] }), {}, /projectFiles/],
  ["an extension of 17 characters", engine({ projectFiles: [`.${"k".repeat(17)}`] }), {}, /projectFiles/],
  ["the same extension twice", engine({ projectFiles: [".kiln", ".kiln"] }), {}, /projectFiles/],
  ["a fact neither detected nor Genex's own", engine({ fact: "other-project" }), {}, /fact/],
  ["a fact that is no fact id", engine({ fact: "Kiln Project" }), {}, /fact/],
  ["the web game's fact", engine({ fact: "web-game" }), {}, /fact/],
  ["no projectInFolder", engine({ projectInFolder: undefined }), {}, /projectInFolder/],
  ["a projectInFolder that is not a boolean", engine({ projectInFolder: "yes" }), {}, /projectInFolder/],
  ["play that is not an object", engine({ play: true }), {}, /play/],
  ["no players", engine({ play: { players: 0 } }), {}, /play/],
  ["9 players", engine({ play: { players: 9 } }), {}, /play/],
  ["half a player", engine({ play: { players: 2.5 } }), {}, /play/],
  ["an unknown clock", engine({ play: { clock: "warp" } }), {}, /play/],
  ["a pointer that is not a boolean", engine({ play: { pointer: "yes" } }), {}, /play/],
  ["state that is not a boolean", engine({ play: { state: 1 } }), {}, /play/],
  ["apps that are not an object", engine({ apps: ["com.kiln.Editor"] }), {}, /apps/],
  ["a bundle id with a space", engine({ apps: { mac: ["com.kiln.Kiln Editor"] } }), {}, /apps/],
  ["a bundle id of one part", engine({ apps: { mac: ["KilnEditor"] } }), {}, /apps/],
  ["a bundle id with an empty part", engine({ apps: { mac: ["com..kiln"] } }), {}, /apps/],
  ["a bundle id that is a path", engine({ apps: { mac: ["/Applications/Kiln.app"] } }), {}, /apps/],
  ["5 Mac apps", engine({ apps: { mac: ["a.b", "a.c", "a.d", "a.e", "a.f"] } }), {}, /apps/],
  ["no Mac apps in a Mac list", engine({ apps: { mac: [] } }), {}, /apps/],
  ["a Windows app that is no .exe", engine({ apps: { windows: ["KilnEditor"] } }), {}, /apps/],
  ["a Windows app that is a path", engine({ apps: { windows: ["C:\\Kiln\\KilnEditor.exe"] } }), {}, /apps/],
  ["a Windows app named only .exe", engine({ apps: { windows: [".exe"] } }), {}, /apps/],
  ["the same Windows app twice", engine({ apps: { windows: ["Kiln.exe", "Kiln.exe"] } }), {}, /apps/],
  ["player apps that are not an object", engine({ playerApps: ["com.kiln.Player"] }), {}, /playerApps/],
  ["a player app that is a path", engine({ playerApps: { mac: ["/Applications/Kiln Player.app"] } }), {}, /playerApps/],
  [
    "a Windows player app that is a path",
    engine({ playerApps: { windows: ["C:\\Kiln\\Player.exe"] } }),
    {},
    /playerApps/,
  ],
];

describe("a plugin's engine declaration", () => {
  it("keeps the toy engine's and Unreal's declarations as they are written", () => {
    const toy = read(path.join(TOY_PLUGIN, "plugin.json"));
    assert.deepEqual(validateManifest(toy).engine, {
      id: TOY_PLUGIN_ID,
      label: "Toy",
      projectFiles: [".toyproj"],
      fact: "toy-project",
      projectInFolder: false,
      play: { players: 3, clock: "none", pointer: true },
      apps: { mac: ["com.example.toy"], windows: ["ToyEditor.exe"] },
    });
    const unreal = read(path.join("src", "plugins", "unreal", "plugin.json"));
    assert.deepEqual(validateManifest(unreal).engine, {
      id: "unreal",
      label: "Unreal",
      projectFiles: [".uproject"],
      fact: "unreal-project",
      projectInFolder: true,
      // Epic's launcher, which Do it for me installs Unreal in: never Unreal's editor.
      apps: { mac: ["com.epicgames.EpicGamesLauncher"], windows: ["EpicGamesLauncher.exe", "EpicWebHelper.exe"] },
    });
  });

  it("keeps every field it knows in a fixed order, drops the rest, and accepts Genex's own facts", () => {
    const full = engine({
      projectFiles: [".kiln", ".kilnx", ".project.json"],
      projectInFolder: false,
      apps: { windows: ["Kiln Editor.exe"], mac: ["com.Kiln.KilnEditor", "com.kiln.helper-2"], linux: ["kiln"] },
      play: { state: true, players: 8, clock: "none", pointer: true, camera: "far" },
      extra: "dropped",
    });
    const kept = validateManifest(manifest(full)).engine;
    assert.equal(
      JSON.stringify(kept),
      JSON.stringify({
        id: "kiln",
        label: "Kiln",
        projectFiles: [".kiln", ".kilnx", ".project.json"],
        fact: "kiln-project",
        projectInFolder: false,
        play: { players: 8, clock: "none", pointer: true, state: true },
        apps: { mac: ["com.Kiln.KilnEditor", "com.kiln.helper-2"], windows: ["Kiln Editor.exe"] },
      }),
    );
    // A fact Genex itself knows needs no detect rule of the plugin's own.
    const core = validateManifest(manifest(engine({ fact: "unity-project" }), { detect: undefined })).engine;
    assert.equal(core?.fact, "unity-project");
    // Play may declare nothing yet, and apps may name one system only.
    const bare = validateManifest(manifest(engine({ play: {}, apps: { windows: ["Kiln.exe"] } }))).engine;
    assert.deepEqual(bare?.play, {});
    assert.deepEqual(bare?.apps, { windows: ["Kiln.exe"] });
  });

  it("keeps the apps an engine's games are played in, and Roblox's names its player", () => {
    const kept = validateManifest(
      manifest(engine({ playerApps: { windows: ["KilnPlayer.exe"], mac: ["com.kiln.Player"] } })),
    ).engine;
    assert.deepEqual(kept?.playerApps, { mac: ["com.kiln.Player"], windows: ["KilnPlayer.exe"] });
    const roblox = validateManifest(read(path.join("src", "plugins", "roblox", "plugin.json"))).engine;
    assert.deepEqual(roblox?.playerApps, { mac: ["com.roblox.RobloxPlayer"], windows: ["RobloxPlayerBeta.exe"] });
  });

  it("leaves a game-engine plugin without a declaration as it was", () => {
    const kept = validateManifest(manifest(undefined));
    assert.equal(kept.engine, undefined);
    assert.ok(!("engine" in kept), "no engine key is written for a plugin that declares none");
  });

  it("refuses a declaration it cannot keep, naming the field", () => {
    for (const [name, value, header, words] of refused) {
      assert.throws(() => validateManifest(manifest(value, header)), words, name);
    }
  });

  it("catalogs the declared engines by id, the first declaration of an id winning", () => {
    const kiln = validateManifest(manifest(engine()));
    const again = validateManifest(manifest(engine({ label: "Kiln again" })));
    const none = validateManifest(manifest(undefined, { id: "plain", capabilities: [] }));
    const catalog = engineCatalog([none, kiln, again] as PluginManifest[]);
    assert.deepEqual([...catalog.keys()], ["kiln"]);
    assert.equal(catalog.get("kiln")?.label, "Kiln");
  });
});

describe("an engine's project paths and published place", () => {
  it("knows a project path by any of the engine's extensions, one or two parts long", () => {
    const extensions = [".kiln", ".project.json"];
    assert.ok(isProjectPath("/games/Lantern/Lantern.kiln", extensions));
    assert.ok(isProjectPath("/games/Lantern/default.project.json", extensions));
    assert.ok(isProjectPath("C:\\Games\\Lantern\\LANTERN.KILN", extensions), "extensions match in any case");
    assert.ok(!isProjectPath("/games/Lantern/Lantern.json", extensions), "only the whole extension matches");
    assert.ok(!isProjectPath("/games/Lantern/Lantern.uproject", extensions));
    assert.ok(isProjectPath("/games/Lantern/Lantern.uproject"), "Unreal's extension when none is given");
    assert.ok(!isProjectPath("/games/../Lantern.kiln", extensions));
  });

  it("reads a published place's ids as decimal strings and refuses anything else", () => {
    assert.deepEqual(parseEngineRemote({ placeId: "4483381587", universeId: "1534453623", other: "x" }), {
      placeId: "4483381587",
      universeId: "1534453623",
    });
    const hostile: unknown[] = [
      undefined,
      null,
      "4483381587",
      [],
      { placeId: 4483381587, universeId: "1" },
      { placeId: "0", universeId: "1" },
      { placeId: "1", universeId: "0123" },
      { placeId: "1".repeat(21), universeId: "1" },
      { placeId: "12a", universeId: "1" },
      { placeId: "-1", universeId: "1" },
      { placeId: "1" },
    ];
    for (const raw of hostile) assert.equal(parseEngineRemote(raw), undefined, JSON.stringify(raw));
    assert.ok(parseEngineRemote({ placeId: "9".repeat(20), universeId: "1" }), "20 digits is the longest id");
  });
});

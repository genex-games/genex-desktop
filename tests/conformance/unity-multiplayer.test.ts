/**
 * Genex multiplayer in a Unity game through the Unity plugin's backend (`unity__multiplayer`): Genex's
 * package embedded in the project's Packages/, the Colyseus Unity SDK asked for in its manifest at
 * the tested commit (a version the person chose stays), a link.xml against IL2CPP stripping, the
 * game's Genex project in Assets/Resources/GenexSettings.json and its matchmaking in genex.json. A
 * second run changes nothing, a Genex file the person changed is kept as `.mine~`, arguments are
 * checked before anything is written, and nothing is written through a link.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { PluginScalar } from "../../src/plugin-sdk/index.d.ts";
import { UnityTool } from "../../src/plugins/unity/backend.ts";
import {
  COLYSEUS_PACKAGE,
  COLYSEUS_PACKAGE_URL,
  GAME_FILES,
  LINK_FILE,
  SETTINGS_FILE,
} from "../../src/plugins/unity/multiplayer.ts";
import { backendOn, MULTIPLAYER_PACKAGE_SOURCE, manifestOf, realTmp, withProject } from "../helpers/unity-backend.ts";

const UNITY_6 = "6000.0.30f1";
/** The Genex files a game gets beside the package, as the plugin ships them. */
const GAME_FILES_SOURCE = path.resolve("src/plugins/unity/multiplayer/genex-game");
const exists = async (file: string) => (await lstat(file).catch(() => null)) !== null;

/** A game with a Unity project in unity/, and the tool as the agent calls it. */
async function unityGame(dependencies: Record<string, string> = { "com.unity.ugui": "2.0.0" }) {
  const rig = await backendOn([UNITY_6]);
  const root = await withProject(rig.game, UNITY_6, dependencies);
  const context = { project: "lantern", directory: rig.game };
  // An object parameter (API 3) reaches the backend as an object; the SDK's type names scalars only.
  const call = async (args: Record<string, unknown> = {}) =>
    String(await rig.backend.tool?.(UnityTool.Multiplayer, args as Record<string, PluginScalar>, rig.context(context)));
  return { ...rig, root, call };
}

/** Every file under a folder, by its path inside it. */
async function filesUnder(folder: string, inside = ""): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(path.join(folder, inside), { withFileTypes: true })) {
    const name = inside ? `${inside}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...(await filesUnder(folder, name)));
    else names.push(name);
  }
  return names.sort();
}

describe("Genex multiplayer in a Unity game", () => {
  it("embeds the package, asks for Colyseus, keeps its assemblies from stripping, and writes the game's project and matchmaking", async () => {
    const game = await unityGame();
    const matchmaking = { preset: "open", config: { minPlayers: 2, maxPlayers: 8 } };
    const answer = await game.call({ slug: "tank-arena", matchmaking });
    assert.match(answer, /Genex multiplayer is in this game's Unity project/);
    assert.match(answer, /Its Genex project is tank-arena/);
    const embedded = path.join(game.root, "Packages/com.genex.multiplayer");
    const shipped = await filesUnder(MULTIPLAYER_PACKAGE_SOURCE);
    assert.deepEqual(await filesUnder(embedded), shipped);
    for (const name of shipped)
      assert.deepEqual(
        await readFile(path.join(embedded, name)),
        await readFile(path.join(MULTIPLAYER_PACKAGE_SOURCE, name)),
        name,
      );
    const manifest = await manifestOf(game.root);
    assert.equal(manifest.dependencies[COLYSEUS_PACKAGE], COLYSEUS_PACKAGE_URL);
    assert.equal(manifest.dependencies["com.unity.ugui"], "2.0.0", "the project's own packages stay");
    assert.deepEqual(
      Object.keys(manifest.dependencies),
      [...Object.keys(manifest.dependencies)].sort(),
      "sorted as Unity keeps them",
    );
    const link = await readFile(path.join(game.root, LINK_FILE), "utf8");
    for (const assembly of ["Genex.Multiplayer", "ColyseusSDK", "colyseus.nativewebsocket"])
      assert.match(link, new RegExp(`<assembly fullname="${assembly}" preserve="all" />`));
    const settings = JSON.parse(await readFile(path.join(game.root, SETTINGS_FILE), "utf8"));
    assert.deepEqual(settings, { slug: "tank-arena", apiUrl: "https://api.genex.games" });
    assert.deepEqual(JSON.parse(await readFile(path.join(game.game, "genex.json"), "utf8")), { matchmaking });
    for (const [file, shipped] of Object.entries(GAME_FILES))
      assert.deepEqual(
        await readFile(path.join(game.root, file)),
        await readFile(path.join(GAME_FILES_SOURCE, shipped)),
        `${file}: the game's name wherever it runs`,
      );
  });

  it("before the first publish, says the published copies learn the game's name from Genex, so a publish needs no rebuild", async () => {
    const game = await unityGame();
    const answer = await game.call();
    assert.match(answer, /no Genex project yet/);
    assert.match(answer, /GenexGame\.Slug/);
    assert.doesNotMatch(answer, /then build again/, "a publish needs no second build");
    for (const file of Object.keys(GAME_FILES)) assert.ok(await exists(path.join(game.root, file)), file);
    assert.deepEqual(JSON.parse(await readFile(path.join(game.root, SETTINGS_FILE), "utf8")), {
      apiUrl: "https://api.genex.games",
    });
  });

  it("is the same the second time, keeps a Colyseus version the person chose, and keeps their changed files as .mine~", async () => {
    const game = await unityGame({ [COLYSEUS_PACKAGE]: "https://github.com/colyseus/colyseus-unity-sdk.git#mine" });
    await game.call({ slug: "tank-arena" });
    assert.equal(
      (await manifestOf(game.root)).dependencies[COLYSEUS_PACKAGE],
      "https://github.com/colyseus/colyseus-unity-sdk.git#mine",
    );
    const pump = path.join(game.root, "Packages/com.genex.multiplayer/Runtime/Unity/GenexPump.cs");
    await writeFile(pump, "// my own pump\n");
    await writeFile(path.join(game.root, LINK_FILE), "<linker />\n");
    const gameFile = path.join(game.root, "Assets/Genex/GenexGame.cs");
    await writeFile(gameFile, "// my own name\n");
    const settings = path.join(game.root, SETTINGS_FILE);
    await writeFile(settings, JSON.stringify({ slug: "tank-arena", apiUrl: "https://api-dev.genex.games", mine: 1 }));
    const answer = await game.call();
    assert.match(
      answer,
      /Kept your changed Runtime\/Unity\/GenexPump\.cs, Assets\/Genex\/link\.xml, Assets\/Genex\/GenexGame\.cs beside the new ones as \.mine~/,
    );
    assert.equal(await readFile(`${gameFile}.mine~`, "utf8"), "// my own name\n");
    assert.equal(await readFile(`${pump}.mine~`, "utf8"), "// my own pump\n");
    assert.deepEqual(
      JSON.parse(await readFile(settings, "utf8")),
      { slug: "tank-arena", apiUrl: "https://api-dev.genex.games", mine: 1 },
      "the slug and the API it names stay",
    );
    const before = await readFile(path.join(game.root, "Packages/manifest.json"), "utf8");
    await game.call();
    assert.equal(await readFile(path.join(game.root, "Packages/manifest.json"), "utf8"), before, "twice is once");
  });

  it("refuses a slug or matchmaking that isn't one, and a game with no Unity project, before writing anything", async () => {
    const game = await unityGame();
    const rows: Array<[string, Record<string, unknown>]> = [
      ["a path", { slug: "../other" }],
      ["a JSON break", { slug: 'x", "apiUrl": "https://evil.test' }],
      ["an unknown preset", { matchmaking: { preset: "royale" } }],
      ["a knob that isn't a number", { matchmaking: { preset: "open", config: { maxPlayers: "8" } } }],
    ];
    for (const [name, args] of rows) {
      await assert.rejects(game.call(args), name);
      assert.equal(await exists(path.join(game.root, "Packages/com.genex.multiplayer")), false, name);
      assert.equal((await manifestOf(game.root)).dependencies[COLYSEUS_PACKAGE], undefined, name);
      assert.equal(await exists(path.join(game.game, "genex.json")), false, name);
    }
    const empty = await backendOn([UNITY_6]);
    await assert.rejects(
      empty.backend.tool?.(UnityTool.Multiplayer, {}, empty.context({ project: "lantern", directory: empty.game })) ??
        Promise.resolve(),
      /holds no Unity project/,
    );
  });

  it("writes nothing through a link", async () => {
    for (const at of ["Packages/com.genex.multiplayer", "Assets", "Assets/Resources", "Assets/Genex"]) {
      const game = await unityGame();
      const outside = await realTmp("unity-outside-");
      await mkdir(path.dirname(path.join(game.root, at)), { recursive: true });
      await symlink(outside, path.join(game.root, at));
      await assert.rejects(game.call({ slug: "tank-arena" }), /link/, at);
      assert.deepEqual(await readdir(outside), [], `${at}: nothing written outside the project`);
    }
  });
});

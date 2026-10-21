/**
 * The Game mods plugin finding the games a person has: Steam's library list and manifests (a game
 * only when a store lists it and its folder is there, never Steam's own tools or a manifest that
 * points out of its library), Epic's manifests (games, not engines), Minecraft's launcher; what a
 * game's folder says it was made with and the anti-cheat it ships; and where Genex knows a game
 * keeps its mods and saves on a Mac and on Windows.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { findGames, GameStore, systemGamesEnv } from "../../src/plugins/mods/find-games.ts";
import { BuiltWith, fingerprint } from "../../src/plugins/mods/fingerprint.ts";
import { KNOWN_GAMES, placeFolder } from "../../src/plugins/mods/known-games.ts";
import { findTarget, ModRefusal } from "../../src/plugins/mods/mod-link.ts";
import { steamPicture } from "../../src/plugins/mods/pictures.ts";
import { MAX_VDF_CHARS, parseVdf } from "../../src/plugins/mods/vdf.ts";
import { fakeComputer, writeTree } from "../helpers/mods-computer.ts";
import { tmpDir } from "../helpers/tmp.ts";

describe("Valve's KeyValues", () => {
  const table: Array<[string, string, unknown]> = [
    [
      "a manifest",
      '"AppState"\n{\n\t"appid"\t"427520"\n\t"name"\t"Factorio"\n}',
      { AppState: { appid: "427520", name: "Factorio" } },
    ],
    ["escapes", '"a" "C:\\\\Steam \\"x\\""', { a: 'C:\\Steam "x"' }],
    ["a comment line", '// Steam\n"a" "1"', { a: "1" }],
    ["the first of a repeated key", '"a" "1" "a" "2"', { a: "1" }],
    ["nothing", "", {}],
    ["a bare word", "a { }", null],
    ["a quote that never closes", '"a" "1', null],
    ["a block that never closes", '"a" { "b" "1"', null],
    ["a closing brace too many", '"a" "1" }', null],
    ["a key without a value", '"a"', null],
    ["blocks nested too deep", `${'"k" {'.repeat(20)}${"}".repeat(20)}`, null],
    ["a file too long", `"a" "${"x".repeat(MAX_VDF_CHARS)}"`, null],
  ];
  for (const [name, source, expected] of table) it(`reads ${name}`, () => assert.deepEqual(parseVdf(source), expected));
});

describe("finding installed games", () => {
  it("lists what Steam, Epic and Minecraft's launcher installed, each once, by name", async () => {
    const computer = await fakeComputer({
      steam: [
        { id: "427520", name: "Factorio" },
        { id: "413150", name: "Stardew Valley", library: "second" },
        { id: "228980", name: "Steamworks Common Redistributables" },
        { id: "1493710", name: "Proton Experimental" },
        { id: "105600", name: "Terraria", noFolder: true },
        { id: "999", name: "Sneaky", dir: "../../../home" },
      ],
      minecraft: true,
      epic: [
        {
          DisplayName: "Celeste",
          AppName: "Salt",
          InstallLocation: path.join("/", "nowhere"),
          AppCategories: ["games"],
        },
      ],
    });
    const celeste = path.join(computer.root, "Epic Games", "Celeste");
    await mkdir(celeste, { recursive: true });
    const engine = path.join(computer.root, "Epic Games", "UE_5.8");
    await mkdir(engine, { recursive: true });
    const withEpic = await fakeComputer({
      epic: [
        { DisplayName: "Celeste", AppName: "Salt", InstallLocation: celeste, AppCategories: ["games", "applications"] },
        { DisplayName: "Unreal Engine", AppName: "UE_5.8", InstallLocation: engine, AppCategories: ["engines"] },
        { DisplayName: "Half", AppName: "Half", InstallLocation: celeste, bIsIncompleteInstall: true },
      ],
    });
    const games = await findGames(computer.env);
    assert.deepEqual(
      games.map((g) => [g.id, g.name, g.store]),
      [
        ["steam:427520", "Factorio", GameStore.Steam],
        ["minecraft", "Minecraft", GameStore.Minecraft],
        ["steam:413150", "Stardew Valley", GameStore.Steam],
      ],
    );
    assert.equal(games[0]?.folder, computer.steamGame("Factorio"));
    assert.equal(games[2]?.folder, path.join(computer.second, "steamapps", "common", "Stardew Valley"));
    assert.deepEqual(
      (await findGames(withEpic.env)).map((g) => [g.id, g.name, g.folder]),
      [["epic:Salt", "Celeste", celeste]],
    );
  });

  it("finds nothing on a computer with no store", async () => {
    const empty = await tmpDir("mods-empty-");
    const env = { ...systemGamesEnv({}, "darwin"), home: empty, applications: path.join(empty, "Applications") };
    assert.deepEqual(await findGames(env), []);
  });

  it("reads a development test's made-up Mac, never the real one, when the test root is set", () => {
    const env = systemGamesEnv({ STUDIO_ENGINE_TEST_ROOT: "/made/up" }, "darwin");
    assert.equal(env.home, "/made/up/home");
    assert.equal(env.applications, "/made/up/Applications");
  });
});

describe("what a game's folder says", () => {
  const table: Array<[string, string[], BuiltWith | null, string[]]> = [
    ["a Unity game on a Mac", ["Hollow.app/Contents/Resources/Data/globalgamemanagers"], BuiltWith.Unity, []],
    [
      "a Unity IL2CPP game on Windows",
      ["UnityPlayer.dll", "GameAssembly.dll", "Game_Data/"],
      BuiltWith.UnityIl2cpp,
      [],
    ],
    ["an Unreal game on Windows", ["Engine/", "Lantern/Content/Paks/Lantern-Windows.pak"], BuiltWith.Unreal, []],
    ["an Unreal game on a Mac", ["Lantern.app/Contents/UE/"], BuiltWith.Unreal, []],
    ["a Godot game", ["Puck.pck", "Puck.exe"], BuiltWith.Godot, []],
    ["a LÖVE game on a Mac", ["Balatro.app/Contents/Resources/Balatro.love"], BuiltWith.Love, []],
    ["a GameMaker game on a Mac", ["Game.app/Contents/Resources/game.ios"], BuiltWith.GameMaker, []],
    ["a game whose folder is its bundle", ["Contents/MacOS/MonoGame.Framework.dll"], BuiltWith.DotNet, []],
    ["a Ren'Py game", ["renpy/", "game/"], BuiltWith.RenPy, []],
    ["a game Genex can't tell", ["readme.txt"], null, []],
    ["Easy Anti-Cheat", ["EasyAntiCheat/", "UnityPlayer.dll"], BuiltWith.Unity, ["Easy Anti-Cheat"]],
    ["BattlEye", ["BattlEye/BEClient_x64.dll"], null, ["BattlEye"]],
  ];
  for (const [name, files, builtWith, antiCheat] of table)
    it(`tells ${name}`, async () => {
      const dir = await tmpDir("mods-print-");
      await writeTree(dir, files);
      assert.deepEqual(await fingerprint(dir), { builtWith, antiCheat });
    });

  it("refuses a game that ships anti-cheat and an online game, by the game's own folder and id", async () => {
    const computer = await fakeComputer({
      steam: [
        { id: "1245620", name: "Elden Ring", files: ["Game/EasyAntiCheat/"] },
        { id: "570", name: "dota 2 beta" },
        { id: "427520", name: "Factorio" },
      ],
    });
    assert.equal((await findTarget(computer.env, "steam:1245620"))?.refusal, ModRefusal.AntiCheat);
    assert.equal((await findTarget(computer.env, "steam:570"))?.refusal, ModRefusal.Online);
    assert.equal((await findTarget(computer.env, "steam:427520"))?.refusal, null);
  });
});

describe("where a known game keeps mods and saves", () => {
  const mac = { platform: "darwin" as const, home: "/Users/me", appData: "", game: "/Steam/common/Stardew Valley" };
  const win = {
    platform: "win32" as const,
    home: "C:\\Users\\me",
    appData: "C:\\Users\\me\\AppData\\Roaming",
    game: "D:\\Games\\Stardew Valley",
  };
  const table: Array<[string, "mods" | "saves", string | null, string | null]> = [
    [
      "steam:427520",
      "mods",
      "/Users/me/Library/Application Support/factorio/mods",
      "C:\\Users\\me\\AppData\\Roaming\\Factorio\\mods",
    ],
    ["steam:413150", "mods", "/Steam/common/Stardew Valley/Contents/MacOS/Mods", "D:\\Games\\Stardew Valley\\Mods"],
    [
      "steam:413150",
      "saves",
      "/Users/me/.config/StardewValley/Saves",
      "C:\\Users\\me\\AppData\\Roaming\\StardewValley\\Saves",
    ],
    [
      "steam:1281930",
      "mods",
      "/Users/me/Library/Application Support/Terraria/tModLoader/ModSources",
      "C:\\Users\\me\\Documents\\My Games\\Terraria\\tModLoader\\ModSources",
    ],
    ["steam:105600", "mods", null, null],
  ];
  for (const [id, kind, onMac, onWindows] of table)
    it(`${id} ${kind}`, () => {
      const pair = KNOWN_GAMES[id]?.[kind];
      assert.equal(placeFolder(pair, mac), onMac);
      assert.equal(placeFolder(pair, win), onWindows);
    });
});

describe("a game's own picture", () => {
  it("reads Steam's cached header in either layout, and nothing for another store", async () => {
    const computer = await fakeComputer({
      steam: [
        { id: "646570", name: "SlayTheSpire" },
        { id: "1794680", name: "Vampire Survivors" },
      ],
      minecraft: true,
    });
    const cache = path.join(computer.steam, "appcache", "librarycache");
    await mkdir(path.join(cache, "1794680"), { recursive: true });
    await writeFile(path.join(cache, "646570_header.jpg"), "old layout");
    await writeFile(path.join(cache, "1794680", "library_header.jpg"), "new layout");
    const games = await findGames(computer.env);
    const picture = async (id: string) => {
      const game = games.find((g) => g.id === id);
      return game ? steamPicture(computer.env, game) : undefined;
    };
    assert.equal(
      await picture("steam:646570"),
      `data:image/jpeg;base64,${Buffer.from("old layout").toString("base64")}`,
    );
    assert.equal(
      await picture("steam:1794680"),
      `data:image/jpeg;base64,${Buffer.from("new layout").toString("base64")}`,
    );
    assert.equal(await picture("minecraft"), null);
  });
});

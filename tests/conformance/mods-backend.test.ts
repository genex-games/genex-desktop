/**
 * The Game mods plugin's backend in an open game on a made-up computer: the agent finds the
 * person's games, makes the project a mod of one (refusing online games, games with anti-cheat and
 * a second game), installs and removes the mod, and opens the game through its store; the install
 * card names the game and the game files it replaces; the panel, the toolbar and Live's card read
 * where the mod stands; the observer hands a reviewer the newest pictures the agent kept. Every
 * destination comes from the linked game, never from the project.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { ModsAction, ModsTool, SHOTS_FOLDER } from "../../src/plugins/mods/backend.ts";
import { MOD_FILE } from "../../src/plugins/mods/mod-link.ts";
import { fakeComputer, modsBackend, writeTree } from "../helpers/mods-computer.ts";

const FACTORIO = { id: "427520", name: "Factorio", files: ["factorio.app/Contents/MacOS/factorio", "config.ini"] };

/** A Factorio mod project with a mod folder in it; Factorio has run once, so its data folder is there. */
async function factorioMod() {
  const computer = await fakeComputer({
    steam: [
      FACTORIO,
      { id: "1245620", name: "ELDEN RING", files: ["Game/EasyAntiCheat/"] },
      { id: "105600", name: "Terraria" },
    ],
  });
  const mods = await modsBackend(computer);
  await mkdir(path.dirname(factorioMods(computer)), { recursive: true });
  await writeTree(mods.gameDir, ["faster_1.0.0/info.json", "faster_1.0.0/data.lua", "settings/config.ini"]);
  return { computer, ...mods };
}

/** Factorio's mods folder on the made-up computer. */
const factorioMods = (computer: Awaited<ReturnType<typeof fakeComputer>>) =>
  computer.known("steam:427520", "mods") ?? "";

describe("making a project a mod", () => {
  it("lists the installed games with what Genex can do for each", async () => {
    const { tool } = await factorioMod();
    const listed = String(await tool(ModsTool.FindGames));
    assert.match(listed, /- Factorio · id steam:427520 · Steam · Genex knows its mods folder/);
    assert.match(listed, /- ELDEN RING · id steam:1245620 · Steam · ships Easy Anti-Cheat: no mods/);
    assert.match(String(await tool(ModsTool.FindGames, { name: "terra" })), /^Games installed[^\n]*\n- Terraria /);
    assert.match(String(await tool(ModsTool.FindGames, { name: "zelda" })), /No installed game is called "zelda"/);
  });

  it("links the project to the game, and marks it with the game's folders", async () => {
    const { tool, gameDir, computer } = await factorioMod();
    const answer = String(await tool(ModsTool.UseGame, { game: "steam:427520" }));
    assert.match(answer, /now a mod of Factorio \(Steam\)/);
    const marker = JSON.parse(await readFile(path.join(gameDir, MOD_FILE), "utf8"));
    assert.equal(marker.id, "steam:427520");
    assert.equal(marker.folders.game, computer.steamGame("Factorio"));
    assert.equal(marker.folders.mods, factorioMods(computer));
  });

  it("refuses a game with anti-cheat, an id no store lists and a second game", async () => {
    const { tool } = await factorioMod();
    assert.match(
      String(await tool(ModsTool.UseGame, { game: "steam:1245620" })),
      /makes no mod for ELDEN RING: it ships Easy Anti-Cheat/,
    );
    assert.match(String(await tool(ModsTool.UseGame, { game: "steam:7" })), /No installed game has the id "steam:7"/);
    await tool(ModsTool.UseGame, { game: "steam:427520" });
    assert.match(String(await tool(ModsTool.UseGame, { game: "steam:105600" })), /already a mod of Factorio/);
  });
});

describe("the mod in the game", () => {
  it("installs into the mods folder the linked game names, whatever the project's marker says", async () => {
    const { tool, act, gameDir, computer } = await factorioMod();
    await tool(ModsTool.UseGame, { game: "steam:427520" });
    const hijack = path.join(computer.root, "elsewhere");
    await writeFile(path.join(gameDir, MOD_FILE), JSON.stringify({ folders: { mods: hijack, game: hijack } }));
    assert.match(String(await tool(ModsTool.Install, { from: "faster_1.0.0" })), /^Copied 2 files into /);
    const mods = factorioMods(computer);
    assert.equal(await readFile(path.join(mods, "faster_1.0.0", "info.json"), "utf8"), "faster_1.0.0/info.json");
    assert.deepEqual(await act(ModsAction.StageStatus), {
      line: "Mod for Factorio · in the game, 2 files",
      button: { label: "Play Factorio", action: ModsAction.Play },
    });
    assert.deepEqual(await act(ModsAction.ToolbarStatus), {
      title: "Mod for Factorio · in the game, 2 files",
      tone: "ok",
      dot: true,
    });
    assert.match(String(await act(ModsAction.Remove)), /removed 2 files and put back 0/);
    assert.deepEqual((await act(ModsAction.StageStatus)) as object, {
      line: "Mod for Factorio · not in the game yet",
      button: { label: "Play Factorio", action: ModsAction.Play },
    });
  });

  it("says what a refused install asks for, copying nothing", async () => {
    const { tool } = await factorioMod();
    assert.match(
      String(await tool(ModsTool.Install, { from: "faster_1.0.0" }).catch((e) => e.message)),
      /not a mod of a game yet/,
    );
    await tool(ModsTool.UseGame, { game: "steam:427520" });
    assert.match(String(await tool(ModsTool.Install, { from: "../../x" })), /Nothing was copied\.$/);
  });

  it("opens the game through Steam's own link", async () => {
    const { tool, launches } = await factorioMod();
    await tool(ModsTool.UseGame, { game: "steam:427520" });
    assert.match(String(await tool(ModsTool.Play)), /Opened Factorio through Steam/);
    assert.deepEqual(launches.at(-1)?.args, ["steam://rungameid/427520"]);
  });

  it("shows the panel the game, where the mod stands and its saves", async () => {
    const { tool, act, computer } = await factorioMod();
    assert.deepEqual(await act(ModsAction.Status), { linked: false });
    const saves = computer.known("steam:427520", "saves") ?? "";
    await mkdir(saves, { recursive: true });
    await writeFile(path.join(saves, "a.zip"), "save");
    await tool(ModsTool.UseGame, { game: "steam:427520" });
    await tool(ModsTool.Install, { from: "faster_1.0.0" });
    const status = (await act(ModsAction.Status)) as Record<string, unknown> & { game: Record<string, unknown> };
    assert.equal(status.game.name, "Factorio");
    assert.equal(status.game.store, "Steam");
    assert.equal(status.files, 2);
    assert.equal(typeof status.savesAt, "string");
    assert.equal(status.canPlay, true);
  });
});

describe("the install card", () => {
  it("names the game, and says plainly when the install replaces the game's own files", async () => {
    const { tool, card } = await factorioMod();
    assert.deepEqual(await card(ModsTool.Install, { from: "faster_1.0.0" }), {}, "a project that mods no game yet");
    await tool(ModsTool.UseGame, { game: "steam:427520" });
    assert.deepEqual(await card(ModsTool.Install, { from: "faster_1.0.0" }), {
      message: "Put this mod into Factorio? Remove mod takes it out again.",
    });
    assert.deepEqual(await card(ModsTool.Install, { from: "settings", into: "game", contents: true }), {
      message:
        "Put this mod into Factorio? It replaces 1 of the game's own files; Genex keeps it, and Remove mod puts it back.",
    });
    assert.deepEqual(await card(ModsTool.Install, { from: "../nope" }), {}, "a refused call: the manifest's question");
  });
});

describe("the status polls", () => {
  it("share one read of the stores for ten seconds, while a tool always reads afresh", async () => {
    const computer = await fakeComputer({ steam: [FACTORIO] });
    let clock = 0;
    const { tool, act } = await modsBackend(computer, "valley", () => clock);
    await tool(ModsTool.UseGame, { game: "steam:427520" });
    assert.match(JSON.stringify(await act(ModsAction.StageStatus)), /Mod for Factorio/);
    await rm(computer.steamGame("Factorio"), { recursive: true });
    assert.match(
      JSON.stringify(await act(ModsAction.StageStatus)),
      /Mod for Factorio/,
      "within ten seconds the poll keeps its read",
    );
    clock += 10_000;
    assert.match(JSON.stringify(await act(ModsAction.StageStatus)), /isn't installed on this computer now/);
    assert.match(
      String(await tool(ModsTool.Play).catch((e) => e.message)),
      /not installed on this computer anymore/,
      "a tool reads afresh",
    );
  });
});

describe("a new version of the mod", () => {
  it("replaces what the project put in the game in the same approval, so an older version leaves", async () => {
    const { tool, gameDir, computer } = await factorioMod();
    await tool(ModsTool.UseGame, { game: "steam:427520" });
    await tool(ModsTool.Install, { from: "faster_1.0.0" });
    await writeTree(gameDir, ["faster_1.1.0/info.json"]);
    assert.match(
      String(await tool(ModsTool.Install, { from: "faster_1.1.0", replace: true })),
      /^Took the earlier version out first\. Took the mod out of Factorio: removed 2 files[\s\S]*\nCopied 1 file /,
    );
    assert.deepEqual(await readdir(factorioMods(computer)), ["faster_1.1.0"]);
  });
});

describe("the observer", () => {
  it("hands over the newest pictures the agent kept, none when there are none", async () => {
    const { tool, gameDir } = await factorioMod();
    assert.deepEqual(await tool(ModsTool.GameShots), {});
    await mkdir(path.join(gameDir, SHOTS_FOLDER));
    for (const name of ["a.jpg", "b.jpg", "c.png", "d.jpg", "e.jpg", "notes.txt"])
      await writeFile(path.join(gameDir, SHOTS_FOLDER, name), name);
    const answer = (await tool(ModsTool.GameShots)) as { images: Array<{ name: string }> };
    assert.deepEqual(
      answer.images.map((image) => image.name),
      ["e.jpg", "d.jpg", "c.png", "b.jpg"],
    );
  });
});

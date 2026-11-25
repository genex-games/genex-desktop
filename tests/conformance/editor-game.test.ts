/**
 * The game an editor's Genex button means: the button sends its project's folder, and Genex opens
 * the chat of the game of this library whose folder holds it. The folder comes from outside Genex,
 * so it is compared by real path and nothing else is done with it.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { gameHoldingFolder, unrealProjectFolder } from "../../src/main/play/editor-game.ts";
import { tmpDir } from "../helpers/tmp.ts";

describe("the game an editor's Genex button means", () => {
  it("is the game whose folder is the project's or holds it", async () => {
    const root = await tmpDir("editor-game-");
    const forest = path.join(root, "games", "forest");
    const racer = path.join(root, "games", "racer");
    await mkdir(path.join(forest, "unreal", "Content"), { recursive: true });
    await mkdir(racer, { recursive: true });
    const games = [
      { name: "racer", dir: racer },
      { name: "forest", dir: forest },
    ];
    assert.equal(await gameHoldingFolder(games, path.join(forest, "unreal")), "forest");
    assert.equal(await gameHoldingFolder(games, forest), "forest");
    assert.equal(await gameHoldingFolder(games, racer), "racer");
  });

  it("is no game for a folder outside every game, a missing one or one that only looks inside", async () => {
    const root = await tmpDir("editor-game-");
    const forest = path.join(root, "games", "forest");
    const outside = path.join(root, "outside");
    await mkdir(forest, { recursive: true });
    await mkdir(path.join(root, "games", "forest-two"), { recursive: true });
    await mkdir(outside, { recursive: true });
    if (process.platform !== "win32") await symlink(outside, path.join(forest, "linked"));
    const games = [{ name: "forest", dir: forest }];
    const hostile = [
      outside,
      root,
      path.join(root, "games"),
      path.join(root, "games", "forest-two"),
      path.join(forest, "missing"),
      path.join(forest, "..", "..", "outside"),
      ...(process.platform === "win32" ? [] : [path.join(forest, "linked")]),
      "",
      "relative/forest",
    ];
    const before = await readdir(root, { recursive: true });
    for (const folder of hostile) assert.equal(await gameHoldingFolder(games, folder), null, folder);
    assert.deepEqual(await readdir(root, { recursive: true }), before, "nothing is made or changed");
  });

  it("takes for an Unreal project only a folder with a project file directly in it, and writes nothing", async () => {
    const root = await tmpDir("editor-project-");
    const valley = path.join(root, "Valley");
    await mkdir(path.join(valley, "Content"), { recursive: true });
    await writeFile(path.join(valley, "Valley.uproject"), "{}");
    await mkdir(path.join(root, "notes", "Fake.uproject"), { recursive: true });
    await mkdir(path.join(root, "empty"), { recursive: true });
    const before = await readdir(root, { recursive: true });
    assert.equal(await unrealProjectFolder(valley), valley);
    const hostile = [
      root, // the project is one level down
      path.join(root, "notes"), // a folder named like a project file
      path.join(root, "empty"),
      path.join(valley, "Valley.uproject"), // a file, not a folder
      path.join(root, "missing"),
      "",
    ];
    for (const folder of hostile) assert.equal(await unrealProjectFolder(folder), null, folder);
    assert.deepEqual(await readdir(root, { recursive: true }), before);
  });
});

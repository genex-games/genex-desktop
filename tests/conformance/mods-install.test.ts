/**
 * Putting a mod into a game and taking it out: an install copies the mod's files into the game's
 * mods folder or its own folder, keeps each game file it replaces and copies the saves aside once;
 * Remove mod puts back exactly what was there; Put back saves copies the saves back. Every hostile
 * path (out of the project, a link in the copied files, a link on the way into the game, a link
 * where a file would land) is refused with nothing written anywhere.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type InstallAsk,
  InstallProblem,
  InstallRefused,
  InstallRoot,
  installMod,
  readRecord,
  removeMod,
  restoreSaves,
  SavesKept,
} from "../../src/plugins/mods/install.ts";
import { writeTree } from "../helpers/mods-computer.ts";
import { tmpDir } from "../helpers/tmp.ts";

const GAME = "steam:427520";

/** A project with a mod in it, a game folder, a mods folder that doesn't exist yet and saves. */
async function setUp() {
  const root = await realpath(await tmpDir("mods-install-"));
  const project = path.join(root, "project");
  const game = path.join(root, "game");
  const mods = path.join(root, "support", "mods");
  const saves = path.join(root, "support", "saves");
  const kept = path.join(root, "storage", "installs", "p");
  await writeTree(project, [
    "mod/info.json",
    "mod/data.lua",
    "mod/graphics/icon.png",
    "loader/liblovely.dylib",
    "loader/run.sh",
  ]);
  await writeTree(game, ["Game.app/Contents/Info.plist", "liblovely.dylib", "keep/"]);
  await writeFile(path.join(game, "liblovely.dylib"), "the game's own");
  await writeTree(saves, ["world-1/level.dat"]);
  await writeFile(path.join(saves, "world-1", "level.dat"), "day 40");
  const places = { project, kept, roots: { [InstallRoot.Mods]: mods, [InstallRoot.Game]: game }, saves };
  return { root, project, game, mods, saves, kept, places };
}

/** Every path below `dir`, `/`-separated, sorted; links shown as links. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string, prefix: string) => {
    for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) out.push(`${rel} -> link`);
      else if (entry.isDirectory()) {
        out.push(`${rel}/`);
        await walk(path.join(at, entry.name), rel);
      } else out.push(rel);
    }
  };
  await walk(dir, "");
  return out.sort();
}

describe("installing a mod", () => {
  it("copies a folder into the mods folder, copying the saves aside first, once", async () => {
    const s = await setUp();
    const done = await installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods });
    assert.deepEqual(done, { copied: 3, replaced: 0, folder: await realpath(s.mods), saves: SavesKept.Copied });
    assert.deepEqual(await tree(s.mods), [
      "mod/",
      "mod/data.lua",
      "mod/graphics/",
      "mod/graphics/icon.png",
      "mod/info.json",
    ]);
    assert.equal(await readFile(path.join(s.kept, "saves", "first", "world-1", "level.dat"), "utf8"), "day 40");
    const again = await installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods });
    assert.equal(again.saves, SavesKept.Before);
    assert.equal((await readRecord(s.kept, GAME)).files.length, 3, "a second install records nothing twice");
  });

  it("puts a loader's files beside the game, keeping the game file one replaces and the run bit", async () => {
    const s = await setUp();
    await chmod(path.join(s.project, "loader", "run.sh"), 0o755);
    const done = await installMod(s.places, GAME, { from: "loader", into: InstallRoot.Game, contents: true });
    assert.equal(done.copied, 2);
    assert.equal(done.replaced, 1);
    assert.equal(await readFile(path.join(s.game, "liblovely.dylib"), "utf8"), "loader/liblovely.dylib");
    assert.equal((await stat(path.join(s.game, "run.sh"))).mode & 0o111, 0o111);
  });

  it("copies into a folder below the place, making it", async () => {
    const s = await setUp();
    await installMod(s.places, GAME, { from: "mod/data.lua", into: InstallRoot.Game, to: "BepInEx/plugins" });
    assert.equal(await readFile(path.join(s.game, "BepInEx", "plugins", "data.lua"), "utf8"), "mod/data.lua");
  });

  const refusals: Array<[string, Partial<InstallAsk> & { from: string }, InstallProblem]> = [
    ["a path out of the project", { from: "../game/Game.app" }, InstallProblem.BadPath],
    ["an absolute path", { from: "/etc/hosts" }, InstallProblem.BadPath],
    ["a Windows path", { from: "mod\\data.lua" }, InstallProblem.BadPath],
    ["a hidden folder", { from: ".git" }, InstallProblem.Hidden],
    ["nothing", { from: "nope" }, InstallProblem.NotThere],
    ["a below-folder out of the place", { from: "mod", to: "../../elsewhere" }, InstallProblem.BadPath],
    ["the contents of a file", { from: "mod/data.lua", contents: true }, InstallProblem.NotAFolder],
  ];
  for (const [name, ask, problem] of refusals)
    it(`refuses ${name}, writing nothing`, async () => {
      const s = await setUp();
      const before = { game: await tree(s.game), root: await tree(s.root) };
      await assert.rejects(
        installMod(s.places, GAME, { into: InstallRoot.Game, ...ask }),
        (error) => error instanceof InstallRefused && error.problem === problem,
      );
      assert.deepEqual(await tree(s.game), before.game);
      assert.deepEqual(await tree(s.root), before.root);
    });

  it("refuses files that hold a link, writing nothing", async () => {
    const s = await setUp();
    const secret = path.join(s.root, "secret.txt");
    await writeFile(secret, "private");
    await symlink(secret, path.join(s.project, "mod", "graphics", "key.txt"));
    await assert.rejects(installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods }), InstallRefused);
    assert.deepEqual(await tree(s.mods), []);
    await symlink(path.join(s.project, "mod"), path.join(s.project, "alias"));
    await assert.rejects(installMod(s.places, GAME, { from: "alias", into: InstallRoot.Game }), InstallRefused);
    assert.deepEqual(await tree(s.game), [
      "Game.app/",
      "Game.app/Contents/",
      "Game.app/Contents/Info.plist",
      "keep/",
      "liblovely.dylib",
    ]);
  });

  it("refuses a link on the way into the game, writing nothing through it", async () => {
    const s = await setUp();
    const elsewhere = path.join(s.root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(s.game, "BepInEx"));
    await assert.rejects(
      installMod(s.places, GAME, { from: "mod", into: InstallRoot.Game, to: "BepInEx/plugins" }),
      (error) => error instanceof InstallRefused && error.problem === InstallProblem.Unsafe,
    );
    assert.deepEqual(await tree(elsewhere), []);
  });

  it("refuses a link where a file would land, leaving what it points at alone", async () => {
    const s = await setUp();
    const target = path.join(s.root, "target.txt");
    await writeFile(target, "untouched");
    await symlink(target, path.join(s.game, "data.lua"));
    await assert.rejects(installMod(s.places, GAME, { from: "mod/data.lua", into: InstallRoot.Game }), InstallRefused);
    assert.equal(await readFile(target, "utf8"), "untouched");
  });

  it("refuses the mods folder of a game Genex knows none for", async () => {
    const s = await setUp();
    const places = { ...s.places, roots: { ...s.places.roots, [InstallRoot.Mods]: null } };
    await assert.rejects(
      installMod(places, GAME, { from: "mod", into: InstallRoot.Mods }),
      (error) => error instanceof InstallRefused && error.problem === InstallProblem.NoMods,
    );
  });
});

describe("a new version replacing the old", () => {
  it("takes the old files out only once the new install's checks pass", async () => {
    const s = await setUp();
    await installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods });
    await assert.rejects(
      installMod(s.places, GAME, { from: "../x", into: InstallRoot.Mods, replace: true }),
      InstallRefused,
    );
    assert.deepEqual(await tree(s.mods), [
      "mod/",
      "mod/data.lua",
      "mod/graphics/",
      "mod/graphics/icon.png",
      "mod/info.json",
    ]);
    const done = await installMod(s.places, GAME, { from: "loader", into: InstallRoot.Mods, replace: true });
    assert.equal(done.saves, SavesKept.Before, "the saves copied before the first install stay the ones kept");
    assert.deepEqual(await tree(s.mods), ["loader/", "loader/liblovely.dylib", "loader/run.sh"]);
  });
});

describe("removing a mod", () => {
  it("takes out every file it placed, puts back each it replaced and leaves the saves", async () => {
    const s = await setUp();
    const gameBefore = await tree(s.game);
    await installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods });
    await installMod(s.places, GAME, { from: "loader", into: InstallRoot.Game, contents: true });
    await installMod(s.places, GAME, { from: "mod/info.json", into: InstallRoot.Game, to: "keep/deep" });
    await writeFile(path.join(s.saves, "world-1", "level.dat"), "day 41");
    const done = await removeMod(s.places, GAME);
    assert.deepEqual(done, { removed: 5, restored: 1 });
    assert.deepEqual(await tree(s.game), gameBefore);
    assert.equal(await readFile(path.join(s.game, "liblovely.dylib"), "utf8"), "the game's own");
    assert.deepEqual(await tree(s.mods), []);
    assert.equal(await readFile(path.join(s.saves, "world-1", "level.dat"), "utf8"), "day 41");
    assert.deepEqual((await readRecord(s.kept, GAME)).files, []);
  });

  it("keeps a folder the person put a file in since", async () => {
    const s = await setUp();
    await installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods });
    await writeFile(path.join(s.mods, "mod", "notes.txt"), "mine");
    await removeMod(s.places, GAME);
    assert.deepEqual(await tree(s.mods), ["mod/", "mod/notes.txt"]);
  });

  it("never deletes through a link swapped in on the way", async () => {
    const s = await setUp();
    await installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods });
    const elsewhere = path.join(s.root, "elsewhere");
    await writeTree(elsewhere, ["data.lua", "info.json"]);
    await rm(path.join(s.mods, "mod"), { recursive: true });
    await symlink(elsewhere, path.join(s.mods, "mod"));
    await removeMod(s.places, GAME);
    assert.deepEqual(await tree(elsewhere), ["data.lua", "info.json"]);
  });
});

describe("putting back saves", () => {
  it("copies the saves from before the first install back, keeping today's aside", async () => {
    const s = await setUp();
    await installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods });
    await writeFile(path.join(s.saves, "world-1", "level.dat"), "broken by the mod");
    assert.equal(await restoreSaves(s.places, GAME), true);
    assert.equal(await readFile(path.join(s.saves, "world-1", "level.dat"), "utf8"), "day 40");
    assert.equal(
      await readFile(path.join(s.kept, "saves", "before-restore", "world-1", "level.dat"), "utf8"),
      "broken by the mod",
    );
  });

  it("does nothing before any install", async () => {
    const s = await setUp();
    assert.equal(await restoreSaves(s.places, GAME), false);
  });
});

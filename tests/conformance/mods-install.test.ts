/**
 * Putting a mod into a game and taking it out. An install checks everything before it writes,
 * copies the mod's files into the game's mods folder or its own folder (hidden files left out),
 * keeps each game file it replaces, copies the saves aside once and undoes itself when a write
 * fails; no project writes over a file another project placed. Remove mod puts back exactly what
 * was there, leaves a file the game changed since, and keeps (with its original) a file it can't
 * reach safely. Put back saves refuses when today's saves can't be copied aside first. Every
 * hostile path is refused with nothing written anywhere.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type InstallAsk,
  type InstallPlaces,
  InstallProblem,
  InstallRefused,
  InstallRoot,
  installMod,
  planInstall,
  readRecord,
  removeMod,
  restoreSaves,
  SavesKept,
} from "../../src/plugins/mods/install.ts";
import { ON_WINDOWS, writeTree } from "../helpers/mods-computer.ts";
import { tmpDir } from "../helpers/tmp.ts";

const GAME = "steam:427520";
/**
 * A link to a folder: on Windows a junction, which needs no Developer Mode and which Genex must
 * refuse as it refuses a link; elsewhere a symbolic link.
 */
const folderLink = (target: string, at: string) => symlink(target, at, ON_WINDOWS ? "junction" : "dir");

/** A project with a mod in it, a game folder, a mods folder that doesn't exist yet, and saves. */
async function setUp() {
  const root = await realpath(await tmpDir("mods-install-"));
  const project = path.join(root, "project");
  const game = path.join(root, "game");
  const mods = path.join(root, "support", "mods");
  const saves = path.join(root, "support", "saves");
  const storage = path.join(root, "storage");
  const kept = path.join(storage, "installs", "p");
  const files = ["mod/info.json", "mod/data.lua", "mod/graphics/icon.png", "loader/liblovely.dylib", "loader/run.sh"];
  await writeTree(project, files);
  await writeTree(game, ["Game.app/Contents/Info.plist", "liblovely.dylib", "keep/"]);
  await writeFile(path.join(game, "liblovely.dylib"), "the game's own");
  await writeTree(saves, ["world-1/level.dat"]);
  await writeFile(path.join(saves, "world-1", "level.dat"), "day 40");
  const places: InstallPlaces = {
    project,
    kept,
    claims: path.join(storage, "games", "g", "claims.json"),
    owner: "p",
    roots: { [InstallRoot.Mods]: mods, [InstallRoot.Game]: game },
    saves,
  };
  return { root, project, game, mods, saves, kept, storage, places };
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

const MOD_TREE = ["mod/", "mod/data.lua", "mod/graphics/", "mod/graphics/icon.png", "mod/info.json"];

describe("installing a mod", () => {
  it("copies a folder into the mods folder, copying the saves aside first, once", async () => {
    const s = await setUp();
    const done = await installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods });
    assert.deepEqual(done, { copied: 3, replaced: 0, folder: await realpath(s.mods), saves: SavesKept.Copied });
    assert.deepEqual(await tree(s.mods), MOD_TREE);
    assert.equal(await readFile(path.join(s.kept, "saves", "first", "world-1", "level.dat"), "utf8"), "day 40");
    const again = await installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods });
    assert.equal(again.saves, SavesKept.Before);
    assert.equal((await readRecord(s.kept, GAME)).files.length, 3, "a second install records nothing twice");
  });

  it("leaves hidden files out", async () => {
    const s = await setUp();
    await writeTree(s.project, ["mod/.DS_Store", "mod/.git/HEAD"]);
    await installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods });
    assert.deepEqual(await tree(s.mods), MOD_TREE);
  });

  it("puts a loader's files beside the game, keeping the game file one replaces and the run bit", {
    skip: ON_WINDOWS && "Windows keeps no run bit",
  }, async () => {
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

  it("makes a missing mods folder only below the game's own data folder, never a whole chain", async () => {
    const s = await setUp();
    const deep = path.join(s.root, "nowhere", "Balatro", "Mods");
    const places = { ...s.places, roots: { ...s.places.roots, [InstallRoot.Mods]: deep } };
    await assert.rejects(
      installMod(places, GAME, { from: "mod", into: InstallRoot.Mods }),
      (error) => error instanceof InstallRefused && error.problem === InstallProblem.NoGameData,
    );
    assert.deepEqual(await tree(path.join(s.root, "nowhere")), []);
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
      const before = await tree(s.root);
      await assert.rejects(
        installMod(s.places, GAME, { into: InstallRoot.Game, ...ask }),
        (error) => error instanceof InstallRefused && error.problem === problem,
      );
      assert.deepEqual(await tree(s.root), before);
    });

  it("refuses files that hold a link, writing nothing", async () => {
    const s = await setUp();
    const secrets = path.join(s.root, "secrets");
    await writeTree(secrets, ["key.txt"]);
    await folderLink(secrets, path.join(s.project, "mod", "graphics", "keys"));
    await assert.rejects(installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods }), InstallRefused);
    assert.deepEqual(await tree(s.mods), []);
    await folderLink(path.join(s.project, "mod"), path.join(s.project, "alias"));
    await assert.rejects(installMod(s.places, GAME, { from: "alias", into: InstallRoot.Game }), InstallRefused);
    assert.deepEqual(await tree(s.game), [
      "Game.app/",
      "Game.app/Contents/",
      "Game.app/Contents/Info.plist",
      "keep/",
      "liblovely.dylib",
    ]);
  });

  it("refuses a link to a file, in the mod or where a file would land, writing nothing", {
    skip: ON_WINDOWS && "Windows makes file links only in Developer Mode",
  }, async () => {
    const s = await setUp();
    const secret = path.join(s.root, "secret.txt");
    await writeFile(secret, "secret");
    const keyLink = path.join(s.project, "mod", "graphics", "key.txt");
    await symlink(secret, keyLink);
    await assert.rejects(installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods }), InstallRefused);
    assert.deepEqual(await tree(s.mods), []);
    await rm(keyLink);
    await symlink(secret, path.join(s.game, "data.lua"));
    await assert.rejects(installMod(s.places, GAME, { from: "mod/data.lua", into: InstallRoot.Game }), InstallRefused);
    assert.equal(await readFile(secret, "utf8"), "secret");
  });

  it("refuses a link on the way into the game before writing anything, even far down the list", async () => {
    const s = await setUp();
    const elsewhere = path.join(s.root, "elsewhere");
    await mkdir(elsewhere);
    await folderLink(elsewhere, path.join(s.game, "graphics"));
    const before = await tree(s.game);
    await assert.rejects(
      installMod(s.places, GAME, { from: "mod", into: InstallRoot.Game, contents: true }),
      (error) => error instanceof InstallRefused && error.problem === InstallProblem.Unsafe,
    );
    assert.deepEqual(await tree(s.game), before, "not even the files before the link went in");
    assert.deepEqual(await tree(elsewhere), []);
  });

  it("refuses a link where a file would land, leaving what it points at alone", async () => {
    const s = await setUp();
    const target = path.join(s.root, "target");
    await writeTree(target, ["inside.txt"]);
    await folderLink(target, path.join(s.game, "data.lua"));
    await assert.rejects(installMod(s.places, GAME, { from: "mod/data.lua", into: InstallRoot.Game }), InstallRefused);
    assert.deepEqual(await tree(target), ["inside.txt"]);
    assert.equal(await readFile(path.join(target, "inside.txt"), "utf8"), "inside.txt");
  });

  it("refuses the mods folder of a game Genex knows none for", async () => {
    const s = await setUp();
    const places = { ...s.places, roots: { ...s.places.roots, [InstallRoot.Mods]: null } };
    await assert.rejects(
      installMod(places, GAME, { from: "mod", into: InstallRoot.Mods }),
      (error) => error instanceof InstallRefused && error.problem === InstallProblem.NoMods,
    );
  });

  it("undoes itself when a source changes between the check and its copy, putting the game's file back", async () => {
    const s = await setUp();
    const swap = path.join(s.project, "loader", "run.sh");
    const places: InstallPlaces = {
      ...s.places,
      beforeFile: async (index) => {
        if (index !== 1) return;
        // A new file renamed over the old one: made while the old still exists, it never reuses its inode.
        await writeFile(`${swap}.new`, "swapped in");
        await rename(`${swap}.new`, swap);
      },
    };
    const before = await tree(s.game);
    const ask = { from: "loader", into: InstallRoot.Game, contents: true };
    await assert.rejects(installMod(places, GAME, ask), InstallRefused);
    assert.deepEqual(await tree(s.game), before);
    assert.equal(await readFile(path.join(s.game, "liblovely.dylib"), "utf8"), "the game's own");
    assert.deepEqual((await readRecord(s.kept, GAME)).files, []);
  });

  it("never writes over a file another mod project placed", async () => {
    const s = await setUp();
    await installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods });
    const other = { ...s.places, kept: path.join(s.storage, "installs", "q"), owner: "q" };
    const before = await tree(s.mods);
    await assert.rejects(
      installMod(other, GAME, { from: "mod", into: InstallRoot.Mods }),
      (error) => error instanceof InstallRefused && error.problem === InstallProblem.OtherMod,
    );
    assert.deepEqual(await tree(s.mods), before);
    await removeMod(s.places, GAME);
    await installMod(other, GAME, { from: "mod", into: InstallRoot.Mods });
    assert.deepEqual(await tree(s.mods), MOD_TREE, "once the first project took its mod out, the file is free");
  });

  it("lets only one of two projects installing the same file at once have it", async () => {
    const s = await setUp();
    const other = { ...s.places, kept: path.join(s.storage, "installs", "q"), owner: "q" };
    const ask = { from: "mod", into: InstallRoot.Mods };
    const results = await Promise.allSettled([installMod(s.places, GAME, ask), installMod(other, GAME, ask)]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "rejected"],
    );
    const refusal = results[1]?.status === "rejected" ? results[1].reason : null;
    assert.ok(refusal instanceof InstallRefused && refusal.problem === InstallProblem.OtherMod);
    const claims = JSON.parse(await readFile(s.places.claims, "utf8"));
    assert.deepEqual(new Set(Object.values(claims)), new Set(["p"]));
    assert.deepEqual((await readRecord(other.kept, GAME)).files, []);
  });

  it("plans the card's words with nothing written: how many of the game's files it replaces", async () => {
    const s = await setUp();
    const before = await tree(s.root);
    const plan = await planInstall(s.places, GAME, { from: "loader", into: InstallRoot.Game, contents: true });
    assert.equal(plan.replaced, 1);
    assert.deepEqual(await tree(s.root), before);
  });
});

describe("a new version replacing the old", () => {
  it("takes the old files out only once the new install's checks pass", async () => {
    const s = await setUp();
    await installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods });
    const bad = { from: "../x", into: InstallRoot.Mods, replace: true };
    await assert.rejects(installMod(s.places, GAME, bad), InstallRefused);
    assert.deepEqual(await tree(s.mods), MOD_TREE);
    const done = await installMod(s.places, GAME, { from: "loader", into: InstallRoot.Mods, replace: true });
    assert.equal(done.saves, SavesKept.Before, "the saves copied before the first install stay the ones kept");
    assert.deepEqual(done.before, { removed: 3, restored: 0, skipped: 0, changed: 0 });
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
    assert.deepEqual(done, { removed: 5, restored: 1, skipped: 0, changed: 0 });
    assert.deepEqual(await tree(s.game), gameBefore);
    assert.equal(await readFile(path.join(s.game, "liblovely.dylib"), "utf8"), "the game's own");
    assert.deepEqual(await tree(s.mods), []);
    assert.equal(await readFile(path.join(s.saves, "world-1", "level.dat"), "utf8"), "day 41");
    assert.deepEqual((await readRecord(s.kept, GAME)).files, []);
  });

  it("leaves a file the game changed since, and forgets it", async () => {
    const s = await setUp();
    await installMod(s.places, GAME, { from: "loader", into: InstallRoot.Game, contents: true });
    await writeFile(path.join(s.game, "liblovely.dylib"), "a game update's");
    const done = await removeMod(s.places, GAME);
    assert.deepEqual(done, { removed: 1, restored: 0, skipped: 0, changed: 1 });
    assert.equal(await readFile(path.join(s.game, "liblovely.dylib"), "utf8"), "a game update's");
    assert.deepEqual((await readRecord(s.kept, GAME)).files, []);
  });

  it("keeps a folder the person put a file in since", async () => {
    const s = await setUp();
    await installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods });
    await writeFile(path.join(s.mods, "mod", "notes.txt"), "mine");
    await removeMod(s.places, GAME);
    assert.deepEqual(await tree(s.mods), ["mod/", "mod/notes.txt"]);
  });

  it("never deletes through a link on the way, and keeps that file and its original for a later try", async () => {
    const s = await setUp();
    await writeTree(s.game, ["sub/liblovely.dylib"]);
    await writeFile(path.join(s.game, "sub", "liblovely.dylib"), "the game's own, below");
    await installMod(s.places, GAME, { from: "loader/liblovely.dylib", into: InstallRoot.Game, to: "sub" });
    const real = path.join(s.root, "real-sub");
    await rename(path.join(s.game, "sub"), real);
    await folderLink(real, path.join(s.game, "sub"));
    const first = await removeMod(s.places, GAME);
    assert.deepEqual(first, { removed: 0, restored: 0, skipped: 1, changed: 0 });
    assert.equal(await readFile(path.join(real, "liblovely.dylib"), "utf8"), "loader/liblovely.dylib");
    assert.equal((await readRecord(s.kept, GAME)).files.length, 1, "the file stays recorded");
    await rm(path.join(s.game, "sub"));
    await rename(real, path.join(s.game, "sub"));
    const second = await removeMod(s.places, GAME);
    assert.deepEqual(second, { removed: 0, restored: 1, skipped: 0, changed: 0 });
    assert.equal(await readFile(path.join(s.game, "sub", "liblovely.dylib"), "utf8"), "the game's own, below");
  });
});

describe("putting back saves", () => {
  it("copies the saves from before the first install back, keeping today's aside", async () => {
    const s = await setUp();
    await installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods });
    await writeFile(path.join(s.saves, "world-1", "level.dat"), "broken by the mod");
    assert.equal(await restoreSaves(s.places, GAME), true);
    assert.equal(await readFile(path.join(s.saves, "world-1", "level.dat"), "utf8"), "day 40");
    const aside = path.join(s.kept, "saves", "before-restore", "world-1", "level.dat");
    assert.equal(await readFile(aside, "utf8"), "broken by the mod");
  });

  it("puts nothing back when today's saves are too big to copy aside first", async () => {
    const s = await setUp();
    await installMod(s.places, GAME, { from: "mod", into: InstallRoot.Mods });
    await writeTree(s.saves, ["world-2/a", "world-2/b"]);
    await writeFile(path.join(s.saves, "world-1", "level.dat"), "today");
    const tight = { ...s.places, saveLimits: { files: 2, bytes: 1024 } };
    await assert.rejects(
      restoreSaves(tight, GAME),
      (error) => error instanceof InstallRefused && error.problem === InstallProblem.SavesTooBig,
    );
    assert.equal(await readFile(path.join(s.saves, "world-1", "level.dat"), "utf8"), "today");
  });

  it("does nothing before any install", async () => {
    const s = await setUp();
    assert.equal(await restoreSaves(s.places, GAME), false);
  });
});

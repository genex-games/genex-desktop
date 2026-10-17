/**
 * Create game in a folder the user chose: the chosen folder is only *where*, and the game gets a
 * new folder of its own inside it, named as the user named the game. The chosen folder's own
 * contents are never opened, adopted or written (the Open Game sheet used to take over here and
 * offer to open whatever was already in it).
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { GameWorkspaces } from "../../src/substrate/game-workspace.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const posixOnly = process.platform === "win32" ? "symlinks need privileges on Windows" : false;

async function workspaces() {
  const base = await tmpDir("studio-game-location-");
  const options = {
    root: path.join(base, "library"),
    templateDir: path.join(repo, "src", "game-template"),
    vendorDir: path.join(base, "vendor"),
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
  };
  await mkdir(options.userData, { recursive: true });
  const places = path.join(base, "places");
  await mkdir(places, { recursive: true });
  return { games: new GameWorkspaces(options), base, places, options };
}

/** What a refused location must leave exactly as it was. */
async function sideEffects(games: GameWorkspaces, options: { root: string; indexFile: string }, watched: string) {
  // Listing first: a listing makes the games folder and its index, which is not the location's doing.
  const listed = (await games.list()).map((game) => `${game.name}=${game.dir}`);
  return {
    listed,
    watched: await readdir(watched).catch(() => null),
    root: await readdir(options.root).catch(() => null),
    index: await readFile(options.indexFile, "utf8").catch(() => null),
  };
}

describe("creating a game in a chosen folder", () => {
  it("makes a new folder named after the game inside the chosen one, and lists it", async () => {
    const { games, places, options } = await workspaces();
    const parent = path.join(places, "Projects");
    await mkdir(path.join(parent, "some-old-game"), { recursive: true });
    await writeFile(path.join(parent, "some-old-game", "index.html"), "<title>theirs</title>");
    await writeFile(path.join(parent, "notes.txt"), "mine");

    const game = await games.create("Space Pong", { parent });

    assert.equal(game.dir, path.join(await realpath(parent), "Space Pong"));
    assert.equal(game.title, "Space Pong");
    assert.equal(game.library, false);
    // New game makes an empty folder: its record carries the title, and no starter page is written.
    assert.equal(await readFile(path.join(game.dir, "index.html"), "utf8").catch(() => null), null);
    assert.equal(JSON.parse(await readFile(path.join(game.dir, "studio.json"), "utf8")).title, "Space Pong");
    assert.deepEqual((await readdir(parent)).sort(), ["Space Pong", "notes.txt", "some-old-game"]);
    assert.equal(await readFile(path.join(parent, "some-old-game", "index.html"), "utf8"), "<title>theirs</title>");
    assert.equal(await readFile(path.join(parent, "notes.txt"), "utf8"), "mine");
    assert.deepEqual(await readdir(options.root), [], "nothing is made in the games folder");

    const reopened = new GameWorkspaces(options);
    const listed = (await reopened.list()).find((row) => row.name === game.name);
    assert.equal(listed?.dir, game.dir, "the game is still listed after a restart");
    assert.equal(reopened.dirFor(game.name), game.dir);
    assert.equal(reopened.root, options.root, "a game's location never moves the games folder");
  });

  it("keeps the words the user typed, and never overwrites a folder that is already there", async () => {
    const { games, places } = await workspaces();
    const parent = path.join(places, "Игры");
    await mkdir(path.join(parent, "Лунный лес"), { recursive: true });
    await writeFile(path.join(parent, "Лунный лес", "keep.txt"), "keep");
    await writeFile(path.join(parent, "Лунный лес 2"), "a file, not a folder");

    const game = await games.create("Лунный лес", { parent });

    assert.equal(path.basename(game.dir), "Лунный лес 3");
    assert.equal(await readFile(path.join(parent, "Лунный лес", "keep.txt"), "utf8"), "keep");
    assert.deepEqual(await readdir(path.join(parent, "Лунный лес")), ["keep.txt"]);
    assert.equal(await readFile(path.join(parent, "Лунный лес 2"), "utf8"), "a file, not a folder");
    assert.equal(game.title, "Лунный лес");
  });

  it("never lets a title reach outside the chosen folder, hide itself or name a device", async () => {
    const { games, places } = await workspaces();
    const parent = path.join(places, "titles");
    await mkdir(parent);
    const real = await realpath(parent);
    const titles = [
      "../escape",
      "a/b\\c",
      "..",
      ".hidden",
      "CON",
      "CON.txt",
      "nul.tar.gz",
      "LPT1.md",
      "COM¹",
      "con .txt",
    ];
    for (const title of [...titles, "  spaced out.  ", 'Q: "why?" <a|b>*', "Pong [WIP]"]) {
      const game = await games.create(title, { parent });
      const name = path.basename(game.dir);
      assert.equal(path.dirname(game.dir), real, title);
      assert.ok(!name.startsWith("."), `${title}: not hidden`);
      // Windows reads a device name in the part before the first dot, whatever follows it.
      const stem = (name.split(".")[0] ?? "").trimEnd();
      assert.doesNotMatch(stem, /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i, `${title}: not a device name`);
      // Glob characters too: the sandbox reads a path holding one as a pattern.
      assert.doesNotMatch(name, /[\\/:*?"<>|[\]]|[. ]$/, `${title}: a name any file system and sandbox keep`);
    }
    assert.deepEqual(await readdir(places), ["titles"]);
  });

  it("the games folder itself is the ordinary library, not a location", async () => {
    const { games, options } = await workspaces();
    await mkdir(options.root, { recursive: true });
    const game = await games.create("Pong", { parent: options.root });
    assert.equal(game.library, true);
    assert.equal(game.dir, path.join(options.root, "pong"));
    assert.equal(await games.location(options.root), await realpath(options.root));
  });

  it("a name the library already uses gets its own, and both games keep their folders", async () => {
    const { games, places, options } = await workspaces();
    const inLibrary = await games.create("Pong");
    const elsewhere = await games.create("Pong", { parent: places });
    assert.notEqual(elsewhere.name, inLibrary.name);
    assert.equal(elsewhere.dir, path.join(await realpath(places), "Pong"));
    const later = await games.create("Pong");
    const reopened = new GameWorkspaces(options);
    const dirs = Object.fromEntries((await reopened.list()).map((game) => [game.name, game.dir]));
    assert.equal(dirs[inLibrary.name], inLibrary.dir);
    assert.equal(dirs[elsewhere.name], elsewhere.dir);
    assert.equal(dirs[later.name], later.dir);
    assert.equal(new Set([inLibrary.name, elsewhere.name, later.name]).size, 3);
  });

  it("a long name used twice gets a second one, not a hang", async () => {
    const { games, places } = await workspaces();
    const title = "The Legend of the Very Long Named Game of Doom and Destiny Part II";
    const first = await games.create(title, { parent: places });
    const second = await games.create(title, { parent: places });
    const inRoot = await games.create(title);
    assert.equal(new Set([first.name, second.name, inRoot.name]).size, 3);
  });

  it("making the chosen folder the games folder later keeps every game's name and folder", async () => {
    const { games, places, options } = await workspaces();
    const inLibrary = await games.create("pong");
    const placed = await games.create("pong", { parent: places });
    assert.equal(path.basename(placed.dir), "pong", "a one-word title is also a library-style folder name");
    // As Settings → Games hands it over: the folder's real path.
    const root = await realpath(places);
    await games.changeRoot(root);
    const reopened = new GameWorkspaces({ ...options, root });
    await reopened.list();
    for (const workspaces of [games, reopened]) {
      assert.equal(workspaces.dirFor(inLibrary.name), inLibrary.dir, "the first game keeps its name");
      assert.equal(workspaces.dirFor(placed.name), placed.dir, "the placed game keeps its name");
    }
  });

  it("two games with one name at once get two folders", async () => {
    const { games, places } = await workspaces();
    const [a, b] = await Promise.all([
      games.create("Twin", { parent: places }),
      games.create("Twin", { parent: places }),
    ]);
    assert.notEqual(a.name, b.name);
    assert.deepEqual([path.basename(a.dir), path.basename(b.dir)].sort(), ["Twin", "Twin 2"]);
    assert.deepEqual((await games.list()).map((game) => game.name).sort(), [a.name, b.name].sort());
  });

  it("a link to an ordinary folder creates the game in the folder it points at", { skip: posixOnly }, async () => {
    const { games, base, places } = await workspaces();
    await mkdir(path.join(places, "real"));
    await symlink(path.join(places, "real"), path.join(base, "shortcut"));
    const game = await games.create("Linked", { parent: path.join(base, "shortcut") });
    assert.equal(game.dir, path.join(await realpath(path.join(places, "real")), "Linked"));
  });
});

describe("a location that is refused changes nothing", () => {
  it("a link swapped in after the location was checked is caught before anything is written", {
    skip: posixOnly,
  }, async () => {
    const env = await workspaces();
    const parent = path.join(env.places, "Projects");
    const outside = path.join(env.base, "outside");
    await mkdir(parent);
    await mkdir(outside);
    const before = await sideEffects(env.games, env.options, outside);
    const swap = async () => {
      await rename(parent, `${parent}-moved`);
      await symlink(outside, parent);
    };
    await assert.rejects(env.games.create("Escape", { parent, allowed: swap }));
    assert.deepEqual(await sideEffects(env.games, env.options, outside), before, "nothing outside, no alias");
  });

  /** Each row builds a hostile location and names the folder whose contents must not change. */
  const rows: Array<{
    name: string;
    skip?: string | false;
    setup(env: Awaited<ReturnType<typeof workspaces>>): Promise<{ parent: string; watched: string }>;
  }> = [
    {
      name: "a game in the library",
      async setup({ games }) {
        const game = await games.create("Pong");
        return { parent: game.dir, watched: game.dir };
      },
    },
    {
      name: "a folder inside a game",
      async setup({ games }) {
        const game = await games.create("Pong");
        return { parent: path.join(game.dir, "src"), watched: path.join(game.dir, "src") };
      },
    },
    {
      name: "a game opened from elsewhere",
      async setup({ games, places }) {
        await mkdir(path.join(places, "mine"));
        const game = await games.adopt(path.join(places, "mine"));
        return { parent: game.dir, watched: game.dir };
      },
    },
    {
      name: "a game removed from the sidebar",
      async setup({ games }) {
        const game = await games.create("Old");
        await games.forget(game.name);
        return { parent: game.dir, watched: game.dir };
      },
    },
    {
      name: "a game created in a chosen folder",
      async setup({ games, places }) {
        const game = await games.create("Placed", { parent: places });
        return { parent: game.dir, watched: game.dir };
      },
    },
    {
      name: "the app's own data",
      async setup({ options }) {
        return { parent: options.userData, watched: options.userData };
      },
    },
    {
      name: "a folder inside the app's own data",
      async setup({ options }) {
        await mkdir(path.join(options.userData, "secrets"));
        return { parent: path.join(options.userData, "secrets"), watched: path.join(options.userData, "secrets") };
      },
    },
    {
      name: "a Claude Code settings folder",
      async setup({ places }) {
        await mkdir(path.join(places, ".claude", "skills"), { recursive: true });
        return { parent: path.join(places, ".claude", "skills"), watched: path.join(places, ".claude", "skills") };
      },
    },
    {
      name: "a link to a game",
      skip: posixOnly,
      async setup({ games, base }) {
        const game = await games.create("Pong");
        await symlink(game.dir, path.join(base, "to-pong"));
        return { parent: path.join(base, "to-pong"), watched: game.dir };
      },
    },
    {
      name: "a folder that does not exist",
      async setup({ places }) {
        return { parent: path.join(places, "missing", "deeper"), watched: places };
      },
    },
    {
      name: "a file",
      async setup({ places }) {
        await writeFile(path.join(places, "file.txt"), "text");
        return { parent: path.join(places, "file.txt"), watched: places };
      },
    },
    {
      name: "a relative path",
      async setup({ places }) {
        return { parent: path.relative(process.cwd(), places), watched: places };
      },
    },
    {
      name: "an empty path",
      async setup({ places }) {
        return { parent: "", watched: places };
      },
    },
    {
      name: "the whole disk",
      async setup({ base, places }) {
        return { parent: path.parse(base).root, watched: places };
      },
    },
  ];

  for (const row of rows) {
    it(row.name, { skip: row.skip ?? false }, async () => {
      const env = await workspaces();
      const { parent, watched } = await row.setup(env);
      const before = await sideEffects(env.games, env.options, watched);
      await assert.rejects(env.games.location(parent), `${row.name}: the picker refuses it`);
      await assert.rejects(env.games.create("Intruder", { parent }), `${row.name}: creating there is refused`);
      assert.deepEqual(await sideEffects(env.games, env.options, watched), before, `${row.name}: nothing changed`);
    });
  }
});

/** A core whose games folder is spelled by its real path, as a launch's own games folder is. */
async function studio() {
  return coreLite({ gamesRoot: await realpath(await tmpDir("studio-game-location-games-")) });
}

describe("the studio checks a chosen folder before the library writes anything", () => {
  it("a development profile keeps new games inside its own games folder", { skip: posixOnly }, async () => {
    const { core, gamesRoot } = await studio();
    const outside = await tmpDir("studio-game-location-outside-");
    await symlink(outside, path.join(gamesRoot, "shortcut"));
    for (const parent of [outside, path.join(gamesRoot, "shortcut")]) {
      await assert.rejects(core.gameLocation(parent), /outside the owned|alias/, parent);
      await assert.rejects(core.createGame("Escape", { parent }), /outside the owned|alias/, parent);
    }
    assert.deepEqual(await readdir(outside), [], "nothing was written outside the profile");
    assert.deepEqual(await readdir(gamesRoot), ["shortcut"]);
  });

  it("refuses the Genex login folder, also through a link, before anything is written", {
    skip: posixOnly,
  }, async (t) => {
    const home = await realpath(await tmpDir("studio-game-location-home-"));
    const previous = process.env.HOME;
    process.env.HOME = home;
    t.after(() => {
      process.env.HOME = previous;
    });
    // A launch without the development policy, as the normal profile runs.
    const { core } = await coreLite({ executionPolicy: { runBackgroundImprovement: false } });
    await mkdir(path.join(home, "dotfiles", "genex", "inner"), { recursive: true });
    await symlink(path.join(home, "dotfiles", "genex"), path.join(home, ".genex"));
    for (const parent of [path.join(home, ".genex"), path.join(home, "dotfiles", "genex", "inner")]) {
      await assert.rejects(core.gameLocation(parent), /can't create games there/, parent);
      await assert.rejects(core.createGame("Leak", { parent }), /can't create games there/, parent);
    }
    assert.deepEqual(await readdir(path.join(home, "dotfiles", "genex")), ["inner"]);
    assert.deepEqual(await readdir(path.join(home, "dotfiles", "genex", "inner")), []);
  });

  it("offers the games folder and a plain folder inside it, labelled as the picker shows them", async () => {
    const { core, gamesRoot } = await studio();
    await mkdir(path.join(gamesRoot, "My Stuff"));
    const library = await core.gameLocation(gamesRoot);
    assert.equal(library.dir, await realpath(gamesRoot));
    const game = await core.createGame("Home", { parent: gamesRoot });
    assert.equal(game.library, true);

    const stuff = await core.gameLocation(path.join(gamesRoot, "My Stuff"));
    assert.equal(stuff.dir, await realpath(path.join(gamesRoot, "My Stuff")));
    assert.ok(stuff.pathLabel.endsWith(`${path.sep}My Stuff`), stuff.pathLabel);
    const placed = await core.createGame("Placed", { parent: stuff.dir });
    assert.equal(placed.dir, path.join(stuff.dir, "Placed"));
    assert.ok((await core.games.list()).some((listed) => listed.dir === placed.dir));
  });
});

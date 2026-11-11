/**
 * Move into game: the plan every engine shares (`substrate/plugins/engine-move.ts`), and the moves
 * of the Unreal and Godot plugins over it. A refused move changes nothing on disk; a move whose
 * link fails puts the folder back.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  gamesLinkedTo,
  moveIntoGame as moveGodot,
  planMoveIn as planGodot,
} from "../../src/plugins/godot/move-into-game.ts";
import { moveIntoGame as moveUnreal, planMoveIn as planUnreal } from "../../src/plugins/unreal/move-into-game.ts";
import { ENGINE_LINKS_FOLDER } from "../../src/shared/plugins.ts";
import { type MoveInFacts, MoveInRefusal, planMoveIn } from "../../src/substrate/plugins/engine-move.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A made-up engine: a game keeps its project in `toy/`, and a project folder holds `project.toy`. */
const TOY = {
  folder: "toy",
  isProjectFolder: async (folder: string) => (await readdir(folder).catch((): string[] => [])).includes("project.toy"),
};

/** Every path under `root`, sorted: what a refused move must leave as it was. */
async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.map((entry) => path.join(entry.parentPath, entry.name)).sort();
}

/** A home with a game folder and a toy project outside it. */
async function place() {
  const root = await realpath(await tmpDir("studio-engine-move-"));
  const home = path.join(root, "home");
  const game = path.join(home, "AI Games", "lantern");
  const project = path.join(home, "Projects", "Lantern");
  await mkdir(game, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "project.toy"), "");
  const facts: MoveInFacts = { game, home, directory: project, own: true, shared: false, inUse: false };
  return { root, home, game, project, facts };
}

type Place = Awaited<ReturnType<typeof place>>;

describe("the plan for Move into game", () => {
  it("moves the open game's own project folder into the game's folder for that engine", async () => {
    const p = await place();
    assert.deepEqual(await planMoveIn(p.facts, TOY), { from: p.project, target: path.join(p.game, "toy") });
  });

  it("compares folders by their real place: a project reached through a link is planned from where it is", async () => {
    const p = await place();
    const link = path.join(p.home, "shortcut");
    await symlink(p.project, link);
    assert.deepEqual(await planMoveIn({ ...p.facts, directory: link }, TOY), {
      from: p.project,
      target: path.join(p.game, "toy"),
    });
  });

  /** Each way a move is refused: what is arranged, the facts it gives, and the refusal. */
  const REFUSED: Array<{ name: string; arrange: (p: Place) => Promise<Partial<MoveInFacts>>; refusal: MoveInRefusal }> =
    [
      { name: "no game is open", arrange: async () => ({ game: undefined }), refusal: MoveInRefusal.NoGame },
      {
        name: "the project isn't the game's own",
        arrange: async () => ({ own: false }),
        refusal: MoveInRefusal.NotOwn,
      },
      {
        name: "the project is already inside the game",
        arrange: async (p) => {
          const inside = path.join(p.game, "somewhere", "Lantern");
          await mkdir(inside, { recursive: true });
          await writeFile(path.join(inside, "project.toy"), "");
          return { directory: inside };
        },
        refusal: MoveInRefusal.Inside,
      },
      {
        name: "the project is the game's folder itself, reached through a link",
        arrange: async (p) => {
          await writeFile(path.join(p.game, "project.toy"), "");
          const link = path.join(p.home, "game-link");
          await symlink(p.game, link);
          return { directory: link };
        },
        refusal: MoveInRefusal.Inside,
      },
      {
        name: "the project's folder holds the game",
        arrange: async (p) => {
          await writeFile(path.join(p.home, "AI Games", "project.toy"), "");
          return { directory: path.join(p.home, "AI Games") };
        },
        refusal: MoveInRefusal.HoldsGame,
      },
      {
        name: "the project's folder is the person's home",
        arrange: async (p) => {
          await writeFile(path.join(p.home, "project.toy"), "");
          return { directory: p.home };
        },
        refusal: MoveInRefusal.HoldsGame,
      },
      {
        name: "the project's folder holds home, spelled with ..",
        arrange: async (p) => ({ directory: path.join(p.project, "..", "..", "..") }),
        refusal: MoveInRefusal.HoldsGame,
      },
      {
        name: "the folder is a disk's root",
        arrange: async () => ({ directory: path.parse(process.cwd()).root }),
        refusal: MoveInRefusal.NotProjectFolder,
      },
      {
        name: "the folder isn't a project's own by the engine's rule",
        arrange: async (p) => {
          const plain = path.join(p.home, "Downloads");
          await mkdir(plain, { recursive: true });
          return { directory: plain };
        },
        refusal: MoveInRefusal.NotProjectFolder,
      },
      {
        name: "the folder is another Genex game's own",
        arrange: async (p) => {
          await writeFile(path.join(p.project, "studio.json"), "{}\n");
          return {};
        },
        refusal: MoveInRefusal.NotProjectFolder,
      },
      {
        name: "the folder doesn't exist",
        arrange: async (p) => ({ directory: path.join(p.home, "gone") }),
        refusal: MoveInRefusal.NotProjectFolder,
      },
      {
        name: "another Genex game builds in it too",
        arrange: async () => ({ shared: true }),
        refusal: MoveInRefusal.Shared,
      },
      {
        name: "its editor has it open, or a Loop is using it",
        arrange: async () => ({ inUse: true }),
        refusal: MoveInRefusal.InUse,
      },
      {
        name: "the game already has the engine's folder",
        arrange: async (p) => {
          await mkdir(path.join(p.game, "toy"));
          return {};
        },
        refusal: MoveInRefusal.Taken,
      },
      {
        name: "the game has a file of that name",
        arrange: async (p) => {
          await writeFile(path.join(p.game, "toy"), "");
          return {};
        },
        refusal: MoveInRefusal.Taken,
      },
      {
        name: "the game has a dangling link of that name",
        arrange: async (p) => {
          await symlink(path.join(p.root, "nowhere"), path.join(p.game, "toy"));
          return {};
        },
        refusal: MoveInRefusal.Taken,
      },
    ];

  for (const { name, arrange, refusal } of REFUSED)
    it(`refuses when ${name}, and changes nothing`, async () => {
      const p = await place();
      const facts = { ...p.facts, ...(await arrange(p)) };
      const before = await tree(p.root);
      assert.deepEqual(await planMoveIn(facts, TOY), { refusal });
      assert.deepEqual(await tree(p.root), before);
    });
});

describe("Unreal's Move into game", () => {
  /** A game folder and an Unreal project outside it, with the plugin's storage. */
  async function unrealPlace(extra: string[] = []) {
    const p = await place();
    const project = path.join(p.home, "Unreal Projects", "Drift");
    for (const folder of ["Config", "Content"]) await mkdir(path.join(project, folder), { recursive: true });
    const file = path.join(project, "Drift.uproject");
    await writeFile(file, "{}\n");
    for (const name of extra) await writeFile(path.join(project, name), "{}\n");
    const storage = path.join(p.root, "storage");
    await mkdir(storage);
    return { ...p, project, file, storage, facts: { ...p.facts, directory: project } };
  }

  it("takes a folder with Config, Content and one project file, and refuses one with a second project or without Unreal's folders", async () => {
    const one = await unrealPlace();
    assert.deepEqual(await planUnreal(one.facts), { from: one.project, target: path.join(one.game, "unreal") });
    const two = await unrealPlace(["Other.uproject"]);
    assert.deepEqual(await planUnreal(two.facts), { refusal: MoveInRefusal.NotProjectFolder });
    const bare = await place();
    await writeFile(path.join(bare.project, "Drift.uproject"), "{}\n");
    assert.deepEqual(await planUnreal(bare.facts), { refusal: MoveInRefusal.NotProjectFolder });
  });

  it("moves the folder, links the game to the project's new file, and keeps Unreal's scratch out of the game's save points", async () => {
    const p = await unrealPlace();
    const linked: string[] = [];
    const moved = await moveUnreal({
      plan: { from: p.project, target: path.join(p.game, "unreal") },
      file: p.file,
      game: p.game,
      storage: p.storage,
      link: async (project) => void linked.push(project),
    });
    assert.equal(moved, path.join(p.game, "unreal", "Drift.uproject"));
    assert.deepEqual(linked, [moved]);
    assert.deepEqual((await readdir(path.join(p.game, "unreal"))).sort(), ["Config", "Content", "Drift.uproject"]);
    assert.equal((await readdir(path.dirname(p.project))).includes("Drift"), false, "nothing is left behind");
    assert.match(await readFile(path.join(p.game, ".gitignore"), "utf8"), /Intermediate/);
  });

  it("a link that fails puts the folder back where it was, and the game's ignore file as it was", async () => {
    const p = await unrealPlace();
    await writeFile(path.join(p.game, ".gitignore"), "mine\n");
    const before = await tree(p.root);
    await assert.rejects(
      moveUnreal({
        plan: { from: p.project, target: path.join(p.game, "unreal") },
        file: p.file,
        game: p.game,
        storage: p.storage,
        link: async () => {
          throw new Error("the host refused the link");
        },
      }),
      /the host refused the link/,
    );
    assert.deepEqual(await tree(p.root), before);
    assert.equal(await readFile(path.join(p.game, ".gitignore"), "utf8"), "mine\n");
  });
});

describe("Godot's Move into game", () => {
  async function godotPlace() {
    const p = await place();
    await writeFile(path.join(p.project, "project.godot"), "");
    return p;
  }

  it("takes a folder with project.godot, and never one of the person's own home folders", async () => {
    const p = await godotPlace();
    assert.deepEqual(await planGodot(p.facts), { from: p.project, target: path.join(p.game, "godot") });
    for (const folder of ["Documents", "Desktop", "Downloads"]) {
      const own = path.join(p.home, folder);
      await mkdir(own, { recursive: true });
      await writeFile(path.join(own, "project.godot"), "");
      const before = await tree(p.root);
      assert.deepEqual(await planGodot({ ...p.facts, directory: own }), { refusal: MoveInRefusal.NotProjectFolder });
      assert.deepEqual(await tree(p.root), before);
    }
  });

  it("moves the folder, links the game to it, and adds Godot's ignore file only where the project has none", async () => {
    const p = await godotPlace();
    const linked: string[] = [];
    const target = path.join(p.game, "godot");
    assert.equal(
      await moveGodot({ plan: { from: p.project, target }, link: async (to) => void linked.push(to) }),
      target,
    );
    assert.deepEqual(linked, [target]);
    assert.match(await readFile(path.join(target, ".gitignore"), "utf8"), /^\.godot\/$/m);

    const own = await godotPlace();
    await writeFile(path.join(own.project, ".gitignore"), "mine\n");
    const kept = path.join(own.game, "godot");
    await moveGodot({ plan: { from: own.project, target: kept }, link: async () => undefined });
    assert.equal(await readFile(path.join(kept, ".gitignore"), "utf8"), "mine\n");
  });

  it("a link that fails puts the folder back where it was", async () => {
    const p = await godotPlace();
    const before = await tree(p.root);
    await assert.rejects(
      moveGodot({
        plan: { from: p.project, target: path.join(p.game, "godot") },
        link: async () => {
          throw new Error("no link");
        },
      }),
      /no link/,
    );
    assert.deepEqual(await tree(p.root), before);
  });

  it("finds the games linked to a project among the host's link records, reading only Godot links", async () => {
    const p = await godotPlace();
    const links = path.join(p.root, "storage", ENGINE_LINKS_FOLDER);
    await mkdir(links, { recursive: true });
    const project = path.join(p.project, "project.godot");
    await writeFile(path.join(links, "lantern.json"), JSON.stringify({ kind: "godot", project }));
    await writeFile(path.join(links, "harbor.json"), JSON.stringify({ kind: "godot", project }));
    await writeFile(path.join(links, "other.json"), JSON.stringify({ kind: "unreal", project }));
    await writeFile(path.join(links, "elsewhere.json"), JSON.stringify({ kind: "godot", project: "/x/project.godot" }));
    await writeFile(path.join(links, "broken.json"), "{");
    assert.deepEqual((await gamesLinkedTo(path.join(p.root, "storage"), p.project)).sort(), ["harbor", "lantern"]);
  });
});

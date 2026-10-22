import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  bridgeHome,
  findUnityProject,
  projectRecordFile,
  rememberedProject,
  rememberProject,
} from "../../src/plugins/unity/project-folder.ts";
import { tmpDir } from "../helpers/tmp.ts";

const VERSION_TEXT = "m_EditorVersion: 6000.6.0f1\nm_EditorVersionWithRevision: 6000.6.0f1 (abc123)\n";
const NOW = () => new Date("2026-10-13T10:00:00.000Z");

/** A temporary folder by its real path, as a game folder and the plugin's storage are handed over. */
const realTmp = async (prefix: string) => realpath(await tmpDir(prefix));

/** Writes the files Unity keeps in every project's `ProjectSettings`, making `root` a Unity project. */
async function makeProject(root: string, version = VERSION_TEXT): Promise<string> {
  await mkdir(path.join(root, "ProjectSettings"), { recursive: true });
  await writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), version);
  return root;
}

describe("a game's Unity project folder", () => {
  it("is the game folder itself when it holds ProjectSettings/ProjectVersion.txt", async () => {
    const game = await realTmp("unity-game-");
    await makeProject(game);
    assert.deepEqual(await findUnityProject(game), { root: game, game, editorVersion: "6000.6.0f1" });
  });

  it("is the unity folder before any other subfolder, and the first by name otherwise", async () => {
    const game = await realTmp("unity-game-");
    await makeProject(path.join(game, "alpha"));
    await makeProject(path.join(game, "beta"));
    assert.equal((await findUnityProject(game))?.root, path.join(game, "alpha"));
    await makeProject(path.join(game, "unity"));
    assert.equal((await findUnityProject(game))?.root, path.join(game, "unity"));
  });

  it("answers no editor version for a version file that names none", async () => {
    const game = await realTmp("unity-game-");
    await makeProject(game, "something else\n");
    assert.deepEqual(await findUnityProject(game), { root: game, game });
  });

  it("finds a project as deep as Genex finds the fact, and nothing in a folder with none or a missing one", async () => {
    const game = await realTmp("unity-game-");
    assert.equal(await findUnityProject(game), undefined);
    assert.equal(await findUnityProject(path.join(game, "gone")), undefined);
    await makeProject(path.join(game, "a", "b", "c", "d", "e"));
    assert.equal(await findUnityProject(game), undefined, "past the walk's depth");
    await makeProject(path.join(game, "deep", "deeper"));
    assert.equal((await findUnityProject(game))?.root, path.join(game, "deep", "deeper"));
  });

  it("is still found beside folders holding thousands of other files", async () => {
    const game = await realTmp("unity-game-");
    for (let folder = 0; folder < 50; folder++) {
      const shots = path.join(game, "docs", `proof-${folder}`);
      await mkdir(shots, { recursive: true });
      await Promise.all(Array.from({ length: 100 }, (_, shot) => writeFile(path.join(shots, `${shot}.png`), "")));
    }
    await makeProject(path.join(game, "unity"));
    assert.equal((await findUnityProject(game))?.root, path.join(game, "unity"));
  });

  it("never takes a project through a link, a hidden folder or node_modules", async () => {
    const outside = await makeProject(await realTmp("unity-outside-"));
    const hostile: Array<[string, (game: string) => Promise<unknown>]> = [
      ["a subfolder that is a link to a project elsewhere", (game) => symlink(outside, path.join(game, "unity"))],
      [
        "a ProjectSettings folder that is a link",
        (game) => symlink(path.join(outside, "ProjectSettings"), path.join(game, "ProjectSettings")),
      ],
      [
        "a version file that is a link",
        async (game) => {
          await mkdir(path.join(game, "ProjectSettings"));
          await symlink(
            path.join(outside, "ProjectSettings", "ProjectVersion.txt"),
            path.join(game, "ProjectSettings", "ProjectVersion.txt"),
          );
        },
      ],
      [
        "a version file that is a folder",
        (game) => mkdir(path.join(game, "ProjectSettings", "ProjectVersion.txt"), { recursive: true }),
      ],
      ["a project in a hidden folder", (game) => makeProject(path.join(game, ".cache"))],
      ["a project in node_modules", (game) => makeProject(path.join(game, "node_modules"))],
      ["a project in an engine's scratch folder", (game) => makeProject(path.join(game, "Library", "PackageCache"))],
    ];
    for (const [what, arrange] of hostile) {
      const game = await realTmp("unity-game-");
      await arrange(game);
      assert.equal(await findUnityProject(game), undefined, what);
    }
  });
});

describe("the record the editor connector reads", () => {
  it("keeps the project a game was found with, and gives it back while it is still one", async () => {
    const storage = await realTmp("unity-storage-");
    const root = await makeProject(await realTmp("unity-game-"));
    await rememberProject(storage, "lantern", { root, game: root, editorVersion: "6000.6.0f1" }, NOW);
    assert.deepEqual(JSON.parse(await readFile(projectRecordFile(storage, "lantern"), "utf8")), {
      root,
      game: root,
      editorVersion: "6000.6.0f1",
      foundAt: "2026-10-13T10:00:00.000Z",
    });
    assert.deepEqual(await rememberedProject(storage, "lantern"), { root, game: root });
    assert.equal(await rememberedProject(storage, "another"), undefined);
  });

  it("gives back the game's folder with a project inside it, and only a folder that holds the project", async () => {
    const storage = await realTmp("unity-storage-");
    const game = await realTmp("unity-game-");
    const root = await makeProject(path.join(game, "unity"));
    const elsewhere = await realTmp("unity-elsewhere-");
    const write = (record: unknown) => writeFile(projectRecordFile(storage, "lantern"), JSON.stringify(record));
    await rememberProject(storage, "lantern", await findUnityProject(game), NOW);
    assert.deepEqual(await rememberedProject(storage, "lantern"), { root, game });

    const notTheGame: Array<[string, unknown]> = [
      ["a folder that does not hold the project", elsewhere],
      ["a folder below the project", path.join(root, "ProjectSettings")],
      ["a folder with a .. part", `${root}/..`],
      ["a relative folder", ".."],
      ["a folder that is gone", path.join(game, "gone")],
      ["no folder", undefined],
      ["a folder that is not text", 7],
    ];
    for (const [what, folder] of notTheGame) {
      await write({ root, game: folder });
      assert.deepEqual(await rememberedProject(storage, "lantern"), { root, game: root }, what);
    }
  });

  it("forgets the project of a game found with none", async () => {
    const storage = await realTmp("unity-storage-");
    const root = await makeProject(await realTmp("unity-game-"));
    await rememberProject(storage, "lantern", { root, game: root }, NOW);
    await rememberProject(storage, "lantern", undefined, NOW);
    assert.equal(await rememberedProject(storage, "lantern"), undefined);
    await rememberProject(storage, "lantern", undefined, NOW);
  });

  it("believes a record only while its folder is still that project by real path", async () => {
    const storage = await realTmp("unity-storage-");
    const root = await makeProject(await realTmp("unity-game-"));
    const elsewhere = await makeProject(await realTmp("unity-elsewhere-"));
    const link = path.join(await realTmp("unity-links-"), "project");
    await symlink(elsewhere, link);
    const write = (record: unknown) => writeFile(projectRecordFile(storage, "lantern"), JSON.stringify(record));
    await rememberProject(storage, "lantern", { root, game: root }, NOW);

    const unbelieved: Array<[string, unknown]> = [
      ["a relative folder", { root: "unity" }],
      ["a folder with a .. part", { root: `${root}/../${path.basename(elsewhere)}` }],
      ["a folder reached through a link", { root: link }],
      ["a folder that is no project", { root: path.dirname(root) }],
      ["no folder at all", { foundAt: "2026-10-13T10:00:00.000Z" }],
      ["a folder that is not text", { root: 7 }],
      ["a record that is a list", [root]],
    ];
    for (const [what, record] of unbelieved) {
      await write(record);
      assert.equal(await rememberedProject(storage, "lantern"), undefined, what);
    }
    await writeFile(projectRecordFile(storage, "lantern"), "{ not json");
    assert.equal(await rememberedProject(storage, "lantern"), undefined, "a record that does not parse");

    await write({ root });
    assert.deepEqual(await rememberedProject(storage, "lantern"), { root, game: root });
    await rm(path.join(root, "ProjectSettings"), { recursive: true });
    assert.equal(await rememberedProject(storage, "lantern"), undefined, "a project that is gone");
  });

  it("is read by a connector that knows its game from its own folder in the plugin's storage", async () => {
    const storage = await realTmp("unity-storage-");
    const root = await makeProject(await realTmp("unity-game-"));
    await rememberProject(storage, "lantern", { root, game: root }, NOW);
    const home = bridgeHome(path.join(storage, "mcp", "lantern"));
    assert.deepEqual(home, { storage, game: "lantern" });
    assert.deepEqual(await rememberedProject(home.storage, home.game), { root, game: root });
    assert.deepEqual(bridgeHome(path.join(storage, "mcp", "_shared")), { storage });
  });

  it("names a record only for a plain game id, and writes nothing for any other", async () => {
    const storage = await realTmp("unity-storage-");
    const root = await makeProject(await realTmp("unity-game-"));
    for (const game of ["../escape", "a/b", "", ".", "with space", "x".repeat(101)]) {
      await assert.rejects(rememberProject(storage, game, { root, game: root }, NOW), /Invalid game/, game);
      assert.equal(await rememberedProject(storage, game), undefined, game);
    }
    assert.equal(await rememberedProject(storage, undefined), undefined);
    assert.deepEqual(await readFile(path.join(storage, "escape.json"), "utf8").catch(() => null), null);
  });
});

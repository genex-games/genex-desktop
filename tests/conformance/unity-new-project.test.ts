import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createProject, NewProjectRefusal, newProjectDependencies } from "../../src/plugins/unity/new-project.ts";
import { PIPELINE_VERSION } from "../../src/plugins/unity/pipeline.ts";
import { findUnityProject } from "../../src/plugins/unity/project-folder.ts";
import {
  pipelineVersionOf,
  type SetupPlace,
  SetupRefusal,
  setUpProject,
  undoSetup,
} from "../../src/plugins/unity/setup.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { fakeEditor, macEnv, unityProject } from "../helpers/unity-editor-stand-in.ts";

const NOW = () => new Date("2026-10-14T09:00:00.000Z");
const realTmp = async (prefix: string) => realpath(await tmpDir(prefix));

/** An installed Unity 6 that ships physics, audio and the UI package, and no cloth. */
async function editor() {
  const env = await macEnv();
  return fakeEditor(path.join(env.applications, "Unity", "Hub", "Editor"), "6000.3.10f1", {
    "com.unity.modules.physics": null,
    "com.unity.modules.audio": null,
    "com.unity.modules.hierarchycore": null,
    "com.unity.ugui": "2.0.0",
    "com.unity.render-pipelines.universal": "17.3.0",
  });
}

const refusal = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

describe("a new game's Unity project", () => {
  it("is an empty project for the installed editor, asking for Pipeline and the modules that editor ships", async () => {
    const game = await realTmp("unity-game-");
    const made = await createProject(game, await editor(), "darwin");
    const root = path.join(game, "unity");
    assert.deepEqual(made, { root, game, editorVersion: "6000.3.10f1" });
    assert.deepEqual(await findUnityProject(game), made);
    assert.deepEqual((await readdir(root)).sort(), ["Assets", "Packages", "ProjectSettings"]);
    assert.equal(
      await readFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "utf8"),
      "m_EditorVersion: 6000.3.10f1\n",
    );
    const manifest = await readFile(path.join(root, "Packages", "manifest.json"), "utf8");
    assert.deepEqual(JSON.parse(manifest), {
      dependencies: {
        "com.unity.modules.audio": "1.0.0",
        "com.unity.modules.physics": "1.0.0",
        "com.unity.pipeline": PIPELINE_VERSION,
        "com.unity.ugui": "2.0.0",
      },
    });
    assert.ok(manifest.endsWith("}\n"));
    assert.deepEqual(await readdir(game), ["unity"], "nothing is left beside the project");
  });

  it("asks for every standard module when what the editor ships can't be read", async () => {
    const dependencies = await newProjectDependencies({ version: "6000.0.26f1", app: "/nowhere/Unity.app" }, "darwin");
    const names = Object.keys(dependencies);
    assert.equal(dependencies["com.unity.pipeline"], PIPELINE_VERSION);
    for (const module of ["physics", "physics2d", "audio", "animation", "ui", "particlesystem", "terrain"])
      assert.equal(dependencies[`com.unity.modules.${module}`], "1.0.0", module);
    assert.equal(dependencies["com.unity.ugui"], undefined, "no version is guessed for a package");
    assert.deepEqual(names, [...names].sort());
  });

  it("refuses a game that already holds a project or whose place is taken, changing nothing", async () => {
    const installed = await editor();
    const outside = await realTmp("unity-outside-");
    const taken: Array<[string, (game: string) => Promise<unknown>, string]> = [
      [
        "a Unity project at the game's root",
        (game) => unityProject().then((p) => copyProject(p, game)),
        NewProjectRefusal.HasProject,
      ],
      [
        "a Unity project elsewhere in the game",
        (game) => unityProject().then((p) => copyProject(p, path.join(game, "old"))),
        NewProjectRefusal.HasProject,
      ],
      ["a folder named unity", (game) => mkdir(path.join(game, "unity")), NewProjectRefusal.PlaceTaken],
      ["a file named unity", (game) => writeFile(path.join(game, "unity"), "notes"), NewProjectRefusal.PlaceTaken],
      ["a link named unity", (game) => symlink(outside, path.join(game, "unity")), NewProjectRefusal.PlaceTaken],
      [
        "a link named unity that leads nowhere",
        (game) => symlink(path.join(outside, "gone"), path.join(game, "unity")),
        NewProjectRefusal.PlaceTaken,
      ],
    ];
    for (const [what, arrange, code] of taken) {
      const game = await realTmp("unity-game-");
      await arrange(game);
      const before = (await readdir(game, { recursive: true })).sort();
      await assert.rejects(createProject(game, installed, "darwin"), refusal(code), what);
      assert.deepEqual((await readdir(game, { recursive: true })).sort(), before, what);
    }
    assert.deepEqual(await readdir(outside), [], "nothing was made through the link");
  });
});

/** Writes the files that make `to` a Unity project, as the helper's own project has them. */
async function copyProject(from: string, to: string): Promise<void> {
  await mkdir(path.join(to, "ProjectSettings"), { recursive: true });
  await writeFile(
    path.join(to, "ProjectSettings", "ProjectVersion.txt"),
    await readFile(path.join(from, "ProjectSettings", "ProjectVersion.txt")),
  );
}

/** An existing Unity 6 project with a manifest of its own, and the plugin's storage. */
async function existing(
  manifest: unknown = {
    dependencies: { "com.unity.ugui": "2.0.0", "com.unity.cinemachine": "3.1.2" },
    scopedRegistries: [],
  },
) {
  const root = await unityProject();
  const storage = await realTmp("unity-storage-");
  await mkdir(path.join(root, "Packages"));
  const file = path.join(root, "Packages", "manifest.json");
  await writeFile(file, typeof manifest === "string" ? manifest : `${JSON.stringify(manifest, null, 2)}\n`);
  const place = { root, editorVersion: "6000.6.0f1", storage, game: "lantern" };
  return { place, file, read: async () => JSON.parse(await readFile(file, "utf8")) };
}

describe("setting an existing Unity project up", () => {
  it("adds the Pipeline package to the manifest and keeps the rest, with a copy of the manifest as it was", async () => {
    const { place, file, read } = await existing();
    const before = await readFile(file, "utf8");
    assert.equal(await pipelineVersionOf(place.root), undefined);
    assert.deepEqual(await setUpProject(place, NOW), { changed: true, version: PIPELINE_VERSION });
    assert.deepEqual(await read(), {
      dependencies: {
        "com.unity.cinemachine": "3.1.2",
        "com.unity.pipeline": PIPELINE_VERSION,
        "com.unity.ugui": "2.0.0",
      },
      scopedRegistries: [],
    });
    assert.equal(await pipelineVersionOf(place.root), PIPELINE_VERSION);
    assert.equal(await readFile(path.join(place.storage, "setup", "lantern", "manifest.json"), "utf8"), before);
    assert.deepEqual(
      await setUpProject(place, NOW),
      { changed: false, version: PIPELINE_VERSION },
      "a second setup changes nothing",
    );
  });

  it("leaves a project that already asks for the package as it is, whatever version it asks for", async () => {
    const { place, file } = await existing({ dependencies: { "com.unity.pipeline": "0.6.0-exp.1" } });
    const before = await readFile(file, "utf8");
    assert.deepEqual(await setUpProject(place, NOW), { changed: false, version: "0.6.0-exp.1" });
    assert.equal(await readFile(file, "utf8"), before);
    assert.deepEqual(await undoSetup(place), { changed: false }, "Genex added nothing, so Undo takes nothing back");
    assert.equal(await readFile(file, "utf8"), before);
  });

  it("takes back exactly the line it added, and only while it is still as Genex wrote it", async () => {
    const mine = await existing();
    await setUpProject(mine.place, NOW);
    assert.deepEqual(await undoSetup(mine.place), { changed: true });
    assert.deepEqual(await mine.read(), {
      dependencies: { "com.unity.cinemachine": "3.1.2", "com.unity.ugui": "2.0.0" },
      scopedRegistries: [],
    });
    assert.deepEqual(await undoSetup(mine.place), { changed: false }, "a second Undo has nothing left to take back");

    const changed = await existing();
    await setUpProject(changed.place, NOW);
    const manifest = await changed.read();
    manifest.dependencies["com.unity.pipeline"] = "0.9.0-exp.1";
    manifest.dependencies["com.unity.inputsystem"] = "1.14.0";
    await writeFile(changed.file, JSON.stringify(manifest));
    assert.deepEqual(await undoSetup(changed.place), { changed: false });
    assert.equal(
      (await changed.read()).dependencies["com.unity.pipeline"],
      "0.9.0-exp.1",
      "the person's version stays",
    );

    const other = await existing();
    await setUpProject(other.place, NOW);
    const moved = { ...other.place, root: (await existing()).place.root };
    assert.deepEqual(
      await undoSetup(moved),
      { changed: false },
      "a record of another project's setup changes nothing here",
    );
  });

  it("refuses what it can't change safely, writing nothing", async () => {
    const outside = await existing();
    const refused: Array<[string, () => Promise<{ place: SetupPlace }>, string]> = [
      [
        "a project older than Unity 6",
        async () => ({ place: { ...(await existing()).place, editorVersion: "2022.3.13f1" } }),
        SetupRefusal.NeedsUnity6,
      ],
      [
        "a project whose editor is unknown",
        async () => ({ place: { ...(await existing()).place, editorVersion: undefined } }),
        SetupRefusal.NeedsUnity6,
      ],
      ["a manifest that is not JSON", () => existing("{ nope"), SetupRefusal.Unreadable],
      ["a manifest that is a list", () => existing([1]), SetupRefusal.Unreadable],
      ["dependencies that are no object", () => existing({ dependencies: ["x"] }), SetupRefusal.Unreadable],
      [
        "a game id that is a path",
        async () => ({ place: { ...(await existing()).place, game: "../escape" } }),
        SetupRefusal.InvalidGame,
      ],
      [
        "no manifest at all",
        async () => ({
          place: {
            root: await unityProject(),
            editorVersion: "6000.6.0f1",
            storage: await realTmp("unity-storage-"),
            game: "lantern",
          },
        }),
        SetupRefusal.NoManifest,
      ],
      [
        "a manifest that is a link out of the project",
        async () => {
          const root = await unityProject();
          await mkdir(path.join(root, "Packages"));
          await symlink(outside.file, path.join(root, "Packages", "manifest.json"));
          return {
            place: { root, editorVersion: "6000.6.0f1", storage: await realTmp("unity-storage-"), game: "lantern" },
          };
        },
        SetupRefusal.Unreadable,
      ],
      [
        "a Packages folder that is a link out of the project",
        async () => {
          const root = await unityProject();
          await symlink(path.dirname(outside.file), path.join(root, "Packages"));
          return {
            place: { root, editorVersion: "6000.6.0f1", storage: await realTmp("unity-storage-"), game: "lantern" },
          };
        },
        SetupRefusal.Unreadable,
      ],
    ];
    const untouched = await readFile(outside.file, "utf8");
    for (const [what, arrange, code] of refused) {
      const { place } = await arrange();
      await assert.rejects(setUpProject(place, NOW), refusal(code), what);
      assert.deepEqual(await readdir(place.storage).catch(() => []), [], `${what}: nothing is kept`);
    }
    assert.equal(await readFile(outside.file, "utf8"), untouched, "nothing was written through a link");
  });
});

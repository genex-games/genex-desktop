import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  compareVersions,
  type EditorsEnv,
  editorFolders,
  findEditors,
  isUnity6,
  shippedPackages,
} from "../../src/plugins/unity/editors.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { fakeEditor, macEnv } from "../helpers/unity-editor-stand-in.ts";

describe("Unity versions", () => {
  it("orders versions the later one first, release kind and number included", () => {
    const versions = [
      "2022.3.13f1",
      "6000.3.10f1",
      "6000.0.26f1",
      "6000.3.10b2",
      "6000.3.9f2",
      "6000.6.0a4",
      "nonsense",
    ];
    assert.deepEqual([...versions].sort(compareVersions), [
      "6000.6.0a4",
      "6000.3.10f1",
      "6000.3.10b2",
      "6000.3.9f2",
      "6000.0.26f1",
      "2022.3.13f1",
      "nonsense",
    ]);
  });

  it("knows Unity 6 and later from what came before", () => {
    for (const version of ["6000.0.0f1", "6000.3.10f1", "6001.0.0a1"]) assert.equal(isUnity6(version), true, version);
    for (const version of ["2022.3.13f1", "2023.2.20f1", "6", "", undefined]) assert.equal(isUnity6(version), false);
  });
});

describe("the Unity editors installed on this computer", () => {
  it("finds editors in Hub's own folder and in the one the person chose, newest first, each version once", async () => {
    const env = await macEnv();
    const own = path.join(env.applications, "Unity", "Hub", "Editor");
    const chosen = path.join(env.home, "Unity3D");
    await fakeEditor(own, "6000.0.26f1");
    await fakeEditor(own, "2022.3.13f1");
    await fakeEditor(chosen, "6000.3.10f1");
    await fakeEditor(chosen, "6000.0.26f1");
    await writeFile(
      path.join(env.home, "Library", "Application Support", "UnityHub", "secondaryInstallPath.json"),
      JSON.stringify(chosen),
    );

    assert.deepEqual(await editorFolders(env), [own, chosen]);
    assert.deepEqual(await findEditors(env), [
      { version: "6000.3.10f1", app: path.join(chosen, "6000.3.10f1", "Unity.app") },
      { version: "6000.0.26f1", app: path.join(own, "6000.0.26f1", "Unity.app") },
      { version: "2022.3.13f1", app: path.join(own, "2022.3.13f1", "Unity.app") },
    ]);
  });

  it("lists nothing that is not an editor in a folder named by its version", async () => {
    const env = await macEnv();
    const own = path.join(env.applications, "Unity", "Hub", "Editor");
    const real = await fakeEditor(await realpath(await tmpDir("unity-elsewhere-")), "6000.3.10f1");
    await mkdir(path.join(own, "6000.3.10f1"), { recursive: true });
    await symlink(real.app, path.join(own, "6000.3.10f1", "Unity.app"));
    await mkdir(path.join(own, "6000.1.0f1"), { recursive: true });
    await writeFile(path.join(own, "6000.1.0f1", "Unity.app"), "a file, not an app");
    await mkdir(path.join(own, "latest", "Unity.app"), { recursive: true });
    await mkdir(path.join(own, "6000.2.0f1"), { recursive: true });
    assert.deepEqual(await findEditors(env), []);
    assert.deepEqual(await findEditors({ ...env, platform: "linux" }), []);
  });

  it("believes Hub's record of the person's folder only when it names a folder plainly", async () => {
    const env = await macEnv();
    const own = path.join(env.applications, "Unity", "Hub", "Editor");
    const record = path.join(env.home, "Library", "Application Support", "UnityHub", "secondaryInstallPath.json");
    const unbelieved: Array<[string, string]> = [
      ["a relative folder", JSON.stringify("Unity3D")],
      ["a folder with a .. part", JSON.stringify(`${env.home}/../elsewhere`)],
      ["an object", JSON.stringify({ path: env.home })],
      ["an empty string", JSON.stringify("")],
      ["text that is not JSON", "/Users/someone"],
    ];
    for (const [what, text] of unbelieved) {
      await writeFile(record, text);
      assert.deepEqual(await editorFolders(env), [own], what);
    }
  });

  it("spells Windows's folders its own way", async () => {
    const env: EditorsEnv = {
      platform: "win32",
      home: "C:\\Users\\Ada",
      applications: "C:\\Program Files",
      appData: "C:\\Users\\Ada\\AppData\\Roaming",
    };
    assert.deepEqual(await editorFolders(env), ["C:\\Program Files\\Unity\\Hub\\Editor"]);
  });

  it("reads which packages an editor ships, with the versions they name", async () => {
    const env = await macEnv();
    const editor = await fakeEditor(path.join(env.applications, "Unity", "Hub", "Editor"), "6000.3.10f1", {
      "com.unity.modules.physics": null,
      "com.unity.modules.audio": null,
      "com.unity.ugui": "2.0.0",
    });
    assert.deepEqual([...((await shippedPackages(editor, "darwin")) ?? [])].sort(), [
      ["com.unity.modules.audio", "1.0.0"],
      ["com.unity.modules.physics", "1.0.0"],
      ["com.unity.ugui", "2.0.0"],
    ]);
    assert.equal(
      await shippedPackages({ version: "6000.3.10f1", app: path.join(env.home, "gone.app") }, "darwin"),
      undefined,
    );
  });
});

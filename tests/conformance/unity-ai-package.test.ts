/**
 * Genex's play-time AI package for Unity (`com.genex.ai`) embedded in a game's Unity project:
 * `Packages/com.genex.ai/`, every file as shipped, a file the person changed kept beside it as
 * `.mine~`, nothing written through a link, and the agent's `unity__add-ai` tool doing exactly that.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { AI_PACKAGE, AiPackageRefusal, aiPackageState, embedAiPackage } from "../../src/plugins/unity/ai-package.ts";
import { UnityTool } from "../../src/plugins/unity/backend.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { backendOn, withProject } from "../helpers/unity-backend.ts";
import { unityProject } from "../helpers/unity-editor-stand-in.ts";

const UNITY_6 = "6000.6.0f1";

const SHIPPED = path.resolve("src/plugins/unity/packages", AI_PACKAGE);

/** A Unity project Unity has opened once: it has its Packages folder. */
async function openedProject(): Promise<string> {
  const root = await unityProject("unity-ai-package-");
  await mkdir(path.join(root, "Packages"));
  await writeFile(path.join(root, "Packages", "manifest.json"), '{"dependencies":{}}\n');
  return root;
}

async function filesUnder(folder: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) out.push(...(await filesUnder(path.join(folder, entry.name), `${name}/`)));
    else out.push(name);
  }
  return out.sort();
}

describe("Genex's AI package in a Unity project", () => {
  it("embeds every shipped file, and says the project is current after", async () => {
    const root = await openedProject();
    assert.equal(await aiPackageState(root, SHIPPED), "missing");
    assert.deepEqual(await embedAiPackage(root, SHIPPED), { changed: true, kept: [] });
    const embedded = path.join(root, "Packages", AI_PACKAGE);
    assert.deepEqual(await filesUnder(embedded), await filesUnder(SHIPPED));
    for (const file of await filesUnder(SHIPPED))
      assert.equal(await readFile(path.join(embedded, file), "utf8"), await readFile(path.join(SHIPPED, file), "utf8"));
    assert.equal(await aiPackageState(root, SHIPPED), "current");
    assert.deepEqual(
      await embedAiPackage(root, SHIPPED),
      { changed: false, kept: [] },
      "a second time changes nothing",
    );
  });

  it("keeps a file the person changed beside the shipped one as .mine~ (a name Unity never imports), and leaves their own files", async () => {
    const root = await openedProject();
    await embedAiPackage(root, SHIPPED);
    const embedded = path.join(root, "Packages", AI_PACKAGE);
    await writeFile(path.join(embedded, "Runtime", "GenexAi.cs"), "// mine\n");
    await writeFile(path.join(embedded, "Runtime", "Mine.cs"), "// theirs\n");
    assert.equal(await aiPackageState(root, SHIPPED), "outdated");
    assert.deepEqual(await embedAiPackage(root, SHIPPED), { changed: true, kept: ["Runtime/GenexAi.cs"] });
    assert.equal(await readFile(path.join(embedded, "Runtime", "GenexAi.cs.mine~"), "utf8"), "// mine\n");
    assert.equal(await readFile(path.join(embedded, "Runtime", "Mine.cs"), "utf8"), "// theirs\n");
  });

  const links: Array<[string, (root: string, outside: string) => Promise<void>]> = [
    ["the Packages folder", async (root, outside) => symlink(outside, path.join(root, "Packages"))],
    [
      "the package's folder",
      async (root, outside) => {
        await mkdir(path.join(root, "Packages"));
        await symlink(outside, path.join(root, "Packages", AI_PACKAGE));
      },
    ],
    [
      "its Runtime folder",
      async (root, outside) => {
        await mkdir(path.join(root, "Packages", AI_PACKAGE), { recursive: true });
        await symlink(outside, path.join(root, "Packages", AI_PACKAGE, "Runtime"));
      },
    ],
    [
      "one of its files",
      async (root, outside) => {
        await mkdir(path.join(root, "Packages", AI_PACKAGE), { recursive: true });
        await symlink(path.join(outside, "victim.txt"), path.join(root, "Packages", AI_PACKAGE, "package.json"));
      },
    ],
  ];
  for (const [name, plant] of links) {
    it(`writes nothing through a link: ${name}`, async () => {
      const root = await unityProject("unity-ai-package-link-");
      const outside = await realpath(await tmpDir("unity-ai-package-outside-"));
      await writeFile(path.join(outside, "victim.txt"), "untouched");
      await plant(root, outside);
      await assert.rejects(embedAiPackage(root, SHIPPED), (error: Error & { code?: string }) => {
        assert.equal(error.code, AiPackageRefusal.Link);
        return true;
      });
      assert.deepEqual(await readdir(outside), ["victim.txt"]);
      assert.equal(await readFile(path.join(outside, "victim.txt"), "utf8"), "untouched");
    });
  }

  it("refuses a project Unity has never opened: it has no Packages folder", async () => {
    const root = await unityProject("unity-ai-package-new-");
    await assert.rejects(embedAiPackage(root, SHIPPED), (error: Error & { code?: string }) => {
      assert.equal(error.code, AiPackageRefusal.NoPackages);
      return true;
    });
    assert.deepEqual((await readdir(root)).sort(), ["ProjectSettings"]);
  });

  it("unity__add-ai embeds it in the open game's Unity project and says how a game uses it", async () => {
    const { call, game } = await backendOn([UNITY_6]);
    const root = await withProject(game, UNITY_6);
    const said = String(await call(UnityTool.AddAi));
    assert.match(said, /com\.genex\.ai/);
    assert.match(said, /GenexAi\.Drain/);
    assert.equal(await aiPackageState(root, SHIPPED), "current");
  });

  it("unity__add-ai refuses a game with no Unity project, writing nothing", async () => {
    const { call, game } = await backendOn([UNITY_6]);
    await assert.rejects(Promise.resolve(call(UnityTool.AddAi)), /no Unity project/);
    assert.deepEqual(await readdir(game), []);
  });
});

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
import { tmpDir } from "../helpers/tmp.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { copyProject, Project, TOY_PLUGIN, TOY_PLUGIN_ID } from "../helpers/project-fixtures.ts";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import { joinProjectAssets, readContainedImage, readGenexJobs, walkGameAssets } from "../../src/main/game-assets.ts";
import { assetKind, isAudioFile } from "../../src/shared/game-assets.ts";
import { DEFAULT_ASSET_FOLDERS, isAssetPath } from "../../src/shared/project-workspace.ts";
import { isImageFile } from "../../src/substrate/game-workspace.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";

const JOB_A = "11111111-1111-1111-1111-111111111111";
const JOB_B = "22222222-2222-2222-2222-222222222222";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A game with one file of every shape the walk has an opinion about. */
async function game(): Promise<string> {
  const root = path.join(await tmpDir("studio-assets-"), "game");
  for (const dir of ["assets/genex/" + JOB_A, "assets/foo/" + JOB_B, "assets/src", "public/assets", "outside"]) {
    await mkdir(path.join(root, ...dir.split("/")), { recursive: true });
  }
  await writeFile(path.join(root, "assets/genex", JOB_A, "a.png"), PNG);
  await writeFile(path.join(root, "assets/foo", JOB_B, "b.png"), PNG);
  await writeFile(path.join(root, "assets/barn.glb"), "glb");
  await writeFile(path.join(root, "assets/hand.mp3"), "mp3");
  await writeFile(path.join(root, "assets/src/tree.py"), "import bpy");
  await writeFile(path.join(root, "assets/README.md"), "# notes");
  await writeFile(path.join(root, "assets/.hidden"), "x");
  await writeFile(path.join(root, "public/assets/x.png"), PNG);
  await writeFile(path.join(root, "outside/secret.png"), PNG);
  await symlink(path.join(root, "outside"), path.join(root, "assets/escape"));
  // Fixed file times so the ordering assertions test the join's precedence, not the clock.
  const when = new Date("2020-01-01T00:00:00.000Z");
  for (const file of [
    "assets/genex/" + JOB_A + "/a.png",
    "assets/foo/" + JOB_B + "/b.png",
    "assets/barn.glb",
    "assets/hand.mp3",
    "public/assets/x.png",
  ]) {
    await utimes(path.join(root, ...file.split("/")), when, when);
  }
  return root;
}

const custom = (event_type: string, payload: unknown): EventEnvelope => ({
  id: `e-${event_type}-${Math.random()}`,
  thread_id: "t1",
  session_id: null,
  turn_id: null,
  created_at: "2026-09-18T10:00:00.000Z",
  data: { type: "custom", event_type, payload },
});

it("the walk lists the game's own assets and refuses to follow anything that leaves it", async () => {
  const root = await game();
  const walk = await walkGameAssets(root);
  assert.deepEqual(
    walk.entries.map((e) => e.file),
    [
      "assets/barn.glb",
      `assets/foo/${JOB_B}/b.png`,
      `assets/genex/${JOB_A}/a.png`,
      "assets/hand.mp3",
      "public/assets/x.png",
    ],
  );
  assert.deepEqual(walk.skipped, [{ file: "assets/escape", why: "symlink" }]);
  assert.equal(walk.truncated, false);
  assert.equal(
    walk.entries.every((e) => e.bytes > 0 && e.mtime === "2020-01-01T00:00:00.000Z"),
    true,
  );
  // The link is reported and the walk carries on: one hostile link must not hide the folder.
  assert.ok(walk.entries.some((e) => e.file === "assets/hand.mp3"));
  const capped = await walkGameAssets(root, { maxEntries: 2 });
  assert.equal(capped.truncated, true);
  assert.ok(capped.entries.length <= 2);
  // Depth bounds how far the walk nests: the asset folders themselves are depth 1.
  const shallow = await walkGameAssets(root, { maxDepth: 1 });
  assert.equal(shallow.truncated, true);
  assert.deepEqual(
    shallow.entries.map((e) => e.file),
    ["assets/barn.glb", "assets/hand.mp3", "public/assets/x.png"],
  );
  assert.deepEqual(await walkGameAssets(path.join(root, "nowhere")), { entries: [], truncated: false, skipped: [] });
});

it("a symlinked asset root is reported and never walked, so a link cannot lend another folder to this game", async () => {
  const root = await game();
  // `public/assets` is replaced by a link to a folder outside the game; `assets/` stays real.
  await rm(path.join(root, "public/assets"), { recursive: true, force: true });
  await symlink(path.join(root, "outside"), path.join(root, "public/assets"));
  const walk = await walkGameAssets(root);
  assert.deepEqual(walk.skipped, [
    { file: "assets/escape", why: "symlink" },
    { file: "public/assets", why: "symlink" },
  ]);
  assert.equal(
    walk.entries.some((e) => e.file.startsWith("public/assets/")),
    false,
    "nothing behind the link is listed, not even its names",
  );
  assert.deepEqual(
    walk.entries.map((e) => e.file),
    ["assets/barn.glb", `assets/foo/${JOB_B}/b.png`, `assets/genex/${JOB_A}/a.png`, "assets/hand.mp3"],
    "and the game's own folder is still read in full",
  );
  assert.equal(walk.truncated, false);
});

it("the join names where each file came from, in the order the ledger and the records allow", async () => {
  const root = await game();
  const walk = await walkGameAssets(root);
  const ledger = [
    custom("asset_delivered", {
      project: "farm",
      source: "genex",
      pluginId: "genex",
      jobId: JOB_A,
      files: [{ file: `assets/genex/${JOB_A}/a.png`, bytes: PNG.length, kind: "image" }],
      at: "2026-09-18T12:00:00.000Z",
      runId: "run-1",
      facetId: "world",
      iteration: 2,
    }),
    custom("blender_asset", {
      project: "farm",
      name: "barn",
      file: "assets/barn.glb",
      ok: true,
      render: "/runs/run-1/barn-1.png",
      renderFront: "/runs/run-1/barn-1-front.png",
      runId: "run-1",
      facetId: "world",
      iteration: 1,
      at: "2026-09-18T11:00:00.000Z",
    }),
    // Another game's delivery, sitting in the same Studio thread: it must not touch this project.
    custom("asset_delivered", {
      project: "other",
      source: "genex",
      jobId: JOB_B,
      files: [{ file: "assets/hand.mp3", bytes: 3, kind: "audio" }],
      at: "2026-09-18T23:00:00.000Z",
    }),
    // A record for a file nobody can find: the walk is the truth about existence.
    custom("asset_delivered", {
      project: "farm",
      source: "genex",
      jobId: JOB_A,
      files: [{ file: "assets/genex/gone.png", bytes: 1, kind: "image" }],
      at: "2026-09-18T13:00:00.000Z",
    }),
  ];
  const jobs = [
    {
      id: JOB_A,
      files: [`assets/genex/${JOB_A}/a.png`],
      operation: "image",
      status: "downloaded",
      prompt: "a barn at dusk",
      createdAt: "2026-09-18T09:00:00.000Z",
      use: { stage: "integrated" as const },
    },
  ];
  const joined = joinProjectAssets({
    project: "farm",
    entries: walk.entries,
    ledger,
    jobs,
    truncated: walk.truncated,
    skipped: walk.skipped,
  });
  const by = (file: string) => joined.assets.find((a) => a.file === file)!;
  assert.equal(joined.assets.length, 5);
  assert.equal(
    joined.assets.some((a) => a.file === "assets/genex/gone.png"),
    false,
  );

  const a = by(`assets/genex/${JOB_A}/a.png`);
  assert.equal(a.source, "genex");
  assert.equal(a.jobId, JOB_A);
  assert.equal(a.kind, "image");
  assert.equal(a.operation, "image");
  assert.equal(a.pluginStatus, "downloaded");
  assert.equal(a.prompt, "a barn at dusk");
  assert.deepEqual(a.use, { stage: "integrated" });
  assert.equal(a.runId, "run-1");
  assert.equal(a.facetId, "world");
  assert.equal(a.iteration, 2);

  const barn = by("assets/barn.glb");
  assert.equal(barn.source, "blender");
  assert.equal(barn.kind, "model");
  assert.equal(barn.jobId, "barn");
  assert.equal(barn.render, "/runs/run-1/barn-1.png");
  assert.equal(barn.renderFront, "/runs/run-1/barn-1-front.png");

  // The other project's event claimed this file; it stays an imported drop-in.
  assert.equal(by("assets/hand.mp3").source, "imported");
  assert.equal(by("assets/hand.mp3").kind, "audio");
  assert.equal(by("public/assets/x.png").source, "imported");
  // Nothing in the ledger, nothing in the records: the shape a delivery leaves behind is inference.
  assert.equal(by(`assets/foo/${JOB_B}/b.png`).source, "foo");
  assert.equal(by(`assets/foo/${JOB_B}/b.png`).jobId, JOB_B);
  assert.equal(by(`assets/foo/${JOB_B}/b.png`).pluginStatus, undefined);

  // Newest first by when it was delivered, falling back to the file's own time, then by path.
  assert.deepEqual(
    joined.assets.map((x) => x.file),
    [
      `assets/genex/${JOB_A}/a.png`,
      "assets/barn.glb",
      `assets/foo/${JOB_B}/b.png`,
      "assets/hand.mp3",
      "public/assets/x.png",
    ],
  );
  assert.equal(joined.project, "farm");
  assert.deepEqual(joined.skipped, [{ file: "assets/escape", why: "symlink" }]);
});

it("Genex job records are read without being written, and an approval never leaves the folder", async () => {
  const homes = await tmpDir("studio-homes-");
  const jobs = path.join(homes, "genex", "projects", "farm", "jobs");
  const good = path.join(jobs, JOB_A);
  await mkdir(good, { recursive: true });
  await writeFile(
    path.join(good, "job.json"),
    JSON.stringify({
      id: JOB_A,
      project: "farm",
      operation: "image",
      status: "downloaded",
      files: [`assets/genex/${JOB_A}/a.png`],
      createdAt: "2026-09-18T09:00:00.000Z",
      approval: { images: ["AAAA"] },
    }),
  );
  await writeFile(path.join(good, "request.json"), JSON.stringify({ prompt: "p".repeat(900) }));
  // A record naming another project, a folder that is not a job id, and a link out of the folder.
  const wrong = path.join(jobs, JOB_B);
  await mkdir(wrong, { recursive: true });
  await writeFile(path.join(wrong, "job.json"), JSON.stringify({ id: JOB_B, project: "other", files: [] }));
  await mkdir(path.join(jobs, "not-a-uuid"), { recursive: true });
  await writeFile(
    path.join(jobs, "not-a-uuid", "job.json"),
    JSON.stringify({ id: "not-a-uuid", project: "farm", files: [] }),
  );
  const linked = path.join(jobs, "33333333-3333-3333-3333-333333333333");
  await mkdir(linked, { recursive: true });
  await symlink(
    path.join(homes, "genex", "projects", "farm", "jobs", JOB_A, "job.json"),
    path.join(linked, "job.json"),
  );

  const before = await readdir(jobs);
  const beforeMtime = (await stat(path.join(good, "job.json"))).mtimeMs;
  const records = await readGenexJobs(homes, "farm");
  assert.deepEqual(
    records.map((r) => r.id),
    [JOB_A],
  );
  assert.equal(records[0]!.operation, "image");
  assert.equal(records[0]!.prompt!.length, 900, "a prompt within the cap is kept whole, for the card's tooltip");
  assert.equal("approval" in records[0]!, false);
  assert.equal(JSON.stringify(records).includes("AAAA"), false);
  assert.deepEqual(await readdir(jobs), before);
  assert.equal((await stat(path.join(good, "job.json"))).mtimeMs, beforeMtime);
  assert.deepEqual(await readGenexJobs(homes, "../escape"), []);
  assert.deepEqual(await readGenexJobs(homes, "never-a-project"), []);
});

it("the contained reader refuses everything that is not an image inside the game's asset folders", async () => {
  const root = await game();
  const ok = await readContainedImage(root, `assets/genex/${JOB_A}/a.png`);
  assert.equal(ok?.mimeType, "image/png");
  assert.equal(Buffer.from(ok!.data, "base64").length, PNG.length);
  assert.equal(await readContainedImage(root, "../x.png"), null);
  assert.equal(await readContainedImage(root, "/etc/hosts.png"), null);
  assert.equal(await readContainedImage(root, "src/main.png"), null, "outside the asset prefixes");
  assert.equal(await readContainedImage(root, "assets/missing.png"), null);
  assert.equal(await readContainedImage(root, "assets/barn.glb"), null, "not an image extension");

  // A symlinked image inside the folder is refused rather than followed.
  await symlink(path.join(root, "outside/secret.png"), path.join(root, "assets/linked.png"));
  assert.equal(await readContainedImage(root, "assets/linked.png"), null);

  // The bytes name the type: a PNG called .jpg reads as a PNG, text called .png reads as nothing.
  await writeFile(path.join(root, "assets/mislabelled.jpg"), PNG);
  assert.equal((await readContainedImage(root, "assets/mislabelled.jpg"))?.mimeType, "image/png");
  await writeFile(path.join(root, "assets/pretend.png"), "not an image at all");
  assert.equal(await readContainedImage(root, "assets/pretend.png"), null);

  // The ceiling is bytes, not trust.
  assert.equal(await readContainedImage(root, `assets/genex/${JOB_A}/a.png`, { maxBytes: 4 }), null);

  // A resize is used when asked for, and a failing one falls back to the original bytes.
  const asked: number[] = [];
  const resized = await readContainedImage(root, `assets/genex/${JOB_A}/a.png`, {
    resize: async (data) => {
      asked.push(data.length);
      return Buffer.from("jpeg-bytes");
    },
  });
  assert.deepEqual(asked, [PNG.length]);
  assert.equal(resized?.mimeType, "image/jpeg");
  const fell = await readContainedImage(root, `assets/genex/${JOB_A}/a.png`, {
    resize: async () => {
      throw new Error("no preview");
    },
  });
  assert.equal(fell?.mimeType, "image/png");
  // An empty prefix list is how the inspection scope reads inside a job folder.
  assert.equal(
    (await readContainedImage(path.join(root, "outside"), "secret.png", { prefixes: [] }))?.mimeType,
    "image/png",
  );
});

/** Write files into a folder, making their folders. */
async function writeIn(dir: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [file, data] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, ...file.split("/"))), { recursive: true });
    await writeFile(path.join(dir, ...file.split("/")), data);
  }
}

it("walks the folders it is given, with their formats, each file once", async () => {
  const root = path.join(await tmpDir("studio-asset-folders-"), "game");
  await writeIn(root, {
    "Content/Hero.uasset": "uasset",
    "Content/notes.txt": "notes",
    "assets/a.png": "png",
    ".godot/x.png": "png",
    "node_modules/p/i.png": "png",
    "Saved/s.png": "png",
  });
  const files = async (folders: Parameters<typeof walkGameAssets>[1]) =>
    (await walkGameAssets(root, folders)).entries.map((entry) => entry.file);
  assert.deepEqual(
    await files({ folders: [{ folder: "Content", formats: ["uasset"] }, { folder: "assets" }] }),
    ["Content/Hero.uasset", "assets/a.png"],
    "a folder's formats filter what it lists",
  );
  assert.deepEqual(
    await files({ folders: [{ folder: "." }, { folder: "Content", formats: ["uasset"] }, { folder: "assets" }] }),
    ["Content/Hero.uasset", "Content/notes.txt", "assets/a.png"],
    "the root lists each file once, and never a hidden folder or one no walk enters",
  );
  assert.deepEqual(await files({ folders: [{ folder: ".", formats: ["png"] }] }), ["assets/a.png"]);
  assert.deepEqual(await files({}), ["assets/a.png"], "today's folders when none are given");
  // A linked asset folder is reported once and never walked, wherever the walk meets it.
  await rm(path.join(root, "Content"), { recursive: true });
  await symlink(path.join(root, "assets"), path.join(root, "Content"));
  const linked = await walkGameAssets(root, { folders: [{ folder: "." }, { folder: "Content" }] });
  assert.deepEqual(linked.skipped, [{ file: "Content", why: "symlink" }]);
  assert.deepEqual(
    linked.entries.map((entry) => entry.file),
    ["assets/a.png"],
  );
});

it("a game's asset folders list media only: data a script wrote there is no asset, a model's buffers stay readable", async () => {
  const root = path.join(await tmpDir("studio-asset-media-"), "game");
  await writeIn(root, {
    "assets/terrain/T_m00032_p00032_64.bin": "tile",
    "assets/terrain/manifest.json": "{}",
    "assets/notes.txt": "notes",
    "assets/rock.gltf": "{}",
    "assets/rock.bin": "buffers",
    "assets/rock.png": "png",
    "public/assets/level.json": "{}",
  });
  assert.deepEqual(
    (await walkGameAssets(root)).entries.map((entry) => entry.file),
    ["assets/rock.gltf", "assets/rock.png"],
  );
  assert.equal(isAssetPath("assets/rock.bin", DEFAULT_ASSET_FOLDERS), true, "a glTF's buffers are read beside it");
  assert.equal(isAssetPath("assets/terrain/manifest.json", DEFAULT_ASSET_FOLDERS), false);
});

it("a whole folder leaves out Genex's mood boards and build output", async () => {
  const root = path.join(await tmpDir("studio-asset-whole-"), "game");
  await writeIn(root, {
    "art/a.png": "png",
    "references/mood-1.png": "png",
    "dist/y.png": "png",
    "output/x.png": "png",
    "levels/dist/z.png": "png",
    "levels/references/r.png": "png",
  });
  const listed = await walkGameAssets(root, { folders: [{ folder: ".", formats: ["png"] }] });
  assert.deepEqual(
    listed.entries.map((entry) => entry.file),
    ["art/a.png", "levels/references/r.png"],
    "the mood boards at the game's root and build output anywhere stay out; a person's own references folder is listed",
  );
});

it("an asset folder is walked only by its own spelling, so a case alias lists nothing twice", async () => {
  const root = path.join(await tmpDir("studio-asset-case-"), "game");
  await writeIn(root, { "Assets/t.png": "png", "Assets/t.png.meta": "meta", "Assets/Scripts/P.cs": "cs" });
  const listed = await walkGameAssets(root, {
    folders: [{ folder: "assets" }, { folder: "Assets", formats: ["png"] }],
  });
  assert.deepEqual(
    listed.entries.map((entry) => entry.file),
    ["Assets/t.png"],
  );
});

it("a link at an inner part of an asset folder is reported and never walked", async () => {
  const base = await tmpDir("studio-asset-inner-link-");
  const root = path.join(base, "game");
  await writeIn(base, { "outside/Assets/private.png": "png" });
  await mkdir(root, { recursive: true });
  await symlink(path.join(base, "outside"), path.join(root, "unity"));
  const listed = await walkGameAssets(root, { folders: [{ folder: "unity/Assets" }] });
  assert.deepEqual(listed.entries, [], "nothing outside the game is listed");
  assert.deepEqual(listed.skipped, [{ file: "unity", why: "symlink" }]);
});

let lite: CoreLite;
let cases: string;

/** A copy of a project fixture with these files added, opened as a game. */
async function adopted(name: Project, files: Record<string, string | Buffer> = {}) {
  const dir = await copyProject(name, await mkdtemp(path.join(cases, "case-")));
  await writeIn(dir, files);
  const game = await lite.core.adoptProject(dir);
  return { dir, name: game.name };
}

/** The game's assets as the Assets tab lists them. */
const listed = async (game: string) => (await lite.core.projectAssets(game)).assets;

async function listsByFactsAndPlugins(): Promise<void> {
  const unreal = await adopted(Project.UnrealGame, {
    "Content/Maps/Main.umap": "umap",
    "Content/Hero.uasset": "uasset",
    "Saved/x.uasset": "uasset",
    "assets/models/rock.obj": "o rock\nv 0 0 0\n",
  });
  assert.deepEqual(
    (await listed(unreal.name)).map((asset) => [asset.file, asset.kind]).sort(),
    [["assets/models/rock.obj", "model"]],
    "the media agents brought in, never Unreal's own packages (no preview) or the editor's scratch",
  );

  await lite.core.plugins.installLocal(TOY_PLUGIN, PluginSourceKind.Local, []);
  await lite.core.plugins.setEnabled(TOY_PLUGIN_ID, true);
  const toy = await adopted(Project.ToyProject);
  assert.deepEqual(
    (await listed(toy.name)).map((asset) => asset.file),
    ["scenes/start.toyscene"],
  );

  const web = await adopted(Project.WebFolder, { "assets/a.png": "png", "art/b.png": "png", "src/c.png": "png" });
  assert.deepEqual(
    (await listed(web.name)).map((asset) => asset.file),
    ["assets/a.png"],
    "a web game lists what it listed before",
  );

  const unity = await adopted(Project.WebFolder, {
    "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.0f1\n",
    "Assets/hero.png": PNG,
    "Assets/hero.png.meta": "guid: 1\n",
    "Assets/Scripts/Player.cs": "class Player {}\n",
    "Assets/Scenes/Main.unity": "%YAML 1.1\n",
  });
  assert.deepEqual(
    (await listed(unity.name)).map((asset) => asset.file),
    ["Assets/hero.png"],
    "a Unity game lists its media once, never its metadata, scripts or scenes",
  );

  const blend = await adopted(Project.WebFolder, {
    "scene.blend": "BLENDER-v400\n",
    "assets/a.png": PNG,
    "dist/assets/a.png": PNG,
    "references/mood-1.png": PNG,
  });
  const blendFiles = (await listed(blend.name)).map((asset) => asset.file);
  assert.ok(blendFiles.includes("assets/a.png") && blendFiles.includes("scene.blend"), blendFiles.join(", "));
  assert.ok(
    !blendFiles.some((file) => file.startsWith("dist/") || file.startsWith("references/")),
    "build output and the mood boards are no assets",
  );
}

async function previewsInsideAssetFolders(): Promise<void> {
  const unity = await adopted(Project.WebFolder, {
    "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.0f1\n",
    "ProjectSettings/x.png": PNG,
    "Assets/t.png": PNG,
    "Assets/.cache/t.png": PNG,
    "outside/secret.png": PNG,
  });
  await symlink(path.join(unity.dir, "outside/secret.png"), path.join(unity.dir, "Assets/linked.png"));
  const preview = (file: string) => lite.core.previewProjectAsset({ project: unity.name, file });
  assert.deepEqual(Buffer.from((await preview("Assets/t.png")).data), PNG);
  await assert.rejects(preview("ProjectSettings/x.png"), /Only asset files can be previewed\./);
  await assert.rejects(preview("Assets/.cache/t.png"), /Only asset files can be previewed\./);
  await assert.rejects(preview("Assets/linked.png"), /Linked files cannot be previewed\./);
  const image = (file: string) => lite.core.readProjectAsset({ project: unity.name, file });
  assert.equal((await image("Assets/t.png"))?.mimeType, "image/png");
  assert.equal(await image("ProjectSettings/x.png"), null, "the canvas reader keeps the same folders");
  assert.equal(await image("Assets/linked.png"), null);
  assert.equal(await image("Assets/.cache/t.png"), null, "the canvas reader refuses a hidden part too");

  const godot = await adopted(Project.GodotGame, {
    "art/x.png": PNG,
    ".godot/imported/x.png": PNG,
    ".studio/x.png": PNG,
    "node_modules/p/x.png": PNG,
    "references/mood-1.png": PNG,
    "dist/x.png": PNG,
    "Saved/x.png": PNG,
  });
  const godotImage = (file: string) => lite.core.readProjectAsset({ project: godot.name, file });
  const godotPreview = (file: string) => lite.core.previewProjectAsset({ project: godot.name, file });
  assert.equal((await godotImage("art/x.png"))?.mimeType, "image/png");
  for (const file of [
    ".godot/imported/x.png",
    ".studio/x.png",
    "node_modules/p/x.png",
    "references/mood-1.png",
    "dist/x.png",
  ]) {
    assert.equal(await godotImage(file), null, file);
    await assert.rejects(godotPreview(file), /Only asset files can be previewed\./, file);
  }
  // Spelled in another case: a case-insensitive disk opens these as the folders above.
  for (const file of ["SAVED/x.png", "References/mood-1.png", "Node_Modules/p/x.png", "DIST/x.png"])
    assert.equal(await godotImage(file), null, file);
}

async function readsShareOneFactsWalk(): Promise<void> {
  const unity = await adopted(Project.WebFolder, {
    "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.0f1\n",
    "Assets/a.png": PNG,
    "Assets/b.png": PNG,
  });
  const games = lite.core.games;
  const factsOf = games.factsOf.bind(games);
  let walks = 0;
  games.factsOf = async (name: string) => {
    walks += 1;
    return factsOf(name);
  };
  try {
    await lite.core.projectAssets(unity.name);
    const reads = ["Assets/a.png", "Assets/b.png", "Assets/a.png", "Assets/b.png"].map((file) =>
      lite.core.readProjectAsset({ project: unity.name, file }),
    );
    for (const read of await Promise.all(reads)) assert.equal(read?.mimeType, "image/png");
    await lite.core.previewProjectAsset({ project: unity.name, file: "Assets/a.png" });
    assert.equal(walks, 1, "the listing reads the facts; its thumbnails and previews reuse them");
  } finally {
    games.factsOf = factsOf;
  }
}

describe("a project's assets, by its facts and plugins", () => {
  before(async () => {
    const root = await realpath(await tmpDir("studio-asset-facts-"));
    cases = path.join(root, "cases");
    await mkdir(cases);
    lite = await coreLite({
      gamesRoot: path.join(root, "games"),
      executionPolicy: { allowedProjectRoot: root, runBackgroundImprovement: false },
    });
  });
  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  it("lists what a project's facts and plugins name, by name when Genex cannot show it", listsByFactsAndPlugins);
  it("previews a file inside a project's asset folders and refuses one outside", previewsInsideAssetFolders);
  it("thumbnails and previews reuse the folders the listing found", readsShareOneFactsWalk);
});

describe("a game's asset folders as its facts change", () => {
  let timed: CoreLite;
  let root: string;
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  /** Longer than the ten seconds previews and thumbnails reuse a read of the folders for. */
  const PAST_THE_WINDOW_MS = 60_000;
  before(async () => {
    root = await realpath(await tmpDir("studio-asset-clock-"));
    timed = await coreLite({
      gamesRoot: path.join(root, "games"),
      executionPolicy: { allowedProjectRoot: root, runBackgroundImprovement: false },
      assetFolders: { now: () => clock },
    });
  });
  after(() => timed.close());

  it("a listing reads them afresh; a preview reads them again once its window has passed", async () => {
    const dir = await copyProject(Project.WebFolder, await mkdtemp(path.join(root, "case-")));
    await writeIn(dir, { "Assets/a.png": PNG });
    const game = await timed.core.adoptProject(dir);
    const games = timed.core.games;
    const factsOf = games.factsOf.bind(games);
    let walks = 0;
    games.factsOf = async (name: string) => {
      walks += 1;
      return factsOf(name);
    };
    const image = () => timed.core.readProjectAsset({ project: game.name, file: "Assets/a.png" });
    const files = async () => (await timed.core.projectAssets(game.name)).assets.map((asset) => asset.file);
    try {
      assert.ok(!(await files()).includes("Assets/a.png"), "a web folder keeps no assets in Assets/");
      assert.equal(await image(), null);
      // The folder becomes a Unity project: the next listing finds its Assets folder at once.
      await writeIn(dir, { "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0.0f1\n" });
      const before = walks;
      assert.ok((await files()).includes("Assets/a.png"), "the listing reads the facts afresh");
      assert.equal(walks, before + 1);
      assert.equal((await image())?.mimeType, "image/png", "and the reads after it use what it found");
      assert.equal(walks, before + 1, "without another walk");

      // The project file goes: within the window a read keeps the folders; past it, it walks again.
      await rm(path.join(dir, "ProjectSettings"), { recursive: true });
      assert.equal((await image())?.mimeType, "image/png");
      assert.equal(walks, before + 1);
      clock += PAST_THE_WINDOW_MS;
      assert.equal(await image(), null, "past the window the read finds the folders as they are now");
      assert.equal(walks, before + 2);
    } finally {
      games.factsOf = factsOf;
    }
  });
});

it("assetKind classifies by extension and treats anything else as other", () => {
  assert.equal(assetKind("assets/a.png"), "image");
  assert.equal(assetKind("assets/BARN.GLB"), "model");
  assert.equal(assetKind("assets/hand.wav"), "audio");
  assert.equal(assetKind("assets/clip.mp4"), "video");
  assert.equal(assetKind("assets/src/tree.py"), "other");
  assert.equal(assetKind("assets/logo.svg"), "image");
  assert.equal(assetKind(""), "other");
});

it("the join falls back to the file's own time when nothing recorded a delivery", async () => {
  const root = await game();
  const older = path.join(root, "assets/hand.mp3");
  await utimes(older, new Date("2019-01-01T00:00:00.000Z"), new Date("2019-01-01T00:00:00.000Z"));
  const walk = await walkGameAssets(root);
  const joined = joinProjectAssets({ project: "farm", entries: walk.entries, ledger: [], jobs: [] });
  assert.equal(joined.assets.at(-1)!.file, "assets/hand.mp3");
  assert.equal(
    joined.assets.every((a) => a.source === "imported" || a.source === "genex" || a.source === "foo"),
    true,
  );
  assert.equal(await readFile(older, "utf8"), "mp3");
});

it("main and the substrate read pictures and sounds from the one format table", () => {
  // The contained readers, the run stills and the user-paths listing take raster pictures only.
  for (const [file, image] of [
    ["a.png", true],
    ["dir/A.JPEG", true],
    ["b.webp", true],
    ["c.gif", true],
    ["d.svg", false],
    ["e.bmp", false],
    ["f.exr", false],
    [".png", false],
    ["png", false],
    ["dir.png/file", false],
  ] as const) {
    assert.equal(isImageFile(file), image, file);
  }
  // The audio a Genex use check observes: every audio row of the table, `.oga` and `.opus` included.
  for (const [file, audio] of [
    ["a.mp3", true],
    ["b.WAV", true],
    ["c.ogg", true],
    ["d.m4a", true],
    ["e.aac", true],
    ["f.flac", true],
    ["g.oga", true],
    ["h.opus", true],
    ["i.mp4", false],
    ["j.png", false],
    ["mp3", false],
  ] as const) {
    assert.equal(isAudioFile(file), audio, file);
  }
});

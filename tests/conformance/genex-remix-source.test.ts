/**
 * A game's project as remixers get it: Studio copies the files the game's own git would keep into a
 * folder of its own, which the Genex CLI pushes as the game's source. History, Studio's and Genex's
 * folders, packages, agent settings, secrets and an engine's caches and builds never go; neither does
 * a link, or a path the agents wrote that leads out of the game. A project bigger than Genex keeps is
 * refused with nothing copied, and a file big enough to trip the upload limit goes to Git LFS by name.
 * A build on Genex gets the game's Unreal project alone, and no limit of Studio's: Genex decides.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  gitListFiles,
  LFS_FILE_BYTES,
  RemixSourceError,
  SOURCE_MAX_FILES,
  stageBuildSource,
  stageRemixSource,
} from "../../src/plugins/genex/remix-source.ts";
import { GenexRemixProblem } from "../../src/shared/genex.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** Every file under `dir`, relative, `/` between parts, sorted. */
async function filesIn(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await filesIn(dir, rel)));
    else found.push(rel);
  }
  return found.sort();
}

/** A game folder with `files` (relative path → text) and a place for the copy beside it. */
async function gameWith(files: Record<string, string>) {
  const root = await realpath(await tmpDir("genex-remix-source-"));
  const game = path.join(root, "game");
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(game, file)), { recursive: true });
    await writeFile(path.join(game, file), text);
  }
  return { root, game, dest: path.join(root, "publish", "source") };
}

/** A staging that lists exactly `listed`, as an agent-written folder's git might. */
const listing = (listed: string[]) => ({ listFiles: async () => listed });

describe("a game's project staged for remixing", () => {
  it("copies the files the game's git keeps, tracked or new, and leaves ignored ones and history behind", async () => {
    const { game, dest } = await gameWith({
      "studio.json": "{}",
      "index.html": "<canvas></canvas>",
      "src/main.js": "start()",
      "notes/new-idea.md": "untracked, not ignored",
      ".gitignore": "dist/\nbig-cache/\n",
      "dist/bundle.js": "built",
      "big-cache/blob.bin": "ignored",
    });
    execFileSync("git", ["init", "-q"], { cwd: game });
    execFileSync("git", ["add", "studio.json", "index.html", "src/main.js", ".gitignore"], { cwd: game });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "game"], { cwd: game });
    const staged = await stageRemixSource(game, dest);
    assert.deepEqual(await filesIn(dest), [
      ".gitignore",
      "index.html",
      "notes/new-idea.md",
      "src/main.js",
      "studio.json",
    ]);
    assert.equal(staged.files, 5);
    assert.equal(await readFile(path.join(dest, "src/main.js"), "utf8"), "start()");
  });

  it("keeps a file's mode, so a script stays runnable in the remix", async () => {
    const { game, dest } = await gameWith({ "tools/build.sh": "#!/bin/sh\n" });
    execFileSync("chmod", ["755", path.join(game, "tools/build.sh")]);
    await stageRemixSource(game, dest, listing(["tools/build.sh"]));
    assert.equal((await stat(path.join(dest, "tools/build.sh"))).mode & 0o777, 0o755);
  });

  it("leaves out what is never a game's own, wherever an agent put it", async () => {
    const cases: Array<[string, string]> = [
      [".git/config", "history"],
      ["sub/.git/HEAD", "a nested repository"],
      [".studio/state.json", "Studio's own folder"],
      [".genex/project.json", "Genex's own folder"],
      ["node_modules/three/index.js", "installed packages"],
      [".claude/settings.local.json", "an agent's settings"],
      [".codex/config.toml", "an agent's settings"],
      [".cursor/rules.md", "an agent's settings"],
      [".agents/skills/x.md", "an agent's settings"],
      [".mcp.json", "MCP settings, which may hold keys"],
      [".env", "secrets"],
      [".env.local", "secrets"],
      ["server/.env.production", "secrets"],
      [".DS_Store", "Finder's notes"],
    ];
    const kept = ["studio.json", ".env.example", "docs/claude.md"];
    const { game, dest } = await gameWith(
      Object.fromEntries([...cases.map(([file]) => [file, "x"]), ...kept.map((file) => [file, "x"])]),
    );
    await stageRemixSource(game, dest, listing([...cases.map(([file]) => file), ...kept]));
    const copied = await filesIn(dest);
    for (const [file, why] of cases) assert.equal(copied.includes(file), false, `${file}: ${why}`);
    assert.deepEqual(copied, [...kept].sort());
  });

  it("leaves out an engine project's caches and builds, and its plugins', but only inside that project", async () => {
    const files = {
      "unity/ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.2",
      "unity/Assets/Scenes/Main.unity": "scene",
      "unity/Library/ArtifactDB": "cache",
      "unity/Temp/lock": "cache",
      "unity/Logs/shadercompiler.log": "log",
      "unity/UserSettings/Layouts.dwlt": "layout",
      "unity/Builds/Mac/Game.app/Contents/Info.plist": "build",
      "godot/project.godot": "[application]",
      "godot/.godot/imported/x.ctex": "cache",
      "godot/scenes/main.tscn": "scene",
      "Arena/Arena.uproject": "{}",
      "Arena/Intermediate/Build/x.o": "cache",
      "Arena/Saved/Logs/Arena.log": "log",
      "Arena/Content/Maps/Main.umap": "map",
      "Arena/Builds/Mac/Arena-Mac-Shipping.app/Contents/Info.plist": "the packaged app",
      "Arena/Plugins/Fx/Fx.uplugin": "{}",
      "Arena/Plugins/Fx/Source/Fx.cpp": "code",
      "Arena/Plugins/Fx/Binaries/Mac/libFx.dylib": "build",
      "Arena/Plugins/Fx/Intermediate/Build/x.o": "cache",
      "web/Library/readme.md": "a web game's own folder named Library",
    };
    const { game, dest } = await gameWith(files);
    await stageRemixSource(game, dest, listing(Object.keys(files)));
    assert.deepEqual(await filesIn(dest), [
      // The level goes to Git LFS: the copy names it there.
      ".gitattributes",
      "Arena/Arena.uproject",
      "Arena/Content/Maps/Main.umap",
      "Arena/Plugins/Fx/Fx.uplugin",
      "Arena/Plugins/Fx/Source/Fx.cpp",
      "godot/project.godot",
      "godot/scenes/main.tscn",
      "unity/Assets/Scenes/Main.unity",
      "unity/ProjectSettings/ProjectVersion.txt",
      "web/Library/readme.md",
    ]);
  });

  it("leaves an engine game's asset copies and proof screenshots out, but never a web game's or a Godot project's at the top", async () => {
    const unreal = {
      "unreal/Arena.uproject": "{}",
      "unreal/Content/Crate.uasset": "package",
      "assets/blender/crate.glb": "the model, already imported",
      "assets/genex/hero.glb": "a generation, already imported",
      "docs/proof/shot-01.png": "proof",
      "docs/design.md": "notes",
      "NOTES.md": "notes",
    };
    const one = await gameWith(unreal);
    await stageRemixSource(one.game, one.dest, listing(Object.keys(unreal)));
    assert.deepEqual(await filesIn(one.dest), [
      ".gitattributes",
      "NOTES.md",
      "docs/design.md",
      "unreal/Arena.uproject",
      "unreal/Content/Crate.uasset",
    ]);
    const web = {
      "index.html": "<html>",
      "assets/hero.glb": "the game loads it",
      "unity/ProjectSettings/ProjectVersion.txt": "6000.2",
    };
    const two = await gameWith(web);
    await stageRemixSource(two.game, two.dest, listing(Object.keys(web)));
    assert.ok((await filesIn(two.dest)).includes("assets/hero.glb"), "a web page at the top loads its assets");
    const godot = { "project.godot": "[application]", "assets/hero.glb": "res://assets/hero.glb" };
    const three = await gameWith(godot);
    await stageRemixSource(three.game, three.dest, listing(Object.keys(godot)));
    assert.ok((await filesIn(three.dest)).includes("assets/hero.glb"), "a Godot project at the top owns assets/");
  });

  it("copies only real files inside the game: links and paths out of it stay behind, and nothing outside is touched", async () => {
    const { root, game, dest } = await gameWith({ "studio.json": "{}", "src/main.js": "ok" });
    await writeFile(path.join(root, "secret.txt"), "outside the game");
    await mkdir(path.join(root, "elsewhere"), { recursive: true });
    await writeFile(path.join(root, "elsewhere", "loot.txt"), "outside the game");
    await symlink(path.join(root, "secret.txt"), path.join(game, "linked-file.txt"));
    await symlink(path.join(root, "elsewhere"), path.join(game, "linked-folder"));
    await symlink(path.join(game, "src", "main.js"), path.join(game, "inside-link.js"));
    const hostile = [
      "linked-file.txt",
      "linked-folder/loot.txt",
      "inside-link.js",
      "../secret.txt",
      "src/../../secret.txt",
      path.join(root, "secret.txt"),
      "missing.js",
      "src",
    ];
    await stageRemixSource(game, dest, listing(["studio.json", "src/main.js", ...hostile]));
    assert.deepEqual(await filesIn(dest), ["src/main.js", "studio.json"]);
    assert.deepEqual(await filesIn(root, "elsewhere"), ["elsewhere/loot.txt"]);
    assert.equal(await readFile(path.join(root, "secret.txt"), "utf8"), "outside the game");
  });

  it("refuses with nothing copied: no repository, nothing of the game's own, or more files than Genex keeps", async () => {
    const plain = await gameWith({ "index.html": "x" });
    await assert.rejects(
      stageRemixSource(plain.game, plain.dest, { listFiles: gitListFiles }),
      (error: unknown) => error instanceof RemixSourceError && error.code === GenexRemixProblem.NoRepository,
    );
    const onlyCaches = await gameWith({ ".env": "KEY=1", "node_modules/a.js": "x" });
    await assert.rejects(
      stageRemixSource(onlyCaches.game, onlyCaches.dest, listing([".env", "node_modules/a.js"])),
      (error: unknown) => error instanceof RemixSourceError && error.code === GenexRemixProblem.Empty,
    );
    const many = Array.from({ length: SOURCE_MAX_FILES + 1 }, (_, n) => `levels/${n}.json`);
    const crowded = await gameWith(Object.fromEntries(many.map((file) => [file, "{}"])));
    await assert.rejects(
      stageRemixSource(crowded.game, crowded.dest, listing(many)),
      (error: unknown) => error instanceof RemixSourceError && error.code === GenexRemixProblem.TooBig,
    );
    for (const refused of [plain, onlyCaches, crowded]) assert.deepEqual(await filesIn(refused.dest), []);
  });

  it("starts the copy afresh, so a file the game dropped since the last publish is gone", async () => {
    const { game, dest } = await gameWith({ "studio.json": "{}", "old.js": "x" });
    await stageRemixSource(game, dest, listing(["studio.json", "old.js"]));
    await stageRemixSource(game, dest, listing(["studio.json"]));
    assert.deepEqual(await filesIn(dest), ["studio.json"]);
  });

  it("sends every model, picture, sound, video and Unreal package to Git LFS whatever its size, and code never", async () => {
    const { game, dest } = await gameWith({
      "unreal/Content/Maps/Main.umap": "level",
      "unreal/Content/Crate.uasset": "package",
      "assets/crate.glb": "model",
      "assets/src/crate.blend": "blend",
      "assets/hit.wav": "sound",
      "src/main.js": "code",
      "unreal/build/courtyard.py": "script",
    });
    await stageRemixSource(
      game,
      dest,
      listing([
        "unreal/Content/Maps/Main.umap",
        "unreal/Content/Crate.uasset",
        "assets/crate.glb",
        "assets/src/crate.blend",
        "assets/hit.wav",
        "src/main.js",
        "unreal/build/courtyard.py",
      ]),
    );
    const routed = (await readFile(path.join(dest, ".gitattributes"), "utf8")).split("\n").filter(Boolean);
    assert.deepEqual(routed.map((line) => line.split('" ')[0]?.slice(2)).sort(), [
      "assets/crate.glb",
      "assets/hit.wav",
      "assets/src/crate.blend",
      "unreal/Content/Crate.uasset",
      "unreal/Content/Maps/Main.umap",
    ]);
  });

  it("names a file big enough to trip the upload limit in .gitattributes, after the game's own lines", async () => {
    const { game, dest } = await gameWith({
      ".gitattributes": "*.psd filter=lfs diff=lfs merge=lfs -text",
      "unity/Assets/Terrain Data.asset": "",
      'unity/Assets/odd"name.bin': "",
      "unity/Assets/small.asset": "small",
    });
    const big = Buffer.alloc(LFS_FILE_BYTES);
    await writeFile(path.join(game, "unity/Assets/Terrain Data.asset"), big);
    await writeFile(path.join(game, 'unity/Assets/odd"name.bin'), big);
    await stageRemixSource(
      game,
      dest,
      listing([
        ".gitattributes",
        "unity/Assets/Terrain Data.asset",
        'unity/Assets/odd"name.bin',
        "unity/Assets/small.asset",
      ]),
    );
    assert.equal(
      await readFile(path.join(dest, ".gitattributes"), "utf8"),
      [
        "*.psd filter=lfs diff=lfs merge=lfs -text",
        '"/unity/Assets/Terrain Data.asset" filter=lfs diff=lfs merge=lfs -text',
        '"/unity/Assets/odd\\"name.bin" filter=lfs diff=lfs merge=lfs -text',
        "",
      ].join("\n"),
    );
    execFileSync("git", ["init", "-q"], { cwd: dest });
    const routed = execFileSync(
      "git",
      [
        "check-attr",
        "filter",
        "--",
        "unity/Assets/Terrain Data.asset",
        'unity/Assets/odd"name.bin',
        "unity/Assets/small.asset",
      ],
      {
        cwd: dest,
        encoding: "utf8",
      },
    );
    assert.match(routed, /Terrain Data\.asset: filter: lfs/);
    assert.match(routed, /odd\\"name\.bin": filter: lfs/);
    assert.match(routed, /small\.asset: filter: unspecified/);
  });
});

describe("a game's project staged for a build on Genex", () => {
  const unrealGame = {
    "studio.json": "{}",
    "index.html": "<p>web</p>",
    "docs/notes.md": "notes",
    "unreal/Strike.uproject": "{}",
    "unreal/Content/Maps/Arena.umap": "map",
    "unreal/Config/DefaultGame.ini": "[x]",
    "unreal/Saved/Logs/Strike.log": "log",
    "unreal/Binaries/Mac/Strike": "bin",
  };

  it("sends the Unreal project alone, its .uproject at the top, without its caches or the game's other files", async () => {
    const { game, dest } = await gameWith(unrealGame);
    const staged = await stageBuildSource(game, dest, listing(Object.keys(unrealGame)));
    assert.deepEqual(await filesIn(dest), ["Config/DefaultGame.ini", "Content/Maps/Arena.umap", "Strike.uproject"]);
    assert.equal(staged.files, 3);
    assert.equal(staged.bytes, "{}".length + "map".length + "[x]".length);
  });

  it("takes what the game's .gitignore keeps out of checkpoints when the cook needs it, and nothing else", async () => {
    // The incident: a Fab kit stayed out of checkpoints, so it never reached the build machine, and
    // the cook failed on 830 "Unknown structure" errors in the game's own Blueprints.
    const ignored = [
      "unreal/Content/BodycamFPSKIT/BP_Item.uasset",
      "unreal/Config/Local.ini",
      "unreal/Plugins/Kit/Content/Mesh.uasset",
      "unreal/Plugins/Kit/Kit.uplugin",
      "unreal/Plugins/Kit/Binaries/Mac/Kit.dylib",
      "unreal/Plugins/Kit/Intermediate/Build/x.o",
      "unreal/Saved/Logs/game.log",
      "unreal/Intermediate/x.o",
      "unreal/DerivedDataCache/x.ddc",
      "unreal/Builds/Game.app/x",
      "unreal/Content/Sample/Other.uproject",
      "unreal/Content/.env",
      "assets/Big.fbx",
      "notes/private.md",
    ];
    const files = { ...unrealGame, ...Object.fromEntries(ignored.map((file) => [file, "x"])) };
    const { game, dest } = await gameWith(files);
    const tracked = Object.keys(unrealGame);
    const staged = await stageBuildSource(game, dest, { ...listing(tracked), listIgnored: async () => ignored });
    assert.deepEqual(await filesIn(dest), [
      "Config/DefaultGame.ini",
      "Config/Local.ini",
      "Content/BodycamFPSKIT/BP_Item.uasset",
      "Content/Maps/Arena.umap",
      "Plugins/Kit/Content/Mesh.uasset",
      "Plugins/Kit/Kit.uplugin",
      "Strike.uproject",
    ]);
    assert.equal(staged.files, 7);
  });

  it("reads what git itself ignores, and a remix of the same game still leaves it out", async () => {
    const { game, dest } = await gameWith({
      ...unrealGame,
      "unreal/Content/Kit/BP.uasset": "kit",
      ".gitignore": "unreal/Content/Kit/\n",
    });
    execFileSync("git", ["init", "-q"], { cwd: game });
    await stageBuildSource(game, dest);
    assert.ok((await filesIn(dest)).includes("Content/Kit/BP.uasset"), "the build gets the kit");
    const remix = path.join(dest, "..", "remix");
    await stageRemixSource(game, remix);
    assert.ok(!(await filesIn(remix)).some((file) => file.includes("Content/Kit")), "a remix never does");
  });

  it("takes nothing ignored for a game with no one Unreal project", async () => {
    const { game, dest } = await gameWith({ "index.html": "x", "dist/app.js": "y" });
    await stageBuildSource(game, dest, { ...listing(["index.html"]), listIgnored: async () => ["dist/app.js"] });
    assert.deepEqual(await filesIn(dest), ["index.html"]);
  });

  it("keeps no limit of Studio's own: a project past what remixing takes still goes, and Genex decides", async () => {
    const many = Array.from({ length: SOURCE_MAX_FILES + 1 }, (_, n) => `unreal/Content/${n}.uasset`);
    const files = { "unreal/Strike.uproject": "{}", ...Object.fromEntries(many.map((file) => [file, "a"])) };
    const { game, dest } = await gameWith(files);
    await assert.rejects(stageRemixSource(game, path.join(dest, "..", "remix"), listing(Object.keys(files))));
    const staged = await stageBuildSource(game, dest, listing(Object.keys(files)));
    assert.equal(staged.files, SOURCE_MAX_FILES + 2);
  });

  it("counts only the game's own .uproject: one in a package or a cache leaves the project found", async () => {
    const stray = { ...unrealGame, "node_modules/kit/Sample.uproject": "{}", "unreal/Saved/Old.uproject": "{}" };
    const { game, dest } = await gameWith(stray);
    await stageBuildSource(game, dest, listing(Object.keys(stray)));
    assert.deepEqual(await filesIn(dest), ["Config/DefaultGame.ini", "Content/Maps/Arena.umap", "Strike.uproject"]);
  });

  it("sends the whole game, as remixers get it, when it has no Unreal project or more than one", async () => {
    const two = { ...unrealGame, "other/Other.uproject": "{}" };
    const both = await gameWith(two);
    await stageBuildSource(both.game, both.dest, listing(Object.keys(two)));
    assert.ok((await filesIn(both.dest)).includes("unreal/Strike.uproject"));
    assert.ok((await filesIn(both.dest)).includes("other/Other.uproject"));
    const web = await gameWith({ "index.html": "x", "src/main.js": "y" });
    await stageBuildSource(web.game, web.dest, listing(["index.html", "src/main.js"]));
    assert.deepEqual(await filesIn(web.dest), ["index.html", "src/main.js"]);
  });

  it("refuses with nothing copied when the game has nothing of its own", async () => {
    const { game, dest } = await gameWith({ ".env": "KEY=1", "node_modules/a.js": "x" });
    await assert.rejects(
      stageBuildSource(game, dest, listing([".env", "node_modules/a.js"])),
      (error: unknown) => error instanceof RemixSourceError && error.code === GenexRemixProblem.Empty,
    );
    assert.deepEqual(await filesIn(dest), []);
  });
});

/**
 * What a folder holds, as facts: the core table, a plugin's detect, the link, and what never counts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  CORE_FACT_RULES,
  CoreFact,
  FactSource,
  factsOfFiles,
  FolderHolds,
  globMatches,
  LoopProfile,
  loopProfileOf,
  parsePortedFrom,
  pluginFactSource,
  scopePaths,
  type FactRule,
  WEB_LOOP_FACTS,
} from "../../src/shared/project-facts.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { webFolderOf } from "../../src/shared/project-workspace.ts";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import { writeEngineBinding } from "../../src/substrate/game-engine-binding.ts";
import { ENGINES, GODOT_ENGINE, TOY_ENGINE, UNREAL_ENGINE } from "../helpers/engines.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { detectFacts, projectFiles } from "../../src/substrate/project-facts.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { TOY_PLUGIN, TOY_PLUGIN_ID } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const CORE = CORE_FACT_RULES.map((rule) => ({ rule, source: FactSource.Core }));

/** Every entry under a folder, relative; a link is listed and never followed (Node's recursive readdir follows them). */
async function entriesUnder(dir: string, rel = ""): Promise<string[]> {
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
  const listed: string[] = [];
  for (const entry of entries) {
    const at = rel ? `${rel}/${entry.name}` : entry.name;
    listed.push(at);
    if (entry.isDirectory()) listed.push(...(await entriesUnder(dir, at)));
  }
  return listed.sort();
}

/** The facts of a file list as `id@path`, in the order the facts come. */
const found = (files: string[], rules = CORE) => factsOfFiles(files, rules).map((fact) => `${fact.id}@${fact.path}`);

describe("the core table", () => {
  it("finds each core kind at the folder it sits in", () => {
    const table: Array<[string, string[], string[]]> = [
      ["a web page at the root", ["index.html"], ["web-game@."]],
      [
        "an Unreal project with a site beside it",
        ["site/index.html", "Harbor.uproject"],
        ["unreal-project@.", "web-game@site"],
      ],
      ["a Unity project one folder down", ["a/ProjectSettings/ProjectVersion.txt"], ["unity-project@a"]],
      ["Blender files and their backups", ["props/crate.blend", "props/crate.blend1"], ["blender-assets@props"]],
      [
        "the Genex editor helper inside a game's Plugins folder",
        ["Plugins/GenexEditorHelper/GenexEditorHelper.uplugin", "Lantern.uproject"],
        ["unreal-project@."],
      ],
      ["an Unreal plugin with no host project", ["LevelTools.uplugin"], ["unreal-plugin@."]],
      [
        "pages in output, dependencies and a docs folder under a web game",
        ["index.html", "dist/index.html", "node_modules/x/index.html", "docs/index.html"],
        ["web-game@."],
      ],
      [
        "a Unity game's own WebGL template beside its web build",
        ["unity/Assets/WebGLTemplates/Genex/index.html", "unity/ProjectSettings/ProjectVersion.txt", "web/index.html"],
        ["unity-project@unity", "web-game@web"],
      ],
      ["a Godot project", ["project.godot", "scenes/main.tscn"], ["godot-project@."]],
      ["a Roblox place at the root", ["Obby.rbxl", "src/server/main.server.luau"], ["roblox-project@."]],
      ["a Roblox place in XML one folder down", ["places/Obby.rbxlx"], ["roblox-project@places"]],
      ["a Rojo project", ["default.project.json", "src/shared/util.luau"], ["roblox-project@."]],
      ["another JSON project file", ["game.project.json", "package.json"], []],
      ["nothing a kind is known by", ["README.md", "idea.txt"], []],
    ];
    for (const [name, files, facts] of table) assert.deepEqual(found(files), facts, name);
    const [first] = factsOfFiles(["index.html"], CORE);
    assert.equal(first?.source, FactSource.Core, "a core fact says where it came from");
  });

  it("matches a path against a glob as the facts do", () => {
    const table: Array<[string, string, boolean]> = [
      ["Harbor.uproject", "*.uproject", true],
      ["a/Harbor.uproject", "*.uproject", false],
      ["a/Harbor.uproject", "**/*.uproject", true],
      ["Harbor.uproject", "**/*.uproject", true],
      ["props/crate.blend1", "**/*.blend1", true],
      ["props/crate.blend", "**/*.blend1", false],
      ["Saved", "Saved/", true],
      ["Saved/Logs/Lantern.log", "Saved/", true],
      ["Savedx/a", "Saved/", false],
      ["unreal/Saved/a", "Saved/", false],
      ["unreal/Saved/a", "**/Saved/", true],
      ["Plugins/Kit/Binaries/x.dylib", "Plugins/*/Binaries/", true],
      ["Plugins/Binaries/x.dylib", "Plugins/*/Binaries/", false],
      ["Saved/a", "../Saved/", false],
      ["frame_0001.png", "*[0-9].png", true],
      ["12.png", "*[0-9].png", true],
      ["poster.png", "*[0-9].png", false],
      ["frame_0001.jpg", "*[0-9].png", false],
      ["take_1.mp4", "*[0-9].png", false],
      ["frame_0001.png", "*[a-z].png", false],
      ["frame_0001.png", "*[0-9.png", false],
    ];
    for (const [file, glob, matches] of table) assert.equal(globMatches(file, glob), matches, `${file} ~ ${glob}`);
  });
});

describe("a Loop's profile", () => {
  it("is web only for a web game served at the root beside nothing but Blender files; anything else is open", () => {
    const at = (id: string, where: string) => ({ id, path: where, source: FactSource.Core });
    const { Web, Open } = LoopProfile;
    const table: Array<[string, Parameters<typeof loopProfileOf>[0], LoopProfile]> = [
      ["a folder with no kind yet", { facts: [] }, Web],
      ["a folder of its own files of a kind no rule knows", { facts: [], holds: FolderHolds.OwnFiles }, Open],
      ["a web game", { facts: [at(CoreFact.WebGame, ".")] }, Web],
      ["a web game with a second site", { facts: [at(CoreFact.WebGame, "."), at(CoreFact.WebGame, "site")] }, Web],
      [
        "a web game holding Blender files",
        { facts: [at(CoreFact.WebGame, "."), at(CoreFact.BlenderAssets, "assets")] },
        Web,
      ],
      ["a site in a subfolder only", { facts: [at(CoreFact.WebGame, "site")] }, Open],
      ["an Unreal project", { facts: [at(CoreFact.UnrealProject, ".")] }, Open],
      [
        "a web game with an Unreal project linked in",
        { facts: [at(CoreFact.WebGame, "."), at(CoreFact.UnrealProject, "unreal")] },
        Open,
      ],
      [
        "an Unreal project with a site",
        { facts: [at(CoreFact.UnrealProject, "."), at(CoreFact.WebGame, "site")] },
        Open,
      ],
      ["a Godot project", { facts: [at(CoreFact.GodotProject, ".")] }, Open],
      ["a plugin's kind", { facts: [at("toy-project", ".")] }, Open],
      ["Blender files alone", { facts: [at(CoreFact.BlenderAssets, ".")] }, Open],
      ["an Unreal plugin", { facts: [at(CoreFact.UnrealPlugin, ".")] }, Open],
    ];
    for (const [name, game, profile] of table) assert.equal(loopProfileOf(game), profile, name);
    assert.deepEqual([...WEB_LOOP_FACTS].sort(), [CoreFact.BlenderAssets, CoreFact.WebGame]);
  });
});

describe("walking a folder", () => {
  let dir: string;
  before(async () => {
    dir = await realpath(await tmpDir("studio-facts-walk-"));
    await symlink("/", path.join(dir, "out"));
    await symlink("/etc/hosts", path.join(dir, "game.uproject"));
    await mkdir(path.join(dir, "a/b/c/d/e/f"), { recursive: true });
    await writeFile(path.join(dir, "a/b/c/d/e/f/project.godot"), "");
    await mkdir(path.join(dir, "x/y/z"), { recursive: true });
    await writeFile(path.join(dir, "x/y/z/project.godot"), "");
  });

  it("a hostile folder is walked without leaving it", async () => {
    const before = await entriesUnder(dir);
    const facts = (await detectFacts(dir, [])).map((fact) => `${fact.id}@${fact.path}`);
    assert.deepEqual(facts, ["godot-project@x/y/z"], "nothing from a link, nothing past four folders down");
    assert.ok(!(await projectFiles(dir)).some((file) => file.startsWith("out/")), "a linked folder is never walked");

    await mkdir(path.join(dir, "many"));
    for (let i = 0; i < 5000; i++) await writeFile(path.join(dir, "many", `f${i}`), "");
    const files = await projectFiles(dir);
    assert.ok(files.length <= 4000, `the walk stops at its cap (${files.length} files)`);
    const after = await entriesUnder(dir);
    assert.deepEqual(
      after.filter((entry) => !entry.startsWith("many")),
      before,
      "nothing is written in the folder",
    );
  });
});

describe("what the walk leaves out", () => {
  /** A file at `rel` under `dir`, with its folders. */
  const put = async (dir: string, rel: string) => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), "");
  };

  it("never walks hidden, dependency or engine-output folders", async () => {
    const skipped = [
      ".git/x/project.godot",
      ".hidden/Game.uproject",
      "node_modules/a/index.html",
      "Saved/Old.uproject",
      "Intermediate/P/P.uplugin",
      "DerivedDataCache/x/project.godot",
      "Binaries/Mac/Game.uproject",
      "Library/x/project.godot",
      "Temp/x/project.godot",
      "Logs/x/crash.blend",
      "obj/x/project.godot",
    ];
    for (const rel of skipped) {
      const dir = await realpath(await tmpDir("studio-facts-skip-"));
      await put(dir, rel);
      assert.deepEqual(await detectFacts(dir, []), [], `${rel}: no fact`);
      assert.deepEqual(await projectFiles(dir), [], `${rel}: not listed`);
    }
  });

  it("reads four folders down and no further", async () => {
    const deepest = await realpath(await tmpDir("studio-facts-depth-"));
    await put(deepest, "a/b/c/d/project.godot");
    assert.deepEqual(
      (await detectFacts(deepest, [])).map((fact) => `${fact.id}@${fact.path}`),
      ["godot-project@a/b/c/d"],
    );
    const deeper = await realpath(await tmpDir("studio-facts-depth-"));
    await put(deeper, "a/b/c/d/e/project.godot");
    assert.deepEqual(await detectFacts(deeper, []), [], "one folder deeper is never read");
  });

  it("stops at exactly its cap of files", async () => {
    const dir = await realpath(await tmpDir("studio-facts-cap-"));
    for (let i = 0; i < 100; i++) await writeFile(path.join(dir, `f${String(i).padStart(3, "0")}`), "");
    assert.equal((await projectFiles(dir, { maxFiles: 50 })).length, 50);
    assert.equal((await projectFiles(dir, { maxFiles: 7 })).length, 7);
    assert.equal((await projectFiles(dir)).length, 100, "under the cap, every file");
  });

  it("reads at most its cap of folders, the root among them", async () => {
    const dir = await realpath(await tmpDir("studio-facts-folders-"));
    for (let i = 0; i < 10; i++) await put(dir, `f${i}/game.blend`);
    const files = await projectFiles(dir, { maxFolders: 4 });
    assert.deepEqual(files, ["f0/game.blend", "f1/game.blend", "f2/game.blend"], "the root and three folders");
  });

  it("counts only the files it keeps, so folders of other files never use up the walk", async () => {
    const dir = await realpath(await tmpDir("studio-facts-keep-"));
    await Promise.all(Array.from({ length: 30 }, (_, i) => put(dir, `a/shot-${i}.png`)));
    await put(dir, "b/Game.uproject");
    const keep = (rel: string) => rel.endsWith(".uproject");
    assert.deepEqual(await projectFiles(dir, { maxFiles: 5, keep }), ["b/Game.uproject"]);
    assert.equal((await projectFiles(dir, { maxFiles: 5 })).length, 5, "without keep, every file counts");
  });

  it("throws for a folder that is gone", async () => {
    const dir = await realpath(await tmpDir("studio-facts-gone-"));
    await assert.rejects(projectFiles(path.join(dir, "missing")), "a missing root is no empty folder");
    await assert.rejects(detectFacts(path.join(dir, "missing"), []));
  });

  it("skips a folder below the root it can't read", {
    skip: process.platform === "win32" && "a folder's mode shuts no one out on Windows",
  }, async () => {
    const dir = await realpath(await tmpDir("studio-facts-shut-"));
    await put(dir, "shut/project.godot");
    await put(dir, "open/Game.uproject");
    await chmod(path.join(dir, "shut"), 0o000);
    try {
      assert.deepEqual(
        (await detectFacts(dir, [])).map((fact) => `${fact.id}@${fact.path}`),
        ["unreal-project@open"],
        "the readable part is still read",
      );
    } finally {
      await chmod(path.join(dir, "shut"), 0o755);
    }
  });
});

describe("a game whose other folders fill up with files", () => {
  /** Empty files at `rels` under `dir`, with their folders. */
  const putAll = async (dir: string, rels: readonly string[]) => {
    for (const rel of rels) await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await Promise.all(rels.map((rel) => writeFile(path.join(dir, rel), "")));
  };

  // A Unity game whose run kept 4,800 screenshots in docs/ lost its kind: the walk spent its whole
  // budget there and never reached unity/ProjectSettings, so its editor's tools went away mid-run.
  it("still finds its Unity project beside a docs folder of thousands of screenshots", async () => {
    const game = await realpath(await tmpDir("studio-facts-crowded-"));
    const shots = Array.from({ length: 60 }, (_, folder) =>
      Array.from({ length: 80 }, (_, shot) => `docs/proof-v${folder}/shot-${shot}.png`),
    ).flat();
    await putAll(game, [...shots, "assets/props/altar.glb", "unity/Assets/Scenes/Main.unity"]);
    await putAll(game, ["unity/ProjectSettings/ProjectVersion.txt", "unity/Packages/manifest.json"]);
    assert.deepEqual(
      (await detectFacts(game, [])).map((fact) => `${fact.id}@${fact.path}`),
      ["unity-project@unity"],
    );
  });
});

describe("a plugin's detect", () => {
  /** The smallest manifest that loads, with `detect` set as given. */
  const manifest = (detect: unknown, apiVersion = 3) => ({
    apiVersion,
    id: "detect-test",
    version: "1.0.0",
    name: "Detect test",
    publisher: "Genex tests",
    description: "A manifest whose detect section is under test.",
    backend: "backend.mjs",
    capabilities: [],
    tools: [],
    skills: [],
    panels: [],
    settings: [],
    actions: [],
    detect,
  });

  it("a plugin's detect adds its facts, and a malformed detect is refused", () => {
    const raw = JSON.parse(readFileSync(path.join(TOY_PLUGIN, "plugin.json"), "utf8")) as { detect: FactRule[] };
    const kept = validateManifest(raw).detect;
    assert.deepEqual(kept, raw.detect, "the manifest keeps detect");
    const rules = [...CORE, ...(kept ?? []).map((rule) => ({ rule, source: pluginFactSource(TOY_PLUGIN_ID) }))];
    const facts = factsOfFiles(["Garden.toyproj", "vendor/kit/Kit.toyproj", "scenes/start.toyscene"], rules);
    assert.deepEqual(facts, [{ id: "toy-project", path: ".", source: `plugin:${TOY_PLUGIN_ID}` }]);

    const rule = { fact: "toy-project", files: ["**/*.toyproj"] };
    const hostile: Array<[string, unknown, number?]> = [
      ["a fact id that is not lowercase", [{ ...rule, fact: "Toy" }]],
      ["no files", [{ ...rule, files: [] }]],
      ["a file glob that climbs out", [{ ...rule, files: ["../x"] }]],
      ["an absolute file glob", [{ ...rule, files: ["/abs"] }]],
      ["a ** inside a glob", [{ ...rule, files: ["a/**/b"] }]],
      ["a notUnder that is no folder", [{ ...rule, notUnder: ["vendor"] }]],
      ["nine entries", Array.from({ length: 9 }, () => rule)],
      ["not a list", { ...rule }],
      ["detect on API 2", [rule], 2],
    ];
    for (const [name, detect, apiVersion] of hostile) {
      assert.throws(() => validateManifest(manifest(detect, apiVersion)), /detect/, name);
    }
  });
});

describe("a port's record", () => {
  it("studio.json's portedFrom is read by shape only: what is malformed is dropped, at most 32 kept", () => {
    const ok = { id: "web-game", path: ".", source: "core" };
    const table: Array<[string, unknown, unknown[]]> = [
      ["not a list", { ...ok }, []],
      ["text", "web-game", []],
      ["a list of one", [ok], [ok]],
      ["an entry that is not an object", [ok, "web-game", 7, null, [ok]], [ok]],
      [
        "a bad id",
        [
          { ...ok, id: "Web Game" },
          { ...ok, id: "" },
          { ...ok, id: 3 },
        ],
        [],
      ],
      [
        "a path that climbs",
        [
          { ...ok, path: "../elsewhere" },
          { ...ok, path: "a/../../b" },
          { ...ok, path: "a\\..\\b" },
        ],
        [],
      ],
      [
        "a path with a NUL or a newline",
        [
          { ...ok, path: "a\u0000b" },
          { ...ok, path: "a\nb" },
        ],
        [],
      ],
      ["a path of 2000 characters", [{ ...ok, path: "a".repeat(2000) }], []],
      ["an empty path", [{ ...ok, path: "" }], []],
      [
        "no source, or an unknown one, reads as the core table's",
        [
          { id: "web-game", path: "." },
          { ...ok, source: "elsewhere" },
        ],
        [ok, ok],
      ],
      ["a plugin source with a bad id", [{ ...ok, source: "plugin:../x" }], [ok]],
      ["a plugin source", [{ ...ok, source: "plugin:toy-engine" }], [{ ...ok, source: "plugin:toy-engine" }]],
    ];
    for (const [name, raw, facts] of table) assert.deepEqual(parsePortedFrom(raw), facts, name);
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `kind-${i}`, path: ".", source: "core" }));
    assert.deepEqual(parsePortedFrom(many), many.slice(0, 32), "at most 32");
  });

  it("two ports in a row merge into one record, each fact once, and every other key stays", async () => {
    const lite = await coreLite();
    try {
      const game = await lite.core.games.scaffold("twice");
      const file = path.join(game.dir, "studio.json");
      const before = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      const web = { id: "web-game", path: ".", source: FactSource.Core };
      const site = { id: "web-game", path: "site", source: FactSource.Core };
      await lite.core.games.recordPort(game.name, [web]);
      await lite.core.games.recordPort(game.name, [web, site]);
      await lite.core.games.recordPort(game.name, []);
      const after = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      assert.deepEqual(after.portedFrom, [web, site]);
      for (const key of ["name", "title", "createdAt", "contractVersion"])
        assert.deepEqual(after[key], before[key], `${key} stays`);
    } finally {
      lite.core.plugins.cancel();
      await lite.close();
    }
  });
});

describe("a listed game's facts", () => {
  let lite: CoreLite;
  before(async () => {
    lite = await coreLite();
  });
  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });
  const listed = async (name: string) => {
    const game = (await lite.core.games.list()).find((g) => g.name === name);
    assert.ok(game, `${name} is listed`);
    return game;
  };
  /** The game's facts as `id@path:source`. */
  const factsOf = async (name: string) =>
    ((await listed(name)) as { facts?: Array<{ id: string; path: string; source: string }> }).facts?.map(
      (fact) => `${fact.id}@${fact.path}:${fact.source}`,
    );

  it("a game lists its facts: the link reads as one, and old records, ports and an untouched starter never count", async () => {
    const kite = await lite.core.games.scaffold("kite");
    assert.deepEqual(await factsOf(kite.name), ["web-game@.:core"], "a template game is a web game");
    assert.equal((await listed(kite.name)).web, true);
    await lite.core.games.rememberScaffold(kite.name);
    assert.deepEqual(await factsOf(kite.name), [], "an untouched starter is no kind yet");
    assert.equal((await listed(kite.name)).web, false);
    await writeFile(path.join(kite.dir, "src", "main.js"), "// the first build\n");
    assert.deepEqual(await factsOf(kite.name), ["web-game@.:core"], "a touched starter is a web game");

    const linked = await lite.core.games.scaffold("linked");
    await mkdir(path.join(linked.dir, "unreal"));
    const uproject = path.join(linked.dir, "unreal", "X.uproject");
    await writeFile(uproject, "{}\n");
    await writeEngineBinding(linked.dir, uproject, UNREAL_ENGINE.id, ENGINES);
    assert.deepEqual(
      await factsOf(linked.name),
      [`${CoreFact.UnrealProject}@unreal:${FactSource.Link}`],
      "the link is the fact, and the template beside it no web game",
    );

    const ported = await lite.core.games.scaffold("ported");
    await writeFile(path.join(ported.dir, "Y.uproject"), "{}\n");
    const meta = JSON.parse(await readFile(path.join(ported.dir, "studio.json"), "utf8")) as object;
    const portedFrom = [{ id: CoreFact.WebGame, path: ".", source: FactSource.Core }];
    await writeFile(path.join(ported.dir, "studio.json"), `${JSON.stringify({ ...meta, portedFrom }, null, 2)}\n`);
    assert.deepEqual(await factsOf(ported.name), ["unreal-project@.:core"], "the web files stay as the reference");
    assert.deepEqual((await listed(ported.name)).portedFrom, portedFrom);
  });

  it("a Unity or Godot game's web version in web/ is its web game, never hidden by the web starter at its root", async () => {
    const portedFrom = [{ id: CoreFact.WebGame, path: ".", source: FactSource.Core }];
    /** A game New game made from the web starter, with these files written into it, its port recorded or not. */
    const made = async (name: string, files: string[], ported: boolean) => {
      const game = await lite.core.games.scaffold(name);
      for (const file of files) {
        await mkdir(path.dirname(path.join(game.dir, file)), { recursive: true });
        await writeFile(path.join(game.dir, file), "made by the engine\n");
      }
      const meta = JSON.parse(await readFile(path.join(game.dir, "studio.json"), "utf8")) as object;
      if (ported)
        await writeFile(path.join(game.dir, "studio.json"), `${JSON.stringify({ ...meta, portedFrom }, null, 2)}\n`);
      return game.name;
    };
    const unity = ["unity/ProjectSettings/ProjectVersion.txt", "web/index.html", "web/Build/web.loader.js"];
    const godot = ["godot/project.godot", "web/index.html", "web/index.pck"];
    const rows: Array<[string, string, string[], boolean, string[], string | null]> = [
      [
        "a Unity game with its WebGL build",
        "unity-web",
        unity,
        true,
        ["unity-project@unity:core", "web-game@web:core"],
        "web",
      ],
      [
        "a Godot game with its web export",
        "godot-web",
        godot,
        true,
        ["godot-project@godot:core", "web-game@web:core"],
        "web",
      ],
      [
        "a Unity game whose port Genex never saw",
        "unity-unported",
        unity,
        false,
        ["unity-project@unity:core", "web-game@web:core"],
        "web",
      ],
      [
        "a Unity game with no web build yet keeps what it had",
        "unity-no-web",
        ["unity/ProjectSettings/ProjectVersion.txt"],
        false,
        ["web-game@.:core", "unity-project@unity:core"],
        null,
      ],
      [
        "a web game with a page in web/ stays one web game",
        "web-in-web",
        ["web/index.html"],
        false,
        ["web-game@.:core"],
        null,
      ],
    ];
    for (const [title, name, files, ported, facts, webFolder] of rows) {
      await made(name, files, ported);
      assert.deepEqual(await factsOf(name), facts, title);
      assert.equal(webFolderOf(await listed(name)), webFolder, `${title}: the page Live plays and Publish sends`);
    }
  });

  it("a root page of the folder's own, or a web game built on the starter, keeps its place beside an engine's web build; a linked game and Web/ get theirs", async () => {
    /** A game whose files are these, written into a folder New game left empty or into the web starter. */
    const holding = async (name: string, files: string[], start: "empty" | "starter") => {
      const game = start === "empty" ? await lite.core.games.makeEmpty(name) : await lite.core.games.scaffold(name);
      for (const file of files) {
        await mkdir(path.dirname(path.join(game.dir, file)), { recursive: true });
        await writeFile(path.join(game.dir, file), "the folder's own\n");
      }
      return game;
    };
    const ownUnity = await holding(
      "own-unity",
      ["index.html", "unity/ProjectSettings/ProjectVersion.txt", "web/index.html"],
      "empty",
    );
    assert.deepEqual(await factsOf(ownUnity.name), ["web-game@.:core", "unity-project@unity:core"]);
    assert.equal(webFolderOf(await listed(ownUnity.name)), null, "the folder's own page is its web game");
    const ownGodot = await holding("own-godot", ["index.html", "godot/project.godot", "web/index.html"], "empty");
    assert.deepEqual(await factsOf(ownGodot.name), ["web-game@.:core", "godot-project@godot:core"]);
    assert.equal(webFolderOf(await listed(ownGodot.name)), null, "and a Godot game's");
    const builtUnity = await holding(
      "built-unity",
      ["src/main.js", "unity/ProjectSettings/ProjectVersion.txt", "web/index.html"],
      "starter",
    );
    assert.deepEqual(await factsOf(builtUnity.name), ["web-game@.:core", "unity-project@unity:core"]);
    assert.equal(webFolderOf(await listed(builtUnity.name)), null, "a web game built on the starter keeps its page");
    const builtGodot = await holding(
      "built-godot",
      ["src/main.js", "godot/project.godot", "web/index.html"],
      "starter",
    );
    assert.deepEqual(await factsOf(builtGodot.name), ["web-game@.:core", "godot-project@godot:core"]);
    assert.equal(webFolderOf(await listed(builtGodot.name)), null, "beside a Godot project too");

    const elsewhere = await realpath(await tmpDir("studio-linked-godot-web-"));
    await writeFile(path.join(elsewhere, "project.godot"), "config_version=5\n");
    const linked = await holding("linked-godot-web", ["web/index.html", "web/index.pck"], "starter");
    await writeEngineBinding(linked.dir, path.join(elsewhere, "project.godot"), GODOT_ENGINE.id, ENGINES);
    assert.deepEqual(await factsOf(linked.name), [
      `${CoreFact.GodotProject}@${elsewhere}:${FactSource.Link}`,
      "web-game@web:core",
    ]);
    assert.equal(webFolderOf(await listed(linked.name)), "web", "a linked game's export plays too");

    const cased = await holding(
      "unity-cased-web",
      ["unity/ProjectSettings/ProjectVersion.txt", "Web/index.html", "Web/Build/Web.loader.js"],
      "starter",
    );
    assert.deepEqual(await factsOf(cased.name), ["web-game@Web:core", "unity-project@unity:core"]);
    assert.equal(webFolderOf(await listed(cased.name)), "Web", "Web/ is the same folder");
  });

  it("a link to a project outside the game is one absolute fact, and stands for the game's Unreal project", async () => {
    const elsewhere = await realpath(await tmpDir("studio-outside-uproject-"));
    const outside = path.join(elsewhere, "B.uproject");
    await writeFile(outside, "{}\n");

    const far = await lite.core.games.scaffold("far-link");
    await writeEngineBinding(far.dir, outside, UNREAL_ENGINE.id, ENGINES);
    assert.deepEqual(
      await factsOf(far.name),
      [`${CoreFact.UnrealProject}@${elsewhere}:${FactSource.Link}`],
      "an absolute path, and the template beside it no web game",
    );
    const facts = (await lite.core.games.factsOf(far.name)).map(({ id, path: where }) => ({ id, path: where }));
    assert.deepEqual(scopePaths([CoreFact.UnrealProject], { facts }), [elsewhere], "a scope applies to that folder");

    // A game that made its own project and was then switched to another lists the other one only.
    const switched = await lite.core.games.scaffold("switched-link");
    await mkdir(path.join(switched.dir, "unreal"));
    const own = path.join(switched.dir, "unreal", "A.uproject");
    await writeFile(own, "{}\n");
    await writeEngineBinding(switched.dir, own, UNREAL_ENGINE.id, ENGINES);
    await writeEngineBinding(switched.dir, outside, UNREAL_ENGINE.id, ENGINES);
    assert.deepEqual(
      await factsOf(switched.name),
      [`${CoreFact.UnrealProject}@${elsewhere}:${FactSource.Link}`],
      "the link stands for the game's Unreal project; its own project's files are no second one",
    );
  });

  it("a link to another engine's project is that engine's fact, not Unreal's", async () => {
    await lite.core.plugins.installLocal(TOY_PLUGIN, PluginSourceKind.Local, []);
    const garden = await lite.core.games.scaffold("toy-link");
    await mkdir(path.join(garden.dir, "garden"));
    const toyproj = path.join(garden.dir, "garden", "Garden.toyproj");
    await writeFile(toyproj, "toy\n");
    await writeEngineBinding(garden.dir, toyproj, TOY_ENGINE.id, ENGINES);
    assert.deepEqual(
      await factsOf(garden.name),
      [`toy-project@garden:${FactSource.Link}`],
      "the toy engine's fact at its project's folder, and the template beside it no web game",
    );
  });

  it("a link to a Godot project outside the game is one absolute Godot fact; the game's own godot/ is no second one", async () => {
    const elsewhere = await realpath(await tmpDir("studio-outside-godot-"));
    await writeFile(path.join(elsewhere, "project.godot"), "config_version=5\n");
    const game = await lite.core.games.scaffold("godot-link");
    await mkdir(path.join(game.dir, "godot"));
    await writeFile(path.join(game.dir, "godot", "project.godot"), "config_version=5\n");
    const { binding } = await writeEngineBinding(
      game.dir,
      path.join(elsewhere, "project.godot"),
      GODOT_ENGINE.id,
      ENGINES,
    );
    assert.equal(binding.kind, GameEngine.Godot, "linked as the Godot plugin's engine");
    assert.deepEqual(await factsOf(game.name), [`${CoreFact.GodotProject}@${elsewhere}:${FactSource.Link}`]);
  });
});

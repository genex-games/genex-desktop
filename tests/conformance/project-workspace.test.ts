/**
 * What history leaves out of a project, and where its assets live: by its facts, from Genex's table
 * and its plugins.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { CoreFact, type FactRef, hasFact } from "../../src/shared/project-facts.ts";
import { MEDIA_FORMATS } from "../../src/shared/game-assets.ts";
import {
  type AssetFolder,
  assetFoldersFor,
  deliveryFolderFor,
  publishesAsWebGame,
  webFolderOf,
  ignoreLine,
  ignoreRulesFor,
  isAssetPath,
  type PluginWorkspace,
  ruleGlob,
  ruleMatches,
  saysIgnoreLine,
} from "../../src/shared/project-workspace.ts";
import { ignoreUnrealScratch } from "../../src/plugins/unreal/game-folder.ts";
import { ensureFactIgnoreRules, ensureIgnoreRules, missingIgnoreRules } from "../../src/substrate/nested-repos.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { pluginWorkspaces } from "../../src/substrate/plugins/workspace-manifest.ts";
import { TOY_PLUGIN, TOY_PLUGIN_ID, toyRegistry } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ROOT = ".";
/** The ignore lines a set of facts and plugins writes, in order. */
const linesFor = (facts: FactRef[], plugins: PluginWorkspace[] = []) => ignoreRulesFor(facts, plugins).map(ignoreLine);
const fact = (id: string, at: string): FactRef => ({ id, path: at });

describe("Genex's own table", () => {
  it("places each fact's rules at the fact's folder", async () => {
    assert.deepEqual(linesFor([fact(CoreFact.UnrealProject, ROOT)]), [
      "/Saved/",
      "/Intermediate/",
      "/DerivedDataCache/",
      "/Binaries/",
      "Plugins/*/Intermediate/",
      "Plugins/*/Binaries/",
    ]);

    // A project inside the game gets the very lines the Unreal plugin writes for it, its Python
    // caches aside.
    const game = await tmpDir("studio-workspace-unreal-");
    await ignoreUnrealScratch(game);
    const plugins = (await readFile(path.join(game, ".gitignore"), "utf8")).split("\n").filter(Boolean);
    assert.deepEqual(
      linesFor([fact(CoreFact.UnrealProject, "unreal")]),
      plugins.filter((line) => line !== "__pycache__/"),
    );

    const godot = linesFor([fact(CoreFact.GodotProject, ROOT)]);
    assert.deepEqual(godot, ["/.godot/"]);
    assert.ok(!godot.some((line) => line.includes(".import")), "Godot needs its import files in history");
    assert.deepEqual(linesFor([fact(CoreFact.BlenderAssets, "props")]), ["props/**/*.blend1", "props/**/*.blend2"]);
    assert.deepEqual(linesFor([fact(CoreFact.BlenderAssets, ROOT)]), ["*.blend1", "*.blend2"]);
    assert.deepEqual(linesFor([fact(CoreFact.WebGame, ROOT)]), [], "the generic rules are the web rules");
    assert.deepEqual(linesFor([fact(CoreFact.UnrealProject, ROOT), fact(CoreFact.UnrealPlugin, ROOT)]), [
      "/Saved/",
      "/Intermediate/",
      "/DerivedDataCache/",
      "/Binaries/",
      "Plugins/*/Intermediate/",
      "Plugins/*/Binaries/",
    ]);
    assert.deepEqual(linesFor([fact(CoreFact.UnityProject, "game"), fact(CoreFact.WebGame, "site")]), [
      "game/Library/",
      "game/Temp/",
      "game/Logs/",
      "game/obj/",
      "game/UserSettings/",
      "game/Builds/",
    ]);
  });

  it("matches a file against a placed rule as its ignore line does", () => {
    const [saved] = ignoreRulesFor([fact(CoreFact.UnrealProject, "unreal")], []);
    assert.ok(saved);
    assert.equal(ruleGlob(saved), "unreal/Saved/**");
    assert.equal(ruleMatches("unreal/Saved/Logs/a.log", saved), true);
    assert.equal(ruleMatches("unreal/Savedx/a", saved), false);
    assert.equal(ruleMatches("Saved/a", saved), false);
    const [backup] = ignoreRulesFor([fact(CoreFact.BlenderAssets, "my props")], []);
    assert.ok(backup);
    assert.equal(ruleGlob(backup), "my props/**/*.blend1");
    assert.equal(ruleMatches("my props/a/crate.blend1", backup), true);
    assert.equal(ruleMatches("my props/crate.blend", backup), false);
    assert.equal(ruleMatches("props/crate.blend1", backup), false);
    assert.equal(saysIgnoreLine("Saved", "/Saved/"), true);
    assert.equal(saysIgnoreLine(" Saved/ ", "/Saved/"), true);
    assert.equal(saysIgnoreLine("Saved/Logs/", "/Saved/"), false);
  });

  it("a fact in a folder it cannot name safely gets no rule", () => {
    const bases = ["a\nb", "*", "!x", "#x", "../x", "/abs", " x", "a/./b", "x ", "a//b", "C:\\x"];
    for (const base of bases)
      assert.deepEqual(linesFor([fact(CoreFact.UnrealProject, base)]), [], JSON.stringify(base));
    assert.deepEqual(linesFor([fact(CoreFact.UnrealProject, "My Game")])[0], "My Game/Saved/", "inner spaces are fine");
  });
});

describe("a plugin's workspace", () => {
  /** The smallest manifest that loads, with the given sections. */
  const manifest = (sections: Record<string, unknown>, apiVersion = 3) => ({
    apiVersion,
    id: "workspace-test",
    version: "1.0.0",
    name: "Workspace test",
    publisher: "Genex tests",
    description: "A manifest whose workspace and assets are under test.",
    backend: "backend.mjs",
    capabilities: [],
    tools: [],
    skills: [],
    panels: [],
    settings: [],
    actions: [],
    detect: [{ fact: "toy-project", files: ["**/*.toyproj"] }],
    ...sections,
  });

  it("a plugin's workspace reaches its own facts, and a malformed one is refused", () => {
    const raw = JSON.parse(readFileSync(path.join(TOY_PLUGIN, "plugin.json"), "utf8")) as Record<string, unknown>;
    const kept = validateManifest(raw);
    assert.deepEqual(kept.workspace, raw.workspace, "the manifest keeps workspace");
    assert.deepEqual(kept.assets, raw.assets, "the manifest keeps assets");

    const toy = pluginWorkspaces(kept);
    assert.deepEqual(linesFor([fact("toy-project", ROOT)], toy), ["/Cache/"]);
    assert.deepEqual(linesFor([fact("toy-project", "sub")], toy), ["sub/Cache/"]);
    assert.deepEqual(linesFor([fact(CoreFact.WebGame, ROOT)], toy), [], "a game without the plugin's facts");
    const named = pluginWorkspaces(
      validateManifest(manifest({ workspace: { facts: ["web-game"], ignore: [".cache/"] } })),
    );
    assert.deepEqual(linesFor([fact(CoreFact.WebGame, "site"), fact("toy-project", ROOT)], named), ["site/.cache/"]);

    const pattern = (ignore: unknown) => ({ workspace: { ignore } });
    const hostile: Array<[string, Record<string, unknown>, number?]> = [
      ...["*", "**/*", "*/", "../x/", "/x/", "a/**/b", "!keep", "#c", "a?", "[ab]", "a b/"].map(
        (glob): [string, Record<string, unknown>] => [`the pattern ${glob}`, pattern([glob])],
      ),
      ...["studio.json", ".git/", ".gitignore", "references/", "**/.studio/", "a/b/c/d/e/f/g"].map(
        (glob): [string, Record<string, unknown>] => [`the pattern ${glob}`, pattern([glob])],
      ),
      ...[".*", ".git*", "*.json", "studio.*", "ref*/", "**/.git*", "**/x/.*"].map(
        (glob): [string, Record<string, unknown>] => [`the pattern ${glob}`, pattern([glob])],
      ),
      // A case-insensitive disk reads these as Genex's own names, and a session loads `.claude/`.
      ...["Studio.json", "STUDIO.JSON", "References/", ".GIT/", ".claude/", "**/.Claude/", "a/.claude/", "Ref*/"].map(
        (glob): [string, Record<string, unknown>] => [`the pattern ${glob}`, pattern([glob])],
      ),
      ["17 entries", pattern(Array.from({ length: 17 }, (_, i) => `cache${i}/`))],
      ["a pattern that is no string", pattern([7])],
      ["an empty section", { workspace: {} }],
      ["empty lists only", { workspace: { ignore: [], copySkip: [] } }],
      ["an unknown key", { workspace: { ignore: ["Cache/"], keep: ["x"] } }],
      ["workspace on API 2", { detect: undefined, workspace: { facts: ["toy-project"], ignore: ["Cache/"] } }, 2],
      ["a section with no facts on a plugin with no detect", { detect: undefined, ...pattern(["Cache/"]) }],
      ["a fact id that is not one", { workspace: { facts: ["Toy"], ignore: ["Cache/"] } }],
      ["an empty facts list", { workspace: { facts: [], ignore: ["Cache/"] } }],
      ["the folder ../up", { assets: { folders: ["../up"] } }],
      ...[".git", ".studio", "a/.git", "references", "a/references", ".cache", "References", "a/REFERENCES"].map(
        (folder): [string, Record<string, unknown>] => [`the folder ${folder}`, { assets: { folders: [folder] } }],
      ),
      ["no folders", { assets: { folders: [] } }],
      ["the format .png", { assets: { folders: ["art"], formats: [".png"] } }],
      ["the format PNG", { assets: { folders: ["art"], formats: ["PNG"] } }],
      ["assets on API 2", { detect: undefined, assets: { facts: ["toy-project"], folders: ["art"] } }, 2],
      ["assets with no facts on a plugin with no detect", { detect: undefined, assets: { folders: ["art"] } }],
    ];
    for (const [name, sections, apiVersion] of hostile) {
      const section = "assets" in sections ? /assets/ : /workspace/;
      assert.throws(() => validateManifest(manifest(sections, apiVersion)), section, name);
    }
  });
});

describe("the registry's sections", () => {
  it("hands over the enabled plugins' sections only", async () => {
    const registry = await toyRegistry();
    await registry.setEnabled(TOY_PLUGIN_ID, true);
    assert.deepEqual(registry.workspaceSections(), [
      {
        pluginId: TOY_PLUGIN_ID,
        facts: ["toy-project"],
        ignore: ["Cache/"],
        copySkip: ["Cache/", "Exports/"],
        assets: { folders: ["scenes"], formats: ["toyscene"] },
      },
    ]);
    await registry.setEnabled(TOY_PLUGIN_ID, false);
    assert.deepEqual(registry.workspaceSections(), [], "a plugin that is off adds no rules");
  });
});

/** Today's folders, which every game keeps. */
const DEFAULTS: AssetFolder[] = [
  { folder: "assets", formats: MEDIA_FORMATS },
  { folder: "public/assets", formats: MEDIA_FORMATS },
];
const BLENDER = [...new Set(["blend", ...MEDIA_FORMATS])];
const toy: PluginWorkspace = {
  pluginId: TOY_PLUGIN_ID,
  facts: ["toy-project"],
  ignore: [],
  copySkip: [],
  assets: { folders: ["scenes", "."], formats: ["toyscene"] },
};

/** Facts and plugins, and the folders they keep assets in. */
const ASSET_FOLDER_CASES: Array<[string, FactRef[], PluginWorkspace[], AssetFolder[]]> = [
  ["no facts: today's folders", [], [], DEFAULTS],
  ["a web game at the root: today's folders, once", [fact(CoreFact.WebGame, ROOT)], [], DEFAULTS],
  [
    "a web game in site/",
    [fact(CoreFact.WebGame, "site")],
    [],
    [
      ...DEFAULTS,
      { folder: "site/assets", formats: MEDIA_FORMATS },
      { folder: "site/public/assets", formats: MEDIA_FORMATS },
    ],
  ],
  [
    "Blender files in props/",
    [fact(CoreFact.BlenderAssets, "props")],
    [],
    [...DEFAULTS, { folder: "props", formats: BLENDER }],
  ],
  [
    "an Unreal project's own files never fill Assets: only the folders agents bring media into",
    [fact(CoreFact.UnrealProject, ROOT), fact(CoreFact.UnrealPlugin, ROOT)],
    [],
    DEFAULTS,
  ],
  [
    "a Unity project in game/",
    [fact(CoreFact.UnityProject, "game")],
    [],
    [...DEFAULTS, { folder: "game/Assets", formats: MEDIA_FORMATS }],
  ],
  [
    "one folder with two format sets is kept once for each",
    [fact(CoreFact.UnityProject, ROOT), fact("toy-project", ROOT)],
    [{ ...toy, assets: { folders: ["Assets", "Assets"], formats: ["toyscene"] } }],
    [...DEFAULTS, { folder: "Assets", formats: MEDIA_FORMATS }, { folder: "Assets", formats: ["toyscene"] }],
  ],
  [
    "a plugin's folders at its fact's folder",
    [fact("toy-project", "levels")],
    [toy],
    [...DEFAULTS, { folder: "levels/scenes", formats: ["toyscene"] }, { folder: "levels", formats: ["toyscene"] }],
  ],
  ["a plugin reaches only its own facts", [fact(CoreFact.WebGame, ROOT)], [toy], DEFAULTS],
  [
    "a plugin's folders with no formats take any file",
    [fact("toy-project", ROOT)],
    [{ ...toy, assets: { folders: ["art"] } }],
    [...DEFAULTS, { folder: "art" }],
  ],
  ["a fact in a folder it cannot name safely adds none", [fact(CoreFact.BlenderAssets, "../out")], [], DEFAULTS],
  ["a linked fact outside the game adds none", [fact(CoreFact.UnityProject, "/elsewhere")], [], DEFAULTS],
];

/** Facts, and the folder a plugin's delivered files land in (null: Genex's default, the game's root). */
const DELIVERY_CASES: Array<[string, FactRef[], string | null]> = [
  ["no facts", [], null],
  ["a web game at the root", [fact(CoreFact.WebGame, ROOT)], null],
  ["a Godot project in godot/: its own folder, where res:// reaches", [fact(CoreFact.GodotProject, "godot")], "godot"],
  ["a Godot project at the root", [fact(CoreFact.GodotProject, ROOT)], ROOT],
  [
    "a web game at the root beside a Godot project keeps the root",
    [fact(CoreFact.GodotProject, "godot"), fact(CoreFact.WebGame, ROOT)],
    null,
  ],
  ["a web game in a folder doesn't", [fact(CoreFact.WebGame, "web"), fact(CoreFact.GodotProject, "godot")], "godot"],
  ["an Unreal project keeps the root", [fact(CoreFact.UnrealProject, ROOT)], null],
  ["a Godot project it cannot name safely", [fact(CoreFact.GodotProject, "../out")], null],
  ["a linked Godot project outside the game", [fact(CoreFact.GodotProject, "/elsewhere")], null],
];

describe("where a project's assets live", () => {
  it("delivers a plugin's files where the game's engine reads them", () => {
    for (const [name, facts, folder] of DELIVERY_CASES) assert.equal(deliveryFolderFor(facts), folder, name);
  });

  it("plays and publishes a web game in a folder only when there is none at the root", () => {
    const rows: Array<[string, FactRef[], string | null]> = [
      ["a web game at the root", [fact(CoreFact.WebGame, ROOT), fact(CoreFact.WebGame, "web")], null],
      ["a Godot game's web export", [fact(CoreFact.GodotProject, "godot"), fact(CoreFact.WebGame, "web")], "web"],
      ["a Godot game with none", [fact(CoreFact.GodotProject, "godot")], null],
      ["a folder it cannot name safely", [fact(CoreFact.WebGame, "../web")], null],
    ];
    for (const [name, facts, folder] of rows) {
      assert.equal(webFolderOf({ facts }), folder, name);
      assert.equal(publishesAsWebGame({ facts }), folder !== null || hasFact(facts, CoreFact.WebGame, ROOT), name);
    }
    assert.equal(webFolderOf({ facts: [] }), null, "a game with no kind yet is served at its root");
  });

  it("finds each fact's asset folders", () => {
    for (const [name, facts, plugins, folders] of ASSET_FOLDER_CASES) {
      assert.deepEqual(assetFoldersFor(facts, plugins), folders, name);
    }
  });

  it("tells an asset by its folder and, where the folder names them, its format", () => {
    const folders = assetFoldersFor([fact(CoreFact.UnrealProject, ROOT), fact(CoreFact.BlenderAssets, "props")], []);
    const table: Array<[string, boolean]> = [
      ["assets/a.png", true],
      ["assets/notes.txt", false],
      ["public/assets/x.glb", true],
      ["Content/Hero.uasset", false],
      ["Content/Maps/Main.umap", false],
      ["Content/notes.txt", false],
      ["Saved/x.uasset", false],
      ["props/crate.blend", true],
      ["props/crate.blend1", false],
      ["propsx/crate.blend", false],
      ["Contentx/Hero.uasset", false],
      ["assets", false],
      ["", false],
    ];
    for (const [file, asset] of table) assert.equal(isAssetPath(file, folders), asset, file);
    const unity = assetFoldersFor([fact(CoreFact.UnityProject, ROOT)], []);
    const companions: Array<[string, boolean]> = [
      ["Assets/m/car.bin", true],
      ["Assets/m/car.mtl", true],
      ["Assets/m/car.cs", false],
      ["Assets/.cache/car.png", false],
      ["Content/car.bin", false],
    ];
    for (const [file, asset] of companions)
      assert.equal(isAssetPath(file, unity), asset, `a model's companion ${file}`);
    assert.equal(isAssetPath("Content/car.bin", folders), false, "a folder of engine packages lists no companions");
    const anywhere = [{ folder: ROOT, formats: ["png"] }];
    assert.equal(isAssetPath("deep/in/it.PNG", anywhere), true, "the root folder reaches any depth; case is ignored");
    assert.equal(isAssetPath("deep/in/it.jpg", anywhere), false);
    // A case-insensitive disk opens these as the folders the walk never enters.
    for (const file of ["SAVED/a.png", "References/a.png", "Node_Modules/p/a.png", "a/DIST/a.png", "Saved./a.png"])
      assert.equal(isAssetPath(file, anywhere), false, `${file} is in a folder the walk never enters`);
    assert.equal(isAssetPath("art/References/a.png", anywhere), true, "mood boards live at the root only");
  });
});

describe("writing the ignore file", () => {
  it("never writes through a linked ignore file", async () => {
    const root = await tmpDir("studio-workspace-ignore-");
    const outside = path.join(root, "outside.txt");
    const original = "mine\n";
    await writeFile(outside, original);
    const linked = path.join(root, "linked");
    await mkdir(linked);
    await symlink(outside, path.join(linked, ".gitignore"));
    await ensureIgnoreRules(linked, "", ["/Saved/"]);
    assert.equal(await readFile(outside, "utf8"), original, "the file the link names is untouched");
    assert.ok((await lstat(path.join(linked, ".gitignore"))).isSymbolicLink(), "the link stays");
    assert.equal(await readlink(path.join(linked, ".gitignore")), outside);

    const folder = path.join(root, "folder");
    await mkdir(path.join(folder, ".gitignore"), { recursive: true });
    await ensureIgnoreRules(folder, "", ["/Saved/"]);
    assert.ok((await lstat(path.join(folder, ".gitignore"))).isDirectory(), "a folder named so is left alone");

    const fresh = path.join(root, "fresh");
    await mkdir(fresh);
    await ensureIgnoreRules(fresh, "# header\n", ["/Saved/"]);
    const written = (await readFile(path.join(fresh, ".gitignore"), "utf8")).split("\n");
    assert.equal(written[0], "# header");
    assert.ok(written.includes("node_modules"), "the generic rules");
    assert.equal(written.filter(Boolean).at(-1), "/Saved/", "then the fact's");

    const own = path.join(root, "own");
    await mkdir(own);
    await writeFile(path.join(own, ".gitignore"), "Saved/\n");
    await ensureIgnoreRules(own, "", ["/Saved/", "/Binaries/"]);
    const topped = (await readFile(path.join(own, ".gitignore"), "utf8")).split("\n");
    assert.equal(topped[0], "Saved/", "what the folder wrote stays first");
    assert.ok(!topped.includes("/Saved/"), "a rule already there is not added again");
    assert.equal(topped.filter(Boolean).at(-1), "/Binaries/");
  });

  it("a fact's line is not added where the file already says that path, in any spelling", async () => {
    const root = await tmpDir("studio-workspace-spelling-");
    const facts = ["/Saved/", "/Intermediate/", "/Library/", "/Temp/", "/Logs/"];
    const cases: Array<[string, string, string[]]> = [
      ["the engines' own templates", "Saved/*\n!Saved/Config/\n/[Ll]ibrary/\n[Tt]emp/\n", ["/Intermediate/", "/Logs/"]],
      ["an exception of the folder itself", "!Saved/\n", ["/Intermediate/", "/Library/", "/Temp/", "/Logs/"]],
      ["an exception inside the folder", "!Saved/Config/\n", ["/Intermediate/", "/Library/", "/Temp/", "/Logs/"]],
      ["any depth and folder contents", "**/Intermediate\nLibrary/**\n", ["/Saved/", "/Temp/", "/Logs/"]],
      [
        "a narrower rule of the person's",
        "Saved/Logs/\n# Temp/\n",
        ["/Saved/", "/Intermediate/", "/Library/", "/Temp/", "/Logs/"],
      ],
    ];
    for (const [name, text, added] of cases) {
      const dir = path.join(root, name.replaceAll(" ", "-"));
      await mkdir(dir);
      await writeFile(path.join(dir, ".gitignore"), text);
      await ensureIgnoreRules(dir, "", facts);
      const after = await readFile(path.join(dir, ".gitignore"), "utf8");
      assert.ok(after.startsWith(text), `${name}: the person's lines stay as they are`);
      const appended = after.slice(text.length).split("\n").filter(Boolean);
      assert.deepEqual(
        appended.filter((line) => facts.includes(line)),
        added,
        name,
      );
    }
  });

  it("a line of the person's that no pattern can be made of says nothing, as git reads it", () => {
    const table: Array<[string, string, boolean]> = [
      // git's class with a reversed range matches nothing, and its negation any character.
      ["[z-a]", "/Saved/", false],
      ["[z-a]aved/", "/Saved/", false],
      ["[!z-a]*", "/Saved/", true],
      ["[^z-a]aved", "/Saved/", true],
      ["[a-\\]x", "/Saved/", false],
      ["[S-Sz-a]aved", "/Saved/", true],
    ];
    for (const [present, line, says] of table) assert.equal(saysIgnoreLine(present, line), says, present);
    assert.deepEqual(
      missingIgnoreRules("[z-a]\n[!z-a]/\n", ["/Saved/"]).filter((line) => line === "/Saved/"),
      ["/Saved/"],
    );
  });

  it("a top-up of the facts' lines alone leaves the generic rules and a missing file as they are", async () => {
    const root = await tmpDir("studio-workspace-facts-only-");
    const web = path.join(root, "web");
    await mkdir(web);
    await writeFile(path.join(web, ".gitignore"), "node_modules\n");
    await ensureFactIgnoreRules(web, []);
    assert.equal(await readFile(path.join(web, ".gitignore"), "utf8"), "node_modules\n", "no fact lines, no write");
    await ensureFactIgnoreRules(web, ["/Saved/"]);
    assert.equal(
      await readFile(path.join(web, ".gitignore"), "utf8"),
      "node_modules\n/Saved/\n",
      "the fact's line only",
    );
    const gone = path.join(root, "gone");
    await mkdir(gone);
    await ensureFactIgnoreRules(gone, ["/Saved/"]);
    await assert.rejects(lstat(path.join(gone, ".gitignore")), "a deleted ignore file is not made again");
  });
});

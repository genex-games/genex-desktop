/**
 * The Unreal plugin's `new-plugin`: in an open game with no Unreal project yet, a host project from
 * Epic's Blank template (set up with the Genex editor helper and linked to the game), a C++ module of
 * the host's own, and `unreal/Plugins/<Name>/` from one of Epic's plugin templates with its .uplugin,
 * enabled in the host's .uproject, as Epic's New Plugin wizard lays one out. UnrealBuildTool's
 * sandbox lets the host's build write each project plugin's build output and nothing else of it.
 * Everything runs on a fake engine (`helpers/unreal-fake-engine.ts`); nothing starts Unreal or UBT.
 */
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { CreateError, CreateErrorCode } from "../../src/plugins/unreal/create-project.ts";
import { chosenProject, listSetUpProjects, rememberChoice } from "../../src/plugins/unreal/editor-port.ts";
import { removeGameProjectFolder, undoGameProjectFolder } from "../../src/plugins/unreal/game-folder.ts";
import { planPlugin, writePlugin } from "../../src/plugins/unreal/plugin-scaffold.ts";
import { type BuildSandboxRequest, prepareBuildSandbox } from "../../src/plugins/unreal/ubt-sandbox.ts";
import { compileEditor, projectPluginDirs, systemRunCommand } from "../../src/plugins/unreal/ubt.ts";
import { tmpDir } from "../helpers/tmp.ts";
import {
  ENGINE_MODULE_NAME,
  ENGINE_PLUGIN_NAME,
  ICON_PNG,
  put,
  unrealBackendFixture,
  tree,
} from "../helpers/unreal-fake-engine.ts";

const NEW_PLUGIN = "new-plugin";
const SEPARATE_LINKS = process.platform === "win32" && "links need privileges on Windows";
const SANDBOX = process.platform === "darwin" ? false : "the build sandbox is macOS's sandbox-exec";

/** The .uplugin Genex writes for a plugin named `name` whose module is of `type`, as Epic's wizard does. */
const descriptor = (name: string, type: string) =>
  `${JSON.stringify(
    {
      FileVersion: 3,
      Version: 1,
      VersionName: "1.0",
      FriendlyName: name,
      Category: "Other",
      CanContainContent: true,
      EnabledByDefault: true,
      Installed: false,
      Modules: [{ Name: name, Type: type, LoadingPhase: "Default" }],
    },
    null,
    "\t",
  )}\n`;

describe("the Unreal plugin's new-plugin tool", () => {
  it("new-plugin makes a host project with the plugin in Plugins/<Name>, linked and enabled", async () => {
    const f = await unrealBackendFixture();
    const answer = await f.call(NEW_PLUGIN, { name: "LevelTools", template: "window" });
    const unreal = await realpath(path.join(f.dir, "unreal"));
    const host = path.join(unreal, "LevelToolsHost.uproject");
    assert.equal(typeof answer, "string");
    assert.match(String(answer), /unreal\/Plugins\/LevelTools\//);
    assert.match(String(answer), /LevelToolsHost/);
    assert.deepEqual(f.linked, [{ project: host }], "the game builds in the host from now on");
    assert.deepEqual(f.launches, [], "Unreal is not opened");

    const project = JSON.parse(await readFile(host, "utf8"));
    assert.deepEqual(project.Modules, [{ Name: "LevelToolsHost", Type: "Runtime", LoadingPhase: "Default" }]);
    assert.ok(
      project.Plugins.some((p: { Name: string; Enabled: boolean }) => p.Name === "LevelTools" && p.Enabled),
      "the plugin is enabled in the host",
    );
    assert.ok(
      project.Plugins.some((p: { Name: string }) => p.Name === "ModelContextProtocol"),
      "the host is set up",
    );
    await readFile(path.join(unreal, "Source", "LevelToolsHost", "LevelToolsHost.Build.cs"));
    await readFile(path.join(unreal, "Plugins", "GenexEditorHelper", "GenexEditorHelper.uplugin"));

    const plugin = path.join(unreal, "Plugins", "LevelTools");
    assert.equal(await readFile(path.join(plugin, "LevelTools.uplugin"), "utf8"), descriptor("LevelTools", "Editor"));
    const files = Object.keys(await tree(plugin))
      .filter((file) => !file.endsWith("/"))
      .sort();
    assert.deepEqual(files, [
      "LevelTools.uplugin",
      "Resources/Icon128.png",
      "Resources/PlaceholderButtonIcon.svg",
      "Source/LevelTools/LevelTools.Build.cs",
      "Source/LevelTools/Private/LevelTools.cpp",
      "Source/LevelTools/Public/LevelTools.h",
      "Source/LevelTools/Public/LevelToolsCommands.h",
    ]);
    const source = await readFile(path.join(plugin, "Source", "LevelTools", "Private", "LevelTools.cpp"), "utf8");
    assert.match(source, /IMPLEMENT_MODULE\(FLevelToolsModule, LevelTools\)/);
    for (const file of files.filter((f) => /\.(cs|h|cpp)$/.test(f)))
      assert.doesNotMatch(await readFile(path.join(plugin, file), "utf8"), /PLUGIN_NAME/, file);
    assert.deepEqual(await readFile(path.join(plugin, "Resources", "Icon128.png")), ICON_PNG, "bytes kept");
    const ignored = (await readFile(path.join(f.dir, ".gitignore"), "utf8")).split("\n");
    assert.ok(ignored.includes("unreal/Plugins/*/Binaries/"), "the plugin's build output stays out of history");
  });

  it("each template gives its module type: a window and a toolbar button are editor modules, blank a runtime one", async () => {
    for (const [template, type] of [
      ["toolbar-button", "Editor"],
      ["blank", "Runtime"],
    ]) {
      const f = await unrealBackendFixture();
      await f.call(NEW_PLUGIN, { name: "Snap", template });
      const file = path.join(f.dir, "unreal", "Plugins", "Snap", "Snap.uplugin");
      assert.equal(await readFile(file, "utf8"), descriptor("Snap", type), template);
    }
    const f = await unrealBackendFixture();
    await f.call(NEW_PLUGIN, { name: "Plain" });
    const made = JSON.parse(await readFile(path.join(f.dir, "unreal", "Plugins", "Plain", "Plain.uplugin"), "utf8"));
    assert.equal(made.Modules[0].Type, "Editor", "with no template, an editor window");
  });

  it("a new-plugin that fails after the host is made leaves no host behind and links nothing", async () => {
    const f = await unrealBackendFixture();
    // Epic's Blank template carrying a folder where the plugin goes: the host is made, then the plugin is refused.
    const planted = path.join(f.engine.directory, "Templates", "TP_BlankBP", "Plugins", "LevelTools");
    await put(path.join(planted, "LevelTools.uplugin"), "{}");
    const game = await tree(f.dir);
    const args = { name: "LevelTools", template: "window" };
    await assert.rejects(f.call(NEW_PLUGIN, args), /Plugins\/LevelTools/);
    assert.deepEqual(f.linked, [], "the game keeps its engine");
    await assert.rejects(lstat(path.join(f.dir, "unreal")), { code: "ENOENT" }, "the host it made is gone");
    assert.deepEqual(await tree(f.dir), game, "nothing it made or changed stays in the game, its ignore file included");
    assert.deepEqual(await listSetUpProjects(f.storage), [], "Genex lists no set-up project for the host");
    assert.deepEqual(await readdir(path.join(f.storage, "setup")).catch(() => []), [], "no setup record is kept");

    await rm(path.join(f.engine.directory, "Templates", "TP_BlankBP", "Plugins"), { recursive: true });
    const answer = await f.call(NEW_PLUGIN, args);
    assert.match(String(answer), /unreal\/Plugins\/LevelTools\//);
    assert.equal(f.linked.length, 1, "a second new-plugin is made and linked");
  });

  it("a new-plugin whose game link is refused keeps the panel's choice and leaves no host", async () => {
    const f = await unrealBackendFixture({ refuseLink: new Error("the host refused the link") });
    const before = path.join(f.parent, "Earlier", "Earlier.uproject");
    await rememberChoice(f.storage, before);
    await assert.rejects(f.call(NEW_PLUGIN, { name: "LevelTools" }), /the host refused the link/);
    assert.equal(await chosenProject(f.storage), before, "the person's earlier choice stays");
    await assert.rejects(lstat(path.join(f.dir, "unreal")), { code: "ENOENT" }, "the host it made is gone");
  });

  it("a new-plugin whose panel choice can't be saved after the link keeps the linked host", async () => {
    const f = await unrealBackendFixture();
    // The panel's choice can't be written: its file is a folder.
    await mkdir(path.join(f.storage, "chosen.json"), { recursive: true });
    const answer = await f.call(NEW_PLUGIN, { name: "LevelTools" });
    assert.match(String(answer), /LevelToolsHost/);
    const host = path.join(await realpath(path.join(f.dir, "unreal")), "LevelToolsHost.uproject");
    assert.deepEqual(f.linked, [{ project: host }], "the link stands");
    await readFile(host);
    await readFile(path.join(f.dir, "unreal", "Plugins", "LevelTools", "LevelTools.uplugin"));
  });

  it("a new-plugin whose turn was stopped while it wrote links nothing and leaves no host", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const f = await unrealBackendFixture({ signal: stopped.signal });
    await assert.rejects(f.call(NEW_PLUGIN, { name: "LevelTools" }));
    assert.deepEqual(f.linked, [], "the game keeps its engine");
    assert.equal(await chosenProject(f.storage), undefined, "nothing is chosen");
    await assert.rejects(lstat(path.join(f.dir, "unreal")), { code: "ENOENT" }, "the host it made is gone");
  });

  type Refusal = {
    name: string;
    args?: Record<string, unknown>;
    links?: boolean;
    game?: boolean;
    arrange?: (dir: string, outside: string) => Promise<void>;
  };
  const GOOD = { name: "LevelTools", template: "window" };
  const refusals: Refusal[] = [
    ...[
      "../Evil",
      "Evil/Inner",
      "My Tool",
      "",
      "1Tool",
      "_Tool",
      "Tool__X",
      "class",
      "A".repeat(17),
      "GenexEditorHelper",
      "Core",
      ENGINE_PLUGIN_NAME,
      ENGINE_MODULE_NAME,
    ].map((name): Refusal => ({ name: `the name ${JSON.stringify(name)}`, args: { ...GOOD, name } })),
    { name: "a name that isn't text", args: { ...GOOD, name: 42 } },
    { name: "no name", args: { template: "window" } },
    ...["Advanced", "../Blank", "WINDOW", "content-only"].map(
      (template): Refusal => ({ name: `the template ${JSON.stringify(template)}`, args: { ...GOOD, template } }),
    ),
    { name: "a template that isn't text", args: { ...GOOD, template: ["window"] } },
    { name: "a game that already has an unreal folder", arrange: (dir) => mkdir(path.join(dir, "unreal")) },
    {
      name: "a game whose unreal is a link out of it",
      links: true,
      arrange: (dir, outside) => symlink(outside, path.join(dir, "unreal")),
    },
    { name: "no game open in Genex", game: false },
  ];

  describe("new-plugin refuses a bad name, a taken folder or a game that already has a project, and writes nothing", () => {
    for (const row of refusals)
      it(`for ${row.name}`, { skip: row.links ? SEPARATE_LINKS : false }, async () => {
        const f = await unrealBackendFixture({ game: row.game });
        await row.arrange?.(f.dir, f.outside);
        const witness = async () => ({
          game: await tree(f.dir),
          documents: await tree(f.parent),
          storage: await tree(f.storage),
          outside: await tree(f.outside),
          engine: await tree(f.engine.directory),
        });
        const before = await witness();
        await assert.rejects(f.call(NEW_PLUGIN, row.args ?? GOOD), Error);
        assert.deepEqual(await witness(), before, "nothing made, written or moved");
        assert.deepEqual(f.linked, [], "the game keeps its engine");
        assert.deepEqual(f.launches, [], "Unreal is not opened");
      });
  });
});

describe("removing the folder a failed new-plugin made", () => {
  const ROWS: Array<{ name: string; arrange: (game: string, outside: string) => Promise<void>; removed: boolean }> = [
    {
      name: "a real unreal folder in the game is removed",
      arrange: (game) => put(path.join(game, "unreal", "Host.uproject"), "{}"),
      removed: true,
    },
    { name: "no unreal folder is nothing to do", arrange: async () => {}, removed: false },
    {
      name: "an unreal that is a file is kept",
      arrange: (game) => writeFile(path.join(game, "unreal"), "the person's file\n"),
      removed: false,
    },
    {
      name: "an unreal that is a link out of the game is kept, and nothing behind it is touched",
      arrange: (game, outside) => symlink(outside, path.join(game, "unreal")),
      removed: false,
    },
  ];
  for (const row of ROWS)
    it(row.name, { skip: row.name.includes("link") ? SEPARATE_LINKS : false }, async () => {
      const root = await realpath(await tmpDir("studio-unreal-remove-"));
      const game = path.join(root, "game");
      const outside = path.join(root, "outside");
      await put(path.join(game, ".gitignore"), "node_modules\n");
      await put(path.join(outside, "keep.txt"), "the person's\n");
      await row.arrange(game, outside);
      const before = { outside: await tree(outside), ignore: await readFile(path.join(game, ".gitignore"), "utf8") };
      const unrealBefore = await lstat(path.join(game, "unreal")).catch(() => null);
      await removeGameProjectFolder(game);
      const unrealAfter = await lstat(path.join(game, "unreal")).catch(() => null);
      assert.equal(unrealBefore !== null && unrealAfter === null, row.removed);
      if (!row.removed) assert.equal(unrealAfter?.isSymbolicLink(), unrealBefore?.isSymbolicLink());
      assert.deepEqual(await tree(outside), before.outside, "nothing outside the game changed");
      assert.equal(await readFile(path.join(game, ".gitignore"), "utf8"), before.ignore, "nor the rest of the game");
    });
});

describe("undoing what a failed new-plugin made", () => {
  const NO_CHMOD = (process.platform === "win32" || process.getuid?.() === 0) && "permissions don't hold here";

  it("a refusal that the place was taken keeps what is there: it was never this call's", async () => {
    const game = await realpath(await tmpDir("studio-unreal-undo-"));
    await put(path.join(game, "unreal", "Mine.uproject"), "the person's\n");
    await undoGameProjectFolder(game, new CreateError(CreateErrorCode.NameTaken, "taken"));
    assert.equal(await readFile(path.join(game, "unreal", "Mine.uproject"), "utf8"), "the person's\n");
  });

  it("any other failure removes the folder the call made", async () => {
    const game = await realpath(await tmpDir("studio-unreal-undo-"));
    await put(path.join(game, "unreal", "Host.uproject"), "{}");
    await undoGameProjectFolder(game, new Error("the plugin template is missing"));
    await assert.rejects(lstat(path.join(game, "unreal")), { code: "ENOENT" });
  });

  it("a removal that fails resolves, so why new-plugin failed still reaches the caller", {
    skip: NO_CHMOD,
  }, async () => {
    const game = await realpath(await tmpDir("studio-unreal-undo-"));
    const held = path.join(game, "unreal", "Held");
    await put(path.join(held, "file.txt"), "held\n");
    await chmod(held, 0o500);
    try {
      await undoGameProjectFolder(game, new Error("the plugin template is missing"));
    } finally {
      await chmod(held, 0o700);
    }
    await readFile(path.join(held, "file.txt"));
  });
});

/** A host project with its plugin, the Genex editor helper, a folder with no .uplugin and a link out. */
async function hostProject(root: string) {
  const unreal = path.join(root, "home", "AI Games", "tools", "unreal");
  const plugins = path.join(unreal, "Plugins");
  const outside = path.join(root, "outside-plugin");
  for (const dir of [
    path.join(unreal, "Source"),
    path.join(plugins, "LevelTools", "Source"),
    path.join(plugins, "GenexEditorHelper"),
    path.join(plugins, "Loose"),
    outside,
    path.join(root, "engine"),
  ])
    await mkdir(dir, { recursive: true });
  await writeFile(path.join(unreal, "ToolsHost.uproject"), "{}");
  await writeFile(path.join(plugins, "LevelTools", "LevelTools.uplugin"), "{}");
  await writeFile(path.join(plugins, "LevelTools", "Source", "Tool.cpp"), "// the plugin's code\n");
  await writeFile(path.join(plugins, "GenexEditorHelper", "GenexEditorHelper.uplugin"), "{}");
  await writeFile(path.join(outside, "Elsewhere.uplugin"), "{}");
  if (!SEPARATE_LINKS) await symlink(outside, path.join(plugins, "Elsewhere"));
  return { unreal, plugins, outside, engine: path.join(root, "engine"), home: path.join(root, "home") };
}

describe("a host project's build", () => {
  it("a host build may write its plugins' build output and nothing else of theirs", async () => {
    const root = await realpath(await tmpDir("studio-host-build-"));
    const p = await hostProject(root);
    const plugin = path.join(p.plugins, "LevelTools");
    assert.deepEqual(
      await projectPluginDirs(path.join(p.unreal, "ToolsHost.uproject")),
      [path.join(p.plugins, "GenexEditorHelper"), plugin],
      "plain folders under Plugins/ holding a .uplugin, never through a link",
    );

    const asked: BuildSandboxRequest[] = [];
    const result = await compileEditor({
      engineDir: p.engine,
      projectFile: path.join(p.unreal, "ToolsHost.uproject"),
      module: "ToolsHost",
      platform: "darwin",
      prepareSandbox: async (request) => {
        asked.push(request);
        return { profile: "p", env: {}, cwd: root, dispose: async () => {} };
      },
      run: async () => ({ code: 0, output: "Result: Succeeded" }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(asked[0]?.pluginDirs, [path.join(p.plugins, "GenexEditorHelper"), plugin]);

    const hostile: Array<[string, string[]]> = [
      ["a folder outside the project", [p.outside]],
      ["a relative folder", ["Plugins/LevelTools"]],
      ["the project itself", [p.unreal]],
      ...(SEPARATE_LINKS
        ? []
        : [["a link out of the project", [path.join(p.plugins, "Elsewhere")]] as [string, string[]]]),
      ["a folder that isn't there", [path.join(p.plugins, "Missing")]],
    ];
    for (const [name, pluginDirs] of hostile)
      await assert.rejects(
        prepareBuildSandbox({ projectDir: p.unreal, engineDir: p.engine, xcodeApp: null, home: p.home, pluginDirs }),
        Error,
        name,
      );
  });

  it("in the sandbox, the plugin's Intermediate and Binaries are written and its Source is not", {
    skip: SANDBOX,
  }, async () => {
    const root = await realpath(await tmpDir("studio-host-sandbox-"));
    const p = await hostProject(root);
    const plugin = path.join(p.plugins, "LevelTools");
    const sandbox = await prepareBuildSandbox({
      projectDir: p.unreal,
      engineDir: p.engine,
      xcodeApp: null,
      home: p.home,
      denied: [],
      pluginDirs: [plugin],
    });
    try {
      const run = (script: string) =>
        systemRunCommand("/bin/sh", ["-c", script], { signal: new AbortController().signal, sandbox });
      const built = await run(
        `mkdir -p "${plugin}/Intermediate/Build" "${plugin}/Binaries/Mac" && echo o > "${plugin}/Intermediate/Build/a.o" && echo d > "${plugin}/Binaries/Mac/b.dylib"`,
      );
      assert.equal(built.code, 0, built.output);
      const source = await run(`echo changed > "${plugin}/Source/Tool.cpp"`);
      assert.notEqual(source.code, 0, "the plugin's Source is not written");
      assert.equal(await readFile(path.join(plugin, "Source", "Tool.cpp"), "utf8"), "// the plugin's code\n");
      const other = await run(`echo x > "${p.plugins}/GenexEditorHelper/x.txt"`);
      assert.notEqual(other.code, 0, "a plugin not named is not written");
    } finally {
      await sandbox.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("writing a planned plugin", () => {
  const template = {
    type: "Editor" as const,
    files: [{ relative: "Source/PLUGIN_NAME/Private/PLUGIN_NAME.cpp", bytes: Buffer.from("// PLUGIN_NAME\n") }],
  };
  /** Each row plants a link somewhere on the plugin's way: before the write, or once its folder is made. */
  const plantings: readonly {
    name: string;
    havePlugins: boolean;
    before?: (project: string, outside: string) => Promise<void>;
    between?: (folder: string, outside: string) => Promise<void>;
  }[] = [
    {
      name: "a link planted in the new plugin's folder",
      havePlugins: false,
      between: (folder, outside) => symlink(outside, path.join(folder, "Source")),
    },
    {
      name: "the new plugin's folder swapped for a link",
      havePlugins: false,
      between: async (folder, outside) => {
        await rm(folder, { recursive: true });
        await symlink(outside, folder);
      },
    },
    {
      name: "Plugins/ swapped for a link after the plan",
      havePlugins: true,
      before: async (project, outside) => {
        await rm(path.join(project, "Plugins"), { recursive: true });
        await symlink(outside, path.join(project, "Plugins"));
      },
    },
  ];
  for (const row of plantings) {
    it(`never writes through ${row.name}`, { skip: SEPARATE_LINKS }, async () => {
      const root = await realpath(await tmpDir("studio-plugin-write-"));
      const project = path.join(root, "unreal");
      const outside = path.join(root, "outside");
      await mkdir(project);
      await mkdir(outside);
      if (row.havePlugins) await mkdir(path.join(project, "Plugins"));
      try {
        const plan = await planPlugin(project, "Snap", template as never);
        await row.before?.(project, outside);
        await assert.rejects(
          writePlugin(plan, row.between && ((folder) => row.between?.(folder, outside) ?? Promise.resolve())),
        );
        assert.deepEqual(await readdir(outside), [], "nothing was made or written through the link");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

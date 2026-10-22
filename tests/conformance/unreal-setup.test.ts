/**
 * Set up Unreal: the one step that makes a user's Unreal project ready for Genex, so nobody edits
 * a .uproject or an ini by hand. It finds the engines and recent projects in Epic's own lists,
 * turns on Epic's MCP plugins, makes the editor start its MCP server on the project's own port,
 * installs the Genex editor helper, keeps a copy of every file first, and undoes exactly what it
 * added.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { createUnrealBackend, PanelStep } from "../../src/plugins/unreal/backend.ts";
import { type Launch, type LaunchEnv, systemLaunchEnv } from "../../src/plugins/unreal/editor-launch.ts";
import { UnrealStepId, unrealInstallCard, unrealSteps, XcodeStep } from "../../src/plugins/unreal/engine-steps.ts";
import type { PluginEngineLink } from "../../src/plugin-sdk/index.d.ts";
import { pluginBackendEnv } from "../../src/substrate/plugins/process.ts";
import { editorLogPath, readEditorLog } from "../../src/plugins/unreal/editor-log.ts";
import { chosenProject, derivedPort, listSetUpProjects, SetupStorage } from "../../src/plugins/unreal/editor-port.ts";
import {
  addToolsetPlugins,
  findEngines,
  HelperState,
  helperVersion,
  inspectProject,
  planSetup,
  recentProjects,
  type SetupEnv,
  SetupErrorCode,
  SetupStep,
  setUpProject,
  type ReadEntries,
  systemSetupEnv,
  tasklistShowsEditor,
  undoSetup,
  updateHelper,
} from "../../src/plugins/unreal/setup.ts";
import { type XcodeStatus, XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { createEngineLinks } from "../../src/substrate/plugins/engine-links.ts";
import { ENGINES as ENGINE_CATALOG } from "../helpers/engines.ts";
import { tmpDir } from "../helpers/tmp.ts";

const GIB = 1024 ** 3;
const HELPER = path.resolve("src/plugins/unreal/GenexEditorHelper");
const MCP_SECTION = "[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]";
const SETTINGS_INI = "Saved/Config/MacEditor/EditorPerProjectUserSettings.ini";

/** A .uproject the way Unreal writes one: tabs, a module, and plugins of its own. */
const UPROJECT = `${JSON.stringify(
  {
    FileVersion: 3,
    EngineAssociation: "5.8",
    Category: "",
    Description: "",
    Modules: [{ Name: "Drift", Type: "Runtime", LoadingPhase: "Default" }],
    Plugins: [
      { Name: "ChaosVehiclesPlugin", Enabled: true },
      { Name: "EditorToolset", Enabled: false },
    ],
  },
  null,
  "\t",
)}\n`;
const USER_INI = "[/Script/UnrealEd.EditorPerProjectUserSettings]\nbDisplayDocumentationLink=False\n\n";

/** A Mac without Xcode but with Apple's Command Line Tools. */
const NO_XCODE: XcodeStatus = {
  state: XcodeState.Missing,
  app: null,
  version: null,
  commandLineTools: true,
  supported: null,
  command: null,
};
const READY_XCODE: XcodeStatus = {
  ...NO_XCODE,
  state: XcodeState.Ready,
  app: "/Applications/Xcode.app",
  version: "26.2",
};

function fakeEnv(home: string, overrides: Partial<SetupEnv> = {}): SetupEnv {
  return {
    home,
    platform: "darwin",
    programData: path.join(home, "ProgramData"),
    editorRunning: async () => false,
    portListening: async () => false,
    editorAnswers: async () => false,
    xcode: async () => READY_XCODE,
    freeBytes: async () => 200 * GIB,
    totalMemory: () => 32 * GIB,
    ...overrides,
  };
}

/** Epic's launcher list and the 5.8 editor's recent projects, in a fake home. */
async function fakeEpic(home: string, platform: "darwin" | "win32", recent: Array<[string, string]>) {
  const engines = path.join(home, "Engines");
  await mkdir(path.join(engines, "UE_5.8"), { recursive: true });
  await mkdir(path.join(engines, "UE_5.7"), { recursive: true });
  const dat =
    platform === "win32"
      ? path.join(home, "ProgramData", "Epic", "UnrealEngineLauncher", "LauncherInstalled.dat")
      : path.join(home, "Library", "Application Support", "Epic", "UnrealEngineLauncher", "LauncherInstalled.dat");
  await mkdir(path.dirname(dat), { recursive: true });
  const entry = (app: string, version: string, folder: string) => ({
    InstallLocation: path.join(engines, folder),
    AppVersion: version,
    AppName: app,
  });
  await writeFile(
    dat,
    JSON.stringify({
      InstallationList: [
        entry("UE_5.7", "5.7.1-48512491+++UE5+Release-5.7-Mac", "UE_5.7"),
        entry("UE_5.8", "5.8.3-58210709+++UE5+Release-5.8-Mac", "UE_5.8"),
        entry("UE_5.6", "5.6.0-1+++UE5+Release-5.6-Mac", "UE_5.6-removed"),
        entry("Fortnite", "1.0", "UE_5.8"),
      ],
    }),
  );
  const editorSettings =
    platform === "win32"
      ? path.join(home, "AppData", "Local", "UnrealEngine", "5.8", "Saved", "Config", "WindowsEditor")
      : path.join(
          home,
          "Library",
          "Application Support",
          "Epic",
          "UnrealEngine",
          "5.8",
          "Saved",
          "Config",
          "MacEditor",
        );
  await mkdir(editorSettings, { recursive: true });
  const lines = recent.map(([file, at]) => `RecentlyOpenedProjectFiles=(ProjectName="${file}",LastOpenTime=${at})`);
  await writeFile(
    path.join(editorSettings, "EditorSettings.ini"),
    ["[/Script/UnrealEd.EditorSettings]", ...lines, ""].join("\n"),
  );
}

async function fakeProject(root: string, name = "Drift", options: { ini?: string } = {}) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.uproject`);
  await writeFile(file, UPROJECT);
  if (options.ini !== undefined) {
    await mkdir(path.dirname(path.join(directory, SETTINGS_INI)), { recursive: true });
    await writeFile(path.join(directory, SETTINGS_INI), options.ini);
  }
  return { directory, file };
}

/** Every file under `dir` with a hash of its bytes (links named, not followed): a no-side-effect witness. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    const full = path.join(entry.parentPath, entry.name);
    const key = path.relative(dir, full).split(path.sep).join("/");
    if (entry.isSymbolicLink()) out[key] = "link";
    else if (entry.isFile())
      out[key] = createHash("sha256")
        .update(await readFile(full))
        .digest("hex");
  }
  return out;
}

async function setupFixture(options: { ini?: string } = {}) {
  const root = await tmpDir("studio-unreal-setup-");
  const home = path.join(root, "home");
  const storage = path.join(root, "storage");
  const project = await fakeProject(path.join(root, "Projects"), "Drift", options);
  const env = fakeEnv(home);
  // Setup works on the project's real path (macOS tmp is /var → /private/var), so its port comes from that.
  const port = derivedPort(await realpath(project.file));
  return { root, home, storage, project, env, port, options: { env, helper: HELPER, storage } };
}

/** A launcher for tests that never open, quit or get Unreal: any launch fails the test. */
const noLaunch = (root: string): LaunchEnv => ({
  open: async (launch) => {
    throw new Error(`unexpected launch of ${launch.command}`);
  },
  applications: path.join(root, "Applications"),
  now: () => Date.now(),
});

/** Whether anything, even an empty folder, is at `file`. */
const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  );

/** What the bridge would find in storage: each set-up project's name and port. */
const setUp = async (storage: string) => (await listSetUpProjects(storage)).map((p) => [p.name, p.port]);

describe("Set up Unreal finds", () => {
  it("finds installed engines in Epic's launcher list, newest first; only 5.8 or newer is supported", async () => {
    const home = await tmpDir("studio-unreal-home-");
    await fakeEpic(home, "darwin", []);
    const engines = await findEngines(fakeEnv(home));
    assert.deepEqual(
      engines.map((e) => [e.version, e.build, e.supported]),
      [
        ["5.8", "5.8.3", true],
        ["5.7", "5.7.1", false],
      ],
    );
  });

  it("lists recently opened projects from the engine's own list, newest first, skipping files that are gone", async () => {
    const home = await tmpDir("studio-unreal-home-");
    const projects = path.join(home, "Projects");
    const older = await fakeProject(projects, "Older");
    const newer = await fakeProject(projects, "Newer");
    await fakeEpic(home, "darwin", [
      [older.file, "2026.03.01-10.00.00"],
      [path.join(projects, "Gone", "Gone.uproject"), "2026.10.01-10.00.00"],
      [newer.file, "2026.10.03-20.00.00"],
    ]);
    const env = fakeEnv(home);
    const recent = await recentProjects(env, await findEngines(env));
    assert.deepEqual(
      recent.map((p) => p.name),
      ["Newer", "Older"],
    );
  });

  it("reads Epic's lists from the Windows locations and writes the WindowsEditor settings there", async () => {
    const home = await tmpDir("studio-unreal-home-");
    const project = await fakeProject(path.join(home, "Projects"), "Drift");
    await fakeEpic(home, "win32", [[project.file, "2026.10.03-20.00.00"]]);
    const env = fakeEnv(home, { platform: "win32" });
    const engines = await findEngines(env);
    assert.deepEqual(
      (await recentProjects(env, engines)).map((p) => p.name),
      ["Drift"],
    );
    await setUpProject(project.file, { env, helper: HELPER, storage: path.join(home, "storage") });
    const ini = await readFile(
      path.join(project.directory, "Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini"),
      "utf8",
    );
    assert.match(ini, new RegExp(`ServerPortNumber=${derivedPort(await realpath(project.file))}`));
  });
});

describe("Set up Unreal on a project", () => {
  it("sets a project up: Epic's plugins on, the MCP server starting on its own port, the helper installed", async () => {
    const f = await setupFixture({ ini: USER_INI });
    const before = await inspectProject(f.project.file, f.options);
    assert.deepEqual(
      [before.plugins, before.autoStart, before.helper, before.ready, before.cpp],
      [false, false, HelperState.Missing, false, true],
    );

    const after = await setUpProject(f.project.file, f.options);
    assert.deepEqual(
      [after.plugins, after.autoStart, after.helper, after.ready, after.port],
      [true, true, HelperState.Current, true, f.port],
    );
    assert.ok(f.port >= 18_000 && f.port <= 18_999, "Genex's own block, away from Epic's 8000");

    const uproject = JSON.parse(await readFile(f.project.file, "utf8"));
    assert.deepEqual(
      uproject.Plugins.map((p: { Name: string; Enabled: boolean }) => [p.Name, p.Enabled]),
      [
        ["ChaosVehiclesPlugin", true],
        ["EditorToolset", true],
        ["ModelContextProtocol", true],
        ...TOOLSETS.map((name) => [name, true]),
      ],
    );
    assert.deepEqual(uproject.Modules, [{ Name: "Drift", Type: "Runtime", LoadingPhase: "Default" }]);
    assert.match(await readFile(f.project.file, "utf8"), /^\{\n\t"FileVersion": 3,/, "Unreal's own tab layout");
    const ini = await readFile(path.join(f.project.directory, SETTINGS_INI), "utf8");
    assert.ok(ini.startsWith(USER_INI), "the user's own settings stay first and untouched");
    assert.ok(ini.includes(`${MCP_SECTION}\nbAutoStartServer=True\nServerPortNumber=${f.port}\n`));
    assert.deepEqual(await tree(path.join(f.project.directory, "Plugins/GenexEditorHelper")), await tree(HELPER));
  });

  it("setting up twice changes nothing the second time", async () => {
    const f = await setupFixture({ ini: USER_INI });
    await setUpProject(f.project.file, f.options);
    const once = await tree(f.project.directory);
    await setUpProject(f.project.file, f.options);
    assert.deepEqual(await tree(f.project.directory), once);
  });

  it("keeps a copy of every file it changes, from before Genex touched it", async () => {
    const f = await setupFixture({ ini: USER_INI });
    await setUpProject(f.project.file, f.options);
    // Another app now holds the project's port, so the second setup moves it and writes again.
    const env = { ...f.env, portListening: async (port: number) => port === f.port };
    const moved = await setUpProject(f.project.file, { ...f.options, env });
    assert.notEqual(moved.port, f.port);
    const copies = Object.values(await tree(f.storage));
    for (const original of [UPROJECT, USER_INI])
      assert.ok(copies.includes(createHash("sha256").update(original).digest("hex")));
  });
});

/** Epic's toolset plugins setup adds beyond EditorToolset, in the order it adds them. */
const TOOLSETS = [
  "UMGToolSet",
  "NiagaraToolsets",
  "StateTreeToolset",
  "AIModuleToolset",
  "AnimationAssistantToolset",
  "PCGToolset",
  "PhysicsToolsets",
  "GameplayTagsToolset",
  "AutomationTestToolset",
];

type PluginEntry = { Name: string; Enabled: boolean; TargetAllowList?: string[] };
const pluginsOf = async (file: string): Promise<PluginEntry[]> => JSON.parse(await readFile(file, "utf8")).Plugins;

/** The one setup record in `storage`, read and written as the plugin keeps it. */
async function setupRecord(storage: string) {
  const [key] = await readdir(path.join(storage, SetupStorage.Folder));
  const file = path.join(storage, SetupStorage.Folder, key, SetupStorage.Record);
  return { file, record: JSON.parse(await readFile(file, "utf8")) };
}

/** Drift as a Genex from before the toolsets set it up: Epic's MCP plugins and the helper, no toolset. */
async function setUpWithoutToolsets() {
  const f = await setupFixture({ ini: USER_INI });
  await setUpProject(f.project.file, f.options);
  const uproject = JSON.parse(await readFile(f.project.file, "utf8"));
  uproject.Plugins = uproject.Plugins.filter((p: PluginEntry) => !TOOLSETS.includes(p.Name));
  await writeFile(f.project.file, `${JSON.stringify(uproject, null, "\t")}\n`);
  const { file, record } = await setupRecord(f.storage);
  record.uproject.added = record.uproject.added.filter((name: string) => !TOOLSETS.includes(name));
  await writeFile(file, JSON.stringify(record));
  return f;
}

describe("Epic's toolsets for games", () => {
  it("setup adds them after Epic's MCP plugins, for the editor only, and undo takes them back out", async () => {
    const f = await setupFixture({ ini: USER_INI });
    const before = await inspectProject(f.project.file, f.options);
    assert.equal(before.toolsets, false);
    const after = await setUpProject(f.project.file, f.options);
    assert.deepEqual([after.toolsets, after.ready], [true, true]);
    const added = (await pluginsOf(f.project.file)).filter((p) => TOOLSETS.includes(p.Name));
    assert.deepEqual(
      added,
      TOOLSETS.map((name) => ({ Name: name, Enabled: true, TargetAllowList: ["Editor"] })),
    );
    await undoSetup(f.project.file, f.options);
    assert.equal(await readFile(f.project.file, "utf8"), UPROJECT, "the .uproject as it was before Genex");
  });

  it("a toolset the project already names stays as the user left it, turned off included", async () => {
    const f = await setupFixture({ ini: USER_INI });
    const uproject = JSON.parse(UPROJECT);
    uproject.Plugins.push({ Name: "NiagaraToolsets", Enabled: false }, { Name: "pcgtoolset", Enabled: true });
    const own = `${JSON.stringify(uproject, null, "\t")}\n`;
    await writeFile(f.project.file, own);
    const after = await setUpProject(f.project.file, f.options);
    assert.deepEqual([after.toolsets, after.ready], [true, true], "the user's own choice counts as decided");
    const plugins = await pluginsOf(f.project.file);
    assert.deepEqual(
      plugins.filter((p) => ["niagaratoolsets", "pcgtoolset"].includes(p.Name.toLowerCase())),
      [
        { Name: "NiagaraToolsets", Enabled: false },
        { Name: "pcgtoolset", Enabled: true },
      ],
    );
    // Epic's MCP plugin and the toolsets the project didn't name yet join the four it had.
    assert.equal(plugins.length, uproject.Plugins.length + 1 + TOOLSETS.length - 2);
    await undoSetup(f.project.file, f.options);
    assert.equal(await readFile(f.project.file, "utf8"), own, "undo keeps the user's own entries");
  });

  it("a toolset the user takes out after setup stays out: the project stays set up, and nothing puts it back", async () => {
    const f = await setupFixture({ ini: USER_INI });
    await setUpProject(f.project.file, f.options);
    const uproject = JSON.parse(await readFile(f.project.file, "utf8"));
    uproject.Plugins = uproject.Plugins.filter((p: PluginEntry) => p.Name !== "NiagaraToolsets");
    const edited = `${JSON.stringify(uproject, null, "\t")}\n`;
    await writeFile(f.project.file, edited);

    const state = await inspectProject(f.project.file, f.options);
    assert.deepEqual([state.toolsets, state.ready], [true, true], "the user's removal counts as decided");
    assert.deepEqual((await planSetup(f.project.file, f.options)).steps, []);
    assert.deepEqual(await addToolsetPlugins(f.project.file, f.options), []);
    await setUpProject(f.project.file, f.options);
    assert.equal(await readFile(f.project.file, "utf8"), edited, "neither adding nor setup again puts it back");
    await undoSetup(f.project.file, f.options);
    assert.equal(await readFile(f.project.file, "utf8"), UPROJECT, "the .uproject as it was before Genex");
  });

  it("a project set up before them is still set up, and only its setup plan names them", async () => {
    const f = await setUpWithoutToolsets();
    const state = await inspectProject(f.project.file, f.options);
    assert.deepEqual(
      [state.plugins, state.autoStart, state.undoable, state.toolsets, state.ready],
      [true, true, true, false, false],
    );
    assert.deepEqual((await planSetup(f.project.file, f.options)).steps, [SetupStep.Plugins]);
  });

  it("adding them to such a project changes only its .uproject, and undo takes them back out", async () => {
    const f = await setUpWithoutToolsets();
    const before = await tree(f.project.directory);
    const uprojectBefore = await readFile(f.project.file, "utf8");

    assert.deepEqual(await addToolsetPlugins(f.project.file, f.options), TOOLSETS);

    assert.deepEqual(changedKeys(before, await tree(f.project.directory)), [path.basename(f.project.file)]);
    assert.match(await readFile(f.project.file, "utf8"), /^\{\n\t"FileVersion": 3,/, "Unreal's own tab layout");
    assert.equal((await inspectProject(f.project.file, f.options)).ready, true);
    assert.deepEqual(await addToolsetPlugins(f.project.file, f.options), [], "a second time adds nothing");
    assert.equal((await pluginsOf(f.project.file)).length, JSON.parse(uprojectBefore).Plugins.length + TOOLSETS.length);
    await undoSetup(f.project.file, f.options);
    assert.equal(await readFile(f.project.file, "utf8"), UPROJECT, "the .uproject as it was before Genex");
  });

  it("adding them refuses, writing nothing, while Unreal runs or for a project Genex never set up", async () => {
    const f = await setUpWithoutToolsets();
    const witness = await tree(f.root);
    const running = { ...f.options, env: { ...f.env, editorRunning: async () => true } };
    await assert.rejects(addToolsetPlugins(f.project.file, running), { code: SetupErrorCode.EditorRunning });
    const fresh = await setupFixture();
    const untouched = await readFile(fresh.project.file, "utf8");
    await assert.rejects(addToolsetPlugins(fresh.project.file, fresh.options), { code: SetupErrorCode.NotSetUp });
    assert.deepEqual(await tree(f.root), witness);
    assert.equal(await readFile(fresh.project.file, "utf8"), untouched);
  });
});

describe("Undo setup", () => {
  it("undo takes back only what setup added and keeps the user's later edits", async () => {
    const f = await setupFixture({ ini: USER_INI });
    await setUpProject(f.project.file, f.options);
    // Afterwards the user adds a plugin and Unreal writes more settings and compiles the helper.
    const uproject = JSON.parse(await readFile(f.project.file, "utf8"));
    uproject.Plugins.push({ Name: "Water", Enabled: true });
    await writeFile(f.project.file, `${JSON.stringify(uproject, null, "\t")}\n`);
    const ini = path.join(f.project.directory, SETTINGS_INI);
    await writeFile(
      ini,
      `${await readFile(ini, "utf8")}\n[/Script/LevelEditor.LevelEditorPlaySettings]\nPlayInEditorSoundQualityLevel=0\n`,
    );
    const cache = path.join(f.project.directory, "Plugins/GenexEditorHelper/Content/Python/genex_play/__pycache__");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "play.cpython-311.pyc"), "compiled");

    const undone = await undoSetup(f.project.file, f.options);
    assert.deepEqual(
      [undone.plugins, undone.autoStart, undone.helper, undone.undoable],
      [false, false, HelperState.Missing, false],
    );
    assert.deepEqual(
      JSON.parse(await readFile(f.project.file, "utf8")).Plugins.map((p: { Name: string; Enabled: boolean }) => [
        p.Name,
        p.Enabled,
      ]),
      [
        ["ChaosVehiclesPlugin", true],
        ["EditorToolset", false],
        ["Water", true],
      ],
    );
    const left = await readFile(ini, "utf8");
    assert.ok(!left.includes(MCP_SECTION));
    assert.ok(left.startsWith(USER_INI) && left.includes("PlayInEditorSoundQualityLevel=0"));
    assert.equal(await exists(path.join(f.project.directory, "Plugins")), false, "setup made the Plugins folder");
  });

  it("undo leaves a project that had no Plugins folder and no settings file as it was", async () => {
    const f = await setupFixture();
    const witness = await tree(f.project.directory);
    await setUpProject(f.project.file, f.options);
    await undoSetup(f.project.file, f.options);
    assert.deepEqual(await tree(f.project.directory), witness, "no empty settings file left behind");
    assert.equal(await exists(path.join(f.project.directory, "Plugins")), false, "no empty Plugins folder");
  });

  it("undo keeps a Plugins folder and a settings file that hold something the user added since", async () => {
    const f = await setupFixture();
    await setUpProject(f.project.file, f.options);
    const own = path.join(f.project.directory, "Plugins/Water/Water.uplugin");
    await mkdir(path.dirname(own), { recursive: true });
    await writeFile(own, "{}");
    const ini = path.join(f.project.directory, SETTINGS_INI);
    await writeFile(ini, `${await readFile(ini, "utf8")}\n${USER_INI}`);
    await undoSetup(f.project.file, f.options);
    assert.deepEqual(await readdir(path.join(f.project.directory, "Plugins")), ["Water"]);
    const left = await readFile(ini, "utf8");
    assert.ok(!left.includes(MCP_SECTION) && left.includes("bDisplayDocumentationLink=False"));
  });

  it("an MCP section the user already had gets its own values back on undo", async () => {
    const own = `${MCP_SECTION}\nbAutoStartServer=False\nServerPortNumber=9000\nbLogRequests=True\n`;
    const f = await setupFixture({ ini: own });
    await setUpProject(f.project.file, f.options);
    const set = await readFile(path.join(f.project.directory, SETTINGS_INI), "utf8");
    assert.equal(
      set,
      `${MCP_SECTION}\nbAutoStartServer=True\nServerPortNumber=${f.port}\nbLogRequests=True\n`,
      "a port outside Genex's block moves into it",
    );
    await undoSetup(f.project.file, f.options);
    assert.equal(await readFile(path.join(f.project.directory, SETTINGS_INI), "utf8"), own);
  });

  const MY_TOOLS = "Plugins/GenexEditorHelper/Content/Python/my_tools.py";
  const TOOLS = "Plugins/GenexEditorHelper/Content/Python/genex_play/tools.py";

  for (const before of ["no helper", "a helper copied in by hand"] as const)
    it(`undo keeps a file the user added inside the helper folder (${before})`, async () => {
      const f = await setupFixture({ ini: USER_INI });
      if (before === "a helper copied in by hand")
        await cp(HELPER, path.join(f.project.directory, "Plugins/GenexEditorHelper"), { recursive: true });
      await setUpProject(f.project.file, f.options);
      await writeFile(path.join(f.project.directory, MY_TOOLS), "def mine():\n    return 1\n");
      await undoSetup(f.project.file, f.options);
      assert.equal(await readFile(path.join(f.project.directory, MY_TOOLS), "utf8"), "def mine():\n    return 1\n");
    });

  it("undo keeps a helper file the user changed after setup", async () => {
    const f = await setupFixture({ ini: USER_INI });
    await setUpProject(f.project.file, f.options);
    await appendFile(path.join(f.project.directory, TOOLS), "# my change\n");
    const changed = await readFile(path.join(f.project.directory, TOOLS));
    const undone = (await undoSetup(f.project.file, f.options)) as { kept?: string[] };
    assert.deepEqual(await readFile(path.join(f.project.directory, TOOLS)), changed);
    assert.deepEqual(undone.kept, [TOOLS.replace("Plugins/GenexEditorHelper/", "").split("/").join(path.sep)]);
  });

  it("setting up again over a changed helper keeps the user's version beside it, and undo keeps that", async () => {
    const f = await setupFixture({ ini: USER_INI });
    await setUpProject(f.project.file, f.options);
    await appendFile(path.join(f.project.directory, TOOLS), "# my change\n");
    const changed = await readFile(path.join(f.project.directory, TOOLS));
    const outdated = await inspectProject(f.project.file, f.options);
    assert.equal(outdated.helper, HelperState.Outdated);
    await setUpProject(f.project.file, f.options);
    const mine = path.join(f.project.directory, `${TOOLS}.mine`);
    assert.deepEqual(await readFile(mine), changed, "the user's version is kept as tools.py.mine");
    assert.deepEqual(
      await readFile(path.join(f.project.directory, TOOLS)),
      await readFile(path.join(HELPER, "Content/Python/genex_play/tools.py")),
    );
    await undoSetup(f.project.file, f.options);
    assert.deepEqual(await readFile(mine), changed, "undo never removes the kept copy");
  });

  it("undo still removes Python's caches and an untouched helper, and gives a hand-installed helper back byte for byte", async () => {
    const fresh = await setupFixture({ ini: USER_INI });
    await setUpProject(fresh.project.file, fresh.options);
    const cache = path.join(fresh.project.directory, "Plugins/GenexEditorHelper/Content/Python/__pycache__");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "init_unreal.cpython-311.pyc"), "compiled");
    await undoSetup(fresh.project.file, fresh.options);
    assert.equal(await exists(path.join(fresh.project.directory, "Plugins")), false);

    const byHand = await setupFixture({ ini: USER_INI });
    const helper = path.join(byHand.project.directory, "Plugins/GenexEditorHelper");
    await cp(HELPER, helper, { recursive: true });
    await appendFile(path.join(helper, "Content/Python/genex_play/tools.py"), "# an older copy\n");
    const witness = await tree(helper);
    await setUpProject(byHand.project.file, byHand.options);
    await undoSetup(byHand.project.file, byHand.options);
    assert.deepEqual(await tree(helper), witness);
  });

  it("refuses while Unreal Editor runs, and refuses an undo with nothing to undo", async () => {
    const f = await setupFixture();
    const running = { ...f.options, env: { ...f.env, editorRunning: async () => true } };
    await assert.rejects(setUpProject(f.project.file, running), { code: SetupErrorCode.EditorRunning });
    await assert.rejects(undoSetup(f.project.file, f.options), { code: SetupErrorCode.NothingToUndo });
    await setUpProject(f.project.file, f.options);
    await assert.rejects(undoSetup(f.project.file, running), { code: SetupErrorCode.EditorRunning });
  });

  it("sets up and undoes beside an Unreal that has another project open, and refuses while this one is open", async () => {
    const f = await setupFixture();
    const real = await realpath(f.project.file);
    const open = { open: true, openedAt: 0, mtime: 0, mcpStarted: false, loaded: true };
    /** An editor runs; its log of this project says `log`, and this project's port answers when `answers`. */
    const editor = (log: typeof open | undefined, answers = false) => ({
      ...f.options,
      env: {
        ...f.env,
        editorRunning: async () => true,
        editorLog: async (project: { file: string }) => (project.file === real ? log : undefined),
        editorAnswers: async (_port: number, project?: string) => answers && project === real,
      },
    });
    const elsewhere = editor(undefined);
    assert.equal((await setUpProject(f.project.file, elsewhere)).undoable, true, "another project open: set up");
    assert.deepEqual(await setUp(f.storage), [["Drift", f.port]]);
    await assert.rejects(undoSetup(f.project.file, editor(open)), { code: SetupErrorCode.EditorRunning });
    await assert.rejects(undoSetup(f.project.file, editor(undefined, true)), { code: SetupErrorCode.EditorRunning });
    assert.equal((await undoSetup(f.project.file, elsewhere)).undoable, false, "another project open: undone");
    await assert.rejects(setUpProject(f.project.file, editor({ ...open })), { code: SetupErrorCode.EditorRunning });
    assert.equal(await exists(path.join(f.project.directory, SETTINGS_INI)), false, "a refusal writes nothing");
  });
});

/** An MCP section as the user wrote it by hand, with Epic's server starting on `port`. */
const handIni = (port: string) => `${USER_INI}${MCP_SECTION}\nbAutoStartServer=True\nServerPortNumber=${port}\n`;
const iniPort = async (directory: string) =>
  /ServerPortNumber=(\d+)/.exec(await readFile(path.join(directory, SETTINGS_INI), "utf8"))?.[1];

describe("A project's own port", () => {
  it("goes into the setup record, where the bridge finds it, and undo takes it away", async () => {
    const f = await setupFixture({ ini: USER_INI });
    await setUpProject(f.project.file, f.options);
    assert.deepEqual(await setUp(f.storage), [["Drift", f.port]]);
    await undoSetup(f.project.file, f.options);
    assert.deepEqual(await setUp(f.storage), []);
  });

  it("a project on Epic's 8000 moves into Genex's block, and undo gives it 8000 back", async () => {
    const f = await setupFixture({ ini: handIni("8000") });
    const set = await setUpProject(f.project.file, f.options);
    assert.equal(set.port, f.port);
    assert.equal(await iniPort(f.project.directory), String(f.port));
    assert.deepEqual(await setUp(f.storage), [["Drift", f.port]]);
    await undoSetup(f.project.file, f.options);
    assert.equal(await iniPort(f.project.directory), "8000");
  });

  it("a port inside Genex's block that the project already has is kept", async () => {
    const f = await setupFixture({ ini: handIni("18123") });
    const set = await setUpProject(f.project.file, f.options);
    assert.equal(set.port, 18_123);
    assert.equal(await iniPort(f.project.directory), "18123");
  });

  it("a record from before ports moved into the block is not trusted: the project reads not set up", async () => {
    const f = await setupFixture({ ini: handIni("8000") });
    await setUpProject(f.project.file, f.options);
    // A record written before this rule, still holding 8000, with the settings to match.
    const [key] = await readdir(path.join(f.storage, "setup"));
    const recordFile = path.join(f.storage, "setup", key, "record.json");
    const kept = JSON.parse(await readFile(recordFile, "utf8"));
    await writeFile(recordFile, JSON.stringify({ ...kept, port: 8000 }));
    await writeFile(path.join(f.project.directory, SETTINGS_INI), handIni("8000"));
    assert.deepEqual(await setUp(f.storage), [], "the bridge and the toolbar skip it");
    const state = await inspectProject(f.project.file, f.options);
    assert.deepEqual([state.autoStart, state.ready], [false, false], "the panel offers Set up again");
    const again = await setUpProject(f.project.file, f.options);
    assert.deepEqual([again.port, again.ready], [f.port, true]);
  });

  it("a port another app listens on while Unreal is closed moves to a free one", async () => {
    const f = await setupFixture({ ini: handIni("8000") });
    const env = { ...f.env, portListening: async (port: number) => port === 8000 };
    const set = await setUpProject(f.project.file, { ...f.options, env });
    assert.equal(set.port, f.port);
    assert.equal(await iniPort(f.project.directory), String(f.port));
  });

  it("two projects never share a port, even when both had Epic's 8000", async () => {
    const f = await setupFixture({ ini: handIni("8000") });
    const other = await fakeProject(path.join(f.root, "Projects"), "Other", { ini: handIni("8000") });
    const first = await setUpProject(f.project.file, f.options);
    const second = await setUpProject(other.file, f.options);
    assert.equal(second.port, derivedPort(await realpath(other.file)));
    assert.ok(first.port !== null && first.port >= 18_000 && first.port <= 18_999, String(first.port));
    assert.ok(second.port !== null && second.port >= 18_000 && second.port <= 18_999, String(second.port));
    assert.notEqual(first.port, second.port);
    assert.deepEqual((await setUp(f.storage)).sort(), [
      ["Drift", first.port],
      ["Other", second.port],
    ]);
  });

  it("a project set up by hand on 8000 is recorded with a port in Genex's block, and undo restores it exactly", async () => {
    const f = await setupFixture({ ini: handIni("8000") });
    const uproject = JSON.parse(UPROJECT);
    uproject.Plugins = [
      { Name: "EditorToolset", Enabled: true },
      { Name: "ModelContextProtocol", Enabled: true },
    ];
    await writeFile(f.project.file, `${JSON.stringify(uproject, null, "\t")}\n`);
    await cp(HELPER, path.join(f.project.directory, "Plugins/GenexEditorHelper"), { recursive: true });
    const witness = await tree(f.project.directory);
    const set = await setUpProject(f.project.file, f.options);
    assert.deepEqual([set.ready, set.undoable, set.port], [true, true, f.port]);
    const changed = await tree(f.project.directory);
    assert.deepEqual(
      Object.keys(changed)
        .filter((file) => changed[file] !== witness[file])
        .sort(),
      [path.basename(f.project.file), SETTINGS_INI].sort(),
      "only the settings' port changes, and Epic's toolsets join the .uproject",
    );
    assert.deepEqual(
      (await pluginsOf(f.project.file)).map((p) => p.Name),
      ["EditorToolset", "ModelContextProtocol", ...TOOLSETS],
      "the hand-made plugin entries stay as they were",
    );
    assert.equal(await iniPort(f.project.directory), String(f.port));
    assert.deepEqual(await setUp(f.storage), [["Drift", f.port]]);
    await undoSetup(f.project.file, f.options);
    assert.deepEqual(await tree(f.project.directory), witness);
    assert.deepEqual(await setUp(f.storage), []);
  });

  for (const hostile of [
    "80",
    "0",
    "1023",
    "65536",
    "70000",
    "8000.5",
    "08000",
    "-1",
    "1e4",
    "0x1f40",
    "8000/evil",
    "",
  ]) {
    it(`never keeps the port ${JSON.stringify(hostile)} from a project's settings, nor asks it`, async () => {
      const f = await setupFixture({ ini: handIni(hostile) });
      const probed: number[] = [];
      const env = {
        ...f.env,
        portListening: async (port: number) => {
          probed.push(port);
          return false;
        },
      };
      const set = await setUpProject(f.project.file, { ...f.options, env });
      assert.equal(set.port, f.port);
      assert.equal(await iniPort(f.project.directory), String(f.port));
      assert.ok(
        probed.every((port) => port >= 18_000 && port <= 18_999),
        "only Genex's own block is probed",
      );
    });
  }
});

/** Whether the folder's file system ignores case, as macOS and Windows do by default. */
async function caseInsensitive(dir: string): Promise<boolean> {
  const probe = path.join(dir, "CaseProbe.txt");
  await writeFile(probe, "x");
  return exists(path.join(dir, "caseprobe.txt"));
}

describe("A project spelled in another case", () => {
  it("is one project: one record, one port, and undo through either spelling", async () => {
    const f = await setupFixture({ ini: USER_INI });
    if (!(await caseInsensitive(f.root))) return;
    const miscased = path.join(f.project.directory, "drift.uproject");
    const set = await setUpProject(miscased, f.options);
    const state = await inspectProject(f.project.file, f.options);
    assert.deepEqual([state.undoable, state.port], [true, set.port]);
    await setUpProject(f.project.file, f.options);
    assert.deepEqual(await setUp(f.storage), [["Drift", set.port]], "exactly one record, by the name on disk");
    await undoSetup(miscased, f.options);
    assert.deepEqual(await setUp(f.storage), []);
  });
});

/**
 * Drift open in Unreal under a spelling the log names: the editor writes `commandline="" <path>""`
 * at the top of the project's own log, which Genex reads where Unreal keeps it in the fake home.
 */
const openSpellings: Array<{
  name: string;
  /** The path the open editor's log names, from the fixture. */
  named: (f: Awaited<ReturnType<typeof setupFixture>>, other: string) => Promise<string>;
  refuses: boolean;
  links?: boolean;
  caseless?: boolean;
}> = [
  { name: "as it is", named: async (f) => realpath(f.project.file), refuses: true },
  {
    name: "through a link to its folder's parent",
    links: true,
    named: async (f) => {
      await symlink(path.join(f.root, "Projects"), path.join(f.root, "Linked"));
      return path.join(f.root, "Linked", "Drift", "Drift.uproject");
    },
    refuses: true,
  },
  {
    name: "in another case",
    caseless: true,
    named: async (f) => path.join(await realpath(f.root), "projects", "drift", "DRIFT.uproject"),
    refuses: true,
  },
  { name: "another project", named: async (_f, other) => other, refuses: false },
  {
    name: "a link named like it that leads to another project",
    links: true,
    named: async (f, other) => {
      await mkdir(path.join(f.root, "Links", "Drift"), { recursive: true });
      await symlink(other, path.join(f.root, "Links", "Drift", "Drift.uproject"));
      return path.join(f.root, "Links", "Drift", "Drift.uproject");
    },
    refuses: false,
  },
];

describe("Set up Unreal while an editor runs", () => {
  for (const row of openSpellings)
    it(`${row.refuses ? "refuses, changing nothing," : "sets up"} when the open project is ${row.name}`, {
      skip: row.links && process.platform === "win32" && "links need privileges on Windows",
    }, async () => {
      const f = await setupFixture({ ini: USER_INI });
      if (row.caseless && !(await caseInsensitive(f.root))) return;
      const other = (await fakeProject(path.join(f.root, "Projects"), "Other")).file;
      const named = await row.named(f, other);
      const real = await realpath(f.project.file);
      const log = editorLogPath({ file: real, directory: path.dirname(real) }, f.home, process.platform);
      await mkdir(path.dirname(log), { recursive: true });
      await writeFile(
        log,
        `﻿Log file open, 01/01/26 12:00:00\nLogCsvProfiler: Display: Metadata set : commandline="" ${named}""\n`,
      );
      const env: SetupEnv = {
        ...f.env,
        editorRunning: async () => true,
        editorLog: (project) =>
          readEditorLog(editorLogPath(project, f.home, process.platform), project.file, project.port),
      };
      const options = { ...f.options, env };
      if (!row.refuses) {
        assert.equal((await setUpProject(f.project.file, options)).undoable, true);
        return;
      }
      const witness = [await tree(f.project.directory), await tree(f.storage)];
      await assert.rejects(setUpProject(f.project.file, options), { code: SetupErrorCode.EditorRunning });
      assert.deepEqual([await tree(f.project.directory), await tree(f.storage)], witness);
    });
});

/** Paths that are not a real project, and projects whose write targets lead elsewhere. */
const hostile: Array<{
  name: string;
  code: string;
  arrange: (f: Awaited<ReturnType<typeof setupFixture>>, outside: string) => Promise<string>;
}> = [
  { name: "a relative path", code: SetupErrorCode.NotProjectFile, arrange: async () => "Drift/Drift.uproject" },
  {
    name: "a file that is not a .uproject",
    code: SetupErrorCode.NotProjectFile,
    arrange: async (f) => path.join(f.project.directory, "Drift.txt"),
  },
  {
    name: "a .uproject that does not exist",
    code: SetupErrorCode.NoProject,
    arrange: async (f) => path.join(f.project.directory, "Missing.uproject"),
  },
  {
    name: "a folder named like a project",
    code: SetupErrorCode.NoProject,
    arrange: async (f) => {
      await mkdir(path.join(f.project.directory, "Folder.uproject"));
      return path.join(f.project.directory, "Folder.uproject");
    },
  },
  {
    name: "a .uproject that is a link to a project elsewhere",
    code: SetupErrorCode.NoProject,
    arrange: async (f, outside) => {
      const elsewhere = await fakeProject(outside, "Elsewhere");
      const link = path.join(f.project.directory, "Linked.uproject");
      await symlink(elsewhere.file, link);
      return link;
    },
  },
  {
    name: "a .uproject that is not JSON",
    code: SetupErrorCode.BadProjectFile,
    arrange: async (f) => {
      await writeFile(f.project.file, "{ not json");
      return f.project.file;
    },
  },
  {
    name: "a Plugins folder that links outside the project",
    code: SetupErrorCode.Link,
    arrange: async (f, outside) => {
      await symlink(outside, path.join(f.project.directory, "Plugins"));
      return f.project.file;
    },
  },
  {
    name: "a helper folder that links outside the project",
    code: SetupErrorCode.Link,
    arrange: async (f, outside) => {
      await mkdir(path.join(f.project.directory, "Plugins"));
      await symlink(outside, path.join(f.project.directory, "Plugins/GenexEditorHelper"));
      return f.project.file;
    },
  },
  {
    name: "a link inside the helper folder",
    code: SetupErrorCode.Link,
    arrange: async (f, outside) => {
      const python = path.join(f.project.directory, "Plugins/GenexEditorHelper/Content/Python");
      await mkdir(python, { recursive: true });
      await writeFile(path.join(outside, "init_unreal.py"), "print('outside')\n");
      await symlink(path.join(outside, "init_unreal.py"), path.join(python, "init_unreal.py"));
      return f.project.file;
    },
  },
  {
    name: "a settings folder that links outside the project",
    code: SetupErrorCode.Link,
    arrange: async (f, outside) => {
      await mkdir(path.join(f.project.directory, "Saved/Config"), { recursive: true });
      await symlink(outside, path.join(f.project.directory, "Saved/Config/MacEditor"));
      return f.project.file;
    },
  },
  {
    name: "a settings file that links outside the project",
    code: SetupErrorCode.Link,
    arrange: async (f, outside) => {
      await mkdir(path.join(f.project.directory, "Saved/Config/MacEditor"), { recursive: true });
      await writeFile(path.join(outside, "victim.ini"), "[Victim]\nKeep=1\n");
      await symlink(path.join(outside, "victim.ini"), path.join(f.project.directory, SETTINGS_INI));
      return f.project.file;
    },
  },
];

describe("Set up Unreal refuses, changing nothing,", () => {
  it("refuses when every port in Genex's block is taken", async () => {
    const f = await setupFixture({ ini: USER_INI });
    const witness = await tree(f.project.directory);
    const env = { ...f.env, portListening: async () => true };
    await assert.rejects(setUpProject(f.project.file, { ...f.options, env }), { code: SetupErrorCode.NoFreePort });
    assert.deepEqual(await tree(f.project.directory), witness);
    assert.deepEqual(await tree(f.storage), {});
  });

  for (const { name, code, arrange } of hostile) {
    it(`refuses ${name} and changes nothing`, {
      skip: process.platform === "win32" && "links need privileges on Windows",
    }, async () => {
      const f = await setupFixture();
      const outside = path.join(f.root, "outside");
      await mkdir(outside, { recursive: true });
      const file = await arrange(f, outside);
      const witness = [await tree(f.project.directory), await tree(outside)];
      await assert.rejects(setUpProject(file, f.options), { code });
      assert.deepEqual([await tree(f.project.directory), await tree(outside)], witness);
      assert.deepEqual(await tree(f.storage), {}, "no snapshot or record for a refused setup");
    });
  }
});

/** Every folder under `dir`, so a removed empty folder shows too. */
async function folders(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []))
    if (entry.isDirectory()) out.push(path.relative(dir, path.join(entry.parentPath, entry.name)));
  return out.sort();
}

type SetFixture = Awaited<ReturnType<typeof setupFixture>>;

/** Moves a set-up part of the project outside and leaves a link to it in its place. */
async function linkAfterSetup(f: SetFixture, outside: string, relative: string) {
  const moved = path.join(outside, path.basename(relative));
  await rename(path.join(f.project.directory, relative), moved);
  await symlink(moved, path.join(f.project.directory, relative));
}

const SETTINGS_DIR = path.dirname(SETTINGS_INI);

/** Paths undo must refuse, and set-up parts that became links after setup. */
const hostileUndo: Array<{
  name: string;
  code: string;
  ini?: string;
  arrange: (f: SetFixture, outside: string) => Promise<string>;
}> = [
  { name: "a relative path", code: SetupErrorCode.NotProjectFile, arrange: async () => "Drift/Drift.uproject" },
  {
    name: "a file that is not a .uproject",
    code: SetupErrorCode.NotProjectFile,
    arrange: async (f) => path.join(f.project.directory, "Drift.txt"),
  },
  {
    name: "a .uproject that does not exist",
    code: SetupErrorCode.NoProject,
    arrange: async (f) => path.join(f.project.directory, "Missing.uproject"),
  },
  {
    name: "a folder named like a project",
    code: SetupErrorCode.NoProject,
    arrange: async (f) => {
      await mkdir(path.join(f.project.directory, "Folder.uproject"));
      return path.join(f.project.directory, "Folder.uproject");
    },
  },
  {
    name: "a .uproject that is a link to the set-up project",
    code: SetupErrorCode.NoProject,
    arrange: async (f) => {
      const link = path.join(f.root, "Linked.uproject");
      await symlink(f.project.file, link);
      return link;
    },
  },
  {
    name: "a Plugins folder linked after setup",
    code: SetupErrorCode.Link,
    arrange: async (f, outside) => {
      await linkAfterSetup(f, outside, "Plugins");
      return f.project.file;
    },
  },
  {
    name: "a helper folder linked after setup",
    code: SetupErrorCode.Link,
    arrange: async (f, outside) => {
      await linkAfterSetup(f, outside, "Plugins/GenexEditorHelper");
      return f.project.file;
    },
  },
  {
    name: "a link planted inside the helper folder",
    code: SetupErrorCode.Link,
    arrange: async (f, outside) => {
      const target = path.join(f.project.directory, "Plugins/GenexEditorHelper/Content/Python/init_unreal.py");
      await rename(target, path.join(outside, "init_unreal.py"));
      await symlink(path.join(outside, "init_unreal.py"), target);
      return f.project.file;
    },
  },
  {
    name: "a settings folder linked after setup, where the settings file existed",
    code: SetupErrorCode.Link,
    ini: USER_INI,
    arrange: async (f, outside) => {
      await linkAfterSetup(f, outside, SETTINGS_DIR);
      return f.project.file;
    },
  },
  {
    name: "a settings folder linked after setup, where setup made the settings file",
    code: SetupErrorCode.Link,
    arrange: async (f, outside) => {
      await linkAfterSetup(f, outside, SETTINGS_DIR);
      return f.project.file;
    },
  },
  {
    name: "a settings file linked after setup",
    code: SetupErrorCode.Link,
    ini: USER_INI,
    arrange: async (f, outside) => {
      await linkAfterSetup(f, outside, SETTINGS_INI);
      return f.project.file;
    },
  },
];

describe("Undo setup refuses, changing nothing,", () => {
  for (const { name, code, ini, arrange } of hostileUndo)
    it(`refuses ${name}`, { skip: process.platform === "win32" && "links need privileges on Windows" }, async () => {
      const f = await setupFixture(ini === undefined ? {} : { ini });
      await setUpProject(f.project.file, f.options);
      const outside = path.join(f.root, "outside");
      await mkdir(outside, { recursive: true });
      const file = await arrange(f, outside);
      const witness = [
        await tree(f.project.directory),
        await folders(f.project.directory),
        await tree(outside),
        await tree(f.storage),
      ];
      await assert.rejects(undoSetup(file, f.options), { code });
      assert.deepEqual(
        [
          await tree(f.project.directory),
          await folders(f.project.directory),
          await tree(outside),
          await tree(f.storage),
        ],
        witness,
      );
      assert.ok(
        Object.keys(witness[3]).some((key) => key.endsWith("record.json")),
        "the record and its copies stay for a later undo",
      );
    });
});

/** Windows' readdir as it reports OneDrive placeholders: every entry a link, though lstat sees plain files. */
const everyEntryALink: ReadEntries = async (dir) =>
  (await readdir(dir)).map((name) => ({
    name,
    isFile: () => false,
    isDirectory: () => false,
    isSymbolicLink: () => true,
  }));

describe("Documents in OneDrive", () => {
  it("undo and setting up again work where readdir calls every entry a link but lstat sees plain files", async () => {
    const f = await setupFixture({ ini: USER_INI });
    const env = { ...f.env, readEntries: everyEntryALink };
    const options = { ...f.options, env };
    await setUpProject(f.project.file, options);
    await appendFile(
      path.join(f.project.directory, "Plugins/GenexEditorHelper/Content/Python/genex_play/tools.py"),
      "#\n",
    );
    const again = await setUpProject(f.project.file, options);
    assert.equal(again.helper, HelperState.Current);
    const undone = await undoSetup(f.project.file, options);
    assert.equal(undone.undoable, false);
  });
});

describe("the Unreal plugin's setup actions", () => {
  async function backendFixture(overrides: Partial<SetupEnv> = {}) {
    const f = await setupFixture({ ini: USER_INI });
    await fakeEpic(f.home, "darwin", [[f.project.file, "2026.10.03-20.00.00"]]);
    const env = { ...f.env, ...overrides };
    const backend = createUnrealBackend({ env, helper: HELPER, launch: noLaunch(f.root) });
    const context = {
      signal: new AbortController().signal,
      callId: 1,
      host: (async (method: string) => {
        if (method === "storage.root") return f.storage;
        throw new Error(`unexpected host call ${method}`);
      }) as never,
    };
    return { ...f, backend, context };
  }

  it("status names the engine, the recent projects and what the first project still needs", async () => {
    const b = await backendFixture({
      editorRunning: async () => true,
      freeBytes: async () => 12 * GIB,
      xcode: async () => NO_XCODE,
    });
    const status = (await b.backend.action?.("status", {}, b.context)) as any;
    assert.equal(status.engine.build, "5.8.3");
    assert.deepEqual(
      status.projects.map((p: { name: string }) => p.name),
      ["Drift"],
    );
    assert.equal(status.project.file, await realpath(b.project.file), "the list names each project by its real path");
    assert.equal(status.project.ready, false);
    assert.equal(status.engineMatch, "installed");
    assert.equal(status.port, null, "a project that isn't set up has no port yet");
    assert.deepEqual(status.editor, { running: true, answering: false, editors: 1 });
    assert.deepEqual([status.lowDisk, status.lowMemory, status.xcode.state], [true, false, XcodeState.Missing]);
  });

  /** The panel status's ray tracing warning for the fixture's project. */
  const rayTracingRisk = async (b: Awaited<ReturnType<typeof backendFixture>>) => {
    const status = (await b.backend.action?.("status", {}, b.context)) as { rayTracingRisk?: boolean } | undefined;
    return status?.rayTracingRisk;
  };

  // UE 5.8 on a Mac hangs the GPU rendering a ray-traced level behind another app.
  it("on a Mac, status warns of a project that ray-traces, and turning it off clears the warning", async () => {
    const b = await backendFixture();
    const config = path.join(b.project.directory, "Config", "DefaultEngine.ini");
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(config, "[/Script/Engine.RendererSettings]\nr.RayTracing=True\n");
    const project = await realpath(b.project.file);
    assert.equal(await rayTracingRisk(b), true);
    const review = await b.backend.review?.("ray-tracing-off", { project }, b.context);
    assert.match(String(review?.message), /Drift/);
    await b.backend.action?.("ray-tracing-off", { project }, b.context);
    assert.equal(await readFile(config, "utf8"), "[/Script/Engine.RendererSettings]\nr.RayTracing=False\n");
    assert.equal(await rayTracingRisk(b), false);
  });

  it("never warns of ray tracing off a Mac", async () => {
    const b = await backendFixture({ platform: "win32" });
    const config = path.join(b.project.directory, "Config", "DefaultEngine.ini");
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(config, "[/Script/Engine.RendererSettings]\nr.RayTracing=True\n");
    assert.equal(await rayTracingRisk(b), false);
  });

  it("status says where Xcode stands on every Mac, C++ project or not, against the supported engine", async () => {
    const asked: Array<string | undefined> = [];
    const b = await backendFixture({
      xcode: async (engine) => {
        asked.push(engine);
        return NO_XCODE;
      },
    });
    await writeFile(b.project.file, `${JSON.stringify({ FileVersion: 3, EngineAssociation: "5.8" }, null, "\t")}\n`);
    const status = (await b.backend.action?.("status", {}, b.context)) as {
      project: { cpp: boolean };
      xcode: XcodeStatus;
    };
    assert.equal(status.project.cpp, false);
    assert.deepEqual(status.xcode, NO_XCODE);
    assert.equal("needsXcode" in status, false, "no C++-only flag any more");
    assert.deepEqual(asked, [path.join(b.home, "Engines", "UE_5.8")]);
  });

  it("set up and undo run through the actions, with the project's own port", async () => {
    const b = await backendFixture();
    const review = await b.backend.review?.("setup", { project: b.project.file }, b.context);
    assert.match(review?.detail ?? "", /Drift\.uproject/);
    assert.match(review?.detail ?? "", new RegExp(`port ${b.port}\\b`));
    const set = (await b.backend.action?.("setup", { project: b.project.file }, b.context)) as any;
    assert.deepEqual([set.ready, set.port], [true, b.port]);
    const undone = (await b.backend.action?.("undo-setup", { project: b.project.file }, b.context)) as any;
    assert.equal(undone.plugins, false);
    await assert.rejects(b.backend.action?.("setup", {}, b.context) ?? Promise.reject(), {
      code: SetupErrorCode.NotProjectFile,
    });
  });

  it("a link's Undo takes the set-up back through undo-setup, and answers nothing once it is gone", async () => {
    const b = await backendFixture();
    await b.backend.action?.("setup", { project: b.project.file }, b.context);
    const args = { project: await realpath(b.project.file), ifSetUp: true };
    const undone = (await b.backend.action?.("undo-setup", args, b.context)) as { undoable: boolean };
    assert.equal(undone.undoable, false);
    assert.equal(await b.backend.action?.("undo-setup", args, b.context), null, "nothing left to undo is no refusal");
    await assert.rejects(b.backend.action?.("undo-setup", { project: b.project.file }, b.context) ?? Promise.reject(), {
      code: SetupErrorCode.NothingToUndo,
    });
  });

  it("status asks only the chosen project's own port whether Unreal answers", async () => {
    const asked: number[] = [];
    const b = await backendFixture({
      editorAnswers: async (port: number) => {
        asked.push(port);
        return true;
      },
    });
    const before = (await b.backend.action?.("status", {}, b.context)) as any;
    assert.deepEqual([before.port, before.editor.answering, asked], [null, false, []], "nothing set up, nothing asked");
    await b.backend.action?.("setup", { project: b.project.file }, b.context);
    const after = (await b.backend.action?.("status", {}, b.context)) as any;
    assert.deepEqual([after.port, after.editor.answering, asked], [b.port, true, [b.port]]);
  });

  it("the project chosen in the panel is remembered, and the bridge tries it first", async () => {
    const b = await backendFixture();
    const other = await fakeProject(path.join(b.root, "Projects"), "Other", { ini: USER_INI });
    await b.backend.action?.("setup", { project: other.file }, b.context);
    await b.backend.action?.("setup", { project: b.project.file }, b.context);
    assert.deepEqual(
      (await listSetUpProjects(b.storage)).map((p) => p.name),
      ["Drift", "Other"],
      "the project set up last is the one chosen",
    );
    await b.backend.action?.("status", { project: other.file }, b.context);
    assert.deepEqual(
      (await listSetUpProjects(b.storage)).map((p) => p.name),
      ["Other", "Drift"],
    );
    const reopened = (await b.backend.action?.("status", {}, b.context)) as any;
    assert.equal(reopened.project.name, "Other", "the panel opens on the project chosen last");
  });

  it("status of a typed path that is not a project explains why instead of failing", async () => {
    const b = await backendFixture();
    const status = (await b.backend.action?.("status", { project: "/nowhere/Nope.uproject" }, b.context)) as any;
    assert.equal(status.project, undefined);
    assert.equal(status.projectError.code, SetupErrorCode.NoProject);
    const none = (await b.backend.action?.("status", { project: "" }, b.context)) as any;
    assert.deepEqual(
      [none.project, none.projectError],
      [undefined, undefined],
      "Another project with nothing typed yet",
    );
  });
});

describe("On Windows, the Unreal plugin's console tools", () => {
  type Call = { file: string; args: readonly string[]; options: { windowsHide?: boolean } };
  const recorder = (stdout: string) => {
    const calls: Call[] = [];
    const run = async (file: string, args: readonly string[], options: { windowsHide?: boolean }) => {
      calls.push({ file, args, options });
      return { stdout };
    };
    return { calls, run };
  };

  it("asks tasklist by its full path under SystemRoot, with no console window", async () => {
    const { calls, run } = recorder("UnrealEditor.exe   12345 Console   1   1,234,567 K\r\n");
    const env = systemSetupEnv({ SystemRoot: "C:\\Windows" }, "win32", run);
    assert.equal(await env.editorRunning(), true);
    assert.equal(calls[0]?.file, "C:\\Windows\\System32\\tasklist.exe");
    assert.equal(calls[0]?.options.windowsHide, true);
  });

  it("reads tasklist's answer", () => {
    assert.equal(tasklistShowsEditor("UnrealEditor.exe   12345 Console   1   1,234,567 K"), true);
    assert.equal(tasklistShowsEditor("INFO: No tasks are running which match the specified criteria."), false);
    assert.equal(tasklistShowsEditor(""), false);
  });

  it("finds Epic's ProgramData and the launcher's Program Files from the env a plugin backend gets", () => {
    const parent = {
      SystemRoot: "D:\\Windows",
      ProgramData: "D:\\ProgramData",
      "ProgramFiles(x86)": "D:\\Program Files (x86)",
      PATH: "D:\\Windows\\System32",
    };
    const env = pluginBackendEnv(parent, "win32");
    assert.equal(systemSetupEnv(env, "win32").programData, "D:\\ProgramData");
    assert.equal(systemLaunchEnv("win32", env).applications, "D:\\Program Files (x86)");
  });

  it("without those variables, takes the folders from SystemRoot's drive, and C: only with nothing at all", () => {
    assert.equal(systemSetupEnv({ SystemRoot: "D:\\Windows" }, "win32").programData, "D:\\ProgramData");
    assert.equal(systemLaunchEnv("win32", { SystemRoot: "D:\\Windows" }).applications, "D:\\Program Files (x86)");
    assert.equal(systemSetupEnv({}, "win32").programData, "C:\\ProgramData");
    assert.equal(systemLaunchEnv("win32", {}).applications, "C:\\Program Files (x86)");
  });
});

describe("a game's own Unreal project and the steps card", () => {
  type HostCall = [string, unknown];
  /** A backend whose host answers storage and the game.engine services, keeps the game's link, and records every call. */
  async function linkFixture(overrides: Partial<SetupEnv> = {}, game: string | null = "valley") {
    const f = await setupFixture({ ini: USER_INI });
    await fakeEpic(f.home, "darwin", [[f.project.file, "2026.10.03-20.00.00"]]);
    const env = { ...f.env, xcode: async () => READY_XCODE, ...overrides };
    const launched: Launch[] = [];
    const launch: LaunchEnv = { ...noLaunch(f.root), open: async (l) => void launched.push(l) };
    const backend = createUnrealBackend({ env, helper: HELPER, launch });
    const calls: HostCall[] = [];
    let link: PluginEngineLink | null = null;
    const host = (async (method: string, args?: unknown) => {
      if (method === "storage.root") return f.storage;
      calls.push([method, args]);
      if (method === "game.engine.link") {
        const project = (args as { project: string }).project;
        link = {
          kind: "unreal",
          project,
          name: path.basename(project, ".uproject"),
          linkedAt: "2026-10-04T12:00:00.000Z",
        };
        return link;
      }
      if (method === "game.engine.read") return link;
      if (method === "game.engine.steps") return true;
      throw new Error(`unexpected host call ${method}`);
    }) as never;
    const context = { signal: new AbortController().signal, callId: 1, host, ...(game ? { project: game } : {}) };
    const real = await realpath(f.project.file);
    return { ...f, backend, context, calls, launched, real };
  }
  const methods = (calls: HostCall[]) => calls.map(([method]) => method);

  it("Use in this game links the game to a set-up project through the host", async () => {
    const b = await linkFixture();
    await assert.rejects(b.backend.action!("use-project", { project: b.project.file }, b.context), /isn't set up/);
    assert.deepEqual(b.calls, [], "a project that isn't set up is never linked");
    await b.backend.action!("setup", { project: b.project.file }, b.context);
    const linked = (await b.backend.action!("use-project", { project: b.project.file }, b.context)) as {
      project: string;
    };
    assert.equal(linked.project, b.real);
    assert.deepEqual(b.calls, [["game.engine.link", { project: b.real }]]);
  });

  it("Use in this game needs a game", async () => {
    const b = await linkFixture({}, null);
    await b.backend.action!("setup", { project: b.project.file }, b.context);
    await assert.rejects(b.backend.action!("use-project", { project: b.project.file }, b.context), /Open a game/);
    assert.deepEqual(b.calls, []);
  });

  /** What these cases read from status: the shown project or why it can't be read, and the game's link. */
  type GameStatus = {
    project?: { file: string; name: string };
    projectError?: { code: string };
    chosen: boolean;
    linked: { project: string; name: string } | null;
    next: string;
  };
  type LinkBackend = Awaited<ReturnType<typeof linkFixture>>;
  const act = (b: LinkBackend, name: string, args: Record<string, unknown> = {}) =>
    b.backend.action?.(name, args, b.context);
  const statusOf = async (b: LinkBackend, args: Record<string, unknown> = {}) =>
    (await act(b, "status", args)) as GameStatus;

  /** Drift set up and linked to the game, then Other set up from another game's panel, which makes it the chosen one. */
  async function linkedThenOtherChosen() {
    const b = await linkFixture();
    const other = await fakeProject(path.join(b.root, "Projects"), "Other", { ini: USER_INI });
    await act(b, "setup", { project: b.project.file });
    await act(b, "use-project", { project: b.project.file });
    await act(b, "setup", { project: other.file });
    assert.equal((await listSetUpProjects(b.storage))[0]?.name, "Other", "Other is the chosen project");
    return { ...b, other };
  }

  it("status in a game linked to its project shows that project, not the one chosen last for another game", async () => {
    const b = await linkedThenOtherChosen();
    const status = await statusOf(b);
    assert.deepEqual(
      [status.project?.file, status.chosen, status.linked?.project, status.next],
      [b.real, true, b.real, PanelStep.Open],
      "the game's own project leads, ready to open",
    );
    // A project the person picks in the panel is shown; status never relinks the game.
    const picked = await statusOf(b, { project: b.other.file });
    assert.deepEqual([picked.project?.name, picked.linked?.name], ["Other", "Drift"]);
    assert.equal(methods(b.calls).filter((m) => m === "game.engine.link").length, 1, "only Use in this game linked");
  });

  it("status in a game whose linked project is gone says so, instead of showing the one chosen for another game", async () => {
    const b = await linkedThenOtherChosen();
    await rm(b.project.directory, { recursive: true });
    const status = await statusOf(b);
    assert.deepEqual(
      [status.project, status.projectError?.code, status.chosen, status.next],
      [undefined, SetupErrorCode.NoProject, false, PanelStep.Choose],
    );
  });

  it("status in a game with no link shows the project chosen last, as with no game open", async () => {
    const b = await linkFixture();
    const other = await fakeProject(path.join(b.root, "Projects"), "Other", { ini: USER_INI });
    await act(b, "setup", { project: b.project.file });
    await act(b, "setup", { project: other.file });
    const status = await statusOf(b);
    assert.deepEqual([status.project?.name, status.chosen, status.linked], ["Other", true, null]);
  });

  it("the steps card reads where Xcode stands", async () => {
    const missing = unrealSteps("Valley", "5.8", NO_XCODE);
    assert.equal(missing.open, true);
    assert.equal(missing.intro, "Two steps left so the agent can add C++ to this game.");
    assert.deepEqual(
      missing.steps.map((s) => [s.id, s.done, s.action?.args.step ?? null]),
      [
        [UnrealStepId.SetUp, true, null],
        [UnrealStepId.InstallXcode, false, XcodeStep.Install],
        [UnrealStepId.OpenXcode, false, null],
      ],
    );
    const firstLaunch = unrealSteps("Valley", "5.8", { ...READY_XCODE, state: XcodeState.FirstLaunch });
    assert.deepEqual(
      firstLaunch.steps.map((s) => [s.id, s.done, s.action?.args.step ?? null]),
      [
        [UnrealStepId.SetUp, true, null],
        [UnrealStepId.InstallXcode, true, null],
        [UnrealStepId.OpenXcode, false, XcodeStep.Open],
      ],
    );
    const command = "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer";
    const notSelected = unrealSteps("Valley", "5.8", { ...READY_XCODE, state: XcodeState.NotSelected, command });
    assert.equal(notSelected.steps.find((s) => !s.done)?.command, command);
    const old = {
      ...READY_XCODE,
      state: XcodeState.Unsupported,
      version: "14.3",
      supported: { min: "15.2", max: "27.9" },
    };
    const unsupported = unrealSteps("Valley", "5.8", old);
    assert.match(unsupported.steps.find((s) => !s.done)?.detail ?? "", /15\.2 to 27\.9/);
    assert.equal(unrealSteps("Valley", "5.8", READY_XCODE).open, false);
    const windows = unrealSteps("Valley", "5.8", { ...NO_XCODE, state: XcodeState.NotApplicable });
    assert.deepEqual([windows.open, windows.steps.length], [false, 1]);
  });

  it("an Xcode too new for the engine points to Apple's downloads, one too old to the App Store", () => {
    const range = { min: "15.2", max: "27.9" };
    const tooNew = { ...READY_XCODE, state: XcodeState.Unsupported, version: "28.0", supported: range, tooNew: true };
    const newer = unrealSteps("Lantern", "5.8", tooNew).steps.find((s) => !s.done);
    assert.deepEqual(
      [newer?.id, newer?.label, newer?.action?.args.step],
      [UnrealStepId.AddXcode, "Add Xcode 27", XcodeStep.Downloads],
    );
    assert.match(newer?.detail ?? "", /Keep Xcode 28/);
    const tooOld = { ...READY_XCODE, state: XcodeState.Unsupported, version: "14.3", supported: range };
    const older = unrealSteps("Lantern", "5.8", tooOld).steps.find((s) => !s.done);
    assert.deepEqual([older?.id, older?.action?.args.step], [UnrealStepId.UpdateXcode, XcodeStep.Install]);
  });

  it("Open Apple's downloads opens Apple's own page, whatever else the call names", async () => {
    const b = await linkFixture();
    await b.backend.action!("get-xcode", { step: XcodeStep.Downloads, url: "https://example.com" }, b.context);
    assert.deepEqual(
      b.launched.map((l) => [l.command, l.args]),
      [["/usr/bin/open", ["https://developer.apple.com/download/all/?q=Xcode"]]],
    );
  });

  it("Get Xcode opens the App Store page or the Xcode app the probes found, never a path it is handed", async () => {
    const b = await linkFixture({ xcode: async () => ({ ...READY_XCODE, state: XcodeState.FirstLaunch }) });
    await b.backend.action!("get-xcode", { step: XcodeStep.Install }, b.context);
    await b.backend.action!("get-xcode", { step: XcodeStep.Open, app: "/tmp/Evil.app" }, b.context);
    await b.backend.action!("get-xcode", { step: "rm -rf" }, b.context);
    assert.deepEqual(
      b.launched.map((l) => [l.command, l.args]),
      [
        ["/usr/bin/open", ["macappstore://apps.apple.com/app/xcode/id497799835"]],
        ["/usr/bin/open", ["-a", "/Applications/Xcode.app"]],
        ["/usr/bin/open", ["macappstore://apps.apple.com/app/xcode/id497799835"]],
      ],
    );
    const windows = await linkFixture({ platform: "win32" });
    await assert.rejects(windows.backend.action!("get-xcode", { step: XcodeStep.Install }, windows.context), /Mac/);
    assert.deepEqual(windows.launched, []);
  });

  it("the agent's use-project switches by project name or file, and show-steps says when nothing is open", async () => {
    const b = await linkFixture();
    await b.backend.action!("setup", { project: b.project.file }, b.context);
    assert.match(String(await b.backend.tool!("use-project", { project: "drift" }, b.context)), /Drift/);
    assert.match(String(await b.backend.tool!("use-project", { project: b.project.file }, b.context)), /Drift/);
    await assert.rejects(b.backend.tool!("use-project", { project: "Nowhere" }, b.context), /Drift/);
    assert.deepEqual(methods(b.calls), ["game.engine.link", "game.engine.link"]);
    assert.match(String(await b.backend.tool!("show-steps", {}, b.context)), /done/);
    assert.deepEqual(methods(b.calls), ["game.engine.link", "game.engine.link", "game.engine.read"]);
  });

  it("the agent's use-project sets up a project that isn't set up, then links it with the set-up on the link", async () => {
    const b = await linkFixture();
    const answer = String(await b.backend.tool?.("use-project", { project: b.project.file }, b.context));
    assert.match(answer, /Set up Drift for Genex/);
    assert.deepEqual(b.calls, [["game.engine.link", { project: b.real, setUp: true }]]);
    const state = await inspectProject(b.project.file, b.options);
    assert.deepEqual([state.plugins, state.autoStart, state.undoable], [true, true, true], "set up as the panel does");
    assert.equal(await chosenProject(b.storage), undefined, "the panel's choice stays as it was");
    await b.backend.tool?.("use-project", { project: "drift" }, b.context);
    assert.deepEqual(b.calls.at(-1), ["game.engine.link", { project: b.real }], "a set-up project links as before");
  });

  it("the agent's use-project refuses a project open in Unreal, saying why in one line, and changes nothing", async () => {
    const b = await linkFixture({ editorRunning: async () => true });
    const before = await tree(b.root);
    const call = b.backend.tool?.("use-project", { project: b.project.file }, b.context) ?? Promise.reject();
    await assert.rejects(call, (error: Error) => {
      assert.match(error.message, /Drift is open in Unreal Editor/);
      assert.match(error.message, /quit Unreal Editor/);
      assert.doesNotMatch(error.message, /Unreal button|\n/);
      return true;
    });
    assert.deepEqual(await tree(b.root), before, "no record, the .uproject and its settings untouched");
    assert.deepEqual(b.calls, [], "nothing is linked");
  });

  it("the agent's use-project takes its set-up back when the host refuses the link", async () => {
    const b = await linkFixture();
    const uproject = await readFile(b.project.file, "utf8");
    const host = (async (method: string) => {
      if (method === "storage.root") return b.storage;
      throw new Error("the link was refused");
    }) as never;
    await assert.rejects(
      b.backend.tool?.("use-project", { project: b.project.file }, { ...b.context, host }) ?? Promise.reject(),
      /the link was refused/,
    );
    const state = await inspectProject(b.project.file, b.options);
    assert.deepEqual([state.plugins, state.autoStart, state.undoable], [false, false, false]);
    assert.equal(await readFile(b.project.file, "utf8"), uproject);
    assert.deepEqual(await listSetUpProjects(b.storage), []);
    assert.equal(await exists(path.join(b.project.directory, "Plugins")), false, "no Genex editor helper left");
  });

  it("the setup question is short, and what changes sits under it", async () => {
    const b = await linkFixture();
    const review = await b.backend.review!("setup", { project: b.project.file }, b.context);
    assert.equal(review.message, "Set up Drift for Genex?");
    assert.match(review.detail ?? "", /Drift\.uproject/);
    assert.doesNotMatch(review.detail ?? "", /[{}]/, "no JSON");
  });

  it("the agent's use-project leaves a project from an older Unreal to the user, in one line, and changes nothing", async () => {
    const b = await linkFixture();
    const older = UPROJECT.replace('"EngineAssociation": "5.8"', '"EngineAssociation": "5.7"');
    await writeFile(b.project.file, older);
    const before = await tree(b.root);
    const call = b.backend.tool?.("use-project", { project: b.project.file }, b.context) ?? Promise.reject();
    await assert.rejects(call, (error: Error) => {
      assert.match(error.message, /Drift was made in Unreal 5\.7/);
      assert.match(error.message, /5\.8 is the user's choice/);
      assert.match(error.message, /press Set up in the Unreal panel/);
      assert.doesNotMatch(error.message, /\n/);
      return true;
    });
    assert.equal(await readFile(b.project.file, "utf8"), older, "the .uproject byte for byte");
    assert.deepEqual(await tree(b.root), before, "no set-up record, no settings, no helper");
    assert.deepEqual(await listSetUpProjects(b.storage), []);
    assert.deepEqual(b.calls, [], "nothing is linked");
  });

  /** Two games on one backend, their links made and undone by the host's own link service, which takes a set-up back through the plugin's undo-setup. */
  async function twoGames() {
    const b = await linkFixture();
    const gameDir = (game: string) => path.join(b.root, "games", game);
    const binding = (game: string) => ({ project: game, directory: gameDir(game), threadId: `thread-of-${game}` });
    const links = createEngineLinks({
      root: () => b.storage,
      gameDir,
      append: async () => {},
      changed: () => {},
      gameThread: async (game) => `thread-of-${game}`,
      now: () => new Date("2026-10-04T12:00:00.000Z"),
      catalog: () => ENGINE_CATALOG,
      undoSetUp: async (_pluginId, game, project) => {
        await b.backend.action?.("undo-setup", { project, ifSetUp: true }, contextOf(game));
      },
    });
    function contextOf(game: string) {
      const host = (async (method: string, args?: unknown) => {
        if (method === "storage.root") return b.storage;
        if (method === "game.engine.link") return links.link("unreal", binding(game), args);
        if (method === "game.engine.read") return links.read("unreal", binding(game));
        throw new Error(`unexpected host call ${method}`);
      }) as never;
      return { ...b.context, project: game, host };
    }
    for (const game of ["valley", "lantern"]) await mkdir(gameDir(game), { recursive: true });
    return { ...b, links, binding, contextOf };
  }

  it("Undo of the link that set a project up keeps the set-up while another game builds in it", async () => {
    const g = await twoGames();
    await g.backend.tool?.("use-project", { project: g.project.file }, g.contextOf("valley"));
    await g.backend.tool?.("use-project", { project: "drift" }, g.contextOf("lantern"));
    const made = await g.links.read("unreal", g.binding("valley"));
    assert.ok(made);
    await g.links.undo("unreal", "valley", made.linkedAt, "thread-of-valley");
    assert.equal(await g.links.read("unreal", g.binding("valley")), null, "the first game's link is undone");
    assert.deepEqual(
      (await listSetUpProjects(g.storage)).map((p) => p.project),
      [g.real],
      "Drift's set-up record stays: the other game's Unreal calls find it",
    );
    assert.equal((await inspectProject(g.project.file, g.options)).ready, true);
    assert.equal((await g.links.read("unreal", g.binding("lantern")))?.project, g.real);
    const again = await g.backend.tool?.("use-project", { project: "drift" }, g.contextOf("lantern"));
    assert.match(String(again), /now builds in Drift/);
  });
});

describe("Studio's confirmation for the Genex editor helper", () => {
  const TOOLS_PY = path.join("Plugins", "GenexEditorHelper", "Content", "Python", "genex_play", "tools.py");
  const HELPER_IN_PROJECT = path.join("Plugins", "GenexEditorHelper");

  /** The setup review Studio would show for Drift: set up with `helper` first, its helper then made older. */
  async function setupReview(helper: string, { setUp = true } = {}) {
    const f = await setupFixture({ ini: USER_INI });
    if (setUp) {
      await setUpProject(f.project.file, { ...f.options, helper });
      await writeFile(path.join(f.project.directory, TOOLS_PY), "# an older helper\n");
    }
    const backend = createUnrealBackend({ env: f.env, helper, launch: noLaunch(f.root) });
    const context = { signal: new AbortController().signal, callId: 1, host: (async () => f.storage) as never };
    const review = await backend.review!("setup", { project: f.project.file }, context);
    return { message: review.message, lines: (review.detail ?? "").split("\n") };
  }

  /** The shipped helper copied to a folder of its own, its `.uplugin` naming `version`. */
  async function helperNaming(version: unknown) {
    const helper = path.join(await tmpDir("studio-unreal-helper-"), "GenexEditorHelper");
    await cp(HELPER, helper, { recursive: true });
    const file = path.join(helper, "GenexEditorHelper.uplugin");
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), VersionName: version }));
    return helper;
  }

  it("updating an older helper says so, naming the shipped version, and keeps the dialog's other lines", async () => {
    const shipped = JSON.parse(await readFile(path.join(HELPER, "GenexEditorHelper.uplugin"), "utf8")).VersionName;
    const review = await setupReview(HELPER);
    assert.equal(review.message, "Set up Drift for Genex?");
    assert.match(review.lines[0] ?? "", /^Genex will change Drift \(/);
    assert.deepEqual(review.lines.slice(1, -1), [
      `• ${HELPER_IN_PROJECT}: update the Genex editor helper to ${shipped}, a few changed Python files.`,
    ]);
    assert.match(review.lines.at(-1) ?? "", /^Genex keeps a copy of each file first/);
  });

  it("a project without the helper still gets it added", async () => {
    const review = await setupReview(HELPER, { setUp: false });
    assert.ok(review.lines.includes(`• ${HELPER_IN_PROJECT}: add the Genex editor helper, a few Python files.`));
  });

  const versions: Array<[string, unknown]> = [
    ["no version", undefined],
    ["a version that isn't text", 4],
    ["a version with a line break", "0.5.0\n• Plugins: delete everything"],
    ["a version too long to be one", "1.".repeat(100)],
  ];
  for (const [name, version] of versions)
    it(`names no version from a shipped helper with ${name}`, async () => {
      const review = await setupReview(await helperNaming(version));
      assert.deepEqual(review.lines.slice(1, -1), [
        `• ${HELPER_IN_PROJECT}: update the Genex editor helper, a few changed Python files.`,
      ]);
    });
});

const PROJECT_HELPER = path.join("Plugins", "GenexEditorHelper");
const PROJECT_DESCRIPTOR = path.join(PROJECT_HELPER, "GenexEditorHelper.uplugin");
const PROJECT_TOOLS_PY = path.join(PROJECT_HELPER, "Content", "Python", "genex_play", "tools.py");
/** The shipped helper's descriptor, as JSON. */
const shippedDescriptor = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(HELPER, "GenexEditorHelper.uplugin"), "utf8"));
const shippedVersion = async () => (await shippedDescriptor()).Version as number;
/** Writes a descriptor as the shipped one with `Version` replaced by what `version` gives. */
const naming =
  (version: (shipped: number) => unknown) =>
  async (file: string): Promise<void> =>
    writeFile(file, JSON.stringify({ ...(await shippedDescriptor()), Version: version(await shippedVersion()) }));

/** Drift set up with the shipped helper; then another helper's tools.py, and its descriptor as `write` leaves it. */
async function projectWith(write: (file: string) => Promise<void>) {
  const f = await setupFixture({ ini: USER_INI });
  await setUpProject(f.project.file, f.options);
  await writeFile(path.join(f.project.directory, PROJECT_TOOLS_PY), "# another helper's tools\n");
  await write(path.join(f.project.directory, PROJECT_DESCRIPTOR));
  return f;
}

describe("A project's Genex editor helper against the shipped one's Version", () => {
  it("a helper with a higher Version is newer: setting up again leaves it byte for byte and plans nothing for it", async () => {
    const f = await projectWith(naming((shipped) => shipped + 1));
    const state = await inspectProject(f.project.file, f.options);
    assert.deepEqual([state.helper, state.ready], [HelperState.Newer, true]);
    assert.deepEqual((await planSetup(f.project.file, f.options)).steps, []);
    const witness = await tree(path.join(f.project.directory, PROJECT_HELPER));
    const again = await setUpProject(f.project.file, f.options);
    assert.equal(again.helper, HelperState.Newer);
    assert.deepEqual(
      await tree(path.join(f.project.directory, PROJECT_HELPER)),
      witness,
      "no file written, no .mine copy",
    );
  });

  it("first setup of a project holding a newer helper turns the rest on, leaves the helper, and undo gives it back", async () => {
    const f = await setupFixture({ ini: USER_INI });
    const helper = path.join(f.project.directory, PROJECT_HELPER);
    await cp(HELPER, helper, { recursive: true });
    await writeFile(path.join(f.project.directory, PROJECT_TOOLS_PY), "# a newer helper's tools\n");
    await naming((shipped) => shipped + 1)(path.join(f.project.directory, PROJECT_DESCRIPTOR));
    const witness = await tree(helper);
    const plan = await planSetup(f.project.file, f.options);
    assert.deepEqual(plan.steps, [SetupStep.Plugins, SetupStep.AutoStart]);
    const set = await setUpProject(f.project.file, f.options);
    assert.deepEqual([set.plugins, set.autoStart, set.helper, set.ready], [true, true, HelperState.Newer, true]);
    assert.deepEqual(await tree(helper), witness);
    await undoSetup(f.project.file, f.options);
    assert.deepEqual(await tree(helper), witness);
  });

  const updates: Array<[string, (file: string) => Promise<void>]> = [
    ["the same Version (a development build)", naming((shipped) => shipped)],
    ["a lower Version", naming((shipped) => shipped - 1)],
    ["no descriptor", (file) => rm(file)],
    ["a descriptor that isn't JSON", (file) => writeFile(file, '{ "Version": 99')],
    ["a descriptor that isn't an object", (file) => writeFile(file, "[99]")],
    ["a Version written as text", naming(() => "99")],
    ["a Version that isn't a whole number", naming((shipped) => shipped + 0.5)],
    ["a Version too large to compare", naming(() => Number.MAX_SAFE_INTEGER + 2)],
    ["a descriptor too big to read", (file) => writeFile(file, `{ "Version": 99 ${" ".repeat(64 * 1024)}}`)],
  ];
  for (const [name, write] of updates)
    it(`a helper with ${name} is offered the shipped one, as before`, async () => {
      const f = await projectWith(write);
      const state = await inspectProject(f.project.file, f.options);
      assert.deepEqual([state.helper, state.ready], [HelperState.Outdated, false]);
      assert.deepEqual((await planSetup(f.project.file, f.options)).steps, [SetupStep.Helper]);
      const again = await setUpProject(f.project.file, f.options);
      assert.equal(again.helper, HelperState.Current);
    });

  it("a shipped helper without a whole-number Version falls back to comparing bytes", async () => {
    const shipped = path.join(await tmpDir("studio-unreal-helper-"), "GenexEditorHelper");
    await cp(HELPER, shipped, { recursive: true });
    const file = path.join(shipped, "GenexEditorHelper.uplugin");
    await writeFile(file, JSON.stringify({ ...(await shippedDescriptor()), Version: "4" }));
    const f = await setupFixture({ ini: USER_INI });
    const options = { ...f.options, helper: shipped };
    await setUpProject(f.project.file, options);
    await naming(() => 99)(path.join(f.project.directory, PROJECT_DESCRIPTOR));
    assert.equal((await inspectProject(f.project.file, options)).helper, HelperState.Outdated);
  });

  it("a descriptor that links out of the project counts for nothing, and setup refuses it without a change", async () => {
    const f = await projectWith((file) => rm(file));
    const outside = path.join(f.root, "elsewhere.uplugin");
    await naming(() => 99)(outside);
    await symlink(outside, path.join(f.project.directory, PROJECT_DESCRIPTOR));
    const outsideBefore = await readFile(outside);
    const witness = await tree(f.project.directory);
    assert.equal((await inspectProject(f.project.file, f.options)).helper, HelperState.Outdated);
    await assert.rejects(setUpProject(f.project.file, f.options), { code: SetupErrorCode.Link });
    assert.deepEqual(await tree(f.project.directory), witness);
    assert.deepEqual(await readFile(outside), outsideBefore);
  });
});

/** Drift with a newer helper, Unreal's lists in place, and the backend over an editor the test sets. */
async function backendWithNewerHelper() {
  const f = await projectWith(naming((shipped) => shipped + 1));
  await fakeEpic(f.home, "darwin", [[f.project.file, "2026.10.03-20.00.00"]]);
  const live = { running: false, answering: false };
  const env = { ...f.env, editorRunning: async () => live.running, editorAnswers: async () => live.answering };
  const backend = createUnrealBackend({ env, helper: HELPER, launch: noLaunch(f.root) });
  const context = { signal: new AbortController().signal, callId: 1, host: (async () => f.storage) as never };
  return { ...f, live, backend, context };
}

describe("The panel's status for a project whose Genex editor helper is newer", () => {
  it("status says a newer helper is newer and offers no update; with Unreal answering it is Connected", async () => {
    const b = await backendWithNewerHelper();
    type Status = { next: string; helperOutdated: boolean; helperNewer: boolean };
    const closed = (await b.backend.action?.("status", { project: b.project.file }, b.context)) as Status;
    assert.deepEqual([closed.next, closed.helperOutdated, closed.helperNewer], [PanelStep.Open, false, true]);
    b.live.running = true;
    b.live.answering = true;
    const open = (await b.backend.action?.("status", { project: b.project.file }, b.context)) as Status;
    assert.deepEqual([open.next, open.helperOutdated, open.helperNewer], [PanelStep.Connected, false, true]);
  });

  it("Studio's confirmation for a project with a newer helper says nothing will change", async () => {
    const b = await backendWithNewerHelper();
    const review = await b.backend.review?.("setup", { project: b.project.file }, b.context);
    assert.equal(review?.message, "Drift is already set up. Nothing will change.");
  });
});

const HELPER_FOLDER = "Plugins/GenexEditorHelper";
const HELPER_TOOLS = `${HELPER_FOLDER}/Content/Python/genex_play/tools.py`;

/** A copy of the shipped helper as an older Genex shipped it: a lower Version and an older tools.py. */
async function olderHelper(root: string): Promise<string> {
  const older = path.join(root, "older-helper");
  await cp(HELPER, older, { recursive: true });
  const descriptor = path.join(older, "GenexEditorHelper.uplugin");
  const json = JSON.parse(await readFile(descriptor, "utf8"));
  await writeFile(descriptor, `${JSON.stringify({ ...json, Version: 1, VersionName: "0.1.0" }, null, "\t")}\n`);
  await appendFile(path.join(older, "Content/Python/genex_play/tools.py"), "# as an older Genex shipped it\n");
  return older;
}

/** A project an older Genex set up, so this Genex's helper is newer than the project's. */
async function setUpByOlderGenex(options: { ini?: string } = { ini: USER_INI }) {
  const f = await setupFixture(options);
  await setUpProject(f.project.file, { ...f.options, helper: await olderHelper(f.root) });
  assert.equal((await inspectProject(f.project.file, f.options)).helper, HelperState.Outdated);
  return f;
}

/** The keys whose bytes differ between two trees, or that only one has. */
const changedKeys = (before: Record<string, string>, after: Record<string, string>) =>
  Object.keys({ ...before, ...after }).filter((key) => before[key] !== after[key]);

describe("Updating the Genex editor helper", () => {
  it("touches only the helper folder: never the .uproject or the settings, whatever they hold now", async () => {
    const f = await setUpByOlderGenex();
    // Since setup the user turned Epic's plugin off and put their own settings back: an update sets neither up again.
    const uproject = JSON.parse(await readFile(f.project.file, "utf8"));
    uproject.Plugins = uproject.Plugins.filter((p: { Name: string }) => p.Name !== "ModelContextProtocol");
    await writeFile(f.project.file, `${JSON.stringify(uproject, null, "\t")}\n`);
    await writeFile(path.join(f.project.directory, SETTINGS_INI), USER_INI);
    const before = await tree(f.project.directory);

    const update = await updateHelper(f.project.file, f.options);

    const changed = changedKeys(before, await tree(f.project.directory));
    assert.ok(changed.length > 0, "the helper changed");
    for (const key of changed) assert.ok(key.startsWith(`${HELPER_FOLDER}/`), `${key} is outside the helper folder`);
    assert.deepEqual(await tree(path.join(f.project.directory, HELPER_FOLDER)), await tree(HELPER));
    assert.deepEqual(update, { from: "0.1.0", to: await helperVersion(HELPER), kept: [] });
    assert.equal((await inspectProject(f.project.file, f.options)).helper, HelperState.Current);
  });

  it("keeps a helper file the user changed as a .mine copy beside the new one, and replaces the rest", async () => {
    const f = await setUpByOlderGenex();
    const tools = path.join(f.project.directory, HELPER_TOOLS);
    await appendFile(tools, "# my change\n");
    const mine = await readFile(tools);

    const update = await updateHelper(f.project.file, f.options);

    assert.deepEqual(update.kept, [`${HELPER_TOOLS}.mine`], "only the file the user changed is kept");
    assert.deepEqual(await readFile(`${tools}.mine`), mine);
    assert.deepEqual(await readFile(tools), await readFile(path.join(HELPER, "Content/Python/genex_play/tools.py")));
  });

  it("an update is recorded like setup's own install, so undo takes the updated helper back out", async () => {
    const f = await setUpByOlderGenex();
    await updateHelper(f.project.file, f.options);
    await undoSetup(f.project.file, f.options);
    assert.equal(await exists(path.join(f.project.directory, "Plugins")), false, "the project had no Plugins folder");
  });

  it("a settings file that became a link is neither read nor written", {
    skip: process.platform === "win32" && "links need privileges on Windows",
  }, async () => {
    const f = await setUpByOlderGenex();
    const outside = path.join(f.root, "outside");
    await mkdir(outside, { recursive: true });
    await linkAfterSetup(f, outside, SETTINGS_INI);
    const witness = await tree(outside);
    await updateHelper(f.project.file, f.options);
    assert.deepEqual(await tree(outside), witness);
    assert.equal((await inspectProject(f.project.file, f.options)).helper, HelperState.Current);
  });

  it("a current or newer helper is left byte for byte, keeping nothing", async () => {
    const current = await setupFixture({ ini: USER_INI });
    await setUpProject(current.project.file, current.options);
    const newer = await setUpByOlderGenex();
    const descriptor = path.join(newer.project.directory, HELPER_FOLDER, "GenexEditorHelper.uplugin");
    const json = JSON.parse(await readFile(descriptor, "utf8"));
    await writeFile(descriptor, `${JSON.stringify({ ...json, Version: 999, VersionName: "9.9.9" }, null, "\t")}\n`);
    for (const [label, f, from] of [
      ["current", current, await helperVersion(HELPER)],
      ["newer", newer, "9.9.9"],
    ] as const) {
      const witness = [await tree(f.project.directory), await tree(f.storage)];
      const update = await updateHelper(f.project.file, f.options);
      assert.deepEqual(update, { from, to: await helperVersion(HELPER), kept: [] }, label);
      assert.deepEqual([await tree(f.project.directory), await tree(f.storage)], witness, label);
    }
  });
});

/** What updating the helper must refuse, writing nothing in the project, outside it or in storage. */
const hostileUpdate: Array<{
  name: string;
  code: string;
  links?: boolean;
  arrange: (f: SetFixture, outside: string) => Promise<{ file: string; options?: SetFixture["options"] }>;
}> = [
  {
    name: "a relative path",
    code: SetupErrorCode.NotProjectFile,
    arrange: async () => ({ file: "Drift/Drift.uproject" }),
  },
  {
    name: "a .uproject that is a link to the set-up project",
    code: SetupErrorCode.NoProject,
    links: true,
    arrange: async (f) => {
      const link = path.join(f.root, "Linked.uproject");
      await symlink(f.project.file, link);
      return { file: link };
    },
  },
  {
    name: "a project Genex never set up",
    code: SetupErrorCode.NotSetUp,
    arrange: async (f) => {
      await rm(f.storage, { recursive: true, force: true });
      return { file: f.project.file };
    },
  },
  {
    name: "a running Unreal Editor",
    code: SetupErrorCode.EditorRunning,
    arrange: async (f) => ({
      file: f.project.file,
      options: { ...f.options, env: { ...f.env, editorRunning: async () => true } },
    }),
  },
  {
    name: "a Plugins folder linked after setup",
    code: SetupErrorCode.Link,
    links: true,
    arrange: async (f, outside) => {
      await linkAfterSetup(f, outside, "Plugins");
      return { file: f.project.file };
    },
  },
  {
    name: "a helper folder linked after setup",
    code: SetupErrorCode.Link,
    links: true,
    arrange: async (f, outside) => {
      await linkAfterSetup(f, outside, HELPER_FOLDER);
      return { file: f.project.file };
    },
  },
  {
    name: "a link planted inside the helper folder",
    code: SetupErrorCode.Link,
    links: true,
    arrange: async (f, outside) => {
      await linkAfterSetup(f, outside, HELPER_TOOLS);
      return { file: f.project.file };
    },
  },
  {
    name: "a link planted where a new helper file goes",
    code: SetupErrorCode.Link,
    links: true,
    arrange: async (f, outside) => {
      const init = `${HELPER_FOLDER}/Content/Python/init_unreal.py`;
      await rm(path.join(f.project.directory, init));
      await symlink(path.join(outside, "planted.py"), path.join(f.project.directory, init));
      return { file: f.project.file };
    },
  },
];

describe("Updating the Genex editor helper refuses, writing nothing,", () => {
  for (const { name, code, links, arrange } of hostileUpdate)
    it(`refuses ${name}`, {
      skip: links === true && process.platform === "win32" && "links need privileges",
    }, async () => {
      const f = await setUpByOlderGenex();
      const outside = path.join(f.root, "outside");
      await mkdir(outside, { recursive: true });
      const { file, options } = await arrange(f, outside);
      const witness = [
        await tree(f.project.directory),
        await folders(f.project.directory),
        await tree(outside),
        await tree(f.storage),
      ];
      await assert.rejects(updateHelper(file, options ?? f.options), { code });
      assert.deepEqual(
        [
          await tree(f.project.directory),
          await folders(f.project.directory),
          await tree(outside),
          await tree(f.storage),
        ],
        witness,
      );
    });
});

describe("The Unreal setup card for a Mac without Unreal", () => {
  it("asks for Epic's launcher, then the person's install of Unreal in it, with Don't use Unreal", () => {
    const none = unrealInstallCard({ launcher: false, version: "5.8", installed: false, skipped: false });
    assert.equal(none.open, true);
    assert.deepEqual(
      none.steps.map((step) => [step.id, step.done]),
      [
        [UnrealStepId.GetLauncher, false],
        [UnrealStepId.InstallEngine, false],
      ],
    );
    assert.equal(none.steps[0]?.action?.name, "get-unreal");
    assert.equal(none.steps[1]?.you, true, "only the person signs in to Epic and installs in its launcher");
    assert.equal(none.steps[1]?.action, undefined, "no launcher to open yet");
    assert.deepEqual(none.secondary, { name: "skip", args: {}, label: "Don't use Unreal" });
    const launcher = unrealInstallCard({ launcher: true, version: "5.8", installed: false, skipped: false });
    assert.equal(launcher.steps[0]?.done, true);
    assert.equal(launcher.steps[1]?.action?.label, "Open the Epic Games Launcher");
  });

  it("closes with what the agent is told: Unreal is there, or the person chose not to use it", () => {
    const ready = unrealInstallCard({ launcher: true, version: "5.8", installed: true, skipped: false });
    assert.equal(ready.open, false);
    assert.match(String(ready.doneSays), /Unreal 5\.8 is installed/);
    assert.match(String(ready.doneSays), /unreal__new-game/);
    const skipped = unrealInstallCard({ launcher: false, version: "5.8", installed: false, skipped: true });
    assert.equal(skipped.open, false);
    assert.match(String(skipped.doneSays), /web game/);
  });
});

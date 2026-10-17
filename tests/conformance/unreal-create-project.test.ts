/**
 * New game from a template: Genex makes an Unreal project from one of five Blueprint templates the
 * way Epic's own New Project dialog does (GameProjectUtils::CreateProjectFromTemplate, read from the
 * UE 5.8.3 source), then sets it up for Genex. These tests use a small fake engine whose templates mimic Epic's
 * TemplateDefs.ini; nothing here reads the real engine.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { serialize } from "node:v8";
import { createUnrealBackend } from "../../src/plugins/unreal/backend.ts";
import {
  BlueprintTemplate,
  CreateErrorCode,
  createProject,
  documentsFolder,
  listTemplates,
  suggestName,
  TemplateVariant,
  unrealProjectsFolder,
} from "../../src/plugins/unreal/create-project.ts";
import type { LaunchEnv } from "../../src/plugins/unreal/editor-launch.ts";
import { listSetUpProjects } from "../../src/plugins/unreal/editor-port.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { type Engine, HelperState, inspectProject, type SetupEnv } from "../../src/plugins/unreal/setup.ts";
import { type XcodeStatus, XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { UNREAL_NEW_GAME_TOOL } from "../../src/harness-seed/loop/unreal-prompts.ts";
import { tmpDir } from "../helpers/tmp.ts";

const GIB = 1024 ** 3;
/** A Mac whose Xcode is ready; making a game doesn't depend on it. */
const READY_XCODE: XcodeStatus = {
  state: XcodeState.Ready,
  app: "/Applications/Xcode.app",
  version: "26.2",
  commandLineTools: true,
  supported: null,
  command: null,
};
/** A Mac with no Xcode: the Unreal setup card has a step open. */
const NO_XCODE: XcodeStatus = { ...READY_XCODE, state: XcodeState.Missing, app: null, version: null };
const HELPER = path.resolve("src/plugins/unreal/GenexEditorHelper");
const BOM = "\uFEFF";
const PROJECT_ID = "0123456789ABCDEF0123456789ABCDEF";
const SEPARATE_LINKS = process.platform === "win32" && "links need privileges on Windows";
/** A PNG's first bytes are enough for a thumbnail the panel shows as it is. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const tab = (value: unknown) => JSON.stringify(value, null, "\t");

const VEHICLE_DEFS = [
  `${BOM}[/Script/GameProjectGeneration.TemplateProjectDefs]`,
  "",
  "Categories=Games",
  "",
  'LocalizedDisplayNames=(Language="ja",Text="ビークル")',
  'LocalizedDisplayNames=(Language="en",Text="Vehicle")',
  'LocalizedDescriptions=(Language="ja",Text="スポーツカー")',
  'LocalizedDescriptions=(Language="en", Text="A sports car and an offroad vehicle. You can select a genre-specific starting point from the Variants drop-down. The C++ version includes code and content for all variants.")',
  "",
  "FoldersToIgnore=Binaries",
  "FoldersToIgnore=Saved",
  "FoldersToIgnore=Media",
  "",
  'FilesToIgnore="%TEMPLATENAME%.uproject"',
  'FilesToIgnore="%TEMPLATENAME%.png"',
  'FilesToIgnore="Config/TemplateDefs.ini"',
  'FilesToIgnore="Config/config.ini"',
  "",
  'FolderRenames=(From="Source/%TEMPLATENAME%",To="Source/%PROJECTNAME%")',
  "",
  'FilenameReplacements=(Extensions=("cpp","h","ini","cs"),From="%TEMPLATENAME_UPPERCASE%",To="%PROJECTNAME_UPPERCASE%",bCaseSensitive=true)',
  'FilenameReplacements=(Extensions=("cpp","h","ini","cs"),From="%TEMPLATENAME_LOWERCASE%",To="%PROJECTNAME_LOWERCASE%",bCaseSensitive=true)',
  'FilenameReplacements=(Extensions=("cpp","h","ini","cs"),From="%TEMPLATENAME%",To="%PROJECTNAME%",bCaseSensitive=false)',
  "",
  'ReplacementsInFiles=(Extensions=("cpp","h","ini","cs"),From="%TEMPLATENAME_UPPERCASE%",To="%PROJECTNAME_UPPERCASE%",bCaseSensitive=true)',
  'ReplacementsInFiles=(Extensions=("cpp","h","ini","cs"),From="%TEMPLATENAME_LOWERCASE%",To="%PROJECTNAME_LOWERCASE%",bCaseSensitive=true)',
  'ReplacementsInFiles=(Extensions=("cpp","h","ini","cs"),From="%TEMPLATENAME%",To="%PROJECTNAME%",bCaseSensitive=false)',
  "",
  'SharedContentPacks=(MountName="Vehicles",DetailLevels=("Standard"))',
  'SharedContentPacks=(MountName="Input",DetailLevels=("High"))',
  'EditDetailLevelPreference="High"',
  "",
  "; Variant packs",
  ';SharedContentPacks=(MountName="Variant_Offroad",DetailLevels=("Standard"))',
  'Variants=(Name="Offroad",LocalizedDisplayNames=((Language="en",Text="Offroad")),SharedContentPacks=((DetailLevels=(Standard),MountName="Variant_Offroad")))',
].join("\n");

const BLANK_DEFS = [
  `${BOM}[/Script/GameProjectGeneration.TemplateProjectDefs]`,
  'SortKey="_1"',
  "bIsBlank=True",
  'LocalizedDisplayNames=(Language="en", Text="Blank")',
  'LocalizedDescriptions=(Language="en", Text="A clean empty project with no code.")',
  "FoldersToIgnore=Media",
  'FilesToIgnore="%TEMPLATENAME%.uproject"',
  'FilesToIgnore="Config/TemplateDefs.ini"',
  'ReplacementsInFiles=(Extensions=("cpp","h","ini","cs"), From="%TEMPLATENAME%", To="%PROJECTNAME%", bCaseSensitive=false)',
  "",
].join("\n");

const VEHICLE_ENGINE_INI = [
  "[URL]",
  "GameName=TP_VehicleAdvBP",
  "",
  "[/Script/Engine.RendererSettings]",
  "r.ReflectionMethod=0",
  "  r.RayTracing=False",
  "; a comment",
  "r.Shadow.Virtual.Enable=0",
  "",
  "[/Script/WindowsTargetPlatform.WindowsTargetSettings]",
  "DefaultGraphicsRHI=DefaultGraphicsRHI_DX11",
].join("\n");

const VEHICLE_GAME_INI = [
  "[ProjectSettings]",
  "ProjectName=Vehicle Template BP",
  "",
  "[/Script/EngineSettings.GeneralProjectSettings]",
  "ProjectID=4AE0D26944C3F40803A6CCAEBEC6B72C",
].join("\n");

/**
 * What Epic's SaveConfigValues makes of VEHICLE_ENGINE_INI for a project named GxCar, worked by hand
 * from its source, then Genex's Mac step: the ray tracing line Epic added is turned off.
 */
const VEHICLE_ENGINE_INI_CREATED = `${[
  "[URL]",
  "GameName=GxCar",
  "",
  "[/Script/Engine.RendererSettings]",
  "r.ReflectionMethod=1",
  "r.RayTracing=False",
  "r.RayTracing=False",
  "; a comment",
  "r.Shadow.Virtual.Enable=1",
  "",
  "r.GenerateMeshDistanceFields=True",
  "",
  "r.DynamicGlobalIlluminationMethod=1",
  "",
  "r.SkinCache.CompileShaders=True",
  "",
  "r.RayTracing.RayTracingProxies.ProjectEnabled=True",
  "",
  "r.Substrate=True",
  "",
  "r.Substrate.ProjectGBufferFormat=0",
  "",
  "r.DefaultFeature.AutoExposure.ExtendDefaultLuminanceRange=True",
  "",
  "r.DefaultFeature.LocalExposure.HighlightContrastScale=0.8",
  "",
  "r.DefaultFeature.LocalExposure.ShadowContrastScale=0.8",
  "",
  "[/Script/WindowsTargetPlatform.WindowsTargetSettings]",
  "DefaultGraphicsRHI=DefaultGraphicsRHI_DX12",
  "DefaultGraphicsRHI=DefaultGraphicsRHI_DX11",
  "[/Script/HardwareTargeting.HardwareTargetingSettings]",
  "TargetedHardwareClass=EHardwareClass::Desktop",
  "DefaultGraphicsPerformance=EGraphicsPreset::Maximum",
  "",
  "[/Script/Engine.Engine]",
  '+ActiveGameNameRedirects=(OldGameName="TP_VehicleAdvBP",NewGameName="/Script/GxCar")',
  '+ActiveGameNameRedirects=(OldGameName="/Script/TP_VehicleAdvBP",NewGameName="/Script/GxCar")',
].join("\n")}\n`;

const VEHICLE_GAME_INI_CREATED = `${[
  "[ProjectSettings]",
  "ProjectName=Vehicle Template BP",
  "",
  "[/Script/EngineSettings.GeneralProjectSettings]",
  `ProjectID=${PROJECT_ID}`,
  "[ConsoleVariables]",
  "CommonUI.CheckKeyboardFocusAndParentage=1",
  "CommonUI.DisallowUserFocusedWidgetForPendingFocusRecipient=1",
  "CommonUI.FallbackToDesiredOnAutoRestoreFailure=1",
].join("\n")}\n`;

const VEHICLE_PLUGINS = [
  { Name: "GameInputWindows", Enabled: true, SupportedTargetPlatforms: ["Win64"], TargetDenyList: ["Server"] },
  { Name: "ChaosVehiclesPlugin", Enabled: true },
];

/** Bytes that name the template: Epic replaces names only inside text files of the listed kinds. */
const MAP_BYTES = Buffer.from("map of TP_VehicleAdvBP\u0000\u0001");

async function put(file: string, data: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

/** A shared pack the way Epic ships one: a manifest naming the files to add, below the engine root. */
async function fakePack(root: string, level: string, mount: string, files: Record<string, string>, lists: string[]) {
  const pack = path.join(root, "Templates", "TemplateResources", level, mount);
  const manifest = {
    Version: 1,
    Ident: `${mount}${level}`,
    AdditionalFiles: {
      DestinationFilesFolder: mount,
      AdditionalFilesList: lists.map((list) => `Templates/TemplateResources/${level}/${mount}/${list}/*.*`),
    },
  };
  await put(path.join(pack, "FeaturePack", "manifest.json"), tab(manifest));
  await put(path.join(pack, "Media", `${mount}.png`), PNG);
  for (const [file, text] of Object.entries(files)) await put(path.join(pack, file), text);
}

/** A fake UE 5.8 with the Vehicle and Blank templates, their shared packs, and a template Genex ignores. */
async function fakeEngine(root: string): Promise<Engine> {
  const directory = path.join(root, "UE_5.8");
  const vehicle = path.join(directory, "Templates", "TP_VehicleAdvBP");
  await put(
    path.join(vehicle, "TP_VehicleAdvBP.uproject"),
    tab({
      FileVersion: 3,
      EngineAssociation: "",
      Category: "",
      Description: "",
      Plugins: VEHICLE_PLUGINS,
      EpicSampleNameHash: "1234",
      SomethingElse: true,
    }),
  );
  await put(path.join(vehicle, "Config", "TemplateDefs.ini"), VEHICLE_DEFS);
  await put(path.join(vehicle, "Config", "config.ini"), "[Pack]\nIgnored=1\n");
  await put(path.join(vehicle, "Config", "DefaultEngine.ini"), VEHICLE_ENGINE_INI);
  await put(path.join(vehicle, "Config", "DefaultGame.ini"), VEHICLE_GAME_INI);
  await put(
    path.join(vehicle, "Config", "DefaultInput.ini"),
    `${BOM}[Input]\r\nUpper=TP_VEHICLEADVBP lower=tp_vehicleadvbp Mixed=Tp_VehicleAdvBp\r\n`,
  );
  await put(path.join(vehicle, "Config", "TP_VehicleAdvBP_Extra.ini"), "Name=TP_VehicleAdvBP\n");
  await put(path.join(vehicle, "Content", "VehicleTemplate", "Maps", "Lvl.umap"), MAP_BYTES);
  await put(path.join(vehicle, "Content", "__ExternalActors__", "VehicleTemplate", "Maps", "X.uasset"), "actor");
  await put(path.join(vehicle, "Media", "TP_VehicleAdvBP.png"), PNG);
  await put(path.join(vehicle, "Saved", "Logs", "old.log"), "log");
  await put(path.join(vehicle, "Binaries", "Mac", "x.dylib"), "bin");
  await fakePack(
    directory,
    "Standard",
    "Vehicles",
    { "Content/SportsCar/SM_Car.uasset": "car", "Content/PhysicsMaterials/PM.uasset": "pm" },
    ["Content"],
  );
  await fakePack(
    directory,
    "High",
    "Input",
    { "Content/Actions/IA_Move.uasset": "move", "__ExternalActors__/Lvl/A/B.uasset": "external" },
    ["Content", "__ExternalActors__"],
  );

  const blank = path.join(directory, "Templates", "TP_BlankBP");
  await put(
    path.join(blank, "TP_BlankBP.uproject"),
    tab({
      FileVersion: 3,
      EngineAssociation: "",
      Category: "",
      Description: "",
      Modules: [],
      Plugins: [{ Name: "ModelingToolsEditorMode", Enabled: true, TargetAllowList: ["Editor"] }],
    }),
  );
  await put(path.join(blank, "Config", "TemplateDefs.ini"), BLANK_DEFS);
  await put(path.join(blank, "Config", "DefaultEngine.ini"), "[/Script/EngineSettings.GameMapsSettings]\n");
  await put(path.join(blank, "Config", "DefaultGame.ini"), "[/Script/EngineSettings.GeneralProjectSettings]\n");
  await put(path.join(blank, "Media", "TP_BlankBP.png"), PNG);

  // Not one of the five: Genex lists and creates only its allowlist.
  const other = path.join(directory, "Templates", "TP_VirtualRealityBP");
  await put(path.join(other, "TP_VirtualRealityBP.uproject"), tab({ FileVersion: 3 }));
  await put(path.join(other, "Config", "TemplateDefs.ini"), BLANK_DEFS);

  await put(
    path.join(directory, "Engine", "Config", "Mac", "DataDrivenPlatformInfo.ini"),
    "[DataDrivenPlatformInfo]\n",
  );
  await put(
    path.join(directory, "Engine", "Platforms", "Zebra", "Config", "DataDrivenPlatformInfo.ini"),
    "[DataDrivenPlatformInfo]\n",
  );
  return { version: "5.8", build: "5.8.3", directory, supported: true };
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
    else if (entry.isDirectory()) out[`${key}/`] = "dir";
  }
  return out;
}

const files = async (dir: string) =>
  Object.keys(await tree(dir))
    .filter((key) => !key.endsWith("/"))
    .sort();

async function fixture() {
  const root = await tmpDir("studio-unreal-create-");
  const engine = await fakeEngine(path.join(root, "Engines"));
  const parent = path.join(root, "Unreal Projects");
  await mkdir(parent, { recursive: true });
  const outside = path.join(root, "outside");
  await mkdir(outside, { recursive: true });
  return { root, engine, parent, outside };
}

/** Mac rules on any host, so the expected files below hold on Windows too. */
const create = (f: { engine: Engine; parent: string }, template: string, name: string) =>
  createProject({ engine: f.engine, template, name, parent: f.parent, platform: "darwin", newId: () => PROJECT_ID });

describe("New game templates", () => {
  it("lists only the allowlisted Blueprint templates, with Epic's English name, Genex's own line and the thumbnail", async () => {
    const f = await fixture();
    const cards = await listTemplates(f.engine);
    // Epic's description advertises a Variants drop-down and a C++ version that Genex doesn't offer.
    assert.deepEqual(cards, [
      {
        id: BlueprintTemplate.Vehicle,
        name: "Vehicle",
        description: "A sports car and an off-road buggy with gears and a speedometer.",
        thumbnail: `data:image/png;base64,${PNG.toString("base64")}`,
      },
      {
        id: BlueprintTemplate.Blank,
        name: "Blank",
        description: "An empty level to build from scratch.",
        thumbnail: `data:image/png;base64,${PNG.toString("base64")}`,
      },
    ]);
  });

  it("lists them in the panel's order: third person, first person, top down, vehicle, blank", () => {
    assert.deepEqual(Object.values(BlueprintTemplate), [
      "TP_ThirdPersonBP",
      "TP_FirstPersonBP",
      "TP_TopDownBP",
      "TP_VehicleAdvBP",
      "TP_BlankBP",
    ]);
  });

  it("skips a template folder that is a link, and shows no thumbnail that is a link", {
    skip: SEPARATE_LINKS,
  }, async () => {
    const f = await fixture();
    const templates = path.join(f.engine.directory, "Templates");
    await symlink(path.join(templates, "TP_VehicleAdvBP"), path.join(templates, "TP_TopDownBP"));
    await writeFile(path.join(f.outside, "secret.png"), PNG);
    const media = path.join(templates, "TP_BlankBP", "Media", "TP_BlankBP.png");
    await rm(media);
    await symlink(path.join(f.outside, "secret.png"), media);
    const cards = await listTemplates(f.engine);
    assert.deepEqual(
      cards.map((card) => [card.id, card.thumbnail === null]),
      [
        [BlueprintTemplate.Vehicle, false],
        [BlueprintTemplate.Blank, true],
      ],
    );
  });

  it("suggests MyGame, then MyGame2 and on, whichever is free", async () => {
    const f = await fixture();
    assert.equal(await suggestName(f.parent), "MyGame");
    await mkdir(path.join(f.parent, "MyGame"));
    await writeFile(path.join(f.parent, "MyGame2"), "a file takes the name too");
    assert.equal(await suggestName(f.parent), "MyGame3");
  });

  it("saves new games in Documents › Unreal Projects, Windows' real Documents folder included", () => {
    assert.equal(unrealProjectsFolder("darwin", "/Users/me/Documents"), "/Users/me/Documents/Unreal Projects");
    assert.equal(
      unrealProjectsFolder("win32", "C:\\Users\\me\\OneDrive\\Documents"),
      "C:\\Users\\me\\OneDrive\\Documents\\Unreal Projects",
    );
  });
});

describe("A new game from a template", () => {
  it("copies the Vehicle template the way Epic does: ignored files out, names replaced, shared packs mounted", async () => {
    const f = await fixture();
    const file = await create(f, BlueprintTemplate.Vehicle, "GxCar");
    const project = path.join(f.parent, "GxCar");
    assert.equal(file, path.join(project, "GxCar.uproject"));
    assert.deepEqual(await files(project), [
      "Config/DefaultEngine.ini",
      "Config/DefaultGame.ini",
      "Config/DefaultInput.ini",
      "Config/GxCar_Extra.ini",
      "Content/Input/Actions/IA_Move.uasset",
      "Content/VehicleTemplate/Maps/Lvl.umap",
      "Content/Vehicles/PhysicsMaterials/PM.uasset",
      "Content/Vehicles/SportsCar/SM_Car.uasset",
      "Content/__ExternalActors__/Input/Lvl/A/B.uasset",
      "Content/__ExternalActors__/VehicleTemplate/Maps/X.uasset",
      "GxCar.uproject",
    ]);
    assert.deepEqual(await readFile(path.join(project, "Content/VehicleTemplate/Maps/Lvl.umap")), MAP_BYTES);
    assert.equal(await readFile(path.join(project, "Config/GxCar_Extra.ini"), "utf8"), "Name=GxCar\n");
    assert.equal(
      await readFile(path.join(project, "Config/DefaultInput.ini"), "utf8"),
      "[Input]\r\nUpper=GXCAR lower=gxcar Mixed=GxCar\r\n",
      "BOM dropped, line endings kept, each case replaced once",
    );
  });

  it("writes the .uproject as Epic's descriptor does, with the engine's own association", async () => {
    const f = await fixture();
    const file = await create(f, BlueprintTemplate.Vehicle, "GxCar");
    assert.equal(
      await readFile(file, "utf8"),
      tab({ FileVersion: 3, EngineAssociation: "5.8", Category: "", Description: "", Plugins: VEHICLE_PLUGINS }),
    );
  });

  it("applies Epic's config values for Desktop and Maximum, the game-name redirects and a new ProjectID", async () => {
    const f = await fixture();
    await create(f, BlueprintTemplate.Vehicle, "GxCar");
    const config = path.join(f.parent, "GxCar", "Config");
    assert.equal(await readFile(path.join(config, "DefaultEngine.ini"), "utf8"), VEHICLE_ENGINE_INI_CREATED);
    assert.equal(await readFile(path.join(config, "DefaultGame.ini"), "utf8"), VEHICLE_GAME_INI_CREATED);
  });

  // UE 5.8 on a Mac hangs the GPU rendering a ray-traced level behind another app; Lumen still lights it in software.
  it("turns hardware ray tracing off in a game made on a Mac, and keeps Epic's value elsewhere", async () => {
    for (const [platform, traced] of [
      ["darwin", false],
      ["win32", true],
    ] as const) {
      const f = await fixture();
      const template = BlueprintTemplate.Vehicle;
      await createProject({
        engine: f.engine,
        template,
        name: "GxCar",
        parent: f.parent,
        platform,
        newId: () => PROJECT_ID,
      });
      const engineIni = await readFile(path.join(f.parent, "GxCar", "Config", "DefaultEngine.ini"), "utf8");
      const values = [...engineIni.matchAll(/^r\.RayTracing=(\w+)\r?$/gm)].map((m) => m[1]);
      assert.ok(values.length > 0, platform);
      assert.equal(values.includes("True"), traced, `${platform}: ${values.join(",")}`);
    }
  });

  it("writes Windows line endings in the config files it edits on Windows", async () => {
    const f = await fixture();
    await createProject({
      engine: f.engine,
      template: BlueprintTemplate.Vehicle,
      name: "GxCar",
      parent: f.parent,
      platform: "win32",
      newId: () => PROJECT_ID,
    });
    const game = await readFile(path.join(f.parent, "GxCar", "Config", "DefaultGame.ini"), "utf8");
    assert.equal(game, VEHICLE_GAME_INI_CREATED.replaceAll("\n", "\r\n"));
  });

  it("gives the Blank template Epic's blank-only settings and drops its empty module list", async () => {
    const f = await fixture();
    const file = await create(f, BlueprintTemplate.Blank, "Empty");
    const config = path.join(f.parent, "Empty", "Config");
    const engineIni = await readFile(path.join(config, "DefaultEngine.ini"), "utf8");
    for (const lines of [
      "[/Script/WorldPartitionEditor.WorldPartitionEditorSettings]\nCommandletClass=Class'/Script/UnrealEd.WorldPartitionConvertCommandlet'\n",
      "[/Script/Engine.UserInterfaceSettings]\nbAuthorizeAutomaticWidgetVariableCreation=False\nFontDPIPreset=Standard\nFontDPI=72\n",
    ])
      assert.ok(engineIni.includes(lines), lines);
    const gameIni = await readFile(path.join(config, "DefaultGame.ini"), "utf8");
    assert.ok(gameIni.includes("[/Script/CommonUI.CommonUISettings]\nCommonButtonAcceptKeyHandling=TriggerClick\n"));
    assert.equal(
      await readFile(file, "utf8"),
      tab({
        FileVersion: 3,
        EngineAssociation: "5.8",
        Category: "",
        Description: "",
        Plugins: [{ Name: "ModelingToolsEditorMode", Enabled: true, TargetAllowList: ["Editor"] }],
      }),
    );
    await create(f, BlueprintTemplate.Vehicle, "Car2");
    const vehicleIni = await readFile(path.join(f.parent, "Car2", "Config", "DefaultEngine.ini"), "utf8");
    assert.ok(!vehicleIni.includes("WorldPartitionEditorSettings"), "blank-only settings stay out of other templates");
  });

  it("creates the parent folder when it is missing", async () => {
    const f = await fixture();
    const parent = path.join(f.root, "Documents", "Unreal Projects");
    const file = await createProject({ engine: f.engine, template: BlueprintTemplate.Blank, name: "First", parent });
    assert.equal(file, path.join(parent, "First", "First.uproject"));
  });

  it("leaves nothing behind when a shared pack is missing", async () => {
    const f = await fixture();
    await rm(path.join(f.engine.directory, "Templates/TemplateResources/High/Input/FeaturePack/manifest.json"));
    await assert.rejects(create(f, BlueprintTemplate.Vehicle, "GxCar"), { code: CreateErrorCode.BadTemplate });
    assert.deepEqual(await readdir(f.parent), [], "no project and no temporary folder");
  });
});

/** Epic's third-person defs, trimmed: its packs and two of its variants, each with a pack of its own. */
const THIRD_PERSON_DEFS = [
  `${BOM}[/Script/GameProjectGeneration.TemplateProjectDefs]`,
  'LocalizedDisplayNames=(Language="en",Text="Third Person")',
  'LocalizedDescriptions=(Language="en",Text="A third person template.")',
  "FoldersToIgnore=Media",
  'FilesToIgnore="%TEMPLATENAME%.uproject"',
  'FilesToIgnore="Config/TemplateDefs.ini"',
  'SharedContentPacks=(MountName="Input",DetailLevels=("High"))',
  ';SharedContentPacks=(MountName="Variant_Combat",DetailLevels=("Standard"))',
  'Variants=(Name="Combat",LocalizedDisplayNames=((Language="en",Text="Combat"),(Language="ja",Text="戦闘")),LocalizedDescriptions=((Language="en",Text="A combat game with melee attacks and AI-controlled enemies.")),SharedContentPacks=((DetailLevels=(Standard),MountName="Variant_Combat")))',
  'Variants=(Name="Platforming",LocalizedDisplayNames=((Language="en",Text="Platforming")),SharedContentPacks=((DetailLevels=(Standard),MountName="Variant_Platforming")))',
].join("\n");

/** The third-person template and its Combat and Platforming packs, beside the fake engine's others. */
async function addThirdPerson(engine: Engine): Promise<void> {
  const template = path.join(engine.directory, "Templates", BlueprintTemplate.ThirdPerson);
  await put(path.join(template, `${BlueprintTemplate.ThirdPerson}.uproject`), tab({ FileVersion: 3 }));
  await put(path.join(template, "Config", "TemplateDefs.ini"), THIRD_PERSON_DEFS);
  await put(path.join(template, "Config", "DefaultEngine.ini"), "[/Script/EngineSettings.GameMapsSettings]\n");
  await put(path.join(template, "Content", "ThirdPerson", "Lvl_ThirdPerson.umap"), "level");
  // Its own picture, told apart from the packs' small icons.
  await put(
    path.join(template, "Media", `${BlueprintTemplate.ThirdPerson}.png`),
    Buffer.concat([PNG, Buffer.from([1])]),
  );
  const combat = { "Content/Lvl_Combat.umap": "arena", "Content/Blueprints/BP_CombatCharacter.uasset": "fighter" };
  const external = { "__ExternalActors__/Lvl_Combat/0/A.uasset": "enemy" };
  await fakePack(engine.directory, "Standard", "Variant_Combat", { ...combat, ...external }, [
    "Content",
    "__ExternalActors__",
  ]);
  await fakePack(engine.directory, "Standard", "Variant_Platforming", { "Content/Lvl_Jump.umap": "jump" }, ["Content"]);
}

describe("The Combat variant of the third-person template", () => {
  it("is offered as its own card right after Third Person, with Third Person's gameplay picture", async () => {
    const f = await fixture();
    await addThirdPerson(f.engine);
    const cards = await listTemplates(f.engine);
    assert.deepEqual(
      cards.map((card) => [card.id, card.variant ?? null, card.name]),
      [
        [BlueprintTemplate.ThirdPerson, null, "Third Person"],
        [BlueprintTemplate.ThirdPerson, TemplateVariant.Combat, "Third Person · Combat"],
        [BlueprintTemplate.Vehicle, null, "Vehicle"],
        [BlueprintTemplate.Blank, null, "Blank"],
      ],
      "Platforming is Epic's too, but not one Genex offers",
    );
    assert.match(cards[1]?.description ?? "", /melee/i);
    // The pack's own Media picture is a small icon, not a shot of the game.
    assert.ok(cards[0]?.thumbnail);
    assert.equal(cards[1]?.thumbnail, cards[0]?.thumbnail);
  });

  it("adds the variant's own pack after the template's, the way Epic's dialog does", async () => {
    const f = await fixture();
    await addThirdPerson(f.engine);
    const file = await createProject({
      engine: f.engine,
      template: BlueprintTemplate.ThirdPerson,
      variant: TemplateVariant.Combat,
      name: "Blades",
      parent: f.parent,
      platform: "darwin",
      newId: () => PROJECT_ID,
    });
    const project = path.dirname(file);
    assert.deepEqual(await files(project), [
      "Blades.uproject",
      "Config/DefaultEngine.ini",
      "Content/Input/Actions/IA_Move.uasset",
      "Content/ThirdPerson/Lvl_ThirdPerson.umap",
      "Content/Variant_Combat/Blueprints/BP_CombatCharacter.uasset",
      "Content/Variant_Combat/Lvl_Combat.umap",
      "Content/__ExternalActors__/Input/Lvl/A/B.uasset",
      "Content/__ExternalActors__/Variant_Combat/Lvl_Combat/0/A.uasset",
    ]);
    const plain = await createProject({
      engine: f.engine,
      template: BlueprintTemplate.ThirdPerson,
      name: "Plain",
      parent: f.parent,
      platform: "darwin",
    });
    const plainFiles = await files(path.dirname(plain));
    assert.ok(!plainFiles.some((name) => name.includes("Variant_")), "no variant: none of its files");
  });

  const refused: Array<{
    name: string;
    template: string;
    variant: string;
    arrange?: (engine: Engine) => Promise<void>;
  }> = [
    { name: "a variant Genex doesn't offer", template: BlueprintTemplate.ThirdPerson, variant: "Platforming" },
    { name: "a variant the template doesn't have", template: BlueprintTemplate.ThirdPerson, variant: "Nope" },
    { name: "Combat on another template", template: BlueprintTemplate.Vehicle, variant: TemplateVariant.Combat },
    { name: "a path as the variant", template: BlueprintTemplate.ThirdPerson, variant: "../Variant_Combat" },
    {
      name: "a Combat pack that is missing",
      template: BlueprintTemplate.ThirdPerson,
      variant: TemplateVariant.Combat,
      arrange: (engine) =>
        rm(
          path.join(engine.directory, "Templates/TemplateResources/Standard/Variant_Combat/FeaturePack/manifest.json"),
        ),
    },
  ];
  for (const row of refused)
    it(`refuses ${row.name}, creating nothing`, async () => {
      const f = await fixture();
      await addThirdPerson(f.engine);
      await row.arrange?.(f.engine);
      const witness = await tree(f.root);
      await assert.rejects(
        createProject({
          engine: f.engine,
          template: row.template,
          variant: row.variant,
          name: "Blades",
          parent: f.parent,
        }),
        (error: { code?: string }) =>
          error.code === CreateErrorCode.UnknownVariant || error.code === CreateErrorCode.BadTemplate,
      );
      assert.deepEqual(await tree(f.root), witness, "nothing created anywhere");
    });

  it("lists no Combat card while its pack is missing", async () => {
    const f = await fixture();
    await addThirdPerson(f.engine);
    await rm(path.join(f.engine.directory, "Templates/TemplateResources/Standard/Variant_Combat"), { recursive: true });
    const cards = await listTemplates(f.engine);
    assert.ok(!cards.some((card) => card.variant), "only cards that can be made");
  });
});

type CreateFixture = Awaited<ReturnType<typeof fixture>>;

describe("A new game's final rename on Windows", () => {
  /** A real rename that first fails with `codes`, as Windows does while OneDrive or an antivirus reads the new files. */
  const flaky = (codes: string[]) => {
    const tries: string[] = [];
    const move = async (from: string, to: string) => {
      tries.push(path.basename(to));
      const code = codes.shift();
      if (code) throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
      await rename(from, to);
    };
    return { move, tries };
  };
  const make = (
    f: CreateFixture,
    platform: NodeJS.Platform,
    files: NonNullable<Parameters<typeof createProject>[0]["files"]>,
  ) =>
    createProject({
      engine: f.engine,
      template: BlueprintTemplate.Blank,
      name: "GxBlank",
      parent: f.parent,
      platform,
      newId: () => PROJECT_ID,
      files,
    });

  it("tries again while another app holds the new files, and leaves no temporary folder", async () => {
    const f = await fixture();
    const { move, tries } = flaky(["EPERM", "EPERM"]);
    const made = await make(f, "win32", { rename: move, sleep: async () => {} });
    assert.equal(made, path.join(f.parent, "GxBlank", "GxBlank.uproject"));
    assert.equal(tries.length, 3);
    assert.deepEqual(await readdir(f.parent), ["GxBlank"]);
  });

  it("on a Mac fails at once and removes the temporary folder", async () => {
    const f = await fixture();
    const { move, tries } = flaky(["EPERM"]);
    await assert.rejects(make(f, "darwin", { rename: move, sleep: async () => {} }), { code: "EPERM" });
    assert.equal(tries.length, 1);
    assert.deepEqual(await readdir(f.parent), []);
  });

  it("says in plain words when the files stay busy, after waiting, and leaves nothing", async () => {
    const f = await fixture();
    const { move } = flaky(Array(10_000).fill("EPERM"));
    let waited = 0;
    const sleep = async (ms: number) => {
      waited += ms;
    };
    await assert.rejects(make(f, "win32", { rename: move, sleep }), (error: { code?: string; message?: string }) => {
      assert.equal(error.code, CreateErrorCode.Busy);
      assert.match(error.message ?? "", /OneDrive|antivirus/);
      return true;
    });
    assert.ok(waited > 0, "it waited before giving up");
    assert.deepEqual(await readdir(f.parent), []);
  });

  it("a cleanup that fails never hides the real error", async () => {
    const f = await fixture();
    const { move } = flaky(["ENOSPC"]);
    let removes = 0;
    const remove = async () => {
      removes++;
      throw Object.assign(new Error("EBUSY: resource busy or locked, rmdir"), { code: "EBUSY" });
    };
    await assert.rejects(make(f, "darwin", { rename: move, sleep: async () => {}, remove }), { code: "ENOSPC" });
    assert.equal(removes, 1);
  });
});

type HostileRow = {
  name: string;
  code: CreateErrorCode;
  links?: boolean;
  arrange?: (
    f: CreateFixture,
  ) => Promise<Partial<{ template: string; name: string; parent: string; platform: NodeJS.Platform; engine: Engine }>>;
  /** What the refusal's message must say. */
  says?: RegExp;
};

/** A folder under the fixture's parent whose full path is exactly `length` characters. */
async function parentOfLength(f: CreateFixture, length: number): Promise<string> {
  const parent = path.join(f.parent, "x".repeat(length - f.parent.length - 1));
  assert.equal(parent.length, length);
  await mkdir(parent);
  return parent;
}

const badName = (name: string, code: CreateErrorCode = CreateErrorCode.BadName, says?: RegExp): HostileRow => ({
  name: `the name ${JSON.stringify(name)}`,
  code,
  arrange: async () => ({ name }),
  says,
});

const hostile: HostileRow[] = [
  badName("", CreateErrorCode.BadName, /^Type a name\.$/),
  badName("1Game", CreateErrorCode.BadName, /^Start the name with a letter\.$/),
  badName("My game", CreateErrorCode.BadName, /^Use no spaces; try MyGame or My_Game\.$/),
  badName("My-game", CreateErrorCode.BadName, /^Use only letters, digits and underscores\.$/),
  badName("A".repeat(23), CreateErrorCode.BadName, /^Use 20 characters or fewer\.$/),
  badName("../Evil"),
  badName("Evil/Inner"),
  badName("Evil\\Inner"),
  badName("My Game"),
  badName("Café"),
  badName("Ｇａｍｅ"),
  badName(""),
  badName("."),
  badName("1Game"),
  badName("_Game"),
  badName("My-Game"),
  badName("%TEMPLATENAME%"),
  badName("Gx\nCar"),
  badName("Gx\u0000Car"),
  badName("A".repeat(21)),
  badName("Mac", CreateErrorCode.ReservedName),
  badName("windows", CreateErrorCode.ReservedName),
  badName("MacTargetPlatform", CreateErrorCode.ReservedName),
  badName("zebra", CreateErrorCode.ReservedName),
  badName("ZebraTargetPlatform", CreateErrorCode.ReservedName),
  badName("Con", CreateErrorCode.ReservedName),
  badName("LPT1", CreateErrorCode.ReservedName),
  {
    name: "a name whose folder exists",
    code: CreateErrorCode.NameTaken,
    arrange: async (f) => {
      await mkdir(path.join(f.parent, "GxCar"));
      await writeFile(path.join(f.parent, "GxCar", "mine.txt"), "the user's");
      return {};
    },
  },
  {
    name: "a name a file already has",
    code: CreateErrorCode.NameTaken,
    arrange: async (f) => {
      await writeFile(path.join(f.parent, "GxCar"), "the user's");
      return {};
    },
  },
  {
    name: "a name a link already has",
    code: CreateErrorCode.NameTaken,
    links: true,
    arrange: async (f) => {
      await symlink(f.outside, path.join(f.parent, "GxCar"));
      return {};
    },
  },
  {
    name: "a parent folder that is a link elsewhere",
    code: CreateErrorCode.Link,
    links: true,
    arrange: async (f) => {
      const parent = path.join(f.root, "Linked Projects");
      await symlink(f.outside, parent);
      return { parent };
    },
  },
  {
    name: "a relative parent folder",
    code: CreateErrorCode.BadParent,
    arrange: async () => ({ parent: "Unreal Projects" }),
  },
  {
    name: "a parent inside the engine",
    code: CreateErrorCode.BadParent,
    arrange: async (f) => ({ parent: path.join(f.engine.directory, "Projects") }),
  },
  {
    name: "a path too long for Windows, where even a one-letter name can't fit",
    code: CreateErrorCode.FolderTooLong,
    arrange: async (f) => {
      const parent = path.join(f.parent, "x".repeat(120));
      await mkdir(parent);
      return { parent, platform: "win32" };
    },
  },
  {
    name: "a name one character longer than fits on Windows, which says the longest that fits",
    code: CreateErrorCode.PathTooLong,
    says: /up to 10 characters/,
    // 260 − 130 kept free = 130; <parent>/<Name>/<Name> with a 108-character parent leaves 10 for the name.
    arrange: async (f) => ({ parent: await parentOfLength(f, 108), name: "A".repeat(11), platform: "win32" }),
  },
  {
    name: "a folder too long on Windows for any name, which never says to shorten the name",
    code: CreateErrorCode.FolderTooLong,
    says: /Documents/,
    arrange: async (f) => ({ parent: await parentOfLength(f, 127), name: "A", platform: "win32" }),
  },
  ...["5.9", "6.0"].map(
    (version): HostileRow => ({
      name: `an engine (${version}) whose creation steps weren't compared with Epic's`,
      code: CreateErrorCode.UnverifiedEngine,
      says: new RegExp(`Unreal ${version.replace(".", "\\.")}`),
      arrange: async (f) => ({ engine: { ...f.engine, version, build: `${version}.0` } }),
    }),
  ),
  ...["TP_VirtualRealityBP", "TP_ThirdPerson", "../TP_BlankBP", "TP_BlankBP/..", "", "tp_blankbp"].map(
    (template): HostileRow => ({
      name: `the template ${JSON.stringify(template)}`,
      code: CreateErrorCode.UnknownTemplate,
      arrange: async () => ({ template }),
    }),
  ),
  {
    name: "a template folder that is a link",
    code: CreateErrorCode.Link,
    links: true,
    arrange: async (f) => {
      await symlink(
        path.join(f.engine.directory, "Templates", "TP_BlankBP"),
        path.join(f.engine.directory, "Templates", "TP_TopDownBP"),
      );
      return { template: BlueprintTemplate.TopDown };
    },
  },
  {
    name: "a link inside the template",
    code: CreateErrorCode.Link,
    links: true,
    arrange: async (f) => {
      await writeFile(path.join(f.outside, "secret.ini"), "secret=1\n");
      await symlink(
        path.join(f.outside, "secret.ini"),
        path.join(f.engine.directory, "Templates", "TP_VehicleAdvBP", "Config", "Linked.ini"),
      );
      return {};
    },
  },
  {
    name: "a shared pack's content folder that is a link",
    code: CreateErrorCode.Link,
    links: true,
    arrange: async (f) => {
      const content = path.join(f.engine.directory, "Templates/TemplateResources/Standard/Vehicles/Content");
      await rename(content, path.join(f.outside, "VehiclesContent"));
      await symlink(path.join(f.outside, "VehiclesContent"), content);
      return {};
    },
  },
  {
    name: "a template that brings C++ source",
    code: CreateErrorCode.BadTemplate,
    arrange: async (f) => {
      await put(path.join(f.engine.directory, "Templates", "TP_VehicleAdvBP", "Source", "Game.cpp"), "int x;");
      return {};
    },
  },
  {
    name: "a template that names its own defs class",
    code: CreateErrorCode.BadTemplate,
    arrange: async (f) => {
      const defs = path.join(f.engine.directory, "Templates", "TP_BlankBP", "Config", "TemplateDefs.ini");
      await writeFile(defs, `${BLANK_DEFS}TemplateProjectDefsClass=/Script/Custom.Defs\n`);
      return { template: BlueprintTemplate.Blank };
    },
  },
];

describe("A new game is refused, creating nothing,", () => {
  for (const row of hostile)
    it(`for ${row.name}`, { skip: row.links ? SEPARATE_LINKS : false }, async () => {
      const f = await fixture();
      const input = {
        template: BlueprintTemplate.Vehicle as string,
        name: "GxCar",
        parent: f.parent,
        ...(await row.arrange?.(f)),
      };
      const witness = [await tree(f.root)];
      await assert.rejects(
        createProject({ engine: f.engine, newId: () => PROJECT_ID, ...input }),
        (error: { code?: string; message?: string }) =>
          error.code === row.code && (row.says === undefined || row.says.test(error.message ?? "")),
      );
      assert.deepEqual([await tree(f.root)], witness, "nothing created, moved or changed anywhere");
    });
});

/** A launcher for tests that never open, quit or get Unreal: any launch fails the test. */
const noLaunch = (root: string): LaunchEnv => ({
  open: async (launch) => {
    throw new Error(`unexpected launch of ${launch.command}`);
  },
  applications: path.join(root, "Applications"),
  now: () => Date.now(),
});

describe("The Unreal plugin's create action", () => {
  async function backendFixture(overrides: Partial<SetupEnv> = {}) {
    const f = await fixture();
    const home = path.join(f.root, "home");
    const storage = path.join(f.root, "storage");
    const dat = path.join(home, "Library/Application Support/Epic/UnrealEngineLauncher/LauncherInstalled.dat");
    await put(
      dat,
      JSON.stringify({
        InstallationList: [
          {
            InstallLocation: f.engine.directory,
            AppVersion: "5.8.3-58210709+++UE5+Release-5.8-Mac",
            AppName: "UE_5.8",
          },
        ],
      }),
    );
    const env: SetupEnv = {
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
    const backend = createUnrealBackend({
      env,
      helper: HELPER,
      projects: async () => f.parent,
      launch: noLaunch(f.root),
    });
    const context = {
      signal: new AbortController().signal,
      callId: 1,
      host: (async (method: string) => {
        if (method === "storage.root") return storage;
        throw new Error(`unexpected host call ${method}`);
      }) as never,
    };
    return { ...f, env, storage, backend, context };
  }

  it("creates the game and sets it up at once, even while Unreal has another project open", async () => {
    const b = await backendFixture({ editorRunning: async () => true });
    const made = (await b.backend.action?.(
      "create",
      { template: BlueprintTemplate.Vehicle, name: "GxCar" },
      b.context,
    )) as {
      project: string;
      state: { ready: boolean; helper: string; port: number };
    };
    assert.equal(made.project, path.join(b.parent, "GxCar", "GxCar.uproject"));
    assert.deepEqual([made.state.ready, made.state.helper], [true, HelperState.Current]);
    assert.deepEqual(
      (await listSetUpProjects(b.storage)).map((p) => [p.name, p.port]),
      [["GxCar", made.state.port]],
      "recorded like any setup, and chosen in the panel",
    );
  });

  it("the Create action's answer crosses the plugin process's wire, as advanced serialization sends it", async () => {
    const b = await backendFixture();
    const made = await b.backend.action?.("create", { template: BlueprintTemplate.Blank, name: "GxBlank" }, b.context);
    assert.ok(made, "the action answers");
    assert.doesNotThrow(() => serialize(made), "nothing in the answer is a function");
  });

  /** A host that makes Genex games under `games/` when asked, and records every call. */
  function gameMakingHost(b: Awaited<ReturnType<typeof backendFixture>>) {
    const calls: Array<[string, unknown]> = [];
    const host = (async (method: string, args?: unknown) => {
      if (method === "storage.root") return b.storage;
      calls.push([method, args]);
      if (method === "game.create") {
        const directory = path.join(b.root, "games", "blades");
        await mkdir(directory, { recursive: true });
        return { project: "blades", directory };
      }
      if (method === "game.engine.link") return { kind: "unreal", ...(args as object) };
      throw new Error(`unexpected host call ${method}`);
    }) as never;
    return { calls, context: { ...b.context, host } };
  }

  it("with no game open, a new Unreal project gets a new Genex game around it, in its unreal folder", async () => {
    const b = await backendFixture();
    const { calls, context } = gameMakingHost(b);
    const made = (await b.backend.action?.(
      "create",
      { template: BlueprintTemplate.Blank, name: "Blades" },
      context,
    )) as {
      project: string;
      game: { project: string } | null;
    };
    const project = await realpath(path.join(b.root, "games", "blades", "unreal", "Blades.uproject"));
    assert.equal(await realpath(made.project), project);
    assert.equal(made.game?.project, "blades");
    assert.deepEqual(calls, [
      ["game.create", { title: "Blades" }],
      ["game.engine.link", { project, game: "blades" }],
    ]);
    assert.deepEqual(await readdir(b.parent), [], "nothing in Documents › Unreal Projects");
    const ignored = (await readFile(path.join(b.root, "games", "blades", ".gitignore"), "utf8")).split("\n");
    assert.ok(ignored.includes("unreal/Saved/"), "Unreal's scratch stays out of the game's snapshots");
  });

  it("with no game open, a refused name makes no Genex game either", async () => {
    const b = await backendFixture();
    const { calls, context } = gameMakingHost(b);
    await assert.rejects(
      b.backend.action?.("create", { template: BlueprintTemplate.Blank, name: "../Evil" }, context) ??
        Promise.reject(new Error("no actions")),
      { code: CreateErrorCode.BadName },
    );
    assert.deepEqual(calls, [], "the host was never asked to make a game");
  });

  it("the New game form says a project made with no game open gets a game of its own", async () => {
    const b = await backendFixture();
    const offer = (await b.backend.action?.("templates", {}, b.context)) as { newGame: boolean };
    assert.equal(offer.newGame, true);
  });

  it("a new game made while a Genex game is open becomes that game's project", async () => {
    const b = await backendFixture();
    const linked: unknown[] = [];
    const context = {
      ...b.context,
      project: "valley",
      host: (async (method: string, args?: unknown) => {
        if (method === "storage.root") return b.storage;
        if (method === "game.engine.link") return linked.push(args);
        throw new Error(`unexpected host call ${method}`);
      }) as never,
    };
    const made = (await b.backend.action?.(
      "create",
      { template: BlueprintTemplate.Vehicle, name: "GxCar" },
      context,
    )) as { project: string };
    assert.deepEqual(linked, [{ project: await realpath(made.project) }]);
  });

  /** A Genex game's folder open in the chat, with its own ignore file, and the host calls it saw. */
  async function openGame(b: Awaited<ReturnType<typeof backendFixture>>) {
    const dir = path.join(b.root, "games", "valley");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ".gitignore"), ".studio/\nnode_modules\n");
    const linked: unknown[] = [];
    const context = {
      ...b.context,
      project: "valley",
      directory: dir,
      host: (async (method: string, args?: unknown) => {
        if (method === "storage.root") return b.storage;
        if (method === "game.engine.link") return linked.push(args);
        throw new Error(`unexpected host call ${method}`);
      }) as never,
    };
    return { dir, linked, context };
  }

  it("a new game made from an open Genex game goes in its folder as unreal/, with Unreal's scratch ignored", async () => {
    const b = await backendFixture();
    const game = await openGame(b);
    const made = (await b.backend.action?.(
      "create",
      { template: BlueprintTemplate.Vehicle, name: "GxCar" },
      game.context,
    )) as { project: string; state: { ready: boolean } };
    assert.equal(made.project, path.join(game.dir, "unreal", "GxCar.uproject"));
    assert.equal(made.state.ready, true);
    assert.deepEqual(game.linked, [{ project: await realpath(made.project) }]);
    assert.deepEqual(await readdir(b.parent), [], "nothing in Documents › Unreal Projects");
    const ignored = (await readFile(path.join(game.dir, ".gitignore"), "utf8")).split("\n");
    for (const line of [
      ".studio/",
      "node_modules",
      "unreal/Saved/",
      "unreal/Intermediate/",
      "unreal/DerivedDataCache/",
    ])
      assert.ok(ignored.includes(line), `${line} is ignored`);
    for (const line of [
      "unreal/Binaries/",
      "unreal/Plugins/*/Intermediate/",
      "unreal/Plugins/*/Binaries/",
      "__pycache__/",
    ])
      assert.ok(ignored.includes(line), `${line} is ignored`);
  });

  it("the New game form offers the open game's folder", async () => {
    const b = await backendFixture();
    const game = await openGame(b);
    const offer = (await b.backend.action?.("templates", {}, game.context)) as { folder: string };
    assert.equal(offer.folder, path.join(game.dir, "unreal"));
  });

  it("refuses a game that already has an unreal folder, or whose ignore file is a link, and changes nothing", async () => {
    const cases: Array<[string, (dir: string, outside: string) => Promise<void>]> = [
      ["an unreal folder", (dir) => mkdir(path.join(dir, "unreal"))],
      ["an unreal file", (dir) => writeFile(path.join(dir, "unreal"), "x")],
      ["an unreal link out of the game", (dir, outside) => symlink(outside, path.join(dir, "unreal"))],
      [
        "an ignore file that is a link out of the game",
        async (dir, outside) => {
          await writeFile(path.join(outside, "ignore"), "mine\n");
          await rm(path.join(dir, ".gitignore"));
          await symlink(path.join(outside, "ignore"), path.join(dir, ".gitignore"));
        },
      ],
    ];
    for (const [label, arrange] of cases) {
      const b = await backendFixture();
      const game = await openGame(b);
      await arrange(game.dir, b.outside);
      const before = { game: await tree(game.dir), outside: await tree(b.outside) };
      await assert.rejects(
        b.backend.action?.("create", { template: BlueprintTemplate.Vehicle, name: "GxCar" }, game.context) ??
          Promise.reject(),
        Error,
        label,
      );
      assert.deepEqual({ game: await tree(game.dir), outside: await tree(b.outside) }, before, label);
      assert.deepEqual(await readdir(b.parent), [], label);
      assert.deepEqual(game.linked, [], label);
    }
  });

  it("undo setup takes a new game back to exactly what Epic's steps made", async () => {
    const b = await backendFixture();
    const made = (await b.backend.action?.(
      "create",
      { template: BlueprintTemplate.Vehicle, name: "GxCar" },
      b.context,
    )) as {
      project: string;
    };
    const uproject = JSON.parse(await readFile(made.project, "utf8"));
    assert.ok(uproject.Plugins.some((p: { Name: string }) => p.Name === "ModelContextProtocol"));
    await b.backend.action?.("undo-setup", { project: made.project }, b.context);
    assert.equal(
      await readFile(made.project, "utf8"),
      tab({ FileVersion: 3, EngineAssociation: "5.8", Category: "", Description: "", Plugins: VEHICLE_PLUGINS }),
    );
    const state = await inspectProject(made.project, { env: b.env, helper: HELPER, storage: b.storage });
    assert.deepEqual(
      [state.plugins, state.autoStart, state.helper, state.undoable],
      [false, false, HelperState.Missing, false],
    );
  });

  it("refuses a template outside the allowlist and creates nothing", async () => {
    const b = await backendFixture();
    await assert.rejects(
      b.backend.action?.("create", { template: "TP_VirtualRealityBP", name: "GxCar" }, b.context) ?? Promise.reject(),
      { code: CreateErrorCode.UnknownTemplate },
    );
    assert.deepEqual(await readdir(b.parent), []);
    assert.deepEqual(await tree(b.storage), {});
  });

  it("lists the template cards and the suggested name for the New game form", async () => {
    const b = await backendFixture();
    await mkdir(path.join(b.parent, "MyGame"));
    const offer = (await b.backend.action?.("templates", {}, b.context)) as {
      templates: Array<{ id: string }>;
      name: string;
      folder: string;
    };
    assert.deepEqual(
      offer.templates.map((t) => t.id),
      [BlueprintTemplate.Vehicle, BlueprintTemplate.Blank],
    );
    assert.equal(offer.name, "MyGame2");
    assert.equal(offer.folder, b.parent);
  });

  /** Epic's launcher list naming these engines, each `[version, build, folder]`. */
  async function installed(b: Awaited<ReturnType<typeof backendFixture>>, engines: Array<[string, string, string]>) {
    const dat = path.join(b.env.home, "Library/Application Support/Epic/UnrealEngineLauncher/LauncherInstalled.dat");
    for (const [, , folder] of engines) await mkdir(folder, { recursive: true });
    const list = engines.map(([version, build, folder]) => ({
      InstallLocation: folder,
      AppVersion: `${build}-1+++UE5+Release-${version}-Mac`,
      AppName: `UE_${version}`,
    }));
    await writeFile(dat, JSON.stringify({ InstallationList: list }));
  }

  it("makes a new game with Unreal 5.8 even when a newer, unverified engine is installed beside it", async () => {
    const b = await backendFixture();
    await installed(b, [
      ["5.8", "5.8.3", b.engine.directory],
      ["5.9", "5.9.0", path.join(b.root, "Engines", "UE_5.9")],
    ]);
    const offer = (await b.backend.action?.("templates", {}, b.context)) as { templates: Array<{ id: string }> };
    assert.deepEqual(
      offer.templates.map((t) => t.id),
      [BlueprintTemplate.Vehicle, BlueprintTemplate.Blank],
    );
    const made = (await b.backend.action?.(
      "create",
      { template: BlueprintTemplate.Blank, name: "GxBlank" },
      b.context,
    )) as {
      project: string;
    };
    assert.equal(JSON.parse(await readFile(made.project, "utf8")).EngineAssociation, "5.8");
  });

  it("with only a newer, unverified engine, creates nothing and says which version it is", async () => {
    const b = await backendFixture();
    await installed(b, [["5.9", "5.9.0", path.join(b.root, "Engines", "UE_5.9")]]);
    await assert.rejects(
      b.backend.action?.("create", { template: BlueprintTemplate.Blank, name: "GxBlank" }, b.context) ??
        Promise.reject(),
      { code: CreateErrorCode.UnverifiedEngine },
    );
    assert.deepEqual(await readdir(b.parent), []);
    assert.deepEqual(await tree(b.storage), {});
    const offer = (await b.backend.action?.("templates", {}, b.context)) as {
      templates: unknown[];
      newestUnverified: string | null;
    };
    assert.deepEqual([offer.templates, offer.newestUnverified], [[], "5.9"]);
  });

  it("suggests a name that fits a long Windows folder", async () => {
    const f = await fixture();
    const parent = await parentOfLength(f, 117);
    const name = await suggestName(parent, "win32");
    const made = await createProject({
      engine: f.engine,
      template: BlueprintTemplate.Blank,
      name,
      parent,
      platform: "win32",
      newId: () => PROJECT_ID,
    });
    assert.equal(made, path.join(parent, name, `${name}.uproject`));
  });

  it("declares create and templates as actions the host runs without a confirmation", async () => {
    const manifest = validateManifest(JSON.parse(await readFile("src/plugins/unreal/plugin.json", "utf8")));
    const declared = (name: string) => manifest.actions.find((a) => a.name === name);
    for (const name of ["create", "templates"]) {
      assert.ok(declared(name), `${name} is declared`);
      assert.equal(declared(name)?.confirmation, undefined, `${name} asks nothing: no existing file changes`);
    }
  });
});

describe("The Windows Documents folder", () => {
  type Call = { file: string; args: readonly string[]; options: { windowsHide?: boolean } };
  const WINDOWS = { home: "C:\\Users\\ann", platform: "win32" as const };
  const FALLBACK = "C:\\Users\\ann\\Documents";
  /** How PowerShell's answer travels: UTF-16LE in base64, plain ASCII whatever the console's code page. */
  const encoded = (folder: string) => Buffer.from(folder, "utf16le").toString("base64");
  const ask = (answer: () => Promise<{ stdout: string }>) => {
    const calls: Call[] = [];
    const run = async (file: string, args: readonly string[], options: { windowsHide?: boolean }) => {
      calls.push({ file, args, options });
      return answer();
    };
    return { calls, query: { run, env: { SystemRoot: "C:\\Windows" }, isFolder: async () => true } };
  };

  for (const folder of ["C:\\Users\\Jürgen\\Documents", "C:\\Users\\ann\\OneDrive - Universität Wien\\Documents"])
    it(`comes back exactly, by PowerShell's full path with no window: ${folder}`, async () => {
      const { calls, query } = ask(async () => ({ stdout: `${encoded(folder)}\r\n` }));
      assert.equal(await documentsFolder(WINDOWS, query), folder);
      assert.equal(calls[0]?.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      assert.deepEqual(calls[0]?.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
      assert.equal(calls[0]?.options.windowsHide, true);
    });

  const unusable: Array<[string, () => Promise<{ stdout: string }>]> = [
    ["raw code-page bytes read as text", async () => ({ stdout: "C:\\Users\\J\x81rgen\\Documents\r\n" })],
    ["a replacement character", async () => ({ stdout: encoded("C:\\Users\\J\uFFFDrgen\\Documents") })],
    ["a question mark", async () => ({ stdout: encoded("C:\\Users\\J?rgen\\Documents") })],
    ["a path that isn't absolute", async () => ({ stdout: encoded("Documents") })],
    ["an empty answer", async () => ({ stdout: "" })],
    [
      "a PowerShell that times out",
      async () => {
        throw Object.assign(new Error("timed out"), { killed: true });
      },
    ],
  ];
  for (const [name, answer] of unusable)
    it(`falls back to home\\Documents for ${name}`, async () => {
      const { query } = ask(answer);
      assert.equal(await documentsFolder(WINDOWS, query), FALLBACK);
    });

  it("is asked once per backend after a clean answer, and again after a failed one", async () => {
    let asks = 0;
    let fail = true;
    const documents = {
      run: async () => {
        asks++;
        if (fail) throw Object.assign(new Error("timed out"), { killed: true });
        return { stdout: encoded("D:\\Docs") };
      },
      env: { SystemRoot: "C:\\Windows" },
      isFolder: async () => true,
    };
    const root = await tmpDir("studio-unreal-documents-");
    const env: SetupEnv = {
      home: "C:\\Users\\ann",
      platform: "win32",
      programData: path.join(root, "ProgramData"),
      editorRunning: async () => false,
      portListening: async () => false,
      editorAnswers: async () => false,
      xcode: async () => ({ ...READY_XCODE, state: XcodeState.NotApplicable, app: null, version: null }),
      freeBytes: async () => 200 * GIB,
      totalMemory: () => 32 * GIB,
    };
    const backend = createUnrealBackend({ env, helper: HELPER, documents, launch: noLaunch(root) });
    const context = {
      signal: new AbortController().signal,
      callId: 1,
      host: (async () => path.join(root, "storage")) as never,
    };
    const offer = async () => (await backend.action?.("templates", {}, context)) as { folder: string };
    assert.equal((await offer()).folder, "C:\\Users\\ann\\Documents\\Unreal Projects", "a failed answer falls back");
    fail = false;
    assert.equal((await offer()).folder, "D:\\Docs\\Unreal Projects", "and is asked again");
    await offer();
    await backend.action?.("status", {}, context);
    assert.equal(asks, 2, "a clean answer is kept for the backend's life");
  });

  it("falls back when the answer is not a folder that exists", async () => {
    const { query } = ask(async () => ({ stdout: encoded("C:\\Users\\ann\\Gone") }));
    assert.equal(await documentsFolder(WINDOWS, { ...query, isFolder: async () => false }), FALLBACK);
  });
});

type Launched = { command: string; args: readonly string[] };
/**
 * A Genex game open in the chat (`valley`, with its own ignore file), a fake Unreal 5.8 whose editor
 * app is there, and every launch the tool asked for, recorded instead of run.
 */
async function newGameFixture(options: { game?: boolean; open?: LaunchEnv["open"]; xcode?: XcodeStatus } = {}) {
  const f = await fixture();
  const home = path.join(f.root, "home");
  const storage = path.join(f.root, "storage");
  const dat = path.join(home, "Library/Application Support/Epic/UnrealEngineLauncher/LauncherInstalled.dat");
  await put(
    dat,
    JSON.stringify({
      InstallationList: [
        {
          InstallLocation: f.engine.directory,
          AppVersion: "5.8.3-58210709+++UE5+Release-5.8-Mac",
          AppName: "UE_5.8",
        },
      ],
    }),
  );
  await mkdir(path.join(f.engine.directory, "Engine", "Binaries", "Mac", "UnrealEditor.app"), { recursive: true });
  const env: SetupEnv = {
    home,
    platform: "darwin",
    programData: path.join(home, "ProgramData"),
    editorRunning: async () => false,
    portListening: async () => false,
    editorAnswers: async () => false,
    xcode: async () => options.xcode ?? READY_XCODE,
    freeBytes: async () => 200 * GIB,
    totalMemory: () => 32 * GIB,
  };
  const launches: Launched[] = [];
  const launch: LaunchEnv = {
    open: options.open ?? (async (l) => void launches.push({ command: l.command, args: l.args })),
    applications: path.join(f.root, "Applications"),
    now: () => 1_000,
  };
  const backend = createUnrealBackend({ env, helper: HELPER, projects: async () => f.parent, launch });
  const dir = path.join(f.root, "games", "valley");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ".gitignore"), ".studio/\nnode_modules\n");
  const linked: unknown[] = [];
  const shown = { steps: 0 };
  const context = {
    signal: new AbortController().signal,
    callId: 1,
    ...(options.game === false ? {} : { project: "valley", directory: dir }),
    host: (async (method: string, args?: unknown) => {
      if (method === "storage.root") return storage;
      if (method === "game.engine.link") return linked.push(args);
      if (method === "game.engine.steps") return Boolean(++shown.steps);
      throw new Error(`unexpected host call ${method}`);
    }) as never,
  };
  const newGame = (args: Record<string, unknown>) =>
    // A hostile call sends any JSON, whatever the SDK's scalar type says.
    backend.tool?.("new-game", args as never, context) ?? Promise.reject(new Error("no tools"));
  return {
    ...f,
    storage,
    dir,
    linked,
    launches,
    newGame,
    get stepsShown() {
      return shown.steps;
    },
  };
}

type Refusal = {
  name: string;
  args?: Record<string, unknown>;
  links?: boolean;
  game?: boolean;
  arrange?: (dir: string, outside: string) => Promise<void>;
};
const GOOD = { template: BlueprintTemplate.Vehicle, name: "GxCar" };
const refusals: Refusal[] = [
  ...["../Evil", "..", "Evil/Inner", "Evil\\Inner", "/tmp/Evil", "C:\\Evil", "My Game", " ", "", "A".repeat(21)].map(
    (name): Refusal => ({ name: `the name ${JSON.stringify(name)}`, args: { ...GOOD, name } }),
  ),
  { name: "a name with a NUL", args: { ...GOOD, name: "Gx\u0000Car" } },
  { name: "a name that isn't text", args: { ...GOOD, name: 42 } },
  { name: "no name", args: { template: GOOD.template } },
  ...["../TP_BlankBP", "TP_BlankBP/..", "/etc/passwd", "TP_VirtualRealityBP", "tp_blankbp", ""].map(
    (template): Refusal => ({ name: `the template ${JSON.stringify(template)}`, args: { ...GOOD, template } }),
  ),
  { name: "a template that isn't text", args: { ...GOOD, template: { id: GOOD.template } } },
  { name: "a game that already has an unreal folder", arrange: (dir) => mkdir(path.join(dir, "unreal")) },
  { name: "a game with an unreal file", arrange: (dir) => writeFile(path.join(dir, "unreal"), "mine") },
  {
    name: "a game whose unreal is a link out of it",
    links: true,
    arrange: (dir, outside) => symlink(outside, path.join(dir, "unreal")),
  },
  {
    name: "a game whose ignore file is a link out of it",
    links: true,
    arrange: async (dir, outside) => {
      await writeFile(path.join(outside, "ignore"), "mine\n");
      await rm(path.join(dir, ".gitignore"));
      await symlink(path.join(outside, "ignore"), path.join(dir, ".gitignore"));
    },
  },
  { name: "no game open in Genex", game: false },
];

describe("The Unreal plugin's new-game tool", () => {
  it("makes the game's Unreal project in its folder as unreal/, set up and linked, and opens it in Unreal", async () => {
    const g = await newGameFixture();
    const answer = await g.newGame({ template: BlueprintTemplate.Vehicle, name: "GxCar" });
    const project = await realpath(path.join(g.dir, "unreal", "GxCar.uproject"));
    assert.equal(typeof answer, "string");
    assert.ok(String(answer).includes(project), "the answer names the project it made");
    assert.deepEqual(g.linked, [{ project }], "the game builds in it from now on");
    assert.deepEqual(
      (await listSetUpProjects(g.storage)).map((p) => p.project),
      [project],
      "set up like any project",
    );
    assert.equal(g.launches.length, 1, "Unreal is asked to open it once");
    assert.ok(g.launches[0]?.args.includes(project), "the launch opens this project");
    assert.deepEqual(await readdir(g.parent), [], "nothing in Documents › Unreal Projects");
    const ignored = (await readFile(path.join(g.dir, ".gitignore"), "utf8")).split("\n");
    for (const line of [".studio/", "unreal/Saved/", "unreal/Intermediate/"]) assert.ok(ignored.includes(line), line);
  });

  it("makes the third-person Combat variant when the agent asks for it", async () => {
    const g = await newGameFixture();
    await addThirdPerson(g.engine);
    await g.newGame({ template: BlueprintTemplate.ThirdPerson, variant: TemplateVariant.Combat, name: "Blades" });
    const arena = path.join(g.dir, "unreal", "Content", "Variant_Combat", "Lvl_Combat.umap");
    assert.equal(await readFile(arena, "utf8"), "arena");
  });

  it("offers the Unreal setup card in the chat while a step is open, and not once every step is done", async () => {
    const missing = await newGameFixture({ xcode: NO_XCODE });
    await missing.newGame(GOOD);
    assert.equal(missing.stepsShown, 1, "Xcode is missing: the card shows once");
    const ready = await newGameFixture();
    await ready.newGame(GOOD);
    assert.equal(ready.stepsShown, 0);
  });

  it("keeps the game made and linked when Unreal won't open, and says so instead of failing", async () => {
    const g = await newGameFixture({
      open: async () => {
        throw new Error("Unreal could not start");
      },
    });
    const answer = await g.newGame({ template: BlueprintTemplate.Blank, name: "Plain" });
    const project = await realpath(path.join(g.dir, "unreal", "Plain.uproject"));
    assert.deepEqual(g.linked, [{ project }]);
    assert.ok(String(answer).includes("Unreal could not start"), "the reason it didn't open is passed on");
  });

  it("is an agent tool the seed names exactly, with its template and name required", async () => {
    const manifest = validateManifest(JSON.parse(await readFile("src/plugins/unreal/plugin.json", "utf8")));
    const tool = manifest.tools.find((t) => `${manifest.id}__${t.name}` === UNREAL_NEW_GAME_TOOL);
    assert.ok(tool, `${UNREAL_NEW_GAME_TOOL} is declared`);
    assert.deepEqual([...(tool.parameters.required ?? [])].sort(), ["name", "template"]);
    assert.equal(tool.confirmation, undefined, "no card: nothing that exists changes, as the panel's New game");
  });

  describe("is refused, changing nothing anywhere,", () => {
    for (const row of refusals)
      it(`for ${row.name}`, { skip: row.links ? SEPARATE_LINKS : false }, async () => {
        const g = await newGameFixture({ game: row.game });
        await row.arrange?.(g.dir, g.outside);
        const witness = async () => ({
          game: await tree(g.dir),
          documents: await tree(g.parent),
          storage: await tree(g.storage),
          outside: await tree(g.outside),
        });
        const before = await witness();
        await assert.rejects(g.newGame(row.args ?? GOOD), Error);
        assert.deepEqual(await witness(), before, "nothing made, written or moved");
        assert.deepEqual(g.linked, [], "the game keeps its engine");
        assert.deepEqual(g.launches, [], "Unreal is not opened");
      });
  });
});

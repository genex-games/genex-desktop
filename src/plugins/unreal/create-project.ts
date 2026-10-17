/**
 * New game from a template: Genex makes an Unreal project from one of five Blueprint templates
 * exactly as Unreal's New Project dialog does (GameProjectUtils::CreateProjectFromTemplate in UE
 * 5.8.3, followed step by step). Epic's dialog defaults apply: Desktop, Maximum quality, and no
 * variant unless the third-person template's Combat variant is chosen, whose shared pack is added
 * after the template's as the dialog's AddSharedContentToProject does. One step is Genex's own: on a
 * Mac the game is made without hardware ray tracing ({@link MAC_VALUES}).
 * The project is built in a temporary sibling (its dot prefix hides it on a Mac, not on Windows)
 * and renamed into place only when complete, so a failure leaves nothing half made. Nothing here follows a link: a template, a shared pack or
 * a parent folder that is one is refused.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as FS } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";
import { isInside } from "../../substrate/paths.ts";
import { isJsonObject, type RenameFolderOptions, readRegularFile, renameFolder } from "../../substrate/fsx.ts";
import {
  type ConfigValue,
  loadEpicText,
  projectDescriptorText,
  replaceAllText,
  replaceInText,
  saveEpicText,
  setConfigValue,
} from "./epic-files.ts";
import { type Engine, installEngineText, type Runner, type SetupEnv, windowsSystemTool } from "./setup.ts";
import { UPROJECT_EXTENSION } from "./project-file.ts";
import {
  fixupStrings,
  type PackLevelSet,
  parseTemplateDefs,
  type TemplateDefs,
  type TemplateVariantDefs,
} from "./template-defs.ts";

/** The templates Genex offers, in the panel's order; any other template is ignored. */
export const BlueprintTemplate = {
  ThirdPerson: "TP_ThirdPersonBP",
  FirstPerson: "TP_FirstPersonBP",
  TopDown: "TP_TopDownBP",
  Vehicle: "TP_VehicleAdvBP",
  Blank: "TP_BlankBP",
} as const;
export type BlueprintTemplate = (typeof BlueprintTemplate)[keyof typeof BlueprintTemplate];

/**
 * The template variants Genex offers, by Epic's names (FTemplateVariant::Name): each is a card of
 * its own after its template. Wire values: never rename.
 */
export const TemplateVariant = { Combat: "Combat" } as const;
export type TemplateVariant = (typeof TemplateVariant)[keyof typeof TemplateVariant];

/** Which variants each template offers; any other variant Epic ships is ignored. */
const OFFERED_VARIANTS: Readonly<Record<BlueprintTemplate, readonly TemplateVariant[]>> = {
  [BlueprintTemplate.ThirdPerson]: [TemplateVariant.Combat],
  [BlueprintTemplate.FirstPerson]: [],
  [BlueprintTemplate.TopDown]: [],
  [BlueprintTemplate.Vehicle]: [],
  [BlueprintTemplate.Blank]: [],
};

/** Genex's own line for each variant card. */
const VARIANT_LINE = {
  [TemplateVariant.Combat]: "Over-the-shoulder melee: combo attacks and enemies that fight back.",
} as const satisfies Record<TemplateVariant, string>;

/** How a variant card is named: its template's name, then the variant's, as Epic's dialog shows both. */
const variantName = (template: string, variant: string) => `${template} · ${variant}`;

/**
 * Genex's own line for each template card. Epic's descriptions advertise a Variants drop-down and a
 * C++ version, and Genex offers neither (the default variant, Blueprint only).
 */
const TEMPLATE_LINE = {
  [BlueprintTemplate.ThirdPerson]: "Over-the-shoulder camera; walk, run and jump.",
  [BlueprintTemplate.FirstPerson]: "Look and move from the player's eyes.",
  [BlueprintTemplate.TopDown]: "Camera high above; click where to go.",
  [BlueprintTemplate.Vehicle]: "A sports car and an off-road buggy with gears and a speedometer.",
  [BlueprintTemplate.Blank]: "An empty level to build from scratch.",
} as const satisfies Record<BlueprintTemplate, string>;

/** Why a new game was refused; the message says it in words the panel shows as they are. */
export const CreateErrorCode = {
  BadName: "bad-name",
  ReservedName: "reserved-name",
  NameTaken: "name-taken",
  UnknownTemplate: "unknown-template",
  BadTemplate: "bad-template",
  Link: "link",
  BadParent: "bad-parent",
  PathTooLong: "path-too-long",
  FolderTooLong: "folder-too-long",
  Busy: "busy",
  NoEngine: "no-engine",
  UnverifiedEngine: "unverified-engine",
  UnknownVariant: "unknown-variant",
} as const;
export type CreateErrorCode = (typeof CreateErrorCode)[keyof typeof CreateErrorCode];

/** The longest name Genex accepts for a new game. */
const PROJECT_NAME_MAX = 20;

/** The first rule a refused name breaks, in the order they are checked; each has its own words. */
const NameProblem = {
  Empty: "empty",
  FirstNotLetter: "first-not-letter",
  Space: "space",
  OtherCharacter: "other-character",
  TooLong: "too-long",
} as const;
type NameProblem = (typeof NameProblem)[keyof typeof NameProblem];

const MESSAGE = {
  [CreateErrorCode.BadName]: {
    [NameProblem.Empty]: "Type a name.",
    [NameProblem.FirstNotLetter]: "Start the name with a letter.",
    [NameProblem.Space]: "Use no spaces; try MyGame or My_Game.",
    [NameProblem.OtherCharacter]: "Use only letters, digits and underscores.",
    [NameProblem.TooLong]: `Use ${PROJECT_NAME_MAX} characters or fewer.`,
  } satisfies Record<NameProblem, string>,
  [CreateErrorCode.ReservedName]: (name: string) =>
    `${name} is a name Unreal or Windows keeps for itself. Choose another name.`,
  [CreateErrorCode.NameTaken]: (name: string, place: string) =>
    `There's already something called ${name} in ${place}. Choose another name.`,
  [CreateErrorCode.UnknownTemplate]: "Choose one of the templates Genex shows.",
  [CreateErrorCode.UnknownVariant]: "Choose one of the templates Genex shows.",
  [CreateErrorCode.BadTemplate]: (why: string) => `This Unreal template can't be used: ${why}`,
  [CreateErrorCode.Link]: (what: string) => `${what} links somewhere else, so Genex won't use it.`,
  [CreateErrorCode.BadParent]: "Genex can't save a new project in that folder.",
  [CreateErrorCode.PathTooLong]: (longest: number) =>
    `The path to this project would be too long for Unreal. Use a name of up to ${longest} characters here.`,
  [CreateErrorCode.FolderTooLong]:
    "The Unreal Projects folder's path is too long for Unreal on Windows, whatever the game's name. Move your Documents folder to a shorter path.",
  [CreateErrorCode.NoEngine]: installEngineText(),
  [CreateErrorCode.Busy]:
    "Another app, such as OneDrive or an antivirus, is still reading the new project's files. Try Create and open again in a moment.",
  [CreateErrorCode.UnverifiedEngine]: (version: string) =>
    `Genex makes new Unreal projects with Unreal ${VERIFIED_CREATE_ENGINES.join(" or ")}, and this computer has Unreal ${version}. Install ${VERIFIED_CREATE_ENGINES[0]} beside it in the Epic Games Launcher (Library, then + next to Engine Versions), or make the project in Unreal's own New Project dialog and choose it from the Unreal button.`,
  NoDefs: "it has no Config/TemplateDefs.ini.",
  CustomDefs: "it needs its own C++ setup code.",
  HasCode: "it brings C++ code.",
  NoProjectFile: "its .uproject is missing.",
  MissingPack: (pack: string) => `its shared pack ${pack} is missing.`,
  BadPackList: (pack: string) => `its shared pack ${pack} names files outside the engine.`,
} as const;

/** A refusal with a code for the panel and a message it shows as it is. */
export class CreateError extends Error {
  readonly code: CreateErrorCode;
  constructor(code: CreateErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The refusal when no supported engine is installed. */
export const noEngineError = () => new CreateError(CreateErrorCode.NoEngine, MESSAGE[CreateErrorCode.NoEngine]);

/**
 * The engine versions whose CreateProjectFromTemplate was compared step by step with Epic's own
 * (GameProjectUtils.cpp, the Add*ConfigValues helpers, FeaturePackContentSource's folder markers
 * and the ProjectDescriptor FileVersion). Epic changes these between releases, so each new version
 * needs that comparison again before it is added here; until then, Unreal's own dialog makes it.
 */
export const VERIFIED_CREATE_ENGINES = ["5.8"] as const;
const verified: readonly string[] = VERIFIED_CREATE_ENGINES;

/** Whether Genex makes new games with this engine: its version's creation steps were compared with Epic's. */
export function canCreateWith(engine: Engine): boolean {
  return engine.supported && verified.includes(engine.version);
}

/** The refusal for a supported engine whose creation steps Genex hasn't compared with Epic's. */
export const unverifiedEngineError = (version: string) =>
  new CreateError(CreateErrorCode.UnverifiedEngine, MESSAGE[CreateErrorCode.UnverifiedEngine](version));

/**
 * A template card for the New game form: Epic's English name, Genex's line and the thumbnail; a
 * variant's card names the variant too.
 */
export type TemplateCard = {
  id: BlueprintTemplate;
  variant?: TemplateVariant;
  name: string;
  description: string;
  thumbnail: string | null;
};

/** One new game: the engine, an allowlisted template, the name, and the folder it goes in. */
export type CreateRequest = {
  engine: Engine;
  template: string;
  /** One of the variants Genex offers for the template; none for the template as it is. */
  variant?: string;
  name: string;
  parent: string;
  /**
   * The project's folder under `parent`; the name when absent. A game made from a Genex game goes
   * in that game's folder as `unreal/`, so its checkpoints, Rewind and landing cover the project.
   */
  folder?: string;
  /** Whose rules apply (path length, line endings); defaults to this computer. */
  platform?: NodeJS.Platform;
  /** The new ProjectID's 32 hex digits; tests fix it, Epic makes a new FGuid. */
  newId?: () => string;
  /** How the finished game is renamed into place and a failed one removed; tests stand in for Windows. */
  files?: Pick<RenameFolderOptions, "rename" | "sleep"> & { remove?: (folder: string) => Promise<void> };
};

/** How often, and how far apart, a failed game's temporary folder is removed while Windows holds its files. */
const CLEANUP_RETRIES = 5;
const CLEANUP_RETRY_MS = 200;
/** The codes a rename fails with while another app holds a file inside the folder. */
const BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Epic's limit (MAX_PROJECT_NAME_LENGTH) and character rules (NameContainsOnlyLegalCharacters), ASCII only. */
const PROJECT_NAME = new RegExp(`^[A-Za-z][A-Za-z0-9_]{0,${PROJECT_NAME_MAX - 1}}$`);
/**
 * The longest path per platform, of which Epic keeps 130 characters free (MAX_PROJECT_PATH_BUFFER_SPACE).
 * Stricter than Unreal's dialog on Windows, on purpose: Epic's FPlatformMisc::GetMaxPathLength()
 * there is 32767 when long paths are on (UnrealEditor.exe is longPathAware), but Unreal's Content
 * Browser and external tools (GetExternalAppMaxPathLength) still assume MAX_PATH, 260.
 */
const MAX_PATH = { win32: 260, other: 1024 } as const;
const PATH_BUFFER = 130;
/** The shorter name suggested when "MyGame" doesn't fit a long Windows folder. */
const SHORT_SUGGESTED_NAME = "Game";
/** Platforms Unreal names that the installed engine may not list; a project may not take their names. */
const KNOWN_PLATFORMS = [
  "Android",
  "IOS",
  "Linux",
  "LinuxArm64",
  "Mac",
  "TVOS",
  "Unix",
  "VisionOS",
  "VulkanPC",
  "Windows",
];
const PLATFORM_MODULE_SUFFIX = "TargetPlatform";
/** Names Windows keeps for devices: a folder can't have one there, so a game that may move to Windows can't either. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const PLATFORM_INFO = "DataDrivenPlatformInfo.ini";
const SUGGESTED_NAME = "MyGame";
const SUGGESTION_CAP = 999;
const PROJECTS_FOLDER = "Unreal Projects";
const TEMP_PREFIX = ".genex-new-";
const TEMP_SUFFIX_BYTES = 4;
const PROJECT_ID_BYTES = 16;
const PNG_DATA_URL = "data:image/png;base64,";
/** Epic's thumbnails are 24–88 KB; a larger one is not shown. */
const THUMBNAIL_MAX_BYTES = 512 * 1024;
/** TemplateDefs.ini, a pack manifest, a config file or a .uproject: text far below this. */
const TEXT_MAX_BYTES = 4 * 1024 * 1024;
const DOCUMENTS_TIMEOUT_MS = 5 * SECOND_MS;
/** Epic's detail level for Desktop hardware (EFeaturePackDetailLevel::High; Standard is for Mobile). */
const REQUIRED_DETAIL = "High";
/** CopyAdditionalFilesToFolder's markers, in its order; `true` puts the file under Content/. */
const PACK_FOLDERS: ReadonlyArray<readonly [string, boolean]> = [
  ["__ExternalActors__/", true],
  ["__ExternalObjects__/", true],
  ["Content/", false],
];
const ALL_FILES = new Set(["*", "*.*"]);

const ENGINE_INI = "DefaultEngine.ini";
const GAME_INI = "DefaultGame.ini";
const Section = {
  Hardware: "/Script/HardwareTargeting.HardwareTargetingSettings",
  Renderer: "/Script/Engine.RendererSettings",
  Windows: "/Script/WindowsTargetPlatform.WindowsTargetSettings",
  WorldPartition: "/Script/WorldPartitionEditor.WorldPartitionEditorSettings",
  UserInterface: "/Script/Engine.UserInterfaceSettings",
  CommonUi: "/Script/CommonUI.CommonUISettings",
  ConsoleVariables: "ConsoleVariables",
  Engine: "/Script/Engine.Engine",
  Project: "/Script/EngineSettings.GeneralProjectSettings",
} as const;

const run: Runner = promisify(execFile);
const allowlist: readonly string[] = Object.values(BlueprintTemplate);
const isAllowed = (template: string): template is BlueprintTemplate => allowlist.includes(template);
const lower = (text: string) => text.toLowerCase();
const toPosix = (relative: string) => relative.split(path.sep).join("/");
const templatesFolder = (engine: Engine) => path.join(engine.directory, "Templates");

/** Where new games go: Documents › Unreal Projects, as Unreal's own dialog suggests. */
export function unrealProjectsFolder(platform: NodeJS.Platform, documents: string): string {
  return (platform === "win32" ? path.win32 : path.posix).join(documents, PROJECTS_FOLDER);
}

/**
 * PowerShell's answer as UTF-16LE in base64: plain ASCII, so the console's code page (which turns
 * "Jürgen" into "J?rgen" or a replacement character when read as UTF-8) can't garble it.
 */
const DOCUMENTS_QUERY =
  "[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([Environment]::GetFolderPath('MyDocuments')))";
/** Characters a garbled or lossy answer leaves in a path. */
const GARBLED = /[?\uFFFD]/;

/** How Genex asks Windows for the Documents folder; tests stand in for PowerShell and the disk. */
export type DocumentsQuery = {
  run: Runner;
  env: NodeJS.ProcessEnv;
  isFolder: (folder: string) => Promise<boolean>;
};
const SYSTEM_QUERY: DocumentsQuery = {
  run,
  env: process.env,
  isFolder: async (folder) => (await lstat(folder).catch(() => null))?.isDirectory() ?? false,
};

/** The Documents folder PowerShell names, or undefined when it can't be read cleanly or isn't a folder. */
export async function askDocuments(query: DocumentsQuery = SYSTEM_QUERY): Promise<string | undefined> {
  const powershell = windowsSystemTool(query.env, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DOCUMENTS_QUERY];
  const answer = await query
    .run(powershell, args, { timeout: DOCUMENTS_TIMEOUT_MS, windowsHide: true })
    .catch(() => null);
  const folder = Buffer.from(answer?.stdout.trim() ?? "", "base64").toString("utf16le");
  const clean = path.win32.isAbsolute(folder) && !GARBLED.test(folder);
  return clean && (await query.isFolder(folder)) ? folder : undefined;
}

/** The user's Documents folder; on Windows the real one, which may be redirected to OneDrive. */
export async function documentsFolder(
  env: Pick<SetupEnv, "home" | "platform">,
  query: DocumentsQuery = SYSTEM_QUERY,
): Promise<string> {
  const fallback = (env.platform === "win32" ? path.win32 : path.posix).join(env.home, "Documents");
  if (env.platform !== "win32") return fallback;
  return (await askDocuments(query)) ?? fallback;
}

async function lstatOrNull(target: string) {
  return lstat(target).catch(() => null);
}

/** Refuses when `below` or any folder between `root` and it is a link; true when it exists. */
async function assertNoLinkBelow(root: string, below: string, what: string): Promise<boolean> {
  let current = root;
  for (const segment of path.relative(root, below).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstatOrNull(current);
    if (!info) return false;
    if (info.isSymbolicLink()) throw new CreateError(CreateErrorCode.Link, MESSAGE[CreateErrorCode.Link](what));
  }
  return true;
}

/** Every file below `dir` by its `/`-separated path, refusing any link inside. */
async function listFiles(dir: string, what: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) throw new CreateError(CreateErrorCode.Link, MESSAGE[CreateErrorCode.Link](what));
    if (entry.isFile()) found.push(toPosix(path.relative(dir, full)));
  }
  return found.sort();
}

async function readText(file: string): Promise<string> {
  return loadEpicText(await readRegularFile(file, TEXT_MAX_BYTES));
}

/** A JSON file's value, or null when it is missing, a link, too large or not JSON. */
async function readJsonValue(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readText(file));
  } catch {
    return null;
  }
}

const badTemplate = (why: string) =>
  new CreateError(CreateErrorCode.BadTemplate, MESSAGE[CreateErrorCode.BadTemplate](why));

/** A template's folder and defs, refusing what Genex cannot replicate (the template's .uproject and TemplateDefs.ini; C++ build-settings rules are refused). */
async function loadTemplate(engine: Engine, template: BlueprintTemplate) {
  const folder = path.join(templatesFolder(engine), template);
  if (!(await assertNoLinkBelow(engine.directory, folder, template))) throw badTemplate(MESSAGE.NoDefs);
  const defsText = await readText(path.join(folder, "Config", "TemplateDefs.ini")).catch(() => null);
  if (defsText === null) throw badTemplate(MESSAGE.NoDefs);
  const defs = parseTemplateDefs(defsText);
  if (defs.customClass !== "") throw badTemplate(MESSAGE.CustomDefs);
  // UDefaultTemplateProjectDefs::GeneratesCode: a Source folder makes it a C++ template.
  if (await lstatOrNull(path.join(folder, "Source"))) throw badTemplate(MESSAGE.HasCode);
  const descriptor = await readJsonValue(path.join(folder, `${template}${UPROJECT_EXTENSION}`));
  if (!isJsonObject(descriptor)) throw badTemplate(MESSAGE.NoProjectFile);
  if (Array.isArray(descriptor.Modules) && descriptor.Modules.length > 0) throw badTemplate(MESSAGE.HasCode);
  return { folder, defs, descriptor };
}

/** A PNG as the panel shows it, or null when it is missing, a link or too large. */
async function thumbnailOf(file: string): Promise<string | null> {
  const png = await readRegularFile(file, THUMBNAIL_MAX_BYTES).catch(() => null);
  return png ? `${PNG_DATA_URL}${png.toString("base64")}` : null;
}

/** The variant Genex offers for this template by that name, from the template's own defs; refused otherwise. */
function offeredVariant(template: BlueprintTemplate, defs: TemplateDefs, variant: string): TemplateVariantDefs {
  const offered: readonly string[] = OFFERED_VARIANTS[template];
  const found = offered.includes(variant) ? defs.variants.find((v) => v.name === variant) : undefined;
  if (!found) throw new CreateError(CreateErrorCode.UnknownVariant, MESSAGE[CreateErrorCode.UnknownVariant]);
  return found;
}

/**
 * The cards of a template's offered variants whose packs are all there, each with the template's
 * own picture: a pack's Media image is a small icon of the pack, not a shot of the game.
 */
async function variantCards(
  engine: Engine,
  template: BlueprintTemplate,
  loaded: { defs: TemplateDefs },
  thumbnail: string | null,
): Promise<TemplateCard[]> {
  const cards: TemplateCard[] = [];
  for (const variant of OFFERED_VARIANTS[template]) {
    const defs = await Promise.resolve()
      .then(() => offeredVariant(template, loaded.defs, variant))
      .catch(() => null);
    const packs = defs ? await planPacks(engine, defs.sharedContentPacks).catch(() => null) : null;
    if (!defs || !packs) continue;
    const name = variantName(loaded.defs.displayName, defs.displayName || variant);
    cards.push({ id: template, variant, name, description: VARIANT_LINE[variant], thumbnail });
  }
  return cards;
}

/** The template cards for the allowlisted templates this engine has and Genex can create, each followed by its variants. */
export async function listTemplates(engine: Engine): Promise<TemplateCard[]> {
  const cards: TemplateCard[] = [];
  for (const id of Object.values(BlueprintTemplate)) {
    const loaded = await loadTemplate(engine, id).catch(() => null);
    if (!loaded) continue;
    const thumbnail = await thumbnailOf(path.join(loaded.folder, "Media", `${id}.png`));
    cards.push({ id, name: loaded.defs.displayName, description: TEMPLATE_LINE[id], thumbnail });
    cards.push(...(await variantCards(engine, id, loaded, thumbnail)));
  }
  return cards;
}

/** "MyGame", else "MyGame2" and on: the first name nothing in `parent` has. */
export async function suggestName(parent: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  const limit = pathLimit(platform);
  for (const base of [SUGGESTED_NAME, SHORT_SUGGESTED_NAME])
    for (let n = 1; n <= SUGGESTION_CAP; n++) {
      const name = n === 1 ? base : `${base}${n}`;
      if (!fits(parent, name, limit)) break;
      if (!(await lstatOrNull(path.join(parent, name)))) return name;
    }
  return SUGGESTED_NAME;
}

/** The longest `<parent>/<Name>/<Name>` Unreal takes on the platform. */
const pathLimit = (platform: NodeJS.Platform) => (platform === "win32" ? MAX_PATH.win32 : MAX_PATH.other) - PATH_BUFFER;
/** Whether `<parent>/<Name>/<Name>` (FPaths::GetBaseFilename of the project file) stays within the limit. */
const fits = (parent: string, name: string, limit: number) => parent.length + 2 * (name.length + 1) <= limit;
/** The longest name that fits under `parent`. */
const longestName = (parent: string, limit: number) => Math.floor((limit - parent.length) / 2) - 1;

/** Platform names the engine lists (NameMatchesPlatformModuleName's source) with Genex's known ones. */
async function platformNames(engine: Engine): Promise<string[]> {
  const names = new Set(KNOWN_PLATFORMS);
  const config = path.join(engine.directory, "Engine", "Config");
  const platforms = path.join(engine.directory, "Engine", "Platforms");
  for (const name of await readdir(config).catch(() => []))
    if (await lstatOrNull(path.join(config, name, PLATFORM_INFO))) names.add(name);
  for (const name of await readdir(platforms).catch(() => []))
    if (await lstatOrNull(path.join(platforms, name, "Config", PLATFORM_INFO))) names.add(name);
  return [...names];
}

/** The first rule `name` breaks, checked in the order the user can fix them. */
function nameProblem(name: string): NameProblem {
  if (name === "") return NameProblem.Empty;
  if (!/^[A-Za-z]/.test(name)) return NameProblem.FirstNotLetter;
  if (/\s/.test(name)) return NameProblem.Space;
  if (!/^[A-Za-z0-9_]*$/.test(name)) return NameProblem.OtherCharacter;
  return NameProblem.TooLong;
}

/** Epic's name rules (IsValidProjectFileForCreation). */
async function assertName(name: string, engine: Engine): Promise<void> {
  if (!PROJECT_NAME.test(name))
    throw new CreateError(CreateErrorCode.BadName, MESSAGE[CreateErrorCode.BadName][nameProblem(name)]);
  const reserved = (await platformNames(engine)).flatMap((p) => [lower(p), lower(p + PLATFORM_MODULE_SUFFIX)]);
  if (reserved.includes(lower(name)) || WINDOWS_DEVICE_NAME.test(name))
    throw new CreateError(CreateErrorCode.ReservedName, MESSAGE[CreateErrorCode.ReservedName](name));
}

/** The parent's own rules: absolute, outside the engine, not a link, short enough. */
async function assertParent(request: CreateRequest, platform: NodeJS.Platform): Promise<void> {
  const { parent, name, engine } = request;
  if (!path.isAbsolute(parent) || isInside(engine.directory, parent))
    throw new CreateError(CreateErrorCode.BadParent, MESSAGE[CreateErrorCode.BadParent]);
  const limit = pathLimit(platform);
  if (!fits(parent, "A", limit))
    throw new CreateError(CreateErrorCode.FolderTooLong, MESSAGE[CreateErrorCode.FolderTooLong]);
  if (!fits(parent, name, limit))
    throw new CreateError(
      CreateErrorCode.PathTooLong,
      MESSAGE[CreateErrorCode.PathTooLong](longestName(parent, limit)),
    );
  if ((await lstatOrNull(parent))?.isSymbolicLink())
    throw new CreateError(CreateErrorCode.Link, MESSAGE[CreateErrorCode.Link](parent));
}

/** A folder as the panel names a place: its parent's name and its own, "Documents › Unreal Projects". */
const folderWords = (folder: string) => [path.basename(path.dirname(folder)), path.basename(folder)].join(" › ");

async function assertFree(parent: string, name: string): Promise<void> {
  if (await lstatOrNull(path.join(parent, name)))
    throw new CreateError(CreateErrorCode.NameTaken, MESSAGE[CreateErrorCode.NameTaken](name, folderWords(parent)));
}

type CopyItem = { from: string; to: string; replace: boolean };

const startsWithFolder = (subpath: string, folder: string) => lower(subpath).startsWith(lower(`${folder}/`));

/** FPaths::GetBaseFilename and GetExtension for a `/`-separated path. */
function splitName(subpath: string): { folder: string; base: string; extension: string } {
  const folder = path.posix.dirname(subpath);
  const file = path.posix.basename(subpath);
  const dot = file.lastIndexOf(".");
  return dot < 0
    ? { folder, base: file, extension: "" }
    : { folder, base: file.slice(0, dot), extension: file.slice(dot + 1) };
}

/** Where CreateProjectFromTemplate copies one template file, or undefined when Epic ignores it. */
function copyTarget(subpath: string, defs: TemplateDefs): CopyItem | undefined {
  if (defs.filesToIgnore.some((ignored) => lower(ignored) === lower(subpath))) return undefined;
  if (defs.foldersToIgnore.some((folder) => startsWithFolder(subpath, folder))) return undefined;
  const { folder, base, extension } = splitName(subpath);
  let target = folder === "." ? "" : folder;
  for (const rename of defs.folderRenames)
    if (startsWithFolder(subpath, rename.from)) target = path.posix.join(rename.to, target.slice(rename.from.length));
  let name = base;
  for (const rule of defs.filenameReplacements)
    if (rule.extensions.some((listed) => lower(listed) === lower(extension)))
      name = replaceAllText(name, rule.from, rule.to, rule.caseSensitive);
  const file = extension === "" ? name : `${name}.${extension}`;
  const replace = defs.replacementsInFiles.some((rule) => rule.extensions.some((e) => lower(e) === lower(extension)));
  return { from: subpath, to: path.posix.join(target, file), replace };
}

/** The file copy and ReplacementsInFiles: the template's files, copied and renamed, text files with the names replaced. */
async function copyTemplate(plan: CreatePlan, destination: string): Promise<void> {
  for (const subpath of plan.files) {
    const item = copyTarget(subpath, plan.defs);
    if (!item) continue;
    const source = path.join(plan.folder, ...item.from.split("/"));
    const target = path.join(destination, ...item.to.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    if (!item.replace) {
      await copyFile(source, target, FS.COPYFILE_EXCL);
      continue;
    }
    const replaced = replaceInText(await readText(source), plan.defs.replacementsInFiles, splitName(item.to).extension);
    await writeFile(target, saveEpicText(replaced), { flag: "wx" });
  }
}

type PackFile = { source: string; target: string };

/** The pack a SharedContentPacks entry means at Desktop detail (FFeaturePackLevelSet::GetFeaturePackNameForLevel). */
function packLevel(levels: string[]): string {
  return levels.some((level) => lower(level) === lower(REQUIRED_DETAIL)) ? REQUIRED_DETAIL : (levels[0] ?? "");
}

/** CopyAdditionalFilesToFolder's destination for a file below the engine root, or undefined when Epic skips it. */
function packTarget(relative: string, mount: string): string | undefined {
  for (const [marker, underContent] of PACK_FOLDERS) {
    const at = lower(relative).indexOf(lower(marker));
    if (at < 0) continue;
    const inner = relative.slice(at);
    const mounted = `${inner.slice(0, marker.length - 1)}/${mount}${inner.slice(marker.length - 1)}`;
    return underContent ? `Content/${mounted}` : mounted;
  }
  return undefined;
}

const wildcard = (pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")
      .replaceAll("?", ".")}$`,
    "i",
  );

/** One AdditionalFilesList entry's files, relative to the engine root (BuildListOfAdditionalFiles). */
async function packListFiles(engine: Engine, entry: string, pack: string): Promise<string[]> {
  const relative = path.posix.normalize(entry.replaceAll("\\", "/"));
  const directory = path.join(engine.directory, ...path.posix.dirname(relative).split("/"));
  const outsideEngine =
    path.posix.isAbsolute(relative) || relative.startsWith("..") || !isInside(engine.directory, directory);
  if (outsideEngine) throw badTemplate(MESSAGE.BadPackList(pack));
  if (!(await assertNoLinkBelow(engine.directory, directory, pack))) return [];
  const pattern = path.posix.basename(relative);
  const below = toPosix(path.relative(engine.directory, directory));
  if (!pattern.includes("*")) return [`${below}/${pattern}`];
  const matches = ALL_FILES.has(pattern)
    ? () => true
    : (file: string) => wildcard(pattern).test(path.posix.basename(file));
  return (await listFiles(directory, pack)).filter(matches).map((file) => `${below}/${file}`);
}

/** A shared pack's folder under the engine's template resources. */
const packFolder = (engine: Engine, mount: string, level: string) =>
  path.join(templatesFolder(engine), "TemplateResources", level, mount);

/** The AdditionalFilesList a pack's manifest names, refusing a manifest that is missing or not that pack's. */
async function packLists(engine: Engine, mount: string, level: string): Promise<string[]> {
  const pack = `${mount}${level}`;
  const manifestFile = path.join(packFolder(engine, mount, level), "FeaturePack", "manifest.json");
  if (!(await assertNoLinkBelow(engine.directory, manifestFile, pack))) throw badTemplate(MESSAGE.MissingPack(pack));
  const manifest = await readJsonValue(manifestFile);
  if (!isJsonObject(manifest) || manifest.Ident !== pack) throw badTemplate(MESSAGE.MissingPack(pack));
  const extra = manifest.AdditionalFiles;
  const lists = isJsonObject(extra) && Array.isArray(extra.AdditionalFilesList) ? extra.AdditionalFilesList : [];
  return lists.filter((item): item is string => typeof item === "string");
}

/** AddSharedContentToProject: every shared pack's files and where they go; a pack that isn't there fails creation. */
async function planPacks(engine: Engine, packs: readonly PackLevelSet[]): Promise<PackFile[]> {
  const planned: PackFile[] = [];
  for (const { mount, levels } of packs) {
    const level = packLevel(levels);
    for (const entry of await packLists(engine, mount, level))
      for (const file of await packListFiles(engine, entry, `${mount}${level}`)) {
        const target = packTarget(file, mount);
        if (target) planned.push({ source: path.join(engine.directory, ...file.split("/")), target });
      }
  }
  return planned;
}

async function copyPacks(files: PackFile[], destination: string): Promise<void> {
  for (const { source, target } of files) {
    const to = path.join(destination, ...target.split("/"));
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(source, to, FS.COPYFILE_EXCL);
  }
}

const value = (file: string, section: string, key: string, setting: string, replace: boolean): ConfigValue => ({
  file,
  section,
  key,
  value: setting,
  replace,
});

/**
 * What Genex sets after Epic's values in a game made on a Mac: hardware ray tracing off. UE 5.8
 * rendering a ray-traced level behind another app hangs the GPU and crashes the editor (an M4 Max,
 * within a few plays every time); Lumen still lights the level, tracing in software. It replaces
 * the first `r.RayTracing` line, which is the one Epic's values added.
 */
const MAC_VALUES: readonly ConfigValue[] = [value(ENGINE_INI, Section.Renderer, "r.RayTracing", "False", true)];
const MAC: NodeJS.Platform = "darwin";

/** CreateProjectFromTemplate's config values: Epic's values for a Blueprint template at Desktop and Maximum, in Epic's order. */
function configValues(template: string, name: string, isBlank: boolean, projectId: string): ConfigValue[] {
  const renderer = (key: string, setting: string, replace: boolean) =>
    value(ENGINE_INI, Section.Renderer, key, setting, replace);
  const blankOnly = (values: ConfigValue[]) => (isBlank ? values : []);
  return [
    value(ENGINE_INI, Section.Hardware, "TargetedHardwareClass", "EHardwareClass::Desktop", true),
    value(ENGINE_INI, Section.Hardware, "DefaultGraphicsPerformance", "EGraphicsPreset::Maximum", true),
    renderer("r.GenerateMeshDistanceFields", "True", true),
    renderer("r.DynamicGlobalIlluminationMethod", "1", true),
    renderer("r.ReflectionMethod", "1", true),
    value(ENGINE_INI, Section.Windows, "DefaultGraphicsRHI", "DefaultGraphicsRHI_DX12", false),
    renderer("r.SkinCache.CompileShaders", "True", false),
    renderer("r.RayTracing", "True", false),
    renderer("r.RayTracing.RayTracingProxies.ProjectEnabled", "True", false),
    renderer("r.Substrate", "True", false),
    renderer("r.Substrate.ProjectGBufferFormat", "0", false),
    renderer("r.Shadow.Virtual.Enable", "1", true),
    renderer("r.DefaultFeature.AutoExposure.ExtendDefaultLuminanceRange", "True", false),
    renderer("r.DefaultFeature.LocalExposure.HighlightContrastScale", "0.8", false),
    renderer("r.DefaultFeature.LocalExposure.ShadowContrastScale", "0.8", false),
    ...blankOnly([
      value(
        ENGINE_INI,
        Section.WorldPartition,
        "CommandletClass",
        "Class'/Script/UnrealEd.WorldPartitionConvertCommandlet'",
        true,
      ),
      value(ENGINE_INI, Section.UserInterface, "bAuthorizeAutomaticWidgetVariableCreation", "False", true),
      value(ENGINE_INI, Section.UserInterface, "FontDPIPreset", "Standard", true),
      value(ENGINE_INI, Section.UserInterface, "FontDPI", "72", true),
      value(GAME_INI, Section.CommonUi, "CommonButtonAcceptKeyHandling", "TriggerClick", true),
    ]),
    value(GAME_INI, Section.ConsoleVariables, "CommonUI.CheckKeyboardFocusAndParentage", "1", true),
    value(GAME_INI, Section.ConsoleVariables, "CommonUI.DisallowUserFocusedWidgetForPendingFocusRecipient", "1", true),
    value(GAME_INI, Section.ConsoleVariables, "CommonUI.FallbackToDesiredOnAutoRestoreFailure", "1", true),
    value(
      ENGINE_INI,
      Section.Engine,
      "+ActiveGameNameRedirects",
      `(OldGameName="/Script/${template}",NewGameName="/Script/${name}")`,
      false,
    ),
    value(
      ENGINE_INI,
      Section.Engine,
      "+ActiveGameNameRedirects",
      `(OldGameName="${template}",NewGameName="/Script/${name}")`,
      false,
    ),
    value(GAME_INI, Section.Project, "ProjectID", projectId, true),
  ];
}

/** SaveConfigValues: each value applied in order to its file under Config/; a file that isn't there is skipped. */
async function saveConfigValues(destination: string, values: ConfigValue[], eol: string): Promise<void> {
  const texts = new Map<string, string>();
  for (const setting of values) {
    const file = path.join(destination, "Config", setting.file);
    const text = texts.get(file) ?? (await readText(file).catch(() => null));
    if (text === null) continue;
    texts.set(file, setConfigValue(text, setting, eol));
  }
  for (const [file, text] of texts) await writeFile(file, saveEpicText(text));
}

const newProjectId = () => randomBytes(PROJECT_ID_BYTES).toString("hex").toUpperCase();

/** Everything creation reads, gathered and checked before anything is written. */
type CreatePlan = {
  folder: string;
  defs: TemplateDefs;
  descriptor: unknown;
  files: string[];
  packs: PackFile[];
};

/**
 * What a new game is made of: the template, its defs with the names filled in, its files and its
 * shared packs, then the chosen variant's packs (AddSharedContentToProject copies them after).
 */
async function planProject(request: Omit<CreateRequest, "parent">, template: BlueprintTemplate): Promise<CreatePlan> {
  const loaded = await loadTemplate(request.engine, template);
  const defs = fixupStrings(loaded.defs, template, request.name);
  const variant = request.variant === undefined ? null : offeredVariant(template, defs, request.variant);
  const packs = [
    ...(await planPacks(request.engine, defs.sharedContentPacks)),
    ...(variant ? await planPacks(request.engine, variant.sharedContentPacks) : []),
  ];
  const files = await listFiles(loaded.folder, template);
  return { folder: loaded.folder, defs, descriptor: loaded.descriptor, files, packs };
}

/** The new game written into `destination`, a fresh folder: Content, the files, the config, the packs and the .uproject. */
async function buildProject(request: CreateRequest, plan: CreatePlan, destination: string, eol: string) {
  const template = path.basename(plan.folder);
  await mkdir(path.join(destination, "Content"), { recursive: true });
  await copyTemplate(plan, destination);
  const projectId = (request.newId ?? newProjectId)();
  const epic = configValues(template, request.name, plan.defs.isBlank, projectId);
  const onMac = (request.platform ?? process.platform) === MAC;
  await saveConfigValues(destination, onMac ? [...epic, ...MAC_VALUES] : epic, eol);
  await copyPacks(plan.packs, destination);
  const descriptor = projectDescriptorText(plan.descriptor, request.engine.version, eol);
  const file = path.join(destination, `${request.name}${UPROJECT_EXTENSION}`);
  await writeFile(file, saveEpicText(descriptor), { flag: "wx" });
}

/** The checks that need no folder yet: the engine, the template and its variant, and the name. */
async function assertMakeable(request: Omit<CreateRequest, "parent">): Promise<BlueprintTemplate> {
  const { template, name } = request;
  if (!canCreateWith(request.engine)) throw unverifiedEngineError(request.engine.version);
  if (!isAllowed(template))
    throw new CreateError(CreateErrorCode.UnknownTemplate, MESSAGE[CreateErrorCode.UnknownTemplate]);
  await assertName(name, request.engine);
  return template;
}

/** Every check `createProject` makes before it writes, in its order; the plan when all pass. */
async function checkedPlan(request: CreateRequest): Promise<CreatePlan> {
  const platform = request.platform ?? process.platform;
  const template = await assertMakeable(request);
  await assertParent(request, platform);
  const plan = await planProject(request, template);
  await assertFree(request.parent, request.folder ?? request.name);
  return plan;
}

/**
 * Refuses, with the same `CreateError`, a template, variant or name `createProject` would refuse
 * wherever the project goes, reading nothing but the engine: asked before a folder for it is made.
 */
export async function assertTemplateAndName(request: Omit<CreateRequest, "parent">): Promise<void> {
  const template = await assertMakeable(request);
  await planProject(request, template);
}

/**
 * Refuses, with the same `CreateError`, a project `createProject` would refuse, reading and writing
 * nothing else: a caller that changes something first (the game's ignore file) asks this before.
 */
export async function assertCreatable(request: CreateRequest): Promise<void> {
  await checkedPlan(request);
}

/**
 * Makes a new Unreal project `<parent>/<name>` from an allowlisted Blueprint template and returns
 * its `.uproject`. Everything is read and checked before anything is written; the project is built
 * in a hidden sibling and renamed into place, and that sibling is removed if anything fails.
 */
export async function createProject(request: CreateRequest): Promise<string> {
  const platform = request.platform ?? process.platform;
  const { name, parent } = request;
  const folder = request.folder ?? name;
  const plan = await checkedPlan(request);
  await mkdir(parent, { recursive: true });
  await assertFree(parent, folder);
  const temporary = path.join(parent, `${TEMP_PREFIX}${name}-${randomBytes(TEMP_SUFFIX_BYTES).toString("hex")}`);
  await mkdir(temporary);
  try {
    await buildProject(request, plan, temporary, platform === "win32" ? "\r\n" : "\n");
    await assertFree(parent, folder);
    await moveIntoPlace(temporary, path.join(parent, folder), platform, request.files);
  } catch (error) {
    // A cleanup that fails (Windows still holding a file) never hides why creation failed.
    const remove = request.files?.remove ?? removeTemporary;
    await remove(temporary).catch(() => undefined);
    throw error;
  }
  return path.join(parent, folder, `${name}${UPROJECT_EXTENSION}`);
}

const removeTemporary = (folder: string) =>
  rm(folder, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES, retryDelay: CLEANUP_RETRY_MS });

/** Renames the finished game into place, saying in plain words when Windows apps still hold its files. */
async function moveIntoPlace(
  from: string,
  to: string,
  platform: NodeJS.Platform,
  files: CreateRequest["files"],
): Promise<void> {
  try {
    await renameFolder(from, to, { platform, rename: files?.rename, sleep: files?.sleep });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (platform === "win32" && BUSY_CODES.has(code))
      throw new CreateError(CreateErrorCode.Busy, MESSAGE[CreateErrorCode.Busy]);
    throw error;
  }
}

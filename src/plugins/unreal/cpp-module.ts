/**
 * A game's C++ module. A Blueprint project becomes a C++ project the way Unreal lays one out:
 * `Source/<M>.Target.cs` and `Source/<M>Editor.Target.cs`, the module's `Build.cs`, header and
 * source with IMPLEMENT_PRIMARY_GAME_MODULE, and one Runtime entry in the .uproject's "Modules".
 * Builders then write their parts under `Source/<M>/Parts/<Part>/`.
 *
 * The project folder is the user's: every check comes before the first write, nothing is written
 * through a link or outside the project's real folder, a file already there is kept as it is,
 * and the .uproject is rewritten last and atomically, every other field and its indentation kept.
 * A second call changes nothing. A project plugin is enabled in the .uproject the same way
 * (`enableProjectPlugin`).
 */
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import { isProjectPath, projectName } from "./project-file.ts";

/** Why Genex refused to add the module; nothing was written. */
export const CppModuleErrorCode = {
  NotProjectFile: "not-project-file",
  Unreadable: "unreadable",
  Link: "link",
  Escapes: "escapes",
  PathTaken: "path-taken",
  DifferentModule: "different-module",
  ReservedName: "reserved-name",
} as const;
export type CppModuleErrorCode = (typeof CppModuleErrorCode)[keyof typeof CppModuleErrorCode];

/** A refusal with a code for the caller and a message it can show as it is. */
export class CppModuleError extends Error {
  readonly code: CppModuleErrorCode;
  constructor(code: CppModuleErrorCode, message: string) {
    super(message);
    this.name = "CppModuleError";
    this.code = code;
  }
}

/** What adding the module may know besides the project. */
export type AddCppModuleOptions = {
  /** The engine's version as the plugin knows it ("5.8", "5.8.3"); else the .uproject's EngineAssociation. */
  engineVersion?: string;
  /** The installed engine's folder: a name one of its own modules has is refused too. */
  engineDir?: string;
};

/** The module's name, the files written (relative, `/`-separated) and whether the .uproject gained its entry. */
export type AddedCppModule = { module: string; created: string[]; declared: boolean };

/** A .uproject is a few kilobytes. */
const UPROJECT_MAX_BYTES = 256 * 1024;
/**
 * A library of the game's own as a crash frame or `UnrealEditor.modules` names it:
 * `libUnrealEditor-<Module>[-<hot reload>].dylib`, or Windows' `.dll`. A hot reload gives each new
 * library a numbered suffix (`-4543`).
 */
export const GAME_LIBRARY = /^(?:lib)?UnrealEditor-([A-Za-z_][A-Za-z0-9_]*?)(-\d+)?\.(?:dylib|dll)$/;
/** Where a Mac editor build lists the project's libraries, relative to the project folder. */
const MAC_MODULES_FILE = ["Binaries", "Mac", "UnrealEditor.modules"] as const;
/** A modules file names a handful of libraries. */
const MODULES_MAX_BYTES = 64 * 1024;
/** The longest module name Genex picks; Unreal's New Project dialog keeps names far shorter. */
const MAX_MODULE_CHARS = 32;
/** A module name Genex accepts from a .uproject or a caller: a C++ identifier. */
const MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/**
 * Underscore shapes C++ reserves, in the name or in its `<MODULE>_API` macro: a leading one, a
 * trailing one (`GX__API`) and a double one.
 */
const RESERVED_SHAPE = /^_|_$|__/;
/**
 * Names a module can't take: C++ and C# keywords (the module's name is a C++ macro prefix and a
 * C# class in its Build.cs), and the C# names its rules files use. Compared with case, as both
 * languages do.
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set(
  [
    // C++
    "alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t char32_t class",
    "compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype",
    "default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline",
    "int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public",
    "register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch",
    "template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile",
    "wchar_t while xor xor_eq",
    // C# (besides those C++ shares)
    "abstract as base byte checked decimal delegate dynamic event finally fixed foreach implicit in interface",
    "internal is lock null object out override params readonly record ref sbyte sealed stackalloc string typeof",
    "uint ulong unchecked unsafe ushort var",
    // The C# names the module's rules files use
    "System Microsoft EpicGames UnrealBuildTool ModuleRules TargetRules TargetInfo ReadOnlyTargetRules TargetType",
    "Target BuildSettingsVersion EngineIncludeOrderVersion PCHUsageMode ModuleDirectory",
  ].flatMap((line) => line.split(" ")),
);
/** What separates the words of a project name that isn't an identifier ("Dirt-Track"). */
const NOT_IDENTIFIER = /[^A-Za-z0-9_]+/;
/** What a cleaned name can't start or end with, and the runs of underscores it keeps as one. */
const LEADING_JUNK = /^[\d_]+/;
const TRAILING_UNDERSCORES = /_+$/;
const UNDERSCORE_RUNS = /__+/g;
/** The module's name when the project's has nothing an identifier can keep. */
const FALLBACK_MODULE = "GenexGame";
const SOURCE_FOLDER = "Source";
const TARGET_SUFFIX = ".Target.cs";
const EDITOR_SUFFIX = "Editor";
const RUNTIME_TYPE = "Runtime";
const MODULES_KEY = "Modules";
const PLUGINS_KEY = "Plugins";
const BOM = "﻿";
/** An engine version: "5.8" or "5.8.3". */
const ENGINE_VERSION = /^(\d+)\.(\d+)(?:\.\d+)?$/;
/**
 * The include order an engine's targets name: Unreal5_<minor> for 5.8 and newer (each engine
 * keeps the two before it), else 5.8's, the version this file was compared against.
 */
const INCLUDE_ORDER = { major: 5, minor: 8 } as const;
/** UE 5.8's latest build settings, as its own C++ templates name them; later engines keep it. */
const BUILD_SETTINGS = "V7";
const VEHICLE_PLUGIN = "ChaosVehiclesPlugin";
/** What every game module may use: gameplay, Enhanced Input, and UMG and Slate for HUDs. */
const DEPENDENCIES = ["Core", "CoreUObject", "Engine", "InputCore", "EnhancedInput", "UMG", "Slate", "SlateCore"];
/** What a vehicle game's module adds, as Epic's vehicle template does. */
const VEHICLE_DEPENDENCIES = ["ChaosVehicles", "PhysicsCore"];
/** Names Unreal itself uses for modules or targets, refused without asking the engine; compared without case. */
const ENGINE_MODULES = new Set(
  [
    ...DEPENDENCIES,
    ...VEHICLE_DEPENDENCIES,
    "Unreal",
    "UnrealGame",
    "UnrealEditor",
    "UnrealClient",
    "UnrealServer",
    "UnrealEd",
    "Launch",
    "Chaos",
    "RenderCore",
    "Renderer",
    "RHI",
    "ApplicationCore",
    "Projects",
    "Json",
    "JsonUtilities",
    "AIModule",
    "NavigationSystem",
    "GameplayTags",
    "GameplayTasks",
    "Niagara",
    "Landscape",
    "Foliage",
    "AudioMixer",
    "MovieScene",
    "LevelSequence",
    "Networking",
    "Sockets",
    "HTTP",
    "Kismet",
    "BlueprintGraph",
    "ToolMenus",
    "AssetRegistry",
    "DeveloperSettings",
    "NetCore",
    "Media",
    "MediaAssets",
    "Paper2D",
    "CinematicCamera",
  ].map((name) => name.toLowerCase()),
);
/** Where an installed engine keeps its own modules, each in a folder of its name. */
const ENGINE_SOURCE_GROUPS = ["Runtime", "Editor", "Developer", "Programs"] as const;
/** What a target is for, as TargetType names it. */
const TargetKind = { Game: "Game", Editor: "Editor" } as const;
type TargetKind = (typeof TargetKind)[keyof typeof TargetKind];
/** What is at a path, without following a link there. */
const PathKind = { Missing: "missing", Link: "link", Folder: "folder", File: "file", Other: "other" } as const;
type PathKind = (typeof PathKind)[keyof typeof PathKind];

const MESSAGE = {
  NotProjectFile: "Genex adds a C++ module to an Unreal project file (.uproject), and this isn't one.",
  Unreadable: (why: string) => `The project file couldn't be read: ${why}, so Genex left the project as it is.`,
  NotJson: "it isn't JSON",
  NotObject: "it isn't a JSON object",
  ModulesNotList: '"Modules" isn\'t a list',
  PluginsNotList: '"Plugins" isn\'t a list',
  TooLarge: `it is larger than ${UPROJECT_MAX_BYTES / 1024} KB`,
  Link: (what: string) => `${what} is a link, so Genex won't write through it.`,
  Escapes: (what: string) => `${what} doesn't resolve to itself inside the project folder, so Genex won't write there.`,
  PathTaken: (what: string) =>
    `${what} is already there and isn't what a C++ module needs, so Genex left the project as it is.`,
  DifferentModule: (other: string) =>
    `This project already has the C++ module ${other}; Genex adds its module to a Blueprint project only.`,
  AnotherModule: "another module",
  ReservedName: (module: string) =>
    `${module} is the name of one of Unreal's own modules, so it can't name this game's module. Rename the project first.`,
  ProjectFile: "The project file",
  ProjectFolder: "The project folder",
} as const;

/** One file of the module: where it goes (relative, `/`-separated) and its text. */
type ModuleFile = { relative: string; text: string };
/** How the .uproject is written, so a rewrite keeps it. */
type TextFormat = { bom: boolean; indent: string; eol: string; trailingNewline: boolean };
/** A .uproject read for the change: its real folder and file, its JSON and how it is written. */
type Project = { root: string; file: string; json: Record<string, unknown>; format: TextFormat };

const refusal = (code: CppModuleErrorCode, message: string) => new CppModuleError(code, message);
/** A .uproject field that should be a list: the list, or none. */
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Whether a name can name a C++ module: an identifier of at most 64 characters that is no C++ or
 * C# keyword, no name the rules files use and no underscore shape C++ reserves.
 */
export function isModuleName(name: string): boolean {
  return MODULE_NAME.test(name) && !RESERVED_SHAPE.test(name) && !RESERVED_WORDS.has(name);
}

const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * The module Genex makes for a project: the .uproject's name when it is a module name of at most
 * 32 characters, else its words joined and capitalized ("Dirt-Track" is "DirtTrack",
 * "class" is "Class"), leading digits and underscores dropped, else "GenexGame".
 */
export function moduleNameFor(projectFile: string): string {
  const name = projectName(projectFile);
  if (isModuleName(name) && name.length <= MAX_MODULE_CHARS) return name;
  const words = name.split(NOT_IDENTIFIER).filter(Boolean);
  const joined = words.map(capitalized).join("").replace(UNDERSCORE_RUNS, "_").replace(LEADING_JUNK, "");
  const cleaned = joined.slice(0, MAX_MODULE_CHARS).replace(TRAILING_UNDERSCORES, "");
  return isModuleName(cleaned) ? cleaned : FALLBACK_MODULE;
}

async function kindOf(target: string): Promise<PathKind> {
  const info = await lstat(target).catch(() => null);
  if (!info) return PathKind.Missing;
  if (info.isSymbolicLink()) return PathKind.Link;
  if (info.isDirectory()) return PathKind.Folder;
  return info.isFile() ? PathKind.File : PathKind.Other;
}

/** The .uproject's text, never through a link and within the cap. */
async function readProjectText(file: string): Promise<string> {
  try {
    return (await readRegularFile(file, UPROJECT_MAX_BYTES)).toString("utf8");
  } catch (failure) {
    const code = (failure as NodeJS.ErrnoException).code;
    if (code === "EFBIG") throw refusal(CppModuleErrorCode.Unreadable, MESSAGE.Unreadable(MESSAGE.TooLarge));
    if (code === "ELOOP") throw refusal(CppModuleErrorCode.Link, MESSAGE.Link(MESSAGE.ProjectFile));
    throw refusal(CppModuleErrorCode.NotProjectFile, MESSAGE.NotProjectFile);
  }
}

function formatOf(text: string): TextFormat {
  return {
    bom: text.startsWith(BOM),
    indent: /^([ \t]+)\S/m.exec(text)?.[1] ?? "\t",
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    trailingNewline: text.endsWith("\n"),
  };
}

/** The .uproject's JSON object, with a list (or nothing) as its Modules. */
function parseProject(text: string): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(text.startsWith(BOM) ? text.slice(BOM.length) : text);
  } catch {
    throw refusal(CppModuleErrorCode.Unreadable, MESSAGE.Unreadable(MESSAGE.NotJson));
  }
  if (!isJsonObject(json)) throw refusal(CppModuleErrorCode.Unreadable, MESSAGE.Unreadable(MESSAGE.NotObject));
  const modules = json[MODULES_KEY];
  if (modules !== undefined && !Array.isArray(modules))
    throw refusal(CppModuleErrorCode.Unreadable, MESSAGE.Unreadable(MESSAGE.ModulesNotList));
  return json;
}

/** The project file by its real folder: refused when it, or its folder, is a link or not a plain file. */
async function readProject(projectFile: string): Promise<Project> {
  if (!isProjectPath(projectFile)) throw refusal(CppModuleErrorCode.NotProjectFile, MESSAGE.NotProjectFile);
  const folder = path.dirname(projectFile);
  if ((await kindOf(folder)) === PathKind.Link)
    throw refusal(CppModuleErrorCode.Link, MESSAGE.Link(MESSAGE.ProjectFolder));
  const root = await realpath(folder).catch(() => undefined);
  if (root === undefined) throw refusal(CppModuleErrorCode.NotProjectFile, MESSAGE.NotProjectFile);
  const file = path.join(root, path.basename(projectFile));
  const kind = await kindOf(file);
  if (kind === PathKind.Link) throw refusal(CppModuleErrorCode.Link, MESSAGE.Link(MESSAGE.ProjectFile));
  if (kind !== PathKind.File) throw refusal(CppModuleErrorCode.NotProjectFile, MESSAGE.NotProjectFile);
  const text = await readProjectText(file);
  return { root, file, json: parseProject(text), format: formatOf(text) };
}

/** The .uproject's JSON object, or undefined when it can't be read as one. */
async function readProjectJson(projectFile: string): Promise<Record<string, unknown> | undefined> {
  if (!isProjectPath(projectFile)) return undefined;
  try {
    const text = (await readRegularFile(projectFile, UPROJECT_MAX_BYTES)).toString("utf8");
    const json: unknown = JSON.parse(text.startsWith(BOM) ? text.slice(BOM.length) : text);
    return isJsonObject(json) ? json : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The project's game module: the first Runtime module its .uproject names, read from the file
 * itself (never through a link, within the size cap), when that name is an identifier; else
 * undefined, as for a Blueprint project.
 */
export async function projectModule(projectFile: string): Promise<string | undefined> {
  const json = await readProjectJson(projectFile);
  const runtime = listOf(json?.[MODULES_KEY]).find((entry) => isJsonObject(entry) && entry.Type === RUNTIME_TYPE);
  const name = isJsonObject(runtime) ? runtime.Name : undefined;
  return typeof name === "string" && isModuleName(name) ? name : undefined;
}

/**
 * The library the project's own `Binaries/Mac/UnrealEditor.modules` names for `module`, read only
 * at its real path inside the project folder (no link on the way), within the size cap; undefined
 * when there is none or it can't be read as one.
 */
async function macModuleLibrary(projectFile: string, module: string): Promise<string | undefined> {
  try {
    const root = await realpath(path.dirname(projectFile));
    const file = path.join(root, ...MAC_MODULES_FILE);
    if ((await realpath(file)) !== file) return undefined;
    const text = (await readRegularFile(file, MODULES_MAX_BYTES)).toString("utf8");
    const json: unknown = JSON.parse(text.startsWith(BOM) ? text.slice(BOM.length) : text);
    const modules = isJsonObject(json) ? json.Modules : undefined;
    const library = isJsonObject(modules) ? modules[module] : undefined;
    return typeof library === "string" ? library : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether Unreal would load a hot-reloaded library of the game's module when the project opens: the
 * project's Mac `UnrealEditor.modules` names `module`'s own library with a hot reload's suffix. That
 * library is the code as it was compiled in the editor, which the Source may no longer match, so a
 * Mac builds the module before it opens the project. A link, an oversized or malformed file, or any
 * other library reads as not loaded.
 */
export async function hotLibraryLoaded(projectFile: string, module: string): Promise<boolean> {
  if (!isProjectPath(projectFile) || !isModuleName(module)) return false;
  const library = GAME_LIBRARY.exec((await macModuleLibrary(projectFile, module)) ?? "");
  return library?.[1] === module && library[2] !== undefined;
}

/**
 * Whether Unreal itself uses a name for a module: one Genex knows (compared without case), or a
 * folder of the installed engine's own modules when `engineDir` is given.
 */
export async function isEngineModule(name: string, engineDir?: string): Promise<boolean> {
  if (ENGINE_MODULES.has(name.toLowerCase())) return true;
  if (engineDir === undefined) return false;
  for (const group of ENGINE_SOURCE_GROUPS)
    if ((await kindOf(path.join(engineDir, "Engine", "Source", group, name))) === PathKind.Folder) return true;
  return false;
}

/** Refuses a name Unreal itself uses: a known one, or a folder of the installed engine's own modules. */
async function assertFreeName(module: string, engineDir: string | undefined): Promise<void> {
  if (!isModuleName(module) || (await isEngineModule(module, engineDir)))
    throw refusal(CppModuleErrorCode.ReservedName, MESSAGE.ReservedName(module));
}

/** Whether the .uproject already declares the module; refuses one that declares any other. */
function declares(json: Record<string, unknown>, module: string): boolean {
  const modules = listOf(json[MODULES_KEY]);
  for (const entry of modules) {
    const name = isJsonObject(entry) ? entry.Name : undefined;
    if (name === module) continue;
    const other = typeof name === "string" && isModuleName(name) ? name : MESSAGE.AnotherModule;
    throw refusal(CppModuleErrorCode.DifferentModule, MESSAGE.DifferentModule(other));
  }
  return modules.length > 0;
}

function includeOrderFor(version: unknown): string {
  const match = typeof version === "string" ? ENGINE_VERSION.exec(version) : null;
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  const known = major === INCLUDE_ORDER.major && minor >= INCLUDE_ORDER.minor;
  return `Unreal${INCLUDE_ORDER.major}_${known ? minor : INCLUDE_ORDER.minor}`;
}

function vehiclesEnabled(json: Record<string, unknown>): boolean {
  return listOf(json[PLUGINS_KEY]).some((p) => isJsonObject(p) && p.Name === VEHICLE_PLUGIN && p.Enabled === true);
}

function targetText(module: string, kind: TargetKind, includeOrder: string): string {
  const target = `${kind === TargetKind.Editor ? `${module}${EDITOR_SUFFIX}` : module}Target`;
  return [
    "using UnrealBuildTool;",
    "using System.Collections.Generic;",
    "",
    `public class ${target} : TargetRules`,
    "{",
    `\tpublic ${target}(TargetInfo Target) : base(Target)`,
    "\t{",
    `\t\tType = TargetType.${kind};`,
    `\t\tDefaultBuildSettings = BuildSettingsVersion.${BUILD_SETTINGS};`,
    `\t\tIncludeOrderVersion = EngineIncludeOrderVersion.${includeOrder};`,
    `\t\tExtraModuleNames.Add("${module}");`,
    "\t}",
    "}",
    "",
  ].join("\n");
}

/** The module's rules; PublicIncludePaths lets part headers include each other from the module's folder. */
function buildText(module: string, dependencies: readonly string[]): string {
  return [
    "using UnrealBuildTool;",
    "",
    `public class ${module} : ModuleRules`,
    "{",
    `\tpublic ${module}(ReadOnlyTargetRules Target) : base(Target)`,
    "\t{",
    "\t\tPCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;",
    `\t\tPublicDependencyModuleNames.AddRange(new string[] { ${dependencies.map((d) => `"${d}"`).join(", ")} });`,
    "\t\tPublicIncludePaths.Add(ModuleDirectory);",
    "\t}",
    "}",
    "",
  ].join("\n");
}

/** The module's files, as Unreal lays a C++ project out. */
function moduleFiles(module: string, json: Record<string, unknown>, engineVersion: string | undefined): ModuleFile[] {
  const includeOrder = includeOrderFor(engineVersion ?? json.EngineAssociation);
  const dependencies = vehiclesEnabled(json) ? [...DEPENDENCIES, ...VEHICLE_DEPENDENCIES] : DEPENDENCIES;
  const folder = `${SOURCE_FOLDER}/${module}`;
  return [
    { relative: `${SOURCE_FOLDER}/${module}${TARGET_SUFFIX}`, text: targetText(module, TargetKind.Game, includeOrder) },
    {
      relative: `${SOURCE_FOLDER}/${module}${EDITOR_SUFFIX}${TARGET_SUFFIX}`,
      text: targetText(module, TargetKind.Editor, includeOrder),
    },
    { relative: `${folder}/${module}.Build.cs`, text: buildText(module, dependencies) },
    { relative: `${folder}/${module}.h`, text: '#pragma once\n\n#include "CoreMinimal.h"\n' },
    {
      relative: `${folder}/${module}.cpp`,
      text: `#include "${module}.h"\n#include "Modules/ModuleManager.h"\n\nIMPLEMENT_PRIMARY_GAME_MODULE(FDefaultGameModuleImpl, ${module}, "${module}");\n`,
    },
  ];
}

const onDisk = (root: string, relative: string) => path.join(root, ...relative.split("/"));

/** Refuses a Source folder holding another module: a folder or a target that isn't this module's, or a link. */
async function assertOnlyModule(source: string, module: string): Promise<void> {
  const targets = new Set([`${module}${TARGET_SUFFIX}`, `${module}${EDITOR_SUFFIX}${TARGET_SUFFIX}`]);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === module) continue;
    const what = `${SOURCE_FOLDER}/${entry.name}`;
    if (entry.isSymbolicLink()) throw refusal(CppModuleErrorCode.Link, MESSAGE.Link(what));
    const another = entry.isDirectory() || (entry.name.endsWith(TARGET_SUFFIX) && !targets.has(entry.name));
    if (another) throw refusal(CppModuleErrorCode.DifferentModule, MESSAGE.DifferentModule(entry.name));
  }
}

/** A folder Genex writes into: missing (to make), or a real folder that resolves to itself. */
async function checkFolder(root: string, relative: string): Promise<boolean> {
  const folder = onDisk(root, relative);
  const kind = await kindOf(folder);
  if (kind === PathKind.Missing) return false;
  if (kind === PathKind.Link) throw refusal(CppModuleErrorCode.Link, MESSAGE.Link(relative));
  if (kind !== PathKind.Folder) throw refusal(CppModuleErrorCode.PathTaken, MESSAGE.PathTaken(relative));
  if ((await realpath(folder)) !== folder) throw refusal(CppModuleErrorCode.Escapes, MESSAGE.Escapes(relative));
  return true;
}

/** The folders to make and the files to write; every refusal comes from here, before any write. */
async function planWrites(root: string, module: string, files: ModuleFile[]) {
  const folders: string[] = [];
  for (const relative of [SOURCE_FOLDER, `${SOURCE_FOLDER}/${module}`]) {
    if (!(await checkFolder(root, relative))) folders.push(onDisk(root, relative));
    else if (relative === SOURCE_FOLDER) await assertOnlyModule(onDisk(root, relative), module);
  }
  const missing: ModuleFile[] = [];
  for (const file of files) {
    const kind = await kindOf(onDisk(root, file.relative));
    if (kind === PathKind.Missing) missing.push(file);
    else if (kind === PathKind.Link) throw refusal(CppModuleErrorCode.Link, MESSAGE.Link(file.relative));
    else if (kind !== PathKind.File) throw refusal(CppModuleErrorCode.PathTaken, MESSAGE.PathTaken(file.relative));
  }
  return { folders, files: missing };
}

/** `json` with `key` placed before `before` (where Unreal writes Modules), or last without it. */
function insertBefore(json: Record<string, unknown>, before: string, key: string, value: unknown) {
  const entries = Object.entries(json);
  const at = entries.findIndex(([name]) => name === before);
  entries.splice(at === -1 ? entries.length : at, 0, [key, value]);
  return Object.fromEntries(entries);
}

/** The .uproject's text with the module declared, written the way the file was. */
function withModule(project: Project, module: string): string {
  const entry = { Name: module, Type: RUNTIME_TYPE, LoadingPhase: "Default" };
  const { json, format } = project;
  const modules = json[MODULES_KEY];
  const next = Array.isArray(modules)
    ? { ...json, [MODULES_KEY]: [...modules, entry] }
    : insertBefore(json, PLUGINS_KEY, MODULES_KEY, [entry]);
  const text = JSON.stringify(next, null, format.indent).replaceAll("\n", format.eol);
  return `${format.bom ? BOM : ""}${text}${format.trailingNewline ? format.eol : ""}`;
}

/** Every check {@link addCppModule} makes before it writes: the project read, its module's name and what to write. */
async function planModule(projectFile: string, options: AddCppModuleOptions) {
  const project = await readProject(projectFile);
  const module = moduleNameFor(project.file);
  await assertFreeName(module, options.engineDir);
  const declared = declares(project.json, module);
  const plan = await planWrites(project.root, module, moduleFiles(module, project.json, options.engineVersion));
  return { project, module, declared, plan };
}

/**
 * The module {@link addCppModule} would add, refusing as it would and writing nothing: a caller
 * checks before it quits Unreal for the module, so a project that can't take one keeps its editor.
 */
export async function checkCppModule(projectFile: string, options: AddCppModuleOptions = {}): Promise<string> {
  return (await planModule(projectFile, options)).module;
}

/**
 * Makes a Blueprint project a C++ project with the module {@link moduleNameFor} names: the module's
 * files (each only when missing) and its .uproject entry (only when undeclared). Refuses, writing
 * nothing, a project file that is a link or not a plain .uproject, one that doesn't read, a
 * project with another module, a name Unreal uses, and any path on the way that is a link, leads
 * elsewhere or is taken by something else. The caller restarts Unreal and builds afterwards.
 */
export async function addCppModule(projectFile: string, options: AddCppModuleOptions = {}): Promise<AddedCppModule> {
  const { project, module, declared, plan } = await planModule(projectFile, options);
  for (const folder of plan.folders) await mkdir(folder);
  // Exclusive creation: a file that appeared since the check, or a link planted there, is never written through.
  for (const file of plan.files) await writeFile(onDisk(project.root, file.relative), file.text, { flag: "wx" });
  if (!declared) await atomicWriteText(project.file, withModule(project, module));
  return { module, created: plan.files.map((f) => f.relative), declared: !declared };
}

/** The .uproject's text with the project plugin `name` enabled in its Plugins, written the way the file was. */
function withPlugin(project: Project, name: string): string {
  const { json, format } = project;
  const listed = listOf(json[PLUGINS_KEY]);
  const named = (entry: unknown): entry is Record<string, unknown> => isJsonObject(entry) && entry.Name === name;
  const plugins = listed.some(named)
    ? listed.map((entry) => (named(entry) ? { ...entry, Enabled: true } : entry))
    : [...listed, { Name: name, Enabled: true }];
  const next = { ...json, [PLUGINS_KEY]: plugins };
  const text = JSON.stringify(next, null, format.indent).replaceAll("\n", format.eol);
  return `${format.bom ? BOM : ""}${text}${format.trailingNewline ? format.eol : ""}`;
}

/**
 * Enables the project plugin `name` in the .uproject's Plugins (an entry there already is turned
 * on), atomically and keeping every other field and the file's indentation, as {@link addCppModule}
 * writes it. Refuses, writing nothing, a project file that is a link, isn't a plain .uproject or
 * doesn't read, and a name that isn't a module name. Answers whether the file changed.
 */
export async function enableProjectPlugin(projectFile: string, name: string): Promise<boolean> {
  if (!isModuleName(name)) throw refusal(CppModuleErrorCode.ReservedName, MESSAGE.ReservedName(name));
  const project = await readProject(projectFile);
  const listed = project.json[PLUGINS_KEY];
  if (listed !== undefined && !Array.isArray(listed))
    throw refusal(CppModuleErrorCode.Unreadable, MESSAGE.Unreadable(MESSAGE.PluginsNotList));
  const enabled = listOf(listed).some((entry) => isJsonObject(entry) && entry.Name === name && entry.Enabled === true);
  if (enabled) return false;
  await atomicWriteText(project.file, withPlugin(project, name));
  return true;
}

/**
 * An Unreal plugin inside a project, laid out the way Epic's New Plugin wizard lays one out
 * (PluginUtils::CreateAndLoadNewPlugin): the chosen template's folder under
 * `Engine/Plugins/Editor/PluginBrowser/Templates/` copied to the project's `Plugins/<Name>/`, every
 * `PLUGIN_NAME` in a file or folder name and in the text of its C++, C# and ini files replaced by the
 * plugin's name (any other file copied as its bytes), and the plugin's `<Name>.uplugin` written
 * beside it, tab-indented, with one module of the template's type. Genex offers three templates: an
 * editor window (Epic's Advanced), a toolbar button (Basic) and a blank runtime module (Blank).
 *
 * The project folder is the user's: every check comes before the first write (a name Unreal or the
 * engine already uses, a template folder that isn't the engine's own plain files, a plugin folder
 * already there, a link on the way), and each file is created exclusively, so nothing is written
 * through a link or over a file.
 */
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createFileInDir, ensureDirBelow } from "../../substrate/fsx.ts";
import { isEngineModule, isModuleName } from "./cpp-module.ts";
import { HELPER_FOLDER } from "./setup.ts";

/** The plugin templates Genex offers, by the names a `new-plugin` call gives. Wire values: never rename one. */
export const PluginTemplate = { Window: "window", ToolbarButton: "toolbar-button", Blank: "blank" } as const;
export type PluginTemplate = (typeof PluginTemplate)[keyof typeof PluginTemplate];

/** The module type a .uplugin names. An editor plugin's module uses UnrealEd and ToolMenus. */
const ModuleType = { Editor: "Editor", Runtime: "Runtime" } as const;
type ModuleType = (typeof ModuleType)[keyof typeof ModuleType];

/** Each template's folder in the engine and the type of the module it holds (read from its Build.cs). */
const TEMPLATES: Readonly<Record<PluginTemplate, { folder: string; type: ModuleType }>> = {
  [PluginTemplate.Window]: { folder: "Advanced", type: ModuleType.Editor },
  [PluginTemplate.ToolbarButton]: { folder: "Basic", type: ModuleType.Editor },
  [PluginTemplate.Blank]: { folder: "Blank", type: ModuleType.Runtime },
};
const TEMPLATE_NAMES: ReadonlySet<unknown> = new Set(Object.values(PluginTemplate));

/** Why Genex refused to make the plugin; nothing was written. */
export const PluginScaffoldErrorCode = {
  BadName: "bad-name",
  NameTaken: "name-taken",
  BadTemplate: "bad-template",
  TemplateUnreadable: "template-unreadable",
  PathTaken: "path-taken",
  Link: "link",
} as const;
export type PluginScaffoldErrorCode = (typeof PluginScaffoldErrorCode)[keyof typeof PluginScaffoldErrorCode];

/** A refusal with a code for the caller and a message it can show as it is. */
export class PluginScaffoldError extends Error {
  readonly code: PluginScaffoldErrorCode;
  constructor(code: PluginScaffoldErrorCode, message: string) {
    super(message);
    this.name = "PluginScaffoldError";
    this.code = code;
  }
}

/** The longest plugin name: its host project is `<Name>Host`, and a project's name is at most 20 characters. */
export const PLUGIN_NAME_MAX = 16;
const PLUGIN_NAME = new RegExp(`^[A-Za-z][A-Za-z0-9_]{0,${PLUGIN_NAME_MAX - 1}}$`);
/** Where an engine keeps the New Plugin wizard's templates. */
const TEMPLATES_FOLDER = ["Engine", "Plugins", "Editor", "PluginBrowser", "Templates"] as const;
/** Where an engine keeps its own plugins, and how deep a plugin folder lies in it at most. */
const ENGINE_PLUGINS = ["Engine", "Plugins"] as const;
const ENGINE_PLUGIN_DEPTH = 5;
/** What the wizard replaces in names and text, and in which files' text. */
const PLACEHOLDER = "PLUGIN_NAME";
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([".cpp", ".h", ".cs", ".ini"]);
/** A template is a few small files. */
const MAX_TEMPLATE_FILES = 64;
const MAX_TEMPLATE_FILE_BYTES = 1024 * 1024;
const PLUGINS_FOLDER = "Plugins";
const DESCRIPTOR_EXTENSION = ".uplugin";

const MESSAGE = {
  BadName: `A plugin's name is a letter, then letters, digits or underscores, at most ${PLUGIN_NAME_MAX} characters, and no C++ word.`,
  Helper: `${HELPER_FOLDER} is the Genex editor helper's name; pick another for your plugin.`,
  EngineName: (name: string) => `${name} is the name of one of Unreal's own modules or plugins; pick another.`,
  BadTemplate: `The template is one of ${[...TEMPLATE_NAMES].join(", ")}.`,
  TemplateUnreadable: (folder: string) =>
    `This Unreal has no ${folder} plugin template Genex can copy (its folder is missing, a link, or holds more than plain files).`,
  PathTaken: (what: string) => `${what} is already there, so Genex left the project as it is.`,
  Link: (what: string) => `${what} is a link or leads out of the project, so Genex won't write there.`,
} as const;

const refusal = (code: PluginScaffoldErrorCode, message: string) => new PluginScaffoldError(code, message);

/**
 * Whether a name can name a project plugin and its module: a letter, then letters, digits or
 * underscores (at most 16), a C++ module name (`isModuleName`), and not the Genex editor helper's.
 */
export function isPluginName(name: unknown): name is string {
  if (typeof name !== "string" || !PLUGIN_NAME.test(name) || !isModuleName(name)) return false;
  return name.toLowerCase() !== HELPER_FOLDER.toLowerCase();
}

/** Whether a value names one of the templates Genex offers. */
export const isPluginTemplate = (value: unknown): value is PluginTemplate => TEMPLATE_NAMES.has(value);

/** The names of the engine's own plugins (lowercase): each folder holding a .uplugin, to a few levels down. */
async function enginePluginNames(engineDir: string): Promise<Set<string>> {
  const names = new Set<string>();
  let level = [path.join(engineDir, ...ENGINE_PLUGINS)];
  for (let depth = 0; depth < ENGINE_PLUGIN_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const folder of level) {
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
      if (entries.some((entry) => entry.isFile() && entry.name.endsWith(DESCRIPTOR_EXTENSION))) {
        names.add(path.basename(folder).toLowerCase());
        continue;
      }
      for (const entry of entries) if (entry.isDirectory()) next.push(path.join(folder, entry.name));
    }
    level = next;
  }
  return names;
}

/**
 * Refuses a name a project plugin can't take, before anything is made: a malformed one, the Genex
 * editor helper's, or one the engine already uses for a module or a plugin of its own.
 */
export async function assertPluginName(name: unknown, engineDir: string): Promise<string> {
  if (typeof name === "string" && name.toLowerCase() === HELPER_FOLDER.toLowerCase())
    throw refusal(PluginScaffoldErrorCode.BadName, MESSAGE.Helper);
  if (!isPluginName(name)) throw refusal(PluginScaffoldErrorCode.BadName, MESSAGE.BadName);
  const taken = (await isEngineModule(name, engineDir)) || (await enginePluginNames(engineDir)).has(name.toLowerCase());
  if (taken) throw refusal(PluginScaffoldErrorCode.NameTaken, MESSAGE.EngineName(name));
  return name;
}

/** One file of a template: its path inside the template (`/`-separated) and its bytes. */
type TemplateFile = { relative: string; bytes: Buffer };

/** A template read from the engine: its module type and its files. */
export type PluginTemplateFiles = { type: ModuleType; files: TemplateFile[] };

/** Every plain file under `root`, relative, within the caps; refuses a link or anything that isn't a file or folder. */
async function templateFiles(root: string, unreadable: () => PluginScaffoldError): Promise<TemplateFile[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => {
    throw unreadable();
  });
  const files: TemplateFile[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!entry.isFile() || files.length >= MAX_TEMPLATE_FILES) throw unreadable();
    const full = path.join(entry.parentPath, entry.name);
    if ((await lstat(full)).size > MAX_TEMPLATE_FILE_BYTES) throw unreadable();
    files.push({ relative: path.relative(root, full).split(path.sep).join("/"), bytes: await readFile(full) });
  }
  return files.sort((a, b) => (a.relative < b.relative ? -1 : 1));
}

/**
 * The template `template` names, read from the engine: its folder must be a real folder inside the
 * engine (no link on the way) holding at most 64 plain files of at most 1 MB each.
 */
export async function readPluginTemplate(engineDir: string, template: unknown): Promise<PluginTemplateFiles> {
  if (!isPluginTemplate(template)) throw refusal(PluginScaffoldErrorCode.BadTemplate, MESSAGE.BadTemplate);
  const { folder, type } = TEMPLATES[template];
  const unreadable = () => refusal(PluginScaffoldErrorCode.TemplateUnreadable, MESSAGE.TemplateUnreadable(folder));
  const engine = await realpath(engineDir).catch(() => {
    throw unreadable();
  });
  const root = path.join(engine, ...TEMPLATES_FOLDER, folder);
  if ((await realpath(root).catch(() => null)) !== root) throw unreadable();
  return { type, files: await templateFiles(root, unreadable) };
}

/** A plugin ready to write: the real project folder, whether `Plugins/` must be made, and every file. */
export type PluginPlan = {
  name: string;
  root: string;
  makePlugins: boolean;
  files: Array<{ relative: string; data: Buffer | string }>;
};

/** The file a template file becomes: `PLUGIN_NAME` replaced in its path and, for source and ini files, in its text. */
function renamed(file: TemplateFile, name: string): { relative: string; data: Buffer | string } {
  const relative = file.relative.replaceAll(PLACEHOLDER, name);
  if (!TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) return { relative, data: file.bytes };
  return { relative, data: file.bytes.toString("utf8").replaceAll(PLACEHOLDER, name) };
}

/** The `<Name>.uplugin` the wizard writes for a plugin with one module of `type`, tab-indented. */
export function pluginDescriptor(name: string, type: ModuleType): string {
  const descriptor = {
    FileVersion: 3,
    Version: 1,
    VersionName: "1.0",
    FriendlyName: name,
    Category: "Other",
    CanContainContent: true,
    EnabledByDefault: true,
    Installed: false,
    Modules: [{ Name: name, Type: type, LoadingPhase: "Default" }],
  };
  return `${JSON.stringify(descriptor, null, "\t")}\n`;
}

/** What is at a path, without following a link there. */
const PathKind = { Missing: "missing", Link: "link", Folder: "folder", Other: "other" } as const;
type PathKind = (typeof PathKind)[keyof typeof PathKind];

async function kindAt(target: string): Promise<PathKind> {
  const info = await lstat(target).catch(() => null);
  if (!info) return PathKind.Missing;
  if (info.isSymbolicLink()) return PathKind.Link;
  return info.isDirectory() ? PathKind.Folder : PathKind.Other;
}

/**
 * Every check before `writePlugin`: the project folder real, `Plugins/` missing or a real folder of
 * the project's own, `Plugins/<Name>` missing; the files are the template's, renamed, and the .uplugin.
 */
export async function planPlugin(projectDir: string, name: string, template: PluginTemplateFiles): Promise<PluginPlan> {
  if ((await kindAt(projectDir)) !== PathKind.Folder)
    throw refusal(PluginScaffoldErrorCode.Link, MESSAGE.Link("The project folder"));
  const root = await realpath(projectDir);
  const plugins = path.join(root, PLUGINS_FOLDER);
  const pluginsKind = await kindAt(plugins);
  if (pluginsKind === PathKind.Link) throw refusal(PluginScaffoldErrorCode.Link, MESSAGE.Link(PLUGINS_FOLDER));
  if (pluginsKind === PathKind.Other)
    throw refusal(PluginScaffoldErrorCode.PathTaken, MESSAGE.PathTaken(PLUGINS_FOLDER));
  const folder = `${PLUGINS_FOLDER}/${name}`;
  if ((await kindAt(path.join(plugins, name))) !== PathKind.Missing)
    throw refusal(PluginScaffoldErrorCode.PathTaken, MESSAGE.PathTaken(folder));
  const files = template.files.map((file) => renamed(file, name));
  files.push({ relative: `${name}${DESCRIPTOR_EXTENSION}`, data: pluginDescriptor(name, template.type) });
  return { name, root, makePlugins: pluginsKind === PathKind.Missing, files };
}

/**
 * Writes a planned plugin: `Plugins/` when missing, the plugin's folder (which must not exist yet),
 * each folder inside it made without following a link and each file created exclusively, so a
 * folder or file that appeared since the plan, or a link planted there, is never written through.
 * `between` runs once the plugin's folder is made: a test's planted link.
 */
export async function writePlugin(plan: PluginPlan, between?: (folder: string) => Promise<void>): Promise<string> {
  if (plan.makePlugins) await mkdir(path.join(plan.root, PLUGINS_FOLDER));
  // Every folder is made from the project's real folder, each step checked: a `Plugins/` or a
  // plugin folder swapped for a link since the plan is refused, never followed.
  const plugins = await ensureDirBelow(plan.root, [PLUGINS_FOLDER]);
  const folder = path.join(plugins, plan.name);
  await mkdir(folder);
  await between?.(folder);
  for (const file of plan.files) {
    const steps = file.relative.split("/");
    const name = steps.pop() ?? "";
    await createFileInDir(await ensureDirBelow(plan.root, [PLUGINS_FOLDER, plan.name, ...steps]), name, file.data);
  }
  return folder;
}

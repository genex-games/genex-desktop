/**
 * The gate between an agent and Unity's Pipeline commands. The editor connector carries every
 * command the editor lists by name, and agents may do in the editor what a person does there: add
 * and remove packages, build a player, switch the build target, run menu items. What never goes
 * through: commands that run C# text nobody keeps (`script eval`), ending the editor (`editor quit`,
 * `runtime quit`, or a menu item that quits or opens another project in it), widening Pipeline's
 * own authoring root, or its server in built players. `script run` stays: it runs a C# file of the
 * game's own folder, which the game's checkpoints keep, and is how a scene is built with code.
 *
 * A command is known by the exact name its editor's catalogue lists it under, and goes to the
 * editor under that name. Pipeline itself also runs a command by other spellings (its last word
 * alone, a dot for the space), and through 0.8 every command had a flat name: none of those is a
 * name of the catalogue an agent is shown, so none passes, and the commands agents never run are
 * refused under every name the package has given them.
 *
 * A file a command names must stay inside the game's folder by real path (the Unity project, and
 * beside it the game's own assets an import reads). Which parameters name files comes from the
 * editor's own catalogue: a text parameter with a file's name is one, while an object reference
 * (`ObjectRef`: an asset path, a GUID or a hierarchy path such as `/Player`) is resolved by Unity
 * inside the project and is not. A build names its output folder, which must be inside the game (Unity
 * would otherwise build into the person's last build folder, wherever that is), and a package added
 * from a folder (`file:`) is one inside the game. Every operation of a `batch` is held to the same rules.
 *
 * These are guardrails for the person's open editor, not a sandbox: code an agent writes into the
 * project compiles and runs in that editor, as it does when the person writes it.
 */
import path from "node:path";
import { isJsonObject, realpathNearest } from "../../substrate/fsx.ts";
import { isInside } from "../../substrate/paths.ts";
import { COMMAND_NAME, type PipelineCommand } from "./pipeline.ts";
import { canonicalCommand, EditorCommand } from "./pipeline-commands.ts";

/** Commands no agent runs, by every name Pipeline has listed them under. */
const DENIED_COMMANDS: ReadonlySet<string> = new Set([
  EditorCommand.Eval,
  "script eval_file",
  "editor quit",
  "runtime quit",
  "authoring set_root",
  "settings.runtime_pipeline set",
  // Their flat names through 0.8, and the last word alone, which later versions also run them by.
  "eval",
  "eval_file",
  "quit",
  "set_root",
  "set_authoring_root",
  "set_runtime_pipeline_settings",
  // What Pipeline called its package commands before 0.8, whose parameters the gate does not read.
  "add_package",
  "remove_package",
]);

/** Where a build goes, as 1.0 and earlier versions name it: without it, Unity builds into the person's last build folder. */
const BUILD_OUTPUTS = ["output-path", "outputPath"] as const;
/** The menu item a menu call runs, as `File/Save Project`. */
const MENU_PATH = "path";
/** A menu path's segment that ends the editor or opens another project in it, trailing dots aside. */
const EDITOR_ENDING_MENU = /^(quit|quit unity|exit|new project|open project|open recent)$/i;
/**
 * The package a `package add` names, as 1.0 and earlier versions name the parameter: a registry
 * name, a repository's URL, or `file:` and a folder.
 */
const PACKAGE_NAMES = ["name", "identifier"] as const;
/** A package from a folder or archive on disk, as Unity's manifest spells it. */
const LOCAL_PACKAGE = /^file:/i;
/** Any reach to a file on disk in a package's identifier, `git+file:` included. */
const NAMES_DISK = /file:/i;
/** The folder a `file:` package is relative to: the project's own Packages folder. */
const PACKAGES_FOLDER = "Packages";

/** The fields of a batch and of one of its operations. */
const BatchField = { Operations: "operations", Command: "command", Params: "params" } as const;
/** The most operations Pipeline takes in one batch. */
const MAX_BATCH_OPERATIONS = 200;
/** How a batch operation's value names an earlier operation's answer; `$$` is a literal `$`. */
const REFERENCE = "$";

/**
 * The parameters that name a file or folder on disk when the catalogue types them as text, as 1.0
 * spells them (`output-path`) and as earlier versions did (`save_path`, `outputPath`).
 */
const FILE_PARAMETERS: ReadonlySet<string> = new Set([
  "path",
  "paths",
  "save_path",
  "output",
  "output-path",
  "outputPath",
  "file",
  "filename",
  "assemblyDir",
  "assembly-dir",
  "source",
  "destination",
  "scene_path",
  "scene-path",
  // 1.0's own: a build profile's folder, a search's folder, and a profiler capture read from disk.
  "folder",
  "search-in",
  "capture",
]);
/** The catalogue's types for text and for a list of it. */
const TEXT_TYPES: ReadonlySet<string> = new Set(["String", "String[]"]);

/** A control character: never part of a path a command may name. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const CONTROL = /[\0-\x1f\x7f]/;

/** Why the gate refused a call. Wire values: never rename one. */
export const GateRefusal = {
  NotACommand: "not-a-command",
  NotParameters: "not-parameters",
  Denied: "denied",
  PathOutside: "path-outside",
} as const;
export type GateRefusal = (typeof GateRefusal)[keyof typeof GateRefusal];

/** Where a call's files may be: the Unity project relative paths start from, inside the game's folder. Real paths. */
export interface GatePlace {
  root: string;
  game: string;
}

/**
 * A refused call: why, with the parameter that named a file outside the game, or the command agents
 * never run (in a batch, the operation's).
 */
export type GateRefused = { ok: false; refusal: GateRefusal; parameter?: string; command?: string };
/** A call that passed, as it goes to the editor, or why it does not. */
export type GateAnswer = { ok: true; command: string; parameters: Record<string, unknown> } | GateRefused;

const refused = (refusal: GateRefusal, named: Pick<GateRefused, "parameter" | "command"> = {}): GateRefused => ({
  ok: false,
  refusal,
  ...named,
});

/** Whether an agent may run the command the editor lists under `name`. */
export function commandAllowed(name: string): boolean {
  return !DENIED_COMMANDS.has(name.toLowerCase());
}

/** Whether a batch value stands for an earlier operation's answer, which no check can read ahead of time. */
const isReference = (value: string): boolean => value.startsWith(REFERENCE) && !value.startsWith(REFERENCE.repeat(2));

/** Whether `spelled`, relative to `from`, lies in the game's folder once every link on the way is resolved. */
async function realInside(at: GatePlace, from: string, spelled: string): Promise<boolean> {
  // Unity reads a backslash as a separator on every platform.
  const real = await realpathNearest(path.resolve(from, spelled.replaceAll("\\", "/"))).catch(() => undefined);
  return real !== undefined && isInside(at.game, real);
}

/** Whether a file a command names lies in the game's folder once every link on the way is resolved. */
async function staysInside(at: GatePlace, value: unknown, inBatch: boolean): Promise<boolean> {
  if (typeof value !== "string" || !value || CONTROL.test(value)) return false;
  if (inBatch && isReference(value)) return false;
  return realInside(at, at.root, value);
}

/** Whether a menu path runs an item that ends the editor or opens another project in it. */
function endsEditor(item: unknown): boolean {
  if (typeof item !== "string") return false;
  return item.split("/").some((segment) => EDITOR_ENDING_MENU.test(segment.trim().replace(/\.+$/, "")));
}

/**
 * Whether a package's identifier leaves the game's files alone outside its folder: a registry name or
 * a repository's URL, or a `file:` folder inside the game (relative to the project's Packages folder).
 */
async function packageStaysInside(at: GatePlace, identifier: unknown, inBatch: boolean): Promise<boolean> {
  if (typeof identifier !== "string" || CONTROL.test(identifier)) return false;
  if (inBatch && isReference(identifier)) return false;
  const local = LOCAL_PACKAGE.exec(identifier);
  if (!local) return !NAMES_DISK.test(identifier);
  const folder = identifier.slice(local[0].length);
  return folder !== "" && realInside(at, path.join(at.root, PACKAGES_FOLDER), folder);
}

/** Which of a parameter's names over the versions this editor's catalogue lists; the current one when it lists none. */
const listedName = (listed: PipelineCommand, spellings: readonly string[]): string =>
  spellings.find((name) => listed.parameters.some((parameter) => parameter.name === name)) ?? String(spellings[0]);

/** The parameter of a package add that reaches outside the game, if one does: the one the editor reads, and any other spelling given. */
async function packageOutside(
  at: GatePlace,
  listed: PipelineCommand,
  parameters: Record<string, unknown>,
  inBatch: boolean,
): Promise<string | undefined> {
  const read = listedName(listed, PACKAGE_NAMES);
  const given = PACKAGE_NAMES.filter((name) => name === read || parameters[name] !== undefined);
  for (const name of given) {
    if (!(await packageStaysInside(at, parameters[name], inBatch))) return name;
  }
  return undefined;
}

/** Why a call of a command the gate reads more closely does not go through, if it does not. */
async function closerLookRefused(
  at: GatePlace,
  listed: PipelineCommand,
  parameters: Record<string, unknown>,
  inBatch: boolean,
): Promise<GateRefused | undefined> {
  const command = listed.name;
  const known = canonicalCommand(command);
  if (known === EditorCommand.Menu && endsEditor(parameters[MENU_PATH]))
    return refused(GateRefusal.Denied, { command });
  if (known === EditorCommand.Build && BUILD_OUTPUTS.every((name) => parameters[name] === undefined))
    return refused(GateRefusal.PathOutside, { parameter: listedName(listed, BUILD_OUTPUTS) });
  if (known !== EditorCommand.PackageAdd) return undefined;
  const parameter = await packageOutside(at, listed, parameters, inBatch);
  return parameter ? refused(GateRefusal.PathOutside, { parameter }) : undefined;
}

/** Whether the editor reads the parameter `key` of `listed` as a file's name: text, or one it does not list. */
function namesFile(listed: PipelineCommand, key: string): boolean {
  if (!FILE_PARAMETERS.has(key)) return false;
  const type = listed.parameters.find((parameter) => parameter.name === key)?.type;
  return type === undefined || TEXT_TYPES.has(type);
}

/** The first parameter of a call that names a file outside the game, if any does. */
async function fileOutside(
  at: GatePlace,
  listed: PipelineCommand,
  parameters: Record<string, unknown>,
  inBatch: boolean,
): Promise<string | undefined> {
  for (const [key, value] of Object.entries(parameters)) {
    if (!namesFile(listed, key)) continue;
    for (const file of Array.isArray(value) ? value : [value]) {
      if (!(await staysInside(at, file, inBatch))) return key;
    }
  }
  return undefined;
}

/** Checks one command: its name, that the editor has it and agents may run it, its parameters and their files. */
async function gateOne(
  at: GatePlace,
  catalogue: readonly PipelineCommand[],
  command: unknown,
  parameters: unknown,
  inBatch = false,
): Promise<GateAnswer> {
  if (typeof command !== "string" || !COMMAND_NAME.test(command)) return refused(GateRefusal.NotACommand);
  if (!commandAllowed(command)) return refused(GateRefusal.Denied, { command });
  const listed = catalogue.find((entry) => entry.name === command);
  if (!listed) return refused(GateRefusal.NotACommand);
  if (parameters !== undefined && !isJsonObject(parameters)) return refused(GateRefusal.NotParameters);
  const given = parameters ?? {};
  const parameter = await fileOutside(at, listed, given, inBatch);
  if (parameter) return refused(GateRefusal.PathOutside, { parameter });
  return (await closerLookRefused(at, listed, given, inBatch)) ?? { ok: true, command, parameters: given };
}

/** An operation's parameters: none, an object, or JSON text of one; `null` for anything else. */
function operationParams(params: unknown): Record<string, unknown> | undefined | null {
  if (params === undefined) return undefined;
  if (isJsonObject(params)) return params;
  if (typeof params !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(params);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Why a batch does not go through, if one of its operations would not on its own. */
async function batchRefused(
  at: GatePlace,
  catalogue: readonly PipelineCommand[],
  parameters: Record<string, unknown>,
): Promise<GateRefused | undefined> {
  const operations = parameters[BatchField.Operations];
  if (!Array.isArray(operations) || operations.length > MAX_BATCH_OPERATIONS) return refused(GateRefusal.NotParameters);
  for (const operation of operations) {
    if (!isJsonObject(operation)) return refused(GateRefusal.NotParameters);
    const nested = operation[BatchField.Command];
    if (typeof nested === "string" && canonicalCommand(nested) === EditorCommand.Batch)
      return refused(GateRefusal.Denied, { command: nested });
    const params = operationParams(operation[BatchField.Params]);
    if (params === null) return refused(GateRefusal.NotParameters);
    const answer = await gateOne(at, catalogue, operation[BatchField.Command], params, true);
    if (!answer.ok) return answer;
  }
  return undefined;
}

/**
 * Checks one call against the editor's catalogue for the game at `at`: the command's name, that
 * agents may run it, its parameters' shape and every file they name; for a batch, each operation.
 */
export async function gateCall(
  at: GatePlace,
  catalogue: readonly PipelineCommand[],
  command: unknown,
  parameters: unknown,
): Promise<GateAnswer> {
  const call = await gateOne(at, catalogue, command, parameters);
  if (!call.ok || canonicalCommand(call.command) !== EditorCommand.Batch) return call;
  return (await batchRefused(at, catalogue, call.parameters)) ?? call;
}

/**
 * The Pipeline commands Genex knows by name, in the two spellings Unity's package has had. Since
 * 0.9 a command is a group and a name (`scene save`, `editor.playmode stop`), and that is what
 * 1.0.0, the version Genex asks for, lists and runs; through 0.8 each was one flat word
 * (`save_scene`, `editor_stop`). A project still on 0.8 keeps working: Genex's own calls are spelled
 * the old way for its editor ({@link spelledFor}), and a name an agent took from that editor's
 * catalogue is read as the command it is ({@link canonicalCommand}).
 *
 * Measured on Unity 6000.6.0f1 with Pipeline 0.8.0-exp.1, 0.9.0-exp.1 and 1.0.0 (2026-11-19): the
 * old names are refused from 0.9 on, 1.0.0 gives no hint of the new one, and what a command
 * answers changed with them (`scene list_open` a bare list, `script eval` the bare value).
 */
import { isJsonObject } from "../../substrate/fsx.ts";

/** The commands Genex itself runs or reads closely. Wire values: Pipeline's own since 0.9. */
export const EditorCommand = {
  Batch: "job batch",
  Eval: "script eval",
  ListOpenScenes: "scene list_open",
  SaveScene: "scene save",
  SaveAll: "editor save_all",
  CreateScene: "scene create",
  SetAutoTick: "editor set_auto_tick",
  Play: "editor.playmode start",
  Stop: "editor.playmode stop",
  Pause: "editor.playmode pause",
  Capture: "capture game_view",
  Build: "build run",
  Menu: "editor invoke_menu",
  PackageAdd: "package add",
} as const;
export type EditorCommand = (typeof EditorCommand)[keyof typeof EditorCommand];

/** What Pipeline called each of them through 0.8. Wire values: Pipeline's own. */
const FLAT_NAME = {
  [EditorCommand.Batch]: "batch",
  [EditorCommand.Eval]: "eval",
  [EditorCommand.ListOpenScenes]: "list_open_scenes",
  [EditorCommand.SaveScene]: "save_scene",
  [EditorCommand.SaveAll]: "save_all",
  [EditorCommand.CreateScene]: "create_scene",
  [EditorCommand.SetAutoTick]: "set_autotick",
  [EditorCommand.Play]: "editor_play",
  [EditorCommand.Stop]: "editor_stop",
  [EditorCommand.Pause]: "editor_pause",
  [EditorCommand.Capture]: "capture_game_view",
  [EditorCommand.Build]: "build",
  [EditorCommand.Menu]: "menu",
  [EditorCommand.PackageAdd]: "package_add",
} as const satisfies Record<EditorCommand, string>;

const GROUPED_NAME = new Map<string, EditorCommand>(
  Object.entries(FLAT_NAME).map(([grouped, flat]) => [flat, grouped as EditorCommand]),
);

/** The command a name stands for, whichever way its editor spells it; any other name is itself. */
export const canonicalCommand = (name: string): string => GROUPED_NAME.get(name) ?? name;

/** One of Genex's own commands as an editor spells it: grouped since 0.9, one flat word before. */
export const spelledFor = (command: string, grouped: boolean): string =>
  grouped ? command : (FLAT_NAME[command as EditorCommand] ?? command);

/** A value C# handed back from `script eval`, or the editor's words for why it handed none. */
export type Evaluated = { ok: true; value: unknown } | { ok: false; detail: string };

/** Whether an eval's answer is the envelope Pipeline wrapped a value in before 1.0. */
const isEnvelope = (result: unknown): result is Record<string, unknown> =>
  isJsonObject(result) && Array.isArray(result.diagnostics) && typeof result.success === "boolean";

/**
 * What an eval that the editor ran came to. 1.0.0 answers the value itself and fails the request
 * when the code does not compile or throws; before it the value came inside
 * `{ output, diagnostics, success, result }`, whose own `success` was the one that said so.
 */
export function evaluated(result: unknown): Evaluated {
  if (!isEnvelope(result)) return { ok: true, value: result };
  if (result.success) return { ok: true, value: result.result };
  return { ok: false, detail: typeof result.error === "string" ? result.error : "" };
}

/** The open scenes in a `scene list_open` answer: the list itself since 1.0, under `scenes` before. */
export function listedScenes(result: unknown): Record<string, unknown>[] {
  const listed = isJsonObject(result) ? result.scenes : result;
  return Array.isArray(listed) ? listed.filter(isJsonObject) : [];
}

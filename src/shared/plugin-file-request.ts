/**
 * A plugin panel's Choose file request, `studioPlugin.chooseFile({ title, extensions })`: the one
 * native picker a sandboxed panel may ask Studio for. The panel host reads it before it leaves the
 * renderer and main reads it again before the dialog opens, both with {@link readPluginFileRequest},
 * so neither side trusts the other's copy. Mirrors `PluginFileRequest` in `src/plugin-sdk/index.d.ts`.
 */

/** The longest title a panel may give its picker. */
export const PLUGIN_FILE_TITLE_MAX_CHARS = 80;
/** How many file types one picker may offer. */
export const PLUGIN_FILE_EXTENSIONS_MAX = 4;
/** One extension: lowercase letters and digits, without the dot. */
const EXTENSION_PATTERN = /^[a-z0-9]{1,10}$/;
/** Control, line-break and direction-override characters: a title stays one plain line that reads as written. */
const UNSAFE_TITLE_CHARS = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
/** The only fields a request has; anything else (a start folder, several files) is refused. */
const REQUEST_FIELDS: ReadonlySet<string> = new Set(["title", "extensions"]);

/** What a panel asks Studio's file picker for. */
export interface PluginFileRequest {
  /** 1–80 characters on one line; Studio shows it after the plugin's name. */
  title: string;
  /** 1–4 different extensions without the dot: lowercase letters and digits, at most 10 each. */
  extensions: string[];
}

/** Why a Choose file request is refused. */
export const PluginFileProblem = {
  NotAnObject: "not-an-object",
  UnknownField: "unknown-field",
  BadTitle: "bad-title",
  BadExtensions: "bad-extensions",
} as const;
export type PluginFileProblem = (typeof PluginFileProblem)[keyof typeof PluginFileProblem];

/** What the panel is told about each refusal. */
const MESSAGE = {
  [PluginFileProblem.NotAnObject]: "Choose file takes { title, extensions }",
  [PluginFileProblem.UnknownField]: "Choose file takes only a title and extensions",
  [PluginFileProblem.BadTitle]: `Choose file needs a title of 1 to ${PLUGIN_FILE_TITLE_MAX_CHARS} characters on one line`,
  [PluginFileProblem.BadExtensions]: `Choose file needs 1 to ${PLUGIN_FILE_EXTENSIONS_MAX} different extensions of lowercase letters and digits, without the dot`,
} as const satisfies Record<PluginFileProblem, string>;

/** A title the picker may show: trimmed, then 1–80 characters with nothing that breaks or reverses the line. */
function pickerTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim();
  const fits = title.length > 0 && title.length <= PLUGIN_FILE_TITLE_MAX_CHARS;
  return fits && !UNSAFE_TITLE_CHARS.test(title) ? title : null;
}

const isExtension = (value: unknown): value is string => typeof value === "string" && EXTENSION_PATTERN.test(value);

/** The listed extensions as a new dense array, or null when the list breaks a rule. */
function pickerExtensions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  // Array.from fills holes with undefined, which the extension check below then refuses.
  const extensions: unknown[] = Array.from(value);
  const counted = extensions.length > 0 && extensions.length <= PLUGIN_FILE_EXTENSIONS_MAX;
  if (!counted || new Set(extensions).size !== extensions.length) return null;
  return extensions.every(isExtension) ? extensions : null;
}

/** A request read from untrusted input: a fresh copy of its title and extensions, or why it is refused. */
export function readPluginFileRequest(value: unknown): { request: PluginFileRequest } | { problem: PluginFileProblem } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { problem: PluginFileProblem.NotAnObject };
  if (Object.keys(value).some((key) => !REQUEST_FIELDS.has(key))) return { problem: PluginFileProblem.UnknownField };
  const title = pickerTitle("title" in value ? value.title : undefined);
  if (title === null) return { problem: PluginFileProblem.BadTitle };
  const extensions = pickerExtensions("extensions" in value ? value.extensions : undefined);
  if (extensions === null) return { problem: PluginFileProblem.BadExtensions };
  return { request: { title, extensions } };
}

/** The request, or an error saying what is wrong with it. Nothing else from `value` is kept. */
export function pluginFileRequest(value: unknown): PluginFileRequest {
  const read = readPluginFileRequest(value);
  if ("problem" in read) throw new Error(MESSAGE[read.problem]);
  return read.request;
}

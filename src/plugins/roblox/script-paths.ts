/**
 * Where each of a place's scripts lives as a file under the game's `src/`: the two-way mapping
 * between a script as Studio holds it ({@link ScriptRef}: instance names from its service down,
 * class and run context) and a `/`-separated path below `src/`, in Rojo's names.
 *
 * - `Round.server.luau` is a Script (legacy run context), `Input.client.luau` a LocalScript,
 *   `Inventory.luau` a ModuleScript, `Tool.plugin.luau` a Script whose run context is Plugin, and
 *   `.runcontext-server.luau` / `.runcontext-client.luau` a Script whose run context is Server or
 *   Client (Rojo has no name for those in its default mode). Folders on the way are the instances
 *   on the way; a script with scripts below it is a folder holding `init.<kind>.luau`.
 * - An instance name may hold anything. What a file name can't hold on Windows, macOS or Linux is
 *   escaped as `%XX` per UTF-8 byte: `%` itself, separators, `: * ? " < > |`, control characters,
 *   trailing dots and spaces, the first letter of a Windows device name (`CON`, `COM1` …), the dot
 *   before an ending that would read as a script kind (`Main.server` as a ModuleScript's name), and
 *   the first letter of a script named `init`. Every name has one spelling: a file whose name
 *   decodes but isn't spelled that way (`%41`, `a%2e`) is no script of the game's.
 * - A name past {@link MAX_SCRIPT_NAME_CHARS}, or whose file name would pass 255 bytes, or that
 *   isn't well-formed text, has no file: it is refused, never shortened.
 * - Two scripts whose files differ only in letter case (or Unicode composition) can't both exist on
 *   macOS or Windows; {@link layoutScripts} keeps the first and refuses the other.
 */
import { RunContext, SCRIPT_SERVICES, ScriptClass, type ScriptRef } from "./helper-protocol.ts";

/** The game folder's script root. */
export const SCRIPTS_FOLDER = "src";
/** Every script file's ending. */
export const SCRIPT_EXTENSION = ".luau";
/** The longest instance name a script's file carries. */
export const MAX_SCRIPT_NAME_CHARS = 200;
/** The longest file or folder name most file systems keep, in UTF-8 bytes. */
const MAX_FILE_NAME_BYTES = 255;
/** The deepest script path the helper carries. */
const MAX_SCRIPT_DEPTH = 64;
/** The name of a script that has scripts below it, inside its own folder. */
const CONTAINER_NAME = "init";

/** A script kind's file name ending before `.luau`, longest first, and what it reads as. */
const KINDS: ReadonlyArray<{ marker: string; class: ScriptClass; runContext?: RunContext }> = [
  { marker: ".runcontext-server", class: ScriptClass.Script, runContext: RunContext.Server },
  { marker: ".runcontext-client", class: ScriptClass.Script, runContext: RunContext.Client },
  { marker: ".server", class: ScriptClass.Script, runContext: RunContext.Legacy },
  { marker: ".client", class: ScriptClass.LocalScript },
  { marker: ".plugin", class: ScriptClass.Script, runContext: RunContext.Plugin },
  { marker: "", class: ScriptClass.ModuleScript },
];
const LONGEST_ENDING = Math.max(...KINDS.map((kind) => kind.marker.length)) + SCRIPT_EXTENSION.length;
/** Endings a name may not keep raw: they would read as a script kind or a script file. */
const RESERVED_ENDINGS = [...KINDS.map((kind) => kind.marker).filter(Boolean), SCRIPT_EXTENSION];
/** What is never written raw in a name: the escape itself, separators, Windows' refused characters, controls. */
const ESCAPED = /[%/\\:*?"<>|\u0000-\u001f\u007f]/u;
/** A Windows device name: the name before its first dot (spaces trimmed) is the device. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/i;
const ESCAPE = /%([0-9A-F]{2})/g;
const ANY_ESCAPE = /%/;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
/** Half of a surrogate pair standing alone: with the `u` flag a whole pair is one code point and never matches. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

const escapeChar = (char: string) =>
  [...Buffer.from(char, "utf8")].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");

/** `chars` with the character at `index` escaped. */
function escapeAt(chars: string[], index: number): void {
  const char = chars[index];
  if (char !== undefined && !char.startsWith("%")) chars[index] = escapeChar(char);
}

/**
 * The one spelling of an instance name inside a file name, or undefined when the name has none:
 * empty, past {@link MAX_SCRIPT_NAME_CHARS}, not well-formed text, or too long once escaped.
 */
export function encodeName(name: string): string | undefined {
  if (name.length === 0 || name.length > MAX_SCRIPT_NAME_CHARS || LONE_SURROGATE.test(name)) return undefined;
  const chars = [...name].map((char) => (ESCAPED.test(char) ? escapeChar(char) : char));
  for (let index = chars.length - 1; index >= 0 && (chars[index] === "." || chars[index] === " "); index--)
    escapeAt(chars, index);
  const raw = chars.join("");
  if (WINDOWS_DEVICE.test(raw) || raw === CONTAINER_NAME) escapeAt(chars, 0);
  const ending = RESERVED_ENDINGS.find((end) => chars.join("").endsWith(end));
  // The dot that starts the ending is one character: the ending's own length back from the end.
  if (ending) escapeAt(chars, chars.length - [...ending].length);
  const encoded = chars.join("");
  return Buffer.byteLength(encoded, "utf8") + LONGEST_ENDING <= MAX_FILE_NAME_BYTES ? encoded : undefined;
}

/** The instance name a file or folder name spells, or undefined when it isn't that name's one spelling. */
export function decodeName(segment: string): string | undefined {
  if (segment.length === 0) return undefined;
  let decoded: string;
  if (ANY_ESCAPE.test(segment)) {
    const parts = segment.split(ESCAPE);
    // split with a capture group alternates text and the captured hex digits.
    const bytes: number[] = [];
    for (const [index, part] of parts.entries()) {
      if (index % 2 === 1) bytes.push(Number.parseInt(part, 16));
      else if (part.includes("%")) return undefined;
      else bytes.push(...Buffer.from(part, "utf8"));
    }
    try {
      decoded = STRICT_UTF8.decode(Uint8Array.from(bytes));
    } catch {
      return undefined;
    }
  } else decoded = segment;
  return encodeName(decoded) === segment ? decoded : undefined;
}

/** A script's identity: class, run context and names, as one string. */
export const scriptKey = (ref: ScriptRef): string => JSON.stringify([ref.class, ref.runContext ?? "", ...ref.path]);

const kindOf = (ref: ScriptRef) => KINDS.find((kind) => kind.class === ref.class && kind.runContext === ref.runContext);

/** How a file under `src/` is placed: `container` puts the script in its own folder as `init`. */
export interface ScriptFileOptions {
  container?: boolean;
}

/**
 * The file below `src/` that holds `ref`, or undefined when one of its names has no file name
 * (see {@link encodeName}) or the reference isn't a script the helper keeps.
 */
export function scriptFile(ref: ScriptRef, options: ScriptFileOptions = {}): string | undefined {
  const kind = kindOf(ref);
  const [service, ...names] = ref.path;
  const known = (SCRIPT_SERVICES as readonly string[]).includes(service ?? "");
  if (!kind || !known || names.length === 0 || ref.path.length > MAX_SCRIPT_DEPTH) return undefined;
  const encoded = names.map(encodeName);
  if (encoded.some((name) => name === undefined)) return undefined;
  const segments = [service, ...encoded] as string[];
  const last = segments.pop() as string;
  const leaf = options.container
    ? `${last}/${CONTAINER_NAME}${kind.marker}${SCRIPT_EXTENSION}`
    : `${last}${kind.marker}${SCRIPT_EXTENSION}`;
  return [...segments, leaf].join("/");
}

/** The script a file below `src/` holds, or undefined when it holds none of the game's scripts. */
export function scriptRefOf(file: string): ScriptRef | undefined {
  const segments = file.split("/");
  const leaf = segments.pop();
  const [service, ...folders] = segments;
  if (!leaf?.endsWith(SCRIPT_EXTENSION) || !(SCRIPT_SERVICES as readonly string[]).includes(service ?? ""))
    return undefined;
  const stem = leaf.slice(0, -SCRIPT_EXTENSION.length);
  const kind = KINDS.find((entry) => stem.endsWith(entry.marker)) as (typeof KINDS)[number];
  const name = stem.slice(0, stem.length - kind.marker.length);
  const container = name === CONTAINER_NAME;
  const encoded = container ? folders : [...folders, name];
  const names = encoded.map(decodeName);
  if (names.length === 0 || names.some((each) => each === undefined)) return undefined;
  const path = [service as string, ...(names as string[])];
  if (path.length > MAX_SCRIPT_DEPTH) return undefined;
  return kind.runContext ? { path, class: kind.class, runContext: kind.runContext } : { path, class: kind.class };
}

/** How macOS and Windows compare names by default: letter case and Unicode composition aside. */
const fold = (text: string) => text.normalize("NFC").toLowerCase();

/** Where each script goes, and the scripts that get no file. */
export interface ScriptLayout {
  /** By {@link scriptKey}: the file below `src/`. */
  files: Map<string, string>;
  /** Scripts with no file: a name with none, another script of the same name, or a case clash. */
  refused: ScriptRef[];
}

/** The names taken so far, folded: each folder and file with its exact spelling. */
type Taken = Map<string, { exact: string; folder: boolean }>;

/** Takes `file` and the folders on its way, unless one of them clashes with what is taken. */
function take(taken: Taken, file: string): boolean {
  const segments = file.split("/");
  const steps = segments.map((_segment, index) => ({
    path: segments.slice(0, index + 1).join("/"),
    folder: index < segments.length - 1,
  }));
  const clash = steps.some((step) => {
    const held = taken.get(fold(step.path));
    return held !== undefined && (held.exact !== step.path || !held.folder || !step.folder);
  });
  if (clash) return false;
  for (const step of steps) taken.set(fold(step.path), { exact: step.path, folder: step.folder });
  return true;
}

/** Every instance path that has a script below it, each as its names in JSON. */
function holders(refs: readonly ScriptRef[]): Set<string> {
  const held = new Set<string>();
  for (const ref of refs)
    for (let end = 1; end < ref.path.length; end++) held.add(JSON.stringify(ref.path.slice(0, end)));
  return held;
}

/** Code-unit order: the same on every computer, unlike a locale's. */
function byFile(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Each file already on disk, by its script's key: the first of two for one script keeps it. */
function placeFixed(taken: Taken, fixed: readonly string[]): Map<string, string> {
  const onDisk = new Map<string, string>();
  for (const file of [...fixed].sort(byFile)) {
    const ref = scriptRefOf(file);
    if (ref && !onDisk.has(scriptKey(ref)) && take(taken, file)) onDisk.set(scriptKey(ref), file);
  }
  return onDisk;
}

/** How many of `refs` share each key. */
function keyCounts(refs: readonly ScriptRef[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ref of refs) counts.set(scriptKey(ref), (counts.get(scriptKey(ref)) ?? 0) + 1);
  return counts;
}

/**
 * The files for `refs`, beside the files already on disk (`fixed`, below `src/`), which stay
 * where they are: a script already in a file keeps it. A new script with scripts below it goes in
 * its own folder as `init`. Two scripts of one name, or a file or folder that differs only in
 * letter case from one already taken, get no file.
 */
export function layoutScripts(fixed: readonly string[], refs: readonly ScriptRef[]): ScriptLayout {
  const taken: Taken = new Map();
  const files = new Map<string, string>();
  const refused: ScriptRef[] = [];
  const counts = keyCounts(refs);
  const onDisk = placeFixed(taken, fixed);
  const containers = holders(refs);
  const placed: Array<{ ref: ScriptRef; file: string | undefined }> = [];
  for (const ref of refs) {
    const key = scriptKey(ref);
    const file = onDisk.get(key);
    if ((counts.get(key) ?? 0) > 1) refused.push(ref);
    else if (file) files.set(key, file);
    else placed.push({ ref, file: scriptFile(ref, { container: containers.has(JSON.stringify(ref.path)) }) });
  }
  placed.sort((a, b) => byFile(a.file ?? "", b.file ?? ""));
  for (const { ref, file } of placed) {
    if (file && take(taken, file)) files.set(scriptKey(ref), file);
    else refused.push(ref);
  }
  return { files, refused };
}

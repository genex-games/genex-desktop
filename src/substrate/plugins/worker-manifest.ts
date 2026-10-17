/**
 * A plugin manifest's `workerTypes` and `folders` sections (API 3): the kinds of worker the plugin
 * declares (`shared/workers.ts`) and the folders outside the game its engine programs write to,
 * which become workers' write roots while the plugin is on. Checked here and kept in canonical
 * form. A folder is never a whole personal folder, a login, Genex's own data or anything holding
 * one: a manifest naming one is refused, whatever its reason says.
 */
import os from "node:os";
import path from "node:path";
import { isPluginId, PLUGIN_ID } from "../../shared/plugin-id.ts";
import { isAgentTool, type PluginFolder, type PluginManifest, type PluginWorkerType } from "../../shared/plugins.ts";
import { isWorkerIsolation, type WorkerType } from "../../shared/workers.ts";
import { HOME_SIGN_IN_STORES } from "../credential-homes.ts";

/** How much the sections may declare. */
const LIMIT = {
  Types: 16,
  Tools: 8,
  DescriptionChars: 200,
  Folders: 8,
  PathChars: 200,
  WhyChars: 120,
} as const;

/** A worker type's id: lowercase, starting with a letter, letters, digits, `_` and `-`, at most 40. */
const TYPE_ID = /^[a-z][a-z0-9_-]{0,39}$/;
/** What names another plugin's tools: `<plugin>__` for all of them, `<plugin>__<tool>` for one. */
const OTHER_PLUGIN_SEPARATOR = "__";
/** Glob characters: a folder is one folder, never a pattern. */
const GLOB = /[*?[\]{}]/;
/** Control characters, NUL included. */
const CONTROL = /\p{Cc}/u;
/** How a manifest spells the home folder. */
const HOME = "~";

/**
 * Folders inside the home folder that are never a write root themselves: the whole of a personal
 * folder (anything the person keeps is under it), case-folded segments.
 */
const WHOLE_FOLDERS: readonly (readonly string[])[] = [
  [],
  ["library"],
  ["library", "application support"],
  ["documents"],
  ["desktop"],
  ["downloads"],
];
/**
 * Folders inside the home folder a write root may neither be, sit inside nor hold: logins (the
 * coding CLIs' homes, Genex's own and the sign-in stores no agent reads) and Genex's own data (its
 * profile is `~/Library/Application Support/Genex`). Case-folded segments.
 */
const NEVER_TOUCH: readonly (readonly string[])[] = [
  [".claude"],
  [".codex"],
  [".genex"],
  ...HOME_SIGN_IN_STORES,
  ["library", "application support", "genex"],
].map((parts) => parts.map((part) => part.toLowerCase()));

/** The keys each entry may hold, in canonical order. */
const TYPE_KEYS = ["id", "description", "tools", "isolation"] as const;
const FOLDER_KEYS = ["path", "why"] as const;

/** What a publisher reads when a section is refused. */
const MESSAGE = {
  NeedsApi3: (section: string) => `${section} requires apiVersion 3`,
  NotList: (section: string, max: number) => `Invalid ${section} (a list of at most ${max} entries)`,
  InvalidType: (at: string) =>
    `Invalid workerTypes entry ${at} (id: lowercase letters, digits, _ and -, starting with a letter, at most 40; description: 1-${LIMIT.DescriptionChars} characters; isolation: read, copy or lock; only these keys)`,
  DuplicateType: (id: string) => `Invalid workerTypes: ${id} is declared twice`,
  InvalidTools: (id: string) =>
    `Invalid workerTypes ${id} tools (1-${LIMIT.Tools} distinct names: the plugin's own agent tools, or another plugin's as <plugin>__ or <plugin>__<tool>)`,
  InvalidFolder: (at: string) =>
    `Invalid folders entry ${at} (path: one folder starting with ~/ or /, at most ${LIMIT.PathChars} characters, no . or .. segment and no glob; why: 1-${LIMIT.WhyChars} characters; only these keys)`,
  RefusedFolder: (at: string) =>
    `Refused folders entry ${at}: a plugin may not write to a whole personal folder, a login, Genex's own data or a folder holding one`,
  DuplicateFolder: (at: string) => `Invalid folders: ${at} is declared twice`,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max;
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));
/** How an entry is named in a refusal: its id or path when it has one, else its place in the list. */
const nameOf = (entry: unknown, key: string, index: number): string => {
  const named = isRecord(entry) && typeof entry[key] === "string" ? String(entry[key]) : "";
  return named ? JSON.stringify(named) : `#${index + 1}`;
};

/** The section's list, refusing anything but a list of at most `max` on API 3. */
function sectionList(m: Pick<PluginManifest, "apiVersion">, section: string, raw: unknown, max: number): unknown[] {
  if (m.apiVersion !== 3) throw new Error(MESSAGE.NeedsApi3(section));
  if (!Array.isArray(raw) || raw.length > max) throw new Error(MESSAGE.NotList(section, max));
  return raw;
}

/** Whether `name` names another plugin's tools: `<plugin>__` or `<plugin>__<tool>`, never this plugin's. */
function isOtherPluginTool(name: string, ownId: string): boolean {
  const at = name.indexOf(OTHER_PLUGIN_SEPARATOR);
  const plugin = name.slice(0, at);
  const tool = name.slice(at + OTHER_PLUGIN_SEPARATOR.length);
  return at > 0 && isPluginId(plugin) && plugin !== ownId && (tool === "" || PLUGIN_ID.test(tool));
}

/** A worker type's tools, checked against the plugin's own agent tools. */
function typeTools(raw: unknown, id: string, m: Pick<PluginManifest, "id" | "tools">): string[] {
  const own = new Set(m.tools.filter(isAgentTool).map((tool) => tool.name));
  const valid =
    Array.isArray(raw) &&
    raw.length >= 1 &&
    raw.length <= LIMIT.Tools &&
    new Set(raw).size === raw.length &&
    raw.every(
      (name) =>
        typeof name === "string" &&
        (name.includes(OTHER_PLUGIN_SEPARATOR) ? isOtherPluginTool(name, m.id) : own.has(name)),
    );
  if (!valid) throw new Error(MESSAGE.InvalidTools(id));
  return [...(raw as string[])];
}

/** Whether `entry` is a worker type with only its keys and a valid id, description and isolation (its tools aside). */
function isTypeEntry(entry: unknown): entry is Omit<PluginWorkerType, "tools"> & { tools: unknown } {
  return (
    isRecord(entry) &&
    hasOnlyKeys(entry, TYPE_KEYS) &&
    typeof entry.id === "string" &&
    TYPE_ID.test(entry.id) &&
    isText(entry.description, LIMIT.DescriptionChars) &&
    isWorkerIsolation(entry.isolation)
  );
}

/** One worker type in canonical form. */
function workerType(entry: unknown, index: number, m: Pick<PluginManifest, "id" | "tools">): PluginWorkerType {
  if (!isTypeEntry(entry)) throw new Error(MESSAGE.InvalidType(nameOf(entry, "id", index)));
  const { id, description, isolation } = entry;
  return { id, description, tools: typeTools(entry.tools, id, m), isolation };
}

/**
 * The manifest's `workerTypes` in canonical form; throws on API 1 or 2 and on anything malformed.
 * `m.tools` must already be checked: a type names only the plugin's own agent tools by name.
 */
export function validateWorkerTypes(
  m: Pick<PluginManifest, "apiVersion" | "id" | "tools" | "workerTypes">,
): PluginWorkerType[] {
  const seen = new Set<string>();
  return sectionList(m, "workerTypes", m.workerTypes, LIMIT.Types).map((entry, index) => {
    const type = workerType(entry, index, m);
    if (seen.has(type.id)) throw new Error(MESSAGE.DuplicateType(type.id));
    seen.add(type.id);
    return type;
  });
}

/** Case-folded, composed segments, as a case-blind macOS disk compares names. */
const folded = (segments: readonly string[]): string[] => segments.map((s) => s.normalize("NFC").toLowerCase());
/** Whether `prefix` is `segments` or one of its parents. */
const startsWith = (segments: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= segments.length && prefix.every((segment, i) => segments[i] === segment);
const sameSegments = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && startsWith(a, b);

/** Whether the folder segments (inside the home folder) are a whole personal folder or reach a never-touch root. */
function refusedInHome(segments: readonly string[]): boolean {
  const at = folded(segments);
  if (WHOLE_FOLDERS.some((whole) => sameSegments(at, whole))) return true;
  return NEVER_TOUCH.some((root) => startsWith(at, root) || startsWith(root, at));
}

/**
 * Whether a folder may be a write root: inside the home folder (spelled `~/…` or whole) it is
 * neither a whole personal folder nor a login nor Genex's data, nor holds one; outside it, it is
 * neither the disk's root nor a folder holding the home folder.
 */
function refusedFolder(spelled: string, home: string): boolean {
  if (spelled.startsWith(`${HOME}/`)) return refusedInHome(spelled.slice(2).split("/"));
  const segments = spelled.slice(1).split("/");
  const homeSegments = home.split("/").filter(Boolean);
  const [inHome, at] = [folded(homeSegments), folded(segments)];
  if (startsWith(at, inHome)) return refusedInHome(segments.slice(homeSegments.length));
  return startsWith(inHome, at);
}

/** Whether `value` is one folder spelled from `~/` or `/`, with no `.`/`..`/empty segment and no glob. */
function isFolderPath(value: unknown): value is string {
  if (!isText(value, LIMIT.PathChars) || GLOB.test(value) || CONTROL.test(value)) return false;
  // The disk's root is a folder, refused as one.
  if (value === "/") return true;
  if (!value.startsWith("/") && !value.startsWith(`${HOME}/`)) return false;
  const segments = value.slice(value.startsWith("/") ? 1 : 2).split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Whether `entry` is a folder with only its keys, a folder path and a reason. */
const isFolderEntry = (entry: unknown): entry is PluginFolder =>
  isRecord(entry) && hasOnlyKeys(entry, FOLDER_KEYS) && isFolderPath(entry.path) && isText(entry.why, LIMIT.WhyChars);

/** One folder in canonical form. */
function pluginFolder(entry: unknown, index: number, home: string): PluginFolder {
  if (!isFolderEntry(entry)) throw new Error(MESSAGE.InvalidFolder(nameOf(entry, "path", index)));
  if (entry.path === "/" || refusedFolder(entry.path, home))
    throw new Error(MESSAGE.RefusedFolder(JSON.stringify(entry.path)));
  return { path: entry.path, why: entry.why };
}

/** The manifest's `folders` in canonical form; throws on API 1 or 2, on anything malformed and on a refused folder. */
export function validateFolders(
  m: Pick<PluginManifest, "apiVersion" | "folders">,
  home = os.homedir(),
): PluginFolder[] {
  const seen = new Set<string>();
  return sectionList(m, "folders", m.folders, LIMIT.Folders).map((entry, index) => {
    const folder = pluginFolder(entry, index, home);
    const key = folded([folder.path]).join("");
    if (seen.has(key)) throw new Error(MESSAGE.DuplicateFolder(JSON.stringify(folder.path)));
    seen.add(key);
    return folder;
  });
}

/**
 * A validated manifest's worker types as the registry lists them: each tool as an agent name, the
 * plugin's own as `<plugin>__<tool>`, another plugin's prefix or name as written.
 */
export function pluginWorkerTypes(manifest: Pick<PluginManifest, "id" | "workerTypes">): WorkerType[] {
  return (manifest.workerTypes ?? []).map((type) => ({
    pluginId: manifest.id,
    id: type.id,
    description: type.description,
    tools: type.tools.map((tool) =>
      tool.includes(OTHER_PLUGIN_SEPARATOR) ? tool : `${manifest.id}${OTHER_PLUGIN_SEPARATOR}${tool}`,
    ),
    isolation: type.isolation,
  }));
}

/** Whether one of a worker type's tools (agent names, or prefixes ending in `__`) is among `offered`. */
export function workerTypeOffered(type: Pick<WorkerType, "tools">, offered: readonly string[]): boolean {
  return type.tools.some((tool) =>
    tool.endsWith(OTHER_PLUGIN_SEPARATOR) ? offered.some((name) => name.startsWith(tool)) : offered.includes(tool),
  );
}

/** A validated manifest's folders as absolute paths, `~` expanded to `home`. */
export function pluginFolderPaths(manifest: Pick<PluginManifest, "folders">, home = os.homedir()): string[] {
  return (manifest.folders ?? []).map((folder) =>
    folder.path.startsWith(`${HOME}/`) ? path.resolve(home, folder.path.slice(2)) : path.resolve(folder.path),
  );
}

/**
 * Find Godot projects without typing. The Godot panel offers the person's projects from the places
 * Godot's own Project Manager knows them: its project list (`projects.cfg` in Godot's settings
 * folder, in a Mac's Application Support or Windows's `%APPDATA%`) and the Godot Projects folder in
 * Documents, one level down (`*` / `project.godot`), with `GodotProjects` beside it as people often
 * name it. Each project is listed once by its real folder, newest first (when its `project.godot`
 * last changed), at most twelve. Listing only reads; it never follows a link into the list.
 */
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { PROJECT_FILE } from "./game-project.ts";

/** The panel's list is a choice, not an archive. */
const PROJECTS_CAP = 12;
/** A `project.godot` is a few kilobytes; a larger one is not read for its name. */
const SETTINGS_MAX_BYTES = 256 * 1024;
/** Godot's settings folder in its data folder (a Mac's Application Support, Windows's `%APPDATA%`). */
const GODOT_SETTINGS = "Godot";
/** A Mac's data folder under the home folder, where a caller names none. */
const MAC_DATA_HOME = ["Library", "Application Support"];
/** Godot's own list of the projects it knows: one `[<folder>]` section each. */
const PROJECT_LIST = "projects.cfg";
/** Where the person keeps Godot projects, under Documents: Genex's own name first. */
export const PROJECTS_FOLDERS = ["Godot Projects", "GodotProjects"] as const;
const DOCUMENTS = "Documents";
const SECTION = /^\[(.+)\]\s*$/;
const NAME = /^config\/name="((?:[^"\\]|\\.)*)"\s*$/m;
const FEATURES = /^config\/features=PackedStringArray\(([^)]*)\)\s*$/m;
const VERSION = /"(\d+\.\d+)"/;

/** A project the panel offers: its real folder, its name, the Godot version it was made with ("" when it doesn't say) and when its settings last changed (ms). */
export type FoundProject = { folder: string; name: string; version: string; modified: number };

/** Godot's text for a name, its escapes read. */
const unescape = (text: string) => text.replace(/\\(.)/g, "$1");

/** The project in `folder`, or undefined unless it is a plain folder (not a link) holding a plain `project.godot`. */
export async function readProject(folder: string): Promise<FoundProject | undefined> {
  if (!path.isAbsolute(folder)) return undefined;
  const info = await lstat(folder).catch(() => null);
  if (!info?.isDirectory()) return undefined;
  const settings = path.join(folder, PROJECT_FILE);
  const file = await lstat(settings).catch(() => null);
  if (!file?.isFile() || file.size > SETTINGS_MAX_BYTES) return undefined;
  const real = await realpath(folder).catch(() => null);
  if (!real) return undefined;
  const text = await readFile(settings, "utf8").catch(() => "");
  const name = NAME.exec(text)?.[1];
  const version = VERSION.exec(FEATURES.exec(text)?.[1] ?? "")?.[1] ?? "";
  return { folder: real, name: name ? unescape(name) : path.basename(real), version, modified: file.mtimeMs };
}

/** The folders Godot's project list in its data folder names, in its order; none when it can't be read. */
export async function listedFolders(dataHome: string): Promise<string[]> {
  const text = await readFile(path.join(dataHome, GODOT_SETTINGS, PROJECT_LIST), "utf8").catch(() => "");
  return text.split(/\r?\n/).flatMap((line) => SECTION.exec(line)?.[1] ?? []);
}

/** The folders one level down in a projects folder, unless it is itself a link; hidden ones and links are skipped. */
async function scannedFolders(folder: string): Promise<string[]> {
  if (!(await lstat(folder).catch(() => null))?.isDirectory()) return [];
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((e) => path.join(folder, e.name));
}

/**
 * The person's Godot projects, each once by its real folder, newest first, at most
 * {@link PROJECTS_CAP}; Godot's list is read in its data folder (`GodotEnv.dataHome`).
 */
export async function findProjects(
  home: string,
  dataHome = path.join(home, ...MAC_DATA_HOME),
): Promise<FoundProject[]> {
  const roots = PROJECTS_FOLDERS.map((name) => path.join(home, DOCUMENTS, name));
  const listed = await listedFolders(dataHome);
  const candidates = [...listed, ...(await Promise.all(roots.map(scannedFolders))).flat()];
  const found = new Map<string, FoundProject>();
  for (const folder of candidates) {
    const project = await readProject(folder);
    if (project && !found.has(project.folder)) found.set(project.folder, project);
  }
  return [...found.values()].sort((a, b) => b.modified - a.modified).slice(0, PROJECTS_CAP);
}

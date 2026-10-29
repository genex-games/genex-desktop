/**
 * The sourcemap luau-lsp reads to know the place's instance tree: the game's scripts under `src/`
 * in Rojo's sourcemap format (`{name, className, filePaths?, children?}`), written by Genex itself,
 * so Rojo isn't needed. Each file is placed by the same names the script sync uses
 * (`script-paths.ts`): a service, the folders on the way, and the script with its class; a script
 * kept as `init` in its own folder holds the scripts below it. Folders on the way are `Folder`s,
 * except the player containers whose class Roblox fixes. File paths are relative to the game
 * folder, which is where luau-lsp runs. Links are never followed: a `src/` that is a link lists
 * no script, and a linked folder inside it is skipped.
 */
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { SCRIPT_EXTENSION, SCRIPTS_FOLDER, scriptRefOf } from "./script-paths.ts";

/** One instance as Rojo's sourcemap writes it. */
export interface SourcemapNode {
  name: string;
  className: string;
  filePaths?: string[];
  children?: SourcemapNode[];
}

/** The root's name: luau-lsp names scripts from `game`, whatever the root is called. */
const ROOT_NAME = "Game";
/** How many scripts a sourcemap lists, and how deep it walks: past either the rest is left out. */
export const MAX_SOURCEMAP_SCRIPTS = 5_000;
const MAX_DEPTH = 64;
/** Containers whose class Roblox fixes, by their path below a service. */
const FIXED_CLASSES: Readonly<Record<string, string>> = {
  "StarterPlayer/StarterPlayerScripts": "StarterPlayerScripts",
  "StarterPlayer/StarterCharacterScripts": "StarterCharacterScripts",
};
const FOLDER_CLASS = "Folder";

/** Code-unit order: the same on every computer, unlike a locale's. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Every script file below the game's `src/`, as `/`-separated paths below it, in code-unit order:
 * only names the script sync reads as a script, never through a link.
 */
export async function scriptFiles(folder: string): Promise<string[]> {
  const root = path.join(folder, SCRIPTS_FOLDER);
  const info = await lstat(root).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) return [];
  const found: string[] = [];
  const walk = async (dir: string, rel: string[]): Promise<void> => {
    if (rel.length > MAX_DEPTH) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => byCodeUnit(a.name, b.name))) {
      if (found.length >= MAX_SOURCEMAP_SCRIPTS) return;
      const parts = [...rel, entry.name];
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), parts);
      else if (entry.isFile() && entry.name.endsWith(SCRIPT_EXTENSION) && scriptRefOf(parts.join("/")))
        found.push(parts.join("/"));
    }
  };
  await walk(root, []);
  return found.sort(byCodeUnit);
}

/** A node being built: its children by name, so each instance on the way is made once. */
interface Building {
  node: SourcemapNode;
  children: Map<string, Building>;
}

const building = (name: string, className: string): Building => ({ node: { name, className }, children: new Map() });

/** The child `name` of `parent`, made with `className` when it isn't there yet. */
function childOf(parent: Building, name: string, className: string): Building {
  const existing = parent.children.get(name);
  if (existing) return existing;
  const made = building(name, className);
  parent.children.set(name, made);
  return made;
}

/** A built node with its children sorted by name, in Rojo's key order. */
function finished(at: Building): SourcemapNode {
  const node: SourcemapNode = { name: at.node.name, className: at.node.className };
  if (at.node.filePaths) node.filePaths = at.node.filePaths;
  const names = [...at.children.keys()].sort(byCodeUnit);
  if (names.length > 0) node.children = names.map((name) => finished(at.children.get(name) as Building));
  return node;
}

/** The sourcemap of `files` (paths below `src/`, as {@link scriptFiles} lists them). */
export function sourcemapOf(files: readonly string[]): SourcemapNode {
  const root = building(ROOT_NAME, "DataModel");
  for (const file of files) {
    const ref = scriptRefOf(file);
    if (!ref) continue;
    const [service, ...names] = ref.path as [string, ...string[]];
    let at = childOf(root, service, service);
    for (const [index, name] of names.entries()) {
      const below = [...names.slice(0, index), name].join("/");
      const last = index === names.length - 1;
      at = childOf(at, name, last ? ref.class : (FIXED_CLASSES[`${service}/${below}`] ?? FOLDER_CLASS));
    }
    // A container's folder may have been made first (for a script below it): its class is the script's.
    at.node.className = ref.class;
    at.node.filePaths = [`${SCRIPTS_FOLDER}/${file}`];
  }
  return finished(root);
}

/**
 * Find projects without typing. The Unreal panel offers the user's projects from three places,
 * the way Unreal's own Project Browser finds them: the engine's Recent Projects list, the Unreal
 * Projects folder one level down (`*` / `*.uproject`), and the projects Genex created, set up or
 * was shown (the setup records and the panel's remembered choice in the plugin's storage). Each
 * project is listed once by its real path, newest first (when Unreal last opened it, else when its
 * `.uproject` last changed), at most twelve. Listing only reads; it never follows a link into the
 * list. The folder scan is kept for a few seconds so the panel's refresh stays cheap.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import { isInside } from "../../substrate/paths.ts";
import { chosenProject, listSetUpProjects } from "./editor-port.ts";
import { isProjectPath, projectName } from "./project-file.ts";
import { type Engine, type ReadEntries, readEntries, recentProjects, type SetupEnv } from "./setup.ts";

/** How long one scan of the Unreal Projects folder answers the panel's refreshes. */
export const SCAN_KEEP_MS = 10 * SECOND_MS;
/** The panel's list is a choice, not an archive. */
const PROJECTS_CAP = 12;
/** A `.uproject` is a few hundred bytes; a larger file is not read for its engine. */
const UPROJECT_MAX_BYTES = 1024 * 1024;
/** Epic's FDateTime text in the Recent Projects list (`2026.01.01-12.00.00`), written in UTC. */
const EPIC_TIME = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})$/;

/** A project file read for the list: its real path, name, engine and last change. */
export type ScannedProject = { file: string; name: string; engine: string; modified: number };

/**
 * A project the panel offers: its real `.uproject`, its name, the folders that hold its folder
 * (from home when inside it), the `EngineAssociation` it names ("" when none), when Unreal last
 * opened it (null when its list doesn't say) and when its `.uproject` last changed (ms).
 */
export type FoundProject = ScannedProject & { place: string[]; opened: number | null };

/** Where the list comes from: the computer, its engines, the plugin's storage and a folder scan. */
export type ProjectSources = { env: SetupEnv; engines: Engine[]; storage: string; scanned: ScannedProject[] };

/** Epic's LastOpenTime as ms since the epoch, or null when it isn't Epic's form. */
function epicTime(text: string): number | null {
  const match = EPIC_TIME.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/** The engine a `.uproject` names, or "" when it can't be read as a small JSON object. */
async function association(file: string): Promise<string> {
  try {
    const json: unknown = JSON.parse((await readRegularFile(file, UPROJECT_MAX_BYTES)).toString("utf8"));
    return isJsonObject(json) && typeof json.EngineAssociation === "string" ? json.EngineAssociation : "";
  } catch {
    return "";
  }
}

/** A project file as the list shows it, or undefined unless it is an absolute `.uproject` that is a plain file. */
async function readProject(file: string): Promise<ScannedProject | undefined> {
  if (!isProjectPath(file)) return undefined;
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) return undefined;
  const directory = await realpath(path.dirname(file)).catch(() => null);
  // A plain file (checked above), so realpath only gives its name the case it has on disk.
  const real = await realpath(file).catch(() => null);
  if (!directory || !real || path.dirname(real) !== directory) return undefined;
  return { file: real, name: projectName(real), engine: await association(real), modified: info.mtimeMs };
}

/**
 * The projects in the Unreal Projects folder, one level down as Unreal's Project Browser looks:
 * each folder's own `.uproject` files. Hidden folders (Genex builds a new game in one) and links
 * are skipped, and so is the whole folder when it is itself a link.
 */
export async function scanProjectsFolder(folder: string, read: ReadEntries = readEntries): Promise<ScannedProject[]> {
  if (!(await isPlainFolder(folder))) return [];
  const found: ScannedProject[] = [];
  // Names only from readdir, types from lstat: Windows' readdir calls OneDrive's placeholders links.
  for (const { name } of await read(folder).catch(() => [])) {
    const dir = path.join(folder, name);
    if (name.startsWith(".") || !(await isPlainFolder(dir))) continue;
    for (const entry of await read(dir).catch(() => [])) {
      const project = await readProject(path.join(dir, entry.name));
      if (project) found.push(project);
    }
  }
  return found;
}

/** Whether a path is a folder itself, not a link to one. */
async function isPlainFolder(dir: string): Promise<boolean> {
  return (await lstat(dir).catch(() => null))?.isDirectory() ?? false;
}

/** A folder's real path, through its nearest existing ancestor when it doesn't exist yet. */
async function realFolder(folder: string): Promise<string> {
  const missing: string[] = [];
  let current = folder;
  for (;;) {
    const real = await realpath(current).catch(() => null);
    if (real) return path.join(real, ...missing.reverse());
    const parent = path.dirname(current);
    if (parent === current) return folder;
    missing.push(path.basename(current));
    current = parent;
  }
}

/**
 * A folder as the panel names it, by real paths so a link anywhere names it one way everywhere:
 * the folders from home when inside it, else the whole path (a drive first on Windows).
 */
export async function placeOf(folder: string, home: string): Promise<string[]> {
  const [realHome, real] = await Promise.all([realFolder(home), realFolder(folder)]);
  const shown = isInside(realHome, real) ? path.relative(realHome, real) : real;
  return shown.split(path.sep).filter(Boolean);
}

/** The project files the setup records and the panel's choice name. */
async function storedProjects(storage: string): Promise<string[]> {
  const chosen = await chosenProject(storage);
  const recorded = (await listSetUpProjects(storage)).map((p) => p.project);
  return chosen ? [chosen, ...recorded] : recorded;
}

const lastSeen = (p: FoundProject) => p.opened ?? p.modified;

/** Every project the panel offers, once each by real path, newest first, at most twelve. */
export async function findProjects(sources: ProjectSources): Promise<FoundProject[]> {
  const { env, engines, storage, scanned } = sources;
  const found = new Map<string, FoundProject>();
  const add = async (project: ScannedProject, opened: number | null) => {
    const known = found.get(project.file);
    const latest = Math.max(opened ?? Number.NEGATIVE_INFINITY, known?.opened ?? Number.NEGATIVE_INFINITY);
    const place = await placeOf(path.dirname(path.dirname(project.file)), env.home);
    found.set(project.file, { ...project, place, opened: Number.isFinite(latest) ? latest : null });
  };
  for (const entry of await recentProjects(env, engines)) {
    const project = await readProject(entry.file);
    if (project) await add(project, epicTime(entry.opened));
  }
  for (const project of scanned) await add(project, null);
  for (const file of await storedProjects(storage)) {
    const project = await readProject(file);
    if (project) await add(project, null);
  }
  return [...found.values()]
    .sort((a, b) => lastSeen(b) - lastSeen(a) || a.name.localeCompare(b.name))
    .slice(0, PROJECTS_CAP);
}

/** `compute`, answered from its last result while that is younger than `ms` by `now`. */
export function keepFor<T>(ms: number, now: () => number, compute: () => Promise<T>): () => Promise<T> {
  let kept: { at: number; value: Promise<T> } | undefined;
  return () => {
    const at = now();
    const age = kept ? at - kept.at : -1;
    // A clock that went backwards counts as stale.
    const fresh = age >= 0 && age < ms;
    if (kept && fresh) return kept.value;
    const value = compute();
    kept = { at, value };
    // A failed scan is not kept: the next refresh tries again.
    value.catch(() => {
      if (kept?.value === value) kept = undefined;
    });
    return value;
  };
}

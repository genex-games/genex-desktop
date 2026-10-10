import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectShape } from "../shared/game-project.ts";
import { containedReal } from "./paths.ts";

const MAX_METADATA_BYTES = 1024 * 1024;
const UNITY_VERSION_FILE = "ProjectSettings/ProjectVersion.txt";
const UNITY_PACKAGES_FILE = "Packages/manifest.json";
const UNITY_CACHE_RULES = [
  "/[Ll]ibrary/",
  "/[Tt]emp/",
  "/[Oo]bj/",
  "/[Ll]ogs/",
  "/[Uu]ser[Ss]ettings/",
  "/[Mm]emoryCaptures/",
];
const MESSAGE = {
  Metadata: (file: string) => `${file} must be a readable regular file inside the Unity project`,
  Directory: (directory: string) => `${directory}/ must be a directory inside the Unity project`,
  Version: `${UNITY_VERSION_FILE} must declare m_EditorVersion`,
  Packages: `${UNITY_PACKAGES_FILE} must be valid JSON with a dependencies object`,
  AdoptionTarget: (file: string) => `${file} cannot be linked or shared with a file outside this Unity project`,
} as const;

/** A native Unity source project; its entry is a project marker, never a browser page. */
export const UNITY_PROJECT_SHAPE: ProjectShape = {
  entry: UNITY_VERSION_FILE,
  main: "Assets",
  build: null,
  install: null,
  own: true,
  kind: "unity",
  serve: ".",
};

/** Recognize incomplete Unity projects too, so invalid metadata can never trigger browser scaffolding. */
export async function isUnityProject(dir: string): Promise<boolean> {
  const [assets, packages, version] = await Promise.all(
    ["Assets", "Packages", UNITY_VERSION_FILE].map((file) => lstat(path.join(dir, file)).catch(() => null)),
  );
  const assetsPresent = assets?.isDirectory() || assets?.isSymbolicLink();
  const packagesPresent = packages?.isDirectory() || packages?.isSymbolicLink();
  return Boolean(assetsPresent && packagesPresent && version);
}

/** Read only bounded metadata inside the project, refusing links to files outside it. */
async function metadataText(dir: string, relative: string): Promise<string> {
  const file = await containedReal(dir, relative),
    info = await lstat(file);
  if (!info.isFile() || info.size > MAX_METADATA_BYTES) throw new Error(MESSAGE.Metadata(relative));
  return readFile(file, "utf8");
}

/** Unity structural validation does not claim that an Editor is connected or that scripts compiled. */
export async function validateUnityProject(dir: string): Promise<string[]> {
  const problems: string[] = [];
  for (const directory of ["Assets", "Packages", "ProjectSettings"]) {
    try {
      if (!(await lstat(await containedReal(dir, directory))).isDirectory())
        problems.push(MESSAGE.Directory(directory));
    } catch {
      problems.push(MESSAGE.Directory(directory));
    }
  }
  try {
    const version = await metadataText(dir, UNITY_VERSION_FILE);
    if (!/^m_EditorVersion:\s*\d+\.\d+\.\d+[a-z]\d+[a-z0-9]*\s*$/im.test(version)) problems.push(MESSAGE.Version);
  } catch {
    problems.push(MESSAGE.Metadata(UNITY_VERSION_FILE));
  }
  try {
    const manifest = JSON.parse(await metadataText(dir, UNITY_PACKAGES_FILE));
    const deps = manifest?.dependencies;
    const valid =
      deps &&
      typeof deps === "object" &&
      !Array.isArray(deps) &&
      Object.values(deps).every((value) => typeof value === "string");
    if (!valid) problems.push(MESSAGE.Packages);
  } catch {
    problems.push(MESSAGE.Packages);
  }
  return problems;
}

/** Unity cache rules missing from this folder's existing ignore file. */
export function missingUnityIgnoreRules(current: string | null): string[] {
  const lines = new Set((current ?? "").split(/\r?\n/).map((line) => line.trim()));
  return UNITY_CACHE_RULES.filter((rule) => !lines.has(rule));
}

/** Add Unity cache exclusions before the initial history snapshot, keeping the user's rules intact. */
export async function ensureUnityIgnoreRules(dir: string): Promise<void> {
  const file = path.join(dir, ".gitignore");
  const current = await readFile(file, "utf8").catch(() => null),
    missing = missingUnityIgnoreRules(current);
  if (!missing.length) return;
  const before = current === null ? "" : `${current.replace(/\s*$/, "")}\n`;
  await writeFile(file, `${before}${missing.join("\n")}\n`);
}

/** Refuse metadata aliases before adoption can read or overwrite a file outside the chosen project. */
export async function assertUnityAdoptionTargets(dir: string): Promise<void> {
  for (const relative of ["studio.json", ".gitignore", ".git"]) {
    const info = await lstat(path.join(dir, relative)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    const regular = info.isFile() && info.nlink === 1;
    const gitDirectory = relative === ".git" && info.isDirectory();
    if (!regular && !gitDirectory) throw new Error(MESSAGE.AdoptionTarget(relative));
  }
}

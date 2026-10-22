/**
 * The Unity editors installed on this computer, found where Unity Hub puts them: its own folder
 * and the folder the person chose in Hub (its `secondaryInstallPath.json`), one editor per folder
 * named by its version. Finding only reads: nothing is installed, activated or signed in here, and
 * an editor that is a link to one is not listed. Each editor also says which packages it ships
 * (its built-in modules), so a new project asks only for what that editor has.
 */
import { lstat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { engineTestMac } from "../../substrate/app-install.ts";
import { isJsonObject, readJsonIfExists } from "../../substrate/fsx.ts";

/** The first Unity 6 release line: the oldest editors Unity's Pipeline package runs in. */
const UNITY_6 = 6000;
/** A Unity version, such as `6000.3.10f1`: three numbers, then alpha, beta, final or patch and its number. */
const VERSION = /^(\d{1,5})\.(\d{1,3})\.(\d{1,4})([abfp])(\d{1,4})$/;
/** Release kinds from earliest to latest. */
const KINDS = "abfp";
/** The most editors listed, and the most entries of one folder read. */
const MAX_EDITORS = 32;
/** Hub's record of the folder the person installs editors into: a JSON string. */
const SECONDARY_PATH_FILE = "secondaryInstallPath.json";
/** A package's own description inside an editor's built-in packages. */
const PACKAGE_JSON = "package.json";

/** One installed editor: its version, and the app (a Mac's `Unity.app`, Windows's `Unity.exe`) that opens projects. */
export interface UnityEditor {
  version: string;
  app: string;
}

/** Where editors are looked for; tests point it at folders of their own. */
export interface EditorsEnv {
  platform: NodeJS.Platform;
  /** The person's home folder. */
  home: string;
  /** `/Applications` on a Mac, Program Files on Windows. */
  applications: string;
  /** Windows's roaming application data, where Hub keeps its records. */
  appData: string;
}

/** This computer's own folders, or a development test's made-up Mac (`substrate/app-install.ts`). */
export function systemEditorsEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): EditorsEnv {
  const testMac = engineTestMac(env, platform);
  if (testMac) return { platform, ...testMac, appData: path.posix.join(testMac.home, "AppData") };
  const home = os.homedir();
  const windows = platform === "win32";
  return {
    platform,
    home,
    applications: windows ? (env.ProgramFiles ?? "C:\\Program Files") : "/Applications",
    appData: env.APPDATA ?? path.join(home, "AppData", "Roaming"),
  };
}

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);

/** A version's parts as numbers, release kind included, or undefined for text that is no Unity version. */
function versionParts(version: string): number[] | undefined {
  const match = VERSION.exec(version);
  if (!match) return undefined;
  const [, major, minor, patch, kind, build] = match;
  return [Number(major), Number(minor), Number(patch), KINDS.indexOf(kind ?? ""), Number(build)];
}

/** Orders two Unity versions, the later one first; text that is no version sorts last. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a) ?? [];
  const right = versionParts(b) ?? [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (right[i] ?? -1) - (left[i] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Whether `version` is Unity 6 or later, which Unity's Pipeline package needs. */
export function isUnity6(version: string | undefined): boolean {
  const major = version ? versionParts(version)?.[0] : undefined;
  return major !== undefined && major >= UNITY_6;
}

/** Where Hub keeps its records on this platform. */
function hubRecords(env: EditorsEnv): string {
  const p = pathFor(env.platform);
  return env.platform === "win32"
    ? p.join(env.appData, "UnityHub")
    : p.join(env.home, "Library", "Application Support", "UnityHub");
}

/** The folder the person chose in Hub for their editors, when its record names one plainly. */
async function secondaryFolder(env: EditorsEnv): Promise<string | undefined> {
  const p = pathFor(env.platform);
  const recorded = await readJsonIfExists<unknown>(p.join(hubRecords(env), SECONDARY_PATH_FILE)).catch(() => null);
  if (typeof recorded !== "string" || !p.isAbsolute(recorded) || p.normalize(recorded) !== recorded) return undefined;
  return recorded;
}

/** The folders holding one editor per version: Hub's own, then the person's. */
export async function editorFolders(env: EditorsEnv): Promise<string[]> {
  const own = pathFor(env.platform).join(env.applications, "Unity", "Hub", "Editor");
  const chosen = await secondaryFolder(env);
  return chosen && chosen !== own ? [own, chosen] : [own];
}

/** The app that opens projects inside an editor's own folder. */
const appIn = (folder: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? path.win32.join(folder, "Editor", "Unity.exe") : path.posix.join(folder, "Unity.app");

/** Whether `app` is itself the editor's app (a Mac's bundle is a folder, Windows's a file), not a link to one. */
async function isApp(app: string, platform: NodeJS.Platform): Promise<boolean> {
  const stat = await lstat(app).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return false;
  return platform === "win32" ? stat.isFile() : stat.isDirectory();
}

/**
 * Unity Hub's own app where its installer puts it (a Mac's Applications, Windows's Program Files),
 * when it is there and is no link to another program.
 */
export async function findHub(env: EditorsEnv): Promise<string | undefined> {
  if (env.platform !== "darwin" && env.platform !== "win32") return undefined;
  const hub =
    env.platform === "win32"
      ? path.win32.join(env.applications, "Unity Hub", "Unity Hub.exe")
      : path.posix.join(env.applications, "Unity Hub.app");
  return (await isApp(hub, env.platform)) ? hub : undefined;
}

/** The editors one folder holds, by the versions its subfolders are named after. */
async function editorsIn(folder: string, platform: NodeJS.Platform): Promise<UnityEditor[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const versions = entries.filter((entry) => entry.isDirectory() && VERSION.test(entry.name)).slice(0, MAX_EDITORS);
  const found: UnityEditor[] = [];
  for (const { name } of versions) {
    const app = appIn(pathFor(platform).join(folder, name), platform);
    if (await isApp(app, platform)) found.push({ version: name, app });
  }
  return found;
}

/** The editors installed here, newest first, each version once (Hub's own folder first). */
export async function findEditors(env: EditorsEnv): Promise<UnityEditor[]> {
  if (env.platform !== "darwin" && env.platform !== "win32") return [];
  const byVersion = new Map<string, UnityEditor>();
  for (const folder of await editorFolders(env)) {
    for (const editor of await editorsIn(folder, env.platform)) {
      if (!byVersion.has(editor.version)) byVersion.set(editor.version, editor);
    }
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(a.version, b.version)).slice(0, MAX_EDITORS);
}

/** Where an editor keeps the packages it ships. */
function builtInFolder(editor: UnityEditor, platform: NodeJS.Platform): string {
  const p = pathFor(platform);
  const resources =
    platform === "win32"
      ? p.join(p.dirname(editor.app), "Data", "Resources")
      : p.join(editor.app, "Contents", "Resources");
  return p.join(resources, "PackageManager", "BuiltInPackages");
}

/**
 * The packages an editor ships, each with the version its own `package.json` names (`1.0.0` when
 * it names none, as every built-in module is); undefined when the editor's folder can't be read.
 */
export async function shippedPackages(
  editor: UnityEditor,
  platform: NodeJS.Platform,
): Promise<Map<string, string> | undefined> {
  const folder = builtInFolder(editor, platform);
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return undefined;
  const shipped = new Map<string, string>();
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const file = pathFor(platform).join(folder, entry.name, PACKAGE_JSON);
    const described = await readJsonIfExists<unknown>(file).catch(() => null);
    const version = isJsonObject(described) && typeof described.version === "string" ? described.version : "1.0.0";
    shipped.set(entry.name, version);
  }
  return shipped;
}

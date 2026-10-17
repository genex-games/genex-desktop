/**
 * A new, empty Unity project for a game, made as plain files: `Assets/`, the version file naming
 * the installed editor it is for, and a package manifest asking for Unity's Pipeline package, the
 * built-in modules an empty 3D project has (physics, audio, animation, UI…) and Unity's UI package.
 * Unity writes everything else the first time it opens the folder, and downloads the Pipeline
 * package then. Only modules the chosen editor ships are asked for, so the manifest always resolves.
 *
 * The project goes in the game's own folder as `unity/`, where the game's checkpoints and Rewind
 * cover it. It is built in a hidden sibling and renamed into place only when complete, so a failure
 * leaves nothing half made; a game that already holds a Unity project, or anything named `unity`,
 * is refused with nothing changed.
 */
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { shippedPackages, type UnityEditor } from "./editors.ts";
import { PIPELINE_PACKAGE, PIPELINE_VERSION } from "./pipeline.ts";
import { findUnityProject, GAME_PROJECT_FOLDER, type UnityProject } from "./project-folder.ts";

/** The start of the hidden folder a project is built in before it is renamed into place. */
const BUILDING_PREFIX = ".unity-new-";
/** Unity's UI package (uGUI and TextMeshPro), shipped with every Unity 6 editor. */
const UI_PACKAGE = "com.unity.ugui";
/** The prefix of an editor's built-in modules. */
const MODULE_PREFIX = "com.unity.modules.";
/** The version every built-in module has. */
const MODULE_VERSION = "1.0.0";
/** The built-in modules of Unity's own empty 3D project. */
const STANDARD_MODULES = [
  "accessibility",
  "ai",
  "androidjni",
  "animation",
  "assetbundle",
  "audio",
  "cloth",
  "director",
  "imageconversion",
  "imgui",
  "jsonserialize",
  "particlesystem",
  "physics",
  "physics2d",
  "screencapture",
  "terrain",
  "terrainphysics",
  "tilemap",
  "ui",
  "uielements",
  "umbra",
  "unityanalytics",
  "unitywebrequest",
  "unitywebrequestassetbundle",
  "unitywebrequestaudio",
  "unitywebrequesttexture",
  "unitywebrequestwww",
  "vehicles",
  "video",
  "vr",
  "wind",
  "xr",
].map((name) => `${MODULE_PREFIX}${name}`);

/** Why a new project was not made. Wire values: never rename one. */
export const NewProjectRefusal = {
  /** The game's folder already holds a Unity project. */
  HasProject: "has-project",
  /** Something named `unity` is already in the game's folder. */
  PlaceTaken: "place-taken",
} as const;
export type NewProjectRefusal = (typeof NewProjectRefusal)[keyof typeof NewProjectRefusal];

/** A refused new project, with a code its caller words. */
export class NewProjectError extends Error {
  readonly code: NewProjectRefusal;
  constructor(code: NewProjectRefusal) {
    super(code);
    this.name = "NewProjectError";
    this.code = code;
  }
}

/**
 * What a new project asks Unity for: the Pipeline package, then the standard modules and the UI
 * package this editor ships (every standard module, when what it ships can't be read).
 */
export async function newProjectDependencies(
  editor: UnityEditor,
  platform: NodeJS.Platform,
): Promise<Record<string, string>> {
  const shipped = await shippedPackages(editor, platform);
  const modules = STANDARD_MODULES.filter((name) => !shipped || shipped.has(name));
  const ui = shipped?.get(UI_PACKAGE);
  const wanted = new Map<string, string>([[PIPELINE_PACKAGE, PIPELINE_VERSION]]);
  for (const name of modules) wanted.set(name, MODULE_VERSION);
  if (ui) wanted.set(UI_PACKAGE, ui);
  return Object.fromEntries([...wanted].sort(([a], [b]) => (a < b ? -1 : 1)));
}

const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Writes an empty project's files into `folder`, for `editor`. */
async function writeProject(folder: string, editor: UnityEditor, platform: NodeJS.Platform): Promise<void> {
  await mkdir(path.join(folder, "Assets"));
  await mkdir(path.join(folder, "Packages"));
  await mkdir(path.join(folder, "ProjectSettings"));
  const dependencies = await newProjectDependencies(editor, platform);
  await writeFile(path.join(folder, "Packages", "manifest.json"), jsonText({ dependencies }));
  await writeFile(path.join(folder, "ProjectSettings", "ProjectVersion.txt"), `m_EditorVersion: ${editor.version}\n`);
}

/**
 * Makes the empty Unity project of the game at `game` (its real path) for `editor`, as `unity/`.
 * Throws {@link NewProjectError} with nothing changed when the game already holds a project or the
 * place is taken.
 */
export async function createProject(
  game: string,
  editor: UnityEditor,
  platform: NodeJS.Platform = process.platform,
): Promise<UnityProject> {
  if (await findUnityProject(game)) throw new NewProjectError(NewProjectRefusal.HasProject);
  const root = path.join(game, GAME_PROJECT_FOLDER);
  if (await lstat(root).catch(() => null)) throw new NewProjectError(NewProjectRefusal.PlaceTaken);
  const building = await mkdtemp(path.join(game, BUILDING_PREFIX));
  try {
    await writeProject(building, editor, platform);
    // A rename onto something that appeared meanwhile fails or replaces an empty folder only.
    await rename(building, root);
  } catch (error) {
    await rm(building, { recursive: true, force: true });
    throw error;
  }
  return { root, game, editorVersion: editor.version };
}

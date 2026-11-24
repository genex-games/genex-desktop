/**
 * A Godot game's app export: Godot's own export of the project as a Mac app, a Windows program or a
 * Linux program into the project's `Builds/<Platform>/` folder, where Publish finds it
 * (`main/core/native-builds.ts`). It runs as a Godot job of Genex's, like the web export
 * (`web-export.ts`), so it never depends on what the session's own shell may write: Godot keeps its
 * settings in a private home and writes one file in macOS's own temporary folder, which a session
 * that works unattended can reach neither of. The project gets one preset of Genex's own per
 * platform (`Genex Mac`, `Genex Windows`, `Genex Linux`), added once; after that it is the game's,
 * and its options (version, icon, bundle identifier) are kept as the agent or the person set them.
 */
import { lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileNoFollow } from "../../substrate/fsx.ts";
import { ExportPlatform } from "./export-templates.ts";
import { PROJECT_FILE } from "./game-project.ts";
import { type GodotCall, GodotJob } from "./godot-run.ts";
import { godotString } from "./multiplayer.ts";
import {
  assertNoLink,
  EXPORT_SETTINGS_TEMP,
  EXPORT_TIMEOUT_MS,
  GDIGNORE,
  PRESETS_FILE,
  TEMPLATES_HOME,
  withPreset,
} from "./web-export.ts";

/** The platforms an app is exported for, as the agent names them: {@link ExportPlatform} without the web. */
export type AppPlatform = Exclude<ExportPlatform, typeof ExportPlatform.Web>;
/** The app platforms, in the order the tool's words list them. */
export const APP_PLATFORMS: readonly AppPlatform[] = [ExportPlatform.Mac, ExportPlatform.Windows, ExportPlatform.Linux];

/** The project's folder every app goes into, and each platform's folder in it. */
export const BUILDS_FOLDER = "Builds";
const PLATFORM_FOLDER: Readonly<Record<AppPlatform, string>> = {
  [ExportPlatform.Mac]: "Mac",
  [ExportPlatform.Windows]: "Windows",
  [ExportPlatform.Linux]: "Linux",
};
/** Genex's own preset for each platform in the project's `export_presets.cfg`. */
export const APP_PRESET: Readonly<Record<AppPlatform, string>> = {
  [ExportPlatform.Mac]: "Genex Mac",
  [ExportPlatform.Windows]: "Genex Windows",
  [ExportPlatform.Linux]: "Genex Linux",
};
/** Godot's own name for each platform, as a preset's `platform` says it. */
const GODOT_PLATFORM: Readonly<Record<AppPlatform, string>> = {
  [ExportPlatform.Mac]: "macOS",
  [ExportPlatform.Windows]: "Windows Desktop",
  [ExportPlatform.Linux]: "Linux",
};
/** What the app's file ends with: a Mac's bundle, a Windows program, a Linux program as Godot names it. */
const APP_SUFFIX: Readonly<Record<AppPlatform, string>> = {
  [ExportPlatform.Mac]: ".app",
  [ExportPlatform.Windows]: ".exe",
  [ExportPlatform.Linux]: ".x86_64",
};
/**
 * The entitlements a Mac app is signed with, as a file of the game's in `Builds/`: Godot's own for
 * an ad hoc signed app (none), which the game may add to. Named in Genex's preset because Godot
 * otherwise writes the file itself in macOS's temporary folder, under the game's own name, which a
 * job's sandbox can't name when it has a space or another alphabet's letters in it.
 */
export const MAC_ENTITLEMENTS_FILE = "genex-mac-entitlements.plist";
const MAC_ENTITLEMENTS = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  "<dict>",
  "</dict>",
  "</plist>",
  "",
].join("\n");
/**
 * Each platform's options in Genex's preset. A Mac app runs on both processors and is signed ad hoc
 * by Godot itself (`codesign/codesign=1`), never by a program of Xcode's; a Windows program keeps its
 * resources as the template has them, so no outside tool is asked for.
 */
const PRESET_OPTIONS: Readonly<Record<AppPlatform, readonly string[]>> = {
  [ExportPlatform.Mac]: [
    'binary_format/architecture="universal"',
    "codesign/codesign=1",
    `codesign/entitlements/custom_file="res://${BUILDS_FOLDER}/${MAC_ENTITLEMENTS_FILE}"`,
    "notarization/notarization=0",
  ],
  [ExportPlatform.Windows]: [
    'binary_format/architecture="x86_64"',
    "binary_format/embed_pck=false",
    "codesign/enable=false",
    "application/modify_resources=false",
  ],
  [ExportPlatform.Linux]: ['binary_format/architecture="x86_64"', "binary_format/embed_pck=false"],
};
/** A Mac bundle's folder of programs, and the reverse-DNS prefix of the identifier Genex gives a game's app. */
const MAC_PROGRAMS = path.join("Contents", "MacOS");
/** What signing a bundle writes last: the template's own signature has none, so a fresh one tells Godot signed the app. */
const MAC_SIGNATURE = path.join("Contents", "_CodeSignature", "CodeResources");
/**
 * The folder Godot's own signing splits a universal program into its two processors in, in macOS's
 * temporary folder whatever TMPDIR says: the one folder there a Mac export may write.
 */
export const MAC_SIGNING_TEMP = "_lipo";
const BUNDLE_PREFIX = "games.genex";
/** The game's name in `project.godot`, and the name an app gets when the project says none usable. */
const PROJECT_NAME = /^config\/name="((?:[^"\\]|\\.)*)"\s*$/m;
const FALLBACK_NAME = "Game";
/** The longest name an app's file gets: a file system's own limit is far above it. */
const APP_NAME_CHARS = 60;
/** Godot's own word that an export failed, whatever it wrote before: `Project export for preset "Genex Mac" failed.` */
const exportFailedLine = (preset: string) => `Project export for preset "${preset}" failed.`;

/** Whether `value` names an app platform. */
export const isAppPlatform = (value: unknown): value is AppPlatform =>
  typeof value === "string" && (APP_PLATFORMS as readonly string[]).includes(value);

/** The project's own name as `project.godot` says it, unescaped; empty when it says none. */
const projectName = (settings: string): string => PROJECT_NAME.exec(settings)?.[1]?.replace(/\\(.)/g, "$1") ?? "";

/** Whether Godot itself said the export with a platform's preset failed: an app it left then is not one to ship. */
export const exportFailed = (output: string, platform: AppPlatform): boolean =>
  output.includes(exportFailedLine(APP_PRESET[platform]));

/**
 * The app's file name from the project's own name: its letters and digits, each word capitalized
 * (`Collect a Single Coin` is `CollectASingleCoin`), so no shell, zip or installer trips on it.
 */
export function appName(settings: string): string {
  const words = projectName(settings)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const joined = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  return joined.slice(0, APP_NAME_CHARS) || FALLBACK_NAME;
}

/** The identifier a Mac app is given: Godot refuses a Mac export without one. Latin letters and digits only. */
export function bundleIdentifier(name: string): string {
  const plain = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${BUNDLE_PREFIX}.${plain || FALLBACK_NAME.toLowerCase()}`;
}

/** Where a platform's app goes: its folder in the project's `Builds/`, and the app itself in it. */
export function appTarget(project: string, platform: AppPlatform, name: string): { folder: string; entry: string } {
  const folder = path.join(project, BUILDS_FOLDER, PLATFORM_FOLDER[platform]);
  return { folder, entry: path.join(folder, `${name}${APP_SUFFIX[platform]}`) };
}

/** Genex's preset for a platform as Godot writes one, numbered after the project's own. */
function presetText(index: number, platform: AppPlatform, name: string): string {
  const identifier =
    platform === ExportPlatform.Mac ? [`application/bundle_identifier=${godotString(bundleIdentifier(name))}`] : [];
  return [
    `[preset.${index}]`,
    "",
    `name="${APP_PRESET[platform]}"`,
    `platform="${GODOT_PLATFORM[platform]}"`,
    "runnable=false",
    'export_filter="all_resources"',
    'include_filter=""',
    'exclude_filter=""',
    `export_path="${BUILDS_FOLDER}/${PLATFORM_FOLDER[platform]}/${name}${APP_SUFFIX[platform]}"`,
    "",
    `[preset.${index}.options]`,
    "",
    ...PRESET_OPTIONS[platform],
    ...identifier,
    "",
  ].join("\n");
}

/** The project's presets with Genex's preset for `platform` added after them; unchanged when it is there. */
export function withAppPreset(presets: string, platform: AppPlatform, name: string): string {
  return withPreset(presets, APP_PRESET[platform], (index) => presetText(index, platform, name));
}

/**
 * The app's place made ready: Genex's preset in `export_presets.cfg`, the platform's folder in
 * `Builds/`, and `Builds/.gdignore`, so Godot never imports an app's files as the game's. Nothing is
 * written through a link. A Mac app also gets its entitlements file there, when the game has none yet. Answers where the app goes.
 */
export async function prepareAppExport(
  project: string,
  platform: AppPlatform,
  linkMessage: string,
): Promise<{ folder: string; entry: string }> {
  const name = appName(await readFile(path.join(project, PROJECT_FILE), "utf8"));
  const presets = path.join(project, PRESETS_FILE);
  const builds = path.join(project, BUILDS_FOLDER);
  const marker = path.join(builds, GDIGNORE);
  const entitlements = path.join(builds, MAC_ENTITLEMENTS_FILE);
  const target = appTarget(project, platform, name);
  // Every place is looked at before anything is written: a link among them stops the whole export.
  for (const at of [presets, builds, marker, entitlements, target.folder, target.entry])
    await assertNoLink(at, linkMessage);
  const before = await readFile(presets, "utf8").catch(() => "");
  const next = withAppPreset(before, platform, name);
  if (next !== before) await writeFileNoFollow(presets, next);
  await mkdir(target.folder, { recursive: true });
  await writeFileNoFollow(marker, "");
  // The game's own once it is there: an entitlement the agent or the person added stays.
  if (platform === ExportPlatform.Mac && !(await lstat(entitlements).catch(() => null)))
    await writeFileNoFollow(entitlements, MAC_ENTITLEMENTS);
  return target;
}

/**
 * The export: Godot imports the project and writes the platform's app at `entry` with Genex's
 * preset, the person's templates linked into a Mac job's private home, writing only the project
 * (the app's folder is in it), the one file Godot writes in macOS's own temporary folder and, for a
 * Mac app, the folder its signing works in there (`MAC_SIGNING_TEMP`).
 */
export function appExportCall(
  project: string,
  platform: AppPlatform,
  entry: string,
  templates: { folder: string; version: string; userTemp: string | null },
): GodotCall {
  // Godot writes the file under a name of its own that starts with this one, then renames it into place.
  const settings = templates.userTemp ? [path.join(templates.userTemp, EXPORT_SETTINGS_TEMP)] : [];
  const signing =
    templates.userTemp && platform === ExportPlatform.Mac ? [path.join(templates.userTemp, MAC_SIGNING_TEMP)] : [];
  return {
    job: GodotJob.Export,
    args: ["--headless", "--path", project, "--export-release", APP_PRESET[platform], entry],
    cwd: project,
    reads: [templates.folder],
    writes: [project, ...signing],
    writePrefixes: settings,
    timeoutMs: EXPORT_TIMEOUT_MS,
    gpu: false,
    homeLinks: [{ at: path.join(TEMPLATES_HOME, templates.version), to: templates.folder }],
  };
}

/** The file that tells an export wrote the app: the program itself, a Mac bundle's being inside it. */
async function programOf(platform: AppPlatform, entry: string): Promise<string | null> {
  if (platform !== ExportPlatform.Mac) return entry;
  const programs = path.join(entry, MAC_PROGRAMS);
  const names = await readdir(programs).catch(() => []);
  const [first] = names.filter((name) => !name.startsWith("."));
  return first ? path.join(programs, first) : null;
}

/** When the app's program was last written (ms), or null when there is none: a regular file, never a link. */
export async function appWrittenAt(platform: AppPlatform, entry: string): Promise<number | null> {
  const program = await programOf(platform, entry);
  const found = program ? await lstat(program).catch(() => null) : null;
  return found?.isFile() ? found.mtimeMs : null;
}

/**
 * When Godot signed a Mac app (ms), or null when it didn't: a bundle whose signing failed keeps the
 * template's own signature, which no Mac accepts for the changed app.
 */
export async function macSignedAt(entry: string): Promise<number | null> {
  const found = await lstat(path.join(entry, MAC_SIGNATURE)).catch(() => null);
  return found?.isFile() ? found.mtimeMs : null;
}

/** The space the app takes: a Mac's bundle, or the folder a program and its data are in. */
export async function appBytes(platform: AppPlatform, target: { folder: string; entry: string }): Promise<number> {
  const root = platform === ExportPlatform.Mac ? target.entry : target.folder;
  let bytes = 0;
  const folders = [root];
  for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const at = path.join(folder, entry.name);
      if (entry.isDirectory()) folders.push(at);
      else if (entry.isFile()) bytes += (await stat(at).catch(() => null))?.size ?? 0;
    }
  }
  return bytes;
}

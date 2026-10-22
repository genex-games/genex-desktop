/**
 * A Godot game's web export: Godot's own Web export of the project into the game's `web/` folder,
 * which Live's Web game tab plays and Publish puts online (`webFolderOf` in
 * `shared/project-workspace.ts`). It needs Godot's Web export template for the installed version,
 * which Godot's Export Template Manager installs into the person's home; the export job's home is
 * private, so the template folder is linked into it, read-only. The project gets one preset of
 * Genex's own (`Genex Web`, no threads: Genex's preview and a published page aren't cross-origin
 * isolated); every other preset of the person's stays as it is.
 */
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { writeFileNoFollow } from "../../substrate/fsx.ts";
import { type GodotInstall, type GodotVersion, versionName } from "./find-godot.ts";
import { dataCopyCall, type GodotCall, GodotJob } from "./godot-run.ts";
import { BRIDGE_LICENSES_FILE, BRIDGE_PAGE_FILE, COLYSEUS_FOLDER, godotString } from "./multiplayer.ts";

/** The game's folder the export goes into, at the game's root. */
export const WEB_EXPORT_FOLDER = "web";
/** The page Godot writes there; its `.pck`, `.wasm` and `.js` share its name. */
export const WEB_PAGE = "index.html";
/** The file that tells the export is Godot's (the game's data), beside the page. */
export const WEB_PACK = "index.pck";
/** Genex's own preset in the project's `export_presets.cfg`. */
export const WEB_PRESET = "Genex Web";
const PRESETS_FILE = "export_presets.cfg";
/** Godot's Web template without threads: a page that needs no cross-origin isolation. */
export const WEB_TEMPLATE = "web_nothreads_release.zip";
/** Where Godot's Export Template Manager keeps templates, in Godot's data folder (a Mac's job links it into its private home). */
const TEMPLATES_IN_DATA = path.join("Godot", "export_templates");
const TEMPLATES_HOME = path.join("Library", "Application Support", TEMPLATES_IN_DATA);
/** Tells Godot to leave a folder out of the project, should the export sit inside it. */
const GDIGNORE = ".gdignore";
/**
 * The file Godot writes the exported project's settings to before packing them, in macOS's own
 * temporary folder for the user whatever TMPDIR says: the one file there an export may write.
 */
export const EXPORT_SETTINGS_TEMP = "tmpproject.binary";
/** An export imports the whole project first, the first time with every asset; within the tool's own nine minutes. */
const EXPORT_TIMEOUT_MS = 8 * MINUTE_MS;

/** The template folder Godot looks in for a version: `4.6.1.stable`, `4.3.stable.mono`. */
export function templateVersion(version: GodotVersion): string {
  return `${versionName(version)}.${version.status}${version.mono ? ".mono" : ""}`;
}

/** The person's template folder for a Godot, in Godot's data folder (`GodotEnv.dataHome`), and the Web template in it. */
export function webTemplates(dataHome: string, install: GodotInstall): { folder: string; template: string } {
  const folder = path.join(dataHome, TEMPLATES_IN_DATA, templateVersion(install.version));
  return { folder, template: path.join(folder, WEB_TEMPLATE) };
}

/** Whether the Web template is installed: a regular file, not a link. */
export async function hasWebTemplate(dataHome: string, install: GodotInstall): Promise<boolean> {
  return (await lstat(webTemplates(dataHome, install).template).catch(() => null))?.isFile() === true;
}

/** Genex's preset as Godot writes one, numbered after the project's own. */
function presetText(index: number): string {
  return [
    `[preset.${index}]`,
    "",
    `name="${WEB_PRESET}"`,
    'platform="Web"',
    "runnable=false",
    'export_filter="all_resources"',
    'include_filter=""',
    'exclude_filter=""',
    `export_path="../${WEB_EXPORT_FOLDER}/${WEB_PAGE}"`,
    "",
    `[preset.${index}.options]`,
    "",
    "variant/extensions_support=false",
    "variant/thread_support=false",
    "vram_texture_compression/for_desktop=true",
    "vram_texture_compression/for_mobile=false",
    "html/canvas_resize_policy=2",
    "html/focus_canvas_on_start=true",
    "progressive_web_app/enabled=false",
    "",
  ].join("\n");
}

/** The project's presets with Genex's Web preset added after them; unchanged when it is there. */
export function withWebPreset(presets: string): string {
  if (presets.split(/\r?\n/).some((line) => line.trim() === `name="${WEB_PRESET}"`)) return presets;
  const numbers = [...presets.matchAll(/^\[preset\.(\d+)\]\s*$/gm)].map((found) => Number(found[1]));
  const next = numbers.length ? Math.max(...numbers) + 1 : 0;
  const before = presets.trim() ? `${presets.replace(/\s*$/, "")}\n\n` : "";
  return `${before}${presetText(next)}`;
}

/** What a multiplayer game's Web preset loads before the engine: Genex's SDK bridge, beside the page. */
export const BRIDGE_HEAD_INCLUDE = `<script src="${BRIDGE_PAGE_FILE}"></script>`;
/** What a multiplayer game's Web preset leaves out: the native GDExtension, which a web build never loads. */
export const WEB_EXCLUDE = `${COLYSEUS_FOLDER}/*`;

/** One `key=value` line of a section's lines, set: replaced where it is, else added after the heading. */
function setLine(lines: string[], heading: number, end: number, key: string, value: string): void {
  const line = `${key}=${value}`;
  const own = lines.findIndex((text, index) => index > heading && index < end && text.trim().startsWith(`${key}=`));
  if (own >= 0) lines[own] = line;
  else lines.splice(heading + 1, 0, line);
}

/**
 * The presets with Genex's Web preset loading the multiplayer bridge (its HTML head include) and
 * leaving the native GDExtension out of the pack; unchanged without Genex's preset or when it does.
 */
export function withMultiplayerWebPreset(presets: string): string {
  const lines = presets.split("\n");
  const named = lines.findIndex((line) => line.trim() === `name="${WEB_PRESET}"`);
  const heading =
    named < 0 ? -1 : lines.slice(0, named).findLastIndex((line) => /^\[preset\.\d+\]\s*$/.test(line.trim()));
  if (heading < 0) return presets;
  const index = /^\[preset\.(\d+)\]/.exec(lines[heading]?.trim() ?? "")?.[1] ?? "";
  const endOf = (from: number) => {
    const next = lines.findIndex((line, at) => at > from && line.trim().startsWith("["));
    return next < 0 ? lines.length : next;
  };
  setLine(lines, heading, endOf(heading), "exclude_filter", godotString(WEB_EXCLUDE));
  const options = lines.findIndex((line) => line.trim() === `[preset.${index}.options]`);
  if (options < 0) return lines.join("\n");
  setLine(lines, options, endOf(options), "html/head_include", godotString(BRIDGE_HEAD_INCLUDE));
  return lines.join("\n");
}

/** Refuses a path that is a link; a missing one is fine. */
async function assertNoLink(file: string, message: string): Promise<void> {
  if ((await lstat(file).catch(() => null))?.isSymbolicLink()) throw new Error(message);
}

/**
 * Genex's preset into the project's `export_presets.cfg`, never through a link; for a multiplayer
 * game, loading Genex's SDK bridge (`withMultiplayerWebPreset`).
 */
export async function addWebPreset(project: string, linkMessage: string, options: { multiplayer?: boolean } = {}) {
  const file = path.join(project, PRESETS_FILE);
  await assertNoLink(file, linkMessage);
  const presets = await readFile(file, "utf8").catch(() => "");
  const added = withWebPreset(presets);
  const next = options.multiplayer ? withMultiplayerWebPreset(added) : added;
  if (next !== presets) await writeFileNoFollow(file, next);
}

/**
 * Genex's SDK bridge beside the exported page, with the licenses of what it bundles, from the
 * copies the plugin ships; never through a link.
 */
export async function copyBridge(
  folder: string,
  shipped: { bridge: string; bridgeLicenses: string },
  linkMessage: string,
): Promise<void> {
  for (const [name, from] of [
    [BRIDGE_PAGE_FILE, shipped.bridge],
    [BRIDGE_LICENSES_FILE, shipped.bridgeLicenses],
  ] as const) {
    const target = path.join(folder, name);
    await assertNoLink(target, linkMessage);
    await writeFileNoFollow(target, await readFile(from));
  }
}

/** The export's folder, made when missing and marked for Godot to leave out of the project; never a link. */
export async function prepareWebFolder(game: string, linkMessage: string): Promise<string> {
  const folder = path.join(game, WEB_EXPORT_FOLDER);
  await assertNoLink(folder, linkMessage);
  await mkdir(folder, { recursive: true });
  const marker = path.join(folder, GDIGNORE);
  await assertNoLink(marker, linkMessage);
  await writeFileNoFollow(marker, "");
  return folder;
}

/**
 * The export: Godot imports the project and writes Genex's Web preset's page and files into
 * `folder`, with the person's Web template linked into a Mac job's private home (on Windows a job
 * of its own puts it in the sandbox user's data folder first: `templateCopyCall`), and the one file
 * Godot writes on a Mac (under names of its own) in the user's own temporary folder.
 */
export function webExportCall(
  project: string,
  folder: string,
  templates: { folder: string; version: string; userTemp: string | null },
): GodotCall {
  // Godot writes the file under a name of its own that starts with this one, then renames it into place.
  const settings = templates.userTemp ? [path.join(templates.userTemp, EXPORT_SETTINGS_TEMP)] : [];
  return {
    job: GodotJob.Export,
    args: ["--headless", "--path", project, "--export-release", WEB_PRESET, path.join(folder, WEB_PAGE)],
    cwd: project,
    reads: [templates.folder],
    writes: [project, folder],
    writePrefixes: settings,
    timeoutMs: EXPORT_TIMEOUT_MS,
    gpu: false,
    homeLinks: [{ at: path.join(TEMPLATES_HOME, templates.version), to: templates.folder }],
  };
}

/**
 * Windows's: one of the person's templates for a Godot (the Web template unless named) put where
 * the sandbox user's Godot looks for it, in that user's own data folder, by a Godot job of Genex's
 * (`dataCopyCall`), before an export.
 */
export function templateCopyCall(
  project: string,
  scripts: string,
  dataHome: string,
  install: GodotInstall,
  name: string = WEB_TEMPLATE,
): GodotCall {
  const to = path.join(TEMPLATES_IN_DATA, templateVersion(install.version), name);
  return dataCopyCall(project, scripts, path.join(webTemplates(dataHome, install).folder, name), to);
}

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
import { type GodotCall, GodotJob } from "./godot-run.ts";

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
/** Where Godot's Export Template Manager keeps templates, in the person's home. */
const TEMPLATES_HOME = "Library/Application Support/Godot/export_templates";
/** Tells Godot to leave a folder out of the project, should the export sit inside it. */
const GDIGNORE = ".gdignore";
/**
 * The file Godot writes the exported project's settings to before packing them, in macOS's own
 * temporary folder for the user whatever TMPDIR says: the one file there an export may write.
 */
export const EXPORT_SETTINGS_TEMP = "tmpproject.binary";
/** An export imports the whole project first, the first time with every asset. */
const EXPORT_TIMEOUT_MS = 10 * MINUTE_MS;

/** The template folder Godot looks in for a version: `4.6.1.stable`, `4.3.stable.mono`. */
export function templateVersion(version: GodotVersion): string {
  return `${versionName(version)}.${version.status}${version.mono ? ".mono" : ""}`;
}

/** The person's template folder for a Godot, and the Web template in it. */
export function webTemplates(home: string, install: GodotInstall): { folder: string; template: string } {
  const folder = path.join(home, TEMPLATES_HOME, templateVersion(install.version));
  return { folder, template: path.join(folder, WEB_TEMPLATE) };
}

/** Whether the Web template is installed: a regular file, not a link. */
export async function hasWebTemplate(home: string, install: GodotInstall): Promise<boolean> {
  return (await lstat(webTemplates(home, install).template).catch(() => null))?.isFile() === true;
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

/** Refuses a path that is a link; a missing one is fine. */
async function assertNoLink(file: string, message: string): Promise<void> {
  if ((await lstat(file).catch(() => null))?.isSymbolicLink()) throw new Error(message);
}

/** Genex's preset into the project's `export_presets.cfg`, never through a link. */
export async function addWebPreset(project: string, linkMessage: string): Promise<void> {
  const file = path.join(project, PRESETS_FILE);
  await assertNoLink(file, linkMessage);
  const presets = await readFile(file, "utf8").catch(() => "");
  const next = withWebPreset(presets);
  if (next !== presets) await writeFileNoFollow(file, next);
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
 * `folder`, with the person's Web template linked into the job's private home, and the one file
 * Godot writes (under names of its own) in the user's own temporary folder.
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

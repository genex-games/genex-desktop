/**
 * Setting a Godot game up for Genex's own play: the Genex addon in the project
 * (`addons/genex/`: the Play Protocol autoload that sleeps unless the game is started with
 * `--play-protocol`, and the editor plugin that saves and reloads for Genex), its autoload line and
 * the editor plugin turned on in `project.godot`, a `bin/play` launcher at the game's root
 * that finds Godot and starts the project with it, and `runtime: bridge` in the game's
 * `studio.json`, which tells Genex's computer tool, playtesters and judges to drive the game through
 * that launcher (docs/play-protocol.md). Every file is the person's: nothing is written through a
 * link, a Genex file the person changed is kept beside the new one as `.mine`, and every other key
 * of `studio.json` stays.
 */
import { chmod, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readJsonForUpdate, writeFileNoFollow } from "../../substrate/fsx.ts";
import { isInside } from "../../substrate/paths.ts";
import { PROJECT_FILE } from "./game-project.ts";

/** Where the addon lives in a project, and the autoload Godot starts it as. */
export const ADDON_FOLDER = "addons/genex";
export const AUTOLOAD_NAME = "GenexPlay";
const AUTOLOAD_SCRIPT = "play_protocol.gd";
/** The launcher at the game's root that `studio.json`'s play command names. */
export const LAUNCHER = "bin/play";
const AUTOLOAD_SECTION = "[autoload]";
const EDITOR_PLUGINS_SECTION = "[editor_plugins]";
/** The addon's editor plugin as `project.godot` lists it among the enabled ones. */
const EDITOR_PLUGIN = `res://${ADDON_FOLDER}/plugin.cfg`;
const STUDIO_JSON = "studio.json";
const BRIDGE_RUNTIME = "bridge";
/** The native runtime plugin.json declares for Godot (`nativeRuntimes[].id`). */
export const GODOT_RUNTIME = "godot";
/** The addon's flag: its Play Protocol runs only when the game is started with it. */
const PLAY_FLAG = "--play-protocol";
const OFF_SCREEN = "-10000,-10000";
const MINE_SUFFIX = ".mine";
const EXECUTABLE = 0o755;

const MESSAGE = {
  Link: (file: string) => `${file} is a link, so Genex won't write through it.`,
  Outside: "The Godot project isn't inside this game's folder.",
} as const;

/** Why setting a game up was refused. */
export class AddonError extends Error {}

/**
 * Where a game stands for Genex's play: the addon (its files as shipped, older, or missing), its
 * autoload, its editor plugin turned on, the launcher and studio.json's runtime.
 */
export type AddonState = {
  addon: "current" | "outdated" | "missing";
  autoload: boolean;
  editor: boolean;
  launcher: boolean;
  bridge: boolean;
};

/** Whether every part is in place. */
export const isSetUp = (state: AddonState): boolean =>
  state.addon === "current" && [state.autoload, state.editor, state.launcher, state.bridge].every(Boolean);

const textOf = (file: string) => readFile(file, "utf8").catch(() => null);

/** Refuses a path that is a link; a missing one is fine. */
async function assertNoLink(file: string): Promise<void> {
  if ((await lstat(file).catch(() => null))?.isSymbolicLink()) throw new AddonError(MESSAGE.Link(path.basename(file)));
}

/** The shipped addon's files, by name. */
async function shippedFiles(source: string): Promise<Map<string, string>> {
  const names = (await readdir(source)).filter((name) => !name.startsWith("."));
  return new Map(
    await Promise.all(names.map(async (name) => [name, await readFile(path.join(source, name), "utf8")] as const)),
  );
}

/** The autoload line as Godot writes it: `*` makes it a singleton node. */
const autoloadLine = () => `${AUTOLOAD_NAME}="*res://${ADDON_FOLDER}/${AUTOLOAD_SCRIPT}"`;

/** `project.godot` with Genex's autoload in its `[autoload]` section (made when it has none); unchanged when it is there. */
export function withAutoload(settings: string): string {
  if (settings.split(/\r?\n/).some((line) => line.trim().startsWith(`${AUTOLOAD_NAME}=`))) return settings;
  const lines = settings.split("\n");
  const section = lines.findIndex((line) => line.trim() === AUTOLOAD_SECTION);
  if (section < 0) return `${settings.replace(/\s*$/, "")}\n\n${AUTOLOAD_SECTION}\n\n${autoloadLine()}\n`;
  lines.splice(section + 1, 0, autoloadLine());
  return lines.join("\n");
}

/** The line of a section's `enabled=PackedStringArray(...)`, and the plugin paths it lists. */
const ENABLED_LINE = /^enabled=PackedStringArray\((.*)\)\s*$/;

/** `project.godot` with the addon's editor plugin enabled (its section made when it has none); unchanged when it is. */
export function withEditorPlugin(settings: string): string {
  const lines = settings.split("\n");
  const section = lines.findIndex((line) => line.trim() === EDITOR_PLUGINS_SECTION);
  const listed = `"${EDITOR_PLUGIN}"`;
  if (section < 0)
    return `${settings.replace(/\s*$/, "")}\n\n${EDITOR_PLUGINS_SECTION}\n\nenabled=PackedStringArray(${listed})\n`;
  const end = lines.findIndex((line, at) => at > section && line.trim().startsWith("["));
  const within = (at: number) => at > section && (end < 0 || at < end);
  const at = lines.findIndex((line, index) => within(index) && ENABLED_LINE.test(line.trim()));
  if (at < 0) {
    lines.splice(section + 1, 0, `enabled=PackedStringArray(${listed})`);
    return lines.join("\n");
  }
  const inside = ENABLED_LINE.exec(lines[at]?.trim() ?? "")?.[1]?.trim() ?? "";
  if (inside.includes(listed)) return settings;
  lines[at] = `enabled=PackedStringArray(${inside ? `${inside}, ${listed}` : listed})`;
  return lines.join("\n");
}

/**
 * The project's folder as the game's root names it, with forward slashes ("." at the root); a
 * linked project outside the game by its absolute path.
 */
const projectPath = (gameDir: string, project: string) =>
  isInside(gameDir, project) || path.resolve(gameDir) === path.resolve(project)
    ? (path.relative(gameDir, project) || ".").split(path.sep).join("/")
    : project;

/** A shell string literal. */
const shellString = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The launcher: Godot from `GENEX_GODOT`, the install Genex found, the usual places or the PATH,
 * starting the project with Genex's play on, at a fixed 60 ticks a second in a window off every
 * screen (a headless Godot draws nothing to show).
 */
export function launcherText(projectFromGame: string, godot: string | null): string {
  // The folder's own name is quoted whole, so nothing in it (a quote, `$`, a backtick) is read as shell.
  const where = projectFromGame === "." ? '"$root"' : `"$root"/${shellString(projectFromGame)}`;
  // A linked project outside the game is named by its own path.
  const project = path.isAbsolute(projectFromGame) ? shellString(projectFromGame) : where;
  return [
    "#!/bin/sh",
    "# Starts this game for Genex's computer tool, playtesters and judges (Genex Play Protocol).",
    "# Made by Genex's Godot plugin; set GENEX_GODOT to use another Godot.",
    'root=$(cd "$(dirname "$0")/.." && pwd)',
    `for godot in "$GENEX_GODOT" ${godot ? `${shellString(godot)} ` : ""}/Applications/Godot.app/Contents/MacOS/Godot "$HOME/Applications/Godot.app/Contents/MacOS/Godot" "$(command -v godot)"; do`,
    '  if [ -n "$godot" ] && [ -x "$godot" ]; then',
    `    exec "$godot" --path ${project} --no-header --fixed-fps 60 --max-fps 60 --position ${OFF_SCREEN} -- ${PLAY_FLAG} "$@"`,
    "  fi",
    "done",
    'echo \'{"event":"fatal","error":"Godot 4 was not found: install it in Applications or set GENEX_GODOT."}\'',
    "exit 1",
    "",
  ].join("\n");
}

/** Whether studio.json's play names the plugin's Godot as its engine. */
function playsWithEngine(play: unknown): boolean {
  const engine =
    typeof play === "object" && play !== null ? (play as { engine?: { runtime?: unknown } }).engine : undefined;
  return engine?.runtime === GODOT_RUNTIME;
}

/** The addon as installed: every file as shipped, none of them, or something between. */
function addonOf(installed: ReadonlyArray<{ text: string; now: string | null }>): AddonState["addon"] {
  if (installed.every((file) => file.now === null)) return "missing";
  return installed.every((file) => file.now === file.text) ? "current" : "outdated";
}

/** Where a game stands for Genex's play, read without changing anything. */
export async function addonState(gameDir: string, project: string, source: string): Promise<AddonState> {
  const shipped = await shippedFiles(source);
  const installed = await Promise.all(
    [...shipped].map(async ([name, text]) => ({ text, now: await textOf(path.join(project, ADDON_FOLDER, name)) })),
  );
  const addon = addonOf(installed);
  const settings = (await textOf(path.join(project, PROJECT_FILE))) ?? "";
  const studio =
    (await readJsonForUpdate<Record<string, unknown>>(path.join(gameDir, STUDIO_JSON)).catch(() => null)) ?? {};
  return {
    addon,
    autoload: withAutoload(settings) === settings && settings !== "",
    editor: withEditorPlugin(settings) === settings && settings !== "",
    launcher: (await lstat(path.join(gameDir, LAUNCHER)).catch(() => null))?.isFile() === true,
    bridge: studio.runtime === BRIDGE_RUNTIME && playsWithEngine(studio.play),
  };
}

/** The addon's files into the project; a Genex file the person changed is kept beside it as `.mine`. Answers the names kept. */
async function installAddon(project: string, source: string): Promise<string[]> {
  const folder = path.join(project, ADDON_FOLDER);
  await assertNoLink(path.join(project, "addons"));
  await assertNoLink(folder);
  await mkdir(folder, { recursive: true });
  const kept: string[] = [];
  for (const [name, text] of await shippedFiles(source)) {
    const file = path.join(folder, name);
    await assertNoLink(file);
    const now = await textOf(file);
    if (now === text) continue;
    if (now !== null) {
      await writeFileNoFollow(`${file}${MINE_SUFFIX}`, now);
      kept.push(name);
    }
    await writeFileNoFollow(file, text);
  }
  return kept;
}

/** The autoload line and the editor plugin into `project.godot`, when they aren't there. */
async function addToSettings(project: string): Promise<void> {
  const file = path.join(project, PROJECT_FILE);
  await assertNoLink(file);
  const settings = await readFile(file, "utf8");
  const next = withEditorPlugin(withAutoload(settings));
  if (next !== settings) await writeFileNoFollow(file, next);
}

/** The launcher at the game's root, executable. */
async function writeLauncher(gameDir: string, project: string, godot: string | null): Promise<void> {
  const file = path.join(gameDir, LAUNCHER);
  await assertNoLink(path.dirname(file));
  await mkdir(path.dirname(file), { recursive: true });
  await assertNoLink(file);
  await writeFileNoFollow(file, launcherText(projectPath(gameDir, project), godot));
  await chmod(file, EXECUTABLE);
}

/**
 * The arguments Genex starts the plugin's Godot runtime with for the game's play: the project, a
 * fixed 60 ticks, a window off every screen, and the addon's flag.
 */
export function engineArgs(projectFromGame: string): string[] {
  return [
    "--path",
    projectFromGame,
    "--no-header",
    "--fixed-fps",
    "60",
    "--max-fps",
    "60",
    "--position",
    OFF_SCREEN,
    "--",
    PLAY_FLAG,
  ];
}

/**
 * `runtime: bridge`, the launcher as studio.json's play command (a person's way to start it) and
 * the plugin's Godot as the engine Genex starts it with (in its sandbox, with a window and the
 * GPU); every other key stays.
 */
async function recordBridge(gameDir: string, project: string): Promise<void> {
  const file = path.join(gameDir, STUDIO_JSON);
  await assertNoLink(file);
  const current = (await readJsonForUpdate<Record<string, unknown>>(file)) ?? {};
  const engine = { runtime: GODOT_RUNTIME, args: engineArgs(projectPath(gameDir, project)) };
  const next = { ...current, runtime: BRIDGE_RUNTIME, play: { command: LAUNCHER, engine } };
  await writeFileNoFollow(file, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Sets a game up for Genex's play: the addon, its autoload and editor plugin, the launcher (naming `godot`, the
 * install Genex found, first) and studio.json's runtime. Answers the addon files kept as `.mine`.
 */
export async function setUpGame(
  gameDir: string,
  project: string,
  source: string,
  godot: string | null,
  options: { linked?: boolean } = {},
): Promise<string[]> {
  // A project outside the game is set up only when the game is linked to it (its engine link).
  const inside = isInside(gameDir, project) || path.resolve(gameDir) === path.resolve(project);
  if (!inside && !options.linked) throw new AddonError(MESSAGE.Outside);
  const kept = await installAddon(project, source);
  await addToSettings(project);
  await writeLauncher(gameDir, project, godot);
  await recordBridge(gameDir, project);
  return kept;
}

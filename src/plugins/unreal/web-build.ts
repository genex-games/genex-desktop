/**
 * What an Unreal game's web build needs of this computer, read from the engine's own files. Unreal
 * builds for the web (its Wasm platform, from 5.9) only from an engine that has the web libraries:
 * an installed (launcher) engine says which platforms it builds in `BaseEngine.ini`'s
 * `[InstalledPlatforms]`, and an engine with no such list builds what its `Engine/Platforms` holds.
 * The build compiles with emscripten, in exactly the version the engine's `Wasm_SDK.json` names,
 * from an emsdk folder the person installs and names in `WASM_EMSDK_ROOT` (else `EMSDK`), the two
 * variables Unreal's build tool reads first.
 *
 * The finished site is the game's web version in `web/` at the game's root, where Publish and Live
 * find an engine's web build; a `web/` that holds anything but an earlier Unreal web build is never
 * replaced. A web build runs only on a cross-origin isolated page, and Genex's hosts are plain ones,
 * so the project gets Epic's setting that has the page's own service worker add the headers. Those
 * hosts also take no file past a size, and Unreal packs a game's whole content into one, so the
 * project's web-only config gets Epic's settings that split it into several.
 */
import { lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText, readRegularFile } from "../../substrate/fsx.ts";
import { UNREAL_WEB_BUILD_MARKER } from "../../shared/project-facts.ts";
import { isInside } from "../../substrate/paths.ts";
import { loadEpicText } from "./epic-files.ts";

/** Unreal's name for the web platform, in `-platform=` and in its installed-platform list. */
export const WEB_PLATFORM = "Wasm";
/** The variables that name an emsdk folder, in the order Unreal's build tool reads them. */
export const EMSDK_VARIABLES = ["WASM_EMSDK_ROOT", "EMSDK"] as const;
/** The variable Genex hands the build: the first Unreal reads, so the emsdk Genex checked is the one used. */
export const EMSDK_VARIABLE = EMSDK_VARIABLES[0];

const BASE_ENGINE_INI = ["Engine", "Config", "BaseEngine.ini"];
const WEB_SDK_FILE = ["Engine", "Platforms", WEB_PLATFORM, "Config", "Wasm_SDK.json"];
const EMSCRIPTEN_VERSION_FILE = ["upstream", "emscripten", "emscripten-version.txt"];
const HAS_PLATFORM_LIST = /^\s*HasInstalledPlatformInfo\s*=\s*true\s*$/im;
const PLATFORM_LINE = /^\s*\+InstalledPlatformConfigurations\s*=\s*\((.*)\)\s*$/;
const FIELD = /(\w+)\s*=\s*"?([^",)]*)"?/g;
/** The configuration Genex packages, and the kind of target a game is. */
const PACKAGED = { Configuration: "Shipping", PlatformType: "Game" } as const;
const VERSION = /^\d+(\.\d+){1,3}$/;

/** One line of the installed-platform list as its fields, or undefined for any other line. */
function platformEntry(line: string): Record<string, string> | undefined {
  const listed = PLATFORM_LINE.exec(line);
  if (!listed) return undefined;
  return Object.fromEntries([...(listed[1] ?? "").matchAll(FIELD)].map((field) => [field[1], field[2]]));
}

/** Whether a plain file (never a link) is at `file`. */
const isPlainFile = async (file: string) => (await lstat(file).catch(() => null))?.isFile() === true;

/** Whether an entry's required file is there, inside the engine; an entry that requires none passes. */
async function hasRequired(engineDir: string, entry: Record<string, string>): Promise<boolean> {
  const required = entry.RequiredFile;
  if (!required) return true;
  const file = path.resolve(engineDir, required);
  return isInside(engineDir, file) && isPlainFile(file);
}

/**
 * Whether the engine in `engineDir` builds a Shipping game for the web: its installed-platform list
 * has such an entry whose required file is there; an engine with no list (not an installed build)
 * does when it holds the web platform.
 */
export async function engineBuildsWeb(engineDir: string): Promise<boolean> {
  const ini = await readFile(path.join(engineDir, ...BASE_ENGINE_INI), "utf8").catch(() => undefined);
  if (ini === undefined) return false;
  if (!HAS_PLATFORM_LIST.test(ini)) return isPlainFile(path.join(engineDir, ...WEB_SDK_FILE));
  for (const line of ini.split(/\r?\n/)) {
    const entry = platformEntry(line);
    const web =
      entry?.PlatformName === WEB_PLATFORM &&
      entry.Configuration === PACKAGED.Configuration &&
      entry.PlatformType === PACKAGED.PlatformType;
    if (entry && web && (await hasRequired(engineDir, entry))) return true;
  }
  return false;
}

/** The emscripten version the engine in `engineDir` builds web games with; undefined when it names none. */
export async function emscriptenFor(engineDir: string): Promise<string | undefined> {
  const text = await readFile(path.join(engineDir, ...WEB_SDK_FILE), "utf8").catch(() => "");
  try {
    const main: unknown = (JSON.parse(text) as { MainVersion?: unknown } | null)?.MainVersion;
    return typeof main === "string" && VERSION.test(main) ? main : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `root` is an emsdk folder whose emscripten is exactly `version`: an absolute plain folder
 * (never a link) whose `upstream/emscripten/emscripten-version.txt` reads it, quoted or not.
 */
export async function emsdkHolds(root: string, version: string): Promise<boolean> {
  if (!path.isAbsolute(root)) return false;
  const folder = await lstat(root).catch(() => null);
  if (!folder?.isDirectory()) return false;
  const text = await readFile(path.join(root, ...EMSCRIPTEN_VERSION_FILE), "utf8").catch(() => "");
  return text.trim().replace(/^"|"$/g, "") === version;
}

/** The folder at a game's root that holds its web version. */
export const GAME_WEB_FOLDER = "web";
/** The page a web build starts from, at its site's root. */
export const WEB_PAGE = "index.html";

/** Whose a game's `web/` is: nobody's yet, an Unreal web build's, or something else's that stays. */
export const WebFolder = { Free: "free", Ours: "ours", Taken: "taken" } as const;
export type WebFolder = (typeof WebFolder)[keyof typeof WebFolder];

/**
 * Whether `folder` holds an Unreal web build: the file list Unreal's package step writes at the
 * site's root, which the page reads before it starts anything.
 */
export const holdsWebBuild = (folder: string): Promise<boolean> =>
  isPlainFile(path.join(folder, UNREAL_WEB_BUILD_MARKER));

/** Whose the game's `web/` is ({@link WebFolder}); a link or a file of that name is taken. */
export async function webFolderOf(gameDir: string): Promise<WebFolder> {
  const folder = path.join(gameDir, GAME_WEB_FOLDER);
  const info = await lstat(folder).catch(() => null);
  if (!info) return WebFolder.Free;
  if (!info.isDirectory()) return WebFolder.Taken;
  return (await holdsWebBuild(folder)) ? WebFolder.Ours : WebFolder.Taken;
}

/**
 * Makes the site Unreal staged in `staged` the game's web version: `web/` at the game's root, an
 * earlier Unreal web build there replaced whole. Answers its page, or undefined when `web/` holds
 * anything else, which stays as it is with the site left where Unreal staged it.
 */
export async function placeWebBuild(gameDir: string, staged: string): Promise<string | undefined> {
  if ((await webFolderOf(gameDir)) === WebFolder.Taken) return undefined;
  const folder = path.join(gameDir, GAME_WEB_FOLDER);
  await rm(folder, { recursive: true, force: true });
  await rename(staged, folder);
  return path.join(folder, WEB_PAGE);
}

/**
 * What Genex's hosting takes of one game's site as a rule: its largest file and the whole site, in
 * bytes, and how many files. An account's own limits can differ, and the upload is what decides.
 */
export const HOST_LIMITS = { FileBytes: 500 * 1024 * 1024, SiteBytes: 2 * 1024 * 1024 * 1024, Files: 200 } as const;
/** The measures of a site the host limits, as {@link HOST_LIMITS} names them. */
export type HostLimits = { [Limit in keyof typeof HOST_LIMITS]: number };

/** Which of the host's limits a site is past: one file's size, the whole site's, or its number of files. */
export const HostLimit = { File: "file", Site: "site", Files: "files" } as const;
export type HostLimit = (typeof HostLimit)[keyof typeof HostLimit];

/**
 * One limit of the host's a site is past: by how much it stands (bytes, or files). For a file, its
 * path in the site and how many more files are past the file limit too.
 */
export type SiteExcess = { limit: HostLimit; amount: number; file?: string; others?: number };

/**
 * What of the site in `folder` is past what Genex's hosting takes ({@link HOST_LIMITS}): its largest file when
 * that is past the file limit, with how many more are, its whole size and its number of files, each only
 * when past its limit; none for a site the host takes, and for a folder that can't be read. A link is
 * no file of the site: it is neither followed nor counted.
 */
export async function siteExcess(folder: string, limits: HostLimits = HOST_LIMITS): Promise<SiteExcess[]> {
  const entries = await readdir(folder, { withFileTypes: true, recursive: true }).catch(() => []);
  const sizes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return { file, bytes: (await lstat(file).catch(() => null))?.size ?? 0 };
      }),
  );
  const bytes = sizes.reduce((sum, size) => sum + size.bytes, 0);
  // Largest first; of two the same size, the one whose path sorts first, so the answer never depends on the listing's order.
  const [largest, ...others] = sizes
    .filter((size) => size.bytes > limits.FileBytes)
    .sort((a, b) => b.bytes - a.bytes || (a.file < b.file ? -1 : 1));
  const excess: SiteExcess[] = [];
  if (largest) {
    const file = path.relative(folder, largest.file).split(path.sep).join("/");
    excess.push({ limit: HostLimit.File, amount: largest.bytes, file, others: others.length });
  }
  if (bytes > limits.SiteBytes) excess.push({ limit: HostLimit.Site, amount: bytes });
  if (sizes.length > limits.Files) excess.push({ limit: HostLimit.Files, amount: sizes.length });
  return excess;
}

/** The folder of a project's own config, beside its `.uproject`. */
export const PROJECT_CONFIG_FOLDER = "Config";
const MAX_CONFIG_BYTES = 1024 * 1024;
const LINE_BREAK = /\r\n|\r|\n/;
const CRLF = "\r\n";
const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.toLowerCase();
const NOT_OWN_FOLDER = "A folder on the way to the project's config is a link or a file.";

/**
 * The most cooked content Unreal puts in one file of a web build, in bytes: half of what the host
 * takes per file ({@link HOST_LIMITS}). Unreal measures a chunk before it is packed into its
 * container, and shader code and padding come on top, so each file is left room.
 */
export const WEB_CHUNK_BYTES = HOST_LIMITS.FileBytes / 2;

/** What Genex adds to one of a project's configs: the folders to the file below the project, its section and the settings. */
type WebConfig = {
  folders: readonly string[];
  file: string;
  section: string;
  /** Each setting's key and the value written where the project doesn't set that key. */
  settings: ReadonlyArray<readonly [key: string, value: string]>;
};

/**
 * Epic's settings of the web build's page, in the config Unreal's own Project Settings write them
 * to: for a host that can't send the isolation headers, the page's service worker adds them; and
 * the page waits for a click before the game starts, since a browser lets a page play sound and
 * take the mouse only after one (Unreal's default lifts the cover by itself and starts sound on the
 * first click or key); and the picture is drawn at up to two device pixels a CSS pixel, sharp on a
 * Retina screen, which Unreal's default of one draws at half its sharpness.
 */
const PAGE: WebConfig = {
  folders: [PROJECT_CONFIG_FOLDER],
  file: "DefaultEngine.ini",
  section: "[/Script/WasmTargetPlatform.WasmTargetSettings]",
  settings: [
    ["bInjectIsolationHeaders", "True"],
    ["StartMode", "Click"],
    ["MaxDevicePixelRatio", "2.0"],
  ],
};

/**
 * Epic's settings that split a package's content into chunks of at most a size, which the cook does
 * when BuildCookRun is given `-manifests`. They go in the web platform's own config, which no Mac,
 * Windows or Linux package reads, and which is the only place asked whether the project sets them:
 * what the project says for every platform (`Config/DefaultGame.ini`) is for its other packages, and
 * a web build has to fit the host whatever they are.
 */
const CHUNKS: WebConfig = {
  folders: [PROJECT_CONFIG_FOLDER, WEB_PLATFORM],
  file: `${WEB_PLATFORM}Game.ini`,
  section: "[/Script/UnrealEd.ProjectPackagingSettings]",
  settings: [
    ["bGenerateChunks", "True"],
    ["MaxChunkSize", String(WEB_CHUNK_BYTES)],
  ],
};

/** A config's whole new text, to be written to `file`. */
type ConfigEdit = { file: string; text: string };

/** The project's config as text; "" when it has none. Never read through a link. */
async function projectConfig(file: string): Promise<string> {
  try {
    return loadEpicText(await readRegularFile(file, MAX_CONFIG_BYTES));
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return "";
    throw error;
  }
}

/**
 * The folder `folders` names below the project, checked and not made: each on the way is a folder
 * of the project's own or not there yet, never a link or a file, which is refused (ELOOP) before
 * anything is written through it. Each is asked what it is by its own name, not by comparing
 * spelled paths, so a `config` in another case, the same folder on a Mac or Windows, is taken as it
 * is.
 */
async function ownFolder(projectDir: string, folders: readonly string[]): Promise<string> {
  let dir = projectDir;
  for (const folder of folders) {
    dir = path.join(dir, folder);
    const there = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (there && !there.isDirectory()) throw Object.assign(new Error(NOT_OWN_FOLDER), { code: "ELOOP" });
  }
  return dir;
}

/** Unreal's marks before a key: add to a list, add even when there, remove a value, clear the key. */
const KEY_MARK = /^[+.\-!]/;

/**
 * Where `section` stands in a config's lines: its last line, and the keys it speaks of, in lower
 * case. A line that adds to a key or takes it away (`+Key=`, `-Key=`, `!Key=`) speaks of it too:
 * the project has said what it wants there.
 */
function sectionIn(lines: readonly string[], section: string): { end: number | null; keys: Set<string> } {
  let inside = false;
  let end: number | null = null;
  const keys = new Set<string>();
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) inside = sameText(trimmed, section);
    if (!inside || trimmed === "") return;
    end = index;
    keys.add((trimmed.split("=")[0] ?? "").trim().replace(KEY_MARK, "").toLowerCase());
  });
  return { end, keys };
}

/**
 * One of the project's own configs with each setting its section doesn't set added: a key the
 * project sets, either way, is left as it is, and so is every other line. Undefined when the project
 * sets them all. The folders to the config are the project's own and the config a plain file: a link
 * in either's place is refused. Nothing is written or made yet.
 */
async function withWebSettings(projectDir: string, config: WebConfig): Promise<ConfigEdit | undefined> {
  const file = path.join(await ownFolder(projectDir, config.folders), config.file);
  const text = await projectConfig(file);
  const eol = text.includes(CRLF) ? CRLF : "\n";
  const lines = text === "" ? [] : text.split(LINE_BREAK);
  const { end, keys } = sectionIn(lines, config.section);
  const missing = config.settings.filter(([key]) => !keys.has(key.toLowerCase()));
  if (missing.length === 0) return undefined;
  const added = missing.map(([key, value]) => `${key}=${value}`);
  if (end !== null) lines.splice(end + 1, 0, ...added);
  else {
    // A config that ends with its final line break keeps one blank line before the new section.
    if (lines.at(-1) === "") lines.pop();
    lines.push(...(lines.length ? [""] : []), config.section, ...added, "");
  }
  return { file, text: lines.join(eol) };
}

/**
 * Gives the project what its web build needs to run on, and be taken by, a plain host that caps a
 * file's size, each setting only where the project's config doesn't say either way:
 *
 * - in `Config/DefaultEngine.ini`, the settings that have the page add the isolation headers itself,
 *   wait for a click before the game starts and draw sharp on a Retina screen;
 * - in the web platform's own `Config/Wasm/WasmGame.ini`, the settings that split the content into
 *   files of at most {@link WEB_CHUNK_BYTES} of cooked data.
 *
 * Both configs are read and checked before either is written or a folder is made, so a project
 * whose config can't be written safely (a link where a folder or a config belongs) keeps both as
 * they were. A write that fails on the way (a full disk) can leave the first written: each setting
 * is harmless alone, and the next package adds the rest.
 */
export async function ensureWebSettings(projectDir: string): Promise<void> {
  const edits: ConfigEdit[] = [];
  for (const config of [PAGE, CHUNKS]) {
    const edit = await withWebSettings(projectDir, config);
    if (edit) edits.push(edit);
  }
  for (const edit of edits) {
    await mkdir(path.dirname(edit.file), { recursive: true });
    await atomicWriteText(edit.file, edit.text);
  }
}

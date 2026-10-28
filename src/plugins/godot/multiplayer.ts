/**
 * Genex multiplayer in a Godot game: Genex's Godot addon (`addons/genex_multiplayer/`, copied from
 * the Genex SDK's `sdks/godot`) and its `GenexMultiplayer` autoload, the official Colyseus
 * GDExtension the addon's native backend runs on (`addons/colyseus/`, release libraries for macOS,
 * Windows and Linux only), the game's Genex project in `project.godot`'s `[genex]` section, and its
 * matchmaking in the game's `genex.json`, which a publish sends to Genex. On the web the addon drives
 * Genex's TypeScript SDK through `window.GenexMultiplayerBridge`, which Genex's Web preset loads
 * (`web-export.ts`). Every file is the person's: nothing is written through a link, and a Genex file
 * the person changed is kept beside the new one as `.mine`.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { MINUTE_MS } from "../../shared/duration.ts";
import { type AppRunner, downloadFile } from "../../substrate/app-install.ts";
import { writeFileNoFollow } from "../../substrate/fsx.ts";
import { GENEX_API_URL } from "../../substrate/genex-game-settings.ts";
import { addonFolderState, assertNoLink, installAddonFolder, withAutoloadOf } from "./genex-addon.ts";
import { PROJECT_FILE } from "./game-project.ts";

/** Where the multiplayer addon lives in a project, and the autoload Godot starts it as. */
export const MULTIPLAYER_ADDON_FOLDER = "addons/genex_multiplayer";
export const MULTIPLAYER_AUTOLOAD = "GenexMultiplayer";
const MULTIPLAYER_SCRIPT = "genex_multiplayer.gd";
/**
 * The Genex SDK commit `addon/genex_multiplayer` is a copy of (`sdks/godot/addons/genex_multiplayer`),
 * plus `identity.gd` taking Genex's API from the launcher's `GENEX_API_URL` (Play's gateway).
 */
export const MULTIPLAYER_ADDON_SOURCE = "me-ai-org/genex-demo@8cd1477a2a120937a1c79fc1c98b99cef3fcc145";

/** Where the Colyseus GDExtension lives in a project. */
export const COLYSEUS_FOLDER = "addons/colyseus";
/** The pinned Colyseus Godot release the addon's native backend is tested with (`sdks/godot/fetch-colyseus.sh`). */
export const COLYSEUS_GODOT = {
  version: "0.18.5",
  url: "https://github.com/colyseus/native-sdk/releases/download/godot-v0.18.5/colyseus-godot-0.18.5.zip",
  sha256: "540fd94593a3fb4393e35176b35da96486298076b6d8257b2cc520a645d7c487",
} as const;
/** The release's files a project takes as they ship, beside the libraries. */
const COLYSEUS_FILES = ["plugin.cfg", "plugin.gd", "colyseus.gd", "version.json"] as const;
/**
 * The release libraries a project takes, by Godot's platform tag: a desktop game exports for
 * these. The debug builds (up to 97 MB each) stay out: the extension loads the release one in the
 * editor too, as the release itself does for Linux, whose debug build crashes.
 */
const COLYSEUS_LIBRARIES = {
  macos: "bin/libcolyseus_godot.macos.release.dylib",
  "windows.x86_64": "bin/colyseus_godot.windows.x86_64.release.dll",
  "linux.x86_64": "bin/libcolyseus_godot.linux.x86_64.release.so",
} as const;
const COLYSEUS_EXTENSION = "colyseus.gdextension";
const COLYSEUS_LICENSE = "LICENSE";
/** Where the release sits inside its zip. */
const ZIP_ROOT = "addons/colyseus";
/** The plugin storage folder holding the checked release and what was unpacked from it. */
const STORAGE_FOLDER = "multiplayer";
const UNZIP = "/usr/bin/unzip";
/** Windows's own folder when its environment names none; its `tar` (bsdtar) reads a zip. */
const WINDOWS_ROOT = "C:\\Windows";
const WINDOWS_TAR = ["System32", "tar.exe"];
const UNZIP_MS = 2 * MINUTE_MS;

/** The page file the Web preset loads the SDK's bridge from, beside the exported page. */
export const BRIDGE_PAGE_FILE = "genex-multiplayer-bridge.js";
/** The licenses of everything the bridge bundles, beside it in the export (the bridge carries none). */
export const BRIDGE_LICENSES_FILE = "genex-multiplayer-bridge.LICENSES.md";

/** `project.godot`'s section of Genex's own settings, and the keys of the game's Genex project in it. */
const GENEX_SECTION = "[genex]";
export const GenexSetting = { Slug: "slug", ApiUrl: "api_url" } as const;
export type GenexSetting = (typeof GenexSetting)[keyof typeof GenexSetting];
const MESSAGE = {
  Checksum: "The Colyseus Godot release Genex downloaded isn't the one it pins, so it was not used.",
} as const;

/** Why setting up multiplayer was refused. */
export class MultiplayerError extends Error {}

/** Where a project stands for Genex multiplayer. */
export type MultiplayerState = {
  addon: "current" | "outdated" | "missing";
  autoload: boolean;
  /** The Colyseus GDExtension a native build needs, at the pinned version. */
  native: boolean;
  /** The game's Genex project, once it has one. */
  slug: string | null;
};

const textOf = (file: string) => readFile(file, "utf8").catch(() => null);

/** A Godot settings string literal. */
export const godotString = (text: string) => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** The lines of one `[section]` of a Godot settings file: its heading's index and where it ends. */
function sectionBounds(lines: readonly string[], heading: string): { at: number; end: number } | null {
  const at = lines.findIndex((line) => line.trim() === heading);
  if (at < 0) return null;
  const next = lines.findIndex((line, index) => index > at && line.trim().startsWith("["));
  return { at, end: next < 0 ? lines.length : next };
}

/** A `[genex]` setting of `project.godot` as written (a string's value), or null. */
export function genexSetting(settings: string, key: GenexSetting): string | null {
  const lines = settings.split(/\r?\n/);
  const bounds = sectionBounds(lines, GENEX_SECTION);
  if (!bounds) return null;
  for (const line of lines.slice(bounds.at + 1, bounds.end)) {
    const found = new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*$`).exec(line.trim());
    if (found) return (found[1] ?? "").replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  return null;
}

/** `project.godot` with a `[genex]` setting set to `value` (the section made when it has none). */
export function withGenexSetting(settings: string, key: GenexSetting, value: string): string {
  const line = `${key}=${godotString(value)}`;
  const lines = settings.split("\n");
  const bounds = sectionBounds(lines, GENEX_SECTION);
  if (!bounds) return `${settings.replace(/\s*$/, "")}\n\n${GENEX_SECTION}\n\n${line}\n`;
  const own = lines.findIndex(
    (text, index) => index > bounds.at && index < bounds.end && new RegExp(`^${key}\\s*=`).test(text.trim()),
  );
  if (own >= 0) lines[own] = line;
  else lines.splice(bounds.at + 1, 0, line);
  return lines.join("\n");
}

/** `project.godot` with the `GenexMultiplayer` autoload. */
export const withMultiplayerAutoload = (settings: string): string =>
  withAutoloadOf(settings, MULTIPLAYER_AUTOLOAD, `${MULTIPLAYER_ADDON_FOLDER}/${MULTIPLAYER_SCRIPT}`);

/**
 * The extension file a project gets: the release library for each desktop platform, loaded in the
 * editor (`debug`) and in an exported game (`release`) alike.
 */
export function colyseusExtension(): string {
  const libraries = Object.entries(COLYSEUS_LIBRARIES).flatMap(([platform, library]) => {
    const [os, arch] = platform.split(".");
    const tag = (build: string) => [os, build, arch].filter(Boolean).join(".");
    return [`${tag("debug")} = "${library}"`, `${tag("release")} = "${library}"`];
  });
  return [
    "; Written by Genex: the Colyseus Godot release's own extension file, with its release libraries for",
    "; macOS, Windows and Linux only (its debug builds weigh up to 97 MB each).",
    "[configuration]",
    'entry_symbol = "colyseus_sdk_init"',
    'compatibility_minimum = "4.1"',
    "",
    "[libraries]",
    ...libraries,
    "",
  ].join("\n");
}

/** Whether the project holds the pinned Colyseus GDExtension, its libraries included. */
async function hasColyseus(project: string): Promise<boolean> {
  const folder = path.join(project, COLYSEUS_FOLDER);
  const version = await textOf(path.join(folder, "version.json"));
  if (!version?.includes(`"${COLYSEUS_GODOT.version}"`)) return false;
  if ((await textOf(path.join(folder, COLYSEUS_EXTENSION))) !== colyseusExtension()) return false;
  const files = await Promise.all(
    Object.values(COLYSEUS_LIBRARIES).map((library) => lstat(path.join(folder, library)).catch(() => null)),
  );
  return files.every((file) => file?.isFile() === true);
}

/** Whether the game's Godot project carries Genex's multiplayer addon. */
export async function usesMultiplayer(project: string): Promise<boolean> {
  return (await lstat(path.join(project, MULTIPLAYER_ADDON_FOLDER, "plugin.cfg")).catch(() => null))?.isFile() === true;
}

/** Where a project stands for Genex multiplayer, read without changing anything. */
export async function multiplayerState(project: string, source: string): Promise<MultiplayerState> {
  const settings = (await textOf(path.join(project, PROJECT_FILE))) ?? "";
  return {
    addon: await addonFolderState(project, source, MULTIPLAYER_ADDON_FOLDER),
    autoload: settings !== "" && withMultiplayerAutoload(settings) === settings,
    native: await hasColyseus(project),
    slug: genexSetting(settings, GenexSetting.Slug),
  };
}

/** The addon, its autoload and the game's Genex project into the project. Answers the addon files kept as `.mine`. */
export async function installMultiplayer(
  project: string,
  source: string,
  options: { slug?: string; apiUrl?: string },
): Promise<string[]> {
  const kept = await installAddonFolder(project, source, MULTIPLAYER_ADDON_FOLDER);
  const file = path.join(project, PROJECT_FILE);
  await assertNoLink(file);
  const settings = await readFile(file, "utf8");
  let next = withMultiplayerAutoload(settings);
  if (options.slug) next = withGenexSetting(next, GenexSetting.Slug, options.slug);
  if (options.apiUrl || genexSetting(next, GenexSetting.ApiUrl) === null)
    next = withGenexSetting(next, GenexSetting.ApiUrl, options.apiUrl ?? GENEX_API_URL);
  if (next !== settings) await writeFileNoFollow(file, next);
  return kept;
}

/** What fetching the Colyseus release reaches: the network and the `unzip` program. */
export type ColyseusFetchDeps = { fetch: typeof fetch; run: AppRunner };
/** A Colyseus Godot release: its version, where it downloads from and its archive's sha256. */
export type ColyseusRelease = { version: string; url: string; sha256: string };

/** A file's sha256, hex. */
async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * The program that unpacks `entries` of a zip into a folder that exists: a Mac's `unzip`, or
 * Windows's own `tar` by its full path under SystemRoot, so neither PATH nor the current folder
 * stands in (Git's `tar` would read `C:` as a host).
 */
export function unzipCall(
  zip: string,
  entries: readonly string[],
  into: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  if (platform !== "win32") return { command: UNZIP, args: ["-q", "-o", zip, ...entries, "-d", into] };
  const root = env.SystemRoot && path.win32.isAbsolute(env.SystemRoot) ? env.SystemRoot : WINDOWS_ROOT;
  return { command: path.win32.join(root, ...WINDOWS_TAR), args: ["-xf", zip, "-C", into, ...entries] };
}

/**
 * The pinned Colyseus release, unpacked once into the plugin's storage: downloaded, checked against
 * its sha256 and only then unpacked (the files a project takes, no debug builds). Answers the
 * unpacked `addons/colyseus` folder. A download that isn't the pinned release is removed, never used.
 */
export async function colyseusRelease(
  deps: ColyseusFetchDeps,
  storage: string,
  signal: AbortSignal,
  release: ColyseusRelease = COLYSEUS_GODOT,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const folder = path.join(storage, STORAGE_FOLDER, `colyseus-godot-${release.version}`);
  const unpacked = path.join(folder, "unpacked");
  const ready = path.join(unpacked, ZIP_ROOT);
  if (await hasRelease(ready)) return ready;
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  const zip = path.join(folder, "release.zip");
  const partial = `${zip}.partial`;
  await downloadFile(deps.fetch, release.url, partial, { signal, onBytes: () => undefined });
  if ((await sha256Of(partial)) !== release.sha256) {
    await rm(folder, { recursive: true, force: true });
    throw new MultiplayerError(MESSAGE.Checksum);
  }
  await rename(partial, zip);
  const entries = [...COLYSEUS_FILES, ...Object.values(COLYSEUS_LIBRARIES)].map((name) => `${ZIP_ROOT}/${name}`);
  await mkdir(unpacked, { recursive: true });
  const unzip = unzipCall(zip, entries, unpacked, platform);
  await deps.run(unzip.command, unzip.args, UNZIP_MS, signal);
  await rm(zip, { force: true });
  return ready;
}

/** Whether an unpacked release holds every file a project takes. */
async function hasRelease(folder: string): Promise<boolean> {
  const names = [...COLYSEUS_FILES, ...Object.values(COLYSEUS_LIBRARIES)];
  const found = await Promise.all(names.map((name) => lstat(path.join(folder, name)).catch(() => null)));
  return found.every((file) => file?.isFile() === true);
}

/**
 * The Colyseus GDExtension into the project from an unpacked release: its files as they ship, the
 * desktop release libraries, Genex's extension file naming only those, and the release's license.
 */
export async function installColyseus(project: string, release: string, license: string): Promise<void> {
  const folder = path.join(project, COLYSEUS_FOLDER);
  await assertNoLink(path.join(project, "addons"));
  await assertNoLink(folder);
  await assertNoLink(path.join(folder, "bin"));
  await mkdir(path.join(folder, "bin"), { recursive: true });
  for (const name of [...COLYSEUS_FILES, ...Object.values(COLYSEUS_LIBRARIES)]) {
    const target = path.join(folder, name);
    await assertNoLink(target);
    await writeFileNoFollow(target, await readFile(path.join(release, name)));
  }
  for (const [name, text] of [
    [COLYSEUS_EXTENSION, colyseusExtension()],
    [COLYSEUS_LICENSE, await readFile(license, "utf8")],
  ] as const) {
    await assertNoLink(path.join(folder, name));
    await writeFileNoFollow(path.join(folder, name), text);
  }
}

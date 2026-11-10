/**
 * What a game's package.json tells Genex at publish time, read by the host for the Genex plugin's
 * `export.stage`. The plugin runs the CLI in its own copy of the game, which has no package.json,
 * so without this the CLI never told Genex the game uses sign-in and players saw "this game didn't
 * finish starting". Only the Genex SDK versions and the `genex` settings leave the game folder.
 *
 * A game made from Studio's template has no package.json: multiplayer is its dependency when its
 * import map takes Studio's copy (`GENEX_STUDIO_IMPORTS`), at the version Studio serves, and its
 * `genex.json` holds the settings a package.json's `genex` field would. Its player identity is not:
 * Studio connects a template game itself and names the SDK it ships then (`workspaceManifest`).
 */
import { readFile, stat } from "node:fs/promises";
import { CodedError } from "../shared/errors.ts";
import { ExportRefusal } from "../shared/game-library.ts";
import { GENEX_GAME_PACKAGES, type GenexGameManifest, type GenexGamePackage } from "../shared/genex.ts";
import { pageStudioSdkPackages } from "../shared/genex-page.ts";
import { t } from "../shared/i18n.ts";
import { containedReal } from "./paths.ts";

/** A package.json, genex.json or template page larger than this is not read. */
const MAX_MANIFEST_BYTES = 256 * 1024;
/** Where a template game keeps its Genex settings: the `genex` field of a package.json it has not got. */
export const TEMPLATE_GENEX_SETTINGS = "genex.json";
/**
 * The file a Godot game's project carries once Genex's multiplayer addon is in it (the Godot
 * plugin's `godot__multiplayer`, in the game's `godot/` project): its multiplayer is Studio's copy.
 */
const GODOT_MULTIPLAYER_ADDON = "godot/addons/genex_multiplayer/plugin.cfg";
/**
 * The file a Unity game's project holds once Genex's multiplayer package is embedded in it (the
 * Unity plugin's `unity__multiplayer`), in a project at the game's root or in its `unity/`.
 */
const UNITY_MULTIPLAYER_PACKAGES = [
  "Packages/com.genex.multiplayer/package.json",
  "unity/Packages/com.genex.multiplayer/package.json",
];
/**
 * The descriptor an Unreal game's project holds once Genex's GenexMultiplayer plugin is in it (the
 * Unreal plugin's `unreal__multiplayer`), in the game's `unreal/` project or one at its root.
 */
const UNREAL_MULTIPLAYER_PLUGINS = [
  "unreal/Plugins/GenexMultiplayer/GenexMultiplayer.uplugin",
  "Plugins/GenexMultiplayer/GenexMultiplayer.uplugin",
];
/** A `genex.matchmaking` block larger than this, as JSON, is left out. */
const MAX_MATCHMAKING_CHARS = 4096;
/** The `genex` setting that names a game's server-authoritative room module. */
const AUTHORITY_SETTING = "authority";
/** The room module files whose presence says a game meant to declare a room. */
const ROOM_MODULE_FILES = ["server/room.js", "server/room.ts"];
/** A version range as npm writes one for a registry package; links, paths and URLs are left out. */
const VERSION_RANGE = /^[0-9A-Za-z.^~<>=*+| -]{1,64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A dependency's version range, when it is one a registry package could have. */
function versionOf(pkg: Record<string, unknown>, name: GenexGamePackage): string | undefined {
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field];
    const version = isRecord(deps) && Object.hasOwn(deps, name) ? deps[name] : undefined;
    if (typeof version === "string" && VERSION_RANGE.test(version.trim())) return version.trim();
  }
  return undefined;
}

/**
 * The `genex` settings the CLI sends with an upload: a matchmaking block, the mobile-controls flag
 * and the server-authoritative room block. The room block goes as written, malformed or not: the
 * CLI checks it and refuses a bad one by name, where leaving it out would ship a game whose every
 * join is refused (424, no room module).
 */
function genexSettings(pkg: Record<string, unknown>): GenexGameManifest["genex"] {
  const genex = pkg.genex;
  if (!isRecord(genex)) return undefined;
  const settings: NonNullable<GenexGameManifest["genex"]> = {};
  const matchmaking = genex.matchmaking;
  if (isRecord(matchmaking) && JSON.stringify(matchmaking).length <= MAX_MATCHMAKING_CHARS)
    settings.matchmaking = matchmaking;
  if (genex.mobileControls === true) settings.mobileControls = true;
  if (Object.hasOwn(genex, AUTHORITY_SETTING)) settings.authority = genex[AUTHORITY_SETTING];
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/** The Genex part of a parsed package.json; undefined when it names no Genex package or setting. */
export function genexGameManifest(pkg: unknown): GenexGameManifest | undefined {
  if (!isRecord(pkg)) return undefined;
  const dependencies: GenexGameManifest["dependencies"] = {};
  for (const name of Object.keys(GENEX_GAME_PACKAGES) as GenexGamePackage[]) {
    const version = versionOf(pkg, name);
    if (version) dependencies[name] = version;
  }
  const genex = genexSettings(pkg);
  if (Object.keys(dependencies).length === 0 && !genex) return undefined;
  return genex ? { dependencies, genex } : { dependencies };
}

/** The package a multiplayer game loads. */
const MULTIPLAYER_PACKAGE: GenexGamePackage = "@genex-ai/multiplayer";

/** The package Studio connects a template game with, and names itself when it publishes one. */
const STUDIO_CONNECTED: GenexGamePackage = "@genex-ai/embed-sdk";

/**
 * A template game's Genex manifest from its page's import map and its `genex.json` (both parsed
 * already); undefined when it turns on no Genex package of its own and sets nothing.
 */
export function templateGenexManifest(html: string, settings: unknown): GenexGameManifest | undefined {
  const dependencies: GenexGameManifest["dependencies"] = {};
  for (const name of pageStudioSdkPackages(html))
    if (name !== STUDIO_CONNECTED) dependencies[name] = GENEX_GAME_PACKAGES[name];
  const genex = genexSettings({ genex: settings });
  if (Object.keys(dependencies).length === 0 && !genex) return undefined;
  return genex ? { dependencies, genex } : { dependencies };
}

/**
 * An engine game's Genex manifest once its project carries Genex's multiplayer (Godot's addon,
 * Unity's package, Unreal's plugin): multiplayer at the version Studio ships, and its `genex.json` settings.
 */
function engineGenexManifest(settings: unknown): GenexGameManifest {
  const dependencies: GenexGameManifest["dependencies"] = {
    [MULTIPLAYER_PACKAGE]: GENEX_GAME_PACKAGES[MULTIPLAYER_PACKAGE],
  };
  const genex = genexSettings({ genex: settings });
  return genex ? { dependencies, genex } : { dependencies };
}

/** Whether a game's engine project carries Genex's multiplayer: Godot's addon, Unity's package or Unreal's plugin. */
async function carriesEngineMultiplayer(dir: string): Promise<boolean> {
  for (const file of [GODOT_MULTIPLAYER_ADDON, ...UNITY_MULTIPLAYER_PACKAGES, ...UNREAL_MULTIPLAYER_PLUGINS])
    if ((await readOwnFile(dir, file)) !== null) return true;
  return false;
}

/** A small regular file that really lives inside `dir` (a link out of it is not followed); null otherwise. */
async function readOwnFile(dir: string, name: string): Promise<string | null> {
  try {
    const file = await containedReal(dir, name);
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Parsed JSON, or undefined when the text is missing or is not JSON. */
function parsedJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The game's Genex manifest: from `dir/package.json` when the game has one, else, for a Godot,
 * Unity or Unreal game whose project carries Genex's multiplayer, from that and its `genex.json`, else, for a game
 * made from the template, from its `index.html` import map and `genex.json`. Undefined when there
 * is none to read.
 */
export async function readGenexGameManifest(dir: string): Promise<GenexGameManifest | undefined> {
  const pkg = await readOwnFile(dir, "package.json");
  if (pkg !== null) return genexGameManifest(parsedJson(pkg));
  if (await carriesEngineMultiplayer(dir))
    return engineGenexManifest(parsedJson(await readOwnFile(dir, TEMPLATE_GENEX_SETTINGS)));
  const html = await readOwnFile(dir, "index.html");
  if (html === null) return undefined;
  return templateGenexManifest(html, parsedJson(await readOwnFile(dir, TEMPLATE_GENEX_SETTINGS)));
}

/** Whether the game in `dir` loads Genex's multiplayer, by the manifest a publish would send. */
export async function usesGenexMultiplayer(dir: string): Promise<boolean> {
  const manifest = await readGenexGameManifest(dir);
  return manifest?.dependencies[MULTIPLAYER_PACKAGE] !== undefined;
}

/** Why a game's `authority` block never reaches Genex, as the builder reads it. */
const DROPPED = {
  NotJson: (file: string) =>
    t(
      "{file} is not a JSON object, so its authority block never reaches Genex and the game would publish with no room. Fix {file}",
      { file },
    ),
  GenexNotObject: () =>
    t(
      "package.json's genex is not an object, so no authority block reaches Genex and the game would publish with no room",
    ),
  ShadowedByPackage: () =>
    t(
      "Genex reads this game's package.json, not its genex.json, so genex.json's authority block is ignored. Move the block into package.json as genex.authority, or remove package.json",
    ),
  Unread: () =>
    t(
      "Genex reads no settings of this game, so genex.json's authority block is ignored: it needs an index.html, a package.json, or Genex's multiplayer in its engine project",
    ),
} as const;

/** Whether the game in `dir` holds a room module file in `server/` (a real file, no link out). */
async function holdsRoomModule(dir: string): Promise<boolean> {
  for (const rel of ROOM_MODULE_FILES) {
    const file = await containedReal(dir, rel).catch(() => null);
    if (file && (await stat(file).catch(() => null))?.isFile()) return true;
  }
  return false;
}

/** Whether `text` is present but is not a JSON object. */
const notJsonObject = (text: string | null): boolean => text !== null && !isRecord(parsedJson(text));

/**
 * The game's `authority` block dropped on the way to Genex, as a refusal; null when it is read, or
 * when nothing says the game meant one. A `genex.json` that declares one is meant, wherever it is;
 * a manifest that is not JSON is taken as meant when a room module (`server/room.*`) is beside it.
 */
async function droppedAuthority(dir: string, manifest: GenexGameManifest | undefined): Promise<CodedError | null> {
  if (manifest?.genex && Object.hasOwn(manifest.genex, AUTHORITY_SETTING)) return null;
  const pkg = await readOwnFile(dir, "package.json");
  const settings = await readOwnFile(dir, TEMPLATE_GENEX_SETTINGS);
  const settingsJson = parsedJson(settings);
  if (isRecord(settingsJson) && Object.hasOwn(settingsJson, AUTHORITY_SETTING))
    return new CodedError(
      ExportRefusal.RoomManifestShadowed,
      pkg === null ? DROPPED.Unread() : DROPPED.ShadowedByPackage(),
    );
  if (!(await holdsRoomModule(dir))) return null;
  const pkgJson = parsedJson(pkg);
  if (pkg !== null && !isRecord(pkgJson))
    return new CodedError(ExportRefusal.RoomManifestBroken, DROPPED.NotJson("package.json"));
  if (isRecord(pkgJson) && pkgJson.genex !== undefined && !isRecord(pkgJson.genex))
    return new CodedError(ExportRefusal.RoomManifestBroken, DROPPED.GenexNotObject());
  if (pkg === null && notJsonObject(settings))
    return new CodedError(ExportRefusal.RoomManifestBroken, DROPPED.NotJson(TEMPLATE_GENEX_SETTINGS));
  return null;
}

/**
 * The game's Genex manifest for a publish or a local room: {@link readGenexGameManifest}, refused
 * by name (`ExportRefusal.RoomManifestBroken`, `RoomManifestShadowed`) when the game's `authority`
 * block is dropped on the way, which would otherwise ship a game with no room.
 */
export async function readRoomGameManifest(dir: string): Promise<GenexGameManifest | undefined> {
  const manifest = await readGenexGameManifest(dir);
  const dropped = await droppedAuthority(dir, manifest);
  if (dropped) throw dropped;
  return manifest;
}

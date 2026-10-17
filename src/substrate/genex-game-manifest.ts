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
import { GENEX_GAME_PACKAGES, type GenexGameManifest, type GenexGamePackage } from "../shared/genex.ts";
import { pageStudioSdkPackages } from "../shared/genex-page.ts";
import { containedReal } from "./paths.ts";

/** A package.json, genex.json or template page larger than this is not read. */
const MAX_MANIFEST_BYTES = 256 * 1024;
/** Where a template game keeps its Genex settings: the `genex` field of a package.json it has not got. */
export const TEMPLATE_GENEX_SETTINGS = "genex.json";
/** A `genex.matchmaking` block larger than this, as JSON, is left out. */
const MAX_MATCHMAKING_CHARS = 4096;
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

/** The `genex` settings the CLI sends with an upload: a matchmaking block and the mobile-controls flag. */
function genexSettings(pkg: Record<string, unknown>): GenexGameManifest["genex"] {
  const genex = pkg.genex;
  if (!isRecord(genex)) return undefined;
  const settings: NonNullable<GenexGameManifest["genex"]> = {};
  const matchmaking = genex.matchmaking;
  if (isRecord(matchmaking) && JSON.stringify(matchmaking).length <= MAX_MATCHMAKING_CHARS)
    settings.matchmaking = matchmaking;
  if (genex.mobileControls === true) settings.mobileControls = true;
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
 * The game's Genex manifest: from `dir/package.json` when the game has one, else, for a game made
 * from the template, from its `index.html` import map and `genex.json`. Undefined when there is
 * none to read.
 */
export async function readGenexGameManifest(dir: string): Promise<GenexGameManifest | undefined> {
  const pkg = await readOwnFile(dir, "package.json");
  if (pkg !== null) return genexGameManifest(parsedJson(pkg));
  const html = await readOwnFile(dir, "index.html");
  if (html === null) return undefined;
  return templateGenexManifest(html, parsedJson(await readOwnFile(dir, TEMPLATE_GENEX_SETTINGS)));
}

/** Whether the game in `dir` loads Genex's multiplayer, by the manifest a publish would send. */
export async function usesGenexMultiplayer(dir: string): Promise<boolean> {
  const manifest = await readGenexGameManifest(dir);
  return manifest?.dependencies[MULTIPLAYER_PACKAGE] !== undefined;
}

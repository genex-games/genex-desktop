/**
 * What a game's package.json tells Genex at publish time, read by the host for the Genex plugin's
 * `export.stage`. The plugin runs the CLI in its own copy of the game, which has no package.json,
 * so without this the CLI never told Genex the game uses sign-in and players saw "this game didn't
 * finish starting". Only the Genex SDK versions and the `genex` settings leave the game folder.
 */
import { readFile, stat } from "node:fs/promises";
import { GENEX_GAME_PACKAGES, type GenexGameManifest, type GenexGamePackage } from "../shared/genex.ts";
import { containedReal } from "./paths.ts";

/** A package.json larger than this is not read. */
const MAX_MANIFEST_BYTES = 256 * 1024;
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

/**
 * The game's Genex manifest from `dir/package.json`, read only when that file really lives inside
 * the game (a link out of it is not followed) and is small; undefined when there is none to read.
 */
export async function readGenexGameManifest(dir: string): Promise<GenexGameManifest | undefined> {
  try {
    const file = await containedReal(dir, "package.json");
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) return undefined;
    return genexGameManifest(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * Genex multiplayer in a Unity game: Genex's Unity package (`com.genex.multiplayer`, copied from
 * the Genex SDK's `sdks/unity`) embedded in the project's `Packages/` folder, the official Colyseus
 * Unity SDK it runs on asked for in `Packages/manifest.json` at the commit the Genex SDK is tested
 * with (Unity fetches it from Colyseus's own repository; Studio ships none of it), and the game's
 * Genex project in `Assets/Resources/GenexSettings.json`, which the game reads with
 * `Resources.Load`, and Genex's `GenexGame` beside it in `Assets/Genex/`, which also takes the
 * game's project from Play (`GENEX_GAME`) or its published page (`window.__GENEX__.slug`), so a
 * build made before the first publish joins its rooms once published. A WebGL build signs in through
 * the published page's own embed SDK (`window.genexEmbed`, which Studio's connect module exposes); a
 * native one through `GenexNativeIdentity` (Play's gateway and ticket, or a guest). Every file is the person's: nothing
 * is written through a link, and a Genex file the person changed is kept beside the new one as
 * `<name>.mine~` (a name Unity never imports).
 */
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readJsonForUpdate, writeFileNoFollow } from "../../substrate/fsx.ts";
import { GENEX_API_URL } from "../../substrate/genex-game-settings.ts";
import { readManifest, writeManifest } from "./setup.ts";

/** Genex's Unity package, and where a project embeds it. */
export const MULTIPLAYER_PACKAGE = "com.genex.multiplayer";
/** The Genex SDK commit `multiplayer/com.genex.multiplayer` is a copy of (`sdks/unity`). */
export const MULTIPLAYER_PACKAGE_SOURCE = "me-ai-org/genex-demo@91cc3409919cbc89bba08b664274b71a96198f27";
/** The Colyseus Unity SDK the Genex package runs on, at the `upm` commit of 0.18.8 it is tested with. */
export const COLYSEUS_PACKAGE = "io.colyseus.sdk";
export const COLYSEUS_PACKAGE_URL =
  "https://github.com/colyseus/colyseus-unity-sdk.git#7306c8ee4be7e78984baf0837df5ea8125154820";
/** The game's Genex project, as the game reads it: `Resources.Load<TextAsset>("GenexSettings")`. */
export const SETTINGS_FILE = "Assets/Resources/GenexSettings.json";
const PACKAGES_FOLDER = "Packages";
/**
 * Keeps IL2CPP's stripping from removing what the relay's schema reaches only by reflection: the
 * Genex package's and the Colyseus SDK's assemblies, whole. Unity reads a `link.xml` anywhere under
 * `Assets/`.
 */
export const LINK_FILE = "Assets/Genex/link.xml";
const LINK_XML = [
  "<!-- Written by Genex: keeps IL2CPP from stripping the multiplayer schema it reaches by reflection. -->",
  "<linker>",
  '  <assembly fullname="Genex.Multiplayer" preserve="all" />',
  '  <assembly fullname="ColyseusSDK" preserve="all" />',
  '  <assembly fullname="colyseus.nativewebsocket" preserve="all" />',
  "</linker>",
  "",
].join("\n");
/**
 * Genex's own files a game gets beside the package, by where they go in the project and their name in
 * `genex-game/` beside the shipped package: `GenexGame.Slug`, the game's project wherever it runs.
 */
export const GAME_FILES = {
  "Assets/Genex/GenexGame.cs": "GenexGame.cs",
  "Assets/Genex/GenexGame.jslib": "GenexGame.jslib",
} as const;
/** The folder beside the shipped package that holds {@link GAME_FILES}. */
const GAME_FILES_FOLDER = "genex-game";
/** Unity never imports a name that ends so: a changed Genex file kept beside the new one. */
const MINE_SUFFIX = ".mine~";

const MESSAGE = {
  Link: (file: string) => `${file} is a link, so Genex won't write through it.`,
} as const;

/** Why setting up multiplayer was refused. */
export class UnityMultiplayerError extends Error {}

/** Where a Unity project stands for Genex multiplayer. */
export type UnityMultiplayerState = {
  package: "current" | "outdated" | "missing";
  /** The project's manifest asks for the Colyseus Unity SDK (any version the person chose counts). */
  colyseus: boolean;
  /** The game's Genex project, once it has one. */
  slug: string | null;
};

/** Refuses a path that is a link; a missing one is fine. */
async function assertNoLink(file: string): Promise<void> {
  if ((await lstat(file).catch(() => null))?.isSymbolicLink()) throw new UnityMultiplayerError(MESSAGE.Link(file));
}

/** Every file of the shipped package, by its path inside it, forward slashes. */
async function shippedFiles(source: string, folder = ""): Promise<string[]> {
  const entries = await readdir(path.join(source, folder), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const name = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await shippedFiles(source, name)));
    else if (entry.isFile()) files.push(name);
  }
  return files.sort();
}

const bytesOf = (file: string) => readFile(file).catch(() => null);

/** The package as the project holds it: every file as shipped, none of them, or something between. */
async function packageState(root: string, source: string): Promise<UnityMultiplayerState["package"]> {
  const target = path.join(root, PACKAGES_FOLDER, MULTIPLAYER_PACKAGE);
  const files = await shippedFiles(source);
  const held = await Promise.all(
    files.map(async (name) => {
      const [now, shipped] = await Promise.all([bytesOf(path.join(target, name)), bytesOf(path.join(source, name))]);
      return { now, same: now !== null && shipped !== null && now.equals(shipped) };
    }),
  );
  if (held.every((file) => file.now === null)) return "missing";
  return held.every((file) => file.same) ? "current" : "outdated";
}

/** The game's settings file, parsed, or an empty one. */
async function readSettings(root: string): Promise<Record<string, unknown>> {
  return (await readJsonForUpdate<Record<string, unknown>>(path.join(root, ...SETTINGS_FILE.split("/")))) ?? {};
}

/** Whether the Unity project at `root` embeds Genex's multiplayer package. */
export async function usesUnityMultiplayer(root: string): Promise<boolean> {
  const manifest = path.join(root, PACKAGES_FOLDER, MULTIPLAYER_PACKAGE, "package.json");
  return (await lstat(manifest).catch(() => null))?.isFile() === true;
}

/** Where a Unity project stands for Genex multiplayer, read without changing anything. */
export async function unityMultiplayerState(root: string, source: string): Promise<UnityMultiplayerState> {
  const dependencies = await readManifest(root)
    .then((manifest) => manifest.dependencies)
    .catch(() => ({}) as Record<string, unknown>);
  const slug = (await readSettings(root)).slug;
  return {
    package: await packageState(root, source),
    colyseus: typeof dependencies[COLYSEUS_PACKAGE] === "string",
    slug: typeof slug === "string" && slug ? slug : null,
  };
}

/** The shipped package into the project's `Packages/`; a Genex file the person changed is kept as `.mine~`. Answers those. */
async function embedPackage(root: string, source: string): Promise<string[]> {
  const target = path.join(root, PACKAGES_FOLDER, MULTIPLAYER_PACKAGE);
  await assertNoLink(path.join(root, PACKAGES_FOLDER));
  const kept: string[] = [];
  for (const name of await shippedFiles(source)) {
    const file = path.join(target, ...name.split("/"));
    for (let folder = path.dirname(file); folder.startsWith(target); folder = path.dirname(folder))
      await assertNoLink(folder);
    await mkdir(path.dirname(file), { recursive: true });
    await assertNoLink(file);
    const shipped = await readFile(path.join(source, name));
    const now = await bytesOf(file);
    if (now?.equals(shipped)) continue;
    if (now !== null) {
      await writeFileNoFollow(`${file}${MINE_SUFFIX}`, now);
      kept.push(name);
    }
    await writeFileNoFollow(file, shipped);
  }
  return kept;
}

/** The Colyseus Unity SDK into the manifest when the project doesn't ask for it yet; a version the person chose stays. */
async function askForColyseus(root: string): Promise<boolean> {
  const manifest = await readManifest(root);
  if (typeof manifest.dependencies[COLYSEUS_PACKAGE] === "string") return false;
  await writeManifest(manifest, { ...manifest.dependencies, [COLYSEUS_PACKAGE]: COLYSEUS_PACKAGE_URL });
  return true;
}

/** The game's Genex project into its settings file; every other key stays, and an API it already names stays. */
async function writeSettings(root: string, slug: string | undefined): Promise<void> {
  const file = path.join(root, ...SETTINGS_FILE.split("/"));
  for (const folder of [path.join(root, "Assets"), path.dirname(file)]) await assertNoLink(folder);
  await mkdir(path.dirname(file), { recursive: true });
  await assertNoLink(file);
  const current = await readSettings(root);
  const next = { ...current, ...(slug ? { slug } : {}), apiUrl: current.apiUrl ?? GENEX_API_URL };
  await writeFileNoFollow(file, `${JSON.stringify(next, null, 2)}\n`);
}

/** One of Genex's files under `Assets/Genex/`, as it ships; a file the person changed is kept beside it as `.mine~`. Answers whether it was kept. */
async function writeGenexFile(root: string, name: string, shipped: Buffer): Promise<boolean> {
  const file = path.join(root, ...name.split("/"));
  for (const folder of [path.join(root, "Assets"), path.dirname(file)]) await assertNoLink(folder);
  await mkdir(path.dirname(file), { recursive: true });
  await assertNoLink(file);
  const now = await bytesOf(file);
  if (now?.equals(shipped)) return false;
  if (now !== null) await writeFileNoFollow(`${file}${MINE_SUFFIX}`, now);
  await writeFileNoFollow(file, shipped);
  return now !== null;
}

/** Genex's `link.xml` and {@link GAME_FILES}, as they ship. Answers the ones the person had changed, kept as `.mine~`. */
async function writeGenexFiles(root: string, source: string): Promise<string[]> {
  const files: Array<[string, Buffer]> = [[LINK_FILE, Buffer.from(LINK_XML)]];
  for (const [name, shipped] of Object.entries(GAME_FILES))
    files.push([name, await readFile(path.join(path.dirname(source), GAME_FILES_FOLDER, shipped))]);
  const kept: string[] = [];
  for (const [name, shipped] of files) if (await writeGenexFile(root, name, shipped)) kept.push(name);
  return kept;
}

/**
 * Genex multiplayer into the Unity project at `root`: the package embedded, Colyseus asked for, the
 * assemblies kept from stripping, `GenexGame` beside them and the game's Genex project written. Answers what changed: the package files kept as `.mine~`, and
 * whether the manifest changed (Unity resolves it when its editor next comes forward).
 */
export async function installUnityMultiplayer(
  root: string,
  source: string,
  options: { slug?: string },
): Promise<{ kept: string[]; manifestChanged: boolean }> {
  const kept = await embedPackage(root, source);
  const manifestChanged = await askForColyseus(root);
  kept.push(...(await writeGenexFiles(root, source)));
  await writeSettings(root, options.slug);
  return { kept, manifestChanged };
}

/**
 * Genex multiplayer in an Unreal game (`unreal__multiplayer`): Genex's own `GenexMultiplayer`
 * plugin, which the app ships at a pinned Genex SDK commit (`multiplayer/GenexMultiplayer`,
 * vendored by `scripts/vendor-unreal-multiplayer.ts`), copied into the game's project as
 * `Plugins/GenexMultiplayer` and turned on in its .uproject. The plugin is the Unreal client for
 * Genex's relay rooms and server-authoritative rooms (protocol 4: prediction, the fast UDP
 * channel, identity). Its editor module joins Play to the room `genex__room` runs (named in the
 * game's `.studio/authority.json`).
 *
 * The plugin links the official Colyseus native core, which Genex never commits: on a Mac the
 * pinned release (the core's own xcframework, checked by sha256 before anything is unpacked) is
 * downloaded once into the plugin's storage by this backend, never by a sandboxed job, and its
 * macOS library and headers placed in the plugin's `Source/ThirdParty/ColyseusNative`. Windows has
 * no published Win64 core yet: there the plugin goes in and the answer says the core is missing.
 * A core that couldn't be added is a note, never a refusal.
 *
 * Every file is the person's: nothing is written through a link, and a folder on the way that is
 * a link refuses the whole call before anything is written.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { MINUTE_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { downloadFile } from "../../substrate/app-install.ts";
import { ensureDirBelow, writeFileNoFollow } from "../../substrate/fsx.ts";
import { enableProjectPlugin } from "./cpp-module.ts";

/** The tool, by its name after `unreal__`. */
export const MultiplayerToolName = { Multiplayer: "multiplayer" } as const;
export type MultiplayerToolName = (typeof MultiplayerToolName)[keyof typeof MultiplayerToolName];

/** The plugin's folder name, in the app and in a project's `Plugins/`. */
export const MULTIPLAYER_PLUGIN = "GenexMultiplayer";
/** What the app ships beside the backend: the plugin, its pin and the core's license. */
export const SHIPPED_MULTIPLAYER = fileURLToPath(new URL("./multiplayer/", import.meta.url));
const PIN_FILE = "vendor.json";
const CORE_LICENSE = "COLYSEUS-LICENSE";
/** Where the plugin keeps the Colyseus core it links (`ColyseusNative.Build.cs`). */
const CORE_FOLDER = ["Source", "ThirdParty", "ColyseusNative"] as const;

/** The pinned Colyseus native core release a Mac game's plugin links (`sdks/unreal/scripts/fetch-colyseus.sh macos`). */
export const COLYSEUS_UNREAL_CORE = {
  version: "0.18.10",
  url: "https://github.com/colyseus/native-sdk/releases/download/v0.18.10/Colyseus.xcframework.zip",
  sha256: "66eb6f4ebd662e81f20e63a3c42c515159f523246238055ff55fdf6d09b09982",
} as const;
export type ColyseusCoreRelease = { version: string; url: string; sha256: string };
/** The xcframework's macOS slice (universal arm64 + x86_64): its library and headers. */
const MAC_SLICE = "Colyseus.xcframework/macos-arm64_x86_64";
const MAC_LIBRARY = "libcolyseus.a";
const MAC_HEADERS = "Headers";
/** The plugin storage folder holding the checked release, unpacked. */
const STORAGE_FOLDER = "multiplayer";
const UNZIP = "/usr/bin/unzip";
const UNZIP_MS = 2 * MINUTE_MS;

const MESSAGE = {
  Checksum: "The Colyseus core Genex downloaded isn't the one it pins, so it was not used.",
  Link: (rel: string) => `${rel} in the Unreal project is a link, so Genex won't write through it.`,
  NoWindowsCore:
    "Genex has no Windows build of the Colyseus core to give yet, so this PC can't compile the plugin; build and play the game's multiplayer on a Mac.",
  NoCore: (platform: string) => `Genex has no Colyseus core for ${platform}; the plugin compiles on a Mac.`,
  NoUnzip: "The Colyseus core's archive held no macOS library.",
} as const;

/** Why setting up multiplayer was refused. */
export class UnrealMultiplayerError extends Error {}

/** Unpacks `pattern` of `zip` into `into` (a Mac's `unzip`). */
export type Unzip = (zip: string, pattern: string, into: string, signal: AbortSignal) => Promise<void>;

/** A Mac's own `unzip`, by its full path. */
export const systemUnzip: Unzip = async (zip, pattern, into, signal) => {
  await promisify(execFile)(UNZIP, ["-q", "-o", zip, pattern, "-d", into], { timeout: UNZIP_MS, signal });
};

/** What the tool reaches: the network and `unzip` for the core, this computer's system, the shipped plugin. */
export type UnrealMultiplayerDeps = {
  fetch: typeof fetch;
  /** {@link systemUnzip} unless a test stands in. */
  unzip?: Unzip;
  platform: NodeJS.Platform;
  /** The shipped folder ({@link SHIPPED_MULTIPLAYER}) unless a test stands in. */
  shipped?: string;
  /** The core release ({@link COLYSEUS_UNREAL_CORE}) unless a test stands in. */
  core?: ColyseusCoreRelease;
};

/** The pin the shipped plugin was vendored at. */
type ShippedPin = { source: string; commit: string; tree: string };

/** What `unreal__multiplayer` answers. */
export type MultiplayerAnswer = {
  /** The plugin's folder in the project, relative to the project's folder. */
  plugin: string;
  sdk: ShippedPin;
  enabled: boolean;
  /** Whether the Colyseus core is in the plugin, or why not. */
  core: { ready: true } | { ready: false; why: string };
  next: string;
};

/** A file's sha256, hex. */
async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Every file below `dir`, as `/`-separated relative paths; a link anywhere refuses. */
async function filesBelow(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new UnrealMultiplayerError(MESSAGE.Link(child));
    if (entry.isDirectory()) out.push(...(await filesBelow(dir, child)));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** Refuses when any folder or file `files` would be written at (below `into`) is a link; reads only. */
async function assertNoLinkOnTheWay(into: string, files: readonly string[], label: string): Promise<void> {
  const seen = new Set<string>();
  for (const rel of files) {
    const parts = rel.split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      const sub = parts.slice(0, depth).join("/");
      if (seen.has(sub)) continue;
      seen.add(sub);
      if ((await lstat(path.join(into, ...parts.slice(0, depth))).catch(() => null))?.isSymbolicLink())
        throw new UnrealMultiplayerError(MESSAGE.Link(`${label}/${sub}`));
    }
  }
}

/**
 * Copy every file of `from` into `into` (folders made by real path, never through a link; files
 * written without following one), keeping each file's executable bit. Everything is checked first.
 */
async function copyTree(from: string, into: string, label: string): Promise<number> {
  const files = await filesBelow(from);
  await assertNoLinkOnTheWay(into, files, label);
  for (const rel of files) {
    const parts = rel.split("/");
    const dir = await ensureDirBelow(into, parts.slice(0, -1));
    const source = path.join(from, ...parts);
    const target = path.join(dir, parts.at(-1) ?? "");
    await writeFileNoFollow(target, await readFile(source));
    await chmod(target, (await lstat(source)).mode & 0o777);
  }
  return files.length;
}

/**
 * The pinned core release, unpacked once into the plugin's storage: downloaded, checked against its
 * sha256 and only then unpacked (its macOS slice). Answers the slice's folder. A download that
 * isn't the pinned release is removed, never used.
 */
export async function colyseusCore(deps: UnrealMultiplayerDeps, storage: string, signal: AbortSignal): Promise<string> {
  const release = deps.core ?? COLYSEUS_UNREAL_CORE;
  const folder = path.join(storage, STORAGE_FOLDER, `colyseus-unreal-${release.version}`);
  const unpacked = path.join(folder, "unpacked");
  const slice = path.join(unpacked, MAC_SLICE);
  if ((await lstat(path.join(slice, MAC_LIBRARY)).catch(() => null))?.isFile()) return slice;
  await rm(folder, { recursive: true, force: true });
  await mkdir(unpacked, { recursive: true });
  const zip = path.join(folder, "release.zip");
  const partial = `${zip}.partial`;
  await downloadFile(deps.fetch, release.url, partial, { signal, onBytes: () => undefined });
  if ((await sha256Of(partial)) !== release.sha256) {
    await rm(folder, { recursive: true, force: true });
    throw new UnrealMultiplayerError(MESSAGE.Checksum);
  }
  await rename(partial, zip);
  await (deps.unzip ?? systemUnzip)(zip, `${MAC_SLICE}/*`, unpacked, signal);
  await rm(zip, { force: true });
  if (!(await lstat(path.join(slice, MAC_LIBRARY)).catch(() => null))?.isFile())
    throw new UnrealMultiplayerError(MESSAGE.NoUnzip);
  return slice;
}

/** The core into the project's plugin: the library under `lib/Mac`, the headers under `include`, its license beside them. */
async function placeCore(slice: string, plugin: string, shipped: string): Promise<void> {
  const core = await ensureDirBelow(plugin, CORE_FOLDER);
  const lib = await ensureDirBelow(core, ["lib", "Mac"]);
  await writeFileNoFollow(path.join(lib, MAC_LIBRARY), await readFile(path.join(slice, MAC_LIBRARY)));
  await copyTree(path.join(slice, MAC_HEADERS), await ensureDirBelow(core, ["include"]), "ColyseusNative/include");
  await writeFileNoFollow(path.join(core, "LICENSE"), await readFile(path.join(shipped, CORE_LICENSE)));
}

/** The Colyseus core into the plugin where Genex has one for this system; why not otherwise. */
async function addCore(
  deps: UnrealMultiplayerDeps,
  storage: string,
  plugin: string,
  signal: AbortSignal,
): Promise<MultiplayerAnswer["core"]> {
  if (deps.platform === "win32") return { ready: false, why: MESSAGE.NoWindowsCore };
  if (deps.platform !== "darwin") return { ready: false, why: MESSAGE.NoCore(deps.platform) };
  try {
    const slice = await colyseusCore(deps, storage, signal);
    await placeCore(slice, plugin, deps.shipped ?? SHIPPED_MULTIPLAYER);
    return { ready: true };
  } catch (error) {
    return { ready: false, why: errorMessage(error) };
  }
}

/**
 * The agent's `multiplayer`: Genex's GenexMultiplayer plugin into the Unreal project `projectFile`
 * (copied from the app, turned on in the .uproject) and the Colyseus core it links. Refuses,
 * writing nothing, when a folder or file on the way is a link.
 */
export async function addMultiplayer(
  deps: UnrealMultiplayerDeps,
  storage: string,
  projectFile: string,
  signal: AbortSignal,
): Promise<MultiplayerAnswer> {
  const shipped = deps.shipped ?? SHIPPED_MULTIPLAYER;
  const sdk = JSON.parse(await readFile(path.join(shipped, PIN_FILE), "utf8")) as ShippedPin;
  const project = path.dirname(projectFile);
  for (const rel of ["Plugins", `Plugins/${MULTIPLAYER_PLUGIN}`])
    if ((await lstat(path.join(project, rel)).catch(() => null))?.isSymbolicLink())
      throw new UnrealMultiplayerError(MESSAGE.Link(rel));
  const plugin = await ensureDirBelow(project, ["Plugins", MULTIPLAYER_PLUGIN]);
  await copyTree(path.join(shipped, MULTIPLAYER_PLUGIN), plugin, `Plugins/${MULTIPLAYER_PLUGIN}`);
  const enabled = await enableProjectPlugin(projectFile, MULTIPLAYER_PLUGIN);
  const core = await addCore(deps, storage, plugin, signal);
  return {
    plugin: `Plugins/${MULTIPLAYER_PLUGIN}`,
    sdk: { source: sdk.source, commit: sdk.commit, tree: sdk.tree },
    enabled,
    core,
    next: core.ready
      ? "Read the unreal-multiplayer skill (unreal__skill), then: cpp-status (add-cpp-module if the game has none), write server/room.ts and genex.json's authority block, genex__room validate, the client on the Genex Authority Subsystem, a rebuild with Unreal closed so it builds the plugin, then genex__room start and Play."
      : "The plugin is in the project, but Unreal can't build it without the Colyseus core (see core.why); call unreal__multiplayer again to retry.",
  };
}

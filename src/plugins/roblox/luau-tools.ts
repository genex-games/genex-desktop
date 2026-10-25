/**
 * The Luau checks' programs: luau-lsp (types), selene (lint) and StyLua (format), plus luau-lsp's
 * Roblox type definitions. `findTools` looks where the person keeps them first (PATH, then Rokit,
 * Aftman and Foreman's bins), then where **Add Luau checks** put them: the plugin's own storage,
 * one folder per pinned version (`luau/<asset>-<version>/`).
 *
 * `addLuauChecks` downloads only the {@link PINNED} public releases from GitHub, never the latest
 * and never into the app's build: HTTPS only, every redirect checked to stay on GitHub's hosts,
 * each file no larger than its pin and matching its sha256 before anything is unpacked. All the
 * files are fetched and checked into a private folder inside the storage first; only then are the
 * archives unpacked (`ditto` on a Mac, Windows' own `tar`) and moved into place, so a refusal at
 * any step leaves nothing behind. The programs are the person's to run on their own scripts and
 * run outside Genex's process sandbox, as the person's own copies would.
 */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { envPath, envValue } from "../../substrate/toolchain.ts";
import type { InstallRun } from "./studio-install.ts";
import { isWindowsPath, type LocateFs } from "./studio-locate.ts";
import { MESSAGE } from "./words.ts";

/** The three checking programs. Wire values (program names): never rename. */
export const LuauTool = {
  LuauLsp: "luau-lsp",
  Selene: "selene",
  StyLua: "stylua",
} as const;
export type LuauTool = (typeof LuauTool)[keyof typeof LuauTool];
/** Every checking program, in the order the checks run and report them. */
export const LUAU_TOOLS: readonly LuauTool[] = Object.values(LuauTool);

/** What Add Luau checks downloads: each program, and luau-lsp's Roblox type definitions. */
export const LuauAsset = { ...LuauTool, RobloxTypes: "roblox-types" } as const;
export type LuauAsset = (typeof LuauAsset)[keyof typeof LuauAsset];

/** The computers a release is pinned for. Wire values: never rename. */
export const LuauPlatform = {
  MacArm64: "darwin-arm64",
  MacX64: "darwin-x64",
  WindowsX64: "win32-x64",
} as const;
export type LuauPlatform = (typeof LuauPlatform)[keyof typeof LuauPlatform];
/** A pin every computer uses: the type definitions are one text file. */
const ANY_PLATFORM = "any";

/** One downloadable file, pinned by its version, size and sha256. */
export interface PinnedAsset {
  asset: LuauAsset;
  version: string;
  platform: LuauPlatform | typeof ANY_PLATFORM;
  url: string;
  sha256: string;
  bytes: number;
}

const LUAU_LSP_VERSION = "1.70.1";
const SELENE_VERSION = "0.32.0";
const STYLUA_VERSION = "2.6.0";
const LUAU_LSP_RELEASE = `https://github.com/JohnnyMorganz/luau-lsp/releases/download/${LUAU_LSP_VERSION}`;
const SELENE_RELEASE = `https://github.com/Kampfkarren/selene/releases/download/${SELENE_VERSION}`;
const STYLUA_RELEASE = `https://github.com/JohnnyMorganz/StyLua/releases/download/v${STYLUA_VERSION}`;

/** luau-lsp's Roblox definitions for game scripts (no plugin or Roblox-only APIs), at luau-lsp's own tag. */
export const ROBLOX_TYPES = {
  asset: LuauAsset.RobloxTypes,
  version: LUAU_LSP_VERSION,
  platform: ANY_PLATFORM,
  url: `https://raw.githubusercontent.com/JohnnyMorganz/luau-lsp/${LUAU_LSP_VERSION}/scripts/globalTypes.None.d.luau`,
  sha256: "9ad75109b8dc9197f6d1726208bfa0b12de47c3a43672a4fa43227f0cec609ee",
  bytes: 677_555,
} as const satisfies PinnedAsset;

/**
 * The pinned releases. selene ships no Intel Mac build, so an Intel Mac gets none; luau-lsp's Mac
 * build is one universal binary. Each sha256 was taken from the release asset itself.
 */
export const PINNED = [
  {
    asset: LuauAsset.LuauLsp,
    version: LUAU_LSP_VERSION,
    platform: LuauPlatform.MacArm64,
    url: `${LUAU_LSP_RELEASE}/luau-lsp-macos.zip`,
    sha256: "7d3936e8dec6dc77547abd061d2e950da392562a5f94858b880f23dba50d84cd",
    bytes: 7_700_771,
  },
  {
    asset: LuauAsset.LuauLsp,
    version: LUAU_LSP_VERSION,
    platform: LuauPlatform.MacX64,
    url: `${LUAU_LSP_RELEASE}/luau-lsp-macos.zip`,
    sha256: "7d3936e8dec6dc77547abd061d2e950da392562a5f94858b880f23dba50d84cd",
    bytes: 7_700_771,
  },
  {
    asset: LuauAsset.LuauLsp,
    version: LUAU_LSP_VERSION,
    platform: LuauPlatform.WindowsX64,
    url: `${LUAU_LSP_RELEASE}/luau-lsp-win64.zip`,
    sha256: "64225b9738102a30de6ee09fb28e5a3827edc402ecf2a6364af570312468159f",
    bytes: 5_358_589,
  },
  {
    asset: LuauAsset.Selene,
    version: SELENE_VERSION,
    platform: LuauPlatform.MacArm64,
    url: `${SELENE_RELEASE}/selene-${SELENE_VERSION}-macos.zip`,
    sha256: "d8aa4701530a81334836f9c5e3bf38b91f633d9ad88f4d15cf29f63fe8589dc0",
    bytes: 3_274_406,
  },
  {
    asset: LuauAsset.Selene,
    version: SELENE_VERSION,
    platform: LuauPlatform.WindowsX64,
    url: `${SELENE_RELEASE}/selene-${SELENE_VERSION}-windows.zip`,
    sha256: "c8b693de81d0ddc11490d8e1170dd98d775c2b21431144bd8286f738ef416109",
    bytes: 3_053_713,
  },
  {
    asset: LuauAsset.StyLua,
    version: STYLUA_VERSION,
    platform: LuauPlatform.MacArm64,
    url: `${STYLUA_RELEASE}/stylua-macos-aarch64.zip`,
    sha256: "dab9b66d340ca5ffc8225211f1dcf89b84783e09b8cbec8c518497eba81f3c42",
    bytes: 3_038_001,
  },
  {
    asset: LuauAsset.StyLua,
    version: STYLUA_VERSION,
    platform: LuauPlatform.MacX64,
    url: `${STYLUA_RELEASE}/stylua-macos-x86_64.zip`,
    sha256: "90779aa873837b2dff8eb3361bd27950303914c24265a59cae0a0d0629d71585",
    bytes: 3_139_236,
  },
  {
    asset: LuauAsset.StyLua,
    version: STYLUA_VERSION,
    platform: LuauPlatform.WindowsX64,
    url: `${STYLUA_RELEASE}/stylua-windows-x86_64.zip`,
    sha256: "fd13b4014e3b779c244bbc03f2c282e357f15bc526de6a6fa5ecbc447538313c",
    bytes: 2_946_498,
  },
  ROBLOX_TYPES,
] as const satisfies readonly PinnedAsset[];

/** The hosts a download may reach: GitHub's release pages, its asset hosts, and its raw files. */
export const LUAU_HOSTS: readonly string[] = [
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
];
/** The largest file Add Luau checks takes, whatever its pin says. */
export const MAX_LUAU_ASSET_BYTES = 32 * 1024 * 1024;
/** How long one file may take to download. */
export const LUAU_DOWNLOAD_MAX_MS = 5 * MINUTE_MS;
/** How long unpacking one archive, or selene's first run, may take. */
const LUAU_UNPACK_MAX_MS = MINUTE_MS;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const BYTES_PER_MB = 1024 * 1024;

/** The plugin storage's folder for the checks: downloads, selene's home and each check's own folder. */
export const LUAU_FOLDER = "luau";
/** selene's home while Genex's own selene runs: its Roblox library is cached there, not in the person's. */
const SELENE_HOME = "home";
/** Where selene first runs, to fetch Roblox's library while the person is adding the checks. */
const WARM_FOLDER = "warm";
const MAC_UNZIP = "/usr/bin/ditto";
const WINDOWS_ROOT = "C:\\Windows";

/** The computer a pin is chosen for: Windows on Arm runs the x64 build; anything else gets none. */
export function luauPlatform(platform: NodeJS.Platform, arch: string): LuauPlatform | undefined {
  if (platform === "darwin" && arch === "arm64") return LuauPlatform.MacArm64;
  if (platform === "darwin" && arch === "x64") return LuauPlatform.MacX64;
  const windowsBuild = arch === "x64" || arch === "arm64";
  return platform === "win32" && windowsBuild ? LuauPlatform.WindowsX64 : undefined;
}

/** The pins for one computer: its programs, then the type definitions. */
export function pinnedFor(platform: LuauPlatform): PinnedAsset[] {
  return PINNED.filter((pin) => pin.platform === platform || pin.platform === ANY_PLATFORM);
}

/** A program's file name on a system. */
export const programName = (tool: LuauTool, platform: NodeJS.Platform): string =>
  platform === "win32" ? `${tool}.exe` : tool;

/** The file a pin becomes in its folder: the program it holds, or the definitions file's own name. */
function pinnedFile(pin: PinnedAsset, platform: NodeJS.Platform): string {
  if (pin.asset === LuauAsset.RobloxTypes) return path.posix.basename(new URL(pin.url).pathname);
  return programName(pin.asset, platform);
}

/** A pin's folder in the plugin storage: one per asset and version, so a new pin never mixes with an old one. */
const pinnedFolder = (pin: Pick<PinnedAsset, "asset" | "version">) => `${pin.asset}-${pin.version}`;

/** A checking program as found: its file, and whether it is Genex's own download. */
export interface LuauProgram {
  tool: LuauTool;
  file: string;
  ours: boolean;
}

/** What the checks can use on this computer. */
export interface LuauToolset {
  programs: Partial<Record<LuauTool, LuauProgram>>;
  /** luau-lsp's Roblox definitions, in Genex's storage. */
  definitions?: string;
}

/** Where `findTools` looks; tests hand in a fake disk. */
export interface FindToolsDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  fs: Pick<LocateFs, "lstat" | "realpath">;
}

/** The person's own bin folders the Roblox tool managers fill. */
const MANAGER_BINS = [".rokit", ".aftman", ".foreman"] as const;

/** The folders searched for a program, in order: PATH's absolute entries, then the tool managers' bins. */
function searchFolders(deps: FindToolsDeps): string[] {
  const host = deps.platform === "win32" ? path.win32 : path.posix;
  const listed = (envPath(deps.env) ?? "").split(host.delimiter).filter((dir) => dir && host.isAbsolute(dir));
  const managers = MANAGER_BINS.map((folder) => host.join(deps.home, folder, "bin"));
  return [...new Set([...listed, ...managers])];
}

/** Whether `file` is a program: a plain file, or a link that ends at one. */
async function isProgram(fs: FindToolsDeps["fs"], file: string): Promise<boolean> {
  const info = await fs.lstat(file);
  if (!info) return false;
  if (!info.link) return info.file;
  const target = await fs.realpath(file).catch(() => undefined);
  return Boolean(target && (await fs.lstat(target))?.file);
}

/** Whether `file` in Genex's storage is a plain file: Genex never follows a link it didn't make. */
async function isOurs(fs: FindToolsDeps["fs"], file: string): Promise<boolean> {
  const info = await fs.lstat(file);
  return Boolean(info?.file && !info.link);
}

/** The pinned version of a program, the same on every computer. */
const pinnedVersion = (tool: LuauTool) => PINNED.find((pin) => pin.asset === tool)?.version ?? "";

/** The checking programs and definitions on this computer: the person's own first, then Genex's. */
export async function findTools(deps: FindToolsDeps, storage: string): Promise<LuauToolset> {
  const host = deps.platform === "win32" ? path.win32 : path.posix;
  const folders = searchFolders(deps);
  const programs: LuauToolset["programs"] = {};
  for (const tool of LUAU_TOOLS) {
    const name = programName(tool, deps.platform);
    for (const folder of folders) {
      const file = host.join(folder, name);
      if (!(await isProgram(deps.fs, file))) continue;
      programs[tool] = { tool, file, ours: false };
      break;
    }
    if (programs[tool]) continue;
    const ours = host.join(storage, LUAU_FOLDER, pinnedFolder({ asset: tool, version: pinnedVersion(tool) }), name);
    if (await isOurs(deps.fs, ours)) programs[tool] = { tool, file: ours, ours: true };
  }
  const definitions = host.join(storage, LUAU_FOLDER, pinnedFolder(ROBLOX_TYPES), pinnedFile(ROBLOX_TYPES, "darwin"));
  return (await isOurs(deps.fs, definitions)) ? { programs, definitions } : { programs };
}

/** The pins this computer still lacks: a program found nowhere, or the definitions. */
export function missingAssets(toolset: LuauToolset, platform: LuauPlatform): PinnedAsset[] {
  return pinnedFor(platform).filter((pin) =>
    pin.asset === LuauAsset.RobloxTypes ? !toolset.definitions : !toolset.programs[pin.asset],
  );
}

/** The download size of `pins` in whole megabytes, for the confirmation. */
export function downloadMegabytes(pins: readonly PinnedAsset[]): number {
  return Math.max(1, Math.round(pins.reduce((sum, pin) => sum + pin.bytes, 0) / BYTES_PER_MB));
}

/** The environment Genex's own selene runs with: its home in the storage, so its cache stays there. */
export function seleneEnv(storage: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  if (platform === "win32") return {};
  const home = path.join(storage, LUAU_FOLDER, SELENE_HOME);
  return { HOME: home, XDG_CACHE_HOME: path.join(home, ".cache") };
}

/** Why Add Luau checks didn't add them. Wire values: never rename. */
export const LuauAddRefusal = {
  Unsupported: "unsupported",
  NotHttps: "not-https",
  OtherHost: "other-host",
  TooLarge: "too-large",
  Mismatch: "mismatch",
  DownloadFailed: "download-failed",
  Unpack: "unpack-failed",
  /** The storage's luau folder is a link or no folder. */
  Linked: "linked",
  Cancelled: "cancelled",
} as const;
export type LuauAddRefusal = (typeof LuauAddRefusal)[keyof typeof LuauAddRefusal];

/** Add Luau checks stopped, in plain words; nothing it fetched was kept. */
export class LuauAddError extends Error {
  readonly code: LuauAddRefusal;
  constructor(code: LuauAddRefusal) {
    super(MESSAGE.Luau.Refused[code]());
    this.name = "LuauAddError";
    this.code = code;
  }
}

/** The network, the unpacker and the storage Add Luau checks works with; tests hand in fakes. */
export interface AddLuauDeps {
  platform: NodeJS.Platform;
  /** The processor; this computer's by default. */
  arch?: string;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  /** Runs the unpacker and selene's first run, by full path with an argument list. */
  run: InstallRun;
  storage: string;
  signal: AbortSignal;
  /** A signal that ends after `ms`; the system's timer by default. */
  timeout?(ms: number): AbortSignal;
}

/** What Add Luau checks put in place, in pin order. */
export interface LuauAdded {
  assets: LuauAsset[];
}

function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new LuauAddError(LuauAddRefusal.Cancelled);
}

/** A link a download may follow: HTTPS, on one of GitHub's hosts, no port and no credentials. */
function checkedUrl(raw: string, base?: string): URL {
  const url = new URL(raw, base);
  if (url.protocol !== "https:") throw new LuauAddError(LuauAddRefusal.NotHttps);
  const plain = url.port === "" && !url.username && !url.password;
  if (!LUAU_HOSTS.includes(url.hostname) || !plain) throw new LuauAddError(LuauAddRefusal.OtherHost);
  return url;
}

/** The pin's response, following only redirects that stay on GitHub's hosts over HTTPS. */
async function fetchChecked(fetchFn: typeof fetch, url: URL, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetchFn(current.href, { redirect: "manual", signal });
    if (!REDIRECT_STATUS.has(response.status)) return response;
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    if (!location) throw new LuauAddError(LuauAddRefusal.DownloadFailed);
    current = checkedUrl(location, current.href);
  }
  throw new LuauAddError(LuauAddRefusal.DownloadFailed);
}

/** Writes `body` into `file`, never past `bytes`; answers its sha256 and size. */
async function writePinned(body: ReadableStream<Uint8Array>, file: string, bytes: number, signal: AbortSignal) {
  const reader = body.getReader();
  const stop = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", stop, { once: true });
  const handle = await open(file, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new LuauAddError(LuauAddRefusal.DownloadFailed);
      if (done) return { size, sha256: hash.digest("hex") };
      size += value.byteLength;
      if (size > bytes) throw new LuauAddError(LuauAddRefusal.TooLarge);
      hash.update(value);
      await handle.write(value);
    }
  } finally {
    signal.removeEventListener("abort", stop);
    await handle.close();
    if (size > bytes || signal.aborted) await reader.cancel().catch(() => undefined);
  }
}

/** Downloads one pin into `file`, refusing anything that isn't exactly its pinned bytes. */
async function downloadPin(deps: AddLuauDeps, pin: PinnedAsset, file: string): Promise<void> {
  const limit = (deps.timeout ?? AbortSignal.timeout)(LUAU_DOWNLOAD_MAX_MS);
  const signal = AbortSignal.any([deps.signal, limit]);
  const failed = (error: unknown): never => {
    throwIfStopped(deps.signal);
    if (error instanceof LuauAddError) throw error;
    throw new LuauAddError(LuauAddRefusal.DownloadFailed);
  };
  const response = await fetchChecked(deps.fetch, checkedUrl(pin.url), signal).catch(failed);
  if (!response.ok || !response.body) throw new LuauAddError(LuauAddRefusal.DownloadFailed);
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (declared > pin.bytes) throw new LuauAddError(LuauAddRefusal.TooLarge);
  const written = await writePinned(response.body, file, pin.bytes, signal).catch(failed);
  if (written.size !== pin.bytes || written.sha256 !== pin.sha256) throw new LuauAddError(LuauAddRefusal.Mismatch);
}

/** The unpacker for this system: `ditto` on a Mac, Windows' own `tar` by its full path. */
function unpackCommand(deps: AddLuauDeps, archive: string, into: string): { file: string; args: string[] } {
  if (deps.platform !== "win32") return { file: MAC_UNZIP, args: ["-x", "-k", archive, into] };
  const root = envValue(deps.env, "SystemRoot");
  const system = root && isWindowsPath(root) ? root : WINDOWS_ROOT;
  return { file: path.win32.join(system, "System32", "tar.exe"), args: ["-xf", archive, "-C", into] };
}

/** Unpacks a checked archive into `into` and answers its program, a plain file made runnable. */
async function unpack(deps: AddLuauDeps, pin: PinnedAsset, archive: string, into: string): Promise<string> {
  await mkdir(into);
  const command = unpackCommand(deps, archive, into);
  const ran = await deps.run(command.file, command.args, { timeoutMs: LUAU_UNPACK_MAX_MS }).catch(() => undefined);
  if (ran?.code !== 0) throw new LuauAddError(LuauAddRefusal.Unpack);
  const program = path.join(into, pinnedFile(pin, deps.platform));
  const info = await lstat(program).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new LuauAddError(LuauAddRefusal.Unpack);
  if (deps.platform !== "win32") await chmod(program, 0o755);
  return program;
}

/** The storage's luau folder, made when missing; a link or anything but a folder is refused. */
async function luauRoot(storage: string): Promise<string> {
  const root = path.join(storage, LUAU_FOLDER);
  const info = await lstat(root).catch(() => undefined);
  if (!info) await mkdir(root, { recursive: true });
  else if (info.isSymbolicLink() || !info.isDirectory()) throw new LuauAddError(LuauAddRefusal.Linked);
  return root;
}

/** Each pin's file staged in `temp`, downloaded and checked first, unpacked only once all matched. */
async function stage(deps: AddLuauDeps, pins: readonly PinnedAsset[], temp: string): Promise<Map<PinnedAsset, string>> {
  const downloads = new Map<PinnedAsset, string>();
  for (const [index, pin] of pins.entries()) {
    throwIfStopped(deps.signal);
    // Each file keeps its release name, in a folder of its own.
    const folder = path.join(temp, String(index));
    await mkdir(folder);
    const file = path.join(folder, path.posix.basename(new URL(pin.url).pathname));
    await downloadPin(deps, pin, file);
    downloads.set(pin, file);
  }
  const staged = new Map<PinnedAsset, string>();
  for (const [index, pin] of pins.entries()) {
    throwIfStopped(deps.signal);
    const file = downloads.get(pin) as string;
    if (pin.asset === LuauAsset.RobloxTypes) {
      const folder = path.join(temp, `${index}-out`);
      await mkdir(folder);
      await rename(file, path.join(folder, pinnedFile(pin, deps.platform)));
      staged.set(pin, folder);
    } else staged.set(pin, path.dirname(await unpack(deps, pin, file, path.join(temp, `${index}-out`))));
  }
  return staged;
}

/** Runs Genex's selene once, so it fetches Roblox's library into Genex's storage while the person is adding the checks. */
async function warmSelene(deps: AddLuauDeps, root: string, selene: string): Promise<void> {
  const warm = path.join(root, WARM_FOLDER);
  await mkdir(warm, { recursive: true });
  await mkdir(path.join(root, SELENE_HOME), { recursive: true });
  await writeFile(path.join(warm, "selene.toml"), 'std = "roblox"\n');
  await writeFile(path.join(warm, "warm.luau"), "return nil\n");
  const env = seleneEnv(deps.storage, deps.platform);
  const args = ["--display-style=Quiet", "--config", path.join(warm, "selene.toml"), path.join(warm, "warm.luau")];
  await deps.run(selene, args, { timeoutMs: LUAU_UNPACK_MAX_MS, env }).catch(() => undefined);
}

/**
 * Downloads `pins` (this computer's when not given) into the plugin's storage: all checked before
 * any is unpacked, all moved into place or none. Rejects with a `LuauAddError`; its temporary
 * folder never stays.
 */
export async function addLuauChecks(deps: AddLuauDeps, pins?: readonly PinnedAsset[]): Promise<LuauAdded> {
  const platform = luauPlatform(deps.platform, deps.arch ?? process.arch);
  const chosen = pins ?? (platform ? pinnedFor(platform) : undefined);
  if (!chosen || chosen.length === 0) throw new LuauAddError(LuauAddRefusal.Unsupported);
  for (const pin of chosen) checkedUrl(pin.url);
  throwIfStopped(deps.signal);
  const root = await luauRoot(deps.storage);
  const temp = await mkdtemp(path.join(root, ".incoming-"));
  try {
    const staged = await stage(deps, chosen, temp);
    throwIfStopped(deps.signal);
    for (const [pin, folder] of staged) {
      const target = path.join(root, pinnedFolder(pin));
      await rm(target, { recursive: true, force: true });
      await rename(folder, target);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  const selene = chosen.find((pin) => pin.asset === LuauAsset.Selene);
  if (selene) await warmSelene(deps, root, path.join(root, pinnedFolder(selene), pinnedFile(selene, deps.platform)));
  return { assets: chosen.map((pin) => pin.asset) };
}

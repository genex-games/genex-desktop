/**
 * The Seatbelt profile a C++ · raylib game runs under on a Mac: deny by default, start only the
 * bundle's own executable, read only the system and the bundle, write only the run's `state/`, no
 * network, no way out of its process group, and no OpenGL (the file deny on `OpenGL.framework` and
 * `AppleMetalOpenGLRenderer.bundle`; the game draws through the bundled Metal-only ANGLE). A
 * headless run reaches no WindowServer; a window run adds exactly what a window needs; an embedded
 * run (Live) is headless plus IOSurface and the one frames service its host checked in. The host
 * writes the text into `<layout.nativeRuns>/<runId>/profile.sb` and passes the paths and the frames
 * service as `-D` parameters, so no path or name is ever spliced into the profile text.
 *
 * The allow-lists are the ones measured on macOS 26.6.2 (Apple M4 Max) for a Metal device, an MSL
 * compile, CoreAudio output and, windowed, an AppKit window with a Metal layer: every name not
 * listed was denied there without breaking any of those. A game whose host-written Info.plist names
 * a studio bundle id (`games.genex.game.` and 12 hex digits, one per game folder) also gets its own
 * Metal shader cache (LG-14, owner decision D3): `<DARWIN_USER_CACHE_DIR>/<its id>`, the folder Metal
 * keys by that id, made by the host and checked to be no link, plus the two metadata reads and the
 * dirhelper lookup Metal needs to find it (measured on macOS 26, M4 Max: a pipeline the box compiled
 * cold every run in about 250 ms takes 8-20 ms from the cache). The cache is never shared: no other
 * game's id and no other application's folder is ever granted.
 */
import { constants as FS } from "node:fs";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../shared/errors.ts";
import {
  type FdGameEnv,
  NATIVE_BUNDLE_APP,
  NATIVE_FRAMES_SERVICE_PREFIX,
  NativeEnv,
  NativeError,
  NativeRefusal,
  NativeRunMode,
} from "../shared/native-contract.ts";
import { openNoFollow } from "./fsx.ts";
import { bundleExecutable, isBundleId, isRunId, RunDirLayout } from "./native-bundle.ts";
import { darwinUserCacheDir, LEAVE_GROUP_SYSCALLS, quote } from "./plugins/native-process.ts";

const MESSAGE = {
  Unsupported: (mode: string) => `a ${mode} run has no game profile`,
  BadPath: (name: string) => `the game profile's ${name} must be a plain absolute path inside the run directory`,
  NotTheLayout: (name: string, folder: string) => `the game profile's ${name} must be the run directory's ${folder}`,
  ExeOutsideBundle: "the game's executable must be inside its bundle",
  NotTheExecutable: "a game starts only its bundle's own executable, Game.app/Contents/MacOS/game",
  BadRunTag: "the game profile's run tag must be a short plain word",
  BadRunId: "a run id is 12 to 32 lowercase hexadecimal characters",
  BadNonce: "a run's nonce is 1 to 128 letters, digits, '-' or '_'",
  FramesOutsideEmbedded: "only an embedded run looks up a frames service",
  NotTheRunFrames: "an embedded run looks up only its own frames service, the prefix and its run id",
  NotTheRunDir: "a game starts only from its own run directory in the native-runs folder",
  NotARunFolder: (name: string) => `the run's ${name} is not a folder of its own`,
  AlreadyStarted: "this run directory has started a game already",
  Unreadable: (detail: string) => `the run directory cannot be checked: ${detail}`,
  BadMetalCache: "a game's Metal cache is its own bundle id's folder, directly in the user's cache folder",
} as const;

/** A refusal for anything about a run the host cannot vouch for. */
const refused = (message: string) => new NativeError(NativeRefusal.Unsupported, message);

/** The `-D` parameters a game profile reads (`sandbox-exec -D NAME=value`). Wire names: the profile text spells them. */
export const GameProfileParam = {
  /** Tags every denial the profile logs, so a run's denials can be read back. */
  RunTag: "RUN_TAG",
  /** The one program the profile lets start: the bundle's realpath'd executable. */
  Exe: "EXE",
  /** `<runDir>/bundle`, readable. */
  Bundle: "BUNDLE",
  /** `<runDir>/state`, the only writable path. */
  State: "STATE",
  /** Embedded runs only: the run's own frames service, `NATIVE_FRAMES_SERVICE_PREFIX` + its run id. */
  Frames: "FRAMES",
  /** The user's cache folder (real path), whose metadata Metal reads to find the game's own cache. */
  MetalCacheRoot: "METAL_CACHE_ROOT",
  /** `<METAL_CACHE_ROOT>/<the game's bundle id>`: its own Metal shader cache, readable and writable. */
  MetalCache: "METAL_CACHE",
} as const;
export type GameProfileParam = (typeof GameProfileParam)[keyof typeof GameProfileParam];

/** What one profile is for. The frames service is a `-D` parameter, never part of the text. */
export interface GameProfileOptions {
  mode: NativeRunMode;
  /** Whether the run is granted its own Metal shader cache (`METAL_CACHE`, LG-14). */
  metalCache?: boolean;
}

/** The parameters a run may go without: FRAMES (embedded runs only) and its Metal cache (LG-14). */
type OptionalParam =
  | typeof GameProfileParam.Frames
  | typeof GameProfileParam.MetalCacheRoot
  | typeof GameProfileParam.MetalCache;

/** The values of one run's `-D` parameters: FRAMES only for an embedded run, the Metal cache only when granted. */
export type GameProfileValues = Record<Exclude<GameProfileParam, OptionalParam>, string> &
  Partial<Record<OptionalParam, string>>;

/** The program that applies a profile to the game it then becomes (exec in place: the game keeps its pid). */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** The run directory's own file beside the game's two folders (`RunDirLayout`): the profile the host wrote. */
const PROFILE_FILE = "profile.sb";
/** The order `-D` parameters are passed in; FRAMES, an embedded run's, follows them. */
const DEFINE_ORDER = [GameProfileParam.RunTag, GameProfileParam.Exe, GameProfileParam.Bundle, GameProfileParam.State];
/** What a run tag and a nonce may be spelled with (a run id: `isRunId`). */
const RUN_TAG = /^[A-Za-z0-9._-]{1,96}$/;
const NONCE = /^[A-Za-z0-9_-]{1,128}$/;
/** A quote or a control character: never part of a path a profile parameter carries. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point: they are refused.
const UNSAFE_IN_PATH = /["\x00-\x1f\x7f]/;
/** The ANGLE-Metal backend, named again in the environment beside the Metal-only build. */
const ANGLE_PLATFORM = "metal";
/** The protocol pipe's descriptor: stdio slot 3. */
const PROTOCOL_FD = "3";
/** The Mach service that tells a process where its user's cache folder is (Metal asks it for its cache). */
const DIRHELPER_SERVICE = "com.apple.bsd.dirhelper";
/** `/var`, the link the user's cache folder is named through (`/var/folders/...`), whose metadata Metal reads. */
const VAR_LINK = "/var";
/** The most of a run bundle's Info.plist read for its bundle id (the host writes a few hundred bytes). */
const INFO_PLIST_MAX_BYTES = 64 * 1024;
/** The bundle id entry of the Info.plist the host writes (`bundleIdentityEntries`). */
const PLIST_BUNDLE_ID = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/;

/** Apple's OpenGL: its framework and the renderer bundle CGL loads. Unreadable, so no GL context can exist. */
const OPENGL_FILES = [
  "/System/Library/Extensions/AppleMetalOpenGLRenderer.bundle",
  "/System/Library/Frameworks/OpenGL.framework",
];

/** One mode's measured allowances, beyond the rules every game profile has. */
interface ModeRules {
  sysctls: readonly string[];
  /** Single files readable beyond `/`, `/System/Library` and the bundle. */
  files: readonly string[];
  userClients: readonly string[];
  services: readonly string[];
  /** Services named by a `-D` parameter, after `services`: an embedded run's frames service. */
  serviceParams: readonly GameProfileParam[];
}

/** Metal (device and MSL compiles) and CoreAudio output: what every game reaches. */
const GAME_SERVICES = [
  "com.apple.MTLCompilerService",
  "com.apple.audio.AudioComponentRegistrar",
  "com.apple.audio.audiohald",
];

/**
 * Rust std reads the page size to place the main thread's stack guard, and aborts before `main`
 * without it (M0a.10a measurement; approved as R1 headless and R2 windowed, M0a.10 approval.md).
 */
const RUST_PAGE_SIZE = "hw.pagesize_compat";

/** Agent runs: no WindowServer, no LaunchServices, no IOSurface. */
const HEADLESS: ModeRules = {
  sysctls: [
    "hw.ephemeral_storage",
    "hw.memsize",
    "hw.ncpu",
    // R1 (approval.md, headless profile).
    RUST_PAGE_SIZE,
    "hw.perflevel0.logicalcpu",
    "hw.perflevel1.logicalcpu",
    "kern.bootargs",
    "kern.iossupportversion",
    "kern.osproductversion",
    "kern.osrelease",
    "kern.osvariant_status",
    "security.mac.lockdown_mode_state",
    "sysctl.proc_translated",
  ],
  files: [],
  userClients: ["AGXDeviceUserClient"],
  services: GAME_SERVICES,
  serviceParams: [],
};

/**
 * The person's Play window: the WindowServer session, the LaunchServices check-in AppKit aborts
 * without, IOSurface for drawables and libobjc-trampolines (loaded from disk by AppKit), and for a
 * wgpu window the Core Animation render server and WindowManager (R3, R4). No pasteboard, Dock,
 * app launching, AppleEvents, screen capture or input-method server.
 */
const WINDOW: ModeRules = {
  sysctls: [
    "hw.ephemeral_storage",
    "hw.logicalcpu_max",
    "hw.memsize",
    "hw.ncpu",
    // R2 (approval.md, windowed profile).
    RUST_PAGE_SIZE,
    "hw.perflevel0.logicalcpu",
    "hw.perflevel1.logicalcpu",
    "hw.physicalcpu_max",
    "kern.bootargs",
    "kern.hv_vmm_present",
    "kern.iossupportversion",
    "kern.osproductversion",
    "kern.osrelease",
    "kern.osvariant_status",
    "kern.willshutdown",
    "security.mac.lockdown_mode_state",
    "sysctl.proc_translated",
  ],
  files: ["/usr/lib/libobjc-trampolines.dylib"],
  userClients: ["AGXDeviceUserClient", "IOSurfaceRootUserClient"],
  services: [
    ...GAME_SERVICES,
    "com.apple.windowserver.active",
    "com.apple.coreservices.launchservicesd",
    // R3 (approval.md, windowed profile): Core Animation's render server, which composites a wgpu
    // window's CAMetalLayer; without it no drawable reaches the screen.
    "com.apple.CARenderServer",
    // R4 (approval.md, windowed profile, with a follow-up): WindowManager; the measured window
    // never became visible without it. Measured with the probe's window raise: the owner rechecks
    // a plain window once with `--no-raise` and drops this if it presents without it.
    "com.apple.windowmanager.server",
  ],
  serviceParams: [],
};

/**
 * A game shown inside Live: the headless rules, plus the IOSurfaces its frames ring is made of and
 * the one Mach service it sends them to, the run's own (S11 on macOS 26.6.2, M4 Max: the host
 * checks the name in; a lookup of any other run's name is refused, 1100). Still no WindowServer.
 */
const EMBEDDED: ModeRules = {
  ...HEADLESS,
  userClients: ["AGXDeviceUserClient", "IOSurfaceRootUserClient"],
  serviceParams: [GameProfileParam.Frames],
};

/** The rules for `mode`; any other value has no profile. */
function modeRules(mode: NativeRunMode): ModeRules {
  if (mode === NativeRunMode.Headless) return HEADLESS;
  if (mode === NativeRunMode.Window) return WINDOW;
  if (mode === NativeRunMode.Embedded) return EMBEDDED;
  throw new NativeError(NativeRefusal.Unsupported, MESSAGE.Unsupported(mode));
}

const param = (name: GameProfileParam) => `(param ${quote(name)})`;
const filters = (kind: string, values: readonly string[]) => values.map((value) => `(${kind} ${quote(value)})`);

/** The rules a granted Metal cache adds after STATE's: the two metadata reads and its folder (LG-14). */
const METAL_CACHE_RULES = [
  `(allow file-read-metadata (literal ${quote(VAR_LINK)}) (literal ${param(GameProfileParam.MetalCacheRoot)}))`,
  `(allow file-read* file-write* (subpath ${param(GameProfileParam.MetalCache)}))`,
];

/** The profile text for `options.mode`: the measured allow-list, the OpenGL file deny last. */
export function gameSandboxProfile(options: GameProfileOptions): string {
  const rules = modeRules(options.mode);
  const reads = ['(literal "/")', '(subpath "/System/Library")', `(subpath ${param(GameProfileParam.Bundle)})`];
  const services = options.metalCache ? [...rules.services, DIRHELPER_SERVICE] : rules.services;
  return [
    "(version 1)",
    `(deny default (with message ${param(GameProfileParam.RunTag)}))`,
    `(allow process-exec (literal ${param(GameProfileParam.Exe)}))`,
    `(allow sysctl-read ${filters("sysctl-name", rules.sysctls).join(" ")})`,
    `(allow file-read* ${[...reads, ...filters("literal", rules.files)].join(" ")})`,
    `(allow file-read* file-write* (subpath ${param(GameProfileParam.State)}))`,
    ...(options.metalCache ? METAL_CACHE_RULES : []),
    `(allow iokit-open ${filters("iokit-user-client-class", rules.userClients).join(" ")})`,
    `(allow mach-lookup ${[...filters("global-name", services), ...rules.serviceParams.map((name) => `(global-name ${param(name)})`)].join(" ")})`,
    // Last, so no allow above can reopen Apple's OpenGL (denying cvmsServ alone does not stop it).
    `(deny file-read* ${filters("subpath", OPENGL_FILES).join(" ")})`,
    `(deny syscall-unix (syscall-number ${LEAVE_GROUP_SYSCALLS.join(" ")}))`,
    "(deny network*)",
    "",
  ].join("\n");
}

/** `child` is `parent` or lies under it, as POSIX paths: a Seatbelt profile's paths are the Mac's. */
function isUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/** Whether `value` is a plain absolute POSIX path: normalized, no trailing slash, no quote or control character. */
function isPlainPath(value: string): boolean {
  const normal = path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !value.endsWith("/");
  return normal && !UNSAFE_IN_PATH.test(value);
}

/** Whether `value` is a plain absolute POSIX path strictly inside `runDir`. */
function isRunPath(value: string, runDir: string): boolean {
  return isPlainPath(value) && value !== runDir && isUnder(runDir, value);
}

/**
 * Whether `cache` is a game's own Metal cache in the cache folder `root`: a studio bundle id's
 * folder directly in it, both plain paths, outside the run directory.
 */
function isGameMetalCache(root: string, cache: string, runDir: string): boolean {
  const plain = isPlainPath(root) && root !== "/" && !isUnder(runDir, root) && !isUnder(root, runDir);
  return plain && cache === path.posix.join(root, path.posix.basename(cache)) && isBundleId(path.posix.basename(cache));
}

/** The `-D` arguments of a granted Metal cache (none without one); refuses half a pair or a cache that is not a game's own. */
function metalCacheDefines(values: GameProfileValues, runDir: string): string[] {
  const root = values[GameProfileParam.MetalCacheRoot];
  const cache = values[GameProfileParam.MetalCache];
  if (root === undefined && cache === undefined) return [];
  if (root === undefined || cache === undefined || !isGameMetalCache(root, cache, runDir)) {
    throw refused(MESSAGE.BadMetalCache);
  }
  return ["-D", `${GameProfileParam.MetalCacheRoot}=${root}`, "-D", `${GameProfileParam.MetalCache}=${cache}`];
}

/** The run directory's folder each folder parameter must name exactly. */
const LAYOUT_FOLDERS = [
  [GameProfileParam.Bundle, RunDirLayout.Bundle],
  [GameProfileParam.State, RunDirLayout.State],
] as const;

/** The frames service a run with id `runId` may look up. */
function framesServiceOf(runId: string): string {
  return `${NATIVE_FRAMES_SERVICE_PREFIX}${runId}`;
}

/**
 * Refuses a frames service that is not exactly what `mode` may have: none outside an embedded run,
 * and for an embedded run the prefix and the run's own id (a run id is plain hex, so the name
 * carries no quote, newline or anything a profile parameter could misread).
 */
function assertFrames(frames: string | undefined, mode: NativeRunMode | undefined, runId: string): void {
  if (mode !== NativeRunMode.Embedded) {
    if (frames !== undefined) throw refused(MESSAGE.FramesOutsideEmbedded);
    return;
  }
  if (!isRunId(runId) || frames !== framesServiceOf(runId)) throw refused(MESSAGE.NotTheRunFrames);
}

/**
 * `sandbox-exec`'s `-D NAME=value` arguments for one run, in a fixed order; refuses any value it
 * cannot vouch for. Every path is strictly inside `runDir`, BUNDLE is exactly `<runDir>/bundle`
 * and STATE exactly `<runDir>/state`, so the profile grants writes to the run's own folder only.
 * Without `runDir` the bundle's parent is taken for it: BUNDLE must still be named `bundle`, with
 * STATE the `state` folder beside it. A granted Metal cache follows: METAL_CACHE_ROOT and METAL_CACHE,
 * a studio bundle id's folder directly in the cache root (LG-14). FRAMES comes last and only for an
 * embedded `mode`: the frames service of the run `runDir` names.
 */
export function gameProfileDefines(
  values: GameProfileValues,
  runDir: string = path.posix.dirname(values[GameProfileParam.Bundle]),
  mode?: NativeRunMode,
): string[] {
  if (!RUN_TAG.test(values[GameProfileParam.RunTag])) {
    throw new NativeError(NativeRefusal.Unsupported, MESSAGE.BadRunTag);
  }
  for (const name of [GameProfileParam.Exe, GameProfileParam.Bundle, GameProfileParam.State] as const) {
    if (!isRunPath(values[name], runDir)) throw new NativeError(NativeRefusal.Unsupported, MESSAGE.BadPath(name));
  }
  for (const [name, folder] of LAYOUT_FOLDERS) {
    if (values[name] !== path.posix.join(runDir, folder)) throw refused(MESSAGE.NotTheLayout(name, folder));
  }
  const exe = values[GameProfileParam.Exe];
  const bundle = values[GameProfileParam.Bundle];
  if (exe === bundle || !isUnder(bundle, exe))
    throw new NativeError(NativeRefusal.Unsupported, MESSAGE.ExeOutsideBundle);
  const frames = values[GameProfileParam.Frames];
  assertFrames(frames, mode, path.posix.basename(runDir));
  const defines = [
    ...DEFINE_ORDER.flatMap((name) => ["-D", `${name}=${values[name]}`]),
    ...metalCacheDefines(values, runDir),
  ];
  return frames === undefined ? defines : [...defines, "-D", `${GameProfileParam.Frames}=${frames}`];
}

/** What `ProcessSandbox.spawnGame` is asked to start; structurally its `GameSpawnRequest`. */
export interface GameLaunchRequest {
  runId: string;
  runDir: string;
  exe: string;
  bundle: string;
  state: string;
  mode: NativeRunMode;
  nonce: string;
  /** Embedded runs only, and required there: `NATIVE_FRAMES_SERVICE_PREFIX` + `runId`. */
  frames?: string;
}

/** How to start a checked game: `sandbox-exec` with its arguments, the exact environment and the working folder. */
export interface GameLaunch {
  file: string;
  args: string[];
  /** Exactly the game's environment: every name, and the frames service only for an embedded run. */
  env: Record<Exclude<FdGameEnv, typeof NativeEnv.FramesService>, string> &
    Partial<Record<typeof NativeEnv.FramesService, string>>;
  cwd: string;
}

/** The run's folders as the kernel sees them, each checked to be the one it must be. */
interface RunFolders {
  runDir: string;
  bundle: string;
  state: string;
  exe: string;
}

/** `dir`'s real path, which must be `expected`, and `dir` itself a folder, not a link. */
async function ownFolder(dir: string, expected: string, name: string): Promise<string> {
  const info = await lstat(dir);
  const real = await realpath(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || real !== expected) throw refused(MESSAGE.NotARunFolder(name));
  return real;
}

/** The request's folders, real, each where the run directory says it is; the executable inside the bundle. */
async function runFolders(request: GameLaunchRequest, root: string): Promise<RunFolders> {
  if (!isRunId(request.runId)) throw refused(MESSAGE.BadRunId);
  // Spelled through the root as the layout names it or as its real path: either way the folder
  // directly in the root, named by the run id.
  const realRoot = await realpath(root);
  const inRoot = path.basename(request.runDir) === request.runId;
  if (!inRoot || (await realpath(path.dirname(request.runDir))) !== realRoot) throw refused(MESSAGE.NotTheRunDir);
  const runDir = await ownFolder(request.runDir, path.join(realRoot, request.runId), "run directory");
  const bundle = await ownFolder(request.bundle, path.join(runDir, RunDirLayout.Bundle), RunDirLayout.Bundle);
  const state = await ownFolder(request.state, path.join(runDir, RunDirLayout.State), RunDirLayout.State);
  // Exactly the app's executable, a regular file reached through no link: any other file in the
  // bundle (an asset, a second program) is never what the profile lets start.
  const exeInfo = await lstat(request.exe);
  const exe = await realpath(request.exe);
  if (!exeInfo.isFile() || exe !== bundleExecutable(bundle)) throw refused(MESSAGE.NotTheExecutable);
  return { runDir, bundle, state, exe };
}

/** Folds an fs failure while checking the request into the typed refusal; a refusal passes through. */
async function checked<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof NativeError ? error : refused(MESSAGE.Unreadable(errorMessage(error)));
  }
}

/** `state/home`, absent (to be made) or already a folder of its own; anything else is refused. */
async function assertHomeFree(home: string): Promise<boolean> {
  const info = await lstat(home).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw refused(MESSAGE.NotARunFolder(RunDirLayout.Home));
  return info === null;
}

/** Writes `profile.sb` into the run directory: created exclusively (one start per run), host-only, never through a link. */
async function writeProfile(file: string, text: string): Promise<void> {
  const handle = await openNoFollow(file, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600).catch((error: unknown) => {
    throw (error as NodeJS.ErrnoException).code === "EEXIST" ? refused(MESSAGE.AlreadyStarted) : error;
  });
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
}

/** A game's own Metal cache: the user's cache folder and `<it>/<the game's bundle id>`, and whether that folder is there yet. */
interface MetalCache {
  root: string;
  dir: string;
  exists: boolean;
}

/**
 * The bundle id the host wrote into the run bundle's Info.plist when it is a studio one (a
 * game's own), else null: no plist, a link, an oversized file or any other id.
 */
async function bundleIdIn(bundle: string): Promise<string | null> {
  const plist = path.join(bundle, NATIVE_BUNDLE_APP, "Contents", "Info.plist");
  const handle = await openNoFollow(plist, FS.O_RDONLY).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > INFO_PLIST_MAX_BYTES) return null;
    const id = PLIST_BUNDLE_ID.exec(await handle.readFile("utf8"))?.[1] ?? "";
    return isBundleId(id) ? id : null;
  } finally {
    await handle.close();
  }
}

/**
 * The run's own Metal cache, read only (nothing is made here): its bundle's studio id under the
 * user's cache folder `cacheRoot` resolves to, when that folder is a plain path and the game's
 * folder in it is absent or a folder of its own. Null (the run starts without a cache) otherwise.
 */
async function metalCacheOf(bundle: string, cacheRoot: () => Promise<string | null>): Promise<MetalCache | null> {
  const id = await bundleIdIn(bundle);
  const root = id === null ? null : await cacheRoot();
  if (id === null || root === null || !isPlainPath(root) || root === "/") return null;
  const dir = path.join(root, id);
  const info = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return { root, dir, exists: false };
  return info.isDirectory() && !info.isSymbolicLink() ? { root, dir, exists: true } : null;
}

/**
 * Checks a start request against the native-runs root, then writes its profile and makes its HOME:
 * the run directory must be `<root>/<runId>` (real, no link), the bundle and state its own
 * folders, the executable inside the bundle. Every check comes before the first write; a refusal
 * is `NativeError(Unsupported)` and leaves the run directory as it was.
 */
export async function prepareGameLaunch(
  request: GameLaunchRequest,
  root: string,
  cacheRoot: () => Promise<string | null> = darwinUserCacheDir,
): Promise<GameLaunch> {
  // A mode without a profile, or a frames service that is not the run's own, is refused before anything is read.
  modeRules(request.mode);
  assertFrames(request.frames, request.mode, request.runId);
  if (!NONCE.test(request.nonce)) throw refused(MESSAGE.BadNonce);
  const run = await checked(() => runFolders(request, root));
  const frames = request.frames === undefined ? {} : { [GameProfileParam.Frames]: request.frames };
  const cache = await checked(() => metalCacheOf(run.bundle, cacheRoot));
  const cacheValues =
    cache === null ? {} : { [GameProfileParam.MetalCacheRoot]: cache.root, [GameProfileParam.MetalCache]: cache.dir };
  const defines = gameProfileDefines(
    {
      [GameProfileParam.RunTag]: `genex-game-${request.runId}`,
      [GameProfileParam.Exe]: run.exe,
      [GameProfileParam.Bundle]: run.bundle,
      [GameProfileParam.State]: run.state,
      ...cacheValues,
      ...frames,
    },
    run.runDir,
    request.mode,
  );
  const home = path.join(run.state, RunDirLayout.Home);
  const makeHome = await checked(() => assertHomeFree(home));
  const profile = path.join(run.runDir, PROFILE_FILE);
  await checked(() => writeProfile(profile, gameSandboxProfile({ mode: request.mode, metalCache: cache !== null })));
  await chmod(run.runDir, 0o700);
  if (makeHome) await mkdir(home, { mode: 0o700 });
  // The game's own cache folder, host-made and never through a link (`metalCacheOf` saw it absent).
  if (cache && !cache.exists) await checked(() => mkdir(cache.dir, { mode: 0o700 }));
  return {
    file: SANDBOX_EXEC,
    args: [...defines, "-f", profile, run.exe],
    env: {
      [NativeEnv.StudioFd]: PROTOCOL_FD,
      [NativeEnv.Nonce]: request.nonce,
      [NativeEnv.StateDir]: run.state,
      [NativeEnv.AnglePlatform]: ANGLE_PLATFORM,
      [NativeEnv.Home]: home,
      ...(request.frames === undefined ? {} : { [NativeEnv.FramesService]: request.frames }),
    },
    cwd: run.state,
  };
}

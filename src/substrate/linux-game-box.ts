/**
 * The bubblewrap box a compiled game (C++ · raylib, or Rust · wgpu since M4.3) runs in when Genex
 * itself runs on Linux (M7, D19 = C).
 *
 * The box has its own user, pid, ipc, uts and network namespaces (no network: the X11 abstract
 * socket lives in the network namespace too), dies with Genex, starts a new session, drops every
 * capability, cannot create further user namespaces, and runs under the seccomp filter of
 * `linux-game-seccomp.ts`, which bubblewrap reads from fd 4 (headless: no socket at all; windowed:
 * AF_UNIX only). Its file system is a read-only root with: the system's `/usr` read-only and its
 * program folders hidden, the run bundle read-only at {@link LINUX_BOX_APP} (the game starts from
 * there), the run's state folder as the only writable bind at {@link LINUX_BOX_STATE}, a private
 * `/tmp`, bubblewrap's minimal `/dev` plus the granted GPU render nodes `/dev/dri/renderD*` (never
 * `card*`, never another device) with only their own device folder from sysfs, and, for windowed
 * play only, a fresh 0700 runtime folder with one Wayland socket and, when the plan asks, the
 * Pulse socket. The environment is cleared and set from a fixed allow-list; fd 3 is the protocol.
 *
 * Display. X11 is never reached: an X11-only session is refused (`x11-only`), because any X11
 * client can read every other window's keystrokes. Wayland is not safe by default either: on the
 * session's own socket, wlroots compositors (sway, Hyprland) offer every client privileged globals
 * (virtual keyboard and pointer, screencopy, data control), so a game could type into a terminal,
 * capture the screen or read the clipboard. The box therefore binds only a per-run socket the host
 * made through the compositor's `wp_security_context_manager_v1` (sandbox engine "genex"), which
 * hides those globals. The helper that makes one is `genex-wayland-context`
 * (`native/genex-game-launcher/linux/wayland_context.c`), started per run by
 * {@link openWaylandContext}; a build without it refuses windowed play `wayland-helper-missing`, and
 * with it a compositor without the protocol is `wayland-unrestricted`.
 *
 * Audio. The Pulse native socket (PulseAudio or pipewire-pulse) lets any client LOAD_MODULE by
 * default: `module-tunnel-sink` or `module-rtp-send` reach a remote address and
 * `module-native-protocol-tcp` opens a listener on the host, which undoes `--unshare-net`; the same
 * socket records from the microphone. So windowed play is muted ({@link LinuxBoxAudio.Muted})
 * unless the plan asks for {@link LinuxBoxAudio.HostPulse}, which needs an owner decision (a
 * restricted path, such as a PCM relay over a second protocol fd or a PipeWire security-context
 * socket, is the open alternative). A Rust game is always muted in the box (plan Q8, decided in
 * M4.3: the device-less backend): its kira mixer runs on the device-less backend, so `audioLevel`
 * stays measurable while nothing reaches a sound server. A headless run gets no display or audio
 * socket; a raylib game draws with surfaceless EGL, a Rust game runs its winit-free loop
 * (`GENEX_HEADLESS=1`).
 *
 * Vulkan. Both stacks draw through the Vulkan loader the bundle ships: the bundled SwiftShader ICD
 * alone without a render node, beside the system's drivers with one. The loader would also load
 * every implicit layer the system lists (overlays, capture tools: code from outside the bundle in
 * the game's process), so the system's layer manifest folders are hidden behind empty read-only
 * folders and `VK_LOADER_LAYERS_DISABLE=~implicit~` is set; the cleared environment keeps the
 * session's `VK_LAYER_PATH`, `VK_INSTANCE_LAYERS` and the rest out.
 *
 * Every host path is checked before anything starts: absolute, normalized, without control
 * characters, equal to its realpath (no link anywhere on it), of the right kind and owner. A
 * refusal is typed, carries the path or value it is about, and spawns nothing; a file-system error
 * becomes a refusal too. Planning reads the file system through an injected {@link LinuxBoxSystem};
 * {@link linuxGameBoxArgs} is pure.
 *
 * Not covered here: bubblewrap cannot mount the state folder or `/tmp` `noexec` and seccomp cannot
 * see paths, so a file the game writes there could still be executed (Landlock's execute right
 * closes that; an open item).
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { lstat, mkdir, readlink, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../shared/duration.ts";
import { BuildTarget, type CompiledStack, GameStack } from "../shared/game-project.ts";
import { DeviceClass } from "../shared/render-quality.ts";
import {
  GameBoxProblem,
  NATIVE_CROSS_EXECUTABLES,
  NativeEnv,
  NativeError,
  NativeRefusal,
  NativeRunMode,
} from "../shared/native-contract.ts";
import { linuxGameSeccompProgram } from "./linux-game-seccomp.ts";
import { isRunId, RunDirLayout } from "./native-bundle.ts";

/** Where the run bundle appears inside the box, read-only. */
export const LINUX_BOX_APP = "/app";
/** Where the run's state folder appears inside the box: the only writable bind. */
export const LINUX_BOX_STATE = "/state";
/** The box's own `XDG_RUNTIME_DIR`, created 0700, holding only the sockets windowed play needs. */
export const LINUX_BOX_RUNTIME = "/run/genex";
/** The Wayland display name inside the box. */
const BOX_WAYLAND_DISPLAY = "wayland-0";
/** The Pulse socket inside a runtime folder (PipeWire serves it through `pipewire-pulse`). */
const PULSE_SOCKET = "pulse/native";
const BOX_WAYLAND_SOCKET = `${LINUX_BOX_RUNTIME}/${BOX_WAYLAND_DISPLAY}`;
const BOX_PULSE_SOCKET = `${LINUX_BOX_RUNTIME}/${PULSE_SOCKET}`;
const BOX_PULSE_DIR = path.posix.dirname(BOX_PULSE_SOCKET);
/** The box's runtime folders are its user's alone. */
const RUNTIME_PERMS = "0700";
/** The fd the protocol pipe has in the game. */
const STUDIO_FD = 3;
/** The fd bubblewrap reads the seccomp program from; it closes it before the game starts. */
const SECCOMP_FD = 4;
/**
 * The spawn's stdio: stdin ignored, stdout and stderr read by the host, fd 3 the protocol pipe
 * (bubblewrap passes inherited descriptors through to the game), fd 4 the seccomp program.
 */
export const LINUX_BOX_STDIO = ["ignore", "pipe", "pipe", "pipe", "pipe"] as const;
/** One stdio entry of the spawn. */
export type LinuxBoxStdio = (typeof LINUX_BOX_STDIO)[number];

/** ANGLE's Vulkan back end: the Linux value of {@link NativeEnv.AnglePlatform}. */
const ANGLE_PLATFORM = "vulkan";
/** Headless EGL without a display server. */
const EGL_SURFACELESS = "surfaceless";
/** GLFW picks its Wayland platform from this session type. */
const SESSION_WAYLAND = "wayland";

/** Where X11 sockets live: never inside a bind, never bound. */
const X11_SOCKET_DIR = "/tmp/.X11-unix";
/** Top-level library folders: a merged-/usr link is recreated, a real folder bound read-only. */
const LIB_ROOTS = ["/lib", "/lib64", "/lib32", "/libx32"] as const;
/** System program folders under `/usr`, hidden behind an empty read-only tmpfs where present. */
const PROGRAM_DIRS = [
  "/usr/bin",
  "/usr/sbin",
  "/usr/libexec",
  "/usr/games",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/local/games",
] as const;
/**
 * The Vulkan loader's layer manifest folders under `/usr` (its `XDG_DATA_DIRS` defaults), hidden
 * the same way where present: no system layer loads into the game.
 */
const VULKAN_LAYER_DIRS = [
  "/usr/share/vulkan/implicit_layer.d",
  "/usr/share/vulkan/explicit_layer.d",
  "/usr/local/share/vulkan/implicit_layer.d",
  "/usr/local/share/vulkan/explicit_layer.d",
] as const;
/** Every folder under `/usr` the box hides behind an empty read-only tmpfs where present. */
const HIDDEN_DIRS = [...PROGRAM_DIRS, ...VULKAN_LAYER_DIRS] as const;
/** The loader's value that skips every implicit layer (Vulkan loader 1.3.234 and newer). */
const NO_IMPLICIT_LAYERS = "~implicit~";
/**
 * The capture class of a Rust game drawn by SwiftShader alone: a CPU rasterizer draws the
 * desktop-high reference profile (TAA with its settle re-renders) far past a capture's deadline,
 * and its pictures are not comparable with a GPU's anyway (pass-1 gate).
 */
const SOFTWARE_REFERENCE_CLASS: DeviceClass = DeviceClass.DesktopLow;
/** A Rust game's winit-free loop: the value `GENEX_HEADLESS` takes. */
const HEADLESS_ON = "1";
/** The dynamic loader's cache: without it the multiarch library folders are not searched. */
const LOADER_CACHE = "/etc/ld.so.cache";
/** Where sysfs lists character devices by number; a granted node's entry is recreated in the box. */
const SYSFS_CHAR = "/sys/dev/char";
/** The only sysfs tree a granted node's device folder may come from. */
const SYSFS_DEVICES = "/sys/devices";
/** The DRM character-device major. */
const DRM_MAJOR = 226;
/** A DRM render node, and nothing else under `/dev`; the number is its minor. */
const RENDER_NODE = /^\/dev\/dri\/renderD([0-9]{1,3})$/;
/** The run nonce, echoed in `ready`. */
const NONCE = /^[A-Za-z0-9_-]{8,128}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
/** Group and other permission bits: a socket's folder must have none. */
const NOT_PRIVATE_BITS = 0o077;
/** `bwrap --version`'s first line, `bubblewrap 0.9.0`. */
const BUBBLEWRAP_VERSION_LINE = /^bubblewrap (\d{1,4})\.(\d{1,4})(?:\.(\d{1,4}))?$/;
/** The oldest bubblewrap the box runs under: 0.8.0 added `--disable-userns`. */
export const BUBBLEWRAP_MIN_VERSION = { major: 0, minor: 8 } as const;

/** Why a run cannot be boxed. Wire values: never rename one. */
export const LinuxBoxRefusal = {
  /** Embedded runs need a frames channel the box does not have. */
  ModeUnsupported: "mode-unsupported",
  /** Not absolute, not normalized, or with a control character. */
  UnsafePath: "unsafe-path",
  /** A path whose realpath differs, or that loops: a link somewhere on it. */
  PathLinked: "path-linked",
  /** The path does not exist (or a file stands where a folder on it should be). */
  Missing: "missing",
  NotADirectory: "not-a-directory",
  NotAFile: "not-a-file",
  /** The planner may not read the path (permissions, a name too long, another file-system error). */
  Unreadable: "unreadable",
  /** The bundle or the state folder belongs to someone else. */
  NotOwned: "not-owned",
  /** The executable or the software ICD is not strictly inside the bundle. */
  OutsideBundle: "outside-bundle",
  /** The bundle and the state folder must be disjoint, from each other and from every socket folder. */
  PathsOverlap: "paths-overlap",
  /** The nonce is not a plain token. */
  UnsafeValue: "unsafe-value",
  /** Not `/dev/dri/renderD<n>` itself, not that DRM device, or without its own sysfs device folder. */
  NotARenderNode: "not-a-render-node",
  /** Windowed play in a session with X11 and no Wayland (one home: `GameBoxProblem`). */
  X11Only: GameBoxProblem.X11Only,
  /** Windowed play with no display session at all. */
  NoWayland: GameBoxProblem.NoWayland,
  /** Windowed play without a per-run security-context Wayland socket. */
  WaylandUnrestricted: GameBoxProblem.WaylandUnrestricted,
  /** The plan asks for the host's Pulse socket and the session has no `XDG_RUNTIME_DIR`. */
  RuntimeDirMissing: "runtime-dir-missing",
  /** A socket's folder belongs to someone else, or others may enter it. */
  SocketFolderNotPrivate: "socket-folder-not-private",
  /** A display or audio socket path that is not a socket. */
  NotASocket: "not-a-socket",
  /** A display or audio socket that belongs to someone else. */
  SocketNotOwned: "socket-not-owned",
  /** bubblewrap started but its fd 4 cannot take the seccomp program; it was killed before the game ran. */
  SeccompNotSent: "seccomp-not-sent",
  /** The Wayland helper exited, answered something else, or did not answer in time: no per-run socket. */
  WaylandContextFailed: "wayland-context-failed",
  /** The run folder is not `<native-runs>/<run id>` itself, with its own `bundle`, `state` and `bundle/game`. */
  NotTheRunDir: "not-the-run-dir",
  /** This run folder has started a game already (its claim exists): one start per run. */
  AlreadyStarted: "already-started",
} as const;
export type LinuxBoxRefusal = (typeof LinuxBoxRefusal)[keyof typeof LinuxBoxRefusal];

/** How windowed play gets sound. Wire values. */
export const LinuxBoxAudio = {
  /** No audio socket: the default (see the module doc). */
  Muted: "muted",
  /** The session's raw Pulse socket: reaches the network and the microphone; an owner decision. */
  HostPulse: "host-pulse",
} as const;
export type LinuxBoxAudio = (typeof LinuxBoxAudio)[keyof typeof LinuxBoxAudio];

/** Linux-only names the box sets beside {@link NativeEnv}. Wire names. */
export const LinuxBoxEnv = {
  RuntimeDir: "XDG_RUNTIME_DIR",
  WaylandDisplay: "WAYLAND_DISPLAY",
  /** "wayland": GLFW picks its Wayland platform from it. */
  SessionType: "XDG_SESSION_TYPE",
  PulseServer: "PULSE_SERVER",
  /** The bundled SwiftShader ICD alone, when no render node is granted. */
  VulkanIcd: "VK_ICD_FILENAMES",
  /** The bundled SwiftShader ICD beside the system's, when a render node is granted. */
  VulkanAddIcd: "VK_ADD_DRIVER_FILES",
  /** "surfaceless", headless runs only. */
  EglPlatform: "EGL_PLATFORM",
  /** The executable's folder, where the game starts: bubblewrap sets it after `--chdir` anyway. */
  WorkingDir: "PWD",
  /** "~implicit~": the Vulkan loader loads none of the system's implicit layers. */
  VulkanLayersDisable: "VK_LOADER_LAYERS_DISABLE",
  /** "1", a Rust game's headless runs only: its winit-free loop (`genex-platform-desktop` mode.rs). */
  Headless: "GENEX_HEADLESS",
  /**
   * The class a Rust game's captures resolve on (genex's `GENEX_RENDER_REFERENCE_CLASS`, a
   * `DeviceClass` value): {@link SOFTWARE_REFERENCE_CLASS} when SwiftShader alone draws; unset with
   * a GPU, whose captures keep the runtime's reference class.
   */
  RenderReferenceClass: "GENEX_RENDER_REFERENCE_CLASS",
} as const;
export type LinuxBoxEnv = (typeof LinuxBoxEnv)[keyof typeof LinuxBoxEnv];

/** The session variables the planner reads besides {@link LinuxBoxEnv}; nothing else reaches the box. */
const SessionVar = { Display: "DISPLAY" } as const;

/** What a checked path must be. */
const PathKind = { Dir: "dir", File: "file", Socket: "socket" } as const;
type PathKind = (typeof PathKind)[keyof typeof PathKind];

/** File-system error codes the planner maps to a refusal of their own; any other is `unreadable`. */
const ERRNO_REFUSAL = new Map<string, LinuxBoxRefusal>([
  ["ENOENT", LinuxBoxRefusal.Missing],
  ["ENOTDIR", LinuxBoxRefusal.Missing],
  ["ELOOP", LinuxBoxRefusal.PathLinked],
]);

/** The part of `fs.Stats` the planner reads. */
export interface LinuxBoxStats {
  uid: number;
  mode: number;
  /** The device number of a character device. */
  rdev: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSocket(): boolean;
  isCharacterDevice(): boolean;
  isSymbolicLink(): boolean;
}

/** The file system and identity the planner checks against; tests inject one. */
export interface LinuxBoxSystem {
  /** This process's uid: the owner the socket folders, sockets, bundle and state must have. */
  uid: number;
  lstat(target: string): Promise<LinuxBoxStats>;
  realpath(target: string): Promise<string>;
  readlink(target: string): Promise<string>;
}

/** The running process's view. */
export const LINUX_BOX_SYSTEM: LinuxBoxSystem = { uid: process.getuid?.() ?? -1, lstat, realpath, readlink };

/** One run to box. */
export interface LinuxBoxRequest {
  mode: NativeRunMode;
  /** The game's stack: how it draws, sounds and runs headless. Absent: C++ · raylib. */
  stack?: CompiledStack;
  /** The run bundle (host-assembled, owned by this user): read-only in the box. */
  bundle: string;
  /** The game's executable, strictly inside `bundle`. */
  exe: string;
  /** The run's state folder (owned by this user): the box's only writable bind. */
  state: string;
  nonce: string;
  /** The render nodes to grant (`/dev/dri/renderD*`); none means the bundled SwiftShader alone. */
  renderNodes: readonly string[];
  /** The bundled SwiftShader ICD manifest, strictly inside `bundle`. */
  softwareIcd: string;
  /**
   * Windowed play: the listening socket the host made for this run through the compositor's
   * `wp_security_context_manager_v1`, in a private folder. Null when the compositor offers none.
   */
  waylandContext: string | null;
  /** Windowed play's sound. */
  audio: LinuxBoxAudio;
  /** The session's environment: only `WAYLAND_DISPLAY`, `DISPLAY` and (for audio) `XDG_RUNTIME_DIR` are read. */
  session: Readonly<Record<string, string | undefined>>;
}

/** The sockets windowed play binds, checked. */
export interface LinuxBoxDisplay {
  /** The run's security-context Wayland socket. */
  wayland: string;
  /** The Pulse socket, or null to play muted. */
  pulse: string | null;
}

/** A granted render node and the sysfs entries its driver reads. */
export interface LinuxBoxRenderNode {
  node: string;
  /** `/sys/dev/char/226:<minor>`, recreated in the box as a link to `sysfsTarget`. */
  sysfsEntry: string;
  /** The node's own sysfs folder, inside `device`. */
  sysfsTarget: string;
  /** The node's device folder under `/sys/devices`: the only sysfs bound, read-only. */
  device: string;
}

/** How the system's top-level folders are recreated in the box. */
export interface LinuxBoxSystemLayout {
  /** Merged-/usr links: `/lib` → `usr/lib`. */
  links: { path: string; target: string }[];
  /** Real top-level library folders, bound read-only. */
  dirs: string[];
  /** Program and Vulkan layer folders present under `/usr`, hidden. */
  hidden: string[];
}

/** The run modes the box runs. */
export type LinuxBoxMode = typeof NativeRunMode.Window | typeof NativeRunMode.Headless;

/** A checked request: everything {@link linuxGameBoxArgs} and the launch need. */
export interface LinuxBoxPlan {
  mode: LinuxBoxMode;
  stack: CompiledStack;
  bundle: string;
  /** The executable's path below the bundle. */
  exe: string;
  /** The software ICD's path below the bundle. */
  softwareIcd: string;
  state: string;
  nonce: string;
  renderNodes: LinuxBoxRenderNode[];
  display: LinuxBoxDisplay | null;
  layout: LinuxBoxSystemLayout;
  /** The seccomp program for this mode, written to fd 4. */
  seccomp: Uint8Array;
}

type Refused = { ok: false; refusal: LinuxBoxRefusal; detail: string };

/** A plan, or the typed refusal and the path or value it was about. */
export type LinuxBoxPlanning = { ok: true; plan: LinuxBoxPlan } | Refused;

/** What the launch needs of the started bubblewrap. Node's `ChildProcess` is one. */
export interface LinuxBoxChild {
  readonly stdio: readonly unknown[];
  kill(signal?: NodeJS.Signals): boolean;
}

/** The spawn options the launch passes; a subset of Node's `SpawnOptions`. */
export interface LinuxBoxSpawnOptions {
  stdio: LinuxBoxStdio[];
  env: Record<string, string>;
  detached: true;
}

/** Starts bubblewrap. Called at most once, and only for a checked plan. Node's `spawn` is one. */
export type LinuxBoxSpawn<T extends LinuxBoxChild> = (file: string, args: string[], options: LinuxBoxSpawnOptions) => T;

/** The writable end of fd 4, as a Node stream has it. */
interface SeccompSink {
  end(chunk: Uint8Array): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

function refuse(refusal: LinuxBoxRefusal, detail: string): Refused {
  return { ok: false, refusal, detail };
}

function isRefusal(value: unknown): value is Refused {
  return typeof value === "object" && value !== null && "ok" in value;
}

function isSink(value: unknown): value is SeccompSink {
  const candidate = value as Partial<SeccompSink> | null | undefined;
  return typeof candidate?.end === "function" && typeof candidate.on === "function";
}

/** Null for an absolute, normalized path without control characters. */
function unsafePath(candidate: string): Refused | null {
  const normalized = path.posix.normalize(candidate);
  const trailing = candidate.length > 1 && candidate.endsWith("/");
  const safe = candidate.startsWith("/") && !CONTROL_CHARACTER.test(candidate) && normalized === candidate && !trailing;
  return safe ? null : refuse(LinuxBoxRefusal.UnsafePath, JSON.stringify(candidate));
}

/** Whether a relative path stays below its base: `..x` does, `..` and `../x` do not. */
function staysBelow(relative: string): boolean {
  const leaves = relative === ".." || relative.startsWith("../");
  return !leaves && !path.posix.isAbsolute(relative);
}

/** Whether `inner` is `outer` or below it. */
function contains(outer: string, inner: string): boolean {
  const relative = path.posix.relative(outer, inner);
  return relative === "" || staysBelow(relative);
}

/** Whether `inner` is strictly below `outer`. */
function strictlyWithin(outer: string, inner: string): boolean {
  return inner !== outer && contains(outer, inner);
}

/** Whether either path holds the other. */
function overlaps(first: string, second: string): boolean {
  return contains(first, second) || contains(second, first);
}

/** The typed refusal for a file-system error on `target`. */
function fileErrorRefusal(error: unknown, target: string): Refused {
  const code = (error as NodeJS.ErrnoException | null)?.code ?? "";
  return refuse(ERRNO_REFUSAL.get(code) ?? LinuxBoxRefusal.Unreadable, target);
}

const KIND_REFUSAL = {
  [PathKind.Dir]: LinuxBoxRefusal.NotADirectory,
  [PathKind.File]: LinuxBoxRefusal.NotAFile,
  [PathKind.Socket]: LinuxBoxRefusal.NotASocket,
} as const satisfies Record<PathKind, LinuxBoxRefusal>;

function hasKind(stats: LinuxBoxStats, kind: PathKind): boolean {
  if (kind === PathKind.Dir) return stats.isDirectory();
  if (kind === PathKind.File) return stats.isFile();
  return stats.isSocket();
}

/** The path's stats when it exists, equals its realpath and has `kind`; else the refusal. */
async function checkedStats(system: LinuxBoxSystem, target: string, kind: PathKind): Promise<LinuxBoxStats | Refused> {
  const unsafe = unsafePath(target);
  if (unsafe) return unsafe;
  try {
    if ((await system.realpath(target)) !== target) return refuse(LinuxBoxRefusal.PathLinked, target);
    const stats = await system.lstat(target);
    if (stats.isSymbolicLink()) return refuse(LinuxBoxRefusal.PathLinked, target);
    return hasKind(stats, kind) ? stats : refuse(KIND_REFUSAL[kind], target);
  } catch (error) {
    return fileErrorRefusal(error, target);
  }
}

/** Windowed play's checked inputs from the request: the Wayland socket and, for audio, the runtime folder. */
interface WindowedSession {
  wayland: string;
  runtimeDir: string | null;
}

/** The folders a bind must stay clear of: X11's and every socket folder the run reads. */
function socketFolders(session: WindowedSession | null): string[] {
  if (!session) return [X11_SOCKET_DIR];
  const folders = [X11_SOCKET_DIR, path.posix.dirname(session.wayland)];
  return session.runtimeDir ? [...folders, session.runtimeDir] : folders;
}

/** The pure checks: nonce, path syntax, containment and overlap. Null when they pass. */
function syntaxRefusal(request: LinuxBoxRequest, guarded: readonly string[]): Refused | null {
  if (!NONCE.test(request.nonce)) return refuse(LinuxBoxRefusal.UnsafeValue, "nonce");
  for (const candidate of [request.bundle, request.state, request.exe, request.softwareIcd]) {
    const unsafe = unsafePath(candidate);
    if (unsafe) return unsafe;
  }
  const binds = [request.bundle, request.state];
  const crowded =
    overlaps(request.bundle, request.state) || binds.some((bind) => guarded.some((dir) => overlaps(bind, dir)));
  if (crowded) return refuse(LinuxBoxRefusal.PathsOverlap, `${request.bundle} ${request.state}`);
  for (const file of [request.exe, request.softwareIcd]) {
    if (!strictlyWithin(request.bundle, file)) return refuse(LinuxBoxRefusal.OutsideBundle, file);
  }
  const node = request.renderNodes.find((candidate) => !RENDER_NODE.test(candidate));
  return node === undefined ? null : refuse(LinuxBoxRefusal.NotARenderNode, JSON.stringify(node));
}

/**
 * Why a session cannot show a boxed window before any socket is looked at: X11 alone (`x11-only`)
 * or no display at all (`no-wayland`); null when it names a Wayland display.
 */
export function sessionDisplayRefusal(
  session: Readonly<Record<string, string | undefined>>,
): typeof LinuxBoxRefusal.X11Only | typeof LinuxBoxRefusal.NoWayland | null {
  if (session[LinuxBoxEnv.WaylandDisplay]) return null;
  return session[SessionVar.Display] ? LinuxBoxRefusal.X11Only : LinuxBoxRefusal.NoWayland;
}

/** The stack a request names; an older caller's request is a raylib game's. */
function stackOf(request: { stack?: CompiledStack }): CompiledStack {
  return request.stack ?? GameStack.RaylibCpp;
}

/** Whether the run gets the host's Pulse socket: a raylib game whose plan asks for it; a Rust game never (Q8). */
function asksHostPulse(request: LinuxBoxRequest): boolean {
  return request.audio === LinuxBoxAudio.HostPulse && stackOf(request) === GameStack.RaylibCpp;
}

/** Windowed play's Wayland socket and, when asked for audio, runtime folder; or why there is none. */
function windowedSession(request: LinuxBoxRequest): WindowedSession | Refused {
  const { session, waylandContext } = request;
  const display = sessionDisplayRefusal(session);
  if (display === LinuxBoxRefusal.X11Only) return refuse(display, SessionVar.Display);
  if (display) return refuse(display, LinuxBoxEnv.WaylandDisplay);
  if (!waylandContext) return refuse(LinuxBoxRefusal.WaylandUnrestricted, LinuxBoxEnv.WaylandDisplay);
  const unsafe = unsafePath(waylandContext);
  if (unsafe) return unsafe;
  if (!asksHostPulse(request)) return { wayland: waylandContext, runtimeDir: null };
  const runtimeDir = session[LinuxBoxEnv.RuntimeDir];
  if (!runtimeDir) return refuse(LinuxBoxRefusal.RuntimeDirMissing, LinuxBoxEnv.RuntimeDir);
  return unsafePath(runtimeDir) ?? { wayland: waylandContext, runtimeDir };
}

/** Null when `dir` is an unlinked folder of ours that nobody else may enter. */
async function checkedPrivateDir(system: LinuxBoxSystem, dir: string): Promise<Refused | null> {
  const stats = await checkedStats(system, dir, PathKind.Dir);
  if (isRefusal(stats)) return stats;
  const isPrivate = stats.uid === system.uid && (stats.mode & NOT_PRIVATE_BITS) === 0;
  return isPrivate ? null : refuse(LinuxBoxRefusal.SocketFolderNotPrivate, dir);
}

/** Null when `socket` is an unlinked socket of ours in a private folder. */
async function checkedSocket(system: LinuxBoxSystem, socket: string): Promise<Refused | null> {
  const folder = await checkedPrivateDir(system, path.posix.dirname(socket));
  if (folder) return folder;
  const stats = await checkedStats(system, socket, PathKind.Socket);
  if (isRefusal(stats)) return stats;
  return stats.uid === system.uid ? null : refuse(LinuxBoxRefusal.SocketNotOwned, socket);
}

/** The checked Pulse socket in `runtimeDir`, or null when there is none (muted play). */
async function checkedPulse(system: LinuxBoxSystem, runtimeDir: string): Promise<string | null | Refused> {
  const folder = await checkedPrivateDir(system, runtimeDir);
  if (folder) return folder;
  const pulse = path.posix.join(runtimeDir, PULSE_SOCKET);
  const refusal = await checkedSocket(system, pulse);
  if (refusal?.refusal === LinuxBoxRefusal.Missing) return null;
  return refusal ?? pulse;
}

/** The checked display and audio sockets windowed play binds. */
async function checkedDisplay(system: LinuxBoxSystem, session: WindowedSession): Promise<LinuxBoxDisplay | Refused> {
  const wayland = await checkedSocket(system, session.wayland);
  if (wayland) return wayland;
  if (!session.runtimeDir) return { wayland: session.wayland, pulse: null };
  const pulse = await checkedPulse(system, session.runtimeDir);
  return isRefusal(pulse) ? pulse : { wayland: session.wayland, pulse };
}

/** The bundle, state, executable and ICD exist as they claim, unlinked, and the folders are ours. */
async function checkedRunPaths(system: LinuxBoxSystem, request: LinuxBoxRequest): Promise<Refused | null> {
  for (const folder of [request.bundle, request.state]) {
    const stats = await checkedStats(system, folder, PathKind.Dir);
    if (isRefusal(stats)) return stats;
    if (stats.uid !== system.uid) return refuse(LinuxBoxRefusal.NotOwned, folder);
  }
  for (const file of [request.exe, request.softwareIcd]) {
    const stats = await checkedStats(system, file, PathKind.File);
    if (isRefusal(stats)) return stats;
  }
  return null;
}

/** glibc's `major()` and `minor()` of a Linux `dev_t`. */
function deviceNumbers(rdev: number): { major: number; minor: number } {
  const dev = BigInt(rdev);
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  return { major: Number(major), minor: Number(minor) };
}

/** Whether the node's sysfs folder is its own and sits in a device folder no wider than its device. */
function isOwnSysfs(target: string, device: string, minor: number): boolean {
  const plain = unsafePath(target) === null && unsafePath(device) === null;
  const nested = strictlyWithin(SYSFS_DEVICES, device) && strictlyWithin(device, target);
  return plain && nested && path.posix.basename(target) === `renderD${minor}`;
}

/** One granted node: itself (its own realpath), a DRM character device of its minor, with its sysfs. */
async function checkedRenderNode(system: LinuxBoxSystem, node: string): Promise<LinuxBoxRenderNode | null> {
  const minor = Number(RENDER_NODE.exec(node)?.[1]);
  if ((await system.realpath(node)) !== node) return null;
  const stats = await system.lstat(node);
  if (!stats.isCharacterDevice()) return null;
  const numbers = deviceNumbers(stats.rdev);
  if (numbers.major !== DRM_MAJOR || numbers.minor !== minor) return null;
  const sysfsEntry = `${SYSFS_CHAR}/${DRM_MAJOR}:${minor}`;
  const sysfsTarget = await system.realpath(sysfsEntry);
  const device = await system.realpath(`${sysfsEntry}/device`);
  return isOwnSysfs(sysfsTarget, device, minor) ? { node, sysfsEntry, sysfsTarget, device } : null;
}

/** The granted render nodes, deduplicated and sorted, each checked with its sysfs. */
async function checkedRenderNodes(
  system: LinuxBoxSystem,
  nodes: readonly string[],
): Promise<LinuxBoxRenderNode[] | Refused> {
  const granted: LinuxBoxRenderNode[] = [];
  for (const node of [...new Set(nodes)].sort()) {
    const checked = await checkedRenderNode(system, node).catch(() => null);
    if (!checked) return refuse(LinuxBoxRefusal.NotARenderNode, node);
    granted.push(checked);
  }
  return granted;
}

/** The path's stats, null when it does not exist, or the refusal for another error. */
async function optionalStats(system: LinuxBoxSystem, target: string): Promise<LinuxBoxStats | null | Refused> {
  try {
    return await system.lstat(target);
  } catch (error) {
    const refusal = fileErrorRefusal(error, target);
    return refusal.refusal === LinuxBoxRefusal.Missing ? null : refusal;
  }
}

/** A top-level link into `/usr` to recreate, null for one that leads elsewhere. */
async function usrLink(system: LinuxBoxSystem, root: string): Promise<LinuxBoxSystemLayout["links"][number] | null> {
  const target = await system.readlink(root);
  const resolved = path.posix.resolve("/", target);
  const intoUsr = !CONTROL_CHARACTER.test(target) && strictlyWithin("/usr", resolved);
  return intoUsr ? { path: root, target } : null;
}

/** Adds one top-level library folder to the layout: a real folder bound, a link into `/usr` recreated. */
async function addLibraryRoot(
  system: LinuxBoxSystem,
  root: string,
  layout: LinuxBoxSystemLayout,
): Promise<Refused | null> {
  const stats = await optionalStats(system, root);
  if (isRefusal(stats)) return stats;
  if (stats?.isDirectory()) layout.dirs.push(root);
  if (!stats?.isSymbolicLink()) return null;
  const link = await usrLink(system, root).catch((error: unknown) => fileErrorRefusal(error, root));
  if (isRefusal(link)) return link;
  if (link) layout.links.push(link);
  return null;
}

/** How this system's top-level library folders and program folders look. */
async function systemLayout(system: LinuxBoxSystem): Promise<LinuxBoxSystemLayout | Refused> {
  const layout: LinuxBoxSystemLayout = { links: [], dirs: [], hidden: [] };
  for (const root of LIB_ROOTS) {
    const refusal = await addLibraryRoot(system, root, layout);
    if (refusal) return refusal;
  }
  for (const dir of HIDDEN_DIRS) {
    const stats = await optionalStats(system, dir);
    if (isRefusal(stats)) return stats;
    if (stats?.isDirectory()) layout.hidden.push(dir);
  }
  return layout;
}

function boxedMode(mode: NativeRunMode): LinuxBoxMode | null {
  if (mode === NativeRunMode.Window || mode === NativeRunMode.Headless) return mode;
  return null;
}

/** Checks one request against the system and returns the plan, or a typed refusal. Starts nothing. */
export async function planLinuxGameBox(
  request: LinuxBoxRequest,
  system: LinuxBoxSystem = LINUX_BOX_SYSTEM,
): Promise<LinuxBoxPlanning> {
  const mode = boxedMode(request.mode);
  if (!mode) return refuse(LinuxBoxRefusal.ModeUnsupported, request.mode);
  const session = mode === NativeRunMode.Window ? windowedSession(request) : null;
  if (isRefusal(session)) return session;
  const syntax = syntaxRefusal(request, socketFolders(session));
  if (syntax) return syntax;
  const display = session ? await checkedDisplay(system, session) : null;
  if (isRefusal(display)) return display;
  const run = await checkedRunPaths(system, request);
  if (run) return run;
  const renderNodes = await checkedRenderNodes(system, request.renderNodes);
  if (isRefusal(renderNodes)) return renderNodes;
  const layout = await systemLayout(system);
  if (isRefusal(layout)) return layout;
  const plan: LinuxBoxPlan = {
    mode,
    stack: stackOf(request),
    bundle: request.bundle,
    exe: path.posix.relative(request.bundle, request.exe),
    softwareIcd: path.posix.relative(request.bundle, request.softwareIcd),
    state: request.state,
    nonce: request.nonce,
    renderNodes,
    display,
    layout,
    seccomp: linuxGameSeccompProgram({ unixSockets: display !== null }),
  };
  return { ok: true, plan };
}

/** How the stack draws: ANGLE's back end (and, headless, surfaceless EGL) for raylib; the winit-free loop for Rust. */
function stackEnv(plan: LinuxBoxPlan): [string, string][] {
  const headless = plan.display === null;
  if (plan.stack === GameStack.RustWgpu) return rustEnv(plan, headless);
  const angle: [string, string][] = [[NativeEnv.AnglePlatform, ANGLE_PLATFORM]];
  return headless ? [...angle, [LinuxBoxEnv.EglPlatform, EGL_SURFACELESS]] : angle;
}

/** A Rust game's: its headless loop, and the capture class a software device draws. */
function rustEnv(plan: LinuxBoxPlan, headless: boolean): [string, string][] {
  const env: [string, string][] = headless ? [[LinuxBoxEnv.Headless, HEADLESS_ON]] : [];
  if (plan.renderNodes.length === 0) env.push([LinuxBoxEnv.RenderReferenceClass, SOFTWARE_REFERENCE_CLASS]);
  return env;
}

/** The game's environment: the fixed allow-list, nothing of the host's. Ordered, so the argv is stable. */
function boxEnv(plan: LinuxBoxPlan): [string, string][] {
  const icd = `${LINUX_BOX_APP}/${plan.softwareIcd}`;
  const env: [string, string][] = [
    [LinuxBoxEnv.WorkingDir, workingDir(plan)],
    [NativeEnv.StudioFd, String(STUDIO_FD)],
    [NativeEnv.Nonce, plan.nonce],
    [NativeEnv.StateDir, LINUX_BOX_STATE],
    [NativeEnv.Home, `${LINUX_BOX_STATE}/home`],
    // With a GPU, SwiftShader joins the system's drivers, so a GPU the box cannot open (NVIDIA's
    // proprietary driver needs /dev/nvidia*) still leaves a software device.
    plan.renderNodes.length ? [LinuxBoxEnv.VulkanAddIcd, icd] : [LinuxBoxEnv.VulkanIcd, icd],
    [LinuxBoxEnv.VulkanLayersDisable, NO_IMPLICIT_LAYERS],
    ...stackEnv(plan),
  ];
  if (!plan.display) return env;
  env.push(
    [LinuxBoxEnv.RuntimeDir, LINUX_BOX_RUNTIME],
    [LinuxBoxEnv.WaylandDisplay, BOX_WAYLAND_DISPLAY],
    [LinuxBoxEnv.SessionType, SESSION_WAYLAND],
  );
  if (plan.display.pulse) env.push([LinuxBoxEnv.PulseServer, `unix:${BOX_PULSE_SOCKET}`]);
  return env;
}

/** `/usr` read-only with its program folders hidden, the library links or folders, the loader cache. */
function systemMounts(layout: LinuxBoxSystemLayout): string[] {
  return [
    ...["--ro-bind", "/usr", "/usr"],
    ...layout.hidden.flatMap((dir) => ["--tmpfs", dir, "--remount-ro", dir]),
    ...layout.links.flatMap((link) => ["--symlink", link.target, link.path]),
    ...layout.dirs.flatMap((dir) => ["--ro-bind", dir, dir]),
    ...["--ro-bind-try", LOADER_CACHE, LOADER_CACHE],
  ];
}

/** `/proc`, the minimal `/dev`, the render nodes, and each one's own device folder in sysfs. */
function deviceMounts(nodes: readonly LinuxBoxRenderNode[]): string[] {
  const devices = [...new Set(nodes.map((node) => node.device))];
  return [
    ...["--proc", "/proc", "--dev", "/dev"],
    ...nodes.flatMap((node) => ["--dev-bind", node.node, node.node]),
    ...devices.flatMap((device) => ["--ro-bind", device, device]),
    ...nodes.flatMap((node) => ["--symlink", node.sysfsTarget, node.sysfsEntry]),
  ];
}

/** Windowed play: a fresh private runtime folder with the Wayland socket and, when granted, the Pulse socket. */
function displayMounts(display: LinuxBoxDisplay | null): string[] {
  if (!display) return [];
  const wayland = [
    "--perms",
    RUNTIME_PERMS,
    "--dir",
    LINUX_BOX_RUNTIME,
    "--ro-bind",
    display.wayland,
    BOX_WAYLAND_SOCKET,
  ];
  if (!display.pulse) return wayland;
  return [...wayland, "--perms", RUNTIME_PERMS, "--dir", BOX_PULSE_DIR, "--ro-bind", display.pulse, BOX_PULSE_SOCKET];
}

/** The executable inside the box. */
function boxedExe(plan: LinuxBoxPlan): string {
  return `${LINUX_BOX_APP}/${plan.exe}`;
}

/** The game starts in its executable's folder, so relative asset paths resolve in the bundle. */
function workingDir(plan: LinuxBoxPlan): string {
  return path.posix.dirname(boxedExe(plan));
}

/** bubblewrap's arguments for a checked plan (everything after `bwrap`). Pure. */
export function linuxGameBoxArgs(plan: LinuxBoxPlan): string[] {
  return [
    ...["--unshare-user", "--disable-userns", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net"],
    ...["--unshare-cgroup-try", "--die-with-parent", "--new-session", "--cap-drop", "ALL"],
    ...["--seccomp", String(SECCOMP_FD)],
    "--clearenv",
    ...boxEnv(plan).flatMap(([name, value]) => ["--setenv", name, value]),
    ...systemMounts(plan.layout),
    ...deviceMounts(plan.renderNodes),
    ...["--tmpfs", "/tmp"],
    ...["--ro-bind", plan.bundle, LINUX_BOX_APP],
    ...["--bind", plan.state, LINUX_BOX_STATE],
    ...displayMounts(plan.display),
    ...["--remount-ro", "/"],
    ...["--chdir", workingDir(plan)],
    "--",
    boxedExe(plan),
  ];
}

/** The run's claim, as a refusal: `already-started` when a start claimed it before, `unreadable` when it cannot be made. */
async function claimRefusal(claim: () => Promise<boolean>, bundle: string): Promise<Refused | null> {
  try {
    return (await claim()) ? null : refuse(LinuxBoxRefusal.AlreadyStarted, bundle);
  } catch (error) {
    return fileErrorRefusal(error, bundle);
  }
}

/**
 * Checks `bwrap` (absolute, unlinked, a file) and the request, then starts bubblewrap once,
 * detached into its own process group, with an empty environment, fd 3, and the seccomp program
 * written to fd 4 (bubblewrap reads it before the game starts and refuses to start it without one).
 * A refusal before the spawn spawns nothing.
 */
export async function launchLinuxGameBox<T extends LinuxBoxChild>(
  bwrap: string,
  request: LinuxBoxRequest,
  deps: {
    system?: LinuxBoxSystem;
    spawn: LinuxBoxSpawn<T>;
    /** Claims the run for this one start, after every check and before the spawn: false when a start claimed it before. */
    claim?(): Promise<boolean>;
  },
): Promise<{ ok: true; child: T; args: string[] } | Refused> {
  const system = deps.system ?? LINUX_BOX_SYSTEM;
  const bwrapStats = await checkedStats(system, bwrap, PathKind.File);
  if (isRefusal(bwrapStats)) return bwrapStats;
  const planned = await planLinuxGameBox(request, system);
  if (!planned.ok) return planned;
  const claimed = deps.claim ? await claimRefusal(deps.claim, request.bundle) : null;
  if (claimed) return claimed;
  const args = linuxGameBoxArgs(planned.plan);
  const child = deps.spawn(bwrap, args, { stdio: [...LINUX_BOX_STDIO], env: {}, detached: true });
  const sink = child.stdio[SECCOMP_FD];
  if (!isSink(sink)) {
    child.kill("SIGKILL");
    return refuse(LinuxBoxRefusal.SeccompNotSent, bwrap);
  }
  // A bubblewrap that exits before reading fd 4 closes it; its exit status reports that, and the
  // game cannot have started without the program, so the write error itself is not needed.
  sink.on("error", () => {});
  sink.end(planned.plan.seccomp);
  return { ok: true, child, args };
}

// ── the host's side: whether it has a box, and a start request's run folders ─────────────────

/** A bubblewrap version, as `bwrap --version` reports it. */
export interface BubblewrapVersion {
  major: number;
  minor: number;
  patch: number;
}

/** `bwrap --version`'s output read as a version (`bubblewrap 0.9.0`), or null for anything else. */
export function bubblewrapVersion(text: string | null): BubblewrapVersion | null {
  const [line = ""] = (text ?? "").split("\n");
  const found = BUBBLEWRAP_VERSION_LINE.exec(line.trim());
  if (!found) return null;
  return { major: Number(found[1]), minor: Number(found[2]), patch: Number(found[3] ?? 0) };
}

/** Whether `bwrap --version`'s output names a bubblewrap the box runs under ({@link BUBBLEWRAP_MIN_VERSION} or newer). */
export function bubblewrapSupported(text: string | null): boolean {
  const version = bubblewrapVersion(text);
  if (!version) return false;
  if (version.major !== BUBBLEWRAP_MIN_VERSION.major) return version.major > BUBBLEWRAP_MIN_VERSION.major;
  return version.minor >= BUBBLEWRAP_MIN_VERSION.minor;
}

/** What a Linux host knows about its box; the probes are asked only when an earlier check passed. */
export interface LinuxBoxFacts {
  mode: NativeRunMode;
  /** The game's stack; absent: C++ · raylib, which has no Linux headless build. */
  stack?: CompiledStack;
  /** `bwrap --version`'s output, or null when bubblewrap does not run. */
  bwrapVersion(): string | null;
  /** Ubuntu 24.04's user-namespace restriction applies to this process (`usernsRestricted`). */
  usernsRestricted(): boolean;
  /** The session's environment: only `WAYLAND_DISPLAY` and `DISPLAY` are read. */
  session: Readonly<Record<string, string | undefined>>;
  /** Whether this build has the helper that makes a per-run `wp_security_context_v1` socket ({@link openWaylandContext}). */
  securityContext: boolean;
}

/** Whether the stack has a Linux build for `mode`: a window for both, headless for Rust's one binary alone. */
function hasLinuxBuild(mode: NativeRunMode, stack: CompiledStack): boolean {
  if (mode === NativeRunMode.Window) return true;
  return mode === NativeRunMode.Headless && stack === GameStack.RustWgpu;
}

/**
 * Why a Linux host has no box for a `mode` run, in this order: no build for the mode (a raylib
 * game has no windowless Linux build, and no stack embeds in Live on Linux: `no-headless-build`),
 * bubblewrap missing or older than 0.8, the user-namespace restriction, then for a window an
 * X11-only session, no display, and no helper for a per-run Wayland security context in this build
 * (`wayland-helper-missing`; whether the compositor offers one is the helper's to say at the run,
 * `wayland-unrestricted`). A Rust game's headless run needs no display. Null: the box runs.
 */
export function linuxGameBoxProblem(facts: LinuxBoxFacts): GameBoxProblem | null {
  if (!hasLinuxBuild(facts.mode, stackOf(facts))) return GameBoxProblem.NoHeadlessBuild;
  if (!bubblewrapSupported(facts.bwrapVersion())) return GameBoxProblem.BubblewrapMissing;
  if (facts.usernsRestricted()) return GameBoxProblem.UsernsRestricted;
  if (facts.mode === NativeRunMode.Headless) return null;
  const display = sessionDisplayRefusal(facts.session);
  if (display) return display;
  return facts.securityContext ? null : GameBoxProblem.WaylandHelperMissing;
}

/** The planner's display refusals are box problems of their own; every other refusal is the box refusing. */
const BOX_PROBLEM_OF: Partial<Record<LinuxBoxRefusal, GameBoxProblem>> = {
  [LinuxBoxRefusal.X11Only]: GameBoxProblem.X11Only,
  [LinuxBoxRefusal.NoWayland]: GameBoxProblem.NoWayland,
  [LinuxBoxRefusal.WaylandUnrestricted]: GameBoxProblem.WaylandUnrestricted,
};

/** A refused Linux start as `spawnGame` throws it: `no-game-box` with the box's problem, keeping the planner's code. */
export class LinuxBoxError extends NativeError {
  /** The planner's own refusal. */
  readonly reason: LinuxBoxRefusal;

  constructor(reason: LinuxBoxRefusal, message: string) {
    super(NativeRefusal.NoGameBox, message, null, BOX_PROBLEM_OF[reason] ?? GameBoxProblem.BoxRefused);
    this.name = "LinuxBoxError";
    this.reason = reason;
  }
}

/** The typed error for a planner or launch refusal. */
export function linuxBoxError(refused: Refused): LinuxBoxError {
  return new LinuxBoxError(refused.refusal, refused.detail);
}

/** A start request's own paths, as `spawnGame` is handed them. */
export interface LinuxRunRequest {
  runId: string;
  runDir: string;
  bundle: string;
  state: string;
  exe: string;
}

/** A run's folders by real path: `<real native-runs>/<run id>`, its `bundle` and `state`, and `bundle/game`. */
export interface LinuxRunFolders {
  runDir: string;
  bundle: string;
  state: string;
  exe: string;
}

/**
 * Checks a start request against the native-runs root before the box planner sees it: the run folder
 * is `<root>/<run id>` (spelled through the root or its real path), a folder of this user's that no
 * link redirects, with `bundle`, `state` and `bundle/game` its own. Answers the real paths, which the
 * planner then checks again; reads only.
 */
export async function linuxRunFolders(
  request: LinuxRunRequest,
  root: string,
  system: LinuxBoxSystem = LINUX_BOX_SYSTEM,
): Promise<{ ok: true; folders: LinuxRunFolders } | Refused> {
  if (!isRunId(request.runId)) return refuse(LinuxBoxRefusal.NotTheRunDir, JSON.stringify(request.runId));
  for (const candidate of [root, request.runDir, request.bundle, request.state, request.exe]) {
    const unsafe = unsafePath(candidate);
    if (unsafe) return unsafe;
  }
  let realRoot: string;
  try {
    realRoot = await system.realpath(root);
  } catch (error) {
    return fileErrorRefusal(error, root);
  }
  const spelled = [path.posix.join(root, request.runId), path.posix.join(realRoot, request.runId)];
  const own = (name: string) => path.posix.join(request.runDir, name);
  const bundle = own(RunDirLayout.Bundle);
  const exe = path.posix.join(bundle, NATIVE_CROSS_EXECUTABLES[BuildTarget.Linux]);
  const laidOut = request.bundle === bundle && request.state === own(RunDirLayout.State) && request.exe === exe;
  if (!spelled.includes(request.runDir) || !laidOut) return refuse(LinuxBoxRefusal.NotTheRunDir, request.runDir);
  const runDir = path.posix.join(realRoot, request.runId);
  const stats = await checkedStats(system, runDir, PathKind.Dir);
  if (isRefusal(stats)) return stats;
  if (stats.uid !== system.uid) return refuse(LinuxBoxRefusal.NotOwned, runDir);
  const realBundle = path.posix.join(runDir, RunDirLayout.Bundle);
  const folders = {
    runDir,
    bundle: realBundle,
    state: path.posix.join(runDir, RunDirLayout.State),
    exe: path.posix.join(realBundle, NATIVE_CROSS_EXECUTABLES[BuildTarget.Linux]),
  };
  return { ok: true, folders };
}

// ── the Wayland helper: a per-run security-context socket for windowed play ───────────────────

/** The helper's file name in a build's resources (`native/genex-game-launcher/linux/wayland_context.c`). */
export const WAYLAND_CONTEXT_HELPER = "genex-wayland-context";
/** The app id every boxed game's Wayland context carries; the run id is its instance. */
export const WAYLAND_CONTEXT_APP_ID = "games.genex.game";
/** What the helper prints first, one line (`failed <step>` otherwise). Wire values. */
export const WaylandHelperLine = {
  /** The compositor accepts sandboxed clients on the run's socket until the helper exits. */
  Ready: "ready",
  /** The compositor offers no `wp_security_context_manager_v1`. */
  Unrestricted: "unrestricted",
} as const;
export type WaylandHelperLine = (typeof WaylandHelperLine)[keyof typeof WaylandHelperLine];

/** How long the helper may take to commit the context, and a closed helper to exit before it is killed. */
const WAYLAND_CONTEXT_TIMEOUT_MS = 5 * SECOND_MS;
/** The run's context folder in the session's runtime folder: this prefix, then the run id. */
const CONTEXT_DIR_PREFIX = "genex-wl-";
/** The run's socket inside its context folder. */
const CONTEXT_SOCKET = "wl";
/** `sun_path` holds 108 bytes on Linux, its NUL included. */
const SOCKET_PATH_MAX_BYTES = 107;
/** The most the helper's first line may hold before it is read as no answer. */
const HELPER_LINE_MAX = 256;
/** A `WAYLAND_DISPLAY` that names a socket inside the runtime folder. */
const DISPLAY_NAME = /^[A-Za-z0-9._-]{1,64}$/;
/** The helper's stdio: stdin held open for the run's life, stdout its one line, stderr ignored. */
const HELPER_STDIO = ["pipe", "pipe", "ignore"] as const;
/** A context folder that exists before the run made it was planted, or left by a run with this id. */
const ERRNO_EXISTS = "EEXIST";

/** The run a context is for, and the session it opens on. */
export interface WaylandContextRequest {
  runId: string;
  /** The session's environment: only `WAYLAND_DISPLAY`, `DISPLAY` and `XDG_RUNTIME_DIR` are read. */
  session: Readonly<Record<string, string | undefined>>;
}

/** An open per-run context: the socket the box binds, and how to revoke it when the run ends. */
export interface WaylandContext {
  socket: string;
  /** Ends the helper (the compositor stops accepting on the socket) and removes the context folder. */
  close(): Promise<void>;
}

/** What opening a context uses; tests inject the system and the deadline. */
export interface WaylandContextDeps {
  /** Starts the helper. Node's `spawn` is one. */
  spawn: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  system?: LinuxBoxSystem;
  /** The helper's deadline to answer, and a closed helper's to exit (default {@link WAYLAND_CONTEXT_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/** An open context; null when the compositor offers none (`wayland-unrestricted`); or the refusal. */
export type WaylandContextOpening = { ok: true; context: WaylandContext | null } | Refused;

/** Where the run's context goes, checked. */
interface ContextTarget {
  /** The session compositor's own socket, which only the helper connects to. */
  compositor: string;
  dir: string;
  socket: string;
}

/** The session compositor's socket: an absolute path, or a plain name inside the runtime folder. */
function compositorSocket(display: string, runtimeDir: string): string | Refused {
  if (display.startsWith("/")) return unsafePath(display) ?? display;
  const plain = DISPLAY_NAME.test(display) && display !== "." && display !== "..";
  if (!plain) return refuse(LinuxBoxRefusal.UnsafeValue, LinuxBoxEnv.WaylandDisplay);
  return path.posix.join(runtimeDir, display);
}

/** The checked compositor socket and the run's context folder and socket, before anything is made. */
async function contextTarget(system: LinuxBoxSystem, request: WaylandContextRequest): Promise<ContextTarget | Refused> {
  if (!isRunId(request.runId)) return refuse(LinuxBoxRefusal.UnsafeValue, JSON.stringify(request.runId));
  const { session } = request;
  const display = sessionDisplayRefusal(session);
  if (display === LinuxBoxRefusal.X11Only) return refuse(display, SessionVar.Display);
  if (display) return refuse(display, LinuxBoxEnv.WaylandDisplay);
  const runtimeDir = session[LinuxBoxEnv.RuntimeDir];
  if (!runtimeDir) return refuse(LinuxBoxRefusal.RuntimeDirMissing, LinuxBoxEnv.RuntimeDir);
  const folder = await checkedPrivateDir(system, runtimeDir);
  if (folder) return folder;
  const compositor = compositorSocket(session[LinuxBoxEnv.WaylandDisplay] ?? "", runtimeDir);
  if (isRefusal(compositor)) return compositor;
  const reachable = await checkedSocket(system, compositor);
  if (reachable) return reachable;
  const dir = path.posix.join(runtimeDir, `${CONTEXT_DIR_PREFIX}${request.runId}`);
  const socket = path.posix.join(dir, CONTEXT_SOCKET);
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX_BYTES) return refuse(LinuxBoxRefusal.UnsafePath, socket);
  return { compositor, dir, socket };
}

/** Makes the run's context folder (0700, never over anything that exists), then checks it as made. */
async function makeContextDir(system: LinuxBoxSystem, dir: string): Promise<Refused | null> {
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    const exists = (error as NodeJS.ErrnoException | null)?.code === ERRNO_EXISTS;
    return exists ? refuse(LinuxBoxRefusal.AlreadyStarted, dir) : fileErrorRefusal(error, dir);
  }
  return checkedPrivateDir(system, dir);
}

/** Whether the helper has exited (or never started). */
function helperGone(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves once the helper has exited or failed to start. */
function helperExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (helperGone(child)) resolve();
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

/** The helper's first line, or null when it ends stdout, fails, says too much, or the deadline passes. */
async function firstLine(child: ChildProcess, timeoutMs: number): Promise<string | null> {
  const stdout = child.stdout;
  if (!stdout) return null;
  const line = new Promise<string | null>((resolve) => {
    let text = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end >= 0) resolve(text.slice(0, end));
      if (text.length > HELPER_LINE_MAX) resolve(null);
    });
    stdout.once("end", () => resolve(null));
    child.once("error", () => resolve(null));
  });
  const deadline = new AbortController();
  const late = sleep(timeoutMs, null, { signal: deadline.signal }).catch(() => null);
  const answer = await Promise.race([line, late]);
  deadline.abort();
  return answer;
}

/** Ends the helper: stdin closed (its "run over"), then SIGKILL after the grace; then the folder goes. */
async function closeContext(child: ChildProcess, exited: Promise<void>, dir: string, graceMs: number): Promise<void> {
  child.stdin?.end();
  const grace = new AbortController();
  await Promise.race([exited, sleep(graceMs, undefined, { signal: grace.signal }).catch(() => {})]);
  grace.abort();
  if (!helperGone(child)) child.kill("SIGKILL");
  await exited;
  await rm(dir, { recursive: true, force: true });
}

/**
 * Opens windowed play's per-run Wayland socket: checks the helper (absolute, unlinked, a file), the
 * run id, the session (a Wayland display, a private runtime folder of ours, the compositor's socket
 * ours), makes `<XDG_RUNTIME_DIR>/genex-wl-<run id>` (0700, never over an existing path), and starts
 * the helper with only the compositor's socket in its environment. `ready` gives the socket and its
 * `close`; `unrestricted` gives null; anything else, or silence past the deadline, is
 * `wayland-context-failed`. Every refusal before the folder is made starts nothing; a failed or
 * unrestricted helper is ended and its folder removed. The helper also ends when Genex does: its
 * stdin closes.
 */
export async function openWaylandContext(
  helper: string,
  request: WaylandContextRequest,
  deps: WaylandContextDeps,
): Promise<WaylandContextOpening> {
  const system = deps.system ?? LINUX_BOX_SYSTEM;
  const timeoutMs = deps.timeoutMs ?? WAYLAND_CONTEXT_TIMEOUT_MS;
  const helperFile = await checkedStats(system, helper, PathKind.File);
  if (isRefusal(helperFile)) return helperFile;
  const target = await contextTarget(system, request);
  if (isRefusal(target)) return target;
  const made = await makeContextDir(system, target.dir);
  if (made) return made;
  const args = ["--socket", target.socket, "--app-id", WAYLAND_CONTEXT_APP_ID, "--instance-id", request.runId];
  const env = { [LinuxBoxEnv.WaylandDisplay]: target.compositor };
  let child: ChildProcess;
  try {
    child = deps.spawn(helper, args, { stdio: [...HELPER_STDIO], env });
  } catch (error) {
    await rm(target.dir, { recursive: true, force: true });
    return refuse(LinuxBoxRefusal.WaylandContextFailed, String(error));
  }
  // Closing stdin of a helper that already exited may fail (EPIPE); the exit is what counts.
  child.stdin?.on("error", () => {});
  const exited = helperExit(child);
  const close = () => closeContext(child, exited, target.dir, timeoutMs);
  const line = await firstLine(child, timeoutMs);
  if (line === WaylandHelperLine.Ready) {
    const socket = await checkedSocket(system, target.socket);
    if (!socket) return { ok: true, context: { socket: target.socket, close } };
    await close();
    return socket;
  }
  await close();
  if (line === WaylandHelperLine.Unrestricted) return { ok: true, context: null };
  return refuse(LinuxBoxRefusal.WaylandContextFailed, line ?? "no answer");
}

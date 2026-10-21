/**
 * The harness's copy of the C++ · raylib contract: stacks, destinations, the phone artifacts the
 * harness may export and the judging target,
 * the native run protocol's vocabularies, ops and reply checks (the renderer's quality vocabulary of
 * `renderSettings`, `volatile.render` and capture provenance included; the `saves` and `uiSettings`
 * codes and arguments of `shared/game-saves.ts` too), which checks a raylib game can
 * measure per stack, and the `SERVES_NATIVE` and `SERVES_RUST` marks a raylib or Rust night needs
 * from every part it runs. The app
 * keeps the same in `shared/game-project.ts`, `shared/game-targets.ts`,
 * `shared/game-export-contract.ts`, `shared/native-contract.ts` and `shared/render-quality.ts`; `tests/conformance/seed-contracts.test.ts` holds the copies together.
 *
 * A new module on purpose: a seed upgrade keeps any older module the agent edited, so every name a
 * raylib night needs lives here, and this file imports only names its neighbours have always had.
 */
import type { HarnessHostApi, PreviewInputAction } from "../types/host-api.d.ts";

/** The host's facts about an admitted or refused Mac, Windows or Linux build, and the typed probes' answers (shared/harness-api.ts). */
export type { CameraPoseResult, EmptySceneResult, NativeAdmissionFacts, WitnessResult } from "../types/host-api.d.ts";
import { HostMethod } from "./host-methods.ts";
import { NativeRefusal, TargetRefusal } from "./native-refusal.ts";
import { CheckKind } from "./spec.ts";
import { SECOND_MS } from "./time.ts";

// ── stacks, destinations and hosts ─────────────────────────────────────────────────────────

/** The runtime a game is written for. Wire values (studio.json `stack`): never rename one. */
export const GameStack = {
  ThreeJs: "three-js",
  RaylibCpp: "raylib-cpp",
  /** Rust gameplay on the genex facade, drawn by wgpu. */
  RustWgpu: "rust-wgpu",
} as const;
export type GameStack = (typeof GameStack)[keyof typeof GameStack];

/** Where people play, as a destination the studio builds for. Wire values (studio.json `targets`). */
export const BuildTarget = {
  Web: "web",
  Mac: "macos",
  Windows: "windows",
  Linux: "linux",
  /** iPhone and iPad: a Rust · wgpu destination only. */
  Ios: "ios",
  /** Android phones and tablets: a Rust · wgpu destination only. */
  Android: "android",
} as const;
export type BuildTarget = (typeof BuildTarget)[keyof typeof BuildTarget];

/** The browser and desktop destinations, in list order: what a raylib game may name. */
const WEB_AND_DESKTOP: readonly BuildTarget[] = Object.freeze([
  BuildTarget.Web,
  BuildTarget.Mac,
  BuildTarget.Windows,
  BuildTarget.Linux,
]);

/** What kind of game a folder holds. Wire values (studio.json `kind`): never rename one. */
export const ProjectKind = {
  StudioTemplate: "studio-template",
  ThreeVite: "three-vite",
  ThreeModules: "three-modules",
  Canvas2d: "canvas2d",
  Phaser: "phaser",
  EngineExport: "engine-export",
  OwnScript: "own-script",
  /** A CMake project that builds with raylib: C++ for the browser and the desktop. */
  RaylibCpp: "raylib-cpp",
  /** A `genex.toml` project: Rust gameplay on the genex facade. */
  RustWgpu: "rust-wgpu",
} as const;
export type ProjectKind = (typeof ProjectKind)[keyof typeof ProjectKind];

/** The stack each kind is: raylib and Rust are their own, every other kind is a browser game. */
export const STACK_OF_KIND = {
  [ProjectKind.StudioTemplate]: GameStack.ThreeJs,
  [ProjectKind.ThreeVite]: GameStack.ThreeJs,
  [ProjectKind.ThreeModules]: GameStack.ThreeJs,
  [ProjectKind.Canvas2d]: GameStack.ThreeJs,
  [ProjectKind.Phaser]: GameStack.ThreeJs,
  [ProjectKind.EngineExport]: GameStack.ThreeJs,
  [ProjectKind.OwnScript]: GameStack.ThreeJs,
  [ProjectKind.RaylibCpp]: GameStack.RaylibCpp,
  [ProjectKind.RustWgpu]: GameStack.RustWgpu,
} as const satisfies Record<ProjectKind, GameStack>;

/** Every destination a game of each stack may name, in list order. */
export const STACK_TARGETS = {
  [GameStack.ThreeJs]: Object.freeze([BuildTarget.Web]),
  [GameStack.RaylibCpp]: WEB_AND_DESKTOP,
  [GameStack.RustWgpu]: Object.freeze([...WEB_AND_DESKTOP, BuildTarget.Ios, BuildTarget.Android]),
} as const satisfies Record<GameStack, readonly BuildTarget[]>;

/** The stacks a new game may be created with: C++ · raylib creation is retired (existing raylib games stay). */
export type CreatableStack = Exclude<GameStack, typeof GameStack.RaylibCpp>;

/** {@link CreatableStack} in list order. */
export const CREATABLE_STACKS: readonly CreatableStack[] = Object.freeze([GameStack.ThreeJs, GameStack.RustWgpu]);

/** Why the host refuses a create request for its stack. Wire values (the error's `code`): never rename one. */
export const CreationRefusal = {
  /** The request named C++ · raylib, or only desktop destinations as a pre-Rust intake did: nothing was made. */
  RaylibCreationRetired: "raylib-creation-retired",
} as const;
export type CreationRefusal = (typeof CreationRefusal)[keyof typeof CreationRefusal];

/**
 * The stack a new game's destinations imply: anything beyond the browser (a desktop or a phone)
 * is Rust · wgpu, the browser alone three.js; `chosen` Rust · wgpu forces it. Never C++ · raylib.
 */
export function stackForTargets(targets: readonly BuildTarget[], chosen?: GameStack): CreatableStack {
  if (chosen === GameStack.RustWgpu) return GameStack.RustWgpu;
  return targets.some((target) => target !== BuildTarget.Web) ? GameStack.RustWgpu : GameStack.ThreeJs;
}

/** The platforms the studio runs on, as `preview.capacity` names its host. Wire values. */
export const StudioPlatform = {
  Mac: "darwin",
  Windows: "win32",
  Linux: "linux",
} as const;
export type StudioPlatform = (typeof StudioPlatform)[keyof typeof StudioPlatform];

/** What a host can build and run. */
interface HostAbility {
  build: readonly BuildTarget[];
  run: readonly BuildTarget[];
}

/** The host matrix: a Mac builds all four and runs Browser + Mac; Windows and Linux run their own OS through a game box. */
export const HOST_MATRIX = {
  [StudioPlatform.Mac]: {
    build: [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux],
    run: [BuildTarget.Web, BuildTarget.Mac],
  },
  [StudioPlatform.Windows]: {
    build: [BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux],
    run: [BuildTarget.Web, BuildTarget.Windows],
  },
  [StudioPlatform.Linux]: {
    build: [BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux],
    run: [BuildTarget.Web, BuildTarget.Linux],
  },
} as const satisfies Record<StudioPlatform, HostAbility>;

/** A host that builds and runs nothing for a stack. */
const NO_LANE_HOST: HostAbility = Object.freeze({ build: Object.freeze([]), run: Object.freeze([]) });

/** The browser only: what every host does for a game with no managed toolchain. */
const WEB_ONLY_HOST: HostAbility = Object.freeze({
  build: Object.freeze([BuildTarget.Web]),
  run: Object.freeze([BuildTarget.Web]),
});

/**
 * What each host can build and run, per stack: raylib is {@link HOST_MATRIX}; Rust's lane builds
 * Browser, Mac, Windows, Linux, iPhone and Android on a Mac and Browser, Windows, Linux and
 * Android on Linux (a cross build is refused `target-unbuilt` until its toolchain is pinned), runs
 * the browser and a Mac's own build, and nothing on Windows. A phone build is only ever exported:
 * no agent runs one on a Simulator, emulator or device.
 */
export const STACK_HOST_MATRIX = {
  [GameStack.ThreeJs]: {
    [StudioPlatform.Mac]: WEB_ONLY_HOST,
    [StudioPlatform.Windows]: WEB_ONLY_HOST,
    [StudioPlatform.Linux]: WEB_ONLY_HOST,
  },
  [GameStack.RaylibCpp]: HOST_MATRIX,
  [GameStack.RustWgpu]: {
    [StudioPlatform.Mac]: Object.freeze({
      build: Object.freeze([
        BuildTarget.Web,
        BuildTarget.Mac,
        BuildTarget.Windows,
        BuildTarget.Linux,
        BuildTarget.Ios,
        BuildTarget.Android,
      ]),
      run: Object.freeze([BuildTarget.Web, BuildTarget.Mac]),
    }),
    [StudioPlatform.Windows]: NO_LANE_HOST,
    [StudioPlatform.Linux]: Object.freeze({
      build: Object.freeze([BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux, BuildTarget.Android]),
      run: Object.freeze([BuildTarget.Web]),
    }),
  },
} as const satisfies Record<GameStack, Record<StudioPlatform, HostAbility>>;

/** What a phone export makes. Wire values (the export's receipt): never rename one. */
export const MobileArtifact = {
  /** An `.app` for the iOS Simulator, signed ad hoc. */
  SimulatorApp: "simulator-app",
  /** An `.ipa` signed with the person's Apple identity. Person only. */
  Ipa: "ipa",
  /** A development APK signed with Studio's per-profile debug key. */
  ApkDev: "apk-dev",
  /** An Android App Bundle signed with the person's release keystore. Person only. */
  Aab: "aab",
} as const;
export type MobileArtifact = (typeof MobileArtifact)[keyof typeof MobileArtifact];

/**
 * The phone artifacts `game.export` may make for the harness: a Simulator app and a dev APK, never
 * an IPA or an AAB, whose signings are the person's alone (the host refuses `harness-may-not-sign`).
 */
export const HARNESS_MOBILE_ARTIFACTS: readonly MobileArtifact[] = Object.freeze([
  MobileArtifact.SimulatorApp,
  MobileArtifact.ApkDev,
]);

/** Which build the evidence pass judges, and whether it is a build no player gets. */
export interface JudgingTarget {
  target: BuildTarget;
  /** A web build made only so judges see real frames: never exported, never shown in Live. */
  judgingOnly: boolean;
}

/** A game's stack and destinations (`GameProject.destinations`). */
export interface Destinations {
  stack: GameStack;
  targets: readonly BuildTarget[];
}

/** null when this host builds `target`; else the refusal. */
export function buildRefusal(host: StudioPlatform, target: BuildTarget): TargetRefusal | null {
  const builds: readonly BuildTarget[] = HOST_MATRIX[host].build;
  return builds.includes(target) ? null : TargetRefusal.MacBuildsNeedAMac;
}

/** null when this host runs `target`; `gameBox` is whether the host has a game box for its own OS. */
export function runRefusal(
  host: StudioPlatform,
  target: BuildTarget,
  options: { gameBox: boolean },
): TargetRefusal | null {
  const unbuildable = buildRefusal(host, target);
  if (unbuildable) return unbuildable;
  if (target === BuildTarget.Web) return null;
  const runs: readonly BuildTarget[] = HOST_MATRIX[host].run;
  if (!runs.includes(target)) return TargetRefusal.NotRunnableHere;
  return options.gameBox ? null : TargetRefusal.NoGameBox;
}

/**
 * The judging target: Web when Browser is a destination; else the first destination this host
 * runs; else a judging-only Web build. Never null: a failed judging build is the gate's
 * `NoJudgingTarget`, not the picker's.
 */
export function judgingTarget(
  destinations: Destinations,
  host: StudioPlatform,
  options: { gameBox: boolean },
): JudgingTarget {
  if (destinations.targets.includes(BuildTarget.Web)) return { target: BuildTarget.Web, judgingOnly: false };
  const runnable = destinations.targets.find((target) => runRefusal(host, target, options) === null);
  if (runnable) return { target: runnable, judgingOnly: false };
  return { target: BuildTarget.Web, judgingOnly: true };
}

// ── the native run protocol ────────────────────────────────────────────────────────────────

/** Protocol 1: every C++ · raylib game, and a Rust game made before contract v2. Frozen. */
export const NATIVE_PROTOCOL_V1 = 1;
/** The newest protocol the host speaks (contract v2: receipt, lifecycle, safe area, touch). */
export const NATIVE_PROTOCOL_VERSION = 2;
/** A protocol the host accepts in `ready`. */
export type NativeProtocolVersion = typeof NATIVE_PROTOCOL_V1 | typeof NATIVE_PROTOCOL_VERSION;
/** Every protocol a `ready` may state, oldest first. */
export const NATIVE_PROTOCOL_VERSIONS: readonly NativeProtocolVersion[] = Object.freeze([
  NATIVE_PROTOCOL_V1,
  NATIVE_PROTOCOL_VERSION,
]);

/** Whether a `ready`'s `protocol` is one the host speaks. */
export function isNativeProtocolVersion(value: unknown): value is NativeProtocolVersion {
  return NATIVE_PROTOCOL_VERSIONS.some((version) => version === value);
}

/** The ops the host sends a native game. Wire values: never rename one. */
export const NativeOp = {
  Seed: "seed",
  Start: "start",
  Pause: "pause",
  Step: "step",
  State: "state",
  Input: "input",
  Capture: "capture",
  DebugCamera: "debugCamera",
  Cameras: "cameras",
  Eyes: "eyes",
  Demos: "demos",
  Demo: "demo",
  Audio: "audio",
  AudioLevel: "audioLevel",
  Timing: "timing",
  Quit: "quit",
  Front: "front",
  Visible: "visible",
  Surface: "surface",
  Release: "release",
  /** Read or change the renderer's quality (preset, emulated device class, feature switches, scale lock). */
  RenderSettings: "renderSettings",
  /** Run one registered bake (`{kind, name}`) into `state/bakes/<kind>/<name>`: a build step's, never an agent's. */
  BakeAssets: "bakeAssets",
  /** Swap named asset files in a running dev game (`{files: [{path, digest}]}`) without a rebuild. */
  ReloadAssets: "reloadAssets",
  /** Read a dev game's frame profile (`{action, frames?, mode?}`): summary, report, arm or trace. */
  Profile: "profile",
  /** List, read, write, save, load or delete the game's save slots (`{op, slot?, label?, envelope?}`). */
  Saves: "saves",
  /** A session layer over the gameplay UI's settings (`{locale?, scale?, safeArea?, textSize?}`); no member reads. */
  UiSettings: "uiSettings",
} as const;
export type NativeOp = (typeof NativeOp)[keyof typeof NativeOp];

/** What a `bakeAssets` bakes. Wire values: never rename one. */
export const BakeKind = { Nav: "nav", Impostor: "impostor" } as const;
export type BakeKind = (typeof BakeKind)[keyof typeof BakeKind];

/** The most bytes one bake's output may hold. */
export const NATIVE_BAKE_MAX_BYTES = 256 * 1024 * 1024;
/** The most files one `reloadAssets` names. */
export const NATIVE_RELOAD_FILES_MAX = 256;

/** A bake's name is one path segment: lowercase letters, digits, `-` and `_`, at most 64, never a dot. */
const BAKE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Whether `value` is a bake name (a file in `state/bakes/<kind>/` that can never climb out). */
export function isBakeName(value: unknown): value is string {
  return typeof value === "string" && BAKE_NAME.test(value);
}

/** Why `reloadAssets` refused one file. Wire values: never rename one. */
export const ReloadRefusal = {
  UnsafePath: "unsafe-path",
  DigestMismatch: "digest-mismatch",
  Missing: "missing",
} as const;
export type ReloadRefusal = (typeof ReloadRefusal)[keyof typeof ReloadRefusal];

/** One file a `reloadAssets` names, with the FNV-1a 64 digest of its new bytes. */
export interface NativeReloadFile {
  path: string;
  digest: string;
}

/** What `reloadAssets` answers. */
export interface NativeReloadAnswer {
  reloaded: string[];
  refused: Array<{ path: string; code: ReloadRefusal }>;
  pending: number;
}

/** What `bakeAssets` answers: the bake it ran, and the size and digest of the file it wrote. */
export interface NativeBakeReply {
  kind: BakeKind;
  name: string;
  bytes: number;
  digest: string;
}

/** The events a native game sends on its own. Wire values. */
export const NativeEvent = {
  Ready: "ready",
  Fatal: "fatal",
  Focus: "focus",
  Frame: "frame",
  DeviceRestored: "device-restored",
  Starting: "starting",
  /** The game crashed and sends its `genex-crash/1` record (before `ready` too). */
  Crash: "crash",
} as const;
export type NativeEvent = (typeof NativeEvent)[keyof typeof NativeEvent];

/** What a `profile` request asks for. Wire values: never rename one. */
export const FrameProfileAction = { Summary: "summary", Report: "report", Arm: "arm", Trace: "trace" } as const;
export type FrameProfileAction = (typeof FrameProfileAction)[keyof typeof FrameProfileAction];

/** How a game times its GPU: the whole frame, or each frame-graph node while armed. Wire values. */
export const GpuTimingMode = { Frame: "frame", Nodes: "nodes" } as const;
export type GpuTimingMode = (typeof GpuTimingMode)[keyof typeof GpuTimingMode];

/** The profile summary's and report's format numbers (their `v`). */
const PROFILE_SUMMARY_VERSION = 1;
const PROFILE_REPORT_VERSION = 2;

/** How a native run is shown. Never rename a value. */
export const NativeRunMode = {
  Window: "window",
  Headless: "headless",
  Embedded: "embedded",
} as const;
export type NativeRunMode = (typeof NativeRunMode)[keyof typeof NativeRunMode];

/** Extra input kinds only native runs take. Wire values. */
export const NativeInputKind = {
  Gamepad: "gamepad",
  Text: "text",
  /** Contract v2: one finger's start, move or end in world coordinates. */
  Touch: "touch",
} as const;
export type NativeInputKind = (typeof NativeInputKind)[keyof typeof NativeInputKind];

/** Which kind of pad a `gamepad` action stands for: display only (button labels). Wire values. */
export const NativeGamepadFamily = {
  Generic: "generic",
  Xbox: "xbox",
  PlayStation: "playstation",
  Nintendo: "nintendo",
  Steam: "steam",
} as const;
export type NativeGamepadFamily = (typeof NativeGamepadFamily)[keyof typeof NativeGamepadFamily];

/** The graphics path a native game reports in `ready`. Wire values. */
export const NativeBackend = {
  MetalAngle: "metal-angle",
  D3d11Angle: "d3d11-angle",
  VulkanAngle: "vulkan-angle",
  WebGl2: "webgl2",
  Unknown: "unknown",
  /** wgpu on Metal (macOS, iOS). */
  Metal: "metal",
  /** wgpu on Vulkan (Linux, Android). */
  Vulkan: "vulkan",
  /** wgpu on Direct3D 12 (Windows). */
  D3d12: "d3d12",
  /** wgpu on the browser's WebGPU. */
  WebGpu: "webgpu",
} as const;
export type NativeBackend = (typeof NativeBackend)[keyof typeof NativeBackend];

/** The backends a Rust · wgpu game may report: WebGPU core natively and on the web, never GL. */
export type NativeWgpuBackend =
  | typeof NativeBackend.Metal
  | typeof NativeBackend.Vulkan
  | typeof NativeBackend.D3d12
  | typeof NativeBackend.WebGpu;
/** The wgpu backends as a list. */
export const NATIVE_WGPU_BACKENDS: readonly NativeWgpuBackend[] = Object.freeze([
  NativeBackend.Metal,
  NativeBackend.Vulkan,
  NativeBackend.D3d12,
  NativeBackend.WebGpu,
]);

/** The capability tier a receipt states: always core. Wire values. */
export const NativeGpuTier = {
  Core: "core",
} as const;
export type NativeGpuTier = (typeof NativeGpuTier)[keyof typeof NativeGpuTier];

/** Optional wgpu native features (native-enhanced), as `genex.toml` and the receipt spell them. Wire values. */
export const NativeEnhancedFeature = {
  ShaderInt64AtomicMinMax: "shader-int64-atomic-min-max",
  ShaderInt64AtomicAllOps: "shader-int64-atomic-all-ops",
  Subgroup: "subgroup",
  RayQuery: "ray-query",
  MeshShader: "mesh-shader",
  TextureBindingArray: "texture-binding-array",
  MultiDrawIndirectCount: "multi-draw-indirect-count",
} as const;
export type NativeEnhancedFeature = (typeof NativeEnhancedFeature)[keyof typeof NativeEnhancedFeature];

/** Where a v2 game's app is in its life (`state().lifecycle`). Wire values. */
export const NativeLifecycle = {
  Launched: "launched",
  Resumed: "resumed",
  Suspended: "suspended",
} as const;
export type NativeLifecycle = (typeof NativeLifecycle)[keyof typeof NativeLifecycle];

/** Where a native run stands. Never rename a value. */
export const NativeRunState = {
  Building: "building",
  Admitting: "admitting",
  Starting: "starting",
  Ready: "ready",
  Paused: "paused",
  Stopping: "stopping",
  Stopped: "stopped",
  Crashed: "crashed",
  Killed: "killed",
  Refused: "refused",
} as const;
export type NativeRunState = (typeof NativeRunState)[keyof typeof NativeRunState];

export { NativeRefusal, TargetRefusal };

/** Pixel layout of a native capture, rows top-down. */
export const NATIVE_CAPTURE_FORMAT = "bgra8";
/** The longest side a capture may have. */
export const NATIVE_CAPTURE_MAX_PX = 4096;
/** The shortest side a capture may be asked to draw at: the world target's smallest. */
export const NATIVE_CAPTURE_MIN_PX = 64;
/** The most bytes one capture may take. */
export const NATIVE_CAPTURE_MAX_BYTES = NATIVE_CAPTURE_MAX_PX * NATIVE_CAPTURE_MAX_PX * 4;
/** One protocol line, in either direction, may not exceed this. */
export const NATIVE_LINE_MAX_BYTES = 1024 * 1024;
/** How long the host waits for `ready` when the game declares no `bootMs`. */
export const NATIVE_READY_TIMEOUT_MS = 20 * SECOND_MS;
/** The longest a start may take however often the game says it is still `starting` (contract v2). */
export const NATIVE_START_MAX_MS = 3 * NATIVE_READY_TIMEOUT_MS;
/** How long one op may take to answer. */
export const NATIVE_CALL_TIMEOUT_MS = 10 * SECOND_MS;
/** Stop sequence: after `quit`, before SIGTERM. */
export const NATIVE_QUIT_GRACE_MS = 2 * SECOND_MS;
/** Stop sequence: after SIGTERM, before SIGKILL. */
export const NATIVE_TERM_GRACE_MS = 3 * SECOND_MS;
/** Stop sequence: the reap must land within this after SIGKILL. */
export const NATIVE_REAP_MARGIN_MS = 1 * SECOND_MS;
/** The whole stop sequence, quit to reap. */
export const NATIVE_STOP_BUDGET_MS = NATIVE_QUIT_GRACE_MS + NATIVE_TERM_GRACE_MS + NATIVE_REAP_MARGIN_MS;
/** A `state` heartbeat that goes unanswered this long marks the run unresponsive. */
export const NATIVE_HEARTBEAT_MS = 5 * SECOND_MS;
/** stderr lines are cut here before they reach `native.log`. */
export const NATIVE_STDERR_LINE_MAX_CHARS = 2048;
/** The most stderr lines one `native.log` event carries. */
export const NATIVE_LOG_BATCH_MAX = 200;
/** A game past this memory footprint is killed. */
export const NATIVE_GAME_MEMORY_MAX_BYTES = 4 * 1024 ** 3;
/** Embedded runs: the shared-image ring size. */
export const NATIVE_FRAME_SLOTS = 3;
/** Embedded runs: the longest side of a ring slot, in device pixels. */
export const NATIVE_FRAME_SIDE_MAX = 4096;
/** Embedded runs: frames per second past which the game is refused. */
export const NATIVE_FRAME_RATE_MAX_PER_S = 240;
/** Native leases a host grants at once. */
export const NATIVE_LEASES_MAX = 4;
/** The most actions one `input` op carries. */
export const NATIVE_INPUT_ACTIONS_MAX = 5000;
/** Committed text, in UTF-16 units. */
export const NATIVE_TEXT_MAX_UNITS = 256;
/** Pads, buttons per pad and axes per pad. */
export const NATIVE_GAMEPADS_MAX = 4;
export const NATIVE_GAMEPAD_BUTTONS_MAX = 17;
export const NATIVE_GAMEPAD_AXES_MAX = 4;
/** The oldest macOS a Mac game runs on. */
export const MAC_MINIMUM_SYSTEM_VERSION = "13.0";
/** The highest WGSL extension points' bind layout version the host knows (v1 sources keep loading). */
export const NATIVE_EXTENSION_API_VERSION = 2;
/** The highest custom GPU pass API version the host knows; v2 adds stage `post-hdr`. */
export const NATIVE_CUSTOM_PASS_API_VERSION = 2;

/** Where in the frame a custom GPU pass runs; stages are appended, never renamed. Wire values. */
export const CustomPassStage = {
  BeforeCull: "before-cull",
  AfterOpaque: "after-opaque",
  AfterTransparent: "after-transparent",
  Post: "post",
  PostHdr: "post-hdr",
  /** After the depth/normal prepass, before ambient occlusion and the world pass (custom-pass API v2). */
  AfterPrepass: "after-prepass",
} as const;
export type CustomPassStage = (typeof CustomPassStage)[keyof typeof CustomPassStage];
/** The key under a game's `state().volatile` listing its custom GPU passes and each one's refusal code. */
export const NATIVE_CUSTOM_PASSES_KEY = "customPasses";
/** The key of what the renderer runs with, under `state().volatile`, and of a capture's provenance. */
export const NATIVE_RENDER_KEY = "render";
/** The `renderSettings` version a receipt advertises as `renderSettingsApi`. */
export const NATIVE_RENDER_SETTINGS_API_VERSION = 1;

// ── the renderer's quality (shared/render-quality.ts) ─────────────────────────────────────

/** A quality preset; `auto` follows the device class and is never an effective preset. Wire values. */
export const QualityPreset = {
  Auto: "auto",
  Low: "low",
  Medium: "medium",
  High: "high",
  Ultra: "ultra",
} as const;
export type QualityPreset = (typeof QualityPreset)[keyof typeof QualityPreset];
/** A preset a frame is drawn with. */
export type EffectivePreset = Exclude<QualityPreset, typeof QualityPreset.Auto>;
/** The effective presets, cheapest first. */
export const EFFECTIVE_PRESETS: readonly EffectivePreset[] = Object.freeze([
  QualityPreset.Low,
  QualityPreset.Medium,
  QualityPreset.High,
  QualityPreset.Ultra,
]);

/** Desktop or mobile. Wire values. */
export const FormFactor = { Desktop: "desktop", Mobile: "mobile" } as const;
export type FormFactor = (typeof FormFactor)[keyof typeof FormFactor];

/** How capable a device is within its form factor. Wire values. */
export const PerformanceTier = { Low: "low", Mid: "mid", High: "high", Ultra: "ultra" } as const;
export type PerformanceTier = (typeof PerformanceTier)[keyof typeof PerformanceTier];

/** A device class, `<form factor>-<tier>`. Wire values. */
export const DeviceClass = {
  DesktopUltra: "desktop-ultra",
  DesktopHigh: "desktop-high",
  DesktopMid: "desktop-mid",
  DesktopLow: "desktop-low",
  MobileHigh: "mobile-high",
  MobileMid: "mobile-mid",
  MobileLow: "mobile-low",
} as const satisfies Record<string, `${FormFactor}-${PerformanceTier}`>;
export type DeviceClass = (typeof DeviceClass)[keyof typeof DeviceClass];

/** A renderer feature with its own switch. Wire values. */
export const RenderFeature = {
  Hdr: "hdr",
  Tonemap: "tonemap",
  Exposure: "exposure",
  Ibl: "ibl",
  Sky: "sky",
  Shadows: "shadows",
  ContactShadows: "contact-shadows",
  Bloom: "bloom",
  Ao: "ao",
  Fog: "fog",
  Taa: "taa",
  Upscaler: "upscaler",
  Clustered: "clustered",
  Meshlets: "meshlets",
  Occlusion: "occlusion",
  Prepass: "prepass",
  TextureQuality: "texture-quality",
  SpotShadows: "spot-shadows",
} as const;
export type RenderFeature = (typeof RenderFeature)[keyof typeof RenderFeature];

/** Why a frame runs with less than asked (`volatile.render.degraded`). Wire values. */
export const DegradeReason = {
  CustomPassV1InWorld: "custom-pass-v1-in-world",
  MaterialV1InHdr: "material-v1-in-hdr",
  Budget: "budget",
  FormatUnrenderable: "format-unrenderable",
  PassOverBudget: "pass-over-budget",
  PipelineChangeDeferred: "pipeline-change-deferred",
  TransientUnsupported: "transient-unsupported",
  NotLanded: "not-landed",
} as const;
export type DegradeReason = (typeof DegradeReason)[keyof typeof DegradeReason];

/** Where a capture's settings came from. Wire values. */
export const SettingsSource = { Toml: "toml", ReferenceClass: "reference-class", Verb: "verb" } as const;
export type SettingsSource = (typeof SettingsSource)[keyof typeof SettingsSource];

/** How a capture's exposure was settled. Wire values. */
export const CaptureExposure = { Instant: "instant" } as const;
export type CaptureExposure = (typeof CaptureExposure)[keyof typeof CaptureExposure];

/** Optional adapter features the renderer opens the device with for itself. Wire values. */
export const RendererFeature = {
  TimestampQuery: "timestamp-query",
  Rg11b10UfloatRenderable: "rg11b10ufloat-renderable",
  DepthClipControl: "depth-clip-control",
  /** Compressed material textures (BC7, ASTC 4x4, ETC2 RGBA8). */
  TextureCompressionBc: "texture-compression-bc",
  TextureCompressionAstc: "texture-compression-astc",
  TextureCompressionEtc2: "texture-compression-etc2",
} as const;
export type RendererFeature = (typeof RendererFeature)[keyof typeof RendererFeature];

/** A frame input a v2 extension may read. Wire values. */
export const RenderInput = {
  Depth: "depth",
  Normals: "normals",
  Motion: "motion",
  Environment: "environment",
  HdrScene: "hdr-scene",
} as const;
export type RenderInput = (typeof RenderInput)[keyof typeof RenderInput];

/** What a game answers a `renderSettings` it refuses. Wire values. */
export const RenderSettingsRefusal = {
  Unavailable: "unavailable",
  UnknownPreset: "unknown-preset",
  UnknownDeviceClass: "unknown-device-class",
  UnknownFeature: "unknown-render-feature",
  InvalidScale: "invalid-render-scale",
  InvalidFrameBudget: "invalid-frame-budget",
} as const;
export type RenderSettingsRefusal = (typeof RenderSettingsRefusal)[keyof typeof RenderSettingsRefusal];

/** The render scale range, of the output size. */
export const RENDER_SCALE_MIN = 0.5;
export const RENDER_SCALE_MAX = 1;
/** The frame time range, in ms, `renderSettings` may ask dynamic resolution to hold. */
export const FRAME_BUDGET_MS_MIN = 1;
export const FRAME_BUDGET_MS_MAX = 100;
/** The most settle frames a capture re-renders. */
export const CAPTURE_SETTLE_FRAMES_MAX = 16;

/** What `renderSettings {set}` changes; a member left out stays. */
export interface RenderSettingsChange {
  /** The preset; null gives the game's and the person's own choice back. */
  preset?: QualityPreset | null;
  /** Emulate a class; null gives the probed class back. */
  deviceClass?: DeviceClass | null;
  /** Feature switches; null gives back the switches the verb set. */
  features?: Partial<Record<RenderFeature, boolean>> | null;
  /** Hold the render scale; null lets it move. */
  renderScaleLock?: number | null;
  /** The frame time, in ms, dynamic resolution holds instead of the class's; null gives it back. */
  frameBudgetMs?: number | null;
}

/** What `renderSettings` answers: the settings in force after the call. */
export interface RenderSettingsAnswer {
  preset: EffectivePreset;
  requested: QualityPreset;
  deviceClass: DeviceClass;
  detectedClass: DeviceClass;
  features: Partial<Record<RenderFeature, boolean>>;
  renderScaleLock: number | null;
  frameBudgetMs?: number | null;
  scale: number;
}

/** `state().volatile.render`: what the renderer runs with; never compared. */
export interface RenderStatus {
  deviceClass: DeviceClass;
  preset: EffectivePreset;
  scale: number;
  features: Partial<Record<RenderFeature, boolean>>;
  degraded: Array<{ reason: DegradeReason; subject: string | null }>;
  gpuMs: number | null;
  cpuMs: number | null;
  frames?: { rendered: number; repeated: number };
}

/** A capture's `render` provenance. */
export interface CaptureProvenance {
  preset: EffectivePreset;
  deviceClass: DeviceClass;
  settingsSource: SettingsSource;
  scale: number;
  settleFrames: number;
  historyReset: boolean;
  exposure: CaptureExposure;
}

// ── saves and the gameplay UI's settings (shared/game-saves.ts) ───────────────────────────

/** What a `saves` call does. Wire values: never rename one. */
export const SaveOp = {
  List: "list",
  Read: "read",
  Write: "write",
  Save: "save",
  Load: "load",
  Delete: "delete",
} as const;
export type SaveOp = (typeof SaveOp)[keyof typeof SaveOp];

/** Why a game refused a save, load or delete; nothing changed. Wire values: never rename one. */
export const SaveErrorCode = {
  SlotInvalid: "save-slot-invalid",
  SlotMissing: "save-slot-missing",
  SlotsFull: "save-slots-full",
  TooLarge: "save-too-large",
  Quota: "save-quota",
  Unavailable: "save-unavailable",
  Corrupt: "save-corrupt",
  FormatUnknown: "save-format-unknown",
  Newer: "save-newer",
  MigrationMissing: "save-migration-missing",
  MigrationFailed: "save-migration-failed",
  SectionInvalid: "save-section-invalid",
  SectionMissing: "save-section-missing",
  Busy: "save-busy",
  LoadTimeout: "save-load-timeout",
  NotConfigured: "save-not-configured",
} as const satisfies Record<string, `save-${string}`>;
export type SaveErrorCode = (typeof SaveErrorCode)[keyof typeof SaveErrorCode];

/** The volatile issue of a load that applied but whose recomputed checksum differs from the saved one. */
export const SAVE_RESTORE_DIVERGED = "save-restore-diverged";

/** Why a game's text could not be shown as asked. Wire values. */
export const TextErrorCode = {
  Missing: "text-missing",
  Invalid: "text-invalid",
  TooLarge: "text-too-large",
  LocaleUnknown: "text-locale-unknown",
  FontMissing: "text-font-missing",
} as const satisfies Record<string, `text-${string}`>;
export type TextErrorCode = (typeof TextErrorCode)[keyof typeof TextErrorCode];

/** The most bytes a slot name holds; the most characters a label holds. */
export const SAVE_SLOT_NAME_MAX = 32;
export const SAVE_LABEL_CHARS_MAX = 64;
/** The most bytes of JSON an envelope a `saves` call carries or answers may hold. */
export const NATIVE_SAVES_ENVELOPE_MAX_BYTES = 1024 * 1024 - 4 * 1024;
/** The longest locale tag; the UI scale and text size range; the largest safe-area inset (world px). */
export const UI_LOCALE_TAG_CHARS_MAX = 35;
export const UI_SCALE_MIN = 0.5;
export const UI_SCALE_MAX = 3.0;
export const UI_TEXT_SIZE_MIN = UI_SCALE_MIN;
export const UI_TEXT_SIZE_MAX = UI_SCALE_MAX;
export const UI_SAFE_AREA_MAX_PX = 4096;

/** A `saves` argument; the host refuses anything else `bad-argument` before it is sent. */
export type SavesArg =
  | { op: typeof SaveOp.List }
  | { op: typeof SaveOp.Read | typeof SaveOp.Load | typeof SaveOp.Delete; slot: string }
  | { op: typeof SaveOp.Save; slot: string; label?: string }
  | { op: typeof SaveOp.Write; slot: string; envelope: Record<string, unknown> };

/** The UI's left, top, right and bottom safe-area insets, in world pixels. */
export type UiSafeArea = [left: number, top: number, right: number, bottom: number];

/** A `uiSettings` change: a member left out stays, null gives the game's own back, none reads. */
export interface UiSettingsArg {
  locale?: string | null;
  scale?: number | null;
  safeArea?: UiSafeArea | null;
  textSize?: number | null;
}

/** A pad's state as the Gamepad API reports it. */
export interface NativeGamepadAction {
  type: typeof NativeInputKind.Gamepad;
  index: number;
  buttons: readonly number[];
  axes: readonly number[];
  /** The kind of pad, for its labels; absent reads as generic. */
  family?: NativeGamepadFamily;
}

/** Committed text. */
export interface NativeTextAction {
  type: typeof NativeInputKind.Text;
  text: string;
}

/** Where one finger is in its touch. Wire values. */
export const TouchPhase = {
  Start: "start",
  Move: "move",
  End: "end",
} as const;
export type TouchPhase = (typeof TouchPhase)[keyof typeof TouchPhase];

/** One finger's step in world coordinates (contract v2); `id` ties a start to its moves and end. */
export interface NativeTouchAction {
  type: typeof NativeInputKind.Touch;
  phase: TouchPhase;
  id: number;
  x: number;
  y: number;
}

/** Everything the `input` op takes. */
export type NativeInputAction = PreviewInputAction | NativeGamepadAction | NativeTextAction | NativeTouchAction;

/** The part of the screen nothing covers: insets in physical pixels. */
export interface NativeSafeArea {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** What a protocol 2 game's `state()` must carry beside its own fields. */
export type NativeStateV2 = Record<string, unknown> & { lifecycle: NativeLifecycle; safeArea: NativeSafeArea };

/** What `capture` answers before the host reads the file. */
export interface NativeCaptureReply {
  seq: number;
  width: number;
  height: number;
  format: typeof NATIVE_CAPTURE_FORMAT;
  /** FNV-1a 64 of the BGRA bytes, 16 lowercase hex. */
  digest: string;
  /** The camera or eye the game drew this frame from (a Rust · wgpu game says; a C++ game does not). */
  camera?: string;
  /** The settings the frame was drawn with (a Rust · wgpu game with `renderSettings` says). */
  render?: CaptureProvenance;
}

/**
 * What a capture asks of the look's lens (a Rust · wgpu game): its depth of field and motion blur,
 * neither by default, so a capture is a still of the held frame.
 */
export interface NativeCaptureLens {
  depthOfField?: boolean;
  motionBlur?: boolean;
}

/** A size a capture is asked to draw at, in whole pixels (a Rust · wgpu game). */
export interface NativeCaptureSize {
  width: number;
  height: number;
}

/** Per-op arguments; ops absent take none. */
export interface NativeOpArgs {
  [NativeOp.Seed]: { seed: number };
  [NativeOp.Step]: { ms: number };
  [NativeOp.Input]: { actions: NativeInputAction[] };
  [NativeOp.Capture]: { camera?: string; size?: NativeCaptureSize; lens?: NativeCaptureLens };
  [NativeOp.DebugCamera]: { camera: string | null };
  [NativeOp.Demo]: { name: string };
  [NativeOp.Audio]: { muted: boolean };
  [NativeOp.Visible]: { visible: boolean };
  [NativeOp.Surface]: { w: number; h: number; dpr: number; slots: number; generation: number };
  [NativeOp.Release]: { slot: number; generation: number };
  [NativeOp.RenderSettings]: { set?: RenderSettingsChange };
  [NativeOp.BakeAssets]: { kind: BakeKind; name: string };
  [NativeOp.ReloadAssets]: { files: NativeReloadFile[] };
  [NativeOp.Profile]: { action: FrameProfileAction; frames?: number; mode?: GpuTimingMode };
  [NativeOp.Saves]: SavesArg;
  [NativeOp.UiSettings]: UiSettingsArg;
}

/** Per-op results, as the host checks every reply against them. Fields beyond these are ignored. */
export interface NativeOpResults {
  [NativeOp.Seed]: { seed: number; paused: true };
  [NativeOp.Start]: { running: boolean };
  [NativeOp.Pause]: { running: boolean };
  [NativeOp.Step]: { frame: number; simulatedMs: number; steppedFrames: number; drawCalls: number };
  [NativeOp.State]: Record<string, unknown>;
  [NativeOp.Input]: { held: string[] };
  [NativeOp.Capture]: NativeCaptureReply;
  [NativeOp.DebugCamera]: { ok: boolean; camera?: string; available?: string[] };
  [NativeOp.Cameras]: { cameras: string[] };
  [NativeOp.Eyes]: { eyes: string[] };
  [NativeOp.Demos]: { demos: string[] };
  [NativeOp.Demo]: { ok: boolean; demo?: string; result?: unknown; available?: string[] };
  [NativeOp.Audio]: { muted: boolean };
  [NativeOp.AudioLevel]: { rms: number; centroid: number };
  [NativeOp.Timing]: { frameMs: number; updateMs: number; drawMs: number; frames: number };
  [NativeOp.Quit]: { quitting: true };
  [NativeOp.Front]: { fronted: boolean };
  [NativeOp.Visible]: { visible: boolean };
  [NativeOp.Surface]: { generation: number; width: number; height: number; slots: number };
  [NativeOp.Release]: Record<string, never>;
  [NativeOp.RenderSettings]: RenderSettingsAnswer;
  [NativeOp.BakeAssets]: NativeBakeReply;
  [NativeOp.ReloadAssets]: NativeReloadAnswer;
  /** Checked by shape only (summary `v: 1`, report `v: 2`, `{mode}` or `{bytes, digest}`); read it field by field. */
  [NativeOp.Profile]: Record<string, unknown>;
  /** An object (a list, an envelope or its `tooLarge` stand-in, a slot, a load's checksum); read the members asked for. */
  [NativeOp.Saves]: Record<string, unknown>;
  /** The settings in force after the call. */
  [NativeOp.UiSettings]: Record<string, unknown>;
}

/** Names a list answer may carry, and how long each may be. */
const NAMES_MAX = 512;
const NAME_MAX_CHARS = 256;
/** A digest is FNV-1a 64 as 16 lowercase hex. */
const DIGEST = /^[0-9a-f]{16}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isSide = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= NATIVE_CAPTURE_MAX_PX;
const isNames = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= NAMES_MAX &&
  value.every((name) => typeof name === "string" && name.length <= NAME_MAX_CHARS);
const isOptional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length <= NAME_MAX_CHARS;
const hasFlag = (value: unknown, field: string): boolean => isRecord(value) && typeof value[field] === "boolean";
const hasNames = (value: unknown, field: string): boolean => isRecord(value) && isNames(value[field]);

/**
 * What a compiled game's web page answers to `audio()` with no argument (`PageMethod.Audio`; a
 * native run answers `audioLevel` instead): the game's own mix before the mute, as `rms` and
 * spectral `centroid`. `available` is false when the build exports no level or the level could not
 * be read; its numbers then read 0 and are never judged.
 */
export interface NativeAudioAnswer {
  available: boolean;
  rms: number;
  centroid: number;
}

/** Whether `value` is a page `audio()` answer: `available` a flag, the level finite and not negative. */
export function isNativeAudioAnswer(value: unknown): value is NativeAudioAnswer {
  const level = (n: unknown) => isFiniteNumber(n) && n >= 0;
  return isRecord(value) && typeof value.available === "boolean" && level(value.rms) && level(value.centroid);
}

/** Whether a page `audio()` answer measured the game's level: a well-formed answer that says `available`. */
export function isNativeAudioMeasured(value: unknown): value is NativeAudioAnswer & { available: true } {
  return isNativeAudioAnswer(value) && value.available;
}
/** A ring generation is a uint32 the host chose, from 1; a slot side is at most `NATIVE_FRAME_SIDE_MAX`. */
const GENERATION_MAX = 0xffff_ffff;
const isGeneration = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= GENERATION_MAX;
const isRingSide = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= NATIVE_FRAME_SIDE_MAX;
/** Whether `value` is one of `vocabulary`'s values. */
const isOneOf = (vocabulary: Record<string, string>, value: unknown): boolean =>
  typeof value === "string" && Object.values(vocabulary).includes(value);
const isEffectivePreset = (value: unknown): boolean => isOneOf(QualityPreset, value) && value !== QualityPreset.Auto;
const isRenderScale = (value: unknown): boolean =>
  typeof value === "number" && value >= RENDER_SCALE_MIN && value <= RENDER_SCALE_MAX;
/** A held frame budget: absent (an older game), none, or inside its range. */
const isHeldBudget = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "number" && value >= FRAME_BUDGET_MS_MIN && value <= FRAME_BUDGET_MS_MAX);
const isFeatureSwitches = (value: unknown): boolean =>
  isRecord(value) && Object.entries(value).every(([key, on]) => isOneOf(RenderFeature, key) && typeof on === "boolean");
const isRenderSettingsAnswer = (value: unknown): boolean =>
  isRecord(value) &&
  isEffectivePreset(value.preset) &&
  isOneOf(QualityPreset, value.requested) &&
  isOneOf(DeviceClass, value.deviceClass) &&
  isOneOf(DeviceClass, value.detectedClass) &&
  (value.renderScaleLock === null || isRenderScale(value.renderScaleLock)) &&
  isHeldBudget(value.frameBudgetMs) &&
  isFeatureSwitches(value.features) &&
  isRenderScale(value.scale);
const isSettleFrames = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= CAPTURE_SETTLE_FRAMES_MAX;
const isCaptureProvenance = (value: unknown): boolean =>
  isRecord(value) &&
  isEffectivePreset(value.preset) &&
  isOneOf(DeviceClass, value.deviceClass) &&
  isOneOf(SettingsSource, value.settingsSource) &&
  isRenderScale(value.scale) &&
  isSettleFrames(value.settleFrames) &&
  typeof value.historyReset === "boolean" &&
  isOneOf(CaptureExposure, value.exposure);

const isReloadRefused = (value: unknown): boolean =>
  isRecord(value) && isText(value.path) && isOneOf(ReloadRefusal, value.code);
const isBakeReply = (value: unknown): boolean =>
  isRecord(value) &&
  isOneOf(BakeKind, value.kind) &&
  isBakeName(value.name) &&
  isCount(value.bytes) &&
  value.bytes <= NATIVE_BAKE_MAX_BYTES &&
  typeof value.digest === "string" &&
  DIGEST.test(value.digest);
const isReloadAnswer = (value: unknown): boolean =>
  isRecord(value) &&
  isNames(value.reloaded) &&
  value.reloaded.length <= NATIVE_RELOAD_FILES_MAX &&
  Array.isArray(value.refused) &&
  value.refused.length <= NATIVE_RELOAD_FILES_MAX &&
  value.refused.every(isReloadRefused) &&
  isCount(value.pending);
/** A profile summary, report, arm or trace answer, by shape. */
const isProfileReply = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.v === PROFILE_SUMMARY_VERSION) return typeof value.on === "boolean" && isCount(value.frames);
  if (value.v === PROFILE_REPORT_VERSION) return Array.isArray(value.frames) && typeof value.truncated === "boolean";
  if (Object.hasOwn(value, "mode")) return isOneOf(GpuTimingMode, value.mode);
  return isCount(value.bytes) && typeof value.digest === "string" && DIGEST.test(value.digest);
};

/** One validator per op. */
const RESULT_CHECKS: { readonly [K in keyof NativeOpResults]: (value: unknown) => boolean } = {
  [NativeOp.Seed]: (value) => isRecord(value) && isFiniteNumber(value.seed) && value.paused === true,
  [NativeOp.Start]: (value) => hasFlag(value, "running"),
  [NativeOp.Pause]: (value) => hasFlag(value, "running"),
  [NativeOp.Step]: (value) =>
    isRecord(value) &&
    isCount(value.frame) &&
    isFiniteNumber(value.simulatedMs) &&
    isCount(value.steppedFrames) &&
    isCount(value.drawCalls),
  [NativeOp.State]: isRecord,
  [NativeOp.Input]: (value) => hasNames(value, "held"),
  [NativeOp.Capture]: (value) =>
    isRecord(value) &&
    isCount(value.seq) &&
    isSide(value.width) &&
    isSide(value.height) &&
    value.format === NATIVE_CAPTURE_FORMAT &&
    typeof value.digest === "string" &&
    DIGEST.test(value.digest) &&
    isOptional(value[NATIVE_RENDER_KEY], isCaptureProvenance),
  [NativeOp.DebugCamera]: (value) =>
    hasFlag(value, "ok") && isRecord(value) && isOptional(value.camera, isText) && isOptional(value.available, isNames),
  [NativeOp.Cameras]: (value) => hasNames(value, "cameras"),
  [NativeOp.Eyes]: (value) => hasNames(value, "eyes"),
  [NativeOp.Demos]: (value) => hasNames(value, "demos"),
  [NativeOp.Demo]: (value) =>
    hasFlag(value, "ok") && isRecord(value) && isOptional(value.demo, isText) && isOptional(value.available, isNames),
  [NativeOp.Audio]: (value) => hasFlag(value, "muted"),
  [NativeOp.AudioLevel]: (value) => isRecord(value) && isFiniteNumber(value.rms) && isFiniteNumber(value.centroid),
  [NativeOp.Timing]: (value) =>
    isRecord(value) &&
    isFiniteNumber(value.frameMs) &&
    isFiniteNumber(value.updateMs) &&
    isFiniteNumber(value.drawMs) &&
    isCount(value.frames),
  [NativeOp.Quit]: (value) => isRecord(value) && value.quitting === true,
  [NativeOp.Front]: (value) => hasFlag(value, "fronted"),
  [NativeOp.Visible]: (value) => hasFlag(value, "visible"),
  [NativeOp.Surface]: (value) =>
    isRecord(value) &&
    isGeneration(value.generation) &&
    isRingSide(value.width) &&
    isRingSide(value.height) &&
    Number.isSafeInteger(value.slots) &&
    Number(value.slots) >= 1 &&
    Number(value.slots) <= NATIVE_FRAME_SLOTS,
  [NativeOp.Release]: isRecord,
  [NativeOp.RenderSettings]: isRenderSettingsAnswer,
  [NativeOp.BakeAssets]: isBakeReply,
  [NativeOp.ReloadAssets]: isReloadAnswer,
  [NativeOp.Profile]: isProfileReply,
  [NativeOp.Saves]: isRecord,
  [NativeOp.UiSettings]: isRecord,
};

const LIFECYCLES: ReadonlySet<string> = new Set<NativeLifecycle>(Object.values(NativeLifecycle));
/** A safe-area inset is at most this many physical pixels. */
const SAFE_AREA_INSET_MAX_PX = 16_384;
const isInset = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= SAFE_AREA_INSET_MAX_PX;
const isSafeArea = (value: unknown): boolean =>
  isRecord(value) && [value.top, value.left, value.bottom, value.right].every(isInset);

/** What protocol 2 adds to an op's check: a v2 `state()` carries a known lifecycle and a whole safe area. */
const V2_RESULT_CHECKS: Partial<Readonly<Record<NativeOp, (value: unknown) => boolean>>> = {
  [NativeOp.State]: (value) =>
    isRecord(value) &&
    typeof value.lifecycle === "string" &&
    LIFECYCLES.has(value.lifecycle) &&
    isSafeArea(value.safeArea),
};

/**
 * Checks an untrusted reply's `result` for `op`, exactly as the host does, as the game's negotiated
 * `protocol` shapes it (protocol 1 when absent); false means `ReplyInvalid`.
 */
export function isNativeResult<K extends keyof NativeOpResults>(
  op: K,
  value: unknown,
  protocol: NativeProtocolVersion = NATIVE_PROTOCOL_V1,
): value is NativeOpResults[K] {
  if (!Object.hasOwn(RESULT_CHECKS, op) || !RESULT_CHECKS[op](value)) return false;
  const v2 = protocol === NATIVE_PROTOCOL_VERSION ? V2_RESULT_CHECKS[op] : undefined;
  return v2 === undefined || v2(value);
}

// ── the game conformance suite ────────────────────────────────────────────────────────────

/**
 * The checks the host's game conformance suite runs on a built game (`HostMethod.GameConformance`
 * answers one result per check, in this order). Wire values: never rename one.
 */
export const ConformanceCheck = {
  Verbs: "verbs",
  SeedDeterminism: "seed-determinism",
  CaptureDigest: "capture-digest",
  LiveRing: "live-ring",
  StopReap: "stop-reap",
  RenderPresets: "render-presets",
  RenderExtensions: "render-extensions",
} as const;
export type ConformanceCheck = (typeof ConformanceCheck)[keyof typeof ConformanceCheck];

// ── what a raylib game can be measured on ──────────────────────────────────────────────────

/** Whether a check kind can be measured on a raylib game (web or native). Unsupported is never a pass. */
export const CheckSupport = { Measured: "measured", Unmeasured: "unmeasured" } as const;
export type CheckSupport = (typeof CheckSupport)[keyof typeof CheckSupport];

/** Scene checks are honest `unmeasured`; everything that reads pixels, `state()` or plays runs. */
export const RAYLIB_CHECK_SUPPORT = {
  [CheckKind.Scene]: CheckSupport.Unmeasured,
  [CheckKind.Pixel]: CheckSupport.Measured,
  [CheckKind.Metric]: CheckSupport.Measured,
  [CheckKind.Probe]: CheckSupport.Measured,
  [CheckKind.Demo]: CheckSupport.Measured,
  [CheckKind.Vision]: CheckSupport.Measured,
  [CheckKind.Play]: CheckSupport.Measured,
} as const satisfies Record<CheckKind, CheckSupport>;

/**
 * Which check kinds each stack's games can be measured on. A three.js page measures every kind;
 * a raylib or Rust · wgpu game has no scene graph to read, so its scene checks are `unmeasured`
 * by name, never a pass, and everything that reads pixels, `state()` or plays runs.
 */
export const STACK_CHECK_SUPPORT = {
  [GameStack.ThreeJs]: {
    [CheckKind.Scene]: CheckSupport.Measured,
    [CheckKind.Pixel]: CheckSupport.Measured,
    [CheckKind.Metric]: CheckSupport.Measured,
    [CheckKind.Probe]: CheckSupport.Measured,
    [CheckKind.Demo]: CheckSupport.Measured,
    [CheckKind.Vision]: CheckSupport.Measured,
    [CheckKind.Play]: CheckSupport.Measured,
  },
  [GameStack.RaylibCpp]: RAYLIB_CHECK_SUPPORT,
  [GameStack.RustWgpu]: {
    [CheckKind.Scene]: CheckSupport.Unmeasured,
    [CheckKind.Pixel]: CheckSupport.Measured,
    [CheckKind.Metric]: CheckSupport.Measured,
    [CheckKind.Probe]: CheckSupport.Measured,
    [CheckKind.Demo]: CheckSupport.Measured,
    [CheckKind.Vision]: CheckSupport.Measured,
    [CheckKind.Play]: CheckSupport.Measured,
  },
} as const satisfies Record<GameStack, Record<CheckKind, CheckSupport>>;

/** Whether a check of `kind` can be measured on a game of `stack`. */
export function checkSupportFor(stack: GameStack, kind: CheckKind): CheckSupport {
  return STACK_CHECK_SUPPORT[stack][kind];
}

/** Evidence probes whose raylib support differs from Three.js. Wire values (evidence rows): never rename one. */
export const NativeProbe = {
  Audio: "audio",
  Profiler: "profiler",
  GpuErrors: "gpuErrors",
  PageUi: "pageUi",
  UserView: "userView",
  FrameSimilarity: "frameSimilarity",
} as const;
export type NativeProbe = (typeof NativeProbe)[keyof typeof NativeProbe];

/** Probes with no counterpart on a raylib web build: reported `unmeasured` by name, never pass. */
export const RAYLIB_WEB_UNMEASURED: readonly NativeProbe[] = [NativeProbe.Audio, NativeProbe.Profiler];
/**
 * Probes a Rust · wgpu web build never measures. Its sound is measured when the page's `audio()`
 * answers `available` ({@link isNativeAudioMeasured}), and named unmeasured otherwise.
 */
export const RUST_WEB_UNMEASURED: readonly NativeProbe[] = [NativeProbe.Profiler];
/** Probes with no counterpart on a native run (frame similarity until it is measured). */
export const RAYLIB_NATIVE_UNMEASURED: readonly NativeProbe[] = [
  NativeProbe.GpuErrors,
  NativeProbe.PageUi,
  NativeProbe.UserView,
  NativeProbe.FrameSimilarity,
];

/** Why a raylib night is refused before it starts. Wire values (the error's `code`): never rename one. */
export const NativeNightRefusal = {
  /** A part the night runs was kept from before the native contract: it has no `SERVES_NATIVE` mark. */
  PartsMissing: "native-parts-missing",
  /** A Rust · wgpu night: a part it runs was kept from before Rust games, so it has no `SERVES_RUST` mark. */
  RustPartsMissing: "rust-parts-missing",
} as const;
export type NativeNightRefusal = (typeof NativeNightRefusal)[keyof typeof NativeNightRefusal];

/** The error a refused raylib night throws: the chat's sentence, with its typed `code` beside it. */
export function nativeNightRefused(code: NativeNightRefusal, sentence: string): Error & { code: NativeNightRefusal } {
  return Object.assign(new Error(sentence), { code });
}

/**
 * Does every seed part a raylib night depends on serve one? Each part is a module namespace
 * (`import * as self from "./run-dispatch.ts"`); a part kept from before the native contract has
 * no `SERVES_NATIVE` mark, and a raylib night on it is refused instead of judged on a page it
 * cannot read.
 */
export function servesNative(parts: readonly Readonly<Record<string, unknown>>[]): boolean {
  return parts.every((part) => part.SERVES_NATIVE === true);
}

/**
 * Does every seed part a Rust · wgpu night depends on serve one (run-dispatch.ts `RUST_PARTS`)? A
 * part kept from before Rust games has no `SERVES_RUST` mark and routes by binary raylib checks,
 * which would send a Rust game down the three.js path without a word: the night is refused.
 */
export function servesRust(parts: readonly Readonly<Record<string, unknown>>[]): boolean {
  return parts.every((part) => part.SERVES_RUST === true);
}

/**
 * The stacks a harness serves, in the order a lease declares them: three.js always, raylib when
 * every part a raylib night runs says so, Rust · wgpu when every part a Rust night runs says so.
 */
export function stacksServed(served: { native: boolean; rust: boolean }): GameStack[] {
  const stacks: GameStack[] = [GameStack.ThreeJs];
  if (served.native) stacks.push(GameStack.RaylibCpp);
  if (served.rust) stacks.push(GameStack.RustWgpu);
  return stacks;
}

/** Until the night's start says what it serves, a lease declares what every seed since native support served. */
const PRE_RUST_STACKS = stacksServed({ native: true, rust: false });

/** What this harness serves, asked each time a lease is acquired (run-dispatch.ts registers it). */
let servedNow: () => readonly GameStack[] = () => PRE_RUST_STACKS;

/**
 * Registers how this harness reads the stacks it serves. run-dispatch.ts calls it once with a
 * reader of its parts' marks, read lazily: a part may still be loading when the start is.
 */
export function serveStacksFrom(read: () => readonly GameStack[]): void {
  servedNow = read;
}

/** The stacks every lease this harness acquires declares (`preview.acquire {stacks}`). */
export function servedStacks(): readonly GameStack[] {
  return servedNow();
}

// ── leases that always name their target ───────────────────────────────────────────────────

/** What `acquireFor` needs of `ctx.call`: the `preview.acquire` call. */
export type AcquireCall = (
  method: typeof HostMethod.PreviewAcquire,
  params: HarnessHostApi["preview.acquire"]["params"],
) => Promise<HarnessHostApi["preview.acquire"]["result"]>;

/** The game a lease is for: its destinations (`GameProject.destinations`); absent is a Three.js browser game. */
export interface LeaseGame {
  destinations?: Destinations;
}

/** What `preview.capacity` says about the host: its platform and whether it has a game box. */
export interface LeaseCapacity {
  host?: StudioPlatform | null;
  native?: { gameBox: boolean } | null;
}

/** A lease and the build it judges. */
export interface JudgedLease extends JudgingTarget {
  handle: string;
}

/** A game that names no destinations: a Three.js browser game. */
const BROWSER_ONLY: Destinations = { stack: GameStack.ThreeJs, targets: [BuildTarget.Web] };

/** The one purpose a lease may name: a window fit for the optimizer's profile. */
const OPTIMIZATION_PURPOSE = "optimization" satisfies NonNullable<
  HarnessHostApi["preview.acquire"]["params"]["purpose"]
>;

/** The web build of a game, as judging-only when Browser is not one of its destinations. */
function webJudging(destinations: Destinations): JudgingTarget {
  return { target: BuildTarget.Web, judgingOnly: !destinations.targets.includes(BuildTarget.Web) };
}

/**
 * The target a lease for `game` judges: `judgingTarget` on the host `capacity` names (Web when
 * Browser is a destination, else a desktop build this host runs in its game box, else a
 * judging-only web build). A host that names no platform answers the judging-only web build.
 */
export function leaseTarget(game: LeaseGame, capacity: LeaseCapacity): JudgingTarget {
  const destinations = game.destinations ?? BROWSER_ONLY;
  if (!capacity.host) return webJudging(destinations);
  return judgingTarget(destinations, capacity.host, { gameBox: capacity.native?.gameBox === true });
}

/** What a lease this harness acquired judges, and for which game on which host (`leasedJudging`). */
export interface LeasedJudging extends JudgingTarget {
  destinations: Destinations;
  capacity: LeaseCapacity;
}

/** The leases remembered at once; the oldest is forgotten first. */
const LEASES_REMEMBERED_MAX = 256;
/** Every lease `acquireFor` acquired, by handle: the evidence pass reads which build it looks at. */
const LEASED = new Map<string, LeasedJudging>();

/** What the lease `handle` judges, when this harness acquired it through `acquireFor`; else null. */
export function leasedJudging(handle: string | null | undefined): LeasedJudging | null {
  return handle ? (LEASED.get(handle) ?? null) : null;
}

/** Remembers what a lease judges, forgetting the oldest beyond the cap. */
function rememberLease(handle: string, leased: LeasedJudging): void {
  LEASED.delete(handle);
  LEASED.set(handle, leased);
  const oldest = LEASED.size > LEASES_REMEMBERED_MAX ? LEASED.keys().next().value : undefined;
  if (oldest !== undefined) LEASED.delete(oldest);
}

/**
 * Acquires a lease that names its judging target and the stacks this harness serves, always: the
 * host refuses a raylib game's preview on a lease without a target, and a Rust game's on one whose
 * harness does not declare Rust (`harness-predates-native`), so every evidence acquire goes here.
 * The optimizer's lease is always a web build: its profile reads a page, and a native lease
 * refuses candidate loads.
 */
export async function acquireFor(
  call: AcquireCall,
  game: LeaseGame,
  capacity: LeaseCapacity,
  request: { label?: string; purpose?: "optimization" } = {},
): Promise<JudgedLease> {
  const destinations = game.destinations ?? BROWSER_ONLY;
  const judged = request.purpose === OPTIMIZATION_PURPOSE ? webJudging(destinations) : leaseTarget(game, capacity);
  // The lease declares the stacks this harness serves: the host loads a Rust game only through a
  // lease whose harness says it serves Rust games.
  const stacks = [...servedStacks()];
  const { handle } = await call(HostMethod.PreviewAcquire, { ...request, target: judged.target, stacks });
  rememberLease(handle, { ...judged, destinations, capacity });
  return { handle, ...judged };
}

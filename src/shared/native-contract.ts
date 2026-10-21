/**
 * The native run contract: how the host talks to a compiled game it started (a C++ · raylib or a
 * Rust · wgpu game; NDJSON on fd 3, one JSON object per line), what a run looks like to the
 * renderer and the harness, and the checks every untrusted line goes through before anything
 * reads it. Browser-safe: the renderer words the states and refusals, main and the substrate run
 * the games. The harness seed keeps a copy in `loop/native-contract.ts`, held to this one by
 * `seed-contracts.test.ts`; the Rust runtime's side is genex-studio's `wire.rs`, held to this one
 * through `tests/fixtures/native-wire-v2.json`.
 *
 * Contract v2 (Rust · wgpu): `ready` states protocol 2 and carries the capability receipt,
 * `state()` carries `lifecycle` and `safeArea`, `input` takes `touch`. A protocol 1 game (every
 * raylib game) is read exactly as before. The renderer's quality (`renderSettings`,
 * `state().volatile.render`, a capture's `render` provenance) speaks `shared/render-quality.ts`.
 */
import { SandboxProblemCode } from "./boot.ts";
import type { BuildProblem } from "./build-problem.ts";
import { SECOND_MS } from "./duration.ts";
import { BuildTarget, type CompiledStack, GameStack } from "./game-project.ts";
import { type CrashKind, type CrashRecordV1, parseCrashRecord } from "./crash-record.ts";
import {
  type FrameProfileAction,
  GpuTimingMode,
  PROFILE_REPORT_VERSION,
  PROFILE_SUMMARY_VERSION,
} from "./frame-profile.ts";
import type { SavesArg, UiSettingsArg } from "./game-saves.ts";
import { DestinationBadge, TargetRefusal } from "./game-targets.ts";
import { type PreviewInputAction, type PreviewTouchAction, TouchPhase } from "./preview-contract.ts";
import {
  type CaptureProvenance,
  FRAME_BUDGET_MS_MAX,
  FRAME_BUDGET_MS_MIN,
  isCaptureProvenance,
  isDeviceClass,
  isFeatureSwitches,
  isQualityPreset,
  isRendererFeature,
  isRenderFeature,
  isRenderInput,
  isRenderSettingsAnswer,
  parseRenderStatus,
  RENDER_SCALE_MAX,
  RENDER_SCALE_MIN,
  type RendererFeature,
  type RenderInput,
  type RenderSettingsAnswer,
  type RenderSettingsChange,
  RenderSettingsRefusal,
  type RenderStatus,
} from "./render-quality.ts";

/** Protocol 1: every C++ · raylib game, and a Rust game made before contract v2. Frozen. */
export const NATIVE_PROTOCOL_V1 = 1;
/** The newest protocol the host speaks (contract v2: receipt, lifecycle, safe area, touch). */
export const NATIVE_PROTOCOL_VERSION = 2;
/** A protocol the host accepts in `ready`. */
export type NativeProtocolVersion = typeof NATIVE_PROTOCOL_V1 | typeof NATIVE_PROTOCOL_VERSION;
/** Every protocol a `ready` may state, oldest first: the handshake refuses any other (`bad-handshake`). */
export const NATIVE_PROTOCOL_VERSIONS: readonly NativeProtocolVersion[] = Object.freeze([
  NATIVE_PROTOCOL_V1,
  NATIVE_PROTOCOL_VERSION,
]);

/** Whether a `ready`'s `protocol` is one this host speaks. */
export function isNativeProtocolVersion(value: unknown): value is NativeProtocolVersion {
  return NATIVE_PROTOCOL_VERSIONS.some((version) => version === value);
}

/** The ops the host sends on fd 3 (`{id, op, arg?}`). Wire values: never rename one. Names follow `PageMethod`. */
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
  /** Raise the game's window (the card's "Bring to front"); a headless run answers `{fronted: false}`. */
  Front: "front",
  /** Show or hide a window run (the hidden-window fallback); headless runs pause instead. */
  Visible: "visible",
  /** Embedded runs: create the shared-image ring. */
  Surface: "surface",
  /** Embedded runs: give a slot back to the game. */
  Release: "release",
  /**
   * Read or change the renderer's quality: the preset, an emulated device class, feature switches
   * and a render-scale lock (`shared/render-quality.ts`). A game whose receipt does not advertise
   * `renderSettingsApi` answers `unknown-op` (made before the verb) or `unavailable`.
   */
  RenderSettings: "renderSettings",
  /**
   * Run one bake the game registered (`{kind, name}`: a navmesh, an impostor atlas) and write its
   * output into the run's `state/bakes/<kind>/<name>`, answering its size and digest. Dev flavour
   * only: a build step sends it to a headless session after the dev build, never an agent; an
   * export answers `unknown-op`, a game that serves no bakes yet `unavailable`.
   */
  BakeAssets: "bakeAssets",
  /**
   * Swap named asset files in a running game (`{files: [{path, digest}]}`) without a rebuild: each
   * is re-read on the next frame. Dev flavour only (Live and hidden runs); an export answers
   * `unknown-op`, a game that does not serve it yet `unavailable`, one mid-reload `busy`.
   */
  ReloadAssets: "reloadAssets",
  /**
   * Read the game's frame profile (`{action, frames?, mode?}`, `shared/frame-profile.ts`): the
   * summary, a `ProfileReport` v2, arming per-node GPU timing, or a Chrome trace written into the
   * run's `state/profile/`. Dev flavour only; an export (or a game made before the verb) answers
   * `unknown-op`, a game that serves no profiles yet `unavailable`.
   */
  Profile: "profile",
  /**
   * List, read, write, save, load or delete the game's save slots (`{op, slot?, label?,
   * envelope?}`, `shared/game-saves.ts`); a load answers once it applied. Checked before it is
   * sent (`checkSavesArg`); a game made before the verb answers `unknown-op`, one that registered
   * no saves `save-not-configured`.
   */
  Saves: "saves",
  /**
   * A session layer over the gameplay UI's settings (`{locale?, scale?, safeArea?, textSize?}`,
   * `shared/game-saves.ts`), applied at the next tick; no member reads them. Checked before it is
   * sent (`checkUiSettingsArg`); a game made before the verb answers `unknown-op`.
   */
  UiSettings: "uiSettings",
} as const;
export type NativeOp = (typeof NativeOp)[keyof typeof NativeOp];

/** What a `bakeAssets` bakes: the game's registered bake of that kind. Wire values: never rename one. */
export const BakeKind = {
  /** A navmesh (`game.nav_bake`), loaded with `NavMesh::from_bytes`. */
  Nav: "nav",
  /** An impostor atlas of a model that opted in. */
  Impostor: "impostor",
} as const;
export type BakeKind = (typeof BakeKind)[keyof typeof BakeKind];

/** The most bytes one bake's output may hold; a reply declaring more is refused before any read. */
export const NATIVE_BAKE_MAX_BYTES = 256 * 1024 * 1024;
/** The most files one `reloadAssets` names. */
export const NATIVE_RELOAD_FILES_MAX = 256;

/** A bake's name is one path segment: lowercase letters, digits, `-` and `_`, at most 64, never a dot. */
const BAKE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Whether `value` is a bake name: it names a file in `state/bakes/<kind>/` and can never climb out. */
export function isBakeName(value: unknown): value is string {
  return typeof value === "string" && BAKE_NAME.test(value);
}

/** Why `reloadAssets` refused one file (its answer's `refused[].code`). Wire values: never rename one. */
export const ReloadRefusal = {
  /** The path breaks the asset-path rule: absolute, climbing, a link out of `assets/`. */
  UnsafePath: "unsafe-path",
  /** The bytes the game's source serves now do not have the digest the host named. */
  DigestMismatch: "digest-mismatch",
  /** Nothing is there. */
  Missing: "missing",
} as const;
export type ReloadRefusal = (typeof ReloadRefusal)[keyof typeof ReloadRefusal];

/** One file a `reloadAssets` names: its asset path and the FNV-1a 64 digest of its new bytes. */
export interface NativeReloadFile {
  path: string;
  digest: string;
}

/** What `reloadAssets` answers: the paths swapped, the ones refused and the reloads still in flight. */
export interface NativeReloadAnswer {
  reloaded: string[];
  refused: Array<{ path: string; code: ReloadRefusal }>;
  /** Reloads not finished yet; a settled capture waits for 0. */
  pending: number;
}

/**
 * A `profile` reply as the port checks it: by shape only (a summary `v: 1`, a report `v: 2`, an
 * arm's `{mode}` or a trace's `{bytes, digest}`). The profile leg reads it in full for the action it
 * asked with `parseProfileAnswer` (`shared/frame-profile.ts`) and refuses what is out of shape there.
 */
export type NativeProfileReply = Record<string, unknown>;

/**
 * A `saves` reply as the port checks it: an object (a list, an envelope or its `tooLarge` stand-in,
 * a slot's info, a load's `{tick, checksum, checksumMatch}`). The caller asked with the op and
 * reads the members it named.
 */
export type NativeSavesReply = Record<string, unknown>;

/** A `uiSettings` reply as the port checks it: an object, the settings in force after the call. */
export type NativeUiSettingsReply = Record<string, unknown>;

/** What `bakeAssets` answers: the bake it ran, and the size and digest of the file it wrote. */
export interface NativeBakeReply {
  kind: BakeKind;
  name: string;
  bytes: number;
  /** FNV-1a 64 of the file's bytes, 16 lowercase hex; the host recomputes it before reading further. */
  digest: string;
}

/** The events the game sends on its own (`{event, …}`). Wire values. */
export const NativeEvent = {
  Ready: "ready",
  Fatal: "fatal",
  /** The game's window gained or lost OS focus (untrusted: only ever mutes the game's own audio). */
  Focus: "focus",
  /** Embedded runs: a slot is finished and synchronized. */
  Frame: "frame",
  /**
   * Contract v2: the game re-created its lost GPU device. Live's ring was made on the old one, so
   * the game dropped it and the host announces a new generation (old slots are refused from then).
   */
  DeviceRestored: "device-restored",
  /**
   * Contract v2, before `ready`: a boot step finished and the game is still starting. Each gives
   * the ready deadline again from there, never past `NATIVE_START_MAX_MS`; after `ready` it is a
   * violation.
   */
  Starting: "starting",
  /**
   * The game crashed and sends its `genex-crash/1` record (`shared/crash-record.ts`) before it
   * exits (a fatal panic) or goes on (a caught panic, a lost device). Accepted before `ready` too:
   * a boot panic has a record. A malformed record is a violation.
   */
  Crash: "crash",
} as const;
export type NativeEvent = (typeof NativeEvent)[keyof typeof NativeEvent];

/**
 * Where a game's boot is (owner decision D11: real progress on every destination), in the order a
 * boot passes them. A native game's `starting` event names one with its `done` of `total` (genex
 * `protocol::BootStage`); the web shell's `genex:progress` events and `GenexShell.progress` carry
 * the same words (its own copy, `LoadStage` in `src/game-template-rust/web/shell.html`). Wire
 * values: never rename one.
 */
export const BootStage = {
  /** The browser downloads the game's module: bytes of bytes. */
  Wasm: "wasm",
  /** The game's staged files are fetched (web) or its models and textures uploaded (native): files of files. */
  Assets: "assets",
  /** The GPU device opens. */
  Device: "device",
  /** The renderer's pipelines compile: pipelines of pipelines (total unknown until the boot listed them). */
  Pipelines: "pipelines",
  /** The first frame is drawn. */
  Frame: "frame",
  /** The first lit frame is on screen: the loading state leaves. */
  Ready: "ready",
} as const;
export type BootStage = (typeof BootStage)[keyof typeof BootStage];

/** The largest count a boot's progress names (pipelines, files); a larger one is not a count. */
export const NATIVE_BOOT_COUNT_MAX = 1_000_000;

/** Where a starting game's boot is: its stage and, where counted, `done` of `total` (null when not counted). */
export interface NativeBootProgress {
  stage: BootStage;
  done: number | null;
  total: number | null;
}

const BOOT_STAGES: ReadonlySet<string> = new Set(Object.values(BootStage));
/** Whether `value` names a boot stage. */
export const isBootStage = (value: unknown): value is BootStage => typeof value === "string" && BOOT_STAGES.has(value);

/** How a run is shown. Sent to the renderer: never rename a value. */
export const NativeRunMode = {
  /** The person's Play window. */
  Window: "window",
  /** An agent's run: no window, captures only. */
  Headless: "headless",
  /** Frames drawn inside Live. */
  Embedded: "embedded",
} as const;
export type NativeRunMode = (typeof NativeRunMode)[keyof typeof NativeRunMode];

/** Extra input kinds only native runs take, beside `PreviewInputAction`. Wire values. */
export const NativeInputKind = {
  /** One pad's full state (Gamepad API order), sent on change. */
  Gamepad: "gamepad",
  /** Committed IME or typed text (`compositionend`/`beforeinput`). */
  Text: "text",
  /** Contract v2: one finger's start, move or end in world coordinates (`PreviewTouchAction`). */
  Touch: "touch",
} as const;
export type NativeInputKind = (typeof NativeInputKind)[keyof typeof NativeInputKind];

/**
 * Which kind of pad a `gamepad` action stands for (genex-core `PadFamily`, its wire spellings): the
 * game picks button labels by it (Cross on a PlayStation pad, B for confirm on a Nintendo one).
 * Display only: it never changes what a button does. Wire values: never rename one.
 */
export const NativeGamepadFamily = {
  Generic: "generic",
  Xbox: "xbox",
  PlayStation: "playstation",
  Nintendo: "nintendo",
  Steam: "steam",
} as const;
export type NativeGamepadFamily = (typeof NativeGamepadFamily)[keyof typeof NativeGamepadFamily];

/**
 * The graphics path a game reports in `ready.backend.api`: a diagnostic; the host's bundle gate
 * decides. A raylib game draws through ANGLE (or WebGL2); a Rust · wgpu game names one of the
 * WebGPU-core backends below, and there is deliberately no GL member for it: wgpu's GL backend is
 * never built, and a receipt naming GL is refused.
 */
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
/** {@link NativeWgpuBackend} as a list, in genex-render's order. */
export const NATIVE_WGPU_BACKENDS: readonly NativeWgpuBackend[] = Object.freeze([
  NativeBackend.Metal,
  NativeBackend.Vulkan,
  NativeBackend.D3d12,
  NativeBackend.WebGpu,
]);

/**
 * The capability tier a receipt states. Always `core` (WebGPU core limits and features, guaranteed
 * everywhere): the device is opened with core limits only, and native-enhanced is what the offered
 * features in `nativeEnhanced` add, never a tier of its own. Wire values.
 */
export const NativeGpuTier = {
  Core: "core",
} as const;
export type NativeGpuTier = (typeof NativeGpuTier)[keyof typeof NativeGpuTier];

/**
 * Optional wgpu native features (native-enhanced): offered in the receipt, declared by a game in
 * `genex.toml` (`[gpu] native_features`), never requested unless declared, never on the web.
 * Wire values, the genex.toml spellings (genex's `NativeFeature`): never rename one.
 */
export const NativeEnhancedFeature = {
  /** `SHADER_INT64_ATOMIC_MIN_MAX`. */
  ShaderInt64AtomicMinMax: "shader-int64-atomic-min-max",
  /** `SHADER_INT64_ATOMIC_ALL_OPS`. */
  ShaderInt64AtomicAllOps: "shader-int64-atomic-all-ops",
  /** `SUBGROUP`. */
  Subgroup: "subgroup",
  /** `EXPERIMENTAL_RAY_QUERY`. */
  RayQuery: "ray-query",
  /** `EXPERIMENTAL_MESH_SHADER`. */
  MeshShader: "mesh-shader",
  /** `TEXTURE_BINDING_ARRAY` and its non-uniform indexing companions. */
  TextureBindingArray: "texture-binding-array",
  /** `MULTI_DRAW_INDIRECT_COUNT`. */
  MultiDrawIndirectCount: "multi-draw-indirect-count",
} as const;
export type NativeEnhancedFeature = (typeof NativeEnhancedFeature)[keyof typeof NativeEnhancedFeature];

/** Where a v2 game's app is in its life (`state().lifecycle`): a surface exists only while resumed. Wire values. */
export const NativeLifecycle = {
  /** Launched, never resumed: no surface yet. */
  Launched: "launched",
  /** In the foreground (every desktop and headless run). */
  Resumed: "resumed",
  /** In the background (iOS, Android): no surface. */
  Suspended: "suspended",
} as const;
export type NativeLifecycle = (typeof NativeLifecycle)[keyof typeof NativeLifecycle];

/**
 * Where Live's Native canvas stands: the wire values of its `data-stage-native-canvas` attribute,
 * which the renderer writes and the dev control's live capture reads (a capture is taken only of a
 * canvas that is `playing`).
 */
export const NativeCanvasPhase = {
  /** Building, checking or starting the Mac build, or waiting for the host's answer. */
  Starting: "starting",
  /** The game runs (or waits, paused, while Live is hidden): its frames are drawn. */
  Playing: "playing",
  Refused: "refused",
  Ended: "ended",
  /** The embed call itself failed. */
  Failed: "failed",
  /** No WebGL2 to draw frames with. */
  CantDraw: "cant-draw",
} as const;
export type NativeCanvasPhase = (typeof NativeCanvasPhase)[keyof typeof NativeCanvasPhase];

/** Where a native run stands. Sent to the renderer: never rename a value. */
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

/** Why the host refused a bundle, a run or a reply. Typed; the words live in the renderer. Never rename a value. */
export const NativeRefusal = {
  ExtraMachO: "extra-mach-o",
  Symlink: "symlink",
  HardLink: "hard-link",
  LinksOpenGl: "links-opengl",
  MissingAngleImport: "missing-angle-import",
  ForeignRpath: "foreign-rpath",
  NotAnExecutable: "not-an-executable",
  AngleDigest: "angle-digest",
  ExtraPe: "extra-pe",
  ImportsOpengl32: "imports-opengl32",
  ExtraSharedObject: "extra-shared-object",
  ImportsLibGl: "imports-libgl",
  RunpathNotOrigin: "runpath-not-origin",
  GlibcTooNew: "glibc-too-new",
  BadHandshake: "bad-handshake",
  ReadyTimeout: "ready-timeout",
  ReplyTooLarge: "reply-too-large",
  ReplyInvalid: "reply-invalid",
  CaptureTooLarge: "capture-too-large",
  CaptureDigest: "capture-digest",
  MemoryCap: "memory-cap",
  Unresponsive: "unresponsive",
  Unsupported: "unsupported",
  /** The host's own OS, but this build has no game box for it. */
  NoGameBox: TargetRefusal.NoGameBox,
  /** A run or lease for a destination the game does not name. */
  NotADestination: TargetRefusal.NotADestination,
  /** A destination this host builds but cannot run (`preview.acquire {target: windows}` on a Mac). */
  NotRunnableHere: TargetRefusal.NotRunnableHere,
  /** The game's recorded kind is one this version does not know: it is opened read-only. */
  KindUnsupported: TargetRefusal.KindUnsupported,
  /** The game's stack is behind the development gate in this build. */
  StackGated: TargetRefusal.StackGated,
  /** The stack's toolchain is missing and cannot be fetched offline. */
  ToolchainOffline: TargetRefusal.ToolchainOffline,
  /**
   * No build lane is registered for the game's stack in this build (a Rust game before its lane
   * lands): nothing was built. The gate is open; `stack-gated` is only for a closed gate.
   */
  LaneMissing: "lane-missing",
  /** The lane's build for the run failed; the run's `problem` says why. */
  BuildFailed: "build-failed",
  /** A harness lease for a raylib game named no `target`: the harness predates native support. */
  HarnessPredatesNative: "harness-predates-native",
  EmbedUnsupported: "embed-unsupported",
  SlotUnknown: "slot-unknown",
  SlotMismatch: "slot-mismatch",
  TooManySlots: "too-many-slots",
  FrameRate: "frame-rate",
  ElectronUntested: "electron-untested",
  /** The frames addon refused a frame for a code `nativeRefusalOfFrames` names no closer refusal for. */
  FramesInvalid: "frames-invalid",
  /** A slot stayed unreleased past `NATIVE_FRAME_SLOT_WATCHDOG_MS`: Live stopped taking frames. */
  FramesStalled: "frames-stalled",
  /** The game answered `surface` with `unknown-op`: it was made before Live could show Mac builds. */
  GamePredatesEmbedding: "game-predates-embedding",
  /** A Windows or Linux build for another machine than x86-64 (the PE gate's non-x64 image, the ELF gate's `e_machine`). */
  WrongMachine: "wrong-machine",
  /** A Windows or Linux build that needs a system library outside the gate's allow-list. */
  ForeignImport: "foreign-import",
  /** No adapter on a WebGPU-core backend, or one below core limits: the designed refusal, never a fallback. */
  GpuUnsupported: "gpu-unsupported",
  /** The GPU device was lost; the run re-creates it, and `capture` answers this meanwhile (a web page shows its card with this code). */
  DeviceLost: "device-lost",
  /** A frame or step deadline passed: the supervisor took it for a GPU hang and ended the run. */
  GpuHang: "gpu-hang",
  /** The game declares a native-enhanced feature the device does not offer. */
  NativeFeatureMissing: "native-feature-missing",
  /** A web build of a game that declares native-enhanced features: the web has none. */
  NativeFeaturesWeb: "native-features-web",
  /** A custom GPU pass (extension ladder level 3) failed validation: its WGSL, layout or caps. */
  GpuPassInvalid: "gpu-pass-invalid",
  /**
   * `preview.input` with a touch on a preview that takes none: a page other than a Rust · wgpu web
   * build, or a protocol 1 native game. The host's own answer, never a game's: a script skips it.
   */
  TouchNotTaken: "touch-not-taken",
  /**
   * An ejected game's build (extension ladder level 5) has no green conformance run on its build
   * digest: Live and an agent's run start nothing until `game.conformance` passes on that build.
   */
  ConformanceRequired: "conformance-required",
} as const;
export type NativeRefusal = (typeof NativeRefusal)[keyof typeof NativeRefusal];

/** What a game answers an op it refuses (`{ok: false, error}`), as the template spells it; the host reads only these. Never rename a value. */
export const NativeOpError = {
  /** The game has no such op: it was made before the op existed (`surface` before Live could show Mac builds). */
  UnknownOp: "unknown-op",
  /** A v2 game's `capture` while its device is being re-created (the run's refusal of the same name). */
  DeviceLost: NativeRefusal.DeviceLost,
  /** A v2 game's own watchdog found its GPU work past the deadline (the run's refusal of the same name). */
  GpuHang: NativeRefusal.GpuHang,
  /** The game knows the op but this build cannot serve it (`renderSettings` before the renderer's settings land). */
  Unavailable: RenderSettingsRefusal.Unavailable,
  /** An argument member of the wrong type (genex-studio's `VerbRefusal::BAD_ARGUMENT`). */
  BadArgument: "bad-argument",
  /** The game is still applying an earlier `reloadAssets`: ask again once it settles. */
  Busy: "busy",
} as const;
export type NativeOpError = (typeof NativeOpError)[keyof typeof NativeOpError];

/** Why a `renderSettings` argument is refused: the vocabulary's code, or `bad-argument`. */
export type RenderSettingsArgError = RenderSettingsRefusal | typeof NativeOpError.BadArgument;

/** A `renderSettings` argument as a game reads it, or the code the game refuses it with. */
export type RenderSettingsArgCheck =
  | { ok: true; arg: { set?: RenderSettingsChange } }
  | { ok: false; error: RenderSettingsArgError };

/** A preset or class member: absent or null, a known word, else its code (a string) or `bad-argument`. */
function wordError(value: unknown, isWord: (value: unknown) => boolean, unknown: RenderSettingsRefusal) {
  if (value === undefined || value === null || isWord(value)) return null;
  return typeof value === "string" ? unknown : NativeOpError.BadArgument;
}

/** The feature switches: absent or null, else known features each true or false. */
function featuresError(value: unknown): RenderSettingsArgError | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return NativeOpError.BadArgument;
  for (const [feature, on] of Object.entries(value)) {
    if (!isRenderFeature(feature)) return RenderSettingsRefusal.UnknownFeature;
    if (typeof on !== "boolean") return NativeOpError.BadArgument;
  }
  return null;
}

/** A scale lock or frame budget: absent or null, else a finite number inside its range. */
function rangeError(value: unknown, range: readonly [number, number], outside: RenderSettingsRefusal) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return NativeOpError.BadArgument;
  return value >= range[0] && value <= range[1] ? null : outside;
}

/** The members of a checked `set` a game reads (it ignores any other). */
function settingsChangeOf(set: Record<string, unknown>): RenderSettingsChange {
  const change: RenderSettingsChange = {};
  const { preset, deviceClass, features, renderScaleLock, frameBudgetMs } = set;
  if (preset === null || isQualityPreset(preset)) change.preset = preset;
  if (deviceClass === null || isDeviceClass(deviceClass)) change.deviceClass = deviceClass;
  if (features === null || isFeatureSwitches(features)) change.features = features === null ? null : { ...features };
  if (renderScaleLock === null || typeof renderScaleLock === "number") change.renderScaleLock = renderScaleLock;
  if (frameBudgetMs === null || typeof frameBudgetMs === "number") change.frameBudgetMs = frameBudgetMs;
  return change;
}

/**
 * A `renderSettings` argument checked as genex-studio's `parse_render_settings` checks it, in its
 * order and with its codes: no `set` is a read; a `set` that is no object, or a member of the wrong
 * type, is `bad-argument`; an unknown preset, class or feature and a scale or budget outside its
 * range answer the vocabulary's code. A page verb on a native run answers what its web page does.
 */
export function checkRenderSettingsArg(arg: unknown): RenderSettingsArgCheck {
  if (!isRecord(arg) || !Object.hasOwn(arg, "set")) return { ok: true, arg: {} };
  const set = arg.set;
  if (!isRecord(set)) return { ok: false, error: NativeOpError.BadArgument };
  const error =
    wordError(set.preset, isQualityPreset, RenderSettingsRefusal.UnknownPreset) ??
    wordError(set.deviceClass, isDeviceClass, RenderSettingsRefusal.UnknownDeviceClass) ??
    featuresError(set.features) ??
    rangeError(set.renderScaleLock, [RENDER_SCALE_MIN, RENDER_SCALE_MAX], RenderSettingsRefusal.InvalidScale) ??
    rangeError(set.frameBudgetMs, [FRAME_BUDGET_MS_MIN, FRAME_BUDGET_MS_MAX], RenderSettingsRefusal.InvalidFrameBudget);
  return error ? { ok: false, error } : { ok: true, arg: { set: settingsChangeOf(set) } };
}

/**
 * Why a Windows or Linux host has no game box it can start a game in: the detail under
 * `NativeRefusal.NoGameBox`, which the run card words. Never rename a value.
 */
export const GameBoxProblem = {
  /** Windows: no signed `genex-game-launcher.exe` ships in this build's resources. */
  LauncherMissing: "launcher-missing",
  /** Linux: bubblewrap is not installed, or is older than 0.8. */
  BubblewrapMissing: "bubblewrap-missing",
  /** Linux: unprivileged user namespaces are restricted (Ubuntu 24.04's AppArmor rule), the boot gate's own code. */
  UsernsRestricted: SandboxProblemCode.UsernsRestricted,
  /** Linux: the session is X11 only; a game window opens only on Wayland. */
  X11Only: "x11-only",
  /** Linux: no Wayland compositor answers at `WAYLAND_DISPLAY`. */
  NoWayland: "no-wayland",
  /** Linux: the compositor offers no per-run Wayland security context (`wp_security_context_manager_v1`), and the raw session socket is never handed over. */
  WaylandUnrestricted: "wayland-unrestricted",
  /** No headless build exists for this OS, so an agent's run is judged on the web build instead. */
  NoHeadlessBuild: "no-headless-build",
  /** The box itself refused to start (bubblewrap or the launcher exited before the game ran). */
  BoxRefused: "box-refused",
  /** Linux: this build has no helper that makes a per-run Wayland security context, whatever the compositor offers. */
  WaylandHelperMissing: "wayland-helper-missing",
} as const;
export type GameBoxProblem = (typeof GameBoxProblem)[keyof typeof GameBoxProblem];

/** Pixel layout of a capture file in `state/captures/<seq>.bgra`, rows top-down: what `computePixelStats` reads. */
export const NATIVE_CAPTURE_FORMAT = "bgra8";
/** The longest side a capture may have; a reply declaring more is refused before any read. */
export const NATIVE_CAPTURE_MAX_PX = 4096;
/** The shortest side a capture may be asked to draw at: the world target's smallest (`MIN_WORLD_PX`). */
export const NATIVE_CAPTURE_MIN_PX = 64;
/** The most bytes `readRegularFile` will take for one capture. */
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
/** The whole stop sequence, quit to reap: what a caller that stops every run gives it at most. */
export const NATIVE_STOP_BUDGET_MS = NATIVE_QUIT_GRACE_MS + NATIVE_TERM_GRACE_MS + NATIVE_REAP_MARGIN_MS;
/** A `state` heartbeat that goes unanswered this long marks the run unresponsive. */
export const NATIVE_HEARTBEAT_MS = 5 * SECOND_MS;
/** stderr lines are cut here before they reach `native.log`. */
export const NATIVE_STDERR_LINE_MAX_CHARS = 2048;
/** The most stderr lines one `native.log` event carries. */
export const NATIVE_LOG_BATCH_MAX = 200;
/** A game past this `phys_footprint` is killed (PX8 sets this). */
export const NATIVE_GAME_MEMORY_MAX_BYTES = 4 * 1024 ** 3;
/** Embedded runs: the shared-image ring size. */
export const NATIVE_FRAME_SLOTS = 3;
/** Embedded runs: frames per second past which the frames receiver refuses the game. */
export const NATIVE_FRAME_RATE_MAX_PER_S = 240;
/** Native leases a pool grants at once, apart from `MAX_POOL_MAX` (PX12 sets this). */
export const NATIVE_LEASES_MAX = 4;
/** The most actions one `input` op or `studio:native.input` call carries. */
export const NATIVE_INPUT_ACTIONS_MAX = 5000;
/** Committed text, in UTF-16 units. */
export const NATIVE_TEXT_MAX_UNITS = 256;
/** Pads, buttons per pad and axes per pad, as the standard Gamepad mapping has them. */
export const NATIVE_GAMEPADS_MAX = 4;
export const NATIVE_GAMEPAD_BUTTONS_MAX = 17;
export const NATIVE_GAMEPAD_AXES_MAX = 4;
/** The oldest macOS a Mac game runs on: its `Info.plist` `LSMinimumSystemVersion` and the deployment target. */
export const MAC_MINIMUM_SYSTEM_VERSION = "13.0";
/**
 * The most bytes a `ready`'s capability receipt may take as JSON (UTF-8), checked before any of its
 * fields: a real one is about 170 bytes on Metal, far below the line cap (M0a.15).
 */
export const NATIVE_RECEIPT_MAX_BYTES = 4 * 1024;
/**
 * The highest bind layout of the WGSL extension points (`gfx.material`, `gfx.post_pass`) this host
 * knows. v2 (the renderer follow-up's RQ1) adds the HDR scene, depth, normals, motion, the
 * environment and the game's own textures; v1 sources keep loading.
 */
export const NATIVE_EXTENSION_API_VERSION = 2;
/** The highest custom GPU pass API (extension ladder level 3, `genex::gpu`) this host knows; v2 adds stage `post-hdr`. */
export const NATIVE_CUSTOM_PASS_API_VERSION = 2;

/**
 * Where in the frame a custom GPU pass runs (`state().volatile.customPasses[].stage`). Stages are
 * appended, never renamed: `post-hdr` (custom-pass API v2) runs on the linear HDR scene after
 * TAA's place and before bloom and the tonemap; `after-prepass` (custom-pass API v2) runs after the
 * depth/normal prepass, before ambient occlusion and the world pass, with the prepass's depth and
 * normals as declared inputs. Wire values.
 */
export const CustomPassStage = {
  BeforeCull: "before-cull",
  AfterOpaque: "after-opaque",
  AfterTransparent: "after-transparent",
  Post: "post",
  PostHdr: "post-hdr",
  AfterPrepass: "after-prepass",
} as const;
export type CustomPassStage = (typeof CustomPassStage)[keyof typeof CustomPassStage];
/** The longest WGSL source a game's renderer or the lane's naga step takes (genex-render's `WGSL_MAX_BYTES`). */
export const NATIVE_WGSL_MAX_BYTES = 256 * 1024;
/**
 * The key under a v2 game's `state().volatile` listing its custom GPU passes
 * ({@link NativeCustomPassStatus}): a pass refused at install or stopped in a frame carries its
 * typed code there (`gpu-pass-invalid`), never only on stderr. Outside the checksum.
 */
export const NATIVE_CUSTOM_PASSES_KEY = "customPasses";
/**
 * The key under a v2 game's `state().volatile` holding what its renderer runs with (`RenderStatus`:
 * class, preset, scale, features, degraded reasons, GPU and CPU ms), and under a capture reply its
 * `render` provenance. Outside the checksum; never compared.
 */
export const NATIVE_RENDER_KEY = "render";
/** The `renderSettings` verb's version a receipt advertises as `renderSettingsApi`. */
export const NATIVE_RENDER_SETTINGS_API_VERSION = 1;
/** The `reloadAssets` verb's version a receipt advertises as `reloadAssetsApi`. */
export const NATIVE_RELOAD_ASSETS_API_VERSION = 1;
/** The `saves` verb's version a receipt advertises as `savesApi` (G6 UIS-16). */
export const NATIVE_SAVES_API_VERSION = 1;
/** The `uiSettings` verb's version a receipt advertises as `uiSettingsApi` (G6 UIS-16). */
export const NATIVE_UI_SETTINGS_API_VERSION = 1;

// ── Live's embedded frames (genex-frames, M5a) ─────────────────────────────────────────────

/** The `abiVersion` the frames addon must report; any other build of it is not loaded. */
export const NATIVE_FRAMES_ABI_VERSION = 1;
/** The `wireVersion` (`GXF_WIRE_VERSION`) the addon and the game's sender must both speak. */
export const NATIVE_FRAMES_WIRE_VERSION = 1;
/** Frames the addon's rate cap lets through at once above `NATIVE_FRAME_RATE_MAX_PER_S` (PX4 sets this). */
export const NATIVE_FRAME_BURST = 16;
/** A slot still unreleased this long after its send resolved means no receiver drew it (PX13 sets this). */
export const NATIVE_FRAME_SLOT_WATCHDOG_MS = 2 * SECOND_MS;
/** Live's canvas resizes are coalesced this long before a new ring generation is asked for. */
export const NATIVE_RESIZE_DEBOUNCE_MS = 80;
/** The longest side of a ring slot, in device pixels (the addon allows 8192; Live asks for at most this). */
export const NATIVE_FRAME_SIDE_MAX = 4096;
/** The most pixels one ring slot may hold (`GXF_MAX_PIXELS`, 128 MiB of BGRA). */
export const NATIVE_FRAME_PIXELS_MAX = 32 * 1024 * 1024;
/** Old-generation slots the addon keeps retained across resizes before `expectRing` refuses (`too-many-held`). */
export const NATIVE_FRAMES_RETIRED_MAX = 12;
/** The Mach service a run's frames arrive on is this prefix and the run's frames id (`GXF_SERVICE_PREFIX`). */
export const NATIVE_FRAMES_SERVICE_PREFIX = "games.genex.frames.";
/** The run id of a status made before the registry registered any run: main's refusals and the renderer read it so. */
export const NATIVE_NO_RUN_ID = "";

/**
 * Why the frames addon refused a message or a frame (`CODE_NAMES` in
 * `native/genex-frames/src/gxf_validate.c`). Wire values: never rename one.
 */
export const NativeFramesCode = {
  Oversize: "oversize",
  Truncated: "truncated",
  WrongSize: "wrong-size",
  WrongMsgId: "wrong-msg-id",
  BadHeader: "bad-header",
  MissingPort: "missing-port",
  BadDescriptor: "bad-descriptor",
  BadDisposition: "bad-disposition",
  BadTrailer: "bad-trailer",
  BadMagic: "bad-magic",
  ForeignSender: "foreign-sender",
  NoRing: "no-ring",
  StaleGeneration: "stale-generation",
  BadGeneration: "bad-generation",
  UnknownSlot: "unknown-slot",
  BadSeq: "bad-seq",
  Rate: "rate",
  SizeMismatch: "size-mismatch",
  FormatMismatch: "format-mismatch",
  AllocMismatch: "alloc-mismatch",
  NotIosurface: "not-iosurface",
  SlotBusy: "slot-busy",
  RingOverflow: "ring-overflow",
  DuplicateSurface: "duplicate-surface",
  QueueOverflow: "queue-overflow",
  ReceiveFailed: "receive-failed",
} as const;
export type NativeFramesCode = (typeof NativeFramesCode)[keyof typeof NativeFramesCode];

/**
 * GPU bounds (ProcessSandbox does not bound GPU work): the codes a Rust · wgpu game's renderer
 * refuses with when a shader, buffer, texture, frame upload or capture exceeds its cap, as
 * genex-render's `RenderCode` spells them. They reach the host in a `fatal` reason or an op's
 * `error`. Wire values: never rename one.
 */
export const NativeGpuBound = {
  /** The device request failed after the adapter passed the floor check. */
  DeviceFailed: "device-failed",
  /** A WGSL source above `NATIVE_WGSL_MAX_BYTES`, or one naga refused. */
  WgslTooLarge: "wgsl-too-large",
  /** An empty buffer, or one above the WebGPU-core storage binding size. */
  BufferTooLarge: "buffer-too-large",
  /** A texture above 4096 × 4096 × 4 bytes. */
  TextureTooLarge: "texture-too-large",
  /** One frame's uploads above the per-frame budget. */
  UploadBudget: "upload-budget",
  /** A capture above `NATIVE_CAPTURE_MAX_BYTES` (the run's refusal of the same name). */
  CaptureTooLarge: NativeRefusal.CaptureTooLarge,
  /** A malformed mesh, one naming an external buffer, or an unknown one. */
  MeshInvalid: "mesh-invalid",
} as const;
export type NativeGpuBound = (typeof NativeGpuBound)[keyof typeof NativeGpuBound];

/** The codes the addon drops without faulting the run (`gxf_code_is_fatal`): every other code ends it. */
export const NATIVE_FRAMES_DROPPED: readonly NativeFramesCode[] = [
  NativeFramesCode.ForeignSender,
  NativeFramesCode.StaleGeneration,
];

const FRAMES_CODES: ReadonlySet<string> = new Set<NativeFramesCode>(Object.values(NativeFramesCode));

/** Whether `value` is one of the addon's refusal codes. */
export function isNativeFramesCode(value: unknown): value is NativeFramesCode {
  return typeof value === "string" && FRAMES_CODES.has(value);
}

/** The run refusal a fatal frames code ends the run with: the slot, size and rate ones by name, the rest invalid. */
export function nativeRefusalOfFrames(code: NativeFramesCode): NativeRefusal {
  switch (code) {
    case NativeFramesCode.UnknownSlot:
      return NativeRefusal.SlotUnknown;
    case NativeFramesCode.SizeMismatch:
    case NativeFramesCode.FormatMismatch:
    case NativeFramesCode.AllocMismatch:
      return NativeRefusal.SlotMismatch;
    case NativeFramesCode.RingOverflow:
    case NativeFramesCode.DuplicateSurface:
      return NativeRefusal.TooManySlots;
    case NativeFramesCode.Rate:
      return NativeRefusal.FrameRate;
    default:
      return NativeRefusal.FramesInvalid;
  }
}

/** Live's canvas for an embedded run, in CSS pixels, and the screen's device-pixel ratio. */
export interface NativeEmbedSize {
  width: number;
  height: number;
  dpr: number;
  /**
   * The canvas's exact device pixels, when the browser reports them (`devicePixelContentBoxSize`):
   * a slot's CSS side is often fractional, and its rounded CSS side times the ratio can be a
   * device pixel off, which the compositor would then resample every frame.
   */
  device?: { width: number; height: number };
}

/** The highest device-pixel ratio Live sends. */
const EMBED_DPR_MAX = 4;

const isEmbedSide = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 1 && Number(value) <= NATIVE_FRAME_SIDE_MAX;
const isEmbedDpr = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= EMBED_DPR_MAX;
const isDeviceSide = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 1 && Number(value) <= NATIVE_FRAME_SIDE_MAX * EMBED_DPR_MAX;

/**
 * Whether `device` pixels cover a `css`-pixel side at `dpr`: within one CSS pixel (the CSS side is
 * the rounded one, the device side the snapped box).
 */
export const deviceSideFits = (device: number, css: number, dpr: number): boolean =>
  Math.abs(device - css * dpr) <= dpr;

/** Checks an embed size's device pixels against its CSS sides: a copy, or null. */
function parseEmbedDevice(
  value: unknown,
  width: number,
  height: number,
  dpr: number,
): { width: number; height: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const device = value as Record<string, unknown>;
  if (!isDeviceSide(device.width) || !isDeviceSide(device.height)) return null;
  const fits = deviceSideFits(device.width, width, dpr) && deviceSideFits(device.height, height, dpr);
  return fits ? { width: device.width, height: device.height } : null;
}

/**
 * Checks a renderer-sent embed size: integer CSS sides 1..`NATIVE_FRAME_SIDE_MAX`, a dpr in [1, 4]
 * and, when sent, integer device sides within one CSS pixel of the CSS sides; a copy, or null.
 */
export function parseNativeEmbedSize(value: unknown): NativeEmbedSize | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { width, height, dpr, device } = value as Record<string, unknown>;
  if (!isEmbedSide(width) || !isEmbedSide(height) || !isEmbedDpr(dpr)) return null;
  if (device === undefined) return { width, height, dpr };
  const pixels = parseEmbedDevice(device, width, height, dpr);
  return pixels ? { width, height, dpr, device: pixels } : null;
}

/**
 * The ring a canvas of `size` asks the game for, in device pixels: the canvas's own device pixels
 * when it reported them, else the CSS sides times the dpr, scaled down with the aspect kept until
 * each side is at most `NATIVE_FRAME_SIDE_MAX` and the slot at most `NATIVE_FRAME_PIXELS_MAX`
 * pixels; never below one pixel a side.
 */
export function ringSizeFor(size: NativeEmbedSize): { width: number; height: number } {
  const width = Math.max(1, size.device?.width ?? Math.round(size.width * size.dpr));
  const height = Math.max(1, size.device?.height ?? Math.round(size.height * size.dpr));
  const longest = Math.max(width, height);
  const sided =
    longest <= NATIVE_FRAME_SIDE_MAX
      ? { width, height }
      : {
          width: Math.max(1, Math.round((width * NATIVE_FRAME_SIDE_MAX) / longest)),
          height: Math.max(1, Math.round((height * NATIVE_FRAME_SIDE_MAX) / longest)),
        };
  if (sided.width * sided.height <= NATIVE_FRAME_PIXELS_MAX) return sided;
  const scale = Math.sqrt(NATIVE_FRAME_PIXELS_MAX / (sided.width * sided.height));
  return { width: Math.max(1, Math.floor(sided.width * scale)), height: Math.max(1, Math.floor(sided.height * scale)) };
}

/** What main sends with each frame to the renderer's `nativeFrames` subscriber (`sendSharedTexture`'s extra argument). */
export interface NativeFrameMeta {
  project: string;
  runId: string;
  generation: number;
  seq: number;
  slot: number;
  width: number;
  height: number;
}

/** Whether `value` has a frame meta's shape (main's own argument, checked before the renderer reads it). */
export function isNativeFrameMeta(value: unknown): value is NativeFrameMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta: Record<string, unknown> = { ...value };
  const counts = [meta.generation, meta.seq, meta.slot, meta.width, meta.height];
  return typeof meta.project === "string" && typeof meta.runId === "string" && counts.every(Number.isSafeInteger);
}

/**
 * The host's own facts about a desktop build it admitted or refused, as `native.build` hands them to
 * the harness: a Mac bundle (`admitMacBundle`), or a Windows or Linux `out/` (`admitCrossOutput`,
 * read even when refused). What the game reports about its backend is a claim; these are facts.
 */
export interface NativeAdmissionFacts {
  /** `macos`, `windows` or `linux`. */
  target: BuildTarget;
  /** Why the build was refused; null when it was admitted. */
  refusal: NativeRefusal | null;
  /** The refusal's detail (the import, rpath or file that failed it); null when admitted. */
  detail: string | null;
  /** The libraries the executable names, as written: each `LC_LOAD_DYLIB`, PE import DLL name, or ELF `DT_NEEDED`. */
  imports: string[];
  /** Where it looks for them, as written: each `LC_RPATH` or ELF `DT_RUNPATH`; always empty on Windows. */
  rpaths: string[];
  /** The SHA-256 of the store ANGLE's `manifest.json` the build was checked against; null when none was. */
  angleManifestSha256: string | null;
}

/** The executable a Windows or Linux build of a raylib game leaves at the top of the lane's `out/`. File names. */
export const NATIVE_CROSS_EXECUTABLES = {
  [BuildTarget.Windows]: "game.exe",
  [BuildTarget.Linux]: "game",
} as const satisfies Partial<Record<BuildTarget, string>>;

/** A destination a compiled game is cross-built for. */
export type CrossBuildTarget = typeof BuildTarget.Windows | typeof BuildTarget.Linux;

/**
 * The executable a Windows or Linux build leaves at the top of its lane's `out/`, per compiled
 * stack: raylib's is {@link NATIVE_CROSS_EXECUTABLES}; a Rust game's one binary (windowed or
 * headless by how the host starts it) keeps the same names, so the PE and ELF gates, the run
 * folders and the archives read one name per destination. File names.
 */
export const STACK_CROSS_EXECUTABLES = {
  [GameStack.RaylibCpp]: NATIVE_CROSS_EXECUTABLES,
  [GameStack.RustWgpu]: {
    [BuildTarget.Windows]: "game.exe",
    [BuildTarget.Linux]: "game",
  },
} as const satisfies Record<CompiledStack, Record<CrossBuildTarget, string>>;

/**
 * The executables a Mac build of a raylib game leaves in the lane's `out/`: plain thin-arm64 Mach-O
 * files, never a CMake `MACOSX_BUNDLE` (the host assembles every `.app`). File names.
 */
export const NATIVE_MAC_EXECUTABLES = {
  [NativeRunMode.Window]: "game",
  [NativeRunMode.Headless]: "game-headless",
} as const satisfies Partial<Record<NativeRunMode, string>>;
/** The binary format an admission gate reads. Wire values (admission facts and refusals): never rename one. */
export const ExecutableFormat = {
  MachO: "mach-o",
  Pe: "pe",
  Elf: "elf",
  Wasm: "wasm",
} as const;
export type ExecutableFormat = (typeof ExecutableFormat)[keyof typeof ExecutableFormat];

/** The one architecture each admitted executable is built for. Wire values: never rename one. */
export const ExecutableArch = {
  Arm64: "arm64",
  X8664: "x86-64",
  Wasm32: "wasm32",
} as const;
export type ExecutableArch = (typeof ExecutableArch)[keyof typeof ExecutableArch];

/** What one destination's admission gate reads in a Rust · wgpu build's `out/`. */
export interface RustAdmittedExecutable {
  format: ExecutableFormat;
  arch: ExecutableArch;
  /** The executables by file name, at the top of `out/`; anything else of the format there is refused. */
  files: readonly string[];
}

/**
 * The six binaries a Rust · wgpu game's destinations are admitted as: a thin arm64 Mach-O for the
 * Mac (one executable under both names a Mac run admits) and for iOS (device and Simulator, told
 * apart by `LC_BUILD_VERSION`), an x86-64 PE for Windows, an x86-64 glibc ELF for Linux, an arm64
 * bionic ELF for Android (packaged as `libmain.so` by the export, not the lane), and the web
 * build's wasm module. The gates themselves are substrate's (M3.5).
 */
export const RUST_ADMITTED_EXECUTABLES = {
  [BuildTarget.Mac]: { format: ExecutableFormat.MachO, arch: ExecutableArch.Arm64, files: ["game", "game-headless"] },
  [BuildTarget.Ios]: { format: ExecutableFormat.MachO, arch: ExecutableArch.Arm64, files: ["game"] },
  [BuildTarget.Windows]: { format: ExecutableFormat.Pe, arch: ExecutableArch.X8664, files: ["game.exe"] },
  [BuildTarget.Linux]: { format: ExecutableFormat.Elf, arch: ExecutableArch.X8664, files: ["game"] },
  [BuildTarget.Android]: { format: ExecutableFormat.Elf, arch: ExecutableArch.Arm64, files: ["game"] },
  [BuildTarget.Web]: { format: ExecutableFormat.Wasm, arch: ExecutableArch.Wasm32, files: ["game_bg.wasm"] },
} as const satisfies Record<BuildTarget, RustAdmittedExecutable>;

/** The iOS release every Rust iOS build's `LC_BUILD_VERSION` names as its minimum (rustc's own default is 10.0). */
export const IOS_MINIMUM_OS_VERSION = "16.0";
/** Every `PT_LOAD` of an Android build is aligned to a multiple of this (Google Play's 16 KB pages). */
export const ANDROID_LOAD_ALIGN_BYTES = 16 * 1024;

/**
 * Why a Rust · wgpu destination's binary was refused (M3.5), finer than the `NativeRefusal` it is
 * reported under. Wire values (build problems and admission facts): never rename one.
 */
export const RustAdmissionProblem = {
  /** Not the destination's format, or malformed, truncated or past the gate's caps. */
  Unreadable: "unreadable",
  /** A library, object or unfinished image where an executable belongs. */
  NotAnExecutable: "not-an-executable",
  /** Built for another CPU. */
  WrongMachine: "wrong-machine",
  /** A Mach-O whose `LC_BUILD_VERSION` names another platform (a Mac build for iOS), or none. */
  WrongPlatform: "wrong-platform",
  /** An iOS Mach-O whose minimum OS is not {@link IOS_MINIMUM_OS_VERSION}. */
  MinosMismatch: "minos-mismatch",
  /** Starts through another dynamic loader than the destination's. */
  WrongInterpreter: "wrong-interpreter",
  /** Imports desktop OpenGL or OpenGL ES (any spelling): Rust games draw through wgpu alone. */
  OpenGl: "opengl",
  /** Imports a DirectX shader compiler other than `d3dcompiler_47.dll` (`dxcompiler.dll`, `dxil.dll`). */
  DxCompiler: "dx-compiler",
  /** Imports a library outside the destination's allow-list (a bundled dylib, a network library, a path). */
  ForeignImport: "foreign-import",
  /** Carries a library search path the destination does not allow (`LC_RPATH`, `DT_RPATH`, a `DT_RUNPATH` but `$ORIGIN`). */
  SearchPath: "search-path",
  /** Sets the loader's environment for itself (`LC_DYLD_ENVIRONMENT`). */
  DyldEnvironment: "dyld-environment",
  /** Needs a newer glibc symbol version than the floor, or one no numbered release guarantees. */
  GlibcTooNew: "glibc-too-new",
  /** Loads a library through a filter or auditor tag. */
  LoadsByTag: "loads-by-tag",
  /** An Android `PT_LOAD` not aligned to {@link ANDROID_LOAD_ALIGN_BYTES}. */
  LoadAlignment: "load-alignment",
  /** A wasm import from a module other than the build's own wasm-bindgen glue. */
  WasmImport: "wasm-import",
  /** An export build that links the host transport (`genex-studio`): the dev flavour, never shipped. */
  TransportLinked: "transport-linked",
  /** A web build's folder holds a file the shell does not name, or lacks one it does. */
  ShellFiles: "shell-files",
  /** A file in the build's output is a link, or has a second hard link. */
  Link: "link",
} as const;
export type RustAdmissionProblem = (typeof RustAdmissionProblem)[keyof typeof RustAdmissionProblem];

/** A Rust binary a gate refused: the refusal it is reported under, the finer problem and what it was about. */
export interface RustBinaryRefusal {
  ok: false;
  refusal: NativeRefusal;
  problem: RustAdmissionProblem;
  detail: string;
}

/** The ANGLE libraries every Mac game imports at link time, exactly as `LC_LOAD_DYLIB` names them. */
export const MAC_ANGLE_IMPORTS = ["@rpath/libEGL.dylib", "@rpath/libGLESv2.dylib"] as const;
/** The only `LC_RPATH` a Mac game may carry. */
export const MAC_GAME_RPATH = "@executable_path/../Frameworks";
/** The bundle a run dir holds: `<runDir>/bundle/Game.app/Contents/{MacOS/game, Frameworks/, Resources/assets/, Info.plist}`. */
export const NATIVE_BUNDLE_APP = "Game.app";

/** The environment a game starts with: `spawnGame` passes exactly these and nothing of its own env. Wire names. */
export const NativeEnv = {
  /** Always "3": the protocol pipe. */
  StudioFd: "GENEX_STUDIO_FD",
  /** Echoed in `ready`. */
  Nonce: "GENEX_STUDIO_NONCE",
  /** The run's `state/`: the template's save root for a Genex run. */
  StateDir: "GENEX_STATE_DIR",
  /** The store ANGLE's one back end, as redundancy beside it: "metal" on a Mac, "d3d11" on Windows, "vulkan" on Linux. */
  AnglePlatform: "ANGLE_DEFAULT_PLATFORM",
  /** `<state>/home`. */
  Home: "HOME",
  /** Embedded runs only: the Mach service the game sends frames to (the profile's `FRAMES` parameter). */
  FramesService: "GENEX_FRAMES_SERVICE",
  /** Windows: the protocol pipe's name, which the launcher passes instead of fd 3. */
  StudioPipe: "GENEX_STUDIO_PIPE",
} as const;
export type NativeEnv = (typeof NativeEnv)[keyof typeof NativeEnv];
/** What a game that speaks on fd 3 (a Mac or Linux game) starts with: every variable but the Windows pipe's. */
export type FdGameEnv = Exclude<NativeEnv, typeof NativeEnv.StudioPipe>;

/** A typed native failure with its sentence, as `ToolchainError` does: no reader matches English. */
export class NativeError extends Error {
  readonly refusal: NativeRefusal;
  /** The build's problem, when `refusal` is `build-failed`. */
  readonly problem: BuildProblem | null;
  /** Why the host has no usable game box, when `refusal` is `no-game-box` on Windows or Linux. */
  readonly box: GameBoxProblem | null;

  constructor(
    refusal: NativeRefusal,
    message: string,
    problem: BuildProblem | null = null,
    box: GameBoxProblem | null = null,
  ) {
    super(message);
    this.name = "NativeError";
    this.refusal = refusal;
    this.problem = problem;
    this.box = box;
  }
}

/** What the host sends: one line, `{id, op, arg?}`. */
export interface NativeRequest {
  id: number;
  op: NativeOp;
  arg?: unknown;
}

/** What the game answers, as untrusted JSON the host checks. */
export type NativeReply =
  | { id: number; ok: true; op: NativeOp; result: unknown }
  | { id: number; ok: false; op: NativeOp; error: string; available?: NativeOp[] };

/**
 * What a Rust · wgpu game's `ready` reports about its GPU (contract v2, inline in `ready`): tier
 * core, the backend, the adapter, the native-enhanced features the adapter offers (offered, not
 * requested) and the extension API versions the runtime serves. A claim the host records; the
 * lane and the admission decide. A receipt from before the renderer follow-up has the singular
 * API fields only: read the versions it serves through {@link receiptExtensionApis} and
 * {@link receiptCustomPassApis}, which answer `[extensionApi]` and `[customPassApi]` for it.
 */
export interface NativeCapabilityReceipt {
  tier: NativeGpuTier;
  backend: NativeWgpuBackend;
  /** The adapter's name, at most 256 characters. */
  adapter: string;
  /** Each offered feature once, in the order the game lists them. */
  nativeEnhanced: NativeEnhancedFeature[];
  /** The highest WGSL extension points' bind layout version served (`NATIVE_EXTENSION_API_VERSION` today). */
  extensionApi: number;
  /** The highest custom GPU pass API version served (`NATIVE_CUSTOM_PASS_API_VERSION` today). */
  customPassApi: number;
  /** Every extension API version served, ascending, ending in `extensionApi`. */
  extensionApis?: number[];
  /** Every custom pass API version served, ascending, ending in `customPassApi`. */
  customPassApis?: number[];
  /** Optional adapter features the renderer opened the device with for itself (never a game's). */
  rendererFeatures?: RendererFeature[];
  /** The v2 extension inputs a producer really fills (the rest are neutral 1x1 resources). */
  renderInputs?: RenderInput[];
  /** The `renderSettings` verb's version this game serves; absent: the game has no such verb. */
  renderSettingsApi?: number;
  /** The `reloadAssets` verb's version this game serves; absent: a build that does not swap assets in place. */
  reloadAssetsApi?: number;
  /** The `saves` verb's version this game serves; absent: a build without the verb. */
  savesApi?: number;
  /** The `uiSettings` verb's version this game serves; absent: a build without the verb. */
  uiSettingsApi?: number;
}

/** The extension API versions a receipt serves: its list, or `[extensionApi]` for a receipt without one. */
export function receiptExtensionApis(receipt: NativeCapabilityReceipt): number[] {
  return receipt.extensionApis ? [...receipt.extensionApis] : [receipt.extensionApi];
}

/** The custom pass API versions a receipt serves: its list, or `[customPassApi]` for a receipt without one. */
export function receiptCustomPassApis(receipt: NativeCapabilityReceipt): number[] {
  return receipt.customPassApis ? [...receipt.customPassApis] : [receipt.customPassApi];
}

/** Whether a receipt advertises the `renderSettings` verb (a C++ game and a pre-RQ0 Rust game do not). */
export function receiptServesRenderSettings(receipt: NativeCapabilityReceipt | null | undefined): boolean {
  return (receipt?.renderSettingsApi ?? 0) >= NATIVE_RENDER_SETTINGS_API_VERSION;
}

/** Whether a receipt advertises the `reloadAssets` verb (a dev build that swaps changed assets in place). */
export function receiptServesReloadAssets(receipt: NativeCapabilityReceipt | null | undefined): boolean {
  return (receipt?.reloadAssetsApi ?? 0) >= NATIVE_RELOAD_ASSETS_API_VERSION;
}

/** Whether a receipt advertises the `saves` verb (a dev build of a Rust game, UIS-16). */
export function receiptServesSaves(receipt: NativeCapabilityReceipt | null | undefined): boolean {
  return (receipt?.savesApi ?? 0) >= NATIVE_SAVES_API_VERSION;
}

/** Whether a receipt advertises the `uiSettings` verb (a dev build of a Rust game, UIS-16). */
export function receiptServesUiSettings(receipt: NativeCapabilityReceipt | null | undefined): boolean {
  return (receipt?.uiSettingsApi ?? 0) >= NATIVE_UI_SETTINGS_API_VERSION;
}

/** One custom GPU pass in a v2 game's `state().volatile.customPasses`. */
export interface NativeCustomPassStatus {
  name: string;
  /** The frame stage it runs at (a {@link CustomPassStage}; a newer game may name a stage this host does not know yet). */
  stage: string;
  /** False once refused: it is left out of every frame. */
  running: boolean;
  /** What refused it (`gpu-pass-invalid`, or a cap's or naga's code); null while it runs. */
  code: string | null;
}

/** The game's `ready` event; the nonce must echo `GENEX_STUDIO_NONCE`. */
export interface NativeReadyEvent {
  event: typeof NativeEvent.Ready;
  nonce: string;
  protocol: number;
  contractVersion: number;
  build: string;
  backend: { api: NativeBackend; device: string | null };
  size: { width: number; height: number };
  seed: number;
  /** Protocol 2 only (always present there, naming `backend.api`'s backend); a v1 ready has none. */
  receipt?: NativeCapabilityReceipt;
}

/** The game's `fatal` event: it is about to exit. */
export interface NativeFatalEvent {
  event: typeof NativeEvent.Fatal;
  reason: string;
}

/** The game's window gained or lost focus. */
export interface NativeFocusEvent {
  event: typeof NativeEvent.Focus;
  focused: boolean;
}

/** Embedded runs: a finished slot. */
export interface NativeFrameEvent {
  event: typeof NativeEvent.Frame;
  seq: number;
  slot: number;
  ts: number;
}

/** A v2 game re-created its lost GPU device: its Live ring is gone with the old one. */
export interface NativeDeviceRestoredEvent {
  event: typeof NativeEvent.DeviceRestored;
}

/** A v2 game is still starting: a boot step finished before its `ready`, and where its boot is when it says. */
export interface NativeStartingEvent {
  event: typeof NativeEvent.Starting;
  progress?: NativeBootProgress;
}

/** The game's crash record, copied through `parseCrashRecord`. */
export interface NativeCrashEvent {
  event: typeof NativeEvent.Crash;
  record: CrashRecordV1;
}

/** Every event a game may send. */
export type NativeEventMessage =
  | NativeReadyEvent
  | NativeFatalEvent
  | NativeFocusEvent
  | NativeFrameEvent
  | NativeDeviceRestoredEvent
  | NativeStartingEvent
  | NativeCrashEvent;

/** A pad's state as the Gamepad API reports it (standard mapping); at most 4 pads, 17 buttons, 4 axes. */
export interface NativeGamepadAction {
  type: typeof NativeInputKind.Gamepad;
  index: number;
  buttons: readonly number[];
  axes: readonly number[];
  /** The kind of pad, so a run without real pads can show a family's labels; absent reads as generic. */
  family?: NativeGamepadFamily;
}

/** Committed text, at most 256 UTF-16 units. */
export interface NativeTextAction {
  type: typeof NativeInputKind.Text;
  text: string;
}

/** One finger's start, move or end in world coordinates (contract v2): `PreviewTouchAction`. */
export type NativeTouchAction = PreviewTouchAction;

/** Everything `studio:native.input` and the `input` op accept. */
export type NativeInputAction = PreviewInputAction | NativeGamepadAction | NativeTextAction | NativeTouchAction;

/** The part of the screen no notch, island or home indicator covers: insets in physical pixels. */
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
  /** FNV-1a 64 of the BGRA bytes, 16 lowercase hex; the host recomputes it before JPEG encoding. */
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

/** A size a capture is asked to draw at, in whole pixels. */
export interface NativeCaptureSize {
  width: number;
  height: number;
}

/** Whether `value` is a size a capture may be asked to draw at: whole pixels, each side 64..4096. */
export function isNativeCaptureSize(value: unknown): value is NativeCaptureSize {
  const side = (n: unknown) =>
    Number.isSafeInteger(n) && Number(n) >= NATIVE_CAPTURE_MIN_PX && Number(n) <= NATIVE_CAPTURE_MAX_PX;
  return isRecord(value) && side(value.width) && side(value.height);
}

/**
 * Per-op arguments: the host builds these, and the seed copy holds the same shapes. Ops absent
 * from the map take no argument.
 */
export interface NativeOpArgs {
  [NativeOp.Seed]: { seed: number };
  [NativeOp.Step]: { ms: number };
  [NativeOp.Input]: { actions: NativeInputAction[] };
  /** `size`: draw the pinned capture at that size (a Rust · wgpu game; the 4K/1440p plan). */
  [NativeOp.Capture]: { camera?: string; size?: NativeCaptureSize; lens?: NativeCaptureLens };
  [NativeOp.DebugCamera]: { camera: string | null };
  [NativeOp.Demo]: { name: string };
  [NativeOp.Audio]: { muted: boolean };
  [NativeOp.Visible]: { visible: boolean };
  /** The ring Live asks for, in device pixels, and the host-chosen, increasing generation it carries. */
  [NativeOp.Surface]: { w: number; h: number; dpr: number; slots: number; generation: number };
  [NativeOp.Release]: { slot: number; generation: number };
  /** No `set`: read the settings; with one, change what it names first. */
  [NativeOp.RenderSettings]: { set?: RenderSettingsChange };
  [NativeOp.BakeAssets]: { kind: BakeKind; name: string };
  /** At most `NATIVE_RELOAD_FILES_MAX` files. */
  [NativeOp.ReloadAssets]: { files: NativeReloadFile[] };
  /** `frames` 1..=240 for a report; `mode` for an arm. */
  [NativeOp.Profile]: { action: FrameProfileAction; frames?: number; mode?: GpuTimingMode };
  /** Checked by `checkSavesArg`: a slot name of a safe shape, an envelope a line can carry. */
  [NativeOp.Saves]: SavesArg;
  /** Checked by `checkUiSettingsArg`: no member reads, null gives the game's own back. */
  [NativeOp.UiSettings]: UiSettingsArg;
}

/**
 * Per-op results, as the host checks every reply against them (`ReplyInvalid` kills the game).
 * Fields a game adds beyond these are ignored, never read. `debugCamera` and `demo` answer the
 * template's own `{ok, …, available?}`: `ok: false` names what exists instead.
 */
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
  /** The ring the game made: the generation it was asked for, its size and slot count. */
  [NativeOp.Surface]: { generation: number; width: number; height: number; slots: number };
  [NativeOp.Release]: Record<string, never>;
  [NativeOp.RenderSettings]: RenderSettingsAnswer;
  [NativeOp.BakeAssets]: NativeBakeReply;
  [NativeOp.ReloadAssets]: NativeReloadAnswer;
  [NativeOp.Profile]: NativeProfileReply;
  [NativeOp.Saves]: NativeSavesReply;
  [NativeOp.UiSettings]: NativeUiSettingsReply;
}

// Every op has a result shape: an op added without one fails here.
type UncheckedOp = Exclude<NativeOp, keyof NativeOpResults>;
const everyOpHasAResult: [UncheckedOp] extends [never] ? true : { unchecked: UncheckedOp } = true;
void everyOpHasAResult;

/**
 * What a compiled game's web page answers to `audio()` with no argument (the page verb; a native
 * run answers `audioLevel` instead): the game's own mix before the mute, as `rms` and spectral
 * `centroid`. `available` is false when the build exports no level or the level could not be read;
 * its numbers then read 0 and are never judged.
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

/**
 * A `starting` event, with the boot's progress when it names a known stage (counts out of shape,
 * negative, fractional, past {@link NATIVE_BOOT_COUNT_MAX} or done past total read as uncounted). A
 * progress it cannot read is dropped, never the event: its deadline still counts.
 */
function startingEvent(value: Record<string, unknown>): NativeStartingEvent {
  if (!isBootStage(value.stage)) return { event: NativeEvent.Starting };
  const count = (raw: unknown) =>
    Number.isSafeInteger(raw) && Number(raw) >= 0 && Number(raw) <= NATIVE_BOOT_COUNT_MAX ? Number(raw) : null;
  const done = count(value.done);
  const total = count(value.total);
  const counted = done !== null && total !== null && done <= total;
  return {
    event: NativeEvent.Starting,
    progress: { stage: value.stage, done: counted ? done : null, total: counted ? total : null },
  };
}

/** What a run looks like to the renderer, the harness and `studio:native.state`. */
export interface NativeRunStatus {
  project: string;
  runId: string;
  target: BuildTarget;
  state: NativeRunState;
  /** The run is a person's window (Play), an agent's headless run, or embedded in Live. */
  mode: NativeRunMode;
  pid: number | null;
  backend: NativeBackend | null;
  /** A protocol 2 game's capability receipt from its `ready`; absent or null for a v1 game. */
  receipt?: NativeCapabilityReceipt | null;
  refusal: NativeRefusal | null;
  /** Why the build failed, when `refusal` is `build-failed`. */
  problem: BuildProblem | null;
  /** Why the host has no usable game box, when `refusal` is `no-game-box` on Windows or Linux. */
  box?: GameBoxProblem | null;
  exit: { code: number | null; signal: string | null } | null;
  /** The harness lease that started it; null for the person's window. */
  owner: string | null;
  /** Where a starting game's boot is (its last `starting` that named a stage); absent or null otherwise. */
  progress?: NativeBootProgress | null;
  /** The crash record the host kept for this run (`game.crashes` names it); absent or null when none. */
  crash?: { crashId: string; kind: CrashKind } | null;
  startedAt: string;
  endedAt: string | null;
}

/** One `native.log` batch: stderr lines, each cut at `NATIVE_STDERR_LINE_MAX_CHARS`, at most `NATIVE_LOG_BATCH_MAX`. */
export interface NativeLogBatch {
  project: string;
  runId: string;
  lines: string[];
  /** Lines were dropped or cut. */
  truncated: boolean;
}

/** `studio:native.input` forwards the preview actions plus the native-only kinds. */
export type NativeInputActions = NativeInputAction[];

/** Injected clock for every timed native module (port, registry, supervisor, frames), as `ShutdownTimers` does for quitting. */
export interface NativeTimers {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * What the build lane last learned of a desktop (Windows, Linux or Mac) build of a game's own
 * folder: the badge its stage shows, the lock it was built with (first 12 hex of the digest), when,
 * and the gate's refusal when it refused the build. A host fact kept in the library
 * (`GameLibraryEntry.native.checks`), never in the game.
 */
export interface DestinationCheck {
  badge: DestinationBadge;
  /** The toolchain lock's digest, first 12 lowercase hex. */
  lock: string;
  /** ISO 8601, as `Date.toISOString` writes it. */
  at: string;
  refusal?: NativeRefusal;
}

/** The longest `at` a check may carry. */
const CHECK_AT_MAX_CHARS = 40;
const CHECK_LOCK = /^[0-9a-f]{12}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const BADGES: ReadonlySet<string> = new Set<DestinationBadge>(Object.values(DestinationBadge));
const REFUSALS: ReadonlySet<string> = new Set<NativeRefusal>(Object.values(NativeRefusal));

const isCheckTime = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= CHECK_AT_MAX_CHARS &&
  ISO_DATE.test(value) &&
  !Number.isNaN(Date.parse(value));
const isCheckBadge = (value: unknown): value is DestinationBadge => typeof value === "string" && BADGES.has(value);
const isCheckLock = (value: unknown): value is string => typeof value === "string" && CHECK_LOCK.test(value);
const isCheckRefusal = (value: unknown): value is NativeRefusal => typeof value === "string" && REFUSALS.has(value);

/**
 * A destination check read back from the library (a file the host writes, but reads as untrusted):
 * a copy with only the fields a check has, or null for an unknown badge or refusal, a lock that is
 * not 12 lowercase hex, or an `at` that is not an ISO date of at most 40 characters.
 */
export function parseDestinationCheck(value: unknown): DestinationCheck | null {
  if (!isRecord(value)) return null;
  const { badge, lock, at, refusal } = value;
  if (!isCheckBadge(badge) || !isCheckLock(lock) || !isCheckTime(at)) return null;
  if (refusal !== undefined && !isCheckRefusal(refusal)) return null;
  const check: DestinationCheck = { badge, lock, at };
  return refusal === undefined ? check : { ...check, refusal };
}

// ── checks over untrusted lines ───────────────────────────────────────────────────────────

/** Names a list answer (`cameras`, `eyes`, `demos`, `held`) may carry, and how long each may be. */
const NAMES_MAX = 512;
const NAME_MAX_CHARS = 256;
/** A digest is FNV-1a 64 as 16 lowercase hex. */
const DIGEST = /^[0-9a-f]{16}$/;
/** The longest nonce, build id and device name a `ready` may carry. */
const READY_TEXT_MAX_CHARS = 256;
/** Keys one key action names, and how long each name may be. */
const KEYS_MAX = 16;
const KEY_MAX_CHARS = 64;
/** The longest `type` text, `press` combo and click modifier list. */
const TYPE_MAX_CHARS = 4096;
const MODIFIERS_MAX = 4;

const OPS: ReadonlySet<string> = new Set<NativeOp>(Object.values(NativeOp));
const BACKENDS: ReadonlySet<string> = new Set<NativeBackend>(Object.values(NativeBackend));
const WGPU_BACKENDS: ReadonlySet<string> = new Set<NativeWgpuBackend>(NATIVE_WGPU_BACKENDS);
const ENHANCED_FEATURES: ReadonlySet<string> = new Set<NativeEnhancedFeature>(Object.values(NativeEnhancedFeature));
const LIFECYCLES: ReadonlySet<string> = new Set<NativeLifecycle>(Object.values(NativeLifecycle));
/** An extension API version is a small positive integer. */
const API_VERSION_MAX = 0xffff;
/** The most API versions one receipt list names. */
const API_VERSIONS_MAX = 16;
/** A safe-area inset is at most this many physical pixels (an 8K screen's side, twice over). */
const SAFE_AREA_INSET_MAX_PX = 16_384;
/** A touch id is a uint32 the sender chose. */
const TOUCH_ID_MAX = 0xffff_ffff;

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
/** A ring generation is a uint32 the host chose, from 1. */
const GENERATION_MAX = 0xffff_ffff;
const isGeneration = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= GENERATION_MAX;
const isRingSide = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= NATIVE_FRAME_SIDE_MAX;

/** Whether `value` is an op this host knows. */
export function isNativeOp(value: unknown): value is NativeOp {
  return typeof value === "string" && OPS.has(value);
}

/** Whether `value` is a backend name a `ready` may report. */
export function isNativeBackend(value: unknown): value is NativeBackend {
  return typeof value === "string" && BACKENDS.has(value);
}

const isWgpuBackend = (value: unknown): value is NativeWgpuBackend =>
  typeof value === "string" && WGPU_BACKENDS.has(value);
const isEnhancedFeature = (value: unknown): value is NativeEnhancedFeature =>
  typeof value === "string" && ENHANCED_FEATURES.has(value);
const isApiVersion = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= API_VERSION_MAX;
const isInset = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= SAFE_AREA_INSET_MAX_PX;
const isFeatureList = (value: unknown): value is NativeEnhancedFeature[] =>
  Array.isArray(value) && value.every(isEnhancedFeature) && new Set(value).size === value.length;

/** UTF-8 bytes of `value` as JSON; past the cap for anything JSON cannot write. */
function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Checks an untrusted capability receipt: refused (null) past `NATIVE_RECEIPT_MAX_BYTES` before any
 * field is read, for a tier other than core, a backend that is not WebGPU core (GL, ANGLE), an
 * unknown or repeated native-enhanced feature, an adapter name past 256 characters, or an extension
 * API version that is not a positive integer. The answer is a copy with only the receipt's fields.
 */
export function parseNativeCapabilityReceipt(value: unknown): NativeCapabilityReceipt | null {
  if (!isRecord(value) || jsonBytes(value) > NATIVE_RECEIPT_MAX_BYTES) return null;
  const { tier, backend, adapter, nativeEnhanced, extensionApi, customPassApi } = value;
  if (tier !== NativeGpuTier.Core || !isWgpuBackend(backend) || !isText(adapter)) return null;
  if (!isFeatureList(nativeEnhanced) || !isApiVersion(extensionApi) || !isApiVersion(customPassApi)) return null;
  const singular = { tier, backend, adapter, nativeEnhanced: [...nativeEnhanced], extensionApi, customPassApi };
  const renderer = receiptRendererFields(value, extensionApi, customPassApi);
  return renderer === null ? null : { ...singular, ...renderer };
}

/** The fields a receipt from the renderer follow-up adds, each only when present; null when one is outside its shape. */
function receiptRendererFields(
  value: Record<string, unknown>,
  extensionApi: number,
  customPassApi: number,
): Partial<NativeCapabilityReceipt> | null {
  const { extensionApis, customPassApis, rendererFeatures, renderInputs } = value;
  const lists =
    isOptional(extensionApis, (list) => isApiList(list, extensionApi)) &&
    isOptional(customPassApis, (list) => isApiList(list, customPassApi));
  const named =
    isOptional(rendererFeatures, (list) => isDistinctList(list, isRendererFeature)) &&
    isOptional(renderInputs, (list) => isDistinctList(list, isRenderInput));
  const versions = RECEIPT_VERB_VERSIONS.every((key) => isOptional(value[key], isApiVersion));
  if (!lists || !named || !versions) return null;
  const fields: Partial<NativeCapabilityReceipt> = {};
  if (Array.isArray(extensionApis)) fields.extensionApis = extensionApis.filter(isApiVersion);
  if (Array.isArray(customPassApis)) fields.customPassApis = customPassApis.filter(isApiVersion);
  if (Array.isArray(rendererFeatures)) fields.rendererFeatures = rendererFeatures.filter(isRendererFeature);
  if (Array.isArray(renderInputs)) fields.renderInputs = renderInputs.filter(isRenderInput);
  for (const key of RECEIPT_VERB_VERSIONS) {
    const version = value[key];
    if (isApiVersion(version)) fields[key] = version;
  }
  return fields;
}

/** The receipt's optional verb versions, each copied only when it is a version. */
const RECEIPT_VERB_VERSIONS = ["renderSettingsApi", "reloadAssetsApi", "savesApi", "uiSettingsApi"] as const;

/** Versions served, ascending and distinct, the highest being the receipt's singular field. */
function isApiList(value: unknown, highest: number): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > API_VERSIONS_MAX) return false;
  const ascending = value.every(
    (version, index) => isApiVersion(version) && (index === 0 || version > value[index - 1]),
  );
  return ascending && value.at(-1) === highest;
}

/** A list of distinct names, each one `known` accepts. */
function isDistinctList(value: unknown, known: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(known) && new Set(value).size === value.length;
}

function isSafeArea(value: unknown): value is NativeSafeArea {
  return isRecord(value) && [value.top, value.left, value.bottom, value.right].every(isInset);
}

/** A protocol 2 `state()`: any object that also carries a known `lifecycle` and a whole `safeArea`. */
function isStateV2Result(value: unknown): value is NativeStateV2 {
  return (
    isRecord(value) &&
    typeof value.lifecycle === "string" &&
    LIFECYCLES.has(value.lifecycle) &&
    isSafeArea(value.safeArea)
  );
}

function isSeedResult(value: unknown): value is NativeOpResults[typeof NativeOp.Seed] {
  return isRecord(value) && isFiniteNumber(value.seed) && value.paused === true;
}
function isRunningResult(value: unknown): value is NativeOpResults[typeof NativeOp.Start] {
  return isRecord(value) && typeof value.running === "boolean";
}
function isStepResult(value: unknown): value is NativeOpResults[typeof NativeOp.Step] {
  return (
    isRecord(value) &&
    isCount(value.frame) &&
    isFiniteNumber(value.simulatedMs) &&
    isCount(value.steppedFrames) &&
    isCount(value.drawCalls)
  );
}
function isStateResult(value: unknown): value is NativeOpResults[typeof NativeOp.State] {
  return isRecord(value);
}
function isInputResult(value: unknown): value is NativeOpResults[typeof NativeOp.Input] {
  return isRecord(value) && isNames(value.held);
}
function isCaptureResult(value: unknown): value is NativeOpResults[typeof NativeOp.Capture] {
  return (
    isRecord(value) &&
    isCount(value.seq) &&
    isSide(value.width) &&
    isSide(value.height) &&
    value.format === NATIVE_CAPTURE_FORMAT &&
    typeof value.digest === "string" &&
    DIGEST.test(value.digest) &&
    isOptional(value.camera, isCameraName) &&
    isOptional(value[NATIVE_RENDER_KEY], isCaptureProvenance)
  );
}

/** A camera a capture names: a non-empty name no longer than any other the contract takes. */
const isCameraName = (value: unknown): value is string => isText(value) && value.length > 0;
function isDebugCameraResult(value: unknown): value is NativeOpResults[typeof NativeOp.DebugCamera] {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    isOptional(value.camera, isText) &&
    isOptional(value.available, isNames)
  );
}
function isCamerasResult(value: unknown): value is NativeOpResults[typeof NativeOp.Cameras] {
  return isRecord(value) && isNames(value.cameras);
}
function isEyesResult(value: unknown): value is NativeOpResults[typeof NativeOp.Eyes] {
  return isRecord(value) && isNames(value.eyes);
}
function isDemosResult(value: unknown): value is NativeOpResults[typeof NativeOp.Demos] {
  return isRecord(value) && isNames(value.demos);
}
function isDemoResult(value: unknown): value is NativeOpResults[typeof NativeOp.Demo] {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    isOptional(value.demo, isText) &&
    isOptional(value.available, isNames)
  );
}
function isAudioResult(value: unknown): value is NativeOpResults[typeof NativeOp.Audio] {
  return isRecord(value) && typeof value.muted === "boolean";
}
function isAudioLevelResult(value: unknown): value is NativeOpResults[typeof NativeOp.AudioLevel] {
  return isRecord(value) && isFiniteNumber(value.rms) && isFiniteNumber(value.centroid);
}
function isTimingResult(value: unknown): value is NativeOpResults[typeof NativeOp.Timing] {
  return (
    isRecord(value) &&
    isFiniteNumber(value.frameMs) &&
    isFiniteNumber(value.updateMs) &&
    isFiniteNumber(value.drawMs) &&
    isCount(value.frames)
  );
}
function isQuitResult(value: unknown): value is NativeOpResults[typeof NativeOp.Quit] {
  return isRecord(value) && value.quitting === true;
}
function isFrontResult(value: unknown): value is NativeOpResults[typeof NativeOp.Front] {
  return isRecord(value) && typeof value.fronted === "boolean";
}
function isVisibleResult(value: unknown): value is NativeOpResults[typeof NativeOp.Visible] {
  return isRecord(value) && typeof value.visible === "boolean";
}
function isSurfaceResult(value: unknown): value is NativeOpResults[typeof NativeOp.Surface] {
  return (
    isRecord(value) &&
    isGeneration(value.generation) &&
    isRingSide(value.width) &&
    isRingSide(value.height) &&
    Number.isSafeInteger(value.slots) &&
    Number(value.slots) >= 1 &&
    Number(value.slots) <= NATIVE_FRAME_SLOTS
  );
}
function isReleaseResult(value: unknown): value is NativeOpResults[typeof NativeOp.Release] {
  return isRecord(value);
}
function isRenderSettingsResult(value: unknown): value is NativeOpResults[typeof NativeOp.RenderSettings] {
  return isRenderSettingsAnswer(value);
}

const BAKE_KINDS: ReadonlySet<string> = new Set<BakeKind>(Object.values(BakeKind));
const RELOAD_REFUSALS: ReadonlySet<string> = new Set<ReloadRefusal>(Object.values(ReloadRefusal));
function isBakeAssetsResult(value: unknown): value is NativeOpResults[typeof NativeOp.BakeAssets] {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    BAKE_KINDS.has(value.kind) &&
    isBakeName(value.name) &&
    isCount(value.bytes) &&
    value.bytes <= NATIVE_BAKE_MAX_BYTES &&
    typeof value.digest === "string" &&
    DIGEST.test(value.digest)
  );
}
const isReloadRefused = (value: unknown): boolean =>
  isRecord(value) && isText(value.path) && typeof value.code === "string" && RELOAD_REFUSALS.has(value.code);
function isReloadAssetsResult(value: unknown): value is NativeOpResults[typeof NativeOp.ReloadAssets] {
  return (
    isRecord(value) &&
    isNames(value.reloaded) &&
    value.reloaded.length <= NATIVE_RELOAD_FILES_MAX &&
    Array.isArray(value.refused) &&
    value.refused.length <= NATIVE_RELOAD_FILES_MAX &&
    value.refused.every(isReloadRefused) &&
    isCount(value.pending)
  );
}
const GPU_TIMING_MODES: ReadonlySet<string> = new Set<GpuTimingMode>(Object.values(GpuTimingMode));
/** A summary, a report, an arm's mode or a trace's size and digest, by shape. */
function isProfileResult(value: unknown): value is NativeOpResults[typeof NativeOp.Profile] {
  if (!isRecord(value)) return false;
  if (value.v === PROFILE_SUMMARY_VERSION) return typeof value.on === "boolean" && isCount(value.frames);
  if (value.v === PROFILE_REPORT_VERSION) return Array.isArray(value.frames) && typeof value.truncated === "boolean";
  if (Object.hasOwn(value, "mode")) return typeof value.mode === "string" && GPU_TIMING_MODES.has(value.mode);
  return isCount(value.bytes) && typeof value.digest === "string" && DIGEST.test(value.digest);
}

/** One validator per op. */
const RESULT_CHECKS: { readonly [K in keyof NativeOpResults]: (value: unknown) => value is NativeOpResults[K] } = {
  [NativeOp.Seed]: isSeedResult,
  [NativeOp.Start]: isRunningResult,
  [NativeOp.Pause]: isRunningResult,
  [NativeOp.Step]: isStepResult,
  [NativeOp.State]: isStateResult,
  [NativeOp.Input]: isInputResult,
  [NativeOp.Capture]: isCaptureResult,
  [NativeOp.DebugCamera]: isDebugCameraResult,
  [NativeOp.Cameras]: isCamerasResult,
  [NativeOp.Eyes]: isEyesResult,
  [NativeOp.Demos]: isDemosResult,
  [NativeOp.Demo]: isDemoResult,
  [NativeOp.Audio]: isAudioResult,
  [NativeOp.AudioLevel]: isAudioLevelResult,
  [NativeOp.Timing]: isTimingResult,
  [NativeOp.Quit]: isQuitResult,
  [NativeOp.Front]: isFrontResult,
  [NativeOp.Visible]: isVisibleResult,
  [NativeOp.Surface]: isSurfaceResult,
  [NativeOp.Release]: isReleaseResult,
  [NativeOp.RenderSettings]: isRenderSettingsResult,
  [NativeOp.BakeAssets]: isBakeAssetsResult,
  [NativeOp.ReloadAssets]: isReloadAssetsResult,
  [NativeOp.Profile]: isProfileResult,
  [NativeOp.Saves]: isRecord,
  [NativeOp.UiSettings]: isRecord,
};

/** What protocol 2 adds to an op's check; ops absent here are checked as in protocol 1. */
const V2_RESULT_CHECKS: Partial<Readonly<Record<NativeOp, (value: unknown) => boolean>>> = {
  [NativeOp.State]: isStateV2Result,
};

/**
 * Checks an untrusted reply's `result` for `op`, as the game's negotiated `protocol` (from its
 * `ready`; protocol 1 when absent) shapes it; false means `ReplyInvalid`. One validator per op.
 */
export function isNativeResult<K extends keyof NativeOpResults>(
  op: K,
  value: unknown,
  protocol: NativeProtocolVersion = NATIVE_PROTOCOL_V1,
): value is NativeOpResults[K] {
  if (!Object.hasOwn(RESULT_CHECKS, op)) return false;
  const check: (value: unknown) => value is NativeOpResults[K] = RESULT_CHECKS[op];
  if (!check(value)) return false;
  const v2 = protocol === NATIVE_PROTOCOL_VERSION ? V2_RESULT_CHECKS[op] : undefined;
  return v2 === undefined || v2(value);
}

/** Whether `value` is one custom pass's status as a v2 game reports it. */
function isCustomPassStatus(value: unknown): value is NativeCustomPassStatus {
  if (!isRecord(value) || !isText(value.name) || !isText(value.stage) || typeof value.running !== "boolean")
    return false;
  return value.code === null || isText(value.code);
}

/**
 * The custom passes a v2 game's untrusted `state()` lists under `volatile.customPasses`, copied
 * with only their fields; an empty list when it lists none, null when the list is outside its shape.
 */
export function nativeCustomPasses(state: unknown): NativeCustomPassStatus[] | null {
  const volatile = isRecord(state) ? state.volatile : undefined;
  const listed = isRecord(volatile) ? volatile[NATIVE_CUSTOM_PASSES_KEY] : undefined;
  if (listed === undefined) return [];
  if (!Array.isArray(listed) || listed.length > NAMES_MAX || !listed.every(isCustomPassStatus)) return null;
  return listed.map(({ name, stage, running, code }) => ({ name, stage, running, code }));
}

/**
 * What a v2 game's untrusted `state()` says its renderer runs with (`volatile.render`), copied with
 * only its fields; null when it says nothing or something outside the shape. Never compared.
 */
export function nativeRenderStatus(state: unknown): RenderStatus | null {
  const volatile = isRecord(state) ? state.volatile : undefined;
  return isRecord(volatile) ? parseRenderStatus(volatile[NATIVE_RENDER_KEY]) : null;
}

/** A `ready` line, copied field by field; null when any field is outside its shape. */
function readyEvent(value: Record<string, unknown>): NativeReadyEvent | null {
  const { nonce, protocol, contractVersion, build, backend, size, seed } = value;
  const textOk = [nonce, build].every((text) => typeof text === "string" && text.length <= READY_TEXT_MAX_CHARS);
  if (!textOk || typeof nonce !== "string" || typeof build !== "string") return null;
  if (!isCount(protocol) || !isCount(contractVersion) || !isFiniteNumber(seed)) return null;
  if (!isRecord(backend) || !isNativeBackend(backend.api)) return null;
  const device = backend.device;
  const deviceOk = device === null || (typeof device === "string" && device.length <= READY_TEXT_MAX_CHARS);
  if (!deviceOk || !isRecord(size) || !isSide(size.width) || !isSide(size.height)) return null;
  const ready: NativeReadyEvent = {
    event: NativeEvent.Ready,
    nonce,
    protocol,
    contractVersion,
    build,
    backend: { api: backend.api, device: typeof device === "string" ? device : null },
    size: { width: size.width, height: size.height },
    seed,
  };
  // Protocol 1 (and any protocol the port will refuse by version) is read as it always was.
  if (protocol !== NATIVE_PROTOCOL_VERSION) return ready;
  const receipt = parseNativeCapabilityReceipt(value.receipt);
  if (!receipt || receipt.backend !== ready.backend.api) return null;
  return { ...ready, receipt };
}

/** A `frame` line, copied; null when a field is not a count. */
function frameEvent(value: Record<string, unknown>): NativeFrameEvent | null {
  const { seq, slot, ts } = value;
  if (!isCount(seq) || !isCount(slot) || !isFiniteNumber(ts)) return null;
  return { event: NativeEvent.Frame, seq, slot, ts };
}

/** Checks an untrusted event line; null means `ReplyInvalid`. The answer is a copy: no unchecked field survives. */
export function parseNativeEvent(value: unknown): NativeEventMessage | null {
  if (!isRecord(value)) return null;
  switch (value.event) {
    case NativeEvent.Ready:
      return readyEvent(value);
    case NativeEvent.Fatal:
      return typeof value.reason === "string"
        ? { event: NativeEvent.Fatal, reason: value.reason.slice(0, NATIVE_STDERR_LINE_MAX_CHARS) }
        : null;
    case NativeEvent.Focus:
      return typeof value.focused === "boolean" ? { event: NativeEvent.Focus, focused: value.focused } : null;
    case NativeEvent.Frame:
      return frameEvent(value);
    case NativeEvent.DeviceRestored:
      return { event: NativeEvent.DeviceRestored };
    case NativeEvent.Starting:
      return startingEvent(value);
    case NativeEvent.Crash: {
      const record = parseCrashRecord(value.record);
      return record ? { event: NativeEvent.Crash, record } : null;
    }
    default:
      return null;
  }
}

// ── input from the renderer or the harness ─────────────────────────────────────────────────

/** Thrown inside the input check for a value outside its shape; caught once, by `parseNativeInput`. */
class InputRefused extends Error {}
const refuse = (): never => {
  throw new InputRefused();
};
const finite = (value: unknown): number => (isFiniteNumber(value) ? value : refuse());
const optionalFinite = (value: unknown): number | undefined => (value === undefined ? undefined : finite(value));
const optionalFlag = (value: unknown): boolean | undefined =>
  value === undefined || typeof value === "boolean" ? value : refuse();
const text = (value: unknown, max: number): string =>
  typeof value === "string" && value.length <= max ? value : refuse();
const keyList = (value: unknown): string[] =>
  Array.isArray(value) && value.length >= 1 && value.length <= KEYS_MAX
    ? value.map((key) => text(key, KEY_MAX_CHARS))
    : refuse();
const modifierList = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MODIFIERS_MAX) return refuse();
  return value.map((key) => text(key, KEY_MAX_CHARS));
};
const MOUSE_BUTTONS = ["left", "right", "middle"] as const;
type MouseButton = (typeof MOUSE_BUTTONS)[number];
const button = (value: unknown): MouseButton | undefined => {
  if (value === undefined) return undefined;
  return MOUSE_BUTTONS.find((name) => name === value) ?? refuse();
};
const touchPhase = (value: unknown): TouchPhase =>
  Object.values(TouchPhase).find((phase) => phase === value) ?? refuse();
const padFamily = (value: unknown): NativeGamepadFamily | undefined => {
  if (value === undefined) return undefined;
  return Object.values(NativeGamepadFamily).find((family) => family === value) ?? refuse();
};
const touchId = (value: unknown): number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= TOUCH_ID_MAX ? Number(value) : refuse();
const unitList = (value: unknown, max: number, low: number): number[] =>
  Array.isArray(value) && value.length <= max
    ? value.map((item) => {
        const n = finite(item);
        return n >= low && n <= 1 ? n : refuse();
      })
    : refuse();

/** One parser per action kind; each builds a fresh action from the fields it knows. */
const INPUT_PARSERS: Readonly<Record<string, (raw: Record<string, unknown>) => NativeInputAction>> = {
  tap: (raw) => ({ type: "tap", keys: keyList(raw.keys), stepMs: optionalFinite(raw.stepMs) }),
  down: (raw) => ({ type: "down", keys: keyList(raw.keys) }),
  up: (raw) => ({ type: "up", keys: keyList(raw.keys) }),
  hold: (raw) => ({ type: "hold", keys: keyList(raw.keys), ms: optionalFinite(raw.ms) }),
  click: (raw) => ({
    type: "click",
    x: optionalFinite(raw.x),
    y: optionalFinite(raw.y),
    button: button(raw.button),
    clicks: optionalFinite(raw.clicks),
    modifiers: modifierList(raw.modifiers),
    px: optionalFlag(raw.px),
    stepMs: optionalFinite(raw.stepMs),
  }),
  move: (raw) => ({ type: "move", x: finite(raw.x), y: finite(raw.y), px: optionalFlag(raw.px) }),
  drag: (raw) => ({
    type: "drag",
    fromX: finite(raw.fromX),
    fromY: finite(raw.fromY),
    x: finite(raw.x),
    y: finite(raw.y),
    button: button(raw.button),
    px: optionalFlag(raw.px),
  }),
  mousedown: (raw) => ({ type: "mousedown", button: button(raw.button) }),
  mouseup: (raw) => ({ type: "mouseup", button: button(raw.button) }),
  look: (raw) => ({ type: "look", dx: finite(raw.dx), dy: finite(raw.dy) }),
  scroll: (raw) => ({
    type: "scroll",
    dx: optionalFinite(raw.dx),
    dy: optionalFinite(raw.dy),
    x: optionalFinite(raw.x),
    y: optionalFinite(raw.y),
  }),
  type: (raw) => ({ type: "type", text: text(raw.text, TYPE_MAX_CHARS) }),
  press: (raw) => ({ type: "press", combo: text(raw.combo, KEY_MAX_CHARS), repeat: optionalFinite(raw.repeat) }),
  wait: (raw) => ({ type: "wait", ms: finite(raw.ms) }),
  [NativeInputKind.Gamepad]: (raw) => {
    const index = finite(raw.index);
    if (!Number.isInteger(index) || index < 0 || index >= NATIVE_GAMEPADS_MAX) refuse();
    const family = padFamily(raw.family);
    return {
      type: NativeInputKind.Gamepad,
      index,
      buttons: unitList(raw.buttons, NATIVE_GAMEPAD_BUTTONS_MAX, 0),
      axes: unitList(raw.axes, NATIVE_GAMEPAD_AXES_MAX, -1),
      ...(family === undefined ? {} : { family }),
    };
  },
  [NativeInputKind.Text]: (raw) => ({ type: NativeInputKind.Text, text: text(raw.text, NATIVE_TEXT_MAX_UNITS) }),
  [NativeInputKind.Touch]: (raw) => ({
    type: NativeInputKind.Touch,
    phase: touchPhase(raw.phase),
    id: touchId(raw.id),
    x: finite(raw.x),
    y: finite(raw.y),
    ...(raw.px === true ? { px: true as const } : {}),
  }),
};

/**
 * Checks renderer- or harness-supplied input. The whole list is refused (null) for a NaN or an
 * infinite number anywhere, more than `NATIVE_INPUT_ACTIONS_MAX` actions, an unknown kind, or a
 * field outside its shape; the answer is a copy with only the fields each kind knows.
 */
export function parseNativeInput(value: unknown): NativeInputAction[] | null {
  if (!Array.isArray(value) || value.length > NATIVE_INPUT_ACTIONS_MAX) return null;
  try {
    return value.map((raw) => {
      if (!isRecord(raw) || typeof raw.type !== "string" || !Object.hasOwn(INPUT_PARSERS, raw.type)) return refuse();
      const parse = INPUT_PARSERS[raw.type] ?? refuse;
      return parse(raw);
    });
  } catch (error) {
    if (error instanceof InputRefused) return null;
    throw error;
  }
}

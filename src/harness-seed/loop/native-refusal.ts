/**
 * The host's typed refusals (a destination's and a run's), in a module that imports nothing: play-script.ts reads them at load,
 * and native-contract.ts (which re-exports them) reaches play-script.ts back through spec.ts and
 * kinds.ts, so the vocabulary lives where no cycle reaches it.
 */
/** Why a destination is refused, or only labelled, on this host. Never rename a value. */
export const TargetRefusal = {
  /** Apple's SDK licence: Mac games are built on a Mac. */
  MacBuildsNeedAMac: "mac-builds-need-a-mac",
  /** Built here, not run here: the honest label for a cross-build. */
  NotRunnableHere: "not-runnable-here",
  /** The host's own OS, but this build has no game box for it yet. */
  NoGameBox: "no-game-box",
  /** The game's studio.json does not name this destination. */
  NotADestination: "not-a-destination",
  /** Destinations may be added later; a change that would change the stack is refused. */
  StackIsFixed: "stack-is-fixed",
  /** The game has no destination this host can judge on real frames, and its judging-only web build failed. */
  NoJudgingTarget: "no-judging-target",
  /** The folder records a kind this version does not know: it opens read-only. */
  KindUnsupported: "kind-unsupported",
  /** The stack is behind the development gate in this build. */
  StackGated: "stack-gated",
  /** The stack's toolchain is not installed and cannot be fetched offline. */
  ToolchainOffline: "toolchain-offline",
} as const;
export type TargetRefusal = (typeof TargetRefusal)[keyof typeof TargetRefusal];

/** Why the host refused a bundle, a run or a reply. Never rename a value. */
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
  NoGameBox: TargetRefusal.NoGameBox,
  NotADestination: TargetRefusal.NotADestination,
  NotRunnableHere: TargetRefusal.NotRunnableHere,
  /** The game's recorded kind is one this version does not know: it is opened read-only. */
  KindUnsupported: TargetRefusal.KindUnsupported,
  /** The game's stack is behind the development gate in this build. */
  StackGated: TargetRefusal.StackGated,
  /** The stack's toolchain is missing and cannot be fetched offline. */
  ToolchainOffline: TargetRefusal.ToolchainOffline,
  /** No build lane for the game's stack in this build: nothing was built (not the development gate). */
  LaneMissing: "lane-missing",
  BuildFailed: "build-failed",
  /** A lease for a raylib game named no `target`: this harness predates native support. */
  HarnessPredatesNative: "harness-predates-native",
  EmbedUnsupported: "embed-unsupported",
  SlotUnknown: "slot-unknown",
  SlotMismatch: "slot-mismatch",
  TooManySlots: "too-many-slots",
  FrameRate: "frame-rate",
  ElectronUntested: "electron-untested",
  FramesInvalid: "frames-invalid",
  FramesStalled: "frames-stalled",
  /** The game answered `surface` with `unsupported`: made before Live could show Mac builds. */
  GamePredatesEmbedding: "game-predates-embedding",
  /** A Windows or Linux build for another machine than x86-64. */
  WrongMachine: "wrong-machine",
  /** A Windows or Linux build that needs a system library outside the gate's allow-list. */
  ForeignImport: "foreign-import",
  /** No adapter on a WebGPU-core backend, or one below core limits. */
  GpuUnsupported: "gpu-unsupported",
  /** The GPU device was lost; the run re-creates it. */
  DeviceLost: "device-lost",
  /** A frame or step deadline passed: taken for a GPU hang, the run ended. */
  GpuHang: "gpu-hang",
  /** The game declares a native-enhanced feature the device does not offer. */
  NativeFeatureMissing: "native-feature-missing",
  /** A web build of a game that declares native-enhanced features. */
  NativeFeaturesWeb: "native-features-web",
  /** A custom GPU pass (extension ladder level 3) failed validation. */
  GpuPassInvalid: "gpu-pass-invalid",
  /**
   * `preview.input` with a touch on a preview that takes none: a page other than a Rust · wgpu web
   * build, or a protocol 1 native game. The host's own answer, never a game's: a script skips it.
   */
  TouchNotTaken: "touch-not-taken",
  /** An ejected game's build has no green conformance run on its build digest: run `game.conformance` on it. */
  ConformanceRequired: "conformance-required",
} as const;
export type NativeRefusal = (typeof NativeRefusal)[keyof typeof NativeRefusal];

/**
 * What a look says when its play script's touches were refused `touch-not-taken` and skipped: those
 * controls went untested, never passed. Here, not in play-script.ts, so a kept copy of that module
 * from before touches never leaves the evidence passes without it.
 */
export const touchesSkipped = (count: number): string =>
  `${count} touch${count === 1 ? "" : "es"} of the play script went untested: this preview takes no touch (touch-not-taken), so the game's touch controls were never played`;

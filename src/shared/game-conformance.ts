/**
 * The game conformance suite's contract (extension ladder, M7): the behaviour checks every built
 * Rust · wgpu game must pass whatever it extends — every contract verb answers per the contract,
 * two seeded runs agree, a capture's file is the one its digest names, Live's ring delivers frames
 * on the Mac, Stop ends the game and everything it started, and a game that advertises
 * `renderSettings` serves its presets with one look and keeps its custom passes and typed degrades
 * under each. The suite runs in the host
 * (`main/core/game-conformance.ts`), from `npm run conformance:game` and from the harness through
 * `HostMethod.GameConformance` (read-only: it runs the suite on the current build); each harness run
 * is recorded as a `conformance_run` event keyed by its build digest.
 *
 * Level 5 of the ladder lives here too: the person-only engine actions (`studio:engine.eject`,
 * `studio:engine.uneject`, `studio:engine.setTrust`) and the refusals eject, trust and the
 * conformance gate answer with. The harness seed keeps a copy of `ConformanceCheck`
 * (`harness-seed/loop/native-contract.ts`), held equal by `tests/conformance/seed-contracts.test.ts`.
 */
import type { BuildTarget } from "./game-project.ts";
import { NativeRefusal } from "./native-contract.ts";
import { CustomEvent, type CustomEventData, customPayload } from "./custom-events.ts";

/** The checks the suite runs, in the order it runs them. Wire values: never rename one. */
export const ConformanceCheck = {
  /** Every contract verb answers in its shape, refusals included (an unknown demo or camera names what exists). */
  Verbs: "verbs",
  /** Two seeded runs of the named demo, in two runs of the game, give the same state checksum and capture digest. */
  SeedDeterminism: "seed-determinism",
  /** The FNV-1a of the capture file equals the digest the game reported, and the file is `width × height × 4` BGRA. */
  CaptureDigest: "capture-digest",
  /** On a Mac, Live's ring delivers frames with a monotonic seq on the ring's generation; elsewhere `unavailable`. */
  LiveRing: "live-ring",
  /** Stop ends the game on `quit` within the studio's deadlines, its process group reaped and nothing left behind. */
  StopReap: "stop-reap",
  /**
   * A game whose receipt advertises `renderSettings` answers it in shape and round-trips it, names
   * what it was set to in `state().volatile.render`, draws every feature switch it was sent (or names
   * it in `degraded`), gives a non-blank capture settled twice with one digest under every preset,
   * every emulated phone class as it ships and every phone class with TAA, AO and exposure on, keeps one look
   * from low to high (mean luminance and hue) and captures two cold boots on one pinned profile;
   * `unavailable` with `render-settings-unsupported` for a game without the verb (C++, a Rust game
   * built before it).
   */
  RenderPresets: "render-presets",
  /**
   * Under every preset and the emulated mobile-mid and mobile-low classes, no custom GPU pass is
   * refused (`state().volatile.customPasses`), no Level-2 `[[wgsl]]` source carries a refusal code
   * (`volatile.extensions`) and `volatile.render.degraded` names only typed reasons the
   * game's receipt allows (a v1 fallback only where it still serves v1); `unavailable` with
   * `render-settings-unsupported` for a game without the verb.
   */
  RenderExtensions: "render-extensions",
} as const;
export type ConformanceCheck = (typeof ConformanceCheck)[keyof typeof ConformanceCheck];

/** Every check, in run order. */
export const CONFORMANCE_CHECKS: readonly ConformanceCheck[] = Object.freeze(Object.values(ConformanceCheck));

/**
 * How one check came out. `unavailable` means the check could not run here: never a pass, and
 * counted green only where {@link conformancePassed} says. Wire values.
 */
export const ConformanceOutcome = {
  Pass: "pass",
  Fail: "fail",
  Unavailable: "unavailable",
} as const;
export type ConformanceOutcome = (typeof ConformanceOutcome)[keyof typeof ConformanceOutcome];

/** Why a check failed or could not run. Typed; the words live with the reader. Wire values: never rename one. */
export const ConformanceProblem = {
  /** The game did not start, or never said it was ready. */
  LaunchFailed: "launch-failed",
  /** The game ended (or the host ended it) while the check spoke to it. */
  GameEnded: "game-ended",
  /** A contract verb answered `unknown-op`. */
  VerbMissing: "verb-missing",
  /** A verb answered outside its contract (the shape, or what it says it did). */
  VerbInvalid: "verb-invalid",
  /** A verb was refused, or did not answer in time. */
  VerbFailed: "verb-failed",
  /** The named demo is not one the game lists. */
  DemoMissing: "demo-missing",
  /** `state()` carries no `checksum`. */
  ChecksumMissing: "checksum-missing",
  /** Two seeded runs disagree on the state checksum or the capture digest. */
  Nondeterministic: "nondeterministic",
  /** The two seeded runs started different builds (the folder changed between them): nothing is judged of either. */
  BuildChanged: "build-changed",
  /** The capture file's FNV-1a is not the digest the game reported. */
  CaptureDigest: "capture-digest",
  /** The capture file is missing, not a regular file in the run's captures folder, or not the declared size. */
  CaptureFile: "capture-file",
  /** Live embeds Mac builds only: the ring cannot be watched on this host. */
  LiveNotMac: "live-not-mac",
  /** No frames host here (no addon, or a caller that may not borrow Live): the ring cannot be watched. */
  LiveNoFramesHost: "live-no-frames-host",
  /** Fewer frames than the check waits for arrived on the ring. */
  RingNoFrames: "ring-no-frames",
  /** A frame's seq did not increase. */
  RingSeq: "ring-seq",
  /** A frame came on another generation than its ring's, or the ring has none. */
  RingGeneration: "ring-generation",
  /** The game did not end on `quit`: the studio had to signal its group. */
  StopIgnored: "stop-ignored",
  /** The game was not reaped within `NATIVE_STOP_BUDGET_MS`. */
  StopDeadline: "stop-deadline",
  /** A process the game started outlived it. */
  Orphan: "orphan",
  /** The check is not run for this destination yet (the web build's suite). */
  TargetUnsupported: "target-unsupported",
  /** The game's receipt does not advertise `renderSettings` (a C++ game, or a Rust game built before the verb). */
  RenderSettingsUnsupported: "render-settings-unsupported",
  /** `state().volatile.render` is missing or outside its shape (a status with no preset, an unknown reason). */
  RenderStatusInvalid: "render-status-invalid",
  /** The low and high presets' captures of one state disagree on mean luminance or hue beyond tolerance. */
  LookInconsistent: "look-inconsistent",
  /**
   * A cold boot's capture is not on the pinned profile: it names no `render` provenance, its settings
   * came from the verb, or two cold boots captured one state under different settings or digests.
   */
  CaptureUnpinned: "capture-unpinned",
  /** A custom GPU pass is not running or carries a refusal code (`gpu-pass-invalid`) under a preset or class. */
  CustomPassRefused: "custom-pass-refused",
  /** `volatile.render.degraded` names a reason the game's receipt does not allow (a v1 fallback without v1). */
  DegradeNotAllowed: "degrade-not-allowed",
  /** A Level-2 `[[wgsl]]` material or post source in `volatile.extensions` carries a refusal code under a preset or class. */
  ExtensionRefused: "extension-refused",
} as const;
export type ConformanceProblem = (typeof ConformanceProblem)[keyof typeof ConformanceProblem];

/** One check's result. `code` is null for a pass; `detail` names the verb, the field or the numbers. */
export interface ConformanceCheckResult {
  check: ConformanceCheck;
  outcome: ConformanceOutcome;
  code: ConformanceProblem | null;
  detail: string | null;
}

/**
 * A whole suite run on one build: green as `conformancePassed` says. `unavailable` counts green only
 * for Live's ring, which no caller watches yet, and for the renderer's checks on a game without the
 * verb (see {@link conformancePassed}).
 */
export interface GameConformanceReport {
  project: string | null;
  target: BuildTarget;
  /** The admitted build's SHA-256 the run judged, or null where the caller did not know it. */
  buildDigest: string | null;
  /** Every check passed, Live's ring and the renderer's checks of an unsupported game possibly `unavailable` (`conformancePassed`). */
  passed: boolean;
  checks: ConformanceCheckResult[];
  /** ISO 8601, as `Date.toISOString` writes it. */
  at: string;
}

/** The renderer's checks: judged only on a game whose receipt advertises `renderSettings`. */
const RENDER_CHECKS: ReadonlySet<ConformanceCheck> = new Set([
  ConformanceCheck.RenderPresets,
  ConformanceCheck.RenderExtensions,
]);

/**
 * Whether a report is green: every check passed, with exceptions that may be `unavailable`. Live's
 * ring is not judged yet: it is watched only through a frames host, and no caller (the harness
 * method, the npm script) has one until the M7 ring probe lands, so on every host, the Mac
 * included, a green report says nothing about Live's ring. `render-presets` and `render-extensions`
 * count green `unavailable` only with the typed problem `render-settings-unsupported` (the game's
 * receipt does not advertise `renderSettings`); a game that advertises the verb must pass both. Any
 * other check that could not run, or a run without a check's row (a run recorded before the row
 * existed), leaves the report red.
 */
export function conformancePassed(checks: readonly ConformanceCheckResult[]): boolean {
  return CONFORMANCE_CHECKS.every((check) => checks.some((result) => result.check === check && isGreen(result)));
}

/** Whether one check's result counts toward a green report (see {@link conformancePassed}). */
function isGreen(result: ConformanceCheckResult): boolean {
  if (result.outcome === ConformanceOutcome.Pass) return true;
  if (result.outcome !== ConformanceOutcome.Unavailable) return false;
  const unsupportedRender =
    RENDER_CHECKS.has(result.check) && result.code === ConformanceProblem.RenderSettingsUnsupported;
  return result.check === ConformanceCheck.LiveRing || unsupportedRender;
}

/** What the harness sends with `game.conformance`: the game, optionally a playable worktree, and the demo to seed. */
export interface GameConformanceParams {
  project: string;
  /** A playable worktree to build instead of the game folder (checked by the host). */
  root?: string;
  /** The demo the determinism check runs; the game's first demo when absent, a fixed step when it lists none. */
  demo?: string;
  /** The seed both determinism runs start from (default `CONFORMANCE_SEED`). */
  seed?: number;
  /** The thread the `conformance_run` event is written to; the main thread when absent. */
  threadId?: string;
}

/** The seed the determinism check starts both runs from when the caller names none. */
export const CONFORMANCE_SEED = 7;

/** The `conformance_run` event: one suite run, keyed by the build digest. Every field optional, as for every custom event. */
export interface ConformanceRunPayload {
  project?: string | null;
  target?: BuildTarget;
  buildDigest?: string | null;
  passed?: boolean;
  checks?: ConformanceCheckResult[];
}

// ── extension ladder level 5: eject and the trust flag ────────────────────────────────────────

/**
 * Why eject, un-eject, the trust flag or the conformance gate refused. Typed; the words live in the
 * renderer. Wire values: never rename one.
 */
export const ExtensionRefusal = {
  /** An ejected game's Live, capture or export needs a green conformance run on its current build digest. */
  ConformanceRequired: NativeRefusal.ConformanceRequired,
  /** The game already has an `engine/` (a folder, a file or a link): nothing was written. */
  EjectTargetExists: "eject-target-exists",
  /** The vendored engine crates of the game's lock line no longer match their digest manifest. */
  EjectSourceTampered: "eject-source-tampered",
  /** The game's lock line is no longer in the store. */
  EjectLockMissing: "eject-lock-missing",
  /**
   * The conformance suite judges an ejected engine on the game's Mac build: eject needs a Mac host
   * and macOS among the game's destinations. Nothing was written.
   */
  EjectNeedsMac: "eject-needs-mac",
  /** Only the person sets the trust flag, in Studio's window: never a harness method, a game file or `genex.toml`. */
  TrustPersonOnly: "trust-person-only",
  /** `unsafe` code in the game's own crates while its trust flag is off. */
  UnsafeCode: "unsafe-code",
  /** A build script or proc macro in the game's own crates while its trust flag is off. */
  BuildScriptRefused: "build-script-refused",
  /** This build cannot eject or set trust yet: nothing was written. */
  Unavailable: "extension-unavailable",
} as const;
export type ExtensionRefusal = (typeof ExtensionRefusal)[keyof typeof ExtensionRefusal];

/** What `studio:engine.eject` and `studio:engine.uneject` answer: done, or the typed refusal with nothing written. */
export interface EngineEjectAnswer {
  project: string;
  ok: boolean;
  refusal: ExtensionRefusal | null;
  /** The genex version the game's `engine/` was copied from; null when the game is not ejected. */
  ejectedFrom: string | null;
}

/** What `studio:engine.setTrust` answers: the flag as it now stands, or the typed refusal with it unchanged. */
export interface EngineTrustAnswer {
  project: string;
  ok: boolean;
  refusal: ExtensionRefusal | null;
  trusted: boolean;
}

/** What `studio:engine.state` answers: the engine a Rust game builds with and its trust flag, as the person sees them. */
export interface EngineState {
  project: string;
  /** The genex release the game's `engine/` was copied from; null when it builds with Studio's engine. */
  ejectedFrom: string | null;
  /** The person's trust flag for `unsafe` and build scripts (default off). */
  trusted: boolean;
}

/** The `engine_ejected` event: the person ejected (or un-ejected) a game's engine. */
export interface EngineEjectedPayload {
  project?: string;
  /** False for an un-eject. */
  ejected?: boolean;
  ejectedFrom?: string | null;
  /** The game snapshot taken before an un-eject. */
  snapshotId?: string | null;
}

/** The `game_trust` event: the person turned a game's trust flag on or off. */
export interface GameTrustPayload {
  project?: string;
  trusted?: boolean;
}

/**
 * The events that record an extension-ladder escape (a requested crate, an ejected engine, a
 * trusted game): `npm run report:extension-escapes` reads these so recurring escapes become genex
 * features.
 */
export const EXTENSION_ESCAPE_EVENTS: readonly CustomEvent[] = Object.freeze([
  CustomEvent.CrateRequest,
  CustomEvent.EngineEjected,
  CustomEvent.GameTrust,
]);

/** A `conformance_run` record's payload, or null for any other record. */
export function conformanceRunOf(data: CustomEventData): ConformanceRunPayload | null {
  return customPayload(data, CustomEvent.ConformanceRun);
}

/** An `engine_ejected` record's payload, or null for any other record. */
export function engineEjectedOf(data: CustomEventData): EngineEjectedPayload | null {
  return customPayload(data, CustomEvent.EngineEjected);
}

/** A `game_trust` record's payload, or null for any other record. */
export function gameTrustOf(data: CustomEventData): GameTrustPayload | null {
  return customPayload(data, CustomEvent.GameTrust);
}

/**
 * Why the stage cannot show a game that builds itself.
 *
 * Until now a failed build reached exactly two places: the game's own console, and the agent
 * loop. The user saw a black rectangle and no sentence (`studio-core.ts` set `loadError` and no
 * renderer file read it). This is that sentence's payload — structured, so the stage owns the
 * words and this file owns none of them.
 */
import type { BuildTarget } from "./game-project.ts";
import { TargetRefusal } from "./game-targets.ts";
import type { NativeRefusal } from "./native-contract.ts";
import { ToolchainProblem } from "./toolchain.ts";

/** Why a build could not even run, before any compiler output. Typed; the stage owns the words. Never rename a value. */
export const BuildProblemCode = {
  /** The command ran and failed: `lines` and `diagnostics` say why (every build problem before this epic). */
  CommandFailed: "command-failed",
  /** `<root>/CMakeCache.txt` exists: an in-source configure the lane refuses to build on. */
  InSourceBuild: "in-source-build",
  /** The lock names a store version that is not installed. */
  ToolchainMissing: "toolchain-missing",
  /** Every tool is installed, but its first build was prepared by an older Genex: set it up again. */
  ToolchainStale: "toolchain-stale",
  /** A tool it needs is pinned, but Genex has published no download of it yet: nothing to install. */
  ToolchainNotHosted: ToolchainProblem.NotHosted,
  /** No Xcode Command Line Tools. */
  CltMissing: ToolchainProblem.CltMissing,
  /** This computer builds no C++ game yet (Windows: `cppLaneRunsOn`); nothing was made or run. */
  UnsupportedHost: ToolchainProblem.UnsupportedHost,
  /** A Mac destination on a host that is not a Mac. */
  MacBuildsNeedAMac: TargetRefusal.MacBuildsNeedAMac,
  /** A desktop destination not in the game's studio.json (Web always builds). */
  NotADestination: TargetRefusal.NotADestination,
  TimedOut: "timed-out",
  /** Composer Stop or a newer build cancelled this one; no processes remain. */
  Cancelled: "cancelled",
  /** Every tool is installed, but the lock's first build (its prewarm) was never prepared: set it up. */
  ToolchainUnprepared: "toolchain-unprepared",
  /** A Windows or Linux build the PE or ELF gate refused: `gate` says which rule and file. */
  GateRefused: "gate-refused",
} as const;
export type BuildProblemCode = (typeof BuildProblemCode)[keyof typeof BuildProblemCode];

/** Where a C++ build stands, as `build.progress` reports it. Sent to the renderer: never rename a value. */
export const BuildPhase = {
  Configure: "configure",
  Build: "build",
  Done: "done",
  Failed: "failed",
} as const;
export type BuildPhase = (typeof BuildPhase)[keyof typeof BuildPhase];

/**
 * Why a C++ build is made: what Live shows, what the judges see, or what an export ships. Sent to
 * the renderer with `build.progress`: never rename a value.
 */
export const CppBuildPurpose = { Live: "live", Judging: "judging", Export: "export" } as const;
export type CppBuildPurpose = (typeof CppBuildPurpose)[keyof typeof CppBuildPurpose];

/** Which program printed a diagnostic. */
export const DiagnosticTool = {
  Clang: "clang",
  CMake: "cmake",
  WasmLd: "wasm-ld",
  Emcc: "emcc",
  Ninja: "ninja",
  Zig: "zig",
} as const;
export type DiagnosticTool = (typeof DiagnosticTool)[keyof typeof DiagnosticTool];

/** One parsed `file:line:col: error:` (or a CMake/linker error), as the stage shows it. */
export interface BuildDiagnostic {
  tool: DiagnosticTool;
  file: string | null;
  line: number | null;
  column: number | null;
  message: string;
}

export interface BuildProblem {
  project: string;
  /** The command that failed, shown only behind "Details". */
  command: string;
  /** Its exit code; null when it was killed. */
  code: number | null;
  /** The first three lines of what it printed — the part that names the error. */
  lines: string[];
  /** Dependencies are declared and node_modules is not there: offer "Install packages". */
  needsInstall: boolean;
  /** What that button runs (`npm install`, `pnpm install`, …); null when there is nothing to install. */
  install: string | null;
  /** The stage is showing the last build that worked instead of nothing at all. */
  showingLastBuild: boolean;
  /**
   * A remix's setup scripts its script-free install skipped, which it may need to build: the stage
   * offers to run them once the person trusts the game. Null for a game whose scripts ran.
   */
  skippedScripts: SetupScripts | null;
  at: string;
  /** Typed reason; absent on problems written before this field existed (read as CommandFailed). */
  reason?: BuildProblemCode;
  /** The destination that was being built; absent for a browser game's own build. */
  target?: BuildTarget;
  /** The first three diagnostics the C++ lane parsed; `lines` keeps the first output lines as before. */
  diagnostics?: BuildDiagnostic[];
  /** `GateRefused`: the gate's refusal and the file in `out/` it was about. */
  gate?: { refusal: NativeRefusal; file: string };
}

/** The setup scripts a script-free install skipped: the game's own, and its packages' by name. */
export interface SetupScripts {
  own: boolean;
  packages: string[];
}

/** What one press of "Install packages" did. */
export interface InstallResult {
  ok: boolean;
  /** The last few lines of the install, for the same "Details" disclosure. */
  lines: string[];
}

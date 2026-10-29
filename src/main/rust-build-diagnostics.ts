/**
 * What the Rust build lane (`rust-build.ts`) reads back from cargo, and the typed vocabulary it
 * answers with besides the stage's `BuildProblem`: the lane's own refusal codes, the first
 * diagnostics of a failed step (Cargo's JSON `compiler-message`s, the first one with spans first),
 * the executables a build produced (Cargo's `compiler-artifact` messages: the lane never guesses a
 * path from the target folder's layout, which Cargo 1.100 changes) and the receipt a build leaves.
 *
 * Every line cargo prints is untrusted: a build script or a proc macro can print anything to
 * stdout, so a line that is not a JSON object of a known shape is skipped, and every string kept
 * is capped.
 */
import type { RustTargetSeed, RustTargetSharing } from "./rust-build-cache.ts";
import path from "node:path";
import { isInside, toPosixRelative } from "../substrate/paths.ts";
import type { CrateRefusal } from "../shared/crate-requests.ts";
import type { ExtensionRefusal } from "../shared/game-conformance.ts";
import type { NativeRefusal, RustAdmissionProblem } from "../shared/native-contract.ts";
import type { StagedImportReport } from "./rust-assets.ts";
import type { AssetPackageReport } from "./rust-package-assets.ts";
import type { WebReceipt } from "./rust-build-web.ts";

/** Why the Rust lane refused a build, beside the stage's `BuildProblemCode`. Typed; never rename a value. */
export const RustBuildRefusal = {
  /** The game's manifest names a crate outside the facade and the reviewed allowlist (`RUST_CRATE_ALLOWLIST`). */
  DependencyNotAllowed: "dependency-not-allowed",
  /** The offline lock named a package from anywhere but the vendored registry or the facade's own sources. */
  LockRefused: "lock-refused",
  /** Staging the game's sources and writing its manifest refused it (M2.2's typed code is in `detail`). */
  StageRefused: "stage-refused",
  /** No builder for this destination has landed yet (`RUST_TARGET_BUILDERS`): web, mobile, Windows and Linux until theirs. */
  TargetUnbuilt: "target-unbuilt",
  /** The build finished, but Cargo's messages named no executable for the game. */
  NoArtifact: "no-artifact",
  /** An executable or asset Cargo named was not a regular file inside the build folder, or too big. */
  ArtifactRefused: "artifact-refused",
  /** A web build found no shell page in the app's resources a build may serve (absent, a link, not a file, empty). */
  WebShellMissing: "web-shell-missing",
  /** The web branch refused the module cargo built (`RustWebRefusal` in the line), or had no tools. */
  WebPackageRefused: "web-package-refused",
  /** This host cannot make the destination's own settings (a phone's SDK or NDK is missing). */
  TargetSettings: "target-settings",
  /** The host's admission refused an executable the build made (M3.5's policy, or the transport scan). */
  AdmissionRefused: "admission-refused",
  /** The destination's asset package passed its hard cap (`assets-over-ceiling` in the line, C-17). */
  PackageRefused: "package-refused",
} as const;
export type RustBuildRefusal = (typeof RustBuildRefusal)[keyof typeof RustBuildRefusal];

/** Which program a Rust diagnostic came from. Typed; never rename a value. */
export const RustDiagnosticTool = {
  Rustc: "rustc",
  Clippy: "clippy",
  Cargo: "cargo",
} as const;
export type RustDiagnosticTool = (typeof RustDiagnosticTool)[keyof typeof RustDiagnosticTool];

/** One compiler error as the lane reports it: where (relative to the staged game), what, and its notes. */
export interface RustDiagnostic {
  tool: RustDiagnosticTool;
  /** The lint or error code (`E0308`, `clippy::disallowed_methods`), or null. */
  code: string | null;
  /** The primary span's file, relative to the staged game when inside it; null without a span. */
  file: string | null;
  line: number | null;
  column: number | null;
  message: string;
  /** The child notes and helps, in order. */
  notes: string[];
}

/** The compiler a build used, as `rustc -vV` names it. */
export interface RustCompilerIdentity {
  release: string;
  commitHash: string;
  host: string;
  llvm: string;
}

/** One step of a build and how long it took. Wire values in receipts: never rename a step. */
export const RustBuildStep = {
  Identity: "identity",
  Lock: "lock",
  Clippy: "clippy",
  Build: "build",
  /** The web branch after cargo: wasm-bindgen, wasm-opt and the page (`rust-build-web.ts`). */
  WebPackage: "web-package",
} as const;
export type RustBuildStep = (typeof RustBuildStep)[keyof typeof RustBuildStep];

/** What a Rust build leaves beside its folder: what was built, with what, how long each step took and the admitted files. */
export interface RustBuildReceipt {
  version: 1;
  project: string;
  target: string;
  triple: string;
  profile: string;
  /** The toolchain lock's full digest. */
  lock: string;
  compiler: RustCompilerIdentity;
  startedAt: string;
  finishedAt: string;
  steps: Array<{ step: RustBuildStep; ms: number; code: number | null }>;
  /** The admitted `out/` files, `/`-separated, with their sha256 and size. */
  outputs: Array<{ path: string; sha256: string; bytes: number }>;
  /** How the host shares compiled dependencies, and where this build's target folder came from (`rust-build-cache.ts`). */
  cache?: { sharing: RustTargetSharing; seed: RustTargetSeed };
  /** A web build's packaging: the tools, the module's sizes against the budget, the served files. */
  web?: WebReceipt;
  /** The import step over the stage (C-2): each staged asset's action and refusal. */
  assets?: StagedImportReport;
  /** The destination's asset package (C-15): bytes, files per family, what was dropped or trimmed. */
  package?: AssetPackageReport;
}

/** A crate the build was refused for (`dependency-not-allowed`): its name, when one is named, and why. */
export interface RustCrateRefusal {
  name: string | null;
  refusal: CrateRefusal;
}

/** What the Rust lane adds to a `BuildOutcome`: its typed refusal, the first diagnostics and the receipt. */
export interface RustLaneReport {
  refusal: RustBuildRefusal | null;
  diagnostics: RustDiagnostic[];
  receipt: RustBuildReceipt | null;
  /** The crate decision behind a `dependency-not-allowed` refusal, typed; absent otherwise. */
  crate?: RustCrateRefusal;
  /** What the host's admission refused behind an `admission-refused`: the file, the refusal and why, typed. */
  admission?: RustAdmissionRefusal;
  /** The trust policy a refusal comes from (`unsafe-code`, `build-script-refused`, M7.2), typed; absent otherwise. */
  extension?: ExtensionRefusal;
}

/** An `out/` file the host's admission refused (`admitRustOutput`): its name, the refusal and the finer problem. */
export interface RustAdmissionRefusal {
  file: string;
  refusal: NativeRefusal;
  problem: RustAdmissionProblem;
}

/** What one cargo run printed, read as Cargo's JSON messages. */
export interface CargoMessages {
  /** The errors, the first one with spans first, at most {@link DIAGNOSTICS_KEPT}. */
  diagnostics: RustDiagnostic[];
  /** The rendered text of the first error with spans (else the first error), split into lines; empty when none. */
  rendered: string[];
  /** How many errors named a place in the code: rustc's closing `aborting due to …` names none. */
  located: number;
  /** Executables Cargo reported for a binary target of the package at `manifest`, in order. */
  executables: string[];
  /** `build-finished`'s verdict, or null when cargo never said. */
  success: boolean | null;
}

/** How many diagnostics a report keeps: the stage has room for three. */
const DIAGNOSTICS_KEPT = 3;
/** The longest message or note kept. */
const MESSAGE_MAX_CHARS = 400;
/** How many notes one diagnostic keeps. */
const NOTES_KEPT = 4;
/** How many rendered lines a problem keeps. */
const RENDERED_LINES_KEPT = 12;
/** The longest line of cargo output the lane reads as a message; anything longer is skipped. */
const MESSAGE_LINE_MAX_CHARS = 1024 * 1024;
/** A rendered line that is only rustc's gutter (`    |`): it says nothing, so the agent never reads it. */
const GUTTER_ONLY = /^\s*\|\s*$/;
/** What a problem says after the first error about the rest. */
const MESSAGE = {
  moreErrors: (count: number) => `…and ${count} more error${count === 1 ? "" : "s"}`,
} as const;
/** The clippy lint prefix: a diagnostic whose code has it came from clippy. */
const CLIPPY_PREFIX = "clippy::";

/** Cargo's message kinds the lane reads. Wire values (cargo's own): never rename one. */
const CargoReason = {
  CompilerMessage: "compiler-message",
  CompilerArtifact: "compiler-artifact",
  BuildFinished: "build-finished",
} as const;

/** rustc's diagnostic levels that fail a build. */
const ERROR_LEVELS: ReadonlySet<string> = new Set(["error", "error: internal compiler error"]);

interface RawSpan {
  file_name?: unknown;
  line_start?: unknown;
  column_start?: unknown;
  is_primary?: unknown;
}

interface RawMessage {
  message?: unknown;
  code?: { code?: unknown } | null;
  level?: unknown;
  spans?: unknown;
  children?: unknown;
  rendered?: unknown;
}

/**
 * Cargo's JSON messages in `output` (one per line, anything else skipped): the errors (the first
 * with spans first), the first error's rendered text, the executables of the binary targets of the
 * package whose manifest is `manifest`, and the build's verdict. Files inside `stageRoot` are named
 * relative to it.
 */
export function parseCargoMessages(output: string, stageRoot: string, manifest: string): CargoMessages {
  const read: MessagesRead = { errors: [], executables: [], success: null };
  for (const line of output.split("\n")) {
    const message = jsonObject(line);
    if (message) readMessage(read, message, stageRoot, manifest);
  }
  const located = read.errors.findIndex((error) => error.diagnostic.file !== null);
  const first = read.errors[located];
  const ordered = first && located > 0 ? [first, ...read.errors.filter((_, at) => at !== located)] : read.errors;
  const kept = ordered.slice(0, DIAGNOSTICS_KEPT);
  return {
    diagnostics: kept.map((error) => error.diagnostic),
    rendered: kept[0]?.rendered ?? [],
    located: read.errors.filter((error) => error.diagnostic.file !== null).length,
    executables: read.executables,
    success: read.success,
  };
}

/** What the messages read so far said: the errors with their rendered text, the executables and the verdict. */
interface MessagesRead {
  errors: Array<{ diagnostic: RustDiagnostic; rendered: string[] }>;
  executables: string[];
  success: boolean | null;
}

/** One of cargo's messages into `read`: a verdict, an artifact or an error; anything else is skipped. */
function readMessage(read: MessagesRead, message: Record<string, unknown>, stageRoot: string, manifest: string): void {
  if (message.reason === CargoReason.BuildFinished && typeof message.success === "boolean")
    read.success = message.success;
  if (message.reason === CargoReason.CompilerArtifact) read.executables.push(...artifactExecutable(message, manifest));
  if (message.reason !== CargoReason.CompilerMessage) return;
  const raw = (message.message ?? null) as RawMessage | null;
  const diagnostic = raw ? errorDiagnostic(raw, stageRoot) : null;
  if (raw && diagnostic) read.errors.push({ diagnostic, rendered: renderedLines(raw) });
}

/**
 * The lines a problem shows for `messages`: the first error's rendered text without its empty
 * gutter lines, then how many more errors named a place; nothing when there is no error.
 */
export function diagnosticLines(messages: Pick<CargoMessages, "rendered" | "located">): string[] {
  const lines = messages.rendered.filter((line) => !GUTTER_ONLY.test(line)).slice(0, RENDERED_LINES_KEPT);
  const more = messages.located - 1;
  return lines.length && more > 0 ? [...lines, MESSAGE.moreErrors(more)] : lines;
}

/**
 * `rustc -vV` read as the compiler's identity; a field it did not print is `""`, so a receipt
 * always says what was known.
 */
export function parseRustcIdentity(output: string): RustCompilerIdentity {
  const field = (name: string) => {
    const line = output.split("\n").find((entry) => entry.startsWith(`${name}: `));
    return clip(line ? line.slice(name.length + 2).trim() : "");
  };
  return {
    release: field("release"),
    commitHash: field("commit-hash"),
    host: field("host"),
    llvm: field("LLVM version"),
  };
}

/** A JSON object on one line of cargo's output, or null for anything else. */
function jsonObject(line: string): Record<string, unknown> | null {
  const text = line.trim();
  if (!text.startsWith("{") || text.length > MESSAGE_LINE_MAX_CHARS) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The executable a `compiler-artifact` message reports for a binary target of the package at `manifest`. */
function artifactExecutable(message: Record<string, unknown>, manifest: string): string[] {
  if (message.manifest_path !== manifest || typeof message.executable !== "string") return [];
  const target = message.target as { kind?: unknown } | undefined;
  const kinds = Array.isArray(target?.kind) ? target.kind : [];
  return kinds.includes("bin") ? [message.executable] : [];
}

/** An error-level message as a diagnostic, or null for warnings, notes and malformed messages. */
function errorDiagnostic(raw: RawMessage, stageRoot: string): RustDiagnostic | null {
  if (typeof raw.level !== "string" || !ERROR_LEVELS.has(raw.level) || typeof raw.message !== "string") return null;
  const code = typeof raw.code?.code === "string" ? clip(raw.code.code) : null;
  const span = primarySpan(raw.spans);
  return {
    tool: code?.startsWith(CLIPPY_PREFIX) ? RustDiagnosticTool.Clippy : RustDiagnosticTool.Rustc,
    code,
    file: span ? stageRelative(stageRoot, span.file) : null,
    line: span?.line ?? null,
    column: span?.column ?? null,
    message: clip(raw.message),
    notes: childNotes(raw.children),
  };
}

/** The primary span (else the first) with a file and a position. */
function primarySpan(spans: unknown): { file: string; line: number; column: number } | null {
  if (!Array.isArray(spans)) return null;
  const located = spans.filter(
    (span: RawSpan) =>
      typeof span?.file_name === "string" && Number.isInteger(span.line_start) && Number.isInteger(span.column_start),
  ) as Array<Required<RawSpan>>;
  const span = located.find((entry) => entry.is_primary === true) ?? located[0];
  if (!span) return null;
  return { file: span.file_name as string, line: span.line_start as number, column: span.column_start as number };
}

function childNotes(children: unknown): string[] {
  if (!Array.isArray(children)) return [];
  const notes = children
    .map((child: RawMessage) => child?.message)
    .filter((note): note is string => typeof note === "string" && note.length > 0);
  return notes.slice(0, NOTES_KEPT).map(clip);
}

/** The rendered text of a message as lines, blank ones and trailing space dropped. */
function renderedLines(raw: RawMessage): string[] {
  if (typeof raw.rendered !== "string") return typeof raw.message === "string" ? [clip(raw.message)] : [];
  return raw.rendered
    .split("\n")
    .map((line) => clip(line.trimEnd()))
    .filter((line) => line.trim().length > 0);
}

/** A file inside the staged game named relative to it (what the person's editor calls it); any other keeps its path. */
function stageRelative(root: string, file: string): string {
  if (!path.isAbsolute(file) || !isInside(root, file)) return clip(file);
  return clip(toPosixRelative(path.relative(root, file)));
}

function clip(text: string): string {
  return text.length > MESSAGE_MAX_CHARS ? `${text.slice(0, MESSAGE_MAX_CHARS - 1)}…` : text;
}

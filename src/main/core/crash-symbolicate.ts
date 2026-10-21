/**
 * Symbolication of a kept crash record (game-systems PROFILE, CRASH-7b): the record's raw frames
 * named from the build's own debug files by the store's `genex-symbolicate` tool
 * (`rust-prewarm.ts`), run under the sandbox with no network and nothing writable.
 *
 * - The host chooses every path the tool reads ({@link crashDebugFiles}): an export's kept debug
 *   folder (`<bin>.debug/<digest>/`, CRASH-7a), or a Live build's own executable and target
 *   folder, only while the built executable still has the run's digest. Nothing from the record
 *   becomes a path: the request carries only its numbers (anchor, frame addresses, wasm function
 *   indexes), and the tool itself opens only files under the roots it is given.
 * - The image's slide comes from the anchor: the record's runtime address of
 *   `genex_crash::frames::anchor` against the same symbol in the debug file. A frame outside the
 *   image's text is `foreign` (a system library).
 * - A Mac Live build keeps its DWARF in the object files; the tool follows the executable's debug
 *   map (`N_OSO`) into the build's target folder.
 * - A web trap's `wasm-function[N]` frames are named from the export's symbol map.
 * - The tool gets {@link SYMBOLICATE_TIMEOUT_MS}. A timeout, a refusal, a missing tool or output
 *   it cannot read gives null: the record is kept unsymbolicated, and intake never fails for it.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  CRASH_FRAMES_MAX,
  CRASH_PATH_MAX_CHARS,
  type CrashRecordV1,
  type CrashSymbolFrame,
  type CrashSymbolFunction,
  type CrashSymbols,
} from "../../shared/crash-record.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { isJsonObject } from "../../substrate/fsx.ts";
import { isInside } from "../../substrate/paths.ts";
import { DebugFileKind, keptDebugBuild } from "../../substrate/rust-debug-files.ts";
import { type RunRequest, type RunResult, shellQuote } from "../../substrate/spawn.ts";
import type { ToolchainLock } from "../../shared/toolchain.ts";
import { rustToolsFolder, SYMBOLICATE_TOOL } from "../../substrate/toolchain-store/rust-locate.ts";
import { RustToolStep } from "../../substrate/toolchain-store/rust-prewarm.ts";

/** How long one symbolication may take before the record is kept unsymbolicated. */
export const SYMBOLICATE_TIMEOUT_MS = 20 * SECOND_MS;
/** The anchor function's demangled path in every game (`genex-crash/src/frames.rs`). */
export const CRASH_ANCHOR_SYMBOL = "genex_crash::frames::anchor";
/** The most output read back from the tool. */
const SYMBOLICATE_OUTPUT_MAX_BYTES = 1024 * 1024;
/** The most functions (one frame's inlined chain) kept per frame, as the tool caps them. */
const FRAME_FUNCTIONS_MAX = 16;
/** The longest function name kept. */
const FUNCTION_NAME_MAX_CHARS = 1024;
/** A cargo `.dSYM` bundle's DWARF folder, inside the bundle. */
const DSYM_DWARF = ["Contents", "Resources", "DWARF"] as const;
/** Beside the build folder `<bin>`: the admitted output and the staged game the build compiled. */
const OUT_SUFFIX = ".out";
const STAGE_SUFFIX = ".stage";
const TARGET_DIR = "target";

/** The files one build gives the tool, all chosen by the host. */
export interface CrashDebugFiles {
  /** The folders the tool may read under. */
  roots: string[];
  /** The files the anchor is looked for in: an executable, an unstripped copy or a dSYM's DWARF file. */
  debug: string[];
  /** A web export's symbol map, or null. */
  symbolMap: string | null;
  /** Source folders shown as game-relative paths (the staged copy the build compiled). */
  sourceRoots: string[];
}

/** The build a record came from: its admitted output (`<bin>.out`), the executable in it and its digest. */
export interface CrashBuild {
  output: string;
  /** The executable's path inside `output` (`game`, `game-headless`); null for a web build. */
  exe: string | null;
  /** The SHA-256 of the admitted executable or module (the run's `BuildIdentity.digest`). */
  digest: string;
}

/** What a symbolication reaches, injected. */
export interface CrashSymbolicateDeps {
  /** The store's `genex-symbolicate`, or null when this lock's prewarm built none. */
  tool: string | null;
  run(request: RunRequest): Promise<RunResult>;
  timeoutMs?: number;
}

/** The store's symbolicator for `lock`, or null when that lock's prewarm built none. */
export async function storeSymbolicateTool(store: string, lock: ToolchainLock): Promise<string | null> {
  const name = process.platform === "win32" ? `${SYMBOLICATE_TOOL}.exe` : SYMBOLICATE_TOOL;
  const tool = path.join(rustToolsFolder(store, lock), name);
  return (await lstat(tool).catch(() => null))?.isFile() ? tool : null;
}

/** What the intake's symbolicator reaches: the store's tool for a game's lock and the sandbox. */
export interface CrashSymbolicatorDeps {
  tool(project: string): Promise<string | null>;
  run(request: RunRequest): Promise<RunResult>;
}

/**
 * The game crash store's `symbolicate`: a run's record named against its build's debug files,
 * null for a run with no build, no debug files or no tool. Never throws.
 */
export function createCrashSymbolicator(
  deps: CrashSymbolicatorDeps,
): (run: { project: string; build?: CrashBuild | null }, record: CrashRecordV1) => Promise<CrashSymbols | null> {
  return async (run, record) => {
    try {
      const files = run.build ? await crashDebugFiles(run.build) : null;
      const tool = files ? await deps.tool(run.project) : null;
      return files && tool ? await symbolicateCrash(record, files, { tool, run: deps.run }) : null;
    } catch {
      return null;
    }
  };
}

/**
 * The debug files of `build`, or null when there are none to read: an export's kept folder for
 * its digest, else (a Live build) its own executable while it still has that digest, with the
 * build's target folder for the object files a Mac debug map names.
 */
export async function crashDebugFiles(build: CrashBuild): Promise<CrashDebugFiles | null> {
  if (!build.output.endsWith(OUT_SUFFIX)) return null;
  const bin = build.output.slice(0, -OUT_SUFFIX.length);
  const sourceRoots = [`${bin}${STAGE_SUFFIX}`];
  const kept = await keptDebugBuild(bin, build.digest);
  if (kept) return keptFiles(kept.folder, kept.index, sourceRoots);
  if (build.exe === null) return null;
  const exe = path.join(build.output, build.exe);
  if (!isInside(build.output, exe) || (await fileSha256(exe)) !== build.digest) return null;
  return { roots: [build.output, path.join(bin, TARGET_DIR)], debug: [exe], symbolMap: null, sourceRoots };
}

/** The tool's files in a kept export folder, from its index (never a link: the index lists regular files). */
function keptFiles(
  folder: string,
  index: { kind: string; files: { path: string }[] },
  sourceRoots: string[],
): CrashDebugFiles {
  const files = index.files.map((file) => file.path).filter((rel) => !rel.split("/").includes(".."));
  const inFolder = (rel: string) => path.join(folder, ...rel.split("/"));
  const dwarf = (rel: string) => rel.split("/").slice(1, -1).join("/") === DSYM_DWARF.join("/");
  const pick: Record<string, (rel: string) => boolean> = {
    [DebugFileKind.Dsym]: (rel) => rel.split("/")[0]?.endsWith(".dSYM") === true && dwarf(rel),
    [DebugFileKind.Unstripped]: (rel) => !rel.includes("/"),
    [DebugFileKind.SymbolMap]: () => false,
  };
  const debug = files.filter((rel) => pick[index.kind]?.(rel) ?? false).map(inFolder);
  const map = index.kind === DebugFileKind.SymbolMap ? (files[0] ?? null) : null;
  return { roots: [folder], debug, symbolMap: map === null ? null : inFolder(map), sourceRoots };
}

async function fileSha256(file: string): Promise<string | null> {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) return null;
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk);
  } catch {
    return null;
  }
  return hash.digest("hex");
}

/** A path fit for one request line: absolute, with no line break. */
const plainPath = (file: string) => path.isAbsolute(file) && !/[\r\n]/.test(file);

/**
 * The tool's request for `record` (one directive per line), or null when there is nothing to
 * name. Only the host's paths and the record's numbers go in it.
 */
export function symbolicateRequest(record: CrashRecordV1, files: CrashDebugFiles): string | null {
  const ips = record.frames.slice(0, CRASH_FRAMES_MAX).flatMap((frame) => ("ip" in frame ? [frame.ip] : []));
  const funcs = (record.wasm?.stack ?? []).slice(0, CRASH_FRAMES_MAX).map((frame) => frame.func);
  const native = ips.length > 0 && record.anchor !== null && files.debug.length > 0;
  const web = funcs.length > 0 && files.symbolMap !== null;
  const paths = [...files.roots, ...files.debug, ...(files.symbolMap ? [files.symbolMap] : [])];
  if ((!native && !web) || !paths.every(plainPath)) return null;
  const lines = files.roots.map((root) => `root ${root}`);
  if (native) {
    lines.push(...files.debug.map((file) => `debug ${file}`), `anchor ${CRASH_ANCHOR_SYMBOL} ${record.anchor}`);
    lines.push(...ips.map((ip) => `frame ${ip}`));
  }
  if (web) lines.push(`map ${files.symbolMap}`, ...funcs.map((func) => `func ${func}`));
  return `${lines.join("\n")}\n`;
}

/**
 * `record`'s frames named from `files` by the store's tool, or null when they could not be (no
 * tool, nothing to name, a refusal, a timeout or output that is not the tool's). Never throws.
 */
export async function symbolicateCrash(
  record: CrashRecordV1,
  files: CrashDebugFiles,
  deps: CrashSymbolicateDeps,
): Promise<CrashSymbols | null> {
  const stdin = symbolicateRequest(record, files);
  if (deps.tool === null || stdin === null) return null;
  const roots = await Promise.all(files.roots.map((root) => realpath(root).catch(() => root)));
  try {
    const result = await deps.run({
      label: RustToolStep.Symbolicate,
      command: shellQuote(deps.tool),
      cwd: path.dirname(deps.tool),
      stdin,
      timeoutMs: deps.timeoutMs ?? SYMBOLICATE_TIMEOUT_MS,
      maxOutputBytes: SYMBOLICATE_OUTPUT_MAX_BYTES,
      policy: { allowedDomains: [], allowWrite: [], allowRead: roots },
    });
    if (result.timedOut || result.code !== 0) return null;
    return parseSymbolicateOutput(result.stdout, record, files.sourceRoots);
  } catch {
    return null;
  }
}

/**
 * The tool's answer for `record`, or null: one named frame per `ip` frame sent, in the record's
 * frame order (a platform frame, `{image, offset}`, is listed with no functions), and the web
 * trap's functions.
 */
export function parseSymbolicateOutput(
  stdout: string,
  record: CrashRecordV1,
  sourceRoots: readonly string[] = [],
): CrashSymbols | null {
  const value = parseJson(stdout.trim().split("\n").pop() ?? "");
  if (!isJsonObject(value) || value.ok !== true) return null;
  const answer = parseCrashSymbols({ frames: value.frames, wasm: value.funcs });
  if (answer === null) return null;
  if (answer.frames.length === 0) return answer;
  const kept = record.frames.slice(0, CRASH_FRAMES_MAX);
  const named = answer.frames.map((frame) => relativeFrame(frame, sourceRoots));
  if (named.length !== kept.filter((frame) => "ip" in frame).length) return null;
  let next = 0;
  const unnamed: CrashSymbolFrame = { foreign: false, functions: [] };
  const frames = kept.map((frame) => ("ip" in frame ? (named[next++] ?? unnamed) : unnamed));
  return { frames, wasm: answer.wasm };
}

/** A frame with every file under a source root shown relative to it (`src/main.rs`). */
function relativeFrame(frame: CrashSymbolFrame, sourceRoots: readonly string[]): CrashSymbolFrame {
  if (frame.foreign) return frame;
  const relative = (file: string | null) => {
    const root = file === null ? undefined : sourceRoots.find((dir) => isInside(dir, file));
    return file !== null && root !== undefined ? path.relative(root, file).split(path.sep).join("/") : file;
  };
  return { foreign: false, functions: frame.functions.map((f) => ({ ...f, file: relative(f.file) })) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const isCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
/** A string cut to `max`, null for null, undefined for anything else (malformed). */
function nullableText(value: unknown, max: number): string | null | undefined {
  if (typeof value === "string") return value.slice(0, max);
  return value === null ? null : undefined;
}

/** A count, null for null, undefined for anything else (malformed). */
function nullableCount(value: unknown): number | null | undefined {
  if (isCount(value)) return Number(value);
  return value === null ? null : undefined;
}

function symbolFunction(value: unknown): CrashSymbolFunction | null {
  if (!isJsonObject(value)) return null;
  const name = nullableText(value.function, FUNCTION_NAME_MAX_CHARS);
  const file = nullableText(value.file, CRASH_PATH_MAX_CHARS);
  const line = nullableCount(value.line);
  const column = nullableCount(value.column);
  const malformed = name === undefined || file === undefined || line === undefined || column === undefined;
  if (malformed) return null;
  return { function: name, file, line, column };
}

function symbolFrame(value: unknown): CrashSymbolFrame | null {
  if (!isJsonObject(value)) return null;
  if (value.foreign === true) return { foreign: true };
  if (value.foreign !== false || !Array.isArray(value.functions)) return null;
  const functions = value.functions.slice(0, FRAME_FUNCTIONS_MAX).map(symbolFunction);
  return functions.every((f) => f !== null) ? { foreign: false, functions } : null;
}

function wasmName(value: unknown): CrashSymbols["wasm"][number] | null {
  if (!isJsonObject(value) || !isCount(value.func)) return null;
  const name = nullableText(value.name, FUNCTION_NAME_MAX_CHARS);
  return name === undefined ? null : { func: Number(value.func), name };
}

/**
 * Symbols read back from a kept entry or the tool (hostile input): at most `CRASH_FRAMES_MAX`
 * frames and wasm functions, names and paths cut to their caps; anything malformed gives null.
 */
export function parseCrashSymbols(value: unknown): CrashSymbols | null {
  if (!isJsonObject(value) || !Array.isArray(value.frames) || !Array.isArray(value.wasm)) return null;
  if (value.frames.length > CRASH_FRAMES_MAX || value.wasm.length > CRASH_FRAMES_MAX) return null;
  const frames = value.frames.map(symbolFrame);
  const wasm = value.wasm.map(wasmName);
  if (!frames.every((frame) => frame !== null) || !wasm.every((item) => item !== null)) return null;
  return { frames, wasm };
}

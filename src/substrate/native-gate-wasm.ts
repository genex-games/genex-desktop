/**
 * The web destination's gate for a Rust · wgpu game (M3.5). A web build is agent-made code the
 * player's browser runs, so the host reads its wasm module itself: a bounded reader of the binary
 * format's sections (every length checked against the bytes, every name strict UTF-8) that takes
 * the imports and exports, and refuses anything malformed with a typed problem, never a throw.
 *
 * - The module ({@link admitRustWasm}) imports only functions from its own wasm-bindgen glue
 *   ({@link RUST_WASM_GLUE_MODULE}): no `env` or WASI import, no memory or table shared with the
 *   page, nothing a page could hand it besides the glue's functions.
 * - The folder ({@link admitWebShell}, the shell manifest) holds exactly the shell's files
 *   ({@link RUST_WEB_SHELL_FILES}: the page, the glue, the module and the optional size report) and
 *   regular files under `assets/`, none of them a wasm module; it is read through the shared
 *   bounded walk (`bundle-walk.ts`), links and hard links refused, and each file opened again
 *   without following a link. The answer lists every file with its sha256 and size: what the export
 *   copies and re-checks.
 *
 * Reads only, never writes.
 */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { errorMessage } from "../shared/errors.ts";
import { NativeRefusal, RustAdmissionProblem, type RustBinaryRefusal } from "../shared/native-contract.ts";
import { readBundleFile, WalkKind, WalkProblem, type WalkRefused, walkBundle } from "./bundle-walk.ts";

/** The biggest wasm module the gate reads (the plan's budget is 4 MB gzipped; a debug build is larger). */
export const WASM_MAX_BYTES = 64 * 1024 ** 2;
/** The biggest other file of a web build the gate reads for its digest. */
const WEB_FILE_MAX_BYTES = 256 * 1024 ** 2;
/** An unsigned LEB128 of 32 bits takes at most five bytes; a 64-bit one (memory64 limits) ten. */
const LEB_U32_BYTES = 5;
const LEB_U64_BYTES = 10;
/** wasm's magic (`\0asm`) and the one binary version. */
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d] as const;
const WASM_VERSION = 1;
const HEADER_BYTES = 8;
/** The highest known section id (13, the tag section of exception handling). */
const SECTION_ID_MAX = 13;

/** The sections the reader looks into. */
const Section = { Custom: 0, Import: 2, Export: 7 } as const;

/** What a wasm import or export is, by WebAssembly's own names. Wire values: never rename one. */
export const WasmImportKind = {
  Function: "function",
  Table: "table",
  Memory: "memory",
  Global: "global",
  Tag: "tag",
} as const;
export type WasmImportKind = (typeof WasmImportKind)[keyof typeof WasmImportKind];

/** The external kinds by their byte in the binary format. */
const KIND_OF_BYTE: readonly WasmImportKind[] = [
  WasmImportKind.Function,
  WasmImportKind.Table,
  WasmImportKind.Memory,
  WasmImportKind.Global,
  WasmImportKind.Tag,
];

/**
 * The files a Rust web build's folder holds besides `assets/`, as the lane's web branch names them
 * (`WEB_FILES` in `main/rust-build-web.ts`; `native-gate-wasm.test.ts` holds the two together).
 * `size` is the build's size report, written by the lane; every other file is required.
 */
export const RUST_WEB_SHELL_FILES = {
  page: "index.html",
  module: "game.js",
  wasm: "game_bg.wasm",
  size: "size.json",
} as const;
/** The module wasm-bindgen's glue answers imports from: `./<out-name>_bg.js`, the out-name being `game`. */
export const RUST_WASM_GLUE_MODULE = "./game_bg.js";
const ASSETS_PREFIX = "assets/";
const REQUIRED_SHELL_FILES: readonly string[] = [
  RUST_WEB_SHELL_FILES.page,
  RUST_WEB_SHELL_FILES.module,
  RUST_WEB_SHELL_FILES.wasm,
];
const SHELL_FILES: ReadonlySet<string> = new Set(Object.values(RUST_WEB_SHELL_FILES));

/** One import as the module declares it. */
export interface WasmImport {
  module: string;
  name: string;
  kind: WasmImportKind;
}

/** One export as the module declares it. */
export interface WasmExport {
  name: string;
  kind: WasmImportKind;
}

/** What a wasm module's sections say. */
export interface WasmModule {
  imports: WasmImport[];
  exports: WasmExport[];
  /** Custom section names, in file order. */
  customSections: string[];
}

/** The reader's answer: the module, or why the bytes are not one it can vouch for. */
export type WasmRead = { ok: true; module: WasmModule } | { ok: false; detail: string };

/** A Rust module the policy admitted. */
export type RustWasmAdmission = { ok: true; module: WasmModule } | RustBinaryRefusal;

/** One file of an admitted web build: its `/`-separated path, sha256 and size. */
export interface WebShellFile {
  path: string;
  sha256: string;
  bytes: number;
}

/** What the export copies from an admitted web build, and re-checks after copying. */
export interface WebShellManifest {
  files: WebShellFile[];
}

/** An admitted web build: its manifest and its module. */
export type WebShellAdmission = { ok: true; manifest: WebShellManifest; module: WasmModule } | RustBinaryRefusal;

const MESSAGE = {
  Magic: "not a WebAssembly module",
  Version: (version: number) => `WebAssembly binary version ${version}, not ${WASM_VERSION}`,
  TooLarge: (size: number) => `${size} bytes is over the ${WASM_MAX_BYTES}-byte cap`,
  Past: (at: number) => `reads past the end at byte ${at}`,
  Leb: (at: number) => `an integer at byte ${at} runs past its longest encoding`,
  SectionId: (id: number) => `unknown section id ${id}`,
  SectionSize: (id: number) => `section ${id} does not end where its size says`,
  Count: (count: number) => `a vector of ${count} entries is longer than its section`,
  Name: (at: number) => `the name at byte ${at} is not UTF-8`,
  Kind: (kind: number) => `unknown external kind ${kind}`,
  Limits: (flags: number) => `unknown limits flags ${flags}`,
  ForeignImport: (entry: WasmImport) =>
    `it imports ${entry.kind} ${JSON.stringify(entry.name)} from ${JSON.stringify(entry.module)}; a Rust web build imports functions from ${RUST_WASM_GLUE_MODULE} only`,
  ExtraFile: (file: string) => `${file} is not a file of the web shell, nor under assets/`,
  ExtraWasm: (file: string) => `${file} is a WebAssembly module besides the game's own`,
  MissingFile: (file: string) => `the web build has no ${file}`,
  Unreadable: (file: string, detail: string) => `${file} cannot be read: ${detail}`,
} as const;

/** A malformed module, thrown inside the reader and caught at its boundary. */
class WasmFault extends Error {}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A cursor over one range of the module's bytes. */
interface Cursor {
  bytes: Uint8Array;
  at: number;
  end: number;
}

function byte(cursor: Cursor): number {
  if (cursor.at >= cursor.end) throw new WasmFault(MESSAGE.Past(cursor.at));
  const value = cursor.bytes[cursor.at] ?? 0;
  cursor.at += 1;
  return value;
}

/** An unsigned LEB128 of at most `maxBytes` bytes, as a number (exact up to 2^53, bounded beyond). */
function leb(cursor: Cursor, maxBytes: number = LEB_U32_BYTES): number {
  const start = cursor.at;
  let value = 0;
  let scale = 1;
  for (let index = 0; index < maxBytes; index++) {
    const next = byte(cursor);
    value += (next & 0x7f) * scale;
    if ((next & 0x80) === 0) return value;
    scale *= 128;
  }
  throw new WasmFault(MESSAGE.Leb(start));
}

/** A length-prefixed UTF-8 name inside the cursor's range. */
function name(cursor: Cursor): string {
  const start = cursor.at;
  const length = leb(cursor);
  if (length > cursor.end - cursor.at) throw new WasmFault(MESSAGE.Past(cursor.at));
  const text = cursor.bytes.subarray(cursor.at, cursor.at + length);
  cursor.at += length;
  try {
    return utf8.decode(text);
  } catch {
    throw new WasmFault(MESSAGE.Name(start));
  }
}

/** A vector's count, which cannot exceed the bytes left (every entry takes at least one). */
function count(cursor: Cursor): number {
  const entries = leb(cursor);
  if (entries > cursor.end - cursor.at) throw new WasmFault(MESSAGE.Count(entries));
  return entries;
}

function kindOf(value: number): WasmImportKind {
  const kind = KIND_OF_BYTE[value];
  if (kind === undefined) throw new WasmFault(MESSAGE.Kind(value));
  return kind;
}

/** A table's or memory's limits: a flags byte, the minimum and, when flagged, the maximum. */
function skipLimits(cursor: Cursor): void {
  const flags = byte(cursor);
  if (flags > 7) throw new WasmFault(MESSAGE.Limits(flags));
  const width = (flags & 0x04) === 0 ? LEB_U32_BYTES : LEB_U64_BYTES;
  leb(cursor, width);
  if ((flags & 0x01) !== 0) leb(cursor, width);
}

/** Skips what an import of `kind` describes after its names: a type index, a table, a memory, a global or a tag. */
function skipDescription(cursor: Cursor, kind: WasmImportKind): void {
  if (kind === WasmImportKind.Function) {
    leb(cursor);
    return;
  }
  if (kind === WasmImportKind.Table) byte(cursor);
  if (kind === WasmImportKind.Table || kind === WasmImportKind.Memory) {
    skipLimits(cursor);
    return;
  }
  if (kind === WasmImportKind.Global) {
    byte(cursor);
    byte(cursor);
    return;
  }
  byte(cursor);
  leb(cursor);
}

function readImports(cursor: Cursor): WasmImport[] {
  const imports: WasmImport[] = [];
  const entries = count(cursor);
  for (let index = 0; index < entries; index++) {
    const module = name(cursor);
    const field = name(cursor);
    const kind = kindOf(byte(cursor));
    skipDescription(cursor, kind);
    imports.push({ module, name: field, kind });
  }
  return imports;
}

function readExports(cursor: Cursor): WasmExport[] {
  const exports: WasmExport[] = [];
  const entries = count(cursor);
  for (let index = 0; index < entries; index++) {
    const field = name(cursor);
    const kind = kindOf(byte(cursor));
    leb(cursor);
    exports.push({ name: field, kind });
  }
  return exports;
}

/** Reads one section's payload into `module`; the import and export sections must end where their size says. */
function readSection(id: number, payload: Cursor, module: WasmModule): void {
  if (id === Section.Custom) {
    module.customSections.push(name(payload));
    return;
  }
  if (id === Section.Import) module.imports.push(...readImports(payload));
  else if (id === Section.Export) module.exports.push(...readExports(payload));
  else return;
  if (payload.at !== payload.end) throw new WasmFault(MESSAGE.SectionSize(id));
}

function readHeader(bytes: Uint8Array): void {
  if (bytes.byteLength > WASM_MAX_BYTES) throw new WasmFault(MESSAGE.TooLarge(bytes.byteLength));
  const magic = bytes.byteLength >= HEADER_BYTES && WASM_MAGIC.every((value, index) => bytes[index] === value);
  if (!magic) throw new WasmFault(MESSAGE.Magic);
  const version = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (version !== WASM_VERSION) throw new WasmFault(MESSAGE.Version(version));
}

/**
 * The imports, exports and custom section names of a wasm module (binary version 1). Every length
 * is checked against the bytes; anything that does not add up is `{ ok: false }`. Never throws.
 */
export function parseWasm(bytes: Uint8Array): WasmRead {
  try {
    readHeader(bytes);
    const module: WasmModule = { imports: [], exports: [], customSections: [] };
    const cursor: Cursor = { bytes, at: HEADER_BYTES, end: bytes.byteLength };
    while (cursor.at < cursor.end) {
      const id = byte(cursor);
      if (id > SECTION_ID_MAX) throw new WasmFault(MESSAGE.SectionId(id));
      const size = leb(cursor);
      if (size > cursor.end - cursor.at) throw new WasmFault(MESSAGE.Past(cursor.at));
      readSection(id, { bytes, at: cursor.at, end: cursor.at + size }, module);
      cursor.at += size;
    }
    return { ok: true, module };
  } catch (error) {
    return { ok: false, detail: errorMessage(error) };
  }
}

const rustRefused = (refusal: NativeRefusal, problem: RustAdmissionProblem, detail: string): RustBinaryRefusal => ({
  ok: false,
  refusal,
  problem,
  detail,
});

/**
 * Admits a Rust · wgpu game's web module from its bytes (M3.5): a well-formed wasm module whose
 * every import is a function of {@link RUST_WASM_GLUE_MODULE}. Pure; never throws.
 */
export function admitRustWasm(bytes: Uint8Array): RustWasmAdmission {
  const read = parseWasm(bytes);
  if (!read.ok) return rustRefused(NativeRefusal.NotAnExecutable, RustAdmissionProblem.Unreadable, read.detail);
  const foreign = read.module.imports.find(
    (entry) => entry.module !== RUST_WASM_GLUE_MODULE || entry.kind !== WasmImportKind.Function,
  );
  if (foreign) {
    return rustRefused(NativeRefusal.ForeignImport, RustAdmissionProblem.WasmImport, MESSAGE.ForeignImport(foreign));
  }
  return { ok: true, module: read.module };
}

/** Whether `bytes` start with wasm's magic. */
const isWasm = (bytes: Uint8Array): boolean => WASM_MAGIC.every((value, index) => bytes[index] === value);

/** The refusal a walk or a second open that stopped earns: a link, a hard link, or an unreadable folder. */
function walkRefusal(stopped: WalkRefused): RustBinaryRefusal {
  const detail = MESSAGE.Unreadable(stopped.path, stopped.detail);
  if (stopped.problem === WalkProblem.Symlink || stopped.problem === WalkProblem.Swapped) {
    return rustRefused(NativeRefusal.Symlink, RustAdmissionProblem.Link, detail);
  }
  if (stopped.problem === WalkProblem.HardLink)
    return rustRefused(NativeRefusal.HardLink, RustAdmissionProblem.Link, detail);
  return rustRefused(NativeRefusal.NotAnExecutable, RustAdmissionProblem.ShellFiles, detail);
}

/** Why a file at `file` may not be in a web build, by its place and its bytes, or null. */
function placeRefusal(file: string, bytes: Uint8Array): RustBinaryRefusal | null {
  if (file.startsWith(ASSETS_PREFIX)) {
    if (!isWasm(bytes)) return null;
    return rustRefused(NativeRefusal.NotAnExecutable, RustAdmissionProblem.ShellFiles, MESSAGE.ExtraWasm(file));
  }
  if (SHELL_FILES.has(file)) return null;
  return rustRefused(NativeRefusal.NotAnExecutable, RustAdmissionProblem.ShellFiles, MESSAGE.ExtraFile(file));
}

/** Each listed file's bytes, read again without following a link, with its place checked. */
async function readShellFiles(
  dir: string,
  files: readonly string[],
): Promise<Map<string, Uint8Array> | RustBinaryRefusal> {
  const realRoot = await realpath(dir);
  const read = new Map<string, Uint8Array>();
  for (const file of files) {
    const maxBytes = file === RUST_WEB_SHELL_FILES.wasm ? WASM_MAX_BYTES : WEB_FILE_MAX_BYTES;
    const opened = await readBundleFile(dir, file, { realRoot, maxBytes });
    if (!opened.ok) return walkRefusal(opened);
    const refusal = placeRefusal(file, opened.bytes);
    if (refusal) return refusal;
    read.set(file, opened.bytes);
  }
  return read;
}

/**
 * Admits a Rust web build's folder (the shell manifest, M3.5): exactly the shell's files and
 * regular files under `assets/` (none a wasm module), each reached without a link and with no
 * second hard link, and a module {@link admitRustWasm} admits. Answers every file's digest. Reads
 * only; never throws.
 */
export async function admitWebShell(dir: string): Promise<WebShellAdmission> {
  try {
    const walk = await walkBundle(dir);
    if (!walk.ok) return walkRefusal(walk);
    const files = walk.entries.filter((entry) => entry.kind === WalkKind.File).map((entry) => entry.path);
    const read = await readShellFiles(dir, files);
    if (!(read instanceof Map)) return read;
    const missing = REQUIRED_SHELL_FILES.find((file) => !read.has(file));
    if (missing) {
      return rustRefused(NativeRefusal.NotAnExecutable, RustAdmissionProblem.ShellFiles, MESSAGE.MissingFile(missing));
    }
    const module = admitRustWasm(read.get(RUST_WEB_SHELL_FILES.wasm) ?? new Uint8Array());
    if (!module.ok) return module;
    const listed = [...read].map(([path, bytes]) => ({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    }));
    listed.sort((a, b) => (a.path < b.path ? -1 : Number(a.path > b.path)));
    return { ok: true, manifest: { files: listed }, module: module.module };
  } catch (error) {
    return rustRefused(
      NativeRefusal.NotAnExecutable,
      RustAdmissionProblem.ShellFiles,
      MESSAGE.Unreadable(dir, errorMessage(error)),
    );
  }
}

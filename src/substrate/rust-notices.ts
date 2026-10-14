/**
 * The licence notices a Rust · wgpu game's export carries (M3.5), generated per export from two
 * inputs: the admitted `Cargo.lock` closure (every crate the build resolved, but the game's own
 * packages) and the destination's runtime row (what the pinned toolchain links into every binary
 * for that destination: Rust's `std`, `compiler_builtins`, LLVM's compiler-rt, and egui's fonts
 * when the closure compiles them in). Each crate needs a licence entry (`readVendoredLicences`
 * reads them from the vendored crates' manifests and licence files), each row part a licence text
 * (`rustRuntimeSources` reads the store's); a crate without an entry, a destination without a row
 * and a row part without text are each refused, typed, before anything is written. The notices are
 * `native-export.ts` notices: an export writes them with `writeNoticesFolder`.
 *
 * Rows: the Mac, the web, Windows (M4.1: LLVM libunwind and the mingw-w64 runtime, from the
 * store's llvm-mingw) and Linux (M4.2: zig's runtime, which its link adds, and the SwiftShader and
 * Vulkan loader the export ships, from the SwiftShader split's licences) here; iOS and Android
 * (GameActivity's AAR if used) with theirs (M5.1, M5.2). A crate the person approved for the game
 * (the crate request flow, `main/crate-requests.ts`) is in the admitted lock like any other and
 * lives in the profile's vendored overlay: its entry is read by passing the overlay's vendor folder
 * after the store's (`readVendoredLicences([store, overlay])`). The asset importer's wasm
 * decoders run in the studio at import time and ship in no export yet, so no row names them; the
 * part is here for the row that ships one.
 */
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../shared/errors.ts";
import { BuildTarget } from "../shared/game-project.ts";
import { readHostFile } from "./native-bundle.ts";
import { SWIFTSHADER_LICENCES } from "./toolchain-store/swiftshader-bundle.ts";
import { type MacNotice, type NoticeSource, NoticeSourceKind } from "./native-export.ts";

/** The most of a `Cargo.lock` and of one vendored `Cargo.toml` the generator reads. */
const LOCK_MAX_BYTES = 4 * 1024 ** 2;
const MANIFEST_MAX_BYTES = 1024 ** 2;
/** The most licence files one crate contributes. */
const LICENCE_FILES_MAX = 32;
/** A crate's licence files at its root: `LICENSE*`, `LICENCE*`, `COPYING*`, `NOTICE*`. */
const LICENCE_FILE = /^(licen[sc]e|copying|notice)([._-]|$)/i;
/** A crate name and version as a lock may name them: plain names a folder can hold. */
const CRATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CRATE_VERSION = /^[0-9][0-9A-Za-z.+-]{0,63}$/;
/** The sources a closure crate may come from: the registry (vendored by source replacement); a path package has none. */
const REGISTRY_SOURCES = ["registry+", "sparse+"] as const;
/** The crate that compiles egui's default fonts into the HUD. */
const EGUI_FONTS_CRATE = "epaint_default_fonts";
const EGUI_FONTS_FOLDER = "fonts";
const FONT_LICENCE = /\.txt$/i;
/** Where the notices sit under an export's notices folder. */
const CRATES_FOLDER = "rust-crates";
const RUNTIME_FOLDER = "rust-runtime";
const CRATES_INDEX = "CRATES.txt";
/** Where the pinned sysroot keeps the licence texts its components are under. */
const SYSROOT_LICENCES = ["share", "doc", "rust", "licenses"] as const;
const SPDX_TEXT = { Mit: "MIT.txt", Apache: "Apache-2.0.txt", LlvmException: "LLVM-exception.txt" } as const;

/**
 * What the toolchain (or the runtime's own assets) links into a Rust game besides its crates. Every
 * part a destination's row names but egui's fonts is one of `RUST_TOOLCHAIN_RUNTIME`'s names in
 * `scripts/third-party-notices.mjs` (third-party-notices.test.ts holds them together). Never rename a value.
 */
export const RustRuntimePart = {
  Std: "std",
  CompilerBuiltins: "compiler_builtins",
  CompilerRt: "compiler-rt",
  Libunwind: "libunwind",
  MingwCrt: "mingw-w64-crt",
  Winpthreads: "winpthreads",
  SwiftShader: "swiftshader",
  VulkanLoader: "vulkan-loader",
  EguiFonts: "egui-fonts",
  ImporterDecoders: "importer-decoders",
  GameActivity: "game-activity",
  ZigRuntime: "zig-runtime",
} as const;
export type RustRuntimePart = (typeof RustRuntimePart)[keyof typeof RustRuntimePart];

/** Each part as the export's `NOTICES.txt` names it. */
const RUNTIME_TITLE = {
  [RustRuntimePart.Std]: "Rust standard library (std, core, alloc and the crates it builds in): MIT OR Apache-2.0",
  [RustRuntimePart.CompilerBuiltins]: "Rust compiler_builtins: MIT OR Apache-2.0",
  [RustRuntimePart.CompilerRt]: "LLVM compiler-rt builtins: Apache-2.0 WITH LLVM-exception",
  [RustRuntimePart.Libunwind]: "LLVM libunwind: Apache-2.0 WITH LLVM-exception",
  [RustRuntimePart.MingwCrt]: "mingw-w64 C runtime: ZPL-2.1",
  [RustRuntimePart.Winpthreads]: "mingw-w64 winpthreads: MIT",
  [RustRuntimePart.SwiftShader]: "SwiftShader: Apache-2.0",
  [RustRuntimePart.VulkanLoader]: "Vulkan loader: Apache-2.0",
  [RustRuntimePart.EguiFonts]:
    "egui's default fonts (Ubuntu Light, Hack, Noto Emoji, emoji-icon-font): their font licences",
  [RustRuntimePart.ImporterDecoders]: "Asset importer decoders (Basis Universal, Draco, meshoptimizer): their licences",
  [RustRuntimePart.GameActivity]: "Android GameActivity: Apache-2.0",
  [RustRuntimePart.ZigRuntime]: "zig's compiler-rt and C start-up code (linked by zig for glibc 2.28): MIT",
} as const satisfies Record<RustRuntimePart, string>;

/** One part of a destination's row; `whenCrate` limits it to a closure holding that crate. */
export interface RustRuntimeRow {
  part: RustRuntimePart;
  whenCrate?: string;
}

/** What every destination links: Rust's runtime and compiler-rt, and egui's fonts when the HUD is in the closure. */
const CORE_ROW: readonly RustRuntimeRow[] = [
  { part: RustRuntimePart.Std },
  { part: RustRuntimePart.CompilerBuiltins },
  { part: RustRuntimePart.CompilerRt },
  { part: RustRuntimePart.EguiFonts, whenCrate: EGUI_FONTS_CRATE },
];

/**
 * The runtime parts each destination's export carries notices for. A destination without a row is
 * refused (`row-missing`) until its export work package adds it.
 */
export const RUST_NOTICE_ROWS: Partial<Record<BuildTarget, readonly RustRuntimeRow[]>> = {
  [BuildTarget.Mac]: CORE_ROW,
  [BuildTarget.Web]: CORE_ROW,
  // gnullvm with a static C runtime (M4.1): LLVM's libunwind and mingw-w64's CRT start-up and helpers link in.
  [BuildTarget.Windows]: [...CORE_ROW, { part: RustRuntimePart.Libunwind }, { part: RustRuntimePart.MingwCrt }],
  // glibc 2.28 through zig (M4.2): zig's runtime links in, and the export ships SwiftShader and the Vulkan loader.
  [BuildTarget.Linux]: [
    ...CORE_ROW,
    { part: RustRuntimePart.ZigRuntime },
    { part: RustRuntimePart.SwiftShader },
    { part: RustRuntimePart.VulkanLoader },
  ],
  // NativeActivity on bionic (M5.2): Rust's unwinder links the NDK's static LLVM libunwind; no
  // GameActivity AAR is packaged, so its part joins the row only when GameActivity does.
  [BuildTarget.Android]: [...CORE_ROW, { part: RustRuntimePart.Libunwind }],
  // Xcode's clang links the iOS game (M5.1): its compiler-rt builtins and Rust's own runtime; UIKit,
  // Metal and the rest are the system's frameworks, and the app ships no other library.
  [BuildTarget.Ios]: CORE_ROW,
};

/** Why no notices were generated. Wire values (an export's refusal detail): never rename one. */
export const NoticeRefusal = {
  /** The lock is unreadable, names no package, or names one by a name, version or source the generator refuses. */
  LockInvalid: "lock-invalid",
  /** A crate of the closure has no licence entry. */
  CrateUnlicensed: "crate-unlicensed",
  /** The destination has no notices row yet. */
  RowMissing: "row-missing",
  /** A part of the destination's row has no licence text. */
  RuntimeNoticeMissing: "runtime-notice-missing",
} as const;
export type NoticeRefusal = (typeof NoticeRefusal)[keyof typeof NoticeRefusal];

/** One `[[package]]` of a lock: its name, version and source (null for a path package). */
export interface LockedCrate {
  name: string;
  version: string;
  source: string | null;
}

/** One crate's licence: its SPDX expression (or `license-file` note) and the files that hold its text. */
export interface CrateLicence {
  license: string;
  sources: NoticeSource[];
}

/** What one export's notices are generated from. */
export interface RustNoticesRequest {
  target: BuildTarget;
  /** The admitted `Cargo.lock`'s text. */
  lock: string;
  /** The game's own path packages (the game, a workspace's members): first-party, listed in no notice. */
  roots: readonly string[];
  /** Licence entries by {@link crateKey}. */
  licences: ReadonlyMap<string, CrateLicence>;
  /** Licence texts by runtime part. */
  runtime: Partial<Record<RustRuntimePart, readonly NoticeSource[]>>;
}

/** The generated notices, or why none were. */
export type RustNotices = { ok: true; notices: MacNotice[] } | { ok: false; refusal: NoticeRefusal; detail: string };

const MESSAGE = {
  NoPackages: "the lock names no package",
  BadField: (field: string, value: string) => `the lock names a package ${field} ${JSON.stringify(value)}`,
  Missing: (field: string) => `a package of the lock has no ${field}`,
  TooLarge: `the lock is larger than ${LOCK_MAX_BYTES} bytes`,
  Unlicensed: (crates: readonly LockedCrate[]) =>
    `no licence entry for ${crates.map((crate) => `${crate.name} ${crate.version}`).join(", ")}`,
  RowMissing: (target: string) => `the ${target} export has no notices row yet`,
  PartMissing: (part: string) => `no licence text for ${part}`,
  CratesTitle: "Rust crates the game links, each under its own licence (the list is CRATES.txt)",
} as const;

/** The key a licence entry is found by: `name@version`. */
export function crateKey(crate: Pick<LockedCrate, "name" | "version">): string {
  return `${crate.name}@${crate.version}`;
}

/** A field's quoted value in one `[[package]]` block, or null. */
function field(block: string, key: string): string | null {
  return new RegExp(`^${key} = "([^"\\\\]*)"\\s*$`, "m").exec(block)?.[1] ?? null;
}

/** The problem with one package's name, version or source, or null. */
function crateProblem(crate: LockedCrate): string | null {
  if (!CRATE_NAME.test(crate.name)) return MESSAGE.BadField("name", crate.name);
  if (!CRATE_VERSION.test(crate.version)) return MESSAGE.BadField("version", crate.version);
  const registry = crate.source === null || REGISTRY_SOURCES.some((prefix) => crate.source?.startsWith(prefix));
  return registry ? null : MESSAGE.BadField("source", crate.source ?? "");
}

/**
 * Every `[[package]]` of a `Cargo.lock` (version 3 or 4), in lock order. A package is cut at the
 * next table header, so a later table's keys are never read as its fields. Never throws.
 */
export function parseLockClosure(
  text: string,
): { ok: true; crates: LockedCrate[] } | { ok: false; refusal: NoticeRefusal; detail: string } {
  const invalid = (detail: string) => ({ ok: false as const, refusal: NoticeRefusal.LockInvalid, detail });
  if (Buffer.byteLength(text) > LOCK_MAX_BYTES) return invalid(MESSAGE.TooLarge);
  const blocks = text.split(/^\[\[package\]\]\s*$/m).slice(1);
  if (blocks.length === 0) return invalid(MESSAGE.NoPackages);
  const crates: LockedCrate[] = [];
  for (const whole of blocks) {
    const block = whole.split(/^\[/m)[0] ?? "";
    const [name, version] = [field(block, "name"), field(block, "version")];
    if (name === null) return invalid(MESSAGE.Missing("name"));
    if (version === null) return invalid(MESSAGE.Missing("version"));
    const crate = { name, version, source: field(block, "source") };
    const problem = crateProblem(crate);
    if (problem) return invalid(problem);
    crates.push(crate);
  }
  return { ok: true, crates };
}

/** The crates a destination's runtime row applies to, by the closure's names. */
function rowParts(row: readonly RustRuntimeRow[], closure: readonly LockedCrate[]): RustRuntimePart[] {
  const names = new Set(closure.map((crate) => crate.name));
  return row.filter((entry) => entry.whenCrate === undefined || names.has(entry.whenCrate)).map((entry) => entry.part);
}

const compareCrates = (a: LockedCrate, b: LockedCrate): number =>
  a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name);

/** The closure's index notice and one notice per crate with licence files. */
function crateNotices(closure: readonly LockedCrate[], licences: ReadonlyMap<string, CrateLicence>): MacNotice[] {
  const lines: string[] = [];
  const notices: MacNotice[] = [];
  for (const crate of closure) {
    const licence = licences.get(crateKey(crate));
    if (!licence) continue;
    lines.push(`${crate.name} ${crate.version}: ${licence.license}`);
    if (licence.sources.length === 0) continue;
    notices.push({
      folder: `${CRATES_FOLDER}/${crate.name}-${crate.version}`,
      title: `${crate.name} ${crate.version}: ${licence.license}`,
      sources: licence.sources,
    });
  }
  const index: MacNotice = {
    folder: CRATES_FOLDER,
    title: MESSAGE.CratesTitle,
    sources: [{ kind: NoticeSourceKind.Text, name: CRATES_INDEX, text: `${lines.join("\n")}\n` }],
  };
  return [index, ...notices];
}

/**
 * The notices one Rust export carries: the closure's crates (`rust-crates/`, with `CRATES.txt`
 * listing every crate and its licence) and the destination's runtime parts (`rust-runtime/`), or
 * the typed refusal. Pure: the licence texts are read when the export writes them.
 */
export function rustNotices(request: RustNoticesRequest): RustNotices {
  const row = RUST_NOTICE_ROWS[request.target];
  if (!row) return { ok: false, refusal: NoticeRefusal.RowMissing, detail: MESSAGE.RowMissing(request.target) };
  const read = parseLockClosure(request.lock);
  if (!read.ok) return read;
  const closure = read.crates
    .filter((crate) => !(crate.source === null && request.roots.includes(crate.name)))
    .sort(compareCrates);
  const unlicensed = closure.filter((crate) => !request.licences.has(crateKey(crate)));
  if (unlicensed.length > 0) {
    return { ok: false, refusal: NoticeRefusal.CrateUnlicensed, detail: MESSAGE.Unlicensed(unlicensed) };
  }
  const runtime: MacNotice[] = [];
  for (const part of rowParts(row, closure)) {
    const sources = request.runtime[part] ?? [];
    if (sources.length === 0) {
      return { ok: false, refusal: NoticeRefusal.RuntimeNoticeMissing, detail: MESSAGE.PartMissing(part) };
    }
    runtime.push({ folder: `${RUNTIME_FOLDER}/${part}`, title: RUNTIME_TITLE[part], sources: [...sources] });
  }
  return { ok: true, notices: [...crateNotices(closure, request.licences), ...runtime] };
}

/** The plain entries of `dir`, by name; none when it is not a plain folder. */
async function entriesOf(dir: string): Promise<Dirent[]> {
  const info = await lstat(dir).catch(() => null);
  if (!info?.isDirectory()) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));
}

/** The `[package]` table's `key = "value"` in a vendored, cargo-normalized `Cargo.toml`, or null. */
function packageField(manifest: string, key: string): string | null {
  const table = /^\[package\]\s*$/m.exec(manifest);
  if (!table) return null;
  const rest = manifest.slice(table.index + table[0].length);
  const body = rest.split(/^\[/m)[0] ?? "";
  return field(body.replace(/^\s+/gm, ""), key);
}

/** One vendored crate's licence entry, from its folder; null when its manifest names no licence. */
async function vendoredLicence(dir: string): Promise<CrateLicence | null> {
  const manifest = await readHostFile(path.join(dir, "Cargo.toml"), MANIFEST_MAX_BYTES).catch(() => null);
  if (!manifest) return null;
  const text = manifest.toString("utf8");
  const license = packageField(text, "license");
  const licenseFile = packageField(text, "license-file");
  if (license === null && licenseFile === null) return null;
  const files = (await entriesOf(dir)).filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name));
  const sources: NoticeSource[] = files
    .slice(0, LICENCE_FILES_MAX)
    .map((entry) => ({ kind: NoticeSourceKind.File, path: path.join(dir, entry.name) }));
  const named = licenseFile === null ? null : path.basename(licenseFile);
  const extra = named !== null && !files.some((entry) => entry.name === named);
  if (extra) sources.push({ kind: NoticeSourceKind.File, path: path.join(dir, licenseFile ?? "") });
  return { license: license ?? `see ${licenseFile}`, sources };
}

/**
 * The licence entry of each crate found as `<dir>/<name>-<version>/` in one of `vendorDirs` (the
 * store's vendored set, then an overlay): its manifest's `license` (or `license-file`) and its
 * licence files, read without following a link at their names. A crate found nowhere, or whose
 * manifest names no licence, has no entry, so the generator refuses it.
 */
export async function readVendoredLicences(
  vendorDirs: readonly string[],
  crates: readonly LockedCrate[],
): Promise<Map<string, CrateLicence>> {
  const licences = new Map<string, CrateLicence>();
  for (const crate of crates) {
    for (const vendor of vendorDirs) {
      const dir = path.join(vendor, `${crate.name}-${crate.version}`);
      const info = await lstat(dir).catch(() => null);
      if (!info?.isDirectory()) continue;
      const licence = await vendoredLicence(dir).catch((error: unknown) => {
        throw new Error(`${dir}: ${errorMessage(error)}`);
      });
      if (licence) licences.set(crateKey(crate), licence);
      break;
    }
  }
  return licences;
}

/** The files among `names` that exist under `dir` as regular files, as notice sources. */
async function existingFiles(dir: string, names: readonly string[]): Promise<NoticeSource[]> {
  const found: NoticeSource[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if ((await lstat(file).catch(() => null))?.isFile()) found.push({ kind: NoticeSourceKind.File, path: file });
  }
  return found;
}

/** Where llvm-mingw keeps the licences of what it links into a Windows game. */
const LLVM_MINGW_LICENCES = {
  /** The LLVM project's licence (Apache-2.0 WITH LLVM-exception), libunwind's among them. */
  llvm: ["LICENSE.TXT"],
  /** mingw-w64's runtime licences, in the x86-64 target folder. */
  mingw: ["x86_64-w64-mingw32", "share", "mingw32"],
  mingwFiles: ["COPYING.MinGW-w64-runtime.txt", "COPYING.MinGW-w64.txt"],
} as const;

/** libunwind's and the mingw-w64 runtime's licence texts from llvm-mingw; a part whose files are missing is left out. */
async function llvmMingwSources(root: string): Promise<Partial<Record<RustRuntimePart, NoticeSource[]>>> {
  const sources: Partial<Record<RustRuntimePart, NoticeSource[]>> = {};
  const llvm = await existingFiles(root, LLVM_MINGW_LICENCES.llvm);
  if (llvm.length > 0) sources[RustRuntimePart.Libunwind] = llvm;
  const mingw = await existingFiles(path.join(root, ...LLVM_MINGW_LICENCES.mingw), LLVM_MINGW_LICENCES.mingwFiles);
  if (mingw.length > 0) sources[RustRuntimePart.MingwCrt] = mingw;
  return sources;
}

/** zig's own licence, beside its executable in the store's zig folder. */
const ZIG_LICENCE = "LICENSE";

/**
 * The Linux export's runtime licences: zig's (beside the store's `zig`) and the SwiftShader
 * split's (`SWIFTSHADER_LICENCES`, under its folder); a part whose files are missing is left out.
 */
async function linuxSources(store: {
  zig?: string;
  swiftShader?: string;
}): Promise<Partial<Record<RustRuntimePart, NoticeSource[]>>> {
  const sources: Partial<Record<RustRuntimePart, NoticeSource[]>> = {};
  const zig = store.zig === undefined ? [] : await existingFiles(path.dirname(store.zig), [ZIG_LICENCE]);
  if (zig.length > 0) sources[RustRuntimePart.ZigRuntime] = zig;
  if (store.swiftShader === undefined) return sources;
  const swiftShader = await existingFiles(store.swiftShader, SWIFTSHADER_LICENCES.SwiftShader);
  if (swiftShader.length === SWIFTSHADER_LICENCES.SwiftShader.length)
    sources[RustRuntimePart.SwiftShader] = swiftShader;
  const loader = await existingFiles(store.swiftShader, SWIFTSHADER_LICENCES.VulkanLoader);
  if (loader.length === SWIFTSHADER_LICENCES.VulkanLoader.length) sources[RustRuntimePart.VulkanLoader] = loader;
  return sources;
}

/**
 * The licence texts of the parts every destination's row names, from the store: the sysroot's
 * licence folder for `std`, `compiler_builtins` and compiler-rt, and the vendored
 * `epaint_default_fonts`'s font licences for egui's fonts. A part whose files are missing is left
 * out, so the generator refuses a row that needs it.
 */
export async function rustRuntimeSources(store: {
  sysroot: string;
  vendorDirs: readonly string[];
  crates: readonly LockedCrate[];
  /** The store's llvm-mingw, for a Windows export: libunwind's and the mingw-w64 runtime's licences. */
  llvmMingw?: string;
  /** The store's zig executable, for a Linux export: zig's runtime licence. */
  zig?: string;
  /** The SwiftShader split's folder, for a Linux export: SwiftShader's and the Vulkan loader's licences. */
  swiftShader?: string;
}): Promise<Partial<Record<RustRuntimePart, NoticeSource[]>>> {
  const licences = path.join(store.sysroot, ...SYSROOT_LICENCES);
  const rust = await existingFiles(licences, [SPDX_TEXT.Mit, SPDX_TEXT.Apache]);
  const llvm = await existingFiles(licences, [SPDX_TEXT.Apache, SPDX_TEXT.LlvmException]);
  const sources: Partial<Record<RustRuntimePart, NoticeSource[]>> = {};
  if (rust.length === 2) {
    sources[RustRuntimePart.Std] = rust;
    sources[RustRuntimePart.CompilerBuiltins] = rust;
  }
  if (llvm.length === 2) sources[RustRuntimePart.CompilerRt] = llvm;
  if (store.llvmMingw !== undefined) Object.assign(sources, await llvmMingwSources(store.llvmMingw));
  Object.assign(sources, await linuxSources(store));
  const fonts = store.crates.find((crate) => crate.name === EGUI_FONTS_CRATE);
  for (const vendor of fonts ? store.vendorDirs : []) {
    const dir = path.join(vendor, `${EGUI_FONTS_CRATE}-${fonts?.version}`, EGUI_FONTS_FOLDER);
    const texts = (await entriesOf(dir)).filter((entry) => entry.isFile() && FONT_LICENCE.test(entry.name));
    if (texts.length === 0) continue;
    sources[RustRuntimePart.EguiFonts] = texts.map((entry) => ({
      kind: NoticeSourceKind.File,
      path: path.join(dir, entry.name),
    }));
    break;
  }
  return sources;
}

/**
 * Admits a Windows or Linux build's `out/` (the C++ lane's output, cross-built with zig on any
 * host) through the PE or ELF gate, against the lock's store ANGLE: glue over
 * `native-gate-pe.ts` and `native-gate-elf.ts`. The ANGLE folder's `manifest.json` is read first,
 * without following a link and within 1 MiB, and must be the very file the lock pins (its sha256)
 * before anything in `out/` is read; the gates' own pins come from it. Reads only, never writes,
 * and never throws: what cannot be read is not admitted. {@link crossAdmissionFacts} turns the
 * verdict into the facts `native.build` answers the harness.
 *
 * It is also where a Rust · wgpu game's six binaries are admitted (M3.5): {@link admitRustBinary}
 * reads a destination's executable in its format (`RUST_ADMITTED_EXECUTABLES`) through that
 * format's Rust policy (`native-bundle.ts` for the Mac and iOS, `native-gate-pe.ts`,
 * `native-gate-elf.ts` for Linux and Android, `native-gate-wasm.ts`), then scans an export's bytes
 * for the host transport ({@link TRANSPORT_MARKERS}): only a desktop dev build serves the studio, so
 * any other build that carries the transport linked the dev flavour and is refused
 * (`transport-linked`). {@link admitRustOutput} does the same for the executables in a build's
 * `out/`, read without following a link.
 */
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../shared/errors.ts";
import { BuildTarget } from "../shared/game-project.ts";
import {
  ExecutableFormat,
  NATIVE_CROSS_EXECUTABLES,
  type NativeAdmissionFacts,
  NativeRefusal,
  RUST_ADMITTED_EXECUTABLES,
  RustAdmissionProblem,
  type RustBinaryRefusal,
} from "../shared/native-contract.ts";
import { type BundleReads, NODE_BUNDLE_READS, readBundleFile, WalkProblem } from "./bundle-walk.ts";
import { readRegularFile } from "./fsx.ts";
import { admitRustMachO } from "./native-bundle.ts";
import {
  type AdmittedLinuxBundle,
  admitAndroidElf,
  admitLinuxBundle,
  admitRustLinuxElf,
  LINUX_ELF_MAX_BYTES,
  linuxHostFiles,
  readLinuxExecutable,
} from "./native-gate-elf.ts";
import {
  type AdmittedWindowsBundle,
  admitRustPe,
  admitWindowsOutput,
  readWindowsExecutable,
  windowsAnglePins,
} from "./native-gate-pe.ts";
import { admitRustWasm, WASM_MAX_BYTES } from "./native-gate-wasm.ts";

/** The most bytes of a store ANGLE `manifest.json` admission reads. */
export const NATIVE_CROSS_MANIFEST_MAX_BYTES = 1024 * 1024;
const MANIFEST_FILE = "manifest.json";

/** The lock's store ANGLE for a cross destination: its folder, and the sha256 of its `manifest.json` the lock pins. */
export interface CrossAngle {
  dir: string;
  manifestSha256: string;
}

/**
 * The `out/` folder admission read: its real path and its node. A later read of `out/` must find
 * this very folder at its name ({@link outFolderChange}), or a link put there afterwards would
 * have every copy read through it.
 */
export interface OutFolder {
  real: string;
  dev: number;
  ino: number;
}

/** A destination cross-built with zig: Windows x64 or Linux x64. */
export type DesktopTarget = typeof BuildTarget.Windows | typeof BuildTarget.Linux;

/** Whether `target` is a destination cross-built with zig (Windows or Linux), which these gates admit. */
export function isDesktopTarget(target: BuildTarget): target is DesktopTarget {
  return target === BuildTarget.Windows || target === BuildTarget.Linux;
}

/** What makes a file a program on each destination, and the refusal an asset that became one earns. */
const PROGRAM_HEAD = {
  [BuildTarget.Windows]: { magic: [0x4d, 0x5a], refusal: NativeRefusal.ExtraPe },
  [BuildTarget.Linux]: { magic: [0x7f, 0x45, 0x4c, 0x46], refusal: NativeRefusal.ExtraSharedObject },
} as const satisfies Record<DesktopTarget, { magic: readonly number[]; refusal: NativeRefusal }>;

/**
 * The refusal a file of `target`'s build earns when its bytes start as a program there (`MZ`, ELF),
 * or null: an admitted asset read again (a run folder's copy, an export) must not have become one.
 */
export function programRefusal(target: DesktopTarget, head: Uint8Array): NativeRefusal | null {
  const { magic, refusal } = PROGRAM_HEAD[target];
  const starts = head.byteLength >= magic.length && magic.every((byte, index) => head[index] === byte);
  return starts ? refusal : null;
}

/** What {@link admitCrossOutput} admits. */
export interface CrossAdmissionRequest {
  target: DesktopTarget;
  /** The lane's `out/` for the build. */
  out: string;
  angle: CrossAngle;
}

/**
 * Admission's answer: the admitted bundle (the gate's own shape under `windows` or `linux`) with the
 * facts the lane records, or the refusal, the file it was about (relative to `out/`, `.` for the
 * folder itself, `manifest.json` for the ANGLE manifest) and a sentence for logs.
 */
export type CrossAdmission =
  | {
      ok: true;
      target: DesktopTarget;
      out: string;
      /** The folder admitted at `out`: every later read of it starts at `outFolder.real`, after {@link outFolderChange}. */
      outFolder: OutFolder;
      windows?: AdmittedWindowsBundle;
      linux?: AdmittedLinuxBundle;
      /** The game's imports (Windows: import and delay-import DLLs; Linux: `DT_NEEDED`), and its newest glibc. */
      facts: { imports: string[]; maxGlibc: string | null };
    }
  | { ok: false; refusal: NativeRefusal; file: string; detail: string };

type Refused = Extract<CrossAdmission, { ok: false }>;

const MESSAGE = {
  ManifestUnreadable: (dir: string, why: string) => `${dir}/${MANIFEST_FILE} cannot be read: ${why}`,
  ManifestDigest: (dir: string) => `${dir}/${MANIFEST_FILE} is not the manifest the toolchain lock pins`,
  ManifestPins: (dir: string, why: string) => `${dir}/${MANIFEST_FILE} does not pin the host's files: ${why}`,
  NotJson: "not JSON",
  NoWindowsPins: "no sha256 for libEGL.dll, libGLESv2.dll and d3dcompiler_47.dll",
  OutLink: (out: string) => `${out} is a link, not the build's output folder`,
  OutNotAFolder: (out: string) => `${out} is not a folder`,
  OutUnreadable: (out: string, why: string) => `${out} cannot be read: ${why}`,
  OutChanged: (out: string) => `${out} is no longer the folder admission read`,
} as const;

const refused = (refusal: NativeRefusal, file: string, detail: string): Refused => ({
  ok: false,
  refusal,
  file,
  detail,
});
const angleRefused = (detail: string) => refused(NativeRefusal.AngleDigest, MANIFEST_FILE, detail);

/** The store ANGLE's manifest as JSON, or the refusal: unreadable, oversize, a link or another file than the lock's. */
async function pinnedManifest(angle: CrossAngle): Promise<{ json: unknown } | Refused> {
  const file = path.join(angle.dir, MANIFEST_FILE);
  let bytes: Buffer;
  try {
    bytes = await readRegularFile(file, NATIVE_CROSS_MANIFEST_MAX_BYTES);
  } catch (error) {
    return angleRefused(MESSAGE.ManifestUnreadable(angle.dir, errorMessage(error)));
  }
  if (createHash("sha256").update(bytes).digest("hex") !== angle.manifestSha256) {
    return angleRefused(MESSAGE.ManifestDigest(angle.dir));
  }
  try {
    return { json: JSON.parse(bytes.toString("utf8")) as unknown };
  } catch {
    return angleRefused(MESSAGE.ManifestUnreadable(angle.dir, MESSAGE.NotJson));
  }
}

/** `out` as a real folder (not a link to one) with its real path and node, else the refusal; looked at through `reads`. */
async function outFolderOf(out: string, reads: BundleReads): Promise<OutFolder | Refused> {
  try {
    const info = await reads.lstat(out);
    if (info.isSymbolicLink()) return refused(NativeRefusal.Symlink, ".", MESSAGE.OutLink(out));
    if (!info.isDirectory()) return refused(NativeRefusal.NotAnExecutable, ".", MESSAGE.OutNotAFolder(out));
    return { real: await realpath(out), dev: info.dev, ino: info.ino };
  } catch (error) {
    return refused(NativeRefusal.NotAnExecutable, ".", MESSAGE.OutUnreadable(out, errorMessage(error)));
  }
}

/**
 * Null while `out` is still the folder admission read: a real folder, not a link, the same node at
 * the same real path. Else a sentence for logs: whoever reads `out/` again refuses (`symlink`).
 * Every later read starts at `folder.real`, so a link put anywhere above or at `out` afterwards is
 * also refused by the read's own real-path check.
 */
export async function outFolderChange(out: string, folder: OutFolder): Promise<string | null> {
  const info = await lstat(out).catch(() => null);
  const same = info?.isDirectory() === true && info.dev === folder.dev && info.ino === folder.ino;
  if (!same) return MESSAGE.OutChanged(out);
  const real = await realpath(out).catch(() => null);
  return real === folder.real ? null : MESSAGE.OutChanged(out);
}

/** The admitted folder, unless `out` stopped being it while the gate read it. */
async function stillOut(out: string, folder: OutFolder, reads: BundleReads): Promise<Refused | null> {
  const after = await reads.lstat(out).catch(() => null);
  const same = after?.isDirectory() === true && after.dev === folder.dev && after.ino === folder.ino;
  return same ? null : refused(NativeRefusal.Symlink, ".", MESSAGE.OutChanged(out));
}

/** A Windows `out/` through the PE gate, with the pins from the store ANGLE's manifest. */
async function admitWindows(request: CrossAdmissionRequest, json: unknown, reads: BundleReads) {
  const pins = windowsAnglePins(json);
  if (pins === null) return angleRefused(MESSAGE.ManifestPins(request.angle.dir, MESSAGE.NoWindowsPins));
  const outFolder = await outFolderOf(request.out, reads);
  if ("ok" in outFolder) return outFolder;
  const exe = NATIVE_CROSS_EXECUTABLES[BuildTarget.Windows];
  const admission = await admitWindowsOutput(request.out, { exe, pins, reads });
  if (!admission.ok) return refused(admission.refusal, admission.file, admission.detail);
  const changed = await stillOut(request.out, outFolder, reads);
  if (changed) return changed;
  const { image } = admission.bundle.exe;
  const facts = { imports: [...image.imports, ...image.delayImports], maxGlibc: null };
  return { ok: true as const, target: request.target, out: request.out, outFolder, windows: admission.bundle, facts };
}

/** A Linux `out/` through the ELF gate, with the host files from the store ANGLE's manifest. */
async function admitLinux(request: CrossAdmissionRequest, json: unknown, reads: BundleReads) {
  let hostFiles: Record<string, string>;
  try {
    hostFiles = linuxHostFiles(json);
  } catch (error) {
    return angleRefused(MESSAGE.ManifestPins(request.angle.dir, errorMessage(error)));
  }
  const outFolder = await outFolderOf(request.out, reads);
  if ("ok" in outFolder) return outFolder;
  const exe = NATIVE_CROSS_EXECUTABLES[BuildTarget.Linux];
  const admission = await admitLinuxBundle({ root: request.out, exe, hostFiles, reads });
  if (!admission.ok) return refused(admission.refusal, admission.file, admission.detail);
  const changed = await stillOut(request.out, outFolder, reads);
  if (changed) return changed;
  const { bundle } = admission;
  const facts = { imports: [...bundle.image.needed], maxGlibc: bundle.maxGlibc };
  return { ok: true as const, target: request.target, out: request.out, outFolder, linux: bundle, facts };
}

/**
 * Admits a cross build's `out/`: the store ANGLE's `manifest.json` must hash to
 * `angle.manifestSha256` (else `angle-digest`, with no read of `out/`), `out/` must be a real
 * folder, and then the PE gate (Windows: `game.exe`) or the ELF gate (Linux: `game`) decides;
 * `out/` must still be the same folder once the gate is done (its real path and node are kept).
 * `reads` replaces the folder reads of `out/` (a test counts them); it never writes.
 */
export async function admitCrossOutput(
  request: CrossAdmissionRequest,
  reads: BundleReads = NODE_BUNDLE_READS,
): Promise<CrossAdmission> {
  try {
    const manifest = await pinnedManifest(request.angle);
    if ("ok" in manifest) return manifest;
    return request.target === BuildTarget.Windows
      ? await admitWindows(request, manifest.json, reads)
      : await admitLinux(request, manifest.json, reads);
  } catch (error) {
    return refused(NativeRefusal.NotAnExecutable, ".", MESSAGE.OutUnreadable(request.out, errorMessage(error)));
  }
}

/** What a game's executable names, as {@link NativeAdmissionFacts} carries it. */
type GameLinks = Pick<NativeAdmissionFacts, "imports" | "rpaths">;
const NO_LINKS: GameLinks = { imports: [], rpaths: [] };

/** An admitted build's links: the gate's own reading of the very bytes it admitted. */
function admittedLinks(admission: Extract<CrossAdmission, { ok: true }>): GameLinks {
  const rpaths = admission.linux ? [...admission.linux.image.runpath] : [];
  return { imports: [...admission.facts.imports], rpaths };
}

/**
 * A refused build's links, read from its executable so the import or RUNPATH that failed it is
 * named: only when `out` is a real folder (never a link to one), and the executable is read as
 * admission reads a file (no link, no other hard link, within the gate's cap). Anything else
 * names nothing. Never throws.
 */
async function refusedLinks(out: string, target: DesktopTarget): Promise<GameLinks> {
  try {
    const folder = await outFolderOf(out, NODE_BUNDLE_READS);
    if ("ok" in folder) return NO_LINKS;
    const exe = NATIVE_CROSS_EXECUTABLES[target];
    if (target === BuildTarget.Windows) {
      const image = await readWindowsExecutable(out, exe, folder.real);
      return image ? { imports: [...image.imports, ...image.delayImports], rpaths: [] } : NO_LINKS;
    }
    const image = await readLinuxExecutable(out, exe, folder.real);
    return image ? { imports: [...image.needed], rpaths: [...image.runpath] } : NO_LINKS;
  } catch {
    return NO_LINKS;
  }
}

/**
 * The host's facts about a Windows or Linux build's `out/`, as `native.build` answers them:
 * {@link admitCrossOutput}'s verdict against the lock's store ANGLE (its refusal and detail), and
 * the game's imports (Windows: import and delay-import DLL names; Linux: `DT_NEEDED`) and rpaths
 * (Linux: `DT_RUNPATH`; none on Windows) as written, read even when admission refused the build so
 * the failing import is named. Read-only: nothing is assembled, copied or started. Never throws.
 */
export async function crossAdmissionFacts(
  output: string,
  target: DesktopTarget,
  angle: CrossAngle,
  checked?: CrossAdmission,
): Promise<NativeAdmissionFacts> {
  const admission = checked ?? (await admitCrossOutput({ target, out: output, angle }));
  const links = admission.ok ? admittedLinks(admission) : await refusedLinks(output, target);
  return {
    target,
    refusal: admission.ok ? null : admission.refusal,
    detail: admission.ok ? null : admission.detail,
    ...links,
    angleManifestSha256: angle.manifestSha256,
  };
}

/**
 * Byte strings only the host transport (`genex-studio`'s fd 3 and named-pipe code) puts in a
 * binary: its environment variables, the Windows pipe's name prefix and its module's mangled path.
 * genex-studio's verbs (which the web and phone shells use) and genex-core's `GENEX_STUDIO_FD`
 * check carry none of them, so a build that does linked the transport.
 */
export const TRANSPORT_MARKERS: readonly string[] = [
  "GENEX_STUDIO_NONCE",
  "GENEX_STUDIO_PIPE",
  "\\\\.\\pipe\\genex-game-",
  "genex_studio9transport",
];
/** The destinations whose dev build serves the studio over the transport; every other build is an export's flavour. */
export const RUST_STUDIO_SERVED_TARGETS: ReadonlySet<BuildTarget> = new Set([
  BuildTarget.Mac,
  BuildTarget.Windows,
  BuildTarget.Linux,
]);
/** The most bytes of one Rust executable {@link admitRustOutput} reads, by format. */
const RUST_EXECUTABLE_MAX_BYTES = {
  [ExecutableFormat.MachO]: 256 * 1024 ** 2,
  [ExecutableFormat.Pe]: 512 * 1024 ** 2,
  [ExecutableFormat.Elf]: LINUX_ELF_MAX_BYTES,
  [ExecutableFormat.Wasm]: WASM_MAX_BYTES,
} as const satisfies Record<ExecutableFormat, number>;
const TRANSPORT_BYTES = TRANSPORT_MARKERS.map((marker) => Buffer.from(marker, "latin1"));

const RUST_MESSAGE = {
  Transport: (marker: string) =>
    `it carries ${JSON.stringify(marker)}: the host transport (genex-studio's dev flavour), which no export links`,
} as const;

/** The first transport marker in `bytes`, or null. */
export function transportMarkerIn(bytes: Uint8Array): string | null {
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const index = TRANSPORT_BYTES.findIndex((marker) => haystack.includes(marker));
  return index < 0 ? null : (TRANSPORT_MARKERS[index] ?? null);
}

/** One Rust executable to admit: its destination, its bytes, and whether the build serves the studio (a dev build). */
export interface RustBinaryRequest {
  target: BuildTarget;
  bytes: Uint8Array;
  /** The lane linked the dev flavour (Live and judging builds); honoured only on {@link RUST_STUDIO_SERVED_TARGETS}. */
  servesStudio: boolean;
  /** A `[net]` game's export, which links the relay client: its network imports are admitted (Windows: `RUST_WINDOWS_NET_DLLS`). Absent: none. */
  network?: boolean;
}

/** An admitted Rust executable: its format, its sha256 and what it imports (libraries, DLLs, wasm modules). */
export type RustBinaryAdmission =
  | { ok: true; target: BuildTarget; format: ExecutableFormat; sha256: string; imports: string[] }
  | RustBinaryRefusal;

/** The format's Rust policy over `bytes`: the imports it admitted, or its refusal. */
function formatAdmission(
  target: BuildTarget,
  bytes: Uint8Array,
  network: boolean,
): { imports: string[] } | RustBinaryRefusal {
  switch (target) {
    case BuildTarget.Mac:
    case BuildTarget.Ios: {
      const admitted = admitRustMachO(bytes, target);
      return admitted.ok ? { imports: admitted.image.dylibs } : admitted;
    }
    case BuildTarget.Windows: {
      const admitted = admitRustPe(bytes, { network });
      return admitted.ok ? { imports: [...admitted.image.imports, ...admitted.image.delayImports] } : admitted;
    }
    case BuildTarget.Linux:
    case BuildTarget.Android: {
      const admitted = target === BuildTarget.Linux ? admitRustLinuxElf(bytes) : admitAndroidElf(bytes);
      return admitted.ok ? { imports: admitted.image.needed } : admitted;
    }
    default: {
      const admitted = admitRustWasm(bytes);
      return admitted.ok ? { imports: [...new Set(admitted.module.imports.map((entry) => entry.module))] } : admitted;
    }
  }
}

/**
 * Admits one Rust · wgpu executable for its destination (M3.5): the format's policy, then, unless
 * a desktop dev build serves the studio, the transport scan. Pure; never throws.
 */
export function admitRustBinary(request: RustBinaryRequest): RustBinaryAdmission {
  const { target, bytes } = request;
  const admitted = formatAdmission(target, bytes, request.network === true);
  if ("ok" in admitted) return admitted;
  const transportAllowed = request.servesStudio && RUST_STUDIO_SERVED_TARGETS.has(target);
  const marker = transportAllowed ? null : transportMarkerIn(bytes);
  if (marker !== null) {
    return {
      ok: false,
      refusal: NativeRefusal.NotAnExecutable,
      problem: RustAdmissionProblem.TransportLinked,
      detail: RUST_MESSAGE.Transport(marker),
    };
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { ok: true, target, format: RUST_ADMITTED_EXECUTABLES[target].format, sha256, imports: admitted.imports };
}

/** Every executable a Rust build's `out/` was admitted for, by its file name there. */
export type RustOutputAdmission =
  | { ok: true; files: Array<{ file: string } & Extract<RustBinaryAdmission, { ok: true }>> }
  | (RustBinaryRefusal & { file: string });

/** The refusal a file that could not be read as admission reads earns: a link, a hard link, or not there. */
function readRefusal(file: string, problem: WalkProblem, detail: string): RustBinaryRefusal & { file: string } {
  const linked = problem === WalkProblem.Symlink || problem === WalkProblem.Swapped;
  if (linked) return { ok: false, refusal: NativeRefusal.Symlink, problem: RustAdmissionProblem.Link, detail, file };
  if (problem === WalkProblem.HardLink) {
    return { ok: false, refusal: NativeRefusal.HardLink, problem: RustAdmissionProblem.Link, detail, file };
  }
  return { ok: false, refusal: NativeRefusal.NotAnExecutable, problem: RustAdmissionProblem.Unreadable, detail, file };
}

/**
 * Admits each executable `RUST_ADMITTED_EXECUTABLES` names for `target` at the top of a Rust
 * build's `out/`, read without following a link (at its name or above it), never blocking, with
 * no second hard link and within the format's cap, through {@link admitRustBinary}. Reads only;
 * never throws.
 */
export async function admitRustOutput(
  out: string,
  target: BuildTarget,
  options: { servesStudio: boolean },
): Promise<RustOutputAdmission> {
  const entry = RUST_ADMITTED_EXECUTABLES[target];
  const realRoot = await realpath(out).catch(() => null);
  const files: Array<{ file: string } & Extract<RustBinaryAdmission, { ok: true }>> = [];
  for (const file of entry.files) {
    if (realRoot === null) return readRefusal(file, WalkProblem.NotAFolder, MESSAGE.OutNotAFolder(out));
    const read = await readBundleFile(out, file, { realRoot, maxBytes: RUST_EXECUTABLE_MAX_BYTES[entry.format] });
    if (!read.ok) return readRefusal(file, read.problem, read.detail);
    const admitted = admitRustBinary({ target, bytes: read.bytes, servesStudio: options.servesStudio });
    if (!admitted.ok) return { ...admitted, file };
    files.push({ file, ...admitted });
  }
  return { ok: true, files };
}

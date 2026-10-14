/**
 * The Windows and Linux exports (plan §7.7, M4b; D20): a cross build's admitted `out/`, packed as
 * `<Game>-windows-x64.zip` or `<game>-linux-x64.tar.gz` by `native-export-archive.ts`.
 *
 * In order, and nothing is written before the last step:
 * 1. The archive target is checked: an absolute path with no `.`/`..` step, in an existing real
 *    folder (not a link) outside the game and the build's `out/`, with nothing but a regular file
 *    at its name.
 * 2. A signing request is checked as far as it can be before anything is staged: only the person
 *    signs, and only with their own certificate (`windows-sign.ts`).
 * 3. `admitCrossOutput` admits `out/` against the lock's ANGLE; the game's bytes are the very bytes
 *    the PE gate read (Windows), or the ELF gate's executable re-read through its pin and held to
 *    the digest it admitted (Linux).
 * 4. ANGLE's runtime files come from the store, each held to the pin in ANGLE's `manifest.json`
 *    (itself held to the lock's digest); the assets come from `assets/` under the real path
 *    admission recorded for `out/`, while `out/` is still that folder (checked before and after the
 *    walk), each pinned, only files admission listed, and none that starts as a program when packed.
 * 5. The licences: ANGLE's (and SwiftShader's) from ANGLE's manifest, raylib's, GLFW's and
 *    miniaudio's from the store's raylib source, the mingw-w64, LLVM and Zig runtimes' from the
 *    store's zig, the Wayland protocol code's from the Linux sysroot (pinned by its manifest), and
 *    every library the game vendors under `third_party/`. A missing one refuses the export.
 * 6. Windows, when the person chose to sign: the exe and ANGLE's two DLLs (never Microsoft's
 *    compiler) are staged in a folder of their own inside the host-private signing folder (never
 *    beside the archive, which may be in a folder agents write: an agent swapping a staged file
 *    would get its own program signed with the person's certificate), jsign signs them in a
 *    sandbox of its own, and each signed file must be its original plus a signature, the exe
 *    admitted again by the PE gate. The staging folder goes whatever happens.
 * 7. The archive is written to a partial file and renamed over the target; every file is checked
 *    for the credentials Studio holds. Anything the archive does not list (`game.pdb`, import
 *    libraries, the build's own copies of the host files) is left out.
 *
 * Refusals are typed: {@link DesktopExportError} here, `NativeArchiveError` from the archive and
 * the licence reads, `WindowsSignError` from the signing checks.
 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { StudioPlatform } from "../shared/boot.ts";
import { errorMessage } from "../shared/errors.ts";
import { GpuQualification, gpuQualificationOf } from "../shared/game-export-contract.ts";
import { BuildTarget, type CompiledStack, GameStack } from "../shared/game-project.ts";
import { NATIVE_CROSS_EXECUTABLES, NativeRefusal, STACK_CROSS_EXECUTABLES } from "../shared/native-contract.ts";
import { redactValues } from "../shared/redact.ts";
import { readBundleFile } from "./bundle-walk.ts";
import { isJsonObject, readRegularFile, writeNewFile } from "./fsx.ts";
import {
  admitCrossOutput,
  admitRustBinary,
  type CrossAdmission,
  type CrossAdmissionRequest,
  type CrossAngle,
  type DesktopTarget,
  NATIVE_CROSS_MANIFEST_MAX_BYTES,
  outFolderChange,
  programRefusal,
} from "./native-cross-admission.ts";
import {
  ArchiveRefusal,
  type ArchiveSummary,
  type AssetFile,
  type LinuxArchiveInput,
  LinuxRuntimeFile,
  linuxArchiveItems,
  linuxExportName,
  NativeArchiveError,
  NoticeComponent,
  type NoticeText,
  pinnedFile,
  readArchiveContent,
  readAssetTree,
  type RustWindowsArchiveInput,
  rustWindowsArchiveItems,
  type WindowsArchiveInput,
  WindowsRuntimeFile,
  windowsArchiveItems,
  windowsExportName,
  writeLinuxTarGz,
  writeRustWindowsZip,
  writeWindowsZip,
} from "./native-export-archive.ts";
import { type MacNotice, noticesIndex, readNotices } from "./native-export.ts";
import { type AdmittedLinuxBundle, linuxHostFiles } from "./native-gate-elf.ts";
import {
  admitWindowsBundle,
  BundleEntryKind,
  checkWindowsAngleDll,
  type WindowsAnglePins,
  windowsAnglePins,
} from "./native-gate-pe.ts";
import { isInside } from "./paths.ts";
import {
  type JavaProxy,
  type JsignPlan,
  type JsignRun,
  type JsignRunResult,
  jsignPlan,
  jsignPreflight,
  jsignRunRequest,
  type SigningRequester,
  signatureOnlyChange,
  WindowsSignError,
  WindowsSignProblem,
  type WindowsSigningChoice,
  windowsSignTargets,
} from "./windows-sign.ts";

const MIB = 1024 * 1024;
/** The largest store runtime file an export reads (ANGLE's GLES library is about 9 MiB). */
const RUNTIME_FILE_MAX_BYTES = 256 * MIB;
/** The largest licence file an export reads, and the largest Wayland protocol code file. */
const LICENCE_MAX_BYTES = 4 * MIB;
/** miniaudio's licence closes its single 4 MiB header. */
const MINIAUDIO_MAX_BYTES = 16 * MIB;
/** How much of a failed jsign run's error output the refusal quotes. */
const SIGN_ERROR_MAX_CHARS = 2000;
/** Each signed export's own staging folder, inside the host-private signing folder. */
const STAGING_PREFIX = "sign-";
/** The signing folder's mode: the person's only. */
const SIGNING_FOLDER_MODE = 0o700;
/** The staged files' mode: the person's only. */
const STAGED_FILE_MODE = 0o600;
/** The largest Rust Windows executable an export reads (the admission cap for a PE). */
const RUST_EXE_MAX_BYTES = 512 * MIB;
const MANIFEST_FILE = "manifest.json";
const ASSETS_FOLDER = "assets";
const THIRD_PARTY_FOLDER = "third_party";
/** ANGLE's licence files in its manifest, and which of them are SwiftShader's (and its bundled libraries'). */
const ANGLE_LICENCE = /^licenses\/[^/]+$/u;
const SWIFTSHADER_LICENCE = /^licenses\/third_party_SwiftShader[._]/u;
/** wayland-scanner's private code for each protocol GLFW compiles in, in the Linux sysroot. */
const WAYLAND_CODE = /^glfw-wayland\/[^/]+-client-protocol-code\.h$/u;
/** A licence file's name in a vendored library's folder: LICENSE, LICENCE.md, COPYING, NOTICE, LICENSE-MIT and the like. */
const LICENCE_FILE = /^(?:licen[cs]e|copying|unlicense|notice)(?:[-.][A-Za-z0-9.-]*)?$/iu;
/** A control character: never part of an archive path Studio writes. */
const CONTROL = /\p{Cc}/u;
/** Where miniaudio's licence starts, at the end of `miniaudio.h`. */
const MINIAUDIO_LICENCE_START = "This software is available as a choice of the following licenses.";
const COMMENT = /\/\*([\s\S]*?)\*\//gu;
/** What every licence is labelled with, by where it was read: never an absolute path. */
const SOURCE = {
  Angle: "angle",
  Zig: "zig",
  Raylib: "raylib",
  Sysroot: "linux-sysroot",
} as const;

/** The licence files zig's tree holds for each runtime it links into a game, relative to zig's folder. */
const ZIG_LICENCES = {
  [NoticeComponent.MingwRuntime]: ["lib/libc/mingw/COPYING"],
  [NoticeComponent.LlvmRuntime]: ["lib/libcxx/LICENSE.TXT", "lib/libcxxabi/LICENSE.TXT", "lib/libunwind/LICENSE.TXT"],
  [NoticeComponent.ZigRuntime]: ["LICENSE"],
} as const;
type ZigRuntime = keyof typeof ZIG_LICENCES;
/** The zig runtimes each destination links: mingw-w64's C runtime only on Windows. */
const ZIG_RUNTIMES = {
  [BuildTarget.Windows]: [NoticeComponent.MingwRuntime, NoticeComponent.LlvmRuntime, NoticeComponent.ZigRuntime],
  [BuildTarget.Linux]: [NoticeComponent.LlvmRuntime, NoticeComponent.ZigRuntime],
} as const satisfies Record<DesktopTarget, readonly ZigRuntime[]>;
/** raylib's own licence and GLFW's, relative to the raylib source; miniaudio's is cut from its header. */
const RAYLIB_LICENCES = [
  [NoticeComponent.Raylib, "LICENSE"],
  [NoticeComponent.Glfw, "src/external/glfw/LICENSE.md"],
] as const;
const MINIAUDIO_HEADER = "src/external/miniaudio.h";

/** Why a desktop export was refused. Never rename a value. */
export const DesktopExportProblem = {
  /** The archive path is relative, climbs, has no real folder, is inside the game or `out/`, or names a link or folder. */
  Target: "target",
  /** The gate refused the build; `refusal` and `file` say why. */
  NotAdmitted: "not-admitted",
  /** The build's executable is not the one admission read. */
  Changed: "changed",
  /** A store file (an ANGLE runtime file or licence, a manifest, a sysroot file) is missing or not its pin. */
  StoreFile: "store-file",
  /** jsign did not finish or failed. */
  SignFailed: "sign-failed",
  /** A signed file changed more than its signature, or the signed exe no longer passes the PE gate. */
  SignedNotAdmitted: "signed-not-admitted",
} as const;
export type DesktopExportProblem = (typeof DesktopExportProblem)[keyof typeof DesktopExportProblem];

/** A refused desktop export: its problem, the gate's refusal when a gate refused, and the file it is about. */
export class DesktopExportError extends Error {
  readonly code: DesktopExportProblem;
  readonly refusal: NativeRefusal | null;
  readonly file: string | null;

  constructor(
    code: DesktopExportProblem,
    message: string,
    detail: { refusal?: NativeRefusal | null; file?: string | null } = {},
  ) {
    super(message);
    this.name = "DesktopExportError";
    this.code = code;
    this.refusal = detail.refusal ?? null;
    this.file = detail.file ?? null;
  }
}

const MESSAGE = {
  Target: (archive: string, why: string) => `The export cannot be written to ${JSON.stringify(archive)}: ${why}.`,
  Why: {
    NotAbsolute: "it is not a full path",
    Climbs: "it has a . or .. step",
    NoFolder: "its folder does not exist or is a link",
    Inside: "it is inside the game or its build",
    NotAFile: "a link or folder is at that name",
  },
  NotAdmitted: (detail: string) => `The build was not admitted: ${detail}`,
  Changed: (file: string) => `The build's ${file} changed after it was admitted; build again, then export.`,
  OutChanged: (detail: string) => `The build changed after it was admitted (${detail}); build again, then export.`,
  BecameProgram: (file: string) =>
    `The build's ${file} became a program after it was admitted; build again, then export.`,
  StoreFile: (file: string, why: string) => `The toolchain store's ${file} cannot be used: ${why}`,
  NotPinned: "it is not the file its manifest pins",
  NoPin: "its manifest pins no such file",
  ManifestDigest: "it is not the manifest the toolchain lock pins",
  NotJson: "it is not a JSON object",
  NoLicence: (source: string) => `${source} is missing or cannot be read`,
  NoLicenceBlock: (source: string) => `${source} holds no licence text`,
  NoLibraryLicence: (library: string) => `${library} has no licence file (LICENSE, COPYING or NOTICE) beside its code`,
  NotAFolder: (folder: string) => `${folder} is a link or a file, not a folder`,
  SignFailed: (why: string) => `jsign could not sign the export: ${why}`,
  TimedOut: "it ran out of time",
  Exit: (code: number | null, stderr: string) => `it exited ${code ?? "on a signal"}${stderr ? `: ${stderr}` : ""}`,
  SignedChanged: (file: string) => `${file} changed more than its signature while it was being signed`,
  SignedRefused: (detail: string) => `the signed executable is no longer admitted: ${detail}`,
  SigningFolder: (folder: string) => `the signing folder ${folder} is a link or not a folder`,
  NotAdmittedBuild: (file: string) => `${file} is not a file the build admitted; build again, then export.`,
} as const;

/** What both exports take. */
interface DesktopExportRequest {
  /** The game's title: the archive's folder and executable names come from it. */
  title: string;
  /** The game's folder: its `third_party/` licences are read, and the archive must be outside it. */
  game: string;
  /** The lane's `out/` for the build. */
  out: string;
  /** The lock's store ANGLE for the destination. */
  angle: CrossAngle;
  /** The store's zig folder (its `LICENSE` and `lib/`). */
  zig: string;
  /** The store's raylib source folder. */
  raylib: string;
  /** The archive file to write: in an existing real folder outside the game and `out/`. */
  archive: string;
  builtOn: StudioPlatform;
  /** Whether Genex ran this build on its destination; false adds the honest "not run" line. */
  ranOnTarget: boolean;
  /** The credential values Studio holds: one in any exported file refuses the export. */
  secretValues: Iterable<string>;
}

/** The Windows export, optionally signed with the person's own certificate. */
export interface WindowsExportRequest extends DesktopExportRequest {
  signing?: { requester: SigningRequester; choice: WindowsSigningChoice };
}

/** The Linux export: it also needs the Linux sysroot, for the Wayland protocol code's licences. */
export interface LinuxExportRequest extends DesktopExportRequest {
  sysroot: CrossAngle;
}

/** Admission, replaceable in tests (default: `admitCrossOutput`). */
type Admit = (request: CrossAdmissionRequest) => Promise<CrossAdmission>;

/** What the Linux export is given besides its request. */
export interface LinuxExportDeps {
  admit?: Admit;
}

/** What the Windows export is given besides its request: how jsign is launched and run. */
export interface WindowsExportDeps extends LinuxExportDeps {
  /**
   * jsign's launcher, the folders a keystore may never come from, the sandbox's proxy when known,
   * and the host-private folder the files to sign are staged in (`layout.signing`: no agent process
   * may write it, so none can swap a file between staging and signing).
   */
  jsign?: {
    tool: { file: string; args: readonly string[] };
    forbiddenRoots: readonly string[];
    proxy?: JavaProxy;
    stagingRoot: string;
  };
  /** Runs one jsign request in jsign's own sandbox (`jsignSandboxOptions`) and redacts its output (`runJsign`). */
  runSigned?: (run: JsignRun) => Promise<JsignRunResult>;
}

/** A written export: the archive, its folder and executable name, whether it is signed, and every licence source. */
export interface DesktopExport {
  target: DesktopTarget;
  name: string;
  archive: ArchiveSummary;
  signed: boolean;
  notices: string[];
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// ---------- the target ----------

/** Refuses an archive path that is not a plain new or regular file in a real folder outside every input. */
async function checkArchiveTarget(archive: string, inputs: readonly string[]): Promise<void> {
  const refuse = (why: string) => new DesktopExportError(DesktopExportProblem.Target, MESSAGE.Target(archive, why));
  if (!path.isAbsolute(archive) || CONTROL.test(archive)) throw refuse(MESSAGE.Why.NotAbsolute);
  if (archive.split(/[\\/]/u).some((step) => step === "." || step === "..")) throw refuse(MESSAGE.Why.Climbs);
  const parent = path.dirname(archive);
  const folder = await lstat(parent).catch(() => null);
  if (!folder?.isDirectory()) throw refuse(MESSAGE.Why.NoFolder);
  const existing = await lstat(archive).catch(() => null);
  if (existing && !existing.isFile()) throw refuse(MESSAGE.Why.NotAFile);
  const realParent = await realpath(parent);
  for (const input of inputs) {
    const realInput = await realpath(input).catch(() => path.resolve(input));
    if (isInside(realInput, realParent)) throw refuse(MESSAGE.Why.Inside);
  }
}

// ---------- admission and the store ----------

type Admitted = Extract<CrossAdmission, { ok: true }>;

async function admitted(request: DesktopExportRequest, target: DesktopTarget, admit: Admit): Promise<Admitted> {
  const admission = await admit({ target, out: request.out, angle: request.angle });
  if (admission.ok) return admission;
  throw new DesktopExportError(DesktopExportProblem.NotAdmitted, MESSAGE.NotAdmitted(admission.detail), {
    refusal: admission.refusal,
    file: admission.file,
  });
}

/** A store folder's `manifest.json`, held to its pin, with its `files` map. */
interface PinnedManifest {
  folder: CrossAngle;
  json: Record<string, unknown>;
  files: Record<string, unknown>;
  /** The refusal a file of this folder that is not its pin earns (ANGLE's: `angle-digest`). */
  refusal: NativeRefusal | null;
}

const storeError = (file: string, why: string, refusal: NativeRefusal | null) =>
  new DesktopExportError(DesktopExportProblem.StoreFile, MESSAGE.StoreFile(file, why), { refusal, file });

/** A store folder's manifest, read without following a link, within 1 MiB, and only if it is the pinned one. */
async function pinnedManifest(folder: CrossAngle, refusal: NativeRefusal | null): Promise<PinnedManifest> {
  const bytes = await readRegularFile(path.join(folder.dir, MANIFEST_FILE), NATIVE_CROSS_MANIFEST_MAX_BYTES).catch(
    (error: unknown) => {
      throw storeError(MANIFEST_FILE, errorMessage(error), refusal);
    },
  );
  if (sha256(bytes) !== folder.manifestSha256) throw storeError(MANIFEST_FILE, MESSAGE.ManifestDigest, refusal);
  let json: unknown = null;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    json = null;
  }
  if (!isJsonObject(json)) throw storeError(MANIFEST_FILE, MESSAGE.NotJson, refusal);
  const files = isJsonObject(json.files) ? json.files : {};
  return { folder, json, files, refusal };
}

/** The digest a manifest pins for `rel`, or null. */
function pinOf(manifest: PinnedManifest, rel: string): string | null {
  const entry = Object.hasOwn(manifest.files, rel) ? manifest.files[rel] : null;
  const digest = isJsonObject(entry) ? entry.sha256 : null;
  return typeof digest === "string" ? digest : null;
}

/** A store file's bytes, read without following a link, held to `digest`. */
async function storeBytes(
  manifest: PinnedManifest,
  rel: string,
  digest: string | null,
  maxBytes: number,
): Promise<Buffer> {
  if (digest === null) throw storeError(rel, MESSAGE.NoPin, manifest.refusal);
  const bytes = await readRegularFile(path.join(manifest.folder.dir, ...rel.split("/")), maxBytes).catch(
    (error: unknown) => {
      throw storeError(rel, errorMessage(error), manifest.refusal);
    },
  );
  if (sha256(bytes) !== digest) throw storeError(rel, MESSAGE.NotPinned, manifest.refusal);
  return bytes;
}

/** ANGLE's three Windows DLLs from the store, each its pin and an x64 DLL that imports no desktop OpenGL. */
async function windowsRuntime(manifest: PinnedManifest): Promise<{
  runtime: Record<WindowsRuntimeFile, Buffer>;
  pins: WindowsAnglePins;
}> {
  const pins = windowsAnglePins(manifest.json);
  if (pins === null) throw storeError(MANIFEST_FILE, MESSAGE.NoPin, NativeRefusal.AngleDigest);
  const read = async (name: WindowsRuntimeFile): Promise<Buffer> => {
    const bytes = await storeBytes(manifest, name, pins[name], RUNTIME_FILE_MAX_BYTES);
    const problem = checkWindowsAngleDll(name, bytes, pins);
    if (problem) throw storeError(name, problem.detail, problem.refusal);
    return bytes;
  };
  const runtime = {
    [WindowsRuntimeFile.Egl]: await read(WindowsRuntimeFile.Egl),
    [WindowsRuntimeFile.Gles]: await read(WindowsRuntimeFile.Gles),
    [WindowsRuntimeFile.D3dCompiler]: await read(WindowsRuntimeFile.D3dCompiler),
  };
  return { runtime, pins };
}

/** ANGLE's Linux runtime files (with the Vulkan loader and SwiftShader) from the store, each its pin. */
async function linuxRuntime(manifest: PinnedManifest): Promise<Record<LinuxRuntimeFile, Buffer>> {
  let pins: Record<string, string>;
  try {
    pins = linuxHostFiles(manifest.json);
  } catch (error) {
    throw storeError(MANIFEST_FILE, errorMessage(error), NativeRefusal.AngleDigest);
  }
  const read = (name: LinuxRuntimeFile) =>
    storeBytes(manifest, name, Object.hasOwn(pins, name) ? pins[name] : null, RUNTIME_FILE_MAX_BYTES);
  return {
    [LinuxRuntimeFile.Egl]: await read(LinuxRuntimeFile.Egl),
    [LinuxRuntimeFile.Gles]: await read(LinuxRuntimeFile.Gles),
    [LinuxRuntimeFile.VulkanLoader]: await read(LinuxRuntimeFile.VulkanLoader),
    [LinuxRuntimeFile.SwiftShader]: await read(LinuxRuntimeFile.SwiftShader),
    [LinuxRuntimeFile.SwiftShaderIcd]: await read(LinuxRuntimeFile.SwiftShaderIcd),
  };
}

/** The Linux game's bytes: re-read through a pin and held to the digest the ELF gate admitted. */
async function admittedLinuxExe(bundle: AdmittedLinuxBundle): Promise<Buffer> {
  const bytes = await readArchiveContent(await pinnedFile(bundle.exePath, bundle.exe), bundle.exe);
  if (sha256(bytes) === bundle.exeSha256) return bytes;
  throw new DesktopExportError(DesktopExportProblem.Changed, MESSAGE.Changed(bundle.exe), { file: bundle.exe });
}

/** Refuses (`changed`, `symlink`) unless `out/` is still the folder admission read. */
async function requireAdmittedOut(request: DesktopExportRequest, admission: Admitted): Promise<void> {
  const changed = await outFolderChange(request.out, admission.outFolder);
  if (changed === null) return;
  throw new DesktopExportError(DesktopExportProblem.Changed, MESSAGE.OutChanged(changed), {
    refusal: NativeRefusal.Symlink,
    file: ".",
  });
}

/** The paths below the top-level assets folder (in any capitals) that admission listed. */
function admittedAssetPaths(admission: Admitted): Set<string> {
  const files = admission.windows?.assets ?? admission.linux?.files ?? [];
  const below = files.flatMap((file) => {
    const slash = file.indexOf("/");
    return slash > 0 && file.slice(0, slash).toLowerCase() === ASSETS_FOLDER ? [file.slice(slash + 1)] : [];
  });
  return new Set(below);
}

/**
 * The assets to pack: `assets/` under the real path admission recorded for `out/`, walked while
 * `out/` is still that folder (before and after), each file pinned and one admission listed.
 */
async function admittedAssets(request: DesktopExportRequest, admission: Admitted): Promise<AssetFile[]> {
  await requireAdmittedOut(request, admission);
  const assets = await readAssetTree(path.join(admission.outFolder.real, ASSETS_FOLDER));
  await requireAdmittedOut(request, admission);
  const listed = admittedAssetPaths(admission);
  const extra = assets.find((asset) => !listed.has(asset.path));
  if (!extra) return assets;
  const file = `${ASSETS_FOLDER}/${extra.path}`;
  throw new DesktopExportError(DesktopExportProblem.Changed, MESSAGE.Changed(file), { file });
}

/** The archive's look at each file it packs: an asset whose packed bytes start as a program refuses the export. */
function assetInspector(target: DesktopTarget, name: string): (entry: string, data: Buffer) => void {
  const prefix = `${name}/${ASSETS_FOLDER}/`;
  return (entry, data) => {
    if (!entry.startsWith(prefix)) return;
    const refusal = programRefusal(target, data);
    if (refusal === null) return;
    const file = `${ASSETS_FOLDER}/${entry.slice(prefix.length)}`;
    throw new DesktopExportError(DesktopExportProblem.Changed, MESSAGE.BecameProgram(file), { refusal, file });
  };
}

// ---------- licences ----------

const missingNotice = (message: string, cause?: unknown) =>
  new NativeArchiveError(ArchiveRefusal.MissingNotice, message, cause);

/** A licence file's text, read without following a link at its name; missing or unreadable refuses the export. */
async function licenceText(file: string, source: string, maxBytes = LICENCE_MAX_BYTES): Promise<string> {
  const bytes = await readRegularFile(file, maxBytes).catch((error: unknown) => {
    throw missingNotice(MESSAGE.NoLicence(source), error);
  });
  return bytes.toString("utf8");
}

/** ANGLE's licences from its pinned manifest: SwiftShader's under its own heading. */
async function angleNotices(manifest: PinnedManifest): Promise<NoticeText[]> {
  const notices: NoticeText[] = [];
  for (const rel of Object.keys(manifest.files)
    .filter((key) => ANGLE_LICENCE.test(key))
    .sort(byBytes)) {
    const bytes = await storeBytes(manifest, rel, pinOf(manifest, rel), LICENCE_MAX_BYTES);
    const component = SWIFTSHADER_LICENCE.test(rel) ? NoticeComponent.SwiftShader : NoticeComponent.Angle;
    notices.push({ component, source: `${SOURCE.Angle}/${rel}`, text: bytes.toString("utf8") });
  }
  return notices;
}

/** The licences of the runtimes zig links into a game for `target`. */
async function zigNotices(zig: string, target: DesktopTarget): Promise<NoticeText[]> {
  const notices: NoticeText[] = [];
  for (const component of ZIG_RUNTIMES[target]) {
    for (const rel of ZIG_LICENCES[component]) {
      const source = `${SOURCE.Zig}/${rel}`;
      notices.push({ component, source, text: await licenceText(path.join(zig, ...rel.split("/")), source) });
    }
  }
  return notices;
}

/** miniaudio's licence: the closing comment of its header, from its first line to the comment's end. */
function miniaudioLicence(header: string, source: string): string {
  const start = header.lastIndexOf(MINIAUDIO_LICENCE_START);
  if (start < 0) throw missingNotice(MESSAGE.NoLicenceBlock(source));
  const end = header.indexOf("*/", start);
  return header.slice(start, end < 0 ? undefined : end);
}

/** raylib's, GLFW's and miniaudio's licences from the store's raylib source. */
async function raylibNotices(raylib: string): Promise<NoticeText[]> {
  const notices: NoticeText[] = [];
  for (const [component, rel] of RAYLIB_LICENCES) {
    const source = `${SOURCE.Raylib}/${rel}`;
    notices.push({ component, source, text: await licenceText(path.join(raylib, ...rel.split("/")), source) });
  }
  const source = `${SOURCE.Raylib}/${MINIAUDIO_HEADER}`;
  const header = await licenceText(path.join(raylib, ...MINIAUDIO_HEADER.split("/")), source, MINIAUDIO_MAX_BYTES);
  notices.push({ component: NoticeComponent.Miniaudio, source, text: miniaudioLicence(header, source) });
  return notices;
}

/** The copyright comment wayland-scanner copies from a protocol into its code, without the comment's ` * `. */
function protocolCopyright(code: string): string | null {
  for (const match of code.matchAll(COMMENT)) {
    const body = match[1] ?? "";
    if (!body.includes("Copyright")) continue;
    return body
      .split("\n")
      .map((line) => line.replace(/^\s*\* ?/u, ""))
      .join("\n")
      .trim();
  }
  return null;
}

/** The Wayland protocol code's licences, from the pinned Linux sysroot's `glfw-wayland/` files. */
async function waylandNotices(sysroot: CrossAngle): Promise<NoticeText[]> {
  const manifest = await pinnedManifest(sysroot, null);
  const notices: NoticeText[] = [];
  for (const rel of Object.keys(manifest.files)
    .filter((key) => WAYLAND_CODE.test(key))
    .sort(byBytes)) {
    const source = `${SOURCE.Sysroot}/${rel}`;
    const bytes = await storeBytes(manifest, rel, pinOf(manifest, rel), LICENCE_MAX_BYTES);
    const text = protocolCopyright(bytes.toString("utf8"));
    if (text === null) throw missingNotice(MESSAGE.NoLicenceBlock(source));
    notices.push({ component: NoticeComponent.WaylandProtocols, source, text });
  }
  return notices;
}

/** A folder's entries, or none when it is missing; refused when it is a link or a file. */
async function folderEntries(dir: string, label: string): Promise<Dirent[]> {
  const info = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw missingNotice(MESSAGE.NoLicence(label), error);
  });
  if (info === null) return [];
  if (!info.isDirectory()) throw new NativeArchiveError(ArchiveRefusal.NotARegularFile, MESSAGE.NotAFolder(label));
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => !entry.name.startsWith(".")).sort((a, b) => byBytes(a.name, b.name));
}

/** One vendored library's licence files; a library without one refuses the export. */
async function libraryNotices(dir: string, label: string): Promise<NoticeText[]> {
  const licences = (await folderEntries(dir, label)).filter((entry) => LICENCE_FILE.test(entry.name));
  if (licences.length === 0) throw missingNotice(MESSAGE.NoLibraryLicence(label));
  const notices: NoticeText[] = [];
  for (const licence of licences) {
    const source = `${label}/${licence.name}`;
    const text = await licenceText(path.join(dir, licence.name), source);
    notices.push({ component: NoticeComponent.GameThirdParty, source, text });
  }
  return notices;
}

/** Every library the game vendors under `third_party/<name>/`, with its licence; files beside them are not libraries. */
async function thirdPartyNotices(game: string): Promise<NoticeText[]> {
  const root = path.join(game, THIRD_PARTY_FOLDER);
  const notices: NoticeText[] = [];
  for (const entry of await folderEntries(root, THIRD_PARTY_FOLDER)) {
    const label = `${THIRD_PARTY_FOLDER}/${entry.name}`;
    if (entry.isFile()) continue;
    if (!entry.isDirectory()) throw new NativeArchiveError(ArchiveRefusal.NotARegularFile, MESSAGE.NotAFolder(label));
    notices.push(...(await libraryNotices(path.join(root, entry.name), label)));
  }
  return notices;
}

/** One notice per component and text: identical licences (libc++abi's and libunwind's) are listed once, naming both. */
function mergedNotices(notices: readonly NoticeText[]): NoticeText[] {
  const merged = new Map<string, { component: NoticeComponent; text: string; sources: string[] }>();
  for (const notice of notices) {
    const key = `${notice.component}\0${notice.text.trim()}`;
    const known = merged.get(key);
    if (known) known.sources.push(notice.source);
    else merged.set(key, { component: notice.component, text: notice.text, sources: [notice.source] });
  }
  return [...merged.values()].map(({ component, text, sources }) => ({
    component,
    text,
    source: sources.sort(byBytes).join(", "),
  }));
}

/** Every licence a destination's archive carries, and the sources they were read from. */
async function desktopNotices(
  target: DesktopTarget,
  request: DesktopExportRequest,
  angle: PinnedManifest,
  sysroot: CrossAngle | null,
): Promise<{ texts: NoticeText[]; sources: string[] }> {
  const all = [
    ...(await angleNotices(angle)),
    ...(await raylibNotices(request.raylib)),
    ...(await zigNotices(request.zig, target)),
    ...(sysroot ? await waylandNotices(sysroot) : []),
    ...(await thirdPartyNotices(request.game)),
  ];
  return { texts: mergedNotices(all), sources: all.map((notice) => notice.source).sort(byBytes) };
}

// ---------- signing ----------

/** The checked signing request: who asked, what they chose and how jsign runs. */
interface Signer {
  requester: SigningRequester;
  choice: WindowsSigningChoice;
  host: StudioPlatform;
  jsign: NonNullable<WindowsExportDeps["jsign"]>;
  runSigned: NonNullable<WindowsExportDeps["runSigned"]>;
  forbiddenRoots: string[];
}

/** No jsign launcher: the checks refuse it (`tool`) after the harness rule. */
const NO_TOOL = { file: "", args: [] } as const;

/**
 * The signing request checked before anything is read or staged, or null for an unsigned export:
 * the harness is refused first, then every field, then a key on hardware (the sandbox has no
 * smart-card access), then a missing jsign. A keystore never comes from the game or its build.
 */
async function signingPreflight(
  request: Pick<WindowsExportRequest, "signing" | "game" | "out" | "builtOn">,
  name: string,
  deps: WindowsExportDeps,
): Promise<Signer | null> {
  if (!request.signing) return null;
  const { requester, choice } = request.signing;
  const forbiddenRoots = [...(deps.jsign?.forbiddenRoots ?? []), request.game, request.out];
  const tool = deps.jsign?.tool ?? NO_TOOL;
  const host = request.builtOn;
  const preflight = await jsignPreflight({
    choice,
    requestedBy: requester,
    host,
    tool,
    programName: name,
    forbiddenRoots,
  });
  if (preflight === null) return null;
  if (preflight.hardwareToken) throw new WindowsSignError(WindowsSignProblem.HardwareToken);
  if (!deps.jsign || !deps.runSigned) throw new WindowsSignError(WindowsSignProblem.Tool);
  return { requester, choice, host, jsign: deps.jsign, runSigned: deps.runSigned, forbiddenRoots };
}

/** The bytes the export signs, in the order `windowsSignTargets` names their files. */
interface Unsigned {
  exe: Buffer;
  egl: Buffer;
  gles: Buffer;
}

/**
 * The files a stack's Windows export signs, staged in `staging`, in order with the game first: a
 * raylib game's exe and ANGLE's two DLLs (never Microsoft's compiler), a Rust game's exe alone (it
 * ships no DLL).
 */
const WINDOWS_SIGN_LIST = {
  [GameStack.RaylibCpp]: (staging: string, exeName: string) => windowsSignTargets(staging, exeName),
  [GameStack.RustWgpu]: (staging: string, exeName: string) => [path.join(staging, exeName)],
} as const satisfies Record<CompiledStack, (staging: string, exeName: string) => string[]>;

/** The checked jsign plan for `bytes` staged in `staging` under the stack's sign list, in its order. */
async function stagedPlan(
  staging: string,
  exeName: string,
  bytes: readonly Buffer[],
  signer: Signer,
  stack: CompiledStack,
): Promise<JsignPlan> {
  const targets = WINDOWS_SIGN_LIST[stack](staging, exeName);
  for (const [index, file] of targets.entries()) await writeNewFile(file, bytes[index], STAGED_FILE_MODE);
  const plan = await jsignPlan({
    choice: signer.choice,
    requestedBy: signer.requester,
    host: signer.host,
    tool: signer.jsign.tool,
    programName: path.basename(exeName, ".exe"),
    stagingDir: staging,
    targets,
    forbiddenRoots: signer.forbiddenRoots,
  });
  if (plan === null) throw new WindowsSignError(WindowsSignProblem.Tool);
  return plan;
}

const signFailed = (why: string) => new DesktopExportError(DesktopExportProblem.SignFailed, MESSAGE.SignFailed(why));

/** Runs jsign on the staged plan; a timeout or failure refuses with its error output, the password redacted. */
async function runPlan(plan: JsignPlan, signer: Signer): Promise<void> {
  const result = await signer
    .runSigned(jsignRunRequest(plan, { proxy: signer.jsign.proxy }))
    .catch((error: unknown) => {
      throw signFailed(redactValues(errorMessage(error), plan.secretValues));
    });
  if (result.timedOut) throw signFailed(MESSAGE.TimedOut);
  if (result.code === 0) return;
  const stderr = redactValues(result.stderr.trim(), plan.secretValues).slice(-SIGN_ERROR_MAX_CHARS);
  throw signFailed(MESSAGE.Exit(result.code, stderr));
}

const signedRefused = (message: string, refusal: NativeRefusal | null = null, file: string | null = null) =>
  new DesktopExportError(DesktopExportProblem.SignedNotAdmitted, MESSAGE.SignFailed(message), { refusal, file });

/** The signed files read back, each its original plus a signature, the exe admitted again by the PE gate. */
async function signedBytes(plan: JsignPlan, unsigned: Unsigned, pins: WindowsAnglePins): Promise<Unsigned> {
  const originals = [unsigned.exe, unsigned.egl, unsigned.gles];
  const signed: Buffer[] = [];
  for (const [index, file] of plan.targets.entries()) {
    const label = path.basename(file);
    const bytes = await readRegularFile(file, RUNTIME_FILE_MAX_BYTES).catch((error: unknown) => {
      throw signedRefused(errorMessage(error), null, label);
    });
    if (!signatureOnlyChange(originals[index], bytes)) throw signedRefused(MESSAGE.SignedChanged(label), null, label);
    signed.push(bytes);
  }
  const [exe, egl, gles] = signed;
  const game = NATIVE_CROSS_EXECUTABLES[BuildTarget.Windows];
  const entry = { path: game, kind: BundleEntryKind.File, links: 1, bytes: exe, whole: true };
  const again = admitWindowsBundle([entry], { exe: game, pins });
  if (!again.ok) throw signedRefused(MESSAGE.SignedRefused(again.detail), again.refusal, game);
  return { exe, egl, gles };
}

/** A new staging folder of this export's own inside the signing folder, which must be a real folder (made if missing). */
async function stagingFolder(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: SIGNING_FOLDER_MODE });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw signFailed(MESSAGE.SigningFolder(root));
  return mkdtemp(path.join(await realpath(root), STAGING_PREFIX));
}

/** Stages, signs, checks and zips the signed files; the staging folder goes whatever happens. */
async function signedZip(
  request: WindowsExportRequest,
  input: WindowsArchiveInput,
  unsigned: Unsigned,
  context: { signer: Signer; pins: WindowsAnglePins; secretValues: string[] },
): Promise<ArchiveSummary> {
  const staging = await stagingFolder(context.signer.jsign.stagingRoot);
  try {
    const files = [unsigned.exe, unsigned.egl, unsigned.gles];
    const plan = await stagedPlan(staging, `${input.name}.exe`, files, context.signer, GameStack.RaylibCpp);
    await runPlan(plan, context.signer);
    const signed = await signedBytes(plan, unsigned, context.pins);
    const runtime = {
      ...input.runtime,
      [WindowsRuntimeFile.Egl]: { bytes: signed.egl },
      [WindowsRuntimeFile.Gles]: { bytes: signed.gles },
    };
    const signedInput = { ...input, executable: { bytes: signed.exe }, runtime, signed: true };
    return await writeWindowsZip(request.archive, signedInput, {
      secretValues: [...context.secretValues, ...plan.secretValues],
      inspect: assetInspector(BuildTarget.Windows, input.name),
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// ---------- the exports ----------

const contentOf = (bytes: Buffer) => ({ bytes });

/**
 * Exports a Windows cross build as `<Game>/` in a zip at `request.archive`: the admitted exe,
 * ANGLE's D3D11 DLLs and Microsoft's shader compiler from the store, the assets, the licences, a
 * README and `SHA256SUMS`; signed with the person's own certificate only when they chose it. A
 * refusal throws a typed error and leaves nothing behind.
 */
export async function exportWindowsZip(
  request: WindowsExportRequest,
  deps: WindowsExportDeps = {},
): Promise<DesktopExport> {
  await checkArchiveTarget(request.archive, [request.game, request.out]);
  const name = windowsExportName(request.title);
  const signer = await signingPreflight(request, name, deps);
  const admission = await admitted(request, BuildTarget.Windows, deps.admit ?? admitCrossOutput);
  if (!admission.windows) throw new DesktopExportError(DesktopExportProblem.NotAdmitted, MESSAGE.NotAdmitted("."));
  const exe = Buffer.from(admission.windows.exe.bytes);
  const angle = await pinnedManifest(request.angle, NativeRefusal.AngleDigest);
  const { runtime, pins } = await windowsRuntime(angle);
  const assets = await admittedAssets(request, admission);
  const notices = await desktopNotices(BuildTarget.Windows, request, angle, null);
  const input: WindowsArchiveInput = {
    name,
    executable: contentOf(exe),
    runtime: {
      [WindowsRuntimeFile.Egl]: contentOf(runtime[WindowsRuntimeFile.Egl]),
      [WindowsRuntimeFile.Gles]: contentOf(runtime[WindowsRuntimeFile.Gles]),
      [WindowsRuntimeFile.D3dCompiler]: contentOf(runtime[WindowsRuntimeFile.D3dCompiler]),
    },
    assets,
    notices: notices.texts,
    builtOn: request.builtOn,
    ranOnTarget: request.ranOnTarget,
    signed: false,
  };
  // Every name and licence is checked before anything is staged or signed.
  windowsArchiveItems(input);
  const secretValues = [...request.secretValues];
  const unsigned = { exe, egl: runtime[WindowsRuntimeFile.Egl], gles: runtime[WindowsRuntimeFile.Gles] };
  const archive = signer
    ? await signedZip(request, input, unsigned, { signer, pins, secretValues })
    : await writeWindowsZip(request.archive, input, {
        secretValues,
        inspect: assetInspector(BuildTarget.Windows, name),
      });
  return { target: BuildTarget.Windows, name, archive, signed: signer !== null, notices: notices.sources };
}

/**
 * Exports a Linux cross build as `<game>/` in a tar.gz at `request.archive`: the admitted game
 * (0755), ANGLE's Vulkan libraries, the Vulkan loader and SwiftShader with its ICD from the store,
 * the assets, the licences, a README and `SHA256SUMS`. A refusal throws a typed error and leaves
 * nothing behind.
 */
export async function exportLinuxTarball(
  request: LinuxExportRequest,
  deps: LinuxExportDeps = {},
): Promise<DesktopExport> {
  await checkArchiveTarget(request.archive, [request.game, request.out]);
  const admission = await admitted(request, BuildTarget.Linux, deps.admit ?? admitCrossOutput);
  if (!admission.linux) throw new DesktopExportError(DesktopExportProblem.NotAdmitted, MESSAGE.NotAdmitted("."));
  const angle = await pinnedManifest(request.angle, NativeRefusal.AngleDigest);
  const runtime = await linuxRuntime(angle);
  const exe = await admittedLinuxExe(admission.linux);
  const assets = await admittedAssets(request, admission);
  const notices = await desktopNotices(BuildTarget.Linux, request, angle, request.sysroot);
  const name = linuxExportName(request.title);
  const input: LinuxArchiveInput = {
    name,
    executable: contentOf(exe),
    runtime: {
      [LinuxRuntimeFile.Egl]: contentOf(runtime[LinuxRuntimeFile.Egl]),
      [LinuxRuntimeFile.Gles]: contentOf(runtime[LinuxRuntimeFile.Gles]),
      [LinuxRuntimeFile.VulkanLoader]: contentOf(runtime[LinuxRuntimeFile.VulkanLoader]),
      [LinuxRuntimeFile.SwiftShader]: contentOf(runtime[LinuxRuntimeFile.SwiftShader]),
      [LinuxRuntimeFile.SwiftShaderIcd]: contentOf(runtime[LinuxRuntimeFile.SwiftShaderIcd]),
    },
    assets,
    notices: notices.texts,
    builtOn: request.builtOn,
    ranOnTarget: request.ranOnTarget,
  };
  linuxArchiveItems(input);
  const archive = await writeLinuxTarGz(request.archive, input, {
    secretValues: [...request.secretValues],
    inspect: assetInspector(BuildTarget.Linux, name),
  });
  return { target: BuildTarget.Linux, name, archive, signed: false, notices: notices.sources };
}

// ---------- a Rust · wgpu game's Windows export ----------

/** A Rust · wgpu game's Windows export (M4.1), optionally signed with the person's own certificate. */
export interface RustWindowsExportRequest {
  /** The game's title: the archive's folder and executable names come from it. */
  title: string;
  /** The game's folder: the archive must be outside it. */
  game: string;
  /** The lane's admitted `out/` of the game's export build (`<bin>.out`). */
  out: string;
  /** Every file of `out/` as the lane admitted it (its receipt's `outputs`): nothing else is packed. */
  outputs: ReadonlyArray<{ path: string; sha256: string }>;
  /** The game's licence notices for Windows (`rustNotices` over the admitted lock, `rust-notices.ts`). */
  notices: readonly MacNotice[];
  /** The archive file to write: in an existing real folder outside the game and `out/`. */
  archive: string;
  builtOn: StudioPlatform;
  /** The credential values Studio holds: one in any exported file refuses the export. */
  secretValues: Iterable<string>;
  signing?: { requester: SigningRequester; choice: WindowsSigningChoice };
}

/** What the Rust Windows export is given besides its request: how jsign is launched and run. */
export type RustWindowsExportDeps = Pick<WindowsExportDeps, "jsign" | "runSigned">;

/** A written Rust Windows export, with the GPU qualification its receipt records. */
export interface RustDesktopExport extends DesktopExport {
  gpuQualification: GpuQualification;
}

const RUST_WINDOWS_EXE = STACK_CROSS_EXECUTABLES[GameStack.RustWgpu][BuildTarget.Windows];

/** The lane's admitted digest of each file of `out/`, by its `/`-separated path. */
const digestsOf = (outputs: RustWindowsExportRequest["outputs"]): Map<string, string> =>
  new Map(outputs.map((output) => [output.path, output.sha256]));

const notAdmittedFile = (file: string) =>
  new DesktopExportError(DesktopExportProblem.Changed, MESSAGE.NotAdmittedBuild(file), { file });

/**
 * The game's executable, read once from `out/` (no link at its name or above it, one name) and
 * admitted from those very bytes: the Rust PE policy (x64, System32 imports only: no desktop
 * OpenGL, no DXC) and no studio transport, since an export never serves the studio. Its digest must
 * be the one the lane admitted.
 */
async function rustWindowsExe(out: string, digests: ReadonlyMap<string, string>): Promise<Buffer> {
  const realRoot = await realpath(out).catch(() => null);
  if (realRoot === null) throw notAdmittedFile(".");
  const read = await readBundleFile(out, RUST_WINDOWS_EXE, { realRoot, maxBytes: RUST_EXE_MAX_BYTES });
  if (!read.ok) {
    const detail = MESSAGE.NotAdmitted(read.detail);
    throw new DesktopExportError(DesktopExportProblem.NotAdmitted, detail, { file: RUST_WINDOWS_EXE });
  }
  const admission = admitRustBinary({ target: BuildTarget.Windows, bytes: read.bytes, servesStudio: false });
  if (!admission.ok) {
    throw new DesktopExportError(DesktopExportProblem.NotAdmitted, MESSAGE.NotAdmitted(admission.detail), {
      refusal: admission.refusal,
      file: RUST_WINDOWS_EXE,
    });
  }
  if (digests.get(RUST_WINDOWS_EXE) !== admission.sha256) throw notAdmittedFile(RUST_WINDOWS_EXE);
  return Buffer.from(read.bytes);
}

/** The assets under `out/assets`, each pinned, and each one the lane admitted. */
async function rustWindowsAssets(out: string, digests: ReadonlyMap<string, string>): Promise<AssetFile[]> {
  const folder = path.join(await realpath(out), ASSETS_FOLDER);
  const present = await lstat(folder).catch(() => null);
  const assets = present ? await readAssetTree(folder) : [];
  const extra = assets.find((asset) => !digests.has(`${ASSETS_FOLDER}/${asset.path}`));
  if (extra) throw notAdmittedFile(`${ASSETS_FOLDER}/${extra.path}`);
  return assets;
}

/**
 * The archive's look at each asset it packs, at write time: its bytes must be the lane's admitted
 * digest, and none may start as a Windows program.
 */
function rustAssetInspector(name: string, digests: ReadonlyMap<string, string>): (entry: string, data: Buffer) => void {
  const prefix = `${name}/${ASSETS_FOLDER}/`;
  const program = assetInspector(BuildTarget.Windows, name);
  return (entry, data) => {
    if (!entry.startsWith(prefix)) return;
    const file = `${ASSETS_FOLDER}/${entry.slice(prefix.length)}`;
    if (digests.get(file) !== sha256(data)) throw notAdmittedFile(file);
    program(entry, data);
  };
}

/** The notices' files under `notices/` and their index, read now (a store licence missing is `build-failed`). */
async function rustNoticeFiles(
  name: string,
  notices: readonly MacNotice[],
): Promise<RustWindowsArchiveInput["notices"]> {
  const files = await readNotices(notices);
  return {
    index: noticesIndex(name, notices, files),
    files: files.map((file) => ({ path: file.rel, content: { bytes: file.bytes } })),
  };
}

/** Stages, signs (the exe alone), checks and zips a Rust game's signed export; the staging folder goes whatever happens. */
async function rustSignedZip(
  archive: string,
  input: RustWindowsArchiveInput,
  exe: Buffer,
  context: { signer: Signer; secretValues: string[]; inspect: (entry: string, data: Buffer) => void },
): Promise<ArchiveSummary> {
  const staging = await stagingFolder(context.signer.jsign.stagingRoot);
  try {
    const plan = await stagedPlan(staging, `${input.name}.exe`, [exe], context.signer, GameStack.RustWgpu);
    await runPlan(plan, context.signer);
    const [file] = plan.targets;
    const label = path.basename(file ?? "");
    const signed = await readRegularFile(file ?? "", RUST_EXE_MAX_BYTES).catch((error: unknown) => {
      throw signedRefused(errorMessage(error), null, label);
    });
    if (!signatureOnlyChange(exe, signed)) throw signedRefused(MESSAGE.SignedChanged(label), null, label);
    const again = admitRustBinary({ target: BuildTarget.Windows, bytes: signed, servesStudio: false });
    if (!again.ok) throw signedRefused(MESSAGE.SignedRefused(again.detail), again.refusal, RUST_WINDOWS_EXE);
    const signedInput = { ...input, executable: { bytes: signed }, signed: true };
    return await writeRustWindowsZip(archive, signedInput, {
      secretValues: [...context.secretValues, ...plan.secretValues],
      inspect: context.inspect,
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Exports a Rust · wgpu game's Windows build as `<Game>/` in a zip at `request.archive`: the
 * admitted `game.exe` alone (its C runtime linked in; D3D12 and FXC's `d3dcompiler_47.dll` are
 * Windows' own), the assets, the notices, a README and `SHA256SUMS`; signed (the exe only) with the
 * person's own certificate only when they chose it. Every packed byte is one the lane admitted.
 * The same build gives a byte-identical zip. The receipt records the GPU qualification
 * (`untested` until a real Windows GPU runs a row). A refusal throws a typed error and leaves
 * nothing behind.
 */
export async function exportRustWindowsZip(
  request: RustWindowsExportRequest,
  deps: RustWindowsExportDeps = {},
): Promise<RustDesktopExport> {
  await checkArchiveTarget(request.archive, [request.game, request.out]);
  const name = windowsExportName(request.title);
  const signer = await signingPreflight(request, name, deps);
  const digests = digestsOf(request.outputs);
  const exe = await rustWindowsExe(request.out, digests);
  const assets = await rustWindowsAssets(request.out, digests);
  const gpuQualification = gpuQualificationOf(GameStack.RustWgpu, BuildTarget.Windows) ?? GpuQualification.Untested;
  const input: RustWindowsArchiveInput = {
    name,
    executable: contentOf(exe),
    assets,
    notices: await rustNoticeFiles(name, request.notices),
    builtOn: request.builtOn,
    gpuQualification,
    signed: false,
  };
  // Every name is checked before anything is staged or signed.
  rustWindowsArchiveItems(input);
  const secretValues = [...request.secretValues];
  const inspect = rustAssetInspector(name, digests);
  const archive = signer
    ? await rustSignedZip(request.archive, input, exe, { signer, secretValues, inspect })
    : await writeRustWindowsZip(request.archive, input, { secretValues, inspect });
  const notices = request.notices.map((notice) => notice.folder).sort(byBytes);
  return { target: BuildTarget.Windows, name, archive, signed: signer !== null, notices, gpuQualification };
}

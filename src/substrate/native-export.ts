/**
 * A C++ game's Mac app export: the admitted window build assembled into `<Title>.app` with a
 * host-written `Info.plist`, the store's ANGLE in `Frameworks/`, the build's assets and the licence
 * notices in `Resources/`, and signed inside out (libraries, then the app; never `--deep`).
 *
 * Every byte is read and checked before anything is written, with the run bundle's own checks
 * (`native-bundle.ts`): the executable again as a game, the ANGLE against the lock's pin, each asset
 * as listed. The app is staged in the host's own folder (`stagingRoot`, where no sandboxed process
 * writes), scanned for held credentials, signed and verified there, and only then swapped into place with the web export's helpers
 * (`game-export.ts`), the export marker and a README beside it. Ad-hoc signing runs; Developer ID
 * signing and notarization are argv builders, built only from a `parseExportSigning` result, that
 * run only for a person and behind `GENEX_EXPORT_SIGN_IDENTITY_OK=1`.
 *
 * The notices a Rust · wgpu export carries (`rust-notices.ts`, M3.5: its lock closure and its
 * destination's runtime parts) are notices of the same shape, some with generated text; every
 * export writes its notices folder through {@link writeNoticesFolder}.
 */
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../shared/errors.ts";
import { ExportError, ExportRefusal, ExportSigning, type ExportSigningChoice } from "../shared/game-export-contract.ts";
import { BuildTarget } from "../shared/game-project.ts";
import { NativeError, NativeRefusal, NativeRunMode } from "../shared/native-contract.ts";
import {
  EXPORT_MANIFEST,
  fileWithSecret,
  makeStaging,
  resolveExportTarget,
  secretFoundError,
  swapIntoPlace,
} from "./game-export.ts";
import { realpathNearest } from "./fsx.ts";
import {
  type AdmittedMacBundle,
  type AssetListing,
  type BundleExec,
  bundleIdentityEntries,
  gameModeEntries,
  CODESIGN_PATH,
  copyListedAssets,
  listAdmittedAssets,
  MAC_ANGLE_FILES,
  type MacAngle,
  plistDocument,
  plistString,
  readAssetFile,
  readGameExecutable,
  readHostFile,
  readMacAngle,
  RunDirLayout,
} from "./native-bundle.ts";
import { isBelow } from "./paths.ts";

/** Where a notice's licence text comes from. Names of nothing on the wire. */
export const NoticeSourceKind = {
  /** One licence file, copied whole under its own name. */
  File: "file",
  /** A folder of licence files (ANGLE's `licenses/`): each regular file in it, copied whole. */
  Folder: "folder",
  /** A single-file library whose licence is the header's last block comment (miniaudio), as `LICENSE.txt`. */
  LastComment: "last-comment",
  /** Text the host wrote itself (a Rust export's crate list), written as `name`. */
  Text: "text",
} as const;
export type NoticeSourceKind = (typeof NoticeSourceKind)[keyof typeof NoticeSourceKind];

/** One place a component's licence text is read from, or the host's own text for it. */
export type NoticeSource =
  | { kind: Exclude<NoticeSourceKind, typeof NoticeSourceKind.Text>; path: string }
  | { kind: typeof NoticeSourceKind.Text; name: string; text: string };

/** One third-party component whose licence the app carries in `Resources/notices/<folder>/`. */
export interface MacNotice {
  /** The folder under `notices/`, `/`-separated (`raylib`, `third_party/box2d`). */
  folder: string;
  /** The component and its licence, as `NOTICES.txt` lists it. */
  title: string;
  sources: readonly NoticeSource[];
  /** The game's own copy (`third_party/`): agent-made, read as an asset is (no link anywhere, one hard link). */
  game?: boolean;
}

/** What one Mac app export is made from. */
export interface MacExportRequest {
  /** The window build's executable, admitted from the lane's output (`admitMacBundle`, mode `window`). */
  admitted: AdmittedMacBundle;
  /** The store's Mac ANGLE, checked against the lock's pin before it is copied. */
  angle: MacAngle;
  /** The licences `Resources/notices/` carries: {@link storeNotices} and {@link gameNotices}. */
  notices: readonly MacNotice[];
  /** The game's once-chosen bundle identifier (`GameWorkspaces.bundleIdFor`). */
  bundleId: string;
  /** The game's title: the app's name ({@link appNameOf}) and its `CFBundleName`. */
  title: string;
  /** The name the app takes when the title leaves nothing (the game's folder name). */
  fallbackName: string;
  /** Checked by `parseExportSigning`: ad hoc runs; Developer ID only for a person, behind the gate. */
  signing: ExportSigningChoice;
  /** The game folder: the target may never hold it or sit inside it. */
  source: string;
  /** The folder the `.app` is written into: empty, or an earlier Genex export. */
  target: string;
  /** When given (`layout.exports`), the target must resolve below it. */
  exportsRoot?: string;
  /** The host-only folder the app is staged and signed in (`layout.exportStaging`); absent, beside the target. */
  stagingRoot?: string;
  /** Host programs without a shell (`codesign`, `ditto`, `xcrun`, `spctl`). */
  exec: BundleExec;
  /** The clock (default `Date.now`): the app's build number and the swap's aside name. */
  now?: () => number;
  /** Values no exported file may hold (`StudioCore.knownSecretValues`). */
  secretValues?: Iterable<string>;
  /** The person asked for this export in the studio's window: never the harness or a plugin. */
  person?: boolean;
  /** Where the Developer ID gate is read (default `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/** What a Mac app export wrote. */
export interface MacExportResult {
  /** The export folder: the `.app`, its README and the marker. */
  dir: string;
  /** The `.app`, inside `dir`. */
  app: string;
  /** Files inside the `.app`. */
  files: number;
  /** Those files, `/`-separated from `dir`, sorted. */
  included: string[];
  /** How it was signed. */
  signed: ExportSigning;
}

/** One host program call: the program and its arguments, never a shell line. */
export interface ExportStep {
  file: string;
  args: string[];
}

/** The environment variable that clears Developer ID signing for a person's export. */
export const EXPORT_SIGN_GATE = "GENEX_EXPORT_SIGN_IDENTITY_OK";
/** The gate's one opening value. */
const GATE_OPEN = "1";
/** An app's name is cut to this many characters. */
const APP_NAME_MAX_CHARS = 64;
const DEFAULT_APP_NAME = "Game";
const APP_SUFFIX = ".app";
/** What an app's name may not hold: a path separator, Finder's `:`, a control character. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this drops.
const APP_NAME_REFUSED = /[/:\u0000-\u001f\u007f]/g;
/** The most bytes of one licence file, and of a header its licence is cut from. */
const NOTICE_MAX_BYTES = 1024 * 1024;
const NOTICE_HEADER_MAX_BYTES = 16 * 1024 * 1024;
/** The most licence files one component contributes. */
const NOTICE_FILES_MAX = 32;
/** The game's folder of vendored libraries, and the licence files read in each. */
const THIRD_PARTY = "third_party";
const LICENCE_FILE = /^(licen[sc]e|copying|notice)([._-]|$)/i;
/** A `third_party/<name>` folder a notice is made for: a plain name. */
const COMPONENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/** The file a last-comment licence is written as, and the index of every notice. */
const LAST_COMMENT_FILE = "LICENSE.txt";
const NOTICES_INDEX = "NOTICES.txt";
const NOTICES_FOLDER = "notices";
const ASSETS_FOLDER = "assets";
const README = "README.txt";
/** Where raylib's source keeps the licences the app carries. */
const RAYLIB_LICENCES = {
  raylib: ["LICENSE"],
  glfw: ["src", "external", "glfw", "LICENSE.md"],
  miniaudio: ["src", "external", "miniaudio.h"],
} as const;
const ANGLE_LICENCES = "licenses";
/** The app's marketing version. */
const SHORT_VERSION = "1.0";
const DITTO = "/usr/bin/ditto";
const XCRUN = "/usr/bin/xcrun";
const SPCTL = "/usr/sbin/spctl";
const ADHOC_FLAGS = ["--force", "--sign", "-", "--timestamp=none"] as const;
const VERIFY_FLAGS = ["--verify", "--strict"] as const;

const MESSAGE = {
  admission: (refusal: string, detail: string) =>
    `The Mac build did not pass Genex's checks, so no app was made (${refusal}): ${detail}`,
  notWindow: (mode: string) => `a Mac app is made from the window build, not the ${mode} build`,
  unsigned: "a Mac app is signed, ad hoc at least",
  signingUnavailable: "Developer ID signing is not available in this version of Genex; Mac apps are signed ad hoc",
  outsideExports: (target: string) => `Export destination must be inside the studio's exports folder: ${target}`,
  noticeMissing: (folder: string, detail: string) =>
    `The toolchain store's ${folder} licence could not be read, so no app was made: ${detail}`,
  noLicenceComment: (file: string) => `${file} ends with no licence comment`,
  badTextName: (name: string) => `${JSON.stringify(name)} is not a plain file name for a notice`,
  stepFailed: (step: ExportStep, detail: string) => `${path.basename(step.file)} failed on the app: ${detail}`,
  indexHeading: (app: string) => `Third-party software in ${app}, and where each licence is:`,
  readme: (app: string) =>
    [
      `${app} is a game for Mac computers with Apple silicon and macOS 13 or later.`,
      "",
      "It is signed for this Mac only (ad hoc), not by a registered Apple developer. To open it on another Mac:",
      `1. Copy ${app} to that Mac and double-click it. macOS says it cannot check it: choose Done.`,
      "2. Open System Settings > Privacy & Security, and under Security choose Open Anyway.",
      "3. Double-click it again and choose Open.",
      "",
      `The licences of the software it includes are in ${app}/Contents/Resources/notices.`,
      "",
    ].join("\n"),
  readmeSigned: (app: string) =>
    [
      `${app} is a game for Mac computers with Apple silicon and macOS 13 or later.`,
      "It is signed with its developer's Developer ID.",
      "",
      `The licences of the software it includes are in ${app}/Contents/Resources/notices.`,
      "",
    ].join("\n"),
} as const;

/** `text` with no path separator, `:` or control character, no leading dot, trimmed and cut to 64 characters. */
function cleanName(text: string): string {
  const plain = text.replace(APP_NAME_REFUSED, "").trim().replace(/^\.+/, "").trim();
  return Array.from(plain).slice(0, APP_NAME_MAX_CHARS).join("").trim();
}

/** The app's name (without `.app`): the title made safe for a folder name, else the fallback, else "Game". */
export function appNameOf(title: string, fallback: string): string {
  return cleanName(title) || cleanName(fallback) || DEFAULT_APP_NAME;
}

/** `codesign --force --sign - --timestamp=none` on each library, then the app: inside out, never `--deep`. */
export function adhocSignArgv(app: string, libraries: readonly string[]): ExportStep[] {
  return [...libraries, app].map((target) => ({ file: CODESIGN_PATH, args: [...ADHOC_FLAGS, target] }));
}

/** `codesign --force --sign <identity> --timestamp --options runtime` on each library, then the app: inside out. */
export function developerIdSignArgv(
  app: string,
  libraries: readonly string[],
  signing: Extract<ExportSigningChoice, { kind: typeof ExportSigning.DeveloperId }>,
): ExportStep[] {
  const flags = ["--force", "--sign", signing.identity, "--timestamp", "--options", "runtime"];
  return [...libraries, app].map((target) => ({ file: CODESIGN_PATH, args: [...flags, target] }));
}

/** `ditto -c -k --keepParent`, `notarytool submit --wait --keychain-profile`, `stapler staple`, `spctl -a -vv -t exec`. */
export function notarizeArgv(app: string, zip: string, keychainProfile: string): ExportStep[] {
  return [
    { file: DITTO, args: ["-c", "-k", "--keepParent", app, zip] },
    { file: XCRUN, args: ["notarytool", "submit", zip, "--keychain-profile", keychainProfile, "--wait"] },
    { file: XCRUN, args: ["stapler", "staple", app] },
    { file: SPCTL, args: ["-a", "-vv", "-t", "exec", app] },
  ];
}

/**
 * Refuses a signing a Mac app export cannot run: unsigned (`signing-invalid`), or Developer ID
 * unless a person asked for it and `GENEX_EXPORT_SIGN_IDENTITY_OK=1` (`signing-unavailable`).
 */
export function assertMacSigning(
  signing: ExportSigningChoice,
  from: { person: boolean; env: NodeJS.ProcessEnv },
): void {
  if (signing.kind === ExportSigning.None) throw new ExportError(ExportRefusal.SigningInvalid, MESSAGE.unsigned);
  const cleared = from.person && from.env[EXPORT_SIGN_GATE] === GATE_OPEN;
  if (signing.kind === ExportSigning.DeveloperId && !cleared) {
    throw new ExportError(ExportRefusal.SigningUnavailable, MESSAGE.signingUnavailable);
  }
}

/** The licences raylib, GLFW, miniaudio and ANGLE carry, read from the toolchain store. */
export function storeNotices(store: { raylibSource: string; angleDir: string }): MacNotice[] {
  const raylib = (parts: readonly string[]) => path.join(store.raylibSource, ...parts);
  return [
    {
      folder: "raylib",
      title: "raylib: zlib/libpng licence",
      sources: [{ kind: NoticeSourceKind.File, path: raylib(RAYLIB_LICENCES.raylib) }],
    },
    {
      folder: "glfw",
      title: "GLFW (inside raylib): zlib/libpng licence",
      sources: [{ kind: NoticeSourceKind.File, path: raylib(RAYLIB_LICENCES.glfw) }],
    },
    {
      folder: "miniaudio",
      title: "miniaudio (inside raylib): public domain (Unlicense) or MIT No Attribution",
      sources: [{ kind: NoticeSourceKind.LastComment, path: raylib(RAYLIB_LICENCES.miniaudio) }],
    },
    {
      folder: "angle",
      title: "ANGLE: BSD 3-Clause licence, with the licences of the code it includes",
      sources: [{ kind: NoticeSourceKind.Folder, path: path.join(store.angleDir, ANGLE_LICENCES) }],
    },
  ];
}

/** The plain folders of `dir`, by name, never through a link; none when `dir` is no plain folder. */
async function plainEntries(dir: string): Promise<Dirent[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));
}

/**
 * The licence files of every `third_party/<name>/` of the game (`LICENSE*`, `COPYING*`, `NOTICE*`):
 * plain folders and regular files only, never a link; read later as assets are.
 */
export async function gameNotices(gameDir: string): Promise<MacNotice[]> {
  const root = path.join(await realpath(gameDir), THIRD_PARTY);
  // A `third_party` that is a link is no folder of the game's: nothing under it is the game's licence.
  if (!(await lstat(root).catch(() => null))?.isDirectory()) return [];
  const notices: MacNotice[] = [];
  for (const component of await plainEntries(root)) {
    if (!component.isDirectory() || !COMPONENT_NAME.test(component.name)) continue;
    const dir = path.join(root, component.name);
    const files = (await plainEntries(dir)).filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name));
    if (files.length === 0) continue;
    const folder = `${THIRD_PARTY}/${component.name}`;
    notices.push({
      folder,
      title: `${folder}: the game's own copy, under its own licence`,
      game: true,
      sources: files
        .slice(0, NOTICE_FILES_MAX)
        .map((entry) => ({ kind: NoticeSourceKind.File, path: path.join(dir, entry.name) })),
    });
  }
  return notices;
}

/** One file the app carries under `notices/`: its path there and its bytes. */
export interface NoticeFile {
  rel: string;
  bytes: Buffer;
}

/** A header's last block comment: the licence a single-file library ends with. */
function lastComment(file: string, text: string): string {
  const start = text.lastIndexOf("/*");
  const end = start < 0 ? -1 : text.indexOf("*/", start);
  if (end < 0) throw new Error(MESSAGE.noLicenceComment(file));
  return `${text.slice(start, end + 2)}\n`;
}

/** The licence files one source gives, named as `notices/<folder>/` holds them. */
async function readSource(notice: MacNotice, source: NoticeSource): Promise<NoticeFile[]> {
  const under = (name: string) => `${notice.folder}/${name}`;
  if (source.kind === NoticeSourceKind.Text) {
    if (!COMPONENT_NAME.test(source.name)) throw new Error(MESSAGE.badTextName(source.name));
    return [{ rel: under(source.name), bytes: Buffer.from(source.text, "utf8") }];
  }
  if (source.kind === NoticeSourceKind.LastComment) {
    const text = (await readHostFile(source.path, NOTICE_HEADER_MAX_BYTES)).toString("utf8");
    return [{ rel: under(LAST_COMMENT_FILE), bytes: Buffer.from(lastComment(source.path, text)) }];
  }
  if (source.kind === NoticeSourceKind.Folder) {
    const files = (await plainEntries(source.path)).filter((entry) => entry.isFile()).slice(0, NOTICE_FILES_MAX);
    const read = files.map(async (entry) => ({
      rel: under(entry.name),
      bytes: await readHostFile(path.join(source.path, entry.name), NOTICE_MAX_BYTES),
    }));
    return Promise.all(read);
  }
  const read = notice.game ? readAssetFile : readHostFile;
  return [{ rel: under(path.basename(source.path)), bytes: await read(source.path, NOTICE_MAX_BYTES) }];
}

/**
 * Every notice's files, read now: a game's link or swapped file is the typed refusal, a store
 * licence that cannot be read is `build-failed` (the toolchain is not whole). The Windows Rust
 * zip (`native-export-desktop.ts`) packs the same files.
 */
export async function readNotices(notices: readonly MacNotice[]): Promise<NoticeFile[]> {
  const files: NoticeFile[] = [];
  for (const notice of notices) {
    for (const source of notice.sources) {
      try {
        files.push(...(await readSource(notice, source)));
      } catch (error) {
        if (notice.game) throw error;
        throw new ExportError(ExportRefusal.BuildFailed, MESSAGE.noticeMissing(notice.folder, errorMessage(error)));
      }
    }
  }
  return files;
}

/** `NOTICES.txt`: each component, its licence and the files that hold it (relative to the notices folder). */
export function noticesIndex(app: string, notices: readonly MacNotice[], files: readonly NoticeFile[]): string {
  const lines = [MESSAGE.indexHeading(app), ""];
  for (const notice of notices) {
    lines.push(notice.title);
    for (const file of files) if (file.rel.startsWith(`${notice.folder}/`)) lines.push(`  ${file.rel}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Writes an export's notices folder at `dir` (created; it must not hold these files yet): each
 * notice's files under `<dir>/<folder>/` and `NOTICES.txt`, the index naming `product`, every
 * component and its files. Reads every source first, so nothing is written for a notice set with a
 * source that cannot be read (a store licence missing is `build-failed`). Answers the files
 * written, `/`-separated from `dir`, sorted. Any destination's export carries its notices this way.
 */
export async function writeNoticesFolder(
  dir: string,
  product: string,
  notices: readonly MacNotice[],
): Promise<string[]> {
  const files = await readNotices(notices);
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    const to = path.join(dir, ...file.rel.split("/"));
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, file.bytes, { flag: "wx", mode: 0o644 });
  }
  await writeFile(path.join(dir, NOTICES_INDEX), noticesIndex(product, notices, files), { flag: "wx", mode: 0o644 });
  return [...files.map((file) => file.rel), NOTICES_INDEX].sort();
}

/** Everything the app is written from, read and checked first. */
interface AppParts {
  exe: Buffer;
  angle: { egl: Buffer; gles: Buffer };
  assets: AssetListing | null;
  notices: NoticeFile[];
}

/** Reads and checks every part; a native refusal is `admission-refused` with the refusal in the sentence. */
async function readParts(request: MacExportRequest): Promise<AppParts> {
  try {
    const { admitted } = request;
    if (admitted.mode !== NativeRunMode.Window)
      throw new NativeError(NativeRefusal.Unsupported, MESSAGE.notWindow(admitted.mode));
    const angle = await readMacAngle(request.angle);
    const { bytes: exe } = await readGameExecutable(admitted.exe);
    const assets = await listAdmittedAssets(admitted.assets);
    return { exe, angle, assets, notices: await readNotices(request.notices) };
  } catch (error) {
    if (!(error instanceof NativeError)) throw error;
    throw new ExportError(ExportRefusal.AdmissionRefused, MESSAGE.admission(error.refusal, error.message));
  }
}

/** The app's build number from the clock: `<year>.<month><day>.<hour><minute>` in UTC, three integers. */
function bundleVersion(now: number): string {
  const at = new Date(now);
  const day = (at.getUTCMonth() + 1) * 100 + at.getUTCDate();
  const minute = at.getUTCHours() * 100 + at.getUTCMinutes();
  return `${at.getUTCFullYear()}.${day}.${minute}`;
}

/** The app's `Info.plist`: the run bundle's identity entries and a player's app's own; no `LSUIElement`. */
function appInfoPlist(request: MacExportRequest, now: number): string {
  return plistDocument([
    ...bundleIdentityEntries(request.bundleId, request.title),
    ["CFBundleDisplayName", plistString(request.title || DEFAULT_APP_NAME)],
    ["CFBundleShortVersionString", plistString(SHORT_VERSION)],
    ["CFBundleVersion", plistString(bundleVersion(now))],
    ...gameModeEntries(),
  ]);
}

/** Writes the `.app` at `app` from checked parts; answers its files, `/`-separated from the app's parent. */
async function writeApp(app: string, parts: AppParts, plist: string): Promise<string[]> {
  const contents = path.join(app, "Contents");
  const resources = path.join(contents, "Resources");
  for (const folder of ["MacOS", "Frameworks", path.join("Resources", NOTICES_FOLDER)]) {
    await mkdir(path.join(contents, folder), { recursive: true });
  }
  await writeFile(path.join(contents, "MacOS", RunDirLayout.Executable), parts.exe, { flag: "wx", mode: 0o755 });
  await writeFile(path.join(contents, "Frameworks", MAC_ANGLE_FILES.egl), parts.angle.egl, { flag: "wx", mode: 0o644 });
  await writeFile(path.join(contents, "Frameworks", MAC_ANGLE_FILES.gles), parts.angle.gles, {
    flag: "wx",
    mode: 0o644,
  });
  await writeFile(path.join(contents, "Info.plist"), plist, { flag: "wx", mode: 0o644 });
  if (parts.assets) await copyListedAssets(parts.assets, path.join(resources, ASSETS_FOLDER));
  for (const file of parts.notices) {
    const to = path.join(resources, NOTICES_FOLDER, ...file.rel.split("/"));
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, file.bytes, { flag: "wx", mode: 0o644 });
  }
  const parent = path.dirname(app);
  const listed = await readdir(app, { recursive: true, withFileTypes: true });
  return listed
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(parent, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

/** Runs one step; a non-zero exit stops the export with what the program said. */
async function runStep(exec: BundleExec, step: ExportStep): Promise<void> {
  const ran = await exec(step.file, step.args);
  if (ran.code !== 0) throw new Error(MESSAGE.stepFailed(step, ran.stderr.trim() || `exit ${ran.code}`));
}

/** Signs the staged app inside out and verifies it; a person's Developer ID export is also notarized. */
async function signApp(request: MacExportRequest, app: string, name: string): Promise<void> {
  const frameworks = path.join(app, "Contents", "Frameworks");
  const libraries = [path.join(frameworks, MAC_ANGLE_FILES.egl), path.join(frameworks, MAC_ANGLE_FILES.gles)];
  const { signing } = request;
  const steps =
    signing.kind === ExportSigning.DeveloperId
      ? developerIdSignArgv(app, libraries, signing)
      : adhocSignArgv(app, libraries);
  for (const step of steps) await runStep(request.exec, step);
  await runStep(request.exec, { file: CODESIGN_PATH, args: [...VERIFY_FLAGS, app] });
  if (signing.kind !== ExportSigning.DeveloperId || !signing.keychainProfile) return;
  const zip = path.join(path.dirname(app), `${name}.zip`);
  try {
    for (const step of notarizeArgv(app, zip, signing.keychainProfile)) await runStep(request.exec, step);
  } finally {
    await rm(zip, { force: true });
  }
}

/** Refuses a target that does not resolve below the exports root, before anything is made for it. */
async function assertInsideExports(request: MacExportRequest): Promise<void> {
  if (request.exportsRoot === undefined) return;
  const lexical = isBelow(path.resolve(request.exportsRoot), path.resolve(request.target));
  const root = await realpathNearest(request.exportsRoot);
  const real = await realpathNearest(request.target).catch(() => null);
  if (!lexical || !real || !isBelow(root, real)) throw new Error(MESSAGE.outsideExports(request.target));
}

/** The files a held credential is looked for in: what the game made (executable, assets, its own notices). */
function scannedFiles(name: string, files: readonly string[]): string[] {
  const contents = `${name}${APP_SUFFIX}/Contents/`;
  const gameMade = [
    `${contents}MacOS/`,
    `${contents}Resources/${ASSETS_FOLDER}/`,
    `${contents}Resources/${NOTICES_FOLDER}/${THIRD_PARTY}/`,
  ];
  return files.filter((rel) => gameMade.some((prefix) => rel.startsWith(prefix)));
}

/**
 * Assembles, scans, signs and verifies one Mac app export in a staging folder of the host's own,
 * then swaps it into place. Throws `ExportError` (or the web export's sentences for a target) and
 * leaves the target as it was.
 */
export async function exportMacApp(request: MacExportRequest): Promise<MacExportResult> {
  assertMacSigning(request.signing, { person: request.person === true, env: request.env ?? process.env });
  const parts = await readParts(request);
  const name = appNameOf(request.title, request.fallbackName);
  const now = request.now ?? Date.now;
  await assertInsideExports(request);
  const { target, parent, existing } = await resolveExportTarget(await realpath(request.source), request.target);
  const staging = await makeStaging(parent, request.stagingRoot);
  try {
    const staged = path.join(staging, `${name}${APP_SUFFIX}`);
    const included = await writeApp(staged, parts, appInfoPlist(request, now()));
    const executable = `${name}${APP_SUFFIX}/Contents/MacOS/${RunDirLayout.Executable}`;
    const leaked = await fileWithSecret(
      staging,
      scannedFiles(name, included),
      request.secretValues ?? [],
      (rel) => rel === executable,
    );
    if (leaked) throw secretFoundError(leaked);
    const notices = noticesIndex(`${name}${APP_SUFFIX}`, request.notices, parts.notices);
    await writeFile(path.join(staged, "Contents", "Resources", NOTICES_FOLDER, NOTICES_INDEX), notices, { flag: "wx" });
    const all = [...included, `${name}${APP_SUFFIX}/Contents/Resources/${NOTICES_FOLDER}/${NOTICES_INDEX}`].sort();
    await signApp(request, staged, name);
    const signedBy = request.signing.kind === ExportSigning.DeveloperId ? MESSAGE.readmeSigned : MESSAGE.readme;
    await writeFile(path.join(staging, README), signedBy(`${name}${APP_SUFFIX}`), { flag: "wx" });
    const marker = {
      studioExport: 1,
      destination: BuildTarget.Mac,
      app: `${name}${APP_SUFFIX}`,
      bundleId: request.bundleId,
      signed: request.signing.kind,
      included: all,
    };
    await writeFile(path.join(staging, EXPORT_MANIFEST), JSON.stringify(marker), { flag: "wx" });
    await swapIntoPlace(staging, target, existing, now);
    return {
      dir: target,
      app: path.join(target, `${name}${APP_SUFFIX}`),
      files: all.length,
      included: all,
      signed: request.signing.kind,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

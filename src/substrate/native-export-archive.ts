/**
 * The Windows and Linux export archives (plan §7.7, M4b): `<Game>-windows-x64.zip` and
 * `<game>-linux-x64.tar.gz`, written with nothing but `node:zlib` so the same input gives the same
 * bytes on every host. Entries are sorted by their UTF-8 bytes, every timestamp is
 * {@link ARCHIVE_EPOCH_SECONDS}, owners are 0, and the only modes are 0755 (folders, the game's
 * executable) and 0644 (everything else). There are no links of any kind.
 *
 * Every entry name is checked before a byte is written: no absolute path, no `.`/`..`/empty
 * segment, no backslash, and nothing Windows refuses (`windows-names.ts`, the one rule the PE gate
 * applies too: reserved device names, a trailing dot or space, `<>:"|?*`, control characters).
 * One rule set serves both archives, because the same game's assets go to every destination: a
 * name that cannot land on Windows is refused for Linux too, instead of exporting fine there and
 * failing on the other. Names that differ only by case or Unicode form are refused as one file
 * (NTFS and APFS fold them). Both archives end with a `SHA256SUMS` of every file beside it.
 *
 * Files are read at write time through `openNoFollow` as regular files (never a link, never
 * blocking on a FIFO) and checked for any credential Studio holds. A file found in a folder the
 * agent can write (the assets, see {@link readAssetTree}) is pinned when found: the read must open
 * that very file (same device and inode, one name), so a folder swapped for a link between the
 * walk and the write cannot slip in a file from outside the game. The archive is written to a
 * partial file beside the target and renamed over it only when complete, so a refusal leaves
 * nothing behind and a link planted at the target is never written through.
 *
 * This module only writes: it does not admit the build, read the store or gather licences. The
 * export flow (`native-export-desktop.ts`) admits the build, checks the store's files against their
 * pins, then hands {@link writeWindowsZip} or {@link writeLinuxTarGz} the admitted bytes.
 */
import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants as FS } from "node:fs";
import { lstat, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { crc32, createDeflateRaw, deflateRaw } from "node:zlib";
import { StudioPlatform } from "../shared/boot.ts";
import { GpuQualification } from "../shared/game-export-contract.ts";
import { BuildTarget } from "../shared/game-project.ts";
import { MIN_SECRET_LENGTH } from "../shared/redact.ts";
import { openNoFollow } from "./fsx.ts";
import { excludedFromExport } from "./game-export.ts";
import { LinuxRuntimeFile, WindowsRuntimeFile } from "./native-runtime-files.ts";
import { ARCHIVE_NAME_MAX_BYTES } from "./toolchain-store/archive.ts";
import { WindowsNameProblem, windowsNameProblem } from "./windows-names.ts";

/** Every entry's timestamp: 1980-01-01T00:00:00Z, the earliest a zip can state, so both formats agree. */
export const ARCHIVE_EPOCH_SECONDS = 315_532_800;
/** The licence file each archive carries beside the game. */
export const NOTICES_FILE = "THIRD-PARTY-NOTICES.txt";
/** How to run the game, its requirements and the honest "not run there" line. */
export const README_FILE = "README.txt";
/** Each archive's `sha256sum -c` list of every file beside it. */
export const SUMS_FILE = "SHA256SUMS";
/** The folder a Rust · wgpu export keeps each licence file in, under its notices index. */
export const NOTICES_FOLDER = "notices";

const MIB = 1024 * 1024;
/** The largest single file an archive packs: one asset or binary, read whole. */
const ARCHIVE_FILE_MAX_BYTES = 1024 * MIB;
/** How much of a file one read takes. */
const READ_CHUNK_BYTES = MIB;
/** An export name's limit, in characters: the folder, the executable and the archive file name. */
const EXPORT_NAME_MAX_CHARS = 64;
/** zlib's best compression: export time is not the bottleneck, the player's download is. */
const DEFLATE_LEVEL = 9;
/** Zip without Zip64: these are the format's own limits. */
const ZIP32_MAX_BYTES = 0xffff_ffff;
const ZIP32_MAX_ENTRIES = 0xffff;
const TAR_BLOCK_BYTES = 512;
/** tar's conventional record (blocking factor 20): the archive is padded to a multiple of it. */
const TAR_RECORD_BYTES = 10_240;

const MODE_FILE = 0o644;
const MODE_EXECUTABLE = 0o755;
const MODE_DIR = 0o755;

const MESSAGE = {
  Unsafe: (name: string, why: string) => `The export cannot hold ${JSON.stringify(name)}: ${why}.`,
  Duplicate: (name: string) =>
    `The export would hold ${JSON.stringify(name)} twice (names that differ only by case are one file on Windows and macOS).`,
  GameName: (name: string, why: string) => `${JSON.stringify(name)} cannot name an exported game: ${why}.`,
  NotRegular: (name: string) =>
    `${name} is a link, a folder or a special file, not a regular file, so it is not exported.`,
  HardLink: (name: string) => `${name} has another name elsewhere (a hard link), so it is not exported.`,
  Changed: (name: string) => `${name} was replaced while the export was being written; export again.`,
  NotAFolder: (dir: string) => `${dir} is a link or a file, not a folder of assets.`,
  Missing: (name: string) => `${name} does not exist.`,
  Unreadable: (name: string) => `${name} cannot be read, so it is not exported.`,
  TooLarge: (name: string) => `${name} is larger than an export can hold.`,
  TooMany: (count: number) => `The export would hold ${count} entries; a zip holds at most ${ZIP32_MAX_ENTRIES}.`,
  Notice: (component: string) => `The export has no licence text for ${component}, which it ships.`,
  Secret: (name: string) => `${name} contains a credential Studio holds, so it is not exported.`,
  Target: (file: string) => `${file} is a link or a folder; the export does not write through it.`,
  Why: {
    Empty: "an empty path segment",
    Dot: "a . or .. segment",
    Character: 'a character Windows refuses (<>:"|?*, \\ or a control character)',
    Reserved: "a name Windows reserves for a device",
    Trailing: "a segment ending in a dot or space, which Windows drops",
    Long: "a name longer than a filesystem allows",
    Leading: "a name that starts with - or .",
    LinuxName: "a Linux export name holds only lowercase letters and digits, joined by single dashes",
  },
} as const;

/** Why an archive was refused before it was written. Never rename a value. */
export const ArchiveRefusal = {
  UnsafeName: "unsafe-name",
  DuplicateName: "duplicate-name",
  InvalidGameName: "invalid-game-name",
  NotARegularFile: "not-a-regular-file",
  MissingFile: "missing-file",
  Unreadable: "unreadable",
  TooLarge: "too-large",
  MissingNotice: "missing-notice",
  SecretFound: "secret-found",
} as const;
export type ArchiveRefusal = (typeof ArchiveRefusal)[keyof typeof ArchiveRefusal];

/** An archive refusal with its typed code beside the sentence. */
export class NativeArchiveError extends Error {
  readonly code: ArchiveRefusal;

  /** `cause` is the raw filesystem error, for logs; the message names the entry, never its bytes. */
  constructor(code: ArchiveRefusal, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NativeArchiveError";
    this.code = code;
  }
}

/** The runtime files each archive packs beside the game: one table each, in `native-runtime-files.ts`. */
export { LinuxRuntimeFile, WindowsRuntimeFile };

/** What an archive entry is. */
export const ArchiveItemKind = { File: "file", Dir: "dir" } as const;
export type ArchiveItemKind = (typeof ArchiveItemKind)[keyof typeof ArchiveItemKind];

/** Which file a path named when it was found: its device and inode, exact. */
export interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

/**
 * A file's bytes: in memory, or a path read (no-follow, regular files only) when it is written.
 * A `pinned` path must still be that file, with no other name, when it is read (see {@link pinnedFile}).
 */
export type ArchiveContent = { bytes: Uint8Array } | { file: string; pinned?: FileIdentity };

/** One entry, `/`-separated and relative to the archive's root, folders without a trailing slash. */
export type ArchiveItem =
  | { kind: typeof ArchiveItemKind.Dir; path: string }
  | { kind: typeof ArchiveItemKind.File; path: string; content: ArchiveContent; executable: boolean };

/** One asset, relative to the game's `assets/` folder. */
export interface AssetFile {
  path: string;
  content: ArchiveContent;
}

/** Whose licence a notice is. The order here is the order NOTICES lists them. */
export const NoticeComponent = {
  Angle: "angle",
  SwiftShader: "swiftshader",
  Raylib: "raylib",
  Glfw: "glfw",
  Miniaudio: "miniaudio",
  MingwRuntime: "mingw-w64-runtime",
  LlvmRuntime: "llvm-runtime",
  /** zig's own runtime (compiler_rt), which zig links into every executable it builds. */
  ZigRuntime: "zig-runtime",
  /** The Wayland protocol code GLFW's Wayland backend compiles in (wayland-scanner output). */
  WaylandProtocols: "wayland-protocols",
  /** A game's own `third_party/<name>/LICENSE`. */
  GameThirdParty: "game-third-party",
} as const;
export type NoticeComponent = (typeof NoticeComponent)[keyof typeof NoticeComponent];

const NOTICE_TITLES = {
  [NoticeComponent.Angle]: "ANGLE and the libraries it bundles",
  [NoticeComponent.SwiftShader]: "SwiftShader",
  [NoticeComponent.Raylib]: "raylib",
  [NoticeComponent.Glfw]: "GLFW",
  [NoticeComponent.Miniaudio]: "miniaudio",
  [NoticeComponent.MingwRuntime]: "mingw-w64 runtime (linked into the executable)",
  [NoticeComponent.LlvmRuntime]: "LLVM runtime libraries (linked into the executable)",
  [NoticeComponent.ZigRuntime]: "Zig runtime library (linked into the executable)",
  [NoticeComponent.WaylandProtocols]: "Wayland protocol code (linked into the executable)",
  [NoticeComponent.GameThirdParty]: "Bundled with the game",
} as const satisfies Record<NoticeComponent, string>;

/** The two desktop destinations these archives serve. */
export type ArchiveTarget = typeof BuildTarget.Windows | typeof BuildTarget.Linux;

/** The components each destination ships, so each must have a licence text. */
export const REQUIRED_NOTICES = {
  [BuildTarget.Windows]: [
    NoticeComponent.Angle,
    NoticeComponent.Raylib,
    NoticeComponent.Glfw,
    NoticeComponent.Miniaudio,
    NoticeComponent.MingwRuntime,
    NoticeComponent.LlvmRuntime,
    NoticeComponent.ZigRuntime,
  ],
  [BuildTarget.Linux]: [
    NoticeComponent.Angle,
    NoticeComponent.SwiftShader,
    NoticeComponent.Raylib,
    NoticeComponent.Glfw,
    NoticeComponent.Miniaudio,
    NoticeComponent.LlvmRuntime,
    NoticeComponent.ZigRuntime,
    NoticeComponent.WaylandProtocols,
  ],
} as const satisfies Record<ArchiveTarget, readonly NoticeComponent[]>;

/** One licence text and where it was read from (shown under its heading). */
export interface NoticeText {
  component: NoticeComponent;
  source: string;
  text: string;
}

/** What both archives are made of. `ranOnTarget` false adds the honest "not run there" line. */
interface DestinationArchiveInput<Runtime extends string> {
  /**
   * The folder and executable name: one safe segment. Windows takes {@link windowsExportName}'s
   * shape; Linux only {@link linuxExportName}'s, because its README puts the name in shell commands.
   */
  name: string;
  executable: ArchiveContent;
  runtime: Readonly<Record<Runtime, ArchiveContent>>;
  assets: readonly AssetFile[];
  notices: readonly NoticeText[];
  builtOn: StudioPlatform;
  ranOnTarget: boolean;
}

/** A Windows export; `signed` says whether the person signed it with their own certificate. */
export interface WindowsArchiveInput extends DestinationArchiveInput<WindowsRuntimeFile> {
  signed?: boolean;
}
/** A Linux export. */
export type LinuxArchiveInput = DestinationArchiveInput<LinuxRuntimeFile>;

/** One licence file of a Rust export's notices, `/`-separated under {@link NOTICES_FOLDER}. */
export interface NoticeFileItem {
  path: string;
  content: ArchiveContent;
}

/**
 * A Rust · wgpu Windows export: the game alone beside its assets (the C runtime is static and
 * D3D12 and FXC are Windows' own, so no DLL ships), its notices folder with the index as
 * {@link NOTICES_FILE}, and the GPU qualification its README states honestly.
 */
export interface RustWindowsArchiveInput {
  name: string;
  executable: ArchiveContent;
  assets: readonly AssetFile[];
  notices: { index: string; files: readonly NoticeFileItem[] };
  builtOn: StudioPlatform;
  gpuQualification: GpuQualification;
  signed?: boolean;
}

/** Writing options: the credential values Studio holds, any of which in a file refuses the export. */
export interface WriteOptions {
  secretValues?: Iterable<string>;
  /**
   * Called with each file's path in the archive and the very bytes about to be written, after the
   * credential check; a throw refuses the archive and nothing lands (the export refuses an asset
   * that became a program after admission this way).
   */
  inspect?: (entry: string, data: Buffer) => void;
}

/** Where archive bytes go, in order. */
export interface ArchiveSink {
  write(chunk: Uint8Array): Promise<void>;
}

/** A written archive: its size and digest for the export result, and its entry names in order. */
export interface ArchiveSummary {
  file: string;
  bytes: number;
  sha256: string;
  entries: string[];
}

// ---------- names ----------

/** The only shape a Linux export name takes: what {@link linuxExportName} produces. */
const LINUX_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Each Windows name problem, worded for the refusal. */
const WINDOWS_NAME_WHY = {
  [WindowsNameProblem.Empty]: MESSAGE.Why.Empty,
  [WindowsNameProblem.DotSegment]: MESSAGE.Why.Dot,
  [WindowsNameProblem.Character]: MESSAGE.Why.Character,
  [WindowsNameProblem.Reserved]: MESSAGE.Why.Reserved,
  [WindowsNameProblem.Trailing]: MESSAGE.Why.Trailing,
  [WindowsNameProblem.TooLong]: MESSAGE.Why.Long,
} as const satisfies Record<WindowsNameProblem, string>;

const refuse = (code: ArchiveRefusal, message: string) => new NativeArchiveError(code, message);

/** Whether Windows reads `name` (already free of every other problem) as a device. */
const isDeviceName = (name: string): boolean => windowsNameProblem(name) === WindowsNameProblem.Reserved;

/** Why `segment` cannot be one name in an archive, or null. */
function segmentProblem(segment: string): string | null {
  const problem = windowsNameProblem(segment);
  return problem === null ? null : WINDOWS_NAME_WHY[problem];
}

/** Refuses an entry path that is absolute, escapes, or names anything Windows refuses. */
export function checkArchivePath(rel: string): void {
  if (Buffer.byteLength(rel) > ARCHIVE_NAME_MAX_BYTES)
    throw refuse(ArchiveRefusal.UnsafeName, MESSAGE.Unsafe(rel, MESSAGE.Why.Long));
  for (const segment of rel.split("/")) {
    const why = segmentProblem(segment);
    if (why) throw refuse(ArchiveRefusal.UnsafeName, MESSAGE.Unsafe(rel, why));
  }
}

/** Why `name` cannot be an export's folder and executable name, or null. */
function gameNameProblem(name: string): string | null {
  if (/^[-.]/u.test(name)) return MESSAGE.Why.Leading;
  if (name.includes("/")) return MESSAGE.Why.Character;
  return segmentProblem(name);
}

/** The name, checked as the archive's top folder: one safe segment that is not option- or dotfile-shaped. */
function checkGameName(name: string): string {
  const why = gameNameProblem(name);
  if (why) throw refuse(ArchiveRefusal.InvalidGameName, MESSAGE.GameName(name, why));
  if (Array.from(name).length > EXPORT_NAME_MAX_CHARS) {
    throw refuse(ArchiveRefusal.InvalidGameName, MESSAGE.GameName(name, MESSAGE.Why.Long));
  }
  return name;
}

/**
 * The Windows folder and `.exe` name for a game's title: characters Windows refuses removed,
 * whitespace collapsed, no leading `-`/`.` or trailing dot/space, at most 64 characters; a device
 * name gets " Game" after its base, and nothing usable becomes "Game".
 */
export function windowsExportName(title: string): string {
  const cleaned = title
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\p{Cc}\p{Cs}]/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/^[-.\s]+|[.\s]+$/gu, "");
  if (!cleaned) return "Game";
  // The cap comes after the device rewrite, which lengthens the name.
  const capped = Array.from(notADevice(cleaned)).slice(0, EXPORT_NAME_MAX_CHARS).join("");
  return capped.replace(/[.\s]+$/u, "");
}

/** `name` with " Game" after its base when Windows would read it as a device (`nul.txt` → `nul Game.txt`). */
function notADevice(name: string): string {
  if (!isDeviceName(name)) return name;
  const dot = name.indexOf(".");
  const base = (dot < 0 ? name : name.slice(0, dot)).trimEnd();
  return `${base} Game${dot < 0 ? "" : name.slice(dot)}`;
}

/**
 * The Linux folder and executable name for a game's title: lowercase ASCII letters and digits
 * joined by `-`, at most 64 characters; nothing usable becomes "game", and a Windows device name
 * gets "-game" so the archive's one rule set accepts it.
 */
export function linuxExportName(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const capped = slug.slice(0, EXPORT_NAME_MAX_CHARS).replace(/-+$/u, "");
  if (!capped) return "game";
  return isDeviceName(capped) ? `${capped}-game` : capped;
}

/** The Windows archive's file name. */
export const windowsArchiveName = (name: string): string => `${name}-windows-x64.zip`;
/** The Linux archive's file name. */
export const linuxArchiveName = (name: string): string => `${name}-linux-x64.tar.gz`;

// ---------- notices and README ----------

const RULE = "=".repeat(72);

/** One line, with control characters (a hostile source label's newlines) turned into spaces. */
const oneLine = (text: string) => text.replace(/\p{Cc}/gu, " ").trim();

/**
 * The NOTICES text for `target`: every component the destination ships (in table order), then
 * the game's own `third_party` licences, each under a heading naming where it was read. Refuses
 * when a required component has no non-blank text. Windows gets CRLF line ends.
 */
export function composeNotices(target: ArchiveTarget, gameName: string, notices: readonly NoticeText[]): string {
  for (const component of REQUIRED_NOTICES[target]) {
    const present = notices.some((notice) => notice.component === component && notice.text.trim() !== "");
    if (!present) throw refuse(ArchiveRefusal.MissingNotice, MESSAGE.Notice(NOTICE_TITLES[component]));
  }
  const order: readonly NoticeComponent[] = Object.values(NoticeComponent);
  const sorted = [...notices]
    .filter((notice) => notice.text.trim() !== "")
    .sort(
      (a, b) =>
        order.indexOf(a.component) - order.indexOf(b.component) ||
        Buffer.compare(Buffer.from(a.source), Buffer.from(b.source)),
    );
  const sections = sorted.map(
    (notice) =>
      `${RULE}\n${NOTICE_TITLES[notice.component]} (${oneLine(notice.source)})\n${RULE}\n\n${notice.text.replace(/\r\n?/gu, "\n").trim()}\n`,
  );
  const head = `Third-party software in ${gameName}\n\n${gameName} includes the software below. Each part's licence follows its heading.\n`;
  return lineEnds(target, [head, ...sections].join("\n"));
}

const lineEnds = (target: ArchiveTarget, text: string) =>
  target === BuildTarget.Windows ? text.replace(/\n/gu, "\r\n") : text;

const HOST_PHRASE = {
  [StudioPlatform.Mac]: "a Mac",
  [StudioPlatform.Windows]: "Windows",
  [StudioPlatform.Linux]: "Linux",
} as const satisfies Record<StudioPlatform, string>;

/** The player-facing README text, per destination. */
const README = {
  NotRun: (builtOn: StudioPlatform, os: string) =>
    `This copy was built on ${HOST_PHRASE[builtOn]} and has not been run on ${os} by Genex. If it does not start, tell the person who made it what you saw.\n`,
  Windows: (name: string, signed: boolean) =>
    [
      `${name} for Windows\n`,
      "How to play",
      "1. Extract the whole zip first (right-click it, then Extract All). The game does not run from inside the zip.",
      `2. Open the ${name} folder and double-click ${name}.exe. Keep the .dll files and the assets folder next to it.\n`,
      "If Windows stops it",
      signed
        ? 'This game is signed with its maker\'s code-signing certificate. While that certificate is new, Microsoft Defender SmartScreen may still show "Windows protected your PC": choose More info, then Run anyway.'
        : 'This game is not signed with a code-signing certificate, so Microsoft Defender SmartScreen may show "Windows protected your PC": choose More info, then Run anyway.',
      "If Smart App Control is on, Windows may block the game with no option to run it; Smart App Control has no exception for a single app.\n",
      "Requirements",
      "Windows 10 (22H2) or Windows 11, 64-bit (x64). Windows 11 on Arm runs it through emulation.",
      "A graphics card with DirectX 11. Without one, Windows draws the game in software, slowly.\n",
      "Saves",
      "Saves are kept in your %APPDATA% folder, so replacing this folder keeps them.\n",
      "Check the files (optional)",
      `${SUMS_FILE} lists each file's SHA-256 digest. In PowerShell: Get-FileHash <file>\n`,
      `Third-party licences are in ${NOTICES_FILE}.\n`,
    ].join("\n"),
  Linux: (name: string) =>
    [
      `${name} for Linux (x86-64)\n`,
      "How to play",
      `  tar -xzf ${linuxArchiveName(name)}`,
      `  cd ${name}`,
      `  ./${name}`,
      `Keep the .so files, ${LinuxRuntimeFile.SwiftShaderIcd} and the assets folder next to ${name}.\n`,
      "Check the files (optional)",
      `  sha256sum -c ${SUMS_FILE}\n`,
      "Requirements",
      "- 64-bit x86 Linux with glibc 2.28 or newer (RHEL or AlmaLinux 8, Debian 10, Ubuntu 20.04 and later).",
      "- An X11 session, or XWayland on a Wayland desktop (GNOME and KDE run it by default), with libxcb (libxcb.so.1, which desktop systems already have): the game opens its window on X11.",
      "- A Vulkan 1.1 driver for your graphics card (Mesa or NVIDIA). Without one, the bundled SwiftShader draws the game on the CPU, slowly.\n",
      "Saves",
      "Saves are kept under $XDG_DATA_HOME (usually ~/.local/share), so replacing this folder keeps them.\n",
      `Third-party licences are in ${NOTICES_FILE}.\n`,
    ].join("\n"),
  RustWindows: (name: string, signed: boolean) =>
    [
      `${name} for Windows\n`,
      "How to play",
      "1. Extract the whole zip first (right-click it, then Extract All). The game does not run from inside the zip.",
      `2. Open the ${name} folder and double-click ${name}.exe. Keep the assets folder next to it.\n`,
      "If Windows stops it",
      signed
        ? 'This game is signed with its maker\'s code-signing certificate. While that certificate is new, Microsoft Defender SmartScreen may still show "Windows protected your PC": choose More info, then Run anyway.'
        : 'This game is not signed with a code-signing certificate, so Microsoft Defender SmartScreen may show "Windows protected your PC": choose More info, then Run anyway.',
      "If Smart App Control is on, Windows may block the game with no option to run it; Smart App Control has no exception for a single app.\n",
      "Requirements",
      "Windows 10 (22H2) or Windows 11, 64-bit (x64). Windows 11 on Arm runs it through emulation.",
      "A graphics card with DirectX 12 and WebGPU-class drivers. Without one, the game says the graphics card is not supported and closes.\n",
      "Saves",
      "Saves are kept in your %APPDATA% folder, so replacing this folder keeps them.\n",
      "Check the files (optional)",
      `${SUMS_FILE} lists each file's SHA-256 digest. In PowerShell: Get-FileHash <file>\n`,
      `Third-party licences are listed in ${NOTICES_FILE}; their texts are in the ${NOTICES_FOLDER} folder.\n`,
    ].join("\n"),
  UntestedGpu:
    "Genex ran this build only on Microsoft's software renderer (WARP), never on a real graphics card. If it does not start or draws wrongly, tell the person who made it what you saw.\n",
} as const;

function windowsReadme(input: WindowsArchiveInput): string {
  const notRun = input.ranOnTarget ? "" : `\n${README.NotRun(input.builtOn, "Windows")}`;
  return lineEnds(BuildTarget.Windows, `${README.Windows(input.name, input.signed === true)}${notRun}`);
}

function rustWindowsReadme(input: RustWindowsArchiveInput): string {
  const untested = input.gpuQualification === GpuQualification.Untested ? `\n${README.UntestedGpu}` : "";
  return lineEnds(BuildTarget.Windows, `${README.RustWindows(input.name, input.signed === true)}${untested}`);
}

function linuxReadme(input: LinuxArchiveInput): string {
  const notRun = input.ranOnTarget ? "" : `\n${README.NotRun(input.builtOn, "Linux")}`;
  return `${README.Linux(input.name)}${notRun}`;
}

// ---------- layouts ----------

const fileItem = (rel: string, content: ArchiveContent, executable = false): ArchiveItem => ({
  kind: ArchiveItemKind.File,
  path: rel,
  content,
  executable,
});
const textItem = (rel: string, text: string): ArchiveItem => fileItem(rel, { bytes: Buffer.from(text, "utf8") });

/** The entries every desktop layout shares: the folder, its assets, the notices and the README. */
function sharedItems(
  root: string,
  input: DestinationArchiveInput<string>,
  notices: string,
  readme: string,
): ArchiveItem[] {
  return [
    { kind: ArchiveItemKind.Dir, path: root },
    { kind: ArchiveItemKind.Dir, path: `${root}/assets` },
    ...input.assets.map((asset) => fileItem(`${root}/assets/${asset.path}`, asset.content)),
    textItem(`${root}/${NOTICES_FILE}`, notices),
    textItem(`${root}/${README_FILE}`, readme),
  ];
}

/** `<Game>/<Game>.exe`, the three runtime DLLs, `assets/`, NOTICES and README. */
export function windowsArchiveItems(input: WindowsArchiveInput): ArchiveItem[] {
  const root = checkGameName(input.name);
  const notices = composeNotices(BuildTarget.Windows, root, input.notices);
  const runtime = Object.values(WindowsRuntimeFile).map((name) => fileItem(`${root}/${name}`, input.runtime[name]));
  return [
    fileItem(`${root}/${root}.exe`, input.executable, true),
    ...runtime,
    ...sharedItems(root, input, notices, windowsReadme(input)),
  ];
}

/**
 * A Rust · wgpu game's Windows layout: `<Game>/<Game>.exe`, `assets/`, the notices index as
 * {@link NOTICES_FILE} with each licence under `notices/`, and README. No runtime DLL: the C
 * runtime is linked in and D3D12 and its shader compiler are Windows' own.
 */
export function rustWindowsArchiveItems(input: RustWindowsArchiveInput): ArchiveItem[] {
  const root = checkGameName(input.name);
  const notices = input.notices.files.map((file) => fileItem(`${root}/${NOTICES_FOLDER}/${file.path}`, file.content));
  return [
    fileItem(`${root}/${root}.exe`, input.executable, true),
    { kind: ArchiveItemKind.Dir, path: root },
    { kind: ArchiveItemKind.Dir, path: `${root}/assets` },
    ...input.assets.map((asset) => fileItem(`${root}/assets/${asset.path}`, asset.content)),
    ...notices,
    textItem(`${root}/${NOTICES_FILE}`, lineEnds(BuildTarget.Windows, input.notices.index)),
    textItem(`${root}/${README_FILE}`, rustWindowsReadme(input)),
  ];
}

/** `<game>/<game>` (0755), ANGLE, the Vulkan loader, SwiftShader and its ICD, `assets/`, NOTICES and README. */
export function linuxArchiveItems(input: LinuxArchiveInput): ArchiveItem[] {
  const root = checkGameName(input.name);
  if (!LINUX_NAME.test(root)) {
    throw refuse(ArchiveRefusal.InvalidGameName, MESSAGE.GameName(root, MESSAGE.Why.LinuxName));
  }
  const notices = composeNotices(BuildTarget.Linux, root, input.notices);
  const runtime = Object.values(LinuxRuntimeFile).map((name) => fileItem(`${root}/${name}`, input.runtime[name]));
  return [
    fileItem(`${root}/${root}`, input.executable, true),
    ...runtime,
    ...sharedItems(root, input, notices, linuxReadme(input)),
  ];
}

// ---------- the plan: every name checked, folders implied, one order ----------

/** One entry as it will be written: its name (folders end in `/`) and its item. */
interface PlannedEntry {
  name: string;
  item: ArchiveItem;
}

/**
 * The fold NTFS and APFS apply: names equal here are one file there. Upper then lower case folds
 * ſ/s, ς/σ, µ/μ and ß/ss as well; folding a few names a filesystem keeps apart only refuses more.
 */
const foldedName = (rel: string) => rel.normalize("NFD").toUpperCase().toLowerCase().normalize("NFC");

const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Adds `item` and every folder above it to `entries`, refusing two different entries on one folded name. */
function addEntry(entries: Map<string, ArchiveItem>, item: ArchiveItem): void {
  const segments = item.path.split("/");
  for (let depth = 1; depth < segments.length; depth++) {
    addEntry(entries, { kind: ArchiveItemKind.Dir, path: segments.slice(0, depth).join("/") });
  }
  const key = foldedName(item.path);
  const existing = entries.get(key);
  const sameFolder =
    existing?.kind === ArchiveItemKind.Dir && item.kind === ArchiveItemKind.Dir && existing.path === item.path;
  if (existing && !sameFolder) throw refuse(ArchiveRefusal.DuplicateName, MESSAGE.Duplicate(item.path));
  entries.set(key, item);
}

/**
 * Every entry checked and sorted, with the folders above each one, before anything is written.
 * `reserved` are names written after the sorted entries (the Linux `SHA256SUMS`), checked too.
 */
function planEntries(items: readonly ArchiveItem[], reserved: readonly string[] = []): PlannedEntry[] {
  const entries = new Map<string, ArchiveItem>();
  for (const rel of reserved) checkArchivePath(rel);
  for (const item of items) {
    checkArchivePath(item.path);
    addEntry(entries, item);
  }
  for (const rel of reserved) {
    if (entries.has(foldedName(rel))) throw refuse(ArchiveRefusal.DuplicateName, MESSAGE.Duplicate(rel));
  }
  return [...entries.values()]
    .map((item) => ({ name: item.kind === ArchiveItemKind.Dir ? `${item.path}/` : item.path, item }))
    .sort((a, b) => byBytes(a.name, b.name));
}

// ---------- content ----------

/** The held credentials worth looking for, as bytes. */
function secretNeedles(values: Iterable<string> | undefined): Buffer[] {
  const unique = new Set([...(values ?? [])].filter((value) => value.length >= MIN_SECRET_LENGTH));
  return [...unique].map((value) => Buffer.from(value, "utf8"));
}

/** Filesystem codes that mean the name is not there (or a folder on its way is not). */
const MISSING_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);
/** Filesystem codes that mean the file is there but this process may not read it. */
const UNREADABLE_CODES: ReadonlySet<string> = new Set(["EACCES", "EPERM"]);

/**
 * Every filesystem failure reading `rel`, as a typed refusal naming the entry. The raw error
 * stays as `cause` for logs. A socket, device or link (whatever code the host gives) is not a
 * regular file.
 */
function readRefusal(error: unknown, rel: string): NativeArchiveError {
  if (error instanceof NativeArchiveError) return error;
  const code = String((error as NodeJS.ErrnoException | null)?.code ?? "");
  if (MISSING_CODES.has(code)) return new NativeArchiveError(ArchiveRefusal.MissingFile, MESSAGE.Missing(rel), error);
  if (UNREADABLE_CODES.has(code)) {
    return new NativeArchiveError(ArchiveRefusal.Unreadable, MESSAGE.Unreadable(rel), error);
  }
  return new NativeArchiveError(ArchiveRefusal.NotARegularFile, MESSAGE.NotRegular(rel), error);
}

const sameFile = (info: BigIntStats, pin: FileIdentity) => info.dev === pin.dev && info.ino === pin.ino;

/** Refuses an opened file that is not the regular file `pinned` names, has another name, or is too large. */
function checkOpened(info: BigIntStats, pinned: FileIdentity | undefined, rel: string): void {
  if (!info.isFile()) throw refuse(ArchiveRefusal.NotARegularFile, MESSAGE.NotRegular(rel));
  if (pinned && !sameFile(info, pinned)) throw refuse(ArchiveRefusal.NotARegularFile, MESSAGE.Changed(rel));
  if (pinned && info.nlink !== 1n) throw refuse(ArchiveRefusal.NotARegularFile, MESSAGE.HardLink(rel));
  if (info.size > BigInt(ARCHIVE_FILE_MAX_BYTES)) throw refuse(ArchiveRefusal.TooLarge, MESSAGE.TooLarge(rel));
}

/**
 * A file's bytes: opened without following a link at its name and without blocking on a FIFO,
 * then required to be a regular file (the pinned one, when pinned) no larger than the cap, also
 * while it grows.
 */
async function readFileContent(content: { file: string; pinned?: FileIdentity }, rel: string): Promise<Buffer> {
  const handle = await openNoFollow(content.file, FS.O_RDONLY | FS.O_NONBLOCK);
  try {
    checkOpened(await handle.stat({ bigint: true }), content.pinned, rel);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, ARCHIVE_FILE_MAX_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > ARCHIVE_FILE_MAX_BYTES) throw refuse(ArchiveRefusal.TooLarge, MESSAGE.TooLarge(rel));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

/** A file entry's bytes, read now (never through a link), refused if too large or holding a held credential. */
async function contentOf(rel: string, content: ArchiveContent, secrets: readonly Buffer[]): Promise<Buffer> {
  const data =
    "bytes" in content
      ? Buffer.from(content.bytes.buffer, content.bytes.byteOffset, content.bytes.byteLength)
      : await readFileContent(content, rel).catch((error: unknown) => {
          throw readRefusal(error, rel);
        });
  if (data.length > ARCHIVE_FILE_MAX_BYTES) throw refuse(ArchiveRefusal.TooLarge, MESSAGE.TooLarge(rel));
  if (secrets.some((secret) => data.includes(secret))) throw refuse(ArchiveRefusal.SecretFound, MESSAGE.Secret(rel));
  return data;
}

/**
 * A content's bytes, read as the archive reads them: never through a link, a pinned file only if
 * it is still that file, within the size cap. For a caller that checks a digest before packing.
 */
export async function readArchiveContent(content: ArchiveContent, rel: string): Promise<Buffer> {
  return contentOf(rel, content, []);
}

const EMPTY = Buffer.alloc(0);

/** How an archive reads its files' bytes: the credentials to refuse, and the caller's own look. */
interface EntryReading {
  secrets: readonly Buffer[];
  inspect?: WriteOptions["inspect"];
}

const readingOf = (options: WriteOptions): EntryReading => ({
  secrets: secretNeedles(options.secretValues),
  inspect: options.inspect,
});

async function entryData(entry: PlannedEntry, read: EntryReading): Promise<Buffer> {
  if (entry.item.kind !== ArchiveItemKind.File) return EMPTY;
  const data = await contentOf(entry.item.path, entry.item.content, read.secrets);
  read.inspect?.(entry.name, data);
  return data;
}

/** The permission bits an entry is written with. */
function modeOf(item: ArchiveItem): number {
  if (item.kind === ArchiveItemKind.Dir) return MODE_DIR;
  return item.executable ? MODE_EXECUTABLE : MODE_FILE;
}

// ---------- zip ----------

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
/** Version 2.0: deflate and folders. */
const ZIP_VERSION = 20;
/** "Made by" Unix 2.0, so readers apply the Unix mode in the external attributes. */
const ZIP_MADE_BY_UNIX = (3 << 8) | ZIP_VERSION;
/** General-purpose bit 11: the name is UTF-8. */
const ZIP_UTF8 = 0x0800;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;
/** MS-DOS 1980-01-01 00:00:00 (date: day 1, month 1, year 0 = 1980; time: 0). */
const DOS_DATE = (1 << 5) | 1;
const DOS_TIME = 0;
const DOS_DIRECTORY = 0x10;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

/** One zip member's header facts. */
interface ZipMember {
  name: Buffer;
  method: number;
  crc: number;
  size: number;
  stored: Buffer;
  external: number;
}

/** zlib's raw deflate on the thread pool, so a large export does not stall the main process. */
const deflateRawAsync = promisify(deflateRaw);

async function zipMember(entry: PlannedEntry, data: Buffer): Promise<ZipMember> {
  const deflated = data.length > 0 ? await deflateRawAsync(data, { level: DEFLATE_LEVEL }) : EMPTY;
  const useDeflate = deflated.length < data.length;
  const isDir = entry.item.kind === ArchiveItemKind.Dir;
  const unixMode = (isDir ? S_IFDIR : S_IFREG) | modeOf(entry.item);
  return {
    name: Buffer.from(entry.name, "utf8"),
    method: useDeflate ? ZIP_DEFLATED : ZIP_STORED,
    crc: crc32(data),
    size: data.length,
    stored: useDeflate ? deflated : data,
    external: ((unixMode << 16) | (isDir ? DOS_DIRECTORY : 0)) >>> 0,
  };
}

/** The fields the local and central headers share, from "version needed" through the name length. */
function zipCommon(member: ZipMember): Buffer {
  const common = Buffer.alloc(24);
  common.writeUInt16LE(ZIP_VERSION, 0);
  common.writeUInt16LE(ZIP_UTF8, 2);
  common.writeUInt16LE(member.method, 4);
  common.writeUInt16LE(DOS_TIME, 6);
  common.writeUInt16LE(DOS_DATE, 8);
  common.writeUInt32LE(member.crc, 10);
  common.writeUInt32LE(member.stored.length, 14);
  common.writeUInt32LE(member.size, 18);
  common.writeUInt16LE(member.name.length, 22);
  return common;
}

function zipLocalHeader(member: ZipMember): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(ZIP_LOCAL, 0);
  return Buffer.concat([head, zipCommon(member), Buffer.alloc(2), member.name]);
}

function zipCentralHeader(member: ZipMember, offset: number): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt32LE(ZIP_CENTRAL, 0);
  head.writeUInt16LE(ZIP_MADE_BY_UNIX, 4);
  const tail = Buffer.alloc(16);
  // extra length, comment length, disk, internal attributes are 0
  tail.writeUInt32LE(member.external, 8);
  tail.writeUInt32LE(offset, 12);
  return Buffer.concat([head, zipCommon(member), tail, member.name]);
}

function zipEnd(count: number, size: number, offset: number): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return end;
}

const tooLarge = (what: string) => refuse(ArchiveRefusal.TooLarge, MESSAGE.TooLarge(what));

/** Zip and tar options: `sums` names a `SHA256SUMS` entry written last, listing every file in its folder. */
export interface SumsOptions extends WriteOptions {
  sums?: string;
}

/** Collects the `SHA256SUMS` lines for the files under the sums entry's folder, as they are written. */
function sumsCollector(sums: string | null): {
  add(entry: PlannedEntry, data: Buffer): void;
  entry(): PlannedEntry | null;
} {
  const folder = sums === null ? null : `${path.posix.dirname(sums)}/`;
  const digests: Array<readonly [string, string]> = [];
  return {
    add(entry, data) {
      const listed = folder !== null && entry.item.kind === ArchiveItemKind.File && entry.name.startsWith(folder);
      if (listed) digests.push([entry.name.slice(folder.length), createHash("sha256").update(data).digest("hex")]);
    },
    entry() {
      if (sums === null) return null;
      return { name: sums, item: textItem(sums, sumsText(digests)) };
    },
  };
}

async function zipPlanned(
  entries: readonly PlannedEntry[],
  sink: ArchiveSink,
  options: SumsOptions,
): Promise<string[]> {
  const count = entries.length + (options.sums ? 1 : 0);
  if (count > ZIP32_MAX_ENTRIES) throw refuse(ArchiveRefusal.TooLarge, MESSAGE.TooMany(count));
  const read = readingOf(options);
  const sums = sumsCollector(options.sums ?? null);
  const central: Buffer[] = [];
  const written: string[] = [];
  let offset = 0;
  const writeMember = async (entry: PlannedEntry, data: Buffer) => {
    const member = await zipMember(entry, data);
    const local = zipLocalHeader(member);
    central.push(zipCentralHeader(member, offset));
    await sink.write(local);
    await sink.write(member.stored);
    offset += local.length + member.stored.length;
    written.push(entry.name);
    if (offset > ZIP32_MAX_BYTES) throw tooLarge("The zip");
  };
  for (const entry of entries) {
    const data = await entryData(entry, read);
    sums.add(entry, data);
    await writeMember(entry, data);
  }
  const sumsEntry = sums.entry();
  if (sumsEntry) await writeMember(sumsEntry, await entryData(sumsEntry, read));
  const directory = Buffer.concat(central);
  if (offset + directory.length > ZIP32_MAX_BYTES) throw tooLarge("The zip");
  await sink.write(directory);
  await sink.write(zipEnd(written.length, directory.length, offset));
  return written;
}

/** Writes `items` as a deterministic zip to `sink`; answers the entry names in order. */
export async function writeZip(
  items: readonly ArchiveItem[],
  sink: ArchiveSink,
  options: SumsOptions = {},
): Promise<string[]> {
  return zipPlanned(planEntries(items, options.sums ? [options.sums] : []), sink, options);
}

// ---------- tar.gz ----------

const TAR_FILE = "0";
const TAR_DIR = "5";
const TAR_PAX = "x";
const TAR_NAME_BYTES = 100;
const TAR_PREFIX_BYTES = 155;
/** The pax header's own name: readers that know pax ignore it. */
const TAR_PAX_NAME = "PaxHeader";
/** gzip header: deflate, no flags, mtime 0, no extra flags, OS 3 (Unix) on every host. */
const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);

function writeOctal(header: Buffer, value: number, offset: number, length: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "latin1");
}

/** The ustar `name`/`prefix` split of `name`, or null when it does not fit (a pax header carries it). */
function ustarSplit(name: Buffer): { prefix: Buffer; name: Buffer } | null {
  if (name.length <= TAR_NAME_BYTES) return { prefix: EMPTY, name };
  for (let at = name.indexOf(0x2f); at >= 0; at = name.indexOf(0x2f, at + 1)) {
    const rest = name.subarray(at + 1);
    const fits = at <= TAR_PREFIX_BYTES && rest.length > 0 && rest.length <= TAR_NAME_BYTES;
    if (fits) return { prefix: name.subarray(0, at), name: rest };
  }
  return null;
}

function tarHeader(fields: { prefix: Buffer; name: Buffer }, mode: number, size: number, type: string): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  fields.name.copy(header, 0);
  writeOctal(header, mode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, ARCHIVE_EPOCH_SECONDS, 136, 12);
  header.write(type, 156, 1, "latin1");
  header.write("ustar\0" + "00", 257, 8, "latin1");
  fields.prefix.copy(header, 345);
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return header;
}

const tarPadding = (size: number) => Buffer.alloc((TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES);

/** One pax `path` record: its length prefix counts itself. */
function paxPath(value: string): Buffer {
  const body = Buffer.from(` path=${value}\n`, "utf8");
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return Buffer.concat([Buffer.from(String(length), "latin1"), body]);
}

/** An entry's blocks: a pax header first when its name fits no ustar field, then its header and data. */
function tarEntry(name: string, mode: number, data: Buffer, type: string): Buffer[] {
  const nameBytes = Buffer.from(name, "utf8");
  const split = ustarSplit(nameBytes);
  if (split) return [tarHeader(split, mode, data.length, type), data, tarPadding(data.length)];
  const pax = paxPath(name);
  const stand = Buffer.from(createHash("sha256").update(nameBytes).digest("hex").slice(0, 32), "latin1");
  const paxHeader = tarHeader(
    { prefix: EMPTY, name: Buffer.from(TAR_PAX_NAME, "latin1") },
    MODE_FILE,
    pax.length,
    TAR_PAX,
  );
  return [
    paxHeader,
    pax,
    tarPadding(pax.length),
    tarHeader({ prefix: EMPTY, name: stand }, mode, data.length, type),
    data,
    tarPadding(data.length),
  ];
}

/** `sha256sum -c` lines for the files under `dir/`, relative to it. */
function sumsText(digests: ReadonlyArray<readonly [string, string]>): string {
  return digests.map(([rel, digest]) => `${digest}  ${rel}\n`).join("");
}

/** The tar stream: each entry in order, then the sums file, the end blocks and record padding. */
async function* tarStream(
  entries: readonly PlannedEntry[],
  read: EntryReading,
  sums: string | null,
): AsyncGenerator<Buffer> {
  const collector = sumsCollector(sums);
  let total = 0;
  const emit = (entry: PlannedEntry, data: Buffer) => {
    const isFile = entry.item.kind === ArchiveItemKind.File;
    const blocks = tarEntry(entry.name, modeOf(entry.item), data, isFile ? TAR_FILE : TAR_DIR);
    for (const block of blocks) total += block.length;
    return blocks;
  };
  for (const entry of entries) {
    const data = await entryData(entry, read);
    collector.add(entry, data);
    yield* emit(entry, data);
  }
  const sumsEntry = collector.entry();
  if (sumsEntry) yield* emit(sumsEntry, await entryData(sumsEntry, read));
  const end = 2 * TAR_BLOCK_BYTES;
  yield Buffer.alloc(end + ((TAR_RECORD_BYTES - ((total + end) % TAR_RECORD_BYTES)) % TAR_RECORD_BYTES));
}

/** gzips `source` into `sink` with a header that names no time and the same OS on every host. */
async function gzipInto(sink: ArchiveSink, source: AsyncIterable<Buffer>): Promise<void> {
  let crc = 0;
  let size = 0;
  async function* counted() {
    for await (const chunk of source) {
      crc = crc32(chunk, crc);
      size += chunk.length;
      yield chunk;
    }
  }
  await sink.write(GZIP_HEADER);
  await pipeline(
    Readable.from(counted()),
    createDeflateRaw({ level: DEFLATE_LEVEL }),
    async (deflated: AsyncIterable<Buffer>) => {
      for await (const chunk of deflated) await sink.write(chunk);
    },
  );
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc >>> 0, 0);
  trailer.writeUInt32LE(size % 2 ** 32, 4);
  await sink.write(trailer);
}

/** Tar options: the same as a zip's. */
export type TarOptions = SumsOptions;

async function tarGzPlanned(
  entries: readonly PlannedEntry[],
  sink: ArchiveSink,
  options: TarOptions,
): Promise<string[]> {
  await gzipInto(sink, tarStream(entries, readingOf(options), options.sums ?? null));
  const names = entries.map((entry) => entry.name);
  return options.sums ? [...names, options.sums] : names;
}

/** Writes `items` as a deterministic tar.gz to `sink`; answers the entry names in order. */
export async function writeTarGz(
  items: readonly ArchiveItem[],
  sink: ArchiveSink,
  options: TarOptions = {},
): Promise<string[]> {
  return tarGzPlanned(planEntries(items, options.sums ? [options.sums] : []), sink, options);
}

// ---------- the target file ----------

/** Writes an archive to `file` through a partial file renamed over it only when complete. */
async function writeTarget(file: string, write: (sink: ArchiveSink) => Promise<string[]>): Promise<ArchiveSummary> {
  const existing = await lstat(file).catch(() => null);
  if (existing && !existing.isFile()) throw refuse(ArchiveRefusal.NotARegularFile, MESSAGE.Target(file));
  const partial = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.partial`);
  const handle = await openNoFollow(partial, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, MODE_FILE);
  const hash = createHash("sha256");
  let bytes = 0;
  const sink: ArchiveSink = {
    async write(chunk) {
      hash.update(chunk);
      bytes += chunk.length;
      await handle.writeFile(chunk);
    },
  };
  try {
    const entries = await write(sink);
    await handle.sync();
    await handle.close();
    await rename(partial, file);
    return { file, bytes, sha256: hash.digest("hex"), entries };
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(partial, { force: true });
    throw error;
  }
}

/** Writes the Windows export zip, `SHA256SUMS` included, to `file` (see {@link windowsArchiveName}); nothing lands when it is refused. */
export async function writeWindowsZip(
  file: string,
  input: WindowsArchiveInput,
  options: WriteOptions = {},
): Promise<ArchiveSummary> {
  const sums = `${input.name}/${SUMS_FILE}`;
  const entries = planEntries(windowsArchiveItems(input), [sums]);
  return writeTarget(file, (sink) => zipPlanned(entries, sink, { ...options, sums }));
}

/**
 * Writes a Rust · wgpu game's Windows export zip, `SHA256SUMS` included, to `file`; nothing lands
 * when it is refused. The same input gives the same bytes.
 */
export async function writeRustWindowsZip(
  file: string,
  input: RustWindowsArchiveInput,
  options: WriteOptions = {},
): Promise<ArchiveSummary> {
  const sums = `${input.name}/${SUMS_FILE}`;
  const entries = planEntries(rustWindowsArchiveItems(input), [sums]);
  return writeTarget(file, (sink) => zipPlanned(entries, sink, { ...options, sums }));
}

/** Writes the Linux export tar.gz, `SHA256SUMS` included, to `file`; nothing lands when it is refused. */
export async function writeLinuxTarGz(
  file: string,
  input: LinuxArchiveInput,
  options: WriteOptions = {},
): Promise<ArchiveSummary> {
  const items = linuxArchiveItems(input);
  const sums = `${input.name}/${SUMS_FILE}`;
  const entries = planEntries(items, [sums]);
  return writeTarget(file, (sink) => tarGzPlanned(entries, sink, { ...options, sums }));
}

/**
 * Writes `items` as a deterministic tar.gz to `file`, `sums` (the `SHA256SUMS` entry) last, with
 * the credential check and `inspect` over every file; nothing lands when it is refused.
 */
export async function writeTarGzTarget(
  file: string,
  items: readonly ArchiveItem[],
  options: WriteOptions & { sums: string },
): Promise<ArchiveSummary> {
  const entries = planEntries(items, [options.sums]);
  return writeTarget(file, (sink) => tarGzPlanned(entries, sink, options));
}

// ---------- assets from disk ----------

/** `full`'s identity, read without following a link at its name. */
async function identityOf(full: string, rel: string): Promise<BigIntStats> {
  return lstat(full, { bigint: true }).catch((error: unknown) => {
    throw readRefusal(error, rel);
  });
}

/**
 * `file` pinned as it is now: a regular file with no other name, which the archive must find again
 * (same device and inode) when it reads it. Pin every file from a folder the agent can write.
 */
export async function pinnedFile(file: string, rel = path.basename(file)): Promise<ArchiveContent> {
  const info = await identityOf(file, rel);
  if (!info.isFile()) throw refuse(ArchiveRefusal.NotARegularFile, MESSAGE.NotRegular(rel));
  if (info.nlink !== 1n) throw refuse(ArchiveRefusal.NotARegularFile, MESSAGE.HardLink(rel));
  return { file, pinned: { dev: info.dev, ino: info.ino } };
}

/**
 * One folder's files, pinned, then its subfolders. The folder must be the same real folder (not a
 * link) before its listing and after its files are pinned, so a folder swapped for a link while
 * it is walked refuses the tree.
 */
async function walkAssets(dir: string, rel: string, files: AssetFile[]): Promise<void> {
  const label = rel || dir;
  const before = await identityOf(dir, label);
  if (!before.isDirectory()) throw refuse(ArchiveRefusal.NotARegularFile, MESSAGE.NotAFolder(label));
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    throw readRefusal(error, label);
  });
  const subfolders: Array<readonly [string, string]> = [];
  for (const entry of entries) {
    if (excludedFromExport(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) subfolders.push([full, childRel]);
    else if (entry.isFile()) files.push({ path: childRel, content: await pinnedFile(full, childRel) });
    else throw refuse(ArchiveRefusal.NotARegularFile, MESSAGE.NotRegular(childRel));
  }
  const after = await identityOf(dir, label);
  if (!after.isDirectory() || !sameFile(after, before)) {
    throw refuse(ArchiveRefusal.NotARegularFile, MESSAGE.NotAFolder(label));
  }
  for (const [full, childRel] of subfolders) await walkAssets(full, childRel, files);
}

/**
 * The files under a game's assets folder, `/`-separated and sorted, leaving out the names no export
 * publishes (dotfiles, keys, logs: `excludedFromExport`). A link, hard link or special file
 * anywhere refuses the tree; a missing folder is no assets. Each file is pinned (see
 * {@link pinnedFile}); contents are read when the archive is written.
 */
export async function readAssetTree(root: string): Promise<AssetFile[]> {
  const info = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw readRefusal(error, root);
  });
  if (!info) return [];
  if (!info.isDirectory()) throw refuse(ArchiveRefusal.NotARegularFile, MESSAGE.NotAFolder(root));
  const files: AssetFile[] = [];
  await walkAssets(root, "", files);
  return files.sort((a, b) => byBytes(a.path, b.path));
}

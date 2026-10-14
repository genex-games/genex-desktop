/**
 * A Rust · wgpu game's Linux export archive (M4.2): `<game>-linux-x64.tar.gz` holding `<game>/`
 * with the admitted game (0755), the software Vulkan beside it at the root (the Vulkan loader,
 * SwiftShader and its ICD manifest, from the SwiftShader split, `swiftshader-bundle.ts`), the
 * assets, the notices index with each licence under `notices/`, a README and `SHA256SUMS`. No
 * ANGLE: wgpu draws through Vulkan, opening the loader with `dlopen` through the game's
 * `DT_RUNPATH` of `$ORIGIN` (`admitRustLinuxExport` in `main/rust-build-linux.ts`).
 *
 * The archive is the shared deterministic tar.gz writer's (`native-export-archive.ts`), so the
 * same inputs give the same bytes, written through a partial file with the credential scan and the
 * caller's `inspect` over every file. Admitting the executable (`admitRustLinuxExport`) and holding
 * it and each asset to the lane's admitted digests, staging the notices (`rust-notices.ts`'s Linux
 * row) and the receipt's GPU qualification are the export run's. No export run reaches a Rust game
 * yet (the export-run table refuses Rust Linux `lane-missing`): its run is wired, modelled on
 * `exportRustWindowsZip`, once the Rust recipe pins the cross components.
 *
 * The bundled SwiftShader is not reached on its own yet: the Vulkan loader searches only the
 * system's ICD folders, and nothing points it at the ICD manifest beside the game (the Linux game
 * box sets the driver path itself). Until the facade or a launcher does, the README promises no
 * software fallback.
 */
import { GpuQualification } from "../shared/game-export-contract.ts";
import {
  type ArchiveContent,
  type ArchiveItem,
  ArchiveItemKind,
  type ArchiveSummary,
  type AssetFile,
  NOTICES_FILE,
  README_FILE,
  SUMS_FILE,
  linuxArchiveName,
  type WriteOptions,
  writeTarGzTarget,
} from "./native-export-archive.ts";
import { LinuxVulkanFile } from "./native-runtime-files.ts";

/** The folder each licence file goes in, under the export's root. */
const NOTICES_FOLDER = "notices";
/** A game folder name a Linux export may use: what `linuxExportName` makes of a title. */
const GAME_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A notice file's relative path: plain segments only. */
const NOTICE_PATH = /^[A-Za-z0-9][A-Za-z0-9._+-]*(\/[A-Za-z0-9][A-Za-z0-9._+-]*)*$/;

const MESSAGE = {
  BadName: (name: string) => `${JSON.stringify(name)} is not a Linux export's game folder name`,
  BadNotice: (rel: string) => `${JSON.stringify(rel)} is not a notice file's relative path`,
  Readme: (name: string) =>
    [
      `${name} for Linux (x86-64)\n`,
      "How to play",
      `  tar -xzf ${linuxArchiveName(name)}`,
      `  cd ${name}`,
      `  ./${name}`,
      `Keep ${LinuxVulkanFile.VulkanLoader}, ${LinuxVulkanFile.SwiftShader}, ${LinuxVulkanFile.SwiftShaderIcd} and the assets folder next to ${name}.\n`,
      "Check the files (optional)",
      `  sha256sum -c ${SUMS_FILE}\n`,
      "Requirements",
      "- 64-bit x86 Linux with glibc 2.28 or newer (RHEL or AlmaLinux 8, Debian 10, Ubuntu 20.04 and later).",
      "- An X11 or Wayland desktop session.",
      "- A Vulkan driver for your graphics card with WebGPU-class features (Mesa or NVIDIA). Without one, the game says the graphics card is not supported and closes.\n",
      "Saves",
      "Saves are kept under $XDG_DATA_HOME (usually ~/.local/share), so replacing this folder keeps them.\n",
      `Third-party licences are listed in ${NOTICES_FILE}; their texts are in the ${NOTICES_FOLDER} folder.\n`,
    ].join("\n"),
  UntestedGpu:
    "Genex ran this build only on SwiftShader, a software renderer, never on a real graphics card. If it does not start or draws wrongly, tell the person who made it what you saw.\n",
} as const;

/** One licence file of the export's notices, `/`-separated under `notices/`. */
export interface RustLinuxNoticeFile {
  path: string;
  content: ArchiveContent;
}

/** What a Rust Linux export archive is made from: every byte already admitted or pinned. */
export interface RustLinuxArchiveInput {
  /** The game folder's and executable's name (`linuxExportName` of the title). */
  name: string;
  /** The admitted game's bytes or file. */
  executable: ArchiveContent | Uint8Array;
  assets: readonly AssetFile[];
  /** The SwiftShader split's runtime files, each its pin (`readSwiftShaderRuntime`). */
  runtime: Readonly<Record<LinuxVulkanFile, ArchiveContent | Uint8Array>>;
  notices: { index: string; files: readonly RustLinuxNoticeFile[] };
  /** What the README says about the GPUs this build ran on. */
  gpuQualification: GpuQualification;
}

const fileItem = (path: string, content: ArchiveContent, executable = false): ArchiveItem => ({
  kind: ArchiveItemKind.File,
  path,
  content,
  executable,
});

const contentOf = (value: ArchiveContent | Uint8Array): ArchiveContent =>
  value instanceof Uint8Array ? { bytes: value } : value;

function checkName(name: string): string {
  const runtime: readonly string[] = Object.values(LinuxVulkanFile);
  if (!GAME_NAME.test(name) || runtime.includes(name)) throw new TypeError(MESSAGE.BadName(name));
  return name;
}

function readme(input: RustLinuxArchiveInput): string {
  const untested = input.gpuQualification === GpuQualification.Untested ? `\n${MESSAGE.UntestedGpu}` : "";
  return `${MESSAGE.Readme(input.name)}${untested}`;
}

/**
 * A Rust · wgpu game's Linux layout: `<game>/<game>` (0755), the Vulkan loader, SwiftShader and its
 * ICD beside it (data, never programs), `assets/`, each licence under `notices/`, the notices index
 * as `THIRD-PARTY-NOTICES.txt` and README. Refuses a game name that is not one plain segment.
 */
export function rustLinuxArchiveItems(input: RustLinuxArchiveInput): ArchiveItem[] {
  const root = checkName(input.name);
  for (const file of input.notices.files)
    if (!NOTICE_PATH.test(file.path) || file.path.split("/").includes(".."))
      throw new TypeError(MESSAGE.BadNotice(file.path));
  const runtime = Object.values(LinuxVulkanFile).map((name) =>
    fileItem(`${root}/${name}`, contentOf(input.runtime[name])),
  );
  const text = (rel: string, value: string) => fileItem(`${root}/${rel}`, { bytes: Buffer.from(value) });
  return [
    fileItem(`${root}/${root}`, contentOf(input.executable), true),
    { kind: ArchiveItemKind.Dir, path: root },
    ...runtime,
    { kind: ArchiveItemKind.Dir, path: `${root}/assets` },
    ...input.assets.map((asset) => fileItem(`${root}/assets/${asset.path}`, asset.content)),
    ...input.notices.files.map((file) => fileItem(`${root}/${NOTICES_FOLDER}/${file.path}`, file.content)),
    text(NOTICES_FILE, input.notices.index),
    text(README_FILE, readme(input)),
  ];
}

/**
 * Writes the Rust Linux export to `file` with its `SHA256SUMS` last, refusing a file that holds one
 * of `options.secretValues` or that `options.inspect` throws on; nothing lands when it is refused.
 * Answers the archive's sha256, size and entries.
 */
export async function writeRustLinuxTarGz(
  input: RustLinuxArchiveInput,
  file: string,
  options: WriteOptions = {},
): Promise<ArchiveSummary> {
  const items = rustLinuxArchiveItems(input);
  return writeTarGzTarget(file, items, { ...options, sums: `${input.name}/${SUMS_FILE}` });
}

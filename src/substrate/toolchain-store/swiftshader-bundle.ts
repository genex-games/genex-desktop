/**
 * The software Vulkan a Rust · wgpu Linux game ships (M4.2): the Vulkan loader, SwiftShader and its
 * ICD manifest with their licences, split out of the pinned Linux ANGLE build (`linux-x64-vulkan`)
 * into a folder of their own with its own `manifest.json` (target `linux-x64-swiftshader`). A
 * Rust game uses no ANGLE, so it ships these files alone; a raylib game keeps them inside ANGLE's.
 *
 * The split's manifest is derived from the listed files' sha256 and size alone (no time, no host),
 * so it is the same wherever it is made from the same ANGLE bytes: `native/angle/bundle-lock.json`
 * pins it (`swiftshader`) beside the ANGLE builds, and the runtime files are also held to
 * `LINUX_VULKAN_FILE_PINS`, so a raylib and a Rust Linux game ship the same software Vulkan. The
 * app's build splits it from its bundled Linux ANGLE copy (`copyAngleTarget` in `bundled.ts`), a
 * packaged app's copy is verified with the ANGLE builds (`verifyAngleBundle`), and angle.yml
 * uploads the split from each Linux build for the owner to publish as a release asset.
 */
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isJsonObject } from "../fsx.ts";
import { LINUX_VULKAN_FILE_PINS, LinuxVulkanFile } from "../native-runtime-files.ts";
import {
  ARTIFACT_MANIFEST_FILE,
  ArtifactError,
  ArtifactFault,
  type ArtifactPin,
  assertExactly,
  assertOrigin,
  copyListed,
  type ListedFile,
  type PinnedManifest,
  plainFiles,
  readListed,
  readPinnedManifest,
  writeNew,
} from "./artifact.ts";

/** The split's build target, as its manifest and the lock name it. Wire value: never rename it. */
export const SWIFTSHADER_TARGET = "linux-x64-swiftshader";
/** The ANGLE build it is split from (`AngleTarget.LinuxX64Vulkan`). */
export const SWIFTSHADER_FROM = "linux-x64-vulkan";
/** The folder of the app's resources the split is bundled in: `<resources>/swiftshader/<target>/<commit12>`. */
export const SWIFTSHADER_RESOURCES_FOLDER = "swiftshader";
const MANIFEST_SCHEMA = 1;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const STAGING_PREFIX = ".staging-";

/**
 * The licence files of ANGLE's Linux build that cover what the split ships: SwiftShader and the
 * libraries it builds in, the Vulkan loader, and Chromium's libc++ both are linked with.
 */
export const SWIFTSHADER_LICENCES = {
  SwiftShader: [
    "licenses/third_party_SwiftShader.txt",
    "licenses/third_party_SwiftShader_third_party_SPIRV-Headers.txt",
    "licenses/third_party_SwiftShader_third_party_SPIRV-Tools.txt",
    "licenses/third_party_SwiftShader_third_party_marl.txt",
    "licenses/third_party_libc++.txt",
    "licenses/third_party_libc++abi.txt",
    "licenses/third_party_llvm-libc.txt",
  ],
  VulkanLoader: ["licenses/third_party_vulkan-loader.txt"],
} as const;

/** Every file the split holds besides its manifest, sorted as its manifest lists them. */
export const SWIFTSHADER_FILES: readonly string[] = Object.freeze(
  [...Object.values(LinuxVulkanFile), ...Object.values(SWIFTSHADER_LICENCES).flat()].sort(),
);

/** The split's pin in `native/angle/bundle-lock.json`: its target, the ANGLE build it comes from and its manifest. */
export interface SwiftShaderPin extends ArtifactPin {
  target: string;
  from: string;
}

const MESSAGE = {
  NotListed: (rel: string) => `The Linux ANGLE build lists no ${rel}, which the SwiftShader split ships.`,
  RuntimePin: (rel: string) => `${rel} in the Linux ANGLE build is not the pinned software Vulkan file.`,
  BadCommit: "The SwiftShader split needs ANGLE's full commit.",
  Missing: (folder: string) => `${folder} is not there: this build of Genex was made without the SwiftShader split.`,
  Link: (folder: string) => `${folder} is a link; a bundled build is a plain folder.`,
} as const;

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** The `swiftshader` pin of a bundle lock, shape-checked (its target and source the split's own), or null. */
export function parseSwiftShaderPin(value: unknown): SwiftShaderPin | null {
  if (!isJsonObject(value)) return null;
  const { target, from, manifestSha256, manifestBytes, files, bytes } = value;
  if (target !== SWIFTSHADER_TARGET || from !== SWIFTSHADER_FROM) return null;
  const counts = isCount(manifestBytes) && isCount(files) && isCount(bytes);
  if (typeof manifestSha256 !== "string" || !SHA256.test(manifestSha256) || !counts) return null;
  return { target, from, manifestSha256, manifestBytes, files, bytes };
}

/**
 * The split's `manifest.json` bytes for ANGLE `commit` and the listed files: target, source,
 * commit and each file's sha256 and size, sorted, two-space JSON with a final newline.
 */
export function swiftShaderManifest(commit: string, files: readonly ListedFile[]): Buffer {
  if (!COMMIT.test(commit)) throw new ArtifactError(ArtifactFault.Origin, MESSAGE.BadCommit);
  const sorted = [...files].sort((a, b) => (a.rel < b.rel ? -1 : Number(a.rel > b.rel)));
  const listed = Object.fromEntries(sorted.map((file) => [file.rel, { sha256: file.sha256, size: file.size }]));
  const manifest = {
    schema: MANIFEST_SCHEMA,
    target: SWIFTSHADER_TARGET,
    from: SWIFTSHADER_FROM,
    commit,
    files: listed,
  };
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * The files the split takes from a verified Linux ANGLE manifest: every {@link SWIFTSHADER_FILES}
 * entry, each runtime file also equal to its `LINUX_VULKAN_FILE_PINS` pin. Refuses an ANGLE build
 * that lists one of them not at all or with other bytes.
 */
export function swiftShaderFilesOf(angle: PinnedManifest): ListedFile[] {
  const byRel = new Map(angle.files.map((file) => [file.rel, file]));
  return SWIFTSHADER_FILES.map((rel) => {
    const file = byRel.get(rel);
    if (!file) throw new ArtifactError(ArtifactFault.ManifestShape, MESSAGE.NotListed(rel));
    const runtime = (LINUX_VULKAN_FILE_PINS as Readonly<Record<string, { sha256: string; size: number }>>)[rel];
    if (runtime && (runtime.sha256 !== file.sha256 || runtime.size !== file.size))
      throw new ArtifactError(ArtifactFault.FileDigest, MESSAGE.RuntimePin(rel));
    return file;
  });
}

/** Where the app's resources keep the split: `<resources>/swiftshader/linux-x64-swiftshader/<commit12>`. */
export function bundledSwiftShaderFolder(resources: string, commit: string): string {
  if (!COMMIT.test(commit)) throw new ArtifactError(ArtifactFault.BadPath, MESSAGE.BadCommit);
  return path.join(resources, SWIFTSHADER_RESOURCES_FOLDER, SWIFTSHADER_TARGET, commit.slice(0, 12));
}

/** A folder that must be a plain folder: absent is `missing`, anything else `not-regular`. */
async function plainFolder(folder: string): Promise<void> {
  const info = await lstat(folder).catch(() => null);
  if (!info) throw new ArtifactError(ArtifactFault.Missing, MESSAGE.Missing(folder));
  if (!info.isDirectory()) throw new ArtifactError(ArtifactFault.NotRegular, MESSAGE.Link(folder));
}

/**
 * Verifies a SwiftShader split in place: its `manifest.json` is the pinned one (sha256, size, file
 * count and bytes), names the lock's ANGLE commit and the split's target, and the folder holds
 * exactly the listed files, each its listed size and sha256, the runtime files their pins.
 */
export async function verifySwiftShaderFolder(
  folder: string,
  pin: SwiftShaderPin,
  commit: string,
): Promise<PinnedManifest> {
  await plainFolder(folder);
  const manifest = await readPinnedManifest(folder, pin);
  assertOrigin(manifest, { commit, target: SWIFTSHADER_TARGET });
  assertExactly(await plainFiles(folder), manifest.files, []);
  for (const file of manifest.files) await readListed(folder, file);
  swiftShaderFilesOf(manifest);
  return manifest;
}

/**
 * Splits the software Vulkan files out of a verified Linux ANGLE folder (`angleRoot`, whose pinned
 * manifest is `angle`) into `final`: assembled in a staging folder beside it, its manifest held to
 * `pin`, verified, then renamed into place over an earlier copy. A refused source leaves nothing.
 */
export async function splitSwiftShader(
  angleRoot: string,
  angle: PinnedManifest,
  final: string,
  pin: SwiftShaderPin,
  commit: string,
): Promise<{ folder: string; files: number; bytes: number }> {
  const files = swiftShaderFilesOf(angle);
  const manifest = swiftShaderManifest(commit, files);
  const parent = path.dirname(final);
  const staging = path.join(parent, `${STAGING_PREFIX}${path.basename(final)}`);
  await mkdir(parent, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  try {
    for (const file of files) await copyListed(angleRoot, staging, file);
    await writeNew(path.join(staging, ARTIFACT_MANIFEST_FILE), manifest);
    await verifySwiftShaderFolder(staging, pin, commit);
    await rm(final, { recursive: true, force: true });
    await rename(staging, final);
    return { folder: final, files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** The software Vulkan's runtime files and licences, read from a verified split. */
export interface SwiftShaderRuntime {
  /** The three files a Linux export ships beside the game, by name, each its pinned bytes. */
  files: Record<LinuxVulkanFile, Buffer>;
  /** The licence files' absolute paths per part, for the export's notices. */
  licences: { SwiftShader: string[]; VulkanLoader: string[] };
}

/** A verified split's runtime files (each its pin) and its licence paths; anything altered is refused. */
export async function readSwiftShaderRuntime(
  folder: string,
  pin: SwiftShaderPin,
  commit: string,
): Promise<SwiftShaderRuntime> {
  const manifest = await verifySwiftShaderFolder(folder, pin, commit);
  const byRel = new Map(manifest.files.map((file) => [file.rel, file]));
  const read = async (name: LinuxVulkanFile) => {
    const listed = byRel.get(name);
    if (!listed) throw new ArtifactError(ArtifactFault.ManifestShape, MESSAGE.NotListed(name));
    return (await readListed(folder, listed)).bytes;
  };
  const files = {
    [LinuxVulkanFile.VulkanLoader]: await read(LinuxVulkanFile.VulkanLoader),
    [LinuxVulkanFile.SwiftShader]: await read(LinuxVulkanFile.SwiftShader),
    [LinuxVulkanFile.SwiftShaderIcd]: await read(LinuxVulkanFile.SwiftShaderIcd),
  };
  const at = (rels: readonly string[]) => rels.map((rel) => path.join(folder, ...rel.split("/")));
  return {
    files,
    licences: {
      SwiftShader: at(SWIFTSHADER_LICENCES.SwiftShader),
      VulkanLoader: at(SWIFTSHADER_LICENCES.VulkanLoader),
    },
  };
}

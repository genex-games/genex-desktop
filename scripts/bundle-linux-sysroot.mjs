/** Bundle Linux build headers from the checked-in, digest-pinned archive; never use a download. */
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArchiveFormat } from "../src/shared/toolchain.ts";
import { readRegularFile } from "../src/substrate/fsx.ts";
import { extractArchive } from "../src/substrate/toolchain-store/archive.ts";
import { ArtifactError, ArtifactFault, sha256Hex } from "../src/substrate/toolchain-store/artifact.ts";
import {
  bundledLinuxSysrootFolder,
  copyLinuxSysrootBundle,
  LINUX_SYSROOT_BUNDLE_PIN,
  verifyLinuxSysrootFolder,
} from "../src/substrate/toolchain-store/linux-sysroot-bundle.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MESSAGE = {
  Archive: "The Linux sysroot archive differs from its checked-in size or sha256 pin.",
  NotPlain: "The Linux sysroot archive must be a plain file.",
};

/**
 * Verify the archive before extracting, then its manifest and every file before publishing resources.
 * @param {{ resources: string, root?: string, archive?: string,
 *   pin?: import('../src/substrate/toolchain-store/linux-sysroot-bundle.ts').LinuxSysrootBundlePin }} options
 */
export async function bundleLinuxSysroot({ resources, root = ROOT, archive, pin = LINUX_SYSROOT_BUNDLE_PIN }) {
  const source = archive ?? path.join(root, "native", "linux-sysroot", pin.archive.file);
  const info = await lstat(source).catch(() => null);
  if (!info) throw new ArtifactError(ArtifactFault.Missing, MESSAGE.NotPlain);
  if (!info.isFile()) throw new ArtifactError(ArtifactFault.NotRegular, MESSAGE.NotPlain);
  if (info.size !== pin.archive.bytes) throw new ArtifactError(ArtifactFault.FileDigest, MESSAGE.Archive);
  const bytes = await readRegularFile(source, pin.archive.bytes);
  if (bytes.length !== pin.archive.bytes || sha256Hex(bytes) !== pin.archive.sha256)
    throw new ArtifactError(ArtifactFault.FileDigest, MESSAGE.Archive);
  await mkdir(resources, { recursive: true });
  const staging = await mkdtemp(path.join(resources, ".linux-sysroot-"));
  try {
    await extractArchive(source, ArchiveFormat.TarGz, staging, { strip: 0, into: "" });
    const folder = await copyLinuxSysrootBundle(staging, resources, pin);
    return { folder, files: pin.files, bytes: pin.bytes };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Check the exact sysroot a built or packaged app includes. */
export async function verifyLinuxSysrootBundle(resources) {
  const folder = bundledLinuxSysrootFolder(resources);
  await verifyLinuxSysrootFolder(folder);
  return { folder, files: LINUX_SYSROOT_BUNDLE_PIN.files, bytes: LINUX_SYSROOT_BUNDLE_PIN.bytes };
}

/** Whether this is the command-line entry point, including a script reached through a symlink. */
async function runsAsScript() {
  if (!process.argv[1]) return false;
  return (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)));
}

if (await runsAsScript()) {
  const args = process.argv.slice(2);
  const verify = args.indexOf("--verify");
  const at = args.indexOf("--resources");
  const resources = path.resolve(at >= 0 ? args[at + 1] : path.join(ROOT, "dist", "resources"));
  try {
    const result =
      verify >= 0
        ? await verifyLinuxSysrootBundle(path.resolve(args[verify + 1]))
        : await bundleLinuxSysroot({ resources });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

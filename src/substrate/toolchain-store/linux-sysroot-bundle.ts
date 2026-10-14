/** Linux build headers shipped with Genex, pinned independently of any external download. */
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import pinJson from "../../../native/linux-sysroot/bundle-lock.json" with { type: "json" };
import { BuildTarget } from "../../shared/game-project.ts";
import { type ToolchainEntry, ToolchainId } from "../../shared/toolchain.ts";
import { isJsonObject } from "../fsx.ts";
import {
  ARTIFACT_MANIFEST_FILE,
  ArtifactError,
  ArtifactFault,
  type ArtifactPin,
  assertExactly,
  copyListed,
  plainFiles,
  readListed,
  readPinnedManifest,
  writeNew,
} from "./artifact.ts";

/** The app-resource folder containing Linux's build-only headers and protocol code. */
export const LINUX_SYSROOT_RESOURCES_FOLDER = "linux-sysroot";
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const STAGING_PREFIX = ".staging-";
const MESSAGE = {
  BadPin: "native/linux-sysroot/bundle-lock.json is not a Linux sysroot bundle pin.",
  NotPlain: (folder: string) => `${folder} is not a plain Linux sysroot folder.`,
  Origin: "The Linux sysroot manifest names another target or source image.",
} as const;

/** The sysroot artifact and the deterministic archive from which an app build provisions it. */
export interface LinuxSysrootBundlePin extends ArtifactPin {
  version: string;
  target: string;
  imageDigest: string;
  archive: { file: string; sha256: string; bytes: number };
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isName = (value: unknown): value is string => typeof value === "string" && SAFE_NAME.test(value);
const isDigest = (value: unknown): value is string => typeof value === "string" && SHA256.test(value);

/** A bundle pin with safe resource/archive names and complete digests, or null. */
export function parseLinuxSysrootPin(value: unknown): LinuxSysrootBundlePin | null {
  if (!isJsonObject(value) || value.schema !== 1) return null;
  const { version, target, imageDigest, manifestSha256, manifestBytes, files, bytes, archive } = value;
  if (!isName(version) || !isName(target) || typeof imageDigest !== "string" || !IMAGE_DIGEST.test(imageDigest))
    return null;
  const artifact = isDigest(manifestSha256) && isCount(manifestBytes) && isCount(files) && isCount(bytes);
  if (!artifact || !isJsonObject(archive)) return null;
  if (!isName(archive.file) || !isDigest(archive.sha256) || !isCount(archive.bytes)) return null;
  return {
    version,
    target,
    imageDigest,
    manifestSha256,
    manifestBytes,
    files,
    bytes,
    archive: { file: archive.file, sha256: archive.sha256, bytes: archive.bytes },
  };
}

const parsedPin = parseLinuxSysrootPin(pinJson);
if (!parsedPin) throw new Error(MESSAGE.BadPin);
/** The sole checked-in pin used by the manifest, app build and resource installer. */
export const LINUX_SYSROOT_BUNDLE_PIN: LinuxSysrootBundlePin = Object.freeze(parsedPin);

/** Whether `entry` is exactly the sysroot artifact this Genex build includes. */
export function isBundledLinuxSysroot(
  entry: ToolchainEntry,
  pin: LinuxSysrootBundlePin = LINUX_SYSROOT_BUNDLE_PIN,
): boolean {
  const { local } = entry;
  const destination = entry.host === null && entry.target === BuildTarget.Linux;
  if (entry.id !== ToolchainId.LinuxSysroot || !local || !destination || entry.archives.length !== 0) return false;
  return (
    entry.version === pin.version &&
    local.manifestSha256 === pin.manifestSha256 &&
    local.manifestBytes === pin.manifestBytes &&
    local.files === pin.files &&
    local.bytes === pin.bytes
  );
}

/** Where the app resources keep the exact sysroot artifact this build includes. */
export function bundledLinuxSysrootFolder(
  resources: string,
  pin: LinuxSysrootBundlePin = LINUX_SYSROOT_BUNDLE_PIN,
): string {
  if (!isName(pin.version) || !isDigest(pin.manifestSha256))
    throw new ArtifactError(ArtifactFault.BadPath, MESSAGE.BadPin);
  return path.join(resources, LINUX_SYSROOT_RESOURCES_FOLDER, `${pin.version}-${pin.manifestSha256.slice(0, 12)}`);
}

/** Verify every byte and provenance field of a plain sysroot folder before copying or using it. */
export async function verifyLinuxSysrootFolder(folder: string, pin: LinuxSysrootBundlePin = LINUX_SYSROOT_BUNDLE_PIN) {
  const info = await lstat(folder).catch(() => null);
  if (!info) throw new ArtifactError(ArtifactFault.Missing, MESSAGE.NotPlain(folder));
  if (!info.isDirectory()) throw new ArtifactError(ArtifactFault.NotRegular, MESSAGE.NotPlain(folder));
  const root = await realpath(folder);
  const manifest = await readPinnedManifest(root, pin);
  if (manifest.fields.target !== pin.target || manifest.fields.imageDigest !== pin.imageDigest)
    throw new ArtifactError(ArtifactFault.Origin, MESSAGE.Origin);
  assertExactly(await plainFiles(root), manifest.files, []);
  for (const file of manifest.files) await readListed(root, file, null);
  return { root, manifest };
}

/** Copy a verified sysroot through private resource staging, then verify the completed copy. */
export async function copyLinuxSysrootBundle(
  folder: string,
  resources: string,
  pin: LinuxSysrootBundlePin = LINUX_SYSROOT_BUNDLE_PIN,
): Promise<string> {
  const { root, manifest } = await verifyLinuxSysrootFolder(folder, pin);
  const final = bundledLinuxSysrootFolder(resources, pin);
  const parent = path.dirname(final);
  const staging = path.join(parent, `${STAGING_PREFIX}${pin.manifestSha256.slice(0, 12)}`);
  await mkdir(parent, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  try {
    for (const file of manifest.files) await copyListed(root, staging, file);
    await writeNew(path.join(staging, ARTIFACT_MANIFEST_FILE), manifest.bytes);
    await verifyLinuxSysrootFolder(staging, pin);
    await rm(final, { recursive: true, force: true });
    await rename(staging, final);
    return final;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

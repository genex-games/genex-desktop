/**
 * The ANGLE builds every Genex build ships (owner decision, 2026-10-01): the pinned Metal-only
 * macOS arm64, D3D11-only Windows x64 and Vulkan + SwiftShader Linux x64 builds of the one ANGLE
 * commit, each pinned by its `manifest.json` in `native/angle/bundle-lock.json`.
 * `scripts/bundle-angle.mjs` verifies them at build time and copies them into the app's resources
 * (`<resources>/angle/<target>/<commit12>/`, beside `signatures.json` for the Mac libraries); the
 * toolchain store installs ANGLE from that copy, verified again file by file, never from a
 * download. A packaged app's copy is checked by {@link verifyAngleBundle}.
 *
 * The Linux build's software Vulkan (the Vulkan loader, SwiftShader and its ICD, with their
 * licences) is also split into a folder of its own for Rust · wgpu Linux games (M4.2,
 * `swiftshader-bundle.ts`): the lock's `swiftshader` entry pins that split, {@link copyAngleTarget}
 * makes it beside the Linux copy and {@link verifyAngleBundle} holds the Linux check to both.
 */
import { constants as FS } from "node:fs";
import { copyFile, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ToolchainEntry, ToolchainId } from "../../shared/toolchain.ts";
import { isJsonObject } from "../fsx.ts";
import bundleLockJson from "../../../native/angle/bundle-lock.json" with { type: "json" };
import {
  ARTIFACT_MANIFEST_FILE,
  ArtifactError,
  ArtifactFault,
  type ArtifactPin,
  assertExactly,
  assertOrigin,
  type ListedFile,
  type PinnedManifest,
  plainFiles,
  readListed,
  readPinnedManifest,
  readSignatures,
  SIGNATURES_FILE,
  type SignatureRecord,
  signatureRecord,
  writeNew,
} from "./artifact.ts";
import { bundledLinuxSysrootFolder, isBundledLinuxSysroot } from "./linux-sysroot-bundle.ts";
import {
  bundledSwiftShaderFolder,
  parseSwiftShaderPin,
  type SwiftShaderPin,
  splitSwiftShader,
  verifySwiftShaderFolder,
} from "./swiftshader-bundle.ts";

/** The ANGLE builds, by the name `native/angle/recipe.json` and angle.yml give each. Wire values: never rename one. */
export const AngleTarget = {
  MacArm64Metal: "macos-arm64-metal",
  WindowsX64D3d11: "windows-x64-d3d11",
  LinuxX64Vulkan: "linux-x64-vulkan",
} as const;
export type AngleTarget = (typeof AngleTarget)[keyof typeof AngleTarget];

/** Every ANGLE build the app bundles, in the lock's order. */
export const ANGLE_TARGETS: readonly AngleTarget[] = Object.freeze(Object.values(AngleTarget));

/** The toolchain component each ANGLE build is installed as. */
export const ANGLE_COMPONENT = {
  [AngleTarget.MacArm64Metal]: ToolchainId.AngleMac,
  [AngleTarget.WindowsX64D3d11]: ToolchainId.AngleWindows,
  [AngleTarget.LinuxX64Vulkan]: ToolchainId.AngleLinux,
} as const satisfies Record<AngleTarget, ToolchainId>;

/** The folder of the app's resources the ANGLE builds are bundled in. */
export const ANGLE_RESOURCES_FOLDER = "angle";
/** Where a bundle copy is assembled before it is renamed into place, inside {@link ANGLE_RESOURCES_FOLDER}. */
const STAGING_PREFIX = ".staging-";
/** A packaged app's resources are inside `app.asar`, unpacked beside it (main's `resourcesDir()`). */
const ASAR = "app.asar";
const ASAR_UNPACKED = "app.asar.unpacked";
const BUNDLE_LOCK_SCHEMA = 1;
const SIGNATURES_SCHEMA = 1;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const MESSAGE = {
  BadLock: "native/angle/bundle-lock.json is not a bundle lock: schema 1, a full commit, one pin per ANGLE build.",
  Missing: (folder: string) => `${folder} is not there: this build of Genex was made without it.`,
  Link: (folder: string) => `${folder} is a link; a bundled build is a plain folder.`,
} as const;

/** The angle.yml run the lock's artifacts come from. */
export interface BundleRun {
  repository: string;
  workflow: string;
  id: number;
  /** The day GitHub deletes the run's artifacts (`YYYY-MM-DD`). */
  expires: string;
}

/** `native/angle/bundle-lock.json`: the ANGLE commit, the run its builds come from, and each build's pin. */
export interface BundleLock {
  commit: string;
  run: BundleRun;
  targets: Record<AngleTarget, ArtifactPin>;
  /** The Linux build's software Vulkan split for Rust games; absent from a lock that pins none. */
  swiftshader?: SwiftShaderPin;
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** One target's pin, shape-checked, or null. */
function parsePin(value: unknown): ArtifactPin | null {
  if (!isJsonObject(value)) return null;
  const { manifestSha256, manifestBytes, files, bytes } = value;
  const counts = isCount(manifestBytes) && isCount(files) && isCount(bytes);
  if (typeof manifestSha256 !== "string" || !SHA256.test(manifestSha256) || !counts) return null;
  return { manifestSha256, manifestBytes, files, bytes };
}

/** The run, shape-checked, or null. */
function parseRun(value: unknown): BundleRun | null {
  if (!isJsonObject(value)) return null;
  const { repository, workflow, id, expires } = value;
  const named = typeof repository === "string" && typeof workflow === "string" && typeof expires === "string";
  return named && isCount(id) ? { repository, workflow, id, expires } : null;
}

/** `value` as a bundle lock (schema 1, a full commit, exactly one pin per {@link AngleTarget}), or null. */
export function parseBundleLock(value: unknown): BundleLock | null {
  if (!isJsonObject(value) || value.schema !== BUNDLE_LOCK_SCHEMA) return null;
  const { commit, targets } = value;
  const run = parseRun(value.run);
  if (typeof commit !== "string" || !COMMIT.test(commit) || !run || !isJsonObject(targets)) return null;
  if (Object.keys(targets).length !== ANGLE_TARGETS.length) return null;
  const pins: Partial<Record<AngleTarget, ArtifactPin>> = {};
  for (const target of ANGLE_TARGETS) {
    const pin = parsePin(targets[target]);
    if (!pin) return null;
    pins[target] = pin;
  }
  const targetPins = pins as Record<AngleTarget, ArtifactPin>;
  if (value.swiftshader === undefined) return { commit, run, targets: targetPins };
  const swiftshader = parseSwiftShaderPin(value.swiftshader);
  return swiftshader ? { commit, run, targets: targetPins, swiftshader } : null;
}

/** The shipped lock; a malformed one stops the app from loading rather than trusting it. */
export const BUNDLE_LOCK: BundleLock = (() => {
  const lock = parseBundleLock(bundleLockJson);
  if (!lock) throw new Error(MESSAGE.BadLock);
  return lock;
})();

/** The lock's ANGLE commit, shortened as folder names and versions hold it. */
export const commit12 = (lock: BundleLock = BUNDLE_LOCK): string => lock.commit.slice(0, 12);

/** The ANGLE build `id` is installed from, or null for a component that is not ANGLE. */
function angleTargetOf(id: ToolchainId): AngleTarget | null {
  return ANGLE_TARGETS.find((target) => ANGLE_COMPONENT[target] === id) ?? null;
}

/**
 * The ANGLE build the app bundles for `entry`, or null: `entry` must be the pinned local artifact
 * the lock names for its component (same commit, same manifest digest, size and listing). Any
 * other local artifact has no download and is not bundled (`not-hosted`).
 */
export function bundledTargetOf(entry: ToolchainEntry, lock: BundleLock = BUNDLE_LOCK): AngleTarget | null {
  const target = angleTargetOf(entry.id);
  const { local } = entry;
  if (!target || !local || entry.archives.length > 0 || entry.version !== commit12(lock)) return null;
  const pin = lock.targets[target];
  const same =
    pin.manifestSha256 === local.manifestSha256 &&
    pin.manifestBytes === local.manifestBytes &&
    pin.files === local.files &&
    pin.bytes === local.bytes;
  return same ? target : null;
}

/** Whether the app includes this exact ANGLE or Linux headers pin, installed from its resources. */
export const isBundled = (entry: ToolchainEntry, lock: BundleLock = BUNDLE_LOCK): boolean =>
  bundledTargetOf(entry, lock) !== null || isBundledLinuxSysroot(entry);

/** Where the app's resources keep one ANGLE build: `<resources>/angle/<target>/<commit12>`. */
export function bundledFolder(resources: string, target: AngleTarget, lock: BundleLock = BUNDLE_LOCK): string {
  return path.join(resources, ANGLE_RESOURCES_FOLDER, target, commit12(lock));
}

/**
 * The app's read-only resources folder, resolved as main's `resourcesDir()` resolves it: beside the
 * main bundle this code is built into (`dist/main/main.mjs` → `dist/resources`, the unpacked copy in
 * a packaged app); from source (tests, scripts), the checkout's last build, `dist/resources`. The
 * core passes its own `paths.resources` where it can.
 */
export function appResourcesDir(moduleUrl: string = import.meta.url): string {
  const here = fileURLToPath(moduleUrl);
  if (here.endsWith(".ts")) return path.resolve(path.dirname(here), "..", "..", "..", "dist", "resources");
  const inArchive = path.resolve(path.dirname(here), "..", "resources");
  const marker = `${path.sep}${ASAR}${path.sep}`;
  return inArchive.includes(marker) ? inArchive.replace(marker, `${path.sep}${ASAR_UNPACKED}${path.sep}`) : inArchive;
}

/** Whether a bundled build is in the app's resources. Wire values: never rename one. */
export const BundleState = {
  /** Its folder and `manifest.json` are there (an install verifies every file). */
  Present: "present",
  /** This build of Genex was made without it (a developer build whose sources were absent). */
  Missing: "missing",
} as const;
export type BundleState = (typeof BundleState)[keyof typeof BundleState];

/** Whether the app's resources hold `entry`'s bundled build, or null when the app does not bundle `entry`. */
export async function bundledState(
  resources: string,
  entry: ToolchainEntry,
  lock: BundleLock = BUNDLE_LOCK,
): Promise<BundleState | null> {
  const target = bundledTargetOf(entry, lock);
  const sysroot = isBundledLinuxSysroot(entry);
  if (!target && !sysroot) return null;
  const folder = target ? bundledFolder(resources, target, lock) : bundledLinuxSysrootFolder(resources);
  const manifest = await lstat(path.join(folder, ARTIFACT_MANIFEST_FILE)).catch(() => null);
  return manifest?.isFile() ? BundleState.Present : BundleState.Missing;
}

/** A folder that must be a plain folder, realpath'd: absent is `missing`, a link `not-regular`. */
export async function plainFolder(folder: string): Promise<string> {
  const info = await lstat(folder).catch(() => null);
  if (!info) throw new ArtifactError(ArtifactFault.Missing, MESSAGE.Missing(folder));
  if (!info.isDirectory()) throw new ArtifactError(ArtifactFault.NotRegular, MESSAGE.Link(folder));
  return realpath(folder);
}

/** What one ANGLE build folder held once every file was verified. */
export interface VerifiedAngle {
  root: string;
  manifest: PinnedManifest;
  signatures: Map<string, SignatureRecord>;
}

/**
 * Verifies an ANGLE build folder in place against the lock: its `manifest.json` is the pinned one
 * and names the lock's commit and `target`, it holds exactly the listed files, each its listed size
 * and sha256. A bundled copy (`bundled`) may also hold `signatures.json`, which restores a library
 * the app's signing re-signed; a build's own folder (angle.yml's artifact, a developer's cache) never.
 */
export async function verifyAngleFolder(
  folder: string,
  target: AngleTarget,
  options: { bundled: boolean; lock?: BundleLock },
): Promise<VerifiedAngle> {
  const lock = options.lock ?? BUNDLE_LOCK;
  const root = await plainFolder(folder);
  const manifest = await readPinnedManifest(root, lock.targets[target]);
  assertOrigin(manifest, { commit: lock.commit, target });
  const signatures = options.bundled ? await readSignatures(root) : new Map<string, SignatureRecord>();
  assertExactly(await plainFiles(root), manifest.files, options.bundled ? [SIGNATURES_FILE] : []);
  for (const file of manifest.files) await readListed(root, file, signatures.get(file.rel) ?? null);
  return { root, manifest, signatures };
}

/** What a bundle copy of one ANGLE build holds. */
export interface BundledCopy {
  target: AngleTarget;
  folder: string;
  files: number;
  bytes: number;
  /** The listed libraries `signatures.json` can restore once the app's signing re-signs them. */
  signed: string[];
  /** The Linux build's software Vulkan split, made beside it when the lock pins one. */
  swiftshader?: { folder: string; files: number; bytes: number };
}

/** Clones (or copies) one listed file into `into` and holds the copy to its listed size and sha256. */
async function cloneListed(root: string, into: string, file: ListedFile): Promise<Buffer> {
  const to = path.join(into, ...file.rel.split("/"));
  await mkdir(path.dirname(to), { recursive: true });
  // copyFile follows a link swapped in after the walk; the copy's own bytes are what is checked.
  await copyFile(path.join(root, ...file.rel.split("/")), to, FS.COPYFILE_EXCL | FS.COPYFILE_FICLONE);
  return (await readListed(into, file)).bytes;
}

/**
 * Copies one ANGLE build from `source` (angle.yml's artifact or a developer's cache) into the app's
 * resources at `<resources>/angle/<target>/<commit12>`: every listed file and `manifest.json`, each
 * copy verified, and for every signed Mach-O library its {@link SignatureRecord} in
 * `signatures.json`. It is assembled in a staging folder and renamed into place, so a refused
 * source leaves nothing of itself behind; an earlier copy is replaced.
 */
export async function copyAngleTarget(
  source: string,
  resources: string,
  target: AngleTarget,
  lock: BundleLock = BUNDLE_LOCK,
): Promise<BundledCopy> {
  const root = await plainFolder(source);
  const manifest = await readPinnedManifest(root, lock.targets[target]);
  assertOrigin(manifest, { commit: lock.commit, target });
  assertExactly(await plainFiles(root), manifest.files);
  const parent = path.join(resources, ANGLE_RESOURCES_FOLDER);
  const staging = path.join(parent, `${STAGING_PREFIX}${target}`);
  const final = bundledFolder(resources, target, lock);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const records: Record<string, SignatureRecord> = {};
    for (const file of manifest.files) {
      const record = signatureRecord(await cloneListed(root, staging, file));
      if (record) records[file.rel] = record;
    }
    await writeNew(path.join(staging, ARTIFACT_MANIFEST_FILE), manifest.bytes);
    const signed = Object.keys(records);
    if (signed.length > 0)
      await writeNew(
        path.join(staging, SIGNATURES_FILE),
        `${JSON.stringify({ schema: SIGNATURES_SCHEMA, files: records }, null, 2)}\n`,
      );
    await rm(final, { recursive: true, force: true });
    await mkdir(path.dirname(final), { recursive: true });
    await rename(staging, final);
    const bytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
    const copied: BundledCopy = { target, folder: final, files: manifest.files.length, bytes, signed };
    if (target !== AngleTarget.LinuxX64Vulkan || !lock.swiftshader) return copied;
    const into = bundledSwiftShaderFolder(resources, lock.commit);
    const swiftshader = await splitSwiftShader(final, manifest, into, lock.swiftshader, lock.commit);
    return { ...copied, swiftshader };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** One bundled build as a built or packaged app holds it: verified, or the fault that refused it. */
export type BundleCheck =
  | { target: AngleTarget; ok: true; folder: string; files: number; bytes: number }
  | { target: AngleTarget; ok: false; folder: string; fault: ArtifactFault; detail: string };

/**
 * Every ANGLE build the lock pins, checked where `resources` (a built `dist/resources`, or a
 * packaged app's unpacked resources) keeps it: present, and every file its pinned bytes, a library
 * re-signed by the app's signing restored through `signatures.json` first. The Linux check also
 * holds the lock's SwiftShader split, when it pins one.
 */
export async function verifyAngleBundle(resources: string, lock: BundleLock = BUNDLE_LOCK): Promise<BundleCheck[]> {
  const checks: BundleCheck[] = [];
  for (const target of ANGLE_TARGETS) {
    const folder = bundledFolder(resources, target, lock);
    try {
      const { manifest } = await verifyAngleFolder(folder, target, { bundled: true, lock });
      if (target === AngleTarget.LinuxX64Vulkan && lock.swiftshader)
        await verifySwiftShaderFolder(bundledSwiftShaderFolder(resources, lock.commit), lock.swiftshader, lock.commit);
      const bytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
      checks.push({ target, ok: true, folder, files: manifest.files.length, bytes });
    } catch (error) {
      if (!(error instanceof ArtifactError)) throw error;
      checks.push({ target, ok: false, folder, fault: error.fault, detail: error.message });
    }
  }
  return checks;
}

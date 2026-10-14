/**
 * Splits the software Vulkan a Rust · wgpu Linux game ships (the Vulkan loader, SwiftShader, its
 * ICD and their licences) out of a Linux ANGLE build folder (`linux-x64-vulkan`, angle.yml's
 * artifact or a developer's copy) into `--out`, with the split's own `manifest.json`
 * (`src/substrate/toolchain-store/swiftshader-bundle.ts`), and prints the pin
 * `native/angle/bundle-lock.json` records as `swiftshader`. The ANGLE folder is verified against
 * its own manifest first (every listed file its size and sha256); `--check-lock` also requires the
 * split to be exactly the lock's pin (exit 1 otherwise). Writes nothing but `--out`.
 *
 *   node scripts/toolchains/swiftshader-split.ts --angle <folder> --out <folder> [--check-lock]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readPinnedManifest, sha256Hex } from "../../src/substrate/toolchain-store/artifact.ts";
import { BUNDLE_LOCK } from "../../src/substrate/toolchain-store/bundled.ts";
import {
  SWIFTSHADER_FROM,
  SWIFTSHADER_TARGET,
  type SwiftShaderPin,
  splitSwiftShader,
  swiftShaderFilesOf,
  swiftShaderManifest,
} from "../../src/substrate/toolchain-store/swiftshader-bundle.ts";

const MESSAGE = {
  Usage: "usage: swiftshader-split.ts --angle <folder> --out <folder> [--check-lock]",
  NotLinux: (target: unknown) => `the ANGLE folder is ${JSON.stringify(target)}, not ${SWIFTSHADER_FROM}`,
  NoCommit: "the ANGLE manifest names no full commit",
  LockDiffers: "the split is not the pin native/angle/bundle-lock.json records as swiftshader",
} as const;
const COMMIT = /^[0-9a-f]{40}$/;

function flag(name: string): string | null {
  const at = process.argv.indexOf(name);
  const value = at < 0 ? undefined : process.argv[at + 1];
  return value && !value.startsWith("--") ? value : null;
}

/** The ANGLE folder's manifest, pinned by its own bytes: every listed file is still verified. */
async function selfPinned(folder: string) {
  const bytes = await readFile(path.join(folder, "manifest.json"));
  const parsed = JSON.parse(bytes.toString("utf8")) as { files?: Record<string, { size: number }> };
  const sizes = Object.values(parsed.files ?? {}).map((file) => file.size);
  const pin = {
    manifestSha256: sha256Hex(bytes),
    manifestBytes: bytes.length,
    files: sizes.length,
    bytes: sizes.reduce((sum, size) => sum + size, 0),
  };
  return await readPinnedManifest(folder, pin);
}

async function main(): Promise<void> {
  const angle = flag("--angle");
  const out = flag("--out");
  if (!angle || !out) throw new Error(MESSAGE.Usage);
  const manifest = await selfPinned(path.resolve(angle));
  const { target, commit } = manifest.fields;
  if (target !== SWIFTSHADER_FROM) throw new Error(MESSAGE.NotLinux(target));
  if (typeof commit !== "string" || !COMMIT.test(commit)) throw new Error(MESSAGE.NoCommit);
  const files = swiftShaderFilesOf(manifest);
  const split = swiftShaderManifest(commit, files);
  const pin: SwiftShaderPin = {
    target: SWIFTSHADER_TARGET,
    from: SWIFTSHADER_FROM,
    manifestSha256: sha256Hex(split),
    manifestBytes: split.length,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  };
  const made = await splitSwiftShader(path.resolve(angle), manifest, path.resolve(out), pin, commit);
  const locked = BUNDLE_LOCK.swiftshader;
  const matchesLock =
    locked !== undefined && locked.manifestSha256 === pin.manifestSha256 && BUNDLE_LOCK.commit === commit;
  console.log(JSON.stringify({ folder: made.folder, commit, pin, matchesLock }, null, 2));
  if (process.argv.includes("--check-lock") && !matchesLock) {
    console.error(MESSAGE.LockDiffers);
    process.exitCode = 1;
  }
}

await main();

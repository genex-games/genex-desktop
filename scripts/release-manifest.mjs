import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GameStack } from "../src/shared/game-project.ts";
import { STACK_REQUIRED_COMPONENTS } from "../src/shared/toolchain.ts";
import { rustManifestOf, TOOLCHAIN_MANIFEST } from "../src/substrate/toolchain-store/manifest.ts";
import { requiresSignature } from "./release-policy.mjs";

const ARTIFACT = /\.(dmg|zip|deb|rpm|exe|nupkg)$|^RELEASES$/;

/** The Rust · wgpu stack's pinned downloads (`manifest.ts` reads them as `RUST_MANIFEST`). */
const RUST_RECIPE = "src/substrate/toolchain-store/rust-recipe.json";

/**
 * What the toolchains a release expects are made of: the raylib build recipe, the pinned
 * downloads, the ANGLE recipe and the headless raylib platform every Mac prewarm compiles; the
 * Rust stack's pinned downloads and the lock line its vendored crate set is cut from, and the
 * crate policy crate requests are vetted against (both shipped in resources,
 * `scripts/rust-payload.ts`). A change to any of them changes what users' stores install,
 * prewarm or vet.
 */
export const TOOLCHAIN_LOCK_INPUTS = [
  "src/substrate/toolchain-store/recipe.json",
  "src/substrate/toolchain-store/manifest.ts",
  "native/angle/recipe.json",
  "native/raylib-platform/rcore_genex_headless.c",
  RUST_RECIPE,
  "native/genex-rust/Cargo.lock",
  "native/genex-rust/crate-policy.json",
];

/** sha256 over each toolchain input's path and digest, in order; a missing input throws. */
export async function toolchainLockSha256(root) {
  const lines = [];
  for (const rel of TOOLCHAIN_LOCK_INPUTS) {
    const bytes = await readFile(path.join(root, ...rel.split("/")));
    lines.push(`${rel}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  return createHash("sha256").update(lines.join("")).digest("hex");
}

/**
 * Every download the Rust store installs, as a release records it: one row per pinned archive with
 * its sha256, size and URL, after `rustManifestOf` refused any URL that is not a durable release URL
 * of its publisher (a CI artifact, a mirror, a moving `latest` link) or any archive without a
 * digest. `unpinned` names the components a Rust game needs that neither the recipe nor the shared
 * manifest pins yet (the vendored crate set until the genex release is cut), so a provenance never
 * implies a complete store. The shared pins a Rust cross build reads (zig, llvm-mingw, the Linux
 * headers, the SwiftShader split) are the toolchain inputs' own (`manifest.ts`, the bundle locks).
 */
export function rustStoreInputs(recipe) {
  const entries = rustManifestOf(recipe);
  const inputs = entries.flatMap((entry) =>
    entry.archives.map((archive) => ({
      id: entry.id,
      version: entry.version,
      host: entry.host,
      target: entry.target,
      into: archive.into,
      url: archive.url,
      sha256: archive.sha256,
      bytes: archive.bytes,
    })),
  );
  const pinned = new Set([...entries, ...TOOLCHAIN_MANIFEST].map((entry) => entry.id));
  const needed = new Set(Object.values(STACK_REQUIRED_COMPONENTS[GameStack.RustWgpu]).flat());
  return { inputs, unpinned: [...needed].filter((id) => !pinned.has(id)) };
}

/**
 * One platform's provenance for the checkout at `root`: the version, source, Electron, lockfile and
 * toolchain digests, the Rust store's inputs and the hashed `artifacts`.
 */
export async function platformProvenance(root, { source, platform, arch, signed, artifacts }) {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lock = await readFile(path.join(root, "package-lock.json"));
  const recipe = JSON.parse(await readFile(path.join(root, ...RUST_RECIPE.split("/")), "utf8"));
  return {
    version: pkg.version,
    source,
    platform,
    arch,
    electron: pkg.devDependencies.electron,
    lockfileSha256: createHash("sha256").update(lock).digest("hex"),
    toolchainLockSha256: await toolchainLockSha256(root),
    rustStore: rustStoreInputs(recipe),
    signed,
    artifacts,
  };
}

/** Hash only regular release artifacts; links cannot pull outside files into the inventory. */
export async function releaseArtifacts(root, relative = "") {
  const artifacts = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Release artifacts must not contain symlinks");
    if (entry.isDirectory()) artifacts.push(...(await releaseArtifacts(root, file)));
    else if (entry.isFile() && ARTIFACT.test(entry.name)) {
      const hash = createHash("sha256");
      for await (const bytes of createReadStream(path.join(root, file))) hash.update(bytes);
      artifacts.push({ file: file.split(path.sep).join("/"), sha256: hash.digest("hex") });
    }
  }
  return artifacts.sort((left, right) => left.file.localeCompare(right.file));
}

/** Verify distributed bytes against each distributed platform's manifest and the exact source/lock identity. */
export async function verifyReleaseArtifacts(root, expected, platforms) {
  if (!platforms?.length) throw new Error("Release platforms are required");
  const artifacts = new Map((await releaseArtifacts(root)).map((row) => [row.file, row.sha256]));
  const seen = new Set();
  for (const [platform, arch] of platforms) {
    const manifest = JSON.parse(await readFile(path.join(root, `PROVENANCE-${platform}-${arch}.json`), "utf8"));
    verifyPlatformManifest(manifest, { ...expected, platform, arch }, artifacts, seen);
  }
  if ([...artifacts.keys()].some((file) => !seen.has(file))) throw new Error("Release includes an unlisted artifact");
  const inventory = JSON.parse(await readFile(path.join(root, "SBOM.cyclonedx.json"), "utf8"));
  if (inventory.bomFormat !== "CycloneDX" || !Array.isArray(inventory.components))
    throw new Error("Invalid release inventory");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.env.GITHUB_SHA;
  if (!source || !/^[a-f0-9]{40,64}$/.test(source)) throw new Error("Release source SHA is required");
  const artifacts = await releaseArtifacts("out/make");
  if (!artifacts.length) throw new Error("No release artifacts");
  const platform = process.platform;
  const manifest = await platformProvenance(".", {
    source,
    platform,
    arch: process.arch,
    signed: process.env.RELEASE_SIGNED === "true",
    artifacts,
  });
  await writeFile(`out/make/PROVENANCE-${platform}-${process.arch}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** One platform's recorded identity, signatures and hashes must describe these exact bytes. */
function verifyPlatformManifest(manifest, expected, artifacts, seen) {
  const validIdentity = Object.entries(expected).every(([key, value]) => manifest[key] === value);
  if (!validIdentity) throw new Error("Release provenance does not match the candidate");
  if (requiresSignature(expected.platform) && manifest.signed !== true)
    throw new Error("Release signing is incomplete");
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error("Empty release provenance");
  for (const artifact of manifest.artifacts) {
    const file = path.posix.basename(artifact.file);
    if (seen.has(file)) throw new Error("Duplicate release artifact");
    if (artifacts.get(file) !== artifact.sha256) throw new Error("Release artifact hash mismatch");
    seen.add(file);
  }
}

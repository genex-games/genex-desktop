import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiresSignature } from "./release-policy.mjs";

const ARTIFACT = /\.(dmg|zip|deb|rpm|exe|nupkg)$|^RELEASES$/;

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
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const lock = await readFile("package-lock.json");
  const source = process.env.GITHUB_SHA;
  if (!source || !/^[a-f0-9]{40,64}$/.test(source)) throw new Error("Release source SHA is required");
  const artifacts = await releaseArtifacts("out/make");
  if (!artifacts.length) throw new Error("No release artifacts");
  const platform = process.platform;
  const manifest = {
    version: pkg.version,
    source,
    platform,
    arch: process.arch,
    electron: pkg.devDependencies.electron,
    lockfileSha256: createHash("sha256").update(lock).digest("hex"),
    signed: process.env.RELEASE_SIGNED === "true",
    artifacts,
  };
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

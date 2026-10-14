import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function filesBelow(root, prefix = "") {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      if ([".git", "node_modules", ".studio-dev", "dist", "out"].includes(e.name)) return [];
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new Error(`symlink source is not supported: ${rel}`);
      return e.isDirectory() ? filesBelow(path.join(root, e.name), rel) : [rel];
    });
}
/**
 * Each file's digest by its path, size, modification time and inode: a running developer
 * control checks staleness on every operation, and re-reading thousands of unchanged sources each
 * time held the app's main thread for a quarter of a second.
 */
const printed = new Map();
function fingerprint(file) {
  const stat = fs.statSync(file, { bigint: true });
  const key = `${stat.size}:${stat.mtimeNs}:${stat.ino}`;
  const known = printed.get(file);
  if (known?.key === key) return known.digest;
  const digest = hash(fs.readFileSync(file));
  printed.set(file, { key, digest });
  return digest;
}
export function fingerprints(root, files) {
  return Object.fromEntries([...new Set(files)].sort().map((f) => [f, fingerprint(path.join(root, f))]));
}
export const digest = (entries) => hash(JSON.stringify(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))));
/** Include every maintained build input, including notices copied into development resources. */
export function maintained(root) {
  return [
    ...["src", "scripts", "tests", "native", "build"].flatMap((d) => filesBelow(path.join(root, d), d)),
    ...fs
      .readdirSync(root)
      .filter((f) =>
        /^(package.*\.json|tsconfig.*\.json|forge\.config\..*|\.gitignore|AGENTS\.md|CLAUDE\.md|LICENSE(?:\..*)?|THIRD-PARTY-NOTICES\.md)$/.test(
          f,
        ),
      ),
  ].sort();
}
export function sourceIdentity(root) {
  const git = (...args) => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const { inputs, sourceDigest, dependencies } = buildInputs(root);
  return {
    checkout: fs.realpathSync(root),
    sha: git("rev-parse", "HEAD"),
    branch: git("branch", "--show-current") || null,
    dirty: !!git("status", "--porcelain"),
    sourceDigest,
    inputs,
    dependencies,
  };
}
/** What a build is made from: the maintained sources' digest and the dependencies, without git. */
export function buildInputs(root) {
  const inputs = fingerprints(root, maintained(root));
  return {
    inputs,
    sourceDigest: digest(inputs),
    dependencies: {
      realpath: fs.realpathSync(path.join(root, "node_modules")),
      lockHash: fingerprint(path.join(root, "package-lock.json")),
      electron: JSON.parse(fs.readFileSync(path.join(root, "node_modules/electron/package.json"), "utf8")).version,
      node: process.versions.node,
    },
  };
}
export function safeChild(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some((x) => !x || x === "." || x === ".."))
    throw new Error("unsafe relative path");
  const base = fs.realpathSync(root),
    dest = path.join(base, relative);
  let current = base;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (fs.existsSync(current) && (fs.lstatSync(current).isSymbolicLink() || fs.realpathSync(current) !== current))
      throw new Error(`symlink/alias refused: ${current}`);
  }
  if (!dest.startsWith(base + path.sep)) throw new Error("path escapes owned root");
  return dest;
}
export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function readVersion(file) {
  const v = JSON.parse(fs.readFileSync(file, "utf8"));
  if (v.version !== 1) throw new Error(`unsupported version in ${file}; use a fresh owned profile`);
  return v;
}
export function publishBuild(root, dist, buildId, before) {
  if (dist !== safeChild(root, `.studio-dev/builds/${buildId}`))
    throw new Error("unsafe development build publication root");
  const after = sourceIdentity(root);
  if (
    after.sourceDigest !== before.sourceDigest ||
    JSON.stringify(after.dependencies) !== JSON.stringify(before.dependencies)
  )
    throw new Error("stale/incomplete: inputs changed during build");
  const output = fingerprints(dist, filesBelow(dist));
  writeJson(path.join(dist, "build.json"), {
    version: 1,
    buildId,
    createdAt: new Date().toISOString(),
    ...before,
    outputDigest: digest(output),
    resourcesDigest: digest(fingerprints(dist, filesBelow(path.join(dist, "resources"), "resources"))),
    flags: { developer: true },
  });
}

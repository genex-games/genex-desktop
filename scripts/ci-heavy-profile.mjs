/**
 * CI only: fill the runner user's profile with a large synthetic tree shaped like a developer's
 * (package caches, node_modules trees, editor extensions, browser caches) and the folders Genex
 * denies, so the packaged first start runs on a profile as heavy as a person's. srt-win's deny
 * stamp re-applies permissions under each denied path's parent, and `.ssh`'s parent is the profile
 * itself, so that step's cost grows with every file in the profile; the hosted runner's profile is
 * nearly empty. Existing files are never overwritten. Outside GitHub Actions it seeds only a new or
 * empty folder named with `--root`, never the home.
 *
 *   node scripts/ci-heavy-profile.mjs                the runner's own profile (GitHub Actions only)
 *   node scripts/ci-heavy-profile.mjs --root <dir>   a new or empty folder, to try it locally
 *   --files <n>                                      another size than PROFILE_FILES
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Files the seeded profile holds in all: a developer's few projects, package caches and editors. */
export const PROFILE_FILES = 300_000;
/** File-system calls in flight at once. */
const IO_CONCURRENCY = 64;
/**
 * libuv threads that run them on Windows. A hosted runner's C: drive takes milliseconds per file
 * (432 files/s on the default four), so more of them in flight help there; on macOS's APFS they
 * slowed seeding sevenfold, so elsewhere the default stays.
 */
const WINDOWS_IO_THREADS = 64;
/**
 * The smallest and largest seeded file, in bytes: small source files, manifests and cache entries.
 * NTFS keeps a file this small inside its MFT record, with no cluster of its own to write.
 */
const MIN_FILE_BYTES = 64;
const MAX_FILE_BYTES = 600;
/** Files in one package of a node_modules-style tree, before its nested dependency. */
const PACKAGE_FILES = ["package.json", "README.md", "LICENSE", "index.js", "dist/index.js", "dist/index.d.ts"];
const PACKAGE_SOURCES = 8;
/** Every NESTED_EVERY-th package carries a dependency of its own in a nested node_modules. */
const NESTED_EVERY = 4;
const BODY = Buffer.alloc(MAX_FILE_BYTES, "synthetic profile file for the Genex first-start check\n");

/** How an area's files are laid out. */
export const Shape = {
  /** A content-addressed cache: `<2 hex>/<hash>`, as pnpm's store and git's objects lay theirs out. */
  Cache: "cache",
  /** A node_modules tree: packages of a dozen files, some with nested dependencies. */
  Packages: "packages",
};

/** Where the files go under the profile, each area's share of them (weights sum to 100) and its shape. */
const AREAS = [
  { at: "AppData/Local/npm-cache/_cacache/content-v2/sha512", weight: 8, shape: Shape.Cache },
  { at: "AppData/Local/npm-cache/_cacache/index-v5", weight: 2, shape: Shape.Cache },
  { at: "AppData/Local/pnpm/store/v3/files", weight: 4, shape: Shape.Cache },
  { at: "AppData/Local/Google/Chrome/User Data/Default/Cache/Cache_Data", weight: 5, shape: Shape.Cache },
  { at: "AppData/Local/Microsoft/Edge/User Data/Default/Code Cache/js", weight: 3, shape: Shape.Cache },
  { at: "AppData/Local/Temp/vite-cache", weight: 1, shape: Shape.Cache },
  { at: "AppData/Roaming/Code/User/workspaceStorage", weight: 1, shape: Shape.Cache },
  { at: "Documents/GitHub/game-jam/.git/objects", weight: 2, shape: Shape.Cache },
  { at: "AppData/Local/Programs/Microsoft VS Code/resources/app", weight: 2, shape: Shape.Packages },
  { at: "AppData/Roaming/npm", weight: 5, shape: Shape.Packages },
  // Proof only: a large per-user toolchain on PATH (Python, conda, nvm), granted whole for reading.
  { at: "AppData/Local/Programs/Python/Python312", weight: 50, shape: Shape.Packages },
  { at: "Documents/GitHub/web-app", weight: 6, shape: Shape.Packages },
  { at: "Documents/GitHub/game-jam", weight: 6, shape: Shape.Packages },
  { at: "Documents/GitHub/tools", weight: 2, shape: Shape.Packages },
  { at: ".vscode/extensions", weight: 2, shape: Shape.Packages },
  { at: ".nuget/packages", weight: 1, shape: Shape.Packages },
];

/**
 * Folders Genex denies on Windows (`windowsDenyRead`), relative to the profile, each seeded with one
 * placeholder file: srt-win stamps a deny path only when it exists.
 */
export const DENIED_FOLDERS = [
  ".ssh",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".config/gh",
  "AppData/Roaming/Microsoft/Credentials",
  "AppData/Roaming/Microsoft/Protect",
  "AppData/Roaming/GitHub CLI",
  "AppData/Roaming/gcloud",
  "AppData/Roaming/Mozilla/Firefox/Profiles",
  "AppData/Local/Microsoft/Credentials",
  "AppData/Local/Google/Chrome/User Data",
  "AppData/Local/Microsoft/Edge/User Data",
];
const PLACEHOLDER = "placeholder";

/** A stable hex name for the `index`-th entry: what a cache keys its files by. */
function hexName(index, length) {
  let name = "";
  for (let round = 0; name.length < length; round++) {
    name += (Math.imul(index + 1, 2_654_435_761 + round * 40_503) >>> 0).toString(16).padStart(8, "0");
  }
  return name.slice(0, length);
}

/** The first `count` files of a content-addressed cache. */
function cacheFiles(at, count) {
  return Array.from({ length: count }, (_, i) => {
    const hash = hexName(i, 40);
    return `${at}/${hash.slice(0, 2)}/${hash.slice(2)}`;
  });
}

/** The files of one package in `modules`, with a nested dependency every NESTED_EVERY-th package. */
function packageFiles(modules, index) {
  const name = `${modules}/pkg-${hexName(index, 8)}`;
  const own = [
    ...PACKAGE_FILES,
    ...Array.from({ length: PACKAGE_SOURCES }, (_, i) => `lib/${i < 3 ? "" : "internal/"}${hexName(i, 6)}.js`),
  ].map((file) => `${name}/${file}`);
  if (index % NESTED_EVERY !== 0) return own;
  const nested = `${name}/node_modules/dep-${hexName(index, 4)}`;
  return [...own, ...PACKAGE_FILES.map((file) => `${nested}/${file}`)];
}

/** The first `count` files of a node_modules tree. */
function packageTreeFiles(at, count) {
  const files = [];
  for (let index = 0; files.length < count; index++) files.push(...packageFiles(`${at}/node_modules`, index));
  return files.slice(0, count);
}

/** Every file of a seeded profile of `total` files, as `/`-separated paths relative to the profile. */
export function profileFiles(total) {
  const placeholders = DENIED_FOLDERS.map((folder) => `${folder}/${PLACEHOLDER}`);
  const spread = Math.max(0, total - placeholders.length);
  const weights = AREAS.reduce((sum, area) => sum + area.weight, 0);
  const files = [...placeholders];
  let left = spread;
  AREAS.forEach((area, i) => {
    const count = i === AREAS.length - 1 ? left : Math.floor((spread * area.weight) / weights);
    left -= count;
    files.push(...(area.shape === Shape.Cache ? cacheFiles(area.at, count) : packageTreeFiles(area.at, count)));
  });
  return files.slice(0, total);
}

/** Run `work` on every item, at most `limit` at once. */
async function eachLimited(items, limit, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Write every file of a `total`-file profile under `root`; a file already there is kept as it is. */
export async function seedProfile(root, total) {
  const files = profileFiles(total);
  const dirs = [...new Set(files.map((file) => path.posix.dirname(file)))];
  const started = performance.now();
  await eachLimited(dirs, IO_CONCURRENCY, (dir) => mkdir(path.join(root, ...dir.split("/")), { recursive: true }));
  let written = 0;
  await eachLimited(files, IO_CONCURRENCY, async (file) => {
    const size = MIN_FILE_BYTES + ((written * 37) % (MAX_FILE_BYTES - MIN_FILE_BYTES));
    try {
      await writeFile(path.join(root, ...file.split("/")), BODY.subarray(0, size), { flag: "wx" });
      written++;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  });
  return { files: files.length, written, dirs: dirs.length, ms: Math.round(performance.now() - started) };
}

/**
 * Where this run may seed, or why it may not. The home only on a GitHub Actions runner, which is
 * disposable; elsewhere only a `--root` that is new or empty and holds no home of its own.
 */
export async function seedTarget({ root, home, ci }) {
  if (!root) {
    if (ci) return { root: home };
    return { refused: "seeds the home only on a disposable GitHub Actions runner; pass --root <new folder>" };
  }
  const resolved = path.resolve(root);
  if (ci) return { root: resolved };
  const relative = path.relative(resolved, path.resolve(home));
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return { refused: `${resolved} holds the home` };
  const entries = await readdir(resolved).catch((error) => (error?.code === "ENOENT" ? [] : null));
  if (entries === null) return { refused: `${resolved} cannot be read` };
  if (entries.length > 0) return { refused: `${resolved} is not empty` };
  return { root: resolved };
}

function fail(reason) {
  console.log(`::error title=Heavy profile::${reason}`);
  process.exit(1);
}

async function main() {
  // Before the first file-system call starts libuv's pool, which reads this once.
  if (process.platform === "win32") process.env.UV_THREADPOOL_SIZE ??= String(WINDOWS_IO_THREADS);
  const { values } = parseArgs({ options: { root: { type: "string" }, files: { type: "string" } } });
  const total = values.files === undefined ? PROFILE_FILES : Number(values.files);
  if (!Number.isSafeInteger(total) || total < DENIED_FOLDERS.length)
    fail(`--files must be at least ${DENIED_FOLDERS.length}`);
  const target = await seedTarget({ root: values.root, home: os.homedir(), ci: process.env.GITHUB_ACTIONS === "true" });
  if (target.refused) fail(target.refused);
  const seeded = await seedProfile(target.root, total);
  const rate = Math.round(seeded.written / Math.max(seeded.ms / 1_000, 0.001));
  console.log(
    `Seeded ${seeded.written} of ${seeded.files} files in ${seeded.dirs} folders under ${target.root} ` +
      `in ${seeded.ms} ms (${rate} files/s)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(`seeding threw: ${error?.message ?? error}`));
}

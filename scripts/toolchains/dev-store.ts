/**
 * Builds the developer's derived dev store, `$GENEX_DEV_TOOLCHAINS/dev-store/`, in the product's
 * own layout and through the product's own code paths, so every real-build test row builds with
 * exactly what a user's store would hold:
 *
 * - `installComponents` installs this host's archive components for the destinations (CMake,
 *   Ninja, emsdk with its Node and Python, raylib 6.0's tag archive, zig), fed from
 *   `$GENEX_DEV_TOOLCHAINS/downloads/` by a file-backed fetch whose digests must equal both
 *   `SHA256SUMS` and the manifest; probes run under the real `ProcessSandbox`.
 * - The components Genex built and has not published (the Metal-only ANGLE, ANGLE for Windows and
 *   Linux, the Linux headers' sysroot) come through the dev-only local-artifact seam
 *   (`installLocalArtifact`, receipt `source: "local-artifact"`): each folder verified against its
 *   pinned `manifest.json`, file by file, and copied.
 * - `prewarm` builds every destination this computer prewarms whose components the lock names
 *   (the web, the Mac on an Apple silicon Mac, Windows and Linux with zig) under the real
 *   `ProcessSandbox` with the network off; the Mac needs the Command Line Tools.
 *
 * One store holds every worktree's components and lock folders side by side (decision T2). The
 * lock goes to this worktree's own lock file, never the store's `current-lock.json` (another
 * worktree's): `--lock-file`, else `GENEX_DEV_STORE_LOCK`, else `<repo>/.studio-dev/dev-store-lock.json`,
 * the file the real-build rows read (`tests/helpers/dev-toolchains.ts`). A lock file that is the
 * store's own, however spelled or linked, is refused, and so is a lock whose digest is the store's
 * current lock's (its lock folder is that worktree's). The store's `current-lock.json` sha256 and
 * mtime before and after are recorded.
 *
 * Nothing is downloaded and nothing is deleted. Flags: `--check` verifies this worktree's lock
 * without writing; `--verify-archives` lists every cached archive with the store's pure-TS
 * readers; `--targets web,macos,windows,linux` narrows the destinations; `--evidence <dir>` is
 * where wall time, `du -sh`, step logs and the lock digest go (default
 * `.studio-dev/evidence/dev-store/`).
 *
 * `--stack rust-wgpu` builds the Rust stack's dev store instead, in the same store: the pinned
 * archives every Rust destination needs on this host (the sysroot, each destination's standard
 * library, wasm-bindgen, binaryen, llvm-mingw, zig and cargo-zigbuild) from
 * `$GENEX_RUST_TOOLCHAIN_DIR/downloads/` (default `.studio-dev/spike-toolchain`, which
 * `scripts/spike/rust-wgpu/setup-toolchain.sh` fills) through `installComponents`; the Linux
 * headers (the repository's pinned archive) and the software Vulkan (split from the toolchains
 * folder's Linux ANGLE build) through `installLocalArtifact`; a dev
 * vendored set, the pinned vendored tree plus this checkout's genex crates packaged with
 * `cargo package` (offline, through the env helper), through `installRustVendor`, so a game's
 * `genex = "=0.1.0"` resolves from local sources until M2.18 publishes the release; the base and
 * the Mac and web prewarms of a game's host-written manifest under the real `ProcessSandbox` (the
 * cross and phone destinations build from a cold target folder; the base holds their standard
 * libraries). Its
 * lock goes to `--lock-file`, else `GENEX_DEV_STORE_RUST_LOCK`, else
 * `<repo>/.studio-dev/dev-store-rust-lock.json` (`devStoreRustLockFile`), never the store's own;
 * `--check --stack rust-wgpu` locates the two prewarmed destinations, then every destination for the
 * lane without a prewarm, and holds the receipts to the pins. The
 * Rust store's folder is created when missing, under the project's `.studio-dev`. With
 * `--release <dir>` the vendored set is a locally cut genex release's (`rust-release.ts cut --out
 * <dir>`, its record and archive checked by `readCutVendor`) instead of this checkout's crates.
 * An owned live `studio:dev` profile seeds its own Rust stack from this store and lock at startup
 * (`main/core/rust-dev-seed.ts`, `ToolchainService.seedRust`).
 *
 *   node scripts/toolchains/dev-store.ts [--check | --verify-archives] [--lock-file <file>]
 *     [--targets <list>] [--evidence <dir>] [--stack raylib-cpp | rust-wgpu] [--release <dir>]
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { GAME_PREWARM_RUSTFLAGS, rustWarmProject } from "../../src/main/core/rust-dev-seed.ts";
import { ALL_BUILD_TARGETS, BuildTarget, GameStack, isBuildTarget } from "../../src/shared/game-project.ts";
import {
  ArchiveFormat,
  type ToolchainEntry,
  type ToolchainHost,
  ToolchainId,
  ToolchainInstallPhase,
  type ToolchainLock,
  toolchainHostOf,
} from "../../src/shared/toolchain.ts";
import { atomicWriteJson } from "../../src/substrate/fsx.ts";
import { ProcessSandbox, type RunRequest, type RunResult } from "../../src/substrate/spawn.ts";
import { listArchive, planExtraction, treeDigest } from "../../src/substrate/toolchain-store/archive.ts";
import { readPinnedManifest } from "../../src/substrate/toolchain-store/artifact.ts";
import { AngleTarget, BUNDLE_LOCK, commit12 } from "../../src/substrate/toolchain-store/bundled.ts";
import { headlessPlatformSha256, readRecipe, recipeSha12 } from "../../src/substrate/toolchain-store/genex-cmake.ts";
import {
  installComponents,
  installLocalArtifact,
  LOCAL_MANIFEST_FILE,
  ReceiptSource,
  readReceipts,
  type ToolchainReceipt,
} from "../../src/substrate/toolchain-store/install.ts";
import {
  componentFolder,
  crossPrewarmDigest,
  lockFolder,
  locateToolchain,
  PREWARM_FILE,
  requiredFor,
} from "../../src/substrate/toolchain-store/locate.ts";
import {
  CURRENT_LOCK_FILE,
  isStoreLockFile,
  isToolchainLock,
  lockOf,
  readCurrentLock,
} from "../../src/substrate/toolchain-store/lock.ts";
import { LINUX_SYSROOT_BUNDLE_PIN } from "../../src/substrate/toolchain-store/linux-sysroot-bundle.ts";
import { installRustBase, installRustVendor } from "../../src/substrate/toolchain-store/rust-install.ts";
import { locateRust } from "../../src/substrate/toolchain-store/rust-locate.ts";
import { prewarmRust, recordRustSizes } from "../../src/substrate/toolchain-store/rust-prewarm.ts";
import {
  entryDigest,
  entrySha12,
  manifestEntry,
  TOOLCHAIN_MANIFEST,
} from "../../src/substrate/toolchain-store/manifest.ts";
import {
  PREWARMED_TARGETS,
  PrewarmStep,
  prewarm,
  prewarmableFor,
  prewarmSandboxOptions,
} from "../../src/substrate/toolchain-store/prewarm.ts";
import { devStoreLockFile, devStoreRustLockFile } from "../../tests/helpers/dev-toolchains.ts";
import { splitSwiftShader } from "../../src/substrate/toolchain-store/swiftshader-bundle.ts";
import { pinnedDownloadNames, rustToolchainLayout } from "./rust-env.ts";
import { readCutVendor } from "./rust-release.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_EVIDENCE = path.join(REPO, ".studio-dev", "evidence", "dev-store");
/** A worktree's own lock file, before it exists: what `devStoreLockFile` reads once it does. */
const WORKTREE_LOCK = path.join(REPO, ".studio-dev", "dev-store-lock.json");
const DEV_STORE = "dev-store";
/**
 * Where each local artifact Genex built waits in the developer's toolchains folder: the ANGLE
 * builds by their commit (the entry's version), the Linux sysroot by its pin's sha12. The Mac
 * ANGLE is the CI build the app bundles (`native/angle/bundle-lock.json`): its dylibs are the
 * local build's bytes.
 */
const LOCAL_ARTIFACT_FOLDER: Partial<Record<ToolchainId, (entry: ToolchainEntry) => string>> = {
  [ToolchainId.AngleMac]: (entry) => `angle-macos-arm64-metal/${entry.version}`,
  [ToolchainId.AngleWindows]: (entry) => `angle-windows-x64-d3d11/${entry.version}`,
  [ToolchainId.AngleLinux]: (entry) => `angle-linux-x64-vulkan/${entry.version}`,
  [ToolchainId.LinuxSysroot]: (entry) => `linux-sysroot-x64/${entrySha12(entry)}`,
};
const LIST_MAX_BUFFER = 256 * 1024 ** 2;
/** Matches what a port or network fetch prints in a step's log. */
const FETCH_TRACE = /\bports?\b|embuilder|https?:\/\/|\bfetch(?:ing)?\b|\bdownload/i;

const MESSAGE = {
  NoToolchains: (root: string) => `No dev toolchains at ${root}: populate them (tracker) or set GENEX_DEV_TOOLCHAINS.`,
  UnpinnedHost: (host: string) =>
    `This host (${host}) has no pinned toolchain yet; the dev store is built on darwin-arm64.`,
  NoEntry: (id: string) => `The manifest has no ${id} entry for this host.`,
  NoFolder: (id: string) => `The dev store takes ${id} from no folder in the toolchains folder.`,
  NotRecorded: (url: string) => `SHA256SUMS does not record ${url}.`,
  Mismatch: (name: string) => `${name}: SHA256SUMS and the manifest disagree.`,
  NotCached: (name: string) => `downloads/${name} is missing.`,
  InstallFailed: (phase: string, problem: string) => `Install ended ${phase} (${problem}).`,
  StoreLockFile: (file: string, store: string) =>
    `${file} is ${store}/${CURRENT_LOCK_FILE}, another worktree's lock: give this worktree its own --lock-file.`,
  StoreLock: (digest: string) =>
    `The lock ${digest.slice(0, 12)} is the store's current lock, whose folder another worktree builds with: refusing to prewarm it.`,
  BadTargets: (value: string) => `--targets names ${JSON.stringify(value)}; give web, macos, windows or linux.`,
  NoLock: (file: string) => `${file} holds no lock: build it with node scripts/toolchains/dev-store.ts.`,
} as const;

interface Sum {
  sha256: string;
  name: string;
  bytes: number;
  url: string;
}

/** What one run was asked for. */
interface Options {
  root: string;
  store: string;
  lockFile: string;
  targets: BuildTarget[];
  evidence: string;
  /** `--release <dir>` (Rust only): a locally cut genex release whose vendored set the store installs instead of this checkout's. */
  release?: string;
}

/** SHA256SUMS: `<sha256>  <name>  <bytes>  <url>` per line. */
async function readSums(root: string): Promise<Sum[]> {
  const text = await readFile(path.join(root, "SHA256SUMS"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha256 = "", name = "", bytes = "0", url = ""] = line.split(/\s+/);
      return { sha256, name, bytes: Number(bytes), url };
    });
}

/** The manifest entries the destinations need on this host, split into downloads and local artifacts. */
function wantedEntries(targets: readonly BuildTarget[]): { archives: ToolchainEntry[]; locals: ToolchainEntry[] } {
  const host = thisHost();
  const entries = requiredFor(targets).map((id) => {
    const entry = manifestEntry(id, host);
    if (!entry) throw new Error(MESSAGE.NoEntry(id));
    return entry;
  });
  return { archives: entries.filter((entry) => !entry.local), locals: entries.filter((entry) => entry.local) };
}

/** Each archive of `entries` checked against SHA256SUMS and the cache. */
function checkArchives(root: string, entries: readonly ToolchainEntry[], sums: readonly Sum[]): void {
  for (const archive of entries.flatMap((entry) => entry.archives)) {
    const sum = sums.find((item) => item.url === archive.url);
    if (!sum) throw new Error(MESSAGE.NotRecorded(archive.url));
    if (sum.sha256 !== archive.sha256 || sum.bytes !== archive.bytes) throw new Error(MESSAGE.Mismatch(sum.name));
    if (!existsSync(path.join(root, "downloads", sum.name))) throw new Error(MESSAGE.NotCached(sum.name));
  }
}

/** A fetch that answers the manifest's URLs from downloads/, and nothing else. */
function cachedFetch(root: string, sums: readonly Sum[]) {
  return async (url: string): Promise<Response> => {
    const sum = sums.find((item) => item.url === url);
    if (!sum) return new Response(null, { status: 404 });
    const stream = Readable.toWeb(createReadStream(path.join(root, "downloads", sum.name)));
    return new Response(stream as ReadableStream<Uint8Array>);
  };
}

async function du(target: string): Promise<string> {
  const { stdout } = await execFileAsync("du", ["-sh", target]).catch(() => ({ stdout: `? ${target}` }));
  return stdout.trim();
}

/** Seconds since `start`, to one decimal. */
const since = (start: number) => `${((performance.now() - start) / 1000).toFixed(1)} s`;

/** This computer's manifest host, or a refusal: the dev store is built where a toolchain is pinned. */
function thisHost(): ToolchainHost {
  const host = toolchainHostOf(process.platform, process.arch);
  if (!host) throw new Error(MESSAGE.UnpinnedHost(`${process.platform}-${process.arch}`));
  return host;
}

/** The real sandbox the product prewarms in: no network and no write root but its own scratch. */
async function devSandbox(): Promise<{ sandbox: ProcessSandbox; scratch: string }> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "genex-dev-store-"));
  const sandbox = await ProcessSandbox.create(prewarmSandboxOptions(path.join(scratch, "tmp"), []));
  return { sandbox, scratch };
}

/** Installs the archive components (or finds them installed). */
async function installArchives(
  root: string,
  store: string,
  entries: readonly ToolchainEntry[],
  sandbox: ProcessSandbox,
  log: string[],
): Promise<void> {
  const sums = await readSums(root);
  checkArchives(root, entries, sums);
  let last = "";
  const job = await installComponents(store, entries, {
    fetch: cachedFetch(root, sums),
    run: (request) => sandbox.run(request),
    freeBytes: async (dir) => {
      const disk = await statfs(dir);
      return disk.bavail * disk.bsize;
    },
    onJob: (update) => {
      const line = `${update.phase} ${update.entry ?? ""}`.trim();
      if (line !== last) console.log(`  install: ${line}`);
      last = line;
    },
  });
  log.push(`install job: ${JSON.stringify(job)}`);
  if (job.phase !== ToolchainInstallPhase.Installed)
    throw new Error(MESSAGE.InstallFailed(job.phase, job.problem ?? "no problem code"));
}

/** Installs the local artifacts (ANGLE, the Linux sysroot) from the toolchains folder through the dev-only seam. */
async function installLocals(root: string, store: string, entries: readonly ToolchainEntry[], log: string[]) {
  for (const entry of entries) {
    const folder = LOCAL_ARTIFACT_FOLDER[entry.id]?.(entry);
    if (!folder) throw new Error(MESSAGE.NoFolder(entry.id));
    const at = await installLocalArtifact(store, entry, path.join(root, folder));
    log.push(
      `${entry.id} ${entry.version} from ${folder} (local-artifact, manifest ${entry.local?.manifestSha256}): ${at}`,
    );
  }
}

/** The lock of exactly what this run installs: each entry at its manifest pin, never whichever older folder the store still holds. */
function devLock(installed: readonly ToolchainEntry[]): ToolchainLock {
  const entries: ToolchainLock["entries"] = {};
  for (const entry of installed) entries[entry.id] = { version: entry.version, sha12: entrySha12(entry) };
  return lockOf(entries);
}

/** Records one prewarm step: its log file, its exit and time, and any port, fetch or download line it printed. */
function stepRecorder(log: string[], evidence: string) {
  let index = 0;
  return (label: string, result: RunResult) => {
    index += 1;
    const name = `${String(index).padStart(2, "0")}-${label.replace(/[^a-z0-9-]+/gi, "-")}.log`;
    void writeFile(
      path.join(evidence, name),
      `$ ${result.command}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}\n`,
    );
    log.push(
      `${label}: exit ${result.code} in ${(result.durationMs / 1000).toFixed(1)} s, sandboxed=${result.sandboxed} (${name})`,
    );
    const hits = `${result.stdout}\n${result.stderr}`.split("\n").filter((line) => FETCH_TRACE.test(line));
    if (label === PrewarmStep.WarmCache || hits.length > 0)
      log.push(`  port/fetch/download lines: ${hits.length}${hits.length ? `\n    ${hits.join("\n    ")}` : ""}`);
  };
}

/** The store's `current-lock.json` as evidence: its sha256 and mtime, or that it is absent. */
async function storeLockFacts(store: string): Promise<string> {
  const file = path.join(store, CURRENT_LOCK_FILE);
  const bytes = await readFile(file).catch(() => null);
  if (!bytes) return `${file}: absent`;
  const { mtimeMs } = await stat(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return `${file}: sha256 ${sha256}, mtime ${new Date(mtimeMs).toISOString()} (${mtimeMs} ms)`;
}

/** Refuses a lock file that is the store's own, and a lock whose folder is the store's current lock's. */
async function assertOwnLock(store: string, lockFile: string, lock: ToolchainLock): Promise<void> {
  if (await isStoreLockFile(store, lockFile)) throw new Error(MESSAGE.StoreLockFile(lockFile, store));
  if ((await readCurrentLock(store))?.digest === lock.digest) throw new Error(MESSAGE.StoreLock(lock.digest));
}

async function build(options: Options): Promise<void> {
  const { root, store, lockFile, targets, evidence } = options;
  await mkdir(store, { recursive: true });
  await mkdir(evidence, { recursive: true });
  const log = [
    `dev store build ${new Date().toISOString()} on ${os.hostname()} (${process.platform}-${process.arch}), node ${process.version}`,
    `store ${store}, lock file ${lockFile}, destinations [${targets.join(", ")}]`,
    `before: ${await storeLockFacts(store)}`,
  ];
  const { archives, locals } = wantedEntries(targets);
  const lock = devLock([...archives, ...locals]);
  try {
    await assertOwnLock(store, lockFile, lock);
  } catch (error) {
    log.push(
      `refused: ${error instanceof Error ? error.message : String(error)}`,
      `after: ${await storeLockFacts(store)}`,
    );
    await writeFile(path.join(evidence, "dev-store-refused.txt"), `${log.join("\n")}\n`);
    console.log(log.join("\n"));
    throw error;
  }
  const { sandbox, scratch } = await devSandbox();
  const started = performance.now();
  try {
    let phase = performance.now();
    await installArchives(root, store, archives, sandbox, log);
    log.push(`installComponents (${archives.map((entry) => entry.id).join(", ")}): ${since(phase)}`);
    phase = performance.now();
    await installLocals(root, store, locals, log);
    log.push(`installLocalArtifact (${locals.map((entry) => entry.id).join(", ") || "none"}): ${since(phase)}`);
    phase = performance.now();
    const prewarmed = prewarmableFor(lock, targets);
    const current = await locateToolchain(store, lock, prewarmed);
    if (current.ok)
      log.push(`prewarm([${prewarmed.join(", ")}]): already current for lock ${lock.digest.slice(0, 12)}`);
    else {
      const record = await prewarm(store, lock, prewarmed, {
        run: (request: RunRequest) => sandbox.run(request),
        denyWrite: [scratch, REPO],
        onStep: stepRecorder(log, evidence),
      });
      log.push(
        `prewarm([${prewarmed.join(", ")}]) under ProcessSandbox, network off: ${since(phase)}`,
        `prewarm.json: ${JSON.stringify(record)}`,
      );
    }
    await atomicWriteJson(lockFile, lock);
    log.push(`lock file ${lockFile}: ${JSON.stringify(lock)}`, `lock digest: ${lock.digest}`);
    log.push(`total wall time: ${since(started)}`);
    log.push("du -sh:", ...(await sizes(store, lock)).map((line) => `  ${line}`));
  } finally {
    await sandbox.dispose();
    await rm(scratch, { recursive: true, force: true });
    log.push(`after: ${await storeLockFacts(store)}`);
    await writeFile(path.join(evidence, "dev-store-build.txt"), `${log.join("\n")}\n`);
    console.log(log.join("\n"));
  }
}

async function sizes(store: string, lock: ToolchainLock): Promise<string[]> {
  const parts = Object.entries(lock.entries).map(([id, pin]) => path.join(store, id, `${pin?.version}-${pin?.sha12}`));
  return Promise.all([store, ...parts, lockFolder(await realpath(store), lock)].map(du));
}

/** A component copied from a pinned folder (the dev seam's local artifact, or the app's bundled ANGLE), never downloaded. */
function isPinnedArtifact(receipt: ToolchainReceipt): boolean {
  return receipt.source === ReceiptSource.LocalArtifact || receipt.source === ReceiptSource.Bundled;
}

/** What is wrong with one receipt against the manifest: an archive's digest, a local artifact's pin. */
function receiptProblem(receipt: ToolchainReceipt, host: ToolchainHost | null): string | null {
  const entry = host ? manifestEntry(receipt.id, host) : null;
  if (!entry) return null;
  if (receipt.source === ReceiptSource.Archive && entryDigest(entry) !== receipt.sha256)
    return `${receipt.id}: receipt digest is not the manifest's`;
  const pinnedArtifact = isPinnedArtifact(receipt);
  if (pinnedArtifact && entry.local?.manifestSha256 !== receipt.sha256)
    return `${receipt.id}: receipt digest is not the local artifact's pin`;
  if (receipt.source !== ReceiptSource.Archive && !pinnedArtifact)
    return `${receipt.id}: installed from ${receipt.source}, which no product install writes`;
  return null;
}

const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Re-hashes a local-artifact install against its own pinned manifest.json: every listed file, its size and sha256. */
async function localArtifactProblems(store: string, receipt: ToolchainReceipt): Promise<string[]> {
  const folder = componentFolder(store, receipt.id, receipt);
  const manifest = await readFile(path.join(folder, LOCAL_MANIFEST_FILE));
  if (sha256Of(manifest) !== receipt.sha256) return [`${receipt.id}: its manifest.json is not the pinned one`];
  const files = (JSON.parse(manifest.toString("utf8")) as { files: Record<string, { sha256: string; size: number }> })
    .files;
  const problems: string[] = [];
  for (const [rel, fact] of Object.entries(files)) {
    const bytes = await readFile(path.join(folder, ...rel.split("/"))).catch(() => null);
    if (!bytes || bytes.length !== fact.size || sha256Of(bytes) !== fact.sha256)
      problems.push(`${receipt.id}: ${rel} differs from its manifest.json`);
  }
  return problems;
}

/** This worktree's lock, or null when its lock file holds none. */
async function readLockFile(file: string): Promise<ToolchainLock | null> {
  const value = await readFile(file, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  return isToolchainLock(value) ? value : null;
}

/** What `prewarm.json` in the lock's folder says that no longer matches this checkout. */
async function recordProblems(store: string, lock: ToolchainLock, targets: readonly BuildTarget[]): Promise<string[]> {
  const prewarmed = JSON.parse(
    await readFile(path.join(lockFolder(await realpath(store), lock), PREWARM_FILE), "utf8").catch(() => "{}"),
  );
  const problems: string[] = [];
  if (prewarmed.recipe !== recipeSha12(readRecipe()))
    problems.push("prewarm.json names another recipe: run dev-store.ts again to prewarm the lock");
  const platform = targets.includes(BuildTarget.Mac) ? await headlessPlatformSha256() : null;
  if (prewarmed.platform !== platform)
    problems.push("prewarm.json names another headless platform file: run dev-store.ts again to prewarm the lock");
  const cross = targets.some((target) => target === BuildTarget.Windows || target === BuildTarget.Linux);
  if ((prewarmed.cross ?? null) !== (cross ? crossPrewarmDigest() : null))
    problems.push(
      "prewarm.json names another cross format or Linux sysroot: run dev-store.ts again to prewarm the lock",
    );
  return problems;
}

/** Verifies this worktree's lock without writing: it locates, its receipts match the pins, its prewarm is current. */
async function check(options: Options): Promise<boolean> {
  const { store, lockFile } = options;
  const problems: string[] = [];
  const lock = await readLockFile(lockFile);
  if (!lock) {
    console.log(MESSAGE.NoLock(lockFile));
    return false;
  }
  const targets = prewarmableFor(lock, options.targets);
  const located = await locateToolchain(store, lock, targets);
  if (!located.ok) problems.push(`locate [${targets.join(", ")}]: ${JSON.stringify(located)}`);
  const host = toolchainHostOf(process.platform, process.arch);
  const receipts = await readReceipts(store);
  // Only what the lock names is checked: an older version the store still holds (a re-pinned ANGLE) waits for prune.
  const named = (receipt: ToolchainReceipt) => lock.entries[receipt.id]?.sha12 === receipt.sha12;
  for (const receipt of receipts.filter(named)) {
    const problem = receiptProblem(receipt, host);
    if (problem) problems.push(problem);
    if (isPinnedArtifact(receipt)) problems.push(...(await localArtifactProblems(store, receipt)));
  }
  for (const [id, pin] of Object.entries(lock.entries)) {
    const held = receipts.some((item) => item.id === id && item.version === pin?.version && item.sha12 === pin?.sha12);
    if (!held) problems.push(`${id}: the lock names ${pin?.version}-${pin?.sha12}, which the store does not hold`);
  }
  problems.push(...(await recordProblems(store, lock, targets)), ...(await newBytecode(store, lock)));
  console.log(located.ok ? JSON.stringify(located.toolchain, null, 2) : "");
  console.log(`${await storeLockFacts(store)}\nlock file ${lockFile}`);
  console.log(
    problems.length
      ? `problems:\n- ${problems.join("\n- ")}`
      : `dev store OK: lock ${lock.digest} (${lock.digest.slice(0, 12)}), prewarmed [${targets.join(", ")}]`,
  );
  return problems.length === 0;
}

/**
 * Bytecode written into emsdk after it was installed: the archives ship their own `__pycache__`,
 * which predates the receipt; anything newer came from a run the store's write-deny missed.
 */
async function newBytecode(store: string, lock: ToolchainLock): Promise<string[]> {
  const pin = lock.entries[ToolchainId.Emsdk];
  if (!pin) return [];
  const emsdk = path.join(await realpath(store), ToolchainId.Emsdk, `${pin.version}-${pin.sha12}`);
  const { stdout } = await execFileAsync(
    "find",
    [emsdk, "-name", "*.pyc", "-newer", path.join(emsdk, "receipt.json")],
    {
      maxBuffer: LIST_MAX_BUFFER,
    },
  );
  return stdout.trim() ? [`bytecode was written into the store after install:\n${stdout.trim()}`] : [];
}

/** Lists every cached archive with the store's pure-TS readers and compares the count with the system's listing. */
async function verifyArchives(root: string, evidence: string): Promise<boolean> {
  const sums = (await readSums(root)).filter((sum) => existsSync(path.join(root, "downloads", sum.name)));
  const archives = TOOLCHAIN_MANIFEST.flatMap((entry) => entry.archives);
  const lines: string[] = [];
  let ok = true;
  for (const sum of sums) {
    const archive = archives.find((item) => item.url === sum.url);
    const file = path.join(root, "downloads", sum.name);
    if (!archive) {
      lines.push(`${sum.name}: not in the manifest`);
      ok = false;
      continue;
    }
    const start = performance.now();
    const outcome = await listOne(file, archive.format, archive.strip, archive.into);
    ok &&= outcome.ok;
    lines.push(`${sum.name}: ${outcome.text} (${since(start)})`);
  }
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, "verify-archives.txt"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  return ok;
}

async function listOne(
  file: string,
  format: ArchiveFormat,
  strip: number,
  into: string,
): Promise<{ ok: boolean; text: string }> {
  try {
    const entries = await listArchive(file, format);
    const planned = planExtraction(entries, { strip, into });
    const system = format === ArchiveFormat.Zip ? ["zipinfo", ["-1", file]] : ["tar", ["-tf", file]];
    const { stdout } = await execFileAsync(system[0] as string, system[1] as string[], { maxBuffer: LIST_MAX_BUFFER });
    const counted = stdout.split("\n").filter(Boolean).length;
    const links = entries.filter((entry) => entry.linkTarget !== null).length;
    const same = counted === entries.length;
    return {
      ok: same,
      text: `${entries.length} entries (${links} links, ${planned.length} written), system ${counted}${same ? "" : " MISMATCH"}`,
    };
  } catch (error) {
    return { ok: false, text: `REFUSED ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The Rust stack's run: its own store folder (made when missing), lock file and evidence. */
async function mainRust(values: {
  check?: boolean;
  "lock-file"?: string;
  evidence?: string;
  release?: string;
}): Promise<void> {
  const configured = process.env.GENEX_DEV_TOOLCHAINS || path.join(REPO, ".studio-dev", "toolchains");
  await mkdir(configured, { recursive: true });
  const root = await realpath(configured);
  const store = path.join(root, DEV_STORE);
  const options: Options = {
    root,
    store,
    lockFile: await chosenRustLockFile(store, values["lock-file"]),
    targets: [...RUST_DEV_TARGETS],
    evidence: path.resolve(values.evidence ?? DEFAULT_EVIDENCE),
    ...(values.release === undefined ? {} : { release: path.resolve(values.release) }),
  };
  if (values.check) process.exitCode = (await checkRust(options)) ? 0 : 1;
  else await buildRust(options);
}

/** The destinations `--targets` names (default: every one this computer prewarms). */
function chosenTargets(value: string | undefined): BuildTarget[] {
  if (value === undefined) return [...PREWARMED_TARGETS];
  const named = value.split(",").map((item) => item.trim());
  const bad = named.find((item) => !isBuildTarget(item));
  if (bad !== undefined) throw new Error(MESSAGE.BadTargets(bad));
  return PREWARMED_TARGETS.filter((target) => named.includes(target));
}

/** This worktree's lock file: `--lock-file`, else the one the real-build rows read, never the store's own. */
async function chosenLockFile(store: string, flag: string | undefined): Promise<string> {
  if (flag !== undefined) return path.resolve(flag);
  const read = devStoreLockFile(process.env, REPO);
  return (await isStoreLockFile(store, read)) ? WORKTREE_LOCK : read;
}

// ---------- the Rust stack (`--stack rust-wgpu`) ----------

/**
 * What a Rust game's every destination needs on this host (`STACK_REQUIRED_COMPONENTS`), the
 * vendored set apart: the sysroot, each destination's standard library, the browser's tools, and
 * the cross builds' llvm-mingw, zig and cargo-zigbuild (pinned downloads), with the Linux headers
 * and the software Vulkan (pinned local artifacts).
 */
function rustWanted(): { archives: ToolchainEntry[]; locals: ToolchainEntry[] } {
  const host = thisHost();
  const ids = requiredFor(ALL_BUILD_TARGETS, GameStack.RustWgpu).filter((id) => id !== ToolchainId.RustVendor);
  const entries = ids.map((id) => {
    const entry = manifestEntry(id, host);
    if (!entry) throw new Error(MESSAGE.NoEntry(id));
    return entry;
  });
  return { archives: entries.filter((entry) => !entry.local), locals: entries.filter((entry) => entry.local) };
}
/** The Rust components installed from pinned downloads. */
const RUST_ARCHIVE_IDS: ReadonlySet<ToolchainId> = new Set(rustWanted().archives.map((entry) => entry.id));
/**
 * The Rust destinations the dev store prewarms: this Mac's and the browser (the store's eager
 * pair). The cross and phone destinations are lazy (`rustPrewarmPlan`): the base holds their
 * standard libraries, and the lane builds them from a cold target folder.
 */
const RUST_DEV_TARGETS: readonly BuildTarget[] = [BuildTarget.Mac, BuildTarget.Web];
/** Every Rust destination this Mac builds: each must locate (its components and base) without a prewarm. */
const RUST_LANE_TARGETS: readonly BuildTarget[] = ALL_BUILD_TARGETS;
/** The genex release the workspace's crates are packaged as, the one a game's manifest pins. */
const GENEX_RELEASE = "0.1.0";
/** The dev vendored set's version: the release's, marked as built from this checkout. */
const RUST_VENDOR_VERSION = `${GENEX_RELEASE}-dev`;
/** The release URL M2.18 publishes the vendored set under; the dev archive is served from scratch in its place. */
const RUST_VENDOR_URL = `https://github.com/genex-games/genex-desktop/releases/download/genex-${GENEX_RELEASE}/rust-vendor.tar.gz`;
/** The compiler flags every game build carries (the lane's trust policy), so the prewarm is the one builds clone. */
const RUST_GAME_FLAGS = GAME_PREWARM_RUSTFLAGS;
/** This worktree's Rust lock file, before it exists: what `devStoreRustLockFile` reads once it does. */
const WORKTREE_RUST_LOCK = path.join(REPO, ".studio-dev", "dev-store-rust-lock.json");
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const GENEX_CRATES = path.join(REPO, "native", "genex-rust", "crates");
const CARGO_CHECKSUM_FILE = ".cargo-checksum.json";
const RUST_STACK_FLAG = GameStack.RustWgpu;

const RUST_MESSAGE = {
  NoDownload: (file: string) => `${file} is missing: run scripts/spike/rust-wgpu/setup-toolchain.sh first.`,
  NoVendor: (dir: string) => `${dir} is missing: run scripts/spike/rust-wgpu/setup-toolchain.sh first.`,
  Vendored: (name: string) =>
    `${name} is already in the vendored tree; the dev store adds genex from this checkout only.`,
  NoCrates: "cargo package wrote no .crate for the genex workspace.",
  NoLock: (file: string) =>
    `${file} holds no Rust lock: build it with node scripts/toolchains/dev-store.ts --stack rust-wgpu.`,
  SysrootPin: (file: string) => `${file} is not the archive native/linux-sysroot/bundle-lock.json pins.`,
  StoreLock: (digest: string) =>
    `The Rust lock ${digest.slice(0, 12)} is the store's current Rust lock, whose folder another worktree builds with: refusing to prewarm it.`,
} as const;

/** The pinned Rust toolchain folder: the sysroot's downloads and the vendored crates (`GENEX_RUST_TOOLCHAIN_DIR`). */
function rustToolchainDir(): string {
  return process.env.GENEX_RUST_TOOLCHAIN_DIR || path.join(REPO, ".studio-dev", "spike-toolchain");
}

/** The Rust entries this host installs from downloads, each served from `<rust>/downloads/<archive name>`. */
function rustArchives(rust: string): { entries: ToolchainEntry[]; served: Map<string, string> } {
  const entries = rustWanted().archives;
  // setup-toolchain.sh saves an archive under the pins table's name (cargo-zigbuild's carries its version).
  const names = pinnedDownloadNames({ ...rustToolchainLayout(), dir: rust });
  const served = new Map<string, string>();
  for (const archive of entries.flatMap((entry) => entry.archives)) {
    const name = names.get(archive.url) ?? path.basename(new URL(archive.url).pathname);
    const file = path.join(rust, "downloads", name);
    if (!existsSync(file)) throw new Error(RUST_MESSAGE.NoDownload(file));
    served.set(archive.url, file);
  }
  return { entries, served };
}

/**
 * Where each Rust local artifact comes from, made in `scratch`: the Linux headers from the
 * archive the repository checks in (`native/linux-sysroot`, its bytes held to the bundle pin), the
 * software Vulkan split from the toolchains folder's Linux ANGLE build (`swiftshader-bundle.ts`).
 * `installLocalArtifact` then verifies every file against the entry's pinned manifest.
 */
const RUST_LOCAL_SOURCES: Partial<Record<ToolchainId, (root: string, scratch: string) => Promise<string>>> = {
  [ToolchainId.LinuxSysroot]: async (_root, scratch) => {
    const pin = LINUX_SYSROOT_BUNDLE_PIN.archive;
    const archive = path.join(REPO, "native", "linux-sysroot", pin.file);
    const bytes = await readFile(archive);
    if (bytes.length !== pin.bytes || sha256Of(bytes) !== pin.sha256) throw new Error(RUST_MESSAGE.SysrootPin(archive));
    const folder = path.join(scratch, "linux-sysroot");
    await mkdir(folder, { recursive: true });
    await execFileAsync("tar", ["-xzf", archive, "-C", folder]);
    return folder;
  },
  [ToolchainId.SwiftShaderLinux]: async (root, scratch) => {
    const pin = BUNDLE_LOCK.swiftshader;
    if (!pin) throw new Error(MESSAGE.NoFolder(ToolchainId.SwiftShaderLinux));
    const angle = path.join(root, `angle-${AngleTarget.LinuxX64Vulkan}`, commit12());
    const manifest = await readPinnedManifest(angle, BUNDLE_LOCK.targets[AngleTarget.LinuxX64Vulkan]);
    const folder = path.join(scratch, "swiftshader");
    await splitSwiftShader(angle, manifest, folder, pin, BUNDLE_LOCK.commit);
    return folder;
  },
};

/** Installs the Rust local artifacts through the dev-only seam, each from its {@link RUST_LOCAL_SOURCES} folder. */
async function installRustLocals(root: string, store: string, scratch: string, log: string[]) {
  const { locals } = rustWanted();
  for (const entry of locals) {
    const source = RUST_LOCAL_SOURCES[entry.id];
    if (!source) throw new Error(MESSAGE.NoFolder(entry.id));
    const at = await installLocalArtifact(store, entry, await source(root, scratch));
    log.push(`${entry.id} ${entry.version} (local-artifact, manifest ${entry.local?.manifestSha256}): ${at}`);
  }
  return locals;
}

/** A fetch that answers the given URLs from files, and nothing else. */
function fileFetch(served: ReadonlyMap<string, string>) {
  return async (url: string): Promise<Response> => {
    const file = served.get(url);
    if (!file) return new Response(null, { status: 404 });
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>);
  };
}

/**
 * The genex workspace's library crates packaged as a registry would hold them (`cargo package`
 * through the env helper: offline, against the vendored tree, no lock inside), into `target`.
 */
async function packageGenex(rust: string, target: string): Promise<string[]> {
  const crates = (await readdir(GENEX_CRATES, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  const packages = crates.flatMap((entry) => ["-p", entry.name]);
  const args = [
    "--no-verify",
    "--offline",
    "--locked",
    "--allow-dirty",
    "--registry",
    "crates-io",
    "--exclude-lockfile",
  ];
  await execFileAsync(process.execPath, [RUST_ENV, "--", "cargo", "package", ...packages, ...args], {
    env: { ...process.env, GENEX_RUST_TOOLCHAIN_DIR: rust, CARGO_TARGET_DIR: target },
    maxBuffer: LIST_MAX_BUFFER,
  });
  const folder = path.join(target, "package");
  const files = (await readdir(folder)).filter((name) => name.endsWith(".crate"));
  const wanted = new Set(crates.map((entry) => `${entry.name}-${GENEX_RELEASE}.crate`));
  const made = files.filter((name) => wanted.has(name)).map((name) => path.join(folder, name));
  if (made.length !== wanted.size) throw new Error(RUST_MESSAGE.NoCrates);
  return made.sort();
}

/** Every regular file under `dir`, `/`-separated and sorted. */
async function filesUnder(dir: string, rel = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await filesUnder(dir, child)));
    else if (entry.isFile()) found.push(child);
  }
  return found.sort();
}

/** Unpacks one `.crate` into the vendored tree with the `.cargo-checksum.json` a directory source requires. */
async function vendorCrate(vendor: string, crate: string): Promise<void> {
  const name = path.basename(crate, ".crate");
  if (existsSync(path.join(vendor, name))) throw new Error(RUST_MESSAGE.Vendored(name));
  await execFileAsync("tar", ["-xzf", crate, "-C", vendor]);
  const files: Record<string, string> = {};
  for (const rel of await filesUnder(path.join(vendor, name)))
    files[rel] = sha256Of(await readFile(path.join(vendor, name, ...rel.split("/"))));
  const checksum = { files, package: sha256Of(await readFile(crate)) };
  await writeFile(path.join(vendor, name, CARGO_CHECKSUM_FILE), JSON.stringify(checksum));
}

/**
 * The dev vendored set: a clone of the pinned vendored tree with this checkout's genex crates
 * added, archived as the release's would be. Answers its entry, the archive and the tree's digest.
 */
async function devVendor(rust: string, scratch: string, target: string) {
  const pinned = path.join(rust, "vendor");
  if (!existsSync(pinned)) throw new Error(RUST_MESSAGE.NoVendor(pinned));
  const source = path.join(scratch, "vendor-source");
  await mkdir(source, { recursive: true });
  const clone = process.platform === "darwin" ? ["-c", "-R"] : ["-R", "--reflink=auto"];
  await execFileAsync("/bin/cp", [...clone, pinned, path.join(source, "vendor")]);
  for (const crate of await packageGenex(rust, target)) await vendorCrate(path.join(source, "vendor"), crate);
  const pin = await treeDigest(path.join(source, "vendor"));
  const archive = path.join(scratch, "rust-vendor.tar.gz");
  await execFileAsync("tar", ["-czf", archive, "-C", source, "vendor"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const bytes = await readFile(archive);
  const entry: ToolchainEntry = {
    id: ToolchainId.RustVendor,
    version: RUST_VENDOR_VERSION,
    host: null,
    target: null,
    licence: "per crate (inventory)",
    archives: [
      {
        url: RUST_VENDOR_URL,
        bytes: bytes.length,
        sha256: sha256Of(bytes),
        format: ArchiveFormat.TarGz,
        strip: 0,
        into: "",
      },
    ],
  };
  await rm(source, { recursive: true, force: true });
  return { entry, archive, pin };
}

/** What `install` and the probes and prewarms run with: the dev sandbox, the install's fetch and the disk. */
function rustInstallDeps(sandbox: ProcessSandbox, served: ReadonlyMap<string, string>, log: string[]) {
  return {
    fetch: fileFetch(served),
    run: (request: RunRequest) => sandbox.run(request),
    freeBytes: async (dir: string) => {
      const disk = await statfs(dir);
      return disk.bavail * disk.bsize;
    },
    onJob: (update: { phase: string; entry?: string | null }) =>
      log.push(`  install: ${update.phase} ${update.entry ?? ""}`),
  };
}

/**
 * The vendored set the dev store installs: a locally cut release's (`--release <dir>`, its record
 * and archive checked by `readCutVendor`), else this checkout's genex crates packaged beside the
 * pinned vendored tree.
 */
async function chosenVendor(rust: string, scratch: string, release: string | undefined, log: string[]) {
  if (release !== undefined) {
    const cut = await readCutVendor(release);
    log.push(`vendored set from the local cut ${release} (genex ${cut.entry.version})`);
    return cut;
  }
  const target = path.join(
    process.env.CARGO_TARGET_DIR || path.join(REPO, ".studio-dev", "cargo-target"),
    "dev-store-package",
  );
  const vendor = await devVendor(rust, scratch, target);
  log.push(`vendored set: genex ${GENEX_RELEASE} from this checkout`);
  return vendor;
}

/** Installs the Rust archives, local artifacts and the vendored set; answers the lock naming exactly them. */
async function installRust(
  paths: { rust: string; root: string; store: string; scratch: string },
  sandbox: ProcessSandbox,
  log: string[],
  release?: string,
) {
  const { rust, root, store, scratch } = paths;
  const { entries, served } = rustArchives(rust);
  const job = await installComponents(store, entries, rustInstallDeps(sandbox, served, log));
  if (job.phase !== ToolchainInstallPhase.Installed)
    throw new Error(MESSAGE.InstallFailed(job.phase, job.problem ?? "no problem code"));
  const locals = await installRustLocals(root, store, scratch, log);
  const vendor = await chosenVendor(rust, scratch, release, log);
  const urls = new Map(vendor.entry.archives.map((archive) => [archive.url, vendor.archive]));
  const vendorJob = await installRustVendor(store, vendor.entry, vendor.pin, rustInstallDeps(sandbox, urls, log));
  if (vendorJob.phase !== ToolchainInstallPhase.Installed)
    throw new Error(MESSAGE.InstallFailed(vendorJob.phase, vendorJob.problem ?? "no problem code"));
  log.push(`vendored tree ${JSON.stringify(vendor.pin)}`);
  return devLock([...entries, ...locals, vendor.entry]);
}

/** Refuses a lock file that is any stack's lock in the store, and a lock that is the store's current Rust lock. */
async function assertOwnRustLock(store: string, lockFile: string, lock: ToolchainLock): Promise<void> {
  if (await isStoreLockFile(store, lockFile)) throw new Error(MESSAGE.StoreLockFile(lockFile, store));
  if ((await readCurrentLock(store, GameStack.RustWgpu))?.digest === lock.digest)
    throw new Error(RUST_MESSAGE.StoreLock(lock.digest));
}

/** Builds the Rust dev store: installs, the base, the Mac and web prewarms and the size receipt; writes the worktree's Rust lock. */
async function buildRust(options: Options): Promise<void> {
  const { store, lockFile, evidence } = options;
  const rust = rustToolchainDir();
  await mkdir(store, { recursive: true });
  await mkdir(evidence, { recursive: true });
  const log = [
    `rust dev store build ${new Date().toISOString()} (${process.platform}-${process.arch}), node ${process.version}`,
  ];
  log.push(`store ${store}, lock file ${lockFile}, rust ${rust}`, `before: ${await storeLockFacts(store)}`);
  const { sandbox, scratch } = await devSandbox();
  const started = performance.now();
  try {
    const lock = await installRust({ rust, root: options.root, store, scratch }, sandbox, log, options.release);
    await assertOwnRustLock(store, lockFile, lock);
    const run = (request: RunRequest) => sandbox.run(request);
    const denyWrite = [scratch, REPO];
    const base = await installRustBase(store, lock, { run, denyWrite });
    log.push(`base: ${JSON.stringify(base.triples)} (${since(started)})`);
    for (const target of RUST_DEV_TARGETS) {
      const deps = { run, denyWrite, rustflags: RUST_GAME_FLAGS, tools: target === BuildTarget.Mac };
      const record = await prewarmRust(store, lock, target, rustWarmProject(GENEX_RELEASE), deps);
      log.push(
        `prewarm ${target}: ${record.units} units, ${record.steps.map((s) => `${s.label} ${s.ms} ms`).join(", ")}`,
      );
    }
    log.push(`sizes: ${JSON.stringify(await recordRustSizes(store, lock, RUST_DEV_TARGETS))}`);
    await atomicWriteJson(lockFile, lock);
    log.push(`lock file ${lockFile}: ${JSON.stringify(lock)}`, `total wall time: ${since(started)}`);
  } finally {
    await sandbox.dispose();
    await rm(scratch, { recursive: true, force: true });
    log.push(`after: ${await storeLockFacts(store)}`);
    await writeFile(path.join(evidence, "dev-store-rust-build.txt"), `${log.join("\n")}\n`);
    console.log(log.join("\n"));
  }
}

/** Verifies this worktree's Rust lock without writing: it locates for the Mac and the web, and its archives match the pins. */
async function checkRust(options: Options): Promise<boolean> {
  const lock = await readLockFile(options.lockFile);
  if (!lock) {
    console.log(RUST_MESSAGE.NoLock(options.lockFile));
    return false;
  }
  const problems: string[] = [];
  for (const target of RUST_DEV_TARGETS) {
    const located = await locateRust(options.store, lock, target, { rustflags: RUST_GAME_FLAGS });
    if (!located.ok) problems.push(`locate ${target}: ${JSON.stringify(located.missing)}`);
  }
  for (const target of RUST_LANE_TARGETS) {
    const located = await locateRust(options.store, lock, target, { prewarm: false });
    if (!located.ok) problems.push(`locate ${target} for the lane: ${JSON.stringify(located.missing)}`);
  }
  const host = toolchainHostOf(process.platform, process.arch);
  const named = (receipt: ToolchainReceipt) => lock.entries[receipt.id]?.sha12 === receipt.sha12;
  const rustLocals = new Set(rustWanted().locals.map((entry) => entry.id));
  for (const receipt of (await readReceipts(options.store)).filter(named)) {
    if (!RUST_ARCHIVE_IDS.has(receipt.id) && !rustLocals.has(receipt.id)) continue;
    const problem = receiptProblem(receipt, host);
    if (problem) problems.push(problem);
  }
  console.log(
    problems.length
      ? `problems:\n- ${problems.join("\n- ")}`
      : `rust dev store OK: lock ${lock.digest} (${lock.digest.slice(0, 12)}), prewarmed [${RUST_DEV_TARGETS.join(", ")}], lane [${RUST_LANE_TARGETS.join(", ")}]`,
  );
  return problems.length === 0;
}

/** This worktree's Rust lock file: `--lock-file`, else the one the real-build rows read, never the store's own. */
async function chosenRustLockFile(store: string, flag: string | undefined): Promise<string> {
  if (flag !== undefined) return path.resolve(flag);
  const read = devStoreRustLockFile(process.env, REPO);
  return (await isStoreLockFile(store, read)) ? WORKTREE_RUST_LOCK : read;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean" },
      "verify-archives": { type: "boolean" },
      "lock-file": { type: "string" },
      targets: { type: "string" },
      evidence: { type: "string" },
      stack: { type: "string" },
      release: { type: "string" },
    },
  });
  if (values.stack === RUST_STACK_FLAG) return await mainRust(values);
  const configured = process.env.GENEX_DEV_TOOLCHAINS || path.join(REPO, ".studio-dev", "toolchains");
  const root = await realpath(configured).catch(() => {
    throw new Error(MESSAGE.NoToolchains(configured));
  });
  const store = path.join(root, DEV_STORE);
  const evidence = path.resolve(values.evidence ?? DEFAULT_EVIDENCE);
  if (values["verify-archives"]) {
    process.exitCode = (await verifyArchives(root, evidence)) ? 0 : 1;
    return;
  }
  const options: Options = {
    root,
    store,
    lockFile: await chosenLockFile(store, values["lock-file"]),
    targets: chosenTargets(values.targets),
    evidence,
  };
  if (values.check) process.exitCode = (await check(options)) ? 0 : 1;
  else await build(options);
}

await main();

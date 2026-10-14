/**
 * Moves the crate policy's RustSec snapshot (`native/genex-rust/crate-policy.json`) and rewrites
 * every pin that names it, so the shipped policy, the store recipe and the spike's pin table stay
 * one snapshot:
 *
 * - the snapshot is GitHub's archive of one advisory-db commit (`--commit <sha>`, else the
 *   repository's HEAD from `git ls-remote`), downloaded into `$GENEX_RUST_TOOLCHAIN_DIR/downloads/`
 *   (default `.studio-dev/spike-toolchain`; the archive stays out of git) and checked to hold
 *   RustSec's `crates/` tree;
 * - `crate-policy.json`'s `advisories` (commit, archive, sha256, size, date), the recipe's
 *   `rustsec-advisory-db` entry and the `pins.md` row are rewritten, the two JSON files formatted
 *   as Biome writes them, and `CRATE_POLICY_SHA256` (`crate-policy.ts`) set to the new policy's
 *   digest;
 * - with `--audits`, each trusted source's audit list is pinned too: its URL moved to the source
 *   repository's HEAD commit, its sha256 taken from the downloaded bytes.
 *
 * `check` downloads nothing: it holds the four pins to each other and fails on any drift.
 *
 *   node scripts/toolchains/crate-policy.ts refresh [--commit <sha>] [--audits]
 *   node scripts/toolchains/crate-policy.ts check
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { ArchiveFormat } from "../../src/shared/toolchain.ts";
import { listArchive } from "../../src/substrate/toolchain-store/archive.ts";
import { CRATE_POLICY_SHA256, readCratePolicy } from "../../src/substrate/toolchain-store/crate-policy.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
/** The four files that pin the snapshot, from the repository root. */
export const PIN_FILES = {
  policy: "native/genex-rust/crate-policy.json",
  recipe: "src/substrate/toolchain-store/rust-recipe.json",
  pins: "scripts/spike/rust-wgpu/pins.md",
  module: "src/substrate/toolchain-store/crate-policy.ts",
} as const;
const RUSTSEC_REPO = "https://github.com/rustsec/advisory-db";
const ARCHIVE_PREFIX = `${RUSTSEC_REPO}/archive/`;
const SNAPSHOT_ID = "rustsec-advisory-db";
const COMMIT = /^[0-9a-f]{40}$/;
/** The largest snapshot archive the script accepts (the database is about 0.5 MB packed). */
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const AUDIT_LIST_MAX_BYTES = 16 * 1024 * 1024;
const RAW_HOST = "https://raw.githubusercontent.com/";

const MESSAGE = {
  usage: "usage: crate-policy.ts refresh [--commit <sha>] [--audits] | check",
  badCommit: (commit: string) => `${commit} is not a 40-hex commit`,
  fetch: (url: string, status: number) => `${url} answered ${status}`,
  tooLarge: (url: string) => `${url} is larger than the script accepts`,
  noCrates: "the archive holds no RustSec crates/ tree",
  noEntry: "the recipe has no rustsec-advisory-db entry",
  noRow: "pins.md has no advisory-db row and no end marker",
  drift: (what: string) => `the pins disagree: ${what}`,
  auditUrl: (url: string) => `${url} is not a raw.githubusercontent.com URL at a commit`,
} as const;

/** One snapshot: its commit, its archive's sha256 and size, and the day it was pinned. */
export interface Snapshot {
  commit: string;
  sha256: string;
  bytes: number;
  pinnedAt: string;
}

const sha256Of = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const archiveUrl = (commit: string) => `${ARCHIVE_PREFIX}${commit}.tar.gz`;

/** The policy text with its `advisories` pin moved to `snapshot`. */
export function rewritePolicy(text: string, snapshot: Snapshot): string {
  const policy = JSON.parse(text);
  Object.assign(policy.advisories, {
    commit: snapshot.commit,
    archive: archiveUrl(snapshot.commit),
    sha256: snapshot.sha256,
    bytes: snapshot.bytes,
    pinnedAt: snapshot.pinnedAt,
  });
  return `${JSON.stringify(policy, null, 2)}\n`;
}

/** The recipe text with its snapshot entry moved to `snapshot`. */
export function rewriteRecipe(text: string, snapshot: Snapshot): string {
  const recipe = JSON.parse(text);
  const entry = recipe.entries.find((found: { id: string }) => found.id === SNAPSHOT_ID);
  if (!entry) throw new Error(MESSAGE.noEntry);
  entry.version = snapshot.commit.slice(0, 12);
  entry.archives = [
    {
      url: archiveUrl(snapshot.commit),
      bytes: snapshot.bytes,
      sha256: snapshot.sha256,
      format: ArchiveFormat.TarGz,
      strip: 1,
      into: "",
    },
  ];
  return `${JSON.stringify(recipe, null, 2)}\n`;
}

/** The pin table with its one advisory-db row replaced by `snapshot`'s (added before the end marker when absent). */
export function rewritePins(text: string, snapshot: Snapshot): string {
  const row = `| supply-chain | ${snapshot.commit}.tar.gz | ${archiveUrl(snapshot.commit)} | ${snapshot.sha256} | RustSec advisory-db at commit ${snapshot.commit} (${snapshot.pinnedAt}), archive sha256 taken on download; crate-policy.json pins the same |`;
  const lines = text.split("\n").filter((line) => !line.includes(ARCHIVE_PREFIX));
  const end = lines.findIndex((line) => line.startsWith("<!-- genex-spike-pins:end"));
  if (end < 0) throw new Error(MESSAGE.noRow);
  lines.splice(end, 0, row);
  return lines.join("\n");
}

/** The module text with `CRATE_POLICY_SHA256` set to `digest`. */
export function rewriteModulePin(text: string, digest: string): string {
  return text.replace(/(export const CRATE_POLICY_SHA256 = ")[0-9a-f]{64}(";)/, `$1${digest}$2`);
}

/** The repository's files, read. */
async function readPins(root: string): Promise<Record<keyof typeof PIN_FILES, string>> {
  const read = (rel: string) => readFile(path.join(root, rel), "utf8");
  return {
    policy: await read(PIN_FILES.policy),
    recipe: await read(PIN_FILES.recipe),
    pins: await read(PIN_FILES.pins),
    module: await read(PIN_FILES.module),
  };
}

/** One https GET's whole body, capped; throws on anything but 200. */
async function download(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow" });
  if (response.status !== 200) throw new Error(MESSAGE.fetch(url, response.status));
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(MESSAGE.tooLarge(url));
  return bytes;
}

/** A repository's HEAD commit, as `git ls-remote` reads it. */
async function headCommit(repo: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["ls-remote", repo, "HEAD"]);
  const commit = stdout.split("\t")[0]?.trim() ?? "";
  if (!COMMIT.test(commit)) throw new Error(MESSAGE.badCommit(commit));
  return commit;
}

/** Downloads `commit`'s snapshot into `downloads`, checks it holds RustSec's tree, and answers its pin. */
async function fetchSnapshot(commit: string, downloads: string): Promise<Snapshot> {
  const bytes = await download(archiveUrl(commit), SNAPSHOT_MAX_BYTES);
  await mkdir(downloads, { recursive: true });
  const file = path.join(downloads, `${commit}.tar.gz`);
  await writeFile(`${file}.part`, bytes);
  await rename(`${file}.part`, file);
  const entries = await listArchive(file, ArchiveFormat.TarGz);
  if (!entries.some((entry) => /^[^/]+\/crates\/[^/]+\/RUSTSEC-/.test(entry.name))) throw new Error(MESSAGE.noCrates);
  return { commit, sha256: sha256Of(bytes), bytes: bytes.length, pinnedAt: new Date().toISOString().slice(0, 10) };
}

/** Each audit import moved to its repository's HEAD and pinned by the downloaded bytes' sha256. */
async function pinAudits(policyText: string): Promise<string> {
  const policy = JSON.parse(policyText);
  for (const found of policy.audits.imports) {
    const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/[0-9a-f]{40}\/(.+)$/.exec(found.url);
    if (!match) throw new Error(MESSAGE.auditUrl(found.url));
    const [, repo, file] = match;
    const commit = await headCommit(`https://github.com/${repo}`);
    found.url = `${RAW_HOST}${repo}/${commit}/${file}`;
    found.sha256 = sha256Of(await download(found.url, AUDIT_LIST_MAX_BYTES));
  }
  return `${JSON.stringify(policy, null, 2)}\n`;
}

/** Formats the JSON files as `npm run lint` expects them. */
async function biomeFormat(root: string, files: readonly string[]): Promise<void> {
  await execFileAsync(path.join(root, "node_modules", ".bin", "biome"), ["format", "--write", ...files], { cwd: root });
}

/** Rewrites every pin for a new snapshot (and, with `audits`, the audit lists); answers the new policy digest. */
async function refresh(root: string, options: { commit?: string; audits: boolean }): Promise<string> {
  const commit = options.commit ?? (await headCommit(RUSTSEC_REPO));
  if (!COMMIT.test(commit)) throw new Error(MESSAGE.badCommit(commit));
  const toolchain = process.env.GENEX_RUST_TOOLCHAIN_DIR || path.join(root, ".studio-dev", "spike-toolchain");
  const snapshot = await fetchSnapshot(commit, path.join(toolchain, "downloads"));
  const files = await readPins(root);
  let policy = rewritePolicy(files.policy, snapshot);
  if (options.audits) policy = await pinAudits(policy);
  await writeFile(path.join(root, PIN_FILES.policy), policy);
  await writeFile(path.join(root, PIN_FILES.recipe), rewriteRecipe(files.recipe, snapshot));
  await writeFile(path.join(root, PIN_FILES.pins), rewritePins(files.pins, snapshot));
  await biomeFormat(root, [PIN_FILES.policy, PIN_FILES.recipe]);
  const digest = sha256Of(await readFile(path.join(root, PIN_FILES.policy)));
  await writeFile(path.join(root, PIN_FILES.module), rewriteModulePin(files.module, digest));
  return digest;
}

/** The drift between the four pins, or none: what `check` reports. */
export async function pinDrift(root: string, pin: string = CRATE_POLICY_SHA256): Promise<string[]> {
  const files = await readPins(root);
  const drift: string[] = [];
  const read = await readCratePolicy(path.join(root, path.dirname(PIN_FILES.policy)), pin);
  if (!read.ok) return [MESSAGE.drift(`crate-policy.json is not CRATE_POLICY_SHA256 (${read.detail})`)];
  const { advisories } = read.policy;
  const recipe = JSON.parse(files.recipe);
  const entry = recipe.entries.find((found: { id: string }) => found.id === SNAPSHOT_ID);
  const archive = entry?.archives?.[0];
  if (!archive || archive.sha256 !== advisories.sha256 || archive.url !== advisories.archive)
    drift.push(MESSAGE.drift("the recipe's rustsec-advisory-db entry is not the policy's snapshot"));
  if (entry?.version !== advisories.commit.slice(0, 12))
    drift.push(MESSAGE.drift("the recipe's snapshot version is not the policy's commit"));
  if (!files.pins.includes(`| ${advisories.archive} | ${advisories.sha256} |`))
    drift.push(MESSAGE.drift("pins.md has no row for the policy's snapshot"));
  return drift;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { commit: { type: "string" }, audits: { type: "boolean", default: false } },
  });
  const [command] = positionals;
  if (command === "refresh") {
    const digest = await refresh(REPO, { commit: values.commit, audits: values.audits === true });
    console.log(`crate policy refreshed: sha256 ${digest}`);
    return;
  }
  if (command !== "check") throw new Error(MESSAGE.usage);
  const drift = await pinDrift(REPO);
  for (const line of drift) console.error(line);
  if (drift.length > 0) process.exitCode = 1;
  else console.log("crate policy pins agree");
}

if (import.meta.main) await main();

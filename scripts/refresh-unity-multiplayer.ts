/**
 * Refresh Genex's Unity multiplayer package that Studio vendors into
 * `src/plugins/unity/multiplayer/com.genex.multiplayer` (developer-run only: nothing is fetched at
 * runtime or in CI). The package is the Genex SDK's `sdks/unity` at one pinned commit of
 * `me-ai-org/genex-demo`, read from a local checkout with git, byte for byte, minus what a game
 * never needs from Studio: the SDK's own test projects (`Tests~`), its `.gitignore` for them, and
 * the native Genex Physics core (`Runtime/Plugins`, about 130 MB of per-platform libraries). Without
 * that core a physics room's bodies are drawn the way a WebGL player draws them (unpredicted); every
 * other part of the server-authoritative client and the whole relay client ship.
 *
 * `vendor.json` beside the package records the pin, the package version and each file's sha256,
 * which `tests/conformance/unity-multiplayer-vendor.test.ts` holds to the vendored bytes and
 * `MULTIPLAYER_PACKAGE_SOURCE` (src/plugins/unity/multiplayer.ts). A refresh refuses a commit whose
 * package is not `com.genex.multiplayer`, a version other than the one asked for, and a link or a
 * submodule in the SDK, and writes nothing then. `--check` compares the vendored copy with the SDK
 * at the recorded pin and fails on any file added, missing or changed.
 *
 *   node scripts/refresh-unity-multiplayer.ts --from <genex-demo checkout> --commit <sha> --version <x.y.z>
 *   node scripts/refresh-unity-multiplayer.ts --from <genex-demo checkout> --check
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The repository the package comes from, as `MULTIPLAYER_PACKAGE_SOURCE` names it. */
export const SDK_REPOSITORY = "me-ai-org/genex-demo";
/** The package's folder in that repository. */
export const SDK_PATH = "sdks/unity";
/** The package's name, which the source must declare. */
const PACKAGE_NAME = "com.genex.multiplayer";
/** Paths inside the package Studio does not vendor: each one and everything under it. */
export const EXCLUDED = [".gitignore", "Tests~", "Runtime/Plugins", "Runtime/Plugins.meta"] as const;
/** The largest blob git hands back here: well over any vendored file. */
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
/** git's tree modes for a link and a submodule, which a vendored package never holds. */
const LINK_MODE = "120000";
const SUBMODULE_MODE = "160000";

/** Where the vendored package and its record live in the repository. */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VENDORED_PACKAGE = path.join(REPO, "src/plugins/unity/multiplayer", PACKAGE_NAME);
export const VENDOR_RECORD = path.join(REPO, "src/plugins/unity/multiplayer/vendor.json");

const MESSAGE = {
  NoCommit: (commit: string) => `${commit} is not a commit of the checkout`,
  NotThePackage: (name: unknown) => `${SDK_PATH}/package.json names ${String(name)}, not ${PACKAGE_NAME}`,
  WrongVersion: (found: unknown, wanted: string) => `${SDK_PATH} at that commit is ${String(found)}, not ${wanted}`,
  Link: (file: string) => `${SDK_PATH}/${file} is a link or a submodule; a vendored package holds files only`,
  Usage: "usage: --from <genex-demo checkout> (--commit <sha> --version <x.y.z> | --check)",
} as const;

/** The record of a vendored package: its pin, version, what was left out and each file's sha256. */
export interface UnityVendorRecord {
  repository: string;
  commit: string;
  path: string;
  version: string;
  excluded: readonly string[];
  files: Record<string, string>;
}

/** A file of the SDK at a commit: its path inside the package and its bytes. */
interface SdkFile {
  name: string;
  bytes: Buffer;
}

/** Why a refresh was refused. */
export class UnityVendorError extends Error {}

export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Whether a path inside the package is one Studio leaves out. */
export function isExcluded(name: string): boolean {
  return EXCLUDED.some((top) => name === top || name.startsWith(`${top}/`));
}

/** git in `from`, answering its output as bytes. */
async function git(from: string, args: string[]): Promise<Buffer> {
  const { stdout } = await run("git", ["-C", from, ...args], { encoding: "buffer", maxBuffer: MAX_BLOB_BYTES });
  return stdout;
}

/** The full commit `commit` names in `from`; refused when it names none. */
async function resolveCommit(from: string, commit: string): Promise<string> {
  try {
    return (await git(from, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`])).toString("utf8").trim();
  } catch {
    throw new UnityVendorError(MESSAGE.NoCommit(commit));
  }
}

/** Every file Studio vendors from the package at `commit`, sorted by path; a link or a submodule refuses it. */
export async function sdkFiles(from: string, commit: string): Promise<SdkFile[]> {
  const listing = (await git(from, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", SDK_PATH])).toString("utf8");
  const files: SdkFile[] = [];
  for (const line of listing.split("\0").filter(Boolean)) {
    const [meta = "", full = ""] = line.split("\t");
    const [mode, , blob = ""] = meta.split(" ");
    const name = full.slice(SDK_PATH.length + 1);
    if (isExcluded(name)) continue;
    if (mode === LINK_MODE || mode === SUBMODULE_MODE) throw new UnityVendorError(MESSAGE.Link(name));
    files.push({ name, bytes: await git(from, ["cat-file", "blob", blob]) });
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));
}

/** The package's version at `commit`, after checking it is Genex's Unity package. */
function packageVersion(files: readonly SdkFile[]): string {
  const manifest = files.find((file) => file.name === "package.json");
  const parsed = manifest ? (JSON.parse(manifest.bytes.toString("utf8")) as Record<string, unknown>) : {};
  if (parsed.name !== PACKAGE_NAME) throw new UnityVendorError(MESSAGE.NotThePackage(parsed.name));
  return String(parsed.version);
}

/** Every file under `folder`, by its path inside it, forward slashes; none when it is missing. */
async function filesUnder(folder: string, inside = ""): Promise<string[]> {
  const entries = await readdir(path.join(folder, inside), { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    const name = inside ? `${inside}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...(await filesUnder(folder, name)));
    else names.push(name);
  }
  return names.sort();
}

/** The vendored copy's differences from the SDK's files: each path added, missing or changed. */
export async function vendoredDifferences(target: string, files: readonly SdkFile[]): Promise<string[]> {
  const held = new Set(await filesUnder(target));
  const differences: string[] = [];
  for (const { name, bytes } of files) {
    const now = held.has(name) ? await readFile(path.join(target, name)) : null;
    if (now === null) differences.push(`missing ${name}`);
    else if (!now.equals(bytes)) differences.push(`changed ${name}`);
    held.delete(name);
  }
  for (const name of held) differences.push(`added ${name}`);
  return differences.sort();
}

/** The SDK's files written as the vendored package, replacing the old one only once all are written. */
async function writePackage(target: string, files: readonly SdkFile[]): Promise<void> {
  const staging = `${target}.refresh`;
  await rm(staging, { recursive: true, force: true });
  for (const { name, bytes } of files) {
    await mkdir(path.dirname(path.join(staging, name)), { recursive: true });
    await writeFile(path.join(staging, name), bytes);
  }
  await rm(target, { recursive: true, force: true });
  await rename(staging, target);
}

/** Where a refresh reads from and writes to; the repository's own package and record by default. */
export interface RefreshOptions {
  from: string;
  commit: string;
  version: string;
  target?: string;
  record?: string;
}

/** Vendor the package at `commit`, which must be `version`; answers the record it wrote. */
export async function refreshUnityMultiplayer(options: RefreshOptions): Promise<UnityVendorRecord> {
  const commit = await resolveCommit(options.from, options.commit);
  const files = await sdkFiles(options.from, commit);
  const version = packageVersion(files);
  if (version !== options.version) throw new UnityVendorError(MESSAGE.WrongVersion(version, options.version));
  const record: UnityVendorRecord = {
    repository: SDK_REPOSITORY,
    commit,
    path: SDK_PATH,
    version,
    excluded: EXCLUDED,
    files: Object.fromEntries(files.map(({ name, bytes }) => [name, sha256(bytes)])),
  };
  await writePackage(options.target ?? VENDORED_PACKAGE, files);
  await writeFile(options.record ?? VENDOR_RECORD, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** The vendored copy's differences from the SDK at the recorded pin; none when it is that SDK. */
export async function checkUnityMultiplayer(options: Omit<RefreshOptions, "commit" | "version">): Promise<string[]> {
  const record = JSON.parse(await readFile(options.record ?? VENDOR_RECORD, "utf8")) as UnityVendorRecord;
  const files = await sdkFiles(options.from, await resolveCommit(options.from, record.commit));
  const differences = await vendoredDifferences(options.target ?? VENDORED_PACKAGE, files);
  const version = packageVersion(files);
  return version === record.version ? differences : [...differences, MESSAGE.WrongVersion(version, record.version)];
}

/** The value after `flag` on the command line. */
function flag(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(args: readonly string[]): Promise<number> {
  const from = flag(args, "--from");
  if (!from) throw new UnityVendorError(MESSAGE.Usage);
  if (args.includes("--check")) {
    const differences = await checkUnityMultiplayer({ from });
    for (const line of differences) console.error(line);
    console.log(differences.length ? "the vendored package is not the pinned SDK" : "the vendored package is the pin");
    return differences.length ? 1 : 0;
  }
  const commit = flag(args, "--commit");
  const version = flag(args, "--version");
  if (!commit || !version) throw new UnityVendorError(MESSAGE.Usage);
  const record = await refreshUnityMultiplayer({ from, commit, version });
  console.log(`vendored ${PACKAGE_NAME} ${record.version} from ${record.repository}@${record.commit}`);
  console.log(
    `now set MULTIPLAYER_PACKAGE_SOURCE in src/plugins/unity/multiplayer.ts to ${SDK_REPOSITORY}@${record.commit}`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}

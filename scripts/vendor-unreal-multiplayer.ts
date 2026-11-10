/**
 * Vendor Genex's Unreal multiplayer plugin (`sdks/unreal/GenexMultiplayer` of the Genex SDK) into
 * `src/plugins/unreal/multiplayer/GenexMultiplayer`, byte for byte as a pinned commit holds it
 * (developer-run only: nothing is fetched at runtime or in CI, and a sandboxed job never fetches it).
 * The Unreal plugin's `unreal__multiplayer` copies this folder into a game's `unreal/Plugins/`.
 *
 * The files are read from the commit's objects in a local checkout of the SDK (`git cat-file`),
 * never from its working tree, and each is checked against its blob id before it is written.
 * `vendor.json` records the commit, the plugin's tree id there and its executable files;
 * `tests/conformance/unreal-multiplayer-vendor.test.ts` recomputes the tree id from the vendored
 * bytes, so a changed, extra or missing byte fails. `--check` compares the vendored folder with the
 * pin and writes nothing.
 *
 *   npm run unreal:multiplayer -- --from <genex-demo checkout> [--commit <sha>] [--check]
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/** Where the plugin and its pin live in this repository. */
const UNREAL_PLUGIN_DIR = fileURLToPath(new URL("../src/plugins/unreal/multiplayer/", import.meta.url));
/** The vendored plugin folder. */
export const UNREAL_MULTIPLAYER_DIR = path.join(UNREAL_PLUGIN_DIR, "GenexMultiplayer");
/** The pin beside it. */
export const UNREAL_MULTIPLAYER_PIN = path.join(UNREAL_PLUGIN_DIR, "vendor.json");
/** The SDK repository and the plugin's folder in it. */
const SOURCE = "me-ai-org/genex-demo";
const SOURCE_PATH = "sdks/unreal/GenexMultiplayer";
/** Git's modes for a plain file, an executable file and a folder in a tree object. */
const GitMode = { File: "100644", Executable: "100755", Folder: "40000" } as const;
/** git cat-file of a 7 MB library needs more than Node's default output buffer. */
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

const run = promisify(execFile);

/** What `vendor.json` records. */
export interface UnrealMultiplayerPin {
  source: string;
  path: string;
  commit: string;
  /** The plugin folder's git tree id at `commit`. */
  tree: string;
  /** Files (relative, `/`-separated) git keeps executable. */
  executables: string[];
}

/** The pin as committed. */
export async function readUnrealMultiplayerPin(): Promise<UnrealMultiplayerPin> {
  return JSON.parse(await readFile(UNREAL_MULTIPLAYER_PIN, "utf8")) as UnrealMultiplayerPin;
}

/** Git's object id of `kind` holding `body`. */
function objectId(kind: "blob" | "tree", body: Buffer): Buffer {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`${kind} ${body.length}\0`), body]))
    .digest();
}

/** Git's mode for a file: executable or plain. */
const fileMode = (executable: boolean) => (executable ? GitMode.Executable : GitMode.File);

/** Git's order for tree entries: by name, a folder as if its name ended in `/`. */
const treeKey = (name: string, folder: boolean) => (folder ? `${name}/` : name);

/** The git tree id of `dir` as on disk, `executables` (relative to `rel0`) with git's executable mode. */
async function treeOf(dir: string, rel: string, executables: ReadonlySet<string>): Promise<Buffer> {
  const entries: Array<{ key: string; bytes: Buffer }> = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${child} is a link: the plugin holds none`);
    const folder = entry.isDirectory();
    const id = folder ? await treeOf(full, child, executables) : objectId("blob", await readFile(full));
    const mode = folder ? GitMode.Folder : fileMode(executables.has(child));
    entries.push({
      key: treeKey(entry.name, folder),
      bytes: Buffer.concat([Buffer.from(`${mode} ${entry.name}\0`), id]),
    });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return objectId("tree", Buffer.concat(entries.map((entry) => entry.bytes)));
}

/** The git tree id a folder of files has, with `executables` (relative paths) executable. */
export async function vendoredTreeId(dir: string, executables: readonly string[]): Promise<string> {
  return (await treeOf(dir, "", new Set(executables))).toString("hex");
}

/** One file of the pinned tree: its mode, blob id and path below the plugin folder. */
interface PinnedEntry {
  mode: string;
  blob: string;
  rel: string;
}

const git = (from: string, args: string[]) =>
  run("git", ["-C", from, ...args], { encoding: "buffer", maxBuffer: MAX_BLOB_BYTES });

/** The plugin's files at `commit`, and its tree id there. */
async function pinnedTree(from: string, commit: string): Promise<{ tree: string; entries: PinnedEntry[] }> {
  const tree = (await git(from, ["rev-parse", `${commit}:${SOURCE_PATH}`])).stdout.toString().trim();
  const listing = (await git(from, ["ls-tree", "-r", "-z", commit, `${SOURCE_PATH}/`])).stdout.toString();
  const entries = listing
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta = "", file = ""] = line.split("\t");
      const [mode = "", , blob = ""] = meta.split(" ");
      return { mode, blob, rel: file.slice(SOURCE_PATH.length + 1) };
    });
  return { tree, entries };
}

/** Write the pinned files, each checked against its blob id first, replacing the vendored folder. */
async function writeTree(from: string, entries: readonly PinnedEntry[]): Promise<void> {
  await rm(UNREAL_MULTIPLAYER_DIR, { recursive: true, force: true });
  for (const entry of entries) {
    const bytes = (await git(from, ["cat-file", "blob", entry.blob])).stdout;
    if (objectId("blob", bytes).toString("hex") !== entry.blob)
      throw new Error(`${entry.rel} is not blob ${entry.blob}`);
    const target = path.join(UNREAL_MULTIPLAYER_DIR, ...entry.rel.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { mode: entry.mode === GitMode.Executable ? 0o755 : 0o644 });
  }
}

/** The value after `--name`, if given. */
function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
}

/** Vendor (or, with `--check`, compare) the plugin at the pin. */
async function main(argv: readonly string[]): Promise<void> {
  const from = flag(argv, "from");
  if (!from || !(await lstat(from).catch(() => null))?.isDirectory())
    throw new Error("--from <a local checkout of genex-demo> is required");
  const current = await readUnrealMultiplayerPin().catch(() => null);
  const commit = flag(argv, "commit") ?? current?.commit;
  if (!commit) throw new Error("--commit <sha> is required for a first vendor");
  const resolved = (await git(from, ["rev-parse", `${commit}^{commit}`])).stdout.toString().trim();
  const { tree, entries } = await pinnedTree(from, resolved);
  const executables = entries.filter((entry) => entry.mode === GitMode.Executable).map((entry) => entry.rel);
  if (argv.includes("--check")) {
    const got = await vendoredTreeId(UNREAL_MULTIPLAYER_DIR, executables);
    if (got !== tree) throw new Error(`the vendored plugin is tree ${got}, not ${tree} of ${SOURCE}@${resolved}`);
    console.log(`GenexMultiplayer matches ${SOURCE}@${resolved} (tree ${tree})`);
    return;
  }
  await writeTree(from, entries);
  const got = await vendoredTreeId(UNREAL_MULTIPLAYER_DIR, executables);
  if (got !== tree) throw new Error(`wrote tree ${got}, not the pinned ${tree}: refusing it`);
  const pin: UnrealMultiplayerPin = { source: SOURCE, path: SOURCE_PATH, commit: resolved, tree, executables };
  await writeFile(UNREAL_MULTIPLAYER_PIN, `${JSON.stringify(pin, null, 2)}\n`);
  const bytes = (await Promise.all(entries.map((e) => lstat(path.join(UNREAL_MULTIPLAYER_DIR, e.rel))))).reduce(
    (sum, info) => sum + info.size,
    0,
  );
  console.log(`vendored ${entries.length} files (${bytes} bytes) of ${SOURCE}@${resolved}, tree ${tree}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

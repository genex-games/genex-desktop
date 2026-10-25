/**
 * Builds keyed by content (lane PW): a Rust build of a clean checkout is named by what it was built
 * from — the commit's git tree, the toolchain lock, the destination and its triple, the profile and
 * flavour, the net feature, the person's trust and eject, the crate grant and the SDK — never by the
 * folder it was built in. The lane records that key beside a build folder once its admitted output
 * is written (`<bin>.content`), and a later build of the same content in any copy (Play latest's,
 * the judge's, the integration's, the Live copy's) is served that admitted output without a copy's
 * build (`RustBuilds`), as long as `lastAdmitted` still finds it whole.
 *
 * A key is recorded only for a build whose staged sources are, file for file, the tree's own blobs
 * (`stageMatchesTree`): a checkout's status trusts file sizes and times, so a copy someone changed
 * without changing those is built as itself but never named after a commit it does not hold. A
 * checkout is clean when git reports nothing changed, untracked or ignored outside the folders a
 * build never stages ({@link NEVER_STAGED}). A record is read only from a real build folder under the
 * lane's root (no link is followed), and one that is malformed, of another version or whose output
 * changed is no record; reading never writes or removes anything.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText, readRegularFile } from "../substrate/fsx.ts";
import { toPosixRelative } from "../substrate/paths.ts";
import { gitOrNull } from "../substrate/snapshots.ts";

/** Beside a build folder: the content key of the build its admitted output holds. */
export const CONTENT_RECORD_SUFFIX = ".content";
/** The record's version: a lane whose key changes meaning moves it on, and every older record is none. */
const CONTENT_RECORD_VERSION = 1;
/** The most of a record the lane reads. */
const RECORD_MAX_BYTES = 4096;
/** Top-level folders of a game no build stages: what git reports there leaves a checkout clean. */
const NEVER_STAGED: ReadonlySet<string> = new Set(["target", "dist", ".studio", "node_modules"]);
/** A git object name: SHA-1 or SHA-256. */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A content key: a SHA-256. */
const CONTENT_KEY = /^[0-9a-f]{64}$/;
/** A build folder of one project, as the lane names it. */
const PROJECT_FOLDER = /^.+-[0-9a-f]{12}$/;

/** What a build is made of besides its tree: everything that changes its output. */
export interface ContentFacts {
  tree: string;
  lock: string;
  target: string;
  triple: string;
  profile: string;
  flavour: string;
  net: string;
  trusted: boolean;
  ejectedFrom: string | null;
  grant: unknown;
  sdk: string | null;
}

/** The key of a build made of `facts`. */
export function contentKeyOf(facts: ContentFacts): string {
  const named = { version: CONTENT_RECORD_VERSION, ...facts };
  return createHash("sha256").update(JSON.stringify(named)).digest("hex");
}

/**
 * The tree of the commit `dir` holds when it is a clean checkout at the top of its own repository:
 * nothing changed, untracked or ignored outside {@link NEVER_STAGED}. Null for anything else (no git,
 * a subfolder of another repository, changes), which builds as itself.
 */
export async function cleanTreeOf(dir: string): Promise<string | null> {
  const top = (await gitOrNull(dir, ["rev-parse", "--show-toplevel"]))?.trim();
  const [real, realTop] = await Promise.all([
    realpath(dir).catch(() => null),
    top ? realpath(top).catch(() => null) : null,
  ]);
  if (!real || real !== realTop) return null;
  const status = await gitOrNull(dir, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  if (status === null || statusPaths(status).some((rel) => !NEVER_STAGED.has(rel.split("/")[0] ?? ""))) return null;
  const tree = (await gitOrNull(dir, ["rev-parse", "--verify", "--end-of-options", "HEAD^{tree}"]))?.trim() ?? "";
  return OBJECT_NAME.test(tree) ? tree : null;
}

/** The paths `git status --porcelain -z` lists: a rename or copy carries its source as the next entry. */
function statusPaths(status: string): string[] {
  const tokens = status.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    paths.push(token.slice(3));
    if (token.startsWith("R") || token.startsWith("C")) i++;
  }
  return paths;
}

/**
 * Whether every file the stage holds is the blob `tree` holds at that path (`hostWritten` files,
 * the host's own, aside): what a content key may be recorded for. A link, or anything but a file
 * or folder, in the stage is a mismatch.
 */
export async function stageMatchesTree(
  stage: string,
  source: string,
  tree: string,
  hostWritten: (rel: string) => boolean,
): Promise<boolean> {
  if (!OBJECT_NAME.test(tree)) return false;
  const listing = await gitOrNull(source, ["ls-tree", "-r", "-z", "--full-tree", "--end-of-options", tree]);
  if (listing === null) return false;
  const blobs = new Map<string, string>();
  for (const row of listing.split("\0").filter(Boolean)) {
    const [meta, rel] = row.split("\t");
    const [, type, name] = (meta ?? "").split(" ");
    if (type === "blob" && name && rel) blobs.set(rel, name);
  }
  const sha256 = tree.length === 64;
  return await stagedMatch(stage, stage, { blobs, sha256, hostWritten });
}

async function stagedMatch(
  stage: string,
  dir: string,
  expected: { blobs: ReadonlyMap<string, string>; sha256: boolean; hostWritten: (rel: string) => boolean },
): Promise<boolean> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = toPosixRelative(path.relative(stage, full));
    if (entry.isDirectory()) {
      if (!(await stagedMatch(stage, full, expected))) return false;
      continue;
    }
    if (!entry.isFile()) return false;
    if (expected.hostWritten(rel)) continue;
    const blob = expected.blobs.get(rel);
    if (!blob || blob !== gitBlobName(await readFile(full), expected.sha256)) return false;
  }
  return true;
}

/** The name git gives a blob of `bytes`. */
function gitBlobName(bytes: Buffer, sha256: boolean): string {
  const hash = createHash(sha256 ? "sha256" : "sha1");
  hash.update(`blob ${bytes.length}\0`);
  hash.update(bytes);
  return hash.digest("hex");
}

/** One recorded build of a content key: its build folder, whether clippy gated it, and when it was recorded. */
export interface ContentRecord {
  bin: string;
  linted: boolean;
  at: number;
}

/** The lane's records of content keys, read from its root once, then kept as builds record theirs. */
export class RustContentIndex {
  readonly #root: string;
  #records: Map<string, ContentRecord[]> | null = null;
  #loading: Promise<Map<string, ContentRecord[]>> | null = null;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  /** The recorded builds of `key`, newest first. */
  async recorded(key: string): Promise<ContentRecord[]> {
    if (!CONTENT_KEY.test(key)) return [];
    const records = await this.#load();
    return [...(records.get(key) ?? [])];
  }

  /** Records that `bin`'s admitted output is a build of `key`; a record that cannot be written is none. */
  async record(bin: string, key: string, linted: boolean, at: number): Promise<void> {
    if (!CONTENT_KEY.test(key)) return;
    const text = `${JSON.stringify({ version: CONTENT_RECORD_VERSION, key, linted })}\n`;
    try {
      await atomicWriteText(`${bin}${CONTENT_RECORD_SUFFIX}`, text);
    } catch {
      return;
    }
    const records = await this.#load();
    const others = (records.get(key) ?? []).filter((record) => record.bin !== bin);
    records.set(key, [{ bin, linted, at }, ...others]);
  }

  #load(): Promise<Map<string, ContentRecord[]>> {
    if (this.#records) return Promise.resolve(this.#records);
    this.#loading ??= readRecords(this.#root).then((records) => {
      this.#records = records;
      return records;
    });
    return this.#loading;
  }
}

/** Every record under `root`, by key, newest first; nothing that is not a real folder or file is read. */
async function readRecords(root: string): Promise<Map<string, ContentRecord[]>> {
  const records = new Map<string, ContentRecord[]>();
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const project = path.join(root, name);
    if (!PROJECT_FOLDER.test(name) || !(await lstat(project).catch(() => null))?.isDirectory()) continue;
    for (const file of await readdir(project).catch(() => [] as string[])) {
      if (!file.endsWith(CONTENT_RECORD_SUFFIX)) continue;
      const found = await readRecord(path.join(project, file));
      if (!found) continue;
      records.set(found.key, [...(records.get(found.key) ?? []), found.record]);
    }
  }
  for (const list of records.values()) list.sort((a, b) => b.at - a.at);
  return records;
}

/** One `<bin>.content` file, or null when it is not a regular file holding a record of this version. */
async function readRecord(file: string): Promise<{ key: string; record: ContentRecord } | null> {
  const stats = await lstat(file).catch(() => null);
  if (!stats?.isFile()) return null;
  const bytes = await readRegularFile(file, RECORD_MAX_BYTES).catch(() => null);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const version = Reflect.get(parsed, "version");
    const key = Reflect.get(parsed, "key");
    const linted = Reflect.get(parsed, "linted");
    if (version !== CONTENT_RECORD_VERSION || typeof key !== "string" || !CONTENT_KEY.test(key)) return null;
    if (typeof linted !== "boolean") return null;
    const bin = file.slice(0, -CONTENT_RECORD_SUFFIX.length);
    return { key, record: { bin, linted, at: stats.mtimeMs } };
  } catch {
    return null;
  }
}

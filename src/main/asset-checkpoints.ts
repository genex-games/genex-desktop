import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, lstat, mkdir, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { atomicWriteJson } from "../substrate/fsx.ts";
import { GIT_ENV, HOST_GIT_CONFIG } from "../substrate/snapshots.ts";
import { assertRelativePath } from "../substrate/paths.ts";
import { ASSET_PREFIXES } from "../shared/game-assets.ts";
const exec = promisify(execFile);

/** The most output one git command of a checkpoint may print. */
const GIT_MAX_BUFFER = 8 * 1024 ** 2;
/** How much of git's complaint a failed staged read keeps. */
const GIT_ERROR_TAIL_CHARS = 2000;
/** The commit message of a checkpoint of host-delivered assets. */
const CHECKPOINT_COMMIT_MESSAGE = "Checkpoint host-delivered assets";

/** Why a delivery could not be recorded or checkpointed, as the asset panel shows it. */
const MESSAGE = {
  notDelivered: "Only delivered asset files can be checkpointed",
  notContained: "Asset is not a contained regular file",
  cannotInspect: "Cannot inspect staged asset",
  modified: (relative: string) =>
    `Delivered asset was modified: ${relative}. Preserve it and resolve the change before integrating.`,
  alreadyStaged: (relative: string) => `Asset already has staged changes: ${relative}`,
  changedDuringCheckpoint: (file: string) =>
    `Delivered asset changed during checkpoint: ${file}. No commit was created.`,
  unknownDelivery: "Unknown asset delivery for this workspace",
} as const;

export interface AssetDeliveryRecord {
  id: string;
  project: string;
  workspace: string;
  plugin: string;
  jobId: string;
  files: Array<{ path: string; sha256: string }>;
  revision?: string;
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function checkedFile(root: string, relative: string) {
  assertRelativePath(relative);
  if (
    !ASSET_PREFIXES.some((prefix) => relative.startsWith(prefix)) ||
    relative.split("/").some((p) => p.startsWith("."))
  )
    throw new Error(MESSAGE.notDelivered);
  const base = await realpath(root),
    file = path.join(base, relative),
    resolved = await realpath(file);
  if (resolved !== file || !(await lstat(file)).isFile()) throw new Error(MESSAGE.notContained);
  return file;
}
/** Hash the staged blob, not a second read of a path that could change during git add. */
async function stagedDigest(root: string, index: string, file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...HOST_GIT_CONFIG, "show", `:${file}`], {
      cwd: root,
      env: { ...process.env, ...GIT_ENV, GIT_INDEX_FILE: index },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const hash = createHash("sha256");
    let error = "";
    child.stdout.on("data", (bytes) => hash.update(bytes));
    child.stderr.on("data", (bytes) => {
      error = (error + bytes).slice(-GIT_ERROR_TAIL_CHARS);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(hash.digest("hex")) : reject(new Error(error || MESSAGE.cannotInspect)),
    );
  });
}
/** git in one worktree, with the host's own config, optionally on a private index; its trimmed output. */
type HostGit = (args: string[], index?: string) => Promise<string>;

function hostGit(root: string): HostGit {
  return async (args, index) =>
    (
      await exec("git", [...HOST_GIT_CONFIG, ...args], {
        cwd: root,
        env: { ...process.env, ...GIT_ENV, ...(index ? { GIT_INDEX_FILE: index } : {}) },
        maxBuffer: GIT_MAX_BUFFER,
      })
    ).stdout.trim();
}

/**
 * The delivered files a checkpoint must commit: pending in the worktree, still exactly the bytes
 * delivered, and not staged by anyone else. A modified or already-staged delivery stops it.
 */
async function pendingDeliveries(git: HostGit, root: string, latest: ReadonlyMap<string, string>): Promise<string[]> {
  const paths: string[] = [];
  for (const [relative, digest] of latest) {
    // Already committed edits belong to the game; only pending deliveries need a checkpoint.
    if (!(await git(["status", "--porcelain", "--", relative]))) continue;
    const file = await checkedFile(root, relative).catch(() => null);
    if (!file) continue;
    if (hash(await readFile(file)) !== digest) throw new Error(MESSAGE.modified(relative));
    if (await git(["diff", "--cached", "--name-only", "--", relative]))
      throw new Error(MESSAGE.alreadyStaged(relative));
    if (await git(["status", "--porcelain", "--", relative])) paths.push(relative);
  }
  return paths;
}

/**
 * Commit exactly these delivered files on top of `previous`, through a private index so nothing
 * the user staged or left unstaged is swept in, and only when the staged bytes are the delivered
 * ones. Returns the new revision; HEAD moves only if nobody moved it meanwhile.
 */
async function commitDeliveries(
  git: HostGit,
  root: string,
  index: string,
  previous: string,
  paths: readonly string[],
  latest: ReadonlyMap<string, string>,
): Promise<string> {
  await git(["read-tree", previous], index);
  await git(["add", "--", ...paths], index);
  for (const file of paths)
    if ((await stagedDigest(root, index, file)) !== latest.get(file))
      throw new Error(MESSAGE.changedDuringCheckpoint(file));
  const tree = await git(["write-tree"], index);
  const revision = await git(["commit-tree", tree, "-p", previous, "-m", CHECKPOINT_COMMIT_MESSAGE], index);
  await git(["update-ref", "HEAD", revision, previous]);
  await git(["reset", "--quiet", revision, "--", ...paths]);
  return revision;
}

/** Host-only records. The caller cannot nominate a path to add to Git. */
export class AssetCheckpoints {
  #tail = Promise.resolve();
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  /** Only a missing file means "no deliveries yet"; any other read failure must not become [] and be written back. */
  async records(): Promise<AssetDeliveryRecord[]> {
    return JSON.parse(
      await readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error?.code === "ENOENT") return "[]";
        throw error;
      }),
    );
  }
  /** Run `work` after every record and checkpoint already asked for: one writer of the file at a time. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work);
    this.#tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async record(project: string, workspace: string, plugin: string, jobId: string, files: string[]) {
    return this.#serial(async () => {
      const record: AssetDeliveryRecord = {
        id: randomUUID(),
        project,
        workspace: await realpath(workspace),
        plugin,
        jobId,
        files: [],
      };
      for (const relative of files)
        record.files.push({ path: relative, sha256: hash(await readFile(await checkedFile(workspace, relative))) });
      const records = await this.records();
      records.push(record);
      await atomicWriteJson(this.file, records);
      return record;
    });
  }
  async checkpoint(project: string, workspace: string, ids?: string[]) {
    return this.#serial(async () => {
      const root = await realpath(workspace);
      const records = await this.records();
      const asked = (r: AssetDeliveryRecord) => !ids || ids.includes(r.id);
      const candidates = records.filter((r) => r.project === project && r.workspace === root && asked(r));
      if (ids?.some((id) => !candidates.some((r) => r.id === id))) throw new Error(MESSAGE.unknownDelivery);
      const latest = new Map<string, string>();
      for (const r of candidates) for (const f of r.files) latest.set(f.path, f.sha256);
      const git = hostGit(root);
      const paths = await pendingDeliveries(git, root, latest);
      if (!paths.length) return { revision: await git(["rev-parse", "HEAD"]), files: [] };
      const previous = await git(["rev-parse", "HEAD"]);
      await mkdir(path.dirname(this.file), { recursive: true });
      const index = path.join(path.dirname(this.file), `index-${randomUUID()}`);
      try {
        const revision = await commitDeliveries(git, root, index, previous, paths, latest);
        for (const r of candidates) r.revision = revision;
        await atomicWriteJson(this.file, records);
        return { revision, files: paths };
      } finally {
        await rm(index, { force: true });
      }
    });
  }
}

import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, lstat } from "node:fs/promises";
import { atomicWriteJson } from "../substrate/fsx.ts";
import { assertRelativePath } from "../substrate/paths.ts";

/** Why a delivery could not be recorded, as the asset panel shows it. */
const MESSAGE = {
  notDelivered: "Only delivered asset files can be checkpointed",
  notContained: "Asset is not a contained regular file",
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
  if (!/^(public\/)?assets\//.test(relative) || relative.split("/").some((p) => p.startsWith(".")))
    throw new Error(MESSAGE.notDelivered);
  const base = await realpath(root),
    file = path.join(base, relative),
    resolved = await realpath(file);
  if (resolved !== file || !(await lstat(file)).isFile()) throw new Error(MESSAGE.notContained);
  return file;
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
  /** Run `work` after every record already asked for: one writer of the file at a time. */
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
}

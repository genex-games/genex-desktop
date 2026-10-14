/**
 * The importer: `node worker.ts <job folder>`, run by the host inside its own sandbox (no network,
 * writes only `<job>/out` and `<job>/tmp`). It reads `job.json` and the copied inputs, runs each
 * step (`convert.ts`), writes each output and then `out/receipt.json`. It never names a path the
 * job did not: every input and output is `in/<n>.<ext>` or `out/<n>.<ext>` inside the job folder.
 * Exit 0 with a receipt, 2 when the job file is unreadable.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { convertAsset } from "./convert.ts";
import { AssetImportRefusal } from "./import-plan.ts";
import {
  IMPORT_DETAIL_MAX_CHARS,
  IMPORT_JOB_VERSION,
  type ImportJob,
  type ImportJobFile,
  ImportJobLayout,
  type ImportReceiptEntry,
  parseImportJob,
} from "./job.ts";

/** The exit code of a job the importer cannot read. */
export const IMPORT_JOB_UNREADABLE_EXIT = 2;

const failed = (index: number, error: unknown): ImportReceiptEntry => ({
  index,
  ok: false,
  refusal: AssetImportRefusal.ImporterFailed,
  detail: (error instanceof Error ? error.message : String(error)).slice(0, IMPORT_DETAIL_MAX_CHARS),
});

/** One file's step, its output written; the receipt line either way. */
async function importOne(jobDir: string, job: ImportJob, file: ImportJobFile): Promise<ImportReceiptEntry> {
  const bytes = new Uint8Array(await readFile(path.join(jobDir, file.input)));
  const mtl = file.mtl
    ? { text: await readFile(path.join(jobDir, file.mtl.input), "utf8"), dir: file.mtl.dir }
    : undefined;
  const { converter, ext, name } = file;
  const result = await convertAsset({ converter, ext, name, bytes, ...(mtl ? { mtl } : {}), targets: job.targets });
  if (!result.ok) {
    return {
      index: file.index,
      ok: false,
      refusal: result.refusal,
      detail: result.detail.slice(0, IMPORT_DETAIL_MAX_CHARS),
    };
  }
  await writeFile(path.join(jobDir, file.output), result.bytes, { flag: "wx" });
  return {
    index: file.index,
    ok: true,
    output: file.output,
    ...(result.textures ? { textures: result.textures } : {}),
  };
}

/** The job file, or null when it is missing, not JSON or not a job. */
async function readJob(jobDir: string): Promise<ImportJob | null> {
  try {
    return parseImportJob(JSON.parse(await readFile(path.join(jobDir, ImportJobLayout.Job), "utf8")));
  } catch {
    return null;
  }
}

/** Run the job in `jobDir`; returns the exit code. */
export async function runImportJob(jobDir: string): Promise<number> {
  const job = await readJob(jobDir);
  if (!job) return IMPORT_JOB_UNREADABLE_EXIT;
  const files: ImportReceiptEntry[] = [];
  for (const file of job.files)
    files.push(await importOne(jobDir, job, file).catch((error: unknown) => failed(file.index, error)));
  const receipt = path.join(jobDir, ImportJobLayout.Out, ImportJobLayout.Receipt);
  await writeFile(receipt, JSON.stringify({ version: IMPORT_JOB_VERSION, files }), { flag: "wx" });
  return 0;
}

if (import.meta.main) {
  const jobDir = process.argv[2];
  process.exitCode = jobDir ? await runImportJob(path.resolve(jobDir)) : IMPORT_JOB_UNREADABLE_EXIT;
}

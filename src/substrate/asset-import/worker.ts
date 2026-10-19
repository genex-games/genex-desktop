/**
 * The importer: `node worker.ts <job folder>`, run by the host inside its own sandbox (no network,
 * writes only `<job>/out` and `<job>/tmp`). It reads `job.json` and the copied inputs, runs each
 * step (`convert.ts`), writes each output and then `out/receipt.json`. It never names a path the
 * job did not: every input and output is `in/<n>.<ext>` or `out/<n>.<ext>` inside the job folder.
 * Exit 0 with a receipt, 2 when the job file is unreadable.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ConvertResult, convertAsset } from "./convert.ts";
import { AssetImportRefusal } from "./import-plan.ts";
import {
  IMPORT_DETAIL_MAX_CHARS,
  IMPORT_ISSUES_MAX,
  IMPORT_JOB_VERSION,
  type ImportJob,
  type ImportFamilyOutput,
  type ImportJobFile,
  ImportJobLayout,
  type ImportReceiptEntry,
  familyOutput,
  parseImportJob,
  sidecarOutput,
} from "./job.ts";

/** The exit code of a job the importer cannot read. */
export const IMPORT_JOB_UNREADABLE_EXIT = 2;

const failed = (index: number, error: unknown): ImportReceiptEntry => ({
  index,
  ok: false,
  refusal: AssetImportRefusal.ImporterFailed,
  detail: (error instanceof Error ? error.message : String(error)).slice(0, IMPORT_DETAIL_MAX_CHARS),
});

/** A step's family files (its own, then each GLB image sidecar's) written to `out/`; the receipt's rows. */
async function writeFamilies(
  jobDir: string,
  index: number,
  result: Extract<ConvertResult, { ok: true }>,
): Promise<ImportFamilyOutput[]> {
  const families: ImportFamilyOutput[] = [];
  for (const family of result.families ?? []) {
    const output = familyOutput(index, family.compression);
    await writeFile(path.join(jobDir, output), family.bytes, { flag: "wx" });
    families.push({ compression: family.compression, output });
  }
  for (const [at, sidecar] of (result.sidecars ?? []).entries()) {
    for (const family of sidecar.files) {
      const output = sidecarOutput(index, at, family.compression);
      await writeFile(path.join(jobDir, output), family.bytes, { flag: "wx" });
      families.push({ compression: family.compression, output, stem: sidecar.stem });
    }
  }
  return families;
}

/** One file's step, its output written; the receipt line either way. */
async function importOne(jobDir: string, job: ImportJob, file: ImportJobFile): Promise<ImportReceiptEntry> {
  const bytes = new Uint8Array(await readFile(path.join(jobDir, file.input)));
  const mtl = file.mtl
    ? { text: await readFile(path.join(jobDir, file.mtl.input), "utf8"), dir: file.mtl.dir }
    : undefined;
  const { converter, ext, name, usage } = file;
  const result = await convertAsset({
    converter,
    ext,
    name,
    bytes,
    ...(mtl ? { mtl } : {}),
    ...(usage ? { usage } : {}),
    targets: job.targets,
  });
  if (!result.ok) {
    return {
      index: file.index,
      ok: false,
      refusal: result.refusal,
      detail: result.detail.slice(0, IMPORT_DETAIL_MAX_CHARS),
    };
  }
  await writeFile(path.join(jobDir, file.output), result.bytes, { flag: "wx" });
  const families = await writeFamilies(jobDir, file.index, result);
  return {
    index: file.index,
    ok: true,
    output: file.output,
    ...(result.textures ? { textures: result.textures } : {}),
    ...(result.families || result.sidecars ? { families } : {}),
    ...(result.familiesSkipped ? { familiesSkipped: result.familiesSkipped } : {}),
    ...(result.sizes ? { sizes: result.sizes } : {}),
    ...(result.texture ? { texture: result.texture } : {}),
    ...(result.issues
      ? {
          issues: result.issues
            .slice(0, IMPORT_ISSUES_MAX)
            .map(({ code, pointer }) => ({ code, ...(pointer ? { pointer } : {}) })),
        }
      : {}),
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

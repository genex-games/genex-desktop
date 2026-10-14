/**
 * The Rust · wgpu import step, host side (plan "Game services", M2.7). For each of a game's files
 * it plans a step (`planImport`): keep, refuse with a typed per-stack code, or run the importer to
 * normalize or convert it. The importer is a store tool in a sandbox of its own: the host copies
 * the files it needs (read under the safe-path rule, never through a link, never outside the
 * game) into a fresh job folder, starts `worker.ts` there with no network and no writable folder
 * but the job's `out/` and `tmp/`, and then admits each output itself: its name, kind, size and
 * format checked, its digest taken host-side. The receipt's word is taken only for refusal codes
 * from the vocabulary and for the KTX2 transcode digests.
 *
 * TODO(M3): the jobs folder in `core/layout.ts`, the importer carried in the packaged app,
 * running it on deliveries to Rust games, and placing admitted outputs beside their sources (or
 * in the lane's staged copy, M2.2). Not wired in M2: deliveries to Rust games arrive with the
 * harness integration, and no catalog package owns the importer's payload yet.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MINUTE_MS } from "../shared/duration.ts";
import { assetExtension } from "../shared/game-assets.ts";
import type { BuildTarget, GameStack } from "../shared/game-project.ts";
import { readRegularFile, writeNewFile } from "../substrate/fsx.ts";
import { isGlb, readGlb } from "../substrate/asset-import/glb.ts";
import {
  AssetImportRefusal,
  ImportAction,
  ImportConverter,
  type ImporterStep,
  planImport,
  runsImporter,
} from "../substrate/asset-import/import-plan.ts";
import {
  IMPORT_JOB_VERSION,
  type ImportJob,
  type ImportJobFile,
  ImportJobLayout,
  type ImportReceipt,
  parseImportReceipt,
} from "../substrate/asset-import/job.ts";
import { looksLikeRadiance } from "../substrate/asset-import/hdr.ts";
import { readKtx2Header } from "../substrate/asset-import/ktx2.ts";
import { objMaterialLibrary } from "../substrate/asset-import/obj.ts";
import { readGameAsset } from "../substrate/asset-import/safe-asset.ts";
import type { TranscodedTexture } from "../substrate/asset-import/texture-table.ts";
import type { RunRequest, RunResult, SandboxOptions, SandboxPolicy } from "../substrate/spawn.ts";
import { shellQuote } from "../substrate/shell-quote.ts";

/** The largest file the import step reads from a game. */
export const IMPORT_INPUT_MAX_BYTES = 256 * 1024 * 1024;
/** The largest output admitted (a decompressed mesh is larger than its Draco form). */
export const IMPORT_OUTPUT_MAX_BYTES = 512 * 1024 * 1024;
/** The largest receipt read back. */
const RECEIPT_MAX_BYTES = 4 * 1024 * 1024;
/** How long one import job may run. */
export const IMPORT_TIMEOUT_MS = 5 * MINUTE_MS;
/** The importer's output the host keeps for its log. */
const IMPORT_OUTPUT_KEEP_CHARS = 64 * 1024;
const IMPORT_LABEL = "asset-import";

/** What every admitted output must start with, by output extension. */
const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53] as const;

/** How the importer starts: the argv before the job folder, and its own environment. */
export interface ImporterCommand {
  argv: readonly string[];
  env?: Record<string, string>;
}

/** This process's Node (Electron's, as Node) running `worker.ts`. */
export function defaultImporterCommand(): ImporterCommand {
  const worker = fileURLToPath(new URL("../substrate/asset-import/worker.ts", import.meta.url));
  const electron = typeof process.versions.electron === "string";
  return { argv: [process.execPath, worker], ...(electron ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}) };
}

/** The sandbox one job runs in (`ProcessSandbox.create`), disposed after it. */
export interface ImportSandbox {
  run(request: RunRequest): Promise<RunResult>;
  dispose(): Promise<void>;
}

/** What the import step reaches: injected. */
export interface RustAssetImportDeps {
  /** The host-owned folder that holds one folder per job; no sandboxed process writes it. */
  jobsRoot: string;
  /** A sandbox of the importer's own, with no writable root (each job's overlay opens its `out/`). */
  sandboxFor(options: SandboxOptions): Promise<ImportSandbox>;
  /** Host credentials denied to the importer. */
  secretPaths: readonly string[];
  /** Further folders the importer may never write. */
  denyWrite?: readonly string[];
  importer?: ImporterCommand;
  newJobId?(): string;
  timeoutMs?: number;
}

/** One import: a game's files for its stack and destinations. */
export interface RustAssetImportRequest {
  gameRoot: string;
  stack: GameStack;
  /** Posix paths under the game folder (`assets/ship.obj`). */
  files: readonly string[];
  targets: readonly BuildTarget[];
}

/** An admitted output of the importer. */
export interface ImportOutput {
  /** Its absolute path in the job's `out/`. */
  path: string;
  /** The game-relative name it takes beside its source (`assets/ship.glb`). */
  file: string;
  bytes: number;
  sha256: string;
}

/** What the import step did with one file. */
export interface ImportedAsset {
  file: string;
  action: ImportAction;
  converter?: ImportConverter;
  refusal?: AssetImportRefusal;
  output?: ImportOutput;
  textures?: TranscodedTexture[];
}

/** One import's outcome, file by file, in request order. */
export interface RustAssetImportResult {
  jobId: string;
  /** The job folder, kept for the caller to place outputs from and then remove. */
  jobDir: string;
  files: ImportedAsset[];
  /** The importer's stderr, cut: for the log, never shown as copy. */
  log: string;
}

/** A file the importer runs on: its plan, its job entry, and its step. */
interface Planned {
  at: number;
  step: ImporterStep;
  job: ImportJobFile;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The job folder's layout. */
function jobFolders(jobDir: string) {
  return {
    job: path.join(jobDir, ImportJobLayout.Job),
    in: path.join(jobDir, ImportJobLayout.In),
    out: path.join(jobDir, ImportJobLayout.Out),
    tmp: path.join(jobDir, ImportJobLayout.Tmp),
    receipt: path.join(jobDir, ImportJobLayout.Out, ImportJobLayout.Receipt),
  };
}

/** `assets/ship.obj` → `assets/ship.glb`. */
function outputName(file: string, output: string): string {
  const dot = file.lastIndexOf(".");
  return `${dot > file.lastIndexOf("/") ? file.slice(0, dot) : file}.${output}`;
}

/** The stem a model is named by in its GLB. */
const stem = (file: string) => path.posix.basename(file, path.posix.extname(file));

/** An OBJ's material library copied beside it as `in/<n>.mtl`, when it names a safe one that is there. */
async function copyMaterialLibrary(
  gameRoot: string,
  file: string,
  objBytes: Uint8Array,
  folders: ReturnType<typeof jobFolders>,
  at: number,
): Promise<ImportJobFile["mtl"]> {
  const library = objMaterialLibrary(new TextDecoder().decode(objBytes));
  if (!library) return undefined;
  const dir = path.posix.dirname(file);
  const rel = dir === "." ? library : `${dir}/${library}`;
  const read = await readGameAsset(gameRoot, rel, IMPORT_INPUT_MAX_BYTES);
  if (!read.ok) return undefined;
  const input = `${ImportJobLayout.In}/${at}.mtl`;
  await writeNewFile(path.join(folders.in, `${at}.mtl`), read.bytes);
  const mtlDir = path.posix.dirname(library);
  return { input, dir: mtlDir === "." ? "" : mtlDir };
}

/** Plan every file; copy what the importer reads into the job folder. */
async function prepare(
  request: RustAssetImportRequest,
  folders: ReturnType<typeof jobFolders>,
): Promise<{ results: ImportedAsset[]; planned: Planned[] }> {
  const results: ImportedAsset[] = [];
  const planned: Planned[] = [];
  for (const [at, file] of request.files.entries()) {
    const step = planImport(request.stack, file);
    if (!runsImporter(step)) {
      results.push({ file, action: step.action, ...(step.refusal ? { refusal: step.refusal } : {}) });
      continue;
    }
    const read = await readGameAsset(request.gameRoot, file, IMPORT_INPUT_MAX_BYTES);
    if (!read.ok) {
      results.push({ file, action: ImportAction.Refuse, converter: step.converter, refusal: read.refusal });
      continue;
    }
    const ext = assetExtension(file);
    await writeNewFile(path.join(folders.in, `${at}.${ext}`), read.bytes);
    const mtl =
      step.converter === ImportConverter.ObjToGlb
        ? await copyMaterialLibrary(request.gameRoot, file, read.bytes, folders, at)
        : undefined;
    const job: ImportJobFile = {
      index: at,
      input: `${ImportJobLayout.In}/${at}.${ext}`,
      ext,
      converter: step.converter,
      output: `${ImportJobLayout.Out}/${at}.${step.output}`,
      name: stem(file),
      ...(mtl ? { mtl } : {}),
    };
    results.push({ file, action: step.action, converter: step.converter });
    planned.push({ at: results.length - 1, step, job });
  }
  return { results, planned };
}

/**
 * The importer's run: its own sandbox with no writable root, so only `out/` and its TMPDIR are
 * writable; no domain is opened, so the filtering proxy refuses every host and Seatbelt (or
 * bubblewrap's network namespace) every direct connection. Loopback follows the process-wide
 * sandbox setting the core's sandbox holds (`allowLocalBinding`, read by sandbox-runtime from its
 * global config, never a run's overlay). TODO(spawn.ts owner): a store-tool sandbox option that
 * closes loopback too.
 */
async function runImporter(
  deps: RustAssetImportDeps,
  jobDir: string,
  folders: ReturnType<typeof jobFolders>,
): Promise<RunResult | null> {
  const importer = deps.importer ?? defaultImporterCommand();
  const sandbox = await deps.sandboxFor({
    writableRoots: [],
    scratchDir: folders.tmp,
    secretPaths: [...deps.secretPaths],
  });
  const policy: Partial<SandboxPolicy> = {
    allowedDomains: [],
    allowWrite: [folders.out],
    denyWrite: [...(deps.denyWrite ?? []), folders.in, folders.job],
  };
  try {
    return await sandbox.run({
      command: [...importer.argv, jobDir].map(shellQuote).join(" "),
      cwd: jobDir,
      env: importer.env,
      policy,
      label: IMPORT_LABEL,
      timeoutMs: deps.timeoutMs ?? IMPORT_TIMEOUT_MS,
      maxOutputBytes: IMPORT_OUTPUT_KEEP_CHARS,
      reapGroup: true,
    });
  } catch {
    return null;
  } finally {
    await sandbox.dispose();
  }
}

/** Whether `bytes` are the kind of file `output` names. */
function looksLike(output: string, bytes: Uint8Array): boolean {
  if (output === "glb") {
    if (!isGlb(bytes)) return false;
    try {
      readGlb(bytes);
      return true;
    } catch {
      return false;
    }
  }
  if (output === "ktx2") return readKtx2Header(bytes) !== null;
  if (output === "hdr") return looksLikeRadiance(bytes);
  if (output === "ogg") return OGG_MAGIC.every((byte, i) => bytes[i] === byte);
  if (output === "gltf") {
    try {
      return typeof JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) === "object";
    } catch {
      return false;
    }
  }
  return false;
}

/** One output as the host admits it: a regular file in `out/`, not a link, of the planned kind and size. */
async function admitOutput(jobDir: string, planned: Planned, source: string): Promise<ImportOutput | null> {
  const file = path.join(jobDir, ...planned.job.output.split("/"));
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.size > IMPORT_OUTPUT_MAX_BYTES) return null;
  const bytes = await readRegularFile(file, IMPORT_OUTPUT_MAX_BYTES).catch(() => null);
  if (!bytes || !looksLike(planned.step.output, bytes)) return null;
  // A kept KTX2 or HDR map must be the very file delivered: the importer only checks it.
  if (planned.step.converter === ImportConverter.Ktx2Check || planned.step.converter === ImportConverter.HdrCheck) {
    const input = await readFile(path.join(jobDir, ...planned.job.input.split("/")));
    if (sha256(input) !== sha256(bytes)) return null;
  }
  return { path: file, file: outputName(source, planned.step.output), bytes: bytes.byteLength, sha256: sha256(bytes) };
}

/** The receipt, or null when there is none the host accepts. */
async function readReceipt(file: string): Promise<ImportReceipt | null> {
  const bytes = await readRegularFile(file, RECEIPT_MAX_BYTES).catch(() => null);
  if (!bytes) return null;
  try {
    return parseImportReceipt(JSON.parse(bytes.toString("utf8")));
  } catch {
    return null;
  }
}

/** Each planned file's outcome from the receipt, every output checked. */
async function admit(
  jobDir: string,
  receipt: ImportReceipt | null,
  planned: readonly Planned[],
  results: ImportedAsset[],
): Promise<void> {
  const failed = (entry: ImportedAsset) =>
    Object.assign(entry, { action: ImportAction.Refuse, refusal: AssetImportRefusal.ImporterFailed });
  for (const item of planned) {
    const entry = results[item.at];
    if (!entry) continue;
    const line = receipt?.files.find((file) => file.index === item.job.index);
    if (!line) {
      failed(entry);
      continue;
    }
    if (!line.ok) {
      Object.assign(entry, { action: ImportAction.Refuse, refusal: line.refusal });
      continue;
    }
    const output = line.output === item.job.output ? await admitOutput(jobDir, item, entry.file) : null;
    if (!output) failed(entry);
    else Object.assign(entry, { output, ...(line.textures ? { textures: line.textures } : {}) });
  }
}

/**
 * Import `request.files` of a game for its stack: plan each, run the importer once for every file
 * that needs it, and admit what it wrote. Never throws for a file's sake: each file ends kept,
 * skipped, refused (typed) or with an admitted output.
 */
export async function importRustAssets(
  deps: RustAssetImportDeps,
  request: RustAssetImportRequest,
): Promise<RustAssetImportResult> {
  const jobId = deps.newJobId?.() ?? randomUUID();
  const jobDir = path.join(deps.jobsRoot, jobId);
  const folders = jobFolders(jobDir);
  await mkdir(deps.jobsRoot, { recursive: true });
  await mkdir(jobDir);
  await Promise.all([mkdir(folders.in), mkdir(folders.out), mkdir(folders.tmp)]);
  const { results, planned } = await prepare(request, folders);
  if (!planned.length) return { jobId, jobDir, files: results, log: "" };
  const job: ImportJob = {
    version: IMPORT_JOB_VERSION,
    targets: [...request.targets],
    files: planned.map((item) => item.job),
  };
  await writeNewFile(folders.job, JSON.stringify(job));
  const run = await runImporter(deps, jobDir, folders);
  const finished = run !== null && run.code === 0 && !run.timedOut;
  await admit(jobDir, finished ? await readReceipt(folders.receipt) : null, planned, results);
  return { jobId, jobDir, files: results, log: run?.stderr ?? "" };
}

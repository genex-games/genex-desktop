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
 * The build lane runs it on every staged copy (`importStagedAssets`, C-2): each importable file
 * of the stage's `assets/` is a job of its own (the importer is a pure function of one file), at
 * most {@link IMPORT_JOBS_MAX} at once, in the profile's `asset-jobs` folder (`core/layout.ts`).
 * Admitted outputs replace their sources in the stage, never in the game folder: a converted
 * OBJ's GLB takes the OBJ's place, a Draco GLB is written back plain under its own name, and a
 * refused file leaves the stage, so the build ships only what the runtime reads.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MINUTE_MS } from "../shared/duration.ts";
import { assetExtension } from "../shared/game-assets.ts";
import { type BuildTarget, GameStack } from "../shared/game-project.ts";
import { readRegularFile, writeNewFile } from "../substrate/fsx.ts";
import type { TextureUsage } from "../substrate/asset-import/basis-encoder.ts";
import { IMPORTER_TOOLS_ENV } from "../substrate/asset-import/decoders.ts";
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
import { type Ktx2FamilySkip, readKtx2Header } from "../substrate/asset-import/ktx2.ts";
import { objMaterialLibrary } from "../substrate/asset-import/obj.ts";
import { readGameAsset } from "../substrate/asset-import/safe-asset.ts";
import { type EncodedTexture, stageTextureUsages } from "../substrate/asset-import/texture-encode.ts";
import {
  familyFileName,
  KTX2_VK_FORMAT,
  type TextureCompression,
  type TranscodedTexture,
} from "../substrate/asset-import/texture-table.ts";
import {
  ProcessSandbox,
  type RunRequest,
  type RunResult,
  type SandboxOptions,
  type SandboxPolicy,
} from "../substrate/spawn.ts";
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
/** How many per-file import jobs one build runs at once: each is a Node process in a sandbox of its own. */
export const IMPORT_JOBS_MAX = 4;
/** The stage's folder of game assets (`rust-stage.ts` copies the game's `assets/` there). */
const STAGE_ASSETS_DIR = "assets";

/** The steps whose output is their input, kept: the host holds the output to the input's bytes. */
const KEPT_INPUT_STEPS: ReadonlySet<ImportConverter> = new Set([
  ImportConverter.Ktx2Check,
  ImportConverter.HdrCheck,
  ImportConverter.TextureEncode,
]);
/** The steps that write per-family KTX2 files beside their output. */
const FAMILY_STEPS: ReadonlySet<ImportConverter> = new Set([ImportConverter.Ktx2Check, ImportConverter.TextureEncode]);

/** What every admitted output must start with, by output extension. */
const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53] as const;

/** How the importer starts: the argv before the job folder, and its own environment. */
export interface ImporterCommand {
  argv: readonly string[];
  env?: Record<string, string>;
}

/**
 * This process's Node (Electron's, as Node) running `worker.ts`, reading its tools from `toolsDir`
 * (the app's `resources/importer-tools`, `IMPORTER_TOOLS_ENV`) when given.
 */
export function defaultImporterCommand(toolsDir?: string): ImporterCommand {
  const worker = fileURLToPath(new URL("../substrate/asset-import/worker.ts", import.meta.url));
  const electron = typeof process.versions.electron === "string";
  const env: Record<string, string> = {
    ...(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    ...(toolsDir ? { [IMPORTER_TOOLS_ENV]: toolsDir } : {}),
  };
  return { argv: [process.execPath, worker], ...(Object.keys(env).length > 0 ? { env } : {}) };
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
  /** Each loose texture's resolved usage (`texture-usage.ts`), by its path: those are encoded (C-12). */
  usages?: ReadonlyMap<string, TextureUsage>;
  /** The build's Stop: a job in flight is ended, and its file refused `importer-failed`. */
  signal?: AbortSignal;
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
  /** A Basis KTX2's fixed-format file per family (A6.5), each named `<stem>.<family>.ktx2` beside it. */
  families?: ImportOutput[];
  /** Why a Basis KTX2 got no per-family files. */
  familiesSkipped?: Ktx2FamilySkip;
  /** An encoded loose texture's usage, source size and class (C-12). */
  texture?: EncodedTexture;
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
    const usage = request.usages?.get(file);
    const step = planImport(request.stack, file, usage);
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
      ...(step.converter === ImportConverter.TextureEncode && usage ? { usage } : {}),
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
  signal: AbortSignal | undefined,
): Promise<RunResult | null> {
  const importer = deps.importer ?? defaultImporterCommand();
  const policy: Partial<SandboxPolicy> = {
    allowedDomains: [],
    allowWrite: [folders.out],
    denyWrite: [...(deps.denyWrite ?? []), folders.in, folders.job],
  };
  let sandbox: ImportSandbox | null = null;
  try {
    sandbox = await deps.sandboxFor({
      writableRoots: [],
      scratchDir: folders.tmp,
      secretPaths: [...deps.secretPaths],
    });
    return await sandbox.run({
      command: [...importer.argv, jobDir].map(shellQuote).join(" "),
      cwd: jobDir,
      env: importer.env,
      policy,
      label: IMPORT_LABEL,
      timeoutMs: deps.timeoutMs ?? IMPORT_TIMEOUT_MS,
      maxOutputBytes: IMPORT_OUTPUT_KEEP_CHARS,
      reapGroup: true,
      ...(signal ? { signal } : {}),
    });
  } catch {
    return null;
  } finally {
    await sandbox?.dispose();
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
  // An encoded texture's output is its source image, held to the input's digest by `admitOutput`.
  if (output === "png" || output === "jpg" || output === "jpeg") return bytes.byteLength > 0;
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
  // A kept KTX2, HDR map or encoded texture's image must be the very file delivered: the importer only reads it.
  if (KEPT_INPUT_STEPS.has(planned.step.converter)) {
    const input = await readFile(path.join(jobDir, ...planned.job.input.split("/")));
    if (sha256(input) !== sha256(bytes)) return null;
  }
  return { path: file, file: outputName(source, planned.step.output), bytes: bytes.byteLength, sha256: sha256(bytes) };
}

/** A regular file in `out/` (never a link) within the output cap, read; or null. */
async function readOutputFile(file: string): Promise<Uint8Array | null> {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.size > IMPORT_OUTPUT_MAX_BYTES) return null;
  return await readRegularFile(file, IMPORT_OUTPUT_MAX_BYTES).catch(() => null);
}

/** One family's KTX2 as the host admits it: a KTX2 in that family's own fixed format, plain levels. */
async function admitFamily(
  jobDir: string,
  family: { compression: TextureCompression; output: string },
  source: string,
): Promise<ImportOutput | null> {
  const file = path.join(jobDir, ...family.output.split("/"));
  const bytes = await readOutputFile(file);
  const header = bytes ? readKtx2Header(bytes) : null;
  const formats: readonly number[] = Object.values(KTX2_VK_FORMAT[family.compression]);
  if (!bytes || !header || !formats.includes(header.vkFormat) || header.supercompression !== 0) return null;
  return {
    path: file,
    file: familyFileName(source, family.compression),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

/** Every family file of a receipt line admitted, or null when any one is not. */
async function admitFamilies(
  jobDir: string,
  line: Extract<ImportReceipt["files"][number], { ok: true }>,
  source: string,
): Promise<ImportOutput[] | null> {
  const admitted: ImportOutput[] = [];
  for (const family of line.families ?? []) {
    const output = await admitFamily(jobDir, family, source);
    if (!output) return null;
    admitted.push(output);
  }
  return admitted;
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

/** What one planned file's receipt line comes to: its admitted outputs, or how it failed. */
async function admitLine(
  jobDir: string,
  item: Planned,
  entry: ImportedAsset,
  line: ImportReceipt["files"][number] | undefined,
): Promise<Partial<ImportedAsset>> {
  const failed = { action: ImportAction.Refuse, refusal: AssetImportRefusal.ImporterFailed };
  if (!line) return failed;
  if (!line.ok) return { action: ImportAction.Refuse, refusal: line.refusal };
  const output = line.output === item.job.output ? await admitOutput(jobDir, item, entry.file) : null;
  if (!output) return failed;
  const families = FAMILY_STEPS.has(item.step.converter) ? await admitFamilies(jobDir, line, entry.file) : [];
  if (!families) return failed;
  const texture = item.step.converter === ImportConverter.TextureEncode ? line.texture : undefined;
  return {
    output,
    ...(line.textures ? { textures: line.textures } : {}),
    ...(line.families ? { families } : {}),
    ...(line.familiesSkipped ? { familiesSkipped: line.familiesSkipped } : {}),
    ...(texture ? { texture } : {}),
  };
}

/** Each planned file's outcome from the receipt, every output checked. */
async function admit(
  jobDir: string,
  receipt: ImportReceipt | null,
  planned: readonly Planned[],
  results: ImportedAsset[],
): Promise<void> {
  for (const item of planned) {
    const entry = results[item.at];
    if (!entry) continue;
    const line = receipt?.files.find((file) => file.index === item.job.index);
    Object.assign(entry, await admitLine(jobDir, item, entry, line));
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
  const run = await runImporter(deps, jobDir, folders, request.signal);
  const finished = run !== null && run.code === 0 && !run.timedOut;
  await admit(jobDir, finished ? await readReceipt(folders.receipt) : null, planned, results);
  return { jobId, jobDir, files: results, log: run?.stderr ?? "" };
}

/**
 * Why the stage step did not place a file's admitted output, beside the importer's own refusals.
 * Wire values in the build receipt: never rename one.
 */
export const StagePlacementRefusal = {
  /** Another staged file (a delivered GLB, or an earlier conversion) already holds the output's name. */
  NameTaken: "name-taken",
} as const;
export type StagePlacementRefusal = (typeof StagePlacementRefusal)[keyof typeof StagePlacementRefusal];

/** A file the stage step placed: its game-relative name, digest and size (never a job path). */
export interface StagedAssetFile {
  file: string;
  sha256: string;
  bytes: number;
}

/** What the stage step did with one staged file: the build receipt's `assets.files` row. */
export interface StagedImportFile {
  file: string;
  action: ImportAction;
  converter?: ImportConverter;
  refusal?: AssetImportRefusal | StagePlacementRefusal;
  /** The output placed in the stage (for a converted file, under its new name). */
  output?: StagedAssetFile;
  /** A Basis KTX2's (or an encoded texture's) per-family files placed beside it. */
  families?: StagedAssetFile[];
  familiesSkipped?: Ktx2FamilySkip;
  /** An encoded loose texture's usage, source size and class (C-12). */
  texture?: EncodedTexture;
}

/** The stage step's record in the build receipt (`assets`). */
export interface StagedImportReport {
  /** The jobs it ran at once, at most. */
  jobs: number;
  /** How long it took. */
  ms: number;
  /** Every staged file, in `/`-separated code-unit order. */
  files: StagedImportFile[];
}

/** One build's stage to import for its destination. */
export interface RustStageImportRequest {
  /** The build's staged copy (`<bin>.stage`), the host's own. */
  stage: string;
  target: BuildTarget;
  signal?: AbortSignal;
}

/** How the stage step runs: its concurrency and clock. */
export interface RustStageImportOptions {
  /** Jobs at once, clamped to 1..{@link IMPORT_JOBS_MAX} (default the max). */
  jobs?: number;
  now?: () => number;
}

/** The build lane's import step (`RustBuildsOptions.importAssets`): the report, or null once Stop came. */
export type RustStageImport = (request: RustStageImportRequest) => Promise<StagedImportReport | null>;

/** The jobs at once for `asked`: a whole number in 1..{@link IMPORT_JOBS_MAX}. */
function importJobs(asked: number | undefined): number {
  if (asked === undefined || !Number.isFinite(asked)) return IMPORT_JOBS_MAX;
  return Math.min(IMPORT_JOBS_MAX, Math.max(1, Math.floor(asked)));
}

/** The regular files under the stage's `assets/`, `/`-separated, in code-unit order; links and odd files left out. */
async function stagedAssets(stage: string, rel = STAGE_ASSETS_DIR): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(path.join(stage, ...rel.split("/")), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await stagedAssets(stage, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort((a, b) => (a < b ? -1 : Number(a > b)));
}

/** Every file planned; the importable ones run as per-file jobs, `jobs` at once. Null once Stop came. */
async function importEach(
  deps: RustAssetImportDeps,
  request: RustStageImportRequest,
  files: readonly string[],
  jobs: number,
  jobDirs: string[],
): Promise<ImportedAsset[] | null> {
  const results: ImportedAsset[] = [];
  const queue: number[] = [];
  const usages = new Map<string, TextureUsage>();
  for (const row of await stageTextureUsages(request.stage, files)) if (row.usage) usages.set(row.path, row.usage);
  for (const [at, file] of files.entries()) {
    const step = planImport(GameStack.RustWgpu, file, usages.get(file));
    results.push({ file, action: step.action, ...(step.refusal ? { refusal: step.refusal } : {}) });
    if (runsImporter(step)) queue.push(at);
  }
  const targets = [request.target];
  let next = 0;
  const worker = async () => {
    for (let at = queue[next++]; at !== undefined && !request.signal?.aborted; at = queue[next++]) {
      const file = files[at] ?? "";
      const one = await importRustAssets(deps, {
        gameRoot: request.stage,
        stack: GameStack.RustWgpu,
        files: [file],
        targets,
        usages,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      jobDirs.push(one.jobDir);
      const failed = { file, action: ImportAction.Refuse, refusal: AssetImportRefusal.ImporterFailed };
      results[at] = one.files[0] ?? failed;
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
  return request.signal?.aborted ? null : results;
}

/** An admitted output read back and checked against its admitted digest; null when it changed. */
async function admittedBytes(output: ImportOutput): Promise<Uint8Array | null> {
  const bytes = await readOutputFile(output.path);
  return bytes && sha256(bytes) === output.sha256 ? bytes : null;
}

/** `bytes` written at `rel` in the stage in place of what is there; false when a folder holds the name. */
async function placeFile(stage: string, rel: string, bytes: Uint8Array): Promise<boolean> {
  const file = path.join(stage, ...rel.split("/"));
  const found = await lstat(file).catch(() => null);
  if (found?.isDirectory()) return false;
  // A link (never a staged file of the walk) is removed, never written through.
  await rm(file, { force: true });
  return await writeNewFile(file, bytes);
}

const digestOf = (output: ImportOutput): StagedAssetFile => ({
  file: output.file,
  sha256: output.sha256,
  bytes: output.bytes,
});

/** Whether `name` is held by a staged file other than `own`. */
const takenBy = (taken: ReadonlySet<string>, name: string, own: string) => name !== own && taken.has(name);

/** An admitted file's family KTX2s placed beside it; one whose name another staged file holds is left out. */
async function placeFamilies(stage: string, entry: ImportedAsset, taken: Set<string>): Promise<StagedAssetFile[]> {
  const families: StagedAssetFile[] = [];
  for (const family of entry.families ?? []) {
    const familyBytes = takenBy(taken, family.file, entry.file) ? null : await admittedBytes(family);
    if (!familyBytes || !(await placeFile(stage, family.file, familyBytes))) continue;
    taken.add(family.file);
    families.push(digestOf(family));
  }
  return families;
}

/** One admitted file placed in the stage: its row, refused `name-taken` when its output's name is held. */
async function placeOne(stage: string, entry: ImportedAsset, taken: Set<string>): Promise<StagedImportFile> {
  const { file, action, converter, output } = entry;
  const row: StagedImportFile = { file, action, ...(converter ? { converter } : {}) };
  const refuse = (refusal: AssetImportRefusal | StagePlacementRefusal): StagedImportFile => ({ ...row, refusal });
  if (!output) return refuse(AssetImportRefusal.ImporterFailed);
  if (takenBy(taken, output.file, file)) return refuse(StagePlacementRefusal.NameTaken);
  const bytes = await admittedBytes(output);
  if (!bytes) return refuse(AssetImportRefusal.ImporterFailed);
  if (!(await placeFile(stage, output.file, bytes))) return refuse(StagePlacementRefusal.NameTaken);
  taken.add(output.file);
  if (output.file !== file) await rm(path.join(stage, ...file.split("/")), { force: true });
  const families = await placeFamilies(stage, entry, taken);
  return {
    ...row,
    output: digestOf(output),
    ...(entry.families ? { families } : {}),
    ...(entry.familiesSkipped ? { familiesSkipped: entry.familiesSkipped } : {}),
    ...(entry.texture ? { texture: entry.texture } : {}),
  };
}

/**
 * Every result placed in the stage, in order: refused files leave it first (freeing their names),
 * then each admitted output takes its source's place unless another staged file holds its name.
 */
async function placeAll(
  stage: string,
  sources: readonly string[],
  results: readonly ImportedAsset[],
): Promise<StagedImportFile[]> {
  const taken = new Set(sources);
  for (const entry of results) {
    if (entry.action !== ImportAction.Refuse) continue;
    taken.delete(entry.file);
    await rm(path.join(stage, ...entry.file.split("/")), { force: true });
  }
  const rows: StagedImportFile[] = [];
  for (const entry of results) {
    const runs = entry.action === ImportAction.Normalize || entry.action === ImportAction.Convert;
    if (runs) {
      const row = await placeOne(stage, entry, taken);
      if (row.refusal) await rm(path.join(stage, ...entry.file.split("/")), { force: true });
      rows.push(row);
      continue;
    }
    const { file, action, converter, refusal } = entry;
    rows.push({ file, action, ...(converter ? { converter } : {}), ...(refusal ? { refusal } : {}) });
  }
  return rows;
}

/**
 * The build lane's import step over a staged copy (C-2): every regular file of the stage's
 * `assets/` planned for `target`, the importable ones run as sandboxed per-file jobs, and what was
 * admitted placed back into the stage (see {@link placeAll}). No sandbox starts when no file runs
 * the importer. The job folders are removed before it answers. Null once the build's Stop came.
 */
export async function importStagedAssets(
  deps: RustAssetImportDeps,
  request: RustStageImportRequest & RustStageImportOptions,
): Promise<StagedImportReport | null> {
  if (request.signal?.aborted) return null;
  const now = request.now ?? Date.now;
  const started = now();
  const jobs = importJobs(request.jobs);
  const sources = await stagedAssets(request.stage);
  const jobDirs: string[] = [];
  try {
    const results = await importEach(deps, request, sources, jobs, jobDirs);
    if (!results) return null;
    const files = await placeAll(request.stage, sources, results);
    return { jobs, ms: Math.max(0, now() - started), files };
  } finally {
    await Promise.all(jobDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

/** The lane's import step over `deps` (the profile's jobs folder and the importer's sandboxes). */
export function rustStageImporter(deps: RustAssetImportDeps, options: RustStageImportOptions = {}): RustStageImport {
  return async (request) => await importStagedAssets(deps, { ...request, ...options });
}

/** What the importer's sandbox factory is built with: whether sandboxing is on, and the core's sandbox to put back. */
export interface RustImportSandboxesOptions {
  /** False only where the core's own sandbox is off. */
  enabled?: boolean;
  /**
   * The core's sandbox, whose config goes back into the one process-wide runtime once a job's
   * sandbox has pushed its own, and again once it goes (as `rustBuildSandboxes` does).
   */
  alongside?: Pick<ProcessSandbox, "refreshConfig">;
}

/** A `ProcessSandbox` per import job, as {@link RustAssetImportDeps.sandboxFor} asks for one. */
export function rustImportSandboxes(options: RustImportSandboxesOptions = {}): RustAssetImportDeps["sandboxFor"] {
  return async (sandboxOptions) => {
    const sandbox = await ProcessSandbox.create({
      ...sandboxOptions,
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    });
    options.alongside?.refreshConfig();
    return {
      run: (request) => sandbox.run(request),
      dispose: async () => {
        await sandbox.dispose();
        options.alongside?.refreshConfig();
      },
    };
  };
}

/**
 * The importer's job folder and the two files that cross the sandbox: `job.json`, written by the
 * host (what to convert, from which copied input to which output), and `out/receipt.json`, written
 * by the importer (what it wrote or why it refused). The host trusts neither the receipt's paths
 * nor its digests: it checks every output itself (`main/rust-assets.ts`).
 *
 *   <job>/job.json      host-written, read-only to the importer
 *   <job>/in/<n>.<ext>  host-written copies of the game's files (never links)
 *   <job>/out/          the one folder the importer writes, with receipt.json
 *   <job>/tmp/          the importer's TMPDIR
 */
import { BuildTarget } from "../../shared/game-project.ts";
import { type AssetImportRefusal, ImportConverter, isAssetImportRefusal } from "./import-plan.ts";
import { TextureCompression, type TranscodedTexture } from "./texture-table.ts";

/** The job folder's fixed names. Wire values between host and importer: never rename one. */
export const ImportJobLayout = {
  Job: "job.json",
  In: "in",
  Out: "out",
  Tmp: "tmp",
  Receipt: "receipt.json",
} as const;

/** The version of `job.json` and `receipt.json` this build writes and reads. */
export const IMPORT_JOB_VERSION = 1;
/** The longest `detail` a receipt entry keeps: a log line, never shown as copy. */
export const IMPORT_DETAIL_MAX_CHARS = 300;

/** One file of a job. */
export interface ImportJobFile {
  index: number;
  /** The copied input, `in/<index>.<ext>`. */
  input: string;
  /** The input's lowercase extension. */
  ext: string;
  converter: ImportConverter;
  /** Where the importer writes, `out/<index>.<output ext>`. */
  output: string;
  /** The model's name in the GLB: the file's stem. */
  name: string;
  /** An OBJ's material library, copied as `in/<index>.mtl`, and its folder relative to the OBJ. */
  mtl?: { input: string; dir: string };
}

/** `job.json`. */
export interface ImportJob {
  version: number;
  /** The game's destinations: the texture families a KTX2 is transcoded to. */
  targets: BuildTarget[];
  files: ImportJobFile[];
}

/** One file's line in the receipt. */
export type ImportReceiptEntry =
  | { index: number; ok: true; output: string; textures?: TranscodedTexture[] }
  | { index: number; ok: false; refusal: AssetImportRefusal; detail: string };

/** `out/receipt.json`. */
export interface ImportReceipt {
  version: number;
  files: ImportReceiptEntry[];
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isIndex = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const CONVERTERS: readonly string[] = Object.values(ImportConverter);
/** Every destination, mobile included: the texture table has a row for each. */
const TARGETS: readonly unknown[] = Object.values(BuildTarget);
const FAMILIES: readonly string[] = Object.values(TextureCompression);
/** `in/3.obj`, `out/3.glb`: a folder, an index, an extension of letters and digits. */
const JOB_FILE = /^(in|out)\/(\d+)\.([a-z0-9]{1,8})$/;

/** Whether `rel` is `<folder>/<index>.<ext>` for exactly this folder and index. */
export function isJobFile(rel: unknown, folder: "in" | "out", at: number): rel is string {
  const match = typeof rel === "string" ? JOB_FILE.exec(rel) : null;
  return match !== null && match[1] === folder && Number(match[2]) === at;
}

function parseJobFile(value: unknown): ImportJobFile | null {
  if (!isObject(value) || !isIndex(value.index)) return null;
  const { index, input, ext, converter, output, name, mtl } = value;
  const valid =
    isJobFile(input, "in", index) &&
    isJobFile(output, "out", index) &&
    typeof ext === "string" &&
    typeof converter === "string" &&
    CONVERTERS.includes(converter) &&
    typeof name === "string";
  if (!valid) return null;
  const file: ImportJobFile = { index, input, ext, converter: converter as ImportConverter, output, name };
  if (mtl === undefined) return file;
  if (!isObject(mtl) || !isJobFile(mtl.input, "in", index) || typeof mtl.dir !== "string") return null;
  return { ...file, mtl: { input: mtl.input, dir: mtl.dir } };
}

/** A job file as the importer reads it, or null for anything else. */
export function parseImportJob(value: unknown): ImportJob | null {
  if (!isObject(value) || value.version !== IMPORT_JOB_VERSION) return null;
  if (!Array.isArray(value.targets) || !Array.isArray(value.files)) return null;
  const targets = value.targets.filter((t): t is BuildTarget => TARGETS.includes(t));
  const files = value.files.map(parseJobFile);
  if (targets.length !== value.targets.length || files.some((file) => file === null)) return null;
  return { version: IMPORT_JOB_VERSION, targets, files: files as ImportJobFile[] };
}

function parseTexture(value: unknown): TranscodedTexture | null {
  if (!isObject(value)) return null;
  const { compression, format, bytes, sha256 } = value;
  const valid =
    typeof compression === "string" &&
    FAMILIES.includes(compression) &&
    isIndex(format) &&
    isIndex(bytes) &&
    typeof sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(sha256);
  return valid ? { compression: compression as TextureCompression, format, bytes, sha256 } : null;
}

function parseEntry(value: unknown): ImportReceiptEntry | null {
  if (!isObject(value) || !isIndex(value.index)) return null;
  if (value.ok === false) {
    if (!isAssetImportRefusal(value.refusal)) return null;
    const detail = typeof value.detail === "string" ? value.detail.slice(0, IMPORT_DETAIL_MAX_CHARS) : "";
    return { index: value.index, ok: false, refusal: value.refusal, detail };
  }
  if (value.ok !== true || !isJobFile(value.output, "out", value.index)) return null;
  if (value.textures === undefined) return { index: value.index, ok: true, output: value.output };
  if (!Array.isArray(value.textures)) return null;
  const textures = value.textures.map(parseTexture);
  if (textures.some((texture) => texture === null)) return null;
  return { index: value.index, ok: true, output: value.output, textures: textures as TranscodedTexture[] };
}

/** A receipt as the host reads it: entries it cannot read are dropped (their files count as failed). */
export function parseImportReceipt(value: unknown): ImportReceipt | null {
  if (!isObject(value) || value.version !== IMPORT_JOB_VERSION || !Array.isArray(value.files)) return null;
  const files = value.files.map(parseEntry).filter((entry): entry is ImportReceiptEntry => entry !== null);
  return { version: IMPORT_JOB_VERSION, files };
}

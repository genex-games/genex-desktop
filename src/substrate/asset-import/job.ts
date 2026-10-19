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
import type { TextureUsage } from "./basis-encoder.ts";
import { type AssetImportRefusal, ImportConverter, isAssetImportRefusal } from "./import-plan.ts";
import { type ImportSizes, parseImportSizes } from "./inspect.ts";
import { Ktx2FamilySkip } from "./ktx2.ts";
import { type EncodedTexture, parseEncodedTexture } from "./texture-encode.ts";
import { TextureCompression, type TranscodedTexture } from "./texture-table.ts";
import { isTextureUsage } from "./texture-usage.ts";

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
/** The most validator warnings a receipt entry keeps. */
export const IMPORT_ISSUES_MAX = 32;
/** The longest JSON pointer a receipt issue keeps. */
const ISSUE_POINTER_MAX_CHARS = 256;
/** A validator issue code: the Khronos validator's spelling. */
const ISSUE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** A warning the glTF validator found in an input (`validate.ts`), as the receipt carries it. */
export interface ImportIssue {
  code: string;
  pointer?: string;
}

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
  /** A `texture-encode` file's resolved usage (C-12). */
  usage?: TextureUsage;
}

/** `job.json`. */
export interface ImportJob {
  version: number;
  /** The game's destinations: the texture families a KTX2 is transcoded to. */
  targets: BuildTarget[];
  files: ImportJobFile[];
}

/** A Basis KTX2's file for one family (A6.5), `out/<index>.<family>.ktx2`. */
export interface ImportFamilyOutput {
  compression: TextureCompression;
  output: string;
}

/** One file's line in the receipt. */
export type ImportReceiptEntry =
  | {
      index: number;
      ok: true;
      output: string;
      textures?: TranscodedTexture[];
      families?: ImportFamilyOutput[];
      familiesSkipped?: Ktx2FamilySkip;
      issues?: ImportIssue[];
      /** The written GLB's counts and bytes (C-7). */
      sizes?: ImportSizes;
      /** An encoded loose texture's usage, source size and class (C-12). */
      texture?: EncodedTexture;
    }
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

const SKIPS: readonly string[] = Object.values(Ktx2FamilySkip);

/** Where the importer writes file `index`'s KTX2 for `compression`. */
export const familyOutput = (index: number, compression: TextureCompression) =>
  `${ImportJobLayout.Out}/${index}.${compression}.ktx2`;

/** Whether `rel` is `<folder>/<index>.<ext>` for exactly this folder and index. */
export function isJobFile(rel: unknown, folder: "in" | "out", at: number): rel is string {
  const match = typeof rel === "string" ? JOB_FILE.exec(rel) : null;
  return match !== null && match[1] === folder && Number(match[2]) === at;
}

function parseJobFile(value: unknown): ImportJobFile | null {
  if (!isObject(value) || !isIndex(value.index)) return null;
  const { index, input, ext, converter, output, name, mtl, usage } = value;
  const valid =
    isJobFile(input, "in", index) &&
    isJobFile(output, "out", index) &&
    typeof ext === "string" &&
    typeof converter === "string" &&
    CONVERTERS.includes(converter) &&
    typeof name === "string" &&
    (usage === undefined || isTextureUsage(usage));
  if (!valid) return null;
  const file: ImportJobFile = {
    index,
    input,
    ext,
    converter: converter as ImportConverter,
    output,
    name,
    ...(isTextureUsage(usage) ? { usage } : {}),
  };
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

/** A line's family files: each named for its index and a family of its own, or null. */
function parseFamilies(value: unknown, index: number): ImportFamilyOutput[] | null {
  if (!Array.isArray(value)) return null;
  const families = value.map((item): ImportFamilyOutput | null => {
    if (!isObject(item) || typeof item.compression !== "string" || !FAMILIES.includes(item.compression)) return null;
    const compression = item.compression as TextureCompression;
    return item.output === familyOutput(index, compression) ? { compression, output: item.output } : null;
  });
  const distinct = new Set(families.map((family) => family?.compression)).size === families.length;
  return distinct && families.every((family) => family !== null) ? (families as ImportFamilyOutput[]) : null;
}

/** A line's optional texture fields (`textures`, `families`, `familiesSkipped`), or null when one is bad. */
function parseTextureFields(value: Json, index: number): Partial<Extract<ImportReceiptEntry, { ok: true }>> | null {
  const fields: Partial<Extract<ImportReceiptEntry, { ok: true }>> = {};
  if (value.textures !== undefined) {
    const textures = Array.isArray(value.textures) ? value.textures.map(parseTexture) : [null];
    if (textures.some((texture) => texture === null)) return null;
    fields.textures = textures as TranscodedTexture[];
  }
  if (value.families !== undefined) {
    const families = parseFamilies(value.families, index);
    if (!families) return null;
    fields.families = families;
  }
  if (value.familiesSkipped !== undefined) {
    if (typeof value.familiesSkipped !== "string" || !SKIPS.includes(value.familiesSkipped)) return null;
    fields.familiesSkipped = value.familiesSkipped as Ktx2FamilySkip;
  }
  if (value.texture !== undefined) {
    const texture = parseEncodedTexture(value.texture);
    if (!texture) return null;
    fields.texture = texture;
  }
  return fields;
}

/** A receipt's issues: at most {@link IMPORT_ISSUES_MAX}, each a code and an optional pointer; null when one is bad. */
export function parseIssues(value: unknown): ImportIssue[] | null {
  if (!Array.isArray(value) || value.length > IMPORT_ISSUES_MAX) return null;
  const issues = value.map((item): ImportIssue | null => {
    if (!isObject(item) || typeof item.code !== "string" || !ISSUE_CODE.test(item.code)) return null;
    if (item.pointer === undefined) return { code: item.code };
    const pointer = typeof item.pointer === "string" && item.pointer.length <= ISSUE_POINTER_MAX_CHARS;
    return pointer ? { code: item.code, pointer: item.pointer as string } : null;
  });
  return issues.every((issue) => issue !== null) ? (issues as ImportIssue[]) : null;
}

function parseEntry(value: unknown): ImportReceiptEntry | null {
  if (!isObject(value) || !isIndex(value.index)) return null;
  if (value.ok === false) {
    if (!isAssetImportRefusal(value.refusal)) return null;
    const detail = typeof value.detail === "string" ? value.detail.slice(0, IMPORT_DETAIL_MAX_CHARS) : "";
    return { index: value.index, ok: false, refusal: value.refusal, detail };
  }
  if (value.ok !== true || !isJobFile(value.output, "out", value.index)) return null;
  const fields = parseTextureFields(value, value.index);
  const issues = value.issues === undefined ? undefined : parseIssues(value.issues);
  const sizes = value.sizes === undefined ? undefined : parseImportSizes(value.sizes);
  if (!fields || issues === null || sizes === null) return null;
  return {
    index: value.index,
    ok: true,
    output: value.output,
    ...fields,
    ...(issues ? { issues } : {}),
    ...(sizes ? { sizes } : {}),
  };
}

/** A receipt as the host reads it: entries it cannot read are dropped (their files count as failed). */
export function parseImportReceipt(value: unknown): ImportReceipt | null {
  if (!isObject(value) || value.version !== IMPORT_JOB_VERSION || !Array.isArray(value.files)) return null;
  const files = value.files.map(parseEntry).filter((entry): entry is ImportReceiptEntry => entry !== null);
  return { version: IMPORT_JOB_VERSION, files };
}

/**
 * One importer step, in process: the bytes of a copied input in, the bytes the runtime loads (or
 * a typed refusal) out. The sandboxed importer (`worker.ts`) runs this for every file of its job;
 * nothing here touches the file system beyond the decoders' own files.
 */
import type { ImportIssue as ReportIssue } from "../../shared/asset-db.ts";
import type { CharacterFacts } from "../../shared/character-facts.ts";
import type { BuildTarget } from "../../shared/game-project.ts";
import { ImportIssueCode } from "../../shared/asset-db.ts";
import { MODEL_IMPORT_TRIANGLES } from "../../shared/model-budget.ts";
import { audioToOgg } from "./audio-ogg.ts";
import type { TextureUsage } from "./basis-encoder.ts";
import { characterFacts } from "./character-facts.ts";
import { decimateGlb } from "./decimate.ts";
import { meshoptSimplifier } from "./decoders.ts";
import { GlbError, meshToGlb } from "./glb.ts";
import { addGlbTextures, type GlbTextureSidecar } from "./glb-textures.ts";
import { importGltf } from "./gltf-decompress.ts";
import { GltfImportError } from "./gltf-json.ts";
import { type ImportSizes, inspectGlb } from "./inspect.ts";
import { checkRadiance, HdrError } from "./hdr.ts";
import { AssetImportRefusal, ImportConverter } from "./import-plan.ts";
import {
  isBasisKtx2,
  Ktx2Error,
  type Ktx2FamilyFile,
  type Ktx2FamilySkip,
  readKtx2Header,
  transcodeKtx2,
  transcodeKtx2Families,
} from "./ktx2.ts";
import { foldAuthoredLods, liftMsftLod } from "./lod-authored.ts";
import { addLodExtras } from "./lods.ts";
import { addMeshletExtras } from "./meshlets.ts";
import { MeshFormatError, objToMesh } from "./obj.ts";
import { reorderGlb } from "./reorder.ts";
import { reportGlb } from "./report.ts";
import { plyToMesh, stlToMesh } from "./stl-ply.ts";
import { addTangents } from "./tangents.ts";
import { type EncodedTexture, encodeTexture, requireUsage, TextureDecodeError } from "./texture-encode.ts";
import { type TranscodedTexture, texturesForTargets } from "./texture-table.ts";
import type { GltfIssue } from "./validate.ts";
import { weldGlb } from "./weld.ts";

/** One file for a step. */
export interface ConvertInput {
  converter: ImportConverter;
  /** The input's lowercase extension. */
  ext: string;
  /** The model's name: the file's stem. */
  name: string;
  bytes: Uint8Array;
  /** An OBJ's material library and its folder relative to the OBJ. */
  mtl?: { text: string; dir: string };
  /** The game's destinations. */
  targets: readonly BuildTarget[];
  /** The fewest triangles a GLB needs to get import-time meshlets; the renderer's default when absent. */
  meshletMinTriangles?: number;
  /** A `texture-encode` file's resolved usage (`texture-usage.ts`). */
  usage?: TextureUsage;
  /** The most triangles a static model imports with (decimated to it past it); the import cap when absent. */
  triangleBudget?: number;
}

/** What a step wrote, or why it refused. */
export type ConvertResult =
  | {
      ok: true;
      bytes: Uint8Array;
      textures?: TranscodedTexture[];
      /** A Basis KTX2's fixed-format file per family (A6.5). */
      families?: Ktx2FamilyFile[];
      /** Why a Basis KTX2 got no per-family files. */
      familiesSkipped?: Ktx2FamilySkip;
      /** The glTF validator's warnings about the input (`validate.ts`). */
      issues?: GltfIssue[];
      /** The written GLB's counts and bytes (C-7), for the receipt. */
      sizes?: ImportSizes;
      /** An encoded loose texture's usage, source size and class (C-12). */
      texture?: EncodedTexture;
      /** A GLB's embedded images as per-family KTX2 sidecars, named in its `genex_textures` (C-13). */
      sidecars?: GlbTextureSidecar[];
      /** The validation report's issues about the written GLB (C-23). */
      report?: ReportIssue[];
      /** A rigged GLB's facts (C-23). */
      character?: CharacterFacts;
    }
  | { ok: false; refusal: AssetImportRefusal; detail: string };

const MESSAGE = {
  NotKtx2: "not a KTX2 file",
} as const;

const refused = (refusal: AssetImportRefusal, detail: string): ConvertResult => ({ ok: false, refusal, detail });

/**
 * A KTX2 texture checked against every family its game's destinations may pick, and transcoded
 * into each family's file when it is square with its whole chain; the file itself is kept.
 */
async function checkKtx2(input: ConvertInput): Promise<ConvertResult> {
  const header = readKtx2Header(input.bytes);
  if (!header) return refused(AssetImportRefusal.Malformed, MESSAGE.NotKtx2);
  // A KTX2 in a fixed GPU format has nothing to transcode: the runtime loads it where the device has that format.
  if (!isBasisKtx2(header)) return { ok: true, bytes: input.bytes, textures: [] };
  const families = texturesForTargets(input.targets);
  const textures = await transcodeKtx2(input.bytes, families);
  const transcoded = await transcodeKtx2Families(input.bytes, families);
  const extra = "files" in transcoded ? { families: transcoded.files } : { familiesSkipped: transcoded.skipped };
  return { ok: true, bytes: input.bytes, textures, ...extra };
}

/** A loose PNG or JPEG encoded per family for its usage (C-12); the image itself is kept as the fallback. */
async function encodeLoose(input: ConvertInput): Promise<ConvertResult> {
  const { files, texture } = await encodeTexture(
    input.bytes,
    requireUsage(input.usage),
    texturesForTargets(input.targets),
  );
  return { ok: true, bytes: input.bytes, families: files, texture };
}

/** A Radiance map checked against the renderer's caps; the file is kept. */
function checkHdr(input: ConvertInput): ConvertResult {
  checkRadiance(input.bytes);
  return { ok: true, bytes: input.bytes };
}

/** What the mesh steps noticed that the receipt names: a decimation's triangles before and after. */
interface MeshNotes {
  decimated?: { before: number; after: number };
}

/** One optional mesh step: a GLB in, the GLB to hand on out (the same bytes when the step skips). */
type MeshStep = (glb: Uint8Array, input: ConvertInput, notes: MeshNotes) => Promise<Uint8Array>;

/** A static model over its budget brought down to it (WP-0/WP-6), noted for the receipt. */
const decimateStep: MeshStep = async (glb, input, notes) => {
  const outcome = await decimateGlb(glb, input.triangleBudget ?? MODEL_IMPORT_TRIANGLES, await meshoptSimplifier());
  if (!outcome.decimated) return glb;
  notes.decimated = { before: outcome.before, after: outcome.after };
  return outcome.bytes;
};

/**
 * The mesh steps in order. Weld comes before tangents (MikkTSpace splits only what welded vertices
 * still disagree on) and both before the reorder, which fixes the vertex order the meshlets and LODs
 * then index; the extras name views by index, so nothing rewrites vertices after them. A model over
 * its triangle budget is decimated right after the weld, so every later step works on LOD0 at the
 * budget. Authored `MSFT_lod` levels are lifted into a private extra before the weld and folded into
 * `genex_lods` after the reorder (LOD-11).
 */
const MESH_STEPS: readonly MeshStep[] = [
  async (glb) => liftMsftLod(glb).bytes,
  async (glb) => weldGlb(glb).bytes,
  decimateStep,
  async (glb) => (await addTangents(glb)).bytes,
  async (glb) => (await reorderGlb(glb)).bytes,
  async (glb) => (await foldAuthoredLods(glb)).bytes,
  async (glb, input) => {
    const minTriangles = input.meshletMinTriangles;
    return (await addMeshletExtras(glb, minTriangles === undefined ? {} : { minTriangles })).bytes;
  },
  async (glb) => (await addLodExtras(glb)).bytes,
];

/** The receipt's issue for a decimation, before the report's own. */
const decimatedIssues = (notes: MeshNotes): ReportIssue[] =>
  notes.decimated
    ? [{ code: ImportIssueCode.Decimated, detail: `${notes.decimated.before}/${notes.decimated.after}` }]
    : [];

/**
 * A GLB the runtime loads: welded, deduplicated and pruned (C-7), decimated to its triangle budget
 * when it is over it, tangent-complete and in vertex cache and fetch order (C-8), then with
 * import-time meshlets (R2.3) and LODs (A6.9) when it is big enough for each, and its sizes for the
 * receipt; never a refusal.
 */
async function meshSteps(glb: Uint8Array, input: ConvertInput): Promise<ConvertResult> {
  let bytes = glb;
  const notes: MeshNotes = {};
  for (const step of MESH_STEPS) bytes = await step(bytes, input, notes);
  const sizes = inspectGlb(bytes);
  const report = [...decimatedIssues(notes), ...reportGlb(bytes)];
  const character = characterFacts(bytes);
  return {
    ok: true,
    bytes,
    ...(sizes ? { sizes } : {}),
    ...(report.length ? { report } : {}),
    ...(character ? { character } : {}),
  };
}

/**
 * A GLB step's output with its embedded images written out as per-family sidecars (C-13): the last
 * pass, since it only adds `asset.extras.genex_textures` to the JSON. A GLB with none is kept as it is.
 */
async function withGlbTextures(result: ConvertResult, input: ConvertInput): Promise<ConvertResult> {
  if (!result.ok) return result;
  const textures = await addGlbTextures(result.bytes, input.name, texturesForTargets(input.targets));
  if (!textures.encoded) return result;
  const sizes = inspectGlb(textures.bytes);
  return { ...result, bytes: textures.bytes, sidecars: textures.sidecars, ...(sizes ? { sizes } : {}) };
}

const decoder = new TextDecoder();

/** The step's output bytes; throws the converters' own errors. */
async function run(input: ConvertInput): Promise<ConvertResult> {
  switch (input.converter) {
    case ImportConverter.ObjToGlb: {
      const mesh = objToMesh(decoder.decode(input.bytes), input.mtl?.text ?? null, input.mtl?.dir ?? "", input.name);
      return await meshSteps(meshToGlb(mesh), input);
    }
    case ImportConverter.StlToGlb:
      return await meshSteps(meshToGlb(stlToMesh(input.bytes, input.name)), input);
    case ImportConverter.PlyToGlb:
      return await meshSteps(meshToGlb(plyToMesh(input.bytes, input.name)), input);
    case ImportConverter.GltfDecompress: {
      const { bytes, issues } = await importGltf(input.bytes, input.ext);
      const result: ConvertResult =
        input.ext === "glb" ? await withGlbTextures(await meshSteps(bytes, input), input) : { ok: true, bytes };
      return result.ok && issues.length ? { ...result, issues } : result;
    }
    case ImportConverter.Ktx2Check:
      return await checkKtx2(input);
    case ImportConverter.HdrCheck:
      return checkHdr(input);
    case ImportConverter.AudioToOgg:
      // Ogg Vorbis at 48 kHz through the pinned host tool (AU-6); a platform without it refuses converter-missing.
      return await audioToOgg(input);
    case ImportConverter.TextureEncode:
      return await encodeLoose(input);
    case ImportConverter.GlbTextures:
      return await withGlbTextures({ ok: true, bytes: input.bytes }, input);
  }
}

/** One step, its failures as typed refusals. Never throws. */
export async function convertAsset(input: ConvertInput): Promise<ConvertResult> {
  try {
    return await run(input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof GltfImportError) return refused(error.code, detail);
    if (error instanceof TextureDecodeError) return refused(error.refusal, detail);
    if (
      error instanceof MeshFormatError ||
      error instanceof GlbError ||
      error instanceof Ktx2Error ||
      error instanceof HdrError ||
      error instanceof SyntaxError
    ) {
      return refused(AssetImportRefusal.Malformed, detail);
    }
    return refused(AssetImportRefusal.ImporterFailed, detail);
  }
}

/**
 * One importer step, in process: the bytes of a copied input in, the bytes the runtime loads (or
 * a typed refusal) out. The sandboxed importer (`worker.ts`) runs this for every file of its job;
 * nothing here touches the file system beyond the decoders' own files.
 */
import type { BuildTarget } from "../../shared/game-project.ts";
import { meshToGlb } from "./glb.ts";
import { GltfImportError, normalizeGltf } from "./gltf-decompress.ts";
import { checkRadiance, HdrError } from "./hdr.ts";
import { AssetImportRefusal, ImportConverter } from "./import-plan.ts";
import { isBasisKtx2, Ktx2Error, readKtx2Header, transcodeKtx2 } from "./ktx2.ts";
import { addMeshletExtras } from "./meshlets.ts";
import { MeshFormatError, objToMesh } from "./obj.ts";
import { plyToMesh, stlToMesh } from "./stl-ply.ts";
import { type TranscodedTexture, texturesForTargets } from "./texture-table.ts";

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
}

/** What a step wrote, or why it refused. */
export type ConvertResult =
  | { ok: true; bytes: Uint8Array; textures?: TranscodedTexture[] }
  | { ok: false; refusal: AssetImportRefusal; detail: string };

const MESSAGE = {
  NoAudioEncoder: "no Ogg encoder in the toolchain store yet",
  NotKtx2: "not a KTX2 file",
} as const;

const refused = (refusal: AssetImportRefusal, detail: string): ConvertResult => ({ ok: false, refusal, detail });

/** A KTX2 texture checked against every family its game's destinations may pick; the file is kept. */
async function checkKtx2(input: ConvertInput): Promise<ConvertResult> {
  const header = readKtx2Header(input.bytes);
  if (!header) return refused(AssetImportRefusal.Malformed, MESSAGE.NotKtx2);
  // A KTX2 in a fixed GPU format has nothing to transcode: the runtime loads it where the device has that format.
  if (!isBasisKtx2(header)) return { ok: true, bytes: input.bytes, textures: [] };
  const textures = await transcodeKtx2(input.bytes, texturesForTargets(input.targets));
  return { ok: true, bytes: input.bytes, textures };
}

/** A Radiance map checked against the renderer's caps; the file is kept. */
function checkHdr(input: ConvertInput): ConvertResult {
  checkRadiance(input.bytes);
  return { ok: true, bytes: input.bytes };
}

/** A GLB the runtime loads, with import-time meshlets when it is big enough (R2.3); never a refusal. */
async function withMeshlets(glb: Uint8Array, input: ConvertInput): Promise<ConvertResult> {
  const minTriangles = input.meshletMinTriangles;
  const { bytes } = await addMeshletExtras(glb, minTriangles === undefined ? {} : { minTriangles });
  return { ok: true, bytes };
}

const decoder = new TextDecoder();

/** The step's output bytes; throws the converters' own errors. */
async function run(input: ConvertInput): Promise<ConvertResult> {
  switch (input.converter) {
    case ImportConverter.ObjToGlb: {
      const mesh = objToMesh(decoder.decode(input.bytes), input.mtl?.text ?? null, input.mtl?.dir ?? "", input.name);
      return await withMeshlets(meshToGlb(mesh), input);
    }
    case ImportConverter.StlToGlb:
      return await withMeshlets(meshToGlb(stlToMesh(input.bytes, input.name)), input);
    case ImportConverter.PlyToGlb:
      return await withMeshlets(meshToGlb(plyToMesh(input.bytes, input.name)), input);
    case ImportConverter.GltfDecompress:
      return input.ext === "glb"
        ? await withMeshlets(await normalizeGltf(input.bytes, input.ext), input)
        : { ok: true, bytes: await normalizeGltf(input.bytes, input.ext) };
    case ImportConverter.Ktx2Check:
      return await checkKtx2(input);
    case ImportConverter.HdrCheck:
      return checkHdr(input);
    case ImportConverter.AudioToOgg:
      // TODO(M2.3): an Ogg encoder as a pinned store tool; until then Opus and AAC are refused, typed.
      return refused(AssetImportRefusal.ConverterMissing, MESSAGE.NoAudioEncoder);
  }
}

/** One step, its failures as typed refusals. Never throws. */
export async function convertAsset(input: ConvertInput): Promise<ConvertResult> {
  try {
    return await run(input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof GltfImportError) return refused(error.code, detail);
    if (
      error instanceof MeshFormatError ||
      error instanceof Ktx2Error ||
      error instanceof HdrError ||
      error instanceof SyntaxError
    ) {
      return refused(AssetImportRefusal.Malformed, detail);
    }
    return refused(AssetImportRefusal.ImporterFailed, detail);
  }
}

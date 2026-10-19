/**
 * What the studio's import step does with one asset of a game, decided host-side before anything
 * runs: keep it as it is, normalize it (a glTF the Rust runtime cannot read as delivered, a KTX2
 * texture checked against every destination, a Radiance `.hdr` checked against the renderer's caps,
 * a PNG or JPEG whose usage resolved encoded to KTX2 per texture family beside it), convert it
 * (OBJ, STL and PLY to GLB; Opus and AAC to OGG), refuse it with a typed code, or skip it (a
 * format the studio does not know stays metadata). The format table (`shared/game-assets.ts`) is the one source of what each stack
 * loads; this module only maps its rows to steps. Plan "Game services", M2.7.
 */
import {
  AssetImportRefusal,
  AssetSupport,
  assetExtension,
  assetFormat,
  isAssetImportRefusal,
  stackAcceptsAsset,
  stackAssetSupport,
} from "../../shared/game-assets.ts";
import { GameStack } from "../../shared/game-project.ts";
import type { TextureUsage } from "./basis-encoder.ts";

/** What the import step does with a file. Wire values in the importer's job and receipt: never rename one. */
export const ImportAction = {
  /** The game's stack loads the file as it is: nothing runs. */
  Keep: "keep",
  /** The importer reads the file and writes the form the runtime loads (same format). */
  Normalize: "normalize",
  /** The importer writes the file in another format. */
  Convert: "convert",
  /** The game's stack cannot use the file: a typed refusal, nothing runs. */
  Refuse: "refuse",
  /** A format the studio does not know: it stays metadata, never imported nor refused. */
  Skip: "skip",
} as const;
export type ImportAction = (typeof ImportAction)[keyof typeof ImportAction];

/** The importer step a file runs through. Wire values in the job file: never rename one. */
export const ImportConverter = {
  ObjToGlb: "obj-to-glb",
  StlToGlb: "stl-to-glb",
  PlyToGlb: "ply-to-glb",
  /** Opus and AAC/M4A to Ogg: needs an encoder the store does not carry yet (`converter-missing`). */
  AudioToOgg: "audio-to-ogg",
  /** A glTF whose meshes are Draco- or meshopt-compressed, written back uncompressed. */
  GltfDecompress: "gltf-decompress",
  /**
   * A KTX2 texture, transcoded once per destination's texture format and kept as it is; a square,
   * mipmapped Basis one also gets a fixed-format KTX2 per family beside it (`<stem>.<family>.ktx2`).
   */
  Ktx2Check: "ktx2-check",
  /** A Radiance `.hdr` environment map, its header and size checked against the renderer's caps and kept as it is. */
  HdrCheck: "hdr-check",
  /**
   * A PNG or JPEG texture whose usage resolved (colour, data or normal), encoded to KTX2 per family
   * beside it (`texture-encode.ts`); the image itself is kept as the fallback.
   */
  TextureEncode: "texture-encode",
  /**
   * A GLB's embedded images written out as per-family KTX2 sidecars named in its
   * `asset.extras.genex_textures`. Declared ahead of the step, like `texture-encode`.
   */
  GlbTextures: "glb-textures",
} as const;
export type ImportConverter = (typeof ImportConverter)[keyof typeof ImportConverter];

/** The import step's refusals: one table, in `shared/game-assets.ts` (`assets.inventory` reports them). */
export { AssetImportRefusal, isAssetImportRefusal };

/** One file's step: what runs, and what it writes. */
export interface ImportStep {
  action: ImportAction;
  /** Set for `normalize` and `convert`. */
  converter?: ImportConverter;
  /** The extension the step writes, without its dot (`glb`, `ogg`, `ktx2`). */
  output?: string;
  /** Set for `refuse`. */
  refusal?: AssetImportRefusal;
}

/** A step that runs the importer: its converter and output are set. */
export type ImporterStep = ImportStep & { converter: ImportConverter; output: string };

/** The converter and output extension of each format the Rust import step converts or normalizes. */
const RUST_STEPS: Readonly<Record<string, { converter: ImportConverter; output: string }>> = Object.freeze({
  obj: { converter: ImportConverter.ObjToGlb, output: "glb" },
  stl: { converter: ImportConverter.StlToGlb, output: "glb" },
  ply: { converter: ImportConverter.PlyToGlb, output: "glb" },
  opus: { converter: ImportConverter.AudioToOgg, output: "ogg" },
  m4a: { converter: ImportConverter.AudioToOgg, output: "ogg" },
  aac: { converter: ImportConverter.AudioToOgg, output: "ogg" },
  glb: { converter: ImportConverter.GltfDecompress, output: "glb" },
  gltf: { converter: ImportConverter.GltfDecompress, output: "gltf" },
  ktx2: { converter: ImportConverter.Ktx2Check, output: "ktx2" },
  hdr: { converter: ImportConverter.HdrCheck, output: "hdr" },
});

/**
 * The raster textures the importer decodes and encodes (fast-png, jpeg-js and the Basis encoder's
 * own readers). A WebP has no decoder in the importer, so it ships as its source.
 */
const ENCODED_TEXTURE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg"]);

/**
 * The step a game of `stack` takes for `rel` (a posix path under the game folder). Only a Rust
 * game runs the importer; raylib and Three.js games keep what their stack loads. An MTL is
 * consumed by the OBJ that names it, so on its own it is kept. A PNG or JPEG is encoded only when
 * its `usage` resolved (`texture-usage.ts`); with none it is kept and ships as its source.
 */
export function planImport(stack: GameStack, rel: string, usage?: TextureUsage | null): ImportStep {
  if (!assetFormat(rel)) return { action: ImportAction.Skip };
  const refusal = stackAcceptsAsset(stack, rel);
  if (refusal) return { action: ImportAction.Refuse, refusal };
  if (stack !== GameStack.RustWgpu) return { action: ImportAction.Keep };
  const ext = assetExtension(rel);
  if (ENCODED_TEXTURE_EXTENSIONS.has(ext)) {
    if (!usage) return { action: ImportAction.Keep };
    return { action: ImportAction.Normalize, converter: ImportConverter.TextureEncode, output: ext };
  }
  const step = Object.hasOwn(RUST_STEPS, ext) ? RUST_STEPS[ext] : undefined;
  if (!step) return { action: ImportAction.Keep };
  const converts = stackAssetSupport(stack, rel) === AssetSupport.Converts;
  return { action: converts ? ImportAction.Convert : ImportAction.Normalize, ...step };
}

/** Whether a step runs the importer. */
export function runsImporter(step: ImportStep): step is ImporterStep {
  const runs = step.action === ImportAction.Normalize || step.action === ImportAction.Convert;
  return runs && step.converter !== undefined && step.output !== undefined;
}

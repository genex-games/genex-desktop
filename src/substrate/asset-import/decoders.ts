/**
 * The WebAssembly decoders the importer runs: the Basis Universal transcoder, Draco's glTF decoder,
 * meshoptimizer's decoder, its meshlet clusterizer and its simplifier (import-time LODs), the
 * builds the pinned `three` package ships. Each is loaded from
 * its file with its WebAssembly handed over as bytes, so nothing is fetched. The importer runs
 * them inside its own sandbox (no network, writes only its job folder).
 *
 * Shipping them is copying third-party code: `IMPORT_DECODERS` names each one's upstream and
 * licence, and THIRD-PARTY-NOTICES.md's "Asset importer decoders" table must list every file
 * with both (`assertImportDecodersListed`, held by `third-party-notices.test.ts`).
 * TODO(M3): carry these files in the packaged app and the toolchain store instead of resolving
 * them in `node_modules` (with the importer itself, `rust-assets.ts`; no catalog package owns it
 * yet, so the M2c integration left it open).
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

/** A decoder the importer runs. Wire values in the import receipt: never rename one. */
export const ImportDecoder = {
  Basisu: "basisu",
  Draco: "draco",
  Meshopt: "meshopt",
  MeshoptClusterizer: "meshopt-clusterizer",
  MeshoptSimplifier: "meshopt-simplifier",
} as const;
export type ImportDecoder = (typeof ImportDecoder)[keyof typeof ImportDecoder];

/** Where a decoder's files are, under the `three` package, and what notice it needs. */
export interface DecoderRecord {
  /** Paths under `three/` (its `examples/jsm/*` export). */
  files: readonly string[];
  upstream: string;
  license: string;
}

/** Every decoder the importer copies from `three`, with its upstream and licence (THIRD-PARTY-NOTICES.md). */
export const IMPORT_DECODERS = {
  [ImportDecoder.Basisu]: {
    files: ["examples/jsm/libs/basis/basis_transcoder.js", "examples/jsm/libs/basis/basis_transcoder.wasm"],
    upstream: "https://github.com/BinomialLLC/basis_universal",
    license: "Apache-2.0",
  },
  [ImportDecoder.Draco]: {
    files: ["examples/jsm/libs/draco/gltf/draco_decoder.js", "examples/jsm/libs/draco/gltf/draco_decoder.wasm"],
    upstream: "https://github.com/google/draco",
    license: "Apache-2.0",
  },
  [ImportDecoder.Meshopt]: {
    files: ["examples/jsm/libs/meshopt_decoder.module.js"],
    upstream: "https://github.com/zeux/meshoptimizer",
    license: "MIT",
  },
  [ImportDecoder.MeshoptClusterizer]: {
    files: ["examples/jsm/libs/meshopt_clusterizer.module.js"],
    upstream: "https://github.com/zeux/meshoptimizer",
    license: "MIT",
  },
  [ImportDecoder.MeshoptSimplifier]: {
    files: ["examples/jsm/libs/meshopt_simplifier.module.js"],
    upstream: "https://github.com/zeux/meshoptimizer",
    license: "MIT",
  },
} as const satisfies Record<ImportDecoder, DecoderRecord>;

const require = createRequire(import.meta.url);

/** The absolute path of a decoder file under the `three` package. */
export function decoderFile(file: string): string {
  return require.resolve(`three/${file}`);
}

/** An Emscripten module factory: called with options, resolves to the module. */
type EmscriptenFactory<T> = (options: { wasmBinary: Uint8Array }) => Promise<T>;

/**
 * Evaluate an Emscripten loader (a CommonJS-shaped script inside an ES-module package) and start
 * it with its WebAssembly given as bytes, so it never reads or fetches anything itself.
 */
async function emscripten<T>(js: string, wasm: string): Promise<T> {
  const file = decoderFile(js);
  const source = await readFile(file, "utf8");
  const module: { exports: unknown } = { exports: {} };
  const load = vm.compileFunction(source, ["module", "exports", "require", "__dirname", "__filename"], {
    filename: file,
  });
  load(module, module.exports, createRequire(file), path.dirname(file), file);
  const factory = module.exports as EmscriptenFactory<T>;
  return await factory({ wasmBinary: new Uint8Array(await readFile(decoderFile(wasm))) });
}

/** The parts of Basis Universal's KTX2 reader the importer calls. */
export interface BasisKtx2File {
  isValid(): boolean;
  getWidth(): number;
  getHeight(): number;
  getLevels(): number;
  isETC1S(): boolean;
  isUASTC(): boolean;
  startTranscoding(): boolean;
  getImageTranscodedSizeInBytes(level: number, layer: number, face: number, format: number): number;
  transcodeImage(
    dst: Uint8Array,
    level: number,
    layer: number,
    face: number,
    format: number,
    flags: number,
    channel0: number,
    channel1: number,
  ): number;
  close(): void;
  delete(): void;
}

/** The Basis Universal transcoder module. */
export interface BasisModule {
  initializeBasis(): void;
  KTX2File: new (bytes: Uint8Array) => BasisKtx2File;
}

let basis: Promise<BasisModule> | null = null;

/** The Basis Universal transcoder, started once per process. */
export function basisTranscoder(): Promise<BasisModule> {
  basis ??= (async () => {
    const [js, wasm] = IMPORT_DECODERS[ImportDecoder.Basisu].files;
    const module = await emscripten<BasisModule>(js, wasm);
    module.initializeBasis();
    return module;
  })();
  return basis;
}

/** The parts of Draco's decoder module the importer calls (its embind API, untyped upstream). */
export interface DracoModule {
  Decoder: new () => DracoDecoder;
  Mesh: new () => DracoHandle;
  DracoFloat32Array: new () => DracoHandle;
  DT_FLOAT32: number;
  DT_INT8: number;
  DT_INT16: number;
  DT_INT32: number;
  DT_UINT8: number;
  DT_UINT16: number;
  DT_UINT32: number;
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  destroy(handle: DracoHandle | DracoDecoder): void;
}

/** An object on Draco's heap. */
export interface DracoHandle {
  ptr: number;
  ok?(): boolean;
  num_points?(): number;
  num_faces?(): number;
}

/** Draco's decoder. */
export interface DracoDecoder {
  DecodeArrayToMesh(data: Int8Array, size: number, mesh: DracoHandle): DracoHandle;
  GetAttributeByUniqueId(mesh: DracoHandle, id: number): DracoHandle;
  GetAttributeDataArrayForAllPoints(
    mesh: DracoHandle,
    attribute: DracoHandle,
    dataType: number,
    byteLength: number,
    pointer: number,
  ): boolean;
  GetTrianglesUInt32Array(mesh: DracoHandle, byteLength: number, pointer: number): boolean;
}

let draco: Promise<DracoModule> | null = null;

/** Draco's glTF decoder, started once per process. */
export function dracoDecoder(): Promise<DracoModule> {
  draco ??= (() => {
    const [js, wasm] = IMPORT_DECODERS[ImportDecoder.Draco].files;
    return emscripten<DracoModule>(js, wasm);
  })();
  return draco;
}

/** meshoptimizer's decoder, as its module exports it. */
export interface MeshoptDecoderModule {
  ready: Promise<void>;
  supported: boolean;
  decodeGltfBuffer(
    target: Uint8Array,
    count: number,
    size: number,
    source: Uint8Array,
    mode: string,
    filter: string,
  ): void;
}

/** meshoptimizer's decoder, ready. */
export async function meshoptDecoder(): Promise<MeshoptDecoderModule> {
  const [file] = IMPORT_DECODERS[ImportDecoder.Meshopt].files;
  const { MeshoptDecoder } = (await import(pathToFileURL(decoderFile(file)).href)) as {
    MeshoptDecoder: MeshoptDecoderModule;
  };
  await MeshoptDecoder.ready;
  return MeshoptDecoder;
}

/** meshoptimizer's meshlet output: records of four `u32` (vertex offset, triangle offset in bytes, vertex count, triangle count). */
export interface MeshletBuffers {
  meshlets: Uint32Array;
  /** The input vertex index of every meshlet vertex. */
  vertices: Uint32Array;
  /** Three meshlet-local vertex indices per triangle, one byte each. */
  triangles: Uint8Array;
  meshletCount: number;
}

/** One meshlet's bounding sphere and normal cone, meshoptimizer's `meshopt_Bounds`. */
export interface MeshletBounds {
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
  coneAxisX: number;
  coneAxisY: number;
  coneAxisZ: number;
  coneCutoff: number;
}

/** The parts of meshoptimizer's clusterizer module the importer calls. */
export interface MeshoptClusterizerModule {
  ready: Promise<void>;
  supported: boolean;
  buildMeshlets(
    indices: Uint32Array,
    vertexPositions: Float32Array,
    vertexPositionsStride: number,
    maxVertices: number,
    maxTriangles: number,
    coneWeight: number,
  ): MeshletBuffers;
  computeMeshletBounds(
    buffers: MeshletBuffers,
    vertexPositions: Float32Array,
    vertexPositionsStride: number,
  ): MeshletBounds[];
}

/** meshoptimizer's meshlet clusterizer, ready. */
export async function meshoptClusterizer(): Promise<MeshoptClusterizerModule> {
  const [file] = IMPORT_DECODERS[ImportDecoder.MeshoptClusterizer].files;
  const { MeshoptClusterizer } = (await import(pathToFileURL(decoderFile(file)).href)) as {
    MeshoptClusterizer: MeshoptClusterizerModule;
  };
  await MeshoptClusterizer.ready;
  return MeshoptClusterizer;
}

/** The parts of meshoptimizer's simplifier module the importer calls. */
export interface MeshoptSimplifierModule {
  ready: Promise<void>;
  supported: boolean;
  /** Simplified indices and the result's error relative to the mesh's extent. */
  simplify(
    indices: Uint32Array,
    vertexPositions: Float32Array,
    vertexPositionsStride: number,
    targetIndexCount: number,
    targetError: number,
    flags?: readonly string[],
  ): [Uint32Array, number];
  /** The factor that turns a relative error into an object-space distance. */
  getScale(vertexPositions: Float32Array, vertexPositionsStride: number): number;
}

/** meshoptimizer's simplifier, ready. */
export async function meshoptSimplifier(): Promise<MeshoptSimplifierModule> {
  const [file] = IMPORT_DECODERS[ImportDecoder.MeshoptSimplifier].files;
  const { MeshoptSimplifier } = (await import(pathToFileURL(decoderFile(file)).href)) as {
    MeshoptSimplifier: MeshoptSimplifierModule;
  };
  await MeshoptSimplifier.ready;
  return MeshoptSimplifier;
}

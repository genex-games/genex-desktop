/**
 * The importer's tools: the Basis Universal v2.50 build (its transcoder; the same build encodes,
 * `basis-encoder.ts`), Draco's glTF decoder from npm `draco3dgltf`, meshoptimizer's decoder,
 * meshlet clusterizer and simplifier (import-time LODs) from npm `meshoptimizer`, and the Khronos
 * glTF validator from npm `gltf-validator` (`validate.ts`). They live in one
 * folder, the importer tools folder ({@link importerToolsDir}): the packaged app carries it in its
 * resources (`scripts/toolchains/importer-tools.ts` stages it at build time), and a development
 * checkout reads the npm packages in place and the Basis build where its fetch keeps it. Every
 * file is held to its size and sha256 ({@link IMPORTER_TOOL_FILES}) before anything in it is
 * evaluated, and each WebAssembly module is handed over as bytes, so nothing is fetched or read
 * behind the pins. The importer runs them inside its own sandbox (no network, writes only its job
 * folder).
 *
 * Shipping them is copying third-party code: `IMPORT_DECODERS` names each one's upstream and
 * licence, and THIRD-PARTY-NOTICES.md's "Asset importer decoders" table must list every file
 * with both (`assertImportDecodersListed`, held by `third-party-notices.test.ts`).
 */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { BASIS_ENCODER } from "./basis-encoder.ts";

/** A decoder the importer runs. Wire values in the import receipt: never rename one. */
export const ImportDecoder = {
  Basisu: "basisu",
  Draco: "draco",
  Meshopt: "meshopt",
  MeshoptClusterizer: "meshopt-clusterizer",
  MeshoptSimplifier: "meshopt-simplifier",
  /** Not a decoder: the Khronos glTF validator the import step runs before any decoder (`validate.ts`). */
  GltfValidator: "gltf-validator",
} as const;
export type ImportDecoder = (typeof ImportDecoder)[keyof typeof ImportDecoder];

/** The environment variable that names the importer tools folder (the host sets it for the importer). */
export const IMPORTER_TOOLS_ENV = "GENEX_IMPORTER_TOOLS";
/** The folder the build stages the tools into, under the app's resources (what the host names in {@link IMPORTER_TOOLS_ENV}). */
export const IMPORTER_TOOLS_RESOURCES_FOLDER = "importer-tools";

/** The folder of each tool under the importer tools folder. */
export const ImporterToolFolder = {
  Basis: `basis-encoder-${BASIS_ENCODER.version}`,
  Draco: "draco3dgltf",
  Meshoptimizer: "meshoptimizer",
  GltfValidator: "gltf-validator",
} as const;
export type ImporterToolFolder = (typeof ImporterToolFolder)[keyof typeof ImporterToolFolder];

/** One pinned file of a tool. */
export interface ImporterToolFile {
  sha256: string;
  bytes: number;
}

/** The npm package a tool folder is copied from in a development checkout, at its exact version. */
export const IMPORTER_TOOL_PACKAGES = {
  [ImporterToolFolder.Draco]: { name: "draco3dgltf", version: "1.5.9" },
  [ImporterToolFolder.Meshoptimizer]: { name: "meshoptimizer", version: "1.3.0" },
  [ImporterToolFolder.GltfValidator]: { name: "gltf-validator", version: "2.0.0-dev.3.10" },
} as const;

const basisFile = (index: 0 | 1) => BASIS_ENCODER.files[index];

/**
 * Every file the importer runs, as `<folder>/<file>` under the importer tools folder, with its
 * pin. A package upgrade changes these pins, and the notices row with them.
 */
export const IMPORTER_TOOL_FILES: Readonly<Record<string, ImporterToolFile>> = {
  [`${ImporterToolFolder.Basis}/${basisFile(0).name}`]: { sha256: basisFile(0).sha256, bytes: basisFile(0).bytes },
  [`${ImporterToolFolder.Basis}/${basisFile(1).name}`]: { sha256: basisFile(1).sha256, bytes: basisFile(1).bytes },
  "draco3dgltf/draco_decoder_gltf_nodejs.js": {
    sha256: "9927d2886d34906aec5258d091a162f3d9f59ab7e84fd6a81961987bca3c363f",
    bytes: 54_804,
  },
  "draco3dgltf/draco_decoder_gltf.wasm": {
    sha256: "39b78cec9398af525d76f7eecf336ccf829891cec9524905e55fe686499834bf",
    bytes: 183_697,
  },
  "meshoptimizer/meshopt_decoder.mjs": {
    sha256: "10b313edaa0e322b0c1b46443f6c8b186b42139fe1eca189d50c09511d0ebedc",
    bytes: 29_019,
  },
  "meshoptimizer/meshopt_clusterizer.js": {
    sha256: "ab1841427630c3c7be0fa53cf8f0a5c6b8b284618200be9d7762b807b45cec01",
    bytes: 32_101,
  },
  "meshoptimizer/meshopt_simplifier.js": {
    sha256: "c3098ee4cb4fc242b84f064c88898e76e44bf58b0e1f693507f323c08cdbb5ed",
    bytes: 67_671,
  },
  "gltf-validator/gltf_validator.dart.js": {
    sha256: "b73a7b2d455ac217567725138b46d826a13d7d1bb0c88c15f7c571bfb349298c",
    bytes: 307_792,
  },
  // Apache-2.0 §4(d): the package's NOTICES file ships beside the validator, with its licence.
  "gltf-validator/NOTICES": {
    sha256: "933f161ca1e7b3ead5a6cf93ebb3bf6cb67f0e79b38e08d2046f8cdc41cb78a3",
    bytes: 22_286,
  },
  "gltf-validator/LICENSE": {
    sha256: "3ddf9be5c28fe27dad143a5dc76eea25222ad1dd68934a047064e56ed2fa40c5",
    bytes: 11_560,
  },
};

/** Where a decoder's files are, under the importer tools folder, and what notice it needs. */
export interface DecoderRecord {
  /** Paths under the importer tools folder (`<folder>/<file>`), each a key of {@link IMPORTER_TOOL_FILES}. */
  files: readonly string[];
  upstream: string;
  license: string;
}

/** Every decoder the importer runs, with its upstream and licence (THIRD-PARTY-NOTICES.md). */
export const IMPORT_DECODERS = {
  [ImportDecoder.Basisu]: {
    files: [`${ImporterToolFolder.Basis}/${basisFile(0).name}`, `${ImporterToolFolder.Basis}/${basisFile(1).name}`],
    upstream: BASIS_ENCODER.upstream,
    license: BASIS_ENCODER.license,
  },
  [ImportDecoder.Draco]: {
    files: ["draco3dgltf/draco_decoder_gltf_nodejs.js", "draco3dgltf/draco_decoder_gltf.wasm"],
    upstream: "https://github.com/google/draco",
    license: "Apache-2.0",
  },
  [ImportDecoder.Meshopt]: {
    files: ["meshoptimizer/meshopt_decoder.mjs"],
    upstream: "https://github.com/zeux/meshoptimizer",
    license: "MIT",
  },
  [ImportDecoder.MeshoptClusterizer]: {
    files: ["meshoptimizer/meshopt_clusterizer.js"],
    upstream: "https://github.com/zeux/meshoptimizer",
    license: "MIT",
  },
  [ImportDecoder.MeshoptSimplifier]: {
    files: ["meshoptimizer/meshopt_simplifier.js"],
    upstream: "https://github.com/zeux/meshoptimizer",
    license: "MIT",
  },
  [ImportDecoder.GltfValidator]: {
    files: ["gltf-validator/gltf_validator.dart.js", "gltf-validator/NOTICES", "gltf-validator/LICENSE"],
    upstream: "https://github.com/KhronosGroup/glTF-Validator",
    license: "Apache-2.0",
  },
} as const satisfies Record<ImportDecoder, DecoderRecord>;

/** Why a tool file was refused. Wire values: never rename one. */
export const ImporterToolFault = {
  /** Not there, or not a regular file (a link, a folder, a device). */
  Missing: "missing",
  /** There, but not the pinned bytes. */
  Mismatch: "mismatch",
  /** A path no tool pins. */
  Unpinned: "unpinned",
} as const;
export type ImporterToolFault = (typeof ImporterToolFault)[keyof typeof ImporterToolFault];

/** A tool file the importer will not run, and why. */
export class ImporterToolError extends Error {
  readonly fault: ImporterToolFault;
  readonly file: string;
  constructor(fault: ImporterToolFault, file: string) {
    super(`importer tool ${file}: ${fault}`);
    this.name = "ImporterToolError";
    this.fault = fault;
    this.file = file;
  }
}

/** This checkout's root (decoders.ts is `src/substrate/asset-import/`). */
const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Where a development checkout keeps each tool folder: the npm packages in its `node_modules`, the
 * Basis build where `node scripts/toolchains/importer-tools.ts fetch` puts it.
 */
export function devToolFolder(folder: ImporterToolFolder, repo = REPO): string {
  if (folder === ImporterToolFolder.Basis) return path.join(repo, ".studio-dev", "tools", folder);
  return path.join(repo, "node_modules", IMPORTER_TOOL_PACKAGES[folder].name);
}

/** The importer tools folder the environment names, or null for a development checkout's own. */
export function importerToolsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env[IMPORTER_TOOLS_ENV];
  return dir ? path.resolve(dir) : null;
}

/** The absolute path of a tool file (`<folder>/<file>`), in the named tools folder or this checkout's. */
export function decoderFile(file: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = importerToolsDir(env);
  if (dir) return path.join(dir, file);
  const [folder = "", ...rest] = file.split("/");
  const known = Object.values(ImporterToolFolder).find((value) => value === folder);
  if (!known) throw new ImporterToolError(ImporterToolFault.Unpinned, file);
  return path.join(devToolFolder(known), ...rest);
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A tool file's bytes, held to its pin; throws {@link ImporterToolError} before anything is evaluated. */
export async function pinnedToolFile(file: string): Promise<{ path: string; bytes: Uint8Array }> {
  const pin = IMPORTER_TOOL_FILES[file];
  if (!pin) throw new ImporterToolError(ImporterToolFault.Unpinned, file);
  const at = decoderFile(file);
  const info = await lstat(at).catch(() => null);
  if (!info?.isFile()) throw new ImporterToolError(ImporterToolFault.Missing, file);
  const bytes = new Uint8Array(await readFile(at));
  if (bytes.byteLength !== pin.bytes || sha256(bytes) !== pin.sha256) {
    throw new ImporterToolError(ImporterToolFault.Mismatch, file);
  }
  return { path: at, bytes };
}

/** An Emscripten module factory: called with options, resolves to the module. */
type EmscriptenFactory<T> = (options: { wasmBinary: Uint8Array }) => Promise<T>;

/**
 * Evaluate an Emscripten loader (a CommonJS-shaped script) held to its pin, and start it with its
 * pinned WebAssembly given as bytes, so it never reads or fetches anything itself.
 */
async function emscripten<T>(js: string, wasm: string): Promise<T> {
  const [loader, binary] = await Promise.all([pinnedToolFile(js), pinnedToolFile(wasm)]);
  const module: { exports: unknown } = { exports: {} };
  const load = vm.compileFunction(
    new TextDecoder().decode(loader.bytes),
    ["module", "exports", "require", "__dirname", "__filename"],
    { filename: loader.path },
  );
  load(module, module.exports, createRequire(loader.path), path.dirname(loader.path), loader.path);
  const factory = module.exports as EmscriptenFactory<T>;
  return await factory({ wasmBinary: binary.bytes });
}

/**
 * Evaluate an ES module held to its pin. The verified bytes themselves are imported (as a data
 * URL), so what runs is what was checked; meshoptimizer's modules carry their WebAssembly inline
 * and import nothing.
 */
async function pinnedModule(file: string): Promise<Record<string, unknown>> {
  const { bytes } = await pinnedToolFile(file);
  return (await import(`data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`)) as Record<
    string,
    unknown
  >;
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

/** The Basis Universal module (the v2.50 build, whose transcoder the importer calls). */
export interface BasisModule {
  initializeBasis(): void;
  KTX2File: new (bytes: Uint8Array) => BasisKtx2File;
}

let basis: Promise<BasisModule> | null = null;

/** The Basis Universal v2.50 transcoder (the pinned build the encoder is), started once per process. */
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

/** A meshoptimizer module (a `ready` promise its export resolves). */
interface MeshoptModule {
  ready: Promise<void>;
}

/** meshoptimizer's module for `decoder`, its pinned file evaluated and its export ready. */
async function meshoptModule<T extends MeshoptModule>(decoder: ImportDecoder, exported: string): Promise<T> {
  const [file] = IMPORT_DECODERS[decoder].files;
  const loaded = (await pinnedModule(file))[exported] as T | undefined;
  if (!loaded) throw new ImporterToolError(ImporterToolFault.Mismatch, file);
  await loaded.ready;
  return loaded;
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

let meshopt: Promise<MeshoptDecoderModule> | null = null;

/** meshoptimizer's decoder, started once per process. */
export function meshoptDecoder(): Promise<MeshoptDecoderModule> {
  meshopt ??= meshoptModule<MeshoptDecoderModule>(ImportDecoder.Meshopt, "MeshoptDecoder");
  return meshopt;
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

let clusterizer: Promise<MeshoptClusterizerModule> | null = null;

/** meshoptimizer's meshlet clusterizer, started once per process. */
export function meshoptClusterizer(): Promise<MeshoptClusterizerModule> {
  clusterizer ??= meshoptModule<MeshoptClusterizerModule>(ImportDecoder.MeshoptClusterizer, "MeshoptClusterizer");
  return clusterizer;
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

let simplifier: Promise<MeshoptSimplifierModule> | null = null;

/** meshoptimizer's simplifier, started once per process. */
export function meshoptSimplifier(): Promise<MeshoptSimplifierModule> {
  simplifier ??= meshoptModule<MeshoptSimplifierModule>(ImportDecoder.MeshoptSimplifier, "MeshoptSimplifier");
  return simplifier;
}

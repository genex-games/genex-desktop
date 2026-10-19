/**
 * The import step's glTF gate: every glTF a Rust game delivers is validated before any decoder
 * (Draco, meshopt, dequantize) or the runtime's `gltf` crate reads it, because that crate panics
 * on invalid input (gltf #478) and a panic aborts a wasm game. The gate runs the Khronos glTF
 * validator (npm `gltf-validator`, pinned in `decoders.ts`); an error refuses the file
 * `validation-failed` with its first codes in the detail, a warning is returned to the step, and
 * information and hints are dropped. Severity is decided by the issue's code and the validator's
 * numeric severity, never by its message text.
 *
 * The validator is a pre-release compiled from Dart. If it stops working, the gate switches to its
 * fallback ({@link GltfValidatorEngine.Accessors}): this module's own reference, buffer, accessor
 * and index checks, which refuse the same hostile table with the same codes.
 *
 * Nothing here reads a file or the network: the job carries the one file, so an external buffer or
 * image named by URI is not checked here (a warning), and the validator is evaluated with a
 * `require` that answers only `url`.
 */
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { IMPORT_DECODERS, ImportDecoder, pinnedToolFile } from "./decoders.ts";
import { GltfComponent, readGlb } from "./glb.ts";
import { GltfImportError, index, isObject, type Json, objects } from "./gltf-json.ts";
import { AssetImportRefusal } from "./import-plan.ts";

/** An issue's severity: the validator report's own numbers. Wire values: never renumber one. */
export const GltfIssueSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
} as const;
export type GltfIssueSeverity = (typeof GltfIssueSeverity)[keyof typeof GltfIssueSeverity];

/** Which checker the gate runs. */
export const GltfValidatorEngine = {
  /** The Khronos glTF validator (npm `gltf-validator`). */
  Khronos: "khronos",
  /** This module's own checks: references, buffer views, accessors and index ranges. */
  Accessors: "accessors",
} as const;
export type GltfValidatorEngine = (typeof GltfValidatorEngine)[keyof typeof GltfValidatorEngine];

/** The engine the gate runs. Switch it to `Accessors` if the Khronos package stops working. */
export const GLTF_VALIDATOR_ENGINE: GltfValidatorEngine = GltfValidatorEngine.Khronos;

/** The most issues one report keeps: a hostile file can name millions. */
const MAX_ISSUES = 256;
/** The most error codes a refusal names (its detail is a log line). */
const REFUSAL_CODES = 8;

/** The issue codes this module produces itself or treats specially: the validator's own spelling. */
export const GltfIssueCode = {
  UnresolvedReference: "UNRESOLVED_REFERENCE",
  BufferViewTooLong: "BUFFER_VIEW_TOO_LONG",
  BufferByteLengthMismatch: "BUFFER_BYTE_LENGTH_MISMATCH",
  AccessorTooLong: "ACCESSOR_TOO_LONG",
  AccessorIndexOob: "ACCESSOR_INDEX_OOB",
  AccessorSparseIndexOob: "ACCESSOR_SPARSE_INDEX_OOB",
  UnequalAccessorCount: "MESH_PRIMITIVE_UNEQUAL_ACCESSOR_COUNT",
  ValueNotInList: "VALUE_NOT_IN_LIST",
  InvalidJson: "INVALID_JSON",
  GlbUnexpectedEnd: "GLB_UNEXPECTED_END_OF_CHUNK_DATA",
  IoError: "IO_ERROR",
} as const;
export type GltfIssueCode = (typeof GltfIssueCode)[keyof typeof GltfIssueCode];

/**
 * Codes whose severity the gate sets itself, whatever the report says. Matched by code only.
 */
export const GLTF_SEVERITY_OVERRIDES: Readonly<Record<string, GltfIssueSeverity>> = Object.freeze({
  // Tolerance checks on unit vectors, skin weights, rotations and tangent signs: exporters often miss
  // the validator's epsilon. They are precision findings, not reference or memory faults: a warning.
  ACCESSOR_VECTOR3_NON_UNIT: GltfIssueSeverity.Warning,
  ACCESSOR_WEIGHTS_NON_NORMALIZED: GltfIssueSeverity.Warning,
  ACCESSOR_ANIMATION_SAMPLER_OUTPUT_NON_NORMALIZED_QUATERNION: GltfIssueSeverity.Warning,
  ROTATION_NON_UNIT: GltfIssueSeverity.Warning,
  ACCESSOR_INVALID_SIGN: GltfIssueSeverity.Warning,
  // The job carries one file: an external buffer or image is not in it, so it is not checked here.
  [GltfIssueCode.IoError]: GltfIssueSeverity.Warning,
});

/** One finding about a glTF file. */
export interface GltfIssue {
  code: string;
  severity: GltfIssueSeverity;
  /** A JSON pointer into the document, when the finding has one. */
  pointer?: string;
}

/** The part of a Khronos validation report the gate reads. */
export interface GltfValidationReport {
  issues: {
    numErrors: number;
    messages: ReadonlyArray<{ code: string; severity: number; pointer?: string; message?: string }>;
  };
}

/** The severity the gate gives `code`, reported as `severity`. */
function gateSeverity(code: string, severity: number): GltfIssueSeverity | null {
  if (Object.hasOwn(GLTF_SEVERITY_OVERRIDES, code)) return GLTF_SEVERITY_OVERRIDES[code] ?? null;
  const known = Object.values(GltfIssueSeverity).find((value) => value === severity);
  return known ?? null;
}

/**
 * A report's findings sorted into what refuses the file and what the step keeps as warnings, by
 * code and numeric severity (an unknown severity counts as an error). Messages are never read.
 */
export function gateIssues(report: GltfValidationReport): { errors: GltfIssue[]; warnings: GltfIssue[] } {
  const errors: GltfIssue[] = [];
  const warnings: GltfIssue[] = [];
  for (const message of report.issues.messages) {
    const severity = gateSeverity(message.code, message.severity) ?? GltfIssueSeverity.Error;
    const issue: GltfIssue = { code: message.code, severity, ...(message.pointer ? { pointer: message.pointer } : {}) };
    if (severity === GltfIssueSeverity.Error) errors.push(issue);
    else if (severity === GltfIssueSeverity.Warning) warnings.push(issue);
  }
  return { errors, warnings };
}

/** The refusal for a file with `errors`: its first distinct codes in the detail. */
function refusal(errors: readonly GltfIssue[], counted: number): GltfImportError {
  const codes = [...new Set(errors.map((issue) => issue.code))].slice(0, REFUSAL_CODES);
  const detail = codes.length ? codes.join(", ") : `${counted} validation errors`;
  return new GltfImportError(AssetImportRefusal.ValidationFailed, detail);
}

/** The Khronos validator's API (`index.js` of npm `gltf-validator`). */
interface KhronosValidator {
  validateBytes(data: Uint8Array, options: Record<string, unknown>): Promise<GltfValidationReport>;
  version(): string;
}

/** The one module the validator's Dart runtime asks for: `url`; anything else is refused. */
function onlyUrl(at: string): (name: string) => unknown {
  const real = createRequire(at);
  return (name) => {
    if (name === "url") return real("node:url");
    throw new Error(`the glTF validator may not load ${name}`);
  };
}

let khronos: Promise<KhronosValidator> | null = null;

/**
 * The Khronos validator, its pinned script evaluated once per process. Its Dart runtime also adds
 * call helpers (`$1`, `$2`, …) to `Function.prototype`, which is why it runs only in the importer.
 */
export function khronosValidator(): Promise<KhronosValidator> {
  khronos ??= (async () => {
    const [file] = IMPORT_DECODERS[ImportDecoder.GltfValidator].files;
    const { path: at, bytes } = await pinnedToolFile(file);
    const module: { exports: unknown } = { exports: {} };
    const load = vm.compileFunction(
      new TextDecoder().decode(bytes),
      ["module", "exports", "require", "__dirname", "__filename"],
      { filename: at },
    );
    load(module, module.exports, onlyUrl(at), path.dirname(at), at);
    return module.exports as KhronosValidator;
  })();
  return khronos;
}

/** The Khronos report for `bytes`: no timestamp, no external resources, the gate's overrides applied. */
async function khronosReport(bytes: Uint8Array, ext: string): Promise<GltfValidationReport> {
  const validator = await khronosValidator();
  return await validator.validateBytes(bytes, {
    format: ext === "glb" ? "glb" : "gltf",
    writeTimestamp: false,
    maxIssues: MAX_ISSUES,
    severityOverrides: GLTF_SEVERITY_OVERRIDES,
  });
}

/**
 * Validate a glTF file (`ext` `glb` or `gltf`) before anything decodes it. Returns its warnings;
 * throws {@link GltfImportError} `validation-failed` when it has an error.
 */
export async function validateGltf(
  bytes: Uint8Array,
  ext: string,
  engine: GltfValidatorEngine = GLTF_VALIDATOR_ENGINE,
): Promise<GltfIssue[]> {
  const report = engine === GltfValidatorEngine.Khronos ? await khronosReport(bytes, ext) : accessorReport(bytes, ext);
  const { errors, warnings } = gateIssues(report);
  if (errors.length || report.issues.numErrors > 0) throw refusal(errors, report.issues.numErrors);
  return warnings;
}

// The fallback engine: the checks that keep the runtime's `gltf` crate and the decoders in bounds.

const COMPONENT_BYTES: Readonly<Record<number, number>> = {
  [GltfComponent.Byte]: 1,
  [GltfComponent.UnsignedByte]: 1,
  [GltfComponent.Short]: 2,
  [GltfComponent.UnsignedShort]: 2,
  [GltfComponent.UnsignedInt]: 4,
  [GltfComponent.Float]: 4,
};
const TYPE_WIDTH: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};
const BASE64_DATA_URI = /^data:[^,]*;base64,/;

/** The fallback's findings so far, capped at {@link MAX_ISSUES}. */
class Findings {
  readonly messages: Array<{ code: string; severity: number; pointer?: string }> = [];
  numErrors = 0;
  add(code: GltfIssueCode, pointer: string, severity: GltfIssueSeverity = GltfIssueSeverity.Error): void {
    if (severity === GltfIssueSeverity.Error) this.numErrors++;
    if (this.messages.length < MAX_ISSUES) this.messages.push({ code, severity, pointer });
  }
  report(): GltfValidationReport {
    return { issues: { numErrors: this.numErrors, messages: this.messages } };
  }
}

/** The document and its binary chunk, or the finding that it is neither GLB nor glTF JSON. */
function parseDocument(bytes: Uint8Array, ext: string, findings: Findings): { json: Json; bin: Uint8Array } | null {
  try {
    if (ext === "glb") return readGlb(bytes) as { json: Json; bin: Uint8Array };
    const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (isObject(json)) return { json, bin: new Uint8Array(0) };
  } catch {
    // Reported below.
  }
  findings.add(ext === "glb" ? GltfIssueCode.GlbUnexpectedEnd : GltfIssueCode.InvalidJson, "");
  return null;
}

/** Each buffer's bytes where this file holds them; null for an external or meshopt-fallback buffer. */
function bufferBytes(json: Json, bin: Uint8Array, ext: string): Array<Uint8Array | null> {
  return objects(json.buffers).map((buffer, at) => {
    if (typeof buffer.uri === "string" && BASE64_DATA_URI.test(buffer.uri)) {
      return new Uint8Array(Buffer.from(buffer.uri.replace(BASE64_DATA_URI, ""), "base64"));
    }
    const glbChunk = ext === "glb" && at === 0 && buffer.uri === undefined;
    return glbChunk ? bin : null;
  });
}

/** One reference site: the collection it names and where it is. */
type Reference = [value: unknown, target: string, pointer: string];

/** The texture references of a material. */
function materialReferences(material: Json, at: number): Reference[] {
  const pbr = isObject(material.pbrMetallicRoughness) ? material.pbrMetallicRoughness : {};
  const infos: Array<[Json, string]> = [
    [pbr, "baseColorTexture"],
    [pbr, "metallicRoughnessTexture"],
    [material, "normalTexture"],
    [material, "occlusionTexture"],
    [material, "emissiveTexture"],
  ];
  return infos.flatMap(([owner, key]) => {
    const info = owner[key];
    return isObject(info) ? [[info.index, "textures", `/materials/${at}/${key}/index`] as Reference] : [];
  });
}

/** The references of each mesh primitive: attributes, indices, material and morph targets. */
function meshReferences(json: Json): Reference[] {
  return objects(json.meshes).flatMap((mesh, m) =>
    objects(mesh.primitives).flatMap((primitive, p) => {
      const at = `/meshes/${m}/primitives/${p}`;
      const attributes = isObject(primitive.attributes) ? Object.entries(primitive.attributes) : [];
      const targets = objects(primitive.targets).flatMap((target, t) =>
        Object.entries(target).map(([name, value]): Reference => [value, "accessors", `${at}/targets/${t}/${name}`]),
      );
      return [
        ...attributes.map(([name, value]): Reference => [value, "accessors", `${at}/attributes/${name}`]),
        ...(primitive.indices === undefined ? [] : [[primitive.indices, "accessors", `${at}/indices`] as Reference]),
        ...(primitive.material === undefined ? [] : [[primitive.material, "materials", `${at}/material`] as Reference]),
        ...targets,
      ];
    }),
  );
}

/** A reference to `target` at `pointer` when `value` is set. */
const optional = (value: unknown, target: string, pointer: string): Reference[] =>
  value === undefined ? [] : [[value, target, pointer]];

/** The references of the scene graph: scenes, nodes and skins. */
function graphReferences(json: Json): Reference[] {
  return [
    ...optional(json.scene, "scenes", "/scene"),
    ...objects(json.scenes).flatMap((scene, s) =>
      (Array.isArray(scene.nodes) ? scene.nodes : []).map(
        (node, n): Reference => [node, "nodes", `/scenes/${s}/nodes/${n}`],
      ),
    ),
    ...objects(json.nodes).flatMap((node, n) => [
      ...optional(node.mesh, "meshes", `/nodes/${n}/mesh`),
      ...optional(node.skin, "skins", `/nodes/${n}/skin`),
      ...optional(node.camera, "cameras", `/nodes/${n}/camera`),
      ...(Array.isArray(node.children) ? node.children : []).map(
        (child, c): Reference => [child, "nodes", `/nodes/${n}/children/${c}`],
      ),
    ]),
    ...objects(json.skins).flatMap((skin, s) => [
      ...optional(skin.inverseBindMatrices, "accessors", `/skins/${s}/inverseBindMatrices`),
      ...optional(skin.skeleton, "nodes", `/skins/${s}/skeleton`),
      ...(Array.isArray(skin.joints) ? skin.joints : []).map(
        (joint, j): Reference => [joint, "nodes", `/skins/${s}/joints/${j}`],
      ),
    ]),
  ];
}

/** The references of animations, textures, images, accessors and buffer views. */
function dataReferences(json: Json): Reference[] {
  return [
    ...objects(json.animations).flatMap((animation, a) => {
      const samplers = objects(animation.samplers);
      return [
        ...samplers.flatMap((sampler, s) => [
          [sampler.input, "accessors", `/animations/${a}/samplers/${s}/input`] as Reference,
          [sampler.output, "accessors", `/animations/${a}/samplers/${s}/output`] as Reference,
        ]),
        ...objects(animation.channels).flatMap((channel, c) => {
          const target = isObject(channel.target) ? channel.target : {};
          return [
            [channel.sampler, `animations/${a}/samplers`, `/animations/${a}/channels/${c}/sampler`] as Reference,
            ...optional(target.node, "nodes", `/animations/${a}/channels/${c}/target/node`),
          ];
        }),
      ];
    }),
    ...objects(json.textures).flatMap((texture, t) => [
      ...optional(texture.source, "images", `/textures/${t}/source`),
      ...optional(texture.sampler, "samplers", `/textures/${t}/sampler`),
    ]),
    ...objects(json.images).flatMap((image, i) => optional(image.bufferView, "bufferViews", `/images/${i}/bufferView`)),
    ...objects(json.accessors).flatMap((accessor, a) => {
      const sparse = isObject(accessor.sparse) ? accessor.sparse : {};
      const part = (key: string) => (isObject(sparse[key]) ? (sparse[key] as Json) : {});
      return [
        ...optional(accessor.bufferView, "bufferViews", `/accessors/${a}/bufferView`),
        ...optional(part("indices").bufferView, "bufferViews", `/accessors/${a}/sparse/indices/bufferView`),
        ...optional(part("values").bufferView, "bufferViews", `/accessors/${a}/sparse/values/bufferView`),
      ];
    }),
    ...objects(json.bufferViews).map((view, v): Reference => [view.buffer, "buffers", `/bufferViews/${v}/buffer`]),
  ];
}

/** How many items the collection `target` (a top-level name, or `animations/<a>/samplers`) has. */
function collectionSize(json: Json, target: string): number {
  const [top = "", at, nested] = target.split("/");
  const items = json[top];
  if (!Array.isArray(items)) return 0;
  if (at === undefined || nested === undefined) return items.length;
  const owner = items[Number(at)];
  return isObject(owner) && Array.isArray(owner[nested]) ? owner[nested].length : 0;
}

/** Every reference must name an item that exists. */
function checkReferences(json: Json, findings: Findings): void {
  const references = [
    ...meshReferences(json),
    ...objects(json.materials).flatMap(materialReferences),
    ...graphReferences(json),
    ...dataReferences(json),
  ];
  for (const [value, target, pointer] of references) {
    const at = index(value);
    if (at === null || at >= collectionSize(json, target)) findings.add(GltfIssueCode.UnresolvedReference, pointer);
  }
}

/** Each view's bytes when its buffer is here and it fits; null when it cannot be read. */
function checkViews(json: Json, buffers: Array<Uint8Array | null>, findings: Findings): Array<Uint8Array | null> {
  for (const [at, buffer] of objects(json.buffers).entries()) {
    const data = buffers[at];
    const length = index(buffer.byteLength);
    const shortOfItsLength = data !== null && data !== undefined && (length === null || length > data.byteLength);
    if (shortOfItsLength) findings.add(GltfIssueCode.BufferByteLengthMismatch, `/buffers/${at}/byteLength`);
  }
  return objects(json.bufferViews).map((view, at) => {
    const data = buffers[index(view.buffer) ?? -1];
    const start = view.byteOffset === undefined ? 0 : index(view.byteOffset);
    const size = index(view.byteLength);
    if (!data) return null;
    if (start === null || size === null || start + size > data.byteLength) {
      findings.add(GltfIssueCode.BufferViewTooLong, `/bufferViews/${at}`);
      return null;
    }
    return data.subarray(start, start + size);
  });
}

/** An accessor's element size and stride in bytes, or null for a type glTF does not have. */
function layout(accessor: Json, view: Json | undefined): { size: number; stride: number } | null {
  const component = typeof accessor.componentType === "number" ? COMPONENT_BYTES[accessor.componentType] : undefined;
  const width = typeof accessor.type === "string" ? TYPE_WIDTH[accessor.type] : undefined;
  if (!component || !width) return null;
  const size = component * width;
  const stride = view ? index(view.byteStride) : null;
  return { size, stride: stride || size };
}

/** The code an accessor breaks, or null: a known type and a count, inside its view when it is here. */
function accessorFault(accessor: Json, viewJson: Json[], views: Array<Uint8Array | null>): GltfIssueCode | null {
  const viewAt = index(accessor.bufferView);
  const shape = layout(accessor, viewAt === null ? undefined : viewJson[viewAt]);
  const count = index(accessor.count);
  if (!shape || !count) return GltfIssueCode.ValueNotInList;
  const data = viewAt === null ? null : views[viewAt];
  if (!data) return null;
  const offset = accessor.byteOffset === undefined ? 0 : index(accessor.byteOffset);
  const end = offset === null ? Number.POSITIVE_INFINITY : offset + shape.stride * (count - 1) + shape.size;
  return end > data.byteLength ? GltfIssueCode.AccessorTooLong : null;
}

/** Every accessor must have a known type and lie inside its view. */
function checkAccessors(json: Json, views: Array<Uint8Array | null>, findings: Findings): void {
  const viewJson = objects(json.bufferViews);
  for (const [at, accessor] of objects(json.accessors).entries()) {
    const fault = accessorFault(accessor, viewJson, views);
    if (fault) findings.add(fault, `/accessors/${at}`);
  }
}

/** How an index of each byte size is read. */
const INDEX_READERS: Readonly<Record<number, (data: DataView, at: number) => number>> = {
  1: (data, at) => data.getUint8(at),
  2: (data, at) => data.getUint16(at, true),
  4: (data, at) => data.getUint32(at, true),
};

/** The largest value of an index accessor, or null when it cannot be read here. */
function largestIndex(accessor: Json, views: Array<Uint8Array | null>): number | null {
  const data = views[index(accessor.bufferView) ?? -1];
  const count = index(accessor.count);
  const offset = accessor.byteOffset === undefined ? 0 : index(accessor.byteOffset);
  const size = typeof accessor.componentType === "number" ? COMPONENT_BYTES[accessor.componentType] : undefined;
  const value = size ? INDEX_READERS[size] : undefined;
  if (!data || count === null || offset === null || !size || !value) return null;
  if (offset + count * size > data.byteLength) return null;
  const read = new DataView(data.buffer, data.byteOffset + offset, count * size);
  let largest = 0;
  for (let i = 0; i < count; i++) largest = Math.max(largest, value(read, i * size));
  return largest;
}

/** One primitive's attributes must agree on a vertex count, and its indices must stay below it. */
function checkPrimitive(
  primitive: Json,
  at: string,
  context: { accessors: Json[]; views: Array<Uint8Array | null>; findings: Findings },
): void {
  const { accessors, views, findings } = context;
  const attributes = isObject(primitive.attributes) ? Object.values(primitive.attributes) : [];
  const counts = new Set(attributes.map((value) => index(accessors[index(value) ?? -1]?.count)));
  if (counts.size > 1) findings.add(GltfIssueCode.UnequalAccessorCount, `${at}/attributes`);
  const [vertices] = [...counts];
  const indices = accessors[index(primitive.indices) ?? -1];
  const largest = indices && !indices.sparse ? largestIndex(indices, views) : null;
  const pastLastVertex = largest !== null && typeof vertices === "number" && largest >= vertices;
  if (pastLastVertex) findings.add(GltfIssueCode.AccessorIndexOob, `${at}/indices`);
}

/** Every mesh primitive checked ({@link checkPrimitive}). */
function checkPrimitives(json: Json, views: Array<Uint8Array | null>, findings: Findings): void {
  const context = { accessors: objects(json.accessors), views, findings };
  for (const [m, mesh] of objects(json.meshes).entries()) {
    for (const [p, primitive] of objects(mesh.primitives).entries())
      checkPrimitive(primitive, `/meshes/${m}/primitives/${p}`, context);
  }
}

/** External buffers and images the job does not carry: noted, not checked. */
function noteExternal(json: Json, findings: Findings): void {
  for (const [key, items] of [
    ["buffers", objects(json.buffers)],
    ["images", objects(json.images)],
  ] as const) {
    for (const [at, item] of items.entries()) {
      const external = typeof item.uri === "string" && !item.uri.startsWith("data:");
      if (external) findings.add(GltfIssueCode.IoError, `/${key}/${at}/uri`, GltfIssueSeverity.Warning);
    }
  }
}

/** The fallback engine's report: the same shape as the Khronos validator's. */
export function accessorReport(bytes: Uint8Array, ext: string): GltfValidationReport {
  const findings = new Findings();
  const document = parseDocument(bytes, ext, findings);
  if (!document) return findings.report();
  const { json, bin } = document;
  checkReferences(json, findings);
  const views = checkViews(json, bufferBytes(json, bin, ext), findings);
  checkAccessors(json, views, findings);
  checkPrimitives(json, views, findings);
  noteExternal(json, findings);
  return findings.report();
}

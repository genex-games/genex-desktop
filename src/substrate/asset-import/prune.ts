/**
 * The import step's clean-up over a GLB's raw JSON (C-7): duplicate accessors and materials merged
 * (`dedup`), everything nothing references dropped (`prune`), and the binary chunk written back
 * with one tightly packed view per accessor (`pack`). `weld.ts` runs these after welding; the
 * shared reads here (an accessor's elements as dense bytes, every place an accessor is named) are
 * what both need.
 *
 * Ported from glTF-Transform 4.4.2 (MIT, © 2024 Don McCurdy, THIRD-PARTY-NOTICES.md "Asset
 * importer ports"): `packages/functions/src/dedup.ts` (`dedupAccessors`: accessors grouped as
 * vertex attributes, indices, animation inputs and outputs, merged when count, type, component
 * type and normalization match and the bytes are equal; `dedupMaterials`: materials equal but for
 * their name merged into the first) and `packages/functions/src/prune.ts` (unreferenced accessors
 * and materials removed). Unlike upstream, prune keeps unused vertex attributes, nodes, meshes,
 * textures and animations: a game names them, and the runtime reads what is there.
 */
import { ARRAY_BUFFER, BinWriter, ELEMENT_ARRAY_BUFFER, GltfComponent, type GltfJson, writeGlb } from "./glb.ts";
import { index, isObject, type Json, objects } from "./gltf-json.ts";

/** Bytes per component of each glTF component type. */
const COMPONENT_BYTES: Readonly<Record<number, number>> = {
  [GltfComponent.Byte]: 1,
  [GltfComponent.UnsignedByte]: 1,
  [GltfComponent.Short]: 2,
  [GltfComponent.UnsignedShort]: 2,
  [GltfComponent.UnsignedInt]: 4,
  [GltfComponent.Float]: 4,
};
/** Components per element of each accessor type. */
const TYPE_WIDTH: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};
const MATRIX = /^MAT/;
const VERTEX_ALIGN = 4;
const INSTANCING = "EXT_mesh_gpu_instancing";

/** Why the clean-up left a GLB as it was. Wire values in the import outcome: never rename one. */
export const WeldSkip = {
  /** Not a GLB the step can read: damaged, or its JSON has no glTF shape the step relies on. */
  UnreadableGeometry: "unreadable-geometry",
  /** Data outside the binary chunk (a `uri` buffer, a second buffer). */
  ExternalBuffer: "external-buffer",
  /** An extension that names accessors, views or materials by index in a way the step does not remap. */
  UnsafeExtension: "unsafe-extension",
  /** A sparse accessor: its views are not rewritten. */
  SparseAccessor: "sparse-accessor",
  /** Import extras (`genex_lods`, `genex_meshlets`) that name views by index. */
  ImportExtras: "import-extras",
  /** Every vertex is already unique and nothing is duplicated or unreferenced. */
  NothingToWeld: "nothing-to-weld",
} as const;
export type WeldSkip = (typeof WeldSkip)[keyof typeof WeldSkip];

/** Thrown inside the step to leave the GLB as it was, with the reason. */
export class WeldSkipped extends Error {
  readonly reason: WeldSkip;
  constructor(reason: WeldSkip, message: string) {
    super(message);
    this.name = "WeldSkipped";
    this.reason = reason;
  }
}

const unreadable = (message: string) => new WeldSkipped(WeldSkip.UnreadableGeometry, message);

/**
 * A GLB being cleaned up: its JSON (changed in place) and, per accessor index, the dense bytes of
 * its elements: read from the binary chunk on first use, or set by a step that wrote new data.
 */
export interface PackDoc {
  json: Json;
  bin: Uint8Array;
  data: Map<number, Uint8Array>;
}

/** How one accessor's elements are laid out: bytes per component, components, bytes per element. */
export interface ElementLayout {
  componentBytes: number;
  width: number;
  elementBytes: number;
}

/** An accessor's element layout; throws {@link WeldSkipped} for one without a glTF shape. */
export function elementLayout(accessor: Json): ElementLayout {
  const componentBytes = COMPONENT_BYTES[accessor.componentType as number];
  const width = TYPE_WIDTH[String(accessor.type)];
  if (!componentBytes || !width) throw unreadable("an accessor without a glTF layout");
  // Small-component matrices pad each column (glTF §3.6.2.4); only 4-byte ones are dense.
  if (MATRIX.test(String(accessor.type)) && componentBytes !== 4) throw unreadable("a padded matrix accessor");
  return { componentBytes, width, elementBytes: componentBytes * width };
}

/** The accessor at `at`; throws {@link WeldSkipped} when there is none. */
export function accessorAt(doc: PackDoc, at: number): Json {
  const accessor = objects(doc.json.accessors)[at];
  if (!accessor) throw unreadable(`accessor ${at} does not exist`);
  return accessor;
}

/** The element count of the accessor at `at`. */
export function accessorCount(doc: PackDoc, at: number): number {
  const count = index(accessorAt(doc, at).count);
  if (count === null) throw unreadable(`accessor ${at} has no count`);
  return count;
}

/** The dense bytes of accessor `at`'s elements, stride removed; zeros for one without a view. */
export function accessorData(doc: PackDoc, at: number): Uint8Array {
  const cached = doc.data.get(at);
  if (cached) return cached;
  const accessor = accessorAt(doc, at);
  if (accessor.sparse !== undefined) throw new WeldSkipped(WeldSkip.SparseAccessor, `accessor ${at} is sparse`);
  const { elementBytes } = elementLayout(accessor);
  const count = accessorCount(doc, at);
  const out = new Uint8Array(count * elementBytes);
  const viewAt = index(accessor.bufferView);
  // An accessor without a view reads as zeros and stays without one: only data a step set is packed.
  if (viewAt === null) return out;
  copyElements(doc, accessor, viewAt, out, elementBytes);
  doc.data.set(at, out);
  return out;
}

/** Copy `out.length / elementBytes` elements of `accessor` out of its view, checked to lie inside it. */
function copyElements(doc: PackDoc, accessor: Json, viewAt: number, out: Uint8Array, elementBytes: number): void {
  const view = objects(doc.json.bufferViews)[viewAt];
  if (!view || index(view.buffer) !== 0) throw unreadable(`view ${viewAt} is not in the binary chunk`);
  const count = out.length / elementBytes;
  const stride = index(view.byteStride) || elementBytes;
  const viewStart = index(view.byteOffset) ?? 0;
  const start = viewStart + (index(accessor.byteOffset) ?? 0);
  const viewEnd = viewStart + (index(view.byteLength) ?? 0);
  const end = count ? start + stride * (count - 1) + elementBytes : start;
  if (end > viewEnd || viewEnd > doc.bin.byteLength) throw unreadable(`an accessor lies past view ${viewAt}`);
  for (let i = 0; i < count; i++) {
    const from = start + i * stride;
    out.set(doc.bin.subarray(from, from + elementBytes), i * elementBytes);
  }
}

/** Every mesh primitive, in document order. */
export const primitivesOf = (json: Json): Json[] => objects(json.meshes).flatMap((mesh) => objects(mesh.primitives));

/** A primitive's attribute maps: its own, then each morph target's. */
export function attributeMaps(primitive: Json): Json[] {
  const own = isObject(primitive.attributes) ? [primitive.attributes] : [];
  return [...own, ...objects(primitive.targets)];
}

/** What an accessor is used as, which decides its view's target when packed. */
const AccessorUse = { Vertex: "vertex", Index: "index", Other: "other" } as const;
type AccessorUse = (typeof AccessorUse)[keyof typeof AccessorUse];

/** One place a document names an accessor: its owner object, the key, and what it is used as. */
interface AccessorSlot {
  owner: Json;
  key: string;
  use: AccessorUse;
}

const slot = (owner: Json, key: string, use: AccessorUse): AccessorSlot => ({ owner, key, use });

/** The accessors mesh primitives name: attributes and morph targets (vertex data), then indices. */
const meshSlots = (json: Json): AccessorSlot[] =>
  primitivesOf(json).flatMap((primitive) => [
    ...attributeMaps(primitive).flatMap((map) => Object.keys(map).map((key) => slot(map, key, AccessorUse.Vertex))),
    ...(primitive.indices === undefined ? [] : [slot(primitive, "indices", AccessorUse.Index)]),
  ]);

/** The accessors skins, animation samplers and instanced nodes name. */
function otherSlots(json: Json): AccessorSlot[] {
  const skins = objects(json.skins).flatMap((skin) =>
    skin.inverseBindMatrices === undefined ? [] : [slot(skin, "inverseBindMatrices", AccessorUse.Other)],
  );
  const samplers = objects(json.animations)
    .flatMap((animation) => objects(animation.samplers))
    .flatMap((sampler) => [slot(sampler, "input", AccessorUse.Other), slot(sampler, "output", AccessorUse.Other)]);
  const instanced = objects(json.nodes).flatMap((node) => {
    const instancing = isObject(node.extensions) ? node.extensions[INSTANCING] : undefined;
    const attributes = isObject(instancing) && isObject(instancing.attributes) ? instancing.attributes : {};
    return Object.keys(attributes).map((key) => slot(attributes, key, AccessorUse.Other));
  });
  return [...skins, ...samplers, ...instanced];
}

/** Every place the document names an accessor, in document order. */
const accessorSlots = (json: Json): AccessorSlot[] => [...meshSlots(json), ...otherSlots(json)];

/** The accessor a slot names; throws {@link WeldSkipped} for a reference to nothing. */
function slotAccessor(json: Json, slot: AccessorSlot): number {
  const at = index(slot.owner[slot.key]);
  if (at === null || !objects(json.accessors)[at]) throw unreadable(`${slot.key} names no accessor`);
  return at;
}

/** A canonical text of a JSON value: keys sorted, so key order never decides equality. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isObject(value)) return JSON.stringify(value) ?? "null";
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, at) => byte === b[at]);

/** The dedup groups upstream compares within: attributes, indices, animation inputs, outputs. */
function dedupGroups(json: Json): number[][] {
  const groups: Array<Set<number>> = [new Set(), new Set(), new Set(), new Set()];
  const add = (group: Set<number> | undefined, value: unknown) => {
    const at = index(value);
    if (group && at !== null) group.add(at);
  };
  for (const primitive of primitivesOf(json)) {
    for (const value of Object.values(isObject(primitive.attributes) ? primitive.attributes : {}))
      add(groups[0], value);
    add(groups[1], primitive.indices);
  }
  for (const sampler of objects(json.animations).flatMap((animation) => objects(animation.samplers))) {
    add(groups[2], sampler.input);
    add(groups[3], sampler.output);
  }
  return groups.map((group) => [...group]);
}

/** The key two accessors must share before their bytes are compared. */
const accessorKey = (accessor: Json) =>
  [accessor.count, accessor.type, accessor.componentType, accessor.normalized === true].join(":");

/** Within one group, each accessor equal in shape and bytes to an earlier one, mapped to that one. */
function findDuplicates(doc: PackDoc, group: number[], duplicates: Map<number, number>): void {
  const accessors = objects(doc.json.accessors);
  group.forEach((a, i) => {
    if (duplicates.has(a)) return;
    for (const b of group.slice(i + 1)) {
      const candidate = !duplicates.has(b) && accessorKey(accessors[a] ?? {}) === accessorKey(accessors[b] ?? {});
      if (candidate && sameBytes(accessorData(doc, a), accessorData(doc, b))) duplicates.set(b, a);
    }
  });
}

/**
 * Merge accessors equal in shape and bytes into the first of each (glTF-Transform `dedupAccessors`):
 * primitive attributes (not morph targets, as upstream), indices and animation samplers are pointed
 * at it. Returns how many accessors were merged away.
 */
export function dedupAccessors(doc: PackDoc): number {
  const duplicates = new Map<number, number>();
  for (const group of dedupGroups(doc.json)) findDuplicates(doc, group, duplicates);
  const swap = (owner: Json, key: string) => {
    const at = index(owner[key]);
    if (at !== null && duplicates.has(at)) owner[key] = duplicates.get(at);
  };
  for (const primitive of primitivesOf(doc.json)) {
    const attributes = isObject(primitive.attributes) ? primitive.attributes : {};
    for (const key of Object.keys(attributes)) swap(attributes, key);
    swap(primitive, "indices");
  }
  for (const sampler of objects(doc.json.animations).flatMap((animation) => objects(animation.samplers))) {
    swap(sampler, "input");
    swap(sampler, "output");
  }
  return duplicates.size;
}

/**
 * Merge materials equal in everything but their name into the first (glTF-Transform
 * `dedupMaterials` with `keepUniqueNames: false`); returns how many were merged away. Textures are
 * compared by index.
 */
export function dedupMaterials(json: Json): number {
  const keys = objects(json.materials).map((material) => {
    const { name: _name, ...rest } = material;
    return canonical(rest);
  });
  const first = new Map<string, number>();
  const duplicates = new Map<number, number>();
  keys.forEach((key, at) => {
    const kept = first.get(key);
    if (kept === undefined) first.set(key, at);
    else duplicates.set(at, kept);
  });
  for (const primitive of primitivesOf(json)) {
    const at = index(primitive.material);
    if (at !== null && duplicates.has(at)) primitive.material = duplicates.get(at);
  }
  return duplicates.size;
}

/** Drop materials no primitive names, renumbering the rest; returns how many were dropped. */
export function pruneMaterials(json: Json): number {
  if (json.materials === undefined) return 0;
  const materials = objects(json.materials);
  const used = new Set(primitivesOf(json).flatMap((primitive) => index(primitive.material) ?? []));
  const moved = new Map<number, number>();
  const kept = materials.filter((_, at) => {
    if (!used.has(at)) return false;
    moved.set(at, moved.size);
    return true;
  });
  for (const primitive of primitivesOf(json)) {
    const at = index(primitive.material);
    if (at !== null) primitive.material = moved.get(at);
  }
  if (kept.length) json.materials = kept;
  else delete json.materials;
  return materials.length - kept.length;
}

/** Drop accessors nothing names, renumbering the rest and their data; returns how many were dropped. */
export function pruneAccessors(doc: PackDoc): number {
  const accessors = objects(doc.json.accessors);
  const slots = accessorSlots(doc.json);
  const used = new Set(slots.map((slot) => slotAccessor(doc.json, slot)));
  const moved = new Map<number, number>();
  const kept = accessors.filter((_, at) => {
    if (!used.has(at)) return false;
    moved.set(at, moved.size);
    return true;
  });
  for (const slot of slots) slot.owner[slot.key] = moved.get(slotAccessor(doc.json, slot));
  const data = new Map<number, Uint8Array>();
  for (const [from, to] of moved) {
    const bytes = doc.data.get(from);
    if (bytes) data.set(to, bytes);
  }
  doc.json.accessors = kept;
  doc.data = data;
  return accessors.length - kept.length;
}

/** What each accessor is used as; throws {@link WeldSkipped} for one used both as vertices and as indices. */
function accessorUses(json: Json): Map<number, AccessorUse> {
  const uses = new Map<number, AccessorUse>();
  for (const slot of accessorSlots(json)) {
    const at = slotAccessor(json, slot);
    const seen = uses.get(at);
    const clash = seen !== undefined && seen !== slot.use;
    if (clash && (seen === AccessorUse.Index || slot.use === AccessorUse.Index))
      throw unreadable(`accessor ${at} is both indices and data`);
    if (seen === undefined || slot.use === AccessorUse.Vertex) uses.set(at, slot.use);
  }
  return uses;
}

/** One accessor's dense data written as a view of its own; vertex data padded to 4-byte elements. */
function packAccessor(out: BinWriter, data: Uint8Array, elementBytes: number, use: AccessorUse | undefined): number {
  if (use === AccessorUse.Index) return out.add(data, { target: ELEMENT_ARRAY_BUFFER });
  if (use !== AccessorUse.Vertex) return out.add(data);
  const stride = Math.ceil(elementBytes / VERTEX_ALIGN) * VERTEX_ALIGN;
  if (stride === elementBytes) return out.add(data, { target: ARRAY_BUFFER });
  const count = data.length / elementBytes;
  const strided = new Uint8Array(count * stride);
  for (let i = 0; i < count; i++) strided.set(data.subarray(i * elementBytes, (i + 1) * elementBytes), i * stride);
  return out.add(strided, { target: ARRAY_BUFFER, byteStride: stride });
}

/** The bytes of view `at`, checked to lie inside the binary chunk. */
function viewBytes(doc: PackDoc, at: number): Uint8Array {
  const view = objects(doc.json.bufferViews)[at];
  const start = index(view?.byteOffset) ?? 0;
  const length = index(view?.byteLength);
  if (!view || index(view.buffer) !== 0 || length === null || start + length > doc.bin.byteLength)
    throw unreadable(`view ${at} lies outside the binary chunk`);
  return doc.bin.subarray(start, start + length);
}

/**
 * The document written as a GLB: every accessor with data in a view of its own, in accessor order,
 * then every image's view, in image order. Views nothing else names are left out.
 */
export function packGlb(doc: PackDoc): Uint8Array {
  const uses = accessorUses(doc.json);
  const accessors = objects(doc.json.accessors);
  const payloads = accessors.map((accessor, at) =>
    accessor.bufferView === undefined && !doc.data.has(at) ? null : accessorData(doc, at),
  );
  const images = objects(doc.json.images).map((image) => {
    const at = index(image.bufferView);
    return at === null ? null : viewBytes(doc, at);
  });
  const out = new BinWriter();
  accessors.forEach((accessor, at) => {
    const data = payloads[at];
    if (!data) return;
    accessor.bufferView = packAccessor(out, data, elementLayout(accessor).elementBytes, uses.get(at));
    delete accessor.byteOffset;
  });
  objects(doc.json.images).forEach((image, at) => {
    const data = images[at];
    if (data) image.bufferView = out.add(data);
  });
  const bin = out.bytes();
  const json: Json = { ...doc.json, bufferViews: out.views, buffers: [{ byteLength: bin.byteLength }] };
  // glTF has no empty buffer or view list: a document with no data has neither.
  if (!out.views.length) {
    delete json.bufferViews;
    delete json.buffers;
  }
  return writeGlb(json as GltfJson, bin);
}

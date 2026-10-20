/**
 * Authored levels at import (LOD-11): a GLB whose nodes carry `MSFT_lod` (the vendor extension
 * Babylon writes; the highest level names its coarser levels' nodes in `ids`, best first, with an
 * optional `extras.MSFT_screencoverage` per level) gets those levels as the host primitives'
 * `genex_lods`, the same schema the simplifier writes (`lods.ts`), so the renderer picks them by the
 * same rule.
 *
 * Two steps around the mesh steps that rewrite vertices:
 *
 * 1. {@link liftMsftLod} (first): each host node's `ids` and coverage move to an import-private
 *    node extra ({@link AUTHORED_LODS_KEY}) and `MSFT_lod` leaves the node, the materials and
 *    `extensionsUsed`, so weld, tangents and reorder treat every level's mesh as a mesh of its own.
 *    The level nodes are in no scene (a reader without the extension draws the highest level only),
 *    and the runtime walks the scene, so they never draw.
 * 2. {@link foldAuthoredLods} (after reorder, before meshlets): each host primitive gets its levels'
 *    vertices appended to its own attributes (the base vertices keep their indices, so the base
 *    triangles and every later step see the same mesh), the level nodes lose their meshes, unused
 *    meshes and accessors go, the document is packed, and each level becomes a `genex_lods` range
 *    over the appended vertices.
 *
 * A level's error is what makes the runtime switch at the coverage the author gave. The spec leaves
 * coverage's unit open; it is read as Babylon's: the bounding sphere's projected disc over the
 * view's height squared. At a 1-pixel threshold on {@link LOD_NOMINAL_HEIGHT_PX} rows (genex-render
 * `mesh_lod.rs`: level k is drawn while `error_k * H / (2 tan(fov/2)) <= threshold * distance`), the
 * switch from level k-1 to k at coverage `c` is `error_k = threshold * r / (H * sqrt(c / pi))`, the
 * field of view cancelling out. A level without a usable coverage (none, not decreasing, outside
 * (0, 1]) takes how far the base vertices lie from it (`lod-deviation.ts`). Errors never decrease.
 *
 * All or nothing per GLB: a host whose levels do not match it part for part and attribute for
 * attribute, a level node that is missing, repeated, another host or the host itself, more than
 * {@link LOD_MAX_LEVELS} levels, or levels that are not coarser leave the whole GLB as the mesh steps
 * made it, the private extras dropped, with the typed reason; the simplifier then runs as for any
 * GLB. A GLB with authored levels gets no simplified levels for its other primitives. The output
 * is a pure function of the input. The last coverage value (below which nothing draws) has no
 * runtime rule and is not kept.
 */
import {
  LOD_MAX_LEVELS,
  LOD_SCHEMA_VERSION,
  LodExtrasKey,
  LodLevelKey,
  LODS_EXTRAS_KEY,
} from "../../shared/render-quality.ts";
import { type GltfJson, readGlb, writeGlb } from "./glb.ts";
import { dropExtension, extension, index, isObject, type Json, objects, withoutExtensions } from "./gltf-json.ts";
import { type LodLevel, validateLodSet } from "./lods.ts";
import { vertexDeviation } from "./lod-deviation.ts";
import { type Geometry, readGeometry } from "./meshlets.ts";
import { accessorData, type PackDoc, packGlb, primitivesOf, pruneAccessors } from "./prune.ts";

/** The glTF vendor extension read here. */
export const MSFT_LOD = "MSFT_lod";
/** The host node's extras member holding each level's screen coverage. */
export const MSFT_SCREEN_COVERAGE = "MSFT_screencoverage";
/** The import-private node and primitive extra between the two steps; never in a delivered GLB. */
export const AUTHORED_LODS_KEY = "genex_authored_lods";
/** The output height the runtime's LOD view assumes (genex-render `LOD_NOMINAL_HEIGHT`). */
export const LOD_NOMINAL_HEIGHT_PX = 1080;
/** The error a drawn level may show, in output pixels (genex-render `LOD_THRESHOLD_PX`). */
const LOD_THRESHOLD_PX = 1;
const AXES = 3;
const U32_BYTES = 4;
const POSITION = "POSITION";

/** Why {@link foldAuthoredLods} kept no authored levels. Wire values: the import report names them. */
export const AuthoredLodSkip = {
  NoAuthoredLevels: "no-authored-levels",
  AlreadySimplified: "already-simplified",
  Unreadable: "unreadable",
  LevelMissing: "level-missing",
  SharedMesh: "shared-mesh",
  PartsMismatch: "parts-mismatch",
  AttributesMismatch: "attributes-mismatch",
  OverLimit: "over-limit",
  NotCoarser: "not-coarser",
} as const;
export type AuthoredLodSkip = (typeof AuthoredLodSkip)[keyof typeof AuthoredLodSkip];

/** What {@link foldAuthoredLods} did: the bytes to hand on and how many hosts got levels. */
export type AuthoredLodOutcome =
  | { bytes: Uint8Array; authored: true; hosts: number }
  | { bytes: Uint8Array; authored: false; reason: AuthoredLodSkip };

/** A host node's lifted levels: the level nodes, best first, and the coverage per level (null: none given). */
interface AuthoredLevels {
  ids: number[];
  coverage: number[] | null;
}

/** One host's checked plan: its node, mesh and level meshes, and the coverage. */
interface HostPlan {
  mesh: number;
  levelNodes: number[];
  levelMeshes: number[];
  coverage: number[] | null;
}

/** A fold refusal carried out of the planning and merging helpers. */
class AuthoredRefusal extends Error {
  readonly reason: AuthoredLodSkip;
  constructor(reason: AuthoredLodSkip) {
    super(reason);
    this.reason = reason;
  }
}

const refuse = (reason: AuthoredLodSkip): never => {
  throw new AuthoredRefusal(reason);
};

/** The finite numbers of `value` when it is an array of them, else null. */
function numbers(value: unknown): number[] | null {
  if (!Array.isArray(value) || !value.every((each) => typeof each === "number" && Number.isFinite(each))) return null;
  return value as number[];
}

/**
 * `glb` with every node's `MSFT_lod` moved to {@link AUTHORED_LODS_KEY} in its extras (with its
 * coverage), and the extension gone from materials and the extension lists; the same bytes when no
 * node or material names it, or the GLB cannot be read.
 */
export function liftMsftLod(glb: Uint8Array): { bytes: Uint8Array; lifted: number } {
  let parts: { json: GltfJson; bin: Uint8Array };
  try {
    parts = readGlb(glb);
  } catch {
    return { bytes: glb, lifted: 0 };
  }
  const json = structuredClone(parts.json) as Json;
  let lifted = 0;
  let touched = false;
  for (const node of objects(json.nodes)) {
    const found = extension(node, MSFT_LOD);
    if (!found) continue;
    const extras = isObject(node.extras) ? { ...node.extras } : {};
    const coverage = numbers(extras[MSFT_SCREEN_COVERAGE]);
    delete extras[MSFT_SCREEN_COVERAGE];
    const ids = Array.isArray(found.ids) ? found.ids.map((id) => index(id) ?? -1) : [];
    node.extras = { ...extras, [AUTHORED_LODS_KEY]: { ids, coverage } satisfies AuthoredLevels };
    dropExtension(node, MSFT_LOD);
    lifted++;
    touched = true;
  }
  // A material's own levels follow its node's: the host's material is the one drawn.
  for (const material of objects(json.materials)) {
    if (!extension(material, MSFT_LOD)) continue;
    dropExtension(material, MSFT_LOD);
    touched = true;
  }
  if (!touched) return { bytes: glb, lifted: 0 };
  return { bytes: writeGlb(withoutExtensions(json, (name) => name === MSFT_LOD) as GltfJson, parts.bin), lifted };
}

/** The lifted levels a node carries, or null. */
function authoredOf(node: Json): AuthoredLevels | null {
  const value = isObject(node.extras) ? node.extras[AUTHORED_LODS_KEY] : undefined;
  if (!isObject(value) || !Array.isArray(value.ids)) return null;
  return { ids: value.ids.map((id) => index(id) ?? -1), coverage: numbers(value.coverage) };
}

/** Every node's and primitive's private extra removed (an extras object left empty goes too). */
function dropPrivateExtras(json: Json): void {
  for (const owner of [...objects(json.nodes), ...primitivesOf(json)]) {
    if (!isObject(owner.extras) || !(AUTHORED_LODS_KEY in owner.extras)) continue;
    delete owner.extras[AUTHORED_LODS_KEY];
    if (!Object.keys(owner.extras).length) delete owner.extras;
  }
}

/** The checked plan of each host node, in node order; throws {@link AuthoredRefusal}. */
function planHosts(json: Json): HostPlan[] {
  const nodes = objects(json.nodes);
  const hosts = nodes.flatMap((node, at) => {
    const levels = authoredOf(node);
    return levels ? [{ at, node, levels }] : [];
  });
  const hostNodes = new Set(hosts.map((host) => host.at));
  const claimed = new Set<number>();
  return hosts.map(({ at, node, levels }) => {
    const mesh = index(node.mesh) ?? refuse(AuthoredLodSkip.LevelMissing);
    if (levels.ids.length > LOD_MAX_LEVELS) refuse(AuthoredLodSkip.OverLimit);
    const ownLevels = new Set(levels.ids);
    const nested = levels.ids.some((id) => id === at || hostNodes.has(id));
    if (!levels.ids.length || ownLevels.size !== levels.ids.length || nested) refuse(AuthoredLodSkip.LevelMissing);
    const levelMeshes = levels.ids.map((id) => index(nodes[id]?.mesh) ?? refuse(AuthoredLodSkip.LevelMissing));
    for (const used of [mesh, ...levelMeshes]) {
      if (claimed.has(used)) refuse(AuthoredLodSkip.SharedMesh);
      claimed.add(used);
    }
    return { mesh, levelNodes: levels.ids, levelMeshes, coverage: levels.coverage };
  });
}

/** Whether two accessors lay out their elements alike. */
function sameLayout(a: Json | undefined, b: Json | undefined): boolean {
  if (!a || !b) return false;
  return a.componentType === b.componentType && a.type === b.type && Boolean(a.normalized) === Boolean(b.normalized);
}

/** The host primitives and, per level, the matching level primitives; throws {@link AuthoredRefusal}. */
function matchParts(json: Json, plan: HostPlan): { host: Json[]; levels: Json[][] } {
  const meshes = objects(json.meshes);
  const host = objects(meshes[plan.mesh]?.primitives);
  const levels = plan.levelMeshes.map((at) => objects(meshes[at]?.primitives));
  if (!host.length || levels.some((each) => each.length !== host.length)) refuse(AuthoredLodSkip.PartsMismatch);
  const accessors = objects(json.accessors);
  host.forEach((primitive, part) => {
    const attributes = isObject(primitive.attributes) ? primitive.attributes : {};
    if (primitive.targets !== undefined) refuse(AuthoredLodSkip.AttributesMismatch);
    for (const level of levels) {
      const other = level[part];
      const theirs = isObject(other?.attributes) ? other.attributes : {};
      const alike = Object.entries(attributes).every(([name, at]) =>
        sameLayout(accessors[index(at) ?? -1], accessors[index(theirs[name]) ?? -1]),
      );
      if (!alike || other?.targets !== undefined) refuse(AuthoredLodSkip.AttributesMismatch);
    }
  });
  return { host, levels };
}

/** The radius of the sphere around the base vertices' bounding box centre. */
function radiusOf(positions: Float32Array): number {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let at = 0; at < positions.length; at++) {
    const axis = at % AXES;
    const value = positions[at] ?? 0;
    min[axis] = Math.min(min[axis] ?? 0, value);
    max[axis] = Math.max(max[axis] ?? 0, value);
  }
  const centre = min.map((low, axis) => (low + (max[axis] ?? 0)) / 2);
  let radius = 0;
  for (let at = 0; at < positions.length; at += AXES) {
    const d = Math.hypot(...centre.map((mid, axis) => (positions[at + axis] ?? 0) - mid));
    radius = Math.max(radius, d);
  }
  return radius;
}

/**
 * The coverage at which each level takes over, or null when it is not usable: one value per level
 * at least (the first `levels` are read), each in (0, 1] and strictly below the one before.
 */
function switchCoverage(coverage: number[] | null, levels: number): number[] | null {
  if (!coverage || coverage.length < levels) return null;
  const used = coverage.slice(0, levels);
  const valid = used.every((value, at) => value > 0 && value <= 1 && (at === 0 || value < (used[at - 1] ?? 0)));
  return valid ? used : null;
}

/** The object-space error at which the runtime switches to a level at coverage `c` of a sphere of `radius`. */
export function coverageError(radius: number, c: number): number {
  return (LOD_THRESHOLD_PX * radius) / (LOD_NOMINAL_HEIGHT_PX * Math.sqrt(c / Math.PI));
}

/**
 * One host primitive's levels' vertices appended to its attributes (new accessors, base vertices
 * first) and its levels as ranges over them with their errors; throws {@link AuthoredRefusal}.
 */
function foldPart(doc: PackDoc, host: Json, levels: Json[], coverage: number[] | null): LodLevel[] {
  const base = readGeometry(doc.json, doc.bin, host) ?? refuse(AuthoredLodSkip.Unreadable);
  const geometry: Geometry[] = levels.map(
    (level) => readGeometry(doc.json, doc.bin, level) ?? refuse(AuthoredLodSkip.Unreadable),
  );
  const counts = [base, ...geometry].map((each) => each.positions.length / AXES);
  const offsets = counts.map((_, at) => counts.slice(0, at).reduce((sum, count) => sum + count, 0));
  const total = counts.reduce((sum, count) => sum + count, 0);
  const attributes = isObject(host.attributes) ? host.attributes : {};
  const accessors = objects(doc.json.accessors);
  for (const [name, at] of Object.entries(attributes)) {
    const owners = [host, ...levels].map((primitive) =>
      isObject(primitive.attributes) ? (index(primitive.attributes[name]) ?? -1) : -1,
    );
    let chunks: Uint8Array[];
    try {
      chunks = owners.map((owner) => accessorData(doc, owner));
    } catch {
      return refuse(AuthoredLodSkip.Unreadable);
    }
    const data = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    chunks.reduce((cursor, chunk) => {
      data.set(chunk, cursor);
      return cursor + chunk.byteLength;
    }, 0);
    const source = accessors[index(at) ?? -1] ?? {};
    const merged: Json = { componentType: source.componentType, type: source.type, count: total };
    if (source.normalized) merged.normalized = true;
    if (name === POSITION) Object.assign(merged, boundsOf([base, ...geometry]));
    accessors.push(merged);
    doc.data.set(accessors.length - 1, data);
    attributes[name] = accessors.length - 1;
  }
  doc.json.accessors = accessors;
  const ranges = geometry.map((each, at) => each.indices.map((vertex) => vertex + (offsets[at + 1] ?? 0)));
  return withErrors(base, geometry, ranges, coverage, total);
}

/** POSITION's `min` and `max` over every level's vertices. */
function boundsOf(levels: Geometry[]): { min: number[]; max: number[] } {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const level of levels) {
    level.positions.forEach((value, at) => {
      const axis = at % AXES;
      min[axis] = Math.min(min[axis] ?? 0, value);
      max[axis] = Math.max(max[axis] ?? 0, value);
    });
  }
  return { min, max };
}

/** The ranges with their errors, checked as a chain the runtime takes; throws {@link AuthoredRefusal}. */
function withErrors(
  base: Geometry,
  geometry: Geometry[],
  ranges: Uint32Array[],
  coverage: number[] | null,
  total: number,
): LodLevel[] {
  const switches = switchCoverage(coverage, ranges.length);
  const radius = radiusOf(base.positions);
  const positions = new Float32Array(total * AXES);
  [base, ...geometry].reduce((cursor, each) => {
    positions.set(each.positions, cursor);
    return cursor + each.positions.length;
  }, 0);
  let previous = 0;
  const levels = ranges.map((indices, at) => {
    const authored = switches
      ? coverageError(radius, switches[at] ?? 1)
      : vertexDeviation(positions, base.indices, indices);
    const error = Math.max(authored, previous);
    previous = error;
    return { indices, error };
  });
  if (validateLodSet({ levels }, total) !== null) refuse(AuthoredLodSkip.NotCoarser);
  return levels;
}

/** The level nodes' meshes detached and every mesh no node names removed, `node.mesh` renumbered. */
function dropLevelMeshes(json: Json, plans: HostPlan[]): void {
  const nodes = objects(json.nodes);
  for (const plan of plans) for (const at of plan.levelNodes) delete nodes[at]?.mesh;
  const meshes = objects(json.meshes);
  const named = new Set(nodes.map((node) => index(node.mesh)).filter((at): at is number => at !== null));
  const moved = new Map<number, number>();
  const kept = meshes.filter((_, at) => {
    if (!named.has(at)) return false;
    moved.set(at, moved.size);
    return true;
  });
  for (const node of nodes) {
    const at = index(node.mesh);
    if (at !== null) node.mesh = moved.get(at);
  }
  json.meshes = kept;
}

/**
 * The host primitives' level ranges appended as one view each and named in their `genex_lods`,
 * found by the private slot each carries.
 */
function writeLevels(glb: Uint8Array, slots: LodLevel[][]): Uint8Array {
  const { json: parsed, bin } = readGlb(glb);
  const json = parsed as Json;
  const views = objects(json.bufferViews);
  const chunks: Uint8Array[] = [];
  const padded = (size: number) => Math.ceil(size / U32_BYTES) * U32_BYTES;
  let length = padded(bin.byteLength);
  for (const primitive of primitivesOf(json)) {
    const extras = isObject(primitive.extras) ? primitive.extras : {};
    const slot = index(extras[AUTHORED_LODS_KEY]);
    const set = slot === null ? undefined : slots[slot];
    if (!set) continue;
    const words = new Uint32Array(set.reduce((sum, level) => sum + level.indices.length, 0));
    let first = 0;
    const levels = set.map((level) => {
      words.set(level.indices, first);
      const entry = {
        [LodLevelKey.First]: first,
        [LodLevelKey.Count]: level.indices.length,
        [LodLevelKey.Error]: level.error,
      };
      first += level.indices.length;
      return entry;
    });
    views.push({ buffer: 0, byteOffset: length, byteLength: words.byteLength });
    chunks.push(new Uint8Array(words.buffer));
    length += padded(words.byteLength);
    delete extras[AUTHORED_LODS_KEY];
    primitive.extras = {
      ...extras,
      [LODS_EXTRAS_KEY]: {
        [LodExtrasKey.Version]: LOD_SCHEMA_VERSION,
        [LodExtrasKey.Indices]: views.length - 1,
        [LodExtrasKey.Levels]: levels,
      },
    };
  }
  const out = new Uint8Array(length);
  out.set(bin);
  let cursor = padded(bin.byteLength);
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += padded(chunk.byteLength);
  }
  const buffers = objects(json.buffers);
  json.bufferViews = views;
  json.buffers = [{ ...(buffers[0] ?? {}), byteLength: length }, ...buffers.slice(1)];
  return writeGlb(json as GltfJson, out);
}

/** Whether any primitive already names `genex_lods`, or holds extras a key cannot join. */
function alreadySimplified(json: Json): boolean {
  return primitivesOf(json).some(
    (primitive) =>
      primitive.extras !== undefined && (!isObject(primitive.extras) || LODS_EXTRAS_KEY in primitive.extras),
  );
}

/**
 * `glb` with each lifted host's levels folded into its primitives' `genex_lods` (see the module
 * comment); otherwise the GLB with the private extras dropped and the reason. Never throws for the
 * GLB's own contents.
 */
export async function foldAuthoredLods(glb: Uint8Array): Promise<AuthoredLodOutcome> {
  let parts: { json: GltfJson; bin: Uint8Array };
  try {
    parts = readGlb(glb);
  } catch {
    return { bytes: glb, authored: false, reason: AuthoredLodSkip.Unreadable };
  }
  const json = structuredClone(parts.json) as Json;
  if (!objects(json.nodes).some((node) => authoredOf(node) !== null))
    return { bytes: glb, authored: false, reason: AuthoredLodSkip.NoAuthoredLevels };
  const skip = (reason: AuthoredLodSkip): AuthoredLodOutcome => {
    const plain = structuredClone(parts.json) as Json;
    dropPrivateExtras(plain);
    return { bytes: writeGlb(plain as GltfJson, parts.bin), authored: false, reason };
  };
  if (alreadySimplified(json)) return skip(AuthoredLodSkip.AlreadySimplified);
  try {
    const plans = planHosts(json);
    const doc: PackDoc = { json, bin: parts.bin, data: new Map() };
    const slots: LodLevel[][] = [];
    for (const plan of plans) {
      const { host, levels } = matchParts(json, plan);
      host.forEach((primitive, part) => {
        const set = foldPart(
          doc,
          primitive,
          levels.map((level) => level[part] ?? {}),
          plan.coverage,
        );
        primitive.extras = {
          ...(isObject(primitive.extras) ? primitive.extras : {}),
          [AUTHORED_LODS_KEY]: slots.length,
        };
        slots.push(set);
      });
    }
    for (const node of objects(json.nodes)) {
      if (isObject(node.extras) && AUTHORED_LODS_KEY in node.extras) delete node.extras[AUTHORED_LODS_KEY];
      if (isObject(node.extras) && !Object.keys(node.extras).length) delete node.extras;
    }
    dropLevelMeshes(json, plans);
    pruneAccessors(doc);
    return { bytes: writeLevels(packGlb(doc), slots), authored: true, hosts: plans.length };
  } catch (error) {
    if (error instanceof AuthoredRefusal) return skip(error.reason);
    return skip(AuthoredLodSkip.Unreadable);
  }
}

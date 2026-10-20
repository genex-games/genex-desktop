/**
 * Character facts (game systems C-23): a rigged GLB's clips, joints, humanoid coverage and skinned
 * levels, read in the importer's sandbox from the GLB it wrote and carried in the receipt to
 * `assets.inventory` (`shared/character-facts.ts` holds the shape and the host's check).
 *
 * The skeleton is genex-anim's (`import.rs`): the skin of the first node that draws a mesh through
 * one, its joints and the nodes between two joints, in parent-first order. Humanoid coverage reads
 * the one alias table, `tests/fixtures/humanoid-aliases.json`, with genex-anim's rule
 * (`humanoid.rs`): each bone tries its names in order, a joint matching by its exact name first,
 * then by the part after its last `:` or `|` ignoring ASCII case, never a joint an earlier bone
 * took; the rig takes the family that maps the most bones, a tie going to the earlier family.
 *
 * A clip's length is its last key time (genex-anim's), and it is root motion when the root, or
 * the hips, ends more than {@link ROOT_MOTION_MIN_SHARE} of the hips' height away on the ground
 * plane (glTF's Y-up world, through the rest pose of the node's parents). The output is a pure
 * function of the input; a file this cannot read has no facts.
 */
import {
  CHARACTER_CLIP_NAME_MAX_CHARS,
  CHARACTER_CLIPS_MAX,
  CHARACTER_JOINTS_MAX,
  type CharacterClip,
  type CharacterFacts,
  ClipMotion,
  HUMANOID_REQUIRED_BONES,
  type HumanoidCoverage,
} from "../../shared/character-facts.ts";
import { LOD_SCHEMA_VERSION, LodExtrasKey, LODS_EXTRAS_KEY } from "../../shared/render-quality.ts";
import aliasTable from "../../../tests/fixtures/humanoid-aliases.json" with { type: "json" };
import { GltfComponent, readGlb } from "./glb.ts";
import { index, isObject, type Json, objects } from "./gltf-json.ts";
import { accessorData, type PackDoc } from "./prune.ts";

/** The humanoid profile's bones, in profile order (the alias table's `bones`). */
export const HUMANOID_BONES: readonly string[] = aliasTable.bones;
/** Each rig family's names per bone, in detection tie-break order. */
const PROFILES: readonly { id: string; aliases: Readonly<Record<string, readonly string[]>> }[] = aliasTable.profiles;

/** A root or hips that travels further than this share of the hips' height makes a clip root motion. */
export const ROOT_MOTION_MIN_SHARE = 0.1;
/** Clip lengths are kept to the millisecond. */
const SECONDS_PER_MS = 1000;
const NO_NODE = -1;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
const MAT4 = 16;
const VEC3 = 3;
/** A CubicSpline sampler's output holds in-tangent, value and out-tangent per key. */
const CUBIC_PARTS = 3;
const HIPS = "Hips";
const JOINTS_ATTRIBUTE = "JOINTS_0";

type Mat4 = readonly number[];
type Vec3 = readonly [number, number, number];

/** The GLB's skeleton as genex-anim builds it: nodes in parent-first order and their names. */
interface Skeleton {
  order: number[];
  names: string[];
  parents: number[];
  meshNode: number;
}

/** Each node's parent, or {@link NO_NODE}; null when a node has two parents or a child is not a node. */
function parentTable(nodes: readonly Json[]): number[] | null {
  const parents = new Array<number>(nodes.length).fill(NO_NODE);
  for (const [at, node] of nodes.entries()) {
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      const slot = index(child);
      if (slot === null || slot >= nodes.length || parents[slot] !== NO_NODE || slot === at) return null;
      parents[slot] = at;
    }
  }
  return parents;
}

/** The skin's joints and the nodes between two of them; null for a joint listed twice or a cycle. */
function members(parents: readonly number[], joints: readonly number[]): boolean[] | null {
  const member = new Array<boolean>(parents.length).fill(false);
  for (const joint of joints) {
    if (member[joint]) return null;
    member[joint] = true;
  }
  for (const joint of joints) {
    const between = betweenNodes(parents, member, joint);
    if (!between) return null;
    for (const node of between) member[node] = true;
  }
  return member;
}

/** The non-member nodes from `joint` up to its nearest member ancestor (none without one); null for a cycle. */
function betweenNodes(parents: readonly number[], member: readonly boolean[], joint: number): number[] | null {
  const between: number[] = [];
  let at = parents[joint] ?? NO_NODE;
  while (at !== NO_NODE && !member[at]) {
    if (between.length > parents.length) return null;
    between.push(at);
    at = parents[at] ?? NO_NODE;
  }
  return at === NO_NODE ? [] : between;
}

/** Members in parent-first order: the skin's order, each joint's unplaced member ancestors first. */
function parentFirst(parents: readonly number[], member: readonly boolean[], joints: readonly number[]): number[] {
  const placed = new Array<boolean>(parents.length).fill(false);
  const order: number[] = [];
  for (const joint of joints) {
    const pending: number[] = [];
    for (let at = joint; at !== NO_NODE && !placed[at]; at = parents[at] ?? NO_NODE) {
      if (member[at]) pending.push(at);
      if (pending.length > parents.length) break;
    }
    for (const node of pending.reverse()) {
      placed[node] = true;
      order.push(node);
    }
  }
  return order;
}

/** The document's nodes by index, anything that is not an object read as an empty node. */
const nodeList = (json: Json): Json[] =>
  Array.isArray(json.nodes) ? json.nodes.map((node) => (isObject(node) ? node : {})) : [];

/** The skeleton of the first skinned mesh node, or null when there is none or it is not a tree. */
function skeletonOf(json: Json): Skeleton | null {
  const nodes = nodeList(json);
  const meshNode = nodes.findIndex((node) => index(node.mesh) !== null && index(node.skin) !== null);
  const skin = objects(json.skins)[index(nodes[meshNode]?.skin) ?? -1];
  const parents = parentTable(nodes);
  if (!skin || !parents || !Array.isArray(skin.joints)) return null;
  const joints = skin.joints.map(index);
  if (!joints.length || joints.some((joint) => joint === null || joint >= nodes.length)) return null;
  const member = members(parents, joints as number[]);
  if (!member) return null;
  const order = parentFirst(parents, member, joints as number[]);
  const names = order.map((node) => (typeof nodes[node]?.name === "string" ? (nodes[node].name as string) : ""));
  return { order, names, parents, meshNode };
}

/** The part of a joint name after its last `|` or `:` ("Armature|mixamorig:Hips" → "Hips"). */
const shortName = (name: string): string => name.slice(Math.max(name.lastIndexOf("|"), name.lastIndexOf(":")) + 1);
const sameIgnoringAsciiCase = (a: string, b: string): boolean =>
  a.length === b.length && a.replace(/[A-Z]/g, (c) => c.toLowerCase()) === b.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The joint (skeleton slot) `name` matches that no earlier bone took: exact first, then the short name. */
function findFree(names: readonly string[], name: string, taken: ReadonlySet<number>): number | null {
  const free = names.flatMap((joint, slot) => (taken.has(slot) ? [] : [[joint, slot] as const]));
  const exact = free.find(([joint]) => joint === name);
  const short = exact ?? free.find(([joint]) => sameIgnoringAsciiCase(shortName(joint), name));
  return short ? short[1] : null;
}

/** Each bone's skeleton slot under one family's names (null where the rig lacks it). */
function mapWith(names: readonly string[], aliases: Readonly<Record<string, readonly string[]>>): (number | null)[] {
  const taken = new Set<number>();
  return HUMANOID_BONES.map((bone) => {
    for (const alias of aliases[bone] ?? []) {
      const slot = findFree(names, alias, taken);
      if (slot === null) continue;
      taken.add(slot);
      return slot;
    }
    return null;
  });
}

/** The rig family that maps the most bones (ties to the earlier) and its map. */
function humanoidMap(names: readonly string[]): { coverage: HumanoidCoverage; hips: number | null } {
  let best = { id: PROFILES[0]?.id ?? "", map: mapWith(names, PROFILES[0]?.aliases ?? {}) };
  for (const profile of PROFILES.slice(1)) {
    const map = mapWith(names, profile.aliases);
    const count = (slots: (number | null)[]) => slots.filter((slot) => slot !== null).length;
    if (count(map) > count(best.map)) best = { id: profile.id, map };
  }
  const missing = HUMANOID_BONES.filter((_, at) => best.map[at] === null);
  const coverage = {
    rig: best.id,
    mapped: HUMANOID_REQUIRED_BONES - missing.length,
    required: HUMANOID_REQUIRED_BONES,
    missing,
  };
  return { coverage, hips: best.map[HUMANOID_BONES.indexOf(HIPS)] ?? null };
}

const numbers = (value: unknown, length: number): number[] | null =>
  Array.isArray(value) && value.length === length && value.every((n) => typeof n === "number" && Number.isFinite(n))
    ? (value as number[])
    : null;

/** A node's local rest transform as a column-major matrix: its `matrix`, or T·R·S. */
function localMatrix(node: Json | undefined): Mat4 {
  const matrix = numbers(node?.matrix, MAT4);
  if (matrix) return matrix;
  const [tx, ty, tz] = numbers(node?.translation, VEC3) ?? [0, 0, 0];
  const [x, y, z, w] = numbers(node?.rotation, 4) ?? [0, 0, 0, 1];
  const [sx, sy, sz] = numbers(node?.scale, VEC3) ?? [1, 1, 1];
  // biome-ignore format: a matrix reads as its four columns
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(MAT4).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) out[col * 4 + row] += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
  return out;
}

/** A node's rest transform in the world: its parents' transforms, then its own. */
function globalMatrix(nodes: readonly Json[], parents: readonly number[], node: number): Mat4 {
  let matrix: Mat4 = IDENTITY;
  for (let at = node, steps = 0; at !== NO_NODE && steps <= nodes.length; at = parents[at] ?? NO_NODE, steps++)
    matrix = multiply(localMatrix(nodes[at]), matrix);
  return matrix;
}

/** A direction (no translation) through a matrix's linear part. */
const direct = (m: Mat4, [x, y, z]: Vec3): Vec3 => [
  (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z,
  (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z,
  (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z,
];

/** The hips' height above the skeleton's lowest joint, or the skeleton's extent without hips. */
function rigHeight(nodes: readonly Json[], skeleton: Skeleton, hips: number | null): number {
  const heights = skeleton.order.map((node) => globalMatrix(nodes, skeleton.parents, node)[13] ?? 0);
  const lowest = Math.min(...heights);
  if (hips !== null) return (heights[hips] ?? 0) - lowest;
  return Math.max(...heights) - lowest;
}

/** An accessor's floats, when it is a float accessor of `type`; null for anything else. */
function floats(doc: PackDoc, at: unknown, type: string): Float32Array | null {
  const slot = index(at);
  const accessor = objects(doc.json.accessors)[slot ?? -1];
  if (slot === null || accessor?.componentType !== GltfComponent.Float || accessor.type !== type) return null;
  try {
    const bytes = accessorData(doc, slot);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Float32Array.from({ length: bytes.byteLength / 4 }, (_, i) => view.getFloat32(i * 4, true));
  } catch {
    return null;
  }
}

/** A sampler's last key time: its input accessor's `max`, else its last value. */
function lastKey(doc: PackDoc, sampler: Json | undefined): number {
  const accessor = objects(doc.json.accessors)[index(sampler?.input) ?? -1];
  const max = Array.isArray(accessor?.max) ? accessor.max[0] : undefined;
  if (typeof max === "number" && Number.isFinite(max)) return max;
  const times = floats(doc, sampler?.input, "SCALAR");
  return times?.length ? (times[times.length - 1] ?? 0) : 0;
}

/** How far a translation channel moves its node on the ground plane, first key to last, in the world. */
function travel(doc: PackDoc, sampler: Json | undefined, parentRest: Mat4): number {
  const values = floats(doc, sampler?.output, "VEC3");
  if (!values) return 0;
  const parts = sampler?.interpolation === "CUBICSPLINE" ? CUBIC_PARTS : 1;
  const keys = values.length / VEC3 / parts;
  if (keys < 2) return 0;
  const value = (key: number, axis: number) => values[(key * parts + (parts === 1 ? 0 : 1)) * VEC3 + axis] ?? 0;
  const delta: Vec3 = [
    value(keys - 1, 0) - value(0, 0),
    value(keys - 1, 1) - value(0, 1),
    value(keys - 1, 2) - value(0, 2),
  ];
  const [x, , z] = direct(parentRest, delta);
  return Math.hypot(x, z);
}

/** What a clip's channels say: its last key time and how far its root or hips travels. */
interface ClipReach {
  seconds: number;
  moved: number;
}

/** One clip's last key time and its movers' furthest ground travel. */
function reachOf(doc: PackDoc, skeleton: Skeleton, movers: ReadonlySet<number>, animation: Json): ClipReach {
  const nodes = nodeList(doc.json);
  const samplers = Array.isArray(animation.samplers) ? animation.samplers : [];
  const reach = { seconds: 0, moved: 0 };
  for (const channel of objects(animation.channels)) {
    const found = samplers[index(channel.sampler) ?? -1];
    const sampler = isObject(found) ? found : undefined;
    reach.seconds = Math.max(reach.seconds, lastKey(doc, sampler));
    const target = isObject(channel.target) ? channel.target : {};
    const node = index(target.node);
    if (node === null || !movers.has(node) || target.path !== "translation") continue;
    const parentRest = globalMatrix(nodes, skeleton.parents, skeleton.parents[node] ?? NO_NODE);
    reach.moved = Math.max(reach.moved, travel(doc, sampler, parentRest));
  }
  return reach;
}

/** The clips in file order, each with its length and motion. */
function clipsOf(doc: PackDoc, skeleton: Skeleton, movers: ReadonlySet<number>, height: number): CharacterClip[] {
  return objects(doc.json.animations).map((animation) => {
    const { seconds, moved } = reachOf(doc, skeleton, movers, animation);
    const name = typeof animation.name === "string" ? animation.name : "";
    const motion = moved > ROOT_MOTION_MIN_SHARE * height ? ClipMotion.RootMotion : ClipMotion.InPlace;
    return { name, seconds: Math.round(seconds * SECONDS_PER_MS) / SECONDS_PER_MS, motion };
  });
}

/** The levels the skinned mesh draws at: its own triangles plus its longest `genex_lods` chain. */
function skinnedLevels(json: Json, meshNode: number): number {
  const mesh = objects(json.meshes)[index(nodeList(json)[meshNode]?.mesh) ?? -1];
  let levels = 0;
  for (const primitive of objects(mesh?.primitives)) {
    const skinned = isObject(primitive.attributes) && primitive.attributes[JOINTS_ATTRIBUTE] !== undefined;
    const lods = isObject(primitive.extras) ? primitive.extras[LODS_EXTRAS_KEY] : undefined;
    const valid = skinned && isObject(lods) && lods[LodExtrasKey.Version] === LOD_SCHEMA_VERSION;
    const chain =
      valid && Array.isArray(lods[LodExtrasKey.Levels]) ? (lods[LodExtrasKey.Levels] as unknown[]).length : 0;
    levels = Math.max(levels, chain);
  }
  return 1 + levels;
}

/** The facts of the rigged GLB `bytes`, or null for a file with no skinned mesh node or one this cannot read. */
export function characterFacts(bytes: Uint8Array): CharacterFacts | null {
  let doc: PackDoc;
  try {
    const { json, bin } = readGlb(bytes);
    doc = { json, bin, data: new Map() };
  } catch {
    return null;
  }
  const skeleton = skeletonOf(doc.json);
  if (!skeleton || skeleton.order.length > CHARACTER_JOINTS_MAX) return null;
  const { coverage, hips } = humanoidMap(skeleton.names);
  const roots = skeleton.order.filter((node) => !skeleton.order.includes(skeleton.parents[node] ?? NO_NODE));
  const hipsNode = hips === null ? null : (skeleton.order[hips] ?? null);
  const movers = new Set([...roots, ...(hipsNode === null ? [] : [hipsNode])]);
  const height = rigHeight(nodeList(doc.json), skeleton, hips);
  const clips = clipsOf(doc, skeleton, movers, height);
  const listed = clips
    .filter((clip) => clip.name.length <= CHARACTER_CLIP_NAME_MAX_CHARS)
    .slice(0, CHARACTER_CLIPS_MAX);
  return {
    joints: skeleton.order.length,
    clips: listed,
    clipCount: clips.length,
    humanoid: coverage,
    skinnedLevels: skinnedLevels(doc.json, skeleton.meshNode),
  };
}

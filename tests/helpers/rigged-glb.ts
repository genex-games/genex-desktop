/** A skinned humanoid GLB built in memory: a skinned triangle on the Godot-named humanoid joints, for the character gate. */
import { glb } from "./glb.ts";

type Vec3 = [number, number, number];
export interface RiggedClip {
  name: string;
  seconds?: number;
}
export interface RiggedOptions {
  /** Degrees each arm sits from hanging straight down at rest: 90 is a T-pose, 45 an A-pose. */
  armDrop?: number;
  /** Joint names to leave out. */
  without?: readonly string[];
  /** Hips height above the feet, metres. */
  hips?: number;
  clips?: readonly RiggedClip[];
  /** Skin the triangle; false leaves a rig nothing is bound to. */
  skinned?: boolean;
}

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;

const f32 = (values: number[]) => new Uint8Array(Float32Array.from(values).buffer);

/** The arm's direction at `drop` degrees from hanging straight down: 90 is a T-pose, 45 an A-pose. */
const armDirection = (drop: number): Vec3 => [Math.sin((drop * Math.PI) / 180), -Math.cos((drop * Math.PI) / 180), 0];

function joints(armDrop: number, hips: number): Array<[string, string | null, Vec3]> {
  const [ax, ay] = armDirection(armDrop);
  const side = (name: "Left" | "Right", sign: 1 | -1): Array<[string, string | null, Vec3]> => [
    [`${name}Shoulder`, "UpperChest", [0.05 * sign, 0.1, 0]],
    [`${name}UpperArm`, `${name}Shoulder`, [0.1 * sign, 0, 0]],
    [`${name}LowerArm`, `${name}UpperArm`, [0.28 * ax * sign, 0.28 * ay, 0]],
    [`${name}Hand`, `${name}LowerArm`, [0.26 * ax * sign, 0.26 * ay, 0]],
    [`${name}UpperLeg`, "Hips", [0.1 * sign, -0.05, 0]],
    [`${name}LowerLeg`, `${name}UpperLeg`, [0, -(hips - 0.1) / 2, 0]],
    [`${name}Foot`, `${name}LowerLeg`, [0, -(hips - 0.1) / 2, 0]],
    [`${name}Toes`, `${name}Foot`, [0, -0.05, 0.12]],
  ];
  return [
    ["Hips", null, [0, hips, 0]],
    ["Spine", "Hips", [0, 0.1, 0]],
    ["Chest", "Spine", [0, 0.15, 0]],
    ["UpperChest", "Chest", [0, 0.15, 0]],
    ["Neck", "UpperChest", [0, 0.1, 0]],
    ["Head", "Neck", [0, 0.1, 0]],
    ...side("Left", 1),
    ...side("Right", -1),
  ];
}

/** A skinned humanoid with the given clips (each turns the hips) as GLB bytes. */
export function riggedCharacter(options: RiggedOptions = {}): Uint8Array {
  const all = joints(options.armDrop ?? 45, options.hips ?? 0.95);
  const kept = all.filter(([name]) => !options.without?.includes(name));
  const nodes: Array<Record<string, unknown>> = kept.map(([name, , translation]) => ({ name, translation }));
  for (const [at, [, parent]] of kept.entries()) {
    const owner = parent === null ? undefined : kept.findIndex(([name]) => name === parent);
    if (owner === undefined || owner < 0) continue;
    const parentNode = nodes[owner] as { children?: number[] };
    parentNode.children = [...(parentNode.children ?? []), at];
  }
  const skinned = options.skinned ?? true;
  const meshNode = nodes.push({ name: "body", mesh: 0, ...(skinned ? { skin: 0 } : {}) }) - 1;
  const parts: Uint8Array[] = [];
  const views: Array<Record<string, number>> = [];
  let length = 0;
  const view = (bytes: Uint8Array) => {
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.byteLength });
    parts.push(bytes);
    length += bytes.byteLength;
    const pad = (4 - (length % 4)) % 4;
    parts.push(new Uint8Array(pad));
    length += pad;
    return views.length - 1;
  };
  const accessors: Array<Record<string, unknown>> = [];
  const accessor = (fields: Record<string, unknown>) => accessors.push(fields) - 1;
  const position = accessor({
    bufferView: view(f32([0, 0, 0, 1, 0, 0, 0, 1, 0])),
    componentType: FLOAT,
    count: 3,
    type: "VEC3",
    min: [0, 0, 0],
    max: [1, 1, 0],
  });
  const attributes: Record<string, number> = { POSITION: position };
  if (skinned) {
    attributes.JOINTS_0 = accessor({
      bufferView: view(new Uint8Array(12)),
      componentType: UNSIGNED_BYTE,
      count: 3,
      type: "VEC4",
    });
    attributes.WEIGHTS_0 = accessor({
      bufferView: view(f32([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])),
      componentType: FLOAT,
      count: 3,
      type: "VEC4",
    });
  }
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const ibm = accessor({
    bufferView: view(f32(kept.flatMap(() => identity))),
    componentType: FLOAT,
    count: kept.length,
    type: "MAT4",
  });
  const animations = (options.clips ?? []).map((clip) => {
    const seconds = clip.seconds ?? 1;
    const input = accessor({
      bufferView: view(f32([0, seconds])),
      componentType: FLOAT,
      count: 2,
      type: "SCALAR",
      min: [0],
      max: [seconds],
    });
    const output = accessor({
      bufferView: view(f32([0, 0, 0, 1, 0, 0, 0, 1])),
      componentType: FLOAT,
      count: 2,
      type: "VEC4",
    });
    return {
      name: clip.name,
      samplers: [{ input, output }],
      channels: [{ sampler: 0, target: { node: 0, path: "rotation" } }],
    };
  });
  const bin = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    bin.set(part, at);
    at += part.byteLength;
  }
  return new Uint8Array(
    glb(
      {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0, meshNode] }],
        nodes,
        meshes: [{ primitives: [{ attributes }] }],
        ...(skinned ? { skins: [{ joints: kept.map((_, i) => i), inverseBindMatrices: ibm }] } : {}),
        animations,
        accessors,
        bufferViews: views,
        buffers: [{ byteLength: length }],
      },
      bin,
    ),
  );
}

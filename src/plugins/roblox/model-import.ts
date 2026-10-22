/**
 * The Roblox Studio plugin's model tools over the asset gate (`asset-gate.ts`, decision 15).
 *
 * - `check-model` (no card): what a `.glb` or `.gltf` in the game folder fails on, in plain words.
 * - `import-model` (the person approves each call on a card): the gate runs first, and only a model
 *   that passes reaches the Genex helper's `model.import`, as the helper's own mesh (`GXM1`: positions,
 *   normals, UVs and triangles) converted from glTF's metres to studs. The helper builds it in Studio
 *   as an anchored MeshPart; it is uploaded to the person's Roblox account only when they publish the
 *   place. Studio's change runs under the agent's busy mark, so the Studio lock doesn't read it as the
 *   person's.
 * - When Studio can't add it, the answer names the checked file and Studio's own click path
 *   (File › Import 3D). Genex never uploads a model any other way.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { agentBusyMarker } from "./agent-marks.ts";
import {
  type CheckedMesh,
  checkModel,
  type GateOptions,
  MAX_TEXTURE_SIDE,
  type ModelCheck,
  type ModelProblem,
  ModelRefusal,
} from "./asset-gate.ts";
import { type HelperAsk, HelperLinkError, HelperLinkFailure } from "./helper-link.ts";
import { HelperMessage, MODEL_MAGIC, MODEL_PART } from "./helper-protocol.ts";

/** glTF is in metres; a Roblox stud is 0.28 m. */
export const STUDS_PER_METRE = 1 / 0.28;
/** How long Studio has to build the mesh once it has arrived. */
export const MODEL_IMPORT_MAX_MS = 60 * SECOND_MS;
/** The smallest texture side a check may be asked to hold. */
const MIN_TEXTURE_SIDE = 16;
/** The longest name the part gets (the helper's own limit). */
const MAX_NAME_CHARS = 100;
/** Bytes of the mesh header, and per vertex and per triangle. */
const MESH_HEADER_BYTES = 12;
const VERTEX_BYTES = 32;
const TRIANGLE_BYTES = 12;
/** Studio's own way to bring a model in, for the person. */
export const IMPORT_CLICK_PATH = "File › Import 3D";

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
const CONTROL = /[\u0000-\u001f\u007f]/;

const fmt = (value: number) => value.toLocaleString("en-US");
const studs = (value: number) => String(Number(value.toFixed(1)));

const MESSAGE = {
  file: "file must be the model's path in the game folder, such as models/chair.glb.",
  name: `name must be one line of at most ${MAX_NAME_CHARS} characters.`,
  textureSide: `textureSide must be a whole number from ${MIN_TEXTURE_SIDE} to ${MAX_TEXTURE_SIDE}.`,
  noFolder: "This call has no game folder to read the model from.",
  failed: (file: string, problems: string[]) =>
    `${file} doesn't pass:\n${problems.map((one) => `- ${one}`).join("\n")}`,
  passed: (check: ModelCheck) => {
    const textures = check.textures.map((one) => `${one.name} ${one.width} by ${one.height}`);
    const pictures = textures.length ? `; textures ${textures.join(", ")}` : "";
    return `${check.file} passes: ${fmt(check.triangles)} triangles, one material, closed, its root at the origin${pictures}. import-model adds it to the place.`;
  },
  notConnected:
    "The Genex helper in Roblox Studio isn't connected for this game: open the game's place in Studio (the Roblox Studio button), then try again.",
  imported: (name: string, instance: string, check: ModelCheck, size: number[]) =>
    `Added "${name}" to the place as ${instance}: ${fmt(check.triangles)} triangles, about ${size.map(studs).join(" × ")} studs, anchored at the origin. Only its shape came in: give it a SurfaceAppearance for its textures. It is uploaded to the person's Roblox account when they publish the place.`,
  notImported: (file: string, why: string) =>
    `Studio didn't add the model: ${why} ${file} passed Genex's checks, so the person can add it themselves with ${IMPORT_CLICK_PATH} in Studio and pick ${file} in the game folder.`,
} as const;

/** The game an import is for: its folder, its helper and the agent's marks. */
export interface ImportGame {
  folder?: string;
  ask: HelperAsk;
  /** The Studio the game's helper is connected from now. */
  bound(): string | undefined;
  marks?: string;
}

/** What the tools work with; tests hand in a clock and the gate's options. */
export interface ImportDeps {
  now(): number;
  gate?: Pick<GateOptions, "open">;
}

/** What `check-model` answers. */
export interface CheckAnswer {
  passed: boolean;
  message: string;
  refused?: ModelRefusal;
  problems?: ModelProblem[];
  triangles?: number;
  textures?: ModelCheck["textures"];
}

/** What `import-model` answers. */
export interface ImportAnswer {
  done: boolean;
  message: string;
  problems?: ModelProblem[];
  /** Studio's own way, when Studio couldn't add a model that passed. */
  clickPath?: string;
  result?: { instance: string; triangles: number };
}

class BadArgument extends Error {}
const bad = (message: string): never => {
  throw new BadArgument(message);
};

const fileArg = (args: Record<string, unknown>) =>
  typeof args.file === "string" && args.file.length > 0 ? args.file : bad(MESSAGE.file);

function textureSideArg(args: Record<string, unknown>): number | undefined {
  const side = args.textureSide;
  if (side === undefined) return undefined;
  const ok = typeof side === "number" && Number.isInteger(side) && side >= MIN_TEXTURE_SIDE && side <= MAX_TEXTURE_SIDE;
  return ok ? side : bad(MESSAGE.textureSide);
}

/** The part's name: as asked, else the file's own name. */
function nameArg(args: Record<string, unknown>, file: string): string {
  const name = args.name;
  if (name === undefined) {
    const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.(glb|gltf)$/i, "");
    return base.slice(0, MAX_NAME_CHARS) || "Model";
  }
  const ok = typeof name === "string" && name.trim().length > 0 && name.length <= MAX_NAME_CHARS && !CONTROL.test(name);
  return ok ? name : bad(MESSAGE.name);
}

/** Runs `work` over checked arguments; a bad argument becomes its plain words. */
async function withArgs<T>(work: () => Promise<T>, refused: (message: string) => T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BadArgument) return refused(error.message);
    throw error;
  }
}

/** `check-model`: the gate's verdict on one model in the game folder. */
export function checkModelTool(
  args: Record<string, unknown>,
  folder: string | undefined,
  options: Pick<GateOptions, "open"> = {},
): Promise<CheckAnswer> {
  return withArgs<CheckAnswer>(
    async () => {
      const file = fileArg(args);
      const textureSide = textureSideArg(args);
      if (!folder) return bad(MESSAGE.noFolder);
      const answer = await checkModel(folder, file, { ...options, ...(textureSide ? { textureSide } : {}) });
      if (!answer.ok) return { passed: false, message: answer.message, refused: answer.refusal };
      const { check } = answer;
      const message = check.passed
        ? MESSAGE.passed(check)
        : MESSAGE.failed(
            check.file,
            check.problems.map((one) => one.message),
          );
      return {
        passed: check.passed,
        message,
        problems: check.problems.map((one) => one.problem),
        triangles: check.triangles,
        textures: check.textures,
      };
    },
    (message) => ({ passed: false, message, refused: ModelRefusal.Arguments }),
  );
}

const item = (values: ArrayLike<number>, at: number) => values[at] ?? 0;

/** A triangle's face normal, scaled by twice its area. */
function faceNormal(positions: Float32Array, a: number, b: number, c: number): number[] {
  const edge = (to: number) => [0, 1, 2].map((axis) => item(positions, to * 3 + axis) - item(positions, a * 3 + axis));
  const [ux, uy, uz] = edge(b) as [number, number, number];
  const [vx, vy, vz] = edge(c) as [number, number, number];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** Face-weighted vertex normals, for a model exported without its own. */
function faceNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let corner = 0; corner < indices.length; corner += 3) {
    const triangle = [item(indices, corner), item(indices, corner + 1), item(indices, corner + 2)];
    const face = faceNormal(positions, ...(triangle as [number, number, number]));
    for (const vertex of triangle)
      for (let axis = 0; axis < 3; axis++)
        normals[vertex * 3 + axis] = item(normals, vertex * 3 + axis) + item(face, axis);
  }
  for (let vertex = 0; vertex < normals.length; vertex += 3) {
    const length = Math.hypot(item(normals, vertex), item(normals, vertex + 1), item(normals, vertex + 2)) || 1;
    for (let axis = 0; axis < 3; axis++) normals[vertex + axis] = item(normals, vertex + axis) / length;
  }
  return normals;
}

/**
 * The helper's mesh (`GXM1`, little-endian) of a checked mesh, in studs: only the vertices a triangle
 * uses, each with its position, normal and UV.
 */
export function encodeMesh(mesh: CheckedMesh): Uint8Array {
  const normals = mesh.normals ?? faceNormals(mesh.positions, mesh.indices);
  const used = new Map<number, number>();
  for (const vertex of mesh.indices) if (!used.has(vertex)) used.set(vertex, used.size);
  const triangles = mesh.indices.length / 3;
  const bytes = Buffer.alloc(MESH_HEADER_BYTES + used.size * VERTEX_BYTES + triangles * TRIANGLE_BYTES);
  bytes.write(MODEL_MAGIC, 0, "latin1");
  bytes.writeUInt32LE(used.size, 4);
  bytes.writeUInt32LE(triangles, 8);
  const normalsAt = MESH_HEADER_BYTES + used.size * 12;
  const uvsAt = normalsAt + used.size * 12;
  const trianglesAt = uvsAt + used.size * 8;
  for (const [vertex, slot] of used) {
    for (let axis = 0; axis < 3; axis++) {
      bytes.writeFloatLE(
        (mesh.positions[vertex * 3 + axis] ?? 0) * STUDS_PER_METRE,
        MESH_HEADER_BYTES + slot * 12 + axis * 4,
      );
      bytes.writeFloatLE(normals[vertex * 3 + axis] ?? 0, normalsAt + slot * 12 + axis * 4);
    }
    for (let axis = 0; axis < 2; axis++)
      bytes.writeFloatLE(mesh.uvs?.[vertex * 2 + axis] ?? 0, uvsAt + slot * 8 + axis * 4);
  }
  mesh.indices.forEach((vertex, corner) => {
    bytes.writeUInt32LE(used.get(vertex) ?? 0, trianglesAt + corner * 4);
  });
  return bytes;
}

/** Why Studio didn't add it, in words: the helper's own, or what became of the link. */
function whyNot(error: unknown): string {
  if (error instanceof HelperLinkError) return error.message;
  return "the Genex helper in Studio didn't answer.";
}

/** The model sent to the game's helper, under the agent's busy mark; Studio's refusal names the click path. */
async function sendToStudio(deps: ImportDeps, game: ImportGame, file: string, name: string, check: ModelCheck) {
  const mesh = check.mesh as CheckedMesh;
  const data = encodeMesh(mesh);
  const send = () =>
    game.ask(
      HelperMessage.ModelImport,
      { name, bytes: data.length },
      { timeoutMs: MODEL_IMPORT_MAX_MS, upload: [{ part: MODEL_PART, data }] },
    );
  try {
    const answer = game.marks ? await agentBusyMarker(game.marks, deps.now).around(send) : await send();
    const size = (check.size ?? [0, 0, 0]).map((value) => value * STUDS_PER_METRE);
    return {
      done: true,
      message: MESSAGE.imported(name, answer.instance, check, size),
      result: { instance: answer.instance, triangles: check.triangles },
    };
  } catch (error) {
    const notBound = error instanceof HelperLinkError && error.code === HelperLinkFailure.NotBound;
    if (notBound) return { done: false, message: MESSAGE.notConnected };
    return { done: false, message: MESSAGE.notImported(file, whyNot(error)), clickPath: IMPORT_CLICK_PATH };
  }
}

/** `import-model`: the gate, then the helper's `model.import` for a model that passes, and nothing else. */
export function importModel(deps: ImportDeps, args: Record<string, unknown>, game: ImportGame): Promise<ImportAnswer> {
  return withArgs(
    async (): Promise<ImportAnswer> => {
      const file = fileArg(args);
      const name = nameArg(args, file);
      if (!game.folder) return bad(MESSAGE.noFolder);
      const answer = await checkModel(game.folder, file, deps.gate ?? {});
      if (!answer.ok) return { done: false, message: answer.message };
      const { check } = answer;
      if (!check.passed || !check.mesh)
        return {
          done: false,
          message: MESSAGE.failed(
            file,
            check.problems.map((one) => one.message),
          ),
          problems: check.problems.map((one) => one.problem),
        };
      if (game.bound() === undefined) return { done: false, message: MESSAGE.notConnected };
      return sendToStudio(deps, game, file, name, check);
    },
    (message) => ({ done: false, message }),
  );
}

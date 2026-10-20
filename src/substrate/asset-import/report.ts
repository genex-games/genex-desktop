/**
 * The validation report (game systems C-23): checks of a GLB the import step wrote that refuse
 * nothing and reach an agent as `ProjectAsset.import.issues`, by code (`ImportIssueCode`), never
 * text. Each issue's detail names the part (a material's JSON pointer) or the numbers.
 *
 * - An untextured material's base colour outside the range real surfaces have, as sRGB luminance:
 *   30-240 for a dielectric, 180-255 for a metal (the ranges of Allegorithmic's "PBR Guide",
 *   which the Physically Based database's measured albedos fall inside).
 * - An untextured material that is part metal (metallic strictly between 0 and 1).
 * - An index of refraction (`KHR_materials_ior`) outside 1.0-3.0.
 * - More triangles than the model's class's budget ({@link TRIANGLE_BUDGETS}, owner-tunable):
 *   a skinned model is a character, anything else a model.
 *
 * A file the report cannot read reports nothing: the validator owns damaged files. The output is a
 * pure function of the input.
 */
import { type ImportIssue, ImportIssueCode } from "../../shared/asset-db.ts";
import { readGlb } from "./glb.ts";
import { extension, index, isObject, type Json, objects } from "./gltf-json.ts";
import { inspectGlb } from "./inspect.ts";

/** A model's class for its triangle budget. */
export interface TriangleBudgets {
  /** A model with a skinned mesh node. */
  character: number;
  /** Any other model. */
  model: number;
}

/**
 * Triangles per class, before import-time LODs: a hero character of an AA game, and a large prop
 * or building (owner-tunable; a level is many models, each with its own budget).
 */
export const TRIANGLE_BUDGETS: TriangleBudgets = { character: 100_000, model: 250_000 };

/** A dielectric's base colour, as sRGB luminance 0-255. */
const DIELECTRIC_LUMINANCE = { min: 30, max: 240 } as const;
/** A metal's base colour (its reflectance), as sRGB luminance 0-255. */
const METAL_LUMINANCE = { min: 180, max: 255 } as const;
/** A metallic factor this close to 0 or 1 is that value (an 8-bit export of either). */
const METALLIC_EPSILON = 1 / 255;
/** The indices of refraction of real materials (air 1.0 to diamond 2.42, a margin above). */
const IOR_RANGE = { min: 1, max: 3 } as const;
/** Rec. 709 luminance weights of linear RGB. */
const LUMA = [0.2126, 0.7152, 0.0722] as const;
const SRGB_MAX = 255;
/** glTF's default base colour factor and metallic factor (glTF 2.0 §5.19). */
const DEFAULT_BASE_COLOR = [1, 1, 1, 1] as const;
const DEFAULT_METALLIC = 1;
const IOR_EXTENSION = "KHR_materials_ior";

/** Linear 0-1 to sRGB-encoded 0-255 (IEC 61966-2-1). */
function toSrgb255(linear: number): number {
  const clamped = Math.min(Math.max(linear, 0), 1);
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return encoded * SRGB_MAX;
}

const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** A base colour factor's sRGB luminance, 0-255. */
function luminance(factor: unknown): number {
  const rgb = Array.isArray(factor) ? factor : DEFAULT_BASE_COLOR;
  const linear = LUMA.reduce((sum, weight, at) => sum + weight * finite(rgb[at], 1), 0);
  return toSrgb255(linear);
}

/** One material's issues, its pointer as their detail. */
function materialIssues(material: Json, at: number): ImportIssue[] {
  const detail = `/materials/${at}`;
  const pbr = isObject(material.pbrMetallicRoughness) ? material.pbrMetallicRoughness : {};
  const metallic = finite(pbr.metallicFactor, DEFAULT_METALLIC);
  const metallicMapped = pbr.metallicRoughnessTexture !== undefined;
  const issues: ImportIssue[] = [];
  if (pbr.baseColorTexture === undefined) {
    const range = metallic >= 1 - METALLIC_EPSILON ? METAL_LUMINANCE : DIELECTRIC_LUMINANCE;
    const lum = luminance(pbr.baseColorFactor);
    if (lum < range.min || lum > range.max) issues.push({ code: ImportIssueCode.AlbedoOutOfRange, detail });
  }
  const partial = metallic > METALLIC_EPSILON && metallic < 1 - METALLIC_EPSILON;
  if (partial && !metallicMapped) issues.push({ code: ImportIssueCode.MetallicPartial, detail });
  const ior = extension(material, IOR_EXTENSION)?.ior;
  if (typeof ior === "number" && (ior < IOR_RANGE.min || ior > IOR_RANGE.max)) {
    issues.push({ code: ImportIssueCode.IorOutOfRange, detail });
  }
  return issues;
}

/** Whether any node draws a mesh through a skin. */
const hasSkinnedMesh = (json: Json): boolean =>
  objects(json.nodes).some((node) => index(node.mesh) !== null && index(node.skin) !== null);

/** The report of the GLB `bytes`, in material order, then the triangle budget; empty when it cannot be read. */
export function reportGlb(bytes: Uint8Array, budgets: TriangleBudgets = TRIANGLE_BUDGETS): ImportIssue[] {
  let json: Json;
  try {
    json = readGlb(bytes).json;
  } catch {
    return [];
  }
  const issues = objects(json.materials).flatMap(materialIssues);
  const triangles = inspectGlb(bytes)?.triangles ?? 0;
  const budget = hasSkinnedMesh(json) ? budgets.character : budgets.model;
  if (triangles > budget) issues.push({ code: ImportIssueCode.TrianglesOverBudget, detail: `${triangles}/${budget}` });
  return issues;
}

/** The most report issues one receipt line keeps: a file can have thousands of materials. */
export const IMPORT_REPORT_MAX = 64;
/** The longest detail a report issue has: a material's pointer or two counts. */
const REPORT_DETAIL_MAX_CHARS = 64;
/** The codes this report writes; the validator's and the lock's are not a report's. */
const REPORT_CODES: readonly string[] = [
  ImportIssueCode.AlbedoOutOfRange,
  ImportIssueCode.MetallicPartial,
  ImportIssueCode.IorOutOfRange,
  ImportIssueCode.TrianglesOverBudget,
];

/** A receipt's report: at most {@link IMPORT_REPORT_MAX} issues, each a report code and a short detail; null when one is bad. */
export function parseReport(value: unknown): ImportIssue[] | null {
  if (!Array.isArray(value) || value.length > IMPORT_REPORT_MAX) return null;
  const issues: ImportIssue[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.code !== "string" || !REPORT_CODES.includes(item.code)) return null;
    const { detail } = item;
    if (detail !== undefined && (typeof detail !== "string" || detail.length > REPORT_DETAIL_MAX_CHARS)) return null;
    issues.push({ code: item.code as ImportIssueCode, ...(detail === undefined ? {} : { detail }) });
  }
  return issues;
}

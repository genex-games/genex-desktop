/**
 * The provenance audit: every draw tag the art pass plans is followed to the model file the engine
 * draws it from, that file's row in `genex-assets.lock` and what the file holds, and compared with
 * the source and tier the plan named. A tag delivered from a lesser source is
 * `[art-source-mismatch]`, a look blocker. Gen3 planned the yard and delivered seven benches, four
 * bins and every birch as box and cone bpy scripts with no normal map; nothing compared the two.
 *
 * A file the engine names is the build's own output: it is read only when it resolves, links
 * followed, inside the game folder.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { AnyRecord } from "../types/harness.d.ts";
import { ArtSource, LookBlocker, runArtPass, type ArtAsset } from "./look-bar.ts";
import { ArtKind } from "./art-kinds.ts";
import { lookFactsOf } from "./look-facts.ts";

/** The lock the host writes beside `genex.toml` (shared/asset-db.ts `ASSET_LOCK_FILE`). */
export const ASSET_LOCK_FILE = "genex-assets.lock";
/** The largest model file the audit reads to see its materials. */
const MAX_MODEL_BYTES = 64 * 1024 * 1024;
/** A GLB's magic, its JSON chunk's type and the header sizes. */
const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_HEADER_BYTES = 12;
const GLB_CHUNK_HEADER_BYTES = 8;

/** Where a lock row says a file came from (shared/asset-db.ts `AssetOrigin`, the values the audit reads). */
const Origin = {
  Cc0: "cc0",
  Genex: "genex",
  Blender: "blender",
} as const;

/** How far up the ladder a delivered model sits: code-built, a textured kit, an authored or scanned model. */
export const SourceRank = {
  Code: 0,
  Kit: 1,
  Model: 2,
} as const;
export type SourceRank = (typeof SourceRank)[keyof typeof SourceRank];

/** The rank a planned source asks for; null for a source that plans a surface, not a model. */
const PLANNED_RANK: Record<ArtSource, SourceRank | null> = {
  [ArtSource.GenexModel]: SourceRank.Model,
  [ArtSource.GenexCharacter]: SourceRank.Model,
  [ArtSource.Cc0Model]: SourceRank.Model,
  [ArtSource.BlenderKit]: SourceRank.Kit,
  [ArtSource.Code]: SourceRank.Code,
  [ArtSource.Scan]: null,
  [ArtSource.GenexTexture]: null,
};

/** The kinds the audit follows: a surface or a sky has no model to follow. */
const MODEL_KINDS: ReadonlySet<string> = new Set([ArtKind.Prop, ArtKind.Organic, ArtKind.Structure, ArtKind.Character]);

/** What a model file holds, as far as the audit needs. */
export interface ModelFacts {
  images: number;
  /** Materials that carry a normal map. */
  normalMaps: number;
  materials: number;
}

/** A GLB's materials and images, or null when the bytes are no GLB. */
export function glbFacts(bytes: Uint8Array): ModelFacts | null {
  if (bytes.byteLength < GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) return null;
  const length = view.getUint32(GLB_HEADER_BYTES, true);
  const type = view.getUint32(GLB_HEADER_BYTES + 4, true);
  const start = GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES;
  if (type !== GLB_JSON_CHUNK || start + length > bytes.byteLength) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + length))) as AnyRecord;
    const materials = Array.isArray(json.materials) ? (json.materials as AnyRecord[]) : [];
    return {
      images: Array.isArray(json.images) ? json.images.length : 0,
      normalMaps: materials.filter((material) => material?.normalTexture).length,
      materials: materials.length,
    };
  } catch {
    return null;
  }
}

/** One lock row as the audit reads it. */
interface LockRow {
  path: string;
  origin: string;
}

/** The lock's rows by path, from its text; none when it is no lock. */
export function lockRows(text: string | null): Map<string, LockRow> {
  const rows = new Map<string, LockRow>();
  if (!text) return rows;
  try {
    const lock = JSON.parse(text) as AnyRecord;
    for (const entry of Array.isArray(lock.entries) ? (lock.entries as AnyRecord[]) : []) {
      if (typeof entry?.path === "string" && typeof entry.origin === "string")
        rows.set(entry.path, { path: entry.path, origin: entry.origin });
    }
  } catch {
    /* an unreadable lock has no rows: every file is unproven */
  }
  return rows;
}

/** What one delivered model is: where its lock row says it came from, and what it holds. */
export interface Delivered {
  model: string;
  origin: string | null;
  facts: ModelFacts | null;
  /** The engine reports every mesh under the tag as an untouched primitive. */
  primitiveOnly: boolean;
}

/**
 * The rank a delivered model earns. A Blender file with no normal map, or one the engine reports
 * as untouched primitives, is a box script: it counts as code, whatever folder it lands in.
 */
export function deliveredRank(delivered: Delivered): SourceRank {
  if (delivered.primitiveOnly) return SourceRank.Code;
  if (delivered.origin === Origin.Genex || delivered.origin === Origin.Cc0) return SourceRank.Model;
  const textured = (delivered.facts?.normalMaps ?? 0) > 0;
  if (delivered.origin === Origin.Blender && textured) return SourceRank.Kit;
  return SourceRank.Code;
}

/** What a rank is called in a defect. */
const RANK_WORDS: Record<SourceRank, string> = {
  [SourceRank.Code]: "code-built or an untextured box script",
  [SourceRank.Kit]: "a textured Blender kit",
  [SourceRank.Model]: "a generated or CC0 model",
};

/** The defect one mismatched tag is. */
function mismatchText(asset: ArtAsset, tag: string, delivered: Delivered): string {
  const rank = deliveredRank(delivered);
  return `[${LookBlocker.ArtSourceMismatch}] ${tag}: the art pass plans ${asset.asset} as ${asset.source} (${asset.tier}), and it is drawn from ${RANK_WORDS[rank]} (${delivered.model}) — provenance audit`;
}

/** Everything the audit compares, already read. */
export interface ProvenanceInput {
  assets: readonly ArtAsset[];
  /** The model each draw tag is drawn from, and whether the engine calls it primitive-only. */
  drawn: ReadonlyMap<string, { model: string | null; primitiveOnly: boolean }>;
  lock: ReadonlyMap<string, LockRow>;
  models: ReadonlyMap<string, ModelFacts | null>;
}

/**
 * The tags delivered from a lesser source than the art pass planned, as `[art-source-mismatch]`
 * defects. A planned tag the frame does not draw, or draws with no model named, is not judged here.
 */
export function provenanceMismatches(input: ProvenanceInput): string[] {
  return input.assets.flatMap((asset) => assetMismatches(asset, input));
}

/** One planned asset's tags drawn from a lesser source than it names. */
function assetMismatches(asset: ArtAsset, { drawn, lock, models }: ProvenanceInput): string[] {
  const planned = PLANNED_RANK[asset.source];
  const followed = planned !== null && planned !== SourceRank.Code && MODEL_KINDS.has(asset.kind ?? "");
  if (!followed) return [];
  const out: string[] = [];
  for (const tag of asset.tags ?? []) {
    const draw = drawn.get(tag);
    if (!draw?.model) continue;
    const delivered: Delivered = {
      model: draw.model,
      origin: lock.get(draw.model)?.origin ?? null,
      facts: models.get(draw.model) ?? null,
      primitiveOnly: draw.primitiveOnly,
    };
    if (deliveredRank(delivered) < planned) out.push(mismatchText(asset, tag, delivered));
  }
  return out;
}

/** The real path of `relative` when it lies inside `root` (links followed), else null. */
async function insideRoot(root: string, relative: string): Promise<string | null> {
  if (!relative || path.isAbsolute(relative) || relative.includes("\0")) return null;
  try {
    const realRoot = await realpath(root);
    const real = await realpath(path.resolve(realRoot, relative));
    const rel = path.relative(realRoot, real);
    const escapes = rel.split(path.sep)[0] === ".." || path.isAbsolute(rel);
    return rel && !escapes ? real : null;
  } catch {
    return null;
  }
}

/** A text file inside the game folder, or null. */
async function readInside(root: string, relative: string): Promise<string | null> {
  const real = await insideRoot(root, relative);
  return real ? readFile(real, "utf8").catch(() => null) : null;
}

/** A model file's facts, when it lies inside the game folder and is small enough to read. */
async function modelFactsAt(root: string, relative: string): Promise<ModelFacts | null> {
  const real = await insideRoot(root, relative);
  if (!real) return null;
  const bytes = await readFile(real).catch(() => null);
  if (!bytes || bytes.byteLength > MAX_MODEL_BYTES) return null;
  return glbFacts(bytes);
}

/**
 * The audit of one build: its art pass (`run.art`), the look facts its state reports (the model
 * per tag), the lock and the model files under `root`. Empty for a run with no art pass, a build
 * that reports no look facts, or no folder to read.
 */
export async function auditProvenance(
  run: { readonly [field: string]: unknown } | null | undefined,
  state: AnyRecord | null | undefined,
  root: string | null,
): Promise<string[]> {
  const art = runArtPass(run);
  const facts = lookFactsOf(state);
  if (!art || !facts || !root) return [];
  const drawn = new Map(
    Object.entries(facts.tags).map(([tag, look]) => [
      tag,
      { model: look.models[0] ?? null, primitiveOnly: look.primitiveOnly },
    ]),
  );
  const lock = lockRows(await readInside(root, ASSET_LOCK_FILE));
  const models = new Map<string, ModelFacts | null>();
  for (const { model } of drawn.values()) {
    if (model && !models.has(model)) models.set(model, await modelFactsAt(root, model));
  }
  return provenanceMismatches({ assets: art.assets, drawn, lock, models });
}

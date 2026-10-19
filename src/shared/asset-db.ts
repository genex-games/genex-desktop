/**
 * The asset database's shapes: `genex-assets.lock`, which sits beside a Rust game's `genex.toml`
 * and is committed with it. The host alone writes it, like a cargo lock: one row per source asset
 * (a stable id, where it came from, its licence, how it was imported and what that wrote) and one
 * `derived` row per baked output (a navmesh, an impostor atlas) with the inputs it was baked from.
 * Types and vocabularies only; `src/main/asset-db.ts` reads and writes the file. Browser-safe.
 */
import type { AssetKind } from "./game-assets.ts";
import type { BakeKind } from "./native-contract.ts";

/** The lock file's name, beside `genex.toml`. */
export const ASSET_LOCK_FILE = "genex-assets.lock";
/** The lock format this host writes; a lock of another version is rewritten from the files. */
export const ASSET_LOCK_VERSION = 1;

/** Where a source asset came from. Wire values in the lock: never rename one. */
export const AssetOrigin = {
  /** A CC0 library fetch (Poly Haven, ambientCG, a curated pack). */
  Cc0: "cc0",
  /** A Genex asset job (its file `role` is the job record's). */
  Genex: "genex",
  /** A model Blender wrote. */
  Blender: "blender",
  /** A plugin's `assets.deliver`. */
  Delivered: "delivered",
  /** An agent wrote the file itself. */
  Agent: "agent",
  /** The person added it. */
  Person: "person",
} as const;
export type AssetOrigin = (typeof AssetOrigin)[keyof typeof AssetOrigin];

/** A source asset's licence as the lock records it. Wire values: never rename one. */
export const AssetLicence = {
  Cc0: "CC0-1.0",
  /** Made by a generator for this game. */
  Generated: "Generated",
  /** The person's own work. */
  Owned: "Owned",
  /** Nothing says. */
  Unknown: "Unknown",
} as const;
export type AssetLicence = (typeof AssetLicence)[keyof typeof AssetLicence];

/** What decided a texture's usage, strongest first. Wire values: never rename one. */
export const TextureUsageSource = {
  /** A `[[texture]]` row of `genex.toml`. */
  Toml: "toml",
  /** The material slot a GLB samples it from. */
  MaterialSlot: "material-slot",
  /** The asset's provenance (a Genex texture job's role, a CC0 row's map). */
  Provenance: "provenance",
  /** The kind a Live run observed the game sample it as (__render.textures), as the lock recorded it (owner call C1: never the pixels or the name). */
  Observed: "observed",
} as const;
export type TextureUsageSource = (typeof TextureUsageSource)[keyof typeof TextureUsageSource];

/**
 * Something the import step noticed about a file that did not refuse it. Codes, never text: an
 * agent reads the code, and the detail only says which part. Wire values: never rename one.
 */
export const ImportIssueCode = {
  /** The lock's own digest did not match its body: someone edited it, and it was rewritten from the files. */
  LockEdited: "lock-edited",
  /** Nothing said how a texture is used, so it ships as the source image, not encoded. */
  UsageUnknown: "usage-unknown",
  /** Two sources disagreed about a texture's usage; the stronger one won. */
  UsageConflict: "usage-conflict",
  /** A texture was resampled to fit its size class. */
  Resampled: "resampled",
  /** The glTF validator warned about the file (its first codes are in the detail). */
  ValidationWarning: "validation-warning",
} as const;
export type ImportIssueCode = (typeof ImportIssueCode)[keyof typeof ImportIssueCode];

/** One issue on a lock row. */
export interface ImportIssue {
  code: ImportIssueCode;
  /** Which part of the file (a validator code, a material slot); never the meaning. */
  detail?: string;
}

/** How a source was imported: the texture usage it resolved to, and what decided it. */
export interface AssetImportSettings {
  /** A texture's usage (`color`, `data` or `normal`); absent for anything but a texture. */
  usage?: string;
  usageSource?: TextureUsageSource;
}

/** One file the import step wrote for a source. */
export interface AssetLockOutput {
  /** Posix path relative to the game's stage. */
  file: string;
  /** The GPU texture family of a KTX2 output (`bc`, `astc`, `etc2`, `rgba8`); absent for others. */
  family?: string;
  sha256: string;
  bytes: number;
}

/** One source asset in the lock. */
export interface AssetLockEntry {
  /** Stable for the asset's life: random at first sight, kept across a rename with the same sha256. */
  id: string;
  /** Posix path relative to the game folder. */
  path: string;
  sha256: string;
  kind: AssetKind;
  origin: AssetOrigin;
  licence: AssetLicence;
  source?: { url: string; page?: string; authors?: string[] };
  settings: AssetImportSettings;
  /** The importer's version that wrote the outputs. */
  importer: string;
  /** Ids of the entries this one reads (a `.gltf`'s buffers and images, an OBJ's MTL). */
  deps: string[];
  outputs: AssetLockOutput[];
  issues: ImportIssue[];
}

/** One baked output in the lock: what it was baked from, with what, and its digest. */
export interface AssetLockDerived {
  /** What the `bakeAssets` that made it baked. */
  kind: BakeKind;
  /** The bake's registered name (`isBakeName`). */
  name: string;
  /** Ids of the entries it was baked from. */
  inputs: string[];
  /** The digest of the bake's parameters (its config), so a changed config rebakes. */
  params: string;
  sha256: string;
  bytes: number;
}

/** The whole lock: sorted by path, so two imports of one tree write byte-identical files. */
export interface AssetLock {
  version: typeof ASSET_LOCK_VERSION;
  entries: AssetLockEntry[];
  derived: AssetLockDerived[];
}

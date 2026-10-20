/**
 * The curated CC0 manifest: packs no API lists (rigged characters, animation libraries, kits),
 * each file pinned by size and sha256 on an allowlisted download host, fetched by `cc0__fetch`
 * with `source: "curated"`. A pack that cannot be fetched under the CC0 fetch rules yet is listed
 * as held with a typed reason, so an agent learns why instead of searching for it.
 */

/** Why a curated pack is held. Wire values: the tool's refusal carries them. */
export const CuratedHeld = {
  /** The pack has no stable https download (its store signs a fresh link per download). */
  NoStableHost: "no-stable-host",
  /** The pack's zip nests its files in folders (some also hold more entries than the fetch rules allow). */
  ZipNested: "zip-nested",
} as const;
export type CuratedHeld = (typeof CuratedHeld)[keyof typeof CuratedHeld];

/** One pinned file of a curated pack, delivered under its plain name. */
export interface CuratedFile {
  name: string;
  url: string;
  bytes: number;
  sha256: string;
  /** Its role: `model`, or a map name of Poly Haven's vocabulary (`diff`, `nor_gl`, `arm`). */
  map: string;
}

/** One curated pack. */
export interface CuratedAsset {
  id: string;
  kind: string;
  licence: string;
  page: string;
  authors: string[];
  files: CuratedFile[];
}

/** The manifest: fetchable packs, and held ones with their reason. */
export interface CuratedManifest {
  assets: CuratedAsset[];
  held: Array<{ id: string; reason: CuratedHeld }>;
}

/** The manifest Studio ships. */
export const CURATED: CuratedManifest = {
  assets: [],
  held: [
    // Quaternius publishes the Universal Animation Library (CC0, 45 clips) through itch.io, whose
    // download links are signed per request: owner call on a Genex-hosted, sha256-pinned mirror.
    { id: "quaternius-ual", reason: CuratedHeld.NoStableHost },
    // Kenney's kits are zips of nested folders (`Models/GLB format/…`) with many entries
    // (prototype-kit: 749 entries; mini-characters: 148, nested too), which the CC0 zip rules refuse whole.
    { id: "kenney-prototype-kit", reason: CuratedHeld.ZipNested },
    { id: "kenney-mini-characters", reason: CuratedHeld.ZipNested },
  ],
};

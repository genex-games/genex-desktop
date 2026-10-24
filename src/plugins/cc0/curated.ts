/**
 * The curated CC0 manifest: packs no API lists (rigged characters, animation libraries, kits),
 * each file pinned by size and sha256 on an allowlisted download or curated host, fetched by
 * `cc0__fetch` with `source: "curated"`. A pack that cannot be fetched under the CC0 fetch rules yet is listed
 * as held with a typed reason, so an agent learns why instead of searching for it.
 */

/** Why a curated pack is held. Wire values: the tool's refusal carries them. */
export const CuratedHeld = {
  /** The pack's zip nests its files in folders (some also hold more entries than the fetch rules allow). */
  ZipNested: "zip-nested",
  /** The pack's host is allowed, but its files' sizes and sha256 pins are not recorded yet. */
  Unpinned: "unpinned",
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
    // Quaternius publishes the Universal Animation Library (CC0, 45 clips) on OpenGameArt as one
    // zip, `universal_animation_librarystandard.zip` (14,541,205 bytes), on an allowed curated host
    // (owner call AN-21). Its row lands once a fetch records the zip's sha256 and the members a
    // game takes.
    { id: "quaternius-ual", reason: CuratedHeld.Unpinned },
    // Kenney's kits are zips of nested folders (`Models/GLB format/…`) with many entries
    // (prototype-kit: 749 entries; mini-characters: 148, nested too), which the CC0 zip rules refuse whole.
    { id: "kenney-prototype-kit", reason: CuratedHeld.ZipNested },
    { id: "kenney-mini-characters", reason: CuratedHeld.ZipNested },
  ],
};

/**
 * What a CC0 fetch leaves behind: the delivery record the plugin keeps (`jobs.write`, one per
 * delivery folder) and the `genex-assets.lock` facts the host builds from it, so each delivered
 * file's row carries origin `cc0`, licence CC0-1.0, its source page and authors, and (for a map)
 * the texture usage its role decides at the provenance step. Pure, so the host can build lock
 * facts from a record with it.
 */
import { AssetLicence, type AssetImportSettings, AssetOrigin } from "../../shared/asset-db.ts";
import { type AssetKind, assetKind } from "../../shared/game-assets.ts";
import { resolveTextureUsage, usageLockFacts } from "../../substrate/asset-import/texture-usage.ts";

/** One delivered file: its game-relative path, digest, size, role and where its bytes came from. */
export interface Cc0DeliveredFile {
  path: string;
  sha256: string;
  bytes: number;
  /** `model`, `hdri`, or a map name of Poly Haven's vocabulary (`diff`, `nor_gl`, `arm`). */
  map: string;
  /** The download it is, or (a packed GLB) the glTF it was packed from. */
  url: string;
}

/** The record of one delivery, kept under its job id. */
export interface Cc0Delivery {
  jobId: string;
  source: string;
  id: string;
  kind: string;
  resolution: string | null;
  licence: typeof AssetLicence.Cc0;
  page: string;
  authors: string[];
  files: Cc0DeliveredFile[];
}

/** One lock fact (the shape `refreshAssetLock` reads). */
export interface Cc0LockFact {
  path: string;
  sha256: string;
  kind: AssetKind;
  origin: AssetOrigin;
  licence: AssetLicence;
  source: { url: string; page: string; authors: string[] };
  settings?: AssetImportSettings;
}

/** The lock facts of every file `record` delivered. */
export function cc0LockFacts(record: Cc0Delivery): Cc0LockFact[] {
  return record.files.map((file) => {
    const fact: Cc0LockFact = {
      path: file.path,
      sha256: file.sha256,
      kind: assetKind(file.path),
      origin: AssetOrigin.Cc0,
      licence: AssetLicence.Cc0,
      source: { url: file.url, page: record.page, authors: [...record.authors] },
    };
    if (fact.kind !== "image") return fact;
    const resolved = resolveTextureUsage({ path: file.path, provenance: { origin: AssetOrigin.Cc0, role: file.map } });
    if (resolved.usage !== null) fact.settings = usageLockFacts(resolved).settings;
    return fact;
  });
}

/** The ownership rule as a facet's merge and review phases ask it: may this part edit this file? */
import { allowedFile, type ReviewSpec } from "../review.ts";
import { STUDIO_CONTRACT, type FacetLoop } from "./state.ts";
import type { OwnedFile } from "../merge-ownership.ts";

/**
 * The facet's own files, by the reviewer's rule (`review.ts` allowedFile) for this game's shape:
 * the template's entry and contract, or a game the user brought with its own entry module.
 */
export function ownedByFacet({ ownShape, ownsMain, shape, spec }: FacetLoop): OwnedFile {
  const shaped: ReviewSpec = {
    ...(spec as ReviewSpec),
    ...(ownShape ? { template: false } : {}),
    ...(ownShape && shape?.main ? { main: shape.main, studio: STUDIO_CONTRACT } : {}),
  };
  return (file) => allowedFile(file, shaped, ownsMain);
}

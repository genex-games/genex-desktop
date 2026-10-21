/**
 * Live's asset swap (game systems C-19): what `studio:live.reloadAssets` answers. Reload on a Live
 * game whose waiting change is only files under `assets/` swaps them into the running game (the
 * `reloadAssets` op) with no rebuild and the game's state kept; any other change, or a file the
 * swap cannot place, answers `rebuild` with its reason and the stage reloads as it always did.
 * Browser-safe: the renderer reads it.
 */

/** What the swap did. Wire values: never rename one. */
export const LiveAssetsOutcome = {
  /** Every changed asset is in the running game; nothing waits for Reload any more. */
  Swapped: "swapped",
  /** Nothing was swapped: Reload rebuilds and reloads as before (`reason` says why). */
  Rebuild: "rebuild",
} as const;
export type LiveAssetsOutcome = (typeof LiveAssetsOutcome)[keyof typeof LiveAssetsOutcome];

/** Why a swap gave way to a rebuild. Wire values: never rename one. */
export const LiveAssetsRebuild = {
  /** Live shows no run or page of this game's own folder (another game, a run's build, nothing). */
  NoRun: "no-run",
  /** The build Live shows does not serve `reloadAssets` (an older build, an export, a C++ game). */
  NotServed: "not-served",
  /** `src/`, `genex.toml` or another file outside `assets/` changed: the code needs a build. */
  Source: "source",
  /** No asset differs from what the running game reads: what waits is not an asset change. */
  Unchanged: "unchanged",
  /** A file the running game reads is gone from the game's `assets/`. */
  Removed: "removed",
  /** A changed file needs the import step first (a conversion, a compressed mesh, a texture's families). */
  Import: "import",
  /** More files changed than one swap names (`NATIVE_RELOAD_FILES_MAX`). */
  TooMany: "too-many",
  /** The game refused a file, or the swap itself. */
  Refused: "refused",
} as const;
export type LiveAssetsRebuild = (typeof LiveAssetsRebuild)[keyof typeof LiveAssetsRebuild];

/** What `studio:live.reloadAssets` answers. */
export interface LiveAssetsAnswer {
  outcome: LiveAssetsOutcome;
  /** Why the swap gave way to a rebuild; null when it swapped. */
  reason: LiveAssetsRebuild | null;
  /** The asset paths the game swapped (`textures/bark.png`). */
  reloaded: string[];
  /** Reloads the game has not drawn yet (0 once its next frame read them). */
  pending: number;
}

/** A rebuild answer for `reason`: nothing swapped. */
export function liveAssetsRebuild(reason: LiveAssetsRebuild): LiveAssetsAnswer {
  return { outcome: LiveAssetsOutcome.Rebuild, reason, reloaded: [], pending: 0 };
}

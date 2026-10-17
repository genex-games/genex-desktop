/**
 * How much space a game's version history takes, and what clearing Rewind history and finished
 * runs' side tracks freed. Sizes are git's on-disk sizes, so they are about.
 */

/** Where Rewind keeps a chat's saved copies of the game: `refs/studio/chat/<thread>/…`. */
export const REWIND_REFS = "refs/studio/chat/";
/** Where a run keeps its integration, workers and attempts: `refs/studio/runs/<run>/…` (the seed's `runRef`). */
export const RUN_REFS = "refs/studio/runs/";

/** A game's version history on disk, and the part of it Genex's side tracks alone hold. */
export interface GameHistorySpace {
  /** Every object of the game's repository, loose and packed, in bytes. */
  totalBytes: number;
  /**
   * What a clear frees now, in bytes: what only Rewind's saved copies and finished runs' side tracks
   * reach, and copies an earlier clear left, once older than the hour a clear keeps them.
   */
  clearableBytes: number;
  /** Of what those reach or an earlier clear left, what is under an hour old: a later clear frees it. */
  recentBytes: number;
  /** Rewind's saved copies of the game (`refs/studio/chat/**`). */
  rewindTracks: number;
  /** The side tracks of runs that finished, were cancelled or failed (`refs/studio/runs/<run>/**`). */
  finishedRunTracks: number;
}

/** What clearing a game's side tracks did. */
export interface GameHistoryCleared {
  /** How many side tracks were removed. */
  removedTracks: number;
  /** How much smaller the repository is afterwards, in bytes (never negative). */
  freedBytes: number;
}

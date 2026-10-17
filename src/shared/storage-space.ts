/**
 * What Genex keeps beside the person's games that freeing space deletes, by kind, and what a
 * clean-up freed. Sizes are on-disk sizes, so they are about.
 */

/** A kind of space freeing deletes. */
export const StorageKind = {
  /** Folders Genex made to run and show builds: shown builds' copies, finished runs' folders. */
  Copies: "copies",
  /** Screenshots and recordings of finished builds (`runs/<run>`). */
  Pictures: "pictures",
  /** Versions Rewind and finished builds keep inside a game's own history (`refs/studio/**`). */
  History: "history",
} as const;
export type StorageKind = (typeof StorageKind)[keyof typeof StorageKind];

/** Every kind, in the order Settings lists them. */
export const STORAGE_KINDS: readonly StorageKind[] = [StorageKind.Copies, StorageKind.Pictures, StorageKind.History];

/**
 * What freeing space deletes now, for one game or for every game and what removed games left. A
 * game that is working counts nothing: freeing leaves it alone until its work ends.
 */
export interface StorageSpace {
  /** What freeing deletes now, by kind, in bytes. */
  bytes: Record<StorageKind, number>;
}

/** What freeing space did. */
export interface StorageFreed {
  /** How much space it freed, in bytes (never negative). */
  freedBytes: number;
  /** The games it left alone because they were working. */
  skipped: string[];
}

/** Nothing to free, by kind. */
export const NO_STORAGE: StorageSpace = {
  bytes: { [StorageKind.Copies]: 0, [StorageKind.Pictures]: 0, [StorageKind.History]: 0 },
};

/** What freeing deletes now, every kind together. */
export function freeableBytes(space: StorageSpace): number {
  return STORAGE_KINDS.reduce((sum, kind) => sum + space.bytes[kind], 0);
}

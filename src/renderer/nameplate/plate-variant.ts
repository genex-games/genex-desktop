/**
 * The nameplate variant a Pro account rolled, kept on this Mac per account: 0 (the account's first
 * plate) until New one rolls another. The sidebar and Settings read it live, so a roll shows in both
 * at once.
 */
import { useSyncExternalStore } from "react";
import { isPlateVariant, nextPlateVariant } from "../../shared/plate-recipe.ts";
import { readText, storageKeyFor, writeText } from "../storage.ts";

const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The variant stored for `accountId`; 0 when none is, or what is stored is not a variant. */
export function readPlateVariant(accountId: string): number {
  const stored = readText(storageKeyFor.plateVariant(accountId));
  const variant = stored === null ? 0 : Number(stored);
  return isPlateVariant(variant) ? variant : 0;
}

/** Roll a new plate for `accountId`, never the one it has, from `random` in [0, 1). */
export function rollPlateVariant(accountId: string, random: () => number = Math.random): number {
  const next = nextPlateVariant(readPlateVariant(accountId), random());
  writeText(storageKeyFor.plateVariant(accountId), String(next));
  for (const listener of listeners) listener();
  return next;
}

/** The variant for `accountId`, kept current as it is rolled. */
export function usePlateVariant(accountId: string): number {
  return useSyncExternalStore(subscribe, () => readPlateVariant(accountId));
}

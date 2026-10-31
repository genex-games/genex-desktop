/**
 * A game's space for the chat header's Free button: what freeing would delete, read when the chat
 * opens and each time the game's work ends, and freeing it, one clean-up at a time.
 */
import { useEffect, useRef, useState } from "react";
import { freeableBytes, type StorageFreed, type StorageSpace } from "../../shared/storage-space.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";
import { freedProperties } from "../analytics/workspace-properties.ts";
import { StorageSurface } from "../analytics/workspace-vocabulary.ts";
import { type Notify, notifyProblem, ToastTone } from "../state/toasts.ts";
import { freedWords } from "../words.ts";

/** The header's view of a game's space. */
export interface GameStorage {
  /** What freeing deletes now; null while it loads, while the game works, or when it could not be read. */
  space: StorageSpace | null;
  /** A clean-up is running. */
  freeing: boolean;
  /** Free the game's space and say what it freed; a second call while one runs does nothing. */
  free(): void;
}

export function useGameStorage(project: string | null, working: boolean, onNotice: Notify): GameStorage {
  const [space, setSpace] = useState<StorageSpace | null>(null);
  const [freeing, setFreeing] = useState(false);
  // Only the newest read may set the space: an older answer for another game arrives late.
  const reads = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    const read = ++reads.current;
    setSpace(null);
    if (!project || working) return;
    void window.studio
      .storageSpace(project)
      .then((next) => {
        if (read === reads.current) setSpace(next);
      })
      .catch(() => {});
  }, [project, working]);
  const free = (): void => {
    if (!project || pending.current) return;
    pending.current = true;
    setFreeing(true);
    const offered = space ? freeableBytes(space) : 0;
    const answered = (freed: StorageFreed | null): void =>
      track(AnalyticsEvent.FreeSpaceAnswered, freedProperties(StorageSurface.ChatHeader, offered, freed));
    void window.studio
      .freeStorage(project)
      .then((freed) => {
        answered(freed);
        reads.current++;
        setSpace(null);
        onNotice(freedWords(freed), ToastTone.Ok);
      })
      .catch((error: unknown) => {
        answered(null);
        notifyProblem(onNotice)(error);
      })
      .finally(() => {
        pending.current = false;
        setFreeing(false);
      });
  };
  return { space, freeing, free };
}

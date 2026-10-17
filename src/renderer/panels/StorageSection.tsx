/**
 * Settings → Storage: what freeing space deletes, by kind, across every game, and one button that
 * frees it all after a confirmation. Games that are working are left alone and named afterwards.
 */
import { type JSX, useEffect, useState } from "react";
import { sizeWords } from "../../shared/byte-size.ts";
import { freeableBytes, STORAGE_KINDS, type StorageSpace } from "../../shared/storage-space.ts";
import { useLibrary } from "../state/hooks.ts";
import { Button } from "../ui/Button.tsx";
import { Pending } from "../ui/Pending.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { freedWords, freeSpaceWords, freeUpWords, problemWords, STORAGE_KIND_WORDS, STORAGE_WORDS } from "../words.ts";
import { FreeSpaceSheet } from "./FreeSpaceSheet.tsx";

/** The one button: how much it frees, with what goes and what stays in its tooltip. */
function FreeUpButton({
  space,
  freeing,
  onChoose,
}: {
  space: StorageSpace;
  freeing: boolean;
  onChoose: () => void;
}): JSX.Element {
  const button = (
    <Button
      data-free-storage
      variant="default"
      busy={freeing}
      disabled={!freeing && freeableBytes(space) === 0}
      onClick={onChoose}
      className="h-9"
    >
      {freeing ? STORAGE_WORDS.freeing : freeUpWords(space)}
    </Button>
  );
  if (freeing || freeableBytes(space) === 0) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent className="max-w-72">{freeSpaceWords(space)}</TooltipContent>
    </Tooltip>
  );
}

/** One row per kind of space: its name, what it is and how much of it freeing deletes. */
function StorageKinds({ space }: { space: StorageSpace }): JSX.Element {
  return (
    <ul data-list className="settings-card">
      {STORAGE_KINDS.map((kind) => (
        <li
          key={kind}
          data-storage-kind={kind}
          className="settings-list-row flex min-h-13 min-w-0 items-center gap-3 px-3 py-1.5"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-ink">{STORAGE_KIND_WORDS[kind].label}</span>
            <span className="truncate text-ink-3">{STORAGE_KIND_WORDS[kind].about}</span>
          </span>
          <span className="shrink-0 font-mono text-xs text-ink-3">
            {space.bytes[kind] > 0 ? sizeWords(space.bytes[kind]) : STORAGE_WORDS.none}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function StorageSection(): JSX.Element {
  const games = useLibrary((s) => s.games);
  const [space, setSpace] = useState<StorageSpace | null>(null);
  const [freeing, setFreeing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.studio.storageSpace().then(setSpace, (cause: unknown) => setError(problemWords(cause)));
  }, []);
  const titleOf = (name: string): string => games.find((game) => game.name === name)?.title || name;
  const free = async (): Promise<void> => {
    setFreeing(true);
    setNotice(null);
    setError(null);
    try {
      setNotice(freedWords(await window.studio.freeStorage(), titleOf));
      setSpace(await window.studio.storageSpace());
    } catch (cause) {
      setError(problemWords(cause));
    } finally {
      setFreeing(false);
    }
  };
  return (
    <div data-storage-settings className="appearance-section flex flex-col gap-3">
      {confirming && space && (
        <FreeSpaceSheet space={space} onFree={() => void free()} onDone={() => setConfirming(false)} />
      )}
      <section aria-label={STORAGE_WORDS.title} data-row className="settings-card">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="settings-card-title">{STORAGE_WORDS.title}</h3>
          <p className="text-ink-3">{STORAGE_WORDS.keeps}</p>
        </div>
        {space ? (
          <FreeUpButton space={space} freeing={freeing} onChoose={() => setConfirming(true)} />
        ) : (
          !error && <Pending label={STORAGE_WORDS.measuring} />
        )}
      </section>
      {space && <StorageKinds space={space} />}
      {notice && (
        <p role="status" className="text-ink-2">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-red">
          {error}
        </p>
      )}
    </div>
  );
}

/** The confirmation before freeing space, from Settings → Storage or the chat header. */
import type { JSX } from "react";
import type { StorageSpace } from "../../shared/storage-space.ts";
import { ConfirmSheet } from "../ui/Confirm.tsx";
import { freeConfirmTitle, freeSpaceWords, freeUpWords, STORAGE_WORDS } from "../words.ts";

/** What freeing deletes and what stays, with Keep first and Free up as the danger. */
export function FreeSpaceSheet({
  space,
  game,
  onFree,
  onDone,
}: {
  space: StorageSpace;
  /** The game freeing is for; none for every game. */
  game?: string;
  onFree: () => void;
  onDone: () => void;
}): JSX.Element {
  return (
    <ConfirmSheet
      title={freeConfirmTitle(space)}
      body={freeSpaceWords(space, game)}
      testId="free-space"
      onDismiss={onDone}
      choices={[
        { label: STORAGE_WORDS.keep, onChoose: onDone },
        {
          label: freeUpWords(space),
          danger: true,
          onChoose: () => {
            onFree();
            onDone();
          },
        },
      ]}
    />
  );
}

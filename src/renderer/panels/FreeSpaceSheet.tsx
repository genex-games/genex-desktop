/** The confirmation before freeing space, from Settings → Storage or the chat header. */
import type { JSX } from "react";
import { freeableBytes, type StorageSpace } from "../../shared/storage-space.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";
import { sizeBucket } from "../analytics/workspace-properties.ts";
import { FreeSpaceAnswer, type StorageSurface } from "../analytics/workspace-vocabulary.ts";
import { ConfirmSheet } from "../ui/Confirm.tsx";
import { freeConfirmTitle, freeSpaceWords, freeUpWords, STORAGE_WORDS } from "../words.ts";

/** What freeing deletes and what stays, with Keep first and Free up as the danger. */
export function FreeSpaceSheet({
  space,
  game,
  surface,
  onFree,
  onDone,
}: {
  space: StorageSpace;
  /** The game freeing is for; none for every game. */
  game?: string;
  /** Where it was asked from (usage analytics; Free up is counted by `onFree` once it is done). */
  surface: StorageSurface;
  onFree: () => void;
  onDone: () => void;
}): JSX.Element {
  const answered = (answer: FreeSpaceAnswer): void => {
    track(AnalyticsEvent.FreeSpaceAnswered, { surface, answer, freeable_bucket: sizeBucket(freeableBytes(space)) });
    onDone();
  };
  return (
    <ConfirmSheet
      title={freeConfirmTitle(space)}
      // It names the game freeing is for: a dialog's words, which a replay never shows.
      body={freeSpaceWords(space, game)}
      testId="free-space"
      onDismiss={() => answered(FreeSpaceAnswer.Dismiss)}
      choices={[
        { label: STORAGE_WORDS.keep, onChoose: () => answered(FreeSpaceAnswer.Keep) },
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

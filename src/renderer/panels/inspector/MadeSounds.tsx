/**
 * The sounds a step made, on its card: each as the chat's sound row (play in place, its shape, its
 * length), the first few at once and the rest behind Show all, so a card of thirty opens light. A
 * sound the game has no record of yet has nothing to play, and is left out.
 */
import type { JSX } from "react";
import { useState } from "react";
import type { ProjectAsset } from "../../../shared/game-assets.ts";
import { t } from "../../../shared/i18n.ts";
import { AudioStrip } from "../../chat/AudioStrip.tsx";
import type { AssetCard } from "../../run-steps.ts";

/** How many sounds a card lists before Show all. */
const SOUNDS_SHOWN = 6;

const MESSAGE = {
  showAll: (count: number) => t("Show all {count}", { count }),
} as const;

/** The game's record of each sound the cards made, in the order they were made. */
export function madeSounds(cards: readonly AssetCard[]): ProjectAsset[] {
  return cards.flatMap((card) => {
    const preview = card.versions.at(-1)?.preview;
    return preview?.kind === "audio" ? [preview] : [];
  });
}

/** The step's sounds as rows that play, the first few, then Show all. */
export function MadeSounds({
  project,
  cards,
}: {
  project: string | null;
  cards: readonly AssetCard[];
}): JSX.Element | null {
  const [all, setAll] = useState(false);
  const sounds = madeSounds(cards);
  if (!project || !sounds.length) return null;
  const shown = all ? sounds : sounds.slice(0, SOUNDS_SHOWN);
  return (
    <div data-made-sounds className="flex flex-col gap-1.5">
      {shown.map((asset) => (
        <AudioStrip key={asset.file} project={project} asset={asset} />
      ))}
      {shown.length < sounds.length ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-1.5 cursor-pointer self-start text-chat-sub text-ink underline decoration-current/35 decoration-[0.5px] underline-offset-[5px] hover:decoration-current/70 focus-visible:decoration-current/70 focus-visible:outline-none"
        >
          {MESSAGE.showAll(sounds.length)}
        </button>
      ) : null}
    </div>
  );
}

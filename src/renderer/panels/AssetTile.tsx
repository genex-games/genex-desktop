import { Play } from "lucide-react";
import type { ProjectAsset } from "../../shared/game-assets.ts";
import { Icon } from "../ui/icons.tsx";
import { ASSET_WORDS, animationCountWords } from "../words.ts";
import { AssetThumbnail } from "./AssetThumbnail.tsx";
import { t } from "../../shared/i18n.ts";

/**
 * One file as a card, in the conversation and on the Assets canvas: the picture is the card and
 * opens the viewer. A model shows how many animation files move it; `onOpenAssets` adds the corner
 * action. An animation file with no model to fold into (`motion`) shows a figure and its name.
 */
export function AssetTile({
  project,
  asset,
  companions,
  clips = 0,
  motion = false,
  onOpen,
  onOpenAssets,
}: {
  project: string;
  asset: ProjectAsset;
  companions: string[];
  /** How many animation files play on this model. */
  clips?: number;
  motion?: boolean;
  onOpen: () => void;
  onOpenAssets?: () => void;
}) {
  const name = asset.file.split("/").at(-1) ?? asset.file;
  return (
    <div
      data-tile-kind={asset.kind}
      className="asset-tile relative h-full min-h-0 overflow-hidden rounded-card bg-inset"
    >
      <button
        type="button"
        aria-label={t("Preview {name}", { name })}
        title={name}
        onClick={onOpen}
        className="absolute inset-0 block w-full cursor-pointer rounded-card text-ink-3"
      >
        <AssetThumbnail project={project} asset={asset} companions={companions} fallback={null} motion={motion} />
        {clips > 0 && (
          <span data-asset-clips={clips} className="asset-chip asset-glass">
            <Play aria-hidden size={10} fill="currentColor" strokeWidth={0} />
            {animationCountWords(clips)}
          </span>
        )}
      </button>
      {onOpenAssets && (
        <button
          type="button"
          data-open-assets
          aria-label={ASSET_WORDS.openInAssets}
          title={ASSET_WORDS.openInAssets}
          onClick={onOpenAssets}
          className="asset-corner asset-glass"
        >
          <Icon name="assets" size={16} />
        </button>
      )}
    </div>
  );
}

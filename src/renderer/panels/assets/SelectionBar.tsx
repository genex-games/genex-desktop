/** The bar pinned under the canvas while several cards are picked: how many, Save, Share and Clear. */
import type { JSX } from "react";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/icons.tsx";
import { ASSET_LIBRARY_WORDS as WORDS } from "../../words.ts";

export function SelectionBar({
  count,
  canSave,
  canShare,
  onSave,
  onShare,
  onClear,
}: {
  count: number;
  /** Some picked file is not saved yet; false hides Save. */
  canSave: boolean;
  /** Some picked file can be shared; false hides Share. */
  canShare: boolean;
  onSave: () => void;
  onShare: () => void;
  onClear: () => void;
}): JSX.Element {
  return (
    <div
      data-assets-selection={count}
      className="asset-selection-bar"
      role="toolbar"
      aria-label={WORDS.selected(count)}
    >
      <span className="asset-selection-count">{WORDS.selected(count)}</span>
      {canSave && (
        <Button data-selection-save onClick={onSave}>
          <Icon name="bookmark" size={14} />
          {WORDS.save}
        </Button>
      )}
      {canShare && (
        <Button variant="play-tint" data-selection-share onClick={onShare}>
          <Icon name="globe" size={14} />
          {WORDS.share}
        </Button>
      )}
      <button
        type="button"
        data-selection-clear
        aria-label={WORDS.clearSelection}
        className="asset-underlined"
        onClick={onClear}
      >
        {WORDS.clear}
      </button>
    </div>
  );
}

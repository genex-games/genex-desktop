/**
 * The share window: one asset or several, each with its picture and the name it goes on Play
 * under, one line on who can find it, and Share. Share hands the names to the cards, whose lines
 * follow each share, and the window closes.
 */
import type { JSX, RefObject } from "react";
import { useRef, useState } from "react";
import { SHARE_NAME_MAX } from "../../../shared/asset-library.ts";
import type { ProjectAsset } from "../../../shared/game-assets.ts";
import { offeredName, shareItemsOf } from "../../asset-library-view.ts";
import { studio } from "../../state/studio.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogSurface } from "../../ui/dialog.tsx";
import { Icon } from "../../ui/icons.tsx";
import { useMoreBelow } from "../../ui/scroll-fade.ts";
import { ASSET_LIBRARY_WORDS as WORDS } from "../../words.ts";
import { AssetThumbnail } from "../AssetThumbnail.tsx";

/** One asset's picture as its canvas card shows it; a sound shows its mark. */
function SharePicture({
  project,
  asset,
  companions,
  className,
}: {
  project: string;
  asset: ProjectAsset;
  companions: string[];
  className: string;
}): JSX.Element {
  return (
    <div className={`asset-share-picture ${className}`}>
      {asset.kind === "audio" ? (
        <span className="absolute inset-0 grid place-items-center text-ink-3">
          <Icon name="sound" size={22} />
        </span>
      ) : (
        <AssetThumbnail project={project} asset={asset} companions={companions} fallback={null} quiet />
      )}
    </div>
  );
}

/** A name field, its accessible name the asset's first name. */
function NameField({
  value,
  label,
  compact,
  onChange,
  field,
}: {
  value: string;
  label: string;
  compact: boolean;
  onChange: (value: string) => void;
  field?: RefObject<HTMLInputElement | null>;
}): JSX.Element {
  return (
    <input
      ref={field}
      data-share-name
      aria-label={label}
      className={`asset-name-field ${compact ? "asset-name-field-compact" : ""}`}
      value={value}
      maxLength={SHARE_NAME_MAX}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function ShareDialog({
  project,
  assets,
  companions,
  onDismiss,
}: {
  project: string;
  assets: ProjectAsset[];
  companions: string[];
  onDismiss: () => void;
}): JSX.Element {
  const [names, setNames] = useState(() => assets.map((asset) => ({ file: asset.file, name: offeredName(asset) })));
  const [title] = useState(() =>
    assets.length === 1 ? WORDS.shareOne(names[0]?.name ?? "") : WORDS.shareMany(assets.length),
  );
  const first = useRef<HTMLInputElement>(null);
  const more = useMoreBelow<HTMLDivElement>();
  const items = shareItemsOf(names);
  const rename = (file: string, name: string): void =>
    setNames((current) => current.map((entry) => (entry.file === file ? { file, name } : entry)));
  const share = (): void => {
    if (!items) return;
    void studio().sharing.share(project, items);
    onDismiss();
  };
  const one = assets.length === 1;
  return (
    <DialogSurface
      title={title}
      onDismiss={onDismiss}
      size={one ? "md" : "lg"}
      initialFocus={first}
      testId="share-assets"
    >
      <form
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          share();
        }}
      >
        {one ? (
          <OneAsset
            project={project}
            asset={assets[0]}
            companions={companions}
            names={names}
            rename={rename}
            first={first}
          />
        ) : (
          <div ref={more} className="asset-share-grid scroll-fade">
            {assets.map((asset, index) => (
              <div key={asset.file} className="flex min-w-0 flex-col gap-1.5">
                <SharePicture project={project} asset={asset} companions={companions} className="h-[74px]" />
                <NameField
                  value={names[index]?.name ?? ""}
                  label={WORDS.nameOf(offeredName(asset))}
                  compact
                  field={index === 0 ? first : undefined}
                  onChange={(name) => rename(asset.file, name)}
                />
              </div>
            ))}
          </div>
        )}
        <p className="asset-share-everyone">
          <Icon name="globe" size={14} />
          <span className="truncate">{one ? WORDS.everyoneOne : WORDS.everyoneMany}</span>
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onDismiss}>{WORDS.cancel}</Button>
          <Button type="submit" variant="default" data-share-confirm disabled={!items}>
            {WORDS.shareButton(assets.length)}
          </Button>
        </div>
      </form>
    </DialogSurface>
  );
}

/** One asset: its picture beside its Name field. */
function OneAsset({
  project,
  asset,
  companions,
  names,
  rename,
  first,
}: {
  project: string;
  asset: ProjectAsset | undefined;
  companions: string[];
  names: ReadonlyArray<{ file: string; name: string }>;
  rename: (file: string, name: string) => void;
  first: RefObject<HTMLInputElement | null>;
}): JSX.Element | null {
  if (!asset) return null;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <SharePicture project={project} asset={asset} companions={companions} className="h-[58px] w-16 flex-none" />
      <label className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-xs text-ink-3">{WORDS.nameLabel}</span>
        <NameField
          value={names[0]?.name ?? ""}
          label={WORDS.nameLabel}
          compact={false}
          field={first}
          onChange={(name) => rename(asset.file, name)}
        />
      </label>
    </div>
  );
}

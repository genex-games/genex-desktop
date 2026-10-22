/**
 * Edit tags, for an admin: the shelf a game sits on (Games, Tools or Assets) and its tags from that
 * shelf's own list, up to the shelf's limit. The line under them says where Play will show it.
 */
import type { JSX } from "react";
import { useState } from "react";
import {
  categoriesShelf,
  categoriesTags,
  isPlayTag,
  PlayChangeKind,
  shelfTags,
  shelfTagsMax,
  taggedCategories,
} from "../../../shared/play-manage.ts";
import { isPlayCategory, PLAY_SHELVES, PlayShelf } from "../../../shared/play.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogSurface } from "../../ui/dialog.tsx";
import { PLAY_CARD_MENU_WORDS, PLAY_WORDS } from "../../words.ts";
import { actionLabel, type CardDialogProps, DialogFoot } from "./DialogFoot.tsx";
import { curationOf } from "./manage-model.ts";
import { useChange } from "./use-change.ts";

const WORDS = PLAY_CARD_MENU_WORDS.tags;

/** A tag's name as Play's tabs show it. */
const tagName = (tag: string): string => (isPlayCategory(tag) ? PLAY_WORDS.categories[tag] : tag);

/** Choose a game's shelf and tags. */
export function TagsDialog({ game, onClose, returnFocus }: CardDialogProps): JSX.Element {
  // An older tag in a shape Save tags may not send stays off the list, so a save never fails on it.
  const stored = curationOf(game).categories.filter((category) => isPlayTag(category));
  const [shelf, setShelf] = useState<PlayShelf>(() => categoriesShelf(stored));
  const [tags, setTags] = useState<string[]>(() => categoriesTags(stored));
  const save = useChange(game, onClose, WORDS.failed);
  const max = shelfTagsMax(shelf);
  // The shelf's own tags, and any the game already carries outside them (an older tag), so a save
  // never drops one it did not show.
  const offered = [...new Set([...shelfTags(shelf), ...categoriesTags(stored)])];
  const kept = tags.filter((tag) => offered.includes(tag)).slice(0, max);
  const categories = taggedCategories(shelf, kept);
  const changed = categories.join() !== taggedCategories(categoriesShelf(stored), categoriesTags(stored)).join();
  const toggle = (tag: string) => setTags((now) => (now.includes(tag) ? now.filter((t) => t !== tag) : [...now, tag]));
  return (
    <DialogSurface
      title={WORDS.title(game.title)}
      onDismiss={onClose}
      returnFocus={returnFocus}
      dismissible={!save.busy}
    >
      <div className="play-tags-shelves" role="radiogroup" aria-label={WORDS.shelfLabel}>
        {PLAY_SHELVES.map((value) => (
          // biome-ignore lint/a11y/useSemanticElements: a segmented choice of three shelves
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={shelf === value}
            className="play-tags-shelf"
            onClick={() => setShelf(value)}
          >
            {WORDS.shelf[value]}
          </button>
        ))}
      </div>
      {offered.length > 0 ? (
        <fieldset className="play-tags-chips">
          <legend className="sr-only">{WORDS.tagsLabel}</legend>
          {offered.map((tag) => {
            const on = kept.includes(tag);
            // A full shelf hides what can't be added rather than greying it.
            if (!on && kept.length >= max) return null;
            return (
              <button key={tag} type="button" aria-pressed={on} className="play-tags-chip" onClick={() => toggle(tag)}>
                {tagName(tag)}
              </button>
            );
          })}
        </fieldset>
      ) : (
        <p className="play-dialog-note">{WORDS.noTags}</p>
      )}
      <p className="play-dialog-note">
        {WORDS.shows(WORDS.shelf[shelf], kept.map(tagName))} {shelf !== PlayShelf.Assets && WORDS.limit(max)}
      </p>
      <DialogFoot problem={save.problem} busy={save.busy} onCancel={onClose}>
        {changed && (
          <Button
            variant="play-fill"
            disabled={save.busy}
            data-play-dialog-save
            onClick={() => void save.run({ kind: PlayChangeKind.Tags, categories }, () => WORDS.done)}
          >
            {actionLabel(WORDS.save, save.busy, save.failed)}
          </Button>
        )}
      </DialogFoot>
    </DialogSurface>
  );
}

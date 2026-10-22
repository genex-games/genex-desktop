/**
 * Unpublish and Delete game, confirmed in one sentence each, with the game's own name in the
 * title. Unpublish is undone by publishing again; Delete is not, so its button is the red one.
 */
import type { JSX } from "react";
import { PlayCardAction, PlayChangeKind } from "../../../shared/play-manage.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogSurface } from "../../ui/dialog.tsx";
import { PLAY_CARD_MENU_WORDS } from "../../words.ts";
import { actionLabel, type CardDialogProps, DialogFoot } from "./DialogFoot.tsx";
import { useChange } from "./use-change.ts";

const WORDS = PLAY_CARD_MENU_WORDS;

/** Where the focus goes once the card holding `from` is gone: the next card's cover, else the one before, else its grid. */
function nextFocus(from: HTMLElement | null): HTMLElement | null {
  const card = from?.closest("article");
  const beside = card?.nextElementSibling ?? card?.previousElementSibling;
  const cover = beside?.querySelector("button");
  if (cover instanceof HTMLElement) return cover;
  return card?.parentElement ?? null;
}

/** Confirm taking a game off Play: unpublishing it, or deleting it for good. */
export function ConfirmDialog({
  action,
  game,
  onClose,
  returnFocus,
}: CardDialogProps & { action: typeof PlayCardAction.Unpublish | typeof PlayCardAction.Delete }): JSX.Element {
  const remove = action === PlayCardAction.Delete;
  const words = remove ? WORDS.remove : WORDS.unpublish;
  const save = useChange(game, onClose, words.failed);
  const confirm = () => {
    // The game's card leaves with it, ⋯ and dialog too: the focus goes to the card beside it.
    const landing = nextFocus(returnFocus.current);
    void save.run({ kind: remove ? PlayChangeKind.Delete : PlayChangeKind.Unpublish }, () => {
      requestAnimationFrame(() => landing?.focus());
      return words.done(game.title);
    });
  };
  return (
    <DialogSurface
      title={words.title(game.title)}
      description={words.body}
      onDismiss={onClose}
      returnFocus={returnFocus}
      dismissible={!save.busy}
    >
      <DialogFoot problem={save.problem} busy={save.busy} onCancel={onClose}>
        <Button
          variant={remove ? "destructive" : "play-fill"}
          disabled={save.busy}
          onClick={confirm}
          data-play-dialog-save
        >
          {actionLabel(words.confirm, save.busy, save.failed, words.working)}
        </Button>
      </DialogFoot>
    </DialogSurface>
  );
}

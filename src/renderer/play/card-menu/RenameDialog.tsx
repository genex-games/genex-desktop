/**
 * Rename, for a game's owner: the name players see on Play and genex.games, saved with Enter or Save.
 * The name is cleaned as genex.games cleans one, and one with no letter or digit is never sent.
 */
import type { JSX } from "react";
import { useState } from "react";
import { cleanGenexTitle, GENEX_TITLE_MAX_CHARS } from "../../../shared/genex.ts";
import { PlayChangeKind } from "../../../shared/play-manage.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogSurface } from "../../ui/dialog.tsx";
import { Input } from "../../ui/input.tsx";
import { PLAY_CARD_MENU_WORDS } from "../../words.ts";
import { actionLabel, type CardDialogProps, DialogFoot } from "./DialogFoot.tsx";
import { useChange } from "./use-change.ts";

const WORDS = PLAY_CARD_MENU_WORDS;

/** Give a game a new name. */
export function RenameDialog({ game, onClose, returnFocus }: CardDialogProps): JSX.Element {
  const [typed, setTyped] = useState(game.title);
  const save = useChange(game, onClose, WORDS.rename.failed);
  const title = cleanGenexTitle(typed);
  const changed = title !== null && title !== game.title;
  const send = () => {
    if (title && changed) void save.run({ kind: PlayChangeKind.Rename, title }, () => WORDS.rename.done(title));
  };
  return (
    <DialogSurface
      title={WORDS.rename.title(game.title)}
      description={WORDS.rename.sub}
      onDismiss={onClose}
      returnFocus={returnFocus}
      dismissible={!save.busy}
    >
      <form
        className="play-dialog-field"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <label className="play-dialog-label" htmlFor="play-rename-title">
          {WORDS.rename.label}
        </label>
        <Input
          id="play-rename-title"
          data-play-rename-title
          value={typed}
          maxLength={GENEX_TITLE_MAX_CHARS}
          autoFocus
          disabled={save.busy}
          aria-invalid={title === null}
          onChange={(event) => setTyped(event.target.value)}
        />
        {title === null && <p className="play-dialog-note">{WORDS.rename.noName}</p>}
      </form>
      <DialogFoot problem={save.problem} busy={save.busy} onCancel={onClose}>
        {changed && (
          <Button variant="play-fill" disabled={save.busy} data-play-dialog-save onClick={send}>
            {actionLabel(WORDS.save, save.busy, save.failed)}
          </Button>
        )}
      </DialogFoot>
    </DialogSurface>
  );
}

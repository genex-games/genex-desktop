/**
 * Mobile support, for an admin: Auto (genex.games decides from crash reports), Desktop only, or
 * Works on phones. The admin's choice wins over the automatic check, and the line under the choices
 * says what Auto would do for this game.
 */
import type { JSX } from "react";
import { useState } from "react";
import { PlayChangeKind, PlayMobileSupport } from "../../../shared/play-manage.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogSurface } from "../../ui/dialog.tsx";
import { PLAY_CARD_MENU_WORDS } from "../../words.ts";
import { actionLabel, type CardDialogProps, DialogFoot } from "./DialogFoot.tsx";
import { curationOf } from "./manage-model.ts";
import { useChange } from "./use-change.ts";

const WORDS = PLAY_CARD_MENU_WORDS;

/** The three choices, Auto first. */
const CHOICES: ReadonlyArray<{ value: PlayMobileSupport | null; label: string; hint: string }> = [
  { value: null, label: WORDS.mobile.auto, hint: WORDS.mobile.autoHint },
  {
    value: PlayMobileSupport.DesktopOnly,
    label: WORDS.mobileState[PlayMobileSupport.DesktopOnly],
    hint: WORDS.mobile.hint[PlayMobileSupport.DesktopOnly],
  },
  {
    value: PlayMobileSupport.Supported,
    label: WORDS.mobileState[PlayMobileSupport.Supported],
    hint: WORDS.mobile.hint[PlayMobileSupport.Supported],
  },
];

/** Set or clear a game's mobile flag. */
export function MobileDialog({ game, onClose, returnFocus }: CardDialogProps): JSX.Element {
  const curation = curationOf(game);
  const [picked, setPicked] = useState<PlayMobileSupport | null>(curation.mobileSupport);
  const save = useChange(game, onClose, WORDS.mobile.failed);
  const flagged = curation.mobileAuto === PlayMobileSupport.DesktopOnly;
  return (
    <DialogSurface
      title={WORDS.mobile.title(game.title)}
      description={WORDS.mobile.sub}
      onDismiss={onClose}
      returnFocus={returnFocus}
      dismissible={!save.busy}
    >
      <div className="play-dialog-choices" role="radiogroup" aria-label={WORDS.mobile.label}>
        {CHOICES.map((choice) => (
          // biome-ignore lint/a11y/useSemanticElements: a choice row with a name and a line under it, as the website draws it
          <button
            key={choice.label}
            type="button"
            role="radio"
            aria-checked={picked === choice.value}
            className="play-dialog-choice"
            disabled={save.busy}
            onClick={() => setPicked(choice.value)}
          >
            <span className="play-dialog-radio" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="play-dialog-choice-name">{choice.label}</span>
              <span className="play-dialog-choice-hint">{choice.hint}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="play-dialog-note">{flagged ? WORDS.mobile.autoFlagged : WORDS.mobile.autoClear}</p>
      <DialogFoot problem={save.problem} busy={save.busy} onCancel={onClose}>
        {picked !== curation.mobileSupport && (
          <Button
            variant="play-fill"
            disabled={save.busy}
            data-play-dialog-save
            onClick={() =>
              void save.run({ kind: PlayChangeKind.Mobile, mobileSupport: picked }, () => WORDS.mobile.done)
            }
          >
            {actionLabel(WORDS.save, save.busy, save.failed)}
          </Button>
        )}
      </DialogFoot>
    </DialogSurface>
  );
}

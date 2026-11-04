/**
 * Change link, for a game's owner: the game's address on genex.games, typed after the site's own
 * part and spelled as genex.games spells a link while it is typed. The old link keeps opening the
 * game; when genex.games keeps the old one (another game has the new one, the game used its changes,
 * or Genex keeps that link) the dialog stays open and says why.
 */
import type { JSX } from "react";
import { useState } from "react";
import { GENEX_SLUG_MAX_CHARS, genexSlug } from "../../../shared/genex.ts";
import { type PlayChangeResult, PlayChangeKind, PlayChangeOutcome } from "../../../shared/play-manage.ts";
import { playPageUrl } from "../../../shared/play.ts";
import { usePlayWeb } from "../../state/hooks.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogSurface } from "../../ui/dialog.tsx";
import { PLAY_CARD_MENU_WORDS } from "../../words.ts";
import { actionLabel, type CardDialogProps, DialogFoot } from "./DialogFoot.tsx";
import { useChange } from "./use-change.ts";

const WORDS = PLAY_CARD_MENU_WORDS;

/** A link as it is typed: lower case, anything but a letter, digit or dash a dash. */
const linkTyped = (value: string): string => value.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

/** What the dialog says of a link genex.games kept back. */
const keptWords = (result: PlayChangeResult): string | undefined =>
  result.outcome === PlayChangeOutcome.Done || result.outcome === PlayChangeOutcome.OwnRepo
    ? undefined
    : WORDS.link.kept[result.outcome];

/** An address without its scheme: `genex.games/skate`. */
const shownAddress = (url: string): string => url.replace(/^https?:\/\//, "");

/** Move a game to a new link. */
export function LinkDialog({ game, onClose, returnFocus }: CardDialogProps): JSX.Element {
  const web = usePlayWeb();
  const [typed, setTyped] = useState(game.slug);
  const save = useChange(game, onClose, WORDS.link.failed);
  const slug = genexSlug(typed);
  const changed = slug !== "" && slug !== game.slug;
  const send = () => {
    if (!changed) return;
    void save.run(
      { kind: PlayChangeKind.Link, slug },
      (result) => WORDS.link.done(shownAddress(playPageUrl(web, ("slug" in result && result.slug) || slug))),
      keptWords,
    );
  };
  return (
    <DialogSurface
      title={WORDS.link.title(game.title)}
      description={WORDS.link.sub}
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
        <label className="play-dialog-label" htmlFor="play-link-slug">
          {WORDS.link.label}
        </label>
        <div className="play-link-input" data-refused={save.problem ? "" : undefined}>
          <span className="play-link-base" aria-hidden="true">
            {shownAddress(playPageUrl(web, ""))}
          </span>
          <input
            id="play-link-slug"
            data-play-link-slug
            value={typed}
            maxLength={GENEX_SLUG_MAX_CHARS}
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            disabled={save.busy}
            onChange={(event) => setTyped(linkTyped(event.target.value))}
          />
        </div>
        {slug === "" && <p className="play-dialog-note">{WORDS.link.empty}</p>}
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

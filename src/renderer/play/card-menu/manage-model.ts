/**
 * What a change from a card's ⋯ menu does to the card on screen, and what its mobile row reads:
 * pure, so the store and the menu share one answer.
 */
import {
  type PlayChangeResult,
  PlayChangeKind,
  type PlayCuration,
  type PlayGameChange,
  PlayMobileSupport,
} from "../../../shared/play-manage.ts";
import type { PlayGame } from "../../../shared/play.ts";

/** A card that carries no curation reads as a plain one: Auto, no tags, remixing on. */
const NO_CURATION: PlayCuration = { mobileSupport: null, mobileAuto: null, categories: [], remixOff: false };

/** A card's curation, or the plain one. */
export const curationOf = (game: PlayGame): PlayCuration => game.curation ?? NO_CURATION;

/** The card with its curation changed by `patch`. */
const curated = (game: PlayGame, patch: Partial<PlayCuration>): PlayGame => ({
  ...game,
  curation: { ...curationOf(game), ...patch },
});

/** The card after `change` went through, or null once the game has left the catalog (Unpublish, Delete). */
export function changedGame(game: PlayGame, change: PlayGameChange, result: PlayChangeResult): PlayGame | null {
  switch (change.kind) {
    case PlayChangeKind.Unpublish:
    case PlayChangeKind.Delete:
      return null;
    case PlayChangeKind.Mobile:
      return curated(game, { mobileSupport: change.mobileSupport });
    case PlayChangeKind.Tags: {
      const stored = "categories" in result ? result.categories : undefined;
      return curated(game, { categories: stored ?? change.categories });
    }
    case PlayChangeKind.Remixing:
      // Off hides Remix at once; whether it shows again is the gallery's to say (a game for sale never
      // offers it), on the next read.
      return { ...curated(game, { remixOff: !change.allowed }), remixable: change.allowed && game.remixable };
  }
}

/** Where a game's mobile flag stands, as its menu row reads it: the admin's choice, or Auto having flagged it. */
export const MobileShown = { ...PlayMobileSupport, AutoFlagged: "auto-flagged" } as const;
export type MobileShown = (typeof MobileShown)[keyof typeof MobileShown];

/** The mobile row's state, or null when Auto has nothing to say. */
export function mobileShown(curation: PlayCuration): MobileShown | null {
  if (curation.mobileSupport) return curation.mobileSupport;
  return curation.mobileAuto === PlayMobileSupport.DesktopOnly ? MobileShown.AutoFlagged : null;
}

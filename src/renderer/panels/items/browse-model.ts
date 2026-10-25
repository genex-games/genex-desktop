/**
 * Browse's words that carry the selling game's share (marketplace screen 07, P14): genex.games
 * configures it (`crossGameSellerBps`) and sends it with Browse (`sellerShareBps`), so the intro and
 * the detail panel say it as configured; an API that does not send it gets the design's own words.
 * Nothing here computes what a game earns per sale: that is genex.games' `youGetPerSale`. And where
 * the item on show stands in the game Add to acts on: added there, and sold there yet (Q5), or not.
 */
import { intlLocale } from "../../../shared/i18n.ts";
import { type BrowseDetail, SALE_BPS } from "../../../shared/store-items.ts";
import { ITEMS_WORDS } from "../../words.ts";

/** The most decimals a share is said with: 12.5%, never 12.4999%. */
const SHARE_DECIMALS = 2;
/** The app in English writes numbers as English does, whatever the computer's own language. */
const ENGLISH = "en";

/** A share in basis points as the app's language writes a percentage ("15%", "15 %"). */
export function shareText(bps: number): string {
  const format = new Intl.NumberFormat(intlLocale() ?? ENGLISH, {
    style: "percent",
    maximumFractionDigits: SHARE_DECIMALS,
  });
  return format.format(bps / SALE_BPS);
}

/** Browse's intro: with the share genex.games named, else the design's words. */
export const browseIntro = (bps: number | undefined): string =>
  bps === undefined ? ITEMS_WORDS.intro : ITEMS_WORDS.introShare(shareText(bps));

/** The detail panel's "You get per sale": with the share genex.games named, else as the design says it. */
export const youGetLabel = (bps: number | undefined): string =>
  bps === undefined ? ITEMS_WORDS.youGet : ITEMS_WORDS.youGetShare(shareText(bps));

/**
 * The item on show in the game whose Genex project is `projectId`: added there, and whether players
 * can get it there yet (the game released a build since, Q5); null when it is not there, or its
 * detail is not read yet (Add to stays).
 */
export function addedIn(detail: BrowseDetail | undefined, projectId: string | null): { live: boolean } | null {
  const added = projectId ? detail?.addedTo.find((game) => game.projectId === projectId) : undefined;
  return added ? { live: added.live } : null;
}

/**
 * Regenerate: the account gets another generated avatar, free and at once, in the app and on
 * genex.games. It is a new variant of the account's recipe, never the one it has: nothing is made,
 * the avatar is drawn here from the id and the variant, and genex.games keeps the variant so every
 * client draws the same face. Presses may follow each other as fast as the person likes; the people
 * store saves them in order.
 */
import { nextAvatarVariant } from "../../shared/avatar-recipe.ts";
import type { PlayMe } from "../../shared/play-people.ts";
import { studio } from "../state/studio.ts";
import { ToastTone } from "../state/toasts.ts";
import { ACCOUNT_WORDS } from "../words.ts";

const WORDS = ACCOUNT_WORDS;

/** What the Regenerate button needs: whether it works yet, and the press. */
export interface RegenerateAvatar {
  /** genex.games keeps a regenerated avatar; until then the button waits. */
  available: boolean;
  regenerate(): void;
}

/** Save another generated avatar for `me`; rejects when Genex refused, once the kept one is back. */
export const regenerateAvatar = (me: PlayMe, random: () => number = Math.random): Promise<void> =>
  studio().people.setAvatarVariant(nextAvatarVariant(me.avatarVariant, random()));

/** Regenerate `me`'s avatar; a toast says so when Genex refused, and the kept one comes back. */
export function useRegenerateAvatar(me: PlayMe | null, random: () => number = Math.random): RegenerateAvatar {
  const regenerate = (): void => {
    if (!me?.avatarVariantKept) return;
    regenerateAvatar(me, random).catch(() => studio().notify(WORDS.regenerateFailed, ToastTone.Error));
  };
  return { available: me?.avatarVariantKept === true, regenerate };
}

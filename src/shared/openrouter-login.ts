/**
 * OpenRouter's browser sign-in, as the renderer sees it: one call that settles when the person
 * has approved Genex on OpenRouter (and the key is saved), cancelled it, or it failed. The key
 * itself stays in main.
 */

/** How a browser sign-in ended. */
export const OpenRouterSignInOutcome = {
  Connected: "connected",
  Cancelled: "cancelled",
  Failed: "failed",
} as const;
export type OpenRouterSignInOutcome = (typeof OpenRouterSignInOutcome)[keyof typeof OpenRouterSignInOutcome];

/** The end of one browser sign-in; a failure says why, in words for the person. */
export type OpenRouterSignInResult =
  | { outcome: typeof OpenRouterSignInOutcome.Connected }
  | { outcome: typeof OpenRouterSignInOutcome.Cancelled }
  | { outcome: typeof OpenRouterSignInOutcome.Failed; error: string };

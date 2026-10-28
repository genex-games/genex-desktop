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

/** Why a browser sign-in failed. Never rename a value. */
export const OpenRouterSignInProblem = {
  /** The person did not approve Genex on OpenRouter. */
  Denied: "denied",
  /** OpenRouter answered the code without a key. */
  NoKey: "no_key",
  /** OpenRouter could not be reached to redeem the code. */
  Unreachable: "unreachable",
  /** Nobody came back from the browser in time. */
  Expired: "expired",
  NoBrowser: "no_browser",
  /** The loopback callback could not listen. */
  NoCallback: "no_callback",
  /** The key came back, but checking it did not leave OpenRouter ready. */
  KeyRefused: "key_refused",
  /** The key came back, but keeping it failed. */
  KeyNotSaved: "key_not_saved",
} as const;
export type OpenRouterSignInProblem = (typeof OpenRouterSignInProblem)[keyof typeof OpenRouterSignInProblem];

/** The end of one browser sign-in; a failure says why, in words for the person and as a problem. */
export type OpenRouterSignInResult =
  | { outcome: typeof OpenRouterSignInOutcome.Connected }
  | { outcome: typeof OpenRouterSignInOutcome.Cancelled }
  | { outcome: typeof OpenRouterSignInOutcome.Failed; error: string; problem: OpenRouterSignInProblem };

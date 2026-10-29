/**
 * Building with Genex (owner, 2026-10-28): the app's third way to build, beside the person's own
 * Claude and ChatGPT plans. The same Claude Code runs, its calls go through the app's relay to
 * genex.games, and genex.games bills them to the person's Genex credits. genex.games owns the
 * plan, the price and the models; the app keeps the routes it calls, the access words it reads,
 * and the three models to show before genex.games has answered.
 */

/** What genex.games says the account may do now (`GET /api/desktop/llm/status`). Wire values. */
export const GenexAccess = {
  Ready: "ready",
  SignIn: "sign_in",
  VerifyEmail: "verify_email",
  NeedsPlan: "needs_plan",
  OutOfCredits: "out_of_credits",
  Paused: "paused",
} as const;
export type GenexAccess = (typeof GenexAccess)[keyof typeof GenexAccess];

const ACCESS_VALUES: ReadonlySet<string> = new Set(Object.values(GenexAccess));

/** True for an access word genex.games sends. */
export function isGenexAccess(value: unknown): value is GenexAccess {
  return typeof value === "string" && ACCESS_VALUES.has(value);
}

/** The genex.games routes building with Genex calls. The two Messages routes are the whole upstream. */
export const GenexBuildRoute = {
  Status: "/api/desktop/llm/status",
  Messages: "/api/desktop/llm/v1/messages",
  CountTokens: "/api/desktop/llm/v1/messages/count_tokens",
} as const;

/** The genex.games page that signs the person in and lets them pick Pro or a credit pack. */
export const GENEX_BUILD_PAGE = "/desktop/build";

/** The most of the waiting message the build page shows back; the page cuts it there too. */
export const GENEX_IDEA_MAX_CHARS = 300;

/** One model building with Genex offers. */
export interface GenexModel {
  readonly id: string;
  readonly label: string;
}

/** Sonnet, the default and every helper's model. */
export const GENEX_HELPER_MODEL = "sonnet-5.5-medium-or";

/**
 * The models genex.games offers, in its order (owner: Sonnet by default, then Opus, then GPT-6
 * Sol), for the menu before its first answer. genex.games's own list wins once it has answered.
 */
export const GENEX_MODELS: readonly GenexModel[] = [
  { id: GENEX_HELPER_MODEL, label: "Sonnet 5.5" },
  { id: "opus-5.5-medium-or", label: "Opus 5.5" },
  { id: "gpt-6-sol-medium-or", label: "GPT-6 Sol" },
];

/**
 * The build page on `web`: with the app's sign-in `code` while it is not signed in, and the
 * waiting message in the fragment, which never reaches a server.
 */
export function genexBuildPage(web: string, options: { code?: string; idea?: string } = {}): string {
  const url = new URL(GENEX_BUILD_PAGE, web);
  if (options.code) url.searchParams.set("code", options.code);
  const idea = options.idea?.trim().slice(0, GENEX_IDEA_MAX_CHARS);
  if (idea) url.hash = new URLSearchParams({ idea }).toString();
  return url.toString();
}

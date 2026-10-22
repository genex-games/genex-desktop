/**
 * The app's Genex account as every surface reads it (the sidebar's plate, Settings, Publish): the
 * account belongs to the app, so the Genex plugin being off never changes it, and only genex.games
 * refusing its token ends a sign-in. Going offline changes nothing here.
 */

/** Where the app's Genex account stands. Wire values: never rename one. */
export const GenexAccountStatus = {
  /** No account on this Mac. */
  SignedOut: "signed-out",
  /** A sign-in waits for the person to finish it in their browser. */
  SigningIn: "signing-in",
  SignedIn: "signed-in",
  /** Signed in, but genex.games no longer takes the token: the person signs in again. */
  Ended: "ended",
} as const;
export type GenexAccountStatus = (typeof GenexAccountStatus)[keyof typeof GenexAccountStatus];

/** The account as main tells it. */
export interface GenexAccountView {
  status: GenexAccountStatus;
  /** While signing in from the app: the code the browser shows, so the person knows it is this Mac's. */
  code?: string;
  /** Signed in, with Genex's updated terms still to accept on genex.games: the sidebar offers Review. */
  termsPending?: true;
}

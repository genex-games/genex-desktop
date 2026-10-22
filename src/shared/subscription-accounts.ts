/**
 * The accounts a subscription (Claude Code, Codex) can run on, as Settings and the composer's usage
 * panel show them. Only the renderer reads these: an email is the person's own, never the harness's.
 */

/** Where a new sign-in goes: an account's id, or one more account. */
export const NEW_ACCOUNT = "new";

/** One account of a subscription. */
export interface SubscriptionAccountView {
  /** `terminal`, `studio` or `account-N` (`substrate/engines/subscription-accounts.ts`). */
  id: string;
  /** The account's email when its CLI reported one. */
  email: string | null;
  /** The CLI's own login, as used in Terminal. */
  terminal: boolean;
  /** Whether its home holds a sign-in. A presence check, so an expired one still reads as signed in. */
  signedIn: boolean;
  /** The account the subscription runs on. */
  active: boolean;
}

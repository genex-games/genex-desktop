/**
 * The app's Genex account in a fixture launch: signed in as the fixture account the launch asked
 * for (`STUDIO_FIXTURE_GENEX_ACCOUNT`), else signed out. A sign-in opens no page: it waits as if in
 * the browser and is approved after a moment, as the full fixture account; Cancel stops it, and
 * signing out forgets the account until the next launch. No socket, no Keychain.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { PluginAccountState } from "../../shared/plugins.ts";
import type { GenexAccountPort } from "../core/genex-account.ts";
import { FixtureAccount, fixtureAccountToken } from "./fixture-people.ts";

/** How long a fixture sign-in waits "in the browser" before it is approved: long enough to look at. */
export const FIXTURE_SIGN_IN_MS = 6 * SECOND_MS;
/** The code a fixture sign-in shows. */
export const FIXTURE_SIGN_IN_CODE = "GNX-4821";

/** The fixture launch's account, signed in as `account` (or signed out), on `now`'s clock. */
export function fixtureAccountPort(account: FixtureAccount | null, now: () => number): GenexAccountPort {
  let signedIn = account;
  /** When the sign-in under way is approved, or null while none is. */
  let approvesAt: number | null = null;
  const settle = (): void => {
    if (approvesAt === null || now() < approvesAt) return;
    approvesAt = null;
    signedIn = FixtureAccount.Full;
  };
  return {
    state: async () => {
      settle();
      if (approvesAt !== null) return PluginAccountState.Authorizing;
      return signedIn ? PluginAccountState.Unlocked : PluginAccountState.NotConnected;
    },
    token: async () => {
      settle();
      return signedIn ? fixtureAccountToken(signedIn) : undefined;
    },
    connect: async () => {
      settle();
      if (signedIn) return {};
      approvesAt ??= now() + FIXTURE_SIGN_IN_MS;
      return { userCode: FIXTURE_SIGN_IN_CODE };
    },
    cancel: async () => {
      approvesAt = null;
    },
    disconnect: async () => {
      approvesAt = null;
      signedIn = null;
    },
    // A fixture launch's Genex is as the fixture set it up.
    signedIn: async () => {},
    termsPending: async () => signedIn === FixtureAccount.Terms,
  };
}

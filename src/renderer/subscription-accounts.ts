/**
 * A subscription's accounts as the renderer shows them: their names, and the hook that reads them
 * from main. Switching and adding go through `useAccountActions`, which signs in on the web when the
 * account switched to is not signed in.
 */
import { useCallback, useState } from "react";
import { EngineStatusCode } from "../shared/engine-descriptor.ts";
import { NEW_ACCOUNT, type SubscriptionAccountView } from "../shared/subscription-accounts.ts";
import { useAsyncEffect } from "./use-async-effect.ts";
import { PROVIDER_ACCOUNT_WORDS } from "./words.ts";

/** An added account's id: `account-N`. */
const ADDED_ID = /^account-(\d+)$/;

/** What an account is called: its email, else the Terminal login, Studio's account or "Account N". */
export function accountLabel(account: Pick<SubscriptionAccountView, "id" | "email" | "terminal">): string {
  if (account.email) return account.email;
  if (account.terminal) return PROVIDER_ACCOUNT_WORDS.terminal;
  const added = ADDED_ID.exec(account.id);
  return added ? PROVIDER_ACCOUNT_WORDS.numbered(Number(added[1])) : PROVIDER_ACCOUNT_WORDS.studio;
}

/** The account a subscription runs on, if it lists one. */
export function activeAccount(accounts: readonly SubscriptionAccountView[]): SubscriptionAccountView | null {
  return accounts.find((account) => account.active) ?? null;
}

/**
 * A subscription's accounts, read again whenever `key` changes (an engine refresh hands a new
 * descriptor) and after `reload`. Empty until read, and when main cannot list them.
 */
export function useSubscriptionAccounts(
  engine: string,
  key: unknown,
): { accounts: SubscriptionAccountView[]; reload: () => void } {
  const [accounts, setAccounts] = useState<SubscriptionAccountView[]>([]);
  const [round, setRound] = useState(0);
  useAsyncEffect(
    (alive) => {
      void window.studio
        .subscriptionAccounts?.(engine)
        .then((next) => {
          if (alive()) setAccounts(next);
        })
        .catch(() => {
          if (alive()) setAccounts([]);
        });
      return undefined;
    },
    [engine, key, round],
  );
  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { accounts, reload };
}

/**
 * Switch to an account, or add one: the switch runs the account from the next message on, and an
 * account that turns out signed out starts its web sign-in at once.
 */
export async function switchAccount(
  engine: string,
  account: string,
  signIn: (opts: { account: string }) => Promise<void>,
): Promise<void> {
  if (account === NEW_ACCOUNT) {
    await signIn({ account: NEW_ACCOUNT });
    return;
  }
  const status = await window.studio.subscriptionUseAccount(engine, account);
  if (status.code === EngineStatusCode.NeedsLogin) await signIn({ account });
}

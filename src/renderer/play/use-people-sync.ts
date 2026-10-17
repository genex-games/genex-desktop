/**
 * Keeps what the app knows of the Genex account current: who it is signed in as (read at start,
 * whenever plugins or connections change, when the window comes back to the front, when the Mac is
 * back online, every few seconds while a sign-in waits in the browser, and when a Genex generation
 * starts or stops waiting on Genex's updated terms) and, while signed in,
 * the Friends page, so the friends under the games show the game each is in and the count of
 * requests waiting stays true. The first sign-in retires Play's Genex card for good.
 */
import { useEffect } from "react";
import { GenexAccountStatus } from "../../shared/genex-account.ts";
import { GENEX_PLUGIN_ID, GenexPluginEvent } from "../../shared/genex.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { usePeople } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { useBackOnline } from "../ui/use-online.ts";
import { dismissPlayPromo, playPromoRetires } from "./play-model.ts";

/** How often the Friends page is read again while the sidebar lists the friends: what genex.games itself polls at. */
const FRIENDS_READ_MS = 20 * SECOND_MS;
/** How often the account is read while a sign-in waits in the browser, so the plate fills in by itself. */
const SIGN_IN_POLL_MS = 2 * SECOND_MS;

/** A Genex plugin event saying its account's terms began or stopped waiting for the person. */
function genexTermsEvent(payload: { id: string; event: unknown }): boolean {
  const event = payload.event as { kind?: unknown } | null;
  return payload.id === GENEX_PLUGIN_ID && event?.kind === GenexPluginEvent.Terms;
}

/** Read the account and, while signed in, the Friends page; mounted once, by the sidebar. */
export function usePeopleSync(): void {
  const signedIn = usePeople((s) => s.me?.id ?? null);
  const account = usePeople((s) => s.account);
  useEffect(() => {
    const people = studio().people;
    void people.loadMe();
    const reread = () => void people.loadMe();
    const unsubscribe = window.studio.onEvent((event) => {
      if (event.type === UiEvent.ConnectionsChanged || event.type === UiEvent.PluginsChanged) reread();
      // A Genex generation began or stopped waiting on the terms: the sidebar's line shows it at once.
      if (event.type === UiEvent.PluginEvent && genexTermsEvent(event.payload)) reread();
    });
    window.addEventListener("focus", reread);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", reread);
    };
  }, []);
  // Back online, everything the account shows reads again by itself.
  useBackOnline(() => {
    const people = studio().people;
    void people.loadMe().then(() => people.loadFriends());
  });
  useEffect(() => {
    if (account !== GenexAccountStatus.SigningIn) return;
    const timer = window.setInterval(() => void studio().people.loadMe(), SIGN_IN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [account]);
  useEffect(() => {
    if (playPromoRetires(account)) dismissPlayPromo();
  }, [account]);
  useEffect(() => {
    if (!signedIn) return;
    const people = studio().people;
    void people.loadFriends();
    const timer = window.setInterval(() => void people.loadFriends(), FRIENDS_READ_MS);
    return () => window.clearInterval(timer);
  }, [signedIn]);
}

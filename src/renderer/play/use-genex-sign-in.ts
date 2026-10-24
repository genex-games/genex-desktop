/**
 * The presses of the app's Genex account, one path for each place that offers them (the plate, the
 * card in Play's sidebar, Settings, Publish, a game's guest card): sign in in the browser, cancel a
 * sign-in that waits there, and sign out. A press that fails says so in a toast and changes nothing.
 */
import { useCallback, useEffect, useState } from "react";
import { usePlay } from "../state/hooks.ts";
import { installAnswered } from "../state/play.ts";
import { studio } from "../state/studio.ts";
import { ToastTone } from "../state/toasts.ts";
import { PLAY_WORDS } from "../words.ts";

const WORDS = PLAY_WORDS.people;

/** Sign in to Genex in the browser; a failure is a toast. */
export async function signInToGenex(): Promise<void> {
  try {
    await studio().people.signIn();
  } catch {
    studio().notify(WORDS.signInFailed, ToastTone.Error);
  }
}

/** Stop a sign-in that waits in the browser; a failure is a toast. */
export async function cancelGenexSignIn(): Promise<void> {
  try {
    await studio().people.cancelSignIn();
  } catch {
    studio().notify(WORDS.cancelFailed, ToastTone.Error);
  }
}

/** Sign in, busy while main opens the browser (a second press waits for the first). */
export function useGenexSignIn(): { busy: boolean; signIn: () => void } {
  const [busy, setBusy] = useState(false);
  const signIn = useCallback(() => {
    if (busy) return;
    setBusy(true);
    void signInToGenex().finally(() => setBusy(false));
  }, [busy]);
  return { busy, signIn };
}

/** Signs in once for each time a game's guest card asked to (its viewer has closed by then). */
export function useGuestSignIn(): void {
  const asked = usePlay((s) => s.installAsked);
  useEffect(() => {
    if (!asked) return;
    studio().play.setState(installAnswered, true);
    void signInToGenex();
  }, [asked]);
}

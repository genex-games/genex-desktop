/**
 * Sign out's question, asked in Studio wherever Sign out is pressed (the plate's menu, Settings):
 * the app and the Genex plugin sign out together, since they share one account.
 */
import type { JSX } from "react";
import { useState } from "react";
import { studio } from "../state/studio.ts";
import { Button } from "../ui/Button.tsx";
import { DialogSurface } from "../ui/dialog.tsx";
import { PLAY_WORDS } from "../words.ts";

const WORDS = PLAY_WORDS.people;

/** Cancel or Sign out; it closes once signed out, and says so when it could not. */
export function SignOutDialog({ onDismiss }: { onDismiss: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const signOut = (): void => {
    setBusy(true);
    setFailed(false);
    void studio()
      .people.signOut()
      .then(onDismiss, () => setFailed(true))
      .finally(() => setBusy(false));
  };
  return (
    <DialogSurface
      title={WORDS.signOutTitle}
      description={WORDS.signOutText}
      size="sm"
      testId="genex-sign-out"
      dismissible={!busy}
      onDismiss={() => {
        if (!busy) onDismiss();
      }}
    >
      {failed && (
        <p role="alert" className="text-xs text-red">
          {WORDS.signOutFailed}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onDismiss}>
          {WORDS.cancel}
        </Button>
        <Button variant="default" busy={busy} data-genex-sign-out onClick={signOut}>
          {WORDS.signOut}
        </Button>
      </div>
    </DialogSurface>
  );
}

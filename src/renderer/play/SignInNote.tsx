/**
 * A Play page that needs the Genex account while it is signed out: what the page needs it for, and
 * Sign in, which signs in in the browser as the plate does.
 */
import type { JSX } from "react";
import { Button } from "../ui/Button.tsx";
import { PLAY_WORDS } from "../words.ts";
import { useGenexSignIn } from "./use-genex-sign-in.ts";

/** `text`, then Sign in. */
export function SignInNote({ text }: { text: string }): JSX.Element {
  const { busy, signIn } = useGenexSignIn();
  return (
    <div className="people-note" data-sign-in-note>
      {text}
      <Button variant="secondary" disabled={busy} onClick={signIn}>
        {PLAY_WORDS.people.signIn}
      </Button>
    </div>
  );
}

/**
 * One save from a card-menu dialog: busy while it runs, its failure kept as the line the dialog
 * shows, and the dialog closed with a toast once it went through.
 */
import { useRef, useState } from "react";
import type { PlayChangeResult, PlayGameChange } from "../../../shared/play-manage.ts";
import type { PlayGame } from "../../../shared/play.ts";
import { studio } from "../../state/studio.ts";
import { ToastTone } from "../../state/toasts.ts";

/** A dialog's save: `run` sends `change` for `game`, says `done` and closes; a failure shows `failed`. */
export function useChange(game: PlayGame, onClose: () => void, failed: string) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A second press before the first answer must not send the change twice.
  const running = useRef(false);
  const run = async (
    change: PlayGameChange,
    done: (result: PlayChangeResult) => string,
  ): Promise<PlayChangeResult | null> => {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const result = await studio().play.manage(game, change);
      studio().notify(done(result), ToastTone.Ok);
      onClose();
      return result;
    } catch {
      setProblem(failed);
      return null;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, problem, failed: problem !== null, run };
}

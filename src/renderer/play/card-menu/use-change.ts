/**
 * One save from a card-menu dialog: busy while it runs, its failure (or why genex.games kept the
 * game as it was) kept as the line the dialog shows, and the dialog closed with a toast once it went
 * through.
 */
import { useRef, useState } from "react";
import { type PlayChangeResult, PlayChangeOutcome, type PlayGameChange } from "../../../shared/play-manage.ts";
import type { PlayGame } from "../../../shared/play.ts";
import { studio } from "../../state/studio.ts";
import { ToastTone } from "../../state/toasts.ts";

/**
 * A dialog's save: `run` sends `change` for `game`, says `done` and closes; a failure shows `failed`,
 * and a change genex.games kept back shows what `kept` says of it (else `failed`), the dialog open.
 */
export function useChange(game: PlayGame, onClose: () => void, failed: string) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A second press before the first answer must not send the change twice.
  const running = useRef(false);
  const run = async (
    change: PlayGameChange,
    done: (result: PlayChangeResult) => string,
    kept?: (result: PlayChangeResult) => string | undefined,
  ): Promise<PlayChangeResult | null> => {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const result = await studio().play.manage(game, change);
      if (result.outcome !== PlayChangeOutcome.Done) {
        setProblem(kept?.(result) ?? failed);
        return result;
      }
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

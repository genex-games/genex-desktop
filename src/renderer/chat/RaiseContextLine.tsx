/** Ollama's small default context refused a turn: one quiet line offering Raise context to 16K. */
import { type JSX, useState } from "react";
import type { Entry, EntryKind } from "../chat-entries.ts";
import { parseModelKey } from "../model-key.ts";
import { studio } from "../state/studio.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { ResultButton } from "../ui/ResultButton.tsx";
import { appRaiseContextDeps, raiseContext } from "./raise-context.ts";
import { raisedContextDone, TRANSCRIPT_WORDS } from "../words.ts";

/**
 * "Genex can copy qwen3:8b to run with a 16K context…" with Raise context to 16K: Ollama makes
 * the copy, the chat switches to it, and the line says so. A failure is toasted and the button
 * stays, so the person can try again.
 */
export function RaiseContextLine({
  entry,
  onUseModel,
  onNotice,
}: {
  entry: Extract<Entry, { kind: typeof EntryKind.Action }>;
  onUseModel?: (key: string) => void;
  onNotice: Notify;
}): JSX.Element {
  const [raising, setRaising] = useState(false);
  const [copy, setCopy] = useState<string | null>(null);
  const model = entry.raiseContext;
  const raise = async (): Promise<void> => {
    if (!model || raising) return;
    setRaising(true);
    try {
      const key = await raiseContext(
        model,
        appRaiseContextDeps(() => studio().engines.refresh()),
      );
      onUseModel?.(key);
      setCopy(parseModelKey(key).model);
    } catch (err) {
      notifyProblem(onNotice)(err);
    } finally {
      setRaising(false);
    }
  };
  return (
    <div data-raise-context className="min-w-0 text-chat text-ink-3 [overflow-wrap:anywhere]">
      <span>{copy ? raisedContextDone(copy) : entry.text}</span>
      {/* A space before the button, not a margin: at a line break it collapses, so a wrapped button starts flush. */}
      {!copy && model && onUseModel && (
        <span>
          {" "}
          <ResultButton type="button" className="align-middle" disabled={raising} onClick={() => void raise()}>
            {raising ? TRANSCRIPT_WORDS.raisingContext : TRANSCRIPT_WORDS.raiseContext}
          </ResultButton>
        </span>
      )}
    </div>
  );
}

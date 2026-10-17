/** A game's engine link in its chat: one quiet line, with Undo while it is the game's newest link. */
import { type JSX, useState } from "react";
import type { Entry, EntryKind } from "../chat-entries.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { ResultButton } from "../ui/ResultButton.tsx";
import { TRANSCRIPT_WORDS } from "../words.ts";

/**
 * "Lantern Run now builds in Unreal · Lantern", then what Undo did once it ran. Undo flows after
 * the line's last word, as text does, so a long line doesn't push it onto a row of its own.
 */
export function EngineLinkLine({
  entry,
  threadId,
  onNotice,
}: {
  entry: Extract<Entry, { kind: typeof EntryKind.Action }>;
  threadId: string | null;
  onNotice: Notify;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const link = entry.engineLink;
  const undo = () => {
    if (!link || busy) return;
    setBusy(true);
    void window.studio
      .undoEngineLink({ ...link, ...(threadId ? { threadId } : {}) })
      .catch(notifyProblem(onNotice))
      .finally(() => setBusy(false));
  };
  return (
    <div data-engine-link className="min-w-0 text-chat text-ink-3 [overflow-wrap:anywhere]">
      <span>{entry.text}</span>
      {/* A space, not a margin: at a line break it collapses, so a wrapped Undo starts flush. */}
      {link ? " " : null}
      {link ? (
        <ResultButton
          type="button"
          className="align-middle"
          title={TRANSCRIPT_WORDS.engineUndoTitle}
          disabled={busy}
          onClick={undo}
        >
          {TRANSCRIPT_WORDS.engineUndo}
        </ResultButton>
      ) : null}
      {entry.outcome ? <span> {entry.outcome}</span> : null}
    </div>
  );
}

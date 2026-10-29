/** A rewind that put game files back: one quiet line, with Bring back newer version while the chat offers it. */
import { type JSX, useState } from "react";
import type { Entry, EntryKind } from "../chat-entries.ts";
import type { Notify } from "../state/toasts.ts";
import { ResultButton } from "../ui/ResultButton.tsx";
import { TRANSCRIPT_WORDS } from "../words.ts";
import { bringBackNewer } from "./rewind-undo.ts";

/**
 * "The chat went back, and 2 game files with it", then what bringing the newer version back did.
 * The button flows after the line's last word, as the engine link's Undo does.
 */
export function RewindLine({
  entry,
  threadId,
  onNotice,
}: {
  entry: Extract<Entry, { kind: typeof EntryKind.Action }>;
  threadId: string | null;
  onNotice: Notify;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const rewindId = entry.rewindUndo;
  const offered = Boolean(rewindId && threadId);
  const bringBack = () => {
    if (!rewindId || !threadId || busy) return;
    setBusy(true);
    void bringBackNewer(window.studio, { threadId, rewindId }, onNotice).finally(() => setBusy(false));
  };
  return (
    <div data-rewind-line className="min-w-0 text-chat text-ink-3 [overflow-wrap:anywhere]">
      <span>{entry.text}</span>
      {/* A space, not a margin: at a line break it collapses, so a wrapped button starts flush. */}
      {offered ? " " : null}
      {offered ? (
        <ResultButton
          type="button"
          data-rewind-undo
          className="align-middle"
          title={TRANSCRIPT_WORDS.rewindUndoTitle}
          disabled={busy}
          onClick={bringBack}
        >
          {TRANSCRIPT_WORDS.rewindUndo}
        </ResultButton>
      ) : null}
      {entry.outcome ? <span> {entry.outcome}</span> : null}
    </div>
  );
}

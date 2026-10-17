/** A worker a lead started, in its chat: one quiet line naming its task, rewritten as it ends. */
import type { JSX } from "react";
import type { Entry, EntryKind } from "../chat-entries.ts";
import { StepMark } from "./StepMark.tsx";

/**
 * "Port the car…" while it works; "Ported the car. Added to your game." once the lead used it.
 * The mark is the setup card's, ticked once the work ended well. The line is text only.
 */
export function WorkerLine({ entry }: { entry: Extract<Entry, { kind: typeof EntryKind.Action }> }): JSX.Element {
  return (
    <div data-worker-line className="flex min-w-0 items-start gap-2.5 text-chat text-ink-3 [overflow-wrap:anywhere]">
      <StepMark done={entry.workerDone === true} />
      <span className="min-w-0 flex-1">{entry.text}</span>
    </div>
  );
}

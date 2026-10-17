/** Background work an agent started, in its chat: one quiet line, with Stop while it runs. */
import { type JSX, useState } from "react";
import type { Entry, EntryKind } from "../chat-entries.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { ResultButton } from "../ui/ResultButton.tsx";
import { useClockText } from "../use-polling.ts";
import { TRANSCRIPT_WORDS } from "../words.ts";
import { runningLine } from "./job-lines.ts";

/**
 * "In the background: Unreal build · 4 min" with Stop, the minutes kept current once a minute;
 * once the job ended, its outcome and no button. Stop flows after the line's last word, as the
 * engine link's Undo does.
 */
export function JobLine({
  entry,
  onNotice,
}: {
  entry: Extract<Entry, { kind: typeof EntryKind.Action }>;
  onNotice: Notify;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const job = entry.job;
  const line = useClockText<HTMLSpanElement>((now) => runningLine(entry, now), MINUTE_MS);
  const stop = () => {
    if (!job || busy) return;
    setBusy(true);
    void window.studio
      .stopJob(job.project, job.jobId)
      .catch(notifyProblem(onNotice))
      .finally(() => setBusy(false));
  };
  return (
    <div data-job-line className="min-w-0 text-chat text-ink-3 [overflow-wrap:anywhere]">
      <span ref={line} />
      {/* A space, not a margin: at a line break it collapses, so a wrapped Stop starts flush. */}
      {job ? " " : null}
      {job ? (
        <ResultButton
          type="button"
          className="align-middle"
          title={TRANSCRIPT_WORDS.jobStopTitle}
          disabled={busy}
          onClick={stop}
        >
          {TRANSCRIPT_WORDS.jobStop}
        </ResultButton>
      ) : null}
    </div>
  );
}

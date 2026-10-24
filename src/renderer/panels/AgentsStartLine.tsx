/**
 * "Agents didn't start" with Try again, at the foot of the sidebar, while the open studio's
 * harness would not start: main keeps the studio, its games and Play (`state/agents-start.ts`).
 * The line's name opens why, with the raw error and Send a report; Try again reads "Starting
 * agents" until it ends, and the line goes once the agents start.
 */
import type { JSX } from "react";
import { useId, useState } from "react";
import { SetupReport } from "../state/boot.ts";
import { useAgentsStart } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { AGENTS_START_WORDS as WORDS } from "../words.ts";

export function AgentsStartLine(): JSX.Element | null {
  const failure = useAgentsStart((s) => s.failure);
  const retrying = useAgentsStart((s) => s.retrying);
  const report = useAgentsStart((s) => s.report);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  if (failure === null) return null;
  const agents = studio().agentsStart;
  return (
    <div className="agents-start" data-agents-start={retrying ? "starting" : "failed"}>
      <div className="agents-start-line">
        <button
          type="button"
          className="agents-start-label"
          aria-label={WORDS.detailsLabel}
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((was) => !was)}
          data-agents-start-details-toggle
        >
          <span className={retrying ? "min-w-0 flex-1 truncate chat-status-shimmer" : "min-w-0 flex-1 truncate"}>
            {retrying ? WORDS.starting : WORDS.line}
          </span>
        </button>
        {!retrying && (
          <button
            type="button"
            className="agents-start-retry"
            onClick={() => void agents.retry()}
            data-agents-start-retry
          >
            {WORDS.tryAgain}
          </button>
        )}
      </div>
      {open && (
        <div id={detailsId} className="agents-start-details" data-agents-start-details>
          <pre className="agents-start-error">{failure}</pre>
          <AgentsReport report={report} onReport={() => void agents.report()} />
        </div>
      )}
    </div>
  );
}

/** Send a report, then "Sending…", then a bare ✓; a report that did not send says so and offers it again. */
function AgentsReport({ report, onReport }: { report: SetupReport; onReport: () => void }): JSX.Element {
  if (report === SetupReport.Sent) {
    return (
      <span role="img" aria-label={WORDS.sent} className="agents-start-sent" data-agents-start-report={report}>
        ✓
      </span>
    );
  }
  if (report === SetupReport.Sending) {
    return (
      <span className="agents-start-note" data-agents-start-report={report}>
        {WORDS.sending}
      </span>
    );
  }
  return (
    <div className="agents-start-report">
      <button type="button" className="agents-start-send" onClick={onReport} data-agents-start-report={report}>
        {WORDS.report}
      </button>
      {report === SetupReport.Failed && <span className="agents-start-note">{WORDS.reportFailed}</span>}
    </div>
  );
}

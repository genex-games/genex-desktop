/**
 * When a command the user ran from a reply ends, the chat that offered it tells the agent how it
 * went, behind the scenes (a message the transcript never draws), so the agent carries on without
 * anyone retyping the output.
 * A command the user stopped, or one that could not start, is left for the user to explain. A
 * chat that is not open when its command ends reports it when it opens again.
 */
import { useEffect, useRef } from "react";
import { endedRuns, reportsResult, runsSettled } from "../state/command-runs.ts";
import { studio } from "../state/studio.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { commandResultWords } from "../words.ts";
import { MessageOrigin } from "../../shared/protocol.ts";
import { commandState } from "../state/command-runs.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";

export function useCommandResults(
  threadId: string | null,
  enabled: boolean,
  report: (text: string, origin: MessageOrigin) => Promise<void>,
  onNotice: Notify,
): void {
  const send = useRef(report);
  send.current = report;
  const notice = useRef(onNotice);
  notice.current = onNotice;
  useEffect(() => {
    if (!threadId || !enabled) return;
    const store = studio().commandRuns;
    const report = (): void => {
      const ended = endedRuns(store.getState(), threadId);
      if (!ended.length) return;
      // Settled before sending, so the store update the send causes cannot report it twice.
      store.setState(
        (state) =>
          runsSettled(
            state,
            ended.map(({ run }) => run.sessionId),
          ),
        true,
      );
      for (const { run, session } of ended) {
        const reported = reportsResult(session);
        track(AnalyticsEvent.ChatCommandRun, { state: commandState(session), reported });
        if (reported)
          void send
            .current(commandResultWords(run.command, session), MessageOrigin.CommandResult)
            .catch(notifyProblem(notice.current));
      }
    };
    report();
    return store.subscribe(report);
  }, [threadId, enabled]);
}

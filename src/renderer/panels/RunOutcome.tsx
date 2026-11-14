import { RunCapture } from "../chat/RunCapture.tsx";
import { ResultButton } from "../ui/ResultButton.tsx";
import type { JSX } from "react";
import { useState } from "react";
import { ExecutionStatus } from "../../shared/run-state.ts";
import { inGameVersion, summaryOutcome, type RunSummary } from "../../shared/run-summary.ts";
import { t } from "../../shared/i18n.ts";
import { OUTCOME_WORDS, outcomeTitle } from "../words.ts";
import { Icon } from "../ui/icons.tsx";
import { FileText } from "../ui/FileText.tsx";
import { openBuildGraph } from "../open-build.ts";
import { workedShortWords } from "../run-steps.ts";
import { BuildCard } from "../chat/BuildCard.tsx";

/** Did the run leave a build of its own (a head that moved past where it started)? */
const hasNewBuild = (summary: RunSummary): boolean => Boolean(summary.head) && summary.head !== summary.base;

/**
 * The chat card's one name for the build. A stopped build's card says so in its own line, next to
 * Resume; this card only names the build. A finished run whose merged build did not reach the game
 * is not "no new build": it is not live yet.
 */
function chatOutcomeTitle(summary: RunSummary): string {
  const newBuild = hasNewBuild(summary);
  const stopped = summary.execution === ExecutionStatus.Paused || summary.execution === ExecutionStatus.Cancelled;
  if (stopped) return newBuild ? t("Latest build") : t("No new build");
  const view = summaryOutcome(summary);
  if (view.state === "finished" && view.delivered === "none" && newBuild) return t("Not live yet");
  return outcomeTitle(view, "chat");
}

/**
 * The card's second line: the checks that failed, the parts that went in, and how long it took.
 * Failed checks lead, so a narrow chat's ellipsis never hides them; the card itself opens Builds,
 * so they need no pointer there.
 */
function outcomeLine(summary: RunSummary, failedChecks: number, duration: string | null): string {
  const added = summary.tasks.filter((task) => task.integrations > 0).length;
  return [
    failedChecks ? t("{count, plural, one {# check} other {# checks}} failed", { count: failedChecks }) : "",
    added ? t("{count, plural, one {# part} other {# parts}} added", { count: added }) : "",
    duration ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function PlayButton({ onPlay }: { onPlay: () => void | Promise<void> }): JSX.Element {
  const [playing, setPlaying] = useState(false);
  return (
    <ResultButton
      className="w-fit"
      disabled={playing}
      onClick={async () => {
        setPlaying(true);
        try {
          await onPlay();
        } finally {
          setPlaying(false);
        }
      }}
    >
      <Icon name="play" size={12} className="fill-current" />
      {playing ? t("Opening…") : t("Play")}
    </ResultButton>
  );
}

/**
 * The build's outcome as the chat tells it — the same card the running build was, now finished:
 * its picture, what happened, one line of what went in and how long it took, and Play on the
 * right. The whole card opens the build on Builds, so nothing wraps under it on a narrow chat.
 */
export function RunOutcome({
  summary,
  onPlay,
  capturePath,
}: {
  summary: RunSummary;
  /** kept for callers that name the chat form; it is the only form */
  conversation?: boolean;
  capturePath?: string | null;
  onPlay?: () => void | Promise<void>;
}): JSX.Element {
  const current = summary.evidence.filter((e) => e.head === summary.head);
  const failed = current.filter((e) => e.status === "failed");
  // A version in the game is one line: which version, and Play. The lead's own last message says what it holds.
  const version = inGameVersion(summary);
  const title = version ? OUTCOME_WORDS.inGame(version) : chatOutcomeTitle(summary);
  const still = version
    ? null
    : (summary.captures?.current ?? capturePath ?? current.findLast((e) => e.capture)?.capture);
  const line = version ? "" : outcomeLine(summary, failed.length, workedShortWords(summary.worked));
  return (
    <section data-testid="run-outcome" data-chat-outcome className="flex min-w-0 flex-col gap-2 text-chat text-ink-3">
      {/* How this build was made: its graph on Builds, the one way back to an earlier build. */}
      <BuildCard
        data-outcome-card
        title={title || t("Build finished")}
        open={{ runId: summary.runId, onClick: () => openBuildGraph(summary.runId) }}
        {...(still ? { picture: <RunCapture key={still} path={still} compact /> } : {})}
        {...(version
          ? {
              picture: (
                <span aria-hidden="true" className="ps-3 text-ink">
                  <Icon name="check" size={14} />
                </span>
              ),
            }
          : {})}
        {...(line
          ? {
              line: (
                <p className={`m-0 truncate text-chat-sub ${failed.length ? "text-orange" : "text-ink-3"}`}>{line}</p>
              ),
            }
          : {})}
        {...(onPlay && hasNewBuild(summary) ? { aside: <PlayButton onPlay={onPlay} /> } : {})}
      />
      {summary.execution === ExecutionStatus.Failed && summary.reason && (
        <p role="alert" className="break-words text-orange">
          <FileText text={summary.reason} />
        </p>
      )}
    </section>
  );
}

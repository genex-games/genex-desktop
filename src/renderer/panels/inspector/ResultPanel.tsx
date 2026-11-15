/** The card of "Your build": which version of the game it is, its picture now and what is still open on it. */
import type { JSX } from "react";
import { t } from "../../../shared/i18n.ts";
import { inGameVersion, type RunSummary, summaryOutcome } from "../../../shared/run-summary.ts";
import {
  type FinalNode,
  finalNodeOf,
  plainDefect,
  type RunGraph as RunGraphModel,
  type RunNode,
} from "../../run-graph.ts";
import { elapsedWords, resultStatus, workedSpan } from "../../run-steps.ts";
import { endedWords } from "../../round-status.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/icons.tsx";
import { OUTCOME_WORDS, TOAST_WORDS } from "../../words.ts";
import { Panel, Para, Section } from "./chrome.tsx";
import { formatTime } from "./format.ts";
import { Single } from "./pictures.tsx";
import { GraphSelection } from "./selection.ts";
import { Status } from "./tone.tsx";
import type { InspectorProps } from "./types.ts";
import { type Notify, notifyProblem, ToastTone } from "../../state/toasts.ts";
import { webBuildShown } from "../../web-build-shown.ts";
import { track } from "../../analytics/client.ts";
import { AnalyticsEvent } from "../../analytics/events.ts";
import { BuildSurface } from "../../analytics/events/builds.ts";

/** Play this build from the result card, and say whether it played. */
function playBuild(build: { project: string; head: string }, refuse: (error: unknown) => void): void {
  const played = (ok: boolean) =>
    track(AnalyticsEvent.BuildPlayed, { surface: BuildSurface.ResultPanel, run_active: false, ok });
  void window.studio
    .showBuild(build.project, build.head)
    .then(() => {
      played(true);
      webBuildShown(build.project);
    })
    .catch((error: unknown) => {
      played(false);
      refuse(error);
    });
}

/** Make this build the game, and say whether it went. */
function landBuild(build: { project: string; head: string }, onNotice: Notify, refuse: (error: unknown) => void): void {
  void window.studio
    .landBuild(build.project, build.head)
    .then(() => {
      track(AnalyticsEvent.BuildMadeLive, { ok: true });
      onNotice(TOAST_WORDS.buildLive, ToastTone.Ok);
    })
    .catch((error: unknown) => {
      track(AnalyticsEvent.BuildMadeLive, { ok: false });
      refuse(error);
    });
}

/** The most open problems the panel lists. */
const STILL_OPEN_SHOWN = 5;

/** A delivered build whose current checks failed: the recorded outcome's own field, never its title. */
const checksNeedAttention = (outcome: RunSummary): boolean => {
  const view = summaryOutcome(outcome);
  return view.state === "finished" && view.delivered === "delivered" && view.verification === "attention";
};

/** A finished run whose merged build never became the game: it can still be played, or made live. */
function unlandedBuild(graph: RunGraphModel, final: FinalNode | null, run: RunNode) {
  if (graph.active || !final) return null;
  const head = final.integrationHead;
  const offLive = head && head !== final.baseCommit && final.landed === false;
  return offLive && run.project ? { project: run.project, head } : null;
}

function BuildActions({
  build,
  onNotice,
}: {
  build: { project: string; head: string } | null;
  onNotice: Notify;
}): JSX.Element | null {
  if (!build) return null;
  const refuse = notifyProblem(onNotice);
  return (
    <>
      <Button variant="default" onClick={() => playBuild(build, refuse)}>
        <Icon name="play" size={13} />
        {t("Play this build")}
      </Button>
      <Button onClick={() => landBuild(build, onNotice, refuse)}>{t("Make it live")}</Button>
    </>
  );
}

function StillOpen({ items }: { items: string[] }): JSX.Element | null {
  if (!items.length) return null;
  return (
    <Section label={t("Still open")}>
      {items.map((text, index) => (
        <span key={index} className="flex items-baseline gap-2 text-chat-sub text-ink-2">
          <span aria-hidden="true" className="size-1.5 shrink-0 -translate-y-0.5 rounded-full bg-orange" />
          <span className="[overflow-wrap:anywhere]">{text}</span>
        </span>
      ))}
    </Section>
  );
}

/** What is still open on the build on offer: its failed checks against that head, then the judges' defects. */
function stillOpenOf(outcome: RunSummary | null, final: FinalNode | null): string[] {
  const current = outcome ? outcome.evidence.filter((row) => row.head === outcome.head) : [];
  const failed = current.filter((row) => row.status === "failed" && row.category !== "comparison");
  return [...failed.map((row) => row.label), ...(final?.globalVerdict?.defects ?? []).map(plainDefect)]
    .filter(Boolean)
    .slice(0, STILL_OPEN_SHOWN);
}

/** The card's subtitle: when the run started or finished, and how long it worked. A paused run is not finished. */
function resultSub(graph: RunGraphModel, run: RunNode, outcome: RunSummary | null): string {
  const duration = workedSpan(outcome?.worked) ?? elapsedWords(run.startedAt, run.finishedAt);
  if (graph.active) {
    const time = formatTime(run.startedAt);
    return duration ? t("Started {time} · {duration} so far", { time, duration }) : t("Started {time}", { time });
  }
  if (run.paused) return duration ? t("Paused · {duration}", { duration }) : t("Paused");
  const time = formatTime(run.finishedAt ?? outcome?.endedAt ?? null);
  return duration ? t("Finished {time} · {duration}", { time, duration }) : t("Finished {time}", { time });
}

/**
 * The build's picture, now. A build still being tried has no picture of its own yet, and says so
 * rather than wear a part's.
 */
function ResultMedia({
  resultSrc,
  borrowed,
  onOpen,
}: {
  resultSrc: string | null;
  borrowed: boolean;
  onOpen: () => void;
}): JSX.Element {
  if (borrowed)
    return <Single src={null} label={t("Now")} empty={t("Checking the new build starts. Its picture comes next.")} />;
  return <Single src={resultSrc} label={t("Now")} onOpen={onOpen} />;
}

/** The card of the run's build: which version it is, its picture now, and what is still open on it. */
export function ResultPanel(props: InspectorProps): JSX.Element {
  const { graph, outcome, run, resultSrc, resultPath, resultBorrowed, onNotice } = props;
  const final = finalNodeOf(graph);
  // The node and its card say the same words about the same build.
  const status = resultStatus(graph, outcome);
  const version = outcome ? inGameVersion(outcome) : null;
  const yours = version ? OUTCOME_WORDS.inGame(version) : t("Your build");
  const title = graph.active ? t("Latest build") : yours;
  const ended = endedWords(graph);
  const open = (): void => {
    if (resultSrc)
      props.onLight(
        [{ path: resultPath, src: resultSrc, title, caption: t("camera: {camera}", { camera: "default" }) }],
        0,
      );
  };
  const attention = outcome && checksNeedAttention(outcome) ? t("checks need attention") : null;
  return (
    <Panel
      id={GraphSelection.Final}
      label={t("Your build")}
      title={title}
      sub={resultSub(graph, run, outcome)}
      status={
        <Status tone={status.tone} meta={attention}>
          {status.word}
        </Status>
      }
      onClose={props.onClose}
      reply={{ label: title, placeholder: t("Ask for a change to this build") }}
      onReply={props.onReply}
      actions={<BuildActions build={unlandedBuild(graph, final, run)} onNotice={onNotice} />}
      media={<ResultMedia resultSrc={resultSrc} borrowed={resultBorrowed} onOpen={open} />}
    >
      {ended ? <Para quiet>{ended}</Para> : null}
      <StillOpen items={stillOpenOf(outcome, final)} />
    </Panel>
  );
}

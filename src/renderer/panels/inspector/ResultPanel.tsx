/** The card of "Your build": before and now, the last look anybody took at it, the lead's summary and what is still open. */
import type { JSX } from "react";
import { useState } from "react";
import { type RunSummary, summaryOutcome } from "../../../shared/run-summary.ts";
import {
  type FinalNode,
  finalNodeOf,
  plainDefect,
  type RunGraph as RunGraphModel,
  type RunNode,
} from "../../run-graph.ts";
import { buildReview, elapsedWords, resultStatus, workedSpan } from "../../run-steps.ts";
import { endedWords } from "../../round-status.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/icons.tsx";
import { TOAST_WORDS } from "../../words.ts";
import { OutcomeChecks, OutcomeDetails } from "../RunOutcome.tsx";
import { Details, Panel, Para, Quote, Row, Rows, Section } from "./chrome.tsx";
import { formatTime, modelLine } from "./format.ts";
import { Compare, Single } from "./pictures.tsx";
import { GraphSelection } from "./selection.ts";
import { Status } from "./tone.tsx";
import type { InspectorProps } from "./types.ts";
import { type Notify, notifyProblem, ToastTone } from "../../state/toasts.ts";

/** The most open problems the panel lists. */
const STILL_OPEN_SHOWN = 5;
/** A summary longer than this is clamped until the user asks to read it all. */
const SUMMARY_CLAMP_CHARS = 220;

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
      <Button
        variant="default"
        onClick={() =>
          void window.studio
            .showBuild(build.project, build.head)
            .then(() => undefined)
            .catch(refuse)
        }
      >
        <Icon name="play" size={13} />
        Play this build
      </Button>
      <Button
        onClick={() =>
          void window.studio
            .landBuild(build.project, build.head)
            .then(() => onNotice(TOAST_WORDS.buildLive, ToastTone.Ok))
            .catch(refuse)
        }
      >
        Make it live
      </Button>
    </>
  );
}

function LeadSummary({ final }: { final: FinalNode | null }): JSX.Element | null {
  const [readAll, setReadAll] = useState(false);
  if (!final?.summary) return null;
  return (
    <Section label="The lead's summary" gap="gap-1">
      <p
        className={`text-chat-sub whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere] ${readAll ? "" : "line-clamp-4"}`}
      >
        {final.summary}
      </p>
      {final.summary.length > SUMMARY_CLAMP_CHARS ? (
        <button
          type="button"
          className="w-fit cursor-pointer text-body-sm text-accent-ink hover:underline"
          onClick={() => setReadAll((value) => !value)}
        >
          {readAll ? "Show less" : "Read all"}
        </button>
      ) : null}
    </Section>
  );
}

function StillOpen({ items }: { items: string[] }): JSX.Element | null {
  if (!items.length) return null;
  return (
    <Section label="Still open">
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

/** The paper trail, disclosed: what the studio learned, then counts, revisions and every recorded check. */
function ResultRows({
  graph,
  run,
  outcome,
}: {
  graph: RunGraphModel;
  run: RunNode;
  outcome: RunSummary | null;
}): JSX.Element {
  return (
    <Rows>
      {outcome?.learning ? (
        <Row label="What the studio learned" right={outcome.learning}>
          <Para quiet>Studio learning: {outcome.learning} — separate from game execution.</Para>
        </Row>
      ) : null}
      <Row label="Technical details">
        {outcome ? <OutcomeDetails summary={outcome} /> : null}
        <div className="mt-2">
          <Details
            rows={[
              ["run", graph.runId],
              ["model", modelLine(run.engine, run.model)],
            ]}
          />
        </div>
        {outcome ? (
          <div className="mt-3">
            <OutcomeChecks summary={outcome} />
          </div>
        ) : null}
      </Row>
    </Rows>
  );
}

/** The last look anybody took at the build on offer, in the words that look wrote. */
function LastLook({ graph }: { graph: RunGraphModel }): JSX.Element | null {
  const review = buildReview(graph);
  return review ? <Quote label={review.label}>{review.words}</Quote> : null;
}

/** The card's subtitle: when the run started or finished, and how long it worked. A paused run is not finished. */
function resultSub(graph: RunGraphModel, run: RunNode, outcome: RunSummary | null): string {
  const duration = workedSpan(outcome?.worked) ?? elapsedWords(run.startedAt, run.finishedAt);
  if (graph.active) return `Started ${formatTime(run.startedAt)}${duration ? ` · ${duration} so far` : ""}`;
  if (run.paused) return `Paused${duration ? ` · ${duration}` : ""}`;
  return `Finished ${formatTime(run.finishedAt ?? outcome?.endedAt ?? null)}${duration ? ` · ${duration}` : ""}`;
}

/**
 * The build's picture: before and now side by side, or now alone. A build still being tried has
 * no picture of its own yet, and says so rather than wear a part's.
 */
function ResultMedia({
  baseSrc,
  resultSrc,
  borrowed,
  onOpen,
}: {
  baseSrc: string | null;
  resultSrc: string | null;
  borrowed: boolean;
  onOpen: () => void;
}): JSX.Element {
  if (borrowed) return <Single src={null} label="Now" empty="Checking the new build starts. Its picture comes next." />;
  if (baseSrc && resultSrc)
    return <Compare left={baseSrc} right={resultSrc} leftLabel="Before" rightLabel="Now" onOpen={onOpen} />;
  return <Single src={resultSrc} label="Now" onOpen={onOpen} />;
}

/** The card of the run's build: the picture before and now, and everything said about it. */
export function ResultPanel(props: InspectorProps): JSX.Element {
  const { graph, outcome, run, baseSrc, resultSrc, resultPath, resultBorrowed, onNotice } = props;
  const final = finalNodeOf(graph);
  // The node and its card say the same words about the same build.
  const status = resultStatus(graph, outcome);
  const title = graph.active ? "Latest build" : "Your build";
  const ended = endedWords(graph);
  const open = (): void => {
    if (resultSrc) props.onLight([{ path: resultPath, src: resultSrc, title, caption: "camera: default" }], 0);
  };
  const attention = outcome && checksNeedAttention(outcome) ? "checks need attention" : null;
  return (
    <Panel
      id={GraphSelection.Final}
      label="Your build"
      title={title}
      sub={resultSub(graph, run, outcome)}
      status={
        <Status tone={status.tone} meta={attention}>
          {status.word}
        </Status>
      }
      nav={false}
      onPrev={props.onPrev}
      onNext={props.onNext}
      onClose={props.onClose}
      reply={{ label: title, placeholder: "Ask for a change to this build" }}
      onReply={props.onReply}
      actions={<BuildActions build={unlandedBuild(graph, final, run)} onNotice={onNotice} />}
      media={<ResultMedia baseSrc={baseSrc} resultSrc={resultSrc} borrowed={resultBorrowed} onOpen={open} />}
    >
      <LastLook graph={graph} />
      <LeadSummary final={final} />
      {ended ? <Para quiet>{ended}</Para> : null}
      <StillOpen items={stillOpenOf(outcome, final)} />
      <ResultRows graph={graph} run={run} outcome={outcome} />
    </Panel>
  );
}

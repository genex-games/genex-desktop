/**
 * The card of a part built in one session: its picture, who checked it, and what happened to it.
 * A worker's card says what the lead asked it, its own report and the lead's note, never how it
 * works in the game.
 */
import type { JSX } from "react";
import type { RunSummary, RunTask } from "../../../shared/run-summary.ts";
import { runIdOf } from "../../run-graph.ts";
import type { WorkerInfo } from "../../run-graph-workers.ts";
import {
  CheckedBy,
  Gate,
  STATE_TONE,
  type Step,
  StepState,
  stepPill,
  stepSentence,
  stoppedShort,
  workerStopWords,
} from "../../run-steps.ts";
import { stoppedWords, verdictSentence, WORKER_WORDS } from "../../words.ts";
import { useRoundStill } from "../run-stills.ts";
import { type DetailRow, Details, Panel, Para, Quote, Row, Rows } from "./chrome.tsx";
import { capitalise } from "./format.ts";
import { Single } from "./pictures.tsx";
import { LiveScreen, usePartScreen } from "./screen.tsx";
import { Status } from "./tone.tsx";
import type { StepPanelProps } from "./types.ts";

/** The recorded outcome's task for a part, when there is one. */
export const taskOf = (outcome: RunSummary | null, facetId: string): RunTask | null =>
  outcome?.tasks.find((item) => item.id === facetId) ?? null;

/** The technical rows a part's task adds: how often it merged and who built it. */
export const taskRows = (task: RunTask | null): DetailRow[] => [
  ["integrations", task ? String(task.integrations) : null],
  ["workers", task && task.workers.length > 1 ? task.workers.join(" → ") : null],
];

function WhoChecked({ step }: { step: Step }): JSX.Element | null {
  if (!step.checkedBy) return null;
  if (step.checkedBy !== CheckedBy.Judges)
    return (
      <Quote label="The lead">
        It merged this part's work without a reviewer's verdict. The reviewers score parts that build in steps; this one
        was built in one session.
      </Quote>
    );
  const preferred =
    step.gate === Gate.Kept ? "They preferred this build to the one before it." : "They preferred the build before it.";
  return <Quote label="Reviewers">{verdictSentence(step.verdict) || preferred}</Quote>;
}

/** A part's own account: who checked it, what happened to it, why it stopped short, its details. */
function PartAbout({ props, step }: { props: StepPanelProps; step: Step }): JSX.Element {
  const { graph, row, outcome } = props;
  const task = taskOf(outcome, step.facetId);
  const stopped = row.facet.stoppedBecause;
  return (
    <>
      <WhoChecked step={step} />
      <div className="flex flex-col gap-1.5">
        <Para>{stepSentence(step, graph.active)}</Para>
        {stoppedShort(stopped) ? <Para quiet>{capitalise(stoppedWords(stopped))}.</Para> : null}
      </div>
      <Rows>
        <Row label="Technical details">
          <Details
            rows={[["run", runIdOf(graph)], ["part", step.facetId], ...taskRows(task), ["state", task?.state ?? null]]}
          />
        </Row>
      </Rows>
    </>
  );
}

/**
 * A worker's account: the reviewers' word when they compared its build, what the lead asked it,
 * its own report, the lead's note, why it stopped short.
 */
function WorkerAbout({ step, worker }: { step: Step; worker: WorkerInfo }): JSX.Element {
  const failed = workerStopWords(worker);
  return (
    <>
      {step.verdict ? <WhoChecked step={step} /> : null}
      {worker.task ? <Quote label={WORKER_WORDS.asked}>{worker.task}</Quote> : null}
      {worker.summary ? <Para>{worker.summary}</Para> : null}
      {worker.note ? <Quote label={WORKER_WORDS.leadSaid}>{worker.note}</Quote> : null}
      {failed ? <Para quiet>{failed}.</Para> : null}
    </>
  );
}

/** The card of a part built in one session. */
export function SessionPanel(props: StepPanelProps): JSX.Element {
  const { graph, step } = props;
  const working = step.state === StepState.Building;
  const src = useRoundStill(graph, step.facetId, 1, null, working && graph.active);
  const screen = usePartScreen(props.project, runIdOf(graph), step.facetId, working && graph.active);
  return (
    <Panel
      id={step.id}
      label="Selected part"
      title={step.name}
      status={<Status tone={STATE_TONE[step.state]}>{stepPill(step, graph.active)}</Status>}
      onPrev={props.onPrev}
      onNext={props.onNext}
      onClose={props.onClose}
      reply={{ label: step.name, placeholder: "Anything to change here?", target: { facetId: step.facetId } }}
      onReply={props.onReply}
      media={
        screen.frame ? (
          <LiveScreen
            frame={screen.frame}
            trail={screen.trail}
            label={step.name}
            onOpen={(shown, caption) => props.onLight([{ path: null, src: shown, title: step.name, caption }], 0)}
          />
        ) : (
          <Single
            src={src}
            label={step.name}
            onOpen={src ? () => props.onLight([{ path: null, src, title: step.name, caption: "" }], 0) : undefined}
          />
        )
      }
    >
      {step.worker ? <WorkerAbout step={step} worker={step.worker} /> : <PartAbout props={props} step={step} />}
    </Panel>
  );
}

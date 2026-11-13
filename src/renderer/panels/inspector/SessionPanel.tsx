/**
 * The card of a part built in one session: its picture, who checked it, and what happened to it.
 * A worker's card says what it did in its own words, never what the lead asked it or noted about it.
 */
import { placedWord } from "../../run-graph-builds.ts";
import type { JSX } from "react";
import type { ProjectAsset } from "../../../shared/game-assets.ts";
import { t } from "../../../shared/i18n.ts";
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
import { stoppedWords, verdictSentence } from "../../words.ts";
import { useRoundStill, useWorkerStill } from "../run-stills.ts";
import { AssetThumbnail } from "../AssetThumbnail.tsx";
import { type DetailRow, Details, Panel, PanelRow, Para, Quote, Row, Rows } from "./chrome.tsx";
import { capitalise } from "./format.ts";
import { IMAGE_OUTLINE, Single } from "./pictures.tsx";
import { LiveScreen, usePartScreen } from "./screen.tsx";
import { Status } from "./tone.tsx";
import type { StepPanelProps } from "./types.ts";

/** The recorded outcome's task for a part, when there is one. */
const taskOf = (outcome: RunSummary | null, facetId: string): RunTask | null =>
  outcome?.tasks.find((item) => item.id === facetId) ?? null;

/** The technical rows a part's task adds: how often it merged and who built it. */
const taskRows = (task: RunTask | null): DetailRow[] => [
  [t("integrations"), task ? String(task.integrations) : null],
  [t("workers"), task && task.workers.length > 1 ? task.workers.join(" → ") : null],
];

function WhoChecked({ step }: { step: Step }): JSX.Element | null {
  if (!step.checkedBy) return null;
  if (step.checkedBy !== CheckedBy.Judges)
    return (
      <Quote label={t("The lead")}>
        {t(
          "It merged this part's work without a reviewer's verdict. The reviewers score parts that build in steps; this one was built in one session.",
        )}
      </Quote>
    );
  const preferred =
    step.gate === Gate.Kept
      ? t("They preferred this build to the one before it.")
      : t("They preferred the build before it.");
  return <Quote label={t("Reviewers")}>{verdictSentence(step.verdict) || preferred}</Quote>;
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
        <Row row={PanelRow.TechnicalDetails} label={t("Technical details")}>
          <Details
            rows={[
              [t("run"), runIdOf(graph)],
              [t("part"), step.facetId],
              ...taskRows(task),
              [t("state"), task?.state ?? null],
            ]}
          />
        </Row>
      </Rows>
    </>
  );
}

/** A worker's account: the reviewers' word when they compared its build, its own report, why it stopped short. */
function WorkerAbout({ step, worker }: { step: Step; worker: WorkerInfo }): JSX.Element {
  const failed = workerStopWords(worker);
  return (
    <>
      {step.verdict ? <WhoChecked step={step} /> : null}
      {worker.summary ? <Para>{worker.summary}</Para> : null}
      {failed ? <Para quiet>{failed}.</Para> : null}
    </>
  );
}

/** A worker's delivered model or image on its card, as the Assets stage draws its thumbnail. */
function WorkerAssetPicture({ project, asset }: { project: string; asset: ProjectAsset }): JSX.Element {
  return (
    <div
      className="relative aspect-video w-full overflow-hidden rounded-[10px] bg-inset"
      style={{ boxShadow: IMAGE_OUTLINE }}
    >
      <AssetThumbnail project={project} asset={asset} companions={[]} fallback={null} quiet />
    </div>
  );
}

/** The card's picture when no agent's screen is live: a still, else the worker's delivered model. */
function StillMedia({ props, src, asset }: { props: StepPanelProps; src: string | null; asset: ProjectAsset | null }) {
  const { step, project } = props;
  if (!src && project && asset) return <WorkerAssetPicture project={project} asset={asset} />;
  return (
    <Single
      src={src}
      label={step.name}
      onOpen={src ? () => props.onLight([{ path: null, src, title: step.name, caption: "" }], 0) : undefined}
    />
  );
}

/** The card's status: on a Loop's build line, a merged worker's work is in that build, not yet the game. */
function sessionPill({ step, graph, timeline }: StepPanelProps): string {
  const place = timeline?.places.get(step.id);
  return place?.merged ? placedWord(step, place, graph.active) : stepPill(step, graph.active);
}

/** The card of a part built in one session. */
export function SessionPanel(props: StepPanelProps): JSX.Element {
  const { graph, step } = props;
  const working = step.state === StepState.Building;
  const round = useRoundStill(graph, step.facetId, 1, null, working && graph.active);
  const worker = useWorkerStill(props.project, step.picture);
  const screen = usePartScreen(props.project, runIdOf(graph), step.facetId, working && graph.active);
  const src = round ?? worker.src;
  // A worker that kept no picture and delivered nothing to draw has a card of words alone.
  const pictured = src !== null || (props.project !== null && worker.asset !== null);
  const still = pictured ? <StillMedia props={props} src={src} asset={worker.asset} /> : null;
  const media = screen.frame ? (
    <LiveScreen
      frame={screen.frame}
      trail={screen.trail}
      label={step.name}
      onOpen={(shown, caption) => props.onLight([{ path: null, src: shown, title: step.name, caption }], 0)}
    />
  ) : (
    still
  );
  return (
    <Panel
      id={step.id}
      label={t("Selected part")}
      title={step.name}
      status={<Status tone={STATE_TONE[step.state]}>{sessionPill(props)}</Status>}
      onClose={props.onClose}
      reply={{ label: step.name, placeholder: t("Anything to change here?"), target: { facetId: step.facetId } }}
      onReply={props.onReply}
      media={media}
    >
      {step.worker ? <WorkerAbout step={step} worker={step.worker} /> : <PartAbout props={props} step={step} />}
    </Panel>
  );
}

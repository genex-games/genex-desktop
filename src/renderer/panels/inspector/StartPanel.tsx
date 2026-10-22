/** The panel of "You asked": the prompt, the user's reference pictures, and the starting point every part builds on. */
import type { JSX } from "react";
import { t } from "../../../shared/i18n.ts";
import { providerInfo, SUBSCRIPTION_ENGINES } from "../../../shared/providers.ts";
import {
  type BaseNode,
  type RunGraph as RunGraphModel,
  type RunNode,
  runIdOf,
  RunStillStage,
  runStillPath,
} from "../../run-graph.ts";
import { BuildCapture } from "../BuildCapture.tsx";
import type { ReferenceFrame } from "../run-stills.ts";
import { Details, Panel, PanelRow, Para, Row, Rows, Section } from "./chrome.tsx";
import { formatWhen, modelLine } from "./format.ts";
import { IMAGE_OUTLINE } from "./pictures.tsx";
import { GraphSelection } from "./selection.ts";
import type { InspectorProps, LightItem } from "./types.ts";

/** The most decisions the technical details list. */
const DECISIONS_SHOWN = 8;

/** A subscription builder by its product name; any other engine by its id, as the log wrote it. */
const builderName = (engine: string | null): string | null =>
  (SUBSCRIPTION_ENGINES as readonly string[]).includes(engine ?? "") ? (providerInfo(engine)?.label ?? engine) : engine;

/** What the run started from, in one sentence. */
function startedFromWords(base: BaseNode | null, building: boolean): string {
  if (!base || base.absent) return t("Your game as it was when the run started.");
  if (building) return t("Building the starting point…");
  if (base.ok === false && base.error)
    return t(
      "The starting point was rejected, and the game was put back the way it started. What the checks saw: {problem}",
      { problem: base.error },
    );
  if (base.ok === false) return t("The starting point was rejected, and the game was put back the way it started.");
  if (base.empty) return t("An empty scene. It runs and its cameras see it; nothing else was checked yet.");
  return t("Checked: it loads and its cameras see it. Gameplay is reviewed step by step.");
}

function References({
  references,
  onLight,
}: {
  references: ReferenceFrame[];
  onLight: (items: LightItem[], index: number) => void;
}): JSX.Element | null {
  if (!references.length) return null;
  const items = (): LightItem[] =>
    references.map((item) => ({ path: null, src: item.src, title: t("Your reference"), caption: item.label }));
  return (
    <Section label={t("Your references")}>
      <div className="grid grid-cols-2 gap-2">
        {references.map((frame, index) => (
          <button
            key={frame.label + index}
            type="button"
            className="cursor-zoom-in overflow-hidden rounded-[8px]"
            style={{ boxShadow: IMAGE_OUTLINE }}
            onClick={() => onLight(items(), index)}
          >
            <img
              src={frame.src}
              alt={frame.label}
              draggable={false}
              className="block aspect-video w-full object-cover"
            />
          </button>
        ))}
      </div>
    </Section>
  );
}

/**
 * The starting point: the picture its node on the graph shows, else — while the run builds a
 * starting point of its own — that build's newest capture.
 */
function StartedFrom({
  graph,
  base,
  baseSrc,
  building,
}: {
  graph: RunGraphModel;
  base: BaseNode | null;
  baseSrc: string | null;
  building: boolean;
}): JSX.Element {
  const built = base !== null && !base.absent;
  return (
    <Section label={t("Started from")} gap="gap-2">
      {built || baseSrc ? (
        <BuildCapture
          graph={graph}
          facetId="base"
          iteration={0}
          still={baseSrc}
          active={building}
          fallback={base?.done && graph.runDir ? runStillPath(graph.runDir, RunStillStage.Base) : null}
        />
      ) : null}
      <Para quiet>{startedFromWords(base, building)}</Para>
    </Section>
  );
}

function StartDetails({
  graph,
  run,
  base,
}: {
  graph: RunGraphModel;
  run: RunNode;
  base: BaseNode | null;
}): JSX.Element {
  return (
    <Row row={PanelRow.TechnicalDetails} label={t("Technical details")}>
      <Details
        rows={[
          [t("run"), runIdOf(graph)],
          [t("project"), run.project],
          [t("worker"), modelLine(builderName(run.builderEngine), run.model)],
          [t("lead"), modelLine(run.engine, run.model)],
          [t("parallel"), run.maxParallel !== null ? String(run.maxParallel) : null],
          [t("base commit"), base?.commit ?? null],
          [t("started"), formatWhen(run.startedAt)],
          [t("finished"), run.finishedAt ? formatWhen(run.finishedAt) : null],
        ]}
      />
      {run.decisions.length ? (
        <ul className="mt-2 flex flex-col gap-1 text-body-sm text-ink-3">
          {run.decisions.slice(0, DECISIONS_SHOWN).map((decision, index) => (
            <li key={index}>{decision}</li>
          ))}
        </ul>
      ) : null}
    </Row>
  );
}

/** The card of what the user asked and where the run started. */
export function StartPanel(props: InspectorProps): JSX.Element {
  const { graph, run, base, references } = props;
  const building = graph.active && base !== null && !base.done;
  return (
    <Panel
      id={GraphSelection.Start}
      label={t("What you asked")}
      title={t("You asked")}
      nav={false}
      onPrev={props.onPrev}
      onNext={props.onNext}
      onClose={props.onClose}
      reply={{ label: t("Every part"), placeholder: t("A note for every part") }}
      onReply={props.onReply}
    >
      <p className="text-chat-sub whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
        {run.goal || t("No prompt was recorded.")}
      </p>
      <References references={references} onLight={props.onLight} />
      <StartedFrom graph={graph} base={base} baseSrc={props.baseSrc} building={building} />
      <Rows>
        <StartDetails graph={graph} run={run} base={base} />
      </Rows>
    </Panel>
  );
}

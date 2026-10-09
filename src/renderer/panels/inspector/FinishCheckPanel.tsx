/**
 * The card of the finish check, the last node of a run's tree: when the lead says the Loop is
 * done, a reviewer that did none of the work checks the proof first. Until it runs, the card says
 * only that.
 */
import type { JSX } from "react";
import { FinishCheckState, GraphNodeKind, type FinishCheckNode } from "../../run-graph.ts";
import { Tone } from "../../run-steps.ts";
import { FINISH_CHECK_WORDS } from "../../words.ts";
import { Panel, Para } from "./chrome.tsx";
import { GraphSelection } from "./selection.ts";
import { Status } from "./tone.tsx";
import type { InspectorProps } from "./types.ts";

/** The tone of each state's status on the card. */
const FINISH_TONE: Record<FinishCheckState, Tone> = {
  [FinishCheckState.NotYet]: Tone.Muted,
  [FinishCheckState.Checking]: Tone.Accent,
  [FinishCheckState.Done]: Tone.Green,
  [FinishCheckState.Stopped]: Tone.Red,
};

/** The finish check's card. */
export function FinishCheckPanel(props: InspectorProps): JSX.Element {
  const node = props.graph.nodes.find((item): item is FinishCheckNode => item.kind === GraphNodeKind.FinishCheck);
  const state = node?.state ?? FinishCheckState.NotYet;
  const meta = state === FinishCheckState.NotYet ? FINISH_CHECK_WORDS.placeholder : null;
  return (
    <Panel
      id={GraphSelection.FinishCheck}
      label={FINISH_CHECK_WORDS.name}
      title={FINISH_CHECK_WORDS.name}
      status={
        <Status tone={FINISH_TONE[state]} meta={meta}>
          {FINISH_CHECK_WORDS.state[state]}
        </Status>
      }
      onPrev={props.onPrev}
      onNext={props.onNext}
      onClose={props.onClose}
    >
      <Para>{FINISH_CHECK_WORDS.about}</Para>
    </Panel>
  );
}

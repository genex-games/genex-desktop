/**
 * The card of the Loop's final look, the last node of a run's tree: before the Loop calls it done,
 * a second AI looks at the game. The card shows where that stands now and nothing of the rounds
 * before it: looking, what is still to fix (and that the Loop keeps working on it, or Keep building
 * once it ended, as the chat's result card offers it), all done, or that it couldn't look.
 */
import type { JSX } from "react";
import { FinishCheckStep } from "../../../shared/finish-check.ts";
import { StillToFix } from "../../chat/StillToFixCard.tsx";
import { FinishCheckState, type FinishCheckNode, type FinishRound, GraphNodeKind } from "../../run-graph.ts";
import { currentRound, endedOnNo, finishCheckFace, finishPanelTone, leftOf, roundNoteOf } from "../../run-tree.ts";
import { Tone } from "../../run-steps.ts";
import { FINISH_CHECK_WORDS } from "../../words.ts";
import { Panel, Para } from "./chrome.tsx";
import { GraphSelection } from "./selection.ts";
import { Status } from "./tone.tsx";
import type { InspectorProps } from "./types.ts";

/** What the card says about the newest round of the current ask. */
function Now({
  node,
  round,
  onKeepBuilding,
}: {
  node: FinishCheckNode;
  round: FinishRound | undefined;
  onKeepBuilding: InspectorProps["onKeepBuilding"];
}): JSX.Element {
  if (!round) return <Para>{FINISH_CHECK_WORDS.about}</Para>;
  if (round.step === FinishCheckStep.Checking) return <Para>{FINISH_CHECK_WORDS.checkingCard}</Para>;
  if (round.step === FinishCheckStep.Unanswered) return <Para>{FINISH_CHECK_WORDS.unansweredCard}</Para>;
  if (round.step === FinishCheckStep.Accepted)
    return round.done.length ? (
      <StillToFix done={round.done} notDone={[]} title={null} />
    ) : (
      <Para>{FINISH_CHECK_WORDS.doneCard}</Para>
    );
  const left = leftOf(round);
  const keep = endedOnNo(round, node) && onKeepBuilding ? () => onKeepBuilding(left) : null;
  const note = keep ? null : roundNoteOf(round, node);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <StillToFix done={round.done} notDone={left} title={null} onKeepBuilding={keep} />
      {note ? <Para quiet>{note.text}</Para> : null}
    </div>
  );
}

/** The final look's card. */
export function FinishCheckPanel(props: InspectorProps): JSX.Element {
  const node = props.graph.nodes.find((item): item is FinishCheckNode => item.kind === GraphNodeKind.FinishCheck);
  const state = node?.state ?? FinishCheckState.NotYet;
  const tone = node ? finishPanelTone(node) : Tone.Muted;
  const meta = node ? finishCheckFace(node).word : FINISH_CHECK_WORDS.placeholder;
  return (
    <Panel
      id={GraphSelection.FinishCheck}
      label={FINISH_CHECK_WORDS.name}
      title={FINISH_CHECK_WORDS.name}
      status={
        <Status tone={tone} meta={meta}>
          {FINISH_CHECK_WORDS.state[state]}
        </Status>
      }
      onPrev={props.onPrev}
      onNext={props.onNext}
      onClose={props.onClose}
      neutralEdge
    >
      {node ? (
        <Now node={node} round={currentRound(node)} onKeepBuilding={props.onKeepBuilding} />
      ) : (
        <Para>{FINISH_CHECK_WORDS.about}</Para>
      )}
    </Panel>
  );
}

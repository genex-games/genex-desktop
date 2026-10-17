/**
 * The card of the finish check, the last node of a run's tree: when the lead says the Loop is
 * done, a reviewer that did none of the work checks the proof first. Until it runs, the card says
 * only that; then it lists every round, newest first, under the design's headings: the reviewer
 * at work, why not yet, why yes, what isn't done.
 */
import type { JSX } from "react";
import { FinishCheckStep } from "../../../shared/finish-check.ts";
import { FinishCheckState, type FinishCheckNode, type FinishRound, GraphNodeKind } from "../../run-graph.ts";
import { Tone } from "../../run-steps.ts";
import { finishCheckFace, finishPanelTone, reasonTone, roundNoteOf } from "../../run-tree.ts";
import { FINISH_CHECK_WORDS } from "../../words.ts";
import { Panel, Para, Quote, Section } from "./chrome.tsx";
import { GraphSelection } from "./selection.ts";
import { Status } from "./tone.tsx";
import type { InspectorProps } from "./types.ts";

/** The ink of a round's reason numbers (`reasonTone`), as a list-marker utility. */
const MARKER_CLASS: Record<Tone, string> = {
  [Tone.Green]: "marker:text-green",
  [Tone.Red]: "marker:text-red",
  [Tone.Accent]: "marker:text-accent",
  [Tone.Orange]: "marker:text-orange",
  [Tone.Muted]: "marker:text-ink-3",
};

/** A round's heading by how it ended. */
function headingOf(round: FinishRound): string {
  const { heading } = FINISH_CHECK_WORDS;
  if (round.step === FinishCheckStep.Checking) return heading.reviewer;
  if (round.step === FinishCheckStep.Accepted) return heading.whyYes;
  if (round.step === FinishCheckStep.Unanswered) return FINISH_CHECK_WORDS.unanswered;
  return round.stopped ? heading.notDone : heading.whyNotYet;
}

/** The reviewer's reasons, numbered in the round's ink, in the list markup the cards already use. */
function Reasons({ reasons, tone }: { reasons: string[]; tone: Tone }): JSX.Element | null {
  if (reasons.length === 0) return null;
  return (
    <ol className={`flex list-decimal flex-col gap-1 pl-5 text-chat-sub text-ink-2 ${MARKER_CLASS[tone]}`}>
      {reasons.map((reason, index) => (
        <li key={index}>{reason}</li>
      ))}
    </ol>
  );
}

/** The line under a round's reasons (`roundNoteOf`). */
function RoundNote({ round, node }: { round: FinishRound; node: FinishCheckNode }) {
  const note = roundNoteOf(round, node);
  if (!note) return null;
  return note.quiet ? <Para quiet>{note.text}</Para> : <Para>{note.text}</Para>;
}

/** One round of the check: its heading, the lead's claim while the reviewer looks, the reasons and what follows. */
function RoundSection({ round, node, goal }: { round: FinishRound; node: FinishCheckNode; goal: string }): JSX.Element {
  const heading = headingOf(round);
  const label = node.rounds.length > 1 ? FINISH_CHECK_WORDS.roundHeading(heading, round.round) : heading;
  const checking = round.step === FinishCheckStep.Checking;
  return (
    <Section label={label}>
      {checking ? <Para>{FINISH_CHECK_WORDS.reviewerIs}</Para> : null}
      {checking && round.claim ? <Quote label={FINISH_CHECK_WORDS.claimLabel}>{round.claim}</Quote> : null}
      {checking && goal ? <Quote label={FINISH_CHECK_WORDS.yourRequest}>{goal}</Quote> : null}
      <Reasons reasons={round.reasons} tone={reasonTone(round)} />
      <RoundNote round={round} node={node} />
    </Section>
  );
}

/** The finish check's card. */
export function FinishCheckPanel(props: InspectorProps): JSX.Element {
  const node = props.graph.nodes.find((item): item is FinishCheckNode => item.kind === GraphNodeKind.FinishCheck);
  const state = node?.state ?? FinishCheckState.NotYet;
  const tone = node ? finishPanelTone(node) : Tone.Muted;
  const meta = node ? finishCheckFace(node).word : FINISH_CHECK_WORDS.placeholder;
  const rounds = node ? [...node.rounds].reverse() : [];
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
      {node && rounds.length > 0 ? (
        rounds.map((round) => <RoundSection key={round.round} round={round} node={node} goal={props.run.goal} />)
      ) : (
        <Para>{FINISH_CHECK_WORDS.about}</Para>
      )}
    </Panel>
  );
}

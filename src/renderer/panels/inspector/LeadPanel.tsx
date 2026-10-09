/**
 * The card of the lead: while it has the run (no part is working and the build on offer has been
 * tried), or in a tree for the whole run, saying what it is doing.
 */
import type { JSX } from "react";
import { STATE_TONE, StepState, Tone } from "../../run-steps.ts";
import { LeadFace, leadAbout, leadFace } from "../../run-tree.ts";
import { LEAD_WORDS } from "../../words.ts";
import { Panel, Para } from "./chrome.tsx";
import { LiveScreen, useScreenTrail } from "./screen.tsx";
import { GraphSelection } from "./selection.ts";
import { Status } from "./tone.tsx";
import type { InspectorProps } from "./types.ts";

/** The tone of the lead's status by its face: at work, waiting, or how the run closed. */
const FACE_TONE: Record<LeadFace, Tone> = {
  [LeadFace.Working]: Tone.Accent,
  [LeadFace.Waiting]: Tone.Accent,
  [LeadFace.Paused]: STATE_TONE[StepState.NotInBuild],
  [LeadFace.Stopped]: STATE_TONE[StepState.NotInBuild],
  [LeadFace.Done]: STATE_TONE[StepState.InBuild],
};

export function LeadPanel(props: InspectorProps): JSX.Element {
  const { leadFrame, graph, outcome, rows } = props;
  const face = graph.tree ? leadFace(graph, outcome, rows) : LeadFace.Working;
  // Only the lead at work shows its screen, as its node does.
  const frame = face === LeadFace.Working ? leadFrame : null;
  const trail = useScreenTrail(frame);
  const open = (src: string, caption: string): void =>
    props.onLight([{ path: null, src, title: LEAD_WORDS.name, caption }], 0);
  return (
    <Panel
      id={GraphSelection.Lead}
      label={LEAD_WORDS.name}
      title={LEAD_WORDS.name}
      status={<Status tone={FACE_TONE[face]}>{LEAD_WORDS.face[face]}</Status>}
      onPrev={props.onPrev}
      onNext={props.onNext}
      onClose={props.onClose}
      reply={{ label: LEAD_WORDS.name, placeholder: "Anything the lead should do next?" }}
      onReply={props.onReply}
      media={
        frame ? <LiveScreen frame={frame} trail={trail} label="The lead's view of the game" onOpen={open} /> : null
      }
    >
      <Para>{leadAbout(face, graph.tree)}</Para>
    </Panel>
  );
}

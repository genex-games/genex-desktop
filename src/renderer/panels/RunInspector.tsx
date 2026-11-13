/**
 * The Builds tab's one card, opened in place of its row: a title and one status, the picture that
 * matters, the reviewers' own words quoted, disclosure rows for their full notes, checks and
 * technical details. Replies go through the chat's composer (Follow up in chat), so the app keeps
 * one input. The lightbox is an overlay of the same tab.
 *
 * Each card lives in `inspector/`: the shell and its parts in `chrome.tsx`, the pictures in
 * `pictures.tsx`, and one file per kind of node.
 */
import type { JSX } from "react";
import { AssetsPanel } from "./inspector/AssetsPanel.tsx";
import { BuildPanel } from "./inspector/BuildPanel.tsx";
import { isBuildSelection } from "../run-graph-builds.ts";
import { FinishCheckPanel } from "./inspector/FinishCheckPanel.tsx";
import { JobsPanel } from "./inspector/JobsPanel.tsx";
import { LeadPanel } from "./inspector/LeadPanel.tsx";
import { ResultPanel } from "./inspector/ResultPanel.tsx";
import { GraphSelection } from "./inspector/selection.ts";
import { SessionPanel } from "./inspector/SessionPanel.tsx";
import { StepPanel } from "./inspector/StepPanel.tsx";
import type { InspectorProps } from "./inspector/types.ts";

export { Lightbox } from "./inspector/Lightbox.tsx";
export { StateGlyph, TONE } from "./inspector/tone.tsx";
export type { InspectorProps, LightItem, Reply } from "./inspector/types.ts";

/** The card of whatever row is open on the list, or nothing when the selection names none. */
export function Inspector(props: InspectorProps): JSX.Element | null {
  const { selection } = props;
  if (selection === GraphSelection.Final) return <ResultPanel {...props} />;
  if (selection === GraphSelection.Lead) return <LeadPanel {...props} />;
  if (selection === GraphSelection.Jobs) return <JobsPanel {...props} />;
  if (selection === GraphSelection.FinishCheck) return <FinishCheckPanel {...props} />;
  if (selection === GraphSelection.Assets) return <AssetsPanel {...props} />;
  if (isBuildSelection(selection)) {
    const build = props.timeline?.builds.find((item) => item.id === selection);
    return build ? <BuildPanel {...props} build={build} /> : null;
  }
  return <RowCard {...props} />;
}

/** The card of a step's row: a session's, or a step built in tries. */
function RowCard(props: InspectorProps): JSX.Element | null {
  const { selection, rows } = props;
  const row = rows.find((item) => item.steps.some((step) => step.id === selection));
  const step = row?.steps.find((item) => item.id === selection);
  if (!row || !step) return null;
  if (step.session) return <SessionPanel {...props} row={row} step={step} />;
  return <StepPanel {...props} row={row} step={step} />;
}

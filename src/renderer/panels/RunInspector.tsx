/**
 * The Builds tab's one card: the canvas brings the selected node to the middle and the node opens
 * in place — a title and one status, the picture that matters (before and after, side by side),
 * the judges' own words quoted, disclosure rows for their full notes, checks and technical
 * details. Replies go through the chat's composer (Follow up in chat), so the app keeps one input.
 * The lightbox is an overlay of the same tab.
 *
 * Each card lives in `inspector/`: the shell and its parts in `chrome.tsx`, the pictures in
 * `pictures.tsx`, and one file per kind of node.
 */
import type { JSX } from "react";
import { AssetsPanel } from "./inspector/AssetsPanel.tsx";
import { FinishCheckPanel } from "./inspector/FinishCheckPanel.tsx";
import { JobsPanel } from "./inspector/JobsPanel.tsx";
import { LeadPanel } from "./inspector/LeadPanel.tsx";
import { OptimizationPanel } from "./inspector/OptimizationPanel.tsx";
import { PartPanel } from "./inspector/PartPanel.tsx";
import { ResultPanel } from "./inspector/ResultPanel.tsx";
import { GraphSelection, isPartSelection, partSelection } from "./inspector/selection.ts";
import { SessionPanel } from "./inspector/SessionPanel.tsx";
import { StartPanel } from "./inspector/StartPanel.tsx";
import { StepPanel } from "./inspector/StepPanel.tsx";
import type { InspectorProps } from "./inspector/types.ts";

export { Lightbox } from "./inspector/Lightbox.tsx";
export { optimizationStatus } from "./inspector/OptimizationPanel.tsx";
export { StateGlyph, TONE } from "./inspector/tone.tsx";
export type { InspectorProps, LightItem, Reply } from "./inspector/types.ts";

/** The card of whatever is selected on the graph, or nothing when the selection names no node. */
export function Inspector(props: InspectorProps): JSX.Element | null {
  const { selection, rows } = props;
  if (selection === GraphSelection.Start) return <StartPanel {...props} />;
  if (selection === GraphSelection.Final) return <ResultPanel {...props} />;
  if (selection === GraphSelection.Lead) return <LeadPanel {...props} />;
  if (selection === GraphSelection.Jobs) return <JobsPanel {...props} />;
  if (selection === GraphSelection.FinishCheck) return <FinishCheckPanel {...props} />;
  if (selection === GraphSelection.Assets) return <AssetsPanel {...props} />;
  if (selection === GraphSelection.Optimization && props.optimization)
    return <OptimizationPanel {...props} node={props.optimization} />;
  if (isPartSelection(selection)) {
    const row = rows.find((item) => partSelection(item.facet.facetId) === selection);
    return row ? <PartPanel {...props} row={row} /> : null;
  }
  const row = rows.find((item) => item.steps.some((step) => step.id === selection));
  const step = row?.steps.find((item) => item.id === selection);
  if (!row || !step) return null;
  if (step.session) return <SessionPanel {...props} row={row} step={step} />;
  return <StepPanel {...props} row={row} step={step} />;
}

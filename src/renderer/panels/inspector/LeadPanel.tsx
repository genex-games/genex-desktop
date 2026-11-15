/**
 * The card of the lead: while it has the run (no part is working and the build on offer has been
 * tried), or in a tree for the whole run, saying what it is doing: its plan's steps when it named a
 * plan (the same list as the chat's Building card), else its own latest words.
 */
import { type JSX, useContext, useId, useMemo } from "react";
import { t } from "../../../shared/i18n.ts";
import { buildChecklist, leadLine } from "../../chat/build-checklist.ts";
import { BuildChecklist } from "../../chat/BuildChecklist.tsx";
import { STATE_TONE, StepState, Tone } from "../../run-steps.ts";
import { LeadFace, leadAbout, leadFace } from "../../run-tree.ts";
import { LEAD_WORDS } from "../../words.ts";
import { Panel, Para, UnderRowHeader } from "./chrome.tsx";
import { GraphSelection } from "./selection.ts";
import { Status } from "./tone.tsx";
import type { InspectorProps } from "./types.ts";

/** How many of the lead's latest lines its card shows when it named no plan. */
const LEAD_LINES_SHOWN = 3;

/** The tone of the lead's status by its face: at work, waiting, or how the run closed. */
const FACE_TONE: Record<LeadFace, Tone> = {
  [LeadFace.Working]: Tone.Accent,
  [LeadFace.Waiting]: Tone.Accent,
  [LeadFace.Paused]: STATE_TONE[StepState.NotInBuild],
  [LeadFace.Stopped]: STATE_TONE[StepState.NotInBuild],
  [LeadFace.Done]: STATE_TONE[StepState.InBuild],
};

/** What the card holds: the plan's steps, else the lead's latest lines, else what its face means. */
function LeadBody({ props, face }: { props: InspectorProps; face: LeadFace }): JSX.Element {
  const listId = useId();
  const { outcome } = props;
  // The lead's own rows: its plan's steps; the parts its workers build are rows of their own on Builds.
  const plan = useMemo(() => {
    const list = buildChecklist(outcome, Date.now());
    return list?.step ? { ...list, rows: list.rows.slice(0, list.lead) } : null;
  }, [outcome]);
  // The plan marks a step at work: shown only while the lead works, never once its run ended.
  if (plan && face === LeadFace.Working) return <BuildChecklist id={listId} list={plan} />;
  const said = outcome?.lead?.said.slice(-LEAD_LINES_SHOWN).reverse() ?? [];
  if (!said.length) return <Para>{leadAbout(face, props.graph.tree)}</Para>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-analytics-mask>
      {said.map((line, at) => (
        <li key={`${line.at}-${at}`} className="text-chat-sub text-ink-2 [overflow-wrap:anywhere]">
          {line.text}
        </li>
      ))}
    </ul>
  );
}

export function LeadPanel(props: InspectorProps): JSX.Element {
  const { graph, outcome, rows } = props;
  const face = graph.tree ? leadFace(graph, outcome, rows) : LeadFace.Working;
  const working = face === LeadFace.Working;
  const line = working ? leadLine(outcome, Date.now()) : null;
  const underRow = useContext(UnderRowHeader);
  return (
    <Panel
      id={GraphSelection.Lead}
      label={LEAD_WORDS.name}
      title={LEAD_WORDS.name}
      // Under its row in Builds the row's own line already says it; a card of its own says it here.
      {...(underRow
        ? {}
        : {
            status: (
              <Status tone={FACE_TONE[face]}>
                <span className={working ? "chat-status-shimmer" : undefined}>{line ?? LEAD_WORDS.face[face]}</span>
              </Status>
            ),
          })}
      onClose={props.onClose}
      reply={{ label: LEAD_WORDS.name, placeholder: t("Anything the lead should do next?") }}
      onReply={props.onReply}
    >
      <LeadBody props={props} face={face} />
    </Panel>
  );
}

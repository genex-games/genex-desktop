/** The card of one part: its steps as rows, why it stopped, the user's notes and its checks. */
import type { JSX } from "react";
import type { RunTask } from "../../../shared/run-summary.ts";
import { type FacetNode, type RunGraph as RunGraphModel, runIdOf, thumbShot } from "../../run-graph.ts";
import {
  elapsedWords,
  isLiveStep,
  type PartRow,
  type Step,
  stepWord,
  stoppedShort,
  Tone,
  triesWord,
} from "../../run-steps.ts";
import { Icon } from "../../ui/icons.tsx";
import { checkCounts, ranToItsEnd, stoppedWords } from "../../words.ts";
import { useRoundStill } from "../run-stills.ts";
import { Details, NotesSection, Panel, Para, Quote, Row, Rows, Section } from "./chrome.tsx";
import { capitalise, joinDots } from "./format.ts";
import { IMAGE_OUTLINE } from "./pictures.tsx";
import { partSelection } from "./selection.ts";
import { taskOf, taskRows } from "./SessionPanel.tsx";
import { StateGlyph, Status } from "./tone.tsx";
import type { InspectorProps } from "./types.ts";

/** How the stop words begin when the lead, not the budget or the judges, stopped a part. */
const LEAD_STOPPED = /^stopped by the lead/;
const LEAD_STOPPED_PREFIX = /^stopped by the lead\s*(?:—\s*)?/;

/** A step as one row of its part's panel: thumbnail, name, state and tries. */
function StepRow({ graph, step, onSelect }: { graph: RunGraphModel; step: Step; onSelect: () => void }): JSX.Element {
  const node = step.shown;
  const src = useRoundStill(
    graph,
    step.facetId,
    node?.iteration ?? 1,
    node ? (thumbShot(node)?.path ?? null) : null,
    false,
  );
  const off = !step.onLine && !isLiveStep(step);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex h-[52px] cursor-pointer items-center gap-3 rounded-[8px] text-left hover:bg-control-hover focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span
        className={`block h-9 w-16 shrink-0 overflow-hidden rounded-[6px] ${src ? "bg-inset" : "hatch"}`}
        style={{ boxShadow: IMAGE_OUTLINE }}
      >
        {src ? (
          <img
            src={src}
            alt=""
            draggable={false}
            className="h-full w-full object-cover"
            style={off ? { opacity: 0.45, filter: "saturate(0.4)" } : undefined}
          />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-chat-sub text-ink">{step.name}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
          <StateGlyph state={step.state} size={11} />
          <span className="truncate">{joinDots([stepWord(step, graph.active), triesWord(step)])}</span>
        </span>
      </span>
      <span className="text-ink-3">
        <Icon name="chevron-right" size={14} />
      </span>
    </button>
  );
}

/** Whether a part was stopped before it ran its course and before the judges were satisfied. */
const stoppedEarly = (facet: FacetNode): facet is FacetNode & { stoppedBecause: string } =>
  Boolean(facet.stoppedBecause) && !ranToItsEnd(facet.stoppedBecause) && !facet.satisfied;

function partPill(row: PartRow, active: boolean): { tone: Tone; text: string } {
  const facet = row.facet;
  if (active && row.working) return { tone: Tone.Accent, text: "Working" };
  if (stoppedEarly(facet)) {
    const byLead = LEAD_STOPPED.test(stoppedWords(facet.stoppedBecause));
    return { tone: Tone.Muted, text: byLead ? "Stopped by the lead" : "Stopped" };
  }
  if (row.integrated)
    return { tone: Tone.Green, text: row.inBuild === row.steps.length ? "Added to your build" : "Partly added" };
  return { tone: Tone.Muted, text: "Left out of your build" };
}

/** How long the part has been, or was, at work: its first try's start to its last try's news. */
function partDuration(row: PartRow, active: boolean): string | null {
  const rounds = row.steps.flatMap((step) => step.tries);
  const first =
    rounds
      .map((node) => node.startedAt)
      .filter(Boolean)
      .sort()[0] ?? null;
  const last =
    rounds
      .map((node) => node.judgedAt ?? node.activityAt ?? null)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
  if (!first) return null;
  return elapsedWords(first, active && row.working ? null : last);
}

/** Why a part stopped, and whether it was the lead that stopped it. A part that finished its work has no "why it stopped" to tell. */
function stopReason(facet: FacetNode): { lead: boolean; text: string } | null {
  if (!stoppedShort(facet.stoppedBecause)) return null;
  const stopped = stoppedWords(facet.stoppedBecause);
  return { lead: LEAD_STOPPED.test(stopped), text: stopped.replace(LEAD_STOPPED_PREFIX, "") || stopped };
}

const attemptsLine = (task: RunTask | null): string | null => {
  if (!task?.attempts.length) return null;
  return task.attempts
    .map(
      (attempt) =>
        `${attempt.iteration === null ? "session" : `#${attempt.iteration}`} ${attempt.evaluation ?? attempt.state}`,
    )
    .join(" · ");
};

function PartChecks({ row }: { row: PartRow }): JSX.Element | null {
  const facet = row.facet;
  const rounds = row.steps.flatMap((step) => step.tries);
  const board = [...rounds].reverse().find((node) => node.scoreboard)?.scoreboard ?? null;
  if (!board) return null;
  return (
    <Row label="Checks" right={checkCounts(board)}>
      <Para quiet>
        {facet.plannedChecks !== null ? `${facet.plannedChecks} planned` : ""}
        {facet.checksAdded ? ` · ${facet.checksAdded} added by the reviewers` : ""}
        {facet.replans ? ` · ${facet.replans} re-pointed` : ""}
      </Para>
    </Row>
  );
}

/** The card of one part and its steps. */
export function PartPanel(props: InspectorProps & { row: PartRow }): JSX.Element {
  const { graph, row, outcome } = props;
  const facet = row.facet;
  const task = taskOf(outcome, facet.facetId);
  const pill = partPill(row, graph.active);
  const notes = graph.notes.filter((note) => note.facetId === facet.facetId && note.iteration === null);
  // A part built in one session has one node and no steps to count.
  const session = row.steps.every((step) => step.session);
  const why = stopReason(facet);
  const stepCount = `${row.steps.length} step${row.steps.length === 1 ? "" : "s"}`;
  return (
    <Panel
      id={partSelection(facet.facetId)}
      label="Selected part"
      title={facet.title}
      sub={joinDots([session ? null : stepCount, partDuration(row, graph.active)])}
      status={<Status tone={pill.tone}>{pill.text}</Status>}
      onPrev={props.onPrev}
      onNext={props.onNext}
      onClose={props.onClose}
      reply={{
        label: facet.title,
        placeholder: "Anything this part should do differently?",
        target: { facetId: facet.facetId },
      }}
      onReply={props.onReply}
    >
      <Section label="Steps" gap="gap-0">
        {row.steps.map((step) => (
          <StepRow key={step.id} graph={graph} step={step} onSelect={() => props.onSelect(step.id)} />
        ))}
      </Section>
      {why ? (
        <Quote label={why.lead ? "Why the lead stopped it" : "Why it stopped"}>{capitalise(why.text)}.</Quote>
      ) : null}
      <NotesSection notes={notes} />
      <Rows>
        <PartChecks row={row} />
        <Row label="Technical details">
          <Details
            rows={[
              ["run", runIdOf(graph)],
              ["part", facet.facetId],
              ["budget share", facet.budgetShare !== null ? `${Math.round(facet.budgetShare * 100)}%` : null],
              ...taskRows(task),
              ["attempts", attemptsLine(task)],
              ["outages", facet.outages ? String(facet.outages) : null],
            ]}
          />
        </Row>
      </Rows>
    </Panel>
  );
}

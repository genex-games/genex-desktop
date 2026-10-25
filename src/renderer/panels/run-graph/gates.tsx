/** The judges' gates on the Builds graph: an eye on the edge into every node they looked at, and its tooltip. */
import { memo, type JSX } from "react";
import { t } from "../../../shared/i18n.ts";
import { sameGateButton, type GateButtonProps } from "./step-props.ts";
import {
  finalNodeOf,
  headVerdict,
  IterationStatus,
  type RunGraph as RunGraphModel,
  truncate,
} from "../../run-graph.ts";
import { Gate, type GatePoint, judgesOn, type Step } from "../../run-steps.ts";
import { Icon } from "../../ui/icons.tsx";
import { verdictSentence } from "../../words.ts";
import { GraphSelection } from "../inspector/selection.ts";
import { WORKING_PULSE } from "../inspector/tone.tsx";

/** How much of the judges' words a tooltip keeps, after the kept try and after the undone one. */
const KEPT_WORDS_CHARS = 110;
const UNDONE_WORDS_CHARS = 120;
/** A gate's radius, in canvas pixels: its button is centred on the gate's point. */
const GATE_RADIUS = 10;

const GATE_INK: Record<Gate, string> = {
  [Gate.Kept]: "var(--green)",
  [Gate.Undone]: "var(--red)",
  [Gate.Looking]: "var(--accent)",
  [Gate.Waiting]: "color-mix(in oklab, var(--ink-3) 62%, var(--canvas))",
};

const GATE_LABEL: Record<Gate, string> = {
  [Gate.Kept]: t("Reviewers kept it"),
  [Gate.Undone]: t("Reviewers undid it"),
  [Gate.Looking]: t("Reviewers looking now"),
  [Gate.Waiting]: t("No reviewer compared it"),
};

/** A gate's eye: pressing it opens what the judges said, hovering or focusing it shows the tooltip. */
export const GateButton = memo(function GateButton({ gate, notesId, onOpen, onTip }: GateButtonProps): JSX.Element {
  const ink = GATE_INK[gate.gate];
  return (
    <button
      type="button"
      data-graph-gate={gate.gate}
      aria-label={t("{verdict} — show what they said", { verdict: GATE_LABEL[gate.gate] })}
      className="absolute z-[1] grid size-5 cursor-pointer place-items-center rounded-full bg-canvas p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      style={{
        left: gate.x - GATE_RADIUS,
        top: gate.y - GATE_RADIUS,
        border: `1.5px solid ${ink}`,
        color: ink,
        animation: gate.gate === Gate.Looking ? WORKING_PULSE : undefined,
      }}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(gate, notesId);
      }}
      onPointerEnter={() => onTip(gate)}
      onPointerLeave={() => onTip(null)}
      onFocus={() => onTip(gate)}
      onBlur={() => onTip(null)}
    >
      <Icon name="eye" size={12} strokeWidth={2} />
    </button>
  );
}, sameGateButton);

/** What the judges made of the build behind the result gate. */
function resultGateWords(gate: GatePoint, graph: RunGraphModel): { title: string; line: string } {
  const verdict = headVerdict(graph);
  const line = finalNodeOf(graph)?.landing?.line ?? verdictSentence(verdict);
  if (gate.gate === Gate.Waiting)
    return {
      title: GATE_LABEL[Gate.Waiting],
      line: line || t("It runs, but no reviewer compared it with the game you had."),
    };
  return {
    title: gate.gate === Gate.Kept ? t("Reviewers preferred it") : t("Reviewers preferred the game you had"),
    line: line || "",
  };
}

/** What the judges made of a step's tries: the one they kept, or how many they undid. */
function stepGateWords(gate: GatePoint, tries: Step["tries"]): { title: string; line: string } {
  const keptAt = tries.findIndex((node) => node.status === IterationStatus.Accepted);
  const undone = tries.filter((node) => node.status === IterationStatus.Rolled).length;
  if (gate.gate === Gate.Looking)
    return { title: GATE_LABEL[Gate.Looking], line: t("Try {count} · the worker is done", { count: tries.length }) };
  const kept = gate.gate === Gate.Kept ? tries[keptAt] : undefined;
  if (kept) {
    const said = judgesOn(kept);
    const facts = [
      undone ? t("Undid {count, plural, one {# try} other {# tries}} before it", { count: undone }) : "",
      said ? truncate(said, KEPT_WORDS_CHARS) : "",
    ].filter(Boolean);
    return {
      title: tries.length > 1 ? t("Reviewers kept try {number}", { number: keptAt + 1 }) : GATE_LABEL[Gate.Kept],
      line: facts.join(" · "),
    };
  }
  const last = [...tries].reverse().find((node) => node.status === IterationStatus.Rolled);
  return {
    title:
      undone > 1 ? t("Reviewers undid {count, plural, other {# tries}}", { count: undone }) : GATE_LABEL[Gate.Undone],
    line: last ? truncate(judgesOn(last), UNDONE_WORDS_CHARS) : "",
  };
}

/** What the judges made of the node behind a gate, in a title and one line. */
export function gateWords(gate: GatePoint, step: Step | null, graph: RunGraphModel): { title: string; line: string } {
  if (gate.target === GraphSelection.Final) return resultGateWords(gate, graph);
  if (!step) return { title: GATE_LABEL[gate.gate], line: "" };
  if (step.session) return { title: GATE_LABEL[gate.gate], line: verdictSentence(step.verdict) };
  return stepGateWords(gate, step.tries);
}

/** The tooltip over a gate: the judges' title and line. */
export function GateTip({ gate, words }: { gate: GatePoint; words: { title: string; line: string } }): JSX.Element {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-[2] flex w-[200px] flex-col gap-0.5 rounded-[10px] bg-popover px-2.5 py-2"
      style={{ left: gate.x, top: gate.y - 16, transform: "translate(-50%, -100%)", boxShadow: "var(--shadow-raised)" }}
    >
      <span className="text-xs font-semibold text-ink">{words.title}</span>
      {words.line ? <span className="line-clamp-3 text-micro text-ink-3">{words.line}</span> : null}
    </div>
  );
}

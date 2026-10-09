/** The card of one step: its picture before and after, its tries, what the judges said and their notes, and its checks. */
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  type AdviceInfo,
  checkWords,
  type IterationNode,
  IterationStatus,
  type MergeInfo,
  type OutageInfo,
  plannedFlips,
  type RunGraph as RunGraphModel,
  type RunNode,
  runIdOf,
  type Shot,
  thumbShot,
} from "../../run-graph.ts";
import {
  isJudgedTry,
  isLiveStep,
  judgesOn,
  leadStopped,
  type PartRow,
  STATE_TONE,
  type Step,
  stepPill,
} from "../../run-steps.ts";
import { useStill } from "../../stills.ts";
import { Icon, type IconName } from "../../ui/icons.tsx";
import { checkCounts, undoneBecause } from "../../words.ts";
import { useRoundStill } from "../run-stills.ts";
import { Details, NotesSection, Panel, Para, Quote, Row, Rows } from "./chrome.tsx";
import { capitalise, listOrNull, modelLine } from "./format.ts";
import { JudgesNotes } from "./JudgesNotes.tsx";
import { Cameras, Compare, Single, TryThumb } from "./pictures.tsx";
import { LiveScreen, usePartScreen } from "./screen.tsx";
import { Status } from "./tone.tsx";
import type { StepPanelProps } from "./types.ts";

/** The demo cameras record play, not the scene: the panel never shows them as stills. */
const sceneShots = (node: IterationNode): Shot[] => node.shots.filter((shot) => !shot.camera.startsWith("demo"));

/** A try's shot through one camera, or its thumbnail shot when it has none from there. */
const shotThrough = (node: IterationNode, camera: string | null): Shot | null =>
  node.shots.find((shot) => shot.camera === camera) ?? thumbShot(node);

/** What the build looked like before this step: the step it follows on the line, or the start. */
const stepBefore = (row: PartRow, step: Step): Step | null =>
  row.steps
    .slice(0, row.steps.indexOf(step))
    .filter((item) => item.onLine)
    .at(-1) ?? null;

/** The try a step's panel opens on: the one whose notes were asked for, else the one its node shows, else the latest. */
function openingTry(step: Step, notesFor: string | null): number {
  const asked = step.tries.findIndex((node) => node.id === notesFor);
  if (asked >= 0) return asked;
  const shown = step.shown ?? step.tries.at(-1);
  return shown ? Math.max(0, step.tries.indexOf(shown)) : 0;
}

const mergeLine = (merge: MergeInfo | null): string | null => {
  if (!merge) return null;
  return `${merge.head?.slice(0, 8) ?? ""}${merge.conflict ? " · conflict" : ""}${merge.union ? " · union" : ""}`;
};

const outageLine = (outage: OutageInfo | null): string | null => {
  if (!outage) return null;
  return `×${outage.count}${outage.phase ? ` during ${outage.phase}` : ""}`;
};

/** The before and after of the try on show through one camera, and everything the camera switch needs. */
function useStepPicture(props: StepPanelProps, node: IterationNode) {
  const { graph, row, step, baseSrc } = props;
  const cameras = useMemo(() => [...new Set(sceneShots(node).map((shot) => shot.camera))], [node]);
  const [camera, setCamera] = useState<string | null>(thumbShot(node)?.camera ?? null);
  useEffect(() => setCamera(thumbShot(node)?.camera ?? null), [node]);
  const live = graph.active && node.status === IterationStatus.Building;
  const rightShot = shotThrough(node, camera);
  const right = useRoundStill(graph, node.facetId, node.iteration, rightShot?.path ?? null, live);
  const beforeNode = stepBefore(row, step)?.shown ?? null;
  const leftShot = beforeNode ? shotThrough(beforeNode, camera) : null;
  const leftStill = useStill(leftShot?.path ? { run: leftShot.path } : null);
  const left = beforeNode ? leftStill : baseSrc;
  return { cameras, camera, setCamera, rightShot, right, left, compare: Boolean(left || beforeNode) };
}

const PASS_MARK: Record<"pass" | "fail" | "unknown", { color: string; icon: IconName }> = {
  pass: { color: "var(--green)", icon: "check" },
  fail: { color: "var(--red)", icon: "close" },
  unknown: { color: "var(--ink-3)", icon: "minus" },
};

const passMark = (pass: boolean | null | undefined): (typeof PASS_MARK)[keyof typeof PASS_MARK] => {
  if (pass === true) return PASS_MARK.pass;
  if (pass === false) return PASS_MARK.fail;
  return PASS_MARK.unknown;
};

function CheckList({ node }: { node: IterationNode }): JSX.Element {
  const board = node.scoreboard;
  const flips = new Set(plannedFlips(node));
  if (!board?.results.length) return <Para quiet>{checkCounts(board)}</Para>;
  return (
    <ul className="flex flex-col gap-1.5">
      {board.results.map((row) => {
        const mark = passMark(row.pass);
        return (
          <li key={row.id} className="flex items-start gap-2 text-body-sm">
            <span className="mt-[3px]" style={{ color: mark.color }}>
              <Icon name={mark.icon} size={11} strokeWidth={2.4} />
            </span>
            <span className="min-w-0 text-ink-2 [overflow-wrap:anywhere]">
              {capitalise(checkWords(row.id))}
              {flips.has(row.id) ? <span className="text-green"> · newly passing</span> : null}
              {row.reason ? <span className="block text-ink-3">{row.reason}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Folded into one node on the graph, the tries unfold here: pick one to see it above. */
function TriesStrip({
  graph,
  tries,
  node,
  onPick,
}: {
  graph: RunGraphModel;
  tries: IterationNode[];
  node: IterationNode;
  onPick: (at: number) => void;
}): JSX.Element | null {
  if (tries.length < 2) return null;
  return (
    <div role="group" aria-label="Tries" className="flex flex-wrap gap-2.5 pt-1">
      {tries.map((item, at) => (
        <TryThumb
          key={item.id}
          graph={graph}
          node={item}
          n={at + 1}
          selected={item === node}
          live={graph.active && item.status === IterationStatus.Building}
          onSelect={() => onPick(at)}
        />
      ))}
    </div>
  );
}

/** The judges' words on the try on show, and who stopped or undid it; the card's status says what became of it. */
function StepStory({ step, node }: { step: Step; node: IterationNode }): JSX.Element | null {
  const tries = step.tries;
  const n = tries.indexOf(node) + 1;
  const said = judgesOn(node);
  // Who stopped the step is a fact about the step, whichever try is looked at.
  const stoppedTry = [...tries].reverse().find((item) => leadStopped(item));
  const stopped = stoppedTry ? leadStopped(stoppedTry) : null;
  const undone = node.status === IterationStatus.Rolled && !said;
  if (!said && !stopped && !undone) return null;
  return (
    <div className="flex flex-col gap-2.5">
      {said ? <Quote label={tries.length > 1 ? `Reviewers · try ${n}` : "Reviewers"}>“{said}”</Quote> : null}
      {stopped ? <Para quiet>{capitalise(stopped)}.</Para> : null}
      {undone ? <Para quiet>Undone because {undoneBecause(node.verdictSource, node.verdict)}.</Para> : null}
    </div>
  );
}

/** A critic's advice on the try: each defect with its fix, its one bold move, and its gate answers. Advice, not a verdict. */
function AdviceNotes({ advice }: { advice: AdviceInfo }): JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      {advice.defects.length ? (
        <ul className="flex flex-col gap-1.5">
          {advice.defects.map((item) => (
            <li key={item.defect} className="text-body-sm text-ink-2 [overflow-wrap:anywhere]">
              {item.defect}
              {item.fix ? <span className="block text-ink-3">Fix: {item.fix}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {advice.boldMove ? <Quote label="One bold move">{advice.boldMove}</Quote> : null}
      {advice.gates.length ? (
        <ul className="flex flex-col gap-1 text-body-sm text-ink-3">
          {advice.gates.map((gate) => (
            <li key={gate} className="[overflow-wrap:anywhere]">
              {gate}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StepRows({
  graph,
  run,
  node,
  notesOpen,
}: {
  graph: RunGraphModel;
  run: RunNode;
  node: IterationNode;
  /** the judges' notes open already showing: a gate on the graph asked for them */
  notesOpen: boolean;
}): JSX.Element {
  const judged = isJudgedTry(node);
  return (
    <Rows>
      {judged ? (
        <Row
          label="Reviewers' notes"
          right={node.defects.length ? String(node.defects.length) : null}
          defaultOpen={notesOpen}
        >
          <JudgesNotes node={node} graph={graph} quoted={judgesOn(node)} />
        </Row>
      ) : null}
      {node.advice ? (
        <Row label="Critic's advice" right={String(node.advice.defects.length)}>
          <AdviceNotes advice={node.advice} />
        </Row>
      ) : null}
      {node.scoreboard ? (
        <Row label="Checks" right={checkCounts(node.scoreboard)}>
          <CheckList node={node} />
        </Row>
      ) : null}
      <Row label="Technical details">
        <Details
          rows={[
            ["run", runIdOf(graph)],
            ["part", node.facetId],
            ["round", String(node.iteration)],
            ["verdict by", node.verdictSource],
            ["merged", mergeLine(node.merge)],
            ["cameras", listOrNull(node.shots.map((shot) => shot.camera))],
            ["model", modelLine(run.engine, run.model)],
            ["flags", listOrNull(node.flags.map((flag) => flag.what))],
            ["outage", outageLine(node.outage)],
          ]}
        />
      </Row>
    </Rows>
  );
}

/** The label of the still on the right: the try on show, this step, or this one try. */
function rightLabelOf(step: Step, n: number): string {
  if (step.tries.length > 1) return `Try ${n}`;
  return step.onLine ? "This step" : "This try";
}

/** A try's saved stills: before and after when there is a before, else the one; and the camera switch. */
function TryStills({
  picture,
  onLine,
  label,
  onOpen,
}: {
  picture: ReturnType<typeof useStepPicture>;
  onLine: boolean;
  label: string;
  onOpen: () => void;
}): JSX.Element {
  return (
    <>
      {picture.compare ? (
        <Compare
          left={picture.left}
          right={picture.right}
          leftLabel={onLine ? "Before" : "In your build"}
          rightLabel={label}
          onOpen={onOpen}
        />
      ) : (
        <Single src={picture.right} label={label} onOpen={onOpen} />
      )}
      <Cameras names={picture.cameras} value={picture.camera} onChange={picture.setCamera} />
    </>
  );
}

/** The panel of one step of a part, opened on the try its node shows. */
export function StepPanel(props: StepPanelProps): JSX.Element | null {
  const tries = props.step.tries;
  const [index, setIndex] = useState(() => openingTry(props.step, props.notesFor));
  const node = tries[Math.min(index, tries.length - 1)];
  if (!node) return null;
  return <StepView {...props} node={node} onPick={setIndex} />;
}

function StepView(props: StepPanelProps & { node: IterationNode; onPick: (at: number) => void }): JSX.Element {
  const { graph, step, run, node } = props;
  const tries = step.tries;
  const picture = useStepPicture(props, node);
  // The try in hand, while its agent works: the card shows its screen, live, instead of its stills.
  const screen = usePartScreen(props.project, runIdOf(graph), step.facetId, graph.active && isLiveStep(step));
  const liveFrame = node === tries.at(-1) ? screen.frame : null;
  const n = tries.indexOf(node) + 1;
  const rightLabel = rightLabelOf(step, n);
  const open = (): void => {
    const shots = sceneShots(node);
    if (!shots.length) return;
    const items = shots.map((shot) => ({
      path: shot.path,
      src: null,
      title: `${step.name} · try ${n}`,
      caption: `camera: ${shot.camera}`,
    }));
    props.onLight(
      items,
      Math.max(
        0,
        shots.findIndex((shot) => shot.camera === picture.rightShot?.camera),
      ),
    );
  };
  const several = tries.length > 1;
  const reply = {
    label: several ? `${step.name} · try ${n}` : step.name,
    placeholder: "What should the worker do instead?",
    target: {
      facetId: node.facetId,
      iteration: node.iteration,
      ...(picture.rightShot ? { camera: picture.rightShot.camera } : {}),
    },
  };
  return (
    <Panel
      id={step.id}
      label="Selected step"
      title={step.name}
      status={
        <Status tone={STATE_TONE[step.state]} meta={several ? `${tries.length} tries` : null}>
          {stepPill(step, graph.active)}
        </Status>
      }
      onPrev={props.onPrev}
      onNext={props.onNext}
      onClose={props.onClose}
      reply={reply}
      onReply={props.onReply}
      media={
        <div className="flex flex-col gap-2.5">
          {liveFrame ? (
            <LiveScreen
              frame={liveFrame}
              trail={screen.trail}
              label={`${step.name} · try ${n}`}
              onOpen={(src, caption) =>
                props.onLight([{ path: null, src, title: `${step.name} · try ${n}`, caption }], 0)
              }
            />
          ) : (
            <TryStills picture={picture} onLine={step.onLine} label={rightLabel} onOpen={open} />
          )}
          <TriesStrip graph={graph} tries={tries} node={node} onPick={props.onPick} />
        </div>
      }
    >
      <StepStory step={step} node={node} />
      <NotesSection notes={node.notes} />
      <StepRows graph={graph} run={run} node={node} notesOpen={props.notesFor === node.id} />
    </Panel>
  );
}

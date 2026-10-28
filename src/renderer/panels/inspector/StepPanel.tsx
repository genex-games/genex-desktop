/** The card of one step: its picture before and after, its tries, what the judges said and their notes, and its checks. */
import type { JSX } from "react";
import { useMemo, useState } from "react";
import { t } from "../../../shared/i18n.ts";
import {
  type AdviceInfo,
  cameraWords,
  checkWords,
  type IterationNode,
  IterationStatus,
  type MergeInfo,
  type OutageInfo,
  plannedFlips,
  type RunGraph as RunGraphModel,
  type RunNode,
  runIdOf,
} from "../../run-graph.ts";
import { openingView, type ShotView, shotViews, viewBefore } from "../../run-graph-pictures.ts";
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
import { useRoundStill, useSavePointShot } from "../run-stills.ts";
import { Details, NotesSection, Panel, PanelRow, Para, Quote, Row, Rows } from "./chrome.tsx";
import { capitalise, listOrNull, modelLine } from "./format.ts";
import { JudgesNotes } from "./JudgesNotes.tsx";
import { Cameras, Compare, Single, TryThumb } from "./pictures.tsx";
import { LiveScreen, usePartScreen } from "./screen.tsx";
import { Status } from "./tone.tsx";
import type { StepPanelProps } from "./types.ts";

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
  return `${merge.head?.slice(0, 8) ?? ""}${merge.conflict ? ` · ${t("conflict")}` : ""}${merge.union ? ` · ${t("union")}` : ""}`;
};

const outageLine = (outage: OutageInfo | null): string | null => {
  if (!outage) return null;
  if (outage.phase) return t("×{count} during {phase}", { count: outage.count, phase: outage.phase });
  return `×${outage.count}`;
};

/** A picture's name on the camera switch and in the viewer: the lead's named one says what it is for. */
const viewLabel = (view: ShotView): string => (view.changed ? t("What changed") : cameraWords(view.shot.camera));

/**
 * The before and after of the try on show, and everything the picture switch needs: it opens on the
 * picture the step's card wears, and compares each camera only with that camera before it.
 */
function useStepPicture(props: StepPanelProps, node: IterationNode) {
  const { graph, row, step, baseSrc } = props;
  const views = useMemo(() => shotViews(node), [node]);
  const card = useSavePointShot(node, node === step.shown ? step.earlier : null);
  // A picture picked by hand holds for the try it was picked on; another try opens on its card's again.
  const [picked, setPicked] = useState<{ node: string; key: string } | null>(null);
  const pickedKey = picked?.node === node.id ? picked.key : null;
  const view = views.find((item) => item.key === pickedKey) ?? openingView(views, card);
  const live = graph.active && node.status === IterationStatus.Building;
  const rightShot = view?.shot ?? null;
  const right = useRoundStill(graph, node.facetId, node.iteration, rightShot?.path ?? null, live);
  const beforeNode = stepBefore(row, step)?.shown ?? null;
  const leftShot = beforeNode && view ? viewBefore(view, beforeNode) : null;
  const leftStill = useStill(leftShot ? { run: leftShot.path } : null);
  // The start's picture is the default camera's: the lead's named picture is framed its own way.
  const baseLeft = view?.changed ? null : baseSrc;
  const left = beforeNode ? leftStill : baseLeft;
  const compare = beforeNode ? Boolean(leftShot) : Boolean(baseLeft);
  const pick = (key: string): void => setPicked({ node: node.id, key });
  return { views, view, pick, right, left, compare };
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
              {flips.has(row.id) ? <span className="text-green"> · {t("newly passing")}</span> : null}
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
    <div role="group" aria-label={t("Tries")} className="flex flex-wrap gap-2.5 pt-1">
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
      {said ? (
        <Quote label={tries.length > 1 ? t("Reviewers · try {number}", { number: n }) : t("Reviewers")}>“{said}”</Quote>
      ) : null}
      {stopped ? <Para quiet>{capitalise(stopped)}.</Para> : null}
      {undone ? (
        <Para quiet>{t("Undone because {reason}.", { reason: undoneBecause(node.verdictSource, node.verdict) })}</Para>
      ) : null}
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
              {item.fix ? <span className="block text-ink-3">{t("Fix: {fix}", { fix: item.fix })}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {advice.boldMove ? <Quote label={t("One bold move")}>{advice.boldMove}</Quote> : null}
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
          row={PanelRow.ReviewersNotes}
          label={t("Reviewers' notes")}
          right={node.defects.length ? String(node.defects.length) : null}
          defaultOpen={notesOpen}
        >
          <JudgesNotes node={node} graph={graph} quoted={judgesOn(node)} />
        </Row>
      ) : null}
      {node.advice ? (
        <Row row={PanelRow.CriticsAdvice} label={t("Critic's advice")} right={String(node.advice.defects.length)}>
          <AdviceNotes advice={node.advice} />
        </Row>
      ) : null}
      {node.scoreboard ? (
        <Row row={PanelRow.Checks} label={t("Checks")} right={checkCounts(node.scoreboard)}>
          <CheckList node={node} />
        </Row>
      ) : null}
      <Row row={PanelRow.TechnicalDetails} label={t("Technical details")}>
        <Details
          rows={[
            [t("run"), runIdOf(graph)],
            [t("part"), node.facetId],
            [t("round"), String(node.iteration)],
            [t("verdict by"), node.verdictSource],
            [t("merged"), mergeLine(node.merge)],
            [t("cameras"), listOrNull(node.shots.map((shot) => cameraWords(shot.camera)))],
            [t("model"), modelLine(run.engine, run.model)],
            [t("flags"), listOrNull(node.flags.map((flag) => flag.what))],
            [t("outage"), outageLine(node.outage)],
          ]}
        />
      </Row>
    </Rows>
  );
}

/** The label of the still on the right: the try on show, this step, or this one try. */
function rightLabelOf(step: Step, n: number): string {
  if (step.tries.length > 1) return t("Try {number}", { number: n });
  return step.onLine ? t("This step") : t("This try");
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
          leftLabel={onLine ? t("Before") : t("In your build")}
          rightLabel={label}
          onOpen={onOpen}
        />
      ) : (
        <Single src={picture.right} label={label} onOpen={onOpen} />
      )}
      <Cameras
        views={picture.views.map((view) => ({ key: view.key, label: viewLabel(view) }))}
        value={picture.view?.key ?? null}
        onChange={picture.pick}
      />
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
  const tryTitle = t("{name} · try {number}", { name: step.name, number: n });
  const open = (): void => {
    const views = picture.views;
    if (!views.length) return;
    const items = views.map((view) => ({
      path: view.shot.path,
      src: null,
      title: tryTitle,
      caption: view.changed ? viewLabel(view) : t("camera: {camera}", { camera: viewLabel(view) }),
    }));
    props.onLight(
      items,
      Math.max(
        0,
        views.findIndex((view) => view.key === picture.view?.key),
      ),
    );
  };
  const several = tries.length > 1;
  const reply = {
    label: several ? tryTitle : step.name,
    placeholder: t("What should the worker do instead?"),
    target: {
      facetId: node.facetId,
      iteration: node.iteration,
      // A note names a real camera: the lead's named picture is no camera of the game's.
      ...(picture.view && !picture.view.changed ? { camera: picture.view.shot.camera } : {}),
    },
  };
  return (
    <Panel
      id={step.id}
      label={t("Selected step")}
      title={step.name}
      status={
        <Status
          tone={STATE_TONE[step.state]}
          meta={several ? t("{count, plural, other {# tries}}", { count: tries.length }) : null}
        >
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
              label={tryTitle}
              onOpen={(src, caption) => props.onLight([{ path: null, src, title: tryTitle, caption }], 0)}
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

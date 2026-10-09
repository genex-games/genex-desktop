/**
 * Steps — what the Builds graph draws, folded out of the run graph and its recorded summary.
 *
 * A part is a row. Its rounds fold into steps: every try at the same move or fix is one node,
 * and the group ends at the try the judges kept. What reached the build sits on the row's line
 * and runs on to the result; anything that did not (an undone step, a stopped one, the work in
 * hand) hangs below it. A part with nothing on the line keeps its nodes on the row, ghosted, and
 * never joins the result.
 *
 * A step's state comes from the build first and the judges second. A round nobody judged is not left
 * unexplained when the lead merged the part's work afterwards: that work is in the build, and
 * the lead is who checked it. The judges show as a gate — an eye on the edge into a node they
 * looked at; a node the lead let in has no eye.
 *
 * Pure: no DOM, no window. `panels/RunGraph.tsx` draws it and the tests read it directly.
 */
import { MINUTE_MS } from "../shared/duration.ts";
import { GameEngine } from "../shared/game-engine.ts";
import { comparedWithNothing, ExecutionStatus, type RunWorked, VerdictPass, workedMs } from "../shared/run-state.ts";
import { type RunSummary, UNKNOWN_EXECUTION } from "../shared/run-summary.ts";
import { plural } from "../shared/skill-words.ts";
import { WorkerEnd, WorkerVerdict } from "../shared/workers.ts";
import {
  boundsOf,
  type FacetNode,
  finalNodeOf,
  GraphNodeKind,
  headVerdict,
  type IntegrationNode,
  type IterationNode,
  IterationStatus,
  type MergeInfo,
  plainDefect,
  type Rect,
  type RunGraph,
  truncate,
  type VerdictRecord,
  WorkerState,
} from "./run-graph.ts";
import type { WorkerInfo } from "./run-graph-workers.ts";
import {
  GAME_ENGINE_WORDS,
  MINUTES_PER_HOUR,
  ranToItsEnd,
  savedByLead,
  spanWords,
  stoppedWords,
  TURN_WORDS,
  verdictSentence,
  WORKER_STOP_WORDS,
  WORKER_WORDS,
  workersOnIt,
} from "./words.ts";

// ── the model ─────────────────────────────────────────────────────────────────────────────

/**
 * `in-build`: merged into the build. `kept`: the judges kept it and the lead has not merged it
 * (yet). `delivered`: a sub-agent's files are in the game folder and wait for the lead to use
 * them. `undone`: the judges threw every try away. `building`/`judging`: in hand now.
 * `not-in-build`: it ended unjudged and unmerged — stopped, or the run ended first. `waiting`:
 * a part that has not started.
 */
export const StepState = {
  InBuild: "in-build",
  Kept: "kept",
  Delivered: "delivered",
  Undone: "undone",
  Building: "building",
  Judging: "judging",
  NotInBuild: "not-in-build",
  /** A single session that failed: it delivered nothing to leave out. */
  NotDelivered: "not-delivered",
  Waiting: "waiting",
} as const;
export type StepState = (typeof StepState)[keyof typeof StepState];

/** The eye on the edge into a node: what the judges made of it. No gate: no judge looked. */
export const Gate = { Kept: "kept", Undone: "undone", Looking: "looking", Waiting: "waiting" } as const;
export type Gate = (typeof Gate)[keyof typeof Gate];

/** Who let a step into the build: the judges, or the lead when no judge saw it. */
export const CheckedBy = { Judges: "judges", Lead: "lead" } as const;
export type CheckedBy = (typeof CheckedBy)[keyof typeof CheckedBy];

export interface Step {
  id: string;
  facetId: string;
  /** a part built in one session: one node for the whole part, no tries */
  session: boolean;
  /** oldest first; empty for a session */
  tries: IterationNode[];
  /** the try the node shows — the kept one, else the one that went in, else the latest */
  shown: IterationNode | null;
  name: string;
  /** what the builder was asked, in full */
  asked: string | null;
  state: StepState;
  /** on the row's line: in the build (or, while the run goes on, kept and on its way) */
  onLine: boolean;
  gate: Gate | null;
  /** who let it into the build: the judges, or the lead when no judge saw it */
  checkedBy: CheckedBy | null;
  /** a lead's judge of a single-session part's build, when one looked */
  verdict: VerdictRecord | null;
  /** What a worker's own records say, on the one node of its row: it picks the node's words. */
  worker?: WorkerInfo;
}

export interface PartRow {
  facet: FacetNode;
  steps: Step[];
  /** steps in the build */
  inBuild: number;
  /** anything of this part was merged */
  integrated: boolean;
  working: boolean;
}

const JUDGED = new Set<IterationNode["status"]>([IterationStatus.Accepted, IterationStatus.Rolled]);
/** Whether the judges ruled on a try: kept it, or undid it. A save the lead kept itself had no judge. */
export const isJudgedTry = (node: IterationNode): boolean =>
  JUDGED.has(node.status) && !savedByLead(node.verdictSource);
const isKept = (node: IterationNode): boolean => node.status === IterationStatus.Accepted;
const capitalise = (text: string): string => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
/** A worker's row while its worker works: what the lead of a tree waits for. */
export const isWorkerAtWork = (row: PartRow): boolean => row.working && row.facet.worker !== undefined;
/** A step in hand now: being built, or being judged. */
export const isLiveStep = (step: Step): boolean =>
  step.state === StepState.Building || step.state === StepState.Judging;

/** How long a node's name may run. */
const HEADLINE_MAX = 64;

/** The first clause of what a round was asked, as a node's name: "Add a wreck-lifecycle system". */
export function headline(text: string): string {
  const clean = plainDefect(text).replace(/\s+/g, " ").trim();
  const first = clean.split(/\s*(?::|—|–|;|\.\s)\s*/)[0] ?? clean;
  const head = (first.length >= 4 ? first : clean).replace(/[.\s]+$/, "");
  return capitalise(truncate(head, HEADLINE_MAX));
}

export function stepName(node: IterationNode): string {
  const asked = node.fix?.what ?? node.move?.what ?? null;
  if (asked) return headline(asked);
  return node.iteration === 1 ? "First build" : "Small fixes";
}

/** Two rounds are tries at one step when they were asked the same thing. */
function stepKey(node: IterationNode): string {
  if (node.fix) return `fix:${node.fix.checkId ?? node.fix.what}`;
  if (node.move) return `move:${node.move.milestoneId ?? node.move.what}`;
  return `round:${node.iteration}`;
}

/** A round is one more try at the group's step while the group was asked the same and kept nothing. */
function continuesTries(group: IterationNode[] | undefined, round: IterationNode): group is IterationNode[] {
  if (!group) return false;
  const [first] = group;
  return first !== undefined && stepKey(first) === stepKey(round) && !group.some(isKept);
}

/** Consecutive tries at one step, each group ending at the try the judges kept. */
export function foldTries(rounds: IterationNode[]): IterationNode[][] {
  const groups: IterationNode[][] = [];
  for (const round of rounds) {
    const last = groups.at(-1);
    if (continuesTries(last, round)) last.push(round);
    else groups.push([round]);
  }
  return groups;
}

/**
 * The rounds a part's merges carried into the build. A loop's merge names its round, and takes
 * every kept round up to it. A lead's merge names only a moment: it takes the part's last kept
 * round, or — when nothing was kept yet — whatever the builder had committed, which is every
 * unjudged round that had started by then.
 */
export function mergedRounds(rounds: IterationNode[], merges: MergeInfo[]): Set<IterationNode> {
  const merged = new Set<IterationNode>();
  for (const merge of merges) {
    if (merge.conflict) continue;
    for (const round of roundsMergedBy(rounds, merge)) merged.add(round);
  }
  return merged;
}

/** Whether a round's verdict landed before this point in the log. */
const judgedBefore = (round: IterationNode, seq: number): boolean => round.judgedSeq !== null && round.judgedSeq < seq;

function roundsMergedBy(rounds: IterationNode[], merge: MergeInfo): IterationNode[] {
  const { iteration } = merge;
  if (iteration !== null) return rounds.filter((round) => isKept(round) && round.iteration <= iteration);
  // Ordered by the log, not the clock: a batch of records can share one millisecond.
  const kept = rounds.filter((round) => isKept(round) && judgedBefore(round, merge.seq));
  if (kept.length) return kept;
  return rounds.filter((round) => !JUDGED.has(round.status) && round.startedSeq < merge.seq);
}

/** Who kept a try: the judges, or the lead when it saved the try itself after looking at it. */
const keptBy = (node: IterationNode): CheckedBy =>
  savedByLead(node.verdictSource) ? CheckedBy.Lead : CheckedBy.Judges;

/** Where a folded step stands, and who let it in: the build first, the judges second. */
function stepStanding(tries: IterationNode[], merged: Set<IterationNode>): Pick<Step, "state" | "checkedBy"> {
  const kept = tries.find(isKept);
  if (kept) return { state: merged.has(kept) ? StepState.InBuild : StepState.Kept, checkedBy: keptBy(kept) };
  const latest = tries.at(-1);
  if (latest?.status === IterationStatus.Building)
    return { state: latest.liveness ? StepState.Judging : StepState.Building, checkedBy: null };
  if (tries.some((node) => merged.has(node))) return { state: StepState.InBuild, checkedBy: CheckedBy.Lead };
  if (tries.some(isJudgedTry)) return { state: StepState.Undone, checkedBy: null };
  return { state: StepState.NotInBuild, checkedBy: null };
}

function stepGate({ state, checkedBy }: Pick<Step, "state" | "checkedBy">): Gate | null {
  if (state === StepState.Judging) return Gate.Looking;
  if (checkedBy === CheckedBy.Judges) return Gate.Kept;
  return state === StepState.Undone ? Gate.Undone : null;
}

/** A try in hand shows its newest frame; otherwise the latest try that saved a picture. */
function shownTry(tries: IterationNode[], merged: Set<IterationNode>, latest: IterationNode): IterationNode {
  const kept = tries.find(isKept) ?? tries.filter((node) => merged.has(node)).at(-1);
  if (kept) return kept;
  if (latest.status === IterationStatus.Building) return latest;
  return [...tries].reverse().find((node) => node.shots.length > 0) ?? latest;
}

function roundStep(tries: IterationNode[], merged: Set<IterationNode>, active: boolean): Step {
  const first = tries[0];
  const latest = tries.at(-1);
  if (!first || !latest) throw new Error("a step folds at least one try");
  const standing = stepStanding(tries, merged);
  return {
    id: `step:${first.facetId}:${first.iteration}`,
    facetId: first.facetId,
    session: false,
    tries,
    shown: shownTry(tries, merged, latest),
    name: stepName(first),
    asked: first.fix?.what ?? first.move?.what ?? null,
    state: standing.state,
    onLine: standing.state === StepState.InBuild || (standing.state === StepState.Kept && active),
    gate: stepGate(standing),
    checkedBy: standing.checkedBy,
    verdict: null,
  };
}

/** Every row the graph draws, in plan order. */
export function partRows(graph: RunGraph, summary: RunSummary | null = graph.summary ?? null): PartRow[] {
  const integration = graph.nodes.find((node): node is IntegrationNode => node.kind === GraphNodeKind.Integration);
  const merges = (integration?.merges ?? []).filter((merge) => !merge.conflict);
  return graph.facets.map((facet) => partRow(graph, facet, merges, summary));
}

type RunTask = RunSummary["tasks"][number];

function partRow(graph: RunGraph, facet: FacetNode, merges: MergeInfo[], summary: RunSummary | null): PartRow {
  const rounds = graph.nodes
    .filter((node): node is IterationNode => node.kind === GraphNodeKind.Iteration && node.facetId === facet.facetId)
    .sort((a, b) => a.iteration - b.iteration);
  const partMerges = merges.filter((merge) => merge.facetId === facet.facetId);
  const task = summary?.tasks.find((row) => row.id === facet.facetId) ?? null;
  // A worker's own verdict says its work was added to the game: no run merge records it.
  const integrated = partMerges.length > 0 || (task?.integrations ?? 0) > 0 || facet.worker?.merged === true;
  const busy =
    facet.building ||
    task?.state === WorkerState.Running ||
    rounds.some((round) => round.status === IterationStatus.Building);
  const working = graph.active && busy;
  const merged = mergedRounds(rounds, partMerges);
  const steps = rounds.length
    ? foldTries(rounds).map((tries) => roundStep(tries, merged, graph.active))
    : [sessionStep(graph, facet, task, { integrated, working })];
  const inBuild = steps.filter((step) => step.state === StepState.InBuild).length;
  return { facet, steps, inBuild, integrated, working };
}

/** A part built in one session: one node for the whole part. */
function sessionStep(
  graph: RunGraph,
  facet: FacetNode,
  task: RunTask | null,
  part: { integrated: boolean; working: boolean },
): Step {
  const verdict = sessionVerdict(graph, facet, task);
  const state = sessionState(graph, facet, task, part);
  return {
    id: `session:${facet.facetId}`,
    facetId: facet.facetId,
    session: true,
    tries: [],
    shown: null,
    name: facet.title,
    asked: null,
    state,
    onLine: state === StepState.InBuild || finishedWell(facet, state),
    gate: verdictGate(verdict),
    checkedBy: sessionCheckedBy(verdict, part.integrated),
    verdict,
    ...(facet.worker ? { worker: facet.worker } : {}),
  };
}

/**
 * A worker that finished its task and left nothing waiting on the lead: it read, or the lead used
 * what it made. It stands on the line, joined to the result, though nothing of it was merged; work
 * handed back and not used yet, a rejected worker and one that did not finish stay ghosts.
 */
function finishedWell(facet: FacetNode, state: StepState): boolean {
  const worker = facet.worker;
  if (state !== StepState.Delivered || worker?.ended !== WorkerEnd.Done) return false;
  if (worker.verdict === WorkerVerdict.Rejected) return false;
  return !facet.delivered || worker.verdict === WorkerVerdict.Used;
}

/** Whether a row's step is a worker that finished well: on the line, though not in the build. */
const isFinishedWorker = (step: Step): boolean => step.session && step.onLine && step.state === StepState.Delivered;

/** A lead's judge that compared this part's own build, side by side. */
function sessionVerdict(graph: RunGraph, facet: FacetNode, task: RunTask | null): VerdictRecord | null {
  const workers = new Set([facet.facetId, ...(task?.workers ?? [])]);
  const compared = graph.verdicts
    .filter((row) => row.seen.pick !== null)
    .filter((row) => row.build.worker !== null && workers.has(row.build.worker));
  return compared.at(-1) ?? null;
}

function sessionState(
  graph: RunGraph,
  facet: FacetNode,
  task: RunTask | null,
  part: { integrated: boolean; working: boolean },
): StepState {
  if (part.integrated) return StepState.InBuild;
  if (part.working) return StepState.Building;
  // The lead did not use what the worker made: its work stops there, whatever it delivered.
  if (facet.worker?.verdict === WorkerVerdict.Rejected) return StepState.NotInBuild;
  if (facet.delivered) return StepState.Delivered;
  if (facet.failed) return StepState.NotDelivered;
  // A worker that finished its task is done, whether or not it made files to add.
  if (facet.worker?.ended === WorkerEnd.Done) return StepState.Delivered;
  const started =
    Boolean(task?.attempts.length) ||
    facet.building ||
    facet.stoppedBecause !== null ||
    facet.satisfied !== null ||
    graph.active === false;
  return started ? StepState.NotInBuild : StepState.Waiting;
}

function verdictGate(verdict: VerdictRecord | null): Gate | null {
  if (!verdict) return null;
  return verdict.decision.kept === false ? Gate.Undone : Gate.Kept;
}

function sessionCheckedBy(verdict: VerdictRecord | null, integrated: boolean): CheckedBy | null {
  if (verdict) return CheckedBy.Judges;
  return integrated ? CheckedBy.Lead : null;
}

/** What the row's label says beside the part's name. A single session has no label: its node says it all. */
export function rowMeta(row: PartRow, active: boolean): string {
  if (row.steps.every((step) => step.session)) return "";
  const total = row.steps.length;
  if (row.inBuild === total) return total === 1 ? "added" : `all ${total} added`;
  if (active && row.working) return row.inBuild ? `${row.inBuild} added so far` : "working";
  if (!row.inBuild) return "nothing added";
  return `${row.inBuild} of ${total} added`;
}

/** The step the run is on right now — the newest one in hand — or null between steps. */
export function frontier(rows: PartRow[]): Step | null {
  let newest: Step | null = null;
  let newestAt = "";
  for (const row of rows)
    for (const step of row.steps) {
      if (!isLiveStep(step)) continue;
      const at = step.tries.at(-1)?.activityAt ?? step.tries.at(-1)?.startedAt ?? "";
      if (newest === null || at > newestAt) {
        newest = step;
        newestAt = at;
      }
    }
  return newest;
}

// ── words a node wears ────────────────────────────────────────────────────────────────────

/** The colour a state or a status line is drawn in. */
export const Tone = { Green: "green", Red: "red", Accent: "accent", Muted: "muted", Orange: "orange" } as const;
export type Tone = (typeof Tone)[keyof typeof Tone];

export const STATE_TONE: Record<StepState, Tone> = {
  [StepState.InBuild]: Tone.Green,
  [StepState.Kept]: Tone.Green,
  [StepState.Delivered]: Tone.Green,
  [StepState.Undone]: Tone.Red,
  [StepState.Building]: Tone.Accent,
  [StepState.Judging]: Tone.Accent,
  [StepState.NotInBuild]: Tone.Muted,
  [StepState.NotDelivered]: Tone.Muted,
  [StepState.Waiting]: Tone.Muted,
};

/** How many tries a folded node stands for, or nothing for one. */
export function triesWord(step: Step): string | null {
  return step.tries.length > 1 ? `${step.tries.length} tries` : null;
}

/**
 * The status line of each state on a node; `kept` depends on whether the run goes on. The chat
 * says "Added" for a part merged into the build, and so does the graph.
 */
const STEP_WORD: Record<Exclude<StepState, typeof StepState.Kept>, string> = {
  [StepState.InBuild]: "Added",
  [StepState.Delivered]: "Delivered",
  [StepState.Undone]: "Undone",
  [StepState.Building]: "Working",
  [StepState.Judging]: "Being checked",
  [StepState.Waiting]: "Waiting to start",
  [StepState.NotInBuild]: "Left out",
  [StepState.NotDelivered]: "Didn't deliver",
};

/**
 * A worker's word for where its one node stands, the same on its node and its card: how it ended,
 * never how it works. The states a worker's node never takes keep the part's words.
 */
const WORKER_STATE_WORD: Partial<Record<StepState, string>> = {
  [StepState.InBuild]: WORKER_WORDS.added,
  [StepState.Delivered]: WORKER_WORDS.done,
  [StepState.NotDelivered]: WORKER_WORDS.didntFinish,
  [StepState.NotInBuild]: WORKER_WORDS.stopped,
};

/**
 * Where a worker works in place, in words: the label of the lock it holds, else (an older record)
 * the engine other than the web's whose game folder it works in; null for neither.
 */
function workingPlace(worker: WorkerInfo): string | null {
  if (worker.where) return worker.where;
  return worker.in !== null && worker.in !== GameEngine.Web ? GAME_ENGINE_WORDS[worker.in] : null;
}

/** Whether a part stopped short of its end for a reason worth saying; one that finished its work has none. */
export const stoppedShort = (reason: string | null | undefined): reason is string =>
  Boolean(reason) && reason !== "done" && !ranToItsEnd(reason);

/** The ends a worker's card gives a reason for: it stopped short of its task. */
const STOPPED_SHORT_ENDS: ReadonlySet<WorkerEnd | null> = new Set([WorkerEnd.Failed, WorkerEnd.Stopped]);

/**
 * Why a worker stopped short (it failed, or was stopped), on its card: its end record's code in the
 * app's own words. The reason its records and its part carry is written for the lead, so a worker
 * whose end has no code says none. Null for a worker that finished or still works.
 */
export function workerStopWords(worker: WorkerInfo): string | null {
  if (!STOPPED_SHORT_ENDS.has(worker.ended) || !worker.stopCode) return null;
  return WORKER_STOP_WORDS[worker.stopCode];
}

/** A worker's word for its node, or null for a step that is no worker's. */
function workerWord(step: Step): string | null {
  const { worker } = step;
  if (!worker) return null;
  if (step.state === StepState.Building) {
    const place = workingPlace(worker);
    return place ? WORKER_WORDS.workingIn(place) : WORKER_WORDS.working;
  }
  const rejected = worker.verdict === WorkerVerdict.Rejected;
  if (step.state === StepState.NotInBuild && rejected) return WORKER_WORDS.notUsed;
  return WORKER_STATE_WORD[step.state] ?? null;
}

/** The one status line on a node; the tries it folds are counted on its picture. */
export function stepWord(step: Step, active: boolean): string {
  if (step.state === StepState.Kept) return active ? "Kept" : "Kept, not added";
  return workerWord(step) ?? STEP_WORD[step.state];
}

/** The status of each state at the top of a step's card; `kept` depends on whether the run goes on. */
const STEP_PILL: Record<Exclude<StepState, typeof StepState.Kept>, string> = {
  [StepState.InBuild]: "Added to your build",
  [StepState.Delivered]: "Delivered, not used yet",
  [StepState.Building]: "Working",
  [StepState.Judging]: "Being checked",
  [StepState.Waiting]: "Waiting to start",
  [StepState.Undone]: "Rejected by reviewers",
  [StepState.NotInBuild]: "Left out of your build",
  [StepState.NotDelivered]: "Didn't deliver",
};

/** The status at the top of a step's card: who decided it, or where it stands against the build you play. */
export function stepPill(step: Step, active: boolean): string {
  if (step.state === StepState.Kept) return active ? "Kept by reviewers" : "Kept by reviewers, not added";
  return workerWord(step) ?? STEP_PILL[step.state];
}

const COUNT = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const count = (n: number): string => COUNT[n] ?? String(n);
const ORDINAL = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"];
const ordinal = (n: number): string => ORDINAL[n] ?? `${n}th`;

/** A single session's sentence, by where it stands. */
function sessionSentence(state: StepState): string {
  if (state === StepState.InBuild) return "Built in one session and merged into your build.";
  if (state === StepState.Building) return "A worker is building it in one session.";
  if (state === StepState.Waiting) return "It hasn't started yet.";
  if (state === StepState.Delivered) return "Its files are in your game folder, waiting for the lead to use them.";
  if (state === StepState.NotDelivered) return "Its session failed before it delivered anything.";
  return "Built in one session. Its work wasn't merged into your build.";
}

/** What a step the lead saved itself says instead of the judges' words: nobody judged it. */
const LEAD_SAVED = "The lead saved it after looking at its own captures; no reviewer judged it.";

/** What the judges did with a step's tries: kept one (after undoing some), or undid them. */
function judgesSentence(tries: number, undone: number, keptAt: number): string {
  if (keptAt === 1) return "The reviewers kept it on the first try.";
  if (keptAt) {
    const before = count(undone) === "one" ? "the one" : count(undone);
    return `The reviewers kept try ${keptAt} after undoing ${before} before it.`;
  }
  if (!undone) return "";
  if (undone === tries)
    return undone === 1 ? "The reviewers undid it." : `The reviewers undid all ${count(undone)} tries.`;
  return `The reviewers undid ${count(undone)} ${undone === 1 ? "try" : "tries"}.`;
}

/** Which tries the lead stopped before any judge saw them. */
function leadStopSentence(tries: IterationNode[], stopped: IterationNode[]): string {
  if (!stopped.length) return "";
  if (tries.length === 1) return "The lead stopped it before the reviewers saw it.";
  const [only] = stopped;
  if (stopped.length === 1 && only) return `The lead stopped the ${ordinal(tries.indexOf(only) + 1)}.`;
  return `The lead stopped ${count(stopped.length)}.`;
}

/** Where the step stands against the build now. */
function standingSentence(step: Step, active: boolean, anyStopped: boolean): string {
  const tries = step.tries.length;
  switch (step.state) {
    case StepState.InBuild:
      return step.checkedBy === CheckedBy.Lead && !step.tries.some(isKept)
        ? "No reviewer saw it; the lead merged the part's work into your build."
        : "";
    case StepState.Kept:
      return active
        ? "It merges into your build when the lead integrates this part."
        : "The lead didn't merge it, so it isn't in your build.";
    case StepState.NotInBuild:
      return anyStopped ? "Its work is saved, not merged." : "The run ended before the reviewers saw it.";
    case StepState.Building:
      return tries > 1 ? `The worker is on try ${tries}.` : "A worker is building it.";
    case StepState.Judging:
      return `The reviewers are looking at try ${tries}.`;
    default:
      return "";
  }
}

/**
 * What happened to a step, in one or two plain sentences: who kept or undid which try, and who
 * stopped one. The judges' own words go beside it, quoted; this line never paraphrases them.
 */
export function stepSentence(step: Step, active: boolean): string {
  if (step.session) return sessionSentence(step.state);
  const all = step.tries;
  const undone = all.filter((node) => node.status === IterationStatus.Rolled).length;
  const stopped = all.filter((node) => node.status === IterationStatus.Stopped);
  const keptAt = all.findIndex(isKept) + 1;
  const savedAt = all.find(isKept);
  const parts = [
    savedAt && savedByLead(savedAt.verdictSource) ? LEAD_SAVED : judgesSentence(all.length, undone, keptAt),
    keptAt ? "" : leadStopSentence(all, stopped),
    standingSentence(step, active, stopped.length > 0),
  ].filter(Boolean);
  return parts.join(" ") || (all.at(-1)?.status === IterationStatus.Accepted ? "Kept." : "");
}

/** What the judges said about one try, in their words, or nothing when they said nothing. */
export function judgesOn(node: IterationNode): string {
  return (
    verdictSentence(node.verdict) || plainDefect(node.biggestGap) || (isJudgedTry(node) ? plainDefect(node.reason) : "")
  );
}

/** The lead's reason for stopping a try, when it gave one — without saying twice who stopped it. */
export function leadStopped(node: IterationNode): string | null {
  if (node.status !== IterationStatus.Stopped || !node.reason) return null;
  const words = stoppedWords(node.reason).replace(/^stopped by the lead\s*(?:—\s*)?/, "");
  return words || null;
}

/** What a step was asked, minus the name the node already wears: "Tall mountain: a tall…" → "A tall…". */
export function askedRest(step: Step): string | null {
  const asked = step.asked ? plainDefect(step.asked).replace(/\s+/g, " ").trim() : "";
  if (!asked) return null;
  const head = step.name.replace(/…$/, "");
  if (!asked.toLowerCase().startsWith(head.toLowerCase())) return asked;
  const rest = asked
    .slice(head.length)
    .replace(/^\s*(?::|—|–|;|\.)\s*/, "")
    .trim();
  return rest ? capitalise(rest) : null;
}

// ── the result's gate and the status line ─────────────────────────────────────────────────

/** Is there a build of this run to offer: a head that moved off the start, or a merge at all. */
function hasNewBuild(graph: RunGraph, summary: RunSummary | null | undefined): boolean {
  return summary ? Boolean(summary.head && summary.head !== summary.base) : graph.mergedHead !== null;
}

/**
 * Did a judge compare the build on offer with what came before it? A health pass is not a
 * comparison: a build made live on health alone gets the grey eye, never the green one.
 */
export function resultGate(graph: RunGraph): Gate | null {
  if (finalNodeOf(graph)?.landing?.verified) return Gate.Kept;
  const verdict = headVerdict(graph);
  const compared = verdict !== null && verdict.seen.pick !== null && verdict.decision.kept !== null;
  if (compared) return verdict.decision.kept ? Gate.Kept : Gate.Undone;
  if (graph.active) return null;
  return hasNewBuild(graph, graph.summary) ? Gate.Waiting : null;
}

export interface StatusLine {
  tone: Tone | "live";
  strong: string;
  rest: string;
}

/** The round the latest merge brought in, when the graph has it. */
function lastMergedRound(graph: RunGraph): IterationNode | undefined {
  const last = graph.lastMerged;
  if (!last) return undefined;
  return graph.nodes.find(
    (node): node is IterationNode =>
      node.kind === GraphNodeKind.Iteration && node.facetId === last.facetId && node.iteration === last.iteration,
  );
}

/**
 * The build on offer was just merged and nothing has shown yet that it starts: no picture of it,
 * no health pass. Until something has, it is not "ready to play".
 */
export function checkingBuild(graph: RunGraph, summary: RunSummary | null): boolean {
  if (!graph.active || !summary?.head || summary.head === summary.base || summary.captures?.current) return false;
  const merged = graph.mergedHead;
  // The lead's own commits move the head without a merge; nothing is pending a check then.
  if (!merged || merged.head !== summary.head || merged.healthy !== null) return false;
  return !lastMergedRound(graph)?.shots.length;
}

export interface ResultStatus {
  word: string;
  tone: Tone;
  state: StepState;
}

/** A running run's build: none yet, one that did not start, one being tried, or one to play. */
function runningResultStatus(graph: RunGraph, summary: RunSummary | null): ResultStatus {
  if (!hasNewBuild(graph, summary)) return { word: "Nothing yet", tone: Tone.Muted, state: StepState.Waiting };
  const merged = graph.mergedHead;
  const didNotStart = merged !== null && summary !== null && merged.head === summary.head && merged.healthy === false;
  if (didNotStart) return { word: "Didn't start", tone: Tone.Red, state: StepState.Undone };
  if (checkingBuild(graph, summary))
    return { word: "Checking it starts…", tone: Tone.Accent, state: StepState.Judging };
  return { word: "Ready to play", tone: Tone.Green, state: StepState.InBuild };
}

/**
 * The build a running run offers to play on Live — the one its result node calls ready to
 * play — or null while there is none, it is still being tried, it didn't start, or the run is over.
 */
export function readyToPlay(graph: RunGraph, summary: RunSummary | null): string | null {
  if (!graph.active || !summary?.head) return null;
  return runningResultStatus(graph, summary).state === StepState.InBuild ? summary.head : null;
}

/** Who took the last look at the build on offer, as the result card names them; the reviewers otherwise. */
const REVIEW_BY: Partial<Record<string, string>> = {
  [VerdictPass.Health]: "Health check",
  [VerdictPass.Close]: "Lead's last look",
};

/**
 * The last look anybody took at the build on offer, for the result card: who looked, and the
 * sentence they wrote. Nothing when nobody wrote one, or when the build had nothing to be
 * compared with — a first build from an empty game is judged on its own, and saying so is noise.
 */
export function buildReview(graph: RunGraph): { label: string; words: string } | null {
  const look = headVerdict(graph);
  const words = verdictSentence(look);
  if (!look || !words || comparedWithNothing(look.decision.rule)) return null;
  return { label: REVIEW_BY[look.pass] ?? "Reviewers", words };
}

/** A chat turn put a worker's work in your game: the lead added it, or the worker wrote it there and finished. */
const turnAddedWork = (graph: RunGraph): boolean => graph.facets.some((facet) => facet.worker?.merged === true);

/**
 * A chat turn's result: its workers change the game itself, so there is no separate build. It is
 * live once a worker's work is in, nothing yet while they work, and done once they ended: no
 * record says whether the lead changed the game itself, so it never claims the game is unchanged.
 */
function turnResultStatus(graph: RunGraph): ResultStatus {
  if (turnAddedWork(graph)) return { word: TURN_WORDS.live, tone: Tone.Green, state: StepState.InBuild };
  if (graph.active) return { word: TURN_WORDS.nothingYet, tone: Tone.Muted, state: StepState.Waiting };
  return { word: TURN_WORDS.done, tone: Tone.Muted, state: StepState.Delivered };
}

/** What the result node and its card both say about the build you would play. */
export function resultStatus(graph: RunGraph, summary: RunSummary | null): ResultStatus {
  if (graph.turn) return turnResultStatus(graph);
  if (summary?.landed === true) return { word: "Live in your game", tone: Tone.Green, state: StepState.InBuild };
  if (graph.active) return runningResultStatus(graph, summary);
  if (hasNewBuild(graph, summary)) return { word: "Not live yet", tone: Tone.Orange, state: StepState.Kept };
  return { word: "No new build", tone: Tone.Muted, state: StepState.NotInBuild };
}

/** Where the run stands: its recorded execution, else live or completed by the graph. */
export const runExecution = (graph: RunGraph, summary: RunSummary | null): string =>
  summary?.execution ?? (graph.active ? ExecutionStatus.Running : ExecutionStatus.Completed);

/**
 * The lead has the run to itself: no part is working and no build is waiting on a check. It is
 * planning, changing the game itself, or winding down — the graph draws it so a run between parts
 * never looks finished.
 */
export function leadWorking(graph: RunGraph, summary: RunSummary | null, rows: PartRow[]): boolean {
  if (!graph.active || runExecution(graph, summary) !== ExecutionStatus.Running) return false;
  const base = graph.nodes.find((node) => node.kind === GraphNodeKind.Base);
  if (base?.kind === GraphNodeKind.Base && !base.done) return false;
  return !rows.some((row) => row.working) && !checkingBuild(graph, summary);
}

/** How far a run is into the time it was given: "9 of 30 min", "1 h 5 min of 2 h". */
export function budgetWords(elapsedMs: number, budgetMs: number): string {
  const elapsed = Math.max(0, Math.floor(elapsedMs / MINUTE_MS));
  const budget = Math.max(1, Math.round(budgetMs / MINUTE_MS));
  return budget < MINUTES_PER_HOUR ? `${elapsed} of ${budget} min` : `${spanWords(elapsed)} of ${spanWords(budget)}`;
}

/** A span of whole minutes in the chat build card's short units: "9m", "1h", "1h 5m". */
function shortSpanWords(minutes: number): string {
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`;
  const rest = minutes % MINUTES_PER_HOUR;
  return `${Math.floor(minutes / MINUTES_PER_HOUR)}h${rest ? ` ${rest}m` : ""}`;
}

/**
 * The time a build was given, as the chat's build card says it: "up to 10h". It is a cap, not a
 * target — the build may finish well before it.
 */
export function capWords(budgetMs: number): string {
  return `up to ${shortSpanWords(Math.max(1, Math.round(budgetMs / MINUTE_MS)))}`;
}

/** Whole minutes from `from` to `to` (or now); null when unknown, backwards or under a minute. */
function elapsedMinutes(from: string | null | undefined, to: string | null | undefined, now: number): number | null {
  if (!from) return null;
  const start = Date.parse(from);
  const end = to ? Date.parse(to) : now;
  const valid = Number.isFinite(start) && Number.isFinite(end) && end >= start;
  if (!valid) return null;
  const minutes = Math.round((end - start) / MINUTE_MS);
  return minutes < 1 ? null : minutes;
}

export function elapsedWords(
  from: string | null | undefined,
  to: string | null | undefined,
  now = Date.now(),
): string | null {
  const minutes = elapsedMinutes(from, to, now);
  return minutes === null ? null : spanWords(minutes);
}

const listWords = (names: string[]): string =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** How many steps that missed the build the finished line names before it only counts them. */
const MAX_NAMED_MISSING = 2;

interface LineFacts {
  /** how long the build has worked, pauses aside: "1 h 5 min" */
  worked: string | null;
  /** the same for a build that can go on, against the time it was given when it has one: "1 h 5 min of 8 h" */
  time: string | null;
  hasBuild: boolean;
}

/** How long a build has worked, in whole minutes: "0 min", "9 min", "1 h 5 min". */
const workedWords = (ms: number): string => spanWords(Math.max(0, Math.floor(ms / MINUTE_MS)));

/**
 * How long a build has worked by `now` (a summary's `worked`): "1 h 5 min", never a pause or the
 * hours the app was closed under it. Null while its start is unknown.
 */
export function workedSpan(worked: RunWorked | null | undefined, now = Date.now()): string | null {
  return worked ? workedWords(workedMs(worked, now)) : null;
}

/** The same in the chat build card's short units, "5h 17m"; null under a minute. */
export function workedShortWords(worked: RunWorked | null | undefined, now = Date.now()): string | null {
  const minutes = worked ? Math.floor(workedMs(worked, now) / MINUTE_MS) : 0;
  return minutes < 1 ? null : shortSpanWords(minutes);
}

/**
 * The time a build has worked (run-state.ts `RunWorked`, left out while its start is unknown),
 * said once for every state, and against the time it was given while it can still go on.
 */
function lineFacts(graph: RunGraph, summary: RunSummary | null, now: number): LineFacts {
  const run = graph.nodes.find((node) => node.kind === GraphNodeKind.Run);
  const budget = run?.kind === GraphNodeKind.Run ? (run.durationMs ?? null) : null;
  const ms = summary?.worked ? workedMs(summary.worked, now) : null;
  const worked = ms === null ? null : workedWords(ms);
  return {
    worked,
    time: ms !== null && budget ? budgetWords(ms, budget) : worked,
    hasBuild: hasNewBuild(graph, summary),
  };
}

/** A state and the time the build has worked: "Paused · 1 h of 8 h". */
const timed = (state: string, time: string | null): string => (time ? `${state} · ${time}` : state);

/**
 * The one line above the graph: the state of the build you play and how long it has worked, then
 * the fact that matters most about it. Failed checks and missing history stay in it; they are not
 * good news to hide.
 */
export function statusLine(graph: RunGraph, summary: RunSummary | null, rows: PartRow[], now = Date.now()): StatusLine {
  if (graph.turn) return turnLine(graph, rows);
  const facts = lineFacts(graph, summary, now);
  const execution = runExecution(graph, summary);
  if (execution === ExecutionStatus.Running) return runningLine(graph, summary, rows, facts);
  if (execution === ExecutionStatus.Paused)
    return {
      tone: Tone.Orange,
      strong: timed("Paused", facts.time),
      rest: facts.hasBuild ? "an earlier build is ready to play · resume from chat" : "resume from chat",
    };
  if (execution === ExecutionStatus.Failed || execution === ExecutionStatus.Cancelled)
    return stoppedLine(execution === ExecutionStatus.Failed, summary, facts);
  if (execution === UNKNOWN_EXECUTION)
    return {
      tone: Tone.Muted,
      strong: timed("Status unavailable", facts.worked),
      rest: "the run's record is incomplete",
    };
  return finishedLine(summary, rows, facts);
}

/** A chat turn's line: its workers at work, then whether your game changed. It has no time of its own. */
function turnLine(graph: RunGraph, rows: PartRow[]): StatusLine {
  if (graph.active) {
    const workers = rows.filter(isWorkerAtWork).length;
    return { tone: "live", strong: TURN_WORDS.working, rest: workers ? workersOnIt(workers) : "" };
  }
  const result = turnResultStatus(graph);
  return { tone: result.tone, strong: result.word, rest: TURN_WORDS.fromTurn };
}

function runningLine(graph: RunGraph, summary: RunSummary | null, rows: PartRow[], facts: LineFacts): StatusLine {
  const base = graph.nodes.find((node) => node.kind === GraphNodeKind.Base);
  const step = frontier(rows);
  const building = rows.filter((row) => row.steps.some(isLiveStep)).length;
  const working = rows.filter((row) => row.working).length;
  const workers = graph.tree ? rows.filter(isWorkerAtWork).length : 0;
  let rest: string;
  if (base?.kind === GraphNodeKind.Base && !base.done) rest = "building the starting point";
  else rest = runningRest(graph, summary, step, { building, working, workers });
  // A failed start stays in the line beside whatever is building on.
  const startFailed = base?.kind === GraphNodeKind.Base && base.done && base.ok === false;
  if (startFailed)
    rest =
      building || working
        ? `${rest} · the starting point failed`
        : `the starting point failed${base.error ? `: ${base.error}` : ""}`;
  const doing = step?.state === StepState.Judging ? "Checking" : "Building";
  return { tone: "live", strong: timed(doing, facts.time), rest };
}

/** What a running run is on, once its starting point is built. */
function runningRest(
  graph: RunGraph,
  summary: RunSummary | null,
  step: Step | null,
  counts: { building: number; working: number; workers: number },
): string {
  if (step?.state === StepState.Judging)
    return `the reviewers are looking at try ${step.tries.length} of ${lowerFirst(step.name)}`;
  if (counts.workers) return workersOnIt(counts.workers);
  if (counts.building > 1) return `${counts.building} parts working`;
  if (step) return stepRest(graph, step);
  if (counts.working) return `${plural(counts.working, "part")} working`;
  // Nothing of a part in hand is not a pause: the lead has the run, or the new build is being tried.
  return checkingBuild(graph, summary) ? "checking the new build starts" : "the lead is working on the next step";
}

function stepRest(graph: RunGraph, step: Step): string {
  const title = graph.facets.find((facet) => facet.facetId === step.facetId)?.title ?? step.facetId;
  if (step.session) return `working on ${title}`;
  const tryNote = step.tries.length > 1 ? ` · try ${step.tries.length}` : "";
  return `${title}: ${lowerFirst(step.name)}${tryNote}`;
}

function stoppedLine(failed: boolean, summary: RunSummary | null, facts: LineFacts): StatusLine {
  const rest = facts.hasBuild ? "an earlier build is ready to play" : "nothing was made live";
  return {
    tone: failed ? Tone.Red : Tone.Muted,
    strong: timed(failed ? "Build failed" : "Build stopped", facts.worked),
    rest: summary?.reason ? stoppedWords(summary.reason) : rest,
  };
}

/** How many of the checks on the build on offer failed, a side-by-side comparison aside. */
function failedChecks(summary: RunSummary | null): number {
  if (!summary) return 0;
  const current = summary.evidence.filter((row) => row.head === summary.head);
  return current.filter((row) => row.status === "failed" && row.category !== "comparison").length;
}

/** A save point the lead made itself: a step it kept with no judge. */
const isSavePoint = (step: Step): boolean => step.tries.some((node) => savedByLead(node.verdictSource));

/**
 * A lead's run in its own terms: how many save points it made, then each worker that didn't
 * deliver, by its title as written (counted past two). A delivery the lead didn't use is on its
 * node, not here.
 */
function leadLandedWords(rows: PartRow[]): string {
  const steps = rows.flatMap((row) => row.steps);
  const saves = plural(steps.filter(isSavePoint).length, "save point");
  const failed = rows.filter((row) => row.steps.some((step) => step.state === StepState.NotDelivered));
  if (!failed.length) return saves;
  const named = failed.length <= MAX_NAMED_MISSING;
  const lost = named
    ? failed.map((row) => `${row.facet.title} didn't deliver`)
    : [`${plural(failed.length, "worker")} didn't deliver`];
  return [saves, ...lost].join(" · ");
}

/** Which of the run's steps reached the build, named when only one or two did not; a lead's run in its own terms. */
function landedWords(rows: PartRow[]): string {
  const steps = rows.flatMap((row) => row.steps).filter((step) => step.state !== StepState.Waiting);
  if (!steps.length) return "";
  if (steps.some(isSavePoint)) return leadLandedWords(rows);
  const missing = steps.filter((step) => step.state !== StepState.InBuild).map((step) => lowerFirst(step.name));
  if (!missing.length) return steps.length === 1 ? "it landed" : "every step landed";
  if (missing.length <= MAX_NAMED_MISSING) return `all but ${listWords(missing)} landed`;
  return `${steps.length - missing.length} of ${steps.length} steps landed`;
}

function finishedLine(summary: RunSummary | null, rows: PartRow[], facts: LineFacts): StatusLine {
  const failed = failedChecks(summary);
  const failedWords = failed ? `${plural(failed, "check")} failed` : "";
  if (summary?.landed === true) {
    const newer = summary.deliveredSourceHead !== null && summary.deliveredSourceHead !== summary.head;
    const clean = !failed && !newer;
    const rest = [failedWords, newer ? "a newer build wasn't made live" : "", clean ? landedWords(rows) : ""]
      .filter(Boolean)
      .join(" · ");
    return {
      tone: clean ? Tone.Green : Tone.Orange,
      strong: timed("Live in your game", facts.worked),
      rest: rest || "finished",
    };
  }
  if (facts.hasBuild)
    return {
      tone: Tone.Orange,
      strong: timed("Not live yet", facts.worked),
      rest: [failedWords, "the build is ready to play"].filter(Boolean).join(" · "),
    };
  return {
    tone: Tone.Muted,
    strong: timed("No new build", facts.worked),
    rest: summary?.reason ? stoppedWords(summary.reason) : "nothing was merged",
  };
}

// ── layout ────────────────────────────────────────────────────────────────────────────────

/**
 * Fixed frame sizes, in canvas pixels. Every picture node is one size — its picture fills it and
 * its words sit on the picture — so no state, try count or zoom level changes a node's height.
 */
export const STEPS = {
  pad: 24,
  startW: 208,
  startH: 130,
  assetsW: 208,
  assetsH: 96,
  assetsGap: 32,
  busGap: 18,
  nodeW: 208,
  nodeH: 130,
  pitch: 244,
  labelH: 26,
  rowGap: 36,
  hangGap: 36,
  resultW: 208,
  resultH: 130,
  resultGap: 18,
  leadGap: 64,
  corner: 10,
} as const;

/** How far the start's line runs when there is no row to feed. */
const EMPTY_BUS_REACH = 40;
/** How far a row's label stops short of the result's bus. */
const LABEL_INSET = 8;
/** The link between the optimisation card and the result. */
const OPTIMIZATION_LINK = 24;

/** How an edge is drawn: merged, merging later, never merged, or in hand now. */
export const StepEdgeKind = { Solid: "solid", Pending: "pending", Dotted: "dotted", Live: "live" } as const;
export type StepEdgeKind = (typeof StepEdgeKind)[keyof typeof StepEdgeKind];

export interface EdgeLine {
  id: string;
  d: string;
  kind: StepEdgeKind;
}

export interface GatePoint {
  /** the node the gate opens: a step id, or `final` */
  target: string;
  gate: Gate;
  x: number;
  y: number;
}

export interface StepsLayout {
  /**
   * `start`, `assets`, `optimization`, `final`, `lead`, every step id, `row:<facetId>` for a label,
   * and in a tree `jobs` and `finish_check`
   */
  rects: Record<string, Rect>;
  edges: EdgeLine[];
  gates: GatePoint[];
  /** steps drawn off the line or on a line that never reaches the build */
  ghosts: Set<string>;
  width: number;
  height: number;
}

type LayoutDraft = Pick<StepsLayout, "rects" | "edges" | "gates" | "ghosts">;

/** A tree's extra nodes: the lead's background work under it, and the finish check after the result. */
export interface TreeOptions {
  jobs: boolean;
  finishCheck: boolean;
}

/** What the layout draws besides the rows. */
export interface LayoutOptions {
  assets?: boolean;
  optimization?: boolean;
  resultGate?: Gate | null;
  /** the lead has the run to itself: drawn after the result, or in a tree, on a live line into it */
  lead?: boolean;
  /** a tree: the lead stands between what you asked and the rows */
  tree?: TreeOptions;
}

/** Where the rows' bus is fed from (the start's right edge, or the lead's in a tree), runs, and the rows begin. */
interface BusOrigin {
  from: number;
  busX: number;
  rowX: number;
}

/** The lead of a tree stands right of the start by the lead's gap. */
const treeLeadX = (): number => STEPS.pad + STEPS.startW + STEPS.leadGap;

function busOrigin(tree: boolean): BusOrigin {
  const from = tree ? treeLeadX() + STEPS.nodeW : STEPS.pad + STEPS.startW;
  return { from, busX: from + STEPS.busGap, rowX: from + 2 * STEPS.busGap };
}

/**
 * A row as the layout sees it: nothing on its line (a ghost row), or something hanging below; and
 * the height of its label, which a part built in one session does not have.
 */
interface RowShape {
  row: PartRow;
  ghostRow: boolean;
  label: number;
  hangs: boolean;
}

/** A drawn row: where its line runs, and the last node on it that reaches the build. */
interface DrawnRow {
  row: PartRow;
  cy: number;
  last: Rect | null;
}

/** Where the next node of a row goes: its column on the line, the node it follows, the next free hang. */
interface RowCursor {
  origin: BusOrigin;
  col: number;
  previous: Rect | null;
  anchor: Rect | null;
  hangX: number;
}

const rowShape = (row: PartRow): RowShape => {
  const ghostRow = !row.steps.some((step) => step.onLine);
  const label = row.steps.some((step) => !step.session) ? STEPS.labelH : 0;
  return { row, ghostRow, label, hangs: !ghostRow && row.steps.some((step) => !step.onLine) };
};

/**
 * Start (and the assets under it) → a bus into every row → the steps on each line, the rest
 * hanging below them → a bus out to the result → the lead, while it has the run. Rows never
 * overlap by construction: a row that has something hanging is taller by that lane. A part built
 * in one session is its one node, so its row has no label over it. A tree puts the lead between
 * the start and the rows (its background work under it) and ends in the finish check.
 */
export function layoutSteps(rows: PartRow[], options: LayoutOptions = {}): StepsLayout {
  const S = STEPS;
  const draft: LayoutDraft = { rects: {}, edges: [], gates: [], ghosts: new Set<string>() };
  const origin = busOrigin(options.tree !== undefined);
  const shapes = rows.map(rowShape);
  // A row is taller by one lane when something hangs below its line; the start and the result
  // sit on the middle of the rows, and the rows move down when the start would not fit above.
  const heights = shapes.map(({ label, hangs }) => label + S.nodeH + (hangs ? S.hangGap + S.nodeH : 0));
  const lines = rowLines(shapes, heights);
  const rowsMid = lines.length ? ((lines[0] ?? 0) + (lines.at(-1) ?? 0)) / 2 : S.startH / 2;
  const top = S.pad + Math.max(0, S.startH / 2 - rowsMid);
  const midY = top + rowsMid;

  const drawn: DrawnRow[] = [];
  let y = top;
  let right = origin.rowX;
  shapes.forEach((shape, index) => {
    drawn.push(placeRow(draft, shape, y, origin));
    for (const step of shape.row.steps) right = Math.max(right, (draft.rects[step.id]?.x ?? origin.rowX) + S.nodeW);
    y += (heights[index] ?? 0) + S.rowGap;
  });

  placeStart(draft, midY, options.assets === true);
  if (options.tree) placeTreeLead(draft, midY, options.tree.jobs, options.lead === true);
  const rightBus = drawn.length ? right + S.resultGap : origin.from + EMPTY_BUS_REACH;
  // A row's label may use the row's whole width, never the result's.
  for (const { row } of drawn) {
    const label = draft.rects[`row:${row.facet.facetId}`];
    if (label) label.w = Math.max(S.nodeW, rightBus - origin.rowX - LABEL_INSET);
  }
  const into = rightBus + S.resultGap;
  const final = placeResult(draft, into, midY, options.optimization === true);
  placeEnd(draft, final, midY, options);
  draft.edges.unshift(...busIn(drawn, midY, into, origin));
  draft.edges.push(...busOut(drawn, rightBus, midY, into));
  if (options.resultGate) draft.gates.push({ target: "final", gate: options.resultGate, x: final.x, y: midY });

  const bounds = boundsOf(Object.values(draft.rects)) ?? { x: 0, y: 0, w: 0, h: 0 };
  return { ...draft, width: bounds.x + bounds.w + S.pad, height: bounds.y + bounds.h + S.pad };
}

/** Where each row's line runs, from the top of the first row. */
function rowLines(shapes: RowShape[], heights: number[]): number[] {
  const lines: number[] = [];
  let top = 0;
  shapes.forEach((shape, index) => {
    lines.push(top + shape.label + STEPS.nodeH / 2);
    top += (heights[index] ?? 0) + STEPS.rowGap;
  });
  return lines;
}

/** One row: its label (none for a part built in one session), the steps on its line, the rest below. */
function placeRow(draft: LayoutDraft, { row, ghostRow, label }: RowShape, y: number, origin: BusOrigin): DrawnRow {
  const S = STEPS;
  const nodeY = y + label;
  const cy = nodeY + S.nodeH / 2;
  if (label) draft.rects[`row:${row.facet.facetId}`] = { x: origin.rowX, y, w: S.nodeW, h: S.labelH };
  const cursor: RowCursor = { origin, col: 0, previous: null, anchor: null, hangX: -Infinity };
  for (const step of row.steps) {
    if (ghostRow || step.onLine) placeOnLine(draft, cursor, step, { nodeY, cy, ghostRow });
    else placeHanging(draft, cursor, step, { hangY: nodeY + S.nodeH + S.hangGap, cy });
  }
  return { row, cy, last: ghostRow ? null : cursor.anchor };
}

/** A line edge into a step: merged, in hand, or never reaching the build. */
function lineKind(step: Step): StepEdgeKind {
  if (step.onLine) return StepEdgeKind.Solid;
  return isLiveStep(step) ? StepEdgeKind.Live : StepEdgeKind.Dotted;
}

function placeOnLine(
  draft: LayoutDraft,
  cursor: RowCursor,
  step: Step,
  at: { nodeY: number; cy: number; ghostRow: boolean },
): void {
  const S = STEPS;
  const rect = { x: cursor.origin.rowX + cursor.col * S.pitch, y: at.nodeY, w: S.nodeW, h: S.nodeH };
  cursor.col += 1;
  draft.rects[step.id] = rect;
  if (at.ghostRow && !isLiveStep(step)) draft.ghosts.add(step.id);
  const { previous } = cursor;
  if (previous)
    draft.edges.push({
      id: `line:${step.id}`,
      d: `M${previous.x + previous.w} ${at.cy} H${rect.x}`,
      kind: lineKind(step),
    });
  if (step.gate) draft.gates.push({ target: step.id, gate: step.gate, x: rect.x, y: at.cy });
  cursor.previous = rect;
  if (step.onLine) cursor.anchor = rect;
}

/** Off the line: under the node it would have followed, never on top of another hang. */
function placeHanging(draft: LayoutDraft, cursor: RowCursor, step: Step, at: { hangY: number; cy: number }): void {
  const S = STEPS;
  const r = S.corner;
  const { anchor } = cursor;
  const x = Math.max(anchor ? anchor.x : cursor.origin.rowX, cursor.hangX);
  cursor.hangX = x + S.pitch;
  draft.rects[step.id] = { x, y: at.hangY, w: S.nodeW, h: S.nodeH };
  if (!isLiveStep(step)) draft.ghosts.add(step.id);
  const fromX = anchor ? anchor.x + anchor.w / 2 : cursor.origin.busX;
  const fromY = anchor ? anchor.y + anchor.h : at.cy;
  const toX = x + S.nodeW / 2;
  const mid = at.hangY - S.hangGap / 2;
  const d =
    fromX === toX
      ? `M${fromX} ${fromY} V${at.hangY}`
      : `M${fromX} ${fromY} V${mid - r} Q${fromX} ${mid} ${fromX + r} ${mid} H${toX - r} Q${toX} ${mid} ${toX} ${mid + r} V${at.hangY}`;
  draft.edges.push({ id: `hang:${step.id}`, d, kind: isLiveStep(step) ? StepEdgeKind.Live : StepEdgeKind.Dotted });
  if (step.gate) draft.gates.push({ target: step.id, gate: step.gate, x: toX, y: at.hangY });
}

/** The start on the middle of the rows, and the assets card under it with its dotted link. */
function placeStart(draft: LayoutDraft, midY: number, assets: boolean): void {
  const S = STEPS;
  draft.rects.start = { x: S.pad, y: midY - S.startH / 2, w: S.startW, h: S.startH };
  if (!assets) return;
  const assetsTop = midY + S.startH / 2 + S.assetsGap;
  draft.rects.assets = { x: S.pad, y: assetsTop, w: S.assetsW, h: S.assetsH };
  draft.edges.push({
    id: "assets",
    d: `M${S.pad + S.startW / 2} ${midY + S.startH / 2} V${assetsTop}`,
    kind: StepEdgeKind.Dotted,
  });
}

/** The result, with the optimisation card before it when there is one; returns the result's rect. */
function placeResult(draft: LayoutDraft, into: number, midY: number, optimization: boolean): Rect {
  const S = STEPS;
  const y = midY - S.resultH / 2;
  if (!optimization) {
    draft.rects.final = { x: into, y, w: S.resultW, h: S.resultH };
    return draft.rects.final;
  }
  draft.rects.optimization = { x: into, y, w: S.resultW, h: S.resultH };
  draft.edges.push({
    id: "optimization",
    d: `M${into + S.resultW} ${midY} H${into + S.resultW + OPTIMIZATION_LINK}`,
    kind: StepEdgeKind.Solid,
  });
  draft.rects.final = { x: into + S.resultW + OPTIMIZATION_LINK, y, w: S.resultW, h: S.resultH };
  return draft.rects.final;
}

/** After the result: a tree's finish check, else the lead while it has the run. */
function placeEnd(draft: LayoutDraft, final: Rect, midY: number, options: LayoutOptions): void {
  if (!options.tree) {
    if (options.lead) placeLead(draft, final, midY);
    return;
  }
  if (options.tree.finishCheck) placeFinishCheck(draft, final, midY);
}

/**
 * A tree's lead, right of the start on the middle line: a live line into it while it works alone.
 * Its background work hangs under it on a dotted line, as the assets hang under the start.
 */
function placeTreeLead(draft: LayoutDraft, midY: number, jobs: boolean, alone: boolean): void {
  const S = STEPS;
  const startRight = S.pad + S.startW;
  const x = treeLeadX();
  const lead = { x, y: midY - S.nodeH / 2, w: S.nodeW, h: S.nodeH };
  draft.rects.lead = lead;
  draft.edges.push({
    id: "lead",
    d: `M${startRight} ${midY} H${x}`,
    kind: alone ? StepEdgeKind.Live : StepEdgeKind.Solid,
  });
  if (!jobs) return;
  const top = lead.y + lead.h + S.assetsGap;
  draft.rects.jobs = { x, y: top, w: S.assetsW, h: S.assetsH };
  draft.edges.push({ id: "jobs", d: `M${x + S.nodeW / 2} ${lead.y + lead.h} V${top}`, kind: StepEdgeKind.Dotted });
}

/** The finish check, the last node of a run's tree: after the result on a dotted line. */
function placeFinishCheck(draft: LayoutDraft, final: Rect, midY: number): void {
  const S = STEPS;
  const from = final.x + final.w;
  draft.rects[GraphNodeKind.FinishCheck] = { x: from + S.leadGap, y: midY - S.resultH / 2, w: S.resultW, h: S.resultH };
  draft.edges.push({
    id: GraphNodeKind.FinishCheck,
    d: `M${from} ${midY} H${from + S.leadGap}`,
    kind: StepEdgeKind.Dotted,
  });
}

/** The lead, after the result while it has the run, on a live line from it. */
function placeLead(draft: LayoutDraft, final: Rect, midY: number): void {
  const S = STEPS;
  const from = final.x + final.w;
  draft.rects.lead = { x: from + S.leadGap, y: midY - S.nodeH / 2, w: S.nodeW, h: S.nodeH };
  draft.edges.push({ id: "lead", d: `M${from} ${midY} H${from + S.leadGap}`, kind: StepEdgeKind.Live });
}

/** A row's entry from the bus: solid when something of it reached the line, else live or dotted. */
function rowEntryKind(row: PartRow): StepEdgeKind {
  if (row.steps.some((step) => step.onLine)) return StepEdgeKind.Solid;
  return row.steps.some(isLiveStep) ? StepEdgeKind.Live : StepEdgeKind.Dotted;
}

/**
 * From the start (the lead, in a tree) into the bus and every row — or straight to the result
 * when there are no rows.
 */
function busIn(drawn: DrawnRow[], midY: number, into: number, origin: BusOrigin): EdgeLine[] {
  const { from, busX, rowX } = origin;
  if (!drawn.length) return [{ id: "direct", d: `M${from} ${midY} H${into}`, kind: StepEdgeKind.Solid }];
  return [
    { id: "start", d: `M${from} ${midY} H${busX}`, kind: StepEdgeKind.Solid },
    ...drawn.map(({ row, cy }) => ({
      id: `in:${row.facet.facetId}`,
      d: bend(busX, midY, cy, rowX, STEPS.corner),
      kind: rowEntryKind(row),
    })),
  ];
}

/** From each row's last node on the line to the result; where lines share the bus the merged one shows. */
function busOut(drawn: DrawnRow[], rightBus: number, midY: number, into: number): EdgeLine[] {
  const exits: EdgeLine[] = [];
  for (const { row, cy, last } of drawn) {
    if (!last) continue;
    exits.push({
      id: `out:${row.facet.facetId}`,
      d: `M${last.x + last.w} ${cy} ${join(rightBus, cy, midY, into, STEPS.corner)}`,
      kind: row.integrated || row.steps.some(isFinishedWorker) ? StepEdgeKind.Solid : StepEdgeKind.Pending,
    });
  }
  // The merged one is drawn last.
  return exits.sort((a, b) => Number(a.kind === StepEdgeKind.Solid) - Number(b.kind === StepEdgeKind.Solid));
}

/** From the bus at `fromY` up or down to a row at `toY`, then right into its first node. */
function bend(x: number, fromY: number, toY: number, toX: number, r: number): string {
  if (fromY === toY) return `M${x} ${fromY} H${toX}`;
  const dir = toY > fromY ? 1 : -1;
  return `M${x} ${fromY} V${toY - dir * r} Q${x} ${toY} ${x + r} ${toY} H${toX}`;
}

/** Along a row's line to the right bus at `x`, down or up to `midY`, then right into the result. */
function join(x: number, fromY: number, midY: number, toX: number, r: number): string {
  if (fromY === midY) return `H${toX}`;
  const dir = midY > fromY ? 1 : -1;
  return `H${x - r} Q${x} ${fromY} ${x} ${fromY + dir * r} V${midY - dir * r} Q${x} ${midY} ${x + r} ${midY} H${toX}`;
}

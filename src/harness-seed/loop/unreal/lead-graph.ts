/**
 * The lead's run as the Builds graph reads it, in the director's shape: the lead's part and one
 * column per milestone ("Lead · <title>"), a kept round (`facet_iteration`, verdict source `lead`)
 * and an `integration_merge` for every save point, a part per typed worker (`agent-<id>`) with its
 * state and, through its attribution, its asset cards, a merge into the next save point for each
 * delivery the lead used, and the critic's advice on the round it reviewed. Each typed worker also
 * leaves the worker records every lead's workers leave (`worker_started`, `worker_finished`, and
 * the lead's verdict), under its part's id. Every record is a courtesy to the log: a write that
 * fails never costs the run.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import { Side } from "../judge.ts";
import { WorkerMode, WorkerState } from "../outcomes.ts";
import { appendRun, RunEvent } from "../run-events.ts";
import { WorkerEnd, WorkerIsolation, type WorkerStopCode } from "../workers/contract.ts";
import { recordWorkerFinished, recordWorkerStarted, type WorkerEventScope } from "../workers/events.ts";
import { agentTitle } from "./agent-prompts.ts";
import {
  AGENT_PART_PREFIX,
  type AgentRecord,
  AgentState,
  AgentVerdict,
  type CriticAdvice,
  type CriticAdvicePayload,
  LEAD_PART,
  LEAD_VERDICT_SOURCE,
  type LeadJournal,
  type LeadMergePayload,
  type LeadMilestone,
  type LeadPart,
  type LeadStartedPayload,
  type LeadWorkerPayload,
  MAX_RUNNING_AGENTS,
  MergeStage,
  type SavePoint,
  type SavePointRoundPayload,
} from "./lead-contract.ts";
import type { Lead } from "./lead-journal.ts";

/** A used delivery's merge names the one round its part has: the delivery itself. */
const DELIVERY_ROUND = 1;

/** The graph's words: the lead's column titles, why a part stopped, and the close's sentence. */
const WORDS = {
  Lead: "Lead",
  Milestone: (title: string) => `Lead · ${title}`,
  Rejected: (note: string | null) => (note ? `the lead set it aside: ${note}` : "the lead set it aside"),
  Saves: (count: number, label: string, summary: string) =>
    count === 1 ? `One save point: ${label} (${summary}).` : `${count} save points; the last, ${label}: ${summary}.`,
  NoSaves: "No save point was made, so the game is as the run found it.",
  Agents: (delivered: number, used: number, failed: number) =>
    [
      `${delivered} ${delivered === 1 ? "worker" : "workers"} delivered`,
      used ? `, ${used} used in the game` : "",
      failed ? `; ${failed} didn't deliver` : "",
      ".",
    ].join(""),
} as const;

/** The worker state each typed worker state shows as on its part. */
const AGENT_WORKER_STATE = {
  [AgentState.Running]: WorkerState.Running,
  [AgentState.Done]: WorkerState.Done,
  [AgentState.Failed]: WorkerState.Failed,
  [AgentState.Stopped]: WorkerState.Stopped,
} as const satisfies Record<AgentState, WorkerState>;

/** How a typed worker's end is recorded, by the state it ended in. */
const AGENT_END = {
  [AgentState.Done]: WorkerEnd.Done,
  [AgentState.Failed]: WorkerEnd.Failed,
  [AgentState.Stopped]: WorkerEnd.Stopped,
} as const satisfies Record<Exclude<AgentState, typeof AgentState.Running>, WorkerEnd>;

/** Appends one record of the run to its thread. */
function append(lead: Lead, eventType: string, payload: object): Promise<unknown> {
  return appendRun(lead.ctx, lead.threadId, eventType, payload, { runId: lead.run.runId });
}

/** A milestone's part on the graph: the lead's own before it named one, else its own column beside the lead's. */
export function milestonePart(milestoneId: string): string {
  return milestoneId === LEAD_PART ? LEAD_PART : `${LEAD_PART}-${milestoneId}`;
}

/** A milestone's column as the graph titles it. */
function columnOf(milestone: Pick<LeadMilestone, "id" | "title">): LeadPart {
  const title = milestone.id === LEAD_PART ? WORDS.Lead : WORDS.Milestone(milestone.title);
  return { id: milestonePart(milestone.id), title };
}

/**
 * The lead's columns: its own when it saved before it named a milestone, then every milestone's.
 * The lead's own column is never drawn empty: until it has a column at work, the graph's lead node
 * stands for it.
 */
function leadParts(journal: LeadJournal): LeadPart[] {
  const savedAsLead = journal.savePoints.some((point) => point.milestoneId === LEAD_PART);
  const own = savedAsLead ? [columnOf({ id: LEAD_PART, title: WORDS.Lead })] : [];
  return [...own, ...journal.milestones.map(columnOf)];
}

/** The column each lead in this process works in now, as its last worker record said. */
const atWork = new WeakMap<Lead, LeadPart>();

/** A column's worker record: at work, or done. */
async function column(lead: Lead, part: LeadPart, state: WorkerState): Promise<void> {
  if (state === WorkerState.Running) atWork.set(lead, part);
  const payload: LeadWorkerPayload = { workerId: part.id, title: part.title, mode: WorkerMode.Single, state };
  await append(lead, RunEvent.DirectorWorker, payload);
}

/** The milestone column the lead works in now, or null before it named one. */
function currentColumn(journal: LeadJournal): LeadPart | null {
  const last = journal.milestones.at(-1);
  return last ? columnOf(last) : null;
}

/** One plain line for the user on the run's feed, as a lead's decision card (the chat shows `plain`). */
export async function tellUser(lead: Lead, line: string, plain = line): Promise<void> {
  const at = new Date(lead.clock.now()).toISOString();
  await append(lead, RunEvent.AutopilotDecision, { decision: line, text: line, plain, at });
}

/**
 * The run's start on the graph (`autopilot_started`): a director's run whose parts are the lead's
 * columns (none yet on a new run), with the milestone it works in at work on a resume.
 */
export async function leadStarted(lead: Lead): Promise<void> {
  const payload: LeadStartedPayload = {
    project: lead.run.project,
    director: true,
    maxParallel: 1 + MAX_RUNNING_AGENTS,
    facets: leadParts(lead.journal),
  };
  await append(lead, RunEvent.AutopilotStarted, payload);
  const current = currentColumn(lead.journal);
  if (current) await column(lead, current, WorkerState.Running);
}

/**
 * The column at work before the milestone just named (the journal's milestones end with it): this
 * process's own record, else, on a resume, the milestone the journal had last before it.
 */
function columnBefore(lead: Lead): LeadPart | undefined {
  const previous = lead.journal.milestones.at(-2);
  return atWork.get(lead) ?? (previous ? columnOf(previous) : undefined);
}

/** A milestone the lead named: the column it leaves is done, and this one's at work. */
export async function milestoneColumn(lead: Lead, milestone: LeadMilestone): Promise<void> {
  const here = columnOf(milestone);
  const before = columnBefore(lead);
  if (before && before.id !== here.id) await column(lead, before, WorkerState.Done);
  await column(lead, here, WorkerState.Running);
}

/** A save point as a kept round of its milestone, with its merge into the game and the used deliveries merged into it. */
export async function savePointRound(lead: Lead, point: SavePoint): Promise<void> {
  const milestone = lead.journal.milestones.find((m) => m.id === point.milestoneId);
  const part = columnOf(milestone ?? { id: point.milestoneId, title: point.milestoneId });
  const round: SavePointRoundPayload = {
    facetId: part.id,
    facetTitle: part.title,
    iteration: point.round,
    winner: Side.Challenger,
    verdictSource: LEAD_VERDICT_SOURCE,
    reason: point.summary,
    satisfied: false,
    summary: point.summary,
    label: point.label,
    snapshot: point.snapshotId,
    shots: point.thumbnails,
    logErrors: point.logErrors ?? [],
    auto: point.auto,
  };
  // The save's label names its node; the summary is what it asked of the game.
  const move = { what: `${point.label}: ${point.summary}`, milestoneId: point.milestoneId, delivered: true };
  await append(lead, RunEvent.FacetIteration, { ...round, move });
  await merge(lead, part.id, point.round, point.snapshotId);
  for (const agent of lead.journal.agents) {
    if (agent.mark?.verdict !== AgentVerdict.Used || agent.mergedInto) continue;
    agent.mergedInto = point.label;
    await merge(lead, agentPart(agent.id), DELIVERY_ROUND, point.snapshotId);
    // Its line in the chat says what its row says: the work is in the game now.
    const added = { workerId: agentPart(agent.id), title: agentTitle(agent.kind, agent.title), merged: true };
    await recordWorkerFinished(workerScope(lead), added, lead.clock.now());
  }
}

/** A part's work in the game: the game folder is the live game, so the merge names its snapshot and no build of its own. */
async function merge(lead: Lead, facetId: string, round: number, snapshot: string): Promise<void> {
  const payload: LeadMergePayload = {
    project: lead.run.project,
    facetId,
    round,
    iteration: round,
    snapshot,
    conflict: false,
    stage: MergeStage.Editor,
  };
  await append(lead, RunEvent.IntegrationMerge, payload);
}

/** A typed worker's part on the graph: the prefix and its id. */
export const agentPart = (id: string): string => `${AGENT_PART_PREFIX}${id}`;

/** Where a typed worker's records go: the run's chat, stamped with the run. */
function workerScope(lead: Lead): WorkerEventScope {
  return { ctx: lead.ctx, threadId: lead.threadId, project: lead.run.project, runId: lead.run.runId };
}

/**
 * A typed worker's start, or its end, as every lead's worker records it: in its own copy, by its
 * kind; an end that stopped short says why in the app's code (`stoppedBecause` is for the lead).
 */
function agentRecord(lead: Lead, agent: AgentRecord, title: string, stopCode: WorkerStopCode | null): Promise<void> {
  const workerId = agentPart(agent.id);
  const at = lead.clock.now();
  if (agent.state === AgentState.Running) {
    const started = { workerId, title, isolation: WorkerIsolation.Copy, task: agent.brief, type: agent.kind };
    return recordWorkerStarted(workerScope(lead), started, at);
  }
  const delivered = agent.state === AgentState.Done;
  const ended = { workerId, title, state: AGENT_END[agent.state], stoppedBecause: agent.error, stopCode, delivered };
  return recordWorkerFinished(workerScope(lead), ended, at);
}

/** A typed worker's part: at work, done, failed or stopped, with why (and, on its end record, why's code). */
export async function agentNode(lead: Lead, agent: AgentRecord, stopCode: WorkerStopCode | null = null): Promise<void> {
  const title = agentTitle(agent.kind, agent.title);
  const payload: LeadWorkerPayload = {
    workerId: agentPart(agent.id),
    title,
    mode: WorkerMode.Single,
    state: AGENT_WORKER_STATE[agent.state],
    ...(agent.state === AgentState.Done ? { delivered: true as const } : {}),
    ...(agent.error ? { stoppedBecause: agent.error } : {}),
  };
  await append(lead, RunEvent.DirectorWorker, payload);
  await agentRecord(lead, agent, title, stopCode);
}

/**
 * The lead's mark on a typed worker: its verdict, recorded as every lead's worker verdict is; and on
 * its part, a rejected delivery stops there, with the lead's note (a used one stays done until the
 * next save point merges it).
 */
export async function agentMarked(lead: Lead, agent: AgentRecord): Promise<void> {
  const mark = agent.mark;
  if (!mark) return;
  const title = agentTitle(agent.kind, agent.title);
  const verdict = { workerId: agentPart(agent.id), title, verdict: mark.verdict, note: mark.note };
  await recordWorkerFinished(workerScope(lead), verdict, lead.clock.now());
  if (mark.verdict !== AgentVerdict.Rejected) return;
  const payload: LeadWorkerPayload = {
    workerId: agentPart(agent.id),
    title,
    mode: WorkerMode.Single,
    state: WorkerState.Stopped,
    stoppedBecause: WORDS.Rejected(mark.note),
  };
  await append(lead, RunEvent.DirectorWorker, payload);
}

/**
 * The critic's advice on the round it reviewed, shown as advice, never as a verdict: it carries no
 * `because`, `decision` or `pass`, so nothing that reads verdicts takes it for one.
 */
export async function criticAdvice(lead: Lead, advice: CriticAdvice): Promise<void> {
  const payload: CriticAdvicePayload = {
    advice: true,
    facetId: milestonePart(advice.milestoneId),
    iteration: advice.round,
    at: new Date(advice.at).toISOString(),
    defects: advice.defects,
    boldMove: advice.boldMove,
    gates: advice.gates,
    shots: advice.shots,
  };
  await append(lead, RunEvent.DirectorVerdict, payload);
}

/** Each part's last word at the close: the lead's columns with their rounds, each typed worker with how it ended. */
function closeFacets(journal: LeadJournal): Record<string, AnyRecord> {
  const facets: Record<string, AnyRecord> = {};
  for (const part of leadParts(journal)) {
    const iterations = journal.savePoints.filter((point) => milestonePart(point.milestoneId) === part.id).length;
    facets[part.id] = { stoppedBecause: null, iterations, satisfied: null };
  }
  for (const agent of journal.agents) {
    const rejected = agent.mark?.verdict === AgentVerdict.Rejected;
    const stoppedBecause = rejected ? WORDS.Rejected(agent.mark?.note ?? null) : agent.error;
    facets[agentPart(agent.id)] = { stoppedBecause, iterations: 0, satisfied: agent.state === AgentState.Done };
  }
  return facets;
}

/** How the run's typed workers ended, as the close counts them: delivered, used in the game, and not delivered. */
export type AgentCounts = { delivered: number; used: number; failed: number };

/**
 * The close's sentence from its facts: how many save points there were and the last one, and how
 * the typed workers ended (none without any).
 */
export function leadCloseSentence(
  saves: number,
  last: { label: string; summary: string } | undefined,
  agents: AgentCounts | undefined,
): string {
  const lines = [last ? WORDS.Saves(saves, last.label, last.summary) : WORDS.NoSaves];
  if (agents) lines.push(WORDS.Agents(agents.delivered, agents.used, agents.failed));
  return lines.join(" ");
}

/** The close's sentence: the save points, the last one's summary, and what the typed workers delivered. */
function closeSentence(journal: LeadJournal): string {
  const { savePoints, agents } = journal;
  const delivered = agents.filter((a) => a.state === AgentState.Done).length;
  const used = agents.filter((a) => a.mark?.verdict === AgentVerdict.Used).length;
  const counts = agents.length ? { delivered, used, failed: agents.length - delivered } : undefined;
  return leadCloseSentence(savePoints.length, savePoints.at(-1), counts);
}

/**
 * The close as the Builds graph and the run's summary read it, in the director's shape: the run
 * landed when it made a save point (the game folder is the live game), each part's last word, and
 * a sentence naming the save points and the typed workers.
 */
export function leadCloseOf(journal: LeadJournal): AnyRecord {
  return {
    landed: journal.savePoints.length > 0,
    facets: closeFacets(journal),
    summary: closeSentence(journal),
  };
}

/**
 * The run's close on its thread: the column the lead worked in is done (it stays at work on a
 * pause, which a resume picks up), then `run_finished`, and `autopilot_paused` when a resume
 * picks it up.
 */
export async function leadFinished(lead: Lead, report: AnyRecord, paused: boolean): Promise<void> {
  const current = currentColumn(lead.journal);
  if (current && !paused) await column(lead, current, WorkerState.Done);
  await append(lead, RunEvent.RunFinished, report);
  if (paused) await append(lead, RunEvent.AutopilotPaused, { project: lead.run.project });
}

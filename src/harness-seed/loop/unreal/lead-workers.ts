/**
 * The Unreal lead's six worker tools, Genex's one worker model: `worker_start` with a type the
 * plugins that are on declare runs one of the lead's typed workers (agents.ts: a delivering agent in
 * its own copy), and without one a generic worker from the run's shared pool (`loop/workers/`), so
 * the lead's tool set is everyone's. `worker_status`, `worker_wait`, `worker_steer`, `worker_stop`
 * and `worker_mark` reach a worker by its id, whichever it is, a generic one kept from before a
 * restart included. A journaled call from before the rename (`kind`, `brief`) still replays.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import { modelOn, RoleKey, roleEngine } from "../model-roles.ts";
import { hasText } from "../text.ts";
import { WorkerIsolation, WorkerTool } from "../workers/contract.ts";
import { folderLabelOf, UNREAL_AT_ROOT } from "../workers/identity.ts";
import type { WorkerPool } from "../workers/pool.ts";
import { readRecords, runningRecords, runWorkersArtifact } from "../workers/records.ts";
import { HostMethod } from "../host-methods.ts";
import {
  holdsWorker,
  openRunPool,
  type RunPoolSeat,
  runPool,
  runPoolCall,
  runPoolStatus,
} from "../workers/run-pool.ts";
import { AGENT_WORDS } from "./agent-prompts.ts";
import { agentStatus, askingAgents, creditCapOf, markAgent, startAgent, stopAgent, waitAgent } from "./agents.ts";
import { AgentKind, AgentState } from "./lead-contract.ts";
import { notePoolEnd } from "./pool-news.ts";
import { type Lead, oneGitWrite } from "./lead-journal.ts";

const AGENT_KINDS: readonly string[] = Object.values(AgentKind);

/** Whether a type is one of the lead's typed workers. */
const isAgentKind = (value: unknown): value is AgentKind => AGENT_KINDS.includes(value as string);

/** The type a start asks for: `type`, or a journaled call's `kind`. */
const typeOf = (args: AnyRecord): unknown => (hasText(args.type) ? args.type : args.kind);

/** The task a start hands over: `task`, or a journaled call's `brief`. */
const taskOf = (args: AnyRecord): unknown => (hasText(args.task) ? args.task : args.brief);

/** Whether the id names one of the lead's typed workers. */
const typedWorker = (lead: Lead, id: unknown): boolean => lead.journal.agents.some((agent) => agent.id === id);

/** The run's shared pool as the lead's generic workers use it: the builders' engine, the game folder. */
function seatOf(lead: Lead): RunPoolSeat {
  const { ctx, run, threadId, game } = lead;
  const engine = roleEngine(run, RoleKey.Builder);
  const model = modelOn(run, engine);
  return {
    ctx,
    project: run.project,
    threadId,
    runId: run.runId,
    engine,
    ...(model ? { model } : {}),
    // The run's Genex credit cap holds for its generic workers as for its typed ones.
    ...creditCapOf(lead),
    gameDir: game.dir,
    game,
    leadFolder: { project: run.project },
    identity: { folderLabel: folderLabelOf(game.dir, null), facts: game.facts ?? UNREAL_AT_ROOT },
    clock: lead.clock,
    // The pool's snapshots and merges take the game's one git index, as the lead's landings and save points do.
    gitWrite: (write) => oneGitWrite(lead, write),
    // A generic worker's end is the lead's news, with its typed workers' (`agentNews`).
    onEnded: (record) => notePoolEnd(lead, record),
  };
}

/** `worker_start`: a typed worker of the lead's own, or a generic one from the run's shared pool. */
async function startWorker(lead: Lead, args: AnyRecord): Promise<string> {
  const type = typeOf(args);
  const task = taskOf(args);
  if (isAgentKind(type)) {
    // A typed worker always writes in a copy of its own: a call asking for another isolation is
    // refused rather than run as something it did not ask for.
    if (hasText(args.isolation) && String(args.isolation).trim() !== WorkerIsolation.Copy)
      return AGENT_WORDS.Refused(AGENT_WORDS.TypedIsolation(type));
    return startAgent(lead, { kind: type, title: args.title, brief: task, inputs: args.inputs });
  }
  const pool = await runPool(seatOf(lead));
  return pool.call(WorkerTool.Start, { ...args, task, ...(hasText(type) ? { type } : {}) });
}

/**
 * The run's shared pool, opened from the run's artifact when this harness has not opened it yet
 * (a restart, a resumed run): its kept workers stay reachable by id. Null when the run never
 * started one.
 */
async function keptPool(lead: Lead): Promise<WorkerPool | null> {
  const open = await openRunPool(lead.run.runId);
  if (open) return open;
  const saved = await lead.ctx
    .call(HostMethod.ArtifactRead, { threadId: lead.threadId, artifactId: runWorkersArtifact(lead.run.runId) })
    .catch(() => null);
  return readRecords(saved).length ? runPool(seatOf(lead)).catch(() => null) : null;
}

/** `worker_status`: one worker, or every worker, typed ones first. */
async function statusOf(lead: Lead, args: AnyRecord): Promise<string> {
  if (hasText(args.id) && typedWorker(lead, args.id)) return agentStatus(lead, args.id, await askingAgents(lead));
  await keptPool(lead);
  if (hasText(args.id))
    return (await runPoolCall(lead.run.runId, WorkerTool.Status, args)) ?? AGENT_WORDS.Unknown(args.id);
  const pooled = await runPoolStatus(lead.run.runId, (pool) => pool.call(WorkerTool.Status, {}));
  const typed = agentStatus(lead, undefined, await askingAgents(lead));
  if (!pooled) return typed;
  return lead.journal.agents.length ? `${typed}\n\n${pooled}` : pooled;
}

/** `worker_wait`: for one worker, or the first of all of them to end; answers where they stand. */
async function waitFor(lead: Lead, args: AnyRecord): Promise<string> {
  const id = args.id ?? args.worker;
  if (hasText(id) && typedWorker(lead, id)) return waitAgent(lead, { ...args, id });
  const pool = await keptPool(lead);
  if (hasText(id))
    return (await runPoolCall(lead.run.runId, WorkerTool.Wait, { ...args, id })) ?? AGENT_WORDS.Unknown(id);
  const typedRunning = lead.journal.agents.some((agent) => agent.state === AgentState.Running);
  const pooledRunning = pool !== null && runningRecords(pool.state).length > 0;
  // The typed workers' wait is ended once either answers: it must not mark questions this answer never shows.
  const answered = new AbortController();
  const waits = [
    ...(typedRunning ? [waitAgent(lead, { seconds: args.seconds }, answered.signal)] : []),
    ...(pool && pooledRunning ? [pool.call(WorkerTool.Wait, { seconds: args.seconds })] : []),
  ];
  if (waits.length) await Promise.race(waits);
  answered.abort();
  return statusOf(lead, {});
}

/** A call naming one worker: the typed worker's answer, or the shared pool's, or that there is none. */
async function oneWorker(
  lead: Lead,
  name: WorkerTool,
  args: AnyRecord,
  typed: (id: string) => Promise<string> | string,
): Promise<string> {
  const id = String(args.id ?? args.worker ?? "");
  if (typedWorker(lead, id)) return typed(id);
  await keptPool(lead);
  if (await holdsWorker(lead.run.runId, id)) return (await runPoolCall(lead.run.runId, name, { ...args, id })) ?? "";
  return AGENT_WORDS.Unknown(id);
}

/** The lead's six worker tools, by the names its engine sends. */
export function workerTools(lead: Lead): Record<WorkerTool, (args: AnyRecord) => Promise<string>> {
  return {
    [WorkerTool.Start]: (args) => startWorker(lead, args),
    [WorkerTool.Status]: (args) => statusOf(lead, args),
    [WorkerTool.Wait]: (args) => waitFor(lead, args),
    [WorkerTool.Steer]: (args) => oneWorker(lead, WorkerTool.Steer, args, AGENT_WORDS.CannotSteer),
    [WorkerTool.Stop]: (args) => oneWorker(lead, WorkerTool.Stop, args, (id) => stopAgent(lead, id)),
    [WorkerTool.Mark]: (args) => oneWorker(lead, WorkerTool.Mark, args, (id) => markAgent(lead, { ...args, id })),
  };
}

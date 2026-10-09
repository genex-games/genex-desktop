/**
 * The Unreal lead's run as one object (`Lead`), and the journal it resumes from. The journal is the
 * part a pause keeps (lead-contract.ts `LeadJournal`): the lead's seat and session, its milestones,
 * save points, sub-agents, the critic's advice, what the next digest owes it, credits and cost, and
 * the time worked. It is saved under the run's shared journal artifact (`autopilot_<runId>`), where
 * the app's Resume, its boot repair and `resumeRun` find a run, and tells itself apart from the
 * other modes' journals by its `kind`. The rest of `Lead` is this process's: the clock, the
 * deadlines, the turn under way, the sub-agents at work.
 */
import type { HarnessCtx, Run } from "../../types/harness.d.ts";
import type { LeadSeat } from "../director/lead-session.ts";
import type { FactRef } from "../folder-facts.ts";
import { HostMethod } from "../host-methods.ts";
import { isPlainRecord } from "../json.ts";
import { CLIP_DETAIL, clip } from "../text.ts";
import { JournalPhase, saveJournal } from "../run-events.ts";
import { readJournal } from "../run-journal.ts";
import type { CppSupport } from "./cpp.ts";
import {
  type AgentOffers,
  type AgentRecord,
  AgentState,
  type CriticDefect,
  LEAD_JOURNAL_KIND,
  LEAD_PART,
  type LeadCost,
  type LeadDigestState,
  type LeadJournal,
  type LeadMilestone,
} from "./lead-contract.ts";
import { LIVE_JOURNAL_KIND } from "./live-contract.ts";

/** The scope of the game folder's snapshots the lead's run takes (save points, inputs, the C++ module). */
export const SNAPSHOT_SCOPE = "game";

/** The Genex credits a run's sub-agents may spend unless the run names its own cap. */
export const DEFAULT_CREDIT_CAP = 600;

const MESSAGE = {
  /** The lead's own part, before it names a milestone. */
  LeadTitle: "Lead",
  NoReason: "no reason given",
  /** Why a sub-agent that was at work when the run paused is no longer. */
  PausedAgent: "the run paused while it worked",
} as const;

/** The run's clock: what time it is, and a wait that a test may make instant. */
export type LeadClock = { now(): number; sleep(ms: number): Promise<void> };

/** The lead's turn under way: its deadline, whether it ended, whether Unreal crashed in it, and what it was told mid-turn. */
export type LeadTurn = { deadline: number; over: boolean; crashed: boolean; steered: Set<string> };

/** The lead's run: its journal, and what this process keeps beside it. */
export type Lead = {
  ctx: HarnessCtx;
  run: Run;
  threadId: string;
  clock: LeadClock;
  /**
   * The game's folder (the lead's seat), its name as the user knows it, what its folder holds
   * (`game.list`'s `facts`; absent: the lead's Unreal project at its root) and the moments its
   * plugins hook (`hookEvents`; absent: none).
   */
  game: { dir: string; title: string; facts?: FactRef[]; hookEvents?: string[] };
  journal: LeadJournal;
  /** When the run's clock started (earlier than now on a resume), and its two deadlines. */
  started: number;
  softDeadline: number;
  finalDeadline: number;
  /** What the template has, from the Genex editor helper's export ("" without it). */
  template: string;
  cpp: CppSupport;
  /** The plugin tools on offer now (Local Blender's, and Genex Tools' asset tool) and the worker types declared. */
  offers: AgentOffers;
  turn: LeadTurn | null;
  /** Why the run stops for good (Unreal can't be reopened), or null while it goes on. */
  halted: string | null;
  /** A C++ agent asked for the game's module: it is added between turns. */
  addModule: boolean;
  /** The sub-agents at work in this process, by id. */
  agentRuns: Map<string, Promise<void>>;
  /** The save point under way, so two never overlap. */
  saving: Promise<unknown> | null;
};

/** What the next digest owes a new run's lead: nothing yet. */
const freshDigest = (): LeadDigestState => ({
  heardOwner: [],
  toldAgents: [],
  toldCritiques: 0,
  carried: [],
  jobs: [],
  lastAt: null,
});

/** The run's Genex credit cap: its own (`budgets.creditCap`, a whole number), else the default. */
function creditCap(run: Run): number {
  const own = run.budgets?.creditCap;
  return typeof own === "number" && Number.isSafeInteger(own) && own >= 0 ? own : DEFAULT_CREDIT_CAP;
}

/** A new run's journal. */
export function newLeadJournal(run: Run, seat: LeadSeat): LeadJournal {
  return {
    kind: LEAD_JOURNAL_KIND,
    phase: JournalPhase.Director,
    run,
    seat,
    sessionId: seat.sessionId,
    briefed: false,
    handovers: 0,
    turns: 0,
    milestones: [],
    savePoints: [],
    agents: [],
    critiques: [],
    crashes: [],
    digest: freshDigest(),
    credits: { spent: 0, cap: creditCap(run) },
    cost: { spent: 0 },
    between: { rewind: null, rebuild: false },
    builtStamp: null,
    logOffset: null,
    ends: [],
    jobsCursor: 0,
    workedMs: 0,
    savedAt: new Date(0).toISOString(),
  };
}

/** The lists a lead journal keeps, as a resume reads them. */
const LISTS = ["milestones", "savePoints", "agents", "critiques", "crashes", "ends"] as const;

/** Whether a saved journal is a lead run's, with the lists a resume reads. */
function isLeadJournal(saved: unknown): saved is LeadJournal {
  if (!isPlainRecord(saved) || saved.kind !== LEAD_JOURNAL_KIND) return false;
  return LISTS.every((list) => Array.isArray(saved[list])) && isPlainRecord(saved.run) && isPlainRecord(saved.seat);
}

/** A sub-agent at work when the run paused is stopped now: nothing in this process works on it. */
function stoppedAtPause(agent: AgentRecord): AgentRecord {
  if (agent.state !== AgentState.Running) return agent;
  return { ...agent, state: AgentState.Stopped, error: agent.error ?? MESSAGE.PausedAgent };
}

/** What the next digest owes, as saved; anything it can't read starts fresh. */
function digestOf(saved: unknown): LeadDigestState {
  const fresh = freshDigest();
  if (!isPlainRecord(saved)) return fresh;
  const texts = (list: unknown) => (Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : []);
  const told = Number(saved.toldCritiques);
  return {
    heardOwner: texts(saved.heardOwner),
    toldAgents: texts(saved.toldAgents),
    toldCritiques: Number.isSafeInteger(told) && told > 0 ? told : 0,
    carried: texts(saved.carried),
    jobs: texts(saved.jobs),
    lastAt: typeof saved.lastAt === "number" ? saved.lastAt : null,
  };
}

/** The cost so far, as saved (an older journal's running totals beside it are left behind); nothing it can't read. */
function costOf(saved: unknown): LeadCost {
  const spent = isPlainRecord(saved) ? saved.spent : null;
  return { spent: typeof spent === "number" && Number.isFinite(spent) && spent >= 0 ? spent : 0 };
}

/** A saved lead journal as a resume takes it up (a sub-agent at work then is stopped now), or null when it is not one. */
export function leadJournalOf(saved: unknown): LeadJournal | null {
  if (!isLeadJournal(saved)) return null;
  const fresh = newLeadJournal(saved.run, saved.seat);
  return {
    ...fresh,
    ...saved,
    briefed: saved.briefed === true,
    agents: saved.agents.map(stoppedAtPause),
    digest: digestOf(saved.digest),
    credits: isPlainRecord(saved.credits) ? saved.credits : fresh.credits,
    cost: costOf(saved.cost),
    between: isPlainRecord(saved.between) ? saved.between : fresh.between,
    logOffset: typeof saved.logOffset === "number" ? saved.logOffset : null,
    jobsCursor: Number.isSafeInteger(saved.jobsCursor) && saved.jobsCursor > 0 ? saved.jobsCursor : 0,
  };
}

/** Whether a saved journal is the older Unreal Loop's (`unreal-live`): the run closes with a plain line. */
export function fromOlderLoop(saved: unknown): boolean {
  return isPlainRecord(saved) && saved.kind === LIVE_JOURNAL_KIND;
}

/** The run's lead journal on its thread, or null when there is none (or it is another mode's). */
export async function readLeadJournal(ctx: HarnessCtx, threadId: string, runId: string): Promise<LeadJournal | null> {
  return leadJournalOf(await readJournal(ctx, threadId, runId));
}

/** Saves the journal, with the time worked so far and, when given, a new phase. Never throws. */
export async function saveLead(lead: Lead, phase?: JournalPhase): Promise<void> {
  const { journal } = lead;
  if (phase) journal.phase = phase;
  journal.workedMs = Math.max(0, lead.clock.now() - lead.started);
  journal.savedAt = new Date(lead.clock.now()).toISOString();
  await saveJournal(lead.ctx, lead.threadId, lead.run.runId, journal);
}

/** The critic's required items still open: those of its latest look (a defect it saw in two looks in a row). */
export const requiredNow = (journal: LeadJournal): CriticDefect[] => journal.critiques.at(-1)?.required ?? [];

/** The milestone the lead works on now: its last one, or the lead's own part before it named any. */
export function milestoneNow(journal: LeadJournal): LeadMilestone {
  const last = journal.milestones.at(-1);
  if (last) return last;
  const rounds = journal.savePoints.filter((point) => point.milestoneId === LEAD_PART).length;
  return { id: LEAD_PART, title: MESSAGE.LeadTitle, startedAt: 0, rounds };
}

/** A failure's message, on one line and cut short, as the lead's run quotes it. */
export const why = (err: unknown): string =>
  clip(String((err as Error)?.message ?? err ?? MESSAGE.NoReason).replace(/\s+/g, " "), CLIP_DETAIL);

/** What a command run in the game folder printed, as text ("" when it couldn't run). */
export async function gameText(lead: Pick<Lead, "ctx" | "run">, command: string): Promise<string> {
  const read = await lead.ctx.call(HostMethod.RunExec, { command, project: lead.run.project }).catch(() => null);
  return String(read?.stdout ?? "");
}

/** Each lead's git writes to the game folder, chained: the last one queued. */
const gitWrites = new WeakMap<object, Promise<unknown>>();

/**
 * Runs `write` once every git write to the game folder queued before it for this lead's run has
 * finished, and answers what it answers: a sub-agent's landing, a save point's snapshot and a
 * restore all take the game's one git index, and two at once fight over its lock.
 */
export function oneGitWrite<T>(lead: object, write: () => Promise<T>): Promise<T> {
  const before = gitWrites.get(lead) ?? Promise.resolve();
  const mine = before.then(write, write);
  gitWrites.set(
    lead,
    mine.catch(() => undefined),
  );
  return mine;
}

/**
 * The runner's call of one of the Unreal plugin's tools lives in `lead-steps.ts` (seed-upgrade.ts
 * `SEED_MOVES`): a harness file the agent kept from before still imports it from here.
 */
export { unrealTool } from "./lead-steps.ts";

/**
 * The lead's typed workers: small purpose-built agents (lead-contract.ts `AgentKind`, the worker
 * types the plugins that are on declare) that each run one delegated build turn in a copy of the
 * game folder, as workers of the run (the delegation's `worker`, so the host seats them in the mode
 * of the run's chat), offered only their kind's plugin tools
 * (`AGENT_TOOL_ALLOW`, the delegation's `toolAllow`) and attributed to the run and their part (the
 * delegation's `attribution`), so what they make lands on their own node in the Builds graph. A
 * sub-agent never touches the editor. It delivers into `assets/agents/<id>/` with a manifest; when
 * its turn ends the harness lands that folder in the game folder — only its regular files, inside
 * the folder and within the caps, never a link, a submodule, a climb out or another agent's files —
 * and the lead hears its news until it marks it used or rejected. A turn that ended early still
 * lands a delivery whose manifest was written. Delivered files are never removed at the close.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { DelegateResult } from "../../types/host-api.d.ts";
import { buildTurn } from "../build-turn.ts";
import { GIT, gitExec } from "../git.ts";
import { checkoutPaths, commitFolder, treeEntries } from "../git-delivery.ts";
import { HostMethod } from "../host-methods.ts";
import { isPlainRecord } from "../json.ts";
import { modelOn, RoleKey, roleEngine } from "../model-roles.ts";
import { isCommit, shellQuote } from "../shell.ts";
import { CLIP_DETAIL, clip, hasText } from "../text.ts";
import { MINUTE_MS, SECOND_MS } from "../time.ts";
import { WorkerRefusal, WorkerStopCode } from "../workers/contract.ts";
import { waitingWorkers } from "../workers/questions.ts";
import { withWorkerRoom } from "../workers/room.ts";
import type { WorkerState } from "../workers/records.ts";
import { closeRunPool } from "../workers/run-pool.ts";
import {
  AGENT_WORDS,
  agentBrief,
  agentTitle,
  DELIVERY_WORDS,
  deliveredNews,
  deliversMesh,
  PROP_TRIANGLES,
} from "./agent-prompts.ts";
import { cppFolder } from "./cpp.ts";
import { takePoolNews } from "./pool-news.ts";
import { lookAtDelivery } from "./critic.ts";
import { pathShapeProblem, realInside } from "./game-paths.ts";
import {
  AGENT_DELIVERY_ROOT,
  AGENT_MAIN_TOOLS,
  AGENT_MANIFEST_FILE,
  AGENT_TOOL_ALLOW,
  AGENT_TURN_MS,
  AgentFileRole,
  AgentKind,
  type AgentManifest,
  type AgentManifestFile,
  AgentPluginTool,
  type AgentRecord,
  AgentState,
  AgentVerdict,
  type AssetLook,
  type LeadCredits,
  MAX_AGENT_WAIT_S,
  MAX_RUNNING_AGENTS,
} from "./lead-contract.ts";
import { folderLabelOf } from "../workers/identity.ts";
import { agentMarked, agentNode, agentPart } from "./lead-graph.ts";
import { runScope, workerEndHooks, workerStartHooks } from "../hooks.ts";
import { type Lead, milestoneNow, oneGitWrite, SNAPSHOT_SCOPE, saveLead, why } from "./lead-journal.ts";

/** A sub-agent's turns at most: its first, and the ones it is woken for when it ended with nothing delivered. */
const MAX_AGENT_TURNS = 3;
/** A turn a sub-agent is woken for needs at least this much of its time. */
const MIN_AGENT_TURN_MS = 2 * MINUTE_MS;
/** A sub-agent's turn runs at this effort: a bounded job beside the lead's own work. */
const AGENT_EFFORT = "medium";
/** One delivery lands at most this many files, each at most this large. */
export const MAX_LAND_FILES = 64;
export const MAX_LAND_FILE_BYTES = 100 * 1024 * 1024;
/** At most this many inputs per sub-agent. */
export const MAX_AGENT_INPUTS = 8;
/** The largest manifest read, and what of its free text is kept. */
const MAX_MANIFEST_BYTES = 64 * 1024;
const MANIFEST_NOTES_CHARS = 800;
const IMPORT_CALL_CHARS = 400;
const MAX_IMPORT_CALLS = 24;
/** A checkout into the game folder git refused (another git held its index) is tried this often, this far apart. */
const LAND_TRIES = 3;
const LAND_RETRY_MS = 2 * SECOND_MS;
/** The most digits an agent's number is read with from a folder name. */
const AGENT_NUMBER = /^(\d{1,6})$/;
/**
 * At the close, the sub-agents still at work have this long, in real time, to stop (and land a
 * delivery whose manifest they wrote) before they are left as stopped: the run's own clock may
 * already be over, and the processes it waits for are real.
 */
const SETTLE_WAIT_MS = 30 * SECOND_MS;
/** How often a waiting `worker_wait` looks at the chat's log for a typed worker's question. */
const QUESTION_POLL_MS = 2 * SECOND_MS;
/**
 * A stop is sent again this far apart while the worker's turn has not ended, at most this many
 * times: one that reached the host before the turn's session registered aborted nothing.
 */
const ABORT_RETRY_MS = 2 * SECOND_MS;
const ABORT_RESENDS = 5;

/** The modes git gives a regular file; anything else (a link, a submodule) never lands. */
const REGULAR_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);
/** One `git ls-tree -r -l -z` entry: its mode, type, object, size and path. */
const TREE_ENTRY = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\d+|-)\t(.+)$/s;
const AGENT_KINDS: readonly string[] = Object.values(AgentKind);
const FILE_ROLES: readonly string[] = Object.values(AgentFileRole);
const VERDICTS: readonly string[] = Object.values(AgentVerdict);

/** The leads whose run is closing: a sub-agent that has not started its turn yet never starts it. */
const settling = new WeakSet<Lead>();
/** The typed workers the lead stopped (`worker_stop`), by lead: their turn's end reads as a stop. */
const stopAsked = new WeakMap<Lead, Set<string>>();
/** The questions each lead was shown, by `<worker>:<question>`: a question wakes `worker_wait` once. */
const toldQuestions = new WeakMap<Lead, Set<string>>();

/** The questions this lead was shown so far. */
function toldOf(lead: Lead): Set<string> {
  const told = toldQuestions.get(lead) ?? new Set<string>();
  toldQuestions.set(lead, told);
  return told;
}

/** One sub-agent's news for a digest or a steer: its id, where it stands, and the words the lead reads. */
/** One item of the lead's news of its workers: a typed worker's, or a generic one's end (`pool-news.ts`). */
export type AgentNews = { id: string; state: AgentState | WorkerState; text: string };

const isAgentKind = (value: unknown): value is AgentKind => AGENT_KINDS.includes(value as string);

/** Where a sub-agent delivers, from the game folder. */
export const agentFolder = (id: string): string => `${AGENT_DELIVERY_ROOT}/${id}`;

/** The engine the lead's session runs on, which spells the tools its news names. */
const leadEngineId = (lead: Lead): string => roleEngine(lead.run, RoleKey.Builder);

/** The sub-agents at work now. */
const running = (lead: Lead): AgentRecord[] => lead.journal.agents.filter((a) => a.state === AgentState.Running);

/** Whether the run's sub-agents have spent their Genex credits. */
const capReached = ({ spent, cap }: LeadCredits): boolean => cap !== null && spent >= cap;

/** The run's Genex credit cap as a delegation carries it: the host refuses the run's paid jobs past it. */
export const creditCapOf = (lead: Lead): { creditCap?: number } =>
  lead.journal.credits.cap === null ? {} : { creditCap: lead.journal.credits.cap };

/** What of a delivered record may be missing in a journal an older copy saved. */
const refusedOf = (agent: AgentRecord): string[] => agent.refused ?? [];

// ── paths the lead names ─────────────────────────────────────────────────────────────────────

/** The lead's inputs as game-folder paths, or why one is refused; nothing outside the game folder passes. */
async function inputsOf(lead: Lead, raw: unknown): Promise<{ inputs: string[] } | { refused: string }> {
  const listed = String(raw ?? "")
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (listed.length > MAX_AGENT_INPUTS) return { refused: AGENT_WORDS.TooManyInputs(MAX_AGENT_INPUTS) };
  for (const input of listed) {
    const shape = pathShapeProblem(input);
    const found = shape ? { problem: shape } : await realInside(lead.game.dir, input);
    if ("problem" in found) return { refused: AGENT_WORDS.BadInput(input, found.problem) };
  }
  return { inputs: listed };
}

// ── starting one ─────────────────────────────────────────────────────────────────────────────

/** The plugin tools a kind is offered now: its allowlist, less what is off and Genex once the credits are spent. */
function toolsFor(lead: Lead, kind: AgentKind): AgentPluginTool[] {
  const genex = lead.offers.genex && !capReached(lead.journal.credits);
  return AGENT_TOOL_ALLOW[kind].filter((tool) => {
    if (tool === AgentPluginTool.Blender) return lead.offers.blender;
    if (tool === AgentPluginTool.GenexAsset) return genex;
    return true;
  });
}

/** Why a kind can't work with the tools on offer, or null when it can. */
function missingTool(lead: Lead, kind: AgentKind, tools: readonly AgentPluginTool[]): string | null {
  const main: readonly AgentPluginTool[] = AGENT_MAIN_TOOLS[kind];
  if (main.some((tool) => tools.includes(tool))) return null;
  const { spent, cap } = lead.journal.credits;
  if (main.includes(AgentPluginTool.GenexAsset) && lead.offers.genex && cap !== null)
    return AGENT_WORDS.OverCap(spent, cap);
  return main.includes(AgentPluginTool.Blender) ? AGENT_WORDS.NoBlender : AGENT_WORDS.NoGenex;
}

/** Why a C++ agent can't start, or null when it can; a game with no module yet asks for one between turns. */
function cppProblem(lead: Lead): string | null {
  if (!lead.cpp.available) return AGENT_WORDS.NoCpp;
  if (lead.cpp.module) return null;
  lead.addModule = true;
  return AGENT_WORDS.NoModule;
}

/** What `worker_start` asked for, before its inputs are read. */
type Ask = { kind: AgentKind; title: string; brief: string };

/** `worker_start`'s arguments as an ask this run can start now, or why it can't. */
function askOf(lead: Lead, args: AnyRecord): Ask | { refused: string } {
  const { kind, title, brief } = args;
  const declared = lead.offers.types;
  if (!isAgentKind(kind)) return { refused: AGENT_WORDS.UnknownKind(declared ?? AGENT_KINDS) };
  // A kind is on offer when a plugin that is on declares it as a worker type (`plugins.workerTypes`).
  if (declared && !declared.includes(kind)) return { refused: AGENT_WORDS.UnknownKind(declared) };
  if (!hasText(title) || !hasText(brief)) return { refused: AGENT_WORDS.NeedsTitle };
  if (running(lead).length >= MAX_RUNNING_AGENTS) return { refused: AGENT_WORDS.TooMany(MAX_RUNNING_AGENTS) };
  const problem = kind === AgentKind.Cpp ? cppProblem(lead) : missingTool(lead, kind, toolsFor(lead, kind));
  return problem ? { refused: problem } : { kind, title, brief };
}

/** The number in an agent's id or folder name of this kind (`blender_model-3`, a C++ folder's `cpp_3`); 0 for another's. */
function numberOf(name: string, kind: AgentKind): number {
  const rest = [`${kind}-`, `${kind}_`].find((stem) => name.startsWith(stem));
  const number = rest ? AGENT_NUMBER.exec(name.slice(rest.length))?.[1] : undefined;
  return number ? Number(number) : 0;
}

/**
 * The highest number of this kind in the game's folders, where earlier runs' sub-agents delivered
 * (`assets/agents/`, and a C++ agent's folder in the game's module): a new one never lands over them.
 */
async function lastInGame(lead: Lead, kind: AgentKind): Promise<number> {
  const folders = [AGENT_DELIVERY_ROOT];
  const module = lead.cpp.available ? lead.cpp.module : null;
  if (kind === AgentKind.Cpp && module) folders.push(path.posix.dirname(cppFolder(module, kind)));
  const names = await Promise.all(folders.map((f) => readdir(path.join(lead.game.dir, f)).catch(() => [])));
  return Math.max(0, ...names.flat().map((name) => numberOf(name, kind)));
}

/** A new sub-agent's record: its id is its kind and a number past every one of its kind, this run's and the game's. */
function newAgent(lead: Lead, ask: Ask & { inputs: string[] }, lastFound: number): AgentRecord {
  const { agents } = lead.journal;
  const last = Math.max(lastFound, ...agents.map((a) => numberOf(a.id, ask.kind)));
  return {
    ...ask,
    title: clip(ask.title, CLIP_DETAIL),
    id: `${ask.kind}-${last + 1}`,
    milestoneId: milestoneNow(lead.journal).id,
    state: AgentState.Running,
    startedAt: lead.clock.now(),
    endedAt: null,
    worktree: null,
    error: null,
    commit: null,
    landed: [],
    refused: [],
    manifest: null,
    mark: null,
    mergedInto: null,
    credits: 0,
  };
}

/** A typed worker as Genex's moments name it: its part on the graph, title and kind. */
const agentMoment = (agent: AgentRecord) => ({ id: agentPart(agent.id), title: agent.title, type: agent.kind });

/** Starts a typed worker from `worker_start`'s arguments, in the background; answers its id, or why none started. */
export async function startAgent(lead: Lead, args: AnyRecord): Promise<string> {
  const ask = askOf(lead, args);
  if ("refused" in ask) return AGENT_WORDS.Refused(ask.refused);
  const read = await inputsOf(lead, args.inputs);
  if ("refused" in read) return AGENT_WORDS.Refused(read.refused);
  // Read before the record is made: two starts at once then still number apart, by the journal.
  const lastFound = await lastInGame(lead, ask.kind);
  const agent = newAgent(lead, { ...ask, inputs: read.inputs }, lastFound);
  const tools = toolsFor(lead, ask.kind);
  // Taken at once, before any wait: a start in flight beside it numbers apart and counts.
  lead.journal.agents.push(agent);
  // A plugin of the game may hold the worker back: nothing of it is written.
  const held = await workerStartHooks(lead.ctx, lead.game, runScope(lead), agentMoment(agent));
  if (held) {
    lead.journal.agents.splice(lead.journal.agents.indexOf(agent), 1);
    return AGENT_WORDS.Refused(held);
  }
  await agentNode(lead, agent);
  await saveLead(lead);
  const work = runAgent(lead, agent, tools)
    .catch((err: unknown) => turnEnded(lead, agent, { ok: false, why: refusedWhy(lead, err) }))
    .finally(() => lead.agentRuns.delete(agent.id));
  lead.agentRuns.set(agent.id, work);
  return AGENT_WORDS.Started(agent.id, leadEngineId(lead));
}

/**
 * Why a typed worker did not run: the host's words, and for a copy too large to make (read by its
 * code, never its text) where to work instead.
 */
function refusedWhy(lead: Lead, err: unknown): string {
  const words = why(err);
  if ((err as { code?: unknown } | null)?.code !== WorkerRefusal.CopyTooLarge) return words;
  return AGENT_WORDS.CopyTooLarge(words, leadEngineId(lead));
}

/** Where a C++ agent writes in the game's module, or null for every other kind. */
function cppFolderOf(lead: Lead, agent: AgentRecord): string | null {
  if (agent.kind !== AgentKind.Cpp || !lead.cpp.available || !lead.cpp.module) return null;
  return cppFolder(lead.cpp.module, agent.id.replace(/-/g, "_"));
}

/**
 * The game folder as it is now, in a snapshot, so a copy made from it holds the inputs: files the
 * lead made or another sub-agent landed since the last save point are in no commit yet.
 */
async function snapshotForInputs(lead: Lead, agent: AgentRecord): Promise<void> {
  const reason = AGENT_WORDS.InputsSnapshot(agent.id);
  const made = () =>
    lead.ctx.call(HostMethod.SnapshotCreate, { scope: SNAPSHOT_SCOPE, reason, project: lead.run.project });
  await oneGitWrite(lead, made).catch(() => {});
}

/** What a sub-agent's turns share: its engine and model, its copy, when its time is up, and its tools. */
type AgentSeat = {
  engine: string;
  model: string | undefined;
  cwd: string;
  deadline: number;
  tools: readonly AgentPluginTool[];
};

/**
 * One delegated turn of a sub-agent in its copy, a new session or `resume`d, offered only its tools.
 * A turn the chat's Settings ceiling has no room for yet waits for room until its deadline
 * (`withWorkerRoom`), unless the run or the worker is stopped meanwhile.
 */
function agentTurn(lead: Lead, agent: AgentRecord, seat: AgentSeat, turn: { prompt: string; resume: string | null }) {
  const clock = {
    now: () => lead.clock.now(),
    wait: (ms: number) => lead.clock.sleep(ms),
    stopped: () => endsBeforeItsTurn(lead, agent),
  };
  return withWorkerRoom(() => agentDelegation(lead, agent, seat, turn), seat.deadline, clock);
}

/** The delegation of one sub-agent turn, as the host answers it (a refusal throws). */
function agentDelegation(
  lead: Lead,
  agent: AgentRecord,
  seat: AgentSeat,
  turn: { prompt: string; resume: string | null },
) {
  const { ctx, run, threadId } = lead;
  return buildTurn(ctx, {
    delegated: true,
    engine: seat.engine,
    prompt: turn.prompt,
    project: run.project,
    threadId,
    runId: run.runId,
    ...(seat.model ? { model: seat.model } : {}),
    ...(turn.resume ? { resume: turn.resume } : {}),
    effort: AGENT_EFFORT,
    cwd: seat.cwd,
    timeoutMs: Math.max(MIN_AGENT_TURN_MS, seat.deadline - lead.clock.now()),
    // Spread as the delegation's own fields, so a build-turn.ts kept from before passes them on too.
    delegation: {
      attribution: { runId: run.runId, agentId: agentPart(agent.id) },
      // A worker of the run: the host seats it in the mode of the chat the run was started in.
      worker: { id: agent.id, title: agentTitle(agent.kind, agent.title), runId: run.runId },
      toolAllow: [...seat.tools],
      ...creditCapOf(lead),
    },
  });
}

/** Whether the sub-agent wrote its manifest in its copy: what it delivers lands only with one. */
async function manifestWritten(lead: Lead, agent: AgentRecord): Promise<boolean> {
  const { worktree } = agent;
  if (!worktree) return false;
  const file = shellQuote(`${agentFolder(agent.id)}/${AGENT_MANIFEST_FILE}`);
  const command = `test -f ${file} && echo yes || true`;
  const read = await lead.ctx.call(HostMethod.RunExec, { command, cwd: worktree }).catch(() => null);
  return String(read?.stdout ?? "").includes("yes");
}

/**
 * Whether a sub-agent whose turn ended goes on in its session: a turn that ended as turns do, with
 * nothing delivered yet, a session to resume and time left. A delegated session that ends to wait
 * (for a Genex job, in the background) is never woken, so the harness wakes it.
 */
async function goesOn(lead: Lead, agent: AgentRecord, result: DelegateResult, deadline: number): Promise<boolean> {
  const waiting = result.ok && Boolean(result.sessionId) && agent.state === AgentState.Running;
  const timeLeft = deadline - lead.clock.now() >= MIN_AGENT_TURN_MS;
  if (!waiting || !timeLeft || stopping(lead, agent)) return false;
  return !(await manifestWritten(lead, agent));
}

/** Whether a worker waiting for room should stop waiting: the run was cancelled, it ended, or a stop was asked. */
function endsBeforeItsTurn(lead: Lead, agent: AgentRecord): boolean {
  const ended = Boolean(lead.ctx.cancelled) || agent.state !== AgentState.Running;
  return ended || stopping(lead, agent);
}

/** Whether the run is closing or the lead asked this worker to stop: it takes no further turn. */
function stopping(lead: Lead, agent: AgentRecord): boolean {
  return settling.has(lead) || stopAsked.get(lead)?.has(agent.id) === true;
}

/** A sub-agent's work in its own copy of the game, on the builders' engine: a turn, and more while it hasn't delivered. */
async function runAgent(lead: Lead, agent: AgentRecord, tools: readonly AgentPluginTool[]): Promise<void> {
  const { ctx, run } = lead;
  if (agent.inputs.length) await snapshotForInputs(lead, agent);
  const copy = await ctx.call(HostMethod.SnapshotWorktree, {
    project: run.project,
    name: `agent-${agent.id}`,
    runId: run.runId,
  });
  agent.worktree = copy.path;
  if (stopping(lead, agent)) return stopUnstarted(lead, agent);
  const engine = roleEngine(run, RoleKey.Builder);
  const deadline = lead.clock.now() + AGENT_TURN_MS[agent.kind];
  const seat = { engine, model: modelOn(run, engine), cwd: copy.path, deadline, tools };
  const prompt = agentBrief({
    ...agent,
    game: lead.game.title,
    folder: agentFolder(agent.id),
    cppFolder: cppFolderOf(lead, agent),
    inputs: agent.inputs,
    engine,
    // Genex's identity opens the brief: the game's folder and what it holds.
    folderLabel: folderLabelOf(lead.game.dir, null),
    facts: lead.game.facts ?? null,
  });
  let result = await agentTurn(lead, agent, seat, { prompt, resume: null });
  for (let turns = 1; turns < MAX_AGENT_TURNS && (await goesOn(lead, agent, result, seat.deadline)); turns += 1)
    result = await agentTurn(lead, agent, seat, {
      prompt: AGENT_WORDS.GoOn(agentFolder(agent.id)),
      resume: result.sessionId ?? null,
    });
  const why = result.ok ? null : result.errorText || result.summary || DELIVERY_WORDS.NoReason;
  await turnEnded(lead, agent, { ok: result.ok, why });
}

/** The run closed (or the lead stopped it) before a typed worker's turn began: it never begins. */
async function stopUnstarted(lead: Lead, agent: AgentRecord): Promise<void> {
  const runEnded = settling.has(lead);
  const why = runEnded ? DELIVERY_WORDS.RunEnded : AGENT_WORDS.StoppedByLead;
  const code = runEnded ? WorkerStopCode.RunEnded : WorkerStopCode.StoppedByLead;
  if (agent.state === AgentState.Running) await ended(lead, agent, AgentState.Stopped, why, code);
}

/**
 * A sub-agent's turn ended: its delivery lands (all of it after a turn that went to its end; after
 * one that did not, only when it wrote its manifest), and it is done, or failed or stopped with why.
 */
async function turnEnded(lead: Lead, agent: AgentRecord, outcome: { ok: boolean; why: string | null }): Promise<void> {
  if (agent.state !== AgentState.Running) return;
  const landed = await landAgent(lead, agent, { needsManifest: !outcome.ok });
  // A delivery git couldn't check out yet is still delivered: its commit holds it, and it lands later.
  if (landed.length || agent.pending?.length) return deliveredNow(lead, agent);
  const askedStop = stopAsked.get(lead)?.has(agent.id) === true;
  const stopped = settling.has(lead) || askedStop;
  const stopWords = askedStop ? AGENT_WORDS.StoppedByLead : DELIVERY_WORDS.RunEnded;
  const why = stopped ? stopWords : (outcome.why ?? refusedOf(agent)[0] ?? DELIVERY_WORDS.NothingToLand);
  await ended(lead, agent, stopped ? AgentState.Stopped : AgentState.Failed, why, stopCodeOf(askedStop, stopped));
}

/** Why a typed worker stopped short, as the app words it: the lead's stop, the run's end, else an error. */
function stopCodeOf(askedStop: boolean, stopped: boolean): WorkerStopCode {
  if (askedStop) return WorkerStopCode.StoppedByLead;
  return stopped ? WorkerStopCode.RunEnded : WorkerStopCode.Error;
}

/**
 * A delivery made: the agent is done, its credits counted, its C++ in the game marked for a rebuild,
 * and a model's renders looked at by the critic before the lead hears of it.
 */
async function deliveredNow(lead: Lead, agent: AgentRecord): Promise<void> {
  const { journal } = lead;
  agent.credits = agent.manifest?.credits ?? 0;
  journal.credits.spent += agent.credits;
  if (agent.kind === AgentKind.Cpp && agent.landed.length) journal.between.rebuild = true;
  const look = await lookIfModel(lead, agent);
  if (look) agent.look = look;
  await ended(lead, agent, AgentState.Done, null, null);
}

/**
 * The critic's look at a delivered model's renders in the game folder, or null: not a model, no
 * render landed, or the run is closing (a look takes minutes the close doesn't have).
 */
async function lookIfModel(lead: Lead, agent: AgentRecord): Promise<AssetLook | null> {
  const renders = (agent.manifest?.renders ?? []).filter((render) => agent.landed.includes(render));
  if (!deliversMesh(agent.kind) || !renders.length || settling.has(lead) || lead.ctx.cancelled) return null;
  return lookAtDelivery(lead, { title: agent.title, brief: agent.brief, folder: agentFolder(agent.id), renders });
}

/** A sub-agent's end: its state and why, on its part and in the journal; its copy goes. */
async function ended(
  lead: Lead,
  agent: AgentRecord,
  state: AgentState,
  error: string | null,
  stopCode: WorkerStopCode | null,
): Promise<void> {
  agent.state = state;
  agent.error = error;
  agent.endedAt = lead.clock.now();
  await agentNode(lead, agent, stopCode);
  await workerEndHooks(lead.ctx, lead.game, runScope(lead), agentMoment(agent));
  await removeCopy(lead, agent);
  await saveLead(lead);
}

/** Removes a copy a turn still held at the close, once that turn ends. */
async function removeWhenEnded(lead: Lead, agent: AgentRecord, worktree: string | null): Promise<void> {
  await lead.agentRuns.get(agent.id)?.catch(() => {});
  if (!worktree) return;
  await lead.ctx.call(HostMethod.SnapshotRemoveWorktree, { project: lead.run.project, path: worktree }).catch(() => {});
}

/** Removes a sub-agent's copy of the game once nothing needs it; its delivery is in its commit and the game folder. */
async function removeCopy(lead: Lead, agent: AgentRecord): Promise<void> {
  const worktree = agent.worktree;
  if (!worktree) return;
  agent.worktree = null;
  const params = { project: lead.run.project, path: worktree };
  await lead.ctx.call(HostMethod.SnapshotRemoveWorktree, params).catch(() => {});
}

// ── landing a delivery ───────────────────────────────────────────────────────────────────────

/** One listed entry of a delivery's commit: its path, its size, and why it may not land (null when it may). */
type Entry = { path: string; size: number; problem: string | null };

/** What of a delivery's commit may land: its regular files in its folders, under the caps. */
type Landable = { files: Entry[]; refused: string[]; tooMany: number | null };

/** Whether `file` sits inside one of `folders`, with no climb, no `.` and no empty segment. */
function insideOne(file: string, folders: readonly string[]): boolean {
  const segments = file.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) return false;
  return folders.some((folder) => file.startsWith(`${folder}/`));
}

/** One listed entry, read: a regular file inside a folder and within the caps, or why not. */
function entryOf(line: string, folders: readonly string[]): Entry {
  const match = TREE_ENTRY.exec(line);
  if (!match) return { path: "", size: 0, problem: DELIVERY_WORDS.Malformed };
  const [, mode = "", , , size = "-", file = ""] = match;
  const bytes = Number(size);
  if (!insideOne(file, folders)) return { path: file, size: 0, problem: DELIVERY_WORDS.Outside(file) };
  if (!REGULAR_MODES.has(mode)) return { path: file, size: 0, problem: DELIVERY_WORDS.NotRegular(file) };
  if (!/^\d+$/.test(size) || bytes > MAX_LAND_FILE_BYTES)
    return { path: file, size: 0, problem: DELIVERY_WORDS.TooLarge(file) };
  return { path: file, size: bytes, problem: null };
}

/** What of a listing may land; nothing at all when it holds more files than one delivery takes. */
function landable(listing: readonly string[], folders: readonly string[]): Landable {
  const entries = listing.map((line) => entryOf(line, folders));
  const files = entries.filter((entry) => entry.problem === null);
  const refused = entries.flatMap((entry) => (entry.problem ? [entry.problem] : []));
  if (files.length > MAX_LAND_FILES) return { files: [], refused, tooMany: files.length };
  return { files, refused, tooMany: null };
}

/** The folders a sub-agent delivers into: its own, and a C++ agent's folder in the game's module. */
function deliveryFolders(lead: Lead, agent: AgentRecord): string[] {
  const cpp = cppFolderOf(lead, agent);
  return cpp ? [cpp, agentFolder(agent.id)] : [agentFolder(agent.id)];
}

/** The commit a delivery lands from: the one an earlier landing made, else a new one in its copy. */
async function deliveryCommit(lead: Lead, agent: AgentRecord, folders: readonly string[]): Promise<string | null> {
  if (agent.commit) return agent.commit;
  const { worktree } = agent;
  if (!worktree) return null;
  let commit: string | null = null;
  for (const folder of folders)
    commit = await commitFolder(lead.ctx, worktree, folder, `Sub-agent ${agent.id}`, { label: `agent ${agent.id}` });
  agent.commit = commit;
  return commit;
}

/** What a delivery's commit holds under its folders, read in the game folder (which shares its objects). */
async function listDelivery(lead: Lead, commit: string, folders: readonly string[]): Promise<string[]> {
  const at = { project: lead.run.project };
  const lists = await Promise.all(folders.map((f) => treeEntries(lead.ctx, at, commit, f, { label: "list delivery" })));
  return lists.flat();
}

/** A manifest as read from a delivery's commit: its JSON, or why there is none to read. */
type ManifestRead = { raw: AnyRecord } | { problem: string };

/** Reads the delivery's manifest from its commit (`git show <commit>:<path>`). */
async function readManifest(lead: Lead, commit: string, entry: Entry | undefined): Promise<ManifestRead> {
  if (!entry) return { problem: DELIVERY_WORDS.NoManifest };
  if (entry.size > MAX_MANIFEST_BYTES) return { problem: DELIVERY_WORDS.BadManifest("it is too large") };
  if (!isCommit(commit)) return { problem: DELIVERY_WORDS.BadManifest("no commit") };
  const shown = await gitExec(lead.ctx, { project: lead.run.project }, GIT.show(`${commit}:${entry.path}`), {
    label: "read manifest",
  }).catch(() => null);
  if (shown?.code !== 0) return { problem: DELIVERY_WORDS.BadManifest("git could not show it") };
  try {
    const raw: unknown = JSON.parse(String(shown.stdout));
    return isPlainRecord(raw) ? { raw } : { problem: DELIVERY_WORDS.BadManifest("it is not a JSON object") };
  } catch {
    return { problem: DELIVERY_WORDS.BadManifest("it is not JSON") };
  }
}

/** A path a manifest names, as a game-folder path inside the agent's folder (a bare name is taken as one there). */
function deliveredPath(named: unknown, folder: string): string | null {
  if (!hasText(named)) return null;
  const file = named.trim();
  return file.startsWith(`${folder}/`) ? file : `${folder}/${file}`;
}

/** A finite, non-negative number a manifest gave, or undefined. */
const measure = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Texts a manifest gave as a list, each clipped. */
const texts = (value: unknown, max: number, chars: number): string[] =>
  Array.isArray(value)
    ? value
        .filter(hasText)
        .slice(0, max)
        .map((text) => clip(text.trim(), chars))
    : [];

/** A manifest's bounds: three measures in centimetres, or undefined. */
function sizeOf(value: unknown): [number, number, number] | undefined {
  const [x, y, z, ...more] = Array.isArray(value) ? value.map(measure) : [];
  return x !== undefined && y !== undefined && z !== undefined && !more.length ? [x, y, z] : undefined;
}

/** What a manifest measured about one file; a field it gave nothing usable for is left out. */
function measuredOf(raw: AnyRecord): Omit<AgentManifestFile, "path" | "role"> {
  const measured: Omit<AgentManifestFile, "path" | "role"> = {};
  const triangles = measure(raw.triangles);
  const meshes = measure(raw.meshes);
  const sizeCm = sizeOf(raw.sizeCm);
  const materials = texts(raw.materials, MAX_IMPORT_CALLS, CLIP_DETAIL);
  if (triangles !== undefined) measured.triangles = Math.round(triangles);
  if (sizeCm) measured.sizeCm = sizeCm;
  if (hasText(raw.pivot)) measured.pivot = clip(raw.pivot.trim(), CLIP_DETAIL);
  if (materials.length) measured.materials = materials;
  if (meshes !== undefined) measured.meshes = Math.round(meshes);
  if (raw.meshesAsked === true) measured.meshesAsked = true;
  return measured;
}

/** One file entry of a manifest, read; null when it names no path or no known role. */
function manifestFile(raw: unknown, folder: string): AgentManifestFile | null {
  if (!isPlainRecord(raw) || !FILE_ROLES.includes(raw.role as string)) return null;
  const file = deliveredPath(raw.path, folder);
  return file ? { path: file, role: raw.role as AgentFileRole, ...measuredOf(raw) } : null;
}

/** A checked delivery: its manifest as the lead reads it, the files kept out, and what the lead should know. */
type CheckedDelivery = { manifest: AgentManifest | null; keptOut: Set<string>; problems: string[] };

/** Why one manifest file stays out (several meshes nobody asked for), or a warning, or nothing. */
function fileFindings(file: AgentManifestFile): { keepOut: boolean; problem: string | null } {
  if (file.role !== AgentFileRole.Mesh) return { keepOut: false, problem: null };
  const meshes = file.meshes ?? 1;
  if (meshes > 1 && file.meshesAsked !== true)
    return { keepOut: true, problem: DELIVERY_WORDS.MultiMesh(file.path, meshes) };
  const triangles = file.triangles ?? 0;
  return {
    keepOut: false,
    problem: triangles > PROP_TRIANGLES ? DELIVERY_WORDS.OverBudget(file.path, triangles) : null,
  };
}

/**
 * A delivery held to its contract: the manifest's files are ones it delivered, a mesh file holds
 * one mesh unless its brief asked for more (else it stays out, with the reason), and a prop over
 * its triangle budget is named. The manifest's kind and title are the agent's own.
 */
function checkDelivery(agent: AgentRecord, read: ManifestRead, delivered: ReadonlySet<string>): CheckedDelivery {
  if ("problem" in read) return { manifest: null, keptOut: new Set(), problems: [read.problem] };
  const { raw } = read;
  const folder = agentFolder(agent.id);
  const keptOut = new Set<string>();
  const problems: string[] = [];
  const files: AgentManifestFile[] = [];
  for (const listed of Array.isArray(raw.files) ? raw.files : []) {
    const file = manifestFile(listed, folder);
    if (!file) continue;
    if (!delivered.has(file.path)) {
      problems.push(DELIVERY_WORDS.NotDelivered(file.path));
      continue;
    }
    const found = fileFindings(file);
    if (found.problem) problems.push(found.problem);
    if (found.keepOut) keptOut.add(file.path);
    else files.push(file);
  }
  const renders = rendersOf(raw.renders, files, folder, delivered);
  const manifest: AgentManifest = {
    kind: agent.kind,
    title: agent.title,
    files,
    renders,
    importCalls: texts(raw.importCalls, MAX_IMPORT_CALLS, IMPORT_CALL_CHARS),
    notes: hasText(raw.notes) ? clip(raw.notes.trim(), MANIFEST_NOTES_CHARS) : "",
    credits: Math.round(measure(raw.credits) ?? 0),
  };
  return { manifest, keptOut, problems };
}

/** The renders a manifest names and delivered, then every delivered file whose role is render. */
function rendersOf(
  named: unknown,
  files: readonly AgentManifestFile[],
  folder: string,
  delivered: ReadonlySet<string>,
): string[] {
  const listed = Array.isArray(named) ? named.map((item) => deliveredPath(item, folder)) : [];
  const byRole = files.filter((file) => file.role === AgentFileRole.Render).map((file) => file.path);
  return [...new Set([...listed, ...byRole])].filter((file): file is string => file !== null && delivered.has(file));
}

/**
 * Lands a finished sub-agent's delivery in the game folder: its folder is committed in its copy (or
 * the commit an earlier landing made is used again), the commit's regular files in its folders,
 * within the caps, are checked against its manifest, and those that pass are checked out into the
 * game folder. With `needsManifest`, a delivery that wrote no manifest lands nothing. Answers the
 * landed game-folder paths; the record keeps them, its manifest and what stayed out.
 */
export async function landAgent(
  lead: Lead,
  agent: AgentRecord,
  { needsManifest = false }: { needsManifest?: boolean } = {},
): Promise<string[]> {
  const folders = deliveryFolders(lead, agent);
  const commit = await deliveryCommit(lead, agent, folders);
  if (!commit) return refuseAll(agent, DELIVERY_WORDS.NothingToLand);
  const found = landable(await listDelivery(lead, commit, folders), folders);
  if (found.tooMany !== null) return refuseAll(agent, DELIVERY_WORDS.TooManyFiles(found.tooMany, MAX_LAND_FILES));
  const manifestPath = `${agentFolder(agent.id)}/${AGENT_MANIFEST_FILE}`;
  const manifestEntry = found.files.find((entry) => entry.path === manifestPath);
  if (needsManifest && !manifestEntry) return [];
  const delivered = new Set(found.files.map((entry) => entry.path));
  const checked = checkDelivery(agent, await readManifest(lead, commit, manifestEntry), delivered);
  const files = [...delivered].filter((file) => !checked.keptOut.has(file));
  agent.refused = [...found.refused, ...checked.problems];
  agent.manifest = checked.manifest;
  const checkedOut = await checkoutInGame(lead, commit, files, `land ${agent.id}`);
  agent.landed = checkedOut ? files : [];
  agent.pending = checkedOut ? [] : files;
  return agent.landed;
}

/**
 * Checks the files out of a delivery's commit into the game folder, one git write at a time with
 * the save points' snapshots and the restores (`oneGitWrite`), asking again when git refuses;
 * whether it did.
 */
async function checkoutInGame(lead: Lead, commit: string, files: string[], label: string): Promise<boolean> {
  if (!files.length) return false;
  const at = { project: lead.run.project };
  return oneGitWrite(lead, async () => {
    for (let tries = 1; ; tries += 1) {
      if (await checkoutPaths(lead.ctx, at, commit, files, { label })) return true;
      if (tries >= LAND_TRIES) return false;
      await lead.clock.sleep(LAND_RETRY_MS);
    }
  });
}

/** Nothing of a delivery lands, for this reason. */
function refuseAll(agent: AgentRecord, why: string): string[] {
  agent.refused = [why];
  return [];
}

/**
 * A rewind took delivered files back out of the game folder: every delivered sub-agent's files
 * land again from the commit they came from (its copy is long gone), and C++ among them is rebuilt.
 */
export async function relandAgents(lead: Lead): Promise<void> {
  for (const agent of lead.journal.agents) {
    if (agent.state !== AgentState.Done || !agent.commit) continue;
    const landed = await landAgent(lead, agent);
    if (landed.length && agent.kind === AgentKind.Cpp) lead.journal.between.rebuild = true;
  }
  await saveLead(lead);
}

/** Deliveries git couldn't check out when they were made land now (between turns, at the close); C++ among them is rebuilt. */
export async function landPending(lead: Lead): Promise<void> {
  const waiting = lead.journal.agents.filter(
    (agent) => agent.state === AgentState.Done && agent.commit !== null && (agent.pending?.length ?? 0) > 0,
  );
  if (!waiting.length) return;
  for (const agent of waiting) {
    const landed = await landAgent(lead, agent);
    if (landed.length && agent.kind === AgentKind.Cpp) lead.journal.between.rebuild = true;
  }
  await saveLead(lead);
}

// ── the lead's view of them ──────────────────────────────────────────────────────────────────

/** A delivered agent's news, in the lead's engine's spelling. */
function newsOf(lead: Lead, agent: AgentRecord): string {
  return deliveredNews({
    id: agent.id,
    kind: agent.kind,
    title: agent.title,
    folder: agentFolder(agent.id),
    manifest: agent.manifest,
    landed: agent.landed,
    pending: agent.pending ?? [],
    refused: refusedOf(agent),
    ...(agent.look ? { look: agent.look } : {}),
    engine: leadEngineId(lead),
  });
}

/** A failed or stopped agent's news. */
function endNews(agent: AgentRecord): string {
  const what = agentTitle(agent.kind, agent.title);
  if (agent.state === AgentState.Stopped) return AGENT_WORDS.Stopped(agent.id, what);
  return AGENT_WORDS.Failed(agent.id, what, agent.error ?? DELIVERY_WORDS.NoReason);
}

/**
 * The news the lead is owed: every delivered sub-agent it has not marked (each time, until it
 * does), and each failed or stopped one it has not heard of yet — heard from now on (the journal's
 * `digest.toldAgents`); then each generic worker's end it has not heard yet (`takePoolNews`).
 */
export function agentNews(lead: Lead): AgentNews[] {
  return [...typedNews(lead), ...takePoolNews(lead)];
}

/** The typed workers' part of the lead's news. */
function typedNews(lead: Lead): AgentNews[] {
  const { agents, digest } = lead.journal;
  const news: AgentNews[] = [];
  for (const agent of agents) {
    if (agent.state === AgentState.Done && !agent.mark) {
      news.push({ id: agent.id, state: agent.state, text: newsOf(lead, agent) });
      continue;
    }
    const endedBadly = agent.state === AgentState.Failed || agent.state === AgentState.Stopped;
    if (!endedBadly || digest.toldAgents.includes(agent.id)) continue;
    digest.toldAgents.push(agent.id);
    news.push({ id: agent.id, state: agent.state, text: endNews(agent) });
  }
  return news;
}

/**
 * One sub-agent's line in a status: its kind and title, state, minutes, and its delivery, mark or
 * error; a running one that waits on the person says so, with what it asks.
 */
function statusLine(lead: Lead, agent: AgentRecord, asking: ReadonlyMap<string, string>): string {
  const minutes = Math.round(((agent.endedAt ?? lead.clock.now()) - agent.startedAt) / MINUTE_MS);
  const what = agentTitle(agent.kind, agent.title);
  const question = agent.state === AgentState.Running ? asking.get(agent.id) : undefined;
  if (question) toldOf(lead).add(`${agent.id}:${question}`);
  const extra = question ? AGENT_WORDS.WaitingForPerson(question) : (agent.error ?? "");
  const line = { id: agent.id, what, state: agent.state, minutes, extra };
  if (agent.state !== AgentState.Done) return AGENT_WORDS.Status(line);
  if (agent.mark) return AGENT_WORDS.Status({ ...line, extra: AGENT_WORDS.MarkedAs(agent.mark.verdict) });
  return `${AGENT_WORDS.Status(line)}\n${newsOf(lead, agent)}`;
}

/**
 * Where one sub-agent (or every one) stands, in words, with its manifest when it is done; `asking`
 * holds the questions running ones wait on the person with (`waitingWorkers`).
 */
export function agentStatus(lead: Lead, id?: unknown, asking: ReadonlyMap<string, string> = new Map()): string {
  const { agents } = lead.journal;
  const listed = hasText(id) ? agents.filter((a) => a.id === id) : agents;
  if (hasText(id) && !listed.length) return AGENT_WORDS.Unknown(id);
  if (!listed.length) return AGENT_WORDS.NoAgents;
  return listed.map((agent) => statusLine(lead, agent, asking)).join("\n\n");
}

/** The lead's typed workers that wait on the person now, by id, with what each asks. */
export function askingAgents(lead: Lead): Promise<Map<string, string>> {
  return waitingWorkers(lead.ctx, lead.threadId).catch(() => new Map<string, string>());
}

/** `worker_wait`'s seconds as a whole number from 1 to the cap. */
function waitSeconds(raw: unknown): number {
  const seconds = Math.floor(Number(raw));
  return Number.isFinite(seconds) ? Math.min(MAX_AGENT_WAIT_S, Math.max(1, seconds)) : MAX_AGENT_WAIT_S;
}

/**
 * Waits for one typed worker (or, with no id, the first of those running) to end or to start
 * waiting on the person, at most `worker_wait`'s seconds; answers where they stand. A wait whose
 * `signal` aborts (another wait answered the lead first) ends with no answer, so it never marks a
 * question as shown that the lead never saw.
 */
export async function waitAgent(lead: Lead, args: AnyRecord, signal?: AbortSignal): Promise<string> {
  const id = hasText(args.id) ? String(args.id) : null;
  const agent = id === null ? null : lead.journal.agents.find((a) => a.id === id);
  if (id !== null && !agent) return AGENT_WORDS.Unknown(id);
  const watched = () => (agent ? [agent] : running(lead)).filter((a) => a.state === AgentState.Running);
  const deadline = lead.clock.now() + waitSeconds(args.seconds) * SECOND_MS;
  let asking = await askingAgents(lead);
  // A question the lead was not shown yet wakes the wait, at once if one already waits.
  const told = toldOf(lead);
  const newlyAsks = () =>
    watched().some((a) => {
      const question = asking.get(a.id);
      return question !== undefined && !told.has(`${a.id}:${question}`);
    });
  const goesOnWaiting = () => !signal?.aborted && !newlyAsks() && lead.clock.now() < deadline;
  while (goesOnWaiting()) {
    const runs = watched().flatMap((a) => lead.agentRuns.get(a.id) ?? []);
    if (!runs.length) break;
    const pause = lead.clock.sleep(Math.min(QUESTION_POLL_MS, deadline - lead.clock.now())).then(() => false);
    if (await Promise.race([...runs.map((run) => run.then(() => true)), pause])) break;
    if (signal?.aborted) break;
    asking = await askingAgents(lead);
  }
  return signal?.aborted ? "" : agentStatus(lead, id ?? undefined, asking);
}

/** Records the lead's mark on a delivered typed worker from `worker_mark`'s arguments; answers what was recorded. */
export async function markAgent(lead: Lead, args: AnyRecord): Promise<string> {
  const id = String(args.id ?? "");
  const agent = lead.journal.agents.find((a) => a.id === id);
  if (!agent) return AGENT_WORDS.Unknown(id);
  if (agent.state !== AgentState.Done) return AGENT_WORDS.NotDelivered(id, agent.state);
  if (!VERDICTS.includes(args.verdict as string)) return AGENT_WORDS.BadVerdict;
  // A verdict stands once given: work a save point took in stays in the game, as on its row.
  if (agent.mergedInto) return AGENT_WORDS.InGameAlready(id, agent.mergedInto);
  if (agent.mark) return AGENT_WORDS.AlreadyMarked(id, agent.mark.verdict);
  const verdict = args.verdict as AgentVerdict;
  agent.mark = { verdict, note: hasText(args.note) ? clip(args.note.trim(), CLIP_DETAIL) : null, at: lead.clock.now() };
  await agentMarked(lead, agent);
  await saveLead(lead);
  return AGENT_WORDS.Marked(id, verdict);
}

/**
 * `worker_stop` for a typed worker: its turn is aborted in its copy, and its end reads as a stop. A
 * delivery whose manifest it wrote still lands, as at the run's close.
 */
export async function stopAgent(lead: Lead, id: string): Promise<string> {
  const agent = lead.journal.agents.find((a) => a.id === id);
  if (!agent) return AGENT_WORDS.Unknown(id);
  if (agent.state !== AgentState.Running) return AGENT_WORDS.NotRunning(id, agent.state);
  const asked = stopAsked.get(lead) ?? new Set<string>();
  asked.add(agent.id);
  stopAsked.set(lead, asked);
  await abortUntilEnded(lead, agent);
  return `${AGENT_WORDS.Stopping(id)}\n${agentStatus(lead, id)}`;
}

/**
 * Aborts a typed worker's turn in its copy and waits for it to end, sending the stop again while it
 * has not: one that reached the host before the turn's session registered aborted nothing, and the
 * worker then takes no further turn (`goesOn`).
 */
async function abortUntilEnded(lead: Lead, agent: AgentRecord): Promise<void> {
  const work = lead.agentRuns.get(agent.id);
  let ended = work === undefined;
  void work?.finally(() => {
    ended = true;
  });
  for (let sent = 0; !ended && sent < ABORT_RESENDS; sent += 1) {
    // The host found its session and stopped it: nothing to send again.
    if (await abortCopy(lead, agent)) break;
    await Promise.race([work, lead.clock.sleep(ABORT_RETRY_MS)]);
  }
  await work;
}

/** The host's abort for a typed worker's turn in its copy: whether it found one to stop. */
async function abortCopy(lead: Lead, agent: AgentRecord): Promise<boolean> {
  const cwd = agent.worktree;
  if (!cwd) return false;
  const answer = await lead.ctx.call(HostMethod.EngineAbort, { cwd }).catch(() => null);
  return (answer?.aborted ?? 0) > 0;
}

// ── the close ────────────────────────────────────────────────────────────────────────────────

/**
 * The run's end: sub-agents still at work are aborted; one that wrote its manifest is landed and
 * done, the others stopped. Every delivered file stays in the game folder; the copies go.
 */
export async function settleAgents(lead: Lead): Promise<void> {
  const { ctx } = lead;
  settling.add(lead);
  for (const agent of running(lead))
    if (agent.worktree) await ctx.call(HostMethod.EngineAbort, { cwd: agent.worktree }).catch(() => {});
  const runs = [...lead.agentRuns.values()];
  await Promise.race([Promise.all(runs), delay(SETTLE_WAIT_MS, undefined, { ref: false })]);
  // A turn still going after the wait may still write in its copy: the copy goes once it ends.
  const unsettled = lead.journal.agents.filter((agent) => lead.agentRuns.has(agent.id) && agent.worktree);
  const kept = new Map(unsettled.map((agent) => [agent.id, agent.worktree]));
  for (const agent of unsettled) agent.worktree = null;
  for (const agent of running(lead))
    await ended(lead, agent, AgentState.Stopped, DELIVERY_WORDS.RunEnded, WorkerStopCode.RunEnded);
  await landPending(lead);
  for (const agent of lead.journal.agents) await removeCopy(lead, agent);
  for (const agent of unsettled) void removeWhenEnded(lead, agent, kept.get(agent.id) ?? null);
  // The generic workers of the run's shared pool stop with it; a copy's work stays on the run's refs.
  await closeRunPool(lead.run.runId).catch(() => {});
  await saveLead(lead);
}

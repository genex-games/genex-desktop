/**
 * One turn of the Unreal lead: a delegation of its session in the game folder with the lead's run
 * tools (the director grant) and no window, resumed in the same session turn after turn; the first
 * opens with the brief, every later one with a digest. While a turn runs, the harness watches it:
 * the owner's words are steered at once, a finished sub-agent's news and a job of the run that
 * ended too (one no steer reached rides the next digest), a save is asked for after
 * `SAVE_STEER_MS` of work since the last save point, a crash (Genex's health check blocked) is
 * recovered and the lead told what may be lost, the wrap-up is asked for near the end, and the
 * owner's finish ends the turn. Genex's turn moments run around each turn (`turn.start` may stop
 * it). A lost or full session hands the run to a fresh one; a rate limit is waited out, a usage cap
 * pauses the run.
 */
import type { DelegateResult, HookReport } from "../../types/host-api.d.ts";
import { isResumeFailure } from "../chat-session.ts";
import { MIN_DELEGATE_TIMEOUT_MS } from "../config.ts";
import type { LeadLine } from "../director/lead-line.ts";
import { bookmarkLead, freshChat } from "../director/lead-session.ts";
import { fireHooks, HookEvent, runScope } from "../hooks.ts";
import { HostMethod } from "../host-methods.ts";
import { jobEndLine } from "../jobs/prompts.ts";
import { type JobEnd, jobEnds } from "../jobs/watch.ts";
import { modelOn, RoleKey, roleEffort, roleEngine } from "../model-roles.ts";
import { EngineFailure, engineLimitOf, isEngineLimit, StopReason } from "../outage.ts";
import { ExecutionStatus } from "../run-events.ts";
import { CLIP_DETAIL, clip } from "../text.ts";
import { MINUTE_MS, minutes, SECOND_MS } from "../time.ts";
import { agentNews, creditCapOf } from "./agents.ts";
import { LeadEndReason } from "./lead-contract.ts";
import { tellUser } from "./lead-graph.ts";
import { gameText, type Lead, type LeadTurn, requiredNow, saveLead, why } from "./lead-journal.ts";
import { CARRIED, digestPrompt, HANDOVER_WHY, handoverWords, leadBrief, STEER } from "./lead-prompts.ts";
import { LEAD_TOOLS, runStatusText } from "./lead-tools.ts";
import type { TemplateKind } from "./template-kind.ts";

/** One turn of the lead, at most. */
export const TURN_MS = 45 * MINUTE_MS;
/** This long after the last save point, the lead is steered to look, then save. */
export const SAVE_STEER_MS = 15 * MINUTE_MS;
/** The wrap-up steer comes this long before the run's working deadline. */
export const WRAP_UP_MS = 12 * MINUTE_MS;
/** The lead's effort unless the person chose one for the builders. */
const LEAD_EFFORT = "high";
/** Fresh sessions a run may open after its own was lost or filled up. */
export const MAX_HANDOVERS = 6;
/** A rate limit is waited out at most this often, when it resets this long before the working deadline. */
export const MAX_LIMIT_WAITS = 2;
const LIMIT_MARGIN_MS = 5 * MINUTE_MS;
/** How often Unreal, the chat and the sub-agents are looked at while a turn runs. */
const WATCH_MS = 15 * SECOND_MS;
/** How much of NOTES.md a fresh session's brief carries. */
const NOTES_CHARS = 8_000;
/** With no critic look for this long, the next digest asks for fresh eyes, and then not again for as long. */
export const FRESH_EYES_MS = 45 * MINUTE_MS;
/** How many of the owner's messages the journal remembers as heard. */
const HEARD_OWNER_KEPT = 200;

const MESSAGE = {
  StoppedByUser: "stopped by the user",
  FinishAsked: "the user asked the run to finish",
  Limit: (message: string) => `the engine hit its usage limit (${message}); Resume the Loop when it resets`,
  LimitWait: (minutesLeft: number) => `waiting ${minutesLeft} minutes for the engine's limit to reset`,
  LostTooOften: (why: string) => `the lead's session was lost too often (${why})`,
  TurnFailed: (why: string) => `the lead's turn failed: ${why}`,
  NoReason: "no reason given",
} as const;

/** How the run ends: its status, why in the journal's words, and why in the owner's (null: nothing to say). */
export type RunEnd = { status: ExecutionStatus; reason: LeadEndReason; why: string | null };

/** The run's ends that come from outside its turns: the user's stop, the user's finish, Unreal gone for good. */
export const RUN_ENDS = {
  stopped: (): RunEnd => ({
    status: ExecutionStatus.Cancelled,
    reason: LeadEndReason.Stopped,
    why: MESSAGE.StoppedByUser,
  }),
  finished: (): RunEnd => ({
    status: ExecutionStatus.Completed,
    reason: LeadEndReason.Finished,
    why: MESSAGE.FinishAsked,
  }),
  halted: (halted: string): RunEnd => ({ status: ExecutionStatus.Paused, reason: LeadEndReason.Halted, why: halted }),
} as const;

/** The lead's run as this process runs it: the `Lead`, and what only the runner reads. */
export type LeadRun = Lead & {
  end: RunEnd | null;
  line: LeadLine | null;
  /** Why the next turn opens a fresh session that takes over (null: it resumes). */
  handover: string | null;
  templateKind: TemplateKind;
  /** The game's Unreal project file, as the brief names it. */
  projectFile: string;
  /** The game's `references/` files. */
  references: string[];
  /** How many chat messages the line had when the lead last heard them. */
  heardCount: number;
  /** The owner's words that never reached a turn: the next digest says them. */
  pendingOwner: string[];
  /** Unreal being reopened or restored after a crash, so two never overlap. */
  recovering: Promise<string | null> | null;
  /** The wrap-up was said. */
  wrapUpSaid: boolean;
  /** The owner's words this process first took from the inbox were checked against what the lead heard before. */
  replayChecked: boolean;
  /** When this process took the run up: unsaved work is counted from here at the earliest. */
  workingSince: number;
  /** Why the engine answered the last turn as failed, or null when it ended as turns do. */
  failure: string | null;
  /** When a digest last asked for fresh eyes (null: never in this process). */
  freshEyesAskedAt?: number | null;
};

/** The stop reasons of a turn that ended as turns end, however the engine flagged it. */
const TURN_ENDS: ReadonlySet<string> = new Set([
  StopReason.Completed,
  StopReason.Stopped,
  StopReason.Deadline,
  StopReason.ContextOverflow,
  StopReason.Aborted,
]);

/** The lead's engine, model and effort: the builders' role, at high effort unless the person chose one. */
export function leadEngine(lead: Pick<Lead, "run">) {
  const engine = roleEngine(lead.run, RoleKey.Builder);
  return { engine, model: modelOn(lead.run, engine), effort: roleEffort(lead.run, RoleKey.Builder) ?? LEAD_EFFORT };
}

/** The delegation of one turn: the lead's session in the game folder, with the run tools and no window. */
function delegation(lead: LeadRun, prompt: string, deadline: number) {
  const { run, threadId, journal, game } = lead;
  const { engine, model, effort } = leadEngine(lead);
  return {
    engine,
    prompt,
    project: run.project,
    threadId,
    ...(model ? { model } : {}),
    effort,
    ...(run.preferences ? { preferences: run.preferences } : {}),
    timeoutMs: Math.max(MIN_DELEGATE_TIMEOUT_MS, deadline - lead.clock.now()),
    ...(journal.sessionId ? { resume: journal.sessionId } : {}),
    // The lead's own paid Genex jobs count against the run's cap with its sub-agents'.
    ...creditCapOf(lead),
    chatTurn: { messageId: run.runId },
    director: {
      runId: run.runId,
      threadId,
      project: run.project,
      root: game.dir,
      tools: LEAD_TOOLS,
      ...(journal.seat.chatSession ? { chatSession: true } : {}),
    },
  };
}

/** Says one thing into this turn, once (it reaches the session mid-turn); whether the session took it. */
async function steer(lead: LeadRun, turn: LeadTurn, key: string, text: string): Promise<boolean> {
  if (turn.over || turn.steered.has(key)) return false;
  turn.steered.add(key);
  const id = `${lead.run.runId}:${lead.journal.turns}:${key}`;
  const params = { threadId: lead.threadId, into: lead.run.runId, messages: [{ id, text }], interrupt: false };
  const answer = await lead.ctx.call(HostMethod.EngineSteer, params).catch(() => null);
  return Boolean(answer?.accepted.includes(id));
}

/** Says it into this turn, or, when the turn can't take it, into the next turn's digest. */
export async function steerOrCarry(lead: LeadRun, key: string, text: string): Promise<void> {
  const turn = lead.turn;
  const reached = turn ? await steer(lead, turn, key, text) : false;
  if (!reached && !turn?.steered.has(`carried-${key}`)) {
    turn?.steered.add(`carried-${key}`);
    lead.journal.digest.carried.push(text);
  }
}

/** The owner's words the run's inbox holds that the lead has not had, taken off it. */
export async function userWords(lead: LeadRun): Promise<string[]> {
  const words = (await lead.ctx.runInbox?.steering(undefined, true, { onlyNew: true }).catch(() => [])) ?? [];
  await lead.line?.heardThrough(lead.line.count());
  const { digest } = lead.journal;
  // A new inbox (a resumed run's) answers everything it has once: what the lead heard before the
  // pause is left out of that first answer. Later answers are new by the inbox's own count.
  const heard = lead.replayChecked ? [] : digest.heardOwner;
  lead.replayChecked = true;
  const fresh = words.filter((word) => !heard.includes(word));
  digest.heardOwner = [...digest.heardOwner, ...fresh].slice(-HEARD_OWNER_KEPT);
  return fresh;
}

/** The owner said something since the lead last heard: steered at once, or kept for the next digest. */
async function ownerWatch(lead: LeadRun, turn: LeadTurn): Promise<void> {
  const heard = lead.line?.count() ?? 0;
  if (heard === lead.heardCount) return;
  lead.heardCount = heard;
  const said = await userWords(lead);
  if (!said.length) return;
  const reached = await steer(lead, turn, `said-${heard}`, STEER.OwnerWords(said.join("\n")));
  if (!reached) lead.pendingOwner.push(...said);
}

/** Sub-agents' news the lead has not had in this turn. */
async function agentWatch(lead: LeadRun, turn: LeadTurn): Promise<void> {
  for (const news of agentNews(lead)) {
    const key = `agent-${news.id}-${news.state}`;
    if (turn.steered.has(key)) continue;
    const reached = await steer(lead, turn, key, STEER.AgentNews(news.text));
    if (!reached) lead.journal.digest.carried.push(STEER.AgentNews(news.text));
  }
}

/**
 * The run's jobs that ended since the lead last heard (the lead's own stops passed over); the
 * journal's cursor moves past them and is saved, so a resumed run reads on from there.
 */
async function newJobEnds(lead: LeadRun): Promise<JobEnd[]> {
  const { journal, run } = lead;
  const read = await jobEnds(lead.ctx, { project: run.project, runId: run.runId }, journal.jobsCursor);
  if (read.cursor === journal.jobsCursor) return read.ends;
  journal.jobsCursor = read.cursor;
  await saveLead(lead);
  return read.ends;
}

/** A job of the run that ended: steered into this turn, or kept for the next digest. */
async function jobWatch(lead: LeadRun, turn: LeadTurn): Promise<void> {
  for (const end of await newJobEnds(lead)) {
    const line = jobEndLine(end);
    const reached = await steer(lead, turn, `job-${end.id}`, STEER.JobEnded(line));
    if (!reached) lead.journal.digest.jobs.push(line);
  }
}

/** When unsaved work is counted from: the last save point, or when this process took the run up. */
export function unsavedSince(lead: LeadRun): number {
  return Math.max(lead.journal.savePoints.at(-1)?.at ?? 0, lead.workingSince);
}

/** Every `SAVE_STEER_MS` of work without a save point: look, then save. */
async function saveWatch(lead: LeadRun, turn: LeadTurn): Promise<void> {
  const since = unsavedSince(lead);
  const elapsed = lead.clock.now() - since;
  const key = `save-${since}-${Math.floor(elapsed / SAVE_STEER_MS)}`;
  if (elapsed < SAVE_STEER_MS || turn.steered.has(key) || lead.saving) return;
  await steer(lead, turn, key, STEER.SaveNow(leadEngine(lead).engine, minutes(elapsed)));
}

/** Whether the run is in its wrap-up: its working deadline is near. */
export const inWrapUp = (lead: LeadRun): boolean => lead.clock.now() >= lead.softDeadline - WRAP_UP_MS;

/** The wrap-up's words now. */
export const wrapUpWords = (lead: LeadRun): string =>
  STEER.WrapUp(leadEngine(lead).engine, minutes(Math.max(0, lead.softDeadline - lead.clock.now())));

/** Near the working deadline, once: fix what is visible, set the hero cameras, save "Final", update NOTES.md. */
async function wrapUpWatch(lead: LeadRun, turn: LeadTurn): Promise<void> {
  if (lead.wrapUpSaid || !inWrapUp(lead)) return;
  lead.wrapUpSaid = await steer(lead, turn, "wrap-up", wrapUpWords(lead));
}

/** Ends the lead's turn under way (its delegation in the game folder). */
export async function abortTurn(lead: LeadRun): Promise<void> {
  await lead.ctx.call(HostMethod.EngineAbort, { cwd: lead.game.dir }).catch(() => {});
}

/** Whether the user asked the run to finish (its inbox's finish request). */
export async function finishAsked(lead: LeadRun): Promise<boolean> {
  return (await lead.ctx.runInbox?.finishing().catch(() => false)) === true;
}

/** The owner asked the run to finish, or Unreal can't come back: the turn ends now. */
async function endWatch(lead: LeadRun): Promise<void> {
  if (!lead.halted && !(await finishAsked(lead))) return;
  lead.end ??= lead.halted ? RUN_ENDS.halted(lead.halted) : RUN_ENDS.finished();
  await abortTurn(lead);
}

/**
 * Unreal went away under the turn: recovered (reopened in place, or restored), and the lead told
 * what may be lost. Only when Genex's health check is blocked: a step that is pending (an editor
 * that is busy with the lead's own long script, an import, a save, or one that is reopening) is no
 * crash, and one the plugin can't tell about is pending too.
 */
async function crashWatch(lead: LeadRun, recover: (lead: LeadRun) => Promise<string | null>): Promise<void> {
  if (lead.recovering || lead.saving) return;
  const health = await fireHooks(lead.ctx, lead.game, HookEvent.Health, runScope(lead));
  if (!health.blocked || lead.recovering) return;
  if (lead.turn) lead.turn.crashed = true;
  const said = await recover(lead);
  if (said) await steerOrCarry(lead, `crash-${lead.journal.crashes.length}`, said);
}

/** One look while a turn runs. */
async function lookOnce(lead: LeadRun, turn: LeadTurn, recover: (lead: LeadRun) => Promise<string | null>) {
  await crashWatch(lead, recover);
  await ownerWatch(lead, turn);
  await agentWatch(lead, turn);
  await jobWatch(lead, turn);
  await saveWatch(lead, turn);
  await wrapUpWatch(lead, turn);
  await endWatch(lead);
}

/** Watches one turn until it is over; nobody waits for it. */
async function watchTurn(lead: LeadRun, turn: LeadTurn, recover: (lead: LeadRun) => Promise<string | null>) {
  while (!turn.over && !lead.ctx.cancelled) {
    await lead.clock.sleep(WATCH_MS);
    if (turn.over || lead.ctx.cancelled) return;
    await lookOnce(lead, turn, recover).catch(() => {});
  }
}

/** How one delegated turn ended: the engine's result, or what it threw. */
type TurnEnd = { result: Partial<DelegateResult> } | { error: unknown };

/** One delegated turn of the lead's session, watched while it runs. */
async function delegateTurn(
  lead: LeadRun,
  prompt: string,
  recover: (lead: LeadRun) => Promise<string | null>,
): Promise<TurnEnd> {
  const deadline = Math.min(lead.clock.now() + TURN_MS, lead.softDeadline);
  const turn: LeadTurn = { deadline, over: false, crashed: false, steered: new Set() };
  lead.turn = turn;
  void watchTurn(lead, turn, recover);
  try {
    return { result: await lead.ctx.call(HostMethod.EngineDelegate, delegation(lead, prompt, deadline)) };
  } catch (error) {
    return { error };
  } finally {
    turn.over = true;
    lead.turn = null;
  }
}

/** The lead's session is gone: the next turn opens a fresh one, which hears the brief again. */
function dropSession(lead: LeadRun, handover: string): void {
  lead.journal.sessionId = null;
  lead.journal.briefed = false;
  lead.handover = handover;
}

/** This turn's cost: the engine reports each delegation's own share, so it adds up as it comes. */
function countCost(lead: LeadRun, result: Partial<DelegateResult>): void {
  const share = result.usage?.cost_usd;
  if (typeof share === "number" && Number.isFinite(share) && share >= 0) lead.journal.cost.spent += share;
}

/** Why the engine answered a turn as failed (an error, its turn cap, no progress), or null for one that ended as turns do. */
function turnFailure(result: Partial<DelegateResult>): string | null {
  if (result.ok !== false || TURN_ENDS.has(String(result.stopReason))) return null;
  return why(result.errorText || result.summary || result.stopReason || MESSAGE.NoReason);
}

/**
 * The session a turn answered with: the journal's, and the chat's bookmark when it is the chat's
 * own. A session that answered a turn has heard the brief, even when the engine failed the turn.
 */
async function keepSession(lead: LeadRun, result: Partial<DelegateResult>): Promise<void> {
  const { journal } = lead;
  lead.handover = null;
  lead.failure = turnFailure(result);
  countCost(lead, result);
  if (result.stopReason === StopReason.ContextOverflow) {
    dropSession(lead, HANDOVER_WHY.ContextFull);
  } else {
    journal.briefed = true;
    if (result.sessionId) journal.sessionId = result.sessionId;
    if (result.sessionId)
      await bookmarkLead(lead.ctx, { threadId: lead.threadId, run: lead.run, seat: journal.seat }, result.sessionId);
  }
  await saveLead(lead);
}

/** Why a session is gone and a fresh one must carry the run on, or null when it is not. */
function lostWhy(lead: LeadRun, err: unknown): string | null {
  const kind = (err as { kind?: unknown } | null)?.kind;
  if (kind === EngineFailure.ContextOverflow || kind === EngineFailure.ContextThreshold)
    return HANDOVER_WHY.ContextFull;
  return lead.journal.sessionId && isResumeFailure(err) ? HANDOVER_WHY.ResumeFailed : null;
}

/** Whether a limit is waited out: a rate limit that resets well before the working deadline, and not too often. */
function waitsOut(lead: LeadRun, kind: unknown, wait: number, waits: number): boolean {
  const resets = wait > 0 && lead.clock.now() + wait + LIMIT_MARGIN_MS <= lead.softDeadline;
  return kind === EngineFailure.RateLimit && resets && waits < MAX_LIMIT_WAITS;
}

/** An engine's limit: waited out when it resets well before the working deadline, else the run pauses. */
async function limitHit(lead: LeadRun, err: unknown, waits: number): Promise<boolean> {
  const limit = engineLimitOf(err, lead.clock.now());
  const wait = limit.retryAfterMs ?? 0;
  if (waitsOut(lead, limit.kind, wait, waits)) {
    await tellUser(lead, MESSAGE.LimitWait(minutes(wait))).catch(() => {});
    await lead.clock.sleep(wait);
    return !lead.ctx.cancelled;
  }
  const words = MESSAGE.Limit(clip(limit.message, CLIP_DETAIL));
  lead.end = { status: ExecutionStatus.Paused, reason: LeadEndReason.Limit, why: words };
  return false;
}

/** A failed turn: a fresh session after a lost one, a limit waited out (true: ask again), or the run's end. */
async function afterFailure(lead: LeadRun, err: unknown, waits: number): Promise<boolean> {
  const kind = (err as { kind?: unknown } | null)?.kind;
  if (lead.ctx.cancelled || kind === EngineFailure.Aborted || lead.end) return false;
  if (isEngineLimit(kind)) return limitHit(lead, err, waits);
  const lost = lostWhy(lead, err);
  if (lost && lead.journal.handovers < MAX_HANDOVERS) {
    lead.journal.handovers += 1;
    dropSession(lead, lost);
    await saveLead(lead);
    return true;
  }
  const message = lost ? MESSAGE.LostTooOften(lost) : MESSAGE.TurnFailed(why(err));
  lead.end = { status: ExecutionStatus.Failed, reason: LeadEndReason.Failed, why: message };
  return false;
}

/** A file of the game folder as text ("" when it can't be read), at most `max` characters. */
async function gameFile(lead: LeadRun, file: string, max: number): Promise<string> {
  return (await gameText(lead, `cat ${file} 2>/dev/null || true`)).slice(0, max);
}

/**
 * The brief a session hears on its first turn: after the chat so far when it is the run's first
 * session, or after the handover when it takes over from a lost one; NOTES.md when it has some.
 */
async function briefFor(lead: LeadRun): Promise<string> {
  const { run } = lead;
  const handover = lead.handover
    ? handoverWords({ why: lead.handover, status: runStatusText(lead) })
    : await freshChat(lead.ctx, lead.threadId).catch(() => "");
  const totalMs = lead.softDeadline - lead.started;
  return leadBrief({
    engine: leadEngine(lead).engine,
    project: lead.projectFile,
    goal: String(run.goal ?? ""),
    title: lead.game.title,
    template: lead.template,
    templateKind: lead.templateKind,
    minutes: minutes(Math.max(0, totalMs)),
    cpp: lead.cpp.available,
    offers: lead.offers,
    references: lead.references,
    handover,
    notes: await gameFile(lead, "NOTES.md", NOTES_CHARS),
    folderLabel: lead.game.dir.split("/").slice(-2).join("/"),
    facts: lead.game.facts,
  });
}

/** Minutes since the critic last looked (or the run began) when fresh eyes are due, else null; due at most every FRESH_EYES_MS. */
function freshEyesDue(lead: LeadRun): number | null {
  const now = lead.clock.now();
  const since = lead.journal.critiques.at(-1)?.at ?? lead.started;
  const quiet = now - since >= FRESH_EYES_MS && now - (lead.freshEyesAskedAt ?? since) >= FRESH_EYES_MS;
  if (!quiet) return null;
  lead.freshEyesAskedAt = now;
  return minutes(now - since);
}

/** What the next turn opens with: the digest of what happened since the lead's last turn. */
async function digestOf(lead: LeadRun): Promise<string> {
  const { journal } = lead;
  const ownerWords = [...lead.pendingOwner.splice(0), ...(await userWords(lead))];
  const carried = journal.digest.carried.splice(0);
  const jobs = [...journal.digest.jobs.splice(0), ...(await newJobEnds(lead)).map(jobEndLine)];
  if (inWrapUp(lead) && !lead.wrapUpSaid) {
    carried.push(wrapUpWords(lead));
    lead.wrapUpSaid = true;
  }
  const last = journal.savePoints.at(-1);
  const advice = journal.critiques.slice(journal.digest.toldCritiques);
  journal.digest.toldCritiques = journal.critiques.length;
  journal.digest.lastAt = lead.clock.now();
  return digestPrompt(leadEngine(lead).engine, {
    minutesLeft: minutes(Math.max(0, lead.softDeadline - lead.clock.now())),
    ownerWords,
    agentNews: agentNews(lead).map((news) => news.text),
    lastSave: last ? { label: last.label, minutesAgo: minutes(lead.clock.now() - last.at) } : null,
    advice,
    carried,
    jobs,
    credits: journal.credits,
    freshEyesDue: freshEyesDue(lead),
    required: requiredNow(journal),
  });
}

/** The first turn's own words besides the brief: what the owner said since the run began. */
async function firstWords(lead: LeadRun): Promise<string> {
  const said = [...lead.pendingOwner.splice(0), ...(await userWords(lead))];
  return said.length ? STEER.OwnerWords(said.join("\n")) : "";
}

/** One delegation of the turn, asked again after a handover or a limit waited out. */
async function delegateWithRetries(lead: LeadRun, body: string, recover: (lead: LeadRun) => Promise<string | null>) {
  for (let tries = 0; tries <= MAX_HANDOVERS + MAX_LIMIT_WAITS; tries += 1) {
    const brief = lead.journal.briefed ? "" : await briefFor(lead);
    const end = await delegateTurn(lead, [brief, body].filter(Boolean).join("\n\n"), recover);
    if ("result" in end) return keepSession(lead, end.result);
    if (!(await afterFailure(lead, end.error, tries))) return;
  }
}

/** What held a lead's turn back at its start: the step's reason, and Genex's own hold when it was Genex's. */
export type TurnHeld = NonNullable<HookReport["blocked"]>;

/**
 * One turn of the lead, between Genex's turn moments: a step that blocks the turn's start keeps it
 * from running (the next digest says why) and is answered, so the run can wait before it asks
 * again; null once the turn ran. The end's notes are the plugins' own.
 */
export async function leadTurn(
  lead: LeadRun,
  recover: (lead: LeadRun) => Promise<string | null>,
): Promise<TurnHeld | null> {
  lead.failure = null;
  const scope = { ...runScope(lead), turn: String(lead.journal.turns + 1) };
  const opened = await fireHooks(lead.ctx, lead.game, HookEvent.TurnStart, scope);
  if (opened.blocked) {
    lead.journal.digest.carried.push(CARRIED.TurnHeld(opened.blocked.reason));
    await saveLead(lead);
    return opened.blocked;
  }
  lead.journal.turns += 1;
  const body = lead.journal.turns === 1 ? await firstWords(lead) : await digestOf(lead);
  await saveLead(lead);
  await delegateWithRetries(lead, body, recover);
  await fireHooks(lead.ctx, lead.game, HookEvent.TurnEnd, scope);
  return null;
}

/** How a run ends on something that threw: stopped by the user when it was, else failed with why. */
export function failedEnd(lead: LeadRun, err: unknown): RunEnd {
  if (lead.ctx.cancelled) return RUN_ENDS.stopped();
  return { status: ExecutionStatus.Failed, reason: LeadEndReason.Failed, why: MESSAGE.TurnFailed(why(err)) };
}

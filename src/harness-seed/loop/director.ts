/**
 * The Loop: the lead's session, and optional workers it starts. The lead IS its chat's own session
 * (director/lead-session.ts): it decides how to work — plans or not, starts workers or not — and
 * builds with its own hands. A web game's lead builds in the run's integration worktree; a worker
 * gets a brief and the lead's tools and works in a copy of it, and `worker_mark used` merges its
 * work in, followed by one health check (the page loads, no uncaught errors, the screenshot is not
 * blank). `finish` runs the same check and lands the branch in the game folder. A second opinion is
 * the lead's to ask for (`judge`). A Loop on any other project works the same way in the project's
 * own folder (director/open/), and closes there.
 *
 * The session is driven by the wake loop (director/wake.ts): the lead ends its turn when it decides
 * to, and the studio wakes the same session with a message when something happens.
 */
import path from "node:path";
import { plannerModel, roleEffort, RoleKey } from "./model-roles.ts";
import { GIT, gitAt } from "./git.ts";
import { MIN_DELEGATE_TIMEOUT_MS } from "./config.ts";
import { StopWhy } from "./finish-contract.ts";
import { closeSettled, closeUnderWay, latchClose } from "./director/close-latch.ts";
import { fireHooks, HookEvent, holdOf, notesText, runScope } from "./hooks.ts";
import { type HeldBack, heldTurnEnding, runHeldWords } from "./director/held-words.ts";
import { LoopProfile } from "./folder-facts.ts";
import { loopSkills } from "./loop-skills.ts";
import { closeRunPool } from "./workers/run-pool.ts";
import { leadsOpenLoop } from "./director/open/active-work.ts";
import { briefWriter } from "./director/open/brief.ts";
import { closeInPlace, refuseResume } from "./director/open/close.ts";
import { MESSAGE as OPEN_END, openEndWords, timeUpWithoutYes } from "./director/open/finish.ts";
import { openBetweenTurns } from "./director/open/between.ts";
import { creditCapOf, OPEN_WALL_CLOCK, restartsApp } from "./director/open/contract.ts";
import { settleRecovery } from "./director/open/health.ts";
import { openStartHeld } from "./director/open/prompts.ts";
import { openTools } from "./director/open/tool-specs.ts";
import { openHandler } from "./director/open/tools.ts";
import { HostMethod } from "./host-methods.ts";
import { EngineFailure, engineLimitOf } from "./outage.ts";
import { isProviderLoss, noteProviderLoss, pauseDecision, pauseEnding } from "./provider-loss.ts";
import { isCommit } from "./shell.ts";
import { CLIP_QUOTE } from "./text.ts";
import { SECOND_MS } from "./time.ts";
import { noClaimRead } from "./time-cap.ts";
import { NotLandedReason } from "./verdict.ts";
import * as loopRunFunctions from "./director/loop-run.ts";
import * as toolFunctions from "./director/tools.ts";
import * as integrateFunctions from "./director/integrate.ts";
import { servesLiveChat } from "./live-chat-served.ts";
import { prepareLoopRun } from "./director/setup.ts";
import { reopenMarkOf } from "./director/reopen.ts";
import { reopenNote } from "./director/reopen-prompts.ts";
import { directorBrief, resumeNote } from "./director/briefs.ts";
import { directors, directorTools } from "./director/tool-specs.ts";
import { runWakeLoop, SYSTEM_CLOCK, WAKE_ENDING } from "./director/wake.ts";
import { WrapCause } from "./director/wake-schedule.ts";
import { openLeadLine, type LeadLine } from "./director/lead-line.ts";
import * as leadLineParts from "./director/lead-line.ts";
import { bookmarkLead, freshChat, leadSeat } from "./director/lead-session.ts";
import { retainSpan, type OperationSpan } from "./director/timing.ts";
import { tracedContext } from "./director/trace.ts";
import type { LoopRun } from "./director/loop-run.ts";
import type { DirectorTalk, WakeClock } from "./director/wake.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";
import type { DelegateImage, DelegateResult, LiveToolSpec, ReferenceFrame } from "../types/host-api.d.ts";

export { directorTool } from "./director/tool-specs.ts";

/** This part leads a Loop on a project of any kind: a run reads it by namespace before it leads an open Loop. */
export const SERVES_OPEN_LOOP = true;

/** The run's modules, whose functions `bindLoopRun` puts on the run. */
const LOOP_RUN_MODULES = [loopRunFunctions, toolFunctions, integrateFunctions];

/** How many reference stills the lead's first turn carries. */
const MAX_REFERENCE_IMAGES = 8;
/** A session that ended within this of its deadline ran out of time. */
const OUT_OF_TIME_MS = 60 * SECOND_MS;
/** How much of a crash's message the report keeps. */
const FAILURE_CHARS = 500;
/** How much of an engine limit's message the decision card quotes. */
const LIMIT_MESSAGE_CHARS = 160;

/** The reference stills the person attached, which the lead's first turn carries. */
function referenceImages(run: Run): DelegateImage[] {
  return (run.reference?.frames ?? [])
    .filter((f: ReferenceFrame | null) => f?.data)
    .slice(0, MAX_REFERENCE_IMAGES)
    .map((f: ReferenceFrame) => ({
      label: `REFERENCE ${f.label}`,
      mimeType: f.mimeType ?? "image/jpeg",
      data: f.data,
    }));
}

/**
 * One turn of the lead's session, on its own engine and model. The lead is its chat's own session:
 * it sits in the game folder (no `cwd`); its grant names the folder it builds in (`root`: a web
 * game's integration worktree, or the game folder itself for a Loop in place), and its paid jobs are
 * held to the credit cap its run record names.
 */
function delegateTurn(
  loopRun: LoopRun,
  images: DelegateImage[],
  tools: LiveToolSpec[],
  prompt: string,
  sessionId: string | null | undefined,
  timeoutMs: number,
): Promise<DelegateResult> {
  const { ctx, integrationWorktree, lead, run, threadId } = loopRun;
  const creditCap = creditCapOf(run);
  return ctx.call(HostMethod.EngineDelegate, {
    engine: run.engine,
    prompt,
    project: run.project,
    threadId,
    ...(plannerModel(run) ? { model: plannerModel(run) } : {}),
    effort: roleEffort(run, RoleKey.Planner),
    preferences: run.preferences,
    timeoutMs: Math.max(MIN_DELEGATE_TIMEOUT_MS, timeoutMs),
    ...(sessionId ? { resume: sessionId } : {}),
    ...(creditCap === null ? {} : { creditCap }),
    // The lead answers the chat while its build runs: what the person sends reaches its turn under way.
    ...(loopRun.waking ? { chatTurn: { messageId: run.runId } } : {}),
    director: {
      runId: run.runId,
      threadId,
      project: run.project,
      root: integrationWorktree,
      setup: run.setup ?? null,
      tools,
      ...(lead?.chatSession ? { chatSession: true } : {}),
      ...(leadsOpenLoop(loopRun) ? { inPlace: true } : {}),
    },
    ...(images.length ? { images } : {}),
  });
}

/**
 * The lead's session as the run talks to it. A session that dies of a lost provider — the engine's
 * limit, or its sign-in gone — is not the lead failing: it is remembered, and the loop chooses between
 * waiting and pausing.
 */
export function directorTalk(loopRun: LoopRun, images: DelegateImage[], tools: LiveToolSpec[]): DirectorTalk {
  const { ctx, journal, lead, run, state, threadId } = loopRun;
  let stillsSeen = false;
  const stillsFor = (sid: string | null | undefined): DelegateImage[] => {
    const show = !sid || (Boolean(lead) && !stillsSeen);
    stillsSeen = true;
    return show ? images : [];
  };
  const talk: DirectorTalk = {
    sessionId: lead ? lead.sessionId : (loopRun.priorJournal?.director?.sessionId ?? null),
    session: async (prompt, sid, timeoutMs) => {
      try {
        // A fresh lead session knows nothing of the chat it leads for: it is told the chat so far first.
        const chat = lead && !sid ? await freshChat(ctx, threadId) : "";
        const asked = chat ? `${chat}\n\n${prompt}` : prompt;
        return await delegateTurn(loopRun, stillsFor(sid), tools, asked, sid, timeoutMs);
      } catch (err: any) {
        if (!isProviderLoss(err?.kind)) throw err;
        state.limit = engineLimitOf(err);
        noteProviderLoss(run.runId, run.engine, err);
        const words = pauseDecision(err.kind, String(err.message ?? err).slice(0, LIMIT_MESSAGE_CHARS));
        await loopRun.decision(words.line, words.plain);
        return {
          ok: false,
          stopReason: err.kind,
          errorText: String(err.message ?? err),
          ...(sid ? { sessionId: sid } : {}),
        };
      }
    },
    keep: async (result) => {
      if (!result?.sessionId) return;
      talk.sessionId = result.sessionId;
      if (lead) await bookmarkLead(ctx, { threadId, run, seat: lead }, result.sessionId);
      if (journal.director.sessionId === talk.sessionId) return;
      journal.director.sessionId = talk.sessionId;
      await loopRun.saveJournal();
    },
  };
  return talk;
}

/** What a resumed web run's lead is told about its branch, and — for a finished build reopened — where it goes on from. */
async function resumeWords(loopRun: LoopRun): Promise<string | null> {
  const { baseCommit, ctx, forkCommit, integrationWorktree, priorJournal, run } = loopRun;
  if (!priorJournal?.director) return null;
  const moved = isCommit(forkCommit) && isCommit(baseCommit) && forkCommit !== baseCommit;
  const aheadOfBase = moved
    ? Number(
        await gitAt(ctx, integrationWorktree, GIT.revListCount(baseCommit, forkCommit), {
          label: `director:${run.runId}:ahead`,
        }).catch(() => "0"),
      ) || 0
    : 0;
  const note = resumeNote({ forkCommit, baseCommit, aheadOfBase });
  if (!reopenMarkOf(priorJournal)) return note;
  return `${reopenNote({ inFolder: forkCommit === baseCommit, forkCommit })} ${note}`;
}

/** What the run stands on as its lead's first turn opens: why a plugin held the start back, and what the plugins said. */
interface StartOfRun {
  held?: string;
  blocked?: HeldBack;
  notes: string[];
}

/** The game's plugins prepare their apps first; one that can't holds the run back before any turn. */
async function prepareTheStart(loopRun: LoopRun): Promise<StartOfRun> {
  const { ctx } = loopRun;
  if (ctx.cancelled) return { notes: [] };
  const prepared = await fireHooks(ctx, loopRun.game, HookEvent.RunPrepare, runScope(loopRun));
  if (prepared.blocked && ctx.cancelled) return { notes: [] };
  if (prepared.blocked) return { held: runHeldWords(prepared.blocked), blocked: prepared.blocked, notes: [] };
  return { notes: notesText(prepared) };
}

/** The skills whose facts reach this game, by name: the web lead reads one on demand. */
async function skillNames(loopRun: LoopRun): Promise<string[]> {
  const skills = await loopSkills(loopRun.ctx.workspace, { facts: loopRun.gameFacts ?? [] }).catch(() => []);
  return skills.map((skill) => skill.slug);
}

/** The web lead's brief, from what the run knows (written again for a fresh session). */
async function webBrief(loopRun: LoopRun, start: StartOfRun): Promise<() => string> {
  const resume = await resumeWords(loopRun);
  const skills = await skillNames(loopRun);
  const notes = start.notes.length
    ? `WHAT THE GAME'S PLUGINS SAID:\n${start.notes.map((n) => `- ${n}`).join("\n")}`
    : "";
  return () =>
    [
      directorBrief({
        run: loopRun.run,
        softDeadline: loopRun.softDeadline,
        finalDeadline: loopRun.finalDeadline,
        integrationWorktree: loopRun.integrationWorktree,
        baseCommit: loopRun.state.integrationHead,
        gameFolder: loopRun.projectDir,
        facts: loopRun.gameFacts ?? null,
        resume,
        skills,
      }),
      notes,
    ]
      .filter(Boolean)
      .join("\n\n");
}

/** Why the session ended, in the sentence the report keeps. */
function sessionEndWords(
  loopRun: LoopRun,
  result: Partial<DelegateResult>,
  at: number,
  wrapCause: WrapCause | null,
): string {
  const { ctx, softDeadline, state } = loopRun;
  if (ctx.cancelled) return "stopped by the user";
  if (state.limit) return pauseEnding(state.limit.kind, String(state.limit.message).slice(0, CLIP_QUOTE));
  const held = heldTurnEnding(result);
  if (held) return held;
  if (wrapCause === WrapCause.Idle || wrapCause === WrapCause.Finish) return WAKE_ENDING[wrapCause];
  if (wrapCause !== WrapCause.Failed && at >= softDeadline - OUT_OF_TIME_MS)
    return "the lead ran out of time without calling finish";
  return `the lead's session ended (${result?.stopReason ?? (result?.ok ? "on its own" : "failed")}) before it called finish`;
}

/** Whether a web run's session ended on its clock: no Stop, limit, held turn, idle lead, finish or failed turn ended it first. */
function endedOnTheClock(
  loopRun: LoopRun,
  result: Partial<DelegateResult>,
  at: number,
  wrapCause: WrapCause | null,
): boolean {
  const { ctx, softDeadline, state } = loopRun;
  if (ctx.cancelled || state.limit || heldTurnEnding(result)) return false;
  if (wrapCause === WrapCause.Idle || wrapCause === WrapCause.Finish || wrapCause === WrapCause.Failed) return false;
  return at >= softDeadline - OUT_OF_TIME_MS;
}

/**
 * The run the lead left open: the harness closes it the way `finish` does — a web game's branch lands
 * when it passes its health check; a Loop in place closes there. A run a lost provider paused lands
 * nothing: Resume carries it on.
 */
export async function closeLeftOpen(
  loopRun: LoopRun,
  result: Partial<DelegateResult>,
  wrapCause: WrapCause | null = null,
  now: number = Date.now(),
): Promise<void> {
  const { ctx, state } = loopRun;
  const why = sessionEndWords(loopRun, result, now, wrapCause);
  const halted = loopRun.open?.halted;
  if (halted) return closeInPlace(loopRun, { victory: false, because: halted, paused: true });
  if (leadsOpenLoop(loopRun)) {
    const timeUp = !heldTurnEnding(result) && timeUpWithoutYes(loopRun, wrapCause);
    const because = timeUp ? OPEN_END.timeUpNoClaim : (openEndWords(loopRun, result, wrapCause) ?? why);
    return closeInPlace(loopRun, {
      victory: false,
      because,
      notDone: [],
      unchecked: timeUp && noClaimRead(state.finishTally),
      ...(timeUp ? { why: StopWhy.Time } : {}),
    });
  }
  const paused = Boolean(state.limit);
  await loopRun.closeTheLoopRun({
    land: !paused,
    paused,
    ...(endedOnTheClock(loopRun, result, now, wrapCause) ? { ended: StopWhy.Time } : {}),
    because: (landed: AnyRecord) =>
      ctx.cancelled
        ? why
        : `${why}; ${landed.ok ? "the integration branch was landed" : `nothing was landed (${landed.reason})`}`,
  });
}

/** A run that threw, in its report: the failure unless the user stopped it, and why it stopped. Answers whether it was a stop. */
function crashReport(loopRun: LoopRun, err: { kind?: unknown; message?: unknown } | null | undefined): boolean {
  const { ctx, report } = loopRun;
  const aborted = err?.kind === EngineFailure.Aborted || ctx.cancelled;
  if (!aborted) report.failure = { message: String(err?.message ?? err).slice(0, FAILURE_CHARS) };
  report.stoppedBecause = aborted ? "stopped by the user" : "the build hit a problem and stopped early";
  return aborted;
}

/** A run that threw before it closed: a sentence on the card, the message in the report; nothing landed. */
async function closeAfterCrash(loopRun: LoopRun, err: any): Promise<void> {
  if (loopRun.state.finished) return;
  if (leadsOpenLoop(loopRun)) {
    const halted = loopRun.open?.halted;
    if (halted) return closeInPlace(loopRun, { victory: false, because: halted, paused: true });
    if (!closeUnderWay(loopRun.state)) crashReport(loopRun, err);
    return closeInPlace(loopRun, { victory: false, because: String(loopRun.report.stoppedBecause) });
  }
  await latchClose(loopRun.state, async () => {
    const aborted = crashReport(loopRun, err);
    await closeRunPool(loopRun.run.runId);
    const why = aborted ? NotLandedReason.Stopped : NotLandedReason.Crashed;
    await loopRun.closeRun({ ok: false, reason: loopRun.report.stoppedBecause, why });
    return {};
  });
}

/** The user's window must not be left pointing into a worktree that is about to go: it is brought home first. */
async function bringTheWindowHome(loopRun: LoopRun): Promise<void> {
  const { ctx, integrationWorktree, run } = loopRun;
  const showing = await ctx.call(HostMethod.PreviewShowing, {}).catch(() => null);
  const inside =
    showing?.root === integrationWorktree || String(showing?.root).startsWith(`${integrationWorktree}${path.sep}`);
  if (showing?.root && inside) await ctx.call(HostMethod.PreviewLoad, { project: run.project }).catch(() => {});
}

/** The run is over: its pool settles, a web run's worktree goes (its head is on the run's ref), and the plugins hear it. */
async function tearDown(loopRun: LoopRun): Promise<void> {
  const { ctx, run } = loopRun;
  directors.delete(run.runId);
  await closeSettled(loopRun.state);
  await closeRunPool(run.runId);
  if (leadsOpenLoop(loopRun)) await settleRecovery(loopRun);
  else {
    await bringTheWindowHome(loopRun);
    await ctx
      .call(HostMethod.SnapshotRemoveWorktree, { project: run.project, path: loopRun.integrationWorktree })
      .catch(() => {});
  }
  await fireHooks(ctx, loopRun.game, HookEvent.RunEnd, runScope(loopRun));
  ctx.setStatus("idle");
}

/** The line the lead takes the chat on (live chat), open from the moment the run exists. */
function leadLine(loopRun: LoopRun): LeadLine {
  const { ctx, report, run, state, threadId } = loopRun;
  return openLeadLine(run.runId, threadId, () => !state.finished && !ctx.cancelled && !report.failure, ctx);
}

/** The wake loop's run, and the close of whatever its lead left open. */
async function wakeLoopRun(
  loopRun: LoopRun,
  talk: DirectorTalk,
  brief: () => string,
  line: LeadLine,
  clock: WakeClock,
) {
  const outcome = await runWakeLoop(loopRun, talk, brief, clock, line);
  await line.release();
  if (loopRun.state.finished) return;
  if (stoppedBeforeAnyTurn(loopRun)) return closeStoppedStart(loopRun);
  await closeLeftOpen(loopRun, outcome.failed ?? outcome.result, outcome.wrapCause, clock.now());
}

/** An open Loop the person stopped before any session of its lead's read its message this time. */
const stoppedBeforeAnyTurn = (loopRun: LoopRun): boolean =>
  leadsOpenLoop(loopRun) && loopRun.ctx.cancelled === true && !loopRun.open?.halted && !loopRun.open?.sessionWorked;

/** Seat the run's lead (director/lead-session.ts): the chat's own session when it can continue it. */
async function seatTheLead(loopRun: LoopRun): Promise<void> {
  const { ctx, journal, priorJournal, projectDir, run, threadId } = loopRun;
  const events = await ctx.call(HostMethod.EventsList, { threadId }).catch(() => []);
  loopRun.lead = leadSeat({ events, run, folder: projectDir, priorJournal });
  journal.director.lead = { chatSession: loopRun.lead.chatSession };
  await loopRun.saveJournal();
}

/** The run's host timings, a resumed run's earlier spans first, on its journal and its report. */
type HostTimings = { operationSpans?: OperationSpan[]; omittedSpans?: number };
function keepTimings(loopRun: LoopRun, timings: HostTimings): void {
  const prior = loopRun.priorJournal?.director?.hostTimings;
  const current = timings.operationSpans ?? [];
  if (Array.isArray(prior?.operationSpans)) {
    timings.operationSpans = [];
    timings.omittedSpans = Number(prior.omittedSpans) || 0;
    for (const span of [...prior.operationSpans, ...current]) retainSpan(timings, span);
  }
  loopRun.journal.director.hostTimings = timings;
  loopRun.report.hostTimings = timings;
}

/** The lead's tools and the dispatch of them: a web Loop's, or an open Loop's own. */
function seatTools(loopRun: LoopRun): LiveToolSpec[] {
  const open = loopRun.open;
  if (open) {
    const types = open.pool?.state.types ?? [];
    loopRun.afterTurn = () => openBetweenTurns(loopRun);
    directors.set(loopRun.run.runId, openHandler(loopRun));
    return openTools(types, { restart: restartsApp(loopRun.game), workers: open.pool?.state.allowed });
  }
  directors.set(loopRun.run.runId, (name, args) => loopRun.handler(name, args));
  return directorTools(loopRun.pool?.state.types ?? [], loopRun.pool?.state.allowed);
}

/** A start a plugin held back closes before any turn, saying why. */
async function closeHeldStart(loopRun: LoopRun, start: StartOfRun): Promise<void> {
  if (leadsOpenLoop(loopRun) && start.blocked) {
    const because = openStartHeld(start.blocked, loopRun.resume);
    const startHeld = !loopRun.resume && !holdOf(start.blocked);
    const end = { victory: false, because, keepNothing: true, unworked: true, paused: loopRun.resume, startHeld };
    return closeInPlace(loopRun, end);
  }
  await loopRun.closeTheLoopRun({ land: false, because: start.held ?? null });
}

/** A run the person stopped before its first turn closes as their stop. */
async function closeStoppedStart(loopRun: LoopRun): Promise<void> {
  if (!leadsOpenLoop(loopRun)) return closeLeftOpen(loopRun, {});
  const because = sessionEndWords(loopRun, {}, Date.now(), null);
  return closeInPlace(loopRun, { victory: false, because, keepNothing: true, unworked: true });
}

/** The run under its lead: its start, the lead's turns, the close of whatever it left open, and the teardown. */
async function leadTheRun(loopRun: LoopRun, talk: DirectorTalk, line: LeadLine, clock: WakeClock): Promise<void> {
  let looping = false;
  try {
    const start = await prepareTheStart(loopRun);
    if (start.held) {
      await line.release({ heardNone: true });
      await closeHeldStart(loopRun, start);
      return;
    }
    if (loopRun.ctx.cancelled) {
      await line.release({ heardNone: true });
      await closeStoppedStart(loopRun);
      return;
    }
    const brief = leadsOpenLoop(loopRun) ? await briefWriter(loopRun, start.notes) : await webBrief(loopRun, start);
    looping = true;
    await wakeLoopRun(loopRun, talk, brief, line, clock);
  } catch (err: any) {
    await line.release({ heardNone: !looping });
    await closeAfterCrash(loopRun, err);
  } finally {
    await line.release();
    await tearDown(loopRun);
  }
}

/** Mark the run's lead as preparing (lead-line.ts `expectLeadLine`): a message sent meanwhile waits for it. */
function expectLine(runId: string): () => void {
  return typeof leadLineParts.expectLeadLine === "function" ? leadLineParts.expectLeadLine(runId) : () => {};
}

/**
 * Run a Loop under its lead. Returns the report (also written as run_finished). A Loop on a project
 * that isn't a web game (`profile` Open) is led in place by the chat's own session and closes there.
 */
export async function runDirector(
  ctx: HarnessCtx,
  {
    threadId,
    run,
    resume = false,
    profile = LoopProfile.Web,
    clock: ownClock,
  }: { threadId: string; run: Run; resume?: boolean; profile?: LoopProfile; clock?: WakeClock },
): Promise<AnyRecord> {
  const open = profile === LoopProfile.Open;
  const clock = ownClock ?? (open ? OPEN_WALL_CLOCK : SYSTEM_CLOCK);
  const liveChat = servesLiveChat();
  const timings: HostTimings = {};
  let tracing: LoopRun | undefined;
  const measured = tracedContext(ctx, run, (span) =>
    retainSpan(timings, { ...span, goal: null, head: tracing?.state.integrationHead ?? null }),
  );
  const prepared = liveChat ? expectLine(run.runId) : () => {};
  let loopRun: LoopRun;
  try {
    loopRun = await prepareLoopRun(
      measured,
      { threadId, run, resume, liveChat, ...(open ? { profile, clock } : {}) },
      LOOP_RUN_MODULES,
    );
  } finally {
    prepared();
  }
  const refused = loopRun.open?.refused;
  if (refused) {
    await refuseResume(loopRun, refused, loopRun.open?.refusalPauses === true);
    return loopRun.report;
  }
  tracing = loopRun;
  loopRun.sleep = clock.sleep;
  keepTimings(loopRun, timings);
  await seatTheLead(loopRun);
  const tools = seatTools(loopRun);
  const talk = directorTalk(loopRun, referenceImages(run), tools);
  await leadTheRun(loopRun, talk, leadLine(loopRun), clock);
  return loopRun.report;
}

/**
 * The Loop: the lead's session, and optional workers it starts. The lead IS its chat's own session
 * (director/lead-session.ts), in the project's own folder, whatever the project is: it decides how to
 * work — plans or not, starts workers or not — and builds with its own hands. A worker gets a brief
 * and the lead's tools and works in a copy of the folder or in it, and `worker_mark used` merges a
 * copy's work in. A second opinion is the lead's to ask for (`judge`). The Loop closes in the folder
 * (director/open/).
 *
 * The session is driven by the wake loop (director/wake.ts): the lead ends its turn when it decides
 * to, and the studio wakes the same session with a message when something happens.
 */
import { plannerModel, roleEffort, RoleKey } from "./model-roles.ts";
import { closeSettled, closeUnderWay } from "./director/close-latch.ts";
import { fireHooks, HookEvent, hooksOn, runScope } from "./hooks.ts";
import { gatesOn } from "./builtin-hooks.ts";
import { gateLines, momentLines } from "./moment-lines.ts";
import { heldTurnEnding } from "./director/held-words.ts";
import { CoreFact, kindPending } from "./folder-facts.ts";
import { closeRunPool } from "./workers/run-pool.ts";
import { closeInPlace } from "./director/open/close.ts";
import { MESSAGE as END_WORDS, openEndWords } from "./director/open/finish.ts";
import { openBetweenTurns } from "./director/open/between.ts";
import { creditCapOf, OPEN_WALL_CLOCK, type OpenClock, restartsApp } from "./director/open/contract.ts";
import { appAtStart, settleRecovery } from "./director/open/app-look.ts";
import { openTools } from "./director/open/tool-specs.ts";
import { openHandler } from "./director/open/tools.ts";
import { HostMethod } from "./host-methods.ts";
import { appLanguage } from "./app-language.ts";
import { chatContext } from "./chat-session.ts";
import { folderLabelOf } from "./workers/identity.ts";
import { EngineFailure, engineLimitOf } from "./outage.ts";
import { isProviderLoss, noteProviderLoss, pauseDecision, pauseEnding } from "./provider-loss.ts";
import { CLIP_QUOTE } from "./text.ts";
import * as loopRunFunctions from "./director/loop-run.ts";
import { prepareLoopRun } from "./director/setup.ts";
import { directors } from "./director/tool-specs.ts";
import { resumedFromJournal } from "./director/journal.ts";
import { LOOP_WORDS } from "./director/wake-prompts.ts";
import { runWakeLoop } from "./director/wake.ts";
import { WrapCause } from "./director/wake-schedule.ts";
import { openLeadLine, type LeadLine } from "./director/lead-line.ts";
import { bookmarkLead, freshChat, leadSeat } from "./director/lead-session.ts";
import { retainSpan, type OperationSpan } from "./director/timing.ts";
import { tracedContext } from "./director/trace.ts";
import type { LoopRun } from "./director/loop-run.ts";
import type { TurnSaid } from "./director/news.ts";
import type { DirectorTalk } from "./director/wake.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";
import type {
  DelegateImage,
  DelegateResult,
  HarnessDelegateParams,
  LiveToolSpec,
  ReferenceFrame,
} from "../types/host-api.d.ts";

/** One message to the lead's session: its prompt, who wrote it, and Genex's lines beside it. */
type LeadAsk = Pick<HarnessDelegateParams, "prompt" | "from" | "notices">;

/** The run's modules, whose functions `bindLoopRun` puts on the run. */
const LOOP_RUN_MODULES = [loopRunFunctions];

/** How many reference stills the lead's first turn carries. */
const MAX_REFERENCE_IMAGES = 8;
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
 * One turn of the lead's session, on its own engine and model. The lead is its chat's own session: it
 * sits in the game folder (no `cwd`) and builds there (`root`), with the eyes its chat's turns have,
 * and its paid jobs are held to the credit cap its run record names.
 */
function delegateTurn(
  loopRun: LoopRun,
  images: DelegateImage[],
  tools: LiveToolSpec[],
  { prompt, from, notices }: LeadAsk,
  sessionId: string | null | undefined,
): Promise<DelegateResult> {
  const { ctx, lead, projectDir, run, threadId } = loopRun;
  const creditCap = creditCapOf(run);
  return ctx.call(HostMethod.EngineDelegate, {
    engine: run.engine,
    prompt,
    ...(from ? { from } : {}),
    ...(notices?.length ? { notices } : {}),
    // The chat's own context: the session it continues reads one system text, its cache kept.
    ...(loopRun.context ? { system: loopRun.context } : {}),
    project: run.project,
    threadId,
    ...(plannerModel(run) ? { model: plannerModel(run) } : {}),
    effort: roleEffort(run, RoleKey.Planner),
    preferences: run.preferences,
    ...(sessionId ? { resume: sessionId } : {}),
    ...(creditCap === null ? {} : { creditCap }),
    // The lead answers the chat while its build runs: what the person sends reaches its turn under way.
    ...(loopRun.waking ? { chatTurn: { messageId: run.runId } } : {}),
    // The eyes its chat's turns have (delegated-turn.ts `senses`): the same window of the game folder.
    ...(loopRun.open.seen ? { selfCapture: { project: run.project, root: projectDir, label: run.project } } : {}),
    director: {
      runId: run.runId,
      threadId,
      project: run.project,
      root: projectDir,
      tools,
      ...(lead ? { chatSession: true } : {}),
    },
    ...(images.length ? { images } : {}),
  });
}

/**
 * What one turn of the lead sends: its message as its sender wrote it, Genex's lines beside it — and
 * for a fresh lead session, which knows nothing of the chat it leads for, the chat so far first.
 */
async function leadAsk(
  loopRun: LoopRun,
  prompt: string,
  sid: string | null | undefined,
  said: TurnSaid | undefined,
): Promise<LeadAsk> {
  const chat = loopRun.lead && !sid ? await freshChat(loopRun.ctx, loopRun.threadId) : "";
  const notices = [chat, ...(said?.notices ?? [])].filter(Boolean);
  return { prompt, ...(said?.from ? { from: said.from } : {}), ...(notices.length ? { notices } : {}) };
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
    session: async (prompt, sid, said) => {
      try {
        const pictures = [...stillsFor(sid), ...(said?.images ?? [])];
        return await delegateTurn(loopRun, pictures, tools, await leadAsk(loopRun, prompt, sid, said), sid);
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

/** What the run stands on as its lead's first turn opens: what its start found, as lines. */
interface StartOfRun {
  notes: string[];
}

/**
 * What Genex's own gates found at the start (`web.ready`: a web page's missing files, by
 * `game.validate`'s typed list), asked only for a game a gate reaches; none for a game with no kind
 * yet, whose kind its lead picks first.
 */
async function gatesAtStart(loopRun: LoopRun): Promise<string[]> {
  const { ctx, open, run } = loopRun;
  const game = { name: run.project, facts: open.facts, holds: open.holds };
  if (kindPending(game) || gatesOn(HookEvent.RunPrepare, game).length === 0) return [];
  const readiness = await ctx.call(HostMethod.GameValidate, { project: run.project }).catch(() => null);
  return gateLines(HookEvent.RunPrepare, { game, missing: readiness?.missing });
}

/**
 * Every start is its lead's, fresh or resumed: the game's plugins prepare their apps first
 * (`run.prepare`), Genex's own gates look at the folder, and Genex looks once at the project's app
 * (`health`). What they found is what the lead reads first; nothing here holds the start back. A
 * Stop meanwhile says nothing: the caller reads it from `ctx.cancelled`.
 */
async function prepareTheStart(loopRun: LoopRun): Promise<StartOfRun> {
  const { ctx } = loopRun;
  if (ctx.cancelled) return { notes: [] };
  const prepared = await momentLines(ctx, loopRun.game, HookEvent.RunPrepare, runScope(loopRun));
  if (ctx.cancelled) return { notes: [] };
  const gated = await gatesAtStart(loopRun);
  const app = await appAtStart(loopRun);
  return { notes: [...prepared, ...gated, ...app] };
}

/**
 * The Loop's first lines to its lead: that it started (or resumed), with its goal as the chat's
 * session wrote it; then what its start found (the plugins' words, Genex's gates, the app's look).
 * The time the person asked for goes beside the first as each is sent (wake.ts, `withWorkLine`).
 */
function startLines(loopRun: LoopRun, start: StartOfRun): string[] {
  const { goal } = loopRun.run;
  const line = resumedFromJournal(loopRun) ? LOOP_WORDS.resumed(goal) : LOOP_WORDS.started(goal);
  return [line, ...start.notes];
}

/** Why the session ended, in the sentence the report keeps, when the Loop's own words name none (`openEndWords`). */
function sessionEndWords(loopRun: LoopRun, result: Partial<DelegateResult>): string {
  const { ctx, state } = loopRun;
  if (ctx.cancelled) return "stopped by the user";
  if (state.limit) return pauseEnding(state.limit.kind, String(state.limit.message).slice(0, CLIP_QUOTE));
  return heldTurnEnding(result) ?? END_WORDS.nothingAtWork;
}

/**
 * The run the lead left open — its turn ended with nothing at work, its wrap-up ended, or a lost
 * provider paused it: the harness closes it in place, as `finish` does. A run a lost provider or a
 * Stop paused keeps what it did for a Resume, and so does one whose lead's turn ended with nothing
 * at work: the person's next word that asks for more of its goal goes on with it.
 */
export async function closeLeftOpen(
  loopRun: LoopRun,
  result: Partial<DelegateResult>,
  wrapCause: WrapCause | null = null,
): Promise<void> {
  const halted = loopRun.open.halted;
  if (halted) return closeInPlace(loopRun, { victory: false, because: halted, paused: true });
  const because = openEndWords(loopRun, result, wrapCause) ?? sessionEndWords(loopRun, result);
  if (because === END_WORDS.nothingAtWork) return closeInPlace(loopRun, { victory: false, because, paused: true });
  return closeInPlace(loopRun, { victory: false, because, notDone: [] });
}

/** A run that threw, in its report: the failure unless the user stopped it, and why it stopped. */
function crashReport(loopRun: LoopRun, err: { kind?: unknown; message?: unknown } | null | undefined): void {
  const { ctx, report } = loopRun;
  const aborted = err?.kind === EngineFailure.Aborted || ctx.cancelled;
  if (!aborted) report.failure = { message: String(err?.message ?? err).slice(0, FAILURE_CHARS) };
  report.stoppedBecause = aborted ? "stopped by the user" : "the build hit a problem and stopped early";
}

/** A run that threw before it closed: a sentence on the card, the message in the report. */
async function closeAfterCrash(loopRun: LoopRun, err: any): Promise<void> {
  if (loopRun.state.finished) return;
  const halted = loopRun.open.halted;
  if (halted) return closeInPlace(loopRun, { victory: false, because: halted, paused: true });
  if (!closeUnderWay(loopRun.state)) crashReport(loopRun, err);
  return closeInPlace(loopRun, { victory: false, because: String(loopRun.report.stoppedBecause) });
}

/** The run is over: its pool settles, a look at the project's app under way ends, and the plugins hear it. */
async function tearDown(loopRun: LoopRun): Promise<void> {
  const { ctx, run } = loopRun;
  directors.delete(run.runId);
  await closeSettled(loopRun.state);
  await closeRunPool(run.runId);
  await settleRecovery(loopRun);
  await fireHooks(ctx, loopRun.game, HookEvent.RunEnd, runScope(loopRun));
  ctx.setStatus("idle");
}

/** The line the lead takes the chat on (live chat), open once its lead is seated. */
function leadLine(loopRun: LoopRun): LeadLine {
  const { ctx, report, run, state, threadId } = loopRun;
  return openLeadLine(run.runId, threadId, () => !state.finished && !ctx.cancelled && !report.failure, ctx);
}

/** The wake loop's run, and the close of whatever its lead left open. */
async function wakeLoopRun(
  loopRun: LoopRun,
  talk: DirectorTalk,
  start: readonly string[],
  line: LeadLine,
  clock: OpenClock,
) {
  const outcome = await runWakeLoop(loopRun, talk, start, clock, line);
  await line.release();
  if (loopRun.state.finished) return;
  if (stoppedBeforeAnyTurn(loopRun)) return closeStoppedStart(loopRun);
  await closeLeftOpen(loopRun, outcome.failed ?? outcome.result, outcome.wrapCause);
}

/** A Loop the person stopped before any session of its lead's read its message this time. */
const stoppedBeforeAnyTurn = (loopRun: LoopRun): boolean =>
  loopRun.ctx.cancelled === true && !loopRun.open.halted && !loopRun.open.sessionWorked;

/**
 * Seat the run's lead (director/lead-session.ts): the chat's own session, continued when it can be,
 * with the chat's own context as its system text.
 */
async function seatTheLead(loopRun: LoopRun): Promise<void> {
  const { ctx, journal, projectDir, run, threadId } = loopRun;
  const events = await ctx.call(HostMethod.EventsList, { threadId }).catch(() => []);
  loopRun.lead = leadSeat({ events, run, folder: projectDir });
  // The chat's own turns send the same text (delegated-turn.ts): one system text for the session.
  loopRun.context = chatContext({
    folderLabel: folderLabelOf(projectDir, run.project),
    appLanguage: await appLanguage(ctx),
  });
  journal.director.lead = { chatSession: true };
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

/** The lead's tools, and the dispatch of them. */
function seatTools(loopRun: LoopRun): LiveToolSpec[] {
  const types = loopRun.open.pool?.state.types ?? [];
  loopRun.afterTurn = () => openBetweenTurns(loopRun);
  directors.set(loopRun.run.runId, openHandler(loopRun));
  return openTools(types, {
    restart: restartsApp(loopRun.game),
    workers: loopRun.open.pool?.state.allowed,
    appSaved: hooksOn(loopRun.game, HookEvent.CheckpointBefore),
    cppRestart: (loopRun.gameFacts ?? []).some((fact) => fact.id === CoreFact.UnrealProject),
  });
}

/** A run the person stopped before its first turn closes as their stop. */
async function closeStoppedStart(loopRun: LoopRun): Promise<void> {
  const because = sessionEndWords(loopRun, {});
  return closeInPlace(loopRun, { victory: false, because, keepNothing: true, unworked: true });
}

/** The run under its lead: its start, the lead's turns, the close of whatever it left open, and the teardown. */
async function leadTheRun(loopRun: LoopRun, talk: DirectorTalk, line: LeadLine, clock: OpenClock): Promise<void> {
  try {
    const start = await prepareTheStart(loopRun);
    if (loopRun.ctx.cancelled) {
      await line.release();
      await closeStoppedStart(loopRun);
      return;
    }
    await wakeLoopRun(loopRun, talk, startLines(loopRun, start), line, clock);
  } catch (err: any) {
    await line.release();
    await closeAfterCrash(loopRun, err);
  } finally {
    await line.release();
    await tearDown(loopRun);
  }
}

/** Run a Loop under its lead, in the project's own folder. Returns the report (also written as run_finished). */
export async function runDirector(
  ctx: HarnessCtx,
  {
    threadId,
    run,
    resume = false,
    clock = OPEN_WALL_CLOCK,
  }: { threadId: string; run: Run; resume?: boolean; clock?: OpenClock },
): Promise<AnyRecord> {
  const timings: HostTimings = {};
  const measured = tracedContext(ctx, run, (span) => retainSpan(timings, { ...span, goal: null }));
  const loopRun = await prepareLoopRun(measured, { threadId, run, resume, clock }, LOOP_RUN_MODULES);
  keepTimings(loopRun, timings);
  await seatTheLead(loopRun);
  const talk = directorTalk(loopRun, referenceImages(run), seatTools(loopRun));
  await leadTheRun(loopRun, talk, leadLine(loopRun), clock);
  return loopRun.report;
}

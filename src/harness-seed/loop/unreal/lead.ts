/**
 * The Unreal Loop's lead: ONE session builds the whole game in the user's visible Unreal editor and
 * judges its own captures. The run prepares as before (C++ status, the editor, the Genex editor
 * helper, the template's facts), seats a fresh lead session by default, and then works in turns of
 * at most `TURN_MS`, resumed in the same session: the first opens with the brief, every later one
 * with a digest (time left, the owner's words, finished sub-agents, the last save point, the
 * critic's advice). Mid-turn the harness steers the owner's words at once, a finished sub-agent's
 * news, a save after `SAVE_STEER_MS` without one, a crash and its reopen, and the wrap-up at the
 * soft deadline (`lead-turn.ts`). Between turns it saves what the lead left unsaved
 * (`lead-between.ts`); at the end it settles the sub-agents (keeping every delivered file) and
 * closes the run. The Builds graph reads it as a director's run (`lead-graph.ts`).
 */
import path from "node:path";
import type { AnyRecord, HarnessCtx, Run } from "../../types/harness.d.ts";
import { loopRunClock } from "../director/journal.ts";
import { openLeadLine } from "../director/lead-line.ts";
import { type LeadSeat, leadSeat } from "../director/lead-session.ts";
import { directors } from "../director/tool-specs.ts";
import { factsOfGame } from "../folder-facts.ts";
import { engineOfGame, GameEngine } from "../game-engine.ts";
import { HostMethod } from "../host-methods.ts";
import { supportsSessions } from "../model-roles.ts";
import { appendRun, ExecutionStatus, JournalPhase, RunEvent, saveJournal, writeRunArtifact } from "../run-events.ts";
import { readJournal } from "../run-journal.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS, sleepUnlessCancelled } from "../time.ts";
import { settleAgents } from "./agents.ts";
import { cppSupport, readCppStatus } from "./cpp.ts";
import { betweenTurns, ensureEditor, recoverEditor } from "./lead-between.ts";
import { AgentPluginTool, LeadEndReason, type LeadJournal } from "./lead-contract.ts";
import { leadCloseOf, leadFinished, leadStarted, tellUser } from "./lead-graph.ts";
import {
  fromOlderLoop,
  type LeadClock,
  leadJournalOf,
  newLeadJournal,
  oneGitWrite,
  gameText,
  SNAPSHOT_SCOPE,
  saveLead,
  why,
} from "./lead-journal.ts";
import { unrealTool, unrealWrite } from "./lead-steps.ts";
import { CARRIED } from "./lead-prompts.ts";
import { leadToolHandler } from "./lead-tools.ts";
import { failedEnd, finishAsked, type LeadRun, leadEngine, leadTurn, RUN_ENDS, type RunEnd } from "./lead-turn.ts";
import { EditorHelperState, UnrealLivePluginTool, UnrealLoopTool } from "./live-contract.ts";
import { PROJECT_FACTS_FILE, projectFacts } from "./project-facts.ts";
import { closeEditor, sourceStamp } from "./restore.ts";
import { autosave, markLog } from "./save-point.ts";
import { TemplateKind, templateKind } from "./template-kind.ts";

export { SAVE_STEER_MS, TURN_MS, WRAP_UP_MS } from "./lead-turn.ts";

/** A run without its own budget gets one hour. */
const DEFAULT_RUN_MS = HOUR_MS;
/**
 * A turn that ends this soon, saving nothing, is a quick one; this many in a row and the lead has
 * nothing more to build. A short turn that made a save point is work (a lead may save every few
 * minutes and end its turn after each save).
 */
const QUICK_TURN_MS = 2 * MINUTE_MS;
const MAX_QUICK_TURNS = 3;
/** This many turns in a row the engine answered as failed end the run as failed. */
const MAX_FAILED_TURNS = 3;
/** A new turn needs at least this much of the run's working time. */
const MIN_TURN_MS = MINUTE_MS;
/** How many of the game's references the brief names, and how long each name may be. */
const MAX_REFERENCES = 24;
const REFERENCE_CHARS = 120;
/** A reference's name: one line of name characters. */
const NOT_NAME = /[^A-Za-z0-9 ._()-]/g;
/** How long a helper update waits for a closed editor's process to exit, asking this often. */
const EXIT_WAIT_MS = 60 * SECOND_MS;
const EXIT_POLL_MS = 2 * SECOND_MS;

const MESSAGE = {
  NotUnreal: "This game isn't linked to an Unreal project, so the Unreal Loop can't build it.",
  OutsideFolder:
    "This game's Unreal project lives outside its folder, so its save points couldn't be undone. Make a new Unreal game for the Loop.",
  NoSessions: (engine: string) =>
    `The Unreal Loop needs an engine that keeps a session (Claude Code or Codex); ${engine} doesn't, so nothing was built.`,
  NoHelper:
    "This game's Unreal project has no Genex editor helper, so the Loop can't save or capture it. Set the project up from the Unreal panel, then start the Loop again.",
  OlderLoop: "This run was made by an older Unreal Loop, which can't be resumed; start a new run.",
  TimeUp: "the run's time ran out",
  Idle: (turns: number) => `the lead ended ${turns} turns in a row within minutes: it had nothing more to build`,
  EngineFailed: (turns: number, why: string) => `the lead's engine failed ${turns} turns in a row: ${why}`,
  BeforeHelperUpdate: "Before Genex editor helper update",
  HelperUpdated: (to: string) => `Updated this game's Genex editor helper to ${to} before the Loop.`,
  HelperNotUpdated: (reason: string) =>
    `The Genex editor helper couldn't be updated (${reason}); the Loop goes on with it.`,
  NotSavedAtClose: (why: string) =>
    `Genex didn't save Unreal's last work as the Loop ended: ${why}. Save it in Unreal.`,
} as const;

// ── before the run ─────────────────────────────────────────────────────────────────────────────

/** Why this game can't run the Unreal Loop, or null when it can: linked, with its project inside its folder. */
function unrealProblem(game: AnyRecord | undefined): string | null {
  if (!game || engineOfGame(game) !== GameEngine.Unreal) return MESSAGE.NotUnreal;
  return insideFolder(String(game.dir ?? ""), String(game.engine?.project ?? "")) ? null : MESSAGE.OutsideFolder;
}

/** Whether `file` lies inside the folder `dir` (a game folder and its Unreal project). */
function insideFolder(dir: string, file: string): boolean {
  const inside = path.relative(dir, file);
  const below = inside !== "" && !inside.startsWith("..") && !path.isAbsolute(inside);
  return dir !== "" && below;
}

/** Why the lead's engine can't hold its session, or null when it can. */
async function sessionProblem(ctx: HarnessCtx, run: Run): Promise<string | null> {
  const described = await ctx.call(HostMethod.EngineDescribe, {}).catch(() => []);
  const { engine } = leadEngine({ run });
  return supportsSessions(described.find((e) => e.id === engine)) ? null : MESSAGE.NoSessions(engine);
}

/** The run's clock: the test's, or the wall clock with a wait that ends when the run is stopped. */
function clockOf(ctx: HarnessCtx, options: { now?: () => number; sleep?: (ms: number) => Promise<void> }): LeadClock {
  return { now: options.now ?? Date.now, sleep: options.sleep ?? ((ms) => sleepUnlessCancelled(ctx, ms)) };
}

/**
 * A fresh lead's seat: a new session in the game folder (the chat's own is never resumed for a
 * run), on the lead's engine and model, which the chat's bookmark follows so the chat carries on
 * from it afterwards.
 */
function freshSeat(run: Run, folder: string): LeadSeat {
  const { engine, model } = leadEngine({ run });
  return { ...leadSeat({ events: [], run, folder }), engine, model: model ?? null };
}

/** The lead's run object, before it prepares. */
function newLead(
  ctx: HarnessCtx,
  setup: { threadId: string; run: Run; clock: LeadClock; game: AnyRecord; journal: LeadJournal },
): LeadRun {
  const { threadId, run, clock, game, journal } = setup;
  const totalMs = Number(run.budgets?.wallClockMs) || DEFAULT_RUN_MS;
  const times = loopRunClock({ saved: journal.workedMs > 0 ? journal : null, now: clock.now(), totalMs });
  return {
    ctx,
    run,
    threadId,
    clock,
    game: { dir: String(game.dir), title: String(game.title || run.project), facts: factsOfGame(game) },
    journal: { ...journal, phase: JournalPhase.Director, run },
    ...times,
    template: "",
    templateKind: TemplateKind.Other,
    projectFile: String(game.engine?.project ?? ""),
    references: [],
    cpp: { available: false, why: "" },
    offers: { blender: false, genex: false },
    turn: null,
    halted: null,
    addModule: false,
    agentRuns: new Map(),
    saving: null,
    end: null,
    line: null,
    handover: null,
    heardCount: 0,
    pendingOwner: [],
    recovering: null,
    wrapUpSaid: false,
    replayChecked: false,
    workingSince: clock.now(),
    failure: null,
  };
}

/**
 * The template's facts the Genex editor helper exported, and which template it is. A project that
 * never exported them has the editor export them once.
 */
async function readTemplate(lead: LeadRun): Promise<void> {
  const command = `cat ${PROJECT_FACTS_FILE} 2>/dev/null || true`;
  let text = await gameText(lead, command);
  if (!projectFacts(text) && !lead.halted) {
    await unrealWrite(lead, UnrealLoopTool.ExportReference).catch(() => {});
    text = await gameText(lead, command);
  }
  lead.template = projectFacts(text);
  lead.templateKind = templateKind(text);
}

/** The game's `references/` files, by game-folder path: each name one line of name characters. */
async function readReferences(lead: LeadRun): Promise<string[]> {
  const listed = await gameText(lead, "ls -1 references 2>/dev/null || true");
  return listed
    .split("\n")
    .map((name) => name.replace(NOT_NAME, "").trim().slice(0, REFERENCE_CHARS))
    .filter(Boolean)
    .slice(0, MAX_REFERENCES)
    .map((name) => `references/${name}`);
}

/**
 * The plugin tools the lead's typed workers may be offered now (Local Blender's, and Genex Tools'
 * asset tool), and the worker types the plugins that are on declare for this game: a kind is on
 * offer only when one of them declares it. A host that could not list the types leaves them out.
 */
async function readOffers(lead: LeadRun): Promise<LeadRun["offers"]> {
  const { project } = lead.run;
  const plugins = await lead.ctx.call(HostMethod.PluginsTools, { project }).catch(() => null);
  const names = (plugins?.tools ?? []).map((tool) => String(tool?.name ?? ""));
  const declared = await lead.ctx.call(HostMethod.PluginsWorkerTypes, { project }).catch(() => null);
  return {
    blender: names.some((name) => name.startsWith(AgentPluginTool.Blender)),
    genex: names.includes(AgentPluginTool.GenexAsset),
    ...(Array.isArray(declared) ? { types: declared.map((type) => type.id) } : {}),
  };
}

/** A snapshot of the game folder, by its reason; its id. */
async function snapshot(lead: LeadRun, reason: string): Promise<string> {
  const made = await oneGitWrite(lead, () =>
    lead.ctx.call(HostMethod.SnapshotCreate, { scope: SNAPSHOT_SCOPE, reason, project: lead.run.project }),
  );
  return made.snapshot_id;
}

/**
 * The project's Genex editor helper, brought up to the plugin's before the first turn when it is
 * older: Unreal closed with its work saved (a save that fails leaves it open and the helper as it
 * was), a snapshot, the update, and Unreal reopened. A project with no helper at all halts the run.
 */
async function updateHelper(lead: LeadRun): Promise<void> {
  const state = (await unrealTool(lead, UnrealLoopTool.EditorState).catch(() => null)) as AnyRecord | null;
  if (state?.helper === EditorHelperState.Missing) lead.halted = MESSAGE.NoHelper;
  if (state?.helper !== EditorHelperState.Outdated) return;
  const closed = await closeEditor(lead);
  if (closed.ok) await processGone(lead);
  if (closed.ok) await snapshot(lead, MESSAGE.BeforeHelperUpdate).catch(() => "");
  const updated = closed.ok
    ? await unrealWrite(lead, UnrealLivePluginTool.UpdateHelper).catch((err: unknown) => ({ error: why(err) }))
    : { error: closed.why };
  const said = updated as AnyRecord;
  const line = said.error ? MESSAGE.HelperNotUpdated(String(said.error)) : MESSAGE.HelperUpdated(String(said.to));
  await tellUser(lead, line).catch(() => {});
  await ensureEditor(lead);
}

/**
 * Waits, up to EXIT_WAIT_MS, until the closed editor's process has exited: Unreal stops answering
 * before it is gone, and the helper's files can't be updated while it runs.
 */
async function processGone(lead: LeadRun): Promise<void> {
  const until = lead.clock.now() + EXIT_WAIT_MS;
  while (lead.clock.now() < until && !lead.ctx.cancelled) {
    const state = (await unrealTool(lead, UnrealLoopTool.EditorState).catch(() => null)) as AnyRecord | null;
    if (state?.running !== true) return;
    await lead.clock.sleep(EXIT_POLL_MS);
  }
}

/** What the run knows before its first turn: C++, the editor and its helper, the template, the plugins, the build, the log. */
async function prepare(lead: LeadRun): Promise<void> {
  lead.cpp = cppSupport(readCppStatus(await unrealTool(lead, UnrealLoopTool.CppStatus).catch(() => null)));
  await ensureEditor(lead);
  if (!lead.halted) await updateHelper(lead);
  await readTemplate(lead);
  lead.offers = await readOffers(lead);
  lead.references = await readReferences(lead);
  lead.journal.builtStamp ??= await sourceStamp(lead).catch(() => null);
  if (!lead.halted) await markLog(lead);
}

// ── the turns ──────────────────────────────────────────────────────────────────────────────────

/** Why the run ends before another turn, or null when one may start. */
async function endsNow(lead: LeadRun): Promise<RunEnd | null> {
  if (lead.halted) return RUN_ENDS.halted(lead.halted);
  if (lead.ctx.cancelled) return RUN_ENDS.stopped();
  if (await finishAsked(lead)) return RUN_ENDS.finished();
  const timeLeft = lead.softDeadline - lead.clock.now() >= MIN_TURN_MS;
  return timeLeft ? null : { status: ExecutionStatus.Completed, reason: LeadEndReason.TimeUp, why: MESSAGE.TimeUp };
}

/** Whether the lead asked for a rewind or a rebuild that its turn's end never ran (the run paused first). */
const betweenPending = (journal: LeadJournal): boolean => journal.between.rewind !== null || journal.between.rebuild;

/** Turns in a row so far: quick ones, and ones the engine failed. */
type TurnCount = { quick: number; failed: number };

/**
 * Counts the turn that just ended, and how the run ends because of it, or null: the engine failing
 * turn after turn ends it as failed, with why; quick turns in a row that saved nothing (a failed
 * one isn't counted) end it as idle.
 */
function turnCounted(lead: LeadRun, count: TurnCount, turn: { tookMs: number; saved: boolean }): RunEnd | null {
  if (lead.failure) {
    count.failed += 1;
    const failed = { status: ExecutionStatus.Failed, reason: LeadEndReason.Failed };
    return count.failed >= MAX_FAILED_TURNS
      ? { ...failed, why: MESSAGE.EngineFailed(count.failed, lead.failure) }
      : null;
  }
  count.failed = 0;
  const quick = turn.tookMs < QUICK_TURN_MS && !turn.saved;
  count.quick = quick ? count.quick + 1 : 0;
  const idle = { status: ExecutionStatus.Completed, reason: LeadEndReason.Idle, why: MESSAGE.Idle(count.quick) };
  return count.quick >= MAX_QUICK_TURNS ? idle : null;
}

/** The lead's turns, one after another with no gap, until the time is up or the run stops, pauses or halts. */
async function turns(lead: LeadRun): Promise<void> {
  const count: TurnCount = { quick: 0, failed: 0 };
  while (!lead.end) {
    lead.end = await endsNow(lead);
    if (lead.end) break;
    const started = lead.clock.now();
    const saves = lead.journal.savePoints.length;
    await leadTurn(lead, recoverEditor);
    if (lead.ctx.cancelled) lead.end ??= failedEnd(lead, null);
    const saved = lead.journal.savePoints.length > saves;
    lead.end ??= turnCounted(lead, count, { tookMs: lead.clock.now() - started, saved });
    await betweenTurns(lead, saved);
  }
}

// ── the start, the resume and the close ────────────────────────────────────────────────────────

/**
 * The run's work, start or resume to its last turn. Whatever throws on the way ends the run
 * instead of escaping it, so the close still saves, settles and reports the run.
 */
async function work(lead: LeadRun, resuming: boolean): Promise<void> {
  try {
    await prepare(lead);
    // A resumed run's clock goes on with the time it had left, and its lead hears it resumed; a
    // rewind or rebuild it asked for before the pause runs first, never over its next turn's work.
    if (resuming) lead.journal.digest.carried.push(CARRIED.Resumed);
    else await leadStarted(lead).catch(() => {});
    if (resuming && betweenPending(lead.journal)) await betweenTurns(lead, true);
    await saveLead(lead);
    await turns(lead);
  } catch (err) {
    lead.end ??= failedEnd(lead, err);
  }
}

/** The close's save of what the editor holds unsaved, never while a play session runs or may; the owner hears when it couldn't. */
async function closingSave(lead: LeadRun): Promise<void> {
  if (lead.halted) return;
  const saved = await autosave(lead).catch(() => null);
  if (saved && "skipped" in saved) await tellUser(lead, MESSAGE.NotSavedAtClose(saved.skipped)).catch(() => {});
}

/** The graph's own close, or nothing when it can't say. */
function graphClose(journal: LeadJournal): AnyRecord {
  try {
    return leadCloseOf(journal);
  } catch {
    return {};
  }
}

/** The run's report: what was saved and made, what it cost, and how it ended. */
function reportOf(lead: LeadRun, end: RunEnd): AnyRecord {
  const { journal, run, clock } = lead;
  return {
    runId: run.runId,
    project: run.project,
    goal: run.goal,
    engineGame: GameEngine.Unreal,
    landed: journal.savePoints.length > 0,
    savePoints: journal.savePoints.map(({ label, snapshotId, auto, milestoneId }) => ({
      label,
      snapshotId,
      auto,
      milestoneId,
    })),
    milestones: journal.milestones.map(({ id, title, rounds }) => ({ id, title, rounds })),
    agents: journal.agents.map((a) => ({ id: a.id, kind: a.kind, title: a.title, state: a.state })),
    crashes: journal.crashes.length,
    costUsd: Math.round(journal.cost.spent * 100) / 100,
    credits: journal.credits,
    ...graphClose(journal),
    finishedAt: new Date(clock.now()).toISOString(),
    durationMs: clock.now() - lead.started,
    executionStatus: end.status,
    endReason: end.reason,
    ...(end.why ? { stoppedBecause: end.why } : {}),
  };
}

/** The close: the work saved, the sub-agents settled (their deliveries kept), the report and the journal. */
async function closeLead(lead: LeadRun): Promise<AnyRecord> {
  const end = lead.end ?? { status: ExecutionStatus.Completed, reason: LeadEndReason.TimeUp, why: null };
  await closingSave(lead);
  await settleAgents(lead).catch(() => {});
  lead.journal.ends.push({ reason: end.reason, at: lead.clock.now(), words: end.why ?? "" });
  const paused = end.status === ExecutionStatus.Paused;
  const report = reportOf(lead, end);
  await leadFinished(lead, report, paused).catch(() => {});
  await saveLead(lead, paused ? JournalPhase.Paused : JournalPhase.Done);
  await writeRunArtifact(lead.ctx, lead.run.runId, "report.json", report);
  return report;
}

/** A run that ends before it starts: its close, with why. */
async function closeEarly(ctx: HarnessCtx, threadId: string, run: Run, reason: string): Promise<AnyRecord> {
  const report = {
    runId: run.runId,
    project: run.project,
    goal: run.goal,
    engineGame: GameEngine.Unreal,
    landed: false,
    executionStatus: ExecutionStatus.Completed,
    stoppedBecause: reason,
    finishedAt: new Date().toISOString(),
  };
  await appendRun(ctx, threadId, RunEvent.RunFinished, report);
  await writeRunArtifact(ctx, run.runId, "report.json", report);
  return report;
}

/** A Resume of a run the older Unreal Loop made: its journal closed for good, and the run closed with a plain line. */
async function closeOlder(ctx: HarnessCtx, threadId: string, run: Run, saved: AnyRecord): Promise<AnyRecord> {
  await saveJournal(ctx, threadId, run.runId, { ...saved, phase: JournalPhase.Done });
  return closeEarly(ctx, threadId, run, MESSAGE.OlderLoop);
}

/** What the run dispatch hands the lead: the run, whether it resumes, and a clock a test may make its own. */
export type LeadRunOptions = {
  threadId: string;
  run: Run;
  resume?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The Unreal Loop's lead over one run (run-dispatch.ts `RUNNERS[Unreal]`). `now` and `sleep` are the
 * clock and the wait (a test's own); the wait ends early when the run is stopped. `resume` picks the
 * run up from its journal; an older Unreal Loop's journal closes with a plain line. Answers the
 * run's report.
 */
export async function runUnrealLead(ctx: HarnessCtx, options: LeadRunOptions): Promise<AnyRecord> {
  const { threadId, run } = options;
  const clock = clockOf(ctx, options);
  const started = { goal: run.goal, project: run.project, budgets: run.budgets };
  await appendRun(ctx, threadId, RunEvent.RunStarted, started, { runId: run.runId });
  const games = (await ctx.call(HostMethod.GameList, undefined).catch(() => [])) as AnyRecord[];
  const game = games.find((g) => g.name === run.project);
  const problem = unrealProblem(game) ?? (await sessionProblem(ctx, run));
  if (problem || !game) return closeEarly(ctx, threadId, run, problem ?? MESSAGE.NotUnreal);
  const saved = options.resume ? await readJournal(ctx, threadId, run.runId) : null;
  if (saved && fromOlderLoop(saved)) return closeOlder(ctx, threadId, run, saved);
  const resumedJournal = leadJournalOf(saved);
  const journal = resumedJournal ?? newLeadJournal(run, freshSeat(run, String(game.dir)));
  const lead = newLead(ctx, { threadId, run, clock, game, journal });
  directors.set(run.runId, leadToolHandler(lead));
  lead.line = openLeadLine(run.runId, threadId, () => !lead.end && !ctx.cancelled, ctx);
  lead.line.attend();
  try {
    await work(lead, resumedJournal !== null);
    return await closeLead(lead);
  } finally {
    await lead.line.release();
    directors.delete(run.runId);
  }
}

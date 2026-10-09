/**
 * What the Unreal lead's run does with the editor outside the lead's own work, always cold: a
 * crash (Genex's health check blocked) runs Genex's crash moment, at which the plugin reopens
 * Unreal in place, and waits until health is quiet (twice at most); when it won't come back, the
 * game goes back to the last save point, never when Genex held the crash moment back (nothing was
 * tried in place, so the run halts and keeps the work). Between turns, a turn that left unsaved work and no save
 * point gets an autosave, then the lead's rewind or rebuild runs, then the game's C++ module a C++
 * agent asked for is added. What the lead should know of it is carried into its next digest. A run
 * whose Unreal can't be closed or reopened halts with why, in the words the plugin's steps gave.
 */
import { fireHooks, HookEvent, holdOf, REOPEN_WAIT_MS, runScope, waitReady } from "../hooks.ts";
import { HostMethod } from "../host-methods.ts";
import { minutes } from "../time.ts";
import { landPending, relandAgents } from "./agents.ts";
import { betweenHeldWords } from "./hold-words.ts";
import { cppSupport, ensureCppModule, readCppStatus, type CppSetup, whileAdding } from "./cpp.ts";
import type { LeadCrash, SavePoint } from "./lead-contract.ts";
import { tellUser } from "./lead-graph.ts";
import { oneGitWrite, SNAPSHOT_SCOPE, saveLead } from "./lead-journal.ts";
import { unrealTool, unrealWrite } from "./lead-steps.ts";
import { CARRIED, STEER } from "./lead-prompts.ts";
import type { LeadRun } from "./lead-turn.ts";
import { UnrealLoopTool } from "./live-contract.ts";
import { coldRestore, editorAnswers, editorGone, RestoreFailure, type RestoreOutcome, sourceStamp } from "./restore.ts";
import { autosave } from "./save-point.ts";

/** Reopening a crashed Unreal in place is tried this many times before the game goes back to its last save point. */
export const MAX_REOPENS = 2;
/** How a clock time is quoted to the lead: hours and minutes, UTC. */
const CLOCK_TIME = { start: 11, end: 16 } as const;

const MESSAGE = {
  EditorLost: (why: string) => `Unreal couldn't be reopened (${clause(why)}). Open Unreal, then Resume the Loop.`,
  NotSaved: (why: string) => `${clause(why)}. Save your work in Unreal, then Resume the Loop.`,
  NotClosed: (why: string) => `${clause(why)}. Quit Unreal, then Resume the Loop.`,
  TimedOut: (minutes: number) => `Unreal didn't answer within ${minutes} minutes of reopening`,
  NoSavePoint: "there is no save point to go back to",
  Restored: (label: string) => `Back to '${label}'`,
  Crashed: (at: string) => `Unreal crashed at ${at}; Genex reopened it.`,
  RestoredAfterCrash: (at: string, label: string) =>
    `Unreal crashed at ${at} and wouldn't reopen on the level as it was, so Genex went back to '${label}'.`,
} as const;

/** Words without the full stop they may end with, to go on in a sentence. */
function clause(words: string): string {
  return words.trim().replace(/[.]+$/, "");
}

/** Why the run halts when a restore or restart failed, in words the user can act on. */
export function haltedBy(outcome: Extract<RestoreOutcome, { ok: false }>): string {
  const held = outcome.held ? betweenHeldWords(outcome.held) : null;
  if (held) return held;
  if (outcome.failure === RestoreFailure.NotSaved) return MESSAGE.NotSaved(outcome.why);
  if (outcome.failure === RestoreFailure.NotEnded) return MESSAGE.NotClosed(outcome.why);
  return MESSAGE.EditorLost(outcome.why);
}

/** A time as the lead is told it. */
const clockTime = (ms: number) => new Date(ms).toISOString().slice(CLOCK_TIME.start, CLOCK_TIME.end);

/** The last save point with this label, or the last of all when none is named. */
function savePointOf(lead: LeadRun, label?: string): SavePoint | undefined {
  const points = lead.journal.savePoints;
  return label ? points.filter((point) => point.label === label).at(-1) : points.at(-1);
}

/**
 * Back to a save point, cold: Unreal saved, ended, the folder restored and Unreal reopened on it.
 * What sub-agents delivered lands again (a delivery is never taken back), and the game's C++
 * module is read again.
 */
async function restoreTo(lead: LeadRun, point: SavePoint): Promise<RestoreOutcome> {
  const restored = await coldRestore(lead, {
    snapshot: { id: point.snapshotId, label: MESSAGE.Restored(point.label) },
  });
  if (!restored.ok) return restored;
  lead.journal.between.rebuild = false;
  await relandAgents(lead).catch(() => {});
  await refreshCpp(lead);
  return restored;
}

/**
 * Genex's crash moment (the plugin reopens Unreal), then a wait until health is quiet; why it isn't,
 * or null. A crash moment Genex itself held back (Plan mode, a lock not given) reopened nothing:
 * no wait, and its hold goes with the failure for the person's words.
 */
async function reopenOnce(lead: LeadRun): Promise<Extract<RestoreOutcome, { ok: false }> | null> {
  const crash = await fireHooks(lead.ctx, lead.game, HookEvent.Crash, runScope(lead));
  const held = crash.blocked ? holdOf(crash.blocked) : null;
  if (crash.blocked && held) return { ok: false, failure: RestoreFailure.NotReopened, why: crash.blocked.reason, held };
  const timeout = lead.clock.now() + REOPEN_WAIT_MS;
  const ready = await waitReady(lead.ctx, lead.game, runScope(lead), lead.clock, Math.min(timeout, lead.finalDeadline));
  if (ready.ok || lead.ctx.cancelled) return null;
  const why = ready.timedOut ? MESSAGE.TimedOut(minutes(REOPEN_WAIT_MS)) : ready.reason;
  return { ok: false, failure: RestoreFailure.NotReopened, why };
}

/** Reopens Unreal in place, at most `MAX_REOPENS` times; the last failure, or null once it answers. */
async function reopenInPlace(lead: LeadRun): Promise<Extract<RestoreOutcome, { ok: false }> | null> {
  let last: Extract<RestoreOutcome, { ok: false }> | null = null;
  for (let tries = 0; tries < MAX_REOPENS && !lead.ctx.cancelled; tries += 1) {
    last = await reopenOnce(lead);
    if (!last) return null;
    // Held back by Genex: asking again at once is held back alike.
    if (last.held) return last;
  }
  return last;
}

/** A crash's record, on the journal and the owner's feed; the lead's words for it. */
async function recordCrash(lead: LeadRun, crash: LeadCrash, said: { lead: string; owner: string }): Promise<string> {
  lead.journal.crashes.push(crash);
  await tellUser(lead, said.owner).catch(() => {});
  await saveLead(lead);
  return said.lead;
}

/** The crash handled, start to end: reopened in place, else back to the last save point, else the run halts. */
async function recover(lead: LeadRun): Promise<string | null> {
  const at = lead.clock.now();
  const time = clockTime(at);
  const failed = await reopenInPlace(lead);
  const last = savePointOf(lead);
  if (!failed) {
    const said = { lead: STEER.Crashed(time, last?.label ?? null), owner: MESSAGE.Crashed(time) };
    return recordCrash(lead, { at, reopened: true, restoredTo: null }, said);
  }
  // A crash moment Genex held back never tried a reopen: going back to the save point would lose
  // the work since it for an editor nobody tried to reopen in place.
  const triedReopen = !failed.held;
  const restored = last && triedReopen && !lead.ctx.cancelled ? await restoreTo(lead, last) : null;
  if (last && restored?.ok) {
    const said = { lead: STEER.Restored(time, last.label), owner: MESSAGE.RestoredAfterCrash(time, last.label) };
    return recordCrash(lead, { at, reopened: false, restoredTo: last.label }, said);
  }
  lead.halted = haltedBy(restored && !restored.ok ? restored : failed);
  lead.journal.crashes.push({ at, reopened: false, restoredTo: null });
  await saveLead(lead);
  return null;
}

/**
 * Unreal is gone (Genex's health check blocked): reopened in place through Genex's crash moment, or
 * the game put back to its last save point when it won't reopen twice; a run whose Unreal can't
 * come back halts. Answers what the lead is told, or null (nothing to tell: another recovery is
 * under way, or the run halted).
 */
export async function recoverEditor(lead: LeadRun): Promise<string | null> {
  if (lead.recovering) {
    await lead.recovering;
    return null;
  }
  const running = recover(lead);
  lead.recovering = running;
  try {
    return await running;
  } finally {
    lead.recovering = null;
  }
}

/** The lead's rewind, between turns: back to the save point it named. */
async function rewind(lead: LeadRun, label: string): Promise<void> {
  const { between } = lead.journal;
  between.rewind = null;
  const point = savePointOf(lead, label);
  const restored = point ? await restoreTo(lead, point) : null;
  if (restored?.ok) {
    lead.journal.digest.carried.push(CARRIED.Rewound(label));
    return;
  }
  const reason = restored && !restored.ok ? restored.why : MESSAGE.NoSavePoint;
  lead.journal.digest.carried.push(CARRIED.NoRewind(label, reason));
  // A restore that ended Unreal and couldn't bring it back halts (health blocked); one that left a busy Unreal open doesn't.
  if (restored && !restored.ok && (await editorGone(lead))) lead.halted = haltedBy(restored);
}

/**
 * The lead's rebuild, between turns: Unreal closed, the game's C++ built and Unreal reopened. C++
 * that doesn't build sends the game back to its last save point.
 */
async function rebuild(lead: LeadRun): Promise<void> {
  lead.journal.between.rebuild = false;
  const rebuilt = await coldRestore(lead, { snapshot: null });
  if (rebuilt.ok) {
    lead.journal.digest.carried.push(CARRIED.Rebuilt);
    return;
  }
  const last = savePointOf(lead);
  const notBuilt = rebuilt.failure === RestoreFailure.NotReopened && last !== undefined;
  const restored = notBuilt && last ? await restoreTo(lead, last) : rebuilt;
  if (restored.ok && last) lead.journal.digest.carried.push(CARRIED.NotBuilt(rebuilt.why, last.label));
  else if (!restored.ok) lead.halted = haltedBy(restored);
}

/** Adding the game's C++ module, wired to this run: the plugin's tools, its clock, its feed and its snapshots. */
function cppSetup(lead: LeadRun): CppSetup {
  const { ctx, run } = lead;
  return {
    status: () => unrealTool(lead, UnrealLoopTool.CppStatus),
    add: () => unrealWrite(lead, UnrealLoopTool.AddCppModule),
    say: (line) => tellUser(lead, line).catch(() => {}),
    snapshot: (reason) =>
      oneGitWrite(lead, () =>
        ctx.call(HostMethod.SnapshotCreate, { scope: SNAPSHOT_SCOPE, reason, project: run.project }),
      ),
    now: () => lead.clock.now(),
    sleep: (ms) => lead.clock.sleep(ms),
    stopped: () => Boolean(ctx.cancelled),
    deadline: lead.finalDeadline,
    game: lead.game.title,
  };
}

/**
 * Adds the game's C++ module between turns when a C++ agent asked for it (Unreal restarts once).
 * Until the plugin is done adding it, nothing else touches the editor or the folder, even when the
 * run's wait gave up (`whileAdding`).
 */
export async function addModuleIfAsked(lead: LeadRun): Promise<void> {
  if (!lead.addModule) return;
  lead.addModule = false;
  const setup = cppSetup(lead);
  lead.cpp = await ensureCppModule(setup, lead.cpp, true);
  await whileAdding(setup, lead.cpp);
  lead.journal.builtStamp = await sourceStamp(lead).catch(() => lead.journal.builtStamp);
}

/** The game's C++ module read again after a restore, which may have taken it back out. */
export async function refreshCpp(lead: LeadRun): Promise<void> {
  if (!lead.cpp.available) return;
  const status = readCppStatus(await unrealTool(lead, UnrealLoopTool.CppStatus).catch(() => null));
  if (status) lead.cpp = cppSupport(status);
}

/** The turn left unsaved work and made no save point: the harness saves it (or says why it couldn't), and the lead hears so. */
async function autosaveAfter(lead: LeadRun): Promise<void> {
  const saved = await autosave(lead);
  if (!saved) return;
  const { carried } = lead.journal.digest;
  carried.push("point" in saved ? CARRIED.Autosaved(saved.point.label) : CARRIED.NotAutosaved(saved.skipped));
}

/**
 * What waits for the end of a turn, cold, before the next: Unreal back if Genex's health check
 * says it went away, an autosave when the turn made no save point, the lead's rewind or rebuild,
 * then the C++ module a C++ agent asked for (after a restore, so the restore never takes it back out).
 */
export async function betweenTurns(lead: LeadRun, savedInTurn: boolean): Promise<void> {
  if (lead.end || lead.ctx.cancelled) return;
  await lead.recovering;
  await lead.saving?.catch(() => {});
  if (await editorGone(lead)) {
    const said = await recoverEditor(lead);
    if (said) lead.journal.digest.carried.push(said);
  }
  if (lead.halted) return saveLead(lead);
  // A delivery git couldn't check out while the turn ran goes in now, before anything is saved.
  await landPending(lead).catch(() => {});
  if (!savedInTurn) await autosaveAfter(lead);
  const { between } = lead.journal;
  if (between.rewind) await rewind(lead, between.rewind);
  // A rebuild the lead asked for, or one a rewind's relanded C++ needs.
  if (between.rebuild && !lead.halted) await rebuild(lead);
  if (!lead.halted) await addModuleIfAsked(lead);
  await saveLead(lead);
}

/**
 * Kept for an older copy of a module that imports it (the plugin opens Unreal at Genex's run start
 * now): Unreal answers, or is restarted; a run whose Unreal can't be reopened halts.
 */
export async function ensureEditor(lead: LeadRun): Promise<void> {
  if (await editorAnswers(lead)) return;
  const opened = await coldRestore(lead, { snapshot: null });
  if (!opened.ok) lead.halted = haltedBy(opened);
}

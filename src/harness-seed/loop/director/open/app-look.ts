/**
 * The open Loop's looks at the project's app, where a plugin of the project watches it (`health`).
 * One as the Loop starts, fresh or resumed: why the app doesn't answer, or isn't ready yet, as a line
 * its lead reads first. Then the watch, while the Loop runs (its lead resting or at work), every
 * `HEALTH_POLL_MS`. A look only informs, once per change: an app that stops answering is one line
 * with its plugin's own reason (a build error names its file and line), which reaches a working lead
 * at its next step and wakes a resting one at once (`NoteKind.AppCrashed`); an app that answers again
 * is one line the lead is told with its next message (`NoteKind.Folder`). A step that is pending (an
 * app busy, loading or compiling, the person using it) says nothing. Genex never opens, reopens,
 * restarts or compiles the app, never takes the folder back and never pauses the Loop for it: what to
 * do about an app that stopped is the lead's (its plugin's tools, its own rewind or restart, its
 * pause for the person). What the start's look, and the wait after the lead's rewind or restart, saw
 * of the app is where the watch goes on from (`OpenLoop.appSeen`).
 * A look runs beside the wake loop, one at a time: a slow `health` step never holds up the reads of
 * the person's words. No look starts while the Loop is paused, closing or closed, while its lead's
 * finish is checked or while Genex's work between turns runs; one that ends after that says nothing,
 * and the teardown waits for it a while (`settleRecovery`).
 *
 * A module of its own: the modules around it may be ones an agent kept from before, and a kept copy
 * exports only what it did then, so the names the Loop newly needs for its looks come from here. The
 * watch moved here from `health.ts` (SEED_MOVES), which passes it on: a `health.ts` an agent kept
 * from before runs only under a kept caller from before.
 */
import { fireHooks, HookEvent, hooksOn, notesText, pendingLine, runScope } from "../../hooks.ts";
import { HostMethod } from "../../host-methods.ts";
import type { LoopRun } from "../loop-run.ts";
import { closeUnderWay, finishUnderWay } from "../close-latch.ts";
import { NoteKind } from "../wake-schedule.ts";
import { HEALTH_POLL_MS, OPEN_CLOSE_MS, type OpenLoop } from "./contract.ts";
import { APP_NEWS } from "./app-prompts.ts";
import { OPEN_NEWS } from "./prompts.ts";

/** What Genex last saw of the project's app (`OpenLoop.appSeen`): answering, or not. Never rename a value. */
export const AppSeen = { Up: "up", Down: "down" } as const;
export type AppSeen = (typeof AppSeen)[keyof typeof AppSeen];

/** How long the Loop's teardown waits for a look at the app under way to end, before its run ends anyway. */
const LOOK_SETTLE_MS = OPEN_CLOSE_MS / 2;

/**
 * One look at the project's app as the Loop starts: what its lead reads of it (the look's notes,
 * then why the app doesn't answer or isn't ready), nothing when it answers or no plugin watches it.
 * The look is the watch's baseline: its next one is due `HEALTH_POLL_MS` after it.
 */
export async function appAtStart(loopRun: LoopRun): Promise<string[]> {
  const { ctx, game, open } = loopRun;
  if (ctx.cancelled || !hooksOn(game, HookEvent.Health)) return [];
  const look = await fireHooks(ctx, game, HookEvent.Health, runScope(loopRun));
  open.healthAt = open.clock.now();
  if (ctx.cancelled) return [];
  const notes = notesText(look);
  if (look.blocked) {
    open.appSeen = AppSeen.Down;
    return [...notes, APP_NEWS.notAnswering(look.blocked.reason)];
  }
  if (look.pending) return [...notes, APP_NEWS.notReady(pendingLine(look.pending))];
  // Only an answer a step gave says the app answers: a look the host failed to ask says nothing of it.
  if (look.ran.length > 0) open.appSeen = AppSeen.Up;
  return notes;
}

/**
 * What the wait for the app after the lead's rewind or restart saw of it, which the lead hears with
 * that ask's line: the watch goes on from it, its next look due `HEALTH_POLL_MS` after, so it never
 * tells the lead again what that line said, nor counts a stop the lead's own ask left as the watch's.
 * A wait that ran out with a step still pending saw neither.
 */
export function sawAfterAsk(open: OpenLoop, ready: { ok: boolean; timedOut?: boolean }): void {
  open.healthAt = open.clock.now();
  if (ready.ok) open.appSeen = AppSeen.Up;
  else if (!ready.timedOut) open.appSeen = AppSeen.Down;
}

/**
 * Whether the run is closing or closed, stopped, refused, its lead's finish is checked, or Genex's work
 * between its lead's turns is under way: no look starts then, and one that ends then says nothing.
 */
const over = (loopRun: LoopRun): boolean =>
  loopRun.state.finished ||
  Boolean(loopRun.state.finish) ||
  closeUnderWay(loopRun.state) ||
  finishUnderWay(loopRun.state) ||
  loopRun.ctx.cancelled === true ||
  Boolean(loopRun.open.betweenTurns);

/**
 * Ends the lead's session under way in the folder, addressed to the session the host seated as this
 * run's lead in place: a call the host has not seated yet is missed, so the turn's watch says it
 * again while the Loop stays paused (`../news.ts`).
 */
export async function abortLead(loopRun: LoopRun): Promise<void> {
  const lead = { cwd: loopRun.projectDir, lead: loopRun.run.runId };
  await loopRun.ctx.call(HostMethod.EngineAbort, lead).catch(() => {});
}

/**
 * The app stopped answering: the lead hears the plugin's reason once, kept with the count of the stops
 * the watch saw (`run_status`'s `crashes`); a look that finds it still stopped says nothing more.
 */
export async function appStopped(loopRun: LoopRun, open: OpenLoop, why: string): Promise<void> {
  if (open.appSeen === AppSeen.Down) return;
  open.appSeen = AppSeen.Down;
  open.journal.crashes += 1;
  loopRun.note(APP_NEWS.notAnswering(why), NoteKind.AppCrashed);
  await loopRun.saveJournal().catch(() => {});
}

/** The app answers: the lead hears it with its next message when the watch last saw it stopped. */
function appAnswers(loopRun: LoopRun, open: OpenLoop): void {
  const stopped = open.appSeen === AppSeen.Down;
  open.appSeen = AppSeen.Up;
  if (stopped) loopRun.note(OPEN_NEWS.appAnswers, NoteKind.Folder);
}

/**
 * The look itself (the module's header): a block is an app that stopped, an answer a step gave is one
 * that answers; a pending step, or a look the host failed to ask, says nothing of it.
 */
async function lookAtApp(loopRun: LoopRun, open: OpenLoop): Promise<void> {
  const health = await fireHooks(loopRun.ctx, loopRun.game, HookEvent.Health, runScope(loopRun));
  if (over(loopRun)) return;
  if (health.blocked) return appStopped(loopRun, open, health.blocked.reason);
  if (!health.pending && health.ran.length > 0) appAnswers(loopRun, open);
}

/**
 * One look at the project's app, when it is due (every `HEALTH_POLL_MS`, only when a plugin hooks
 * `health`, never while a look runs, the Loop is paused or it closes), started beside the caller and
 * never awaited by it (`open.healthLook`).
 */
export function healthWatch(loopRun: LoopRun): void {
  const open = loopRun.open;
  if (!open || open.halted || open.healthLook || over(loopRun)) return;
  if (!hooksOn(loopRun.game, HookEvent.Health)) return;
  const now = open.clock.now();
  if (now - open.healthAt < HEALTH_POLL_MS) return;
  open.healthAt = now;
  const look = lookAtApp(loopRun, open)
    .catch(() => {})
    .finally(() => {
      if (open.healthLook === look) open.healthLook = null;
    });
  open.healthLook = look;
}

/**
 * The teardown's wait for a look at the app under way (which says nothing once the Loop closes), at
 * most `LOOK_SETTLE_MS` on the Loop's clock: the run's end never comes while Genex still asks the app,
 * as far as it can help it. Named for the recovery a `director.ts` from before waited for too.
 */
export async function settleRecovery(loopRun: LoopRun): Promise<void> {
  const look = loopRun.open.healthLook;
  if (!look) return;
  await Promise.race([look, loopRun.open.clock.sleep(LOOK_SETTLE_MS)]);
}

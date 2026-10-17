/**
 * What the boot tells the reborn agent (and the morning report) about a seed upgrade. Pure, so the
 * record StudioCore appends is the record the two renderers are tested against
 * (tests/conformance/seed-upgrade.test.ts).
 */
import { type SeedMoveNotice, type SeedUpgradeReport, SeedUpgradeMode } from "../substrate/seed-upgrade.ts";

export type SeedUpgradedPayload = Pick<SeedUpgradeReport, "added" | "updated" | "kept" | "retired"> & {
  moved?: SeedMoveNotice[];
};

/**
 * The `seed_upgraded` payload, or null when the boot changed nothing worth saying. Four outcomes,
 * not three (M4.8a): a seed file the studio no longer ships is RETIRED — backed up, taken out of
 * the install — and the morning report says which of its own pages the app took away, not only
 * which it added. `moved` is there only when a kept file was split from its callers.
 */
export function seedUpgradedPayload(report: SeedUpgradeReport | null): SeedUpgradedPayload | null {
  if (report?.mode !== SeedUpgradeMode.Upgraded) return null;
  const { added, updated, kept, retired, moved } = report;
  return { added, updated, kept, retired, ...(moved?.length ? { moved } : {}) };
}

/**
 * Memory keys the boot owns: one per kept file an upgrade split from its callers. The agent's
 * memory is in every prompt it builds (loop/prompt.ts), which no log event of the Studio thread
 * is, so this is where it learns that an edit it made no longer reaches every caller.
 */
export const SEED_MOVE_MEMORY_PREFIX = "app update moved code out of ";

/** The memory policy's limit on one value (harness-seed/memory/policy.ts `MAX_VALUE_CHARS`). */
const MAX_NOTE_CHARS = 300;

/** Memory keys the boot owns: one per kept file that still calls the host the older way (SEED_CALL_CHANGES). */
export const SEED_CALL_MEMORY_PREFIX = "app update changed host calls in ";

/** What the agent reads about a kept file that calls the host the older way (SEED_CALL_CHANGES), by file. */
const CALL_NOTES: Readonly<Record<string, string>> = {
  "loop/delegated-turn.ts":
    "Your edited loop/delegated-turn.ts was kept but calls the host the older way: turns end with Genex's checkpoint (endOfTurnCheckpoint) and fire moments (hooksOn), plugins.tools needs { project }, the brief takes facts, holds and kinds, and turns open workers (withChatWorkers) with ask: options.text.",
  "loop/main.ts":
    'Your edited loop/main.ts was kept, but it does not claim "workers" or route worker_tool to chatWorkerTool (loop/workers/chat-workers.ts), so the chat\'s session is offered no workers. Copy both from the shipped file.',
  "tools/index.ts":
    "Your edited tools/index.ts was kept, but its plugins.tools call names no project, so the host offers a web game's plugin tools whatever the game holds. Send { project: options.project ?? null } as the shipped copy does.",
  "loop/chat-dispatch.ts":
    "Your edited loop/chat-dispatch.ts was kept, but a Loop's launch makes a web game (ProjectStarter.Web), hands loopRunRefusal readiness?.missing, checks openLoopServed, promises a Loop in place in its words (openLaunchPromise) and starts the next one (startsNextOpenLoop, finishedInPlace). Copy them.",
  "loop/run-dispatch.ts":
    "Your edited loop/run-dispatch.ts was kept, but a kindless game needs startWebIfPending, the web gate is Genex's (fireGates), other projects run in place (loopProfileOf, SERVES_OPEN_LOOP), and a resume keeps its journal's kind (resumedProfile). Copy them from the shipped file.",
  "loop/prompt.ts":
    "Your edited loop/prompt.ts was kept, but a web game's rules now live in prompts/operating-rules-web.md, which it never reads, so a web game's turn misses them. Read that file for a web game, as the shipped copy does.",
  "loop/chat-session.ts":
    "Your edited loop/chat-session.ts was kept, but the brief reads facts and holds and tells a game with no kind to call start_web_game first (pendingKindRule), says when workers run (WORKERS_BRIEF_LINE), and names a Loop in place (loopProfileOf). Copy them from the shipped file.",
  "prompts/operating-rules.md":
    "Your edited prompts/operating-rules.md was kept, but a web game's rules (the preview, window.__studio, determinism) now live in prompts/operating-rules-web.md, read only for a web game: take them out of your copy, as the shipped copy does.",
  "loop/director/tool-specs.ts":
    "Your edited loop/director/tool-specs.ts was kept, but the director uses Genex's worker tools (WorkerTool: worker_wait, worker_mark whose note the person reads, worker_start's task, isolation and research) and finish takes proof for its reviewer. Copy them from the shipped file.",
  "loop/director/tools.ts":
    "Your edited loop/director/tools.ts was kept, but it may lack the workers' worker_mark, the pool's readers, waitingBuilders, the finish moment (HookEvent.Finish, finishCallOf), judgeTheLanding's judgeBy, or no new workers from the cap on (capRefusesWorker). Copy them from the shipped file.",
  "loop/director/reopen.ts":
    "Your edited loop/director/reopen.ts was kept, but a reopened Loop carries the earlier ask's reviewer count and reasons into the new one (freshTally), so it may stop after fewer than three no's. Copy freshTally and its use from the shipped file.",
  "loop/director.ts":
    "Your edited loop/director.ts was kept, but it may lack the run's moments (HookEvent.RunPrepare, RunEnd), what isn't done (notDoneOf, ranOutUnchecked), the close's latch (latchClose) or a Loop led in place (LoopProfile.Open, SERVES_OPEN_LOOP). Copy them from the shipped file.",
  "loop/director/wake-prompts.ts":
    "Your edited loop/director/wake-prompts.ts was kept, but it may name the old wait tool (worker_wait now) or tell a timed Loop's lead to finish only in the wrap-up: a claim may come as soon as the goal is reached (a reviewer's yes ends the build). Copy the wording from the shipped file.",
  "loop/director/briefs.ts":
    "Your edited loop/director/briefs.ts was kept, but it may name the old wait tool (worker_wait now), open a worker's brief without Genex's identity (builderIdentity), or tell a timed lead to finish only in the wrap-up (a reviewer's yes ends the build). Copy them from the shipped file.",
  "loop/director/workers.ts":
    "Your edited loop/director/workers.ts was kept, but it lacks its builders' worker grant (workerGrant), Genex's identity (runIdentity), the wait for room (withWorkerRoom), their records (recordBuilderStarted) or their moments (workerStartHooks, loop/hooks.ts). Copy them from the shipped file.",
  "loop/facet/phases/build.ts":
    "Your edited loop/facet/phases/build.ts was kept, but a builder delegates without its worker grant (worker: loop.options.worker), or reads a chat with no room for another writer as a broken build (withWorkerRoom, loop/workers/room.ts). Copy both from the shipped file.",
  "loop/director/setup.ts":
    "Your edited loop/director/setup.ts was kept, but a web scaffold needs kind: ProjectStarter.Web, sessions Genex's identity (runIdentity), the start workerRecords: true, the run hookEvents and the capped clock (capClock), and a Loop in place starts there (prepareOpenLoopRun, SERVES_OPEN_LOOP).",
  "loop/facet/phases/brief.ts":
    "Your edited loop/facet/phases/brief.ts was kept, but a director's facet worker does not open its brief with Genex's identity (withIdentity, loop/workers/identity.ts). Copy it from the shipped file.",
  "loop/director/wake.ts":
    "Your edited loop/director/wake.ts was kept, but it may miss rejected workers (rejectedNews), watchJobs, HookEvent.TurnStart, noteTurnEnds, closeUnderWay, the cap's lines (withCapWatch, withCapWords, turnEndAtCap) or a Loop in place (activeWork, TurnEnd.Continue, turnReturnedAt, SERVES_OPEN_LOOP).",
  "loop/director/wake-schedule.ts":
    "Your edited loop/director/wake-schedule.ts was kept, but it lacks a job end's kind (NoteKind.JobEnded), a Loop in place's turn cap and idle rule (TurnEnd.Continue, turn.worked), its news (NoteKind.WorkerAsks, AppCrashed, AppStopping) or SERVES_OPEN_LOOP. Copy them from the shipped file.",
  "loop/director/loop-run.ts":
    "Your edited loop/director/loop-run.ts was kept, but the run lacks jobsCursor, finishTally (the reviewer's no's so far) or a Loop in place's profile, record and clock (open?: OpenLoop, recordLoopRun with open?.clock.now()). Copy them from the shipped file.",
  "loop/director/journal.ts":
    "Your edited loop/director/journal.ts was kept, but it does not keep the run's job cursor (jobsCursor) or the reviewer's count (finishTally), so a resumed run hears its job ends again or forgets the no's. Copy recordLoopRun's and restoreLoopRun's lines from the shipped file.",
  "loop/director/integrate.ts":
    "Your edited loop/director/integrate.ts was kept, but its close skips the run's readers (closeReaders, workers/director-pool.ts), or its finish skips a claim's check, latch, proof or early claim (checkClaim, keepProofOut, latchClose, finishWaitsForCap). Copy them from the shipped file.",
  "loop/host-methods.ts":
    "Your edited loop/host-methods.ts was kept, but it lacks the host's newer methods (HooksFire, CheckpointTake, LocksHold, LocksRelease, ObserversCapture, FinishReview, FinishSettle), so moments, checkpoints, in-place workers, observers and finish checks fail. It is generated: copy the shipped file.",
  "loop/skillopt.ts":
    "Your edited loop/skillopt.ts was kept, but it learns from chat builds of projects that aren't web games: set aside a build observation of any game whose Loop works in place (loopProfileOf, loop/folder-facts.ts), as the shipped copy does.",
  "loop/reopen-run.ts":
    "Your edited loop/reopen-run.ts was kept, but it would reopen a finished Loop that worked in place, which has no copy to go on from: answer null for a journal with director?.open, and refuse it in reopenAfterReply (OPEN_LOOP_REFUSAL.notReopenable), as the shipped copy does.",
  "loop/launch-prompts.ts":
    "Your edited loop/launch-prompts.ts was kept, but it tells a project that isn't a web game of builders and judges: its Loop is led in place and a reviewer checks its finish (openBuildWords, loop/open-loop-prompts.ts). Copy launchRules from the shipped file.",
  "loop/studio-state.ts":
    "Your edited loop/studio-state.ts was kept, but it lacks the runners that refuse a Loop with words (RunnerKind.NeedsSession, RunnerKind.WebOnly) and SERVES_OPEN_LOOP, so a Loop on a project that isn't a web game is refused. Copy them from the shipped file.",
  "loop/after-loop-run.ts":
    "Your edited loop/after-loop-run.ts was kept, but after a Loop that worked in place it hands the chat a build to show and land that does not exist: mark such a run inPlace (journal director.open) and send it in runControls, as the shipped copy does.",
  "loop/after-loop-run-prompts.ts":
    "Your edited loop/after-loop-run-prompts.ts was kept, but after a Loop that worked in place it tells the chat to show or land a build it does not have: word its controls as run_status alone (inPlaceControls), as the shipped copy does.",
  "tools/game-tools.ts":
    "Your edited tools/game-tools.ts was kept, but new_game needs kind 'web', start_web_game (game.start) sends threadId: ctx.threadId so Plan holds it, and start_autopilot names no method and answers ∞ by the project's profile (untilDoneWords, OPEN_LAUNCH_WORDS). Copy them from the shipped file.",
};

/** The kept files whose `game.scaffold` call means a web game: a Loop's launch and its web runners. */
const SCAFFOLDS_WEB = new Set([
  "loop/chat-dispatch.ts",
  "loop/autopilot.ts",
  "loop/director/setup.ts",
  "loop/gauntlet.ts",
]);

/** The note for a kept file whose game.scaffold call names no kind: the host now makes that game empty. */
const SCAFFOLD_KIND_NOTE = (file: string) =>
  `Your edited ${file} was kept, but game.scaffold without kind now makes an empty folder with no kind. Send kind: ProjectStarter.Web (loop/folder-facts.ts) where a web game is meant, as the shipped copy does.`;

/** The note the agent reads about a kept file, and the error for a note about nothing. */
const MESSAGE = {
  noMoves: "seedMoveNote needs at least one move",
  callNote: (file: string) =>
    CALL_NOTES[file] ??
    (SCAFFOLDS_WEB.has(file) ? SCAFFOLD_KIND_NOTE(file) : undefined) ??
    `Your edited ${file} was kept, but it calls the host the older way. Compare its host calls with the shipped copy and carry the new ones over.`,
  moveNote: (from: string, where: readonly string[]) =>
    `Your edited ${from} was kept, but other harness files now import some of its code from a new home, so your edits to that code run only inside it. Carry them over to reach the rest. Moved: ${where.join("; ")}.`,
} as const;

/**
 * The note to the agent about one kept file, within the memory policy's limit: what to do first,
 * then where the code went (the callers are in the upgrade record, which has room for them).
 */
export function seedMoveNote(moves: readonly SeedMoveNotice[]): string {
  const [first] = moves;
  if (!first) throw new TypeError(MESSAGE.noMoves);
  const where = moves.map((move) => `${movedNames(move)} → ${move.to}`);
  const text = MESSAGE.moveNote(first.from, where);
  return text.length > MAX_NOTE_CHARS ? `${text.slice(0, MAX_NOTE_CHARS - 1)}…` : text;
}

/** The first name a move carried, and how many more went with it. */
function movedNames(move: SeedMoveNotice): string {
  const others = move.names.length - 1;
  return others > 0 ? `${move.names[0]} +${others}` : `${move.names[0]}`;
}

/**
 * The agent's memory with the boot's notes brought in step with `moved`: a note per kept file
 * that is split from its callers, and none for a file that no longer is. Every other entry is
 * the agent's and is returned as it was.
 */
export function seedMoveMemory(
  memory: Record<string, unknown>,
  moved: readonly SeedMoveNotice[],
): Record<string, unknown> {
  const next = Object.fromEntries(Object.entries(memory).filter(([key]) => !key.startsWith(SEED_MOVE_MEMORY_PREFIX)));
  const byFile = new Map<string, SeedMoveNotice[]>();
  for (const move of moved) byFile.set(move.from, [...(byFile.get(move.from) ?? []), move]);
  for (const [from, moves] of byFile) next[`${SEED_MOVE_MEMORY_PREFIX}${from}`] = seedMoveNote(moves);
  return next;
}

/**
 * The agent's memory with the boot's notes brought in step with `outdated`: a note per kept file
 * that still calls the host the older way, and none for a file that no longer does. Every other
 * entry is returned as it was.
 */
export function seedCallMemory(memory: Record<string, unknown>, outdated: readonly string[]): Record<string, unknown> {
  const next = Object.fromEntries(Object.entries(memory).filter(([key]) => !key.startsWith(SEED_CALL_MEMORY_PREFIX)));
  for (const file of outdated) next[`${SEED_CALL_MEMORY_PREFIX}${file}`] = MESSAGE.callNote(file);
  return next;
}

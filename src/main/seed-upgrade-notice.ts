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
  "loop/run-dispatch.ts":
    "Your edited loop/run-dispatch.ts was kept, but a Loop on a game with no kind yet needs the web starter first: call startWebIfPending (loop/folder-facts.ts) before the runner is chosen, as the shipped copy does.",
  "loop/prompt.ts":
    "Your edited loop/prompt.ts was kept, but a web game's rules now live in prompts/operating-rules-web.md, which it never reads, so a web game's turn misses them. Read that file for a web game, as the shipped copy does.",
  "loop/chat-session.ts":
    "Your edited loop/chat-session.ts was kept, but a new game starts empty: the brief reads facts and holds and tells a game with no kind to call start_web_game first (pendingKindRule), and a turn that runs workers says so (WORKERS_BRIEF_LINE). Copy both from the shipped file.",
  "prompts/operating-rules.md":
    "Your edited prompts/operating-rules.md was kept, but a web game's rules (the preview, window.__studio, determinism) now live in prompts/operating-rules-web.md, read only for a web game: take them out of your copy, as the shipped copy does.",
  "loop/director/tool-specs.ts":
    "Your edited loop/director/tool-specs.ts was kept, but the director now uses Genex's worker tools: wait is worker_wait, worker_mark is new (the person reads its note) and worker_start takes task, isolation and research (WorkerTool, loop/workers/contract.ts). Copy them from the shipped file.",
  "loop/director/tools.ts":
    "Your edited loop/director/tools.ts was kept, but it does not answer worker_mark or readers from the run's pool, never tells the lead a builder waits on the person (waitingBuilders), or finishes without the game's finish moment (HookEvent.Finish, loop/hooks.ts). Copy them from the shipped file.",
  "loop/director.ts":
    "Your edited loop/director.ts was kept, but the run's start and end are not announced to the game's plugins (HookEvent.RunPrepare, HookEvent.RunEnd with fireHooks, loop/hooks.ts). Copy prepareTheStart's and tearDown's lines from the shipped file.",
  "loop/director/wake-prompts.ts":
    "Your edited loop/director/wake-prompts.ts was kept, but it still names the director's old wait tool, which is worker_wait now. Copy the wording and the worker_wait filter from the shipped file.",
  "loop/director/briefs.ts":
    "Your edited loop/director/briefs.ts was kept, but it still names the director's old wait tool (worker_wait now), or a single worker's brief does not open with Genex's identity (builderIdentity). Copy both from the shipped file.",
  "loop/director/workers.ts":
    "Your edited loop/director/workers.ts was kept, but it lacks its builders' worker grant (workerGrant), Genex's identity (runIdentity), the wait for room (withWorkerRoom), their records (recordBuilderStarted) or their moments (workerStartHooks, loop/hooks.ts). Copy them from the shipped file.",
  "loop/facet/phases/build.ts":
    "Your edited loop/facet/phases/build.ts was kept, but a builder delegates without its worker grant (worker: loop.options.worker), or reads a chat with no room for another writer as a broken build (withWorkerRoom, loop/workers/room.ts). Copy both from the shipped file.",
  "loop/director/setup.ts":
    "Your edited loop/director/setup.ts was kept, but game.scaffold needs kind: ProjectStarter.Web for a web game, sessions open with Genex's identity (runIdentity), the start says workerRecords: true, and the run keeps the game's moments (hookEvents). Copy them from the shipped file.",
  "loop/facet/phases/brief.ts":
    "Your edited loop/facet/phases/brief.ts was kept, but a director's facet worker does not open its brief with Genex's identity (withIdentity, loop/workers/identity.ts). Copy it from the shipped file.",
  "loop/director/wake.ts":
    "Your edited loop/director/wake.ts was kept, but its digest still names rejected workers (rejectedNews), a resting lead never hears its job ends (watchJobs), or the lead's turns are not announced to the game's plugins (HookEvent.TurnStart, loop/hooks.ts). Copy them from the shipped file.",
  "loop/director/wake-schedule.ts":
    "Your edited loop/director/wake-schedule.ts was kept, but it has no kind for a job of the run that ended (NoteKind.JobEnded, which wakes the lead soon). Copy the kind and its NOTE_WAKE row from the shipped file.",
  "loop/director/loop-run.ts":
    "Your edited loop/director/loop-run.ts was kept, but its LoopRunState has no jobsCursor: where the run's job ends were read to, which the journal keeps. Copy the field from the shipped file.",
  "loop/director/journal.ts":
    "Your edited loop/director/journal.ts was kept, but it does not keep the run's job cursor (jobsCursor), so a resumed run hears its job ends again. Copy recordLoopRun's and restoreLoopRun's lines from the shipped file.",
  "loop/director/integrate.ts":
    "Your edited loop/director/integrate.ts was kept, but its close does not stop the run's readers (closeReaders, loop/workers/director-pool.ts). Copy the call from the shipped file.",
  "loop/host-methods.ts":
    "Your edited loop/host-methods.ts was kept, but it lacks the host's newer methods (HooksFire, CheckpointTake, LocksHold, LocksRelease), so Genex's moments, checkpoints and in-place workers fail. The file is generated: copy the shipped file.",
  "tools/game-tools.ts":
    "Your edited tools/game-tools.ts was kept, but game.scaffold without kind makes an empty folder: new_game needs kind 'web', and start_web_game (game.start) writes the web starter and sends threadId: ctx.threadId so Plan holds it. Copy them from the shipped file.",
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

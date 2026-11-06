/**
 * Genex's moments, as the harness announces them and asks for them. At a moment (a run starting,
 * a turn, a restart, a health check, the end) the plugins that are on run the steps they
 * hook to it for this game (`hooks.fire`); a checkpoint (`checkpoint.take`) runs their steps around
 * Genex's own snapshot. The harness never names a plugin's steps: it reads only what they answer
 * (a block, a note, a pending reason, pictures). A game whose descriptor lists no moment
 * (`hookEvents`) gets no call at all, so a game no plugin hooks behaves as it always did.
 *
 * A module of its own: the modules that call it may be ones an agent kept from before, and a kept
 * copy exports only what it did then, so every name the harness newly needs for its moments comes
 * from here. The vocabularies are copies of the app's (`shared/plugin-hooks.ts`), held equal by
 * `seed-contracts.test.ts`.
 */
import type { CheckpointAnswer, HookImage, HookReport } from "../types/host-api.d.ts";
import type { AnyRecord, HarnessCtx } from "../types/harness.d.ts";
import { HostMethod } from "./host-methods.ts";
import { isPlainRecord } from "./json.ts";
import { clip } from "./text.ts";
import { MINUTE_MS, SECOND_MS } from "./time.ts";
import { WORKER_TITLE_CHARS } from "./workers/contract.ts";

/** Genex's moments a plugin may hook (the app's `HookEvent`). Manifest values: never rename one. */
export const HookEvent = {
  RunPrepare: "run.prepare",
  RunEnd: "run.end",
  TurnStart: "turn.start",
  TurnEnd: "turn.end",
  CheckpointBefore: "checkpoint.before",
  CheckpointAfter: "checkpoint.after",
  RestoreBefore: "restore.before",
  RestoreAfter: "restore.after",
  WorkerStart: "worker.start",
  WorkerEnd: "worker.end",
  ToolBefore: "tool.before",
  ToolAfter: "tool.after",
  Health: "health",
  Crash: "crash",
  Finish: "finish",
} as const;
export type HookEvent = (typeof HookEvent)[keyof typeof HookEvent];

/**
 * The moments the harness itself announces: every one but the checkpoint and tool moments, which
 * Genex fires around its own work, and `crash`, which nobody fires (Genex never reopens an app by
 * itself: the lead does). A restore the harness announces is a restart: no file changes.
 */
export const SEED_FIRED_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set(
  Object.values(HookEvent).filter(
    (on) =>
      on !== HookEvent.CheckpointBefore &&
      on !== HookEvent.CheckpointAfter &&
      on !== HookEvent.ToolBefore &&
      on !== HookEvent.ToolAfter &&
      on !== HookEvent.Crash,
  ),
);

/**
 * The moments whose block refuses the call that asked for them (the app's `BLOCKING_HOOK_EVENTS`):
 * a restore, a plugin's own tool, the lead's finish. At any other moment a block is only a note.
 */
export const BLOCKING_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set([
  HookEvent.RestoreBefore,
  HookEvent.ToolBefore,
  HookEvent.Finish,
]);

/**
 * The name the host refuses a method it doesn't serve with (an older Genex; the app's
 * `HostRefusal.UnknownMethod`): never read from the message.
 */
export const UNKNOWN_METHOD = "UnknownMethod";

/** Whether a host call failed because this host doesn't serve the method at all: an older Genex, not a refusal. */
export function olderHost(err: unknown): boolean {
  return isPlainRecord(err) && (err as AnyRecord).name === UNKNOWN_METHOD;
}

/** Why a checkpoint asked only if something is unsaved was skipped (the app's `CheckpointSkip`). Never rename a value. */
export const CheckpointSkip = { NothingUnsaved: "nothing_unsaved", CantTell: "cant_tell" } as const;
export type CheckpointSkip = (typeof CheckpointSkip)[keyof typeof CheckpointSkip];

/** The code of the error a restore fails with when a plugin's step stopped it before any file changed (the app's `HOOK_BLOCKED`). */
export const HOOK_BLOCKED = "hook_blocked";

/**
 * Why Genex itself held a moment, a checkpoint or a restore back (the app's `HookHold`): the chat's
 * Plan mode, the person using what a lock guards, Genex unable to tell whether they were, or another
 * holder there. The person's line is worded from it, never from the reason, which is written for
 * agents. Never rename a value.
 */
export const HookHold = { Plan: "plan", PersonFirst: "person_first", CantTell: "cant_tell", Busy: "busy" } as const;
export type HookHold = (typeof HookHold)[keyof typeof HookHold];

/** What held something back: Genex's hold and the lock's label, when it was Genex's (a step's own block has neither). */
export type HookHeldBy = { hold?: unknown; label?: unknown };

/** The longest label a moment carries, a checkpoint's name or a turn's (the app's `HOOK_LABEL_CHARS`). */
export const HOOK_LABEL_CHARS = 120;
/** Characters a label or a worker's title may not carry to the host: control characters. */
const CONTROL_CHARS = /\p{Cc}/gu;

/** How often a wait until the game's apps are ready asks `health` again. */
export const READY_POLL_MS = 5 * SECOND_MS;
/** How long an app a plugin reopens (after a restore or a restart) may take to answer again. */
export const REOPEN_WAIT_MS = 6 * MINUTE_MS;
/** How long a chat waits for the game's apps after a turn changed what the project is (a first start can take long). */
export const READY_WAIT_MS = 20 * MINUTE_MS;

const MESSAGE = {
  Stopped: "the run was stopped",
  MomentStopped: "Stopped.",
  NoAnswer: "no answer",
  CheckpointFailed: (why: string) => `Genex couldn't take the checkpoint: ${why}`,
  MomentFailed: (why: string) => `Genex couldn't ask the game's plugins: ${why}`,
  TurnCheckpoint: "Unsaved work at the end of a chat turn",
  TurnSaved: "This turn left unsaved work, so Genex saved it and took a snapshot of the game.",
  TurnNotSaved: (why: string) => `This turn left unsaved work, and it stays unsaved: ${why}`,
  TurnWaitsForYou: (app: string) =>
    `This turn left unsaved work in ${app}, and it stays unsaved while you use it: save it there when you're done.`,
  TurnCantTell: (app: string) =>
    `This turn left unsaved work in ${app}, and it stays unsaved: Genex couldn't tell whether you were using ${app}. Save it there when you're done.`,
  TurnBusy: (app: string) =>
    `This turn left unsaved work in ${app}, and it stays unsaved: something else was working there. Save it in ${app}, or send a message to try again.`,
  TurnDiskOnly: "Genex took a snapshot of the files on disk.",
  TheApp: "the game's app",
  Unnamed: "Checkpoint",
} as const;

/** What a chat says while it waits for the game's apps to be ready, and when the wait ends without them. */
export const READY_WORDS = {
  stopped: "Stopped waiting. Send a message to go on once it's ready.",
  timedOut: (reason: string) =>
    `${reason} Genex stopped waiting after ${READY_WAIT_MS / MINUTE_MS} minutes: send a message to go on once it's ready.`,
  turnHeld: (reason: string) => `This message wasn't worked on: ${reason}`,
} as const;

/** What a chat says when Genex itself held its message back at the turn's start, by its hold. */
const TURN_HELD_WORDS = {
  [HookHold.PersonFirst]: (app: string) =>
    `This message wasn't worked on: you're using ${app}. Send it again once you're done there.`,
  [HookHold.CantTell]: (app: string) =>
    `This message wasn't worked on: Genex couldn't tell whether you were using ${app}. Send it again in a moment.`,
  [HookHold.Busy]: (app: string) =>
    `This message wasn't worked on: something else was working in ${app}. Send it again to try again.`,
  [HookHold.Plan]: () => "This message wasn't worked on: the chat is in Plan mode.",
} as const satisfies Record<HookHold, (app: string) => string>;

/**
 * The chat's line for a message held back at its turn's start: Genex's own hold in the person's
 * words, a step's block with its reason. Kept for a `delegated-turn.ts` an agent kept from before:
 * the seed's own chat turn is never held, and what its `turn.start` steps said is a notice its
 * session reads (`moment-lines.ts` `momentLines`).
 */
export function turnHeldLine(blocked: { reason: string } & HookHeldBy): string {
  const held = holdOf(blocked);
  if (!held) return READY_WORDS.turnHeld(blocked.reason);
  return TURN_HELD_WORDS[held.hold](held.label ?? MESSAGE.TheApp);
}

/** Genex itself, as the one that held a moment back (the app's): no plugin id is spelled with `@`. */
export const GENEX = "@genex";

/** A moment no step ran at. */
const EMPTY_REPORT: HookReport = Object.freeze({ blocked: null, pending: null, notes: [], images: [], ran: [] });

/** A game descriptor as `game.list` answers it: the moments its plugins hook (absent: none). */
export type HookedGame = { hookEvents?: unknown } | null | undefined;

/** Who a moment is for: the game, the chat and run it answers to, and what its steps are told. */
export type HookScope = {
  project: string;
  threadId?: string;
  runId?: string;
  turn?: string;
  label?: string;
  worker?: { id: string; title: string; type?: string };
};

/** A label as the host takes it: control characters as spaces, trimmed, within the cap; empty when nothing is left. */
export function hookLabel(text: string): string {
  return clip(text.replace(CONTROL_CHARS, " ").trim(), HOOK_LABEL_CHARS).trim();
}

/** A moment's scope with its turn and label on one line within the cap (dropped when nothing is left of one). */
function plainScope(scope: HookScope): HookScope {
  const { turn, label, ...rest } = scope;
  const plainTurn = turn ? hookLabel(turn) : "";
  const plainLabel = label ? hookLabel(label) : "";
  return { ...rest, ...(plainTurn ? { turn: plainTurn } : {}), ...(plainLabel ? { label: plainLabel } : {}) };
}

/** Whether the game's plugins hook a moment, as its descriptor lists them. */
export function hooksOn(game: HookedGame, on: HookEvent): boolean {
  const events = game?.hookEvents;
  return Array.isArray(events) && events.includes(on);
}

/** The scope of a run's moment: its game, chat and run. */
export function runScope(lead: { run: { project: string; runId: string }; threadId: string }): HookScope {
  return { project: lead.run.project, threadId: lead.threadId, runId: lead.run.runId };
}

/** The host's answer read as a report: anything else is a moment no step ran at. */
function reportOf(answer: unknown): HookReport {
  if (!isPlainRecord(answer)) return EMPTY_REPORT;
  const notes = Array.isArray(answer.notes) ? answer.notes.filter(isPlainRecord) : [];
  return {
    blocked: isPlainRecord(answer.blocked) ? (answer.blocked as HookReport["blocked"]) : null,
    pending: isPlainRecord(answer.pending) ? (answer.pending as HookReport["pending"]) : null,
    notes: notes as HookReport["notes"],
    images: Array.isArray(answer.images) ? (answer.images.filter(isPlainRecord) as HookImage[]) : [],
    ran: Array.isArray(answer.ran) ? answer.ran.map(String) : [],
  };
}

/**
 * Announces one moment for a game: its plugins' steps run in order and their answers come back.
 * No call when the game's plugins hook no step there; a host without Genex's moments answers as
 * a moment no step ran at. Any other failure refuses a blocking moment's call with why (fail
 * closed, as the host does), and is Genex's note at any other moment, which its reader decides on.
 * A moment the chat's or the run's Stop ended refuses a blocking moment's call as stopped, never as
 * a plugin's failure, and is a moment no step ran at elsewhere: the caller reads the Stop from
 * `ctx.cancelled`.
 */
export async function fireHooks(
  ctx: HarnessCtx,
  game: HookedGame,
  on: HookEvent,
  scope: HookScope,
): Promise<HookReport> {
  if (!hooksOn(game, on)) return EMPTY_REPORT;
  try {
    return reportOf(await ctx.call(HostMethod.HooksFire, { ...plainScope(scope), on }));
  } catch (err) {
    if (olderHost(err)) return EMPTY_REPORT;
    const blocking = BLOCKING_HOOK_EVENTS.has(on);
    if (ctx.cancelled) return blocking ? heldReport(MESSAGE.MomentStopped) : EMPTY_REPORT;
    const reason = MESSAGE.MomentFailed(err instanceof Error ? err.message : String(err));
    return blocking ? heldReport(reason) : { ...EMPTY_REPORT, notes: [{ plugin: GENEX, text: reason }] };
  }
}

/** A moment Genex itself held back, with why: no step ran. */
function heldReport(reason: string): HookReport {
  return { ...EMPTY_REPORT, blocked: { plugin: GENEX, tool: "", reason } };
}

/** What a checkpoint is asked for: its name, and whether only when something is unsaved. */
export type CheckpointAsk = HookScope & { label: string; onlyIfUnsaved?: boolean };

/**
 * A checkpoint of the game folder: the plugins' steps before, Genex's snapshot, their steps after.
 * Answers the snapshot with the steps' notes and pictures, why it was stopped, or why it was skipped.
 */
export async function takeCheckpoint(ctx: HarnessCtx, ask: CheckpointAsk): Promise<CheckpointAnswer> {
  try {
    const { onlyIfUnsaved, label: named, ...scope } = ask;
    const label = hookLabel(named) || MESSAGE.Unnamed;
    const params = { ...plainScope(scope), label, ...(onlyIfUnsaved ? { onlyIfUnsaved } : {}) };
    const answer = (await ctx.call(HostMethod.CheckpointTake, params)) as CheckpointAnswer | null;
    if (isPlainRecord(answer)) return answer as CheckpointAnswer;
    return { blocked: MESSAGE.CheckpointFailed(MESSAGE.NoAnswer) };
  } catch (err) {
    if (ctx.cancelled) return { blocked: MESSAGE.MomentStopped };
    return { blocked: MESSAGE.CheckpointFailed(err instanceof Error ? err.message : String(err)) };
  }
}

/** Whether a host call failed because a plugin's step (or Genex's hold) stopped the restore before any file changed. */
export function hookBlocked(err: unknown): err is Error & { reason?: string } & HookHeldBy {
  return isPlainRecord(err) && (err as AnyRecord).code === HOOK_BLOCKED;
}

/** Genex's hold of something held back, or null when a step blocked it (or the hold is one this harness doesn't know). */
export function holdOf(held: HookHeldBy): { hold: HookHold; label: string | null } | null {
  const hold = Object.values(HookHold).find((value) => value === held.hold);
  if (!hold) return null;
  const label = typeof held.label === "string" && held.label.trim() ? held.label.trim() : null;
  return { hold, label };
}

/** What a chat says while Genex itself keeps the game's apps from being ready (a lock not given at `health`), by its hold. */
const READY_HELD_WORDS = {
  [HookHold.PersonFirst]: (app: string) => `Waiting for you to finish in ${app}.`,
  [HookHold.CantTell]: (app: string) => `Genex couldn't tell whether you were using ${app}.`,
  [HookHold.Busy]: (app: string) => `Something else was working in ${app}.`,
  [HookHold.Plan]: () => "The chat is in Plan mode.",
} as const satisfies Record<HookHold, (app: string) => string>;

/** What the person reads when Genex itself skipped a step at a moment that only notes it, by its hold. */
const NOTE_HELD_WORDS = {
  [HookHold.PersonFirst]: (app: string) => `Genex skipped a step of the game's plugins while you were using ${app}.`,
  [HookHold.CantTell]: (app: string) =>
    `Genex skipped a step of the game's plugins: it couldn't tell whether you were using ${app}.`,
  [HookHold.Busy]: (app: string) => `Genex skipped a step of the game's plugins: something else was working in ${app}.`,
  [HookHold.Plan]: () => "Genex skipped a step of the game's plugins: the chat is in Plan mode.",
} as const satisfies Record<HookHold, (app: string) => string>;

/** Why the game's apps aren't ready yet, for the person: Genex's own hold in their words, a step's reason as given. */
export function pendingLine(pending: { reason: string } & HookHeldBy): string {
  const held = holdOf(pending);
  return held ? READY_HELD_WORDS[held.hold](held.label ?? MESSAGE.TheApp) : pending.reason;
}

/** The notes a moment's steps added, as lines: one Genex added for its own hold in the person's words. */
export function notesText(report: Pick<HookReport, "notes">): string[] {
  return report.notes
    .map((note) => {
      const held = holdOf(note as HookHeldBy);
      return held ? NOTE_HELD_WORDS[held.hold](held.label ?? MESSAGE.TheApp) : String(note.text ?? "");
    })
    .filter(Boolean);
}

/**
 * How a wait until the game's apps are ready ended: ready, or why not, whether its time ran out, and
 * whether Genex itself was holding them back (the person using the app) when it did.
 */
type ReadyOutcome = { ok: true } | { ok: false; reason: string; timedOut: boolean; held?: boolean };

/** The clock a wait runs on: a test's own, or the run's. */
export type ReadyClock = { now: () => number; sleep: (ms: number) => Promise<void> };

/**
 * Asks `health` until the game's apps are ready: ready once no step says it is pending, not once a
 * step blocks (it can't come back by itself), or once `until` passes with a step still pending.
 * The run's Stop ends the wait, never read as ready, and so does `stopped` (its caller closing).
 */
export async function waitReady(
  ctx: HarnessCtx,
  game: HookedGame,
  scope: HookScope,
  clock: ReadyClock,
  until: number,
  stopped: () => boolean = () => false,
): Promise<ReadyOutcome> {
  for (;;) {
    if (stopped()) return { ok: false, reason: MESSAGE.Stopped, timedOut: false };
    const health = await fireHooks(ctx, game, HookEvent.Health, scope);
    // A Stop first: a health check the Stop cut short answers as no step ran, never as ready.
    if (ctx.cancelled || stopped()) return { ok: false, reason: MESSAGE.Stopped, timedOut: false };
    if (health.blocked) return { ok: false, reason: health.blocked.reason, timedOut: false };
    if (!health.pending) return { ok: true };
    if (clock.now() >= until) {
      const held = holdOf(health.pending) !== null;
      return { ok: false, reason: pendingLine(health.pending), timedOut: true, ...(held ? { held } : {}) };
    }
    await clock.sleep(READY_POLL_MS);
  }
}

/** A chat turn's own moment, as its end checkpoint is asked for: its game and chat, and whether a run's. */
export type ChatTurnScope = { project: string; threadId: string; runId?: string | null };

/**
 * Genex's rule for a chat's own turn (never a run's) on a game whose plugins hook the checkpoint:
 * it ends with a checkpoint taken only if something is unsaved. Answers the chat's line: what was
 * saved, with the steps' notes; why it stays unsaved (also when Genex skipped the steps and took
 * the snapshot of the files on disk alone); or null when nothing was taken or said.
 */
export async function endOfTurnCheckpoint(
  ctx: HarnessCtx,
  turn: ChatTurnScope,
  game: HookedGame,
): Promise<string | null> {
  if (turn.runId) return null;
  if (!hooksOn(game, HookEvent.CheckpointBefore) && !hooksOn(game, HookEvent.CheckpointAfter)) return null;
  const ask = { project: turn.project, threadId: turn.threadId, label: MESSAGE.TurnCheckpoint, onlyIfUnsaved: true };
  const answer = await takeCheckpoint(ctx, ask);
  if ("skipped" in answer) return null;
  if ("blocked" in answer) return turnNotSaved(answer);
  // A snapshot Genex took alone carries its hold as a note: the app's work stays unsaved.
  const alone = answer.notes.map((note) => holdOf(note as HookHeldBy)).find(heldByApp);
  if (alone) return `${unsavedWhileHeld(alone)} ${MESSAGE.TurnDiskOnly}`;
  return [MESSAGE.TurnSaved, ...notesText(answer)].join(" ");
}

/**
 * The chat's line for a turn's work that stays unsaved: Genex's own hold in the person's words
 * (Plan mode says nothing, as a planning turn always did), a step's block with its reason.
 */
function turnNotSaved(answer: { blocked: string } & HookHeldBy): string | null {
  const held = holdOf(answer);
  if (!held) return MESSAGE.TurnNotSaved(answer.blocked);
  if (held.hold === HookHold.Plan) return null;
  return unsavedWhileHeld(held);
}

/** Genex's own hold, read (`holdOf`): why, and the lock's label. */
type HeldRead = { hold: HookHold; label: string | null };

/** Whether Genex held a step back for its app (the person, Genex unsure, another holder), not for Plan mode. */
function heldByApp(held: HeldRead | null): held is HeldRead {
  return held !== null && held.hold !== HookHold.Plan;
}

/** Why a turn's work stays unsaved in the app while Genex held its steps back, in the person's words. */
function unsavedWhileHeld(held: HeldRead): string {
  const app = held.label ?? MESSAGE.TheApp;
  if (held.hold === HookHold.CantTell) return MESSAGE.TurnCantTell(app);
  return held.hold === HookHold.Busy ? MESSAGE.TurnBusy(app) : MESSAGE.TurnWaitsForYou(app);
}

/** The worker a worker moment is about: its id, title and kind. */
export type HookWorker = { id: string; title: string; type?: string | null };

/** The worker as a moment's scope names it: a plain title within the host's cap, a kind only when it has one. */
function workerOf(worker: HookWorker): HookScope["worker"] {
  const title = clip(worker.title.replace(CONTROL_CHARS, " ").trim(), WORKER_TITLE_CHARS) || worker.id;
  return { id: worker.id, title, ...(worker.type ? { type: worker.type } : {}) };
}

/**
 * Announces a worker's start before anything of it is written, and answers null: no step holds a
 * worker back. Kept for a `workers/pool-start.ts` an agent kept from before, which read a reason
 * here; the seed's own reads what the steps said (`moment-lines.ts` `workerMomentLines`).
 */
export async function workerStartHooks(
  ctx: HarnessCtx,
  game: HookedGame,
  scope: HookScope,
  worker: HookWorker,
): Promise<string | null> {
  await fireHooks(ctx, game, HookEvent.WorkerStart, { ...scope, worker: workerOf(worker) });
  return null;
}

/** Announces a worker's end once its end is written; nothing a step answers changes it. */
export async function workerEndHooks(
  ctx: HarnessCtx,
  game: HookedGame,
  scope: HookScope,
  worker: HookWorker,
): Promise<void> {
  await fireHooks(ctx, game, HookEvent.WorkerEnd, { ...scope, worker: workerOf(worker) });
}

/**
 * What Genex's moments tell whoever reads them, as lines: the notes the game's plugins' steps added
 * (Genex's own hold in the person's words), the reason of one of Genex's own gates, and a worker's
 * moments. A moment that answers no call holds nothing back: what a step found is a line its reader
 * (a Loop's lead, a chat's own session, `worker_start`'s caller) reads and decides on. Only a call's
 * own moment (`BLOCKING_HOOK_EVENTS`: a restore, a plugin's own tool, the lead's finish) refuses it,
 * and its caller reads that block, never these lines.
 *
 * A module of its own, built only on names `hooks.ts` and `builtin-hooks.ts` exported before it:
 * the modules around it may be ones an agent kept from before, and a kept copy exports only what it
 * did then, so every name the seed newly needs for its moments' lines comes from here.
 */
import type { HookReport } from "../types/host-api.d.ts";
import type { HarnessCtx } from "../types/harness.d.ts";
import { fireGates, type GateInput } from "./builtin-hooks.ts";
import {
  fireHooks,
  type HookedGame,
  type HookEvent,
  type HookScope,
  type HookWorker,
  hookLabel,
  notesText,
} from "./hooks.ts";
import { clip } from "./text.ts";
import { WORKER_TITLE_CHARS } from "./workers/contract.ts";

/** A block read as a note: its step and reason, and Genex's hold when it was Genex's. */
function blockAsNote(blocked: NonNullable<HookReport["blocked"]>): HookReport["notes"][number] {
  const { plugin, reason, hold, label } = blocked;
  return { plugin, text: reason, ...(hold ? { hold } : {}), ...(label ? { label } : {}) };
}

/**
 * Announces one moment for a game and answers what its steps said, as lines: their notes, Genex's
 * own hold in the person's words. A block (an older Genex's host, or a kept `hooks.ts` that still
 * holds such a moment back when its host fails) is one more line, its reason, after the notes:
 * nothing here holds anything back. A moment the chat's or the run's Stop ended says nothing; its
 * caller reads the Stop from `ctx.cancelled`.
 */
export async function momentLines(
  ctx: HarnessCtx,
  game: HookedGame,
  on: HookEvent,
  scope: HookScope,
): Promise<string[]> {
  const report = await fireHooks(ctx, game, on, scope);
  if (ctx.cancelled) return [];
  const blocked = report.blocked ? [blockAsNote(report.blocked)] : [];
  return notesText({ notes: [...report.notes, ...blocked] });
}

/** Genex's own gates at a moment for a game, as lines: the reason of the gate that found something, or none. */
export function gateLines(on: HookEvent, input: GateInput): string[] {
  const reason = fireGates(on, input).blocked?.reason;
  return reason ? [reason] : [];
}

/**
 * The worker a worker moment names, as `hooks.ts` names it (`workerOf`, which a kept copy doesn't
 * export): a plain title within the host's cap (its id when nothing is left), a kind only when it has one.
 */
function workerScope(worker: HookWorker): NonNullable<HookScope["worker"]> {
  const title = clip(hookLabel(worker.title), WORKER_TITLE_CHARS) || worker.id;
  return { id: worker.id, title, ...(worker.type ? { type: worker.type } : {}) };
}

/**
 * Announces a worker's moment (`worker.start` before anything of it is written, `worker.end` once
 * its end is) and answers what the steps said, as lines (`momentLines`): a worker is never held back.
 */
export function workerMomentLines(
  ctx: HarnessCtx,
  game: HookedGame,
  scope: HookScope,
  worker: HookWorker,
  on: HookEvent,
): Promise<string[]> {
  return momentLines(ctx, game, on, { ...scope, worker: workerScope(worker) });
}

/**
 * A chat turn that goes on with the settings of a message the person sent while it worked
 * (steer-switch.ts): the engine, model and effort it answers on, and the Loop it may launch with,
 * worked out as the turn would have started with that message — the after-run session's engine kept,
 * a reopen's rules kept, the chat's own words never commissioning — and the lines that tell the
 * session what changed (steer-switch-prompts.ts).
 *
 * A module of its own: the chat's turn (delegated-turn.ts) reads it, and a seed upgrade keeps an
 * older copy of that module the agent edited, which never imported it.
 */
import { resolveRoles, supportsSessions } from "./model-roles.ts";
import { commissionHours, reopens } from "./reopen-run.ts";
import { RunState } from "./run-events.ts";
import { SWITCH_NOTES } from "./steer-switch-prompts.ts";
import type { AfterLoopRun } from "./after-loop-run.ts";
import type { AnyRecord } from "../types/harness.d.ts";

/** What a chat turn runs on, as far as a switch changes it. */
export interface TurnSettings {
  engine: string;
  engineLabel: string;
  model?: string;
  effort?: string;
  preferences?: unknown;
  loop?: AnyRecord | null;
  autopilot?: AnyRecord | null;
  afterLoopRun?: AfterLoopRun;
}

/** An engine as the host describes it: whether it holds a session, and what the person reads. */
export interface DescribedEngine {
  id: string;
  label?: string;
  supportsSessions?: boolean;
  kind?: string;
}

/** Did the chat write this message itself (a command's result), not the person? It never commissions a build. */
const chatWrote = (item: AnyRecord): boolean => item.origin !== undefined && item.origin !== null;

/** The message's Loop or Autopilot, and which of the two it is; null when it carries none. */
function commissionOf(item: AnyRecord): { key: "loop" | "autopilot"; commission: AnyRecord } | null {
  if (item.autopilot) return { key: "autopilot", commission: { ...item.autopilot } };
  if (item.loop) return { key: "loop", commission: { ...item.loop } };
  return null;
}

/** The engine a message answers on in this turn: the after-run session's, else the one it names, else the turn's. */
function engineFor(current: TurnSettings, item: AnyRecord): string {
  if (current.afterLoopRun) return current.afterLoopRun.engine;
  return typeof item.engine === "string" && item.engine ? item.engine : current.engine;
}

/**
 * Whether this turn cannot go on with the message's settings, so it ends at the session's next step
 * and the message gets a turn of its own: an engine that holds no session (its turn is another
 * runner's), or — after a run its lead led — another engine than the lead's (another session answers).
 */
export function endsTurnFor(current: TurnSettings, item: AnyRecord, described: readonly DescribedEngine[]): boolean {
  const named = typeof item.engine === "string" && item.engine ? item.engine : null;
  if (!named) return false;
  if (current.afterLoopRun && !startsNextLoop(current, item)) return named !== current.afterLoopRun.engine;
  return !supportsSessions(described.find((engine) => engine.id === named));
}

/**
 * After a finished Loop that worked in the game folder itself, a Loop message is for no run: it
 * starts the next Loop (chat-dispatch.ts `startsNextOpenLoop`), so the turn stops being the
 * after-run session and may launch.
 */
function startsNextLoop(current: TurnSettings, item: AnyRecord): boolean {
  const after = current.afterLoopRun;
  const finishedInPlace = after?.inPlace === true && after.state === RunState.Finished;
  return finishedInPlace && !chatWrote(item) && commissionOf(item) !== null;
}

/**
 * The commission a switch keeps: none for words the chat wrote itself, none after a run that may not
 * be reopened (reopen-run.ts `keepsCommission`), the message's otherwise — and a Loop that brings no
 * mood board keeps the one the turn had.
 */
function keptCommission(current: TurnSettings, item: AnyRecord): ReturnType<typeof commissionOf> {
  const taken = chatWrote(item) ? null : commissionOf(item);
  if (!taken) return null;
  if (current.afterLoopRun && !reopens(current.afterLoopRun, taken.commission)) return null;
  const kept = (current.autopilot ?? current.loop)?.frames;
  if (!taken.commission.frames?.length && Array.isArray(kept) && kept.length) taken.commission.frames = kept;
  return taken;
}

/**
 * The model a commissioning turn runs on: the planner (turn-loop.ts `turnModel`), unless the chat's
 * own session after its run answers — it stays on the model it answers on.
 */
function modelFor(current: TurnSettings, item: AnyRecord, engine: string, commission: AnyRecord | null) {
  const named = typeof item.model === "string" && item.model ? item.model : undefined;
  if (current.afterLoopRun) return named ?? current.afterLoopRun.model ?? undefined;
  if (!commission) return named;
  return commission.roles?.planner ?? resolveRoles(engine, named).planner;
}

/**
 * The settings the turn goes on with after `item`, as a turn started with it would have run:
 * its engine (the after-run session's kept), model, effort and preferences, and its Loop or
 * Autopilot with the composer's engine stamped as the builder (turn-loop.ts `stampBuilder`).
 */
export function switchedSettings(
  turn: TurnSettings,
  item: AnyRecord,
  described: readonly DescribedEngine[],
): TurnSettings {
  // The next Loop after an in-place one starts from a plain chat turn: no run's controls, no after-run rules.
  const current: TurnSettings = startsNextLoop(turn, item) ? { ...turn, afterLoopRun: undefined } : turn;
  const engine = engineFor(current, item);
  const taken = keptCommission(current, item);
  const commission = taken?.commission ?? null;
  const model = modelFor(current, item, engine, commission);
  if (commission) {
    commission.builderEngine = commission.builderEngine ?? engine;
    if (typeof item.model === "string" && item.model) commission.builderModel = commission.builderModel ?? item.model;
  }
  const label = described.find((one) => one.id === engine)?.label ?? engine;
  return {
    ...current,
    engine,
    engineLabel: label,
    ...(model ? { model } : { model: undefined }),
    effort: typeof item.effort === "string" ? item.effort : undefined,
    preferences: item.preferences,
    loop: taken?.key === "loop" ? commission : undefined,
    autopilot: taken?.key === "autopilot" ? commission : undefined,
  };
}

/** The commission a turn runs under, or null. */
const commissionIn = (settings: TurnSettings): AnyRecord | null => settings.autopilot ?? settings.loop ?? null;

/** "Claude Code (opus) · high effort": who answers, as the session is told. */
function whoAnswers(settings: TurnSettings): string {
  const model = settings.model && settings.model !== "default" ? ` (${settings.model})` : "";
  const effort = settings.effort ? ` · ${settings.effort} effort` : "";
  return `${settings.engineLabel}${model}${effort}`;
}

/** What the switch tells the session: the turn's launch tool, its workers, and whether a build takes them over. */
export interface SwitchContext {
  /** The tool the turn may launch a build with after the switch, or null. */
  launchTool: string | null;
  /** The finished build may be reopened after the switch (its note words it). */
  reopening: boolean;
  /** Workers the turn's session started that are still working. */
  workers: number;
  /** A build started from this chat takes them over (a Loop in place); else they finish first. */
  workersCarry: boolean;
}

/** The lines a switch opens the next leg with: one per thing that changed, in the order the session needs them. */
export function switchNotes(before: TurnSettings, after: TurnSettings, context: SwitchContext): string[] {
  const notes: string[] = [];
  if (after.engine !== before.engine) notes.push(SWITCH_NOTES.engine(whoAnswers(after)));
  else if (after.model !== before.model || after.effort !== before.effort)
    notes.push(SWITCH_NOTES.model(whoAnswers(after)));
  notes.push(...commissionNotes(commissionIn(before), commissionIn(after), context));
  return notes;
}

/** What changed about the Loop: on, off, its hours, roles, plan review, or a new mood board. */
function commissionNotes(before: AnyRecord | null, after: AnyRecord | null, context: SwitchContext): string[] {
  if (!after) return before ? [SWITCH_NOTES.loopOff] : [];
  const notes: string[] = [];
  if (!before) notes.push(...loopOnNotes(after, context));
  else notes.push(...loopChangedNotes(before, after));
  const frames = Array.isArray(after.frames) ? after.frames.length : 0;
  if (frames && after.frames !== before?.frames) notes.push(SWITCH_NOTES.moodBoard(frames));
  return notes;
}

/** The Loop came on: what the session may do now, and what happens to its workers. */
function loopOnNotes(after: AnyRecord, context: SwitchContext): string[] {
  if (context.reopening) return [SWITCH_NOTES.reopenOn];
  if (!context.launchTool) return [];
  const notes: string[] = [SWITCH_NOTES.loopOn(context.launchTool, commissionHours(after))];
  if (context.workers > 0)
    notes.push(
      context.workersCarry ? SWITCH_NOTES.workersCarry(context.workers) : SWITCH_NOTES.workersLand(context.workers),
    );
  return notes;
}

/** A Loop that stayed on but changed: its hours, its roles, or its plan review. */
function loopChangedNotes(before: AnyRecord, after: AnyRecord): string[] {
  const notes: string[] = [];
  if (commissionHours(before) !== commissionHours(after)) notes.push(SWITCH_NOTES.loopHours(commissionHours(after)));
  if (JSON.stringify(before.roles ?? null) !== JSON.stringify(after.roles ?? null)) notes.push(SWITCH_NOTES.loopRoles);
  if (Boolean(before.reviewPlan) !== Boolean(after.reviewPlan))
    notes.push(SWITCH_NOTES.planReview(Boolean(after.reviewPlan)));
  return notes;
}

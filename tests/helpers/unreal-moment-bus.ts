/**
 * A fake of Genex's hook bus for a harness test host: `hooks.fire`, `checkpoint.take` and
 * `snapshot.restore` answered as the host's `HookService` does, with the steps planned by the
 * shared `hookPlan` over a plugin manifest (the real one, or one a test hands it). Each step is
 * answered by the test host (`step`), a writing moment is held while the chat plans, the steps'
 * locks wait for the person (`probe`, asked every five seconds up to the moment's wait) and a
 * blocking moment stops at its first block (a step that throws blocks; at `health` it is pending).
 * Every step, probe, snapshot and restore is appended to the host's one ordered trail (`log`).
 */
import { HOOK_LOCK_WAIT_MS } from "../../src/main/core/plugin-hooks.ts";
import { PERSON_FIRST_POLL_MS } from "../../src/main/core/plugin-locks.ts";
import {
  BLOCKING_HOOK_EVENTS,
  CheckpointSkip,
  EMPTY_HOOK_REPORT,
  HOOK_BLOCKED,
  type HookContext,
  HookEvent,
  type HookHeld,
  HookHold,
  type HookReport,
  type HookStep,
  type HookedPlugin,
  hookAnswerOf,
  hookPlan,
  isSeedFiredHookEvent,
  type PluginLock,
  personFirstOf,
  WRITING_HOOK_EVENTS,
} from "../../src/shared/plugin-hooks.ts";
import type { GameKind } from "../../src/shared/project-facts.ts";

/** The host's words, as `main/core/plugin-hooks.ts` and `plugin-locks.ts` say them. */
export const BUS_WORDS = {
  planning: "the chat is in Plan mode, so nothing changes until the plan is approved.",
  planHeld: "The chat is in Plan mode, so this waits until the plan is approved.",
  failed: (plugin: string, tool: string, why: string) => `${plugin}'s ${tool} step failed: ${why}`,
  noProbe: "Genex couldn't tell whether anything was unsaved, so no checkpoint was taken.",
  nothingUnsaved: (labels: string) => `Nothing was unsaved in ${labels}, so no checkpoint was taken.`,
  cantTell: (labels: string) => `Genex couldn't tell whether ${labels} held unsaved work, so no checkpoint was taken.`,
  personUsing: (label: string) =>
    `The person is using ${label}, and this waited for them to finish: they were still at it. Try again later, or ask them in the chat.`,
  personCantTell: (label: string) =>
    `Genex could not tell whether the person is using ${label}, so this waited for them, and still could not tell. Try again later.`,
} as const;

/** What the bus needs from its test host. */
export type BusHost = {
  plugins: () => HookedPlugin[];
  game: GameKind;
  planning: () => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** One step's answer: the plugin's harness tool `tool`, told the moment. */
  step: (plugin: string, tool: string, hook: HookContext) => Promise<unknown>;
  /** A lock's person-first probe's answer (a throw: can't tell). */
  probe: (plugin: string, lock: PluginLock) => Promise<unknown>;
  /** Appends one entry to the host's trail, and notes it when a turn is under way. */
  log: (entry: string, during?: string) => void;
  /** Takes the checkpoint's snapshot; its record. */
  snapshot: (label: string) => Record<string, unknown>;
};

/** Why Genex itself held a moment back: its words, and its typed hold. */
type Refusal = { reason: string; held: HookHeld };

/** Plan mode's hold, as the host words it at a moment and at a checkpoint. */
const PLAN_HELD: HookHeld = { hold: HookHold.Plan };

/** A report Genex itself stopped, with its typed hold. */
const held = ({ reason, held: by }: Refusal): HookReport => ({
  ...EMPTY_HOOK_REPORT,
  blocked: { plugin: "@genex", tool: "", reason, ...by },
});

/** The error a restore a step (or Genex's hold) stopped fails with, as the harness receives it. */
const blockedError = (reason: string, by: HookHeld = {}) =>
  Object.assign(new Error(reason), { code: HOOK_BLOCKED, reason, ...by });

/** The locks a moment's steps need, each once, with the plugin that declares it. */
function locksOf(bus: BusHost, steps: readonly HookStep[]): Array<{ plugin: string; lock: PluginLock }> {
  const found = new Map<string, { plugin: string; lock: PluginLock }>();
  for (const step of steps) {
    const declared = bus.plugins().find((p) => p.id === step.plugin)?.manifest as { locks?: PluginLock[] } | undefined;
    for (const id of step.needs) {
      const lock = declared?.locks?.find((l) => l.id === id);
      if (lock) found.set(`${step.plugin}/${id}`, { plugin: step.plugin, lock });
    }
  }
  return [...found.values()];
}

/** One probe's answer as Genex reads it, appended to the trail as a poll. */
async function asked(bus: BusHost, plugin: string, lock: PluginLock) {
  const name = `${plugin}__${lock.personFirst}`;
  bus.log(`tool:${name}`, name);
  return personFirstOf(await bus.probe(plugin, lock).catch(() => null));
}

/** Waits for the person on one lock until they are not using it, or `waitMs` ran out; why not, or null. */
async function holdOne(bus: BusHost, plugin: string, lock: PluginLock, waitMs: number): Promise<Refusal | null> {
  const until = bus.now() + waitMs;
  for (;;) {
    const answer = await asked(bus, plugin, lock);
    if (answer && !answer.personActive) return null;
    if (bus.now() >= until) {
      const reason = answer ? BUS_WORDS.personUsing(lock.label) : BUS_WORDS.personCantTell(lock.label);
      return { reason, held: { hold: answer ? HookHold.PersonFirst : HookHold.CantTell, label: lock.label } };
    }
    await bus.sleep(PERSON_FIRST_POLL_MS);
  }
}

/** Waits for the person on every lock with a probe; why the moment may not go on, or null. */
async function hold(bus: BusHost, steps: readonly HookStep[], waitMs: number): Promise<Refusal | null> {
  for (const { plugin, lock } of locksOf(bus, steps)) {
    const refused = lock.personFirst ? await holdOne(bus, plugin, lock, waitMs) : null;
    if (refused) return refused;
  }
  return null;
}

/** Whether a step's block stops the moment: a blocking moment's, or a failed health check. */
const stops = (on: HookEvent) => BLOCKING_HOOK_EVENTS.has(on) || on === HookEvent.Health;

/** What a step that threw means at a moment: a block where a block stops it, pending at `health`, else a note. */
function thrown(report: HookReport, on: HookEvent, step: HookStep, error: unknown): HookReport | null {
  const why = BUS_WORDS.failed(step.plugin, step.tool, (error as Error).message);
  if (BLOCKING_HOOK_EVENTS.has(on))
    return { ...report, blocked: { plugin: step.plugin, tool: step.tool, reason: why } };
  if (on === HookEvent.Health) report.pending ??= { plugin: step.plugin, reason: why };
  else report.notes.push({ plugin: step.plugin, text: why });
  return null;
}

/** One step's answer read into the report; the report that ends the moment, or null. */
function read(report: HookReport, on: HookEvent, step: HookStep, answer: ReturnType<typeof hookAnswerOf>) {
  if (answer.block && stops(on))
    return { ...report, blocked: { plugin: step.plugin, tool: step.tool, reason: answer.block } };
  if (answer.block) report.notes.push({ plugin: step.plugin, text: answer.block });
  if (answer.note) report.notes.push({ plugin: step.plugin, text: answer.note });
  if (answer.pending) report.pending ??= { plugin: step.plugin, reason: answer.pending };
  if (answer.images) report.images.push(...answer.images);
  return null;
}

/** Runs a moment's steps in order, as the host does. */
async function run(bus: BusHost, on: HookEvent, steps: readonly HookStep[], hook: HookContext): Promise<HookReport> {
  const report: HookReport = { blocked: null, pending: null, notes: [], images: [], ran: [] };
  for (const step of steps) {
    const name = `${step.plugin}__${step.tool}`;
    bus.log(`tool:${name}`, name);
    report.ran.push(name);
    let ended: HookReport | null;
    try {
      ended = read(report, on, step, hookAnswerOf(await bus.step(step.plugin, step.tool, hook)));
    } catch (error) {
      ended = thrown(report, on, step, error);
    }
    if (ended) return ended;
  }
  return report;
}

/** What a step is told: the moment and the scope's own fields. */
function contextOf(on: HookEvent, params: Record<string, unknown>): HookContext {
  const pick = (key: string) => (typeof params[key] === "string" && params[key] ? { [key]: params[key] } : {});
  return {
    on,
    ...pick("runId"),
    ...pick("turn"),
    ...pick("label"),
    ...(params.worker ? { worker: params.worker } : {}),
  } as HookContext;
}

/** One moment's steps for the game. */
const planOf = (bus: BusHost, on: HookEvent) => hookPlan(bus.plugins(), on, bus.game);

/** `hooks.fire`: a moment the harness announces. */
export async function fire(bus: BusHost, params: Record<string, unknown>): Promise<HookReport> {
  const on = params.on;
  if (!isSeedFiredHookEvent(on)) throw new Error(`The harness may not announce the moment ${JSON.stringify(on)}`);
  const steps = planOf(bus, on);
  if (!steps.length) return EMPTY_HOOK_REPORT;
  if (WRITING_HOOK_EVENTS.has(on) && bus.planning()) return held({ reason: BUS_WORDS.planHeld, held: PLAN_HELD });
  const refused = await hold(bus, steps, HOOK_LOCK_WAIT_MS[on]);
  if (refused && (BLOCKING_HOOK_EVENTS.has(on) || WRITING_HOOK_EVENTS.has(on))) return held(refused);
  if (refused && on === HookEvent.Health)
    return { ...EMPTY_HOOK_REPORT, pending: { plugin: "@genex", reason: refused.reason } };
  if (refused) return { ...EMPTY_HOOK_REPORT, notes: [{ plugin: "@genex", text: refused.reason }] };
  return run(bus, on, steps, contextOf(on, params));
}

/** Why a checkpoint asked only if something is unsaved is skipped, or null when it goes on. */
async function unsavedSkip(bus: BusHost, before: readonly HookStep[]) {
  const locks = locksOf(bus, before).filter(({ lock }) => lock.personFirst);
  if (!locks.length) return { skipped: CheckpointSkip.CantTell, reason: BUS_WORDS.noProbe };
  const labels = locks.map(({ lock }) => lock.label).join(", ");
  let total = 0;
  for (const { plugin, lock } of locks) {
    const answer = await asked(bus, plugin, lock);
    if (answer?.unsaved === undefined) return { skipped: CheckpointSkip.CantTell, reason: BUS_WORDS.cantTell(labels) };
    total += answer.unsaved;
  }
  return total === 0 ? { skipped: CheckpointSkip.NothingUnsaved, reason: BUS_WORDS.nothingUnsaved(labels) } : null;
}

/** `checkpoint.take`: what is unsaved read first when asked, then the before steps, the snapshot, the after steps. */
export async function checkpoint(bus: BusHost, params: Record<string, unknown>) {
  const before = planOf(bus, HookEvent.CheckpointBefore);
  const after = planOf(bus, HookEvent.CheckpointAfter);
  if (params.onlyIfUnsaved === true) {
    const skipped = await unsavedSkip(bus, before);
    if (skipped) return skipped;
  }
  if (bus.planning()) return { blocked: BUS_WORDS.planning, ...PLAN_HELD };
  const refused = await hold(bus, [...before, ...after], HOOK_LOCK_WAIT_MS[HookEvent.CheckpointBefore]);
  if (refused) return { blocked: refused.reason, ...refused.held };
  const opened = await run(bus, HookEvent.CheckpointBefore, before, contextOf(HookEvent.CheckpointBefore, params));
  if (opened.blocked) return { blocked: opened.blocked.reason };
  bus.log("snapshot.create", "snapshot.create");
  const snapshot = bus.snapshot(String(params.label));
  const closed = await run(bus, HookEvent.CheckpointAfter, after, contextOf(HookEvent.CheckpointAfter, params));
  return { snapshot, notes: [...opened.notes, ...closed.notes], images: [...opened.images, ...closed.images] };
}

/** `snapshot.restore` of a game folder: the restore steps around `restore`, which a block before never reaches. */
export async function restore(bus: BusHost, params: Record<string, unknown>, restoreFiles: () => void) {
  const before = planOf(bus, HookEvent.RestoreBefore);
  const after = planOf(bus, HookEvent.RestoreAfter);
  const restoring = () => {
    bus.log("snapshot.restore", "snapshot.restore");
    restoreFiles();
  };
  if (!before.length && !after.length) {
    restoring();
    return true;
  }
  if (bus.planning()) throw blockedError(BUS_WORDS.planHeld, PLAN_HELD);
  const refused = await hold(bus, [...before, ...after], HOOK_LOCK_WAIT_MS[HookEvent.RestoreBefore]);
  if (refused) throw blockedError(refused.reason, refused.held);
  const opened = await run(bus, HookEvent.RestoreBefore, before, contextOf(HookEvent.RestoreBefore, params));
  if (opened.blocked) throw blockedError(opened.blocked.reason);
  try {
    restoring();
  } finally {
    await run(bus, HookEvent.RestoreAfter, after, contextOf(HookEvent.RestoreAfter, params));
  }
  return true;
}

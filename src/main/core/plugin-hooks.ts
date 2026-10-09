/**
 * Genex's hook bus: at one of its moments (`shared/plugin-hooks.ts`) Genex runs the steps the
 * enabled plugins hook to it for the game, in plugin order and then declaration order, each as a
 * harness step told the moment (`PluginBinding.hook`), under the union of the steps' locks. It
 * reads only a step's `block`, `note`, `pending` and `images`: a step never rewrites arguments and
 * never gives instructions. Git stays Genex's: the checkpoint's snapshot and a restore are taken
 * here, never by a step.
 *
 * The host fires the checkpoint moments (`takeCheckpoint`), every restore of a game folder
 * (`restoreWithHooks`, the person's Rewind among them) and a plugin's own tool moments; the harness
 * announces the rest (`hooks.fire`). A moment's steps are called straight through the registry,
 * under the locks the moment already holds, never through a call that holds locks itself.
 */
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { SnapshotScope } from "../../shared/event-log.ts";
import {
  BLOCKING_HOOK_EVENTS,
  type CheckpointAnswer,
  CheckpointSkip,
  EMPTY_HOOK_REPORT,
  HOOK_BLOCKED,
  type HookAnswer,
  type HookContext,
  HookEvent,
  type HookHeld,
  HookHold,
  type HookReport,
  type HookStep,
  hookAnswerOf,
  WRITING_HOOK_EVENTS,
} from "../../shared/plugin-hooks.ts";
import { type PluginBinding, PluginToolAudience } from "../../shared/plugins.ts";
import { shortId } from "../../substrate/ids.ts";
import { PLUGIN_CALL_TIMEOUT_MS } from "../../substrate/plugins/registry.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { consentAudience } from "./consent-audience.ts";
import { chatHolders, isLockRefused, type LockRef, LockRefusal, type LockRefused, runHolders } from "./plugin-locks.ts";

/** The longest a moment waits for its steps' locks: a checkpoint a minute, a restore two, health not at all. */
export const HOOK_LOCK_WAIT_MS = {
  [HookEvent.RunPrepare]: 30 * SECOND_MS,
  [HookEvent.RunEnd]: 30 * SECOND_MS,
  [HookEvent.TurnStart]: 30 * SECOND_MS,
  [HookEvent.TurnEnd]: 30 * SECOND_MS,
  [HookEvent.CheckpointBefore]: MINUTE_MS,
  [HookEvent.CheckpointAfter]: 30 * SECOND_MS,
  [HookEvent.RestoreBefore]: 2 * MINUTE_MS,
  [HookEvent.RestoreAfter]: 30 * SECOND_MS,
  [HookEvent.WorkerStart]: 30 * SECOND_MS,
  [HookEvent.WorkerEnd]: 30 * SECOND_MS,
  // An agent's call waits for its own locks too: its tool moments stay short, within the bridge's deadline.
  [HookEvent.ToolBefore]: 15 * SECOND_MS,
  [HookEvent.ToolAfter]: 15 * SECOND_MS,
  [HookEvent.Health]: 0,
  [HookEvent.Crash]: 30 * SECOND_MS,
  [HookEvent.Finish]: 30 * SECOND_MS,
} as const satisfies Record<HookEvent, number>;

/**
 * The longest one step runs: the host's ceiling for a plugin call, and longer where a step opens an
 * app or, before a restore, waits for a busy app to answer so it can save its work.
 */
export const HOOK_CALL_MS = {
  // A run's start may wait for a busy editor, update its helper and open it twice (Unreal's `OPEN_FOR_RUN_MAX_MS`).
  [HookEvent.RunPrepare]: 30 * MINUTE_MS,
  [HookEvent.RunEnd]: PLUGIN_CALL_TIMEOUT_MS,
  [HookEvent.TurnStart]: PLUGIN_CALL_TIMEOUT_MS,
  [HookEvent.TurnEnd]: PLUGIN_CALL_TIMEOUT_MS,
  [HookEvent.CheckpointBefore]: PLUGIN_CALL_TIMEOUT_MS,
  [HookEvent.CheckpointAfter]: PLUGIN_CALL_TIMEOUT_MS,
  [HookEvent.RestoreBefore]: 8 * MINUTE_MS,
  [HookEvent.RestoreAfter]: 8 * MINUTE_MS,
  [HookEvent.WorkerStart]: PLUGIN_CALL_TIMEOUT_MS,
  [HookEvent.WorkerEnd]: PLUGIN_CALL_TIMEOUT_MS,
  // A step around an agent's call: the call's wait, the call and both moments end within the bridge's deadline.
  [HookEvent.ToolBefore]: MINUTE_MS,
  [HookEvent.ToolAfter]: MINUTE_MS,
  [HookEvent.Health]: PLUGIN_CALL_TIMEOUT_MS,
  [HookEvent.Crash]: 8 * MINUTE_MS,
  [HookEvent.Finish]: PLUGIN_CALL_TIMEOUT_MS,
} as const satisfies Record<HookEvent, number>;

/** Genex itself, as the one that held a moment back (Plan mode, a lock): no plugin id is spelled with `@`. */
const GENEX = "@genex";

/** What the caller, the agent or the log reads. Model-facing where an agent reads it. */
const MESSAGE = {
  planning: "the chat is in Plan mode, so nothing changes until the plan is approved.",
  planHeld: "The chat is in Plan mode, so this waits until the plan is approved.",
  failed: (plugin: string, tool: string, why: string) => `${plugin}'s ${tool} step failed: ${why}`,
  checkpointReason: (label: string) => `checkpoint: ${label}`,
  noProbe: "Genex couldn't tell whether anything was unsaved, so no checkpoint was taken.",
  nothingUnsaved: (labels: string) => `Nothing was unsaved in ${labels}, so no checkpoint was taken.`,
  cantTell: (labels: string) => `Genex couldn't tell whether ${labels} held unsaved work, so no checkpoint was taken.`,
  noSnapshot: (why: string) => `No snapshot was taken: ${why}`,
  taken: (id: string) => `Took snapshot ${id} of the game folder.`,
  blocked: (reason: string) => `Nothing was saved and no snapshot was taken: ${reason}`,
  logBlocked: (on: HookEvent, project: string, by: string, reason: string) =>
    `[core] ${on} in ${project} stopped by ${by}: ${reason}`,
  logNote: (on: HookEvent, project: string, plugin: string, text: string) =>
    `[core] ${on} in ${project}, ${plugin}: ${text}`,
} as const;

/** Who a moment is for, and what its steps are told. */
export interface HookScope {
  project: string;
  /** The chat the moment answers to (or reports in, for a run): its Plan mode holds writing moments. */
  threadId?: string;
  runId?: string;
  turn?: string;
  label?: string;
  worker?: { id: string; title: string; type?: string };
  /** The plugin tool a `tool.*` moment is around, by its agent name. */
  tool?: string;
  /** A digest of that tool's arguments, never the arguments. */
  args?: string;
  /** The person's own action: it never waits for the person, and Plan mode never holds it. */
  forPerson?: boolean;
}

/** How a moment runs: Stop ends it, how long it may wait for its locks, and who holds them. */
export interface HookFireOptions {
  signal?: AbortSignal;
  waitMs?: number;
  /** The caller's lock holder (`workerHolder`): a worker writing in place passes the locks it holds. */
  holder?: string;
}

/** A checkpoint asked for: the game, the chat or run it answers to, its name and whether it is wanted only when something is unsaved. */
export interface CheckpointAsk {
  project: string;
  threadId?: string;
  runId?: string;
  label: string;
  onlyIfUnsaved?: boolean;
  forPerson?: boolean;
  signal?: AbortSignal;
}

/** How a restore is run around its moments. */
export interface RestoreOptions {
  forPerson?: boolean;
  threadId?: string;
  runId?: string;
  signal?: AbortSignal;
}

/**
 * A restore a step (or Plan mode, or a lock) stopped before any file changed; `hold` and `label`
 * say when it was Genex's own hold, and travel to the harness with the error's code.
 */
export class HookBlockedError extends Error {
  readonly code = HOOK_BLOCKED;
  readonly reason: string;
  readonly hold?: HookHold;
  readonly label?: string;
  constructor(reason: string, held: HookHeld = {}) {
    super(reason);
    this.name = "HookBlockedError";
    this.reason = reason;
    if (held.hold) this.hold = held.hold;
    if (held.label) this.label = held.label;
  }
}

/** Genex's hold for each lock refusal. */
const HOLD_OF_REFUSAL = {
  [LockRefusal.PersonFirst]: HookHold.PersonFirst,
  [LockRefusal.CantTell]: HookHold.CantTell,
  [LockRefusal.Busy]: HookHold.Busy,
} as const satisfies Record<LockRefusal, HookHold>;

/** A lock refusal as Genex's hold: why, and which app's lock. */
const heldBy = (refused: LockRefused): HookHeld => ({ hold: HOLD_OF_REFUSAL[refused.code], label: refused.label });

/** Plan mode's hold. */
const PLAN_HELD: HookHeld = { hold: HookHold.Plan };

/** Nothing to let go: a moment whose steps need no lock. */
const NO_RELEASE = (): void => {};

/** The plugin a tool's agent name belongs to. */
const pluginOf = (agentName: string): string => agentName.slice(0, Math.max(0, agentName.indexOf("__")));

/** Whether a step's block stops the moment: a blocking moment's, or a failed health check (Genex's crash). */
const stops = (on: HookEvent): boolean => BLOCKING_HOOK_EVENTS.has(on) || on === HookEvent.Health;

/** A report Genex itself stopped before any step ran, with its typed hold. */
const heldReport = (reason: string, held: HookHeld): HookReport => ({
  ...EMPTY_HOOK_REPORT,
  blocked: { plugin: GENEX, tool: "", reason, ...held },
});

/** What a step is told: the moment and the scope's own fields, nothing else. */
function hookContextOf(on: HookEvent, scope: HookScope): HookContext {
  const { runId, turn, label, worker, tool, args, forPerson } = scope;
  return {
    on,
    ...(runId ? { runId } : {}),
    ...(turn ? { turn } : {}),
    ...(label ? { label } : {}),
    ...(worker ? { worker } : {}),
    ...(tool ? { tool } : {}),
    ...(args ? { args } : {}),
    ...(forPerson ? { forPerson } : {}),
  };
}

/** Genex's moments, and the plugin steps each runs for a game. */
export class HookService {
  readonly #core: StudioCore;
  readonly #x: Pick<CoreInternals, "locks" | "planning">;

  constructor(core: StudioCore, x: Pick<CoreInternals, "locks" | "planning">) {
    this.#core = core;
    this.#x = x;
  }

  /**
   * Run one moment's steps for a game: none when no enabled plugin hooks it there. A writing moment
   * waits while the chat plans (unless the person acts); its steps' locks are held for the whole
   * moment. A blocking moment stops at the first block (a step that fails blocks: fail closed); a
   * failed health check is pending, never a crash. Every note is logged, whoever reads the report.
   */
  async fire(on: HookEvent, scope: HookScope, options: HookFireOptions = {}): Promise<HookReport> {
    const steps = await this.#plan(on, scope);
    if (!steps.length) return EMPTY_HOOK_REPORT;
    const held = await this.#planHeld(on, scope);
    if (held) return heldReport(held, PLAN_HELD);
    const binding = await this.#binding(scope);
    let release = NO_RELEASE;
    try {
      const waitMs = options.waitMs ?? HOOK_LOCK_WAIT_MS[on];
      release = await this.#hold(steps, binding, scope, options.signal, waitMs, options.holder);
    } catch (error) {
      if (!isLockRefused(error)) throw error;
      return this.#refusedReport(on, scope, error);
    }
    try {
      const report = await this.#run(on, steps, scope, binding, options.signal);
      this.#logNotes(on, scope, report);
      return report;
    } finally {
      release();
    }
  }

  /**
   * A checkpoint of the game folder: the `checkpoint.before` steps, a snapshot named for the label,
   * then the `checkpoint.after` steps, all under their locks. Asked only if unsaved, it is skipped
   * when every probe of its locks says nothing is, or one can't tell: that read comes first, so a
   * planning chat with nothing unsaved hears nothing. Plan mode holds the rest.
   */
  async takeCheckpoint(ask: CheckpointAsk): Promise<CheckpointAnswer> {
    const scope: HookScope = scopeOfAsk(ask);
    const before = await this.#plan(HookEvent.CheckpointBefore, scope);
    const after = await this.#plan(HookEvent.CheckpointAfter, scope);
    const binding = await this.#binding(scope);
    if (ask.onlyIfUnsaved) {
      const skipped = await this.#unsavedSkip(before, binding, ask.signal);
      if (skipped) return skipped;
    }
    if (!ask.forPerson && (await this.#planning(scope))) return { blocked: MESSAGE.planning, ...PLAN_HELD };
    let release = NO_RELEASE;
    try {
      const waitMs = HOOK_LOCK_WAIT_MS[HookEvent.CheckpointBefore];
      release = await this.#hold([...before, ...after], binding, scope, ask.signal, waitMs);
    } catch (error) {
      if (!isLockRefused(error)) throw error;
      return { blocked: error.message, ...heldBy(error) };
    }
    try {
      return await this.#checkpointHeld(ask, scope, binding, before, after);
    } finally {
      release();
    }
  }

  /**
   * Restore a game folder (`run`) between its `restore.before` and `restore.after` steps, under
   * their locks. A block before (or Plan mode, or a lock not given) throws `HookBlockedError` and
   * nothing is restored; the after steps run however the restore ended, their notes logged. The
   * person's own Rewind (`forPerson`) never waits for the person or the plan.
   */
  async restoreWithHooks<T>(project: string, run: () => Promise<T>, options: RestoreOptions = {}): Promise<T> {
    const scope: HookScope = { project, ...restoreScope(options) };
    const before = await this.#plan(HookEvent.RestoreBefore, scope);
    const after = await this.#plan(HookEvent.RestoreAfter, scope);
    if (!before.length && !after.length) return run();
    const held = await this.#planHeld(HookEvent.RestoreBefore, scope);
    if (held) throw new HookBlockedError(held, PLAN_HELD);
    const binding = await this.#binding(scope);
    let release = NO_RELEASE;
    try {
      const waitMs = HOOK_LOCK_WAIT_MS[HookEvent.RestoreBefore];
      release = await this.#hold([...before, ...after], binding, scope, options.signal, waitMs);
    } catch (error) {
      if (isLockRefused(error)) throw new HookBlockedError(error.message, heldBy(error));
      throw error;
    }
    try {
      const opened = await this.#run(HookEvent.RestoreBefore, before, scope, binding, options.signal);
      if (opened.blocked) throw new HookBlockedError(opened.blocked.reason);
      this.#logNotes(HookEvent.RestoreBefore, scope, opened);
      try {
        return await run();
      } finally {
        // Once the files may have changed, the after steps run however it ended: Stop ends no one of them.
        await this.#closeRestore(after, scope, binding);
      }
    } finally {
      release();
    }
  }

  /** The checkpoint itself, its locks held: before, the snapshot, after. */
  async #checkpointHeld(
    ask: CheckpointAsk,
    scope: HookScope,
    binding: PluginBinding,
    before: HookStep[],
    after: HookStep[],
  ): Promise<CheckpointAnswer> {
    const opened = await this.#run(HookEvent.CheckpointBefore, before, scope, binding, ask.signal);
    if (opened.blocked) return { blocked: opened.blocked.reason };
    let snapshot: Awaited<ReturnType<StudioCore["snapshot"]>>;
    try {
      snapshot = await this.#core.snapshot(SnapshotScope.Game, MESSAGE.checkpointReason(ask.label), ask.project);
    } catch (error) {
      return { blocked: MESSAGE.noSnapshot(sentence(error)) };
    }
    const closed = await this.#run(HookEvent.CheckpointAfter, after, scope, binding, ask.signal);
    return { snapshot, notes: [...opened.notes, ...closed.notes], images: [...opened.images, ...closed.images] };
  }

  /** The restore's after steps: their notes, and a step that failed, logged; never thrown over the restore's own outcome. */
  async #closeRestore(after: HookStep[], scope: HookScope, binding: PluginBinding) {
    try {
      this.#logNotes(
        HookEvent.RestoreAfter,
        scope,
        await this.#run(HookEvent.RestoreAfter, after, scope, binding, undefined),
      );
    } catch (error) {
      this.#log(MESSAGE.logNote(HookEvent.RestoreAfter, scope.project, GENEX, errorMessage(error)));
    }
  }

  /** The steps a moment runs for the game: none for a folder that can't be read. `tool.*` runs only the called tool's plugin's. */
  async #plan(on: HookEvent, scope: HookScope): Promise<HookStep[]> {
    const own = scope.tool ? pluginOf(scope.tool) : undefined;
    if (!this.#anyHook(on, own)) return [];
    const game = await this.#core.games.kindOf(scope.project).catch(() => null);
    return game ? this.#core.plugins.hookPlan(on, game, own) : [];
  }

  /** Whether some enabled plugin (only `own`, when named) hooks the moment at all: no game is read otherwise. */
  #anyHook(on: HookEvent, own: string | undefined): boolean {
    return this.#core.plugins
      .list()
      .some((p) => p.enabled && (!own || p.manifest.id === own) && p.manifest.hooks?.some((hook) => hook.on === on));
  }

  /** Why a writing moment waits for the plan, or null: the person's own action never does. */
  async #planHeld(on: HookEvent, scope: HookScope): Promise<string | null> {
    if (!WRITING_HOOK_EVENTS.has(on) || scope.forPerson) return null;
    return (await this.#planning(scope)) ? MESSAGE.planHeld : null;
  }

  /** Whether the chat a moment answers to (the chat a run reports to, for a run's) is in Plan mode. */
  async #planning(scope: HookScope): Promise<boolean> {
    if (!scope.threadId) return false;
    const binding = await this.#binding(scope);
    return this.#x.planning(await consentAudience(this.#core, binding, scope.runId));
  }

  async #binding(scope: HookScope): Promise<PluginBinding> {
    const binding = await this.#core.pluginBinding(scope.project, scope.threadId);
    if (!binding) throw new Error(`No such game: ${scope.project}`);
    return binding;
  }

  /**
   * The union of the steps' locks, held for the whole moment, the person first unless they act. A
   * run's moment passes the locks the run's own workers hold, and a chat's the chat's own (a worker
   * writing in place holds the game's for its whole life): Genex's checkpoints, restores and crash
   * recovery for the run or the chat never wait on it. The person's own action passes none.
   */
  async #hold(
    steps: readonly HookStep[],
    binding: PluginBinding,
    scope: HookScope,
    signal: AbortSignal | undefined,
    waitMs: number,
    holder?: string,
  ): Promise<() => void> {
    const refs = this.#locksOf(steps);
    if (!refs.length) return NO_RELEASE;
    return this.#x.locks.hold(refs, {
      binding,
      ...(signal ? { signal } : {}),
      ...(scope.forPerson ? { forPerson: true } : {}),
      waitMs,
      holder: holder ?? shortId("moment"),
      ...(holder ? {} : passesOf(scope)),
    });
  }

  /** The locks the steps need, each once. */
  #locksOf(steps: readonly HookStep[]): LockRef[] {
    const refs = new Map<string, LockRef>();
    for (const step of steps)
      for (const id of step.needs) {
        const lock = this.#core.plugins.lockOf(step.plugin, id);
        if (lock) refs.set(`${step.plugin}:${id}`, { plugin: step.plugin, lock });
      }
    return [...refs.values()];
  }

  /** Why a checkpoint asked only if unsaved is skipped, or null when something is unsaved. */
  async #unsavedSkip(
    before: readonly HookStep[],
    binding: PluginBinding,
    signal: AbortSignal | undefined,
  ): Promise<CheckpointAnswer | null> {
    const refs = this.#locksOf(before).filter((ref) => ref.lock.personFirst);
    if (!refs.length) return { skipped: CheckpointSkip.CantTell, reason: MESSAGE.noProbe };
    const labels = refs.map((ref) => ref.lock.label).join(", ");
    const unsaved = await this.#x.locks.unsaved(refs, binding, signal);
    if (unsaved === 0) return { skipped: CheckpointSkip.NothingUnsaved, reason: MESSAGE.nothingUnsaved(labels) };
    if (unsaved === null) return { skipped: CheckpointSkip.CantTell, reason: MESSAGE.cantTell(labels) };
    return null;
  }

  /**
   * A lock not given in time: a blocking or writing moment is held back with Genex's typed hold (as
   * Plan mode holds a writing one), health is pending, any other moment notes it.
   */
  #refusedReport(on: HookEvent, scope: HookScope, refused: LockRefused): HookReport {
    const reason = refused.message;
    if (BLOCKING_HOOK_EVENTS.has(on) || WRITING_HOOK_EVENTS.has(on)) {
      this.#log(MESSAGE.logBlocked(on, scope.project, GENEX, reason));
      return heldReport(reason, heldBy(refused));
    }
    if (on === HookEvent.Health) return { ...EMPTY_HOOK_REPORT, pending: { plugin: GENEX, reason } };
    const noted: HookReport = { ...EMPTY_HOOK_REPORT, notes: [{ plugin: GENEX, text: reason }] };
    this.#logNotes(on, scope, noted);
    return noted;
  }

  /** Each step in turn, read for its answer; a stopping block ends the moment. */
  async #run(
    on: HookEvent,
    steps: readonly HookStep[],
    scope: HookScope,
    binding: PluginBinding,
    signal: AbortSignal | undefined,
  ): Promise<HookReport> {
    const report: HookReport = { blocked: null, pending: null, notes: [], images: [], ran: [] };
    const told: PluginBinding = { ...binding, hook: hookContextOf(on, scope) };
    for (const step of steps) {
      const name = `${step.plugin}__${step.tool}`;
      report.ran.push(name);
      const answer = await this.#ask(on, step, name, told, signal);
      if (this.#read(report, on, scope, step, answer)) break;
    }
    return report;
  }

  /** One step's answer; a step that fails answers by the moment (fail closed where it blocks, pending at health). */
  async #ask(
    on: HookEvent,
    step: HookStep,
    name: string,
    binding: PluginBinding,
    signal: AbortSignal | undefined,
  ): Promise<HookAnswer> {
    try {
      const raw = await this.#core.plugins.tool(
        name,
        {},
        binding,
        signal,
        PluginToolAudience.Harness,
        HOOK_CALL_MS[on],
      );
      return hookAnswerOf(raw);
    } catch (error) {
      if (signal?.aborted) throw error;
      const words = MESSAGE.failed(this.#pluginName(step.plugin), step.tool, sentence(error));
      if (BLOCKING_HOOK_EVENTS.has(on)) return { block: words };
      if (on === HookEvent.Health) return { pending: words };
      return { note: words };
    }
  }

  /** Take one answer into the report; true when its block stops the moment. */
  #read(report: HookReport, on: HookEvent, scope: HookScope, step: HookStep, answer: HookAnswer): boolean {
    const { plugin } = step;
    if (answer.block && stops(on)) {
      report.blocked = { plugin, tool: step.tool, reason: answer.block };
      this.#log(MESSAGE.logBlocked(on, scope.project, `${plugin}__${step.tool}`, answer.block));
      return true;
    }
    if (answer.block) report.notes.push({ plugin, text: answer.block });
    if (answer.pending && !report.pending) report.pending = { plugin, reason: answer.pending };
    if (answer.note) report.notes.push({ plugin, text: answer.note });
    if (answer.images) report.images.push(...answer.images);
    return false;
  }

  #logNotes(on: HookEvent, scope: HookScope, report: HookReport): void {
    for (const note of report.notes) this.#log(MESSAGE.logNote(on, scope.project, note.plugin, note.text));
  }

  #pluginName(pluginId: string): string {
    return this.#core.plugins.list().find((p) => p.manifest.id === pluginId)?.manifest.name ?? pluginId;
  }

  #log(line: string): void {
    this.#core.options.onLog?.(line, "stderr");
  }
}

/** The words the chat's checkpoint tool answers for a checkpoint taken through its moments. */
export function checkpointWords(answer: CheckpointAnswer, reply: string): string {
  if ("blocked" in answer) return MESSAGE.blocked(answer.blocked);
  if ("skipped" in answer) return answer.reason;
  const notes = answer.notes.map((note) => note.text);
  return [...notes, MESSAGE.taken(answer.snapshot.snapshot_id), reply].join(" ");
}

/** The holders a moment passes as its own: its run's workers, else its chat's; none for the person's own action. */
function passesOf(scope: HookScope): { passes?: string } {
  if (scope.runId) return { passes: runHolders(scope.runId) };
  if (scope.threadId && !scope.forPerson) return { passes: chatHolders(scope.threadId) };
  return {};
}

/** A moment's scope from a checkpoint asked for. */
function scopeOfAsk(ask: CheckpointAsk): HookScope {
  return {
    project: ask.project,
    label: ask.label,
    ...(ask.threadId ? { threadId: ask.threadId } : {}),
    ...(ask.runId ? { runId: ask.runId } : {}),
    ...(ask.forPerson ? { forPerson: true } : {}),
  };
}

/** A restore's moment scope beside its game. */
function restoreScope(options: RestoreOptions): Omit<HookScope, "project"> {
  return {
    ...(options.threadId ? { threadId: options.threadId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.forPerson ? { forPerson: true } : {}),
  };
}

/** A failure's message, ending as a sentence does. */
function sentence(error: unknown): string {
  const text = String(errorMessage(error)).trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

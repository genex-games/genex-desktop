/**
 * Locks: one holder at a time, the person first. A plugin tool or connector that `needs` a lock
 * (manifest `locks`, `shared/plugin-hooks.ts`) waits its turn, first come first served per lock; a
 * lock per `project` is one game's, a lock per `app` is shared by every game. While the lock's
 * `personFirst` probe says the person is using what it guards, Genex's and the agents' calls wait
 * and the chat says so; a person's own action never waits for the person. A holder passes a lock
 * it already holds (an in-place writer's own calls), still giving way to the person. A lock grants
 * nothing: it only orders work that was already allowed.
 *
 * The probe is called straight through the registry, never through a call that itself holds
 * locks, so asking never waits on the lock it asks about.
 */
import { setTimeout as sleepFor } from "node:timers/promises";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { LockScope, type PersonFirstAnswer, type PluginLock, personFirstOf } from "../../shared/plugin-hooks.ts";
import type { PluginBinding } from "../../shared/plugins.ts";

/**
 * How long an agent's tool or connector call waits for a lock before it is answered why not: well
 * within the engine bridge's deadline for one call (`BRIDGE_TOOL_DEADLINE_MS`, 10 minutes), so the
 * agent reads why and the call has time of its own once granted.
 */
export const AGENT_LOCK_WAIT_MS = 4 * MINUTE_MS;
/** How often a call waiting for the person asks again whether they are still at it. */
export const PERSON_FIRST_POLL_MS = 5 * SECOND_MS;
/** How long a probe's "the person is not using it" stands for the next call on the same lock. */
export const PERSON_FIRST_FRESH_MS = 3 * SECOND_MS;

/** The owner Genex's own locks are kept under: no plugin id can be spelled with `@`. */
const GENEX_OWNER = "@genex";

/** Genex's own lock on a game folder: the one worker writing in place there, across every pool of the game. */
export const IN_PLACE_LOCK: LockRef = {
  plugin: GENEX_OWNER,
  lock: { id: "in-place", label: "the game folder", per: LockScope.Project },
};

/**
 * Why a lock was not given: the person kept using what it guards, Genex couldn't tell whether they
 * did, or another holder kept it. Answered to agents: never rename a value.
 */
export const LockRefusal = { PersonFirst: "person_first", CantTell: "cant_tell", Busy: "busy" } as const;
export type LockRefusal = (typeof LockRefusal)[keyof typeof LockRefusal];

/** Words an agent (or a lead) reads when a lock was not given, each naming the lock's label. */
const MESSAGE = {
  personUsing: (label: string) =>
    `The person is using ${label}, and this waited for them to finish: they were still at it. Try again later, or ask them in the chat.`,
  cantTell: (label: string) =>
    `Genex could not tell whether the person is using ${label}, so this waited for them, and still could not tell. Try again later.`,
  busy: (label: string, title: string | null) =>
    `${title ? `"${title}"` : "Another call"} is working in ${label} now, and only one at a time works there.`,
} as const;

/** A lock and the plugin that declares it (Genex's own under `@genex`). */
export interface LockRef {
  plugin: string;
  lock: PluginLock;
}

/** A lock not given: whether the person kept using it (or Genex couldn't tell), or another holder kept it. */
export class LockRefused extends Error {
  readonly code: LockRefusal;
  readonly label: string;
  constructor(code: LockRefusal, label: string, message: string) {
    super(message);
    this.name = "LockRefused";
    this.code = code;
    this.label = label;
  }
}

/** Whether an error is a lock not given. */
export const isLockRefused = (error: unknown): error is LockRefused => error instanceof LockRefused;

/** What the chat hears while a call waits for the person (`UiEvent.PersonFirst`). */
export interface PersonFirstNotice {
  project: string;
  threadId?: string;
  label: string;
  waiting: boolean;
}

/** What a lock service is built with: the probe, the clock and its wait, and who hears of a wait on the person. */
export interface LockServiceOptions {
  /** Runs a lock's `personFirst` tool for a game; its raw answer is read by `personFirstOf`. */
  probe(plugin: string, lock: PluginLock, binding: PluginBinding, signal?: AbortSignal): Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** A signal that aborts once `ms` passed, on the same clock: a probe's call ends when its wait does. */
  timeout?: (ms: number) => AbortSignal;
  /** How long an agent's call waits (`AGENT_LOCK_WAIT_MS`). */
  agentWaitMs?: number;
  onPersonFirst?: (notice: PersonFirstNotice) => void;
}

/** How a call asks for its locks. */
export interface LockHoldOptions {
  /** The game the call is for, and the chat that hears of a wait on the person. */
  binding: PluginBinding;
  /** The chat that hears of a wait on the person, when not the binding's own. */
  threadId?: string;
  /** Ends a wait; never a held lock, which the caller releases. */
  signal?: AbortSignal;
  /** The person's own action: it never waits for the person. */
  forPerson?: boolean;
  /** Whether this hold gives way to the person (default: unless `forPerson`); an in-place writer's life does not, its calls do. */
  personFirst?: boolean;
  waitMs: number;
  /** Who holds: a call passes the locks its holder already holds. */
  holder: string;
  /** The holder's title, for another caller's words. */
  title?: string;
  /** A hold the harness asked for (a worker writing in place): let go whenever the harness ends, planned or not. */
  forHarness?: boolean;
  /**
   * A holder name prefix whose holds this hold passes as its own (`runHolders`): a run's moments
   * pass the locks the run's own workers hold, so Genex's recovery never waits on its own worker.
   */
  passes?: string;
}

/** Who holds one lock now (`holders`). */
export interface LockHeld {
  key: string;
  label: string;
  holder: string;
  title: string | null;
}

/** One waiter at a lock: handed the lock (`granted`), or told why it never will be. */
interface Waiter {
  holder: string;
  title: string | null;
  settle(outcome: true | Error): void;
  /** What it was told, once told. */
  outcome: true | Error | null;
}

/** One holder of a lock: how many holds deep, and its title. */
interface Hold {
  depth: number;
  title: string | null;
}

/**
 * One lock's state: who holds it (the holder it was granted to first, then any hold that passed
 * into it, each counted on its own), under which grant, and who waits, in order. The lock passes
 * on only once no holder has a hold left.
 */
interface Slot {
  label: string;
  owner: { holds: Map<string, Hold>; grant: object } | null;
  queue: Waiter[];
}

/** A lock's owner, granted to one holder that has not taken its hold yet. */
const ownerOf = (holder: string, title: string | null): NonNullable<Slot["owner"]> => ({
  holds: new Map([[holder, { depth: 0, title }]]),
  grant: {},
});

/** The holder a lock is named by: the one that holds it longest. */
const firstHold = (owner: NonNullable<Slot["owner"]>): [string, Hold] | undefined => owner.holds.entries().next().value;

/** How many holds a lock's holders have left, together. */
const depthOf = (owner: NonNullable<Slot["owner"]>): number =>
  [...owner.holds.values()].reduce((sum, hold) => sum + hold.depth, 0);

/** A game's lock key, or an app's (`app` locks are shared by every game). */
export function lockKey(plugin: string, lock: PluginLock, project: string): string {
  return lock.per === LockScope.App ? `${plugin}:${lock.id}` : `${project}:${plugin}:${lock.id}`;
}

/** The prefix every holder of a run's own workers starts with (`workerHolder`), which its moments pass. */
export const runHolders = (runId: string): string => `run:${runId}:`;

/** The prefix every holder of a chat's own workers starts with (`workerHolder`), which the chat's moments pass. */
export const chatHolders = (threadId: string): string => `chat:${threadId}:`;

/** The holder a worker's locks are kept under: the run that started it, else its chat, and its id. */
export function workerHolder(worker: { threadId: string; runId: string | null | undefined; id: string }): string {
  return `${worker.runId ? runHolders(worker.runId) : chatHolders(worker.threadId)}${worker.id}`;
}

/** Whether a hold may take a lock its current holders hold: its own, or one held by a holder it passes. */
function passesOwner(owner: NonNullable<Slot["owner"]>, options: LockHoldOptions): boolean {
  const { passes } = options;
  return [...owner.holds.keys()].some((held) => held === options.holder || (passes ? held.startsWith(passes) : false));
}

/** Genex's lock table: every lock held now, who waits for it, and the person first. */
export class LockService {
  readonly #slots = new Map<string, Slot>();
  /** Until when, per lock, a probe's "the person is not using it" stands. */
  readonly #fresh = new Map<string, number>();
  /** The holders the harness asked locks for, which its end lets go. */
  readonly #harnessHolders = new Set<string>();
  readonly #probe: LockServiceOptions["probe"];
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #timeout: (ms: number) => AbortSignal;
  readonly #onPersonFirst: LockServiceOptions["onPersonFirst"];
  /** How many calls wait on the person now, by game, chat and app (`#notify`). */
  readonly #personWaits = new Map<string, number>();
  /** How long an agent's call waits for its locks. */
  readonly agentWaitMs: number;

  constructor(options: LockServiceOptions) {
    this.#probe = options.probe;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms, signal) => sleepFor(ms, undefined, { signal }));
    this.#timeout = options.timeout ?? ((ms) => AbortSignal.timeout(ms));
    this.#onPersonFirst = options.onPersonFirst;
    this.agentWaitMs = options.agentWaitMs ?? AGENT_LOCK_WAIT_MS;
  }

  /**
   * Take `locks` for one holder, in key order (so two callers never hold one each), waiting first
   * come first served behind other holders and, unless the person acts or the hold says otherwise,
   * for the person. Answers the release, which frees each lock once; refuses with `LockRefused`
   * past `waitMs`, and with the signal's reason when it ends the wait. Nothing is held after a refusal.
   */
  async hold(locks: readonly LockRef[], options: LockHoldOptions): Promise<() => void> {
    const deadline = this.#now() + Math.max(0, options.waitMs);
    const releases: Array<() => void> = [];
    try {
      for (const ref of sortedRefs(locks, options.binding.project)) {
        releases.push(await this.#take(ref, options, deadline));
        if (asksPerson(options)) await this.#personFirst(ref, options, deadline);
      }
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
    if (options.forHarness) this.#harnessHolders.add(options.holder);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases.reverse()) release();
    };
  }

  /** Who holds each lock now. */
  holders(): LockHeld[] {
    return [...this.#slots.entries()].flatMap(([key, slot]) => {
      const first = slot.owner ? firstHold(slot.owner) : undefined;
      return first ? [{ key, label: slot.label, holder: first[0], title: first[1].title }] : [];
    });
  }

  /** A holder ended: every hold it has is let go, however deep; a lock passes on once no other holder holds it. */
  releaseHolder(holder: string): void {
    this.#harnessHolders.delete(holder);
    for (const [key, slot] of [...this.#slots]) {
      if (!slot.owner?.holds.delete(holder)) continue;
      if (depthOf(slot.owner) <= 0) this.#passOn(key, slot);
    }
  }

  /**
   * The harness ended, planned (a self-update, a restart) or not: every holder it asked locks for
   * lets go, since nothing of that harness will release them. Other holders keep theirs.
   */
  releaseHarnessHolds(): void {
    for (const holder of [...this.#harnessHolders]) this.releaseHolder(holder);
  }

  /**
   * How much unsaved work the probes of `locks` report for a game, summed: null when one can't
   * tell or a lock has no probe. Asked straight, holding nothing.
   */
  async unsaved(locks: readonly LockRef[], binding: PluginBinding, signal?: AbortSignal): Promise<number | null> {
    let total = 0;
    for (const ref of locks) {
      const answer = ref.lock.personFirst ? await this.#ask(ref, binding, signal) : null;
      if (answer?.unsaved === undefined) return null;
      total += answer.unsaved;
    }
    return total;
  }

  /** Take one lock: at once when free or already the holder's, else in turn behind the others, until the deadline. */
  async #take(ref: LockRef, options: LockHoldOptions, deadline: number): Promise<() => void> {
    const key = lockKey(ref.plugin, ref.lock, options.binding.project);
    const slot = this.#slotOf(key, ref.lock.label);
    if (!slot.owner) slot.owner = ownerOf(options.holder, options.title ?? null);
    else if (!passesOwner(slot.owner, options)) await this.#waitTurn(key, slot, options, deadline);
    const owner = slot.owner as NonNullable<Slot["owner"]>;
    const { holder } = options;
    const hold = owner.holds.get(holder) ?? { depth: 0, title: options.title ?? null };
    hold.depth += 1;
    owner.holds.set(holder, hold);
    const { grant } = owner;
    return () => {
      const current = this.#slots.get(key)?.owner;
      if (current?.grant !== grant) return;
      const mine = current.holds.get(holder);
      if (mine) mine.depth -= 1;
      if (mine && mine.depth <= 0) current.holds.delete(holder);
      if (depthOf(current) <= 0) this.#passOn(key, this.#slots.get(key) as Slot);
    };
  }

  /** Wait behind the lock's holder and the waiters before this one; refused when the wait runs out or is stopped. */
  async #waitTurn(key: string, slot: Slot, options: LockHoldOptions, deadline: number): Promise<void> {
    const title = slot.owner ? (firstHold(slot.owner)?.[1].title ?? null) : null;
    const refusal = new LockRefused(LockRefusal.Busy, slot.label, MESSAGE.busy(slot.label, title));
    const left = deadline - this.#now();
    if (left <= 0) throw refusal;
    let settle: (outcome: true | Error) => void = () => {};
    const told = new Promise<true | Error>((resolve) => {
      settle = resolve;
    });
    const waiter: Waiter = {
      holder: options.holder,
      title: options.title ?? null,
      outcome: null,
      settle: (outcome) => {
        waiter.outcome = outcome;
        settle(outcome);
      },
    };
    slot.queue.push(waiter);
    const timer = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, timer.signal]) : timer.signal;
    const timedOut = this.#sleep(left, signal).then(
      () => null,
      () => null,
    );
    const outcome = await Promise.race([told, timedOut]);
    timer.abort();
    if (outcome === true) return;
    if (outcome instanceof Error) throw outcome;
    this.#leave(key, slot, waiter);
    options.signal?.throwIfAborted();
    throw refusal;
  }

  /** A waiter that gave up leaves the queue; one handed the lock as it gave up hands it on. */
  #leave(key: string, slot: Slot, waiter: Waiter): void {
    const at = slot.queue.indexOf(waiter);
    if (at >= 0) slot.queue.splice(at, 1);
    else if (waiter.outcome === true && slot.owner && depthOf(slot.owner) === 0) this.#passOn(key, slot);
  }

  /**
   * Ask the person first, again every poll, until they are not using it; refused past the deadline.
   * The chat hears of the wait only once a probe saw the person at it: a probe that can't tell (a busy
   * app that doesn't answer) waits without saying the person is using it.
   */
  async #personFirst(ref: LockRef, options: LockHoldOptions, deadline: number): Promise<void> {
    if (!ref.lock.personFirst) return;
    const key = lockKey(ref.plugin, ref.lock, options.binding.project);
    if ((this.#fresh.get(key) ?? 0) > this.#now()) return;
    let waiting = false;
    try {
      for (;;) {
        const answer = await this.#askWithin(ref, options, deadline);
        if (answer?.personActive === false) {
          this.#fresh.set(key, this.#now() + PERSON_FIRST_FRESH_MS);
          return;
        }
        const left = deadline - this.#now();
        if (left <= 0) throw personRefusal(ref.lock.label, answer);
        if (!waiting && answer?.personActive === true) {
          this.#notify(ref, options, true);
          waiting = true;
        }
        await this.#sleep(Math.min(PERSON_FIRST_POLL_MS, left), options.signal);
      }
    } finally {
      if (waiting) this.#notify(ref, options, false);
    }
  }

  /**
   * One probe's answer within what is left of the wait, or null (Genex can't tell) once the wait ran
   * out with the probe still asking: its call is ended then, so a slow probe never holds a call past
   * its wait, and never grants it a lock after. A hold that may not wait at all (`health`) asks once.
   */
  async #askWithin(ref: LockRef, options: LockHoldOptions, deadline: number): Promise<PersonFirstAnswer | null> {
    const left = deadline - this.#now();
    if (left <= 0) return this.#ask(ref, options.binding, options.signal);
    const waitEnds = this.#timeout(left);
    const signal = options.signal ? AbortSignal.any([options.signal, waitEnds]) : waitEnds;
    const answer = await this.#ask(ref, options.binding, signal);
    return waitEnds.aborted ? null : answer;
  }

  /** One probe's answer, or null when Genex can't tell (it threw, or answered something else). */
  async #ask(ref: LockRef, binding: PluginBinding, signal?: AbortSignal): Promise<PersonFirstAnswer | null> {
    try {
      return personFirstOf(await this.#probe(ref.plugin, ref.lock, binding, signal));
    } catch {
      return null;
    }
  }

  /**
   * The chat hears of a wait on the person once, while any of its calls waits on that app: a call
   * that begins waiting counts up, one that ends counts down, and only the first and the last say so.
   */
  #notify(ref: LockRef, options: LockHoldOptions, waiting: boolean): void {
    const threadId = options.threadId ?? options.binding.threadId;
    const key = [options.binding.project, threadId ?? "", ref.lock.label].join("\0");
    const before = this.#personWaits.get(key) ?? 0;
    const after = Math.max(0, before + (waiting ? 1 : -1));
    if (after === 0) this.#personWaits.delete(key);
    else this.#personWaits.set(key, after);
    const changed = (before === 0) !== (after === 0);
    if (!changed) return;
    this.#onPersonFirst?.({
      project: options.binding.project,
      ...(threadId ? { threadId } : {}),
      label: ref.lock.label,
      waiting,
    });
  }

  #slotOf(key: string, label: string): Slot {
    const known = this.#slots.get(key);
    if (known) return known;
    const slot: Slot = { label, owner: null, queue: [] };
    this.#slots.set(key, slot);
    return slot;
  }

  /** The lock goes to the next waiter in turn, or is free. */
  #passOn(key: string, slot: Slot): void {
    const next = slot.queue.shift();
    if (!next) {
      this.#slots.delete(key);
      return;
    }
    slot.owner = ownerOf(next.holder, next.title);
    next.settle(true);
  }
}

/** Locks in one order for every caller, each once. */
function sortedRefs(locks: readonly LockRef[], project: string): LockRef[] {
  const byKey = new Map(locks.map((ref) => [lockKey(ref.plugin, ref.lock, project), ref]));
  return [...byKey.keys()].sort().map((key) => byKey.get(key) as LockRef);
}

/** Whether a hold waits for the person. */
const asksPerson = (options: LockHoldOptions): boolean => !options.forPerson && options.personFirst !== false;

/** The refusal of a wait on the person: they kept using it, or Genex couldn't tell. */
function personRefusal(label: string, answer: { personActive: boolean } | null): LockRefused {
  if (!answer) return new LockRefused(LockRefusal.CantTell, label, MESSAGE.cantTell(label));
  return new LockRefused(LockRefusal.PersonFirst, label, MESSAGE.personUsing(label));
}

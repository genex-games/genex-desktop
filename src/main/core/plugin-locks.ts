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
import {
  HookHold,
  LockScope,
  type PersonFirstAnswer,
  type PluginLock,
  personFirstOf,
} from "../../shared/plugin-hooks.ts";
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
/**
 * How long a hold with no wait left asks the person's probe, once for the whole hold however many
 * locks it takes: one that may not wait at all (`health`), or one whose turn at the lock came only
 * as its wait ran out. Also the longest a read of what is unsaved asks.
 */
export const PERSON_FIRST_ASK_MS = PERSON_FIRST_POLL_MS;
/**
 * How long a refusal for the person stands for the next calls on the same lock: an agent's calls
 * sent together each ask once, briefly, instead of each waiting the whole wait again behind it.
 */
export const PERSON_REFUSAL_STANDS_MS = 30 * SECOND_MS;

/** The owner Genex's own locks are kept under: no plugin id can be spelled with `@`. */
const GENEX_OWNER = "@genex";

/** Genex's own lock on a game folder: the one worker writing in place there, across every pool of the game. */
export const IN_PLACE_LOCK: LockRef = {
  plugin: GENEX_OWNER,
  lock: { id: "in-place", label: "the game folder", per: LockScope.Project },
};

/**
 * Why a lock was not given: the person kept using what it guards, Genex couldn't tell whether they
 * did, another holder kept it, or the person wrote in the chat of the session that waited
 * (`LockHoldOptions.personWrote`). Answered to agents: never rename a value.
 */
export const LockRefusal = {
  PersonFirst: "person_first",
  CantTell: "cant_tell",
  Busy: "busy",
  PersonWrote: "person_wrote",
} as const;
export type LockRefusal = (typeof LockRefusal)[keyof typeof LockRefusal];

/**
 * Genex's hold (`HookHold`, the harness's own copy of it) for each lock refusal: what the person's
 * words are chosen by. The person writing is the person first too; it ends only an agent's wait,
 * never a moment's, so no surface words it for the person.
 */
export const HOLD_OF_REFUSAL = {
  [LockRefusal.PersonFirst]: HookHold.PersonFirst,
  [LockRefusal.CantTell]: HookHold.CantTell,
  [LockRefusal.Busy]: HookHold.Busy,
  [LockRefusal.PersonWrote]: HookHold.PersonFirst,
} as const satisfies Record<LockRefusal, HookHold>;

/** Words an agent (or a lead) reads when a lock was not given, each naming the lock's label. */
const MESSAGE = {
  personUsing: (label: string) =>
    `The person is using ${label}, and this waited for them to finish: they were still at it. Try again later, or ask them in the chat.`,
  cantTell: (label: string) =>
    `Genex could not tell whether the person is using ${label}, so this waited for them, and still could not tell. Try again later.`,
  busy: (label: string, title: string | null) =>
    `${title ? `"${title}"` : "Another call"} is working in ${label} now, and only one at a time works there.`,
  personWrote: (label: string) =>
    `The person just wrote in the chat, so this stopped waiting for ${label} and did not run. Read their message first; then call this tool again if you still need it.`,
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

/**
 * A session's word that the person wrote in its chat (`engine.steer`): its signal ends the waits for
 * a lock of the calls that took it (`LockHoldOptions.personWrote`), never a lock given or a call's run.
 */
export interface PersonWrote {
  /** The signal a call takes as it starts; replaced once it ended the waits begun before. */
  current: AbortController;
}

/** A session's word, before the person wrote anything. */
export function personWroteWatch(): PersonWrote {
  return { current: new AbortController() };
}

/** The person wrote: the waits begun before end now, and a call made after waits as usual. */
export function personWrote(watch: PersonWrote): void {
  const before = watch.current;
  watch.current = new AbortController();
  before.abort();
}

/** The person wrote and the session is cut at its next step: every wait ends now, and any later one at once. */
export function personWroteBeforeCut(watch: PersonWrote): void {
  watch.current.abort();
}

/** What the chat hears while a call waits for the person (`UiEvent.PersonFirst`). */
export interface PersonFirstNotice {
  project: string;
  threadId?: string;
  label: string;
  waiting: boolean;
}

/** What the chat hears once when an agent went ahead of the person (`CustomEvent.AgentWentAhead`). */
export interface WentAheadNotice {
  project: string;
  threadId?: string;
  label: string;
  plugin: string;
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
  /** Hears a probe that let an agent go ahead of the person for the first time (`PersonFirstAnswer.wentAhead`). */
  onWentAhead?: (notice: WentAheadNotice) => void;
}

/** How a call asks for its locks. */
export interface LockHoldOptions {
  /** The game the call is for, and the chat that hears of a wait on the person. */
  binding: PluginBinding;
  /** The chat that hears of a wait on the person, when not the binding's own. */
  threadId?: string;
  /** Ends a wait; never a held lock, which the caller releases. */
  signal?: AbortSignal;
  /**
   * Ends a wait, never a lock given, when the person writes in the chat of the session that called
   * (`PersonWrote`): refused `person_wrote`, so the agent reads the message before it calls again.
   */
  personWrote?: AbortSignal;
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
  /** The holders it passes (`LockHoldOptions.passes`): it joins them once nothing else holds the lock. */
  passes?: string;
  /** Whether it is a whole-life hold the harness asked for (`LockHoldOptions.forHarness`). */
  whole: boolean;
  /** The owner it was handed, its hold already counted there: a lock never passes on while a granted hold is on its way. */
  owner: Owner | null;
  settle(outcome: true | Error): void;
  /** What it was told, once told. */
  outcome: true | Error | null;
}

/** One hold's wait: when it runs out, and when the one short ask it may still make after that ends. */
interface HoldWait {
  deadline: number;
  lateAskEnds: number | null;
}

/** One holder of a lock: how many holds deep, how many of them whole-life holds the harness asked for, and its title. */
interface Hold {
  depth: number;
  whole: number;
  title: string | null;
}

/**
 * Who holds a lock under one grant: the holder it was granted to first, then any hold that passed
 * into it, each counted on its own. A new object for each grant, so a release of an earlier grant
 * frees nothing of a later one.
 */
interface Owner {
  holds: Map<string, Hold>;
}

/**
 * One lock's state: who holds it, and who waits, in order. The lock passes on only once no holder
 * has a hold left.
 */
interface Slot {
  label: string;
  owner: Owner | null;
  queue: Waiter[];
  /**
   * While a holder waits on the person, what the probe last said (null: it couldn't tell): a hold
   * queued behind it whose wait runs out is refused for the person, not as busy.
   */
  person?: PersonFirstAnswer | null;
}

/** The holder a lock is named by: the one that holds it longest. */
const firstHold = (owner: Owner): [string, Hold] | undefined => owner.holds.entries().next().value;

/** How many holds a lock's holders have left, together. */
const depthOf = (owner: Owner): number => [...owner.holds.values()].reduce((sum, hold) => sum + hold.depth, 0);

/** One more hold of `holder`, counted the moment it is given. */
function countHold(owner: Owner, holder: string, title: string | null, whole: boolean): void {
  const hold = owner.holds.get(holder) ?? { depth: 0, whole: 0, title };
  hold.depth += 1;
  if (whole) hold.whole += 1;
  owner.holds.set(holder, hold);
}

/** One hold of `holder` taken back; a holder with none left holds nothing. */
function uncountHold(owner: Owner, holder: string, whole: boolean): void {
  const hold = owner.holds.get(holder);
  if (!hold) return;
  hold.depth -= 1;
  if (whole) hold.whole = Math.max(0, hold.whole - 1);
  if (hold.depth <= 0) owner.holds.delete(holder);
}

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

/**
 * Whether a hold may take a lock its current holders hold: only when every one of them is itself,
 * or a holder it passes that holds this very lock for its whole life, as the harness asked
 * (`Hold.whole`). So two moments still go one at a time beside a worker writing in place, and none
 * walks into a worker's single call, on this lock or any other.
 */
function passesOwner(owner: Owner, options: Pick<LockHoldOptions, "holder" | "passes">): boolean {
  const { passes, holder } = options;
  const passed = (held: string, hold: Hold): boolean => (passes ? held.startsWith(passes) && hold.whole > 0 : false);
  return [...owner.holds].every(([held, hold]) => held === holder || passed(held, hold));
}

/** Genex's lock table: every lock held now, who waits for it, and the person first. */
export class LockService {
  readonly #slots = new Map<string, Slot>();
  /** Until when, per lock, a probe's "the person is not using it" stands. */
  readonly #fresh = new Map<string, number>();
  /** Until when, per lock, a refusal for the person stands: the next calls ask once, briefly. */
  readonly #refusedForPerson = new Map<string, number>();
  /** The holders the harness asked locks for, which its end lets go. */
  readonly #harnessHolders = new Set<string>();
  readonly #probe: LockServiceOptions["probe"];
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #timeout: (ms: number) => AbortSignal;
  readonly #onPersonFirst: LockServiceOptions["onPersonFirst"];
  readonly #onWentAhead: LockServiceOptions["onWentAhead"];
  /** How many calls wait on the person now, by game, chat and app (`#notify`). */
  readonly #personWaits = new Map<string, number>();
  /** How long an agent's call waits for its locks. */
  readonly agentWaitMs: number;
  /** The locks' clock: now, and a signal that aborts once `ms` passed on it (a call's deadline runs on it). */
  readonly clock: { now(): number; timeout(ms: number): AbortSignal };

  constructor(options: LockServiceOptions) {
    this.#probe = options.probe;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms, signal) => sleepFor(ms, undefined, { signal }));
    this.#timeout = options.timeout ?? ((ms) => AbortSignal.timeout(ms));
    this.#onPersonFirst = options.onPersonFirst;
    this.#onWentAhead = options.onWentAhead;
    this.agentWaitMs = options.agentWaitMs ?? AGENT_LOCK_WAIT_MS;
    this.clock = { now: this.#now, timeout: this.#timeout };
  }

  /**
   * Take `locks` for one holder, in key order (so two callers never hold one each), waiting first
   * come first served behind other holders and, unless the person acts or the hold says otherwise,
   * for the person. Answers the release, which frees each lock once; refuses with `LockRefused`
   * past `waitMs`, and with the signal's reason when it ends the wait. Nothing is held after a refusal.
   */
  async hold(locks: readonly LockRef[], options: LockHoldOptions): Promise<() => void> {
    const wait: HoldWait = { deadline: this.#now() + Math.max(0, options.waitMs), lateAskEnds: null };
    const releases: Array<() => void> = [];
    try {
      for (const ref of sortedRefs(locks, options.binding.project)) {
        // A hold whose wait was stopped (before it began, or as a lock was given) takes nothing.
        options.signal?.throwIfAborted();
        releases.push(await this.#take(ref, options, wait.deadline));
        if (asksPerson(options)) await this.#personFirst(ref, options, wait);
      }
      options.signal?.throwIfAborted();
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
    if (options.forHarness) this.#wholeLifeHeld(options.holder);
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
      else this.#admit(slot);
    }
  }

  /**
   * A whole-life hold the harness asked for is held: its end lets it go. The waiters that pass it
   * (the run's own moments) joined it as each lock was given (`#grant`), never waiting out its life.
   */
  #wholeLifeHeld(holder: string): void {
    this.#harnessHolders.add(holder);
  }

  /** The holders the harness asked locks for (its workers writing in place), which its end lets go. */
  harnessHolders(): string[] {
    return [...this.#harnessHolders];
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
      const asked = { binding, ...(signal ? { signal } : {}) };
      const answer = ref.lock.personFirst ? await this.#askWithin(ref, asked, PERSON_FIRST_ASK_MS) : null;
      if (answer?.unsaved === undefined) return null;
      total += answer.unsaved;
    }
    return total;
  }

  /** Take one lock: at once when free or already the holder's, else in turn behind the others, until the deadline. */
  async #take(ref: LockRef, options: LockHoldOptions, deadline: number): Promise<() => void> {
    const key = lockKey(ref.plugin, ref.lock, options.binding.project);
    const slot = this.#slotOf(key, ref.lock.label);
    const { holder } = options;
    const whole = options.forHarness === true;
    let owner: Owner;
    if (slot.owner && !passesOwner(slot.owner, options)) owner = await this.#waitTurn(key, slot, options, deadline);
    else {
      slot.owner ??= { holds: new Map() };
      owner = slot.owner;
      countHold(owner, holder, options.title ?? null, whole);
    }
    // A hold given while its taker was on its way, then let go with its holder (`releaseHolder`), holds nothing.
    if (this.#slots.get(key)?.owner !== owner || !owner.holds.has(holder)) throw refusalBehind(slot);
    return () => {
      const current = this.#slots.get(key);
      if (current?.owner !== owner) return;
      uncountHold(owner, holder, whole);
      if (depthOf(owner) <= 0) this.#passOn(key, current);
      else this.#admit(current);
    };
  }

  /**
   * Wait behind the lock's holder and the waiters before this one, answering the owner it was handed
   * (its hold counted there); refused when the wait runs out or is stopped.
   */
  async #waitTurn(key: string, slot: Slot, options: LockHoldOptions, deadline: number): Promise<Owner> {
    const left = deadline - this.#now();
    if (left <= 0) throw refusalBehind(slot);
    if (options.personWrote?.aborted) throw personWroteRefusal(slot.label);
    let settle: (outcome: true | Error) => void = () => {};
    const told = new Promise<true | Error>((resolve) => {
      settle = resolve;
    });
    const waiter: Waiter = {
      holder: options.holder,
      title: options.title ?? null,
      ...(options.passes ? { passes: options.passes } : {}),
      whole: options.forHarness === true,
      owner: null,
      outcome: null,
      settle: (outcome) => {
        waiter.outcome = outcome;
        settle(outcome);
      },
    };
    slot.queue.push(waiter);
    const timer = new AbortController();
    const signal = AbortSignal.any([...waitSignals(options), timer.signal]);
    const timedOut = this.#sleep(left, signal).then(
      () => null,
      () => null,
    );
    const outcome = await Promise.race([told, timedOut]);
    timer.abort();
    if (outcome === true && waiter.owner) return waiter.owner;
    if (outcome instanceof Error) throw outcome;
    this.#leave(key, slot, waiter);
    options.signal?.throwIfAborted();
    if (options.personWrote?.aborted) throw personWroteRefusal(slot.label);
    throw refusalBehind(slot);
  }

  /**
   * A waiter that gave up leaves the queue, and the waiters behind it that may pass every holder
   * join now; one handed the lock as it gave up takes back the hold it was given and hands it on.
   */
  #leave(key: string, slot: Slot, waiter: Waiter): void {
    const at = slot.queue.indexOf(waiter);
    if (at >= 0) {
      slot.queue.splice(at, 1);
      if (slot.owner) this.#admit(slot);
      return;
    }
    const { owner } = waiter;
    if (!owner || this.#slots.get(key)?.owner !== owner) return;
    uncountHold(owner, waiter.holder, waiter.whole);
    if (depthOf(owner) <= 0) this.#passOn(key, slot);
    else this.#admit(slot);
  }

  /**
   * A holder let go while others still hold the lock: the next waiters in turn join them while
   * they may pass every holder left (`passesOwner`), never ahead of one that may not.
   */
  #admit(slot: Slot): void {
    for (let next = slot.queue[0]; next; next = slot.queue[0]) {
      const { owner } = slot;
      if (!owner || !passesOwner(owner, next)) return;
      slot.queue.shift();
      grant(owner, next);
    }
  }

  /**
   * Ask the person first, again every poll, until they are not using it; refused past the deadline,
   * with what the last probe said: once the wait has run out the probe is never asked again. The
   * chat hears of the wait only once a probe saw the person at it: a probe that can't tell (a busy
   * app that doesn't answer) waits without saying the person is using it.
   */
  async #personFirst(ref: LockRef, options: LockHoldOptions, wait: HoldWait): Promise<void> {
    if (!ref.lock.personFirst) return;
    const key = lockKey(ref.plugin, ref.lock, options.binding.project);
    if ((this.#fresh.get(key) ?? 0) > this.#now()) return;
    const slot = this.#slots.get(key);
    const told = { waiting: false };
    try {
      await this.#untilFree(key, ref, options, this.#waitAfterRefusal(key, wait), (answer) => {
        if (slot) slot.person = answer;
        if (told.waiting || answer?.personActive !== true) return;
        this.#notify(ref, options, true);
        told.waiting = true;
      });
      this.#refusedForPerson.delete(key);
    } catch (error) {
      if (error instanceof LockRefused && error.code === LockRefusal.PersonFirst)
        this.#refusedForPerson.set(key, this.#now() + PERSON_REFUSAL_STANDS_MS);
      throw error;
    } finally {
      if (slot) delete slot.person;
      if (told.waiting) this.#notify(ref, options, false);
    }
  }

  /**
   * A hold's wait on the person: its own, or one short ask while a refusal for the person on this
   * lock still stands (`PERSON_REFUSAL_STANDS_MS`).
   */
  #waitAfterRefusal(key: string, wait: HoldWait): HoldWait {
    const now = this.#now();
    if ((this.#refusedForPerson.get(key) ?? 0) <= now) return wait;
    return { deadline: Math.min(wait.deadline, now + PERSON_FIRST_ASK_MS), lateAskEnds: wait.lateAskEnds };
  }

  /**
   * The probe asked until it says the person is not at it (that answer then stands a while), each
   * other answer handed to `seen`; refused, in the last answer's words, once the wait runs out.
   */
  async #untilFree(
    key: string,
    ref: LockRef,
    options: LockHoldOptions,
    wait: HoldWait,
    seen: (answer: PersonFirstAnswer | null) => void,
  ): Promise<void> {
    const { deadline } = wait;
    let answer = await this.#probed(key, ref, options, this.#firstAskMs(wait));
    for (;;) {
      if (answer?.personActive === false) {
        this.#fresh.set(key, this.#now() + PERSON_FIRST_FRESH_MS);
        if (answer.wentAhead) this.#toldWentAhead(ref, options);
        return;
      }
      if (deadline - this.#now() <= 0) throw personRefusal(ref.lock.label, answer);
      seen(answer);
      await this.#pause(Math.min(PERSON_FIRST_POLL_MS, deadline - this.#now()), options, ref.lock.label);
      const remaining = deadline - this.#now();
      if (remaining <= 0) throw personRefusal(ref.lock.label, answer);
      answer = await this.#probed(key, ref, options, remaining);
    }
  }

  /**
   * A pause in a wait on the person, ended by the call's stop (with its reason) or by the person
   * writing in the chat of its session (refused `person_wrote`, naming the lock it waited for).
   */
  async #pause(ms: number, options: LockHoldOptions, label: string): Promise<void> {
    if (options.personWrote?.aborted) throw personWroteRefusal(label);
    const signals = waitSignals(options);
    try {
      await this.#sleep(ms, signals.length ? AbortSignal.any(signals) : undefined);
    } catch (error) {
      if (options.personWrote?.aborted && !options.signal?.aborted) throw personWroteRefusal(label);
      throw error;
    }
  }

  /** One probe's answer (`#askWithin`); one that sees the person at it takes back any earlier "not at it". */
  async #probed(
    key: string,
    ref: LockRef,
    options: LockHoldOptions,
    withinMs: number,
  ): Promise<PersonFirstAnswer | null> {
    const answer = await this.#askWithin(ref, options, withinMs);
    if (answer?.personActive === true) this.#fresh.delete(key);
    return answer;
  }

  /**
   * How long a lock's first probe may take: what is left of the wait, and when that is less than one
   * short ask (a hold that may not wait, or one whose turn came only as its wait ran out), that
   * short ask, once for the whole hold: a later lock of it asks only within what is left of it.
   */
  #firstAskMs(wait: HoldWait): number {
    const now = this.#now();
    const left = wait.deadline - now;
    if (left >= PERSON_FIRST_ASK_MS) return left;
    wait.lateAskEnds ??= now + PERSON_FIRST_ASK_MS;
    return wait.lateAskEnds - now;
  }

  /**
   * One probe's answer within `withinMs`, or null (Genex can't tell) once that ran out with the probe
   * still asking: its call is ended then, so a slow probe never holds a call past its wait, and
   * never grants it a lock after.
   */
  async #askWithin(
    ref: LockRef,
    options: Pick<LockHoldOptions, "binding" | "signal">,
    withinMs: number,
  ): Promise<PersonFirstAnswer | null> {
    if (withinMs <= 0) return null;
    const waitEnds = this.#timeout(withinMs);
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

  /** The chat the call answers to hears that an agent went ahead of the person in what the lock guards. */
  #toldWentAhead(ref: LockRef, options: LockHoldOptions): void {
    const threadId = options.threadId ?? options.binding.threadId;
    this.#onWentAhead?.({
      project: options.binding.project,
      ...(threadId ? { threadId } : {}),
      label: ref.lock.label,
      plugin: ref.plugin,
    });
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

  /** The lock goes to the next waiter in turn (and the waiters behind it that pass it), or is free. */
  #passOn(key: string, slot: Slot): void {
    const next = slot.queue.shift();
    if (!next) {
      slot.owner = null;
      this.#slots.delete(key);
      return;
    }
    slot.owner = { holds: new Map() };
    grant(slot.owner, next);
    this.#admit(slot);
  }
}

/** A waiter handed the lock: its hold counted in `owner` now, before it goes on. */
function grant(owner: Owner, waiter: Waiter): void {
  countHold(owner, waiter.holder, waiter.title, waiter.whole);
  waiter.owner = owner;
  waiter.settle(true);
}

/** Locks in one order for every caller, each once. */
function sortedRefs(locks: readonly LockRef[], project: string): LockRef[] {
  const byKey = new Map(locks.map((ref) => [lockKey(ref.plugin, ref.lock, project), ref]));
  return [...byKey.keys()].sort().map((key) => byKey.get(key) as LockRef);
}

/** Whether a hold waits for the person. */
const asksPerson = (options: LockHoldOptions): boolean => !options.forPerson && options.personFirst !== false;

/**
 * The refusal of a wait behind another holder: for the person when that holder waits on them (or
 * on a probe that can't tell), else busy, naming the holder.
 */
function refusalBehind(slot: Slot): LockRefused {
  if (slot.person !== undefined) return personRefusal(slot.label, slot.person);
  const title = slot.owner ? (firstHold(slot.owner)?.[1].title ?? null) : null;
  return new LockRefused(LockRefusal.Busy, slot.label, MESSAGE.busy(slot.label, title));
}

/** What ends a hold's waits: its call's stop, and the person writing in the chat of its session. */
function waitSignals(options: Pick<LockHoldOptions, "signal" | "personWrote">): AbortSignal[] {
  return [options.signal, options.personWrote].filter((signal): signal is AbortSignal => signal !== undefined);
}

/** The refusal of a wait the person's message in the chat ended. */
function personWroteRefusal(label: string): LockRefused {
  return new LockRefused(LockRefusal.PersonWrote, label, MESSAGE.personWrote(label));
}

/** The refusal of a wait on the person: they kept using it, or Genex couldn't tell. */
function personRefusal(label: string, answer: { personActive: boolean } | null): LockRefused {
  if (!answer) return new LockRefused(LockRefusal.CantTell, label, MESSAGE.cantTell(label));
  return new LockRefused(LockRefusal.PersonFirst, label, MESSAGE.personUsing(label));
}

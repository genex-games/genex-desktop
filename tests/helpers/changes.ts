/**
 * Waiting on what happened: a fake tells a `Changes` of each thing a test may wait for, and
 * `until` reads the state again on each. A wait on a clock or on a count of event-loop turns fails
 * at random on a busy machine, where the work takes longer than the test guessed. `until` waits for
 * good, so a case that a regression would leave waiting carries a `timeout` of its own.
 */

/** Something a test waits to be told of: a promise for the next change, and its signal. */
export class Changes {
  #waiters: Array<() => void> = [];
  /** The next change. Ask for it before reading the state it changes, so none is missed. */
  next(): Promise<void> {
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
  /** A change happened: everyone waiting hears it. */
  notify(): void {
    for (const resolve of this.#waiters.splice(0)) resolve();
  }
}

/** Wait until `done` holds, reading it again on each change. */
export async function until(changes: Changes, done: () => boolean | Promise<boolean>): Promise<void> {
  for (;;) {
    const next = changes.next();
    if (await done()) return;
    await next;
  }
}

/**
 * Holding the Mac awake for an unattended run. Unattended-first: App Nap is held off from the
 * moment a run starts until it has settled, and "held" doubles as main's run-active signal (a
 * window close hides instead, a quit asks first, an account change waits).
 */
import { MINUTE_MS } from "../shared/duration.ts";
import { UiEvent } from "../shared/ui-events.ts";

/** How long the Mac is held awake for a stop the harness never confirms (a dead child). */
export const KEEP_AWAKE_FALLBACK_MS = 5 * MINUTE_MS;

/** Electron's `powerSaveBlocker`, reduced to what the hold uses; tests pass a recorder. */
export interface PowerSaveBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

/** The timer the fallback is armed with; injectable so a test need not wait five minutes. */
export interface FallbackTimers {
  setTimeout(callback: () => void, ms: number): { unref?(): unknown };
  clearTimeout(handle: { unref?(): unknown }): void;
}

const realTimers: FallbackTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class KeepAwake {
  readonly #blocker: PowerSaveBlocker;
  readonly #timers: FallbackTimers;
  #id: number | null = null;
  /** Armed when a stop is requested, so a harness that dies mid-settle cannot leak the blocker. */
  #fallback: { unref?(): unknown } | null = null;

  constructor(blocker: PowerSaveBlocker, timers: FallbackTimers = realTimers) {
    this.#blocker = blocker;
    this.#timers = timers;
  }

  /** A run is being held for. */
  get held(): boolean {
    return this.#id !== null;
  }

  /** Start holding, once; a second hold while held is the same hold. */
  hold(): void {
    if (this.#id === null) this.#id = this.#blocker.start("prevent-app-suspension");
  }

  /**
   * The run lifecycle as main sees it on the UI event stream. The run is over, however it ended —
   * stop holding the Mac awake for it. `run.settled` fires after the post-run self-improvement
   * pass too — the run's evidence would go unmined if the Mac napped the moment `run.finished`
   * landed. `run.failed` is the belt.
   */
  observe(event: UiEvent): void {
    if (event.type === UiEvent.RunKeepawake) {
      this.hold();
      // A run announcing itself disarms the fallback a previous stop left running — the timer is
      // for a harness that died mid-settle, not for the next run.
      this.disarmFallback();
    }
    if (event.type === UiEvent.RunSettled || event.type === UiEvent.RunFailed) this.release();
  }

  /**
   * A stop was requested: asking a run to stop is not the run ending, so the hold stays, but
   * a harness that never reports back cannot keep it forever. A no-op with nothing held or a
   * fallback already armed; the timer never holds the app open.
   */
  armFallback(): void {
    if (this.#id === null || this.#fallback !== null) return;
    this.#fallback = this.#timers.setTimeout(() => this.release(), KEEP_AWAKE_FALLBACK_MS);
    this.#fallback.unref?.();
  }

  disarmFallback(): void {
    if (this.#fallback === null) return;
    this.#timers.clearTimeout(this.#fallback);
    this.#fallback = null;
  }

  release(): void {
    this.disarmFallback();
    if (this.#id !== null) {
      this.#blocker.stop(this.#id);
      this.#id = null;
    }
  }
}

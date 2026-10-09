/**
 * Preview pool — N observation ports on games, addressed by handle.
 *
 * The visible WebContentsView is the reserved `"live"` port; headless ports are created on
 * demand by a factory the Electron layer injects (a hidden window reusing the same `game://`
 * protocol). The pool itself is Electron-free: what a port *is* stays the caller's business,
 * the pool only leases and routes.
 *
 * The live view is the person's. A harness call that names no window reaches the stand-in (a
 * hidden window of its own, `STAND_IN_HANDLE`) wherever this build can make one, so nothing the
 * harness does changes what the person is watching; a build with no headless capability still
 * has only the live view.
 */
import { shortId } from "./ids.ts";
import { DEFAULT_BUILDERS, LEAD_WINDOWS, MAX_BUILDERS } from "../shared/builders.ts";
import type { PreviewPort } from "./preview-port.ts";

export const LIVE_HANDLE = "live";
/** The hidden window that stands in for the live view when the harness names no window. */
export const STAND_IN_HANDLE = "stand-in";

/** The smallest size one leased window may take (`resize`): below 320×240 no game lays out. */
export const VIEWPORT_MIN = { width: 320, height: 240 } as const;
/** The largest size one leased window may take (`resize`): a 1920×1200 display; 1600×900 fits. */
export const VIEWPORT_MAX = { width: 1920, height: 1200 } as const;

/** A window's size in pixels. */
export interface ViewSize {
  width: number;
  height: number;
}

const MESSAGE = {
  NoHeadless: "this build has no headless preview capability — only the live view exists",
  BadViewport: "a window size is two finite positive numbers of pixels (width, height)",
  NotALease: (handle: string) => `only a leased pooled window changes size, never ${handle}`,
  NoViewport: (handle: string) => `preview window ${handle} cannot change size`,
  Exhausted: (leased: number, max: number) =>
    `preview pool exhausted (${leased}/${max} leased) — release a handle first`,
  UnknownHandle: (handle: string) => `unknown preview handle: ${handle}`,
} as const;

export interface PreviewLease {
  handle: string;
  port: PreviewPort;
}

export interface PreviewPoolOptions {
  live: PreviewPort;
  /** Absent = this build has no headless capability; `acquire` then refuses loudly. */
  createHeadless?: (options?: { purpose?: "optimization" }) => Promise<PreviewPort>;
  /** Max concurrent headless leases (the live view is not counted). */
  max?: number;
}

/**
 * The most hidden windows sessions may hold past the pool's ceiling (`acquire` with `overflow`), so
 * a session never borrows the person's window. Each is a renderer process with its own GPU context:
 * past a few, memory runs short and Chromium starts dropping the oldest WebGL contexts, which can
 * be Live's. A session past this waits for a window to close.
 */
export const OVERFLOW_WINDOWS_MAX = 2;

/** The most leases at once: past this the provider's rate limit, not the machine, decides. */
export const MAX_POOL_MAX = MAX_BUILDERS + LEAD_WINDOWS;
/** Headless leases at once by default: every builder the setting allows, plus the lead's windows. */
export const DEFAULT_POOL_MAX = DEFAULT_BUILDERS + LEAD_WINDOWS;

export class PreviewPool {
  readonly #live: PreviewPort;
  readonly #createHeadless: ((options?: { purpose?: "optimization" }) => Promise<PreviewPort>) | undefined;
  #max: number;
  /** Hidden windows held, opening or still closing: what the ceiling (and the overflow past it) counts. */
  #reserved = 0;
  readonly #creating = new Set<Promise<PreviewPort>>();
  readonly #retiring = new Map<string, Promise<void>>();
  /** The lease ceiling, for schedulers that size parallelism to it. */
  get max(): number {
    return this.#max;
  }
  /** The "agents at once" setting changes it live; leases already held are never revoked. */
  set max(value: number) {
    this.#max = Math.max(0, Math.min(MAX_POOL_MAX, Math.round(value)));
    this.#wakeWaiters();
  }
  /**
   * `owner` names who gives a lease back when its own `finally` can no longer run — a harness
   * boot (see {@link PreviewPool.releaseOwnedBy}). Leases the host holds for itself carry none.
   */
  readonly #leases = new Map<string, { port: PreviewPort; label: string; owner?: string; resized?: boolean }>();
  /**
   * The stand-in, while it is open. It is not a lease: it replaces the live view the harness used
   * to drive, so it neither takes a builder's window nor counts toward `leaseCount`.
   */
  #standIn: Promise<PreviewPort> | null = null;
  #standInPort: PreviewPort | null = null;
  /** Sessions waiting for an overflow window, in the order they asked; each looks again when a window closes. */
  readonly #waiters = new Set<() => void>();

  constructor(options: PreviewPoolOptions) {
    this.#live = options.live;
    this.#createHeadless = options.createHeadless;
    this.#max = Math.max(0, options.max ?? DEFAULT_POOL_MAX);
  }

  get leaseCount(): number {
    return this.#leases.size;
  }

  /** Whether this build can open hidden windows at all. */
  get headless(): boolean {
    return Boolean(this.#createHeadless);
  }

  leases(): Array<{ handle: string; label: string }> {
    return [...this.#leases.entries()].map(([handle, lease]) => ({ handle, label: lease.label }));
  }

  /**
   * A hidden window. `overflow` is for a host session whose only other choice was the person's own
   * window: it may go past `max` by up to `OVERFLOW_WINDOWS_MAX`, waits (until `signal` aborts) for
   * a window to close beyond that, and gives the window back from its own `finally`.
   */
  async acquire(options: {
    label: string;
    purpose?: "optimization";
    owner?: string;
    overflow?: boolean;
    signal?: AbortSignal;
  }): Promise<PreviewLease> {
    const create = this.#createHeadless;
    if (!create) {
      throw new Error(MESSAGE.NoHeadless);
    }
    if (this.#reserved >= this.#max && !options.overflow) {
      throw new Error(MESSAGE.Exhausted(this.#reserved, this.#max));
    }
    if (options.overflow) await this.#overflowRoom(options.signal);
    else this.#reserved++;
    let port: PreviewPort;
    const creation = Promise.resolve().then(() => create({ purpose: options.purpose }));
    this.#creating.add(creation);
    try {
      port = await creation;
    } catch (error) {
      this.#reserved--;
      this.#wakeWaiters();
      throw error;
    } finally {
      this.#creating.delete(creation);
    }
    const handle = shortId("pv");
    this.#leases.set(handle, { port, label: options.label, ...(options.owner ? { owner: options.owner } : {}) });
    return { handle, port };
  }

  /**
   * Wait until an overflow window fits, then reserve its place before anything else runs, so the
   * sessions woken together take the room one at a time.
   */
  async #overflowRoom(signal: AbortSignal | undefined): Promise<void> {
    while (this.#reserved >= this.#max + OVERFLOW_WINDOWS_MAX) {
      signal?.throwIfAborted();
      await this.#nextClose(signal);
    }
    signal?.throwIfAborted();
    this.#reserved++;
  }

  /** Resolves when a window closes (or the ceiling rises); rejects when `signal` aborts first. */
  #nextClose(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = (): void => {
        this.#waiters.delete(done);
        signal?.removeEventListener("abort", done);
        if (signal?.aborted) reject(signal.reason);
        else resolve();
      };
      this.#waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  #wakeWaiters(): void {
    for (const wake of [...this.#waiters]) wake();
  }

  async release(handle: string): Promise<void> {
    if (handle === LIVE_HANDLE) return; // the live view is never disposed
    const retiring = this.#retiring.get(handle);
    if (retiring) return retiring;
    const lease = this.#leases.get(handle);
    if (!lease) return; // releasing twice is a no-op, not an error
    this.#leases.delete(handle);
    const disposal = Promise.resolve()
      .then(() => restoreSize(lease))
      .then(() => lease.port.dispose?.())
      .then(() => {
        this.#reserved--;
        this.#retiring.delete(handle);
        // Only a window really gone makes room for a session waiting past the ceiling.
        this.#wakeWaiters();
      });
    // A failed cleanup keeps its reservation: the underlying session is not safe to reuse.
    this.#retiring.set(handle, disposal);
    await disposal;
  }

  /**
   * Put one leased window at another size, for that lease only, and answer the size it took:
   * `asked` clamped to {@link VIEWPORT_MIN}…{@link VIEWPORT_MAX} and rounded. Live and the stand-in
   * never change size. A size that is not two finite positive numbers, a handle that is no lease
   * and a window that cannot change size are refused before anything moves. The window is back
   * at the size it opened at when the lease is released (`release`, `disposeAll`) or `restoreSize`.
   */
  resize(handle: string, asked: { width: unknown; height: unknown }): ViewSize {
    const size = viewportSize(asked);
    if (!size) throw new Error(MESSAGE.BadViewport);
    if (handle === LIVE_HANDLE || handle === STAND_IN_HANDLE) throw new Error(MESSAGE.NotALease(handle));
    const lease = this.#leases.get(handle);
    if (!lease) throw new Error(MESSAGE.UnknownHandle(handle));
    if (!lease.port.setViewSize) throw new Error(MESSAGE.NoViewport(handle));
    lease.port.setViewSize(size);
    lease.resized = true;
    return size;
  }

  /** A resized lease back at the size its window opened at; a lease never resized is left alone. */
  restoreSize(handle: string): void {
    const lease = this.#leases.get(handle);
    if (lease) restoreSize(lease);
  }

  /**
   * Open the stand-in, or answer the one already open. `opened` says this call made it, so the
   * caller can put into it what the harness expects to find there.
   */
  async standIn(): Promise<{ handle: string; opened: boolean }> {
    const create = this.#createHeadless;
    if (!create) throw new Error(MESSAGE.NoHeadless);
    if (this.#standIn) {
      await this.#standIn;
      return { handle: STAND_IN_HANDLE, opened: false };
    }
    const opening = create();
    this.#standIn = opening;
    let port: PreviewPort;
    try {
      port = await opening;
    } catch (error) {
      if (this.#standIn === opening) this.#standIn = null;
      throw error;
    }
    // Closed while it was opening: this window is nobody's, and the caller gets a fresh one.
    if (this.#standIn !== opening) {
      await port.dispose?.();
      return this.standIn();
    }
    this.#standInPort = port;
    return { handle: STAND_IN_HANDLE, opened: true };
  }

  /** Close the stand-in; the next harness call that names no window opens a fresh one. */
  async closeStandIn(): Promise<void> {
    const port = this.#standInPort;
    this.#standIn = null;
    this.#standInPort = null;
    await port?.dispose?.();
  }

  /** Undefined or "live" ⇒ the visible view — the back-compat path every old caller takes. */
  port(handle?: string): PreviewPort {
    if (handle === undefined || handle === LIVE_HANDLE) return this.#live;
    if (handle === STAND_IN_HANDLE) {
      if (!this.#standInPort) throw new Error(MESSAGE.UnknownHandle(handle));
      return this.#standInPort;
    }
    const lease = this.#leases.get(handle);
    if (!lease) throw new Error(MESSAGE.UnknownHandle(handle));
    return lease.port;
  }

  /** Release every lease `owner` took — a dead harness never reaches its own release. Returns their handles. */
  async releaseOwnedBy(owner: string): Promise<string[]> {
    const handles = [...this.#leases.entries()].filter(([, lease]) => lease.owner === owner).map(([handle]) => handle);
    for (const handle of handles) await this.release(handle);
    return handles;
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled(this.#creating);
    const handles = [...this.#leases.keys()];
    for (const handle of handles) await this.release(handle);
    await Promise.all(this.#retiring.values());
    await this.closeStandIn();
  }
}

/** `asked` as a window size, clamped and rounded; null when either side is not a finite positive number. */
function viewportSize(asked: { width: unknown; height: unknown } | null | undefined): ViewSize | null {
  const width = asked?.width;
  const height = asked?.height;
  if (!isPixels(width) || !isPixels(height)) return null;
  return {
    width: clamp(Math.round(width), VIEWPORT_MIN.width, VIEWPORT_MAX.width),
    height: clamp(Math.round(height), VIEWPORT_MIN.height, VIEWPORT_MAX.height),
  };
}

function isPixels(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Put a resized lease's window back at its own size. A window that fails to is closing anyway. */
function restoreSize(lease: { port: PreviewPort; resized?: boolean }): void {
  if (!lease.resized) return;
  lease.resized = false;
  try {
    lease.port.setViewSize?.(null);
  } catch {
    /* the window is closing or gone: nothing is left at the other size */
  }
}

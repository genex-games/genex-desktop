/**
 * A hidden worker window paints only while it is used. An offscreen window paints its own frames
 * at 60 fps for as long as it is leased, and a builder holds its window through minutes of
 * writing code it never looks at: up to eight renderers drawing a game nobody watches. Any call
 * on the port starts painting before it runs, a call still out keeps it painting however long it
 * takes, and once nothing has called for {@link PAINT_IDLE_MS} the window stops painting, and the
 * game in it stops getting frames, until the next call. Electron-free: the caller says what
 * starting and stopping a window's painting is.
 */
import { MINUTE_MS } from "../shared/duration.ts";

/** How long a hidden window keeps painting after the last call on it ended. */
export const PAINT_IDLE_MS = MINUTE_MS;

/** Calls that only read what the port already knows, or close it: none of them needs a frame. */
const QUIET_CALLS: ReadonlySet<PropertyKey> = new Set(["status", "consoleEntries", "note", "dispose", "destroy"]);
/** Calls after which the window is gone: its timer goes with it. */
const CLOSING_CALLS: ReadonlySet<PropertyKey> = new Set(["dispose", "destroy"]);

/** Starts and stops one window's painting; `start` is only called on a window that stopped. */
export interface Painter {
  start(): void;
  stop(): void;
}

/** The timeouts the idle time runs on; tests pass their own. */
export interface IdleTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const hostTimers: IdleTimers = {
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * `port`, painting only while it is used. Methods are called on `port` itself (its private fields
 * stay reachable); properties set on the answer, such as an owner's `dispose`, land on `port`.
 */
export function paintWhileUsed<T extends object>(
  port: T,
  painter: Painter,
  options: { idleMs?: number; timers?: IdleTimers } = {},
): T {
  const idleMs = options.idleMs ?? PAINT_IDLE_MS;
  const timers = options.timers ?? hostTimers;
  let painting = true;
  let outstanding = 0;
  let closed = false;
  let timer: unknown = null;
  const clearIdle = (): void => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const restLater = (): void => {
    clearIdle();
    if (closed || outstanding > 0) return;
    timer = timers.setTimeout(() => {
      timer = null;
      if (closed || outstanding > 0 || !painting) return;
      painting = false;
      painter.stop();
    }, idleMs);
  };
  const wake = (): void => {
    clearIdle();
    if (painting) return;
    painting = true;
    painter.start();
  };
  const settle = (): void => {
    outstanding--;
    restLater();
  };
  const call = (key: PropertyKey, method: (...args: unknown[]) => unknown, args: unknown[]): unknown => {
    if (CLOSING_CALLS.has(key)) {
      closed = true;
      clearIdle();
    }
    if (QUIET_CALLS.has(key)) return method.apply(port, args);
    wake();
    outstanding++;
    let answer: unknown;
    try {
      answer = method.apply(port, args);
    } catch (error) {
      settle();
      throw error;
    }
    if (answer instanceof Promise) return answer.finally(settle);
    settle();
    return answer;
  };
  restLater();
  return new Proxy(port, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => call(key, value as (...args: unknown[]) => unknown, args);
    },
    set(target, key, value) {
      return Reflect.set(target, key, value, target);
    },
  });
}

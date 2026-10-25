/**
 * The studio's hold on computer control: whether a desktop driver is installed, the desktop
 * sessions running now, and the one switch that stops them all (the global stop shortcut and the
 * app's quit). Every `desktop` tool a delegation is handed is made here, so nothing drives the
 * person's computer that this registry cannot stop.
 */
import { setTimeout as startTimer } from "node:timers";
import { SECOND_MS } from "../../shared/duration.ts";
import type { DesktopApp, DesktopDriver } from "../../substrate/desktop-driver.ts";
import { type DesktopQuestion, type DesktopTools, type DesktopToolsDeps, desktopTools } from "./desktop-tools.ts";

/**
 * How long the driver's daemon outlives the last session: a chat's next turn, or the harness asking
 * afresh, reuses it instead of starting another.
 */
const IDLE_SHUTDOWN_MS = 30 * SECOND_MS;

/** What the model reads when no driver is installed, or a stop came while it started. */
const MESSAGE = {
  noDriver: "no cua-driver is bundled or installed",
  stopped: "computer control was stopped while it started",
} as const;

/** Run `fire` after `ms`, never keeping the app alive for it; the answer cancels it. */
function unrefTimer(ms: number, fire: () => void): () => void {
  const timer = startTimer(fire, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

/** How computer control is reached on this machine. */
export interface DesktopControlOptions {
  /** The installed driver, or null when there is none (or this platform has no desktop control yet). */
  findDriver: () => Promise<string | null>;
  /** Start a driver session over the installed binary. */
  connect: (binary: string) => Promise<DesktopDriver>;
  /** Whether an app is the studio itself: never driven, so no agent can answer its own consent card. */
  ownApp: (app: DesktopApp) => boolean;
  /** Drive a VM's desktop rather than this computer's (`GENEX_COMPUTER_VM`): every app inside it is the VM's. */
  vm?: boolean;
  /** Told how many sessions hold the computer, whenever it changes: the stop shortcut lives while any do. */
  onActive?: (count: number) => void;
  /** Stop what runs the driver once no session holds it: the app's own embedded daemon. */
  shutdown?: () => Promise<void>;
  /** The timer the daemon's idle stop waits on ({@link IDLE_SHUTDOWN_MS}); the answer cancels it. */
  later?: (ms: number, fire: () => void) => () => void;
}

/** One session's desktop: where its frames go, how its person is asked, and what its screen shows. */
export type DesktopSessionDeps = Pick<
  DesktopToolsDeps,
  "frameDir" | "frame" | "downscale" | "maxActions" | "enabled" | "engineApps"
> & {
  ask: (question: DesktopQuestion, app?: DesktopApp) => Promise<boolean>;
};

/** The registry: what is installed, what is running, and how to stop it all. */
export function desktopControl(options: DesktopControlOptions) {
  const running = new Set<DesktopTools>();
  let found: Promise<string | null> | null = null;
  const binary = () => {
    found ??= options.findDriver().catch(() => null);
    return found;
  };
  const later = options.later ?? unrefTimer;
  // Cancels the daemon's pending idle stop.
  let idle: (() => void) | null = null;
  const keepDaemon = () => {
    idle?.();
    idle = null;
  };
  /** Tell how many sessions hold the computer; once none does, stop the daemon after a while. */
  const changed = () => {
    options.onActive?.(running.size);
    if (running.size > 0 || !options.shutdown) return;
    keepDaemon();
    idle = later(IDLE_SHUTDOWN_MS, () => {
      idle = null;
      if (running.size === 0) void options.shutdown?.().catch(() => {});
    });
  };
  return {
    /** Whether computer control can be offered here: a driver is installed. */
    available: async (): Promise<boolean> => (await binary()) !== null,
    /** The `desktop` tool for one session, stopped with it or by {@link stopAll}. */
    toolsFor: (deps: DesktopSessionDeps): DesktopTools => {
      // Counts this session's stops, so a driver that arrives after one is closed unused.
      let stops = 0;
      // A session holds the computer from the moment its driver starts until it is released, so
      // the stop shortcut also cancels a start under way.
      const hold = (held: DesktopTools) => {
        keepDaemon();
        running.add(held);
        options.onActive?.(running.size);
      };
      const letGo = (held: DesktopTools) => {
        if (running.delete(held)) changed();
      };
      const tools = desktopTools({
        ...deps,
        ownApp: options.ownApp,
        ...(options.vm ? { vm: true } : {}),
        connect: async () => {
          const ticket = stops;
          const path = await binary();
          if (!path) throw new Error(MESSAGE.noDriver);
          if (stops !== ticket) throw new Error(MESSAGE.stopped);
          hold(held);
          const driver = await options.connect(path).catch((error: unknown) => {
            letGo(held);
            throw error;
          });
          if (stops === ticket) return driver;
          await driver.close().catch(() => {});
          throw new Error(MESSAGE.stopped);
        },
      });
      const held: DesktopTools = {
        ...tools,
        release: async () => {
          stops += 1;
          letGo(held);
          await tools.release();
        },
      };
      return held;
    },
    /** How many desktop sessions are holding the computer now. */
    active: (): number => running.size,
    /** Stop every desktop session at once: the person's stop, or the app quitting. */
    stopAll: async (): Promise<void> => {
      const all = [...running];
      running.clear();
      keepDaemon();
      options.onActive?.(0);
      await Promise.all(all.map((tools) => tools.release().catch(() => {})));
      await options.shutdown?.().catch(() => {});
    },
    /** Look for the driver again (after the person installs it). */
    rescan: (): void => {
      found = null;
    },
  };
}

/** The studio's computer-control registry. */
export type DesktopControl = ReturnType<typeof desktopControl>;

/**
 * The `desktop` tool: the same computer vocabulary and the same session referee as a game's
 * `computer` (`computer-session.ts`), on the person's desktop or a VM. It is offered to the
 * sessions the person is answering, on every engine — Claude Code, Codex, OpenCode, the local
 * sessions and the harness's own loop all receive it as one more live tool.
 *
 * Nothing moves before the person says so: the first call asks whether the agent may see the
 * screen and use the computer this session, and each app it then reaches is asked for once
 * (`desktop-target.ts`). A no is the answer the model reads, never a failure. The driver starts
 * on the first call and stops with the session. Computer control is a setting (Settings →
 * Permissions, off by default): while it is off, every call answers so and nothing starts.
 */
import type { ScreenAct } from "../../shared/agent-screen.ts";
import { ScreenRole } from "../../shared/agent-screen.ts";
import { ComputerPacing, type ComputerTraceSummary } from "../../shared/computer-target.ts";
import { errorMessage } from "../../shared/errors.ts";
import { DESKTOP_TOOL_NAME, computerToolDefinition } from "../../substrate/computer-tool.ts";
import type { DesktopApp, DesktopDriver, DesktopShot } from "../../substrate/desktop-driver.ts";
import type { DelegateRequest } from "../../substrate/engines/types.ts";
import { computerSession, type TargetSource } from "./computer-session.ts";
import { type DesktopTarget, desktopTarget } from "./desktop-target.ts";

/** The most moves one desktop session makes unless the grant says otherwise. */
const DESKTOP_MAX_ACTIONS = 200;

/** What the person is asked, in the consent card. */
export const DesktopQuestion = {
  /** May the agent see the screen and use the computer this session? */
  Session: "session",
  /** May the agent use this app? */
  App: "app",
} as const;
export type DesktopQuestion = (typeof DesktopQuestion)[keyof typeof DesktopQuestion];

/** What the model reads when the desktop cannot be used. */
const MESSAGE = {
  declined: "the person did not allow computer control this session — ask them in words what to do instead",
  noDriver: (why: string) => `computer control is not available: ${why}`,
  stopped:
    "the person stopped computer control (Stop, or Control-Option-Command-Escape) — nothing more moved; ask before using it again",
  off: "computer control is off in Settings — nothing moved; the person can turn it on under Settings → Permissions",
} as const;

/** What a call answers while computer control is turned off in Settings. */
export const DESKTOP_OFF_ANSWER = MESSAGE.off;

/** What a desktop session is built from. */
export interface DesktopToolsDeps {
  /** Start the driver: cua-driver on this Mac, or the computer server inside a VM. Throws when it cannot. */
  connect: () => Promise<DesktopDriver>;
  /** Ask the person, in the chat, and wait for their answer. */
  ask: (question: DesktopQuestion, app?: DesktopApp) => Promise<boolean>;
  /** Whether an app is the studio itself, which no agent ever drives. */
  ownApp: (app: DesktopApp) => boolean;
  /** The engine-app guard: why this app is refused now (an engine's editor outside its assist), or null. */
  engineApps?: (app: DesktopApp) => string | null;
  /** The folder the session's frames and trace go into. */
  frameDir: string;
  /** Show a frame on the agent's screen. */
  frame?: (target: DesktopTarget, jpeg: Buffer | null, caption: string, act: ScreenAct) => Promise<void>;
  downscale?: (
    shot: DesktopShot,
  ) => Promise<{ image: Buffer; mime: "image/png" | "image/jpeg"; width: number; height: number }>;
  /** A VM's desktop rather than this Mac's: its apps are all the VM's, so the session's yes covers them. */
  vm?: boolean;
  maxActions?: number;
  /** Whether computer control is on in Settings now; asked before every call (on when absent). */
  enabled?: () => boolean;
}

/** The desktop tool for one session, and how to stop it. */
export interface DesktopTools {
  liveTools: NonNullable<DelegateRequest["liveTools"]>;
  onLiveTool: NonNullable<DelegateRequest["onLiveTool"]>;
  trace: () => ComputerTraceSummary;
  /** Stop the driver; later calls start nothing until asked again. */
  release: () => Promise<void>;
}

/** Whether the person turned computer control off in Settings. */
function turnedOff(deps: DesktopToolsDeps): boolean {
  return deps.enabled?.() === false;
}

/** The apps the person allowed this session, asked for once each. */
function appAllowance(deps: DesktopToolsDeps) {
  const allowed = new Set<string>();
  const declined = new Set<string>();
  return async (app: DesktopApp): Promise<boolean> => {
    if (deps.vm) return true;
    const key = app.bundleId ?? app.name;
    if (allowed.has(key)) return true;
    if (declined.has(key)) return false;
    const yes = await deps.ask(DesktopQuestion.App, app);
    (yes ? allowed : declined).add(key);
    return yes;
  };
}

/**
 * The desktop as the session's target source: asked for, then connected, on the first call. A stop
 * while the card waits or the driver starts cancels that call: a late yes connects nothing, and a
 * driver that arrives after the stop is closed unused.
 */
function desktopSource(deps: DesktopToolsDeps): TargetSource<DesktopTarget> & { release(): Promise<void> } {
  let driver: DesktopDriver | null = null;
  let target: DesktopTarget | null = null;
  // The session question is asked once: a yes stands while a connection fails and is retried.
  let session: boolean | null = null;
  // Counts stops, so a call that waited across one knows it was stopped.
  let stops = 0;
  const allowApp = appAllowance(deps);
  const unusable = (problem: string) => ({
    target: desktopTarget({ driver: deadDriver(problem), allowApp: async () => false }),
    problem,
    note: null,
    fresh: true,
  });
  /** The driver, or why there is none; one that arrives after a stop is closed unused. */
  const connect = async (ticket: number): Promise<DesktopDriver | string> => {
    const connected = await deps.connect().catch((error: unknown) => errorMessage(error));
    if (stops === ticket) return typeof connected === "string" ? MESSAGE.noDriver(connected) : connected;
    if (typeof connected !== "string") await connected.close().catch(() => {});
    return MESSAGE.stopped;
  };
  return {
    caps: desktopTarget({ driver: deadDriver(""), allowApp: async () => false, vm: deps.vm === true }).caps,
    load: async () => {
      if (target) return { target, problem: null, note: null, fresh: false };
      const ticket = stops;
      const answer = session ?? (await deps.ask(DesktopQuestion.Session));
      // Stopped while the card waited: that yes ends with the stop, and the next call asks again.
      if (stops !== ticket) return unusable(MESSAGE.stopped);
      session = answer;
      if (!session) return unusable(MESSAGE.declined);
      // Turned off while the card waited: the yes connects nothing.
      if (turnedOff(deps)) return unusable(MESSAGE.off);
      const connected = await connect(ticket);
      if (typeof connected === "string") return unusable(connected);
      driver = connected;
      target = desktopTarget({
        driver,
        allowApp,
        ownApp: deps.ownApp,
        vm: deps.vm === true,
        ...(deps.engineApps ? { engineApps: deps.engineApps } : {}),
        ...(deps.downscale ? { downscale: deps.downscale } : {}),
      });
      return { target, problem: null, note: null, fresh: true };
    },
    frame: (shown, jpeg, caption, act) => deps.frame?.(shown, jpeg, caption, act) ?? Promise.resolve(),
    release: async () => {
      stops += 1;
      const open = driver;
      driver = null;
      target = null;
      // A stop ends the session's yes: the next call asks again.
      session = null;
      await open?.close().catch(() => {});
    },
  };
}

/** A driver that refuses everything: what a target without a connection holds. */
function deadDriver(why: string): DesktopDriver {
  const refuse = () => Promise.reject(new Error(why || "not connected"));
  return {
    screenshot: refuse,
    focus: refuse,
    move: refuse,
    click: refuse,
    mouse: refuse,
    drag: refuse,
    scroll: refuse,
    type: refuse,
    press: refuse,
    accessibility: refuse,
    close: async () => {},
  };
}

/** The `desktop` tool over one session on the desktop (or a VM). */
export function desktopTools(deps: DesktopToolsDeps): DesktopTools {
  const source = desktopSource(deps);
  const session = computerSession(source, deps.vm ? "vm" : "desktop", {
    pacing: ComputerPacing.Running,
    frameDir: deps.frameDir,
    observeByDefault: true,
    maxActions: deps.maxActions ?? DESKTOP_MAX_ACTIONS,
    toolName: DESKTOP_TOOL_NAME,
  });
  const tool = computerToolDefinition({
    name: DESKTOP_TOOL_NAME,
    role: ScreenRole.Operator,
    capabilities: source.caps,
    observeByDefault: true,
  });
  // A stop during a call cuts the driver off under it: that call says the person stopped it.
  let stops = 0;
  return {
    liveTools: [tool],
    onLiveTool: async (name, args) => {
      if (turnedOff(deps)) return MESSAGE.off;
      const before = stops;
      const answer = await session.run(name, args);
      return stops === before ? answer : MESSAGE.stopped;
    },
    trace: () => session.trace(),
    release: () => {
      stops += 1;
      return source.release();
    },
  };
}

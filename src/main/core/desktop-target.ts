/**
 * The person's desktop, or a VM's, as a computer target: the same `computer` vocabulary, carried
 * out by a desktop driver (`substrate/desktop-driver.ts`) from outside any game. The studio — never
 * the model — decides what the agent may touch:
 *
 * - every app is asked for once: input aimed at an app the person has not allowed this session
 *   waits for their answer, and a no ends the action;
 * - some apps are never driven, whatever is allowed: the studio itself (an agent must never answer
 *   its own consent card), password managers, System Settings and the system's password prompts;
 * - computer use never builds or play-tests: a game engine's editor (the apps an enabled engine
 *   plugin declares) is driven only in that plugin's setup assist (Do it for me), and an assist
 *   drives only the apps it was granted;
 * - nothing is ever typed into a secure (password) field.
 *
 * A click is checked against the app whose window is under the point when the driver can say (a
 * point no window covers is refused), else the app in front; a drag against the apps under both
 * its ends; keys and text against the app in front. A refusal ends the plan and is reported with its
 * reason (`refusals()`), so the model reads why, never a silent no-op. The model's coordinates are
 * pixels of the last screenshot, scaled here to the driver's screen space.
 */
import {
  DESKTOP_CAPABILITIES,
  InputRoute,
  type TargetCapabilities,
  TargetRefusal,
  VM_CAPABILITIES,
} from "../../shared/computer-target.ts";
import { StillMimeType } from "../../shared/preview-contract.ts";
import type { ComputerTarget, TargetShot } from "../../substrate/computer-target.ts";
import { guardedWeb } from "./desktop-web.ts";
import type {
  DesktopApp,
  DesktopButton,
  DesktopDriver,
  DesktopKeys,
  DesktopShot,
} from "../../substrate/desktop-driver.ts";
import {
  MAX_HOLD_KEY_MS,
  clampRepeat,
  normalizeKeys,
  parseCombo,
  pointInView,
  type PreviewInputAction,
  typedText,
} from "../../substrate/preview-input.ts";
import { setTimeout as sleep } from "node:timers/promises";

/** The view a desktop is described in before its first screenshot. */
const DEFAULT_VIEW = { width: 1280, height: 800 } as const;
/** The most clicks one click action makes (a triple click selects a line). */
const MAX_CLICKS = 3;
/** How long a tapped key is held, where the driver holds keys at all. */
const TAP_HOLD_MS = 50;

/**
 * Apps the studio never drives, by bundle id: the studio itself is added at run time. A password
 * manager, the system's settings and its password prompts are the person's alone.
 */
export const NEVER_DRIVEN_BUNDLES: ReadonlySet<string> = new Set([
  "com.apple.systempreferences",
  "com.apple.SystemSettings",
  "com.apple.keychainaccess",
  "com.apple.Passwords",
  "com.apple.SecurityAgent",
  "com.apple.loginwindow",
  "com.apple.LocalAuthentication.UIAgent",
  "com.agilebits.onepassword7",
  "com.1password.1password",
  "com.bitwarden.desktop",
  "com.lastpass.LastPass",
  "com.dashlane.dashlanephonefinal",
  "com.keepassxc.keepassxc",
]);

/**
 * The same apps on Windows, by executable (`windowsAppId`). Every packaged app's window is a
 * frame of `ApplicationFrameHost.exe` (Settings and Windows Security among them), and the studio
 * cannot tell which app a frame holds, so it drives none; `rundll32.exe` hosts the old dialogs,
 * saved passwords among them. The shell is never driven either: Explorer (the desktop, the
 * taskbar, File Explorer's address bar, Run and Control Panel), Start and Search can each start any
 * program as the person, outside the sandbox. Nor is the driver's own cursor overlay, so a point
 * that reaches it is refused rather than charged to it.
 */
export const NEVER_DRIVEN_WINDOWS_APPS: ReadonlySet<string> = new Set([
  "applicationframehost.exe",
  "explorer.exe",
  "startmenuexperiencehost.exe",
  "searchhost.exe",
  "searchapp.exe",
  "shellexperiencehost.exe",
  "cua-driver.exe",
  "systemsettings.exe",
  "sechealthui.exe",
  "consent.exe",
  "credentialuibroker.exe",
  "logonui.exe",
  "lockapp.exe",
  "rundll32.exe",
  "1password.exe",
  "bitwarden.exe",
  "keepass.exe",
  "keepassxc.exe",
  "lastpass.exe",
  "dashlane.exe",
  "nordpass.exe",
  "enpass.exe",
  "keeperpasswordmanager.exe",
  "proton pass.exe",
  "roboform.exe",
]);

/** Whether an app's identifier names one the studio never drives, on either system. */
function neverDrivenId(id: string | null): boolean {
  return id !== null && (NEVER_DRIVEN_BUNDLES.has(id) || NEVER_DRIVEN_WINDOWS_APPS.has(id));
}

/** What the model reads when the studio refuses an action, and why. */
const MESSAGE = {
  neverDriven: (app: string) => `${app} is never driven by an agent (the studio, password managers, system settings)`,
  declined: (app: string) => `the person did not allow ${app} — ask them in words, or use an app they allowed`,
  secureField: "the focused field is a password field: the studio never types into one",
  noApp: "no app could be found under that point or in front",
  noWindow: "no app's window is under that point — click inside the window of an app the person allowed",
  engineApp: (app: string) =>
    `${app} is a game engine's editor: computer use never builds or play-tests there — use the engine's own tools. A setup click or a publish there goes through its plugin's tool (such as Do it for me or Publish), and only the turn that answers the task it posts may click it`,
  playerApp: (app: string) =>
    `${app} is where an engine's games are played by everyone: computer use never plays there, not even for setup`,
  outsideAssist: (app: string) => `${app} is not one of the apps this setup step may use`,
} as const;

/** What the engine-app guard reads: the editors engines declare, and the chat's live assist grant. */
export interface EngineAppRule {
  /** The editor apps every enabled engine plugin declares for this system (`engine.apps`, `engineAppIds`). */
  declared: ReadonlySet<string>;
  /** The apps the chat's live setup assist was granted; null outside an assist. */
  granted: ReadonlySet<string> | null;
  /** The apps every enabled engine's games are played in (`engine.playerApps`): never driven. */
  players?: ReadonlySet<string>;
}

/**
 * Why the engine-app guard refuses an app, or null: an app an engine's games are played in always;
 * during an assist every app outside its grant; outside one, every engine's editor. The apps the
 * studio never drives are refused before this.
 */
export function engineAppRefusal(app: DesktopApp, rule: EngineAppRule): string | null {
  const id = app.bundleId;
  if (id !== null && rule.players?.has(id)) return MESSAGE.playerApp(appName(app));
  if (rule.granted) return id !== null && rule.granted.has(id) ? null : MESSAGE.outsideAssist(appName(app));
  return id !== null && rule.declared.has(id) ? MESSAGE.engineApp(appName(app)) : null;
}

/** One refusal, the shape `refusals()` reports. */
interface Refusal {
  op: string;
  code: string;
  message: string;
}

/** How a desktop target is set up. */
export interface DesktopTargetOptions {
  driver: DesktopDriver;
  /** The desktop on this computer, or a VM's. */
  vm?: boolean;
  /**
   * Whether the agent may use this app: answers at once for an app already allowed, else asks the
   * person and waits. Inside a VM every app is the VM's own, so the VM's grant covers them all.
   */
  allowApp: (app: DesktopApp) => Promise<boolean>;
  /** Whether this app is one the studio never drives (beyond {@link NEVER_DRIVEN_BUNDLES} and {@link NEVER_DRIVEN_WINDOWS_APPS}): the studio itself. */
  ownApp?: (app: DesktopApp) => boolean;
  /** The engine-app guard ({@link engineAppRefusal}): why this app is refused now, or null. */
  engineApps?: (app: DesktopApp) => string | null;
  /** A smaller picture for the model, where the host can make one; the driver's own otherwise. */
  downscale?: (
    shot: DesktopShot,
  ) => Promise<{ image: Buffer; mime: "image/png" | "image/jpeg"; width: number; height: number }>;
}

/** A desktop target, with what it refused since last asked. */
export interface DesktopTarget extends ComputerTarget {
  readonly caps: TargetCapabilities;
}

/** What a running plan reads and keeps. */
interface DesktopState {
  view: { width: number; height: number };
  screen: { width: number; height: number };
  pointer: { x: number; y: number } | null;
  refused: Refusal[];
  /** Whether a picture was taken yet: the space every coordinate is read in. */
  seen: boolean;
}

/** A view point, from the model's pixels, and the same point in the driver's screen space. */
function screenPoint(state: DesktopState, x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round((x * state.screen.width) / Math.max(1, state.view.width)),
    y: Math.round((y * state.screen.height) / Math.max(1, state.view.height)),
  };
}

/** Driver key names, from `KeyboardEvent.code` names. */
const DRIVER_KEYS: Readonly<Record<string, string>> = {
  ShiftLeft: "shift",
  ControlLeft: "ctrl",
  AltLeft: "alt",
  MetaLeft: "cmd",
  Enter: "return",
  Escape: "escape",
  Tab: "tab",
  Backspace: "backspace",
  // cua's "delete" is Backspace (keycode 51); forward delete has its own name.
  Delete: "forward_delete",
  ShiftRight: "shift",
  ControlRight: "ctrl",
  AltRight: "alt",
  MetaRight: "cmd",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backslash: "\\",
  Backquote: "`",
  Space: "space",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  PageUp: "pageup",
  PageDown: "pagedown",
  Home: "home",
  End: "end",
  Minus: "-",
  Equal: "=",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** One `KeyboardEvent.code` as the driver spells it: `KeyA` is `a`, `Digit1` is `1`, `F5` is `f5`. */
export function driverKey(code: string): string {
  const named = DRIVER_KEYS[code];
  if (named) return named;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return code.toLowerCase();
}

/** Key names as the driver spells them. */
function driverKeys(keys: string[]): DesktopKeys {
  return normalizeKeys(keys).map((key) => driverKey(key.code));
}

/** A combo (`ctrl+s`) as the driver's keys, modifiers first; empty when it names no key. */
function comboKeys(combo: string): DesktopKeys {
  const { modifiers, key } = parseCombo(combo);
  if (!key) return [];
  return [...modifiers.map((k) => driverKey(k.code)), driverKey(key.code)];
}

/** What an action touches: a point on screen, or the keyboard of the app in front. */
type Aim = { at: { x: number; y: number } } | { keyboard: true; text: boolean };

/**
 * The points or keyboard an action aims at, in view pixels; none for an action that touches
 * nothing. A drag aims at both ends: where it is picked up and where it is dropped.
 */
function aimsOf(state: DesktopState, action: PreviewInputAction): Aim[] {
  const at = (x: unknown, y: unknown, px?: boolean, from = state.pointer) => {
    const unset = x === undefined || y === undefined;
    if (unset && from) return from;
    return pointInView(x, y, state.view.width, state.view.height, { exact: px === true });
  };
  switch (action.type) {
    case "click":
      return [{ at: at(action.x, action.y, action.px) }];
    case "move":
      return [];
    case "drag": {
      // An unset drop is the pick-up point, as the drag handler places it.
      const start = at(action.fromX, action.fromY, action.px);
      return [{ at: start }, { at: at(action.x, action.y, action.px, start) }];
    }
    case "scroll":
      return [{ at: at(action.x, action.y, true) }];
    case "mousedown":
    case "mouseup":
      return [{ at: at(undefined, undefined, true) }];
    case "type":
      return [{ keyboard: true, text: true }];
    case "wait":
    case "look":
      return [];
    default:
      return [{ keyboard: true, text: false }];
  }
}

/** The handler for each studio input action, in driver calls. */
type Handler = (driver: DesktopDriver, state: DesktopState, action: PreviewInputAction) => Promise<void>;

/** Hold keys for `ms` where the driver holds keys, else press them once. */
async function strike(driver: DesktopDriver, keys: DesktopKeys, ms: number): Promise<void> {
  if (!keys.length) return;
  if (!driver.keys) return driver.press(keys);
  await driver.keys(keys, true);
  try {
    await sleep(ms);
  } finally {
    await driver.keys([...keys].reverse(), false);
  }
}

/** Where a view point lands, remembered as the pointer, and the same point on the driver's screen. */
function placed(state: DesktopState, x: unknown, y: unknown, px?: boolean): { x: number; y: number } {
  const unset = x === undefined || y === undefined;
  const view =
    unset && state.pointer
      ? state.pointer
      : pointInView(x, y, state.view.width, state.view.height, { exact: px === true });
  state.pointer = view;
  return screenPoint(state, view.x, view.y);
}

/** A mouse button the driver takes. */
function buttonOf(raw: string | undefined): DesktopButton {
  return raw === "right" || raw === "middle" ? raw : "left";
}

const INPUT: {
  [K in PreviewInputAction["type"]]: (
    driver: DesktopDriver,
    state: DesktopState,
    action: Extract<PreviewInputAction, { type: K }>,
  ) => Promise<void>;
} = {
  tap: (driver, _state, a) => strike(driver, driverKeys(a.keys), a.stepMs ?? TAP_HOLD_MS),
  hold: (driver, _state, a) =>
    strike(driver, driverKeys(a.keys), Math.min(MAX_HOLD_KEY_MS, Math.max(0, a.ms ?? TAP_HOLD_MS))),
  down: async (driver, _state, a) => {
    if (driver.keys) await driver.keys(driverKeys(a.keys), true);
  },
  up: async (driver, _state, a) => {
    if (driver.keys) await driver.keys(driverKeys(a.keys), false);
  },
  press: async (driver, _state, a) => {
    const keys = comboKeys(a.combo);
    if (!keys.length) return;
    for (let i = 0; i < clampRepeat(a.repeat ?? 1); i++) await driver.press(keys);
  },
  type: (driver, _state, a) => driver.type(typedText(a.text)),
  look: async (driver, state, a) => {
    const from = state.pointer ?? { x: Math.round(state.view.width / 2), y: Math.round(state.view.height / 2) };
    const to = placed(state, from.x + a.dx, from.y + a.dy, true);
    await driver.move(to.x, to.y);
  },
  scroll: async (driver, state, a) => {
    const at = placed(state, a.x, a.y, true);
    await driver.scroll(at.x, at.y, a.dx ?? 0, a.dy ?? 0);
  },
  wait: async (_driver, _state, a) => {
    await sleep(Math.min(MAX_HOLD_KEY_MS, Math.max(0, a.ms)));
  },
  click: async (driver, state, a) => {
    const at = placed(state, a.x, a.y, a.px);
    const modifiers = (a.modifiers ?? []).flatMap((name) => comboKeys(name));
    const count = Math.max(1, Math.min(MAX_CLICKS, a.clicks ?? 1));
    await driver.click(at.x, at.y, { button: buttonOf(a.button), count, modifiers });
  },
  move: async (driver, state, a) => {
    const at = placed(state, a.x, a.y, a.px);
    await driver.move(at.x, at.y);
  },
  drag: async (driver, state, a) => {
    const from = placed(state, a.fromX, a.fromY, a.px);
    const to = placed(state, a.x, a.y, a.px);
    await driver.drag(from, to, buttonOf(a.button));
  },
  mousedown: async (driver, state, a) => {
    const at = placed(state, undefined, undefined, true);
    await driver.mouse(at.x, at.y, { button: buttonOf(a.button), down: true });
  },
  mouseup: async (driver, state, a) => {
    const at = placed(state, undefined, undefined, true);
    await driver.mouse(at.x, at.y, { button: buttonOf(a.button), down: false });
  },
};

/** A readable name for an app in a sentence. */
function appName(app: DesktopApp): string {
  return app.name || app.bundleId || "this app";
}

/**
 * The desktop (or a VM's) as a target. Every input action is first checked: the app it lands in is
 * one the person allowed, never one the studio refuses to drive, and text never goes into a
 * password field.
 */
export function desktopTarget(options: DesktopTargetOptions): DesktopTarget {
  const { driver } = options;
  const state: DesktopState = {
    view: { ...DEFAULT_VIEW },
    screen: { ...DEFAULT_VIEW },
    pointer: null,
    refused: [],
    seen: false,
  };
  const refuse = (op: string, message: string): false => {
    state.refused.push({ op, code: TargetRefusal.Unsupported, message });
    return false;
  };
  const neverDriven = (app: DesktopApp) => neverDrivenId(app.bundleId) || options.ownApp?.(app) === true;
  /**
   * The app an aim lands in, what to say when there is none, and whether it would type into a
   * password field: a point is checked against the app whose window is under it where the driver
   * can say (none there is refused, never put down to the app in front); keys and text, and a point
   * on a driver that can't say, against the app in front and its focused field.
   */
  const landing = async (aim: Aim): Promise<{ app: DesktopApp | null; secret: boolean; none: string }> => {
    if ("at" in aim && driver.appAt) {
      const point = screenPoint(state, aim.at.x, aim.at.y);
      return { app: await driver.appAt(point.x, point.y), secret: false, none: MESSAGE.noWindow };
    }
    const focus = await driver.focus();
    return { app: focus.app, secret: focus.secure && "keyboard" in aim, none: MESSAGE.noApp };
  };
  /** Whether one aim may go ahead: the app it lands in is allowed, and no secret is typed. */
  const aimCleared = async (op: string, aim: Aim): Promise<boolean> => {
    const { app, secret, none } = await landing(aim);
    if (secret) return refuse(op, MESSAGE.secureField);
    if (!app) return refuse(op, none);
    if (neverDriven(app)) return refuse(op, MESSAGE.neverDriven(appName(app)));
    const engine = options.engineApps?.(app);
    if (engine) return refuse(op, engine);
    if (!(await options.allowApp(app))) return refuse(op, MESSAGE.declined(appName(app)));
    return true;
  };
  /** Whether an action may go ahead: every point and keyboard it aims at is cleared, before any input. */
  const cleared = async (action: PreviewInputAction): Promise<boolean> => {
    for (const aim of aimsOf(state, action)) if (!(await aimCleared(action.type, aim))) return false;
    return true;
  };
  const picture = async (): Promise<TargetShot> => {
    const raw = await driver.screenshot();
    const shot = options.downscale ? await options.downscale(raw) : raw;
    state.view = { width: shot.width, height: shot.height };
    state.screen = raw.screen;
    state.seen = true;
    return {
      jpeg: shot.image,
      ...(shot.mime === "image/png" ? { mime: StillMimeType.Png } : {}),
      stats: null,
      surface: null,
    };
  };
  return {
    caps: options.vm ? VM_CAPABILITIES : DESKTOP_CAPABILITIES,
    viewSize: () => state.view,
    pointer: () => state.pointer,
    screenshot: () => picture(),
    input: async (actions) => {
      // The driver places pointer actions in the last picture's pixels: there is always one.
      if (!state.seen) await picture();
      let applied = 0;
      for (const action of actions) {
        if (!(await cleared(action))) break;
        const handler = INPUT[action.type] as Handler;
        await handler(driver, state, action);
        applied += 1;
      }
      return { applied, route: InputRoute.OsForeground };
    },
    state: async () => {
      const focus = await driver.focus();
      if (focus.app && neverDriven(focus.app))
        return { app: appName(focus.app), refused: MESSAGE.neverDriven(appName(focus.app)) };
      return { app: focus.app ? appName(focus.app) : null, tree: await driver.accessibility() };
    },
    refusals: () => state.refused.splice(0),
    ...(driver.web ? { web: guardedWeb(driver.web, { allowApp: options.allowApp, neverDriven }) } : {}),
  };
}

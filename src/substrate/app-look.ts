/**
 * Looking at an app window for an agent (`app_look`): the windows on screen, then one window's
 * picture and accessibility tree. Look-only: nothing here sends input to any app. On macOS the
 * port runs `osascript` (JavaScript for Automation), `screencapture` and `sips` host-side through a
 * runner seam, a window's values reaching the scripts only as arguments. Tests and fixture profiles
 * use the stub; other systems answer that it works on macOS only for now. Electron-free: the macOS
 * access checks and asks live in `main/app-look-access.ts`.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../shared/duration.ts";
import { AppLookAccessKind } from "../shared/jobs.ts";
import { APP_LOOK_MAX_DEPTH, APP_LOOK_MAX_NODES, AX_TREE_SCRIPT, WINDOW_LIST_SCRIPT } from "./app-look-scripts.ts";

export { APP_LOOK_MAX_DEPTH, APP_LOOK_MAX_NODES } from "./app-look-scripts.ts";

/** The longest a window's tree may read, in characters. */
export const APP_LOOK_TREE_MAX_CHARS = 12_000;
/** The longest one text of a tree element (its title, value or description) may read. */
export const APP_LOOK_TEXT_MAX_CHARS = 120;
/** A picture's longest edge, in pixels, after `sips` shrinks it. */
export const APP_LOOK_MAX_EDGE = 1568;
/** The largest picture handed to a model; a larger one is left out with a note. */
export const APP_LOOK_MAX_IMAGE_BYTES = 3.5 * 1024 ** 2;
/** How long one command of a look may take. */
export const APP_LOOK_COMMAND_TIMEOUT_MS = 10 * SECOND_MS;
/** The most output one command of a look may print. */
const APP_LOOK_COMMAND_MAX_BUFFER = 16 * 1024 ** 2;

const OSASCRIPT = "/usr/bin/osascript";
const SCREENCAPTURE = "/usr/sbin/screencapture";
const SIPS = "/usr/bin/sips";
/** `osascript` running a JavaScript for Automation script given in place. */
const JXA = ["-l", "JavaScript", "-e"] as const;
/** The macOS errors that mean Genex may not read another app's accessibility (or drive System Events to): access missing. */
const AX_ACCESS_ERRORS = ["(-1719)", "(-25211)", "(-1743)"] as const;

/** One app window on screen, as Core Graphics lists it. */
export interface AppWindow {
  id: number;
  app: string;
  bundleId?: string;
  pid: number;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  onScreen: boolean;
}

/** A window's picture, as a model reads it. */
export interface AppLookImage {
  mimeType: "image/jpeg";
  data: string;
}

/** One look at a window: its picture (none when it could not be taken) and its accessibility tree. */
export interface AppLookResult {
  window: AppWindow;
  image: AppLookImage | null;
  tree: string;
  /** The tree was cut at its caps. */
  truncated: boolean;
  /** What is missing from the look and why, when something is. */
  note?: string;
}

/** Why a look found nothing to show. */
export const AppLookProblemCode = {
  /** This system has no `app_look` yet. */
  Unsupported: "unsupported",
  /** Genex may not record the screen. */
  NoScreenAccess: "no_screen_access",
  /** Genex may not read other apps' accessibility. */
  NoAxAccess: "no_ax_access",
  /** The window is not on screen any more. */
  NotOnScreen: "not_on_screen",
  /** Genex does not look at this app. */
  Refused: "refused",
  /** A command failed. */
  Failed: "failed",
} as const;
export type AppLookProblemCode = (typeof AppLookProblemCode)[keyof typeof AppLookProblemCode];

/** A look that found nothing to show, and why. */
export interface AppLookProblem {
  problem: AppLookProblemCode;
  detail?: string;
}

/** Whether a port's answer is a problem rather than windows or a look. */
export function isAppLookProblem(value: unknown): value is AppLookProblem {
  return typeof value === "object" && value !== null && "problem" in value;
}

/** What looks at app windows: the macOS port, the stub, or the answer that it is macOS only. */
export interface AppLookPort {
  windows(): Promise<AppWindow[] | AppLookProblem>;
  look(window: AppWindow): Promise<AppLookResult | AppLookProblem>;
}

/** Screen Recording's state, as Electron's `systemPreferences.getMediaAccessStatus("screen")` says it. */
export const ScreenAccessState = {
  Granted: "granted",
  NotDetermined: "not-determined",
  Denied: "denied",
  Restricted: "restricted",
  Unknown: "unknown",
} as const;
export type ScreenAccessState = (typeof ScreenAccessState)[keyof typeof ScreenAccessState];

/** Whether Genex may record the screen and read other apps' accessibility. */
export interface AppLookAccessStatus {
  screen: ScreenAccessState;
  accessibility: boolean;
}

/** macOS's access for `app_look`: what it is now, and Genex's one ask of it. */
export interface ScreenAccess {
  status(): AppLookAccessStatus;
  /** Whether Genex has asked macOS before (it asks once, ever). */
  asked(): Promise<boolean>;
  /** Ask macOS for what is missing, unless Genex asked before; remembered. */
  askOnce(): Promise<void>;
}

/** What a look does next about access: look, ask macOS first, or say what is missing. */
export const AccessStep = { Look: "look", Ask: "ask", Missing: "missing" } as const;
export type AccessStep = (typeof AccessStep)[keyof typeof AccessStep];

/**
 * The next step about access: look when Genex has both; ask macOS when it has not asked before;
 * otherwise what the person must still allow.
 */
export function accessStep(
  status: AppLookAccessStatus,
  asked: boolean,
): { step: AccessStep; missing: AppLookAccessKind[] } {
  const missing = [
    ...(status.screen === ScreenAccessState.Granted ? [] : [AppLookAccessKind.Screen]),
    ...(status.accessibility ? [] : [AppLookAccessKind.Accessibility]),
  ];
  if (!missing.length) return { step: AccessStep.Look, missing: [] };
  if (!asked) return { step: AccessStep.Ask, missing: [] };
  return { step: AccessStep.Missing, missing };
}

/** How a command of a look ran: never thrown for an exit code. */
export interface AppLookRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run one program with its arguments, no shell; production: {@link appLookRun}. */
export type AppLookRun = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<AppLookRunResult>;

/** The production runner: `execFile`, no shell, with a timeout. */
export const appLookRun: AppLookRun = (file, args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: APP_LOOK_COMMAND_MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        const code = typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr: stderr || error.message });
      },
    );
  });

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;
const WHITESPACE = /\s+/g;
const DIGITS = /^\d+$/;

/** One plain line of text, clipped to `max` characters. */
function plainText(value: unknown, max: number): string {
  const line = typeof value === "string" ? value.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE, " ").trim() : "";
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

const finite = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/** One window of the window-list script's output; null for an entry that is not an app window. */
function windowOf(entry: unknown): AppWindow | null {
  if (typeof entry !== "object" || entry === null) return null;
  const raw = entry as Record<string, unknown>;
  const layer = raw.layer ?? 0;
  if (!isId(raw.id) || !isId(raw.pid) || typeof raw.app !== "string" || layer !== 0) return null;
  const bounds = typeof raw.bounds === "object" && raw.bounds !== null ? (raw.bounds as Record<string, unknown>) : {};
  const bundleId = typeof raw.bundleId === "string" && raw.bundleId ? { bundleId: raw.bundleId } : {};
  return {
    id: raw.id,
    app: raw.app,
    ...bundleId,
    pid: raw.pid,
    title: typeof raw.title === "string" ? raw.title : "",
    bounds: {
      x: finite(bounds.x),
      y: finite(bounds.y),
      width: finite(bounds.width),
      height: finite(bounds.height),
    },
    onScreen: raw.onScreen !== false,
  };
}

/** The app windows the window-list script printed, front to back; none for output it cannot read. */
export function parseWindowList(stdout: string): AppWindow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => windowOf(entry) ?? []);
}

/** A window's area on screen. */
const area = (window: AppWindow) => window.bounds.width * window.bounds.height;

/** Whether a window is the app named: its owner's name or bundle id, case aside, exactly. */
function ofApp(window: AppWindow, app: string): boolean {
  return window.app.toLowerCase() === app || window.bundleId?.toLowerCase() === app;
}

/**
 * The window an agent asked for: `window` is an id from the list or words of a title (case aside);
 * `app` is an owner's name or bundle id; with only `app`, that app's largest window on screen. Plain
 * comparisons only: nothing an agent typed becomes a pattern. Null when none matches.
 */
export function pickWindow(
  windows: readonly AppWindow[],
  asked: { app?: string | undefined; window?: string | number | undefined },
): AppWindow | null {
  const app = (asked.app ?? "").trim().toLowerCase();
  const named = String(asked.window ?? "").trim();
  if (!app && !named) return null;
  const candidates = app ? windows.filter((window) => ofApp(window, app)) : [...windows];
  if (!named) {
    const shown = candidates.filter((window) => window.onScreen);
    return shown.reduce<AppWindow | null>((best, window) => (best && area(best) >= area(window) ? best : window), null);
  }
  const byId = DIGITS.test(named) ? candidates.find((window) => window.id === Number(named)) : undefined;
  if (byId) return byId;
  const words = named.toLowerCase();
  return candidates.find((window) => window.title.toLowerCase().includes(words)) ?? null;
}

/** The password managers `app_look` never looks at, by bundle id (lower case). */
const REFUSED_BUNDLES: ReadonlySet<string> = new Set([
  "com.apple.keychainaccess",
  "com.apple.passwords",
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.bitwarden.desktop",
  "com.lastpass.lastpass",
  "com.dashlane.dashlanephonefinal",
]);
/** The same apps by the name their windows' owner has (lower case). */
const REFUSED_NAMES: ReadonlySet<string> = new Set([
  "keychain access",
  "passwords",
  "1password",
  "1password 7",
  "bitwarden",
  "lastpass",
  "dashlane",
]);

/** The password managers, by bundle id and by name: `app_look` never looks at their windows. */
export const APP_LOOK_REFUSED_APPS = { bundles: REFUSED_BUNDLES, names: REFUSED_NAMES } as const;

/** Whether a window is a password manager's, which `app_look` never looks at. */
export function refusedApp(window: Pick<AppWindow, "app" | "bundleId">): boolean {
  return REFUSED_BUNDLES.has(window.bundleId?.toLowerCase() ?? "") || REFUSED_NAMES.has(window.app.toLowerCase());
}

/** One element of a tree, as the tree script prints it. */
interface AxNode {
  d: number;
  role: string;
  title: string;
  value: string;
  description: string;
}

/** One element of the tree script's output; null for an entry it cannot read. */
function axNodeOf(entry: unknown): AxNode | null {
  if (typeof entry !== "object" || entry === null) return null;
  const raw = entry as Record<string, unknown>;
  const depth = finite(raw.d, -1);
  if (!Number.isInteger(depth) || depth < 0) return null;
  const textOf = (value: unknown) => plainText(value, APP_LOOK_TEXT_MAX_CHARS);
  return {
    d: depth,
    role: textOf(raw.role) || "element",
    title: textOf(raw.title),
    value: textOf(raw.value),
    description: textOf(raw.description),
  };
}

/** One line of the outline: `role "title" = value (description)`, indented by depth. */
function axLine(node: AxNode): string {
  const title = node.title ? ` "${node.title}"` : "";
  const value = node.value ? ` = ${node.value}` : "";
  const description = node.description && node.description !== node.title ? ` (${node.description})` : "";
  return `${"  ".repeat(node.d)}${node.role}${title}${value}${description}`;
}

/** The tree script's nodes; none for output it cannot read. */
function axNodes(stdout: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const nodes = typeof parsed === "object" && parsed !== null ? (parsed as { nodes?: unknown }).nodes : null;
    return Array.isArray(nodes) ? nodes : [];
  } catch {
    return [];
  }
}

/**
 * A window's accessibility tree as an indented outline, at most {@link APP_LOOK_MAX_NODES} lines,
 * {@link APP_LOOK_MAX_DEPTH} levels and {@link APP_LOOK_TREE_MAX_CHARS} characters, each text one
 * plain line of at most {@link APP_LOOK_TEXT_MAX_CHARS}. `truncated` when anything was cut.
 */
export function parseAxTree(stdout: string): { tree: string; truncated: boolean } {
  const lines: string[] = [];
  let chars = 0;
  let truncated = false;
  for (const entry of axNodes(stdout)) {
    const node = axNodeOf(entry);
    if (!node) continue;
    if (node.d > APP_LOOK_MAX_DEPTH) {
      truncated = true;
      continue;
    }
    const line = axLine(node);
    const full = lines.length >= APP_LOOK_MAX_NODES || chars + line.length + 1 > APP_LOOK_TREE_MAX_CHARS;
    if (full) return { tree: lines.join("\n"), truncated: true };
    lines.push(line);
    chars += line.length + 1;
  }
  return { tree: lines.join("\n"), truncated };
}

/** A problem answer. */
const problem = (code: AppLookProblemCode, detail?: string): AppLookProblem =>
  detail ? { problem: code, detail } : { problem: code };

/** Whether a command's failure is macOS refusing Genex accessibility (or System Events). */
const axRefused = (stderr: string) => AX_ACCESS_ERRORS.some((code) => stderr.includes(code));

/** What the macOS port needs: how to run a program, where to make a picture, and Genex's access now. */
export interface MacAppLookOptions {
  run: AppLookRun;
  /** A folder of Genex's own; each picture is made in a fresh folder inside it and removed after. */
  scratchDir: string;
  /** Genex's access now, to tell a capture refused for want of Screen Recording from one that failed. */
  access?: () => AppLookAccessStatus;
}

/** A window's picture, or why there is none. */
type Picture = { image: AppLookImage | null; note?: string };

/** Whether Genex lacks Screen Recording, as far as it can tell. */
const screenRefused = (options: MacAppLookOptions) =>
  options.access !== undefined && options.access().screen !== ScreenAccessState.Granted;

/** Take one window's picture, shrink it, read it and remove it. */
async function capture(options: MacAppLookOptions, window: AppWindow): Promise<Picture | AppLookProblem> {
  const { run, scratchDir } = options;
  const timing = { timeoutMs: APP_LOOK_COMMAND_TIMEOUT_MS };
  await mkdir(scratchDir, { recursive: true });
  const dir = await mkdtemp(path.join(scratchDir, "app-look-"));
  const file = path.join(dir, "window.jpg");
  try {
    const taken = await run(SCREENCAPTURE, ["-x", "-o", "-t", "jpg", "-l", String(window.id), file], timing);
    const bytes = taken.code === 0 ? await readFile(file).catch(() => null) : null;
    if (!bytes?.length) {
      if (screenRefused(options)) return problem(AppLookProblemCode.NoScreenAccess);
      return { image: null, note: plainText(taken.stderr, APP_LOOK_TEXT_MAX_CHARS) || "no picture" };
    }
    await run(SIPS, ["-Z", String(APP_LOOK_MAX_EDGE), file], timing);
    const shrunk = (await readFile(file).catch(() => null)) ?? bytes;
    if (shrunk.length > APP_LOOK_MAX_IMAGE_BYTES) return { image: null, note: "the picture was too large" };
    return { image: { mimeType: "image/jpeg", data: shrunk.toString("base64") } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Read one window's accessibility tree; its pid, title and place reach the script only as arguments. */
async function readTree(run: AppLookRun, window: AppWindow) {
  const { x, y, width, height } = window.bounds;
  const place = [x, y, width, height].map((n) => String(Math.round(n)));
  // The pid comes first and is never an option, so `osascript` reads every argument after it as
  // the script's own, a title that starts with "-" included.
  const args = [...JXA, AX_TREE_SCRIPT, String(window.pid), window.title, ...place];
  const read = await run(OSASCRIPT, args, { timeoutMs: APP_LOOK_COMMAND_TIMEOUT_MS });
  if (read.code === 0) return parseAxTree(read.stdout);
  if (axRefused(read.stderr)) return problem(AppLookProblemCode.NoAxAccess);
  return { tree: "", truncated: false, note: "the accessibility tree could not be read" };
}

/** The macOS port: the window list from Core Graphics, a picture by `screencapture`, the tree through System Events. */
export function macAppLook(options: MacAppLookOptions): AppLookPort {
  return {
    async windows() {
      const listed = await options.run(OSASCRIPT, [...JXA, WINDOW_LIST_SCRIPT], {
        timeoutMs: APP_LOOK_COMMAND_TIMEOUT_MS,
      });
      if (listed.code !== 0)
        return problem(AppLookProblemCode.Failed, plainText(listed.stderr, APP_LOOK_TEXT_MAX_CHARS));
      return parseWindowList(listed.stdout);
    },
    async look(window) {
      const picture = await capture(options, window);
      if (isAppLookProblem(picture)) return picture;
      const tree = await readTree(options.run, window);
      if (isAppLookProblem(tree)) return tree;
      const notes = [picture.note, "note" in tree ? tree.note : undefined].filter(Boolean).join("; ");
      return {
        window,
        image: picture.image,
        tree: tree.tree,
        truncated: tree.truncated,
        ...(notes ? { note: notes } : {}),
      };
    },
  };
}

/** A 1×1 grey JPEG: the stub's picture. */
const STUB_JPEG =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

/** The stub's one window. */
const STUB_WINDOW: AppWindow = {
  id: 1,
  app: "Fixture App",
  bundleId: "dev.genex.fixture-app",
  pid: 1,
  title: "Fixture Window",
  bounds: { x: 0, y: 0, width: 640, height: 480 },
  onScreen: true,
};

/** Tests' and fixture profiles' port: one fixture window, a fixed picture and a two-line tree; nothing on the Mac. */
export function stubAppLook(): AppLookPort {
  return {
    windows: async () => [{ ...STUB_WINDOW, bounds: { ...STUB_WINDOW.bounds } }],
    look: async (window) =>
      window.id === STUB_WINDOW.id
        ? {
            window,
            image: { mimeType: "image/jpeg", data: STUB_JPEG },
            tree: 'AXWindow "Fixture Window"\n  AXButton "Play"',
            truncated: false,
          }
        : problem(AppLookProblemCode.NotOnScreen),
  };
}

/** Other systems' port: `app_look` works on macOS only for now. */
export function unsupportedAppLook(): AppLookPort {
  return {
    windows: async () => problem(AppLookProblemCode.Unsupported),
    look: async () => problem(AppLookProblemCode.Unsupported),
  };
}

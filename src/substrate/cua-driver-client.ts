/**
 * cua-driver (trycua/cua, MIT) as the studio's desktop driver. The driver speaks MCP over stdio
 * (`cua-driver mcp`). On this Mac the studio runs its own embedded daemon (`cua-embedded.ts`), so
 * the Accessibility and Screen Recording grants are the studio's. A VM is reached over SSH into the
 * guest (`ssh -T lume@<ip> cua-driver mcp`), where the guest's CuaDriver.app holds them; one client
 * drives both.
 *
 * Every action targets the whole display (`{kind: "desktop"}`) in the foreground: the real pointer
 * and keyboard, the way a person would, because background clicks into a canvas are rerouted and
 * reported as success (cua #4350). Pointer coordinates are pixels of the last `get_desktop_state`
 * picture, which the driver maps back to the screen itself.
 *
 * The driver is a host helper, not an agent or a game: it is started with a fixed argument list and
 * a minimal environment, outside the ProcessSandbox, which would deny it the screen it exists to see.
 */
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SECOND_MS } from "../shared/duration.ts";
import { errorMessage } from "../shared/errors.ts";
import type { DesktopApp, DesktopDriver, DesktopFocus, DesktopShot } from "./desktop-driver.ts";
import { type MacApps, macApps } from "./mac-apps.ts";
import { cuaWeb, refusalError } from "./cua-web.ts";
import { randomUUID } from "node:crypto";

/** The longest side of a desktop picture the model is shown: the driver's own default on macOS. */
const MAX_IMAGE_DIMENSION = 1366;
/** How long one driver call may take. */
const CALL_TIMEOUT_MS = 30 * SECOND_MS;
/** How long the driver has to start and answer its first call: its own daemon wait is 10 s. */
const CONNECT_TIMEOUT_MS = 15 * SECOND_MS;
/** How much of the driver's stderr is kept to say why it did not start. */
const MAX_STDERR_CHARS = 2_000;
/** How long the secure-input check may take. */
const SECURE_INPUT_TIMEOUT_MS = 2 * SECOND_MS;
/** The most wheel notches one scroll sends, and how many a scroll that names none sends. */
const MAX_SCROLL_NOTCHES = 50;
const DEFAULT_SCROLL_NOTCHES = 3;
/** How long one app listing answers for: the calls of one action, never a stale front app later. */
const APPS_TTL_MS = 1_500;
/** How many accessibility elements a state read brings back. */
const MAX_ELEMENTS = 250;
/**
 * A password field in an accessibility tree row: cua prints a field's role, not its secure
 * subrole, so a text field labelled as a password is taken for one.
 */
const PASSWORD_FIELD = /AX(?:Secure)?TextField[^\n]*(?:password|passcode|passwort|mot de passe|contraseña|пароль)/i;
/** Where the driver's installer puts its command, and where a package manager might: a development build's driver. */
const DRIVER_PLACES = [".local/bin/cua-driver", "/opt/homebrew/bin/cua-driver", "/usr/local/bin/cua-driver"] as const;
/** A VM's SSH address: a user and a host, nothing a shell or ssh could read as an option. */
const VM_ADDRESS = /^[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9.-]{1,253}$/;
/** Where the guest image keeps the driver. */
const VM_DRIVER_PATH = "/Users/lume/.local/bin/cua-driver";

/** The driver's own app: its agent-cursor overlay is a full-screen window above every other. */
const DRIVER_BUNDLE = "com.trycua.driver";
const DRIVER_APP_NAME = "Cua Driver";

/** The whole primary display, the target of every action. */
const DESKTOP = { kind: "desktop", display_id: "primary" } as const;

/** What the person reads when the driver cannot be used. */
const MESSAGE = {
  permissions: {
    host: "Genex needs Accessibility and Screen Recording to use this computer: turn Genex on in System Settings → Privacy & Security → Accessibility and → Screen & System Audio Recording, then try again",
    driver:
      "cua-driver needs Accessibility and Screen Recording: allow CuaDriver in System Settings → Privacy & Security, then try again",
  },
  noPicture: "cua-driver answered without a picture of the screen",
  failed: (tool: string, why: string) => `cua-driver ${tool} failed: ${why}`,
} as const;

/** One MCP content item, as the driver returns it. */
interface CuaContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** One tool call's answer. */
export interface CuaAnswer {
  content?: CuaContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** A tool call over the driver's MCP connection, and how to close it. */
export interface CuaConnection {
  call(tool: string, args: Record<string, unknown>): Promise<CuaAnswer>;
  close(): Promise<void>;
}

/** The command line that starts a driver: this Mac's, or a VM's over SSH, and what it adds to the environment. */
export interface CuaCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Who holds the grants a driver needs: the studio itself (embedded), or the driver's own app (a VM's). */
export const GrantHolder = { Host: "host", Driver: "driver" } as const;
export type GrantHolder = (typeof GrantHolder)[keyof typeof GrantHolder];

/** A VM's driver over SSH, when its address is a plain `user@host`; null otherwise. */
export function vmDriverCommand(address: string): CuaCommand | null {
  if (!VM_ADDRESS.test(address)) return null;
  return { command: "ssh", args: ["-T", "-o", "BatchMode=yes", "--", address, VM_DRIVER_PATH, "mcp"] };
}

/**
 * The driver to run: the one bundled with the app, else an installed one (the installer's wrapper,
 * or one on a usual path); null when there is none.
 */
export async function findCuaDriver(options: { bundled?: string; home?: string } = {}): Promise<string | null> {
  const home = options.home ?? os.homedir();
  const places = [...(options.bundled ? [options.bundled] : []), ...DRIVER_PLACES];
  for (const place of places) {
    const full = path.isAbsolute(place) ? place : path.join(home, place);
    const runnable = await access(full, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (runnable) return full;
  }
  return null;
}

/** The answer as one object: its structured content, or its text read as JSON. */
function structured(answer: CuaAnswer): Record<string, unknown> {
  const own = answer.structuredContent;
  if (own && typeof own === "object" && !Array.isArray(own)) return own as Record<string, unknown>;
  for (const item of answer.content ?? []) {
    if (item.type !== "text" || !item.text) continue;
    try {
      const parsed: unknown = JSON.parse(item.text);
      if (parsed && typeof parsed === "object")
        return (Array.isArray(parsed) ? { items: parsed } : parsed) as Record<string, unknown>;
    } catch {
      // Prose, not JSON: the caller reads the text itself.
    }
  }
  return {};
}

/** A window state's tree as text: its Markdown rendering, else whatever text the answer carries. */
function treeText(answer: CuaAnswer): string {
  const markdown = structured(answer).tree_markdown;
  return typeof markdown === "string" ? markdown : textOf(answer);
}

/** A password field in a window state: an element's role and label, else one Markdown row. */
function hasPasswordField(answer: CuaAnswer): boolean {
  const elements = structured(answer).elements;
  if (Array.isArray(elements)) {
    return elements.some((element) => {
      const row = element && typeof element === "object" ? (element as Record<string, unknown>) : {};
      return PASSWORD_FIELD.test(`${String(row.role ?? "")} ${String(row.label ?? "")}`);
    });
  }
  return treeText(answer)
    .split("\n")
    .some((line) => PASSWORD_FIELD.test(line));
}

/** The answer's text, joined. */
function textOf(answer: CuaAnswer): string {
  return (answer.content ?? [])
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text)
    .join("\n");
}

/** A list field of an answer, whatever it is called. */
function listOf(answer: CuaAnswer, ...names: string[]): Record<string, unknown>[] {
  const body = structured(answer);
  for (const name of [...names, "items"]) {
    const value = body[name];
    if (Array.isArray(value))
      return value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object");
  }
  return [];
}

/** A number, or null. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** An app as the studio names it, from a `list_apps` row. */
function appOf(row: Record<string, unknown>): DesktopApp {
  return {
    name: typeof row.name === "string" ? row.name : "",
    bundleId: typeof row.bundle_id === "string" ? row.bundle_id : null,
    pid: num(row.pid),
  };
}

/** A window from a `list_windows` row: its owner and where it is on screen, in points. */
interface CuaWindow {
  pid: number | null;
  windowId: number | null;
  appName: string;
  z: number;
  bounds: { x: number; y: number; width: number; height: number } | null;
}

function windowOf(row: Record<string, unknown>, index: number): CuaWindow {
  const b = row.bounds && typeof row.bounds === "object" ? (row.bounds as Record<string, unknown>) : null;
  const bounds =
    b && num(b.x) !== null && num(b.y) !== null && num(b.width) !== null && num(b.height) !== null
      ? { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number }
      : null;
  // cua numbers windows so the largest z_index is the frontmost; without one, the list is front first.
  const appName = typeof row.app_name === "string" ? row.app_name : "";
  return { pid: num(row.pid), windowId: num(row.window_id), appName, z: num(row.z_index) ?? -index, bounds };
}

/** Whether a window holds a point. */
function holds(window: CuaWindow, x: number, y: number): boolean {
  const b = window.bounds;
  return b !== null && x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;
}

/** A scroll as the driver takes it: a direction and a number of notches. */
function scrollOf(dx: number, dy: number): { direction: string; amount: number } {
  const vertical = Math.abs(dy) >= Math.abs(dx);
  const delta = vertical ? dy : dx;
  const [back, forth] = vertical ? ["up", "down"] : ["left", "right"];
  const amount = Math.max(1, Math.min(MAX_SCROLL_NOTCHES, Math.round(Math.abs(delta)) || DEFAULT_SCROLL_NOTCHES));
  return { direction: delta < 0 ? back : forth, amount };
}

/** A tool call that throws the driver's own words when it answers with an error. */
type CuaCall = (tool: string, args: Record<string, unknown>) => Promise<CuaAnswer>;

/**
 * What the driver says about the desktop: the apps, the on-screen windows front first — never the
 * driver's own cursor overlay, which no click is meant for — and the front window's accessibility
 * tree. On this Mac, apps come from Launch Services (`mac-apps.ts`, milliseconds); the driver's own
 * listing, which walks every installed app, is the fallback (one listing serves one action's calls).
 */
function desktopReads(call: CuaCall, mac: MacApps | undefined) {
  let apps: { at: number; rows: Promise<Record<string, unknown>[]> } | null = null;
  const appRows = (): Promise<Record<string, unknown>[]> => {
    if (!apps || Date.now() - apps.at > APPS_TTL_MS) {
      const rows = call("list_apps", {}).then((answer) => listOf(answer, "apps"));
      apps = { at: Date.now(), rows };
      rows.catch(() => {
        apps = null;
      });
    }
    return apps.rows;
  };
  const appOfPid = async (pid: number): Promise<DesktopApp | null> => {
    if (mac) return mac.byPid(pid);
    const row = (await appRows()).find((app) => num(app.pid) === pid);
    return row ? appOf(row) : null;
  };
  const windows = async (pid?: number): Promise<CuaWindow[]> => {
    const rows = listOf(await call("list_windows", { on_screen_only: true, ...(pid ? { pid } : {}) }), "windows");
    const listed = rows.map(windowOf).sort((a, b) => b.z - a.z);
    const kept: CuaWindow[] = [];
    for (const window of listed) {
      const named = window.appName === DRIVER_APP_NAME;
      const owner = !named && window.pid !== null && mac ? await mac.byPid(window.pid) : null;
      if (!named && owner?.bundleId !== DRIVER_BUNDLE) kept.push(window);
    }
    return kept;
  };
  return {
    appOfPid,
    windows,
    frontApp: async (): Promise<DesktopApp | null> => {
      if (mac) return mac.front();
      const front = (await appRows()).find((row) => row.active === true);
      return front ? appOf(front) : null;
    },
    frontTree: async (app: DesktopApp | null): Promise<CuaAnswer | null> => {
      if (!app?.pid) return null;
      const [front] = await windows(app.pid);
      if (!front?.windowId) return null;
      return call("get_window_state", {
        pid: app.pid,
        window_id: front.windowId,
        include_screenshot: false,
        include_accessibility_tree: true,
        max_elements: MAX_ELEMENTS,
      });
    },
  };
}

/**
 * The driver over one connection: each studio call as the driver's tools. `screenshot` remembers
 * the picture's size and the screen's, so `appAt` can find the window under a picture's point.
 */
export function cuaDriver(
  connection: CuaConnection,
  options: { secureInput?: () => Promise<boolean>; mac?: MacApps } = {},
): DesktopDriver {
  let picture = { width: 1, height: 1 };
  let screen = { width: 1, height: 1 };
  const call: CuaCall = async (tool, args) => {
    const answer = await connection.call(tool, args);
    if (answer.isError) throw new Error(MESSAGE.failed(tool, textOf(answer) || "an error"));
    // A refusal can come back as an answer that is not an error: its own words are the reason, and
    // its code travels with the error for the caller to act on.
    const body = structured(answer);
    if (!isRefusal(body)) return answer;
    const { code, why } = refusalOf(body);
    throw refusalError(MESSAGE.failed(tool, why || textOf(answer)), code);
  };
  const act = (tool: string, args: Record<string, unknown>) =>
    call(tool, { target: DESKTOP, delivery_mode: "foreground", ...args }).then(() => undefined);
  const { appOfPid, windows, frontApp, frontTree } = desktopReads(call, options.mac);
  return {
    screenshot: async (): Promise<DesktopShot> => {
      const answer = await call("get_desktop_state", { max_image_dimension: MAX_IMAGE_DIMENSION });
      const image = (answer.content ?? []).find((item) => item.type === "image" && item.data);
      if (!image?.data) throw new Error(MESSAGE.noPicture);
      const body = structured(answer);
      const bytes = Buffer.from(image.data, "base64");
      picture = {
        width: num(body.screenshot_width) ?? pngWidth(bytes) ?? MAX_IMAGE_DIMENSION,
        height: num(body.screenshot_height) ?? pngHeight(bytes) ?? MAX_IMAGE_DIMENSION,
      };
      screen = { width: num(body.screen_width) ?? picture.width, height: num(body.screen_height) ?? picture.height };
      return {
        image: bytes,
        mime: image.mimeType === "image/jpeg" ? "image/jpeg" : "image/png",
        width: picture.width,
        height: picture.height,
        // The driver maps the picture's pixels back to the screen: the picture is the space actions use.
        screen: { ...picture },
      };
    },
    // On this Mac, macOS's own secure input says a password field has the keyboard, in milliseconds;
    // elsewhere (a VM) a field labelled as a password in the front window's tree stands in for it.
    focus: async (): Promise<DesktopFocus> => {
      const app = await frontApp();
      if (options.secureInput) return { app, secure: await options.secureInput().catch(() => false) };
      const tree = await frontTree(app).catch(() => null);
      return { app, secure: tree !== null && hasPasswordField(tree) };
    },
    appAt: async (x, y) => {
      const point = { x: (x * screen.width) / picture.width, y: (y * screen.height) / picture.height };
      const under = (await windows()).find((window) => holds(window, point.x, point.y));
      if (!under?.pid) return null;
      return (await appOfPid(under.pid)) ?? { name: under.appName, bundleId: null, pid: under.pid };
    },
    // move_cursor takes no delivery mode, and a desktop target is its own scope.
    move: (x, y) => call("move_cursor", { target: DESKTOP, x, y }).then(() => undefined),
    click: (x, y, o) =>
      act("click", {
        x,
        y,
        button: o.button,
        count: o.count,
        ...(o.modifiers.length ? { modifier: o.modifiers } : {}),
      }),
    mouse: () =>
      Promise.reject(
        new Error(MESSAGE.failed("mouse", "the desktop driver presses and releases only as a click or a drag")),
      ),
    drag: (from, to, button) => act("drag", { from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y, button }),
    scroll: (x, y, dx, dy) => act("scroll", { x, y, ...scrollOf(dx, dy) }),
    type: (text) => act("type_text", { text }),
    press: (keys) => {
      const key = keys.at(-1);
      if (!key) return Promise.resolve();
      return act("press_key", { key, ...(keys.length > 1 ? { modifiers: keys.slice(0, -1) } : {}) });
    },
    // Targets, tabs and refs belong to one session label, ended for good when this connection
    // closes: each connection names its own.
    web: cuaWeb(
      async (tool, args) => {
        const answer = await call(tool, args);
        return { body: structured(answer), image: imageOf(answer) };
      },
      { session: `genex-${randomUUID().slice(0, 12)}`, appOf: appOfPid },
    ),
    accessibility: async () => {
      const app = await frontApp();
      const tree = await frontTree(app);
      return tree ? treeText(tree) : null;
    },
    close: () => connection.close(),
  };
}

/** Whether an answer refuses: an action's `effect`, or a browser call's `status` (cua-driver 0.34). */
function isRefusal(body: Record<string, unknown>): boolean {
  return body.effect === "refused" || body.status === "refused";
}

/**
 * The reason a refused call gives: its code, and the code with its hint or message — an action
 * answers `error: {code, hint}`, a browser call `refusal: {code, message}` — or its summary.
 */
function refusalOf(body: Record<string, unknown>): { code: string; why: string } {
  const detail = [body.error, body.refusal].find((value) => value && typeof value === "object");
  const fields = (detail ?? {}) as Record<string, unknown>;
  const code = typeof fields.code === "string" ? fields.code : "";
  const words = [fields.hint, fields.message].find((value) => typeof value === "string");
  const why = [code, words].filter(Boolean).join(": ");
  return { code, why: why || (typeof body.summary === "string" ? body.summary : "") };
}

/** The first picture an answer carries, as bytes. */
function imageOf(answer: CuaAnswer): Buffer | null {
  const image = (answer.content ?? []).find((item) => item.type === "image" && item.data);
  return image?.data ? Buffer.from(image.data, "base64") : null;
}

/** A PNG's width from its header, or null for anything else. */
function pngWidth(bytes: Buffer): number | null {
  return bytes.length > 24 && bytes.readUInt32BE(12) === 0x49484452 ? bytes.readUInt32BE(16) : null;
}

/** A PNG's height from its header, or null for anything else. */
function pngHeight(bytes: Buffer): number | null {
  return bytes.length > 24 && bytes.readUInt32BE(12) === 0x49484452 ? bytes.readUInt32BE(20) : null;
}

/** The driver's environment: enough to run, nothing of the studio's own (no API key reaches it). */
export function driverEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "USER", "LOGNAME"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

/** An MCP connection to a driver command, over the SDK's stdio transport. */
async function openConnection(command: CuaCommand): Promise<CuaConnection> {
  const { Client } = (await import("@modelcontextprotocol/sdk/client/index.js")) as unknown as {
    Client: new (info: {
      name: string;
      version: string;
    }) => {
      connect(transport: unknown, options?: { timeout?: number }): Promise<void>;
      callTool(
        params: { name: string; arguments: Record<string, unknown> },
        schema?: unknown,
        options?: { timeout?: number },
      ): Promise<CuaAnswer>;
      close(): Promise<void>;
    };
  };
  const { StdioClientTransport } = (await import("@modelcontextprotocol/sdk/client/stdio.js")) as unknown as {
    StdioClientTransport: new (options: {
      command: string;
      args: string[];
      env: Record<string, string>;
      stderr: "pipe";
    }) => { stderr: NodeJS.ReadableStream | null };
  };
  const client = new Client({ name: "genex-studio", version: "1" });
  const transport = new StdioClientTransport({
    command: command.command,
    args: command.args,
    env: { ...driverEnv(), ...command.env },
    stderr: "pipe",
  });
  // The driver says why it could not start on stderr (its daemon never came up, a grant is missing).
  let said = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    said = `${said}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
  });
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS }).catch((error: unknown) => {
    throw new Error(said.trim() || errorMessage(error));
  });
  return {
    call: (tool, args) => client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS }),
    close: () => client.close().catch(() => {}),
  };
}

/**
 * Whether the driver holds what it needs to see and move: both grants. Never asks the driver to
 * prompt: an embedded driver never does (the studio asks macOS itself), and a VM's standalone
 * daemon refuses a prompt from an untrusted host.
 */
async function permitted(connection: CuaConnection): Promise<Grants> {
  const answer = await connection.call("check_permissions", { prompt: false });
  // A daemon started before the person granted keeps macOS's old answer until it restarts.
  if (textOf(answer).includes(PERMISSIONS_PENDING)) return Grants.Pending;
  const body = structured(answer);
  const unreported = body.accessibility === undefined && body.screen_recording === undefined;
  if (unreported) return answer.isError ? Grants.Missing : Grants.Held;
  return body.accessibility === true && body.screen_recording === true ? Grants.Held : Grants.Missing;
}

/** What the driver's grants are: held, missing, or granted but not yet seen by a daemon started before. */
const Grants = { Held: "held", Missing: "missing", Pending: "pending" } as const;
type Grants = (typeof Grants)[keyof typeof Grants];

/** The words cua-driver answers with while its permission gate still waits. */
const PERMISSIONS_PENDING = "permissions_pending";

/**
 * Whether macOS is guarding typed input for a password field right now (secure event input): the
 * console session then names the process holding it. This Mac only; a VM's is out of reach.
 */
export async function secureInputActive(): Promise<boolean> {
  const { stdout } = await promisify(execFile)("ioreg", ["-l", "-w", "0", "-d", "1", "-k", "IOConsoleUsers"], {
    timeout: SECURE_INPUT_TIMEOUT_MS,
  });
  return stdout.includes("kCGSSessionSecureInputPID");
}

/**
 * Connect to a driver and check it can see and move. `command` is read again after a restart, since
 * a restarted embedded daemon listens on a new socket. A driver that started before the grants were
 * given keeps macOS's old answer, so one without them is restarted once; still without them,
 * `askForGrants` asks macOS for them (the studio's own prompt or System Settings) and the sentence
 * the person reads is the error. On this Mac, a focused password field is also read from macOS.
 */
export async function connectCuaDriver(
  command: CuaCommand | (() => Promise<CuaCommand>),
  options: {
    local: boolean;
    holder?: GrantHolder;
    restart?: () => Promise<void>;
    askForGrants?: () => Promise<void>;
  },
): Promise<DesktopDriver> {
  const commandNow = typeof command === "function" ? command : async () => command;
  const attempt = async (): Promise<{ connection: CuaConnection; grants: Grants }> => {
    const connection = await openConnection(await commandNow());
    const grants = await permitted(connection).catch(async (error: unknown) => {
      await connection.close();
      throw error;
    });
    if (grants !== Grants.Held) await connection.close();
    return { connection, grants };
  };
  let opened = await attempt();
  if (opened.grants !== Grants.Held && options.restart) {
    await options.restart().catch(() => {});
    opened = await attempt();
  }
  if (opened.grants !== Grants.Held) {
    await options.askForGrants?.().catch(() => {});
    throw new Error(MESSAGE.permissions[options.holder ?? GrantHolder.Driver]);
  }
  return cuaDriver(opened.connection, options.local ? { secureInput: secureInputActive, mac: macApps() } : {});
}

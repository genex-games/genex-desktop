/**
 * cua-driver's browser tools as the studio's web pages (`DesktopWeb`). The browser is a separate,
 * driver-owned Chromium with a fresh profile (`browser_prepare` `isolated_new`): no cookies, no
 * logins, none of the person's tabs. It lives as long as the driver connection, so a stop closes it.
 *
 * What cua-driver showed on a real Mac (0.34.0), and what this follows from it:
 * - targets, tabs and refs belong to one `session` label, which is ended for good when its
 *   connection closes — so every connection gets its own label;
 * - a trusted click on macOS is refused unless it may bring the browser forward
 *   (`browser_input_trust_unavailable`), so clicks are sent in the foreground;
 * - a refusal comes back as `effect: "refused"` or `status: "refused"` without `isError` — the caller
 *   treats it as one and keeps its code;
 * - a page's text is split over many small refs (text runs between links), so the page is drawn
 *   from the action refs and the content refs together, in document order, each element with its ref;
 * - a launched browser can show a second, transient window the driver cannot tie to a tab
 *   (`browser_wrong_target_refused`), so each of its windows is tried;
 * - every snapshot supersedes the refs of the one before (`browser_ref_stale`);
 * - `semantic_v2` gives a password input as a plain `textbox`; only `dom_refs_v1` says
 *   `type=password`. So each read takes the DOM refs first, then the semantic snapshot whose refs
 *   stay live, and marks the fields that ask for a secret by the names the two share.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { DesktopApp, DesktopWeb, WebElement, WebSnapshot } from "./desktop-driver.ts";

/** How long a launched browser is given to show its window. */
const WINDOW_WAIT_MS = 5_000;
const WINDOW_POLL_MS = 250;
/** How long a page is given to settle after a navigation, a click or a submit. */
const SETTLE_MS = 1_200;
/**
 * The roles the model acts on, each with a ref: cua offers a pointer on nearly everything (text
 * runs, wrappers), and a ref on each of those would bury the page's controls.
 */
const CONTROL_ROLES: ReadonlySet<string> = new Set([
  "link",
  "button",
  "searchbox",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "slider",
  "spinbutton",
  "listbox",
  "treeitem",
]);
/**
 * The control roles that are pressed, never typed into: cua offers `type` on some of them (a submit
 * input), and a button is no field.
 */
const PRESSED_ROLES: ReadonlySet<string> = new Set([
  "link",
  "button",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
]);
/** A link is followed through the page itself: a trusted click on macOS can land without following it. */
const FOLLOWED_ROLES: ReadonlySet<string> = new Set(["link"]);
/** The page's roles that carry no words of their own. */
const SILENT_ROLES: ReadonlySet<string> = new Set(["generic", "none", "presentation", "group", "rootwebarea"]);
/** How deep the page's text indents its structure. */
const MAX_INDENT = 6;
/** The visibility words that need saying: an element in the viewport is the plain case. */
const PLAIN_VISIBILITY = "in_viewport";

/** The refusal codes cua-driver answers browser calls with, that the studio acts on. */
export const CuaBrowserRefusal = {
  /** The bound browser is gone or restarted: the person closed it. */
  BindingStale: "browser_binding_stale",
  /** The bound browser's DevTools endpoint no longer answers. */
  RouteUnavailable: "browser_route_unavailable",
} as const;
export type CuaBrowserRefusal = (typeof CuaBrowserRefusal)[keyof typeof CuaBrowserRefusal];

/** The refusals that mean the browser itself is gone, not just this call. */
const LOST_BROWSER: ReadonlySet<string> = new Set([CuaBrowserRefusal.BindingStale, CuaBrowserRefusal.RouteUnavailable]);
/** The attributes `dom_refs_v1` writes into an element's label, as `key=value` pairs. */
const DOM_LABEL_KEY = /(?:^|\s)(aria-label|placeholder|name|id|type|role|value|title|href|alt)=/g;

/** What the model reads when the browser cannot be used. */
const MESSAGE = {
  noWindow: "the browser opened no window the driver could bind",
  notStarted: "the browser did not start",
  closed: "the browser was closed — web_open text=<address> opens a fresh one",
  secretMark: " (asks for a secret: never typed into)",
} as const;

/** An error that carries the driver's refusal code. */
export type RefusalError = Error & { code: string };

/** An error with the driver's refusal code beside its words. */
export function refusalError(message: string, code: string): RefusalError {
  return Object.assign(new Error(message), { code });
}

/** The driver's refusal code an error carries, or "". */
export function refusalCode(error: unknown): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "";
}

/** One driver call: its structured answer and the picture it carried, or a throw with the driver's own reason. */
export type WebCall = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<{ body: Record<string, unknown>; image: Buffer | null }>;

/** A ref the page lists, as cua-driver gives it. */
interface CuaRef {
  ref?: unknown;
  role?: unknown;
  name?: unknown;
  value?: unknown;
  actions?: unknown;
  visibility?: unknown;
}

/** A string field, or "". */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Whether an action ref is one of the page's controls: a control role, or a field text goes into —
 * not a field's nameless inner editor, which cua lists beside the field itself.
 */
function isControl(row: CuaRef): boolean {
  const actions = Array.isArray(row.actions) ? row.actions : [];
  const innerEditor = SILENT_ROLES.has(str(row.role)) && !str(row.name);
  return CONTROL_ROLES.has(str(row.role)) || (actions.includes("type") && !innerEditor);
}

/** An element the model may act on, from an action ref. */
function elementOf(row: CuaRef, secrets: SecretFields): WebElement | null {
  const ref = str(row.ref);
  if (!ref || !isControl(row)) return null;
  const actions = Array.isArray(row.actions) ? row.actions : [];
  const editable = actions.includes("type") && !PRESSED_ROLES.has(str(row.role));
  return { ref, role: str(row.role), name: str(row.name), editable, secret: editable && isSecret(row, secrets) };
}

/** The page's password inputs, as its DOM refs name them. */
export interface SecretFields {
  /** The names (aria-label, placeholder) a password input goes by. */
  secret: ReadonlySet<string>;
  /** The names the page's other text fields go by. */
  plain: ReadonlySet<string>;
  /** Whether a password input has no name a semantic field could share (it is labelled by a `<label>`, or not at all). */
  unplaced: boolean;
}

/** A name compared across the two snapshots. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** A DOM ref's label (`name=p id=p type=password`) as its attributes. */
function domAttributes(label: string): Map<string, string> {
  const marks = [...label.matchAll(DOM_LABEL_KEY)];
  return new Map(
    marks.map((mark, i) => {
      const start = (mark.index ?? 0) + mark[0].length;
      const end = marks[i + 1]?.index ?? label.length;
      return [mark[1] ?? "", label.slice(start, end).trim()];
    }),
  );
}

/** The password inputs `dom_refs_v1` lists, and the names the page's other fields go by. */
export function secretFields(domRefs: readonly unknown[]): SecretFields {
  const secret = new Set<string>();
  const plain = new Set<string>();
  let unplaced = false;
  for (const raw of domRefs) {
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (str(row.node) !== "input" && str(row.node) !== "textarea") continue;
    const attributes = domAttributes(str(row.label));
    const names = [attributes.get("aria-label"), attributes.get("placeholder")].filter((n): n is string => !!n);
    const isPassword = attributes.get("type")?.toLowerCase() === "password";
    for (const name of names) (isPassword ? secret : plain).add(nameKey(name));
    if (isPassword && names.length === 0) unplaced = true;
  }
  return { secret, plain, unplaced };
}

/**
 * Whether a field asks for a secret: a password input goes by its name, or the page has a password
 * input no name places and nothing places this field as another one.
 */
function isSecret(row: CuaRef, secrets: SecretFields): boolean {
  const key = nameKey(str(row.name));
  if (secrets.secret.has(key)) return true;
  return secrets.unplaced && !secrets.plain.has(key);
}

/** One line of cua's outline: its depth, role, quoted name and the rest. */
const OUTLINE_LINE = /^(\s*)- (\S+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/;
/** Where an element is, when it is not in the viewport. */
function whereOf(row: CuaRef): string {
  const visibility = str(row.visibility);
  return visibility && visibility !== PLAIN_VISIBILITY ? ` (${visibility.replace(/_/g, " ")})` : "";
}

/** The note on a field that asks for a secret, so the model does not try it. */
function secretMark(row: CuaRef, secretRefs: ReadonlySet<string>): string {
  return secretRefs.has(str(row.ref)) ? MESSAGE.secretMark : "";
}

/** The action refs by role and name, in page order, each taken once as the outline reaches it. */
function refQueues(actionRefs: readonly CuaRef[]): Map<string, CuaRef[]> {
  const queues = new Map<string, CuaRef[]>();
  for (const row of actionRefs.filter(isControl)) {
    const key = `${str(row.role)}\u0000${str(row.name)}`;
    queues.set(key, [...(queues.get(key) ?? []), row]);
  }
  return queues;
}

/** The element a line sits inside: its depth and its name, whose words its children repeat. */
interface Holder {
  depth: number;
  name: string;
}

/** One outline line as the page's text: the element with its ref, or the words it holds; null to skip. */
function outlineLine(
  line: string,
  queues: Map<string, CuaRef[]>,
  holder: Holder | null,
  secretRefs: ReadonlySet<string>,
): string | null {
  const match = OUTLINE_LINE.exec(line);
  if (!match) return null;
  const [, indent = "", role = "", rawName = ""] = match;
  const name = rawName.replace(/\\"/g, '"');
  const row = queues.get(`${role}\u0000${name}`)?.shift();
  const pad = " ".repeat(Math.min(indent.length / 2, MAX_INDENT));
  if (row) {
    const value = str(row.value);
    return `${pad}[${str(row.ref)}] ${role} "${name}"${value ? ` = "${value}"` : ""}${whereOf(row)}${secretMark(row, secretRefs)}`;
  }
  const repeats = holder !== null && indent.length > holder.depth && holder.name.includes(name);
  if (!name || SILENT_ROLES.has(role) || repeats) return null;
  if (role === "heading") return `${pad}# ${name}`;
  return role === "statictext" ? `${pad}${name}` : `${pad}${role} "${name}"`;
}

/**
 * The page as text, in document order (cua's outline), every element the model may act on carrying
 * its ref inline — a link's own words are not said twice. Elements the outline did not reach follow.
 */
export function pageText(
  outline: string,
  actionRefs: readonly CuaRef[],
  secretRefs: ReadonlySet<string> = new Set(),
): string {
  const queues = refQueues(actionRefs);
  const lines: string[] = [];
  // The last element said with a ref: the words inside it only repeat its name.
  let holder: Holder | null = null;
  for (const line of outline.split("\n")) {
    const match = OUTLINE_LINE.exec(line);
    const depth = match?.[1]?.length ?? 0;
    if (holder && depth <= holder.depth) holder = null;
    const text = outlineLine(line, queues, holder, secretRefs);
    if (text === null) continue;
    lines.push(text);
    if (text.trimStart().startsWith("[")) holder = { depth, name: (match?.[3] ?? "").replace(/\\"/g, '"') };
  }
  const rest = [...queues.values()].flat();
  if (rest.length) {
    lines.push("Other elements:");
    for (const row of rest)
      lines.push(`[${str(row.ref)}] ${str(row.role)} "${str(row.name)}"${whereOf(row)}${secretMark(row, secretRefs)}`);
  }
  return lines.join("\n");
}

/** A browser bound for driving: its process, and the tab the studio drives. */
interface Bound {
  pid: number;
  target: string;
  tab: string;
}

/** The tab a bind answer names: the active one, or the first. */
function activeTab(state: Record<string, unknown>): string {
  const tabs = Array.isArray(state.tabs) ? (state.tabs as Array<Record<string, unknown>>) : [];
  return str((tabs.find((t) => t.active === true) ?? tabs[0])?.tab_id);
}

/**
 * The web pages over cua-driver's browser tools: the browser launched on first use, bound to its
 * window's active tab, and every call carrying this connection's own session label. A browser the
 * person closed is let go; the next `navigate` launches a fresh one.
 */
export function cuaWeb(
  call: WebCall,
  options: { session: string; appOf: (pid: number) => Promise<DesktopApp | null> },
): DesktopWeb {
  let bound: Bound | null = null;
  const session = options.session;
  const windowsOf = async (pid: number): Promise<number[]> => {
    const { body: answer } = await call("list_windows", { pid, on_screen_only: false });
    const windows = Array.isArray(answer.windows) ? (answer.windows as Array<Record<string, unknown>>) : [];
    return windows.map((window) => window.window_id).filter((id): id is number => typeof id === "number");
  };
  /** The first of the browser's windows the driver ties to a tab, waited for while the browser starts. */
  const bindWindow = async (pid: number): Promise<Bound> => {
    for (let waited = 0; waited <= WINDOW_WAIT_MS; waited += WINDOW_POLL_MS) {
      for (const window of await windowsOf(pid)) {
        const state = await call("get_browser_state", { pid, window_id: window, session }).then(
          (answer) => answer.body,
          () => ({}) as Record<string, unknown>,
        );
        const target = str(state.target_id);
        const tab = activeTab(state);
        if (target && tab) return { pid, target, tab };
      }
      await sleep(WINDOW_POLL_MS);
    }
    throw new Error(MESSAGE.noWindow);
  };
  const bind = async (): Promise<Bound> => {
    if (bound) return bound;
    const { body: prepared } = await call("browser_prepare", {
      allow_launch: true,
      profile: { mode: "isolated_new" },
      session,
    });
    const pid = prepared.prepared_pid;
    if (typeof pid !== "number") throw new Error(MESSAGE.notStarted);
    bound = await bindWindow(pid);
    return bound;
  };
  /** One call on the bound tab; a browser found gone is let go, and said so. */
  const onTab = async (tool: string, args: Record<string, unknown>) => {
    const b = await bind();
    return call(tool, { target_id: b.target, tab_id: b.tab, session, ...args }).catch((error: unknown) => {
      if (!LOST_BROWSER.has(refusalCode(error))) throw error;
      bound = null;
      throw refusalError(MESSAGE.closed, refusalCode(error));
    });
  };
  /** The page's password inputs, from its DOM refs; read before the snapshot whose refs stay live. */
  const secretsNow = async (): Promise<SecretFields> => {
    const { body: answer } = await onTab("get_browser_state", { snapshot_format: "dom_refs_v1" });
    return secretFields(Array.isArray(answer.refs) ? answer.refs : []);
  };
  return {
    opened: () => bound !== null,
    browser: async () => {
      const b = await bind();
      return (await options.appOf(b.pid)) ?? { name: "Chromium", bundleId: null, pid: b.pid };
    },
    navigate: async (url) => {
      // A browser the person closed is launched again, once.
      await onTab("browser_navigate", { url }).catch((error: unknown) => {
        if (bound !== null || !LOST_BROWSER.has(refusalCode(error))) throw error;
        return onTab("browser_navigate", { url });
      });
      await sleep(SETTLE_MS);
    },
    snapshot: async ({ query, picture }): Promise<WebSnapshot> => {
      const secrets = await secretsNow();
      const { body: answer, image } = await onTab("get_browser_state", {
        snapshot_format: "semantic_v2",
        ...(query ? { query } : {}),
        ...(picture ? { include_screenshot: true } : {}),
      });
      const actionRefs = (Array.isArray(answer.refs) ? answer.refs : []) as CuaRef[];
      const page = (answer.page ?? {}) as Record<string, unknown>;
      const elements = actionRefs.map((row) => elementOf(row, secrets)).filter((e): e is WebElement => e !== null);
      const secretRefs = new Set(elements.filter((e) => e.secret).map((e) => e.ref));
      return {
        title: str(page.title),
        url: str(page.url),
        text: pageText(str(answer.outline), actionRefs, secretRefs),
        elements,
        shot: picture ? image : null,
      };
    },
    click: async (ref, role) => {
      if (FOLLOWED_ROLES.has(role)) {
        await onTab("browser_click", { ref, input_route: "dom_event" });
      } else {
        // A control is pressed as a person would (macOS wants the browser forward for that); one
        // the trusted route cannot reach is pressed through the page.
        await onTab("browser_click", { ref, delivery_mode: "foreground" }).catch((error: unknown) => {
          if (bound === null) throw error;
          return onTab("browser_click", { ref, input_route: "dom_event" });
        });
      }
      await sleep(SETTLE_MS);
    },
    type: async (ref, text, submit) => {
      const keyed = submit ? { text: `${text}\n`, mode: "keystrokes" } : { text, mode: "insert_text" };
      await onTab("browser_type", { ref, replace: true, ...keyed });
      if (submit) await sleep(SETTLE_MS);
    },
  };
}

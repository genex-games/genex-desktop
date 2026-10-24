/**
 * Web pages on the desktop target, guarded by the studio: the driver's separate, clean browser
 * (`substrate/cua-web.ts`) read and driven by element refs, with the same consent as every other app.
 *
 * - The browser is one app: the person allows it once, like any app (`allowApp`). No per-site
 *   consent. The studio's own app and the apps it never drives stay refused.
 * - Only http and https addresses are opened: never a file, a script or data URL.
 * - An element is acted on only by a ref the page itself listed, read again when it is not known.
 *   Each reading renumbers the refs, so a ref from an earlier reading stands for the one element
 *   on the page now with its role and name; with none or several, it is refused.
 * - Nothing is typed into a field that asks for a secret: a password input by the page's DOM, or a
 *   password, PIN or card number by its name.
 *
 * Every refusal is thrown with the sentence the model reads; nothing reaches the browser first.
 */
import type { TargetWeb, TargetWebPage } from "../../substrate/computer-target.ts";
import type { DesktopApp, DesktopWeb, WebElement, WebSnapshot } from "../../substrate/desktop-driver.ts";

/** A field that asks for a secret, by its name: never typed into. */
const SECRET_FIELD =
  /pass(?:word|code|phrase)?\b|passwort|mot de passe|contraseña|пароль|\bpin\b|\bcvv\b|\bcvc\b|card number|security code|one-time code/i;
/** The addresses a page may be opened at. */
const WEB_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:"]);

/** What the model reads when the studio refuses a web verb. */
const MESSAGE = {
  scheme: "only http:// and https:// pages are opened",
  notOpen: "no page is open yet — web_open text=<https:// address> first",
  unknownRef: (ref: string) => `${ref} is not on the page now — web_read the page again and use a ref it lists`,
  secret: (name: string) =>
    `"${name}" asks for a secret (a password, PIN or card number): the studio never types into it — ask the person`,
  declined: (app: string) => `the person did not allow ${app} — ask them in words`,
  neverDriven: (app: string) => `${app} is never driven by an agent`,
} as const;

/** How the guard decides about the browser app. */
export interface WebGuard {
  allowApp: (app: DesktopApp) => Promise<boolean>;
  neverDriven: (app: DesktopApp) => boolean;
}

/** Whether an address is one a page may be opened at. */
export function openableUrl(url: string): boolean {
  try {
    return WEB_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Whether an element asks for a secret. */
export function asksForSecret(element: Pick<WebElement, "name" | "role">): boolean {
  return SECRET_FIELD.test(`${element.role} ${element.name}`);
}

/** The app's name in a sentence. */
function appName(app: DesktopApp): string {
  return app.name || app.bundleId || "the browser";
}

/** The driver's web pages behind the studio's guards, as the target's web verbs. */
export function guardedWeb(site: DesktopWeb, guard: WebGuard): TargetWeb {
  const known = new Map<string, WebElement>();
  /** Every element a reading listed, by its ref then: what an earlier ref stood for. */
  const listed = new Map<string, WebElement>();
  const allowed = async (): Promise<void> => {
    const app = await site.browser();
    if (guard.neverDriven(app)) throw new Error(MESSAGE.neverDriven(appName(app)));
    if (!(await guard.allowApp(app))) throw new Error(MESSAGE.declined(appName(app)));
  };
  const page = (snapshot: WebSnapshot): TargetWebPage => {
    known.clear();
    for (const element of snapshot.elements) {
      known.set(element.ref, element);
      listed.set(element.ref, element);
    }
    return { title: snapshot.title, url: snapshot.url, text: snapshot.text, shot: snapshot.shot };
  };
  const read = async (picture: boolean, query?: string) =>
    page(await site.snapshot({ picture, ...(query ? { query } : {}) }));
  /** The one element on the page now with an earlier element's role and name, if exactly one has them. */
  const sameNow = (before: WebElement | undefined): WebElement | undefined => {
    if (!before) return undefined;
    const matches = [...known.values()].filter((e) => e.role === before.role && e.name === before.name);
    return matches.length === 1 ? matches[0] : undefined;
  };
  /** The element a ref names on the page now, read again when it is not known; refused when none is. */
  const element = async (ref: string): Promise<WebElement> => {
    const current = known.get(ref) ?? sameNow(listed.get(ref));
    if (current) return current;
    await read(false);
    const found = known.get(ref) ?? sameNow(listed.get(ref));
    if (!found) throw new Error(MESSAGE.unknownRef(ref));
    return found;
  };
  const opened = async (): Promise<void> => {
    if (!site.opened()) throw new Error(MESSAGE.notOpen);
    await allowed();
  };
  return {
    open: async (url, { picture }) => {
      if (!openableUrl(url)) throw new Error(MESSAGE.scheme);
      await allowed();
      await site.navigate(url);
      return read(picture);
    },
    read: async ({ query, picture }) => {
      await opened();
      return read(picture, query);
    },
    click: async (ref, { picture }) => {
      await opened();
      const target = await element(ref);
      await site.click(target.ref, target.role);
      return read(picture);
    },
    type: async (ref, text, { submit, picture }) => {
      await opened();
      const field = await element(ref);
      if (field.secret || asksForSecret(field)) throw new Error(MESSAGE.secret(field.name || ref));
      await site.type(field.ref, text, submit);
      return read(picture);
    },
  };
}

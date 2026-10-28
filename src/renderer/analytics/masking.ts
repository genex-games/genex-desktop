/**
 * What a replay may show, and the last pass over everything that leaves.
 *
 * Replays show the app, not the work. Text is visible only on the app's own controls (buttons,
 * tabs, menu items, labels) outside every content region, and never when it looks like a path.
 * A component that shows the person's work — chats, code, files, game and chat names, accounts,
 * agent-written tasks — inside a control marks a wrapper `data-analytics-mask`. Attribute values
 * are kept only where the app itself wrote them and the page needs them to lay out. Pictures,
 * canvases, frames, terminals and the file viewer are blocked; typed input is masked.
 */
import type { CapturedNetworkRequest, CaptureResult } from "posthog-js";
import { currentScreen, SCREEN_ORIGIN, SCREENS, screenUrl } from "./screens.ts";

/** Regions whose text is the person's work. */
export const CONTENT_SELECTOR = [
  "[data-analytics-mask]",
  // A file a chat names, as a chip or a link, wherever it is shown.
  "[data-file-path]",
  "[data-chat-transcript]",
  "[data-user-message]",
  "[data-streaming-reply]",
  // An agent's question and plan: their choices are the agent's words, inside buttons.
  "[data-chat-question]",
  "[data-plan-review]",
].join(", ");
/** The app's own controls, whose labels a replay may show. */
export const CONTROL_SELECTOR = [
  "button",
  '[role="button"]',
  '[role="tab"]',
  '[role^="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  "label",
  "[data-analytics-visible]",
].join(", ");
/** Recorded only as a placeholder of the same size. */
export const BLOCK_SELECTOR = [
  "img",
  "picture",
  "video",
  "audio",
  "canvas",
  "iframe",
  "object",
  "embed",
  "[data-analytics-block]",
  "[data-terminal-dock]",
  "[data-terminal-view]",
  "[data-sign-in-terminal]",
  "[data-file-viewer]",
].join(", ");

/** Attributes that hold words a person reads, shown like text. */
const TEXT_ATTRIBUTES = new Set([
  "title",
  "alt",
  "placeholder",
  "label",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "aria-placeholder",
  "aria-roledescription",
]);
/** Addresses: kept outside content regions (paths rewritten), dropped inside them. */
const URL_ATTRIBUTES = new Set(["href", "src", "srcset", "poster", "action", "xlink:href"]);
/** Attributes the app writes itself and a replay needs to lay the page out; kept outside content regions. */
const LAYOUT_ATTRIBUTES = new Set([
  ...["class", "style", "role", "type", "id", "for", "tabindex", "dir", "lang", "hidden", "disabled", "open", "inert"],
  ...["rel", "media", "charset", "http-equiv", "width", "height", "viewbox", "xmlns", "d", "points", "cx", "cy", "r"],
  ...["rx", "ry", "x", "y", "x1", "x2", "y1", "y2", "fill", "stroke", "stroke-width", "stroke-linecap"],
  ...["stroke-linejoin", "stroke-opacity", "fill-opacity", "opacity", "transform", "pathlength"],
  ...["preserveaspectratio", "colspan", "rowspan", "stop-color", "stop-opacity", "offset", "gradientunits"],
  ...["gradienttransform", "spreadmethod", "fill-rule", "clip-rule", "clip-path", "mask", "stroke-dasharray"],
  ...["stroke-dashoffset", "stroke-miterlimit", "vector-effect", "text-anchor", "dominant-baseline", "font-size"],
  ...["font-weight", "rows", "cols"],
]);
/** ARIA states CSS styles by; inside content regions they keep only their fixed tokens. */
const ARIA_STATES = new Set([
  "aria-expanded",
  "aria-selected",
  "aria-current",
  "aria-checked",
  "aria-pressed",
  "aria-disabled",
  "aria-hidden",
  "aria-busy",
  "aria-invalid",
]);
const ARIA_TOKEN = /^(true|false|mixed|page|step|location|date|time)$/;
/** `data-*` values that style the page (Radix and component state), never the person's words. */
const LAYOUT_DATA = new Set([
  ...["data-state", "data-side", "data-align", "data-orientation", "data-slot", "data-variant", "data-size"],
  ...["data-highlighted", "data-disabled", "data-placeholder", "data-motion", "data-swipe", "data-theme"],
  ...["data-tone", "data-compact", "data-sidebar-open", "data-active", "data-menu-open", "data-room"],
  ...["data-notices", "data-fresh", "data-shimmer", "data-leaving", "data-tile-kind", "data-worker-state"],
  ...["data-tool-state", "data-notice", "data-kind", "data-status", "data-glyph", "data-shown", "data-show"],
  ...["data-scrolling", "data-scrolled", "data-open", "data-level", "data-invalid", "data-direction", "data-at"],
  ...["data-testid", "data-closing", "data-platform", "data-busy", "data-zoom"],
]);
/** A home folder names the person: /Users/<name>, /home/<name>. */
const HOME = /\/(Users|home)\/[^/\s"'\\)<>]+/gi;
/** A Windows home folder, with either slash, doubled when it sits in JSON: C:\Users\<name>. */
const WINDOWS_HOME = /([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"'<>)]+/gi;
/** Any local address: the app itself, its fonts and stylesheets, a file a chat links to. */
const LOCAL_URL = /file:\/\/[^\s"'\\)<>]*/gi;
const LEAK = /file:\/\/|\/(?:Users|home)\/[^/\s"'\\)<>]|[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>)]/i;
/** Text that names a place on disk: ~/…, /Users/…, /Volumes/…, C:\…, file:… (encoded too). */
const PATHLIKE =
  /(?:^|[\s"'(=:])~[\\/]|[\\/](?:Users|home|Volumes|private|var|tmp)[\\/]|(?:^|[\s"'(=])[A-Za-z]:[\\/]|file:|%2F(?:Users|home|Volumes)%2F/i;

const mask = (text: string): string => text.replace(/\S/g, "*");
const inContent = (element: Element | null | undefined): boolean => Boolean(element?.closest(CONTENT_SELECTOR));

/** Words are shown only on a control outside every content region, and never when they name a place on disk. */
export function textVisible(element: Element | null | undefined, text: string): boolean {
  return Boolean(element?.closest(CONTROL_SELECTOR)) && !inContent(element) && !PATHLIKE.test(text);
}

/** Replay text: the words of the app's own controls, every other character a `*`. */
export function maskText(text: string, element?: Element | null): string {
  return textVisible(element, text) ? text : mask(text);
}

/** An attribute the app writes to lay the page out, whose value is the app's own. */
const layoutValue = (key: string, value: string): boolean =>
  LAYOUT_ATTRIBUTES.has(key) || LAYOUT_DATA.has(key) || (ARIA_STATES.has(key) && ARIA_TOKEN.test(value));

/** Replay attributes: readable words follow the text rule, addresses and layout keep their value outside content, the rest is masked. */
export function maskAttribute(name: string, value: string, element?: Element | null): string {
  const key = name.toLowerCase();
  // rrweb's own attributes: inlined stylesheets and recorded sizes.
  if (key === "_csstext" || key.startsWith("rr_")) return scrubPaths(value);
  if (TEXT_ATTRIBUTES.has(key)) return textVisible(element, value) ? value : mask(value);
  if (inContent(element)) {
    if (layoutValue(key, value)) return scrubPaths(value);
    return URL_ATTRIBUTES.has(key) ? "" : mask(value);
  }
  const kept = URL_ATTRIBUTES.has(key) || LAYOUT_ATTRIBUTES.has(key) || LAYOUT_DATA.has(key) || key.startsWith("aria-");
  return kept ? scrubPaths(value) : mask(value);
}

/** The page's own path, which PostHog also sends bare ($session_entry_pathname and the like). */
let pages: string[] | null = null;
function pagePaths(): string[] {
  if (pages) return pages;
  if (typeof location === "undefined" || location.protocol !== "file:") {
    pages = [];
    return pages;
  }
  const encoded = location.pathname;
  let decoded = encoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    /* keep the encoded form */
  }
  pages = decoded === encoded ? [encoded] : [encoded, decoded];
  return pages;
}

/** Local addresses become screens; the page's own path becomes /; a home folder loses its owner's name. */
export function scrubPaths(value: string): string {
  if (!LEAK.test(value) && !pagePaths().some((path) => value.includes(path))) return value;
  let clean = value.replace(LOCAL_URL, (url) => {
    const fragment = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "";
    return SCREEN_ORIGIN + (SCREENS.has(fragment) ? fragment : currentScreen());
  });
  for (const path of pagePaths()) clean = clean.split(path).join("/");
  return clean.replace(HOME, "/$1/user").replace(WINDOWS_HOME, "$1user");
}

/** A replay address as a screen: local ones via scrubPaths, and anything that is still not a web address (an opaque origin) as the current one. */
function replayUrl(url: string): string {
  const clean = scrubPaths(url);
  return /^https?:\/\//i.test(clean) ? clean : screenUrl();
}

/** The replay's page address, and any request it records, as screens — never headers or bodies. */
export function maskRequest(request: CapturedNetworkRequest): CapturedNetworkRequest {
  return {
    ...request,
    name: request.name ? replayUrl(request.name) : request.name,
    requestHeaders: undefined,
    responseHeaders: undefined,
    requestBody: undefined,
    responseBody: undefined,
  };
}

/**
 * The last pass over every event before it leaves: the screen replaces PostHog's URL fields, and
 * any local path left anywhere — a property, a heatmap's URL key, a replay batch — is rewritten.
 */
export function scrubEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  const clean: CaptureResult = { ...event };
  for (const field of ["properties", "$set", "$set_once"] as const) {
    const json = clean[field] === undefined ? undefined : JSON.stringify(clean[field]);
    if (json !== undefined && scrubPaths(json) !== json) clean[field] = JSON.parse(scrubPaths(json));
  }
  if (clean.event !== "$snapshot" && clean.properties) {
    clean.properties.$current_url = screenUrl();
    clean.properties.$host = new URL(SCREEN_ORIGIN).host;
    clean.properties.$pathname = currentScreen();
  }
  return clean;
}

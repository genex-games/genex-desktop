/**
 * The page-side DOM inspector of the developer control. Every function here runs INSIDE the
 * studio window, sent as source by {@link inspectScript}: each may use only DOM globals, its own
 * locals and the other functions listed in {@link PAGE_FUNCTIONS}, never an import or a
 * module-level constant. Selectors and text travel as data, never as source fragments.
 */
import { DevErrorCode } from "./protocol.ts";

/** What the control asks the page: a snapshot of a scope, or the one element a selector names. */
export interface InspectParams {
  selector?: string;
  scope?: string;
  limit?: number;
  snapshot?: boolean;
  focus?: boolean;
  pointY?: number;
  performanceOnly?: boolean;
}

/** The refusals the page reports, handed to it as data because it cannot import them. */
const PAGE_ERRORS = {
  invalidSelector: DevErrorCode.InvalidSelector,
  ambiguousSelector: DevErrorCode.AmbiguousSelector,
  targetNotVisible: DevErrorCode.TargetNotVisible,
};
type PageErrors = typeof PAGE_ERRORS;
type PageError = { error: string };

function isVisible(e: Element): boolean {
  const r = e.getBoundingClientRect();
  const s = getComputedStyle(e);
  const laidOut = r.width > 0 && r.height > 0 && e.getClientRects().length > 0;
  return laidOut && s.visibility !== "hidden" && s.display !== "none";
}

/** Every match of `selector` under `root`, or null when the selector does not parse. */
function queryAll(root: ParentNode, selector: string): Element[] | null {
  try {
    return [...root.querySelectorAll(selector)];
  } catch {
    return null;
  }
}

/** The one visible element among `found`, or why there is not exactly one. */
function onlyVisible(found: Element[], errors: PageErrors): Element | PageError {
  const available = found.filter(isVisible);
  const [only] = available;
  if (available.length === 1 && only) return only;
  return { error: available.length ? errors.ambiguousSelector : errors.targetNotVisible };
}

function inspectDom(p: InspectParams, errors: PageErrors) {
  if (p.performanceOnly) return { performance: window.__studioPerformance ?? null };
  const scopes = p.scope ? queryAll(document, p.scope) : [document.body];
  if (!scopes) return { error: errors.invalidSelector };
  const root = onlyVisible(scopes, errors);
  if ("error" in root) return root;
  if (p.snapshot) return snapshotOf(root, p.limit ?? 150);
  return locate(root, p, errors);
}

/** What the window shows under `root`: state, chat, plan, layout, text, images and controls. */
function snapshotOf(root: Element, limit: number) {
  const TEXT_LIMIT = 24000;
  const all = queryAll(root, 'button,input,textarea,select,[role="button"],[data-thread],[data-graph-node]') ?? [];
  const controls = all.filter(isVisible);
  const text = root.textContent ?? "";
  return {
    performance: window.__studioPerformance ?? null,
    state: datasetOf("[data-studio-state]"),
    stage: datasetOf("[data-stage-view]"),
    chat: chatSummary(root),
    plan: planSummary(root),
    play: playSummary(root),
    chatLayout: chatLayoutOf(root),
    text: text.slice(0, TEXT_LIMIT),
    textTruncated: text.length > TEXT_LIMIT,
    images: imagesOf(root),
    controls: controls.slice(0, limit).map(controlOf),
    omitted: Math.max(0, controls.length - limit),
    style: {
      background: getComputedStyle(document.body).backgroundColor,
      font: getComputedStyle(document.body).fontFamily,
    },
    activeTag: document.activeElement?.tagName,
  };
}

function datasetOf(selector: string): Record<string, string | undefined> {
  return { ...((document.querySelector(selector) as HTMLElement | null)?.dataset ?? {}) };
}

function chatSummary(root: Element) {
  const list = root.querySelector("[data-chat-transcript]") ?? (root.matches("[data-chat-transcript]") ? root : null);
  if (!list) return null;
  const scroll = document.querySelector("[data-chat-scroll]");
  return {
    total: Number((list as HTMLElement).dataset.totalEntries),
    mounted: Number((list as HTMLElement).dataset.mountedEntries),
    toolDetails: list.querySelectorAll("[data-tool-detail]").length,
    toolRows: list.querySelectorAll("[data-tool-state]").length,
    workLogs: list.querySelectorAll("[data-work-log]").length,
    scrollTop: scroll?.scrollTop,
    scrollHeight: scroll?.scrollHeight,
    clientHeight: scroll?.clientHeight,
    overflowX: scroll ? scroll.scrollWidth - scroll.clientWidth : 0,
    streaming: Boolean(document.querySelector("[data-streaming-reply]")),
    firstEntry: list.querySelector("[data-chat-entry]")?.getAttribute("data-chat-entry"),
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}

function planSummary(root: Element) {
  const card = root.querySelector("[data-plan-review]");
  const body = card?.querySelector("[data-plan-body]");
  const footer = card?.querySelector("[data-plan-actions]");
  if (!card || !body || !footer) return null;
  const bounds = card.getBoundingClientRect();
  const actions = footer.getBoundingClientRect();
  return {
    text: body.textContent,
    scrollTop: body.scrollTop,
    scrollHeight: body.scrollHeight,
    clientHeight: body.clientHeight,
    overflowX: card.scrollWidth - card.clientWidth,
    footerTop: actions.top,
    footerBottom: actions.bottom,
    cardTop: bounds.top,
    cardBottom: bounds.bottom,
    inlineCode: [...body.querySelectorAll("code")].map((e) => e.textContent),
  };
}

/** The measured rows of the chat: status and outcome lines, worker and tool rows. */
function chatLayoutOf(root: Element) {
  const rows =
    queryAll(
      root,
      "[data-worker-state] > button,[data-tool-state] > [data-tool-head],[data-chat-status],[data-chat-outcome]",
    ) ?? [];
  return rows.filter(isVisible).slice(0, 40).map(chatRowOf);
}

function chatRowOf(e: Element) {
  const style = getComputedStyle(e);
  const label = e.querySelector("span.text-step,span.flex-1,span.font-medium");
  const r = e.getBoundingClientRect();
  const shimmer = e.querySelector("[data-shimmer]");
  return {
    kind: chatRowKind(e),
    height: r.height,
    paddingInline: style.paddingInlineStart,
    gap: style.columnGap,
    fontSize: label ? getComputedStyle(label).fontSize : style.fontSize,
    fontFamily: style.fontFamily,
    borderRadius: e.parentElement ? getComputedStyle(e.parentElement).borderRadius : null,
    spinnerCount: e.querySelectorAll('.chat-working-indicator,[class*="animate-spin"]').length,
    shimmer: shimmer ? getComputedStyle(shimmer).animationName : null,
  };
}

function chatRowKind(e: Element): string {
  if (e.hasAttribute("data-chat-status")) return "status";
  if (e.hasAttribute("data-chat-outcome")) return "outcome";
  if (e.parentElement?.hasAttribute("data-worker-state")) return "worker";
  return "tool";
}

/**
 * Play's dashboard as the person sees it: its cards, the covers on screen still blank (not loaded,
 * or loaded and not faded in yet), and the clips holding a decoder or playing.
 */
function playSummary(root: Element) {
  const scroll = root.querySelector("[data-play-page] .play-scroll");
  if (!scroll) return null;
  const view = scroll.getBoundingClientRect();
  const cards = [...scroll.querySelectorAll("[data-play-game]")];
  const covers = cards
    .map((card) => card.querySelector(".play-card-cover"))
    .filter((cover): cover is Element => {
      const r = cover?.getBoundingClientRect();
      return Boolean(r && r.bottom > view.top && r.top < view.bottom && r.height > 0);
    });
  const images = covers.map((cover) => cover.querySelector("img"));
  const videos = [...scroll.querySelectorAll("video")];
  return {
    cards: cards.length,
    placeholders: scroll.querySelectorAll(".play-card-placeholder").length,
    inView: covers.length,
    shown: images.filter((img) => img?.hasAttribute("data-shown")).length,
    loading: images.filter((img) => img && !img.complete).length,
    bare: images.filter((img) => !img).length,
    clipsHeld: videos.filter((v) => v.getAttribute("src")).length,
    clipsPlaying: videos.filter((v) => v.getAttribute("src") && !v.paused).length,
    scrollTop: scroll.scrollTop,
    scrollHeight: scroll.scrollHeight,
    clientHeight: scroll.clientHeight,
  };
}

function imagesOf(root: Element) {
  return [...root.querySelectorAll("img")]
    .filter(isVisible)
    .slice(0, 30)
    .map((e) => ({
      alt: e.alt,
      loaded: e.complete && e.naturalWidth > 0,
      width: e.naturalWidth,
      height: e.naturalHeight,
    }));
}

function controlOf(e: Element) {
  const text = e.textContent ?? "";
  return {
    tag: e.tagName,
    label: e.getAttribute("aria-label"),
    expanded: e.getAttribute("aria-expanded"),
    title: e.getAttribute("title"),
    text: e.textContent?.slice(0, 200),
    textTruncated: text.length > 200,
    value: (e as HTMLInputElement).value,
    disabled: (e as HTMLButtonElement).disabled,
    cursor: getComputedStyle(e).cursor,
    childCursor: e.firstElementChild ? getComputedStyle(e.firstElementChild).cursor : null,
    thread: e.getAttribute("data-thread"),
    node: e.getAttribute("data-graph-node"),
  };
}

/** The one enabled, on-screen, unobscured element `p.selector` names: its centre and its value. */
function locate(root: Element, p: InspectParams, errors: PageErrors) {
  const found = queryAll(root, String(p.selector));
  if (!found) return { error: errors.invalidSelector };
  const target = onlyVisible(found, errors);
  if ("error" in target) return target;
  const e = target as HTMLElement;
  const disabled = (e as HTMLButtonElement).disabled || e.getAttribute("aria-disabled") === "true";
  if (disabled) return { error: errors.targetNotVisible };
  const r = e.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height * (p.pointY ?? 0.5);
  if (!hitsAt(e, x, y)) return { error: errors.targetNotVisible };
  if (p.focus) e.focus({ preventScroll: true });
  return {
    x,
    y,
    tag: e.tagName,
    options:
      e.tagName === "SELECT"
        ? [...(e as HTMLSelectElement).options].map((o) => ({ value: o.value, disabled: o.disabled }))
        : undefined,
    index: (e as HTMLSelectElement).selectedIndex,
    value: (e as HTMLSelectElement).value,
  };
}

/** Is (x, y) inside the viewport and on `e` itself — not on something drawn over it? */
function hitsAt(e: Element, x: number, y: number): boolean {
  const inViewport = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
  if (!inViewport) return false;
  const hit = document.elementFromPoint(x, y);
  return hit !== null && (e === hit || e.contains(hit));
}

/** Every function the page needs, as source; the entry point is {@link inspectDom}. */
const PAGE_FUNCTIONS = [
  isVisible,
  queryAll,
  onlyVisible,
  inspectDom,
  snapshotOf,
  datasetOf,
  chatSummary,
  planSummary,
  chatLayoutOf,
  chatRowOf,
  chatRowKind,
  playSummary,
  imagesOf,
  controlOf,
  locate,
  hitsAt,
]
  .map((fn) => fn.toString())
  .join("\n");

/** The expression that inspects the page with `params` and evaluates to what it found. */
export function inspectScript(params: InspectParams): string {
  return `(() => {\n${PAGE_FUNCTIONS}\nreturn ${inspectDom.name}(${JSON.stringify(params)}, ${JSON.stringify(PAGE_ERRORS)});\n})()`;
}

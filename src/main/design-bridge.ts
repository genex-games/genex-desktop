/**
 * What Genex puts on every design page it serves: a few default styles the page's own styles come
 * after, and the bridge, the one script a page runs. The bridge tells the Design tab the page's
 * title and size, hands it the wheel and drags (the wall zooms and pans; a page never scrolls) and
 * says when the person pressed a link. It asks the tab for nothing and reads nothing of the game.
 * Both are text served inside the page, so plain strings.
 */
import { DESIGN_MESSAGE_SOURCE, DesignSignal, DesignTheme } from "../shared/design-board.ts";

/**
 * What made something on a page a button, before buttons left the board: a press put its words in
 * the chat, which the canvas now does itself (the person's notes and picks). A page written then
 * still carries them; they are not shown, so nothing on a page looks pressable and does nothing.
 */
const RETIRED_BUTTONS = "[data-say]";

/** How far a pointer travels on a page before it is a drag of the wall, as on the wall itself (`DRAG_DEAD_ZONE`). */
const DRAG_DEAD_ZONE = 3;

/** Where a page's frame gets Genex's own typefaces: a reserved folder of the board's scheme, never the game's. */
export const DESIGN_FONTS_PATH = "/~genex/fonts/";

/** Genex's typefaces a page may use, by the file each is served from (`renderer/fonts/`). */
export const DESIGN_FONTS = {
  "Zalando Sans SemiExpanded": "ZalandoSansSemiExpanded-variable.woff2",
  "Geist Mono": "GeistMono-variable.woff2",
} as const;

/** Genex's colours as a page reads them (`var(--genex-ink)`), in each look: the app's own card, ink and accent. */
const PAGE_COLOURS: Readonly<Record<DesignTheme, Readonly<Record<string, string>>>> = {
  [DesignTheme.Dark]: {
    bg: "#141416",
    inset: "#1b1c1d",
    ink: "#dee0e2",
    "ink-2": "#c4c6c9",
    "ink-3": "#a8a9ac",
    line: "#29292b",
    accent: "#3c44c4",
    "accent-ink": "#9aa2ff",
  },
  [DesignTheme.Light]: {
    bg: "#fdfdfd",
    inset: "#ececee",
    ink: "#17181a",
    "ink-2": "#3b3d41",
    "ink-3": "#5f6368",
    line: "#e3e4e6",
    accent: "#3f61f5",
    "accent-ink": "#3f61f5",
  },
};

const FONT_FACES = Object.entries(DESIGN_FONTS)
  .map(
    ([family, file]) =>
      `@font-face{font-family:"${family}";src:url("${DESIGN_FONTS_PATH}${file}") format("woff2");font-weight:100 900;font-display:swap}`,
  )
  .join("");

/**
 * A page's defaults, in the app's look: Genex's card and ink, its two typefaces, its colours as
 * variables a page builds with, pictures that fit, and a pointer over what can be pressed.
 * Everything is at zero specificity or on `html`, so the page's own styles win.
 */
export function designPageStyle(theme: DesignTheme): string {
  const colours = Object.entries(PAGE_COLOURS[theme])
    .map(([name, value]) => `--genex-${name}:${value}`)
    .join(";");
  return [
    FONT_FACES,
    `:root{color-scheme:${theme};${colours};--genex-radius:12px;--genex-mono:"Geist Mono",ui-monospace,monospace}`,
    'html{background:var(--genex-bg);color:var(--genex-ink);font:15px/1.5 "Zalando Sans SemiExpanded",system-ui,sans-serif;',
    "-webkit-user-select:none;user-select:none}",
    ":where(img,video){max-width:100%;border-radius:var(--genex-radius)}",
    ":where(img){-webkit-user-drag:none}",
    ":where(a){color:var(--genex-accent-ink)}",
    ":where(a[href]){cursor:pointer}",
    `${RETIRED_BUTTONS}{display:none !important}`,
  ].join("");
}

/** The bridge. It must never hold the text that ends a script element. */
export const DESIGN_BRIDGE = `(() => {
  const post = (message) => parent.postMessage({ source: ${JSON.stringify(DESIGN_MESSAGE_SOURCE)}, ...message }, "*");
  const root = document.documentElement;
  let reported = "";
  const report = () => {
    // A frame with no size yet lays its page out in no room, every word on its own line: what the
    // page holds is read once the frame has one (the resize that gives it one reports).
    if (!window.innerWidth || !window.innerHeight) return;
    const body = document.body;
    const width = Math.max(root.scrollWidth, body ? body.scrollWidth : 0);
    const height = Math.max(root.scrollHeight, body ? body.scrollHeight : 0);
    const key = document.title + "|" + width + "|" + height;
    if (key === reported) return;
    reported = key;
    post({ type: ${JSON.stringify(DesignSignal.Page)}, title: document.title, width, height });
  };
  const watch = () => {
    report();
    if (typeof ResizeObserver !== "function") return;
    const sizes = new ResizeObserver(report);
    sizes.observe(root);
    if (document.body) sizes.observe(document.body);
  };
  document.addEventListener("DOMContentLoaded", watch);
  window.addEventListener("load", report);
  document.addEventListener("load", report, true);

  window.addEventListener("wheel", (event) => {
    event.preventDefault();
    post({ type: ${JSON.stringify(DesignSignal.Wheel)}, dy: event.deltaY, x: event.clientX, y: event.clientY, pinch: event.ctrlKey || event.metaKey });
  }, { passive: false });

  const pressable = "a[href],button,input,select,textarea,summary,label,video,audio";
  let drag = null;
  let dragged = false;
  document.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (event.button !== 0 || !target || target.closest(pressable)) return;
    drag = { x: event.screenX, y: event.screenY, moved: false };
  }, true);
  document.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.screenX - drag.x;
    const dy = event.screenY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < ${DRAG_DEAD_ZONE}) return;
    if (!drag.moved) {
      drag.moved = true;
      try { root.setPointerCapture(event.pointerId); } catch {}
    }
    drag.x = event.screenX;
    drag.y = event.screenY;
    post({ type: ${JSON.stringify(DesignSignal.Drag)}, dx, dy, end: false });
  }, true);
  const drop = () => {
    if (!drag) return;
    if (drag.moved) {
      dragged = true;
      setTimeout(() => { dragged = false; }, 0);
      post({ type: ${JSON.stringify(DesignSignal.Drag)}, dx: 0, dy: 0, end: true });
    }
    drag = null;
  };
  document.addEventListener("pointerup", drop, true);
  document.addEventListener("pointercancel", drop, true);

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (dragged) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const anchor = target.closest("a[href]");
    if (!anchor) return;
    event.preventDefault();
    let url;
    try { url = new URL(anchor.getAttribute("href") || "", location.href); } catch { return; }
    if (url.protocol !== location.protocol || url.host !== location.host) {
      post({ type: ${JSON.stringify(DesignSignal.Link)}, url: url.href });
      return;
    }
    if (url.pathname === location.pathname) return;
    let file = "";
    try { file = decodeURIComponent(url.pathname.slice(1)); } catch {}
    post({ type: ${JSON.stringify(DesignSignal.Open)}, file });
  }, true);
})();`;

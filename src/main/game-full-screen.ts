/**
 * The Live game's full screen: the window goes full screen and the game view covers all of it,
 * with the studio's own small exit button over its top-right corner. The button says how to leave
 * for a moment, then folds to its icon and fades back. Holding Esc ends it (a tap still reaches
 * the game: pause menus, mouse lock), as do the button and the window leaving full screen any
 * other way. Electron-free: the window, the game view, the button and the clock come in as deps.
 */
import { SECOND_MS } from "../shared/duration.ts";
import { t } from "../shared/i18n.ts";

/** How long Esc is held before full screen ends; a shorter press is the game's. */
export const ESC_HOLD_MS = 0.8 * SECOND_MS;
/** How long the exit button shows its words before it folds to its icon. */
export const EXIT_UNFOLDED_MS = 2.6 * SECOND_MS;
/** The fold itself, drawn by the button's page. */
export const EXIT_FOLD_MS = 0.42 * SECOND_MS;
/** When the folded button's view shrinks to the icon: after its page has folded it. */
export const EXIT_FOLDED_AFTER_MS = EXIT_UNFOLDED_MS + EXIT_FOLD_MS;
/** The exit button's view: inset from the window's top-right corner, its height, and its unfolded width. */
export const EXIT_BUTTON = { margin: 14, height: 38, wide: 292 } as const;

/** A rectangle in window content coordinates. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Everything full screen moves. */
export interface FullScreenDeps {
  window: {
    isFullScreen(): boolean;
    setFullScreen(on: boolean): void;
    contentSize(): { width: number; height: number };
  };
  /** The Live game's view: `fill` covers a rectangle whatever the stage measures, null gives it back. */
  game: { fill(bounds: Rect | null): void; focus(): void };
  exitButton: { show(bounds: Rect): void; hide(): void };
  /** The stage: shown while full screen covers it, then placed again from what the page last measured. */
  stage: { cover(): void; restore(): void };
  clock: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}

/** The part of Electron's `before-input-event` input the held Esc reads. */
export interface FullScreenKey {
  type: string;
  key: string;
  isAutoRepeat: boolean;
}

/** The exit button's view at the window's top-right corner, unfolded or folded to its icon. */
function exitBounds(window: { width: number }, folded: boolean): Rect {
  const width = folded ? EXIT_BUTTON.height : EXIT_BUTTON.wide;
  return { x: window.width - EXIT_BUTTON.margin - width, y: EXIT_BUTTON.margin, width, height: EXIT_BUTTON.height };
}

/** The game's full screen over `deps`; `key` takes every key the game (or its exit button) receives. */
export function gameFullScreen(deps: FullScreenDeps) {
  const { window, game, exitButton, stage, clock } = deps;
  let on = false;
  let folded = false;
  /** Whether this full screen put the window into full screen, so leaving it takes the window out. */
  let tookWindow = false;
  let foldTimer: unknown = null;
  let escTimer: unknown = null;

  const clear = (timer: unknown): null => {
    if (timer !== null) clock.clearTimeout(timer);
    return null;
  };
  const layout = (): void => {
    const size = window.contentSize();
    game.fill({ x: 0, y: 0, width: size.width, height: size.height });
    exitButton.show(exitBounds(size, folded));
  };
  const exit = (): void => {
    if (!on) return;
    on = false;
    foldTimer = clear(foldTimer);
    escTimer = clear(escTimer);
    exitButton.hide();
    game.fill(null);
    stage.restore();
    if (tookWindow && window.isFullScreen()) window.setFullScreen(false);
    tookWindow = false;
  };
  const enter = (): void => {
    if (on) return;
    on = true;
    folded = false;
    tookWindow = !window.isFullScreen();
    if (tookWindow) window.setFullScreen(true);
    stage.cover();
    layout();
    game.focus();
    foldTimer = clock.setTimeout(() => {
      foldTimer = null;
      folded = true;
      if (on) layout();
    }, EXIT_FOLDED_AFTER_MS);
  };
  const key = (input: FullScreenKey): void => {
    if (!on || input.key !== "Escape") return;
    if (input.type === "keyUp") escTimer = clear(escTimer);
    if (input.type !== "keyDown" || input.isAutoRepeat || escTimer !== null) return;
    escTimer = clock.setTimeout(() => {
      escTimer = null;
      exit();
    }, ESC_HOLD_MS);
  };
  return {
    active: (): boolean => on,
    enter,
    exit,
    /** The window changed size: the game and its button follow. */
    resized: (): void => {
      if (on) layout();
    },
    /** The window left full screen by itself (its green button, the View menu): the game's ends too. */
    windowLeft: (): void => {
      tookWindow = false;
      exit();
    },
    key,
  };
}

/** The game's full screen as `gameFullScreen` makes it. */
export type GameFullScreen = ReturnType<typeof gameFullScreen>;

/** The key the exit button names: a key's own name, the same in every language. */
const EXIT_KEY = "esc";
/** Stands in for the key while the sentence around it is escaped; no translation holds it. */
const KEY_SLOT = "\u0000";

/** Text for the button's page: `&`, `<`, `>` and `"` written as entities. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The words on the exit button, in the app's language, as HTML: the hint around the key, and the
 * button's accessible name, which it keeps when folded.
 */
function exitWords(): { hint: string; button: string } {
  const hint = escapeHtml(t("Hold {key} to exit full screen", { key: KEY_SLOT }));
  return { hint: hint.replace(KEY_SLOT, `<kbd>${EXIT_KEY}</kbd>`), button: escapeHtml(t("Exit full screen")) };
}

/** Where the button's page asks to end full screen: a `window.open` the view refuses and reports. */
export const EXIT_FULL_SCREEN_URL = "about:blank#exit-full-screen";

/**
 * The exit button's own page, drawn by the studio over any game: a dark glass pill whose words
 * fold into the icon after `EXIT_UNFOLDED_MS`, leaving it at half strength until the pointer is on it.
 */
export function exitButtonPage(): string {
  const unfolded = `${EXIT_UNFOLDED_MS}ms`;
  const fold = `${EXIT_FOLD_MS}ms`;
  const words = exitWords();
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden}
body{display:flex;justify-content:flex-end;align-items:center;font:13px/20px ui-sans-serif,system-ui,-apple-system,sans-serif;color:#fff;-webkit-user-select:none;user-select:none}
.pill{display:flex;align-items:center;height:${EXIT_BUTTON.height}px;box-sizing:border-box;padding:4px;border-radius:12px;background:rgba(16,17,18,.72);backdrop-filter:blur(12px);animation:fade ${fold} cubic-bezier(.22,1,.36,1) ${unfolded} forwards}
.pill:hover,.pill:focus-within{opacity:1!important}
.words{display:flex;align-items:center;gap:6px;overflow:hidden;white-space:nowrap;max-width:240px;padding:0 12px 0 10px;animation:fold ${fold} cubic-bezier(.22,1,.36,1) ${unfolded} forwards}
kbd{font:12px/18px ui-monospace,"SF Mono",Menlo,monospace;padding:0 6px;border-radius:6px;background:rgba(255,255,255,.14)}
button{all:unset;display:grid;place-items:center;flex:none;width:30px;height:30px;border-radius:9px;background:rgba(255,255,255,.08);cursor:pointer}
button:hover,button:focus-visible{background:rgba(255,255,255,.16)}
@keyframes fold{to{max-width:0;padding:0;opacity:0}}
@keyframes fade{to{opacity:.45}}
@media (prefers-reduced-motion:reduce){.pill,.words{animation-duration:1ms}}
</style></head><body><div class="pill"><span class="words" aria-hidden="true">${words.hint}</span><button type="button" aria-label="${words.button}" onclick="window.open('${EXIT_FULL_SCREEN_URL}')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v2.5A2.5 2.5 0 0 1 6.5 9H4M20 9h-2.5A2.5 2.5 0 0 1 15 6.5V4M15 20v-2.5a2.5 2.5 0 0 1 2.5-2.5H20M4 15h2.5A2.5 2.5 0 0 1 9 17.5V20"/></svg></button></div></body></html>`;
}

/**
 * The app's keyboard: Cmd/Ctrl+K search, +B sidebar, +N new game, +1 the last game, +2 Studio, +I the
 * game's composer, ⌥↑/↓ through the rail, Escape closes the compact drawer. A sheet, dialog or
 * menu that is asking a question owns the keyboard: a second folder dialog opened behind it, or
 * the room changing underneath it, is the app talking over itself.
 */
import { useEffect, useRef } from "react";

export interface AppShortcuts {
  /** Something modal is up that is not in the DOM's dialog roles (the open-folder sheet). */
  blocked: boolean;
  search(): void;
  toggleSidebar(): void;
  /** Escape in a compact window with the drawer open; returns false when it had nothing to close. */
  closeDrawer(): boolean;
  newGame(): void;
  returnToGame(): void;
  enterStudio(): void;
  focusComposer(): void;
  /** Alt-↑/↓: the conversation `step` places away along the rail. */
  stepRail(step: 1 | -1): void;
}

/** A dialog, menu or popover owns the keyboard while it is open. */
const MODAL_OPEN = '[role="dialog"], [role="menu"], [data-slot="popover-content"]';

/** The action a key asks for: a ⌘ (or Ctrl) shortcut, or ⌥↑/↓ along the rail; undefined for anything else. */
function shortcutAction(event: KeyboardEvent, on: AppShortcuts): (() => void) | undefined {
  const withMeta: Record<string, () => void> = {
    k: on.search,
    b: on.toggleSidebar,
    n: on.newGame,
    "1": on.returnToGame,
    "2": on.enterStudio,
    i: () => {
      on.returnToGame();
      requestAnimationFrame(on.focusComposer);
    },
  };
  const logicalKey = event.key.toLowerCase();
  const nonLatinLetter = /^\p{Letter}$/u.test(logicalKey) && !/^[a-z]$/.test(logicalKey);
  const numberRow = /^Digit[12]$/.test(event.code);
  // Physical fallback supports non-Latin letters and number-row symbols without taking Ctrl+C
  // away from a Latin layout whose C happens to occupy the physical I key.
  const physicalKey = nonLatinLetter || numberRow ? event.code.replace(/^(Key|Digit)/, "").toLowerCase() : logicalKey;
  const key = Object.hasOwn(withMeta, logicalKey) ? logicalKey : physicalKey;
  const command = event.metaKey || event.ctrlKey;
  if (command) {
    if (event.altKey || event.shiftKey || event.repeat) return undefined;
    return Object.hasOwn(withMeta, key) ? withMeta[key] : undefined;
  }
  const railKey = event.key === "ArrowUp" || event.key === "ArrowDown";
  if (!event.altKey || event.shiftKey || !railKey) return undefined;
  return () => on.stepRail(event.key === "ArrowDown" ? 1 : -1);
}

/** One key on the window: Escape closes the drawer; a shortcut runs, unless something modal is up. */
function handleShortcut(event: KeyboardEvent, on: AppShortcuts): void {
  if (event.defaultPrevented || event.isComposing) return;
  if (on.blocked || document.querySelector(MODAL_OPEN)) return;
  if (event.key === "Escape") {
    if (on.closeDrawer()) event.preventDefault();
    return;
  }
  const action = shortcutAction(event, on);
  if (!action) return;
  event.preventDefault();
  action();
}

export function useAppShortcuts(shortcuts: AppShortcuts): void {
  const current = useRef(shortcuts);
  current.current = shortcuts;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => handleShortcut(event, current.current);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

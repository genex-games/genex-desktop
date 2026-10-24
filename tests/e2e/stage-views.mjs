/**
 * Pressing a stage view through the developer control, whether the strip shows its views as tabs
 * or has folded them into one button (`panels/stage/strip-fold.ts`): a folded view is a row of the
 * button's menu, which keeps the tab's `data-stage-action`. The smoke runners' twin is
 * `src/main/smoke/stage-views.ts`.
 */
import { setTimeout as pause } from "node:timers/promises";

/** How often, and how far apart, the menu's row is tried while the menu opens. */
const MENU_TRIES = 30;
const MENU_PAUSE_MS = 100;

/**
 * Press the view `key` with `click(selector)` (the runner's developer-control click): its tab, or
 * the folded views' button and then the view's menu row. Throws the tab's error when neither is there.
 */
export async function pressStageView(click, key) {
  try {
    await click(`[data-stage-strip] [role="tab"][data-stage-action="${key}"]`);
    return;
  } catch (tabError) {
    try {
      await click("[data-stage-views]");
    } catch {
      throw tabError;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await click(`[role="menuitemradio"][data-stage-action="${key}"]`);
        return;
      } catch (rowError) {
        if (attempt >= MENU_TRIES) throw rowError;
        await pause(MENU_PAUSE_MS);
      }
    }
  }
}

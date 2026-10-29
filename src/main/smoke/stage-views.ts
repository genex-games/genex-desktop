/**
 * The stage's views for the smoke runners, as tabs or folded into one button. A narrow strip folds
 * its views (`panels/stage/strip-fold.ts`): the button lists every view in `data-stage-views` and
 * names the current one in `data-stage-current`, and a view is pressed through its menu row, which
 * keeps the tab's `data-stage-action`.
 */
import type { WebContents } from "electron";
import { SECOND_MS } from "../../shared/duration.ts";
import { waitFor } from "./wait.ts";

/** How long the folded views' menu may take to open. */
const MENU_WAIT_MS = 5 * SECOND_MS;
const MENU_POLL_MS = 50;

/** The tab of the view `key`, while the strip shows its views as tabs. */
const tab = (key: string): string =>
  `document.querySelector('[data-stage-strip] [role="tab"][data-stage-action="${key}"]')`;

/** The folded views' menu row of the view `key`, while the menu is open. */
const menuRow = (key: string): string => `document.querySelector('[role="menuitemradio"][data-stage-action="${key}"]')`;

/** An expression: does the stage offer the view `key`, as a tab or in the folded views' button? */
export const stageOffers = (key: string): string =>
  `(!!${tab(key)} || !!document.querySelector('[data-stage-views~="${key}"]'))`;

/** An expression: is `key` the view the strip draws as current? */
export const stageCurrent = (key: string): string =>
  `(${tab(key)}?.getAttribute('aria-selected') === 'true' || document.querySelector('[data-stage-views]')?.dataset.stageCurrent === '${key}')`;

/** Press the view `key`: its tab, or the folded views' button and then its row. False when neither is there. */
export async function pressStageView(wc: Pick<WebContents, "executeJavaScript">, key: string): Promise<boolean> {
  if (await wc.executeJavaScript(`(() => { const tab = ${tab(key)}; tab?.click(); return !!tab; })()`)) return true;
  // Radix opens the menu on the pointer going down, not on a click.
  await wc.executeJavaScript(
    `document.querySelector('[data-stage-views]')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))`,
  );
  const open = await waitFor(() => wc.executeJavaScript(`!!${menuRow(key)}`), {
    timeoutMs: MENU_WAIT_MS,
    intervalMs: MENU_POLL_MS,
  });
  if (!open) return false;
  await wc.executeJavaScript(`${menuRow(key)}.click()`);
  return true;
}

/**
 * Taking one of the Play viewer's views out of the studio window (`viewer-view.ts`), and closing the
 * viewer with the window. Its page closes first, whatever state the window is in: Electron marks a
 * closing window destroyed before `closed`, and a page left open keeps the game's sound, timers and
 * microphone going. Electron-free: the window and the view come in by the little of them this needs.
 */

/** A view's page, as closing it needs. */
export interface ClosablePage {
  isDestroyed(): boolean;
  close(): void;
}

/** The window a view leaves, as taking it out needs. */
export interface ViewWindow<V> {
  isDestroyed(): boolean;
  contentView: { removeChildView(view: V): void };
  webContents: { focus(): void };
}

/** A view with a page, as taking it out needs. */
export interface PagedView {
  webContents: ClosablePage;
}

/** The studio window's events, as the viewer's going with it needs. */
export interface ClosingWindow {
  on(event: string, listener: () => void): unknown;
}

/**
 * Close the viewer when the person closes the studio window, whether it goes or a run keeps it
 * hidden (`close`), or when it is destroyed without being asked (`closed`): no sound, no timers on a
 * window that is gone. Never on `hide`: macOS sends it whenever another window covers the studio's,
 * another desktop is shown or the window is minimized, and the game is still there to come back to.
 */
export function closeWithWindow(win: ClosingWindow, close: () => void): void {
  win.on("close", close);
  win.on("closed", close);
}

/** Close a view's page unless it is gone already. */
export function closePage(page: ClosablePage | null | undefined): void {
  if (page && !page.isDestroyed()) page.close();
}

/**
 * Take a game's view out of `win`: its page closes, then, while the window lives, the view leaves it
 * and the keyboard comes back to the app's own page (the game, or the bar before the game was up,
 * took it).
 */
export function dropGameView<V extends PagedView>(win: ViewWindow<V>, view: V | null): void {
  closePage(view?.webContents);
  if (win.isDestroyed()) return;
  if (view) win.contentView.removeChildView(view);
  win.webContents.focus();
}

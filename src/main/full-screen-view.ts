/**
 * The game's full screen in the studio window (`game-full-screen.ts`): the window, Live's view and
 * the exit button, a small transparent view of the studio's own above the game. Nothing is put
 * into the game's page; the button's page has no preload and reaches main only through the one
 * `window.open` it is allowed, which is refused and read as "exit".
 */
import { type BrowserWindow, WebContentsView } from "electron";
import { EXIT_FULL_SCREEN_URL, exitButtonPage, gameFullScreen, type GameFullScreen } from "./game-full-screen.ts";
import type { PreviewBoundsRecord } from "./ipc/preview.ts";
import type { GamePreview } from "./preview.ts";
import type { StudioCore } from "./studio-core.ts";

/**
 * The exit button's page, made and loaded again each time it is shown, so its words unfold again
 * and are in the language the app is in then.
 */
function exitPageUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(exitButtonPage())}`;
}
/** A fully transparent view background: only the pill is drawn. */
const TRANSPARENT = "#00000000";

/** Build the full screen for `win` over Live's `view`; the slot comes back from what the page last measured. */
export function wireGameFullScreen({
  studio,
  win,
  view,
  boundsSeen,
}: {
  studio: StudioCore;
  win: BrowserWindow;
  view: GamePreview;
  boundsSeen: PreviewBoundsRecord;
}): GameFullScreen {
  const exitView = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  exitView.setBackgroundColor(TRANSPARENT);
  exitView.setVisible(false);
  // Added after the game's view, so it is drawn over it.
  win.contentView.addChildView(exitView);
  let shown = false;

  const screen = gameFullScreen({
    window: {
      isFullScreen: () => win.isFullScreen(),
      setFullScreen: (on) => win.setFullScreen(on),
      contentSize: () => {
        const [width = 0, height = 0] = win.getContentSize();
        return { width, height };
      },
    },
    game: {
      fill: (bounds) => view.fill(bounds),
      focus: () => view.view?.webContents.focus(),
    },
    exitButton: {
      show: (bounds) => {
        exitView.setBounds(bounds);
        if (shown) return;
        shown = true;
        void exitView.webContents.loadURL(exitPageUrl()).catch(() => {});
        exitView.setVisible(true);
      },
      hide: () => {
        shown = false;
        exitView.setVisible(false);
      },
    },
    stage: {
      cover: () => void studio.previewStageVisible(true, true),
      restore: () => {
        const last = boundsSeen.last;
        if (!last) return;
        void studio.previewStageVisible(last.width > 0 && last.height > 0, true);
        view.setBounds({
          x: Math.round(last.x),
          y: Math.round(last.y),
          width: Math.round(last.width),
          height: Math.round(last.height),
        });
      },
    },
    clock: { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (handle) => clearTimeout(handle as never) },
  });

  const exits = exitView.webContents;
  exits.setWindowOpenHandler(({ url }) => {
    if (url === EXIT_FULL_SCREEN_URL) screen.exit();
    return { action: "deny" };
  });
  exits.on("will-navigate", (event) => event.preventDefault());
  exits.on("before-input-event", (_event, input) => screen.key(input));
  view.view?.webContents.on("before-input-event", (_event, input) => screen.key(input));
  win.on("resize", () => screen.resized());
  win.on("leave-full-screen", () => screen.windowLeft());
  return screen;
}

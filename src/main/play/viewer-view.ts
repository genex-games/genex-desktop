/**
 * The Play viewer's views in the studio window (`viewer.ts` decides what they do): a fresh sandboxed
 * view per game in Play's own session, below the bar's strip (across the whole window while its page
 * is full screen), and above it the bar's layer, a transparent view of the studio's own page
 * (`renderer/play-bar.html`) made once and kept. The game's
 * page may move between Genex games' addresses and Genex's sign-in hop; any other link opens in the
 * browser, except a coin purchase the game asks for, which the viewer shows as its own sheet
 * (`purchase-window.ts`). Play's session grants only mouse lock, full screen and clipboard writes, and
 * the microphone to a game's own page just after the viewer told it to open it (the bar's mic switch,
 * `mic.ts`); a purchase's hidden popup gets nothing. Its one preload (`preload/play-mic.ts`) gives the
 * page the app's microphone and carries the mic's word between the page and main; the menu of
 * microphones is a native one.
 */
import {
  type BrowserWindow,
  clipboard,
  Menu,
  type MenuItemConstructorOptions,
  type Session,
  session,
  shell,
  systemPreferences,
  type WebContents,
  WebContentsView,
  webContents,
} from "electron";
import { StudioPlatform } from "../../shared/boot.ts";
import type { PlayOrigins, PlayPoint, PlayViewerEvent } from "../../shared/play.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { type PlayMicCommand, PlayMicChannel, type PlayMicReport, readMicReport } from "../../shared/play-mic.ts";
import type { FullScreenKey, Rect } from "../game-full-screen.ts";
import { GAME_DISABLED_BLINK_FEATURES } from "../game-view.ts";
import { createReloadPolicy, ReloadDecision } from "../app-lifecycle.ts";
import { pushToRenderer } from "../ipc-handle.ts";
import type { PlayComments } from "./comments.ts";
import type { SheetInput, ViewerCoin } from "./viewer-purchase.ts";
import type { CertificateRequest, CertificateVerdict } from "./dev-games-trust.ts";
import { linkGate, playAddress, playNavigationAllowed } from "./game-address.ts";
import type { PlayGallery } from "./gallery.ts";
import { playPermissionShown, playPermitted } from "./game-permissions.ts";
import { type MicGate, micGate, micGateFor } from "./mic.ts";
import { closePage, closeWithWindow, dropGameView } from "./view-drop.ts";
import { isPurchaseWindow, wirePurchaseCapture } from "./purchase-window.ts";
import type { PlayMicStore } from "./mic-store.ts";
import { playViewer, type PlayViewer, type PlayViewerDeps } from "./viewer.ts";
import { t } from "../../shared/i18n.ts";

/** Each studio window's Play views, for the development control (`dev/runtime.ts`). */
const viewsOf = new WeakMap<BrowserWindow, PlayViews>();
/** Sessions already given Play's rules: a window made again shares the session and its handlers. */
const prepared = new WeakSet<Session>();
/** Each game view's microphone gate: the session's handlers find a view's by its contents. */
const micGates = new WeakMap<WebContents, MicGate>();
/** Play's own storage: games keep their saves across launches, apart from the studio's. */
export const PLAY_PARTITION = "persist:genex-play";
/** What a game's page shows before it paints. */
const GAME_BACKGROUND = "#000000";
/** The bar's layer is see-through: only the bar (and Comments over the dimmed game) is drawn. */
const TRANSPARENT = "#00000000";
/** A navigation the browser itself aborted (a new one replaced it): not a failure. */
const ERR_ABORTED = -3;
/** Node's timers, for the viewer and for catching a purchase's popup. */
const TIMERS = {
  setTimeout: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
/** Keyboard input as Electron's `input-event` names it: the bar's keys are heard before they land instead. */
const KEY_INPUTS: ReadonlySet<string> = new Set(["rawKeyDown", "keyDown", "keyUp", "char"]);
/** HTTP answers that mean the game is not there to play. */
const GONE_STATUS = 404;
const SERVER_ERROR = 500;
/**
 * The Genex embed SDK's own guest popover on a game's page ("Playing as Guest … Sign in"). Its Sign in
 * goes to the website, which cannot sign the app in; the viewer's own guest card offers the Genex
 * plugin instead. A user-origin rule, so not even the popover's inline `!important` styles win.
 */
const HIDE_GUEST_POPOVER = "[data-genex-guest-popover]{display:none !important}";
/**
 * The browser's own focus ring on a game's canvas once the game takes the keyboard (a canvas focused by
 * script matches :focus-visible): a line along the game's edges that tells the player nothing, since the
 * game is all the view shows. Keys still reach the game; only the canvas's outline goes, and every other
 * focus ring on the page stays. User-origin, so no page rule brings it back.
 */
const HIDE_GAME_FOCUS_RING = "canvas:focus{outline:none !important}";
/**
 * The bar's Full screen, as the game's own: its page asks for full screen as if the player had pressed
 * a button in it, so Esc and the bar's return take the same path as a game's own full screen.
 */
const REQUEST_FULL_SCREEN = "document.documentElement.requestFullscreen().catch(() => undefined)";
/** Where each system keeps its microphone privacy switch for apps. */
const MIC_SETTINGS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  win32: "ms-settings:privacy-microphone",
};
/** The mic menu's words. */
const MESSAGE = {
  micMenu: () => t("Microphone"),
  systemDefault: () => t("System default"),
  noNames: () => t("Your microphones are listed once the mic is on"),
} as const;

/** The studio window and what the viewer reaches through it. */
export interface PlayViewDeps {
  win: BrowserWindow;
  gallery: PlayGallery;
  emit(event: PlayViewerEvent): void;
  /** A link the game asked for that is not its own: to the browser. */
  openExternal(url: string): void;
  /** The website Play links to: Share and Invite copy the game's page there. */
  web: string;
  /** Where games are served and the website their pages hop to: genex.games', or a development stand's. */
  origins: Pick<PlayOrigins, "web" | "games">;
  /**
   * A development stand's own CA, trusted for its game hosts only (`dev-games-trust.ts`); absent in
   * every other launch, where Chromium alone judges certificates.
   */
  certificates?: (request: CertificateRequest) => CertificateVerdict;
  /** Fixture launches: a local stand-in page instead of the network. */
  offline: { gamePage(slug: string): string } | null;
  /** The game view's preload (`dist/preload/play-mic.cjs`). */
  micPreload: string;
  /** The games whose mic is on and the chosen microphone. */
  micStore: PlayMicStore;
  /** The bar's layer: its page (`dist/renderer/play-bar.html`) and its preload (`dist/preload/play-bar.cjs`). */
  barPage: string;
  barPreload: string;
  /** The bar page's `additionalArguments` (the computer's languages, `main/language.ts`); none when absent. */
  barArguments?: () => string[];
  /** The game's comments on genex.games. */
  comments: PlayComments;
  /** A web game's native app on this computer, for the bar's pill; absent where Genex plays no native game. */
  nativeApp?: PlayViewerDeps["nativeApp"];
  /** Whether a game sells items, for the bar's Store door; the Store itself is drawn by the studio's page. */
  storeShown?: (slug: string) => Promise<boolean>;
  /** genex.games' coin, for a game's purchase sheet. */
  coin: ViewerCoin;
  /** The app's Genex account: the purchase sheet's Sign in. */
  account: { signIn(): void };
  /** A genex.games page the purchase sheet opens (Get Nex): to the browser. */
  openPage(url: string): void;
  /**
   * Where genex.games confirms a game's purchase (`purchaseConfirmOrigin`): the game's popup for it is
   * caught and shown as the viewer's sheet. Null catches nothing: every open is a link.
   */
  confirmOrigin: string | null;
}

/**
 * Give `play` Play's rules, once: grant only what Play allows and only to a game's own page (never to a
 * frame inside it, nor to a purchase's hidden popup), and refuse every download. The microphone is its
 * view's gate's to grant: once, just after the viewer told the page to open it; a camera never.
 * Exported for the Electron check of a purchase popup (`tests/e2e/play-purchase-electron.ts`).
 */
export function preparePlaySession(play: Session): Session {
  if (prepared.has(play)) return play;
  prepared.add(play);
  play.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (isPurchaseWindow(contents)) return callback(false);
    const mediaTypes = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    const request = { mediaTypes, isMainFrame: details.isMainFrame };
    callback(playPermitted(permission, request, micGates.get(contents), Date.now()));
  });
  play.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (contents && isPurchaseWindow(contents)) return false;
    const gate = contents ? micGates.get(contents) : undefined;
    return playPermissionShown(permission, { mediaType: details.mediaType, isMainFrame: details.isMainFrame }, gate);
  });
  play.on("will-download", (event) => event.preventDefault());
  return play;
}

/** Play's own session, with its rules. */
const playSession = (): Session => preparePlaySession(session.fromPartition(PLAY_PARTITION));

/** The viewer's views in a window: its bar's layer once made, and the game's view while a game is open. */
export interface PlayViews {
  bar(): WebContentsView | null;
  game(): WebContentsView | null;
}

/** `win`'s Play views, for the development control; null before the viewer is wired. */
export const playViewsOf = (win: BrowserWindow): PlayViews | null => viewsOf.get(win) ?? null;

/**
 * What the game's view reports to the viewer: its keys, how its page loads, its full screen, its
 * microphone and the purchases it asks for; and what it asks the viewer before catching one.
 */
interface ViewerEvents {
  key(input: FullScreenKey): void;
  /** The page took the screen in full screen, or gave it back. */
  fullScreen(on: boolean): void;
  loaded(): void;
  failed(): void;
  /** The page committed a new document: it reloaded, or moved to another Genex game. */
  navigated(): void;
  mic(report: PlayMicReport): void;
  /** The game asked to pay for the purchase `intentId`. */
  purchase(intentId: string): void;
  /** Whether the viewer may show a purchase sheet now: a popup for one is made only then. */
  mayReserve(): boolean;
}

/**
 * Whether the person's microphone may be used. macOS asks the person the first time (the app's
 * own prompt, once); Windows answers its privacy switch; elsewhere the browser's own rules apply.
 */
async function microphoneAccess(): Promise<boolean> {
  const { platform } = process;
  if (platform !== "darwin" && platform !== "win32") return true;
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return true;
  if (platform === "darwin") return status === "not-determined" && systemPreferences.askForMediaAccess("microphone");
  return status !== "denied";
}

/** Open the system's microphone privacy settings, where the app is allowed the microphone. */
function openMicSettings(): void {
  const where = MIC_SETTINGS[process.platform];
  if (where) void shell.openExternal(where).catch(() => {});
}

/**
 * The menu of microphones at `at` under the mic switch: the system's first, then each by name, the
 * chosen one checked (kept in the list while it is not plugged in).
 */
function showMicMenu(
  win: BrowserWindow,
  devices: readonly string[],
  chosen: string | null,
  at: PlayPoint | undefined,
  choose: (device: string | null) => void,
): void {
  if (win.isDestroyed()) return;
  const names = chosen && !devices.includes(chosen) ? [...devices, chosen] : devices;
  const item = (label: string, device: string | null): MenuItemConstructorOptions => ({
    label,
    type: "radio",
    checked: device === chosen,
    click: () => choose(device),
  });
  const template: MenuItemConstructorOptions[] = [
    { label: MESSAGE.micMenu(), enabled: false },
    item(MESSAGE.systemDefault(), null),
    ...names.map((name) => item(name, name)),
  ];
  if (devices.length === 0) template.push({ type: "separator" }, { label: MESSAGE.noNames(), enabled: false });
  Menu.buildFromTemplate(template).popup({ window: win, ...at });
}

/**
 * Keep a game's page on its own addresses. A link it follows or opens elsewhere goes to the browser
 * (without its fragment, at most one every few seconds); a server redirect elsewhere goes nowhere,
 * since it may carry the sign-in ticket. The game's own frames may go where they like. A window it
 * opens is a link too, unless it is the popup of a coin purchase (`purchase-window.ts`).
 */
function guardNavigation(contents: WebContents, play: Session, deps: PlayViewDeps, events: ViewerEvents): void {
  const offline = deps.offline !== null;
  const sendOut = linkGate(deps.openExternal);
  contents.on("will-navigate", (event, target) => {
    if (playNavigationAllowed(target, offline, deps.origins)) return;
    event.preventDefault();
    sendOut(target);
  });
  contents.on("will-redirect", (event) => {
    if (!event.isMainFrame || playNavigationAllowed(event.url, offline, deps.origins)) return;
    event.preventDefault();
  });
  wirePurchaseCapture(play, contents, {
    confirmOrigin: deps.confirmOrigin,
    sendOut,
    mayReserve: events.mayReserve,
    purchase: events.purchase,
    page: (id) => webContents.fromId(id),
    clock: TIMERS,
  });
}

/** The page's word on its microphone, from its own top frame only, as main accepts it. */
function hearMic(contents: WebContents, mine: () => boolean, hear: (report: PlayMicReport) => void): void {
  contents.ipc.on(PlayMicChannel.Report, (event, raw: unknown) => {
    if (!mine() || event.senderFrame?.parent !== null) return;
    const report = readMicReport(raw);
    if (report) hear(report);
  });
}

/**
 * Every press in the bar's layer, for the purchase sheet's Pay (`viewer-purchase.ts`): a key before it
 * lands, with whether it repeats, and a pointer or touch going down.
 */
function hearBarInput(contents: WebContents, hear: (input: SheetInput) => void): void {
  contents.on("before-input-event", (_event, input) => hear({ type: input.type, isAutoRepeat: input.isAutoRepeat }));
  contents.on("input-event", (_event, input) => {
    if (!KEY_INPUTS.has(input.type)) hear({ type: input.type });
  });
}

/**
 * The bar's layer over the game: the studio's own page in a transparent view, made ahead of the first
 * game (`warm`) and kept, drawn over each new game's view. It hears the viewer's news as the studio's
 * page does; a page that loads late says so once it has mounted (`PlayBarHold.ready`) and is drawn
 * the bar again. A layer whose page went away loads it again. Its input is heard for the purchase sheet.
 */
function barLayer(win: BrowserWindow, deps: PlayViewDeps, lost: () => void, heard: (input: SheetInput) => void) {
  let view: WebContentsView | null = null;
  // A page that dies on load does not spin: past a couple of reloads a minute the viewer closes, since
  // a game with no bar has no way out but a held Esc.
  const reloads = createReloadPolicy();
  const made = (): WebContentsView => {
    if (view && !view.webContents.isDestroyed()) return view;
    const layer = new WebContentsView({
      webPreferences: {
        preload: deps.barPreload,
        additionalArguments: deps.barArguments?.() ?? [],
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    layer.setBackgroundColor(TRANSPARENT);
    layer.setVisible(false);
    const contents = layer.webContents;
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    hearBarInput(contents, heard);
    contents.on("render-process-gone", (_event, details) => {
      const decision = reloads.decide(details.reason);
      if (decision === ReloadDecision.GiveUp) lost();
      else if (decision === ReloadDecision.Reload && !contents.isDestroyed()) contents.reload();
    });
    void contents.loadFile(deps.barPage, { query: { platform: process.platform } }).catch(() => {});
    win.contentView.addChildView(layer);
    view = layer;
    return layer;
  };
  return {
    view: (): WebContentsView | null => view,
    /** Over everything again: a game's view added since lies under it. */
    raise: (): void => {
      if (!win.isDestroyed()) win.contentView.addChildView(made());
    },
    show: (bounds: Rect): void => {
      const layer = made();
      layer.setBounds(bounds);
      layer.setVisible(true);
    },
    hide: (): void => view?.setVisible(false),
    focus: (): void => made().webContents.focus(),
    /** Whether the layer's page has the keyboard. */
    focused: (): boolean => Boolean(view && !view.webContents.isDestroyed() && view.webContents.isFocused()),
    /** The window is gone: the layer's page closes with it. */
    destroy: (): void => {
      closePage(view?.webContents);
      view = null;
    },
    warm: (): void => {
      if (!win.isDestroyed()) made();
    },
    reload: (): void => {
      const contents = view?.webContents;
      if (contents && !contents.isDestroyed()) contents.reload();
    },
    /** The viewer's news, for the bar's page. */
    tell: (event: PlayViewerEvent): void => {
      const contents = view?.webContents;
      if (contents && !contents.isDestroyed())
        pushToRenderer(contents, "studio:event", { type: UiEvent.PlayViewer, payload: event });
    },
  };
}

/**
 * The game's view: a fresh one per game in Play's session, below the bar's layer, reporting how its
 * page loads, when it takes the screen in full screen and how its microphone is, with the embed SDK's
 * guest popover hidden on every page it shows.
 */
function gameView(win: BrowserWindow, deps: PlayViewDeps, events: ViewerEvents, raiseBar: () => void) {
  const play = playSession();
  const trust = deps.certificates;
  // A development stand's own CA, for its game hosts only; every other launch leaves Chromium to judge.
  if (trust) play.setCertificateVerifyProc((request, answer) => answer(trust(request)));
  let current: WebContentsView | null = null;
  const close = (): void => {
    const view = current;
    current = null;
    dropGameView<WebContentsView>(win, view);
  };
  const open = (url: string, bounds: Rect): void => {
    close();
    const view = new WebContentsView({
      webPreferences: {
        session: play,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        autoplayPolicy: "no-user-gesture-required",
        disableBlinkFeatures: GAME_DISABLED_BLINK_FEATURES.join(","),
        preload: deps.micPreload,
      },
    });
    view.setBackgroundColor(GAME_BACKGROUND);
    view.setVisible(false);
    // The page boots at the size it plays at, so a game that sizes its canvas once starts right.
    view.setBounds(bounds);
    win.contentView.addChildView(view);
    raiseBar();
    current = view;
    const contents = view.webContents;
    const mine = () => current === view;
    micGates.set(contents, micGate());
    hearMic(contents, mine, events.mic);
    contents.on("enter-html-full-screen", () => mine() && events.fullScreen(true));
    contents.on("leave-html-full-screen", () => mine() && events.fullScreen(false));
    // A purchase is caught only for the game on screen.
    guardNavigation(contents, play, deps, {
      ...events,
      purchase: (intentId) => mine() && events.purchase(intentId),
      mayReserve: () => mine() && events.mayReserve(),
    });
    contents.on("did-finish-load", () => mine() && events.loaded());
    contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
      if (mine() && isMainFrame && code !== ERR_ABORTED) events.failed();
    });
    contents.on("did-navigate", (_event, page, status) => {
      if (!mine()) return;
      // Each page starts with its own gate; a page off the game's origin never gets the microphone.
      micGates.set(contents, micGateFor(page, url));
      events.navigated();
      if (status === GONE_STATUS || status >= SERVER_ERROR) events.failed();
    });
    contents.on("render-process-gone", () => mine() && events.failed());
    contents.on("dom-ready", () => {
      if (contents.isDestroyed()) return;
      for (const css of [HIDE_GUEST_POPOVER, HIDE_GAME_FOCUS_RING])
        void contents.insertCSS(css, { cssOrigin: "user" }).catch(() => {});
    });
    contents.on("before-input-event", (_event, input) => events.key(input));
    void contents.loadURL(url).catch(() => {});
  };
  return {
    view: (): WebContentsView | null => current,
    open: (url: string, _slug: string, bounds: Rect): void => open(url, bounds),
    show: (bounds: Rect): void => {
      current?.setBounds(bounds);
      current?.setVisible(true);
    },
    hide: (): void => current?.setVisible(false),
    focus: (): void => current?.webContents.focus(),
    fullScreen: (): void => {
      const contents = current?.webContents;
      if (contents && !contents.isDestroyed())
        void contents.executeJavaScript(REQUEST_FULL_SCREEN, true).catch(() => undefined);
    },
    close,
    /** Tell the game's page to open the microphone or close it; an opening is what the gate lets through. */
    mic: (command: PlayMicCommand): void => {
      const contents = current?.webContents;
      if (!contents || contents.isDestroyed()) return;
      if (command.open) micGates.get(contents)?.allow(Date.now());
      contents.send(PlayMicChannel.Command, command);
    },
  };
}

/** Wire the viewer into `win`. */
export function wirePlayViewer(deps: PlayViewDeps): PlayViewer {
  const { win, offline } = deps;
  // The views are made before the viewer that answers them: their events reach it once it exists.
  let viewer: PlayViewer | null = null;
  const events: ViewerEvents = {
    key: (input) => viewer?.key(input),
    fullScreen: (on) => viewer?.fullScreen(on),
    loaded: () => viewer?.loaded(),
    failed: () => viewer?.failed(),
    navigated: () => viewer?.navigated(),
    mic: (report) => viewer?.mic(report),
    purchase: (intentId) => viewer?.purchase(intentId),
    mayReserve: () => viewer?.mayReserve() === true,
  };
  const bar = barLayer(
    win,
    deps,
    () => viewer?.close(),
    (input) => viewer?.barInput(input),
  );
  const game = gameView(win, deps, events, bar.raise);
  viewsOf.set(win, { bar: bar.view, game: game.view });
  const made = playViewer({
    gallery: deps.gallery,
    gameUrl: (slug, ticket) => (offline ? offline.gamePage(slug) : playAddress(slug, ticket, deps.origins.games)),
    window: {
      contentSize: () => {
        if (win.isDestroyed()) return { width: 0, height: 0 };
        const [width = 0, height = 0] = win.getContentSize();
        return { width, height };
      },
      buttons: (visible) => {
        if (process.platform === StudioPlatform.Mac && !win.isDestroyed()) win.setWindowButtonVisibility(visible);
      },
    },
    game,
    // The game's view loses the keyboard to the bar, and with it any mouse lock it held.
    bar,
    comments: deps.comments,
    ...(deps.nativeApp ? { nativeApp: deps.nativeApp } : {}),
    // The Store opens in the game's place on the studio's own page, which takes the keyboard for it.
    ...(deps.storeShown
      ? {
          store: {
            shown: deps.storeShown,
            focusPage: () => {
              if (!win.isDestroyed()) win.webContents.focus();
            },
          },
        }
      : {}),
    coin: deps.coin,
    account: deps.account,
    openPage: deps.openPage,
    clipboard: (text) => clipboard.writeText(text),
    web: deps.web,
    emit: (event) => {
      deps.emit(event);
      bar.tell(event);
    },
    clock: { ...TIMERS, now: () => Date.now() },
    // A fixture launch never asks the system or opens its settings: its stand-in page holds no microphone.
    mic: {
      access: () => (offline ? Promise.resolve(true) : microphoneAccess()),
      command: (command) => game.mic(command),
      menu: (devices, chosen, at, choose) => showMicMenu(win, devices, chosen, at, choose),
      openSettings: () => {
        if (!offline) openMicSettings();
      },
      store: deps.micStore,
    },
  });
  viewer = made;
  win.on("resize", () => made.resized());
  // A click that brings the window back never lands on a purchase's Pay: it waits again.
  win.on("focus", () => made.focusChanged());
  win.on("blur", () => made.focusChanged());
  closeWithWindow(win, () => made.close());
  win.on("closed", () => bar.destroy());
  return made;
}

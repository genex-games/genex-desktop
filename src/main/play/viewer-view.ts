/**
 * The Play viewer's game view in the studio window (`viewer.ts` decides what it does): a fresh
 * sandboxed view per game in Play's own session, under the app's own header (drawn by the renderer
 * above it). The game's page may move between Genex games' addresses and Genex's sign-in hop; any
 * other link opens in the browser. Play's session grants only mouse lock, full screen and clipboard
 * writes, and the microphone to a game's own page just after the viewer told it to open it (the
 * header's mic switch, `mic.ts`). Its one preload (`preload/play-mic.ts`) gives the page the app's
 * microphone and carries the mic's word between the page and main; the menu of microphones is a
 * native one, since the game's view covers anything the renderer draws under the header.
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
} from "electron";
import { PLAY_BAR_HEIGHT, type PlayPoint, type PlayViewerEvent } from "../../shared/play.ts";
import { type PlayMicCommand, PlayMicChannel, type PlayMicReport, readMicReport } from "../../shared/play-mic.ts";
import type { FullScreenKey, Rect } from "../game-full-screen.ts";
import { GAME_DISABLED_BLINK_FEATURES } from "../game-view.ts";
import { linkGate, playAddress, playNavigationAllowed } from "./game-address.ts";
import type { PlayGallery } from "./gallery.ts";
import { playPermissionShown, playPermitted } from "./game-permissions.ts";
import { type MicGate, micGate, micGateFor } from "./mic.ts";
import type { PlayMicStore } from "./mic-store.ts";
import { playViewer, type PlayViewer } from "./viewer.ts";

/** Sessions already given Play's rules: a window made again shares the session and its handlers. */
const prepared = new WeakSet<Session>();
/** Each game view's microphone gate: the session's handlers find a view's by its contents. */
const micGates = new WeakMap<WebContents, MicGate>();
/** Play's own storage: games keep their saves across launches, apart from the studio's. */
export const PLAY_PARTITION = "persist:genex-play";
/** What a game's page shows before it paints. */
const GAME_BACKGROUND = "#000000";
/** A navigation the browser itself aborted (a new one replaced it): not a failure. */
const ERR_ABORTED = -3;
/** HTTP answers that mean the game is not there to play. */
const GONE_STATUS = 404;
const SERVER_ERROR = 500;
/**
 * The Genex embed SDK's own guest popover on a game's page ("Playing as Guest … Sign in"). Its Sign in
 * goes to the website, which cannot sign the app in; the viewer's own guest card offers the Genex
 * plugin instead. A user-origin rule, so not even the popover's inline `!important` styles win.
 */
const HIDE_GUEST_POPOVER = "[data-genex-guest-popover]{display:none !important}";
/** Where each system keeps its microphone privacy switch for apps. */
const MIC_SETTINGS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  win32: "ms-settings:privacy-microphone",
};
/** The mic menu's words. */
const MESSAGE = {
  micMenu: "Microphone",
  systemDefault: "System default",
  noNames: "Your microphones are listed once the mic is on",
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
  /** Fixture launches: a local stand-in page instead of the network. */
  offline: { gamePage(slug: string): string } | null;
  /** The game view's preload (`dist/preload/play-mic.cjs`). */
  micPreload: string;
  /** The games whose mic is on and the chosen microphone. */
  micStore: PlayMicStore;
}

/**
 * Play's session, granting only what Play allows and only to a game's own page (never to a frame
 * inside it), and refusing every download. The microphone is its view's gate's to grant: once, just
 * after the viewer told the page to open it; a camera never.
 */
function playSession(): Session {
  const play = session.fromPartition(PLAY_PARTITION);
  if (prepared.has(play)) return play;
  prepared.add(play);
  play.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    const request = { mediaTypes, isMainFrame: details.isMainFrame };
    callback(playPermitted(permission, request, micGates.get(contents), Date.now()));
  });
  play.setPermissionCheckHandler((contents, permission, _origin, details) => {
    const gate = contents ? micGates.get(contents) : undefined;
    return playPermissionShown(permission, { mediaType: details.mediaType, isMainFrame: details.isMainFrame }, gate);
  });
  play.on("will-download", (event) => event.preventDefault());
  return play;
}

/** What the game's view reports to the viewer: its keys, how its page loads, and its microphone. */
interface ViewerEvents {
  key(input: FullScreenKey): void;
  loaded(): void;
  failed(): void;
  mic(report: PlayMicReport): void;
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
    { label: MESSAGE.micMenu, enabled: false },
    item(MESSAGE.systemDefault, null),
    ...names.map((name) => item(name, name)),
  ];
  if (devices.length === 0) template.push({ type: "separator" }, { label: MESSAGE.noNames, enabled: false });
  Menu.buildFromTemplate(template).popup({ window: win, ...at });
}

/**
 * Keep a game's page on its own addresses. A link it follows or opens elsewhere goes to the browser
 * (without its fragment, at most one every few seconds); a server redirect elsewhere goes nowhere,
 * since it may carry the sign-in ticket. The game's own frames may go where they like.
 */
function guardNavigation(contents: WebContents, offline: boolean, openExternal: (url: string) => void): void {
  const sendOut = linkGate(openExternal);
  contents.on("will-navigate", (event, target) => {
    if (playNavigationAllowed(target, offline)) return;
    event.preventDefault();
    sendOut(target);
  });
  contents.on("will-redirect", (event) => {
    if (!event.isMainFrame || playNavigationAllowed(event.url, offline)) return;
    event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    sendOut(url);
    return { action: "deny" };
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
 * The game's view: a fresh one per game in Play's session, under the app's header, reporting how its
 * page loads and how its microphone is, with the embed SDK's guest popover hidden on every page it
 * shows.
 */
function gameView(win: BrowserWindow, deps: PlayViewDeps, events: ViewerEvents) {
  const play = playSession();
  let current: WebContentsView | null = null;
  const close = (): void => {
    const view = current;
    current = null;
    if (!view) return;
    if (!view.webContents.isDestroyed()) view.webContents.close();
    if (win.isDestroyed()) return;
    win.contentView.removeChildView(view);
    // The keyboard comes back to the app the game took it from.
    win.webContents.focus();
  };
  const open = (url: string): void => {
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
    // The page boots at the size it plays at, under the header, so a game that sizes its canvas once starts right.
    const [width = 0, height = 0] = win.getContentSize();
    view.setBounds({ x: 0, y: PLAY_BAR_HEIGHT, width, height: Math.max(0, height - PLAY_BAR_HEIGHT) });
    win.contentView.addChildView(view);
    current = view;
    const contents = view.webContents;
    const mine = () => current === view;
    micGates.set(contents, micGate());
    hearMic(contents, mine, events.mic);
    guardNavigation(contents, deps.offline !== null, deps.openExternal);
    contents.on("did-finish-load", () => mine() && events.loaded());
    contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
      if (mine() && isMainFrame && code !== ERR_ABORTED) events.failed();
    });
    contents.on("did-navigate", (_event, page, status) => {
      if (!mine()) return;
      // Each page starts with its own gate; a page off the game's origin never gets the microphone.
      micGates.set(contents, micGateFor(page, url));
      if (status === GONE_STATUS || status >= SERVER_ERROR) events.failed();
    });
    contents.on("render-process-gone", () => mine() && events.failed());
    contents.on("dom-ready", () => {
      if (!contents.isDestroyed()) void contents.insertCSS(HIDE_GUEST_POPOVER, { cssOrigin: "user" }).catch(() => {});
    });
    contents.on("before-input-event", (_event, input) => events.key(input));
    void contents.loadURL(url).catch(() => {});
  };
  return {
    open,
    show: (bounds: Rect): void => {
      current?.setBounds(bounds);
      current?.setVisible(true);
    },
    hide: (): void => current?.setVisible(false),
    focus: (): void => current?.webContents.focus(),
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
    loaded: () => viewer?.loaded(),
    failed: () => viewer?.failed(),
    mic: (report) => viewer?.mic(report),
  };
  const game = gameView(win, deps, events);
  const made = playViewer({
    gallery: deps.gallery,
    gameUrl: (slug, ticket) => (offline ? offline.gamePage(slug) : playAddress(slug, ticket)),
    window: {
      contentSize: () => {
        if (win.isDestroyed()) return { width: 0, height: 0 };
        const [width = 0, height = 0] = win.getContentSize();
        return { width, height };
      },
    },
    game,
    // The game's view loses the keyboard, and with it any mouse lock it held.
    focusApp: () => {
      if (!win.isDestroyed()) win.webContents.focus();
    },
    clipboard: (text) => clipboard.writeText(text),
    web: deps.web,
    emit: deps.emit,
    clock: {
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
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
  // A hidden or closed window takes its game with it: no sound, no timers on a window that is gone.
  win.on("hide", () => made.close());
  win.on("closed", () => made.close());
  return made;
}

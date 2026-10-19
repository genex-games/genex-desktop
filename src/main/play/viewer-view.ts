/**
 * The Play viewer's views in the studio window (`viewer.ts` decides what they do): a fresh sandboxed
 * view per game in Play's own session, across the whole window, and above it the bar's layer, a
 * transparent view of the studio's own page (`renderer/play-bar.html`) made once and kept. The game's
 * page may move between Genex games' addresses and Genex's sign-in hop; any other link opens in the
 * browser. Play's session grants only mouse lock, full screen and clipboard writes, and the microphone
 * to a game's own page just after the viewer told it to open it (the bar's mic switch, `mic.ts`). Its
 * one preload (`preload/play-mic.ts`) gives the page the app's microphone and `window.__genexDesktop`
 * (play-time AI and the embed-sdk's desktop confirm), and carries their words between the page and
 * main; the menu of microphones is a native one. Every popup a page asks for is still denied: the
 * SDK's spend approval is Genex's card on the bar (`game-ai/bridge-play.ts`). Play's session refuses
 * a game's direct requests to AI vendors (`ai-gateway.ts`).
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
import { StudioPlatform } from "../../shared/boot.ts";
import type { PlayPoint, PlayViewerEvent } from "../../shared/play.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { type PlayMicCommand, PlayMicChannel, type PlayMicReport, readMicReport } from "../../shared/play-mic.ts";
import { PlayAiChannel } from "../../shared/play-ai.ts";
import { type PlayAiGame, playAiPort } from "../game-ai/bridge-play.ts";
import type { GameAiPlayBridge } from "../game-ai/types.ts";
import { aiGatewayVerdict, type BlockedNotes, blockedNotes } from "./ai-gateway.ts";
import type { FullScreenKey, Rect } from "../game-full-screen.ts";
import { GAME_DISABLED_BLINK_FEATURES } from "../game-view.ts";
import { createReloadPolicy, ReloadDecision } from "../app-lifecycle.ts";
import { pushToRenderer } from "../ipc-handle.ts";
import type { PlayComments } from "./comments.ts";
import { linkGate, playAddress, playNavigationAllowed } from "./game-address.ts";
import type { PlayGallery } from "./gallery.ts";
import { playPermissionShown, playPermitted } from "./game-permissions.ts";
import { type MicGate, micGate, micGateFor } from "./mic.ts";
import { closePage, closeWithWindow, dropGameView } from "./view-drop.ts";
import type { PlayMicStore } from "./mic-store.ts";
import { playViewer, type PlayViewer } from "./viewer.ts";

/** Each studio window's Play views, for the development control (`dev/runtime.ts`). */
const viewsOf = new WeakMap<BrowserWindow, PlayViews>();
/** Sessions already given Play's rules: a window made again shares the session and its handlers. */
const prepared = new WeakSet<Session>();
/** Each game view's microphone gate: the session's handlers find a view's by its contents. */
const micGates = new WeakMap<WebContents, MicGate>();
/** Each game view's AI vendor refusals told to its page: the session's request filter finds a view's by its contents. */
const vendorNotes = new WeakMap<WebContents, BlockedNotes>();
/** Play's own storage: games keep their saves across launches, apart from the studio's. */
export const PLAY_PARTITION = "persist:genex-play";
/** What a game's page shows before it paints. */
const GAME_BACKGROUND = "#000000";
/** The bar's layer is see-through: only the bar (and Comments over the dimmed game) is drawn. */
const TRANSPARENT = "#00000000";
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
  /** The bar's layer: its page (`dist/renderer/play-bar.html`) and its preload (`dist/preload/play-bar.cjs`). */
  barPage: string;
  barPreload: string;
  /** The game's comments on genex.games. */
  comments: PlayComments;
  /**
   * Play-time AI for the game's page (`game-ai/bridge-play.ts`). Absent in a studio composed
   * without it: the page's bridge is still there, and answers that AI is off.
   */
  ai?: GameAiPlayBridge;
}

/** Whether Play refuses a game's request (D5); a refused one is told to its page, once per host. */
function refuseVendor(contents: WebContents | undefined, url: string): boolean {
  const blocked = aiGatewayVerdict(url);
  if (!blocked) return false;
  if (contents && !contents.isDestroyed() && vendorNotes.get(contents)?.first(blocked))
    contents.send(PlayAiChannel.Blocked, blocked);
  return true;
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
  // `genex-ai` is the only way a game reaches a model (D5): an AI vendor's API never loads in Play.
  play.webRequest.onBeforeRequest((details, callback) => {
    callback(refuseVendor(details.webContents, details.url) ? { cancel: true } : {});
  });
  return play;
}

/** The viewer's views in a window: its bar's layer once made, and the game's view while a game is open. */
export interface PlayViews {
  bar(): WebContentsView | null;
  game(): WebContentsView | null;
}

/** `win`'s Play views, for the development control; null before the viewer is wired. */
export const playViewsOf = (win: BrowserWindow): PlayViews | null => viewsOf.get(win) ?? null;

/** What the game's view reports to the viewer: its keys and pointer, how its page loads, and its microphone. */
interface ViewerEvents {
  key(input: FullScreenKey): void;
  pointer(x: number, y: number): void;
  loaded(): void;
  failed(): void;
  mic(report: PlayMicReport): void;
  /** The game on screen, as its AI bridge names it. */
  aiGame(): Promise<PlayAiGame | null>;
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

/**
 * Where the pointer is over the game, from the mouse moves the view is sent. A game holding the mouse
 * (pointer lock) is still sent moves, all at the point where the lock began.
 */
function hearPointer(contents: WebContents, mine: () => boolean, hear: (x: number, y: number) => void): void {
  contents.on("input-event", (_event, input) => {
    if (!mine() || input.type !== "mouseMove") return;
    const { x, y } = input as Electron.MouseInputEvent;
    if (typeof x === "number" && typeof y === "number") hear(x, y);
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
 * The page's AI envelopes and the embed-sdk's confirms, from its own top frame only, attributed per
 * message to the game it shows now (`game-ai/bridge-play.ts`). A person's click or key on the page
 * is what lets it ask for a grant; a top-frame navigation abandons its calls and cards.
 */
function hearAi(
  contents: WebContents,
  mine: () => boolean,
  bridge: GameAiPlayBridge | null,
  game: () => Promise<PlayAiGame | null>,
): void {
  const port = playAiPort({
    bridge,
    game,
    pageUrl: () => (contents.isDestroyed() ? "" : contents.getURL()),
    live: () => mine() && !contents.isDestroyed(),
    channel: String(contents.id),
    send: {
      reply: (reply) => contents.send(PlayAiChannel.Reply, reply),
      delta: (delta) => contents.send(PlayAiChannel.Delta, delta),
    },
    clock: { now: Date.now },
  });
  const notes = blockedNotes();
  vendorNotes.set(contents, notes);
  contents.ipc.on(PlayAiChannel.Request, (event, raw: unknown, gesture: unknown) => {
    const frame = event.senderFrame;
    void port.request({ url: frame?.url ?? "", top: Boolean(frame) && frame?.parent === null }, raw, gesture);
  });
  contents.on("input-event", (_event, input) => {
    port.input({ type: input.type, keyCode: "keyCode" in input ? String(input.keyCode) : undefined });
  });
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) port.navigating();
  });
  contents.on("did-navigate", () => {
    notes.reset();
    port.navigated();
  });
  contents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) port.stayed();
  });
  contents.on("did-stop-loading", () => port.stayed());
  contents.once("destroyed", () => port.gone());
}

/**
 * The bar's layer over the game: the studio's own page in a transparent view, made ahead of the first
 * game (`warm`) and kept, drawn over each new game's view. It hears the viewer's news as the studio's
 * page does; a page that loads late says so once it has mounted (`PlayBarHold.ready`) and is drawn
 * the bar again. A layer whose page went away loads it again.
 */
function barLayer(win: BrowserWindow, deps: PlayViewDeps, lost: () => void) {
  let view: WebContentsView | null = null;
  // A page that dies on load does not spin: past a couple of reloads a minute the viewer closes, since
  // a game with no bar has no way out but a held Esc.
  const reloads = createReloadPolicy();
  const made = (): WebContentsView => {
    if (view && !view.webContents.isDestroyed()) return view;
    const layer = new WebContentsView({
      webPreferences: { preload: deps.barPreload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    layer.setBackgroundColor(TRANSPARENT);
    layer.setVisible(false);
    const contents = layer.webContents;
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
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
    /** The viewer's news, for the bar's page. */
    tell: (event: PlayViewerEvent): void => {
      const contents = view?.webContents;
      if (contents && !contents.isDestroyed())
        pushToRenderer(contents, "studio:event", { type: UiEvent.PlayViewer, payload: event });
    },
  };
}

/**
 * The game's view: a fresh one per game in Play's session, across the window under the bar's layer,
 * reporting how its page loads, where the pointer is and how its microphone is, with the embed SDK's
 * guest popover hidden on every page it shows.
 */
function gameView(win: BrowserWindow, deps: PlayViewDeps, events: ViewerEvents, raiseBar: () => void) {
  const play = playSession();
  let current: WebContentsView | null = null;
  const close = (): void => {
    const view = current;
    current = null;
    dropGameView<WebContentsView>(win, view);
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
    // The page boots at the size it plays at, the whole window, so a game that sizes its canvas once starts right.
    const [width = 0, height = 0] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
    win.contentView.addChildView(view);
    raiseBar();
    current = view;
    const contents = view.webContents;
    const mine = () => current === view;
    micGates.set(contents, micGate());
    hearMic(contents, mine, events.mic);
    hearAi(contents, mine, deps.ai ?? null, events.aiGame);
    hearPointer(contents, mine, events.pointer);
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
    view: (): WebContentsView | null => current,
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
    pointer: (x, y) => viewer?.pointer(x, y),
    loaded: () => viewer?.loaded(),
    failed: () => viewer?.failed(),
    mic: (report) => viewer?.mic(report),
    aiGame: () => viewer?.aiGame() ?? Promise.resolve(null),
  };
  const bar = barLayer(win, deps, () => viewer?.close());
  const game = gameView(win, deps, events, bar.raise);
  viewsOf.set(win, { bar: bar.view, game: game.view });
  const made = playViewer({
    gallery: deps.gallery,
    gameUrl: (slug, ticket) => (offline ? offline.gamePage(slug) : playAddress(slug, ticket)),
    window: {
      contentSize: () => {
        if (win.isDestroyed()) return { width: 0, height: 0 };
        const [width = 0, height = 0] = win.getContentSize();
        return { width, height };
      },
      buttons: (visible) => {
        if (process.platform === StudioPlatform.Mac && !win.isDestroyed()) win.setWindowButtonVisibility(visible);
      },
      // Windows and Linux draw their window controls over the bar's corner and cannot hide them with it.
      barFades: process.platform === StudioPlatform.Mac,
    },
    game,
    // The game's view loses the keyboard to the bar, and with it any mouse lock it held.
    bar,
    comments: deps.comments,
    clipboard: (text) => clipboard.writeText(text),
    web: deps.web,
    emit: (event) => {
      deps.emit(event);
      bar.tell(event);
    },
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
  closeWithWindow(win, () => made.close());
  win.on("closed", () => bar.destroy());
  return made;
}

/**
 * The application menu, built whole so every label speaks the app's language: Electron's default
 * menu (its roles keep their native actions and keyboard shortcuts) with Check for Updates… after
 * About on macOS and in Help elsewhere. Electron's own Help links stay out, as in a packaged app.
 * Main builds it at start and again whenever the language changes; a plain function, so its
 * labels are tested without Electron.
 */
import type { MenuItemConstructorOptions } from "electron";
import { currentLocale, t, tc } from "../shared/i18n.ts";
import { Locale } from "../shared/locale.ts";

/** What the menu needs from the running app. */
export interface AppMenuOptions {
  /** `process.platform`: macOS has the app menu, the others keep Check for Updates… in Help. */
  platform: NodeJS.Platform;
  /** The app's name, as macOS's app menu writes it ("About Genex"). */
  appName: string;
  /** What Check for Updates… does. */
  checkForUpdates: () => void;
  /**
   * The Mac's own language (`matchLocale` of its list): macOS adds Start Dictation… and Emoji &
   * Symbols only to a menu titled with its word for Edit. The app's language when absent.
   */
  macLanguage?: Locale;
}

/**
 * macOS's word for the Edit menu in each language, as AppKit spells it (InputManager.loctable):
 * the title it looks for. A system string, not a translation of Genex's.
 */
const MAC_EDIT_MENU = {
  [Locale.English]: "Edit",
  [Locale.Russian]: "Правка",
  [Locale.Spanish]: "Edición",
  [Locale.PortugueseBrazil]: "Editar",
  [Locale.German]: "Bearbeiten",
  [Locale.French]: "Édition",
  [Locale.Japanese]: "編集",
  [Locale.Korean]: "편집",
  [Locale.ChineseSimplified]: "编辑",
} as const satisfies Record<Locale, string>;

const SEPARATOR: MenuItemConstructorOptions = { type: "separator" };

/** The whole application menu for `options.platform`, its labels in the active language. */
export function appMenuTemplate(options: AppMenuOptions): MenuItemConstructorOptions[] {
  const mac = options.platform === "darwin";
  const updates: MenuItemConstructorOptions = {
    label: t("Check for Updates…"),
    click: () => options.checkForUpdates(),
  };
  // macOS's Help keeps its search field and nothing else; elsewhere Help is where updates are checked.
  const help: MenuItemConstructorOptions = { role: "help", label: t("Help"), submenu: mac ? [] : [updates] };
  return [
    ...(mac ? [macAppMenu(options.appName, updates)] : []),
    fileMenu(options.platform),
    editMenu(mac, MAC_EDIT_MENU[options.macLanguage ?? currentLocale()]),
    viewMenu(),
    windowMenu(mac),
    help,
  ];
}

/** macOS's app menu, named by the system: About, Check for Updates…, Services, Hide, Quit. */
function macAppMenu(app: string, updates: MenuItemConstructorOptions): MenuItemConstructorOptions {
  return {
    label: app,
    submenu: [
      { role: "about", label: t("About {app}", { app }) },
      updates,
      SEPARATOR,
      { role: "services", label: t("Services") },
      SEPARATOR,
      { role: "hide", label: t("Hide {app}", { app }) },
      { role: "hideOthers", label: t("Hide Others") },
      { role: "unhide", label: t("Show All") },
      SEPARATOR,
      { role: "quit", label: t("Quit {app}", { app }) },
    ],
  };
}

/** File: Close Window on macOS (Quit is in the app menu), Exit on Windows, Quit on Linux. */
function fileMenu(platform: NodeJS.Platform): MenuItemConstructorOptions {
  const close: MenuItemConstructorOptions = { role: "close", label: t("Close Window") };
  const quit: MenuItemConstructorOptions = { role: "quit", label: platform === "win32" ? t("Exit") : t("Quit") };
  return { label: t("File"), submenu: [platform === "darwin" ? close : quit] };
}

/** Edit: on macOS titled `macTitle`, the Mac's word, so the system's own items join it. */
function editMenu(mac: boolean, macTitle: string): MenuItemConstructorOptions {
  const macOnly: MenuItemConstructorOptions[] = [
    { role: "pasteAndMatchStyle", label: t("Paste and Match Style") },
    { role: "delete", label: t("Delete") },
    { role: "selectAll", label: t("Select All") },
    SEPARATOR,
    {
      label: t("Speech"),
      submenu: [
        { role: "startSpeaking", label: t("Start Speaking") },
        { role: "stopSpeaking", label: t("Stop Speaking") },
      ],
    },
  ];
  const elsewhere: MenuItemConstructorOptions[] = [
    { role: "delete", label: t("Delete") },
    SEPARATOR,
    { role: "selectAll", label: t("Select All") },
  ];
  return {
    label: mac ? macTitle : tc("menu", "Edit"),
    submenu: [
      { role: "undo", label: t("Undo") },
      { role: "redo", label: t("Redo") },
      SEPARATOR,
      { role: "cut", label: t("Cut") },
      { role: "copy", label: t("Copy") },
      { role: "paste", label: t("Paste") },
      ...(mac ? macOnly : elsewhere),
    ],
  };
}

function viewMenu(): MenuItemConstructorOptions {
  return {
    label: t("View"),
    submenu: [
      { role: "reload", label: t("Reload") },
      { role: "forceReload", label: t("Force Reload") },
      { role: "toggleDevTools", label: t("Toggle Developer Tools") },
      SEPARATOR,
      { role: "resetZoom", label: t("Actual Size") },
      { role: "zoomIn", label: t("Zoom In") },
      { role: "zoomOut", label: t("Zoom Out") },
      SEPARATOR,
      { role: "togglefullscreen", label: t("Toggle Full Screen") },
    ],
  };
}

/** Window: its `window` role is macOS's Window menu, which also lists the open windows. */
function windowMenu(mac: boolean): MenuItemConstructorOptions {
  const last: MenuItemConstructorOptions[] = mac
    ? [SEPARATOR, { role: "front", label: t("Bring All to Front") }]
    : [{ role: "close", label: t("Close") }];
  return {
    role: "window",
    label: t("Window"),
    submenu: [{ role: "minimize", label: t("Minimize") }, { role: "zoom", label: t("Zoom") }, ...last],
  };
}

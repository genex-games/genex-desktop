/**
 * The application menu's template: Electron's default menu, item for item, with Check for
 * Updates… after About on macOS and last in Help elsewhere, every label written by the app (so a
 * translation reaches it) and read from the language active when it is built.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { MenuItemConstructorOptions } from "electron";
import { appMenuTemplate } from "../../src/main/app-menu.ts";
import { messageKey, setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";

afterEach(() => setLocale(Locale.English, {}));

const UPDATES = "Check for Updates…";

/** A menu as `label (role)` lines, separators as "-", submenus indented. */
function outline(items: readonly MenuItemConstructorOptions[], depth = 0): string[] {
  return items.flatMap((item) => {
    const indent = "  ".repeat(depth);
    if (item.type === "separator") return [`${indent}-`];
    const line = `${indent}${item.label}${item.role ? ` (${item.role})` : ""}`;
    const submenu = Array.isArray(item.submenu) ? outline(item.submenu, depth + 1) : [];
    return [line, ...submenu];
  });
}

function template(platform: NodeJS.Platform, checkForUpdates = () => {}): MenuItemConstructorOptions[] {
  return appMenuTemplate({ platform, appName: "Genex", checkForUpdates });
}

function findItem(items: readonly MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.label === label) return item;
    const inner = Array.isArray(item.submenu) ? findItem(item.submenu, label) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

const EDIT_COMMON = [
  "Edit",
  "  Undo (undo)",
  "  Redo (redo)",
  "  -",
  "  Cut (cut)",
  "  Copy (copy)",
  "  Paste (paste)",
];
const VIEW = [
  "View",
  "  Reload (reload)",
  "  Force Reload (forceReload)",
  "  Toggle Developer Tools (toggleDevTools)",
  "  -",
  "  Actual Size (resetZoom)",
  "  Zoom In (zoomIn)",
  "  Zoom Out (zoomOut)",
  "  -",
  "  Toggle Full Screen (togglefullscreen)",
];

describe("the application menu", () => {
  it("on macOS is the app menu with Check for Updates… after About, then File, Edit, View, Window and Help", () => {
    assert.deepEqual(outline(template("darwin")), [
      "Genex",
      "  About Genex (about)",
      `  ${UPDATES}`,
      "  -",
      "  Services (services)",
      "  -",
      "  Hide Genex (hide)",
      "  Hide Others (hideOthers)",
      "  Show All (unhide)",
      "  -",
      "  Quit Genex (quit)",
      "File",
      "  Close Window (close)",
      ...EDIT_COMMON,
      "  Paste and Match Style (pasteAndMatchStyle)",
      "  Delete (delete)",
      "  Select All (selectAll)",
      "  -",
      "  Speech",
      "    Start Speaking (startSpeaking)",
      "    Stop Speaking (stopSpeaking)",
      ...VIEW,
      "Window (window)",
      "  Minimize (minimize)",
      "  Zoom (zoom)",
      "  -",
      "  Bring All to Front (front)",
      "Help (help)",
    ]);
  });

  it("on Windows quits with Exit and checks for updates in Help", () => {
    assert.deepEqual(outline(template("win32")), [
      "File",
      "  Exit (quit)",
      ...EDIT_COMMON,
      "  Delete (delete)",
      "  -",
      "  Select All (selectAll)",
      ...VIEW,
      "Window (window)",
      "  Minimize (minimize)",
      "  Zoom (zoom)",
      "  Close (close)",
      "Help (help)",
      `  ${UPDATES}`,
    ]);
  });

  it("on Linux quits with Quit and checks for updates in Help", () => {
    const menu = outline(template("linux"));
    assert.deepEqual(menu.slice(0, 2), ["File", "  Quit (quit)"]);
    assert.deepEqual(menu.slice(-2), ["Help (help)", `  ${UPDATES}`]);
    assert.equal(menu.filter((line) => line.includes("(about)")).length, 0);
  });

  it("runs the update check from its item", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      let checks = 0;
      const item = findItem(
        template(platform, () => {
          checks += 1;
        }),
        UPDATES,
      );
      assert.ok(item?.click, platform);
      (item.click as () => void)();
      assert.equal(checks, 1, platform);
    }
  });

  it("reads its labels from the language active when it is built", () => {
    setLocale(Locale.Russian, {
      [messageKey("menu", "Edit")]: "Правка",
      "Quit {app}": "Завершить {app}",
      [UPDATES]: "Проверить обновления…",
    });
    const menu = template("darwin");
    assert.ok(findItem(menu, "Правка"));
    assert.ok(findItem(menu, "Завершить Genex"));
    assert.ok(findItem(menu, "Проверить обновления…"));
    setLocale(Locale.English, {});
    assert.ok(findItem(template("darwin"), "Edit"));
  });
});

describe("macOS's Edit menu", () => {
  it("titles macOS's Edit menu in the Mac's own word, which macOS finds it by to add Dictation and Emoji & Symbols", () => {
    const edit = (macLanguage: Locale) =>
      appMenuTemplate({ platform: "darwin", appName: "Genex", checkForUpdates: () => {}, macLanguage })[2]?.label;
    setLocale(Locale.Japanese, { [messageKey("menu", "Edit")]: "編集" });
    assert.equal(edit(Locale.English), "Edit", "Genex in Japanese on an English Mac");
    assert.equal(edit(Locale.Japanese), "編集");
    setLocale(Locale.English, {});
    const macWords: Array<[Locale, string]> = [
      [Locale.Russian, "Правка"],
      [Locale.Spanish, "Edición"],
      [Locale.PortugueseBrazil, "Editar"],
      [Locale.German, "Bearbeiten"],
      [Locale.French, "Édition"],
      [Locale.Japanese, "編集"],
      [Locale.Korean, "편집"],
      [Locale.ChineseSimplified, "编辑"],
    ];
    for (const [mac, word] of macWords) assert.equal(edit(mac), word, mac);
    const windows = appMenuTemplate({
      platform: "win32",
      appName: "Genex",
      checkForUpdates: () => {},
      macLanguage: Locale.Japanese,
    });
    assert.equal(windows[1]?.label, "Edit", "elsewhere the menu speaks the app's language");
  });
});

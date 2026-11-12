/**
 * The studio window's right-click menu: Copy Image on a picture copies the picture under the
 * click, a field gets its editing items as the field allows, selected text gets Copy, and a
 * click on nothing actionable opens no menu.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { MenuItemConstructorOptions } from "electron";
import { type ContextMenuFacts, ContextMenuItem, contextMenuTemplate } from "../../src/main/context-menu.ts";
import { setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";

afterEach(() => setLocale(Locale.English, {}));

const NO_EDITS = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: false,
  canEditRichly: false,
};

function facts(over: Partial<ContextMenuFacts> = {}): ContextMenuFacts {
  return {
    x: 140,
    y: 90,
    mediaType: "none",
    hasImageContents: false,
    isEditable: false,
    selectionText: "",
    editFlags: NO_EDITS,
    ...over,
  };
}

/** A page that records where Copy Image copied from. */
function page() {
  const copied: Array<[number, number]> = [];
  return { copied, copyImageAt: (x: number, y: number) => void copied.push([x, y]) };
}

const ids = (items: readonly MenuItemConstructorOptions[]): Array<string | undefined> =>
  items.map((item) => (item.type === "separator" ? "-" : item.id));

describe("the window's right-click menu", () => {
  it("offers Copy Image on a picture, and copies the picture under the click", () => {
    const at = page();
    const items = contextMenuTemplate(facts({ mediaType: "image", hasImageContents: true }), at);
    assert.deepEqual(ids(items), [ContextMenuItem.CopyImage]);
    assert.equal(items[0]?.label, "Copy Image");
    items[0]?.click?.({} as never, undefined, {} as never);
    assert.deepEqual(at.copied, [[140, 90]]);
  });

  it("offers nothing for a picture that has not loaded, or a click on nothing", () => {
    assert.deepEqual(contextMenuTemplate(facts({ mediaType: "image", hasImageContents: false }), page()), []);
    assert.deepEqual(contextMenuTemplate(facts(), page()), []);
    assert.deepEqual(contextMenuTemplate(facts({ selectionText: "  \n" }), page()), []);
  });

  it("gives a field Cut, Copy, Paste and Select All, each enabled as the field allows", () => {
    const items = contextMenuTemplate(
      facts({ isEditable: true, editFlags: { ...NO_EDITS, canPaste: true, canSelectAll: true } }),
      page(),
    );
    assert.deepEqual(ids(items), [
      ContextMenuItem.Cut,
      ContextMenuItem.Copy,
      ContextMenuItem.Paste,
      "-",
      ContextMenuItem.SelectAll,
    ]);
    assert.deepEqual(
      items.filter((item) => item.type !== "separator").map((item) => [item.role, item.enabled]),
      [
        ["cut", false],
        ["copy", false],
        ["paste", true],
        ["selectAll", true],
      ],
    );
  });

  it("gives selected text Copy, after Copy Image when the selection covers a picture", () => {
    assert.deepEqual(ids(contextMenuTemplate(facts({ selectionText: "a reply" }), page())), [ContextMenuItem.Copy]);
    const both = contextMenuTemplate(
      facts({ mediaType: "image", hasImageContents: true, selectionText: "a reply" }),
      page(),
    );
    assert.deepEqual(ids(both), [ContextMenuItem.CopyImage, "-", ContextMenuItem.Copy]);
  });

  it("speaks the app's language", () => {
    setLocale(Locale.Russian, { "Copy Image": "Скопировать изображение" });
    const items = contextMenuTemplate(facts({ mediaType: "image", hasImageContents: true }), page());
    assert.equal(items[0]?.label, "Скопировать изображение");
  });
});

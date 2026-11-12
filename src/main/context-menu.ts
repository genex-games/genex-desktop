/**
 * The studio window's right-click menu, which Electron leaves empty: Copy Image on any picture
 * (a chat's, an asset's, a lightbox's), Copy on selected text, and Cut, Copy, Paste and Select All
 * in a field. Anywhere else a right-click opens nothing. A plain function of what the click landed
 * on, so its items are tested without Electron; main pops it up (`offerContextMenu`).
 */
import type { ContextMenuParams, MenuItemConstructorOptions, WebContents } from "electron";
import { t } from "../shared/i18n.ts";

/** What a right-click landed on, as Electron's `context-menu` event reports it. */
export type ContextMenuFacts = Pick<
  ContextMenuParams,
  "x" | "y" | "mediaType" | "hasImageContents" | "isEditable" | "selectionText" | "editFlags"
>;

/** What the menu does to the page it opened on. */
export type ContextMenuPage = Pick<WebContents, "copyImageAt">;

/** The menu's items, by the `id` each carries. */
export const ContextMenuItem = {
  CopyImage: "copy-image",
  Cut: "cut",
  Copy: "copy",
  Paste: "paste",
  SelectAll: "select-all",
} as const;
export type ContextMenuItem = (typeof ContextMenuItem)[keyof typeof ContextMenuItem];

const SEPARATOR: MenuItemConstructorOptions = { type: "separator" };

/** A picture with its pixels loaded: Copy Image puts them on the clipboard. */
const onPicture = (facts: ContextMenuFacts): boolean => facts.mediaType === "image" && facts.hasImageContents;

function pictureItems(facts: ContextMenuFacts, page: ContextMenuPage): MenuItemConstructorOptions[] {
  if (!onPicture(facts)) return [];
  return [{ id: ContextMenuItem.CopyImage, label: t("Copy Image"), click: () => page.copyImageAt(facts.x, facts.y) }];
}

/** A field's editing items, each enabled as the field allows; selected text elsewhere can only be copied. */
function textItems(facts: ContextMenuFacts): MenuItemConstructorOptions[] {
  const flags = facts.editFlags;
  if (facts.isEditable)
    return [
      { id: ContextMenuItem.Cut, role: "cut", label: t("Cut"), enabled: flags.canCut },
      { id: ContextMenuItem.Copy, role: "copy", label: t("Copy"), enabled: flags.canCopy },
      { id: ContextMenuItem.Paste, role: "paste", label: t("Paste"), enabled: flags.canPaste },
      SEPARATOR,
      { id: ContextMenuItem.SelectAll, role: "selectAll", label: t("Select All"), enabled: flags.canSelectAll },
    ];
  if (facts.selectionText.trim()) return [{ id: ContextMenuItem.Copy, role: "copy", label: t("Copy") }];
  return [];
}

/** The menu for a right-click at `facts`; empty when nothing there has an action. */
export function contextMenuTemplate(facts: ContextMenuFacts, page: ContextMenuPage): MenuItemConstructorOptions[] {
  const picture = pictureItems(facts, page);
  const text = textItems(facts);
  if (picture.length && text.length) return [...picture, SEPARATOR, ...text];
  return [...picture, ...text];
}

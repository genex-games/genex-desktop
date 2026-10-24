/**
 * Folder labels and shortcut hints on Windows: main writes a folder's label in the host's spelling
 * (`~\AI Games`, `D:\Games\rift`), and the app's shortcuts are written in the Mac's glyphs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { besideName } from "../../src/renderer/open-beside.ts";
import { shortcutKeys } from "../../src/renderer/shortcut-keys.ts";
import { homePath, lastTwoParts, pathLeaf, pathParts } from "../../src/shared/path-label.ts";

describe("a folder's label on either platform", () => {
  it("names a folder by its last part", () => {
    const cases: Array<[string, string]> = [
      ["~/AI Games", "AI Games"],
      ["~/AI Games/", "AI Games"],
      ["~\\AI Games", "AI Games"],
      ["D:\\Games\\rift\\", "rift"],
      ["C:\\", "C:"],
      ["AI Games", "AI Games"],
    ];
    for (const [label, leaf] of cases) assert.equal(pathLeaf(label), leaf, label);
  });

  it("splits a label into its parent and its own folder", () => {
    assert.deepEqual(pathParts("~/AI Games"), { parent: "~/", leaf: "AI Games" });
    assert.deepEqual(pathParts("~\\AI Games"), { parent: "~\\", leaf: "AI Games" });
    assert.deepEqual(pathParts("D:\\Games\\rift\\"), { parent: "D:\\Games\\", leaf: "rift" });
    assert.deepEqual(pathParts("AI Games"), { parent: "", leaf: "AI Games" });
  });

  it("keeps a game's last two folders, never the whole Windows path", () => {
    assert.equal(lastTwoParts("C:\\Users\\ana\\AI Games\\rift"), "AI Games/rift");
    assert.equal(lastTwoParts("/Users/ana/AI Games/rift"), "AI Games/rift");
  });

  it("writes a person's home as ~ in every spelling", () => {
    const cases: Array<[string, string]> = [
      ["/Users/ana/refs", "~/refs"],
      ["/home/ana", "~"],
      ["C:\\Users\\ana\\refs", "~\\refs"],
      ["c:/Users/ana/refs", "~/refs"],
      ["/c/Users/ana/refs", "~/refs"],
      ["D:\\Games\\refs", "D:\\Games\\refs"],
      ["/Users", "/Users"],
    ];
    for (const [path, words] of cases) assert.equal(homePath(path), words, path);
  });

  it("names a file opened beside the chat by its own name", () => {
    assert.equal(besideName({ kind: "file", path: "C:\\Users\\ana\\AI Games\\rift\\NOTES.md" }), "NOTES.md");
    assert.equal(besideName({ kind: "file", path: "/Users/ana/AI Games/rift/NOTES.md" }), "NOTES.md");
  });
});

describe("a shortcut hint on either platform", () => {
  it("keeps the Mac's glyphs on the Mac and before main answers", () => {
    assert.equal(shortcutKeys("⌘B", "darwin"), "⌘B");
    assert.equal(shortcutKeys("⌥⌘M", ""), "⌥⌘M");
  });

  it("reads Ctrl, Alt and Shift off the Mac, as the handlers take them", () => {
    const cases: Array<[string, string]> = [
      ["⌘B", "Ctrl+B"],
      ["⌘K", "Ctrl+K"],
      ["⌘2", "Ctrl+2"],
      ["⌘`", "Ctrl+`"],
      ["⌥⌘M", "Ctrl+Alt+M"],
      ["⇧⌘Z", "Ctrl+Shift+Z"],
      ["↵", "↵"],
      ["esc", "esc"],
    ];
    for (const [mac, windows] of cases) {
      assert.equal(shortcutKeys(mac, "win32"), windows, mac);
      assert.equal(shortcutKeys(mac, "linux"), windows, mac);
    }
  });
});

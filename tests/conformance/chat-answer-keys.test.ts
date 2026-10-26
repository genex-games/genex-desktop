/**
 * The keys that press a waiting card's recommended answer: ⌘↩ on a Mac, Ctrl+Enter elsewhere, and
 * no other press, so plain Enter stays the composer's send.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerKeys, pressesAnswer } from "../../src/renderer/chat/answer-keys.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";

const enter = { key: "Enter" };

describe("a waiting card's recommended answer", () => {
  it("takes ⌘↩ on a Mac and Ctrl+Enter elsewhere, and nothing else", () => {
    const rows: Array<[string, string, Parameters<typeof pressesAnswer>[0], boolean]> = [
      ["⌘↩ on a Mac", StudioPlatform.Mac, { ...enter, metaKey: true }, true],
      ["Ctrl+Enter on a Mac", StudioPlatform.Mac, { ...enter, ctrlKey: true }, false],
      ["plain Enter (the composer's send)", StudioPlatform.Mac, enter, false],
      ["⇧⌘↩", StudioPlatform.Mac, { ...enter, metaKey: true, shiftKey: true }, false],
      ["⌥⌘↩", StudioPlatform.Mac, { ...enter, metaKey: true, altKey: true }, false],
      ["⌘↩ while an input method composes", StudioPlatform.Mac, { ...enter, metaKey: true, isComposing: true }, false],
      ["a held ⌘↩ repeating", StudioPlatform.Mac, { ...enter, metaKey: true, repeat: true }, false],
      ["⌘A", StudioPlatform.Mac, { key: "a", metaKey: true }, false],
      ["Ctrl+Enter on Windows", StudioPlatform.Windows, { ...enter, ctrlKey: true }, true],
      ["Win+Enter on Windows", StudioPlatform.Windows, { ...enter, metaKey: true }, false],
      ["Ctrl+Enter on Linux", StudioPlatform.Linux, { ...enter, ctrlKey: true }, true],
      ["Ctrl+Enter before main named the system", "", { ...enter, ctrlKey: true }, true],
    ];
    for (const [name, platform, press, expected] of rows) assert.equal(pressesAnswer(press, platform), expected, name);
  });

  it("shows those keys on the button and names them for assistive tech", () => {
    assert.deepEqual(answerKeys(StudioPlatform.Mac), { caps: ["⌘", "↩"], aria: "Meta+Enter" });
    assert.deepEqual(answerKeys(StudioPlatform.Windows), { caps: ["Ctrl", "↵"], aria: "Control+Enter" });
  });
});

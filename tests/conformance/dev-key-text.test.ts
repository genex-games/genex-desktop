/**
 * The developer control's `key` presses one key the way Chromium needs to see it: a printable
 * character carries its text, so it types into whatever has focus, including a plugin panel's frame
 * that selectors can't reach; named keys and shortcuts type nothing.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import type { WebContents } from "electron";
import { DesktopControl } from "../../src/main/dev/control.ts";

function recorder() {
  const sent: Array<Record<string, unknown>> = [];
  let attached = false;
  const wc = {
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      sendCommand: async (_method: string, params: Record<string, unknown>) => {
        sent.push(params);
        return {};
      },
    },
  } as unknown as WebContents;
  return { wc, sent };
}

it("a printable key types its character; named keys and shortcuts type nothing", async () => {
  const control = new DesktopControl();
  const cases: Array<[{ key: string; code: string; modifiers?: string[] }, string | undefined]> = [
    [{ key: "L", code: "KeyL" }, "L"],
    [{ key: "a", code: "KeyA" }, "a"],
    [{ key: "7", code: "Digit7" }, "7"],
    [{ key: "Enter", code: "Enter" }, "\r"],
    [{ key: "Tab", code: "Tab" }, undefined],
    [{ key: "a", code: "KeyA", modifiers: ["Meta"] }, undefined],
  ];
  for (const [params, text] of cases) {
    const { wc, sent } = recorder();
    await control.key(wc, params);
    const down = sent.find((p) => p.type === "keyDown");
    assert.equal(down?.text, text, JSON.stringify(params));
  }
});

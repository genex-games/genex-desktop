/**
 * The studio window beside a game engine's editor: after the Genex button in the editor it becomes
 * a small chat that stays above other windows at the right edge of its screen, and the full window
 * comes back where and as large as it was.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BESIDE_WINDOW,
  besideBounds,
  besideWindow,
  type BesideWindowHost,
  type WindowBounds,
} from "../../src/main/beside-window.ts";

const FULL_MINIMUM = { minWidth: 1080, minHeight: 680 };
const SCREEN: WindowBounds = { x: 0, y: 25, width: 1728, height: 1055 };

/** A window that records what is done to it, on `area`. */
function fakeWindow(
  start: WindowBounds,
  state: { maximized?: boolean; fullScreen?: boolean; area?: WindowBounds } = {},
) {
  let bounds = start;
  let maximized = state.maximized ?? false;
  const calls: string[] = [];
  const host: BesideWindowHost = {
    getBounds: () => bounds,
    setBounds: (next) => {
      bounds = next;
      calls.push(`bounds ${next.x},${next.y} ${next.width}x${next.height}`);
    },
    setMinimumSize: (width, height) => void calls.push(`minimum ${width}x${height}`),
    setAlwaysOnTop: (on) => void calls.push(`on top ${on}`),
    isMaximized: () => maximized,
    unmaximize: () => {
      maximized = false;
      calls.push("unmaximize");
    },
    isFullScreen: () => state.fullScreen ?? false,
    workArea: () => state.area ?? SCREEN,
  };
  return { host, calls, bounds: () => bounds };
}

describe("the studio window beside an editor", () => {
  it("becomes a small chat above other windows at the right edge of its screen", () => {
    const window = fakeWindow({ x: 100, y: 80, width: 1440, height: 900 });
    const beside = besideWindow(FULL_MINIMUM);
    beside.set(window.host, true);
    assert.equal(beside.on(), true);
    assert.deepEqual(window.bounds(), {
      x: 1728 - 420 - 16,
      y: 25 + Math.round((1055 - 760) / 2),
      width: 420,
      height: 760,
    });
    assert.deepEqual(window.calls, ["minimum 360x480", "bounds 1292,173 420x760", "on top true"]);
  });

  it("goes back to the size and place it had, no longer above other windows", () => {
    const start = { x: 100, y: 80, width: 1440, height: 900 };
    const window = fakeWindow(start);
    const beside = besideWindow(FULL_MINIMUM);
    beside.set(window.host, true);
    window.calls.length = 0;
    beside.set(window.host, false);
    assert.equal(beside.on(), false);
    assert.deepEqual(window.bounds(), start);
    assert.deepEqual(window.calls, ["on top false", "minimum 1080x680", "bounds 100,80 1440x900"]);
  });

  it("does nothing when asked for the shape it already has", () => {
    const window = fakeWindow({ x: 100, y: 80, width: 1440, height: 900 });
    const beside = besideWindow(FULL_MINIMUM);
    beside.set(window.host, false);
    assert.deepEqual(window.calls, [], "already full");
    beside.set(window.host, true);
    window.calls.length = 0;
    beside.set(window.host, true);
    assert.deepEqual(window.calls, [], "already small: the full shape it remembers is not lost");
    beside.set(window.host, false);
    assert.deepEqual(window.bounds(), { x: 100, y: 80, width: 1440, height: 900 });
  });

  it("leaves a maximized window's zoom first, and comes back to the unzoomed shape", () => {
    const window = fakeWindow({ x: 0, y: 25, width: 1728, height: 1055 }, { maximized: true });
    const beside = besideWindow(FULL_MINIMUM);
    beside.set(window.host, true);
    assert.equal(window.calls[0], "unmaximize");
    assert.equal(beside.on(), true);
  });

  it("stays as it is in full screen", () => {
    const window = fakeWindow({ x: 0, y: 0, width: 1728, height: 1117 }, { fullScreen: true });
    const beside = besideWindow(FULL_MINIMUM);
    beside.set(window.host, true);
    assert.equal(beside.on(), false);
    assert.deepEqual(window.calls, []);
  });

  it("opens full after its window closed while small", () => {
    const window = fakeWindow({ x: 100, y: 80, width: 1440, height: 900 });
    const beside = besideWindow(FULL_MINIMUM);
    beside.set(window.host, true);
    beside.forget();
    assert.equal(beside.on(), false);
    const next = fakeWindow({ x: 100, y: 80, width: 1440, height: 900 });
    beside.set(next.host, false);
    assert.deepEqual(next.calls, [], "a new window is not moved to the closed one's place");
  });

  it("fits a small or second screen: inside its work area, never under the smallest it can be dragged to", () => {
    const second: WindowBounds = { x: -1280, y: 0, width: 1280, height: 720 };
    assert.deepEqual(besideBounds(second), { x: -1280 + 1280 - 420 - 16, y: 16, width: 420, height: 688 });
    const tiny = besideBounds({ x: 0, y: 0, width: 300, height: 400 });
    assert.deepEqual([tiny.width, tiny.height], [BESIDE_WINDOW.minWidth, BESIDE_WINDOW.minHeight]);
  });
});

/**
 * The studio window's title bar by platform. macOS keeps its inset traffic lights, in line with the
 * headers; Windows and
 * Linux get a hidden title bar with the system's minimise, maximise and close drawn as an overlay
 * the height of the app's headers, so a frameless window never loses its controls. On Windows the
 * overlay paints no box of its own while Home's background lies under it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type OverlayWindow,
  TITLEBAR_HEIGHT,
  type TitleBarOverlay,
  windowChrome,
  windowControlsPainter,
} from "../../src/main/window-chrome.ts";

const LIGHT = { color: "#fafafa", symbolColor: "#111111" };
const ON_HOME = { ...LIGHT, seeThrough: true };
const ELSEWHERE = { ...LIGHT, seeThrough: false };
const FILLED: TitleBarOverlay = { color: "#fafafa", symbolColor: "#111111", height: TITLEBAR_HEIGHT };
const SEE_THROUGH: TitleBarOverlay = { color: "rgba(0, 0, 0, 0)", symbolColor: "#111111", height: TITLEBAR_HEIGHT };

/** A studio window that records each repaint of its controls. */
function stubWindow(): OverlayWindow & { painted: TitleBarOverlay[]; destroyed: boolean } {
  const stub = {
    painted: [] as TitleBarOverlay[],
    destroyed: false,
    isDestroyed: () => stub.destroyed,
    setTitleBarOverlay: (options: TitleBarOverlay) => void stub.painted.push(options),
  };
  return stub;
}

describe("window chrome", () => {
  it("macOS keeps the inset traffic lights, centred on the headers' line, and no overlay", () => {
    const chrome = windowChrome("darwin");
    assert.equal(chrome.titleBarStyle, "hiddenInset");
    assert.ok("trafficLightPosition" in chrome, "the lights are placed, not left where AppKit puts them");
    // The lights are 14pt circles; their centre is half the header's height down.
    assert.equal(chrome.trafficLightPosition.y + 7, TITLEBAR_HEIGHT / 2);
    assert.equal(chrome.trafficLightPosition.x, 12, "as far from the left edge as AppKit's inset puts them");
    assert.ok(!("titleBarOverlay" in chrome));
  });

  for (const platform of ["win32", "linux"]) {
    it(`${platform} opens with the window controls filled over a hidden title bar, as tall as the headers`, () => {
      const chrome = windowChrome(platform);
      assert.equal(chrome.titleBarStyle, "hidden");
      assert.ok(typeof chrome.titleBarOverlay === "object", "an overlay, not a bare flag");
      assert.equal(chrome.titleBarOverlay.height, TITLEBAR_HEIGHT);
      assert.match(chrome.titleBarOverlay.color ?? "", /^#[0-9a-f]{6}$/i);
      assert.match(chrome.titleBarOverlay.symbolColor ?? "", /^#[0-9a-f]{6}$/i);
    });
  }

  it("on Windows the controls' box is see-through only while Home's background lies under it", () => {
    const painter = windowControlsPainter("win32");
    const window = stubWindow();
    painter.paint(window, ON_HOME);
    painter.paint(window, ELSEWHERE);
    painter.paint(window, ON_HOME);
    assert.deepEqual(window.painted, [SEE_THROUGH, FILLED, SEE_THROUGH]);
  });

  it("Linux keeps the box filled with the theme's canvas, on Home too", () => {
    const painter = windowControlsPainter("linux");
    const window = stubWindow();
    painter.paint(window, ON_HOME);
    painter.paint(window, ELSEWHERE);
    assert.deepEqual(window.painted, [FILLED, FILLED]);
  });

  it("macOS draws its own lights: nothing is repainted", () => {
    const window = stubWindow();
    windowControlsPainter("darwin").paint(window, ON_HOME);
    assert.deepEqual(window.painted, []);
  });

  it("a window opened later takes the controls last sent; a closed one is left alone", () => {
    const painter = windowControlsPainter("win32");
    const closed = stubWindow();
    closed.destroyed = true;
    painter.paint(closed, ON_HOME);
    painter.paint(null, ON_HOME);
    assert.deepEqual(closed.painted, []);
    assert.deepEqual(painter.chrome(), { titleBarStyle: "hidden", titleBarOverlay: SEE_THROUGH });
  });
});

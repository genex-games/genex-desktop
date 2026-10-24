/**
 * The Live game's full screen: the window goes full screen with the game over all of it and a
 * small exit button in the top-right corner, which folds to its icon after a moment. Holding Esc
 * ends it (a tap still reaches the game), as does the button or the window leaving full screen
 * any other way.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ESC_HOLD_MS,
  EXIT_BUTTON,
  EXIT_FOLDED_AFTER_MS,
  type FullScreenDeps,
  gameFullScreen,
  liveFullScreens,
  nativeCanvasGame,
  type Rect,
} from "../../src/main/game-full-screen.ts";

function rig({ windowFull = false } = {}) {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const log: string[] = [];
  const state = {
    windowFull,
    fill: null as Rect | null,
    exit: null as Rect | null,
    focused: false,
  };
  const screen = gameFullScreen({
    window: {
      isFullScreen: () => state.windowFull,
      setFullScreen: (on) => {
        state.windowFull = on;
        log.push(`window ${on ? "full" : "windowed"}`);
      },
      contentSize: () => ({ width: 1440, height: 900 }),
    },
    game: {
      fill: (bounds) => {
        state.fill = bounds;
      },
      focus: () => {
        state.focused = true;
      },
    },
    exitButton: {
      show: (bounds) => {
        state.exit = bounds;
      },
      hide: () => {
        state.exit = null;
      },
    },
    stage: {
      cover: () => log.push("stage covered"),
      restore: () => log.push("stage restored"),
    },
    clock: {
      setTimeout: (fn, ms) => {
        const id = next++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id as number);
      },
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.fn();
    }
  };
  const esc = (type: "keyDown" | "keyUp", isAutoRepeat = false) => screen.key({ type, key: "Escape", isAutoRepeat });
  return { screen, state, log, advance, esc };
}

const WIDE: Rect = {
  x: 1440 - EXIT_BUTTON.margin - EXIT_BUTTON.wide,
  y: EXIT_BUTTON.margin,
  width: EXIT_BUTTON.wide,
  height: EXIT_BUTTON.height,
};
const FOLDED: Rect = {
  x: 1440 - EXIT_BUTTON.margin - EXIT_BUTTON.height,
  y: EXIT_BUTTON.margin,
  width: EXIT_BUTTON.height,
  height: EXIT_BUTTON.height,
};

describe("the game's full screen", () => {
  it("fills the window with the game and shows the exit button, unfolded, top right", () => {
    const { screen, state, log } = rig();
    screen.enter();
    assert.equal(screen.active(), true);
    assert.equal(state.windowFull, true);
    assert.deepEqual(state.fill, { x: 0, y: 0, width: 1440, height: 900 });
    assert.deepEqual(state.exit, WIDE);
    assert.equal(state.focused, true, "the game has the keyboard, so held Esc reaches main");
    assert.deepEqual(log, ["window full", "stage covered"]);
  });

  it("folds the exit button to its icon at the same right edge after a moment", () => {
    const { screen, state, advance } = rig();
    screen.enter();
    advance(EXIT_FOLDED_AFTER_MS - 1);
    assert.deepEqual(state.exit, WIDE);
    advance(1);
    assert.deepEqual(state.exit, FOLDED);
  });

  it("ends when Esc is held, and a tap is left to the game", () => {
    const { screen, state, log, advance, esc } = rig();
    screen.enter();
    esc("keyDown");
    advance(ESC_HOLD_MS - 1);
    esc("keyUp");
    advance(ESC_HOLD_MS);
    assert.equal(screen.active(), true, "a tap does not end it");
    esc("keyDown");
    advance(ESC_HOLD_MS / 2);
    esc("keyDown", true);
    advance(ESC_HOLD_MS / 2);
    assert.equal(screen.active(), false, "a key's own repeats do not restart the hold");
    assert.equal(state.windowFull, false);
    assert.equal(state.fill, null);
    assert.equal(state.exit, null);
    assert.deepEqual(log.slice(-2), ["stage restored", "window windowed"]);
  });

  it("ends from its button, and leaves a window that was already full screen as it was", () => {
    const { screen, state, log } = rig({ windowFull: true });
    screen.enter();
    screen.exit();
    assert.equal(state.windowFull, true);
    assert.deepEqual(log, ["stage covered", "stage restored"]);
  });

  it("ends when the window leaves full screen on its own", () => {
    const { screen, state, log } = rig();
    screen.enter();
    state.windowFull = false;
    screen.windowLeft();
    assert.equal(screen.active(), false);
    assert.equal(state.fill, null);
    assert.deepEqual(log, ["window full", "stage covered", "stage restored"]);
  });

  it("follows the window's size, ignores Esc when it is not on, and enters once", () => {
    const { screen, state, log, advance, esc } = rig();
    esc("keyDown");
    advance(ESC_HOLD_MS);
    assert.deepEqual(log, []);
    screen.enter();
    screen.enter();
    assert.deepEqual(log, ["window full", "stage covered"]);
    state.fill = null;
    screen.resized();
    assert.deepEqual(state.fill, { x: 0, y: 0, width: 1440, height: 900 });
  });
});

/** Live's two full screens over one window and one clock: the web view's, and the Native canvas's in the studio's page. */
function liveRig() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const log: string[] = [];
  const window = { full: false };
  const shared: Omit<FullScreenDeps, "game" | "stage"> = {
    window: {
      isFullScreen: () => window.full,
      setFullScreen: (on) => {
        window.full = on;
      },
      contentSize: () => ({ width: 1440, height: 900 }),
    },
    exitButton: { show: () => {}, hide: () => {} },
    clock: {
      setTimeout: (fn, ms) => {
        const id = next++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id as number);
      },
    },
  };
  const none = { cover: () => {}, restore: () => {} };
  const web = gameFullScreen({
    ...shared,
    game: { fill: (bounds) => log.push(bounds ? "web fills" : "web back"), focus: () => {} },
    stage: none,
  });
  const native = gameFullScreen({
    ...shared,
    game: nativeCanvasGame({
      emit: (on) => log.push(`native.full-screen ${on}`),
      focus: () => log.push("page focused"),
    }),
    stage: none,
  });
  const screens = liveFullScreens({ web, native });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.fn();
    }
  };
  return { screens, log, window, advance };
}

describe("Live's Native view in full screen", () => {
  it("fills the window with the Native canvas: the page is told it covers the window and keeps the keyboard", () => {
    const { screens, log, window } = liveRig();
    screens.enter({ native: true });
    assert.equal(window.full, true);
    assert.equal(screens.nativeActive(), true);
    assert.equal(screens.active(), false, "the web view's slot is still the page's to place");
    assert.deepEqual(log.slice(0, 2), ["native.full-screen true", "page focused"]);
  });

  it("ends as the web view's does: a held Esc, never a tap, which stays the game's (pointer lock)", () => {
    const { screens, log, window, advance } = liveRig();
    screens.enter({ native: true });
    screens.key({ type: "keyDown", key: "Escape", isAutoRepeat: false });
    screens.key({ type: "keyUp", key: "Escape", isAutoRepeat: false });
    advance(ESC_HOLD_MS);
    assert.equal(screens.nativeActive(), true, "a tap leaves full screen on");
    screens.key({ type: "keyDown", key: "Escape", isAutoRepeat: false });
    advance(ESC_HOLD_MS);
    assert.equal(screens.nativeActive(), false);
    assert.equal(window.full, false);
    assert.equal(log.at(-1), "native.full-screen false");
  });

  it("is one at a time: entering one view's full screen ends the other's", () => {
    const { screens, log } = liveRig();
    screens.enter({ native: false });
    screens.enter({ native: true });
    assert.equal(screens.active(), false);
    assert.equal(screens.nativeActive(), true);
    assert.deepEqual(log.slice(0, 2), ["web fills", "web back"]);
  });

  it("follows the window: a resize fills again, and the window leaving full screen ends it", () => {
    const { screens, log } = liveRig();
    screens.enter({ native: true });
    screens.resized();
    assert.equal(log.filter((line) => line === "native.full-screen true").length, 2);
    screens.windowLeft();
    assert.equal(screens.nativeActive(), false);
    assert.equal(log.at(-1), "native.full-screen false");
  });
});

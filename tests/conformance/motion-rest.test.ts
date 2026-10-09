/**
 * Ambient motion rests while nobody is looking: an endless "working" animation keeps
 * Chromium drawing every frame, which held a fixture build at ~15% CPU in the background. The
 * studio's endless animations run only while its window is in front and someone touched it lately.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { Motion, type MotionClock, type MotionDocument, watchMotion } from "../../src/renderer/motion-rest.ts";

/** A window and document whose focus, visibility, input and time a test drives. */
function stage(options: { focused?: boolean; visible?: boolean } = {}) {
  let now = 0;
  let focused = options.focused ?? true;
  let visibility: DocumentVisibilityState = options.visible === false ? "hidden" : "visible";
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 1;
  const listeners = new Map<string, Set<() => void>>();
  const on = (type: string, listener: () => void) => {
    const set = listeners.get(type) ?? new Set();
    set.add(listener);
    listeners.set(type, set);
  };
  const off = (type: string, listener: () => void) => listeners.get(type)?.delete(listener);
  const fire = (type: string) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener();
  };
  const target = { addEventListener: on, removeEventListener: off };
  const doc: MotionDocument = {
    ...target,
    hasFocus: () => focused,
    get visibilityState() {
      return visibility;
    },
  };
  const clock: MotionClock = {
    now: () => now,
    setTimeout: (run, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (id) => {
      if (id !== undefined) timers.delete(id);
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = until;
  };
  const seen: Motion[] = [];
  const stop = watchMotion(target, doc, clock, (motion) => seen.push(motion));
  return {
    seen,
    stop,
    advance,
    listening: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    pendingTimers: () => timers.size,
    input: (type = "pointermove") => fire(type),
    blur: () => {
      focused = false;
      fire("blur");
    },
    focus: () => {
      focused = true;
      fire("focus");
    },
    hide: () => {
      visibility = "hidden";
      fire("visibilitychange");
    },
    show: () => {
      visibility = "visible";
      fire("visibilitychange");
    },
  };
}

describe("ambient motion", () => {
  it("runs in a focused, visible window someone is using", () => {
    const s = stage();
    s.advance(MINUTE_MS);
    assert.deepEqual(s.seen, [Motion.Live]);
  });

  it("rests at once when the window goes to the background, and runs again in front", () => {
    const s = stage();
    s.blur();
    assert.equal(s.seen.at(-1), Motion.Rest);
    s.focus();
    assert.equal(s.seen.at(-1), Motion.Live);
  });

  it("rests while the window is hidden, whatever its focus", () => {
    const s = stage();
    s.hide();
    assert.equal(s.seen.at(-1), Motion.Rest);
    s.input("keydown");
    assert.equal(s.seen.at(-1), Motion.Rest);
    s.show();
    assert.equal(s.seen.at(-1), Motion.Live);
  });

  it("rests after two untouched minutes in front, and wakes on the next input", () => {
    const s = stage();
    s.advance(2 * MINUTE_MS - 1);
    assert.equal(s.seen.at(-1), Motion.Live);
    s.advance(1);
    assert.equal(s.seen.at(-1), Motion.Rest);
    s.input("wheel");
    assert.equal(s.seen.at(-1), Motion.Live);
  });

  it("counts every input as someone looking, so a busy pointer keeps it running", () => {
    const s = stage();
    for (let i = 0; i < 10; i++) {
      s.advance(MINUTE_MS);
      s.input();
    }
    assert.deepEqual(s.seen, [Motion.Live]);
    assert.equal(s.pendingTimers(), 1);
  });

  it("starts at rest in a window that opens in the background", () => {
    const s = stage({ focused: false });
    assert.deepEqual(s.seen, [Motion.Rest]);
  });

  it("leaves no listener or timer behind once stopped", () => {
    const s = stage();
    s.stop();
    assert.equal(s.listening(), 0);
    assert.equal(s.pendingTimers(), 0);
  });
});

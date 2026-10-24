/**
 * Play's cover clips, as genex.games plays them: the first row of the dashboard's Games feed plays
 * its clips by itself, at most MAX_TOP_ROW_CLIPS at a time and one hover anywhere besides. A top-row
 * clip starts only once its cover has decoded, the page has had an idle moment, its stagger has
 * passed, it is at least half in view and the window shows; below half in view it holds, and out
 * of view for CLIP_RELEASE_MS it lets its decoder go. Reduce Motion plays nothing, a failed clip is
 * never tried again, a refused play() stops them all, and the row's pause (remembered in storage)
 * stops them too. A hover waits out its dwell, and a stale release never evicts the card the
 * pointer moved on to. The store is driven here through its injected clock, observer and storage.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLIP_HOVER_DELAY_MS,
  CLIP_REVEAL_FLOOR_MS,
  CLIP_RELEASE_MS,
  CLIP_STAGGER_MS,
  type ClipObserverEntry,
  ClipState,
  createClipPlayback,
  gridColumns,
  MAX_TOP_ROW_CLIPS,
  revealWait,
  topRowClip,
} from "../../src/renderer/play/clip-playback.ts";
import { type KeyValueStorage, STORAGE_KEYS } from "../../src/renderer/storage.ts";

/** A clock only the test moves: timers fire in order as `advance` passes them. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number): unknown {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle: unknown): void {
      timers.delete(handle as number);
    },
    advance(ms: number): void {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

/** One observer the test reports intersections through; it counts how many were made. */
function fakeObserver() {
  let made = 0;
  let report: ((entries: readonly ClipObserverEntry[]) => void) | null = null;
  const watched = new Set<Element>();
  return {
    factory(onChange: (entries: readonly ClipObserverEntry[]) => void) {
      made += 1;
      report = onChange;
      return {
        observe: (el: Element) => void watched.add(el),
        unobserve: (el: Element) => void watched.delete(el),
        disconnect: () => watched.clear(),
      };
    },
    made: () => made,
    watched,
    see(el: Element, ratio: number): void {
      report?.([{ target: el, isIntersecting: ratio > 0, intersectionRatio: ratio }]);
    },
  };
}

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

const throwingStorage: KeyValueStorage = {
  getItem: () => {
    throw new Error("locked");
  },
  setItem: () => {
    throw new Error("locked");
  },
  removeItem: () => {
    throw new Error("locked");
  },
};

/** A store with motion allowed and the window showing; `settle()` fires the idle moment. */
function rig(options: { storage?: KeyValueStorage | null } = {}) {
  const clock = fakeClock();
  const io = fakeObserver();
  const idles: (() => void)[] = [];
  const storage = options.storage === undefined ? memoryStorage() : options.storage;
  const store = createClipPlayback({
    clock,
    storage: () => storage,
    observer: (onChange) => io.factory(onChange),
    idle: (fn) => {
      idles.push(fn);
      return () => {
        const at = idles.indexOf(fn);
        if (at >= 0) idles.splice(at, 1);
      };
    },
  });
  store.setSignals({ reducedMotion: false, visible: true, covered: false });
  const settle = () => {
    for (const fn of idles.splice(0)) fn();
  };
  /** A top-row card whose cover has decoded, half in view or more. */
  const card = (index: number, extra: { ready?: boolean; autoplay?: boolean; url?: string } = {}) => {
    const el = { id: `card-${index}` } as unknown as Element;
    const key = `k${index}`;
    const unregister = store.register(key, {
      url: extra.url ?? `https://cdn.genex.technology/covers/${index}.mp4`,
      ready: extra.ready ?? true,
      autoplay: extra.autoplay ?? true,
      index,
      el,
    });
    io.see(el, 1);
    return { key, el, unregister };
  };
  const states = (keys: readonly string[]) => keys.map((key) => store.getState(key));
  return { clock, io, store, settle, card, states, idles, storage };
}

describe("play cover clips: the top row's order", () => {
  it("admits at most MAX_TOP_ROW_CLIPS, the first cards first", () => {
    const { store, settle, card, clock, states } = rig();
    const cards = Array.from({ length: 6 }, (_, i) => card(i));
    settle();
    clock.advance(10 * CLIP_STAGGER_MS);
    const shown = states(cards.map((c) => c.key));
    assert.equal(MAX_TOP_ROW_CLIPS, 4);
    assert.deepEqual(shown, [
      ClipState.Auto,
      ClipState.Auto,
      ClipState.Auto,
      ClipState.Auto,
      ClipState.Off,
      ClipState.Off,
    ]);
    // A card leaving frees its place for the next one.
    cards[1]?.unregister();
    assert.equal(store.getState("k4"), ClipState.Auto);
  });

  it("starts card i i × CLIP_STAGGER_MS after the idle moment, never before it", () => {
    const { settle, card, clock, states } = rig();
    const keys = [card(0), card(1), card(2)].map((c) => c.key);
    clock.advance(5 * CLIP_STAGGER_MS);
    assert.deepEqual(states(keys), [ClipState.Off, ClipState.Off, ClipState.Off], "no idle moment yet");
    settle();
    assert.deepEqual(states(keys), [ClipState.Auto, ClipState.Off, ClipState.Off]);
    clock.advance(CLIP_STAGGER_MS - 1);
    assert.deepEqual(states(keys), [ClipState.Auto, ClipState.Off, ClipState.Off]);
    clock.advance(1);
    assert.deepEqual(states(keys), [ClipState.Auto, ClipState.Auto, ClipState.Off]);
    clock.advance(CLIP_STAGGER_MS);
    assert.deepEqual(states(keys), [ClipState.Auto, ClipState.Auto, ClipState.Auto]);
  });

  it("waits for the card's own cover to decode", () => {
    const { store, settle, card } = rig();
    const { key } = card(0, { ready: false });
    settle();
    assert.equal(store.getState(key), ClipState.Off);
    store.update(key, { ready: true });
    assert.equal(store.getState(key), ClipState.Auto);
  });

  it("asks for a fresh idle moment when a new row arrives after the old one left", () => {
    const { settle, card, idles, store } = rig();
    const first = card(0);
    settle();
    assert.equal(store.getState(first.key), ClipState.Auto);
    first.unregister();
    const next = card(1);
    assert.equal(store.getState(next.key), ClipState.Off);
    assert.equal(idles.length, 1);
    settle();
    assert.equal(store.getState(next.key), ClipState.Off, "its stagger counts from the new idle moment");
  });
});

describe("play cover clips: in view and on screen", () => {
  it("holds below half in view, plays again above it, and lets go after CLIP_RELEASE_MS out of view", () => {
    const { store, settle, card, clock, io } = rig();
    const { key, el } = card(0);
    settle();
    assert.equal(store.getState(key), ClipState.Auto);
    io.see(el, 0.4);
    assert.equal(store.getState(key), ClipState.Hold);
    io.see(el, 0.6);
    assert.equal(store.getState(key), ClipState.Auto);
    io.see(el, 0);
    clock.advance(CLIP_RELEASE_MS - 1);
    assert.equal(store.getState(key), ClipState.Hold);
    clock.advance(1);
    assert.equal(store.getState(key), ClipState.Off);
  });

  it("does not start a card that is less than half in view", () => {
    const { store, settle, card, io } = rig();
    const { key, el } = card(0);
    io.see(el, 0.3);
    settle();
    assert.equal(store.getState(key), ClipState.Off);
    io.see(el, 0.5);
    assert.equal(store.getState(key), ClipState.Auto);
  });

  it("watches every card through one observer", () => {
    const { card, io } = rig();
    const cards = [card(0), card(1), card(2)];
    assert.equal(io.made(), 1);
    assert.equal(io.watched.size, 3);
    cards[0]?.unregister();
    assert.equal(io.watched.size, 2);
  });

  it("holds while the window is hidden or the viewer covers the dashboard, and starts nothing new", () => {
    const { store, settle, card, clock } = rig();
    const first = card(0);
    settle();
    store.setSignals({ visible: false });
    assert.equal(store.getState(first.key), ClipState.Hold);
    const second = card(1);
    clock.advance(10 * CLIP_STAGGER_MS);
    assert.equal(store.getState(second.key), ClipState.Off);
    store.setSignals({ visible: true, covered: true });
    assert.equal(store.getState(first.key), ClipState.Hold);
    store.setSignals({ covered: false });
    assert.deepEqual([store.getState(first.key), store.getState(second.key)], [ClipState.Auto, ClipState.Auto]);
  });
});

describe("play cover clips: what stops them", () => {
  it("plays nothing under Reduce Motion, or before the setting is read, and shows no control", () => {
    const { store, settle, card } = rig();
    const { key } = card(0);
    store.setSignals({ reducedMotion: true });
    settle();
    store.claimHover(key);
    assert.equal(store.getState(key), ClipState.Off);
    assert.equal(store.showsControl(), false);
    store.setSignals({ reducedMotion: null });
    assert.equal(store.getState(key), ClipState.Off);
    store.setSignals({ reducedMotion: false });
    assert.equal(store.showsControl(), true);
  });

  it("never tries a failed clip again, even on a card made afresh", () => {
    const { store, settle, card } = rig();
    const url = "https://cdn.genex.technology/covers/broken.mp4";
    const first = card(0, { url });
    settle();
    store.markFailed(url);
    assert.equal(store.getState(first.key), ClipState.Off);
    assert.equal(store.isFailed(url), true);
    assert.equal(store.showsControl(), false, "a row whose only clip failed has nothing to pause");
    first.unregister();
    const again = card(0, { url });
    store.claimHover(again.key);
    assert.equal(store.getState(again.key), ClipState.Off);
  });

  it("stops every clip, hover too, once a play() is refused", () => {
    const { store, settle, card, clock } = rig();
    const top = card(0);
    const below = card(5, { autoplay: false });
    settle();
    store.markRefused();
    store.claimHover(below.key);
    clock.advance(CLIP_HOVER_DELAY_MS);
    assert.deepEqual([store.getState(top.key), store.getState(below.key)], [ClipState.Off, ClipState.Off]);
    assert.equal(store.showsControl(), false);
  });

  it("pauses every clip, hover too, remembers it, and keeps the control to play again", () => {
    const storage = memoryStorage();
    const { store, settle, card, clock } = rig({ storage });
    const top = card(0);
    const below = card(5, { autoplay: false });
    settle();
    store.setPaused(true);
    store.claimHover(below.key);
    clock.advance(CLIP_HOVER_DELAY_MS);
    assert.deepEqual([store.getState(top.key), store.getState(below.key)], [ClipState.Off, ClipState.Off]);
    assert.equal(store.showsControl(), true);
    assert.equal(storage.data[STORAGE_KEYS.playClipsPaused], "1");
    const later = rig({ storage });
    assert.equal(later.store.isPaused(), true);
    store.setPaused(false);
    assert.equal(storage.data[STORAGE_KEYS.playClipsPaused], undefined);
    assert.equal(store.getState(top.key), ClipState.Auto);
  });

  it("reads storage that throws as not paused, and a pause there still holds for the session", () => {
    const { store, settle, card } = rig({ storage: throwingStorage });
    assert.equal(store.isPaused(), false);
    const { key } = card(0);
    settle();
    assert.doesNotThrow(() => store.setPaused(true));
    assert.equal(store.isPaused(), true);
    assert.equal(store.getState(key), ClipState.Off);
  });
});

describe("play cover clips: the hover token", () => {
  it("loads a hovered clip only after the dwell, and a pass across the card loads nothing", () => {
    const { store, card, clock } = rig();
    const { key } = card(5, { autoplay: false });
    store.claimHover(key);
    clock.advance(CLIP_HOVER_DELAY_MS - 1);
    assert.equal(store.getState(key), ClipState.Off);
    store.releaseHover(key);
    clock.advance(CLIP_HOVER_DELAY_MS);
    assert.equal(store.getState(key), ClipState.Off);
    store.claimHover(key);
    clock.advance(CLIP_HOVER_DELAY_MS);
    assert.equal(store.getState(key), ClipState.Hover);
    assert.equal(store.hoverStartedAt(key), clock.now() - CLIP_HOVER_DELAY_MS);
  });

  it("holds one hover at a time, and a stale release never evicts the new holder", () => {
    const { store, card, clock } = rig();
    const a = card(5, { autoplay: false });
    const b = card(6, { autoplay: false });
    store.claimHover(a.key);
    clock.advance(CLIP_HOVER_DELAY_MS);
    store.claimHover(b.key);
    clock.advance(CLIP_HOVER_DELAY_MS);
    assert.deepEqual([store.getState(a.key), store.getState(b.key)], [ClipState.Off, ClipState.Hover]);
    store.releaseHover(a.key);
    assert.equal(store.getState(b.key), ClipState.Hover);
  });

  it("is one more decoder beside a full top row, and a top-row card it hovers stays Auto", () => {
    const { store, settle, card, clock } = rig();
    const row = Array.from({ length: MAX_TOP_ROW_CLIPS }, (_, i) => card(i));
    const below = card(9, { autoplay: false });
    settle();
    clock.advance(10 * CLIP_STAGGER_MS);
    store.claimHover(below.key);
    clock.advance(CLIP_HOVER_DELAY_MS);
    assert.equal(store.getState(below.key), ClipState.Hover);
    assert.ok(row.every((c) => store.getState(c.key) === ClipState.Auto));
    store.claimHover(row[0]?.key ?? "");
    clock.advance(CLIP_HOVER_DELAY_MS);
    assert.equal(store.getState(row[0]?.key ?? ""), ClipState.Auto);
    assert.equal(store.getState(below.key), ClipState.Off);
  });

  it("shows a hovered clip no sooner than the reveal floor after the pointer came", () => {
    assert.equal(revealWait(1000, 1000 + CLIP_HOVER_DELAY_MS), CLIP_REVEAL_FLOOR_MS - CLIP_HOVER_DELAY_MS);
    assert.equal(revealWait(1000, 1000 + CLIP_REVEAL_FLOOR_MS + 5), 0);
    assert.equal(revealWait(null, 5000), 0, "a top-row clip shows on its first frame");
  });
});

describe("play cover clips: which cards are the top row", () => {
  it("is the measured first row of a feed that autoplays, at most MAX_TOP_ROW_CLIPS, with a clip", () => {
    const base = { autoplayTopRow: true, measured: true, columns: 3, index: 0, hasClip: true };
    assert.equal(topRowClip(base), true);
    assert.equal(topRowClip({ ...base, index: 2 }), true);
    assert.equal(topRowClip({ ...base, index: 3 }), false, "the second row");
    assert.equal(topRowClip({ ...base, columns: 6, index: 4 }), false, "past the cap");
    assert.equal(topRowClip({ ...base, measured: false }), false);
    assert.equal(topRowClip({ ...base, hasClip: false }), false);
    assert.equal(topRowClip({ ...base, autoplayTopRow: false }), false, "profiles and search results");
  });

  it("counts a grid's columns from its computed template", () => {
    assert.equal(gridColumns("320px 320px 320px"), 3);
    assert.equal(gridColumns("412.5px 412.5px"), 2);
    assert.equal(gridColumns(""), 0);
    assert.equal(gridColumns("none"), 0);
  });
});

/**
 * The start-control finder and the press-any-key finder, replayed against a FAKE DOM. Both are
 * page-side source handed to `page.evaluate`, so each test runs the function's `toString()` in a bare
 * `node:vm` context whose globals are the fake DOM's, exactly the way the browser receives it: a
 * reach for module scope fails here before it fails on a page. Ported from genex-demo's
 * `prober/start-control.test.ts`.
 *
 * The fixture models the ONE fact the geometric predicate rests on: what is painted over what.
 * Elements carry a `z`, and `elementFromPoint` answers with the highest `z` whose rect covers the
 * point, which is how a full-screen overlay hides the HUD legend underneath it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import {
  dispatchLookDeltasInPage,
  findPressAnyKeyInPage,
  findStartControlInPage,
  readOccludedStartControlInPage,
} from "../../scripts/evals/prober/start-control.ts";
import { CHROME_DENY_SOURCE } from "../../scripts/evals/prober/verdicts.ts";

type Spec = {
  readonly tag: string;
  readonly text: string;
  readonly rect: { x: number; y: number; w: number; h: number };
  /** Paint order. Higher wins at `elementFromPoint`. Defaults to fixture order. */
  readonly z?: number;
  readonly role?: string;
  readonly cursor?: string;
  readonly opacity?: string;
  readonly visibility?: string;
  readonly display?: string;
  /** Ids of elements nested inside this one, for the contains() check. */
  readonly children?: readonly string[];
  /** Ids of elements inside this one's OPEN shadow root — invisible to the document's queries. */
  readonly shadow?: readonly string[];
  /** Id of the parent element, for the inherited-opacity walk. */
  readonly parent?: string;
  readonly className?: string;
  /** The `hidden` attribute (the fixture never applies UA styles for it — that is the measured defect). */
  readonly hidden?: boolean;
  readonly id: string;
};

type FakeEl = {
  id: string;
  tagName: string;
  innerText: string;
  textContent: string;
  attrs: Record<string, string>;
  spec: Spec;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number };
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  contains(other: unknown): boolean;
  parentElement?: FakeEl | null;
  className: string;
  shadowRoot?: { querySelectorAll(selector: string): FakeEl[]; elementFromPoint(x: number, y: number): FakeEl | null };
};

const VIEWPORT = { w: 1280, h: 720 };

function mount(specs: readonly Spec[]): {
  els: FakeEl[];
  run: (deny: string) => string | null;
  readOccluded: () => string | null;
} {
  const els: FakeEl[] = specs.map((spec, i) => {
    const el: FakeEl = {
      id: spec.id,
      tagName: spec.tag.toUpperCase(),
      innerText: spec.text,
      textContent: spec.text,
      attrs: { ...(spec.role ? { role: spec.role } : {}), ...(spec.hidden ? { hidden: "" } : {}) },
      className: spec.className ?? "",
      spec: { ...spec, z: spec.z ?? i },
      getBoundingClientRect: () => ({
        left: spec.rect.x,
        top: spec.rect.y,
        right: spec.rect.x + spec.rect.w,
        bottom: spec.rect.y + spec.rect.h,
        width: spec.rect.w,
        height: spec.rect.h,
      }),
      getAttribute: (name: string) => (name in el.attrs ? el.attrs[name] : null),
      setAttribute: (name: string, value: string) => {
        el.attrs[name] = value;
      },
      removeAttribute: (name: string) => {
        delete el.attrs[name];
      },
      contains: (other: unknown) =>
        other === el || (spec.children ?? []).some((childId) => (other as FakeEl | null)?.id === childId),
    };
    return el;
  });
  for (const el of els) el.parentElement = el.spec.parent ? (els.find((p) => p.id === el.spec.parent) ?? null) : null;

  // Elements inside a shadow root belong to their host's root, not the
  // document's: the document's queries never return them, and a hit on one
  // is retargeted to the host — the two facts the shadow walk exists for.
  const inShadow = new Set(els.filter((e) => e.spec.shadow?.length).flatMap((e) => e.spec.shadow ?? []));
  const hostOf = (el: FakeEl): FakeEl | null => els.find((h) => h.spec.shadow?.includes(el.id)) ?? null;
  const query =
    (scope: FakeEl[]) =>
    (selector: string): FakeEl[] => {
      // The finder makes three kinds of call per root: its marker sweep, the
      // wide candidate selector, and the wildcard host sweep. The fixture only
      // ever holds elements the wide selector matches, so both non-attribute
      // queries return the whole scope in document order.
      const attr = /^\[([a-z-]+)\]$/.exec(selector);
      if (attr) return scope.filter((e) => attr[1] in e.attrs);
      return scope;
    };
  const topmost = (x: number, y: number, scope: FakeEl[]): FakeEl | null => {
    if (x < 0 || y < 0 || x > VIEWPORT.w || y > VIEWPORT.h) return null;
    const over = scope.filter((e) => {
      const r = e.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
    if (!over.length) return null;
    return over.reduce((a, b) => ((b.spec.z ?? 0) >= (a.spec.z ?? 0) ? b : a));
  };
  for (const host of els) {
    if (!host.spec.shadow?.length) continue;
    const inner = els.filter((e) => host.spec.shadow?.includes(e.id));
    host.shadowRoot = { querySelectorAll: query(inner), elementFromPoint: (x, y) => topmost(x, y, inner) };
  }
  const lightEls = els.filter((e) => !inShadow.has(e.id));
  const document = {
    querySelectorAll: query(lightEls),
    elementFromPoint(x: number, y: number): FakeEl | null {
      const hit = topmost(x, y, els);
      if (!hit) return null;
      // Retarget: a hit inside a shadow tree is reported as its host.
      return inShadow.has(hit.id) ? hostOf(hit) : hit;
    },
  };

  const ctx = vm.createContext({
    document,
    window: { innerWidth: VIEWPORT.w, innerHeight: VIEWPORT.h },
    getComputedStyle: (el: FakeEl) => ({
      visibility: el.spec.visibility ?? "visible",
      display: el.spec.display ?? "block",
      opacity: el.spec.opacity ?? "1",
      cursor: el.spec.cursor ?? "pointer",
    }),
  });
  /** The finder as the page receives it: serialised source, the fake DOM's globals, nothing else. */
  const run = (deny: string): string | null => {
    ctx.__deny = deny;
    return vm.runInContext(`(${findStartControlInPage.toString()})(__deny)`, ctx) as string | null;
  };
  /** The occlusion read-back, serialised the same way. */
  const readOccluded = (): string | null =>
    vm.runInContext(`(${readOccludedStartControlInPage.toString()})()`, ctx) as string | null;
  return { els, run, readOccluded };
}

function find(specs: readonly Spec[]): { text: string | null; marked: string[] } {
  const dom = mount(specs);
  const text = dom.run(CHROME_DENY_SOURCE);
  return { text, marked: dom.els.filter((e) => "data-genex-probe-start" in e.attrs).map((e) => e.id) };
}

/**
 * The measured village. The overlay is the full-screen click-to-lock door: its
 * own text is the multi-line title block the finder already refuses, and the
 * line a player is told to click sits low on the card. The legend cell is a
 * keybinding row in the HUD BENEATH it — near the middle of the screen, so it
 * takes the centre bonus, and three letters long, so it takes nearly all of the
 * shortest-label bonus. On score alone the legend wins, which is exactly what
 * happened.
 */
const OVERLAY: Spec = {
  id: "overlay",
  tag: "div",
  text: "",
  rect: { x: 0, y: 0, w: 1280, h: 720 },
  z: 100,
  children: ["cta"],
};
const CTA: Spec = {
  id: "cta",
  tag: "div",
  text: "Click to enter the village",
  rect: { x: 440, y: 560, w: 400, h: 40 },
  z: 101,
};
const LEGEND_RUN: Spec = { id: "legend-run", tag: "div", text: "Run", rect: { x: 520, y: 300, w: 120, h: 28 }, z: 1 };

test("THE MEASURED CASE: a HUD legend under a full-screen overlay loses to the overlay CTA", () => {
  // Before the geometric predicate the legend won on score, the probe clicked a
  // spot no player could reach, and 17 clicks over 395s never opened the game.
  const got = find([LEGEND_RUN, OVERLAY, CTA]);
  assert.equal(got.text, "Click to enter the village");
  assert.deepEqual(got.marked, ["cta"], "exactly one element carries the click marker");
});

test("and the legend really does OUTSCORE the CTA — cover is the only thing that reorders them", () => {
  // The same two elements with nothing painted over them. If this ever stops
  // returning "Run", the test above has stopped proving anything.
  assert.equal(find([LEGEND_RUN, CTA]).text, "Run");
});

test("a button whose centre lands on its own child is KEPT — that is ordinary markup", () => {
  // A strict `el === elementFromPoint(...)` test would disqualify every
  // <button><span>DEPLOY</span></button> in the catalogue.
  const got = find([
    { id: "btn", tag: "button", text: "DEPLOY", rect: { x: 540, y: 320, w: 200, h: 60 }, z: 5, children: ["label"] },
    { id: "label", tag: "span", text: "DEPLOY", rect: { x: 560, y: 335, w: 160, h: 30 }, z: 6 },
  ]);
  assert.equal(got.text, "DEPLOY");
  assert.deepEqual(got.marked, ["btn"], "the button outscores its own label by the +4 button bonus");
});

test("the deny list and the play vocabulary are unchanged", () => {
  const guestBar: Spec = {
    id: "signin",
    tag: "button",
    text: "Sign in",
    rect: { x: 1100, y: 8, w: 120, h: 32 },
    z: 200,
  };
  const deploy: Spec = {
    id: "deploy",
    tag: "button",
    text: "DEPLOY TO COMBAT",
    rect: { x: 500, y: 330, w: 280, h: 64 },
    z: 10,
  };
  assert.equal(find([deploy, guestBar]).text, "DEPLOY TO COMBAT", "Sign in is never the start control");
  // Nothing in the play vocabulary at all → nothing is marked.
  assert.deepEqual(find([{ id: "x", tag: "div", text: "Inventory", rect: { x: 500, y: 300, w: 200, h: 60 } }]), {
    text: null,
    marked: [],
  });
});

test("invisible, tiny and off-screen candidates are still refused", () => {
  const at = (id: string, extra: Partial<Spec>): Spec =>
    ({
      id,
      tag: "button",
      text: "PLAY",
      rect: { x: 500, y: 320, w: 200, h: 60 },
      ...extra,
    }) as Spec;
  assert.equal(find([at("a", { visibility: "hidden" })]).text, null);
  assert.equal(find([at("b", { display: "none" })]).text, null);
  assert.equal(find([at("c", { opacity: "0" })]).text, null);
  assert.equal(find([at("d", { rect: { x: 500, y: 320, w: 10, h: 60 } })]).text, null, "too narrow to be a control");
  assert.equal(find([at("e", { rect: { x: -900, y: 320, w: 200, h: 60 } })]).text, null, "entirely off-screen");
});

test("the marker is exclusive across repeated searches — page.click() is strict about that", () => {
  // The finder runs up to six times per run. Two marked elements make
  // `page.click('[data-genex-probe-start]')` throw a strict-mode violation,
  // which `act()` swallows — so the late start click would silently never land.
  const dom = mount([
    { id: "menu", tag: "button", text: "PLAY", rect: { x: 500, y: 320, w: 200, h: 60 }, z: 5 },
    { id: "late", tag: "button", text: "CONTINUE", rect: { x: 900, y: 620, w: 200, h: 60 }, z: 5 },
  ]);
  assert.equal(dom.run(CHROME_DENY_SOURCE), "PLAY");
  dom.els[0].spec = { ...dom.els[0].spec, display: "none" }; // the menu goes away
  assert.equal(dom.run(CHROME_DENY_SOURCE), "CONTINUE");
  assert.deepEqual(
    dom.els.filter((e) => "data-genex-probe-start" in e.attrs).map((e) => e.id),
    ["late"],
    "the previous winner was unmarked",
  );
});

test("SHADOW DOM: a start button inside an open shadow root is found, marked, and wins its own hit test", () => {
  // `document.querySelectorAll` never returns the inner button, and
  // `document.elementFromPoint` at its centre answers with the HOST. Before
  // the shadow walk the finder saw nothing here at all.
  const host: Spec = {
    id: "host",
    tag: "div",
    text: "",
    rect: { x: 440, y: 300, w: 400, h: 120 },
    z: 10,
    shadow: ["inner"],
  };
  const inner: Spec = { id: "inner", tag: "button", text: "PLAY", rect: { x: 540, y: 330, w: 200, h: 60 }, z: 11 };
  const got = find([host, inner]);
  assert.equal(got.text, "PLAY");
  assert.deepEqual(got.marked, ["inner"], "the shadow button carries the marker");
  // A host painted over by a full-screen overlay still loses: the overlay is
  // what the top-level hit test answers, and it is not inside the host.
  const cover: Spec = { id: "cover", tag: "div", text: "Loading…", rect: { x: 0, y: 0, w: 1280, h: 720 }, z: 100 };
  assert.equal(find([host, inner, cover]).text, null);
});

/* ------------------------------------------------------- the press-any-key line */

/** The affordance finder as the page receives it, over the same fake DOM the start-control finder is run against. */
function pressAnyKey(specs: readonly Spec[]): string | null {
  const dom = mount(specs);
  const ctx = vm.createContext({
    document: {
      querySelectorAll: (selector: string) => {
        // Both non-attribute queries (the wide selector and the host sweep) return the light DOM.
        if (/^\[/.test(selector)) return [];
        return dom.els.filter((e) => !specs.some((s) => s.shadow?.includes(e.id)));
      },
      elementFromPoint: (x: number, y: number) => {
        // Topmost by z among everything, retargeted like the finder's fake.
        const over = dom.els.filter((e) => {
          const r = e.getBoundingClientRect();
          return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        });
        if (!over.length) return null;
        return over.reduce((a, b) => ((b.spec.z ?? 0) >= (a.spec.z ?? 0) ? b : a));
      },
    },
    window: { innerWidth: VIEWPORT.w, innerHeight: VIEWPORT.h },
    getComputedStyle: (el: FakeEl) => ({
      visibility: el.spec.visibility ?? "visible",
      display: el.spec.display ?? "block",
      opacity: el.spec.opacity ?? "1",
      cursor: el.spec.cursor ?? "auto",
    }),
  });
  return vm.runInContext(`(${findPressAnyKeyInPage.toString()})()`, ctx) as string | null;
}

test('PRESS ANY KEY: the title line is found; a HUD legend "Press E to interact" is NOT an entrance; a covered line is not live', () => {
  const title: Spec = { id: "title", tag: "h1", text: "IRONSTEEL", rect: { x: 440, y: 200, w: 400, h: 80 }, z: 5 };
  const line: Spec = {
    id: "line",
    tag: "p",
    text: "Press any key to start",
    rect: { x: 490, y: 500, w: 300, h: 30 },
    z: 5,
  };
  assert.equal(pressAnyKey([title, line]), "Press any key to start");
  assert.equal(
    pressAnyKey([{ id: "l", tag: "p", text: "PRESS SPACE TO BEGIN", rect: { x: 490, y: 500, w: 300, h: 30 } }]),
    "PRESS SPACE TO BEGIN",
  );
  assert.equal(
    pressAnyKey([{ id: "l", tag: "p", text: "[ENTER] to start", rect: { x: 490, y: 500, w: 300, h: 30 } }]),
    "[ENTER] to start",
  );
  assert.equal(
    pressAnyKey([{ id: "l", tag: "p", text: "Tap to start", rect: { x: 490, y: 500, w: 300, h: 30 } }]),
    null,
    "a tap line is a click, and the centre click already covers it",
  );
  assert.equal(
    pressAnyKey([{ id: "legend", tag: "div", text: "Press E to interact", rect: { x: 20, y: 680, w: 200, h: 24 } }]),
    null,
    "a gameplay legend",
  );
  assert.equal(
    pressAnyKey([{ id: "legend", tag: "div", text: "Press F to talk", rect: { x: 20, y: 680, w: 200, h: 24 } }]),
    null,
  );
  // The shortest matching line wins over a paragraph that also contains the words.
  const para: Spec = {
    id: "para",
    tag: "p",
    text: "Welcome, traveller — press any key to start your journey",
    rect: { x: 300, y: 400, w: 700, h: 30 },
    z: 4,
  };
  assert.equal(pressAnyKey([para, line]), "Press any key to start");
  // Under a loading overlay the line is not the topmost hit at its centre.
  const cover: Spec = { id: "cover", tag: "div", text: "Loading…", rect: { x: 0, y: 0, w: 1280, h: 720 }, z: 100 };
  assert.equal(pressAnyKey([line, cover]), null);
  assert.equal(pressAnyKey([{ ...line, display: "none" }]), null);
});

/* --------------------------------------------------- the look phase's dispatcher */

test("dispatchLookDeltasInPage: pointermove + mousemove with explicit movementX on the lock element, else the largest canvas, else nothing", () => {
  const received: Array<{ on: string; type: string; init: Record<string, unknown> }> = [];
  const el = (id: string, w: number, h: number) => ({
    id,
    width: w,
    height: h,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    dispatchEvent(e: { type: string; init: Record<string, unknown> }) {
      received.push({ on: id, type: e.type, init: e.init });
      return true;
    },
  });
  class PointerEvent {
    type: string;
    init: Record<string, unknown>;
    constructor(type: string, init: Record<string, unknown>) {
      this.type = type;
      this.init = init;
    }
  }
  class MouseEvent extends PointerEvent {}
  const run = (pointerLockElement: unknown, canvases: unknown[]) => {
    received.length = 0;
    const ctx = vm.createContext({
      document: { pointerLockElement, querySelectorAll: () => canvases },
      PointerEvent,
      MouseEvent,
      __arg: { dx: 42, dy: 0 },
    });
    // JSON round trip: the result is built in the vm realm and strict deepEqual compares prototypes.
    return JSON.parse(JSON.stringify(vm.runInContext(`(${dispatchLookDeltasInPage.toString()})(__arg)`, ctx))) as {
      target: string;
      dispatched: number;
    };
  };
  const lock = el("lock", 1280, 720);
  const small = el("small", 64, 36);
  const big = el("big", 1280, 720);
  assert.deepEqual(run(lock, [small, big]), { target: "lock", dispatched: 2 });
  assert.deepEqual(
    received.map((r) => [r.on, r.type]),
    [
      ["lock", "pointermove"],
      ["lock", "mousemove"],
    ],
  );
  assert.equal(received[0]?.init.movementX, 42, "the delta rides the init — Chromium's MouseEventInit accepts it");
  assert.equal(received[0]?.init.movementY, 0);
  assert.equal(received[0]?.init.clientX, 640, "at the element's centre");
  assert.equal(received[0]?.init.bubbles, true, "so the instrument's window listeners see it too");
  assert.deepEqual(run(null, [small, big]), { target: "canvas", dispatched: 2 });
  assert.ok(
    received.every((r) => r.on === "big"),
    "the LARGEST canvas, not the first",
  );
  assert.deepEqual(run(null, []), { target: "none", dispatched: 0 });
});

/**
 * THE MEASURED CASE (a village game, `sunfall-hamlet`). The title
 * screen's "Walk in" button is real and visible. The pause card is marked
 * `hidden`, but the game's own `.screen { display:flex; opacity:0 }` rule
 * defeats the attribute, so the card is laid out over the title, invisible,
 * with `pointer-events:auto` descendants — and its "Esc resumes too" note sits
 * exactly over the button. A hit test at the button's centre lands on the note.
 */
test('THE MEASURED CASE 2026-09-05: a visible "Walk in" under an invisible pause card is not clicked, and the cover is named', () => {
  const full = { x: 0, y: 0, w: 1280, h: 720 };
  const dom = mount([
    { id: "title", tag: "div", text: "", rect: full, z: 10, children: ["walk"] },
    { id: "walk", tag: "button", text: "Walk in", rect: { x: 560, y: 419, w: 160, h: 52 }, z: 11, parent: "title" },
    {
      id: "pause",
      tag: "div",
      text: "",
      rect: full,
      z: 20,
      opacity: "0",
      display: "flex",
      hidden: true,
      className: "screen",
      children: ["card", "note"],
    },
    {
      id: "card",
      tag: "div",
      text: "",
      rect: { x: 445, y: 239, w: 390, h: 242 },
      z: 21,
      parent: "pause",
      className: "menu-card",
      children: ["note"],
    },
    {
      id: "note",
      tag: "div",
      text: "Esc resumes too",
      rect: { x: 480, y: 439, w: 320, h: 15 },
      z: 22,
      parent: "card",
      className: "menu-note",
    },
  ]);
  assert.equal(
    dom.run(CHROME_DENY_SOURCE),
    null,
    "nothing is clickable: the note is invisible (inherited opacity 0) and the button is covered",
  );
  assert.equal(dom.els.filter((e) => "data-genex-probe-start" in e.attrs).length, 0, "nothing is marked for a click");
  const raw = dom.els.find((e) => e.id === "walk")?.attrs["data-genex-probe-occluded"];
  assert.ok(raw, "the covered control carries the occlusion record");
  const rec = JSON.parse(raw) as { text: string; by: string };
  assert.equal(rec.text, "Walk in");
  assert.match(
    rec.by,
    /^div#note\.menu-note \(effective opacity 0\.00\)$/,
    "the cover is named by tag, id and class, with its effective opacity",
  );
  assert.equal(dom.readOccluded(), raw, "the read-back returns the same record");
  // A second search clears the record before re-deciding (the marker rule).
  assert.equal(dom.run(CHROME_DENY_SOURCE), null);
  assert.equal(dom.els.filter((e) => "data-genex-probe-occluded" in e.attrs).length, 1);
});

test('"Walk in" is a start verb, and with nothing over it the button is simply found', () => {
  const r = find([{ id: "walk", tag: "button", text: "Walk in", rect: { x: 560, y: 419, w: 160, h: 52 } }]);
  assert.equal(r.text, "Walk in");
  assert.deepEqual(r.marked, ["walk"]);
});

test("a control whose OWN opacity is 1 inside an opacity-0 ancestor is invisible to the finder", () => {
  const r = find([
    { id: "card", tag: "div", text: "", rect: { x: 400, y: 200, w: 480, h: 300 }, opacity: "0", children: ["resume"] },
    { id: "resume", tag: "button", text: "Resume", rect: { x: 560, y: 320, w: 160, h: 52 }, parent: "card" },
  ]);
  assert.deepEqual(r, { text: null, marked: [] });
});

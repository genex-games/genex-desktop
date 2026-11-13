/**
 * Genex's bridge, the one script a design page runs, driven as a page would drive it: it tells the
 * tab the page's title and size once the frame has room, hands it the wheel and drags, and says
 * what the person pressed. Every message it posts is one the tab reads (`readDesignSignal`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { DESIGN_BRIDGE, designPageStyle } from "../../src/main/design-bridge.ts";
import { type DesignFrameSignal, DesignSignal, DesignTheme, readDesignSignal } from "../../src/shared/design-board.ts";

type Listener = (event: Record<string, unknown>) => void;

/** An element of the page under the bridge: a tag, its attributes and its parent. */
class PageElement {
  readonly tag: string;
  readonly attributes: Record<string, string>;
  readonly parent: PageElement | null;
  textContent = "";
  scrollWidth = 0;
  scrollHeight = 0;
  captured: number[] = [];

  constructor(tag: string, attributes: Record<string, string> = {}, parent: PageElement | null = null) {
    this.tag = tag;
    this.attributes = attributes;
    this.parent = parent;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  setPointerCapture(id: number): void {
    this.captured.push(id);
  }

  /** `tag`, `[attribute]` or `tag[attribute]`, any of a comma-separated list: all the bridge asks for. */
  #matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const [, tag = "", attribute = ""] = /^([a-z]*)(?:\[([a-z-]+)\])?$/.exec(part.trim()) ?? [];
      const tagFits = !tag || tag === this.tag;
      const attributeFits = !attribute || attribute in this.attributes;
      return tagFits && attributeFits;
    });
  }

  closest(selector: string): PageElement | null {
    if (this.#matches(selector)) return this;
    return this.parent?.closest(selector) ?? null;
  }
}

/** A page with the bridge running on it: its window, what it posted, and a way to fire its events. */
function page(size = { width: 1200, height: 800 }) {
  const posted: unknown[] = [];
  const listeners = new Map<string, Listener[]>();
  const listen = (type: string, listener: Listener): void => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  };
  const root = new PageElement("html");
  const body = new PageElement("body", {}, root);
  const resized: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const window = { innerWidth: size.width, innerHeight: size.height, addEventListener: listen };
  const document = { documentElement: root, body, title: "Concept", addEventListener: listen };
  vm.runInNewContext(DESIGN_BRIDGE, {
    window,
    document,
    parent: { postMessage: (message: unknown) => posted.push(message) },
    location: new URL("genex-design://host/docs/design/01-concept.html?v=1"),
    Element: PageElement,
    ResizeObserver: class {
      constructor(callback: () => void) {
        resized.push(callback);
      }
      observe(): void {}
    },
    setTimeout: (callback: () => void) => timers.push(callback),
    URL,
    Math,
  });
  const fire = (type: string, fields: Record<string, unknown> = {}) => {
    const event = { prevented: false, stopped: false, button: 0, pointerId: 1, ...fields };
    const full = {
      ...event,
      preventDefault: () => {
        full.prevented = true;
      },
      stopPropagation: () => {
        full.stopped = true;
      },
    };
    for (const listener of listeners.get(type) ?? []) listener(full);
    return full;
  };
  const signals = (): DesignFrameSignal[] => posted.splice(0).map((message) => readDesignSignal(message) as never);
  return {
    window,
    document,
    root,
    body,
    fire,
    signals,
    resize: (): void => {
      for (const callback of resized) callback();
    },
    tick: (): void => {
      for (const callback of timers.splice(0)) callback();
    },
  };
}

describe("the bridge on a design page", () => {
  it("tells the tab the page's title and what it needs to show whole", () => {
    const { root, fire, signals } = page();
    root.scrollWidth = 1200;
    root.scrollHeight = 1640;
    fire("DOMContentLoaded");
    assert.deepEqual(signals(), [{ type: DesignSignal.Page, title: "Concept", width: 1200, height: 1640 }]);
    fire("load");
    assert.deepEqual(signals(), [], "the same size is said once");
  });

  it("measures nothing while its frame has no room, and speaks once it has", () => {
    // A page laid out before its frame has a size wraps every word: what it would report is a tall
    // column no sheet should ever keep (seen after a board reload: 507 wide, 1583 tall).
    const { window, root, fire, resize, signals } = page({ width: 0, height: 0 });
    root.scrollWidth = 507;
    root.scrollHeight = 1583;
    fire("DOMContentLoaded");
    fire("load");
    assert.deepEqual(signals(), []);
    window.innerWidth = 1200;
    window.innerHeight = 800;
    root.scrollWidth = 1200;
    root.scrollHeight = 800;
    resize();
    assert.deepEqual(signals(), [{ type: DesignSignal.Page, title: "Concept", width: 1200, height: 800 }]);
  });

  // Flipped: a press on anything with data-say put its words in the chat. Pages have no buttons
  // now: the person answers on the canvas, and what was a button is not shown and says nothing.
  it("says nothing for a press on what was once a button, or on plain text", () => {
    const { body, fire, signals } = page();
    const button = new PageElement("button", { "data-say": "Build direction B" }, body);
    fire("click", { target: new PageElement("span", {}, button) });
    fire("click", { target: new PageElement("p", {}, body) });
    assert.deepEqual(signals(), []);
    assert.match(designPageStyle(DesignTheme.Dark), /\[data-say\]\{display:none !important\}/, "and it is not shown");
  });

  it("never follows a link itself: another page of the board and the web are the tab's to open", () => {
    const { body, fire, signals } = page();
    const link = (href: string) => fire("click", { target: new PageElement("a", { href }, body) });
    assert.equal(link("02-core-loop.html").prevented, true);
    assert.equal(link("https://example.com/reference").prevented, true);
    assert.equal(link("#top").prevented, true);
    assert.deepEqual(signals(), [
      { type: DesignSignal.Open, file: "docs/design/02-core-loop.html" },
      { type: DesignSignal.Link, url: "https://example.com/reference" },
    ]);
  });

  it("hands the wheel to the wall and never scrolls", () => {
    const { fire, signals } = page();
    const wheel = fire("wheel", { deltaY: 120, clientX: 300, clientY: 200, ctrlKey: true, metaKey: false });
    assert.equal(wheel.prevented, true);
    assert.deepEqual(signals(), [{ type: DesignSignal.Wheel, dy: 120, x: 300, y: 200, pinch: true }]);
  });

  it("turns a drag that begins on the page into a pan of the wall, and swallows the click that ends it", () => {
    const { root, body, fire, signals, tick } = page();
    const text = new PageElement("p", {}, body);
    fire("pointerdown", { target: text, screenX: 100, screenY: 100 });
    fire("pointermove", { screenX: 101, screenY: 101 });
    assert.deepEqual(signals(), [], "inside the dead zone it is still a press");
    fire("pointermove", { screenX: 110, screenY: 104 });
    fire("pointermove", { screenX: 115, screenY: 104 });
    fire("pointerup");
    assert.deepEqual(signals(), [
      { type: DesignSignal.Drag, dx: 10, dy: 4, end: false },
      { type: DesignSignal.Drag, dx: 5, dy: 0, end: false },
      { type: DesignSignal.Drag, dx: 0, dy: 0, end: true },
    ]);
    assert.deepEqual(root.captured, [1], "the page keeps the pointer for the drag");
    const link = new PageElement("a", { href: "https://example.com/" }, body);
    assert.equal(fire("click", { target: link }).stopped, true);
    assert.deepEqual(signals(), [], "the click that ends a drag presses nothing");
    tick();
    fire("click", { target: link });
    assert.deepEqual(signals(), [{ type: DesignSignal.Link, url: "https://example.com/" }]);
  });

  it("leaves a press on a button, a link or a field to the page", () => {
    const { body, fire, signals } = page();
    for (const tag of ["button", "input", "summary", "video"]) {
      fire("pointerdown", { target: new PageElement(tag, {}, body), screenX: 0, screenY: 0 });
      fire("pointermove", { screenX: 50, screenY: 50 });
      fire("pointerup");
    }
    assert.deepEqual(signals(), []);
  });
});

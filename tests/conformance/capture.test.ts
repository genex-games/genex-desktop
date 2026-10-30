/**
 * The end-of-frame photograph (M4.9a) — `createFrameCapture` against a stub page.
 *
 * The two rules this file guards are the ones a real GPU cannot be asked about cheaply: never
 * re-render to take a picture (the last pass of a composer is what the user sees), and always
 * composite over the page's own background (a transparent canvas measured black for a game the
 * player saw as sky). Everything below is the ladder that sits between those two rules.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import {
  DEFAULT_BACKGROUND,
  NOTHING_DREW,
  NO_CANVAS,
  PAINTED_BACKGROUND,
  TRANSPARENT_WEBGPU,
  createFrameCapture,
} from "../../src/page/capture.ts";
import {
  chooseCapture,
  PAGE_UI_MAX_ENTRIES,
  PAGE_UI_PRIMARY_COVERAGE,
  PAGE_UI_PROBE,
  probePageUi,
  readPageUi,
  resolveSurface,
} from "../../src/substrate/page-ui.ts";

type Descriptor = {
  index: number;
  kind: string;
  width: number;
  height: number;
  visible?: boolean;
  alphaMode?: string | null;
};

/** A canvas that answers what a canvas answers and remembers being asked for a context. */
function canvasStub(width: number, height: number, style: Record<string, string> = {}) {
  const element = {
    width,
    height,
    style,
    parentElement: null as unknown,
    getContexts: 0,
    getContext() {
      element.getContexts++;
      return null;
    },
  };
  return element;
}

/** A 2D context that records the order of what was drawn onto it. */
function scratchStub() {
  const order: string[] = [];
  const context = {
    fillStyle: "",
    fillRect(...args: number[]) {
      order.push(`fillRect ${args.join(",")} in ${context.fillStyle}`);
    },
    drawImage() {
      order.push("drawImage");
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: (kind: string) => (kind === "2d" ? context : null),
    toDataURL: () => "data:image/png;base64,COMPOSITED",
  };
  return { canvas, context, order };
}

/**
 * A page with a clock the test drives by hand, counters the test moves by hand, and a style
 * tree the test declares. Everything the capture needs, nothing it does not.
 */
function rig(
  options: {
    descriptors: Descriptor[];
    elements?: unknown[];
    rendererCanvas?: unknown;
    frozen?: boolean;
    styles?: Map<unknown, { backgroundColor?: string; backgroundImage?: string }>;
    parents?: Map<unknown, unknown>;
    counting?: boolean;
    /** How a data URL is turned back into something `drawImage` accepts (the WebGPU path). */
    decode?: (url: string) => unknown;
  } = { descriptors: [] },
) {
  let drawCalls = 0;
  const subscribers = new Set<() => void>();
  const timers: Array<{ fn: () => void; at: number }> = [];
  const ladderCalls: string[] = [];
  const scratch = scratchStub();
  const elements = options.elements ?? options.descriptors.map((d) => canvasStub(d.width, d.height));
  const deps = {
    canvases: () => ({ elements, descriptors: options.descriptors.map((d) => ({ visible: true, ...d })) }),
    rendererCanvas: () => options.rendererCanvas ?? null,
    afterFrame: (fn: () => void) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    pumpFrame: (dt: number) => {
      ladderCalls.push(`pumpFrame(${dt})`);
      return false;
    },
    draws: () => ({ drawCalls, counting: options.counting !== false }),
    frozen: () => options.frozen === true,
    start: () => void ladderCalls.push("start"),
    pause: () => void ladderCalls.push("pause"),
    gameCapture: () => {
      ladderCalls.push("gameCapture");
      return null;
    },
    debugCamera: (name: string) => {
      ladderCalls.push(`debugCamera(${name})`);
      return { ok: true };
    },
    currentCamera: () => "default",
    computedStyle: (element: unknown) =>
      options.styles?.get(element) ?? { backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none" },
    parentOf: (element: unknown) => options.parents?.get(element) ?? null,
    createCanvas: () => scratch.canvas,
    decode: options.decode,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, at: ms });
      return timers.length;
    },
    clearTimeout: (id: number) => {
      if (timers[id - 1]) timers[id - 1].fn = () => {};
    },
  };
  return {
    deps,
    elements,
    scratch,
    ladderCalls,
    draw: (n = 1) => {
      drawCalls += n;
    },
    /** One end-of-frame, the way the clock delivers it. */
    frame: (drew = true) => {
      if (drew) drawCalls++;
      for (const fn of [...subscribers]) fn();
    },
    /** The 250 ms race running out. */
    expire: () => {
      for (const timer of timers.splice(0)) timer.fn();
    },
  };
}

describe("the page-side capture photographs the end of the frame", () => {
  it("prefers the renderer's own canvas, then the largest 3D canvas, and never asks for a context", () => {
    const small = canvasStub(320, 200);
    const big = canvasStub(1600, 900);
    const world = rig({
      descriptors: [
        { index: 0, kind: "webgl2", width: 320, height: 200 },
        { index: 1, kind: "webgl2", width: 1600, height: 900 },
      ],
      elements: [small, big],
    });
    const capture = createFrameCapture(world.deps);
    assert.equal(capture.pick().canvas, big);

    const own = rig({
      descriptors: [
        { index: 0, kind: "webgl2", width: 320, height: 200 },
        { index: 1, kind: "webgl2", width: 1600, height: 900 },
      ],
      elements: [small, big],
      rendererCanvas: small,
    });
    assert.equal(createFrameCapture(own.deps).pick().canvas, small);
    assert.equal(small.getContexts, 0);
    assert.equal(big.getContexts, 0);
  });

  it("a canvas with no drawing buffer is not a picture, and no canvas at all says so", async () => {
    const world = rig({ descriptors: [{ index: 0, kind: "webgl2", width: 0, height: 0 }] });
    const capture = createFrameCapture(world.deps);
    assert.equal(capture.pick().canvas, null);
    const shot = capture.capture();
    world.frame();
    assert.equal(await shot, null);
    assert.equal(capture.captureInfo().reason, NO_CANVAS);
  });

  it("composites the resolved background under the frame, in that order", async () => {
    const canvas = canvasStub(800, 600);
    const body = { tag: "body" };
    const world = rig({
      descriptors: [{ index: 0, kind: "webgl2", width: 800, height: 600 }],
      elements: [canvas],
      styles: new Map<unknown, { backgroundColor?: string; backgroundImage?: string }>([
        [canvas, { backgroundColor: "transparent", backgroundImage: "none" }],
        [body, { backgroundColor: "rgb(12, 24, 48)", backgroundImage: "none" }],
      ]),
      parents: new Map<unknown, unknown>([[canvas, body]]),
    });
    const capture = createFrameCapture(world.deps);
    const shot = capture.capture();
    world.frame();
    assert.equal(await shot, "data:image/png;base64,COMPOSITED");
    assert.deepEqual(world.scratch.order, ["fillRect 0,0,800,600 in rgb(12, 24, 48)", "drawImage"]);
    const info = capture.captureInfo();
    assert.equal(info.composited, true);
    assert.equal(info.background, "rgb(12, 24, 48)");
    assert.equal(info.source, "page");
    assert.equal(info.kind, "webgl2");
    assert.deepEqual(info.ladder, ["frame"]);
    assert.equal(world.scratch.canvas.width, 800);
  });

  it("a page that declares no background anywhere is composited on the colour a browser paints", async () => {
    const canvas = canvasStub(64, 64);
    const world = rig({ descriptors: [{ index: 0, kind: "webgl", width: 64, height: 64 }], elements: [canvas] });
    const capture = createFrameCapture(world.deps);
    const shot = capture.capture();
    world.frame();
    await shot;
    assert.equal(capture.captureInfo().background, DEFAULT_BACKGROUND);
  });

  it("an ancestor with a gradient cannot be resolved to one colour, so the compositor takes the frame", async () => {
    const canvas = canvasStub(800, 600);
    const body = { tag: "body" };
    const world = rig({
      descriptors: [{ index: 0, kind: "webgl2", width: 800, height: 600 }],
      elements: [canvas],
      styles: new Map<unknown, { backgroundColor?: string; backgroundImage?: string }>([
        [canvas, { backgroundColor: "transparent", backgroundImage: "none" }],
        [body, { backgroundColor: "rgb(0, 0, 0)", backgroundImage: "linear-gradient(#123, #456)" }],
      ]),
      parents: new Map<unknown, unknown>([[canvas, body]]),
    });
    const capture = createFrameCapture(world.deps);
    const shot = capture.capture();
    world.frame();
    assert.equal(await shot, null);
    assert.equal(capture.captureInfo().reason, PAINTED_BACKGROUND);
    assert.deepEqual(world.scratch.order, []);
  });

  it("with nothing drawn the ladder tries the game, then the camera, and never resumes unasked", async () => {
    const canvas = canvasStub(800, 600);
    const world = rig({ descriptors: [{ index: 0, kind: "webgl2", width: 800, height: 600 }], elements: [canvas] });
    const capture = createFrameCapture(world.deps);
    const shot = capture.capture();
    world.frame(false);
    assert.equal(await shot, null);
    assert.equal(capture.captureInfo().reason, NOTHING_DREW);
    assert.deepEqual(world.ladderCalls, ["gameCapture", "debugCamera(default)"]);
    assert.deepEqual(capture.captureInfo().ladder, ["frame", "game", "camera"]);
  });

  it("allowResume lets the ladder run one frame of a frozen page, and puts it back", async () => {
    const canvas = canvasStub(800, 600);
    const world = rig({
      descriptors: [{ index: 0, kind: "webgl2", width: 800, height: 600 }],
      elements: [canvas],
      frozen: true,
    });
    const capture = createFrameCapture(world.deps);
    const shot = capture.capture({ allowResume: true });
    assert.equal(await shot, null);
    assert.deepEqual(world.ladderCalls, [
      "pumpFrame(0)",
      "gameCapture",
      "debugCamera(default)",
      "start",
      "pumpFrame(16)",
      "pause",
    ]);
    assert.deepEqual(capture.captureInfo().ladder, ["pump", "game", "camera", "resume"]);
  });

  it("a frozen clock is pumped instead of waited on", async () => {
    const canvas = canvasStub(800, 600);
    const world = rig({
      descriptors: [{ index: 0, kind: "webgl2", width: 800, height: 600 }],
      elements: [canvas],
      frozen: true,
    });
    // The pump is what draws, so the counter moves before the verification reads it.
    const deps = {
      ...world.deps,
      pumpFrame: (dt: number) => {
        world.ladderCalls.push(`pumpFrame(${dt})`);
        world.draw();
        return true;
      },
    };
    const capture = createFrameCapture(deps);
    assert.equal(await capture.capture(), "data:image/png;base64,COMPOSITED");
    assert.deepEqual(capture.captureInfo().ladder, ["pump"]);
    assert.equal(capture.captureInfo().drawCalls, 1);
  });

  it("a page that never fires a frame answers after the race instead of hanging", async () => {
    const canvas = canvasStub(800, 600);
    const world = rig({ descriptors: [{ index: 0, kind: "webgl2", width: 800, height: 600 }], elements: [canvas] });
    const capture = createFrameCapture(world.deps);
    const shot = capture.capture();
    world.expire();
    assert.equal(await shot, null);
    assert.deepEqual(capture.captureInfo().ladder, ["timeout", "game", "camera"]);
    assert.equal(capture.captureInfo().reason, NOTHING_DREW);
  });

  it("the game's own picture ends the ladder, and its own capture cannot re-enter this one", async () => {
    const canvas = canvasStub(800, 600);
    const world = rig({ descriptors: [{ index: 0, kind: "webgl2", width: 800, height: 600 }], elements: [canvas] });
    let reentrant: unknown = "never asked";
    let capture: ReturnType<typeof createFrameCapture>;
    const deps = {
      ...world.deps,
      // Exactly what the template does when it has no render of its own: it asks us back.
      gameCapture: async () => {
        world.ladderCalls.push("gameCapture");
        reentrant = await capture.capture();
        return "data:image/png;base64,GAME";
      },
    };
    capture = createFrameCapture(deps);
    const shot = capture.capture();
    world.frame(false);
    assert.equal(await shot, "data:image/png;base64,GAME");
    assert.equal(reentrant, null, "a re-entrant capture must decline, not recurse");
    assert.equal(capture.captureInfo().composited, false);
  });

  it("waits for an asynchronous WebGPU pass and reads the canvas directly", async () => {
    // A WebGPU game renders asynchronously: the pass lands after the animation callback has
    // returned, so the counters, read in the same turn, still say nothing was drawn. Nothing in
    // the suite drove this rung before — a webgpu descriptor never reached the rig at all.
    const canvas = canvasStub(400, 300) as ReturnType<typeof canvasStub> & { toDataURL: () => string };
    canvas.toDataURL = () => "data:image/png;base64,WEBGPU";
    const world = rig({
      descriptors: [{ index: 0, kind: "webgpu", width: 400, height: 300, alphaMode: "opaque" }],
      elements: [canvas],
      frozen: true,
    });
    const capture = createFrameCapture(world.deps);
    const shot = capture.capture();
    world.draw(1);
    world.expire();
    assert.equal(await shot, "data:image/png;base64,WEBGPU");
    const info = capture.captureInfo();
    assert.deepEqual(info.ladder, ["pump", "async"]);
    // Nothing to composite under an opaque context, and its canvas is not a `drawImage` source.
    assert.equal(info.composited, false);
    assert.equal(info.kind, "webgpu");
    assert.deepEqual(world.scratch.order, []);
  });

  it("composites a transparent WebGPU frame rather than encoding its alpha as black", async () => {
    // `alphaMode: "premultiplied"` is what three's own WebGPU renderer configures unless the
    // game asked for an opaque canvas, and a PNG writes those transparent pixels out as black —
    // "renders effectively black" on a game the user can see is lit.
    const canvas = canvasStub(400, 300) as ReturnType<typeof canvasStub> & { toDataURL: () => string };
    canvas.toDataURL = () => "data:image/png;base64,WEBGPU";
    const decoded = { tag: "decoded" };
    const world = rig({
      descriptors: [{ index: 0, kind: "webgpu", width: 400, height: 300, alphaMode: "premultiplied" }],
      elements: [canvas],
      styles: new Map<unknown, { backgroundColor?: string; backgroundImage?: string }>([
        [canvas, { backgroundColor: "rgb(4, 6, 11)", backgroundImage: "none" }],
      ]),
      decode: () => decoded,
    });
    const capture = createFrameCapture(world.deps);
    const shot = capture.capture();
    world.frame();
    assert.equal(await shot, "data:image/png;base64,COMPOSITED");
    assert.deepEqual(world.scratch.order, ["fillRect 0,0,400,300 in rgb(4, 6, 11)", "drawImage"]);
    assert.equal(capture.captureInfo().composited, true);
  });

  it("declines a transparent WebGPU frame it cannot composite, so the compositor takes it", async () => {
    const canvas = canvasStub(400, 300) as ReturnType<typeof canvasStub> & { toDataURL: () => string };
    canvas.toDataURL = () => "data:image/png;base64,WEBGPU";
    const world = rig({
      descriptors: [{ index: 0, kind: "webgpu", width: 400, height: 300, alphaMode: "premultiplied" }],
      elements: [canvas],
    });
    const capture = createFrameCapture(world.deps);
    const shot = capture.capture();
    world.frame();
    assert.equal(await shot, null);
    assert.equal(capture.captureInfo().reason, TRANSPARENT_WEBGPU);
  });

  it("counts the pictures it took, and records the ones a game took itself", async () => {
    // How the studio tells a frame the shim read off the canvas from one the build answered
    // with: `capture()` and `captureInfo()` are both delegated to the game, so the record has to
    // come with a count of the pictures THIS object took.
    const canvas = canvasStub(800, 600);
    const world = rig({ descriptors: [{ index: 0, kind: "webgl2", width: 800, height: 600 }], elements: [canvas] });
    const capture = createFrameCapture(world.deps);
    const start = capture.captureInfo().count;
    const shot = capture.capture();
    world.frame();
    await shot;
    const shimTook = capture.captureInfo();
    assert.equal(shimTook.count, start + 1);
    assert.equal(shimTook.source, "page");

    capture.note({ drawCalls: 42, reason: null, kind: "webgl2", ladder: ["render"] });
    const gameTook = capture.captureInfo();
    assert.equal(gameTook.count, start + 2, "a picture the game took must move the count too");
    assert.equal(gameTook.source, "game", "a game's own picture is labelled as one");
    assert.equal(gameTook.drawCalls, 42);
    assert.deepEqual(gameTook.ladder, ["render"]);
  });

  it("composites a picture the game took itself over the same background", async () => {
    // A raw `toDataURL` of a canvas made with `alpha: true` — three's default — keeps the alpha
    // it was drawn with, and a PNG writes that out as black. The template photographs its own
    // render, so its picture goes over the page's background exactly as the shim's does.
    const canvas = canvasStub(800, 600);
    const decoded = { tag: "decoded" };
    const world = rig({
      descriptors: [{ index: 0, kind: "webgl2", width: 800, height: 600 }],
      elements: [canvas],
      styles: new Map<unknown, { backgroundColor?: string; backgroundImage?: string }>([
        [canvas, { backgroundColor: "rgb(9, 9, 9)", backgroundImage: "none" }],
      ]),
      decode: () => decoded,
    });
    const capture = createFrameCapture(world.deps);
    const painted = await capture.paint("data:image/png;base64,GAME", {
      drawCalls: 12,
      reason: null,
      ladder: ["render"],
    });
    assert.equal(painted, "data:image/png;base64,COMPOSITED");
    assert.deepEqual(world.scratch.order, ["fillRect 0,0,800,600 in rgb(9, 9, 9)", "drawImage"]);
    const info = capture.captureInfo();
    assert.equal(info.source, "game", "a picture the game took is labelled as one, composited or not");
    assert.equal(info.composited, true);
    assert.equal(info.drawCalls, 12);
    assert.equal(info.kind, "webgl2");
    assert.deepEqual(info.ladder, ["render"]);

    // A page that cannot be resolved to one colour keeps the game's own picture rather than none.
    const gradient = rig({
      descriptors: [{ index: 0, kind: "webgl2", width: 800, height: 600 }],
      elements: [canvas],
      styles: new Map<unknown, { backgroundColor?: string; backgroundImage?: string }>([
        [canvas, { backgroundImage: "linear-gradient(#fff, #000)" }],
      ]),
      decode: () => decoded,
    });
    const kept = createFrameCapture(gradient.deps);
    assert.equal(await kept.paint("data:image/png;base64,GAME", {}), "data:image/png;base64,GAME");
    assert.equal(kept.captureInfo().composited, false);
  });

  it("with the counters quieted a draw cannot be proved, so the frame is taken on trust", async () => {
    const canvas = canvasStub(800, 600);
    const world = rig({
      descriptors: [{ index: 0, kind: "webgl2", width: 800, height: 600 }],
      elements: [canvas],
      counting: false,
    });
    const capture = createFrameCapture(world.deps);
    const shot = capture.capture();
    world.frame(false);
    assert.equal(await shot, "data:image/png;base64,COMPOSITED");
    assert.deepEqual(world.ladderCalls, []);
  });
});

// ── M4.5a: the page's other surface ─────────────────────────────────────────

/**
 * The second eye. `PAGE_UI_PROBE` runs in the page, so the test runs the STRING — the exact
 * bytes the preview evaluates — in a fresh realm against a document the test declares. What is
 * being guarded is the difference between the probe and `domUi()`: painted area is clipped,
 * ancestors swallow their children, a wrapper around the game is scenery, and something painted
 * beside the canvas is not the game's interface.
 */
type StubStyle = Record<string, string>;

interface StubEl {
  tagName: string;
  id: string;
  className: string;
  parentElement: StubEl | null;
  kids: StubEl[];
  childNodes: Array<{ nodeType: number; textContent: string } | StubEl>;
  style: StubStyle;
  textContent: string;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number };
  getClientRects(): unknown[];
  closest(selector: string): StubEl | null;
}

/** One element: a tag, a box in view pixels, whatever computed style the case needs, and kids. */
function el(
  tag: string,
  spec: {
    id?: string;
    cls?: string;
    text?: string;
    box?: [number, number, number, number];
    style?: StubStyle;
    kids?: StubEl[];
  } = {},
): StubEl {
  const [x, y, w, h] = spec.box ?? [0, 0, 0, 0];
  const node = {
    tagName: tag.toUpperCase(),
    id: spec.id ?? "",
    className: spec.cls ?? "",
    parentElement: null as StubEl | null,
    kids: spec.kids ?? [],
    childNodes: [] as Array<{ nodeType: number; textContent: string } | StubEl>,
    style: spec.style ?? {},
    textContent: spec.text ?? "",
    getBoundingClientRect: () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }),
    getClientRects: () => (w > 0 && h > 0 ? [1] : []),
    closest(selector: string) {
      let cursor: StubEl | null = node;
      while (cursor) {
        if (cursor.tagName.toLowerCase() === selector) return cursor;
        cursor = cursor.parentElement;
      }
      return null;
    },
  } as StubEl;
  if (spec.text) node.childNodes.push({ nodeType: 3, textContent: spec.text });
  for (const kid of node.kids) {
    kid.parentElement = node;
    node.childNodes.push(kid);
  }
  return node;
}

/** Run the real probe string against a declared page. */
function probe(spec: { width?: number; height?: number; body: StubEl[] }): Record<string, unknown> {
  const width = spec.width ?? 800;
  const height = spec.height ?? 600;
  const flatten = (list: StubEl[]): StubEl[] => list.flatMap((node) => [node, ...flatten(node.kids)]);
  const all = flatten(spec.body);
  const body = el("body", { kids: spec.body }) as StubEl & { querySelectorAll(selector: string): StubEl[] };
  body.querySelectorAll = () => all;
  const document = {
    documentElement: { clientWidth: width, clientHeight: height },
    body,
    querySelectorAll: (selector: string) => all.filter((node) => node.tagName === selector.toUpperCase()),
  };
  const context = {
    document,
    window: { innerWidth: width, innerHeight: height },
    getComputedStyle: (node: StubEl) => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      backgroundColor: "rgba(0, 0, 0, 0)",
      backgroundImage: "none",
      borderStyle: "none",
      borderWidth: "0px",
      ...node.style,
    }),
  };
  // Through JSON, exactly as `preview.evaluate` returns it: the page stringifies, the studio
  // parses, and nothing crosses the realm boundary but text.
  return JSON.parse(JSON.stringify(runInNewContext(PAGE_UI_PROBE, context))) as Record<string, unknown>;
}

const canvasEl = (box: [number, number, number, number]) => el("canvas", { box });

describe("the page's UI probe", () => {
  it("a full-page background layer around the canvas is scenery, not interface", () => {
    const canvas = canvasEl([0, 0, 800, 600]);
    const answer = probe({
      body: [
        el("div", {
          cls: "bg",
          box: [0, 0, 800, 600],
          style: { backgroundImage: "linear-gradient(#111, #333)" },
          kids: [canvas],
        }),
      ],
    });
    assert.deepEqual(answer.entries, []);
    assert.equal(answer.coverage, 0);
    assert.equal(answer.uiPrimary, false);
    assert.deepEqual(answer.canvas, { count: 1, x: 0, y: 0, width: 800, height: 600 });
  });

  it("a letterboxing frame beside the game does not count — it never touches the canvas", () => {
    const answer = probe({
      body: [
        el("div", { cls: "letterbox", box: [0, 0, 100, 600], style: { backgroundColor: "rgb(0, 0, 0)" } }),
        canvasEl([100, 0, 600, 600]),
      ],
    });
    assert.deepEqual(answer.entries, []);
    assert.equal(answer.uiPrimary, false);
  });

  it("a 20px score line is seen and named, but it is not the primary surface", () => {
    const answer = probe({
      body: [canvasEl([0, 0, 800, 600]), el("div", { id: "score", box: [10, 10, 120, 20], text: "SCORE 0" })],
    });
    assert.deepEqual(answer.entries, ['div#score "SCORE 0"']);
    assert.ok(
      (answer.coverage as number) > 0 && (answer.coverage as number) < PAGE_UI_PRIMARY_COVERAGE,
      String(answer.coverage),
    );
    assert.equal(answer.uiPrimary, false);
  });

  it("a full-screen menu is the primary surface, and its buttons are not counted a second time", () => {
    const menu = el("div", {
      cls: "menu",
      box: [0, 0, 800, 600],
      style: { backgroundColor: "rgb(20, 20, 30)" },
      kids: [
        el("button", { box: [300, 250, 200, 40], text: "Play" }),
        el("button", { box: [300, 300, 200, 40], text: "Options" }),
      ],
    });
    const answer = probe({ body: [canvasEl([0, 0, 800, 600]), menu] });
    assert.deepEqual(answer.entries, ["div.menu"]);
    assert.equal(answer.coverage, 1);
    assert.equal(answer.uiPrimary, true);
  });

  it("the naming cap stops the list, never the area sum", () => {
    const tiles = Array.from({ length: 20 }, (_, i) =>
      el("div", { cls: `tile${i}`, box: [(i % 8) * 100, Math.floor(i / 8) * 100, 100, 100], text: `T${i}` }),
    );
    const answer = probe({ body: [canvasEl([0, 0, 800, 600]), ...tiles] });
    assert.equal((answer.entries as string[]).length, PAGE_UI_MAX_ENTRIES);
    // 20 × 100 × 100 of 800 × 600. A cap on the sum would have reported 0.25.
    assert.ok(Math.abs((answer.coverage as number) - 20 / 48) < 1e-9, String(answer.coverage));
  });

  it("area is clipped to the window, so a panel hanging off the edge counts once, at its visible size", () => {
    const answer = probe({
      body: [canvasEl([0, 0, 800, 600]), el("aside", { box: [700, 500, 400, 400], text: "log" })],
    });
    assert.ok(Math.abs((answer.coverage as number) - (100 * 100) / (800 * 600)) < 1e-9, String(answer.coverage));
  });

  it("a page with no canvas measures its DOM against the window, and reports no canvas", () => {
    const answer = probe({ body: [el("div", { cls: "loading", box: [0, 0, 800, 600], text: "Loading" })] });
    assert.equal(answer.canvas, null);
    assert.equal(answer.uiPrimary, true);
  });
});

describe("reading what the page answered", () => {
  it("folds an untrusted answer, caps the entries and recomputes uiPrimary from coverage", () => {
    const folded = readPageUi({
      entries: [1, "nav.menu", ...Array.from({ length: 30 }, (_, i) => `div.i${i}`)],
      coverage: 0.5,
      canvas: { count: "2", x: 1.4, y: -2.6, width: 960.2, height: 600 },
      viewport: { width: 960, height: 600 },
      // The page said it is not primary; half the window says otherwise, and the threshold is
      // the studio's to apply.
      uiPrimary: false,
    });
    assert.equal(folded?.entries.length, PAGE_UI_MAX_ENTRIES);
    assert.equal(folded?.entries[0], "nav.menu");
    // A count that is not a number is one canvas, not none: the page reported a box for it.
    assert.deepEqual(folded?.canvas, { count: 1, x: 1, y: -3, width: 960, height: 600 });
    assert.equal(folded?.uiPrimary, true);
  });

  it("a page that could not be probed reads back as null, which is not a page with no UI", () => {
    assert.equal(readPageUi(null), null);
    assert.equal(readPageUi("nope"), null);
    assert.equal(readPageUi([{ entries: [] }]), null);
    assert.equal(readPageUi({ __error: "TypeError: cannot read x" }), null);
    assert.equal(
      readPageUi({ entries: [], coverage: 0, canvas: null, viewport: {}, uiPrimary: false })?.uiPrimary,
      false,
    );
  });

  it("coverage is clamped and uiPrimary lands exactly on the threshold", () => {
    assert.equal(readPageUi({ coverage: 12 })?.coverage, 1);
    assert.equal(readPageUi({ coverage: -3 })?.coverage, 0);
    assert.equal(readPageUi({ coverage: Number.NaN })?.coverage, 0);
    assert.equal(readPageUi({ coverage: PAGE_UI_PRIMARY_COVERAGE })?.uiPrimary, true);
    assert.equal(readPageUi({ coverage: PAGE_UI_PRIMARY_COVERAGE - 1e-6 })?.uiPrimary, false);
  });

  it("a probe that rejects, times out or answers rubbish is null, never a throw", async () => {
    assert.equal(await probePageUi(() => Promise.reject(new Error("frame is navigating"))), null);
    assert.equal(await probePageUi(() => new Promise(() => {}), { timeoutMs: 5 }), null);
    assert.equal(await probePageUi(async () => ({ __error: "TypeError" })), null);
    const ui = await probePageUi(async (expression) => {
      assert.equal(expression, PAGE_UI_PROBE);
      return {
        entries: ["nav"],
        coverage: 0.4,
        canvas: { count: 1, x: 0, y: 0, width: 8, height: 6 },
        viewport: { width: 8, height: 6 },
        uiPrimary: true,
      };
    });
    assert.equal(ui?.uiPrimary, true);
  });
});

// ── which surface a capture photographs ──────────────────────────────────────
/**
 * The surface ladder, without a window. `chooseCapture` is the whole of `#capture`'s decision: the
 * studio photographs the page as the player sees it (the compositor frame, DOM included) unless a
 * caller names the canvas, and a page frame that cannot be had falls back to the canvas — a
 * picture beats none.
 */
/** A ladder whose callbacks are declared per case and whose calls are recorded. */
function ladder(spec: { canvas?: string | Error; page?: string | Error }) {
  const calls: string[] = [];
  const give = (what: string | Error | undefined, name: string) => async () => {
    calls.push(name);
    if (what instanceof Error) throw what;
    return what ?? name;
  };
  return {
    calls,
    deps: { canvas: give(spec.canvas, "canvas-frame"), page: give(spec.page, "page-frame") },
  };
}

it("photographs the page, DOM included, unless the canvas is named", async () => {
  // Flipped from "neither means the canvas" and an `auto` that probed the page first: every
  // capture the app takes is the page as the player sees it.
  assert.equal(resolveSurface({}), "page");
  assert.equal(resolveSurface({ page: true }), "page");
  assert.equal(resolveSurface({ page: true, surface: "canvas" }), "canvas");
  for (const asked of ["page", "auto"] as const) {
    const rig = ladder({});
    assert.deepEqual(await chooseCapture(asked, rig.deps), { shot: "page-frame", surface: "page" });
    assert.deepEqual(rig.calls, ["page-frame"], `${asked} asks the page nothing first`);
  }
  const canvasOnly = ladder({});
  assert.deepEqual(await chooseCapture("canvas", canvasOnly.deps), { shot: "canvas-frame", surface: "canvas" });
  assert.deepEqual(canvasOnly.calls, ["canvas-frame"]);
});

it("falls back to the canvas when the page frame cannot be had, and fails only when neither can", async () => {
  const noCompositor = ladder({ page: new Error("display surface not available") });
  const fell = await chooseCapture("page", noCompositor.deps);
  assert.equal(fell.shot, "canvas-frame");
  assert.equal(fell.surface, "canvas");
  const both = ladder({
    page: new Error("display surface not available"),
    canvas: new Error("the page never answered"),
  });
  await assert.rejects(chooseCapture("auto", both.deps), /display surface not available/);
});

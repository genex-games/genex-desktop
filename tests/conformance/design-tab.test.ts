/**
 * The stage's Design tab: beside Live and Builds for every game, the game's design pages hung on
 * one wall. A page's frame tells the tab its title and size and what the person pressed; the tab
 * believes nothing else it says. The native game view gives the stage back while Design is open.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LiveView } from "../../src/renderer/live-views.ts";
import { boardIsNew } from "../../src/renderer/panels/design/design-asks.ts";
import {
  boardLayout,
  boardStack,
  changedFiles,
  displayName,
  heldAfter,
  heldFrames,
  MODELS_TURNED_MAX,
  pageCaption,
  PAGE_HEIGHT,
  PAGE_MAX_HEIGHT,
  PAGE_MAX_WIDTH,
  PAGE_WIDTH,
  pictureSize,
  sizeAfter,
  turnedModels,
} from "../../src/renderer/panels/design/design-model.ts";
import { resolveStageView, stageFlags } from "../../src/renderer/panels/stage/stage-flags.ts";
import { stageTabs, tabChoice, tabGlyph } from "../../src/renderer/panels/stage/stage-tabs.ts";
import { isStageView, StageView } from "../../src/renderer/stage.ts";
import {
  DESIGN_MESSAGE_SOURCE,
  designPageFile,
  DesignSignal,
  readDesignSignal,
} from "../../src/shared/design-board.ts";
import { ObserverLive, PREVIEW_OBSERVER } from "../../src/shared/observers.ts";

const preview: LiveView = { live: ObserverLive.Preview, at: ".", observer: PREVIEW_OBSERVER };
const GAME = "bee-siege";

describe("the Design tab on the stage strip", () => {
  it("stands after Builds for every game, and is a plain view the stage remembers", () => {
    const tabs = (hasBuilds: boolean, hasShop = false, designNew = false) =>
      stageTabs({ views: [preview], plugins: [], hasBuilds, buildsLive: false, hasShop, designNew, beside: null });
    assert.deepEqual(
      tabs(false).map((tab) => tab.key),
      ["live", "design", "assets"],
    );
    assert.deepEqual(
      tabs(true, true).map((tab) => tab.key),
      ["live", "builds", "design", "shop", "assets"],
    );
    assert.deepEqual(tabChoice("design", [preview]), { view: StageView.Design });
    assert.equal(tabGlyph({ key: StageView.Design, label: "Design" }, [preview]), "palette");
    assert.equal(isStageView("design"), true, "a remembered Design opens again");
    const label = (designNew: boolean) => tabs(true, false, designNew).find((tab) => tab.key === "design")?.label;
    assert.notEqual(label(true), label(false), "a board the person has not seen marks its tab");
  });

  it("shows for any game, and falls back to Live with none", () => {
    const has = { beside: false, builds: false, project: true };
    assert.equal(resolveStageView(StageView.Design, has), StageView.Design);
    assert.equal(resolveStageView(StageView.Design, { ...has, project: false }), StageView.Live);
  });

  it("takes the stage from the running game while it is open", () => {
    const flags = stageFlags({
      view: StageView.Design,
      beside: null,
      graph: null,
      planning: false,
      project: GAME,
      liveView: ObserverLive.Preview,
      pending: false,
      live: { state: null, liveLoad: null, stopped: false },
    });
    assert.equal(flags.stageView, StageView.Design);
    assert.equal(flags.designOpen, true);
    assert.equal(flags.previewOnStage, false, "Live's page is not what the stage shows");
  });
});

describe("the design wall", () => {
  it("lays artboards out section under section, each at its own size, a section's name above its own", () => {
    const item = (file: string, section = "", width = PAGE_WIDTH, height = PAGE_HEIGHT) => ({
      file,
      section,
      width,
      height,
    });
    const one = boardLayout([item("a")]);
    assert.deepEqual(one.frames, [{ file: "a", x: 0, y: one.frames[0]?.y, width: PAGE_WIDTH, height: PAGE_HEIGHT }]);
    assert.ok((one.frames[0]?.y ?? 0) > 0, "the caption sits above the artboard");
    assert.deepEqual(one.labels, [], "the board's top has no name");
    assert.deepEqual(one.bounds, { x: 0, y: 0, w: PAGE_WIDTH, h: (one.frames[0]?.y ?? 0) + PAGE_HEIGHT });

    const board = boardLayout([
      item("pitch"),
      item("town", "world", 1350, 760),
      item("map", "world", 1200, 2000),
      item("warden", "characters", 760, 760),
    ]);
    const [pitch, town, map, warden] = board.frames;
    assert.ok(pitch && town && map && warden);
    assert.equal(town.y, map.y, "a section's artboards hang from one line");
    assert.ok(map.x >= town.x + town.width, "artboards never overlap");
    assert.deepEqual(
      board.labels.map((label) => label.section),
      ["world", "characters"],
    );
    const [world, characters] = board.labels;
    assert.ok(world && characters);
    assert.ok(world.y > pitch.y + pitch.height, "a section starts below what is above it");
    assert.ok(town.y > world.y, "…and its name stands above its artboards");
    assert.ok(characters.y > map.y + map.height, "…below the tallest artboard of the section above");
    assert.equal(warden.x, 0, "a section starts at the left");
    assert.deepEqual(board.bounds, { x: 0, y: 0, w: map.x + map.width, h: warden.y + warden.height });

    const many = boardLayout(Array.from({ length: 6 }, (_, n) => item(`p${n}`, "world")));
    const wrapped = many.frames.filter((frame) => frame.x === 0);
    assert.ok(wrapped.length > 1, "a long section wraps into rows");
    assert.deepEqual(boardLayout([]), { frames: [], labels: [], bounds: null });
  });

  it("lets a page grow to what it holds, never past the wall's limits and never smaller again", () => {
    assert.deepEqual(sizeAfter(undefined, null), { width: PAGE_WIDTH, height: PAGE_HEIGHT });
    assert.deepEqual(sizeAfter(undefined, { width: 1600, height: 2400 }), { width: 1600, height: 2400 });
    assert.deepEqual(sizeAfter({ width: 1600, height: 2400 }, { width: 900, height: 300 }), {
      width: 1600,
      height: 2400,
    });
    assert.deepEqual(sizeAfter(undefined, { width: 1e9, height: 1e9 }), {
      width: PAGE_MAX_WIDTH,
      height: PAGE_MAX_HEIGHT,
    });
    assert.deepEqual(sizeAfter(undefined, { width: Number.NaN, height: -5 }), {
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
    });
  });

  it("names a page by the title its frame says, else the one its file gives, else its file", () => {
    assert.equal(pageCaption({ name: "01-concept" }, "Bee Siege: concept"), "Bee Siege: concept");
    assert.equal(pageCaption({ name: "01-concept" }, "  "), "Concept");
    assert.equal(pageCaption({ name: "01-concept" }, undefined), "Concept");
    assert.equal(pageCaption({ name: "01-concept", title: "Concept" }, undefined), "Concept");
    assert.equal(pageCaption({ name: "01-concept", title: "Concept" }, "Concept, live"), "Concept, live");
    assert.equal(pageCaption({ name: "01-concept", title: " " }, ""), "Concept");
  });

  it("keeps the page it shows up while a changed one loads behind it", () => {
    assert.deepEqual(heldFrames(undefined, "a?v=1"), { shown: "a?v=1", next: null }, "a page's first address");
    assert.deepEqual(heldFrames("a?v=1", "a?v=1"), { shown: "a?v=1", next: null });
    assert.deepEqual(heldFrames("a?v=1", "a?v=2"), { shown: "a?v=1", next: "a?v=2" }, "the old sheet stays up");
    const pages = [
      { file: "a", url: "a?v=2" },
      { file: "b", url: "b?v=1" },
    ];
    const held = heldAfter({ a: "a?v=1", gone: "gone?v=1" }, pages);
    assert.deepEqual(held, { a: "a?v=1", b: "b?v=1" }, "a new page is held at once, a page that left is dropped");
    assert.equal(heldAfter(held, pages), held, "nothing to hold or drop: the same record");
  });

  it("shows a picture large, at one height and its own shape", () => {
    const wide = pictureSize({ width: 1920, height: 1080 });
    const tall = pictureSize({ width: 600, height: 1200 });
    assert.equal(wide.height, tall.height, "every picture hangs at one height");
    assert.ok(wide.height >= PAGE_HEIGHT * 0.9, "as tall as a page, near enough: it is there to be seen");
    assert.ok(Math.abs(wide.width / wide.height - 16 / 9) < 0.01, "its own shape");
    assert.ok(tall.width < wide.width && tall.width >= 480, "a narrow picture keeps a width that reads");
    assert.ok(pictureSize({ width: 9000, height: 100 }).width <= 1800, "a very wide one is held to a row");
    assert.deepEqual(pictureSize(undefined), pictureSize({ width: 16, height: 9 }), "wide until it has loaded");
    assert.deepEqual(pictureSize({ width: 0, height: 0 }), pictureSize(undefined));
  });

  it("reads a file's or a section's name as a person would", () => {
    assert.equal(displayName("01-the-warden"), "The warden");
    assert.equal(displayName("game_ui"), "Game ui");
    assert.equal(displayName("world"), "World");
    assert.equal(displayName("2026"), "2026", "a name that is only a number stays");
  });

  it("knows which artboards are new or changed since the board was last read", () => {
    const board = [
      { file: "a", url: "a?v=1" },
      { file: "b", url: "b?v=1" },
    ];
    assert.deepEqual(changedFiles(null, board), [], "nothing is new on a board seen for the first time");
    const before = new Map(board.map((item) => [item.file, item.url]));
    assert.deepEqual(changedFiles(before, board), []);
    const after = [{ file: "a", url: "a?v=2" }, board[1]!, { file: "c", url: "c?v=1" }];
    assert.deepEqual(changedFiles(before, after), ["a", "c"]);
  });

  it("stacks the shown artboard on pictures first, then what changed last, three at most", () => {
    const items = [
      { file: "pitch", modifiedAt: 10, kind: "page" },
      { file: "loop", modifiedAt: 50, kind: "page" },
      { file: "town", modifiedAt: 20, kind: "picture" },
      { file: "fires", modifiedAt: 30, kind: "picture" },
    ];
    assert.deepEqual(
      boardStack(items, "pitch").map((item) => item.file),
      ["pitch", "fires", "town"],
    );
    assert.deepEqual(
      boardStack(items.slice(0, 2), "loop").map((item) => item.file),
      ["loop", "pitch"],
    );
    assert.deepEqual(boardStack(items, "gone"), [], "an artboard the board no longer holds has no stack");
  });

  // A model showed as a cube until it was pressed, which nothing on the tile said to do.
  it("turns a board's models by itself, the first few in the board's order, and leaves the rest to a press", () => {
    const items = [
      { file: "pitch.html", kind: "page" },
      ...Array.from({ length: MODELS_TURNED_MAX + 2 }, (_, index) => ({ file: `hero-${index}.glb`, kind: "model" })),
      { file: "town.png", kind: "picture" },
    ];
    const turned = turnedModels(items);
    assert.equal(turned.size, MODELS_TURNED_MAX);
    assert.deepEqual([...turned].slice(0, 2), ["hero-0.glb", "hero-1.glb"], "in the board's order");
    assert.equal(turned.has(`hero-${MODELS_TURNED_MAX}.glb`), false, "past the limit a model waits for a press");
    assert.equal(turnedModels(items.slice(0, 2)).has("pitch.html"), false, "a page is no model");
    assert.equal(turnedModels([]).size, 0);
  });

  it("marks a board new until the person has looked at it", () => {
    assert.equal(boardIsNew({ pages: 2, stamp: "abc" }, null), true);
    assert.equal(boardIsNew({ pages: 2, stamp: "abc" }, "abc"), false);
    assert.equal(boardIsNew({ pages: 2, stamp: "abd" }, "abc"), true);
    assert.equal(boardIsNew({ pages: 0, stamp: "" }, null), false, "an empty board has nothing new");
  });

  it("reads which page a file the chat names is, and no other file", () => {
    assert.equal(designPageFile("docs/design/concept.html"), "docs/design/concept.html");
    assert.equal(designPageFile("./docs/design/concept.html"), "docs/design/concept.html");
    assert.equal(designPageFile("concept.html"), "docs/design/concept.html", "a bare name is a page of the board");
    for (const other of ["docs/design/img/inner.html", "index.html/..", "docs/design/notes.md", "../x.html", "", 7])
      assert.equal(designPageFile(other), null, String(other));
  });
});

describe("what a design page's frame may tell the tab", () => {
  const from = (body: Record<string, unknown>) => readDesignSignal({ source: DESIGN_MESSAGE_SOURCE, ...body });

  it("reads the page's title and size, cut to what a caption and a wall hold", () => {
    assert.deepEqual(from({ type: DesignSignal.Page, title: "Concept", width: 1400.4, height: 900 }), {
      type: DesignSignal.Page,
      title: "Concept",
      width: 1401,
      height: 900,
    });
    const long = from({ type: DesignSignal.Page, title: "t".repeat(500), width: 10, height: 10 });
    assert.ok(long?.type === DesignSignal.Page && long.title.length <= 120);
    assert.equal(from({ type: DesignSignal.Page, title: 7, width: "wide", height: 1 }), null);
  });

  // Flipped: a page's button once said its words through the frame. Pages have no buttons now.
  it("believes no message that says a button was pressed", () => {
    assert.equal(from({ type: "say", text: "Build concept B" }), null);
  });

  it("reads a link to another page or to the web, and nothing that could run or read a file", () => {
    assert.deepEqual(from({ type: DesignSignal.Open, file: "docs/design/world/loop.html" }), {
      type: DesignSignal.Open,
      file: "docs/design/world/loop.html",
    });
    assert.deepEqual(from({ type: DesignSignal.Link, url: "https://example.com/a?b=1" }), {
      type: DesignSignal.Link,
      url: "https://example.com/a?b=1",
    });
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "http://example.com/", "genex-design://x/y", "", 7])
      assert.equal(from({ type: DesignSignal.Link, url }), null, String(url));
    for (const file of [
      "../index.html",
      "loop.html",
      "docs/design/a/b/c.html",
      "docs/design/loop.js",
      "docs/design/img/x.html",
      "",
      "x".repeat(300),
    ])
      assert.equal(from({ type: DesignSignal.Open, file }), null, file);
  });

  it("reads a wheel and a drag as bounded numbers", () => {
    assert.deepEqual(from({ type: DesignSignal.Wheel, dy: 120, x: 30, y: 40, pinch: true }), {
      type: DesignSignal.Wheel,
      dy: 120,
      x: 30,
      y: 40,
      pinch: true,
    });
    assert.deepEqual(from({ type: DesignSignal.Drag, dx: 4, dy: -6, end: false }), {
      type: DesignSignal.Drag,
      dx: 4,
      dy: -6,
      end: false,
    });
    assert.equal(from({ type: DesignSignal.Wheel, dy: "fast", x: 0, y: 0 }), null);
    assert.equal(from({ type: DesignSignal.Drag, dx: Number.POSITIVE_INFINITY, dy: 0 }), null);
  });

  it("ignores anything that is not a design page's message", () => {
    for (const data of [
      null,
      "say",
      7,
      [],
      { type: DesignSignal.Link, url: "https://example.com/" },
      { source: "other" },
    ])
      assert.equal(readDesignSignal(data), null);
    assert.equal(from({ type: "run", code: "alert(1)" }), null);
  });
});

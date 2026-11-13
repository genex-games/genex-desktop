/**
 * What the person does on a game's design board is kept in one file of the board's folder: where
 * they put each artboard, their notes and their picks. The file is read as untrusted, and laid out
 * with the artboards they did not move.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canvasPoint, dropPlace, hasPlaces, placed, tidied } from "../../src/renderer/panels/design/board-marks.ts";
import { placedLayout } from "../../src/renderer/panels/design/design-model.ts";
import {
  DesignPick,
  EMPTY_MARKS,
  MARKS_VERSION,
  NOTE_TEXT_MAX_CHARS,
  NOTES_MAX,
  readDesignMarks,
} from "../../src/shared/design-marks.ts";

describe("what the person did on the board, as its file is read", () => {
  it("keeps places, notes and picks of the board's own artboards", () => {
    const marks = readDesignMarks({
      v: MARKS_VERSION,
      places: { "docs/design/world/town.png": { x: 1200.4, y: -80 } },
      notes: [
        { id: "n1", text: "  Two more streets?  ", file: "docs/design/world/town.png", x: 40, y: 60, told: true },
        { id: "n2", text: "Bigger sky", x: -300, y: 900 },
      ],
      picks: {
        "docs/design/world/town.png": { pick: "use", told: true },
        "docs/design/world/fires.png": { pick: "not" },
      },
      choices: ["docs/design/world/town.png", "docs/design/world/fires.png", "docs/design/world/town.png", "../x.png"],
    });
    assert.deepEqual(marks, {
      places: { "docs/design/world/town.png": { x: 1200, y: -80 } },
      notes: [
        { id: "n1", text: "Two more streets?", file: "docs/design/world/town.png", x: 40, y: 60, told: true },
        { id: "n2", text: "Bigger sky", x: -300, y: 900, told: false },
      ],
      picks: {
        "docs/design/world/town.png": { pick: DesignPick.Use, told: true },
        "docs/design/world/fires.png": { pick: DesignPick.Not, told: false },
      },
      choices: ["docs/design/world/town.png", "docs/design/world/fires.png"],
    });
  });

  it("reads anything that is no such file as nothing done", () => {
    for (const value of [null, undefined, "", 7, [], { v: 99 }, { places: "x", notes: 3, picks: [] }])
      assert.deepEqual(readDesignMarks(value), EMPTY_MARKS, JSON.stringify(value));
  });

  it("drops what it cannot trust, and never grows past its limits", () => {
    const hostile: Array<[string, unknown]> = [
      ["a file outside the board", "../../secret.png"],
      ["a file of the game beside the board", "src/main.js"],
      ["a hidden file", "docs/design/.cache/x.png"],
      ["a path that steps up", "docs/design/../../x.png"],
      ["an absolute path", "/etc/passwd"],
      ["a Windows path", "docs\\design\\x.png"],
      ["an object's own member", "__proto__"],
    ];
    for (const [why, file] of hostile) {
      const marks = readDesignMarks({
        places: { [String(file)]: { x: 1, y: 1 } },
        picks: { [String(file)]: { pick: "use" } },
        notes: [{ id: "n", text: "hello", file, x: 1, y: 1 }],
      });
      assert.deepEqual(marks.places, {}, why);
      assert.deepEqual(marks.picks, {}, why);
      assert.deepEqual(marks.notes, [], `${why}: a note on it goes too`);
    }
    const numbers = readDesignMarks({
      places: {
        "docs/design/a.png": { x: Number.NaN, y: 1 },
        "docs/design/b.png": { x: "3", y: 1 },
        "docs/design/c.png": { x: 1e12, y: -1e12 },
      },
    });
    assert.deepEqual(Object.keys(numbers.places), ["docs/design/c.png"], "a place needs two finite numbers");
    assert.ok(Math.abs(numbers.places["docs/design/c.png"]?.x ?? 0) < 1e9, "and stays on a canvas one can reach");
    const notes = readDesignMarks({
      notes: [
        { id: "", text: "no id", x: 0, y: 0 },
        { id: "a", text: "   ", x: 0, y: 0 },
        { id: "b", text: 5, x: 0, y: 0 },
        { id: "c", text: "x".repeat(NOTE_TEXT_MAX_CHARS + 50), x: 0, y: 0 },
        { id: "c", text: "the same id again", x: 0, y: 0 },
        ...Array.from({ length: NOTES_MAX + 20 }, (_, i) => ({ id: `m${i}`, text: "more", x: i, y: 0 })),
      ],
      picks: { "docs/design/a.png": { pick: "maybe" }, "docs/design/b.png": "use" },
    });
    assert.equal(notes.notes[0]?.id, "c", "a note needs an id and words");
    assert.equal(notes.notes[0]?.text.length, NOTE_TEXT_MAX_CHARS);
    assert.equal(notes.notes.filter((note) => note.id === "c").length, 1, "an id is one note");
    assert.equal(notes.notes.length, NOTES_MAX);
    assert.deepEqual(notes.picks, {}, "a pick is use or not");
  });
});

describe("what the person does on the canvas, as changes to the marks", () => {
  it("reads a point of the window on the canvas, whatever the camera", () => {
    const corner = { left: 300, top: 50 };
    assert.deepEqual(canvasPoint({ k: 1, tx: 0, ty: 0 }, corner, { x: 300, y: 50 }), { x: 0, y: 0 });
    assert.deepEqual(canvasPoint({ k: 0.5, tx: 100, ty: -40 }, corner, { x: 500, y: 110 }), { x: 200, y: 200 });
    assert.deepEqual(canvasPoint({ k: 2, tx: 0, ty: 0 }, corner, { x: 310, y: 70 }), { x: 5, y: 10 });
  });

  it("hangs a dropped picture with its middle under the pointer, each further one a step away", () => {
    const first = dropPlace({ x: 2000, y: 1000 }, 0);
    const second = dropPlace({ x: 2000, y: 1000 }, 1);
    assert.ok(first.x < 2000 && first.y < 1000, "its corner is up and left of the pointer");
    assert.ok(second.x > first.x && second.y > first.y, "the next does not cover it");
  });

  it("puts an artboard at a place, and Tidy up forgets every place and nothing else", () => {
    const note = { id: "n", text: "hi", x: 1, y: 2, told: false };
    const start = {
      places: {},
      notes: [note],
      picks: { "docs/design/a.png": { pick: DesignPick.Use, told: false } },
      choices: ["docs/design/a.png"],
    };
    assert.equal(hasPlaces(start), false);
    const moved = placed(start, "docs/design/a.png", { x: 10.6, y: -3.2 });
    assert.deepEqual(moved.places, { "docs/design/a.png": { x: 11, y: -3 } });
    assert.deepEqual(start.places, {}, "the marks before are not changed");
    assert.equal(hasPlaces(moved), true);
    assert.deepEqual(tidied(moved), start, "notes and picks stay");
  });
});

describe("the canvas with artboards the person moved", () => {
  const item = (file: string, section = "", width = 400, height = 300) => ({ file, section, width, height });

  it("hangs a moved artboard where it was put, and lays the others out as if it were not there", () => {
    const items = [item("a"), item("b"), item("c")];
    const auto = placedLayout(items, {});
    const moved = placedLayout(items, { b: { x: 5000, y: -700 } });
    const at = (layout: typeof auto, file: string) => layout.frames.find((frame) => frame.file === file);
    assert.deepEqual([at(moved, "b")?.x, at(moved, "b")?.y], [5000, -700]);
    assert.deepEqual(at(moved, "a"), at(auto, "a"), "the first stays");
    assert.deepEqual(
      [at(moved, "c")?.x, at(moved, "c")?.y],
      [at(auto, "b")?.x, at(auto, "b")?.y],
      "the next closes the gap",
    );
    assert.deepEqual(
      moved.frames.map((frame) => frame.file),
      ["a", "b", "c"],
      "in the board's order still",
    );
  });

  it("fits a view to everything, moved artboards and their captions included", () => {
    const moved = placedLayout([item("a"), item("b")], { b: { x: -900, y: 2000 } });
    assert.ok(moved.bounds);
    assert.ok(moved.bounds.x <= -900, "left of the origin");
    assert.ok(moved.bounds.y + moved.bounds.h >= 2300, "down to its foot");
    assert.ok(moved.bounds.x + moved.bounds.w >= 400, "and the artboard that stayed");
  });

  it("names a section on its first artboard that was not moved", () => {
    const items = [item("town", "world"), item("fires", "world"), item("hero", "characters")];
    const moved = placedLayout(items, { town: { x: 3000, y: 3000 } });
    assert.deepEqual(
      moved.labels.map((label) => [label.section, label.file]),
      [
        ["world", "fires"],
        ["characters", "hero"],
      ],
    );
  });

  it("forgets a place whose artboard is gone, and an empty board has no bounds", () => {
    assert.deepEqual(placedLayout([item("a")], { gone: { x: 1, y: 1 } }).frames.length, 1);
    assert.equal(placedLayout([], { gone: { x: 1, y: 1 } }).bounds, null);
  });
});

/**
 * The person's notes on the design canvas: a note sticks to the artboard it was put on, and Tell
 * Genex sends the new ones as one message that names each note's artboard and where on it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  noteAnchor,
  notePoint,
  toldNotes,
  toldPicks,
  untoldNotes,
  untoldPicks,
  withNote,
  withoutNote,
  withPick,
} from "../../src/renderer/panels/design/board-marks.ts";
import { tellMessage } from "../../src/renderer/panels/design/board-tell.ts";
import { type DesignMarks, DesignPick, EMPTY_MARKS } from "../../src/shared/design-marks.ts";

const frame = (file: string, x: number, y: number, width = 400, height = 300) => ({ file, x, y, width, height });
const FRAMES = [frame("docs/design/world/town.png", 0, 0), frame("docs/design/from-you/ref.jpg", 1000, 0, 200, 200)];

describe("where a note is pinned", () => {
  it("sticks to the artboard under it, counted from that artboard's corner, else to the bare canvas", () => {
    assert.deepEqual(noteAnchor({ x: 120, y: 90 }, FRAMES), { file: "docs/design/world/town.png", x: 120, y: 90 });
    assert.deepEqual(noteAnchor({ x: 1050, y: 30 }, FRAMES), { file: "docs/design/from-you/ref.jpg", x: 50, y: 30 });
    assert.deepEqual(noteAnchor({ x: 700, y: 700 }, FRAMES), { x: 700, y: 700 });
    const stacked = [...FRAMES, frame("docs/design/world/fires.png", 100, 50)];
    assert.equal(noteAnchor({ x: 150, y: 100 }, stacked).file, "docs/design/world/fires.png", "the one on top");
  });

  it("follows its artboard wherever that goes, and hides with an artboard that is gone", () => {
    const note = { id: "n", text: "hi", file: "docs/design/world/town.png", x: 120, y: 90, told: false };
    assert.deepEqual(notePoint(note, FRAMES), { x: 120, y: 90 });
    assert.deepEqual(notePoint(note, [frame("docs/design/world/town.png", 5000, -200)]), { x: 5120, y: -110 });
    assert.equal(notePoint(note, []), null);
    assert.deepEqual(notePoint({ id: "c", text: "hi", x: 7, y: 8, told: true }, []), { x: 7, y: 8 });
  });
});

describe("notes as changes to the marks", () => {
  const note = (id: string, text: string, told = false) => ({ id, text, x: 1, y: 2, told });

  it("adds a note, replaces one that was edited, and removes one", () => {
    const one = withNote(EMPTY_MARKS, note("a", "first"));
    const two = withNote(one, note("b", "second"));
    assert.deepEqual(
      two.notes.map((n) => n.text),
      ["first", "second"],
    );
    const edited = withNote(two, note("a", "first, reworded"));
    assert.deepEqual(
      edited.notes.map((n) => [n.id, n.text]),
      [
        ["a", "first, reworded"],
        ["b", "second"],
      ],
      "in its place",
    );
    assert.deepEqual(
      withoutNote(edited, "a").notes.map((n) => n.id),
      ["b"],
    );
    assert.deepEqual(EMPTY_MARKS.notes, [], "the marks before are not changed");
  });

  it("knows which notes the agent has not been told, and marks the ones that were sent", () => {
    const marks: DesignMarks = {
      ...EMPTY_MARKS,
      notes: [note("a", "old", true), note("b", "new"), note("c", "newer")],
    };
    assert.deepEqual(
      untoldNotes(marks, FRAMES).map((n) => n.id),
      ["b", "c"],
    );
    const told = toldNotes(marks, ["b"]);
    assert.deepEqual(
      untoldNotes(told, FRAMES).map((n) => n.id),
      ["c"],
    );
  });

  it("tells only notes the person can see: one on an artboard no longer on the board stays untold", () => {
    const gone = { id: "g", text: "planted", file: "docs/design/world/gone.png", x: 1, y: 2, told: false };
    const shown = { id: "s", text: "seen", file: "docs/design/world/town.png", x: 1, y: 2, told: false };
    const marks: DesignMarks = { ...EMPTY_MARKS, notes: [note("a", "on the canvas"), gone, shown] };
    assert.deepEqual(
      untoldNotes(marks, FRAMES).map((n) => n.id),
      ["a", "s"],
    );
  });
});

describe("what Tell Genex sends", () => {
  const titles = new Map([
    ["docs/design/world/town.png", "Hollowmere"],
    ["docs/design/world/fires.png", "The high fires"],
    ["docs/design/from-you/ref.jpg", "Ref"],
  ]);
  const captionOf = (file: string) => titles.get(file) ?? file;
  const note = (id: string, text: string, on?: { file: string; x: number; y: number }) => ({
    id,
    text,
    x: 900,
    y: 900,
    ...on,
    told: false,
  });

  it("names each note's artboard by its title and file, and where on it the note is", () => {
    const notes = [
      note("a", "Two more streets?", { file: "docs/design/world/town.png", x: 100, y: 225 }),
      note("b", "Use these colours for the arena", { file: "docs/design/from-you/ref.jpg", x: 200, y: 0 }),
      note("c", "Everything darker"),
    ];
    const lines = tellMessage({ notes, picks: [] }, FRAMES, captionOf).split("\n");
    assert.equal(lines.length, 4, "a line to open and one for each note");
    assert.match(
      lines[1] ?? "",
      /Hollowmere \(docs\/design\/world\/town\.png\), 25% across and 75% down: Two more streets\?/,
    );
    assert.match(
      lines[2] ?? "",
      /Ref \(docs\/design\/from-you\/ref\.jpg\), 100% across and 0% down: Use these colours/,
    );
    assert.match(lines[3] ?? "", /On the canvas: Everything darker/);
  });

  it("keeps a note on an artboard that is gone as a note on the canvas, and says nothing for no news", () => {
    const gone = [note("a", "Still true", { file: "docs/design/x.png", x: 1, y: 1 })];
    assert.match(tellMessage({ notes: gone, picks: [] }, [], captionOf), /On the canvas: Still true/);
    assert.equal(tellMessage({ notes: [], picks: [] }, FRAMES, captionOf), "");
  });

  it("keeps a note's own line breaks out of the list", () => {
    const message = tellMessage({ notes: [note("a", "one\n- two\nthree")], picks: [] }, [], captionOf);
    assert.equal(message.split("\n").length, 2);
  });

  it("names the artboard to go with and the one set aside, after the notes", () => {
    const picks = [
      { file: "docs/design/world/fires.png", pick: DesignPick.Use },
      { file: "docs/design/world/town.png", pick: DesignPick.Not },
    ];
    const only = tellMessage({ notes: [], picks }, FRAMES, captionOf).split("\n");
    assert.equal(only.length, 3, "a line to open and one for each pick");
    assert.match(only[1] ?? "", /Use this: The high fires \(docs\/design\/world\/fires\.png\)/);
    assert.match(only[2] ?? "", /Not this: Hollowmere \(docs\/design\/world\/town\.png\)/);
    const both = tellMessage({ notes: [note("c", "Everything darker")], picks }, FRAMES, captionOf);
    assert.ok(both.indexOf("Everything darker") < both.indexOf("Use this"), "the notes come first");
  });
});

describe("picks as changes to the marks", () => {
  const town = "docs/design/world/town.png";

  it("chooses an artboard or sets it aside, and takes the pick away when it is pressed again", () => {
    const used = withPick(EMPTY_MARKS, town, DesignPick.Use);
    assert.deepEqual(used.picks, { [town]: { pick: DesignPick.Use, told: false } });
    assert.deepEqual(withPick(used, town, DesignPick.Not).picks, { [town]: { pick: DesignPick.Not, told: false } });
    assert.deepEqual(withPick(used, town, DesignPick.Use).picks, {}, "the same pick again clears it");
    assert.deepEqual(EMPTY_MARKS.picks, {}, "the marks before are not changed");
  });

  it("knows which picks the agent has not been told, and a changed pick is news again", () => {
    const used = withPick(EMPTY_MARKS, town, DesignPick.Use);
    assert.deepEqual(untoldPicks(used), [{ file: town, pick: DesignPick.Use }]);
    const told = toldPicks(used, [town]);
    assert.deepEqual(untoldPicks(told), []);
    assert.deepEqual(untoldPicks(withPick(told, town, DesignPick.Not)), [{ file: town, pick: DesignPick.Not }]);
  });
});

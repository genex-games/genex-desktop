/**
 * The agent on the canvas: `show_design` can point at a spot of an artboard, and can say which
 * artboards it is about to make, so the canvas shows them being drawn before their files exist.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { callProjectTool } from "../../src/main/core/project-tools.ts";
import { askForPage, makingOn, noteMaking, takeAskedPage } from "../../src/renderer/panels/design/design-asks.ts";
import { MAKING_FRESH_MS, makingNow, withGhosts } from "../../src/renderer/panels/design/design-model.ts";
import { MAKING_MAX, readDesignMaking, readDesignSpot } from "../../src/shared/design-board.ts";
import { ProjectTool } from "../../src/shared/project-tools.ts";
import { UiEvent, type UiEvent as UiEventRecord } from "../../src/shared/ui-events.ts";
import { coreLite } from "../helpers/core-lite.ts";

/** A core with one game, a way to write its files, the tool, and what the app was told. */
async function studio() {
  const told: UiEventRecord[] = [];
  const lite = await coreLite({ onUiEvent: (event) => told.push(event) });
  await lite.core.games.scaffold("bees", { title: "Bees" });
  const root = lite.core.games.dirFor("bees");
  const write = (file: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "PNG");
  };
  const show = (args: Record<string, unknown>) =>
    callProjectTool(lite.core, null as never, ProjectTool.ShowDesign, args, { project: "bees" });
  const events = (type: string) => told.filter((event) => event.type === type).map((event) => event.payload);
  return { ...lite, write, show, events };
}

describe("where the agent points", () => {
  it("reads a spot as percent across and percent down, however it is written", () => {
    const read: Array<[unknown, { x: number; y: number } | null]> = [
      ["40,70", { x: 40, y: 70 }],
      ["40% 70%", { x: 40, y: 70 }],
      [" 12.6 , 0 ", { x: 13, y: 0 }],
      [
        { x: 100, y: 55.4 },
        { x: 100, y: 55 },
      ],
      [[25, 75], { x: 25, y: 75 }],
      ["140,-20", { x: 100, y: 0 }],
      ["", null],
      ["middle", null],
      ["40", null],
      ["40,70,10", null],
      [{ x: "a", y: 1 }, null],
      [{ x: Number.NaN, y: 1 }, null],
      [null, null],
      [undefined, null],
      [42, null],
    ];
    for (const [value, spot] of read) assert.deepEqual(readDesignSpot(value), spot, JSON.stringify(value));
  });

  it("reads the artboards being made as the board's own files, each once, a handful at most", () => {
    assert.deepEqual(readDesignMaking(["world/fires.png", "docs/design/world/fires.png", "01-pitch.html"]), [
      "docs/design/world/fires.png",
      "docs/design/01-pitch.html",
    ]);
    assert.deepEqual(readDesignMaking("world/fires.png"), ["docs/design/world/fires.png"], "one file as plain words");
    const hostile = [
      "../../secret.png",
      "/etc/passwd",
      "src/main.js",
      "docs/design/.cache/x.png",
      7,
      null,
      "notes.txt",
    ];
    assert.deepEqual(readDesignMaking(hostile), []);
    for (const value of [null, undefined, 7, {}, ""]) assert.deepEqual(readDesignMaking(value), []);
    const many = Array.from({ length: MAKING_MAX + 5 }, (_, i) => `world/place-${i}.png`);
    assert.equal(readDesignMaking(many).length, MAKING_MAX);
  });
});

describe("show_design, pointing and saying what is being made", () => {
  it("points at a spot of the artboard it shows, with the note said there", async () => {
    const { write, show, events, close } = await studio();
    try {
      write("docs/design/world/town.png");
      await show({ page: "world/town.png", note: "Moved the well next to the gate", spot: "40,70" });
      await show({ page: "world/town.png", note: "The whole map", spot: "over there" });
      await show({ page: "world/town.png" });
      assert.deepEqual(events(UiEvent.DesignShown), [
        {
          project: "bees",
          file: "docs/design/world/town.png",
          note: "Moved the well next to the gate",
          spot: { x: 40, y: 70 },
        },
        { project: "bees", file: "docs/design/world/town.png", note: "The whole map" },
        { project: "bees", file: "docs/design/world/town.png", note: "" },
      ]);
    } finally {
      await close();
    }
  });

  it("tells the canvas which artboards are being made, and makes no file itself", async () => {
    const { core, show, events, close } = await studio();
    try {
      const answer = String(await show({ making: ["world/fires.png", "../../x.png", "characters/wyrm.glb"] }));
      assert.match(answer, /docs\/design\/world\/fires\.png/);
      assert.doesNotMatch(answer, /How to design on Genex's Design tab/, "no guide for a call that only announces");
      assert.deepEqual(events(UiEvent.DesignMaking), [
        { project: "bees", files: ["docs/design/world/fires.png", "docs/design/characters/wyrm.glb"] },
      ]);
      assert.deepEqual(events(UiEvent.DesignShown), [], "nothing is shown yet");
      assert.deepEqual((await core.design.board("bees")).items, [], "and nothing was written");
      // Nothing valid to make: the call is read as the plain one, which answers the guide.
      assert.match(String(await show({ making: ["../../x.png"] })), /How to design on Genex's Design tab/);
      assert.equal(events(UiEvent.DesignMaking).length, 1);
    } finally {
      await close();
    }
  });
});

describe("show_design, offering artboards to pick among", () => {
  it("keeps the choices with the board, tells the canvas, and leaves what the person did alone", async () => {
    const { core, write, show, events, close } = await studio();
    const town = "docs/design/world/town.png";
    const fires = "docs/design/world/fires.png";
    write(town);
    write(fires);
    try {
      const note = { id: "n1", text: "Two more streets?", file: town, x: 20, y: 30, told: false };
      await core.design.saveMarks("bees", { places: {}, notes: [note], picks: {}, choices: [] });
      const answer = String(
        await show({ choose: ["world/town.png", "world/fires.png", "../../x.png", "world/gone.png"] }),
      );
      assert.match(answer, /Use this/, "the answer says what the person now sees");
      const kept = await core.design.marks("bees");
      assert.deepEqual(kept.choices, [town, fires], "only artboards the board holds");
      assert.deepEqual(kept.notes, [note], "the person's notes stay");
      await show({ choose: ["world/fires.png"] });
      assert.deepEqual((await core.design.marks("bees")).choices, [fires], "a new offer replaces the last");
      await show({ choose: [] });
      assert.deepEqual((await core.design.marks("bees")).choices, [], "an empty offer ends the choosing");
      assert.deepEqual(
        events(UiEvent.DesignChoices).map((event) => (event as { files: string[] }).files),
        [[town, fires], [fires], []],
        "the canvas hears each offer",
      );
    } finally {
      await close();
    }
  });
});

describe("the board's marks, saved while another save is still writing", () => {
  it("keeps the last save whole, never a mix of two", async () => {
    const { core, close } = await studio();
    try {
      const notes = (count: number) =>
        Array.from({ length: count }, (_, i) => ({ id: `n${i}`, text: "x".repeat(500), x: i, y: i, told: false }));
      const saves = [120, 60, 30, 1].map((count) =>
        core.design.saveMarks("bees", { places: {}, notes: notes(count), picks: {}, choices: [] }),
      );
      assert.deepEqual(await Promise.all(saves), [true, true, true, true]);
      const root = core.games.dirFor("bees");
      const text = fs.readFileSync(path.join(root, "docs/design/.genex-board.json"), "utf8");
      assert.doesNotThrow(() => JSON.parse(text), "the file parses");
      assert.deepEqual(
        (await core.design.marks("bees")).notes.map((note) => note.id),
        ["n0"],
        "the last save is what the board holds",
      );
    } finally {
      await close();
    }
  });
});

describe("the canvas, asked to point", () => {
  it("keeps where the agent pointed with the artboard it asked for, taken once", () => {
    askForPage("bees", "docs/design/world/town.png", { spot: { x: 40, y: 70 }, note: "The well" });
    assert.equal(takeAskedPage("bees", ["docs/design/other.png"]), null, "until the board holds it");
    assert.deepEqual(takeAskedPage("bees", ["docs/design/world/town.png"]), {
      file: "docs/design/world/town.png",
      spot: { x: 40, y: 70 },
      note: "The well",
    });
    assert.equal(takeAskedPage("bees", ["docs/design/world/town.png"]), null);
    askForPage("bees", "docs/design/world/town.png");
    assert.deepEqual(takeAskedPage("bees", ["docs/design/world/town.png"]), { file: "docs/design/world/town.png" });
  });
});

describe("artboards being made, on the canvas", () => {
  const fires = "docs/design/world/fires.png";
  const wyrm = "docs/design/characters/wyrm.glb";

  it("keeps what each game's agent said it is making, the newest list only", () => {
    noteMaking("bees", [fires, wyrm], 1000);
    noteMaking("ants", [wyrm], 1000);
    assert.deepEqual(makingOn("bees"), { files: [fires, wyrm], at: 1000 });
    noteMaking("bees", [wyrm], 2000);
    assert.deepEqual(makingOn("bees"), { files: [wyrm], at: 2000 });
    assert.deepEqual(makingOn("ants"), { files: [wyrm], at: 1000 });
    assert.equal(makingOn("wasps"), null);
  });

  it("shows what is still to come: not what the board already holds, and not a list gone stale", () => {
    const declared = { files: [fires, wyrm], at: 1000 };
    assert.deepEqual(makingNow(declared, [], 2000), [fires, wyrm]);
    assert.deepEqual(makingNow(declared, [fires], 2000), [wyrm], "a file that arrived is an artboard now");
    assert.deepEqual(makingNow(declared, [], 1000 + MAKING_FRESH_MS + 1), [], "an agent that never made them");
    assert.deepEqual(makingNow(null, [], 2000), []);
  });

  it("hangs each one at the end of its own section, and a new section at the end of the board", () => {
    const item = (file: string, section: string) => ({ file, section });
    const board = [item("pitch", ""), item("town", "world"), item("hero", "characters")];
    const ghosts = [item("fires", "world"), item("wyrm", "characters"), item("hud", "game-ui"), item("loop", "")];
    assert.deepEqual(
      withGhosts(board, ghosts).map((one) => one.file),
      ["pitch", "loop", "town", "fires", "hero", "wyrm", "hud"],
    );
    assert.deepEqual(withGhosts(board, []), board);
    assert.deepEqual(
      withGhosts([], ghosts.slice(0, 2)).map((one) => one.file),
      ["fires", "wyrm"],
      "an empty board takes them in the order they will be made",
    );
  });
});

/**
 * `show_design`, the design board's tool: the chat's own session is handed it, it says how to
 * write a page when asked with none, and with a page of the game's board it tells the app to open
 * the Design tab on it and leaves the page's card in the game's chat. It never writes a file, and
 * it shows nothing that is not a page of the board. The board the tab reads is the same files, each at an address only its game's
 * host answers.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { callProjectTool, projectTools, ProjectToolSeat } from "../../src/main/core/project-tools.ts";
import { CustomEvent, customEvent } from "../../src/shared/custom-events.ts";
import { DESIGN_FOLDER, DESIGN_SCHEME, NOTE_MAX_CHARS } from "../../src/shared/design-board.ts";
import { DESIGN_MARKS_FILE, EMPTY_MARKS } from "../../src/shared/design-marks.ts";
import { CoreFact, type GameKind } from "../../src/shared/project-facts.ts";
import { ProjectTool } from "../../src/shared/project-tools.ts";
import { UiEvent, type UiEvent as UiEventRecord } from "../../src/shared/ui-events.ts";
import { coreLite } from "../helpers/core-lite.ts";

const PAGE = "<!doctype html><title>Concept</title><h1>Bee siege</h1>";

/** A core with one game, and what it told the app. */
async function studio() {
  const told: UiEventRecord[] = [];
  const lite = await coreLite({ onUiEvent: (event) => told.push(event) });
  await lite.core.games.scaffold("bees", { title: "Bees" });
  const root = lite.core.games.dirFor("bees");
  const write = (file: string, text = PAGE): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const show = (args: Record<string, unknown>, threadId?: string) =>
    callProjectTool(lite.core, null as never, ProjectTool.ShowDesign, args, { project: "bees", threadId });
  /** The cards a chat holds: its `design_shown` records, in order. */
  const cards = async (threadId: string) =>
    (await lite.core.store.listEvents(threadId)).flatMap((event) => {
      const card = customEvent(event, CustomEvent.DesignShown);
      return card ? [card] : [];
    });
  const shown = () => told.filter((event) => event.type === UiEvent.DesignShown).map((event) => event.payload);
  return { ...lite, root, write, show, shown, cards };
}

describe("show_design", () => {
  it("is handed to the chat's own session only: a build's lead works in a folder the board does not read", () => {
    const web: GameKind = { facts: [{ id: CoreFact.WebGame, path: "." }] };
    const unreal: GameKind = { facts: [{ id: CoreFact.UnrealProject, path: "." }] };
    const named = (game: GameKind, seat: ProjectToolSeat) => projectTools(game, seat).map((tool) => tool.name);
    for (const game of [web, unreal]) {
      assert.ok(named(game, ProjectToolSeat.Chat).includes(ProjectTool.ShowDesign));
      for (const seat of [ProjectToolSeat.Lead, ProjectToolSeat.Worker, ProjectToolSeat.Reviewer, ProjectToolSeat.None])
        assert.ok(!named(game, seat).includes(ProjectTool.ShowDesign), seat);
    }
  });

  it("says how to write a page when asked with none, and shows nothing", async () => {
    const { show, shown, close } = await studio();
    try {
      for (const args of [{}, { page: "" }, { page: null }]) {
        const guide = String(await show(args));
        assert.match(guide, new RegExp(`Files in ${DESIGN_FOLDER}/`));
        assert.doesNotMatch(guide, /data-say/, "pages have no buttons");
        assert.match(guide, /scripts never run/);
        for (const part of [
          "FROM THE PERSON",
          "NO BUTTONS",
          "pins notes on artboards",
          "Their picks reach you the same way",
          "PICTURES FIRST",
          "LIVE",
          "../../assets/",
          "ON THE BOARD NOW",
        ])
          assert.ok(guide.includes(part), `the guide says ${part}`);
      }
      assert.deepEqual(shown(), []);
    } finally {
      await close();
    }
  });

  it("opens the Design tab on a page of the game's board, named with or without its folder", async () => {
    const { show, shown, write, close } = await studio();
    try {
      write("docs/design/01-concept.html");
      assert.match(
        String(await show({ page: "01-concept.html" })),
        /Design tab is open on docs\/design\/01-concept\.html/,
      );
      await show({ page: "docs/design/01-concept.html" });
      // Flipped: the event named the game and the artboard only; it now carries the agent's words too (empty here).
      const page = { project: "bees", file: "docs/design/01-concept.html", note: "" };
      assert.deepEqual(shown(), [page, page]);
    } finally {
      await close();
    }
  });

  it("leaves the page's card in the game's own chat: its file, its title and the agent's note", async () => {
    const { core, show, cards, write, close } = await studio();
    try {
      write("docs/design/01-concept.html");
      const chat = await core.threadForGame("bees");
      await show({ page: "01-concept.html", note: "  Three directions: pick one  " }, chat);
      await show({ page: "01-concept.html", note: "x".repeat(NOTE_MAX_CHARS + 50) }, chat);
      await show({ page: "01-concept.html", note: 7 }, chat);
      const card = { project: "bees", file: "docs/design/01-concept.html", title: "Concept" };
      assert.deepEqual(await cards(chat), [
        { ...card, note: "Three directions: pick one" },
        { ...card, note: "x".repeat(NOTE_MAX_CHARS) },
        { ...card, note: "" },
      ]);
    } finally {
      await close();
    }
  });

  it("leaves no card for a page it did not show, outside a chat, or in another game's chat", async () => {
    const { core, show, shown, cards, write, close } = await studio();
    try {
      write("docs/design/01-concept.html");
      await core.games.scaffold("wasps", { title: "Wasps" });
      const chat = await core.threadForGame("bees");
      const other = await core.threadForGame("wasps");
      await show({ page: "missing.html", note: "nothing here" }, chat);
      await show({}, chat);
      await show({ page: "01-concept.html" });
      await show({ page: "01-concept.html" }, other);
      await show({ page: "01-concept.html" }, "no-such-chat");
      assert.deepEqual(await cards(chat), []);
      assert.deepEqual(await cards(other), []);
      assert.equal(shown().length, 3, "the tab still opens on a page shown from outside a chat");
    } finally {
      await close();
    }
  });

  it("shows nothing that is not a page of the board, and says what the board holds", async () => {
    const { show, shown, write, close } = await studio();
    try {
      assert.match(String(await show({ page: "concept.html" })), /the board is empty/);
      write("docs/design/01-concept.html");
      write("docs/design/img/inner.html");
      write("notes.html");
      const refused: Array<[unknown, RegExp]> = [
        ["02-loop.html", /no docs\/design\/02-loop\.html\. The board holds: docs\/design\/01-concept\.html/],
        ["img/inner.html", /an artboard's path below/],
        ["../notes.html", /an artboard's path below/],
        ["../../index.html", /an artboard's path below/],
        ["01-concept", /an artboard's path below/],
        [7, /an artboard's path below/],
      ];
      for (const [page, words] of refused) assert.match(String(await show({ page })), words, String(page));
      assert.deepEqual(shown(), []);
    } finally {
      await close();
    }
  });
});

describe("a picture the person drops on the canvas", () => {
  it("is kept in the board's from-you section under its own name, a taken name numbered", async () => {
    const { core, root, close } = await studio();
    try {
      const bytes = new Uint8Array([137, 80, 78, 71]);
      assert.equal(await core.design.drop("bees", "ref.png", bytes), "docs/design/from-you/ref.png");
      assert.equal(
        await core.design.drop("bees", "C:\\Users\\me\\Pictures\\ref.png", bytes),
        "docs/design/from-you/ref 2.png",
      );
      assert.deepEqual(fs.readdirSync(path.join(root, "docs/design/from-you")).sort(), ["ref 2.png", "ref.png"]);
      const board = await core.design.board("bees");
      assert.deepEqual(
        board.items.map((item) => [item.file, item.kind, item.section]),
        [
          ["docs/design/from-you/ref 2.png", "picture", "from-you"],
          ["docs/design/from-you/ref.png", "picture", "from-you"],
        ],
      );
    } finally {
      await close();
    }
  });

  it("refuses anything that is no picture of a sound name and size, and writes nothing for it", async () => {
    const { core, root, close } = await studio();
    try {
      const bytes = new Uint8Array([1, 2, 3]);
      const refused: Array<[unknown, unknown]> = [
        ["page.html", bytes],
        ["run.js", bytes],
        ["model.glb", bytes],
        [".env", bytes],
        ["", bytes],
        [7, bytes],
        ["empty.png", new Uint8Array()],
        ["text.png", "not bytes"],
        ["huge.png", new Uint8Array(21 * 1024 * 1024)],
      ];
      for (const [name, data] of refused) assert.equal(await core.design.drop("bees", name, data), null, String(name));
      assert.equal(await core.design.drop("no-such-game", "ref.png", bytes), null);
      assert.equal(fs.existsSync(path.join(root, "docs")), false, "nothing was made in the game");
      // A name that points out of the board is kept by its last part, inside the board.
      assert.equal(await core.design.drop("bees", "../../../escape.png", bytes), "docs/design/from-you/escape.png");
      assert.equal(fs.existsSync(path.join(root, "..", "escape.png")), false);
      assert.deepEqual(fs.readdirSync(path.join(root, "docs/design/from-you")), ["escape.png"]);
    } finally {
      await close();
    }
  });
});

describe("what the person did on the board", () => {
  it("is kept in the board's own folder and read back, and is never an artboard or a file a page can read", async () => {
    const { core, root, write, close } = await studio();
    try {
      assert.deepEqual(await core.design.marks("bees"), EMPTY_MARKS);
      write("docs/design/world/town.png", "PNG");
      const town = "docs/design/world/town.png";
      const marks = {
        places: { [town]: { x: 900, y: -40 } },
        notes: [{ id: "n1", text: "Two more streets?", file: town, x: 20, y: 30, told: false }],
        picks: { [town]: { pick: "use" as const, told: false } },
        choices: [town],
      };
      assert.equal(await core.design.saveMarks("bees", marks), true);
      assert.deepEqual(await core.design.marks("bees"), marks);
      assert.equal(fs.existsSync(path.join(root, DESIGN_MARKS_FILE)), true, "in the game's own design folder");
      const board = await core.design.board("bees");
      assert.deepEqual(
        board.items.map((item) => item.file),
        [town],
        "the file is no artboard",
      );
      const host = new URL(board.items[0]?.url ?? "").hostname;
      assert.notEqual((await core.design.serve(host, `/${DESIGN_MARKS_FILE}`)).status, 200, "and no page reads it");
      // What is kept is what a read would take: anything else is dropped before it is written.
      assert.equal(
        await core.design.saveMarks("bees", { places: { "../../x.png": { x: 1, y: 1 } }, notes: "x" }),
        true,
      );
      assert.deepEqual(await core.design.marks("bees"), EMPTY_MARKS);
      assert.doesNotMatch(fs.readFileSync(path.join(root, DESIGN_MARKS_FILE), "utf8"), /x\.png/);
      fs.writeFileSync(path.join(root, DESIGN_MARKS_FILE), "{ not json");
      assert.deepEqual(await core.design.marks("bees"), EMPTY_MARKS, "a broken file is nothing done");
      assert.equal(await core.design.saveMarks("no-such-game", marks), false);
      assert.deepEqual(await core.design.marks("no-such-game"), EMPTY_MARKS);
    } finally {
      await close();
    }
  });
});

describe("a 3D model on the board", () => {
  // The canvas turns a model with the app's own viewer, which reads the file through the asset
  // preview. A model in docs/design/ was refused as no asset, so its tile never showed it.
  it("is read for the canvas's viewer from the board, and from nowhere beside it", async () => {
    const { core, root, write, close } = await studio();
    try {
      const glb = "glTF\u0002\u0000\u0000\u0000";
      write("docs/design/characters/hero.glb", glb);
      write("docs/design/.cache/hero.glb", glb);
      write("docs/notes/hero.glb", glb);
      write("secret/hero.glb", glb);
      const board = await core.design.board("bees");
      assert.deepEqual(
        board.items.map((item) => [item.file, item.kind]),
        [["docs/design/characters/hero.glb", "model"]],
      );
      const read = (file: string) => core.previewProjectAsset({ project: "bees", file });
      const model = await read("docs/design/characters/hero.glb");
      assert.equal(model.mimeType, "model/gltf-binary");
      assert.equal(Buffer.from(model.data).toString(), glb);
      const refused: Array<[string, string]> = [
        ["a hidden folder of the board", "docs/design/.cache/hero.glb"],
        ["docs beside the board", "docs/notes/hero.glb"],
        ["another folder of the game", "secret/hero.glb"],
        ["a step up out of the board", "docs/design/../../secret/hero.glb"],
        ["a step up inside it", "docs/design/characters/../../notes/hero.glb"],
        ["an absolute path", path.join(root, "docs/design/characters/hero.glb")],
        ["a backslash", "docs\\design\\characters\\hero.glb"],
        ["a page, which is no model or picture", "docs/design/01-pitch.html"],
      ];
      write("docs/design/01-pitch.html");
      for (const [why, file] of refused) await assert.rejects(read(file), Error, why);
    } finally {
      await close();
    }
  });
});

describe("a game's design board as the app serves it", () => {
  it("lists the game's pages at addresses its own host answers, and no other host", async () => {
    const { core, write, close } = await studio();
    try {
      assert.deepEqual(await core.design.board("bees"), { items: [], stamp: "" });
      write("docs/design/01-concept.html");
      const board = await core.design.board("bees");
      assert.deepEqual(
        board.items.map((page) => [page.file, page.name, page.title]),
        [["docs/design/01-concept.html", "01-concept", "Concept"]],
      );
      const url = new URL(board.items[0]?.url ?? "");
      assert.equal(url.protocol, `${DESIGN_SCHEME}:`);
      assert.match(url.searchParams.get("v") ?? "", /^[0-9a-f]{12}$/, "the page's own version");
      write("docs/design/02-loop.html");
      const [concept] = (await core.design.board("bees")).items;
      assert.equal(concept?.url, url.href, "a new page beside it leaves its address alone");
      const served = await core.design.serve(url.hostname, url.pathname);
      assert.ok(served.status === 200 && "text" in served.body && served.body.text.includes("Bee siege"));
      assert.deepEqual(await core.design.serve("bees", url.pathname), { status: 404 });
      assert.deepEqual(await core.design.serve(`${url.hostname}x`, url.pathname), { status: 404 });
      assert.deepEqual(await core.design.board("no-such-game"), { items: [], stamp: "" });
    } finally {
      await close();
    }
  });
});

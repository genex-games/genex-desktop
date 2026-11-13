/**
 * A design page in the chat: where a game's agent showed a page of its board (`show_design`), the
 * chat holds that page's card (`design_shown`). A page has one card, where it was last shown, and
 * a record that names no page of a board draws nothing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { NOTE_MAX_CHARS, readDesignShown } from "../../src/shared/design-board.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: "turn",
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const shown = (id: number, payload: Record<string, unknown>): EventEnvelope =>
  event(id, { type: "custom", event_type: "design_shown", payload });
const said = (id: number, role: "user" | "assistant", content: string): EventEnvelope =>
  event(id, { type: "messages", messages: [{ role, content }] });

const CONCEPT = { project: "bees", file: "docs/design/01-concept.html", title: "Bee Siege", note: "Pick one" };
const LOOK = { project: "bees", file: "docs/design/02-look.html", title: "The look", note: "" };

/** The transcript's rows as their kinds, a card as its file and note. */
const rows = (events: EventEnvelope[]): string[] =>
  toEntries(events).map((entry) =>
    entry.kind === EntryKind.DesignPage ? `card ${entry.design.file} [${entry.design.note}]` : entry.kind,
  );

describe("a design page's card in the chat", () => {
  it("stands where the agent showed the page, with its title and the agent's note", () => {
    const entries = toEntries([said(1, "user", "Three directions, please"), shown(2, CONCEPT)]);
    const card = entries.find((entry) => entry.kind === EntryKind.DesignPage);
    assert.deepEqual(card?.kind === EntryKind.DesignPage ? card.design : null, CONCEPT);
    assert.deepEqual(rows([said(1, "user", "Three directions, please"), shown(2, CONCEPT)]), [
      "user",
      "card docs/design/01-concept.html [Pick one]",
    ]);
  });

  it("keeps one card for a page, where it was last shown; another page keeps its own", () => {
    const again = { ...CONCEPT, note: "Marked your pick" };
    assert.deepEqual(
      rows([
        said(1, "user", "Three directions, please"),
        shown(2, CONCEPT),
        shown(3, LOOK),
        said(4, "user", "B, but warmer"),
        shown(5, again),
      ]),
      ["user", "card docs/design/02-look.html []", "user", "card docs/design/01-concept.html [Marked your pick]"],
    );
  });

  it("draws nothing for a record that names no game or no page of a board", () => {
    const refused: Array<Record<string, unknown>> = [
      {},
      { project: "bees" },
      { file: "docs/design/01-concept.html" },
      { project: "", file: "docs/design/01-concept.html" },
      { project: "bees", file: "01-concept.html" },
      { project: "bees", file: "docs/design/img/inner.html" },
      { project: "bees", file: "../../secret.html" },
      { project: "bees", file: "index.html" },
      { project: "bees", file: 7 },
    ];
    for (const payload of refused) {
      assert.equal(readDesignShown(payload), null, JSON.stringify(payload));
      assert.deepEqual(rows([shown(1, payload)]), [], JSON.stringify(payload));
    }
    assert.equal(readDesignShown(null), null);
  });

  it("reads a record's title and note as one bounded line each", () => {
    const card = readDesignShown({
      project: "bees",
      file: "docs/design/01-concept.html",
      title: "  Bee\n Siege ",
      note: `${"long ".repeat(100)}`,
    });
    assert.equal(card?.title, "Bee Siege");
    assert.equal(card?.note.length, NOTE_MAX_CHARS);
    const bare = readDesignShown({ project: "bees", file: "docs/design/01-concept.html" });
    assert.deepEqual(bare, { project: "bees", file: "docs/design/01-concept.html", title: "", note: "" });
  });
});

/**
 * Genex's review in the game's chat: each `genex_review` record and Fix with agent press is a card at
 * its own time, never held for the turn it came in; the game's newest is its live card and every older
 * one settles into one line; the same press read again ("Don't publish it automatically") adds no card.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EntryKind, type GenexReviewEntry, toEntries } from "../../src/renderer/chat-entries.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import { type EventData, type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import { GenexFixKind, GenexReviewChange } from "../../src/shared/genex-review.ts";
import {
  fixHistoryLabel,
  historyLabel,
  settledCardView,
} from "../../src/renderer/panels/plugins/genex/review-card-view.ts";

let seq = 0;
const at = (minute: number) => new Date(Date.parse("2026-10-27T14:00:00Z") + minute * 60_000).toISOString();
const event = (data: EventData, minute: number, turn: string | null = null): EventEnvelope => {
  seq += 1;
  return { id: `e${seq}`, thread_id: "t1", session_id: null, turn_id: turn, created_at: at(minute), data };
};
const review = (change: string, minute: number, project = "dust") =>
  event(
    customEventData(CustomEvent.GenexReview, { project, change: change as GenexReviewChange, at: at(minute) }),
    minute,
  );
const fix = (minute: number, autoPublish = true) =>
  event(
    customEventData(CustomEvent.GenexReviewFix, {
      project: "dust",
      fixId: "fix-1",
      kind: GenexFixKind.App,
      count: 3,
      autoPublish,
      at: at(minute),
    }),
    minute,
  );
const reviews = (events: EventEnvelope[]) =>
  toEntries(events).filter((entry): entry is GenexReviewEntry => entry.kind === EntryKind.GenexReview);

describe("Genex's review in the chat", () => {
  it("draws each record at its time, the newest live and the rest as lines", () => {
    const cards = reviews([
      review(GenexReviewChange.Live, 0),
      review(GenexReviewChange.TakenDown, 4),
      fix(20),
      review(GenexReviewChange.Sent, 30),
      review(GenexReviewChange.Restored, 33),
    ]);
    assert.deepEqual(
      cards.map((card) => [card.review?.change ?? "fix", card.latest]),
      [
        [GenexReviewChange.Live, false],
        [GenexReviewChange.TakenDown, false],
        ["fix", false],
        [GenexReviewChange.Sent, false],
        [GenexReviewChange.Restored, true],
      ],
    );
    assert.equal(cards[2]?.fix?.count, 3);
  });

  it("places a card in the middle of a turn, never after it", () => {
    const entries = toEntries([
      event({ type: EventKind.TurnStarted } as EventData, 1, "turn-1"),
      review(GenexReviewChange.NotApproved, 2),
      event(
        { type: EventKind.Messages, messages: [{ role: "assistant", content: "Working on it." }] } as EventData,
        3,
        "turn-1",
      ),
    ]);
    const kinds = entries.map((entry) => entry.kind);
    assert.ok(kinds.indexOf(EntryKind.GenexReview) < kinds.lastIndexOf(EntryKind.Assistant));
  });

  it("adds no card when the same press is read again, and keeps each game's live card its own", () => {
    const cards = reviews([fix(1), fix(2, false), review(GenexReviewChange.NotApproved, 3, "other")]);
    assert.equal(cards.length, 2);
    assert.deepEqual(
      cards.map((card) => [card.project, card.latest]),
      [
        ["dust", true],
        ["other", true],
      ],
    );
  });

  it("reads a record with no payload as a card with nothing in it, never a crash", () => {
    const cards = reviews([event({ type: "custom", event_type: CustomEvent.GenexReview } as EventData, 0)]);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.project, undefined);
  });
});

describe("a settled record's line and what it opens to", () => {
  const THINGS = [
    { text: "The “Get 5,000 coins” button opens an outside payment page", where: "Garage → Get coins" },
    { text: "Loads code from another website (unpkg.com)" },
  ];
  const record = (change: GenexReviewChange, more: Record<string, unknown> = {}) => ({ change, at: at(0), ...more });

  it("labels each record the mockup's way", () => {
    const labels = [
      historyLabel(record(GenexReviewChange.Live)),
      historyLabel(record(GenexReviewChange.Sent)),
      historyLabel(record(GenexReviewChange.Live, { update: true })),
      historyLabel(record(GenexReviewChange.NotApproved)),
      historyLabel(record(GenexReviewChange.Requested)),
      fixHistoryLabel(3),
      fixHistoryLabel(1),
      historyLabel(record(GenexReviewChange.TakenDown)),
      historyLabel(record(GenexReviewChange.Restored)),
    ];
    assert.deepEqual(labels, [
      "Published",
      "Sent for review",
      "Live",
      "Not approved",
      "Human review requested",
      "3 fixes sent",
      "1 fix sent",
      "Taken down",
      "Public again",
    ]);
    assert.equal(historyLabel(record(GenexReviewChange.NotBuilt)), null, "a fix's end draws no line of its own");
  });

  it("opens to what the card said then, read only: its title, its lines and its things", () => {
    const down = settledCardView(
      { review: record(GenexReviewChange.TakenDown, { things: THINGS, count: 2 }), fix: null },
      "Midnight Asphalt",
    );
    assert.deepEqual(down, {
      title: "Taken down: 2 things to fix",
      lines: ["Hidden from players until it's fixed and a person at Genex puts it back."],
      quote: null,
      things: THINGS,
    });
    const kept = settledCardView(
      {
        review: record(GenexReviewChange.Upheld, { things: THINGS, reply: "The shop is still outside Genex." }),
        fix: null,
      },
      "Midnight Asphalt",
    );
    assert.equal(kept?.quote, "The shop is still outside Genex.");
    assert.deepEqual(kept?.lines, ["Human review agreed with the takedown."]);
    const back = settledCardView(
      { review: record(GenexReviewChange.Restored, { requested: true }), fix: null },
      "Midnight Asphalt",
    );
    assert.deepEqual(
      [back?.title, back?.lines],
      ["Midnight Asphalt is public again", ["Someone from the Genex team agreed it's fine."]],
    );
    const fixes = settledCardView(
      { review: null, fix: { fixId: "f1", kind: GenexFixKind.App, count: 3 } },
      "Midnight Asphalt",
    );
    assert.deepEqual(
      [fixes?.title, fixes?.lines],
      ["3 fixes sent", ["Sent to your agent. When it's done, Studio publishes it and Genex checks it again."]],
    );
    const checked = settledCardView(
      {
        review: record(GenexReviewChange.Sent, {
          recheck: true,
          app: { platform: "mac", arch: "arm64", version: "1.3.0" },
        }),
        fix: null,
      },
      "Midnight Asphalt",
    );
    assert.deepEqual([checked?.title, checked?.lines], ["Checking your fixes", ["usually a few minutes"]]);
  });

  it("never says Genex checks a public game again, and trusts no old record's shape", () => {
    const changes = Object.values(GenexReviewChange);
    for (const change of changes) {
      const card = settledCardView({ review: record(change, { things: THINGS }), fix: null }, "Midnight Asphalt");
      const said = card ? [card.title, ...card.lines].join(" ") : "";
      assert.doesNotMatch(said, /keeps checking|checks public games|seconds/i, change);
    }
    const odd = settledCardView(
      {
        review: record(GenexReviewChange.NotApproved, { things: [null, 4, { where: "x" }, { text: "Real" }] }),
        fix: null,
      },
      "Midnight Asphalt",
    );
    assert.deepEqual(odd?.things, [{ text: "Real" }]);
    assert.equal(settledCardView({ review: record(GenexReviewChange.FixStopped), fix: null }, "x"), null);
  });
});

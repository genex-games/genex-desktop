/**
 * The sidebar's second line under a game on Genex (mockup C1): its review's state, Fixing {n} things
 * while a Fix with agent press is with the agent, Checking fixes once the fixed app went again, and
 * Public for any game listed on Genex, a web game's too. A game Genex does not know has no line. Each
 * game's review part is kept until its review changes; the publish record is read every time.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewLineOf, reviewLines, sidebarEntryOf } from "../../src/main/core/genex-review-lines.ts";
import { reviewLineView } from "../../src/renderer/panels/plugins/genex/review-line-view.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import { type EventData, type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import {
  GenexAppReview,
  GenexFixKind,
  GenexGameReview,
  GenexHumanReview,
  type GenexReviewApp,
  GenexReviewChange,
  type GenexReviewRecord,
  type GenexReviewStatus,
  GenexSidebarLine,
  gameReviewOf,
} from "../../src/shared/genex-review.ts";

const app = (state: GenexAppReview): GenexReviewApp => ({
  platform: "mac",
  arch: "arm64",
  state,
  version: "1.3.0",
  things: state === GenexAppReview.NotApproved ? [{ text: "Loads code from unpkg.com" }] : [],
  humanReview: { state: GenexHumanReview.None, canRequest: false },
});
const recordOf = (apps: GenexReviewApp[], takedown: GenexReviewRecord["takedown"] = null): GenexReviewRecord => ({
  state: gameReviewOf(apps, takedown),
  apps,
  takedown,
});
const TAKEDOWN = {
  at: "2026-10-27T14:06:00.000Z",
  things: [{ text: "a" }, { text: "b" }, { text: "c" }],
  appealable: true,
  humanReview: { state: GenexHumanReview.None, canRequest: true },
};
const statusOf = (record: GenexReviewRecord | null): GenexReviewStatus => ({
  record,
  checkedAt: null,
  connected: true,
  open: false,
  fingerprint: null,
  told: null,
  publishing: false,
});

let seq = 0;
const at = (minute: number) => new Date(Date.parse("2026-10-27T14:00:00Z") + minute * 60_000).toISOString();
const event = (data: EventData, minute: number, turn: string | null = null): EventEnvelope => {
  seq += 1;
  return { id: `e${seq}`, thread_id: "t1", session_id: null, turn_id: turn, created_at: at(minute), data };
};
const pressed = (minute: number) =>
  event(
    customEventData(CustomEvent.GenexReviewFix, {
      project: "asphalt",
      fixId: "fix-1",
      kind: GenexFixKind.App,
      count: 3,
      autoPublish: true,
      at: at(minute),
    }),
    minute,
  );
const resent = (minute: number) =>
  event(
    customEventData(CustomEvent.GenexReview, {
      project: "asphalt",
      change: GenexReviewChange.Sent,
      recheck: true,
      at: at(minute),
    }),
    minute,
  );

describe("a game's line from its review", () => {
  it("says each state the way the mockup does, and nothing for a game Genex does not know", () => {
    const line = (record: GenexReviewRecord | null) => reviewLineOf({ record, fix: null, fixing: false })?.line;
    assert.equal(line(recordOf([app(GenexAppReview.Live)])), GenexSidebarLine.Public);
    assert.equal(line(recordOf([app(GenexAppReview.Checking)])), GenexSidebarLine.InReview);
    assert.equal(line(recordOf([app(GenexAppReview.WithPerson)])), GenexSidebarLine.HumanReview);
    assert.equal(
      line(recordOf([app(GenexAppReview.NotApproved), app(GenexAppReview.Live)])),
      GenexSidebarLine.NotApproved,
    );
    assert.equal(line(recordOf([app(GenexAppReview.Live)], TAKEDOWN)), GenexSidebarLine.TakenDown);
    assert.equal(line(recordOf([])), undefined, "nothing sent: no line of its own");
    assert.equal(line(null), undefined);
  });

  it("says Fixing while the agent has the fix, then Checking fixes once the app went again", () => {
    const record = recordOf([app(GenexAppReview.NotApproved)]);
    const fix = { fixId: "fix-1", kind: GenexFixKind.App, count: 3, autoPublish: true, at: at(1), index: 0 };
    assert.deepEqual(reviewLineOf({ record, fix, fixing: true }), { line: GenexSidebarLine.Fixing, things: 3 });
    const checking = recordOf([app(GenexAppReview.Checking)]);
    assert.deepEqual(
      reviewLineOf({ record: checking, fix: { ...fix, outcome: GenexReviewChange.Sent }, fixing: false }),
      {
        line: GenexSidebarLine.CheckingFixes,
      },
    );
    const stopped = { ...fix, outcome: GenexReviewChange.FixStopped };
    assert.equal(reviewLineOf({ record, fix: stopped, fixing: false })?.line, GenexSidebarLine.NotApproved);
  });

  it("says Checking fixes only for the build the fix sent, never for a publish weeks later", () => {
    const fix = {
      fixId: "fix-1",
      kind: GenexFixKind.App,
      count: 3,
      autoPublish: true,
      at: at(1),
      index: 0,
      outcome: GenexReviewChange.Sent,
      sentBuilds: { "mac/arm64": { version: "1.3.0", sha256: "a".repeat(64), sentAt: at(12) } },
    };
    const checked = (sha256: string, sentAt: string) => recordOf([{ ...app(GenexAppReview.Checking), sha256, sentAt }]);
    assert.equal(
      reviewLineOf({ record: checked("a".repeat(64), at(12)), fix, fixing: false })?.line,
      GenexSidebarLine.CheckingFixes,
    );
    assert.equal(
      reviewLineOf({ record: checked("b".repeat(64), at(60 * 24 * 14)), fix, fixing: false })?.line,
      GenexSidebarLine.InReview,
    );
  });

  it("says Public for a listed game with no review of its own, a web game's too", () => {
    assert.deepEqual(sidebarEntryOf(null, true), { line: GenexSidebarLine.Public });
    assert.equal(sidebarEntryOf(null, false), null, "a draft page only: no line");
    assert.deepEqual(sidebarEntryOf({ line: GenexSidebarLine.TakenDown }, true), { line: GenexSidebarLine.TakenDown });
  });
});

describe("the sidebar's lines", () => {
  /** Lines over recorders: one game's kept review, its chat and its publish record, set by the test. */
  function linesOver() {
    const kept: Record<string, GenexReviewRecord | null> = { asphalt: recordOf([app(GenexAppReview.NotApproved)]) };
    const chat: EventEnvelope[] = [];
    const listed: Record<string, boolean> = { asphalt: false, web: true, draft: false };
    const reads: string[] = [];
    const lines = reviewLines({
      games: async () => Object.keys(listed),
      status: async (project) => {
        reads.push(project);
        return statusOf(kept[project] ?? null);
      },
      events: async (project) => (project === "asphalt" ? chat : []),
      published: async (project) => listed[project] ?? false,
    });
    return { kept, chat, listed, reads, lines };
  }

  it("answers each game on Genex that has a line, and keeps a game's review until it changes", async () => {
    const rig = linesOver();
    assert.deepEqual(await rig.lines.lines(), {
      asphalt: { line: GenexSidebarLine.NotApproved },
      web: { line: GenexSidebarLine.Public },
    });
    rig.kept.asphalt = recordOf([app(GenexAppReview.Live)], TAKEDOWN);
    rig.listed.draft = true;
    const again = await rig.lines.lines();
    assert.equal(again.asphalt?.line, GenexSidebarLine.NotApproved, "kept until its review changes");
    assert.equal(again.draft?.line, GenexSidebarLine.Public, "the publish record is read every time");
    rig.lines.forget("asphalt");
    assert.equal((await rig.lines.lines()).asphalt?.line, GenexSidebarLine.TakenDown);
    assert.equal(rig.reads.filter((project) => project === "asphalt").length, 2);
  });

  it("says Fixing from the chat's press until the agent's turn ends", async () => {
    const rig = linesOver();
    rig.chat.push(pressed(1), event({ type: EventKind.TurnStarted } as EventData, 2, "turn-1"));
    assert.deepEqual((await rig.lines.lines()).asphalt, { line: GenexSidebarLine.Fixing, things: 3 });
    rig.chat.push(event({ type: EventKind.TurnEnded, status: "ok" } as EventData, 9, "turn-1"), resent(10));
    rig.kept.asphalt = recordOf([app(GenexAppReview.Checking)]);
    rig.lines.forget("asphalt");
    assert.deepEqual((await rig.lines.lines()).asphalt, { line: GenexSidebarLine.CheckingFixes });
  });

  it("reads a failed game again next time and leaves the rest standing", async () => {
    let fail = true;
    const lines = reviewLines({
      games: async () => ["asphalt", "skate"],
      status: async (project) => {
        if (project === "asphalt" && fail) throw new Error("the plugin is restarting");
        return statusOf(recordOf([app(GenexAppReview.WithPerson)]));
      },
      events: async () => [],
      published: async () => false,
    });
    assert.deepEqual(Object.keys(await lines.lines()), ["skate"]);
    fail = false;
    assert.equal((await lines.lines()).asphalt?.line, GenexSidebarLine.HumanReview);
    assert.equal(GenexGameReview.WithPerson, "with_person");
  });
});

describe("the line as the sidebar draws it", () => {
  it("says the mockup's words, green for Public, red for what needs fixing, the working dot while fixing", () => {
    const drawn = (line: GenexSidebarLine, things?: number) => {
      const view = reviewLineView({ line, ...(things === undefined ? {} : { things }) });
      return view ? [view.text, view.tone, view.busy] : null;
    };
    assert.deepEqual(drawn(GenexSidebarLine.Public), ["Public", "ok", false]);
    assert.deepEqual(drawn(GenexSidebarLine.InReview), ["In review", "quiet", false]);
    assert.deepEqual(drawn(GenexSidebarLine.HumanReview), ["Human review", "quiet", false]);
    assert.deepEqual(drawn(GenexSidebarLine.NotApproved), ["Not approved", "err", false]);
    assert.deepEqual(drawn(GenexSidebarLine.TakenDown), ["Taken down", "err", false]);
    assert.deepEqual(drawn(GenexSidebarLine.Fixing, 3), ["Fixing 3 things", "quiet", true]);
    assert.deepEqual(drawn(GenexSidebarLine.Fixing, 1), ["Fixing 1 thing", "quiet", true]);
    assert.deepEqual(drawn(GenexSidebarLine.CheckingFixes), ["Checking fixes", "quiet", false]);
  });

  it("draws no line for a game with none, or a line from a newer build", () => {
    assert.equal(reviewLineView(undefined), null);
    assert.equal(reviewLineView({ line: "on_fire" as GenexSidebarLine }), null);
  });
});

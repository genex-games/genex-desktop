/**
 * The host's review watch: it reads each game's review through the Genex plugin on main's cadence
 * (the plugin cannot push), one game at a time, and tells the person each change once, in the game's
 * own chat. A sweep 20 s after start and every 15 min catches what happened while Studio was away; an
 * open review is read on its own cadence; a failed read backs off; signing out stops the reads; and
 * what was told is kept by the plugin, so a restart never tells it again.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import {
  GenexAppReview,
  GenexGameReview,
  GenexHumanReview,
  type GenexReviewApp,
  type GenexReviewPayload,
  GenexReviewChange,
  GenexReviewReadProblem,
  type GenexReviewRecord,
  type GenexReviewStatus,
  type GenexReviewTold,
  gameReviewOf,
  isOpenReview,
  reviewFingerprint,
} from "../../src/shared/genex-review.ts";
import {
  REVIEW_FIRST_SWEEP_MS,
  REVIEW_POLL_MS,
  REVIEW_SWEEP_MS,
  reviewChanges,
  startReviewWatch,
} from "../../src/main/core/genex-review-watch.ts";

const START = Date.parse("2026-10-27T14:00:00.000Z");

/** A clock and timers only the test moves. */
function fakeTime() {
  let now = START;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      next += 1;
      timers.set(next, { at: now + ms, run });
      return next;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    /** Move the clock by `ms`, running each timer due on the way and letting its reads settle. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].run();
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      }
      now = end;
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
    pending: () => timers.size,
  };
}

const app = (state: GenexAppReview, extra: Partial<GenexReviewApp> = {}): GenexReviewApp => ({
  platform: "mac",
  arch: "arm64",
  state,
  version: "1.3.0",
  sentAt: new Date(START).toISOString(),
  things: state === GenexAppReview.NotApproved ? [{ text: "Mines cryptocurrency on the player's computer" }] : [],
  humanReview: { state: GenexHumanReview.None, canRequest: state === GenexAppReview.NotApproved },
  ...extra,
});

const recordOf = (apps: GenexReviewApp[], takedown: GenexReviewRecord["takedown"] = null): GenexReviewRecord => ({
  state: gameReviewOf(apps, takedown),
  apps,
  takedown,
});

/** The plugin as the watch sees it: each game's record as Genex answers it now, and what was told. */
function fakePlugin(records: Record<string, GenexReviewRecord>) {
  const told = new Map<string, GenexReviewTold>();
  const reads: string[] = [];
  let running = 0;
  let most = 0;
  const failing = new Set<string>();
  const publishing = new Set<string>();
  let signedOut = false;
  const failures = new Map<string, number>();
  const status = async (
    project: string,
    options: { refresh?: boolean; told?: GenexReviewTold },
  ): Promise<GenexReviewStatus> => {
    if (options.told) told.set(project, options.told);
    if (options.refresh && !publishing.has(project)) {
      running += 1;
      most = Math.max(most, running);
      reads.push(project);
      await Promise.resolve();
      running -= 1;
      failures.set(project, failing.has(project) ? (failures.get(project) ?? 0) + 1 : 0);
    }
    const record = records[project] ?? null;
    const count = failures.get(project) ?? 0;
    return {
      record,
      checkedAt: null,
      connected: !signedOut,
      ...(signedOut ? { problem: GenexReviewReadProblem.SignedOut } : {}),
      ...(count >= 2 ? { problem: GenexReviewReadProblem.Offline } : {}),
      failures: count,
      open: isOpenReview(record),
      fingerprint: record ? reviewFingerprint(record) : null,
      told: told.get(project) ?? null,
      publishing: publishing.has(project),
    };
  };
  return {
    status,
    told,
    reads,
    most: () => most,
    fail: (project: string) => failing.add(project),
    heal: (project: string) => failing.delete(project),
    publish: (project: string, running: boolean) => (running ? publishing.add(project) : publishing.delete(project)),
    signOut: () => {
      signedOut = true;
    },
  };
}

function watchOver(records: Record<string, GenexReviewRecord>) {
  const time = fakeTime();
  const plugin = fakePlugin(records);
  const appended: Array<{ project: string; records: GenexReviewPayload[] }> = [];
  const emitted: string[] = [];
  const deps = {
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    games: async () => Object.keys(records),
    status: plugin.status,
    append: async (project: string, payloads: GenexReviewPayload[]) => {
      appended.push({ project, records: payloads });
    },
    emit: (project: string) => {
      emitted.push(project);
    },
  };
  return { time, plugin, appended, emitted, deps, start: () => startReviewWatch(deps) };
}

describe("the review watch's schedule", () => {
  it("sweeps every game 20 s after it starts, then every 15 min, one read at a time", async () => {
    const live = recordOf([app(GenexAppReview.Live)]);
    const { time, plugin, start } = watchOver({ a: live, b: live, c: live });
    const watch = start();
    await time.advance(REVIEW_FIRST_SWEEP_MS - SECOND_MS);
    assert.deepEqual(plugin.reads, []);
    await time.advance(SECOND_MS);
    assert.deepEqual(plugin.reads.sort(), ["a", "b", "c"]);
    assert.equal(plugin.most(), 1, "one CLI read at a time");
    await time.advance(REVIEW_SWEEP_MS - SECOND_MS);
    assert.equal(plugin.reads.length, 3, "a settled game waits for the next sweep");
    await time.advance(SECOND_MS);
    assert.equal(plugin.reads.length, 6);
    watch.stop();
    await time.advance(REVIEW_SWEEP_MS * 2);
    assert.equal(plugin.reads.length, 6, "a stopped watch reads nothing");
    assert.equal(time.pending(), 0);
  });

  it("reads a checked app at 30 s, 30 s, 1 min, 1 min, 2 min, then every 2 min until 45 min, then 10 min", async () => {
    const { time, plugin, start } = watchOver({ a: recordOf([app(GenexAppReview.Checking)]) });
    start();
    await time.advance(REVIEW_FIRST_SWEEP_MS);
    const at: number[] = [];
    const before = () => plugin.reads.length;
    for (let minute = 0; minute < 70 * 60; minute += 1) {
      const count = before();
      await time.advance(SECOND_MS);
      if (before() > count) at.push(time.now() - START);
    }
    const gaps = at.map((value, index) => value - (index === 0 ? REVIEW_FIRST_SWEEP_MS : (at[index - 1] ?? 0)));
    assert.deepEqual(gaps.slice(0, REVIEW_POLL_MS.length), [...REVIEW_POLL_MS]);
    const late = gaps.slice(REVIEW_POLL_MS.length);
    const lateAt = at.slice(REVIEW_POLL_MS.length);
    assert.ok(late.every((gap, i) => ((lateAt[i] ?? 0) <= 45 * MINUTE_MS ? gap === 2 * MINUTE_MS : true)));
    assert.equal(late.at(-1), 10 * MINUTE_MS, "an hour in, every 10 min");
  });

  it("reads an app with a person every 10 min, and a takedown only on the sweep", async () => {
    const person = recordOf([app(GenexAppReview.WithPerson)]);
    const down = recordOf([app(GenexAppReview.Live)], {
      at: new Date(START).toISOString(),
      things: [{ text: "Opens an outside payment page" }],
      appealable: true,
      humanReview: { state: GenexHumanReview.None, canRequest: true },
    });
    const { time, plugin, start } = watchOver({ person, down });
    start();
    await time.advance(REVIEW_FIRST_SWEEP_MS);
    await time.advance(14 * MINUTE_MS);
    assert.equal(plugin.reads.filter((game) => game === "person").length, 2);
    assert.equal(plugin.reads.filter((game) => game === "down").length, 1);
  });

  it("doubles a failing game's wait up to 15 min, and says offline after two failures in a row", async () => {
    const { time, plugin, start, emitted } = watchOver({ a: recordOf([app(GenexAppReview.Checking)]) });
    plugin.fail("a");
    start();
    await time.advance(REVIEW_FIRST_SWEEP_MS);
    const marks: number[] = [];
    for (let s = 0; s < 40 * 60; s += 1) {
      const count = plugin.reads.length;
      await time.advance(SECOND_MS);
      if (plugin.reads.length > count) marks.push(time.now());
    }
    const gaps = marks.map(
      (value, index) => value - (index === 0 ? START + REVIEW_FIRST_SWEEP_MS : (marks[index - 1] ?? 0)),
    );
    assert.deepEqual(gaps.slice(0, 4), [60 * SECOND_MS, 2 * MINUTE_MS, 4 * MINUTE_MS, 8 * MINUTE_MS]);
    assert.ok(gaps.every((gap) => gap <= 15 * MINUTE_MS));
    assert.ok(emitted.includes("a"), "the line turns offline");
  });

  it("stops reading once signed out", async () => {
    const { time, plugin, start } = watchOver({ a: recordOf([app(GenexAppReview.Checking)]) });
    start();
    await time.advance(REVIEW_FIRST_SWEEP_MS);
    plugin.signOut();
    await time.advance(REVIEW_POLL_MS[0] ?? 0);
    const reads = plugin.reads.length;
    await time.advance(10 * MINUTE_MS);
    assert.equal(plugin.reads.length, reads, "no per-game reads while signed out");
  });

  it("follows a publish it was told of: again while it runs, then the check of what it sent", async () => {
    const records: Record<string, GenexReviewRecord> = { a: recordOf([]) };
    const { time, plugin, appended, start } = watchOver(records);
    const watch = start();
    await time.advance(REVIEW_FIRST_SWEEP_MS);
    assert.equal(plugin.reads.length, 1);
    plugin.publish("a", true);
    watch.refresh("a");
    await time.advance(2 * MINUTE_MS);
    assert.equal(plugin.reads.length, 1, "nothing is read from Genex while the publish runs");
    records.a = recordOf([app(GenexAppReview.Checking, { sentAt: new Date(time.now()).toISOString() })]);
    plugin.publish("a", false);
    await time.advance(30 * SECOND_MS);
    assert.equal(plugin.reads.length, 2, "read within 30 s of the publish's end, not at the next sweep");
    assert.deepEqual(
      appended.map((entry) => entry.records.map((record) => record.change)),
      [[GenexReviewChange.Sent]],
    );
    records.a = recordOf([app(GenexAppReview.NotApproved, { decidedAt: new Date(time.now()).toISOString() })]);
    await time.advance(REVIEW_POLL_MS[0] ?? 0);
    assert.equal(appended.at(-1)?.records[0]?.change, GenexReviewChange.NotApproved, "the check's cadence");
  });

  it("reads a game again at once when asked, and focus sweeps when the last sweep is over 5 min old", async () => {
    const live = recordOf([app(GenexAppReview.Live)]);
    const { time, plugin, start } = watchOver({ a: live });
    const watch = start();
    await time.advance(REVIEW_FIRST_SWEEP_MS);
    watch.refresh("a");
    await time.advance(0);
    assert.equal(plugin.reads.length, 2);
    watch.focus();
    await time.advance(0);
    assert.equal(plugin.reads.length, 2, "a sweep under 5 min old is not repeated");
    await time.advance(6 * MINUTE_MS);
    watch.focus();
    await time.advance(0);
    assert.equal(plugin.reads.length, 3);
  });
});

describe("what the watch tells", () => {
  it("tells a decision made while Studio was away once, and never again after a restart", async () => {
    const records = { a: recordOf([app(GenexAppReview.NotApproved)]) };
    const first = watchOver(records);
    first.start();
    await first.time.advance(REVIEW_FIRST_SWEEP_MS);
    assert.equal(first.appended.length, 1);
    assert.equal(first.appended[0]?.records[0]?.change, GenexReviewChange.NotApproved);
    assert.equal(first.appended[0]?.records[0]?.count, 1);
    assert.deepEqual(first.emitted, ["a"]);
    // A restart: a new watch over the same plugin, which kept what was told.
    const again = watchOver(records);
    again.deps.status = first.plugin.status;
    startReviewWatch(again.deps);
    await again.time.advance(REVIEW_FIRST_SWEEP_MS);
    assert.equal(again.appended.length, 0);
  });

  it("tells each later change once: checked, then live", async () => {
    const records: Record<string, GenexReviewRecord> = {
      a: recordOf([app(GenexAppReview.Live, { version: "1.2.0" })]),
    };
    const { time, appended, emitted, start } = watchOver(records);
    const watch = start();
    await time.advance(REVIEW_FIRST_SWEEP_MS);
    assert.equal(appended.length, 0, "a build live before the watch ever read it is no news");
    assert.deepEqual(emitted, ["a"], "but the window reads it: the sidebar says Public");
    records.a = recordOf([app(GenexAppReview.Checking)]);
    watch.refresh("a");
    await time.advance(0);
    records.a = recordOf([app(GenexAppReview.Live, { decidedAt: new Date(time.now()).toISOString() })]);
    await time.advance(REVIEW_POLL_MS[0] ?? 0);
    assert.deepEqual(
      appended.map((entry) => entry.records.map((record) => record.change)),
      [[GenexReviewChange.Sent], [GenexReviewChange.Live]],
    );
    await time.advance(REVIEW_SWEEP_MS);
    assert.equal(appended.length, 2);
  });
});

describe("the changes between what was told and what Genex says", () => {
  const game = { project: "a", title: "Midnight Asphalt", slug: "midnight-asphalt" };
  const now = START + MINUTE_MS;
  const takedown = {
    at: new Date(START).toISOString(),
    things: [{ text: "x" }, { text: "y" }, { text: "z" }],
    appealable: true,
    humanReview: { state: GenexHumanReview.None, canRequest: true },
  };

  it("tells a takedown, its request, its upheld answer, and its end as the game being back", () => {
    const before = recordOf([app(GenexAppReview.Live)]);
    const told0 = reviewChanges(null, before, now, game).told;
    const down = reviewChanges(told0, recordOf([app(GenexAppReview.Live)], takedown), now, game);
    assert.deepEqual(
      down.records.map((record) => [record.change, record.count]),
      [[GenexReviewChange.TakenDown, 3]],
    );
    const asked = { ...takedown, humanReview: { state: GenexHumanReview.Requested, canRequest: false } };
    const requested = reviewChanges(down.told, recordOf([app(GenexAppReview.Live)], asked), now, game);
    assert.deepEqual(
      requested.records.map((record) => record.change),
      [GenexReviewChange.Requested],
    );
    const kept = {
      ...takedown,
      humanReview: { state: GenexHumanReview.Denied, canRequest: false, reply: "Sell coins through Genex." },
    };
    const upheld = reviewChanges(requested.told, recordOf([app(GenexAppReview.Live)], kept), now, game);
    assert.deepEqual(
      upheld.records.map((record) => [record.change, record.reply]),
      [[GenexReviewChange.Upheld, "Sell coins through Genex."]],
    );
    const back = reviewChanges(upheld.told, recordOf([app(GenexAppReview.Live)]), now, game);
    assert.deepEqual(
      back.records.map((record) => record.change),
      [GenexReviewChange.Restored],
    );
  });

  it("names a turned-down update, a person's decision and its words", () => {
    const told = reviewChanges(null, recordOf([app(GenexAppReview.Checking)]), now, game).told;
    const decided = recordOf([
      app(GenexAppReview.NotApproved, {
        decidedBy: "person",
        reply: "The coin page sends players to a store outside Genex.",
        players: { version: "1.2.0", since: "2026-10-25T10:03:10.000Z" },
      }),
    ]);
    const [record] = reviewChanges(told, decided, now, game).records;
    assert.equal(record?.change, GenexReviewChange.NotApproved);
    assert.equal(record?.decidedBy, "person");
    assert.equal(record?.reply, "The coin page sends players to a store outside Genex.");
    assert.equal(record?.update, true);
    // Flipped on purpose: a record names the build it is about, so a fix's re-check can tell it apart.
    assert.deepEqual(record?.app, {
      platform: "mac",
      arch: "arm64",
      version: "1.3.0",
      sentAt: new Date(START).toISOString(),
    });
    assert.equal(record?.title, "Midnight Asphalt");
  });

  it("tells a request made on genex.games or with the CLI as a request, never as a new turn-down", () => {
    const down = recordOf([app(GenexAppReview.NotApproved, { decidedAt: new Date(START).toISOString() })]);
    const told = reviewChanges(null, down, now, game).told;
    const asked = recordOf([
      app(GenexAppReview.NotApproved, {
        decidedAt: new Date(START).toISOString(),
        humanReview: { state: GenexHumanReview.Requested, canRequest: false, resend: true },
      }),
    ]);
    const changes = reviewChanges(told, asked, now, game);
    assert.deepEqual(
      changes.records.map((record) => [record.change, record.requested]),
      [[GenexReviewChange.Requested, true]],
    );
    assert.equal(reviewChanges(changes.told, asked, now, game).records.length, 0, "told once");
  });

  it("tells a build live in place of an earlier one as an update, and one a person approved after a request", () => {
    const players = { version: "1.2.0", since: "2026-10-25T10:03:10.000Z" };
    const held = recordOf([app(GenexAppReview.Checking, { players })]);
    const live = recordOf([app(GenexAppReview.Live, { decidedAt: new Date(now).toISOString() })]);
    const update = reviewChanges(reviewChanges(null, held, now, game).told, live, now, game).records[0];
    assert.deepEqual([update?.change, update?.update, update?.requested], [GenexReviewChange.Live, true, undefined]);
    const withPerson = recordOf([
      app(GenexAppReview.WithPerson, {
        players,
        humanReview: { state: GenexHumanReview.Requested, canRequest: false },
      }),
    ]);
    const approved = reviewChanges(reviewChanges(null, withPerson, now, game).told, live, now, game).records[0];
    assert.deepEqual([approved?.change, approved?.update, approved?.requested], [GenexReviewChange.Live, true, true]);
    const first = reviewChanges(
      reviewChanges(null, recordOf([app(GenexAppReview.Checking)]), now, game).told,
      live,
      now,
      game,
    );
    assert.equal(first.records[0]?.update, undefined, "a first build live is no update");
  });

  it("tells nothing when nothing changed", () => {
    const record = recordOf([app(GenexAppReview.NotApproved)]);
    const first = reviewChanges(null, record, now, game);
    assert.equal(reviewChanges(first.told, record, now, game).records.length, 0);
    assert.equal(GenexGameReview.NotApproved, record.state);
  });
});

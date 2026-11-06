/**
 * Genex's Publish on the stage strip has two looks: the accent while the game has something to
 * publish, the quiet fill otherwise. Its status says which, and writes no badge for a game's
 * publishing. Genex's review of the game's apps or its takedown adds a red dot when the person must
 * fix something, and a quiet tooltip while Genex holds an app.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { publishButtonStatus } from "../../src/plugins/genex/backend.ts";
import { toolbarTip } from "../../src/shared/plugin-toolbar.ts";
import {
  GenexAppReview,
  GenexHumanReview,
  type GenexReviewApp,
  type GenexReviewRecord,
  gameReviewOf,
} from "../../src/shared/genex-review.ts";
import {
  GenexHostedStatus,
  GenexPublishJobState,
  GenexPublishKind,
  GenexPublishPhase,
  type GenexPublishJob,
  type GenexPublishState,
} from "../../src/shared/genex.ts";

const state = (over: Partial<GenexPublishState> = {}): GenexPublishState => ({
  version: 1,
  project: "pong",
  connected: true,
  ...over,
});
const job = (jobState: GenexPublishJob["state"]): GenexPublishJob => ({
  id: "job",
  kind: GenexPublishKind.Gallery,
  state: jobState,
  phase: GenexPublishPhase.Uploading,
  startedAt: "2026-10-03T10:00:00Z",
});

test("a game that is not listed yet calls for Publish", () => {
  assert.equal(publishButtonStatus(state()).attention, true);
  assert.equal(publishButtonStatus(state({ slug: "pong", status: GenexHostedStatus.Draft })).attention, true);
});

test("a failed publish still calls for Publish", () => {
  assert.equal(publishButtonStatus(state({ job: job(GenexPublishJobState.Failed) })).attention, true);
});

test("a listed game, or one uploading, leaves Publish quiet", () => {
  assert.equal(publishButtonStatus(state({ slug: "pong", status: GenexHostedStatus.Published })).attention, false);
  assert.equal(publishButtonStatus(state({ job: job(GenexPublishJobState.Running) })).attention, false);
  assert.equal(publishButtonStatus(state({ job: job(GenexPublishJobState.Unresolved) })).attention, false);
});

test("a game's publishing never gives Publish a badge, only its tooltip", () => {
  const all = [
    state(),
    state({ slug: "pong", status: GenexHostedStatus.Draft }),
    state({ slug: "pong", status: GenexHostedStatus.Published }),
    state({ job: job(GenexPublishJobState.Running) }),
    state({ job: job(GenexPublishJobState.Failed) }),
  ];
  for (const each of all) {
    const status = publishButtonStatus(each);
    assert.equal(status.badge, undefined);
    assert.equal(status.tone, undefined);
    assert.equal(typeof status.title, "string");
  }
});

const app = (state: GenexAppReview, platform = "mac", things = 0): GenexReviewApp => ({
  platform,
  arch: "arm64",
  state,
  version: "1.3.0",
  things: Array.from({ length: things }, (_, n) => ({ text: `Thing ${n + 1}` })),
  humanReview: { state: GenexHumanReview.None, canRequest: false },
});
const review = (apps: GenexReviewApp[], takedown: GenexReviewRecord["takedown"] = null): GenexReviewRecord => ({
  state: gameReviewOf(apps, takedown),
  apps,
  takedown,
});
const takedown = {
  at: "2026-10-27T14:06:00.000Z",
  things: [{ text: "a" }, { text: "b" }, { text: "c" }],
  appealable: true,
  humanReview: { state: GenexHumanReview.None, canRequest: true },
};
const listed = state({ slug: "asphalt", status: GenexHostedStatus.Published });
const drafted = state({ slug: "asphalt", status: GenexHostedStatus.Draft });

test("a taken-down game or a turned-down app gives Publish a red dot and says what to fix", () => {
  const down = publishButtonStatus(listed, review([app(GenexAppReview.Live)], takedown));
  assert.deepEqual([down.dot, down.tone, down.attention], [true, "err", true]);
  assert.deepEqual(toolbarTip(down), ["Taken down", "3 things to fix. Open Publish to see them."]);
  const turned = publishButtonStatus(drafted, review([app(GenexAppReview.NotApproved, "windows", 1)]));
  assert.deepEqual([turned.dot, turned.tone, turned.attention], [true, "err", true]);
  assert.deepEqual(toolbarTip(turned), ["Not approved", "1 thing to fix. Open Publish to see it."]);
});

test("an app Genex holds says so, never that the game has a draft page", () => {
  const checking = publishButtonStatus(drafted, review([app(GenexAppReview.Checking)]));
  assert.deepEqual(toolbarTip(checking), ["Genex is checking the Mac app. Usually a few minutes."]);
  assert.equal(checking.dot, undefined);
  assert.equal(checking.attention, false);
  const person = publishButtonStatus(drafted, review([app(GenexAppReview.WithPerson, "linux")]));
  assert.deepEqual(toolbarTip(person), ["A person at Genex is reviewing the Linux app. Usually within a day."]);
  const both = publishButtonStatus(
    drafted,
    review([app(GenexAppReview.Checking), app(GenexAppReview.Checking, "windows")]),
  );
  assert.deepEqual(toolbarTip(both), ["Genex is checking the apps. Usually a few minutes."]);
});

test("a game whose web version Genex plays keeps its web status while its app is checked or with a person", () => {
  const web = state({ slug: "asphalt", status: GenexHostedStatus.Published, hostedWeb: true });
  const listedWeb = publishButtonStatus(web, null).title;
  assert.equal(publishButtonStatus(web, review([app(GenexAppReview.Checking)])).title, listedWeb);
  assert.equal(publishButtonStatus(web, review([app(GenexAppReview.WithPerson)])).title, listedWeb);
  const turned = publishButtonStatus(web, review([app(GenexAppReview.NotApproved, "mac", 2)]));
  assert.equal(turned.dot, true, "a turned-down app still asks the person to fix it");
});

test("an upload under way still says so first, and a game whose apps are all live is listed", () => {
  const uploading = publishButtonStatus(state({ job: job(GenexPublishJobState.Running) }), review([], takedown));
  assert.equal(uploading.dot, undefined);
  assert.equal(
    publishButtonStatus(listed, review([app(GenexAppReview.Live)])).title,
    "This game is listed in the Genex gallery",
  );
  assert.equal(
    publishButtonStatus(listed, null).tone,
    undefined,
    "a web game Genex knows nothing more of stays as it was",
  );
});

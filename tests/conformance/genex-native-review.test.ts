/**
 * Genex's review of a game's apps and its takedown, as Studio reads it: `genex review --json` from a
 * CLI that has it, else the API's own answer for the game's apps beside the owner read of the game.
 * Every value is the API's (no English is matched), anything Studio does not know is dropped, the
 * caps hold, and an older API reads as today: a held app is checked, a turned-down one has its reason
 * as its one thing, and a takedown with only `takedownAt` is still a takedown.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readRequestAnswer,
  readReviewStatus,
  REVIEW_CLI,
  reviewDetailOf,
  reviewRecordOf,
  sentWithReview,
  takesReviewCommand,
} from "../../src/plugins/genex/native-review.ts";
import {
  GenexAppReview,
  GenexGameReview,
  GenexHumanReview,
  OLD_APPEAL_NOTE_MIN,
  REVIEW_TEXT_CHARS,
  REVIEW_THINGS_MAX,
  REVIEW_WHERE_CHARS,
  reviewFingerprint,
} from "../../src/shared/genex-review.ts";

const SHA = "3f9a21c0".padEnd(64, "0");

/** A submission row the API answers for a turned-down app (spec §2.1). */
const rejected = (detail: Record<string, unknown> = {}) => ({
  platform: "mac",
  arch: "arm64",
  version: "1.3.0",
  sha256: SHA,
  publishedAt: "2026-10-27T14:02:00.000Z",
  review: "rejected",
  reviewReason: "Off-platform payment: the coin button. If you think this is wrong, request a human review.",
  reviewDetail: {
    stage: "decided",
    decidedBy: "check",
    decidedAt: "2026-10-27T14:06:00.000Z",
    things: [
      { text: "The “Get 5,000 coins” button opens an outside payment page", where: "Garage → Get coins", rule: "x" },
    ],
    humanReview: { state: "none", canRequest: true },
    nextReviewBy: "check",
    ...detail,
  },
});

const live = (extra: Record<string, unknown> = {}) => ({
  platform: "mac",
  arch: "arm64",
  version: "1.2.0",
  sha256: SHA,
  publishedAt: "2026-10-25T10:03:10.000Z",
  review: "approved",
  reviewDetail: { stage: "decided", decidedBy: "check", decidedAt: "2026-10-25T10:03:10.000Z" },
  ...extra,
});

describe("which CLI reads a game's review", () => {
  it("is 1.39.0 or later, a prerelease of 1.39.0 not yet", () => {
    assert.deepEqual(REVIEW_CLI, [1, 39, 0]);
    assert.equal(takesReviewCommand("1.39.0"), true);
    assert.equal(takesReviewCommand("1.40.2"), true);
    assert.equal(takesReviewCommand("1.39.0-dev.1"), false);
    assert.equal(takesReviewCommand("1.38.0"), false);
    assert.equal(takesReviewCommand("nonsense"), false);
  });
});

describe("the API's answer for a game's apps", () => {
  it("reads a turned-down app with its things, the build players keep and the request it allows", () => {
    const record = reviewRecordOf({ native: { builds: [live()], submissions: [rejected()] }, project: {} });
    assert.ok(record);
    assert.equal(record.state, GenexGameReview.NotApproved);
    const [app] = record.apps;
    assert.equal(app?.state, GenexAppReview.NotApproved);
    assert.equal(app?.decidedBy, "check");
    assert.deepEqual(app?.things, [
      { text: "The “Get 5,000 coins” button opens an outside payment page", where: "Garage → Get coins", rule: "x" },
    ]);
    assert.deepEqual(app?.players, { version: "1.2.0", since: "2026-10-25T10:03:10.000Z" });
    assert.equal(app?.humanReview.canRequest, true);
    assert.equal(app?.sentAt, "2026-10-27T14:02:00.000Z");
    assert.equal(record.takedown, null);
  });

  it("reads a held app as checked, or with a person, by its stage", () => {
    const pending = (stage: string, human: Record<string, unknown> = { state: "none", canRequest: false }) =>
      reviewRecordOf({
        native: {
          builds: [],
          submissions: [{ ...rejected(), review: "pending", reviewDetail: { stage, humanReview: human } }],
        },
        project: {},
      });
    assert.equal(pending("checking")?.apps[0]?.state, GenexAppReview.Checking);
    assert.equal(pending("person")?.apps[0]?.state, GenexAppReview.WithPerson);
    const asked = pending("person", { state: "requested", canRequest: false, requestedAt: "2026-10-27T15:00:00Z" });
    assert.equal(asked?.apps[0]?.humanReview.state, GenexHumanReview.Requested);
    assert.equal(asked?.state, GenexGameReview.WithPerson);
  });

  it("reads an older API with no review detail as today: held is checked, turned down has its reason as one thing", () => {
    const { reviewDetail: _held, ...plain } = rejected();
    const held = reviewRecordOf({
      native: { builds: [], submissions: [{ ...plain, review: "pending" }] },
      project: {},
    });
    assert.equal(held?.apps[0]?.state, GenexAppReview.Checking);
    assert.equal(held?.apps[0]?.humanReview.canRequest, false);
    const down = reviewRecordOf({ native: { builds: [], submissions: [plain] }, project: {} });
    assert.equal(down?.apps[0]?.state, GenexAppReview.NotApproved);
    assert.deepEqual(down?.apps[0]?.things, [{ text: plain.reviewReason }]);
    assert.equal(down?.apps[0]?.humanReview.canRequest, false);
  });

  it("reads a held app at a stage Studio does not know as held, checked", () => {
    const later = {
      ...rejected(),
      review: "pending",
      reviewDetail: { stage: "later", humanReview: { canRequest: true } },
    };
    const record = reviewRecordOf({ native: { submissions: [later] }, project: {} });
    assert.equal(record?.apps[0]?.state, GenexAppReview.Checking);
    assert.equal(
      record?.apps[0]?.humanReview.canRequest,
      false,
      "nothing else of a detail Studio does not know is read",
    );
  });

  it("reads an admin's build, which has no review, as live", () => {
    const { review: _none, reviewDetail: _detail, ...admin } = live();
    const record = reviewRecordOf({ native: { builds: [admin], submissions: [] }, project: {} });
    assert.equal(record?.apps[0]?.state, GenexAppReview.Live);
    assert.equal(record?.state, GenexGameReview.Live);
    assert.equal(record?.apps[0]?.decidedBy, undefined);
  });

  it("reads a live build newer than a turned-down one as live: the newer send was approved", () => {
    const newer = live({ version: "1.4.0", publishedAt: "2026-10-28T09:00:00.000Z" });
    const record = reviewRecordOf({ native: { builds: [newer], submissions: [rejected()] }, project: {} });
    assert.equal(record?.apps[0]?.state, GenexAppReview.Live);
    assert.equal(record?.apps[0]?.version, "1.4.0");
  });

  it("caps the things at ten, cuts long text and where, and drops a thing with no text", () => {
    const many = Array.from({ length: 14 }, (_, n) => ({ text: `${n} ${"x".repeat(300)}`, where: "w".repeat(300) }));
    const record = reviewRecordOf({
      native: { submissions: [rejected({ things: [{ text: "" }, { where: "only" }, ...many] })] },
      project: {},
    });
    const things = record?.apps[0]?.things ?? [];
    assert.equal(things.length, REVIEW_THINGS_MAX);
    assert.ok(things.every((thing) => thing.text.length <= REVIEW_TEXT_CHARS));
    assert.ok(things.every((thing) => (thing.where ?? "").length <= REVIEW_WHERE_CHARS));
    assert.match(things[0]?.text ?? "", /^0 x/);
  });

  const hostile: Array<[string, unknown]> = [
    ["an unknown review", { submissions: [{ ...rejected(), review: "maybe" }] }],
    ["a row with no platform", { submissions: [{ ...rejected(), platform: 7 }] }],
    ["a row with no version", { builds: [{ ...live(), version: null }] }],
    ["rows that are not a list", { builds: "mac", submissions: { mac: true } }],
    ["no answer", null],
    ["a string", "builds"],
  ];
  for (const [name, native] of hostile) {
    it(`drops ${name}`, () => {
      const record = reviewRecordOf({ native, project: {} });
      assert.deepEqual(record?.apps ?? [], []);
      assert.equal(record?.state ?? GenexGameReview.NotPublished, GenexGameReview.NotPublished);
    });
  }

  it("ignores fields that are not what they should be, keeping the rest", () => {
    const record = reviewRecordOf({
      native: {
        submissions: [
          rejected({
            decidedBy: "admin@genex.games",
            reply: 42,
            things: [{ text: "Loads code from another website", where: { line: 3 }, rule: ["x"] }],
            humanReview: { state: "sometime", canRequest: "yes" },
            nextReviewBy: "robot",
          }),
        ],
      },
      project: {},
    });
    const app = record?.apps[0];
    assert.equal(app?.decidedBy, undefined, "never an email, never an unknown decider");
    assert.equal(app?.reply, undefined);
    assert.deepEqual(app?.things, [{ text: "Loads code from another website" }]);
    assert.equal(app?.humanReview.state, GenexHumanReview.None);
    assert.equal(app?.humanReview.canRequest, false);
    assert.equal(app?.nextReviewBy, undefined);
  });
});

describe("the owner read's takedown", () => {
  const takedown = {
    at: "2026-10-27T14:06:00.000Z",
    category: "off_platform_payment",
    rule: "Off-platform payment",
    things: [{ text: "The “Get 5,000 coins” button opens an outside payment page", rule: "Off-platform payment" }],
    appealable: true,
    humanReview: { state: "none", canRequest: true, requestedAt: null, expectedBy: null, decidedAt: null, reply: null },
  };

  it("reads a takedown as the game's headline, whatever its apps", () => {
    const record = reviewRecordOf({ native: { builds: [live()] }, project: { takedown } });
    assert.equal(record?.state, GenexGameReview.TakenDown);
    assert.equal(record?.takedown?.things.length, 1);
    assert.equal(record?.takedown?.rule, "Off-platform payment");
    assert.equal(record?.takedown?.humanReview.canRequest, true);
    assert.equal(record?.takedown?.noteMin, undefined);
  });

  it("reads a takedown whose reason is never told apart as one with nothing to fix and no request", () => {
    const record = reviewRecordOf({
      native: {},
      project: {
        takedown: { ...takedown, category: null, rule: null, things: [], appealable: false, humanReview: {} },
      },
    });
    assert.equal(record?.takedown?.appealable, false);
    assert.deepEqual(record?.takedown?.things, []);
    assert.equal(record?.takedown?.humanReview.canRequest, false);
    assert.equal(record?.takedown?.rule, undefined);
  });

  it("reads an older API's takedownAt as a takedown, its detail the one thing, its note at least 20", () => {
    const record = reviewRecordOf({
      native: {},
      project: { takedownAt: "2026-10-27T14:06:00.000Z", moderationDetail: "Opens an outside payment page" },
    });
    assert.equal(record?.state, GenexGameReview.TakenDown);
    assert.deepEqual(record?.takedown?.things, [{ text: "Opens an outside payment page" }]);
    assert.equal(record?.takedown?.noteMin, OLD_APPEAL_NOTE_MIN);
    assert.equal(record?.takedown?.humanReview.canRequest, true);
  });

  it("reads null takedown, and no takedownAt, as none", () => {
    assert.equal(reviewRecordOf({ native: {}, project: { takedown: null } })?.takedown, null);
    assert.equal(reviewRecordOf({ native: {}, project: { takedownAt: null } })?.takedown, null);
  });
});

describe("`genex review --json`", () => {
  const answer = {
    game: {
      id: "cl1",
      slug: "midnight-asphalt",
      title: "Midnight Asphalt",
      url: "https://genex.games/midnight-asphalt",
    },
    state: "not_approved",
    takedown: null,
    apps: [
      {
        platform: "mac",
        arch: "arm64",
        state: "not_approved",
        version: "1.3.0",
        sha256: SHA,
        sentAt: "2026-10-27T14:02:00.000Z",
        decidedAt: "2026-10-27T14:06:00.000Z",
        decidedBy: "check",
        things: [{ text: "Mines cryptocurrency on the player's computer", where: "vendor/worker.min.js" }],
        reply: null,
        humanReview: { state: "none", canRequest: true },
        nextReviewBy: "check",
        players: { version: "1.2.0", since: "2026-10-25T10:03:10.000Z" },
      },
      { platform: "windows", arch: "x64", state: "exploded", version: "1.0.0" },
    ],
    brief: null,
  };

  it("reads its apps and drops an unknown state", () => {
    const record = reviewRecordOf({ review: answer });
    assert.equal(record?.state, GenexGameReview.NotApproved);
    assert.equal(record?.apps.length, 1);
    assert.equal(record?.apps[0]?.players?.version, "1.2.0");
    assert.equal(record?.apps[0]?.things[0]?.where, "vendor/worker.min.js");
  });

  it("prints the same fingerprint for the same review, and another once anything changes", () => {
    const first = reviewRecordOf({ review: answer });
    const again = reviewRecordOf({ review: structuredClone(answer) });
    assert.ok(first && again);
    assert.equal(reviewFingerprint(first), reviewFingerprint(again));
    const decided = structuredClone(answer);
    decided.apps[0] = { ...decided.apps[0], state: "live" } as (typeof decided.apps)[0];
    const changed = reviewRecordOf({ review: decided });
    assert.ok(changed);
    assert.notEqual(reviewFingerprint(first), reviewFingerprint(changed));
  });

  it("answers nothing for an answer that is not a review", () => {
    assert.equal(reviewRecordOf({ review: null }), null);
    assert.equal(reviewRecordOf({ review: { apps: "mac" } })?.apps.length ?? 0, 0);
  });
});

describe("a sent build's review detail", () => {
  it("keeps a known stage and decider and drops the rest", () => {
    assert.deepEqual(reviewDetailOf({ stage: "checking", decidedBy: null, decidedAt: null }), { stage: "checking" });
    assert.deepEqual(reviewDetailOf({ stage: "decided", decidedBy: "person", decidedAt: "2026-10-27T14:06:00Z" }), {
      stage: "decided",
      decidedBy: "person",
      decidedAt: "2026-10-27T14:06:00Z",
    });
    assert.equal(reviewDetailOf({ stage: "soon" }), undefined);
    assert.equal(reviewDetailOf("checking"), undefined);
  });
});

describe("a sent app's row beside the kept review", () => {
  const kept = reviewRecordOf({ native: { builds: [], submissions: [rejected()] }, project: {} });
  const sent = (extra: Record<string, unknown>) => ({
    platform: "mac",
    arch: "arm64",
    version: "1.3.0",
    sizeBytes: 1,
    sha256: SHA,
    publishedAt: "2026-10-27T14:02:00.000Z",
    review: "pending" as const,
    ...extra,
  });

  it("takes Genex's word on the very build that was sent", () => {
    const [row] = sentWithReview([sent({})], kept);
    assert.equal(row?.review, "rejected");
  });

  it("leaves a build sent again with the same version as sent: Genex has said nothing of it yet", () => {
    const fixed = sent({ sha256: "b".repeat(64), publishedAt: "2026-10-27T15:00:00.000Z" });
    assert.deepEqual(sentWithReview([fixed], kept), [fixed]);
    const sameBytes = sent({ publishedAt: "2026-10-27T15:00:00.000Z" });
    assert.deepEqual(sentWithReview([sameBytes], kept), [sameBytes], "sent after the review was read");
    const { sha256: _none, ...noArchive } = sent({ publishedAt: "2026-10-27T15:00:00.000Z" });
    assert.deepEqual(sentWithReview([noArchive], kept), [noArchive], "no archive: told apart by when it went");
  });
});

describe("the plugin's answers as main reads them", () => {
  const status = {
    record: {
      state: "not_approved",
      apps: [
        {
          ...rejected(),
          state: "not_approved",
          things: [{ text: "x" }],
          humanReview: { state: "none", canRequest: true },
        },
      ],
      takedown: null,
    },
    checkedAt: "2026-10-27T14:07:00.000Z",
    connected: true,
    failures: 0,
    open: false,
    fingerprint: "stale",
    told: { fingerprint: "f", keys: { "app:mac/arm64": "x" } },
    publishing: false,
  };

  it("keeps a review-status answer through the same checks as the kept review", () => {
    const read = readReviewStatus(status);
    assert.equal(read?.record?.state, GenexGameReview.NotApproved);
    assert.equal(read?.fingerprint, read?.record ? reviewFingerprint(read.record) : null, "the print is Studio's own");
    assert.deepEqual(read?.told, status.told);
    assert.equal(readReviewStatus({ ...status, problem: "on_fire" })?.problem, undefined);
  });

  for (const [name, raw] of [
    ["nothing", undefined],
    ["a string", "record"],
    ["no record", { connected: true }],
    ["no sign-in", { record: null }],
  ] as const)
    it(`answers no status for ${name}`, () => {
      assert.equal(readReviewStatus(raw), null);
    });

  it("keeps a review-request answer's apps, takedown and known refusal", () => {
    assert.deepEqual(
      readRequestAnswer({
        requested: [{ platform: "mac", arch: "arm64", resend: true }, { platform: 7 }],
        takedown: false,
        refused: "already_requested",
      }),
      { requested: [{ platform: "mac", arch: "arm64", resend: true }], takedown: false, refused: "already_requested" },
    );
    assert.deepEqual(readRequestAnswer({ requested: [], takedown: true, refused: "because" }), {
      requested: [],
      takedown: true,
    });
    assert.equal(readRequestAnswer({ requested: [] }), null);
    assert.equal(readRequestAnswer(null), null);
  });
});

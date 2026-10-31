import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canAskCover,
  clock,
  coverCardPublish,
  coverChoices,
  flipCover,
  GenexSetup,
  genexSetup,
  isGenexPublish,
  justPublished,
  needsCover,
  offeredTitle,
  PublishGate,
  publishGate,
  publishReport,
  publishSteps,
  publishView,
  testLinkOf,
  stripEntries,
  studioPublishButton,
} from "../../src/renderer/panels/plugins/genex/genex-publish-view.ts";
import {
  GENEX_PLUGIN_ID,
  GENEX_PUBLISH_PANEL,
  type GenexCoverRecord,
  GenexCoverOutcome,
  type GenexCoverSent,
  type GenexCoverShot,
  type GenexPublishJob,
  type GenexPublishState,
} from "../../src/shared/genex.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import { CaptureSource, StillMimeType } from "../../src/shared/preview-contract.ts";
import { CoreFact, type FactRef, FolderHolds } from "../../src/shared/project-facts.ts";

const state = (over: Partial<GenexPublishState> = {}): GenexPublishState => ({
  version: 1,
  project: "game",
  connected: true,
  ...over,
});
const job = (over: Partial<GenexPublishJob> = {}): GenexPublishJob => ({
  id: "j1",
  kind: "gallery",
  state: "running",
  phase: "exporting",
  startedAt: "2026-09-30T10:00:00Z",
  ...over,
});

test("the dialog names where the game is and offers one press from there", () => {
  const none = publishView(state());
  assert.equal(none.stage, "none");
  assert.equal(none.primary.label, "Publish to the web");
  assert.equal(none.primary.ariaLabel, "Publish this game on Genex", "the smoke selector stays");
  assert.equal(none.canPublish, true);
  assert.ok(!("secondary" in none), "a draft is no second button beside Publish");

  const draft = publishView(state({ slug: "my-game", status: "draft", draftUrl: "https://x/draft" }));
  assert.equal(draft.stage, "draft");
  assert.equal(draft.primary.label, "Publish to the web");

  const live = publishView(state({ slug: "my-game", status: "published", galleryUrl: "https://x/g" }));
  assert.equal(live.stage, "public");
  assert.equal(live.primary.label, "Publish update");

  const signedOut = publishView(state({ connected: false }));
  assert.equal(signedOut.canPublish, false);
  assert.deepEqual(signedOut.problems, [], "Connect Genex is offered in its place, not reported as a problem");
});

test("Publish asks only for an account: Genex on or off publishes, and signing in brings back a missing Genex", () => {
  assert.equal(publishGate(undefined, undefined), PublishGate.SignIn);
  assert.equal(publishGate({ enabled: false, removed: true }, undefined), PublishGate.SignIn);
  for (const enabled of [true, false]) {
    assert.equal(publishGate({ enabled, removed: false }, false), PublishGate.SignIn, `on: ${enabled}`);
    assert.equal(publishGate({ enabled, removed: false }, true), PublishGate.Ready, `on: ${enabled}`);
    assert.equal(publishGate({ enabled, removed: false }, undefined), PublishGate.Ready, "unread yet is not asked for");
  }
});

test("Multiplayer asks for the Genex plugin: installed, then turned on", () => {
  assert.equal(genexSetup(undefined), GenexSetup.Install);
  assert.equal(genexSetup({ enabled: false, removed: true }), GenexSetup.Install);
  assert.equal(genexSetup({ enabled: false, removed: false }), GenexSetup.TurnOn);
});

const genex = (over: Partial<PluginInfo> = {}): PluginInfo => ({
  manifest: {
    apiVersion: 3,
    id: GENEX_PLUGIN_ID,
    version: "1.0.0",
    name: "Genex Tools",
    publisher: "Genex",
    description: "t",
    backend: "backend.mjs",
    capabilities: [],
    tools: [],
    skills: [],
    panels: [{ id: GENEX_PUBLISH_PANEL, title: "Publish", file: "publish.html", placement: "project" }],
    settings: [],
    actions: [],
    toolbar: [
      {
        id: "publish",
        label: "Publish",
        ariaLabel: "Publish game",
        target: { kind: "panel", id: GENEX_PUBLISH_PANEL },
      },
    ],
  },
  source: "bundled",
  enabled: true,
  removed: false,
  health: "stopped",
  state: "enabled",
  ...over,
});

test("every open web game has Publish on its stage strip, whether Genex is on, off, removed or missing", () => {
  const web: FactRef[] = [{ id: CoreFact.WebGame, path: "." }];
  const off = genex({ enabled: false, state: "disabled" });
  assert.equal(studioPublishButton([genex()], "game", web), false, "Genex's own button is the one shown");
  assert.equal(studioPublishButton([off], "game", web), false, "off too: Publish is the account's");
  assert.deepEqual(
    stripEntries([off], "game", web).map((entry) => [entry.key, entry.plugin.enabled]),
    [[`${GENEX_PLUGIN_ID}:publish`, false]],
    "only Publish of an off Genex's buttons, on the plugin as it is",
  );
  assert.equal(studioPublishButton([genex({ enabled: false, removed: true, state: "disabled" })], "game", web), true);
  assert.equal(studioPublishButton([], "game", web), true);
  assert.equal(studioPublishButton([], null, web), false, "with no game open there is nothing to publish");
});

/** Another plugin's stage-strip button, which no engine takes away. */
const other = (): PluginInfo => {
  const base = genex();
  return {
    ...base,
    manifest: {
      ...base.manifest,
      id: "demo",
      panels: [{ id: "demo", title: "Demo", file: "demo.html", placement: "project" }],
      toolbar: [{ id: "demo", label: "Demo", ariaLabel: "Demo panel", target: { kind: "panel", id: "demo" } }],
    },
  };
};

test("an Unreal game has no Publish on its strip: its folder holds an Unreal project, not a web build", () => {
  const unreal: FactRef[] = [{ id: CoreFact.UnrealProject, path: "unreal" }];
  const strip = (plugins: PluginInfo[], facts: FactRef[]) => ({
    genex: stripEntries(plugins, "game", facts).some(isGenexPublish),
    studio: studioPublishButton(plugins, "game", facts),
    others: stripEntries(plugins, "game", facts)
      .filter((entry) => !isGenexPublish(entry))
      .map((entry) => entry.key),
  });
  const genexStates: Array<[string, PluginInfo[]]> = [
    ["Genex on", [genex(), other()]],
    ["Genex off", [genex({ enabled: false, state: "disabled" }), other()]],
    ["Genex removed", [genex({ enabled: false, removed: true, state: "disabled" }), other()]],
    ["Genex missing", [other()]],
  ];
  for (const [name, plugins] of genexStates)
    assert.deepEqual(
      strip(plugins, unreal),
      { genex: false, studio: false, others: ["demo:demo"] },
      `${name}: no Publish, every other button stays`,
    );

  assert.deepEqual(strip([genex(), other()], []), {
    genex: true,
    studio: false,
    others: ["demo:demo"],
  });
  assert.deepEqual(strip([genex({ enabled: false, state: "disabled" }), other()], []), {
    genex: true,
    studio: false,
    others: ["demo:demo"],
  });
  assert.deepEqual(strip([other()], [{ id: CoreFact.WebGame, path: "." }]), {
    genex: false,
    studio: true,
    others: ["demo:demo"],
  });
});

test("Publish sits on the strip while the game is served as a web game at its root, or has one in a folder of it", () => {
  const strip = (facts: FactRef[], holds?: FolderHolds) => ({
    genex: stripEntries([genex(), other()], "game", facts, holds).some(isGenexPublish),
    studio: studioPublishButton([other()], "game", facts, holds),
  });
  const rows: Array<[string, FactRef[], FolderHolds | undefined, boolean]> = [
    ["a web game at the root", [{ id: CoreFact.WebGame, path: "." }], undefined, true],
    ["no kind yet, served as a web game", [], undefined, true],
    ["an empty folder, served as a web game", [], FolderHolds.Nothing, true],
    ["a folder of notes, served as a web game", [], FolderHolds.Notes, true],
    ["a folder of its own files of a kind no rule knows", [], FolderHolds.OwnFiles, false],
    ["a folder that can't be read", [], FolderHolds.Unreadable, false],
    ["a Godot project", [{ id: CoreFact.GodotProject, path: "." }], undefined, false],
    [
      "a web game only below the root (an engine's web export) publishes that folder",
      [{ id: CoreFact.WebGame, path: "site" }],
      undefined,
      true,
    ],
    [
      "a Godot project with its web export",
      [
        { id: CoreFact.GodotProject, path: "godot" },
        { id: CoreFact.WebGame, path: "web" },
      ],
      undefined,
      true,
    ],
    ["a linked Unreal project", [{ id: CoreFact.UnrealProject, path: "unreal" }], undefined, false],
  ];
  for (const [name, facts, holds, shown] of rows)
    assert.deepEqual(
      strip(facts, holds),
      { genex: shown, studio: shown },
      `${name}: Publish ${shown ? "shown" : "hidden"}`,
    );
});

test("the chat's Genex cover card offers Publish while Genex's own Publish is on the strip and nothing publishes", () => {
  assert.equal(coverCardPublish([genex()], "game", state()), true);
  assert.equal(coverCardPublish([genex()], "game", null), true, "a record not read yet hides nothing");
  assert.equal(coverCardPublish([genex()], "game", state({ job: job() })), false, "a publish is running");
  assert.equal(coverCardPublish([genex()], "game", state({ job: job({ state: "unresolved" }) })), false);
  assert.equal(coverCardPublish([genex()], "game", state({ job: job({ state: "done", phase: "done" }) })), true);
  assert.equal(coverCardPublish([genex()], "game", state({ job: job({ state: "failed", phase: "failed" }) })), true);
  assert.equal(coverCardPublish([genex({ enabled: false, state: "disabled" })], "game", state()), true, "Genex off");
  assert.equal(coverCardPublish([genex({ removed: true })], "game", state()), false, "Genex removed");
  assert.equal(coverCardPublish([], "game", state()), false, "Genex missing");
  assert.equal(coverCardPublish([genex()], null, state()), false, "no game to publish");
});

test("a running attempt shows its steps: every publish tests the draft before it goes live", () => {
  assert.deepEqual(publishSteps(job({ phase: "creating-project" })), ["prepare", "upload", "test", "live"]);
  assert.deepEqual(publishSteps(job({ kind: "draft", phase: "uploading" })), ["prepare", "upload", "test"]);

  const now = Date.parse("2026-09-30T10:00:30Z");
  const testing = publishView(state({ slug: "g", job: job({ phase: "verifying-deployment" }) }), now);
  assert.equal(testing.running, true);
  assert.equal(testing.slow, false);
  assert.equal(testing.canPublish, false, "nothing else starts while one runs");
  assert.equal(testing.phase, "Testing", "the busy button says the step");
  assert.equal(testing.chip, null, "the banner says nothing while the button does");
  assert.deepEqual(
    testing.steps.map((s) => [s.step, s.state]),
    [
      ["prepare", "done"],
      ["upload", "done"],
      ["test", "current"],
      ["live", "next"],
    ],
  );
  const promoting = publishView(state({ slug: "g", status: "published", job: job({ phase: "promoting" }) }), now);
  assert.equal(promoting.phase, "Going live");
  assert.equal(promoting.steps.at(-1)?.state, "current");
});

test("a test running past two minutes is Still testing; an earlier step never is", () => {
  const late = Date.parse("2026-09-30T10:02:01Z");
  const testing = publishView(state({ slug: "g", job: job({ phase: "verifying-deployment" }) }), late);
  assert.equal(testing.slow, true);
  assert.equal(testing.phase, "Still testing");
  assert.equal(testing.again, null, "an upload this Studio still runs is not published over");
  const uploading = publishView(state({ slug: "g", job: job({ phase: "uploading" }) }), late);
  assert.equal(uploading.slow, false);
  assert.equal(uploading.phase, "Uploading");
});

test("a live game shows its link and when it was updated, on the banner", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const live = publishView(
    state({
      slug: "g",
      status: "published",
      galleryUrl: "https://genex.games/g",
      lastPublishAt: "2026-10-06T11:58:00Z",
      job: job({ state: "done", phase: "ready" }),
    }),
    now,
  );
  assert.equal(live.link, "https://genex.games/g");
  assert.deepEqual(live.chip, { tone: "live", text: "Live · 2m ago" });
  assert.equal(live.failure, null);
  assert.equal(
    publishView(state({ slug: "g", galleryUrl: "https://genex.games/g" })).link,
    null,
    "a draft has no public link",
  );
  assert.deepEqual(
    publishView(state({ slug: "g", status: "draft" })).chip,
    { tone: "quiet", text: "Not published" },
    "a draft page alone is not published",
  );
});

test("the dialog celebrates only an attempt it watched go live", () => {
  const running = publishView(state({ slug: "g", job: job({ phase: "promoting" }) }));
  const live = publishView(
    state({ slug: "g", status: "published", galleryUrl: "https://x/g", job: job({ state: "done", phase: "ready" }) }),
  );
  const failed = publishView(state({ slug: "g", job: job({ state: "failed", phase: "failed" }) }));
  assert.equal(justPublished(running, live), true);
  assert.equal(justPublished(null, live), false, "opening on a live game celebrates nothing");
  assert.equal(justPublished(live, live), false);
  assert.equal(justPublished(running, failed), false);
});

test("a failed attempt is one calm line, its raw error kept for the report Send report posts", () => {
  const failed = publishView(
    state({ job: job({ state: "failed", phase: "failed", error: "fixture: HTTP 502 at /api" }) }),
  );
  assert.equal(failed.outcome, "failed");
  assert.deepEqual(failed.problems, [], "the raw error is no problem line");
  assert.deepEqual(failed.chip, { tone: "failed", text: "Didn't publish" });
  assert.equal(failed.failure?.text, "Nothing changed. Try again in a moment.");
  assert.equal(failed.failure?.details, "fixture: HTTP 502 at /api");
  assert.equal(failed.primary.label, "Try again");
  assert.equal(failed.canPublish, true, "a failed attempt can be tried again");

  const report = publishReport("game", "My Game", failed);
  assert.equal(report.appLogs, true, "the report carries the app's logs");
  assert.equal(report.chatId, null, "and no chat");
  assert.match(report.text, /My Game/);
  assert.match(report.text, /HTTP 502 at \/api/);

  const listedFailed = publishView(
    state({ slug: "g", status: "published", job: job({ state: "failed", phase: "failed", error: "x" }) }),
  );
  assert.equal(listedFailed.failure?.text, "The last version is still live.");
});

test("an upload whose outcome is unknown is still testing, with Publish again as the one way out", () => {
  const unknown = publishView(
    state({ slug: "g", job: job({ state: "unresolved", phase: "unresolved", kind: "draft", error: "lost" }) }),
  );
  assert.equal(unknown.running, true);
  assert.equal(unknown.unresolved, true);
  assert.equal(unknown.slow, true);
  assert.equal(unknown.phase, "Still testing");
  assert.equal(unknown.failure, null, "nothing failed yet");
  assert.deepEqual(
    [unknown.again?.label, unknown.again?.action, unknown.again?.args],
    ["Publish again", "publish-allow-upload", { jobId: "j1" }],
  );
  assert.equal(unknown.canPublish, false, "Publish is never pressed over it by accident");
  assert.equal(unknown.steps.find((s) => s.state === "current")?.step, "test");

  const terms = publishView(state({ terms: { accepted: false, acceptUrl: "https://x/terms" } }));
  assert.deepEqual(terms.problems, ["Review the updated Genex terms in your browser before publishing."]);
  assert.equal(terms.terms?.action, "terms", "the one press is reviewing them");
  assert.equal(publishView(state()).terms, null);
});

test("the busy button's clock reads minutes and seconds", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(24), "0:24");
  assert.equal(clock(134), "2:14");
});

test("the name offered is the listed one, else Studio's title for the game, else its folder name as words", () => {
  assert.equal(offeredTitle(state({ title: "Rain Circuit" }), "Racing", "racing-demo"), "Rain Circuit");
  assert.equal(
    offeredTitle(state(), "Hyper-Realistic Racing", "hyper-realistic-racing-demo"),
    "Hyper-Realistic Racing",
  );
  assert.equal(offeredTitle(null, undefined, "hyper-realistic-racing-demo"), "Hyper Realistic Racing Demo");
  assert.equal(offeredTitle(null, "   ", "rain_circuit"), "Rain Circuit");
});

const shot: GenexCoverShot = {
  sha256: "a".repeat(64),
  width: 1920,
  height: 1080,
  mimeType: StillMimeType.Png,
  bytes: 1024,
  source: CaptureSource.Page,
  stats: { lumaMean: 0.4, lumaStdDev: 0.2, nearBlackFraction: 0.1, litFraction: 0.9 },
  takenAt: "2026-10-09T10:00:00Z",
};
const cover = (over: Partial<GenexCoverRecord> = {}): GenexCoverRecord => ({
  shot: null,
  last: null,
  sending: false,
  ...over,
});
const last = (kind: GenexCoverOutcome) => ({ kind, at: "2026-10-09T10:05:00Z" });

test("Studio takes a cover as the dialog opens only while the game has none and its owner chose none", () => {
  const live = { slug: "g", status: "published", lastPublishAt: "2026-10-09T10:05:00Z" } as const;
  const rows: Array<[string, GenexPublishState, boolean]> = [
    ["a game with no cover shot", state({ cover: cover() }), true],
    [
      "a published game whose last publish had no shot to send",
      state({ ...live, cover: cover({ last: last(GenexCoverOutcome.None) }) }),
      true,
    ],
    ["a cover shot kept to send", state({ cover: cover({ shot }) }), false],
    ["a cover being sent now", state({ ...live, cover: cover({ sending: true }) }), false],
    [
      "the owner chose the cover on genex.games",
      state({ ...live, cover: cover({ last: last(GenexCoverOutcome.KeptOwner) }) }),
      false,
    ],
    [
      "the owner's pick outranked a frame",
      state({ ...live, cover: cover({ last: last(GenexCoverOutcome.Outranked) }) }),
      false,
    ],
    [
      "the same frame sent again, where the owner's pick held",
      state({
        ...live,
        cover: cover({ last: { ...last(GenexCoverOutcome.Unchanged), settled: GenexCoverOutcome.KeptOwner } }),
      }),
      false,
    ],
    ["a Genex plugin that answers no cover", state(live), false],
    ["a publish running", state({ cover: cover(), job: job() }), false],
  ];
  for (const [label, record, asks] of rows) {
    assert.equal(needsCover(record), asks, label);
    assert.equal(publishView(record).needsCover, asks, `${label}: the view`);
  }
});

test("the dialog says plainly when the game goes out without a cover", () => {
  const live = { slug: "g", status: "published", lastPublishAt: "2026-10-09T10:05:00Z" } as const;
  const blank = { ...shot, stats: { lumaMean: 0.02, lumaStdDev: 0.01, nearBlackFraction: 0.99, litFraction: 0 } };
  const rows: Array<[string, GenexPublishState, boolean]> = [
    ["no shot, and Genex has none", state({ cover: cover() }), true],
    ["a kept shot that is only a black screen", state({ cover: cover({ shot: blank }) }), true],
    [
      "a published game whose last publish sent nothing",
      state({ ...live, cover: cover({ last: last(GenexCoverOutcome.None) }) }),
      true,
    ],
    ["a real picture kept to send", state({ cover: cover({ shot }) }), false],
    ["a cover Genex already shows", state({ ...live, cover: cover({ last: last(GenexCoverOutcome.Applied) }) }), false],
    [
      "the same frame Genex already shows",
      state({
        ...live,
        cover: cover({ last: { ...last(GenexCoverOutcome.Unchanged), settled: GenexCoverOutcome.Applied } }),
      }),
      false,
    ],
    [
      "the owner's own pick on genex.games",
      state({ ...live, cover: cover({ last: last(GenexCoverOutcome.KeptOwner) }) }),
      false,
    ],
    ["a cover being sent now", state({ cover: cover({ sending: true }) }), false],
    ["a publish running", state({ cover: cover(), job: job() }), false],
    ["a plugin older than covers", state(), false],
  ];
  for (const [label, record, says] of rows) assert.equal(publishView(record).withoutCover, says, label);
});

test("Another cover is offered while nothing runs and the owner chose no cover", () => {
  const rows: Array<[string, GenexPublishState, boolean]> = [
    ["a kept shot", state({ cover: cover({ shot }) }), true],
    ["no shot yet", state({ cover: cover() }), true],
    ["a cover being sent", state({ cover: cover({ shot, sending: true }) }), false],
    ["a publish running", state({ cover: cover({ shot }), job: job() }), false],
    ["the owner's cover holds", state({ cover: cover({ shot, last: last(GenexCoverOutcome.KeptOwner) }) }), false],
    ["a plugin older than covers", state(), false],
  ];
  for (const [label, record, offers] of rows) {
    assert.equal(canAskCover(record), offers, label);
    assert.equal(publishView(record).canAskCover, offers, `${label}: the view`);
  }
});

test("the banner's arrows flip through the recent frames, wrapping round", () => {
  const a = { ...shot, sha256: "a".repeat(64) };
  const b = { ...shot, sha256: "b".repeat(64) };
  const c = { ...shot, sha256: "c".repeat(64) };
  const three = cover({ shot: b, candidates: [c, b, a] });
  assert.deepEqual(coverChoices(three), { shas: [c.sha256, b.sha256, a.sha256], index: 1 });
  assert.equal(flipCover(coverChoices(three), 1), a.sha256, "older");
  assert.equal(flipCover(coverChoices(three), -1), c.sha256, "newer");
  assert.equal(flipCover(coverChoices(cover({ shot: a, candidates: [c, b, a] })), 1), c.sha256, "past the oldest");
  assert.equal(flipCover(coverChoices(cover({ shot: a, candidates: [a] })), 1), null, "one frame: nothing to flip");
  assert.equal(flipCover(coverChoices(cover({ shot: a })), 1), null, "a plugin older than candidates");
  assert.deepEqual(coverChoices(cover({ shot: a, candidates: [c, b] })).index, -1, "a kept shot no longer listed");
  assert.equal(flipCover(coverChoices(cover({ shot: a, candidates: [c, b] })), 1), b.sha256);
});

test("the chat's cover card leaves Publish out once Genex has answered for the kept frame", () => {
  const sent = (kind: GenexCoverOutcome, over: Partial<GenexCoverSent> = {}): GenexCoverSent => ({
    ...last(kind),
    sha256: shot.sha256,
    ...over,
  });
  const { Applied, Outranked, KeptOwner, Unchanged, Failed, NotHosted, Rejected } = GenexCoverOutcome;
  const rows: Array<[string, GenexCoverRecord, boolean]> = [
    ["a kept frame never sent", cover({ shot }), true],
    ["Genex took this frame (a publish re-shoots and sends it)", cover({ shot, last: sent(Applied) }), false],
    ["the owner's pick outranked this frame", cover({ shot, last: sent(Outranked) }), false],
    ["the owner's pick held, nothing uploaded", cover({ shot, last: sent(KeptOwner) }), false],
    ["this frame again, Genex took it before", cover({ shot, last: sent(Unchanged, { settled: Applied }) }), false],
    [
      "a newer frame kept since the last one went",
      cover({ shot, last: sent(Applied, { sha256: "b".repeat(64) }) }),
      true,
    ],
    ["this frame did not reach Genex: the next publish tries again", cover({ shot, last: sent(Failed) }), true],
    ["no hosted project yet: the first publish takes it", cover({ shot, last: sent(NotHosted) }), true],
    ["Genex refused this frame", cover({ shot, last: sent(Rejected) }), true],
    ["this frame again, refused before", cover({ shot, last: sent(Unchanged, { settled: Rejected }) }), true],
  ];
  for (const [label, record, offers] of rows)
    assert.equal(coverCardPublish([genex()], "game", state({ cover: record })), offers, label);
});

test("the test link shows only while it holds a build players do not have", () => {
  const ready = {
    revision: "r2",
    url: "https://preview--g.genex.technology/",
    digest: "d",
    verifiedAt: "2026-10-06T12:10:00Z",
  };
  // Before the first publish: any tested draft is worth a link.
  assert.equal(publishView(state({ slug: "g", status: "draft", readyDraft: ready })).testLink, ready.url);
  assert.equal(publishView(state({ slug: "g", status: "draft" })).testLink, null, "no tested draft, no link");
  // Live, and the draft was tested after the last publish: the changes are worth a link.
  const live = {
    slug: "g",
    status: "published" as const,
    galleryUrl: "https://genex.games/g",
    lastPublishAt: "2026-10-06T12:00:00Z",
  };
  assert.equal(
    publishView(state({ ...live, readyDraft: ready, job: job({ kind: "draft", state: "done", phase: "ready" }) }))
      .testLink,
    ready.url,
  );
  // A publish tests its own draft before it goes live, then stamps lastPublishAt: no second link.
  const sameBuild = { ...ready, verifiedAt: "2026-10-06T11:59:00Z" };
  assert.equal(publishView(state({ ...live, readyDraft: sameBuild })).testLink, null);
  // A publish Genex settled later (verified after the stamp) still is the live build when the revisions match.
  assert.equal(
    testLinkOf(
      state({ ...live, readyDraft: ready, job: job({ state: "done", phase: "ready", expectedStagingRevision: "r2" }) }),
      true,
    ),
    null,
  );
  // A later attempt that uploaded and then failed its test: the address now serves that untested build.
  const failedLater = job({ kind: "draft", state: "failed", phase: "ready", uploadedAt: "2026-10-06T12:20:00Z" });
  assert.equal(publishView(state({ slug: "g", status: "draft", readyDraft: ready, job: failedLater })).testLink, null);
  assert.equal(
    publishView(
      state({
        slug: "g",
        status: "draft",
        readyDraft: ready,
        job: { ...failedLater, uploadedAt: "2026-10-06T12:05:00Z" },
      }),
    ).testLink,
    ready.url,
    "a failure that uploaded before the tested draft leaves the tested draft in place",
  );
  // While an attempt runs, the window shows its progress, not links.
  assert.equal(publishView(state({ slug: "g", status: "draft", readyDraft: ready, job: job() })).testLink, null);
});

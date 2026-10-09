import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isGenexPublish,
  offeredTitle,
  PublishGate,
  publishGate,
  publishSteps,
  publishView,
  stripEntries,
  studioPublishButton,
} from "../../src/renderer/panels/plugins/genex/genex-publish-view.ts";
import {
  GENEX_PLUGIN_ID,
  GENEX_PUBLISH_PANEL,
  type GenexPublishJob,
  type GenexPublishState,
} from "../../src/shared/genex.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
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
  assert.equal(none.primary.label, "Publish");
  assert.equal(none.primary.ariaLabel, "Publish this game on Genex", "the smoke selector stays");
  assert.equal(none.canPublish, true);
  assert.ok(!("secondary" in none), "a draft is no second button beside Publish");

  const draft = publishView(state({ slug: "my-game", status: "draft", draftUrl: "https://x/draft" }));
  assert.equal(draft.stage, "draft");
  assert.equal(draft.primary.label, "Publish");

  const live = publishView(state({ slug: "my-game", status: "published", galleryUrl: "https://x/g" }));
  assert.equal(live.stage, "public");
  assert.equal(live.primary.label, "Publish update");

  const signedOut = publishView(state({ connected: false }));
  assert.equal(signedOut.canPublish, false);
  assert.deepEqual(signedOut.problems, [], "Connect Genex is offered in its place, not reported as a problem");
});

test("Publish asks for what is missing in order: Genex installed, turned on, then an account", () => {
  assert.equal(publishGate(undefined, undefined), PublishGate.Install);
  assert.equal(publishGate({ enabled: false, removed: true }, undefined), PublishGate.Install);
  assert.equal(publishGate({ enabled: false, removed: false }, undefined), PublishGate.TurnOn);
  assert.equal(publishGate({ enabled: true, removed: false }, false), PublishGate.Connect);
  assert.equal(publishGate({ enabled: true, removed: false }, true), PublishGate.Ready);
  assert.equal(
    publishGate({ enabled: true, removed: false }, undefined),
    PublishGate.Ready,
    "unread yet is not asked for",
  );
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
  assert.equal(studioPublishButton([genex()], "game", web), false, "Genex's own button is the one shown");
  assert.equal(studioPublishButton([genex({ enabled: false, state: "disabled" })], "game", web), true);
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
  assert.deepEqual(strip([other()], [{ id: CoreFact.WebGame, path: "." }]), {
    genex: false,
    studio: true,
    others: ["demo:demo"],
  });
});

test("Publish sits on the strip only while the game is served as a web game at its root", () => {
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
    ["a web game only below the root", [{ id: CoreFact.WebGame, path: "site" }], undefined, false],
    ["a linked Unreal project", [{ id: CoreFact.UnrealProject, path: "unreal" }], undefined, false],
  ];
  for (const [name, facts, holds, shown] of rows)
    assert.deepEqual(
      strip(facts, holds),
      { genex: shown, studio: shown },
      `${name}: Publish ${shown ? "shown" : "hidden"}`,
    );
});

test("a running attempt shows its steps: every publish tests the draft before it goes live", () => {
  assert.deepEqual(publishSteps(job({ phase: "creating-project" })), ["prepare", "upload", "test", "live"]);
  assert.deepEqual(publishSteps(job({ kind: "draft", phase: "uploading" })), ["prepare", "upload", "test"]);

  const testing = publishView(state({ slug: "g", job: job({ phase: "verifying-deployment" }) }));
  assert.equal(testing.running, true);
  assert.equal(testing.canPublish, false, "nothing else starts while one runs");
  assert.equal(testing.phase, "Making sure it plays");
  assert.equal(testing.status, "Publishing…");
  assert.deepEqual(
    testing.steps.map((s) => [s.step, s.state]),
    [
      ["prepare", "done"],
      ["upload", "done"],
      ["test", "current"],
      ["live", "next"],
    ],
  );
  const promoting = publishView(state({ slug: "g", status: "published", job: job({ phase: "promoting" }) }));
  assert.equal(promoting.phase, "Going live");
  assert.equal(promoting.steps.at(-1)?.state, "current");
});

test("a live game shows its link and when it was updated", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const live = publishView(
    state({
      slug: "g",
      status: "published",
      galleryUrl: "https://genex.games/world/g",
      lastPublishAt: "2026-10-06T11:58:00Z",
      job: job({ state: "done", phase: "ready" }),
    }),
    now,
  );
  assert.equal(live.link, "https://genex.games/world/g");
  assert.equal(live.status, "Live · updated 2m ago");
  assert.equal(live.failure, null);
  assert.equal(
    publishView(state({ slug: "g", galleryUrl: "https://genex.games/world/g" })).link,
    null,
    "a draft has no public link",
  );
});

test("a failed attempt is said calmly, its raw error kept only as details for support", () => {
  const failed = publishView(
    state({ job: job({ state: "failed", phase: "failed", error: "fixture: HTTP 502 at /api" }) }),
  );
  assert.equal(failed.outcome, "failed");
  assert.deepEqual(failed.problems, [], "the raw error is no problem line");
  assert.equal(failed.failure?.title, "It didn't go online this time");
  assert.match(failed.failure?.text ?? "", /Your game is safe and nothing changed/);
  assert.equal(failed.failure?.details, "fixture: HTTP 502 at /api");
  assert.equal(failed.primary.label, "Try again");
  assert.equal(failed.canPublish, true, "a failed attempt can be tried again");

  const listedFailed = publishView(
    state({ slug: "g", status: "published", job: job({ state: "failed", phase: "failed", error: "x" }) }),
  );
  assert.match(listedFailed.failure?.text ?? "", /players still get the version they had/);
});

test("an upload whose outcome is unknown offers Check again and the person's own word, never a silent retry", () => {
  const unknown = publishView(
    state({ slug: "g", job: job({ state: "unresolved", phase: "unresolved", kind: "draft", error: "lost" }) }),
  );
  assert.equal(unknown.running, false);
  assert.equal(unknown.unresolved, true);
  assert.equal(unknown.outcome, "unresolved");
  assert.deepEqual(
    unknown.extra.map((b) => [b.label, b.action]),
    [
      ["Check again", "publish-status"],
      ["I checked — allow a new upload", "publish-allow-upload"],
    ],
  );
  assert.equal(unknown.canPublish, false);
  assert.match(unknown.failure?.text ?? "", /couldn’t tell whether the upload reached Genex/);

  const terms = publishView(state({ terms: { accepted: false, acceptUrl: "https://x/terms" } }));
  assert.deepEqual(terms.problems, ["Review the updated Genex terms in your browser before publishing."]);
  assert.equal(terms.terms?.action, "terms", "the one press is reviewing them");
  assert.equal(publishView(state()).terms, null);
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

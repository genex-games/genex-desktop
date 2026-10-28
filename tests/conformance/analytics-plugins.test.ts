/**
 * Usage analytics for plugins, connectors, the Harness room and Play: what each mapper makes of a
 * record, a UI event or a store's change, durations from the clocks it is given, and a hostile
 * table proving no name, path, link, id or words of the person's ever reach a property.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { PostHog } from "posthog-js";
import { createStore } from "zustand/vanilla";
import type { ConnectionSnapshot } from "../../src/shared/connections.ts";
import { UserCancelledError } from "../../src/shared/errors.ts";
import type { McpConnectorView } from "../../src/shared/mcp.ts";
import { PlayCategory, PlayRemixRefusal, PlayShelf, PlayViewerPhase, RemixStep } from "../../src/shared/play.ts";
import {
  InstallFailure,
  InstallPhase,
  type InstallProgress,
  type NativeInstalls,
  NativeSessionPhase,
} from "../../src/shared/play-native.ts";
import {
  GithubLookupKind,
  GithubLookupProblem,
  type PluginIndexView,
  type PluginInfo,
  PluginSourceKind,
  PluginTier,
} from "../../src/shared/plugins.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { startAnalytics, track } from "../../src/renderer/analytics/client.ts";
import { AnalyticsEvent } from "../../src/renderer/analytics/events.ts";
import { createPluginsObservers } from "../../src/renderer/analytics/events/plugins.ts";
import {
  activityLoadedProperties,
  AgeBucket,
  ageBucket,
  changeUndoneProperties,
  HarnessOpenedVia,
  ImprovementResult,
  improvementCheckProperties,
  noteHarnessOpening,
  SuggestionDecision,
  suggestionsDecidedProperties,
  takeHarnessOpening,
} from "../../src/renderer/analytics/plugins-harness.ts";
import {
  accountChanges,
  ActionOutcome,
  actionOutcome,
  addedPlugin,
  connectorFormClosedProperties,
  connectorFormOpened,
  ConnectorFormMode,
  ConnectorFormOutcome,
  connectorHealthChanges,
  connectorPasted,
  connectorSaveFailed,
  connectorTestedProperties,
  githubLookupProperties,
  InstallOutcome,
  installFinishedProperties,
  installStartedProperties,
  notePluginsOpening,
  PluginAction,
  PluginInstallOrigin,
  PluginInstallSurface,
  pluginDetailProperties,
  pluginsPageLeftProperties,
  pluginsPageOpenedProperties,
  PluginsOpenedFrom,
  PluginsPageView,
  pluginsSearchedProperties,
  PluginSurface,
  setupCompletions,
  takePluginsOpening,
  trackedPluginAction,
  trackedPluginInstall,
  UpdatesRunSurface,
  updatesRunProperties,
} from "../../src/renderer/analytics/plugins-page.ts";
import {
  feedFailures,
  installsStep,
  NO_INSTALLS_WATCH,
  playSearchedProperties,
  PlayTimeBucket,
  playTimeBucket,
  RemixOutcome,
  type RemixState,
  remixStep,
  sessionsEnded,
  ViewerOutcome,
  viewerStep,
} from "../../src/renderer/analytics/plugins-play.ts";
import {
  ConsentCardSource,
  consentCardShownProperties,
  indexLoadedProperties,
  pluginFailedProperties,
  sameIndexRead,
  suggestionShownProperties,
} from "../../src/renderer/analytics/plugins-records.ts";
import { isOwnPlugin, PluginRefBucket, pluginRef } from "../../src/renderer/analytics/plugins-ref.ts";
import { CharsBucket, CountBucket } from "../../src/renderer/analytics/properties.ts";
import { FeedStatus, type FeedState } from "../../src/renderer/play/play-model.ts";
import { RemixView } from "../../src/renderer/state/play.ts";
import type { Studio } from "../../src/renderer/state/studio.ts";

/** What the person owns or wrote: none of it may appear in any property. */
const SECRETS = [
  "/Users/alice/Games/My Secret Game",
  "C:\\Users\\bob\\plugins",
  "file:///Users/alice/x.js",
  "https://github.com/alice/private-plugin",
  "Alice's Dungeon",
  "alice@example.com",
  "conn-alice-db",
  "thread-123",
];

function plugin(id: string, source: PluginInfo["source"], extra: Partial<PluginInfo> = {}): PluginInfo {
  return {
    manifest: {
      id,
      name: `${id} name ${SECRETS[4]}`,
      description: SECRETS[1],
      version: "1.0.0",
      publisher: SECRETS[5],
      settings: [],
      account: undefined,
      skills: [],
      panels: [],
      actions: [],
    } as unknown as PluginInfo["manifest"],
    source,
    enabled: true,
    removed: false,
    health: "ready",
    state: "enabled",
    ...extra,
  };
}

/** No secret string in anything sent. */
function assertClean(value: unknown, what: string): void {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!text.includes(JSON.stringify(secret).slice(1, -1)), `${what}: ${secret}`);
  assert.doesNotMatch(text, /alice|bob|Users|file:|https?:/i, what);
}

describe("plugin references", () => {
  it("names catalog plugins by id and the person's own only by where they came from", () => {
    assert.equal(pluginRef("genex", PluginSourceKind.Bundled), "genex");
    assert.equal(pluginRef("unity", null), "unity");
    assert.equal(pluginRef("my-tool", PluginSourceKind.Local), PluginRefBucket.Local);
    assert.equal(pluginRef("my-tool", PluginSourceKind.Github), PluginRefBucket.Github);
    // Paths, links, names and addresses are never shaped like a catalog's id.
    for (const hostile of [...SECRETS.slice(0, 6), "", "a".repeat(80), "id with spaces", "../etc"])
      assert.equal(pluginRef(hostile, PluginSourceKind.Index), PluginRefBucket.Other, hostile);
    assert.equal(isOwnPlugin({ source: PluginSourceKind.Local }), true);
    assert.equal(isOwnPlugin({ source: PluginSourceKind.Catalog }), false);
  });
});

describe("plugin records and UI events", () => {
  const list = [plugin("roblox", PluginSourceKind.Bundled, { enabled: false }), plugin("mine", PluginSourceKind.Local)];

  it("maps a suggestion by the live list, and ignores one that names no plugin", () => {
    assert.deepEqual(suggestionShownProperties({ pluginId: "roblox", offer: "turn-on", reason: SECRETS[4] }, list), {
      plugin_ref: "roblox",
      offer: "turn-on",
      state: "turn-on",
    });
    assert.deepEqual(suggestionShownProperties({ pluginId: "mine", offer: "bogus" as never }, list), {
      plugin_ref: PluginRefBucket.Local,
      offer: null,
      state: "on",
    });
    assert.equal(suggestionShownProperties({ name: SECRETS[4] }, list), null);
  });

  it("maps a consent card asked, never a connector's id, and nothing once it settled", () => {
    const pending = {
      state: "pending" as const,
      pluginId: "roblox",
      exportReview: { included: [SECRETS[0], SECRETS[1]], excluded: [SECRETS[2]] },
      input: { label: SECRETS[4], value: SECRETS[5] },
      prompt: SECRETS[4],
      args: { path: SECRETS[0] },
    };
    assert.deepEqual(consentCardShownProperties(pending, list), {
      source: ConsentCardSource.Plugin,
      plugin_ref: "roblox",
      always_offered: false,
      chat_offered: false,
      has_input: true,
      has_export_review: true,
      files_bucket: CountBucket.Few,
    });
    const connector = consentCardShownProperties({ ...pending, pluginId: SECRETS[6], alwaysOffered: true }, list);
    assert.equal(connector?.source, ConsentCardSource.Connector);
    assert.equal(connector?.plugin_ref, null);
    assert.equal(
      consentCardShownProperties({ ...pending, pluginId: "studio-desktop" }, list)?.source,
      "studio-desktop",
    );
    assert.equal(consentCardShownProperties({ ...pending, state: "approved" }, list), null);
    assertClean([connector, consentCardShownProperties(pending, list)], "consent card");
  });

  it("maps a plugin failing with how it failed, and no other change", () => {
    assert.deepEqual(pluginFailedProperties({ id: "mine", reason: "failed" }, list), {
      plugin_ref: "local",
      failure: null,
    });
    assert.deepEqual(
      pluginFailedProperties({ id: "roblox", reason: "failed", failure: "plugin_reload_refused" }, list),
      {
        plugin_ref: "roblox",
        failure: "plugin_reload_refused",
      },
    );
    assert.equal(pluginFailedProperties({ id: "mine", reason: "enabled" }, list), null);
  });

  it("reads the index without its error words, and sends a read only when it says something new", () => {
    const index = {
      url: SECRETS[3],
      studioVersion: "1",
      fetchedAt: 1,
      stale: true,
      error: `offline at ${SECRETS[0]}`,
      entries: [
        { id: "a", tier: PluginTier.Community },
        { id: "b", tier: PluginTier.Official },
      ],
      updates: [],
    } as unknown as PluginIndexView;
    const read = indexLoadedProperties(index);
    assert.deepEqual(read, { stale: true, failed: true, community_entries: 1, community_view: "list" });
    assert.ok(sameIndexRead(read, { ...read }));
    assert.ok(!sameIndexRead(null, read));
    assertClean(read, "index");
  });
});

describe("the Plugins page", () => {
  it("is reached from where the last note said, once, else from the sidebar", () => {
    assert.equal(takePluginsOpening(), PluginsOpenedFrom.Sidebar);
    notePluginsOpening(PluginsOpenedFrom.ToolbarUpdate);
    assert.equal(takePluginsOpening(), PluginsOpenedFrom.ToolbarUpdate);
    assert.equal(takePluginsOpening(), PluginsOpenedFrom.Sidebar, "a note is spent once");
  });

  it("counts what the page opens on, and names the plugin it was asked for only by its reference", () => {
    const plugins = [
      plugin("genex", PluginSourceKind.Bundled),
      plugin("mine", PluginSourceKind.Local, { health: "failed" }),
      plugin("gone", PluginSourceKind.Catalog, { removed: true }),
      plugin("off", PluginSourceKind.Index, { enabled: false }),
    ];
    const opened = pluginsPageOpenedProperties({
      from: PluginsOpenedFrom.SetupRequest,
      setupPlugin: "mine",
      plugins,
      updates: 2,
    });
    assert.deepEqual(opened, {
      source: "setup_request",
      setup_plugin_ref: "local",
      installed: 3,
      enabled: 2,
      failed: 1,
      updates: 2,
    });
    assertClean(opened, "page opened");
  });

  it("sends how long a search was and how many matched, never its words", () => {
    const searched = pluginsSearchedProperties("plugins", `  ${SECRETS[4]}  `, 0);
    assert.deepEqual(searched, {
      tab: "plugins",
      query_chars_bucket: CharsBucket.Short,
      result_count: 0,
      zero_results: true,
    });
    assertClean(searched, "search");
  });

  it("describes an opened plugin by its source and state, a listing by its tier", () => {
    const mine = plugin("mine", PluginSourceKind.Github, {
      manifest: { ...plugin("mine", PluginSourceKind.Github).manifest, account: { connect: "c" } as never },
    });
    const detail = pluginDetailProperties({
      id: "mine",
      plugin: mine,
      listing: undefined,
      account: "not connected",
      hasUpdate: true,
    });
    assert.deepEqual(detail, {
      plugin_ref: "github",
      source_kind: "github",
      tier: null,
      enabled: true,
      health: "ready",
      account_step: "connect",
      needs_setup: true,
      has_update: true,
    });
    const listing = pluginDetailProperties({
      id: "unity",
      plugin: undefined,
      listing: { tier: PluginTier.Official },
      account: undefined,
      hasUpdate: false,
    });
    assert.equal(listing.plugin_ref, "unity");
    assert.equal(listing.source_kind, null);
    assert.equal(listing.tier, "official");
    assertClean(detail, "detail");
  });

  it("measures a visit from the clock it is given", () => {
    const left = pluginsPageLeftProperties({
      openedAt: 1_000,
      now: 4_500,
      actions: 3,
      error: true,
      view: PluginsPageView.Detail,
    });
    assert.deepEqual(left, { dwell_ms: 3_500, actions_count: 3, error_visible: true, last_view: "detail" });
  });
});

describe("installs and actions", () => {
  it("names an install by origin and plugin reference, and its outcome from the list afterwards", () => {
    const github = {
      origin: PluginInstallOrigin.Github,
      surface: PluginInstallSurface.GithubDialog,
      id: "x",
      source: null,
    };
    assert.deepEqual(installStartedProperties(github), {
      plugin_ref: "github",
      origin: "github",
      surface: "github_dialog",
    });
    const local = {
      origin: PluginInstallOrigin.Local,
      surface: PluginInstallSurface.MenuLoadLocal,
      id: null,
      source: null,
    };
    assert.equal(installStartedProperties(local).plugin_ref, "local");
    const catalog = {
      origin: PluginInstallOrigin.Index,
      surface: PluginInstallSurface.BrowseRow,
      id: "unity",
      source: null,
    };
    const installed = plugin("unity", PluginSourceKind.Index, {
      scan: { verdict: "caution", findings: [], files: 1, bytes: 1, scannedAt: "" },
    });
    assert.deepEqual(installFinishedProperties(catalog, installed, false, 1234.4), {
      plugin_ref: "unity",
      origin: "index",
      surface: "browse_row",
      outcome: InstallOutcome.Installed,
      scan_verdict: "caution",
      duration_ms: 1234,
    });
    assert.equal(installFinishedProperties(catalog, null, false, 5).outcome, InstallOutcome.NotInstalled);
    assert.equal(installFinishedProperties(catalog, null, true, 5).outcome, InstallOutcome.Failed);
  });

  it("finds what a nameless install added", () => {
    const before = [plugin("a", PluginSourceKind.Bundled)];
    const after = [...before, plugin("b", PluginSourceKind.Local)];
    assert.equal(addedPlugin(before, after)?.manifest.id, "b");
    assert.equal(addedPlugin(after, after), null);
  });

  it("reads the lookup's typed answer and never its link", () => {
    const found = { repo: "alice/x", sha: "0", spec: SECRETS[3], version: {}, plugin: {} };
    const plugin1 = githubLookupProperties({ kind: GithubLookupKind.Plugin, ...found } as never, false, 10);
    assert.deepEqual(plugin1, {
      version_picked: false,
      duration_ms: 10,
      result: "plugin",
      problem: null,
      plugins_found: 1,
    });
    const choose = { kind: GithubLookupKind.Choose, repo: "alice/x", version: {}, plugins: [found, found] } as never;
    assert.equal(githubLookupProperties(choose, true, 1).plugins_found, 2);
    const problem = { kind: GithubLookupKind.Problem, problem: GithubLookupProblem.RateLimited, detail: SECRETS[0] };
    assert.equal(githubLookupProperties(problem, false, 1).problem, "rate-limited");
    assert.equal(githubLookupProperties(null, false, 1).result, "failed");
    assertClean([plugin1, githubLookupProperties(problem, false, 1)], "lookup");
  });

  it("reads the person's no as cancelled, anything else as a failure", () => {
    assert.equal(actionOutcome(null, false), ActionOutcome.Ok);
    assert.equal(actionOutcome(new UserCancelledError(), true), ActionOutcome.Cancelled);
    assert.equal(actionOutcome(new Error(SECRETS[0]), true), ActionOutcome.Failed);
  });
});

describe("accounts and setups", () => {
  const snapshot = (account: string, kind = "plugin"): ConnectionSnapshot =>
    ({
      revision: 1,
      appliedRevision: null,
      active: true,
      sources: [
        { id: "mine", name: SECRETS[4], kind, enabled: true, health: "ready", tools: 1, account, reason: SECRETS[0] },
      ],
    }) as ConnectionSnapshot;
  const plugins = [plugin("mine", PluginSourceKind.Local)];

  it("sends an account's move with its time in the state it left; a first sight is not a move", () => {
    const first = accountChanges(new Map(), snapshot("not connected"), plugins, 1_000);
    assert.deepEqual(first.changes, []);
    const moved = accountChanges(first.watch, snapshot("authorizing"), plugins, 61_000);
    assert.deepEqual(moved.changes, [
      { plugin_ref: "local", from: "not connected", to: "authorizing", ms_in_previous: 60_000 },
    ]);
    assert.deepEqual(accountChanges(moved.watch, snapshot("authorizing"), plugins, 70_000).changes, []);
    assert.deepEqual(accountChanges(new Map(), snapshot("locked", "mcp"), plugins, 0).watch.size, 0);
    assertClean(moved, "account");
  });

  it("completes a setup once an account waiting on the person connects", () => {
    const withAccount = plugin("mine", PluginSourceKind.Local, {
      manifest: { ...plugins[0].manifest, account: { connect: "c" } as never },
    });
    const waiting = setupCompletions(new Set(), [withAccount], () => "not connected", 0);
    assert.deepEqual([...waiting.waiting], ["mine"]);
    assert.deepEqual(waiting.completed, []);
    const done = setupCompletions(waiting.waiting, [withAccount], () => "unlocked", 5_000);
    assert.deepEqual(done.completed, [
      { plugin_ref: "local", ms_from_enable: null, had_account: true, had_setting: false },
    ]);
    assert.equal(done.waiting.size, 0);
    assert.deepEqual(setupCompletions(new Set(), [withAccount], () => "unlocked", 0).completed, [], "never waited");
  });

  it("measures an Update plugins run", () => {
    const run = updatesRunProperties({
      surface: UpdatesRunSurface.SidebarMenu,
      chosen: 3,
      skipped: 1,
      notUpdated: 1,
      failed: 1,
      declined: 0,
      startedAt: 100,
      now: 2_100,
    });
    assert.deepEqual(run, {
      surface: "sidebar_menu",
      chosen: 3,
      skipped: 1,
      not_updated: 1,
      failed: 1,
      declined: 0,
      duration_ms: 2_000,
    });
  });
});

describe("connectors", () => {
  it("closes a form with what was pasted and what the saves met", () => {
    let visit = connectorFormOpened(ConnectorFormMode.Add);
    visit = connectorPasted(visit, 2, 1);
    visit = connectorSaveFailed(visit, new UserCancelledError());
    visit = connectorSaveFailed(visit, new Error(SECRETS[0]));
    const closed = connectorFormClosedProperties(visit, {
      outcome: ConnectorFormOutcome.Abandoned,
      transport: "stdio",
      problemShown: true,
    });
    assert.deepEqual(closed, {
      mode: "add",
      outcome: "abandoned",
      transport: "stdio",
      had_paste: true,
      paste_drafts: 2,
      paste_warnings: 1,
      save_failures: 2,
      trust_declined: true,
      problem_shown: true,
    });
  });

  it("sends a test's tools as a bucket and its own time, or the call's when it failed", () => {
    const ok = connectorTestedProperties("http", { ok: true, tools: [{}, {}, {}] as never, durationMs: 42 }, 99);
    assert.deepEqual(ok, { transport: "http", ok: true, tools_bucket: CountBucket.Few, duration_ms: 42 });
    assert.deepEqual(connectorTestedProperties("sse", null, 12.6), {
      transport: "sse",
      ok: false,
      tools_bucket: CountBucket.None,
      duration_ms: 13,
    });
  });

  it("pairs connectors by id in memory and sends only transport, source and health", () => {
    const view = (health: McpConnectorView["health"], source?: unknown): McpConnectorView =>
      ({
        connector: { id: SECRETS[6], name: SECRETS[4], transport: "stdio", command: SECRETS[0], source },
        health,
        error: SECRETS[0],
      }) as McpConnectorView;
    const changes = connectorHealthChanges([view("connecting")], [view("failed", { plugin: "p", server: "s" })]);
    assert.deepEqual(changes, [{ transport: "stdio", source: "plugin", from: "connecting", to: "failed", auth: null }]);
    assert.deepEqual(connectorHealthChanges([view("ready")], [view("ready")]), []);
    assert.deepEqual(connectorHealthChanges([], [view("ready")]), [], "a first sight is not a move");
    assertClean(changes, "connector health");
  });
});

describe("the Harness room", () => {
  const NOW = Date.parse("2026-10-27T12:00:00Z");

  it("is reached the way the last note said, once", () => {
    assert.equal(takeHarnessOpening(), HarnessOpenedVia.Other);
    noteHarnessOpening(HarnessOpenedVia.LearningLine);
    assert.equal(takeHarnessOpening(), HarnessOpenedVia.LearningLine);
    assert.equal(takeHarnessOpening(), HarnessOpenedVia.Other);
  });

  it("buckets ages, an unreadable time as new", () => {
    assert.equal(ageBucket("2026-10-27T11:30:00Z", NOW), AgeBucket.UnderHour);
    assert.equal(ageBucket("2026-10-26T13:00:00Z", NOW), AgeBucket.Day);
    assert.equal(ageBucket("2026-10-22T12:00:00Z", NOW), AgeBucket.Week);
    assert.equal(ageBucket("2026-09-01T12:00:00Z", NOW), AgeBucket.Older);
    assert.equal(ageBucket(SECRETS[0], NOW), AgeBucket.UnderHour);
    assert.equal(ageBucket(undefined, NOW), AgeBucket.UnderHour);
  });

  it("decides suggestions by counts and the oldest's age", () => {
    const decided = suggestionsDecidedProperties({
      decision: SuggestionDecision.Apply,
      chosen: [{ at: "2026-10-27T11:00:00Z" }, { at: "2026-10-20T11:00:00Z" }, {}],
      waiting: 5,
      openedDetails: true,
      ok: false,
      now: NOW,
    });
    assert.deepEqual(decided, {
      decision: "apply",
      count: 3,
      excluded: 2,
      opened_details: true,
      outcome: "failed",
      oldest_age_bucket: AgeBucket.Older,
    });
    assert.deepEqual(changeUndoneProperties("2026-10-27T11:59:00Z", true, NOW), {
      age_bucket: AgeBucket.UnderHour,
      outcome: "ok",
    });
  });

  it("reads Look for improvements' result from the counts around it", () => {
    const before = { staged: 1, learned: 4 };
    const check = (after: typeof before | null) =>
      improvementCheckProperties({ before, after, startedAt: 1_000, now: 9_000 });
    assert.deepEqual(check({ staged: 3, learned: 4 }), {
      result: ImprovementResult.Found,
      found: 2,
      applied: 0,
      duration_ms: 8_000,
    });
    assert.equal(check({ staged: 1, learned: 5 }).result, ImprovementResult.Added);
    assert.equal(check(before).result, ImprovementResult.None);
    assert.equal(check(null).result, ImprovementResult.Failed);
  });

  it("measures a feed load, and counts nothing for a failed one", () => {
    assert.deepEqual(
      activityLoadedProperties({ tally: { runs: 7, staged: 2, learned: 1 }, startedAt: 0, now: 250, attempt: 1 }),
      {
        outcome: "ok",
        load_ms: 250,
        attempt: 1,
        runs_bucket: CountBucket.Several,
        staged: 2,
        learned: 1,
      },
    );
    assert.equal(activityLoadedProperties({ tally: null, startedAt: 0, now: 1, attempt: 2 }).outcome, "failed");
  });
});

describe("Play", () => {
  it("buckets play time and searches without their words", () => {
    assert.equal(playTimeBucket(30_000), PlayTimeBucket.UnderMinute);
    assert.equal(playTimeBucket(5 * 60_000), PlayTimeBucket.Minutes);
    assert.equal(playTimeBucket(30 * 60_000), PlayTimeBucket.Quarter);
    assert.equal(playTimeBucket(3 * 3_600_000), PlayTimeBucket.Hours);
    const searched = playSearchedProperties(PlayShelf.Games, SECRETS[4], 7);
    assert.deepEqual(searched, {
      shelf: "games",
      query_chars_bucket: CharsBucket.Short,
      results_bucket: CountBucket.Several,
      failed: false,
    });
    assert.equal(playSearchedProperties(PlayShelf.Tools, "x", null).failed, true);
    assertClean(searched, "play search");
  });

  it("names the tabs whose first or further page failed", () => {
    const feed = (status: FeedState["status"], moreFailed = false): FeedState => ({
      games: [],
      nextCursor: null,
      status,
      loadingMore: false,
      moreFailed,
      at: 0,
    });
    const failures = feedFailures(
      { [PlayCategory.Featured]: feed(FeedStatus.Loading), [PlayCategory.Arcade]: feed(FeedStatus.Ready) },
      { [PlayCategory.Featured]: feed(FeedStatus.Failed), [PlayCategory.Arcade]: feed(FeedStatus.Ready, true) },
      false,
    );
    assert.deepEqual(failures, [
      { category: "featured", more: false, online: false },
      { category: "arcade", more: true, online: false },
    ]);
  });

  it("follows a viewer from its opening to playing, a retry, and a close while loading", () => {
    const shown = (phase: PlayViewerPhase, slug = "alices-secret-game") => ({
      slug,
      title: SECRETS[4],
      coverUrl: SECRETS[3],
      phase,
      openId: 1,
    });
    const opened = viewerStep(null, shown(PlayViewerPhase.Loading), 1_000, true);
    assert.equal(opened.opened, true);
    const failed = viewerStep(opened.watch, shown(PlayViewerPhase.Failed), 3_000, true);
    assert.deepEqual(failed.settled, { outcome: ViewerOutcome.Failed, load_ms: 2_000, retries: 0, online: true });
    const retry = viewerStep(failed.watch, shown(PlayViewerPhase.Loading), 4_000, true);
    const playing = viewerStep(retry.watch, shown(PlayViewerPhase.Playing), 4_500, true);
    assert.deepEqual(playing.settled, { outcome: ViewerOutcome.Playing, load_ms: 500, retries: 1, online: true });
    assert.equal(viewerStep(playing.watch, shown(PlayViewerPhase.Playing), 9_000, true).settled, null, "once");
    const another = viewerStep(playing.watch, shown(PlayViewerPhase.Loading, "other"), 10_000, true);
    const closed = viewerStep(another.watch, null, 10_400, true);
    assert.deepEqual(closed.settled, {
      outcome: ViewerOutcome.ClosedWhileLoading,
      load_ms: 400,
      retries: 0,
      online: true,
    });
    // The watch pairs the game in memory; only the settled properties leave.
    assertClean([opened.opened, failed.settled, playing.settled, closed.settled], "viewer");
  });

  it("follows a remix's steps to its end, with its slowest step and whether it was set aside", () => {
    const making = (step: RemixStep, view: RemixView = RemixView.Shown) => ({
      slug: "s",
      title: SECRETS[4],
      coverUrl: null,
      step,
      done: null,
      total: null,
      name: SECRETS[4],
      view,
    });
    const state = (m: ReturnType<typeof making> | null, failed = false): RemixState => ({
      making: m,
      remixFailed: failed,
      remixRefusal: failed ? PlayRemixRefusal.NoProject : null,
    });
    let watch = remixStep(null, state(making(RemixStep.Copy)), 0).watch;
    watch = remixStep(watch, state(making(RemixStep.Models, RemixView.Aside)), 1_000).watch;
    watch = remixStep(watch, state(making(RemixStep.Build)), 9_000).watch;
    watch = remixStep(watch, state(making(RemixStep.Build, RemixView.Opening)), 10_000).watch;
    const end = remixStep(watch, state(null), 12_000);
    assert.deepEqual(end.finished, {
      outcome: RemixOutcome.Opened,
      refusal: null,
      last_step: "build",
      total_ms: 12_000,
      set_aside: true,
      slowest_step: "models",
    });
    const failing = remixStep(
      remixStep(null, state(making(RemixStep.Copy)), 0).watch,
      state(making(RemixStep.Copy), true),
      5,
    );
    const failed = remixStep(failing.watch, state(null), 10);
    assert.equal(failed.finished?.outcome, RemixOutcome.Failed);
    assert.equal(failed.finished?.refusal, "no-project");
    assertClean(end, "remix");
  });

  it("ends native installs with their typed failure, and knows a retry", () => {
    const progress = (phase: InstallPhase, failure: InstallProgress["failure"] = null): InstallProgress => ({
      slug: "alices-secret-game",
      version: "1",
      phase,
      receivedBytes: 0,
      totalBytes: 1,
      etaMs: null,
      failure,
    });
    const installs = (list: InstallProgress[], installed: string[] = []): NativeInstalls =>
      ({
        installed: installed.map((slug) => ({ slug })),
        progress: list,
        host: { platform: "mac", arch: "arm64", osVersion: "15" },
      }) as NativeInstalls;
    const begun = installsStep(NO_INSTALLS_WATCH, installs([]), installs([progress(InstallPhase.Downloading)]), 1_000);
    assert.deepEqual(begun.finished, []);
    const failed = installsStep(
      begun.watch,
      installs([progress(InstallPhase.Downloading)]),
      installs([progress(InstallPhase.Failed, InstallFailure.NoSpace)]),
      6_000,
    );
    assert.deepEqual(failed.finished, [
      { phase: "failed", failure: "no-space", install_ms: 5_000, retry: false, platform: "mac" },
    ]);
    const again = installsStep(
      failed.watch,
      installs([progress(InstallPhase.Failed)]),
      installs([progress(InstallPhase.Downloading)]),
      7_000,
    );
    const ready = installsStep(
      again.watch,
      installs([progress(InstallPhase.Unpacking)]),
      installs([], ["alices-secret-game"]),
      9_000,
    );
    assert.deepEqual(ready.finished, [
      { phase: "ready", failure: null, install_ms: 2_000, retry: true, platform: "mac" },
    ]);
    assertClean([failed.finished, ready.finished], "installs");
  });

  it("ends native sessions that left the list or failed to start", () => {
    const session = (phase: NativeSessionPhase, failure = null) => ({
      slug: "alices-secret-game",
      phase,
      startedAt: "2026-10-27T12:00:00Z",
      failure,
    });
    const now = Date.parse("2026-10-27T12:20:00Z");
    assert.deepEqual(sessionsEnded([session(NativeSessionPhase.Running)], [], now), [
      { phase: "running", failure: null, play_ms_bucket: PlayTimeBucket.Quarter },
    ]);
    const failedToStart = sessionsEnded(
      [],
      [{ ...session(NativeSessionPhase.Failed), failure: "quit-early" as never }],
      now,
    );
    assert.equal(failedToStart[0]?.failure, "quit-early");
    assert.deepEqual(sessionsEnded([session(NativeSessionPhase.Failed)], [], now), [], "a failure is sent once");
  });
});

describe("what leaves", () => {
  /** What a recorder in place of PostHog's captured: one for the file, as the client keeps its first. */
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const posthog = {
    init: () => undefined,
    has_opted_out_capturing: () => false,
    opt_in_capturing: () => undefined,
    register: () => undefined,
    stopSessionRecording: () => undefined,
    capture: (event: string, properties: Record<string, unknown>) => captured.push({ event, properties }),
  } as unknown as PostHog;
  /** The recorder, started once and emptied for each test. */
  async function recorder(): Promise<typeof captured> {
    await startAnalytics({ key: "phc_test", host: "https://eu.i.posthog.com" }, { replay: false }, async () => ({
      posthog,
    }));
    captured.length = 0;
    return captured;
  }

  it("reports an action's outcome and duration from the clock, and hands its result and failure back", async () => {
    const sent = await recorder();
    let now = 100;
    const clock = () => now;
    const press = {
      action: PluginAction.Enable,
      plugin: plugin("mine", PluginSourceKind.Local),
      surface: PluginSurface.PluginsPage,
    };
    const result = await trackedPluginAction(
      press,
      async () => {
        now = 350;
        return 7;
      },
      clock,
    );
    assert.equal(result, 7);
    await assert.rejects(trackedPluginAction(press, async () => Promise.reject(new UserCancelledError()), clock));
    assert.deepEqual(
      sent.map((s) => s.properties),
      [
        { action: "enable", plugin_ref: "local", surface: "plugins_page", outcome: "ok", duration_ms: 250 },
        { action: "enable", plugin_ref: "local", surface: "plugins_page", outcome: "cancelled", duration_ms: 0 },
      ],
    );
    assert.ok(sent.every((s) => s.event === AnalyticsEvent.PluginActionFinished));
  });

  it("reports an install's start and its outcome, reading the list without holding the install up", async () => {
    const sent = await recorder();
    const press = {
      origin: PluginInstallOrigin.Index,
      surface: PluginInstallSurface.ListingPage,
      id: "unity",
      source: null,
    };
    const installed = plugin("unity", PluginSourceKind.Index);
    let listed: (plugin: PluginInfo | null) => void = () => undefined;
    const list = new Promise<PluginInfo | null>((resolve) => {
      listed = resolve;
    });
    const found: Array<PluginInfo | null> = [];
    await trackedPluginInstall(
      press,
      async () => undefined,
      () => list,
      () => 5,
      (plugin) => found.push(plugin),
    );
    // The install resolved while the list read is still out: only its start was sent so far.
    assert.deepEqual(
      sent.map((s) => s.event),
      [AnalyticsEvent.PluginInstallStarted],
    );
    listed(installed);
    await setImmediate();
    assert.deepEqual(found, [installed]);
    assert.deepEqual(
      sent.map((s) => [s.event, s.properties.outcome]),
      [
        [AnalyticsEvent.PluginInstallStarted, undefined],
        [AnalyticsEvent.PluginInstallFinished, InstallOutcome.Installed],
      ],
    );
  });

  it("reports an install whose list read fails as not installed, and a failing install as failed", async () => {
    const sent = await recorder();
    const press = {
      origin: PluginInstallOrigin.Index,
      surface: PluginInstallSurface.ListingPage,
      id: "u",
      source: null,
    };
    await trackedPluginInstall(
      press,
      async () => undefined,
      async () => Promise.reject(new Error("list")),
    );
    await setImmediate();
    await assert.rejects(
      trackedPluginInstall(
        press,
        async () => Promise.reject(new Error("install")),
        async () => null,
      ),
      /install/,
    );
    assert.deepEqual(
      sent.filter((s) => s.event === AnalyticsEvent.PluginInstallFinished).map((s) => s.properties.outcome),
      [InstallOutcome.NotInstalled, InstallOutcome.Failed],
    );
  });

  it("hears suggestions and consent cards from the log, and a plugin failing from main, with no names", async () => {
    const sent = await recorder();
    const observers = createPluginsObservers(() => 0);
    const list = [plugin("mine", PluginSourceKind.Local)];
    const plugins = createStore(() => ({ list, index: null, updating: false }));
    const play = createStore(() => ({}));
    const stop = observers.start?.({ plugins, play } as unknown as Studio);
    const record = (event_type: string, payload: unknown) =>
      ({
        id: "e",
        thread_id: SECRETS[7],
        session_id: null,
        turn_id: null,
        created_at: "",
        data: { type: "custom", event_type, payload },
      }) as never;
    observers.log?.(
      record(CustomEvent.PluginSuggested, {
        pluginId: "mine",
        offer: "turn-on",
        reason: SECRETS[4],
        project: SECRETS[0],
      }),
    );
    observers.log?.(
      record(CustomEvent.PluginConsent, {
        state: "pending",
        pluginId: SECRETS[6],
        prompt: SECRETS[4],
        args: { p: SECRETS[0] },
      }),
    );
    observers.ui?.({ type: UiEvent.PluginsChanged, payload: { id: "mine", reason: "failed" } });
    observers.ui?.({ type: UiEvent.SkilloptAutoApplyFailed, payload: { error: SECRETS[0] } });
    stop?.();
    assert.deepEqual(
      sent.map((s) => s.event),
      [
        AnalyticsEvent.PluginSuggestionShown,
        AnalyticsEvent.ConsentCardShown,
        AnalyticsEvent.PluginFailed,
        AnalyticsEvent.SuggestionAutoApplyFailed,
      ],
    );
    assertClean(sent, "observed events");
  });

  it("tracks only declared, clean properties for the hostile table", async () => {
    const sent = await recorder();
    track(AnalyticsEvent.PluginsSearched, pluginsSearchedProperties("skills", SECRETS.join(" "), 1));
    track(AnalyticsEvent.PlaySearched, playSearchedProperties(PlayShelf.Assets, SECRETS.join(" "), 0));
    assertClean(sent, "searches");
  });
});

/**
 * Plugins, connectors, the Harness room and Play (plan §1.7): finding and installing a plugin,
 * setting it up, an agent's suggestion and consent card, MCP servers, Harness's suggestions, and
 * Play's games. The builders live beside it (`plugins-page.ts`, `plugins-harness.ts`,
 * `plugins-play.ts`, `plugins-records.ts`); this file names the events and listens.
 */
import { customEvent, CustomEvent } from "../../../shared/custom-events.ts";
import type { McpTransport } from "../../../shared/mcp.ts";
import type { EventEnvelope } from "../../../shared/studio-api.ts";
import { UiEvent } from "../../../shared/ui-events.ts";
import type { PlayState } from "../../state/play.ts";
import type { Studio } from "../../state/studio.ts";
import { guarded, track } from "../client.ts";
import type { AreaObservers } from "../observers.ts";
import type { ActivityLoadedProperties, ChangeUndoneProperties, HarnessOpenedProperties } from "../plugins-harness.ts";
import type {
  ActionOutcome,
  AccountStateChangedProperties,
  ConnectorAction,
  ConnectorFormClosedProperties,
  ConnectorHealthChangedProperties,
  ConnectorTestedProperties,
  GithubLinkLookedUpProperties,
  PluginActionFinishedProperties,
  PluginDetailOpenedProperties,
  PluginInstallFinishedProperties,
  PluginInstallStartedProperties,
  PluginsPageLeftProperties,
  PluginsPageOpenedProperties,
  PluginsSearchedProperties,
  PluginUpdatesRunProperties,
  SetupCompletedProperties,
  SuggestionAnsweredProperties,
} from "../plugins-page.ts";
import {
  feedFailures,
  type FeedFailedProperties,
  type InstallFinishedProperties,
  type InstallsWatch,
  installsStep,
  NO_INSTALLS_WATCH,
  type PlaySearchedProperties,
  type RemixFinishedProperties,
  type RemixWatch,
  remixStep,
  type SessionEndedProperties,
  sessionsEnded,
  type ViewerSettledProperties,
  type ViewerWatch,
  viewerStep,
} from "../plugins-play.ts";
import {
  type ConsentCardShownProperties,
  consentCardShownProperties,
  type IndexLoadedProperties,
  indexLoadedProperties,
  type PluginFailedProperties,
  pluginFailedProperties,
  sameIndexRead,
  type SuggestionShownProperties,
  suggestionShownProperties,
} from "../plugins-records.ts";

export const PluginsEvent = {
  PluginsPageOpened: "plugins_page_opened",
  PluginsSearched: "plugins_searched",
  PluginDetailOpened: "plugin_detail_opened",
  PluginIndexLoaded: "plugin_index_loaded",
  PluginsPageLeft: "plugins_page_left",
  PluginInstallStarted: "plugin_install_started",
  PluginInstallFinished: "plugin_install_finished",
  GithubLinkLookedUp: "github_link_looked_up",
  PluginActionFinished: "plugin_action_finished",
  PluginAccountStateChanged: "plugin_account_state_changed",
  PluginFailed: "plugin_failed",
  PluginSetupCompleted: "plugin_setup_completed",
  PluginUpdatesRun: "plugin_updates_run",
  PluginSuggestionShown: "plugin_suggestion_shown",
  PluginSuggestionAnswered: "plugin_suggestion_answered",
  ConsentCardShown: "consent_card_shown",
  ConnectorFormClosed: "connector_form_closed",
  ConnectorTested: "connector_tested",
  ConnectorHealthChanged: "connector_health_changed",
  ConnectorAction: "connector_action",
  HarnessOpened: "harness_opened",
  ActivityLoaded: "activity_loaded",
  HarnessRecoveryProblemShown: "harness_recovery_problem_shown",
  ChangeUndone: "change_undone",
  PlayFeedFailed: "play_feed_failed",
  PlaySearched: "play_searched",
  PlayGameOpened: "play_game_opened",
  PlayViewerSettled: "play_viewer_settled",
  PlayRemixFinished: "play_remix_finished",
  NativeInstallFinished: "native_install_finished",
  NativeGameSessionEnded: "native_game_session_ended",
} as const;

/** How a Play game was opened: in the viewer (a page of its own is not followed yet). */
export const PlayOpens = { Viewer: "viewer" } as const;
export type PlayOpens = (typeof PlayOpens)[keyof typeof PlayOpens];

export type PluginsEventProperties = {
  [PluginsEvent.PluginsPageOpened]: PluginsPageOpenedProperties;
  [PluginsEvent.PluginsSearched]: PluginsSearchedProperties;
  [PluginsEvent.PluginDetailOpened]: PluginDetailOpenedProperties;
  [PluginsEvent.PluginIndexLoaded]: IndexLoadedProperties;
  [PluginsEvent.PluginsPageLeft]: PluginsPageLeftProperties;
  [PluginsEvent.PluginInstallStarted]: PluginInstallStartedProperties;
  [PluginsEvent.PluginInstallFinished]: PluginInstallFinishedProperties;
  [PluginsEvent.GithubLinkLookedUp]: GithubLinkLookedUpProperties;
  [PluginsEvent.PluginActionFinished]: PluginActionFinishedProperties;
  [PluginsEvent.PluginAccountStateChanged]: AccountStateChangedProperties;
  [PluginsEvent.PluginFailed]: PluginFailedProperties;
  [PluginsEvent.PluginSetupCompleted]: SetupCompletedProperties;
  [PluginsEvent.PluginUpdatesRun]: PluginUpdatesRunProperties;
  [PluginsEvent.PluginSuggestionShown]: SuggestionShownProperties;
  [PluginsEvent.PluginSuggestionAnswered]: SuggestionAnsweredProperties;
  [PluginsEvent.ConsentCardShown]: ConsentCardShownProperties;
  [PluginsEvent.ConnectorFormClosed]: ConnectorFormClosedProperties;
  [PluginsEvent.ConnectorTested]: ConnectorTestedProperties;
  [PluginsEvent.ConnectorHealthChanged]: ConnectorHealthChangedProperties;
  [PluginsEvent.ConnectorAction]: { action: ConnectorAction; transport: McpTransport; outcome: ActionOutcome };
  [PluginsEvent.HarnessOpened]: HarnessOpenedProperties;
  [PluginsEvent.ActivityLoaded]: ActivityLoadedProperties;
  [PluginsEvent.HarnessRecoveryProblemShown]: { has_detail: boolean };
  [PluginsEvent.ChangeUndone]: ChangeUndoneProperties;
  [PluginsEvent.PlayFeedFailed]: FeedFailedProperties;
  [PluginsEvent.PlaySearched]: PlaySearchedProperties;
  [PluginsEvent.PlayGameOpened]: { opens: PlayOpens };
  [PluginsEvent.PlayViewerSettled]: ViewerSettledProperties;
  [PluginsEvent.PlayRemixFinished]: RemixFinishedProperties;
  [PluginsEvent.NativeInstallFinished]: InstallFinishedProperties;
  [PluginsEvent.NativeGameSessionEnded]: SessionEndedProperties;
};

/** Whether the computer is online, where the page can say; a page that cannot reads as online. */
const online = (): boolean => (typeof navigator === "undefined" ? true : navigator.onLine !== false);

/** The log's records this area reads: an agent's plugin suggestion, and a consent card asked. */
function logRecord(app: Studio | null, record: EventEnvelope): void {
  const list = app?.plugins.getState().list ?? [];
  const suggested = customEvent(record, CustomEvent.PluginSuggested);
  const shown = suggested && suggestionShownProperties(suggested, list);
  if (shown) track(PluginsEvent.PluginSuggestionShown, shown);
  const consent = customEvent(record, CustomEvent.PluginConsent);
  const card = consent && consentCardShownProperties(consent, list);
  if (card) track(PluginsEvent.ConsentCardShown, card);
}

/** Main's events this area reads: a plugin failing. */
function uiEvent(app: Studio | null, event: UiEvent): void {
  if (event.type !== UiEvent.PluginsChanged) return;
  const failed = pluginFailedProperties(event.payload, app?.plugins.getState().list ?? []);
  if (failed) track(PluginsEvent.PluginFailed, failed);
}

/** Follow Play's store: feeds that failed, viewers, remixes, native installs and sessions. */
function followPlay(app: Studio, clock: () => number): () => void {
  const watch: PlayWatch = { viewer: null, remix: null, installs: NO_INSTALLS_WATCH };
  return app.play.subscribe(
    guarded((state: PlayState, before: PlayState) => {
      const now = clock();
      for (const failure of feedFailures(before.feeds, state.feeds, online()))
        track(PluginsEvent.PlayFeedFailed, failure);
      followShown(watch, state, now);
      followNative(watch, state, before, now);
    }),
  );
}

/** What Play is followed with from one state to the next, in memory only. */
interface PlayWatch {
  viewer: ViewerWatch | null;
  remix: RemixWatch | null;
  installs: InstallsWatch;
}

/** The viewer opening and settling, and a remix ending. */
function followShown(watch: PlayWatch, state: PlayState, now: number): void {
  const seen = viewerStep(watch.viewer, state.viewer, now, online());
  watch.viewer = seen.watch;
  if (seen.opened) track(PluginsEvent.PlayGameOpened, { opens: PlayOpens.Viewer });
  if (seen.settled) track(PluginsEvent.PlayViewerSettled, seen.settled);
  const made = remixStep(watch.remix, state, now);
  watch.remix = made.watch;
  if (made.finished) track(PluginsEvent.PlayRemixFinished, made.finished);
}

/** Native games: installs that ended, and sessions that ended. */
function followNative(watch: PlayWatch, state: PlayState, before: PlayState, now: number): void {
  if (state.installs !== before.installs) {
    const step = installsStep(watch.installs, before.installs, state.installs, now);
    watch.installs = step.watch;
    for (const finished of step.finished) track(PluginsEvent.NativeInstallFinished, finished);
  }
  if (state.sessions === before.sessions) return;
  for (const ended of sessionsEnded(before.sessions, state.sessions, now))
    track(PluginsEvent.NativeGameSessionEnded, ended);
}

/** Follow the plugin index: each read that says something new about the catalog. */
function followIndex(app: Studio): () => void {
  let last: IndexLoadedProperties | null = null;
  return app.plugins.subscribe(
    guarded((state, before) => {
      if (!state.index || state.index === before.index) return;
      const read = indexLoadedProperties(state.index);
      if (sameIndexRead(last, read)) return;
      last = read;
      track(PluginsEvent.PluginIndexLoaded, read);
    }),
  );
}

/** What this area hears from the log, from main's events and from the plugins and play stores. */
export function createPluginsObservers(clock: () => number = Date.now): AreaObservers {
  let studio: Studio | null = null;
  return {
    log: (record) => logRecord(studio, record),
    ui: (event) => uiEvent(studio, event),
    start: (app) => {
      studio = app;
      const offPlay = followPlay(app, clock);
      const offIndex = followIndex(app);
      return () => {
        offPlay();
        offIndex();
        studio = null;
      };
    },
  };
}

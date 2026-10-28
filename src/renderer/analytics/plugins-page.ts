/**
 * The Plugins page and every plugin action, as usage analytics reads them: how people arrive, what
 * they search and open, the installs, switches, settings and accounts they press, and the MCP
 * servers they add and test. Plugins are named by `pluginRef` (a catalog's id, or only "local" or
 * "github"); a connector, a search or a setting is never named, only counted.
 *
 * The builders are pure; the `tracked*` helpers run one action, report it and hand its result (or
 * its failure) back unchanged, so a call site stays one wrapper around what it already does.
 */
import type { ConnectionSnapshot } from "../../shared/connections.ts";
import { errorCodeIn, isUserCancelled } from "../../shared/errors.ts";
import type { McpConnectorView, McpHealth, McpTestResult, McpTransport } from "../../shared/mcp.ts";
import {
  type GithubLookup,
  GithubLookupKind,
  type GithubLookupProblem,
  PluginAccountState,
  PluginHealth,
  type PluginIndexEntry,
  type PluginInfo,
  PluginInstallProblem,
  type PluginScan,
  PluginSourceKind,
  PluginStateRefusal,
  type PluginTier,
} from "../../shared/plugins.ts";
import { SuggestionState } from "../chat/plugin-suggestion.ts";
import {
  type AccountState,
  type ExtensionsTab,
  needsSetup,
  type RowAccountStep,
  rowAccountStep,
} from "../panels/plugins/labels.ts";
import { quietly, track } from "./client.ts";
import { AnalyticsEvent } from "./events.ts";
import { installedRef, type ListedRef, pluginRef } from "./plugins-ref.ts";
import { type CharsBucket, charsBucket, type CountBucket, countBucket, elapsedMs } from "./properties.ts";

/** How the Plugins page was reached. */
export const PluginsOpenedFrom = {
  Sidebar: "sidebar",
  /** The composer's Add menu: Manage, or a plugin's row there. */
  ComposerManage: "composer_manage",
  /** A chat or stage card asked for a plugin's setup, and it has no panel of its own. */
  SetupRequest: "setup_request",
  /** A plugin suggestion's Manage. */
  SuggestionManage: "suggestion_manage",
  /** The sidebar's plugin updates list. */
  PluginUpdatesMenu: "plugin_updates_menu",
  /** A toolbar button's Update. */
  ToolbarUpdate: "toolbar_update",
} as const;
export type PluginsOpenedFrom = (typeof PluginsOpenedFrom)[keyof typeof PluginsOpenedFrom];

const OPENED_FROM: ReadonlySet<unknown> = new Set(Object.values(PluginsOpenedFrom));

/** Whether a value (a window event's detail) names a way into the Plugins page. */
export const isPluginsOpenedFrom = (value: unknown): value is PluginsOpenedFrom => OPENED_FROM.has(value);

let pendingFrom: PluginsOpenedFrom | null = null;

/** Say how the Plugins page is about to be opened; the page reads it once when it comes up or turns to a plugin. */
export function notePluginsOpening(from: PluginsOpenedFrom): void {
  pendingFrom = from;
}

/** How the page was reached, once: the note, else the sidebar (the only way in that names no plugin). */
export function takePluginsOpening(): PluginsOpenedFrom {
  const from = pendingFrom ?? PluginsOpenedFrom.Sidebar;
  pendingFrom = null;
  return from;
}

/** What the page shows: its lists, an installed plugin, a catalog listing, or a skill. */
export const PluginsPageView = { List: "list", Detail: "detail", Listing: "listing", Skill: "skill" } as const;
export type PluginsPageView = (typeof PluginsPageView)[keyof typeof PluginsPageView];

/** `plugins_page_opened`'s properties. */
export type PluginsPageOpenedProperties = {
  source: PluginsOpenedFrom;
  /** The plugin the page opened on, when it was asked for one. */
  setup_plugin_ref: string | null;
  installed: number;
  enabled: number;
  failed: number;
  updates: number;
};

/** The page coming up, as `plugins_page_opened`. */
export function pluginsPageOpenedProperties(opened: {
  from: PluginsOpenedFrom;
  setupPlugin: string | undefined;
  plugins: readonly PluginInfo[];
  updates: number;
}): PluginsPageOpenedProperties {
  const installed = opened.plugins.filter((p) => !p.removed && !p.unlisted);
  const setup = opened.setupPlugin;
  const shown = setup ? opened.plugins.find((p) => p.manifest.id === setup) : undefined;
  return {
    source: opened.from,
    setup_plugin_ref: setup ? pluginRef(setup, shown?.source ?? null) : null,
    installed: installed.length,
    enabled: installed.filter((p) => p.enabled).length,
    failed: installed.filter((p) => p.health === PluginHealth.Failed).length,
    updates: opened.updates,
  };
}

/** `plugins_searched`'s properties: never the words, only how many and whether anything matched. */
export type PluginsSearchedProperties = {
  tab: ExtensionsTab;
  query_chars_bucket: CharsBucket;
  result_count: number;
  zero_results: boolean;
};

/** A search the person stopped typing, as `plugins_searched`. */
export const pluginsSearchedProperties = (
  tab: ExtensionsTab,
  query: string,
  results: number,
): PluginsSearchedProperties => ({
  tab,
  query_chars_bucket: charsBucket(query.trim().length),
  result_count: results,
  zero_results: results === 0,
});

/** `plugin_detail_opened`'s properties. */
export type PluginDetailOpenedProperties = {
  plugin_ref: string;
  /** Where the installed plugin came from; null for a catalog listing not installed. */
  source_kind: PluginSourceKind | null;
  tier: PluginTier | null;
  enabled: boolean;
  health: PluginHealth | null;
  account_step: RowAccountStep | null;
  needs_setup: boolean;
  has_update: boolean;
};

/** An installed plugin's page or a catalog listing opening, as `plugin_detail_opened`. */
export function pluginDetailProperties(shown: {
  id: string;
  plugin: PluginInfo | undefined;
  listing: Pick<PluginIndexEntry, "tier"> | undefined;
  account: AccountState;
  hasUpdate: boolean;
}): PluginDetailOpenedProperties {
  const { plugin } = shown;
  return {
    plugin_ref: pluginRef(shown.id, plugin?.source ?? null),
    source_kind: plugin?.source ?? null,
    tier: shown.listing?.tier ?? null,
    enabled: plugin?.enabled ?? false,
    health: plugin?.health ?? null,
    account_step: plugin?.manifest.account ? rowAccountStep(shown.account) : null,
    needs_setup: plugin ? needsSetup(plugin, shown.account) : false,
    has_update: shown.hasUpdate,
  };
}

/** `plugins_page_left`'s properties. */
export type PluginsPageLeftProperties = {
  dwell_ms: number;
  actions_count: number;
  /** An action's failure was still on the page. */
  error_visible: boolean;
  last_view: PluginsPageView;
};

/** The page going away, as `plugins_page_left`. */
export const pluginsPageLeftProperties = (left: {
  openedAt: number;
  now: number;
  actions: number;
  error: boolean;
  view: PluginsPageView;
}): PluginsPageLeftProperties => ({
  dwell_ms: elapsedMs(left.openedAt, left.now),
  actions_count: left.actions,
  error_visible: left.error,
  last_view: left.view,
});

/** Where an install comes from. */
export const PluginInstallOrigin = {
  /** A release of Genex's own catalog. */
  Catalog: "catalog",
  /** An entry of the plugin index. */
  Index: "index",
  Github: "github",
  Local: "local",
  /** A removed plugin installed again. */
  Reinstall: "reinstall",
  /** Code found on disk, allowed to run. */
  AllowUnlisted: "allow_unlisted",
} as const;
export type PluginInstallOrigin = (typeof PluginInstallOrigin)[keyof typeof PluginInstallOrigin];

/** The button an install was pressed on. */
export const PluginInstallSurface = {
  BrowseRow: "browse_row",
  ListingPage: "listing_page",
  SuggestionCard: "suggestion_card",
  DetailReinstall: "detail_reinstall",
  MenuLoadLocal: "menu_load_local",
  GithubDialog: "github_dialog",
} as const;
export type PluginInstallSurface = (typeof PluginInstallSurface)[keyof typeof PluginInstallSurface];

/**
 * How an install ended. Main resolves the trust dialog's "no" and a closed folder picker the same
 * way as a yes, so "not installed" is read from the plugin list afterwards and covers both.
 */
export const InstallOutcome = { Installed: "installed", NotInstalled: "not_installed", Failed: "failed" } as const;
export type InstallOutcome = (typeof InstallOutcome)[keyof typeof InstallOutcome];

/** `plugin_install_started`'s properties. */
export type PluginInstallStartedProperties = {
  plugin_ref: string;
  origin: PluginInstallOrigin;
  surface: PluginInstallSurface;
};

/** `plugin_install_finished`'s properties. */
export type PluginInstallFinishedProperties = PluginInstallStartedProperties & {
  outcome: InstallOutcome;
  scan_verdict: PluginScan["verdict"] | null;
  duration_ms: number;
  /** A failed install's code; null when it had none. */
  code?: PluginInstallProblem | null;
};

/** An install as the person pressed it: where from, on which button, and the plugin when its id is known. */
export interface InstallPress {
  origin: PluginInstallOrigin;
  surface: PluginInstallSurface;
  /** The plugin's id, or null when the press names none (a folder picked, a link pasted). */
  id: string | null;
  /** Where the installed copy, if any, came from; null for a catalog or index plugin not installed. */
  source: PluginSourceKind | null;
}

const ORIGIN_SOURCE: Partial<Record<PluginInstallOrigin, PluginSourceKind>> = {
  [PluginInstallOrigin.Local]: PluginSourceKind.Local,
  [PluginInstallOrigin.Github]: PluginSourceKind.Github,
};

/** `plugin_install_started` for a press. */
export function installStartedProperties(press: InstallPress): PluginInstallStartedProperties {
  const source = press.source ?? ORIGIN_SOURCE[press.origin] ?? null;
  return { plugin_ref: pluginRef(press.id ?? "", source), origin: press.origin, surface: press.surface };
}

/** `plugin_install_finished` for a press: the plugin installed (or null), or the failure and its code. */
export function installFinishedProperties(
  press: InstallPress,
  installed: Pick<PluginInfo, "manifest" | "source" | "scan"> | null,
  failed: boolean,
  ms: number,
  failure: unknown = null,
): PluginInstallFinishedProperties {
  const started = installStartedProperties(press);
  return {
    ...started,
    plugin_ref: installed ? installedRef(installed) : started.plugin_ref,
    outcome: installOutcome(installed !== null, failed),
    scan_verdict: installed?.scan?.verdict ?? null,
    duration_ms: Math.max(0, Math.round(ms)),
    ...(failed ? { code: errorCodeIn(PluginInstallProblem, failure) } : {}),
  };
}

function installOutcome(installed: boolean, failed: boolean): InstallOutcome {
  if (failed) return InstallOutcome.Failed;
  return installed ? InstallOutcome.Installed : InstallOutcome.NotInstalled;
}

/** The plugin an install left in the list: the one named, active and not removed. */
export function installedPlugin(list: readonly PluginInfo[], id: string): PluginInfo | null {
  return list.find((p) => p.manifest.id === id && !p.removed && !p.unlisted) ?? null;
}

/** The plugin a nameless install (a folder picked) added: one listed now that was not before. */
export function addedPlugin(before: readonly PluginInfo[], after: readonly PluginInfo[]): PluginInfo | null {
  const known = new Set(before.filter((p) => !p.removed).map((p) => p.manifest.id));
  return after.find((p) => !p.removed && !p.unlisted && !known.has(p.manifest.id)) ?? null;
}

/** Whether the plugin `id` is installed now, read from main's list (the trust dialog's no leaves it out). */
export const installedNow = (id: string) => async (): Promise<PluginInfo | null> =>
  installedPlugin(await window.studio.pluginsList(), id);

/** Whether a nameless install (a folder picked) added a plugin to `before`, read from main's list. */
export const addedSince = (before: readonly PluginInfo[]) => async (): Promise<PluginInfo | null> =>
  addedPlugin(before, await window.studio.pluginsList());

/**
 * Run an install and report it: started now, finished with what the plugin list says afterwards.
 * Resolves once the install itself did: the list is read in the background, so nothing the person
 * waits on waits for analytics, and `found` hears what the read found. A failure is reported with
 * its code and rethrown; the person's no is reported as not installed.
 */
export async function trackedPluginInstall(
  press: InstallPress,
  run: () => Promise<unknown>,
  installed: () => Promise<PluginInfo | null>,
  clock: () => number = Date.now,
  found: (plugin: PluginInfo | null) => void = () => undefined,
): Promise<void> {
  const started = clock();
  track(AnalyticsEvent.PluginInstallStarted, installStartedProperties(press));
  try {
    await run();
  } catch (error) {
    const failed = !isUserCancelled(error);
    track(
      AnalyticsEvent.PluginInstallFinished,
      installFinishedProperties(press, null, failed, clock() - started, error),
    );
    throw error;
  }
  const ms = clock() - started;
  void Promise.resolve()
    .then(installed)
    .catch(() => null)
    .then((plugin) =>
      quietly(() => {
        track(AnalyticsEvent.PluginInstallFinished, installFinishedProperties(press, plugin, false, ms));
        found(plugin);
      }),
    );
}

/** How a GitHub link lookup ended: what it found, or that the call itself failed. */
export const GithubLookupResult = {
  Plugin: GithubLookupKind.Plugin,
  Choose: GithubLookupKind.Choose,
  Problem: GithubLookupKind.Problem,
  Failed: "failed",
} as const;
export type GithubLookupResult = (typeof GithubLookupResult)[keyof typeof GithubLookupResult];

/** `github_link_looked_up`'s properties. */
export type GithubLinkLookedUpProperties = {
  result: GithubLookupResult;
  problem: GithubLookupProblem | null;
  plugins_found: number;
  /** The person picked another version than the one the link settled on. */
  version_picked: boolean;
  duration_ms: number;
};

/** A lookup's answer (null: the call failed) as `github_link_looked_up`. */
export function githubLookupProperties(
  lookup: GithubLookup | null,
  picked: boolean,
  ms: number,
): GithubLinkLookedUpProperties {
  const base = { version_picked: picked, duration_ms: Math.max(0, Math.round(ms)) };
  if (!lookup) return { ...base, result: GithubLookupResult.Failed, problem: null, plugins_found: 0 };
  if (lookup.kind === GithubLookupKind.Problem)
    return { ...base, result: GithubLookupResult.Problem, problem: lookup.problem, plugins_found: 0 };
  const found = lookup.kind === GithubLookupKind.Choose ? lookup.plugins.length : 1;
  return { ...base, result: lookup.kind, problem: null, plugins_found: found };
}

/** What a plugin action did. */
export const PluginAction = {
  Enable: "enable",
  Disable: "disable",
  Remove: "remove",
  Update: "update",
  SettingSaved: "setting_saved",
  SettingsOpened: "settings_opened",
  WatchOn: "watch_on",
  WatchOff: "watch_off",
  PanelOpened: "panel_opened",
  AccountConnect: "account_connect",
  AccountCancel: "account_cancel",
  ForgetAllowed: "forget_allowed",
  ToolbarAction: "toolbar_action",
} as const;
export type PluginAction = (typeof PluginAction)[keyof typeof PluginAction];

/** Where a plugin action was pressed. */
export const PluginSurface = {
  PluginsPage: "plugins_page",
  AddMenu: "add_menu",
  SuggestionCard: "suggestion_card",
  Toolbar: "toolbar",
  Sidebar: "sidebar",
} as const;
export type PluginSurface = (typeof PluginSurface)[keyof typeof PluginSurface];

/** How an action ended. A failure says why only by its code (`code`), never its words. */
export const ActionOutcome = {
  Ok: "ok",
  Failed: "failed",
  /** The person said no in a native dialog. */
  Cancelled: "cancelled",
  /** The person said no in Studio's own review of the pictures, before the native dialog. */
  DeclinedReview: "declined_review",
} as const;
export type ActionOutcome = (typeof ActionOutcome)[keyof typeof ActionOutcome];

/** An action's outcome from what it threw: nothing, the person's no, or a failure. */
export function actionOutcome(error: unknown, threw: boolean): ActionOutcome {
  if (!threw) return ActionOutcome.Ok;
  return isUserCancelled(error) ? ActionOutcome.Cancelled : ActionOutcome.Failed;
}

/** The code a plugin's install, update, switch or removal failed with: never its words. */
export type PluginProblemCode = PluginInstallProblem | PluginStateRefusal;

/** The code a failed plugin action crossed with, or null. */
export const pluginProblemCode = (error: unknown): PluginProblemCode | null =>
  errorCodeIn(PluginInstallProblem, error) ?? errorCodeIn(PluginStateRefusal, error);

/** `plugin_action_finished`'s properties. */
export type PluginActionFinishedProperties = {
  action: PluginAction;
  plugin_ref: string;
  surface: PluginSurface;
  outcome: ActionOutcome;
  duration_ms: number;
  /** A failed action's code; null when it had none. */
  code?: PluginProblemCode | null;
};

/** One plugin action as the caller names it: what, on which plugin, from where. */
export interface ActionPress {
  action: PluginAction;
  plugin: ListedRef;
  surface: PluginSurface;
}

/** An action's end as `plugin_action_finished`; a failure says its code. */
export const pluginActionProperties = (
  press: ActionPress,
  outcome: ActionOutcome,
  ms: number,
  failure: unknown = null,
): PluginActionFinishedProperties => ({
  action: press.action,
  plugin_ref: installedRef(press.plugin),
  surface: press.surface,
  outcome,
  duration_ms: Math.max(0, Math.round(ms)),
  ...(outcome === ActionOutcome.Failed ? { code: pluginProblemCode(failure) } : {}),
});

/** When each plugin was last turned on in this window, by id (memory only): setup time counts from it. */
const enabledAt = new Map<string, number>();

/** When a plugin was turned on in this window, or null. */
export const pluginEnabledAt = (id: string): number | null => enabledAt.get(id) ?? null;

/** Report an action that already ended: its outcome, how long it took and what it failed with. */
export function reportPluginAction(
  press: ActionPress,
  outcome: ActionOutcome,
  started: number,
  now: number,
  failure: unknown = null,
): void {
  if (press.action === PluginAction.Enable && outcome === ActionOutcome.Ok)
    enabledAt.set(press.plugin.manifest.id, now);
  track(AnalyticsEvent.PluginActionFinished, pluginActionProperties(press, outcome, now - started, failure));
}

/** Run a plugin action and report how it ended; its result or failure goes back to the caller unchanged. */
export async function trackedPluginAction<T>(
  press: ActionPress,
  run: () => Promise<T>,
  clock: () => number = Date.now,
): Promise<T> {
  const started = clock();
  try {
    const result = await run();
    reportPluginAction(press, ActionOutcome.Ok, started, clock());
    return result;
  } catch (error) {
    reportPluginAction(press, actionOutcome(error, true), started, clock(), error);
    throw error;
  }
}

/** `plugin_account_state_changed`'s properties. */
export type AccountStateChangedProperties = {
  plugin_ref: string;
  from: PluginAccountState;
  to: PluginAccountState;
  ms_in_previous: number;
};

/** Each plugin account's state as last seen, and since when (memory only). */
export type AccountWatch = ReadonlyMap<string, { state: PluginAccountState; at: number }>;

/** The plugin accounts that moved between two connection snapshots; a first sight is not a move. */
export function accountChanges(
  watch: AccountWatch,
  snapshot: ConnectionSnapshot,
  plugins: readonly Pick<PluginInfo, "manifest" | "source">[],
  now: number,
): { watch: AccountWatch; changes: AccountStateChangedProperties[] } {
  const next = new Map(watch);
  const changes: AccountStateChangedProperties[] = [];
  for (const source of snapshot.sources) {
    if (source.kind !== "plugin" || !source.account) continue;
    const seen = watch.get(source.id);
    if (seen?.state === source.account) continue;
    next.set(source.id, { state: source.account, at: now });
    if (!seen) continue;
    const plugin = plugins.find((p) => p.manifest.id === source.id);
    changes.push({
      plugin_ref: pluginRef(source.id, plugin?.source ?? null),
      from: seen.state,
      to: source.account,
      ms_in_previous: elapsedMs(seen.at, now),
    });
  }
  return { watch: next, changes };
}

/** `plugin_setup_completed`'s properties. */
export type SetupCompletedProperties = {
  plugin_ref: string;
  /** From the press that turned it on in this window; null when it was on before. */
  ms_from_enable: number | null;
  had_account: boolean;
  had_setting: boolean;
};

/**
 * The plugins whose setup finished: on, with an account, once waiting on the person and now
 * connected. Returns the plugins still waiting and the ones that completed.
 */
export function setupCompletions(
  waiting: ReadonlySet<string>,
  plugins: readonly PluginInfo[],
  account: (id: string) => AccountState,
  now: number,
): { waiting: ReadonlySet<string>; completed: SetupCompletedProperties[] } {
  const next = new Set(waiting);
  const completed: SetupCompletedProperties[] = [];
  for (const plugin of plugins) {
    const { id } = plugin.manifest;
    const state = account(id);
    if (needsSetup(plugin, state)) next.add(id);
    const done = next.has(id) && plugin.enabled && state === PluginAccountState.Unlocked;
    if (!done) continue;
    next.delete(id);
    const enabled = pluginEnabledAt(id);
    completed.push({
      plugin_ref: installedRef(plugin),
      ms_from_enable: enabled === null ? null : elapsedMs(enabled, now),
      had_account: Boolean(plugin.manifest.account),
      had_setting: plugin.manifest.settings.length > 0,
    });
  }
  return { waiting: next, completed };
}

/** Where Update plugins was pressed in the sidebar: its own button, or the list's. */
export const UpdatesRunSurface = { SidebarButton: "sidebar_button", SidebarMenu: "sidebar_menu" } as const;
export type UpdatesRunSurface = (typeof UpdatesRunSurface)[keyof typeof UpdatesRunSurface];

/** `plugin_updates_run`'s properties. */
export type PluginUpdatesRunProperties = {
  surface: UpdatesRunSurface;
  chosen: number;
  skipped: number;
  /** Chosen updates still offered afterwards: failed, or turned down in a trust dialog. */
  not_updated: number;
  /** Chosen updates that failed (each toasted with its code). */
  failed: number;
  /** Chosen updates the person turned down in a trust dialog. */
  declined: number;
  duration_ms: number;
};

/** A finished run of Update plugins, as `plugin_updates_run`. */
export const updatesRunProperties = (run: {
  surface: UpdatesRunSurface;
  chosen: number;
  skipped: number;
  notUpdated: number;
  failed: number;
  declined: number;
  startedAt: number;
  now: number;
}): PluginUpdatesRunProperties => ({
  surface: run.surface,
  chosen: run.chosen,
  skipped: run.skipped,
  not_updated: run.notUpdated,
  failed: run.failed,
  declined: run.declined,
  duration_ms: elapsedMs(run.startedAt, run.now),
});

/** What the person did with an agent's plugin suggestion. */
export const SuggestionAnswerAction = { Pressed: "pressed", Closed: "closed" } as const;
export type SuggestionAnswerAction = (typeof SuggestionAnswerAction)[keyof typeof SuggestionAnswerAction];

/** How a pressed suggestion ended. */
export const SuggestionAnswerOutcome = {
  /** Turned on. */
  On: "on",
  Installed: "installed",
  /** Install… resolved but nothing was installed (the trust dialog's no). */
  NotInstalled: "not_installed",
  Failed: "failed",
} as const;
export type SuggestionAnswerOutcome = (typeof SuggestionAnswerOutcome)[keyof typeof SuggestionAnswerOutcome];

/** `plugin_suggestion_answered`'s properties. */
export type SuggestionAnsweredProperties = {
  plugin_ref: string;
  state: SuggestionState;
  action: SuggestionAnswerAction;
  outcome: SuggestionAnswerOutcome | null;
  duration_ms: number | null;
};

/** The suggestion card's button as it was pressed: Turn on or Install…, for which plugin. */
export interface SuggestionPress {
  state: typeof SuggestionState.TurnOn | typeof SuggestionState.Install;
  id: string;
  /** Where the installed copy came from; null when it is not installed (a catalog plugin). */
  source: PluginSourceKind | null;
}

/** Turn on the suggested plugin, reported as the turn-on it is; a plugin of unknown source is named only as local. */
async function suggestionTurnOn(press: SuggestionPress, run: () => Promise<void>, clock: () => number) {
  const plugin = { manifest: { id: press.id }, source: press.source ?? PluginSourceKind.Local };
  await trackedPluginAction({ action: PluginAction.Enable, plugin, surface: PluginSurface.SuggestionCard }, run, clock);
  return SuggestionAnswerOutcome.On;
}

/** Install the suggested plugin, reported as the install it is; `answered` hears what it came to once the list says. */
function suggestionInstall(
  press: SuggestionPress,
  run: () => Promise<void>,
  clock: () => number,
  answered: (outcome: SuggestionAnswerOutcome) => void,
): Promise<void> {
  const install = {
    origin: PluginInstallOrigin.Catalog,
    surface: PluginInstallSurface.SuggestionCard,
    id: press.id,
    source: press.source,
  };
  return trackedPluginInstall(install, run, installedNow(press.id), clock, (plugin) =>
    answered(plugin ? SuggestionAnswerOutcome.Installed : SuggestionAnswerOutcome.NotInstalled),
  );
}

/** The suggestion card's button, pressed: run it, report it, and report the card's answer. Failures go back to the caller. */
export async function trackedSuggestionPress(
  press: SuggestionPress,
  run: () => Promise<void>,
  clock: () => number = Date.now,
): Promise<void> {
  const started = clock();
  const answer = (outcome: SuggestionAnswerOutcome, at: number = clock()): void =>
    track(AnalyticsEvent.PluginSuggestionAnswered, {
      plugin_ref: pluginRef(press.id, press.source),
      state: press.state,
      action: SuggestionAnswerAction.Pressed,
      outcome,
      duration_ms: elapsedMs(started, at),
    });
  try {
    if (press.state === SuggestionState.TurnOn) {
      answer(await suggestionTurnOn(press, run, clock));
      return;
    }
    // The install's answer waits for the list in the background; its time is the install's own.
    let ranAt = started;
    const timed = async (): Promise<void> => {
      await run();
      ranAt = clock();
    };
    await suggestionInstall(press, timed, clock, (outcome) => answer(outcome, ranAt));
  } catch (error) {
    answer(SuggestionAnswerOutcome.Failed);
    throw error;
  }
}

/** The suggestion card closed with its cross, as `plugin_suggestion_answered`. */
export const suggestionClosedProperties = (
  id: string,
  source: PluginSourceKind | null,
  state: SuggestionState,
): SuggestionAnsweredProperties => ({
  plugin_ref: pluginRef(id, source),
  state,
  action: SuggestionAnswerAction.Closed,
  outcome: null,
  duration_ms: null,
});

/** How a connector's form was used. */
export const ConnectorFormMode = { Add: "add", Edit: "edit" } as const;
export type ConnectorFormMode = (typeof ConnectorFormMode)[keyof typeof ConnectorFormMode];

/** How a connector's form closed. */
export const ConnectorFormOutcome = { Saved: "saved", Abandoned: "abandoned" } as const;
export type ConnectorFormOutcome = (typeof ConnectorFormOutcome)[keyof typeof ConnectorFormOutcome];

/** `connector_form_closed`'s properties. */
export type ConnectorFormClosedProperties = {
  mode: ConnectorFormMode;
  outcome: ConnectorFormOutcome;
  transport: McpTransport;
  had_paste: boolean;
  /** Connectors the pasted snippets held, and the warnings they raised. */
  paste_drafts: number;
  paste_warnings: number;
  /** Saves that failed before the form closed. */
  save_failures: number;
  /** The program's trust dialog was turned down at least once. */
  trust_declined: boolean;
  /** A problem was on the form when it closed. */
  problem_shown: boolean;
};

/** What happened in one opening of the form, counted as it went. */
export interface ConnectorFormVisit {
  mode: ConnectorFormMode;
  pastes: number;
  drafts: number;
  warnings: number;
  saveFailures: number;
  trustDeclined: boolean;
}

/** A form just opened. */
export const connectorFormOpened = (mode: ConnectorFormMode): ConnectorFormVisit => ({
  mode,
  pastes: 0,
  drafts: 0,
  warnings: 0,
  saveFailures: 0,
  trustDeclined: false,
});

/** A snippet pasted into the form: how many connectors it held and how many warnings it raised. */
export const connectorPasted = (visit: ConnectorFormVisit, drafts: number, warnings: number): ConnectorFormVisit => ({
  ...visit,
  pastes: visit.pastes + 1,
  drafts: visit.drafts + drafts,
  warnings: visit.warnings + warnings,
});

/** A save that failed: the person's no in the program's trust dialog, or a failure. */
export const connectorSaveFailed = (visit: ConnectorFormVisit, error: unknown): ConnectorFormVisit => ({
  ...visit,
  saveFailures: visit.saveFailures + 1,
  trustDeclined: visit.trustDeclined || isUserCancelled(error),
});

/** The form closing, as `connector_form_closed`. */
export const connectorFormClosedProperties = (
  visit: ConnectorFormVisit,
  closed: { outcome: ConnectorFormOutcome; transport: McpTransport; problemShown: boolean },
): ConnectorFormClosedProperties => ({
  mode: visit.mode,
  outcome: closed.outcome,
  transport: closed.transport,
  had_paste: visit.pastes > 0,
  paste_drafts: visit.drafts,
  paste_warnings: visit.warnings,
  save_failures: visit.saveFailures,
  trust_declined: visit.trustDeclined,
  problem_shown: closed.problemShown,
});

/** `connector_tested`'s properties. */
export type ConnectorTestedProperties = {
  transport: McpTransport;
  ok: boolean;
  tools_bucket: CountBucket;
  duration_ms: number;
};

/** A Test's answer (null: the call failed) as `connector_tested`. */
export const connectorTestedProperties = (
  transport: McpTransport,
  result: Pick<McpTestResult, "ok" | "tools" | "durationMs"> | null,
  ms: number,
): ConnectorTestedProperties => ({
  transport,
  ok: result?.ok ?? false,
  tools_bucket: countBucket(result?.tools.length ?? 0),
  duration_ms: Math.max(0, Math.round(result?.durationMs ?? ms)),
});

/** Who added a connector: the person, or a plugin that ships it. */
export const ConnectorSource = { User: "user", Plugin: "plugin" } as const;
export type ConnectorSource = (typeof ConnectorSource)[keyof typeof ConnectorSource];

/** `connector_health_changed`'s properties. */
export type ConnectorHealthChangedProperties = {
  transport: McpTransport;
  source: ConnectorSource;
  from: McpHealth;
  to: McpHealth;
  auth: NonNullable<McpConnectorView["authentication"]>["state"] | null;
};

/** The connectors whose health moved between two reads of the list, matched by id in memory. */
export function connectorHealthChanges(
  before: readonly McpConnectorView[],
  after: readonly McpConnectorView[],
): ConnectorHealthChangedProperties[] {
  const was = new Map(before.map((view) => [view.connector.id, view.health]));
  return after.flatMap((view) => {
    const from = was.get(view.connector.id);
    if (from === undefined || from === view.health) return [];
    return [
      {
        transport: view.connector.transport,
        source: typeof view.connector.source === "object" ? ConnectorSource.Plugin : ConnectorSource.User,
        from,
        to: view.health,
        auth: view.authentication?.state ?? null,
      },
    ];
  });
}

/** What a connector row's button did. */
export const ConnectorAction = {
  Connect: "connect",
  CancelSignIn: "cancel_sign_in",
  DisconnectAccount: "disconnect_account",
  Remove: "remove",
  TurnOn: "turn_on",
  TurnOff: "turn_off",
} as const;
export type ConnectorAction = (typeof ConnectorAction)[keyof typeof ConnectorAction];

/** Run a connector row's action and report it; its result or failure goes back unchanged. */
export async function trackedConnectorAction<T>(
  action: ConnectorAction,
  transport: McpTransport,
  run: () => Promise<T>,
): Promise<T> {
  try {
    const result = await run();
    track(AnalyticsEvent.ConnectorAction, { action, transport, outcome: ActionOutcome.Ok });
    return result;
  } catch (error) {
    track(AnalyticsEvent.ConnectorAction, { action, transport, outcome: actionOutcome(error, true) });
    throw error;
  }
}

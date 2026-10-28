/**
 * What the Plugins page tells usage analytics: how it was reached and left, what was searched
 * (only how long, and how many matched), which plugin pages opened, and the accounts and setups
 * that moved while it was open. The mapping is `analytics/plugins-page.ts`'s; these hooks only
 * decide when.
 */
import { useEffect, useRef } from "react";
import type { ConnectionSnapshot } from "../../../shared/connections.ts";
import type { PluginIndexEntry, PluginIndexView, PluginInfo } from "../../../shared/plugins.ts";
import type { ProjectSkillInventory, ProviderSkillInventory } from "../../../shared/provider-skills.ts";
import { track } from "../../analytics/client.ts";
import { AnalyticsEvent } from "../../analytics/events.ts";
import {
  type AccountWatch,
  accountChanges,
  pluginDetailProperties,
  pluginsPageLeftProperties,
  pluginsPageOpenedProperties,
  PluginsPageView,
  pluginsSearchedProperties,
  setupCompletions,
  takePluginsOpening,
} from "../../analytics/plugins-page.ts";
import { ExtensionsTab, pluginAccount } from "./labels.ts";
import type { CatalogRow, PluginsPage } from "./page.ts";
import { pluginMatches } from "./rows.tsx";
import { gameSkillsSection, pluginSkillRows, type SkillRow, studioSkillsSection } from "./skills-sections.ts";

/** How long the search rests before it counts as searched. */
const SEARCH_REPORT_MS = 1_000;

/** What the page held when it came up, and what it shows when it goes. */
export interface PageVisit {
  setupPlugin: string | undefined;
  plugins: readonly PluginInfo[];
  updates: number;
  view: PluginsPageView;
  error: boolean;
  actions: number;
}

/** One visit of the page: when it came up, and whether it just unmounted and waits to be counted as left. */
interface OpenVisit {
  openedAt: number;
  leaving: boolean;
}

/** The page came up: how it was reached and what it held, sent once; the visit starts now. */
function reportOpened({ setupPlugin, plugins, updates }: PageVisit): OpenVisit {
  const openedAt = Date.now();
  track(
    AnalyticsEvent.PluginsPageOpened,
    pluginsPageOpenedProperties({ from: takePluginsOpening(), setupPlugin, plugins, updates }),
  );
  return { openedAt, leaving: false };
}

/**
 * The page coming up (once) and going away; a later request to show a plugin only spends its note.
 * StrictMode's development replay unmounts and mounts at once: the leave waits a microtask, and the
 * mount in between takes it back, so the replay is neither a second visit nor a leave.
 */
export function usePageVisitReport(visit: PageVisit): void {
  const latest = useRef(visit);
  latest.current = visit;
  const open = useRef<OpenVisit | null>(null);
  // The page is reached once a mount; `latest` holds what it shows when it goes.
  useEffect(() => {
    const replayed = open.current;
    if (replayed) replayed.leaving = false;
    else open.current = reportOpened(latest.current);
    const current = open.current;
    return () => {
      if (!current) return;
      current.leaving = true;
      queueMicrotask(() => {
        if (!current.leaving) return;
        open.current = null;
        const { view, error, actions } = latest.current;
        const left = { openedAt: current.openedAt, now: Date.now(), actions, error, view };
        track(AnalyticsEvent.PluginsPageLeft, pluginsPageLeftProperties(left));
      });
    };
  }, []);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // Asked to show another plugin while open: the page was already reached; the note is spent.
    takePluginsOpening();
  }, [visit.setupPlugin]);
}

/** What a search on the page can match. */
export interface SearchScope {
  page: PluginsPage;
  plugins: readonly PluginInfo[];
  index: PluginIndexView | null;
  catalog: readonly CatalogRow[];
  builtins: ReadonlyArray<{ name: string; text: string; description: string }>;
  game: ProjectSkillInventory | null;
  providers: readonly ProviderSkillInventory[] | null;
}

const rowMatches = (page: PluginsPage) => (row: SkillRow) => page.matches(row.name, ...row.search);

/** How many things on the tab match its search: plugins and catalog entries, or skills. */
export function searchResultCount(tab: ExtensionsTab, scope: SearchScope): number {
  const { page, plugins } = scope;
  if (tab === ExtensionsTab.Plugins) {
    const installed = new Set(plugins.filter((p) => !p.removed).map((p) => p.manifest.id));
    const entries = (scope.index?.entries ?? []).filter(
      (e: PluginIndexEntry) => !installed.has(e.id) && page.matches(e.name, e.description, e.category, e.publisher),
    );
    const releases = scope.catalog.filter((c) => !installed.has(c.id) && page.matches(c.name));
    return plugins.filter((p) => pluginMatches(page, p)).length + entries.length + releases.length;
  }
  const rows = [
    ...pluginSkillRows(plugins),
    ...studioSkillsSection(scope.builtins).rows,
    ...(scope.game ? gameSkillsSection(scope.game).rows : []),
  ];
  const providers = (scope.providers ?? []).flatMap((p) => p.skills);
  const fromProviders = providers.filter((s) => page.matches(s.name, s.description, s.scope)).length;
  return rows.filter(rowMatches(page)).length + fromProviders;
}

/** A search the person stopped typing, once for each search: never its words. */
export function useSearchReport(tab: ExtensionsTab, query: string, results: number): void {
  const reported = useRef("");
  const count = useRef(results);
  count.current = results;
  useEffect(() => {
    const trimmed = query.trim();
    const key = `${tab}\n${trimmed}`;
    if (!trimmed || key === reported.current) return;
    const timer = setTimeout(() => {
      reported.current = key;
      track(AnalyticsEvent.PluginsSearched, pluginsSearchedProperties(tab, trimmed, count.current));
    }, SEARCH_REPORT_MS);
    return () => clearTimeout(timer);
  }, [tab, query]);
}

/** A plugin's page or a catalog listing opening, once each time the page turns to it. */
export function useDetailReport(
  detailId: string | null,
  shown: { plugin: PluginInfo | undefined; listing: PluginIndexEntry | undefined; page: PluginsPage },
): void {
  const latest = useRef(shown);
  latest.current = shown;
  useEffect(() => {
    if (!detailId) return;
    const { plugin, listing, page } = latest.current;
    if (!plugin && !listing) return;
    const account = pluginAccount(page.connections, detailId);
    const hasUpdate = page.updates.has(detailId);
    track(
      AnalyticsEvent.PluginDetailOpened,
      pluginDetailProperties({ id: detailId, plugin, listing, account, hasUpdate }),
    );
  }, [detailId]);
}

/** Plugin accounts that moved, and setups that finished, while the page was open to see them. */
export function useAccountReports(plugins: readonly PluginInfo[], connections: ConnectionSnapshot | null): void {
  const accounts = useRef<AccountWatch>(new Map());
  const waiting = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!connections) return;
    const now = Date.now();
    const moved = accountChanges(accounts.current, connections, plugins, now);
    accounts.current = moved.watch;
    for (const change of moved.changes) track(AnalyticsEvent.PluginAccountStateChanged, change);
    const setups = setupCompletions(waiting.current, plugins, (id) => pluginAccount(connections, id), now);
    waiting.current = setups.waiting;
    for (const completed of setups.completed) track(AnalyticsEvent.PluginSetupCompleted, completed);
  }, [plugins, connections]);
}

/** What the page shows now, by the navigation's state. */
export function pageView(nav: { skill: unknown; detailId: string | null }, listing: boolean): PluginsPageView {
  if (nav.skill) return PluginsPageView.Skill;
  if (listing) return PluginsPageView.Listing;
  return nav.detailId ? PluginsPageView.Detail : PluginsPageView.List;
}

/** Everything the page reports, from what it holds. */
export interface PageAnalytics {
  nav: { tab: ExtensionsTab; query: string; skill: unknown; detailId: string | null };
  setupPlugin: string | undefined;
  page: PluginsPage;
  detail: PluginInfo | undefined;
  listing: PluginIndexEntry | undefined;
  /** How many actions the page ran since it came up. */
  actions: number;
  plugins: readonly PluginInfo[];
  index: PluginIndexView | null;
  /** The page's own reads: the catalog's releases and Studio's skills. */
  data: Pick<SearchScope, "catalog" | "builtins">;
  /** The Skills tab's reads: this game's skills and each provider's. */
  skills: { game: ProjectSkillInventory | null; providerInventory: readonly ProviderSkillInventory[] | null };
}

/** The Plugins page's reports, in one call: its visit, its searches, the pages it turned to and the accounts that moved. */
export function usePluginsPageAnalytics(input: PageAnalytics): void {
  const { nav, page, plugins, data, skills } = input;
  const scope = { page, plugins, index: input.index, ...data, game: skills.game, providers: skills.providerInventory };
  usePageVisitReport({
    setupPlugin: input.setupPlugin,
    plugins,
    updates: page.updates.size,
    view: pageView(nav, Boolean(input.listing)),
    error: Boolean(page.error),
    actions: input.actions,
  });
  // Counting only while there is a search: the Skills tab's rows are built afresh to count them.
  const results = nav.query.trim() ? searchResultCount(nav.tab, scope) : 0;
  useSearchReport(nav.tab, nav.query, results);
  useDetailReport(nav.detailId, { plugin: input.detail, listing: input.listing, page });
  useAccountReports(plugins, page.connections);
}

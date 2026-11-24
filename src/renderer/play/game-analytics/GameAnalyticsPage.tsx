/**
 * A game's analytics page, which only its creator sees: opened from the game's row on the Stats
 * page (or from Create, `openPlayGameAnalytics`), with a tab for each report, Campaign links and
 * SDK. This is the container: it reads the stores, asks the game analytics store for what the tab
 * shown needs (and leaves it when the tab, the period or an option changes), and hands everything
 * to the faces in `AnalyticsFace.tsx`. The tab lives in Play's view, the period beside the Stats
 * page's, the options and the SDK tab's origin here, for as long as the page is up.
 */
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import { MINUTE_MS } from "../../../shared/duration.ts";
import { EventOrigin, type GameReportOptions } from "../../../shared/game-analytics.ts";
import { playPageUrl } from "../../../shared/play.ts";
import type { StatsPeriod } from "../../../shared/play-stats.ts";
import {
  EVENTS_STATUS_POLL_MS,
  eventsKey,
  latestReady,
  linksKey,
  reportKey,
  reportQuery,
} from "../../state/game-analytics.ts";
import { useGameAnalytics, usePeople, usePlay, usePlayWeb } from "../../state/hooks.ts";
import { PlayPage } from "../../state/play.ts";
import { studio } from "../../state/studio.ts";
import { useBackOnline, useOnline } from "../../ui/use-online.ts";
import { useCopy } from "../../use-copy.ts";
import { PlayPageFrame } from "../PlayPageFrame.tsx";
import { type AnalyticsActions, AnalyticsFace } from "./AnalyticsFace.tsx";
import { bodyOf, headOf, type ShownTab, statsRow } from "./page-view.ts";
import { backLabel, PAGE_WORDS } from "./page-words.ts";
import { AnalyticsTab, reportOf } from "./tabs.ts";

/** How often "updated … ago" is counted again on a report. */
const AGO_TICK_MS = MINUTE_MS / 2;

/** What the page is asked to show, and with what. */
interface Asked {
  slug: string;
  tab: AnalyticsTab;
  period: StatsPeriod;
  options: GameReportOptions;
  origin: EventOrigin;
  signedIn: boolean;
}

/** The wall clock, read again every `tickMs`, for how long ago the numbers were computed. */
function useNow(tickMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(timer);
  }, [tickMs]);
  return now;
}

/**
 * The tab shown with its body, from the store: its own read, or the tab's last answer to another
 * period or option while the new one is on its way.
 */
function useShownTab({ slug, tab, period, options, origin, signedIn }: Asked): ShownTab {
  const online = useOnline();
  const report = reportOf(tab);
  const reportEntry = useGameAnalytics((s) =>
    report ? s.reports[reportKey(reportQuery(slug, report, period, options))] : undefined,
  );
  const lastAnswer = useGameAnalytics((s) =>
    report ? latestReady(s.reports, (ask) => ask.slug === slug && ask.report === report) : null,
  );
  const linksEntry = useGameAnalytics((s) => s.links[linksKey({ slug, days: period })]);
  const lastLinks = useGameAnalytics((s) => latestReady(s.links, (ask) => ask.slug === slug));
  const eventsEntry = useGameAnalytics((s) => s.events[eventsKey({ slug, origin })]);
  const lastEvents = useGameAnalytics((s) => latestReady(s.events, (ask) => ask.slug === slug));
  const state = { signedIn, online };
  if (tab === AnalyticsTab.Links) return { tab, body: bodyOf({ ...state, entry: linksEntry, previous: lastLinks }) };
  // The events status is read again every few seconds: only another origin's answer on its way dims the tab.
  if (tab === AnalyticsTab.Sdk)
    return { tab, body: bodyOf({ ...state, entry: eventsEntry, previous: lastEvents, quietRereads: true }) };
  return { tab, body: bodyOf({ ...state, entry: reportEntry, previous: lastAnswer }) };
}

/**
 * Read what the tab shows for as long as it shows it: a report or the links once (again when
 * stale), the events status on its interval. The store's account is a reason to read too: one that
 * changes straight to another empties the store, and the new account reads afresh. Returns the
 * forced re-read, which also runs when the connection comes back.
 */
function useTabRead({ slug, tab, period, options, origin, signedIn }: Asked): () => void {
  const report = reportOf(tab);
  const account = useGameAnalytics((s) => s.account);
  const query = useMemo(
    () => (report ? reportQuery(slug, report, period, options) : null),
    [slug, report, period, options],
  );
  useEffect(() => {
    if (!signedIn || account === null) return;
    const store = studio().gameAnalytics;
    if (tab === AnalyticsTab.Sdk) return store.watchEvents(slug, origin);
    if (query) void store.loadReport(query);
    else void store.loadLinks(slug, period);
    // What was asked for is left: its answer, if still on its way, lands nowhere.
    return () => store.leave();
  }, [signedIn, account, slug, tab, period, origin, query]);
  const reload = (): void => {
    if (!signedIn) return;
    const store = studio().gameAnalytics;
    if (tab === AnalyticsTab.Sdk) void store.loadEvents(slug, origin);
    else if (query) void store.loadReport(query, { force: true });
    else void store.loadLinks(slug, period, { force: true });
  };
  useBackOnline(reload);
  return reload;
}

/** A game's analytics page. */
export function GameAnalyticsPage({
  slug,
  tab,
  sidebarHidden,
  onToggleSidebar,
}: {
  slug: string;
  tab: AnalyticsTab;
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
}): JSX.Element {
  const signedIn = usePeople((s) => s.me !== null);
  const period = useGameAnalytics((s) => s.period);
  const [options, setOptions] = useState<GameReportOptions>({});
  const [origin, setOrigin] = useState<EventOrigin>(EventOrigin.Published);
  const asked: Asked = { slug, tab, period, options, origin, signedIn };
  const shown = useShownTab(asked);
  const reload = useTabRead(asked);
  const game = useGameAnalytics((s) => s.games[slug]);
  const row = usePeople((s) => statsRow(s.stats, slug));
  const page = usePlay((s) => s.games[slug]?.game ?? null);
  const back = usePlay((s) => (s.view.page === PlayPage.GameAnalytics ? s.view.back : null));
  const gameUrl = playPageUrl(usePlayWeb(), slug);
  const [copied, copy] = useCopy();
  // The SDK tab's "last event … ago" moves in seconds; a report's "updated … ago" in minutes.
  const now = useNow(tab === AnalyticsTab.Sdk ? EVENTS_STATUS_POLL_MS : AGO_TICK_MS);
  const head = headOf(game, row, page);
  const store = studio().gameAnalytics;
  const actions: AnalyticsActions = {
    onTab: (next) => studio().play.chooseAnalyticsTab(next),
    onPeriod: (days) => store.choosePeriod(days),
    onOptions: (change) => setOptions((current) => ({ ...current, ...change })),
    onOrigin: setOrigin,
    onRetry: reload,
    onCopy: () => copy(gameUrl),
    onSaveLink: (tags) => store.saveLink(slug, tags),
    onRemoveLink: (id) => store.removeLink(slug, id),
    onSaveFunnel: (draft) => store.saveFunnel(slug, draft),
    onRemoveFunnel: (id) => store.removeFunnel(slug, id),
  };
  return (
    <PlayPageFrame
      label={head.title ?? PAGE_WORDS.title}
      sidebarHidden={sidebarHidden}
      onToggleSidebar={onToggleSidebar}
      onBack={() => studio().play.back()}
      backLabel={backLabel(back)}
    >
      <AnalyticsFace
        slug={slug}
        shown={shown}
        head={head}
        game={game ?? null}
        gameUrl={gameUrl}
        copied={copied}
        period={period}
        options={options}
        origin={origin}
        now={now}
        actions={actions}
      />
    </PlayPageFrame>
  );
}

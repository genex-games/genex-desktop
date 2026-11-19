/**
 * The faces of a game's analytics page, drawn from props alone (the container in
 * `GameAnalyticsPage.tsx` reads the stores): the header with the game, its link and the facts
 * about the numbers; the tabs, with Campaign links and SDK set apart at the row's end, and the
 * period switch; and the body, which is one face per state (signed out, loading, offline, failed,
 * not served yet, no such game, no such report) or the tab's own component once there is an
 * answer to draw.
 */
import type { JSX, KeyboardEvent, ReactNode } from "react";
import { useId } from "react";
import {
  type AnalyticsGame,
  type CampaignLink,
  type CampaignTags,
  type EventFunnel,
  type EventFunnelDraft,
  type EventOrigin,
  GameReport,
  type GameReportAnswer,
  type GameReportOptions,
} from "../../../shared/game-analytics.ts";
import type { StatsPeriod } from "../../../shared/play-stats.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/icons.tsx";
import { RovingAxis, rovingTarget } from "../../ui/roving-focus.ts";
import { PLAY_WORDS } from "../../words.ts";
import { PeriodSwitch } from "../PeriodSwitch.tsx";
import { OfflineNotice } from "../PlayOffline.tsx";
import { formatStat } from "../play-model.ts";
import { SignInNote } from "../SignInNote.tsx";
import { AcquisitionReport } from "./AcquisitionReport.tsx";
import { EngagementReport } from "./EngagementReport.tsx";
import { EventsReport } from "./EventsReport.tsx";
import { InstallsReport } from "./InstallsReport.tsx";
import { LinksPage } from "./LinksPage.tsx";
import { OverviewReport } from "./OverviewReport.tsx";
import { type Body, BodyKind, type HeadGame, headFacts, type ShownTab } from "./page-view.ts";
import { noReportWords, PAGE_WORDS } from "./page-words.ts";
import type { TabProps } from "./report-props.ts";
import { RetentionReport } from "./RetentionReport.tsx";
import { RevenueReport } from "./RevenueReport.tsx";
import { SdkPage } from "./SdkPage.tsx";
import { AnalyticsTab, isSideTab, listedTabs } from "./tabs.ts";

/** The attribute the page's period buttons carry. */
const PERIOD_ATTRIBUTE = "data-game-analytics-period";
/** A link is shown without its scheme: "genex.games/lantern-run". */
const SCHEME = /^https?:\/\//;
/** The skeleton's tiles while a tab loads. */
const SKELETON_TILES = [0, 1, 2, 3];

/** What the page's controls ask of its container. */
export interface AnalyticsActions {
  onTab(tab: AnalyticsTab): void;
  onPeriod(days: StatsPeriod): void;
  /** Merge a change into the report's options and read it again. */
  onOptions(change: GameReportOptions): void;
  onOrigin(origin: EventOrigin): void;
  /** Read what the tab shows again, whatever its age. */
  onRetry(): void;
  /** Copy the game's link. */
  onCopy(): void;
  onSaveLink(tags: CampaignTags): Promise<CampaignLink>;
  onRemoveLink(id: string): Promise<void>;
  onSaveFunnel(draft: EventFunnelDraft): Promise<EventFunnel>;
  onRemoveFunnel(id: string): Promise<void>;
}

/** Everything the page draws. */
export interface AnalyticsFaceProps {
  slug: string;
  /** The tab shown, with what its read gave. */
  shown: ShownTab;
  /** What the header knows of the game. */
  head: HeadGame;
  /** The game as the latest answer described it, for the Campaign links tab; null before any answer. */
  game: AnalyticsGame | null;
  /** The game's page on genex.games: shown without its scheme, copied whole. */
  gameUrl: string;
  /** The link was just copied. */
  copied: boolean;
  period: StatsPeriod;
  /** The options reports are asked with now. */
  options: GameReportOptions;
  /** Whose events the SDK tab asks for now. */
  origin: EventOrigin;
  /** The wall clock, for how long ago the numbers were computed and for every "ago" a tab writes. */
  now: number;
  actions: AnalyticsActions;
}

/** The game: its cover, title, link with Copy and who is playing now, over the facts about the numbers. */
function AnalyticsHead({
  head,
  gameUrl,
  copied,
  facts,
  onCopy,
}: {
  head: HeadGame;
  gameUrl: string;
  copied: boolean;
  facts: string[];
  onCopy: () => void;
}): JSX.Element {
  return (
    <header className="game-analytics-head">
      <div className="game-analytics-title-row">
        <span className="game-analytics-cover" aria-hidden="true">
          {head.coverUrl && <img src={head.coverUrl} alt="" draggable={false} />}
        </span>
        <h1 className="game-analytics-title">
          {head.title ? <span data-analytics-mask="">{head.title}</span> : PAGE_WORDS.title}
        </h1>
        {/* The link and its Copy, named by the title, are both kept out of usage replays. */}
        <span className="game-analytics-link" data-analytics-mask="">
          <span>{gameUrl.replace(SCHEME, "")}</span>
          <button
            type="button"
            className="game-analytics-copy"
            data-game-analytics-copy
            aria-label={head.title ? PLAY_WORDS.stats.copyLink(head.title) : PAGE_WORDS.copyLink}
            onClick={onCopy}
          >
            <Icon name={copied ? "check" : "copy"} size={14} />
            <span className="sr-only" role="status">
              {copied ? PLAY_WORDS.stats.linkCopied : ""}
            </span>
          </button>
        </span>
        {head.playingNow !== null && (
          <span className="game-analytics-live" data-game-analytics-live>
            <span className="stats-live-dot" data-off={head.playingNow === 0 || undefined} aria-hidden="true" />
            <span className="game-analytics-live-count">{formatStat(head.playingNow)}</span>
            <span>{PLAY_WORDS.stats.playingNow}</span>
          </span>
        )}
      </div>
      <p className="game-analytics-facts" data-game-analytics-facts>
        {facts.map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
      </p>
    </header>
  );
}

/**
 * The tabs: one row with one tab stop. The arrows move along it and choose, wrapping at the ends;
 * Home and End jump to them. Campaign links and SDK sit at the row's end (`data-side`).
 */
function AnalyticsTabs({
  tabs,
  tab,
  panel,
  tabId,
  onTab,
}: {
  tabs: AnalyticsTab[];
  tab: AnalyticsTab;
  /** The id of the panel the tabs control. */
  panel: string;
  tabId: (tab: AnalyticsTab) => string;
  onTab: (tab: AnalyticsTab) => void;
}): JSX.Element {
  const keys = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const target = rovingTarget(event.key, tabs.indexOf(tab), tabs.length, RovingAxis.Horizontal);
    const next = target === null ? undefined : tabs[target];
    if (next === undefined) return;
    event.preventDefault();
    onTab(next);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-game-analytics-tab="${next}"]`)?.focus();
  };
  return (
    <div className="game-analytics-tabs" role="tablist" aria-label={PAGE_WORDS.tabsLabel}>
      {tabs.map((one) => (
        <button
          key={one}
          type="button"
          role="tab"
          id={tabId(one)}
          className="game-analytics-tab"
          aria-selected={one === tab}
          aria-controls={panel}
          tabIndex={one === tab ? 0 : -1}
          data-game-analytics-tab={one}
          data-side={isSideTab(one) ? "" : undefined}
          onClick={() => onTab(one)}
          onKeyDown={keys}
        >
          {PAGE_WORDS.tabs[one]}
        </button>
      ))}
    </div>
  );
}

/** Try again: read what the tab shows once more. */
function Retry({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <Button variant="secondary" data-game-analytics-retry onClick={onRetry}>
      {PLAY_WORDS.retry}
    </Button>
  );
}

/** A tab on its way: blocks where its tiles and its chart will be. */
function Skeleton(): JSX.Element {
  return (
    <div className="stats-placeholder" role="status" aria-label={PAGE_WORDS.loading}>
      <div className="stats-tiles">
        {SKELETON_TILES.map((tile) => (
          <span key={tile} className="stats-tile stats-tile-placeholder" />
        ))}
      </div>
      <span className="stats-chart stats-chart-placeholder" />
    </div>
  );
}

/** A tab with nothing to draw: what its state says, and the way out when there is one. */
function NoData({
  kind,
  tab,
  actions,
}: {
  kind: Exclude<BodyKind, typeof BodyKind.Ready>;
  tab: AnalyticsTab;
  actions: AnalyticsActions;
}): JSX.Element {
  switch (kind) {
    case BodyKind.SignedOut:
      return <SignInNote text={PLAY_WORDS.stats.signedOut} />;
    case BodyKind.Loading:
      return <Skeleton />;
    case BodyKind.Offline:
      return <OfflineNotice text={PAGE_WORDS.offline} onRetry={actions.onRetry} />;
    case BodyKind.Failed:
      return (
        <div className="people-note">
          {PAGE_WORDS.failed}
          <Retry onRetry={actions.onRetry} />
        </div>
      );
    case BodyKind.Unavailable:
      return <p className="people-note">{PAGE_WORDS.unavailable}</p>;
    case BodyKind.NoGame:
      return <p className="people-note">{PAGE_WORDS.noGame}</p>;
    case BodyKind.NoReport:
      return (
        <div className="people-note">
          {noReportWords(tab)}
          <Button
            variant="secondary"
            data-game-analytics-go={AnalyticsTab.Overview}
            onClick={() => actions.onTab(AnalyticsTab.Overview)}
          >
            {PAGE_WORDS.openOverview}
          </Button>
        </div>
      );
  }
}

/**
 * A tab's body for its read: the state's face while there is nothing to draw, else what `children`
 * draws of the value, under a line saying so when reading it again failed.
 */
function TabState<Value>({
  tab,
  body,
  actions,
  children,
}: {
  tab: AnalyticsTab;
  body: Body<Value>;
  actions: AnalyticsActions;
  children: (value: Value, tabProps: Pick<TabProps, "refreshing" | "stale">) => ReactNode;
}): JSX.Element {
  if (body.kind !== BodyKind.Ready) return <NoData kind={body.kind} tab={tab} actions={actions} />;
  const { value, refreshing, stale } = body;
  return (
    <>
      {stale && (
        <div className="game-analytics-stale" role="status" data-game-analytics-stale>
          {PAGE_WORDS.stale}
          <Retry onRetry={actions.onRetry} />
        </div>
      )}
      {children(value, { refreshing, stale })}
    </>
  );
}

/** A report's answer, drawn by that report's component. */
function ReportTab({
  answer,
  tab,
  options,
  actions,
}: {
  answer: GameReportAnswer;
  tab: TabProps;
  options: GameReportOptions;
  actions: AnalyticsActions;
}): JSX.Element {
  const props = { ...tab, options, onOptions: actions.onOptions };
  switch (answer.report) {
    case GameReport.Overview:
      return <OverviewReport {...props} answer={answer} />;
    case GameReport.Acquisition:
      return <AcquisitionReport {...props} answer={answer} />;
    case GameReport.Retention:
      return <RetentionReport {...props} answer={answer} />;
    case GameReport.Engagement:
      return <EngagementReport {...props} answer={answer} />;
    case GameReport.Events:
      return (
        <EventsReport
          {...props}
          answer={answer}
          onSaveFunnel={actions.onSaveFunnel}
          onRemoveFunnel={actions.onRemoveFunnel}
        />
      );
    case GameReport.Revenue:
      return <RevenueReport {...props} answer={answer} />;
    case GameReport.Installs:
      return <InstallsReport {...props} answer={answer} />;
  }
}

/** What the tab shown draws in its panel. */
function TabBody(props: AnalyticsFaceProps): JSX.Element {
  const { slug, shown, game, gameUrl, period, options, origin, now, actions } = props;
  const common = (flags: Pick<TabProps, "refreshing" | "stale">): TabProps => ({
    slug,
    ...flags,
    now,
    onOpenTab: actions.onTab,
  });
  if (shown.tab === AnalyticsTab.Links)
    return (
      <TabState tab={shown.tab} body={shown.body} actions={actions}>
        {(links, flags) => (
          <LinksPage
            {...common(flags)}
            game={game}
            gameUrl={gameUrl}
            days={period}
            links={links}
            onSave={actions.onSaveLink}
            onRemove={actions.onRemoveLink}
          />
        )}
      </TabState>
    );
  if (shown.tab === AnalyticsTab.Sdk)
    return (
      <TabState tab={shown.tab} body={shown.body} actions={actions}>
        {(status, flags) => (
          <SdkPage {...common(flags)} game={status.game} status={status} origin={origin} onOrigin={actions.onOrigin} />
        )}
      </TabState>
    );
  return (
    <TabState tab={shown.tab} body={shown.body} actions={actions}>
      {(answer, flags) => <ReportTab answer={answer} tab={common(flags)} options={options} actions={actions} />}
    </TabState>
  );
}

/** A game's analytics page: the header, the tabs with the period switch, and the tab's panel. */
export function AnalyticsFace(props: AnalyticsFaceProps): JSX.Element {
  const { shown, head, gameUrl, copied, period, now, actions } = props;
  const id = useId();
  const panel = `${id}-panel`;
  const tabId = (tab: AnalyticsTab): string => `${id}-tab-${tab}`;
  const { body } = shown;
  const refreshing = body.kind === BodyKind.Ready && body.refreshing;
  return (
    <div className="game-analytics-page" data-game-analytics-page={shown.tab}>
      <AnalyticsHead
        head={head}
        gameUrl={gameUrl}
        copied={copied}
        facts={headFacts(shown, period, now)}
        onCopy={actions.onCopy}
      />
      <div className="game-analytics-bar">
        <AnalyticsTabs
          tabs={listedTabs(head.hasAppBuild, shown.tab)}
          tab={shown.tab}
          panel={panel}
          tabId={tabId}
          onTab={actions.onTab}
        />
        {/* The SDK tab's events are not counted over a period. */}
        {shown.tab !== AnalyticsTab.Sdk && (
          <PeriodSwitch period={period} onChange={actions.onPeriod} attribute={PERIOD_ATTRIBUTE} />
        )}
      </div>
      <div
        role="tabpanel"
        id={panel}
        aria-labelledby={tabId(shown.tab)}
        className="game-analytics-panel"
        data-game-analytics-state={body.kind}
        data-refreshing={refreshing || undefined}
        aria-busy={body.kind === BodyKind.Loading || refreshing || undefined}
      >
        <TabBody {...props} />
      </div>
    </div>
  );
}

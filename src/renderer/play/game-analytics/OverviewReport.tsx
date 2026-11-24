/**
 * Overview: the headline numbers and a first look at every other report. Eight tiles, each a
 * button that picks the number the chart under them shows per day against the period before, with
 * the campaign and version marks; what is worth a look, in sentences the app writes; where new
 * players came from; whether they come back; and how far new visitors get. Each block opens the
 * tab that has the rest. The shell mounts it only with an answer to draw (`report-props.ts`), and
 * everything it shows is derived in `overview-view.ts`.
 */
import type { JSX } from "react";
import { useState } from "react";
import { GameReport, OverviewMetric } from "../../../shared/game-analytics.ts";
import { Icon } from "../../ui/icons.tsx";
import {
  BarList,
  EmptyNote,
  Legend,
  LineChart,
  MetricTile,
  MetricTiles,
  MiniStats,
  ReportColumns,
  ReportSection,
} from "./kit/index.ts";
import {
  type OverviewChart,
  type OverviewFunnel,
  type OverviewInsight,
  type OverviewRetention,
  type OverviewView,
  overviewView,
} from "./overview-view.ts";
import { OVERVIEW_WORDS as WORDS } from "./overview-words.ts";
import { PAGE_WORDS } from "./page-words.ts";
import type { ReportProps } from "./report-props.ts";
import { AnalyticsTab } from "./tabs.ts";

/** The retention curve's height, in CSS pixels: a first look, shorter than the per-day chart. */
const CURVE_HEIGHT = 160;
/** The decimals of a funnel step's share of the first. */
const FUNNEL_SHARE_DIGITS = 1;

/** Opens another tab of the page. */
type OpenTab = (tab: AnalyticsTab) => void;

/** The link at the end of a block's head that opens the tab with the rest of it. */
function TabLink({ tab, onOpenTab }: { tab: AnalyticsTab; onOpenTab: OpenTab }): JSX.Element {
  return (
    <button
      type="button"
      className="game-analytics-overview-open"
      data-game-analytics-open={tab}
      onClick={() => onOpenTab(tab)}
    >
      {PAGE_WORDS.tabs[tab]}
    </button>
  );
}

/** The number picked, per day: this period's line over the dashed one of the period before. */
function DailyChart({ chart }: { chart: OverviewChart }): JSX.Element {
  return (
    <ReportSection id="daily" title={chart.title} controls={<Legend items={chart.legend} />}>
      {chart.empty ? (
        <EmptyNote>{WORDS.chartEmpty}</EmptyNote>
      ) : (
        <LineChart
          id="daily"
          label={chart.title}
          series={chart.series}
          labels={chart.labels}
          format={chart.format}
          axisFormat={chart.axisFormat}
          marks={chart.marks}
          legend={false}
          fill
        />
      )}
    </ReportSection>
  );
}

/** What is worth a look: each insight a row that opens the tab it is about. */
function WorthALook({ insights, onOpenTab }: { insights: readonly OverviewInsight[]; onOpenTab: OpenTab }) {
  return (
    <ReportSection id="insights" title={WORDS.insightsTitle}>
      <ul className="game-analytics-overview-insights">
        {insights.map((insight) => (
          <li key={insight.id}>
            <button
              type="button"
              className="game-analytics-overview-insight"
              data-game-analytics-insight={insight.kind}
              data-game-analytics-open={insight.tab}
              onClick={() => onOpenTab(insight.tab)}
            >
              <span className="game-analytics-overview-insight-area">{insight.area}</span>
              <span className="game-analytics-overview-insight-text" data-analytics-mask={insight.masked || undefined}>
                <span className="game-analytics-overview-insight-headline">{insight.headline}</span>
                <span className="game-analytics-overview-insight-detail">{insight.detail}</span>
              </span>
              <Icon name="chevron-right" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </ReportSection>
  );
}

/** Whether new players come back: Day 1, Day 7 and Day 30, over the curve against similar games. */
function ComeBack({ retention, onOpenTab }: { retention: OverviewRetention; onOpenTab: OpenTab }): JSX.Element {
  return (
    <ReportSection
      id="retention"
      title={WORDS.retentionTitle}
      controls={<TabLink tab={AnalyticsTab.Retention} onOpenTab={onOpenTab} />}
    >
      <div className="game-analytics-overview-comeback">
        <MiniStats items={retention.stats} />
        {!retention.empty && <Legend items={retention.legend} />}
      </div>
      {retention.empty ? (
        <EmptyNote>{WORDS.retentionEmpty}</EmptyNote>
      ) : (
        <LineChart
          id="retention"
          label={WORDS.retentionLabel}
          series={retention.series}
          labels={retention.labels}
          format={retention.format}
          axisFormat={retention.axisFormat}
          place={WORDS.daysSince}
          ticks={retention.ticks}
          height={CURVE_HEIGHT}
          legend={false}
        />
      )}
    </ReportSection>
  );
}

/** How far new visitors get: each step that came, with its share of everyone who opened the page. */
function StepByStep({ funnel, onOpenTab }: { funnel: OverviewFunnel | null; onOpenTab: OpenTab }): JSX.Element {
  return (
    <ReportSection
      id="funnel"
      title={WORDS.funnelTitle}
      controls={<TabLink tab={AnalyticsTab.Acquisition} onOpenTab={onOpenTab} />}
    >
      {funnel ? (
        <BarList
          id="funnel"
          label={WORDS.funnelLabel}
          items={funnel.items}
          total={funnel.total}
          shareDigits={FUNNEL_SHARE_DIGITS}
        />
      ) : (
        <EmptyNote>{WORDS.funnelEmpty}</EmptyNote>
      )}
    </ReportSection>
  );
}

/** What `OverviewFace` is given: the view to draw, and what its controls ask. */
export interface OverviewFaceProps {
  view: OverviewView;
  /** A tile was pressed: show its number on the chart. */
  onChoose: (metric: OverviewMetric) => void;
  onOpenTab: OpenTab;
}

/** The Overview drawn from its view alone: the number picked is the caller's to keep. */
export function OverviewFace({ view, onChoose, onOpenTab }: OverviewFaceProps): JSX.Element {
  if (view.empty) {
    return (
      <div className="game-analytics-report" data-game-analytics-report={GameReport.Overview}>
        <EmptyNote>{WORDS.empty}</EmptyNote>
      </div>
    );
  }
  return (
    <div className="game-analytics-report" data-game-analytics-report={GameReport.Overview}>
      {view.tiles.length > 0 && (
        <MetricTiles>
          {view.tiles.map((tile) => (
            <MetricTile
              key={tile.metric}
              id={tile.metric}
              label={tile.label}
              value={tile.value}
              delta={tile.delta}
              spark={tile.spark}
              pressed={tile.pressed}
              onPress={() => onChoose(tile.metric)}
            />
          ))}
        </MetricTiles>
      )}
      {view.chart && <DailyChart chart={view.chart} />}
      <ReportColumns>
        {view.insights.length > 0 && <WorthALook insights={view.insights} onOpenTab={onOpenTab} />}
        <ReportSection
          id="channels"
          title={WORDS.channelsTitle}
          controls={<TabLink tab={AnalyticsTab.Acquisition} onOpenTab={onOpenTab} />}
        >
          {view.channels.length > 0 ? (
            <BarList id="channels" label={WORDS.channelsLabel} items={view.channels} />
          ) : (
            <EmptyNote>{WORDS.channelsEmpty}</EmptyNote>
          )}
        </ReportSection>
      </ReportColumns>
      <ReportColumns>
        <ComeBack retention={view.retention} onOpenTab={onOpenTab} />
        <StepByStep funnel={view.funnel} onOpenTab={onOpenTab} />
      </ReportColumns>
    </div>
  );
}

/** The Overview report's body: it keeps which number the chart shows, Players until a tile is pressed. */
export function OverviewReport({ answer, onOpenTab }: ReportProps<typeof GameReport.Overview>): JSX.Element {
  const [chosen, setChosen] = useState<OverviewMetric>(OverviewMetric.Players);
  return <OverviewFace view={overviewView(answer, chosen)} onChoose={setChosen} onOpenTab={onOpenTab} />;
}

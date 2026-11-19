/**
 * The blocks the Acquisition tab is laid out in, each drawn from its part of `AcquisitionView`:
 * new players per day, the funnel from the game page to coming back, the sources and the
 * campaigns. The two tables keep their switches in the report's options, so a press asks genex.games
 * again; what a block draws is the answer's, whatever the switches say until the next answer lands.
 */
import type { JSX } from "react";
import {
  type Attribution,
  CampaignField,
  type GameReportOptions,
  type SourceBreakdown,
} from "../../../shared/game-analytics.ts";
import { Icon } from "../../ui/icons.tsx";
import { campaignColumns, sourceColumns } from "./acquisition-columns.ts";
import {
  ATTRIBUTION_OPTIONS,
  type AcquisitionChart,
  type AcquisitionRow,
  type AcquisitionTable,
  BREAKDOWN_OPTIONS,
  CAMPAIGN_OPTIONS,
} from "./acquisition-view.ts";
import { ACQUISITION_WORDS as WORDS } from "./acquisition-words.ts";
import {
  BarChart,
  type DataColumn,
  DataTable,
  EmptyNote,
  type FunnelStepItem,
  FunnelSteps,
  formatNumber,
  Legend,
  ReportSection,
  SegmentSwitch,
} from "./kit/index.ts";
import { AnalyticsTab } from "./tabs.ts";

/** What the sources table's switches show: the report's options as asked, which the table catches up with. */
export interface SourceSwitches {
  breakdown: SourceBreakdown;
  attribution: Attribution;
}

/** Opens another tab of the page. */
type OpenTab = (tab: AnalyticsTab) => void;

const rowId = (row: AcquisitionRow): string => row.id;
const partsOf = (row: AcquisitionRow): readonly AcquisitionRow[] => row.parts;
const writeCount = (value: number): string => formatNumber(value);

/** New players per day, stacked by the channel that first brought them, its legend at the head's end. */
export function DailySection({ chart }: { chart: AcquisitionChart | null }): JSX.Element {
  return (
    <ReportSection id="daily" title={WORDS.daily.title} controls={chart && <Legend items={chart.legend} />}>
      {chart ? (
        <BarChart
          id="daily"
          label={WORDS.daily.label}
          series={chart.series}
          labels={chart.labels}
          format={writeCount}
          marks={chart.marks}
          legend={false}
        />
      ) : (
        <EmptyNote>{WORDS.daily.empty}</EmptyNote>
      )}
    </ReportSection>
  );
}

/** How far new visitors get, step by step, from the game page to coming back. */
export function FunnelSection({ steps }: { steps: readonly FunnelStepItem[] | null }): JSX.Element {
  return (
    <ReportSection id="funnel" title={WORDS.funnel.title} hint={WORDS.funnel.hint}>
      {steps ? (
        <FunnelSteps id="funnel" label={WORDS.funnel.label} steps={steps} />
      ) : (
        <EmptyNote>{WORDS.funnel.empty}</EmptyNote>
      )}
    </ReportSection>
  );
}

/** A table of sources or campaigns: the rows, the total row when there is one, and the rows inside a row where there are some. */
function Table(props: {
  id: string;
  label: string;
  columns: readonly DataColumn<AcquisitionRow>[];
  table: AcquisitionTable;
}): JSX.Element {
  const { table } = props;
  return (
    <DataTable
      id={props.id}
      label={props.label}
      columns={props.columns}
      rows={table.rows}
      rowId={rowId}
      total={table.total ?? undefined}
      parts={partsOf}
      expanded={table.expanded}
    />
  );
}

/** What the sources block is given. */
export interface SourcesProps {
  /** The table the answer holds, and the breakdown and attribution it was made for. */
  table: AcquisitionTable | null;
  breakdown: SourceBreakdown;
  attribution: Attribution;
  /** What the switches show now. */
  asked: SourceSwitches;
  onOptions: (change: GameReportOptions) => void;
}

/** The sources: split by channel, referrer, country or device, and credited to a player's first source or their latest. */
export function SourcesSection({ table, breakdown, attribution, asked, onOptions }: SourcesProps): JSX.Element {
  return (
    <ReportSection
      id="sources"
      title={WORDS.sources.title}
      controls={
        <div className="game-analytics-acquisition-controls">
          <SegmentSwitch
            id="breakdown"
            label={WORDS.sources.breakdownLabel}
            options={BREAKDOWN_OPTIONS}
            value={asked.breakdown}
            onChange={(value) => onOptions({ breakdown: value })}
          />
          <SegmentSwitch
            id="attribution"
            label={WORDS.sources.attributionLabel}
            options={ATTRIBUTION_OPTIONS}
            value={asked.attribution}
            onChange={(value) => onOptions({ attribution: value })}
          />
        </div>
      }
      footnote={table && WORDS.sources.credit[attribution]}
    >
      {table ? (
        // A new breakdown is a new table: the rows that start open start so again.
        <Table
          key={breakdown}
          id="sources"
          label={WORDS.sources.label}
          columns={sourceColumns(breakdown)}
          table={table}
        />
      ) : (
        <EmptyNote>{WORDS.sources.empty}</EmptyNote>
      )}
    </ReportSection>
  );
}

/** The action that opens the Campaign links tab, where a link with utm_ tags is made. */
function NewLink({ onOpenTab }: { onOpenTab: OpenTab }): JSX.Element {
  return (
    <button
      type="button"
      className="game-analytics-acquisition-action"
      data-game-analytics-open={AnalyticsTab.Links}
      onClick={() => onOpenTab(AnalyticsTab.Links)}
    >
      <Icon name="plus" size={14} />
      {WORDS.campaigns.newLink}
    </button>
  );
}

/** What the campaigns block says when no campaign brought anybody under its tag: what a link is, and where to make one. */
function NoCampaigns({ by, onOpenTab }: { by: CampaignField; onOpenTab: OpenTab }): JSX.Element {
  const tag = CAMPAIGN_OPTIONS.find((option) => option.value === by)?.label ?? by;
  return (
    <div className="game-analytics-acquisition-none" data-game-analytics-campaigns-empty="true">
      <EmptyNote>{by === CampaignField.Campaign ? WORDS.campaigns.none : WORDS.campaigns.noneWith(tag)}</EmptyNote>
      <p className="game-analytics-acquisition-explain">{WORDS.campaigns.whatIsLink}</p>
      <NewLink onOpenTab={onOpenTab} />
    </div>
  );
}

/** What the campaigns block is given. */
export interface CampaignsProps {
  /** The table the answer holds, and the tag it is grouped by. */
  table: AcquisitionTable | null;
  campaignBy: CampaignField;
  /** What the switch shows now. */
  asked: CampaignField;
  onOptions: (change: GameReportOptions) => void;
  onOpenTab: OpenTab;
}

/** The campaigns: one row for each value of a utm_ tag, and where to make a new link. */
export function CampaignsSection({ table, campaignBy, asked, onOptions, onOpenTab }: CampaignsProps): JSX.Element {
  return (
    <ReportSection
      id="campaigns"
      title={WORDS.campaigns.title}
      controls={
        <div className="game-analytics-acquisition-controls">
          <SegmentSwitch
            id="campaign-by"
            label={WORDS.campaigns.groupLabel}
            options={CAMPAIGN_OPTIONS}
            value={asked}
            onChange={(value) => onOptions({ campaignBy: value })}
          />
          {table && <NewLink onOpenTab={onOpenTab} />}
        </div>
      }
      footnote={table && WORDS.campaigns.keeps}
    >
      {table ? (
        <Table id="campaigns" label={WORDS.campaigns.label} columns={campaignColumns(campaignBy)} table={table} />
      ) : (
        <NoCampaigns by={campaignBy} onOpenTab={onOpenTab} />
      )}
    </ReportSection>
  );
}

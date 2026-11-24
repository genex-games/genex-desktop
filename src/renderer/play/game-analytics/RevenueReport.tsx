/**
 * Revenue: the Nex players spend in the game. Four tiles; the Nex of each day as bars; what players
 * buy, in a table with each item's share of all Nex; what a new player spends over time, with the
 * day of the first purchase; and which sources bring players who pay. A game where nothing was
 * bought shows the tiles and one note in place of the empty blocks. The shell mounts it only with
 * an answer to draw (`report-props.ts`), and everything it shows is derived in `revenue-view.ts`.
 */
import type { JSX } from "react";
import { GameReport } from "../../../shared/game-analytics.ts";
import {
  BarChart,
  DataTable,
  EmptyNote,
  formatNexAmount,
  LineChart,
  MetricTile,
  MetricTiles,
  MiniStats,
  ReportColumns,
  ReportSection,
} from "./kit/index.ts";
import type { ReportProps } from "./report-props.ts";
import { ITEM_COLUMNS, SOURCE_COLUMNS } from "./revenue-columns.ts";
import { type ItemRow, type RevenueView, revenueView, type SourceRow } from "./revenue-view.ts";
import { REVENUE_WORDS as WORDS } from "./revenue-words.ts";

/** The spending curve's height, in CSS pixels: shorter than the per-day bars it stands beside. */
const CURVE_HEIGHT = 170;

const itemId = (row: ItemRow): string => row.id;
const sourceId = (row: SourceRow): string => row.id;

/** The Nex of each day, as bars over the period. */
function DailySection({ daily }: { daily: RevenueView["daily"] }): JSX.Element {
  return (
    <ReportSection id="daily" title={WORDS.daily.title}>
      <BarChart
        id="nexPerDay"
        label={WORDS.daily.title}
        series={daily.series}
        labels={daily.labels}
        format={formatNexAmount}
        legend={false}
      />
    </ReportSection>
  );
}

/** What players buy: every item with its price, sales and share of the Nex, and all of them in a last row. */
function ItemsSection({ items }: { items: RevenueView["items"] }): JSX.Element {
  return (
    <ReportSection id="items" title={WORDS.items.title}>
      <DataTable
        id="items"
        label={WORDS.items.table}
        columns={ITEM_COLUMNS}
        rows={items.rows}
        rowId={itemId}
        total={items.total}
        empty={WORDS.items.empty}
      />
    </ReportSection>
  );
}

/** What a new player has spent by each day since their first play: the small numbers, then the curve. */
function SpendSection({ spend }: { spend: RevenueView["spend"] }): JSX.Element {
  return (
    <ReportSection id="spend" title={WORDS.spend.title}>
      {spend.known ? (
        <>
          <MiniStats items={spend.stats} />
          <LineChart
            id="spend"
            label={WORDS.spend.chart}
            series={spend.series}
            labels={spend.labels}
            format={formatNexAmount}
            place={WORDS.spend.place}
            ticks={spend.ticks}
            height={CURVE_HEIGHT}
            legend={false}
          />
        </>
      ) : (
        <EmptyNote>{spend.empty}</EmptyNote>
      )}
    </ReportSection>
  );
}

/** The first channel that brought each player, with how many of them pay and what they spend. */
function SourcesSection({ sources }: { sources: RevenueView["sources"] }): JSX.Element {
  return (
    <ReportSection id="sources" title={WORDS.sources.title} hint={WORDS.sources.hint} footnote={WORDS.sources.footnote}>
      <DataTable
        id="sources"
        label={WORDS.sources.table}
        columns={SOURCE_COLUMNS}
        rows={sources.rows}
        rowId={sourceId}
        total={sources.total}
        empty={WORDS.sources.empty}
      />
    </ReportSection>
  );
}

/** The Revenue report drawn from its view alone. */
export function RevenueFace({ view }: { view: RevenueView }): JSX.Element {
  return (
    <div className="game-analytics-report" data-game-analytics-report={GameReport.Revenue}>
      <MetricTiles>
        {view.tiles.map((tile) => (
          <MetricTile key={tile.id} {...tile} />
        ))}
      </MetricTiles>
      {view.nothingBought ? (
        <EmptyNote>{view.nothing}</EmptyNote>
      ) : (
        <>
          <DailySection daily={view.daily} />
          <ReportColumns>
            <ItemsSection items={view.items} />
            <SpendSection spend={view.spend} />
          </ReportColumns>
          <SourcesSection sources={view.sources} />
        </>
      )}
    </div>
  );
}

/** The Revenue report's body. */
export function RevenueReport({ answer }: ReportProps<typeof GameReport.Revenue>): JSX.Element {
  return <RevenueFace view={revenueView(answer)} />;
}

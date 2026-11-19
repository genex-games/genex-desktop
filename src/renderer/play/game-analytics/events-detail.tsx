/**
 * One event in full: its name, what it is for and when it was first seen; four numbers; its count
 * per day; the values it carries under one property, picked with a switch; and a table of what
 * arrived in each property. The names are the game's own words, so they are kept out of usage
 * recordings wherever they sit.
 */
import type { JSX } from "react";
import { useId } from "react";
import type { EventDetailView, EventSplit, PropertyRow } from "./events-view.ts";
import { EVENTS_WORDS as WORDS } from "./events-words.ts";
import {
  BarList,
  ColumnKind,
  type DataColumn,
  DataTable,
  EmptyNote,
  formatNumber,
  LineChart,
  MetricTile,
  MetricTiles,
  SegmentSwitch,
} from "./kit/index.ts";

/** The per-day line's height, in CSS pixels: shorter than a report's main chart. */
const DAILY_HEIGHT = 160;

const PROPERTY_COLUMNS: DataColumn<PropertyRow>[] = [
  {
    id: "property",
    label: WORDS.properties.property,
    kind: ColumnKind.Text,
    value: (row) => row.name,
    mono: true,
    mask: true,
    width: "minmax(112px, 1fr)",
  },
  {
    id: "kind",
    label: WORDS.properties.kind,
    kind: ColumnKind.Text,
    value: (row) => row.kind,
    quiet: true,
    width: "minmax(96px, 0.7fr)",
  },
  {
    id: "arrived",
    label: WORDS.properties.arrived,
    kind: ColumnKind.Text,
    value: (row) => row.arrived,
    mask: true,
    width: "minmax(200px, 3fr)",
  },
];

/** The values of the event under one property, as bars, with the switch that picks the property. */
function SplitBlock({ split, onSplit }: { split: EventSplit; onSplit: (property: string) => void }): JSX.Element {
  return (
    <div className="game-analytics-events-block" data-game-analytics-events-split={split.property}>
      <div className="game-analytics-events-blockhead">
        <h3 className="game-analytics-events-subtitle">{WORDS.split.title}</h3>
        <SegmentSwitch
          id="split"
          label={WORDS.split.switchLabel}
          options={split.options}
          value={split.property}
          onChange={onSplit}
        />
      </div>
      {split.items.length > 0 ? (
        <BarList id="split" label={split.label} items={split.items} total={split.total} format={formatNumber} mask />
      ) : (
        <EmptyNote>{WORDS.split.empty}</EmptyNote>
      )}
    </div>
  );
}

/** What `EventDetail` is given. */
export interface EventDetailProps {
  detail: EventDetailView;
  /** The property to split by was picked. */
  onSplit: (property: string) => void;
}

/** One event in full. */
export function EventDetail({ detail, onSplit }: EventDetailProps): JSX.Element {
  const heading = useId();
  return (
    <section
      className="game-analytics-section game-analytics-events-detail"
      data-game-analytics-section="detail"
      data-game-analytics-event={detail.name}
      aria-labelledby={heading}
    >
      <header className="game-analytics-events-head">
        <h2 id={heading} className="game-analytics-events-name" data-analytics-mask>
          {detail.name}
        </h2>
        {(detail.note || detail.firstSeen) && (
          <p className="game-analytics-events-note">
            {detail.note && <span>{detail.note}</span>}
            {detail.firstSeen && <span>{detail.firstSeen}</span>}
          </p>
        )}
      </header>
      <MetricTiles>
        {detail.tiles.map((tile) => (
          <MetricTile
            key={tile.id}
            id={tile.id}
            label={tile.label}
            value={tile.value}
            delta={tile.delta}
            note={tile.note}
          />
        ))}
      </MetricTiles>
      <div className="game-analytics-events-block">
        <h3 className="game-analytics-events-subtitle">{WORDS.detail.perDay}</h3>
        <LineChart
          id="events-daily"
          label={WORDS.detail.perDayLabel(detail.name)}
          series={detail.series}
          labels={detail.labels}
          format={formatNumber}
          height={DAILY_HEIGHT}
          legend={false}
          fill
        />
      </div>
      {detail.split && <SplitBlock split={detail.split} onSplit={onSplit} />}
      <div className="game-analytics-events-block">
        <h3 className="game-analytics-events-subtitle">{WORDS.properties.title}</h3>
        <DataTable
          id="event-properties"
          label={WORDS.properties.label(detail.name)}
          columns={PROPERTY_COLUMNS}
          rows={detail.properties}
          rowId={(row) => row.name}
          empty={WORDS.properties.none}
        />
      </div>
    </section>
  );
}

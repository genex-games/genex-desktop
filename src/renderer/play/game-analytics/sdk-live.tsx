/**
 * The two blocks of the SDK tab that follow the game as it runs: the events arriving now, from the
 * published game or from Studio's preview, and the events genex.games dropped over the last day.
 * Both draw what the view model made of the status; the origin shown is the shell's.
 */
import type { JSX } from "react";
import { EventOrigin, type EventsStatus } from "../../../shared/game-analytics.ts";
import { ColumnKind, type DataColumn, DataTable, EmptyNote, ReportSection, SegmentSwitch } from "./kit/index.ts";
import { type DroppedLine, droppedLines, type EventLine, eventLines, liveEmpty } from "./sdk-view.ts";
import { SDK_WORDS as WORDS } from "./sdk-words.ts";

// Narrow enough that the four columns fit the column the table sits in, wide enough for the longest
// "ago" of a language ("59 сек. назад", "US · computer").
const WHEN_TRACK = "100px";
const NAME_TRACK = "minmax(96px, 0.9fr)";
const PROPERTIES_TRACK = "minmax(128px, 2fr)";
const PLAYER_TRACK = "104px";

const ORIGIN_OPTIONS = [
  { value: EventOrigin.Published, label: WORDS.live.origins[EventOrigin.Published] },
  { value: EventOrigin.Preview, label: WORDS.live.origins[EventOrigin.Preview] },
] as const;

/** An event's name; one Genex counts itself is set quieter than the game's own. */
function NameCell({ line }: { line: EventLine }): JSX.Element {
  return (
    <span className="game-analytics-sdk-event-name" data-automatic={line.automatic || undefined}>
      {line.name}
    </span>
  );
}

/** An event's properties as name and value pairs, a dot between two; a dash when it has none. */
function PropertiesCell({ line }: { line: EventLine }): JSX.Element {
  if (line.properties.length === 0) return <span className="game-analytics-sdk-none">{WORDS.live.noProperties}</span>;
  return (
    <span className="game-analytics-sdk-properties" title={line.summary}>
      {line.properties.map((property) => (
        <span key={property.name} className="game-analytics-sdk-property">
          <span className="game-analytics-sdk-property-name">{property.name}</span> {property.value}
        </span>
      ))}
    </span>
  );
}

const COLUMNS: DataColumn<EventLine>[] = [
  {
    id: "when",
    label: WORDS.live.columns.when,
    kind: ColumnKind.Text,
    value: (line) => line.ago,
    quiet: true,
    mono: true,
    width: WHEN_TRACK,
  },
  {
    id: "name",
    label: WORDS.live.columns.name,
    kind: ColumnKind.Text,
    value: (line) => line.name,
    mono: true,
    width: NAME_TRACK,
    cell: (line) => <NameCell line={line} />,
  },
  {
    id: "properties",
    label: WORDS.live.columns.properties,
    kind: ColumnKind.Text,
    value: () => null,
    mono: true,
    width: PROPERTIES_TRACK,
    cell: (line) => <PropertiesCell line={line} />,
  },
  {
    id: "player",
    label: WORDS.live.columns.player,
    kind: ColumnKind.Text,
    value: (line) => line.player,
    quiet: true,
    numeric: true,
    mask: true,
    width: PLAYER_TRACK,
  },
];

/** Events arriving now: the origin switch and the newest events, or why there are none. */
export function LiveEvents({
  status,
  origin,
  now,
  onOrigin,
}: {
  status: EventsStatus;
  origin: EventOrigin;
  now: number;
  onOrigin: (origin: EventOrigin) => void;
}): JSX.Element {
  return (
    <ReportSection
      id="live"
      title={WORDS.live.title}
      controls={
        <SegmentSwitch
          id="origin"
          label={WORDS.live.originLabel}
          options={ORIGIN_OPTIONS}
          value={origin}
          onChange={onOrigin}
        />
      }
      footnote={WORDS.live.previewNote}
    >
      <DataTable
        id="events"
        label={WORDS.live.tableLabel}
        columns={COLUMNS}
        rows={eventLines(status.recent, now)}
        rowId={(line) => line.id}
        empty={liveEmpty(origin, status.lastAt, now)}
      />
    </ReportSection>
  );
}

/** One dropped event: its name as the game sent it over what to send instead, and how many, and when last. */
function DroppedRow({ line }: { line: DroppedLine }): JSX.Element {
  return (
    <li className="game-analytics-sdk-dropped-row" data-game-analytics-dropped={line.id}>
      <span className="game-analytics-sdk-dropped-words">
        <span className="game-analytics-sdk-dropped-name">{line.name}</span>
        <span className="game-analytics-sdk-dropped-sentence">{line.sentence}</span>
      </span>
      <span className="game-analytics-sdk-dropped-count">
        <span>{line.count}</span>
        <span className="game-analytics-sdk-dropped-last">{line.last}</span>
      </span>
    </li>
  );
}

/** Dropped in the last 24 hours: each name as sent with what to send instead, or one line saying nothing was. */
export function DroppedEvents({ status, now }: { status: EventsStatus; now: number }): JSX.Element {
  const lines = droppedLines(status.dropped, status.limits, now);
  return (
    <ReportSection id="dropped" title={WORDS.dropped.title}>
      {lines.length === 0 ? (
        <EmptyNote>{WORDS.dropped.none}</EmptyNote>
      ) : (
        <ul className="game-analytics-sdk-dropped" aria-label={WORDS.dropped.listLabel}>
          {lines.map((line) => (
            <DroppedRow key={line.id} line={line} />
          ))}
        </ul>
      )}
    </ReportSection>
  );
}

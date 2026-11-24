/**
 * A report's table: typed columns (text, a count, a rate, a length of time, Nex, a share bar),
 * numbers lined up at the end of their column in tabular figures, an optional total row, rows that
 * open to show the rows inside them (one level), and rows that can be picked. Long text is cut
 * short with the whole of it a hover away. A number that is not known is a dash, never zero.
 */
import type { JSX, ReactNode } from "react";
import { Fragment, useState } from "react";
import { Icon } from "../../../ui/icons.tsx";
import { cssVars } from "./css.ts";
import { DASH, formatDuration, formatNexAmount, formatNumber, formatPercent } from "./format.ts";
import { EmptyNote } from "./ReportSection.tsx";
import { KIT_WORDS } from "./words.ts";

/** What a column holds, which decides how its cells are written and aligned. */
export const ColumnKind = {
  /** Words: read from the start, cut short when long. */
  Text: "text",
  /** A count or a decimal: `digits` decimals, none by default. */
  Number: "number",
  /** A fraction from 0 to 1, written as a percentage: `digits` decimals, one by default. */
  Rate: "rate",
  /** Seconds, written the short way: "5m 40s". */
  Duration: "duration",
  /** An amount of Nex, bare: the heading carries the unit. */
  Nex: "nex",
  /** A share from 0 to 1 drawn as a bar; a picture of a number another column writes. */
  Bar: "bar",
} as const;
export type ColumnKind = (typeof ColumnKind)[keyof typeof ColumnKind];

/** A column of a table over rows of type `Row`. */
export interface DataColumn<Row> {
  id: string;
  /** The column's heading; may be empty for a Bar column. */
  label: string;
  kind: ColumnKind;
  /** The cell's value: text for a Text column, a number for the others; null when it is not known. */
  value: (row: Row) => string | number | null;
  /** Decimals of a Number or a Rate. */
  digits?: number;
  /** Writes a number instead of the kind's own way (`formatSeconds` for a load time). */
  format?: (value: number) => string;
  /** A second, quiet line under a Text cell (a campaign's source and medium). */
  detail?: (row: Row) => string | null;
  /** A word after a number that flags it ("slow", "low"), so the flag is not told by colour. */
  flag?: (row: Row) => string | null;
  /** Secondary ink, for a column that supports the ones beside it. */
  quiet?: boolean;
  /** The code face, for names a game writes (events, properties, campaign tags). */
  mono?: boolean;
  /** The text is the creator's own words: kept out of usage recordings. */
  mask?: boolean;
  /** The column's track in the grid (`minmax(190px, 1fr)`); by its kind when left out. */
  width?: string;
  /**
   * A Text column whose cells are numbers the report wrote itself (a table turned on its side, each
   * row a different measure): lined up at the end, in tabular figures, like the numbers they are.
   */
  numeric?: boolean;
  /** Draws the cell itself in place of the value (a copy button, a mark); `value` may then return null. */
  cell?: (row: Row) => ReactNode;
}

/** What a table shows. */
export interface DataTableProps<Row> {
  /** Names the table in `data-game-analytics-table`; each row carries its id in `data-game-analytics-row`. */
  id: string;
  /** The table's caption, for assistive technology. */
  label: string;
  columns: readonly DataColumn<Row>[];
  rows: readonly Row[];
  rowId: (row: Row) => string;
  /** A last row that sums the others; a value it does not have (null) stays empty. */
  total?: Row;
  /** The rows inside a row, one level deep; a row with some gets a button that opens it, and the others room for one. */
  parts?: (row: Row) => readonly Row[];
  /** The ids of the rows that start open. */
  expanded?: readonly string[];
  /** With `onSelect` a row's first cell is a button that picks the row; `selectedId` marks the one picked. */
  onSelect?: (row: Row) => void;
  selectedId?: string | null;
  /** What to say in place of the table when it has no rows. */
  empty?: ReactNode;
}

const FIRST_TEXT_TRACK = "minmax(160px, 1.6fr)";
const TEXT_TRACK = "minmax(120px, 1fr)";
const NUMBER_TRACK = "minmax(72px, 0.7fr)";
const BAR_TRACK = "minmax(72px, 1fr)";

/** Whether a column's cells line up at the end, as numbers do. */
function isNumeric<Row>(column: DataColumn<Row>): boolean {
  if (column.kind === ColumnKind.Text) return column.numeric === true;
  return column.kind !== ColumnKind.Bar;
}

/** What a cell holds: the column's own drawing, words, or a value in its kind's writing. */
function cellOf<Row>(column: DataColumn<Row>, state: RowState<Row>, first: boolean): ReactNode {
  if (column.cell) return column.cell(state.row);
  if (column.kind === ColumnKind.Text) return <TextCell column={column} state={state} first={first} />;
  return <ValueCell column={column} state={state} />;
}

/** A column's track when it names none. */
function trackOf<Row>(column: DataColumn<Row>, index: number): string {
  if (column.width) return column.width;
  if (column.kind === ColumnKind.Bar) return BAR_TRACK;
  if (column.kind !== ColumnKind.Text) return NUMBER_TRACK;
  return index === 0 ? FIRST_TEXT_TRACK : TEXT_TRACK;
}

/** A number as its column's kind writes it. */
function written<Row>(column: DataColumn<Row>, value: number): string {
  if (column.format) return column.format(value);
  if (column.kind === ColumnKind.Rate) return formatPercent(value, column.digits);
  if (column.kind === ColumnKind.Duration) return formatDuration(value);
  if (column.kind === ColumnKind.Nex) return formatNexAmount(value);
  return formatNumber(value, column.digits);
}

/** The button before the first words of a row with rows inside it: whether it is open, and how to flip it. */
type Lead = { open: boolean; toggle: () => void } | null;

/** How a row stands in its table. */
interface RowState<Row> {
  row: Row;
  id: string;
  lead: Lead;
  /** Room for a button it does not have, so its first words line up with those of the rows that open. */
  space: boolean;
  part: boolean;
  total: boolean;
  selected: boolean;
  onSelect?: (row: Row) => void;
}

/** A Text cell: its words cut short with the whole a hover away, a quiet second line, and the row's controls. */
function TextCell<Row>({ column, state, first }: { column: DataColumn<Row>; state: RowState<Row>; first: boolean }) {
  const value = column.value(state.row);
  const text = value === null ? "" : String(value);
  const detail = column.detail?.(state.row) ?? null;
  const words = (
    <span className="game-analytics-cell-text" title={text} data-analytics-mask={column.mask || undefined}>
      {text}
    </span>
  );
  const pick = first ? state.onSelect : undefined;
  return (
    <>
      {first && state.lead && (
        <button
          type="button"
          className="game-analytics-expander"
          aria-expanded={state.lead.open}
          aria-label={state.lead.open ? KIT_WORDS.hideParts(text) : KIT_WORDS.showParts(text)}
          data-game-analytics-expand={state.id}
          onClick={state.lead.toggle}
        >
          <Icon name={state.lead.open ? "chevron-down" : "chevron-right"} size={12} />
        </button>
      )}
      {first && state.space && <span className="game-analytics-expander-space" aria-hidden="true" />}
      <span className="game-analytics-cell-words">
        {pick ? (
          <button
            type="button"
            className="game-analytics-cell-pick"
            aria-pressed={state.selected}
            data-game-analytics-pick={state.id}
            onClick={() => pick(state.row)}
          >
            {words}
          </button>
        ) : (
          words
        )}
        {detail && <span className="game-analytics-cell-detail">{detail}</span>}
      </span>
    </>
  );
}

/** A cell that is not text: a number in its kind's writing, a share bar, a dash for a number not known. */
function ValueCell<Row>({ column, state }: { column: DataColumn<Row>; state: RowState<Row> }): ReactNode {
  const value = column.value(state.row);
  const flag = column.flag?.(state.row) ?? null;
  if (typeof value !== "number" || !Number.isFinite(value))
    return state.total || column.kind === ColumnKind.Bar ? null : DASH;
  if (column.kind === ColumnKind.Bar) {
    return (
      <span className="game-analytics-track" aria-hidden="true">
        <span
          className="game-analytics-track-fill"
          style={cssVars({ "--game-analytics-share": Math.min(1, Math.max(0, value)) })}
        />
      </span>
    );
  }
  // The space keeps the word apart from the number when it is read or copied, not only on screen.
  return (
    <>
      {written(column, value)}
      {flag && (
        <>
          {" "}
          <span className="game-analytics-cell-flag">{flag}</span>
        </>
      )}
    </>
  );
}

/** One row of the table. */
function TableRow<Row>({ columns, state }: { columns: readonly DataColumn<Row>[]; state: RowState<Row> }) {
  return (
    <div
      role="row"
      className="game-analytics-row"
      data-game-analytics-row={state.id}
      data-part={state.part || undefined}
      data-total={state.total || undefined}
      data-selected={state.selected || undefined}
    >
      {columns.map((column, index) => (
        <span
          key={column.id}
          role="cell"
          className="game-analytics-cell"
          data-kind={column.kind}
          data-align={isNumeric(column) ? "end" : "start"}
          data-quiet={column.quiet || undefined}
          data-mono={column.mono || undefined}
        >
          {cellOf(column, state, index === 0)}
        </span>
      ))}
    </div>
  );
}

/** A table; see `DataTableProps` for each prop and `DataColumn` for a column. */
export function DataTable<Row>(props: DataTableProps<Row>): JSX.Element {
  const { columns, rows, rowId, parts, onSelect } = props;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(props.expanded ?? []));
  if (rows.length === 0 && props.empty) return <EmptyNote>{props.empty}</EmptyNote>;
  const toggle = (id: string): void =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const stateOf = (row: Row, over: Partial<RowState<Row>> = {}): RowState<Row> => {
    const id = rowId(row);
    const selected = id === props.selectedId;
    return { row, id, lead: null, space: false, part: false, total: false, selected, onSelect, ...over };
  };
  // Once any row opens, a row with nothing inside makes room for the button it lacks.
  const opens = parts !== undefined && rows.some((row) => parts(row).length > 0);
  return (
    <div className="game-analytics-scroll">
      <div
        role="table"
        aria-label={props.label}
        className="game-analytics-table"
        data-game-analytics-table={props.id}
        style={cssVars({ "--game-analytics-columns": columns.map(trackOf).join(" ") })}
      >
        <div role="row" className="game-analytics-row game-analytics-row-head">
          {columns.map((column) => (
            <span key={column.id} role="columnheader" data-align={isNumeric(column) ? "end" : "start"}>
              {column.label}
            </span>
          ))}
        </div>
        {rows.map((row) => {
          const id = rowId(row);
          const inside = parts?.(row) ?? [];
          const lead = inside.length > 0 ? { open: open.has(id), toggle: () => toggle(id) } : null;
          return (
            <Fragment key={id}>
              <TableRow columns={columns} state={stateOf(row, { lead, space: opens && lead === null })} />
              {lead?.open &&
                inside.map((part) => (
                  <TableRow key={rowId(part)} columns={columns} state={stateOf(part, { part: true })} />
                ))}
            </Fragment>
          );
        })}
        {props.total && (
          <TableRow
            columns={columns}
            state={stateOf(props.total, { total: true, selected: false, onSelect: undefined })}
          />
        )}
      </div>
    </div>
  );
}

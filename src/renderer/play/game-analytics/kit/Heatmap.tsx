/**
 * Two tables whose cells are tinted by their value: a heatmap (weekday by hour) and the retention
 * triangle of cohorts. Both are real tables with the number written in every cell, so the tint
 * only repeats what the text says; a value that is missing leaves its cell empty and bare.
 */
import type { JSX } from "react";
import { cssVars } from "./css.ts";
import { formatNumber, formatPercent } from "./format.ts";
import { heatLevel } from "./geometry.ts";

/** A tinted cell: its number, or nothing at all for a missing one. */
function HeatCell({ value, max, format }: { value: number | null; max: number; format: (value: number) => string }) {
  const level = heatLevel(value, max);
  if (value === null || level === null) return <td className="game-analytics-heat" data-empty="true" />;
  return (
    <td className="game-analytics-heat" style={cssVars({ "--game-analytics-heat": level })}>
      {format(value)}
    </td>
  );
}

/** The largest number among rows of cells; 0 with none. */
const largest = (rows: readonly (readonly (number | null)[])[]): number =>
  Math.max(0, ...rows.flat().filter((value): value is number => value !== null && Number.isFinite(value)));

/**
 * A grid of numbers tinted by how large each is. Props: `id` names it in
 * `data-game-analytics-heatmap`; `label` is its caption, for assistive technology; `columns` are
 * the column headings and `corner` names the row headings' column (read, not shown); `rows` each
 * have an `id`, a `label` and one cell per column, null for a missing value (`weekRows(hours)`
 * cuts a week of hours into them); `format` writes a cell (`formatCompact` keeps it short);
 * `scale` adds the "fewer … more" key under the table.
 */
export function Heatmap({
  id,
  label,
  corner,
  columns,
  rows,
  format,
  scale,
}: {
  id: string;
  label: string;
  corner: string;
  columns: readonly string[];
  rows: readonly { id: string; label: string; cells: readonly (number | null)[] }[];
  format: (value: number) => string;
  scale?: { low: string; high: string };
}): JSX.Element {
  const max = largest(rows.map((row) => row.cells));
  return (
    <>
      <div className="game-analytics-scroll">
        <table className="game-analytics-heatmap" data-game-analytics-heatmap={id}>
          <caption className="sr-only">{label}</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">{corner}</span>
              </th>
              {columns.map((column) => (
                <th key={column} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.label}</th>
                {columns.map((column, index) => (
                  <HeatCell key={column} value={row.cells[index] ?? null} max={max} format={format} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {scale && (
        <p className="game-analytics-heat-scale" aria-hidden="true">
          {scale.low}
          <span className="game-analytics-heat-steps">
            <span data-step="1" />
            <span data-step="2" />
            <span data-step="3" />
            <span data-step="4" />
          </span>
          {scale.high}
        </p>
      )}
    </>
  );
}

/**
 * One row of the cohort table: the players who first played on a day or in a week. `size` is how
 * many they are; `rates[n]` the share who played again n+1 days (or weeks) later, null for one that
 * has not passed; `flag` says in words what stands out about the cohort (the campaign that brought
 * most of it); `summary` marks the row that sums the others.
 */
export interface CohortRow {
  id: string;
  label: string;
  size: number;
  rates: readonly (number | null)[];
  flag?: string | null;
  summary?: boolean;
}

/**
 * The retention triangle. Props: `id` names it in `data-game-analytics-cohorts`; `label` is its
 * caption, for assistive technology; `firstColumn` and `sizeColumn` head the cohort's name and its
 * size; `columns` head the days ("Day 1", …); `cohorts` are the rows, oldest first; `format` writes
 * a rate (a percentage with one decimal when left out).
 */
export function CohortTable({
  id,
  label,
  firstColumn,
  sizeColumn,
  columns,
  cohorts,
  format = formatPercent,
}: {
  id: string;
  label: string;
  firstColumn: string;
  sizeColumn: string;
  columns: readonly string[];
  cohorts: readonly CohortRow[];
  format?: (rate: number) => string;
}): JSX.Element {
  const max = largest(cohorts.map((cohort) => cohort.rates));
  return (
    <div className="game-analytics-scroll">
      <table className="game-analytics-cohorts" data-game-analytics-cohorts={id}>
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr>
            <th scope="col">{firstColumn}</th>
            <th scope="col" data-align="end">
              {sizeColumn}
            </th>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((cohort) => (
            <tr key={cohort.id} data-game-analytics-cohort={cohort.id} data-summary={cohort.summary || undefined}>
              <th scope="row">
                {cohort.label}
                {cohort.flag && (
                  <span className="game-analytics-flag" role="img" aria-label={cohort.flag} title={cohort.flag} />
                )}
              </th>
              <td className="game-analytics-cohort-size">{formatNumber(cohort.size)}</td>
              {columns.map((column, index) => (
                <HeatCell key={column} value={cohort.rates[index] ?? null} max={max} format={format} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

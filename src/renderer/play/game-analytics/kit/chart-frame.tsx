/**
 * What every canvas chart of the kit shares: the place under the pointer or the arrow keys, and
 * the table that says in text what the canvas draws.
 */
import type { JSX, KeyboardEvent, PointerEvent } from "react";
import { useState } from "react";
import { cursorTarget } from "./geometry.ts";

/**
 * The hovered place of a chart with `count` places: the pointer picks it through `locate` (the
 * pointer's x from the plot's left edge, and the plot's size), the arrow keys, Home and End move
 * it, and Escape, leaving or losing focus clears it. Spread `handlers` on the focusable plot.
 */
export function useChartCursor(
  count: number,
  locate: (x: number, width: number, height: number) => number,
): {
  hovered: number | null;
  handlers: {
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    onBlur: () => void;
  };
} {
  const [hovered, setHovered] = useState<number | null>(null);
  const shown = hovered !== null && hovered < count ? hovered : null;
  return {
    hovered: shown,
    handlers: {
      onPointerMove: (event) => {
        const box = event.currentTarget.getBoundingClientRect();
        if (count > 0) setHovered(locate(event.clientX - box.left, box.width, box.height));
      },
      onPointerLeave: () => setHovered(null),
      onKeyDown: (event) => {
        if (event.key === "Escape") return setHovered(null);
        const next = cursorTarget(event.key, shown, count);
        if (next === null) return;
        event.preventDefault();
        setHovered(next);
      },
      onBlur: () => setHovered(null),
    },
  };
}

/**
 * A chart's text equivalent, for screen readers only: `label` is its caption, `place` the heading
 * of the first column, `columns` the series (id and name), and each row a place with one written value
 * per column (an empty string for a missing one) and, when the chart has marks, what is marked there.
 */
export function ChartTable({
  label,
  place,
  columns,
  rows,
  marks,
}: {
  label: string;
  place: string;
  columns: readonly { id: string; label: string }[];
  rows: readonly { place: string; cells: readonly string[]; mark: string }[];
  /** The marks column's heading; left out when the chart has no marks. */
  marks?: string;
}): JSX.Element {
  return (
    <table className="sr-only">
      <caption>{label}</caption>
      <thead>
        <tr>
          <th scope="col">{place}</th>
          {columns.map((column) => (
            <th key={column.id} scope="col">
              {column.label}
            </th>
          ))}
          {marks && <th scope="col">{marks}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.place}>
            <th scope="row">{row.place}</th>
            {row.cells.map((cell, index) => (
              <td key={columns[index]?.id}>{cell}</td>
            ))}
            {marks && <td>{row.mark}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The stats page's charts as components: the plays-per-day chart, which follows the pointer with a
 * crosshair and a tooltip, and a sparkline. Each draws again when its box changes size or the theme
 * changes, and has a text equivalent for screen readers. `useRedraw` is the hook every canvas chart
 * draws through, a game's analytics included (`game-analytics/kit`).
 */
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n.ts";
import { dayAt, drawArea, drawSpark } from "./stats-chart.ts";

/** What a new theme changes on the page's root (`appearance/paint.ts`): its scheme and its variables. */
const THEME_ATTRIBUTES = ["data-theme", "style"];

/**
 * Draw on `canvas` after every render (new numbers, a hovered day), whenever its box changes size
 * and whenever the theme repaints the page's colours. It reads no store, so a chart also renders
 * where there is no window.
 */
export function useRedraw(
  canvas: { current: HTMLCanvasElement | null },
  draw: (element: HTMLCanvasElement) => void,
): void {
  const latest = useRef(draw);
  latest.current = draw;
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    latest.current(element);
    const resized = new ResizeObserver(() => latest.current(element));
    resized.observe(element);
    // A new theme sets the root's scheme and variables; the canvas reads its colours as it draws.
    const themed = new MutationObserver(() => latest.current(element));
    themed.observe(document.documentElement, { attributes: true, attributeFilter: THEME_ATTRIBUTES });
    return () => {
      resized.disconnect();
      themed.disconnect();
    };
  }, [canvas]);
  // Every render draws: new numbers or a hovered day.
  useEffect(() => {
    if (canvas.current) latest.current(canvas.current);
  });
}

/** The plays-per-day chart. */
export function AreaChart({
  data,
  labels,
  label,
  valueLine,
  axisValue,
}: {
  data: readonly number[];
  labels: readonly string[];
  /** What the chart shows, for screen readers. */
  label: string;
  valueLine: (count: number) => string;
  axisValue: (count: number) => string;
}): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  useRedraw(canvas, (element) => drawArea(element, { data, labels, hovered, valueLine, axisValue }));
  const readings = data
    .map((count, day) => t("{day} {value}", { day: labels[day] ?? "", value: valueLine(count) }))
    .join(", ");
  return (
    <figure className="stats-area" data-stats-chart>
      <canvas
        ref={canvas}
        className="stats-area-canvas"
        aria-hidden="true"
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setHovered(dayAt(event.clientX - box.left, box.width, data.length));
        }}
        onPointerLeave={() => setHovered(null)}
      />
      <figcaption className="sr-only">{t("{chart}: {readings}", { chart: label, readings })}</figcaption>
    </figure>
  );
}

/** A sparkline of `data`, `width` × `height` CSS pixels; a null is a gap in the line. */
export function Sparkline({
  data,
  width,
  height,
  className,
}: {
  data: readonly (number | null)[];
  width?: number;
  height: number;
  className?: string;
}): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  useRedraw(canvas, (element) => drawSpark(element, data));
  return (
    <canvas
      ref={canvas}
      className={`stats-spark ${className ?? ""}`}
      style={{ width: width ?? "100%", height }}
      aria-hidden="true"
    />
  );
}

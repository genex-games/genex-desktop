/**
 * The stats page's charts as components: the plays-per-day chart, which follows the pointer with a
 * crosshair and a tooltip, and a sparkline. Each draws again when its box changes size or the theme
 * changes, and has a text equivalent for screen readers.
 */
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { useAppearance } from "../appearance/store.ts";
import { dayAt, drawArea, drawSpark } from "./stats-chart.ts";

/** Draw again whenever the canvas's box changes size. */
function useRedraw(canvas: { current: HTMLCanvasElement | null }, draw: (element: HTMLCanvasElement) => void): void {
  const latest = useRef(draw);
  latest.current = draw;
  // A new theme re-renders, which draws again below in its colours.
  useAppearance();
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    latest.current(element);
    const observer = new ResizeObserver(() => latest.current(element));
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvas]);
  // Every render draws: new numbers, a hovered day, or a theme's colours.
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
      <figcaption className="sr-only">
        {label}: {data.map((count, day) => `${labels[day] ?? ""} ${valueLine(count)}`).join(", ")}
      </figcaption>
    </figure>
  );
}

/** A sparkline of `data`, `width` × `height` CSS pixels. */
export function Sparkline({
  data,
  width,
  height,
  className,
}: {
  data: readonly number[];
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

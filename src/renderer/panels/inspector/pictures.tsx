/** The inspector's pictures: one still, two stills split by a handle, the camera switch and a try's thumbnail. */
import type { JSX, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useRef, useState } from "react";
import { t } from "../../../shared/i18n.ts";
import { clamp } from "../../canvas-view.ts";
import { type IterationNode, type RunGraph as RunGraphModel, roundShot } from "../../run-graph.ts";
import { TRY_GLYPH, tryWord } from "../../round-status.ts";
import { Icon } from "../../ui/icons.tsx";
import { PairView, pairView } from "../../run-graph-pictures.ts";
import { useStill } from "../../stills.ts";
import { usePictureChange, useRoundStill } from "../run-stills.ts";

/** Where the compare handle starts, how far it may go toward either edge, and one arrow key's step. */
const SPLIT_START = 0.5;
const SPLIT_MIN = 0.02;
const SPLIT_MAX = 0.98;
const SPLIT_STEP = 0.05;

/** The thin ring every picture of the panel wears. */
export const IMAGE_OUTLINE = "0 0 0 1px var(--image-outline)";

function Chip({ children, side }: { children: ReactNode; side: "left" | "right" }): JSX.Element {
  return (
    <span
      className={`pointer-events-none absolute top-2 ${side === "left" ? "left-2" : "right-2"} rounded-[8px] px-2 py-[3px] font-mono text-micro text-white`}
      style={{ background: "rgb(20 20 21 / 72%)" }}
    >
      {children}
    </span>
  );
}

/** A still filling its frame, or the hatch that stands in for a missing one. */
function Layer({ src, alt, clipPath }: { src: string | null; alt: string; clipPath?: string }): JSX.Element {
  const style = clipPath ? { clipPath } : undefined;
  if (!src) return <span className="hatch absolute inset-0" style={style} />;
  return (
    <img src={src} alt={alt} draggable={false} className="absolute inset-0 h-full w-full object-cover" style={style} />
  );
}

/** Two stills of one camera, split by a handle you drag — or step with the arrow keys. */
export function Compare({
  left,
  right,
  leftLabel,
  rightLabel,
  onOpen,
}: {
  left: string | null;
  right: string | null;
  leftLabel: string;
  rightLabel: string;
  onOpen?: () => void;
}): JSX.Element {
  const [split, setSplit] = useState(SPLIT_START);
  const box = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);
  const place = (clientX: number): void => {
    const rect = box.current?.getBoundingClientRect();
    if (rect?.width) setSplit(clamp((clientX - rect.left) / rect.width, SPLIT_MIN, SPLIT_MAX));
  };
  const onKey = (event: ReactKeyboardEvent): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? -SPLIT_STEP : SPLIT_STEP;
    setSplit((value) => clamp(value + step, SPLIT_MIN, SPLIT_MAX));
  };
  return (
    <div
      ref={box}
      className={`relative aspect-video w-full overflow-hidden rounded-[10px] bg-inset ${onOpen ? "cursor-zoom-in" : ""}`}
      style={{ boxShadow: IMAGE_OUTLINE }}
      onClick={() => {
        if (!dragged.current) onOpen?.();
        dragged.current = false;
      }}
    >
      <Layer src={right} alt={rightLabel} />
      <Layer src={left} alt={leftLabel} clipPath={`inset(0 ${(1 - split) * 100}% 0 0)`} />
      <span
        aria-hidden="true"
        className="absolute inset-y-0 w-0.5 bg-white"
        style={{ left: `calc(${split * 100}% - 1px)` }}
      />
      <button
        type="button"
        role="slider"
        aria-label={t("Drag to compare")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(split * 100)}
        className="absolute top-1/2 grid size-7 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize place-items-center rounded-full bg-white text-[#1d1d1f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        style={{ left: `${split * 100}%`, boxShadow: "0 2px 8px rgb(0 0 0 / 35%)" }}
        onKeyDown={onKey}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragged.current = true;
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) place(event.clientX);
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 7l-4 5 4 5M15 7l4 5-4 5" />
        </svg>
      </button>
      <Chip side="left">{leftLabel}</Chip>
      <Chip side="right">{rightLabel}</Chip>
    </div>
  );
}

/** The largest side of a picture a card shows. */
const CARD_PICTURE_PX = 640;

/**
 * Two pictures of the same frame under the run folder — a build's screenshot and the build's before
 * it, or two versions of one asset from one view — measured: the compare when they visibly differ,
 * else the newer alone, saying so when it did not visibly change. Never give it unrelated pictures.
 */
export function PictureChange({
  before,
  now,
  beforeLabel,
  nowLabel,
  unchanged,
  onOpen,
}: {
  before: string | null;
  now: string | null;
  beforeLabel: string;
  nowLabel: string;
  /** what the card says when the picture did not visibly change */
  unchanged: string;
  onOpen?: () => void;
}): JSX.Element {
  const beforeSrc = useStill(before ? { run: before, maxPx: CARD_PICTURE_PX } : null);
  const nowSrc = useStill(now ? { run: now, maxPx: CARD_PICTURE_PX } : null);
  const view = pairView(before, now, usePictureChange(before, now));
  if (view === PairView.Compare)
    return <Compare left={beforeSrc} right={nowSrc} leftLabel={beforeLabel} rightLabel={nowLabel} onOpen={onOpen} />;
  return (
    <div className="flex flex-col gap-2">
      <Single src={nowSrc} label={nowLabel} {...(onOpen ? { onOpen } : {})} />
      {view === PairView.Unchanged ? (
        <p data-picture-unchanged className="text-body-sm text-ink-3">
          {unchanged}
        </p>
      ) : null}
    </div>
  );
}

/** One still, or a line saying why there is none (by default, that none was saved). */
export function Single({
  src,
  label,
  empty = t("No picture was saved for this."),
  onOpen,
}: {
  src: string | null;
  label: string;
  empty?: string;
  onOpen?: () => void;
}): JSX.Element {
  return (
    <div
      className={`relative aspect-video w-full overflow-hidden rounded-[10px] ${src ? "bg-inset" : "hatch"} ${onOpen && src ? "cursor-zoom-in" : ""}`}
      style={{ boxShadow: IMAGE_OUTLINE }}
      onClick={src ? onOpen : undefined}
    >
      {src ? (
        <img src={src} alt={label} draggable={false} className="block h-full w-full object-cover" />
      ) : (
        <span className="absolute inset-0 grid place-items-center px-6 text-center text-body-sm text-ink-3">
          {empty}
        </span>
      )}
    </div>
  );
}

/** The picture switch, when a try has more than one: the lead's named picture and each camera, by name. */
export function Cameras({
  views,
  value,
  onChange,
}: {
  views: Array<{ key: string; label: string }>;
  value: string | null;
  onChange: (key: string) => void;
}): JSX.Element | null {
  if (views.length < 2) return null;
  return (
    <div role="group" aria-label={t("Camera")} className="flex flex-wrap gap-1">
      {views.map((view) => (
        <button
          key={view.key}
          type="button"
          aria-pressed={view.key === value}
          onClick={() => onChange(view.key)}
          className={`inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-[8px] px-2.5 text-xs focus-visible:outline-2 focus-visible:outline-accent ${view.key === value ? "bg-line-strong text-ink" : "text-ink-3 hover:bg-control-hover hover:text-control-text-hover"}`}
        >
          <Icon name="camera" size={13} />
          {view.label}
        </button>
      ))}
    </div>
  );
}

/** One try of a step as a thumbnail with its status glyph; pressing it shows that try. */
export function TryThumb({
  graph,
  node,
  n,
  selected,
  live,
  onSelect,
}: {
  graph: RunGraphModel;
  node: IterationNode;
  n: number;
  selected: boolean;
  live: boolean;
  onSelect: () => void;
}): JSX.Element {
  const src = useRoundStill(graph, node.facetId, node.iteration, roundShot(node)?.path ?? null, live);
  const glyph = TRY_GLYPH[node.status];
  return (
    <button
      type="button"
      aria-label={t("Try {number}: {state}", { number: n, state: tryWord(node) })}
      aria-pressed={selected}
      onClick={onSelect}
      className="flex cursor-pointer flex-col items-center gap-1 rounded-[8px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <span className="relative block">
        <span
          className={`block h-8 w-14 overflow-hidden rounded-[6px] ${src ? "bg-inset" : "hatch"}`}
          style={
            selected
              ? { outline: "2px solid var(--accent)", outlineOffset: 2 }
              : { opacity: 0.6, boxShadow: IMAGE_OUTLINE }
          }
        >
          {src ? <img src={src} alt="" draggable={false} className="h-full w-full object-cover" /> : null}
        </span>
        <span
          className="absolute -right-[5px] -bottom-[5px] grid size-4 place-items-center rounded-full bg-surface"
          style={{ color: glyph.color }}
        >
          {glyph.icon ? (
            <Icon name={glyph.icon} size={10} strokeWidth={2.4} />
          ) : (
            <span className="size-1.5 rounded-full" style={{ background: glyph.color }} />
          )}
        </span>
      </span>
      <span className={`font-mono text-micro ${selected ? "text-ink" : "text-ink-3"}`}>{n}</span>
    </button>
  );
}

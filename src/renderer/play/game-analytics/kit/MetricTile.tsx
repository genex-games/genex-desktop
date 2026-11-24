/**
 * A report's headline numbers: a tile with a label, the number, how it moved against the period
 * before, a quiet note and a sparkline. A tile that picks the chart's measure is a button. A number
 * that cannot be known is a dash, never zero, and a change is never told by colour alone: it wears
 * its sign and an arrow.
 */
import type { JSX, ReactNode } from "react";
import { ChangeKind, changeOf } from "../../../../shared/play-stats.ts";
import { Icon } from "../../../ui/icons.tsx";
import { Sparkline } from "../../StatsCharts.tsx";
import { ChangeMark } from "../../StatsStrip.tsx";
import { DASH, difference, formatPercent, formatPoints, POINT_DIGITS, roundsToZero } from "./format.ts";

/** How a change is written: a percentage of the number before, points between two rates, or an amount in the number's unit. */
export const DeltaKind = { Percent: "percent", Points: "points", Amount: "amount" } as const;
export type DeltaKind = (typeof DeltaKind)[keyof typeof DeltaKind];

/**
 * A number now and over the period before, and how to write the change. Percent is for counts and
 * sums ("+66%"), Points for rates ("+2.1 pts", `digits` decimals), Amount for anything with a unit
 * (`format` writes the signed difference: `formatSignedDuration`, `formatSigned`; `digits` are the
 * decimals it writes the change at, in the change's own unit, so a change that shows as none goes
 * neither way). `lowerIsBetter` marks a drop as the good direction (quick exits, load time);
 * `neutral` marks a number whose direction is neither good nor bad news (an event a game sends: a
 * win or a death), which keeps its arrow and sign in ink. A missing side is a dash.
 */
export type MetricDelta =
  | { kind: typeof DeltaKind.Percent; now: number | null; before: number | null; neutral?: boolean }
  | {
      kind: typeof DeltaKind.Points;
      now: number | null;
      before: number | null;
      digits?: number;
      lowerIsBetter?: boolean;
      neutral?: boolean;
    }
  | {
      kind: typeof DeltaKind.Amount;
      now: number | null;
      before: number | null;
      format: (change: number) => string;
      digits: number;
      lowerIsBetter?: boolean;
      neutral?: boolean;
    };

/** A change in points between two rates: a rate is a fraction, a point a hundredth of one. */
const POINTS_PER_RATE = 100;

/** Which way a number moved, and whether that is good news. */
const Direction = { Up: "up", Down: "down", Flat: "flat" } as const;
type Direction = (typeof Direction)[keyof typeof Direction];
const Tone = { Good: "good", Bad: "bad", Flat: "flat", Neutral: "neutral" } as const;
type Tone = (typeof Tone)[keyof typeof Tone];

/** No change to show: a side is missing. */
function NoDelta(): JSX.Element {
  return (
    <span className="stats-change" data-change="flat">
      {DASH}
    </span>
  );
}

/** A change in points or in a unit. */
type UnitDelta = Exclude<MetricDelta, { kind: typeof DeltaKind.Percent }>;

/**
 * The way `change` points as it is written: flat when it shows as none at the decimals it is
 * written at. Told from the number, never from the words a language puts around it.
 */
function directionOf(delta: UnitDelta, change: number): Direction {
  const shown = delta.kind === DeltaKind.Points ? change * POINTS_PER_RATE : change;
  const digits = delta.kind === DeltaKind.Points ? (delta.digits ?? POINT_DIGITS) : delta.digits;
  if (roundsToZero(shown, digits)) return Direction.Flat;
  return change > 0 ? Direction.Up : Direction.Down;
}

/** Whether a move in `direction` is good news; neither for a number whose direction tells nothing. */
function toneOf(direction: Direction, delta: UnitDelta): Tone {
  if (direction === Direction.Flat) return Tone.Flat;
  if (delta.neutral) return Tone.Neutral;
  const good = delta.lowerIsBetter ? Direction.Down : Direction.Up;
  return direction === good ? Tone.Good : Tone.Bad;
}

/** A change in percent: Stats' own mark, in ink for a number whose direction tells nothing, and no arrow when it held. */
function PercentMark({ now, before, neutral }: { now: number; before: number; neutral: boolean }): JSX.Element {
  const change = changeOf(now, before);
  if (change.kind === ChangeKind.Flat) {
    return (
      <span className="stats-change game-analytics-delta" data-change="flat" data-direction="flat" data-tone="flat">
        {formatPercent(0, 0)}
      </span>
    );
  }
  if (!neutral) return <ChangeMark change={change} />;
  return (
    <span className="game-analytics-neutral">
      <ChangeMark change={change} />
    </span>
  );
}

/**
 * How a number moved, as a small mark: an arrow, the signed change, green for good news and red
 * for bad. `delta` is a `MetricDelta`. Tiles and `MiniStats` draw it; use it alone beside any number.
 */
export function DeltaMark({ delta }: { delta: MetricDelta }): JSX.Element {
  const change = difference(delta.now, delta.before);
  if (change === null) return <NoDelta />;
  if (delta.kind === DeltaKind.Percent)
    return <PercentMark now={delta.now ?? 0} before={delta.before ?? 0} neutral={delta.neutral === true} />;
  const text = delta.kind === DeltaKind.Points ? formatPoints(change, delta.digits) : delta.format(change);
  const direction = directionOf(delta, change);
  return (
    <span className="stats-change game-analytics-delta" data-direction={direction} data-tone={toneOf(direction, delta)}>
      {direction !== Direction.Flat && <Icon name={direction === Direction.Up ? "caret-up" : "caret-down"} size={12} />}
      {text}
    </span>
  );
}

/** What a tile shows. */
export interface MetricTileProps {
  /** Names the tile in `data-game-analytics-tile`. */
  id: string;
  label: string;
  /** The number as it reads, already written by a formatter; null when it cannot be known. */
  value: string | null;
  /** How it moved against the period before. */
  delta?: MetricDelta;
  /** One quiet line: what the number counts, or what it is compared with. */
  note?: ReactNode;
  /** A value per day for a sparkline; a null is a gap. */
  spark?: readonly (number | null)[];
  /** With `onPress` the tile is a button that picks the chart's measure, and `pressed` marks the one picked. */
  pressed?: boolean;
  onPress?: () => void;
}

/**
 * One headline number. Props: `id`, `label`, `value` (formatted text, or null for a dash), `delta`
 * (a `MetricDelta`), `note`, `spark` (per-day values) and, for a tile that picks the chart's
 * measure, `onPress` with `pressed`.
 */
export function MetricTile({ id, label, value, delta, note, spark, pressed, onPress }: MetricTileProps): JSX.Element {
  const body = (
    <>
      <span className="stats-tile-label">{label}</span>
      <span className="stats-tile-value" data-missing={value === null || undefined}>
        {value ?? DASH}
      </span>
      {(delta || note) && (
        <span className="stats-tile-change">
          {delta && <DeltaMark delta={delta} />}
          {note && <span className="stats-tile-note">{note}</span>}
        </span>
      )}
      {spark && <Sparkline data={spark} height={36} className="game-analytics-tile-spark" />}
    </>
  );
  if (!onPress) {
    return (
      <div className="stats-tile game-analytics-tile" data-game-analytics-tile={id}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="stats-tile game-analytics-tile"
      data-game-analytics-tile={id}
      aria-pressed={pressed === true}
      onClick={onPress}
    >
      {body}
    </button>
  );
}

/** A row of tiles that wraps to as many rows as it needs: `children` are `MetricTile`s. */
export function MetricTiles({ children }: { children: ReactNode }): JSX.Element {
  return <div className="stats-tiles game-analytics-tiles">{children}</div>;
}

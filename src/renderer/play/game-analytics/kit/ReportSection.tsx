/**
 * The blocks a report is laid out with: a titled section with a hint and a place for controls, two
 * or more sections side by side, a note for a block that has nothing to show yet, a row of small
 * numbers and a list of terms with what each means.
 */
import type { JSX, ReactNode } from "react";
import { useId } from "react";
import { DASH } from "./format.ts";
import { DeltaMark, type MetricDelta } from "./MetricTile.tsx";

/**
 * A titled block of a report. `id` names it in `data-game-analytics-section`; `title` is its
 * heading; `hint` one quiet line beside the title (what the numbers are of); `controls` sit at the
 * end of the head (a `SegmentSwitch`, a link, a `Legend`); `footnote` is a quiet paragraph under
 * the body; `children` are the body.
 */
export function ReportSection({
  id,
  title,
  hint,
  controls,
  footnote,
  children,
}: {
  id: string;
  title: string;
  hint?: ReactNode;
  controls?: ReactNode;
  footnote?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const heading = useId();
  return (
    <section className="game-analytics-section" data-game-analytics-section={id} aria-labelledby={heading}>
      <header className="game-analytics-section-head">
        <h2 id={heading} className="game-analytics-section-title">
          {title}
        </h2>
        {hint && <p className="game-analytics-section-hint">{hint}</p>}
        {controls && <div className="game-analytics-section-controls">{controls}</div>}
      </header>
      {children}
      {footnote && <p className="game-analytics-section-footnote">{footnote}</p>}
    </section>
  );
}

/** Sections side by side while the page is wide enough for them, one under another when it is not. */
export function ReportColumns({ children }: { children: ReactNode }): JSX.Element {
  return <div className="game-analytics-columns">{children}</div>;
}

/** A block with nothing to show yet: one plain sentence (`children`) saying so, in place of an empty chart or table. */
export function EmptyNote({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="game-analytics-empty" data-game-analytics-empty="true">
      {children}
    </p>
  );
}

/** One small number: its `label`, its `value` already written (null for one that cannot be known) and how it moved. */
export interface MiniStat {
  id: string;
  label: string;
  value: string | null;
  delta?: MetricDelta;
}

/** A row of small numbers under a section's title, each a label over its value: `items` in reading order. */
export function MiniStats({ items }: { items: readonly MiniStat[] }): JSX.Element {
  return (
    <dl className="game-analytics-ministats">
      {items.map((item) => (
        <div key={item.id} className="game-analytics-ministat" data-game-analytics-stat={item.id}>
          <dt>{item.label}</dt>
          <dd>
            {item.value ?? DASH}
            {item.delta && <DeltaMark delta={item.delta} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A list of terms with what each means: an event's name and when it is sent, a rule and its
 * limits. `items`: each `term` and its `detail`; `mono` sets the terms in the code face, for names
 * a game writes.
 */
export function TermList({
  items,
  mono,
}: {
  items: readonly { id: string; term: ReactNode; detail: ReactNode }[];
  mono?: boolean;
}): JSX.Element {
  return (
    <dl className="game-analytics-terms" data-mono={mono || undefined}>
      {items.map((item) => (
        <div key={item.id} className="game-analytics-term">
          <dt>{item.term}</dt>
          <dd>{item.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

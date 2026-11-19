/**
 * Retention: whether new players come back. Five tiles for the headline days, three switches (what
 * counts as coming back, how first plays are grouped, what the groups below are split by), the
 * curve by day since the first play, the cohort table with its summary row, the groups of new
 * players compared and each week's players stacked. The shell mounts it only with an answer to
 * draw (`report-props.ts`), and everything it shows is derived in `retention-view.ts`.
 */
import type { JSX } from "react";
import { type CohortSize, GameReport, type GameReportOptions } from "../../../shared/game-analytics.ts";
import {
  BarChart,
  CohortTable,
  DataTable,
  EmptyNote,
  formatAxisPercent,
  formatNumber,
  formatPercent,
  Legend,
  LineChart,
  MetricTile,
  MetricTiles,
  ReportColumns,
  ReportSection,
  SegmentSwitch,
} from "./kit/index.ts";
import type { ReportProps } from "./report-props.ts";
import {
  COHORT_OPTIONS,
  MODE_OPTIONS,
  type RetentionCohorts,
  type RetentionCurveView,
  type RetentionSegments,
  type RetentionView,
  type RetentionWeeks,
  retentionView,
  SEGMENT_OPTIONS,
  segmentColumns,
} from "./retention-view.ts";
import { RETENTION_WORDS as WORDS } from "./retention-words.ts";

/** The plot of the curve and of the weeks, in CSS pixels. */
const CURVE_HEIGHT = 240;
const WEEKS_HEIGHT = 260;

/** A switch with its name written beside it, as the mockup lays the three out. */
function Choice({ name, children }: { name: string; children: JSX.Element }): JSX.Element {
  return (
    <div className="game-analytics-retention-choice">
      <span className="game-analytics-retention-choice-name" aria-hidden="true">
        {name}
      </span>
      {children}
    </div>
  );
}

/** What counts as coming back, and how first plays are grouped. */
function Switches({ view, onOptions }: { view: RetentionView; onOptions: (change: GameReportOptions) => void }) {
  return (
    <div className="game-analytics-retention-switches">
      <Choice name={WORDS.modeLabel}>
        <SegmentSwitch
          id="mode"
          label={WORDS.modeLabel}
          options={MODE_OPTIONS}
          value={view.chosen.mode}
          onChange={(mode) => onOptions({ mode })}
        />
      </Choice>
      <Choice name={WORDS.cohortLabel}>
        <SegmentSwitch
          id="cohort"
          label={WORDS.cohortLabel}
          options={COHORT_OPTIONS}
          value={view.chosen.cohort}
          onChange={(cohort) => onOptions({ cohort })}
        />
      </Choice>
    </div>
  );
}

/** New players who play again, by day since their first play: this period over the one before and similar games. */
function Curve({ curve }: { curve: RetentionCurveView | null }): JSX.Element {
  return (
    <ReportSection id="curve" title={WORDS.curveTitle} controls={curve && <Legend items={curve.legend} />}>
      {curve ? (
        <LineChart
          id="curve"
          label={WORDS.curveTitle}
          series={curve.series}
          labels={curve.labels}
          format={formatPercent}
          axisFormat={formatAxisPercent}
          place={WORDS.daysSince}
          ticks={curve.ticks}
          callouts={curve.callouts}
          height={CURVE_HEIGHT}
          legend={false}
        />
      ) : (
        <EmptyNote>{WORDS.curveEmpty}</EmptyNote>
      )}
    </ReportSection>
  );
}

/** What the dots beside some cohorts mean, written under the table. */
function FlagNote({ note }: { note: string }): JSX.Element {
  return (
    <span className="game-analytics-retention-flag-note" data-game-analytics-flag-note="true">
      <span className="game-analytics-flag" aria-hidden="true" />
      <span data-analytics-mask="true">{note}</span>
    </span>
  );
}

/** The cohort table: each first-play day (or week), its size and how many of them played again. */
function Cohorts({ cohorts, size }: { cohorts: RetentionCohorts | null; size: CohortSize }): JSX.Element {
  if (!cohorts) {
    return (
      <ReportSection id="cohorts" title={WORDS.cohortTitles[size]}>
        <EmptyNote>{WORDS.noNewPlayers}</EmptyNote>
      </ReportSection>
    );
  }
  return (
    <ReportSection
      id="cohorts"
      title={cohorts.title}
      hint={cohorts.hint}
      footnote={cohorts.note && <FlagNote note={cohorts.note} />}
    >
      <CohortTable
        id="cohorts"
        label={cohorts.caption}
        firstColumn={WORDS.firstPlay}
        sizeColumn={WORDS.newPlayers}
        columns={cohorts.columns}
        cohorts={cohorts.rows}
      />
    </ReportSection>
  );
}

/** Groups of new players side by side: how many they are and how many of them came back. */
function Segments({
  segments,
  chosen,
  onChange,
}: {
  segments: RetentionSegments;
  chosen: RetentionView["chosen"];
  onChange: (change: GameReportOptions) => void;
}): JSX.Element {
  return (
    <ReportSection id="segments" title={WORDS.segmentsTitle}>
      <div className="game-analytics-retention-segment-by">
        <SegmentSwitch
          id="segment-by"
          label={WORDS.segmentSwitch}
          options={SEGMENT_OPTIONS}
          value={chosen.segmentBy}
          onChange={(segmentBy) => onChange({ segmentBy })}
        />
      </div>
      <DataTable
        id="segments"
        label={segments.caption}
        columns={segmentColumns(segments.by)}
        rows={segments.rows}
        rowId={(row) => row.id}
        total={segments.total ?? undefined}
        empty={WORDS.segmentsEmpty}
      />
    </ReportSection>
  );
}

/** Each week's players: new, stayed and back above the line, the ones who left below it. */
function Weeks({ weeks }: { weeks: RetentionWeeks | null }): JSX.Element {
  return (
    <ReportSection id="weeks" title={WORDS.weeksTitle} hint={weeks?.hint}>
      {weeks ? (
        <BarChart
          id="weeks"
          label={WORDS.weeksTitle}
          series={weeks.series}
          labels={weeks.labels}
          format={formatNumber}
          place={WORDS.weekStarts}
          below={weeks.below}
          height={WEEKS_HEIGHT}
        />
      ) : (
        <EmptyNote>{WORDS.weeksEmpty}</EmptyNote>
      )}
    </ReportSection>
  );
}

/** What `RetentionFace` is given: the view to draw, and what its switches ask. */
export interface RetentionFaceProps {
  view: RetentionView;
  onOptions: (change: GameReportOptions) => void;
}

/** The Retention report drawn from its view alone. */
export function RetentionFace({ view, onOptions }: RetentionFaceProps): JSX.Element {
  return (
    <div className="game-analytics-report" data-game-analytics-report={GameReport.Retention}>
      <MetricTiles>
        {view.tiles.map((tile) => (
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
      <Switches view={view} onOptions={onOptions} />
      <Curve curve={view.curve} />
      <Cohorts cohorts={view.cohorts} size={view.chosen.cohort} />
      <ReportColumns>
        <Segments segments={view.segments} chosen={view.chosen} onChange={onOptions} />
        <Weeks weeks={view.weeks} />
      </ReportColumns>
    </div>
  );
}

/** The Retention report's body: the switches follow what was asked, the numbers what was answered. */
export function RetentionReport({ answer, options, onOptions }: ReportProps<typeof GameReport.Retention>): JSX.Element {
  return <RetentionFace view={retentionView(answer, options)} onOptions={onOptions} />;
}

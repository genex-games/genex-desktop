/**
 * Engagement: how much and how well people play. Eight tiles; how long a play lasts and how many
 * days a week players come, side by side; the week by hour on the viewer's clock or the players';
 * how far players get through the levels the game reports; and how the game runs, against the
 * period before and by device. The shell mounts it only with an answer to draw (`report-props.ts`),
 * and everything it shows is derived in `engagement-view.ts`.
 */
import type { JSX } from "react";
import { Fragment, useId, useState } from "react";
import { GameReport, KnownEvent } from "../../../shared/game-analytics.ts";
import {
  ClockChoice,
  type DeviceRow,
  type EngagementTile,
  type EngagementView,
  engagementView,
  type HoursView,
  type LevelsView,
  LevelsKind,
  type SharesView,
  viewerOffsetMinutes,
} from "./engagement-view.ts";
import { ENGAGEMENT_WORDS as WORDS } from "./engagement-words.ts";
import {
  ColumnKind,
  type DataColumn,
  DataTable,
  EmptyNote,
  formatCompact,
  formatPercent,
  formatSeconds,
  Heatmap,
  Histogram,
  MetricTile,
  MetricTiles,
  ReportColumns,
  ReportSection,
  SegmentSwitch,
} from "./kit/index.ts";
import type { ReportProps } from "./report-props.ts";
import { AnalyticsTab } from "./tabs.ts";

/** A level's column, and the one that names the rows under the bars, in CSS pixels: what the grid needs to stay legible. */
const LEVEL_COLUMN_MIN = 56;
const LEVEL_LABEL_COLUMN = 112;
/** A share written as a whole percent: over a bar of days a week or of a level, and a device's share of the plays. */
const WHOLE_PERCENT = 0;
/** The events a game sends for this report to draw its levels, named for the link. */
const LEVEL_EVENTS = [KnownEvent.LevelStart, KnownEvent.LevelComplete, KnownEvent.LevelFail] as const;

/** Opens another tab of the page. */
type OpenTab = (tab: AnalyticsTab) => void;

/** What the component is given: a report's props, and where the viewer is, which a test can set. */
export type EngagementReportProps = ReportProps<typeof GameReport.Engagement> & {
  /** Minutes east of UTC of the viewer's own clock; the computer's at `now` when left out. */
  offsetMinutes?: number;
};

/** A row of headline tiles. */
function Tiles({ tiles }: { tiles: readonly EngagementTile[] }): JSX.Element {
  return (
    <MetricTiles>
      {tiles.map((tile) => (
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
  );
}

/** A link that opens another tab, set in the quiet way a block's head or a note carries one. */
function TabLink({ tab, onOpenTab, children }: { tab: AnalyticsTab; onOpenTab: OpenTab; children: string }) {
  return (
    <button
      type="button"
      className="game-analytics-engagement-open"
      data-game-analytics-open={tab}
      onClick={() => onOpenTab(tab)}
    >
      {children}
    </button>
  );
}

/** How long plays last, as shares of all plays. */
function Lengths({ lengths }: { lengths: SharesView | null }): JSX.Element {
  return (
    <ReportSection id="lengths" title={WORDS.lengths.title} footnote={lengths?.footnote}>
      {lengths ? (
        <Histogram
          id="lengths"
          label={WORDS.lengths.label}
          buckets={lengths.buckets}
          format={(share) => formatPercent(share)}
        />
      ) : (
        <EmptyNote>{WORDS.lengths.empty}</EmptyNote>
      )}
    </ReportSection>
  );
}

/** How many days a week players play, as shares of a week's players; the regulars' bars stand out. */
function DaysAWeek({ days }: { days: SharesView | null }): JSX.Element {
  return (
    <ReportSection id="days" title={WORDS.days.title} footnote={days?.footnote}>
      {days ? (
        <div className="game-analytics-engagement-days">
          <Histogram
            id="days"
            label={WORDS.days.label}
            buckets={days.buckets}
            format={(share) => formatPercent(share, WHOLE_PERCENT)}
          />
        </div>
      ) : (
        <EmptyNote>{WORDS.days.empty}</EmptyNote>
      )}
    </ReportSection>
  );
}

/** The week by hour, on the viewer's clock, or on the players' own when the answer knows them. */
function WhenTheyPlay({ hours, onClock }: { hours: HoursView; onClock: (clock: ClockChoice) => void }): JSX.Element {
  const choose = hours.switchable ? (
    <SegmentSwitch
      id="clock"
      label={WORDS.hours.switchLabel}
      options={[
        { value: ClockChoice.Mine, label: WORDS.hours.mine },
        { value: ClockChoice.Players, label: WORDS.hours.players },
      ]}
      value={hours.clock}
      onChange={onClock}
    />
  ) : undefined;
  return (
    <ReportSection id="hours" title={WORDS.hours.title} hint={hours.busiest} controls={choose}>
      {hours.empty ? (
        <EmptyNote>{WORDS.hours.empty}</EmptyNote>
      ) : (
        <div className="game-analytics-engagement-heat">
          <Heatmap
            id="hours"
            label={hours.label}
            corner={WORDS.hours.corner}
            columns={hours.columns}
            rows={hours.rows}
            format={(plays) => formatCompact(Math.round(plays))}
            scale={{ low: WORDS.hours.fewer, high: WORDS.hours.more }}
          />
        </div>
      )}
    </ReportSection>
  );
}

/** The bars of the levels with their medians in rows under them, one column for each level. */
function LevelsGrid({ levels }: { levels: Extract<LevelsView, { kind: typeof LevelsKind.Levels }> }): JSX.Element {
  const minWidth = LEVEL_LABEL_COLUMN + levels.buckets.length * LEVEL_COLUMN_MIN;
  return (
    <div className="game-analytics-scroll">
      <div className="game-analytics-engagement-levels" style={{ minWidth }}>
        <Histogram
          id="levels"
          label={WORDS.levels.label}
          buckets={levels.buckets}
          format={(share) => formatPercent(share, WHOLE_PERCENT)}
        />
        {levels.rows.map((row) => (
          <Fragment key={row.id}>
            <span className="game-analytics-engagement-levels-label" aria-hidden="true">
              {row.label}
            </span>
            <ul
              className="game-analytics-engagement-levels-cells"
              aria-label={row.label}
              data-game-analytics-levels-row={row.id}
            >
              {levels.buckets.map((bucket, index) => (
                <li key={bucket.id}>
                  <span className="sr-only">{bucket.label}: </span>
                  {row.cells[index]}
                </li>
              ))}
            </ul>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** How far players get: the levels as bars, or what the game has to send before there are any. */
function HowFarTheyGet({ levels, onOpenTab }: { levels: LevelsView; onOpenTab: OpenTab }): JSX.Element {
  if (levels.kind === LevelsKind.Unsent) {
    const [start, complete, fail] = LEVEL_EVENTS;
    return (
      <ReportSection id="levels" title={WORDS.levels.title}>
        <EmptyNote>
          {WORDS.levels.unsent(start, complete, fail)}{" "}
          <TabLink tab={AnalyticsTab.Sdk} onOpenTab={onOpenTab}>
            {WORDS.levels.openSdk}
          </TabLink>
        </EmptyNote>
      </ReportSection>
    );
  }
  if (levels.kind === LevelsKind.Nobody) {
    return (
      <ReportSection id="levels" title={WORDS.levels.title}>
        <EmptyNote>{WORDS.levels.nobody}</EmptyNote>
      </ReportSection>
    );
  }
  return (
    <ReportSection
      id="levels"
      title={WORDS.levels.title}
      hint={levels.hint}
      controls={
        <TabLink tab={AnalyticsTab.Events} onOpenTab={onOpenTab}>
          {WORDS.levels.fromEvents(LEVEL_EVENTS.join(", "))}
        </TabLink>
      }
      footnote={levels.footnote}
    >
      <LevelsGrid levels={levels} />
    </ReportSection>
  );
}

/** The table's columns: a device, its share of the plays, and how the game ran on it. */
const DEVICE_COLUMNS: readonly DataColumn<DeviceRow>[] = [
  { id: "device", label: WORDS.devices.columns.device, kind: ColumnKind.Text, value: (row) => row.label },
  {
    id: "share",
    label: WORDS.devices.columns.share,
    kind: ColumnKind.Rate,
    digits: WHOLE_PERCENT,
    quiet: true,
    value: (row) => row.share,
  },
  {
    id: "load",
    label: WORDS.devices.columns.loadTime,
    kind: ColumnKind.Number,
    format: (seconds) => formatSeconds(seconds),
    value: (row) => row.loadSeconds,
    flag: (row) => (row.slow ? WORDS.devices.slow : null),
  },
  {
    id: "loaded",
    label: WORDS.devices.columns.loaded,
    kind: ColumnKind.Rate,
    value: (row) => row.loaded,
    flag: (row) => (row.low ? WORDS.devices.low : null),
  },
  { id: "fps", label: WORDS.devices.columns.fps, kind: ColumnKind.Number, value: (row) => row.fps },
  { id: "clean", label: WORDS.devices.columns.clean, kind: ColumnKind.Rate, value: (row) => row.clean },
];

/** How the game runs: four tiles against the period before, and a table by device. */
function HowItRuns({ view }: { view: EngagementView }): JSX.Element {
  const heading = useId();
  return (
    <section className="game-analytics-engagement-run" data-game-analytics-section="run" aria-labelledby={heading}>
      <h2 id={heading} className="game-analytics-engagement-run-title">
        {WORDS.run.title}
      </h2>
      <Tiles tiles={view.run} />
      <ReportSection id="devices" title={WORDS.devices.title}>
        <DataTable
          id="devices"
          label={WORDS.devices.label}
          columns={DEVICE_COLUMNS}
          rows={view.devices}
          rowId={(row) => row.device}
          empty={WORDS.devices.empty}
        />
      </ReportSection>
    </section>
  );
}

/** What `EngagementFace` is given: the view to draw, and what its controls ask. */
export interface EngagementFaceProps {
  view: EngagementView;
  /** The clock switch was pressed. */
  onClock: (clock: ClockChoice) => void;
  onOpenTab: OpenTab;
}

/** The Engagement drawn from its view alone: the clock chosen is the caller's to keep. */
export function EngagementFace({ view, onClock, onOpenTab }: EngagementFaceProps): JSX.Element {
  if (view.empty) {
    return (
      <div className="game-analytics-report" data-game-analytics-report={GameReport.Engagement}>
        <EmptyNote>{WORDS.empty}</EmptyNote>
      </div>
    );
  }
  return (
    <div className="game-analytics-report" data-game-analytics-report={GameReport.Engagement}>
      <Tiles tiles={view.tiles} />
      <ReportColumns>
        <Lengths lengths={view.lengths} />
        <DaysAWeek days={view.days} />
      </ReportColumns>
      <WhenTheyPlay hours={view.hours} onClock={onClock} />
      <HowFarTheyGet levels={view.levels} onOpenTab={onOpenTab} />
      <HowItRuns view={view} />
    </div>
  );
}

/** The Engagement report's body: it keeps whose clock the week is on, the viewer's until the switch is pressed. */
export function EngagementReport({ answer, now, offsetMinutes, onOpenTab }: EngagementReportProps): JSX.Element {
  const [clock, setClock] = useState<ClockChoice>(ClockChoice.Mine);
  const offset = offsetMinutes ?? viewerOffsetMinutes(now);
  return <EngagementFace view={engagementView(answer.data, clock, offset)} onClock={setClock} onOpenTab={onOpenTab} />;
}

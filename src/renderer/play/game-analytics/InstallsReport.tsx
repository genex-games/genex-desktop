/**
 * Installs: the game's app build, from the Install button to the first launch. Four tiles; the way
 * from pressing Install to opening the game, with the visitors who could not get a build; the
 * installs of each day by system beside the systems' table; new players who installed against new
 * players in the browser beside the versions on players' computers and where installs came from.
 * The shell mounts it only with an answer to draw (`report-props.ts`), and everything it shows is
 * derived in `installs-view.ts`.
 */
import type { JSX } from "react";
import { useMemo } from "react";
import { GameReport } from "../../../shared/game-analytics.ts";
import {
  type InstallFunnelView,
  type InstallsTile,
  type InstallsView,
  installsView,
  type PlaceRow,
  type SystemRow,
  type TileNote,
  type VersionRow,
} from "./installs-view.ts";
import { INSTALLS_WORDS as WORDS } from "./installs-words.ts";
import {
  BarChart,
  BarList,
  ColumnKind,
  type DataColumn,
  DataTable,
  EmptyNote,
  FunnelSteps,
  formatNumber,
  Legend,
  MetricTile,
  MetricTiles,
  ReportColumns,
  ReportSection,
} from "./kit/index.ts";
import type { ReportProps } from "./report-props.ts";

/** The per-day chart's height, in CSS pixels. */
const DAILY_HEIGHT = 180;

const SYSTEM_COLUMNS: readonly DataColumn<SystemRow>[] = [
  {
    id: "system",
    label: WORDS.systems.system,
    kind: ColumnKind.Text,
    value: (row) => row.label,
    width: "minmax(130px, 1.6fr)",
  },
  { id: "installs", label: WORDS.systems.installs, kind: ColumnKind.Number, value: (row) => row.installs },
  { id: "share", label: WORDS.systems.share, kind: ColumnKind.Rate, quiet: true, value: (row) => row.share },
  { id: "opened", label: WORDS.systems.opened, kind: ColumnKind.Rate, value: (row) => row.opened },
  {
    id: "download",
    label: WORDS.systems.download,
    kind: ColumnKind.Duration,
    quiet: true,
    value: (row) => row.downloadSeconds,
    width: "minmax(96px, 0.9fr)",
  },
  {
    id: "failed",
    label: WORDS.systems.failed,
    kind: ColumnKind.Rate,
    quiet: true,
    value: (row) => row.failed,
    // Wide enough for German's "Fehlgeschlagen".
    width: "minmax(112px, 0.9fr)",
  },
];

const PLACE_COLUMNS: readonly DataColumn<PlaceRow>[] = [
  {
    id: "measure",
    label: WORDS.places.measure,
    kind: ColumnKind.Text,
    value: (row) => row.label,
    width: "minmax(0, 1fr)",
  },
  {
    id: "installed",
    label: WORDS.places.names.installed,
    kind: ColumnKind.Text,
    numeric: true,
    value: (row) => row.installed,
    width: "minmax(80px, 96px)",
  },
  {
    id: "browser",
    label: WORDS.places.names.browser,
    kind: ColumnKind.Text,
    numeric: true,
    quiet: true,
    value: (row) => row.browser,
    width: "minmax(80px, 96px)",
  },
];

const VERSION_COLUMNS: readonly DataColumn<VersionRow>[] = [
  {
    id: "version",
    label: WORDS.versions.version,
    kind: ColumnKind.Text,
    mono: true,
    mask: true,
    value: (row) => row.label,
    width: "minmax(104px, 1.2fr)",
  },
  {
    id: "published",
    label: WORDS.versions.published,
    kind: ColumnKind.Text,
    quiet: true,
    value: (row) => row.published,
    width: "minmax(72px, 0.8fr)",
  },
  { id: "bar", label: "", kind: ColumnKind.Bar, value: (row) => row.share, width: "minmax(48px, 1.4fr)" },
  { id: "installed", label: WORDS.versions.installed, kind: ColumnKind.Number, value: (row) => row.installed },
  {
    id: "share",
    label: WORDS.versions.share,
    kind: ColumnKind.Rate,
    quiet: true,
    digits: 0,
    value: (row) => row.share,
  },
];

/** A tile's quiet lines, one under another; the creator's own words (a version) stay out of replays. */
function Notes({ notes }: { notes: readonly TileNote[] }): JSX.Element {
  return (
    <span className="game-analytics-installs-notes">
      {notes.map((note) => (
        <span key={note.id} data-analytics-mask={note.mask || undefined}>
          {note.text}
        </span>
      ))}
    </span>
  );
}

/** The four headline tiles. */
function Tiles({ tiles }: { tiles: readonly InstallsTile[] }): JSX.Element {
  return (
    <MetricTiles>
      {tiles.map((tile) => (
        <MetricTile
          key={tile.id}
          id={tile.id}
          label={tile.label}
          value={tile.value}
          delta={tile.delta}
          note={tile.notes.length > 0 ? <Notes notes={tile.notes} /> : undefined}
        />
      ))}
    </MetricTiles>
  );
}

/** The visitors who wanted the build and could not get one, with the reason for each. */
function Blocked({ blocked }: { blocked: NonNullable<InstallFunnelView["blocked"]> }): JSX.Element {
  return (
    <div className="game-analytics-installs-blocked" data-game-analytics-blocked="true">
      <p className="game-analytics-installs-blocked-sentence">{blocked.sentence}</p>
      <ul className="game-analytics-installs-reasons" aria-label={WORDS.funnel.blockedLabel}>
        {blocked.reasons.map((reason) => (
          <li key={reason.id} data-game-analytics-reason={reason.id}>
            {reason.label} <span className="game-analytics-installs-reason-people">{reason.people}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** From pressing Install to opening the game, and who could not get that far. */
function Funnel({ funnel }: { funnel: InstallFunnelView }): JSX.Element {
  return (
    <ReportSection id="funnel" title={WORDS.funnel.title} hint={funnel.hint ?? undefined}>
      {funnel.steps.length > 0 ? (
        <FunnelSteps id="installs" label={WORDS.funnel.title} steps={funnel.steps} />
      ) : (
        <EmptyNote>{WORDS.funnel.empty}</EmptyNote>
      )}
      {funnel.blocked && <Blocked blocked={funnel.blocked} />}
    </ReportSection>
  );
}

/** The installs of each day, stacked by system; the legend sits in the head. */
function Daily({ daily }: { daily: InstallsView["daily"] }): JSX.Element {
  return (
    <ReportSection
      id="daily"
      title={WORDS.daily.title}
      controls={daily.series.length > 0 ? <Legend items={daily.legend} /> : undefined}
    >
      {daily.series.length > 0 ? (
        <BarChart
          id="installs"
          label={WORDS.daily.label}
          series={daily.series}
          labels={daily.labels}
          format={formatNumber}
          height={DAILY_HEIGHT}
          legend={false}
        />
      ) : (
        <EmptyNote>{WORDS.daily.empty}</EmptyNote>
      )}
    </ReportSection>
  );
}

/** The systems' table with its total. */
function Systems({ systems }: { systems: InstallsView["systems"] }): JSX.Element {
  return (
    <ReportSection id="systems" title={WORDS.systems.title}>
      <DataTable
        id="systems"
        label={WORDS.systems.label}
        columns={SYSTEM_COLUMNS}
        rows={systems.rows}
        rowId={(row) => row.id}
        total={systems.total ?? undefined}
        empty={WORDS.systems.empty}
      />
    </ReportSection>
  );
}

/** New players who installed, one measure a row, beside new players in the browser. */
function Places({ places }: { places: InstallsView["places"] }): JSX.Element {
  return (
    <ReportSection id="places" title={WORDS.places.title} hint={places.hint ?? undefined}>
      <DataTable
        id="places"
        label={WORDS.places.label}
        columns={PLACE_COLUMNS}
        rows={places.rows}
        rowId={(row) => row.id}
        empty={WORDS.places.empty}
      />
    </ReportSection>
  );
}

/** The versions on players' computers, newest first, each with its share. */
function Versions({ versions }: { versions: readonly VersionRow[] }): JSX.Element {
  return (
    <ReportSection id="versions" title={WORDS.versions.title}>
      <DataTable
        id="versions"
        label={WORDS.versions.label}
        columns={VERSION_COLUMNS}
        rows={versions}
        rowId={(row) => row.id}
        empty={WORDS.versions.empty}
      />
    </ReportSection>
  );
}

/** Where installs came from, with how long a campaign link keeps its credit. */
function Channels({ view }: { view: InstallsView }): JSX.Element {
  return (
    <ReportSection
      id="channels"
      title={WORDS.channels.title}
      footnote={view.channels.length > 0 ? view.credit : undefined}
    >
      {view.channels.length > 0 ? (
        <BarList id="channels" label={WORDS.channels.label} items={view.channels} shareDigits={1} />
      ) : (
        <EmptyNote>{WORDS.channels.empty}</EmptyNote>
      )}
    </ReportSection>
  );
}

/** The Installs report drawn from its view alone. */
export function InstallsFace({ view }: { view: InstallsView }): JSX.Element {
  return (
    <div className="game-analytics-report" data-game-analytics-report={GameReport.Installs}>
      <Tiles tiles={view.tiles} />
      <Funnel funnel={view.funnel} />
      <ReportColumns>
        <Daily daily={view.daily} />
        <Systems systems={view.systems} />
      </ReportColumns>
      <ReportColumns>
        <Places places={view.places} />
        <div className="game-analytics-installs-stack">
          <Versions versions={view.versions} />
          <Channels view={view} />
        </div>
      </ReportColumns>
    </div>
  );
}

/** The Installs report's body. */
export function InstallsReport({ answer }: ReportProps<typeof GameReport.Installs>): JSX.Element {
  const view = useMemo(() => installsView(answer), [answer]);
  return <InstallsFace view={view} />;
}

/**
 * Acquisition: where new players come from and how far they get. Four tiles (new players, new
 * visitors, how many visitors played, how often Genex's showing the game was clicked), the new
 * players per day by the channel that first brought them, the funnel from the game page to coming
 * back, the sources and the campaigns. The shell mounts it only with an answer to draw
 * (`report-props.ts`), and everything it shows is derived in `acquisition-view.ts`.
 */
import type { JSX } from "react";
import { GameReport } from "../../../shared/game-analytics.ts";
import { CampaignsSection, DailySection, FunnelSection, SourcesSection } from "./acquisition-sections.tsx";
import { acquisitionView } from "./acquisition-view.ts";
import { MetricTile, MetricTiles } from "./kit/index.ts";
import type { ReportProps } from "./report-props.ts";

/** The Acquisition report's body. */
export function AcquisitionReport({
  answer,
  options,
  onOptions,
  onOpenTab,
}: ReportProps<typeof GameReport.Acquisition>): JSX.Element {
  const view = acquisitionView(answer);
  const { data } = answer;
  return (
    <div className="game-analytics-report" data-game-analytics-report={GameReport.Acquisition}>
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
      <DailySection chart={view.chart} />
      <FunnelSection steps={view.funnel} />
      <SourcesSection
        table={view.sources}
        breakdown={view.breakdown}
        attribution={view.attribution}
        asked={{
          breakdown: options.breakdown ?? data.breakdown,
          attribution: options.attribution ?? data.attribution,
        }}
        onOptions={onOptions}
      />
      <CampaignsSection
        table={view.campaigns}
        campaignBy={view.campaignBy}
        asked={options.campaignBy ?? data.campaignBy}
        onOptions={onOptions}
        onOpenTab={onOpenTab}
      />
    </div>
  );
}

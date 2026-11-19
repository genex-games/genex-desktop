/**
 * Which colour of the series palette each thing wears, on every chart: a channel is the same hue
 * in Overview's bar list, Acquisition's stacked bars and Revenue's table, and a campaign is the
 * orange of the campaign marks.
 */
import { OsFamily, SourceChannel } from "../../../../shared/game-analytics.ts";
import { SeriesSlot } from "../../stats-chart.ts";

/** A channel's place in the series palette. */
export const CHANNEL_SLOT = {
  [SourceChannel.Genex]: SeriesSlot.First,
  [SourceChannel.Campaigns]: SeriesSlot.Second,
  [SourceChannel.Social]: SeriesSlot.Third,
  [SourceChannel.Direct]: SeriesSlot.Fourth,
  [SourceChannel.Search]: SeriesSlot.Fifth,
  [SourceChannel.Other]: SeriesSlot.Rest,
} as const satisfies Record<SourceChannel, SeriesSlot>;

/** A system's place in the series palette. */
export const OS_SLOT = {
  [OsFamily.Windows]: SeriesSlot.First,
  [OsFamily.MacArm]: SeriesSlot.Second,
  [OsFamily.MacIntel]: SeriesSlot.Third,
  [OsFamily.Linux]: SeriesSlot.Fourth,
} as const satisfies Record<OsFamily, SeriesSlot>;

/**
 * A fixture game's Overview as genex.games answers it, straight from the game's sample: the same
 * series, channels, retention curve and funnel every other report of the game is made from.
 */
import {
  type Annotation,
  AnnotationKind,
  type GameReportOptions,
  OverviewMetric,
  type OverviewReport,
} from "../../../shared/game-analytics.ts";
import type { GameSample } from "./sample.ts";

/** The marks on the per-day chart: the campaign's first day and the newest version's, when the period has them. */
function annotationsOf(sample: GameSample): Annotation[] {
  const marks: Annotation[] = [];
  if (sample.campaign)
    marks.push({ on: sample.campaign.startsOn, kind: AnnotationKind.Campaign, label: sample.campaign.name });
  marks.push({ on: sample.release.on, kind: AnnotationKind.Version, label: sample.release.version });
  const [firstDay = sample.window.endsOn] = sample.dates;
  return marks.filter((mark) => mark.on >= firstDay && mark.on <= sample.window.endsOn);
}

/** The Overview report's data for `sample`; it takes no options. */
export function fixtureOverview(sample: GameSample, _options: GameReportOptions): OverviewReport {
  return {
    series: {
      [OverviewMetric.Players]: sample.players,
      [OverviewMetric.NewPlayers]: sample.newPlayers,
      [OverviewMetric.Plays]: sample.plays,
      [OverviewMetric.MedianPlaySeconds]: sample.medianPlaySeconds,
      [OverviewMetric.Day1]: sample.day1,
      [OverviewMetric.Day7]: sample.day7,
      [OverviewMetric.Installs]: sample.installs,
      [OverviewMetric.NexSpent]: sample.nex,
    },
    annotations: annotationsOf(sample),
    insights: sample.insights,
    channels: sample.channels.map(({ channel, newPlayers }) => ({ channel, people: newPlayers })),
    retention: sample.retention,
    funnel: sample.funnel,
  };
}

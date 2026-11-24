/**
 * The columns of the Acquisition's two tables. Both end in the same five numbers: how many new
 * visitors and new players a source or a campaign brought, how many of the visitors played, and how
 * its players come back and spend. The sources table has the times Genex showed the game before
 * them; the campaigns table names the source and medium under each campaign.
 */
import { CampaignField, SourceBreakdown } from "../../../shared/game-analytics.ts";
import { ACQUISITION_WORDS as WORDS } from "./acquisition-words.ts";
import type { AcquisitionRow } from "./acquisition-view.ts";
import { ColumnKind, type DataColumn, formatNexPerPlayer } from "./kit/index.ts";

/** A number's column: wide enough for its heading, "Nex per player" being the longest. */
const NUMBER_WIDTH = "minmax(96px, 0.7fr)";
/** The first column of the campaigns table, which holds a name over its source and medium. */
const CAMPAIGN_WIDTH = "minmax(220px, 1.6fr)";
/** A rate is written with one decimal, as the tiles write it. */
const RATE_DIGITS = 1;

type Column = DataColumn<AcquisitionRow>;

const SHOWN: Column = {
  id: "shown",
  label: WORDS.columns.shown,
  kind: ColumnKind.Number,
  value: (row) => row.shown,
  quiet: true,
  width: NUMBER_WIDTH,
};

/** What a source or a campaign brought and how its players turn out. */
const NUMBERS: readonly Column[] = [
  {
    id: "newVisitors",
    label: WORDS.columns.newVisitors,
    kind: ColumnKind.Number,
    value: (row) => row.newVisitors,
    quiet: true,
    width: NUMBER_WIDTH,
  },
  {
    id: "newPlayers",
    label: WORDS.columns.newPlayers,
    kind: ColumnKind.Number,
    value: (row) => row.newPlayers,
    width: NUMBER_WIDTH,
  },
  {
    id: "visitToPlay",
    label: WORDS.columns.visitToPlay,
    kind: ColumnKind.Rate,
    value: (row) => row.visitToPlay,
    digits: RATE_DIGITS,
    quiet: true,
    width: NUMBER_WIDTH,
  },
  {
    id: "day1",
    label: WORDS.columns.day1,
    kind: ColumnKind.Rate,
    value: (row) => row.day1,
    digits: RATE_DIGITS,
    width: NUMBER_WIDTH,
  },
  {
    id: "day7",
    label: WORDS.columns.day7,
    kind: ColumnKind.Rate,
    value: (row) => row.day7,
    digits: RATE_DIGITS,
    width: NUMBER_WIDTH,
  },
  {
    id: "nexPerPlayer",
    label: WORDS.columns.nexPerPlayer,
    kind: ColumnKind.Number,
    value: (row) => row.nexPerPlayer,
    format: formatNexPerPlayer,
    quiet: true,
    width: NUMBER_WIDTH,
  },
];

/** What the first column of the sources table is called: its rows are channels (sources), sites, countries or devices. */
function sourceHeading(breakdown: SourceBreakdown): string {
  return breakdown === SourceBreakdown.Channel ? WORDS.columns.source : WORDS.sources.breakdowns[breakdown];
}

/**
 * Source (or the site, country or device the answer is split by), Shown, then the numbers. A host or
 * a country's name is words someone else wrote or the app's, so the name is masked.
 */
export function sourceColumns(breakdown: SourceBreakdown): readonly Column[] {
  const name: Column = {
    id: "source",
    label: sourceHeading(breakdown),
    kind: ColumnKind.Text,
    value: (row) => row.name,
    mask: true,
  };
  return [name, SHOWN, ...NUMBERS];
}

/**
 * Campaign (or the utm_ tag the answer is grouped by, by its own name) over the source and medium it
 * came with, then the numbers. The tags are the creator's own words.
 */
export function campaignColumns(by: CampaignField): readonly Column[] {
  const name: Column = {
    id: "campaign",
    label: by === CampaignField.Campaign ? WORDS.columns.campaign : `utm_${by}`,
    kind: ColumnKind.Text,
    value: (row) => row.name,
    detail: (row) => row.detail,
    mono: true,
    mask: true,
    width: CAMPAIGN_WIDTH,
  };
  return [name, ...NUMBERS];
}
